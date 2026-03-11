# Backend-Services

Das Backend ist in Services aufgeteilt, die von Express-Routen orchestriert werden.

---

## `pipelineService.js`

Zentrale Workflow-Orchestrierung.

Aufgaben:

- Pipeline-State-Machine + Persistenz (`pipeline_state`)
- Disc-Analyse/Rip/Review/Encode
- Queue-Management (Jobs + `script|chain|wait` Einträge)
- Retry/Re-Encode/Restart-Flows
- WebSocket-Broadcasts für State/Progress/Queue

Wichtige Methoden:

- `analyzeDisc()`
- `selectMetadata()`
- `startPreparedJob()`
- `confirmEncodeReview()`
- `cancel()`
- `retry()`
- `reencodeFromRaw()`
- `restartReviewFromRaw()`
- `restartEncodeWithLastSettings()`
- `resumeReadyToEncodeJob()`
- `enqueueNonJobEntry()`, `reorderQueue()`, `removeQueueEntry()`

---

## `diskDetectionService.js`

Pollt Laufwerk(e) und emittiert:

- `discInserted`
- `discRemoved`
- `error`

Zusatz:

- Modus `auto` oder `explicit`
- heuristische `mediaProfile`-Erkennung (`bluray`/`dvd`/`other`)
- `rescanAndEmit()` für manuellen Trigger

---

## `settingsService.js`

Settings-Layer mit Validation/Serialisierung.

Features:

- `getCategorizedSettings()` für UI-Form
- `setSettingValue()` / `setSettingsBulk()`
- profilspezifische Auflösung (`resolveEffectiveToolSettings`)
- CLI-Config-Building für MakeMKV/HandBrake/MediaInfo
- HandBrake-Preset-Liste via `HandBrakeCLI -z`
- MakeMKV-Registration-Command aus `makemkv_registration_key`

---

## `historyService.js`

Historie + Dateioperationen.

Features:

- Job-Liste/Detail inkl. Log-Tail
- Orphan-RAW-Erkennung und Import
- OMDb-Nachzuweisung
- Dateilöschung (`raw|movie|both`)
- Job-Löschung (`none|raw|movie|both`)

---

## `cronService.js`

Integriertes Cron-System ohne externe Parser-Library.

Features:

- 5-Feld-Cron-Parser + `nextRun`-Berechnung
- Quellen: `script` oder `chain`
- Laufzeitlogs (`cron_run_logs`)
- manuelles Triggern
- WebSocket-Events: `CRON_JOBS_UPDATED`, `CRON_JOB_UPDATED`

---

## `runtimeActivityService.js`

In-Memory-Tracking aller laufenden und kürzlich abgeschlossenen Aktivitäten (Skripte, Ketten, Cron-Jobs, Tasks).

Features:

- `startActivity(type, payload)` → Aktivität registrieren, ID zurückgeben
- `updateActivity(id, patch)` → Laufende Aktivität aktualisieren
- `completeActivity(id, payload)` → Aktivität abschließen und in `recent` verschieben
- `setControls(id, { cancel, nextStep })` → Steuer-Handler registrieren (für `canCancel`/`canNextStep`)
- `requestCancel(id)` / `requestNextStep(id)` → Steuer-Handler aufrufen
- `clearRecent()` → Abgeschlossene Aktivitäten löschen
- `getSnapshot()` → Snapshot mit `active` + `recent` + `updatedAt`
- Broadcasts `RUNTIME_ACTIVITY_CHANGED` über WebSocket bei jeder Änderung

Limits:

- `recent` max. 120 Einträge
- `stdout`/`stderr`/`output` max. 12.000 Zeichen
- `message`/`errorMessage` max. 2.000 Zeichen

Vollständige API-Dokumentation: [Runtime Activities API](../api/runtime-activities.md)

---

## Weitere Services

- `scriptService.js` (CRUD + Test + Wrapper-Ausführung)
- `scriptChainService.js` (CRUD + Step-Execution)
- `userPresetService.js` (HandBrake User-Presets)
- `hardwareMonitorService.js` (CPU/RAM/GPU/Storage)
- `websocketService.js` (Client-Registry + Broadcast)
- `notificationService.js` (PushOver)
- `logger.js` (rotierende Datei-Logs)

---

## Bootstrapping (`src/index.js`)

Beim Start:

1. DB init/migrate
2. Pipeline-Init
3. Cron-Init
4. Express-Routes + Error-Handler
5. WebSocket-Server auf `/ws`
6. Hardware-Monitoring-Init
7. Disk-Detection-Start
