import {
  ArrowDown,
  ArrowRight,
  ArrowUp,
  Box,
  Clock3,
  Cpu,
  Database,
  HardDrive,
  MapPin,
  MemoryStick,
  Radio,
  Server,
  Thermometer,
} from "lucide-react";
import type { ReactNode } from "react";
import type { ServerMetric, ServerSla } from "../types";
import { formatBytes, formatRelativeTime, formatSpeed, formatUptime, severityClass } from "../lib/format";

export function StatusDot({ status, pulse = false }: { status: ServerMetric["status"]; pulse?: boolean }) {
  return <span className={`status-dot ${status}${pulse && status === "online" ? " pulse" : ""}`} />;
}

export function UsageBar({ value }: { value: number }) {
  return (
    <div className="usage-track" role="progressbar" aria-valuenow={Math.round(value)} aria-valuemin={0} aria-valuemax={100}>
      <span className={severityClass(value)} style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
    </div>
  );
}

export function StatCard({
  label,
  value,
  detail,
  icon,
  tone = "neutral",
}: {
  label: string;
  value: string;
  detail: string;
  icon: ReactNode;
  tone?: "neutral" | "green" | "orange" | "blue";
}) {
  return (
    <article className="stat-card">
      <div className={`stat-icon ${tone}`}>{icon}</div>
      <div className="stat-copy">
        <span>{label}</span>
        <strong>{value}</strong>
        <small>{detail}</small>
      </div>
    </article>
  );
}

function NodeMetric({ icon, label, value, percent }: { icon: ReactNode; label: string; value: string; percent: number }) {
  return (
    <div className="node-metric">
      <div className="node-metric-label"><span>{icon}{label}</span><b>{value}</b></div>
      <UsageBar value={percent} />
    </div>
  );
}

export function NodeCard({ server, onClick }: { server: ServerMetric; onClick: () => void }) {
  const offline = server.status === "offline";
  return (
    <button className={`node-card${offline ? " is-offline" : ""}`} onClick={onClick}>
      <div className="node-card-head">
        <div className="node-identity">
          <span className="node-os-icon"><Server size={19} /></span>
          <span>
            <strong>{server.name}</strong>
            <small><MapPin size={12} />{server.location}<i>·</i>{server.ip}</small>
          </span>
        </div>
        <span className={`status-badge ${server.status}`}><StatusDot status={server.status} pulse />{offline ? "离线" : "在线"}</span>
      </div>

      <div className="node-card-body">
        {offline ? (
          <div className="offline-message">
            <Radio size={20} />
            <span><b>连接已中断</b><small>最后上报于 {formatRelativeTime(server.lastSeen)}</small></span>
          </div>
        ) : (
          <>
            <NodeMetric icon={<Cpu size={13} />} label="CPU" value={`${server.cpu.toFixed(1)}%`} percent={server.cpu} />
            <NodeMetric icon={<MemoryStick size={13} />} label="内存" value={`${server.memory.percent.toFixed(1)}%`} percent={server.memory.percent} />
            <NodeMetric icon={<HardDrive size={13} />} label="磁盘" value={`${server.disk.percent.toFixed(1)}%`} percent={server.disk.percent} />
          </>
        )}
      </div>

      <div className="node-card-foot">
        <span><ArrowDown size={13} />{formatSpeed(server.network.downloadSpeed)}</span>
        <span><ArrowUp size={13} />{formatSpeed(server.network.uploadSpeed)}</span>
        <span className="uptime"><Clock3 size={13} />{formatUptime(server.uptime)}</span>
        <ArrowRight className="node-arrow" size={15} />
      </div>
    </button>
  );
}

export function ServerTable({ servers, onSelect }: { servers: ServerMetric[]; onSelect: (server: ServerMetric) => void }) {
  return (
    <div className="server-table-wrap">
      <table className="server-table">
        <thead>
          <tr><th>节点</th><th>状态</th><th>CPU</th><th>内存</th><th>磁盘</th><th>网络</th><th>在线时长</th><th /></tr>
        </thead>
        <tbody>
          {servers.map((server) => (
            <tr key={server.id} onClick={() => onSelect(server)}>
              <td>
                <div className="table-node"><span className="node-os-icon"><Server size={17} /></span><span><b>{server.name}</b><small>{server.location} · {server.ip}</small></span></div>
              </td>
              <td><span className={`status-badge ${server.status}`}><StatusDot status={server.status} />{server.status === "online" ? "在线" : "离线"}</span></td>
              <td><div className="table-usage"><span>{server.cpu.toFixed(1)}%</span><UsageBar value={server.cpu} /></div></td>
              <td><div className="table-usage"><span>{server.memory.percent.toFixed(1)}%</span><UsageBar value={server.memory.percent} /></div></td>
              <td><div className="table-usage"><span>{server.disk.percent.toFixed(1)}%</span><UsageBar value={server.disk.percent} /></div></td>
              <td><div className="table-network"><span><ArrowDown size={12} />{formatSpeed(server.network.downloadSpeed)}</span><span><ArrowUp size={12} />{formatSpeed(server.network.uploadSpeed)}</span></div></td>
              <td>{formatUptime(server.uptime)}</td>
              <td><ArrowRight size={15} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function HealthList({ servers, sla }: { servers: ServerMetric[]; sla: ServerSla[] }) {
  return (
    <div className="health-list">
      {servers.map((server) => {
        const metric = sla.find((item) => item.serverId === server.id);
        const score = metric?.sla ?? (server.status === "online" ? 100 : 0);
        const tone = score >= 99.9 ? "good" : score >= 99 ? "warning" : "danger";
        return (
          <div className="health-row" key={server.id}>
            <span className="health-name"><span><b>{server.name}</b><small>{metric ? `${metric.days} 天 · ${metric.observedDays || 1} 天有采样` : "等待 SLA 采样"}</small></span></span>
            <div className="health-bar"><span className={tone} style={{ width: `${score}%` }} /></div>
            <strong>{`${score.toFixed(3)}%`}</strong>
          </div>
        );
      })}
    </div>
  );
}

export function NetworkRanking({ servers }: { servers: ServerMetric[] }) {
  const ranked = [...servers]
    .filter((server) => server.status === "online")
    .sort((a, b) => b.network.downloadSpeed + b.network.uploadSpeed - a.network.downloadSpeed - a.network.uploadSpeed);
  const maximum = Math.max(1, ...ranked.map((server) => server.network.downloadSpeed + server.network.uploadSpeed));
  return (
    <div className="ranking-list">
      {ranked.map((server, index) => {
        const total = server.network.downloadSpeed + server.network.uploadSpeed;
        return (
          <div className="ranking-row" key={server.id}>
            <span className="rank-index">{String(index + 1).padStart(2, "0")}</span>
            <span className="rank-name"><b>{server.name}</b><small>{server.location}</small></span>
            <div className="rank-meter"><span style={{ width: `${(total / maximum) * 100}%` }} /></div>
            <span className="rank-values"><b><ArrowDown size={12} />{formatSpeed(server.network.downloadSpeed)}</b><small><ArrowUp size={11} />{formatSpeed(server.network.uploadSpeed)}</small></span>
          </div>
        );
      })}
    </div>
  );
}

export function DetailMetricGrid({ server }: { server: ServerMetric }) {
  const rows = [
    { icon: <Cpu size={17} />, label: "CPU 使用率", value: `${server.cpu.toFixed(1)}%`, detail: `${server.cpuCores} 核 · ${server.load[0]?.toFixed(2) || "0.00"} 负载` },
    { icon: <MemoryStick size={17} />, label: "内存", value: `${server.memory.percent.toFixed(1)}%`, detail: `${formatBytes(server.memory.used)} / ${formatBytes(server.memory.total)}` },
    { icon: <Database size={17} />, label: "虚拟内存", value: server.swap.total ? `${server.swap.percent.toFixed(1)}%` : "未启用", detail: server.swap.total ? `${formatBytes(server.swap.used)} / ${formatBytes(server.swap.total)}` : "未配置 SWAP / 分页文件" },
    { icon: <HardDrive size={17} />, label: "磁盘", value: `${server.disk.percent.toFixed(1)}%`, detail: `${formatBytes(server.disk.used)} / ${formatBytes(server.disk.total)}` },
    { icon: <Thermometer size={17} />, label: "温度", value: server.temperature ? `${server.temperature.toFixed(1)}°C` : "--", detail: "CPU Package" },
    { icon: <Box size={17} />, label: "进程", value: String(server.processCount), detail: `${server.tcpConnections} TCP · ${server.udpConnections} UDP` },
    { icon: <Database size={17} />, label: "累计流量", value: formatBytes(server.network.downloadTotal + server.network.uploadTotal), detail: `下 ${formatBytes(server.network.downloadTotal)} · 上 ${formatBytes(server.network.uploadTotal)}` },
  ];
  return (
    <div className="detail-metric-grid">
      {rows.map((row) => <div className="detail-metric" key={row.label}><span>{row.icon}</span><div><small>{row.label}</small><b>{row.value}</b><em>{row.detail}</em></div></div>)}
    </div>
  );
}
