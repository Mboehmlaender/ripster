# Pipeline API

Alle Endpunkte zur Steuerung des Ripping-Workflows.

---

## GET /api/pipeline/state

Gibt den aktuellen Pipeline-Zustand zurück.

**Response:**

```json
{
  "state": "ENCODING",
  "jobId": 42,
  "job": {
    "id": 42,
    "title": "Inception",
    "status": "ENCODING",
    "imdb_id": "tt1375666",
    "omdb_year": "2010"
  },
  "progress": 73.5,
  "eta": "00:12:34",
  "updatedAt": "2024-01-15T14:30:00.000Z"
}
```

**States:**

| Wert | Beschreibung |
|------|-------------|
| `IDLE` | Wartet auf Disc |
| `ANALYZING` | MakeMKV analysiert |
| `METADATA_SELECTION` | Wartet auf Benutzer |
| `READY_TO_START` | Bereit zum Starten |
| `RIPPING` | Rippen läuft |
| `MEDIAINFO_CHECK` | Track-Analyse |
| `READY_TO_ENCODE` | Wartet auf Bestätigung |
| `ENCODING` | Encoding läuft |
| `FINISHED` | Abgeschlossen |
| `ERROR` | Fehler |

---

## POST /api/pipeline/analyze

Startet eine manuelle Disc-Analyse (ohne Disc-Detection-Trigger).

**Request:** Kein Body erforderlich

**Response:**

```json
{ "ok": true, "message": "Analyse gestartet" }
```

**Fehlerfälle:**
- `409` – Pipeline bereits aktiv

---

## POST /api/pipeline/rescan-disc

Erzwingt eine erneute Disc-Erkennung.

**Response:**

```json
{ "ok": true }
```

---

## GET /api/pipeline/omdb/search

Sucht in der OMDb-API nach einem Filmtitel.

**Query-Parameter:**

| Parameter | Typ | Beschreibung |
|----------|-----|-------------|
| `q` | string | Suchbegriff (Filmtitel) |
| `type` | string | `movie` oder `series` (optional) |

**Beispiel:**

```
GET /api/pipeline/omdb/search?q=Inception&type=movie
```

**Response:**

```json
{
  "results": [
    {
      "imdbId": "tt1375666",
      "title": "Inception",
      "year": "2010",
      "type": "movie",
      "poster": "https://m.media-amazon.com/images/..."
    }
  ]
}
```

---

## POST /api/pipeline/select-metadata

Bestätigt Metadaten und Playlist-Auswahl für den aktuellen Job.

**Request:**

```json
{
  "jobId": 42,
  "omdb": {
    "imdbId": "tt1375666",
    "title": "Inception",
    "year": "2010",
    "type": "movie",
    "poster": "https://..."
  },
  "playlist": "00800.mpls"
}
```

`playlist` ist optional und nur bei Blu-rays relevant.

**Response:**

```json
{ "ok": true }
```

---

## POST /api/pipeline/start/:jobId

Startet den Ripping-Prozess für einen vorbereiteten Job.

**URL-Parameter:** `jobId` – ID des Jobs

**Response:**

```json
{ "ok": true, "message": "Ripping gestartet" }
```

**Fehlerfälle:**
- `404` – Job nicht gefunden
- `409` – Job nicht im Status `READY_TO_START`

---

## POST /api/pipeline/confirm-encode/:jobId

Bestätigt die Encode-Konfiguration mit Track-Auswahl.

**URL-Parameter:** `jobId` – ID des Jobs

**Request:**

```json
{
  "audioTracks": [1, 2],
  "subtitleTracks": [1]
}
```

Track-Indizes entsprechen den 1-basierten Track-Nummern aus dem Encode-Plan.

**Response:**

```json
{ "ok": true, "message": "Encoding gestartet" }
```

---

## POST /api/pipeline/cancel

Bricht den aktuellen Pipeline-Prozess ab.

**Response:**

```json
{ "ok": true, "message": "Pipeline abgebrochen" }
```

Der laufende Prozess wird mit SIGINT beendet (Fallback: SIGKILL nach Timeout).

---

## POST /api/pipeline/retry/:jobId

Wiederholt einen fehlgeschlagenen Job.

**URL-Parameter:** `jobId` – ID des Jobs

**Response:**

```json
{ "ok": true, "message": "Job wird wiederholt" }
```

**Fehlerfälle:**
- `404` – Job nicht gefunden
- `409` – Job nicht im Status `ERROR`

---

## POST /api/pipeline/resume-ready/:jobId

Setzt einen Job im Status `READY_TO_ENCODE` zurück in die aktive Pipeline.

**URL-Parameter:** `jobId` – ID des Jobs

**Response:**

```json
{ "ok": true }
```

---

## POST /api/pipeline/reencode/:jobId

Startet ein erneutes Encoding für einen abgeschlossenen Job (ohne erneutes Ripping).

**URL-Parameter:** `jobId` – ID des Jobs

**Request:**

```json
{
  "audioTracks": [1, 2],
  "subtitleTracks": [1]
}
```

**Response:**

```json
{ "ok": true, "message": "Re-Encoding gestartet" }
```
