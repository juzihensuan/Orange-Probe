import crypto from "node:crypto";
import http from "node:http";
import { spawn } from "node:child_process";

const port = Number(process.env.UPDATER_PORT || 4180);
const updateToken = String(process.env.UPDATE_TOKEN || "");
const composeFile = String(process.env.COMPOSE_FILE || "/deployment/docker-compose.yml");
const projectName = String(process.env.COMPOSE_PROJECT_NAME || "orange-probe");
const githubRepository = String(process.env.GITHUB_REPOSITORY || "juzihensuan/Orange-Probe").trim();
const githubToken = String(process.env.GITHUB_TOKEN || "");
let updating = false;
let lastUpdate = { status: "idle", startedAt: 0, completedAt: 0, error: "" };

if (updateToken.length < 32) throw new Error("UPDATE_TOKEN must contain at least 32 characters");

function tokenMatches(header) {
  const supplied = String(header || "").replace(/^Bearer\s+/i, "");
  const left = Buffer.from(supplied);
  const right = Buffer.from(updateToken);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function runCommand(command, argumentsList, input = "") {
  return new Promise((resolve, reject) => {
    const child = spawn(command, argumentsList, { stdio: ["pipe", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    let outputSize = 0;
    const collect = (target) => (chunk) => {
      outputSize += chunk.length;
      if (outputSize <= 4 * 1024 * 1024) target.push(chunk);
    };
    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", collect(stderr));
    const timeout = setTimeout(() => child.kill(), 30 * 60_000);
    child.once("error", (error) => { clearTimeout(timeout); reject(error); });
    child.once("close", (code) => {
      clearTimeout(timeout);
      const output = Buffer.concat(code === 0 ? stdout : stderr.length ? stderr : stdout).toString("utf8").trim();
      if (code !== 0) reject(new Error(output.slice(0, 2000) || `${command} exited with code ${code}`));
      else resolve(output);
    });
    child.stdin.end(input);
  });
}

function githubHeaders(accept = "application/vnd.github+json") {
  return {
    accept,
    "user-agent": "orange-probe-updater",
    ...(githubToken ? { authorization: `Bearer ${githubToken}` } : {}),
  };
}

async function resolveVersion(targetVersion) {
  if (targetVersion !== "latest") return targetVersion.replace(/^v/i, "");
  const response = await fetch(`https://api.github.com/repos/${githubRepository}/releases/latest`, {
    headers: githubHeaders(),
  });
  if (!response.ok) throw new Error(`GitHub Release query failed (${response.status})`);
  const release = await response.json();
  const version = String(release.tag_name || "").replace(/^v/i, "");
  if (!/^[0-9A-Za-z._-]{1,32}$/.test(version)) throw new Error("GitHub Release returned an invalid version");
  return version;
}

async function configuredImages() {
  const argumentsList = ["compose", "--env-file", "/deployment/.env", "-f", composeFile, "--project-name", projectName, "config", "--format", "json"];
  const output = await runCommand("docker", argumentsList);
  const config = JSON.parse(output);
  const appImage = String(config?.services?.["orange-probe"]?.image || "");
  const updaterImage = String(config?.services?.["orange-probe-updater"]?.image || "");
  if (!appImage || !updaterImage) throw new Error("Release Compose file does not define update images");
  return { appImage, updaterImage };
}

function versionedImage(image, version) {
  const withoutDigest = String(image).split("@")[0];
  const slash = withoutDigest.lastIndexOf("/");
  const colon = withoutDigest.lastIndexOf(":");
  const repository = colon > slash ? withoutDigest.slice(0, colon) : withoutDigest;
  return `${repository}:${version}`;
}

async function pullReleaseImages(images, version) {
  for (const configuredImage of [images.appImage, images.updaterImage]) {
    const releaseImage = versionedImage(configuredImage, version);
    try {
      await runCommand("docker", ["pull", releaseImage]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/unauthorized|denied|authentication required/i.test(message)) {
        throw new Error(`Cannot pull ${releaseImage}: registry authorization failed. Make the GHCR package public or configure GITHUB_TOKEN with read:packages.`);
      }
      throw error;
    }
    if (releaseImage !== configuredImage) await runCommand("docker", ["image", "tag", releaseImage, configuredImage]);
  }
}

async function authenticateRegistry(images) {
  if (!githubToken) return;
  const registries = new Set([images.appImage, images.updaterImage].map((image) => String(image).split("/")[0]).filter(Boolean));
  const username = githubRepository.split("/")[0] || "orange-probe";
  for (const registry of registries) await runCommand("docker", ["login", registry, "--username", username, "--password-stdin"], githubToken);
}

async function scheduleUpdaterRecreate(updaterImage) {
  const currentContainer = String(process.env.HOSTNAME || "").trim();
  if (!/^[a-f0-9]{12,64}$/i.test(currentContainer)) throw new Error("Cannot identify the updater container for self-replacement");
  const helperName = `${projectName.replace(/[^A-Za-z0-9_.-]/g, "-")}-updater-reloader-${Date.now()}`.slice(0, 120);
  const composeArguments = ["compose", "--env-file", "/deployment/.env", "-f", composeFile, "--project-name", projectName, "up", "-d", "--no-deps", "--no-build", "orange-probe-updater"];
  const helperScript = `setTimeout(() => import("node:child_process").then(({ spawn }) => { const child = spawn("docker", ${JSON.stringify(composeArguments)}, { stdio: "inherit" }); child.once("error", () => process.exit(1)); child.once("exit", (code) => process.exit(code ?? 1)); }), 2000)`;
  await runCommand("docker", ["run", "--rm", "-d", "--name", helperName, "--volumes-from", currentContainer, "--entrypoint", "node", updaterImage, "-e", helperScript]);
}

async function updateServer(targetVersion) {
  updating = true;
  lastUpdate = { status: "running", targetVersion, startedAt: Date.now(), completedAt: 0, error: "" };
  try {
    const version = await resolveVersion(targetVersion);
    const images = await configuredImages();
    await authenticateRegistry(images);
    await pullReleaseImages(images, version);
    const baseArguments = ["compose", "--env-file", "/deployment/.env", "-f", composeFile, "--project-name", projectName];
    await runCommand("docker", [...baseArguments, "up", "-d", "--no-deps", "--no-build", "orange-probe"]);
    await scheduleUpdaterRecreate(images.updaterImage);
    lastUpdate = { ...lastUpdate, targetVersion: version, imageSource: "registry", status: "completed", completedAt: Date.now(), error: "" };
    console.log(`[${new Date().toISOString()}] Orange Probe server updated to ${version}`);
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
    response.end(JSON.stringify({ ok: true, message: `正在下载并部署 v${targetVersion}` }));
    setImmediate(() => updateServer(targetVersion));
  });
});

server.listen(port, "0.0.0.0", () => console.log(`Orange Probe updater listening on ${port}`));
