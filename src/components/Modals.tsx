import {
  ArrowDown,
  ArrowUp,
  Check,
  CircleCheck,
  CircleX,
  Clipboard,
  Clock3,
  Copy,
  ExternalLink,
  KeyRound,
  LoaderCircle,
  MapPin,
  Radio,
  RefreshCw,
  Server,
  TerminalSquare,
  X,
} from "lucide-react";
import { useEffect, useState } from "react";
import type { HistoryPoint, ServerMetric } from "../types";
import { formatRelativeTime, formatSpeed, formatUptime } from "../lib/format";
import { ResourceChart, TrafficChart } from "./Charts";
import { DetailMetricGrid, StatusDot } from "./ServerUI";

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  };
  return (
    <button className="icon-button code-copy" onClick={copy} title="复制命令">
      {copied ? <Check size={16} /> : <Copy size={16} />}
    </button>
  );
}

interface AgentCommandInfo {
  id: string;
  name: string;
  token: string;
  transport?: "http" | "ws";
  serverUrl?: string;
  wsUrl?: string;
}

interface AgentStatusInfo {
  online: boolean;
  status: "online" | "offline";
  lastSeen: number;
  ip: string;
  version: string;
}

function agentCommand(host: string, system: "linux" | "windows", agent: AgentCommandInfo) {
  const serverUrl = agent.serverUrl || host;
  const useWebSocket = agent.transport === "ws" && agent.wsUrl;
  if (system === "windows") {
    const quote = (value: string) => `'${value.replace(/'/g, "''")}'`;
    const installerUrl = new URL("/downloads/agent/install-windows.ps1", serverUrl).toString();
    return `$installer=Join-Path $env:TEMP 'orange-probe-agent-install.ps1'; Invoke-WebRequest -UseBasicParsing -Uri ${quote(installerUrl)} -OutFile $installer; powershell.exe -NoProfile -ExecutionPolicy Bypass -File $installer -ServerUrl ${quote(serverUrl)} -Transport ${quote(useWebSocket ? "ws" : "http")} -WsUrl ${quote(useWebSocket ? agent.wsUrl || "" : "")} -Token ${quote(agent.token)} -Name ${quote(agent.name)} -AgentId ${quote(agent.id)}`;
  }
  const quote = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`;
  const installerUrl = new URL("/downloads/agent/install-linux.sh", serverUrl).toString();
  return `if [ \"\$(id -u)\" -eq 0 ]; then elevate=''; elif command -v sudo >/dev/null 2>&1; then elevate='sudo'; else echo 'sudo or root privileges are required' >&2; exit 1; fi; if ! command -v curl >/dev/null 2>&1; then if command -v apt-get >/dev/null 2>&1; then \$elevate apt-get update && \$elevate apt-get install -y curl ca-certificates; elif command -v dnf >/dev/null 2>&1; then \$elevate dnf install -y curl ca-certificates; elif command -v yum >/dev/null 2>&1; then \$elevate yum install -y curl ca-certificates; elif command -v apk >/dev/null 2>&1; then \$elevate apk add --no-cache curl ca-certificates; elif command -v pacman >/dev/null 2>&1; then \$elevate pacman -Sy --noconfirm curl ca-certificates; else echo 'Cannot install curl automatically' >&2; exit 1; fi; fi; installer=\$(mktemp); curl -fsSL ${quote(installerUrl)} -o \"\$installer\"; PROBE_SERVER_URL=${quote(serverUrl)} PROBE_TRANSPORT=${quote(useWebSocket ? "ws" : "http")} PROBE_WS_URL=${quote(useWebSocket ? agent.wsUrl || "" : "")} PROBE_TOKEN=${quote(agent.token)} PROBE_NAME=${quote(agent.name)} PROBE_AGENT_ID=${quote(agent.id)} bash \"\$installer\"; status=\$?; rm -f \"\$installer\"; [ \"\$status\" -eq 0 ]`;
}

function AgentCommandView({ agent }: { agent: AgentCommandInfo }) {
  const [system, setSystem] = useState<"linux" | "windows">("linux");
  const [copied, setCopied] = useState(false);
  const [checking, setChecking] = useState(false);
  const [status, setStatus] = useState<AgentStatusInfo | null>(null);
  const [statusError, setStatusError] = useState("");
  const host = window.location.origin.replace(":5173", ":4174");
  const command = agentCommand(host, system, agent);

  const checkStatus = async (showLoading = true) => {
    if (showLoading) setChecking(true);
    try {
      const response = await fetch(`/api/admin/agents/${encodeURIComponent(agent.id)}/status`);
      const payload = await response.json().catch(() => ({})) as AgentStatusInfo & { error?: string };
      if (!response.ok) throw new Error(payload.error || "无法检测 Agent 状态");
      setStatus(payload);
      setStatusError("");
    } catch (checkError) {
      setStatusError(checkError instanceof Error ? checkError.message : "无法检测 Agent 状态");
    } finally {
      if (showLoading) setChecking(false);
    }
  };

  useEffect(() => {
    checkStatus(false);
    const timer = window.setInterval(() => checkStatus(false), 3000);
    return () => window.clearInterval(timer);
  }, [agent.id]);

  const copyCommand = async () => {
    await navigator.clipboard.writeText(command);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  };

  return <div className="install-steps agent-command-view">
    <div className={`install-created ${status?.online ? "online" : "waiting"}`}>{status?.online ? <CircleCheck size={18} /> : <Radio size={18} />}<span><strong>{agent.name}</strong><small>{agent.id} · {status?.online ? `Agent 在线 · ${status.ip} · v${status.version}` : "等待 Agent 首次上报"}</small></span></div>
    <div className="step-row"><b>01</b><span><strong>选择目标系统</strong><small>安装器会检测并自动补齐 curl、Node.js 20+ 与 npm</small></span></div>
    <div className="segmented install-system"><button className={system === "linux" ? "active" : ""} onClick={() => setSystem("linux")}>Linux</button><button className={system === "windows" ? "active" : ""} onClick={() => setSystem("windows")}>Windows</button></div>
    <div className="step-row"><b>02</b><span><strong>安装并注册后台服务</strong><small>Linux 使用 systemd，Windows 使用系统计划任务；关闭 SSH 后仍会运行</small></span></div>
    <div className="code-block"><code>{command}</code><CopyButton value={command} /></div>
    <div className="agent-command-actions"><button className="primary-button" onClick={copyCommand}>{copied ? <Check size={15} /> : <Copy size={15} />}{copied ? "已复制安装命令" : "复制安装命令"}</button><button className="secondary-button" onClick={() => checkStatus()} disabled={checking}>{checking ? <RefreshCw className="spin" size={15} /> : status?.online ? <CircleCheck size={15} /> : <Radio size={15} />}检测 Agent 状态</button></div>
    <div className={`agent-detection ${status?.online ? "online" : statusError ? "failed" : "waiting"}`}>{status?.online ? <CircleCheck size={17} /> : statusError ? <CircleX size={17} /> : <Radio size={17} />}<span><b>{status?.online ? "Agent 已在线" : statusError ? "检测失败" : "Agent 暂未在线"}</b><small>{status?.online ? `最后上报 ${formatRelativeTime(status.lastSeen)}，安装与鉴权均正常` : statusError || "启动命令后可点击检测，系统也会每 3 秒自动检查"}</small></span></div>
    <div className="install-note"><Radio size={16} /><span>安装命令包含该 Agent 独有的 TOKEN。服务端会加密保存，因此后续可以在节点管理中重新复制。</span></div>
  </div>;
}

export function InstallModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => Promise<void> }) {
  const [name, setName] = useState("");
  const [token, setToken] = useState<string>(() => crypto.randomUUID());
  const [created, setCreated] = useState<AgentCommandInfo | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const register = async () => {
    setSaving(true);
    setError("");
    try {
      const response = await fetch("/api/admin/agents", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, token }) });
      const payload = await response.json().catch(() => ({})) as Partial<AgentCommandInfo> & { error?: string };
      if (!response.ok || !payload.id || !payload.token) throw new Error(payload.error || "Agent 创建失败");
      setCreated({ id: payload.id, name: payload.name || name, token: payload.token, transport: payload.transport, serverUrl: payload.serverUrl, wsUrl: payload.wsUrl });
      await onCreated();
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : "Agent 创建失败");
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="modal-layer" role="dialog" aria-modal="true" aria-labelledby="install-title">
      <button className="modal-scrim" onClick={onClose} aria-label="关闭" />
      <div className="modal install-modal">
        <div className="modal-head">
          <span className="modal-title-icon"><TerminalSquare size={20} /></span>
          <div><h2 id="install-title">添加 Agent</h2><p>创建节点身份并生成可重复使用的安装命令</p></div>
          <button className="icon-button" onClick={onClose} title="关闭"><X size={19} /></button>
        </div>
        {!created ? <div className="install-register-form">
          <label><span>Agent 名称</span><input autoFocus maxLength={80} value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：香港 Web 01" /></label>
          <label><span>节点 TOKEN</span><div className="token-input"><KeyRound size={15} /><input maxLength={36} value={token} onChange={(event) => setToken(event.target.value)} /><button type="button" onClick={() => setToken(crypto.randomUUID())} title="自动生成新的 36 位 TOKEN"><RefreshCw size={15} /></button></div><small>每个节点使用独立 TOKEN；可手动填写，也可自动生成。</small></label>
          {error && <p className="manage-error">{error}</p>}
        </div> : <AgentCommandView agent={created} />}
        <div className="modal-actions"><button className="secondary-button" onClick={onClose}>{created ? "稍后处理" : "取消"}</button>{created ? <button className="primary-button" onClick={onClose}>完成</button> : <button className="primary-button" onClick={register} disabled={saving || !name.trim() || token.length !== 36}>{saving ? <RefreshCw className="spin" size={15} /> : <Check size={15} />}创建 Agent</button>}</div>
      </div>
    </div>
  );
}

export function AgentInstallModal({ agent, onClose }: { agent: Pick<ServerMetric, "id" | "name">; onClose: () => void }) {
  const [commandInfo, setCommandInfo] = useState<AgentCommandInfo | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    fetch(`/api/admin/agents/${encodeURIComponent(agent.id)}/install`, { method: "POST" })
      .then(async (response) => {
        const payload = await response.json().catch(() => ({})) as AgentCommandInfo & { error?: string };
        if (!response.ok) throw new Error(payload.error || "无法读取安装命令");
        setCommandInfo(payload);
      })
      .catch((loadError) => setError(loadError instanceof Error ? loadError.message : "无法读取安装命令"));
  }, [agent.id]);
  return <div className="modal-layer" role="dialog" aria-modal="true" aria-label={`${agent.name} 安装命令`}><button className="modal-scrim" onClick={onClose} aria-label="关闭" /><div className="modal install-modal"><div className="modal-head"><span className="modal-title-icon"><TerminalSquare size={20} /></span><div><h2>Agent 安装命令</h2><p>{agent.name} · {agent.id}</p></div><button className="icon-button" onClick={onClose} title="关闭"><X size={19} /></button></div>{commandInfo ? <AgentCommandView agent={commandInfo} /> : <div className="install-command-loading">{error ? <><CircleX size={20} /><b>无法读取安装命令</b><span>{error}</span></> : <><LoaderCircle className="spin" size={20} /><b>正在读取安装命令</b></>}</div>}<div className="modal-actions"><button className="primary-button" onClick={onClose}>完成</button></div></div></div>;
}

export function NodeDrawer({ server, onClose, readOnly = false }: { server: ServerMetric; onClose: () => void; readOnly?: boolean }) {
  const [tab, setTab] = useState<"overview" | "resources" | "network">("overview");
  const [history, setHistory] = useState<HistoryPoint[]>([]);
  const [pinging, setPinging] = useState(false);
  const [latency, setLatency] = useState<number | null | undefined>(undefined);

  useEffect(() => {
    let disposed = false;
    const load = async () => {
      try {
        const response = await fetch(`/api/servers/${encodeURIComponent(server.id)}/history`);
        if (!response.ok) return;
        const payload = await response.json() as { points: HistoryPoint[] };
        if (!disposed) setHistory(payload.points);
      } catch {
        // Live values remain available when the history endpoint is unavailable.
      }
    };
    load();
    const timer = window.setInterval(load, 5000);
    return () => { disposed = true; window.clearInterval(timer); };
  }, [server.id]);

  const ping = async () => {
    setPinging(true);
    try {
      const response = await fetch(`/api/servers/${encodeURIComponent(server.id)}/ping`, { method: "POST" });
      const result = await response.json() as { latency: number | null };
      setLatency(result.latency);
    } finally {
      setPinging(false);
    }
  };

  return (
    <div className="drawer-layer" role="dialog" aria-modal="true" aria-label={`${server.name} 节点详情`}>
      <button className="drawer-scrim" onClick={onClose} aria-label="关闭详情" />
      <aside className="detail-drawer">
        <div className="drawer-head">
          <div className="drawer-server-icon"><Server size={22} /></div>
          <div className="drawer-title"><span><h2>{server.name}</h2><span className={`status-badge ${server.status}`}><StatusDot status={server.status} />{server.status === "online" ? "在线" : "离线"}</span></span><p><MapPin size={13} />{server.location}<i>·</i>{server.ip}</p></div>
          <button className="icon-button" onClick={onClose} title="关闭"><X size={20} /></button>
        </div>
        <div className={`drawer-actions${readOnly ? " read-only" : ""}`}>
          {!readOnly && <button className="secondary-button" onClick={ping} disabled={pinging}>
            {pinging ? <LoaderCircle className="spin" size={15} /> : <RefreshCw size={15} />}
            {latency === undefined ? "连通测试" : latency === null ? "无法连接" : `${latency} ms`}
          </button>}
          <span><Clock3 size={14} />{server.status === "online" ? `已运行 ${formatUptime(server.uptime)}` : `最后上报 ${formatRelativeTime(server.lastSeen)}`}</span>
        </div>
        <div className="drawer-tabs segmented">
          <button className={tab === "overview" ? "active" : ""} onClick={() => setTab("overview")}>概况</button>
          <button className={tab === "resources" ? "active" : ""} onClick={() => setTab("resources")}>资源</button>
          <button className={tab === "network" ? "active" : ""} onClick={() => setTab("network")}>网络</button>
        </div>
        <div className="drawer-body">
          {tab === "overview" && (
            <>
              <DetailMetricGrid server={server} />
              <section className="drawer-section">
                <div className="section-heading compact"><span><h3>系统信息</h3><p>Agent 上报的运行环境</p></span></div>
                <dl className="system-info">
                  <div><dt>操作系统</dt><dd>{server.os}</dd></div><div><dt>架构</dt><dd>{server.arch}</dd></div>
                  <div><dt>处理器</dt><dd>{server.cpuModel}</dd></div><div><dt>核心数</dt><dd>{server.cpuCores} Cores</dd></div>
                  <div><dt>Agent</dt><dd>v{server.version}</dd></div><div><dt>来源</dt><dd>{server.source === "local" ? "管理端本机" : "远程 Agent"}</dd></div>
                </dl>
              </section>
            </>
          )}
          {tab === "resources" && (
            <section className="drawer-section chart-section">
              <div className="section-heading compact"><span><h3>资源使用趋势</h3><p>CPU、内存与磁盘占用</p></span><div className="resource-legend"><span className="cpu">CPU</span><span className="memory">内存</span><span className="disk">磁盘</span></div></div>
              <ResourceChart data={history} height={310} />
            </section>
          )}
          {tab === "network" && (
            <>
              <div className="network-live-cards">
                <div><span><ArrowDown size={16} />实时下载</span><b>{formatSpeed(server.network.downloadSpeed)}</b></div>
                <div><span><ArrowUp size={16} />实时上传</span><b>{formatSpeed(server.network.uploadSpeed)}</b></div>
              </div>
              <section className="drawer-section chart-section">
                <div className="section-heading compact"><span><h3>吞吐趋势</h3><p>节点实时上下行速率</p></span></div>
                <TrafficChart data={history} height={310} />
              </section>
            </>
          )}
        </div>
        <div className="drawer-foot"><span><Clipboard size={14} />节点 ID: {server.id}</span><button className="text-button" onClick={() => window.open(`/api/servers/${encodeURIComponent(server.id)}/history`, "_blank", "noopener,noreferrer")}>查看原始数据 <ExternalLink size={13} /></button></div>
      </aside>
    </div>
  );
}
