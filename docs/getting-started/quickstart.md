# Erster Lauf

Dieser Ablauf zeigt einen vollständigen Job aus Anwendersicht: von Disc-Erkennung bis fertiger Datei.

## 1. Dashboard öffnen und Disc einlegen

Erwartung:

- Status wechselt auf `Medium erkannt`
- im Bereich `Disk-Information` sind Laufwerksdaten sichtbar

Wenn nichts passiert: `Laufwerk neu lesen`.

## 2. Analyse starten

Aktion im Dashboard:

- `Analyse starten`

Erwartung:

- Status `Analyse`
- danach Metadaten-Dialog

## 3. Metadaten auswählen

Im Dialog `Metadaten auswählen`:

1. OMDb-Suche nutzen oder manuell eintragen
2. passenden Treffer markieren
3. `Auswahl übernehmen`

## 4. Auf den nächsten Zustand reagieren

- Normalfall ohne vorhandenes RAW: `Rippen` -> `Mediainfo-Pruefung` -> `Bereit zum Encodieren`
- bei vorhandenem RAW: direkt `Mediainfo-Pruefung` -> `Bereit zum Encodieren`
- bei unklarer Blu-ray-Playlist: `Warte auf Auswahl` (Playlist auswählen und übernehmen)

## 5. Review in `Bereit zum Encodieren`

Im aufgeklappten Job (`Pipeline-Status`):

- Encode-Titel wählen
- Audio-/Subtitle-Spuren prüfen
- optional User-Preset auswählen
- optional Pre-/Post-Skripte bzw. Ketten hinzufügen

Dann `Encoding starten`.

## 6. Encoding überwachen

Während `Encodieren`:

- Fortschritt + ETA im Dashboard
- Live-Log im `Pipeline-Status`
- Queue- und Skript/Cron-Status parallel beobachtbar

## 7. Ergebnis prüfen

Bei `Fertig`:

1. Seite `Historie` öffnen
2. Job in Details öffnen
3. Output-Pfad, Status und Log prüfen

## Typische Folgeaktionen

- Falsches OMDb-Match: in `Historie` -> `OMDb neu zuordnen`
- Neue Encodierung aus RAW: `RAW neu encodieren`
- Prüfung komplett neu aufbauen: `Review neu starten`
