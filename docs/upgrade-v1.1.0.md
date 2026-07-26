# Orange Probe v1.1.0 升级指南

v1.1.0 修复所有 Agent 被安装命令固定为香港地区的问题，并新增公网出口国家自动识别和完整 ISO 国家旗帜。数据卷格式没有破坏性变化，节点、TOKEN、管理员账户、流量、SLA、通知和防火墙规则会继续保留。

## 1. 升级前备份

在当前部署目录执行：

```bash
docker compose ps
cp .env .env.backup

docker run --rm \
  -v orange-probe-data:/data \
  -v "$PWD":/backup \
  alpine sh -c 'tar czf /backup/orange-probe-data-before-v1.1.0.tar.gz -C /data .'
```

确认备份文件存在：

```bash
ls -lh orange-probe-data-before-v1.1.0.tar.gz .env.backup
```

## 2. 替换项目文件

将 `Orange-Probe-Docker-v1.1.0.zip` 上传到服务器并解压到新目录。发布包不包含 `.env` 和运行数据。

把旧目录的 `.env` 复制到新目录：

```bash
cp /旧版本目录/.env /新版本目录/.env
cd /新版本目录
```

使用 1Panel OpenResty 的 host 网络时，不要给 Orange Probe 增加 `network_mode: host`，也不要把服务加入名为 `host` 的 networks。保持：

```yaml
ports:
  - "127.0.0.1:4174:4174"
```

OpenResty 上游继续使用：

```text
http://127.0.0.1:4174
```

## 3. 重建容器

```bash
docker compose build --pull
docker compose up -d --force-recreate
docker compose ps
docker compose logs --tail=100 orange-probe
```

验证版本和健康状态：

```bash
curl -fsS http://127.0.0.1:4174/api/health
curl -fsS https://你的域名/api/health
```

返回的版本应为 `1.1.0`。

## 4. 升级现有 Agent

只升级面板不会改变已经运行的旧 Agent 脚本。旧 Agent 仍可能携带 `PROBE_REGION=Hong-Kong`，因此每个 Agent 都需要更新一次。

1. 登录 v1.1.0 后台。
2. 进入“节点管理”。
3. 点击该节点的“复制安装命令”。
4. 停止该节点当前运行的旧 Agent 进程或服务。
5. 执行新安装命令。
6. 点击“检测 Agent 状态”。

节点 TOKEN 不会改变，不要删除节点，也不需要重新填写计费和流量配置。新命令会下载：

```text
index.js
region.js
package.json
package-lock.json
```

并启用：

```text
PROBE_AUTO_REGION=true
```

如果 Agent 由 systemd、PM2 或 Windows 服务托管，需要把服务启动目录更新为新文件所在目录，并重启对应服务。删除旧环境中的：

```text
PROBE_REGION=Hong-Kong
```

或者确保 `PROBE_AUTO_REGION=true`。新安装命令会主动清除旧的 `PROBE_REGION` 环境变量。

## 5. 网络要求

自动国家识别会并行请求以下 HTTPS 服务，任意一个可用即可：

```text
https://api.country.is/
https://ipwho.is/
```

首次启动时识别，之后每 6 小时刷新。如果出口防火墙同时禁止两个域名，节点会使用 `PROBE_REGION` 回退值或显示为 Remote。

需要手动指定国家时使用两位 ISO 国家代码：

```bash
PROBE_AUTO_REGION=false PROBE_REGION=US npm start
```

## 6. 升级验证

- 后台左下角版本显示 `v1.1.0`。
- `/api/health` 返回 `1.1.0`。
- 美国节点显示美国旗帜，香港节点显示香港旗帜。
- 节点地区文字与公网出口国家一致。
- Agent 版本显示 `1.1.0`。
- 原节点 ID、TOKEN、计费、流量、SLA 和防火墙数据仍然存在。

如地区仍显示香港，说明旧 Agent 服务仍在运行，或者服务配置仍强制设置了 `PROBE_AUTO_REGION=false` 和 `PROBE_REGION=Hong-Kong`。
