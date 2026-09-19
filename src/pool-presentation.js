import { assert } from './http-utils.js'

export function validatePresentation(value = {}) {
  assert(value && typeof value === 'object' && !Array.isArray(value), 400, 'ERR_PRESENTATION', '奖池展示设置格式不正确')
  const theme = value.theme || 'auto'
  assert(['auto', 'gold', 'blue', 'neutral'].includes(theme), 400, 'ERR_PRESENTATION', '请选择有效的包装配色')
  const image = key => {
    const path = String(value[key] || '').trim()
    assert(path.length <= 500 && (!path || /^\/(assets|uploads)\/[\w./%-]+$/.test(path)), 400, 'ERR_PRESENTATION', '请上传有效的图片')
    return path
  }
  assert(value.visible == null || typeof value.visible === 'boolean', 400, 'ERR_PRESENTATION', '展示开关格式不正确')
  return { theme, productImg: image('productImg'), backgroundImg: image('backgroundImg'), visible: value.visible !== false }
}

export function resolvePresentation(presentation = {}, priceCents = 0) {
  presentation ||= {}
  const theme = presentation.theme && presentation.theme !== 'auto' ? presentation.theme : Number(priceCents) === 3000 ? 'gold' : Number(priceCents) === 5000 ? 'blue' : 'neutral'
  return { ...presentation, theme,
    productImg: presentation.productImg || (theme === 'gold' ? '/assets/guanlang-product-30.png' : theme === 'blue' ? '/assets/guanlang-product-50.jpg' : ''),
    backgroundImg: presentation.backgroundImg || '/assets/guanlang-botanical-blue.png',
    tintBackground: !presentation.backgroundImg && theme === 'gold' }
}
