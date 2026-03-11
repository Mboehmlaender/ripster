# HandBrake

Ripster verwendet `HandBrakeCLI` für Scan und Encode.

---

## Verwendete Aufrufe

### Scan (Review-Aufbau)

```bash
HandBrakeCLI --scan --json -i <input> -t 0
```

### Encode (vereinfacht)

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

Optional ergänzt Ripster:

- `--subtitle-burned=<id>`
- `--subtitle-default=<id>`
- `--subtitle-forced=<id>` oder `--subtitle-forced`

---

## Presets auslesen

Ripster liest Presets mit:

```bash
HandBrakeCLI -z
```

---

## Relevante Felder in `Settings`

| Feldname in der GUI | Bedeutung |
|-----|-----------|
| `HandBrake Kommando` | CLI-Binary |
| `HandBrake Preset` (Blu-ray/DVD) | profilspezifisches Preset |
| `HandBrake Extra Args` (Blu-ray/DVD) | profilspezifische Zusatzargumente |
| `Ausgabeformat` (Blu-ray/DVD) | Dateiendung der finalen Datei |
| `Encode-Neustart: unvollständige Ausgabe löschen` | unvollständige Ausgabe bei Neustart löschen |

---

## Fortschritts-Parsing

Ripster parst HandBrake-Stderr (Prozent/ETA/Detail) und sendet WebSocket-Progress (`PIPELINE_PROGRESS`).

---

## Troubleshooting

- Preset nicht gefunden: Preset-Namen mit `HandBrakeCLI -z` prüfen
- sehr langsames Encoding: Preset/Extra-Args prüfen (z. B. `--encoder-preset`)

Das Produktions-Installer-Script `install.sh` bietet eine Option zur Installation eines gebündelten HandBrakeCLI-Binaries mit NVDEC-Unterstützung (NVIDIA GPU-Dekodierung). Diese Option erscheint interaktiv während der Installation.
