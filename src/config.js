import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'

const here = dirname(fileURLToPath(import.meta.url))
const backendRoot = resolve(here, '..')

// 开发会话密钥仅存在于进程内；生产必须显式配置独立密钥。
const DEV_TOKEN_SECRET = randomBytes(32).toString('hex')

function assertProductionSecret(tokenSecret) {
  if (process.env.NODE_ENV !== 'production') return
  if (tokenSecret === DEV_TOKEN_SECRET) {
    throw new Error('拒绝启动：生产环境未配置 TOKEN_SECRET。请在 .env 里设置至少 32 位的随机值后重启。')
  }
  if (String(tokenSecret).length < 32) {
    throw new Error(`拒绝启动：生产环境的 TOKEN_SECRET 只有 ${String(tokenSecret).length} 位，至少需要 32 位随机字符。`)
  }
}

export function loadConfig(overrides = {}) {
  const dbDriver = overrides.dbDriver || process.env.DB_DRIVER || 'mysql'
  const tokenSecret = overrides.tokenSecret || process.env.TOKEN_SECRET || DEV_TOKEN_SECRET
  assertProductionSecret(tokenSecret)
  return {
    host: overrides.host || process.env.HOST || '127.0.0.1',
    port: Number(overrides.port || process.env.PORT || 8897),
    database: {
      driver: dbDriver,
      host: overrides.dbHost || process.env.DB_HOST || '127.0.0.1',
      port: Number(overrides.dbPort || process.env.DB_PORT || 3306),
      user: overrides.dbUser || process.env.DB_USER || 'xin_binlang',
      password: overrides.dbPassword ?? process.env.DB_PASSWORD ?? '',
      name: overrides.dbName || process.env.DB_NAME || 'xin_binlang',
      connectionLimit: Number(overrides.dbConnectionLimit || process.env.DB_CONNECTION_LIMIT || 12),
      ssl: String(overrides.dbSsl ?? process.env.DB_SSL ?? 'false') === 'true',
      autoCreate: String(overrides.dbAutoCreate ?? process.env.DB_AUTO_CREATE ?? 'false') === 'true',
      seed: process.env.NODE_ENV !== 'production'
        && String(overrides.dbSeed ?? process.env.DB_SEED ?? 'false').toLowerCase() === 'true'
    },
    tokenSecret,
    publicOrigin: overrides.publicOrigin || process.env.PUBLIC_ORIGIN || 'http://127.0.0.1:8897',
    allowedOrigins: String(overrides.allowedOrigins || process.env.ALLOWED_ORIGINS || overrides.publicOrigin || process.env.PUBLIC_ORIGIN || 'http://127.0.0.1:8897')
      .split(',').map(value => value.trim()).filter(Boolean),
    adminDir: overrides.adminDir || resolve(backendRoot, process.env.ADMIN_DIR || '../总部管理后台'),
    h5Dir: overrides.h5Dir || resolve(backendRoot, process.env.H5_DIR || '../槟榔小程序端/dist/build/h5'),
    uploadDir: overrides.uploadDir || process.env.UPLOAD_DIR || resolve(backendRoot, 'uploads'),
    transfer: {
      enabled: process.env.WECHAT_TRANSFER_ENABLED === 'true',
      appId: process.env.WECHAT_APP_ID || '',
      mchId: process.env.WECHAT_PAY_MCH_ID || '',
      serialNo: process.env.WECHAT_PAY_SERIAL_NO || '',
      privateKeyPath: process.env.WECHAT_PAY_PRIVATE_KEY_PATH || '',
      publicKeyId: process.env.WECHAT_PAY_PUBLIC_KEY_ID || '',
      publicKeyPath: process.env.WECHAT_PAY_PUBLIC_KEY_PATH || '',
      sceneId: process.env.WECHAT_TRANSFER_SCENE_ID || '',
      activityName: process.env.WECHAT_TRANSFER_ACTIVITY_NAME || '',
      rewardDescription: process.env.WECHAT_TRANSFER_REWARD_DESCRIPTION || '',
      maxCents: Number(process.env.WECHAT_TRANSFER_MAX_CENTS || 20000)
    },
    wechat: {
      appId: process.env.WECHAT_APP_ID || '',
      appSecret: process.env.WECHAT_APP_SECRET || '',
      templates: {
        win: process.env.WECHAT_TEMPLATE_WIN || '',
        verify: process.env.WECHAT_TEMPLATE_VERIFY || '',
        expiring: process.env.WECHAT_TEMPLATE_EXPIRING || ''
      }
    }
  }
}

export { backendRoot }
