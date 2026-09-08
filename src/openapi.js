export function buildOpenApi(origin) {
  const ok = schema => ({
    description: '请求成功',
    content: { 'application/json': { schema: { type:'object', properties:{ ok:{type:'boolean'}, data:schema || {type:'object'} } } } }
  })
  const auth = [{ bearerAuth:[] }]
  const operation = (summary, tags, secured = true, extra = {}) => ({ summary, tags:[tags], ...(secured?{security:auth}:{}), responses:{ 200:ok(), 400:{description:'业务校验失败'}, 401:{description:'未登录或令牌失效'}, 403:{description:'无权限'} }, ...extra })
  return {
    openapi:'3.1.0',
    info:{ title:'津郎记兑奖平台 API', version:'1.0.0', description:'消费者小程序、门店端与总部管理后台统一业务接口。所有写操作均受服务端校验与审计。' },
    servers:[{url:origin}],
    tags:[
      {name:'Public',description:'公开配置与健康检查'},
      {name:'Customer',description:'消费者小程序'},
      {name:'Store',description:'门店端'},
      {name:'Admin',description:'总部管理后台'}
    ],
    components:{
      securitySchemes:{bearerAuth:{type:'http',scheme:'bearer',bearerFormat:'JWT'}},
      schemas:{
        Login:{type:'object',required:['username','password'],properties:{username:{type:'string'},password:{type:'string',format:'password'}}},
        Redeem:{type:'object',required:['code'],properties:{code:{type:'string',minLength:6,maxLength:6},preferredStoreId:{type:'string'}}},
        Verify:{type:'object',properties:{position:{type:'string'}}}
      }
    },
    paths:{
      '/api/health':{get:operation('服务健康检查','Public',false)},
      '/api/public/config':{get:operation('活动公开配置','Public',false)},
      '/api/public/stores':{get:operation('可用门店列表','Public',false)},
      '/api/public/pools':{get:operation('公开奖池列表','Public',false)},
      '/api/public/prizes':{get:operation('公开奖品陈列（不含库存与权重）','Public',false)},
      '/api/customer/auth/wechat':{post:operation('微信 code 登录','Customer',false)},
      '/api/customer/bootstrap':{get:operation('消费者端初始化数据','Customer')},
      '/api/customer/redeem':{post:operation('兑换并抽奖','Customer',true,{requestBody:{required:true,content:{'application/json':{schema:{$ref:'#/components/schemas/Redeem'}}}}})},
      '/api/customer/records':{get:operation('消费者兑奖记录','Customer')},
      '/api/customer/coupons':{get:operation('消费者优惠券','Customer')},
      '/api/customer/notices':{get:operation('消费者通知','Customer')},
      '/api/store/auth/login':{post:operation('门店账号登录','Store',false,{requestBody:{required:true,content:{'application/json':{schema:{$ref:'#/components/schemas/Login'}}}}})},
      '/api/store/bootstrap':{get:operation('门店端初始化数据','Store')},
      '/api/store/orders':{get:operation('权限范围内订单','Store')},
      '/api/store/orders/{code}/verify-preview':{get:operation('核销前校验','Store')},
      '/api/store/orders/{code}/verify':{post:operation('原子核销订单','Store')},
      '/api/store/stats':{get:operation('门店统计','Store')},
      '/api/store/trend':{get:operation('七日核销趋势','Store')},
      '/api/store/rank':{get:operation('门店排行','Store')},
      '/api/store/logs':{get:operation('门店审计日志','Store')},
      '/api/store/staff':{get:operation('店员列表','Store'),post:operation('创建店员','Store')},
      '/api/admin/auth/login':{post:operation('总部管理员登录','Admin',false,{requestBody:{required:true,content:{'application/json':{schema:{$ref:'#/components/schemas/Login'}}}}})},
      '/api/admin/dashboard':{get:operation('总部数据总览','Admin')},
      '/api/admin/settings':{get:operation('活动设置','Admin'),put:operation('更新活动设置','Admin')},
      '/api/admin/pools':{get:operation('奖池列表','Admin'),post:operation('创建奖池','Admin')},
      '/api/admin/pools/{id}':{put:operation('更新奖池','Admin'),delete:operation('删除无兑奖历史的奖池及其关联配置','Admin')},
      '/api/admin/prizes':{get:operation('奖品列表','Admin'),post:operation('创建奖品','Admin')},
      '/api/admin/batches':{get:operation('批次列表','Admin'),post:operation('创建批次','Admin')},
      '/api/admin/sales':{get:operation('销售账号列表（仅超级管理员）','Admin'),post:operation('创建销售账号（仅超级管理员）','Admin')},
      '/api/admin/sales/{id}':{patch:operation('更新、停用或重置销售账号（仅超级管理员）','Admin')},
      '/api/admin/stores':{get:operation('门店列表','Admin'),post:operation('创建门店','Admin')},
      '/api/admin/stores/{id}':{put:operation('更新门店','Admin'),delete:operation('删除无兑奖历史的门店及其门店账号','Admin')},
      '/api/admin/stores/{id}/accounts':{get:operation('门店账号列表','Admin'),post:operation('创建门店账号','Admin')},
      '/api/admin/uploads':{post:operation('上传后台配置图片','Admin')},
      '/api/admin/redemptions':{get:operation('按门店、状态或关键词筛选兑奖订单','Admin')},
      '/api/admin/redemptions/export':{get:operation('按当前筛选条件导出兑奖订单与门店核销信息','Admin')},
      '/api/admin/customers':{get:operation('用户管理','Admin')},
      '/api/admin/audit':{get:operation('全链路审计日志','Admin')}
    }
  }
}
