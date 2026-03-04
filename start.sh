#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"
USE_NODE20_NPX=0

normalize_semver() {
  local version="$1"
  echo "${version#v}" | sed -E 's/[^0-9.].*$//'
}

version_gte() {
  local current required
  local c_major c_minor c_patch r_major r_minor r_patch

  current=$(normalize_semver "$1")
  required=$(normalize_semver "$2")

  IFS='.' read -r c_major c_minor c_patch <<< "$current"
  IFS='.' read -r r_major r_minor r_patch <<< "$required"

  c_major=${c_major:-0}
  c_minor=${c_minor:-0}
  c_patch=${c_patch:-0}
  r_major=${r_major:-0}
  r_minor=${r_minor:-0}
  r_patch=${r_patch:-0}

  if (( c_major > r_major )); then return 0; fi
  if (( c_major < r_major )); then return 1; fi
  if (( c_minor > r_minor )); then return 0; fi
  if (( c_minor < r_minor )); then return 1; fi
  if (( c_patch >= r_patch )); then return 0; fi
  return 1
}

load_nvm_if_available() {
  if command -v nvm >/dev/null 2>&1; then
    return 0
  fi

  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  if [[ -s "$NVM_DIR/nvm.sh" ]]; then
    # shellcheck source=/dev/null
    . "$NVM_DIR/nvm.sh" >/dev/null 2>&1
  fi

  command -v nvm >/dev/null 2>&1
}

try_use_project_node() {
  local project_root="$1"
  local required_version="$2"
  local current_version

  current_version=$(node -v 2>/dev/null || true)
  if [[ -n "$current_version" ]] && version_gte "$current_version" "$required_version"; then
    return 0
  fi

  if ! load_nvm_if_available; then
    return 1
  fi

  pushd "$project_root" >/dev/null
  if [[ -f ".nvmrc" ]]; then
    nvm use --silent >/dev/null 2>&1 || true
  fi
  popd >/dev/null

  current_version=$(node -v 2>/dev/null || true)
  if [[ -n "$current_version" ]] && version_gte "$current_version" "$required_version"; then
    echo "Projekt-Node aktiviert: ${current_version}"
    return 0
  fi

  return 1
}

ensure_minimum_node_version() {
  local project_root="$1"
  local min_version="20.19.0"
  local current_version
  local switched=0

  if ! command -v node >/dev/null 2>&1; then
    echo "Node.js wurde nicht gefunden. Bitte Node.js >= ${min_version} installieren."
    return 1
  fi

  if try_use_project_node "$project_root" "$min_version"; then
    switched=1
  fi

  current_version=$(node -v 2>/dev/null || true)
  if [[ -z "$current_version" ]]; then
    echo "Konnte die Node.js-Version nicht ermitteln."
    return 1
  fi

  if ! version_gte "$current_version" "$min_version"; then
    if (( switched == 0 )) && load_nvm_if_available; then
      echo "Node.js ${current_version} erkannt. Versuche automatische Aktivierung von ${min_version} via nvm ..."
      nvm install "${min_version}" >/dev/null
      nvm use "${min_version}" >/dev/null
      current_version=$(node -v 2>/dev/null || true)
    fi

    if ! version_gte "$current_version" "$min_version"; then
      if command -v npx >/dev/null 2>&1; then
        echo "Node.js ${current_version} erkannt. Nutze node@20 Fallback via npx."
        if npx -y node@20 -v >/dev/null 2>&1; then
          USE_NODE20_NPX=1
          return 0
        fi
      fi

      echo "Node.js ${current_version} erkannt. Erforderlich: >= ${min_version}."
      echo "Projektlokal:"
      echo "nvm install ${min_version} && nvm use"
      return 1
    fi
  fi
}

run_npm() {
  if (( USE_NODE20_NPX == 1 )); then
    npx -y node@20 "$(command -v npm)" "$@"
  else
    npm "$@"
  fi
}

ensure_minimum_node_version "$ROOT_DIR"

if [[ ! -d "$ROOT_DIR/node_modules" ]]; then
  echo "Installiere Abhaengigkeiten in $ROOT_DIR ..."
  run_npm install
fi

if [[ ! -d "$ROOT_DIR/backend/node_modules" ]]; then
  echo "Installiere Abhaengigkeiten in $ROOT_DIR/backend ..."
  run_npm --prefix backend install
fi

if [[ ! -d "$ROOT_DIR/frontend/node_modules" ]]; then
  echo "Installiere Abhaengigkeiten in $ROOT_DIR/frontend ..."
  run_npm --prefix frontend install
fi

echo "Starte Ripster Dev-Umgebung ..."
if (( USE_NODE20_NPX == 1 )); then
  exec npx -y node@20 "$(command -v npm)" run dev
else
  exec npm run dev
fi
