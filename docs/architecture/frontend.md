# Frontend-Komponenten

Das Frontend ist mit **React 18** und **PrimeReact** gebaut und kommuniziert über REST-API und WebSocket mit dem Backend.

---

## Seiten (Pages)

### DashboardPage.jsx

Die Hauptseite von Ripster – zeigt den aktuellen Pipeline-Status und ermöglicht alle Workflow-Aktionen.

**Funktionen:**
- Anzeige des aktuellen Pipeline-Zustands (IDLE, ANALYZING, RIPPING, ENCODING, ...)
- Live-Fortschrittsbalken mit ETA
- Trigger für Metadaten-Dialog
- Playlist-Entscheidungs-UI (bei Blu-ray Obfuskierung)
- Encode-Review mit Track-Auswahl
- Job-Steuerung (Start, Abbruch, Retry)

**Zugehörige Komponenten:**
- `PipelineStatusCard` – Status-Widget
- `MetadataSelectionDialog` – OMDb-Suche und Playlist-Auswahl
- `MediaInfoReviewPanel` – Track-Auswahl vor dem Encoding
- `DiscDetectedDialog` – Benachrichtigung bei Disc-Erkennung

### SettingsPage.jsx

Konfigurationsoberfläche für alle Ripster-Einstellungen.

**Funktionen:**
- Dynamisch generiertes Formular aus dem Settings-Schema
- Echtzeit-Validierungsfeedback
- PushOver-Verbindungstest
- Automatische Aktualisierung des Encode-Reviews bei relevanten Änderungen

### HistoryPage.jsx

Job-Historie mit vollständigem Audit-Trail.

**Funktionen:**
- Sortier- und filterbares Job-Verzeichnis
- Statusfilter (FINISHED, ERROR, WAITING_FOR_USER_DECISION, ...)
- Job-Detail-Dialog mit vollständigen Logs
- Re-Encode, Löschen und Metadaten-Zuweisung
- Import von Orphan-Raw-Ordnern

---

## Komponenten (Components)

### MetadataSelectionDialog.jsx

Dialog für die Metadaten-Auswahl nach der Disc-Analyse.

```
┌─────────────────────────────────────┐
│ Metadaten auswählen                 │
├─────────────────────────────────────┤
│ Suche: [Inception              ] 🔍 │
├─────────────────────────────────────┤
│ Ergebnisse:                         │
│ ▶ Inception (2010) – Movie          │
│   Inception: ... (2011) – Series    │
├─────────────────────────────────────┤
│ Playlist (nur Blu-ray):             │
│ ▶ 00800.mpls (2:30:15) ✓ Empfohlen  │
│   00801.mpls (0:01:23)              │
├─────────────────────────────────────┤
│                   [Bestätigen]      │
└─────────────────────────────────────┘
```

### MediaInfoReviewPanel.jsx

Track-Auswahl-Panel vor dem Encoding.

```
┌─────────────────────────────────────┐
│ Encode-Review                       │
├─────────────────────────────────────┤
│ Audio-Tracks:                       │
│ ☑ Track 1: Deutsch (AC-3, 5.1)     │
│ ☑ Track 2: English (TrueHD, 7.1)   │
│ ☐ Track 3: Français (AC-3, 2.0)    │
├─────────────────────────────────────┤
│ Untertitel:                         │
│ ☑ Track 1: Deutsch                  │
│ ☐ Track 2: English                  │
├─────────────────────────────────────┤
│              [Encodierung starten]  │
└─────────────────────────────────────┘
```

### DynamicSettingsForm.jsx

Wiederverwendbares Formular, das aus dem Settings-Schema generiert wird.

**Unterstützte Feldtypen:**

| Typ | UI-Element |
|----|-----------|
| `string` | Text-Input |
| `number` | Zahlen-Input mit Min/Max |
| `boolean` | Toggle/Checkbox |
| `select` | Dropdown |
| `password` | Passwort-Input |

### PipelineStatusCard.jsx

Status-Anzeige-Widget für die Dashboard-Seite.

### JobDetailDialog.jsx

Vollständiger Job-Detail-Dialog mit Logs-Viewer.

---

## Hooks

### useWebSocket.js

Zentraler Custom-Hook für die WebSocket-Verbindung.

```js
const { status, lastMessage } = useWebSocket({
  onMessage: (msg) => {
    if (msg.type === 'PIPELINE_STATE_CHANGE') {
      setPipelineState(msg.data);
    }
  }
});
```

**Features:**
- Automatische Verbindung zu `/ws`
- Reconnect mit exponential backoff
- Message-Parsing (JSON)
- Status-Tracking (connecting, connected, disconnected)

---

## API-Client (client.js)

Zentraler HTTP-Client für alle Backend-Anfragen.

```js
// Beispiel-Aufrufe
const state = await api.getPipelineState();
const results = await api.searchOmdb('Inception');
await api.selectMetadata(jobId, omdbData, playlist);
await api.confirmEncode(jobId, { audioTracks: [0, 1], subtitleTracks: [0] });
```

**Features:**
- Zentralisierte Fehlerbehandlung
- Automatische JSON-Serialisierung
- Basis-URL aus Umgebungsvariable (`VITE_API_BASE`)

---

## Build & Entwicklung

### Entwicklungsserver

```bash
cd frontend
npm run dev
# → http://localhost:5173
```

### Vite-Proxy-Konfiguration

In der Entwicklungsumgebung proxied Vite API-Anfragen zum Backend:

```js
// vite.config.js
proxy: {
  '/api': 'http://localhost:3001',
  '/ws': { target: 'ws://localhost:3001', ws: true }
}
```

### Production-Build

```bash
cd frontend
npm run build
# → frontend/dist/
```
