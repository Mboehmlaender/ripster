# Ersteinrichtung

Nach der Installation erfolgt die tägliche Konfiguration fast vollständig in der GUI unter `Settings`.

## Ziel

Vor dem ersten echten Job müssen Pfade, Tools und Metadatenzugriff sauber gesetzt sein.

## Reihenfolge (empfohlen)

### 1. `Settings` -> Tab `Konfiguration`

Setze zuerst diese Pflichtwerte:

| Bereich | Wichtige Felder |
|---|---|
| Pfade | `raw_dir`, `movie_dir`, `log_dir` |
| Tools | `makemkv_command`, `handbrake_command`, `mediainfo_command` |
| Metadaten | `omdb_api_key`, optional `omdb_default_type` |

Danach `Änderungen speichern`.

### 2. Medienprofile prüfen

Wenn du Blu-ray und DVD unterschiedlich behandeln willst, pflege die profilbezogenen Felder:

- `*_bluray`
- `*_dvd`
- optional `*_other`

Typische Beispiele:

- `handbrake_preset_bluray` und `handbrake_preset_dvd`
- `raw_dir_bluray` und `raw_dir_dvd`
- `filename_template_bluray` und `filename_template_dvd`

### 3. Queue und Monitoring festlegen

- `pipeline_max_parallel_jobs` für parallele Jobs
- `hardware_monitoring_enabled` und Intervall für Live-Metriken im Dashboard

### 4. Optional: Push-Benachrichtigungen

In den Benachrichtigungsfeldern setzen:

- `pushover_enabled`
- `pushover_token`
- `pushover_user`

Dann über `PushOver Test` direkt prüfen.

## 2-Minuten-Funktionstest

1. `Dashboard` öffnen
2. Disc einlegen
3. `Analyse starten`
4. Metadaten übernehmen
5. Bis `READY_TO_ENCODE` laufen lassen

Wenn diese Schritte funktionieren, ist die Grundkonfiguration korrekt.

## Wenn Werte nicht gespeichert werden

- Feld mit Fehler markieren lassen (rote Validierung im Formular)
- Pfadangaben und numerische Werte prüfen
- bei Tool-Pfaden direkt CLI-Aufruf im Terminal testen

## Weiter

- [Erster Lauf](quickstart.md)
- [GUI-Seiten im Detail](../gui/index.md)
