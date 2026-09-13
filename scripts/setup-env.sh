#!/usr/bin/env bash
# Generate a .env from .env.example with random secrets.
#
# Usage:
#   ./scripts/setup-env.sh              # create .env if missing
#   ./scripts/setup-env.sh --force      # overwrite an existing .env
#   ./scripts/setup-env.sh --lan        # also set IP URLs + CORS_ALLOW_ORIGIN=*
#   ./scripts/setup-env.sh --lan --host 192.168.1.10
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
example="$root/.env.example"
target="$root/.env"

force=0
lan=0
host=""

usage() {
  cat <<'EOF'
Generate .env from .env.example with random passwords.

  --force         Overwrite an existing .env
  --lan           Access-by-IP mode: PUBLIC_* URLs + CORS_ALLOW_ORIGIN=*
  --host ADDR     Host/IP to put in those URLs (default: first LAN address)
  -h, --help      Show this help
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --force) force=1; shift ;;
    --lan) lan=1; shift ;;
    --host)
      host="${2:-}"
      if [[ -z "$host" ]]; then
        echo "error: --host needs an address" >&2
        exit 1
      fi
      shift 2
      ;;
    -h|--help) usage; exit 0 ;;
    *)
      echo "error: unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [[ ! -f "$example" ]]; then
  echo "error: missing $example" >&2
  exit 1
fi

if [[ -f "$target" && "$force" -ne 1 ]]; then
  echo "error: $target already exists (pass --force to overwrite)" >&2
  exit 1
fi

rand_hex() {
  openssl rand -hex "$1"
}

detect_lan_host() {
  local ip=""
  if command -v ipconfig >/dev/null 2>&1; then
    for iface in en0 en1 en2 en3; do
      ip="$(ipconfig getifaddr "$iface" 2>/dev/null || true)"
      if [[ -n "$ip" ]]; then
        printf '%s\n' "$ip"
        return 0
      fi
    done
  fi
  if command -v ip >/dev/null 2>&1; then
    ip="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for (i = 1; i <= NF; i++) if ($i == "src") { print $(i + 1); exit }}')"
    if [[ -n "$ip" ]]; then
      printf '%s\n' "$ip"
      return 0
    fi
  fi
  if command -v hostname >/dev/null 2>&1; then
    ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
    if [[ -n "$ip" ]]; then
      printf '%s\n' "$ip"
      return 0
    fi
  fi
  return 1
}

set_kv() {
  local key="$1"
  local value="$2"
  awk -v k="$key" -v v="$value" '
    BEGIN { FS = OFS = "=" }
    $1 == k { $0 = k "=" v; found = 1 }
    { print }
    END { if (!found) print k "=" v }
  ' "$target" >"$target.tmp"
  mv "$target.tmp" "$target"
}

postgres_password="$(rand_hex 24)"
s3_secret="$(rand_hex 24)"
session_secret="$(rand_hex 32)"
admin_password="$(rand_hex 12)"
postgres_user="vlogbuddy"
postgres_db="vlogbuddy"

cp "$example" "$target"

set_kv POSTGRES_PASSWORD "$postgres_password"
set_kv S3_SECRET_KEY "$s3_secret"
set_kv SESSION_SECRET "$session_secret"
set_kv ADMIN_PASSWORD "$admin_password"
set_kv DATABASE_URL "postgres://${postgres_user}:${postgres_password}@localhost:5432/${postgres_db}"

if [[ "$lan" -eq 1 ]]; then
  if [[ -z "$host" ]]; then
    host="$(detect_lan_host || true)"
  fi
  if [[ -z "$host" ]]; then
    echo "error: could not detect a LAN address; pass --host 192.168.x.x" >&2
    exit 1
  fi

  web_port="$(awk -F= '$1=="WEB_PORT"{print $2; exit}' "$target")"
  s3_port="$(awk -F= '$1=="S3_PORT"{print $2; exit}' "$target")"
  web_port="${web_port:-3000}"
  s3_port="${s3_port:-9000}"

  set_kv PUBLIC_BASE_URL "http://${host}:${web_port}"
  set_kv PUBLIC_STORAGE_URL "http://${host}:${s3_port}"
  set_kv CORS_ALLOW_ORIGIN "*"
fi

echo "wrote $target"
echo "  POSTGRES_PASSWORD, S3_SECRET_KEY, SESSION_SECRET: generated"
echo
echo "  Admin login for /admin (also required to create vlogs):"
echo "    user:     admin"
echo "    password: $admin_password"
if [[ "$lan" -eq 1 ]]; then
  echo "  PUBLIC_BASE_URL=http://${host}:${web_port:-3000}"
  echo "  PUBLIC_STORAGE_URL=http://${host}:${s3_port:-9000}"
  echo "  CORS_ALLOW_ORIGIN=*  (IP / no-domain uploads)"
else
  echo "  set PUBLIC_BASE_URL and PUBLIC_STORAGE_URL before starting"
fi
