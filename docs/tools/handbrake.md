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

## Relevante Settings

| Key | Bedeutung |
|-----|-----------|
| `handbrake_command` | CLI-Binary |
| `handbrake_preset_bluray` / `handbrake_preset_dvd` | profilspezifisches Preset |
| `handbrake_extra_args_bluray` / `handbrake_extra_args_dvd` | profilspezifische Zusatzargumente |
| `output_extension_bluray` / `output_extension_dvd` | Ausgabeformat |
| `handbrake_restart_delete_incomplete_output` | unvollständige Ausgabe bei Neustart löschen |

---

## Fortschritts-Parsing

Ripster parst HandBrake-Stderr (Prozent/ETA/Detail) und sendet WebSocket-Progress (`PIPELINE_PROGRESS`).

---

## Troubleshooting

- Preset nicht gefunden: Preset-Namen mit `HandBrakeCLI -z` prüfen
- sehr langsames Encoding: Preset/Extra-Args prüfen (z. B. `--encoder-preset`)

Das Produktions-Installer-Script `install.sh` bietet eine Option zur Installation eines gebündelten HandBrakeCLI-Binaries mit NVDEC-Unterstützung (NVIDIA GPU-Dekodierung). Diese Option erscheint interaktiv während der Installation.
