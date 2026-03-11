# Historie

Die Seite `Historie` ist für Suche, Prüfung und Nachbearbeitung bestehender Jobs.

## Hauptansicht

Filter und Werkzeuge:

- Suche (Titel/IMDb)
- Status-Filter
- Medium-Filter (`Blu-ray`, `DVD`, `Sonstiges`)
- Sortierung
- Listen-/Grid-Layout

Jeder Eintrag zeigt:

- Poster, Titel, Jahr, IMDb
- Medium-Indikator
- Status
- Start/Ende
- Verfügbarkeit von RAW/Movie
- Ratings (wenn OMDb-Daten vorhanden)

Klick auf einen Eintrag öffnet die Detailansicht.

---

## Job-Detaildialog

Bereiche:

- Film-Infos + OMDb-Details
- Job-Infos (Status, Pfade, Erfolgsflags, Fehler)
- hinterlegte Encode-Auswahl
- ausgeführter HandBrake-Befehl
- strukturierte JSON-Blöcke (OMDb/MakeMKV/MediaInfo/EncodePlan/HandBrake)
- Log-Ladefunktionen (`Tail`, `Vollständig`)

## Typische Aktionen im Detaildialog

- `OMDb neu zuordnen`
- `Encode neu starten`
- `Review neu starten`
- `RAW neu encodieren`
- `RAW löschen`, `Movie löschen`, `Beides löschen`
- `Historieneintrag löschen`
- bei Queue-Lock: `Aus Queue löschen`

## Wann welche Aktion?

| Ziel | Aktion |
|---|---|
| Metadaten korrigieren | `OMDb neu zuordnen` |
| mit gleicher bestätigter Auswahl neu encodieren | `Encode neu starten` |
| Titel-/Spurprüfung komplett neu berechnen | `Review neu starten` |
| aus vorhandenem RAW erneut encodieren | `RAW neu encodieren` |
| Speicher freigeben | Dateilöschaktionen |

## Logs

- `Tail laden (800)` für schnelle Fehleranalyse
- `Vollständiges Log laden` für vollständige Nachverfolgung
