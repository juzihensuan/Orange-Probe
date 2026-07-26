import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const port = Number(process.env.UPDATER_PORT || 4180);
const updateToken = String(process.env.UPDATE_TOKEN || "");
const composeFile = String(process.env.COMPOSE_FILE || "/deployment/docker-compose.yml");
const projectName = String(process.env.COMPOSE_PROJECT_NAME || "orange-probe");
const githubRepository = String(process.env.GITHUB_REPOSITORY || "juzihensuan/Orange-Probe").trim();
const githubToken = String(process.env.GITHUB_TOKEN || "");
const deploymentDir = path.dirname(composeFile);
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

async function downloadRelease(version, destination) {
  const assetName = `Orange-Probe-Docker-v${version}.zip`;
  const url = `https://github.com/${githubRepository}/releases/download/v${version}/${assetName}`;
  const response = await fetch(url, { headers: githubHeaders("application/octet-stream") });
  if (!response.ok) throw new Error(`Release package download failed (${response.status})`);
  const archive = Buffer.from(await response.arrayBuffer());
  if (archive.length < 100 || archive.length > 24 * 1024 * 1024) throw new Error("Release package size is invalid");
  const checksumName = `Orange-Probe-v${version}.sha256`;
  const checksumResponse = await fetch(
    `https://github.com/${githubRepository}/releases/download/v${version}/${checksumName}`,
    { headers: githubHeaders("application/octet-stream") },
  );
  if (!checksumResponse.ok) throw new Error(`Release checksum download failed (${checksumResponse.status})`);
  const checksumText = await checksumResponse.text();
  const checksumLine = checksumText.split(/\r?\n/).find((line) => line.trim().endsWith(` ${assetName}`));
  const expectedHash = String(checksumLine || "").trim().split(/\s+/)[0];
  const actualHash = crypto.createHash("sha256").update(archive).digest("hex");
  if (!/^[a-f0-9]{64}$/i.test(expectedHash) || expectedHash.toLowerCase() !== actualHash) {
    throw new Error("Release package SHA256 verification failed");
  }
  await fs.writeFile(destination, archive, { mode: 0o600 });
}

async function copyReleaseSource(sourceDir) {
  for (const filename of ["package.json", "docker-compose.yml", "Dockerfile"]) {
    const stat = await fs.stat(path.join(sourceDir, filename)).catch(() => null);
    if (!stat?.isFile()) throw new Error(`Release package is missing ${filename}`);
  }
  const entries = await fs.readdir(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === ".env") continue;
    await fs.cp(path.join(sourceDir, entry.name), path.join(deploymentDir, entry.name), {
      recursive: true,
      force: true,
      errorOnExist: false,
    });
  }
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
    await runCommand("docker", ["pull", releaseImage]);
    if (releaseImage !== configuredImage) await runCommand("docker", ["image", "tag", releaseImage, configuredImage]);
  }
}

async function buildReleaseImages(sourceDir, images) {
  await runCommand("docker", ["build", "--pull", "--tag", images.appImage, "--file", path.join(sourceDir, "Dockerfile"), sourceDir]);
  await runCommand("docker", ["build", "--pull", "--tag", images.updaterImage, "--file", path.join(sourceDir, "updater", "Dockerfile"), sourceDir]);
}

async function prepareReleaseImages(sourceDir, images, version) {
  try {
    await pullReleaseImages(images, version);
    return "registry";
  } catch (error) {
    console.warn(`[${new Date().toISOString()}] Registry pull failed; building verified release source locally: ${error instanceof Error ? error.message : error}`);
    await buildReleaseImages(sourceDir, images);
    return "source";
  }
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
  let temporaryDir = "";
  try {
    const version = await resolveVersion(targetVersion);
    temporaryDir = await fs.mkdtemp(path.join(os.tmpdir(), "orange-probe-update-"));
    const archivePath = path.join(temporaryDir, `Orange-Probe-Docker-v${version}.zip`);
    const sourceDir = path.join(temporaryDir, `orange-probe-docker-v${version}`);
    await downloadRelease(version, archivePath);
    await runCommand("unzip", ["-q", archivePath, "-d", temporaryDir]);
    const images = await configuredImages();
    const imageSource = await prepareReleaseImages(sourceDir, images, version);
    await copyReleaseSource(sourceDir);
    const baseArguments = ["compose", "--env-file", "/deployment/.env", "-f", composeFile, "--project-name", projectName];
    await runCommand("docker", [...baseArguments, "up", "-d", "--no-deps", "--no-build", "orange-probe"]);
    await scheduleUpdaterRecreate(images.updaterImage);
    lastUpdate = { ...lastUpdate, targetVersion: version, imageSource, status: "completed", completedAt: Date.now(), error: "" };
    console.log(`[${new Date().toISOString()}] Orange Probe server updated to ${version}`);
  } catch (error) {
    lastUpdate = { ...lastUpdate, status: "failed", completedAt: Date.now(), error: error instanceof Error ? error.message : String(error) };
    console.error(`[${new Date().toISOString()}] Orange Probe update failed: ${lastUpdate.error}`);
  } finally {
    if (temporaryDir) await fs.rm(temporaryDir, { recursive: true, force: true }).catch(() => {});
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
