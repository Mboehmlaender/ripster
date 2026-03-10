# Cron API

Ripster enthält ein eingebautes Cron-System für Skripte und Skript-Ketten (`sourceType: script|chain`).

---

## GET /api/crons

Listet alle Cron-Jobs.

```json
{
  "jobs": [
    {
      "id": 1,
      "name": "Nachtlauf Backup",
      "cronExpression": "0 2 * * *",
      "sourceType": "script",
      "sourceId": 3,
      "sourceName": "Backup-Skript",
      "enabled": true,
      "pushoverEnabled": true,
      "lastRunAt": "2026-03-10T02:00:00.000Z",
      "lastRunStatus": "success",
      "nextRunAt": "2026-03-11T02:00:00.000Z",
      "createdAt": "2026-03-01T10:00:00.000Z",
      "updatedAt": "2026-03-10T02:00:05.000Z"
    }
  ]
}
```

---

## POST /api/crons

Erstellt Cron-Job.

```json
{
  "name": "Nachtlauf Backup",
  "cronExpression": "0 2 * * *",
  "sourceType": "script",
  "sourceId": 3,
  "enabled": true,
  "pushoverEnabled": true
}
```

Response: `201` mit `{ "job": { ... } }`

---

## GET /api/crons/:id

Response:

```json
{ "job": { "id": 1, "name": "..." } }
```

---

## PUT /api/crons/:id

Aktualisiert Cron-Job. Felder wie bei `POST`.

Response:

```json
{ "job": { ... } }
```

---

## DELETE /api/crons/:id

Response:

```json
{ "removed": { "id": 1, "name": "Nachtlauf Backup" } }
```

---

## GET /api/crons/:id/logs

Liefert Ausführungs-Logs.

**Query-Parameter:**

| Parameter | Typ | Default | Beschreibung |
|-----------|-----|---------|-------------|
| `limit` | number | `20` | Anzahl Einträge, max. `100` |

**Response:**

```json
{
  "logs": [
    {
      "id": 42,
      "cronJobId": 1,
      "startedAt": "2026-03-10T02:00:01.000Z",
      "finishedAt": "2026-03-10T02:00:05.000Z",
      "status": "success",
      "output": "Backup abgeschlossen.",
      "errorMessage": null
    }
  ]
}
```

`status`: `running` | `success` | `error`

---

## POST /api/crons/:id/run

Triggert Job manuell (asynchron).

**Response:**

```json
{ "triggered": true, "cronJobId": 1 }
```

Wenn Job bereits läuft: `409`.

---

## POST /api/crons/validate-expression

Validiert 5-Felder-Cron-Ausdruck und berechnet nächsten Lauf.

**Request:**

```json
{ "cronExpression": "*/15 * * * *" }
```

**Gültige Response:**

```json
{
  "valid": true,
  "nextRunAt": "2026-03-10T14:15:00.000Z"
}
```

**Ungültige Response:**

```json
{
  "valid": false,
  "error": "Cron-Ausdruck muss genau 5 Felder haben (Minute Stunde Tag Monat Wochentag).",
  "nextRunAt": null
}
```

---

## Cron-Format

Ripster unterstützt 5 Felder:

```text
Minute Stunde Tag Monat Wochentag
```

Beispiele:

- `0 2 * * *` täglich 02:00
- `*/15 * * * *` alle 15 Minuten
- `0 6 * * 1-5` Mo-Fr 06:00

---

## WebSocket-Events zu Cron

- `CRON_JOBS_UPDATED` bei Create/Update/Delete
- `CRON_JOB_UPDATED` bei Laufzeitstatus (`running` -> `success|error`)
