# TMDb Migration

Die Seite `TMDb Migration` ist eine Sonderansicht für ältere Bestandsjobs, die noch nicht als auf TMDb migriert markiert sind.

## Zugriff

- Direktlink: `/tmdb-migration`
- nicht in der normalen Top-Navigation verlinkt

## Wofür die Seite gedacht ist

Typische Einsatzfälle:

- Altbestand aus früheren Ständen bereinigen
- mehrere Jobs nacheinander auf aktuelle TMDb-Metadaten umstellen
- Historie konsistent auf den heutigen Metadaten-Workflow bringen

## Funktionsweise

Die Seite lädt offene Migrationskandidaten und zeigt:

- Job-ID
- Titel
- Jahr
- Medium
- aktuellen Status

Aktionen:

- `Liste neu laden`
- `Start`
- `Stop`

## Ablauf einer Sequenz

1. Jobliste laden
2. `Start`
3. der bekannte TMDb-Metadaten-Dialog öffnet sich für den ersten Job
4. nach erfolgreicher Übernahme plant Ripster den nächsten Job mit Cooldown

Wichtig:

- zwischen zwei Jobs liegt bewusst eine Wartezeit von mindestens 10 Sekunden
- damit wird die TMDb-API bei Serienmigrationen nicht unnötig belastet

## Relevante Settings

- `TMDb Read Access Token`
- `Film-Sprache`
- `Fallback Sprache`

Ohne diese Einstellungen ist die Migration nicht sinnvoll nutzbar.
