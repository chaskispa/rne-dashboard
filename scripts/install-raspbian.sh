#!/usr/bin/env bash
set -Eeuo pipefail

APP_NAME="rne-dashboard"
APP_DIR="/opt/rne-dashboard"
DATA_DIR="/var/lib/rne-dashboard"
SERVICE_USER="rne-dashboard"
SERVICE_FILE="/etc/systemd/system/rne-dashboard.service"
NETWORK_HELPER="/usr/local/lib/rne-dashboard/network-helper"
SUDOERS_FILE="/etc/sudoers.d/rne-dashboard-network"
NODE_MAJOR="22"
DASHBOARD_PORT="4173"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd)"

info() {
  printf '\n\033[1;32m%s\033[0m\n' "$1"
}

fail() {
  printf '\nError: %s\n' "$1" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Instala RNE Panel Dashboard en Raspberry Pi OS Lite.

Uso:
  sudo bash scripts/install-raspbian.sh [opciones]

Opciones:
  --port PUERTO   Puerto web del dashboard (por defecto 4173)
  --help          Mostrar esta ayuda
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --port)
      [[ $# -ge 2 ]] || fail "Falta el valor de --port."
      DASHBOARD_PORT="$2"
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      fail "Opción desconocida: $1"
      ;;
  esac
done

[[ "${EUID}" -eq 0 ]] || fail "Ejecuta este instalador con sudo."
[[ -f /etc/os-release ]] || fail "No se pudo identificar el sistema operativo."

# shellcheck disable=SC1091
source /etc/os-release
if [[ "${ID:-}" != "raspbian" && "${ID:-}" != "debian" && "${ID_LIKE:-}" != *debian* ]]; then
  fail "Este instalador requiere Raspberry Pi OS o Debian."
fi

[[ "${DASHBOARD_PORT}" =~ ^[0-9]+$ ]] || fail "El puerto debe ser un número."
(( DASHBOARD_PORT >= 1 && DASHBOARD_PORT <= 65535 )) || fail "El puerto debe estar entre 1 y 65535."
[[ -f "${SOURCE_DIR}/server.js" && -d "${SOURCE_DIR}/public" ]] || fail "Ejecuta el instalador desde una copia completa del proyecto."
command -v systemctl >/dev/null 2>&1 || fail "systemd no está disponible."
if ! command -v sudo >/dev/null 2>&1; then
  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y sudo
fi

node_is_compatible() {
  command -v node >/dev/null 2>&1 || return 1
  case "$(command -v node)" in
    /usr/bin/node|/usr/local/bin/node) ;;
    *) return 1 ;;
  esac
  local installed_major
  installed_major="$(node --version | sed -E 's/^v([0-9]+).*/\1/')"
  [[ "${installed_major}" =~ ^[0-9]+$ ]] && (( installed_major >= 20 ))
}

install_node() {
  architecture="$(dpkg --print-architecture)"
  if [[ "${architecture}" != "arm64" && "${architecture}" != "amd64" ]]; then
    fail "La instalación automática de Node.js requiere Raspberry Pi OS de 64 bits (arm64)."
  fi
  info "Instalando Node.js ${NODE_MAJOR}"
  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y ca-certificates curl gnupg
  install -d -m 0755 /etc/apt/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
    | gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
  printf 'deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_%s.x nodistro main\n' "${NODE_MAJOR}" \
    > /etc/apt/sources.list.d/nodesource.list
  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y nodejs
  node_is_compatible || fail "Node.js 20 o posterior no quedó instalado correctamente."
}

if node_is_compatible; then
  info "Node.js $(node --version) ya está disponible"
else
  install_node
fi
NODE_BIN="$(command -v node)"

info "Instalando archivos del dashboard"
if ! getent group "${SERVICE_USER}" >/dev/null; then
  groupadd --system "${SERVICE_USER}"
fi
if ! id "${SERVICE_USER}" >/dev/null 2>&1; then
  useradd --system --gid "${SERVICE_USER}" --home-dir "${DATA_DIR}" --shell /usr/sbin/nologin "${SERVICE_USER}"
fi

install -d -o root -g root -m 0755 "${APP_DIR}"
install -d -o "${SERVICE_USER}" -g "${SERVICE_USER}" -m 0750 "${DATA_DIR}"
install -m 0644 "${SOURCE_DIR}/server.js" "${APP_DIR}/server.js"
install -m 0644 "${SOURCE_DIR}/package.json" "${APP_DIR}/package.json"
install -d -o root -g root -m 0755 "${APP_DIR}/public"
find "${APP_DIR}/public" -mindepth 1 -maxdepth 1 -type f -delete
cp -a "${SOURCE_DIR}/public/." "${APP_DIR}/public/"
chown -R root:root "${APP_DIR}"
find "${APP_DIR}" -type d -exec chmod 0755 {} +
find "${APP_DIR}" -type f -exec chmod 0644 {} +

install -d -o root -g root -m 0755 "$(dirname "${NETWORK_HELPER}")"
install -o root -g root -m 0755 "${SOURCE_DIR}/scripts/network-helper" "${NETWORK_HELPER}"

temporary_sudoers="${SUDOERS_FILE}.tmp"
printf '%s ALL=(root) NOPASSWD: %s\n' "${SERVICE_USER}" "${NETWORK_HELPER}" > "${temporary_sudoers}"
chmod 0440 "${temporary_sudoers}"
visudo -cf "${temporary_sudoers}" >/dev/null || fail "No se pudo validar la autorización de NetworkManager."
mv "${temporary_sudoers}" "${SUDOERS_FILE}"

if [[ ! -f "${DATA_DIR}/config.json" ]]; then
  temporary_config="${DATA_DIR}/config.json.tmp"
  printf '{\n  "panels": []\n}\n' > "${temporary_config}"
  chown "${SERVICE_USER}:${SERVICE_USER}" "${temporary_config}"
  chmod 0640 "${temporary_config}"
  mv "${temporary_config}" "${DATA_DIR}/config.json"
else
  temporary_config="${DATA_DIR}/config.json.tmp"
  RNE_INSTALL_CONFIG="${DATA_DIR}/config.json" "${NODE_BIN}" -e \
    'const fs=require("node:fs");const c=JSON.parse(fs.readFileSync(process.env.RNE_INSTALL_CONFIG,"utf8"));delete c.apiBaseUrl;process.stdout.write(`${JSON.stringify(c,null,2)}\n`)' \
    > "${temporary_config}"
  chown "${SERVICE_USER}:${SERVICE_USER}" "${temporary_config}"
  chmod 0640 "${temporary_config}"
  mv "${temporary_config}" "${DATA_DIR}/config.json"
  info "Conservando las rutas de paneles existentes"
fi

if [[ ! -f "${DATA_DIR}/admin-token" ]]; then
  admin_token="$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
  printf '%s\n' "${admin_token}" > "${DATA_DIR}/admin-token"
  chown "${SERVICE_USER}:${SERVICE_USER}" "${DATA_DIR}/admin-token"
  chmod 0640 "${DATA_DIR}/admin-token"
else
  admin_token="$(tr -d ' \r\n' < "${DATA_DIR}/admin-token")"
fi

info "Configurando el inicio automático"
cat > "${SERVICE_FILE}" <<EOF
[Unit]
Description=RNE LED Panel Dashboard
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${SERVICE_USER}
Group=${SERVICE_USER}
WorkingDirectory=${APP_DIR}
Environment=NODE_ENV=production
Environment=PORT=${DASHBOARD_PORT}
Environment=HOST=0.0.0.0
Environment=RNE_DATA_DIR=${DATA_DIR}
Environment=RNE_ADMIN_TOKEN_FILE=${DATA_DIR}/admin-token
Environment=RNE_NETWORK_HELPER=${NETWORK_HELPER}
ExecStart=${NODE_BIN} ${APP_DIR}/server.js
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=strict
ReadWritePaths=${DATA_DIR}

[Install]
WantedBy=multi-user.target
EOF

chmod 0644 "${SERVICE_FILE}"
systemctl daemon-reload
systemctl enable "${APP_NAME}.service" >/dev/null
systemctl restart "${APP_NAME}.service"

sleep 1
if ! systemctl is-active --quiet "${APP_NAME}.service"; then
  systemctl --no-pager --full status "${APP_NAME}.service" || true
  fail "El servicio no pudo iniciar. Revisa el estado mostrado arriba."
fi

device_ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
if [[ -z "${device_ip}" ]]; then
  device_ip="$(hostname)"
fi

info "Instalación completada"
printf 'Dashboard: http://%s:%s\n' "${device_ip}" "${DASHBOARD_PORT}"
printf 'API RNE:   https://registronacionaldeespera.cl\n'
printf 'Clave de administración de red: %s\n' "${admin_token}"
printf '\nComandos útiles:\n'
printf '  Estado:  sudo systemctl status %s\n' "${APP_NAME}"
printf '  Logs:    sudo journalctl -u %s -f\n' "${APP_NAME}"
printf '  Reinicio: sudo systemctl restart %s\n' "${APP_NAME}"
