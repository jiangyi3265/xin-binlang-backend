import test from 'node:test'
import { randomBytes } from 'node:crypto'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp } from '../src/server.js'
import { queryOne, execute } from '../src/database.js'
import { createRoutes } from '../src/routes.js'
import { buildOpenApi } from '../src/openapi.js'

const testPasswords = Object.fromEntries(
  ['admin', 'operator', 'sales', 'store', 'staff', 'formal', 'salesContract', 'ownerContract']
    .map(role => [role, randomBytes(24).toString('base64url')])
)
const seedEnvironmentKeys = ['ADMIN', 'OPERATOR', 'SALES', 'STORE'].map(role => 'SEED_' + role + '_PASSWORD')
const previousSeedEnvironment = Object.fromEntries(seedEnvironmentKeys.map(key => [key, process.env[key]]))

let app
let base
let tempDir
let requestIp=''

async function request(path,{method='GET',token,body,raw=false}={}) {
  const response=await fetch(base+path,{
    method,
    headers:{...(token?{Authorization:`Bearer ${token}`}:{}),...(body?{'Content-Type':'application/json'}:{}),...(requestIp?{'X-Forwarded-For':requestIp}:{})},
    body:body?JSON.stringify(body):undefined
  })
  if(raw)return response
  const payload=await response.json()
  return {response,payload,data:payload.data,error:payload.error}
}

async function customerToken(openid) {
	const customer=await queryOne(app.db,'SELECT * FROM customers WHERE openid=?',openid)
	assert.ok(customer,`test customer ${openid} must exist`)
	return app.service.customerSession(customer).token
}

test.before(async()=>{
  for (const role of ['ADMIN', 'OPERATOR', 'SALES', 'STORE']) {
    process.env['SEED_' + role + '_PASSWORD'] = testPasswords[role.toLowerCase()]
  }
  tempDir=mkdtempSync(join(tmpdir(),'xin_binlang-api-'))
  // 平台只支持 MySQL，测试也只在 MySQL 上跑。需要本地起一个 MySQL 8.0，
  // 或用 TEST_DB_* 指向任意可写实例；测试库会被自动建出来。
  app=await createApp({
    dbDriver:'mysql',
    dbHost:process.env.TEST_DB_HOST||'127.0.0.1',
    dbPort:Number(process.env.TEST_DB_PORT||3306),
    dbUser:process.env.TEST_DB_USER||'root',
    dbPassword:process.env.TEST_DB_PASSWORD||'',
    dbName:process.env.TEST_DB_NAME||'xin_binlang_test',
    dbAutoCreate:true,
    dbSeed:true,
    uploadDir:join(tempDir,'uploads'),
    host:'127.0.0.1',port:0,tokenSecret:randomBytes(32).toString('hex')
  })
  // This suite verifies store fulfillment. Cash settlement has its own isolated mock-transport suite.
  await execute(app.db, "UPDATE prizes SET status='disabled' WHERE category='cash'")
  await new Promise((resolve,reject)=>{app.server.once('error',reject);app.server.listen(0,'127.0.0.1',resolve)})
  base=`http://127.0.0.1:${app.server.address().port}`
})

test.after(async()=>{
  for (const key of seedEnvironmentKeys) {
    if (previousSeedEnvironment[key] === undefined) delete process.env[key]
    else process.env[key] = previousSeedEnvironment[key]
  }
  await app.close()
  rmSync(tempDir,{recursive:true,force:true})
})

test('production exposes no test customer login route',()=>{
  const routes=createRoutes({config:{},db:{driver:'mysql'}})
  assert.equal(routes.some(item=>item.pattern==='/api/customer/auth/dev'),false)
  assert.equal(Object.hasOwn(buildOpenApi('https://example.com').paths,'/api/customer/auth/dev'),false)
})

test('公开端点、错误格式与跨角色鉴权',async()=>{
  const health=await request('/api/health')
  assert.equal(health.response.status,200)
  assert.equal(health.data.status,'ok')
  const config=await request('/api/public/config')
  assert.equal(config.data.dailyLimit,0)
  assert.equal(config.data.brandMark,'倌')
  assert.equal(config.data.brandLogo,'')
  assert.deepEqual(config.data.flow.map(item=>item.title),['购买活动产品','获取数字兑换码','登录后自主选牌','按奖励领取'])
  assert.match(config.data.flow[1].description,/6 位数字兑换码/)
  const stores=await request('/api/public/stores')
  assert.equal(stores.data.length,6)
  // 未登录浏览：奖池与奖品陈列必须公开可读，且不能带出库存/权重这类运营数据
  const pools=await request('/api/public/pools')
  assert.equal(pools.response.status,200)
  assert.ok(pools.data.length>0)
  const publicPrizes=await request('/api/public/prizes')
  assert.equal(publicPrizes.response.status,200)
  assert.ok(publicPrizes.data.length>0)
  assert.ok(publicPrizes.data.every(item=>item.on===true))
  assert.ok(publicPrizes.data.every(item=>!Object.hasOwn(item,'stock')&&!Object.hasOwn(item,'weight')&&!Object.hasOwn(item,'sent')))
  const protectedResult=await request('/api/admin/dashboard')
  assert.equal(protectedResult.response.status,401)
  assert.equal(protectedResult.error.code,'ERR_AUTH')
  const unauthorizedRedeem=await request('/api/customer/redeem',{method:'POST',body:{code:'ABC123'}})
  assert.equal(unauthorizedRedeem.response.status,401)
  assert.equal(unauthorizedRedeem.error.code,'ERR_AUTH')
  const invalid=await fetch(base+'/api/customer/auth/wechat',{method:'POST',headers:{'Content-Type':'application/json'},body:'{'})
  assert.equal(invalid.status,400)
})

test('every protected route is registered and rejects unauthenticated access',async()=>{
  const routes=createRoutes(app.service).filter(item=>item.auth)
  assert.ok(routes.length>=40)
  for(const route of routes){
    const path=route.pattern.replace(/:([A-Za-z0-9_]+)/g,'TEST')
    const result=await request(path,{method:route.method,body:['POST','PUT','PATCH'].includes(route.method)?{}:undefined})
    assert.equal(result.response.status,401,`${route.method} ${route.pattern}`)
    assert.equal(result.error.code,'ERR_AUTH',`${route.method} ${route.pattern}`)
  }
})

test('消费者兑奖、门店核销、重复拦截与数据隔离形成闭环',async()=>{
  const customerSessionToken=await customerToken('customer-5')

  const redeem=await request('/api/customer/redeem',{method:'POST',token:customerSessionToken,body:{code:'JL8K2M',preferredStoreId:'S01'}})
  assert.equal(redeem.response.status,200)
  assert.equal(redeem.data.record.win,true)
  assert.equal(redeem.data.record.status,'pending')

  const customerRecords=await request('/api/customer/records',{token:customerSessionToken})
  assert.equal(customerRecords.data.some(item=>item.code==='JL8K2M'),true)

  const concurrent=await Promise.all([
    request('/api/customer/redeem',{method:'POST',token:customerSessionToken,body:{code:'F6R3V9',preferredStoreId:'S01'}}),
    request('/api/customer/redeem',{method:'POST',token:customerSessionToken,body:{code:'F6R3V9',preferredStoreId:'S01'}})
  ])
  assert.deepEqual(concurrent.map(item=>item.response.status).sort((a,b)=>a-b),[200,409])
  assert.equal(concurrent.find(item=>item.response.status===409).error.code,'ERR_USED')

  const ownerLogin=await request('/api/store/auth/login',{method:'POST',body:{username:'yht_owner',password:testPasswords.store}})
  assert.equal(ownerLogin.response.status,200)
  const ownerToken=ownerLogin.data.token

  const ownerStats=await request('/api/store/stats',{token:ownerToken})
  assert.equal(ownerStats.response.status,200)
  assert.equal(typeof ownerStats.data.totalVerify,'number')

  const staff=await request('/api/store/staff',{method:'POST',token:ownerToken,body:{username:'test_staff',password:testPasswords.staff,name:'测试店员',phone:'13800000000'}})
  assert.equal(staff.response.status,200)
  assert.equal(staff.data.role,'staff')
  const disabledStaff=await request(`/api/store/staff/${staff.data.id}`,{method:'PATCH',token:ownerToken,body:{active:false}})
  assert.equal(disabledStaff.data.active,false)
  const storeExport=await request('/api/store/orders/export',{token:ownerToken,raw:true})
  assert.equal(storeExport.status,200)
  assert.match(storeExport.headers.get('content-type'),/excel/)

  const preview=await request('/api/store/orders/JL8K2M/verify-preview',{token:ownerToken})
  assert.equal(preview.data.record.status,'pending')

  const verified=await request('/api/store/orders/JL8K2M/verify',{method:'POST',token:ownerToken,body:{position:'测试门店定位点'}})
  assert.equal(verified.response.status,200)
  assert.equal(verified.data.record.status,'verified')
  assert.equal(verified.data.record.verifiedPosition,'测试门店定位点')

  const duplicate=await request('/api/store/orders/JL8K2M/verify',{method:'POST',token:ownerToken,body:{position:'重复请求'}})
  assert.equal(duplicate.response.status,409)
  assert.equal(duplicate.error.code,'ERR_DUP')

  const otherStoreLogin=await request('/api/store/auth/login',{method:'POST',body:{username:'wy_owner',password:testPasswords.store}})
  const otherOrders=await request('/api/store/orders?keyword=JL8K2M',{token:otherStoreLogin.data.token})
  assert.equal(otherOrders.data.total,0)

  const logs=await request('/api/store/logs?type=block',{token:ownerToken})
  assert.equal(logs.data.items.some(item=>item.entityId===redeem.data.record.id),true)
})

test('admin-generated code is redeemed by customer and verified by store',async()=>{
  const adminLogin=await request('/api/admin/auth/login',{method:'POST',body:{username:'admin',password:testPasswords.admin}})
  const adminToken=adminLogin.data.token
  const batchUpdate=await request('/api/admin/batches/JL2601',{method:'PUT',token:adminToken,body:{winRatePpm:1000000}})
  assert.equal(batchUpdate.response.status,200)
  const generated=await request('/api/admin/batches/JL2601/codes/generate',{method:'POST',token:adminToken,body:{count:1}})
  const code=generated.data.codes[0]
  assert.match(code,/^\d{6}$/)
  const physical = await queryOne(app.db, "SELECT id FROM prizes WHERE pool_id='P-A' AND category='goods' AND stock>0 LIMIT 1")
  await execute(app.db, "UPDATE redeem_codes SET forced_outcome='win',forced_prize_id=? WHERE code=?", physical.id, code)

  const token=await customerToken('demo-customer')
  const redeemed=await request('/api/customer/redeem',{method:'POST',token,body:{code,preferredStoreId:'S01'}})
  assert.equal(redeemed.response.status,200)
  assert.equal(redeemed.data.record.win,true)
  assert.equal(redeemed.data.record.status,'pending')

  const storeLogin=await request('/api/store/auth/login',{method:'POST',body:{username:'hq_super',password:testPasswords.store}})
  const storeToken=storeLogin.data.token
  const preview=await request(`/api/store/orders/${code}/verify-preview`,{token:storeToken})
  assert.equal(preview.response.status,200)
  const verified=await request(`/api/store/orders/${code}/verify`,{method:'POST',token:storeToken,body:{position:'正式核销闭环测试位置'}})
  assert.equal(verified.response.status,200)
  assert.equal(verified.data.record.status,'verified')
  const refreshedCustomerRecord=await request(`/api/customer/records/${redeemed.data.record.id}`,{token})
  assert.equal(refreshedCustomerRecord.response.status,200)
  assert.equal(refreshedCustomerRecord.data.status,'verified')
  assert.equal(refreshedCustomerRecord.data.verifiedPosition,'正式核销闭环测试位置')
  const adminOrders=await request(`/api/admin/redemptions?keyword=${code}`,{token:adminToken})
  assert.equal(adminOrders.data.items[0].status,'verified')
})

test('all three portals can load their complete production API surface',async()=>{
  const customerSessionToken=await customerToken('demo-customer')
  for(const path of ['/api/customer/bootstrap','/api/customer/records','/api/customer/coupons','/api/customer/notices']){
    const result=await request(path,{token:customerSessionToken})
    assert.equal(result.response.status,200,path)
  }
  const customerRecords=await request('/api/customer/records',{token:customerSessionToken})
  assert.ok(customerRecords.data.length)
  const customerRecord=await request(`/api/customer/records/${customerRecords.data[0].id}`,{token:customerSessionToken})
  assert.equal(customerRecord.response.status,200)
  const pendingRecord=customerRecords.data.find(item=>item.status==='pending'&&item.prizeType!=='cash')
  if(pendingRecord){
    const preferred=await request(`/api/customer/records/${pendingRecord.id}/preferred-store`,{method:'PATCH',token:customerSessionToken,body:{storeId:'S02'}})
    assert.equal(preferred.response.status,200)
  }
  const notices=await request('/api/customer/notices',{token:customerSessionToken})
  if(notices.data[0]){
    const read=await request(`/api/customer/notices/${notices.data[0].id}/read`,{method:'PATCH',token:customerSessionToken,body:{}})
    assert.equal(read.response.status,200)
  }
  const readAll=await request('/api/customer/notices/read-all',{method:'PATCH',token:customerSessionToken,body:{}})
  assert.equal(readAll.response.status,200)

  const ownerLogin=await request('/api/store/auth/login',{method:'POST',body:{username:'yht_owner',password:testPasswords.store}})
  const ownerToken=ownerLogin.data.token
  for(const path of ['/api/store/bootstrap','/api/store/orders','/api/store/stats','/api/store/trend','/api/store/rank','/api/store/logs','/api/store/prizes','/api/store/staff']){
    const result=await request(path,{token:ownerToken})
    assert.equal(result.response.status,200,path)
  }

  const adminLogin=await request('/api/admin/auth/login',{method:'POST',body:{username:'admin',password:testPasswords.admin}})
  const adminToken=adminLogin.data.token
  for(const path of ['/api/admin/me','/api/admin/dashboard','/api/admin/settings','/api/admin/pools','/api/admin/prizes','/api/admin/batches','/api/admin/stores','/api/admin/redemptions','/api/admin/customers','/api/admin/audit','/api/admin/notifications']){
    const result=await request(path,{token:adminToken})
    assert.equal(result.response.status,200,path)
  }
  const storeFiltered=await request('/api/admin/redemptions?storeId=S02',{token:adminToken})
  assert.ok(storeFiltered.data.total>0)
  assert.ok(storeFiltered.data.items.every(item=>item.preferStoreId==='S02'||item.storeId==='S02'))
  const adminExport=await request('/api/admin/redemptions/export?storeId=S02',{token:adminToken,raw:true})
  assert.equal(adminExport.status,200)
  assert.match(adminExport.headers.get('content-type'),/excel/)
  const adminExportXml=Buffer.from(await adminExport.arrayBuffer()).toString('utf8')
  assert.match(adminExportXml,/意向门店编号/)
  assert.match(adminExportXml,/核销门店地址/)
  assert.match(adminExportXml,/核销账号/)
  assert.match(adminExportXml,/五一广场店/)
  assert.doesNotMatch(adminExportXml,/雨花亭旗舰店/)

  const settings=await request('/api/admin/settings',{token:adminToken})
  const editableFlow=settings.data.flow.map((step,index)=>({...step,title:index===0?'购买正式活动产品':step.title}))
  const editableNotice={...settings.data.notice,enabled:false,badge:'系统通知',buttonText:'关闭公告',image:'/assets/hero-fruit.jpg',title:'合同测试公告',lines:['第一条说明','第二条说明']}
  const savedSettings=await request('/api/admin/settings',{method:'PUT',token:adminToken,body:{dailyLimit:0,brandMark:'奖',brandLogo:'/assets/product-30.png',adminSubtitle:'品牌管理后台',flow:editableFlow,notice:editableNotice,service:{phone:'400-123-4567',wechat:'service-test',time:'08:30 - 20:30',note:'测试客服说明'}}})
  assert.equal(savedSettings.response.status,200)
  assert.equal(savedSettings.data.dailyLimit,0)
  assert.equal(savedSettings.data.flow[0].title,'购买正式活动产品')
  assert.equal(savedSettings.data.notice.title,'合同测试公告')
  assert.equal(savedSettings.data.notice.badge,'系统通知')
  assert.equal(savedSettings.data.notice.buttonText,'关闭公告')
  assert.equal(savedSettings.data.notice.image,'/assets/hero-fruit.jpg')
  assert.equal(savedSettings.data.brandMark,'奖')
  assert.equal(savedSettings.data.brandLogo,'/assets/product-30.png')
  assert.equal(savedSettings.data.adminSubtitle,'品牌管理后台')
  assert.equal(savedSettings.data.service.phone,'400-123-4567')
  assert.equal(savedSettings.data.service.wechat,'service-test')
  assert.equal(savedSettings.data.service.time,'08:30 - 20:30')
  assert.equal(savedSettings.data.service.note,'测试客服说明')
  const invalidBrandMark=await request('/api/admin/settings',{method:'PUT',token:adminToken,body:{brandMark:'三个字'}})
  assert.equal(invalidBrandMark.response.status,400)
  assert.equal(invalidBrandMark.error.code,'ERR_BRAND_MARK')

  const createdPool=await request('/api/admin/pools',{method:'POST',token:adminToken,body:{name:'API contract pool',desc:'automated contract validation',tier:'formal',status:'active'}})
  assert.equal(createdPool.response.status,200)
  const updatedPool=await request(`/api/admin/pools/${createdPool.data.id}`,{method:'PUT',token:adminToken,body:{name:'API contract pool updated'}})
  assert.equal(updatedPool.response.status,200)
  const sameNamePool=await request('/api/admin/pools',{method:'POST',token:adminToken,body:{name:'API contract pool updated',desc:'another product specification',tier:'another tier',status:'active'}})
  assert.equal(sameNamePool.response.status,200)

  const createdPrize=await request('/api/admin/prizes',{method:'POST',token:adminToken,body:{poolId:createdPool.data.id,name:'API contract prize',spec:'1 item',level:'contract',type:'goods',valueCents:100,stock:10,sent:0,lowStockThreshold:1,weight:1,img:'',status:'active'}})
  assert.equal(createdPrize.response.status,200)
  const sameNamePrize=await request('/api/admin/prizes',{method:'POST',token:adminToken,body:{poolId:sameNamePool.data.id,name:'API contract prize',spec:'same prize name in another pool',level:'contract',type:'goods',valueCents:100,stock:10,sent:0,lowStockThreshold:1,weight:1,img:'',status:'active'}})
  assert.equal(sameNamePrize.response.status,200)
  const updatedPrize=await request(`/api/admin/prizes/${createdPrize.data.id}`,{method:'PUT',token:adminToken,body:{stock:11}})
  assert.equal(updatedPrize.response.status,200)

  const now=Date.now()
  const createdBatch=await request('/api/admin/batches',{method:'POST',token:adminToken,body:{id:'API-CONTRACT',name:'API contract batch',productTier:'formal',priceCents:100,poolId:createdPool.data.id,winRatePpm:100000,status:'active',startsAt:now-1000,expiresAt:now+86400000}})
  assert.equal(createdBatch.response.status,200)
  const sameNameBatch=await request('/api/admin/batches',{method:'POST',token:adminToken,body:{id:'API-CONTRACT-SAME',name:'same pool name batch',productTier:'another tier',priceCents:200,poolId:sameNamePool.data.id,winRatePpm:100000,status:'active',startsAt:now-1000,expiresAt:now+86400000}})
  assert.equal(sameNameBatch.response.status,200)
  assert.equal(sameNameBatch.data.poolId,sameNamePool.data.id)
  const sameNameCodes=await request('/api/admin/batches/API-CONTRACT-SAME/codes/generate',{method:'POST',token:adminToken,body:{count:1}})
  assert.equal(sameNameCodes.response.status,200)
  assert.equal(sameNameCodes.data.count,1)
  const updatedBatch=await request('/api/admin/batches/API-CONTRACT',{method:'PUT',token:adminToken,body:{winRatePpm:110000}})
  assert.equal(updatedBatch.response.status,200)
  const generated=await request('/api/admin/batches/API-CONTRACT/codes/generate',{method:'POST',token:adminToken,body:{count:2}})
  assert.equal(generated.response.status,200)
  const codes=await request('/api/admin/batches/API-CONTRACT/codes',{token:adminToken})
  assert.equal(codes.data.total,2)

  const protectedPoolDelete=await request('/api/admin/pools/P-A',{method:'DELETE',token:adminToken})
  assert.equal(protectedPoolDelete.response.status,409)
  assert.equal(protectedPoolDelete.error.code,'ERR_POOL_HAS_HISTORY')

  const deletedPool=await request(`/api/admin/pools/${createdPool.data.id}`,{method:'DELETE',token:adminToken})
  assert.equal(deletedPool.response.status,200)
  assert.deepEqual(deletedPool.data.deleted,{prizes:1,batches:1,codes:2})
  const deletedSameNamePool=await request(`/api/admin/pools/${sameNamePool.data.id}`,{method:'DELETE',token:adminToken})
  assert.equal(deletedSameNamePool.response.status,200)
  assert.deepEqual(deletedSameNamePool.data.deleted,{prizes:1,batches:1,codes:1})
  const poolsAfterDelete=await request('/api/admin/pools',{token:adminToken})
  assert.equal(poolsAfterDelete.data.some(item=>item.id===createdPool.data.id),false)

  const createdStore=await request('/api/admin/stores',{method:'POST',token:adminToken,body:{name:'API contract store',short:'contract store',addr:'contract address',latitude:28.2,longitude:112.9,phone:'07310000000',hours:'09:00-18:00',img:'',status:'active'}})
  assert.equal(createdStore.response.status,200)
  const updatedStore=await request(`/api/admin/stores/${createdStore.data.id}`,{method:'PUT',token:adminToken,body:{hours:'09:00-19:00'}})
  assert.equal(updatedStore.response.status,200)
  const shortPasswordAccount=await request(`/api/admin/stores/${createdStore.data.id}/accounts`,{method:'POST',token:adminToken,body:{username:'api_short_password',password:'x'.repeat(7),name:'Short password'}})
  assert.equal(shortPasswordAccount.response.status,400)
  assert.equal(shortPasswordAccount.error.code,'ERR_PASSWORD')
  const createdAccount=await request(`/api/admin/stores/${createdStore.data.id}/accounts`,{method:'POST',token:adminToken,body:{username:'api_contract_owner',password:testPasswords.formal,name:'API contract owner',phone:'13800000001',avatar:'',role:'owner'}})
  assert.equal(createdAccount.response.status,200)
  const accounts=await request(`/api/admin/stores/${createdStore.data.id}/accounts`,{token:adminToken})
  assert.equal(accounts.data.some(item=>item.username==='api_contract_owner'),true)

  const protectedStoreDelete=await request('/api/admin/stores/S01',{method:'DELETE',token:adminToken})
  assert.equal(protectedStoreDelete.response.status,409)
  assert.equal(protectedStoreDelete.error.code,'ERR_STORE_HAS_HISTORY')

  const deletedStore=await request(`/api/admin/stores/${createdStore.data.id}`,{method:'DELETE',token:adminToken})
  assert.equal(deletedStore.response.status,200)
  assert.equal(deletedStore.data.deleted.accounts,1)
  const storesAfterDelete=await request('/api/admin/stores',{token:adminToken})
  assert.equal(storesAfterDelete.data.some(item=>item.id===createdStore.data.id),false)

  const upload=await request('/api/admin/uploads',{method:'POST',token:adminToken,body:{name:'contract.png',mime:'image/png',data:'data:image/png;base64,iVBORw0KGgo='}})
  assert.equal(upload.response.status,200)
  assert.match(upload.data.url,/^\/uploads\//)

  const customers=await request('/api/admin/customers',{token:adminToken})
  const customer=customers.data.items.find(item=>item.openid==='customer-2')
  assert.ok(customer)
  const blocked=await request(`/api/admin/customers/${customer.id}/blacklist`,{method:'POST',token:adminToken,body:{blocked:true,reason:'contract test'}})
  assert.equal(blocked.response.status,200)
  const restored=await request(`/api/admin/customers/${customer.id}/blacklist`,{method:'POST',token:adminToken,body:{blocked:false,reason:''}})
  assert.equal(restored.response.status,200)
})

test('销售账号只能管理本人创建的门店和门店账号',async context=>{
  const previousRequestIp=requestIp
  requestIp='10.20.30.40'
  context.after(()=>{requestIp=previousRequestIp})
  const adminLogin=await request('/api/admin/auth/login',{method:'POST',body:{username:'admin',password:testPasswords.admin}})
  const adminToken=adminLogin.data.token
  const createdSales=await request('/api/admin/sales',{method:'POST',token:adminToken,body:{username:'sales_contract',password:testPasswords.salesContract,name:'合同测试销售',active:true}})
  assert.equal(createdSales.response.status,200)
  assert.equal(createdSales.data.role,'sales')
  assert.equal(createdSales.data.storeCount,0)

  const salesList=await request('/api/admin/sales',{token:adminToken})
  assert.equal(salesList.data.some(item=>item.id===createdSales.data.id),true)
  const salesLogin=await request('/api/admin/auth/login',{method:'POST',body:{username:'sales_contract',password:testPasswords.salesContract}})
  assert.equal(salesLogin.response.status,200)
  assert.equal(salesLogin.data.user.role,'sales')
  const salesToken=salesLogin.data.token

  const deniedDashboard=await request('/api/admin/dashboard',{token:salesToken})
  assert.equal(deniedDashboard.response.status,403)
  assert.equal(deniedDashboard.error.code,'ERR_PERMISSION')
  const deniedSettings=await request('/api/admin/settings',{token:salesToken})
  assert.equal(deniedSettings.response.status,403)

  const emptyOwnStores=await request('/api/admin/stores',{token:salesToken})
  assert.deepEqual(emptyOwnStores.data,[])
  const createdStore=await request('/api/admin/stores',{method:'POST',token:salesToken,body:{name:'销售合同测试门店',short:'销售测试门店',addr:'销售测试地址',latitude:28.21,longitude:112.91,phone:'07310000009',hours:'09:00-18:00',img:'',status:'active'}})
  assert.equal(createdStore.response.status,200)
  assert.equal(createdStore.data.createdByAdminId,createdSales.data.id)

  const ownStores=await request('/api/admin/stores',{token:salesToken})
  assert.deepEqual(ownStores.data.map(item=>item.id),[createdStore.data.id])
  assert.equal(ownStores.data[0].createdByName,'合同测试销售')
  const createdOwner=await request(`/api/admin/stores/${createdStore.data.id}/accounts`,{method:'POST',token:salesToken,body:{username:'sales_contract_owner',password:testPasswords.ownerContract,name:'销售创建店主',phone:'13800000009',role:'owner'}})
  assert.equal(createdOwner.response.status,200)
  const ownAccounts=await request(`/api/admin/stores/${createdStore.data.id}/accounts`,{token:salesToken})
  assert.equal(ownAccounts.data.some(item=>item.username==='sales_contract_owner'),true)

  const deniedOtherAccounts=await request('/api/admin/stores/S01/accounts',{token:salesToken})
  assert.equal(deniedOtherAccounts.response.status,403)
  assert.equal(deniedOtherAccounts.error.code,'ERR_DATA_SCOPE')
  const deniedOtherEdit=await request('/api/admin/stores/S01',{method:'PUT',token:salesToken,body:{hours:'00:00-24:00'}})
  assert.equal(deniedOtherEdit.response.status,403)

  const adminStores=await request('/api/admin/stores',{token:adminToken})
  const visibleToAdmin=adminStores.data.find(item=>item.id===createdStore.data.id)
  assert.equal(visibleToAdmin.createdByAdminId,createdSales.data.id)
  assert.equal(visibleToAdmin.createdByUsername,'sales_contract')

  const operatorLogin=await request('/api/admin/auth/login',{method:'POST',body:{username:'operator',password:testPasswords.operator}})
  const deniedSalesManagement=await request('/api/admin/sales',{token:operatorLogin.data.token})
  assert.equal(deniedSalesManagement.response.status,403)

  const deletedStore=await request(`/api/admin/stores/${createdStore.data.id}`,{method:'DELETE',token:salesToken})
  assert.equal(deletedStore.response.status,200)
  assert.equal(deletedStore.data.deleted.accounts,1)
  const disabledSales=await request(`/api/admin/sales/${createdSales.data.id}`,{method:'PATCH',token:adminToken,body:{active:false}})
  assert.equal(disabledSales.data.active,false)
  const disabledLogin=await request('/api/admin/auth/login',{method:'POST',body:{username:'sales_contract',password:testPasswords.salesContract}})
  assert.equal(disabledLogin.response.status,401)
})

test('总部管理、只读权限、冻结解冻、生成和导出',async()=>{
  const login=await request('/api/admin/auth/login',{method:'POST',body:{username:'admin',password:testPasswords.admin}})
  assert.equal(login.response.status,200)
  const token=login.data.token
  const dashboard=await request('/api/admin/dashboard',{token})
  assert.equal(dashboard.response.status,200)
  assert.ok(dashboard.data.totals.redeemed>=9)

  const list=await request('/api/admin/redemptions?status=pending&pageSize=20',{token})
  const target=list.data.items[0]
  assert.ok(target)
  const frozen=await request(`/api/admin/redemptions/${target.id}/freeze`,{method:'POST',token,body:{reason:'自动化复核测试'}})
  assert.equal(frozen.data.status,'frozen')
  const unfrozen=await request(`/api/admin/redemptions/${target.id}/unfreeze`,{method:'POST',token,body:{}})
  assert.equal(unfrozen.data.status,'pending')

  const generated=await request('/api/admin/batches/JL2603/codes/generate',{method:'POST',token,body:{count:8}})
  assert.equal(generated.data.count,8)
  assert.equal(new Set(generated.data.codes).size,8)
  assert.equal(generated.data.codes.every(code=>/^\d{6}$/.test(code)),true)

  const exportResponse=await request('/api/admin/batches/JL2603/codes/export',{token,raw:true})
  assert.equal(exportResponse.status,200)
  assert.match(exportResponse.headers.get('content-type'),/excel/)
  assert.ok((await exportResponse.arrayBuffer()).byteLength>1000)

  const messages=await request('/api/admin/notifications/process',{method:'POST',token,body:{}})
  assert.equal(messages.response.status,200)
  assert.ok(messages.data.skipped>=1)

  const auditLogin=await request('/api/admin/auth/login',{method:'POST',body:{username:'auditor',password:testPasswords.operator}})
  const denied=await request('/api/admin/settings',{method:'PUT',token:auditLogin.data.token,body:{dailyLimit:4}})
  assert.equal(denied.response.status,403)
  assert.equal(denied.error.code,'ERR_PERMISSION')
})

test('失效批次、黑名单与库存耗尽由服务端拒绝，兑奖次数不设每日上限',async()=>{
  const token=await customerToken('customer-4')
  const expired=await request('/api/customer/redeem',{method:'POST',token,body:{code:'C9M4Z8'}})
  assert.equal(expired.response.status,409)
  assert.equal(expired.error.code,'ERR_BATCH_EXPIRED')

  const stockOut=await request('/api/customer/redeem',{method:'POST',token,body:{code:'H4W6L5'}})
  assert.equal(stockOut.response.status,200)
  assert.equal(stockOut.data.record.win,false)
  assert.equal(stockOut.data.stockOut,true)

  const blockedToken=await customerToken('blocked-demo')
  const blockedResult=await request('/api/customer/redeem',{method:'POST',token:blockedToken,body:{code:'F6R3V9'}})
  assert.equal(blockedResult.response.status,403)
  assert.equal(blockedResult.error.code,'ERR_BLOCKED')

  const limitCustomerToken=await customerToken('customer-3')
  for(const code of ['A7X9Q2','E1P8W3']){
    const result=await request('/api/customer/redeem',{method:'POST',token:limitCustomerToken,body:{code}})
    assert.equal(result.response.status,200)
  }
  const remaining=(await request('/api/customer/bootstrap',{token:limitCustomerToken})).data.counts.todayLeft
  assert.equal(remaining,null)
  const unused=(await queryOne(app.db,"SELECT code FROM redeem_codes WHERE status='unused' AND batch_id='JL2603' LIMIT 1")).code
  const additional=await request('/api/customer/redeem',{method:'POST',token:limitCustomerToken,body:{code:unused}})
  assert.equal(additional.response.status,200)
})
