import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  BellOff,
  CheckCircle2,
  ChevronRight,
  Clock3,
  Cpu,
  Database,
  Globe2,
  HardDrive,
  Info,
  KeyRound,
  MemoryStick,
  Network,
  RefreshCw,
  Send,
  Server,
  Settings2,
  ShieldCheck,
  UserRound,
  WifiOff,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import AdminLogin, { type AdminSession } from "./AdminLogin";
import PublicHome from "./PublicHome";
import ServerDetailPage from "./ServerDetailPage";
import { ChartLegend, TrafficChart } from "./components/Charts";
import FirewallManagement from "./components/FirewallManagement";
import { InstallModal, NodeDrawer } from "./components/Modals";
import ServerManagement from "./components/ServerManagement";
import SelectMenu from "./components/SelectMenu";
import ServiceOverview from "./components/ServiceOverview";
import ServiceManagement from "./components/ServiceManagement";
import UpdateManagement from "./components/UpdateManagement";
import {
  HealthList,
  StatCard,
} from "./components/ServerUI";
import Shell from "./components/Shell";
import { useProbe } from "./hooks/useProbe";
import { formatBytes, formatRelativeTime, formatSpeed } from "./lib/format";
import { clearPendingServerRefresh, readPendingServerRefresh } from "./lib/updateRefresh";
import type { AlertSettings, ServerMetric, ServerSla, SlaPeriod, ViewName } from "./types";

const defaultSettings: AlertSettings = {
  cpu: 85,
  memory: 85,
  disk: 90,
  homepageRefreshSeconds: 5,
  notifications: false,
  offlineAlerts: true,
  telegramEnabled: false,
  telegramBotToken: "",
  telegramChatId: "",
  telegramLoadAlerts: true,
  telegramOfflineAlerts: true,
  telegramOnlineAlerts: true,
  telegramRenewalAlerts: true,
  telegramTrafficAlerts: true,
  reverseProxyEnabled: false,
  publicDomain: "",
};

interface AlertEvent {
  id: string;
  server: ServerMetric;
  type: "offline" | "cpu" | "memory" | "disk";
  title: string;
  description: string;
  severity: "critical" | "warning";
  timestamp: number;
}

function makeEvents(servers: ServerMetric[], settings: AlertSettings): AlertEvent[] {
  const events: AlertEvent[] = [];
  for (const server of servers) {
    if (server.status === "offline" && settings.offlineAlerts) {
      events.push({ id: `${server.id}-offline`, server, type: "offline", title: "节点连接中断", description: `${server.name} 已停止上报监控数据`, severity: "critical", timestamp: server.lastSeen });
      continue;
    }
    if (server.cpu >= settings.cpu) events.push({ id: `${server.id}-cpu`, server, type: "cpu", title: "CPU 使用率过高", description: `当前 ${server.cpu.toFixed(1)}%，阈值 ${settings.cpu}%`, severity: "warning", timestamp: server.lastSeen });
    if (server.memory.percent >= settings.memory) events.push({ id: `${server.id}-memory`, server, type: "memory", title: "内存使用率过高", description: `当前 ${server.memory.percent.toFixed(1)}%，阈值 ${settings.memory}%`, severity: "warning", timestamp: server.lastSeen });
    if (server.disk.percent >= settings.disk) events.push({ id: `${server.id}-disk`, server, type: "disk", title: "磁盘空间不足", description: `当前占用 ${server.disk.percent.toFixed(1)}%，阈值 ${settings.disk}%`, severity: "warning", timestamp: server.lastSeen });
  }
  return events.sort((a, b) => (a.severity === b.severity ? b.timestamp - a.timestamp : a.severity === "critical" ? -1 : 1));
}

function PanelHeading({ title, subtitle, action }: { title: string; subtitle: string; action?: React.ReactNode }) {
  return <div className="section-heading"><span><h2>{title}</h2><p>{subtitle}</p></span>{action}</div>;
}

function OverviewPage({
  allServers,
  history,
  lastUpdate,
  onViewAll,
}: {
  allServers: ServerMetric[];
  history: ReturnType<typeof useProbe>["aggregateHistory"];
  lastUpdate: number;
  onViewAll: () => void;
}) {
  const [slaPeriod, setSlaPeriod] = useState<SlaPeriod>(30);
  const [sla, setSla] = useState<ServerSla[]>([]);
  const online = allServers.filter((server) => server.status === "online");
  const offline = allServers.length - online.length;
  const totalDown = online.reduce((sum, server) => sum + server.network.downloadSpeed, 0);
  const totalUp = online.reduce((sum, server) => sum + server.network.uploadSpeed, 0);
  const downloadedTraffic = allServers.reduce((sum, server) => sum + server.network.downloadTotal, 0);
  const uploadedTraffic = allServers.reduce((sum, server) => sum + server.network.uploadTotal, 0);

  useEffect(() => {
    let active = true;
    const loadSla = () => fetch(`/api/admin/sla?days=${slaPeriod}`)
      .then((response) => response.ok ? response.json() as Promise<{ servers: ServerSla[] }> : Promise.reject(new Error("sla")))
      .then((payload) => { if (active) setSla(payload.servers); })
      .catch(() => undefined);
    loadSla();
    const timer = window.setInterval(loadSla, 60_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [slaPeriod, allServers.length]);

  return (
    <div className="page-stack">
      <section className="stat-grid">
        <StatCard label="总节点" value={String(allServers.length)} detail={`${online.length} 个在线 · ${offline} 个离线`} icon={<Server size={21} />} tone="blue" />
        <StatCard label="在线节点" value={String(online.length)} detail={offline ? `${offline} 个节点需要检查` : "全部节点连接正常"} icon={<ShieldCheck size={21} />} tone="green" />
        <StatCard label="实时带宽" value={formatSpeed(totalDown + totalUp)} detail={`下载 ${formatSpeed(totalDown)} · 上传 ${formatSpeed(totalUp)}`} icon={<Network size={21} />} tone="orange" />
        <StatCard label="总流量" value={formatBytes(downloadedTraffic + uploadedTraffic)} detail={`下载 ${formatBytes(downloadedTraffic)} · 上传 ${formatBytes(uploadedTraffic)}`} icon={<Database size={21} />} tone="neutral" />
      </section>

      <section className="overview-grid">
        <article className="panel traffic-panel">
          <PanelHeading
            title="聚合网络流量"
            subtitle={lastUpdate ? `实时更新 · ${formatRelativeTime(lastUpdate)}` : "等待采集服务"}
            action={<ChartLegend />}
          />
          <TrafficChart data={history} height={268} />
          <div className="traffic-totals"><span><i className="download"><ArrowDown size={15} /></i><span>当前下载<b>{formatSpeed(totalDown)}</b></span></span><span><i className="upload"><ArrowUp size={15} /></i><span>当前上传<b>{formatSpeed(totalUp)}</b></span></span></div>
        </article>
        <article className="panel health-panel">
          <PanelHeading title="节点 SLA" subtitle={`按最近 ${slaPeriod} 天在线采样计算`} action={<div className="sla-period segmented">{([7, 30, 180, 365] as SlaPeriod[]).map((days) => <button key={days} className={slaPeriod === days ? "active" : ""} onClick={() => setSlaPeriod(days)}>{days} 天</button>)}</div>} />
          <HealthList servers={allServers} sla={sla} />
          <button className="panel-link" onClick={onViewAll}>查看全部节点 <ChevronRight size={15} /></button>
        </article>
      </section>
    </div>
  );
}

function EventsPage({ events, dismissed, onDismissAll, onSelect }: { events: AlertEvent[]; dismissed: Set<string>; onDismissAll: () => void; onSelect: (server: ServerMetric) => void }) {
  const visible = events.filter((event) => !dismissed.has(event.id));
  return (
    <div className="page-stack">
      <section className="event-summary">
        <div className="event-summary-icon"><AlertTriangle size={23} /></div>
        <span><strong>{visible.length ? `${visible.length} 个待处理事件` : "当前没有待处理事件"}</strong><small>{visible.some((event) => event.severity === "critical") ? "包含节点离线等高优先级告警" : "系统运行状态稳定"}</small></span>
        {visible.length > 0 && <button className="secondary-button" onClick={onDismissAll}><CheckCircle2 size={15} />全部标记已读</button>}
      </section>
      <section className="panel event-panel">
        <PanelHeading title="事件记录" subtitle="根据当前阈值实时生成" />
        {visible.length ? (
          <div className="event-list">
            {visible.map((event) => (
              <button className="event-row" key={event.id} onClick={() => onSelect(event.server)}>
                <span className={`event-icon ${event.severity}`}>{event.type === "offline" ? <WifiOff size={18} /> : event.type === "cpu" ? <Cpu size={18} /> : event.type === "memory" ? <MemoryStick size={18} /> : <HardDrive size={18} />}</span>
                <span className="event-copy"><span><b>{event.title}</b><em className={event.severity}>{event.severity === "critical" ? "严重" : "警告"}</em></span><strong>{event.server.name} · {event.server.location}</strong><small>{event.description}</small></span>
                <span className="event-time"><Clock3 size={13} />{formatRelativeTime(event.timestamp)}</span>
                <ChevronRight size={16} />
              </button>
            ))}
          </div>
        ) : (
          <div className="events-clear"><CheckCircle2 size={30} /><h3>一切正常</h3><p>没有超过阈值或离线的节点</p></div>
        )}
      </section>
    </div>
  );
}

function Toggle({ checked, onChange }: { checked: boolean; onChange: (checked: boolean) => void }) {
  return <button className={checked ? "toggle checked" : "toggle"} role="switch" aria-checked={checked} onClick={() => onChange(!checked)}><span /></button>;
}

function SettingsPage({ settings, currentUsername, onAccountUpdated, onChange, onSave, onTestTelegram, telegramTesting, telegramResult }: { settings: AlertSettings; currentUsername: string; onAccountUpdated: (session: AdminSession) => void; onChange: (settings: AlertSettings) => void; onSave: () => void; onTestTelegram: () => void; telegramTesting: boolean; telegramResult: { ok: boolean; message: string } | null }) {
  const [account, setAccount] = useState({ username: currentUsername, currentPassword: "", newPassword: "", confirmPassword: "" });
  const [accountSaving, setAccountSaving] = useState(false);
  const [accountResult, setAccountResult] = useState<{ ok: boolean; message: string } | null>(null);
  const thresholdRows = [
    { key: "cpu" as const, label: "CPU 使用率", icon: <Cpu size={18} />, note: "持续超过阈值时生成警告事件" },
    { key: "memory" as const, label: "内存使用率", icon: <MemoryStick size={18} />, note: "用于发现内存压力和潜在泄漏" },
    { key: "disk" as const, label: "磁盘使用率", icon: <HardDrive size={18} />, note: "磁盘空间接近耗尽前发出告警" },
  ];
  const homepageRefreshOptions: Array<{ value: "5" | "15" | "30" | "60"; label: string }> = [
    { value: "5", label: "每 5 秒" },
    { value: "15", label: "每 15 秒" },
    { value: "30", label: "每 30 秒" },
    { value: "60", label: "每 60 秒" },
  ];
  const saveAccount = async () => {
    if (account.newPassword !== account.confirmPassword) return setAccountResult({ ok: false, message: "两次输入的新密码不一致" });
    setAccountSaving(true);
    setAccountResult(null);
    try {
      const response = await fetch("/api/admin/account", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: account.username, currentPassword: account.currentPassword, newPassword: account.newPassword }) });
      const payload = await response.json().catch(() => ({})) as AdminSession & { error?: string };
      if (!response.ok) throw new Error(payload.error || "账户信息保存失败");
      onAccountUpdated(payload);
      setAccount((value) => ({ ...value, currentPassword: "", newPassword: "", confirmPassword: "" }));
      setAccountResult({ ok: true, message: "管理员账户已更新" });
    } catch (error) {
      setAccountResult({ ok: false, message: error instanceof Error ? error.message : "账户信息保存失败" });
    } finally {
      setAccountSaving(false);
    }
  };
  return (
    <div className="settings-layout">
      <section className="panel settings-panel">
        <PanelHeading title="资源阈值" subtitle="告警规则会立即应用于所有节点" />
        <div className="threshold-list">
          {thresholdRows.map((row) => (
            <div className="threshold-row" key={row.key}>
              <span className="setting-icon">{row.icon}</span>
              <span className="threshold-copy"><b>{row.label}</b><small>{row.note}</small></span>
              <input type="range" min="50" max="99" value={settings[row.key]} onChange={(event) => onChange({ ...settings, [row.key]: Number(event.target.value) })} aria-label={`${row.label}阈值`} />
              <label><input type="number" min="50" max="99" value={settings[row.key]} onChange={(event) => onChange({ ...settings, [row.key]: Math.min(99, Math.max(50, Number(event.target.value))) })} /><span>%</span></label>
            </div>
          ))}
        </div>
      </section>
      <section className="panel settings-panel">
        <PanelHeading title="监控与刷新" subtitle="控制事件生成、桌面提醒和公开主页更新频率" />
        <div className="preference-list">
          <div className="preference-row"><span className="setting-icon"><BellOff size={18} /></span><span><b>浏览器通知</b><small>页面在后台时发送系统通知</small></span><Toggle checked={settings.notifications} onChange={(notifications) => onChange({ ...settings, notifications })} /></div>
          <div className="preference-row"><span className="setting-icon"><WifiOff size={18} /></span><span><b>节点离线告警</b><small>Agent 超过 15 秒未上报时生成严重事件</small></span><Toggle checked={settings.offlineAlerts} onChange={(offlineAlerts) => onChange({ ...settings, offlineAlerts })} /></div>
          <div className="preference-row refresh-frequency-row"><span className="setting-icon"><Clock3 size={18} /></span><span><b>主页刷新频率</b><small>公开主页按所选频率显示最新节点数据</small></span><div className="settings-refresh-select"><SelectMenu label="主页刷新频率" value={String(settings.homepageRefreshSeconds) as "5" | "15" | "30" | "60"} options={homepageRefreshOptions} onChange={(value) => onChange({ ...settings, homepageRefreshSeconds: Number(value) as AlertSettings["homepageRefreshSeconds"] })} /></div></div>
        </div>
        <div className="settings-actions"><button className="primary-button" onClick={onSave}><Settings2 size={16} />保存监控设置</button></div>
      </section>
      <section className="panel settings-panel reverse-proxy-panel">
        <PanelHeading title="反向代理与域名" subtitle="启用后，新增 Agent 将使用 HTTPS 与 WSS 通道" />
        <div className="reverse-proxy-content">
          <div className="preference-row"><span className="setting-icon"><Globe2 size={18} /></span><span><b>启用反向代理模式</b><small>安装命令不再使用当前 IP 和端口，改用下方域名</small></span><Toggle checked={settings.reverseProxyEnabled} onChange={(reverseProxyEnabled) => onChange({ ...settings, reverseProxyEnabled })} /></div>
          <label><span>公网 HTTPS 域名</span><input value={settings.publicDomain} onChange={(event) => onChange({ ...settings, publicDomain: event.target.value })} placeholder="https://probe.example.com" /><small>必须已配置有效 TLS 证书，并将 <code>/ws</code>、<code>/agent-ws</code> 和 HTTP 请求转发到本服务。</small></label>
          <div className={`reverse-proxy-preview${settings.reverseProxyEnabled ? " enabled" : ""}`}><Globe2 size={16} /><span><b>{settings.reverseProxyEnabled ? "Agent WSS 地址" : "当前使用直连模式"}</b><small>{settings.reverseProxyEnabled && settings.publicDomain ? `${settings.publicDomain.replace(/\/$/, "").replace(/^https:/, "wss:")}/agent-ws` : "启用并保存域名后，安装命令将自动切换"}</small></span></div>
        </div>
        <div className="settings-actions"><button className="primary-button" onClick={onSave}><Settings2 size={16} />保存反代设置</button></div>
      </section>
      <section className="panel settings-panel telegram-panel">
        <PanelHeading title="Telegram Bot 通知" subtitle="通过 Bot API 发送负载、离线和续费提醒" />
        <div className="telegram-config-grid">
          <label><span>Bot Token</span><input type="password" autoComplete="off" value={settings.telegramBotToken} onChange={(event) => onChange({ ...settings, telegramBotToken: event.target.value })} placeholder="123456789:AA..." /></label>
          <label><span>Chat ID</span><input value={settings.telegramChatId} onChange={(event) => onChange({ ...settings, telegramChatId: event.target.value })} placeholder="-1001234567890 或 @channel" /></label>
        </div>
        <div className="preference-list telegram-preferences">
          <div className="preference-row"><span className="setting-icon"><Send size={18} /></span><span><b>启用 Telegram 通知</b><small>由服务端后台发送，不依赖浏览器保持打开</small></span><Toggle checked={settings.telegramEnabled} onChange={(telegramEnabled) => onChange({ ...settings, telegramEnabled })} /></div>
          <div className="preference-row"><span className="setting-icon"><AlertTriangle size={18} /></span><span><b>负载异常</b><small>CPU、内存或磁盘超过上方阈值时通知</small></span><Toggle checked={settings.telegramLoadAlerts} onChange={(telegramLoadAlerts) => onChange({ ...settings, telegramLoadAlerts })} /></div>
          <div className="preference-row"><span className="setting-icon"><WifiOff size={18} /></span><span><b>节点离线</b><small>节点从在线变为离线时通知一次</small></span><Toggle checked={settings.telegramOfflineAlerts} onChange={(telegramOfflineAlerts) => onChange({ ...settings, telegramOfflineAlerts })} /></div>
          <div className="preference-row"><span className="setting-icon"><CheckCircle2 size={18} /></span><span><b>节点上线</b><small>节点从离线恢复正常上报时通知一次</small></span><Toggle checked={settings.telegramOnlineAlerts} onChange={(telegramOnlineAlerts) => onChange({ ...settings, telegramOnlineAlerts })} /></div>
          <div className="preference-row"><span className="setting-icon"><Clock3 size={18} /></span><span><b>临期续费</b><small>按节点设置的提前天数通知，并附带续费 URL</small></span><Toggle checked={settings.telegramRenewalAlerts} onChange={(telegramRenewalAlerts) => onChange({ ...settings, telegramRenewalAlerts })} /></div>
          <div className="preference-row"><span className="setting-icon"><Network size={18} /></span><span><b>流量阈值</b><small>节点使用流量达到配置阈值时通知</small></span><Toggle checked={settings.telegramTrafficAlerts} onChange={(telegramTrafficAlerts) => onChange({ ...settings, telegramTrafficAlerts })} /></div>
        </div>
        {telegramResult && <div className={`telegram-test-result ${telegramResult.ok ? "success" : "failed"}`}>{telegramResult.message}</div>}
        <div className="settings-actions telegram-actions"><button className="secondary-button" onClick={onTestTelegram} disabled={telegramTesting || !settings.telegramBotToken || !settings.telegramChatId}>{telegramTesting ? <RefreshCw className="spin" size={15} /> : <Send size={15} />}发送通知预览</button><button className="primary-button" onClick={onSave}><Settings2 size={16} />保存设置</button></div>
      </section>
      <section className="panel settings-panel account-panel">
        <PanelHeading title="管理员账户" subtitle="修改后台登录用户名和密码" />
        <div className="account-config-grid">
          <label><span><UserRound size={14} />用户名</span><input autoComplete="username" value={account.username} onChange={(event) => setAccount({ ...account, username: event.target.value })} /></label>
          <label><span><KeyRound size={14} />当前密码</span><input type="password" autoComplete="current-password" value={account.currentPassword} onChange={(event) => setAccount({ ...account, currentPassword: event.target.value })} /></label>
          <label><span>新密码</span><input type="password" autoComplete="new-password" value={account.newPassword} onChange={(event) => setAccount({ ...account, newPassword: event.target.value })} placeholder="不修改密码时留空" /></label>
          <label><span>确认新密码</span><input type="password" autoComplete="new-password" value={account.confirmPassword} onChange={(event) => setAccount({ ...account, confirmPassword: event.target.value })} placeholder="再次输入新密码" /></label>
        </div>
        {accountResult && <div className={`account-result ${accountResult.ok ? "success" : "failed"}`}>{accountResult.message}</div>}
        <div className="settings-actions"><button className="primary-button" onClick={saveAccount} disabled={accountSaving || !account.currentPassword}>{accountSaving ? <RefreshCw className="spin" size={15} /> : <ShieldCheck size={15} />}保存账户</button></div>
      </section>
      <aside className="settings-note"><Info size={18} /><span><b>配置说明</b><small>Bot Token 和 Chat ID 仅通过后台会话读取，服务端使用 Telegram Bot API 的 <code>sendMessage</code> 方法发送通知。Agent 采集间隔可通过 <code>REPORT_INTERVAL</code> 环境变量调整。</small></span></aside>
    </div>
  );
}

function AdminDashboard({ session, onSessionChange, onLogout }: { session: AdminSession; onSessionChange: (session: AdminSession) => void; onLogout: () => void }) {
  const { servers, connected, lastUpdate, aggregateHistory, refresh } = useProbe();
  const [view, setView] = useState<ViewName>("overview");
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [installOpen, setInstallOpen] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [dark, setDark] = useState(() => localStorage.getItem("orange-probe-theme") === "dark");
  const [settings, setSettings] = useState<AlertSettings>(defaultSettings);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [toast, setToast] = useState<string | null>(null);
  const [telegramTesting, setTelegramTesting] = useState(false);
  const [telegramResult, setTelegramResult] = useState<{ ok: boolean; message: string } | null>(null);

  useEffect(() => {
    document.title = "Orange Probe · 管理后台";
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    localStorage.setItem("orange-probe-theme", dark ? "dark" : "light");
  }, [dark]);

  useEffect(() => {
    let reloading = false;
    const refreshAfterContainerUpdate = async () => {
      const pending = readPendingServerRefresh();
      if (!pending || reloading) return;
      try {
        const response = await fetch("/api/health", { cache: "no-store" });
        if (!response.ok) return;
        const payload = await response.json() as { version?: string };
        if (payload.version !== pending.targetVersion) return;
        reloading = true;
        clearPendingServerRefresh();
        window.location.reload();
      } catch {
        // The application container is expected to be briefly unavailable while it is recreated.
      }
    };
    refreshAfterContainerUpdate();
    const timer = window.setInterval(refreshAfterContainerUpdate, 2000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    fetch("/api/admin/settings")
      .then((response) => {
        if (response.status === 401) throw new Error("unauthorized");
        if (!response.ok) throw new Error("settings");
        return response.json() as Promise<AlertSettings>;
      })
      .then(setSettings)
      .catch((error) => {
        if (error instanceof Error && error.message === "unauthorized") onLogout();
      });
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 2400);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return servers.filter((server) => {
      if (!needle) return true;
      return [server.name, server.location, server.ip, server.os, ...server.tags].some((value) => value.toLowerCase().includes(needle));
    });
  }, [search, servers]);

  const selectedServer = servers.find((server) => server.id === selectedId) || null;
  const events = useMemo(() => makeEvents(servers, settings), [servers, settings]);

  const saveSettings = async () => {
    const response = await fetch("/api/admin/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(settings),
    });
    if (response.status === 401) return onLogout();
    if (!response.ok) {
      const payload = await response.json().catch(() => ({})) as { error?: string };
      setToast(payload.error || "保存失败，请稍后重试");
      return;
    }
    setSettings(await response.json() as AlertSettings);
    if (settings.notifications && "Notification" in window && Notification.permission === "default") {
      await Notification.requestPermission();
    }
    setToast("监控设置已保存");
  };

  const testTelegram = async () => {
    setTelegramTesting(true);
    setTelegramResult(null);
    try {
      const response = await fetch("/api/admin/telegram/test", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ botToken: settings.telegramBotToken, chatId: settings.telegramChatId }),
      });
      const payload = await response.json().catch(() => ({})) as { error?: string; count?: number };
      setTelegramResult(response.ok ? { ok: true, message: `已发送 ${payload.count || 5} 条通知预览` } : { ok: false, message: payload.error || "通知预览发送失败" });
    } catch {
      setTelegramResult({ ok: false, message: "无法连接 Telegram Bot API" });
    } finally {
      setTelegramTesting(false);
    }
  };

  let content: React.ReactNode;
  if (view === "overview") content = <OverviewPage allServers={servers} history={aggregateHistory} lastUpdate={lastUpdate} onViewAll={() => setView("servers")} />;
  else if (view === "serviceOverview") content = <ServiceOverview servers={filtered} />;
  else if (view === "servers") content = <ServerManagement servers={filtered} onRefresh={refresh} />;
  else if (view === "network") content = <ServiceManagement servers={servers} search={search} />;
  else if (view === "events") content = <EventsPage events={events} dismissed={dismissed} onDismissAll={() => setDismissed(new Set(events.map((event) => event.id)))} onSelect={(server) => setSelectedId(server.id)} />;
  else if (view === "firewall") content = <FirewallManagement onUnauthorized={onLogout} />;
  else if (view === "updates") content = <UpdateManagement />;
  else content = <SettingsPage settings={settings} currentUsername={session.username} onAccountUpdated={onSessionChange} onChange={setSettings} onSave={saveSettings} onTestTelegram={testTelegram} telegramTesting={telegramTesting} telegramResult={telegramResult} />;

  return (
    <>
      <Shell view={view} onViewChange={setView} dark={dark} onThemeToggle={() => setDark((value) => !value)} connected={connected} search={search} onSearchChange={setSearch} onAddProbe={() => setInstallOpen(true)} mobileOpen={mobileOpen} onMobileOpenChange={setMobileOpen} adminUsername={session.username} onLogout={onLogout}>
        {!connected && servers.length === 0 ? (
          <div className="loading-state"><RefreshCw className="spin" size={23} /><span><b>正在连接采集服务</b><small>请确认 API 已在 4174 端口启动</small></span><button className="secondary-button" onClick={() => refresh().catch(() => undefined)}>重新连接</button></div>
        ) : content}
      </Shell>
      {selectedServer && <NodeDrawer server={selectedServer} onClose={() => setSelectedId(null)} />}
      {installOpen && <InstallModal onClose={() => setInstallOpen(false)} onCreated={refresh} />}
      {toast && <div className="toast"><CheckCircle2 size={17} /><span>{toast}</span><button onClick={() => setToast(null)}><X size={14} /></button></div>}
    </>
  );
}

function AdminPortal() {
  const [auth, setAuth] = useState<AdminSession | "loading" | "guest">("loading");

  useEffect(() => {
    fetch("/api/admin/session")
      .then(async (response) => {
        if (!response.ok) return setAuth("guest");
        setAuth(await response.json() as AdminSession);
      })
      .catch(() => setAuth("guest"));
  }, []);

  const logout = async () => {
    await fetch("/api/admin/logout", { method: "POST" }).catch(() => undefined);
    setAuth("guest");
  };

  if (auth === "loading") return <div className="admin-auth-loading"><RefreshCw className="spin" size={22} /><span>正在验证后台会话</span></div>;
  if (auth === "guest") return <AdminLogin onLogin={setAuth} />;
  return <AdminDashboard session={auth} onSessionChange={setAuth} onLogout={logout} />;
}

export default function App() {
  if (window.location.pathname.startsWith("/admin")) return <AdminPortal />;
  if (window.location.pathname.startsWith("/server/")) return <ServerDetailPage />;
  return <PublicHome />;
}
