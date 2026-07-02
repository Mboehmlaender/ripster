# Downloads

Auf `Downloads` werden ZIP-Archive für Historie-Artefakte erstellt und bereitgestellt.

## Was heruntergeladen werden kann

Ein Download-Eintrag referenziert immer einen Historie-Job und genau ein Ziel:

- `RAW`
- `Output`

Erzeugt wird ein ZIP-Archiv im Download-Verzeichnis des Backends.

## Statusmodell

| Status | Bedeutung |
|---|---|
| `queued` | Eintrag erstellt, wartet auf Verarbeitung |
| `processing` | ZIP wird gerade gebaut |
| `ready` | Archiv fertig, Download-Link aktiv |
| `failed` | Erzeugung oder Zugriff fehlgeschlagen |

## Eintrag anlegen

Startpunkt ist die `Historie`:

1. Job öffnen.
2. Download einreihen.
3. Ziel (`RAW` oder `Output`) wählen.
4. Status in `Downloads` verfolgen.

## Wichtige Laufzeitdetails

- Wenn bereits ein passendes, aktuelles Archiv existiert, kann der Eintrag wiederverwendet werden.
- Nach Backend-Neustart werden unterbrochene `queued`/`processing`-Einträge geprüft und fortgesetzt.
- Fehlt eine erwartete ZIP-Datei bei `ready`, wird der Eintrag auf `failed` gesetzt.

## Download auslösen

Bei Status `ready`:

- Download-Button lädt die ZIP direkt aus `/api/downloads/:id/file`.

## Einträge entfernen

`Löschen` entfernt:

- Queue-Metadaten
- zugehörige Archivdatei

Nicht erlaubt:

- Löschen während `queued`/`processing`

## Echtzeitaktualisierung

Die Seite reagiert auf `DOWNLOADS_UPDATED` per WebSocket.
Dadurch sind Statuswechsel ohne Reload sichtbar.
