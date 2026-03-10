# Encode-Planung & Track-Auswahl

Ripster erzeugt vor dem Encode einen `encodePlan` und lässt ihn im Review-Panel bestätigen.

---

## Ablauf

```text
Quelle bestimmen (Disc/RAW)
  -> HandBrake-Scan (--scan --json)
  -> Plan erstellen (Titel, Audio, Untertitel)
  -> READY_TO_ENCODE
  -> Benutzer bestätigt Auswahl
  -> finaler HandBrake-Aufruf
```

---

## Review-Inhalt (`READY_TO_ENCODE`)

- auswählbarer Encode-Titel
- Audio-Track-Selektion
- Untertitel-Track-Selektion inkl. Flags
  - `burnIn`
  - `forced`
  - `defaultTrack`
- optionale User-Presets (HandBrake-Preset + Extra-Args)
- optionale Pre-/Post-Skripte und Ketten

---

## Bestätigung (`confirm-encode`)

Typischer Payload:

```json
{
  "selectedEncodeTitleId": 1,
  "selectedTrackSelection": {
    "1": {
      "audioTrackIds": [1, 2],
      "subtitleTrackIds": [3]
    }
  },
  "selectedPreEncodeScriptIds": [1],
  "selectedPostEncodeScriptIds": [2],
  "selectedPreEncodeChainIds": [3],
  "selectedPostEncodeChainIds": [4],
  "selectedUserPresetId": 5
}
```

Ripster speichert die bestätigte Auswahl in `jobs.encode_plan_json` und markiert `encode_review_confirmed = 1`.

---

## HandBrake-Aufruf

Grundstruktur:

```bash
HandBrakeCLI \
  -i <input> \
  -o <output> \
  -t <titleId> \
  -Z "<preset>" \
  <extra-args> \
  -a <audioTrackIds|none> \
  -s <subtitleTrackIds|none>
```

Untertitel-Flags werden bei Bedarf ergänzt:

- `--subtitle-burned=<id>`
- `--subtitle-default=<id>`
- `--subtitle-forced=<id>` oder `--subtitle-forced`

---

## Pre-/Post-Encode-Ausführungen

- Pre-Encode läuft vor HandBrake
- Post-Encode läuft nach HandBrake

Verhalten bei Fehlern:

- Pre-Encode-Fehler: Job wird als `ERROR` beendet (Encode startet nicht)
- Post-Encode-Fehler: Job kann `FINISHED` bleiben, enthält aber Fehlerhinweis/Script-Summary

---

## Dateinamen/Ordner

Der finale Outputpfad wird aus Settings-Templates aufgebaut.

Platzhalter:

- `${title}`
- `${year}`
- `${imdbId}`

Ungültige Dateizeichen werden sanitisiert.
