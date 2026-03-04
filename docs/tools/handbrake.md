# HandBrake

HandBrake encodiert die rohen MKV-Dateien in das gewünschte Format. Ripster nutzt `HandBrakeCLI`.

---

## Verwendeter Befehl

```bash
HandBrakeCLI \
  --input "/mnt/raw/Film_t00.mkv" \
  --output "/mnt/movies/Film (2010).mkv" \
  --preset "H.265 MKV 1080p30" \
  --audio 1,2 \
  --aencoder copy:ac3,ffaac \
  --subtitle 1 \
  --subtitle-default 1
```

---

## Presets

HandBrake verwendet **Presets** für vorkonfigurierte Encoding-Einstellungen.

### Empfohlene Presets

| Preset | Codec | Auflösung | Für |
|--------|-------|----------|-----|
| `H.265 MKV 1080p30` | HEVC/H.265 | 1080p | Beste Qualität/Größe |
| `H.265 MKV 720p30` | HEVC/H.265 | 720p | Kleinere Dateien |
| `H.264 MKV 1080p30` | AVC/H.264 | 1080p | Breiteste Kompatibilität |
| `HQ 1080p30 Surround` | HEVC/H.265 | 1080p | Hohe Qualität mit Surround |

### Alle Presets anzeigen

```bash
HandBrakeCLI --preset-list
```

---

## Audio-Encoding

### Copy-kompatible Codecs

HandBrake kann folgende Codecs direkt kopieren (kein Qualitätsverlust):

| Codec | `--aencoder` Wert |
|-------|-----------------|
| AC-3 | `copy:ac3` |
| AAC | `copy:aac` |
| MP3 | `copy:mp3` |
| TrueHD | `copy:truehd` |
| E-AC-3 | `copy:eac3` |

### Transcoding

Codecs die nicht kopiert werden können, werden zu AAC transcodiert:

| Original | Transcodiert zu |
|---------|----------------|
| DTS | AAC (`ffaac`) |
| DTS-HD | AAC (`ffaac`) |

---

## Extra-Argumente

Über die Einstellung `handbrake_extra_args` können beliebige HandBrake-Argumente hinzugefügt werden:

```
# Cropping deaktivieren
--crop 0:0:0:0

# Loose Anamorphic
--loose-anamorphic

# Bestimmte Qualität setzen
--quality 20
```

---

## Fortschritts-Parsing

Ripster parst die HandBrake-Ausgabe auf stderr für die Fortschrittsanzeige:

```
Encoding: task 1 of 1, 73.50 % (45.23 fps, avg 44.12 fps, ETA 00h12m34s)
```

`progressParsers.js` extrahiert:
- Prozentzahl
- Aktuelle FPS
- ETA

---

## Konfiguration in Ripster

| Einstellung | Beschreibung |
|------------|-------------|
| `handbrake_command` | Pfad/Befehl für `HandBrakeCLI` |
| `handbrake_preset` | Preset-Name |
| `handbrake_extra_args` | Zusätzliche CLI-Argumente |
| `output_extension` | Dateiendung der Ausgabe |

---

## Troubleshooting

### HandBrake findet Preset nicht

```bash
# Preset-Liste anzeigen
HandBrakeCLI --preset-list 2>&1 | grep -i "h.265"
```

Preset-Namen sind case-sensitive!

### Encoding sehr langsam

```bash
# CPU-Encoding-Preset anpassen (schneller = schlechtere Qualität)
handbrake_extra_args = --encoder-preset fast
```

Verfügbare Presets: `ultrafast`, `superfast`, `veryfast`, `faster`, `fast`, `medium`, `slow`, `slower`, `veryslow`

### GPU-Encoding nutzen (NVIDIA)

```
handbrake_preset = H.265 NVENC 1080p
```

Erfordert HandBrake-Build mit NVENC-Unterstützung und NVIDIA-GPU.
