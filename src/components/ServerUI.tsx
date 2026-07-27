import {
  Box,
  Cpu,
  Database,
  HardDrive,
  MemoryStick,
  Thermometer,
} from "lucide-react";
import type { ReactNode } from "react";
import type { ServerMetric, ServerSla } from "../types";
import { formatBytes, severityClass } from "../lib/format";

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
