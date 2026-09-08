import { queryAll } from './database.js'
import { excelResponse, formatDateTime, spreadsheetXml } from './http-utils.js'

function route(method, pattern, options, handler) {
  const names = []
  const source = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/:([A-Za-z0-9_]+)/g, (_, name) => {
    names.push(name)
    return '([^/]+)'
  })
  return { method, pattern, regex:new RegExp(`^${source}/?$`), names, ...options, handler }
}

function redemptionColumns() {
  return [
    {label:'订单号',value:'orderNo'}, {label:'兑换码',value:'code'}, {label:'批次',value:'batchId'},
    {label:'用户昵称',value:'userNick'}, {label:'手机号',value:'userPhone'}, {label:'是否中奖',value:r=>r.win?'是':'否'},
    {label:'奖品',value:'prizeName'}, {label:'奖品价值（元）',value:'prizeValue'}, {label:'状态',value:'status'},
    {label:'意向门店编号',value:'preferStoreId'}, {label:'意向门店',value:'preferStoreName'}, {label:'意向门店地址',value:'preferStoreAddress'},
    {label:'核销门店编号',value:'storeId'}, {label:'核销门店',value:'storeName'}, {label:'核销门店地址',value:'storeAddress'},
    {label:'核销人员',value:'verifiedBy'}, {label:'核销账号',value:'verifiedByUsername'}, {label:'核销位置',value:'verifiedPosition'},
    {label:'兑换时间',value:r=>formatDateTime(r.redeemAt)}, {label:'核销时间',value:r=>formatDateTime(r.verifiedAt)},
    {label:'有效截止',value:r=>formatDateTime(r.expireAt)}, {label:'冻结原因',value:'frozenReason'}
  ]
}

function codeColumns() {
  return [
    {label:'兑换码',value:'code'}, {label:'批次编号',value:'batch_id'}, {label:'状态',value:'status'},
    {label:'生成时间',value:r=>formatDateTime(r.created_at)}, {label:'兑换时间',value:r=>formatDateTime(r.redeemed_at)},
    {label:'兑奖订单ID',value:'redemption_id'}
  ]
}

export function createRoutes(service) {
  const routes = []
  const add = (method, pattern, options, handler) => routes.push(route(method, pattern, options, handler))

  add('GET','/api/health',{auth:null},()=>({status:'ok',service:'xin-binlang-backend',database:service.db.driver,time:Date.now()}))
  add('GET','/api/public/config',{auth:null},()=>service.publicConfig())
  add('GET','/api/public/stores',{auth:null},()=>service.publicStores())
  add('GET','/api/public/pools',{auth:null},()=>service.publicPools())
  add('GET','/api/public/prizes',{auth:null},()=>service.publicPrizes())

  add('POST','/api/customer/auth/wechat',{auth:null},({body})=>service.customerWechatLogin(body.code))
  add('GET','/api/customer/bootstrap',{auth:'customer'},({auth})=>service.customerBootstrap(auth.sub))
  add('GET','/api/customer/records',{auth:'customer'},({auth,query})=>service.customerRecords(auth.sub,query))
  add('GET','/api/customer/records/:id',{auth:'customer'},({auth,params})=>service.customerRecord(auth.sub,params.id))
  add('POST','/api/customer/redeem',{auth:'customer'},({auth,body,ip})=>service.redeem(auth.sub,body.code,body.preferredStoreId,ip))
  add('PATCH','/api/customer/records/:id/preferred-store',{auth:'customer'},({auth,params,body})=>service.updatePreferredStore(auth.sub,params.id,body.storeId))
  add('GET','/api/customer/coupons',{auth:'customer'},({auth})=>service.customerCoupons(auth.sub))
  add('GET','/api/customer/notices',{auth:'customer'},({auth})=>service.customerNotices(auth.sub))
  add('PATCH','/api/customer/notices/read-all',{auth:'customer'},({auth})=>service.readNotice(auth.sub))
  add('PATCH','/api/customer/notices/:id/read',{auth:'customer'},({auth,params})=>service.readNotice(auth.sub,params.id))

  add('POST','/api/store/auth/login',{auth:null},({body,ip})=>service.storeLogin(body.username,body.password,ip))
  add('GET','/api/store/bootstrap',{auth:'store'},({account})=>service.storeBootstrap(account.id))
  add('GET','/api/store/orders',{auth:'store'},({account,query})=>service.storeOrders(account,query))
  add('GET','/api/store/orders/export',{auth:'store'},async({account,res})=>{
    excelResponse(res,`${account.store_name||'门店'}-兑奖订单.xls`,spreadsheetXml('门店兑奖订单',redemptionColumns(),await service.storeOrderRows(account)))
    return Symbol.for('response.sent')
  })
  add('GET','/api/store/orders/:code/verify-preview',{auth:'store'},({account,params})=>service.verifyLookup(account,params.code))
  add('POST','/api/store/orders/:code/verify',{auth:'store'},({account,params,body,ip})=>service.verify(account,params.code,body.position,ip))
  add('GET','/api/store/stats',{auth:'store'},({account})=>service.storeStats(account))
  add('GET','/api/store/trend',{auth:'store'},({account})=>service.storeTrend(account))
  add('GET','/api/store/rank',{auth:'store'},({account})=>service.storeRank(account))
  add('GET','/api/store/logs',{auth:'store'},({account,query})=>service.storeLogs(account,query))
  add('GET','/api/store/prizes',{auth:'store'},()=>service.storePrizeLibrary())
  add('GET','/api/store/staff',{auth:'store'},({account})=>service.storeStaff(account))
  add('POST','/api/store/staff',{auth:'store'},({account,body})=>service.createStoreStaff(account,body))
  add('PATCH','/api/store/staff/:id',{auth:'store'},({account,params,body})=>service.updateStoreStaff(account,params.id,body))

  add('POST','/api/admin/auth/login',{auth:null},({body,ip})=>service.adminLogin(body.username,body.password,ip))
  add('GET','/api/admin/me',{auth:'admin',sales:true},({admin})=>service.adminMe(admin))
  add('GET','/api/admin/sales',{auth:'admin'},({admin})=>service.salesUsers(admin))
  add('POST','/api/admin/sales',{auth:'admin'},({admin,body,ip})=>service.saveSalesUser(admin,null,body,ip))
  add('PATCH','/api/admin/sales/:id',{auth:'admin'},({admin,params,body,ip})=>service.saveSalesUser(admin,params.id,body,ip))
  add('GET','/api/admin/dashboard',{auth:'admin'},()=>service.adminDashboard())
  add('GET','/api/admin/settings',{auth:'admin'},()=>service.publicConfig())
  add('PUT','/api/admin/settings',{auth:'admin'},({admin,body,ip})=>service.updateSettings(admin,body,ip))
  add('GET','/api/admin/pools',{auth:'admin'},()=>service.pools())
  add('POST','/api/admin/pools',{auth:'admin'},({admin,body,ip})=>service.savePool(admin,null,body,ip))
  add('PUT','/api/admin/pools/:id',{auth:'admin'},({admin,params,body,ip})=>service.savePool(admin,params.id,body,ip))
  add('DELETE','/api/admin/pools/:id',{auth:'admin'},({admin,params,ip})=>service.deletePool(admin,params.id,ip))
  add('GET','/api/admin/prizes',{auth:'admin'},({query})=>service.prizes(query))
  add('POST','/api/admin/prizes',{auth:'admin'},({admin,body,ip})=>service.savePrize(admin,null,body,ip))
  add('PUT','/api/admin/prizes/:id',{auth:'admin'},({admin,params,body,ip})=>service.savePrize(admin,params.id,body,ip))
  add('GET','/api/admin/batches',{auth:'admin'},({query})=>service.batches(query))
  add('POST','/api/admin/batches',{auth:'admin'},({admin,body,ip})=>service.saveBatch(admin,null,body,ip))
  add('PUT','/api/admin/batches/:id',{auth:'admin'},({admin,params,body,ip})=>service.saveBatch(admin,params.id,body,ip))
  add('POST','/api/admin/batches/:id/codes/generate',{auth:'admin'},({admin,params,body,ip})=>service.generateCodes(admin,params.id,body.count,ip))
  add('GET','/api/admin/batches/:id/codes',{auth:'admin'},({params,query})=>service.batchCodes(params.id,query))
  add('GET','/api/admin/batches/:id/codes/export',{auth:'admin'},async({params,res})=>{
    const rows=await queryAll(service.db,'SELECT * FROM redeem_codes WHERE batch_id=? ORDER BY created_at,code',params.id)
    excelResponse(res,`兑换码-${params.id}.xls`,spreadsheetXml('兑换码',codeColumns(),rows))
    return Symbol.for('response.sent')
  })
  add('GET','/api/admin/stores',{auth:'admin',sales:true},({admin,query})=>service.stores(admin,query))
  add('POST','/api/admin/stores',{auth:'admin',sales:true},({admin,body,ip})=>service.saveStore(admin,null,body,ip))
  add('PUT','/api/admin/stores/:id',{auth:'admin',sales:true},({admin,params,body,ip})=>service.saveStore(admin,params.id,body,ip))
  add('DELETE','/api/admin/stores/:id',{auth:'admin',sales:true},({admin,params,ip})=>service.deleteStore(admin,params.id,ip))
  add('GET','/api/admin/stores/:id/accounts',{auth:'admin',sales:true},({admin,params})=>service.storeAccounts(admin,params.id))
  add('POST','/api/admin/stores/:id/accounts',{auth:'admin',sales:true},({admin,params,body,ip})=>service.createStoreAccountAdmin(admin,params.id,body,ip))
  add('GET','/api/admin/redemptions',{auth:'admin'},({query})=>service.adminRedemptions(query))
  add('POST','/api/admin/redemptions/:id/freeze',{auth:'admin'},({admin,params,body,ip})=>service.freezeRedemption(admin,params.id,true,body.reason,ip))
  add('POST','/api/admin/redemptions/:id/unfreeze',{auth:'admin'},({admin,params,body,ip})=>service.freezeRedemption(admin,params.id,false,body.reason,ip))
  add('GET','/api/admin/redemptions/export',{auth:'admin'},async({query,res})=>{
    const rows=await service.adminRedemptionRows(query)
    excelResponse(res,'兑奖订单.xls',spreadsheetXml('兑奖订单',redemptionColumns(),rows))
    return Symbol.for('response.sent')
  })
  add('GET','/api/admin/customers',{auth:'admin'},({query})=>service.customers(query))
  add('POST','/api/admin/customers/:id/blacklist',{auth:'admin'},({admin,params,body,ip})=>service.blacklistCustomer(admin,params.id,body.blocked,body.reason,ip))
  add('GET','/api/admin/audit',{auth:'admin'},({query})=>service.auditLogs(query))
  add('GET','/api/admin/notifications',{auth:'admin'},({query})=>service.notificationOutbox(query))
  add('POST','/api/admin/notifications/process',{auth:'admin'},({admin})=>{service.assertAdminWrite(admin);return service.processNotificationOutbox(100)})
  add('POST','/api/admin/uploads',{auth:'admin',sales:true},({admin,body,ip})=>service.saveUpload(admin,body,ip))
  return routes
}

export function matchRoute(routes, method, pathname) {
  for (const candidate of routes) {
    if (candidate.method !== method) continue
    const matched = candidate.regex.exec(pathname)
    if (!matched) continue
    const params = Object.fromEntries(candidate.names.map((name,index)=>[name,decodeURIComponent(matched[index+1])]))
    return {route:candidate,params}
  }
  return null
}
