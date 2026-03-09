#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd -P)"
REPO_ROOT="$SCRIPT_DIR"
BIN_DIR="${REPO_ROOT}/bin"
OUTPUT_BIN="${BIN_DIR}/HandBrakeCLI"
OUTPUT_TMP="${BIN_DIR}/.HandBrakeCLI.build-tmp"
HANDBRAKE_VERSION="${1:-1.10.0}"
JOBS="${JOBS:-$(nproc)}"

export LANG="${LANG:-C.UTF-8}"
export LC_ALL="${LC_ALL:-C.UTF-8}"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
RESET='\033[0m'

info()  { echo -e "${BLUE}[INFO]${RESET}  $*"; }
ok()    { echo -e "${GREEN}[OK]${RESET}    $*"; }
warn()  { echo -e "${YELLOW}[WARN]${RESET}  $*"; }
error() { echo -e "${RED}[ERROR]${RESET} $*" >&2; }
fatal() { error "$*"; exit 1; }

run_as_root() {
  if [[ "${EUID}" -eq 0 ]]; then
    "$@"
  elif command -v sudo >/dev/null 2>&1; then
    sudo "$@"
  else
    fatal "Root-Rechte erforderlich. Bitte als root ausführen oder sudo installieren."
  fi
}

apt_get() {
  run_as_root env DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a \
    apt-get -o Dpkg::Use-Pty=0 "$@"
}

require_cmd() {
  local cmd="$1"
  command -v "$cmd" >/dev/null 2>&1 || fatal "Benötigter Befehl fehlt: $cmd"
}

cleanup_stale_tmp_build_dirs() {
  local stale_dirs=()
  shopt -s nullglob
  stale_dirs=(/tmp/handbrake-nvdec-build-*)
  shopt -u nullglob

  if [[ ${#stale_dirs[@]} -gt 0 ]]; then
    warn "Bereinige alte temporäre Build-Ordner in /tmp..."
    run_as_root rm -rf "${stale_dirs[@]}"
  fi
}

repair_package_state() {
  local audit_output=""
  audit_output="$(run_as_root dpkg --audit || true)"

  if [[ -n "${audit_output//[[:space:]]/}" ]]; then
    warn "Unvollständiger Paketstatus erkannt. Repariere dpkg/apt..."
    run_as_root env DEBIAN_FRONTEND=noninteractive dpkg --configure -a
    apt_get --fix-broken install -y
    ok "Paketstatus repariert."
  fi
}

install_build_dependencies() {
  repair_package_state

  info "Aktualisiere Paketlisten..."
  apt_get update

  info "Installiere Build-Abhängigkeiten..."
  apt_get install -y \
    autoconf automake build-essential cmake git \
    libass-dev libbz2-dev libfontconfig-dev libfreetype-dev libfribidi-dev libharfbuzz-dev \
    libjansson-dev liblzma-dev libmp3lame-dev libnuma-dev libogg-dev \
    libopus-dev libsamplerate0-dev libspeex-dev libtheora-dev libtool libtool-bin \
    libturbojpeg0-dev libvorbis-dev libx264-dev libxml2-dev libvpx-dev \
    m4 make meson nasm ninja-build patch pkg-config tar zlib1g-dev \
    curl libssl-dev clang bzip2 ca-certificates wget libffmpeg-nvenc-dev

  if [[ ! -f /usr/include/ffnvcodec/dynlink_nvcuvid.h ]]; then
    warn "NVDEC-Header (dynlink_nvcuvid.h) nicht gefunden. Versuche nvidia-cuda-toolkit als Fallback..."
    if ! apt_get install -y nvidia-cuda-toolkit; then
      fatal "NVDEC-Header fehlen und nvidia-cuda-toolkit konnte nicht installiert werden."
    fi
    if [[ ! -f /usr/include/ffnvcodec/dynlink_nvcuvid.h && ! -f /usr/include/nvcuvid.h ]]; then
      fatal "NVDEC-Header weiterhin nicht vorhanden. Prüfe Repository-Konfiguration (universe/multiverse)."
    fi
  fi
}

download_source() {
  local tarball="$1"
  local url="https://github.com/HandBrake/HandBrake/releases/download/${HANDBRAKE_VERSION}/HandBrake-${HANDBRAKE_VERSION}-source.tar.bz2"

  info "Lade HandBrake ${HANDBRAKE_VERSION} Quellcode..."
  if command -v curl >/dev/null 2>&1; then
    curl -fL "$url" -o "$tarball"
  else
    wget -O "$tarball" "$url"
  fi
}

main() {
  if [[ ! -f /etc/os-release ]]; then
    fatal "/etc/os-release fehlt. Nur Debian/Ubuntu/Proxmox werden unterstützt."
  fi
  # shellcheck disable=SC1091
  . /etc/os-release
  case "${ID:-}" in
    debian|ubuntu|linuxmint|pop) ;;
    *)
      warn "Ungetestetes Betriebssystem: ${PRETTY_NAME:-unknown}. Es wird trotzdem versucht fortzufahren."
      ;;
  esac

  require_cmd nproc
  require_cmd tar
  require_cmd dpkg

  cleanup_stale_tmp_build_dirs
  install_build_dependencies
  require_cmd make

  local tmp_dir tarball src_dir
  tmp_dir="$(mktemp -d -p /tmp handbrake-nvdec-build-XXXXXX)"
  tarball="${tmp_dir}/HandBrake-${HANDBRAKE_VERSION}-source.tar.bz2"
  src_dir="${tmp_dir}/HandBrake-${HANDBRAKE_VERSION}"

  cleanup() {
    rm -rf "$tmp_dir"
    rm -f "$OUTPUT_TMP"
  }
  trap cleanup EXIT INT TERM

  download_source "$tarball"

  info "Entpacke Quellcode..."
  tar xjf "$tarball" -C "$tmp_dir"
  [[ -d "$src_dir" ]] || fatal "Entpacktes Quellverzeichnis nicht gefunden: $src_dir"

  local configure_log
  configure_log="${tmp_dir}/configure.log"

  info "Konfiguriere Build (NVDEC aktiviert)..."
  (
    cd "$src_dir"
    ./configure \
      --launch-jobs="$JOBS" \
      --enable-nvdec \
      --disable-gtk \
      --prefix=/usr/local >"$configure_log" 2>&1
  )

  if ! rg -q 'Enable NVDEC:[[:space:]]+True' "$configure_log"; then
    tail -n 80 "$configure_log" >&2 || true
    fatal "Configure hat NVDEC nicht aktiviert (Enable NVDEC != True)."
  fi

  if ! rg -q 'Enable NVENC:[[:space:]]+True' "$configure_log"; then
    tail -n 80 "$configure_log" >&2 || true
    fatal "Configure hat NVENC nicht aktiviert (Enable NVENC != True)."
  fi

  rg 'Enable NVENC|Enable NVDEC' "$configure_log" || true

  info "Baue HandBrakeCLI mit ${JOBS} Threads (das kann länger dauern)..."
  make --directory="${src_dir}/build" -j"$JOBS"

  [[ -x "${src_dir}/build/HandBrakeCLI" ]] || fatal "Build erfolgreich, aber HandBrakeCLI wurde nicht gefunden."

  mkdir -p "$BIN_DIR"
  install -m 0755 "${src_dir}/build/HandBrakeCLI" "$OUTPUT_TMP"

  if "$OUTPUT_TMP" --help 2>&1 | rg -qi "nvdec|nvenc"; then
    ok "Hinweis: NVENC/NVDEC-Begriffe in --help gefunden."
  else
    warn "--help zeigt NVENC/NVDEC nicht explizit. Maßgeblich ist die Configure-Zusammenfassung (Enable NVENC/NVDEC: True)."
  fi

  mv -f "$OUTPUT_TMP" "$OUTPUT_BIN"

  ok "Fertig: ${OUTPUT_BIN}"
  "$OUTPUT_BIN" --version | head -1
  info "Aufgeräumt: Nur ${OUTPUT_BIN} bleibt im Repository als Build-Artefakt."
}

main "$@"
