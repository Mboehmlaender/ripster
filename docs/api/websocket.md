# WebSocket Events

Ripster sendet Echtzeit-Updates über `/ws`.

---

## Verbindung

```js
const ws = new WebSocket('ws://localhost:3001/ws');

ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  console.log(msg.type, msg.payload);
};
```

---

## Nachrichtenformat

Die meisten Broadcasts haben dieses Schema:

```json
{
  "type": "EVENT_TYPE",
  "payload": {},
  "timestamp": "2026-03-10T09:00:00.000Z"
}
```

Ausnahme: `WS_CONNECTED` beim Verbindungsaufbau enthält kein `timestamp`.

---

## Event-Typen

### WS_CONNECTED

Sofort nach erfolgreicher Verbindung.

```json
{
  "type": "WS_CONNECTED",
  "payload": {
    "connectedAt": "2026-03-10T09:00:00.000Z"
  }
}
```

### PIPELINE_STATE_CHANGED

Neuer Pipeline-Snapshot.

```json
{
  "type": "PIPELINE_STATE_CHANGED",
  "payload": {
    "state": "ENCODING",
    "activeJobId": 42,
    "progress": 62.5,
    "eta": "00:12:34",
    "statusText": "ENCODING 62.50%",
    "context": {},
    "jobProgress": {
      "42": {
        "state": "ENCODING",
        "progress": 62.5,
        "eta": "00:12:34",
        "statusText": "ENCODING 62.50%"
      }
    },
    "queue": {
      "maxParallelJobs": 1,
      "runningCount": 1,
      "queuedCount": 2,
      "runningJobs": [],
      "queuedJobs": []
    }
  }
}
```

### PIPELINE_PROGRESS

Laufende Fortschrittsupdates.

```json
{
  "type": "PIPELINE_PROGRESS",
  "payload": {
    "state": "ENCODING",
    "activeJobId": 42,
    "progress": 62.5,
    "eta": "00:12:34",
    "statusText": "ENCODING 62.50%"
  }
}
```

### PIPELINE_QUEUE_CHANGED

Queue-Snapshot aktualisiert.

### DISC_DETECTED / DISC_REMOVED

Disc-Insertion/-Removal.

```json
{
  "type": "DISC_DETECTED",
  "payload": {
    "device": {
      "path": "/dev/sr0",
      "discLabel": "INCEPTION",
      "model": "ASUS BW-16D1HT",
      "fstype": "udf",
      "mountpoint": null,
      "mediaProfile": "bluray"
    }
  }
}
```

`mediaProfile`: `bluray` | `dvd` | `other` | `null`

### HARDWARE_MONITOR_UPDATE

Snapshot aus Hardware-Monitoring.

```json
{
  "type": "HARDWARE_MONITOR_UPDATE",
  "payload": {
    "enabled": true,
    "intervalMs": 5000,
    "updatedAt": "2026-03-10T09:00:00.000Z",
    "sample": {
      "cpu": {},
      "memory": {},
      "gpu": {},
      "storage": {}
    },
    "error": null
  }
}
```

### PIPELINE_ERROR

Fehler bei Disc-Event-Verarbeitung in Pipeline.

### DISK_DETECTION_ERROR

Fehler in Laufwerkserkennung.

### SETTINGS_UPDATED

Einzelnes Setting wurde gespeichert.

### SETTINGS_BULK_UPDATED

Bulk-Settings gespeichert.

```json
{
  "type": "SETTINGS_BULK_UPDATED",
  "payload": {
    "count": 3,
    "keys": ["raw_dir", "movie_dir", "handbrake_preset_bluray"]
  }
}
```

### SETTINGS_SCRIPTS_UPDATED

Skript geändert (`created|updated|deleted|reordered`).

### SETTINGS_SCRIPT_CHAINS_UPDATED

Skript-Kette geändert (`created|updated|deleted|reordered`).

### USER_PRESETS_UPDATED

User-Preset geändert (`created|updated|deleted`).

### CRON_JOBS_UPDATED

Cron-Config geändert (`created|updated|deleted`).

### CRON_JOB_UPDATED

Laufzeitstatus eines Cron-Jobs geändert.

```json
{
  "type": "CRON_JOB_UPDATED",
  "payload": {
    "id": 1,
    "lastRunStatus": "running",
    "lastRunAt": "2026-03-10T10:00:00.000Z",
    "nextRunAt": null
  }
}
```

---

## Reconnect-Verhalten

`useWebSocket` verbindet bei Abbruch automatisch neu:

- Retry-Intervall: `1500ms`
- Wiederverbindung bis Komponente unmounted wird
