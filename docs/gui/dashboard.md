# Dashboard

Das Dashboard ist die **Betriebszentrale** für laufende Jobs.

## Aufbau der Seite

Die Bereiche erscheinen in dieser Reihenfolge:

1. `Hardware Monitoring`
2. `Job Queue`
3. `Skript- / Cron-Status`
4. `Job Übersicht`
5. `Disk-Information`

---

## 1) Hardware Monitoring

Zeigt live:

- CPU (gesamt + optional pro Kern)
- RAM
- GPU-Auslastung/Temperatur/VRAM
- freien Speicher in den konfigurierten Pfaden

Wichtig für den Betrieb:

- Hohe Speicherauslastung oder fast volle Zielpfade früh erkennen
- über `Settings` aktivierbar/deaktivierbar (`Hardware Monitoring aktiviert`)

## 2) Job Queue

Zwei Spalten:

- `Laufende Jobs`
- `Warteschlange`

Mögliche Aktionen:

- Queue per Drag-and-Drop umsortieren
- Queue-Job entfernen (`X`)
- zusätzliche Queue-Elemente einfügen (`+`):
  - Skript
  - Skriptkette
  - Wartezeit

Hinweis:

- `Parallel` zeigt den Wert aus `Settings` -> `Parallele Jobs`.

## 3) Skript- / Cron-Status

Zeigt:

- aktive Ausführungen (Skripte, Ketten, Cron)
- zuletzt abgeschlossene Ausführungen

Mögliche Aktionen:

- laufende Ketten: `Nächster Schritt`
- laufende Einträge: `Abbrechen`
- Historie der Aktivitäten: `Liste leeren`

## 4) Job Übersicht

Kompakte Jobliste mit Status, Fortschritt, ETA. Klick auf einen Job klappt die Detailsteuerung auf.

Im aufgeklappten Zustand erscheint die Karte `Pipeline-Status` mit allen zustandsabhängigen Aktionen.

### Zustandsabhängige Hauptaktionen

| Zustand | Typische Aktion |
|---|---|
| `Medium erkannt` / `Bereit` | `Analyse starten` |
| `Metadatenauswahl` | `Metadaten öffnen` |
| `Warte auf Auswahl` | Playlist wählen und `Playlist übernehmen` |
| `Startbereit` | `Job starten` |
| `Bereit zum Encodieren` | Tracks/Skripte prüfen, dann `Encoding starten` |
| laufend (`Analyse`/`Rippen`/`Encodieren`) | `Abbrechen` |
| `Fehler` / `Abgebrochen` | `Retry Rippen`, `Disk-Analyse neu starten` |

Zusätzlich je nach Job:

- `Review neu starten`
- `Encode neu starten`
- `Aus Queue löschen`

### Titel-/Spurprüfung (`Bereit zum Encodieren`)

Im selben Block siehst du:

- Auswahl des Encode-Titels
- Audio-/Subtitle-Trackauswahl
- User-Preset-Auswahl
- Pre-/Post-Encode-Skripte und Ketten
- Preview des finalen HandBrakeCLI-Befehls

## 5) Disk-Information

Zeigt aktuelles Laufwerk und Disc-Metadaten (`Pfad`, `Modell`, `Disc-Label`, `Mount`).

Aktionen:

- `Laufwerk neu lesen`
- `Disk neu analysieren`
- `Metadaten-Modal öffnen`

---

## Wichtige Dialoge im Dashboard

### Metadaten auswählen

- OMDb-Suche + Ergebnisliste
- manuelle Eingabe als Fallback
- `Auswahl übernehmen` startet den nächsten Pipeline-Schritt

### Abbruch-Bereinigung

Nach Abbruch kann Ripster optional fragen, ob erzeugte RAW- oder Movie-Dateien gelöscht werden sollen.

### Queue-Eintrag einfügen

Erstellt gezielt einen Skript-, Ketten- oder Warte-Eintrag an einer bestimmten Queue-Position.
