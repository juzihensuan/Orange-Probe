import crypto from "node:crypto";
import http from "node:http";
import { execFile } from "node:child_process";

const port = Number(process.env.UPDATER_PORT || 4180);
const updateToken = String(process.env.UPDATE_TOKEN || "");
const composeFile = String(process.env.COMPOSE_FILE || "/deployment/docker-compose.yml");
const projectName = String(process.env.COMPOSE_PROJECT_NAME || "orange-probe");
let updating = false;
let lastUpdate = { status: "idle", startedAt: 0, completedAt: 0, error: "" };

if (updateToken.length < 32) throw new Error("UPDATE_TOKEN must contain at least 32 characters");

function tokenMatches(header) {
  const supplied = String(header || "").replace(/^Bearer\s+/i, "");
  const left = Buffer.from(supplied);
  const right = Buffer.from(updateToken);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function runDocker(argumentsList) {
  return new Promise((resolve, reject) => {
    execFile("docker", argumentsList, { timeout: 15 * 60_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) return reject(new Error(String(stderr || stdout || error.message).trim().slice(0, 2000)));
      return resolve(String(stdout || ""));
    });
  });
}

async function updateServer(targetVersion) {
  updating = true;
  lastUpdate = { status: "running", targetVersion, startedAt: Date.now(), completedAt: 0, error: "" };
  try {
    const baseArguments = ["compose", "--env-file", "/deployment/.env", "-f", composeFile, "--project-name", projectName];
    await runDocker([...baseArguments, "pull", "orange-probe"]);
    await runDocker([...baseArguments, "up", "-d", "--no-deps", "--no-build", "orange-probe"]);
    lastUpdate = { ...lastUpdate, status: "completed", completedAt: Date.now(), error: "" };
    console.log(`[${new Date().toISOString()}] Orange Probe server updated to ${targetVersion || "latest"}`);
  } catch (error) {
    lastUpdate = { ...lastUpdate, status: "failed", completedAt: Date.now(), error: error instanceof Error ? error.message : String(error) };
    console.error(`[${new Date().toISOString()}] Orange Probe update failed: ${lastUpdate.error}`);
  } finally {
    updating = false;
  }
}

const server = http.createServer((request, response) => {
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  if (request.method === "GET" && request.url === "/health") {
    response.end(JSON.stringify({ ok: true, updating, lastUpdate }));
    return;
  }
  if (request.method !== "POST" || request.url !== "/update") {
    response.writeHead(404);
    response.end(JSON.stringify({ error: "Not found" }));
    return;
  }
  if (!tokenMatches(request.headers.authorization)) {
    response.writeHead(401);
    response.end(JSON.stringify({ error: "Unauthorized" }));
    return;
  }
  if (updating) {
    response.writeHead(409);
    response.end(JSON.stringify({ error: "An update is already running" }));
    return;
  }
  const chunks = [];
  let size = 0;
  request.on("data", (chunk) => {
    size += chunk.length;
    if (size > 8192) request.destroy();
    else chunks.push(chunk);
  });
  request.on("end", () => {
    let body = {};
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    } catch {
      response.writeHead(400);
      response.end(JSON.stringify({ error: "Invalid JSON" }));
      return;
    }
    const targetVersion = String(body.targetVersion || "latest").replace(/[^0-9A-Za-z._-]/g, "").slice(0, 32) || "latest";
    response.writeHead(202);
    response.end(JSON.stringify({ ok: true, message: `正在拉取并部署 v${targetVersion}` }));
    setImmediate(() => updateServer(targetVersion));
  });
});

server.listen(port, "0.0.0.0", () => console.log(`Orange Probe updater listening on ${port}`));
