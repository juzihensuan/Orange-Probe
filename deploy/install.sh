#!/usr/bin/env bash
set -euo pipefail

repository="juzihensuan/Orange-Probe"
deploy_path="${DEPLOY_PATH:-/opt/orange-probe}"
github_api="https://api.github.com/repos/$repository"

if [ "$(id -u)" -ne 0 ]; then
  if command -v sudo >/dev/null 2>&1; then
    exec sudo -E bash "$0" "$@"
  fi
  echo "Root privileges or sudo are required." >&2
  exit 1
fi

install_prerequisites() {
  command -v curl >/dev/null 2>&1 && command -v unzip >/dev/null 2>&1 && return
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update
    DEBIAN_FRONTEND=noninteractive apt-get install -y curl ca-certificates unzip
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y curl ca-certificates unzip
  elif command -v yum >/dev/null 2>&1; then
    yum install -y curl ca-certificates unzip
  elif command -v apk >/dev/null 2>&1; then
    apk add --no-cache curl ca-certificates unzip
  elif command -v pacman >/dev/null 2>&1; then
    pacman -Sy --noconfirm curl ca-certificates unzip
  else
    echo "Cannot install curl and unzip automatically on this system." >&2
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

github_curl() {
  if [ -n "${GITHUB_TOKEN:-}" ]; then
    curl -fsSL \
      -H "Authorization: Bearer $GITHUB_TOKEN" \
      -H "Accept: ${GITHUB_ACCEPT:-application/vnd.github+json}" \
      "$@"
  else
    curl -fsSL -H "Accept: ${GITHUB_ACCEPT:-application/vnd.github+json}" "$@"
  fi
}

latest_release_version() {
  github_curl "$github_api/releases/latest" | sed -n 's/.*"tag_name":[[:space:]]*"v\([^"]*\)".*/\1/p' | head -n 1
}

download_release() {
  local version="$1"
  local destination="$2"
  GITHUB_ACCEPT="application/octet-stream" github_curl \
    "https://github.com/$repository/releases/download/v$version/Orange-Probe-Docker-v$version.zip" \
    -o "$destination"
}

download_checksums() {
  local version="$1"
  local destination="$2"
  GITHUB_ACCEPT="application/octet-stream" github_curl \
    "https://github.com/$repository/releases/download/v$version/Orange-Probe-v$version.sha256" \
    -o "$destination"
}

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v openssl >/dev/null 2>&1; then
    openssl dgst -sha256 "$1" | awk '{print $NF}'
  else
    echo "A SHA256 implementation is required." >&2
    exit 1
  fi
}

install_prerequisites
install_docker

version="${ORANGE_PROBE_VERSION:-$(latest_release_version)}"
case "$version" in
  ""|*[!0-9A-Za-z._-]*)
    echo "Cannot determine a valid Orange Probe Release version." >&2
    exit 1
    ;;
esac

staging_dir="$(mktemp -d)"
trap 'rm -rf "$staging_dir"' EXIT
archive_path="$staging_dir/Orange-Probe-Docker-v$version.zip"
checksum_path="$staging_dir/Orange-Probe-v$version.sha256"
source_path="$staging_dir/orange-probe-docker-v$version"
echo "Downloading Orange Probe v$version..."
download_release "$version" "$archive_path"
download_checksums "$version" "$checksum_path"
expected_hash="$(awk -v filename="Orange-Probe-Docker-v$version.zip" '$2 == filename {print $1; exit}' "$checksum_path")"
actual_hash="$(sha256_file "$archive_path")"
if [ -z "$expected_hash" ] || [ "$expected_hash" != "$actual_hash" ]; then
  echo "Release package SHA256 verification failed." >&2
  exit 1
fi
unzip -q "$archive_path" -d "$staging_dir"
if [ ! -f "$source_path/docker-compose.yml" ] || [ ! -f "$source_path/package.json" ] || [ ! -f "$source_path/Dockerfile" ]; then
  echo "Release package structure is invalid." >&2
  exit 1
fi
install -d -m 0750 "$deploy_path"
cp -a "$source_path/." "$deploy_path/"

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
GITHUB_TOKEN=${GITHUB_TOKEN:-}
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
ensure_env_value "GITHUB_TOKEN" "${GITHUB_TOKEN:-}"
if [ -n "${GITHUB_TOKEN:-}" ]; then
  if grep -q '^GITHUB_TOKEN=' "$deploy_path/.env"; then
    sed -i "s|^GITHUB_TOKEN=.*$|GITHUB_TOKEN=$GITHUB_TOKEN|" "$deploy_path/.env"
  else
    printf 'GITHUB_TOKEN=%s\n' "$GITHUB_TOKEN" >> "$deploy_path/.env"
  fi
fi
chmod 0600 "$deploy_path/.env"

published_port="$(sed -n 's/^PUBLIC_PORT=//p' "$deploy_path/.env" | tail -n 1)"
published_port="${published_port:-4174}"

cd "$deploy_path"
docker compose --project-name orange-probe build --pull
docker compose --project-name orange-probe up -d --no-build --remove-orphans

echo "Waiting for Orange Probe..."
healthy=false
for ((attempt = 1; attempt <= 60; attempt += 1)); do
  if curl -fsS "http://127.0.0.1:$published_port/api/health" >/dev/null 2>&1; then
    healthy=true
    break
  fi
  sleep 2
done
if [ "$healthy" != "true" ]; then
  echo "Orange Probe failed its startup health check." >&2
  docker compose --project-name orange-probe ps >&2 || true
  docker compose --project-name orange-probe logs --tail=100 orange-probe orange-probe-updater >&2 || true
  exit 1
fi

echo "Orange Probe installation completed."
echo "Installed version: $version"
echo "Local URL: http://127.0.0.1:$published_port"
echo "Deployment directory: $deploy_path"
if [ -n "$generated_password" ]; then
  echo "Admin username: ${ADMIN_USERNAME:-admin}"
  echo "Admin password: $generated_password"
  echo "Store this password securely. It is also saved in $deploy_path/.env with mode 0600."
fi
echo "For public access, configure HTTPS/WSS reverse proxy to 127.0.0.1:$published_port."
