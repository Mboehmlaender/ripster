#!/usr/bin/env bash
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
#    --reinstall           Vorhandene Installation aktualisieren (Daten bleiben erhalten)
#    -h, --help            Diese Hilfe anzeigen
# =============================================================================
set -euo pipefail

REPO_URL="https://github.com/Mboehmlaender/ripster.git"
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
GIT_BRANCH="cd-ripping"
INSTALL_DIR="/opt/ripster"
SERVICE_USER="ripster"
BACKEND_PORT="3001"
FRONTEND_HOST=""
SKIP_MAKEMKV=false
SKIP_HANDBRAKE=false
HANDBRAKE_INSTALL_MODE=""
SKIP_NGINX=false
REINSTALL=false

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
  mkdir -p tmp && echo "accepted" > tmp/eula_accepted
  make -j"$(nproc)"
  make install

  cd /
  rm -rf "$tmp_dir"
  ok "MakeMKV $makemkv_version installiert"
  warn "Hinweis: MakeMKV benötigt eine Lizenz oder den Beta-Key."
  warn "Beta-Key: https://www.makemkv.com/forum/viewtopic.php?t=1053"
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

install_handbrake_gpu_bundled() {
  info "Installiere gebündeltes HandBrakeCLI mit NVDEC..."

  if [[ ! -f "$BUNDLED_HANDBRAKE_CLI" ]]; then
    fatal "Bundled Binary fehlt: ./bin/HandBrakeCLI (aufgelöst zu: $BUNDLED_HANDBRAKE_CLI)"
  fi

  install -m 0755 "$BUNDLED_HANDBRAKE_CLI" /usr/local/bin/HandBrakeCLI
  hash -r 2>/dev/null || true

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

# --- HandBrake-Installmodus auswählen ----------------------------------------
select_handbrake_mode

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

# --- Repository klonen / aktualisieren ----------------------------------------
header "Repository holen (Git)"

# Prüfen ob der gewünschte Branch auf dem Remote existiert
info "Prüfe Branch '$GIT_BRANCH' auf Remote..."
if ! git ls-remote --exit-code --heads "$REPO_URL" "$GIT_BRANCH" &>/dev/null; then
  fatal "Branch '$GIT_BRANCH' existiert nicht im Repository $REPO_URL.\nVerfügbare Branches: $(git ls-remote --heads "$REPO_URL" | awk '{print $2}' | sed 's|refs/heads/||' | tr '\n' ' ')"
fi
ok "Branch '$GIT_BRANCH' gefunden"

if [[ -d "$INSTALL_DIR/.git" ]]; then
  if [[ "$REINSTALL" == true ]]; then
    info "Aktualisiere bestehendes Repository..."
    # Daten sichern
    if [[ -d "$INSTALL_DIR/backend/data" ]]; then
      DATA_BACKUP="/tmp/ripster-data-backup-$(date +%Y%m%d%H%M%S)"
      cp -a "$INSTALL_DIR/backend/data" "$DATA_BACKUP"
      info "Datenbank gesichert nach: $DATA_BACKUP"
    fi
    # safe.directory nötig wenn das Verzeichnis einem anderen User gehört
    # (z.B. ripster-Serviceuser nach erstem Install)
    git config --global --add safe.directory "$INSTALL_DIR" 2>/dev/null || true
    git -C "$INSTALL_DIR" remote set-branches origin '*'
    git -C "$INSTALL_DIR" fetch --quiet origin
    git -C "$INSTALL_DIR" reset --hard HEAD
    git -C "$INSTALL_DIR" checkout --quiet -B "$GIT_BRANCH" "origin/$GIT_BRANCH"
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
mkdir -p "$INSTALL_DIR/backend/data/output/cd"
mkdir -p "$INSTALL_DIR/backend/data/logs"

# Gesicherte Daten zurückspielen
if [[ -n "${DATA_BACKUP:-}" && -d "$DATA_BACKUP" ]]; then
  cp -a "$DATA_BACKUP/." "$INSTALL_DIR/backend/data/"
  ok "Datenbank wiederhergestellt"
fi

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
    "$INSTALL_DIR/backend/data/logs"
  chmod -R 775 \
    "$INSTALL_DIR/backend/data/output" \
    "$INSTALL_DIR/backend/data/logs"
  ok "Verzeichnisse $ACTUAL_USER:$SERVICE_USER (775) zugewiesen"
else
  ok "Verzeichnisse bereits $SERVICE_USER gehörig (kein SUDO_USER erkannt)"
fi

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

cat > /etc/systemd/system/ripster-backend.service <<EOF
[Unit]
Description=Ripster Backend API
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

Environment=NODE_ENV=production
Environment=HOME=${SERVICE_HOME}
Environment=LANG=C.UTF-8
Environment=LC_ALL=C.UTF-8
Environment=LANGUAGE=C.UTF-8
EnvironmentFile=${INSTALL_DIR}/backend/.env

StandardOutput=journal
StandardError=journal
SyslogIdentifier=ripster-backend

# Kein statisches DeviceAllow: Device-Pfade unterscheiden sich je nach Host/Container.
# Damit Ripster auf unterschiedlichen Systemen funktioniert, kein Device-Cgroup-Filter.
DevicePolicy=auto
SupplementaryGroups=video render cdrom disk

# Für Skriptausführung via GUI (inkl. optionalem sudo in User-Skripten)
# darf no_new_privileges nicht aktiv sein.
NoNewPrivileges=false
ProtectSystem=full
ProtectHome=read-only
ReadWritePaths=${INSTALL_DIR}/backend/data ${INSTALL_DIR}/backend/logs /tmp ${SERVICE_HOME} ${MAKEMKV_SERVICE_DIR}
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
        proxy_read_timeout 300s;
        proxy_connect_timeout 10s;
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
