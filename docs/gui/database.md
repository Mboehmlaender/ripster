# Database (Expert)

`/database` ist eine erweiterte Ansicht für Power-User und Recovery-Fälle.

## Zugriff

- Route direkt aufrufen: `/database`
- nicht Teil der Standard-Navigation

## Bereiche

### 1) `Historie & Datenbank`

Tabellarische Jobansicht mit:

- ID, Poster, Medium, Titel
- Status
- Start/Ende

Aktionen im Detaildialog entsprechen weitgehend der Seite `Historie` (inkl. Re-Encode, Review-Neustart, OMDb-Zuordnung, Dateilöschung).

### 2) `RAW ohne Historie`

Listet RAW-Ordner, die keinen zugehörigen Job-Eintrag haben.

Aktionen:

- `RAW prüfen` (Scan der konfigurierten RAW-Pfade)
- `Job anlegen` (Orphan-RAW in Historie importieren)

## Typischer Einsatz

- nach manuellen Dateioperationen
- nach Migrationen oder Recovery
- wenn RAW-Dateien vorhanden sind, aber kein Historieneintrag existiert

## Vorsicht

Diese Seite erlaubt Eingriffe mit direkter Auswirkung auf Datenbestand und Historie. Vor Lösch- oder Importaktionen Pfade und Zieljob sorgfältig prüfen.
