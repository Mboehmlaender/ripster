# Architektur-Übersicht

---

## Kernprinzipien

### Event-getriebene Pipeline

`pipelineService` hält einen Snapshot der State-Machine und broadcastet Änderungen sofort via WebSocket.

```text
State-Änderung -> PIPELINE_STATE_CHANGED/PIPELINE_PROGRESS -> Frontend-Update
```

### Service-Layer

```text
Route -> Service -> DB/Tool-Execution
```

Routes enthalten kaum Business-Logik.

### Schema-getriebene Settings

Settings sind DB-schema-getrieben (`settings_schema` + `settings_values`), UI rendert dynamisch aus diesen Daten.

---

## Echtzeit-Kommunikation

WebSocket läuft auf `/ws`.

Wichtige Events:

- `PIPELINE_STATE_CHANGED`, `PIPELINE_PROGRESS`, `PIPELINE_QUEUE_CHANGED`
- `DISC_DETECTED`, `DISC_REMOVED`
- `HARDWARE_MONITOR_UPDATE`
- `SETTINGS_UPDATED`, `SETTINGS_BULK_UPDATED`
- `SETTINGS_SCRIPTS_UPDATED`, `SETTINGS_SCRIPT_CHAINS_UPDATED`, `USER_PRESETS_UPDATED`
- `CRON_JOBS_UPDATED`, `CRON_JOB_UPDATED`
- `PIPELINE_ERROR`, `DISK_DETECTION_ERROR`

---

## Prozessausführung

Externe Tools werden als Child-Processes gestartet (`processRunner`):

- Streaming von stdout/stderr
- Progress-Parsing (`progressParsers.js`)
- kontrollierter Abbruch (SIGINT/SIGKILL-Fallback)

---

## Persistenz

SQLite-Datei: `backend/data/ripster.db`

Kern-Tabellen:

- `jobs`, `pipeline_state`
- `settings_schema`, `settings_values`
- `scripts`, `script_chains`, `script_chain_steps`
- `user_presets`
- `cron_jobs`, `cron_run_logs`

Beim Start werden Schema und Settings-Migrationen automatisch ausgeführt.

---

## Fehlerbehandlung

Zentrales Error-Handling liefert:

```json
{
  "error": {
    "message": "...",
    "statusCode": 400,
    "reqId": "...",
    "details": []
  }
}
```

Fehlgeschlagene Jobs bleiben in der Historie (`ERROR` oder `CANCELLED`) und können erneut gestartet werden.

---

## CORS & Runtime-Konfig

- `CORS_ORIGIN` default: `*`
- `LOG_LEVEL` default: `info`
- DB-/Log-Pfade über `DB_PATH`/`LOG_DIR` konfigurierbar
