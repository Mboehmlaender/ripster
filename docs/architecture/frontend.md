# Frontend-Komponenten

Frontend: React + PrimeReact + Vite.

---

## Hauptseiten

### `RipperPage.jsx`

Pipeline-Steuerung:

- Status/Progress/ETA
- Metadaten-Dialog
- Playlist-Entscheidung
- Review-Panel (Track-Auswahl)
- Queue-Interaktion (reorder/add/remove)
- Job-Aktionen (Start/Cancel/Retry/Re-Encode)
- Hardware-Monitoring-Anzeige
- Aktivitäts-Tracking (Skripte, Ketten, Cron)

### `SettingsPage.jsx`

Konfiguration:

- dynamisches Settings-Formular (`DynamicSettingsForm`)
- Skripte/Ketten inkl. Reorder/Test
- User-Presets
- Cron-Jobs (`CronJobsTab`)

### `HistoryPage.jsx`

Historie:

- Job-Liste/Filter
- Job-Details + Logs
- TMDb-Neuzuordnung
- Re-Encode/Restart-Workflows

### `ConverterPage.jsx`

Datei-Converter:

- Datei-Explorer des Converter-Eingangsordners (Baum-Ansicht)
- Upload von Audio/Video-Dateien (bis zu 50 Dateien gleichzeitig)
- Dateiverwaltung: Umbenennen, Verschieben, Löschen, Ordner erstellen
- Jobs aus Dateiauswahl erstellen
- Converter-Job-Konfiguration (Ausgabeformat, Preset, Tracks)
- Job-Start, Abbruch, Löschung
- Automatischer Scan-Status

### `AudiobooksPage.jsx`

Dedizierter AAX-/Audiobook-Flow:

- Upload-Panel für AAX-Dateien
- aktive Audiobook-Jobkarten mit Start/Cancel/Retry/Delete
- Audiobook-Konfigurationspanel und Output-Explorer

### `DownloadsPage.jsx`

Download-Queue:

- Ausgabedateien aus der Job-Historie in die Queue einreihen
- Download-Status verfolgen (ausstehend, wird verarbeitet, bereit, fehlgeschlagen)
- Dateien als ZIP herunterladen
- Download-Einträge löschen

### `DatabasePage.jsx`

Expert-Modus:

- Tabellarische Rohsicht der Job-Datenbank
- Orphan-RAW-Import

---

## Wichtige Komponenten

- `PipelineStatusCard.jsx` — Pipeline-Status-Anzeige mit Progress
- `MetadataSelectionDialog.jsx` — TMDb-Metadaten-Auswahl
- `MediaInfoReviewPanel.jsx` — Track-Auswahl-Interface (Video/Audio/Untertitel)
- `JobDetailDialog.jsx` — Job-Detailansicht mit Logs
- `CronJobsTab.jsx` — Cron-Job-Verwaltung
- `DynamicSettingsForm.jsx` — Schema-gesteuertes Einstellungsformular
- `ConverterJobCard.jsx` — Converter-Job-Darstellung
- `CdRipConfigPanel.jsx` — Konfiguration für Audio-CD-Ripping

---

## API-Client (`api/client.js`)

- zentraler `request()` mit JSON-Handling
- Fehlerobjekt aus API wird auf `Error(message)` gemappt
- `VITE_API_BASE` default `/api`

---

## WebSocket (`hooks/useWebSocket.js`)

- URL: `VITE_WS_URL` oder automatisch `ws(s)://<host>/ws`
- Auto-Reconnect mit 1500ms Intervall

In `App.jsx` werden u. a. verarbeitet:

- `PIPELINE_STATE_CHANGED`
- `PIPELINE_PROGRESS`
- `PIPELINE_QUEUE_CHANGED`
- Disk erkannt / Disk entfernt
- `HARDWARE_MONITOR_UPDATE`
- `DOWNLOADS_UPDATED`
- `CONVERTER_SCAN_UPDATE`
- `RUNTIME_ACTIVITY_CHANGED`

---

## Build/Run

```bash
# dev
npm run dev --prefix frontend

# prod build
npm run build --prefix frontend
```
