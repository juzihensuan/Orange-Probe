import { AlertTriangle, Check, Edit3, RefreshCw, Server, TerminalSquare, Trash2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { formatBytes, formatUptime } from "../lib/format";
import type { BillingCycle, ServerMetric } from "../types";
import { StatusDot } from "./ServerUI";
import RegionFlag from "./RegionFlag";
import { AgentInstallModal } from "./Modals";
import SelectMenu from "./SelectMenu";

interface ServerEditorProps {
  server: ServerMetric;
  onClose: () => void;
  onSaved: () => void;
}

const billingCycleOptions: Array<{ value: BillingCycle; label: string }> = [
  { value: "monthly", label: "月付" },
  { value: "quarterly", label: "季付" },
  { value: "semiannual", label: "半年付" },
  { value: "annual", label: "年付" },
  { value: "biennial", label: "两年付" },
  { value: "triennial", label: "三年付" },
  { value: "one-time", label: "一次性" },
  { value: "custom", label: "自定义" },
];

function billingCycleLabel(server: ServerMetric) {
  if (server.billingCycle === "custom") return server.customBillingCycle || "自定义";
  return billingCycleOptions.find((option) => option.value === server.billingCycle)?.label || "未设置周期";
}

function cycleEndLabel(timestamp?: number) {
  if (!timestamp) return "设置购买日期与到期时间后计算";
  return `${new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" }).format(timestamp)} 周期截止`;
}

function ServerEditor({ server, onClose, onSaved }: ServerEditorProps) {
  const initialTrafficUnit = (server.trafficLimitBytes || 0) >= 1024 ** 4 ? "TB" : "GB";
  const initialTrafficDivisor = initialTrafficUnit === "TB" ? 1024 ** 4 : 1024 ** 3;
  const [form, setForm] = useState({
    name: server.name,
    displayIndex: server.displayIndex || 0,
    group: server.group || "",
    price: server.price || "",
    billingCycle: server.billingCycle || "monthly" as BillingCycle,
    customBillingCycle: server.customBillingCycle || "",
    purchaseDate: server.purchaseDate || "",
    expirationDate: server.expirationDate || "",
    autoRenew: Boolean(server.autoRenew),
    renewalUrl: server.renewalUrl || "",
    renewalNotify: Boolean(server.renewalNotify),
    renewalNoticeDays: server.renewalNoticeDays ?? 7,
    trafficLimitValue: server.trafficLimitBytes ? Number((server.trafficLimitBytes / initialTrafficDivisor).toFixed(2)) : 0,
    trafficLimitUnit: initialTrafficUnit as "GB" | "TB",
    trafficNotify: Boolean(server.trafficNotify),
    trafficNotifyPercent: server.trafficNotifyPercent ?? 80,
    hideForGuest: Boolean(server.hideForGuest),
    privateNote: server.privateNote || "",
    publicNote: server.publicNote || "",
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const save = async () => {
    if (form.billingCycle === "custom" && !form.customBillingCycle.trim()) {
      setError("请填写自定义计费周期名称");
      return;
    }
    setSaving(true);
    setError("");
    try {
      const response = await fetch(`/api/admin/servers/${encodeURIComponent(server.id)}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...form, trafficLimitBytes: Math.max(0, Math.round(form.trafficLimitValue * (form.trafficLimitUnit === "TB" ? 1024 ** 4 : 1024 ** 3))) }),
      });
      if (!response.ok) throw new Error((await response.json().catch(() => ({})) as { error?: string }).error || "保存失败");
      onSaved();
      onClose();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "保存失败");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-layer manage-modal-layer" role="dialog" aria-modal="true" aria-label="节点设置">
      <button className="modal-scrim" onClick={onClose} aria-label="关闭" />
      <div className="manage-modal node-editor-modal">
        <div className="manage-modal-head"><span><Server size={19} /></span><div><h2>节点设置</h2><p>{server.id}</p></div><button onClick={onClose} title="关闭"><X size={18} /></button></div>
        <div className="manage-form server-manage-form">
          <label><span>节点名称</span><input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} /></label>
          <label><span>排序权重</span><input type="number" value={form.displayIndex} onChange={(event) => setForm({ ...form, displayIndex: Number(event.target.value) })} /></label>
          <label><span>节点分组</span><input value={form.group} onChange={(event) => setForm({ ...form, group: event.target.value })} placeholder="例如：香港、生产环境" /></label>
          <label><span>价格</span><input value={form.price} onChange={(event) => setForm({ ...form, price: event.target.value })} placeholder="例如：HK$ 48.00" /></label>
          <div className="manage-field"><span>计费周期</span><SelectMenu label="计费周期" value={form.billingCycle} options={billingCycleOptions} onChange={(billingCycle) => setForm({ ...form, billingCycle })} /></div>
          {form.billingCycle === "custom" && <label><span>自定义周期名称</span><input value={form.customBillingCycle} onChange={(event) => setForm({ ...form, customBillingCycle: event.target.value })} placeholder="例如：每 45 天、18 个月" /></label>}
          <label><span>购买日期</span><input type="date" value={form.purchaseDate} onChange={(event) => setForm({ ...form, purchaseDate: event.target.value })} /></label>
          <label><span>到期时间</span><input type="date" value={form.expirationDate} onChange={(event) => setForm({ ...form, expirationDate: event.target.value })} /></label>
          <label><span>提前通知天数</span><input type="number" min="0" max="365" value={form.renewalNoticeDays} disabled={!form.renewalNotify} onChange={(event) => setForm({ ...form, renewalNoticeDays: Number(event.target.value) })} /></label>
          <label className="wide"><span>续费 URL</span><input type="url" value={form.renewalUrl} onChange={(event) => setForm({ ...form, renewalUrl: event.target.value })} placeholder="https://provider.example.com/renew" /></label>
          <label><span>可用流量</span><input type="number" min="0" step="0.01" value={form.trafficLimitValue} onChange={(event) => setForm({ ...form, trafficLimitValue: Number(event.target.value) })} /></label>
          <div className="manage-field"><span>流量单位</span><SelectMenu label="流量单位" value={form.trafficLimitUnit} options={[{ value: "GB", label: "GB" }, { value: "TB", label: "TB" }]} onChange={(trafficLimitUnit) => setForm({ ...form, trafficLimitUnit })} /></div>
          <label><span>流量通知阈值</span><input type="number" min="1" max="100" value={form.trafficNotifyPercent} disabled={!form.trafficNotify} onChange={(event) => setForm({ ...form, trafficNotifyPercent: Number(event.target.value) })} /></label>
          <label className="wide"><span>私有备注</span><textarea value={form.privateNote} onChange={(event) => setForm({ ...form, privateNote: event.target.value })} placeholder="仅后台管理员可见" /></label>
          <label className="wide"><span>公开备注</span><textarea value={form.publicNote} onChange={(event) => setForm({ ...form, publicNote: event.target.value })} placeholder="会显示在公开节点详情页，请勿填写敏感信息" /></label>
          <div className="manage-switch-row wide">
            <label><input type="checkbox" checked={form.autoRenew} onChange={(event) => setForm({ ...form, autoRenew: event.target.checked })} /><span><b>自动续费</b><small>记录服务商是否会自动扣费续期</small></span></label>
            <label><input type="checkbox" checked={form.renewalNotify} onChange={(event) => setForm({ ...form, renewalNotify: event.target.checked })} /><span><b>续费提前通知</b><small>到期前按设置天数发送 Telegram 通知</small></span></label>
            <label><input type="checkbox" checked={form.trafficNotify} onChange={(event) => setForm({ ...form, trafficNotify: event.target.checked })} /><span><b>流量阈值通知</b><small>达到节点阈值后发送 Telegram 通知</small></span></label>
            <label><input type="checkbox" checked={form.hideForGuest} onChange={(event) => setForm({ ...form, hideForGuest: event.target.checked })} /><span><b>对游客隐藏</b><small>公开主页和详情接口不展示此节点</small></span></label>
          </div>
          {error && <p className="manage-error wide">{error}</p>}
        </div>
        <div className="manage-modal-actions"><button className="secondary-button" onClick={onClose}>取消</button><button className="primary-button" onClick={save} disabled={saving}>{saving ? <RefreshCw className="spin" size={15} /> : <Check size={15} />}保存设置</button></div>
      </div>
    </div>
  );
}

function DeleteAgentModal({ server, deleting, error, onClose, onConfirm }: { server: ServerMetric; deleting: boolean; error: string; onClose: () => void; onConfirm: () => void }) {
  const description = server.source === "local"
    ? "将停止管理端内置采集，并删除节点配置、安装命令、流量记录和历史采样。删除状态会持久保存，节点不会被采集任务自动创建回来。"
    : "将同时删除节点配置、安装命令、流量记录和历史采样。原 TOKEN 随即失效，后续需要重新添加 Agent。";
  return <div className="modal-layer manage-modal-layer" role="dialog" aria-modal="true" aria-label={`删除 ${server.name}`}><button className="modal-scrim" onClick={deleting ? undefined : onClose} aria-label="关闭" /><div className="manage-modal confirm-modal danger-confirm-modal"><div className="manage-modal-head"><span><AlertTriangle size={19} /></span><div><h2>删除节点</h2><p>{server.name} · {server.id}</p></div><button onClick={onClose} disabled={deleting} title="关闭"><X size={18} /></button></div><div className="confirm-modal-body"><div className="confirm-warning-icon"><Trash2 size={24} /></div><span><b>确定删除“{server.name}”吗？</b><p>{description}</p></span></div>{error && <p className="manage-error confirm-error">{error}</p>}<div className="manage-modal-actions"><button className="secondary-button" onClick={onClose} disabled={deleting}>取消</button><button className="danger-button" onClick={onConfirm} disabled={deleting}>{deleting ? <RefreshCw className="spin" size={15} /> : <Trash2 size={15} />}确认删除</button></div></div></div>;
}

export default function ServerManagement({ servers, onRefresh }: { servers: ServerMetric[]; onRefresh: () => Promise<void> }) {
  const [editing, setEditing] = useState<ServerMetric | null>(null);
  const [installAgent, setInstallAgent] = useState<ServerMetric | null>(null);
  const [deletingServer, setDeletingServer] = useState<ServerMetric | null>(null);
  const [busyId, setBusyId] = useState("");
  const [deleteError, setDeleteError] = useState("");

  useEffect(() => {
    if (editing && !servers.some((server) => server.id === editing.id)) setEditing(null);
    if (installAgent && !servers.some((server) => server.id === installAgent.id)) setInstallAgent(null);
    if (deletingServer && !servers.some((server) => server.id === deletingServer.id)) setDeletingServer(null);
  }, [servers, editing, installAgent, deletingServer]);

  const remove = async (server: ServerMetric) => {
    setBusyId(server.id);
    setDeleteError("");
    try {
      const response = await fetch(`/api/admin/servers/${encodeURIComponent(server.id)}`, { method: "DELETE" });
      if (!response.ok) throw new Error((await response.json().catch(() => ({})) as { error?: string }).error || "删除失败");
      if (editing?.id === server.id) setEditing(null);
      if (installAgent?.id === server.id) setInstallAgent(null);
      setDeletingServer(null);
      await onRefresh();
    } catch (removeError) {
      setDeleteError(removeError instanceof Error ? removeError.message : "删除失败");
    } finally {
      setBusyId("");
    }
  };

  return (
    <div className="page-stack">
      <section className="management-summary"><span><Server size={20} /></span><div><b>{servers.length} 个节点</b><small>管理在线状态、流量配额、计费信息、到期时间与通知</small></div><button className="secondary-button" onClick={() => onRefresh()}><RefreshCw size={14} />刷新</button></section>
      <section className="management-table-panel">
        <div className="management-table-scroll">
          <table className="management-table server-management-table node-management-table">
            <thead><tr><th>节点名称</th><th>IP</th><th>在线状态</th><th>在线时长</th><th>剩余时间</th><th>本期流量</th><th>版本</th><th>设置</th></tr></thead>
            <tbody>{servers.length ? servers.map((server) => (
              <tr key={server.id}>
                <td><span className="management-server-name"><RegionFlag location={server.location} countryCode={server.countryCode} className="management-region-flag" /><span><b>{server.name}</b><small>{server.id}</small></span></span></td>
                <td><span className="management-stack"><b>{server.ip}</b><small className="management-country-flag"><RegionFlag location={server.location} countryCode={server.countryCode} /></small></span></td>
                <td><span className={`status-badge ${server.status}`}><StatusDot status={server.status} />{server.status === "online" ? "在线" : "离线"}</span></td>
                <td>{server.status === "online" ? formatUptime(server.uptime) : "--"}</td>
                <td><span className="remaining-time-cell"><span><b>{!server.purchaseDate ? "未设置" : !server.serviceCycleEnd ? "缺少到期时间" : (server.serviceRemainingSeconds || 0) <= 0 ? "已到期" : formatUptime(server.serviceRemainingSeconds || 0)}</b><small>{billingCycleLabel(server)}</small></span><small>{cycleEndLabel(server.serviceCycleEnd)}</small><i><em className={(server.serviceCyclePercent || 0) >= 100 ? "danger" : (server.serviceCyclePercent || 0) >= 80 ? "warning" : "healthy"} style={{ width: `${Math.min(100, server.serviceCyclePercent || 0)}%` }} /></i></span></td>
                <td><span className="traffic-quota-cell"><span><b>{formatBytes(server.trafficUsed || 0)} / {server.trafficLimitBytes ? formatBytes(server.trafficLimitBytes) : "未设置"}</b><small>{server.trafficWindowEnd ? `${new Date(server.trafficWindowEnd).getUTCDate()} 日重置` : "每月重置"}</small></span><span className="traffic-direction-values"><small>上传 {formatBytes(server.trafficUploadUsed || 0)}</small><small>下载 {formatBytes(server.trafficDownloadUsed || 0)}</small></span><i><em className={(server.trafficPercent || 0) >= 100 ? "danger" : (server.trafficPercent || 0) >= 80 ? "warning" : "healthy"} style={{ width: `${server.trafficLimitBytes ? Math.min(100, server.trafficPercent || 0) : 0}%` }} /></i></span></td>
                <td><span className="management-stack"><b>{server.version}</b><small>{server.os}</small></span></td>
                <td><span className="management-actions"><button onClick={() => setInstallAgent(server)} title="复制安装命令"><TerminalSquare size={15} /></button><button onClick={() => setEditing(server)} title="节点设置"><Edit3 size={15} /></button><button className="danger" onClick={() => { setDeleteError(""); setDeletingServer(server); }} disabled={busyId === server.id} title="删除节点">{busyId === server.id ? <RefreshCw className="spin" size={14} /> : <Trash2 size={15} />}</button></span></td>
              </tr>
            )) : <tr><td colSpan={8}><div className="management-empty"><Server size={24} /><b>没有匹配的节点</b><span>请调整顶部搜索关键词</span></div></td></tr>}</tbody>
          </table>
        </div>
      </section>
      {editing && <ServerEditor key={editing.id} server={editing} onClose={() => setEditing(null)} onSaved={() => onRefresh()} />}
      {installAgent && <AgentInstallModal agent={installAgent} onClose={() => setInstallAgent(null)} />}
      {deletingServer && <DeleteAgentModal server={deletingServer} deleting={busyId === deletingServer.id} error={deleteError} onClose={() => setDeletingServer(null)} onConfirm={() => remove(deletingServer)} />}
    </div>
  );
}
