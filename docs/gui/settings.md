# Settings

Die Seite `Settings` ist das Kontrollzentrum für Laufzeitverhalten, Standardwerte und Automatisierung. Alles, was spätere Jobs automatisch tun oder vorschlagen, wird hier vorbereitet.

Für die detaillierte Feld-für-Feld-Erklärung jeder einzelnen Einstellung nutze die Seite [Einstellungsreferenz](../configuration/settings-reference.md). Dort ist jedes sichtbare Feld aus der GUI mit Wirkung, Workflow-Bezug und typischem Einsatz beschrieben.

## Tab-Überblick

| Tab | Zweck |
|---|---|
| `Konfiguration` | alle fachlichen Einstellungen aus der GUI |
| `Scripte` | einzelne Bash-Skripte anlegen, testen und sortieren |
| `Skriptketten` | mehrstufige Abläufe aus Skript- und Warte-Schritten bauen |
| `Encode-Presets` | eigene Video-Presets und Standard-Zuordnungen pflegen |
| `Cronjobs` | zeitgesteuerte Ausführung von Skripten oder Ketten |

## Tab `Konfiguration`

### Bedienlogik

1. Felder ändern
2. `Änderungen speichern` klicken
3. erst dann gelten die neuen Werte für künftige Starts, Reviews oder Scheduler

Ausnahmen:

- `Expertenmodus` wird sofort gespeichert
- Buttons wie `PushOver Test`, `Coverarts prüfen` oder der MakeMKV-Betakey-Import lösen direkte Aktionen aus

### Toolbar-Aktionen

- `Änderungen speichern`: schreibt nur geänderte Felder
- `Änderungen verwerfen`: setzt den Formularzustand zurück
- `Neu laden`: lädt Schema und Werte neu
- `PushOver Test`: sendet eine Testnachricht mit den aktuellen PushOver-Werten
- `Coverarts prüfen`: startet den Coverart-Recovery-Lauf sofort

### Was die Kategorien im Alltag steuern

#### Benachrichtigungen

Hier steuerst du zwei Dinge:

- ob und wohin Ripster PushOver-Nachrichten sendet
- bei welchen Ereignissen Ripster überhaupt benachrichtigt

Wichtig:

- `PushOver aktiviert` ist der Master-Schalter
- `Bei manueller Auswahl senden` ist besonders relevant für Playlist-, RAW- oder Titelentscheidungen
- der `Expertenmodus` blendet zusätzliche technische Felder in der gesamten Settings-Seite ein

#### Laufwerk

Diese Kategorie beeinflusst, wie Ripster optische Laufwerke findet und überwacht.

Typische Fragen:

- Soll Ripster Laufwerke automatisch erkennen?
- Soll ein bestimmtes Laufwerk fest an einen MakeMKV-Index gebunden werden?
- Soll das Laufwerk nach erfolgreichem Rip automatisch auswerfen?

Das ist vor allem wichtig bei:

- mehreren Laufwerken
- USB-SATA-Adaptern
- Hosts mit instabilen Device-Namen

#### Logging

Diese Felder ändern nicht die Job-Logs auf Platte, sondern die Ausgabe im Server-Terminal.

Damit steuerst du zum Beispiel:

- ob `start.sh` oder ein Terminal-Run sehr gesprächig sein darf
- ob HTTP-Requests im Terminal sichtbar sein sollen
- ob DEBUG/INFO/WARN/ERROR dort mitlaufen

#### Metadaten

Hier legst du fest, wie Ripster mit TMDb, Covern und NFO-Dateien umgeht.

Besonders wichtig:

- ohne `TMDb Read Access Token` funktionieren Film-/Seriensuche und Neu-Zuordnung nur eingeschränkt oder gar nicht
- `Film-Sprache` und `Fallback Sprache` bestimmen, welche Titel, Beschreibungen und Staffelinformationen bevorzugt werden
- `Coverart-Nachladen aktiv` hilft bei nachträglich fehlenden Postern/Covern

#### Monitoring

Steuert das Hardware-Monitoring für:

- CPU
- RAM
- GPU
- Speicherstände

Diese Werte erscheinen:

- kompakt im `Ripper`
- ausführlich in der Seite `Hardware`

#### Pfade

Hier legst du fest, wohin Ripster schreibt und wie Dateien benannt werden.

Die Felder steuern:

- RAW-Verzeichnisse pro Medium
- Zielordner für Filme, Serien, CDs, Audiobooks, Converter und Downloads
- Eigentümer per `user:gruppe`
- Templates für Datei- und Ordnernamen

Praxisbeispiele:

- Serien getrennt von Filmen ablegen
- RAW auf große HDD, Final-Output auf NAS
- Audiobooks kapitelweise in Unterordnern strukturieren

#### Converter

Diese Kategorie wirkt nur auf die Seite `Converter`.

Sie steuert:

- welche Dateiendungen der Upload und der Verzeichnisscan akzeptieren
- ob der Converter-RAW-Baum automatisch neu gescannt wird
- wie häufig dieses Polling läuft

#### Tools

Diese Kategorie entscheidet über das technische Verhalten der eigentlichen Pipeline.

Dazu gehören:

- Pfade/Befehle für externe Tools
- MakeMKV-Filter und Rip-Modi
- HandBrake-Presets und Extra-Args
- Vorauswahl von Audio-/Untertitelsprachen in der Review
- Ausgabeformate
- Queue- und Parallelitätsregeln
- Timeout für Script-Tests

Für die Nutzer-Workflows besonders relevant:

- `Minimale Titellänge (Minuten)`
- `TMDb Runtime-Abzug für Playlistfilter (%)`
- `HandBrake Preset` und `HandBrake Extra Args`
- `Review Audio-Sprachen (...)`
- `Review UT-Sprachen (...)`
- `Parallele Jobs`
- `Max. parallele Audio CD Jobs`
- `Max. Encodes gesamt (medienunabhängig)`

### Kategorie `Pfade`: Besondere Interaktion

Die Pfad-Kategorie hat eine eigene Darstellung:

- Tabelle `Effektive Pfade`: zeigt die aktuell wirklich verwendeten Laufzeitpfade inklusive Fallbacks
- Accordion pro Bereich wie `Blu-ray`, `DVD`, `CD / Audio`, `Audiobook`, `Converter`, `Downloads`, `Logs`
- Owner-Felder (`*_owner`) erscheinen direkt beim zugehörigen Pfad
- Owner-Felder sind deaktiviert, solange der zugehörige Pfad leer ist

### Spezial-Editoren

- `Explizite Laufwerke`: Editor für mehrere Laufwerke mit Pfad und MakeMKV-Index
- `Externe Speicher`: Liste aus Anzeigename und Pfad für die Speicheranzeige
- `Erlaubte Datei-Endungen`: Auswahl der erlaubten Upload-/Scan-Endungen
- `MakeMKV Key`: inkl. Betakey-Hinweis und Übernahme-Button

### Wichtig für Reviews und Workflows

Die Seite `Settings` bestimmt direkt, was Nutzer später im Workflow sehen:

- Playlist-Kandidaten werden durch `Minimale Titellänge` und `TMDb Runtime-Abzug ...` beeinflusst
- Audio-/Untertitel-Vorauswahlen in `Bereit zum Encodieren` hängen an den Review-Sprachfeldern
- automatisch vorgeschlagene Presets hängen an den Standard-Zuordnungen unter `Encode-Presets`
- Queue-Verhalten im `Ripper` hängt an den drei Parallelitätsfeldern plus `Audio CDs: Queue-Reihenfolge überspringen`

## Tab `Scripte`

Funktionen:

- Skript anlegen
- Skript bearbeiten
- Skript löschen
- Skript testen
- Reihenfolge per Drag-and-Drop ändern
- Favorit markieren

Das Testergebnis zeigt:

- Erfolg oder Fehler
- Exit-Code
- Dauer
- stdout/stderr
- Timeout, falls `Script-Test Timeout (ms)` greift

## Tab `Skriptketten`

Skriptketten bestehen aus Schritten:

- `Skript`
- `Warten (Sekunden)`

Funktionen:

- Ketten anlegen, bearbeiten, löschen
- Reihenfolge der Ketten ändern
- einzelne Ketten testen
- Schritte innerhalb der Kette per Drag-and-Drop sortieren

Wichtig:

- dieselben Skripte können sowohl in Jobs als auch in Ketten und Cronjobs wiederverwendet werden

## Tab `Encode-Presets`

Hier werden Video-Standards für Disc- und Converter-Workflows verwaltet.

### Standard-Zuordnungen

Es gibt vier feste Slots:

- `Blu-ray Film`
- `Blu-ray Serie`
- `DVD Film`
- `DVD Serie`

Wenn für einen Workflow hier ein Default gesetzt ist, erscheint dieses User-Preset später in der Review bereits vorausgewählt.

### Preset-Inhalt

Ein User-Preset besteht aus:

- Name
- Medientyp (`all`, `bluray`, `dvd`)
- HandBrake-Preset
- Extra Args
- optionaler Beschreibung

## Tab `Cronjobs`

Funktionen:

- Cronjob anlegen, bearbeiten, löschen
- Cron-Ausdruck live validieren
- Quelle wählen: `Skript` oder `Skriptkette`
- Aktiv- und PushOver-Status pro Job setzen
- `Jetzt ausführen`
- Lauf-Logs öffnen

Die Runtime-Aktivitäten der laufenden Cronjobs werden zusätzlich live angezeigt.

## Expertenbereich: Activation Bytes Cache

Dieser Block wird nur im Expertenmodus angezeigt.

Er zeigt lokal bekannte AAX-Activation-Bytes mit:

- Prüfsumme
- Activation Bytes
- Speicherzeitpunkt

Das hilft bei Audiobook-Workflows, wenn dieselbe Datei oder derselbe Hash später erneut auftaucht.

## Validierung von Template-Feldern

Template-Felder akzeptieren nur:

- Buchstaben und Ziffern
- Leerzeichen
- `_` und `-`
- Platzhalter in `{...}` oder `${...}`
- `/` für Unterordner

Damit verhindert Ripster fehlerhafte Dateinamen schon beim Speichern.

## Siehe auch

- [Alle Einstellungen](../configuration/settings-reference.md)
- [Ripper](ripper.md)
- [Workflows aus Nutzersicht](../workflows/index.md)
