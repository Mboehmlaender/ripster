# Ersteinrichtung

Nach der Installation erfolgt die tägliche Konfiguration fast vollständig in der GUI unter `Settings`.

## Ziel

Vor dem ersten echten Job müssen Pfade, Tools und Metadatenzugriff sauber gesetzt sein.

## Reihenfolge (empfohlen)

### 1. `Settings` -> Tab `Konfiguration`

Setze zuerst diese Pflichtwerte:

| Bereich | Wichtige Felder |
|---|---|
| Pfade | `Raw Ausgabeordner`, `Film Ausgabeordner`, `Log Ordner` |
| Tools | `MakeMKV Kommando`, `HandBrake Kommando`, `Mediainfo Kommando` |
| Metadaten | `OMDb API Key`, optional `OMDb Typ` |

Danach `Änderungen speichern`.

### 2. Medienprofile prüfen

Wenn du Blu-ray und DVD unterschiedlich behandeln willst, pflege die profilbezogenen Felder:

- `*_bluray`
- `*_dvd`
- optional `*_other`

Typische Beispiele:

- `HandBrake Preset` (Blu-ray und DVD)
- `Raw Ausgabeordner` (Blu-ray und DVD)
- `Dateiname Template` (Blu-ray und DVD)

### 3. Queue und Monitoring festlegen

- `Parallele Jobs` für den gleichzeitigen Durchsatz
- `Hardware Monitoring aktiviert` + `Hardware Monitoring Intervall (ms)` für Live-Metriken im Dashboard

### 4. Optional: Push-Benachrichtigungen

In den Benachrichtigungsfeldern setzen:

- `PushOver aktiviert`
- `PushOver Token`
- `PushOver User`

Dann über `PushOver Test` direkt prüfen.

## 2-Minuten-Funktionstest

1. `Dashboard` öffnen
2. Disc einlegen
3. `Analyse starten`
4. Metadaten übernehmen
5. Bis `Bereit zum Encodieren` laufen lassen

Wenn diese Schritte funktionieren, ist die Grundkonfiguration korrekt.

## Wenn Werte nicht gespeichert werden

- Feld mit Fehler markieren lassen (rote Validierung im Formular)
- Pfadangaben und numerische Werte prüfen
- bei Tool-Pfaden direkt CLI-Aufruf im Terminal testen

## Weiter

- [Erster Lauf](quickstart.md)
- [GUI-Seiten im Detail](../gui/index.md)
