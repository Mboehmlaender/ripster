# Architektur

Ripster ist eine Client-Server-Anwendung mit REST + WebSocket.

---

## Systemüberblick

```mermaid
graph TB
    subgraph Browser["Browser (React)"]
        Dashboard[Dashboard]
        Settings[Einstellungen]
        History[Historie]
    end

    subgraph Backend["Node.js Backend"]
        API[REST API\nExpress]
        WS[WebSocket\n/ws]
        Pipeline[pipelineService]
        Cron[cronService]
        DB[(SQLite)]
    end

    subgraph Tools["Externe Tools"]
        MakeMKV[makemkvcon]
        HandBrake[HandBrakeCLI]
        MediaInfo[mediainfo]
    end

    Browser <-->|HTTP| API
    Browser <-->|WebSocket| WS
    Pipeline --> MakeMKV
    Pipeline --> HandBrake
    Pipeline --> MediaInfo
    API --> DB
    Pipeline --> DB
    Cron --> DB
```

---

## Schichten

### Backend

- `src/index.js` (Bootstrapping, Routes, WS, Services)
- `src/routes/*` (Pipeline, Settings, History, Crons)
- `src/services/*` (Business-Logik)
- `src/db/database.js` (Init/Migration)
- `src/utils/*` (Parser, Dateifunktionen, Validierung)

### Frontend

- `App.jsx` + `pages/*` (Dashboard, Settings, History)
- `components/*` (Status-/Review-/Dialog-Komponenten)
- `api/client.js` (REST-Client)
- `hooks/useWebSocket.js` (WS-Reconnect)

---

## Weiterführend

<div class="grid cards" markdown>

- [:octicons-arrow-right-24: Übersicht](overview.md)
- [:octicons-arrow-right-24: Backend-Services](backend.md)
- [:octicons-arrow-right-24: Frontend-Komponenten](frontend.md)
- [:octicons-arrow-right-24: Datenbank](database.md)

</div>
