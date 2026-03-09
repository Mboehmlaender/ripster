#!/usr/bin/env bash
set -euo pipefail

REMOTE_USER="michael"
REMOTE_HOST="10.10.10.24"
REMOTE_PATH="/home/michael/ripster"
SSH_PASSWORD="rabenNest7$"

LOCAL_PATH="$(cd -- "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REMOTE_TARGET="${REMOTE_USER}@${REMOTE_HOST}:${REMOTE_PATH}"
SSH_OPTS="-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=10"
DATA_RELATIVE_DIR="backend/data/***"
DATA_DIR="backend/data"

if ! command -v sshpass >/dev/null 2>&1; then
  echo "sshpass ist nicht installiert. Bitte installieren, z. B.: sudo apt-get install -y sshpass"
  exit 1
fi

if [[ "$SSH_PASSWORD" == "CHANGE_ME" ]]; then
  echo "Bitte in deploy-ripster.sh den Wert von SSH_PASSWORD setzen."
  exit 1
fi

echo "Pruefe SSH-Verbindung zu ${REMOTE_USER}@${REMOTE_HOST} ..."
sshpass -p "$SSH_PASSWORD" ssh $SSH_OPTS "${REMOTE_USER}@${REMOTE_HOST}" "echo connected" >/dev/null

echo "Stelle sicher, dass Remote-Ordner ${REMOTE_PATH} existiert ..."
sshpass -p "$SSH_PASSWORD" ssh $SSH_OPTS "${REMOTE_USER}@${REMOTE_HOST}" "set -euo pipefail; mkdir -p '${REMOTE_PATH}' '${REMOTE_PATH}/${DATA_DIR}'"

echo "Uebertrage lokalen Ordner ${LOCAL_PATH} nach ${REMOTE_TARGET} ..."
echo "backend/data wird weder uebertragen noch auf dem Ziel geloescht: ${DATA_RELATIVE_DIR}"
sshpass -p "$SSH_PASSWORD" rsync -az --progress --delete \
  --filter "protect debug" \
  -e "ssh $SSH_OPTS" \
  "${LOCAL_PATH}/" "${REMOTE_TARGET}/"

echo "Hole ${DATA_DIR} nach dem Deploy vom Zielserver auf den Quellserver ..."
mkdir -p "${LOCAL_PATH}/${DATA_DIR}"
sshpass -p "$SSH_PASSWORD" rsync -az --progress \
  -e "ssh $SSH_OPTS" \
  "${REMOTE_TARGET}/${DATA_DIR}/" "${LOCAL_PATH}/${DATA_DIR}/"

echo "Fertig: ${LOCAL_PATH} wurde nach ${REMOTE_TARGET} uebertragen und ${DATA_DIR} wurde vom Zielserver auf den Quellserver geholt."
