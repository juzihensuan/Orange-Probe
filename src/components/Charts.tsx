import { Activity, ArrowDown, ArrowUp } from "lucide-react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { AggregatePoint, HistoryPoint } from "../types";
import { formatSpeed, formatSpeedCompact, timeLabel } from "../lib/format";

interface TooltipEntry {
  dataKey?: string;
  value?: number;
  color?: string;
  name?: string;
}

export function ChartYAxisTick({ y = 0, payload, formatter, fontSize = 10, fontWeight = 600 }: { y?: number; payload?: { value?: number | string }; formatter: (value: number) => string; fontSize?: number; fontWeight?: number }) {
  return <text x={2} y={y} dy="0.32em" fill="var(--text-muted)" fontSize={fontSize} fontWeight={fontWeight} textAnchor="start">{formatter(Number(payload?.value) || 0)}</text>;
}

function TrafficTooltip({ active, payload, label }: { active?: boolean; payload?: TooltipEntry[]; label?: number }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="chart-tooltip">
      <span>{label ? timeLabel(label) : ""}</span>
      {payload.map((entry) => (
        <b key={entry.dataKey} style={{ color: entry.color }}>
          {entry.dataKey === "download" ? "下载" : "上传"} {formatSpeed(entry.value || 0)}
        </b>
      ))}
    </div>
  );
}

export function TrafficChart({ data, height = 250 }: { data: AggregatePoint[] | HistoryPoint[]; height?: number }) {
  return (
    <div style={{ width: "100%", height }} className="chart-wrap">
      {data.length < 2 ? (
        <div className="chart-empty"><Activity size={22} /><span>正在收集实时数据</span></div>
      ) : (
        <ResponsiveContainer>
          <AreaChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid stroke="var(--chart-grid)" vertical={false} />
            <XAxis dataKey="timestamp" tickFormatter={timeLabel} tickLine={false} axisLine={false} minTickGap={45} tick={{ fill: "var(--text-muted)", fontSize: 11 }} />
            <YAxis tickLine={false} axisLine={false} width={52} tick={<ChartYAxisTick formatter={formatSpeedCompact} fontSize={10} />} />
            <Tooltip content={<TrafficTooltip />} />
            <Area type="monotone" dataKey="download" name="下载" stroke="#168c73" strokeWidth={2} fill="#168c73" fillOpacity={0.09} isAnimationActive={false} />
            <Area type="monotone" dataKey="upload" name="上传" stroke="#dd6b20" strokeWidth={2} fill="#dd6b20" fillOpacity={0.06} isAnimationActive={false} />
          </AreaChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}

function PercentTooltip({ active, payload, label }: { active?: boolean; payload?: TooltipEntry[]; label?: number }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="chart-tooltip">
      <span>{label ? timeLabel(label) : ""}</span>
      {payload.map((entry) => <b key={entry.dataKey} style={{ color: entry.color }}>{entry.name} {(entry.value || 0).toFixed(1)}%</b>)}
    </div>
  );
}

export function ResourceChart({ data, height = 245 }: { data: HistoryPoint[]; height?: number }) {
  return (
    <div style={{ width: "100%", height }} className="chart-wrap">
      {data.length < 2 ? (
        <div className="chart-empty"><Activity size={22} /><span>等待更多采样点</span></div>
      ) : (
        <ResponsiveContainer>
          <LineChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid stroke="var(--chart-grid)" vertical={false} />
            <XAxis dataKey="timestamp" tickFormatter={timeLabel} tickLine={false} axisLine={false} minTickGap={45} tick={{ fill: "var(--text-muted)", fontSize: 11 }} />
            <YAxis domain={[0, 100]} tickLine={false} axisLine={false} width={48} tick={<ChartYAxisTick formatter={(value) => `${value}%`} fontSize={10} />} />
            <Tooltip content={<PercentTooltip />} />
            <Line type="monotone" dataKey="cpu" name="CPU" dot={false} stroke="#dd6b20" strokeWidth={2} isAnimationActive={false} />
            <Line type="monotone" dataKey="memory" name="内存" dot={false} stroke="#3478f6" strokeWidth={2} isAnimationActive={false} />
            <Line type="monotone" dataKey="disk" name="磁盘" dot={false} stroke="#168c73" strokeWidth={2} isAnimationActive={false} />
          </LineChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}

export function ChartLegend() {
  return (
    <div className="chart-legend">
      <span><i className="legend-dot download" /><ArrowDown size={13} /> 下载</span>
      <span><i className="legend-dot upload" /><ArrowUp size={13} /> 上传</span>
    </div>
  );
}
