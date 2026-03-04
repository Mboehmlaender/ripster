# Architektur-Übersicht

---

## Kern-Designprinzipien

### Event-Driven Pipeline

Der gesamte Ripping-Workflow ist als **State Machine** implementiert. Der `pipelineService` verwaltet den aktuellen Zustand und emittiert Ereignisse bei jedem Zustandswechsel. Der WebSocket-Service überträgt diese Ereignisse sofort an alle verbundenen Clients.

```
Zustandswechsel → Event → WebSocket → Frontend-Update
```

### Service-Layer-Muster

```
HTTP-Route → Service → Datenbank
```

Routes delegieren die gesamte Business-Logik an Services. Services sind voneinander unabhängig und können einzeln getestet werden.

### Schema-getriebene Einstellungen

Die Settings-Konfiguration definiert **sowohl** die Validierungsregeln als auch die UI-Struktur in einer einzigen Quelle (`settings_schema`-Tabelle). Die `DynamicSettingsForm`-Komponente rendert das Formular dynamisch aus dem Schema.

---

## Echtzeit-Kommunikation

### WebSocket-Protokoll

Der WebSocket-Server läuft unter dem Pfad `/ws`. Nachrichten werden als JSON übertragen:

```json
{
  "type": "PIPELINE_STATE_CHANGE",
  "data": {
    "state": "ENCODING",
    "jobId": 42,
    "progress": 73.5,
    "eta": "00:12:34"
  }
}
```

**Nachrichtentypen:**

| Typ | Beschreibung |
|----|-------------|
| `PIPELINE_STATE_CHANGE` | Pipeline-Zustand hat gewechselt |
| `PROGRESS_UPDATE` | Fortschritt (% und ETA) |
| `DISC_DETECTED` | Disc wurde erkannt |
| `DISC_REMOVED` | Disc wurde entfernt |
| `ERROR` | Fehler aufgetreten |
| `JOB_COMPLETE` | Job abgeschlossen |

### Reconnect-Logik

Der Frontend-Hook `useWebSocket.js` implementiert automatisches Reconnect mit exponential backoff bei Verbindungsabbrüchen.

---

## Prozess-Management

### processRunner.js

Externe Tools (MakeMKV, HandBrake, MediaInfo) werden als **Child Processes** gestartet:

```js
spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
```

- **stdout/stderr** werden zeilenweise gelesen und in Echtzeit verarbeitet
- **Progress-Parsing** erfolgt über reguläre Ausdrücke in `progressParsers.js`
- **Graceful Shutdown**: SIGINT → Timeout → SIGKILL
- **Prozess-Tracking**: Aktive Prozesse werden registriert für sauberes Beenden

---

## Datenpersistenz

### SQLite-Datenbank

Ripster verwendet eine **einzige SQLite-Datei** für alle persistenten Daten:

```
backend/data/ripster.db
```

**Tabellen:**

| Tabelle | Inhalt |
|---------|--------|
| `jobs` | Alle Rip-Jobs mit Status, Logs, Metadaten |
| `pipeline_state` | Aktueller Pipeline-Zustand (Singleton) |
| `settings_schema` | Schema aller verfügbaren Einstellungen |
| `settings_values` | Benutzer-konfigurierte Werte |

### Migrations-Strategie

Beim Start prüft `database.js` automatisch, ob das Schema aktuell ist, und führt fehlende Migrationen aus. Korrupte Datenbankdateien werden in ein Quarantäne-Verzeichnis verschoben und eine neue Datenbank erstellt.

---

## Fehlerbehandlung

### Strukturierte Fehler

Alle Fehler werden mit Kontext-Metadaten protokolliert:

```js
logger.error('Encoding fehlgeschlagen', {
  jobId: job.id,
  command: cmd,
  exitCode: code,
  stderr: lastLines
});
```

### Job-Fehler-Recovery

- Fehlgeschlagene Jobs bleiben in der Datenbank (Status `ERROR`)
- Vollständige Fehler-Logs werden im Job-Datensatz gespeichert
- **Retry-Funktion** ermöglicht Neustart von einem Fehler-Zustand
- **Re-Encode** erlaubt erneutes Encodieren ohne neu zu rippen

---

## Sicherheit

### Eingabe-Validierung

- Alle Benutzer-Eingaben werden in `validators.js` validiert
- CLI-Argumente werden sicher über `commandLine.js` konstruiert (kein Shell-Injection-Risiko)
- Pfade werden sanitisiert bevor sie an externe Prozesse übergeben werden

### CORS-Konfiguration

```env
CORS_ORIGIN=http://localhost:5173
```

In Produktion sollte dieser Wert auf die tatsächliche Frontend-URL gesetzt werden.
