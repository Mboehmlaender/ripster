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

MakeMKV unterliegt eigenen Lizenz- und Registrierungsbedingungen. Ripster
lizenziert MakeMKV nicht um und darf diese Bedingungen nicht automatisch für den
Benutzer akzeptieren.

Wenn in `Settings` ein `MakeMKV Key` gesetzt ist, synchronisiert Ripster ihn nach:

```bash
~/.MakeMKV/settings.conf
```

Format:

```ini
app_Key = "product-key"
```

Zusätzlich zeigt die UI unterhalb des Feldes den aktuellen Betakey an, der per Button in das Eingabefeld übernommen werden kann.

---

## Relevante Felder in `Settings`

| Feldname in der GUI | Bedeutung |
|-----|-----------|
| `MakeMKV Kommando` | CLI-Binary |
| `MakeMKV Source Index` | Source-Index im Auto-Modus |
| `Minimale Titellaenge (Minuten)` | Mindestlaufzeitfilter |
| `MakeMKV Rip Modus` (Blu-ray/DVD) | `mkv` oder `backup` |
| `MakeMKV Analyze Extra Args` (Blu-ray/DVD) | Zusatzargumente für Analyse |
| `MakeMKV Rip Extra Args` (Blu-ray/DVD) | Zusatzargumente für Rip |

---

## Hinweise

- Blu-ray-Backups werden oft für robuste Playlist-Analyse genutzt.
- MakeMKV-Ausgaben werden geparst und als `makemkvInfo` im Job gespeichert.
