# MakeMKV

Ripster nutzt `makemkvcon` für Disc-Analyse und Rip.

---

## Verwendete Aufrufe

### Analyse

```bash
makemkvcon -r info <source>
```

`<source>` ist typischerweise:

- `disc:<index>` (Auto-Modus)
- `dev:/dev/sr0` (explicit)
- `file:<path>` (Datei/Ordner-Analyse)

### Rip (MKV-Modus)

```bash
makemkvcon mkv <source> <title-or-all> <rawDir> [--minlength=...] [...extraArgs]
```

### Rip (Backup-Modus)

```bash
makemkvcon backup <source> <rawDir> --decrypt
```

---

## Registrierungsschlüssel (optional)

Wenn `makemkv_registration_key` gesetzt ist, führt Ripster vor Analyse/Rip aus:

```bash
makemkvcon reg <key>
```

---

## Relevante Settings

| Key | Bedeutung |
|-----|-----------|
| `makemkv_command` | CLI-Binary |
| `makemkv_source_index` | Source-Index im Auto-Modus |
| `makemkv_min_length_minutes` | Mindestlaufzeitfilter |
| `makemkv_rip_mode_bluray` / `makemkv_rip_mode_dvd` | `mkv` oder `backup` |
| `makemkv_analyze_extra_args_bluray` / `_dvd` | Zusatzargs Analyse |
| `makemkv_rip_extra_args_bluray` / `_dvd` | Zusatzargs Rip |

---

## Hinweise

- Blu-ray-Backups werden oft für robuste Playlist-Analyse genutzt.
- MakeMKV-Ausgaben werden geparst und als `makemkvInfo` im Job gespeichert.
