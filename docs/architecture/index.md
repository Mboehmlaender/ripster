# Anhang: Architektur

Ripster ist eine Client-Server-Anwendung mit REST + WebSocket und externen CLI-Tools.

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

## Details

<div class="grid cards" markdown>

- [:octicons-arrow-right-24: Übersicht](overview.md)
- [:octicons-arrow-right-24: Backend-Services](backend.md)
- [:octicons-arrow-right-24: Frontend-Komponenten](frontend.md)
- [:octicons-arrow-right-24: Datenbank](database.md)

</div>
