# Orange Probe 反向代理部署教程

本文以 `probe.example.com` 为示例，面板容器只监听 `127.0.0.1:4174`，公网仅开放 80/443。Nginx 和 Caddy 配置都会代理普通 HTTP、公开实时通道 `/ws` 以及 Agent 通道 `/agent-ws`。

## 1. 部署前准备

1. 将域名 A/AAAA 记录指向服务器公网 IP。
2. 防火墙仅向公网开放 TCP 80 和 443；不要开放 4174。
3. 安装 Docker Engine 和 Compose 插件。
4. 确认服务器时间同步正常，证书签发依赖正确的系统时间。

复制环境变量并修改密钥：

```bash
cp .env.example .env
chmod 600 .env
openssl rand -base64 36
```

至少修改：

```dotenv
ADMIN_USERNAME=admin
ADMIN_PASSWORD=替换为独立强密码
PROBE_TOKEN=替换为另一个随机值
AGENT_TOKEN_ENCRYPTION_KEY=替换为长期保存的随机值
BIND_ADDRESS=127.0.0.1
PUBLIC_PORT=4174
```

`AGENT_TOKEN_ENCRYPTION_KEY` 一旦用于生产就必须长期保存；改变它会导致后台无法解密已经保存的 Agent 安装 TOKEN。

启动并确认健康状态：

```bash
docker compose up -d --build
docker compose ps
curl -fsS http://127.0.0.1:4174/api/health
```

Docker 中的“本地节点”采集的是容器命名空间。需要监控宿主机完整磁盘、网卡、进程和网络吞吐时，应在宿主机另外安装 Agent。

## 2. Nginx 方案

安装 Nginx 与 Certbot（Debian/Ubuntu 示例）：

```bash
sudo apt update
sudo apt install -y nginx certbot python3-certbot-nginx
sudo certbot certonly --nginx -d probe.example.com
```

复制项目内配置：

```bash
sudo cp deploy/nginx/orange-probe.conf.example /etc/nginx/sites-available/orange-probe
sudo sed -i 's/probe.example.com/你的域名/g' /etc/nginx/sites-available/orange-probe
sudo ln -s /etc/nginx/sites-available/orange-probe /etc/nginx/sites-enabled/orange-probe
sudo nginx -t
sudo systemctl reload nginx
```

完整示例位于 `deploy/nginx/orange-probe.conf.example`。其中两个 WebSocket 位置必须保留 Upgrade/Connection 请求头和较长的读取超时。Nginx 1.25.1 及以上也可将 `listen 443 ssl http2;` 改为 `listen 443 ssl;` 并在 `server` 块中使用 `http2 on;`。

证书自动续期检查：

```bash
sudo certbot renew --dry-run
systemctl list-timers | grep certbot
```

## 3. Caddy 方案

Caddy 会自动申请和续期 HTTPS 证书，并自动处理 WebSocket 升级。安装 Caddy 后复制配置：

```bash
sudo cp deploy/caddy/Caddyfile.example /etc/caddy/Caddyfile
sudo sed -i 's/probe.example.com/你的域名/g' /etc/caddy/Caddyfile
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

日志目录需要允许 Caddy 用户写入：

```bash
sudo install -d -o caddy -g caddy /var/log/caddy
```

如不需要文件访问日志，可删除示例中的 `log` 块。

## 4. 反代也运行在 Docker 中

当 Nginx/Caddy 与 Orange Probe 位于同一个 Compose 网络时，不要把上游写成 `127.0.0.1:4174`，应写服务名：

```text
orange-probe:4174
```

此时可以删除 Orange Probe 的 `ports`，改为仅声明：

```yaml
expose:
  - "4174"
```

反代容器与 `orange-probe` 服务必须加入同一个自定义网络。

## 5. 在后台启用 WSS Agent

1. 浏览器打开 `https://你的域名/admin`。
2. 进入“监控设置”。
3. 域名填写 `https://你的域名`，不要带路径或末尾斜杠。
4. 启用反向代理并保存。
5. 新建或重新打开 Agent 安装命令。

生成命令应包含：

```text
PROBE_SERVER_URL=https://你的域名
PROBE_TRANSPORT=ws
PROBE_WS_URL=wss://你的域名/agent-ws
```

安装命令会下载系统安装器和独立 Agent，使用锁文件安装 `ws` 依赖，并注册为 Linux systemd 服务或 Windows 系统计划任务。关闭 SSH 后 Agent 仍会运行，异常退出会自动重启。命令中的 36 位 TOKEN 属于节点凭据，不应发布到聊天记录或工单。

## 6. 防火墙与真实访问 IP

Orange Probe 会在同一 IP 连续登录失败 5 次后持久化封禁该地址。Nginx 示例已传递 `X-Real-IP` 和 `X-Forwarded-For`，Caddy 的 `reverse_proxy` 也会自动设置标准转发头。

部署完成后进入后台“防火墙”页面，确认“当前访问 IP”显示的是管理员公网 IP，而不是 `127.0.0.1`、Docker 网关地址或反向代理容器 IP。

不要将 `TRUST_PROXY` 设置为无条件信任所有来源，也不要在 4174 端口公开可访问时信任任意 `X-Forwarded-For`。默认值只信任回环、链路本地和私网代理，适用于反代与应用在同一主机或 Docker 私网的部署。

使用 CDN 时需要确保 CDN 覆盖客户端传入的转发头，并让 Nginx/Caddy 将 CDN 验证后的真实 IP 传给应用。否则防火墙可能看到 CDN 出口 IP。修改后应再次检查后台显示的当前访问 IP，再进行登录失败封禁测试。

## 7. 验证清单

```bash
curl -fsS https://你的域名/api/health
curl -I https://你的域名/downloads/agent/package.json
```

再检查：

- 主页可以读取节点，未登录时不能新增、编辑或删除。
- `/admin` 可以登录，浏览器控制台没有 WebSocket 连接错误。
- 新增 Agent 后运行安装命令，“检测 Agent 状态”在数秒内变为在线。
- 节点切换在线/离线时，Telegram 通知按后台开关发送。
- 防火墙页面显示正确的公网访问 IP；使用一个测试 IP 手动封禁后，访问页面会显示 403、封禁提示和该 IP。

## 8. 常见故障

`502 Bad Gateway`：确认 `docker compose ps` 为 healthy，且反代上游与实际监听地址一致。在宿主机运行反代时使用 `127.0.0.1:4174`；在同一 Docker 网络中使用 `orange-probe:4174`。

WebSocket 返回 400/连接后立即断开：检查 Nginx 的 `proxy_http_version 1.1`、`Upgrade`、`Connection`、`Host` 请求头，检查后台填写的公开域名与浏览器访问域名完全一致。

Agent WSS 超时：确认 `/agent-ws` 没有被 CDN 缓存，证书链有效，服务器和中间网关允许长连接。若使用 Cloudflare，DNS 记录需要启用 WebSocket 支持，且 SSL/TLS 模式应使用 Full (strict)。

后台 403：通常是反代传递的 `Host`/`X-Forwarded-Proto` 不正确，或浏览器 Origin 与后台公开域名不一致。不要随意扩大 `TRUST_PROXY` 到所有来源。

多人被同时封禁或后台显示代理 IP：说明真实 IP 转发链配置错误。先从服务器本机或另一个未封禁 IP 登录解除规则，再检查 `X-Forwarded-For` 和 `TRUST_PROXY`。不要直接删除整个数据卷；必要时只备份后编辑 `firewall.json`。

证书申请失败：确认 DNS 已生效、80/443 未被其他程序占用、AAAA 记录确实可从公网访问。

## 9. 升级、备份与恢复

升级前备份命名卷：

```bash
docker run --rm -v orange-probe-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/orange-probe-data-$(date +%F).tar.gz -C /data .
docker compose build --pull
docker compose up -d
```

恢复到空卷：

```bash
docker compose down
docker volume create orange-probe-data
docker run --rm -v orange-probe-data:/data -v "$PWD":/backup alpine \
  tar xzf /backup/你的备份文件.tar.gz -C /data
docker compose up -d
```

不要把 `.env`、数据卷备份、`settings.json` 或 `agent-token.key` 放入公开仓库。数据卷包含管理员认证记录、Telegram Bot Token、节点 TOKEN 加密密钥、计费信息和历史数据。

## 参考文档

- Nginx WebSocket 代理：https://nginx.org/en/docs/http/websocket.html
- Nginx Proxy 模块：https://nginx.org/en/docs/http/ngx_http_proxy_module.html
- Caddy `reverse_proxy`：https://caddyserver.com/docs/caddyfile/directives/reverse_proxy
- Docker Volumes：https://docs.docker.com/engine/storage/volumes/
