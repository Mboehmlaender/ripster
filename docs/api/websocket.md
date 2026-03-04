# WebSocket Events

Ripster verwendet WebSockets für Echtzeit-Updates. Der Endpunkt ist `/ws`.

---

## Verbindung

```js
const ws = new WebSocket('ws://localhost:3001/ws');

ws.onmessage = (event) => {
  const message = JSON.parse(event.data);
  console.log(message.type, message.data);
};
```

---

## Nachrichten-Format

Alle Nachrichten folgen diesem Schema:

```json
{
  "type": "EVENT_TYPE",
  "data": { ... }
}
```

---

## Event-Typen

### PIPELINE_STATE_CHANGE

Wird gesendet, wenn der Pipeline-Zustand wechselt.

```json
{
  "type": "PIPELINE_STATE_CHANGE",
  "data": {
    "state": "ENCODING",
    "jobId": 42,
    "job": {
      "id": 42,
      "title": "Inception",
      "status": "ENCODING"
    }
  }
}
```

---

### PROGRESS_UPDATE

Wird während aktiver Prozesse (Ripping/Encoding) regelmäßig gesendet.

```json
{
  "type": "PROGRESS_UPDATE",
  "data": {
    "progress": 73.5,
    "eta": "00:12:34",
    "speed": "45.2 fps",
    "phase": "ENCODING"
  }
}
```

**Felder:**

| Feld | Typ | Beschreibung |
|-----|-----|-------------|
| `progress` | number | Fortschritt 0–100 |
| `eta` | string | Geschätzte Restzeit (`HH:MM:SS`) |
| `speed` | string | Encoding-Geschwindigkeit (nur beim Encoding) |
| `phase` | string | Aktuelle Phase (`RIPPING` oder `ENCODING`) |

---

### DISC_DETECTED

Wird gesendet, wenn eine Disc erkannt wird.

```json
{
  "type": "DISC_DETECTED",
  "data": {
    "device": "/dev/sr0"
  }
}
```

---

### DISC_REMOVED

Wird gesendet, wenn eine Disc ausgeworfen wird.

```json
{
  "type": "DISC_REMOVED",
  "data": {
    "device": "/dev/sr0"
  }
}
```

---

### JOB_COMPLETE

Wird gesendet, wenn ein Job erfolgreich abgeschlossen wurde.

```json
{
  "type": "JOB_COMPLETE",
  "data": {
    "jobId": 42,
    "title": "Inception",
    "outputPath": "/mnt/nas/movies/Inception (2010).mkv"
  }
}
```

---

### ERROR

Wird gesendet, wenn ein Fehler aufgetreten ist.

```json
{
  "type": "ERROR",
  "data": {
    "jobId": 42,
    "message": "HandBrake ist abgestürzt",
    "details": "Exit code: 1\nStderr: ..."
  }
}
```

---

### METADATA_REQUIRED

Wird gesendet, wenn Benutzer-Eingabe für Metadaten benötigt wird.

```json
{
  "type": "METADATA_REQUIRED",
  "data": {
    "jobId": 42,
    "makemkvData": { ... },
    "playlistAnalysis": { ... }
  }
}
```

---

### ENCODE_REVIEW_REQUIRED

Wird gesendet, wenn der Benutzer den Encode-Plan bestätigen soll.

```json
{
  "type": "ENCODE_REVIEW_REQUIRED",
  "data": {
    "jobId": 42,
    "encodePlan": {
      "audioTracks": [ ... ],
      "subtitleTracks": [ ... ]
    }
  }
}
```

---

## Reconnect-Verhalten

Der Frontend-Hook `useWebSocket.js` implementiert automatisches Reconnect:

```
Verbindung verloren
    ↓
Warte 1s → Reconnect-Versuch
    ↓ (Fehlschlag)
Warte 2s → Reconnect-Versuch
    ↓ (Fehlschlag)
Warte 4s → ...
    ↓
Max. 30s Wartezeit
```

---

## Beispiel: React-Hook

```js
import { useEffect, useState } from 'react';

function usePipelineState() {
  const [state, setState] = useState({ state: 'IDLE' });

  useEffect(() => {
    const ws = new WebSocket(import.meta.env.VITE_WS_URL + '/ws');

    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);

      if (msg.type === 'PIPELINE_STATE_CHANGE') {
        setState(msg.data);
      }
    };

    return () => ws.close();
  }, []);

  return state;
}
```
