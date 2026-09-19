import { createServer } from 'node:http'
import { existsSync, realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadConfig } from './config.js'
import { openDatabase } from './database.js'
import { apiError, json, sendFile } from './http-utils.js'
import { bearerToken, randomId, verifyToken } from './security.js'
import { PlatformService } from './services.js'
import { createRoutes, matchRoute } from './routes.js'
import { buildOpenApi } from './openapi.js'

const BODY_LIMIT = 7 * 1024 * 1024

function clientIp(req) {
  return String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim()
}

function parseBody(req) {
  if (req.method === 'GET' || req.method === 'HEAD') return Promise.resolve({})
  return new Promise((resolveBody,reject)=>{
    const chunks=[]
    let size=0
    req.on('data',chunk=>{
      size+=chunk.length
      if(size>BODY_LIMIT){reject(apiError(413,'ERR_BODY_TOO_LARGE','请求内容不能超过 7MB'));req.destroy();return}
      chunks.push(chunk)
    })
    req.on('end',()=>{
      if(!size){resolveBody({});return}
      const type=String(req.headers['content-type']||'').split(';')[0]
      if(type!=='application/json'){reject(apiError(415,'ERR_CONTENT_TYPE','接口仅接受 application/json'));return}
      try{resolveBody(JSON.parse(Buffer.concat(chunks).toString('utf8')))}catch{reject(apiError(400,'ERR_JSON','JSON 请求内容格式不正确'))}
    })
    req.on('error',reject)
  })
}

function createRateLimiter() {
  const buckets=new Map()
  return (key,limit,windowMs)=>{
    const now=Date.now();const current=buckets.get(key)
    if(!current||current.reset<=now){buckets.set(key,{count:1,reset:now+windowMs});return}
    current.count+=1
    if(current.count>limit)throw apiError(429,'ERR_RATE_LIMIT','操作过于频繁，请稍后再试')
    if(buckets.size>2000) for(const [name,value] of buckets) if(value.reset<=now)buckets.delete(name)
  }
}

// 微信小程序真机请求不带 Origin，但开发者工具与部分 webview 会带
// https://servicewechat.com，漏掉它会让登录直接 403 ERR_ORIGIN。
const WECHAT_ORIGIN=/^https:\/\/(?:[\w-]+\.)?servicewechat\.com$/

function securityHeaders(req,res,config,requestId) {
  const origin=String(req.headers.origin||'')
  const allowed=!origin||config.allowedOrigins.includes(origin)||WECHAT_ORIGIN.test(origin)||/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)
  if(origin&&allowed){res.setHeader('Access-Control-Allow-Origin',origin);res.setHeader('Vary','Origin')}
  res.setHeader('Access-Control-Allow-Headers','Authorization, Content-Type, X-Request-Id')
  res.setHeader('Access-Control-Allow-Methods','GET, POST, PUT, PATCH, OPTIONS')
  res.setHeader('X-Content-Type-Options','nosniff')
  res.setHeader('X-Frame-Options','DENY')
  res.setHeader('Referrer-Policy','same-origin')
  res.setHeader('Permissions-Policy','camera=(), microphone=(), geolocation=(self)')
  res.setHeader('Content-Security-Policy',"default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self' http://127.0.0.1:* http://localhost:*; frame-ancestors 'none'; base-uri 'self'; form-action 'self'")
  res.setHeader('X-Request-Id',requestId)
  return allowed
}

async function authenticate(route,req,service,config) {
  if(!route.auth)return {auth:null,account:null,admin:null}
  const payload=verifyToken(bearerToken(req.headers),config.tokenSecret)
  if(!payload||payload.type!==route.auth)throw apiError(401,'ERR_AUTH','登录已失效，请重新登录')
  if(route.auth==='customer')return {auth:payload,account:null,admin:null}
  if(route.auth==='store')return {auth:payload,account:await service.storeAccount(payload.sub),admin:null}
  const admin=await service.adminUser(payload.sub)
  if(admin.role==='sales'&&route.sales!==true)throw apiError(403,'ERR_PERMISSION','销售账号仅可进入本人门店管理功能')
  return {auth:payload,account:null,admin}
}

function staticResponse(req,res,url,config) {
  if(req.method!=='GET'&&req.method!=='HEAD')return false
  if(url.pathname.startsWith('/uploads/'))return sendFile(res,config.uploadDir,url.pathname.slice('/uploads/'.length),true)
  if(url.pathname==='/app'||url.pathname==='/app/'||url.pathname.startsWith('/app/')){
    res.setHeader('Content-Security-Policy',"default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self' http://127.0.0.1:* http://localhost:*; frame-ancestors 'none'; base-uri 'self'; form-action 'self'")
    const relative=url.pathname.startsWith('/app/assets/')?url.pathname.slice('/app/'.length):'index.html'
    return sendFile(res,config.h5Dir,relative,url.pathname.startsWith('/app/assets/'))
  }
  if(url.pathname.startsWith('/assets/')){
    const relative=url.pathname.slice('/assets/'.length)
    const versioned=/\.(?:png|jpe?g|webp|svg|ico)$/i.test(relative)
    return sendFile(res,resolve(config.adminDir,'assets'),relative,versioned)
  }
  if(url.pathname==='/favicon.ico')return sendFile(res,config.adminDir,'favicon.svg',true)
  if(url.pathname==='/'||url.pathname==='/admin'||url.pathname.startsWith('/admin/'))return sendFile(res,config.adminDir,'index.html')
  return false
}

export async function createApp(overrides={}) {
  const config=loadConfig(overrides)
  const db=await openDatabase(config,{seed:config.database.seed})
  const service=new PlatformService(db,config)
  const routes=createRoutes(service)
  const limit=createRateLimiter()
  const expirationTimer=setInterval(()=>{Promise.all([service.expireOrders(),service.enqueueExpiringReminders(),service.cash.reconcile()]).catch(error=>console.error('[background:expiration]',error))},60_000)
  const notificationTimer=setInterval(()=>{service.processNotificationOutbox().catch(error=>console.error('[background:notification]',error))},15_000)
  expirationTimer.unref()
  notificationTimer.unref()
  const server=createServer(async(req,res)=>{
    const requestId=String(req.headers['x-request-id']||randomId('REQ'))
    const ip=clientIp(req)
    try{
      const allowedOrigin=securityHeaders(req,res,config,requestId)
      if(!allowedOrigin)throw apiError(403,'ERR_ORIGIN','请求来源不允许')
      if(req.method==='OPTIONS'){res.writeHead(204);res.end();return}
      const url=new URL(req.url||'/',config.publicOrigin)
      if(url.pathname==='/api/openapi.json'){json(res,200,buildOpenApi(config.publicOrigin));return}
      const matched=matchRoute(routes,req.method||'GET',url.pathname)
      if(!matched){
        if(staticResponse(req,res,url,config))return
        throw apiError(404,'ERR_NOT_FOUND','接口或页面不存在')
      }
      limit(`${ip}:all`,180,60_000)
      // 账号密码登录是撞库面，保持严格；微信登录不可爆破，而且小程序每次冷启动
      // 都要重新换 code，配额太小会把正常用户挡在门外。
      if(url.pathname==='/api/customer/auth/wechat')limit(`${ip}:wechat-login`,60,5*60_000)
      else if(url.pathname.includes('/auth/'))limit(`${ip}:login`,12,5*60_000)
      if(url.pathname.endsWith('/draw')||url.pathname.endsWith('/claim')||url.pathname.endsWith('/redeem')||url.pathname.endsWith('/verify'))limit(`${ip}:write`,20,60_000)
      const body=await parseBody(req)
      const auth=await authenticate(matched.route,req,service,config)
      if(url.pathname==='/api/customer/draw/preview')limit(`${auth.auth.sub}:draw-preview`,20,60_000)
      const query=Object.fromEntries(url.searchParams.entries())
      const value=await matched.route.handler({req,res,body,query,params:matched.params,ip,requestId,...auth})
      if(value===Symbol.for('response.sent')||res.writableEnded)return
      json(res,200,{ok:true,data:value,requestId})
    }catch(error){
      if(res.writableEnded||res.destroyed)return
      const status=Number(error.statusCode||500)
      if(status>=500)console.error(`[${requestId}]`,error)
      json(res,status,{ok:false,error:{code:error.code||'ERR_INTERNAL',message:status>=500?'服务暂时不可用，请稍后再试':error.message,details:error.details||null},requestId})
    }
  })
  server.on('close',()=>{clearInterval(expirationTimer);clearInterval(notificationTimer)})
  let closing=null
  const close=()=>closing||(closing=(async()=>{
    if(server.listening)await new Promise((resolveClose,reject)=>server.close(error=>error?reject(error):resolveClose()))
    await db.close()
  })())
  return {server,service,db,config,close}
}

export async function start(overrides={}) {
  const app=await createApp(overrides)
  await new Promise((resolveStart,reject)=>{app.server.once('error',reject);app.server.listen(app.config.port,app.config.host,resolveStart)})
  const address=app.server.address()
  console.log(`倌榔平台已启动：http://${app.config.host}:${address.port}`)
  console.log(`总部管理后台：http://${app.config.host}:${address.port}/admin`)
  console.log(`OpenAPI 文档：http://${app.config.host}:${address.port}/api/openapi.json`)
  return app
}

if(process.argv[1]&&realpathSync(fileURLToPath(import.meta.url))===realpathSync(resolve(process.argv[1])))start()
