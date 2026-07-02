# Downloads API

Endpunkte für die Download-Queue. Ausgabedateien aus der Job-Historie können als ZIP heruntergeladen werden.

Basis-Pfad: `/api/downloads`

---

## `GET /api/downloads`

Liste aller Download-Einträge plus Zusammenfassung.

**Response:**

```json
{
  "items": [
    {
      "id": "dl-42-raw",
      "jobId": 42,
      "target": "raw",
      "status": "ready",
      "archiveName": "Job_42_raw.zip",
      "outputPath": null,
      "createdAt": "2026-03-30T10:00:00.000Z",
      "updatedAt": "2026-03-30T10:01:00.000Z",
      "errorMessage": null
    }
  ],
  "summary": {
    "total": 3,
    "pending": 1,
    "processing": 0,
    "ready": 1,
    "failed": 1
  }
}
```

**Status-Werte:**

| Status | Beschreibung |
|---|---|
| `pending` | In der Queue, noch nicht gestartet |
| `processing` | ZIP wird gerade erstellt |
| `ready` | ZIP fertig, Download verfügbar |
| `failed` | Fehler bei der Erstellung |

---

## `GET /api/downloads/summary`

Nur die Zusammenfassung der Download-Queue (ohne Item-Liste).

**Response:**

```json
{
  "summary": {
    "total": 3,
    "pending": 1,
    "processing": 0,
    "ready": 1,
    "failed": 1
  }
}
```

---

## `POST /api/downloads/history/:jobId`

Job-Ausgabe in die Download-Queue einreihen.

**Parameter:**

| Parameter | Typ | Beschreibung |
|---|---|---|
| `jobId` | number | ID des Jobs in der Historie |

**Body:**

```json
{
  "target": "raw",
  "outputPath": null
}
```

| Feld | Typ | Default | Beschreibung |
|---|---|---|---|
| `target` | string | `raw` | `raw` (RAW-Dateien) oder `movie` (Ausgabedateien) |
| `outputPath` | string | `null` | Optionaler expliziter Ausgabepfad |

**Response (201 Created):**

```json
{
  "created": true,
  "id": "dl-42-raw",
  "status": "pending",
  "summary": { "total": 1, "pending": 1, "processing": 0, "ready": 0, "failed": 0 }
}
```

Ist der Eintrag bereits vorhanden, wird `201` durch `200` ersetzt und `created: false` zurückgegeben.

---

## `GET /api/downloads/:id/file`

Fertige ZIP-Datei herunterladen.

**Parameter:**

| Parameter | Typ | Beschreibung |
|---|---|---|
| `id` | string | Download-ID (z. B. `dl-42-raw`) |

**Response:** Datei-Download (`Content-Disposition: attachment`).

Schlägt fehl mit `404`, wenn kein Download-Eintrag mit dieser ID existiert oder die Datei noch nicht bereit ist.

---

## `DELETE /api/downloads/:id`

Download-Eintrag löschen (auch fertige ZIP-Dateien werden vom Dateisystem entfernt).

**Response:**

```json
{
  "ok": true,
  "summary": { "total": 2, "pending": 0, "processing": 0, "ready": 2, "failed": 0 }
}
```

---

## WebSocket

Statusänderungen werden über `DOWNLOADS_UPDATED` in Echtzeit gemeldet. Vollständige Dokumentation: [WebSocket Events](websocket.md#downloads_updated).
