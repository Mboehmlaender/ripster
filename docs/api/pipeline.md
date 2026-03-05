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

**Pipeline-Zustände:**

| Wert | Beschreibung |
|------|-------------|
| `IDLE` | Wartet auf Disc |
| `DISC_DETECTED` | Disc erkannt, wartet auf Benutzer |
| `METADATA_SELECTION` | Disc-Scan läuft / Metadaten-Dialog |
| `WAITING_FOR_USER_DECISION` | Mehrere Playlist-Kandidaten – manuelle Auswahl |
| `READY_TO_START` | Bereit zum Starten |
| `RIPPING` | MakeMKV-Ripping läuft |
| `MEDIAINFO_CHECK` | HandBrake-Scan & Encode-Plan-Erstellung |
| `READY_TO_ENCODE` | Wartet auf Encode-Bestätigung |
| `ENCODING` | HandBrake encodiert |
| `POST_ENCODE_SCRIPTS` | Post-Encode-Skripte laufen |
| `FINISHED` | Abgeschlossen |
| `ERROR` | Fehler |

**Kontext-Felder (state-abhängig):**

Beim Zustand `WAITING_FOR_USER_DECISION` enthält die Response zusätzlich:

```json
{
  "state": "WAITING_FOR_USER_DECISION",
  "context": {
    "playlistAnalysis": {
      "evaluatedCandidates": [...],
      "recommendation": { "playlistId": "00800", "score": 18 },
      "manualDecisionRequired": true,
      "manualDecisionReason": "multiple_candidates_after_min_length"
    },
    "playlistCandidates": ["00800", "00801", "00900"]
  }
}
```

---

## POST /api/pipeline/analyze

Startet eine manuelle Disc-Analyse.

**Request:** Kein Body

**Response:**

```json
{ "ok": true, "message": "Analyse gestartet" }
```

**Fehlerfälle:**
- `409` – Pipeline bereits aktiv

---

## POST /api/pipeline/rescan-disc

Erzwingt eine erneute Disc-Erkennung.

**Response:** `{ "ok": true }`

---

## GET /api/pipeline/omdb/search

Sucht in der OMDb-API nach einem Filmtitel.

**Query-Parameter:**

| Parameter | Typ | Beschreibung |
|----------|-----|-------------|
| `q` | string | Suchbegriff |
| `type` | string | `movie` oder `series` (optional) |

**Beispiel:** `GET /api/pipeline/omdb/search?q=Inception&type=movie`

**Response:**

```json
{
  "results": [
    { "imdbId": "tt1375666", "title": "Inception", "year": "2010", "type": "movie", "poster": "https://..." }
  ]
}
```

---

## POST /api/pipeline/select-metadata

Bestätigt Metadaten und optionale Playlist-Auswahl.

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
  "selectedPlaylist": "00800"
}
```

!!! info "Playlist-Felder"
    `selectedPlaylist` ist optional. Wird es beim ersten Aufruf weggelassen (kein Obfuskierungsverdacht), wird die Empfehlung automatisch übernommen.

    Beim zweiten Aufruf aus dem `WAITING_FOR_USER_DECISION`-Dialog reicht es, nur `jobId` + `selectedPlaylist` zu schicken – `omdb` kann dann weggelassen werden.

**Response:** `{ "ok": true }`

---

## POST /api/pipeline/start/:jobId

Startet den Ripping-Prozess.

**URL-Parameter:** `jobId`

**Response:** `{ "ok": true, "message": "Ripping gestartet" }`

**Sonderfall:** Falls für den Job bereits eine Raw-Datei vorhanden ist, wird das Ripping übersprungen und direkt der HandBrake-Scan gestartet.

**Fehlerfälle:**
- `404` – Job nicht gefunden
- `409` – Job nicht im Status `READY_TO_START`

---

## POST /api/pipeline/confirm-encode/:jobId

Bestätigt die Encode-Konfiguration mit Track-Auswahl und Post-Encode-Skripten.

**URL-Parameter:** `jobId`

**Request:**

```json
{
  "selectedEncodeTitleId": 1,
  "selectedTrackSelection": {
    "1": {
      "audioTrackIds": [1, 2],
      "subtitleTrackIds": [1]
    }
  },
  "selectedPostEncodeScriptIds": ["script-abc123", "script-def456"]
}
```

| Feld | Typ | Beschreibung |
|------|-----|-------------|
| `selectedEncodeTitleId` | number | HandBrake-Titel-ID (aus dem Encode-Plan) |
| `selectedTrackSelection` | object | Pro Titel: Audio- und Untertitel-Track-IDs |
| `selectedPostEncodeScriptIds` | string[] | Skript-IDs in Ausführungsreihenfolge (optional) |

!!! note "Track-IDs"
    Die Track-IDs entsprechen den `id`-Feldern aus dem Encode-Plan (`encode_plan_json`), nicht den rohen HandBrake-Track-Nummern.

**Response:** `{ "ok": true, "message": "Encoding gestartet" }`

---

## POST /api/pipeline/cancel

Bricht den aktiven Pipeline-Prozess ab.

**Response:** `{ "ok": true, "message": "Pipeline abgebrochen" }`

SIGINT → graceful exit (10 s Timeout) → SIGKILL.

---

## POST /api/pipeline/retry/:jobId

Wiederholt einen fehlgeschlagenen Job.

**Response:** `{ "ok": true, "message": "Job wird wiederholt" }`

**Fehlerfälle:**
- `404` – Job nicht gefunden
- `409` – Job nicht im Status `ERROR`

---

## POST /api/pipeline/resume-ready/:jobId

Reaktiviert einen Job im Status `READY_TO_ENCODE` in die aktive Pipeline (z. B. nach Neustart).

**Response:** `{ "ok": true }`

---

## POST /api/pipeline/reencode/:jobId

Encodiert eine abgeschlossene Raw-MKV erneut – ohne Ripping.

**Request:**

```json
{
  "selectedEncodeTitleId": 1,
  "selectedTrackSelection": {
    "1": { "audioTrackIds": [1, 2], "subtitleTrackIds": [1] }
  },
  "selectedPostEncodeScriptIds": ["script-abc123"]
}
```

Gleiche Struktur wie `confirm-encode` – ermöglicht andere Track-Auswahl und Skripte als beim ersten Encoding.

**Response:** `{ "ok": true, "message": "Re-Encoding gestartet" }`
