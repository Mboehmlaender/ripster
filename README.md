# Ripster

Ripster ist eine lokale Web-Anwendung für halbautomatisches Disc-Ripping mit MakeMKV + HandBrake inklusive Metadaten-Auswahl, Titel-/Spurprüfung und Job-Historie.

## Was Ripster kann

- Disc-Erkennung mit Pipeline-Status in Echtzeit (WebSocket)
- Metadaten-Suche und Zuordnung über OMDb
- MakeMKV-Analyse und Rip (MKV oder Backup-Modus)
- HandBrake-Encode mit Preset + Extra-Args + Track-Override
- Manuelle Playlist-/Titel-Auswahl bei komplexen Blu-rays
- Historie mit Re-Encode, Löschfunktionen und Detailansicht
- Dateibasierte Logs (Backend + Job-Prozesslogs)

## Tech-Stack

- Backend: Node.js, Express, SQLite, WebSocket (`ws`)
- Frontend: React, Vite, PrimeReact
- Externe Tools: `makemkvcon`, `HandBrakeCLI`, `mediainfo`

## Voraussetzungen

- Linux-System mit optischem Laufwerk (oder gemountete Quelle)
- Node.js `>= 20.19.0` (siehe [.nvmrc](.nvmrc))
- Installierte CLI-Tools im `PATH`:
  - `makemkvcon`
  - `HandBrakeCLI`
  - `mediainfo`

## Schnellstart

```bash
./start.sh
```

`start.sh` erledigt:

1. Node-Version prüfen/umschalten (inkl. `nvm`/`node@20`-Fallback)
2. Dependencies installieren (Root, Backend, Frontend)
3. Dev-Umgebung starten (`backend` + `frontend`)

Danach:

- Frontend: `http://localhost:5173`
- Backend API: `http://localhost:3001/api`

Stoppen:

```bash
./kill.sh
```

## Manueller Start

```bash
npm install
npm --prefix backend install
npm --prefix frontend install
npm run dev
```

Einzeln starten:

```bash
npm run dev:backend
npm run dev:frontend
```

Frontend Build:

```bash
npm run build:frontend
```

Backend (ohne Dev-Mode):

```bash
npm run start
```

## Konfiguration

### 1) UI-Settings (empfohlen)

Die meisten Einstellungen werden in der App unter `Settings` gepflegt und in SQLite gespeichert:

- Pfade: `raw_dir`, `movie_dir`, `log_dir`
- Tools: `makemkv_command`, `handbrake_command`, `mediainfo_command`
- Encode: `handbrake_preset`, `handbrake_extra_args`, `output_extension`, `filename_template`
- Laufwerk/Scan: `drive_mode`, `drive_device`, Polling
- Benachrichtigungen: PushOver

### 2) Umgebungsvariablen

Backend (`backend/src/config.js`):

- `PORT` (Default: `3001`)
- `DB_PATH` (Default: `backend/data/ripster.db`)
- `LOG_DIR` (Fallback-Logpfad, Default: `backend/logs`)
- `CORS_ORIGIN` (Default: `*`)
- `LOG_LEVEL` (`debug|info|warn|error`, Default: `info`)

Frontend (Vite):

- `VITE_API_BASE` (Default: `/api`)
- `VITE_WS_URL` (optional, überschreibt automatische WS-URL)
- `VITE_PUBLIC_ORIGIN`, `VITE_ALLOWED_HOSTS`, `VITE_HMR_*` (Remote-Dev/HMR)

## Logs und Daten

Log-Ziel ist primär der in den Settings gepflegte `log_dir`.

- Backend-Logs: `<log_dir>/backend/backend-latest.log` und Tagesdateien
- Job-Logs: `<log_dir>/job-<id>.process.log`
- DB: `backend/data/ripster.db` (inkl. Job-/Settings-Daten)

Hinweis: Beim DB-Init wird das Schema gegen die Soll-Struktur abgeglichen und migriert.

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
  start.sh
  kill.sh
  deploy-ripster.sh
```

## API-Überblick

- `GET /api/pipeline/state`
- `POST /api/pipeline/analyze`
- `POST /api/pipeline/start/:jobId`
- `POST /api/pipeline/confirm-encode/:jobId`
- `GET /api/history`
- `GET /api/history/:id`
- `GET /api/settings`
- `PUT /api/settings`

## Troubleshooting

- WebSocket verbindet nicht:
  - prüfen, ob Frontend über Vite-Proxy läuft (`/ws` -> Backend)
  - bei Reverse-Proxy `VITE_PUBLIC_ORIGIN`/HMR korrekt setzen
- Keine Disc erkannt:
  - `drive_mode=explicit` testen und `drive_device` setzen (z. B. `/dev/sr0`)
- HandBrake/MakeMKV Fehler:
  - CLI-Binaries im `PATH` prüfen
  - Preset-Name exakt wie in `HandBrakeCLI -z` hinterlegen
- Startfehler wegen Schema:
  - sicherstellen, dass die erwartete Schema-Datei vorhanden ist (`db/schema.sql`)

## Sicherheit

- Keine echten Tokens/Passwörter ins Repository committen.
- Lokale Secrets in `.env` oder in Settings pflegen, aber nicht versionieren.

