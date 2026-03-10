# MediaInfo

Ripster nutzt `mediainfo` zur JSON-Analyse von Medien-Dateien.

---

## Aufruf

```bash
mediainfo --Output=JSON <input>
```

Der Input ist typischerweise eine RAW-Datei oder ein vom Workflow gewählter Inputpfad.

---

## Verwendung in Ripster

- Track-/Codec-Metadaten für Review-Plan
- Fallback-Informationen in bestimmten Analysepfaden
- Persistenz als `mediainfoInfo` im Job

---

## Relevante Settings

| Key | Bedeutung |
|-----|-----------|
| `mediainfo_command` | CLI-Binary |
| `mediainfo_extra_args_bluray` / `_dvd` | profilspezifische Zusatzargumente |

---

## Troubleshooting

- JSON-Test: `mediainfo --Output=JSON <datei>`
- unbekannte Sprache erscheint oft als `und` (undetermined)
