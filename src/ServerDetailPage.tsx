import {
  Activity,
  ArrowLeft,
  Clock3,
  ExternalLink,
  LogIn,
  Moon,
  Network,
  Sun,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { useProbe } from "./hooks/useProbe";
import { average, formatBytes, formatSpeed, formatSpeedCompact, formatUptime, stableLatencyValues, timeLabel } from "./lib/format";
import type { HistoryPoint, ServerMetric, ServiceHistoryPoint, ServiceMonitor } from "./types";
import { ChartYAxisTick } from "./components/Charts";

type DetailTab = "detail" | "network";
type DetailPeriod = "realtime" | "1d" | "7d";

const periodMilliseconds: Record<DetailPeriod, number> = {
  realtime: 5 * 60 * 1000,
  "1d": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
};

function DetailHeader({ online, dark, onThemeToggle }: { online: number; dark: boolean; onThemeToggle: () => void }) {
  return (
    <header className="public-header detail-public-header">
      <a className="public-brand" href="/" aria-label="Orange Probe 首页"><span><Activity size={17} /></span><strong>Orange</strong><b>Probe</b><i /><em>Server Monitoring</em></a>
      <nav className="public-actions"><a className="public-login" href="/admin"><LogIn size={14} />后台</a><button className="public-icon-button" onClick={onThemeToggle} title={dark ? "切换浅色模式" : "切换深色模式"}>{dark ? <Sun size={17} /> : <Moon size={17} />}</button><span className="public-online-pill"><b>{online}</b> Online <i className="online" /></span></nav>
    </header>
  );
}

function DetailInfo({ server }: { server: ServerMetric }) {
  const bootTime = server.uptime ? Date.now() - server.uptime * 1000 : 0;
  const dateTime = (value: number) => value ? new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "medium", hour12: false }).format(value) : "--";
  const items = [
    { label: "状态", value: server.status === "online" ? "在线" : "离线", tone: server.status },
    { label: "运行时间", value: formatUptime(server.uptime) },
    { label: "架构", value: server.arch },
    { label: "内存", value: formatBytes(server.memory.total) },
    { label: "虚拟内存", value: server.swap.total ? formatBytes(server.swap.total) : "未启用" },
    { label: "磁盘", value: formatBytes(server.disk.total) },
    { label: "地区", value: server.location },
    { label: "系统", value: server.os },
    { label: "CPU", value: `${server.cpuModel.trim()} · ${server.cpuCores} 核`, wide: true },
    { label: "负载", value: `1m ${server.load[0]?.toFixed(2) || "0"} · 5m ${server.load[1]?.toFixed(2) || "0"} · 15m ${server.load[2]?.toFixed(2) || "0"}` },
    { label: "连接", value: `${server.tcpConnections} TCP · ${server.udpConnections} UDP` },
    { label: "上传总量", value: formatBytes(server.network.uploadTotal) },
    { label: "下载总量", value: formatBytes(server.network.downloadTotal) },
    { label: "启动时间", value: dateTime(bootTime) },
    { label: "最后上报", value: dateTime(server.lastSeen) },
  ];
  return <dl className="server-detail-info">{items.map((item) => <div className={item.wide ? "wide" : ""} key={item.label}><dt>{item.label}</dt><dd className={item.tone}>{item.value}</dd></div>)}</dl>;
}

interface ChartSeries {
  key: keyof HistoryPoint;
  label: string;
  color: string;
}

function DetailChartCard({ title, value, subvalue, data, series, percent = false, speed = false }: { title: string; value: string; subvalue?: string; data: HistoryPoint[]; series: ChartSeries[]; percent?: boolean; speed?: boolean }) {
  return (
    <article className="server-chart-card">
      <div className="server-chart-head"><span><h3>{title}</h3>{subvalue && <small>{subvalue}</small>}</span><strong>{value}</strong></div>
      <div className="server-chart-legend">{series.map((item) => <span key={item.key}><i style={{ background: item.color }} />{item.label}</span>)}</div>
      <div className="server-chart-canvas">
        {data.length < 2 ? <div className="chart-empty"><Activity size={18} /><span>正在收集采样数据</span></div> : <ResponsiveContainer><LineChart data={data} margin={{ top: 5, right: 4, left: 0, bottom: 0 }}><CartesianGrid stroke="var(--chart-grid)" vertical={false} /><XAxis dataKey="timestamp" tickFormatter={timeLabel} tickLine={false} axisLine={false} minTickGap={50} tick={{ fill: "var(--text-muted)", fontSize: 10, fontWeight: 600 }} /><YAxis domain={percent ? [0, 100] : [0, "auto"]} width={speed ? 50 : 48} tickLine={false} axisLine={false} tick={<ChartYAxisTick formatter={(number) => percent ? `${number}%` : speed ? formatSpeedCompact(number) : String(Math.round(number))} />} /><Tooltip labelFormatter={(label) => timeLabel(Number(label))} formatter={(number: number, name: string) => [percent ? `${Number(number).toFixed(1)}%` : speed ? formatSpeed(Number(number)) : String(Math.round(Number(number))), name]} contentStyle={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 6, fontSize: 11, fontWeight: 600 }} />{series.map((item) => <Line key={item.key} type="monotone" dataKey={item.key} name={item.label} stroke={item.color} strokeWidth={2} dot={false} isAnimationActive={false} />)}</LineChart></ResponsiveContainer>}
      </div>
    </article>
  );
}

function ServiceLatencyTooltip({ active, label, services, histories, period, colorFor, latencyLimitFor }: { active?: boolean; label?: number; services: ServiceMonitor[]; histories: Record<number, ServiceHistoryPoint[]>; period: DetailPeriod; colorFor: (serviceId: number) => string; latencyLimitFor: (serviceId: number) => number }) {
  if (!active || !label) return null;
  const cutoff = Date.now() - periodMilliseconds[period];
  return <div className="service-latency-tooltip"><span>{timeLabel(Number(label))}</span>{services.map((service) => {
    const samples = (histories[service.id] || []).filter((point) => point.timestamp >= cutoff);
    const nearest = samples.reduce<ServiceHistoryPoint | null>((best, point) => !best || Math.abs(point.timestamp - Number(label)) < Math.abs(best.timestamp - Number(label)) ? point : best, null);
    const maximumDistance = Math.max(service.interval * 1250, period === "realtime" ? 10_000 : period === "1d" ? 120_000 : 20 * 60_000);
    const sample = nearest && Math.abs(nearest.timestamp - Number(label)) <= maximumDistance ? nearest : null;
    const outlier = Boolean(sample?.success && sample.latency !== null && sample.latency > latencyLimitFor(service.id));
    return <div key={service.id}><i style={{ background: colorFor(service.id) }} /><b>{service.name}</b><strong className={sample && (!sample.success || outlier) ? "failed" : ""}>{!sample ? "--" : outlier ? "已过滤" : sample.success && sample.latency !== null ? `${sample.latency.toFixed(1)} ms` : "丢包"}</strong><small>{sample ? `${outlier ? "异常样本" : "采样"} ${timeLabel(sample.timestamp)}` : "附近无采样"}</small></div>;
  })}</div>;
}

function ServiceNetworkView({ serverId, period }: { serverId: string; period: DetailPeriod }) {
  const [services, setServices] = useState<ServiceMonitor[]>([]);
  const [hiddenIds, setHiddenIds] = useState<number[]>([]);
  const [histories, setHistories] = useState<Record<number, ServiceHistoryPoint[]>>({});

  useEffect(() => {
    let disposed = false;
    const load = async () => {
      const response = await fetch(`/api/services?serverId=${encodeURIComponent(serverId)}`);
      if (!response.ok) return;
      const payload = await response.json() as { services: ServiceMonitor[] };
      if (!disposed) {
        setServices(payload.services);
        setHiddenIds((current) => current.filter((id) => payload.services.some((service) => service.id === id)));
      }
    };
    load();
    const timer = window.setInterval(load, 10000);
    return () => { disposed = true; window.clearInterval(timer); };
  }, [serverId]);

  const serviceIds = services.map((service) => service.id).join(",");
  useEffect(() => {
    if (!services.length) return setHistories({});
    let disposed = false;
    const load = async () => {
      const entries = await Promise.all(services.map(async (service) => {
        const response = await fetch(`/api/services/${service.id}/history?serverId=${encodeURIComponent(serverId)}&period=${period}`);
        if (!response.ok) return [service.id, []] as const;
        const payload = await response.json() as { points: ServiceHistoryPoint[] };
        return [service.id, payload.points] as const;
      }));
      if (!disposed) setHistories(Object.fromEntries(entries));
    };
    load();
    const timer = window.setInterval(load, 5000);
    return () => { disposed = true; window.clearInterval(timer); };
  }, [period, serverId, serviceIds]);

  const visibleServices = services.filter((service) => !hiddenIds.includes(service.id));
  const curveColors = ["#3478f6", "#e66b19", "#168c73", "#9b6ce7", "#d84242", "#d99a17", "#0f9bb4", "#ed5f8d"];
  const serviceColor = (serviceId: number) => curveColors[Math.max(0, services.findIndex((service) => service.id === serviceId)) % curveColors.length];

  const serviceStats = (serviceId: number) => {
    const filtered = (histories[serviceId] || []).filter((point) => point.timestamp >= Date.now() - periodMilliseconds[period]);
    const successful = filtered.filter((point) => point.success && point.latency !== null);
    const stableLatencies = stableLatencyValues(successful.map((point) => Number(point.latency)));
    const latencyCeiling = stableLatencies.length ? Math.max(...stableLatencies) : Number.POSITIVE_INFINITY;
    const averageLatency = average(stableLatencies);
    const packetLoss = filtered.length ? filtered.filter((point) => !point.success).length / filtered.length * 100 : 0;
    return { filtered, successfulCount: stableLatencies.length, averageLatency, packetLoss, latencyCeiling, latest: filtered.at(-1) || null };
  };

  const bucketMilliseconds = period === "realtime" ? 5_000 : period === "1d" ? 60_000 : 10 * 60_000;
  const chartBuckets = new Map<number, Record<string, number | null>>();
  for (const service of visibleServices) {
    const stats = serviceStats(service.id);
    for (const point of stats.filtered) {
      const timestamp = Math.round(point.timestamp / bucketMilliseconds) * bucketMilliseconds;
      const row = chartBuckets.get(timestamp) || { timestamp };
      row[`service_${service.id}`] = point.success && point.latency !== null && point.latency <= stats.latencyCeiling ? point.latency : null;
      chartBuckets.set(timestamp, row);
    }
  }
  const chartData = [...chartBuckets.values()].sort((left, right) => Number(left.timestamp) - Number(right.timestamp));
  const hasChartData = visibleServices.some((service) => serviceStats(service.id).successfulCount >= 2);

  const toggleService = (serviceId: number) => {
    setHiddenIds((current) => current.includes(serviceId) ? current.filter((id) => id !== serviceId) : [...current, serviceId]);
  };

  if (!services.length) return <div className="service-network-empty"><Network size={28} /><h3>暂无服务监控</h3><p>管理员尚未为此服务器配置 Ping 或 TCPing 任务</p></div>;

  return (
    <div className="service-network-view">
      <div className="service-network-tabs">{services.map((service) => { const stats = serviceStats(service.id); const latest = stats.latest || service.latest; const visible = !hiddenIds.includes(service.id); const color = serviceColor(service.id); return <button className={visible ? "active" : "hidden"} aria-pressed={visible} key={service.id} onClick={() => toggleService(service.id)} title={visible ? `隐藏 ${service.name} 延迟曲线` : `显示 ${service.name} 延迟曲线`} style={{ "--service-color": color } as CSSProperties}><i className={latest?.success ? "online" : "offline"} /><span className="service-network-target-name"><b>{service.name}</b><small>{service.type === "icmp" ? "ICMP Ping" : service.type === "tcp" ? "TCPing" : "HTTP GET"}</small></span><span className="service-network-card-stats"><span><small>平均延迟</small><strong>{stats.successfulCount ? `${stats.averageLatency.toFixed(1)} ms` : "--"}</strong></span><span><small>丢包率</small><strong className={stats.packetLoss >= 20 ? "danger" : stats.packetLoss > 0 ? "warning" : "healthy"}>{stats.filtered.length ? `${stats.packetLoss.toFixed(2)}%` : "--"}</strong></span></span></button>; })}</div>
      <article className="service-latency-chart">
        <div className="server-chart-head"><span><h3>网络延迟</h3><small>Agent 到监控目标的往返延迟</small></span><strong>{visibleServices.length} 条曲线</strong></div>
        <div className="service-curve-legend">{visibleServices.map((service) => <span key={service.id}><i style={{ background: serviceColor(service.id) }} />{service.name}</span>)}</div>
        <div className="service-chart-canvas">{!hasChartData ? <div className="chart-empty"><Clock3 size={18} /><span>{visibleServices.length ? "等待 Agent 返回更多监控结果" : "没有可显示的延迟曲线"}</span></div> : <ResponsiveContainer><LineChart data={chartData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}><CartesianGrid stroke="var(--chart-grid)" vertical={false} /><XAxis dataKey="timestamp" tickFormatter={timeLabel} tickLine={false} axisLine={false} minTickGap={50} tick={{ fill: "var(--text-muted)", fontSize: 9 }} /><YAxis width={56} tickLine={false} axisLine={false} tick={<ChartYAxisTick formatter={(value) => `${Math.round(value)} ms`} fontSize={9} />} /><Tooltip content={<ServiceLatencyTooltip services={visibleServices} histories={histories} period={period} colorFor={serviceColor} latencyLimitFor={(serviceId) => serviceStats(serviceId).latencyCeiling} />} />{visibleServices.map((service) => <Line key={service.id} type="monotone" dataKey={`service_${service.id}`} name={service.name} stroke={serviceColor(service.id)} strokeWidth={2} dot={false} connectNulls isAnimationActive={false} />)}</LineChart></ResponsiveContainer>}</div>
      </article>
    </div>
  );
}

export default function ServerDetailPage() {
  const serverId = decodeURIComponent(window.location.pathname.split("/")[2] || "");
  const { servers } = useProbe();
  const [server, setServer] = useState<ServerMetric | null>(null);
  const [history, setHistory] = useState<HistoryPoint[]>([]);
  const [tab, setTab] = useState<DetailTab>("detail");
  const [period, setPeriod] = useState<DetailPeriod>("realtime");
  const [now, setNow] = useState(new Date());
  const [dark, setDark] = useState(() => localStorage.getItem("orange-probe-theme") === "dark");

  useEffect(() => {
    const current = servers.find((item) => item.id === serverId);
    if (current) setServer(current);
  }, [serverId, servers]);

  useEffect(() => {
    let disposed = false;
    const load = async () => {
      const response = await fetch(`/api/servers/${encodeURIComponent(serverId)}/history?period=${period}`);
      if (!response.ok) return;
      const payload = await response.json() as { server: ServerMetric; points: HistoryPoint[] };
      if (!disposed) { setServer(payload.server); setHistory(payload.points); }
    };
    load();
    const timer = window.setInterval(load, 5000);
    return () => { disposed = true; window.clearInterval(timer); };
  }, [period, serverId]);

  useEffect(() => { const timer = window.setInterval(() => setNow(new Date()), 1000); return () => window.clearInterval(timer); }, []);
  useEffect(() => { document.documentElement.dataset.theme = dark ? "dark" : "light"; localStorage.setItem("orange-probe-theme", dark ? "dark" : "light"); }, [dark]);
  useEffect(() => { document.title = `${server?.name || "Server"} · Orange Probe`; }, [server?.name]);

  const filteredHistory = useMemo(() => history.filter((point) => point.timestamp >= Date.now() - periodMilliseconds[period]), [history, period]);
  const online = servers.filter((item) => item.status === "online").length;
  const time = new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(now);

  if (!server) return <div className="server-detail-loading"><Activity className="spin" size={22} /><span>正在加载服务器详情</span><a href="/">返回主页</a></div>;

  return (
    <div className="server-detail-page">
      <DetailHeader online={online} dark={dark} onThemeToggle={() => setDark((value) => !value)} />
      <main className="server-detail-main">
        <section className="public-overview-heading"><h1>👋 运行概览</h1><p>当前时间 <b>{time}</b></p></section>
        <a className="server-detail-title" href="/"><ArrowLeft size={18} /><span><h2>{server.name}</h2>{server.publicNote && <small>{server.publicNote}</small>}</span></a>
        <DetailInfo server={server} />
        <div className="server-detail-tab-line"><i /><div><button className={tab === "detail" ? "active" : ""} onClick={() => setTab("detail")}>详情</button><button className={tab === "network" ? "active" : ""} onClick={() => setTab("network")}>网络</button></div><i /></div>
        <div className="server-period-switch"><button className={period === "realtime" ? "active" : ""} onClick={() => setPeriod("realtime")}><span className="public-status online" />实时</button><button className={period === "1d" ? "active" : ""} onClick={() => setPeriod("1d")}>1 天</button><button className={period === "7d" ? "active" : ""} onClick={() => setPeriod("7d")}>7 天</button></div>
        {tab === "detail" ? <section className="server-chart-grid">
          <DetailChartCard title="CPU" value={`${server.cpu.toFixed(1)}%`} data={filteredHistory} series={[{ key: "cpu", label: "CPU", color: "#3478f6" }]} percent />
          <DetailChartCard title="内存 / SWAP" value={`${server.memory.percent.toFixed(1)}% / ${server.swap.percent.toFixed(1)}%`} subvalue={`MEM ${formatBytes(server.memory.used)} / ${formatBytes(server.memory.total)} · SWAP ${server.swap.total ? `${formatBytes(server.swap.used)} / ${formatBytes(server.swap.total)}` : "未启用"}`} data={filteredHistory} series={[{ key: "memory", label: "MEM", color: "#9b6ce7" }, { key: "swap", label: "SWAP", color: "#e68a2e" }]} percent />
          <DetailChartCard title="磁盘" value={`${server.disk.percent.toFixed(1)}%`} subvalue={`${formatBytes(server.disk.used)} / ${formatBytes(server.disk.total)}`} data={filteredHistory} series={[{ key: "disk", label: "STG", color: "#168c73" }]} percent />
          <DetailChartCard title="进程" value={String(server.processCount)} data={filteredHistory} series={[{ key: "processCount", label: "Process", color: "#ed5f8d" }]} />
          <DetailChartCard title="网络" value={`${formatSpeed(server.network.downloadSpeed)} 下载 · ${formatSpeed(server.network.uploadSpeed)} 上传`} subvalue="当前上下行速率" data={filteredHistory} series={[{ key: "upload", label: "上传", color: "#3478f6" }, { key: "download", label: "下载", color: "#9b6ce7" }]} speed />
          <DetailChartCard title="连接数" value={`${server.tcpConnections} TCP · ${server.udpConnections} UDP`} subvalue="当前活跃套接字" data={filteredHistory} series={[{ key: "tcpConnections", label: "TCP", color: "#7c62e3" }, { key: "udpConnections", label: "UDP", color: "#e68a2e" }]} />
        </section> : <ServiceNetworkView serverId={server.id} period={period} />}
      </main>
      <footer className="public-footer server-detail-footer"><span>©2026 Orange Probe</span><a href="/admin"><ExternalLink size={11} />管理后台</a></footer>
    </div>
  );
}
