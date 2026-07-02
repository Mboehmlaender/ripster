#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-2.0-or-later
# =============================================================================
#  Ripster – Installationsskript (Git)
#  Unterstützt: Debian 11/12, Ubuntu 22.04/24.04
#  Benötigt: sudo / root, Internetzugang
#
#  Verwendung:
#    curl -fsSL https://raw.githubusercontent.com/Mboehmlaender/ripster/main/install.sh | sudo bash
#    oder:
#    wget -qO- https://raw.githubusercontent.com/Mboehmlaender/ripster/main/install.sh | sudo bash
#
#    Mit Optionen (nur via Datei möglich):
#    sudo bash install.sh [Optionen]
#
#  Optionen:
#    --branch <branch>     Git-Branch (Standard: main)
#    --dir <pfad>          Installationsverzeichnis (Standard: /opt/ripster)
#    --user <benutzer>     Systembenutzer für den Dienst (Standard: ripster)
#    --port <port>         Backend-Port (Standard: 3001)
#    --host <hostname>     Hostname/IP für die Weboberfläche (Standard: Maschinen-IP)
#    --no-makemkv          MakeMKV-Installation überspringen
#    --no-handbrake        HandBrake-Installation überspringen
#    --no-nginx            Nginx-Einrichtung überspringen
#    --no-system-deps      Abschnitt "Systemabhängigkeiten installieren" überspringen
#    --accept-makemkv-eula MakeMKV-Lizenz/EULA bewusst akzeptieren
#    --force-license-prompts
#                          Lizenzabfragen auch bei vorhandenen Tools erneut anzeigen
#    --reinstall           Vorhandene Installation aktualisieren (Daten bleiben erhalten)
#    -h, --help            Diese Hilfe anzeigen
# =============================================================================
set -euo pipefail

REPO_URL="https://github.com/Mboehmlaender/ripster.git"
REPO_RAW_BASE="https://raw.githubusercontent.com/Mboehmlaender/ripster"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd -P)"
BUNDLED_HANDBRAKE_CLI="${SCRIPT_DIR}/bin/HandBrakeCLI"

# --- Farben -------------------------------------------------------------------
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; BOLD='\033[1m'; RESET='\033[0m'

info()    { echo -e "${BLUE}[INFO]${RESET}  $*"; }
ok()      { echo -e "${GREEN}[OK]${RESET}    $*"; }
warn()    { echo -e "${YELLOW}[WARN]${RESET}  $*"; }
error()   { echo -e "${RED}[FEHLER]${RESET} $*" >&2; }
header()  { echo -e "\n${BOLD}${BLUE}══════════════════════════════════════════${RESET}"; \
            echo -e "${BOLD}  $*${RESET}"; \
            echo -e "${BOLD}${BLUE}══════════════════════════════════════════${RESET}"; }
fatal()   { error "$*"; exit 1; }

# --- Standard-Optionen --------------------------------------------------------
GIT_BRANCH="dev"
INSTALL_DIR="/opt/ripster"
SERVICE_USER="ripster"
BACKEND_PORT="3001"
FRONTEND_HOST=""
SKIP_MAKEMKV=false
SKIP_HANDBRAKE=false
HANDBRAKE_INSTALL_MODE=""
SKIP_NGINX=false
SKIP_SYSTEM_DEPS=false
ACCEPT_MAKEMKV_EULA=false
FORCE_LICENSE_PROMPTS=false
MAKEMKV_EULA_REVIEWED=false
HANDBRAKE_NOTICE_SHOWN=false
REINSTALL=false
GIT_COMMAND_TIMEOUT_SEC=180

# Keine interaktiven Git-Prompts im Installer (z.B. Credentials) - stattdessen
# sauber mit Fehler abbrechen.
export GIT_TERMINAL_PROMPT=0

# --- Container-Optionen -------------------------------------------------------
CONTAINER_TYPE="none"
CONTAINER_PRIVILEGE="unknown"
SERVICE_SECURITY=""

# --- Argumente parsen ---------------------------------------------------------
while [[ $# -gt 0 ]]; do
  case "$1" in
    --branch)             GIT_BRANCH="$2"; shift 2 ;;
    --dir)                INSTALL_DIR="$2"; shift 2 ;;
    --user)               SERVICE_USER="$2"; shift 2 ;;
    --port)               BACKEND_PORT="$2"; shift 2 ;;
    --host)               FRONTEND_HOST="$2"; shift 2 ;;
    --no-makemkv)         SKIP_MAKEMKV=true; shift ;;
    --no-handbrake)       SKIP_HANDBRAKE=true; shift ;;
    --no-nginx)           SKIP_NGINX=true; shift ;;
    --no-system-deps)     SKIP_SYSTEM_DEPS=true; shift ;;
    --accept-makemkv-eula) ACCEPT_MAKEMKV_EULA=true; shift ;;
    --force-license-prompts) FORCE_LICENSE_PROMPTS=true; shift ;;
    --reinstall)          REINSTALL=true; shift ;;
    -h|--help)
      sed -n '/^#  Verwendung/,/^# ====/p' "$0" | head -n -1 | sed 's/^#  \?//'
      exit 0 ;;
    *) fatal "Unbekannte Option: $1" ;;
  esac
done

# --- Voraussetzungen prüfen ---------------------------------------------------
header "Ripster Installationsskript (Git)"

if [[ $EUID -ne 0 ]]; then
  fatal "Dieses Skript muss als root ausgeführt werden (sudo bash install.sh)"
fi

if [[ ! -f /etc/os-release ]]; then
  fatal "Betriebssystem nicht erkennbar. Nur Debian/Ubuntu wird unterstützt."
fi
. /etc/os-release
case "$ID" in
  debian|ubuntu|linuxmint|pop) ok "Betriebssystem: $PRETTY_NAME" ;;
  *) fatal "Nicht unterstütztes OS: $ID. Nur Debian/Ubuntu unterstützt." ;;
esac

# --- Container Detection ------------------------------------------------------
detect_container_env() {
  CONTAINER_TYPE="none"
  CONTAINER_PRIVILEGE="unknown"

  if command -v systemd-detect-virt &>/dev/null; then
    local virt
    virt=$(systemd-detect-virt 2>/dev/null || true)
    if [[ -n "$virt" && "$virt" != "none" ]]; then
      CONTAINER_TYPE="$virt"
    fi
  fi

  if [[ -f /proc/1/environ ]] && tr '\0' '\n' < /proc/1/environ | grep -q '^container=lxc$'; then
    CONTAINER_TYPE="lxc"
  fi

  if [[ "$CONTAINER_TYPE" == "lxc" ]]; then
    if [[ -r /proc/self/uid_map ]]; then
      local uid_map_line
      uid_map_line=$(head -n1 /proc/self/uid_map 2>/dev/null || true)
      if [[ "$uid_map_line" =~ ^0[[:space:]]+0[[:space:]]+ ]]; then
        CONTAINER_PRIVILEGE="privileged"
      else
        CONTAINER_PRIVILEGE="unprivileged"
      fi
    else
      CONTAINER_PRIVILEGE="unprivileged"
    fi
  fi

  info "Container-Typ:        $CONTAINER_TYPE"
  info "Privileg-Level:       $CONTAINER_PRIVILEGE"
}

# --- Hilfsfunktionen ----------------------------------------------------------

command_exists() { command -v "$1" &>/dev/null; }

run_git_command() {
  local description="$1"
  shift
  local status=0

  info "$description..."
  if command_exists timeout; then
    timeout --foreground "${GIT_COMMAND_TIMEOUT_SEC}" "$@"
    status=$?
    if [[ "$status" -ne 0 ]]; then
      if [[ "$status" -eq 124 ]]; then
        fatal "Git-Kommando lief in Timeout (${GIT_COMMAND_TIMEOUT_SEC}s): $*"
      fi
      fatal "Git-Kommando fehlgeschlagen (Exit $status): $*"
    fi
  else
    "$@"
    status=$?
    if [[ "$status" -ne 0 ]]; then
      fatal "Git-Kommando fehlgeschlagen (Exit $status): $*"
    fi
  fi
}

service_unit_exists() {
  local unit="$1"
  systemctl list-unit-files --type=service --all --no-legend 2>/dev/null \
    | awk '{print $1}' | grep -Fxq "$unit"
}

stop_service_if_exists() {
  local service="$1"
  local unit="${service}.service"

  if ! command_exists systemctl; then
    warn "systemctl nicht gefunden - Stop von '$service' uebersprungen"
    return 0
  fi

  if service_unit_exists "$unit"; then
    if systemctl is-active --quiet "$service"; then
      info "Stoppe Dienst '$service' vor dem Update..."
      systemctl stop "$service"
      ok "Dienst '$service' gestoppt"
    else
      info "Dienst '$service' ist bereits gestoppt"
    fi
  else
    info "Dienst '$service' nicht vorhanden - Stop uebersprungen"
  fi
}

backup_and_remove_backend_src() {
  local src_dir="$INSTALL_DIR/backend/src"
  local backup_root="$INSTALL_DIR/backend/src_backups"
  local backup_dir="${backup_root}/src_bak_$(date +%Y%m%d%H%M%S)"
  local keep_count=2
  local backups=()
  local old_backup

  if [[ ! -d "$src_dir" ]]; then
    fatal "Reinstall erwartet vorhandenes Backend-Quellverzeichnis: $src_dir"
  fi

  mkdir -p "$backup_root"
  mv "$src_dir" "$backup_dir"
  ok "Backend-Quellverzeichnis gesichert nach: $backup_dir"

  mapfile -t backups < <(ls -1dt "$backup_root"/src_bak_* 2>/dev/null || true)
  if (( ${#backups[@]} > keep_count )); then
    for old_backup in "${backups[@]:keep_count}"; do
      rm -rf "$old_backup"
      info "Altes src-Backup entfernt: $old_backup"
    done
  fi
}

backup_persistent_backend_data() {
  local src_dir="$INSTALL_DIR/backend/data"
  local backup_root="$INSTALL_DIR/backend/data/temp/ripster-data-backup"
  local backup_dir="${backup_root}/data_bak_$(date +%Y%m%d%H%M%S)"
  local copied_any=false
  local candidate

  if [[ ! -d "$src_dir" ]]; then
    warn "Kein Backend-Datenverzeichnis gefunden: $src_dir"
    return 0
  fi

  # Nur kleine, kritische Metadaten sichern. Medienordner bleiben im
  # Installationspfad bestehen und werden hier bewusst nicht kopiert.
  mkdir -p "$backup_dir"
  for candidate in "ripster.db" "ripster.db-shm" "ripster.db-wal" "thumbnails"; do
    if [[ -e "${src_dir}/${candidate}" ]]; then
      cp -a "${src_dir}/${candidate}" "$backup_dir/"
      copied_any=true
    fi
  done

  if [[ "$copied_any" == true ]]; then
    DATA_BACKUP="$backup_dir"
    ok "Persistente Backend-Daten gesichert nach: $DATA_BACKUP"
  else
    warn "Keine zu sichernden Kern-Daten in $src_dir gefunden (ripster.db/thumbnails)."
  fi
}

enforce_default_output_dirs_permissions() {
  local default_dirs=(
    "$INSTALL_DIR/backend/data/output/raw"
    "$INSTALL_DIR/backend/data/output/movies"
    "$INSTALL_DIR/backend/data/output/series"
    "$INSTALL_DIR/backend/data/output/cd"
  )
  local dir

  for dir in "${default_dirs[@]}"; do
    mkdir -p "$dir"
    chown "$SERVICE_USER:$SERVICE_USER" "$dir"
    chmod 755 "$dir"
  done

  ok "Default-Output-Ordner auf $SERVICE_USER:$SERVICE_USER (755) gesetzt"
}

post_install_check_default_dirs() {
  header "Post-Install-Check (Default-Ordner)"

  local default_dirs=(
    "$INSTALL_DIR/backend/data/output/raw"
    "$INSTALL_DIR/backend/data/output/movies"
    "$INSTALL_DIR/backend/data/output/series"
    "$INSTALL_DIR/backend/data/output/cd"
  )
  local expected_owner="${SERVICE_USER}:${SERVICE_USER}"
  local expected_mode="755"
  local dir
  local owner
  local mode
  local failed=0

  for dir in "${default_dirs[@]}"; do
    if [[ ! -d "$dir" ]]; then
      error "Fehlt: $dir"
      failed=1
      continue
    fi
    owner="$(stat -c '%U:%G' "$dir" 2>/dev/null || true)"
    mode="$(stat -c '%a' "$dir" 2>/dev/null || true)"
    if [[ "$owner" != "$expected_owner" || "$mode" != "$expected_mode" ]]; then
      error "Falsche Rechte bei $dir (owner=$owner mode=$mode, erwartet: $expected_owner / $expected_mode)"
      failed=1
    else
      ok "$dir -> $owner / $mode"
    fi
  done

  if [[ "$failed" -ne 0 ]]; then
    fatal "Post-Install-Check fehlgeschlagen. Rechte/Owner der Default-Ordner bitte prüfen."
  fi
}

download_file() {
  local url="$1"
  local target="$2"

  if command_exists curl; then
    curl -fsSL "$url" -o "$target"
    return 0
  fi

  if command_exists wget; then
    wget -q "$url" -O "$target"
    return 0
  fi

  return 1
}

nginx_replace_or_insert_directive() {
  local file="$1"
  local directive_regex="$2"
  local desired_line="$3"
  local anchor_regex="$4"
  local directive_sed_regex="${directive_regex//\//\\/}"
  local anchor_sed_regex="${anchor_regex//\//\\/}"
  local desired_sed_line="${desired_line//\//\\/}"

  if grep -Eq "$directive_regex" "$file"; then
    sed -i -E "0,/$directive_sed_regex/s//${desired_sed_line}/" "$file"
    return 0
  fi

  sed -i "/$anchor_sed_regex/a\\$desired_line" "$file"
}

patch_existing_ripster_nginx_site() {
  local file="$1"
  local backup_file="${file}.bak-$(date +%Y%m%d%H%M%S)"

  [[ -f "$file" ]] || return 1

  cp -a "$file" "$backup_file"
  info "Bestehende nginx-Konfiguration erkannt - ergänze Upload-/Proxy-Settings"
  info "Backup erstellt: $backup_file"

  nginx_replace_or_insert_directive \
    "$file" \
    '^[[:space:]]*client_max_body_size[[:space:]]+[^;]+;' \
    '    client_max_body_size 8G;' \
    'server_name .*;'

  nginx_replace_or_insert_directive \
    "$file" \
    '^[[:space:]]*proxy_connect_timeout[[:space:]]+[^;]+;' \
    '        proxy_connect_timeout 60s;' \
    'location /api/ {'

  nginx_replace_or_insert_directive \
    "$file" \
    '^[[:space:]]*proxy_send_timeout[[:space:]]+[^;]+;' \
    '        proxy_send_timeout 3600s;' \
    'location /api/ {'

  nginx_replace_or_insert_directive \
    "$file" \
    '^[[:space:]]*proxy_read_timeout[[:space:]]+[^;]+;' \
    '        proxy_read_timeout 3600s;' \
    'location /api/ {'

  nginx_replace_or_insert_directive \
    "$file" \
    '^[[:space:]]*proxy_request_buffering[[:space:]]+[^;]+;' \
    '        proxy_request_buffering off;' \
    'location /api/ {'
}

generate_systemd_security() {
  SERVICE_SECURITY=$(cat <<EOF
# Kein statisches DeviceAllow: Device-Pfade unterscheiden sich je nach Host/Container.
# Damit Ripster auf unterschiedlichen Systemen funktioniert, kein Device-Cgroup-Filter.
DevicePolicy=auto
SupplementaryGroups=video render cdrom disk

# Für Skriptausführung via GUI (inkl. optionalem sudo in User-Skripten)
# darf no_new_privileges nicht aktiv sein.
NoNewPrivileges=false
ProtectSystem=full
ReadWritePaths=${INSTALL_DIR}/backend/data ${INSTALL_DIR}/backend/logs ${SERVICE_HOME} ${MAKEMKV_SERVICE_DIR}
PrivateTmp=true
EOF
)

  if [[ "$CONTAINER_TYPE" == "lxc" ]]; then
    warn "LXC erkannt – passe systemd-Sandbox an"

    if [[ "$CONTAINER_PRIVILEGE" == "privileged" ]]; then
      SERVICE_SECURITY=$(cat <<EOF
# Kein statisches DeviceAllow: Device-Pfade unterscheiden sich je nach Host/Container.
# Damit Ripster auf unterschiedlichen Systemen funktioniert, kein Device-Cgroup-Filter.
DevicePolicy=auto
SupplementaryGroups=video render cdrom disk

# Für Skriptausführung via GUI (inkl. optionalem sudo in User-Skripten)
# darf no_new_privileges nicht aktiv sein.
NoNewPrivileges=false
ProtectSystem=full
PrivateTmp=false
EOF
)
    else
      SERVICE_SECURITY=$(cat <<EOF
SupplementaryGroups=video render cdrom disk

# Für Skriptausführung via GUI (inkl. optionalem sudo in User-Skripten)
# darf no_new_privileges nicht aktiv sein.
NoNewPrivileges=false
EOF
)
      warn "Unprivileged LXC – systemd-Sandbox deaktiviert"
    fi
  fi
}

install_node() {
  header "Node.js installieren"
  local required_major=20

  if command_exists node; then
    local current_major
    current_major=$(node -e "process.stdout.write(String(process.version.split('.')[0].replace('v','')))")
    if [[ "$current_major" -ge "$required_major" ]]; then
      ok "Node.js $(node --version) bereits installiert"
      return
    fi
    warn "Node.js $(node --version) zu alt – Node.js 20 wird installiert"
  fi

  info "Installiere Node.js 20.x über NodeSource..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
  ok "Node.js $(node --version) installiert"
}

confirm_makemkv_eula() {
  if [[ "$MAKEMKV_EULA_REVIEWED" == true ]]; then
    return 0
  fi

  if [[ "$ACCEPT_MAKEMKV_EULA" == true ]]; then
    warn "MakeMKV-EULA wurde per --accept-makemkv-eula ausdrücklich akzeptiert."
    MAKEMKV_EULA_REVIEWED=true
    return 0
  fi

  echo ""
  warn "MakeMKV unterliegt eigenen Lizenz- und Registrierungsbedingungen."
  warn "Ripster kann diese Bedingungen nicht automatisch fuer dich akzeptieren."
  echo "Bitte pruefe die MakeMKV-Lizenzbedingungen, bevor MakeMKV gebaut und installiert wird."
  echo ""

  local answer=""
  if [[ -t 0 ]]; then
    read -r -p "MakeMKV-EULA bewusst akzeptieren und MakeMKV installieren? Tippe 'yes': " answer
  elif [[ -r /dev/tty ]]; then
    read -r -p "MakeMKV-EULA bewusst akzeptieren und MakeMKV installieren? Tippe 'yes': " answer </dev/tty
  else
    fatal "MakeMKV-Installation benoetigt ausdrueckliche Zustimmung. Nutze --accept-makemkv-eula oder --no-makemkv."
  fi

  if [[ "$answer" != "yes" ]]; then
    fatal "MakeMKV-Installation abgebrochen. Nutze --no-makemkv zum Ueberspringen."
  fi

  ACCEPT_MAKEMKV_EULA=true
  MAKEMKV_EULA_REVIEWED=true
}

show_handbrake_license_notice() {
  if [[ "$HANDBRAKE_NOTICE_SHOWN" == true ]]; then
    return 0
  fi

  echo ""
  warn "HandBrakeCLI ist ein eigenständiges Drittanbieterprogramm unter GPL-2.0-only."
  warn "Die Ripster-Lizenz ersetzt oder verändert die HandBrake-Lizenz nicht."
  if [[ "$HANDBRAKE_INSTALL_MODE" == "gpu" ]]; then
    warn "Die gebündelte HandBrakeCLI enthält FDK-AAC-Hinweise."
    warn "Ihre Weiterverteilung ist bis zur Klärung oder einem Neuaufbau ohne FDK-AAC ungeklärt."
  else
    info "Bei der Standardversion gelten die Lizenzhinweise des Distributionspakets."
  fi
  info "Weitere Details: THIRD_PARTY_NOTICES.md und third_party/handbrake/BUILDINFO.md"
  HANDBRAKE_NOTICE_SHOWN=true
}

install_makemkv() {
  header "MakeMKV installieren"

  if command_exists makemkvcon; then
    ok "makemkvcon bereits installiert ($(makemkvcon --version 2>&1 | head -1))"
    return
  fi

  confirm_makemkv_eula

  info "Installiere Build-Abhängigkeiten für MakeMKV..."
  apt-get install -y \
    build-essential pkg-config libc6-dev libssl-dev \
    libexpat1-dev libavcodec-dev libgl1-mesa-dev \
    qtbase5-dev zlib1g-dev wget

  # Aktuelle Version aus dem offiziellen Linux-Forum-Thread ermitteln.
  # Der Titel lautet immer: "MakeMKV X.Y.Z for Linux is available"
  local makemkv_fallback="1.18.3"
  info "Ermittle aktuelle MakeMKV-Version (forum.makemkv.com)..."
  local makemkv_version
  makemkv_version=$(curl -s --max-time 15 \
    "https://forum.makemkv.com/forum/viewtopic.php?f=3&t=224" \
    | grep -oP 'MakeMKV \K[0-9]+\.[0-9]+\.[0-9]+(?= for Linux)' | head -1 || true)

  if [[ -z "$makemkv_version" ]]; then
    warn "MakeMKV-Version konnte nicht ermittelt werden – verwende Fallback $makemkv_fallback"
    makemkv_version="$makemkv_fallback"
  else
    info "Aktuelle Version: $makemkv_version"
  fi

  info "Baue MakeMKV $makemkv_version..."
  local tmp_dir
  tmp_dir=$(mktemp -d)
  cd "$tmp_dir"

  local base_url="https://www.makemkv.com/download"
  wget -q "${base_url}/makemkv-bin-${makemkv_version}.tar.gz"
  wget -q "${base_url}/makemkv-oss-${makemkv_version}.tar.gz"

  tar xf "makemkv-oss-${makemkv_version}.tar.gz"
  cd "makemkv-oss-${makemkv_version}"
  ./configure
  make -j"$(nproc)"
  make install

  cd "$tmp_dir"
  tar xf "makemkv-bin-${makemkv_version}.tar.gz"
  cd "makemkv-bin-${makemkv_version}"
  # MakeMKV expects this marker during its own build after explicit user consent.
  mkdir -p tmp && echo "accepted" > tmp/eula_accepted
  make -j"$(nproc)"
  make install

  cd /
  rm -rf "$tmp_dir"
  ok "MakeMKV $makemkv_version installiert"
  info "Der MakeMKV-Betakey wird nach dem Backend-Start automatisch per API übernommen, sofern noch kein eigener Key gespeichert ist."
}

sync_makemkv_beta_key() {
  header "MakeMKV Betakey synchronisieren"

  local backend_base_url="http://127.0.0.1:${BACKEND_PORT}/api"
  local backend_health_url="${backend_base_url}/health"
  local backend_settings_url="${backend_base_url}/settings"
  local beta_api_url="https://cable.ayra.ch/makemkv/api.php?json"
  local settings_response=""
  local current_key=""
  local beta_response=""
  local beta_key=""
  local save_response=""
  local makemkv_settings_file="${SERVICE_HOME}/.MakeMKV/settings.conf"
  local wait_attempt=0

  update_makemkv_settings_file_key() {
    local settings_file="$1"
    local registration_key="$2"
    local tmp_file
    tmp_file=$(mktemp)

    if [[ -f "$settings_file" ]]; then
      grep -vE '^[[:space:]]*app_Key[[:space:]]*=' "$settings_file" > "$tmp_file" || true
    else
      : > "$tmp_file"
    fi

    printf 'app_Key = "%s"\n' "$registration_key" >> "$tmp_file"
    mv "$tmp_file" "$settings_file"
    chown "$SERVICE_USER:$SERVICE_USER" "$settings_file" 2>/dev/null || true
    chmod 600 "$settings_file" 2>/dev/null || true
  }

  while (( wait_attempt < 10 )); do
    if curl -fsS "$backend_health_url" >/dev/null 2>&1; then
      break
    fi
    wait_attempt=$((wait_attempt + 1))
    sleep 1
  done

  if ! settings_response=$(curl -fsS "$backend_settings_url" 2>/dev/null); then
    warn "Backend-Settings konnten nicht geladen werden."
    warn "Betakey-Synchronisierung übersprungen: $backend_settings_url"
    return 0
  fi

  current_key=$(printf '%s' "$settings_response" | jq -r '
    (.categories // [])
    | map(.settings // [])
    | add
    | map(select(.key == "makemkv_registration_key"))
    | .[0].value // ""
  ' 2>/dev/null || true)
  current_key="${current_key:-}"

  mkdir -p "${SERVICE_HOME}/.MakeMKV"
  chown "$SERVICE_USER:$SERVICE_USER" "${SERVICE_HOME}/.MakeMKV" 2>/dev/null || true
  chmod 700 "${SERVICE_HOME}/.MakeMKV" 2>/dev/null || true

  if [[ -n "$current_key" ]]; then
    update_makemkv_settings_file_key "$makemkv_settings_file" "$current_key"
    ok "Vorhandener MakeMKV-Key bleibt erhalten ($makemkv_settings_file)"
    return 0
  fi

  if ! beta_response=$(curl -fsS \
    -A 'Ripster/1.0 (MakeMKV beta key installer)' \
    -H 'From: admin@example.invalid' \
    -H 'Accept: application/json, text/plain;q=0.9, */*;q=0.8' \
    -H 'Accept-Language: de,en-US;q=0.7,en;q=0.3' \
    -H 'Cache-Control: no-cache' \
    -H 'Pragma: no-cache' \
    "$beta_api_url" 2>/dev/null); then
    warn "MakeMKV-Betakey konnte nicht von der JSON-API geladen werden."
    warn "API-Endpunkt fehlgeschlagen: $beta_api_url"
    return 0
  fi

  beta_key=$(printf '%s' "$beta_response" | jq -r '.key // ""' 2>/dev/null || true)
  beta_key="${beta_key:-}"
  if [[ -z "$beta_key" ]]; then
    warn "MakeMKV-Betakey fehlt in der JSON-Antwort."
    return 0
  fi

  if ! save_response=$(curl -fsS \
    -X PUT \
    -H 'Content-Type: application/json' \
    --data "{\"value\":$(printf '%s' "$beta_key" | jq -Rs .)}" \
    "${backend_settings_url}/makemkv_registration_key" 2>/dev/null); then
    warn "MakeMKV-Betakey konnte nicht in den Settings gespeichert werden."
    return 0
  fi

  update_makemkv_settings_file_key "$makemkv_settings_file" "$beta_key"
  ok "MakeMKV-Betakey automatisch gespeichert ($makemkv_settings_file)"
}

select_handbrake_mode() {
  [[ "$SKIP_HANDBRAKE" == true ]] && return

  local mode_answer=""
  echo ""
  echo "Install HandBrake:"
  echo ""
  echo "1. Standard version (apt install handbrake-cli)"
  echo "2. GPU version with NVDEC (use bundled binary)"

  if [[ -t 0 ]]; then
    read -r -p "Select option [1/2]: " mode_answer
  elif [[ -r /dev/tty ]]; then
    read -r -p "Select option [1/2]: " mode_answer </dev/tty
  else
    HANDBRAKE_INSTALL_MODE="standard"
    warn "Kein interaktives Terminal erkannt – verwende Standardversion (apt)."
    return
  fi

  case "$mode_answer" in
    2) HANDBRAKE_INSTALL_MODE="gpu" ;;
    1|"") HANDBRAKE_INSTALL_MODE="standard" ;;
    *) warn "Ungültige Auswahl '$mode_answer' – verwende Standardversion."; HANDBRAKE_INSTALL_MODE="standard" ;;
  esac
}

install_handbrake_standard() {
  info "Installiere HandBrakeCLI aus den Standard-Repositories..."
  info "Aktualisiere Paketlisten..."
  apt_update
  apt-get install -y handbrake-cli
  hash -r 2>/dev/null || true

  if command_exists HandBrakeCLI; then
    ok "HandBrakeCLI installiert: $(HandBrakeCLI --version 2>&1 | head -1)"
    return
  fi

  if command_exists handbrake-cli; then
    ok "handbrake-cli installiert: $(handbrake-cli --version 2>&1 | head -1)"
    return
  fi

  fatal "HandBrake wurde installiert, aber kein CLI-Befehl wurde gefunden."
}

verify_bundled_handbrake_binary() {
  local candidate="$1"
  local checksum_file="${SCRIPT_DIR}/third_party/handbrake/SHA256SUMS"
  local host_arch
  local binary_desc=""

  if [[ ! -f "$candidate" ]]; then
    fatal "Gebündelte HandBrakeCLI fehlt: $candidate"
  fi

  if [[ ! -x "$candidate" ]]; then
    fatal "Gebündelte HandBrakeCLI ist nicht ausführbar: $candidate"
  fi

  host_arch="$(uname -m 2>/dev/null || echo unknown)"
  if command_exists file; then
    binary_desc="$(file -b "$candidate" 2>/dev/null || true)"
    info "Gebündelte HandBrakeCLI: ${binary_desc:-Architektur nicht ermittelbar}"
    case "$binary_desc" in
      *"x86-64"*)
        case "$host_arch" in
          x86_64|amd64) ;;
          *) fatal "Gebündelte HandBrakeCLI ist x86-64, Host-Architektur ist '$host_arch'." ;;
        esac
        ;;
      *)
        warn "Architektur der gebündelten HandBrakeCLI konnte nicht eindeutig geprüft werden."
        ;;
    esac
  else
    warn "Befehl 'file' nicht gefunden - Architekturprüfung für HandBrakeCLI übersprungen."
  fi

  if [[ -f "$checksum_file" ]] && command_exists sha256sum; then
    local expected
    local actual
    expected=$(awk '$2 == "bin/HandBrakeCLI" || $2 == "./bin/HandBrakeCLI" { print $1; exit }' "$checksum_file")
    if [[ -n "$expected" ]]; then
      actual=$(sha256sum "$candidate" | awk '{ print $1 }')
      if [[ "$actual" != "$expected" ]]; then
        fatal "Prüfsumme der gebündelten HandBrakeCLI stimmt nicht. Erwartet $expected, erhalten $actual."
      fi
      ok "Prüfsumme der gebündelten HandBrakeCLI verifiziert"
    else
      warn "Keine passende HandBrakeCLI-Prüfsumme in $checksum_file gefunden."
    fi
  else
    warn "HandBrakeCLI-Prüfsumme konnte nicht geprüft werden (SHA256SUMS oder sha256sum fehlt)."
  fi
}

install_handbrake_gpu_bundled() {
  info "Installiere gebündelte GPU-fähige HandBrakeCLI..."
  local bundled_source="$BUNDLED_HANDBRAKE_CLI"
  local downloaded_tmp=""

  if [[ ! -f "$bundled_source" ]]; then
    local remote_url="${REPO_RAW_BASE}/${GIT_BRANCH}/bin/HandBrakeCLI"
    downloaded_tmp=$(mktemp)
    info "Lokale Binary fehlt – lade aus Branch '$GIT_BRANCH' nach..."
    if download_file "$remote_url" "$downloaded_tmp"; then
      chmod 0755 "$downloaded_tmp"
      bundled_source="$downloaded_tmp"
      ok "Bundled HandBrakeCLI temporär heruntergeladen"
    else
      rm -f "$downloaded_tmp" 2>/dev/null || true
      fatal "Bundled Binary fehlt lokal ($BUNDLED_HANDBRAKE_CLI) und Download schlug fehl: $remote_url"
    fi
  fi

  verify_bundled_handbrake_binary "$bundled_source"

  install -m 0755 "$bundled_source" /usr/local/bin/HandBrakeCLI
  hash -r 2>/dev/null || true
  if [[ -n "$downloaded_tmp" ]]; then
    rm -f "$downloaded_tmp" 2>/dev/null || true
  fi

  ok "Bundled HandBrakeCLI installiert nach /usr/local/bin/HandBrakeCLI"
  if command_exists HandBrakeCLI; then
    ok "HandBrakeCLI Version: $(HandBrakeCLI --version 2>&1 | head -1)"
  fi
}

install_handbrake() {
  header "HandBrake CLI installieren"

  if [[ -z "$HANDBRAKE_INSTALL_MODE" ]]; then
    HANDBRAKE_INSTALL_MODE="standard"
  fi

  show_handbrake_license_notice

  case "$HANDBRAKE_INSTALL_MODE" in
    standard) install_handbrake_standard ;;
    gpu) install_handbrake_gpu_bundled ;;
    *) fatal "Unbekannter HandBrake-Modus: $HANDBRAKE_INSTALL_MODE" ;;
  esac
}

# --- apt-Hilfsfunktionen ------------------------------------------------------

# Führt apt-get update aus. Bei Release-Fehlern wird versucht, die Sources zu
# reparieren (Proxmox-Container, veraltete Spiegelserver, etc.).
apt_update() {
  local output
  if output=$(apt-get update 2>&1); then
    return 0
  fi

  # Release-Datei fehlt → versuche Repair
  if echo "$output" | grep -q "no longer has a Release file\|does not have a Release file"; then
    warn "apt-Sources fehlerhaft. Versuche Reparatur..."

    # Strategie 1: --allow-releaseinfo-change
    if apt-get update --allow-releaseinfo-change -qq 2>/dev/null; then
      ok "apt-Update mit --allow-releaseinfo-change erfolgreich"
      return 0
    fi

    # Strategie 2: Kaputte Einträge aus sources.list.d entfernen und Fallback
    # auf offizielle Spiegel schreiben
    if [[ -n "${VERSION_CODENAME:-}" ]]; then
      warn "Schreibe minimale sources.list für $VERSION_CODENAME..."
      local main_list=/etc/apt/sources.list

      # Backup
      cp "$main_list" "${main_list}.bak-$(date +%Y%m%d%H%M%S)" 2>/dev/null || true

      case "$ID" in
        ubuntu)
          cat > "$main_list" <<EOF
deb http://archive.ubuntu.com/ubuntu ${VERSION_CODENAME} main restricted universe multiverse
deb http://archive.ubuntu.com/ubuntu ${VERSION_CODENAME}-updates main restricted universe multiverse
deb http://archive.ubuntu.com/ubuntu ${VERSION_CODENAME}-security main restricted universe multiverse
EOF
          ;;
        debian)
          cat > "$main_list" <<EOF
deb http://deb.debian.org/debian ${VERSION_CODENAME} main contrib non-free
deb http://deb.debian.org/debian ${VERSION_CODENAME}-updates main contrib non-free
deb http://security.debian.org/debian-security ${VERSION_CODENAME}-security main contrib non-free
EOF
          ;;
      esac

      if apt-get update -qq 2>/dev/null; then
        ok "apt-Update nach Sources-Reparatur erfolgreich"
        return 0
      fi
    fi

    # Strategie 3: Kaputte .list-Dateien in sources.list.d deaktivieren
    warn "Deaktiviere fehlerhafte Eintraege in /etc/apt/sources.list.d/ ..."
    local broken_files
    broken_files=$(apt-get update 2>&1 | grep -oP "(?<=The repository ').*?(?=' )" | \
      xargs -I{} grep -rl "{}" /etc/apt/sources.list.d/ 2>/dev/null || true)
    if [[ -n "$broken_files" ]]; then
      echo "$broken_files" | while read -r f; do
        warn "Deaktiviere: $f"
        mv "$f" "${f}.disabled" 2>/dev/null || true
      done
      if apt-get update -qq 2>/dev/null; then
        ok "apt-Update nach Deaktivierung fehlerhafter Sources erfolgreich"
        return 0
      fi
    fi

    error "apt-Update fehlgeschlagen. Bitte Sources manuell pruefen:"
    echo "$output"
    fatal "Installation abgebrochen. Repariere /etc/apt/sources.list und starte erneut."
  else
    error "apt-Update fehlgeschlagen:"
    echo "$output"
    fatal "Installation abgebrochen."
  fi
}

detect_container_env

if [[ -z "$FRONTEND_HOST" ]]; then
  FRONTEND_HOST=$(hostname -I | awk '{print $1}')
  info "Erkannte IP: $FRONTEND_HOST"
fi

info "Repository:            $REPO_URL"
info "Branch:                $GIT_BRANCH"
info "Installationsverzeichnis: $INSTALL_DIR"
info "Systembenutzer:        $SERVICE_USER"
info "Backend-Port:          $BACKEND_PORT"
info "Frontend-Host:         $FRONTEND_HOST"
info "System-Dependencies:   $([[ "$SKIP_SYSTEM_DEPS" == true ]] && echo "überspringen" || echo "installieren")"

# --- HandBrake-Installmodus auswählen ----------------------------------------
if [[ "$SKIP_SYSTEM_DEPS" == false || "$FORCE_LICENSE_PROMPTS" == true ]]; then
  select_handbrake_mode
fi

# --- Lizenzhinweise auf Wunsch unabhängig vom Installationsstatus zeigen -----
if [[ "$FORCE_LICENSE_PROMPTS" == true ]]; then
  header "Lizenzabfragen erneut anzeigen"

  if [[ "$SKIP_MAKEMKV" == false ]]; then
    confirm_makemkv_eula
  else
    warn "MakeMKV-Lizenzabfrage übersprungen (--no-makemkv)"
  fi

  if [[ "$SKIP_HANDBRAKE" == false ]]; then
    show_handbrake_license_notice
  else
    warn "HandBrake-Lizenzhinweis übersprungen (--no-handbrake)"
  fi
fi

# --- Systemabhängigkeiten -----------------------------------------------------
if [[ "$SKIP_SYSTEM_DEPS" == true ]]; then
  header "Systemabhängigkeiten installieren"
  warn "Übersprungen (--no-system-deps)"
else
  header "Systemabhängigkeiten installieren"

  info "Paketlisten aktualisieren..."
  apt_update

  info "Installiere Basispakete..."
  apt-get install -y \
    curl wget git jq \
    ffmpeg \
    mediainfo \
    util-linux udev \
    ca-certificates gnupg \
    lsb-release \
    mkvtoolnix \
    coreutils

  ok "Basispakete installiert"

  info "Installiere CD-Ripping-Tools..."
  apt-get install -y \
    cdparanoia \
    flac \
    lame \
    opus-tools \
    vorbis-tools

  ok "CD-Ripping-Tools installiert (cdparanoia, flac, lame, opus-tools, vorbis-tools)"

  install_node

  if [[ "$SKIP_MAKEMKV" == false ]]; then
    install_makemkv
  else
    warn "MakeMKV-Installation übersprungen (--no-makemkv)"
  fi

  if [[ "$SKIP_HANDBRAKE" == false ]]; then
    install_handbrake
  else
    warn "HandBrake-Installation übersprungen (--no-handbrake)"
  fi

  if [[ "$SKIP_NGINX" == false ]]; then
    if ! command_exists nginx; then
      info "Installiere nginx..."
      apt-get install -y nginx
    fi
    ok "nginx installiert"
  fi
fi

if [[ "$SKIP_SYSTEM_DEPS" == true ]]; then
  missing_required=()
  command_exists git || missing_required+=("git")
  command_exists jq  || missing_required+=("jq")
  command_exists node || missing_required+=("node")
  command_exists npm || missing_required+=("npm")
  if [[ "$SKIP_NGINX" == false ]]; then
    command_exists nginx || missing_required+=("nginx")
  fi

  if [[ ${#missing_required[@]} -gt 0 ]]; then
    fatal "--no-system-deps gesetzt, aber folgende Pflicht-Tools fehlen: ${missing_required[*]}. Bitte vorab installieren oder ohne --no-system-deps ausführen."
  fi
fi

# --- Systembenutzer anlegen ---------------------------------------------------
header "Systembenutzer anlegen"

if id "$SERVICE_USER" &>/dev/null; then
  ok "Benutzer '$SERVICE_USER' existiert bereits"
else
  info "Lege Systembenutzer '$SERVICE_USER' an..."
  useradd --system --no-create-home --shell /usr/sbin/nologin "$SERVICE_USER"
  ok "Benutzer '$SERVICE_USER' angelegt"
fi

SERVICE_HOME="$(getent passwd "$SERVICE_USER" | cut -d: -f6)"
if [[ -z "$SERVICE_HOME" || "$SERVICE_HOME" == "/" || "$SERVICE_HOME" == "/nonexistent" ]]; then
  SERVICE_HOME="/home/$SERVICE_USER"
fi
mkdir -p "$SERVICE_HOME"
chown "$SERVICE_USER:$SERVICE_USER" "$SERVICE_HOME" 2>/dev/null || true
chmod 755 "$SERVICE_HOME" 2>/dev/null || true
info "Service-Home für '$SERVICE_USER': $SERVICE_HOME"

for grp in cdrom optical disk video render; do
  if getent group "$grp" &>/dev/null; then
    usermod -aG "$grp" "$SERVICE_USER" 2>/dev/null || true
    info "Benutzer '$SERVICE_USER' zur Gruppe '$grp' hinzugefügt"
  fi
done

# --- Dienste vor Reinstall stoppen --------------------------------------------
if [[ "$REINSTALL" == true ]]; then
  header "Dienste vor Reinstall stoppen"
  stop_service_if_exists ripster-backend
  if [[ "$SKIP_NGINX" == false ]]; then
    stop_service_if_exists nginx
  fi
fi

# --- Repository klonen / aktualisieren ----------------------------------------
header "Repository holen (Git)"

# Prüfen ob der gewünschte Branch auf dem Remote existiert
info "Prüfe Branch '$GIT_BRANCH' auf Remote..."
branch_check_output=""
branch_check_status=0
if command_exists timeout; then
  branch_check_output=$(timeout --foreground "${GIT_COMMAND_TIMEOUT_SEC}" \
    git ls-remote --exit-code --heads "$REPO_URL" "$GIT_BRANCH" 2>&1) || branch_check_status=$?
else
  branch_check_output=$(git ls-remote --exit-code --heads "$REPO_URL" "$GIT_BRANCH" 2>&1) || branch_check_status=$?
fi

if [[ "$branch_check_status" -ne 0 ]]; then
  if [[ "$branch_check_status" -eq 124 ]]; then
    fatal "Timeout beim Prüfen des Branches '${GIT_BRANCH}' (${GIT_COMMAND_TIMEOUT_SEC}s)."
  fi
  if [[ "$branch_check_status" -eq 2 ]]; then
    if command_exists timeout; then
      available_branches=$(timeout --foreground "${GIT_COMMAND_TIMEOUT_SEC}" \
        git ls-remote --heads "$REPO_URL" 2>/dev/null | awk '{print $2}' | sed 's|refs/heads/||' | tr '\n' ' ')
    else
      available_branches=$(git ls-remote --heads "$REPO_URL" 2>/dev/null | awk '{print $2}' | sed 's|refs/heads/||' | tr '\n' ' ')
    fi
    fatal "Branch '$GIT_BRANCH' existiert nicht im Repository $REPO_URL.\nVerfügbare Branches: ${available_branches:-keine oder Remote nicht erreichbar}"
  fi
  fatal "Remote $REPO_URL ist nicht erreichbar.\nGit-Fehler: ${branch_check_output:-unbekannt}"
fi
ok "Branch '$GIT_BRANCH' gefunden"

if [[ -d "$INSTALL_DIR/.git" ]]; then
  if [[ "$REINSTALL" == true ]]; then
    info "Aktualisiere bestehendes Repository..."
    info "Sichere persistente Backend-Daten (ohne große Medienordner)..."
    backup_persistent_backend_data
    backup_and_remove_backend_src
    # safe.directory nötig wenn das Verzeichnis einem anderen User gehört
    # (z.B. ripster-Serviceuser nach erstem Install)
    git config --global --add safe.directory "$INSTALL_DIR" 2>/dev/null || true
    run_git_command "Setze Git-Remote-URL" \
      git -C "$INSTALL_DIR" remote set-url origin "$REPO_URL"
    run_git_command "Aktualisiere Remote-Branch-Mapping" \
      git -C "$INSTALL_DIR" remote set-branches origin '*'
    run_git_command "Hole Änderungen vom Remote" \
      git -C "$INSTALL_DIR" fetch --quiet origin
    run_git_command "Setze Arbeitsverzeichnis auf aktuellen Stand (HEAD)" \
      git -C "$INSTALL_DIR" reset --hard HEAD
    run_git_command "Checkout Branch '$GIT_BRANCH'" \
      git -C "$INSTALL_DIR" checkout --quiet -B "$GIT_BRANCH" "origin/$GIT_BRANCH"
    run_git_command "Setze Branch auf origin/$GIT_BRANCH" \
      git -C "$INSTALL_DIR" reset --hard "origin/$GIT_BRANCH"
    ok "Repository aktualisiert auf Branch '$GIT_BRANCH'"
  else
    fatal "$INSTALL_DIR enthält bereits ein Git-Repository.\nVerwende --reinstall um zu aktualisieren."
  fi
elif [[ -d "$INSTALL_DIR" && "$REINSTALL" == false ]]; then
  fatal "Verzeichnis $INSTALL_DIR existiert bereits (kein Git-Repo).\nBitte manuell entfernen oder --reinstall verwenden."
else
  info "Klone $REPO_URL (Branch: $GIT_BRANCH)..."
  git clone --quiet --branch "$GIT_BRANCH" --depth 1 "$REPO_URL" "$INSTALL_DIR"
  ok "Repository geklont nach $INSTALL_DIR"
fi

# Daten- und Log-Verzeichnisse sicherstellen
mkdir -p "$INSTALL_DIR/backend/data"
mkdir -p "$INSTALL_DIR/backend/logs"
mkdir -p "$INSTALL_DIR/backend/data/output/raw"
mkdir -p "$INSTALL_DIR/backend/data/output/movies"
mkdir -p "$INSTALL_DIR/backend/data/output/series"
mkdir -p "$INSTALL_DIR/backend/data/output/cd"
mkdir -p "$INSTALL_DIR/backend/data/downloads"
mkdir -p "$INSTALL_DIR/backend/data/logs"
mkdir -p "$INSTALL_DIR/backend/data/temp"

# Gesicherte Daten zurückspielen
if [[ -n "${DATA_BACKUP:-}" && -d "$DATA_BACKUP" ]]; then
  cp -a "$DATA_BACKUP/." "$INSTALL_DIR/backend/data/"
  ok "Datenbank wiederhergestellt"
fi

# Restore kann Altstrukturen zurückbringen – Default-Ausgabeordner danach
# erneut sicherstellen.
mkdir -p "$INSTALL_DIR/backend/data/output/raw"
mkdir -p "$INSTALL_DIR/backend/data/output/movies"
mkdir -p "$INSTALL_DIR/backend/data/output/series"
mkdir -p "$INSTALL_DIR/backend/data/output/cd"
mkdir -p "$INSTALL_DIR/backend/data/temp"

# --- npm-Abhängigkeiten installieren -----------------------------------------
header "npm-Abhängigkeiten installieren"

info "Root-Abhängigkeiten..."
npm install --prefix "$INSTALL_DIR" --omit=dev --silent

info "Backend-Abhängigkeiten..."
npm install --prefix "$INSTALL_DIR/backend" --omit=dev --silent

info "Frontend-Abhängigkeiten..."
npm install --prefix "$INSTALL_DIR/frontend" --silent

ok "npm-Abhängigkeiten installiert"

# --- Frontend bauen -----------------------------------------------------------
header "Frontend bauen"

info "Baue Frontend für $FRONTEND_HOST..."

# Relative URLs verwenden – funktioniert mit jedem Hostnamen/Domain, da nginx
# /api/ und /ws auf dem selben Host proxied. Absolute IP-URLs würden Chromes
# Private Network Access (PNA) Policy verletzen, wenn das Frontend über einen
# Domainnamen aufgerufen wird.
rm -f "$INSTALL_DIR/frontend/.env.production.local"

npm run build --prefix "$INSTALL_DIR/frontend" --silent
ok "Frontend gebaut: $INSTALL_DIR/frontend/dist"

# --- Backend-Konfiguration ---------------------------------------------------
header "Backend konfigurieren"

ENV_FILE="$INSTALL_DIR/backend/.env"

if [[ -f "$ENV_FILE" && "$REINSTALL" == true ]]; then
  warn "Bestehende .env bleibt erhalten (--reinstall)"
else
  info "Erstelle Backend .env..."
  cat > "$ENV_FILE" <<EOF
# Ripster Backend – Konfiguration
# Generiert von install.sh am $(date)

PORT=${BACKEND_PORT}
DB_PATH=./data/ripster.db
LOG_DIR=./logs
LOG_LEVEL=info

# CORS: Erlaube Anfragen vom Frontend (nginx)
CORS_ORIGIN=http://${FRONTEND_HOST}

# Standard-Ausgabepfade (Fallback wenn in den Einstellungen kein Pfad gesetzt)
DEFAULT_RAW_DIR=${INSTALL_DIR}/backend/data/output/raw
DEFAULT_MOVIE_DIR=${INSTALL_DIR}/backend/data/output/movies
DEFAULT_SERIES_DIR=${INSTALL_DIR}/backend/data/output/series
DEFAULT_CD_DIR=${INSTALL_DIR}/backend/data/output/cd
DEFAULT_DOWNLOAD_DIR=${INSTALL_DIR}/backend/data/downloads
DEFAULT_TEMP_DIR=${INSTALL_DIR}/backend/data/temp
EOF
  ok "Backend .env erstellt"
fi

# --- Berechtigungen setzen ---------------------------------------------------
chown -R "$SERVICE_USER:$SERVICE_USER" "$INSTALL_DIR"
chmod -R 755 "$INSTALL_DIR"
chmod 600 "$ENV_FILE"

# Ausgabe- und Log-Verzeichnisse dem installierenden User zuweisen
# (SUDO_USER = der echte User hinter sudo; leer wenn direkt als root ausgeführt)
ACTUAL_USER="${SUDO_USER:-}"
if [[ -n "$ACTUAL_USER" && "$ACTUAL_USER" != "root" ]]; then
  chown -R "$ACTUAL_USER:$SERVICE_USER" \
    "$INSTALL_DIR/backend/data/output" \
    "$INSTALL_DIR/backend/data/downloads" \
    "$INSTALL_DIR/backend/data/logs"
  chmod -R 775 \
    "$INSTALL_DIR/backend/data/output" \
    "$INSTALL_DIR/backend/data/downloads" \
    "$INSTALL_DIR/backend/data/logs"
  ok "Verzeichnisse $ACTUAL_USER:$SERVICE_USER (775) zugewiesen"
else
  ok "Verzeichnisse bereits $SERVICE_USER gehörig (kein SUDO_USER erkannt)"
fi

enforce_default_output_dirs_permissions
post_install_check_default_dirs

# MakeMKV erwartet pro Benutzer ein eigenes Konfigurationsverzeichnis.
# Laufzeit-relevant ist das Verzeichnis des Service-Users.
MAKEMKV_SERVICE_DIR="${SERVICE_HOME}/.MakeMKV"
if [[ ! -d "$MAKEMKV_SERVICE_DIR" ]]; then
  mkdir -p "$MAKEMKV_SERVICE_DIR"
  ok "MakeMKV-Verzeichnis erstellt: $MAKEMKV_SERVICE_DIR"
else
  info "MakeMKV-Verzeichnis vorhanden: $MAKEMKV_SERVICE_DIR"
fi
chown "$SERVICE_USER:$SERVICE_USER" "$MAKEMKV_SERVICE_DIR" 2>/dev/null || true
chmod 700 "$MAKEMKV_SERVICE_DIR" 2>/dev/null || true

# --- Systemd-Dienst: Backend -------------------------------------------------
header "Systemd-Dienst (Backend) erstellen"

generate_systemd_security

cat > /etc/systemd/system/ripster-backend.service <<EOF
[Unit]
Description=Ripster Backend API
After=network.target
Wants=network-online.target
StartLimitIntervalSec=60
StartLimitBurst=3

[Service]
Type=simple
User=${SERVICE_USER}
Group=${SERVICE_USER}
WorkingDirectory=${INSTALL_DIR}/backend
ExecStart=$(command -v node) src/index.js
Restart=on-failure
RestartSec=5

Environment=NODE_ENV=production
Environment=HOME=${SERVICE_HOME}
Environment=LANG=C.UTF-8
Environment=LC_ALL=C.UTF-8
Environment=LANGUAGE=C.UTF-8
EnvironmentFile=${INSTALL_DIR}/backend/.env

StandardOutput=journal
StandardError=journal
SyslogIdentifier=ripster-backend

${SERVICE_SECURITY}

[Install]
WantedBy=multi-user.target
EOF

ok "ripster-backend.service erstellt"

# --- nginx konfigurieren -----------------------------------------------------
if [[ "$SKIP_NGINX" == false ]]; then
  header "nginx konfigurieren"

  if [[ -f /etc/nginx/sites-available/ripster ]]; then
    patch_existing_ripster_nginx_site /etc/nginx/sites-available/ripster
  else
    cat > /etc/nginx/sites-available/ripster <<EOF
server {
    listen 80;
    server_name ${FRONTEND_HOST} _;
    client_max_body_size 8G;

    root ${INSTALL_DIR}/frontend/dist;
    index index.html;

    location / {
        try_files \$uri \$uri/ /index.html;
    }

    location /api/ {
        proxy_pass http://127.0.0.1:${BACKEND_PORT};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
        proxy_connect_timeout 60s;
        proxy_request_buffering off;
    }

    location /ws {
        proxy_pass http://127.0.0.1:${BACKEND_PORT}/ws;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}
EOF
  fi

  rm -f /etc/nginx/sites-enabled/default
  ln -sf /etc/nginx/sites-available/ripster /etc/nginx/sites-enabled/ripster

  nginx -t && ok "nginx-Konfiguration gültig" || fatal "nginx-Konfiguration fehlerhaft!"
fi

# --- Dienste starten ----------------------------------------------------------
header "Dienste starten"

systemctl daemon-reload

systemctl enable ripster-backend
systemctl restart ripster-backend
sleep 2

if systemctl is-active --quiet ripster-backend; then
  ok "ripster-backend läuft"
else
  error "ripster-backend konnte nicht gestartet werden!"
  journalctl -u ripster-backend -n 30 --no-pager
  exit 1
fi

sync_makemkv_beta_key

if [[ "$SKIP_NGINX" == false ]]; then
  systemctl enable nginx
  systemctl restart nginx
  if systemctl is-active --quiet nginx; then
    ok "nginx läuft"
  else
    error "nginx konnte nicht gestartet werden!"
    journalctl -u nginx -n 20 --no-pager
  fi
fi

# --- Zusammenfassung ----------------------------------------------------------
header "Installation abgeschlossen!"

echo ""
echo -e "  ${GREEN}${BOLD}Ripster ist installiert und läuft.${RESET}"
echo ""
if [[ "$SKIP_NGINX" == false ]]; then
  echo -e "  ${BOLD}Weboberfläche:${RESET}  http://${FRONTEND_HOST}"
else
  echo -e "  ${BOLD}Backend API:${RESET}    http://${FRONTEND_HOST}:${BACKEND_PORT}/api"
  warn "nginx deaktiviert – Frontend nicht automatisch erreichbar."
fi
echo ""
echo -e "  ${BOLD}Dienste verwalten:${RESET}"
echo -e "    sudo systemctl status  ripster-backend"
echo -e "    sudo systemctl restart ripster-backend"
echo -e "    sudo systemctl stop    ripster-backend"
echo -e "    sudo journalctl -u ripster-backend -f"
echo ""
echo -e "  ${BOLD}Konfiguration:${RESET}  $INSTALL_DIR/backend/.env"
echo -e "  ${BOLD}Datenbank:${RESET}      $INSTALL_DIR/backend/data/ripster.db"
echo -e "  ${BOLD}Logs:${RESET}           $INSTALL_DIR/backend/logs/"
echo -e "  ${BOLD}Aktualisieren:${RESET}  sudo bash $INSTALL_DIR/install.sh --reinstall"
echo ""

missing_tools=()
command_exists makemkvcon   || missing_tools+=("makemkvcon")
command_exists HandBrakeCLI || missing_tools+=("HandBrakeCLI")
command_exists mediainfo    || missing_tools+=("mediainfo")
command_exists cdparanoia   || missing_tools+=("cdparanoia")
command_exists flac         || missing_tools+=("flac")
command_exists lame         || missing_tools+=("lame")
command_exists opusenc      || missing_tools+=("opusenc")
command_exists oggenc       || missing_tools+=("oggenc")

if [[ ${#missing_tools[@]} -gt 0 ]]; then
  echo -e "  ${YELLOW}${BOLD}Hinweis:${RESET} Folgende Tools fehlen noch:"
  for t in "${missing_tools[@]}"; do
    echo -e "    ${YELLOW}✗${RESET} $t"
  done
  echo -e "  Diese können in den Ripster-Einstellungen konfiguriert werden."
fi

echo ""
