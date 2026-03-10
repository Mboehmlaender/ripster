# Datenbank

Ripster verwendet SQLite (`backend/data/ripster.db`).

---

## Tabellen

```text
settings_schema
settings_values
jobs
pipeline_state
scripts
script_chains
script_chain_steps
user_presets
cron_jobs
cron_run_logs
```

---

## `jobs`

Speichert Pipeline-Lifecycle und Artefakte pro Job.

Zentrale Felder:

- Metadaten: `title`, `year`, `imdb_id`, `poster_url`, `omdb_json`, `selected_from_omdb`
- Laufzeit: `start_time`, `end_time`, `status`, `last_state`
- Pfade: `raw_path`, `output_path`, `encode_input_path`
- Tool-Ausgaben: `makemkv_info_json`, `handbrake_info_json`, `mediainfo_info_json`, `encode_plan_json`
- Kontrolle: `encode_review_confirmed`, `rip_successful`, `error_message`
- Audit: `created_at`, `updated_at`

---

## `pipeline_state`

Singleton-Tabelle (`id = 1`) für aktiven Snapshot:

- `state`
- `active_job_id`
- `progress`
- `eta`
- `status_text`
- `context_json`
- `updated_at`

---

## `settings_schema` + `settings_values`

- `settings_schema`: Definition (Typ, Default, Validation, Reihenfolge)
- `settings_values`: aktueller Wert pro Key

---

## `scripts`, `script_chains`, `script_chain_steps`

- `scripts`: Shell-Skripte (`name`, `script_body`, `order_index`)
- `script_chains`: Ketten (`name`, `order_index`)
- `script_chain_steps`: Schritte je Kette
  - `step_type`: `script` oder `wait`
  - `script_id` oder `wait_seconds`

---

## `user_presets`

Benannte HandBrake-Preset-Sets:

- `name`
- `media_type` (`bluray|dvd|other|all`)
- `handbrake_preset`
- `extra_args`
- `description`

---

## `cron_jobs` + `cron_run_logs`

- `cron_jobs`: Zeitplan + Status
- `cron_run_logs`: einzelne Läufe
  - `status`: `running|success|error`
  - `output`
  - `error_message`

---

## Migration/Recovery

Beim Start werden Schema und Settings-Metadaten automatisch abgeglichen.

Bei korruptem SQLite-File:

1. Datei wird nach `backend/data/corrupt-backups/` verschoben
2. neue DB wird initialisiert
3. Schema wird neu aufgebaut

---

## Direkte Inspektion

```bash
sqlite3 backend/data/ripster.db

.mode table
SELECT id, status, title, created_at FROM jobs ORDER BY created_at DESC;
SELECT key, value FROM settings_values ORDER BY key;
```
