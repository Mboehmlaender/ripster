# Pipeline API

Alle Endpunkte zur Steuerung des Ripster-Workflows.

---

## GET /api/pipeline/state

Liefert den aktuellen Pipeline-Snapshot.

**Response:**

```json
{
  "pipeline": {
    "state": "READY_TO_ENCODE",
    "activeJobId": 42,
    "progress": 0,
    "eta": null,
    "statusText": "Mediainfo geladen - bitte bestätigen",
    "context": {
      "jobId": 42
    },
    "queue": {
      "maxParallelJobs": 1,
      "runningCount": 0,
      "queuedCount": 0,
      "runningJobs": [],
      "queuedJobs": []
    }
  }
}
```

**Pipeline-Zustände:**

| Wert | Beschreibung |
|------|-------------|
| `IDLE` | Wartet auf Medium |
| `DISC_DETECTED` | Medium erkannt, wartet auf Analyse-Start |
| `METADATA_SELECTION` | Metadaten-Dialog aktiv |
| `WAITING_FOR_USER_DECISION` | Manuelle Playlist-Auswahl erforderlich |
| `READY_TO_START` | Übergang/Fallback vor Start |
| `RIPPING` | MakeMKV läuft |
| `MEDIAINFO_CHECK` | HandBrake-Scan + Plan-Erstellung |
| `READY_TO_ENCODE` | Review bereit |
| `ENCODING` | HandBrake-Encoding läuft (inkl. Post-Skripte) |
| `FINISHED` | Abgeschlossen |
| `CANCELLED` | Vom Benutzer abgebrochen |
| `ERROR` | Fehler |

---

## POST /api/pipeline/analyze

Startet die Analyse für die aktuell erkannte Disc.

**Request:** kein Body

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

Erzwingt eine erneute Laufwerksprüfung.

**Response (Beispiel):**

```json
{
  "result": {
    "emitted": "discInserted"
  }
}
```

---

## GET /api/pipeline/omdb/search?q=<query>

Sucht OMDb-Titel.

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

Setzt Metadaten (und optional Playlist-Entscheidung).

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

**Response:** `{ "job": { ... } }`

!!! note "Startlogik"
    Nach Metadaten-Bestätigung wird der nächste Schritt automatisch ausgelöst (`startPreparedJob`).
    Der Job startet direkt oder wird in die Queue eingereiht.

---

## POST /api/pipeline/start/:jobId

Startet einen vorbereiteten Job manuell (z. B. Fallback/Queue-Szenario).

**Response (Beispiel):**

```json
{
  "result": {
    "started": true,
    "stage": "RIPPING"
  }
}
```

Mögliche `stage`-Werte sind u. a. `RIPPING`, `MEDIAINFO_CHECK`, `ENCODING`.

---

## POST /api/pipeline/confirm-encode/:jobId

Bestätigt Review-Auswahl (Titel/Tracks/Post-Skripte).

**Request:**

```json
{
  "selectedEncodeTitleId": 1,
  "selectedTrackSelection": {
    "1": {
      "audioTrackIds": [1, 2],
      "subtitleTrackIds": [3]
    }
  },
  "selectedPostEncodeScriptIds": [2, 7],
  "skipPipelineStateUpdate": false
}
```

**Response:** `{ "job": { ... } }`

---

## POST /api/pipeline/cancel

Bricht laufenden Job ab oder entfernt einen Queue-Eintrag.

**Request (optional):**

```json
{
  "jobId": 42
}
```

**Response (Beispiel):**

```json
{
  "result": {
    "cancelled": true,
    "queuedOnly": false,
    "jobId": 42
  }
}
```

---

## POST /api/pipeline/retry/:jobId

Startet einen Job aus `ERROR`/`CANCELLED` erneut (oder reiht ihn in die Queue ein).

**Response:** `{ "result": { ... } }`

---

## POST /api/pipeline/resume-ready/:jobId

Lädt einen `READY_TO_ENCODE`-Job nach Neustart wieder in die aktive Session.

**Response:** `{ "job": { ... } }`

---

## POST /api/pipeline/reencode/:jobId

Startet Re-Encode aus bestehendem RAW.

**Response:** `{ "result": { ... } }`

---

## POST /api/pipeline/restart-review/:jobId

Berechnet die Review aus vorhandenem RAW neu.

**Response:** `{ "result": { ... } }`

---

## POST /api/pipeline/restart-encode/:jobId

Startet Encoding mit der zuletzt bestätigten Auswahl neu.

**Response:** `{ "result": { ... } }`

---

## Queue-Endpunkte

### GET /api/pipeline/queue

Liefert den aktuellen Queue-Status.

**Response:** `{ "queue": { ... } }`

### POST /api/pipeline/queue/reorder

Sortiert Queue-Einträge neu.

**Request:**

```json
{
  "orderedJobIds": [42, 43, 41]
}
```

**Response:** `{ "queue": { ... } }`
