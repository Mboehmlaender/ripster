# Backend-Services

Das Backend ist in Node.js/Express geschrieben und in **Services** aufgeteilt, die jeweils eine klar abgegrenzte Verantwortlichkeit haben.

---

## pipelineService.js

**Der Kern von Ripster** – orchestriert den gesamten Ripping-Workflow.

### Zuständigkeiten

- Verwaltung des Pipeline-Zustands als State Machine
- Koordination zwischen allen externen Tools
- Generierung von Encode-Plänen
- Fehlerbehandlung und Recovery

### Haupt-Methoden

| Methode | Beschreibung |
|---------|-------------|
| `analyzeDisc()` | Legt Job an und öffnet Metadaten-Auswahl |
| `selectMetadata({...})` | Setzt Metadaten/Playlist und triggert Auto-Start |
| `startPreparedJob(jobId)` | Startet vorbereiteten Job (oder Queue) |
| `confirmEncodeReview(jobId, options)` | Bestätigt Review inkl. Track/Skript-Auswahl |
| `cancel(jobId)` | Bricht laufenden Job ab oder entfernt Queue-Eintrag |
| `retry(jobId)` | Startet fehlgeschlagenen/abgebrochenen Job neu |
| `reencodeFromRaw(jobId)` | Encodiert aus vorhandenem RAW neu |
| `restartReviewFromRaw(jobId)` | Berechnet Review aus RAW neu |
| `restartEncodeWithLastSettings(jobId)` | Neustart mit letzter bestätigter Auswahl |
| `resumeReadyToEncodeJob(jobId)` | Lädt READY_TO_ENCODE nach Neustart in die Session |

### Zustandsübergänge

<div class="pipeline-diagram">

```mermaid
flowchart LR
    START(( )) --> IDLE
    IDLE -->|analyzeDisc()| META[METADATA\nSELECTION]
    META -->|selectMetadata()| RTS[READY_TO\nSTART]
    RTS -->|Auto-Start/Queue| RIP[RIPPING]
    RTS -->|Auto-Start mit RAW| MIC[MEDIAINFO\nCHECK]
    RIP -->|MKV erstellt| MIC[MEDIAINFO\nCHECK]
    MIC -->|Playlist offen| WUD[WAITING_FOR\nUSER_DECISION]
    WUD -->|selectMetadata(selectedPlaylist)| MIC
    MIC -->|Tracks analysiert| RTE[READY_TO\nENCODE]
    RTE -->|confirmEncodeReview() + startPreparedJob()| ENC[ENCODING]
    ENC -->|HandBrake + Post-Skripte fertig| FIN([FINISHED])
    ENC -->|Abbruch| CAN([CANCELLED])
    ENC -->|Fehler| ERR([ERROR])
    RIP -->|Fehler| ERR
    RIP -->|Abbruch| CAN
    ERR -->|retry() / cancel()| IDLE
    CAN -->|retry() / analyzeDisc()| IDLE
    FIN -->|cancel / neue Disc| IDLE

    style FIN fill:#e8f5e9,stroke:#66bb6a,color:#2e7d32
    style CAN fill:#fff3e0,stroke:#fb8c00,color:#e65100
    style ERR fill:#ffebee,stroke:#ef5350,color:#c62828
    style ENC fill:#f3e5f5,stroke:#ab47bc,color:#6a1b9a
    style RIP fill:#e3f2fd,stroke:#42a5f5,color:#1565c0
    style MIC fill:#e3f2fd,stroke:#42a5f5,color:#1565c0
```

</div>

---

## diskDetectionService.js

Überwacht das Disc-Laufwerk auf Disc-Einleger- und Auswurf-Ereignisse.

### Modi

| Modus | Beschreibung |
|------|-------------|
| `auto` | Erkennt verfügbare Laufwerke automatisch |
| `explicit` | Überwacht ein bestimmtes Gerät (z.B. `/dev/sr0`) |

### Polling

Der Service pollt das Laufwerk im konfigurierten Intervall (`disc_poll_interval_ms`, Standard: 4000ms) und emittiert Events:

```js
// Ereignisse
emit('discInserted', { path: '/dev/sr0' })
emit('discRemoved', { path: '/dev/sr0' })
```

---

## processRunner.js

Verwaltet externe CLI-Prozesse.

### Features

- **Streaming**: stdout/stderr werden zeilenweise gelesen
- **Progress-Callbacks**: Ermöglicht Echtzeit-Fortschrittsanzeige
- **Graceful Shutdown**: SIGINT → Warte-Timeout → SIGKILL
- **Prozess-Registry**: Verfolgt aktive Prozesse für sauberes Beenden

### Nutzung

```js
const result = await runProcess(
  'HandBrakeCLI',
  ['--input', rawFile, '--output', outputFile, '--preset', preset],
  {
    onStderr: (line) => parseHandBrakeProgress(line),
    onStdout: (line) => logger.debug(line)
  }
);
```

---

## websocketService.js

WebSocket-Server für Echtzeit-Client-Kommunikation.

### Betrieb

- Läuft auf Pfad `/ws` des Express-Servers
- Hält eine Registry aller verbundenen Clients
- Ermöglicht Broadcast an alle Clients oder gezieltes Senden

### API

```js
broadcast('PIPELINE_STATE_CHANGED', { state, activeJobId });
broadcast('PIPELINE_PROGRESS', { state, progress, eta, statusText });
broadcast('PIPELINE_QUEUE_CHANGED', queueSnapshot);
```

---

## omdbService.js

Integration mit der [OMDb API](https://www.omdbapi.com/).

### Methoden

| Methode | Beschreibung |
|---------|-------------|
| `searchByTitle(title, type)` | Suche nach Titel (movie/series) |
| `fetchById(imdbId)` | Vollständige Metadaten per IMDb-ID |

### Zurückgegebene Daten

```json
{
  "imdbId": "tt1375666",
  "title": "Inception",
  "year": "2010",
  "type": "movie",
  "poster": "https://...",
  "plot": "...",
  "director": "Christopher Nolan"
}
```

---

## settingsService.js

Verwaltet alle Anwendungseinstellungen.

### Features

- **Schema-getriebene Validierung**: Jede Einstellung hat Typ, Grenzen und Pflichtfeld-Flag
- **Kategorisierung**: Einstellungen sind in Kategorien gruppiert (Paths, Tools, Encoding, ...)
- **Persistenz**: Werte in SQLite, Schema ebenfalls in SQLite
- **Defaults**: `defaultSettings.js` definiert Standardwerte

### Einstellungs-Kategorien

| Kategorie | Einstellungen |
|-----------|--------------|
| `Pfade` | `raw_dir`, `movie_dir`, `log_dir` |
| `Laufwerk` | `drive_mode`, `drive_device`, `disc_poll_interval_ms`, `makemkv_source_index` |
| `Monitoring` | `hardware_monitoring_enabled`, `hardware_monitoring_interval_ms` |
| `Tools` | `makemkv_command`, `handbrake_command`, `mediainfo_command`, `pipeline_max_parallel_jobs` |
| `Metadaten` | `omdb_api_key`, `omdb_default_type` |
| `Benachrichtigungen` | `pushover_user_key`, `pushover_api_token` |

---

## historyService.js

Datenbankoperationen für Job-Historie.

### Hauptoperationen

| Operation | Beschreibung |
|-----------|-------------|
| `listJobs(filters)` | Jobs nach Status/Titel filtern |
| `getJob(id)` | Job-Details mit Logs abrufen |
| `findOrphanRawFolders()` | Nicht-getrackte Raw-Ordner finden |
| `importOrphanRaw(path)` | Orphan-Ordner als Job importieren |
| `assignOmdb(id, omdbData)` | OMDb-Metadaten nachträglich zuweisen |
| `deleteJob(id, deleteFiles)` | Job und optional Dateien löschen |

---

## notificationService.js

PushOver-Push-Benachrichtigungen.

```js
await notify({
  title: 'Ripster: Job abgeschlossen',
  message: 'Inception (2010) wurde erfolgreich encodiert'
});
```

---

## logger.js

Strukturiertes Logging mit täglicher Log-Rotation.

### Log-Level

| Level | Verwendung |
|-------|-----------|
| `debug` | Detaillierte Entwicklungs-Informationen |
| `info` | Normale Betriebsereignisse |
| `warn` | Warnungen, die Aufmerksamkeit benötigen |
| `error` | Fehler, die den Betrieb beeinträchtigen |

### Log-Dateien

```
logs/
├── ripster-2024-01-15.log    ← Tages-Log
└── jobs/
    └── job-42-handbrake.log  ← Prozess-spezifische Logs
```
