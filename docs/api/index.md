# API-Referenz

Ripster bietet eine **REST-API** für alle Operationen sowie einen **WebSocket-Endpunkt** für Echtzeit-Updates.

---

## Basis-URL

```
http://localhost:3001
```

Konfigurierbar über die Umgebungsvariable `PORT`.

---

## API-Gruppen

<div class="grid cards" markdown>

-   :material-pipe: **Pipeline API**

    ---

    Pipeline-Steuerung: Analyse starten, Metadaten setzen, Ripping und Encoding steuern.

    [:octicons-arrow-right-24: Pipeline API](pipeline.md)

-   :material-cog: **Settings API**

    ---

    Einstellungen lesen und schreiben.

    [:octicons-arrow-right-24: Settings API](settings.md)

-   :material-history: **History API**

    ---

    Job-Geschichte abfragen, Jobs löschen, Orphan-Ordner importieren.

    [:octicons-arrow-right-24: History API](history.md)

-   :material-clock-outline: **Cron API**

    ---

    Cron-Jobs verwalten, manuell auslösen und Ausführungs-Logs abrufen.

    [:octicons-arrow-right-24: Cron API](crons.md)

-   :material-lightning-bolt: **WebSocket Events**

    ---

    Echtzeit-Events für Pipeline-Status, Fortschritt und Disc-Erkennung.

    [:octicons-arrow-right-24: WebSocket](websocket.md)

</div>

---

## Authentifizierung

Die API hat **keine Authentifizierung**. Sie ist für den Einsatz im lokalen Netzwerk konzipiert.

!!! warning "Produktionsbetrieb"
    Falls Ripster öffentlich erreichbar sein soll, schütze die API mit einem Reverse-Proxy (z. B. nginx mit Basic Auth oder OAuth).

---

## Fehlerformat

Alle API-Fehler werden im folgenden Format zurückgegeben:

```json
{
  "error": "Job nicht gefunden",
  "details": "Kein Job mit ID 999 vorhanden"
}
```

HTTP-Statuscodes:

| Code | Bedeutung |
|-----|-----------|
| `200` | Erfolg |
| `400` | Ungültige Anfrage |
| `404` | Ressource nicht gefunden |
| `409` | Konflikt (z.B. Pipeline bereits aktiv) |
| `500` | Interner Serverfehler |
