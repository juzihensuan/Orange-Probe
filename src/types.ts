export type ServerStatus = "online" | "offline";

export interface DiskMetric {
  name: string;
  mount: string;
  used: number;
  total: number;
  percent: number;
}

export interface NetworkInterfaceMetric {
  name: string;
  mac: string;
  addresses: string[];
}

export interface ServerMetric {
  id: string;
  name: string;
  location: string;
  countryCode?: string;
  ip: string;
  os: string;
  arch: string;
  cpuModel: string;
  cpuCores: number;
  version: string;
  tags: string[];
  source: "local" | "agent";
  reportInterval?: number;
  displayIndex?: number;
  group?: string;
  hideForGuest?: boolean;
  privateNote?: string;
  publicNote?: string;
  price?: string;
  billingCycle?: BillingCycle;
  customBillingCycle?: string;
  purchaseDate?: string;
  expirationDate?: string;
  serviceElapsedSeconds?: number;
  serviceTotalSeconds?: number;
  serviceCycleStart?: number;
  serviceCycleEnd?: number;
  serviceCycleElapsedSeconds?: number;
  serviceRemainingSeconds?: number;
  serviceCycleTotalSeconds?: number;
  serviceCyclePercent?: number;
  autoRenew?: boolean;
  renewalUrl?: string;
  renewalNotify?: boolean;
  renewalNoticeDays?: number;
  trafficLimitBytes?: number;
  trafficDownloadUsed?: number;
  trafficUploadUsed?: number;
  trafficUsed?: number;
  trafficPercent?: number;
  trafficWindowStart?: number;
  trafficWindowEnd?: number;
  trafficNotify?: boolean;
  trafficNotifyPercent?: number;
  agentTokenHint?: string;
  status: ServerStatus;
  cpu: number;
  cpuCoreUsage: number[];
  memory: { used: number; total: number; percent: number };
  swap: { used: number; total: number; percent: number };
  disk: { used: number; total: number; percent: number };
  disks?: DiskMetric[];
  diskCount?: number;
  networkInterfaces?: NetworkInterfaceMetric[];
  networkInterfaceCount?: number;
  network: {
    downloadSpeed: number;
    uploadSpeed: number;
    downloadTotal: number;
    uploadTotal: number;
  };
  load: number[];
  uptime: number;
  temperature: number;
  processCount: number;
  tcpConnections: number;
  udpConnections: number;
  lastSeen: number;
}

export interface Snapshot {
  type: "snapshot";
  now: number;
  refreshSeconds?: number;
  servers: ServerMetric[];
}

export interface HistoryPoint {
  timestamp: number;
  cpu: number;
  memory: number;
  swap: number;
  disk: number;
  download: number;
  upload: number;
  load: number;
  temperature: number;
  processCount: number;
  tcpConnections: number;
  udpConnections: number;
}

export interface AggregatePoint {
  timestamp: number;
  download: number;
  upload: number;
  cpu: number;
  memory: number;
}

export interface AlertSettings {
  cpu: number;
  memory: number;
  disk: number;
  homepageRefreshSeconds: 5 | 15 | 30 | 60;
  notifications: boolean;
  offlineAlerts: boolean;
  telegramEnabled: boolean;
  telegramBotToken: string;
  telegramChatId: string;
  telegramLoadAlerts: boolean;
  telegramOfflineAlerts: boolean;
  telegramOnlineAlerts: boolean;
  telegramRenewalAlerts: boolean;
  telegramTrafficAlerts: boolean;
  reverseProxyEnabled: boolean;
  publicDomain: string;
}

export type BillingCycle = "monthly" | "quarterly" | "semiannual" | "annual" | "biennial" | "triennial" | "one-time" | "custom";

export type SlaPeriod = 7 | 30 | 180 | 365;

export interface ServerSla {
  serverId: string;
  days: SlaPeriod;
  sla: number;
  onlineSamples: number;
  totalSamples: number;
  observedDays: number;
}

export type ViewName = "overview" | "serviceOverview" | "servers" | "network" | "events" | "firewall" | "updates" | "settings";

export type ServiceType = "http" | "icmp" | "tcp";

export interface ServiceHistoryPoint {
  timestamp: number;
  serverId: string;
  success: boolean;
  latency: number | null;
  error: string;
  statusCode: number | null;
  source: "agent" | "dashboard" | "dashboard-test";
}

export interface ServiceMonitor {
  id: number;
  name: string;
  type: ServiceType;
  target: string;
  interval: number;
  displayIndex: number;
  hideForGuest: boolean;
  enabled: boolean;
  notify: boolean;
  serverIds: string[];
  createdAt: number;
  updatedAt: number;
  latest: ServiceHistoryPoint | null;
}
