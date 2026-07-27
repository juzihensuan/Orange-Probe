# 使用 1Panel OpenResty 反向代理 Orange Probe

本文以 `probe.example.com` 为示例。推荐让 Orange Probe 与 1Panel OpenResty 加入同一个 Docker 网络，并使用容器地址 `http://orange-probe:4174`。这样不需要向公网开放 4174，也不会混淆宿主机和 OpenResty 容器的 `127.0.0.1`。

不同 1Panel 版本的菜单文字可能略有差异，一般位于“网站”或“网站管理”中。

## 1. 前置条件

- 域名 A/AAAA 记录已经指向 1Panel 服务器。
- 1Panel 应用商店中的 OpenResty 已安装并正常监听 80/443。
- Orange Probe Docker 容器名称为 `orange-probe`，服务端口为 4174。
- 公网防火墙只开放 80/443，不开放 4174。

先确认 Orange Probe 本身健康：

```bash
docker compose ps
curl -fsS http://127.0.0.1:4174/api/health
```

应返回包含 `"ok":true` 的 JSON。

## 2. 让两个容器共享网络

查找 1Panel OpenResty 容器：

```bash
docker ps --format 'table {{.Names}}\t{{.Image}}' | grep -i openresty
```

假设查到的容器名为 `1Panel-openresty-xxxx`。读取它当前加入的 Docker 网络：

```bash
docker inspect 1Panel-openresty-xxxx \
  --format '{{range $name, $config := .NetworkSettings.Networks}}{{$name}}{{println}}{{end}}'
```

选择其中用于 1Panel 应用通信的网络。假设实际网络名是 `1panel-network`，在 Orange Probe 的 `docker-compose.yml` 中加入：

```yaml
services:
  orange-probe:
    # 保留原有 build、environment、volumes 等配置
    networks:
      - default
      - 1panel-proxy

networks:
  1panel-proxy:
    external: true
    name: 1panel-network
```

这里的 `name` 必须替换为上一步查到的真实网络名。重新创建 Orange Probe：

```bash
docker compose up -d
docker inspect orange-probe \
  --format '{{range $name, $config := .NetworkSettings.Networks}}{{$name}}{{println}}{{end}}'
```

从 OpenResty 容器中检查上游。如果镜像包含 `curl`：

```bash
docker exec 1Panel-openresty-xxxx \
  curl -fsS http://orange-probe:4174/api/health
```

如果没有 `curl`，可尝试：

```bash
docker exec 1Panel-openresty-xxxx \
  wget -qO- http://orange-probe:4174/api/health
```

此处无法访问时不要继续配置域名，先检查两个容器是否确实位于同一网络，以及 Orange Probe 容器是否正在监听 4174。

## 3. 在 1Panel 创建网站

1. 打开 1Panel，进入“网站”。
2. 点击“创建网站”。
3. 网站类型选择“反向代理”。部分版本需要先创建普通网站，再进入该网站的“反向代理”页面新增代理。
4. 主域名填写 `probe.example.com`。
5. 代理名称可填写 `orange-probe`。
6. 代理地址填写 `http://orange-probe:4174`。
7. 缓存关闭。
8. 保存网站。

如果 1Panel 创建页面无法校验容器域名，可先临时填写一个可保存的地址，创建完成后再按下一节修改网站配置文件。

## 4. 配置 OpenResty

进入：

```text
网站 -> probe.example.com -> 配置 -> 配置文件
```

保留 1Panel 生成的 `server_name`、日志、证书、ACME 验证和安全 include。删除自动生成的同名 `location /` 或 `location ^~ /` 反代块，然后把以下内容放入 HTTPS 的 `server {}` 中：

```nginx
client_max_body_size 256k;

location = /ws {
    proxy_pass http://orange-probe:4174;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-Host $host;
    proxy_set_header X-Forwarded-Port $server_port;
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 86400s;
    proxy_send_timeout 86400s;
}

location = /agent-ws {
    proxy_pass http://orange-probe:4174;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-Host $host;
    proxy_set_header X-Forwarded-Port $server_port;
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 86400s;
    proxy_send_timeout 86400s;
}

location / {
    proxy_pass http://orange-probe:4174;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-Host $host;
    proxy_set_header X-Forwarded-Port $server_port;
    proxy_buffering off;
    proxy_cache off;
    proxy_connect_timeout 10s;
    proxy_read_timeout 75s;
    proxy_send_timeout 75s;
}
```

相同配置已经保存在 `deploy/openresty/1panel-orange-probe.locations.conf.example`。

在 1Panel 中点击“保存”。如果界面提供“配置检测”或“重载”，先检测通过再重载 OpenResty。

不要同时保留两份 `location /`。不要在 `/ws` 或 `/agent-ws` 上开启缓存、响应压缩代理缓存或短连接超时。

## 5. 配置 HTTPS

1. 进入网站的“HTTPS”或“证书”设置。
2. 选择已有证书，或通过 ACME/Let's Encrypt 申请证书。
3. 开启 HTTPS。
4. 开启 HTTP 自动跳转 HTTPS。
5. 可开启 HTTP/2；不要启用会中断 WebSocket 的特殊缓存规则。

验证：

```bash
curl -fsS https://probe.example.com/api/health
curl -I https://probe.example.com/downloads/agent/package.json
```

第一条应返回健康 JSON，第二条应返回 200。

## 6. 在 Orange Probe 后台启用反代模式

1. 打开 `https://probe.example.com/admin`。
2. 进入“监控设置”。
3. 域名填写 `https://probe.example.com`，不要附加 `/admin` 或其他路径。
4. 启用反向代理模式并保存。
5. 重新打开 Agent 安装命令。

命令中应出现：

```text
PROBE_SERVER_URL=https://probe.example.com
PROBE_TRANSPORT=ws
PROBE_WS_URL=wss://probe.example.com/agent-ws
```

## 7. 验证真实 IP 与防火墙

Orange Probe 会先检查与它直接建立连接的上游地址。只有这个地址命中 `TRUST_PROXY` 时，应用才会读取 `X-Forwarded-For`；没有该请求头时才回退到 `X-Real-IP`。来自非可信连接的同名请求头会被忽略，避免访客伪造 IP 绕过封禁。

默认值为：

```env
TRUST_PROXY=loopback, linklocal, uniquelocal
```

这适用于 Orange Probe 与 OpenResty 位于同一主机或 Docker 私网的情况。`docker-compose.yml` 会读取 `.env` 中的该值。如果 OpenResty 前还有其他固定代理，按实际地址追加其 IP 或 CIDR，例如：

```env
TRUST_PROXY=loopback, linklocal, uniquelocal, 203.0.113.0/24, 2001:db8:1234::/48
```

只能加入你控制或确认可信的代理范围，禁止填写 `0.0.0.0/0`、`::/0` 或不受控的公网网段。修改后运行 `docker compose up -d --force-recreate orange-probe`。

登录后台“防火墙”页面，检查“当前访问 IP”及括号内的识别来源。这里必须显示管理员真实公网 IP，不能是：

- `127.0.0.1`
- OpenResty 容器 IP
- Docker 网关 IP
- 上游代理出口 IP

显示正确后，再使用一个不会影响自己的测试 IP 执行手动封禁。被封禁地址访问域名时应看到：

```text
你的 IP 已被封禁，禁止访问！
```

页面还会显示访问者 IP。

如果真实 IP 不正确，不要测试五次错误登录，否则可能封禁代理地址，导致所有访问者一起被拦截。先确认 `/`、`/ws` 和 `/agent-ws` 三个反代块都设置了相同的 `X-Real-IP` 与 `X-Forwarded-For`，再核对 `TRUST_PROXY` 是否只包含实际代理链。

封禁生效后，该 IP 对主页、服务器详情、后台、API、Agent 下载以及两个 WebSocket 入口的访问都会返回 403。HTML 页面会直接显示封禁提示和识别出的访问者 IP。

## 8. 常见问题

### 502 Bad Gateway

进入 OpenResty 容器测试：

```bash
docker exec 1Panel-openresty-xxxx \
  curl -v http://orange-probe:4174/api/health
```

无法解析 `orange-probe`：两个容器没有加入同一网络，或 Orange Probe 容器名不同。

连接被拒绝：Orange Probe 未启动、端口不是 4174，或者容器正在反复重启。

### 页面正常但实时数据不刷新

检查浏览器开发者工具中的 `/ws`。OpenResty 配置必须包含：

```nginx
proxy_http_version 1.1;
proxy_set_header Upgrade $http_upgrade;
proxy_set_header Connection "upgrade";
```

### Agent 无法 WSS 上线

检查 `/agent-ws` 是否使用完全相同的 WebSocket 请求头，并确认后台公开域名是 HTTPS。证书链错误、上游缓存 `/agent-ws`、OpenResty 超时过短都会导致连接失败。

### 错误封禁了自己的 IP

优先从另一个未封禁 IP 登录后台解除。如果已经无法从任何地址进入，可以备份并清空命名卷中的防火墙规则，然后重启：

```bash
docker run --rm \
  -v orange-probe-data:/data \
  alpine sh -c 'cp /data/firewall.json /data/firewall.json.bak && printf "[]\n" > /data/firewall.json'

docker restart orange-probe
```

该操作会解除全部 IP 封禁，并保留 `firewall.json.bak` 备份。

## 9. 最终检查

- `https://probe.example.com` 可以打开公开主页。
- `https://probe.example.com/admin` 可以登录。
- 防火墙页面显示真实公网 IP。
- 浏览器 `/ws` 保持连接。
- Agent 使用 `wss://probe.example.com/agent-ws` 上线。
- 4174 没有向公网开放。
- 1Panel/OpenResty 中没有给 `/ws` 和 `/agent-ws` 启用缓存。
