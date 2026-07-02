# Database (Expert)

`/database` ist die Recovery- und Expertensicht für Fälle, in denen Dateisystem und Historie nicht mehr sauber zusammenpassen.

## Zugriff

- direkte Route: `/database`
- nicht Teil der Standardnavigation

## Bereich `Gefundene RAW-Einträge`

Dieser Bereich listet RAW-Verzeichnisse ohne zugeordneten Historie-Job.

Aktionen:

- `RAW prüfen`: scannt konfigurierte RAW-Wurzeln
- `Job anlegen`: erstellt aus einem orphan RAW einen neuen Historie-Job

## Was bei `Job anlegen` passiert

- RAW-Pfad wird als Importquelle registriert
- Job wird in die Historie geschrieben
- anschließende Analyse läuft als RAW-basierter Einstieg (ohne klassischen Disc-Read)

Typischer Einsatz:

- manuelle Dateioperationen außerhalb der UI
- Migrationen
- Wiederherstellung nach abgebrochenen Läufen

## Sicherheits- und Betriebsregeln

- Aktionen wirken direkt auf produktive Historie/Dateipfade.
- Vor Import oder Löschung immer Pfad und Ziel prüfen.
- Diese Seite nur für Recovery-Szenarien nutzen, nicht für normalen Tagesbetrieb.
