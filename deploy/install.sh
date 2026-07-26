#!/usr/bin/env bash
set -euo pipefail

repository="juzihensuan/Orange-Probe"
deploy_path="${DEPLOY_PATH:-/opt/orange-probe}"
raw_base="https://raw.githubusercontent.com/$repository/main"

if [ "$(id -u)" -ne 0 ]; then
  if command -v sudo >/dev/null 2>&1; then
    exec sudo -E bash "$0" "$@"
  fi
  echo "Root privileges or sudo are required." >&2
  exit 1
fi

install_curl() {
  command -v curl >/dev/null 2>&1 && return
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update
    DEBIAN_FRONTEND=noninteractive apt-get install -y curl ca-certificates
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y curl ca-certificates
  elif command -v yum >/dev/null 2>&1; then
    yum install -y curl ca-certificates
  elif command -v apk >/dev/null 2>&1; then
    apk add --no-cache curl ca-certificates
  else
    echo "Cannot install curl automatically on this system." >&2
    exit 1
  fi
}

install_docker() {
  command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1 && return
  echo "Installing Docker Engine and Docker Compose..."
  local installer
  installer="$(mktemp)"
  curl -fsSL https://get.docker.com -o "$installer"
  sh "$installer"
  rm -f "$installer"
  if command -v systemctl >/dev/null 2>&1; then systemctl enable --now docker; fi
  docker compose version >/dev/null 2>&1 || {
    echo "Docker Compose plugin installation failed." >&2
    exit 1
  }
}

random_hex() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex "$1"
  else
    od -An -N "$1" -tx1 /dev/urandom | tr -d ' \n'
  fi
}

install_curl
install_docker
install -d -m 0750 "$deploy_path"
curl -fsSL "$raw_base/docker-compose.yml" -o "$deploy_path/docker-compose.yml"

generated_password=""
if [ ! -f "$deploy_path/.env" ]; then
  generated_password="${ADMIN_PASSWORD:-$(random_hex 12)}"
  cat > "$deploy_path/.env" <<EOF
NODE_ENV=production
PORT=4174
DATA_DIR=/app/data
PROBE_TOKEN=$(random_hex 24)
ADMIN_USERNAME=${ADMIN_USERNAME:-admin}
ADMIN_PASSWORD=$generated_password
AGENT_TOKEN_ENCRYPTION_KEY=$(random_hex 32)
TRUST_PROXY=loopback, linklocal, uniquelocal
BIND_ADDRESS=${BIND_ADDRESS:-127.0.0.1}
PUBLIC_PORT=${PUBLIC_PORT:-4174}
DEPLOY_PATH=$deploy_path
ORANGE_PROBE_TAG=${ORANGE_PROBE_TAG:-latest}
UPDATE_TOKEN=$(random_hex 32)
TELEGRAM_API_BASE_URL=https://api.telegram.org
EOF
  chmod 0600 "$deploy_path/.env"
fi

ensure_env_value() {
  local key="$1"
  local value="$2"
  if grep -q "^${key}=$" "$deploy_path/.env"; then
    sed -i "s|^${key}=$|${key}=${value}|" "$deploy_path/.env"
  elif ! grep -q "^${key}=" "$deploy_path/.env"; then
    printf '%s=%s\n' "$key" "$value" >> "$deploy_path/.env"
  fi
}

ensure_env_value "DEPLOY_PATH" "$deploy_path"
ensure_env_value "ORANGE_PROBE_TAG" "${ORANGE_PROBE_TAG:-latest}"
ensure_env_value "UPDATE_TOKEN" "$(random_hex 32)"
chmod 0600 "$deploy_path/.env"

published_port="$(sed -n 's/^PUBLIC_PORT=//p' "$deploy_path/.env" | tail -n 1)"
published_port="${published_port:-4174}"

cd "$deploy_path"
docker compose --project-name orange-probe pull
docker compose --project-name orange-probe up -d --no-build --remove-orphans

echo "Waiting for Orange Probe..."
for attempt in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:$published_port/api/health" >/dev/null 2>&1; then break; fi
  sleep 2
done

echo "Orange Probe installation completed."
echo "Local URL: http://127.0.0.1:$published_port"
echo "Deployment directory: $deploy_path"
if [ -n "$generated_password" ]; then
  echo "Admin username: ${ADMIN_USERNAME:-admin}"
  echo "Admin password: $generated_password"
  echo "Store this password securely. It is also saved in $deploy_path/.env with mode 0600."
fi
echo "For public access, configure HTTPS/WSS reverse proxy to 127.0.0.1:$published_port."
