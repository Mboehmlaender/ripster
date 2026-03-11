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

-   :material-lightning-bolt: **WebSocket Events**

    ---

    Pipeline-, Queue-, Disk-, Settings-, Cron- und Monitoring-Events.

    [:octicons-arrow-right-24: WebSocket](websocket.md)

</div>

## Hinweis

Ripster hat keine eingebaute Authentifizierung und ist für lokalen, geschützten Betrieb gedacht.
