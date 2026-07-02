# Ersteinrichtung

Diese Seite ist die Betriebs-Checkliste vor dem ersten produktiven Lauf.

## Ziel der Ersteinrichtung

Vor dem ersten Job sollten fünf Bereiche sauber gesetzt sein:

1. Pfade und Templates
2. Laufwerk und Disc-Erkennung
3. Metadatenzugang über TMDb
4. Encode-Standards und Queue-Regeln
5. optionale Automatisierung und Benachrichtigungen

## Empfohlene Reihenfolge

### 1. Basis in `Settings -> Konfiguration`

Prüfe zuerst diese Kernfelder:

- RAW- und Zielordner für Blu-ray, DVD, CD, Audiobooks und Converter
- `Log Ordner`
- `TMDb Read Access Token`
- `MakeMKV Kommando`, `HandBrake Kommando`, `Mediainfo Kommando`
- `FFmpeg Kommando`, `FFprobe Kommando`, `cdparanoia Kommando`, `mkvmerge Kommando`, falls du die jeweiligen Workflows nutzt

Danach speichern.

### 2. Pfade und Templates bewusst festlegen

Wichtig für den Alltag:

- Film-Workflows nutzen die RAW- und Film-Ausgabeordner sowie die Film-Output-Templates
- Serien-Workflows nutzen zusätzlich die Serien-RAW-Ordner, die Serien-Zielordner und die Episode-/Multi-Episode-Templates
- Audiobooks nutzen `Audiobook RAW-Ordner`, `Audiobook Output-Ordner`, `Audiobook RAW Template`, `Output Template (Audiobook)` und `Kapitel Template (Audiobook)`
- Converter nutzt `Converter Raw-Ordner`, `Converter Ausgabe (Video)`, `Converter Ausgabe (Audio)` sowie `Output-Template (Video)` und `Output-Template (Audio)`
- Downloads nutzen `Download ZIP-Ordner`

Wenn du auf NAS, USB oder mit anderen Benutzern/Gruppen schreiben willst, prüfe auch die jeweils zugehörigen `Eigentümer ...`-Felder.

### 3. Laufwerk und automatische Erkennung prüfen

Relevant:

- `Laufwerksmodus`
- `Explizite Laufwerke`, falls du nicht mit Auto-Discovery arbeiten willst
- `Automatische Disk-Erkennung`
- `Polling Intervall (ms)` im Expertenmodus
- `Laufwerk nach Rip auswerfen`

Empfehlung:

- Einzelnes Standardlaufwerk: `auto`
- mehrere stabile Laufwerke oder ungewöhnliche Device-Mappings: `Explizite Laufwerke`

### 4. TMDb und Metadatenverhalten festlegen

Relevant:

- `TMDb Read Access Token`
- `Film-Sprache`
- `Fallback Sprache`
- `Coverart-Nachladen aktiv`
- `Coverart-Prüfintervall (Stunden)`
- `NFO nach Encode erzeugen`

Diese Einstellungen wirken direkt in Metadatensuche, Serienzuordnung, Nachpflege von Covern und im finalen Output.

### 5. Encode- und Review-Standards festlegen

Für Video-Workflows besonders wichtig:

- `Minimale Titellänge (Minuten)`
- `TMDb Runtime-Abzug für Playlistfilter (%)`
- `HandBrake Preset` und `HandBrake Extra Args` je Medium
- `Review Audio-Sprachen (...)`
- `Review UT-Sprachen (...)`
- `Ausgabeformat`

Praxis:

- `Minimale Titellänge` filtert Bonusmaterial früh weg
- `TMDb Runtime-Abzug ...` lockert bei problematischen Blu-rays die Laufzeitprüfung der Playlist-Kandidaten
- Review-Sprachen bestimmen, welche Audio-/Untertitelspuren in der Review schon vorausgewählt sind

### 6. Queue-Verhalten definieren

Stelle diese vier Felder bewusst ein:

- `Parallele Jobs`
- `Max. parallele Audio CD Jobs`
- `Max. Encodes gesamt (medienunabhängig)`
- `Audio CDs: Queue-Reihenfolge überspringen`

Damit steuerst du, wie aggressiv Ripster mehrere Jobs gleichzeitig startet.

### 7. Optional: User-Presets und Standard-Zuordnungen

Unter `Settings -> Encode-Presets` kannst du:

- eigene HandBrake-User-Presets anlegen
- Standard-Zuordnungen für `Blu-ray Film`, `Blu-ray Serie`, `DVD Film`, `DVD Serie` setzen

Diese Defaults wirken später in der Review automatisch vorbefüllend.

### 8. Optional: Benachrichtigungen

Prüfe:

- `PushOver aktiviert`
- Token/User/optional Device
- Event-Toggles wie `Bei manueller Auswahl senden`, `Bei Rip-Start senden`, `Bei Erfolg senden`

Danach in `Settings` den Button `PushOver Test` ausführen.

### 9. Optional: Automatisierung

Erst wenn die Grundkonfiguration stabil ist:

1. Skripte anlegen und testen
2. Skriptketten aufbauen
3. Cronjobs aktivieren

## Funktionsprüfung

Ein sinnvoller Kurztest:

1. Disc in `Ripper` erkennen lassen
2. `Analyse starten`
3. TMDb-Metadaten übernehmen
4. ggf. Playlist-/RAW-Entscheidung durchlaufen
5. bis `Bereit zum Encodieren` kommen
6. Encode starten
7. Ergebnis in `Historie` prüfen

## Typische Konfigurationsfehler

| Symptom | Häufige Ursache |
|---|---|
| Disc wird nicht erkannt | Laufwerksmodus oder Auto-Erkennung passt nicht |
| Playlist-Auswahl wirkt unplausibel | `Minimale Titellänge` oder `TMDb Runtime-Abzug ...` ist zu streng/zu locker |
| falsche Spuren sind in der Review vorausgewählt | Review-Sprachfilter oder HandBrake-Args greifen unerwartet |
| Ausgabe landet am falschen Ort | Profilpfade oder Templates greifen über Fallback |
| Queue verhält sich unerwartet | `Parallele Jobs`, CD-Limit und Gesamtlimit widersprechen sich |

## Weiter

- [Erster Lauf](quickstart.md)
- [GUI-Seiten](../gui/index.md)
- [Workflows aus Nutzersicht](../workflows/index.md)
- [Alle Einstellungen](../configuration/settings-reference.md)
