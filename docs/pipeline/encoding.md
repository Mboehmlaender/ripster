# Encode-Planung & Track-Auswahl

Vor dem eigentlichen Encoding erstellt Ripster einen Encode-Plan und zeigt ihn im Review an.

---

## Ablauf

```text
Quelle bestimmen (Disc/RAW)
  -> HandBrake-Scan (--scan --json)
  -> Plan erstellen (Titel, Audio, Untertitel)
  -> Status: Bereit zum Encodieren
  -> Benutzer bestaetigt Auswahl
  -> finaler HandBrake-Aufruf
```

---

## Review-Inhalt (Status: `Bereit zum Encodieren`)

- auswählbarer Encode-Titel
- Audio-Track-Auswahl
- Untertitel-Track-Auswahl inkl. Flags
  - `burnIn`
  - `forced`
  - `defaultTrack`
- optionale User-Presets (HandBrake Preset + Extra Args)
- optionale Pre-/Post-Skripte und Ketten

---

## Bestaetigung (`confirm-encode`)

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

Die bestätigte Auswahl wird im Job gespeichert und für Neustarts wiederverwendet.

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

Fehlerverhalten:

- Pre-Encode-Fehler: Job endet mit Status `Fehler` (Encode startet nicht)
- Post-Encode-Fehler: Job kann `Fertig` bleiben, enthält aber Fehlerhinweis/Script-Summary

---

## Dateinamen/Ordner

Der finale Outputpfad wird aus den Templates in den Settings aufgebaut.

Platzhalter:

- `${title}`
- `${year}`
- `${imdbId}`

Ungültige Dateizeichen werden bereinigt.
