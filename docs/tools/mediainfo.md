# MediaInfo

MediaInfo analysiert die Track-Struktur von Mediendateien. Ripster nutzt es nach dem Ripping um Audio- und Untertitelspuren zu identifizieren.

---

## Verwendeter Befehl

```bash
mediainfo --Output=JSON /path/to/raw/film.mkv
```

Gibt vollständige Track-Informationen als JSON zurück.

---

## Ausgabe-Struktur

```json
{
  "media": {
    "track": [
      {
        "@type": "General",
        "Duration": "8885.042",
        "Format": "Matroska"
      },
      {
        "@type": "Video",
        "Format": "HEVC",
        "Width": "1920",
        "Height": "1080",
        "FrameRate": "23.976"
      },
      {
        "@type": "Audio",
        "StreamOrder": "1",
        "Format": "TrueHD",
        "Channels": "8",
        "Language": "en"
      },
      {
        "@type": "Audio",
        "StreamOrder": "2",
        "Format": "AC-3",
        "Channels": "6",
        "Language": "de"
      },
      {
        "@type": "Text",
        "StreamOrder": "1",
        "Format": "UTF-8",
        "Language": "de"
      }
    ]
  }
}
```

---

## Verarbeitung in Ripster

`encodePlan.js` verarbeitet die MediaInfo-Ausgabe:

1. **Track-Extraktion**: Alle Audio- und Untertitel-Tracks werden extrahiert
2. **Sprach-Normalisierung**: Sprachcodes werden auf ISO 639-3 normalisiert
3. **Codec-Klassifizierung**: Bestimmt ob Codec kopiert oder transcodiert werden kann
4. **Track-Labels**: Benutzerfreundliche Bezeichnungen (z.B. "Deutsch (AC-3, 5.1)")

### Track-Label-Format

```
{Sprache} ({Format}, {Kanäle})
```

Beispiele:
- `Deutsch (AC-3, 5.1)`
- `English (TrueHD, 7.1)`
- `Français (AC-3, 2.0)`

---

## Konfiguration in Ripster

| Einstellung | Beschreibung |
|------------|-------------|
| `mediainfo_command` | Pfad/Befehl für `mediainfo` |

---

## Troubleshooting

### MediaInfo gibt kein JSON aus

```bash
# Version prüfen
mediainfo --Version

# JSON-Ausgabe testen
mediainfo --Output=JSON /path/to/test.mkv
```

MediaInfo >= 17.10 wird empfohlen.

### Sprache als "und" angezeigt

`und` steht für "undetermined" – die Sprache ist in der MKV-Datei nicht getaggt. Dies ist bei manchen Rips normal. Der Track wird trotzdem angezeigt und kann manuell ausgewählt werden.
