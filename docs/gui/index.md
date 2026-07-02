# GUI-Seiten

Dieses Kapitel ist das Bedienhandbuch für die Oberflächen im Alltag.

## Seitenüberblick

| Seite | Rolle im Betrieb | Typischer Einsatz |
|---|---|---|
| [Ripper](ripper.md) | Live-Steuerung der Disc-Pipeline | Disc erkennen, Analyse starten, Entscheidungen treffen, Queue steuern |
| [Hardware](hardware.md) | Detailansicht für Live-Monitoring | CPU/RAM/GPU und Verlauf prüfen |
| [Audiobooks](audiobooks.md) | AAX-Spezialflow | Upload, Kapitelprüfung und Encode von Audiobooks |
| [Settings](settings.md) | Konfiguration und Automatisierung | Pfade, Tools, Queue, Presets, Skripte, Cron |
| [Historie](history.md) | Nachbearbeitung und Kontrolle | Logs, Re-Encode, TMDb-Neuzuordnung, Löschvorschau |
| [Converter](converter.md) | dateibasierte Konvertierung | Video/Audio/ISO ohne Disc-Rip verarbeiten |
| [Downloads](downloads.md) | ZIP-Exports | RAW/Output aus der Historie bereitstellen |
| [Database (Expert)](database.md) | Recovery-Sicht | orphan RAW finden, prüfen und importieren |
| [TMDb Migration](tmdb-migration.md) | Sonderseite für Altbestände | alte Jobs gesammelt auf TMDb umstellen |

## Empfohlener Tagesablauf

1. `Ripper`, `Converter` oder `Audiobooks`: neue Arbeit starten
2. `Historie`: Ergebnisse kontrollieren und ggf. nachbearbeiten
3. `Downloads`: Artefakte für externe Übergabe vorbereiten
4. `Settings`: Regeln, Presets oder Limits nur kontrolliert anpassen
5. `Hardware`: bei Lastspitzen oder Batch-Läufen den Verlauf prüfen

## Navigation

Direkt in der Top-Navigation:

- `Ripper`
- `Converter`
- `Audiobooks`
- `Settings`
- `Historie`
- `Downloads`

Zusatzansichten:

- `Hardware` unter `/hardware`
- `Database` unter `/database` und im Expertenmodus zusätzlich in der Navigation
- `TMDb Migration` unter `/tmdb-migration` als Direktlink
