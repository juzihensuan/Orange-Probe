import { Check, Clock3, Edit3, Globe2, Plus, Radio, RefreshCw, Server, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { ServerMetric, ServiceMonitor, ServiceType } from "../types";

const emptyService = {
  name: "",
  type: "icmp" as ServiceType,
  target: "",
  interval: 30,
  displayIndex: 0,
  hideForGuest: false,
  enabled: true,
  notify: false,
  serverIds: [] as string[],
};

function serviceTypeLabel(type: ServiceType) {
  return type === "icmp" ? "ICMP Ping" : type === "tcp" ? "TCPing" : "HTTP GET";
}

function ServiceEditor({ service, servers, onClose, onSaved }: { service: ServiceMonitor | null; servers: ServerMetric[]; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState(service ? { ...service } : { ...emptyService });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const save = async () => {
    setSaving(true);
    setError("");
    try {
      const response = await fetch(service ? `/api/admin/services/${service.id}` : "/api/admin/services", { method: service ? "PUT" : "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(form) });
      if (!response.ok) throw new Error((await response.json().catch(() => ({})) as { error?: string }).error || "保存失败");
      onSaved();
      onClose();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "保存失败");
    } finally {
      setSaving(false);
    }
  };

  const placeholder = form.type === "icmp" ? "1.1.1.1 或 example.com" : form.type === "tcp" ? "example.com:443（端口可省略，默认 80）" : "https://example.com/health";
  return <div className="modal-layer manage-modal-layer" role="dialog" aria-modal="true" aria-label={service ? "编辑服务监控" : "新增服务监控"}><button className="modal-scrim" onClick={onClose} aria-label="关闭" /><div className="manage-modal service-editor-modal"><div className="manage-modal-head"><span><Radio size={19} /></span><div><h2>{service ? "编辑服务监控" : "新增服务监控"}</h2><p>由选定 Agent 定时请求监控目标</p></div><button onClick={onClose} title="关闭"><X size={18} /></button></div><div className="manage-form service-manage-form"><label><span>名称</span><input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="例如：香港到源站" /></label><label><span>类型</span><select value={form.type} onChange={(event) => setForm({ ...form, type: event.target.value as ServiceType, target: "" })}><option value="http">HTTP GET</option><option value="icmp">ICMP Ping</option><option value="tcp">TCPing</option></select></label><label className="wide"><span>目标</span><input value={form.target} onChange={(event) => setForm({ ...form, target: event.target.value })} placeholder={placeholder} /></label><label><span>监控间隔（秒）</span><input type="number" min="5" value={form.interval} onChange={(event) => setForm({ ...form, interval: Number(event.target.value) })} /></label><label><span>排序权重</span><input type="number" value={form.displayIndex} onChange={(event) => setForm({ ...form, displayIndex: Number(event.target.value) })} /></label><fieldset className="service-server-picker wide"><legend>覆盖服务器 <small>不选择表示全部服务器</small></legend><div>{servers.map((server) => <label key={server.id}><input type="checkbox" checked={form.serverIds.includes(server.id)} onChange={(event) => setForm({ ...form, serverIds: event.target.checked ? [...form.serverIds, server.id] : form.serverIds.filter((id) => id !== server.id) })} /><span><b>{server.name}</b><small>{server.location} · {server.status === "online" ? "在线" : "离线"}</small></span></label>)}</div></fieldset><div className="manage-switch-row wide"><label><input type="checkbox" checked={form.enabled} onChange={(event) => setForm({ ...form, enabled: event.target.checked })} /><span><b>启用监控</b><small>关闭后 Agent 不再执行此任务</small></span></label><label><input type="checkbox" checked={form.hideForGuest} onChange={(event) => setForm({ ...form, hideForGuest: event.target.checked })} /><span><b>对游客隐藏</b><small>公开服务器详情不展示此监控</small></span></label><label><input type="checkbox" checked={form.notify} onChange={(event) => setForm({ ...form, notify: event.target.checked })} /><span><b>失败通知</b><small>保留通知策略开关</small></span></label></div>{error && <p className="manage-error wide">{error}</p>}</div><div className="manage-modal-actions"><button className="secondary-button" onClick={onClose}>取消</button><button className="primary-button" onClick={save} disabled={saving}>{saving ? <RefreshCw className="spin" size={15} /> : <Check size={15} />}保存监控</button></div></div></div>;
}

export default function ServiceManagement({ servers, search = "" }: { servers: ServerMetric[]; search?: string }) {
  const [services, setServices] = useState<ServiceMonitor[]>([]);
  const [editing, setEditing] = useState<ServiceMonitor | null | "new">(null);
  const [batchInterval, setBatchInterval] = useState(5);
  const [batchSaving, setBatchSaving] = useState(false);
  const [batchMessage, setBatchMessage] = useState("");
  const visibleServices = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return services;
    return services.filter((service) => [service.name, service.target, serviceTypeLabel(service.type)].some((value) => value.toLowerCase().includes(needle)));
  }, [search, services]);

  const load = async () => {
    const response = await fetch("/api/admin/services");
    if (!response.ok) return;
    setServices((await response.json() as { services: ServiceMonitor[] }).services);
  };
  useEffect(() => { load(); }, []);

  const remove = async (service: ServiceMonitor) => {
    if (!window.confirm(`确定删除服务监控“${service.name}”吗？`)) return;
    await fetch(`/api/admin/services/${service.id}`, { method: "DELETE" });
    await load();
  };
  const applyInterval = async () => {
    setBatchSaving(true);
    setBatchMessage("");
    try {
      const response = await fetch("/api/admin/services/interval", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ interval: batchInterval }) });
      const result = await response.json().catch(() => ({})) as { services?: ServiceMonitor[]; updated?: number; interval?: number; error?: string };
      if (!response.ok || !result.services) throw new Error(result.error || "统一修改间隔失败");
      setServices(result.services);
      setBatchInterval(result.interval || batchInterval);
      setBatchMessage(`已将 ${result.updated || 0} 个监控任务统一修改为 ${result.interval || batchInterval} 秒`);
    } catch (error) {
      setBatchMessage(error instanceof Error ? error.message : "统一修改间隔失败");
    } finally {
      setBatchSaving(false);
    }
  };

  return <div className="page-stack"><section className="management-summary service-management-summary"><span><Radio size={20} /></span><div><b>{services.length} 个服务监控</b><small>HTTP GET、ICMP Ping 与 TCPing，由覆盖范围内的 Agent 执行</small></div><div className="service-management-toolbar"><label><Clock3 size={14} /><input type="number" min="5" max="86400" value={batchInterval} onChange={(event) => setBatchInterval(Number(event.target.value))} /><em>秒</em></label><button className="secondary-button" onClick={applyInterval} disabled={batchSaving || !services.length || batchInterval < 5}>{batchSaving ? <RefreshCw className="spin" size={14} /> : <Check size={14} />}应用到全部</button><button className="primary-button" onClick={() => setEditing("new")}><Plus size={15} />新增监控</button></div></section>{batchMessage && <div className="service-batch-message"><Clock3 size={15} />{batchMessage}<button onClick={() => setBatchMessage("")}><X size={14} /></button></div>}<section className="management-table-panel"><div className="management-table-scroll"><table className="management-table service-management-table"><thead><tr><th>监控</th><th>类型</th><th>目标</th><th>间隔 / 排序</th><th>覆盖</th><th>游客可见</th><th>操作</th></tr></thead><tbody>{visibleServices.length ? visibleServices.map((service) => <tr key={service.id}><td><span className="management-server-name"><i>{service.type === "http" ? <Globe2 size={16} /> : service.type === "tcp" ? <Server size={16} /> : <Radio size={16} />}</i><span><b>{service.name}</b><small>{service.enabled ? "已启用" : "已停用"}</small></span></span></td><td><span className={`service-type-badge ${service.type}`}>{serviceTypeLabel(service.type)}</span></td><td><code className="service-target">{service.target}</code></td><td><span className="management-stack"><b>{service.interval}s</b><small>权重 {service.displayIndex}</small></span></td><td>{service.serverIds.length ? `${service.serverIds.length} 台服务器` : "全部服务器"}</td><td>{service.hideForGuest ? "隐藏" : "显示"}</td><td><span className="management-actions"><button onClick={() => setEditing(service)} title="编辑"><Edit3 size={15} /></button><button className="danger" onClick={() => remove(service)} title="删除"><Trash2 size={15} /></button></span></td></tr>) : <tr><td colSpan={7}><div className="management-empty"><Radio size={24} /><b>{services.length ? "没有匹配的服务监控" : "暂无服务监控"}</b><span>{services.length ? "请调整搜索关键词" : "新增 Ping 或 TCPing 任务后，Agent 会自动开始采样"}</span></div></td></tr>}</tbody></table></div></section>{editing && <ServiceEditor service={editing === "new" ? null : editing} servers={servers} onClose={() => setEditing(null)} onSaved={load} />}</div>;
}
