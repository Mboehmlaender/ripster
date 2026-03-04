#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PID_FILE="$ROOT_DIR/start.pid"
WAIT_SECONDS=8

declare -A PID_SET=()

is_running() {
  local pid="$1"
  kill -0 "$pid" 2>/dev/null
}

is_pid_under_root() {
  local pid="$1"
  local cwd

  cwd="$(readlink -f "/proc/$pid/cwd" 2>/dev/null || true)"
  [[ -n "$cwd" && "$cwd" == "$ROOT_DIR"* ]]
}

add_pid() {
  local pid="$1"
  [[ "$pid" =~ ^[0-9]+$ ]] || return 0
  (( pid > 1 )) || return 0
  (( pid == $$ )) && return 0
  is_running "$pid" || return 0

  PID_SET["$pid"]=1
}

collect_descendants() {
  local parent="$1"
  local child

  while read -r child; do
    [[ -n "$child" ]] || continue
    add_pid "$child"
    collect_descendants "$child"
  done < <(pgrep -P "$parent" 2>/dev/null || true)
}

collect_from_pid_file() {
  local pid

  [[ -f "$PID_FILE" ]] || return 0
  pid="$(tr -d '[:space:]' < "$PID_FILE" || true)"
  [[ "$pid" =~ ^[0-9]+$ ]] || return 0
  is_running "$pid" || return 0

  add_pid "$pid"
  collect_descendants "$pid"
}

collect_by_process_scan() {
  local pid cmd

  while read -r pid cmd; do
    [[ -n "$pid" ]] || continue
    is_pid_under_root "$pid" || continue

    case "$cmd" in
      *concurrently*|*npm\ run\ dev*|*nodemon*|*vite*|*backend/src/index.js*)
        add_pid "$pid"
        collect_descendants "$pid"
        ;;
    esac
  done < <(ps -eo pid=,cmd=)
}

collect_all_targets() {
  collect_from_pid_file
  collect_by_process_scan
}

terminate_pids() {
  local signal="$1"
  local pid

  for pid in "${!PID_SET[@]}"; do
    is_running "$pid" || continue
    kill "-$signal" "$pid" 2>/dev/null || true
  done
}

count_running_targets() {
  local pid count=0

  for pid in "${!PID_SET[@]}"; do
    if is_running "$pid"; then
      count=$((count + 1))
    fi
  done

  echo "$count"
}

main() {
  local running_count elapsed

  collect_all_targets

  if [[ ${#PID_SET[@]} -eq 0 ]]; then
    echo "Keine laufenden Ripster-Prozesse gefunden."
    rm -f "$PID_FILE"
    exit 0
  fi

  echo "Beende ${#PID_SET[@]} Ripster-Prozess(e) ..."
  terminate_pids TERM

  elapsed=0
  while (( elapsed < WAIT_SECONDS )); do
    running_count="$(count_running_targets)"
    if [[ "$running_count" -eq 0 ]]; then
      break
    fi
    sleep 1
    elapsed=$((elapsed + 1))
  done

  running_count="$(count_running_targets)"
  if [[ "$running_count" -gt 0 ]]; then
    echo "Noch $running_count Prozess(e) aktiv, sende SIGKILL ..."
    terminate_pids KILL
  fi

  rm -f "$PID_FILE"
  echo "Ripster-Prozesse wurden beendet."
}

main "$@"
