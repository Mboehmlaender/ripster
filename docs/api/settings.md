# Settings API

Endpunkte für Einstellungen, Skripte, Skript-Ketten und User-Presets.

---

## GET /api/settings

Liefert alle Einstellungen kategorisiert.

**Response (Struktur):**

```json
{
  "categories": [
    {
      "category": "Pfade",
      "settings": [
        {
          "key": "raw_dir",
          "label": "Raw Ausgabeordner",
          "type": "path",
          "required": true,
          "description": "...",
          "defaultValue": "data/output/raw",
          "options": [],
          "validation": { "minLength": 1 },
          "value": "data/output/raw",
          "orderIndex": 100
        }
      ]
    }
  ]
}
```

---

## PUT /api/settings/:key

Aktualisiert eine einzelne Einstellung.

**Request:**

```json
{ "value": "/mnt/storage/raw" }
```

**Response:**

```json
{
  "setting": {
    "key": "raw_dir",
    "value": "/mnt/storage/raw"
  },
  "reviewRefresh": {
    "triggered": false,
    "reason": "not_ready"
  }
}
```

`reviewRefresh` ist `null` oder ein Objekt mit Status der optionalen Review-Neuberechnung.

---

## PUT /api/settings

Aktualisiert mehrere Einstellungen atomar.

**Request:**

```json
{
  "settings": {
    "raw_dir": "/mnt/storage/raw",
    "movie_dir": "/mnt/storage/movies",
    "handbrake_preset_bluray": "H.264 MKV 1080p30"
  }
}
```

**Response:**

```json
{
  "changes": [
    { "key": "raw_dir", "value": "/mnt/storage/raw" },
    { "key": "movie_dir", "value": "/mnt/storage/movies" }
  ],
  "reviewRefresh": {
    "triggered": true,
    "jobId": 42,
    "relevantKeys": ["handbrake_preset_bluray"]
  }
}
```

Bei Validierungsfehlern kommt `400` mit `error.details[]`.

---

## GET /api/settings/handbrake-presets

Liest Preset-Liste via `HandBrakeCLI -z` (mit Fallback auf konfigurierte Presets).

**Response (Beispiel):**

```json
{
  "source": "handbrake-cli",
  "message": null,
  "options": [
    { "label": "General/", "value": "__group__general", "disabled": true, "category": "General" },
    { "label": "   Fast 1080p30", "value": "Fast 1080p30", "category": "General" }
  ]
}
```

---

## POST /api/settings/pushover/test

Sendet Testnachricht über aktuelle PushOver-Settings.

**Request (optional):**

```json
{
  "title": "Test",
  "message": "Ripster Test"
}
```

**Response:**

```json
{
  "result": {
    "sent": true,
    "eventKey": "test",
    "requestId": "..."
  }
}
```

Wenn PushOver deaktiviert ist oder Credentials fehlen, kommt i. d. R. ebenfalls `200` mit `sent: false` + `reason`.

---

## Skripte

Basis: `/api/settings/scripts`

### GET /api/settings/scripts

```json
{ "scripts": [ { "id": 1, "name": "...", "scriptBody": "...", "orderIndex": 1, "createdAt": "...", "updatedAt": "..." } ] }
```

### POST /api/settings/scripts

```json
{ "name": "Move", "scriptBody": "mv \"$RIPSTER_OUTPUT_PATH\" /mnt/movies/" }
```

Response: `201` mit `{ "script": { ... } }`

### PUT /api/settings/scripts/:id

Body wie `POST`, Response `{ "script": { ... } }`.

### DELETE /api/settings/scripts/:id

Response `{ "removed": { ... } }`.

### POST /api/settings/scripts/reorder

```json
{ "orderedScriptIds": [3, 1, 2] }
```

Response `{ "scripts": [ ... ] }`.

### POST /api/settings/scripts/:id/test

Führt Skript als Testlauf aus.

```json
{
  "result": {
    "scriptId": 1,
    "scriptName": "Move",
    "success": true,
    "exitCode": 0,
    "signal": null,
    "timedOut": false,
    "durationMs": 120,
    "stdout": "...",
    "stderr": "...",
    "stdoutTruncated": false,
    "stderrTruncated": false
  }
}
```

### Umgebungsvariablen für Skripte

Diese Variablen werden beim Ausführen gesetzt:

- `RIPSTER_SCRIPT_RUN_AT`
- `RIPSTER_JOB_ID`
- `RIPSTER_JOB_TITLE`
- `RIPSTER_MODE`
- `RIPSTER_INPUT_PATH`
- `RIPSTER_OUTPUT_PATH`
- `RIPSTER_RAW_PATH`
- `RIPSTER_SCRIPT_ID`
- `RIPSTER_SCRIPT_NAME`
- `RIPSTER_SCRIPT_SOURCE`

---

## Skript-Ketten

Basis: `/api/settings/script-chains`

Eine Kette hat Schritte vom Typ:

- `script` (`scriptId` erforderlich)
- `wait` (`waitSeconds` 1..3600)

### GET /api/settings/script-chains

Response `{ "chains": [ ... ] }` (inkl. `steps[]`).

### GET /api/settings/script-chains/:id

Response `{ "chain": { ... } }`.

### POST /api/settings/script-chains

```json
{
  "name": "After Encode",
  "steps": [
    { "stepType": "script", "scriptId": 1 },
    { "stepType": "wait", "waitSeconds": 15 },
    { "stepType": "script", "scriptId": 2 }
  ]
}
```

Response: `201` mit `{ "chain": { ... } }`

### PUT /api/settings/script-chains/:id

Body wie `POST`, Response `{ "chain": { ... } }`.

### DELETE /api/settings/script-chains/:id

Response `{ "removed": { ... } }`.

### POST /api/settings/script-chains/reorder

```json
{ "orderedChainIds": [2, 1, 3] }
```

Response `{ "chains": [ ... ] }`.

### POST /api/settings/script-chains/:id/test

Response:

```json
{
  "result": {
    "chainId": 2,
    "chainName": "After Encode",
    "steps": 3,
    "succeeded": 3,
    "failed": 0,
    "aborted": false,
    "results": []
  }
}
```

---

## User-Presets

Basis: `/api/settings/user-presets`

### GET /api/settings/user-presets

Optionaler Query-Parameter: `media_type=bluray|dvd|other|all`

```json
{
  "presets": [
    {
      "id": 1,
      "name": "Blu-ray HQ",
      "mediaType": "bluray",
      "handbrakePreset": "H.264 MKV 1080p30",
      "extraArgs": "--encoder-preset slow",
      "description": "...",
      "createdAt": "...",
      "updatedAt": "..."
    }
  ]
}
```

### POST /api/settings/user-presets

```json
{
  "name": "Blu-ray HQ",
  "mediaType": "bluray",
  "handbrakePreset": "H.264 MKV 1080p30",
  "extraArgs": "--encoder-preset slow",
  "description": "optional"
}
```

Response: `201` mit `{ "preset": { ... } }`

### PUT /api/settings/user-presets/:id

Body mit beliebigen Feldern aus `POST`, Response `{ "preset": { ... } }`.

### DELETE /api/settings/user-presets/:id

Response `{ "removed": { ... } }`.
