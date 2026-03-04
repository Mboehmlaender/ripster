# History API

Endpunkte für die Job-Histoire, Dateimanagement und Orphan-Import.

---

## GET /api/history

Gibt eine Liste aller Jobs zurück, optional gefiltert.

**Query-Parameter:**

| Parameter | Typ | Beschreibung |
|----------|-----|-------------|
| `status` | string | Filtert nach Status (z.B. `FINISHED`, `ERROR`) |
| `search` | string | Sucht in Filmtiteln |

**Beispiel:**

```
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
      "imdb_id": "tt1375666",
      "omdb_year": "2010",
      "omdb_type": "movie",
      "omdb_poster": "https://...",
      "raw_path": "/mnt/nas/raw/Inception_t00.mkv",
      "output_path": "/mnt/nas/movies/Inception (2010).mkv",
      "created_at": "2024-01-15T10:00:00.000Z",
      "updated_at": "2024-01-15T12:30:00.000Z"
    }
  ],
  "total": 1
}
```

---

## GET /api/history/:id

Gibt Detail-Informationen für einen einzelnen Job zurück.

**URL-Parameter:** `id` – Job-ID

**Query-Parameter:**

| Parameter | Typ | Standard | Beschreibung |
|----------|-----|---------|-------------|
| `includeLogs` | boolean | `false` | Log-Inhalte einschließen |
| `includeLiveLog` | boolean | `false` | Aktuellen Live-Log einschließen |

**Response:**

```json
{
  "id": 42,
  "status": "FINISHED",
  "title": "Inception",
  "imdb_id": "tt1375666",
  "encode_plan": { ... },
  "makemkv_output": { ... },
  "mediainfo_output": { ... },
  "handbrake_log": "/path/to/log",
  "logs": {
    "handbrake": "Encoding: task 1 of 1, 100.0%\n..."
  },
  "created_at": "2024-01-15T10:00:00.000Z",
  "updated_at": "2024-01-15T12:30:00.000Z"
}
```

---

## GET /api/history/database

Gibt alle rohen Datenbankzeilen zurück (Debug-Ansicht).

**Response:**

```json
{
  "jobs": [ { "id": 1, "status": "FINISHED", ... } ],
  "total": 15
}
```

---

## GET /api/history/orphan-raw

Findet Raw-Ordner, die nicht als Jobs in der Datenbank registriert sind.

**Response:**

```json
{
  "orphans": [
    {
      "path": "/mnt/nas/raw/UnknownMovie_2023-12-01",
      "size": "45.2 GB",
      "modifiedAt": "2023-12-01T15:00:00.000Z",
      "files": ["t00.mkv", "t01.mkv"]
    }
  ]
}
```

---

## POST /api/history/orphan-raw/import

Importiert einen Orphan-Raw-Ordner als Job in die Datenbank.

**Request:**

```json
{
  "path": "/mnt/nas/raw/UnknownMovie_2023-12-01"
}
```

**Response:**

```json
{
  "ok": true,
  "jobId": 99,
  "message": "Orphan-Ordner als Job importiert"
}
```

Nach dem Import kann dem Job über `/api/history/:id/omdb/assign` Metadaten zugewiesen werden.

---

## POST /api/history/:id/omdb/assign

Weist einem bestehenden Job OMDb-Metadaten nachträglich zu.

**URL-Parameter:** `id` – Job-ID

**Request:**

```json
{
  "imdbId": "tt1375666",
  "title": "Inception",
  "year": "2010",
  "type": "movie",
  "poster": "https://..."
}
```

**Response:**

```json
{ "ok": true }
```

---

## POST /api/history/:id/delete-files

Löscht die Dateien eines Jobs (Raw und/oder Output), behält den Job-Eintrag.

**URL-Parameter:** `id` – Job-ID

**Request:**

```json
{
  "deleteRaw": true,
  "deleteOutput": false
}
```

**Response:**

```json
{
  "ok": true,
  "deleted": {
    "raw": "/mnt/nas/raw/Inception_t00.mkv",
    "output": null
  }
}
```

---

## POST /api/history/:id/delete

Löscht den Job-Eintrag aus der Datenbank, optional auch die Dateien.

**URL-Parameter:** `id` – Job-ID

**Request:**

```json
{
  "deleteFiles": true
}
```

**Response:**

```json
{ "ok": true, "message": "Job gelöscht" }
```

!!! warning "Unwiderruflich"
    Das Löschen von Jobs und Dateien ist nicht rückgängig zu machen.
