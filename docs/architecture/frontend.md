# Frontend-Komponenten

Frontend: React + PrimeReact + Vite.

---

## Hauptseiten

### `DashboardPage.jsx`

Pipeline-Steuerung:

- Status/Progress/ETA
- Metadaten-Dialog
- Playlist-Entscheidung
- Review-Panel
- Queue-Interaktion (reorder/add/remove)
- Job-Aktionen (Start/Cancel/Retry/Re-Encode)
- Hardware-Monitoring-Anzeige

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
- OMDb-Nachzuweisung
- Re-Encode/Restart-Workflows

---

## Wichtige Komponenten

- `PipelineStatusCard.jsx`
- `MetadataSelectionDialog.jsx`
- `MediaInfoReviewPanel.jsx`
- `JobDetailDialog.jsx`
- `CronJobsTab.jsx`

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

---

## Build/Run

```bash
# dev
npm run dev --prefix frontend

# prod build
npm run build --prefix frontend
```
