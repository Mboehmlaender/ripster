# Erster Lauf

Dieser Ablauf zeigt einen vollständigen Job aus Anwendersicht: von Disc-Erkennung bis fertiger Datei.

## 1. Dashboard öffnen und Disc einlegen

Erwartung:

- Status wechselt auf `DISC_DETECTED` bzw. `Medium erkannt`
- im Bereich `Disk-Information` sind Laufwerksdaten sichtbar

Wenn nichts passiert: `Laufwerk neu lesen`.

## 2. Analyse starten

Aktion im Dashboard:

- `Analyse starten`

Erwartung:

- Status `ANALYZING`
- danach Metadaten-Dialog

## 3. Metadaten auswählen

Im Dialog `Metadaten auswählen`:

1. OMDb-Suche nutzen oder manuell eintragen
2. passenden Treffer markieren
3. `Auswahl übernehmen`

## 4. Auf den nächsten Zustand reagieren

- Normalfall ohne vorhandenes RAW: `RIPPING` -> `MEDIAINFO_CHECK` -> `READY_TO_ENCODE`
- bei vorhandenem RAW: direkt `MEDIAINFO_CHECK` -> `READY_TO_ENCODE`
- bei unklarer Blu-ray-Playlist: `WAITING_FOR_USER_DECISION` (Playlist auswählen und übernehmen)

## 5. Review in `READY_TO_ENCODE`

Im aufgeklappten Job (`Pipeline-Status`):

- Encode-Titel wählen
- Audio-/Subtitle-Spuren prüfen
- optional User-Preset auswählen
- optional Pre-/Post-Skripte bzw. Ketten hinzufügen

Dann `Encoding starten`.

## 6. Encoding überwachen

Während `ENCODING`:

- Fortschritt + ETA im Dashboard
- Live-Log im `Pipeline-Status`
- Queue- und Skript/Cron-Status parallel beobachtbar

## 7. Ergebnis prüfen

Bei `FINISHED`:

1. Seite `Historie` öffnen
2. Job in Details öffnen
3. Output-Pfad, Status und Log prüfen

## Typische Folgeaktionen

- Falsches OMDb-Match: in `Historie` -> `OMDb neu zuordnen`
- Neue Encodierung aus RAW: `RAW neu encodieren`
- Prüfung komplett neu aufbauen: `Review neu starten`
