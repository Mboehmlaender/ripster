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

## POST /api/pipeline/rescan-drive

Erzwingt Rescan für ein konkretes Laufwerk.

**Request:**

```json
{ "devicePath": "/dev/sr0" }
```

---

## GET /api/pipeline/tmdb/movie/search?q=<query>

TMDb-Filmsuche.

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

## GET /api/pipeline/tmdb/series/search?q=<query>&season=<n>

TMDb-Seriensuche (für Serien-Workflow bei DVD/Blu-ray).

---

## GET /api/pipeline/cd/drives

Liefert Snapshot der aktuell bekannten CD-Laufwerke.

---

## GET /api/pipeline/cd/musicbrainz/search?q=<query>

MusicBrainz-Suche für CD-Metadaten.

## GET /api/pipeline/cd/musicbrainz/release/:mbId

Lädt Release-Details zu einer MusicBrainz-ID.

## POST /api/pipeline/cd/select-metadata

Übernimmt CD-Metadaten für einen Job.

**Request (Beispiel):**

```json
{
  "jobId": 91,
  "title": "Album",
  "artist": "Artist",
  "year": 2020,
  "mbId": "f5093c06-23e3-404f-aeaa-40f72885ee3a",
  "coverUrl": "https://...",
  "tracks": []
}
```

## POST /api/pipeline/cd/start/:jobId

Startet/queued CD-Rip mit Format-/Script-/Chain-Konfiguration.

---

## POST /api/pipeline/audiobook/upload

Upload von AAX-Datei (Multipart/FormData).

**FormData-Felder:**

- `file` (Pflicht)
- `format` (optional)
- `startImmediately` (optional)

## GET /api/pipeline/audiobook/pending-activation

Zeigt AAX-Jobs mit fehlenden Activation-Bytes.

## POST /api/pipeline/audiobook/start/:jobId

Startet Audiobook-Job mit optionaler Konfiguration.

## GET /api/pipeline/audiobook/jobs

Liefert Audiobook-Jobliste.

## GET /api/pipeline/audiobook/output-tree

Read-only Baumansicht des Audiobook-Ausgabeordners.

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

Wichtige optionale Felder:

- `selectedHandBrakeTitleId` / `selectedHandBrakeTitleIds`: Titel-Auswahl für Review/MediaInfo.
- `metadataProvider`: `omdb` oder `tmdb`.
- `workflowKind`: bei Disc-Jobs typischerweise `film` oder `series`.
- `discNumber`: Pflicht für Serien-Disc-Zuordnung (`workflowKind=series`).
- `duplicateAction`: Duplikatverhalten bei Film-Metadaten (`allow_new` oder `multipart_movie`).
- `existingJobId`: optionaler Referenzjob für `multipart_movie`.
- `existingDiscNumber`: Disc-Nummer des bestehenden Jobs für `multipart_movie`.

**Response:**

```json
{ "job": { "id": 42, "status": "READY_TO_START" } }
```

**Konflikt-Response (Beispiel, HTTP 409):**

```json
{
  "message": "Metadaten bereits in der Historie gefunden. Bitte Auswahl übernehmen oder Multipart movie wählen.",
  "details": [
    {
      "code": "METADATA_DUPLICATE_FOUND",
      "mediaProfile": "bluray",
      "existingJob": {
        "id": 17,
        "title": "Inception",
        "year": 2010,
        "status": "FINISHED",
        "jobKind": "bluray",
        "discNumber": 1,
        "isMultipartMovie": false
      }
    }
  ]
}
```

**Relevante Fehlercodes (`POST /api/pipeline/select-metadata`):**

| Code | Bedeutung |
|---|---|
| `METADATA_DUPLICATE_FOUND` | Film-Metadaten existieren bereits in der Historie (Konfliktdialog im UI). |
| `MULTIPART_DISC_REQUIRED` | Für Multipart fehlen Disc-Nummern (`discNumber`/`existingDiscNumber`). |
| `MULTIPART_DISC_ALREADY_EXISTS` | Disc-Nummer im Multipart-Container bereits vergeben oder doppelt. |
| `MULTIPART_MEDIA_MISMATCH` | Multipart nur bei gleichem Medientyp (DVD oder Blu-ray). |
| `MULTIPART_SERIES_NOT_ALLOWED` | Multipart ist nur für Film-Jobs erlaubt, nicht für Serien-Workflow. |
| `MULTIPART_METADATA_MISMATCH` | Ausgewählter bestehender Job passt nicht zu den Film-Metadaten. |
| `SERIES_DISC_ALREADY_EXISTS` | Serien-Disc-Nummer innerhalb einer Staffel bereits vorhanden. |

---

## POST /api/pipeline/jobs/:jobId/raw-decision

Trifft Entscheidung bei vorhandenem RAW (`continue` oder `restart` je nach Dialogfluss).

**Request:**

```json
{ "decision": "continue" }
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

## POST /api/pipeline/restart-cd-review/:jobId

Berechnet CD-Review aus vorhandenem RAW neu.

## POST /api/pipeline/resume-ready/:jobId

Lädt `READY_TO_ENCODE`-Job nach Neustart wieder in aktive Session.

## GET /api/pipeline/output-folders/:jobId

Liefert bekannte Output-Ordner entlang der Job-Lineage.

## POST /api/pipeline/delete-output-folders/:jobId

Löscht ausgewählte Output-Ordner.

**Request:**

```json
{ "folderPaths": ["/mnt/movies/Inception (2010)"] }
```

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
| `WAITING_FOR_USER_DECISION` | Nutzerentscheidung erforderlich (Playlist-Auswahl oder RAW-Entscheidung) |
| `READY_TO_START` | Übergang vor Start |
| `RIPPING` | MakeMKV-Rip läuft |
| `MEDIAINFO_CHECK` | Titel-/Track-Auswertung |
| `READY_TO_ENCODE` | Review bereit |
| `ENCODING` | HandBrake-Encoding läuft |
| `CD_METADATA_SELECTION` | CD-Metadatenauswahl aktiv |
| `CD_READY_TO_RIP` | CD-Job ist startbereit |
| `CD_ANALYZING` | CD-Struktur/Tracks werden vorbereitet |
| `CD_RIPPING` | CD-Ripping läuft |
| `CD_ENCODING` | CD-Encode läuft |
| `FINISHED` | Abgeschlossen |
| `DONE` | Abgeschlossen (v. a. Audiobook/Converter/CD-Varianten) |
| `CANCELLED` | Abgebrochen |
| `ERROR` | Fehler |
