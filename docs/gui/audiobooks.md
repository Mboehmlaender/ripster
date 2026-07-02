# Audiobooks

Die Seite `Audiobooks` ist der spezialisierte Workflow für Audible-`*.aax`-Dateien.

## Seitenstruktur

Die Oberfläche besteht aus zwei Hauptbereichen:

1. `Audiobooks Upload`
2. `Audiobook Jobs`

## 1. Audiobooks Upload

Der Upload akzeptiert ausschließlich `.aax`.

### Bedienung

- Datei auswählen oder per Drag-and-Drop ablegen
- Upload starten
- Auswahl entfernen oder laufenden Upload abbrechen

Während des Uploads zeigt die UI:

- Prozentfortschritt
- übertragene und gesamte Bytes
- Statusmeldung

### Ablauf nach erfolgreichem Upload

- die AAX-Datei wird geprüft
- Ripster versucht Metadata, Kapitel und Activation-Bytes-Kontext aufzubauen
- ein Audiobook-Job wird angelegt
- der Job startet direkt oder wird in die Queue eingereiht

## 2. Audiobook Jobs

Die Seite zeigt aktive Jobs. Abgeschlossene Jobs findest du in der `Historie`.

Ein Job kann eingeklappt oder ausgeklappt werden und zeigt:

- Titel, Autor, Sprecher, Jahr
- Kapitelanzahl
- Fortschritt und ETA
- bei Split-Ausgabe den Kapitelstatus

## Konfigurierbare Job-Parameter

Im ausgeklappten Job kannst du setzen:

- Ausgabeformat `m4b`, `mp3` oder `flac`
- formatspezifische Optionen
- Kapitelnamen
- Pre-Encode-Skripte und -Ketten
- Post-Encode-Skripte und -Ketten

### Formatverhalten

- `m4b`: eine Datei mit Kapitelmarken
- `mp3`: eine Datei pro Kapitel
- `flac`: eine Datei pro Kapitel

Wenn du `mp3` oder `flac` wählst, zeigt die UI zusätzlich eine Kapitel-Status-Tabelle.

## Activation Bytes

Wenn Ripster für eine Datei keine Activation Bytes verwenden kann, wird im Workflow eine manuelle Eingabe nötig.

Wichtig:

- die Bytes werden lokal gecacht
- derselbe AAX-Hash muss dann später nicht erneut manuell eingegeben werden
- der Expertenblock in `Settings` zeigt bekannte Cache-Einträge an

## Relevante Settings

- `Audiobook RAW-Ordner`
- `Audiobook Output-Ordner`
- `Eigentümer Audiobook RAW-Ordner`
- `Eigentümer Audiobook Output-Ordner`
- `Audiobook RAW Template`
- `Output Template (Audiobook)`
- `Kapitel Template (Audiobook)`
- `FFprobe Kommando`
- `FFmpeg Kommando`

### So wirken die Settings im Alltag

- `Audiobook RAW Template` bestimmt den Namen des AAX-RAW-Ordners
- `Output Template (Audiobook)` bestimmt die Einzeldatei für `m4b`
- `Kapitel Template (Audiobook)` bestimmt Zielstruktur und Dateinamen für `mp3`/`flac`
- `FFprobe Kommando` liest Kapitel und Metadaten
- `FFmpeg Kommando` erzeugt die finalen Dateien

## Queue und Laufzeit

Audiobook-Jobs nutzen dieselbe globale Pipeline wie die anderen Bereiche.

Relevante Settings:

- `Parallele Jobs`
- `Max. Encodes gesamt (medienunabhängig)`

## Typische Fehlerbilder

- Upload wird abgelehnt: Datei ist keine gültige `*.aax`
- Analyse schlägt fehl: `ffprobe` ist nicht erreichbar
- Encode schlägt fehl: `ffmpeg` ist nicht erreichbar
- Ausgabe landet unerwartet: Templates oder Zielpfade passen nicht zur gewünschten Struktur
