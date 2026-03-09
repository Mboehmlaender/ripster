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

Skripte werden über eigene Endpunkte unter `/api/settings/scripts` verwaltet. Jedes Skript hat eine `scriptBody`-Property (der Shell-Befehl oder mehrzeiliges Skript) und einen `orderIndex` für die Sortierung.

### GET /api/settings/scripts

Gibt alle Skripte zurück, sortiert nach `orderIndex`.

**Response:**

```json
{
  "scripts": [
    {
      "id": 1,
      "name": "Zu Plex verschieben",
      "scriptBody": "mv \"$RIPSTER_OUTPUT_PATH\" /mnt/plex/movies/",
      "orderIndex": 1,
      "createdAt": "2026-01-15T10:00:00.000Z",
      "updatedAt": "2026-01-15T10:00:00.000Z"
    }
  ]
}
```

---

### POST /api/settings/scripts

Legt ein neues Skript an.

**Request:**

```json
{
  "name": "Zu Plex verschieben",
  "scriptBody": "mv \"$RIPSTER_OUTPUT_PATH\" /mnt/plex/movies/"
}
```

| Feld | Typ | Pflicht | Beschreibung |
|------|-----|---------|-------------|
| `name` | string | ✅ | Anzeigename (eindeutig) |
| `scriptBody` | string | ✅ | Shell-Befehl oder mehrzeiliges Skript |

**Response:** `201 Created` – `{ "script": { ... } }`

---

### PUT /api/settings/scripts/:id

Aktualisiert ein vorhandenes Skript. Alle Felder optional.

---

### DELETE /api/settings/scripts/:id

Löscht ein Skript.

!!! warning "Referenzen"
    Das Skript wird gelöscht, auch wenn es in Job-Historien referenziert ist. In zukünftigen Reviews erscheint es nicht mehr.

---

### POST /api/settings/scripts/:id/test

Führt ein Skript mit Platzhalter-Umgebungsvariablen aus (Testlauf).

**Response:**

```json
{
  "ok": true,
  "exitCode": 0,
  "stdout": "Testausgabe des Skripts",
  "stderr": "",
  "durationMs": 245
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

### POST /api/settings/scripts/reorder

Ändert die Reihenfolge der Skripte (persistiert in `order_index`).

**Request:**

```json
{ "orderedScriptIds": [3, 1, 2] }
```

**Response:** `{ "scripts": [ ... ] }` – alle Skripte in neuer Reihenfolge.

---

## Skript-Ketten-Verwaltung

Skript-Ketten werden unter `/api/settings/script-chains` verwaltet.

### GET /api/settings/script-chains

Gibt alle Ketten zurück (inkl. Schritte).

### POST /api/settings/script-chains

Legt eine neue Kette an.

```json
{ "name": "Nach Jellyfin deployen" }
```

### PUT /api/settings/script-chains/:id

Aktualisiert eine Kette (Name, Schritte).

### DELETE /api/settings/script-chains/:id

Löscht eine Kette und alle ihre Schritte.

### POST /api/settings/script-chains/:id/test

Führt eine Kette mit Platzhalter-Umgebungsvariablen aus (Testlauf).

**Response:**

```json
{
  "result": {
    "success": true,
    "steps": [
      { "scriptId": 1, "scriptName": "Zu Plex verschieben", "success": true, "exitCode": 0 }
    ]
  }
}
```

### POST /api/settings/script-chains/reorder

Ändert die Reihenfolge der Ketten (persistiert in `order_index`).

**Request:**

```json
{ "orderedChainIds": [2, 1, 3] }
```

---

## User-Presets

Benannte HandBrake-Preset-Sammlungen, die im Encode-Review schnell angewendet werden können. Unter `/api/settings/user-presets` verwaltet.

### GET /api/settings/user-presets

Gibt alle User-Presets zurück. Optional gefiltert per Query-Parameter `mediaType`.

**Query-Parameter:**

| Parameter | Werte | Beschreibung |
|-----------|-------|-------------|
| `mediaType` | `bluray`, `dvd`, `other`, `all` | Filtert Presets nach Medientyp |

**Response:**

```json
{
  "presets": [
    {
      "id": 1,
      "name": "Blu-ray High Quality",
      "mediaType": "bluray",
      "handbrakePreset": "H.265 MKV 1080p30",
      "extraArgs": "--encoder-preset slow",
      "description": "Langsam, aber beste Qualität",
      "createdAt": "2026-01-15T10:00:00.000Z",
      "updatedAt": "2026-01-15T10:00:00.000Z"
    }
  ]
}
```

---

### POST /api/settings/user-presets

Legt ein neues User-Preset an.

**Request:**

```json
{
  "name": "Blu-ray High Quality",
  "mediaType": "bluray",
  "handbrakePreset": "H.265 MKV 1080p30",
  "extraArgs": "--encoder-preset slow",
  "description": "Langsam, aber beste Qualität"
}
```

| Feld | Typ | Pflicht | Beschreibung |
|------|-----|---------|-------------|
| `name` | string | ✅ | Anzeigename |
| `mediaType` | string | — | `bluray`, `dvd`, `other`, `all` (Standard: `all`) |
| `handbrakePreset` | string | — | HandBrake-Preset-Name (`-Z`) |
| `extraArgs` | string | — | Zusatz-CLI-Argumente |
| `description` | string | — | Optionale Beschreibung |

**Response:** `201 Created` – `{ "preset": { ... } }`

---

### PUT /api/settings/user-presets/:id

Aktualisiert ein User-Preset. Alle Felder optional.

---

### DELETE /api/settings/user-presets/:id

Löscht ein User-Preset.

---

## Einstellungs-Schlüssel Referenz

Eine vollständige Übersicht aller Schlüssel:
[:octicons-arrow-right-24: Einstellungsreferenz](../configuration/settings-reference.md)
