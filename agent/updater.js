import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

const argumentsMap = new Map();
for (let index = 2; index < process.argv.length; index += 2) argumentsMap.set(process.argv[index], process.argv[index + 1]);

const stagingDir = path.resolve(argumentsMap.get("--staging") || "");
const installDir = path.resolve(argumentsMap.get("--install") || "");
const dataDir = path.resolve(argumentsMap.get("--data") || "");
const parentPid = Number(argumentsMap.get("--parent") || 0);
const targetVersion = String(argumentsMap.get("--version") || "unknown");
const attemptId = String(argumentsMap.get("--attempt") || "");
const resultFile = path.join(dataDir, "update-result.json");
const backupDir = path.join(dataDir, "update-backup");
const allowedFiles = ["index.js", "region.js", "updater.js", "package.json", "package-lock.json"];

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function parentIsAlive() {
  if (!parentPid) return false;
  try {
    process.kill(parentPid, 0);
    return true;
  } catch {
    return false;
  }
}

function writeResult(state, error = "") {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(resultFile, `${JSON.stringify({ state, targetVersion, attemptId, error, timestamp: Date.now() }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

function installDependencies() {
  const npmPath = process.env.AGENT_NPM_PATH || (process.platform === "win32" ? "npm.cmd" : "npm");
  const result = spawnSync(npmPath, ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], {
    cwd: installDir,
    windowsHide: true,
    shell: process.platform === "win32",
    stdio: "ignore",
    timeout: 5 * 60_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`npm ci exited with code ${result.status}`);
}

function validatePaths() {
  if (!stagingDir.startsWith(`${dataDir}${path.sep}`)) throw new Error("Update staging directory is outside Agent data directory");
  if (!installDir || installDir === path.parse(installDir).root) throw new Error("Agent install directory is unsafe");
  for (const file of allowedFiles) if (!fs.existsSync(path.join(stagingDir, file))) throw new Error(`Update file is missing: ${file}`);
}

async function run() {
  validatePaths();
  const deadline = Date.now() + 20_000;
  while (parentIsAlive() && Date.now() < deadline) await sleep(250);

  fs.rmSync(backupDir, { recursive: true, force: true });
  fs.mkdirSync(backupDir, { recursive: true });
  const previousFiles = [];
  for (const file of allowedFiles) {
    const currentFile = path.join(installDir, file);
    if (!fs.existsSync(currentFile)) continue;
    fs.copyFileSync(currentFile, path.join(backupDir, file));
    previousFiles.push(file);
  }

  try {
    for (const file of allowedFiles) fs.copyFileSync(path.join(stagingDir, file), path.join(installDir, file));
    installDependencies();
    writeResult("success");
    fs.rmSync(stagingDir, { recursive: true, force: true });
    fs.rmSync(backupDir, { recursive: true, force: true });
    if (process.env.AGENT_SERVICE_MODE === "standalone") {
      const child = spawn(process.execPath, [path.join(installDir, "index.js")], { cwd: installDir, env: process.env, detached: true, stdio: "ignore", windowsHide: true });
      child.unref();
    }
  } catch (error) {
    for (const file of allowedFiles) {
      const destination = path.join(installDir, file);
      if (previousFiles.includes(file)) fs.copyFileSync(path.join(backupDir, file), destination);
      else fs.rmSync(destination, { force: true });
    }
    try {
      installDependencies();
    } catch {
      // Preserve the original files even if dependency restoration also fails.
    }
    writeResult("failed", error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

await run().catch((error) => {
  try {
    writeResult("failed", error instanceof Error ? error.message : String(error));
  } catch {
    // The service manager will restart the Agent and expose the original failure in its own logs.
  }
  process.exitCode = 1;
});
