# Encode-Planung

`encodePlan.js` analysiert die MediaInfo-Ausgabe und erstellt einen strukturierten Encode-Plan mit Track-Auswahl.

---

## Ablauf

```
MediaInfo-JSON
      ↓
Track-Parsing (Video, Audio, Untertitel)
      ↓
Sprach-Normalisierung (ISO 639-1 → 639-3)
      ↓
Codec-Klassifizierung (copy-kompatibel / transcode)
      ↓
Encode-Plan generieren
      ↓
Benutzer-Review im Frontend
      ↓
HandBrake-CLI-Argumente aufbauen
```

---

## Encode-Plan-Format

Der generierte Plan wird als JSON im Job-Datensatz gespeichert:

```json
{
  "inputFile": "/mnt/raw/Inception_t00.mkv",
  "outputFile": "/mnt/movies/Inception (2010).mkv",
  "preset": "H.265 MKV 1080p30",
  "audioTracks": [
    {
      "index": 1,
      "codec": "dts",
      "language": "deu",
      "channels": 6,
      "label": "Deutsch (DTS, 5.1)",
      "copyCompatible": false,
      "selected": true
    },
    {
      "index": 2,
      "codec": "truehd",
      "language": "eng",
      "channels": 8,
      "label": "English (TrueHD, 7.1)",
      "copyCompatible": true,
      "selected": true
    }
  ],
  "subtitleTracks": [
    {
      "index": 1,
      "language": "deu",
      "label": "Deutsch",
      "selected": true
    }
  ]
}
```

---

## Sprach-Normalisierung

MediaInfo liefert Sprachcodes in verschiedenen Formaten. `encodePlan.js` normalisiert diese auf **ISO 639-3**:

| MediaInfo-Output | Normalisiert |
|----------------|-------------|
| `de` | `deu` |
| `German` | `deu` |
| `en` | `eng` |
| `English` | `eng` |
| `fr` | `fra` |
| `ja` | `jpn` |

---

## Codec-Klassifizierung

HandBrake kann einige Codecs direkt kopieren (ohne Transcoding):

| Codec | Copy-kompatibel | HandBrake-Encoder |
|-------|----------------|------------------|
| `ac3` | ✅ Ja | `copy:ac3` |
| `aac` | ✅ Ja | `copy:aac` |
| `mp3` | ✅ Ja | `copy:mp3` |
| `truehd` | ✅ Ja | `copy:truehd` |
| `eac3` | ✅ Ja | `copy:eac3` |
| `dts` | ❌ Nein | `ffaac` (transcode) |
| `dtshd` | ❌ Nein | `ffaac` (transcode) |

!!! info "DTS-Transcoding"
    HandBrake unterstützt kein DTS-Passthrough in den Standard-Builds. DTS-Tracks werden zu AAC transcodiert, es sei denn, du verwendest einen speziellen HandBrake-Build mit DTS-Unterstützung.

---

## HandBrake-CLI-Argumente

Aus dem Encode-Plan generiert `commandLine.js` die HandBrake-Argumente:

```bash
HandBrakeCLI \
  --input "/mnt/raw/Inception_t00.mkv" \
  --output "/mnt/movies/Inception (2010).mkv" \
  --preset "H.265 MKV 1080p30" \
  --audio 1,2 \
  --aencoder copy:truehd,ffaac \
  --subtitle 1 \
  --subtitle-default 1
```

### Zusätzliche Argumente

Über die Einstellung `handbrake_extra_args` können beliebige HandBrake-Argumente ergänzt werden:

```
--crop 0:0:0:0 --loose-anamorphic
```

---

## Dateiname-Template

Die Ausgabedatei wird über das konfigurierte Template benannt:

```
Template: {title} ({year})
Ergebnis: Inception (2010).mkv
```

Verfügbare Platzhalter:

| Platzhalter | Wert |
|------------|------|
| `{title}` | Filmtitel von OMDb |
| `{year}` | Erscheinungsjahr |
| `{imdb_id}` | IMDb-ID (z.B. `tt1375666`) |
| `{type}` | `movie` oder `series` |

Sonderzeichen im Dateinamen werden automatisch sanitisiert (`:`, `/`, `?` etc. werden entfernt oder ersetzt).

---

## Re-Encoding

Abgeschlossene Jobs können mit geänderten Einstellungen neu encodiert werden:

1. Job in der History auswählen
2. "Re-Encode" klicken
3. Neue Track-Auswahl treffen (oder bestehende übernehmen)
4. Encoding startet mit aktuellen Einstellungen

Dies ist nützlich, wenn sich das HandBrake-Preset oder die Track-Auswahl geändert hat, ohne die zeitintensive Ripping-Phase zu wiederholen.
