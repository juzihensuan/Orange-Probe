import { Ban, Plus, RefreshCw, ShieldBan, ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

interface FirewallEntry {
  ip: string;
  reason: string;
  source: "automatic" | "manual";
  failedAttempts: number;
  blockedAt: number;
}

interface FirewallPayload {
  currentIp: string;
  currentIpSource: "socket" | "x-forwarded-for" | "x-real-ip" | "visitor-header" | "unavailable";
  blocked: FirewallEntry[];
}

const ipSourceLabels: Record<FirewallPayload["currentIpSource"], string> = {
  socket: "直连地址",
  "x-forwarded-for": "可信代理链",
  "x-real-ip": "可信代理地址",
  "visitor-header": "最终访问者",
  unavailable: "无法识别",
};

function blockedTime(timestamp: number) {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(timestamp);
}

export default function FirewallManagement({ onUnauthorized }: { onUnauthorized: () => void }) {
  const [payload, setPayload] = useState<FirewallPayload>({ currentIp: "", currentIpSource: "unavailable", blocked: [] });
  const [ip, setIp] = useState("");
  const [reason, setReason] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [busyIp, setBusyIp] = useState("");
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/admin/firewall");
      if (response.status === 401) return onUnauthorized();
      const result = await response.json().catch(() => ({})) as FirewallPayload & { error?: string };
      if (!response.ok) throw new Error(result.error || "无法读取防火墙规则");
      setPayload(result);
      setMessage(null);
    } catch (error) {
      setMessage({ ok: false, text: error instanceof Error ? error.message : "无法读取防火墙规则" });
    } finally {
      setLoading(false);
    }
  }, [onUnauthorized]);

  useEffect(() => { load(); }, [load]);

  const automaticCount = useMemo(() => payload.blocked.filter((entry) => entry.source === "automatic").length, [payload.blocked]);

  const add = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setMessage(null);
    try {
      const response = await fetch("/api/admin/firewall", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ip, reason }),
      });
      const result = await response.json().catch(() => ({})) as FirewallEntry & { error?: string };
      if (!response.ok) throw new Error(result.error || "封禁失败");
      setPayload((current) => ({ ...current, blocked: [result, ...current.blocked] }));
      setIp("");
      setReason("");
      setMessage({ ok: true, text: `${result.ip} 已加入封禁列表` });
    } catch (error) {
      setMessage({ ok: false, text: error instanceof Error ? error.message : "封禁失败" });
    } finally {
      setSaving(false);
    }
  };

  const unblock = async (entry: FirewallEntry) => {
    setBusyIp(entry.ip);
    setMessage(null);
    try {
      const response = await fetch(`/api/admin/firewall/${encodeURIComponent(entry.ip)}`, { method: "DELETE" });
      const result = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) throw new Error(result.error || "解除封禁失败");
      setPayload((current) => ({ ...current, blocked: current.blocked.filter((item) => item.ip !== entry.ip) }));
      setMessage({ ok: true, text: `${entry.ip} 已解除封禁` });
    } catch (error) {
      setMessage({ ok: false, text: error instanceof Error ? error.message : "解除封禁失败" });
    } finally {
      setBusyIp("");
    }
  };

  return (
    <div className="page-stack firewall-page">
      <section className="management-summary firewall-summary">
        <span><ShieldBan size={20} /></span>
        <div><b>{payload.blocked.length} 个封禁 IP</b><small>自动封禁 {automaticCount} 个 · 手动封禁 {payload.blocked.length - automaticCount} 个 · 当前访问 IP {payload.currentIp || "--"}（{ipSourceLabels[payload.currentIpSource] || "无法识别"}）</small></div>
        <button className="secondary-button" onClick={load} disabled={loading}>{loading ? <RefreshCw className="spin" size={14} /> : <RefreshCw size={14} />}刷新</button>
      </section>

      <section className="firewall-ban-panel">
        <div className="firewall-panel-heading"><span><Ban size={18} /></span><div><b>手动封禁 IP</b><small>支持单个 IPv4 或 IPv6 地址</small></div></div>
        <form className="firewall-ban-form" onSubmit={add}>
          <label><span>IP 地址</span><input value={ip} onChange={(event) => setIp(event.target.value)} placeholder="例如：203.0.113.10" required /></label>
          <label><span>封禁原因</span><input value={reason} onChange={(event) => setReason(event.target.value)} maxLength={240} placeholder="管理员手动封禁" /></label>
          <button className="danger-button" disabled={saving || !ip.trim()}>{saving ? <RefreshCw className="spin" size={15} /> : <Plus size={15} />}封禁 IP</button>
        </form>
        {message && <div className={`firewall-message ${message.ok ? "success" : "failed"}`}>{message.text}</div>}
      </section>

      <section className="management-table-panel firewall-table-panel">
        <div className="management-table-scroll">
          <table className="management-table firewall-table">
            <thead><tr><th>IP 地址</th><th>来源</th><th>封禁原因</th><th>错误次数</th><th>封禁时间</th><th>操作</th></tr></thead>
            <tbody>{payload.blocked.map((entry) => (
              <tr key={entry.ip}>
                <td><code className="firewall-ip">{entry.ip}</code></td>
                <td><span className={`firewall-source ${entry.source}`}>{entry.source === "automatic" ? "自动封禁" : "手动封禁"}</span></td>
                <td><span className="firewall-reason">{entry.reason}</span></td>
                <td>{entry.failedAttempts || "--"}</td>
                <td><span className="firewall-time">{blockedTime(entry.blockedAt)}</span></td>
                <td><button className="firewall-unblock-button" onClick={() => unblock(entry)} disabled={busyIp === entry.ip}>{busyIp === entry.ip ? <RefreshCw className="spin" size={14} /> : <ShieldCheck size={14} />}解除封禁</button></td>
              </tr>
            ))}</tbody>
          </table>
        </div>
        {!loading && payload.blocked.length === 0 && <div className="management-empty"><ShieldCheck size={24} /><b>暂无被封禁的 IP</b><span>登录失败达到 5 次的地址会自动显示在这里</span></div>}
      </section>
    </div>
  );
}
