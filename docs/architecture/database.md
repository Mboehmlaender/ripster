# Datenbank

Ripster verwendet **SQLite3** als Datenbank. Die Datenbankdatei liegt unter `backend/data/ripster.db`.

---

## Schema-Übersicht

```sql
-- Vier Haupt-Tabellen
settings_schema    -- Einstellungs-Definitionen
settings_values    -- Benutzer-Werte
jobs               -- Rip-Job-Datensätze
pipeline_state     -- Aktueller Pipeline-Zustand (Singleton)
```

---

## Tabelle: jobs

Die wichtigste Tabelle – speichert alle Ripping-Jobs.

```sql
CREATE TABLE jobs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  status          TEXT NOT NULL,        -- Aktueller Status
  title           TEXT,                 -- Filmtitel (von OMDb)
  imdb_id         TEXT,                 -- IMDb-ID
  omdb_year       TEXT,                 -- Erscheinungsjahr
  omdb_type       TEXT,                 -- movie/series
  omdb_poster     TEXT,                 -- Poster-URL
  raw_path        TEXT,                 -- Pfad zur Raw-MKV
  output_path     TEXT,                 -- Pfad zur Ausgabedatei
  playlist        TEXT,                 -- Gewählte Blu-ray Playlist
  makemkv_output  TEXT,                 -- MakeMKV-Ausgabe (JSON)
  mediainfo_output TEXT,                -- MediaInfo-Ausgabe (JSON)
  encode_plan     TEXT,                 -- Encode-Plan (JSON)
  handbrake_log   TEXT,                 -- HandBrake Log-Pfad
  error_message   TEXT,                 -- Fehlermeldung bei ERROR
  error_details   TEXT                  -- Detaillierte Fehler-Infos
);
```

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
2. Datei wird in /backend/data/quarantine/ verschoben
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
