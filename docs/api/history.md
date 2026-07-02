# History API

Endpunkte für Job-Historie, Metadaten-Nachpflege, Orphan-Import und Löschoperationen.

---

## GET /api/history

Liefert Jobs mit optionalen Filtern.

**Query-Parameter:**

| Parameter | Typ | Beschreibung |
|----------|-----|-------------|
| `status` | string | Einzelstatus-Filter (legacy-kompatibel). |
| `statuses` | string | Mehrfachstatus als CSV, z. B. `FINISHED,ERROR`. |
| `search` | string | Suche in Titel-/IMDb-Feldern. |
| `limit` | number | Maximale Anzahl Ergebnisse. |
| `lite` | bool | Ohne Dateisystem-Checks (schneller). |
| `includeChildren` | bool | Child-Jobs (z. B. Serien-/Multipart-Kinder) explizit einbeziehen. |

**Beispiel:**

```text
GET /api/history?statuses=FINISHED,ERROR&search=Inception&limit=50&lite=1
```

**Response (Beispiel):**

```json
{
  "jobs": [
    {
      "id": 42,
      "status": "FINISHED",
      "title": "Inception",
      "job_kind": "bluray",
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
| `includeLogs` | bool | `false` | Prozesslog laden. |
| `includeLiveLog` | bool | `false` | Live-/Tail-Log laden. |
| `includeAllLogs` | bool | `false` | vollständiges Log statt Tail. |
| `logTailLines` | number | `800` | Tail-Länge falls nicht `includeAllLogs`. |
| `lite` | bool | `false` | Detailantwort ohne FS-Checks. |

**Response (Beispiel):**

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

## GET /api/history/orphan-raw

Sucht RAW-Ordner ohne zugehörigen Job.

## POST /api/history/orphan-raw/import

Importiert einen RAW-Ordner als Job und triggert optional die Analyse des Imports.

**Request:**

```json
{ "rawPath": "/mnt/raw/Inception (2010) [tt1375666] - RAW - job-99" }
```

**Response (Beispiel):**

```json
{
  "job": { "id": 77, "status": "FINISHED" },
  "activation": { "started": true },
  "activationError": null
}
```

---

## POST /api/history/:id/metadata/assign

Weist TMDb-Metadaten nachträglich zu oder aktualisiert bestehende Film-/Serien-Metadaten eines Jobs.

## POST /api/history/:id/cd/assign

Weist CD-Metadaten (z. B. MusicBrainz) nachträglich zu.

## POST /api/history/:id/error/ack

Quittiert einen Fehlerzustand im Historieneintrag.

---

## GET /api/history/:id/delete-preview

Liefert eine Vorschau der löschbaren Pfade (inkl. Scope auf verknüpfte Jobs).

**Query-Parameter:**

| Parameter | Typ | Standard | Beschreibung |
|----------|-----|---------|-------------|
| `includeRelated` | bool | `true` | Verknüpfte Jobs in die Vorschau einbeziehen. |

**Response (Beispiel):**

```json
{
  "preview": {
    "jobId": 42,
    "relatedJobs": [{ "id": 42 }, { "id": 73 }],
    "pathCandidates": {
      "raw": [{ "path": "/mnt/raw/...", "exists": true, "isDirectory": true }],
      "movie": [{ "path": "/mnt/movies/...", "exists": true, "isDirectory": true }]
    }
  }
}
```

---

## POST /api/history/:id/delete-files

Löscht Dateien eines Jobs, behält DB-Eintrag.

**Request:**

```json
{
  "target": "both",
  "includeRelated": true,
  "selectedRawPaths": ["/mnt/raw/Inception - RAW - Disc1"],
  "selectedMoviePaths": ["/mnt/movies/Inception (2010)"]
}
```

`target`: `raw` | `movie` | `both`

`selectedRawPaths` / `selectedMoviePaths` sind optional und begrenzen die Löschung auf ausgewählte Pfade aus der Vorschau.

---

## POST /api/history/:id/delete

Löscht Job aus DB; optional auch Dateien.

**Request:**

```json
{
  "target": "both",
  "includeRelated": true,
  "resetDriveState": false,
  "keepDetectedDevice": true,
  "preserveRawForImportJobs": false,
  "selectedRawPaths": ["/mnt/raw/Inception - RAW - Disc1"],
  "selectedMoviePaths": ["/mnt/movies/Inception (2010)"]
}
```

`target`: `none` | `raw` | `movie` | `both`

**Response (Beispiel):**

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
  },
  "safeguards": {
    "containsOrphanRawImportJob": false,
    "resetDriveStateApplied": false,
    "keepDetectedDeviceApplied": true
  }
}
```

---

## Hinweise

- Ein aktiver Pipeline-Job kann nicht gelöscht werden (`409`).
- Löschoperationen sind irreversibel.
- Bei Serien-/Multipart-Containern steuern `includeRelated` und Pfadselektionen den genauen Scope.
