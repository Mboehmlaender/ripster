# Backend-Services

Das Backend ist in Services aufgeteilt, die von Express-Routen orchestriert werden. Seit v0.12.0 erfolgt die Medienverarbeitung über ein **Plugin-System**.

---

## Plugin-System (`src/plugins/`)

Ab v0.12.0 ist die Pipeline modular aufgebaut. Jeder Medientyp wird von einem eigenen Plugin verwaltet.

### Basisklassen

- **`PluginBase.js`** — Abstrakte Basisklasse `SourcePlugin` mit Lifecycle-Methoden
- **`PluginRegistry.js`** — Dynamische Plugin-Erkennung, prioritätsbasierte Auswahl, Settings-Schema-Aggregation
- **`PluginContext.js`** — Ausführungskontext (Logger, Callbacks, Signals) für Plugin-Aufrufe

### Plugin-Lifecycle

Jedes Plugin implementiert die folgenden Methoden:

| Methode | Beschreibung |
|---|---|
| `detect(discInfo)` | Medientyp-Erkennung |
| `analyze(devicePath, job, ctx)` | Analyse / Metadaten-Extraktion |
| `rip(job, ctx)` | Rohdaten-Extraktion |
| `review(job, ctx)` | Optionale Vorschau-Vorbereitung |
| `encode(job, ctx)` | Finales Encoding/Konvertierung |
| `finalize(job, ctx)` | Nachbearbeitung |
| `onCancel(job, ctx)` | Bereinigung bei Abbruch |
| `onRetry(job, ctx)` | Zustand-Reset vor Retry |

### Implementierte Plugins

- **`BluRayPlugin.js`** — Blu-ray via MakeMKV (Backup-Modus)
- **`DVDPlugin.js`** — DVD via MakeMKV (MKV-Modus)
- **`CdPlugin.js`** — Audio-CD via cdparanoia + FFmpeg (experimentell)
- **`AudiobookPlugin.js`** — AAX/M4B via FFmpeg mit Kapitel-Splitting
- **`ConverterPlugin.js`** — Generische Audio/Video-Konvertierung via FFmpeg
- **`VideoDiscPlugin.js`** — Gemeinsame Basis für Blu-ray/DVD (MediaInfo-Parsing)

---

## `pipelineService.js`

Zentrale Workflow-Orchestrierung.

Aufgaben:

- Pipeline-State-Machine + Persistenz (`pipeline_state`)
- Disc-Analyse/Rip/Review/Encode via Plugin-Delegation
- Queue-Management (Jobs + `script|chain|wait` Einträge)
- Retry/Re-Encode/Restart-Flows
- WebSocket-Broadcasts für State/Progress/Queue
- Converter-Job-Verwaltung (`createConverterJobFromEntry`, `uploadConverterFiles`, `startConverterJob`)

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
- `createConverterJobFromEntry()`, `createConverterJobsFromSelection()`
- `uploadConverterFiles()`, `startConverterJob()`

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
- CLI-Config-Building für MakeMKV/HandBrake/MediaInfo/FFmpeg
- HandBrake-Preset-Liste via `HandBrakeCLI -z`
- MakeMKV-Key-Synchronisation aus `makemkv_registration_key` nach `~/.MakeMKV/settings.conf`
- Pfadauflösung für alle Medienprofile inkl. Audiobook und Converter

---

## `historyService.js`

Historie + Dateioperationen.

Features:

- Job-Liste/Detail inkl. Log-Tail
- Orphan-RAW-Erkennung und Import
- TMDb-Neuzuordnung
- Dateilöschung (`raw|movie|both`)
- Job-Löschung (`none|raw|movie|both`)

---

## `audiobookService.js`

Audiobook-Verarbeitung (AAX/M4B).

Features:

- FFprobe-basierte Analyse (Kapitel, Metadaten)
- FFmpeg-basiertes Encoding mit Kapitel-Splitting
- Ausgabeformate: M4B, MP3, FLAC
- Template-basierte Pfade (`{author}`, `{title}`, `{year}`, `{narrator}`, `{series}`, `{part}`)

---

## `activationBytesService.js`

Verwaltung von Audible-Activation-Bytes für AAX-DRM-Handling.

Features:

- SHA-1-Prüfsumme der AAX-Datei berechnen
- Activation Bytes in `aax_activation_bytes`-Tabelle cachen
- Lookup via `audnexService` (wenn konfiguriert)

---

## `converterScanService.js`

Dateisystem-Überwachung des Converter-Eingangsordners.

Features:

- Vollständiger FS-Baum (`getTree()`)
- DB-basierter Datei-Explorer (`getEntries()`)
- Manueller und automatischer Scan (Polling)
- Pfad-Normalisierung mit Traversal-Schutz
- WebSocket-Broadcast: `CONVERTER_SCAN_UPDATE`

---

## `downloadService.js`

Download-Queue für Ausgabedateien aus der Historie.

Features:

- Job in Download-Queue einreihen (`enqueueHistoryJob`)
- ZIP-Archiv aus Ausgabedateien erstellen (`archiver`)
- Datei-Streaming via `res.download()`
- WebSocket-Broadcast: `DOWNLOADS_UPDATED` bei Status-Änderungen
- Download-Item löschen

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
- `cdRipService.js` (CD-Ripping mit cdparanoia)
- `musicBrainzService.js` (MusicBrainz-Metadaten-Lookup)
- `audnexService.js` (Audnex-API für Audiobook-Metadaten)
- `coverArtRecoveryService.js` (Cover-Art-Wiederherstellung)
- `thumbnailService.js` (Vorschaubild-Generierung)
- `tmdbService.js` (Film-/Serien-Metadaten-Suche)
- `logger.js` (rotierende Datei-Logs)

---

## Bootstrapping (`src/index.js`)

Beim Start:

1. DB init/migrate
2. Pipeline-Init (inkl. Plugin-Registry)
3. Cron-Init
4. Express-Routes + Error-Handler
5. WebSocket-Server auf `/ws`
6. Hardware-Monitoring-Init
7. Disk-Detection-Start
8. Converter-Scan-Service-Init (Polling falls aktiviert)
