# Ripster

Ripster ist eine lokale Web-Anwendung für halbautomatisches Disc-Ripping mit MakeMKV + HandBrake inklusive Metadaten-Auswahl, Track-Review, Queue, Skripten/Ketten und Job-Historie.

---

## Statushinweis: CD-Ripping (experimentell)

- Die grundlegende CD-Ripping-Funktion im ersten Durchgang funktioniert.
- Das Frontend ist dafür noch nicht vollständig angepasst.
- Funktionen wie Restart, bestimmte Ansichten und Folge-Workflows können aktuell eingeschränkt sein oder fehlschlagen.
- CD-Ripping wird weiterentwickelt und sollte derzeit als experimentell betrachtet werden.

## Was Ripster kann

- Disc-Erkennung mit Pipeline-Status in Echtzeit (WebSocket)
- Medienprofil-Erkennung (Blu-ray/DVD/Sonstiges) aus Device-/Filesystem-Heuristik
- Metadaten-Suche und Zuordnung über OMDb
- MakeMKV-Analyse und Rip (`mkv` oder `backup`) mit profilspezifischen Settings
- HandBrake-Review und Encoding mit Track-Auswahl, User-Presets, Extra-Args
- Pre- und Post-Encode-Ausführungen (Skripte und/oder Skript-Ketten)
- Pipeline-Queue mit Job- und Nicht-Job-Einträgen (`script`, `chain`, `wait`)
- Cron-Jobs für Skripte/Ketten (inkl. Logs und manueller Auslösung)
- **Aktivitäts-Tracking**: Laufende und abgeschlossene Aktionen (Skripte, Ketten, Cron, Tasks) in Echtzeit im Dashboard
- Historie mit Re-Encode, Review-Neustart, File-/Job-Löschung und Orphan-Import
- Hardware-Monitoring (CPU/RAM/GPU/Storage) im Dashboard

## Tech-Stack

- Backend: Node.js, Express, SQLite, WebSocket (`ws`)
- Frontend: React, Vite, PrimeReact
- Externe Tools: `makemkvcon`, `HandBrakeCLI`, `mediainfo`

## Dokumentation

- Ausführliche Dokumentation: https://mboehmlaender.github.io/ripster/

## Voraussetzungen

- Debian 11/12 oder Ubuntu 22.04/24.04
- root-Rechte + Internetzugang
- optisches Laufwerk (oder gemountete Quelle)

## Schnellstart (`install.sh`)

Auf Debian 11/12 oder Ubuntu 22.04/24.04 (root erforderlich):

```bash
wget -qO install.sh https://raw.githubusercontent.com/Mboehmlaender/ripster/main/install.sh
sudo bash install.sh
```

Alternativ direkt per Pipe:

```bash
curl -fsSL https://raw.githubusercontent.com/Mboehmlaender/ripster/main/install.sh | sudo bash
```

`install.sh` übernimmt u. a.:

- Node.js 20 (falls nötig)
- Basistools inkl. `mediainfo`
- CD-Ripping-Tools (`cdparanoia`, `flac`, `lame`, `opus-tools`, `vorbis-tools`)
- MakeMKV (optional)
- HandBrake CLI (optional; Auswahl Standard oder GPU/NVDEC-Binary)
- nginx (optional)
- Repository-Checkout, npm-Install, Frontend-Build, systemd-Service (`ripster-backend`)

Danach ist Ripster unter `http://<Server-IP>` erreichbar.

Wichtige Optionen:

```bash
sudo bash install.sh --branch dev          # Branch wählen (Default im Skript: dev)
sudo bash install.sh --dir /opt/ripster    # Installationspfad
sudo bash install.sh --user ripster        # Service-User
sudo bash install.sh --port 3001           # Backend-Port
sudo bash install.sh --host 192.168.1.10   # Host/IP für nginx/CORS
sudo bash install.sh --no-makemkv          # MakeMKV überspringen
sudo bash install.sh --no-handbrake        # HandBrake überspringen
sudo bash install.sh --no-nginx            # nginx-Setup überspringen
sudo bash install.sh --reinstall           # Update (Daten bleiben erhalten)
sudo bash install.sh --help                # Hilfe anzeigen
```

## Konfiguration

### UI-Settings (empfohlen)

Die meisten Einstellungen werden in der App unter `Settings` gepflegt und in SQLite gespeichert:

- Pfade: `Raw Ausgabeordner`, `Film Ausgabeordner`, `Log Ordner` (jeweils mit Blu-ray/DVD/Sonstiges-Varianten)
- Tools: `MakeMKV Kommando`, `HandBrake Kommando`, `Mediainfo Kommando`
- Profile: medientyp-spezifische Felder für Blu-ray/DVD/Sonstiges (z. B. Preset, Zusatzargumente, Ausgabeformat)
- Queue/Monitoring: `Parallele Jobs`, `Hardware Monitoring aktiviert`, `Hardware Monitoring Intervall (ms)`
- Benachrichtigungen: PushOver

### Umgebungsvariablen

Backend (`backend/src/config.js`):

- `PORT` (Default: `3001`)
- `DB_PATH` (Default: `backend/data/ripster.db`)
- `LOG_DIR` (Default: `backend/logs`)
- `CORS_ORIGIN` (Default: `*`)
- `LOG_LEVEL` (`debug|info|warn|error`, Default: `info`)

Frontend (Vite):

- `VITE_API_BASE` (Default: `/api`)
- `VITE_WS_URL` (optional, überschreibt automatische WS-URL)
- optional für Remote-Dev: `VITE_PUBLIC_ORIGIN`, `VITE_ALLOWED_HOSTS`, `VITE_HMR_PROTOCOL`, `VITE_HMR_HOST`, `VITE_HMR_CLIENT_PORT`

## Logs und Daten

Log-Ziel ist primär der in den Settings gepflegte `log_dir`.

- Backend-Logs: `<log_dir>/backend/backend-latest.log` und Tagesdateien
- Job-Logs: `<log_dir>/job-<id>.process.log`
- DB: `backend/data/ripster.db`

Hinweis: Beim DB-Init wird das Schema geprüft und fehlende Elemente werden migriert.

## Projektstruktur

```text
ripster/
  backend/
    src/
      routes/
      services/
      db/
      utils/
  frontend/
    src/
      pages/
      components/
      api/
  db/schema.sql
  start.sh
  install.sh
  install-dev.sh
```

## API-Überblick

**Health**
- `GET /api/health`

**Pipeline**
- `GET /api/pipeline/state`
- `POST /api/pipeline/analyze`
- `POST /api/pipeline/rescan-disc`
- `POST /api/pipeline/select-metadata`
- `POST /api/pipeline/start/:jobId`
- `POST /api/pipeline/confirm-encode/:jobId`
- `POST /api/pipeline/cancel`
- `POST /api/pipeline/retry/:jobId`
- `POST /api/pipeline/reencode/:jobId`
- `POST /api/pipeline/restart-review/:jobId`
- `POST /api/pipeline/restart-encode/:jobId`
- `POST /api/pipeline/resume-ready/:jobId`
- `GET /api/pipeline/queue`
- `POST /api/pipeline/queue/reorder`
- `POST /api/pipeline/queue/entry`
- `DELETE /api/pipeline/queue/entry/:entryId`

**History**
- `GET /api/history`
- `GET /api/history/:id`
- `GET /api/history/database`
- `GET /api/history/orphan-raw`
- `POST /api/history/orphan-raw/import`
- `POST /api/history/:id/omdb/assign`
- `POST /api/history/:id/delete-files`
- `POST /api/history/:id/delete`

**Settings**
- `GET /api/settings`
- `PUT /api/settings/:key`
- `PUT /api/settings`
- `GET/POST/PUT/DELETE /api/settings/scripts...`
- `GET/POST/PUT/DELETE /api/settings/script-chains...`
- `GET/POST/PUT/DELETE /api/settings/user-presets...`
- `POST /api/settings/pushover/test`

**Cron-Jobs**
- `GET /api/crons`
- `POST /api/crons`
- `GET /api/crons/:id`
- `PUT /api/crons/:id`
- `DELETE /api/crons/:id`
- `GET /api/crons/:id/logs`
- `POST /api/crons/:id/run`
- `POST /api/crons/validate-expression`

**Runtime-Aktivitäten**
- `GET /api/activities`
- `POST /api/activities/:id/cancel`
- `POST /api/activities/:id/next-step`
- `POST /api/activities/clear-recent`

## Troubleshooting

- WebSocket verbindet nicht:
  - prüfen, ob Frontend über Vite-Proxy läuft (`/ws` -> Backend)
  - bei Reverse-Proxy Upgrade-Header für `/ws` setzen
- Keine Disc erkannt:
  - in den Settings `Laufwerksmodus` auf `Explizites Device` stellen und `Device Pfad` setzen (z. B. `/dev/sr0`)
- HandBrake/MakeMKV Fehler:
  - CLI-Binaries im `PATH` prüfen
  - Preset-Name mit `HandBrakeCLI -z` prüfen
- Startfehler wegen Schema:
  - `db/schema.sql` vorhanden halten

## Sicherheit

- Keine echten Tokens/Passwörter ins Repository committen.
- Lokale Secrets in `.env` oder in Settings pflegen, aber nicht versionieren.
