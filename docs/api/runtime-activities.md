# Runtime Activities API

Ripster verfolgt alle laufenden und kürzlich abgeschlossenen Aktivitäten (Skripte, Skript-Ketten, Cron-Jobs, interne Tasks) in Echtzeit über den `RuntimeActivityService`.

---

## Übersicht

Aktivitäten entstehen, wenn Ripster intern Aktionen ausführt – z. B. beim Start eines Cron-Jobs, beim Ausführen einer Skript-Kette oder beim Durchlaufen von Pipeline-Schritten. Sie sind **nicht persistent** (kein DB-Speicher) und werden nur im Arbeitsspeicher gehalten.

- **Aktive Aktivitäten** (`active`): Laufen gerade.
- **Letzte Aktivitäten** (`recent`): Abgeschlossen, max. 120 Einträge.

Änderungen werden über WebSocket (`RUNTIME_ACTIVITY_CHANGED`) in Echtzeit gesendet.

---

## Aktivitäts-Objekt

```json
{
  "id": 7,
  "type": "chain",
  "name": "Post-Encode Aufräumen",
  "status": "running",
  "source": "cron",
  "message": "Schritt 2 von 3",
  "currentStep": "cleanup.sh",
  "currentStepType": "script",
  "currentScriptName": "cleanup.sh",
  "stepIndex": 2,
  "stepTotal": 3,
  "parentActivityId": null,
  "jobId": 42,
  "cronJobId": 3,
  "chainId": 5,
  "scriptId": null,
  "canCancel": true,
  "canNextStep": false,
  "outcome": "running",
  "errorMessage": null,
  "output": null,
  "stdout": null,
  "stderr": null,
  "stdoutTruncated": false,
  "stderrTruncated": false,
  "startedAt": "2026-03-10T10:00:00.000Z",
  "finishedAt": null,
  "durationMs": null,
  "exitCode": null,
  "success": null
}
```

### Felder

| Feld | Typ | Beschreibung |
|------|-----|--------------|
| `id` | `number` | Eindeutige ID (Laufzähler, nicht persistent) |
| `type` | `string` | Art der Aktivität: `script` \| `chain` \| `cron` \| `task` |
| `name` | `string \| null` | Anzeigename der Aktivität |
| `status` | `string` | Aktueller Status: `running` \| `success` \| `error` |
| `source` | `string \| null` | Auslöser (z. B. `cron`, `pipeline`, `manual`) |
| `message` | `string \| null` | Kurztext zum aktuellen Zustand |
| `currentStep` | `string \| null` | Name des aktuell ausgeführten Schritts |
| `currentStepType` | `string \| null` | Typ des Schritts (z. B. `script`, `wait`) |
| `currentScriptName` | `string \| null` | Name des Skripts im aktuellen Schritt |
| `stepIndex` | `number \| null` | Aktueller Schritt (1-basiert) |
| `stepTotal` | `number \| null` | Gesamtanzahl Schritte |
| `parentActivityId` | `number \| null` | ID der übergeordneten Aktivität |
| `jobId` | `number \| null` | Verknüpfte Job-ID |
| `cronJobId` | `number \| null` | Verknüpfte Cron-Job-ID |
| `chainId` | `number \| null` | Verknüpfte Skript-Ketten-ID |
| `scriptId` | `number \| null` | Verknüpfte Skript-ID |
| `canCancel` | `boolean` | Abbrechen über API möglich |
| `canNextStep` | `boolean` | Nächster Schritt über API auslösbar |
| `outcome` | `string \| null` | Abschluss-Ergebnis: `success` \| `error` \| `cancelled` \| `skipped` \| `running` |
| `errorMessage` | `string \| null` | Fehlermeldung (max. 2.000 Zeichen) |
| `output` | `string \| null` | Allgemeine Ausgabe (max. 12.000 Zeichen) |
| `stdout` | `string \| null` | Standardausgabe des Prozesses (max. 12.000 Zeichen) |
| `stderr` | `string \| null` | Fehlerausgabe des Prozesses (max. 12.000 Zeichen) |
| `stdoutTruncated` | `boolean` | `true`, wenn `stdout` gekürzt wurde |
| `stderrTruncated` | `boolean` | `true`, wenn `stderr` gekürzt wurde |
| `startedAt` | `string` | ISO-8601-Zeitstempel des Starts |
| `finishedAt` | `string \| null` | ISO-8601-Zeitstempel des Endes |
| `durationMs` | `number \| null` | Laufzeit in Millisekunden |
| `exitCode` | `number \| null` | Exit-Code des Prozesses |
| `success` | `boolean \| null` | Erfolgsstatus (`null` bei laufender Aktivität) |

---

## Snapshot-Objekt

Alle Aktivitäts-Endpunkte geben einen Snapshot zurück:

```json
{
  "active": [ /* laufende Aktivitäten, nach startedAt absteigend */ ],
  "recent": [ /* abgeschlossene Aktivitäten, nach finishedAt absteigend, max. 120 */ ],
  "updatedAt": "2026-03-10T10:05:00.000Z"
}
```

---

## Endpunkte

### GET `/api/activities`

Aktuellen Aktivitäts-Snapshot abrufen.

**Antwort:**

```json
{
  "active": [],
  "recent": [
    {
      "id": 5,
      "type": "script",
      "name": "notify.sh",
      "status": "success",
      "outcome": "success",
      "startedAt": "2026-03-10T09:58:00.000Z",
      "finishedAt": "2026-03-10T09:58:02.000Z",
      "durationMs": 2100,
      "exitCode": 0,
      "success": true,
      "canCancel": false,
      "canNextStep": false
    }
  ],
  "updatedAt": "2026-03-10T10:05:00.000Z"
}
```

---

### POST `/api/activities/:id/cancel`

Aktive Aktivität abbrechen (nur wenn `canCancel: true`).

**Parameter:**

| Name | In | Typ | Beschreibung |
|------|----|-----|--------------|
| `id` | path | `number` | Aktivitäts-ID |
| `reason` | body | `string` | Optionaler Abbruchgrund |

**Request Body:**

```json
{ "reason": "Manueller Abbruch durch Benutzer" }
```

**Antwort (Erfolg):**

```json
{
  "ok": true,
  "action": null,
  "snapshot": { "active": [], "recent": [], "updatedAt": "..." }
}
```

**Fehlercodes:**

| HTTP | Bedeutung |
|------|-----------|
| `404` | Aktivität nicht gefunden oder bereits abgeschlossen |
| `409` | Abbrechen wird von dieser Aktivität nicht unterstützt |

---

### POST `/api/activities/:id/next-step`

Nächsten Schritt einer Aktivität auslösen (nur wenn `canNextStep: true`).

**Parameter:**

| Name | In | Typ | Beschreibung |
|------|----|-----|--------------|
| `id` | path | `number` | Aktivitäts-ID |

**Antwort (Erfolg):**

```json
{
  "ok": true,
  "action": null,
  "snapshot": { "active": [], "recent": [], "updatedAt": "..." }
}
```

**Fehlercodes:**

| HTTP | Bedeutung |
|------|-----------|
| `404` | Aktivität nicht gefunden |
| `409` | Nächster Schritt wird von dieser Aktivität nicht unterstützt |

---

### POST `/api/activities/clear-recent`

Alle abgeschlossenen Aktivitäten aus `recent` löschen.

**Antwort:**

```json
{
  "ok": true,
  "removed": 14,
  "snapshot": { "active": [], "recent": [], "updatedAt": "..." }
}
```

---

## Grenzwerte

| Wert | Limit |
|------|-------|
| Maximale `recent`-Einträge | 120 |
| Maximale Länge `stdout` / `stderr` / `output` | 12.000 Zeichen |
| Maximale Länge `errorMessage` / `message` | 2.000 Zeichen |
| Maximale Länge `outcome` | 40 Zeichen |

Gekürzte Ausgaben erhalten den Suffix ` ...[gekürzt]` (bei Inline-Text) bzw. `\n...[gekürzt]` (bei mehrzeiligem Output).

---

## Echtzeit-Updates

Änderungen werden automatisch als [`RUNTIME_ACTIVITY_CHANGED`](websocket.md#runtime_activity_changed) WebSocket-Event gesendet. Die Frontend-Komponente braucht `GET /api/activities` nur beim initialen Laden aufzurufen.
