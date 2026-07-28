export function dateParts(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ""))) return null;
  const [year, monthNumber, day] = String(value).split("-").map(Number);
  const month = monthNumber - 1;
  const timestamp = Date.UTC(year, month, day);
  const parsed = new Date(timestamp);
  if (
    parsed.getUTCFullYear() !== year
    || parsed.getUTCMonth() !== month
    || parsed.getUTCDate() !== day
  ) return null;
  return { year, month, day };
}

export function monthAnchorTimestamp(year, month, day) {
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return Date.UTC(year, month, Math.min(day, lastDay));
}

export function trafficResetAnchorForConfig(config = {}) {
  const candidates = config.billingCycle === "monthly"
    ? [["expirationDate", config.expirationDate], ["purchaseDate", config.purchaseDate]]
    : [["purchaseDate", config.purchaseDate], ["expirationDate", config.expirationDate]];
  for (const [source, value] of candidates) {
    const parts = dateParts(value);
    if (parts) return { ...parts, source, value: String(value) };
  }
  return { day: 1, source: "default", value: "" };
}

export function trafficWindowForConfig(config = {}, now = Date.now()) {
  const anchor = trafficResetAnchorForConfig(config);
  const current = new Date(now);
  let year = current.getUTCFullYear();
  let month = current.getUTCMonth();
  let start = monthAnchorTimestamp(year, month, anchor.day);
  if (start > now) {
    month -= 1;
    if (month < 0) {
      month = 11;
      year -= 1;
    }
    start = monthAnchorTimestamp(year, month, anchor.day);
  }
  let nextYear = year;
  let nextMonth = month + 1;
  if (nextMonth > 11) {
    nextMonth = 0;
    nextYear += 1;
  }
  const end = monthAnchorTimestamp(nextYear, nextMonth, anchor.day);
  return {
    key: `${new Date(start).toISOString()}:${new Date(end).toISOString()}`,
    start,
    end,
    resetDay: anchor.day,
    anchorSource: anchor.source,
    anchorDate: anchor.value,
  };
}

export function trafficCounterDelta(current, previous, currentKey = "", previousKey = "") {
  const normalizedCurrent = {
    download: Math.max(0, Number(current?.download) || 0),
    upload: Math.max(0, Number(current?.upload) || 0),
  };
  const normalizedPrevious = {
    download: Math.max(0, Number(previous?.download) || 0),
    upload: Math.max(0, Number(previous?.upload) || 0),
  };
  const normalizedCurrentKey = String(currentKey || "");
  const normalizedPreviousKey = String(previousKey || "");
  const keyChanged = normalizedCurrentKey !== normalizedPreviousKey
    && Boolean(normalizedCurrentKey || normalizedPreviousKey);
  const rolledBack = normalizedCurrent.download < normalizedPrevious.download
    || normalizedCurrent.upload < normalizedPrevious.upload;
  if (keyChanged || rolledBack) return { download: 0, upload: 0, rebased: true };
  return {
    download: normalizedCurrent.download - normalizedPrevious.download,
    upload: normalizedCurrent.upload - normalizedPrevious.upload,
    rebased: false,
  };
}
