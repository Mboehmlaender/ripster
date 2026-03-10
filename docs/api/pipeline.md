# Pipeline API

Endpunkte zur Steuerung des Pipeline-Workflows.

---

## GET /api/pipeline/state

Liefert aktuellen Pipeline- und Hardware-Monitoring-Snapshot.

**Response (Beispiel):**

```json
{
  "pipeline": {
    "state": "READY_TO_ENCODE",
    "activeJobId": 42,
    "progress": 0,
    "eta": null,
    "statusText": "Mediainfo bestätigt - Encode manuell starten",
    "context": {
      "jobId": 42
    },
    "jobProgress": {
      "42": {
        "state": "MEDIAINFO_CHECK",
        "progress": 68.5,
        "eta": null,
        "statusText": "MEDIAINFO_CHECK 68.50%"
      }
    },
    "queue": {
      "maxParallelJobs": 1,
      "runningCount": 1,
      "queuedCount": 2,
      "runningJobs": [],
      "queuedJobs": []
    }
  },
  "hardwareMonitoring": {
    "enabled": true,
    "intervalMs": 5000,
    "updatedAt": "2026-03-10T09:00:00.000Z",
    "sample": {
      "cpu": {},
      "memory": {},
      "gpu": {},
      "storage": {}
    },
    "error": null
  }
}
```

---

## POST /api/pipeline/analyze

Startet Disc-Analyse und legt Job an.

**Response:**

```json
{
  "result": {
    "jobId": 42,
    "detectedTitle": "INCEPTION",
    "omdbCandidates": []
  }
}
```

---

## POST /api/pipeline/rescan-disc

Erzwingt erneute Laufwerksprüfung.

**Response (Beispiel):**

```json
{
  "result": {
    "present": true,
    "changed": true,
    "emitted": "discInserted",
    "device": {
      "path": "/dev/sr0",
      "discLabel": "INCEPTION",
      "mediaProfile": "bluray"
    }
  }
}
```

---

## GET /api/pipeline/omdb/search?q=<query>

OMDb-Titelsuche.

**Response:**

```json
{
  "results": [
    {
      "imdbId": "tt1375666",
      "title": "Inception",
      "year": "2010",
      "type": "movie",
      "poster": "https://..."
    }
  ]
}
```

---

## POST /api/pipeline/select-metadata

Setzt Metadaten (und optional Playlist) für einen Job.

**Request:**

```json
{
  "jobId": 42,
  "title": "Inception",
  "year": 2010,
  "imdbId": "tt1375666",
  "poster": "https://...",
  "fromOmdb": true,
  "selectedPlaylist": "00800"
}
```

**Response:**

```json
{ "job": { "id": 42, "status": "READY_TO_START" } }
```

---

## POST /api/pipeline/start/:jobId

Startet vorbereiteten Job oder queued ihn (je nach Parallel-Limit).

**Mögliche Responses:**

```json
{ "result": { "started": true, "stage": "RIPPING" } }
```

```json
{ "result": { "queued": true, "started": false, "queuePosition": 2, "action": "START_PREPARED" } }
```

---

## POST /api/pipeline/confirm-encode/:jobId

Bestätigt Review-Auswahl (Tracks, Pre/Post-Skripte/Ketten, User-Preset).

**Request (typisch):**

```json
{
  "selectedEncodeTitleId": 1,
  "selectedTrackSelection": {
    "1": {
      "audioTrackIds": [1, 2],
      "subtitleTrackIds": [3]
    }
  },
  "selectedPreEncodeScriptIds": [1],
  "selectedPostEncodeScriptIds": [2, 7],
  "selectedPreEncodeChainIds": [3],
  "selectedPostEncodeChainIds": [4],
  "selectedUserPresetId": 5,
  "skipPipelineStateUpdate": false
}
```

**Response:**

```json
{ "job": { "id": 42, "encode_review_confirmed": 1 } }
```

---

## POST /api/pipeline/cancel

Bricht laufenden Job ab oder entfernt Queue-Eintrag.

**Request (optional):**

```json
{ "jobId": 42 }
```

**Mögliche Responses:**

```json
{ "result": { "cancelled": true, "queuedOnly": true, "jobId": 42 } }
```

```json
{ "result": { "cancelled": true, "queuedOnly": false, "jobId": 42 } }
```

```json
{ "result": { "cancelled": true, "queuedOnly": false, "pending": true, "jobId": 42 } }
```

---

## POST /api/pipeline/retry/:jobId

Retry für `ERROR`/`CANCELLED`-Jobs (oder Queue-Einreihung).

## POST /api/pipeline/reencode/:jobId

Startet Re-Encode aus bestehendem RAW.

## POST /api/pipeline/restart-review/:jobId

Berechnet Review aus RAW neu.

## POST /api/pipeline/restart-encode/:jobId

Startet Encoding mit letzter bestätigter Review neu.

## POST /api/pipeline/resume-ready/:jobId

Lädt `READY_TO_ENCODE`-Job nach Neustart wieder in aktive Session.

Alle Endpunkte liefern `{ result: ... }` bzw. `{ job: ... }`.

---

## Queue-Endpunkte

### GET /api/pipeline/queue

Liefert Queue-Snapshot.

```json
{
  "queue": {
    "maxParallelJobs": 1,
    "runningCount": 1,
    "queuedCount": 3,
    "runningJobs": [
      {
        "jobId": 41,
        "title": "Inception",
        "status": "ENCODING",
        "lastState": "ENCODING"
      }
    ],
    "queuedJobs": [
      {
        "entryId": 11,
        "position": 1,
        "type": "job",
        "jobId": 42,
        "action": "START_PREPARED",
        "actionLabel": "Start",
        "title": "Matrix",
        "status": "READY_TO_ENCODE",
        "lastState": "READY_TO_ENCODE",
        "hasScripts": true,
        "hasChains": false,
        "enqueuedAt": "2026-03-10T09:00:00.000Z"
      },
      {
        "entryId": 12,
        "position": 2,
        "type": "wait",
        "waitSeconds": 30,
        "title": "Warten 30s",
        "status": "QUEUED",
        "enqueuedAt": "2026-03-10T09:01:00.000Z"
      }
    ],
    "updatedAt": "2026-03-10T09:01:02.000Z"
  }
}
```

### POST /api/pipeline/queue/reorder

Sortiert Queue-Einträge neu.

**Request:**

```json
{
  "orderedEntryIds": [12, 11]
}
```

Legacy fallback wird akzeptiert:

```json
{
  "orderedJobIds": [42, 43]
}
```

### POST /api/pipeline/queue/entry

Fügt Nicht-Job-Queue-Eintrag hinzu (`script`, `chain`, `wait`).

**Request-Beispiele:**

```json
{ "type": "script", "scriptId": 3 }
```

```json
{ "type": "chain", "chainId": 2, "insertAfterEntryId": 11 }
```

```json
{ "type": "wait", "waitSeconds": 45 }
```

**Response:**

```json
{
  "result": { "entryId": 12, "type": "wait", "position": 2 },
  "queue": { "...": "..." }
}
```

### DELETE /api/pipeline/queue/entry/:entryId

Entfernt Queue-Eintrag.

**Response:**

```json
{ "queue": { "...": "..." } }
```

---

## Pipeline-Zustände

| State | Bedeutung |
|------|-----------|
| `IDLE` | Wartet auf Medium |
| `DISC_DETECTED` | Medium erkannt |
| `ANALYZING` | MakeMKV-Analyse läuft |
| `METADATA_SELECTION` | Metadaten-Auswahl |
| `WAITING_FOR_USER_DECISION` | Playlist-Entscheidung erforderlich |
| `READY_TO_START` | Übergang vor Start |
| `RIPPING` | MakeMKV-Rip läuft |
| `MEDIAINFO_CHECK` | Titel-/Track-Auswertung |
| `READY_TO_ENCODE` | Review bereit |
| `ENCODING` | HandBrake-Encoding läuft |
| `FINISHED` | Abgeschlossen |
| `CANCELLED` | Abgebrochen |
| `ERROR` | Fehler |
