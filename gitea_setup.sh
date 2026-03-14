#!/usr/bin/env bash
set -euo pipefail

GITEA_BASE="https://git.d-razz.de"
REPO_OWNER="michael"
REPO_NAME="ripster"
BRANCHES_API_URL="${GITEA_BASE}/api/v1/repos/${REPO_OWNER}/${REPO_NAME}/branches?limit=50"

usage() {
  cat <<'EOF'
Verwendung:
  bash setup.sh [Optionen]

Optionen (wie install.sh):
  --branch <branch>     Branch direkt setzen (ohne Auswahlmenue)
  --dir <pfad>          Installationsverzeichnis
  --user <benutzer>     Systembenutzer fuer den Dienst
  --port <port>         Backend-Port
  --host <hostname>     Hostname/IP fuer die Weboberflaeche
  --no-makemkv          MakeMKV-Installation ueberspringen
  --no-handbrake        HandBrake-Installation ueberspringen
  --no-nginx            Nginx-Einrichtung ueberspringen
  --reinstall           Vorhandene Installation aktualisieren
  -h, --help            Hilfe anzeigen
EOF
}

SELECTED_BRANCH=""
FORWARDED_ARGS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --branch)
      [[ $# -ge 2 ]] || { echo "Fehlender Wert fuer --branch" >&2; exit 1; }
      SELECTED_BRANCH="$2"
      shift 2
      ;;
    --dir|--user|--port|--host)
      [[ $# -ge 2 ]] || { echo "Fehlender Wert fuer $1" >&2; exit 1; }
      FORWARDED_ARGS+=("$1" "$2")
      shift 2
      ;;
    --no-makemkv|--no-handbrake|--no-nginx|--reinstall)
      FORWARDED_ARGS+=("$1")
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unbekannter Parameter: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

fetch_url() {
  local url="$1"

  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$url"
    return
  fi

  if command -v wget >/dev/null 2>&1; then
    wget -qO- "$url"
    return
  fi

  echo "Weder curl noch wget gefunden. Bitte eines davon installieren." >&2
  exit 1
}

download_file() {
  local url="$1"
  local target="$2"
  fetch_url "$url" > "$target"
}

select_branch() {
  local branches_json
  local -a branches
  local selection

  branches_json="$(fetch_url "$BRANCHES_API_URL")"
  mapfile -t branches < <(
    printf '%s\n' "$branches_json" \
      | grep -oE '"name"[[:space:]]*:[[:space:]]*"[^"]+"' \
      | sed -E 's/"name"[[:space:]]*:[[:space:]]*"([^"]+)"/\1/'
  )

  if [[ ${#branches[@]} -eq 0 ]]; then
    echo "Keine Branches gefunden oder API-Antwort ungültig." >&2
    exit 1
  fi

  if [[ -n "$SELECTED_BRANCH" ]]; then
    local found=false
    for branch in "${branches[@]}"; do
      if [[ "$branch" == "$SELECTED_BRANCH" ]]; then
        found=true
        break
      fi
    done
    if [[ "$found" == false ]]; then
      echo "Branch '$SELECTED_BRANCH' nicht gefunden." >&2
      exit 1
    fi
    return
  fi

  if [[ ! -t 0 ]]; then
    echo "Kein interaktives Terminal für die Branch-Auswahl verfügbar." >&2
    exit 1
  fi

  echo "Verfügbare Branches:"
  for i in "${!branches[@]}"; do
    printf "  %2d) %s\n" "$((i + 1))" "${branches[$i]}"
  done

  while true; do
    read -r -p "Bitte Branch auswählen [1-${#branches[@]}]: " selection
    if [[ "$selection" =~ ^[0-9]+$ ]] && (( selection >= 1 && selection <= ${#branches[@]} )); then
      SELECTED_BRANCH="${branches[$((selection - 1))]}"
      return
    fi
    echo "Ungültige Auswahl."
  done
}

select_branch

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd -P)"
INSTALL_SCRIPT="${SCRIPT_DIR}/gitea_install.sh"

if [[ ! -f "$INSTALL_SCRIPT" ]]; then
  echo "gitea_install.sh nicht gefunden in $SCRIPT_DIR" >&2
  exit 1
fi

if [[ $EUID -eq 0 ]]; then
  bash "$INSTALL_SCRIPT" --branch "$SELECTED_BRANCH" "${FORWARDED_ARGS[@]}"
else
  if ! command -v sudo >/dev/null 2>&1; then
    echo "sudo nicht gefunden. Bitte als root ausführen." >&2
    exit 1
  fi
  sudo bash "$INSTALL_SCRIPT" --branch "$SELECTED_BRANCH" "${FORWARDED_ARGS[@]}"
fi
