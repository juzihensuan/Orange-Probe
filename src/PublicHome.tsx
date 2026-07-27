import {
  Activity,
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  CircleDot,
  Grid2X2,
  LayoutList,
  LogIn,
  Moon,
  Search,
  Server,
  Sun,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useProbe } from "./hooks/useProbe";
import { formatBytes, formatSpeed } from "./lib/format";
import type { ServerMetric } from "./types";
import RegionFlag from "./components/RegionFlag";
import SelectMenu from "./components/SelectMenu";

type PublicSort = "default" | "name" | "uptime" | "cpu" | "memory" | "disk" | "download" | "upload";
type PublicLayout = "grid" | "list";

const publicSortOptions: Array<{ value: PublicSort; label: string }> = [
  { value: "default", label: "默认" },
  { value: "name", label: "名称" },
  { value: "uptime", label: "运行时间" },
  { value: "cpu", label: "CPU" },
  { value: "memory", label: "内存" },
  { value: "disk", label: "磁盘" },
  { value: "download", label: "下载" },
  { value: "upload", label: "上传" },
];

function PublicMetric({ label, value, percent }: { label: string; value: string; percent?: number }) {
  return (
    <span className="public-metric">
      <small>{label}</small>
      <b>{value}</b>
      {percent !== undefined && <i><em className={percent >= 90 ? "danger" : percent >= 70 ? "warning" : "healthy"} style={{ width: `${Math.min(100, Math.max(0, percent))}%` }} /></i>}
    </span>
  );
}

function PublicServerCard({ server, onClick }: { server: ServerMetric; onClick: () => void }) {
  const offline = server.status === "offline";
  return (
    <button className={`public-server-card${offline ? " offline" : ""}`} onClick={onClick}>
      <span className="public-server-identity">
        <span className="public-server-name">
          <i className={`public-status ${server.status}`} />
          <RegionFlag location={server.location} countryCode={server.countryCode} />
          <strong>{server.name}</strong>
        </span>
      </span>
      {!offline ? (
        <span className="public-server-metrics">
          <PublicMetric label="CPU" value={`${server.cpu.toFixed(1)}%`} percent={server.cpu} />
          <PublicMetric label="MEM" value={`${server.memory.percent.toFixed(1)}%`} percent={server.memory.percent} />
          <PublicMetric label="SWP" value={server.swap.total ? `${server.swap.percent.toFixed(1)}%` : "未启用"} percent={server.swap.total ? server.swap.percent : undefined} />
          <PublicMetric label="STG" value={formatBytes(server.disk.total)} percent={server.disk.percent} />
          <PublicMetric label="上传" value={formatSpeed(server.network.uploadSpeed).replace("/s", "/s")} />
          <PublicMetric label="下载" value={formatSpeed(server.network.downloadSpeed).replace("/s", "/s")} />
        </span>
      ) : (
        <span className="public-offline-copy">暂时离线</span>
      )}
      <span className="public-traffic-usage">
        <span className="public-traffic-copy"><small>本期流量</small><b>{formatBytes(server.trafficUsed || 0)}<em> / {server.trafficLimitBytes ? formatBytes(server.trafficLimitBytes) : "未设置"}</em></b></span>
        <span className="public-traffic-breakdown"><small>上传 <b>{formatBytes(server.trafficUploadUsed || 0)}</b></small><small>下载 <b>{formatBytes(server.trafficDownloadUsed || 0)}</b></small></span>
        <i><em className={(server.trafficPercent || 0) >= 100 ? "danger" : (server.trafficPercent || 0) >= 80 ? "warning" : "healthy"} style={{ width: `${server.trafficLimitBytes ? Math.min(100, server.trafficPercent || 0) : 0}%` }} /></i>
      </span>
    </button>
  );
}

function SummaryCard({ label, value, tone }: { label: string; value: string; tone: "blue" | "green" | "red" }) {
  return (
    <article className="public-summary-card">
      <span>{label}</span>
      <strong><i className={tone} />{value}</strong>
    </article>
  );
}

export default function PublicHome() {
  const { servers, connected } = useProbe({ respectPublicRefresh: true });
  const [searchOpen, setSearchOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<PublicSort>("default");
  const [layout, setLayout] = useState<PublicLayout>("grid");
  const [now, setNow] = useState(new Date());
  const [dark, setDark] = useState(() => localStorage.getItem("orange-probe-theme") === "dark");

  useEffect(() => {
    document.title = "Orange Probe · Server Status";
    const timer = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    localStorage.setItem("orange-probe-theme", dark ? "dark" : "light");
  }, [dark]);

  const visibleServers = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const filtered = servers.filter((server) => !needle || [server.name, server.location, server.os, ...server.tags].some((value) => value.toLowerCase().includes(needle)));
    if (sort === "default") return filtered;
    return [...filtered].sort((a, b) => {
      if (sort === "name") return a.name.localeCompare(b.name);
      if (sort === "uptime") return b.uptime - a.uptime;
      if (sort === "cpu") return b.cpu - a.cpu;
      if (sort === "memory") return b.memory.percent - a.memory.percent;
      if (sort === "disk") return b.disk.percent - a.disk.percent;
      if (sort === "download") return b.network.downloadSpeed - a.network.downloadSpeed;
      return b.network.uploadSpeed - a.network.uploadSpeed;
    });
  }, [search, servers, sort]);

  const online = servers.filter((server) => server.status === "online");
  const totalDownload = online.reduce((sum, server) => sum + server.network.downloadSpeed, 0);
  const totalUpload = online.reduce((sum, server) => sum + server.network.uploadSpeed, 0);
  const downloadTransfer = online.reduce((sum, server) => sum + server.network.downloadTotal, 0);
  const uploadTransfer = online.reduce((sum, server) => sum + server.network.uploadTotal, 0);
  const time = new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(now);

  return (
    <div className="public-page">
      <header className="public-header">
        <a className="public-brand" href="/" aria-label="Orange Probe 首页">
          <span><Activity size={17} /></span>
          <strong>Orange</strong><b>Probe</b>
          <i />
          <em>Server Monitoring</em>
        </a>
        <nav className="public-actions">
          <a className="public-login" href="/admin"><LogIn size={14} />后台</a>
          <button className="public-icon-button" onClick={() => setSearchOpen((value) => !value)} title="搜索节点"><Search size={17} /></button>
          <button className="public-icon-button" onClick={() => setDark((value) => !value)} title={dark ? "切换浅色模式" : "切换深色模式"}>{dark ? <Sun size={17} /> : <Moon size={17} />}</button>
          <span className="public-online-pill"><b>{online.length}</b> Online <i className={connected ? "online" : "offline"} /></span>
        </nav>
      </header>

      {searchOpen && (
        <label className="public-search">
          <Search size={16} />
          <input autoFocus value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索服务器、地区或标签" />
          <button onClick={() => { setSearch(""); setSearchOpen(false); }} title="关闭搜索"><X size={15} /></button>
        </label>
      )}

      <main className="public-main">
        <section className="public-overview-heading">
          <h1>👋 运行概览</h1>
          <p>当前时间 <b>{time}</b></p>
        </section>

        <section className="public-summary-grid">
          <SummaryCard label="服务器总数" value={String(servers.length)} tone="blue" />
          <SummaryCard label="在线服务器" value={String(online.length)} tone="green" />
          <SummaryCard label="离线服务器" value={String(servers.length - online.length)} tone="red" />
          <article className="public-summary-card public-network-card">
            <span>网络流量</span>
            <small><b>上传 {formatBytes(uploadTransfer)}</b><b>下载 {formatBytes(downloadTransfer)}</b></small>
            <strong><span><ArrowUp size={12} />{formatSpeed(totalUpload)}</span><span><ArrowDown size={12} />{formatSpeed(totalDownload)}</span></strong>
          </article>
        </section>

        <section className="public-toolbar">
          <div className="public-layout-switch">
            <button className={layout === "grid" ? "active" : ""} onClick={() => setLayout("grid")} title="双列视图"><Grid2X2 size={15} /></button>
            <button className={layout === "list" ? "active" : ""} onClick={() => setLayout("list")} title="单列视图"><LayoutList size={16} /></button>
            <span><CircleDot size={14} />实时状态</span>
          </div>
          <div className="public-sort"><ArrowUpDown size={14} /><span className="public-sort-label">排序</span><i /><div className="public-sort-select"><SelectMenu label="服务器排序方式" value={sort} options={publicSortOptions} onChange={setSort} /></div></div>
        </section>

        {visibleServers.length ? (
          <section className={`public-server-grid ${layout}`}>
            {visibleServers.map((server) => <PublicServerCard key={server.id} server={server} onClick={() => { window.location.href = `/server/${encodeURIComponent(server.id)}`; }} />)}
          </section>
        ) : (
          <section className="public-empty"><Server size={24} /><strong>没有匹配的服务器</strong><span>调整搜索条件后重试</span></section>
        )}
      </main>

      <footer className="public-footer"><span>©2026 Orange Probe</span></footer>
    </div>
  );
}
