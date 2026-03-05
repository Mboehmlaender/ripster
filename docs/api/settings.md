# Settings API

Endpunkte zum Lesen und Schreiben der Anwendungseinstellungen.

---

## GET /api/settings

Gibt alle Einstellungen kategorisiert zurück.

**Response:**

```json
{
  "paths": {
    "raw_dir": {
      "value": "/mnt/nas/raw",
      "schema": {
        "type": "string",
        "label": "Raw-Verzeichnis",
        "description": "Speicherort für rohe MKV-Dateien",
        "required": true
      }
    },
    "movie_dir": {
      "value": "/mnt/nas/movies",
      "schema": { ... }
    }
  },
  "tools": { ... },
  "encoding": { ... },
  "drive": { ... },
  "makemkv": { ... },
  "omdb": { ... },
  "notifications": { ... }
}
```

---

## PUT /api/settings/:key

Aktualisiert eine einzelne Einstellung.

**URL-Parameter:** `key` – Einstellungs-Schlüssel

**Request:**

```json
{
  "value": "/mnt/storage/raw"
}
```

**Response:**

```json
{ "ok": true, "key": "raw_dir", "value": "/mnt/storage/raw" }
```

**Fehlerfälle:**
- `400` – Ungültiger Wert (Validierungsfehler)
- `404` – Einstellung nicht gefunden

!!! note "Encode-Review-Refresh"
    Wenn eine encoding-relevante Einstellung geändert wird (z.B. `handbrake_preset`), wird der Encode-Plan für den aktuell wartenden Job automatisch neu berechnet.

---

## PUT /api/settings

Aktualisiert mehrere Einstellungen auf einmal.

**Request:**

```json
{
  "raw_dir": "/mnt/storage/raw",
  "movie_dir": "/mnt/storage/movies",
  "handbrake_preset": "H.265 MKV 720p30"
}
```

**Response:**

```json
{
  "ok": true,
  "updated": ["raw_dir", "movie_dir", "handbrake_preset"],
  "errors": []
}
```

---

## POST /api/settings/pushover/test

Sendet eine Test-Benachrichtigung über PushOver.

**Request:** Kein Body erforderlich (verwendet gespeicherte Zugangsdaten)

**Response (Erfolg):**

```json
{ "ok": true, "message": "Test-Benachrichtigung gesendet" }
```

**Response (Fehler):**

```json
{ "ok": false, "error": "Ungültiger API-Token" }
```

---

## Skript-Verwaltung

Post-Encode-Skripte werden über eigene Endpunkte unter `/api/settings/scripts` verwaltet.

### GET /api/settings/scripts

Gibt alle konfigurierten Skripte zurück.

**Response:**

```json
{
  "scripts": [
    {
      "id": "script-abc123",
      "name": "Zu Plex verschieben",
      "command": "/home/michael/scripts/move-to-plex.sh",
      "description": "Verschiebt die fertige Datei ins Plex-Verzeichnis",
      "createdAt": "2024-01-15T10:00:00.000Z"
    }
  ]
}
```

---

### POST /api/settings/scripts

Legt ein neues Post-Encode-Skript an.

**Request:**

```json
{
  "name": "Zu Plex verschieben",
  "command": "/home/michael/scripts/move-to-plex.sh",
  "description": "Verschiebt die fertige Datei ins Plex-Verzeichnis"
}
```

| Feld | Typ | Pflicht | Beschreibung |
|------|-----|---------|-------------|
| `name` | string | ✅ | Anzeigename |
| `command` | string | ✅ | Shell-Befehl oder absoluter Skriptpfad |
| `description` | string | — | Optionale Beschreibung |

**Response:**

```json
{
  "ok": true,
  "script": {
    "id": "script-abc123",
    "name": "Zu Plex verschieben",
    "command": "/home/michael/scripts/move-to-plex.sh"
  }
}
```

---

### PUT /api/settings/scripts/:scriptId

Aktualisiert ein vorhandenes Skript.

**URL-Parameter:** `scriptId`

**Request:** Gleiche Felder wie beim Anlegen (alle optional).

```json
{ "name": "Zu Jellyfin verschieben", "command": "/home/michael/scripts/move-to-jellyfin.sh" }
```

**Response:** `{ "ok": true }`

---

### DELETE /api/settings/scripts/:scriptId

Löscht ein Skript.

**URL-Parameter:** `scriptId`

**Response:** `{ "ok": true }`

!!! warning "Referenzen in Jobs"
    Wenn das Skript in laufenden oder abgeschlossenen Jobs referenziert wird, wird es trotzdem gelöscht. In zukünftigen Encode-Reviews erscheint es nicht mehr.

---

### POST /api/settings/scripts/:scriptId/test

Führt ein Skript mit Platzhalter-Umgebungsvariablen aus (Testlauf).

**URL-Parameter:** `scriptId`

**Response (Erfolg):**

```json
{
  "ok": true,
  "exitCode": 0,
  "stdout": "Testausgabe des Skripts",
  "stderr": "",
  "durationMs": 245
}
```

**Response (Fehler):**

```json
{
  "ok": false,
  "exitCode": 1,
  "stdout": "",
  "stderr": "Datei nicht gefunden: /home/michael/scripts/move-to-plex.sh",
  "durationMs": 12
}
```

**Platzhalter-Werte beim Testlauf:**

| Variable | Testwert |
|---------|---------|
| `RIPSTER_OUTPUT_PATH` | `/tmp/ripster-test-output.mkv` |
| `RIPSTER_JOB_ID` | `0` |
| `RIPSTER_TITLE` | `Test Film` |
| `RIPSTER_YEAR` | `2024` |
| `RIPSTER_IMDB_ID` | `tt0000000` |
| `RIPSTER_RAW_PATH` | `/tmp/ripster-test-raw.mkv` |

---

## Einstellungs-Schlüssel Referenz

Eine vollständige Liste aller Einstellungs-Schlüssel:

| Schlüssel | Kategorie | Typ | Beschreibung |
|---------|----------|-----|-------------|
| `raw_dir` | paths | string | Raw-MKV Verzeichnis |
| `movie_dir` | paths | string | Ausgabe-Verzeichnis |
| `log_dir` | paths | string | Log-Verzeichnis |
| `makemkv_command` | tools | string | MakeMKV-Befehl |
| `handbrake_command` | tools | string | HandBrake-Befehl |
| `mediainfo_command` | tools | string | MediaInfo-Befehl |
| `handbrake_preset` | encoding | string | HandBrake-Preset-Name |
| `handbrake_extra_args` | encoding | string | Zusatz-Argumente |
| `output_extension` | encoding | string | Dateiendung (z.B. `mkv`) |
| `filename_template` | encoding | string | Dateiname-Template |
| `drive_mode` | drive | select | `auto` oder `explicit` |
| `drive_device` | drive | string | Geräte-Pfad |
| `disc_poll_interval_ms` | drive | number | Polling-Intervall (ms) |
| `makemkv_min_length_minutes` | makemkv | number | Min. Titellänge (Minuten) |
| `makemkv_backup_mode` | makemkv | boolean | Backup-Modus aktivieren |
| `omdb_api_key` | omdb | string | OMDb API-Key |
| `omdb_default_type` | omdb | select | Standard-Suchtyp |
| `pushover_user_key` | notifications | string | PushOver User-Key |
| `pushover_api_token` | notifications | string | PushOver API-Token |
