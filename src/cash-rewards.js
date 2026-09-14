import { randomBytes } from 'node:crypto'
import { execute, parseJson, queryAll, queryOne, transaction } from './database.js'
import { assert } from './http-utils.js'
import { WechatTransfer, transferReady } from './wechat-transfer.js'

const TERMINAL = new Set(['SUCCESS', 'FAIL', 'CANCELLED', 'REVIEW_REQUIRED'])
const PROVIDER_STATES = new Set(['ACCEPTED', 'PROCESSING', 'WAIT_USER_CONFIRM', 'TRANSFERING', 'SUCCESS', 'FAIL', 'CANCELING', 'CANCELLED'])
const LABELS = { NOT_CLAIMED: '待领取', SUBMITTING: '领取处理中', UNKNOWN: '正在确认结果', ACCEPTED: '领取处理中', PROCESSING: '领取处理中', WAIT_USER_CONFIRM: '待确认收款', TRANSFERING: '转账中', SUCCESS: '已到账', FAIL: '发放失败，请联系客服', CANCELING: '正在撤销', CANCELLED: '已撤销，请联系客服', REVIEW_REQUIRED: '需人工核对' }

export class CashRewards {
  constructor(service) {
    this.service = service
    this.db = service.db
    this.config = service.config.transfer
    this.provider = new WechatTransfer(this.config)
    this.reconciling = false
  }

  ready() { return transferReady(this.config) }

  view(row) {
    const state = row?.state || 'NOT_CLAIMED'
    return {
      state, label: LABELS[state] || '正在确认结果', ready: this.ready(),
      amount: Number(row?.amount_cents || 0) / 100,
      ...(state === 'WAIT_USER_CONFIRM' && row.package_info ? {
        confirmation: { mchId: row.mch_id, appId: row.app_id, package: row.package_info }
      } : {})
    }
  }

  async ownedRecord(customerId, id, lock = false) {
    const row = await queryOne(this.db, 'SELECT * FROM redemptions WHERE id=? AND customer_id=?' + (lock ? ' FOR UPDATE' : ''), id, customerId)
    assert(row, 404, 'ERR_RECORD_NOT_FOUND', '兑奖记录不存在')
    assert(row.won && parseJson(row.prize_snapshot_json, {}).category === 'cash', 409, 'ERR_NOT_CASH', '该凭证不是现金红包')
    return row
  }

  async claim(customerId, id, ip = '') {
    assert(this.ready(), 409, 'ERR_CASH_NOT_CONFIGURED', '现金领取暂未开放，请稍后重试或联系客服')
    const now = Date.now()
    const decision = await transaction(this.db, async () => {
      const record = await this.ownedRecord(customerId, id, true)
      const existing = await queryOne(this.db, 'SELECT * FROM cash_rewards WHERE redemption_id=?', id)
      if (existing) return { row: existing, created: false }
      const customer = await queryOne(this.db, 'SELECT * FROM customers WHERE id=?', customerId)
      assert(customer && !customer.blocked, 403, 'ERR_BLOCKED', '账号受限，请联系客服')
      assert(record.status === 'pending' && record.expires_at > now, 409, 'ERR_RECORD_STATE', '该红包已失效或被冻结')
      const amount = Number(parseJson(record.prize_snapshot_json, {}).valueCents)
      assert(Number.isSafeInteger(amount) && amount > 0 && amount <= this.config.maxCents, 409, 'ERR_CASH_AMOUNT', '红包金额配置异常，请联系客服')
      assert(customer.openid && !['demo-customer', 'blocked-demo'].includes(customer.openid) && !customer.openid.startsWith('customer-'), 409, 'ERR_WECHAT_ACCOUNT', '请使用真实微信账号领取')
      const row = { redemption_id: id, customer_id: customerId, out_bill_no: 'GL' + randomBytes(15).toString('hex'),
        mch_id: this.config.mchId, app_id: this.config.appId, openid: customer.openid, amount_cents: amount,
        request_json: { sceneId: this.config.sceneId, activityName: this.config.activityName, rewardDescription: this.config.rewardDescription },
        state: 'SUBMITTING', created_at: now, updated_at: now, lease_until: now + 45000 }
      await execute(this.db, `INSERT INTO cash_rewards
        (redemption_id,customer_id,out_bill_no,mch_id,app_id,openid,amount_cents,request_json,state,created_at,updated_at,lease_until)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, id, customerId, row.out_bill_no, row.mch_id, row.app_id, row.openid, amount, JSON.stringify(row.request_json), row.state, now, now, row.lease_until)
      await this.service.audit({ actorType: 'customer', actorId: customerId, action: 'cash_claim', entityType: 'redemption', entityId: id, ip, result: '领取申请已保存', detail: { amountCents: amount, outBillNo: row.out_bill_no } })
      return { row, created: true }
    })
    // Intent is committed before any external request. A crash can only recover this same bill.
    if (decision.created) await this.send(decision.row, true)
    else await this.refresh(decision.row, true)
    return this.view(await queryOne(this.db, 'SELECT * FROM cash_rewards WHERE redemption_id=?', id))
  }

  async status(customerId, id) {
    await this.ownedRecord(customerId, id)
    let row = await queryOne(this.db, 'SELECT * FROM cash_rewards WHERE redemption_id=?', id)
    if (row) {
      await this.refresh(row, false)
      row = await queryOne(this.db, 'SELECT * FROM cash_rewards WHERE redemption_id=?', id)
    }
    return this.view(row)
  }

  async refresh(row, allowCreate = false) {
    if (!this.ready() || TERMINAL.has(row.state) || Number(row.lease_until) > Date.now()) return
    const leased = await execute(this.db, `UPDATE cash_rewards SET lease_until=? WHERE redemption_id=? AND lease_until<=?
      AND state NOT IN ('SUCCESS','FAIL','CANCELLED','REVIEW_REQUIRED')`, Date.now() + 45000, row.redemption_id, Date.now())
    if (leased.changes !== 1) return
    await this.send(row, false, allowCreate)
  }

  async send(row, create, allowCreate = false) {
    try {
      assert(row.mch_id === this.config.mchId && row.app_id === this.config.appId, 409, 'ERR_CASH_MERCHANT_CHANGED', '商户配置与原订单不一致')
      let reply
      if (create) reply = await this.provider.create(row)
      else {
        try { reply = await this.provider.query(row) }
        catch (error) {
          // Only an explicit re-claim may resubmit, and only with the immutable original bill number.
          if (allowCreate && error.providerCode === 'NOT_FOUND' && Date.now() - row.created_at < 86400000) reply = await this.provider.create(row)
          else throw error
        }
      }
      await this.apply(row, reply)
      if (allowCreate && reply.state === 'WAIT_USER_CONFIRM' && !reply.package_info && !row.package_info) {
        await this.apply(row, await this.provider.create(row))
      }
    } catch (error) {
      // Do not expose provider payloads, OpenIDs or cryptographic material to clients/logs.
      await execute(this.db, `UPDATE cash_rewards SET state=IF(state='SUBMITTING','UNKNOWN',state),last_error=?,updated_at=? WHERE redemption_id=?
        AND state NOT IN ('SUCCESS','FAIL','CANCELLED','REVIEW_REQUIRED')`, String(error.providerCode || error.code || 'NETWORK_UNKNOWN').slice(0, 80), Date.now(), row.redemption_id)
    } finally {
      // Short backoff also prevents each UI poll from becoming a provider request.
      await execute(this.db, 'UPDATE cash_rewards SET lease_until=? WHERE redemption_id=?', Date.now() + 5000, row.redemption_id)
    }
  }

  async apply(row, reply) {
    assert(reply.out_bill_no === row.out_bill_no && PROVIDER_STATES.has(reply.state), 409, 'ERR_CASH_RESPONSE', '转账结果不匹配')
    assert(reply.transfer_amount == null || Number(reply.transfer_amount) === row.amount_cents, 409, 'ERR_CASH_RESPONSE', '转账金额不匹配')
    assert(reply.openid == null || reply.openid === row.openid, 409, 'ERR_CASH_RESPONSE', '收款账号不匹配')
    assert(reply.appid == null || reply.appid === row.app_id, 409, 'ERR_CASH_RESPONSE', '小程序账号不匹配')
    assert(reply.mch_id == null || reply.mch_id === row.mch_id, 409, 'ERR_CASH_RESPONSE', '商户账号不匹配')
    await transaction(this.db, async () => {
      const current = await queryOne(this.db, 'SELECT * FROM cash_rewards WHERE redemption_id=? FOR UPDATE', row.redemption_id)
      if (TERMINAL.has(current.state)) return
      const now = Date.now()
      await execute(this.db, 'UPDATE cash_rewards SET state=?,transfer_bill_no=?,package_info=?,last_error=?,updated_at=? WHERE redemption_id=?',
        reply.state, reply.transfer_bill_no || current.transfer_bill_no, reply.package_info || current.package_info,
        reply.state === 'FAIL' ? String(reply.fail_reason || 'FAIL').slice(0, 80) : '', now, row.redemption_id)
      if (reply.state === 'SUCCESS') {
        const record = await queryOne(this.db, 'SELECT * FROM redemptions WHERE id=? FOR UPDATE', row.redemption_id)
        const changed = await execute(this.db, "UPDATE redemptions SET status='verified',verified_at=?,updated_at=? WHERE id=? AND status='pending'", now, now, row.redemption_id)
        assert(changed.changes === 1, 409, 'ERR_CASH_RECORD_STATE', '订单状态不匹配，等待人工核对')
        await execute(this.db, "UPDATE redeem_codes SET status='verified' WHERE redemption_id=?", row.redemption_id)
        await execute(this.db, 'UPDATE prizes SET sent_count=sent_count+1,updated_at=? WHERE id=?', now, record.prize_id)
        await this.service.notice(row.customer_id, 'cash', '现金红包已到账', `您领取的 ${row.amount_cents / 100} 元红包已到账，请查看微信零钱明细。`, record.code)
      }
      if (reply.state !== current.state) await this.service.audit({ actorType: 'system', action: 'cash_status', entityType: 'redemption', entityId: row.redemption_id, result: LABELS[reply.state], detail: { outBillNo: row.out_bill_no, state: reply.state } })
    })
  }

  async reconcile() {
    if (!this.ready() || this.reconciling) return
    this.reconciling = true
    try {
      const rows = await queryAll(this.db, "SELECT * FROM cash_rewards WHERE state NOT IN ('SUCCESS','FAIL','CANCELLED','REVIEW_REQUIRED') ORDER BY updated_at LIMIT 20")
      for (const row of rows) {
        if (Date.now() - row.created_at > 29 * 86400000) {
          await execute(this.db, "UPDATE cash_rewards SET state='REVIEW_REQUIRED',updated_at=? WHERE redemption_id=? AND state NOT IN ('SUCCESS','FAIL','CANCELLED')", Date.now(), row.redemption_id)
        } else await this.refresh(row, false)
      }
    } finally { this.reconciling = false }
  }

  async adminList() {
    const items = await queryAll(this.db, `SELECT cr.redemption_id,cr.out_bill_no,cr.amount_cents,cr.state,cr.last_error,cr.updated_at,
      r.code,c.nickname FROM cash_rewards cr JOIN redemptions r ON r.id=cr.redemption_id
      JOIN customers c ON c.id=cr.customer_id ORDER BY cr.created_at DESC LIMIT 200`)
    return { ready: this.ready(), items: items.map(row => ({ ...row, label: LABELS[row.state] || '待核对' })) }
  }
}
