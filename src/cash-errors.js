// Provider messages can contain identities or request values. Persist only these
// known reason identifiers and show our own customer-facing descriptions.
export function cashProviderErrorId(code, message = '') {
  const safeCode = /^[A-Z0-9_]{1,48}$/.test(String(code || '')) ? String(code) : 'WECHAT_REJECTED'
  const text = String(message)
  let reason = ''
  if (/appid.*mchid.*(不匹配|未绑定|未关联)|商户.*appid.*(未绑定|未关联)/i.test(text)) reason = 'APPID_MCHID_MISMATCH'
  else if (/IP.*(不允许|白名单|未配置)|接口安全IP/i.test(text)) reason = 'IP_NOT_ALLOWED'
  else if (/openid.*(错误|不属于|不存在)/i.test(text)) reason = 'OPENID_MISMATCH'
  else if (/转账场景.*(报备|权限|未开通|不支持)/.test(text)) reason = 'SCENE_CONFIGURATION'
  else if (/单笔.*(上限|下限|额度)|超过.*转账.*额度/.test(text)) reason = 'AMOUNT_LIMIT'
  return reason ? safeCode + ':' + reason : safeCode
}

export function cashErrorMessage(id = '') {
  const [code, reason] = String(id).split(':')
  if (reason === 'APPID_MCHID_MISMATCH') return '微信支付商户与小程序尚未关联，请联系商家处理。'
  if (reason === 'IP_NOT_ALLOWED') return '商家转账接口配置尚未完成，请联系商家处理。'
  if (reason === 'OPENID_MISMATCH') return '微信收款账号校验未通过，请联系商家核对。'
  if (reason === 'SCENE_CONFIGURATION') return '商家转账场景配置未通过微信校验，请联系商家处理。'
  if (reason === 'AMOUNT_LIMIT') return '红包金额超出商家转账额度，请联系商家处理。'
  if (code === 'NOT_ENOUGH') return '商家红包余额不足，中奖凭证已保留，请联系商家补充。'
  if (['NO_AUTH', 'SIGN_ERROR', 'PARAM_ERROR', 'INVALID_REQUEST', 'WECHAT_REJECTED'].includes(code)) return '微信未受理本次领取，请联系商家核对转账配置。'
  if (code === 'NOT_FOUND') return '微信暂未查到本次转账，请点击领取重试，原中奖凭证仍有效。'
  if (['FREQUENCY_LIMIT', 'FREQUENCY_LIMIT_EXCEED', 'RATELIMIT_EXCEEDED'].includes(code)) return '领取请求较频繁，请稍后再试。'
  if (code) return '领取结果尚未确认，请稍后刷新，勿重复提交。'
  return ''
}
