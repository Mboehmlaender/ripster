# Workflows aus Nutzersicht

Diese Seite beschreibt typische Abläufe mit den passenden UI-Aktionen.

## Workflow 1: Standardlauf (Disc -> fertige Datei)

1. `Dashboard`: Disc einlegen, `Analyse starten`
2. Metadaten im Dialog übernehmen
3. bei `Bereit zum Encodieren` Titel/Tracks prüfen
4. `Encoding starten`
5. Ergebnis in `Historie` kontrollieren

## Workflow 2: Playlist-Entscheidung bei Blu-ray

1. Job landet in `Warte auf Auswahl`
2. im `Pipeline-Status` Playlist-Kandidaten vergleichen
3. gewünschte Playlist auswählen
4. `Playlist übernehmen`
5. danach normal weiter bis `Bereit zum Encodieren`

## Workflow 3: Mehrere Jobs mit Queue

1. Parallel-Limit in `Settings` über `Parallele Jobs` setzen
2. neue Jobs starten; überschüssige Starts gehen in `Job Queue`
3. Reihenfolge per Drag-and-Drop anpassen
4. bei Bedarf Skript/Kette/Warten als Queue-Eintrag ergänzen

## Workflow 4: Nachbearbeitung eines bestehenden Jobs

In `Historie` -> Detaildialog:

- Metadaten korrigieren: `OMDb neu zuordnen`
- gleiche Einstellungen erneut nutzen: `Encode neu starten`
- Analyse neu aufbauen: `Review neu starten`
- aus RAW erneut encodieren: `RAW neu encodieren`

## Workflow 5: Automatisierung mit Skripten und Cron

1. `Settings` -> `Scripte`: Skripte anlegen und testen
2. `Settings` -> `Skriptketten`: Ketten bauen und testen
3. im Dashboard-Review Pre-/Post-Ausführungen pro Job auswählen
4. `Settings` -> `Cronjobs`: zeitgesteuerte Ausführung konfigurieren
5. Status im Dashboard (`Skript- / Cron-Status`) überwachen

## Workflow 6: Abbruch und Recovery

### Fall A: Job wurde abgebrochen

- im Dashboard optional erzeugte RAW/Movie-Datei bereinigen
- anschließend je nach Ziel: `Retry Rippen` oder `Disk-Analyse neu starten`

### Fall B: Job steht in `Bereit zum Encodieren`, ist aber nicht aktive Session

- in `Historie` oder `Database`: `Im Dashboard öffnen`
- im Dashboard Review erneut prüfen und starten

### Fall C: RAW ohne Historieneintrag

- `/database` öffnen
- Bereich `RAW ohne Historie`
- `Job anlegen`
