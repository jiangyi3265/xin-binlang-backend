# 新槟榔部署配置

当前 GitHub Actions 仅测试和构建，不执行服务器部署。此目录是待配置模板，尚未在服务器安装。

本项目约定使用：

- Linux 服务账号及用户组：`xin-binlang`。
- 安装目录：`/opt/xin-binlang`。
- 后端监听：`127.0.0.1:8897`。
- systemd 服务：`xin-binlang.service`。
- 数据库及账号：`xin_binlang`。
- 生产环境文件：`/opt/xin-binlang/shared/.env`。
- 上传目录：`/opt/xin-binlang/shared/uploads`。
- Node.js 24 可执行文件：`/opt/xin-binlang/node/bin/node`。

上线前配置新甲方的独立服务器账号、数据库密码、`TOKEN_SECRET`、小程序 AppID / AppSecret 和订阅模板。环境文件中的 `PORT` 设为 `8897`，`UPLOAD_DIR` 设为上述共享上传目录，`PUBLIC_ORIGIN` 和 `ALLOWED_ORIGINS` 使用新域名。

Nginx 模板中的 `api.example.com`、`admin.example.com` 是占位域名，须替换为新甲方域名，并配置独立 TLS 证书。模板证书路径为 `/etc/letsencrypt/live/xin-binlang/`。

前端 `manifest.json` 中两个 AppID 均待填写；在 `.env` 配置新 API 地址及 `VITE_USE_WECHAT_LOGIN=true` 后重新构建。仅有本地回环地址的 CI 构建包不可直接用于真机或生产环境。

完成目录、账号权限、Node.js、数据库、Nginx、TLS 和 systemd 配置后，再添加本仓库自己的部署凭据与发布流程。原项目的域名、服务、上传目录及数据库不属于本项目。

## 三仓库发布包布局

模板部署脚本接收包含 backend/、总部管理后台/、槟榔小程序端/dist/build/h5/ 的组装发布包。拆分后需要分别检出三个仓库并完成 app 构建，再组装发布包；直接打包 backend 仓库无法提供完整页面与业务图片。当前三个仓库的 CI 均不会自动部署服务器。