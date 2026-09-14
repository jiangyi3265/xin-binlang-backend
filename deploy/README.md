# 新槟榔部署说明

本项目独立部署，常规 CI 仅测试和构建。三端生产发布统一由 xin-binlang-backend 的手动工作流管理。

## 访问地址

- 用户端 H5：[https://xbinglangs.oksja.cn/app/](https://xbinglangs.oksja.cn/app/)
- 后端健康检查：[https://xbinglangs.oksja.cn/api/health](https://xbinglangs.oksja.cn/api/health)
- 总部后台：[https://xbinglangsht.oksja.cn](https://xbinglangsht.oksja.cn)
- 微信小程序 AppID：`wx8887b61da8f2edd6`。AppSecret 仅保存在后端服务器。

## 三仓库发布

在 [Actions](https://github.com/jiangyi3265/xin-binlang-backend/actions/workflows/deploy-split.yml) 中选择 `Deploy split repositories`，分别填写 backend、admin、app 的分支、标签或提交 SHA，默认均为 main。

默认 `deploy=false`，执行 MySQL 后端测试、客户端检查、H5 和微信小程序构建、发布包组装及 SSH 就绪检查；已有发布时也检查服务健康。勾选 `deploy` 才将发布包上传并切换线上服务。

发布包保留以下目录布局，`release-manifest.json` 记录三个实际提交 SHA：

```text
backend/
总部管理后台/
槟榔小程序端/dist/build/h5/
release-manifest.json
```

微信小程序构建产物可从工作流的 `xin-binlang-mp-weixin-*` Artifact 下载，解压后导入微信开发者工具。服务器发布不等同于微信小程序提交审核或发布。

## 独立运行环境

| 项目 | 配置 |
| --- | --- |
| Linux 服务账号 | `xin-binlang` |
| SSH 发布账号 | `xin-binlang-deploy`，仅获本项目部署脚本的免密 sudo 权限 |
| 安装目录 | `/opt/xin-binlang` |
| 当前版本 | `/opt/xin-binlang/current` |
| Node.js | `/opt/xin-binlang/node/bin/node`，24.x |
| 后端监听 | `127.0.0.1:8897` |
| systemd 服务 | `xin-binlang.service` |
| MySQL 数据库及账号 | `xin_binlang` |
| 运行环境 | `/opt/xin-binlang/shared/.env`，root 和服务组可读 |
| 上传目录 | `/opt/xin-binlang/shared/uploads` |
| HTTPS 证书 | `/etc/letsencrypt/live/xin-binlang/` |

部署脚本先安装生产依赖，再切换当前版本、重启本项目服务并检查健康；失败时回退既有版本。生产 `DB_SEED=false`，不导入原项目订单、用户或演示业务数据；管理员账号通过受控初始化建立。

仓库 Actions Secrets 使用 `DEPLOY_HOST`、`DEPLOY_USER`、`DEPLOY_SSH_KEY`、`DEPLOY_KNOWN_HOSTS`。数据库密码、`TOKEN_SECRET`、微信 AppSecret 仅保存在服务器环境文件中，禁止写入前端、Git 或日志。

## Nginx 与证书

`nginx/` 中的两个配置分别对应用户/API 域名和总部域名，反向代理至本项目的 8897 端口。宝塔站点配置位于 `/www/server/panel/vhost/nginx/`。修改后先运行 `/www/server/nginx/sbin/nginx -t`，通过后再平滑重载。

Certbot 使用各域名 `/www/wwwroot/<域名>` 下的 HTTP 验证目录自动续期，续期成功后执行本项目的 Nginx 重载钩子。

## 小程序配置

生产构建使用 `VITE_API_ORIGIN=https://xbinglangs.oksja.cn` 和 `VITE_USE_WECHAT_LOGIN=true`。本地可将两项公开值写入被 Git 忽略的 `.env.production`；CI 和发布工作流已显式设置。

在微信公众平台为本小程序配置 request / uploadFile / downloadFile 合法域名 `https://xbinglangs.oksja.cn`。订阅通知还需在服务器填写 `WECHAT_TEMPLATE_WIN`、`WECHAT_TEMPLATE_VERIFY` 和 `WECHAT_TEMPLATE_EXPIRING`；未提供模板时不发送对应通知。
