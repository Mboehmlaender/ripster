# Ripper

Die Seite `Ripper` ist die Live-Steuerung der Disc-Pipeline. Hier laufen Disc-Erkennung, Queue, manuelle Entscheidungen, Review und aktive Jobs zusammen.

## Seitenaufbau

Die wichtigsten Bereiche:

1. `Hardware`
2. `Job Queue`
3. `Skript- / Cron-Status`
4. `Job Übersicht`
5. `Disk-Information`

## 1. Hardware

Die Hardware-Karte zeigt live:

- CPU
- RAM
- GPU, falls vorhanden
- freie Speicherstände der konfigurierten Pfade

Aktionen:

- Klick auf das Hardware-Symbol öffnet die Seite [Hardware](hardware.md)

Relevante Settings:

- `Hardware Monitoring aktiviert`
- `Hardware Monitoring Intervall (ms)`
- `Externe Speicher`

## 2. Job Queue

Es gibt zwei operative Zonen:

- laufende Jobs
- Warteschlange

Mögliche Queue-Einträge:

- normale Job-Starts
- `Retry Rippen`
- `RAW neu encodieren`
- `Encode neu starten`
- `Review neu starten`
- `Audio CD starten`
- `Skript`
- `Skriptkette`
- `Warten`

Wichtige Regeln:

- Reihenfolge ist per Drag-and-Drop änderbar
- `Warten` blockiert nachfolgende Starts, bis keine aktive Verarbeitung mehr läuft
- Queue-Einträge können auch ohne Medienjob existieren

Relevante Settings:

- `Parallele Jobs`
- `Max. parallele Audio CD Jobs`
- `Max. Encodes gesamt (medienunabhängig)`
- `Audio CDs: Queue-Reihenfolge überspringen`

## 3. Skript- / Cron-Status

Zeigt Runtime-Aktivitäten:

- laufende Skripte
- laufende Ketten
- Cron-Ausführungen
- kürzlich abgeschlossene Aktivitäten

Aktionen:

- `Nächster Schritt` bei Ketten
- `Abbrechen`
- `Liste leeren`

## 4. Job Übersicht

Die Jobliste ist der zentrale Arbeitsbereich. Ein Klick öffnet den jeweiligen `Pipeline-Status`.

### Zustandsabhängige Hauptaktionen

| Zustand | Typische Aktion | Ergebnis |
|---|---|---|
| `Medium erkannt` | `Analyse starten` | MakeMKV-Analyse beginnt |
| `Metadatenauswahl` | `Metadaten öffnen` | TMDb-Dialog für Film/Serie |
| `Warte auf Auswahl` | Entscheidung bestätigen | Flow geht an die passende Stelle weiter |
| `Startbereit` | `Job starten` | Rip oder RAW-basierte Prüfung startet |
| `Bereit zum Encodieren` | `Encoding starten` | HandBrake startet mit bestätigter Auswahl |
| laufend | `Abbrechen` | Job wird gestoppt |
| `Fehler` / `Abgebrochen` | `Retry Rippen` | neuer Rip-Anlauf |

### Was `Warte auf Auswahl` heute bedeuten kann

Der Status ist nicht nur für eine einzige Entscheidung da. Im aktuellen Stand gibt es drei typische Fälle:

#### Vorhandenes RAW

Ripster hat zu den Metadaten bereits ein passendes RAW gefunden. Dann entscheidest du:

- mit RAW weiterarbeiten
- RAW löschen und neu rippen
- in passenden Film-Fällen optional Multipart mit Orphan-RAW bilden

#### Playlist-Auswahl

Bei mehrdeutigen Blu-rays oder bestimmten DVD-Fällen musst du eine Playlist bestätigen. Die Liste zeigt unter anderem:

- Playlist-Datei
- Titel-ID
- Laufzeit
- Score
- Empfehlung
- Segment- und Audio-Vorschau

Relevante Settings:

- `Minimale Titellänge (Minuten)`
- `TMDb Runtime-Abzug für Playlistfilter (%)`
- `Bei manueller Auswahl senden` für PushOver

#### Titelauswahl / PlayAll-Grenzfall

Wenn Ripster mehrere HandBrake-Titel als plausibel erkannt hat, musst du einen oder mehrere Titel bestätigen. Bei Serien kann das der Grenzfall `PlayAll oder Doppelfolge?` sein.

## 5. Review-Bereich (`Bereit zum Encodieren`)

Hier triffst du die eigentliche Encode-Entscheidung.

Du legst fest:

- welchen Titel Ripster encodieren soll
- welche Audio-Spuren übernommen werden
- welche Untertitel übernommen, erzwungen oder eingebrannt werden
- welches User-Preset oder HandBrake-Preset verwendet wird
- welche Pre-/Post-Encode-Skripte oder Ketten mitlaufen

Wichtig:

- ohne diese Bestätigung startet kein produktiver Encode
- bei Multipart-Locks können Einstellungen von einer Referenz-Disc übernommen und gesperrt sein

### Welche Settings hier direkt sichtbar werden

- `HandBrake Preset`
- `HandBrake Extra Args`
- `Review Audio-Sprachen (...)`
- `Review UT-Sprachen (...)`
- `Ausgabeformat`
- Standard-Zuordnungen aus `Settings -> Encode-Presets`

## RAW-Ordnerphasen

Der Ripper arbeitet mit drei RAW-Zuständen:

- `Incomplete_...` während eines unvollständigen Rips
- `Rip_Complete_...` nach erfolgreichem Rip, vor dem finalen Encode
- ohne Prefix nach erfolgreichem Encode

Das ist wichtig für:

- Recovery
- RAW-Wiederverwendung
- Delete-Preview in `Historie`

## Disk-Information

Zeigt aktuelle Laufwerksdaten:

- Device-Pfad
- Modell
- Disc-Label
- Mount-Informationen

Aktionen:

- `Laufwerk neu lesen`
- `Disk neu analysieren`
- Metadaten-Dialog öffnen

Hinweis:

- `Laufwerk neu lesen` ist nicht mehr an einen festen Pipeline-State gebunden

## Wichtige Dialoge

### Metadaten auswählen

Im Dialog bestätigst du Film- oder Serienmetadaten aus TMDb.

Sonderfälle:

- Film-Duplikat: `Übernahme erzwingen` oder `Multipart movie`
- Serie: `Disc-Nummer` ist Pflicht

### Vorhandenes RAW erkannt

Wenn zu den Metadaten bereits RAW existiert, fordert Ripster eine explizite Entscheidung:

- vorhandenes RAW verwenden
- RAW verwerfen/löschen und neu rippen

### Queue-Eintrag einfügen

Du kannst gezielt ab Position einfügen:

- Skript
- Skriptkette
- Wartezeit

### Audible Activation Bytes eintragen

Wenn für eine AAX-Datei keine Activation Bytes verfügbar sind, öffnet Ripster einen Dialog zur manuellen Eingabe.

- Format: genau 8 Hex-Zeichen, z. B. `1a2b3c4d`
- Speicherung: lokal im Activation-Bytes-Cache
- Wirkung: der Audiobook-Flow kann anschließend fortgesetzt werden

## Siehe auch

- [Hardware](hardware.md)
- [Settings](settings.md)
- [Workflows aus Nutzersicht](../workflows/index.md)
