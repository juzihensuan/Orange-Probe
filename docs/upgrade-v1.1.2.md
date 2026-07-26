# Orange Probe v1.1.2 升级指南

v1.1.2 新增后台更新中心、GHCR 服务端镜像更新、Agent 自更新、Agent 依赖自动安装，并把服务监控最低间隔调整为 5 秒。数据卷格式保持兼容。

## 1. 首次升级为什么需要手动操作

v1.1.1 及更早版本没有内部更新容器，旧 Agent 也不认识自更新指令。因此升级到 v1.1.2 时需要手动替换一次 Docker Compose，并在每个 Agent 上重新执行一次安装命令。完成后，后续版本可以直接在后台“系统更新”页面操作。

## 2. 备份数据卷和环境文件

```bash
cd /opt/orange-probe
docker run --rm \
  -v orange-probe-data:/data \
  -v "$PWD":/backup \
  alpine sh -c 'tar czf /backup/orange-probe-data-before-v1.1.2.tar.gz -C /data .'
cp .env .env.before-v1.1.2
```

不要执行 `docker compose down -v`。

## 3. 使用一键脚本升级

旧部署目录为 `/opt/orange-probe` 时直接执行：

```bash
curl -fsSL https://raw.githubusercontent.com/juzihensuan/Orange-Probe/main/deploy/install.sh | sudo bash
```

脚本会保留已有 `.env` 和 `orange-probe-data` 数据卷，更新 Compose 文件并拉取：

```text
ghcr.io/juzihensuan/orange-probe:latest
ghcr.io/juzihensuan/orange-probe-updater:latest
```

如果旧 `.env` 缺少以下变量，请补充随机值：

```bash
DEPLOY_PATH=/opt/orange-probe
ORANGE_PROBE_TAG=latest
UPDATE_TOKEN=$(openssl rand -hex 32)
```

`UPDATE_TOKEN` 至少 32 位，文件权限应保持为 `0600`。

## 4. 升级 Agent

1. 登录后台并进入“节点管理”。
2. 逐个打开 Agent 安装命令。
3. Linux 直接执行命令；Windows 使用管理员 PowerShell 执行。
4. 等待 Agent 版本显示 `1.1.2`。
5. 进入“系统更新”，确认状态不再显示“需重新安装”。

安装器会自动补齐依赖。Linux 支持 apt、dnf、yum、apk 和 pacman；Windows 会从 nodejs.org 安装 Node.js 22 LTS。

## 5. 后续一键更新

发布新版本后，后台“系统更新”会从 GitHub Release 检查最新版本：

- “一键更新服务端”让内部更新容器拉取 GHCR 最新镜像并只重建主面板容器。
- “更新全部 Agent”给在线或离线 Agent 排队；Agent 下次上线后下载更新清单、校验 SHA256、替换文件并自动重启。
- 更新失败的 Agent 会恢复原文件并在后台显示错误信息。

主面板容器不挂载 Docker Socket。只有未映射公网端口、带独立 Token 的 `orange-probe-updater` 容器拥有 Docker Socket。

## 6. 验证

```bash
docker compose --project-name orange-probe ps
curl -fsS http://127.0.0.1:4174/api/health
```

- 健康接口返回 `1.1.2`。
- 后台出现“系统更新”菜单。
- 更新页面显示 GitHub 最新版本和更新容器已配置。
- Agent 显示支持自动更新。
- 服务监控可以保存和批量设置 `5` 秒间隔。
