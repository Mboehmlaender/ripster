# Converter

Die Seite `Converter` verarbeitet vorhandene Dateien ohne Laufwerks-Rip. Sie ist für Video-, Audio- und ISO-Dateien gedacht, die bereits auf dem System liegen oder hochgeladen werden.

## Betriebsmodell

Der Converter arbeitet auf dem in `Settings` festgelegten `Converter Raw-Ordner`.

Dort landen:

- Uploads
- neu angelegte Ordner
- umbenannte oder verschobene Dateien
- alle Dateien, aus denen später Converter-Jobs entstehen

Wichtig:

- Upload erzeugt nicht automatisch einen Job
- die Joberstellung erfolgt bewusst aus der Explorer-Auswahl

## Datei-Explorer

Der Explorer zeigt den kompletten Baum unter `Converter Raw-Ordner`.

Aktionen:

| Aktion | Wirkung |
|---|---|
| `Upload` | schreibt neue Dateien in den Converter-RAW-Baum |
| `Ordner erstellen` | legt Unterordner an |
| `Umbenennen` | benennt Datei oder Ordner um |
| `Verschieben` | verschiebt Einträge innerhalb des Raw-Baums |
| `Löschen` | entfernt Datei oder Ordner dauerhaft |
| `Scannen` | synchronisiert Dateisystem und Converter-Datenbank |

### Upload- und Scan-Regeln

- Dateiendungen müssen in `Erlaubte Datei-Endungen` enthalten sein
- neue Dateien erscheinen sofort nach manuellem Scan
- mit Polling auch automatisch

Relevante Settings:

- `Erlaubte Datei-Endungen`
- `Auto-Scan (Polling)`
- `Polling-Intervall (Sekunden)`

## Joberstellung aus Explorer-Auswahl

Es gibt zwei Audio-Strategien:

1. `Ein Job pro Datei`
2. `Gemeinsamer Job (Audio)`

Verhalten:

- Video und ISO werden immer als Einzeljobs angelegt
- Audio kann als gemeinsamer Album-/Ordner-Job erzeugt werden

Shared-Audio-Job:

- hält mehrere `inputPaths`
- kann vor dem Start erweitert oder reduziert werden

## Job-Konfiguration

Vor dem Start je Job einstellbar:

- `converterMediaType`
- `outputFormat`
- Metadaten
- Track-/Titelwahl bei Video/ISO
- User-Preset und HandBrake-Preset bei Video
- Pre-/Post-Encode-Skripte und Ketten

Spezifika:

- Video/ISO durchlaufen eine Review ähnlich zum Disc-Flow
- Audio wird direkt über Format und Audio-Optionen konfiguriert

## Ausgabe-Pfade

### Video / ISO

- Zielordner: `Converter Ausgabe (Video)`
- Dateiname: `Output-Template (Video)`
- Endung: aus dem gewählten Ausgabeformat

### Audio

- Zielordner: `Converter Ausgabe (Audio)`
- Dateiname/Ordner: `Output-Template (Audio)`
- bei Shared- oder Folder-Jobs entsteht eine Ordnerstruktur mit mehreren Track-Dateien

Relevante Settings:

- `Converter Ausgabe (Video)`
- `Converter Ausgabe (Audio)`
- `Output-Template (Video)`
- `Output-Template (Audio)`
- `Eigentümer Converter Video Output-Ordner`
- `Eigentümer Converter Audio Output-Ordner`

## Queue und Start

Converter-Jobs laufen über dieselbe globale Pipeline-Queue wie Ripper und Audiobooks.

Das bedeutet:

- sofortiger Start, wenn Limits frei sind
- sonst Einreihung in die Warteschlange

Relevante Settings:

- `Parallele Jobs`
- `Max. Encodes gesamt (medienunabhängig)`

## Typische Einsatzfälle

- vorhandene MKV/MP4-Dateien mit neuem Preset encodieren
- ISO-Dateien in einen Video-Workflow überführen
- Musikdateien gesammelt in einen Audio-Ordner-Job packen
- Medien auf anderem Storage per Upload oder Dateibaum vorbereiten

## Abgrenzung zu Audiobooks

- `Converter`: beliebige Audio-, Video- und ISO-Dateien
- `Audiobooks`: spezialisierter AAX-Workflow mit Activation Bytes, Kapitelmetadaten und Kapiteltemplates
