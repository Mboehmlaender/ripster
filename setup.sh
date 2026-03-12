#!/usr/bin/env bash
set -euo pipefail

REPO_OWNER="Mboehmlaender"
REPO_NAME="ripster"
REPO_RAW_BASE="https://raw.githubusercontent.com/${REPO_OWNER}/${REPO_NAME}"
BRANCHES_API_URL="https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/branches?per_page=100"

usage() {
  cat <<'EOF'
Verwendung:
  bash init.sh

Optionen:
  -h, --help          Hilfe anzeigen
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
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

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

SELECTED_BRANCH=""
select_branch

INSTALL_SCRIPT="${TMP_DIR}/install.sh"
INSTALL_URL="${REPO_RAW_BASE}/${SELECTED_BRANCH}/install.sh"

echo "Lade install.sh aus Branch '${SELECTED_BRANCH}'..."
download_file "$INSTALL_URL" "$INSTALL_SCRIPT"
chmod +x "$INSTALL_SCRIPT"

if [[ $EUID -eq 0 ]]; then
  bash "$INSTALL_SCRIPT" --branch "$SELECTED_BRANCH"
else
  if ! command -v sudo >/dev/null 2>&1; then
    echo "sudo nicht gefunden. Bitte als root ausführen." >&2
    exit 1
  fi
  sudo bash "$INSTALL_SCRIPT" --branch "$SELECTED_BRANCH"
fi
