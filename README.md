# xin-binlang-backend

倌榔定制兑奖系统的统一 API，负责活动开奖、订单核销、账号权限与 MySQL 数据持久化。

## 项目简介

后端为消费者、门店、销售和总部管理员提供统一业务接口，支持：

- 包装内 6 位数字码翻牌兑奖，顾客从 6 张牌中选择 1 张；按批次和独立奖池处理中奖概率、库存及一码一兑。
- 支持谢谢惠顾、到店补差价换购和微信现金红包；开奖及领取均由服务端保存结果，重试不重复扣库存或发红包。
- 中奖凭证、选店、门店预检与原子核销，拦截重复操作并同步订单状态。
- 总部活动与品牌配置、奖品库存、兑换码批次、门店账号、销售拓店、黑名单与订单冻结。
- Excel XML 报表导出、图片上传、审计日志、到期扫描和微信订阅消息队列。
- 微信登录接口、角色与门店数据隔离、请求限流、CORS 和安全响应头。

本仓库包含后端代码；后台页面和用户端在关联仓库独立维护。生产 API 与 H5 使用 `https://xbinglangs.oksja.cn`，管理后台使用 `https://xbinglangsht.oksja.cn`。本仓库的 `Deploy split repositories` 手动工作流统一组装和发布三端；运行凭据只保存在独立服务器环境文件及 Actions Secrets 中。

## 技术栈

- Node.js 24+，JavaScript ES Modules；使用 Node 原生 HTTP 服务，不依赖 Express。
- MySQL 8.0+ / InnoDB，mysql2 连接池、事务与行锁。
- Node crypto：scrypt 密码哈希、HMAC-SHA256 签名令牌及安全随机数。
- Node 内置 test / assert 测试，npm 与 package-lock.json 管理依赖。
- Nginx / systemd 部署模板，GitHub Actions + MySQL 容器执行 CI。

## 关联仓库

| 项目 | 说明 | GitHub |
| --- | --- | --- |
| xin-binlang-backend | 后端服务 | [xin-binlang-backend](https://github.com/jiangyi3265/xin-binlang-backend) |
| xin-binlang-admin | 管理后台 | [xin-binlang-admin](https://github.com/jiangyi3265/xin-binlang-admin) |
| xin-binlang-app | 用户端 | [xin-binlang-app](https://github.com/jiangyi3265/xin-binlang-app) |

## 快速启动

完整联调建议使用以下目录布局；当前本机目录已经符合该布局：

```bash
git clone https://github.com/jiangyi3265/xin-binlang-backend.git backend
git clone https://github.com/jiangyi3265/xin-binlang-admin.git 总部管理后台
git clone https://github.com/jiangyi3265/xin-binlang-app.git 槟榔小程序端
cd backend
npm ci
```

复制 `.env.example` 为 `.env`（PowerShell：`Copy-Item .env.example .env`）。先在 MySQL 创建 `xin_binlang` 数据库和专用账号，填写 `DB_USER`、`DB_PASSWORD`、`DB_NAME`，并设置至少 32 位随机 `TOKEN_SECRET`。环境文件只保存在本机。

```bash
npm run db:init
npm start
```

默认监听 `127.0.0.1:8897`：

- 健康检查：<http://127.0.0.1:8897/api/health>
- OpenAPI：<http://127.0.0.1:8897/api/openapi.json>
- 管理后台：<http://127.0.0.1:8897/admin>
- 消费者 H5：<http://127.0.0.1:8897/app>（需先在 app 仓库构建 H5）

仅运行 API 时无需 H5 构建。后台以及业务图片从 `ADMIN_DIR` 提供，H5 从 `H5_DIR` 提供；两个变量支持绝对路径或相对于 backend 仓库的路径，因此也可使用其他克隆目录名称。

默认 `DB_SEED=false`，初始化基础表及活动配置，不生成演示账号。开发库需要演示数据时，在首次初始化空库前设置 `DB_SEED=true`，并填写 `SEED_ADMIN_PASSWORD`、`SEED_OPERATOR_PASSWORD`、`SEED_SALES_PASSWORD`、`SEED_STORE_PASSWORD`（各至少 16 位随机字符）。生产环境禁止演示种子数据；正式账号通过受控的数据库管理流程初始化，后续由后台管理。

微信登录需配置本项目自己的 `WECHAT_APP_ID` 和 `WECHAT_APP_SECRET`；订阅消息另需对应模板 ID。所有凭据只在后端环境配置中保存。

现金奖励默认关闭，后续填写商户配置后再联调启用。完整业务流程、商户参数、到账判定和上线步骤见 [倌榔翻牌与奖励说明](docs/guanlang-rewards.md)。换购金额、红包金额和中奖比例均在后台配置；文档示例不代表正式活动承诺。

### 开发与验证

```bash
npm run dev
npm test
```

测试需专用 MySQL 8.0 实例，通过 `TEST_DB_HOST`、`TEST_DB_PORT`、`TEST_DB_USER`、`TEST_DB_PASSWORD` 设置连接，默认测试库 `xin_binlang_test`。测试账号口令在运行时随机生成。后台静态回归测试需要上面的相邻 `总部管理后台` 仓库；CI 自动检出该仓库。

`npm run pw:rotate` 默认仅预览，添加 `-- --confirm` 才轮换账号口令。`--only-weak` 从本地 `LEGACY_PASSWORDS_JSON` 读取待检测口令，不在源码中保存口令。部署前阅读 [部署说明](deploy/README.md)。

## 项目结构

```text
src/
  config.js           环境配置与生产密钥校验
  server.js           HTTP 服务、鉴权与静态文件入口
  routes.js           REST API 路由
  services.js         兑奖、核销、管理与微信业务
  pool-presentation.js 奖池包装展示配置与批次售价识别
  cash-rewards.js     红包领取台账、幂等处理与状态核对
  wechat-transfer.js  微信商家转账签名请求与响应验签
  database.js         MySQL 表结构、迁移和事务
  security.js         密码哈希、令牌与随机码
  seed-data.js        仅开发环境的演示数据
  seed-cli.js         数据库初始化入口
  rotate-passwords.js 账号口令轮换工具
test/                  API、配置安全与后台静态回归
deploy/                独立部署模板与说明
.env.example           不含凭据的环境变量示例
```

## 简历描述示例

参与兑奖平台后端开发，基于 Node.js 与 MySQL 实现兑换码开奖、库存扣减、原子核销及多角色数据隔离。建设统一 REST API、审计日志和微信登录与消息接口，支撑小程序与总部后台协同运营。
