# Anhang: API-Referenz

REST- und WebSocket-Schnittstellen für Integration, Automatisierung und Debugging.

## Basis-URL

```text
http://localhost:3001
```

API-Prefix: `/api`

## API-Gruppen

<div class="grid cards" markdown>

-   :material-heart-pulse: **Health**

    ---

    Service-Liveness.

    `GET /api/health`

-   :material-pipe: **Pipeline API**

    ---

    Analyse, Start/Retry/Cancel, Queue, Re-Encode.

    [:octicons-arrow-right-24: Pipeline API](pipeline.md)

-   :material-cog: **Settings API**

    ---

    Einstellungen, Skripte/Ketten, User-Presets.

    [:octicons-arrow-right-24: Settings API](settings.md)

-   :material-history: **History API**

    ---

    Job-Historie, Orphan-Import, Löschoperationen.

    [:octicons-arrow-right-24: History API](history.md)

-   :material-clock-outline: **Cron API**

    ---

    Zeitgesteuerte Skript-/Kettenausführung.

    [:octicons-arrow-right-24: Cron API](crons.md)

-   :material-swap-horizontal: **Converter API**

    ---

    Datei-Explorer, Upload, Job-Verwaltung für den Converter.

    [:octicons-arrow-right-24: Converter API](converter.md)

-   :material-download: **Downloads API**

    ---

    Download-Queue für Ausgabedateien aus der Job-Historie.

    [:octicons-arrow-right-24: Downloads API](downloads.md)

-   :material-lightning-bolt: **Runtime Activities API**

    ---

    Laufende und abgeschlossene Aktivitäten (Skripte, Ketten, Cron, Tasks).

    [:octicons-arrow-right-24: Runtime Activities](runtime-activities.md)

-   :material-websocket: **WebSocket Events**

    ---

    Pipeline-, Queue-, Disk-, Settings-, Cron-, Converter- und Download-Events.

    [:octicons-arrow-right-24: WebSocket](websocket.md)

</div>

## Hinweis

Ripster hat keine eingebaute Authentifizierung und ist für lokalen, geschützten Betrieb gedacht.
