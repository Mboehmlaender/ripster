# Datenbank

Ripster verwendet **SQLite3** als Datenbank. Die Datenbankdatei liegt unter `backend/data/ripster.db`.

---

## Schema-Übersicht

```sql
settings_schema    -- Einstellungs-Definitionen
settings_values    -- Benutzer-Werte
jobs               -- Rip-Job-Datensätze
pipeline_state     -- Aktueller Pipeline-Zustand (Singleton)
scripts            -- Shell-Skripte für Pre-/Post-Encode-Ausführung
script_chains      -- Geordnete Ketten aus mehreren Skripten
script_chain_steps -- Einzelschritte einer Skript-Kette
user_presets       -- Benannte HandBrake-Preset-Sammlungen pro Medientyp
cron_jobs          -- Zeitgesteuerte Aufgaben (eigener Cron-Parser)
cron_run_logs      -- Ausführungs-Protokolle für Cron-Jobs
```

---

## Tabelle: jobs

Die wichtigste Tabelle – speichert alle Ripping-Jobs.

```sql
CREATE TABLE jobs (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  status           TEXT NOT NULL,        -- Aktueller Status
  title            TEXT,                 -- Filmtitel (von OMDb)
  imdb_id          TEXT,                 -- IMDb-ID
  omdb_year        TEXT,                 -- Erscheinungsjahr
  omdb_type        TEXT,                 -- movie/series
  omdb_poster      TEXT,                 -- Poster-URL
  raw_path         TEXT,                 -- Pfad zur Raw-MKV
  output_path      TEXT,                 -- Pfad zur Ausgabedatei
  playlist         TEXT,                 -- Gewählte Blu-ray Playlist
  rip_successful   INTEGER NOT NULL DEFAULT 0,  -- 1 wenn Rip abgeschlossen
  makemkv_output   TEXT,                 -- MakeMKV-Ausgabe (JSON)
  mediainfo_output TEXT,                 -- MediaInfo-Ausgabe (JSON)
  encode_plan      TEXT,                 -- Encode-Plan (JSON)
  handbrake_log    TEXT,                 -- HandBrake Log-Pfad
  error_message    TEXT,                 -- Fehlermeldung bei ERROR
  error_details    TEXT                  -- Detaillierte Fehler-Infos
);
```

!!! info "rip_successful"
    Das Feld `rip_successful` wird auf `1` gesetzt, sobald MakeMKV den Rip-Schritt erfolgreich abgeschlossen hat – unabhängig davon, ob danach ein Encode-Fehler auftritt. Damit lässt sich in der History unterscheiden, ob eine Raw-Datei vorhanden ist.

### Job-Status-Werte

| Status | Beschreibung |
|--------|-------------|
| `ANALYZING` | MakeMKV analysiert die Disc |
| `METADATA_SELECTION` | Wartet auf Benutzer-Metadaten-Auswahl |
| `READY_TO_START` | Bereit zum Starten |
| `RIPPING` | MakeMKV rippt die Disc |
| `MEDIAINFO_CHECK` | MediaInfo analysiert die Raw-Datei |
| `READY_TO_ENCODE` | Wartet auf Encode-Bestätigung |
| `ENCODING` | HandBrake encodiert |
| `FINISHED` | Erfolgreich abgeschlossen |
| `ERROR` | Fehler aufgetreten |

---

## Tabelle: pipeline_state

Singleton-Tabelle für den aktuellen Pipeline-Zustand (immer genau 1 Zeile).

```sql
CREATE TABLE pipeline_state (
  id          INTEGER PRIMARY KEY CHECK(id = 1),
  state       TEXT NOT NULL DEFAULT 'IDLE',
  job_id      INTEGER,                -- Aktiver Job (NULL wenn IDLE)
  progress    REAL,                   -- Fortschritt 0-100
  eta         TEXT,                   -- Geschätzte Restzeit
  updated_at  TEXT NOT NULL
);
```

---

## Tabelle: settings_schema

Definiert alle verfügbaren Einstellungen mit Metadaten.

```sql
CREATE TABLE settings_schema (
  key          TEXT PRIMARY KEY,
  category     TEXT NOT NULL,      -- paths, tools, encoding, ...
  type         TEXT NOT NULL,      -- string, number, boolean, select
  label        TEXT NOT NULL,      -- Anzeigename
  description  TEXT,               -- Hilfetext
  default_val  TEXT,               -- Standardwert
  required     INTEGER,            -- 1 = Pflichtfeld
  min_val      REAL,               -- Minimalwert (für number)
  max_val      REAL,               -- Maximalwert (für number)
  options      TEXT                -- JSON-Array für select-Typ
);
```

---

## Tabelle: settings_values

Speichert benutzer-konfigurierte Werte.

```sql
CREATE TABLE settings_values (
  key        TEXT PRIMARY KEY REFERENCES settings_schema(key),
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

---

## Tabelle: scripts

Verwaltet Shell-Skripte, die vor oder nach dem Encode-Schritt ausgeführt werden können.

```sql
CREATE TABLE scripts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL UNIQUE,
  script_body TEXT NOT NULL,
  order_index INTEGER NOT NULL DEFAULT 0,  -- Sortierposition in der UI
  created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

## Tabelle: script_chains

Geordnete Ketten, die mehrere Skripte sequenziell zusammenfassen.

```sql
CREATE TABLE script_chains (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL UNIQUE,
  order_index INTEGER NOT NULL DEFAULT 0,  -- Sortierposition in der UI
  created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE script_chain_steps (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  chain_id       INTEGER NOT NULL REFERENCES script_chains(id) ON DELETE CASCADE,
  script_id      INTEGER NOT NULL REFERENCES scripts(id) ON DELETE CASCADE,
  step_order     INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

!!! info "Sortierung"
    `order_index` in `scripts` und `script_chains` wird über die API (`reorderScripts` / `reorderChains`) per Drag & Drop in der UI gesetzt und bleibt persistent gespeichert.

---

## Tabelle: user_presets

Speichert benannte HandBrake-Preset-Sammlungen pro Medientyp.

```sql
CREATE TABLE user_presets (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  name             TEXT NOT NULL,
  media_type       TEXT NOT NULL DEFAULT 'all',  -- 'bluray', 'dvd', 'other', 'all'
  handbrake_preset TEXT,
  extra_args       TEXT,
  description      TEXT,
  created_at       TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

!!! info "Medientyp-Filter"
    `GET /api/settings/user-presets?mediaType=bluray` gibt Presets mit `media_type = 'bluray'` **und** `media_type = 'all'` zurück.

---

## Tabellen: cron_jobs & cron_run_logs

Speichern den Zeitplan und die Ausführungs-Historie des eingebauten Cron-Systems.

```sql
CREATE TABLE cron_jobs (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  name             TEXT NOT NULL,
  cron_expression  TEXT NOT NULL,     -- 5-Felder-Ausdruck (min h d m wd)
  source_type      TEXT NOT NULL,     -- "script" oder "chain"
  source_id        INTEGER NOT NULL,  -- ID des Skripts/der Kette
  enabled          INTEGER NOT NULL DEFAULT 1,
  pushover_enabled INTEGER NOT NULL DEFAULT 1,
  last_run_at      TEXT,
  last_run_status  TEXT,              -- "success", "error", "running"
  next_run_at      TEXT,
  created_at       TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE cron_run_logs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  cron_job_id INTEGER NOT NULL REFERENCES cron_jobs(id) ON DELETE CASCADE,
  started_at  TEXT NOT NULL,
  finished_at TEXT,
  status      TEXT NOT NULL,   -- "success", "error", "running"
  exit_code   INTEGER,
  stdout      TEXT,
  stderr      TEXT,
  triggered_by TEXT NOT NULL DEFAULT 'cron',  -- "cron" oder "manual"
  created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

!!! info "Log-Rotation"
    Pro Cron-Job werden maximal **50 Log-Einträge** gespeichert; ältere Einträge werden automatisch gelöscht. Stdout/Stderr werden auf **100.000 Zeichen** begrenzt.

---

## Schema-Migrationen

`database.js` implementiert **automatische Migrationen**:

1. Beim Start wird das aktuelle Schema geprüft
2. Fehlende Tabellen werden erstellt
3. Fehlende Spalten werden hinzugefügt
4. Neue Default-Einstellungen werden eingefügt

### Korruptions-Recovery

Falls die Datenbankdatei korrupt ist:

```
1. Korrupte Datei wird erkannt (Verbindungsfehler / Integritätsprüfung)
2. Datei wird in backend/data/corrupt-backups/ verschoben
3. Neue, leere Datenbank wird erstellt
4. Schema wird neu initialisiert
5. Log-Eintrag mit Warnung
```

---

## Datenbankpfad konfigurieren

Standard: `./data/ripster.db` (relativ zum Backend-Verzeichnis)

Über Umgebungsvariable anpassen:

```env
DB_PATH=/var/lib/ripster/ripster.db
```

---

## Direkte Datenbankinspektion

```bash
# SQLite3-CLI
sqlite3 backend/data/ripster.db

# Alle Jobs anzeigen
.mode table
SELECT id, status, title, created_at FROM jobs ORDER BY created_at DESC;

# Einstellungen anzeigen
SELECT key, value FROM settings_values;
```
