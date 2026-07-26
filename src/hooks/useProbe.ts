import { useCallback, useEffect, useRef, useState } from "react";
import type { AggregatePoint, ServerMetric, Snapshot } from "../types";
import { average } from "../lib/format";

const WS_RETRY_DELAY = 2500;
const PUBLIC_REFRESH_SECONDS = new Set([5, 15, 30, 60]);

export function useProbe({ respectPublicRefresh = false }: { respectPublicRefresh?: boolean } = {}) {
  const [servers, setServers] = useState<ServerMetric[]>([]);
  const [connected, setConnected] = useState(false);
  const [lastUpdate, setLastUpdate] = useState(0);
  const [aggregateHistory, setAggregateHistory] = useState<AggregatePoint[]>([]);
  const retryTimer = useRef<number | undefined>(undefined);
  const releaseTimer = useRef<number | undefined>(undefined);
  const socketRef = useRef<WebSocket | null>(null);
  const pendingSnapshot = useRef<Snapshot | null>(null);
  const lastAcceptedAt = useRef(0);

  const acceptSnapshot = useCallback((snapshot: Snapshot) => {
    lastAcceptedAt.current = Date.now();
    pendingSnapshot.current = null;
    window.clearTimeout(releaseTimer.current);
    setServers(snapshot.servers);
    setLastUpdate(snapshot.now);
    const online = snapshot.servers.filter((server) => server.status === "online");
    setAggregateHistory((current) => {
      const point: AggregatePoint = {
        timestamp: snapshot.now,
        download: online.reduce((sum, server) => sum + server.network.downloadSpeed, 0),
        upload: online.reduce((sum, server) => sum + server.network.uploadSpeed, 0),
        cpu: average(online.map((server) => server.cpu)),
        memory: average(online.map((server) => server.memory.percent)),
      };
      const next = [...current, point];
      return next.slice(-100);
    });
  }, []);

  const queueSnapshot = useCallback((snapshot: Snapshot) => {
    if (!respectPublicRefresh) {
      acceptSnapshot(snapshot);
      return;
    }
    const requestedSeconds = Number(snapshot.refreshSeconds);
    const refreshSeconds = PUBLIC_REFRESH_SECONDS.has(requestedSeconds) ? requestedSeconds : 5;
    const remaining = refreshSeconds * 1000 - (Date.now() - lastAcceptedAt.current);
    if (!lastAcceptedAt.current || remaining <= 0) {
      acceptSnapshot(snapshot);
      return;
    }
    pendingSnapshot.current = snapshot;
    window.clearTimeout(releaseTimer.current);
    releaseTimer.current = window.setTimeout(() => {
      if (pendingSnapshot.current) acceptSnapshot(pendingSnapshot.current);
    }, remaining);
  }, [acceptSnapshot, respectPublicRefresh]);

  const refresh = useCallback(async () => {
    const response = await fetch("/api/servers");
    if (!response.ok) throw new Error("Unable to load servers");
    acceptSnapshot((await response.json()) as Snapshot);
  }, [acceptSnapshot]);

  useEffect(() => {
    let disposed = false;

    const connect = () => {
      if (disposed) return;
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const socket = new WebSocket(`${protocol}//${window.location.host}/ws`);
      socketRef.current = socket;

      socket.addEventListener("open", () => setConnected(true));
      socket.addEventListener("message", (event) => {
        try {
          const payload = JSON.parse(event.data) as Snapshot;
          if (payload.type === "snapshot") queueSnapshot(payload);
        } catch {
          // Ignore malformed frames and keep the live connection open.
        }
      });
      socket.addEventListener("close", () => {
        setConnected(false);
        if (!disposed) retryTimer.current = window.setTimeout(connect, WS_RETRY_DELAY);
      });
      socket.addEventListener("error", () => socket.close());
    };

    refresh().catch(() => undefined);
    connect();
    return () => {
      disposed = true;
      window.clearTimeout(retryTimer.current);
      window.clearTimeout(releaseTimer.current);
      socketRef.current?.close();
    };
  }, [queueSnapshot, refresh]);

  return { servers, connected, lastUpdate, aggregateHistory, refresh };
}
