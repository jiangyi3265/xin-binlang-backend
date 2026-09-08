import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

const adminSource = await readFile(new URL('../../总部管理后台/assets/admin.js', import.meta.url), 'utf8')

test('门店账号弹窗使用单一表单并绑定提交事件', () => {
  assert.doesNotMatch(adminSource, /<form id="account-create"/)
  assert.match(adminSource, /id="account-create"/)
  assert.match(adminSource, /q\('#modal-form'\)/)
  assert.match(adminSource, /data-create-account/)
})

test('后台包含销售账号管理和销售专属门店导航', () => {
  assert.match(adminSource, /sales:'公司销售'/)
  assert.match(adminSource, /role==='sales'/)
  assert.match(adminSource, /return \[\['门店拓展',\['stores'\]\]\]/)
  assert.match(adminSource, /groups\[2\]\[1\]\.splice\(1,0,'sales'\)/)
  assert.match(adminSource, /id="manage-sales">销售账号/)
  assert.match(adminSource, /sales:salesPage/)
  assert.match(adminSource, /当前为销售专属视图/)
})

test('兑奖订单可按门店筛选并导出当前筛选结果', () => {
  assert.match(adminSource, /selectField\('意向或核销门店','storeId'/)
  assert.match(adminSource, /导出筛选结果/)
  assert.match(adminSource, /admin\/redemptions\/export\$\{exportQuery\.size/)
})

test('活动设置包含小程序客服信息配置', () => {
  assert.match(adminSource, /<h3>客服支持<\/h3>/)
  assert.match(adminSource, /'servicePhone'/)
  assert.match(adminSource, /values\.service=\{phone:/)
})

test('奖池名称允许复用并提示用产品档位区分', () => {
  assert.match(adminSource, /名称可以重复，请通过产品档位和奖池说明区分不同规格/)
  assert.match(adminSource, /label:`\$\{p\.name\} · \$\{p\.tier\}`/)
})
