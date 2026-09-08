/**
 * 清理 seed-data.js 灌进生产库的演示交易数据。
 *
 *   node --env-file-if-exists=.env src/purge-demo-data.js            # 只统计，不删
 *   node --env-file-if-exists=.env src/purge-demo-data.js --confirm  # 真正删除
 *
 * 只删演示顾客（C001-C006 / openid 为 demo-customer、customer-2..5、blocked-demo）
 * 以及挂在他们名下的兑奖单、通知、优惠券、核销日志，并把被占用的兑换码退回未使用。
 *
 * 刻意不删的东西：settings、stores、prize_pools、prizes、batches、admin_users、
 * store_accounts。这些虽然也来自种子，但上线后很可能已经被当成真实配置在用
 * （线上 settings.brand 已被人改过），删掉会连带毁掉真实数据。要清理它们请到
 * 总部管理后台逐条停用，不要用脚本。
 *
 * 演示顾客名下如果已经混入了真实兑奖记录，脚本不会去猜，会整体中止并报告。
 */
import { loadConfig } from './config.js'
import { openDatabase, queryAll, queryOne, execute, transaction } from './database.js'

const DEMO_CUSTOMER_IDS = ['C001', 'C002', 'C003', 'C004', 'C005', 'C006']
const DEMO_OPENIDS = ['demo-customer', 'customer-2', 'customer-3', 'customer-4', 'customer-5', 'blocked-demo']
const DEMO_REDEMPTION_PREFIX = 'R000042'
const DEMO_NOTICE_IDS = ['N001', 'N002', 'N003', 'N004']
const DEMO_COUPON_IDS = ['CP001', 'CP002']

const confirm = process.argv.includes('--confirm')
const config = loadConfig()
const db = await openDatabase(config, { seed: false })

function list(values) {
  return values.map(() => '?').join(',')
}

try {
  console.log(`数据库：${config.database.driver} ${config.database.host}/${config.database.name}\n`)

  // 只认「id 与 openid 同时对得上」的行，避免误伤 id 撞号的真实用户
  const demoCustomers = await queryAll(db,
    `SELECT id, openid, nickname FROM customers WHERE id IN (${list(DEMO_CUSTOMER_IDS)}) AND openid IN (${list(DEMO_OPENIDS)})`,
    ...DEMO_CUSTOMER_IDS, ...DEMO_OPENIDS)

  if (!demoCustomers.length) {
    console.log('没有找到演示顾客，这个库看起来已经干净了。')
  } else {
    const ids = demoCustomers.map(row => row.id)
    const redemptions = await queryAll(db, `SELECT id, code, status, redeemed_at FROM redemptions WHERE customer_id IN (${list(ids)})`, ...ids)
    const strays = redemptions.filter(row => !row.id.startsWith(DEMO_REDEMPTION_PREFIX))

    console.log('演示顾客：')
    for (const row of demoCustomers) console.log(`  ${row.id}  ${row.openid.padEnd(16)}${row.nickname}`)
    console.log('')

    const counts = {
      兑奖记录: redemptions.length,
      通知: (await queryOne(db, `SELECT COUNT(*) AS c FROM notices WHERE customer_id IN (${list(ids)})`, ...ids)).c,
      优惠券: (await queryOne(db, `SELECT COUNT(*) AS c FROM coupons WHERE customer_id IN (${list(ids)})`, ...ids)).c
    }
    for (const [label, value] of Object.entries(counts)) console.log(`  ${label}：${Number(value)} 条`)

    // 种子里有 B3K7T1 这种「状态是 redeemed 但没有对应兑奖单」的摆设码。
    // 正常流程下 services.redeem() 一定会同时写 redemption_id，所以这属于不变式
    // 被破坏——留着会让这个码永远既不能兑也查不到订单。
    const danglingCodes = await queryAll(db,
      "SELECT code, status FROM redeem_codes WHERE status <> 'unused' AND redemption_id IS NULL")
    if (danglingCodes.length) {
      console.log(`\n另有 ${danglingCodes.length} 个兑换码状态为已用但查不到兑奖单，将退回未使用：`)
      console.log('  ' + danglingCodes.map(row => `${row.code}(${row.status})`).join('、'))
    }

    const realCustomers = Number((await queryOne(db, `SELECT COUNT(*) AS c FROM customers WHERE id NOT IN (${list(ids)})`, ...ids)).c)
    const realRedemptions = Number((await queryOne(db, `SELECT COUNT(*) AS c FROM redemptions WHERE customer_id NOT IN (${list(ids)})`, ...ids)).c)
    console.log(`\n将保留：真实顾客 ${realCustomers} 人，真实兑奖记录 ${realRedemptions} 条`)

    if (strays.length) {
      console.log(`\n✗ 中止：演示顾客名下有 ${strays.length} 条不是种子生成的兑奖记录：`)
      for (const row of strays.slice(0, 10)) console.log(`    ${row.id}  ${row.code}  ${row.status}  ${new Date(Number(row.redeemed_at)).toISOString()}`)
      console.log('  说明有人用演示账号真实兑过奖。请先人工确认这些记录的归属，脚本不做猜测。')
      process.exitCode = 1
    } else if (!confirm) {
      console.log('\n这是预览，数据库未被修改。确认无误后加 --confirm 重新执行。')
    } else {
      const redemptionIds = redemptions.map(row => row.id)
      await transaction(db, async () => {
        if (redemptionIds.length) {
          await execute(db, `DELETE FROM audit_logs WHERE entity_type='redemption' AND entity_id IN (${list(redemptionIds)})`, ...redemptionIds)
          // 先把兑换码退回未使用，再删兑奖单：redemptions.code 对 redeem_codes 是 RESTRICT
          await execute(db, `UPDATE redeem_codes SET status='unused', redeemed_at=NULL, redemption_id=NULL WHERE redemption_id IN (${list(redemptionIds)})`, ...redemptionIds)
          await execute(db, `UPDATE coupons SET redemption_id=NULL WHERE redemption_id IN (${list(redemptionIds)})`, ...redemptionIds)
        }
        await execute(db, `DELETE FROM notices WHERE customer_id IN (${list(ids)})`, ...ids)
        await execute(db, `DELETE FROM coupons WHERE customer_id IN (${list(ids)})`, ...ids)
        if (redemptionIds.length) await execute(db, `DELETE FROM redemptions WHERE id IN (${list(redemptionIds)})`, ...redemptionIds)
        await execute(db, `DELETE FROM customers WHERE id IN (${list(ids)})`, ...ids)
        await execute(db, `DELETE FROM notices WHERE id IN (${list(DEMO_NOTICE_IDS)})`, ...DEMO_NOTICE_IDS)
        await execute(db, `DELETE FROM coupons WHERE id IN (${list(DEMO_COUPON_IDS)})`, ...DEMO_COUPON_IDS)
        await execute(db, "UPDATE redeem_codes SET status='unused', redeemed_at=NULL WHERE status <> 'unused' AND redemption_id IS NULL")
      })
      console.log('\n✓ 演示交易数据已清除，总部后台的中奖率与核销统计从现在起只反映真实数据。')
      console.log('  被演示单占用的兑换码已退回「未使用」，可以重新发放。')
    }
  }
} finally {
  await db.close()
}
