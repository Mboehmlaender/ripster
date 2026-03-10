# Encode-Skripte (Pre & Post)

Ripster kann Skripte und Skript-Ketten vor und nach dem Encode ausführen.

---

## Ablauf

```text
READY_TO_ENCODE
  -> Pre-Encode Skripte/Ketten
  -> HandBrake Encoding
  -> Post-Encode Skripte/Ketten
  -> FINISHED oder ERROR
```

---

## Auswahl im Review

Im Review-Panel kannst du getrennt wählen:

- `selectedPreEncodeScriptIds`
- `selectedPostEncodeScriptIds`
- `selectedPreEncodeChainIds`
- `selectedPostEncodeChainIds`

---

## Fehlerverhalten

- Pre-Encode-Fehler stoppen die Kette und führen zu `ERROR`.
- Post-Encode-Fehler stoppen die restlichen Post-Schritte; Job kann dennoch `FINISHED` sein (mit Fehlerzusatz im Status/Log).

---

## Verfügbare Umgebungsvariablen

Beim Script-Run werden gesetzt:

- `RIPSTER_SCRIPT_RUN_AT`
- `RIPSTER_JOB_ID`
- `RIPSTER_JOB_TITLE`
- `RIPSTER_MODE`
- `RIPSTER_INPUT_PATH`
- `RIPSTER_OUTPUT_PATH`
- `RIPSTER_RAW_PATH`
- `RIPSTER_SCRIPT_ID`
- `RIPSTER_SCRIPT_NAME`
- `RIPSTER_SCRIPT_SOURCE`

---

## Skript-Ketten

Ketten unterstützen zwei Step-Typen:

- `script` (führt ein hinterlegtes Skript aus)
- `wait` (wartet `waitSeconds`)

Bei Fehler in einem Script-Step wird die Kette abgebrochen.

---

## Testläufe

- Skript testen: `POST /api/settings/scripts/:id/test`
- Kette testen: `POST /api/settings/script-chains/:id/test`

Ergebnisse enthalten Erfolg/Exit-Code, Laufzeit und stdout/stderr.
