# Orange Probe v1.1.1 升级指南

v1.1.1 修复多目标 Ping 时间不一致时提示框数据不完整的问题，服务监控支持统一修改检测间隔，并把 Agent 安装方式改为持久后台服务。Agent 日志按天保存并自动清理超过 7 天的文件。面板数据卷格式没有破坏性变化。

## 1. 备份现有数据

在当前 Compose 目录执行：

```bash
docker run --rm \
  -v orange-probe-data:/data \
  -v "$PWD":/backup \
  alpine sh -c 'tar czf /backup/orange-probe-data-before-v1.1.1.tar.gz -C /data .'
cp .env .env.before-v1.1.1
```

不要执行 `docker compose down -v`，`-v` 会删除保存节点、TOKEN、账户、SLA、流量、通知和防火墙规则的命名卷。

## 2. 替换程序并重建容器

把 `Orange-Probe-Docker-v1.1.1.zip` 上传并解压到新目录，将旧部署目录的 `.env` 放入新目录，然后执行：

```bash
docker compose -p orange-probe down --remove-orphans
docker compose -p orange-probe up -d --build
docker compose -p orange-probe ps
curl -fsS http://127.0.0.1:4174/api/health
```

1Panel OpenResty 继续反代 `http://127.0.0.1:4174`，无需修改已有 HTTPS/WSS location 配置。健康接口返回的版本应为 `1.1.1`。

## 3. 升级并后台化每个 Agent

旧 Agent 是在 SSH 终端中直接执行 `npm start` 的，关闭终端会随之退出。升级面板后，对每个节点执行：

1. 登录后台并进入“节点管理”。
2. 打开节点的“安装命令”。
3. 停止该节点旧的前台 Agent 进程，避免同一 TOKEN 重复上报。
4. Linux 直接执行新命令；Windows 使用管理员 PowerShell 执行新命令。
5. 回到弹窗点击“检测 Agent 状态”。

Linux 会创建并启用 `orange-probe-agent-<节点ID>.service`：

```bash
systemctl status orange-probe-agent-<节点ID>.service
journalctl -u orange-probe-agent-<节点ID>.service -n 100 --no-pager
```

Windows 会创建以 `OrangeProbeAgent-<节点ID>` 命名、使用 SYSTEM 账户运行的开机计划任务：

```powershell
Get-ScheduledTask -TaskName 'OrangeProbeAgent-*'
Get-ScheduledTaskInfo -TaskName 'OrangeProbeAgent-<节点ID>'
```

安装命令可以重复执行。再次执行时会更新 Agent 文件、依赖、连接参数并重启同一个后台服务，不会生成新节点或改变 TOKEN。

## 4. 日志位置和自动清理

Linux 日志目录：

```text
/var/lib/orange-probe-agent/<节点ID>/logs
```

Windows 日志目录：

```text
%ProgramData%\OrangeProbeAgent\<节点ID>\data\logs
```

Agent 每天创建一个 `YYYY-MM-DD.log` 文件，每天检查并删除超过 7 天的日志。成功上报最多每小时记录一次；相同错误在 5 分钟内会合并，避免网络故障时日志快速增长。

## 5. 验证

- 后台左下角显示 `Orange Probe v1.1.1`。
- `/api/health` 返回 `1.1.1`。
- 关闭 Agent 的 SSH 会话后，节点仍保持在线。
- 服务监控页没有“最近结果”和“立即测试”，可以一次修改全部监控间隔。
- 多个 Ping 目标的采样时间不完全一致时，曲线提示框仍列出全部目标的最近有效值。
- Agent 版本显示 `1.1.1`，日志目录中没有超过 7 天的日志文件。
