# Workflows aus Nutzersicht

Diese Seite beschreibt die produktiven Abläufe aus Sicht der Benutzer: welche Entscheidung wann anfällt, welche Jobs oder Container entstehen und welche Settings den Ablauf sichtbar beeinflussen.

## Gemeinsame Grundlagen

### Typische Statuskette

`Medium erkannt` -> `Analyse` -> `Metadatenauswahl` -> `Startbereit` -> `Rippen` -> `Mediainfo-Prüfung` -> `Bereit zum Encodieren` -> `Encodieren` -> `Fertig`

Wichtige Abweichungen:

- bei vorhandenem RAW: Sprung direkt in RAW-Entscheidung oder Review
- bei mehrdeutigen Blu-rays/DVDs: `Warte auf Auswahl` für Playlist- oder Titelauswahl
- bei Fehler oder Abbruch: `Fehler` oder `Abgebrochen` mit Folgeaktionen
- bei Audio-CDs und Audiobooks: eigener Spezialflow innerhalb derselben Gesamtpipeline

### Welche Settings fast überall hineinspielen

Die wichtigsten globalen Einflussfaktoren:

- `Parallele Jobs`
- `Max. parallele Audio CD Jobs`
- `Max. Encodes gesamt (medienunabhängig)`
- `Audio CDs: Queue-Reihenfolge überspringen`
- `PushOver`-Ereignisse
- Pfade, Templates und Owner-Felder

Für Disc-Video zusätzlich:

- `Minimale Titellänge (Minuten)`
- `TMDb Runtime-Abzug für Playlistfilter (%)`
- `HandBrake Preset`
- `HandBrake Extra Args`
- `Review Audio-Sprachen (...)`
- `Review UT-Sprachen (...)`
- Standard-Zuordnungen aus `Settings -> Encode-Presets`

## Workflow A: Film von Disc (Blu-ray / DVD)

### 1. Disc analysieren und TMDb-Metadaten wählen

1. Im `Ripper` `Analyse starten`
2. im Metadaten-Dialog Film auswählen
3. `Auswahl übernehmen`

Wirkung:

- der Job wird als Film-Workflow geführt
- Film-Metadaten, Poster und Fingerprint werden gesetzt

Relevante Settings:

- `TMDb Read Access Token`
- `Film-Sprache`
- `Fallback Sprache`

### 2. Duplikatfall entscheiden

Wenn ein Film mit gleichem Fingerprint bereits existiert:

1. `Übernahme erzwingen`: neuer unabhängiger Film-Job
2. `Multipart movie`: neuer Job wird mit bestehendem Film zu einem Multipart-Container verknüpft

Bei Multipart gilt:

- beide Discs brauchen unterschiedliche Disc-Nummern
- gleiche Disc-Nummern blockieren den Vorgang

### 3. RAW-Verzeichnis und RAW-Entscheidung

Wenn noch kein passendes RAW vorhanden ist:

- Ripster legt ein neues RAW-Verzeichnis an

Wenn bereits ein passendes RAW gefunden wird:

- der Job geht in `Warte auf Auswahl`
- du entscheidest, ob das vorhandene RAW weiterverwendet oder neu gerippt wird

Relevante Settings:

- `Raw Ausgabeordner (Blu-ray)` und `Raw Ausgabeordner (DVD)`
- `Eigentümer Raw-Ordner (Blu-ray)` und `Eigentümer Raw-Ordner (DVD)`

### 4. Playlist- oder Titelauswahl

Bei bestimmten Discs ist nach der Metadatenphase eine manuelle Auswahl nötig:

- Playlist-Auswahl
- HandBrake-Titelauswahl
- bei Serien-Grenzfällen PlayAll- oder Doppelfolgen-Entscheidung

Das ist der aktuelle `playlistflow`.

Relevante Settings:

- `Minimale Titellänge (Minuten)`
- `TMDb Runtime-Abzug für Playlistfilter (%)`
- `Bei manueller Auswahl senden`

Praxis:

- zu hoher Mindestwert blendet legitime Alternativfassungen aus
- ein kleiner Runtime-Abzug hilft bei Discs, deren Hauptfilm minimal unter der TMDb-Laufzeit liegt

### 5. Review und Encode

Im Zustand `Bereit zum Encodieren` entscheidest du:

- welcher Titel encodiert wird
- welche Audio-Spuren übernommen werden
- welche Untertitel übernommen, erzwungen oder eingebrannt werden
- welches Preset gilt
- welche Pre-/Post-Encode-Skripte oder Ketten mitlaufen

Relevante Settings:

- `HandBrake Preset`
- `HandBrake Extra Args`
- `Review Audio-Sprachen (Blu-ray Film)` oder `Review Audio-Sprachen (DVD Film)`
- `Review UT-Sprachen (Blu-ray Film)` oder `Review UT-Sprachen (DVD Film)`
- `Ausgabeformat`
- Standard-Userpreset für Film unter `Settings -> Encode-Presets`

### 6. Finale Ausgabe

Finale Ausgabe:

- Zielordner: `Film Ausgabeordner (Blu-ray)` oder `Film Ausgabeordner (DVD)`
- Dateiname und Ordner: `Output Template (Blu-ray)` oder `Output Template (DVD)`

Optional:

- `.nfo` direkt nach Encode

Relevante Settings:

- `Film Ausgabeordner (Blu-ray)` und `Film Ausgabeordner (DVD)`
- `Eigentümer Film-Ordner (Blu-ray)` und `Eigentümer Film-Ordner (DVD)`
- `Output Template (Blu-ray)` und `Output Template (DVD)`
- `NFO nach Encode erzeugen`

## Workflow B: Serie von Disc (Blu-ray / DVD)

### 1. Serienmodus festlegen

1. Disc analysieren
2. im Metadaten-Dialog Serienmetadaten wählen
3. `Disc-Nummer` setzen

Wirkung:

- Ripster arbeitet als Serien-Workflow
- Seriencontainer wird gesucht oder angelegt
- der Job wird als Child unter diesem Container geführt

### 2. Serien-RAW und Staffelkontext

Für Serien bevorzugt Ripster eigene Serien-RAW-Verzeichnisse:

- `RAW-Ordner (Blu-ray Serie)`
- `RAW-Ordner (DVD Serie)`

Falls leer:

- Fallback auf `Raw Ausgabeordner (Blu-ray)` bzw. `Raw Ausgabeordner (DVD)`

### 3. Episodenprüfung und Multi-Episode-Fälle

In der Review werden Episoden oder Mehrfachfolgen aufgelöst.

Ausgabevarianten:

- Einzel-Episode
- Multi-Episode-Datei

Relevante Settings:

- `Output Template (Blu-ray Serie, Episode)`
- `Output Template (Blu-ray Serie, Multi-Episode)`
- `Output Template (DVD Serie, Episode)`
- `Output Template (DVD Serie, Multi-Episode)`
- `Serien-Ordner (Blu-ray)`
- `Serien-Ordner (DVD)`

### 4. Playlistflow auch bei Serien

Auch Serien können vor der Review in eine Playlist- oder Titelauswahl laufen.

Zusätzlich wirken:

- `Review Audio-Sprachen (Blu-ray Serie)` / `Review Audio-Sprachen (DVD Serie)`
- `Review UT-Sprachen (Blu-ray Serie)` / `Review UT-Sprachen (DVD Serie)`
- Serien-Default-Presets unter `Settings -> Encode-Presets`

## Workflow C: Multipart-Film

### Wann der Flow gedacht ist

- gleicher Film auf mehreren Discs
- die Discs sollen in Historie und Detailansichten zusammengehören

### Ablauf

1. Film-Metadaten wählen
2. Duplikatdialog `Multipart movie`
3. Disc-Nummern für bestehenden und neuen Job festlegen

Wirkung:

- `multipart_movie_container` wird angelegt oder wiederverwendet
- die Discs werden als Child-Jobs darunter geführt
- zusätzlich wird ein Merge-Job vorbereitet

Relevante Settings:

- `mkvmerge_command`
- Film-Output-Templates
- Queue-Limits, falls mehrere Discs parallel weiterverarbeitet werden

## Workflow D: Audio-CD

### 1. TOC lesen und Metadaten wählen

1. Audio-CD analysieren
2. Tracks prüfen
3. Metadaten aus MusicBrainz übernehmen oder manuell anpassen

### 2. Trackauswahl und Format

Vor dem Start legst du fest:

- welche Tracks übernommen werden
- welches Ausgabeformat gilt
- welche Formatoptionen genutzt werden
- welche Pre-/Post-Encode-Skripte oder Ketten mitlaufen

### 3. Rip und Encode

Die CD läuft anschließend als Track-für-Track-Flow:

`CD-Metadatenauswahl` -> `CD-Startbereit` -> `CD-Rippen` -> `CD-Encodieren` -> `Fertig`

Relevante Settings:

- `CD RAW-Ordner`
- `CD Output-Ordner`
- `Eigentümer CD RAW-Ordner`
- `Eigentümer CD Output-Ordner`
- `CD Output Template`
- `cdparanoia Kommando`
- `Max. parallele Audio CD Jobs`
- `Audio CDs: Queue-Reihenfolge überspringen`

## Workflow E: Converter

### 1. Dateien bereitstellen

Dateien gelangen in den Converter über:

- Upload
- bestehende Ordner im `Converter Raw-Ordner`
- manuelle Dateiverwaltung im Explorer

### 2. Jobs aus Auswahl erzeugen

- Video und ISO: immer ein Job pro Datei
- Audio: ein Job pro Datei oder gemeinsamer Audio-Job

### 3. Job konfigurieren und starten

Je nach Medium:

- Video/ISO: Review mit Track- und Preset-Auswahl
- Audio: direkte Format- und Zielkonfiguration

Relevante Settings:

- `Erlaubte Datei-Endungen`
- `Auto-Scan (Polling)`
- `Polling-Intervall (Sekunden)`
- `Converter Raw-Ordner`
- `Converter Ausgabe (Video)`
- `Converter Ausgabe (Audio)`
- `Output-Template (Video)`
- `Output-Template (Audio)`
- globale Queue-Limits

## Workflow F: Audiobooks

### 1. AAX hochladen

1. Datei hochladen
2. Metadaten und Kapitel aufbauen lassen
3. bei Bedarf Activation Bytes klären

### 2. Ausgabeformat wählen

- `m4b`: eine Datei
- `mp3`: eine Datei pro Kapitel
- `flac`: eine Datei pro Kapitel

### 3. Kapitel und Skripte prüfen

Vor dem Start anpassbar:

- Kapitelnamen
- Pre-Encode-Skripte und -Ketten
- Post-Encode-Skripte und -Ketten

Relevante Settings:

- `Audiobook RAW-Ordner`
- `Audiobook Output-Ordner`
- `Audiobook RAW Template`
- `Output Template (Audiobook)`
- `Kapitel Template (Audiobook)`
- `FFprobe Kommando`
- `FFmpeg Kommando`
- globale Queue-Limits

## Workflow G: Nachbearbeitung in der Historie

Typische Folgeaktionen:

- `TMDb neu zuweisen`
- `Review neu starten`
- `RAW neu encodieren`
- `Encode neu starten`
- `Retry Rippen`
- `Download` als ZIP einreihen

Besonders wichtig:

- `Encode neu starten` verwendet den letzten bestätigten Plan
- `Encode-Neustart: unvollständige Ausgabe löschen` entscheidet, ob unvollständige Ausgaben vorher gelöscht werden

## Workflow H: Downloads und Recovery

### Downloads

Aus `Historie` können ZIPs für:

- `RAW`
- `Output`

erstellt werden.

Relevante Settings:

- `Download ZIP-Ordner`
- `Eigentümer Download ZIP-Ordner`

### Database (Expert)

Die Recovery-Seite hilft bei orphan RAW:

- `RAW prüfen`
- `Job anlegen`

So lassen sich vorhandene RAW-Verzeichnisse wieder in einen normalen Workflow zurückführen.

### TMDb Migration

Für ältere Bestandsjobs gibt es die Sonderseite `/tmdb-migration`, um mehrere Jobs nacheinander auf den heutigen TMDb-Stand zu bringen.
