import { AsyncLocalStorage } from 'node:async_hooks'
import mysql from 'mysql2/promise'
import { DEFAULT_BRAND_BACKGROUND, DEFAULT_PRODUCT_IMAGE, DEFAULT_REDEMPTION_FLOW, seedDatabase } from './seed-data.js'

const mysqlSchema = `
CREATE TABLE IF NOT EXISTS schema_meta (
  \`key\` VARCHAR(80) PRIMARY KEY,
  value VARCHAR(255) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS settings (
  id TINYINT UNSIGNED PRIMARY KEY,
  brand VARCHAR(120) NOT NULL,
  brand_en VARCHAR(120) NOT NULL,
  brand_mark VARCHAR(8) NOT NULL DEFAULT '倌',
  brand_logo VARCHAR(500) NOT NULL DEFAULT '',
  admin_subtitle VARCHAR(80) NOT NULL DEFAULT '总部运营中枢',
  activity_name VARCHAR(160) NOT NULL,
  activity_subtitle VARCHAR(255) NOT NULL,
  slogan VARCHAR(255) NOT NULL,
  active TINYINT(1) NOT NULL DEFAULT 1,
  activity_start DATE NOT NULL,
  activity_end DATE NOT NULL,
  daily_limit SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  prize_valid_days SMALLINT UNSIGNED NOT NULL DEFAULT 30,
  home_bg VARCHAR(500) NOT NULL,
  poster VARCHAR(500) NOT NULL,
  product_image VARCHAR(500) NOT NULL,
  rule_bg VARCHAR(500) NOT NULL,
  notice_json JSON NOT NULL,
  flow_json JSON NOT NULL,
  service_json JSON NOT NULL,
  updated_at BIGINT UNSIGNED NOT NULL,
  CONSTRAINT chk_settings_singleton CHECK (id = 1),
  CONSTRAINT chk_settings_active CHECK (active IN (0,1)),
  CONSTRAINT chk_settings_daily_limit CHECK (daily_limit BETWEEN 0 AND 20),
  CONSTRAINT chk_settings_valid_days CHECK (prize_valid_days BETWEEN 1 AND 365)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS customers (
  id VARCHAR(50) PRIMARY KEY,
  openid VARCHAR(128) NOT NULL UNIQUE,
  nickname VARCHAR(120) NOT NULL,
  phone VARCHAR(40) NOT NULL DEFAULT '',
  avatar VARCHAR(500) NOT NULL DEFAULT '',
  blocked TINYINT(1) NOT NULL DEFAULT 0,
  blocked_reason VARCHAR(500) NOT NULL DEFAULT '',
  created_at BIGINT UNSIGNED NOT NULL,
  updated_at BIGINT UNSIGNED NOT NULL,
  CONSTRAINT chk_customers_blocked CHECK (blocked IN (0,1))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS admin_users (
  id VARCHAR(50) PRIMARY KEY,
  username VARCHAR(80) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  name VARCHAR(100) NOT NULL,
  role ENUM('super_admin','operator','auditor','sales') NOT NULL,
  active TINYINT(1) NOT NULL DEFAULT 1,
  last_login_at BIGINT UNSIGNED NULL,
  created_at BIGINT UNSIGNED NOT NULL,
  updated_at BIGINT UNSIGNED NOT NULL,
  CONSTRAINT chk_admin_active CHECK (active IN (0,1))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS stores (
  id VARCHAR(50) PRIMARY KEY,
  name VARCHAR(160) NOT NULL,
  short_name VARCHAR(100) NOT NULL,
  address VARCHAR(500) NOT NULL,
  latitude DECIMAL(10,7) NOT NULL,
  longitude DECIMAL(10,7) NOT NULL,
  phone VARCHAR(40) NOT NULL,
  business_hours VARCHAR(100) NOT NULL,
  image VARCHAR(500) NOT NULL DEFAULT '',
  status ENUM('active','disabled') NOT NULL DEFAULT 'active',
  created_by_admin_id VARCHAR(50) NULL,
  created_at BIGINT UNSIGNED NOT NULL,
  updated_at BIGINT UNSIGNED NOT NULL,
  INDEX idx_stores_creator (created_by_admin_id),
  CONSTRAINT fk_stores_creator FOREIGN KEY (created_by_admin_id) REFERENCES admin_users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS store_accounts (
  id VARCHAR(50) PRIMARY KEY,
  store_id VARCHAR(50) NULL,
  username VARCHAR(80) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  name VARCHAR(100) NOT NULL,
  phone VARCHAR(40) NOT NULL DEFAULT '',
  avatar VARCHAR(500) NOT NULL DEFAULT '',
  role ENUM('owner','staff','hq') NOT NULL,
  permissions_json JSON NOT NULL,
  active TINYINT(1) NOT NULL DEFAULT 1,
  last_login_at BIGINT UNSIGNED NULL,
  created_at BIGINT UNSIGNED NOT NULL,
  updated_at BIGINT UNSIGNED NOT NULL,
  CONSTRAINT fk_accounts_store FOREIGN KEY (store_id) REFERENCES stores(id) ON DELETE CASCADE,
  CONSTRAINT chk_accounts_active CHECK (active IN (0,1)),
  CONSTRAINT chk_accounts_scope CHECK ((role='hq' AND store_id IS NULL) OR (role<>'hq' AND store_id IS NOT NULL))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS prize_pools (
  id VARCHAR(50) PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  description VARCHAR(500) NOT NULL DEFAULT '',
  tier_label VARCHAR(100) NOT NULL DEFAULT '',
  status ENUM('active','disabled') NOT NULL DEFAULT 'active',
  created_at BIGINT UNSIGNED NOT NULL,
  updated_at BIGINT UNSIGNED NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS pool_presentations (
  pool_id VARCHAR(50) PRIMARY KEY,
  display_json JSON NOT NULL,
  CONSTRAINT fk_pool_presentation FOREIGN KEY (pool_id) REFERENCES prize_pools(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS prizes (
  id VARCHAR(50) PRIMARY KEY,
  pool_id VARCHAR(50) NOT NULL,
  name VARCHAR(120) NOT NULL,
  specification VARCHAR(160) NOT NULL DEFAULT '',
  level VARCHAR(80) NOT NULL DEFAULT '',
  category VARCHAR(40) NOT NULL DEFAULT 'goods',
  value_cents INT UNSIGNED NOT NULL DEFAULT 0,
  stock INT UNSIGNED NOT NULL DEFAULT 0,
  sent_count INT UNSIGNED NOT NULL DEFAULT 0,
  low_stock_threshold INT UNSIGNED NOT NULL DEFAULT 10,
  weight DECIMAL(12,4) UNSIGNED NOT NULL DEFAULT 1,
  display_only TINYINT(1) NOT NULL DEFAULT 0,
  showcase_weight DECIMAL(12,4) UNSIGNED NOT NULL DEFAULT 1,
  image VARCHAR(500) NOT NULL DEFAULT '',
  status ENUM('active','disabled') NOT NULL DEFAULT 'active',
  created_at BIGINT UNSIGNED NOT NULL,
  updated_at BIGINT UNSIGNED NOT NULL,
  CONSTRAINT fk_prizes_pool FOREIGN KEY (pool_id) REFERENCES prize_pools(id) ON DELETE RESTRICT,
  CONSTRAINT chk_prizes_weight CHECK (weight > 0),
  CONSTRAINT chk_prizes_display_only CHECK (display_only IN (0,1)),
  CONSTRAINT chk_prizes_showcase_weight CHECK (showcase_weight BETWEEN 0 AND 100000)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS batches (
  id VARCHAR(50) PRIMARY KEY,
  name VARCHAR(120) NOT NULL,
  product_tier VARCHAR(100) NOT NULL,
  price_cents INT UNSIGNED NOT NULL,
  pool_id VARCHAR(50) NOT NULL,
  win_rate_ppm INT UNSIGNED NOT NULL,
  status ENUM('active','paused','expired') NOT NULL DEFAULT 'active',
  starts_at BIGINT UNSIGNED NOT NULL,
  expires_at BIGINT UNSIGNED NOT NULL,
  created_at BIGINT UNSIGNED NOT NULL,
  updated_at BIGINT UNSIGNED NOT NULL,
  CONSTRAINT fk_batches_pool FOREIGN KEY (pool_id) REFERENCES prize_pools(id) ON DELETE RESTRICT,
  CONSTRAINT chk_batches_rate CHECK (win_rate_ppm BETWEEN 0 AND 1000000),
  CONSTRAINT chk_batches_dates CHECK (expires_at > starts_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS redeem_codes (
  code CHAR(6) PRIMARY KEY,
  batch_id VARCHAR(50) NOT NULL,
  status ENUM('unused','redeemed','verified','expired') NOT NULL DEFAULT 'unused',
  forced_outcome ENUM('win','lose') NULL,
  forced_prize_id VARCHAR(50) NULL,
  created_at BIGINT UNSIGNED NOT NULL,
  redeemed_at BIGINT UNSIGNED NULL,
  redemption_id VARCHAR(50) NULL,
  INDEX idx_codes_batch_status (batch_id,status),
  CONSTRAINT fk_codes_batch FOREIGN KEY (batch_id) REFERENCES batches(id) ON DELETE RESTRICT,
  CONSTRAINT fk_codes_prize FOREIGN KEY (forced_prize_id) REFERENCES prizes(id) ON DELETE SET NULL,
  CONSTRAINT chk_codes_length CHECK (CHAR_LENGTH(code)=6)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS redemptions (
  id VARCHAR(50) PRIMARY KEY,
  order_no VARCHAR(80) NOT NULL UNIQUE,
  code CHAR(6) NOT NULL UNIQUE,
  batch_id VARCHAR(50) NOT NULL,
  pool_id VARCHAR(50) NOT NULL,
  customer_id VARCHAR(50) NOT NULL,
  prize_id VARCHAR(50) NULL,
  won TINYINT(1) NOT NULL,
  status ENUM('lose','pending','verified','expired','frozen') NOT NULL,
  prize_snapshot_json JSON NOT NULL,
  preferred_store_id VARCHAR(50) NULL,
  verified_store_id VARCHAR(50) NULL,
  verified_by_account_id VARCHAR(50) NULL,
  verified_position VARCHAR(500) NOT NULL DEFAULT '',
  frozen_reason VARCHAR(500) NOT NULL DEFAULT '',
  redeemed_at BIGINT UNSIGNED NOT NULL,
  expires_at BIGINT UNSIGNED NULL,
  verified_at BIGINT UNSIGNED NULL,
  updated_at BIGINT UNSIGNED NOT NULL,
  INDEX idx_redemptions_customer (customer_id,redeemed_at DESC),
  INDEX idx_redemptions_store (preferred_store_id,status,redeemed_at DESC),
  INDEX idx_redemptions_verified_store (verified_store_id,verified_at DESC),
  CONSTRAINT fk_redemptions_code FOREIGN KEY (code) REFERENCES redeem_codes(code) ON DELETE RESTRICT,
  CONSTRAINT fk_redemptions_batch FOREIGN KEY (batch_id) REFERENCES batches(id) ON DELETE RESTRICT,
  CONSTRAINT fk_redemptions_pool FOREIGN KEY (pool_id) REFERENCES prize_pools(id) ON DELETE RESTRICT,
  CONSTRAINT fk_redemptions_customer FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE RESTRICT,
  CONSTRAINT fk_redemptions_prize FOREIGN KEY (prize_id) REFERENCES prizes(id) ON DELETE RESTRICT,
  CONSTRAINT fk_redemptions_preferred_store FOREIGN KEY (preferred_store_id) REFERENCES stores(id) ON DELETE SET NULL,
  CONSTRAINT fk_redemptions_verified_store FOREIGN KEY (verified_store_id) REFERENCES stores(id) ON DELETE SET NULL,
  CONSTRAINT fk_redemptions_account FOREIGN KEY (verified_by_account_id) REFERENCES store_accounts(id) ON DELETE SET NULL,
  CONSTRAINT chk_redemptions_won CHECK (won IN (0,1))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS prize_reward_rules (
  prize_id VARCHAR(50) PRIMARY KEY,
  exchange_cents INT UNSIGNED NOT NULL DEFAULT 0,
  CONSTRAINT fk_reward_prize FOREIGN KEY (prize_id) REFERENCES prizes(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS cash_rewards (
  redemption_id VARCHAR(50) PRIMARY KEY,
  customer_id VARCHAR(50) NOT NULL,
  out_bill_no VARCHAR(32) NOT NULL UNIQUE,
  mch_id VARCHAR(32) NOT NULL,
  app_id VARCHAR(32) NOT NULL,
  openid VARCHAR(64) NOT NULL,
  amount_cents INT UNSIGNED NOT NULL,
  request_json JSON NULL,
  state VARCHAR(32) NOT NULL DEFAULT 'SUBMITTING',
  transfer_bill_no VARCHAR(64) NOT NULL DEFAULT '',
  package_info VARCHAR(2048) NOT NULL DEFAULT '',
  last_error VARCHAR(80) NOT NULL DEFAULT '',
  lease_until BIGINT UNSIGNED NOT NULL DEFAULT 0,
  created_at BIGINT UNSIGNED NOT NULL,
  updated_at BIGINT UNSIGNED NOT NULL,
  INDEX idx_cash_reconcile (state, updated_at),
  CONSTRAINT fk_cash_redemption FOREIGN KEY (redemption_id) REFERENCES redemptions(id) ON DELETE RESTRICT,
  CONSTRAINT fk_cash_customer FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS coupons (
  id VARCHAR(50) PRIMARY KEY,
  customer_id VARCHAR(50) NOT NULL,
  redemption_id VARCHAR(50) NULL,
  name VARCHAR(160) NOT NULL,
  subtitle VARCHAR(255) NOT NULL DEFAULT '',
  amount_cents INT UNSIGNED NOT NULL,
  minimum_cents INT UNSIGNED NOT NULL,
  status ENUM('valid','used','expired') NOT NULL DEFAULT 'valid',
  source VARCHAR(160) NOT NULL DEFAULT '',
  created_at BIGINT UNSIGNED NOT NULL,
  expires_at BIGINT UNSIGNED NOT NULL,
  used_at BIGINT UNSIGNED NULL,
  CONSTRAINT fk_coupons_customer FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE,
  CONSTRAINT fk_coupons_redemption FOREIGN KEY (redemption_id) REFERENCES redemptions(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS notices (
  id VARCHAR(50) PRIMARY KEY,
  customer_id VARCHAR(50) NOT NULL,
  type VARCHAR(40) NOT NULL,
  title VARCHAR(160) NOT NULL,
  description VARCHAR(500) NOT NULL,
  link_code VARCHAR(80) NOT NULL DEFAULT '',
  \`read\` TINYINT(1) NOT NULL DEFAULT 0,
  created_at BIGINT UNSIGNED NOT NULL,
  CONSTRAINT fk_notices_customer FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE,
  CONSTRAINT chk_notices_read CHECK (\`read\` IN (0,1))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS audit_logs (
  id VARCHAR(50) PRIMARY KEY,
  actor_type VARCHAR(40) NOT NULL,
  actor_id VARCHAR(50) NOT NULL DEFAULT '',
  actor_name VARCHAR(100) NOT NULL DEFAULT '',
  action VARCHAR(80) NOT NULL,
  entity_type VARCHAR(80) NOT NULL,
  entity_id VARCHAR(80) NOT NULL DEFAULT '',
  store_id VARCHAR(50) NULL,
  ip VARCHAR(80) NOT NULL DEFAULT '',
  position VARCHAR(500) NOT NULL DEFAULT '',
  result VARCHAR(500) NOT NULL,
  detail_json JSON NOT NULL,
  created_at BIGINT UNSIGNED NOT NULL,
  INDEX idx_audit_created (created_at DESC),
  INDEX idx_audit_store (store_id,created_at DESC),
  CONSTRAINT fk_audit_store FOREIGN KEY (store_id) REFERENCES stores(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS notification_outbox (
  id VARCHAR(50) PRIMARY KEY,
  customer_id VARCHAR(50) NOT NULL,
  type VARCHAR(40) NOT NULL,
  payload_json JSON NOT NULL,
  status ENUM('pending','sent','failed','skipped') NOT NULL DEFAULT 'pending',
  attempts SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  next_attempt_at BIGINT UNSIGNED NOT NULL,
  last_error VARCHAR(500) NOT NULL DEFAULT '',
  created_at BIGINT UNSIGNED NOT NULL,
  sent_at BIGINT UNSIGNED NULL,
  INDEX idx_outbox_delivery (status,next_attempt_at,created_at),
  CONSTRAINT fk_outbox_customer FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
`

const transactionStorage = new AsyncLocalStorage()

function mysqlOptions(config, includeDatabase = true) {
  const options = {
    host: config.database.host,
    port: config.database.port,
    user: config.database.user,
    password: config.database.password,
    charset: 'utf8mb4',
    timezone: 'Z',
    supportBigNumbers: true,
    bigNumberStrings: false,
    decimalNumbers: true,
    dateStrings: true,
    enableKeepAlive: true,
    connectTimeout: 10_000,
    ssl: config.database.ssl ? { minVersion: 'TLSv1.2' } : undefined
  }
  if (includeDatabase) options.database = config.database.name
  return options
}

async function openMysql(config, seed) {
  const name = config.database.name
  if (!/^[A-Za-z0-9_]+$/.test(name)) throw new Error('DB_NAME 仅允许字母、数字和下划线')
  let setup
  try {
    setup = await mysql.createConnection({ ...mysqlOptions(config), multipleStatements: true })
  } catch (error) {
    if (error?.code !== 'ER_BAD_DB_ERROR' || !config.database.autoCreate) throw error
    const admin = await mysql.createConnection({ ...mysqlOptions(config, false), multipleStatements: true })
    try {
      await admin.query(`CREATE DATABASE IF NOT EXISTS \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`)
    } finally {
      await admin.end()
    }
    setup = await mysql.createConnection({ ...mysqlOptions(config), multipleStatements: true })
  }
  try {
    await setup.query(mysqlSchema)
  } finally {
    await setup.end()
  }
  const pool = mysql.createPool({
    ...mysqlOptions(config),
    waitForConnections: true,
    connectionLimit: config.database.connectionLimit,
    maxIdle: config.database.connectionLimit,
    idleTimeout: 60_000,
    queueLimit: 0
  })
  const db = { driver: 'mysql', pool, async close() { await pool.end() } }
  await migrateUnlimitedDailyRedemption(db)
  await migrateBrandSettings(db)
  const cashRequestColumn = await queryOne(db, "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='cash_rewards' AND COLUMN_NAME='request_json'")
  if (!cashRequestColumn) await execute(db, 'ALTER TABLE cash_rewards ADD COLUMN request_json JSON NULL AFTER amount_cents')
  await migrateSalesManagement(db)
  await migrateReusablePoolNames(db)
  await migratePrizeShowcase(db)
  const version = await queryOne(db, "SELECT value FROM schema_meta WHERE `key`='seed_version'")
  if (seed && !version) await seedDatabase(db)
  return db
}

async function migrateUnlimitedDailyRedemption(db) {
  const constraint = await queryOne(db, `SELECT CHECK_CLAUSE AS check_clause
    FROM information_schema.CHECK_CONSTRAINTS
    WHERE CONSTRAINT_SCHEMA=DATABASE() AND CONSTRAINT_NAME='chk_settings_daily_limit'`)
  if (!/between\s+0\s+and\s+20/i.test(String(constraint?.check_clause || ''))) {
    if (constraint) await execute(db, 'ALTER TABLE settings DROP CHECK chk_settings_daily_limit')
    await execute(db, 'ALTER TABLE settings ADD CONSTRAINT chk_settings_daily_limit CHECK (daily_limit BETWEEN 0 AND 20)')
  }

  const migrationId = 'unlimited_daily_redemption_v1'
  const migrated = await queryOne(db, 'SELECT value FROM schema_meta WHERE `key`=?', migrationId)
  if (!migrated) {
    await execute(db, 'UPDATE settings SET daily_limit=0,updated_at=? WHERE id=1', Date.now())
    await execute(db, 'INSERT INTO schema_meta (`key`,value) VALUES (?,?)', migrationId, String(Date.now()))
  }
}

async function migrateBrandSettings(db) {
  const rows = await queryAll(db, `SELECT COLUMN_NAME AS column_name FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='settings' AND COLUMN_NAME IN ('brand_mark','brand_logo','admin_subtitle')`)
  const columns = new Set(rows.map(row => row.column_name))
  if (!columns.has('brand_mark')) await execute(db, "ALTER TABLE settings ADD COLUMN brand_mark VARCHAR(8) NOT NULL DEFAULT '倌' AFTER brand_en")
  if (!columns.has('brand_logo')) await execute(db, "ALTER TABLE settings ADD COLUMN brand_logo VARCHAR(500) NOT NULL DEFAULT '' AFTER brand_mark")
  if (!columns.has('admin_subtitle')) await execute(db, "ALTER TABLE settings ADD COLUMN admin_subtitle VARCHAR(80) NOT NULL DEFAULT '总部运营中枢' AFTER brand_logo")
}

async function migrateSalesManagement(db) {
  const roleColumn = await queryOne(db, `SELECT COLUMN_TYPE AS column_type FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='admin_users' AND COLUMN_NAME='role'`)
  if (!String(roleColumn?.column_type || '').includes("'sales'")) {
    await execute(db, "ALTER TABLE admin_users MODIFY role ENUM('super_admin','operator','auditor','sales') NOT NULL")
  }

  const creatorColumn = await queryOne(db, `SELECT COLUMN_NAME AS column_name FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='stores' AND COLUMN_NAME='created_by_admin_id'`)
  if (!creatorColumn) {
    await execute(db, 'ALTER TABLE stores ADD COLUMN created_by_admin_id VARCHAR(50) NULL AFTER status, ADD INDEX idx_stores_creator (created_by_admin_id)')
  }

  const creatorForeignKey = await queryOne(db, `SELECT CONSTRAINT_NAME AS constraint_name FROM information_schema.REFERENTIAL_CONSTRAINTS
    WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='stores' AND CONSTRAINT_NAME='fk_stores_creator'`)
  if (!creatorForeignKey) {
    await execute(db, 'ALTER TABLE stores ADD CONSTRAINT fk_stores_creator FOREIGN KEY (created_by_admin_id) REFERENCES admin_users(id) ON DELETE SET NULL')
  }
}

async function migrateReusablePoolNames(db) {
  const indexes = await queryAll(db, `SELECT INDEX_NAME AS index_name
    FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='prize_pools' AND NON_UNIQUE=0
    GROUP BY INDEX_NAME
    HAVING COUNT(*)=1 AND SUM(COLUMN_NAME='name')=1`)
  for (const row of indexes) {
    const indexName = String(row.index_name).replaceAll('`', '``')
    await execute(db, `ALTER TABLE prize_pools DROP INDEX \`${indexName}\``)
  }
}

async function migratePrizeShowcase(db) {
  const rows = await queryAll(db, `SELECT COLUMN_NAME AS column_name FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='prizes' AND COLUMN_NAME IN ('display_only','showcase_weight')`)
  const columns = new Set(rows.map(row => row.column_name))
  // Defaults preserve all existing prize eligibility and equal display frequency.
  if (!columns.has('display_only')) await execute(db, 'ALTER TABLE prizes ADD COLUMN display_only TINYINT(1) NOT NULL DEFAULT 0 AFTER weight')
  if (!columns.has('showcase_weight')) await execute(db, 'ALTER TABLE prizes ADD COLUMN showcase_weight DECIMAL(12,4) UNSIGNED NOT NULL DEFAULT 1 AFTER display_only')
  const constraints = await queryAll(db, `SELECT CONSTRAINT_NAME AS constraint_name FROM information_schema.TABLE_CONSTRAINTS
    WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='prizes' AND CONSTRAINT_NAME IN ('chk_prizes_display_only','chk_prizes_showcase_weight')`)
  const names = new Set(constraints.map(row => row.constraint_name))
  if (!names.has('chk_prizes_display_only')) await execute(db, 'ALTER TABLE prizes ADD CONSTRAINT chk_prizes_display_only CHECK (display_only IN (0,1))')
  if (!names.has('chk_prizes_showcase_weight')) await execute(db, 'ALTER TABLE prizes ADD CONSTRAINT chk_prizes_showcase_weight CHECK (showcase_weight BETWEEN 0 AND 100000)')
}

export async function openDatabase(config, { seed = config.database.seed } = {}) {
  // 平台只支持 MySQL 8.0。旧版本的 SQLite 适配器已经拆除，遇到残留的
  // DB_DRIVER=sqlite 要立刻报错，不能悄悄连到别的库上去。
  if (config.database.driver !== 'mysql') {
    throw new Error(`不支持的 DB_DRIVER=${config.database.driver}，本平台只支持 mysql`)
  }
  const db = await openMysql(config, seed)
  await ensureSettingsRow(db)
  return db
}

// settings 是全站单行配置表，publicConfig / customerBootstrap 都直接读它。
// 未灌演示数据的全新库（正式环境 seed 恒为 false）如果缺这一行，
// /api/customer/bootstrap 会在 settingView 里抛 TypeError，
// 表现为「微信授权成功但登录不进去」。这里保证它一定存在。
async function ensureSettingsRow(db) {
  const now = Date.now()
  const today = new Date(now).toISOString().slice(0, 10)
  const end = new Date(now + 365 * 86_400_000).toISOString().slice(0, 10)
  const defaultFlow = JSON.stringify(DEFAULT_REDEMPTION_FLOW)
  await execute(db, `INSERT IGNORE INTO settings (
    id, brand, brand_en, activity_name, activity_subtitle, slogan, active,
    activity_start, activity_end, daily_limit, prize_valid_days, home_bg,
    poster, product_image, rule_bg, notice_json, flow_json, service_json, updated_at
  ) VALUES (1, ?, ?, ?, ?, ?, 0, ?, ?, 0, 30, ?, '', ?, ?, ?, ?, ?, ?)`,
    '倌榔', 'GUANLANG', '开码有奖', '一码一兑 · 全程可追溯', '撕开包装，扫码开奖',
    today, end,
    DEFAULT_BRAND_BACKGROUND,
    DEFAULT_PRODUCT_IMAGE,
    DEFAULT_BRAND_BACKGROUND,
    JSON.stringify({ enabled: false, badge: '公告', buttonText: '我知道了', image: '', title: '', date: today, lines: [] }),
    defaultFlow,
    JSON.stringify({ phone: '', wechat: '', hours: '' }),
    now)
  // Upgrade only the known empty/legacy built-in flow. Any future custom flow is preserved.
  await execute(db, `UPDATE settings SET flow_json=?,updated_at=? WHERE id=1 AND (
    JSON_LENGTH(flow_json)=0 OR
    JSON_UNQUOTE(JSON_EXTRACT(flow_json,'$[1].description'))='包装袋内印有 6 位字母数字兑换码'
  )`, defaultFlow, now)

  // Replace only the built-in placeholder. Product images configured by admins are preserved.
  await execute(db, `UPDATE settings SET product_image=?,updated_at=? WHERE id=1 AND (
    product_image='' OR product_image='/assets/product-nut.jpg'
  )`, DEFAULT_PRODUCT_IMAGE, now)

  // Upgrade only the original bundled backgrounds. Admin-uploaded custom assets are preserved.
  await execute(db, `UPDATE settings SET home_bg=?,updated_at=? WHERE id=1 AND (
    home_bg='' OR home_bg='/assets/hero-plantation.jpg'
  )`, DEFAULT_BRAND_BACKGROUND, now)
  await execute(db, `UPDATE settings SET rule_bg=?,updated_at=? WHERE id=1 AND (
    rule_bg='' OR rule_bg='/assets/bg-grove.jpg'
  )`, DEFAULT_BRAND_BACKGROUND, now)
}

function targetFor(db) {
  const active = transactionStorage.getStore()
  return active?.db === db ? active.connection : db.pool
}

export async function transaction(db, fn) {
  if (transactionStorage.getStore()?.db === db) return fn()
  const connection = await db.pool.getConnection()
  try {
    await connection.beginTransaction()
    const value = await transactionStorage.run({ db, connection }, fn)
    await connection.commit()
    return value
  } catch (error) {
    await connection.rollback()
    throw error
  } finally {
    connection.release()
  }
}

export async function execute(db, sql, ...params) {
  const [result] = await targetFor(db).execute(sql, params)
  return { changes: Number(result.affectedRows || 0), affectedRows: Number(result.affectedRows || 0), insertId: result.insertId }
}

export async function queryOne(db, sql, ...params) {
  const [rows] = await targetFor(db).query(sql, params)
  return rows[0] || null
}

export async function queryAll(db, sql, ...params) {
  const [rows] = await targetFor(db).query(sql, params)
  return rows
}

export function parseJson(value, fallback = null) {
  if (value && typeof value === 'object') return value
  try {
    return JSON.parse(value)
  } catch {
    return fallback
  }
}
