#!/usr/bin/env bash
set -euo pipefail

: "${PROBE_SERVER_URL:?PROBE_SERVER_URL is required}"
: "${PROBE_TOKEN:?PROBE_TOKEN is required}"
: "${PROBE_NAME:?PROBE_NAME is required}"
: "${PROBE_AGENT_ID:?PROBE_AGENT_ID is required}"

if [ "$(id -u)" -ne 0 ]; then
  if command -v sudo >/dev/null 2>&1; then
    exec sudo env \
      PROBE_SERVER_URL="$PROBE_SERVER_URL" \
      PROBE_TRANSPORT="${PROBE_TRANSPORT:-http}" \
      PROBE_WS_URL="${PROBE_WS_URL:-}" \
      PROBE_TOKEN="$PROBE_TOKEN" \
      PROBE_NAME="$PROBE_NAME" \
      PROBE_AGENT_ID="$PROBE_AGENT_ID" \
      bash "$0"
  fi
  echo "Orange Probe Agent installation requires root privileges." >&2
  exit 1
fi

install_curl() {
  command -v curl >/dev/null 2>&1 && return
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update
    DEBIAN_FRONTEND=noninteractive apt-get install -y ca-certificates curl
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y ca-certificates curl
  elif command -v yum >/dev/null 2>&1; then
    yum install -y ca-certificates curl
  elif command -v apk >/dev/null 2>&1; then
    apk add --no-cache ca-certificates curl
  elif command -v pacman >/dev/null 2>&1; then
    pacman -Sy --noconfirm ca-certificates curl
  else
    echo "Cannot install curl automatically: unsupported package manager." >&2
    exit 1
  fi
}

install_node() {
  local current_major=0
  if command -v node >/dev/null 2>&1; then current_major="$(node -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null || printf 0)"; fi
  if command -v npm >/dev/null 2>&1 && [ "$current_major" -ge 20 ]; then return; fi
  echo "Installing Node.js 22 LTS and npm..."
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update
    DEBIAN_FRONTEND=noninteractive apt-get install -y ca-certificates curl gnupg
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
    DEBIAN_FRONTEND=noninteractive apt-get install -y nodejs
  elif command -v dnf >/dev/null 2>&1; then
    curl -fsSL https://rpm.nodesource.com/setup_22.x | bash -
    dnf install -y nodejs
  elif command -v yum >/dev/null 2>&1; then
    curl -fsSL https://rpm.nodesource.com/setup_22.x | bash -
    yum install -y nodejs
  elif command -v apk >/dev/null 2>&1; then
    apk add --no-cache nodejs npm
  elif command -v pacman >/dev/null 2>&1; then
    pacman -Sy --noconfirm nodejs npm
  else
    echo "Cannot install Node.js automatically: unsupported package manager." >&2
    exit 1
  fi
  current_major="$(node -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null || printf 0)"
  if ! command -v npm >/dev/null 2>&1 || [ "$current_major" -lt 20 ]; then
    echo "Node.js 20 or later and npm are required." >&2
    exit 1
  fi
}

install_curl
install_node

agent_suffix="$(printf '%s' "$PROBE_AGENT_ID" | tr -cd 'A-Za-z0-9_-')"
[ -n "$agent_suffix" ] || {
  echo "Invalid Agent ID." >&2
  exit 1
}

install_dir="/opt/orange-probe-agent/$agent_suffix"
data_dir="/var/lib/orange-probe-agent/$agent_suffix"
env_dir="/etc/orange-probe-agent"
env_file="$env_dir/$agent_suffix.env"
service_name="orange-probe-agent-$agent_suffix"
service_file="/etc/systemd/system/$service_name.service"
service_user="orange-probe"

if ! id "$service_user" >/dev/null 2>&1; then
  if command -v useradd >/dev/null 2>&1; then
    useradd --system --home-dir /var/lib/orange-probe-agent --shell /usr/sbin/nologin "$service_user"
  elif command -v adduser >/dev/null 2>&1; then
    adduser --system --home /var/lib/orange-probe-agent --no-create-home --disabled-login "$service_user"
  else
    service_user="root"
  fi
fi
service_group="$(id -gn "$service_user")"
node_path="$(command -v node)"
npm_path="$(command -v npm)"
service_mode="standalone"
if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then service_mode="systemd"; fi
if [ "$service_user" != "root" ]; then
  if command -v runuser >/dev/null 2>&1; then
    run_as_service_user=(runuser -u "$service_user" -- "$node_path" --version)
  else
    run_as_service_user=()
  fi
  if [ "${#run_as_service_user[@]}" -eq 0 ] || ! "${run_as_service_user[@]}" >/dev/null 2>&1; then
    service_user="root"
    service_group="root"
  fi
fi

install -d -m 0750 "$install_dir"
install -d -m 0755 "$env_dir"
install -d -o "$service_user" -g "$service_group" -m 0750 "$data_dir"

base_url="${PROBE_SERVER_URL%/}/downloads/agent"
for file_name in index.js region.js updater.js package.json package-lock.json; do
  curl -fsSL "$base_url/$file_name" -o "$install_dir/$file_name"
done

(
  cd "$install_dir"
  npm ci --omit=dev --ignore-scripts --no-audit --no-fund
)
chown -R "$service_user:$service_group" "$install_dir" "$data_dir"

clean_value() {
  printf '%s' "$1" | tr -d '\r\n' | sed 's/\\/\\\\/g; s/"/\\"/g'
}

{
  printf 'PROBE_SERVER_URL="%s"\n' "$(clean_value "$PROBE_SERVER_URL")"
  printf 'PROBE_TRANSPORT="%s"\n' "$(clean_value "${PROBE_TRANSPORT:-http}")"
  if [ "${PROBE_TRANSPORT:-http}" = "ws" ]; then
    printf 'PROBE_WS_URL="%s"\n' "$(clean_value "${PROBE_WS_URL:-}")"
  fi
  printf 'PROBE_TOKEN="%s"\n' "$(clean_value "$PROBE_TOKEN")"
  printf 'PROBE_NAME="%s"\n' "$(clean_value "$PROBE_NAME")"
  printf 'PROBE_AUTO_REGION="true"\n'
  printf 'REPORT_INTERVAL="3000"\n'
  printf 'AGENT_DATA_DIR="%s"\n' "$(clean_value "$data_dir")"
  printf 'AGENT_LOG_RETENTION_DAYS="7"\n'
  printf 'AGENT_NPM_PATH="%s"\n' "$(clean_value "$npm_path")"
  printf 'AGENT_SERVICE_MODE="%s"\n' "$service_mode"
} > "$env_file"
chmod 0600 "$env_file"

if [ "$service_mode" = "systemd" ]; then
  cat > "$service_file" <<EOF
[Unit]
Description=Orange Probe Agent
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
User=$service_user
Group=$service_group
WorkingDirectory=$install_dir
EnvironmentFile=$env_file
ExecStart=$node_path $install_dir/index.js
Restart=always
RestartSec=2
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable "$service_name.service" >/dev/null
  systemctl restart "$service_name.service"
  echo "Orange Probe Agent installed as $service_name.service"
  systemctl --no-pager --full status "$service_name.service" || true
else
  runner="$install_dir/run-agent.sh"
  cat > "$runner" <<EOF
#!/usr/bin/env bash
set -a
. "$env_file"
set +a
cd "$install_dir"
while true; do
  "$node_path" "$install_dir/index.js"
  exit_code=\$?
  [ "\$exit_code" -ne 0 ] || exit 0
  if [ "\$exit_code" -eq 75 ]; then sleep 2; else sleep 15; fi
done
EOF
  chmod 0755 "$runner"
  pid_file="$data_dir/agent.pid"
  if [ -f "$pid_file" ]; then
    old_pid="$(cat "$pid_file" 2>/dev/null || true)"
    [ -z "$old_pid" ] || kill "$old_pid" 2>/dev/null || true
  fi
  nohup "$runner" >/dev/null 2>&1 &
  echo "$!" > "$pid_file"
  if command -v crontab >/dev/null 2>&1; then
    (crontab -l 2>/dev/null | grep -vF "$runner" || true; printf '@reboot %s >/dev/null 2>&1\n' "$runner") | crontab -
  fi
  echo "systemd was not detected; Orange Probe Agent started with PID $(cat "$pid_file")."
fi

echo "Agent logs: $data_dir/logs (automatic 7-day retention)"
