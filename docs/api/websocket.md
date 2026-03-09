# WebSocket Events

Ripster sendet Echtzeit-Updates über WebSocket unter `/ws`.

---

## Verbindung

```js
const ws = new WebSocket('ws://localhost:3001/ws');

ws.onmessage = (event) => {
  const message = JSON.parse(event.data);
  console.log(message.type, message.payload);
};
```

---

## Nachrichtenformat

Alle Broadcasts haben dieses Schema:

```json
{
  "type": "EVENT_TYPE",
  "payload": { },
  "timestamp": "2026-03-05T10:00:00.000Z"
}
```

---

## Event-Typen

### WS_CONNECTED

Wird direkt nach Verbindungsaufbau gesendet.

```json
{
  "type": "WS_CONNECTED",
  "payload": {
    "connectedAt": "2026-03-05T10:00:00.000Z"
  }
}
```

### PIPELINE_STATE_CHANGED

Snapshot bei Zustandswechsel.

```json
{
  "type": "PIPELINE_STATE_CHANGED",
  "payload": {
    "state": "ENCODING",
    "activeJobId": 42,
    "progress": 73.5,
    "eta": "00:12:34",
    "statusText": "Encoding mit HandBrake",
    "context": {},
    "queue": {
      "maxParallelJobs": 1,
      "runningCount": 1,
      "queuedCount": 0
    }
  }
}
```

### PIPELINE_PROGRESS

Laufende Fortschrittsupdates während aktiver Phasen.

```json
{
  "type": "PIPELINE_PROGRESS",
  "payload": {
    "state": "ENCODING",
    "activeJobId": 42,
    "progress": 73.5,
    "eta": "00:12:34",
    "statusText": "ENCODING 73.50% - task 1 of 1"
  }
}
```

### PIPELINE_QUEUE_CHANGED

Aktualisierung der Job-Queue.

```json
{
  "type": "PIPELINE_QUEUE_CHANGED",
  "payload": {
    "maxParallelJobs": 1,
    "runningCount": 1,
    "queuedCount": 2,
    "runningJobs": [],
    "queuedJobs": []
  }
}
```

### DISC_DETECTED

Disc erkannt.

```json
{
  "type": "DISC_DETECTED",
  "payload": {
    "device": {
      "path": "/dev/sr0",
      "discLabel": "INCEPTION",
      "label": "INCEPTION",
      "model": "ASUS BW-16D1HT",
      "fstype": "udf",
      "mountpoint": null,
      "mediaProfile": "bluray"
    }
  }
}
```

`mediaProfile` ist `"bluray"`, `"dvd"`, `"other"` oder `null` (wenn nicht bestimmbar). Der Wert wird aus Dateisystemtyp (UDF/ISO9660), Laufwerk-Modell und Disc-Label abgeleitet.

### DISC_REMOVED

Disc entfernt.

```json
{
  "type": "DISC_REMOVED",
  "payload": {
    "device": {
      "path": "/dev/sr0"
    }
  }
}
```

### PIPELINE_ERROR

Fehler bei Pipeline-Disc-Events im Backend.

```json
{
  "type": "PIPELINE_ERROR",
  "payload": {
    "message": "..."
  }
}
```

### DISK_DETECTION_ERROR

Fehler im Laufwerkserkennungsdienst.

```json
{
  "type": "DISK_DETECTION_ERROR",
  "payload": {
    "message": "..."
  }
}
```

### SETTINGS_SCRIPTS_UPDATED

Wird gesendet, wenn ein Skript angelegt, aktualisiert, gelöscht oder umsortiert wurde.

```json
{
  "type": "SETTINGS_SCRIPTS_UPDATED",
  "payload": {
    "action": "reordered",
    "count": 3
  }
}
```

`action` ist `"created"`, `"updated"`, `"deleted"` oder `"reordered"`.

### SETTINGS_SCRIPT_CHAINS_UPDATED

Wird gesendet bei Änderungen an Skript-Ketten.

```json
{
  "type": "SETTINGS_SCRIPT_CHAINS_UPDATED",
  "payload": {
    "action": "created",
    "id": 2
  }
}
```

### USER_PRESETS_UPDATED

Wird gesendet, wenn ein User-Preset angelegt, aktualisiert oder gelöscht wurde.

```json
{
  "type": "USER_PRESETS_UPDATED",
  "payload": {
    "action": "created",
    "id": 1
  }
}
```

`action` ist `"created"`, `"updated"` oder `"deleted"`.

### CRON_JOBS_UPDATED

Wird gesendet, wenn ein Cron-Job angelegt, aktualisiert oder gelöscht wurde.

```json
{
  "type": "CRON_JOBS_UPDATED",
  "payload": {
    "action": "created",
    "id": 1
  }
}
```

`action` ist `"created"`, `"updated"` oder `"deleted"`.

---

## Reconnect-Verhalten

`useWebSocket.js` versucht bei Verbindungsabbruch automatisch erneut zu verbinden.

- fester Retry-Intervall: `1500ms`
- erneuter Versuch bis zum Unmount der Komponente

---

## React-Beispiel

```js
import { useWebSocket } from './hooks/useWebSocket';

useWebSocket({
  onMessage: (msg) => {
    if (msg.type === 'PIPELINE_STATE_CHANGED') {
      setPipeline(msg.payload);
    }
  }
});
```
