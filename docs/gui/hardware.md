# Hardware

Die Seite `Hardware` ist die ausführliche Detailansicht für das Live-Monitoring aus dem `Ripper`.

## Was die Seite zeigt

- aktuelle CPU-Auslastung
- RAM-Auslastung
- GPU-Auslastung und VRAM, falls vorhanden
- Temperaturen
- Verlaufshistorie für Auslastung und Temperatur
- Zeitfenster für `1h`, `6h`, `24h`, `4d`

## Live-Bereich

Oben zeigt die Seite:

- ob Monitoring aktiv ist
- aktuelles Polling-Intervall
- Zeitpunkt der letzten Messung

Wenn Monitoring deaktiviert ist, führt die Seite direkt zu `Settings`.

## Historie

Die Historie lädt Messpunkte aus dem Backend und zeigt:

- Auslastung als Linienchart
- Temperatur als Linienchart
- umschaltbare Serien für CPU, RAM und GPU

Das ist besonders nützlich bei:

- mehreren parallelen Encodes
- Fehlersuche bei Hitzespitzen
- Abschätzung, ob weitere Jobs sinnvoll gestartet werden können

## Relevante Settings

- `Hardware Monitoring aktiviert`
- `Hardware Monitoring Intervall (ms)`

Außerdem sinnvoll:

- `Externe Speicher`, damit Speicherstände im `Ripper` sinnvoll angezeigt werden
