import { readFileSync } from 'node:fs'
import { createPrivateKey, createPublicKey, randomBytes, sign, verify } from 'node:crypto'
import { apiError } from './http-utils.js'

const ENDPOINT = 'https://api.mch.weixin.qq.com'
const BILL_PATH = '/v3/fund-app/mch-transfer/transfer-bills'

export function transferReady(config) {
  return Boolean(config?.enabled && config.mchId && config.appId && config.serialNo &&
    config.privateKeyPath && config.publicKeyId && config.publicKeyPath && config.sceneId &&
    config.activityName && config.rewardDescription)
}

export class WechatTransfer {
  constructor(config = {}, transport = fetch) {
    this.config = config
    this.transport = transport
    if (config.enabled) {
      if (!transferReady(config)) throw new Error('微信现金奖励配置不完整，请补全商户配置或关闭 WECHAT_TRANSFER_ENABLED')
      if (!/^\d+$/.test(config.mchId) || !/^wx[a-zA-Z0-9]+$/.test(config.appId) ||
        !/^[a-zA-Z0-9_]+$/.test(config.serialNo) || !/^[a-zA-Z0-9_]+$/.test(config.publicKeyId) ||
        config.sceneId !== '1000' || !Number.isSafeInteger(config.maxCents) || config.maxCents < 1 || config.maxCents > 20000 ||
        [...config.activityName].length > 32 || [...config.rewardDescription].length > 32) {
        throw new Error('现金营销商户参数或单笔金额范围不正确，请核对服务器配置')
      }
      this.privateKey = createPrivateKey(readFileSync(config.privateKeyPath))
      this.publicKey = createPublicKey(readFileSync(config.publicKeyPath))
    }
  }

  async request(method, path, payload) {
    if (!transferReady(this.config)) throw apiError(409, 'ERR_CASH_NOT_CONFIGURED', '现金领取暂未开放，请稍后重试或联系客服')
    const body = payload ? JSON.stringify(payload) : ''
    const nonce = randomBytes(16).toString('hex')
    const timestamp = String(Math.floor(Date.now() / 1000))
    const signature = sign('RSA-SHA256', Buffer.from(`${method}\n${path}\n${timestamp}\n${nonce}\n${body}\n`), this.privateKey).toString('base64')
    const c = this.config
    const authorization = `WECHATPAY2-SHA256-RSA2048 mchid="${c.mchId}",nonce_str="${nonce}",timestamp="${timestamp}",serial_no="${c.serialNo}",signature="${signature}"`
    const response = await this.transport(ENDPOINT + path, {
      method, redirect: 'error', signal: AbortSignal.timeout(15000),
      headers: { Authorization: authorization, Accept: 'application/json', 'Content-Type': 'application/json', 'Wechatpay-Serial': c.publicKeyId },
      ...(body ? { body } : {})
    })
    const raw = await response.text()
    if (!response.ok) {
      // A transport/API error is not a payment result. The caller reconciles the same bill.
      const error = apiError(409, 'ERR_CASH_PENDING', '领取结果正在确认，请稍后刷新，勿重复提交')
      try { error.providerCode = JSON.parse(raw).code } catch {}
      throw error
    }
    const ts = response.headers.get('Wechatpay-Timestamp')
    const resNonce = response.headers.get('Wechatpay-Nonce')
    const serial = response.headers.get('Wechatpay-Serial')
    const resSignature = response.headers.get('Wechatpay-Signature')
    if (!ts || !/^\d+$/.test(ts) || !resNonce || !resSignature || serial !== c.publicKeyId ||
      Math.abs(Date.now() / 1000 - Number(ts)) > 300 ||
      !verify('RSA-SHA256', Buffer.from(`${ts}\n${resNonce}\n${raw}\n`), this.publicKey, Buffer.from(resSignature, 'base64'))) {
      throw apiError(409, 'ERR_CASH_SIGNATURE', '领取结果验证未完成，请稍后刷新')
    }
    return JSON.parse(raw)
  }

  create(bill) {
    const request = typeof bill.request_json === 'string' ? JSON.parse(bill.request_json) : bill.request_json
    const c = request || this.config
    return this.request('POST', BILL_PATH, {
      appid: bill.app_id || this.config.appId, out_bill_no: bill.out_bill_no, openid: bill.openid,
      transfer_scene_id: c.sceneId, transfer_amount: bill.amount_cents,
      transfer_remark: c.rewardDescription,
      transfer_scene_report_infos: [
        { info_type: '活动名称', info_content: c.activityName },
        { info_type: '奖励说明', info_content: c.rewardDescription }
      ]
    })
  }

  query(bill) {
    return this.request('GET', BILL_PATH + '/out-bill-no/' + encodeURIComponent(bill.out_bill_no))
  }
}
