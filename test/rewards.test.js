import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { createApp } from '../src/server.js'
import { execute, queryOne } from '../src/database.js'

let app, customer, other, owner, admin, pool, exchange, cash, batch, base
let serial = 600000
const password = randomBytes(24).toString('base64url')
const priorSeed = Object.fromEntries(['ADMIN','OPERATOR','SALES','STORE'].map(key => [key, process.env[`SEED_${key}_PASSWORD`]]))

test.before(async () => {
  for (const key of Object.keys(priorSeed)) process.env[`SEED_${key}_PASSWORD`] = password
  app = await createApp({ dbHost: process.env.TEST_DB_HOST || '127.0.0.1', dbPort: Number(process.env.TEST_DB_PORT || 3306),
    dbUser: process.env.TEST_DB_USER || 'root', dbPassword: process.env.TEST_DB_PASSWORD || '',
    dbName: (process.env.TEST_DB_NAME || 'xin_binlang_test') + '_rewards', dbAutoCreate: true, dbSeed: true,
    tokenSecret: randomBytes(32).toString('hex') })
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${app.server.address().port}`
  admin = await queryOne(app.db, "SELECT * FROM admin_users WHERE username='admin'")
  // This suite owns the showcase candidate fixtures; seeded examples still
  // retain their draw eligibility but do not enter the showcase sample.
  await execute(app.db, "UPDATE prizes SET showcase_weight=0 WHERE pool_id IN ('P-A','P-B','P-C')")
  customer = await queryOne(app.db, "SELECT * FROM customers WHERE id='C001'")
  other = await queryOne(app.db, "SELECT * FROM customers WHERE id='C002'")
  owner = await queryOne(app.db, "SELECT * FROM store_accounts WHERE username='yht_owner'")
  // An isolated fixture identity. No test ever invokes a real transfer transport.
  await execute(app.db, 'UPDATE customers SET openid=? WHERE id=?', 'oGuanlangLocalFixtureOnly', customer.id)
  pool = await app.service.savePool(admin, null, { name: '翻牌测试', tier: '50 元', status: 'active' })
  exchange = await app.service.savePrize(admin, null, { poolId: pool.id, name: '倌榔深蓝装', type: 'exchange', valueCents: 5000, exchangeCents: 300, stock: 20, weight: 1, img: '/assets/guanlang-product-50.jpg' })
  assert.equal(exchange.displayOnly, false)
  assert.equal(exchange.showcaseWeight, 1)
  cash = await app.service.savePrize(admin, null, { poolId: pool.id, name: '现金红包', type: 'cash', valueCents: 200, stock: 20, weight: 1, status: 'disabled' })
  batch = await app.service.saveBatch(admin, null, { id: 'FLIP_TEST', name: '翻牌测试批次', productTier: '50 元', priceCents: 5000, poolId: pool.id, winRatePpm: 1000000, startsAt: Date.now()-10000, expiresAt: Date.now()+86400000 })
})
test.after(async () => {
  await app?.close()
  for (const [key, value] of Object.entries(priorSeed)) {
    if (value === undefined) delete process.env[`SEED_${key}_PASSWORD`]
    else process.env[`SEED_${key}_PASSWORD`] = value
  }
})
async function codeFor(prize) {
  const code = String(++serial)
  await execute(app.db, 'INSERT INTO redeem_codes (code,batch_id,forced_outcome,forced_prize_id,created_at) VALUES (?,?,?,?,?)', code, batch.id, prize ? 'win' : 'lose', prize?.id || null, Date.now())
  return code
}
async function api(path, body, person = customer) {
  const token = app.service.customerSession(person).token
  const response = await fetch(base + path, { method: body ? 'POST' : 'GET', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
  return { status: response.status, ...(await response.json()) }
}

test('code preview chooses the actual batch packaging without drawing and hides private pools from the showcase', async () => {
  const code = await codeFor(exchange)
  const before = await queryOne(app.db, 'SELECT COUNT(*) n FROM redemptions')
  const quantity = await queryOne(app.db, 'SELECT stock FROM prizes WHERE id=?', exchange.id)
  await app.service.savePool(admin, pool.id, { presentation: { theme: 'gold', visible: false, productImg: '/assets/guanlang-product-30.png' } })
  const preview = await api('/api/customer/draw/preview', { code })
  assert.equal(preview.status, 200)
  assert.equal(preview.data.presentation.theme, 'gold')
  assert.equal(preview.data.presentation.productImg, '/assets/guanlang-product-30.png')
  assert.equal(preview.data.poolId, pool.id)
  assert.equal(preview.data.guaranteed, true)
  assert.ok(preview.data.prizes.every(p => !('stock' in p) && !('weight' in p)))
  assert.equal((await queryOne(app.db, 'SELECT status FROM redeem_codes WHERE code=?', code)).status, 'unused')
  assert.equal((await queryOne(app.db, 'SELECT COUNT(*) n FROM redemptions')).n, before.n)
  assert.equal((await queryOne(app.db, 'SELECT stock FROM prizes WHERE id=?', exchange.id)).stock, quantity.stock)
  assert.ok(!(await app.service.publicPools()).some(p => p.id === pool.id))
  assert.ok(!(await app.service.publicPrizes()).some(p => p.pool === pool.id))
  const bootstrap = await app.service.customerBootstrap(customer.id)
  assert.ok(!bootstrap.pools.some(p => p.id === pool.id))
  assert.ok(!bootstrap.prizes.some(p => p.pool === pool.id))
  await app.service.savePrize(admin, exchange.id, { stock: 0 })
  assert.equal((await app.service.previewDraw(customer.id, code)).guaranteed, false)
  await app.service.savePrize(admin, exchange.id, { stock: quantity.stock })
  await app.service.redeem(customer.id, code, '', '', 2)
  assert.equal((await api('/api/customer/draw/preview', { code }, other)).status, 409)
  await app.service.savePool(admin, pool.id, { presentation: { theme: 'blue', visible: true } })
  await assert.rejects(app.service.savePool(admin, pool.id, { presentation: { productImg: 'javascript:alert(1)' } }), error => error.code === 'ERR_PRESENTATION')
})

test('flip choice is required; concurrent retries retain one chosen card, one result and one stock debit', async () => {
  const code = await codeFor(exchange)
  assert.equal((await api('/api/customer/draw', { code, selectedCard: 7 })).status, 400)
  const before = await queryOne(app.db, 'SELECT stock FROM prizes WHERE id=?', exchange.id)
  const replies = await Promise.all([1, 2].map(selectedCard => api('/api/customer/draw', { code, selectedCard, valueCents: 1, prizeId: cash.id })))
  assert.ok(replies.every(item => item.status === 200))
  assert.equal(replies[0].data.record.id, replies[1].data.record.id)
  assert.equal(replies[0].data.record.selectedCard, replies[1].data.record.selectedCard)
  assert.equal(replies[0].data.record.prizeType, 'exchange')
  assert.equal(replies[0].data.record.exchangeCents, 300)
  assert.equal((await queryOne(app.db, 'SELECT stock FROM prizes WHERE id=?', exchange.id)).stock, before.stock - 1)
  assert.equal((await api('/api/customer/draw', { code, selectedCard: 3 }, other)).status, 409)
  const won = replies[0].data.record
  await app.service.savePrize(admin, exchange.id, { exchangeCents: 500 })
  assert.equal((await app.service.customerRecord(customer.id, won.id)).exchangeCents, 300)
  await assert.rejects(app.service.verify(owner, code, '', '', false), error => error.code === 'ERR_EXCHANGE_PAYMENT')
  assert.equal((await app.service.verify(owner, code, '', '', true)).record.status, 'verified')
  await assert.rejects(app.service.verify(owner, code, '', '', true), error => error.code === 'ERR_DUP')
})

test('card previews include configured public prizes without changing the code pool or exposing private prizes', async () => {
  const publicPool = await app.service.savePool(admin, null, { name: '展示奖池', tier: '30 元', status: 'active' })
  const privatePool = await app.service.savePool(admin, null, { name: '不公开奖池', tier: '专属', status: 'active', presentation: { visible: false } })
  const pausedPool = await app.service.savePool(admin, null, { name: '停用奖池', tier: '停用', status: 'disabled' })
  const createPrize = (poolId, name, status = 'active') => app.service.savePrize(admin, null, { poolId, name, status, type: 'goods', valueCents: 3000, stock: 50, weight: 1, img: '/assets/guanlang-product-30.png' })
  const visible = await createPrize(publicPool.id, '其他已配置奖品')
  const disabled = await createPrize(publicPool.id, '已停用奖品', 'disabled')
  const privatePrize = await createPrize(privatePool.id, '其他私有奖品')
  const pausedPrize = await createPrize(pausedPool.id, '停用奖池奖品')
  const code = await codeFor(exchange)
  await app.service.savePool(admin, pool.id, { presentation: { visible: false } })
  try {
    const { data: preview } = await api('/api/customer/draw/preview', { code })
    assert.deepEqual(preview.prizes.map(prize => prize.id), [exchange.id])
    assert.ok(preview.displayPrizes.some(prize => prize.id === exchange.id))
    assert.ok(preview.displayPrizes.some(prize => prize.id === visible.id))
    for (const prize of [cash, disabled, privatePrize, pausedPrize]) {
      assert.ok(!preview.displayPrizes.some(item => item.id === prize.id))
    }
    assert.equal(new Set(preview.displayPrizes.map(prize => prize.id)).size, preview.displayPrizes.length)
    assert.ok(preview.displayPrizes.length <= 5)
    assert.ok(preview.displayPrizes.every(prize => !('stock' in prize) && !('weight' in prize) && !('sent' in prize) && !('showcaseWeight' in prize)))
    assert.equal((await queryOne(app.db, 'SELECT status FROM redeem_codes WHERE code=?', code)).status, 'unused')
    const stock = (await queryOne(app.db, 'SELECT stock FROM prizes WHERE id=?', exchange.id)).stock
    await app.service.savePrize(admin, exchange.id, { stock: 0 })
    try {
      assert.equal((await app.service.previewDraw(customer.id, code)).guaranteed, false)
    } finally {
      await app.service.savePrize(admin, exchange.id, { stock })
    }
    const drawn = await app.service.redeem(customer.id, code, '', '', 3)
    assert.equal(drawn.record.poolId, pool.id)
    assert.equal(drawn.record.prizeId, exchange.id)
    assert.equal((await queryOne(app.db, 'SELECT stock FROM prizes WHERE id=?', visible.id)).stock, 50)
  } finally {
    await app.service.savePool(admin, pool.id, { presentation: { visible: true } })
    await app.service.savePool(admin, publicPool.id, { status: 'disabled' })
  }
})

test('display-only prizes appear only in card showcases and can never consume stock or award a real prize', async () => {
  const displayPool = await app.service.savePool(admin, null, { name: '展示独立测试', tier: '专属', status: 'active', presentation: { visible: false } })
  const displayPrize = await app.service.savePrize(admin, null, { poolId: displayPool.id, name: '展示手机', type: 'goods', valueCents: 999900, stock: 50, weight: 99999, displayOnly: true, showcaseWeight: 2.5 })
  const displayCash = await app.service.savePrize(admin, null, { poolId: displayPool.id, name: '展示红包', type: 'cash', valueCents: 888800, stock: 50, displayOnly: true, showcaseWeight: 0 })
  const realPrize = await app.service.savePrize(admin, null, { poolId: displayPool.id, name: '实际奖品', type: 'goods', valueCents: 100, stock: 0, weight: 1, showcaseWeight: 0 })
  const localBatch = await app.service.saveBatch(admin, null, { id: 'SHOWCASE_TEST', name: '展示规则测试', productTier: '50 元', priceCents: 5000, poolId: displayPool.id, winRatePpm: 1000000, startsAt: Date.now() - 1000, expiresAt: Date.now() + 86400000 })
  const code = String(++serial)
  await execute(app.db, 'INSERT INTO redeem_codes (code,batch_id,created_at) VALUES (?,?,?)', code, localBatch.id, Date.now())
  try {
    const preview = await app.service.previewDraw(customer.id, code)
    assert.equal(preview.guaranteed, false, 'display-only stock must not make the pool look guaranteed')
    assert.ok(preview.prizes.every(prize => prize.id !== displayPrize.id && prize.id !== displayCash.id))
    assert.ok(preview.displayPrizes.some(prize => prize.id === displayPrize.id))
    assert.ok(preview.displayPrizes.every(prize => prize.id !== displayCash.id && prize.id !== realPrize.id))
    await app.service.savePool(admin, displayPool.id, { presentation: { visible: true } })
    assert.ok(!(await app.service.publicPrizes()).some(prize => prize.id === displayPrize.id || prize.id === displayCash.id))
    const partial = await app.service.savePrize(admin, displayPrize.id, { name: '修改展示手机' })
    assert.equal(partial.displayOnly, true)
    assert.equal(partial.showcaseWeight, 2.5)
    await assert.rejects(app.service.savePrize(admin, displayPrize.id, { showcaseWeight: -1 }), error => error.code === 'ERR_NUMBER')
    await assert.rejects(app.service.savePrize(admin, displayPrize.id, { displayOnly: 'false' }), error => error.code === 'ERR_DISPLAY_ONLY')

    await app.service.savePrize(admin, realPrize.id, { stock: 2 })
    const drawn = await app.service.redeem(customer.id, code, '', '', 2)
    assert.equal(drawn.record.prizeId, realPrize.id, 'a large showcase/draw weight cannot enable a display-only prize')
    assert.equal((await queryOne(app.db, 'SELECT stock FROM prizes WHERE id=?', displayPrize.id)).stock, 50)
    assert.equal((await queryOne(app.db, 'SELECT stock FROM prizes WHERE id=?', displayCash.id)).stock, 50)

    const forced = String(++serial)
    await execute(app.db, 'INSERT INTO redeem_codes (code,batch_id,forced_outcome,forced_prize_id,created_at) VALUES (?,?,?,?,?)', forced, localBatch.id, 'win', displayPrize.id, Date.now())
    await assert.rejects(app.service.redeem(customer.id, forced, '', '', 4), error => error.code === 'ERR_PRIZE_DISPLAY_ONLY')
    assert.equal((await queryOne(app.db, 'SELECT status FROM redeem_codes WHERE code=?', forced)).status, 'unused')
  } finally {
    await app.service.savePool(admin, displayPool.id, { status: 'disabled' })
  }
})

test('thanks result creates no fabricated compensation coupon; repeat draw cannot reroll', async () => {
  const before = Number((await queryOne(app.db, 'SELECT COUNT(*) n FROM coupons WHERE customer_id=?', customer.id)).n)
  const code = await codeFor(null)
  const first = await api('/api/customer/draw', { code, selectedCard: 4 })
  const again = await api('/api/customer/draw', { code, selectedCard: 6 })
  assert.equal(first.data.code, 'OK_LOSE')
  assert.equal(first.data.msg, '谢谢惠顾')
  assert.equal(again.data.record.selectedCard, 4)
  assert.equal(Number((await queryOne(app.db, 'SELECT COUNT(*) n FROM coupons WHERE customer_id=?', customer.id)).n), before)
})

test('cash configuration missing does not consume code; only its owner can claim', async () => {
  await app.service.savePrize(admin, cash.id, { status: 'active' })
  const code = await codeFor(cash)
  const failed = await api('/api/customer/draw', { code, selectedCard: 1 })
  assert.equal(failed.data, undefined)
  assert.equal(failed.error.code, 'ERR_CASH_NOT_CONFIGURED')
  assert.equal((await queryOne(app.db, 'SELECT status FROM redeem_codes WHERE code=?', code)).status, 'unused')
})

test('cash retry reconciles the immutable bill, accepts only provider SUCCESS and rejects store settlement', async () => {
  const ledger = app.service.cash
  ledger.ready = () => true
  Object.assign(ledger.config, { mchId: 'local-merchant', appId: 'local-app', sceneId: '1000', activityName: '本地测试', rewardDescription: '翻牌奖励' })
  let calls = 0, state = 'WAIT_USER_CONFIRM', persistedBill
  ledger.provider = {
    async create(row) {
      calls++
      if (!persistedBill) { persistedBill = row; throw new Error('simulated connection loss after provider acceptance') }
      assert.equal(row.out_bill_no, persistedBill.out_bill_no)
      assert.deepEqual(row.request_json, persistedBill.request_json)
      return { out_bill_no: row.out_bill_no, state, package_info: 'local-confirmation' }
    },
    // WeChat query responses do not include the confirmation package.
    async query(row) { assert.equal(row.out_bill_no, persistedBill.out_bill_no); return { out_bill_no: row.out_bill_no, state, transfer_bill_no: 'local-transfer', transfer_amount: row.amount_cents, openid: row.openid } }
  }
  const code = await codeFor(cash)
  const drawn = (await api('/api/customer/draw', { code, selectedCard: 5 })).data.record
  const denied = await api(`/api/customer/records/${drawn.id}/cash/claim`, { amount: 999 }, other)
  assert.equal(denied.status, 404)
  const [a,b] = await Promise.all([1,2].map(() => api(`/api/customer/records/${drawn.id}/cash/claim`, { amount: 999 })))
  assert.equal(a.status, 200); assert.equal(b.status, 200)
  assert.equal(calls, 1)
  assert.equal(persistedBill.amount_cents, 200)
  assert.equal((await app.service.customerRecord(customer.id, drawn.id)).status, 'pending')
  await assert.rejects(app.service.verifyLookup(owner, code), error => error.code === 'ERR_CASH_STORE')
  await assert.rejects(app.service.freezeRedemption(admin, drawn.id, true, 'test'), error => error.code === 'ERR_CASH_IN_FLIGHT')
  await execute(app.db, 'UPDATE cash_rewards SET lease_until=0 WHERE redemption_id=?', drawn.id)
  const waiting = await ledger.status(customer.id, drawn.id)
  assert.equal(waiting.state, 'WAIT_USER_CONFIRM')
  assert.equal(waiting.confirmation, undefined)
  await execute(app.db, 'UPDATE cash_rewards SET lease_until=0 WHERE redemption_id=?', drawn.id)
  const recovered = await ledger.claim(customer.id, drawn.id)
  assert.equal(recovered.confirmation.appId, 'local-app')
  assert.equal(recovered.confirmation.package, 'local-confirmation')
  assert.equal(calls, 2)
  await execute(app.db, 'UPDATE redemptions SET expires_at=? WHERE id=?', Date.now()-1, drawn.id)
  await app.service.expireOrders()
  assert.equal((await app.service.customerRecord(customer.id, drawn.id)).status, 'pending')
  state = 'SUCCESS'
  await execute(app.db, 'UPDATE cash_rewards SET lease_until=0 WHERE redemption_id=?', drawn.id)
  assert.equal((await ledger.status(customer.id, drawn.id)).state, 'SUCCESS')
  assert.equal((await app.service.customerRecord(customer.id, drawn.id)).cashState, 'SUCCESS')
  assert.equal((await app.service.customerRecord(customer.id, drawn.id)).status, 'verified')
  await ledger.claim(customer.id, drawn.id)
  assert.equal(calls, 2)
  assert.equal((await queryOne(app.db, 'SELECT sent_count FROM prizes WHERE id=?', cash.id)).sent_count, 1)
})

test('invalid provider amount never settles; failed transfers are never silently reissued', async () => {
  const ledger = app.service.cash
  let calls = 0
  ledger.provider = {
    async create(row) { calls++; return { out_bill_no: row.out_bill_no, state: 'WAIT_USER_CONFIRM', package_info: 'local' } },
    async query(row) { return { out_bill_no: row.out_bill_no, state: 'SUCCESS', transfer_amount: row.amount_cents + 1 } }
  }
  const code = await codeFor(cash)
  const record = (await api('/api/customer/draw', { code, selectedCard: 2 })).data.record
  await ledger.claim(customer.id, record.id)
  await execute(app.db, 'UPDATE cash_rewards SET lease_until=0 WHERE redemption_id=?', record.id)
  assert.equal((await ledger.status(customer.id, record.id)).state, 'WAIT_USER_CONFIRM')
  assert.equal((await app.service.customerRecord(customer.id, record.id)).status, 'pending')
  ledger.provider.query = async row => ({ out_bill_no: row.out_bill_no, state: 'FAIL', fail_reason: 'LOCAL_TEST_FAILURE' })
  await execute(app.db, 'UPDATE cash_rewards SET lease_until=0 WHERE redemption_id=?', record.id)
  assert.equal((await ledger.status(customer.id, record.id)).state, 'FAIL')
  await ledger.claim(customer.id, record.id)
  assert.equal(calls, 1)
})

test('a rejected create stays visible after NOT_FOUND polling and only an explicit claim retries the same bill', async () => {
  const ledger = app.service.cash
  let creates = 0, originalBill
  const denial = () => Object.assign(new Error('private provider response'), {
    providerCode: 'INVALID_REQUEST', providerErrorId: 'INVALID_REQUEST:APPID_MCHID_MISMATCH', providerStatus: 400
  })
  ledger.provider = {
    async create(row) {
      creates++
      if (originalBill) assert.equal(row.out_bill_no, originalBill)
      originalBill = row.out_bill_no
      throw denial()
    },
    async query() { throw Object.assign(new Error('not found'), { providerCode: 'NOT_FOUND' }) }
  }
  const code = await codeFor(cash)
  const record = (await api('/api/customer/draw', { code, selectedCard: 1 })).data.record
  const rejected = await ledger.claim(customer.id, record.id)
  assert.equal(rejected.state, 'UNKNOWN')
  assert.match(rejected.message, /小程序尚未关联/)
  await execute(app.db, 'UPDATE cash_rewards SET lease_until=0 WHERE redemption_id=?', record.id)
  const polled = await ledger.status(customer.id, record.id)
  assert.equal(polled.message, rejected.message)
  assert.equal(creates, 1)
  const audit = await queryOne(app.db, "SELECT detail_json FROM audit_logs WHERE entity_id=? AND action='cash_provider_error'", record.id)
  assert.ok(audit)
  assert.equal(JSON.stringify(audit).includes('private provider response'), false)
  await execute(app.db, 'UPDATE cash_rewards SET lease_until=0 WHERE redemption_id=?', record.id)
  await ledger.claim(customer.id, record.id)
  assert.equal(creates, 2)
  assert.equal((await queryOne(app.db, 'SELECT status FROM redemptions WHERE id=?', record.id)).status, 'pending')
})
