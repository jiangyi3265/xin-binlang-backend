/**
 * 重置总部管理账号与门店账号的登录密码。
 *
 * 用于轮换演示和正式账号口令。历史弱口令通过本地环境变量传入，
 * 不把任何固定账号口令写入公开仓库。
 *
 *   node --env-file-if-exists=.env src/rotate-passwords.js              # 预览，不写库
 *   node --env-file-if-exists=.env src/rotate-passwords.js --confirm    # 真正重置
 *   node --env-file-if-exists=.env src/rotate-passwords.js --confirm --user=admin
 *   node --env-file-if-exists=.env src/rotate-passwords.js --confirm --only-weak
 *
 * 新密码只在本次输出里出现一次，库里只存哈希，之后无法再取回。
 */
import { randomInt } from 'node:crypto'
import { loadConfig } from './config.js'
import { openDatabase, queryAll, execute, transaction } from './database.js'
import { hashPassword, verifyPassword } from './security.js'

// 排除 0/O/1/l/I 等易混字符，口令要靠人转述给门店店员
const UPPER = 'ABCDEFGHJKMNPQRSTUVWXYZ'
const LOWER = 'abcdefghijkmnpqrstuvwxyz'
const DIGIT = '23456789'
const SYMBOL = '!@#$%^&*-_=+'
const ALL = UPPER + LOWER + DIGIT + SYMBOL

// 仅从本机环境读取历史口令，--only-weak 用于检测尚未轮换的账号。
const SEEDED_PASSWORDS = JSON.parse(process.env.LEGACY_PASSWORDS_JSON || '[]')
if (!Array.isArray(SEEDED_PASSWORDS) || SEEDED_PASSWORDS.some(value => typeof value !== 'string')) {
  throw new Error('LEGACY_PASSWORDS_JSON 必须是字符串数组')
}

function generatePassword(length = 18) {
  // 四类字符各保底一个，再补足长度后洗牌，避免生成出不满足复杂度要求的串
  const picks = [UPPER, LOWER, DIGIT, SYMBOL].map(set => set[randomInt(0, set.length)])
  while (picks.length < length) picks.push(ALL[randomInt(0, ALL.length)])
  for (let i = picks.length - 1; i > 0; i--) {
    const j = randomInt(0, i + 1)
    ;[picks[i], picks[j]] = [picks[j], picks[i]]
  }
  return picks.join('')
}

function parseArgs(argv) {
  const args = { confirm: false, user: '', onlyWeak: false }
  for (const item of argv) {
    if (item === '--confirm') args.confirm = true
    else if (item === '--only-weak') args.onlyWeak = true
    else if (item.startsWith('--user=')) args.user = item.slice('--user='.length).trim()
  }
  return args
}

function usesSeededPassword(hash) {
  return SEEDED_PASSWORDS.some(candidate => {
    try { return verifyPassword(candidate, hash) } catch { return false }
  })
}

const args = parseArgs(process.argv.slice(2))
if (args.onlyWeak && !SEEDED_PASSWORDS.length) {
  throw new Error('--only-weak 需要在本地环境配置 LEGACY_PASSWORDS_JSON')
}
const config = loadConfig()
const db = await openDatabase(config, { seed: false })

try {
  const targets = []
  for (const [table, label] of [['admin_users', '总部管理'], ['store_accounts', '门店']]) {
    const rows = await queryAll(db, `SELECT id, username, name, password_hash FROM ${table} ORDER BY username`)
    for (const row of rows) {
      if (args.user && row.username !== args.user) continue
      const weak = usesSeededPassword(row.password_hash)
      if (args.onlyWeak && !weak) continue
      targets.push({ table, label, id: row.id, username: row.username, name: row.name, weak })
    }
  }

  if (!targets.length) {
    console.log(args.onlyWeak ? '没有账号还在使用仓库里的演示口令。' : '没有匹配到任何账号。')
  } else {
    const weakCount = targets.filter(item => item.weak).length
    console.log(`数据库：${config.database.driver} ${config.database.host}/${config.database.name}`)
    console.log(`匹配账号 ${targets.length} 个，其中仍在使用演示口令的 ${weakCount} 个\n`)

    const results = targets.map(item => ({ ...item, password: generatePassword() }))
    const width = Math.max(...results.map(item => item.username.length), 8)
    console.log('账号'.padEnd(width + 2) + '角色      姓名            新密码')
    console.log('-'.repeat(width + 2 + 10 + 16 + 18))
    for (const item of results) {
      console.log(
        item.username.padEnd(width + 2) +
        item.label.padEnd(10) +
        String(item.name || '').padEnd(16) +
        (args.confirm ? item.password : '（预览，未写入）') +
        (item.weak ? '   <- 原为演示口令' : '')
      )
    }
    console.log('')

    if (args.confirm) {
      const now = Date.now()
      await transaction(db, async () => {
        for (const item of results) {
          await execute(db, `UPDATE ${item.table} SET password_hash=?, updated_at=? WHERE id=?`, hashPassword(item.password), now, item.id)
        }
      })
      console.log(`✓ 已重置 ${results.length} 个账号的密码。`)
      console.log('⚠ 上面的密码只出现这一次，请立刻保存到密码管理器并分发给对应负责人。')
      console.log('⚠ 已登录的会话不会立刻失效：总部 token 有效期 8 小时，门店 12 小时。')
    } else {
      console.log('这是预览，数据库未被修改。确认无误后加 --confirm 重新执行。')
    }
  }
} finally {
  await db.close()
}
