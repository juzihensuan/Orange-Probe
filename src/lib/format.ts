export function formatBytes(value: number, decimals = 1) {
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  return `${(value / 1024 ** index).toFixed(index === 0 ? 0 : decimals)} ${units[index]}`;
}

export function formatSpeed(value: number) {
  if (!Number.isFinite(value) || value <= 0) return "0 bps";
  const bits = value * 8;
  const units = ["bps", "Kbps", "Mbps", "Gbps", "Tbps"];
  const index = Math.min(Math.max(0, Math.floor(Math.log(bits) / Math.log(1000))), units.length - 1);
  const scaled = bits / 1000 ** index;
  const rounded = scaled >= 100 ? Math.round(scaled) : Number(scaled.toFixed(1));
  return `${rounded} ${units[index]}`;
}

export function formatSpeedCompact(value: number) {
  return formatSpeed(value)
    .replace(" bps", "")
    .replace(" Kbps", "K")
    .replace(" Mbps", "M")
    .replace(" Gbps", "G")
    .replace(" Tbps", "T");
}

export function formatUptime(seconds: number) {
  if (!seconds) return "--";
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days} 天 ${hours} 小时`;
  if (hours > 0) return `${hours} 小时 ${minutes} 分`;
  return `${minutes} 分钟`;
}

export function formatRelativeTime(timestamp: number) {
  const elapsed = Math.max(0, Date.now() - timestamp);
  if (elapsed < 10000) return "刚刚";
  if (elapsed < 60000) return `${Math.floor(elapsed / 1000)} 秒前`;
  if (elapsed < 3600000) return `${Math.floor(elapsed / 60000)} 分钟前`;
  if (elapsed < 86400000) return `${Math.floor(elapsed / 3600000)} 小时前`;
  return `${Math.floor(elapsed / 86400000)} 天前`;
}

export function timeLabel(timestamp: number) {
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(timestamp);
}

export function average(values: number[]) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function stableLatencyValues(values: number[]) {
  const finite = values.filter((value) => Number.isFinite(value) && value >= 0);
  if (finite.length < 3) return finite;
  const sorted = [...finite].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  const deviations = sorted.map((value) => Math.abs(value - median)).sort((left, right) => left - right);
  const deviationMiddle = Math.floor(deviations.length / 2);
  const medianDeviation = deviations.length % 2 ? deviations[deviationMiddle] : (deviations[deviationMiddle - 1] + deviations[deviationMiddle]) / 2;
  const upperBound = median + Math.max(25, median, medianDeviation * 6);
  const stable = finite.filter((value) => value <= upperBound);
  return stable.length ? stable : finite;
}

export function severityClass(value: number, warning = 70, danger = 90) {
  if (value >= danger) return "danger";
  if (value >= warning) return "warning";
  return "healthy";
}
