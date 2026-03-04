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
