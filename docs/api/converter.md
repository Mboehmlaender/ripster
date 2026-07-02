# Converter API

Endpunkte für den Datei-Converter: Datei-Explorer, Upload, Job-Verwaltung.

Basis-Pfad: `/api/converter`

---

## Scan & Explorer

### `GET /api/converter/tree`

Vollständiger Verzeichnisbaum des `converter_raw_dir` (FS-basiert, keine DB).

**Response:**

```json
{
  "tree": [
    {
      "name": "filme",
      "relPath": "filme",
      "isDir": true,
      "children": [
        {
          "name": "film.mkv",
          "relPath": "filme/film.mkv",
          "isDir": false,
          "size": 10485760
        }
      ]
    }
  ]
}
```

---

### `GET /api/converter/browse?parent=relPath`

DB-basierter Datei-Explorer. Gibt Einträge für einen Unterordner zurück.

**Query-Parameter:**

| Parameter | Typ | Beschreibung |
|---|---|---|
| `parent` | string | Relativer Pfad zum Unterordner (leer = Root) |

**Response:**

```json
{
  "entries": [
    {
      "id": 1,
      "rel_path": "filme/film.mkv",
      "is_dir": false,
      "size": 10485760,
      "job_id": null
    }
  ],
  "rawDir": "/data/output/converter-raw"
}
```

---

### `POST /api/converter/scan`

Manuellen Scan des `converter_raw_dir` auslösen. Aktualisiert `converter_scan_entries` in der DB.

**Response:**

```json
{ "result": { "added": 3, "removed": 1 } }
```

---

## Jobs erstellen

### `POST /api/converter/jobs/from-selection`

Jobs aus im Datei-Explorer ausgewählten Dateien erstellen.

**Body:**

```json
{
  "relPaths": ["filme/film.mkv", "musik/track.flac"],
  "audioMode": "individual"
}
```

| Feld | Typ | Beschreibung |
|---|---|---|
| `relPaths` | string[] | Relative Pfade der ausgewählten Dateien |
| `audioMode` | string | `individual` (ein Job pro Datei) oder `shared` (ein gemeinsamer Job) |

**Response:**

```json
{ "jobs": [{ "id": 42, "status": "READY_TO_START" }] }
```

---

### `POST /api/converter/create-jobs`

Jobs aus DB-Scan-Einträgen erstellen.

**Body:**

```json
{
  "entries": [
    { "relPath": "filme/film.mkv", "converterMediaType": "video" }
  ]
}
```

---

### `POST /api/converter/upload`

Dateien hochladen (Multipart, max. 50 Dateien).

**Form-Felder:**

| Feld | Typ | Beschreibung |
|---|---|---|
| `files` | File[] | Hochzuladende Dateien |
| `folderName` | string | (Optional) Ziel-Unterordner |

**Response:**

```json
{
  "folders": [{ "folderRelPath": "upload-2026-03-30", "fileCount": 2 }]
}
```

---

## Job-Verwaltung

### `GET /api/converter/jobs`

Alle Converter-Jobs zurückgeben.

**Response:**

```json
{ "jobs": [{ "id": 42, "status": "READY_TO_START", "title": "film.mkv" }] }
```

---

### `GET /api/converter/jobs/:jobId`

Einzelnen Converter-Job abrufen.

---

### `POST /api/converter/jobs/:jobId/config`

Konfigurationsentwurf für einen Job speichern (persistiert in `encode_plan_json`).

**Body:** Partielles Konfig-Objekt (Ausgabeformat, Presets, Metadaten, Track-Auswahl).

---

### `POST /api/converter/jobs/:jobId/assign-files`

Dateien einem bestehenden (noch nicht gestarteten) Job hinzufügen.

**Body:**

```json
{ "relPaths": ["musik/track2.flac"] }
```

---

### `POST /api/converter/jobs/:jobId/remove-file`

Datei aus einem Job entfernen (per relativer Pfad).

**Body:**

```json
{ "relPath": "musik/track2.flac" }
```

---

### `POST /api/converter/jobs/:jobId/remove-input`

Datei aus einem Job entfernen (per absolutem Eingabepfad).

**Body:**

```json
{ "inputPath": "/data/output/converter-raw/musik/track2.flac" }
```

---

### `POST /api/converter/jobs/:jobId/start`

Job mit finaler Konfiguration starten.

**Body:**

```json
{
  "converterMediaType": "video",
  "outputFormat": "mkv",
  "userPreset": "H.264 MKV 1080p30",
  "trackSelection": {},
  "handBrakeTitleId": 1,
  "audioFormatOptions": {}
}
```

---

### `POST /api/converter/jobs/:jobId/cancel`

Laufenden Job abbrechen.

---

### `DELETE /api/converter/jobs/:jobId`

Job aus der DB löschen.

---

## Datei-Operationen

Alle Datei-Operationen arbeiten direkt auf dem Dateisystem (ohne DB-Aktualisierung). Ein anschließender Scan-Aufruf synchronisiert die DB.

### `DELETE /api/converter/files`

Datei oder Ordner löschen.

**Body:**

```json
{ "relPath": "filme/film.mkv" }
```

---

### `POST /api/converter/files/rename`

Datei oder Ordner umbenennen.

**Body:**

```json
{ "relPath": "filme/film.mkv", "newName": "film-neu.mkv" }
```

---

### `POST /api/converter/files/move`

Datei oder Ordner verschieben.

**Body:**

```json
{ "relPath": "filme/film.mkv", "targetParentRelPath": "archiv" }
```

`targetParentRelPath = ""` verschiebt in das Root-Verzeichnis.

---

### `POST /api/converter/files/folder`

Neuen Ordner anlegen.

**Body:**

```json
{ "parentRelPath": "filme", "name": "neu" }
```
