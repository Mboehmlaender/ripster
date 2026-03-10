# History API

Endpunkte für Job-Historie, Orphan-Import und Löschoperationen.

---

## GET /api/history

Liefert Jobs (optionale Filter).

**Query-Parameter:**

| Parameter | Typ | Beschreibung |
|----------|-----|-------------|
| `status` | string | Filter nach Job-Status |
| `search` | string | Suche in Titel-Feldern |

**Beispiel:**

```text
GET /api/history?status=FINISHED&search=Inception
```

**Response:**

```json
{
  "jobs": [
    {
      "id": 42,
      "status": "FINISHED",
      "title": "Inception",
      "raw_path": "/mnt/raw/Inception - RAW - job-42",
      "output_path": "/mnt/movies/Inception (2010)/Inception (2010).mkv",
      "mediaType": "bluray",
      "ripSuccessful": true,
      "encodeSuccess": true,
      "created_at": "2026-03-10T08:00:00.000Z",
      "updated_at": "2026-03-10T10:00:00.000Z"
    }
  ]
}
```

---

## GET /api/history/:id

Liefert Job-Detail.

**Query-Parameter:**

| Parameter | Typ | Standard | Beschreibung |
|----------|-----|---------|-------------|
| `includeLogs` | bool | `false` | Prozesslog laden |
| `includeLiveLog` | bool | `false` | alias-artig ebenfalls Prozesslog laden |
| `includeAllLogs` | bool | `false` | vollständiges Log statt Tail |
| `logTailLines` | number | `800` | Tail-Länge falls nicht `includeAllLogs` |

**Response:**

```json
{
  "job": {
    "id": 42,
    "status": "FINISHED",
    "makemkvInfo": {},
    "mediainfoInfo": {},
    "handbrakeInfo": {},
    "encodePlan": {},
    "log": "...",
    "log_count": 1,
    "logMeta": {
      "loaded": true,
      "total": 800,
      "returned": 800,
      "truncated": true
    }
  }
}
```

---

## GET /api/history/database

Debug-Ansicht der DB-Zeilen (angereichert).

**Response:**

```json
{
  "rows": [
    {
      "id": 42,
      "status": "FINISHED",
      "rawFolderName": "Inception - RAW - job-42"
    }
  ]
}
```

---

## GET /api/history/orphan-raw

Sucht RAW-Ordner ohne zugehörigen Job.

**Response:**

```json
{
  "rawDir": "/mnt/raw",
  "rawDirs": ["/mnt/raw", "/mnt/raw-bluray"],
  "rows": [
    {
      "rawPath": "/mnt/raw/Inception (2010) [tt1375666] - RAW - job-99",
      "folderName": "Inception (2010) [tt1375666] - RAW - job-99",
      "title": "Inception",
      "year": 2010,
      "imdbId": "tt1375666",
      "folderJobId": 99,
      "entryCount": 4,
      "hasBlurayStructure": true,
      "lastModifiedAt": "2026-03-10T09:00:00.000Z"
    }
  ]
}
```

---

## POST /api/history/orphan-raw/import

Importiert RAW-Ordner als FINISHED-Job.

**Request:**

```json
{ "rawPath": "/mnt/raw/Inception (2010) [tt1375666] - RAW - job-99" }
```

**Response:**

```json
{
  "job": { "id": 77, "status": "FINISHED" },
  "uiReset": { "reset": true, "state": "IDLE" }
}
```

---

## POST /api/history/:id/omdb/assign

Weist OMDb-/Metadaten nachträglich zu.

**Request:**

```json
{
  "imdbId": "tt1375666",
  "title": "Inception",
  "year": 2010,
  "poster": "https://...",
  "fromOmdb": true
}
```

**Response:**

```json
{ "job": { "id": 42, "imdb_id": "tt1375666" } }
```

---

## POST /api/history/:id/delete-files

Löscht Dateien eines Jobs, behält DB-Eintrag.

**Request:**

```json
{ "target": "both" }
```

`target`: `raw` | `movie` | `both`

**Response:**

```json
{
  "summary": {
    "target": "both",
    "raw": { "attempted": true, "deleted": true, "filesDeleted": 12, "dirsRemoved": 3, "reason": null },
    "movie": { "attempted": true, "deleted": false, "filesDeleted": 0, "dirsRemoved": 0, "reason": "Movie-Datei/Pfad existiert nicht." }
  },
  "job": { "id": 42 }
}
```

---

## POST /api/history/:id/delete

Löscht Job aus DB; optional auch Dateien.

**Request:**

```json
{ "target": "none" }
```

`target`: `none` | `raw` | `movie` | `both`

**Response:**

```json
{
  "deleted": true,
  "jobId": 42,
  "fileTarget": "both",
  "fileSummary": {
    "target": "both",
    "raw": { "filesDeleted": 10 },
    "movie": { "filesDeleted": 1 }
  },
  "uiReset": {
    "reset": true,
    "state": "IDLE"
  }
}
```

---

## Hinweise

- Ein aktiver Pipeline-Job kann nicht gelöscht werden (`409`).
- Alle Löschoperationen sind irreversibel.
