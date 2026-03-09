#!/usr/bin/env bash
# =============================================================================
#  HandBrake mit NVDEC aus Quellcode bauen
#  Ubuntu 22.04 / 24.04, Debian 11 / 12
#
#  Verwendung:
#    sudo bash build-handbrake-nvdec.sh [--version 1.9.0]
#
#  NVDEC benötigt zur Laufzeit den NVIDIA-Treiber (libnvcuvid.so).
# =============================================================================
set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; BOLD='\033[1m'; RESET='\033[0m'
info()   { echo -e "${BLUE}[INFO]${RESET}  $*"; }
ok()     { echo -e "${GREEN}[OK]${RESET}    $*"; }
warn()   { echo -e "${YELLOW}[WARN]${RESET}  $*"; }
fatal()  { echo -e "${RED}[FEHLER]${RESET} $*" >&2; exit 1; }

HANDBRAKE_VERSION="1.9.0"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --version) HANDBRAKE_VERSION="$2"; shift 2 ;;
    -h|--help) echo "Verwendung: sudo bash $0 [--version X.Y.Z]"; exit 0 ;;
    *) fatal "Unbekannte Option: $1" ;;
  esac
done

[[ $EUID -eq 0 ]] || fatal "Bitte als root ausführen: sudo bash $0"

[[ -f /etc/os-release ]] && . /etc/os-release || fatal "OS nicht erkennbar"

echo -e "\n${BOLD}${BLUE}══════════════════════════════════════════${RESET}"
echo -e "${BOLD}  HandBrake ${HANDBRAKE_VERSION} mit NVDEC bauen${RESET}"
echo -e "${BOLD}${BLUE}══════════════════════════════════════════${RESET}\n"

# --------------------------------------------------------------------------
# 1. Build-Abhängigkeiten
# --------------------------------------------------------------------------
info "Installiere Build-Abhängigkeiten..."
apt-get update -qq
apt-get install -y \
  autoconf automake build-essential cmake git \
  libass-dev libbz2-dev libdvdnav-dev libdvdread-dev \
  libfontconfig-dev libfreetype-dev libfribidi-dev libharfbuzz-dev \
  libjansson-dev liblzma-dev libmp3lame-dev libnuma-dev libogg-dev \
  libopus-dev libsamplerate0-dev libspeex-dev libtheora-dev libtool \
  libturbojpeg0-dev libvorbis-dev libvpx-dev libx264-dev libxml2-dev \
  m4 meson nasm ninja-build patch pkg-config python3 tar zlib1g-dev \
  >/dev/null
ok "Build-Abhängigkeiten installiert"

# --------------------------------------------------------------------------
# 2. CUDA-Header für NVDEC
# --------------------------------------------------------------------------
info "Prüfe CUDA-Header für NVDEC-Support..."
if dpkg -l 2>/dev/null | grep -q '^ii.*nvidia-cuda-toolkit'; then
  ok "nvidia-cuda-toolkit bereits installiert"
else
  info "Installiere nvidia-cuda-toolkit (für NVDEC-Header)..."
  if apt-get install -y nvidia-cuda-toolkit >/dev/null 2>&1; then
    ok "nvidia-cuda-toolkit installiert"
  else
    warn "nvidia-cuda-toolkit nicht in Standard-Repos – versuche NVIDIA CUDA Repo..."
    local_ver="${VERSION_ID//./}"
    cuda_deb="/tmp/cuda-keyring.deb"
    if curl -fsSL \
      "https://developer.download.nvidia.com/compute/cuda/repos/ubuntu${local_ver}/x86_64/cuda-keyring_1.1-1_all.deb" \
      -o "$cuda_deb" 2>/dev/null; then
      dpkg -i "$cuda_deb"
      apt-get update -qq
      # Minimale Header statt vollem Toolkit
      apt-get install -y cuda-cudart-dev-12-8 >/dev/null 2>&1 && \
        ok "CUDA-Header installiert (cuda-cudart-dev-12-8)" || \
        warn "CUDA-Header-Installation fehlgeschlagen – NVDEC könnte im Build fehlen."
    else
      warn "NVIDIA CUDA Repo nicht erreichbar – NVDEC könnte im Build fehlen."
    fi
  fi
fi

# --------------------------------------------------------------------------
# 3. Alle vorhandenen HandBrake-Installationen entfernen
# --------------------------------------------------------------------------
info "Entferne alle vorhandenen HandBrake-Installationen..."
apt-get remove -y handbrake-cli handbrake 2>/dev/null || true
snap remove handbrake-cli 2>/dev/null || true
rm -f /usr/bin/HandBrakeCLI \
      /usr/local/bin/HandBrakeCLI \
      /snap/bin/handbrake-cli \
      /snap/bin/HandBrakeCLI
while true; do
  FOUND=$(command -v HandBrakeCLI 2>/dev/null || true)
  [[ -z "$FOUND" ]] && break
  warn "Entferne: $FOUND"
  rm -f "$FOUND"
done
hash -r 2>/dev/null || true
ok "Alte HandBrake-Installation(en) entfernt"

# --------------------------------------------------------------------------
# 4. Quellcode herunterladen
# --------------------------------------------------------------------------
TMP_DIR=$(mktemp -d)
trap 'cd /; rm -rf "$TMP_DIR"' EXIT

SRC_URL="https://github.com/HandBrake/HandBrake/releases/download/${HANDBRAKE_VERSION}/HandBrake-${HANDBRAKE_VERSION}-source.tar.bz2"
TARBALL="${TMP_DIR}/handbrake-src.tar.bz2"

info "Lade HandBrake ${HANDBRAKE_VERSION} herunter..."
info "URL: ${SRC_URL}"
curl -fL --progress-bar "$SRC_URL" -o "$TARBALL" || \
  wget --progress=bar:force "$SRC_URL" -O "$TARBALL" || \
  fatal "Download fehlgeschlagen. Bitte Version prüfen: https://github.com/HandBrake/HandBrake/releases"

info "Entpacke..."
tar xjf "$TARBALL" -C "$TMP_DIR"

SRC_DIR="${TMP_DIR}/HandBrake-${HANDBRAKE_VERSION}"
[[ -d "$SRC_DIR" ]] || SRC_DIR=$(find "$TMP_DIR" -maxdepth 1 -type d -name "HandBrake*" | head -1)
[[ -d "$SRC_DIR" ]] || fatal "Quellverzeichnis nicht gefunden"

# --------------------------------------------------------------------------
# 5. Konfigurieren & Bauen
# --------------------------------------------------------------------------
cd "$SRC_DIR"

info "Konfiguriere HandBrake mit NVDEC (--enable-nvdec)..."
./configure \
  --launch-jobs="$(nproc)" \
  --enable-nvdec \
  --prefix=/usr/local \
  2>&1 | tail -15

info "Baue HandBrake mit $(nproc) Threads – das dauert 10–30 Minuten..."
make --directory=build -j"$(nproc)"

info "Installiere nach /usr/local/bin/..."
make --directory=build install

# --------------------------------------------------------------------------
# 6. Ergebnis prüfen
# --------------------------------------------------------------------------
if command -v HandBrakeCLI &>/dev/null; then
  VER=$(HandBrakeCLI --version 2>&1 | head -1)
  ok "Erfolgreich installiert: ${VER}"
  echo ""

  # NVDEC im Binary prüfen
  if HandBrakeCLI --help 2>&1 | grep -qi "nvdec"; then
    ok "NVDEC: im Binary vorhanden ✓"
  else
    warn "NVDEC: nicht in --help gefunden (evtl. kein --enable-nvdec oder kein CUDA-Header)"
  fi

  # Laufzeit-Bibliothek prüfen
  if ldconfig -p 2>/dev/null | grep -q libnvcuvid; then
    ok "libnvcuvid: gefunden – NVDEC zur Laufzeit verfügbar ✓"
  else
    warn "libnvcuvid: NICHT gefunden"
    warn "→ Bitte NVIDIA-Treiber installieren: apt-get install nvidia-driver-XXX"
    warn "  NVDEC ist im Binary vorhanden, funktioniert aber erst mit dem Treiber."
  fi
else
  fatal "HandBrakeCLI nach dem Build nicht gefunden – Build fehlgeschlagen."
fi
