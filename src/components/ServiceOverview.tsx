import { Activity, ArrowDown, ArrowUp, Clock3, Cpu, ExternalLink, HardDrive, MemoryStick, Network, RefreshCw, Server } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { formatBytes, formatRelativeTime, formatSpeed, formatSpeedCompact, formatUptime } from "../lib/format";
import type { HistoryPoint, ServerMetric } from "../types";
import SelectMenu from "./SelectMenu";
import { StatusDot } from "./ServerUI";
import { ChartYAxisTick } from "./Charts";

type HistoryPeriod = "realtime" | "1d" | "7d";
type ResourceTab = "cpu" | "memory" | "disk" | "network";
type RefreshMode = "live" | "15s" | "manual";

const refreshOptions: Array<{ value: RefreshMode; label: string }> = [
  { value: "live", label: "实时刷新（5 秒）" },
  { value: "15s", label: "每 15 秒刷新" },
  { value: "manual", label: "暂停自动刷新" },
];

interface SeriesDefinition {
  key: keyof HistoryPoint;
  label: string;
  color: string;
}

interface MetricChartProps {
  title: string;
  icon: ReactNode;
  value: string;
  detail: string;
  points: HistoryPoint[];
  period: HistoryPeriod;
  series: SeriesDefinition[];
  percent?: boolean;
  speed?: boolean;
  wide?: boolean;
}

function chartTimeLabel(timestamp: number, period: HistoryPeriod) {
  return new Intl.DateTimeFormat("zh-CN", period === "7d"
    ? { month: "2-digit", day: "2-digit", hour: "2-digit", hour12: false }
    : { hour: "2-digit", minute: "2-digit", second: period === "realtime" ? "2-digit" : undefined, hour12: false })
    .format(timestamp);
}

function chartNumberLabel(value: number) {
  const absolute = Math.abs(value);
  if (absolute > 0 && absolute < 1) return value.toFixed(2);
  if (absolute < 10) return value.toFixed(1);
  return String(Math.round(value));
}

function MetricChart({ title, icon, value, detail, points, period, series, percent = false, speed = false, wide = false }: MetricChartProps) {
  return (
    <article className={`service-overview-chart${wide ? " wide" : ""}`}>
      <div className="service-overview-chart-head"><span className="service-overview-chart-icon">{icon}</span><span><h3>{title}</h3><small>{detail}</small></span><strong>{value}</strong></div>
      <div className="service-overview-legend">{series.map((item) => <span key={item.key}><i style={{ background: item.color }} />{item.label}</span>)}</div>
      <div className="service-overview-chart-canvas">
        {points.length < 2 ? <div className="chart-empty"><Activity size={20} /><span>正在收集历史采样</span></div> : <ResponsiveContainer><LineChart data={points} margin={{ top: 8, right: 10, left: 0, bottom: 0 }}><CartesianGrid stroke="var(--chart-grid)" vertical={false} /><XAxis dataKey="timestamp" tickFormatter={(value) => chartTimeLabel(Number(value), period)} tickLine={false} axisLine={false} minTickGap={48} tick={{ fill: "var(--text-muted)", fontSize: 9 }} /><YAxis domain={percent ? [0, 100] : [0, "auto"]} width={speed ? 52 : 48} tickLine={false} axisLine={false} tick={<ChartYAxisTick formatter={(value) => percent ? `${Math.round(value)}%` : speed ? formatSpeedCompact(value) : chartNumberLabel(value)} fontSize={9} />} /><Tooltip labelFormatter={(value) => chartTimeLabel(Number(value), period)} formatter={(value: number, name: string) => [percent ? `${Number(value).toFixed(1)}%` : speed ? formatSpeed(Number(value)) : chartNumberLabel(Number(value)), name]} contentStyle={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 6, fontSize: 10 }} />{series.map((item) => <Line key={item.key} type="monotone" dataKey={item.key} name={item.label} stroke={item.color} strokeWidth={1.8} dot={false} isAnimationActive={false} />)}</LineChart></ResponsiveContainer>}
      </div>
    </article>
  );
}

function ResourceStats({ items }: { items: Array<{ label: string; value: string; detail?: string }> }) {
  return <section className="service-overview-resource-stats">{items.map((item) => <div key={item.label}><small>{item.label}</small><b>{item.value}</b>{item.detail && <span>{item.detail}</span>}</div>)}</section>;
}

function CapacityBreakdown({ title, used, total, color }: { title: string; used: number; total: number; color: string }) {
  const safeTotal = Math.max(0, total);
  const safeUsed = Math.min(Math.max(0, used), safeTotal || used);
  const available = Math.max(0, safeTotal - safeUsed);
  const percent = safeTotal ? Math.min(100, safeUsed / safeTotal * 100) : 0;
  return (
    <section className="service-overview-breakdown">
      <header><span><b>{title}</b><small>容量分布</small></span><strong>{percent.toFixed(1)}%</strong></header>
      <div className="service-overview-capacity-meter"><span style={{ width: `${percent}%`, background: color }} /></div>
      <div className="service-overview-capacity-values"><span><small>总容量</small><b>{formatBytes(safeTotal)}</b></span><span><small>已使用</small><b style={{ color }}>{formatBytes(safeUsed)}</b></span><span><small>可用</small><b>{formatBytes(available)}</b></span></div>
    </section>
  );
}

export default function ServiceOverview({ servers }: { servers: ServerMetric[] }) {
  const [selectedId, setSelectedId] = useState(servers[0]?.id || "");
  const [period, setPeriod] = useState<HistoryPeriod>("realtime");
  const [resource, setResource] = useState<ResourceTab>("cpu");
  const [points, setPoints] = useState<HistoryPoint[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);
  const [refreshMode, setRefreshMode] = useState<RefreshMode>(() => {
    const stored = localStorage.getItem("orange-probe-service-refresh");
    return stored === "15s" || stored === "manual" ? stored : "live";
  });
  const selected = useMemo(() => servers.find((server) => server.id === selectedId) || servers[0] || null, [selectedId, servers]);
  const serverOptions = useMemo(() => servers.map((server) => ({ value: server.id, label: `${server.name} · ${server.ip}` })), [servers]);

  useEffect(() => {
    if (selected && selected.id !== selectedId) setSelectedId(selected.id);
  }, [selected, selectedId]);

  useEffect(() => {
    localStorage.setItem("orange-probe-service-refresh", refreshMode);
  }, [refreshMode]);

  useEffect(() => {
    if (!selected?.id) return setPoints([]);
    let disposed = false;
    const load = async () => {
      setLoading(true);
      try {
        const response = await fetch(`/api/servers/${encodeURIComponent(selected.id)}/history?period=${period}`);
        if (!response.ok) throw new Error("无法读取节点历史数据");
        const payload = await response.json() as { points: HistoryPoint[] };
        if (!disposed) { setPoints(payload.points); setError(""); }
      } catch (loadError) {
        if (!disposed) setError(loadError instanceof Error ? loadError.message : "历史数据加载失败");
      } finally {
        if (!disposed) setLoading(false);
      }
    };
    load();
    const interval = refreshMode === "live" ? 5000 : refreshMode === "15s" ? 15000 : 0;
    const timer = interval ? window.setInterval(load, interval) : undefined;
    return () => { disposed = true; if (timer) window.clearInterval(timer); };
  }, [period, refreshKey, refreshMode, selected?.id]);

  if (!selected) return <div className="management-empty"><Server size={26} /><b>暂无节点</b><span>Agent 上报后即可查看资源历史</span></div>;

  const availableMemory = Math.max(0, selected.memory.total - selected.memory.used);
  const availableSwap = Math.max(0, selected.swap.total - selected.swap.used);
  const availableDisk = Math.max(0, selected.disk.total - selected.disk.used);
  const disks = selected.disks || [];
  const networkInterfaces = selected.networkInterfaces || [];
  const resourceTabs: Array<{ id: ResourceTab; label: string; icon: ReactNode }> = [
    { id: "cpu", label: "CPU", icon: <Cpu size={15} /> },
    { id: "memory", label: "Memory", icon: <MemoryStick size={15} /> },
    { id: "disk", label: "Disk", icon: <HardDrive size={15} /> },
    { id: "network", label: "Network", icon: <Network size={15} /> },
  ];

  return (
    <div className="page-stack service-overview-page">
      <section className="service-overview-toolbar">
        <div className="service-overview-select-control server-select"><Server size={16} /><SelectMenu label="选择服务器" value={selected.id} options={serverOptions} onChange={setSelectedId} /></div>
        <div className="service-overview-select-control refresh-select"><Clock3 size={16} /><SelectMenu label="自动刷新频率" value={refreshMode} options={refreshOptions} onChange={setRefreshMode} /></div>
        <div className="service-overview-period segmented"><button className={period === "realtime" ? "active" : ""} onClick={() => setPeriod("realtime")}>实时</button><button className={period === "1d" ? "active" : ""} onClick={() => setPeriod("1d")}>1 天</button><button className={period === "7d" ? "active" : ""} onClick={() => setPeriod("7d")}>7 天</button></div>
        <button className="icon-button" onClick={() => setRefreshKey((value) => value + 1)} title="刷新历史数据"><RefreshCw className={loading ? "spin" : ""} size={16} /></button>
      </section>
      <section className="service-overview-summary">
        <span className="service-overview-node"><i><Server size={19} /></i><span><b>{selected.name}</b><small>{selected.id}</small></span></span>
        <div><small>状态</small><b className={`service-overview-status ${selected.status}`}><StatusDot status={selected.status} />{selected.status === "online" ? "在线" : "离线"}</b></div>
        <div><small>在线时长</small><b>{formatUptime(selected.uptime)}</b></div>
        <div><small>最后上报</small><b>{formatRelativeTime(selected.lastSeen)}</b></div>
        <div><small>系统 / 版本</small><b>{selected.os} · {selected.version}</b></div>
        <a href={`/server/${encodeURIComponent(selected.id)}`} target="_blank" rel="noreferrer"><ExternalLink size={14} />公开详情</a>
      </section>
      <nav className="service-overview-resource-tabs" aria-label="资源类型">{resourceTabs.map((tab) => <button key={tab.id} className={resource === tab.id ? "active" : ""} onClick={() => setResource(tab.id)} aria-pressed={resource === tab.id}>{tab.icon}<span>{tab.label}</span></button>)}</nav>
      {error && <div className="service-test-message"><Activity size={15} />{error}</div>}

      {resource === "cpu" && <div className="service-overview-resource" data-resource="cpu">
        <ResourceStats items={[
          { label: "总利用率", value: `${selected.cpu.toFixed(1)}%`, detail: `${selected.cpuCores} 个逻辑核心` },
          { label: "1 / 5 / 15 分钟负载", value: selected.load.map((value) => value.toFixed(2)).join(" / "), detail: "系统负载" },
          { label: "进程数", value: String(selected.processCount), detail: "当前活动进程" },
          { label: "处理器", value: selected.cpuModel, detail: selected.arch },
        ]} />
        <section className="cpu-core-panel">
          <header><span><b>CPU 核心占用</b><small>当前每个逻辑核心的实时利用率</small></span><strong>{selected.cpuCoreUsage?.length || selected.cpuCores} 核</strong></header>
          {selected.cpuCoreUsage?.length ? <div className="cpu-core-grid">{selected.cpuCoreUsage.map((usage, index) => <div key={index}><span><small>Core {index + 1}</small><b>{usage.toFixed(1)}%</b></span><i><em className={usage >= 85 ? "danger" : usage >= 65 ? "warning" : "healthy"} style={{ width: `${Math.min(100, usage)}%` }} /></i></div>)}</div> : <div className="cpu-core-empty"><Activity size={16} />等待新版 Agent 上报逐核心数据</div>}
        </section>
        <section className="service-overview-chart-grid">
          <MetricChart wide title="CPU 利用率" icon={<Cpu size={18} />} value={`${selected.cpu.toFixed(1)}%`} detail={`${selected.cpuModel} · ${selected.cpuCores} 核`} points={points} period={period} series={[{ key: "cpu", label: "CPU", color: "#3478f6" }]} percent />
          <MetricChart title="负载" icon={<Activity size={18} />} value={selected.load[0]?.toFixed(2) || "0.00"} detail={`当前 1m / 5m / 15m：${selected.load.map((value) => value.toFixed(2)).join(" / ")}`} points={points} period={period} series={[{ key: "load", label: "1 分钟负载", color: "#168c73" }]} />
          <MetricChart title="进程" icon={<Activity size={18} />} value={String(selected.processCount)} detail="活动进程数量" points={points} period={period} series={[{ key: "processCount", label: "进程", color: "#ed5f8d" }]} />
        </section>
      </div>}

      {resource === "memory" && <div className="service-overview-resource" data-resource="memory">
        <ResourceStats items={[
          { label: "使用率", value: `${selected.memory.percent.toFixed(1)}%`, detail: "物理内存" },
          { label: "总内存", value: formatBytes(selected.memory.total) },
          { label: "已使用", value: formatBytes(selected.memory.used) },
          { label: "可用", value: formatBytes(availableMemory) },
          { label: "SWAP 使用率", value: selected.swap.total ? `${selected.swap.percent.toFixed(1)}%` : "未启用", detail: "虚拟内存" },
          { label: "SWAP 可用", value: selected.swap.total ? formatBytes(availableSwap) : "--" },
        ]} />
        <section className="service-overview-chart-grid"><MetricChart wide title="内存与虚拟内存使用率" icon={<MemoryStick size={18} />} value={`${selected.memory.percent.toFixed(1)}% / ${selected.swap.percent.toFixed(1)}%`} detail={`MEM ${formatBytes(selected.memory.used)} / ${formatBytes(selected.memory.total)} · SWAP ${selected.swap.total ? `${formatBytes(selected.swap.used)} / ${formatBytes(selected.swap.total)}` : "未启用"}`} points={points} period={period} series={[{ key: "memory", label: "Memory", color: "#9b6ce7" }, { key: "swap", label: "SWAP", color: "#e68a2e" }]} percent /></section>
        <CapacityBreakdown title="物理内存" used={selected.memory.used} total={selected.memory.total} color="#9b6ce7" />
        <CapacityBreakdown title={selected.swap.total ? "虚拟内存" : "虚拟内存（未启用）"} used={selected.swap.used} total={selected.swap.total} color="#e68a2e" />
      </div>}

      {resource === "disk" && <div className="service-overview-resource" data-resource="disk">
        <ResourceStats items={[
          { label: "使用率", value: `${selected.disk.percent.toFixed(1)}%`, detail: "文件系统容量" },
          { label: "总容量", value: formatBytes(selected.disk.total) },
          { label: "已使用", value: formatBytes(selected.disk.used) },
          { label: "可用", value: formatBytes(availableDisk) },
          { label: "磁盘数量", value: String(selected.diskCount ?? disks.length), detail: "文件系统卷 / 挂载点" },
        ]} />
        <section className="service-overview-chart-grid"><MetricChart wide title="磁盘使用率" icon={<HardDrive size={18} />} value={`${selected.disk.percent.toFixed(1)}%`} detail={`${formatBytes(selected.disk.used)} / ${formatBytes(selected.disk.total)}`} points={points} period={period} series={[{ key: "disk", label: "Disk", color: "#168c73" }]} percent /></section>
        <CapacityBreakdown title="文件系统" used={selected.disk.used} total={selected.disk.total} color="#168c73" />
        <section className="service-overview-inventory">
          <header><span><HardDrive size={17} /><span><b>磁盘与挂载点</b><small>Agent 当前检测到的文件系统卷</small></span></span><strong>{selected.diskCount ?? disks.length} 个</strong></header>
          <div>{disks.length ? disks.map((disk, index) => <article key={`${disk.name}-${disk.mount}-${index}`}><span><b>{disk.name}</b><small>{disk.mount || "未提供挂载点"}</small></span><span><b>{formatBytes(disk.total)}</b><small>已用 {formatBytes(disk.used)} · {disk.percent.toFixed(1)}%</small></span></article>) : <p>等待新版 Agent 上报磁盘清单</p>}</div>
        </section>
      </div>}

      {resource === "network" && <div className="service-overview-resource" data-resource="network">
        <ResourceStats items={[
          { label: "实时下载", value: formatSpeed(selected.network.downloadSpeed), detail: `累计 ${formatBytes(selected.network.downloadTotal)}` },
          { label: "实时上传", value: formatSpeed(selected.network.uploadSpeed), detail: `累计 ${formatBytes(selected.network.uploadTotal)}` },
          { label: "TCP 连接", value: String(selected.tcpConnections), detail: "当前连接数" },
          { label: "UDP 套接字", value: String(selected.udpConnections), detail: "当前监听与活动套接字" },
          { label: "网卡数量", value: String(selected.networkInterfaceCount ?? networkInterfaces.length), detail: "非回环活动接口" },
          { label: "累计流量", value: formatBytes(selected.network.downloadTotal + selected.network.uploadTotal), detail: "下载与上传合计" },
        ]} />
        <section className="service-overview-chart-grid">
          <MetricChart wide title="网络" icon={<Network size={18} />} value={formatSpeed(selected.network.downloadSpeed + selected.network.uploadSpeed)} detail={`下载 ${formatSpeed(selected.network.downloadSpeed)} · 上传 ${formatSpeed(selected.network.uploadSpeed)}`} points={points} period={period} series={[{ key: "download", label: "下载", color: "#9b6ce7" }, { key: "upload", label: "上传", color: "#3478f6" }]} speed />
          <MetricChart wide title="连接数" icon={<Network size={18} />} value={`${selected.tcpConnections} TCP / ${selected.udpConnections} UDP`} detail="当前 TCP 连接与 UDP 套接字" points={points} period={period} series={[{ key: "tcpConnections", label: "TCP", color: "#7c62e3" }, { key: "udpConnections", label: "UDP", color: "#e68a2e" }]} />
        </section>
        <section className="service-overview-inventory network-inventory">
          <header><span><Network size={17} /><span><b>活动网卡</b><small>仅后台显示接口名称、地址与 MAC</small></span></span><strong>{selected.networkInterfaceCount ?? networkInterfaces.length} 个</strong></header>
          <div>{networkInterfaces.length ? networkInterfaces.map((item) => <article key={item.name}><span><b>{item.name}</b><small>{item.addresses.length ? item.addresses.join(" · ") : "未分配地址"}</small></span><span><b>{item.mac || "无 MAC"}</b><small>{item.addresses.length} 个地址</small></span></article>) : <p>等待新版 Agent 上报网卡清单</p>}</div>
        </section>
      </div>}

      <div className="service-overview-retention"><Clock3 size={14} /><span>指标每 30 秒持久化，最多保留 7 天；图表会根据时间范围自动降采样。</span><span><ArrowDown size={13} />下载</span><span><ArrowUp size={13} />上传</span></div>
    </div>
  );
}
