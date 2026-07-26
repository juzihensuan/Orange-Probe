# Orange Probe

Orange Probe 是一个轻量的服务器监控面板和远程探针 Agent。项目参考了[哪吒监控](https://github.com/nezhahq/nezha)的指标组织方式与节点状态界面，但代码、品牌和视觉实现均为独立实现。

## 功能

- CPU、物理内存、虚拟内存、磁盘/挂载点、网卡、负载、温度、进程、TCP/UDP 套接字与在线时长
- 总节点、在线节点、实时带宽、累计总流量与节点流量排行
- WebSocket 实时更新，断线后自动重连
- 公开服务器卡片/列表视图与后台节点搜索
- 后台服务概览，按 CPU、Memory、Disk、Network 分类查看实时、1 天或 7 天利用率、负载、进程、容量、吞吐与连接历史
- 节点与服务监控历史持久化保存 7 天，超期文件每小时自动清理
- 节点 SLA 在线率，支持 7、30、180、365 天统计周期
- 独立服务器详情页，展示资源、进程、连接数与网络历史曲线
- 服务监控网络页，展示 HTTP GET、ICMP Ping 和 TCPing 延迟与可用率
- 离线及资源阈值告警、浏览器通知设置
- Telegram Bot API 通知，覆盖负载异常、节点离线、节点上线、临期续费和流量阈值
- 深色模式和 390px 移动端适配
- 独立远程 Agent 上报接口与 Token 校验
- 公开只读状态页与独立后台管理入口
- 后台节点标识、排序、分组、公开/私有备注与游客可见性管理
- 节点价格、计费周期、到期时间、自动续费、续费 URL 与提前通知管理
- 节点账期上传/下载流量、使用进度、阈值通知与跨 Agent 重启累计
- 后台服务监控新增、编辑、删除、统一间隔设置和 Agent 覆盖范围配置
- Agent 自动注册为 Linux systemd 服务或 Windows 系统计划任务，关闭 SSH 后持续运行
- Agent 日志按天保存，成功上报限频记录并自动清理超过 7 天的日志
- 后台系统更新中心，可一键更新 GHCR 服务端镜像和支持自更新的 Agent
- 服务监控检测间隔最低 5 秒，支持一次修改全部监控任务
- Agent 安装器自动检测并安装 curl、Node.js 20+ 与 npm
- HttpOnly Cookie 后台会话和登录频率限制
- 后台登录连续失败 5 次自动封禁来源 IP，支持持久化查看、手动封禁与解除封禁

## 快速启动

本地开发、构建和浏览器回归要求 Node.js 20 或更高版本；仅运行已经构建好的 `dist` 与服务端时支持 Node.js 18.20 或更高版本。

```powershell
npm.cmd install
npm.cmd run dev
```

开发环境地址：

- Web：<http://localhost:5173>
- API：<http://localhost:4174>

生产构建与启动：

```powershell
npm.cmd run build
npm.cmd start
```

生产模式由同一个 Node 服务同时提供 API、WebSocket 和 `dist` 前端：

- 公开只读主页：<http://localhost:4174>
- 服务器详情页：`http://localhost:4174/server/{serverId}`
- 管理后台：<http://localhost:4174/admin>

开发默认后台账号为 `admin`，密码为 `orange-probe`。部署前必须通过环境变量修改。

## 配置

Docker Compose 会读取项目根目录的 `.env`。首次生产启动必须提供非空的 `ADMIN_PASSWORD`；后台首次启动后会把密码转换为 scrypt 哈希写入数据卷。

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `4174` | 管理端监听端口 |
| `DATA_DIR` | 项目内 `data`；Docker 为 `/app/data` | 配置、认证、累计值与历史数据目录 |
| `PROBE_TOKEN` | 开发环境为 `orange-probe-agent` | 旧版 HTTP Agent 兼容密钥；新 Agent 使用节点独立 TOKEN |
| `ADMIN_USERNAME` | `admin` | 后台用户名 |
| `ADMIN_PASSWORD` | 开发环境为 `orange-probe` | 首次生产启动必填，之后可在后台修改 |
| `AGENT_TOKEN_ENCRYPTION_KEY` | 首次启动自动生成 | 固定的 Agent TOKEN 加密主密钥；生产环境建议显式设置并备份 |
| `TRUST_PROXY` | `loopback, linklocal, uniquelocal` | 仅信任本机与容器私网反代头；防火墙依靠该设置获取真实访问 IP |
| `BIND_ADDRESS` | `127.0.0.1` | Compose 发布端口绑定地址，使用反代时保持仅本机监听 |
| `PUBLIC_PORT` | `4174` | Compose 在宿主机发布的端口 |
| `DEPLOY_PATH` | `/opt/orange-probe` | 更新容器读取 Compose 文件的宿主机绝对目录 |
| `ORANGE_PROBE_TAG` | `latest` | GHCR 镜像标签，可固定为具体版本 |
| `UPDATE_TOKEN` | 无 | 主面板调用内部更新容器的随机密钥，至少 32 位 |
| `TELEGRAM_API_BASE_URL` | `https://api.telegram.org` | Telegram Bot API 地址；通常不需要修改，测试或自建网关时使用 |
| `PROBE_SERVER_URL` | `http://127.0.0.1:4174` | Agent 上报地址 |
| `PROBE_TRANSPORT` | `http` | Agent 上报方式，反代模式使用 `ws` |
| `PROBE_WS_URL` | `ws://127.0.0.1:4174/agent-ws` | Agent WebSocket/WSS 地址 |
| `PROBE_NAME` | 当前主机名 | 节点名称 |
| `PROBE_AUTO_REGION` | `true` | 根据节点公网出口自动识别国家；每 6 小时刷新 |
| `PROBE_REGION` | 空 | 自动识别失败时的回退地区；设为手动地区时需同时使用 `PROBE_AUTO_REGION=false` |
| `PROBE_TAGS` | `remote` | 逗号分隔的标签 |
| `REPORT_INTERVAL` | `3000` | Agent 上报间隔，单位毫秒 |
| `AGENT_DATA_DIR` | Agent 安装器自动设置 | Agent 运行数据和日志目录 |
| `AGENT_LOG_RETENTION_DAYS` | `7` | Agent 日志保留天数；安装器固定为 7 天 |

## Docker 部署

从旧版本升级到 v1.1.2 时请先阅读 [v1.1.2 升级指南](docs/upgrade-v1.1.2.md)。v1.1.2 首次引入更新容器和 Agent 自更新协议，因此旧部署需要手动升级一次；之后可在后台一键更新。

全新服务器一条命令安装：

```bash
curl -fsSL https://raw.githubusercontent.com/juzihensuan/Orange-Probe/main/deploy/install.sh | sudo bash
```

脚本会自动安装 Docker Engine 与 Docker Compose、生成管理员密码和更新密钥、拉取 GHCR 镜像并启动服务。默认只监听 `127.0.0.1:4174`，适合接入 1Panel OpenResty。

```bash
cp .env.example .env
# 修改 .env 中的 ADMIN_PASSWORD、PROBE_TOKEN、AGENT_TOKEN_ENCRYPTION_KEY 和端口设置
docker compose up -d --build
docker compose ps
```

容器使用非 root 用户、只读根文件系统和 `no-new-privileges`，仅为 ICMP Ping 增加 `NET_RAW`。运行数据保存在 Docker 命名卷 `orange-probe-data`，升级镜像不会删除节点配置和历史记录。容器内置的本地采集看到的是容器命名空间；监控宿主机完整状态时应在宿主机安装 Agent。

## HTTPS/WSS 反向代理

可直接使用 [`deploy/nginx/orange-probe.conf.example`](deploy/nginx/orange-probe.conf.example) 或 [`deploy/caddy/Caddyfile.example`](deploy/caddy/Caddyfile.example)。域名解析、证书申请、容器网络、验证、排错和备份步骤见[反向代理部署教程](docs/reverse-proxy.md)。使用 1Panel OpenResty 时请查看[1Panel OpenResty 教程](docs/1panel-openresty.md)和[可粘贴的 location 配置](deploy/openresty/1panel-orange-probe.locations.conf.example)。

反代与 TLS 验证完成后，在后台“监控设置”填写 `https://probe.example.com` 并启用反向代理模式。之后生成的 Agent 命令会自动使用：

```text
PROBE_SERVER_URL='https://probe.example.com'
PROBE_TRANSPORT='ws'
PROBE_WS_URL='wss://probe.example.com/agent-ws'
```

未配置有效 HTTPS 证书前不要启用此开关，否则 Agent 无法建立 WSS 连接。

本地 PowerShell 示例：

```powershell
$env:PROBE_TOKEN="replace-with-a-long-random-token"
$env:ADMIN_USERNAME="admin"
$env:ADMIN_PASSWORD="replace-with-a-long-random-password"
npm.cmd start
```

## 部署远程 Agent

每个 Agent 使用后台自动生成的独立 TOKEN。安装器会检测运行环境，缺少依赖时自动安装 curl、Node.js 22 LTS 与 npm，然后使用 `npm ci` 安装固定依赖，并根据反代设置自动选择 HTTP 或 WSS。Agent 默认根据公网出口识别 ISO 国家代码。

Linux：

```bash
# 在后台节点管理中复制完整命令并执行。
# 安装器会创建 orange-probe-agent-<节点ID>.service，并立即启动和启用开机自启。
systemctl status orange-probe-agent-<节点ID>.service
```

Windows PowerShell：

```powershell
# 使用管理员身份打开 PowerShell，再执行后台节点管理中复制的完整命令。
# 安装器会创建 OrangeProbeAgent-<节点ID> 系统计划任务并立即启动。
Get-ScheduledTask -TaskName 'OrangeProbeAgent-*'
```

Linux Agent 安装在 `/opt/orange-probe-agent/<节点ID>`，日志位于 `/var/lib/orange-probe-agent/<节点ID>/logs`。Windows Agent 安装在 `%ProgramData%\OrangeProbeAgent\<节点ID>`。安装命令可重复执行。v1.1.2 Agent 支持从后台下载 SHA256 校验的更新包，更新失败会恢复原文件；日志按天写入并自动删除超过 7 天的文件。

## Telegram 通知

在后台“监控设置”中填写 Bot Token 和 Chat ID，启用需要的通知类型后保存。系统通过 Telegram Bot API 的 [`sendMessage`](https://core.telegram.org/bots/api#sendmessage) 方法从服务端发送消息，因此不需要保持浏览器打开。

- 负载异常：CPU、内存或磁盘超过后台阈值时发送。
- 节点离线：节点从在线变为离线时发送一次。
- 节点上线：节点从离线恢复为在线时发送一次。
- 临期续费：进入节点设置的提前通知天数后发送，并在消息中附带续费 URL。
- 流量阈值：节点本期上传与下载流量合计达到设置百分比时发送。

“发送测试消息”会发送五类虚假预览，可在保存前验证 Token、Chat ID 与最终排版。

## API

- `GET /api/health`：管理端健康状态
- `GET /api/servers`：游客可见节点的当前快照
- `GET /api/servers/:id/history?period=realtime|1d|7d`：节点历史采样点，最长 7 天
- `GET /api/services?serverId=...`：指定服务器的公开服务监控
- `GET /api/services/:id/history?serverId=...&period=realtime|1d|7d`：服务监控历史采样点
- `POST /api/agents/report`：Agent 上报入口
- `WS /agent-ws`：反代模式下的 Agent WSS 上报入口
- `GET /downloads/agent/index.js`：公开下载 Agent 程序，不包含节点 TOKEN
- `GET /downloads/agent/region.js`：公开下载 Agent 公网国家识别模块
- `GET /downloads/agent/package.json`：公开下载 Agent 依赖清单
- `GET /downloads/agent/package-lock.json`：公开下载 Agent 锁文件
- `GET /downloads/agent/updater.js`：公开下载 Agent 原子更新程序
- `GET /downloads/agent/manifest.json`：读取当前 Agent 版本、文件大小与 SHA256
- `GET /downloads/agent/install-linux.sh`：公开下载 Linux systemd 安装器
- `GET /downloads/agent/install-windows.ps1`：公开下载 Windows 计划任务安装器
- `POST /api/admin/login`：后台登录
- `POST /api/admin/logout`：退出后台
- `GET /api/admin/session`：读取当前后台会话
- `GET/PUT /api/admin/settings`：读取或保存后台设置，需要后台会话
- `GET /api/admin/firewall`：读取当前访问 IP 与封禁列表，需要后台会话
- `POST /api/admin/firewall`：手动封禁单个 IPv4 或 IPv6 地址，需要后台会话
- `DELETE /api/admin/firewall/:ip`：解除指定 IP 的封禁，需要后台会话
- `GET /api/admin/servers`：读取完整服务器列表，需要后台会话
- `POST /api/admin/agents`：创建 Agent 和独立 TOKEN，需要后台会话
- `GET /api/admin/agents/:id/install`：重新读取加密保存的安装命令参数
- `GET /api/admin/agents/:id/status`：检测 Agent 是否在线
- `GET /api/admin/updates`：读取服务端、GitHub Release 和 Agent 更新状态
- `POST /api/admin/updates/server`：请求内部更新容器更新服务端
- `POST /api/admin/updates/agents`：更新指定或全部支持自更新的 Agent
- `GET /api/admin/sla?days=7|30|180|365`：读取节点 SLA，需要后台会话
- `PUT/DELETE /api/admin/servers/:id`：编辑或删除远程节点，需要后台会话
- `POST /api/admin/telegram/test`：发送 Telegram 测试消息，需要后台会话
- `GET/POST /api/admin/services`：读取或新增服务监控，需要后台会话
- `PUT /api/admin/services/interval`：统一修改全部服务监控间隔，需要后台会话
- `PUT/DELETE /api/admin/services/:id`：编辑或删除服务监控，需要后台会话
- `POST /api/servers/:id/ping`：节点 ICMP 连通测试，需要后台会话
- `WS /ws`：实时节点快照

## 验证

```powershell
npm.cmd run check
npm.cmd run build
npm.cmd run test:smoke
npm.cmd audit
```

## 生产安全

- 每个 Agent 使用独立随机 TOKEN；TOKEN 以 AES-256-GCM 加密保存，密钥位于 `data/agent-token.key`。
- 首次生产启动必须设置 `ADMIN_PASSWORD`，不要在公网使用开发凭据。
- 使用 HTTPS/WSS 反向代理保护页面、管理端 WebSocket 和 Agent 上报。
- 不要直接把 4174 端口暴露到公网；由 Nginx、Caddy 或网关转发。
- 防火墙规则保存在 `data/firewall.json`；同一 IP 连续登录失败 5 次后，页面、API 和 WebSocket 都会被拒绝。
- 反向代理必须传递正确的 `X-Forwarded-For`，并保持 `TRUST_PROXY` 只信任实际代理地址；错误配置可能封禁代理服务器地址或允许伪造来源 IP。
- Telegram Bot Token 保存在 `data/settings.json`；服务端会把运行数据文件权限收紧为仅容器用户可读写。
- 节点和服务监控曲线按日期写入 `data/history/nodes` 与 `data/history/services`，保留 7 天并在启动时恢复。
- SLA、长期累计流量和通知状态分别保存在 `data/availability.json`、`data/traffic-totals.json` 与 `data/notification-state.json`，不受 7 天图表清理影响。

## 项目结构

```text
agent/               远程指标采集与 HTTP/WSS 上报
deploy/nginx/         Nginx HTTPS/WSS 反向代理配置示例
deploy/caddy/         Caddy HTTPS/WSS 反向代理配置示例
deploy/openresty/      1Panel OpenResty 网站 location 配置
docs/                 部署、反向代理、排错与备份教程
Dockerfile            多阶段生产镜像
docker-compose.yml    受限权限容器编排
server/              REST、WebSocket、本机采集、前端托管
src/components/      仪表盘、后台节点管理与服务监控组件
src/ServerDetailPage.tsx  公开服务器详情和网络监控页
src/hooks/           实时数据连接
```

## License

MIT
