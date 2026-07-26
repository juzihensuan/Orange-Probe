import { AlertTriangle, CheckCircle2, CircleDashed, Download, ExternalLink, PackageCheck, RefreshCw, Server, XCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { formatRelativeTime } from "../lib/format";

interface AgentUpdateInfo {
  id: string;
  name: string;
  online: boolean;
  version: string;
  targetVersion: string;
  status: "available" | "current" | "manual" | "pending" | "installing" | "completed" | "failed";
  error: string;
  requestedAt: number;
  updatedAt: number;
  supportsAutoUpdate: boolean;
  updateAvailable: boolean;
}

interface UpdatePayload {
  repository: string;
  server: {
    currentVersion: string;
    latestVersion: string;
    releaseUrl: string;
    publishedAt: string;
    updateAvailable: boolean;
    updaterConfigured: boolean;
    status: string;
    error: string;
    requestedAt: number;
    completedAt: number;
  };
  agents: AgentUpdateInfo[];
}

const statusLabels: Record<AgentUpdateInfo["status"], string> = {
  available: "可更新",
  current: "已是最新",
  manual: "需重新安装",
  pending: "等待 Agent",
  installing: "等待重启确认",
  completed: "更新完成",
  failed: "更新失败",
};

export default function UpdateManagement() {
  const [data, setData] = useState<UpdatePayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState("");
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const load = async () => {
    try {
      const response = await fetch("/api/admin/updates");
      const payload = await response.json().catch(() => ({})) as UpdatePayload & { error?: string };
      if (!response.ok) throw new Error(payload.error || "无法读取更新状态");
      setData(payload);
    } catch (error) {
      setMessage({ ok: false, text: error instanceof Error ? error.message : "无法读取更新状态" });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    const timer = window.setInterval(load, 5000);
    return () => window.clearInterval(timer);
  }, []);

  const request = async (key: string, pathname: string, body: object) => {
    setWorking(key);
    setMessage(null);
    try {
      const response = await fetch(pathname, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const payload = await response.json().catch(() => ({})) as { error?: string; message?: string; queued?: string[]; skipped?: Array<{ reason: string }> };
      if (!response.ok) throw new Error(payload.error || "更新请求失败");
      const queued = payload.queued?.length || 0;
      const skipped = payload.skipped?.length || 0;
      setMessage({ ok: true, text: payload.message || `已提交 ${queued} 个 Agent 更新任务${skipped ? `，跳过 ${skipped} 个` : ""}` });
      await load();
    } catch (error) {
      setMessage({ ok: false, text: error instanceof Error ? error.message : "更新请求失败" });
    } finally {
      setWorking("");
    }
  };

  if (loading && !data) return <div className="management-empty"><RefreshCw className="spin" size={24} /><b>正在检查更新</b><span>读取 GitHub Release 与 Agent 版本</span></div>;
  if (!data) return <div className="management-empty"><XCircle size={24} /><b>无法读取更新状态</b><button className="secondary-button" onClick={load}>重试</button></div>;

  const availableAgents = data.agents.filter((agent) => agent.updateAvailable && !new Set(["pending", "installing"]).has(agent.status)).length;
  return <div className="page-stack update-management">
    <section className="management-summary update-summary"><span><PackageCheck size={20} /></span><div><b>Orange Probe 更新中心</b><small>{data.repository} · 服务端与 Agent 统一版本管理</small></div><button className="secondary-button" onClick={load} disabled={working !== ""}><RefreshCw className={loading ? "spin" : ""} size={15} />检查更新</button></section>
    {message && <div className={`update-message ${message.ok ? "success" : "failed"}`}>{message.ok ? <CheckCircle2 size={16} /> : <AlertTriangle size={16} />}<span>{message.text}</span></div>}
    <section className="update-server-panel">
      <div className="update-panel-heading"><span><Server size={18} /></span><div><b>服务端</b><small>由内部更新容器校验 GitHub Release 并保留数据卷重建</small></div><a href={data.server.releaseUrl} target="_blank" rel="noreferrer">Release <ExternalLink size={13} /></a></div>
      <div className="update-version-row"><span><small>当前版本</small><b>v{data.server.currentVersion}</b></span><i /><span><small>GitHub 最新版本</small><b className={data.server.updateAvailable ? "available" : ""}>v{data.server.latestVersion}</b></span><span className={`update-server-state ${data.server.status}`}>{data.server.updateAvailable ? "发现新版本" : "已是最新版本"}</span><button className="primary-button" disabled={!data.server.updateAvailable || !data.server.updaterConfigured || working !== ""} onClick={() => request("server", "/api/admin/updates/server", {})}>{working === "server" ? <RefreshCw className="spin" size={15} /> : <Download size={15} />}一键更新服务端</button></div>
      {!data.server.updaterConfigured && <p className="update-inline-warning"><AlertTriangle size={14} />当前部署没有连接更新容器，请使用 v1.1.2 或更高版本的 Docker Compose 或一键安装命令部署。</p>}
      {data.server.error && <p className="update-inline-warning"><AlertTriangle size={14} />{data.server.error}</p>}
    </section>
    <section className="management-table-panel update-agent-panel">
      <div className="update-panel-heading"><span><Download size={18} /></span><div><b>Agent 更新</b><small>{data.agents.length} 个 Agent，{availableAgents} 个可更新</small></div><button className="primary-button" disabled={!availableAgents || working !== ""} onClick={() => request("all-agents", "/api/admin/updates/agents", { all: true })}>{working === "all-agents" ? <RefreshCw className="spin" size={14} /> : <Download size={14} />}更新全部 Agent</button></div>
      <div className="management-table-scroll"><table className="management-table update-agent-table"><thead><tr><th>Agent</th><th>当前版本</th><th>目标版本</th><th>状态</th><th>更新时间</th><th>操作</th></tr></thead><tbody>{data.agents.length ? data.agents.map((agent) => { const active = agent.status === "pending" || agent.status === "installing"; return <tr key={agent.id}><td><span className="management-server-name"><i><Server size={15} /></i><span><b>{agent.name}</b><small>{agent.online ? "在线" : "离线"}</small></span></span></td><td><b>v{agent.version}</b></td><td>v{agent.targetVersion}</td><td><span className={`agent-update-status ${agent.status}`}>{active ? <CircleDashed className="spin" size={12} /> : agent.status === "failed" || agent.status === "manual" ? <AlertTriangle size={12} /> : <CheckCircle2 size={12} />}{statusLabels[agent.status]}</span>{agent.error && <small className="agent-update-error">{agent.error}</small>}</td><td>{agent.updatedAt ? formatRelativeTime(agent.updatedAt) : "--"}</td><td><span className="management-actions"><button title={!agent.supportsAutoUpdate ? "请先重新执行安装命令" : active ? "更新任务正在执行" : agent.updateAvailable ? "更新 Agent" : "已是最新版本"} disabled={!agent.supportsAutoUpdate || !agent.updateAvailable || active || working !== ""} onClick={() => request(agent.id, "/api/admin/updates/agents", { agentIds: [agent.id] })}>{working === agent.id ? <RefreshCw className="spin" size={15} /> : <Download size={15} />}</button></span></td></tr>; }) : <tr><td colSpan={6}><div className="management-empty"><Server size={23} /><b>暂无 Agent</b><span>添加 Agent 后可在这里统一更新</span></div></td></tr>}</tbody></table></div>
    </section>
  </div>;
}
