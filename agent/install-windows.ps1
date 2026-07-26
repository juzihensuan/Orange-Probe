param(
  [Parameter(Mandatory = $true)][string]$ServerUrl,
  [Parameter(Mandatory = $true)][ValidateSet("http", "ws")][string]$Transport,
  [string]$WsUrl = "",
  [Parameter(Mandatory = $true)][string]$Token,
  [Parameter(Mandatory = $true)][string]$Name,
  [Parameter(Mandatory = $true)][string]$AgentId
)

$ErrorActionPreference = "Stop"
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw "Run PowerShell as Administrator, then execute the Agent installation command again."
}

function Update-ProcessPath {
  $env:PATH = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [Environment]::GetEnvironmentVariable("Path", "User")
}

function Get-NodeMajor {
  $node = Get-Command node.exe -ErrorAction SilentlyContinue
  if (-not $node) { return 0 }
  try { return [int](& $node.Source -p "Number(process.versions.node.split('.')[0])") } catch { return 0 }
}

Update-ProcessPath
if ((Get-NodeMajor) -lt 20 -or -not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) {
  Write-Host "Installing Node.js 22 LTS and npm..."
  $releases = Invoke-RestMethod -UseBasicParsing -Uri "https://nodejs.org/dist/index.json"
  $release = $releases | Where-Object { $_.version -like "v22.*" -and $_.lts } | Select-Object -First 1
  if (-not $release) { throw "Unable to resolve the latest Node.js 22 LTS release." }
  $architecture = if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") { "arm64" } else { "x64" }
  $msiName = "node-$($release.version)-$architecture.msi"
  $msiPath = Join-Path $env:TEMP $msiName
  Invoke-WebRequest -UseBasicParsing -Uri "https://nodejs.org/dist/$($release.version)/$msiName" -OutFile $msiPath
  $installer = Start-Process -FilePath "msiexec.exe" -ArgumentList "/i", "`"$msiPath`"", "/qn", "/norestart" -Wait -PassThru
  Remove-Item -LiteralPath $msiPath -Force -ErrorAction SilentlyContinue
  if ($installer.ExitCode -ne 0) { throw "Node.js installer exited with code $($installer.ExitCode)." }
  Update-ProcessPath
}
if ((Get-NodeMajor) -lt 20 -or -not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) {
  throw "Node.js 20 or later and npm are required. Automatic installation did not complete."
}

$suffix = $AgentId -replace '[^A-Za-z0-9_-]', ''
if (-not $suffix) { throw "Invalid Agent ID." }

$installDir = Join-Path $env:ProgramData "OrangeProbeAgent\$suffix"
$dataDir = Join-Path $installDir "data"
$taskName = "OrangeProbeAgent-$suffix"
$launcher = Join-Path $installDir "run-agent.ps1"
New-Item -ItemType Directory -Force -Path $installDir, $dataDir | Out-Null

$baseUrl = "$($ServerUrl.TrimEnd('/'))/downloads/agent"
foreach ($fileName in @("index.js", "region.js", "updater.js", "package.json", "package-lock.json")) {
  Invoke-WebRequest -UseBasicParsing -Uri "$baseUrl/$fileName" -OutFile (Join-Path $installDir $fileName)
}

Push-Location $installDir
try {
  $npmPath = (Get-Command npm.cmd).Source
  & $npmPath ci --omit=dev --ignore-scripts --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { throw "npm ci failed." }
} finally {
  Pop-Location
}

function ConvertTo-Literal([string]$Value) {
  return "'" + $Value.Replace("'", "''") + "'"
}

$nodePath = (Get-Command node.exe).Source
$npmPath = (Get-Command npm.cmd).Source
$launcherLines = @(
  '$ErrorActionPreference = "Stop"',
  "`$env:PROBE_SERVER_URL = $(ConvertTo-Literal $ServerUrl)",
  "`$env:PROBE_TRANSPORT = $(ConvertTo-Literal $Transport)",
  "`$env:PROBE_TOKEN = $(ConvertTo-Literal $Token)",
  "`$env:PROBE_NAME = $(ConvertTo-Literal $Name)",
  '`$env:PROBE_AUTO_REGION = "true"',
  '`$env:REPORT_INTERVAL = "3000"',
  "`$env:AGENT_DATA_DIR = $(ConvertTo-Literal $dataDir)",
  '`$env:AGENT_LOG_RETENTION_DAYS = "7"',
  "`$env:AGENT_NPM_PATH = $(ConvertTo-Literal $npmPath)",
  '`$env:AGENT_SERVICE_MODE = "scheduled-task"',
  'Remove-Item Env:PROBE_REGION -ErrorAction SilentlyContinue'
)
if ($Transport -eq "ws") {
  $launcherLines += "`$env:PROBE_WS_URL = $(ConvertTo-Literal $WsUrl)"
}
$launcherLines += @(
  "Set-Location $(ConvertTo-Literal $installDir)",
  "& $(ConvertTo-Literal $nodePath) $(ConvertTo-Literal (Join-Path $installDir 'index.js'))",
  'exit $LASTEXITCODE'
)
Set-Content -LiteralPath $launcher -Value $launcherLines -Encoding UTF8

& icacls.exe $installDir /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' /T /C | Out-Null
if ($LASTEXITCODE -ne 0) { throw "Failed to restrict Agent directory permissions." }

$powerShellPath = (Get-Command powershell.exe).Source
$arguments = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$launcher`""
$action = New-ScheduledTaskAction -Execute $powerShellPath -Argument $arguments
$trigger = New-ScheduledTaskTrigger -AtStartup
$taskPrincipal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero)
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $taskPrincipal -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName $taskName

Write-Host "Orange Probe Agent installed as background task: $taskName"
Write-Host "Agent logs: $dataDir\logs (automatic 7-day retention)"
