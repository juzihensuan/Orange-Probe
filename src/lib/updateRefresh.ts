export const pendingServerRefreshKey = "orange-probe-pending-server-refresh";

export interface PendingServerRefresh {
  fromVersion: string;
  targetVersion: string;
  requestedAt: number;
}

export function readPendingServerRefresh() {
  try {
    const value = JSON.parse(sessionStorage.getItem(pendingServerRefreshKey) || "null") as PendingServerRefresh | null;
    return value?.targetVersion ? value : null;
  } catch {
    sessionStorage.removeItem(pendingServerRefreshKey);
    return null;
  }
}

export function savePendingServerRefresh(value: PendingServerRefresh) {
  sessionStorage.setItem(pendingServerRefreshKey, JSON.stringify(value));
}

export function clearPendingServerRefresh() {
  sessionStorage.removeItem(pendingServerRefreshKey);
}
