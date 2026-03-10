# API-Referenz

Ripster bietet eine REST-API für Steuerung/Verwaltung sowie einen WebSocket-Endpunkt für Echtzeit-Updates.

---

## Basis-URL

```text
http://localhost:3001
```

API-Prefix: `/api`

Beispiele:

- `GET /api/health`
- `GET /api/pipeline/state`

---

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

---

## Authentifizierung

Es gibt keine eingebaute Authentifizierung. Ripster ist für lokalen Betrieb gedacht.

---

## Fehlerformat

Fehler werden zentral als JSON geliefert:

```json
{
  "error": {
    "message": "Job nicht gefunden.",
    "statusCode": 404,
    "reqId": "req_...",
    "details": [
      {
        "field": "name",
        "message": "Name darf nicht leer sein."
      }
    ]
  }
}
```

`details` ist optional (z. B. bei Validierungsfehlern).

---

## Häufige Statuscodes

| Code | Bedeutung |
|------|-----------|
| `200` | Erfolg |
| `201` | Ressource erstellt |
| `400` | Ungültige Anfrage / Validierungsfehler |
| `404` | Ressource nicht gefunden |
| `409` | Konflikt (z. B. falscher Pipeline-Zustand, Job läuft bereits) |
| `500` | Interner Fehler |
