#!/usr/bin/env bash
# =============================================================================
#  Ripster – Installationsskript
#  Unterstützt: Debian 11/12, Ubuntu 22.04/24.04
#  Benötigt: sudo / root
#
#  Verwendung:
#    chmod +x install.sh
#    sudo ./install.sh [Optionen]
#
#  Optionen:
#    --dir <pfad>          Installationsverzeichnis (Standard: /opt/ripster)
#    --user <benutzer>     Systembenutzer für den Dienst (Standard: ripster)
#    --port <port>         Backend-Port (Standard: 3001)
#    --host <hostname>     Hostname/IP für die Weboberfläche (Standard: Maschinen-IP)
#    --no-makemkv          MakeMKV-Installation überspringen
#    --no-handbrake        HandBrake-Installation überspringen
#    --build-handbrake     HandBrake aus Quellcode mit NVDEC-Unterstützung bauen
#    --handbrake-version   HandBrake-Version für Source-Build (Standard: 1.9.0)
#    --no-nginx            Nginx-Einrichtung überspringen (Frontend läuft dann auf Port 5173)
#    --reinstall           Vorhandene Installation ersetzen (Daten bleiben erhalten)
#    -h, --help            Diese Hilfe anzeigen
# =============================================================================
set -euo pipefail

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
INSTALL_DIR="/opt/ripster"
SERVICE_USER="ripster"
BACKEND_PORT="3001"
FRONTEND_HOST=""        # wird automatisch ermittelt, wenn leer
SKIP_MAKEMKV=false
SKIP_HANDBRAKE=false
BUILD_HANDBRAKE_NVDEC=false
HANDBRAKE_VERSION="1.9.0"
SKIP_NGINX=false
REINSTALL=false
SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# --- Argumente parsen ---------------------------------------------------------
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dir)                INSTALL_DIR="$2"; shift 2 ;;
    --user)               SERVICE_USER="$2"; shift 2 ;;
    --port)               BACKEND_PORT="$2"; shift 2 ;;
    --host)               FRONTEND_HOST="$2"; shift 2 ;;
    --no-makemkv)         SKIP_MAKEMKV=true; shift ;;
    --no-handbrake)       SKIP_HANDBRAKE=true; shift ;;
    --build-handbrake)    BUILD_HANDBRAKE_NVDEC=true; shift ;;
    --handbrake-version)  HANDBRAKE_VERSION="$2"; shift 2 ;;
    --no-nginx)           SKIP_NGINX=true; shift ;;
    --reinstall)          REINSTALL=true; shift ;;
    -h|--help)
      sed -n '/^#  Verwendung/,/^# ====/p' "$0" | head -n -1 | sed 's/^#  \?//'
      exit 0 ;;
    *) fatal "Unbekannte Option: $1" ;;
  esac
done

# --- Voraussetzungen prüfen ---------------------------------------------------
header "Ripster Installationsskript"

if [[ $EUID -ne 0 ]]; then
  fatal "Dieses Skript muss als root ausgeführt werden (sudo ./install.sh)"
fi

# OS-Erkennung
if [[ ! -f /etc/os-release ]]; then
  fatal "Betriebssystem nicht erkennbar. Nur Debian/Ubuntu wird unterstützt."
fi
. /etc/os-release
case "$ID" in
  debian|ubuntu|linuxmint|pop) ok "Betriebssystem: $PRETTY_NAME" ;;
  *) fatal "Nicht unterstütztes OS: $ID. Nur Debian/Ubuntu unterstützt." ;;
esac

# Host-IP ermitteln
if [[ -z "$FRONTEND_HOST" ]]; then
  FRONTEND_HOST=$(hostname -I | awk '{print $1}')
  info "Erkannte IP: $FRONTEND_HOST"
fi

# Quelldirectory prüfen
[[ -f "$SOURCE_DIR/backend/package.json" ]] || \
  fatal "Ripster-Quellen nicht gefunden in: $SOURCE_DIR"

info "Quellverzeichnis:      $SOURCE_DIR"
info "Installationsverzeichnis: $INSTALL_DIR"
info "Systembenutzer:        $SERVICE_USER"
info "Backend-Port:          $BACKEND_PORT"
info "Frontend-Host:         $FRONTEND_HOST"

# --- Hilfsfunktionen ----------------------------------------------------------

command_exists() { command -v "$1" &>/dev/null; }

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

install_makemkv() {
  header "MakeMKV installieren"

  if command_exists makemkvcon; then
    ok "makemkvcon bereits installiert ($(makemkvcon --version 2>&1 | head -1))"
    return
  fi

  info "Installiere Build-Abhängigkeiten für MakeMKV..."
  apt-get install -y \
    build-essential pkg-config libc6-dev libssl-dev \
    libexpat1-dev libavcodec-dev libgl1-mesa-dev \
    qtbase5-dev zlib1g-dev wget

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
    info "Gefundene Version: $makemkv_version"
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
  mkdir -p tmp && echo "accepted" > tmp/eula_accepted
  make -j"$(nproc)"
  make install

  cd /
  rm -rf "$tmp_dir"
  ok "MakeMKV $makemkv_version installiert"
  warn "Hinweis: MakeMKV benötigt eine Lizenz oder den Beta-Key."
  warn "Beta-Key: https://www.makemkv.com/forum/viewtopic.php?t=1053"
}

remove_all_handbrake() {
  info "Entferne alle vorhandenen HandBrake-Installationen..."
  apt-get remove -y handbrake-cli handbrake 2>/dev/null || true
  snap remove handbrake-cli 2>/dev/null || true
  rm -f /usr/bin/HandBrakeCLI \
        /usr/local/bin/HandBrakeCLI \
        /snap/bin/handbrake-cli \
        /snap/bin/HandBrakeCLI
  while true; do
    local found
    found=$(command -v HandBrakeCLI 2>/dev/null || true)
    [[ -z "$found" ]] && break
    warn "Entferne: $found"
    rm -f "$found"
  done
  hash -r 2>/dev/null || true
  ok "Alte HandBrake-Installation(en) entfernt"
}

build_handbrake_nvdec() {
  header "HandBrake ${HANDBRAKE_VERSION} mit NVDEC aus Quellcode bauen"

  local tmp_dir
  tmp_dir=$(mktemp -d)
  local src_url="https://github.com/HandBrake/HandBrake/releases/download/${HANDBRAKE_VERSION}/HandBrake-${HANDBRAKE_VERSION}-source.tar.bz2"
  local tarball="${tmp_dir}/handbrake-src.tar.bz2"

  # Alte Installationen vollständig entfernen
  remove_all_handbrake

  # Build-Abhängigkeiten
  info "Installiere Build-Abhängigkeiten..."
  apt-get install -y \
    autoconf automake build-essential cmake git \
    libass-dev libbz2-dev libdvdnav-dev libdvdread-dev \
    libfontconfig-dev libfreetype-dev libfribidi-dev libharfbuzz-dev \
    libjansson-dev liblzma-dev libmp3lame-dev libnuma-dev libogg-dev \
    libopus-dev libsamplerate0-dev libspeex-dev libtheora-dev libtool \
    libturbojpeg0-dev libvorbis-dev libvpx-dev libx264-dev libxml2-dev \
    m4 meson nasm ninja-build patch pkg-config python3 tar zlib1g-dev \
    >/dev/null

  # CUDA Toolkit für NVDEC-Header
  info "Installiere CUDA Toolkit (für NVDEC-Header)..."
  if ! dpkg -l 2>/dev/null | grep -q '^ii.*nvidia-cuda-toolkit'; then
    apt-get install -y nvidia-cuda-toolkit >/dev/null 2>&1 || {
      warn "nvidia-cuda-toolkit nicht verfügbar – versuche Fallback-Header..."
      local cuda_keyring="/tmp/cuda-keyring.deb"
      local ubuntu_ver="${VERSION_ID//./}"
      curl -fsSL "https://developer.download.nvidia.com/compute/cuda/repos/ubuntu${ubuntu_ver}/x86_64/cuda-keyring_1.1-1_all.deb" \
        -o "$cuda_keyring" 2>/dev/null && \
        dpkg -i "$cuda_keyring" 2>/dev/null && \
        apt-get update -qq && \
        apt-get install -y cuda-cudart-dev-12-8 >/dev/null 2>&1 || \
        warn "CUDA-Header konnten nicht installiert werden – NVDEC wird möglicherweise nicht verfügbar sein."
    }
  fi
  ok "Build-Abhängigkeiten installiert"

  # Quellcode herunterladen
  info "Lade HandBrake ${HANDBRAKE_VERSION} herunter..."
  curl -fsSL "$src_url" -o "$tarball" 2>/dev/null || \
    wget -q "$src_url" -O "$tarball" || \
    fatal "HandBrake-Quellcode konnte nicht heruntergeladen werden (${src_url})"

  info "Entpacke Quellcode..."
  tar xjf "$tarball" -C "$tmp_dir"
  local src_dir="${tmp_dir}/HandBrake-${HANDBRAKE_VERSION}"
  [[ -d "$src_dir" ]] || src_dir=$(find "$tmp_dir" -maxdepth 1 -type d -name "HandBrake*" | head -1)
  [[ -d "$src_dir" ]] || fatal "HandBrake-Quellverzeichnis nicht gefunden in $tmp_dir"

  cd "$src_dir"

  info "Konfiguriere HandBrake mit NVDEC..."
  ./configure --launch-jobs="$(nproc)" --enable-nvdec --prefix=/usr/local 2>&1 | tail -10

  info "Baue HandBrake ($(nproc) Threads – bitte warten)..."
  make --directory=build -j"$(nproc)"

  info "Installiere HandBrake nach /usr/local/bin..."
  make --directory=build install

  cd /
  rm -rf "$tmp_dir"

  if command_exists HandBrakeCLI; then
    local ver
    ver=$(HandBrakeCLI --version 2>&1 | head -1)
    ok "HandBrakeCLI mit NVDEC installiert: ${ver}"
    if ldconfig -p 2>/dev/null | grep -q libnvcuvid; then
      ok "libnvcuvid gefunden – NVDEC ist zur Laufzeit verfügbar."
    else
      warn "libnvcuvid NICHT gefunden. NVDEC benötigt den installierten NVIDIA-Treiber."
    fi
  else
    fatal "HandBrakeCLI nach dem Build nicht gefunden – Build fehlgeschlagen."
  fi
}

has_nvidia_gpu() {
  [[ -e /dev/nvidia0 ]] && return 0
  command_exists nvidia-smi && nvidia-smi &>/dev/null && return 0
  command_exists lspci && lspci 2>/dev/null | grep -qi "nvidia" && return 0
  return 1
}

install_handbrake() {
  header "HandBrake CLI installieren"

  # NVIDIA-GPU vorhanden? → immer NVDEC-Build erzwingen
  if has_nvidia_gpu; then
    info "NVIDIA-GPU erkannt – HandBrake wird mit NVDEC aus Quellcode gebaut."
    BUILD_HANDBRAKE_NVDEC=true
  fi

  # --build-handbrake oder NVIDIA erkannt: aus Quellcode mit NVDEC bauen
  if [[ "$BUILD_HANDBRAKE_NVDEC" == true ]]; then
    build_handbrake_nvdec
    return
  fi

  # Bereits installiert → nichts tun
  if command_exists HandBrakeCLI; then
    local ver
    ver=$(HandBrakeCLI --version 2>&1 | head -1)
    ok "HandBrakeCLI bereits installiert: ${ver}"
    return
  fi

  # Strategie 1: direkt aus den Distro-Repos (Ubuntu Universe / Debian)
  info "Versuche HandBrake CLI aus den Standard-Repos..."
  if apt-get install -y handbrake-cli 2>/dev/null; then
    ok "HandBrakeCLI installiert (Standard-Repos)"
    return
  fi

  case "$ID" in
    ubuntu)
      local codename="${VERSION_CODENAME:-jammy}"
      local ppa_sources="/etc/apt/sources.list.d/handbrake.list"
      local ppa_key="/etc/apt/keyrings/handbrake.gpg"

      info "Füge HandBrake PPA manuell hinzu (${codename})..."
      mkdir -p /etc/apt/keyrings

      if curl -fsSL "https://keyserver.ubuntu.com/pks/lookup?op=get&search=0x8771ADB0816950D8" \
          | gpg --dearmor -o "$ppa_key" 2>/dev/null; then
        cat > "$ppa_sources" <<EOF
deb [signed-by=${ppa_key}] https://ppa.launchpadcontent.net/stebbins/handbrake-releases/ubuntu ${codename} main
EOF
        apt_update
        apt-get install -y handbrake-cli 2>/dev/null && \
          { ok "HandBrakeCLI installiert (PPA)"; return; } || \
          { warn "PPA-Installation fehlgeschlagen, räume auf...";
            rm -f "$ppa_key" "$ppa_sources"; }
      else
        warn "PPA-Key konnte nicht geladen werden."
      fi

      if command_exists snap; then
        info "Versuche HandBrake via snap..."
        if snap install handbrake-cli 2>/dev/null; then
          ok "HandBrakeCLI installiert (snap)"
          return
        fi
      fi
      ;;

    debian)
      info "Versuche HandBrake CLI über Debian Backports..."
      if ! find /etc/apt/sources.list.d/ -name "*.list" -exec grep -l "backports" {} \; 2>/dev/null | grep -q .; then
        echo "deb http://deb.debian.org/debian ${VERSION_CODENAME}-backports main" \
          > /etc/apt/sources.list.d/backports.list
        apt_update
      fi
      apt-get install -y -t "${VERSION_CODENAME}-backports" handbrake-cli 2>/dev/null && \
        { ok "HandBrakeCLI installiert (Backports)"; return; }
      ;;
  esac

  warn "HandBrake CLI konnte nicht automatisch installiert werden."
  warn "Für einen NVDEC-Build: sudo bash install-dev.sh --no-makemkv --no-nginx --build-handbrake"
  warn "Oder manuell: https://handbrake.fr/downloads2.php"
}

# --- apt-Hilfsfunktionen ------------------------------------------------------

apt_update() {
  local output
  if output=$(apt-get update 2>&1); then
    return 0
  fi

  if echo "$output" | grep -q "no longer has a Release file\|does not have a Release file"; then
    warn "apt-Sources fehlerhaft. Versuche Reparatur..."

    if apt-get update --allow-releaseinfo-change -qq 2>/dev/null; then
      ok "apt-Update mit --allow-releaseinfo-change erfolgreich"
      return 0
    fi

    if [[ -n "${VERSION_CODENAME:-}" ]]; then
      warn "Schreibe minimale sources.list für $VERSION_CODENAME..."
      local main_list=/etc/apt/sources.list
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

# --- Systemabhängigkeiten -----------------------------------------------------
header "Systemabhängigkeiten installieren"

info "Paketlisten aktualisieren..."
apt_update

info "Installiere Basispakete..."
apt-get install -y \
  curl wget git \
  mediainfo \
  util-linux udev \
  ca-certificates gnupg \
  lsb-release

ok "Basispakete installiert"

# Node.js
install_node

# MakeMKV
if [[ "$SKIP_MAKEMKV" == false ]]; then
  install_makemkv
else
  warn "MakeMKV-Installation übersprungen (--no-makemkv)"
fi

# HandBrake
if [[ "$SKIP_HANDBRAKE" == false ]]; then
  install_handbrake
else
  warn "HandBrake-Installation übersprungen (--no-handbrake)"
fi

# Nginx
if [[ "$SKIP_NGINX" == false ]]; then
  if ! command_exists nginx; then
    info "Installiere nginx..."
    apt-get install -y nginx
  fi
  ok "nginx installiert"
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

# Optisches Laufwerk: Benutzer zur cdrom/optical-Gruppe hinzufügen
for grp in cdrom optical disk; do
  if getent group "$grp" &>/dev/null; then
    usermod -aG "$grp" "$SERVICE_USER" 2>/dev/null || true
    info "Benutzer '$SERVICE_USER' zur Gruppe '$grp' hinzugefügt"
  fi
done

# --- Dateien kopieren ---------------------------------------------------------
header "Ripster-Dateien installieren"

if [[ -d "$INSTALL_DIR" && "$REINSTALL" == false ]]; then
  fatal "Verzeichnis $INSTALL_DIR existiert bereits.\nVerwende --reinstall um zu überschreiben (Daten bleiben erhalten)."
fi

# Bei Reinstall: Daten sichern
if [[ -d "$INSTALL_DIR/backend/data" ]]; then
  info "Sichere vorhandene Datenbank..."
  cp -a "$INSTALL_DIR/backend/data" "/tmp/ripster-data-backup-$(date +%Y%m%d%H%M%S)"
  ok "Datenbank gesichert"
fi

info "Kopiere Quellen nach $INSTALL_DIR..."
mkdir -p "$INSTALL_DIR"

rsync -a --delete \
  --exclude='.git' \
  --exclude='node_modules' \
  --exclude='backend/node_modules' \
  --exclude='frontend/node_modules' \
  --exclude='backend/data' \
  --exclude='backend/logs' \
  --exclude='frontend/dist' \
  --exclude='*.sh' \
  --exclude='deploy-ripster.sh' \
  --exclude='debug/' \
  --exclude='site/' \
  --exclude='docs/' \
  "$SOURCE_DIR/" "$INSTALL_DIR/"

# Datenbank-/Log-Verzeichnisse anlegen
mkdir -p "$INSTALL_DIR/backend/data"
mkdir -p "$INSTALL_DIR/backend/logs"

# Bei Reinstall: Daten wiederherstellen
if [[ -d "$INSTALL_DIR/../ripster-data-backup" ]]; then
  cp -a /tmp/ripster-data-backup-*/ "$INSTALL_DIR/backend/data/" 2>/dev/null || true
fi

ok "Dateien kopiert"

# --- npm-Abhängigkeiten installieren -----------------------------------------
header "npm-Abhängigkeiten installieren"

info "Installiere Root-Abhängigkeiten..."
npm install --prefix "$INSTALL_DIR" --omit=dev --silent

info "Installiere Backend-Abhängigkeiten..."
npm install --prefix "$INSTALL_DIR/backend" --omit=dev --silent

info "Installiere Frontend-Abhängigkeiten..."
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

if [[ -f "$ENV_FILE" && "$REINSTALL" == false ]]; then
  warn "Backend .env existiert bereits – wird nicht überschrieben"
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
EOF
  ok "Backend .env erstellt"
fi

# --- Berechtigungen setzen ---------------------------------------------------
chown -R "$SERVICE_USER:$SERVICE_USER" "$INSTALL_DIR"
chmod -R 755 "$INSTALL_DIR"
chmod 600 "$ENV_FILE"

# --- Systemd-Dienst: Backend -------------------------------------------------
header "Systemd-Dienst (Backend) erstellen"

cat > /etc/systemd/system/ripster-backend.service <<EOF
[Unit]
Description=Ripster Backend API
Documentation=https://github.com/your-repo/ripster
After=network.target
Wants=network-online.target

[Service]
Type=simple
User=${SERVICE_USER}
Group=${SERVICE_USER}
WorkingDirectory=${INSTALL_DIR}/backend
ExecStart=$(command -v node) src/index.js
Restart=on-failure
RestartSec=5
StartLimitIntervalSec=60
StartLimitBurst=3

# Umgebung
Environment=NODE_ENV=production
EnvironmentFile=${INSTALL_DIR}/backend/.env

# Logging
StandardOutput=journal
StandardError=journal
SyslogIdentifier=ripster-backend

# Sicherheit
NoNewPrivileges=true
ProtectSystem=full
ProtectHome=read-only
ReadWritePaths=${INSTALL_DIR}/backend/data ${INSTALL_DIR}/backend/logs /tmp
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF

ok "ripster-backend.service erstellt"

# --- nginx konfigurieren -----------------------------------------------------
if [[ "$SKIP_NGINX" == false ]]; then
  header "nginx konfigurieren"

  cat > /etc/nginx/sites-available/ripster <<EOF
server {
    listen 80;
    server_name ${FRONTEND_HOST} _;

    # Frontend (statische Dateien)
    root ${INSTALL_DIR}/frontend/dist;
    index index.html;

    # SPA: alle unbekannten Pfade → index.html
    location / {
        try_files \$uri \$uri/ /index.html;
    }

    # API → Backend
    location /api/ {
        proxy_pass http://127.0.0.1:${BACKEND_PORT};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_read_timeout 300s;
        proxy_connect_timeout 10s;
    }

    # WebSocket → Backend
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

  # Alte Default-Seite deaktivieren, Ripster aktivieren
  rm -f /etc/nginx/sites-enabled/default
  ln -sf /etc/nginx/sites-available/ripster /etc/nginx/sites-enabled/ripster

  nginx -t && ok "nginx-Konfiguration gültig" || fatal "nginx-Konfiguration fehlerhaft!"

  ok "nginx konfiguriert"
fi

# --- Dienste aktivieren und starten ------------------------------------------
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
echo ""

# Warnungen zu fehlenden Tools
missing_tools=()
command_exists makemkvcon  || missing_tools+=("makemkvcon")
command_exists HandBrakeCLI || missing_tools+=("HandBrakeCLI")
command_exists mediainfo   || missing_tools+=("mediainfo")

if [[ ${#missing_tools[@]} -gt 0 ]]; then
  echo -e "  ${YELLOW}${BOLD}Hinweis:${RESET} Folgende Tools fehlen noch:"
  for t in "${missing_tools[@]}"; do
    echo -e "    ${YELLOW}✗${RESET} $t"
  done
  echo -e "  Diese können in den Ripster-Einstellungen konfiguriert werden."
fi

echo ""
