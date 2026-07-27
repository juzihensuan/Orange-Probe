import crypto from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { resolveRegion } from "./region.js";
import { AGENT_UPDATE_FILES, installStagedUpdate } from "./updater.js";

const serverUrl = (process.env.PROBE_SERVER_URL || "http://127.0.0.1:4174").replace(/\/$/, "");
const transport = process.env.PROBE_TRANSPORT === "ws" ? "ws" : "http";
const wsUrl = (process.env.PROBE_WS_URL || `${serverUrl.replace(/^http/, "ws")}/agent-ws`).replace(/\/$/, "");
const token = process.env.PROBE_TOKEN || "orange-probe-agent";
const interval = Math.max(1000, Number(process.env.REPORT_INTERVAL || 3000));
const automaticRegion = String(process.env.PROBE_AUTO_REGION || "true").toLowerCase() !== "false";
const configuredRegion = String(process.env.PROBE_REGION || "").trim();
const agentRootDir = path.dirname(fileURLToPath(import.meta.url));
const agentDataDir = path.resolve(process.env.AGENT_DATA_DIR || path.join(agentRootDir, "data"));
const agentLogDir = path.join(agentDataDir, "logs");
const updateResultFile = path.join(agentDataDir, "update-result.json");
const logRetentionDays = Math.min(90, Math.max(1, Number(process.env.AGENT_LOG_RETENTION_DAYS || 7)));
const logRetentionMs = logRetentionDays * 24 * 60 * 60 * 1000;
const tags = (process.env.PROBE_TAGS || "remote")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);

let fileLoggingAvailable = true;
let lastHealthyLogAt = 0;
let lastErrorMessage = "";
let lastErrorAt = 0;
let suppressedErrorCount = 0;
let updateInProgress = false;
let updateStatus = null;

try {
  fs.mkdirSync(agentLogDir, { recursive: true });
} catch (error) {
  fileLoggingAvailable = false;
  console.error(`[${new Date().toISOString()}] cannot initialize Agent log directory:`, error instanceof Error ? error.message : error);
}

try {
  const storedUpdateStatus = JSON.parse(fs.readFileSync(updateResultFile, "utf8"));
  if (storedUpdateStatus && typeof storedUpdateStatus === "object") updateStatus = storedUpdateStatus;
} catch {
  updateStatus = null;
}

function appendAgentLog(level, message) {
  const line = `[${new Date().toISOString()}] ${level} ${String(message).replace(/[\r\n]+/g, " ")}\n`;
  if (level === "ERROR") console.error(line.trimEnd());
  else console.log(line.trimEnd());
  if (!fileLoggingAvailable) return;
  try {
    fs.appendFileSync(path.join(agentLogDir, `${new Date().toISOString().slice(0, 10)}.log`), line, "utf8");
  } catch (error) {
    fileLoggingAvailable = false;
    console.error(`[${new Date().toISOString()}] cannot write Agent log:`, error instanceof Error ? error.message : error);
  }
}

function cleanupAgentLogs() {
  if (!fileLoggingAvailable) return;
  const cutoff = Date.now() - logRetentionMs;
  try {
    for (const entry of fs.readdirSync(agentLogDir, { withFileTypes: true })) {
      if (!entry.isFile() || !/^\d{4}-\d{2}-\d{2}\.log$/.test(entry.name)) continue;
      const file = path.join(agentLogDir, entry.name);
      if (fs.statSync(file).mtimeMs < cutoff) fs.unlinkSync(file);
    }
  } catch (error) {
    appendAgentLog("ERROR", `log cleanup failed: ${error instanceof Error ? error.message : error}`);
  }
}

function logHealthyReport(destination) {
  lastErrorMessage = "";
  lastErrorAt = 0;
  suppressedErrorCount = 0;
  if (Date.now() - lastHealthyLogAt < 60 * 60 * 1000) return;
  lastHealthyLogAt = Date.now();
  appendAgentLog("INFO", `report accepted by ${destination}`);
}

function logReportError(error) {
  const message = error instanceof Error ? error.message : String(error);
  const now = Date.now();
  if (message === lastErrorMessage && now - lastErrorAt < 5 * 60 * 1000) {
    suppressedErrorCount += 1;
    return;
  }
  const suffix = suppressedErrorCount ? ` (${suppressedErrorCount} identical errors suppressed)` : "";
  appendAgentLog("ERROR", `report failed: ${message}${suffix}`);
  lastErrorMessage = message;
  lastErrorAt = now;
  suppressedErrorCount = 0;
}

function compareVersions(left, right) {
  const parts = (value) => String(value || "0.0.0").replace(/^v/i, "").split(".").slice(0, 3).map((part) => Number.parseInt(part, 10) || 0);
  const leftParts = parts(left);
  const rightParts = parts(right);
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] !== rightParts[index]) return leftParts[index] > rightParts[index] ? 1 : -1;
  }
  return 0;
}

function saveUpdateStatus(status) {
  updateStatus = status;
  try {
    fs.mkdirSync(agentDataDir, { recursive: true });
    fs.writeFileSync(updateResultFile, `${JSON.stringify(status, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  } catch (error) {
    appendAgentLog("ERROR", `cannot persist update status: ${error instanceof Error ? error.message : error}`);
  }
}

function refreshUpdateStatusFromDisk() {
  try {
    const storedStatus = JSON.parse(fs.readFileSync(updateResultFile, "utf8"));
    if (!storedStatus || typeof storedStatus !== "object") return;
    if (!updateStatus || Number(storedStatus.timestamp || 0) >= Number(updateStatus.timestamp || 0)) updateStatus = storedStatus;
  } catch (error) {
    if (error?.code !== "ENOENT") appendAgentLog("ERROR", `cannot refresh update status: ${error instanceof Error ? error.message : error}`);
  }
}

function acknowledgeUpdateStatus() {
  if (!updateStatus) return;
  updateStatus = null;
  try {
    fs.unlinkSync(updateResultFile);
  } catch (error) {
    if (error?.code !== "ENOENT") appendAgentLog("ERROR", `cannot clear update status: ${error instanceof Error ? error.message : error}`);
  }
}

async function performAgentUpdate(update) {
  if (updateInProgress || !update?.version || !update?.manifestUrl) return;
  if (!update.force && compareVersions(staticInfo.version, update.version) >= 0) return;
  updateInProgress = true;
  const attemptId = String(update.attemptId || "");
  const stagingDir = path.join(agentDataDir, `update-${Date.now()}`);
  try {
    const manifestUrl = new URL(String(update.manifestUrl), `${serverUrl}/`).toString();
    const manifestResponse = await fetch(manifestUrl, { signal: AbortSignal.timeout(15_000) });
    if (!manifestResponse.ok) throw new Error(`manifest HTTP ${manifestResponse.status}`);
    const manifest = await manifestResponse.json();
    if (String(manifest.version) !== String(update.version)) throw new Error(`manifest version ${manifest.version || "unknown"} does not match ${update.version}`);
    const allowedFiles = new Set(AGENT_UPDATE_FILES);
    const files = Array.isArray(manifest.files) ? manifest.files : [];
    if (files.length !== allowedFiles.size || files.some((file) => !allowedFiles.has(String(file?.name || "")))) throw new Error("manifest file list is invalid");
    fs.mkdirSync(stagingDir, { recursive: true });
    for (const file of files) {
      const fileUrl = new URL(String(file.url || ""), manifestUrl).toString();
      const response = await fetch(fileUrl, { signal: AbortSignal.timeout(20_000) });
      if (!response.ok) throw new Error(`${file.name} HTTP ${response.status}`);
      const content = Buffer.from(await response.arrayBuffer());
      const digest = crypto.createHash("sha256").update(content).digest("hex");
      if (!/^[a-f0-9]{64}$/i.test(String(file.sha256 || "")) || digest !== String(file.sha256).toLowerCase()) throw new Error(`${file.name} SHA256 verification failed`);
      fs.writeFileSync(path.join(stagingDir, file.name), content, { mode: 0o600 });
    }
    appendAgentLog("INFO", `verified Agent update v${update.version}; installing before restart`);
    saveUpdateStatus({ state: "installing", targetVersion: String(update.version), attemptId, timestamp: Date.now() });
    const installed = installStagedUpdate({ stagingDir, installDir: agentRootDir, dataDir: agentDataDir, attemptId, allowDependencyChanges: true });
    if (String(installed.version) !== String(update.version)) throw new Error(`installed version ${installed.version} does not match ${update.version}`);
    saveUpdateStatus({ state: "success", targetVersion: String(update.version), attemptId, timestamp: Date.now() });
    appendAgentLog("INFO", `Agent update v${update.version} installed; restarting to activate it`);
    setTimeout(() => process.exit(75), 250).unref();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    saveUpdateStatus({ state: "failed", targetVersion: String(update.version), attemptId, error: message, timestamp: Date.now() });
    appendAgentLog("ERROR", `Agent update v${update.version} failed: ${message}`);
    try {
      fs.rmSync(stagingDir, { recursive: true, force: true });
    } catch {
      // A later update attempt uses a new staging directory.
    }
    updateInProgress = false;
  }
}

function scheduleAgentUpdate(update) {
  if (!update || updateInProgress) return;
  setTimeout(() => performAgentUpdate(update), 100).unref();
}

const round = (value, precision = 1) => {
  const factor = 10 ** precision;
  return Math.round((Number(value) || 0) * factor) / factor;
};

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function getInterfaces() {
  return Object.values(os.networkInterfaces()).flat().filter(Boolean);
}

function getNetworkAdapters() {
  return Object.entries(os.networkInterfaces())
    .map(([name, addresses]) => {
      const active = (addresses || []).filter((item) => !item.internal);
      if (!active.length) return null;
      const mac = active.find((item) => item.mac && item.mac !== "00:00:00:00:00:00")?.mac || "";
      return {
        name,
        mac,
        addresses: active.map((item) => item.address).slice(0, 16),
      };
    })
    .filter(Boolean)
    .slice(0, 64);
}

function getPrettyOsName() {
  if (process.platform === "linux") {
    try {
      const content = fs.readFileSync("/etc/os-release", "utf8");
      const match = content.match(/^PRETTY_NAME=(?:"([^"]+)"|(.+))$/m);
      if (match) return match[1] || match[2];
    } catch {
      // Fall through to the generic platform label.
    }
  }
  return `${os.type()} ${os.release()}`;
}

const interfaces = getInterfaces();
const address = interfaces.find((item) => item.family === "IPv4" && !item.internal)?.address || "127.0.0.1";
const identity = [os.hostname(), os.arch(), ...interfaces.filter((item) => !item.internal).map((item) => item.mac)].join("|");
const id = crypto.createHash("sha256").update(identity).digest("hex").slice(0, 12);
const cpuInfo = os.cpus()[0] || { model: "Unknown CPU" };
let regionInfo = await resolveRegion({ automatic: automaticRegion, fallback: configuredRegion });
const staticInfo = {
  id,
  name: process.env.PROBE_NAME || os.hostname(),
  ip: address,
  os: getPrettyOsName(),
  arch: os.arch(),
  cpuModel: cpuInfo.model || "Unknown CPU",
  cpuCores: os.cpus().length,
  version: "1.2.1",
  capabilities: ["self-update"],
  tags,
  reportInterval: interval,
};

let previousCpu;
let previousNetwork;
let monitorTasks = [];
const monitorLastRuns = new Map();

function cpuSnapshot() {
  return os.cpus().map((cpu) => ({
    idle: cpu.times.idle,
    total: Object.values(cpu.times).reduce((sum, value) => sum + value, 0),
  }));
}

async function getCpuUsage() {
  let current = cpuSnapshot();
  if (!previousCpu) {
    previousCpu = current;
    await delay(200);
    current = cpuSnapshot();
  }
  const cores = current.map((item, index) => {
    const previous = previousCpu[index] || item;
    const idleDelta = item.idle - previous.idle;
    const totalDelta = item.total - previous.total;
    return totalDelta > 0 ? (1 - idleDelta / totalDelta) * 100 : 0;
  });
  const currentTotal = current.reduce((result, item) => ({ idle: result.idle + item.idle, total: result.total + item.total }), { idle: 0, total: 0 });
  const previousTotal = previousCpu.reduce((result, item) => ({ idle: result.idle + item.idle, total: result.total + item.total }), { idle: 0, total: 0 });
  const idleDelta = currentTotal.idle - previousTotal.idle;
  const totalDelta = currentTotal.total - previousTotal.total;
  previousCpu = current;
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

function linuxNetworkCounters() {
  try {
    const rows = fs.readFileSync("/proc/net/dev", "utf8").trim().split(/\r?\n/).slice(2);
    return rows.reduce(
      (result, row) => {
        const [name, data] = row.trim().split(":");
        if (!data || name.trim() === "lo") return result;
        const fields = data.trim().split(/\s+/).map(Number);
        result.rx += fields[0] || 0;
        result.tx += fields[8] || 0;
        return result;
      },
      { rx: 0, tx: 0 },
    );
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

async function linuxProcessCount() {
  try {
    return fs.readdirSync("/proc", { withFileTypes: true }).filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name)).length;
  } catch {
    const output = await execText("ps", ["-e", "-o", "pid="]);
    return output.split(/\r?\n/).filter((line) => /^\s*\d+\s*$/.test(line)).length;
  }
}

function linuxTcpCount() {
  let count = 0;
  for (const file of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    try {
      count += Math.max(0, fs.readFileSync(file, "utf8").trim().split(/\r?\n/).length - 1);
    } catch {
      // IPv6 or procfs may be unavailable.
    }
  }
  return count;
}

function linuxUdpCount() {
  let count = 0;
  for (const file of ["/proc/net/udp", "/proc/net/udp6"]) {
    try {
      count += Math.max(0, fs.readFileSync(file, "utf8").trim().split(/\r?\n/).length - 1);
    } catch {
      // IPv6 or procfs may be unavailable.
    }
  }
  return count;
}

function linuxTemperature() {
  try {
    const base = "/sys/class/thermal";
    const values = fs.readdirSync(base)
      .filter((name) => name.startsWith("thermal_zone"))
      .map((name) => Number(fs.readFileSync(path.join(base, name, "temp"), "utf8").trim()) / 1000)
      .filter((value) => value > 0 && value < 150);
    return values.length ? Math.max(...values) : 0;
  } catch {
    return 0;
  }
}

function execText(file, args) {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { timeout: 3000, windowsHide: true, maxBuffer: 2 * 1024 * 1024 },
      (error, stdout) => {
        resolve(error ? "" : stdout);
      },
    );
  });
}

let windowsSwapCache = { used: 0, total: 0 };
let windowsSwapUpdatedAt = 0;
async function windowsSwapUsage() {
  if (Date.now() - windowsSwapUpdatedAt < 60_000) return windowsSwapCache;
  const output = await execText("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    "$samples=(Get-Counter '\\Memory\\Commit Limit','\\Paging File(_Total)\\% Usage' -ErrorAction SilentlyContinue).CounterSamples; if($samples.Count -ge 2){Write-Output \"$($samples[0].CookedValue),$($samples[1].CookedValue)\"}",
  ]);
  const [commitLimit, usagePercent] = output.trim().split(",").map(Number);
  const total = Math.max(0, (commitLimit || 0) - os.totalmem());
  if (total > 0) windowsSwapCache = { total, used: Math.min(total, total * Math.max(0, usagePercent || 0) / 100) };
  windowsSwapUpdatedAt = Date.now();
  return windowsSwapCache;
}

async function runWindowsStats() {
  const [interfaceOutput, tcpOutput, udpOutput, processOutput, taskOutput, swap] = await Promise.all([
    execText("netstat.exe", ["-e"]),
    execText("netstat.exe", ["-ano", "-p", "tcp"]),
    execText("netstat.exe", ["-ano", "-p", "udp"]),
    execText("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "(Get-Process -ErrorAction SilentlyContinue).Count"]),
    execText("tasklist.exe", ["/FO", "CSV", "/NH"]),
    windowsSwapUsage(),
  ]);
  const counterLine = interfaceOutput
    .split(/\r?\n/)
    .map((line) => line.match(/^\s*\D+?\s+(\d+)\s+(\d+)\s*$/))
    .find(Boolean);
  return {
    rx: Number(counterLine?.[1]) || 0,
    tx: Number(counterLine?.[2]) || 0,
    processCount: Number(processOutput.trim()) || taskOutput.split(/\r?\n/).filter((line) => line.trim() && !line.startsWith("INFO:")).length,
    tcpConnections: tcpOutput.split(/\r?\n/).filter((line) => /^\s*TCP\s+/i.test(line)).length,
    udpConnections: udpOutput.split(/\r?\n/).filter((line) => /^\s*UDP\s+/i.test(line)).length,
    swap,
  };
}

async function getPlatformStats() {
  if (process.platform === "win32") return runWindowsStats();
  if (process.platform === "linux") {
    return {
      ...linuxNetworkCounters(),
      processCount: await linuxProcessCount(),
      tcpConnections: linuxTcpCount(),
      udpConnections: linuxUdpCount(),
      swap: linuxSwapUsage(),
    };
  }
  return { rx: 0, tx: 0, processCount: 0, tcpConnections: 0, udpConnections: 0, swap: { used: 0, total: 0 } };
}

function getNetworkMetrics(counters) {
  const now = Date.now();
  const current = { ...counters, timestamp: now };
  if (!previousNetwork) {
    previousNetwork = current;
    return { downloadSpeed: 0, uploadSpeed: 0, downloadTotal: counters.rx, uploadTotal: counters.tx };
  }
  const elapsed = Math.max(0.001, (now - previousNetwork.timestamp) / 1000);
  const result = {
    downloadSpeed: Math.max(0, counters.rx - previousNetwork.rx) / elapsed,
    uploadSpeed: Math.max(0, counters.tx - previousNetwork.tx) / elapsed,
    downloadTotal: counters.rx,
    uploadTotal: counters.tx,
  };
  previousNetwork = current;
  return result;
}

function agentIcmpPing(target) {
  const args = process.platform === "win32" ? ["-n", "1", "-w", "3000", target] : ["-c", "1", "-W", "3", target];
  const startedAt = performance.now();
  return new Promise((resolve) => {
    execFile("ping", args, { timeout: 5000, windowsHide: true, maxBuffer: 512 * 1024 }, (error, stdout) => {
      const match = String(stdout).match(/(?:time|时间)?[=<]\s*(\d+(?:\.\d+)?)\s*ms/i);
      resolve({ success: !error, latency: !error ? Number(match?.[1]) || performance.now() - startedAt : null, error: error ? "ICMP request failed" : "" });
    });
  });
}

function agentTcpPing(target) {
  let parsed;
  try {
    parsed = new URL(`tcp://${target}`);
  } catch {
    return Promise.resolve({ success: false, latency: null, error: "Invalid TCP target" });
  }
  const startedAt = performance.now();
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: parsed.hostname, port: Number(parsed.port) });
    let settled = false;
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

async function runAgentMonitor(task) {
  if (task.type === "icmp") return agentIcmpPing(task.target);
  if (task.type === "tcp") return agentTcpPing(task.target);
  const startedAt = performance.now();
  try {
    const response = await fetch(task.target, { method: "GET", redirect: "follow", signal: AbortSignal.timeout(7000) });
    response.body?.cancel();
    return { success: response.ok, latency: performance.now() - startedAt, statusCode: response.status, error: response.ok ? "" : `HTTP ${response.status}` };
  } catch (error) {
    return { success: false, latency: null, error: error instanceof Error ? error.message : "HTTP request failed" };
  }
}

async function runDueMonitors() {
  const due = monitorTasks.filter((task) => Date.now() - (monitorLastRuns.get(String(task.id)) || 0) >= Math.max(5, Number(task.interval) || 30) * 1000);
  return Promise.all(due.map(async (task) => {
    monitorLastRuns.set(String(task.id), Date.now());
    return { serviceId: task.id, timestamp: Date.now(), ...(await runAgentMonitor(task)) };
  }));
}

let reporting = false;
let agentSocket;
let socketAuthenticated = false;
let socketConnectPromise;

function connectAgentSocket() {
  if (agentSocket?.readyState === WebSocket.OPEN && socketAuthenticated) return Promise.resolve(agentSocket);
  if (socketConnectPromise) return socketConnectPromise;
  socketConnectPromise = new Promise((resolve, reject) => {
    const socket = new WebSocket(wsUrl, { handshakeTimeout: 10000, maxPayload: 256 * 1024 });
    agentSocket = socket;
    socketAuthenticated = false;
    const timeout = setTimeout(() => {
      socket.terminate();
      reject(new Error("WebSocket authentication timed out"));
    }, 12_000);
    socket.once("open", () => socket.send(JSON.stringify({ type: "auth", token })));
    socket.on("message", (raw) => {
      let message;
      try {
        message = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (message.type === "authenticated") {
        clearTimeout(timeout);
        socketAuthenticated = true;
        resolve(socket);
        return;
      }
      if (message.type === "report-accepted") {
        monitorTasks = Array.isArray(message.monitors) ? message.monitors : [];
        if (message.updateStatusAcknowledged) acknowledgeUpdateStatus();
        scheduleAgentUpdate(message.update);
        logHealthyReport(wsUrl);
        return;
      }
      if (message.type === "report-rejected" || message.type === "error") {
        logReportError(new Error(`WSS report rejected: ${message.error || "Unknown server error"}`));
      }
    });
    socket.once("close", (code, reason) => {
      clearTimeout(timeout);
      const wasAuthenticated = socketAuthenticated;
      socketAuthenticated = false;
      if (agentSocket === socket) agentSocket = undefined;
      if (!wasAuthenticated) reject(new Error(`WebSocket closed (${code}): ${String(reason)}`));
    });
    socket.once("error", (error) => {
      clearTimeout(timeout);
      if (!socketAuthenticated) reject(error);
    });
  }).finally(() => {
    socketConnectPromise = undefined;
  });
  return socketConnectPromise;
}

async function report() {
  if (reporting) return;
  reporting = true;
  try {
    refreshUpdateStatusFromDisk();
    const [cpu, platformStats, monitorResults] = await Promise.all([getCpuUsage(), getPlatformStats(), runDueMonitors()]);
    const memoryTotal = os.totalmem();
    const memoryUsed = memoryTotal - os.freemem();
    const disk = getDiskMetrics();
    const networkInterfaces = getNetworkAdapters();
    const swap = platformStats.swap || { used: 0, total: 0 };
    const payload = {
      ...staticInfo,
      ...regionInfo,
      cpu: round(cpu.total),
      cpuCoreUsage: cpu.cores.map((value) => round(value)),
      memory: {
        used: memoryUsed,
        total: memoryTotal,
        percent: round(memoryTotal ? (memoryUsed / memoryTotal) * 100 : 0),
      },
      swap: {
        used: swap.used,
        total: swap.total,
        percent: round(swap.total ? (swap.used / swap.total) * 100 : 0),
      },
      disk: {
        used: disk.used,
        total: disk.total,
        percent: round(disk.total ? (disk.used / disk.total) * 100 : 0),
      },
      disks: disk.disks,
      diskCount: disk.disks.length,
      networkInterfaces,
      networkInterfaceCount: networkInterfaces.length,
      network: getNetworkMetrics(platformStats),
      load: os.loadavg(),
      uptime: os.uptime(),
      temperature: process.platform === "linux" ? linuxTemperature() : 0,
      processCount: platformStats.processCount,
      tcpConnections: platformStats.tcpConnections,
      udpConnections: platformStats.udpConnections,
      monitorResults,
      ...(updateStatus ? { updateStatus } : {}),
    };

    if (transport === "ws") {
      const socket = await connectAgentSocket();
      socket.send(JSON.stringify({ type: "report", payload }));
    } else {
      const response = await fetch(`${serverUrl}/api/agents/report`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(token ? { "x-probe-token": token } : {}),
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10000),
      });

      if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
      const result = await response.json();
      monitorTasks = Array.isArray(result.monitors) ? result.monitors : [];
      if (result.updateStatusAcknowledged) acknowledgeUpdateStatus();
      scheduleAgentUpdate(result.update);
      logHealthyReport(serverUrl);
    }
  } catch (error) {
    logReportError(error);
  } finally {
    reporting = false;
  }
}

cleanupAgentLogs();
appendAgentLog("INFO", `Orange Probe Agent v${staticInfo.version} ${id} -> ${transport === "ws" ? wsUrl : serverUrl} (${transport.toUpperCase()}); logs retained for ${logRetentionDays} days`);
await report();
setInterval(report, interval);
setInterval(cleanupAgentLogs, 24 * 60 * 60 * 1000).unref();
if (automaticRegion) {
  setInterval(async () => {
    const detected = await resolveRegion({ automatic: true, fallback: configuredRegion });
    if (detected.countryCode || !regionInfo.countryCode) regionInfo = detected;
  }, 6 * 60 * 60 * 1000).unref();
}
