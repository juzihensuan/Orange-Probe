import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { resolveRegion } from "../agent/region.js";
import { installStagedUpdate } from "../agent/updater.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "orange-probe-smoke-"));
const adminUsername = "smoke-admin";
const adminPassword = "SmokeAdminPassword123!";
const telegramMessages = [];
const updaterRequests = [];
const childLogs = [];
let mockReleaseVersion = "1.1.9";
let probeProcess;
let agentProcess;
let updaterProcess;

function listen(server, port = 0) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server.address().port));
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

async function freePort() {
  const server = net.createServer();
  const port = await listen(server);
  await closeServer(server);
  return port;
}

async function stopChild(child) {
  if (!child || child.exitCode !== null) return;
  child.kill();
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 3000)),
  ]);
}

async function testAgentUpdaterTransaction() {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "orange-probe-updater-fixture-"));
  const installDir = path.join(fixtureRoot, "install");
  const dataDir = path.join(fixtureRoot, "data");
  const stagingDir = path.join(dataDir, "update-staging");
  const attemptId = crypto.randomUUID();
  let legacyParent;
  const packageJson = (version) => `${JSON.stringify({ name: "orange-probe-updater-fixture", version, private: true }, null, 2)}\n`;
  const packageLock = (version) => `${JSON.stringify({ name: "orange-probe-updater-fixture", version, lockfileVersion: 3, requires: true, packages: { "": { name: "orange-probe-updater-fixture", version } } }, null, 2)}\n`;
  try {
    fs.mkdirSync(installDir, { recursive: true });
    fs.mkdirSync(stagingDir, { recursive: true });
    const oldFiles = { "index.js": "// old Agent\n", "region.js": "// old region\n", "updater.js": "// old updater\n", "package.json": packageJson("1.1.2"), "package-lock.json": packageLock("1.1.2") };
    const newFiles = { "index.js": "// new Agent\n", "region.js": "// new region\n", "updater.js": "// new updater\n", "package.json": packageJson("1.1.8"), "package-lock.json": packageLock("1.1.8") };
    for (const [name, content] of Object.entries(oldFiles)) fs.writeFileSync(path.join(installDir, name), content);
    for (const [name, content] of Object.entries(newFiles)) fs.writeFileSync(path.join(stagingDir, name), content);
    legacyParent = spawn(process.execPath, ["-e", "setTimeout(() => {}, 5000)"], { stdio: "ignore" });
    const updater = spawn(process.execPath, ["agent/updater.js", "--staging", stagingDir, "--install", installDir, "--data", dataDir, "--parent", String(legacyParent.pid), "--version", "1.1.8", "--attempt", attemptId], {
      cwd: rootDir,
      env: { ...process.env, AGENT_SERVICE_MODE: "scheduled-task" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const output = [];
    updater.stdout.on("data", (chunk) => output.push(String(chunk)));
    updater.stderr.on("data", (chunk) => output.push(String(chunk)));
    const exitCode = await new Promise((resolve, reject) => {
      updater.once("error", reject);
      updater.once("exit", resolve);
    });
    assert.equal(exitCode, 0, output.join(""));
    assert.equal(legacyParent.exitCode, null, "Legacy updater waited for the old Agent to exit");
    assert.equal(JSON.parse(fs.readFileSync(path.join(installDir, "package.json"), "utf8")).version, "1.1.8");
    const result = JSON.parse(fs.readFileSync(path.join(dataDir, "update-result.json"), "utf8"));
    assert.deepEqual({ state: result.state, targetVersion: result.targetVersion, attemptId: result.attemptId }, { state: "success", targetVersion: "1.1.8", attemptId });
    assert.equal(fs.existsSync(stagingDir), false);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, "update-backup", "package.json"), "utf8")).version, "1.1.2");

    const directStagingDir = path.join(dataDir, "update-direct");
    fs.mkdirSync(directStagingDir, { recursive: true });
    const directFiles = { "index.js": "// direct Agent\n", "region.js": "// direct region\n", "updater.js": "// direct updater\n", "package.json": packageJson("1.1.9"), "package-lock.json": packageLock("1.1.9") };
    for (const [name, content] of Object.entries(directFiles)) fs.writeFileSync(path.join(directStagingDir, name), content);
    const installed = installStagedUpdate({ stagingDir: directStagingDir, installDir, dataDir, attemptId: crypto.randomUUID() });
    assert.equal(installed.version, "1.1.9");
    assert.equal(installed.dependenciesChanged, false);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, "update-backup", "package.json"), "utf8")).version, "1.1.8");
  } finally {
    await stopChild(legacyParent);
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

async function testAgentSelfUpdateEndToEnd() {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "orange-probe-agent-e2e-"));
  const installDir = path.join(fixtureRoot, "install");
  const agentDataDir = path.join(fixtureRoot, "data");
  const releaseDir = path.join(fixtureRoot, "release");
  const attemptId = crypto.randomUUID();
  const reports = [];
  let dispatched = false;
  let firstAgent;
  let restartedAgent;
  let updateServer;
  try {
    fs.mkdirSync(installDir, { recursive: true });
    fs.mkdirSync(agentDataDir, { recursive: true });
    fs.mkdirSync(releaseDir, { recursive: true });
    for (const file of ["index.js", "region.js", "updater.js", "package.json", "package-lock.json"]) fs.copyFileSync(path.join(rootDir, "agent", file), path.join(installDir, file));
    fs.mkdirSync(path.join(installDir, "node_modules"), { recursive: true });
    fs.cpSync(path.join(rootDir, "node_modules", "ws"), path.join(installDir, "node_modules", "ws"), { recursive: true });

    const releaseFiles = {};
    for (const file of ["index.js", "region.js", "updater.js", "package.json", "package-lock.json"]) {
      let content = fs.readFileSync(path.join(rootDir, "agent", file));
      if (file === "index.js") content = Buffer.from(content.toString("utf8").replace('version: "1.1.8"', 'version: "1.1.9"'));
      if (file === "package.json" || file === "package-lock.json") content = Buffer.from(content.toString("utf8").replaceAll('"version": "1.1.8"', '"version": "1.1.9"'));
      fs.writeFileSync(path.join(releaseDir, file), content);
      releaseFiles[file] = { content, sha256: crypto.createHash("sha256").update(content).digest("hex") };
    }

    updateServer = http.createServer((request, response) => {
      if (request.method === "GET" && request.url === "/manifest.json") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ version: "1.1.9", files: Object.entries(releaseFiles).map(([name, file]) => ({ name, url: `/files/${name}`, sha256: file.sha256 })) }));
        return;
      }
      if (request.method === "GET" && request.url?.startsWith("/files/")) {
        const name = decodeURIComponent(request.url.slice("/files/".length));
        const file = releaseFiles[name];
        if (!file) {
          response.writeHead(404).end();
          return;
        }
        response.writeHead(200, { "content-type": "application/octet-stream" });
        response.end(file.content);
        return;
      }
      if (request.method === "POST" && request.url === "/api/agents/report") {
        const chunks = [];
        request.on("data", (chunk) => chunks.push(chunk));
        request.on("end", () => {
          const report = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          reports.push(report);
          const responseBody = { ok: true, monitorTasks: [] };
          if (!dispatched && report.version === "1.1.8") {
            dispatched = true;
            responseBody.update = { version: "1.1.9", manifestUrl: "/manifest.json", attemptId };
          }
          if (report.version === "1.1.9" && report.updateStatus?.state === "success") responseBody.updateStatusAcknowledged = true;
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify(responseBody));
        });
        return;
      }
      response.writeHead(404).end();
    });
    const port = await listen(updateServer);
    const environment = {
      ...process.env,
      PROBE_SERVER_URL: `http://127.0.0.1:${port}`,
      PROBE_TOKEN: "orange-probe-e2e-token",
      PROBE_NAME: "Agent Update E2E",
      PROBE_AUTO_REGION: "false",
      PROBE_REGION: "US",
      REPORT_INTERVAL: "1000",
      AGENT_DATA_DIR: agentDataDir,
      AGENT_SERVICE_MODE: "scheduled-task",
    };
    const startAgent = () => {
      const child = spawn(process.execPath, [path.join(installDir, "index.js")], { cwd: installDir, env: environment, stdio: ["ignore", "pipe", "pipe"] });
      child.stdout.on("data", (chunk) => childLogs.push(String(chunk)));
      child.stderr.on("data", (chunk) => childLogs.push(String(chunk)));
      return child;
    };

    firstAgent = startAgent();
    const firstExitCode = await Promise.race([
      new Promise((resolve, reject) => { firstAgent.once("error", reject); firstAgent.once("exit", resolve); }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("Agent did not restart after installing the update")), 15_000)),
    ]);
    assert.equal(firstExitCode, 75);
    assert.equal(JSON.parse(fs.readFileSync(path.join(installDir, "package.json"), "utf8")).version, "1.1.9");
    assert.equal(JSON.parse(fs.readFileSync(path.join(agentDataDir, "update-result.json"), "utf8")).state, "success");

    restartedAgent = startAgent();
    await waitFor(() => reports.some((report) => report.version === "1.1.9" && report.updateStatus?.state === "success"), "Restarted Agent did not confirm v1.1.9", 15_000);
    await waitFor(() => !fs.existsSync(path.join(agentDataDir, "update-result.json")), "Agent update result was not acknowledged", 5000);
  } finally {
    await stopChild(firstAgent);
    await stopChild(restartedAgent);
    if (updateServer) await closeServer(updateServer);
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

async function waitFor(check, message, timeout = 15_000, interval = 150) {
  const startedAt = Date.now();
  let lastError;
  while (Date.now() - startedAt < timeout) {
    try {
      const result = await check();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  throw new Error(`${message}${lastError ? `: ${lastError.message}` : ""}`);
}

const mockServer = http.createServer((request, response) => {
  if (request.url === "/monitor") {
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("ok");
    return;
  }
  if (request.method === "GET" && request.url === "/repos/juzihensuan/Orange-Probe/releases/latest") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ tag_name: `v${mockReleaseVersion}`, html_url: `https://github.com/juzihensuan/Orange-Probe/releases/tag/v${mockReleaseVersion}`, published_at: "2026-07-26T00:00:00Z" }));
    return;
  }
  const chunks = [];
  request.on("data", (chunk) => chunks.push(chunk));
  request.on("end", () => {
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    if (request.url === "/update") {
      updaterRequests.push({ authorization: request.headers.authorization, body });
      response.writeHead(202, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, message: "mock update accepted" }));
      return;
    }
    telegramMessages.push(body);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, result: { message_id: telegramMessages.length } }));
  });
});

const mockPort = await listen(mockServer);
const probePort = await freePort();
const updaterPort = await freePort();
const baseUrl = `http://127.0.0.1:${probePort}`;
const origin = baseUrl;
const mockUrl = `http://127.0.0.1:${mockPort}`;
let sessionCookie = "";

function startProbe() {
  const child = spawn(process.execPath, ["server/index.js"], {
    cwd: rootDir,
    env: {
      ...process.env,
      NODE_ENV: "production",
      PORT: String(probePort),
      DATA_DIR: dataDir,
      ADMIN_USERNAME: adminUsername,
      ADMIN_PASSWORD: adminPassword,
      PROBE_TOKEN: "smoke-legacy-token",
      PROBE_NAME: "Smoke Local Node",
      PROBE_AUTO_REGION: "false",
      PROBE_REGION: "US",
      TELEGRAM_API_BASE_URL: mockUrl,
      GITHUB_API_BASE_URL: mockUrl,
      GITHUB_REPOSITORY: "juzihensuan/Orange-Probe",
      UPDATER_URL: mockUrl,
      UPDATE_TOKEN: "smoke-update-token-12345678901234567890",
      AGENT_UPDATE_TIMEOUT_MS: "1000",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => childLogs.push(String(chunk)));
  child.stderr.on("data", (chunk) => childLogs.push(String(chunk)));
  return child;
}

async function request(pathname, { method = "GET", body, authenticated = true, expectedStatus, headers: extraHeaders = {} } = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: {
      origin,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(authenticated && sessionCookie ? { cookie: sessionCookie } : {}),
      ...extraHeaders,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let payload = {};
  try { payload = text ? JSON.parse(text) : {}; } catch { payload = { text }; }
  if (expectedStatus !== undefined) {
    assert.equal(response.status, expectedStatus, `${method} ${pathname}: ${text}`);
  } else {
    assert.ok(response.ok, `${method} ${pathname} failed (${response.status}): ${text}`);
  }
  return { response, payload };
}

async function login(username = adminUsername, password = adminPassword) {
  const { response, payload } = await request("/api/admin/login", {
    method: "POST",
    authenticated: false,
    body: { username, password },
  });
  sessionCookie = String(response.headers.get("set-cookie") || "").split(";")[0];
  assert.ok(sessionCookie.startsWith("orange_probe_session="));
  assert.equal(payload.authenticated, true);
}

function agentPayload(name) {
  return {
    id: crypto.randomUUID(),
    name,
    location: "Test Region",
    countryCode: "US",
    ip: "192.0.2.10",
    os: "SmokeOS 1.0",
    arch: "x64",
    cpuModel: "Smoke CPU",
    cpuCores: 2,
    version: "1.0.0-smoke",
    tags: ["smoke"],
    reportInterval: 1200,
    cpu: 12.5,
    cpuCoreUsage: [10, 15],
    memory: { used: 512 * 1024 ** 2, total: 1024 ** 3, percent: 50 },
    swap: { used: 0, total: 0, percent: 0 },
    disk: { used: 10 * 1024 ** 3, total: 20 * 1024 ** 3, percent: 50 },
    disks: [{ name: "smoke-disk", mount: "/", used: 10 * 1024 ** 3, total: 20 * 1024 ** 3, percent: 50 }],
    networkInterfaces: [{ name: "eth0", mac: "02:00:00:00:00:01", addresses: ["192.0.2.10"] }],
    network: { downloadSpeed: 2048, uploadSpeed: 1024, downloadTotal: 4096, uploadTotal: 2048 },
    load: [0.1, 0.1, 0.1],
    uptime: 120,
    processCount: 10,
    tcpConnections: 3,
    udpConnections: 2,
  };
}

function publicSnapshot() {
  return request("/api/servers", { authenticated: false }).then(({ payload }) => payload);
}

function websocketSnapshot() {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${probePort}/ws`, { origin });
    const timer = setTimeout(() => { socket.terminate(); reject(new Error("Public WebSocket timeout")); }, 5000);
    socket.once("message", (raw) => {
      clearTimeout(timer);
      const payload = JSON.parse(String(raw));
      socket.close();
      resolve(payload);
    });
    socket.once("error", reject);
  });
}

function websocketAgentReport(token, payload) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${probePort}/agent-ws`);
    const timer = setTimeout(() => { socket.terminate(); reject(new Error("Agent WebSocket timeout")); }, 7000);
    socket.once("open", () => socket.send(JSON.stringify({ type: "auth", token })));
    socket.on("message", (raw) => {
      const message = JSON.parse(String(raw));
      if (message.type === "authenticated") socket.send(JSON.stringify({ type: "report", payload }));
      if (message.type === "report-accepted") {
        clearTimeout(timer);
        socket.close();
        resolve(message);
      }
      if (message.type === "report-rejected" || message.type === "error") {
        clearTimeout(timer);
        socket.close();
        reject(new Error(message.error || "Agent report rejected"));
      }
    });
    socket.once("error", reject);
  });
}

function blockedWebSocket(ip) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${probePort}/ws`, { origin, headers: { "x-forwarded-for": ip } });
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.terminate();
      if (error) reject(error);
      else resolve(true);
    };
    const timer = setTimeout(() => finish(new Error("Blocked WebSocket was not rejected")), 5000);
    socket.once("open", () => finish(new Error("Blocked WebSocket unexpectedly opened")));
    socket.once("unexpected-response", (_request, response) => {
      response.resume();
      finish(response.statusCode === 403 ? null : new Error(`Blocked WebSocket returned ${response.statusCode}`));
    });
    socket.once("error", (error) => {
      if (String(error.message).includes("403")) finish(null);
      else finish(error);
    });
  });
}

fs.mkdirSync(path.join(dataDir, "history", "nodes"), { recursive: true });
const expiredHistoryFile = path.join(dataDir, "history", "nodes", "2020-01-01.jsonl");
fs.writeFileSync(expiredHistoryFile, `${JSON.stringify({ serverId: "old", timestamp: 1, cpu: 1 })}\n`);

try {
  await testAgentUpdaterTransaction();
  await testAgentSelfUpdateEndToEnd();
  updaterProcess = spawn(process.execPath, ["updater/index.js"], {
    cwd: rootDir,
    env: { ...process.env, UPDATER_PORT: String(updaterPort), UPDATE_TOKEN: "standalone-updater-token-123456789012345" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  updaterProcess.stdout.on("data", (chunk) => childLogs.push(String(chunk)));
  updaterProcess.stderr.on("data", (chunk) => childLogs.push(String(chunk)));
  await waitFor(async () => (await fetch(`http://127.0.0.1:${updaterPort}/health`)).ok, "Updater service did not start");
  const unauthorizedUpdater = await fetch(`http://127.0.0.1:${updaterPort}/update`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(unauthorizedUpdater.status, 401);

  probeProcess = startProbe();
  await waitFor(async () => (await fetch(`${baseUrl}/api/health`)).ok, "Probe did not start");
  assert.equal(fs.existsSync(expiredHistoryFile), false, "Expired history was not removed");
  assert.deepEqual(await resolveRegion({ automatic: false, fallback: "US" }), { countryCode: "US", location: "美国" });

  await request("/api/admin/session", { authenticated: false, expectedStatus: 401 });
  await login();

  const manualBlockedIp = "203.0.113.77";
  const automaticBlockedIp = "203.0.113.88";
  const { payload: initialFirewall } = await request("/api/admin/firewall");
  assert.equal(initialFirewall.currentIp, "127.0.0.1");
  assert.deepEqual(initialFirewall.blocked, []);
  await request("/api/admin/firewall", { method: "POST", body: { ip: "127.0.0.1", reason: "self" }, expectedStatus: 400 });
  const { payload: manualBlock } = await request("/api/admin/firewall", { method: "POST", body: { ip: manualBlockedIp, reason: "Smoke manual block" } });
  assert.equal(manualBlock.source, "manual");
  const { payload: blockedHtml } = await request("/", { authenticated: false, expectedStatus: 403, headers: { accept: "text/html", "x-forwarded-for": manualBlockedIp } });
  assert.match(blockedHtml.text, /你的 IP 已被封禁，禁止访问/);
  assert.match(blockedHtml.text, new RegExp(manualBlockedIp.replaceAll(".", "\\.")));
  const { payload: blockedApi } = await request("/api/health", { authenticated: false, expectedStatus: 403, headers: { "x-forwarded-for": manualBlockedIp } });
  assert.equal(blockedApi.ip, manualBlockedIp);
  await blockedWebSocket(manualBlockedIp);
  await request(`/api/admin/firewall/${encodeURIComponent(manualBlockedIp)}`, { method: "DELETE" });
  await request("/api/health", { authenticated: false, headers: { "x-forwarded-for": manualBlockedIp } });

  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const { payload } = await request("/api/admin/login", {
      method: "POST",
      authenticated: false,
      expectedStatus: 401,
      headers: { "x-forwarded-for": automaticBlockedIp },
      body: { username: adminUsername, password: "wrong-password" },
    });
    assert.equal(payload.remainingAttempts, 5 - attempt);
  }
  const { payload: automaticBlock } = await request("/api/admin/login", {
    method: "POST",
    authenticated: false,
    expectedStatus: 403,
    headers: { "x-forwarded-for": automaticBlockedIp },
    body: { username: "wrong-user", password: "wrong-password" },
  });
  assert.equal(automaticBlock.blocked, true);
  assert.equal(automaticBlock.ip, automaticBlockedIp);
  await blockedWebSocket(automaticBlockedIp);
  const { payload: firewallAfterAutomaticBlock } = await request("/api/admin/firewall");
  const automaticEntry = firewallAfterAutomaticBlock.blocked.find((entry) => entry.ip === automaticBlockedIp);
  assert.equal(automaticEntry.source, "automatic");
  assert.equal(automaticEntry.failedAttempts, 5);

  const initialSnapshot = await waitFor(async () => {
    const snapshot = await publicSnapshot();
    return snapshot.servers?.length ? snapshot : null;
  }, "Local node was not collected");
  const localNode = initialSnapshot.servers.find((server) => server.source === "local");
  assert.ok(localNode);

  const publicWs = await websocketSnapshot();
  assert.equal(publicWs.type, "snapshot");
  assert.ok(Array.isArray(publicWs.servers));

  const { response: agentScriptResponse, payload: agentScript } = await request("/downloads/agent/index.js", { authenticated: false });
  assert.match(String(agentScriptResponse.headers.get("content-type")), /javascript/);
  assert.match(agentScript.text, /PROBE_SERVER_URL/);
  const { payload: agentRegion } = await request("/downloads/agent/region.js", { authenticated: false });
  assert.match(agentRegion.text, /api\.country\.is/);
  const { payload: agentUpdater } = await request("/downloads/agent/updater.js", { authenticated: false });
  assert.match(agentUpdater.text, /SHA256|update-result\.json|npm ci/i);
  const { payload: agentPackage } = await request("/downloads/agent/package.json", { authenticated: false });
  assert.equal(agentPackage.scripts.start, "node index.js");
  assert.deepEqual(Object.keys(agentPackage.dependencies), ["ws"]);
  const { payload: agentLock } = await request("/downloads/agent/package-lock.json", { authenticated: false });
  assert.equal(agentLock.packages["node_modules/ws"].version, "8.21.1");
  const { payload: agentManifest } = await request("/downloads/agent/manifest.json", { authenticated: false });
  assert.equal(agentManifest.version, "1.1.8");
  assert.deepEqual(agentManifest.files.map((file) => file.name).sort(), ["index.js", "package-lock.json", "package.json", "region.js", "updater.js"]);
  assert.ok(agentManifest.files.every((file) => file.url.endsWith("?v=1.1.8")));
  for (const file of agentManifest.files) {
    const content = fs.readFileSync(path.join(rootDir, "agent", file.name));
    assert.equal(file.sha256, crypto.createHash("sha256").update(content).digest("hex"));
  }
  const { payload: linuxInstaller } = await request("/downloads/agent/install-linux.sh", { authenticated: false });
  assert.match(linuxInstaller.text, /systemctl restart/);
  assert.match(linuxInstaller.text, /AGENT_LOG_RETENTION_DAYS="7"/);
  assert.match(linuxInstaller.text, /nodesource\.com\/setup_22\.x/);
  assert.match(linuxInstaller.text, /updater\.js/);
  assert.match(linuxInstaller.text, /RestartSec=2/);
  const { payload: windowsInstaller } = await request("/downloads/agent/install-windows.ps1", { authenticated: false });
  assert.match(windowsInstaller.text, /Register-ScheduledTask/);
  assert.match(windowsInstaller.text, /AGENT_LOG_RETENTION_DAYS = "7"/);
  assert.match(windowsInstaller.text, /nodejs\.org\/dist\/index\.json/);
  assert.match(windowsInstaller.text, /updater\.js/);
  assert.match(windowsInstaller.text, /agentExitCode/);
  const oneCommandInstaller = fs.readFileSync(path.join(rootDir, "deploy", "install.sh"), "utf8");
  assert.match(oneCommandInstaller, /get\.docker\.com/);
  assert.match(oneCommandInstaller, /UPDATE_TOKEN/);
  assert.match(oneCommandInstaller, /releases\/latest/);
  assert.match(oneCommandInstaller, /Orange-Probe-Docker-v\$version\.zip/);
  assert.match(oneCommandInstaller, /SHA256 verification failed/);
  assert.match(oneCommandInstaller, /com\.docker\.compose\.project/);
  assert.match(oneCommandInstaller, /data_mount="\.\/data"/);
  assert.match(oneCommandInstaller, /current_update_token/);
  assert.match(oneCommandInstaller, /rm -f "\$deploy_path\/README\.md"/);
  assert.match(oneCommandInstaller, /docker compose --project-name "\$compose_project" build --pull/);
  assert.match(oneCommandInstaller, /failed its startup health check/);
  const serverUpdaterSource = fs.readFileSync(path.join(rootDir, "updater", "index.js"), "utf8");
  assert.match(serverUpdaterSource, /releases\/download\/v\$\{version\}/);
  assert.match(serverUpdaterSource, /createHash\("sha256"\)/);
  assert.match(serverUpdaterSource, /pullReleaseImages\(images, version\)/);
  assert.match(serverUpdaterSource, /\["pull", releaseImage\]/);
  assert.match(serverUpdaterSource, /\["image", "tag", releaseImage, configuredImage\]/);
  assert.match(serverUpdaterSource, /Registry pull failed; building verified release source locally/);
  assert.match(serverUpdaterSource, /buildReleaseImages\(sourceDir, images\)/);
  assert.match(serverUpdaterSource, /configuredImages\(\)/);
  assert.doesNotMatch(serverUpdaterSource, /releaseComposeFile/);
  assert.match(serverUpdaterSource, /--volumes-from/);
  assert.match(serverUpdaterSource, /orange-probe-updater/);
  const dockerfileSource = fs.readFileSync(path.join(rootDir, "Dockerfile"), "utf8");
  assert.match(dockerfileSource, /^FROM node:22-alpine AS builder/m);
  assert.doesNotMatch(dockerfileSource, /BUILDPLATFORM/);
  assert.match(dockerfileSource, /COPY --from=builder \/app\/node_modules \.\/node_modules/);
  assert.equal((dockerfileSource.match(/RUN npm ci/g) || []).length, 1);
  const { response: flagResponse, payload: flagAsset } = await request("/flags/us.svg", { authenticated: false });
  assert.match(String(flagResponse.headers.get("content-type")), /image\/svg\+xml/);
  assert.match(flagAsset.text, /<svg/);

  const { payload: settings } = await request("/api/admin/settings");
  Object.assign(settings, {
    homepageRefreshSeconds: 15,
    telegramEnabled: true,
    telegramBotToken: "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ",
    telegramChatId: "123456789",
    telegramLoadAlerts: false,
    telegramOfflineAlerts: false,
    telegramOnlineAlerts: true,
    telegramRenewalAlerts: false,
    telegramTrafficAlerts: false,
  });
  const { payload: savedSettings } = await request("/api/admin/settings", { method: "PUT", body: settings });
  assert.equal(savedSettings.homepageRefreshSeconds, 15);
  assert.equal(savedSettings.telegramOnlineAlerts, true);

  const { payload: initialUpdates } = await request("/api/admin/updates");
  assert.equal(initialUpdates.server.currentVersion, "1.1.8");
  assert.equal(initialUpdates.server.latestVersion, "1.1.9");
  assert.equal(initialUpdates.agentPackageVersion, "1.1.8");
  assert.equal(initialUpdates.server.updateAvailable, true);
  assert.equal(initialUpdates.server.updaterConfigured, true);
  const { response: serverUpdateResponse, payload: serverUpdate } = await request("/api/admin/updates/server", { method: "POST", body: {} });
  assert.equal(serverUpdateResponse.status, 202);
  assert.equal(serverUpdate.targetVersion, "1.1.9");
  assert.equal(updaterRequests.length, 1);
  assert.equal(updaterRequests[0].authorization, "Bearer smoke-update-token-12345678901234567890");

  const agentToken = crypto.randomUUID();
  const { payload: agent } = await request("/api/admin/agents", { method: "POST", body: { name: "Smoke Windows Agent", token: agentToken } });
  assert.equal(agent.token, agentToken);
  const { payload: install } = await request(`/api/admin/agents/${agent.id}/install`, { method: "POST" });
  assert.equal(install.token, agentToken);
  assert.equal(install.transport, "http");
  const { payload: offlineStatus } = await request(`/api/admin/agents/${agent.id}/status`);
  assert.equal(offlineStatus.online, false);

  await request(`/api/admin/servers/${agent.id}`, { method: "PUT", body: { name: "Smoke Windows Agent" } });
  await new Promise((resolve) => setTimeout(resolve, 400));
  const agentDataDir = path.join(dataDir, "agent-runtime");
  const agentLogDir = path.join(agentDataDir, "logs");
  const oldAgentLog = path.join(agentLogDir, "2020-01-01.log");
  fs.mkdirSync(agentLogDir, { recursive: true });
  fs.writeFileSync(oldAgentLog, "old Agent log\n");
  fs.utimesSync(oldAgentLog, new Date("2020-01-01T00:00:00Z"), new Date("2020-01-01T00:00:00Z"));
  agentProcess = spawn(process.execPath, ["agent/index.js"], {
    cwd: rootDir,
    env: {
      ...process.env,
      PROBE_SERVER_URL: baseUrl,
      PROBE_TRANSPORT: "http",
      PROBE_TOKEN: agentToken,
      PROBE_NAME: "Smoke Windows Agent",
      PROBE_AUTO_REGION: "false",
      PROBE_REGION: "US",
      REPORT_INTERVAL: "1200",
      AGENT_DATA_DIR: agentDataDir,
      AGENT_LOG_RETENTION_DAYS: "7",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  agentProcess.stdout.on("data", (chunk) => childLogs.push(String(chunk)));
  agentProcess.stderr.on("data", (chunk) => childLogs.push(String(chunk)));

  await waitFor(async () => (await request(`/api/admin/agents/${agent.id}/status`)).payload.online, "Real Agent did not become online", 20_000);
  assert.equal(fs.existsSync(oldAgentLog), false, "Agent did not remove an expired log file");
  const currentAgentLog = path.join(agentLogDir, `${new Date().toISOString().slice(0, 10)}.log`);
  assert.ok(fs.existsSync(currentAgentLog), "Agent did not create its daily log file");
  await request(`/api/admin/servers/${agent.id}`, { method: "PUT", body: { name: "Smoke Windows Agent" } });
  await waitFor(() => telegramMessages.find((message) => String(message.text).includes("Smoke Windows Agent") && String(message.text).includes("节点上线")), "Online Telegram notification was not sent");
  const onlineNotice = telegramMessages.find((message) => String(message.text).includes("Smoke Windows Agent"));
  assert.equal(onlineNotice.parse_mode, "HTML");
  assert.equal(/ID[:：]|IP[:：]/.test(onlineNotice.text), false);

  const { payload: adminServers } = await request("/api/admin/servers");
  const liveAgent = adminServers.servers.find((server) => server.id === agent.id);
  assert.ok(liveAgent.processCount > 0, "Windows process count was not collected");
  assert.ok(liveAgent.diskCount > 0, "Disk inventory was not collected");
  assert.ok(liveAgent.networkInterfaceCount > 0, "Network adapter inventory was not collected");
  assert.equal(liveAgent.countryCode, "US", "Agent country code was not collected");
  const { payload: updatesWithAgent } = await request("/api/admin/updates");
  const liveAgentUpdate = updatesWithAgent.agents.find((item) => item.id === agent.id);
  assert.equal(liveAgentUpdate.supportsAutoUpdate, true);
  assert.equal(liveAgentUpdate.version, "1.1.8");

  const updateAgentToken = crypto.randomUUID();
  const { payload: updateAgent } = await request("/api/admin/agents", { method: "POST", body: { name: "Smoke Update Agent", token: updateAgentToken } });
  const oldUpdatePayload = { ...agentPayload("Smoke Update Agent"), version: "1.1.2", capabilities: ["self-update"] };
  await request("/api/agents/report", { method: "POST", authenticated: false, headers: { "x-probe-token": updateAgentToken }, body: oldUpdatePayload });
  const { payload: updateBlockedByServer } = await request("/api/admin/updates");
  const blockedAgentUpdate = updateBlockedByServer.agents.find((item) => item.id === updateAgent.id);
  assert.equal(blockedAgentUpdate.targetVersion, "1.1.9");
  assert.equal(blockedAgentUpdate.status, "server-required");
  assert.equal(blockedAgentUpdate.serverUpdateRequired, true);
  assert.equal(blockedAgentUpdate.updateAvailable, false);
  mockReleaseVersion = "1.1.8";
  const { payload: refreshedAgentUpdates } = await request("/api/admin/updates?refresh=1");
  const refreshableAgent = refreshedAgentUpdates.agents.find((item) => item.id === updateAgent.id);
  assert.equal(refreshableAgent.targetVersion, "1.1.8");
  assert.equal(refreshableAgent.status, "available");
  assert.equal(refreshableAgent.updateAvailable, true);
  const { payload: queuedUpdate } = await request("/api/admin/updates/agents", { method: "POST", body: { agentIds: [updateAgent.id] } });
  assert.deepEqual(queuedUpdate.queued, [updateAgent.id]);
  const { payload: updateInstruction } = await request("/api/agents/report", { method: "POST", authenticated: false, headers: { "x-probe-token": updateAgentToken }, body: oldUpdatePayload });
  assert.equal(updateInstruction.update.version, "1.1.8");
  assert.equal(updateInstruction.update.manifestUrl, "/downloads/agent/manifest.json");
  assert.match(updateInstruction.update.attemptId, /^[0-9a-f-]{36}$/i);
  const { payload: duplicateInstruction } = await request("/api/agents/report", { method: "POST", authenticated: false, headers: { "x-probe-token": updateAgentToken }, body: oldUpdatePayload });
  assert.equal("update" in duplicateInstruction, false, "An installing update was dispatched more than once");
  const { payload: duplicateQueue } = await request("/api/admin/updates/agents", { method: "POST", body: { agentIds: [updateAgent.id] } });
  assert.deepEqual(duplicateQueue.queued, []);
  assert.match(duplicateQueue.skipped[0].reason, /正在执行/);
  const { payload: completedInstruction } = await request("/api/agents/report", { method: "POST", authenticated: false, headers: { "x-probe-token": updateAgentToken }, body: { ...oldUpdatePayload, version: "1.1.8", updateStatus: { state: "success", targetVersion: "1.1.8", attemptId: updateInstruction.update.attemptId } } });
  assert.equal(completedInstruction.updateStatusAcknowledged, true);
  const { payload: completedUpdates } = await request("/api/admin/updates");
  assert.equal(completedUpdates.agents.find((item) => item.id === updateAgent.id).status, "completed");
  const updateManagementSource = fs.readFileSync(path.join(rootDir, "src", "components", "UpdateManagement.tsx"), "utf8");
  assert.doesNotMatch(updateManagementSource, /force:\s*!agent\.updateAvailable/);
  assert.match(updateManagementSource, /active \|\| working/);
  assert.match(updateManagementSource, /\?refresh=1/);
  assert.match(updateManagementSource, /检查中/);
  const agentSource = fs.readFileSync(path.join(rootDir, "agent", "index.js"), "utf8");
  assert.match(agentSource, /refreshUpdateStatusFromDisk/);
  assert.match(agentSource, /updateStatusAcknowledged/);
  assert.match(agentSource, /installStagedUpdate/);
  assert.doesNotMatch(agentSource, /detached:\s*true/);

  const timeoutAgentToken = crypto.randomUUID();
  const { payload: timeoutAgent } = await request("/api/admin/agents", { method: "POST", body: { name: "Smoke Timeout Agent", token: timeoutAgentToken } });
  const timeoutPayload = { ...agentPayload("Smoke Timeout Agent"), version: "1.1.2", capabilities: ["self-update"] };
  await request("/api/agents/report", { method: "POST", authenticated: false, headers: { "x-probe-token": timeoutAgentToken }, body: timeoutPayload });
  await request("/api/admin/updates/agents", { method: "POST", body: { agentIds: [timeoutAgent.id] } });
  const { payload: timeoutInstruction } = await request("/api/agents/report", { method: "POST", authenticated: false, headers: { "x-probe-token": timeoutAgentToken }, body: timeoutPayload });
  assert.equal(timeoutInstruction.update.version, "1.1.8");
  await new Promise((resolve) => setTimeout(resolve, 1200));
  const { payload: timedOutUpdates } = await request("/api/admin/updates");
  const timedOutEntry = timedOutUpdates.agents.find((item) => item.id === timeoutAgent.id);
  assert.equal(timedOutEntry.status, "failed");
  assert.match(timedOutEntry.error, /更新超时/);

  const { payload: service } = await request("/api/admin/services", {
    method: "POST",
    body: { name: "Smoke HTTP Monitor", type: "http", target: `${mockUrl}/monitor`, interval: 5, serverIds: [agent.id], enabled: true },
  });
  const { payload: publicServices } = await request(`/api/services?serverId=${agent.id}`, { authenticated: false });
  assert.equal("target" in publicServices.services[0], false);
  await waitFor(async () => {
    const { payload } = await request(`/api/services/${service.id}/history?serverId=${agent.id}&period=realtime`);
    return payload.points.some((point) => point.source === "agent");
  }, "Agent monitor result was not returned", 12_000, 500);
  const { payload: secondaryService } = await request("/api/admin/services", {
    method: "POST",
    body: { name: "Smoke TCP Monitor", type: "tcp", target: "127.0.0.1:443", interval: 5, serverIds: [agent.id], enabled: false },
  });
  const { payload: intervalUpdate } = await request("/api/admin/services/interval", { method: "PUT", body: { interval: 5 } });
  assert.equal(intervalUpdate.updated, 2);
  assert.ok(intervalUpdate.services.every((item) => item.interval === 5));
  const serviceManagementSource = fs.readFileSync(path.join(rootDir, "src", "components", "ServiceManagement.tsx"), "utf8");
  assert.match(serviceManagementSource, /应用到全部/);
  assert.match(serviceManagementSource, /min="5"/);
  assert.doesNotMatch(serviceManagementSource, /立即测试|最近结果/);

  const wsToken = crypto.randomUUID();
  const { payload: wsAgent } = await request("/api/admin/agents", { method: "POST", body: { name: "Smoke WSS Agent", token: wsToken } });
  const wsAccepted = await websocketAgentReport(wsToken, agentPayload("Smoke WSS Agent"));
  assert.equal(wsAccepted.id, wsAgent.id);
  const { payload: wsStatus } = await request(`/api/admin/agents/${wsAgent.id}/status`);
  assert.equal(wsStatus.online, true);
  await websocketAgentReport(wsToken, {
    ...agentPayload("Smoke WSS Agent"),
    monitorResults: [{ serviceId: service.id, timestamp: Date.now() + 24 * 60 * 60 * 1000, success: true, latency: 1 }],
  });
  const { payload: unauthorizedServiceHistory } = await request(`/api/services/${service.id}/history?serverId=${wsAgent.id}&period=realtime`);
  assert.equal(unauthorizedServiceHistory.points.length, 0, "An Agent injected results into a service that was not assigned to it");

  await request(`/api/admin/servers/${agent.id}`, {
    method: "PUT",
    body: {
      name: "Smoke Windows Agent",
      billingCycle: "annual",
      purchaseDate: "2026-01-21",
      expirationDate: "2029-01-21",
      trafficLimitBytes: 1024 ** 4,
      trafficNotify: true,
      trafficNotifyPercent: 80,
    },
  });
  const { payload: configuredServers } = await request("/api/admin/servers");
  const configuredAgent = configuredServers.servers.find((server) => server.id === agent.id);
  assert.ok(configuredAgent.serviceCycleEnd > configuredAgent.serviceCycleStart);
  assert.ok(configuredAgent.serviceCyclePercent >= 0 && configuredAgent.serviceCyclePercent <= 100);
  assert.equal(configuredAgent.trafficLimitBytes, 1024 ** 4);

  const { payload: history } = await request(`/api/servers/${agent.id}/history?period=realtime`);
  assert.ok(history.points.length > 0);
  const { payload: sla } = await request("/api/admin/sla?days=7");
  assert.equal(sla.days, 7);

  const reverseSettings = { ...savedSettings, reverseProxyEnabled: true, publicDomain: "https://probe.example.com" };
  await request("/api/admin/settings", { method: "PUT", body: reverseSettings });
  const reverseToken = crypto.randomUUID();
  const { payload: reverseAgent } = await request("/api/admin/agents", { method: "POST", body: { name: "Reverse Proxy Agent", token: reverseToken } });
  assert.equal(reverseAgent.transport, "ws");
  assert.equal(reverseAgent.serverUrl, "https://probe.example.com");
  assert.equal(reverseAgent.wsUrl, "wss://probe.example.com/agent-ws");
  const installCommandSource = fs.readFileSync(path.join(rootDir, "src", "components", "Modals.tsx"), "utf8");
  assert.match(installCommandSource, /install-linux\.sh/);
  assert.match(installCommandSource, /install-windows\.ps1/);
  assert.doesNotMatch(installCommandSource, /PROBE_REGION='Hong-Kong'/);
  await request(`/api/admin/servers/${reverseAgent.id}`, { method: "DELETE" });
  await request("/api/admin/settings", { method: "PUT", body: { ...reverseSettings, reverseProxyEnabled: false, publicDomain: "" } });

  const previewCountBefore = telegramMessages.length;
  const { payload: preview } = await request("/api/admin/telegram/test", { method: "POST", body: { botToken: settings.telegramBotToken, chatId: settings.telegramChatId } });
  assert.equal(preview.count, 5);
  assert.equal(telegramMessages.length - previewCountBefore, 5);

  await stopChild(agentProcess);
  agentProcess = undefined;
  await request(`/api/admin/servers/${agent.id}`, { method: "DELETE" });
  const { payload: servicesAfterDelete } = await request("/api/admin/services");
  assert.equal(servicesAfterDelete.services[0].serverIds.includes(agent.id), false, "Deleted node remained assigned to a service");
  await request(`/api/admin/servers/${wsAgent.id}`, { method: "DELETE" });
  await request(`/api/admin/servers/${updateAgent.id}`, { method: "DELETE" });
  await request(`/api/admin/servers/${timeoutAgent.id}`, { method: "DELETE" });
  await request(`/api/admin/services/${service.id}`, { method: "DELETE" });
  await request(`/api/admin/services/${secondaryService.id}`, { method: "DELETE" });
  const agentLogLines = fs.readFileSync(currentAgentLog, "utf8").trim().split(/\r?\n/).filter(Boolean);
  assert.ok(agentLogLines.length < 20, `Agent log grew unexpectedly fast (${agentLogLines.length} lines)`);

  const { payload: localInstall } = await request(`/api/admin/agents/${localNode.id}/install`, { method: "POST" });
  assert.equal(localInstall.token.length, 36);
  await request(`/api/admin/servers/${localNode.id}`, { method: "DELETE" });
  await new Promise((resolve) => setTimeout(resolve, 3500));
  assert.equal((await publicSnapshot()).servers.some((server) => server.id === localNode.id), false);

  await request("/api/admin/account", { method: "PUT", body: { username: "smoke-admin-2", currentPassword: adminPassword, newPassword: "SmokeAdminPassword456!" } });
  await request("/api/admin/logout", { method: "POST" });
  sessionCookie = "";
  await login("smoke-admin-2", "SmokeAdminPassword456!");

  await stopChild(probeProcess);
  probeProcess = startProbe();
  await waitFor(async () => (await fetch(`${baseUrl}/api/health`)).ok, "Probe did not restart");
  sessionCookie = "";
  await login("smoke-admin-2", "SmokeAdminPassword456!");
  const { payload: afterRestart } = await request("/api/admin/servers");
  assert.equal(afterRestart.servers.some((server) => server.id === localNode.id), false, "Deleted local node returned after restart");
  const { payload: persistedFirewall } = await request("/api/admin/firewall");
  assert.equal(persistedFirewall.blocked.some((entry) => entry.ip === automaticBlockedIp), true, "Automatic firewall rule did not persist after restart");
  await request(`/api/admin/firewall/${encodeURIComponent(automaticBlockedIp)}`, { method: "DELETE" });

  console.log(JSON.stringify({
    ok: true,
    checks: {
      publicApi: true,
      adminAuth: true,
      firewallManualAndAutomaticBlocking: true,
      firewallHttpAndWebSocketEnforcement: true,
      firewallPersistence: true,
      publicWebSocket: true,
      downloadableAgentPackage: true,
      serverAndAgentUpdates: true,
      agentUpdaterTransaction: true,
      agentSelfUpdateEndToEnd: true,
      fiveSecondServiceIntervals: true,
      dependencyAwareInstallers: true,
      updaterServiceAuth: true,
      automaticCountryDetectionAndFlagSource: true,
      windowsAgentHttp: true,
      agentWebSocket: true,
      serviceMonitoring: true,
      agentServiceAssignmentIsolation: true,
      telegramTransitionsAndPreviews: true,
      billingAndTraffic: true,
      historyAndSla: true,
      reverseProxyCommands: true,
      deletionCleanupAndPersistence: true,
      accountUpdate: true,
    },
  }, null, 2));
} catch (error) {
  console.error(childLogs.join(""));
  throw error;
} finally {
  await stopChild(agentProcess);
  await stopChild(probeProcess);
  await stopChild(updaterProcess);
  await closeServer(mockServer);
  fs.rmSync(dataDir, { recursive: true, force: true });
}
