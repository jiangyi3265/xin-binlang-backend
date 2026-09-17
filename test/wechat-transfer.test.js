import test from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync, sign, verify } from 'node:crypto'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { WechatTransfer } from '../src/wechat-transfer.js'
import { cashProviderErrorId, cashErrorMessage } from '../src/cash-errors.js'

test('transfer signs the exact method/path/body and verifies provider responses before trusting status', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'guanlang-transfer-test-'))
  const merchant = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const provider = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const privateKeyPath = join(directory, 'merchant.pem'), publicKeyPath = join(directory, 'provider.pem')
  writeFileSync(privateKeyPath, merchant.privateKey.export({ type: 'pkcs8', format: 'pem' }))
  writeFileSync(publicKeyPath, provider.publicKey.export({ type: 'spki', format: 'pem' }))
  const config = { enabled: true, mchId: '1234567890', appId: 'wxLocalTestOnly', serialNo: 'TEST', publicKeyId: 'PUB_KEY_ID_TEST',
    privateKeyPath, publicKeyPath, sceneId: '1000', activityName: '本地测试', rewardDescription: '本地奖励测试', maxCents: 20000 }
  let tamper = false, wrongSerial = false, stale = false, denial = false
  const transport = async (url, options) => {
    assert.ok(url.startsWith('https://api.mch.weixin.qq.com/v3/'))
    assert.equal(options.redirect, 'error')
    const parts = Object.fromEntries([...options.headers.Authorization.matchAll(/(\w+)="([^"]+)"/g)].map(item => [item[1], item[2]]))
    const body = options.body || ''
    assert.ok(verify('RSA-SHA256', Buffer.from(`${options.method}\n${new URL(url).pathname}\n${parts.timestamp}\n${parts.nonce_str}\n${body}\n`), merchant.publicKey, Buffer.from(parts.signature, 'base64')))
    if (denial) return new Response(JSON.stringify({ code: 'INVALID_REQUEST', message: 'appid和mchid不匹配，private-user-id' }), { status: 400 })
    const timestamp = String(Math.floor(Date.now()/1000) - (stale ? 1000 : 0))
    const payload = JSON.stringify({ out_bill_no: 'GLTEST', state: 'WAIT_USER_CONFIRM', package_info: 'fixture' })
    const signature = sign('RSA-SHA256', Buffer.from(`${timestamp}\nfixture-nonce\n${payload}\n`), provider.privateKey).toString('base64')
    return new Response(tamper ? payload.replace('WAIT_USER_CONFIRM', 'SUCCESS') : payload, { status: 200, headers: {
      'Wechatpay-Timestamp': timestamp, 'Wechatpay-Nonce': 'fixture-nonce', 'Wechatpay-Serial': wrongSerial ? 'OTHER' : config.publicKeyId, 'Wechatpay-Signature': signature
    } })
  }
  try {
    const gateway = new WechatTransfer(config, transport)
    const bill = { out_bill_no: 'GLTEST', openid: 'local-openid', amount_cents: 200 }
    assert.equal((await gateway.create(bill)).state, 'WAIT_USER_CONFIRM')
    tamper = true
    await assert.rejects(gateway.query(bill), error => error.code === 'ERR_CASH_SIGNATURE')
    tamper = false; wrongSerial = true
    await assert.rejects(gateway.query(bill), error => error.code === 'ERR_CASH_SIGNATURE')
    wrongSerial = false; stale = true
    await assert.rejects(gateway.query(bill), error => error.code === 'ERR_CASH_SIGNATURE')
    denial = true
    await assert.rejects(gateway.create(bill), error => {
      assert.equal(error.providerCode, 'INVALID_REQUEST')
      assert.equal(error.providerErrorId, 'INVALID_REQUEST:APPID_MCHID_MISMATCH')
      assert.equal(JSON.stringify(error).includes('private-user-id'), false)
      return true
    })
    await assert.rejects(new WechatTransfer({ enabled: false }, () => { throw new Error('must not send') }).create(bill), error => error.code === 'ERR_CASH_NOT_CONFIGURED')
  } finally {
    // Only remove the temporary directory created by this test, within the system temp directory.
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + '\\') || resolve(directory).startsWith(resolve(tmpdir()) + '/'))
    rmSync(directory, { recursive: true, force: true })
  }
})

test('provider diagnostics retain known causes without copying private values into customer messages', () => {
  const id = cashProviderErrorId('INVALID_REQUEST', '此IP地址不允许调用接口，private-server-value')
  assert.equal(id, 'INVALID_REQUEST:IP_NOT_ALLOWED')
  assert.match(cashErrorMessage(id), /接口配置/)
  assert.equal(cashProviderErrorId('not a code private-value', 'private-value'), 'WECHAT_REJECTED')
  assert.equal(cashErrorMessage(id).includes('private-server-value'), false)
})
