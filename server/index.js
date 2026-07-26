import crypto from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import proxyaddr from "proxy-addr";
import { WebSocketServer } from "ws";
import { resolveRegion } from "../agent/region.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const appVersion = "1.1.9";
const githubRepository = String(process.env.GITHUB_REPOSITORY || "juzihensuan/Orange-Probe").trim();
const githubApiBaseUrl = String(process.env.GITHUB_API_BASE_URL || "https://api.github.com").replace(/\/$/, "");
const githubToken = String(process.env.GITHUB_TOKEN || "");
const updaterUrl = String(process.env.UPDATER_URL || "").replace(/\/$/, "");
const updaterToken = String(process.env.UPDATE_TOKEN || "");
const isProduction = process.env.NODE_ENV === "production";
const port = Number(process.env.PORT || 4174);
const probeToken = process.env.PROBE_TOKEN || (isProduction ? "" : "orange-probe-agent");
const initialAdminUsername = process.env.ADMIN_USERNAME || "admin";
const initialAdminPassword = process.env.ADMIN_PASSWORD || (isProduction ? "" : "orange-probe");
const sessionTtl = 12 * 60 * 60 * 1000;
const historyRetentionMs = 7 * 24 * 60 * 60 * 1000;
const historySampleInterval = 30 * 1000;
const maxHistoryResponsePoints = 1200;
const agentUpdateTimeoutMs = Math.max(1000, Number(process.env.AGENT_UPDATE_TIMEOUT_MS || 5 * 60 * 1000));
const dataDir = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(rootDir, "data");
const settingsFile = path.join(dataDir, "settings.json");
const serverConfigsFile = path.join(dataDir, "servers.json");
const servicesFile = path.join(dataDir, "services.json");
const availabilityFile = path.join(dataDir, "availability.json");
const notificationStateFile = path.join(dataDir, "notification-state.json");
const trafficTotalsFile = path.join(dataDir, "traffic-totals.json");
const adminAuthFile = path.join(dataDir, "admin-auth.json");
const agentTokenKeyFile = path.join(dataDir, "agent-token.key");
const firewallFile = path.join(dataDir, "firewall.json");
const updatesFile = path.join(dataDir, "updates.json");
const adminAuthExistedAtStartup = fs.existsSync(adminAuthFile);
const historyRoot = path.join(dataDir, "history");
const nodeHistoryDir = path.join(historyRoot, "nodes");
const serviceHistoryDir = path.join(historyRoot, "services");
const telegramApiBaseUrl = String(process.env.TELEGRAM_API_BASE_URL || "https://api.telegram.org").replace(/\/$/, "");

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", process.env.TRUST_PROXY || "loopback, linklocal, uniquelocal");
const server = http.createServer(app);
server.requestTimeout = 15_000;
server.headersTimeout = 20_000;
server.keepAliveTimeout = 5_000;
server.maxRequestsPerSocket = 1000;
const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });
const agentWss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });
const nodes = new Map();
const history = new Map();
const adminSessions = new Map();
const loginAttempts = new Map();
const serviceHistories = new Map();
const serviceLastRuns = new Map();
const notificationAttempts = new Map();
const pendingTelegramNotifications = new Map();
const alertStates = { initialized: false, offline: new Map(), load: new Map(), traffic: new Map() };

const defaultAdminSettings = {
  cpu: 85,
  memory: 85,
  disk: 90,
  homepageRefreshSeconds: 5,
  notifications: false,
  offlineAlerts: true,
  telegramEnabled: false,
  telegramBotToken: "",
  telegramChatId: "",
  telegramLoadAlerts: true,
  telegramOfflineAlerts: true,
  telegramOnlineAlerts: true,
  telegramRenewalAlerts: true,
  telegramTrafficAlerts: true,
  reverseProxyEnabled: false,
  publicDomain: "",
};

function readAdminSettings() {
  try {
    return { ...defaultAdminSettings, ...JSON.parse(fs.readFileSync(settingsFile, "utf8")) };
  } catch {
    return { ...defaultAdminSettings };
  }
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // Windows and some mounted filesystems do not expose POSIX modes.
  }
}

function versionParts(value) {
  return String(value || "0.0.0").replace(/^v/i, "").split(".").slice(0, 3).map((part) => Number.parseInt(part, 10) || 0);
}

function compareVersions(left, right) {
  const leftParts = versionParts(left);
  const rightParts = versionParts(right);
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] !== rightParts[index]) return leftParts[index] > rightParts[index] ? 1 : -1;
  }
  return 0;
}

function passwordRecord(password, salt = crypto.randomBytes(16).toString("hex")) {
  return { salt, hash: crypto.scryptSync(String(password), salt, 64).toString("hex") };
}

function validPassword(password, record) {
  if (!record?.salt || !record?.hash) return false;
  const actual = crypto.scryptSync(String(password), record.salt, 64);
  const expected = Buffer.from(record.hash, "hex");
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function loadAdminAccount() {
  const stored = readJson(adminAuthFile, null);
  if (stored?.username && stored?.password?.salt && stored?.password?.hash) return stored;
  if (!initialAdminPassword) throw new Error("ADMIN_PASSWORD is required on the first production start");
  const account = { username: initialAdminUsername, password: passwordRecord(initialAdminPassword), updatedAt: Date.now() };
  writeJson(adminAuthFile, account);
  return account;
}

function loadAgentTokenKey() {
  if (process.env.AGENT_TOKEN_ENCRYPTION_KEY) return crypto.createHash("sha256").update(process.env.AGENT_TOKEN_ENCRYPTION_KEY).digest();
  try {
    const stored = Buffer.from(fs.readFileSync(agentTokenKeyFile, "utf8").trim(), "base64");
    if (stored.length === 32) return stored;
  } catch {
    // Generate a local encryption key on first start.
  }
  const key = crypto.randomBytes(32);
  fs.mkdirSync(path.dirname(agentTokenKeyFile), { recursive: true });
  fs.writeFileSync(agentTokenKeyFile, `${key.toString("base64")}\n`, { encoding: "utf8", mode: 0o600 });
  return key;
}

const agentTokenEncryptionKey = loadAgentTokenKey();

function encryptAgentToken(token) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", agentTokenEncryptionKey, iv);
  const encrypted = Buffer.concat([cipher.update(String(token), "utf8"), cipher.final()]);
  return `${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${encrypted.toString("base64url")}`;
}

function decryptAgentToken(value) {
  const [ivText, tagText, encryptedText] = String(value || "").split(".");
  if (!ivText || !tagText || !encryptedText) throw new Error("Agent token is not recoverable");
  const decipher = crypto.createDecipheriv("aes-256-gcm", agentTokenEncryptionKey, Buffer.from(ivText, "base64url"));
  decipher.setAuthTag(Buffer.from(tagText, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(encryptedText, "base64url")), decipher.final()]).toString("utf8");
}

let adminSettings = readAdminSettings();
let serverConfigs = readJson(serverConfigsFile, {});
let services = readJson(servicesFile, []);
let availabilityHistory = readJson(availabilityFile, {});
let notificationState = readJson(notificationStateFile, { renewals: {} });
let trafficTotals = readJson(trafficTotalsFile, {});
let adminAccount = loadAdminAccount();
let firewallEntries = loadFirewallEntries();
let updateState = readJson(updatesFile, { server: {}, agents: {} });
if (!updateState || typeof updateState !== "object" || Array.isArray(updateState)) updateState = { server: {}, agents: {} };
if (!updateState.server || typeof updateState.server !== "object" || Array.isArray(updateState.server)) updateState.server = {};
if (!updateState.agents || typeof updateState.agents !== "object" || Array.isArray(updateState.agents)) updateState.agents = {};
let latestReleaseCache = { checkedAt: 0, value: null, error: "" };
if (!availabilityHistory || typeof availabilityHistory !== "object" || Array.isArray(availabilityHistory)) availabilityHistory = {};
if (!notificationState || typeof notificationState !== "object" || Array.isArray(notificationState)) notificationState = { renewals: {} };
if (!trafficTotals || typeof trafficTotals !== "object" || Array.isArray(trafficTotals)) trafficTotals = {};
if (updateState.server.targetVersion && compareVersions(appVersion, updateState.server.targetVersion) >= 0) {
  updateState.server = { ...updateState.server, status: "completed", currentVersion: appVersion, completedAt: Date.now(), error: "" };
  writeJson(updatesFile, updateState);
}
let trafficTotalsDirty = false;
let removedLegacyDdns = false;
for (const config of Object.values(serverConfigs)) {
  if (!config || typeof config !== "object") continue;
  if ("enableDdns" in config) {
    delete config.enableDdns;
    removedLegacyDdns = true;
  }
  if ("ddnsProfiles" in config) {
    delete config.ddnsProfiles;
    removedLegacyDdns = true;
  }
}
if (removedLegacyDdns) writeJson(serverConfigsFile, serverConfigs);

function saveUpdateState() {
  writeJson(updatesFile, updateState);
}

async function latestGithubRelease(force = false) {
  if (!force && latestReleaseCache.value && Date.now() - latestReleaseCache.checkedAt < 5 * 60_000) return latestReleaseCache.value;
  try {
    const response = await fetch(`${githubApiBaseUrl}/repos/${githubRepository}/releases/latest`, {
      headers: { accept: "application/vnd.github+json", "user-agent": `Orange-Probe/${appVersion}`, ...(githubToken ? { authorization: `Bearer ${githubToken}` } : {}) },
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) throw new Error(`GitHub API HTTP ${response.status}`);
    const payload = await response.json();
    const version = String(payload.tag_name || "").replace(/^v/i, "");
    if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error("GitHub release tag is invalid");
    latestReleaseCache = {
      checkedAt: Date.now(),
      error: "",
      value: { version, tag: String(payload.tag_name || `v${version}`), url: String(payload.html_url || `https://github.com/${githubRepository}/releases/latest`), publishedAt: String(payload.published_at || "") },
    };
    return latestReleaseCache.value;
  } catch (error) {
    latestReleaseCache = { ...latestReleaseCache, checkedAt: Date.now(), error: error instanceof Error ? error.message : "GitHub release query failed" };
    return latestReleaseCache.value || { version: appVersion, tag: `v${appVersion}`, url: `https://github.com/${githubRepository}/releases/latest`, publishedAt: "" };
  }
}

async function syncServerUpdaterState() {
  if (!updaterUrl || !updaterToken || !new Set(["requested", "running", "restarting"]).has(String(updateState.server.status || ""))) return;
  try {
    const response = await fetch(`${updaterUrl}/health`, { signal: AbortSignal.timeout(3000) });
    if (!response.ok) return;
    const payload = await response.json();
    const remote = payload?.lastUpdate && typeof payload.lastUpdate === "object" ? payload.lastUpdate : null;
    if (!remote) return;
    const targetVersion = String(updateState.server.targetVersion || "");
    const remoteTarget = String(remote.targetVersion || "").replace(/^v/i, "");
    if (targetVersion && remoteTarget && targetVersion !== remoteTarget) return;
    const remoteStatus = String(remote.status || "");
    let status = updateState.server.status;
    let error = updateState.server.error || "";
    if (remoteStatus === "running") {
      status = "running";
      error = "";
    } else if (remoteStatus === "failed") {
      status = "failed";
      error = String(remote.error || "Updater failed").slice(0, 1000);
    } else if (remoteStatus === "completed" && compareVersions(appVersion, targetVersion) < 0) {
      status = "restarting";
      error = "";
    }
    if (status !== updateState.server.status || error !== updateState.server.error) {
      updateState.server = { ...updateState.server, status, error, updatedAt: Date.now() };
      saveUpdateState();
    }
  } catch {
    // The updater may be briefly unavailable while Docker recreates the application container.
  }
}

function updateEntryForAgent(agentId) {
  const entry = updateState.agents[agentId];
  return entry && typeof entry === "object" ? entry : null;
}

function expireAgentUpdateEntries(now = Date.now()) {
  let changed = false;
  for (const [agentId, entry] of Object.entries(updateState.agents)) {
    if (!entry || entry.status !== "installing") continue;
    const dispatchedAt = Number(entry.dispatchedAt || entry.startedAt || entry.updatedAt || entry.requestedAt) || 0;
    if (!dispatchedAt || now - dispatchedAt <= agentUpdateTimeoutMs) continue;
    updateState.agents[agentId] = {
      ...entry,
      status: "failed",
      updatedAt: now,
      error: "更新超时，Agent 未确认完成。请检查 Agent 日志后重新提交更新。",
    };
    changed = true;
  }
  if (changed) saveUpdateState();
}

function updateStatusMatchesEntry(entry, reportedStatus) {
  if (!reportedStatus) return false;
  const reportedTarget = String(reportedStatus.targetVersion || "");
  const reportedAttempt = String(reportedStatus.attemptId || "");
  if (reportedTarget && reportedTarget !== entry.targetVersion) return false;
  if (reportedAttempt && entry.attemptId && reportedAttempt !== entry.attemptId) return false;
  return true;
}

function applyAgentUpdateReport(node, report) {
  expireAgentUpdateEntries();
  const entry = updateEntryForAgent(node.id);
  const reportedStatus = report?.updateStatus && typeof report.updateStatus === "object" ? report.updateStatus : null;
  const terminalStatus = new Set(["success", "failed"]).has(String(reportedStatus?.state || ""));
  if (!entry) return { update: null, updateStatusAcknowledged: terminalStatus };
  const statusMatches = updateStatusMatchesEntry(entry, reportedStatus);
  if (reportedStatus?.state === "failed" && statusMatches) {
    updateState.agents[node.id] = { ...entry, status: "failed", updatedAt: Date.now(), error: String(reportedStatus.error || "Agent update failed").slice(0, 500) };
    saveUpdateState();
    return { update: null, updateStatusAcknowledged: true };
  }
  if ((!entry.force && compareVersions(node.version, entry.targetVersion) >= 0) || (entry.force && statusMatches && reportedStatus?.state === "success" && compareVersions(node.version, entry.targetVersion) >= 0)) {
    updateState.agents[node.id] = { ...entry, status: "completed", installedVersion: node.version, completedAt: Date.now(), updatedAt: Date.now(), error: "" };
    saveUpdateState();
    return { update: null, updateStatusAcknowledged: terminalStatus };
  }
  if (entry.targetVersion !== appVersion && new Set(["pending", "installing"]).has(entry.status)) {
    updateState.agents[node.id] = { ...entry, status: "failed", updatedAt: Date.now(), error: "目标版本已过期，请重新提交更新。" };
    saveUpdateState();
    return { update: null, updateStatusAcknowledged: terminalStatus };
  }
  if (entry.status !== "pending") return { update: null, updateStatusAcknowledged: terminalStatus };
  const dispatchedAt = Date.now();
  const installingEntry = {
    ...entry,
    status: "installing",
    startedAt: Number(entry.startedAt) || dispatchedAt,
    dispatchedAt,
    updatedAt: dispatchedAt,
    dispatchCount: Number(entry.dispatchCount || 0) + 1,
    error: "",
  };
  updateState.agents[node.id] = installingEntry;
  saveUpdateState();
  return {
    update: { version: entry.targetVersion, manifestUrl: "/downloads/agent/manifest.json", force: Boolean(entry.force), attemptId: entry.attemptId },
    updateStatusAcknowledged: terminalStatus,
  };
}

function normalizeIp(value) {
  let ip = String(value || "").trim();
  if (ip.startsWith("[") && ip.endsWith("]")) ip = ip.slice(1, -1);
  const zoneIndex = ip.indexOf("%");
  if (zoneIndex !== -1) ip = ip.slice(0, zoneIndex);
  if (ip.toLowerCase().startsWith("::ffff:") && net.isIP(ip.slice(7)) === 4) ip = ip.slice(7);
  const version = net.isIP(ip);
  if (version === 4) return ip;
  if (version === 6) return new URL(`http://[${ip}]/`).hostname.slice(1, -1).toLowerCase();
  return "";
}

function requestIp(request) {
  try {
    return normalizeIp(proxyaddr(request, app.get("trust proxy fn"))) || normalizeIp(request.socket?.remoteAddress);
  } catch {
    return normalizeIp(request.socket?.remoteAddress);
  }
}

function loadFirewallEntries() {
  const stored = readJson(firewallFile, []);
  const entries = Array.isArray(stored) ? stored : Array.isArray(stored?.blocked) ? stored.blocked : [];
  return new Map(entries.flatMap((entry) => {
    const ip = normalizeIp(entry?.ip);
    if (!ip) return [];
    return [[ip, {
      ip,
      reason: String(entry.reason || "管理员手动封禁").slice(0, 240),
      source: entry.source === "automatic" ? "automatic" : "manual",
      failedAttempts: Math.max(0, Math.round(Number(entry.failedAttempts) || 0)),
      blockedAt: Number(entry.blockedAt) || Date.now(),
    }]];
  }));
}

function persistFirewallEntries() {
  writeJson(firewallFile, [...firewallEntries.values()].sort((a, b) => b.blockedAt - a.blockedAt));
}

function blockIp(ip, { reason, source = "manual", failedAttempts = 0 } = {}) {
  const normalized = normalizeIp(ip);
  if (!normalized) throw new Error("IP 地址格式无效");
  const entry = {
    ip: normalized,
    reason: String(reason || "管理员手动封禁").trim().slice(0, 240) || "管理员手动封禁",
    source: source === "automatic" ? "automatic" : "manual",
    failedAttempts: Math.max(0, Math.round(Number(failedAttempts) || 0)),
    blockedAt: Date.now(),
  };
  firewallEntries.set(normalized, entry);
  loginAttempts.delete(normalized);
  persistFirewallEntries();
  return entry;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
}

function firewallBlockedPage(ip) {
  const safeIp = escapeHtml(ip || "未知");
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <meta name="robots" content="noindex,nofollow" />
  <title>访问已被禁止 · Orange Probe</title>
  <style>
    :root{color-scheme:light dark;font-family:Inter,"Segoe UI","Microsoft YaHei",sans-serif;background:#f4f6f8;color:#18202a}
    *{box-sizing:border-box}body{min-height:100vh;margin:0;display:grid;place-items:center;padding:24px;background:#f4f6f8}
    main{width:min(100%,520px);border:1px solid #e0e4e8;border-radius:16px;background:#fff;padding:34px;box-shadow:0 18px 55px rgba(20,28,36,.12)}
    .code{display:inline-flex;min-height:34px;align-items:center;border-radius:8px;background:#fff0ec;padding:0 11px;color:#d84b24;font-size:13px;font-weight:750}
    h1{margin:20px 0 9px;font-size:23px;letter-spacing:0}p{margin:0;color:#68717d;font-size:13px;line-height:1.7}
    dl{margin:25px 0 0;border-top:1px solid #edf0f2;padding-top:18px}div{display:flex;align-items:center;justify-content:space-between;gap:18px}
    dt{color:#8a929c;font-size:12px}dd{overflow-wrap:anywhere;margin:0;color:#18202a;font-family:Consolas,monospace;font-size:13px;font-weight:700;text-align:right}
    small{display:block;margin-top:24px;color:#a0a7af;font-size:11px}
    @media(prefers-color-scheme:dark){:root,body{background:#11161c;color:#edf2f7}main{border-color:#303841;background:#1a2027;box-shadow:none}.code{background:#3a241f;color:#ff8a68}p,dt{color:#9ea8b3}dl{border-color:#303841}dd{color:#edf2f7}small{color:#707b86}}
  </style>
</head>
<body><main><span class="code">403 · ACCESS BLOCKED</span><h1>你的 IP 已被封禁，禁止访问！</h1><p>该地址已被 Orange Probe 防火墙拦截。如需恢复访问，请联系系统管理员解除封禁。</p><dl><div><dt>访问者 IP</dt><dd>${safeIp}</dd></div></dl><small>Orange Probe Firewall</small></main></body>
</html>`;
}

app.use((request, response, next) => {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
  response.setHeader("Content-Security-Policy", "default-src 'self'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'; img-src 'self' data:; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws: wss:");
  if (request.secure) response.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  next();
});

app.use((request, response, next) => {
  const ip = requestIp(request);
  request.clientIp = ip;
  if (!ip || !firewallEntries.has(ip)) return next();
  response.status(403).setHeader("Cache-Control", "no-store");
  if (request.method === "GET" && String(request.headers.accept || "").includes("text/html")) {
    response.setHeader("Content-Language", "zh-CN");
    return response.type("html").send(firewallBlockedPage(ip));
  }
  return response.json({ error: "你的 IP 已被封禁，禁止访问！", blocked: true, ip });
});
app.use(express.json({ limit: "128kb" }));

function parseCookies(request) {
  return Object.fromEntries(
    String(request.headers.cookie || "")
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const index = part.indexOf("=");
        return index === -1 ? [part, ""] : [part.slice(0, index), decodeURIComponent(part.slice(index + 1))];
      }),
  );
}

function safeEqual(actual, expected) {
  const left = Buffer.from(String(actual));
  const right = Buffer.from(String(expected));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function sessionFromRequest(request) {
  const token = parseCookies(request).orange_probe_session;
  if (!token) return null;
  const session = adminSessions.get(token);
  if (!session || session.expiresAt <= Date.now()) {
    adminSessions.delete(token);
    return null;
  }
  return { token, ...session };
}

function requireAdmin(request, response, next) {
  const session = sessionFromRequest(request);
  if (!session) return response.status(401).json({ error: "Admin authentication required" });
  request.admin = session;
  return next();
}

function normalizePublicDomain(value) {
  const input = String(value || "").trim();
  if (!input) return "";
  const parsed = new URL(/^https?:\/\//i.test(input) ? input : `https://${input}`);
  if (parsed.protocol !== "https:") throw new Error("Reverse proxy domain must use HTTPS");
  if (parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error("Reverse proxy domain must only contain scheme, host and optional port");
  }
  return parsed.origin;
}

function requestOriginAllowed(request) {
  const origin = String(request.headers.origin || "").trim();
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    const requestHost = String(request.headers.host || "").toLowerCase();
    if (parsed.host.toLowerCase() === requestHost) return true;
    return Boolean(adminSettings.reverseProxyEnabled && adminSettings.publicDomain && parsed.origin === adminSettings.publicDomain);
  } catch {
    return false;
  }
}

app.use("/api/admin", (request, response, next) => {
  if (new Set(["GET", "HEAD", "OPTIONS"]).has(request.method) || requestOriginAllowed(request)) return next();
  return response.status(403).json({ error: "Cross-origin admin request rejected" });
});

function sanitizeAdminSettings(value, current = adminSettings || defaultAdminSettings) {
  const threshold = (input, fallback) => Math.min(99, Math.max(50, Math.round(Number(input) || fallback)));
  const text = (input, maximum) => String(input || "").trim().slice(0, maximum);
  const allowedHomepageRefreshSeconds = new Set([5, 15, 30, 60]);
  const requestedHomepageRefreshSeconds = Number(value?.homepageRefreshSeconds ?? current.homepageRefreshSeconds);
  const reverseProxyEnabled = Boolean(value?.reverseProxyEnabled);
  const publicDomain = normalizePublicDomain(value?.publicDomain ?? current.publicDomain);
  if (reverseProxyEnabled && !publicDomain) throw new Error("Reverse proxy domain is required when reverse proxy mode is enabled");
  return {
    cpu: threshold(value?.cpu, defaultAdminSettings.cpu),
    memory: threshold(value?.memory, defaultAdminSettings.memory),
    disk: threshold(value?.disk, defaultAdminSettings.disk),
    homepageRefreshSeconds: allowedHomepageRefreshSeconds.has(requestedHomepageRefreshSeconds) ? requestedHomepageRefreshSeconds : defaultAdminSettings.homepageRefreshSeconds,
    notifications: Boolean(value?.notifications),
    offlineAlerts: value?.offlineAlerts !== false,
    telegramEnabled: Boolean(value?.telegramEnabled),
    telegramBotToken: text(value?.telegramBotToken ?? current.telegramBotToken, 240),
    telegramChatId: text(value?.telegramChatId ?? current.telegramChatId, 120),
    telegramLoadAlerts: value?.telegramLoadAlerts !== false,
    telegramOfflineAlerts: value?.telegramOfflineAlerts !== false,
    telegramOnlineAlerts: value?.telegramOnlineAlerts !== false,
    telegramRenewalAlerts: value?.telegramRenewalAlerts !== false,
    telegramTrafficAlerts: value?.telegramTrafficAlerts !== false,
    reverseProxyEnabled,
    publicDomain,
  };
}

function deploymentInfo(request) {
  if (adminSettings.reverseProxyEnabled && adminSettings.publicDomain) {
    return {
      transport: "ws",
      serverUrl: adminSettings.publicDomain,
      wsUrl: `${adminSettings.publicDomain.replace(/^https:/, "wss:")}/agent-ws`,
    };
  }
  const forwardedProtocol = String(request.headers["x-forwarded-proto"] || "").split(",")[0].trim();
  const protocol = forwardedProtocol === "https" ? "https" : request.protocol;
  const serverUrl = `${protocol}://${request.get("host")}`;
  return { transport: "http", serverUrl, wsUrl: `${serverUrl.replace(/^http/, "ws")}/agent-ws` };
}

function sanitizeServerConfig(value, current = {}) {
  const text = (input, maximum = 5000) => String(input || "").trim().slice(0, maximum);
  const pick = (key, fallback = "") => value?.[key] === undefined ? current[key] ?? fallback : value[key];
  const billingCycles = new Set(["monthly", "quarterly", "semiannual", "annual", "biennial", "triennial", "one-time", "custom"]);
  const billingCycle = billingCycles.has(pick("billingCycle")) ? pick("billingCycle") : "monthly";
  const customBillingCycle = text(pick("customBillingCycle"), 60);
  if (billingCycle === "custom" && !customBillingCycle) throw new Error("Custom billing cycle name is required");
  const purchaseDate = text(pick("purchaseDate"), 10);
  const expirationDate = text(pick("expirationDate"), 10);
  if (purchaseDate && (!/^\d{4}-\d{2}-\d{2}$/.test(purchaseDate) || Number.isNaN(Date.parse(`${purchaseDate}T00:00:00.000Z`)))) {
    throw new Error("Purchase date must use YYYY-MM-DD");
  }
  if (expirationDate && (!/^\d{4}-\d{2}-\d{2}$/.test(expirationDate) || Number.isNaN(Date.parse(`${expirationDate}T23:59:59.999Z`)))) {
    throw new Error("Expiration date must use YYYY-MM-DD");
  }
  if (purchaseDate && expirationDate && Date.parse(`${purchaseDate}T00:00:00.000Z`) > Date.parse(`${expirationDate}T23:59:59.999Z`)) {
    throw new Error("Purchase date must not be after expiration date");
  }
  const renewalUrl = text(pick("renewalUrl"), 500);
  if (renewalUrl) {
    const parsed = new URL(renewalUrl);
    if (!new Set(["http:", "https:"]).has(parsed.protocol)) throw new Error("Renewal URL must use http:// or https://");
  }
  const noticeInput = Number(pick("renewalNoticeDays", 7));
  const trafficLimitInput = Number(pick("trafficLimitBytes", 0));
  const trafficThresholdInput = Number(pick("trafficNotifyPercent", 80));
  return {
    name: text(pick("name"), 80) || current.name || "Server",
    displayIndex: Math.max(-9999, Math.min(9999, Math.round(Number(pick("displayIndex", 0)) || 0))),
    group: text(pick("group"), 60),
    hideForGuest: Boolean(pick("hideForGuest", false)),
    privateNote: text(pick("privateNote"), 3000),
    publicNote: text(pick("publicNote"), 5000),
    price: text(pick("price"), 40),
    billingCycle,
    customBillingCycle: billingCycle === "custom" ? customBillingCycle : "",
    purchaseDate,
    expirationDate,
    autoRenew: Boolean(pick("autoRenew", false)),
    renewalUrl,
    renewalNotify: Boolean(pick("renewalNotify", false)),
    renewalNoticeDays: Math.max(0, Math.min(365, Number.isFinite(noticeInput) ? Math.round(noticeInput) : 7)),
    trafficLimitBytes: Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Number.isFinite(trafficLimitInput) ? Math.round(trafficLimitInput) : 0)),
    trafficNotify: Boolean(pick("trafficNotify", false)),
    trafficNotifyPercent: Math.max(1, Math.min(100, Number.isFinite(trafficThresholdInput) ? Math.round(trafficThresholdInput) : 80)),
    ...(current.agentTokenHash ? { agentTokenHash: current.agentTokenHash } : {}),
    ...(current.agentTokenHint ? { agentTokenHint: current.agentTokenHint } : {}),
    ...(current.agentTokenCiphertext ? { agentTokenCiphertext: current.agentTokenCiphertext } : {}),
    ...(current.agentRegisteredAt ? { agentRegisteredAt: current.agentRegisteredAt } : {}),
    ...(current.localCollectorDisabled ? { localCollectorDisabled: true } : {}),
    ...(current.deletedLocalNode ? { deletedLocalNode: true } : {}),
    updatedAt: Date.now(),
  };
}

function sanitizeService(value, current = {}) {
  const types = new Set(["http", "icmp", "tcp"]);
  const type = types.has(value?.type) ? value.type : current.type || "icmp";
  const target = String(value?.target || "").trim().slice(0, 500);
  if (!target) throw new Error("Service target is required");
  if (type === "http") {
    const url = new URL(target);
    if (!new Set(["http:", "https:"]).has(url.protocol)) throw new Error("HTTP target must use http:// or https://");
  }
  if (type === "tcp") {
    const url = new URL(`tcp://${target}`);
    if (!url.hostname || !url.port) throw new Error("TCPing target must include a port");
  }
  if (type === "icmp" && /:\d+$/.test(target)) throw new Error("ICMP Ping target must not include a port");

  return {
    ...current,
    name: String(value?.name || "").trim().slice(0, 100) || current.name || "Service monitor",
    type,
    target,
    interval: Math.max(5, Math.min(86400, Math.round(Number(value?.interval) || 30))),
    displayIndex: Math.max(-9999, Math.min(9999, Math.round(Number(value?.displayIndex) || 0))),
    hideForGuest: Boolean(value?.hideForGuest),
    enabled: value?.enabled !== false,
    notify: Boolean(value?.notify),
    serverIds: Array.isArray(value?.serverIds) ? [...new Set(value.serverIds.map(String))].slice(0, 200) : [],
    updatedAt: Date.now(),
  };
}

const round = (value, precision = 1) => {
  const factor = 10 ** precision;
  return Math.round((Number(value) || 0) * factor) / factor;
};

const clamp = (value, min = 0, max = 100) =>
  Math.min(max, Math.max(min, Number(value) || 0));

const hashId = (value) =>
  crypto.createHash("sha256").update(String(value)).digest("hex").slice(0, 12);

const bytes = (value) => Math.max(0, Number(value) || 0);

function dateParts(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ""))) return null;
  const [year, month, day] = String(value).split("-").map(Number);
  const timestamp = Date.UTC(year, month - 1, day);
  return Number.isNaN(timestamp) ? null : { year, month: month - 1, day };
}

function monthAnchorTimestamp(year, month, day) {
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return Date.UTC(year, month, Math.min(day, lastDay));
}

function trafficWindowForConfig(config = {}, now = Date.now()) {
  const preferredAnchor = config.billingCycle === "monthly"
    ? config.expirationDate || config.purchaseDate
    : config.purchaseDate || config.expirationDate;
  const anchor = dateParts(preferredAnchor) || { day: 1 };
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
  return { key: `${new Date(start).toISOString()}:${new Date(end).toISOString()}`, start, end };
}

function servicePeriodForConfig(config = {}, now = Date.now()) {
  const purchasedAt = dateParts(config.purchaseDate) ? Date.parse(`${config.purchaseDate}T00:00:00.000Z`) : null;
  const expiresAt = dateParts(config.expirationDate) ? Date.parse(`${config.expirationDate}T23:59:59.999Z`) : null;
  if (purchasedAt === null) return { elapsedSeconds: 0, totalSeconds: 0 };
  const boundedNow = expiresAt === null ? now : Math.min(now, expiresAt);
  return {
    elapsedSeconds: Math.max(0, Math.floor((boundedNow - purchasedAt) / 1000)),
    totalSeconds: expiresAt === null ? 0 : Math.max(0, Math.floor((expiresAt - purchasedAt) / 1000)),
  };
}

const billingCycleMonths = {
  monthly: 1,
  quarterly: 3,
  semiannual: 6,
  annual: 12,
  biennial: 24,
  triennial: 36,
};

function anchoredCycleTimestamp(anchor, monthOffset) {
  const absoluteMonth = anchor.month + monthOffset;
  const year = anchor.year + Math.floor(absoluteMonth / 12);
  const month = ((absoluteMonth % 12) + 12) % 12;
  return monthAnchorTimestamp(year, month, anchor.day);
}

function serviceCycleForConfig(config = {}, now = Date.now()) {
  const purchase = dateParts(config.purchaseDate);
  const expiration = dateParts(config.expirationDate);
  if (!purchase) return { start: 0, end: 0, elapsedSeconds: 0, remainingSeconds: 0, totalSeconds: 0, percent: 0 };
  const purchasedAt = Date.UTC(purchase.year, purchase.month, purchase.day);
  const expiresAt = expiration ? Date.parse(`${config.expirationDate}T23:59:59.999Z`) : null;
  const cycleMonths = billingCycleMonths[config.billingCycle];
  let start = purchasedAt;
  let end = expiresAt || 0;

  if (cycleMonths) {
    const reference = Math.max(purchasedAt, expiresAt === null ? now : Math.min(now, expiresAt));
    const referenceDate = new Date(reference);
    const monthDistance = (referenceDate.getUTCFullYear() - purchase.year) * 12 + (referenceDate.getUTCMonth() - purchase.month);
    let cycleIndex = Math.max(0, Math.floor(monthDistance / cycleMonths));
    start = anchoredCycleTimestamp(purchase, cycleIndex * cycleMonths);
    if (start > reference && cycleIndex > 0) {
      cycleIndex -= 1;
      start = anchoredCycleTimestamp(purchase, cycleIndex * cycleMonths);
    }
    end = anchoredCycleTimestamp(purchase, (cycleIndex + 1) * cycleMonths);
    if (expiresAt !== null) end = Math.min(end, expiresAt);
  }

  if (!end || end <= start) return { start, end: end || 0, elapsedSeconds: 0, remainingSeconds: 0, totalSeconds: 0, percent: 0 };
  const boundedNow = Math.min(Math.max(now, start), end);
  const totalSeconds = Math.max(0, Math.floor((end - start) / 1000));
  const elapsedSeconds = Math.max(0, Math.floor((boundedNow - start) / 1000));
  const remainingSeconds = Math.max(0, totalSeconds - elapsedSeconds);
  return {
    start,
    end,
    elapsedSeconds,
    remainingSeconds,
    totalSeconds,
    percent: totalSeconds ? round((elapsedSeconds / totalSeconds) * 100, 2) : 0,
  };
}

function accumulatedTraffic(nodeId, network, config = {}) {
  const rawDownload = bytes(network?.downloadTotal);
  const rawUpload = bytes(network?.uploadTotal);
  const previous = trafficTotals[nodeId];
  const window = trafficWindowForConfig(config);
  const hasPreviousSample = Boolean(previous && previous.initialized !== false && Number.isFinite(Number(previous.rawDownload)) && Number.isFinite(Number(previous.rawUpload)));
  const deltaDownload = hasPreviousSample
    ? (rawDownload >= bytes(previous.rawDownload) ? rawDownload - bytes(previous.rawDownload) : rawDownload)
    : 0;
  const deltaUpload = hasPreviousSample
    ? (rawUpload >= bytes(previous.rawUpload) ? rawUpload - bytes(previous.rawUpload) : rawUpload)
    : 0;
  const sameWindow = previous?.windowKey === window.key;
  const previousDownload = sameWindow ? bytes(previous.windowDownload ?? previous.downloadTotal) : 0;
  const previousUpload = sameWindow ? bytes(previous.windowUpload ?? previous.uploadTotal) : 0;
  const windowDownload = previousDownload + deltaDownload;
  const windowUpload = previousUpload + deltaUpload;
  trafficTotals[nodeId] = {
    rawDownload,
    rawUpload,
    lifetimeDownload: bytes(previous?.lifetimeDownload ?? previous?.downloadTotal) + deltaDownload,
    lifetimeUpload: bytes(previous?.lifetimeUpload ?? previous?.uploadTotal) + deltaUpload,
    windowDownload,
    windowUpload,
    windowKey: window.key,
    windowStart: window.start,
    windowEnd: window.end,
    initialized: true,
    updatedAt: Date.now(),
  };
  trafficTotalsDirty = true;
  return { downloadTotal: windowDownload, uploadTotal: windowUpload };
}

function persistTrafficTotals() {
  if (!trafficTotalsDirty) return;
  writeJson(trafficTotalsFile, trafficTotals);
  trafficTotalsDirty = false;
}

function appendHistoryLine(directory, record) {
  fs.mkdirSync(directory, { recursive: true });
  const timestamp = Number(record.timestamp) || Date.now();
  fs.appendFileSync(path.join(directory, `${utcDayKey(timestamp)}.jsonl`), `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
}

function pruneHistoryList(list) {
  const cutoff = Date.now() - historyRetentionMs;
  const firstValid = list.findIndex((point) => Number(point.timestamp) >= cutoff);
  if (firstValid === -1) return [];
  if (firstValid > 0) list.splice(0, firstValid);
  return list;
}

function addHistory(node) {
  const list = history.get(node.id) || [];
  const timestamp = Date.now();
  if (list.length && timestamp - Number(list.at(-1)?.timestamp || 0) < historySampleInterval) return;
  const point = {
    timestamp,
    cpu: node.cpu,
    memory: node.memory.percent,
    swap: node.swap.percent,
    disk: node.disk.percent,
    download: node.network.downloadSpeed,
    upload: node.network.uploadSpeed,
    load: node.load[0],
    temperature: node.temperature,
    processCount: node.processCount,
    tcpConnections: node.tcpConnections,
    udpConnections: node.udpConnections,
  };
  list.push(point);
  history.set(node.id, pruneHistoryList(list));
  appendHistoryLine(nodeHistoryDir, { serverId: node.id, ...point });
}

function upsertNode(node) {
  const cumulativeTraffic = node.source === "agent" ? accumulatedTraffic(node.id, node.network, serverConfigs[node.id]) : {
    downloadTotal: bytes(node.network?.downloadTotal),
    uploadTotal: bytes(node.network?.uploadTotal),
  };
  const disks = Array.isArray(node.disks) ? node.disks.slice(0, 64).map((item) => ({
    name: String(item?.name || "Disk").slice(0, 128),
    mount: String(item?.mount || "").slice(0, 256),
    used: bytes(item?.used),
    total: bytes(item?.total),
    percent: round(clamp(item?.percent)),
  })) : [];
  const networkInterfaces = Array.isArray(node.networkInterfaces) ? node.networkInterfaces.slice(0, 64).map((item) => ({
    name: String(item?.name || "Interface").slice(0, 128),
    mac: String(item?.mac || "").slice(0, 32),
    addresses: Array.isArray(item?.addresses) ? item.addresses.slice(0, 16).map((address) => String(address).slice(0, 128)) : [],
  })) : [];
  const normalized = {
    ...node,
    version: String(node.version || "--").trim().slice(0, 32) || "--",
    capabilities: Array.isArray(node.capabilities) ? [...new Set(node.capabilities.map((item) => String(item).trim()).filter(Boolean))].slice(0, 20) : [],
    location: String(node.location || "Remote").trim().slice(0, 80) || "Remote",
    countryCode: /^[A-Za-z]{2}$/.test(String(node.countryCode || "").trim()) ? String(node.countryCode).trim().toUpperCase() : "",
    cpu: round(clamp(node.cpu)),
    cpuCoreUsage: Array.isArray(node.cpuCoreUsage) ? node.cpuCoreUsage.slice(0, 512).map((item) => round(clamp(item))) : [],
    memory: {
      used: bytes(node.memory?.used),
      total: bytes(node.memory?.total),
      percent: round(clamp(node.memory?.percent)),
    },
    swap: {
      used: bytes(node.swap?.used),
      total: bytes(node.swap?.total),
      percent: round(clamp(node.swap?.percent)),
    },
    disk: {
      used: bytes(node.disk?.used),
      total: bytes(node.disk?.total),
      percent: round(clamp(node.disk?.percent)),
    },
    disks,
    diskCount: disks.length || Math.max(0, Math.round(Number(node.diskCount) || 0)),
    networkInterfaces,
    networkInterfaceCount: networkInterfaces.length || Math.max(0, Math.round(Number(node.networkInterfaceCount) || 0)),
    network: {
      downloadSpeed: bytes(node.network?.downloadSpeed),
      uploadSpeed: bytes(node.network?.uploadSpeed),
      downloadTotal: cumulativeTraffic.downloadTotal,
      uploadTotal: cumulativeTraffic.uploadTotal,
    },
    load: Array.isArray(node.load) ? node.load.slice(0, 3).map((item) => round(item, 2)) : [0, 0, 0],
    uptime: Math.max(0, Number(node.uptime) || 0),
    temperature: round(node.temperature),
    processCount: Math.max(0, Math.round(Number(node.processCount) || 0)),
    tcpConnections: Math.max(0, Math.round(Number(node.tcpConnections) || 0)),
    udpConnections: Math.max(0, Math.round(Number(node.udpConnections) || 0)),
    lastSeen: Number(node.lastSeen) || Date.now(),
  };

  nodes.set(normalized.id, normalized);
  if (normalized.status !== "offline") addHistory(normalized);
  return normalized;
}

function configuredNode(node, isAdmin = false) {
  const config = serverConfigs[node.id] || {};
  const trafficLimitBytes = Math.max(0, Number(config.trafficLimitBytes) || 0);
  const trafficWindow = trafficWindowForConfig(config);
  const storedTraffic = trafficTotals[node.id];
  const windowIsCurrent = !storedTraffic || storedTraffic.windowKey === trafficWindow.key;
  const trafficDownloadUsed = windowIsCurrent ? bytes(node.network.downloadTotal) : 0;
  const trafficUploadUsed = windowIsCurrent ? bytes(node.network.uploadTotal) : 0;
  const trafficUsed = trafficDownloadUsed + trafficUploadUsed;
  const merged = {
    ...node,
    network: { ...node.network, downloadTotal: trafficDownloadUsed, uploadTotal: trafficUploadUsed },
    name: config.name || node.name,
    displayIndex: Number(config.displayIndex) || 0,
    group: config.group || "",
    hideForGuest: Boolean(config.hideForGuest),
    publicNote: config.publicNote || "",
    trafficLimitBytes,
    trafficDownloadUsed,
    trafficUploadUsed,
    trafficUsed,
    trafficPercent: trafficLimitBytes ? round((trafficUsed / trafficLimitBytes) * 100, 2) : 0,
    trafficWindowStart: trafficWindow.start,
    trafficWindowEnd: trafficWindow.end,
  };
  if (isAdmin) {
    const servicePeriod = servicePeriodForConfig(config);
    const serviceCycle = serviceCycleForConfig(config);
    Object.assign(merged, {
      privateNote: config.privateNote || "",
      price: config.price || "",
      billingCycle: config.billingCycle || "monthly",
      customBillingCycle: config.customBillingCycle || "",
      purchaseDate: config.purchaseDate || "",
      expirationDate: config.expirationDate || "",
      serviceElapsedSeconds: servicePeriod.elapsedSeconds,
      serviceTotalSeconds: servicePeriod.totalSeconds,
      serviceCycleStart: serviceCycle.start,
      serviceCycleEnd: serviceCycle.end,
      serviceCycleElapsedSeconds: serviceCycle.elapsedSeconds,
      serviceRemainingSeconds: serviceCycle.remainingSeconds,
      serviceCycleTotalSeconds: serviceCycle.totalSeconds,
      serviceCyclePercent: serviceCycle.percent,
      autoRenew: Boolean(config.autoRenew),
      renewalUrl: config.renewalUrl || "",
      renewalNotify: Boolean(config.renewalNotify),
      renewalNoticeDays: Number.isFinite(Number(config.renewalNoticeDays)) ? Number(config.renewalNoticeDays) : 7,
      trafficNotify: Boolean(config.trafficNotify),
      trafficNotifyPercent: Number.isFinite(Number(config.trafficNotifyPercent)) ? Number(config.trafficNotifyPercent) : 80,
      agentTokenHint: config.agentTokenHint || "",
    });
  } else {
    delete merged.disks;
    delete merged.diskCount;
    delete merged.networkInterfaces;
    delete merged.networkInterfaceCount;
  }
  return merged;
}

function registeredAgentPlaceholder(id, config) {
  const stored = trafficTotals[id] || {};
  return {
    id,
    name: config.name || "Remote Agent",
    location: "Remote",
    countryCode: "",
    ip: "--",
    os: "等待 Agent 上报",
    arch: "--",
    cpuModel: "--",
    cpuCores: 0,
    cpuCoreUsage: [],
    version: "--",
    tags: ["remote"],
    source: "agent",
    reportInterval: 3000,
    status: "offline",
    cpu: 0,
    memory: { used: 0, total: 0, percent: 0 },
    swap: { used: 0, total: 0, percent: 0 },
    disk: { used: 0, total: 0, percent: 0 },
    disks: [],
    diskCount: 0,
    networkInterfaces: [],
    networkInterfaceCount: 0,
    network: {
      downloadSpeed: 0,
      uploadSpeed: 0,
      downloadTotal: bytes(stored.windowDownload),
      uploadTotal: bytes(stored.windowUpload),
    },
    load: [0, 0, 0],
    uptime: 0,
    temperature: 0,
    processCount: 0,
    tcpConnections: 0,
    udpConnections: 0,
    lastSeen: Number(config.agentRegisteredAt) || 0,
  };
}

function hydrateRegisteredAgents() {
  for (const [id, config] of Object.entries(serverConfigs)) {
    if (config?.agentTokenHash && !nodes.has(id)) nodes.set(id, registeredAgentPlaceholder(id, config));
  }
}

function publicNodes(isAdmin = false) {
  const now = Date.now();
  return [...nodes.values()]
    .map((node) => {
      const reportInterval = Math.max(1000, Number(node.reportInterval) || 3000);
      const staleAfter = Math.max(15000, reportInterval * 3.5);
      const stale = node.source === "agent" && now - node.lastSeen > staleAfter;
      return configuredNode(stale ? { ...node, status: "offline" } : node, isAdmin);
    })
    .filter((node) => isAdmin || !node.hideForGuest)
    .sort((a, b) => {
      if (a.displayIndex !== b.displayIndex) return b.displayIndex - a.displayIndex;
      if (a.status === b.status) return a.name.localeCompare(b.name);
      return a.status === "offline" ? 1 : -1;
    });
}

function summaryPayload(isAdmin = false) {
  return { type: "snapshot", now: Date.now(), refreshSeconds: adminSettings.homepageRefreshSeconds, servers: publicNodes(isAdmin) };
}

const allowedSlaPeriods = new Set([7, 30, 180, 365]);

function utcDayKey(timestamp = Date.now()) {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function historyRangeMilliseconds(value) {
  if (value === "7d") return 7 * 24 * 60 * 60 * 1000;
  if (value === "1d") return 24 * 60 * 60 * 1000;
  return 5 * 60 * 1000;
}

function historyPointsForPeriod(list, period) {
  const cutoff = Date.now() - historyRangeMilliseconds(period);
  const filtered = list.filter((point) => Number(point.timestamp) >= cutoff);
  if (filtered.length <= maxHistoryResponsePoints) return filtered;
  const stride = Math.ceil(filtered.length / maxHistoryResponsePoints);
  const sampled = filtered.filter((_point, index) => index % stride === 0);
  const last = filtered.at(-1);
  if (last && sampled.at(-1)?.timestamp !== last.timestamp) sampled.push(last);
  return sampled;
}

function cleanupHistoryFiles() {
  const cutoff = Date.now() - historyRetentionMs;
  for (const directory of [nodeHistoryDir, serviceHistoryDir]) {
    fs.mkdirSync(directory, { recursive: true });
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isFile() || !/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(entry.name)) continue;
      const file = path.join(directory, entry.name);
      const dayStart = Date.parse(`${entry.name.slice(0, 10)}T00:00:00.000Z`);
      if (!Number.isFinite(dayStart)) continue;
      if (dayStart + 86400 * 1000 < cutoff) {
        fs.unlinkSync(file);
        continue;
      }
      if (dayStart >= cutoff) continue;
      const retained = fs.readFileSync(file, "utf8").split(/\r?\n/).filter((line) => {
        if (!line.trim()) return false;
        try {
          return Number(JSON.parse(line).timestamp) >= cutoff;
        } catch {
          return false;
        }
      });
      if (retained.length) fs.writeFileSync(file, `${retained.join("\n")}\n`, "utf8");
      else fs.unlinkSync(file);
    }
  }
  for (const target of [history, serviceHistories]) {
    for (const [key, list] of target) target.set(key, pruneHistoryList(list));
  }
}

function loadHistoryDirectory(directory, keyField, targetMap) {
  const cutoff = Date.now() - historyRetentionMs;
  fs.mkdirSync(directory, { recursive: true });
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
    const contents = fs.readFileSync(path.join(directory, entry.name), "utf8");
    for (const line of contents.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line);
        const key = String(record[keyField] || "");
        if (!key || Number(record.timestamp) < cutoff) continue;
        delete record[keyField];
        const list = targetMap.get(key) || [];
        list.push(record);
        targetMap.set(key, list);
      } catch {
        // Ignore a partial or invalid JSONL line and continue loading the remaining history.
      }
    }
  }
  for (const [key, list] of targetMap) {
    list.sort((left, right) => Number(left.timestamp) - Number(right.timestamp));
    targetMap.set(key, pruneHistoryList(list));
  }
}

function loadPersistedHistories() {
  cleanupHistoryFiles();
  loadHistoryDirectory(nodeHistoryDir, "serverId", history);
  loadHistoryDirectory(serviceHistoryDir, "serviceId", serviceHistories);
}

function removePersistedHistory(directory, keyField, keyValue) {
  if (!fs.existsSync(directory)) return;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
    const file = path.join(directory, entry.name);
    const retained = fs.readFileSync(file, "utf8").split(/\r?\n/).filter((line) => {
      if (!line.trim()) return false;
      try {
        return String(JSON.parse(line)[keyField] || "") !== String(keyValue);
      } catch {
        return false;
      }
    });
    fs.writeFileSync(file, retained.length ? `${retained.join("\n")}\n` : "", "utf8");
  }
}

function recordAvailabilitySample() {
  const now = Date.now();
  const day = utcDayKey(now);
  const pruneBefore = now - 366 * 86400 * 1000;
  for (const node of publicNodes(true)) {
    const serverDays = availabilityHistory[node.id] && typeof availabilityHistory[node.id] === "object" ? availabilityHistory[node.id] : {};
    const bucket = serverDays[day] && typeof serverDays[day] === "object" ? serverDays[day] : { online: 0, total: 0 };
    bucket.total = Math.max(0, Number(bucket.total) || 0) + 1;
    bucket.online = Math.max(0, Number(bucket.online) || 0) + (node.status === "online" ? 1 : 0);
    serverDays[day] = bucket;
    for (const key of Object.keys(serverDays)) {
      const timestamp = Date.parse(`${key}T00:00:00.000Z`);
      if (!Number.isFinite(timestamp) || timestamp < pruneBefore) delete serverDays[key];
    }
    availabilityHistory[node.id] = serverDays;
  }
  writeJson(availabilityFile, availabilityHistory);
  persistTrafficTotals();
}

function slaPayload(daysInput) {
  const requested = Number(daysInput);
  const days = allowedSlaPeriods.has(requested) ? requested : 30;
  const now = Date.now();
  const currentDayStart = Date.parse(`${utcDayKey(now)}T00:00:00.000Z`);
  const cutoff = currentDayStart - (days - 1) * 86400 * 1000;
  const servers = publicNodes(true).map((node) => {
    let onlineSamples = 0;
    let totalSamples = 0;
    let observedDays = 0;
    for (const [day, bucket] of Object.entries(availabilityHistory[node.id] || {})) {
      const timestamp = Date.parse(`${day}T00:00:00.000Z`);
      if (!Number.isFinite(timestamp) || timestamp < cutoff) continue;
      const total = Math.max(0, Number(bucket?.total) || 0);
      if (!total) continue;
      observedDays += 1;
      totalSamples += total;
      onlineSamples += Math.min(total, Math.max(0, Number(bucket?.online) || 0));
    }
    if (!totalSamples) {
      totalSamples = 1;
      onlineSamples = node.status === "online" ? 1 : 0;
    }
    return {
      serverId: node.id,
      days,
      sla: round((onlineSamples / totalSamples) * 100, 3),
      onlineSamples,
      totalSamples,
      observedDays,
    };
  });
  return { days, generatedAt: now, servers };
}

function billingCycleLabel(value, customLabel = "") {
  if (value === "custom") return customLabel || "自定义";
  return {
    monthly: "月付",
    quarterly: "季付",
    semiannual: "半年付",
    annual: "年付",
    biennial: "两年付",
    triennial: "三年付",
    "one-time": "一次性",
  }[value] || value || "未设置";
}

function daysUntilExpiration(value) {
  const timestamp = Date.parse(`${value}T23:59:59.999Z`);
  if (!Number.isFinite(timestamp)) return null;
  return Math.ceil((timestamp - Date.now()) / 86400000);
}

function formatByteCount(value) {
  const amount = Math.max(0, Number(value) || 0);
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  const index = amount ? Math.min(Math.floor(Math.log(amount) / Math.log(1024)), units.length - 1) : 0;
  return `${(amount / 1024 ** index).toFixed(index ? 2 : 0)} ${units[index]}`;
}

function telegramConfig(overrides = {}) {
  return {
    enabled: overrides.enabled ?? adminSettings.telegramEnabled,
    botToken: String(overrides.botToken ?? adminSettings.telegramBotToken ?? "").trim(),
    chatId: String(overrides.chatId ?? adminSettings.telegramChatId ?? "").trim(),
  };
}

function telegramHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function telegramDateTime(timestamp = Date.now()) {
  const parts = new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(timestamp).reduce((result, part) => ({ ...result, [part.type]: part.value }), {});
  return `${parts.year}年${parts.month}月${parts.day}日 ${parts.hour}:${parts.minute}:${parts.second}`;
}

function telegramDate(timestamp) {
  const parts = new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(timestamp)
    .reduce((result, part) => ({ ...result, [part.type]: part.value }), {});
  return `${parts.year}年${parts.month}月${parts.day}日`;
}

function telegramNotice({ icon, name, time = Date.now(), type, warning, statusIcon = "⚠️", statusLabel = "警告", details = [] }) {
  return [
    `${icon} <b>[Orange Probe] ${telegramHtml(name)}</b>`,
    "━━━━━━━━━━━━━━",
    `🕒 <b>时间：</b>${telegramHtml(telegramDateTime(time))}`,
    `🏷️ <b>类型：</b>${telegramHtml(type)}`,
    `${statusIcon} <b>${telegramHtml(statusLabel)}：</b>${telegramHtml(warning)}`,
    ...details.map((detail) => `${detail.icon || "•"} <b>${telegramHtml(detail.label)}：</b>${telegramHtml(detail.value)}`),
  ].join("\n");
}

function telegramConnectionError(error) {
  const cause = error instanceof Error && error.cause && typeof error.cause === "object" ? error.cause : null;
  const code = String(cause?.code || "").trim();
  if (error?.name === "TimeoutError" || error?.name === "AbortError") {
    return new Error("连接 Telegram API 超时，请检查服务器网络、防火墙或代理设置");
  }
  const hints = {
    EACCES: "网络访问被系统或运行环境拒绝，请检查防火墙和进程网络权限",
    EPERM: "网络访问被系统策略拒绝，请检查防火墙和进程权限",
    ENOTFOUND: "无法解析 api.telegram.org，请检查 DNS 设置",
    EAI_AGAIN: "DNS 查询暂时失败，请稍后重试或更换 DNS",
    ECONNREFUSED: "连接被拒绝，请检查代理或出口防火墙",
    ECONNRESET: "连接被重置，请检查网络稳定性或代理设置",
    ENETUNREACH: "无法访问 Telegram 网络，请检查默认路由、IPv6 或代理设置",
    ETIMEDOUT: "连接 Telegram API 超时，请检查网络或代理设置",
    CERT_HAS_EXPIRED: "TLS 证书校验失败，请检查系统时间与 CA 证书",
    UNABLE_TO_VERIFY_LEAF_SIGNATURE: "无法验证 TLS 证书链，请检查代理证书与系统 CA",
  };
  const detail = hints[code] || String(cause?.message || error?.message || "未知网络错误");
  return new Error(`无法连接 Telegram API${code ? ` (${code})` : ""}：${detail}`);
}

async function sendTelegramMessage(text, overrides = {}) {
  const config = telegramConfig(overrides);
  if (!config.enabled) throw new Error("Telegram notifications are disabled");
  if (!/^\d+:[A-Za-z0-9_-]{20,}$/.test(config.botToken)) throw new Error("Invalid Telegram Bot Token");
  if (!config.chatId) throw new Error("Telegram Chat ID is required");
  let response;
  try {
    response = await fetch(`${telegramApiBaseUrl}/bot${config.botToken}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: config.chatId, text: String(text).slice(0, 4096), parse_mode: "HTML" }),
      signal: AbortSignal.timeout(12000),
    });
  } catch (error) {
    throw telegramConnectionError(error);
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok === false) throw new Error(String(payload.description || `Telegram API HTTP ${response.status}`));
  return payload.result || {};
}

async function attemptTelegramNotification(key, text, cooldown = 15 * 60 * 1000) {
  const now = Date.now();
  if (now - (notificationAttempts.get(key) || 0) < cooldown) return false;
  const pending = pendingTelegramNotifications.get(key);
  if (pending && now - pending.lastAttempt < 60_000) return false;
  pendingTelegramNotifications.set(key, { text, cooldown, lastAttempt: now });
  try {
    await sendTelegramMessage(text);
    notificationAttempts.set(key, now);
    pendingTelegramNotifications.delete(key);
    return true;
  } catch (error) {
    console.warn(`Telegram notification failed (${key}):`, error instanceof Error ? error.message : error);
    return false;
  }
}

async function retryPendingTelegramNotifications() {
  for (const [key, pending] of pendingTelegramNotifications) {
    if (Date.now() - pending.lastAttempt < 60_000) continue;
    await attemptTelegramNotification(key, pending.text, pending.cooldown);
  }
}

let notificationRunnerBusy = false;

async function runNotificationChecks() {
  if (notificationRunnerBusy) return;
  notificationRunnerBusy = true;
  try {
    await retryPendingTelegramNotifications();
    const monitoredNodes = publicNodes(true);
    for (const node of monitoredNodes) {
      const offline = node.status === "offline";
      const wasOffline = alertStates.offline.get(node.id);
      if (alertStates.initialized && offline && wasOffline !== true && adminSettings.telegramEnabled && adminSettings.telegramOfflineAlerts) {
        pendingTelegramNotifications.delete(`online:${node.id}`);
        await attemptTelegramNotification(`offline:${node.id}`, telegramNotice({
          icon: "🔴",
          name: node.name,
          type: "节点离线",
          warning: "节点已离线",
          details: [{ icon: "📡", label: "最后上报", value: telegramDateTime(node.lastSeen) }],
        }));
      }
      if (alertStates.initialized && !offline && wasOffline === true && adminSettings.telegramEnabled && adminSettings.telegramOnlineAlerts) {
        pendingTelegramNotifications.delete(`offline:${node.id}`);
        await attemptTelegramNotification(`online:${node.id}`, telegramNotice({
          icon: "🟢",
          name: node.name,
          type: "节点上线",
          warning: "节点已恢复上线",
          statusIcon: "✅",
          statusLabel: "状态",
          details: [{ icon: "📡", label: "恢复上报", value: telegramDateTime(node.lastSeen) }],
        }));
      }
      alertStates.offline.set(node.id, offline);

      const breaches = [];
      const breachTypes = [];
      if (!offline && node.cpu >= adminSettings.cpu) { breachTypes.push("CPU"); breaches.push(`CPU ${node.cpu.toFixed(1)}% / ${adminSettings.cpu}%`); }
      if (!offline && node.memory.percent >= adminSettings.memory) { breachTypes.push("内存"); breaches.push(`内存 ${node.memory.percent.toFixed(1)}% / ${adminSettings.memory}%`); }
      if (!offline && node.disk.percent >= adminSettings.disk) { breachTypes.push("磁盘"); breaches.push(`磁盘 ${node.disk.percent.toFixed(1)}% / ${adminSettings.disk}%`); }
      const loadAbnormal = breaches.length > 0;
      const wasLoadAbnormal = alertStates.load.get(node.id);
      if (!loadAbnormal) pendingTelegramNotifications.delete(`load:${node.id}`);
      if (alertStates.initialized && loadAbnormal && wasLoadAbnormal !== true && adminSettings.telegramEnabled && adminSettings.telegramLoadAlerts) {
        await attemptTelegramNotification(`load:${node.id}`, telegramNotice({
          icon: "🟠",
          name: node.name,
          type: breachTypes.join(" / "),
          warning: "负载异常",
          details: [{ icon: "📊", label: "当前值", value: breaches.join("；") }],
        }));
      }
      alertStates.load.set(node.id, loadAbnormal);

      const trafficExceeded = Boolean(node.trafficNotify && node.trafficLimitBytes > 0 && node.trafficPercent >= node.trafficNotifyPercent);
      const wasTrafficExceeded = alertStates.traffic.get(node.id);
      if (!trafficExceeded) pendingTelegramNotifications.delete(`traffic:${node.id}`);
      if (alertStates.initialized && trafficExceeded && wasTrafficExceeded !== true && adminSettings.telegramEnabled && adminSettings.telegramTrafficAlerts) {
        await attemptTelegramNotification(`traffic:${node.id}`, telegramNotice({
          icon: "🟡",
          name: node.name,
          type: "流量阈值告警",
          warning: `已使用 ${formatByteCount(node.trafficUsed)} / 剩余 ${formatByteCount(Math.max(0, node.trafficLimitBytes - node.trafficUsed))}`,
          details: [
            { icon: "↗️", label: "上传", value: formatByteCount(node.trafficUploadUsed) },
            { icon: "↘️", label: "下载", value: formatByteCount(node.trafficDownloadUsed) },
            { icon: "📅", label: "重置日期", value: telegramDate(node.trafficWindowEnd) },
          ],
        }));
      }
      alertStates.traffic.set(node.id, trafficExceeded);

      if (!adminSettings.telegramEnabled || !adminSettings.telegramRenewalAlerts || !node.renewalNotify || !node.expirationDate) continue;
      const remaining = daysUntilExpiration(node.expirationDate);
      if (remaining === null || remaining < 0 || remaining > node.renewalNoticeDays) continue;
      const renewalKey = `${node.id}:${node.expirationDate}`;
      notificationState.renewals ||= {};
      if (notificationState.renewals[renewalKey]) continue;
      const sent = await attemptTelegramNotification(`renewal:${renewalKey}`, telegramNotice({
        icon: "🟣",
        name: node.name,
        type: "临期续费提醒",
        warning: `剩余使用时长：${remaining} 天`,
        details: [
          { icon: "📅", label: "到期时间", value: telegramDate(Date.parse(`${node.expirationDate}T23:59:59.999Z`)) },
          { icon: "💳", label: "计费周期", value: billingCycleLabel(node.billingCycle, node.customBillingCycle) },
          { icon: "🔄", label: "自动续费", value: node.autoRenew ? "是" : "否" },
          { icon: "🔗", label: "URL", value: node.renewalUrl || "未配置" },
        ],
      }), 60 * 60 * 1000);
      if (sent) {
        notificationState.renewals[renewalKey] = Date.now();
        writeJson(notificationStateFile, notificationState);
      }
    }
    alertStates.initialized = true;
  } finally {
    notificationRunnerBusy = false;
  }
}

function broadcast() {
  const publicMessage = JSON.stringify(summaryPayload(false));
  const adminMessage = JSON.stringify(summaryPayload(true));
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(client.isAdmin ? adminMessage : publicMessage);
  }
}

let hostInfo;
let previousCpuTimes;
const automaticLocalRegion = String(process.env.PROBE_AUTO_REGION || "true").toLowerCase() !== "false";
const configuredLocalRegion = String(process.env.PROBE_REGION || "").trim();
let localRegionInfo = { countryCode: "", location: configuredLocalRegion || "Local" };

function getNetworkAdapters() {
  return Object.entries(os.networkInterfaces())
    .map(([name, addresses]) => {
      const active = (addresses || []).filter((item) => !item.internal);
      if (!active.length) return null;
      const mac = active.find((item) => item.mac && item.mac !== "00:00:00:00:00:00")?.mac || "";
      return { name, mac, addresses: active.map((item) => item.address).slice(0, 16) };
    })
    .filter(Boolean)
    .slice(0, 64);
}

function getHostInfo() {
  if (hostInfo) return hostInfo;
  const cpu = os.cpus()[0] || { model: "Unknown CPU" };
  const interfaces = Object.values(os.networkInterfaces()).flat().filter(Boolean);
  const address = interfaces.find((item) => item.family === "IPv4" && !item.internal)?.address || "127.0.0.1";
  hostInfo = {
    id: `local-${hashId(os.hostname())}`,
    name: process.env.PROBE_NAME || os.hostname(),
    ...localRegionInfo,
    ip: address,
    os: `${os.type()} ${os.release()}`,
    arch: os.arch(),
    cpuModel: cpu.model || "Unknown CPU",
    cpuCores: os.cpus().length,
    version: appVersion,
    tags: ["local", "monitor"],
    source: "local",
  };
  return hostInfo;
}

async function refreshLocalRegion() {
  const detected = await resolveRegion({ automatic: automaticLocalRegion, fallback: configuredLocalRegion });
  if (automaticLocalRegion && !detected.countryCode && localRegionInfo.countryCode) return;
  localRegionInfo = detected;
  if (!hostInfo) return;
  Object.assign(hostInfo, localRegionInfo);
  const node = nodes.get(hostInfo.id);
  if (node?.source === "local") nodes.set(hostInfo.id, { ...node, ...localRegionInfo });
  broadcast();
}

function getCpuUsage() {
  const current = os.cpus().map((cpu) => ({
    idle: cpu.times.idle,
    total: Object.values(cpu.times).reduce((sum, value) => sum + value, 0),
  }));
  if (!previousCpuTimes) {
    previousCpuTimes = current;
    return { total: 0, cores: current.map(() => 0) };
  }
  const cores = current.map((item, index) => {
    const previous = previousCpuTimes[index] || item;
    const idleDelta = item.idle - previous.idle;
    const totalDelta = item.total - previous.total;
    return totalDelta > 0 ? (1 - idleDelta / totalDelta) * 100 : 0;
  });
  const currentTotal = current.reduce((result, item) => ({ idle: result.idle + item.idle, total: result.total + item.total }), { idle: 0, total: 0 });
  const previousTotal = previousCpuTimes.reduce((result, item) => ({ idle: result.idle + item.idle, total: result.total + item.total }), { idle: 0, total: 0 });
  const idleDelta = currentTotal.idle - previousTotal.idle;
  const totalDelta = currentTotal.total - previousTotal.total;
  previousCpuTimes = current;
  return { total: totalDelta > 0 ? (1 - idleDelta / totalDelta) * 100 : 0, cores };
}

let diskRootsCache = [];
let diskRootsUpdatedAt = 0;

function getDiskRoots() {
  if (diskRootsCache.length && Date.now() - diskRootsUpdatedAt < 5 * 60_000) return diskRootsCache;
  if (process.platform === "win32") {
    diskRootsCache = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("")
      .map((letter) => ({ name: `${letter}:`, mount: `${letter}:\\` }))
      .filter((item) => fs.existsSync(item.mount));
  } else if (process.platform === "linux") {
    const virtualFileSystems = new Set(["proc", "sysfs", "tmpfs", "devtmpfs", "devpts", "cgroup", "cgroup2", "pstore", "securityfs", "debugfs", "tracefs", "configfs", "fusectl", "mqueue", "hugetlbfs", "ramfs", "autofs"]);
    try {
      const seen = new Set();
      diskRootsCache = fs.readFileSync("/proc/self/mounts", "utf8").split(/\r?\n/).flatMap((line) => {
        const [device, mountValue, fileSystem] = line.split(/\s+/);
        const mount = String(mountValue || "").replace(/\\040/g, " ");
        if (!device || !mount || virtualFileSystems.has(fileSystem) || seen.has(device)) return [];
        if (["/proc", "/sys", "/dev", "/run"].some((prefix) => mount === prefix || mount.startsWith(`${prefix}/`))) return [];
        seen.add(device);
        return [{ name: device, mount }];
      });
    } catch {
      diskRootsCache = [];
    }
  }
  if (!diskRootsCache.length) diskRootsCache = [{ name: path.parse(process.cwd()).root || "/", mount: path.parse(process.cwd()).root || "/" }];
  diskRootsUpdatedAt = Date.now();
  return diskRootsCache.slice(0, 64);
}

function getDiskMetrics() {
  const disks = getDiskRoots().flatMap((item) => {
    try {
      const stats = fs.statfsSync(item.mount);
      const total = Number(stats.bsize) * Number(stats.blocks);
      const available = Number(stats.bsize) * Number(stats.bavail);
      const used = Math.max(0, total - available);
      return [{ ...item, total, used, percent: total ? round(used / total * 100) : 0 }];
    } catch {
      return [];
    }
  });
  return {
    disks,
    total: disks.reduce((sum, item) => sum + item.total, 0),
    used: disks.reduce((sum, item) => sum + item.used, 0),
  };
}

function execText(file, args) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: 3000, windowsHide: true, maxBuffer: 2 * 1024 * 1024 }, (error, stdout) => resolve(error ? "" : String(stdout)));
  });
}

function linuxSwapUsage() {
  try {
    const values = Object.fromEntries(fs.readFileSync("/proc/meminfo", "utf8")
      .split(/\r?\n/)
      .map((line) => line.match(/^(SwapTotal|SwapFree):\s+(\d+)\s+kB$/))
      .filter(Boolean)
      .map((match) => [match[1], Number(match[2]) * 1024]));
    const total = Math.max(0, values.SwapTotal || 0);
    return { total, used: Math.max(0, total - (values.SwapFree || 0)) };
  } catch {
    return { total: 0, used: 0 };
  }
}

let windowsSwapCache = { used: 0, total: 0 };
let windowsSwapUpdatedAt = 0;
function windowsSwapUsage() {
  if (Date.now() - windowsSwapUpdatedAt < 60_000) return Promise.resolve(windowsSwapCache);
  return new Promise((resolve) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", "$samples=(Get-Counter '\\Memory\\Commit Limit','\\Paging File(_Total)\\% Usage' -ErrorAction SilentlyContinue).CounterSamples; if($samples.Count -ge 2){Write-Output \"$($samples[0].CookedValue),$($samples[1].CookedValue)\"}"],
      { timeout: 5000, windowsHide: true, maxBuffer: 256 * 1024 },
      (error, stdout) => {
        windowsSwapUpdatedAt = Date.now();
        if (error) return resolve(windowsSwapCache);
        const [commitLimit, usagePercent] = String(stdout).trim().split(",").map(Number);
        const total = Math.max(0, (commitLimit || 0) - os.totalmem());
        if (total > 0) windowsSwapCache = { total, used: Math.min(total, total * Math.max(0, usagePercent || 0) / 100) };
        return resolve(windowsSwapCache);
      },
    );
  });
}

function getLocalSwapUsage() {
  if (process.platform === "linux") return Promise.resolve(linuxSwapUsage());
  if (process.platform === "win32") return windowsSwapUsage();
  return Promise.resolve({ used: 0, total: 0 });
}

function linuxSocketCounts() {
  const count = (files) => files.reduce((total, file) => {
    try {
      return total + Math.max(0, fs.readFileSync(file, "utf8").trim().split(/\r?\n/).length - 1);
    } catch {
      return total;
    }
  }, 0);
  return {
    tcpConnections: count(["/proc/net/tcp", "/proc/net/tcp6"]),
    udpConnections: count(["/proc/net/udp", "/proc/net/udp6"]),
  };
}

function linuxNetworkCounters() {
  try {
    return fs.readFileSync("/proc/net/dev", "utf8").trim().split(/\r?\n/).slice(2).reduce((result, row) => {
      const [name, data] = row.trim().split(":");
      if (!data || name.trim() === "lo") return result;
      const fields = data.trim().split(/\s+/).map(Number);
      result.rx += fields[0] || 0;
      result.tx += fields[8] || 0;
      return result;
    }, { rx: 0, tx: 0 });
  } catch {
    try {
      return fs.readdirSync("/sys/class/net").reduce((result, name) => {
        if (name === "lo") return result;
        result.rx += Number(fs.readFileSync(`/sys/class/net/${name}/statistics/rx_bytes`, "utf8").trim()) || 0;
        result.tx += Number(fs.readFileSync(`/sys/class/net/${name}/statistics/tx_bytes`, "utf8").trim()) || 0;
        return result;
      }, { rx: 0, tx: 0 });
    } catch {
      return { rx: 0, tx: 0 };
    }
  }
}

async function linuxProcessCount() {
  try {
    return fs.readdirSync("/proc", { withFileTypes: true }).filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name)).length;
  } catch {
    const output = await execText("ps", ["-e", "-o", "pid="]);
    return output.split(/\r?\n/).filter((line) => /^\s*\d+\s*$/.test(line)).length;
  }
}

let windowsSystemCache = { processCount: 0, tcpConnections: 0, udpConnections: 0 };
let windowsSystemUpdatedAt = 0;
async function windowsSystemCounts() {
  if (Date.now() - windowsSystemUpdatedAt < 15_000) return windowsSystemCache;
  const [socketOutput, processOutput, taskOutput] = await Promise.all([
    execText("netstat.exe", ["-ano"]),
    execText("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "(Get-Process -ErrorAction SilentlyContinue).Count"]),
    execText("tasklist.exe", ["/FO", "CSV", "/NH"]),
  ]);
  const lines = socketOutput.split(/\r?\n/);
  windowsSystemCache = {
    processCount: Number(processOutput.trim()) || taskOutput.split(/\r?\n/).filter((line) => line.trim() && !line.startsWith("INFO:")).length,
    tcpConnections: lines.filter((line) => /^\s*TCP\s+/i.test(line)).length,
    udpConnections: lines.filter((line) => /^\s*UDP\s+/i.test(line)).length,
  };
  windowsSystemUpdatedAt = Date.now();
  return windowsSystemCache;
}

async function getLocalPlatformStats() {
  if (process.platform === "linux") return { ...linuxNetworkCounters(), processCount: await linuxProcessCount(), ...linuxSocketCounts() };
  if (process.platform === "win32") {
    const [interfaceOutput, counts] = await Promise.all([execText("netstat.exe", ["-e"]), windowsSystemCounts()]);
    const counterLine = interfaceOutput.split(/\r?\n/).map((line) => line.match(/^\s*\D+?\s+(\d+)\s+(\d+)\s*$/)).find(Boolean);
    return { rx: Number(counterLine?.[1]) || 0, tx: Number(counterLine?.[2]) || 0, ...counts };
  }
  return { rx: 0, tx: 0, processCount: 0, tcpConnections: 0, udpConnections: 0 };
}

let previousLocalNetwork;
function getLocalNetworkMetrics(counters) {
  const current = { rx: Math.max(0, Number(counters.rx) || 0), tx: Math.max(0, Number(counters.tx) || 0), timestamp: Date.now() };
  if (!previousLocalNetwork) {
    previousLocalNetwork = current;
    return { downloadSpeed: 0, uploadSpeed: 0, downloadTotal: current.rx, uploadTotal: current.tx };
  }
  const elapsed = Math.max(0.001, (current.timestamp - previousLocalNetwork.timestamp) / 1000);
  const metrics = {
    downloadSpeed: Math.max(0, current.rx - previousLocalNetwork.rx) / elapsed,
    uploadSpeed: Math.max(0, current.tx - previousLocalNetwork.tx) / elapsed,
    downloadTotal: current.rx,
    uploadTotal: current.tx,
  };
  previousLocalNetwork = current;
  return metrics;
}

let localMetricsBusy = false;
async function collectLocalMetrics() {
  if (localMetricsBusy) return;
  localMetricsBusy = true;
  try {
    const info = getHostInfo();
    if (serverConfigs[info.id]?.localCollectorDisabled) return;
    const memoryTotal = os.totalmem();
    const memoryUsed = memoryTotal - os.freemem();
    const disk = getDiskMetrics();
    const [swap, platformStats] = await Promise.all([getLocalSwapUsage(), getLocalPlatformStats()]);
    const networkInterfaces = getNetworkAdapters();
    const cpu = getCpuUsage();
    if (serverConfigs[info.id]?.localCollectorDisabled) return;
    upsertNode({
      ...info,
      status: "online",
      cpu: cpu.total,
      cpuCoreUsage: cpu.cores,
      memory: {
        used: memoryUsed,
        total: memoryTotal,
        percent: memoryTotal ? (memoryUsed / memoryTotal) * 100 : 0,
      },
      swap: {
        used: swap.used,
        total: swap.total,
        percent: swap.total ? (swap.used / swap.total) * 100 : 0,
      },
      disk: {
        used: disk.used,
        total: disk.total,
        percent: disk.total ? (disk.used / disk.total) * 100 : 0,
      },
      disks: disk.disks,
      diskCount: disk.disks.length,
      networkInterfaces,
      networkInterfaceCount: networkInterfaces.length,
      network: getLocalNetworkMetrics(platformStats),
      load: os.loadavg(),
      uptime: os.uptime(),
      temperature: 0,
      processCount: platformStats.processCount,
      tcpConnections: platformStats.tcpConnections,
      udpConnections: platformStats.udpConnections,
      lastSeen: Date.now(),
    });
  } finally {
    localMetricsBusy = false;
  }
}

function serviceById(id) {
  return services.find((service) => String(service.id) === String(id));
}

function servicePayload(service, isAdmin) {
  const payload = { ...service };
  if (!isAdmin) {
    const normalizedName = String(payload.name || "").trim().toLowerCase();
    const normalizedTarget = String(payload.target || "").trim().toLowerCase();
    if (normalizedName && normalizedTarget && (normalizedName === normalizedTarget || normalizedName.includes(normalizedTarget))) {
      payload.name = `监控目标 ${payload.id}`;
    }
    delete payload.target;
  }
  return payload;
}

function servicesForServer(serverId, isAdmin = false) {
  return services
    .filter((service) => (isAdmin || !service.hideForGuest) && (!serverId || service.serverIds.length === 0 || service.serverIds.includes(String(serverId))))
    .sort((a, b) => b.displayIndex - a.displayIndex || a.name.localeCompare(b.name))
    .map((service) => {
      const points = (serviceHistories.get(String(service.id)) || []).filter((point) => !serverId || point.serverId === String(serverId));
      return servicePayload({ ...service, latest: points.at(-1) || null }, isAdmin);
    });
}

function recordServiceResult(serviceId, serverId, result, source = "agent") {
  const service = serviceById(serviceId);
  if (!service) return;
  const normalizedServerId = String(serverId);
  if (source === "agent" && service.serverIds.length > 0 && !service.serverIds.includes(normalizedServerId)) return;
  const now = Date.now();
  const reportedTimestamp = Number(result?.timestamp);
  const timestamp = Number.isFinite(reportedTimestamp) && Math.abs(reportedTimestamp - now) <= 5 * 60 * 1000 ? reportedTimestamp : now;
  const list = serviceHistories.get(String(service.id)) || [];
  const point = {
    timestamp,
    serverId: normalizedServerId,
    success: Boolean(result?.success),
    latency: result?.latency === null || result?.latency === undefined ? null : round(Math.min(24 * 60 * 60 * 1000, Math.max(0, Number(result.latency) || 0)), 2),
    error: String(result?.error || "").slice(0, 240),
    statusCode: Number(result?.statusCode) >= 100 && Number(result?.statusCode) <= 599 ? Math.round(Number(result.statusCode)) : null,
    source,
  };
  list.push(point);
  serviceHistories.set(String(service.id), pruneHistoryList(list));
  appendHistoryLine(serviceHistoryDir, { serviceId: String(service.id), ...point });
}

function runIcmpPing(target) {
  const args = process.platform === "win32" ? ["-n", "1", "-w", "3000", target] : ["-c", "1", "-W", "3", target];
  const startedAt = performance.now();
  return new Promise((resolve) => {
    execFile("ping", args, { timeout: 5000, windowsHide: true, maxBuffer: 512 * 1024 }, (error, stdout) => {
      const match = String(stdout).match(/(?:time|时间)?[=<]\s*(\d+(?:\.\d+)?)\s*ms/i);
      resolve({
        success: !error,
        latency: !error ? Number(match?.[1]) || performance.now() - startedAt : null,
        error: error ? "ICMP request failed" : "",
      });
    });
  });
}

function runTcpPing(target) {
  let parsed;
  try {
    parsed = new URL(`tcp://${target}`);
  } catch {
    return Promise.resolve({ success: false, latency: null, error: "Invalid TCP target" });
  }
  const startedAt = performance.now();
  return new Promise((resolve) => {
    let settled = false;
    const socket = net.createConnection({ host: parsed.hostname, port: Number(parsed.port) });
    const finish = (result) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(5000);
    socket.once("connect", () => finish({ success: true, latency: performance.now() - startedAt, error: "" }));
    socket.once("timeout", () => finish({ success: false, latency: null, error: "TCP connection timed out" }));
    socket.once("error", (error) => finish({ success: false, latency: null, error: error.code || error.message }));
  });
}

async function runMonitorCheck(service) {
  if (service.type === "icmp") return runIcmpPing(service.target);
  if (service.type === "tcp") return runTcpPing(service.target);
  const startedAt = performance.now();
  try {
    const response = await fetch(service.target, { method: "GET", redirect: "follow", signal: AbortSignal.timeout(7000) });
    response.body?.cancel();
    return {
      success: response.ok,
      latency: performance.now() - startedAt,
      statusCode: response.status,
      error: response.ok ? "" : `HTTP ${response.status}`,
    };
  } catch (error) {
    return { success: false, latency: null, error: error instanceof Error ? error.message : "HTTP request failed" };
  }
}

function monitorTasksForServer(serverId) {
  return services
    .filter((service) => service.enabled && (service.serverIds.length === 0 || service.serverIds.includes(String(serverId))))
    .map((service) => ({ id: service.id, name: service.name, type: service.type, target: service.target, interval: service.interval }));
}

let dashboardMonitorRunnerBusy = false;

async function runDashboardMonitors() {
  if (dashboardMonitorRunnerBusy) return;
  dashboardMonitorRunnerBusy = true;
  try {
    const runnableNodes = [...nodes.values()].filter((node) => node.source === "local");
    for (const service of services.filter((item) => item.enabled)) {
      const targets = runnableNodes.filter((node) => service.serverIds.length === 0 || service.serverIds.includes(node.id));
      for (const node of targets) {
        const key = `${service.id}:${node.id}`;
        const lastRun = serviceLastRuns.get(key) || 0;
        if (Date.now() - lastRun < service.interval * 1000) continue;
        serviceLastRuns.set(key, Date.now());
        recordServiceResult(service.id, node.id, await runMonitorCheck(service), "dashboard");
      }
    }
  } finally {
    dashboardMonitorRunnerBusy = false;
  }
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, version: appVersion, time: Date.now(), nodes: nodes.size });
});

app.get("/api/admin/session", (req, res) => {
  const session = sessionFromRequest(req);
  if (!session) return res.status(401).json({ authenticated: false });
  return res.json({ authenticated: true, username: session.username, expiresAt: session.expiresAt });
});

app.post("/api/admin/login", (req, res) => {
  const key = req.clientIp || requestIp(req);
  const now = Date.now();
  const attempt = loginAttempts.get(key);

  const usernameValid = safeEqual(req.body?.username || "", adminAccount.username);
  const passwordValid = validPassword(req.body?.password || "", adminAccount.password);
  if (!usernameValid || !passwordValid) {
    const current = attempt && attempt.resetAt > now ? attempt : { count: 0, resetAt: now + 10 * 60 * 1000 };
    const failedAttempts = current.count + 1;
    if (key && failedAttempts >= 5) {
      const entry = blockIp(key, { reason: "后台登录连续失败 5 次", source: "automatic", failedAttempts });
      return res.status(403).json({ error: "你的 IP 已被封禁，禁止访问！", blocked: true, ip: entry.ip });
    }
    if (key) loginAttempts.set(key, { ...current, count: failedAttempts });
    return res.status(401).json({ error: "Invalid username or password", remainingAttempts: Math.max(0, 5 - failedAttempts) });
  }

  if (key) loginAttempts.delete(key);
  const token = crypto.randomBytes(32).toString("base64url");
  const expiresAt = now + sessionTtl;
  adminSessions.set(token, { username: adminAccount.username, expiresAt });
  const secure = req.secure || req.headers["x-forwarded-proto"] === "https";
  res.setHeader(
    "Set-Cookie",
    `orange_probe_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(sessionTtl / 1000)}${secure ? "; Secure" : ""}`,
  );
  return res.json({ authenticated: true, username: adminAccount.username, expiresAt });
});

app.post("/api/admin/logout", (req, res) => {
  const session = sessionFromRequest(req);
  if (session) adminSessions.delete(session.token);
  res.setHeader("Set-Cookie", "orange_probe_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0");
  return res.json({ ok: true });
});

app.get("/api/admin/settings", requireAdmin, (_req, res) => {
  res.json(adminSettings);
});

app.put("/api/admin/settings", requireAdmin, (req, res) => {
  try {
    adminSettings = sanitizeAdminSettings(req.body, adminSettings);
    writeJson(settingsFile, adminSettings);
    broadcast();
    return res.json(adminSettings);
  } catch (error) {
    return res.status(400).json({ error: error instanceof Error ? error.message : "Invalid settings" });
  }
});

app.get("/api/admin/firewall", requireAdmin, (req, res) => {
  return res.json({
    currentIp: req.clientIp || requestIp(req),
    blocked: [...firewallEntries.values()].sort((a, b) => b.blockedAt - a.blockedAt),
  });
});

app.post("/api/admin/firewall", requireAdmin, (req, res) => {
  const ip = normalizeIp(req.body?.ip);
  if (!ip) return res.status(400).json({ error: "请输入有效的 IPv4 或 IPv6 地址" });
  if (ip === (req.clientIp || requestIp(req))) return res.status(400).json({ error: "不能封禁当前后台会话使用的 IP" });
  if (firewallEntries.has(ip)) return res.status(409).json({ error: "该 IP 已在封禁列表中" });
  try {
    return res.status(201).json(blockIp(ip, { reason: req.body?.reason, source: "manual" }));
  } catch (error) {
    return res.status(400).json({ error: error instanceof Error ? error.message : "无法封禁该 IP" });
  }
});

app.delete("/api/admin/firewall/:ip", requireAdmin, (req, res) => {
  const ip = normalizeIp(req.params.ip);
  if (!ip) return res.status(400).json({ error: "IP 地址格式无效" });
  if (!firewallEntries.delete(ip)) return res.status(404).json({ error: "该 IP 不在封禁列表中" });
  loginAttempts.delete(ip);
  persistFirewallEntries();
  return res.json({ ok: true, ip });
});

app.put("/api/admin/account", requireAdmin, (req, res) => {
  const username = String(req.body?.username || "").trim();
  const currentPassword = String(req.body?.currentPassword || "");
  const newPassword = String(req.body?.newPassword || "");
  if (!validPassword(currentPassword, adminAccount.password)) return res.status(403).json({ error: "当前密码不正确" });
  if (username.length < 3 || username.length > 64 || /[\u0000-\u001f\u007f]/.test(username)) {
    return res.status(400).json({ error: "用户名长度应为 3 到 64 个字符" });
  }
  if (newPassword && (newPassword.length < 8 || newPassword.length > 200)) {
    return res.status(400).json({ error: "新密码长度应为 8 到 200 个字符" });
  }
  adminAccount = {
    username,
    password: newPassword ? passwordRecord(newPassword) : adminAccount.password,
    updatedAt: Date.now(),
  };
  writeJson(adminAuthFile, adminAccount);
  const expiresAt = req.admin.expiresAt;
  adminSessions.clear();
  adminSessions.set(req.admin.token, { username, expiresAt });
  return res.json({ authenticated: true, username, expiresAt });
});

app.post("/api/admin/telegram/test", requireAdmin, async (req, res) => {
  try {
    const previewTime = Date.now();
    const previews = [
      telegramNotice({
        icon: "🟠",
        name: "香港演示节点-01",
        time: previewTime,
        type: "CPU / 内存 / 磁盘",
        warning: "负载异常",
        details: [{ icon: "📊", label: "当前值", value: "CPU 92.6% / 85%；内存 91.4% / 85%；磁盘 94.2% / 90%" }],
      }),
      telegramNotice({
        icon: "🔴",
        name: "东京演示节点-02",
        time: previewTime,
        type: "节点离线",
        warning: "节点已离线",
        details: [{ icon: "📡", label: "最后上报", value: telegramDateTime(previewTime - 8 * 60 * 1000) }],
      }),
      telegramNotice({
        icon: "🟢",
        name: "首尔演示节点-05",
        time: previewTime,
        type: "节点上线",
        warning: "节点已恢复上线",
        statusIcon: "✅",
        statusLabel: "状态",
        details: [{ icon: "📡", label: "恢复上报", value: telegramDateTime(previewTime) }],
      }),
      telegramNotice({
        icon: "🟡",
        name: "新加坡演示节点-03",
        time: previewTime,
        type: "流量阈值告警",
        warning: "已使用 820.00 GB / 剩余 180.00 GB",
        details: [
          { icon: "↗️", label: "上传", value: "328.00 GB" },
          { icon: "↘️", label: "下载", value: "492.00 GB" },
          { icon: "📅", label: "重置日期", value: telegramDate(previewTime + 6 * 24 * 60 * 60 * 1000) },
        ],
      }),
      telegramNotice({
        icon: "🟣",
        name: "洛杉矶演示节点-04",
        time: previewTime,
        type: "临期续费提醒",
        warning: "剩余使用时长：5 天",
        details: [
          { icon: "📅", label: "到期时间", value: telegramDate(previewTime + 5 * 24 * 60 * 60 * 1000) },
          { icon: "💳", label: "计费周期", value: "月付" },
          { icon: "🔄", label: "自动续费", value: "否" },
          { icon: "🔗", label: "URL", value: "https://billing.example.com/renew/demo-node" },
        ],
      }),
    ];
    const messageIds = [];
    for (const preview of previews) {
      const result = await sendTelegramMessage(preview, { enabled: true, botToken: req.body?.botToken, chatId: req.body?.chatId });
      if (result.message_id) messageIds.push(result.message_id);
    }
    return res.json({ ok: true, count: previews.length, messageIds });
  } catch (error) {
    return res.status(502).json({ error: error instanceof Error ? error.message : "Telegram test failed" });
  }
});

app.get("/api/admin/servers", requireAdmin, (_req, res) => {
  res.json(summaryPayload(true));
});

app.post("/api/admin/agents", requireAdmin, (req, res) => {
  const name = String(req.body?.name || "").trim().slice(0, 80);
  const token = String(req.body?.token || "").trim();
  if (!name) return res.status(400).json({ error: "Agent 名称不能为空" });
  if (!/^[A-Za-z0-9_-]{36}$/.test(token)) return res.status(400).json({ error: "TOKEN 必须为 36 位字母、数字、下划线或连字符" });
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  if (Object.values(serverConfigs).some((config) => config?.agentTokenHash && safeEqual(config.agentTokenHash, tokenHash))) {
    return res.status(409).json({ error: "该 TOKEN 已被其他 Agent 使用" });
  }
  const id = `agent-${hashId(`${tokenHash}:${Date.now()}:${name}`)}`;
  const registeredAt = Date.now();
  const internal = { name, agentTokenHash: tokenHash, agentTokenHint: token.slice(-6), agentTokenCiphertext: encryptAgentToken(token), agentRegisteredAt: registeredAt };
  serverConfigs[id] = sanitizeServerConfig({ name }, internal);
  trafficTotals[id] = { rawDownload: null, rawUpload: null, windowDownload: 0, windowUpload: 0, initialized: false, updatedAt: registeredAt };
  nodes.set(id, registeredAgentPlaceholder(id, serverConfigs[id]));
  writeJson(serverConfigsFile, serverConfigs);
  writeJson(trafficTotalsFile, trafficTotals);
  trafficTotalsDirty = false;
  broadcast();
  return res.status(201).json({ id, name, token, tokenHint: token.slice(-6), createdAt: registeredAt, ...deploymentInfo(req) });
});

function uniqueAgentToken() {
  let token = "";
  let tokenHash = "";
  do {
    token = crypto.randomUUID();
    tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  } while (Object.values(serverConfigs).some((config) => config?.agentTokenHash && safeEqual(config.agentTokenHash, tokenHash)));
  return { token, tokenHash };
}

function sendAgentInstallInfo(req, res, createMissing = false) {
  const node = nodes.get(req.params.id);
  if (!node) return res.status(404).json({ error: "Server not found" });
  let config = serverConfigs[req.params.id];
  let token = "";
  if (!config?.agentTokenHash) {
    if (!createMissing) return res.status(404).json({ error: "Agent install command not found" });
    const credentials = uniqueAgentToken();
    token = credentials.token;
    const registeredAt = Date.now();
    const internal = {
      ...(config || {}),
      name: config?.name || node.name,
      agentTokenHash: credentials.tokenHash,
      agentTokenHint: token.slice(-6),
      agentTokenCiphertext: encryptAgentToken(token),
      agentRegisteredAt: registeredAt,
    };
    config = sanitizeServerConfig({ name: internal.name }, internal);
    serverConfigs[req.params.id] = config;
    writeJson(serverConfigsFile, serverConfigs);
  }
  if (!config.agentTokenCiphertext) return res.status(409).json({ error: "该 Agent 创建于安装命令保存功能启用之前，请删除后重新添加" });
  try {
    return res.json({ id: req.params.id, name: config.name || node.name, token: token || decryptAgentToken(config.agentTokenCiphertext), tokenHint: config.agentTokenHint || "", ...deploymentInfo(req) });
  } catch {
    return res.status(500).json({ error: "无法解密该 Agent 的安装命令，请检查服务端加密密钥" });
  }
}

app.get("/api/admin/agents/:id/install", requireAdmin, (req, res) => {
  return sendAgentInstallInfo(req, res, false);
});

app.post("/api/admin/agents/:id/install", requireAdmin, (req, res) => {
  return sendAgentInstallInfo(req, res, true);
});

app.get("/api/admin/agents/:id/status", requireAdmin, (req, res) => {
  const config = serverConfigs[req.params.id];
  const node = publicNodes(true).find((item) => item.id === req.params.id);
  if (!config?.agentTokenHash || !node) return res.status(404).json({ error: "Agent not found" });
  const online = node.source === "agent" && node.status === "online";
  return res.json({ id: node.id, name: node.name, status: online ? "online" : "offline", online, lastSeen: node.lastSeen, ip: node.ip, version: node.version });
});

app.get("/api/admin/updates", requireAdmin, async (req, res) => {
  expireAgentUpdateEntries();
  await syncServerUpdaterState();
  const release = await latestGithubRelease(String(req.query.refresh || "") === "1");
  const serverUpdateRequired = compareVersions(release.version, appVersion) > 0;
  const agents = Object.entries(serverConfigs)
    .filter(([, config]) => Boolean(config?.agentTokenHash))
    .map(([id, config]) => {
      const node = nodes.get(id) || registeredAgentPlaceholder(id, config);
      const storedEntry = updateEntryForAgent(id);
      const entry = !serverUpdateRequired && storedEntry?.targetVersion === appVersion ? storedEntry : null;
      const capabilities = Array.isArray(node.capabilities) ? node.capabilities : [];
      const supportsAutoUpdate = capabilities.includes("self-update");
      const packageUpdateAvailable = supportsAutoUpdate && compareVersions(node.version, appVersion) < 0;
      const latestUpdateAvailable = supportsAutoUpdate && compareVersions(node.version, release.version) < 0;
      const updateAvailable = packageUpdateAvailable && !serverUpdateRequired;
      return {
        id,
        name: config.name || node.name,
        online: node.source === "agent" && node.status === "online",
        version: node.version || "--",
        targetVersion: entry?.targetVersion || release.version,
        packageVersion: appVersion,
        latestVersion: release.version,
        status: entry?.status || (serverUpdateRequired && latestUpdateAvailable ? "server-required" : updateAvailable ? "available" : supportsAutoUpdate ? "current" : "manual"),
        error: entry?.error || "",
        requestedAt: Number(entry?.requestedAt) || 0,
        updatedAt: Number(entry?.updatedAt || entry?.completedAt) || 0,
        supportsAutoUpdate,
        updateAvailable,
        serverUpdateRequired: serverUpdateRequired && latestUpdateAvailable,
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name, "zh-CN"));
  return res.json({
    repository: githubRepository,
    agentPackageVersion: appVersion,
    server: {
      currentVersion: appVersion,
      latestVersion: release.version,
      releaseUrl: release.url,
      publishedAt: release.publishedAt,
      updateAvailable: compareVersions(release.version, appVersion) > 0,
      updaterConfigured: Boolean(updaterUrl && updaterToken),
      status: updateState.server.status || "idle",
      error: updateState.server.error || latestReleaseCache.error || "",
      requestedAt: Number(updateState.server.requestedAt) || 0,
      completedAt: Number(updateState.server.completedAt) || 0,
    },
    agents,
  });
});

app.post("/api/admin/updates/agents", requireAdmin, (req, res) => {
  const requestedIds = req.body?.all ? Object.keys(serverConfigs) : Array.isArray(req.body?.agentIds) ? req.body.agentIds.map(String) : [];
  const force = Boolean(req.body?.force);
  const queued = [];
  const skipped = [];
  for (const id of [...new Set(requestedIds)].slice(0, 500)) {
    const config = serverConfigs[id];
    const node = nodes.get(id);
    const supportsAutoUpdate = Array.isArray(node?.capabilities) && node.capabilities.includes("self-update");
    if (!config?.agentTokenHash || !supportsAutoUpdate) {
      skipped.push({ id, reason: "Agent 需要先重新执行 v1.1.2 或更高版本的安装命令" });
      continue;
    }
    if (!force && compareVersions(node.version, appVersion) >= 0) {
      skipped.push({ id, reason: "已是当前版本" });
      continue;
    }
    const existingEntry = updateEntryForAgent(id);
    if (existingEntry?.targetVersion === appVersion && new Set(["pending", "installing"]).has(existingEntry.status)) {
      skipped.push({ id, reason: "已有更新任务正在执行" });
      continue;
    }
    updateState.agents[id] = { targetVersion: appVersion, attemptId: crypto.randomUUID(), status: "pending", force, requestedAt: Date.now(), updatedAt: Date.now(), dispatchCount: 0, error: "" };
    queued.push(id);
  }
  saveUpdateState();
  return res.json({ ok: true, targetVersion: appVersion, queued, skipped });
});

app.post("/api/admin/updates/server", requireAdmin, async (req, res) => {
  if (!updaterUrl || !updaterToken) return res.status(503).json({ error: "服务端更新容器未配置，请使用 v1.1.2 或更高版本的 Docker Compose 部署" });
  const release = await latestGithubRelease(true);
  if (!req.body?.force && compareVersions(release.version, appVersion) <= 0) return res.status(409).json({ error: "服务端已经是最新版本" });
  updateState.server = { targetVersion: release.version, status: "requested", requestedAt: Date.now(), updatedAt: Date.now(), error: "" };
  saveUpdateState();
  try {
    const response = await fetch(`${updaterUrl}/update`, {
      method: "POST",
      headers: { authorization: `Bearer ${updaterToken}`, "content-type": "application/json" },
      body: JSON.stringify({ targetVersion: release.version, requestedBy: "orange-probe-admin" }),
      signal: AbortSignal.timeout(10_000),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `Updater HTTP ${response.status}`);
    updateState.server = { ...updateState.server, status: "running", updatedAt: Date.now(), error: "" };
    saveUpdateState();
    return res.status(202).json({ ok: true, targetVersion: release.version, message: payload.message || "更新任务已提交，服务端将自动重启" });
  } catch (error) {
    updateState.server = { ...updateState.server, status: "failed", error: error instanceof Error ? error.message : "Updater request failed", updatedAt: Date.now() };
    saveUpdateState();
    return res.status(502).json({ error: updateState.server.error });
  }
});

app.get("/api/admin/sla", requireAdmin, (req, res) => {
  res.json(slaPayload(req.query.days));
});

app.put("/api/admin/servers/:id", requireAdmin, (req, res) => {
  const node = nodes.get(req.params.id);
  if (!node) return res.status(404).json({ error: "Server not found" });
  try {
    serverConfigs[req.params.id] = sanitizeServerConfig(req.body, serverConfigs[req.params.id]);
    writeJson(serverConfigsFile, serverConfigs);
    broadcast();
    runNotificationChecks();
    return res.json(configuredNode(node, true));
  } catch (error) {
    return res.status(400).json({ error: error instanceof Error ? error.message : "Invalid server settings" });
  }
});

app.delete("/api/admin/servers/:id", requireAdmin, (req, res) => {
  const node = nodes.get(req.params.id);
  if (!node) return res.status(404).json({ error: "Server not found" });
  const serverId = req.params.id;
  const localHostNode = node.source === "local" || req.params.id === getHostInfo().id;
  nodes.delete(serverId);
  history.delete(serverId);
  removePersistedHistory(nodeHistoryDir, "serverId", serverId);
  delete availabilityHistory[serverId];
  delete trafficTotals[serverId];
  delete updateState.agents[serverId];
  if (localHostNode) {
    serverConfigs[serverId] = {
      name: serverConfigs[serverId]?.name || node.name,
      localCollectorDisabled: true,
      deletedLocalNode: true,
      updatedAt: Date.now(),
    };
  } else {
    delete serverConfigs[serverId];
  }
  let servicesChanged = false;
  services = services.map((service) => {
    if (!service.serverIds.includes(serverId)) return service;
    servicesChanged = true;
    return { ...service, serverIds: service.serverIds.filter((id) => id !== serverId), updatedAt: Date.now() };
  });
  for (const key of serviceLastRuns.keys()) if (key.endsWith(`:${serverId}`)) serviceLastRuns.delete(key);
  alertStates.offline.delete(serverId);
  alertStates.load.delete(serverId);
  alertStates.traffic.delete(serverId);
  const notificationBelongsToServer = (key) => new Set([`offline:${serverId}`, `online:${serverId}`, `load:${serverId}`, `traffic:${serverId}`]).has(key) || key.startsWith(`renewal:${serverId}:`);
  for (const key of pendingTelegramNotifications.keys()) if (notificationBelongsToServer(key)) pendingTelegramNotifications.delete(key);
  for (const key of notificationAttempts.keys()) if (notificationBelongsToServer(key)) notificationAttempts.delete(key);
  if (servicesChanged) {
    writeJson(servicesFile, services);
  }
  if (notificationState.renewals) {
    for (const key of Object.keys(notificationState.renewals)) {
      if (key.startsWith(`${serverId}:`)) delete notificationState.renewals[key];
    }
  }
  writeJson(serverConfigsFile, serverConfigs);
  writeJson(availabilityFile, availabilityHistory);
  writeJson(trafficTotalsFile, trafficTotals);
  saveUpdateState();
  trafficTotalsDirty = false;
  writeJson(notificationStateFile, notificationState);
  broadcast();
  return res.json({ ok: true });
});

app.get("/api/admin/services", requireAdmin, (_req, res) => {
  res.json({ services: servicesForServer(undefined, true) });
});

app.post("/api/admin/services", requireAdmin, (req, res) => {
  try {
    const nextId = services.reduce((maximum, service) => Math.max(maximum, Number(service.id) || 0), 0) + 1;
    const service = sanitizeService(req.body, { id: nextId, createdAt: Date.now() });
    services.push(service);
    writeJson(servicesFile, services);
    return res.status(201).json(service);
  } catch (error) {
    return res.status(400).json({ error: error instanceof Error ? error.message : "Invalid service" });
  }
});

app.put("/api/admin/services/interval", requireAdmin, (req, res) => {
  const interval = Math.round(Number(req.body?.interval));
  if (!Number.isFinite(interval) || interval < 5 || interval > 86400) return res.status(400).json({ error: "监控间隔必须在 5 到 86400 秒之间" });
  const updatedAt = Date.now();
  services = services.map((service) => ({ ...service, interval, updatedAt }));
  serviceLastRuns.clear();
  writeJson(servicesFile, services);
  return res.json({ updated: services.length, interval, services: servicesForServer(undefined, true) });
});

app.put("/api/admin/services/:id", requireAdmin, (req, res) => {
  const index = services.findIndex((service) => String(service.id) === req.params.id);
  if (index === -1) return res.status(404).json({ error: "Service not found" });
  try {
    services[index] = sanitizeService(req.body, services[index]);
    writeJson(servicesFile, services);
    return res.json(services[index]);
  } catch (error) {
    return res.status(400).json({ error: error instanceof Error ? error.message : "Invalid service" });
  }
});

app.delete("/api/admin/services/:id", requireAdmin, (req, res) => {
  const before = services.length;
  services = services.filter((service) => String(service.id) !== req.params.id);
  if (services.length === before) return res.status(404).json({ error: "Service not found" });
  serviceHistories.delete(req.params.id);
  removePersistedHistory(serviceHistoryDir, "serviceId", req.params.id);
  writeJson(servicesFile, services);
  return res.json({ ok: true });
});

app.get("/api/services", (req, res) => {
  const isAdmin = Boolean(sessionFromRequest(req));
  res.json({ services: servicesForServer(req.query.serverId ? String(req.query.serverId) : undefined, isAdmin) });
});

app.get("/api/services/:id/history", (req, res) => {
  const service = serviceById(req.params.id);
  const isAdmin = Boolean(sessionFromRequest(req));
  if (!service || (service.hideForGuest && !isAdmin)) return res.status(404).json({ error: "Service not found" });
  const serverId = req.query.serverId ? String(req.query.serverId) : "";
  const period = new Set(["realtime", "1d", "7d"]).has(String(req.query.period)) ? String(req.query.period) : "realtime";
  const matching = (serviceHistories.get(String(service.id)) || []).filter((point) => !serverId || point.serverId === serverId);
  return res.json({ service: servicePayload(service, isAdmin), period, retentionDays: 7, points: historyPointsForPeriod(matching, period) });
});

app.get("/api/servers", (req, res) => {
  res.json(summaryPayload(Boolean(sessionFromRequest(req))));
});

app.get("/api/servers/:id/history", (req, res) => {
  const node = nodes.get(req.params.id);
  const isAdmin = Boolean(sessionFromRequest(req));
  if (!node) return res.status(404).json({ error: "Server not found" });
  const serverInfo = configuredNode(node, isAdmin);
  if (serverInfo.hideForGuest && !isAdmin) return res.status(404).json({ error: "Server not found" });
  const period = new Set(["realtime", "1d", "7d"]).has(String(req.query.period)) ? String(req.query.period) : "realtime";
  return res.json({ server: serverInfo, period, retentionDays: 7, points: historyPointsForPeriod(history.get(req.params.id) || [], period) });
});

function agentRegistrationForToken(suppliedToken) {
  const suppliedTokenHash = crypto.createHash("sha256").update(suppliedToken).digest("hex");
  const registeredAgent = Object.entries(serverConfigs).find(([, config]) => config?.agentTokenHash && safeEqual(config.agentTokenHash, suppliedTokenHash));
  const legacyTokenValid = Boolean(probeToken && suppliedToken && safeEqual(suppliedToken, probeToken));
  return registeredAgent || (legacyTokenValid ? [null, null] : null);
}

function acceptAgentReport(report, suppliedToken) {
  const registeredAgent = agentRegistrationForToken(suppliedToken);
  if (!registeredAgent) {
    const error = new Error("Invalid probe token");
    error.statusCode = 401;
    throw error;
  }
  if (!report || typeof report !== "object" || !report.id || !report.name) {
    const error = new Error("Invalid report payload");
    error.statusCode = 400;
    throw error;
  }

  const registeredId = registeredAgent?.[0] || null;
  if (registeredId && registeredId === getHostInfo().id && !serverConfigs[registeredId]?.localCollectorDisabled) {
    serverConfigs[registeredId] = {
      ...serverConfigs[registeredId],
      localCollectorDisabled: true,
      deletedLocalNode: false,
      updatedAt: Date.now(),
    };
    writeJson(serverConfigsFile, serverConfigs);
  }

  const { monitorResults, updateStatus, ...nodeReport } = report;
  const node = upsertNode({
    ...nodeReport,
    id: registeredId || `agent-${String(report.id).replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64)}`,
    name: registeredAgent?.[1]?.name || report.name,
    source: "agent",
    status: "online",
    lastSeen: Date.now(),
  });
  if (Array.isArray(monitorResults)) {
    for (const result of monitorResults.slice(0, 100)) {
      recordServiceResult(result.serviceId, node.id, result, "agent");
    }
  }
  const updateResult = applyAgentUpdateReport(node, { updateStatus });
  broadcast();
  return {
    ok: true,
    id: node.id,
    nextReportIn: Math.max(1000, Number(report.reportInterval) || 3000),
    monitors: monitorTasksForServer(node.id),
    updateStatusAcknowledged: Boolean(updateResult.updateStatusAcknowledged),
    ...(updateResult.update ? { update: updateResult.update } : {}),
  };
}

app.post("/api/agents/report", (req, res) => {
  try {
    return res.json(acceptAgentReport(req.body, String(req.headers["x-probe-token"] || "")));
  } catch (error) {
    return res.status(Number(error?.statusCode) || 400).json({ error: error instanceof Error ? error.message : "Agent report rejected" });
  }
});

app.post("/api/servers/:id/ping", requireAdmin, async (req, res) => {
  const node = nodes.get(req.params.id);
  if (!node) return res.status(404).json({ error: "Server not found" });
  if (node.status === "offline") return res.json({ ok: false, latency: null, checkedAt: Date.now() });
  const result = await runIcmpPing(node.ip);
  return res.json({ ok: result.success, latency: result.latency, error: result.error, checkedAt: Date.now() });
});

server.on("upgrade", (request, socket, head) => {
  const clientIp = requestIp(request);
  if (clientIp && firewallEntries.has(clientIp)) {
    const body = JSON.stringify({ error: "你的 IP 已被封禁，禁止访问！", blocked: true, ip: clientIp });
    socket.end(`HTTP/1.1 403 Forbidden\r\nContent-Type: application/json; charset=utf-8\r\nCache-Control: no-store\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
    return;
  }
  const pathname = new URL(request.url || "/", "http://localhost").pathname;
  if (pathname === "/ws") {
    if (!requestOriginAllowed(request)) return socket.destroy();
    return wss.handleUpgrade(request, socket, head, (ws) => wss.emit("connection", ws, request));
  }
  if (pathname === "/agent-ws") return agentWss.handleUpgrade(request, socket, head, (ws) => agentWss.emit("connection", ws, request));
  return socket.destroy();
});

wss.on("connection", (socket, request) => {
  socket.isAdmin = Boolean(sessionFromRequest(request));
  socket.send(JSON.stringify(summaryPayload(socket.isAdmin)));
});

agentWss.on("connection", (socket) => {
  socket.agentToken = "";
  const authenticationTimer = setTimeout(() => socket.close(4401, "Authentication timeout"), 10_000);
  socket.on("message", (raw) => {
    let message;
    try {
      message = JSON.parse(String(raw));
    } catch {
      return socket.close(4400, "Invalid JSON");
    }
    if (!socket.agentToken) {
      const token = message?.type === "auth" ? String(message.token || "") : "";
      if (!token || !agentRegistrationForToken(token)) return socket.close(4401, "Invalid probe token");
      socket.agentToken = token;
      clearTimeout(authenticationTimer);
      return socket.send(JSON.stringify({ type: "authenticated", reportInterval: 3000 }));
    }
    if (message?.type !== "report") return socket.send(JSON.stringify({ type: "error", error: "Unsupported message type" }));
    try {
      const result = acceptAgentReport(message.payload, socket.agentToken);
      return socket.send(JSON.stringify({ type: "report-accepted", ...result }));
    } catch (error) {
      const statusCode = Number(error?.statusCode) || 400;
      socket.send(JSON.stringify({ type: "report-rejected", statusCode, error: error instanceof Error ? error.message : "Agent report rejected" }));
      if (statusCode === 401) socket.close(4401, "Invalid probe token");
    }
  });
  socket.on("close", () => clearTimeout(authenticationTimer));
});

for (const websocketServer of [wss, agentWss]) {
  websocketServer.on("connection", (socket) => {
    socket.isAlive = true;
    socket.on("pong", () => { socket.isAlive = true; });
  });
}

const websocketHeartbeat = setInterval(() => {
  for (const websocketServer of [wss, agentWss]) {
    for (const socket of websocketServer.clients) {
      if (socket.isAlive === false) {
        socket.terminate();
        continue;
      }
      socket.isAlive = false;
      socket.ping();
    }
  }
}, 30_000);
websocketHeartbeat.unref();

const downloadableAgentFiles = new Map([
  ["/downloads/agent/index.js", { file: path.join(rootDir, "agent", "index.js"), type: "text/javascript; charset=utf-8" }],
  ["/downloads/agent/region.js", { file: path.join(rootDir, "agent", "region.js"), type: "text/javascript; charset=utf-8" }],
  ["/downloads/agent/updater.js", { file: path.join(rootDir, "agent", "updater.js"), type: "text/javascript; charset=utf-8" }],
  ["/downloads/agent/package.json", { file: path.join(rootDir, "agent", "package.json"), type: "application/json; charset=utf-8" }],
  ["/downloads/agent/package-lock.json", { file: path.join(rootDir, "agent", "package-lock.json"), type: "application/json; charset=utf-8" }],
  ["/downloads/agent/install-linux.sh", { file: path.join(rootDir, "agent", "install-linux.sh"), type: "text/x-shellscript; charset=utf-8" }],
  ["/downloads/agent/install-windows.ps1", { file: path.join(rootDir, "agent", "install-windows.ps1"), type: "text/plain; charset=utf-8" }],
]);

app.get("/downloads/agent/manifest.json", (_req, res) => {
  const updateFiles = ["index.js", "region.js", "updater.js", "package.json", "package-lock.json"];
  const files = updateFiles.map((name) => {
    const download = downloadableAgentFiles.get(`/downloads/agent/${name}`);
    if (!download || !fs.existsSync(download.file)) return null;
    const content = fs.readFileSync(download.file);
    return { name, url: `/downloads/agent/${name}?v=${encodeURIComponent(appVersion)}`, size: content.length, sha256: crypto.createHash("sha256").update(content).digest("hex") };
  }).filter(Boolean);
  if (files.length !== updateFiles.length) return res.status(503).json({ error: "Agent update package is incomplete" });
  res.setHeader("Cache-Control", "no-store");
  return res.json({ version: appVersion, generatedAt: Date.now(), files });
});

const flagIconDirectory = path.join(rootDir, "node_modules", "flag-icons", "flags", "4x3");

app.get("/flags/:file", (req, res) => {
  const file = String(req.params.file || "").toLowerCase();
  if (!/^[a-z]{2}\.svg$/.test(file)) return res.status(404).end();
  const flagFile = path.join(flagIconDirectory, file);
  if (!fs.existsSync(flagFile)) return res.status(404).end();
  res.setHeader("Cache-Control", "public, max-age=86400");
  return res.type("image/svg+xml").sendFile(flagFile);
});

app.get([...downloadableAgentFiles.keys()], (req, res) => {
  const download = downloadableAgentFiles.get(req.path);
  if (!download || !fs.existsSync(download.file)) return res.status(404).json({ error: "Agent package not found" });
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  res.type(download.type);
  return res.sendFile(download.file);
});

const distDir = path.join(rootDir, "dist");
if (fs.existsSync(distDir)) {
  app.use(express.static(distDir));
  app.use((req, res, next) => {
    if (req.method !== "GET" || req.path.startsWith("/api")) return next();
    return res.sendFile(path.join(distDir, "index.html"));
  });
}

loadPersistedHistories();
hydrateRegisteredAgents();

setInterval(() => {
  collectLocalMetrics();
  broadcast();
}, 3000);

setInterval(runDashboardMonitors, 5000);
setInterval(recordAvailabilitySample, 60 * 1000);
setInterval(runNotificationChecks, 15 * 1000);
setInterval(cleanupHistoryFiles, 60 * 60 * 1000);
setInterval(() => {
  const now = Date.now();
  for (const [token, session] of adminSessions) if (session.expiresAt <= now) adminSessions.delete(token);
  for (const [key, attempt] of loginAttempts) if (attempt.resetAt <= now) loginAttempts.delete(key);
}, 10 * 60 * 1000).unref();

server.listen(port, "0.0.0.0", () => {
  console.log(`Orange Probe API listening on http://localhost:${port}`);
  if (!adminAuthExistedAtStartup && !process.env.ADMIN_PASSWORD) console.warn("Admin password is using the development default; change it in the admin settings before deployment.");
  if (!process.env.PROBE_TOKEN) console.warn("Probe token is using the development default; set PROBE_TOKEN before deployment.");
  collectLocalMetrics();
  broadcast();
  runDashboardMonitors();
  recordAvailabilitySample();
  runNotificationChecks();
  refreshLocalRegion();
});

setInterval(refreshLocalRegion, 6 * 60 * 60 * 1000).unref();
