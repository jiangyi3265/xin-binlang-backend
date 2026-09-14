import { parseJson } from './database.js'

export function settingView(row) {
  const notice = parseJson(row.notice_json, {})
  const service = parseJson(row.service_json, {})
  return {
    brand: row.brand,
    brandEn: row.brand_en,
    brandMark: row.brand_mark || '倌',
    brandLogo: row.brand_logo || '',
    adminSubtitle: row.admin_subtitle || '总部运营中枢',
    actName: row.activity_name,
    actSub: row.activity_subtitle,
    slogan: row.slogan,
    active: Boolean(row.active),
    actStart: row.activity_start,
    actEnd: row.activity_end,
    codeLen: 6,
    dailyLimit: row.daily_limit,
    prizeValidDays: row.prize_valid_days,
    homeBg: row.home_bg,
    poster: row.poster,
    productImg: row.product_image,
    ruleBg: row.rule_bg,
    notice: { badge: '公告', buttonText: '我知道了', image: '', ...notice },
    flow: parseJson(row.flow_json, []),
    service: {
      phone: service.phone || '',
      wechat: service.wechat || '',
      time: service.time || service.hours || '',
      note: service.note || '本活动与设备厂商无关。如遇兑换码字迹模糊、包装破损等情况，请保留实物并联系客服处理。'
    },
    updatedAt: row.updated_at
  }
}

export function storeView(row) {
  if (!row) return null
  return {
    id: row.id,
    name: row.name,
    short: row.short_name,
    addr: row.address,
    latitude: row.latitude,
    longitude: row.longitude,
    phone: row.phone,
    hours: row.business_hours,
    img: row.image,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

export function poolView(row) {
  if (!row) return null
  return { id: row.id, name: row.name, desc: row.description, tier: row.tier_label, status: row.status, createdAt: row.created_at, updatedAt: row.updated_at }
}

export function prizeView(row, publicView = false) {
  if (!row) return null
  const item = {
    id: row.id,
    pool: row.pool_id,
    poolName: row.pool_name || '',
    name: row.name,
    spec: row.specification,
    level: row.level,
    type: row.category,
    value: row.value_cents / 100,
    valueCents: row.value_cents,
    exchangeCents: Number(row.exchange_cents || 0),
    exchangeAmount: Number(row.exchange_cents || 0) / 100,
    img: row.image,
    on: row.status === 'active',
    status: row.status
  }
  if (!publicView) Object.assign(item, { stock: row.stock, sent: row.sent_count, lowStockThreshold: row.low_stock_threshold, weight: row.weight, createdAt: row.created_at, updatedAt: row.updated_at })
  return item
}

export function accountView(row) {
  if (!row) return null
  return {
    id: row.id,
    storeId: row.store_id,
    storeName: row.store_name || '',
    username: row.username,
    name: row.name,
    phone: row.phone,
    avatar: row.avatar,
    role: row.role,
    permissions: parseJson(row.permissions_json, []),
    active: Boolean(row.active),
    lastLoginAt: row.last_login_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

export function customerView(row) {
  if (!row) return null
  return {
    id: row.id,
    openid: row.openid,
    nick: row.nickname,
    phone: row.phone,
    avatar: row.avatar,
    blocked: Boolean(row.blocked),
    blockedReason: row.blocked_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

export function redemptionView(row) {
  if (!row) return null
  const prize = parseJson(row.prize_snapshot_json, {})
  return {
    id: row.id,
    orderNo: row.order_no,
    code: row.code,
    batchId: row.batch_id,
    batchName: row.batch_name || '',
    poolId: row.pool_id,
    poolName: row.pool_name || '',
    price: Number(row.price_cents || 0) / 100,
    priceCents: Number(row.price_cents || 0),
    userId: row.customer_id,
    userNick: row.customer_nickname || '',
    userAvatar: row.customer_avatar || '',
    userPhone: row.customer_phone || '',
    win: Boolean(row.won),
    won: Boolean(row.won),
    prizeId: row.prize_id || '',
    prizeName: prize.name || '',
    prizeImg: prize.image || '',
    prizeValue: Number(prize.valueCents || 0) / 100,
    prizeValueCents: Number(prize.valueCents || 0),
    prizeLevel: prize.level || '',
    prizeSpec: prize.specification || '',
    prizeType: prize.category || '',
    exchangeCents: Number(prize.exchangeCents || 0),
    exchangeAmount: Number(prize.exchangeCents || 0) / 100,
    selectedCard: prize.selectedCard || null,
    cashState: row.cash_state || '',
    redeemAt: row.redeemed_at,
    expiresAt: row.expires_at,
    expireAt: row.expires_at,
    status: row.status,
    preferStoreId: row.preferred_store_id || '',
    preferStoreName: row.preferred_store_name || '',
    preferStoreAddress: row.preferred_store_address || '',
    storeId: row.verified_store_id || '',
    storeName: row.verified_store_name || '',
    storeAddress: row.verified_store_address || '',
    verifyAt: row.verified_at || 0,
    verifiedAt: row.verified_at || 0,
    verifyById: row.verified_by_account_id || '',
    verifyByName: row.verified_by_name || '',
    verifiedBy: row.verified_by_name || '',
    verifiedByUsername: row.verified_by_username || '',
    verifyPos: row.verified_position || '',
    verifiedPosition: row.verified_position || '',
    frozenReason: row.frozen_reason || '',
    updatedAt: row.updated_at
  }
}

export const redemptionJoin = `
  SELECT r.*, cr.state AS cash_state, b.name AS batch_name, b.price_cents, pp.name AS pool_name,
         c.nickname AS customer_nickname, c.phone AS customer_phone, c.avatar AS customer_avatar,
         ps.short_name AS preferred_store_name, ps.address AS preferred_store_address,
         vs.short_name AS verified_store_name, vs.address AS verified_store_address,
         sa.name AS verified_by_name, sa.username AS verified_by_username
  FROM redemptions r
  LEFT JOIN cash_rewards cr ON cr.redemption_id = r.id
  JOIN batches b ON b.id = r.batch_id
  JOIN prize_pools pp ON pp.id = r.pool_id
  JOIN customers c ON c.id = r.customer_id
  LEFT JOIN stores ps ON ps.id = r.preferred_store_id
  LEFT JOIN stores vs ON vs.id = r.verified_store_id
  LEFT JOIN store_accounts sa ON sa.id = r.verified_by_account_id
`
