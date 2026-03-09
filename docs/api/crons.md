# Cron API

Ripster enthält ein eingebautes Cron-System, mit dem **Skripte** und **Skript-Ketten** zeitgesteuert oder manuell ausgeführt werden können. Der Cron-Dienst benötigt keine externen Pakete – der Cron-Expression-Parser ist vollständig im Backend implementiert.

---

## Endpunkte

### `GET /api/crons`

Alle konfigurierten Cron-Jobs auflisten.

**Antwort:**

```json
{
  "jobs": [
    {
      "id": 1,
      "name": "Nachtlauf Backup",
      "cronExpression": "0 2 * * *",
      "sourceType": "script",
      "sourceId": 3,
      "enabled": true,
      "pushoverEnabled": true,
      "lastRunAt": "2026-03-09T02:00:00.000Z",
      "lastRunStatus": "success",
      "nextRunAt": "2026-03-10T02:00:00.000Z",
      "createdAt": "2026-03-01T10:00:00.000Z",
      "updatedAt": "2026-03-09T02:00:00.000Z"
    }
  ]
}
```

---

### `POST /api/crons`

Neuen Cron-Job anlegen.

**Body:**

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

| Feld | Typ | Pflicht | Beschreibung |
|------|-----|---------|-------------|
| `name` | string | ✓ | Anzeigename |
| `cronExpression` | string | ✓ | 5-Felder-Cron-Ausdruck (Minute Stunde Tag Monat Wochentag) |
| `sourceType` | string | ✓ | `"script"` oder `"chain"` |
| `sourceId` | number | ✓ | ID des Skripts bzw. der Kette |
| `enabled` | boolean | – | Aktiviert (default: `true`) |
| `pushoverEnabled` | boolean | – | PushOver-Benachrichtigung nach Ausführung (default: `true`) |

**Antwort:** `201 Created`

```json
{ "job": { ... } }
```

---

### `GET /api/crons/:id`

Einzelnen Cron-Job abrufen.

**Antwort:**

```json
{ "job": { ... } }
```

---

### `PUT /api/crons/:id`

Cron-Job aktualisieren. Body-Felder entsprechen `POST /api/crons`.

**Antwort:**

```json
{ "job": { ... } }
```

---

### `DELETE /api/crons/:id`

Cron-Job löschen.

**Antwort:**

```json
{ "removed": { "id": 1 } }
```

---

### `GET /api/crons/:id/logs`

Ausführungs-Logs eines Cron-Jobs abrufen.

**Query-Parameter:**

| Parameter | Typ | Default | Beschreibung |
|-----------|-----|---------|-------------|
| `limit` | number | 20 | Anzahl Einträge (max. 100) |

**Antwort:**

```json
{
  "logs": [
    {
      "id": 42,
      "cronJobId": 1,
      "startedAt": "2026-03-09T02:00:01.000Z",
      "finishedAt": "2026-03-09T02:00:05.000Z",
      "status": "success",
      "exitCode": 0,
      "stdout": "Backup abgeschlossen.",
      "stderr": "",
      "triggeredBy": "cron"
    }
  ]
}
```

| Feld | Beschreibung |
|------|-------------|
| `status` | `"success"`, `"error"` oder `"running"` |
| `triggeredBy` | `"cron"` (zeitgesteuert) oder `"manual"` (manuell ausgelöst) |

---

### `POST /api/crons/:id/run`

Cron-Job sofort manuell auslösen (unabhängig vom Zeitplan).

**Antwort:**

```json
{
  "status": "success",
  "exitCode": 0,
  "stdout": "...",
  "stderr": ""
}
```

---

### `POST /api/crons/validate-expression`

Cron-Ausdruck validieren und nächsten Ausführungszeitpunkt berechnen.

**Body:**

```json
{ "cronExpression": "*/15 * * * *" }
```

**Antwort (gültig):**

```json
{
  "valid": true,
  "nextRunAt": "2026-03-09T14:15:00.000Z"
}
```

**Antwort (ungültig):**

```json
{
  "valid": false,
  "error": "Cron-Ausdruck muss genau 5 Felder haben (Minute Stunde Tag Monat Wochentag).",
  "nextRunAt": null
}
```

---

## Cron-Expression-Format

Ripster verwendet **5-Felder-Cron-Ausdrücke** (kein Sekunden-Feld):

```
┌───────────── Minute       (0-59)
│  ┌────────── Stunde       (0-23)
│  │  ┌─────── Tag          (1-31)
│  │  │  ┌──── Monat        (1-12)
│  │  │  │  ┌─ Wochentag    (0-7, 0 und 7 = Sonntag)
│  │  │  │  │
*  *  *  *  *
```

### Beispiele

| Ausdruck | Beschreibung |
|----------|-------------|
| `0 2 * * *` | Täglich um 02:00 Uhr |
| `*/15 * * * *` | Alle 15 Minuten |
| `0 6 * * 1-5` | Montag–Freitag um 06:00 Uhr |
| `30 23 * * 0` | Sonntags um 23:30 Uhr |
| `0 0 1 * *` | Erster Tag des Monats um Mitternacht |

### Unterstützte Syntax

| Syntax | Bedeutung |
|--------|----------|
| `*` | Jeder Wert |
| `*/n` | Jeder n-te Wert (Step) |
| `a-b` | Bereich von a bis b |
| `a,b,c` | Liste von Werten |
| Kombinierbar | z. B. `1,5-10,*/3` |

---

## WebSocket-Event

Bei Änderungen an Cron-Jobs (Anlegen, Aktualisieren, Löschen) wird ein `CRON_JOBS_UPDATED`-Event gesendet:

```json
{
  "type": "CRON_JOBS_UPDATED",
  "payload": {
    "action": "created",
    "id": 1
  }
}
```

`action` ist `"created"`, `"updated"` oder `"deleted"`.
