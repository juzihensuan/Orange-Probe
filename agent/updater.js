import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const AGENT_UPDATE_FILES = ["index.js", "region.js", "updater.js", "package.json", "package-lock.json"];

function safeAttemptId(value) {
  return String(value || Date.now()).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64) || String(Date.now());
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function dependencyFingerprint(directory) {
  const lock = readJson(path.join(directory, "package-lock.json"));
  const rootPackage = lock.packages?.[""] && typeof lock.packages[""] === "object" ? { ...lock.packages[""] } : {};
  delete rootPackage.name;
  delete rootPackage.version;
  const packages = { ...(lock.packages || {}) };
  packages[""] = rootPackage;
  return JSON.stringify({ lockfileVersion: lock.lockfileVersion, packages, dependencies: lock.dependencies || {} });
}

function runNodeCheck(file) {
  const result = spawnSync(process.execPath, ["--check", file], { windowsHide: true, stdio: "pipe", timeout: 30_000 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${path.basename(file)} syntax check failed: ${String(result.stderr || result.stdout).trim().slice(0, 500)}`);
}

function installDependencies(directory) {
  const npmPath = process.env.AGENT_NPM_PATH || (process.platform === "win32" ? "npm.cmd" : "npm");
  const result = spawnSync(npmPath, ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], {
    cwd: directory,
    windowsHide: true,
    shell: process.platform === "win32",
    stdio: "pipe",
    timeout: 5 * 60_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`npm ci exited with code ${result.status}: ${String(result.stderr || result.stdout).trim().slice(0, 500)}`);
}

function validatePaths(stagingDir, installDir, dataDir) {
  if (!stagingDir.startsWith(`${dataDir}${path.sep}`)) throw new Error("Update staging directory is outside Agent data directory");
  if (!installDir || installDir === path.parse(installDir).root) throw new Error("Agent install directory is unsafe");
  for (const file of AGENT_UPDATE_FILES) if (!fs.statSync(path.join(stagingDir, file), { throwIfNoEntry: false })?.isFile()) throw new Error(`Update file is missing: ${file}`);
}

function replaceFile(source, destination) {
  const temporary = `${destination}.orange-update-${process.pid}`;
  fs.copyFileSync(source, temporary);
  fs.rmSync(destination, { force: true });
  fs.renameSync(temporary, destination);
}

export function installStagedUpdate({ stagingDir: stagingValue, installDir: installValue, dataDir: dataValue, attemptId, allowDependencyChanges = true, verifyScripts = true }) {
  const stagingDir = path.resolve(stagingValue || "");
  const installDir = path.resolve(installValue || "");
  const dataDir = path.resolve(dataValue || "");
  const updateId = safeAttemptId(attemptId);
  const backupDir = path.join(dataDir, "update-backup");
  const dependencyStageDir = path.join(installDir, `.orange-update-dependencies-${updateId}`);
  const dependencyBackupDir = path.join(installDir, ".orange-update-node_modules-backup");
  let dependenciesChanged = false;
  let dependencyBackupCreated = false;
  let dependencySwapCompleted = false;

  validatePaths(stagingDir, installDir, dataDir);
  if (verifyScripts) for (const file of ["index.js", "region.js", "updater.js"]) runNodeCheck(path.join(stagingDir, file));
  const stagedPackage = readJson(path.join(stagingDir, "package.json"));
  if (!/^\d+\.\d+\.\d+$/.test(String(stagedPackage.version || ""))) throw new Error("Agent package version is invalid");

  dependenciesChanged = dependencyFingerprint(stagingDir) !== dependencyFingerprint(installDir);
  if (dependenciesChanged && !allowDependencyChanges) throw new Error("This legacy Agent cannot apply an update that changes dependencies; run the installation command once to upgrade");

  fs.rmSync(backupDir, { recursive: true, force: true });
  fs.mkdirSync(backupDir, { recursive: true });
  for (const file of AGENT_UPDATE_FILES) {
    const current = path.join(installDir, file);
    if (fs.existsSync(current)) fs.copyFileSync(current, path.join(backupDir, file));
  }

  try {
    if (dependenciesChanged) {
      fs.rmSync(dependencyStageDir, { recursive: true, force: true });
      fs.mkdirSync(dependencyStageDir, { recursive: true });
      fs.copyFileSync(path.join(stagingDir, "package.json"), path.join(dependencyStageDir, "package.json"));
      fs.copyFileSync(path.join(stagingDir, "package-lock.json"), path.join(dependencyStageDir, "package-lock.json"));
      installDependencies(dependencyStageDir);
    }

    for (const file of AGENT_UPDATE_FILES) replaceFile(path.join(stagingDir, file), path.join(installDir, file));

    if (dependenciesChanged) {
      fs.rmSync(dependencyBackupDir, { recursive: true, force: true });
      const installedModules = path.join(installDir, "node_modules");
      if (fs.existsSync(installedModules)) {
        fs.renameSync(installedModules, dependencyBackupDir);
        dependencyBackupCreated = true;
      }
      fs.renameSync(path.join(dependencyStageDir, "node_modules"), installedModules);
      dependencySwapCompleted = true;
    }

    const installedPackage = readJson(path.join(installDir, "package.json"));
    if (String(installedPackage.version) !== String(stagedPackage.version)) throw new Error("Installed Agent version does not match the staged package");
    return { version: String(installedPackage.version), dependenciesChanged, backupDir };
  } catch (error) {
    for (const file of AGENT_UPDATE_FILES) {
      const backup = path.join(backupDir, file);
      const destination = path.join(installDir, file);
      if (fs.existsSync(backup)) replaceFile(backup, destination);
      else fs.rmSync(destination, { force: true });
    }
    if (dependenciesChanged) {
      fs.rmSync(path.join(installDir, "node_modules"), { recursive: true, force: true });
      if (dependencyBackupCreated && fs.existsSync(dependencyBackupDir)) fs.renameSync(dependencyBackupDir, path.join(installDir, "node_modules"));
    }
    throw error;
  } finally {
    fs.rmSync(dependencyStageDir, { recursive: true, force: true });
    if (!dependencySwapCompleted || !dependencyBackupCreated) fs.rmSync(dependencyBackupDir, { recursive: true, force: true });
    fs.rmSync(stagingDir, { recursive: true, force: true });
  }
}

function writeResult(dataDir, state, targetVersion, attemptId, error = "") {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, "update-result.json"), `${JSON.stringify({ state, targetVersion, attemptId, error, timestamp: Date.now() }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

async function runLegacyUpdater() {
  const argumentsMap = new Map();
  for (let index = 2; index < process.argv.length; index += 2) argumentsMap.set(process.argv[index], process.argv[index + 1]);
  const stagingDir = path.resolve(argumentsMap.get("--staging") || "");
  const installDir = path.resolve(argumentsMap.get("--install") || "");
  const dataDir = path.resolve(argumentsMap.get("--data") || "");
  const targetVersion = String(argumentsMap.get("--version") || "unknown");
  const attemptId = String(argumentsMap.get("--attempt") || "");
  try {
    // v1.1.2/v1.1.3 exit 500 ms after spawning this file. Apply while the parent
    // is still alive so service managers cannot terminate the update halfway.
    installStagedUpdate({ stagingDir, installDir, dataDir, attemptId, allowDependencyChanges: false, verifyScripts: false });
    writeResult(dataDir, "success", targetVersion, attemptId);
  } catch (error) {
    writeResult(dataDir, "failed", targetVersion, attemptId, error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

const invokedFile = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedFile === fileURLToPath(import.meta.url)) await runLegacyUpdater();
