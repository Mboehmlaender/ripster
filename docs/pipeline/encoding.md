# Encode-Planung & Track-Auswahl

`encodePlan.js` analysiert die HandBrake-Scan-Ausgabe, wählt Audio- und Untertitelspuren anhand von Regeln vor und erstellt einen vollständigen Encode-Plan für die Benutzer-Review.

---

## Ablauf im Pipeline-Kontext

```
RIPPING abgeschlossen (oder Pre-Rip-Scan)
          ↓
HandBrake --scan (alle Titel & Tracks einlesen)
          ↓
buildTrackSelectors()     ← Regeln aus Einstellungen ableiten
          ↓
selectTrackIds()          ← Tracks anhand Regeln vorauswählen
          ↓
resolveAudioEncoderAction() ← Encoder-Aktion pro Track bestimmen
          ↓
buildDiscScanReview()     ← Vollständigen Encode-Plan erstellen
          ↓
READY_TO_ENCODE           ← Benutzer-Review im Frontend
          ↓
applyManualTrackSelectionToPlan() ← Benutzer-Auswahl anwenden
          ↓
ENCODING                  ← HandBrake-CLI mit finalem Plan starten
```

---

## Phase 1: Pre-Rip Track-Scan

Ripster führt einen **HandBrake-Scan** bereits **vor dem eigentlichen Ripping** durch:

```bash
HandBrakeCLI --scan -i /dev/sr0 -t 0
```

Dieser Scan liest alle Titel und deren Tracks aus der Disc (ohne zu encodieren). So kann der Benutzer die Track-Auswahl bereits vor dem zeitintensiven Rip-Prozess bestätigen.

!!! info "Pre-Rip vs. Post-Rip"
    Ob der Scan vor oder nach dem Ripping passiert, hängt vom konfigurierten Modus ab. Bei direktem Disc-Zugriff ist Pre-Rip möglich; nach einem MakeMKV-Backup wird die entstandene `.mkv`-Datei gescannt.

---

## Phase 2: Track-Selektor-Regeln (`buildTrackSelectors`)

Die Regeln werden aus den HandBrake-Einstellungen abgeleitet. Es gibt fünf **Selektionsmodi**:

| Modus | Beschreibung |
|------|-------------|
| `none` | Keine Tracks dieser Art übernehmen |
| `first` | Nur den ersten Track übernehmen |
| `all` | Alle Tracks übernehmen |
| `language` | Nur Tracks in bestimmten Sprachen |
| `explicit` | Bestimmte Track-IDs explizit angeben |

Der aktive Modus wird aus den `handbrake_*`-Einstellungen und `handbrake_extra_args` abgeleitet. Explizite CLI-Argumente (`--audio`, `--audio-lang-list`) überschreiben die Basis-Konfiguration.

---

## Phase 3: Automatische Vorauswahl (`selectTrackIds`)

### Audio-Tracks

```
Modus 'none'      → Keine Audio-Tracks
Modus 'all'       → Alle Tracks (oder nur erster, wenn firstOnly)
Modus 'language'  → Alle Tracks in den konfigurierten Sprachen
Modus 'explicit'  → Nur die angegebenen Track-IDs
Modus 'first'     → Nur Track 1
```

Jeder Audio-Track erhält das Feld `selectedByRule: true/false` – dieses zeigt dem Benutzer, welche Tracks automatisch vorausgewählt wurden.

**Sprach-Normalisierung (`normalizeLanguage`):**

Alle Sprachcodes werden auf **ISO 639-2** (3-Buchstaben) normalisiert:

| Eingabe | Normalisiert |
|--------|-------------|
| `de`, `ger` | `deu` |
| `German` | `deu` |
| `en`, `eng` | `eng` |
| `English` | `eng` |
| `fr`, `fre` | `fra` |
| `ja`, `jpn` | `jpn` |
| Unbekannt | `und` |

### Untertitel-Tracks

Gleiche Modus-Logik wie Audio, aber mit **zusätzlichen Flags** pro Track:

| Flag | Bedeutung |
|------|-----------|
| `burnIn` | Untertitel in Video einbrennen (`--subtitle-burned`) |
| `forced` | Nur erzwungene Untertitel übernehmen (`--subtitle-forced`) |
| `defaultTrack` | Als Standard-Untertitelspur markieren (`--subtitle-default`) |

Diese Flags werden im Encode-Review als Checkboxen angezeigt.

---

## Phase 4: Encoder-Aktion bestimmen (`resolveAudioEncoderAction`)

Für jeden vorausgewählten Audio-Track bestimmt Ripster die Encoder-Aktion:

```
Encoder-Einstellung      Codec-Support in Copy-Mask?    Aktion
─────────────────────────────────────────────────────────────────────
Kein Encoder / 'preset-default'   →  preset-default     HandBrake-Preset entscheidet
encoder.startsWith('copy')
  UND Codec in audioCopyMask      →  copy               Direktkopie (verlustfrei)
  UND Codec NICHT in audioCopyMask→  fallback            Transcode mit Fallback-Encoder
sonstiger Encoder                 →  transcode           Transcode mit explizitem Encoder
```

**Encoder-Aktionstypen:**

| Typ | Label (UI) | Qualität |
|----|-----------|---------|
| `preset-default` | `Preset-Default (HandBrake)` | HandBrake entscheidet |
| `copy` | `Copy (ac3)` | Verlustfrei |
| `fallback` | `Fallback Transcode (av_aac)` | Mit Qualitätsverlust |
| `transcode` | `Transcode (av_aac)` | Mit Qualitätsverlust |

**Copy-kompatible Codecs (Standard Copy-Mask):**

| Codec | Encoder-String |
|-------|---------------|
| AC-3 | `copy:ac3` |
| E-AC-3 | `copy:eac3` |
| AAC | `copy:aac` |
| MP3 | `copy:mp3` |
| TrueHD | `copy:truehd` |
| DTS | `copy:dts` *(nur mit spez. HandBrake-Build)* |
| DTS-HD | `copy:dtshd` *(nur mit spez. HandBrake-Build)* |

!!! warning "DTS im Standard-HandBrake"
    Standard-HandBrake-Builds unterstützen kein DTS-Passthrough. DTS-Tracks werden dann automatisch auf den Fallback-Encoder umgestellt (Standard: `av_aac`).

---

## Phase 5: Encode-Plan-Struktur

Der vollständige Plan wird im Job-Datensatz als `encode_plan_json` gespeichert:

```json
{
  "mode": "pre_rip",
  "preRip": true,
  "encodeInputTitleId": 1,
  "encodeInputPath": "disc-track-scan://title-1",
  "selectors": {
    "audio": { "mode": "language", "languages": ["deu", "eng"], "copyMask": ["copy:ac3", "copy:eac3"] },
    "subtitle": { "mode": "none" }
  },
  "titles": [
    {
      "id": 1,
      "fileName": "Disc Title 1",
      "durationSeconds": 8885,
      "selectedByMinLength": true,
      "isEncodeInput": true,
      "audioTracks": [
        {
          "id": 1,
          "sourceTrackId": 1,
          "language": "eng",
          "languageLabel": "English",
          "title": "5.1 Surround",
          "format": "AC3",
          "codecToken": "ac3",
          "channels": "6",
          "selectedByRule": true,
          "selectedForEncode": true,
          "encodePreviewActions": [
            { "type": "copy", "encoder": "copy:ac3", "label": "Copy (ac3)" }
          ],
          "encodePreviewSummary": "Copy (ac3)"
        },
        {
          "id": 2,
          "sourceTrackId": 2,
          "language": "deu",
          "languageLabel": "Deutsch",
          "format": "DTS",
          "codecToken": "dts",
          "channels": "6",
          "selectedByRule": true,
          "selectedForEncode": true,
          "encodePreviewActions": [
            { "type": "fallback", "encoder": "av_aac", "label": "Fallback Transcode (av_aac)" }
          ],
          "encodePreviewSummary": "Fallback Transcode (av_aac)"
        },
        {
          "id": 3,
          "language": "fra",
          "languageLabel": "Français",
          "selectedByRule": false,
          "selectedForEncode": false,
          "encodePreviewSummary": "Nicht übernommen"
        }
      ],
      "subtitleTracks": [
        {
          "id": 1,
          "language": "deu",
          "selectedByRule": true,
          "selectedForEncode": true,
          "burnIn": false,
          "forced": false,
          "defaultTrack": true,
          "subtitlePreviewSummary": "Übernehmen",
          "subtitlePreviewFlags": ["default"]
        }
      ]
    }
  ]
}
```

---

## Phase 6: Benutzer-Review im Frontend (`MediaInfoReviewPanel`)

Das Review-Panel zeigt:

```
┌─────────────────────────────────────────────────────────────────┐
│ Encode-Review                            Titel: Disc Title 1    │
│                                          Laufzeit: 2:28:05      │
├─────────────────────────────────────────────────────────────────┤
│ Audio-Spuren                                                    │
├──────┬──────────────────────────┬──────────────────────────────┤
│ [✓]  │ Track 1: English (AC3)   │ Copy (ac3)                   │
│ [✓]  │ Track 2: Deutsch (DTS)   │ Fallback Transcode (av_aac)  │
│ [ ]  │ Track 3: Français (DTS)  │ Nicht übernommen             │
├──────┴──────────────────────────┴──────────────────────────────┤
│ Untertitel-Spuren                                               │
├──────┬──────────────────────────┬────────┬────────┬────────────┤
│ [✓]  │ Track 1: Deutsch         │Einbr.[ ]│Forced[ ]│Default[✓]│
│ [ ]  │ Track 2: English         │Einbr.[ ]│Forced[ ]│Default[ ]│
├──────┴──────────────────────────┴────────┴────────┴────────────┤
│                               [Encoding starten]               │
└─────────────────────────────────────────────────────────────────┘
```

Der Benutzer kann:
- **Audio-Tracks** per Checkbox aktivieren/deaktivieren
- **Untertitel-Flags** (Einbrennen, Forced, Default) setzen
- **Mehrere Titel** bei der Titleauswahl wechseln (für Discs mit mehreren Haupttiteln)

---

## Phase 7: Benutzer-Auswahl anwenden (`applyManualTrackSelectionToPlan`)

Im Frontend wird die Benutzer-Auswahl beim Klick auf **"Encoding starten"** (ggf. automatisch) bestätigt und dann auf den Plan angewendet:

```json
Payload: {
  "selectedEncodeTitleId": 1,
  "selectedTrackSelection": {
    "1": {
      "audioTrackIds": [1, 2],
      "subtitleTrackIds": [1]
    }
  }
}
```

Jeder Track erhält `selectedForEncode: true/false` entsprechend der Auswahl. Die Encoder-Aktionen (`encodeActions`) der nicht gewählten Tracks werden geleert.

---

## Phase 8: HandBrake-CLI-Befehl

Aus dem finalisierten Plan baut Ripster den HandBrake-Aufruf:

```bash
HandBrakeCLI \
  -i /dev/sr0 \
  -o "/mnt/movies/Inception (2010).mkv" \
  -t 1 \
  --preset "H.265 MKV 1080p30" \
  -a 1,2 \
  -E copy:ac3,av_aac \
  -s 1 \
  --subtitle-default 1
```

| Argument | Quelle |
|---------|--------|
| `-i` | `encode_input_path` aus Job |
| `-o` | Ausgabepfad aus `filename_template` + `movie_dir` |
| `-t` | Gewählter Titel-Index |
| `-a` | Kommagetrennte Audio-Track-IDs der ausgewählten Tracks |
| `-E` | Kommagetrennte Encoder-Aktionen (eine pro Track, gleiche Reihenfolge wie `-a`) |
| `-s` | Kommagetrennte Untertitel-Track-IDs |
| `--subtitle-default` | Track-ID der als Default markierten Untertitelspur |
| `--preset` | `handbrake_preset`-Einstellung |
| Extras | `handbrake_extra_args`-Einstellung |

---

## Dateiname-Template

| Platzhalter | Wert | Beispiel |
|------------|------|---------|
| `{title}` | Filmtitel von OMDb | `Inception` |
| `{year}` | Erscheinungsjahr | `2010` |
| `{imdb_id}` | IMDb-ID | `tt1375666` |
| `{type}` | `movie` oder `series` | `movie` |

Sonderzeichen (`:`, `/`, `?`, `*` etc.) werden automatisch aus dem Dateinamen entfernt.

---

## Re-Encoding

Ein abgeschlossener Job kann ohne erneutes Ripping neu encodiert werden:

1. Job in der **History** öffnen
2. **"Re-Encode"** klicken
3. Track-Auswahl anpassen (oder bestehende übernehmen)
4. Encoding startet mit den aktuellen `handbrake_*`-Einstellungen

Nützlich bei geänderten Presets, anderen Sprach-Präferenzen oder nach einem Einstellungs-Update.
