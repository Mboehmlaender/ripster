# Settings

Die Seite `Settings` steuert Konfiguration und Automatisierung.

## Tabs im Überblick

| Tab | Zweck |
|---|---|
| `Konfiguration` | alle Kernsettings (Pfade, Tools, Monitoring, Metadaten, Queue, Benachrichtigungen) |
| `Scripte` | einzelne Bash-Skripte verwalten und testen |
| `Skriptketten` | Sequenzen aus Skript- und Warte-Schritten bauen |
| `Encode-Presets` | benutzerdefinierte Presets für das Review im Dashboard |
| `Cronjobs` | zeitgesteuerte Skript-/Kettenausführung |

---

## Tab `Konfiguration`

Wichtiges Bedienmuster:

1. Werte ändern
2. `Änderungen speichern`
3. bei Bedarf `Änderungen verwerfen` oder `Neu laden`

Zusätzlich:

- `PushOver Test` sendet eine Testnachricht
- Änderungen werden erst nach Speichern wirksam
- Tool-Preset-Felder bieten HandBrake-Presetauswahl direkt im Formular

## Tab `Scripte`

Funktionen:

- Skript anlegen, bearbeiten, löschen
- Skript testen (`Test`)
- Reihenfolge per Drag-and-Drop

Praxis:

- Reihenfolge ist wichtig, weil ausgewählte Skripte später sequentiell abgearbeitet werden.
- Testresultate zeigen Exit-Code, Dauer und stdout/stderr.

## Tab `Skriptketten`

Funktionen:

- Kette anlegen/bearbeiten/löschen
- Kette testen
- Reihenfolge der Ketten per Drag-and-Drop

Im Ketten-Editor:

- Bausteine links (`Warten`, vorhandene Skripte)
- Schritte rechts per Klick oder Drag-and-Drop hinzufügen
- Schrittreihenfolge im Canvas ändern

## Tab `Encode-Presets`

Ein Preset bündelt:

- optional HandBrake-Preset (`-Z`)
- optionale Extra-Args
- Medientyp (`Universell`, `Blu-ray`, `DVD`, `Sonstiges`)

Verwendung:

- Diese Presets erscheinen später im Dashboard im Review (`Bereit zum Encodieren`).

## Tab `Cronjobs`

Funktionen:

- Cronjob anlegen und bearbeiten
- Quelle wählen: Skript oder Skriptkette
- Cron-Ausdruck validieren
- `Jetzt ausführen`
- Logs je Cronjob anzeigen
- `Aktiviert` und `Pushover` toggeln

Hilfen:

- Beispiele für Cron-Ausdrücke direkt im Dialog
- Link zu `crontab.guru` im Editor

---

## Empfehlung für stabile Nutzung

1. Erst `Konfiguration` sauber setzen
2. dann Skripte/Ketten testen
3. danach Cronjobs aktivieren
