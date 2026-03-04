# MakeMKV

MakeMKV analysiert und rippt DVDs und Blu-rays. Ripster nutzt `makemkvcon` (die CLI-Version).

---

## Verwendete Befehle

### Disc-Analyse

```bash
makemkvcon -r --cache=1 info disc:0
```

Gibt alle Titel und Playlists der eingelegten Disc aus. Ripster parst diese Ausgabe um die verfügbaren Tracks und Playlists zu bestimmen.

**Parameter:**
- `-r` – Maschinen-lesbares Ausgabeformat
- `--cache=1` – Minimaler Disc-Cache
- `info disc:0` – Informationsabfrage für erstes Laufwerk

### MKV-Modus (Standard)

```bash
makemkvcon mkv disc:0 all /path/to/raw/ \
  --minlength=900 \
  -r
```

Erstellt MKV-Dateien aus allen Titeln, die länger als 15 Minuten sind.

**Parameter:**
- `mkv` – MKV-Ausgabemodus
- `disc:0` – Erstes Disc-Laufwerk
- `all` – Alle passenden Titel (nicht nur einen bestimmten)
- `--minlength=900` – Mindestlänge in Sekunden (entspricht 15 Minuten)

### Backup-Modus

```bash
makemkvcon backup disc:0 /path/to/raw/backup/ \
  --decrypt \
  -r
```

Erstellt ein vollständiges Disc-Backup mit Menüs.

**Parameter:**
- `backup` – Backup-Modus
- `--decrypt` – Verschlüsselung entfernen

---

## Ausgabeformat

MakeMKV gibt Fortschritt und Status in einem strukturierten Format aus:

```
PRGV:current,total,max     → Fortschrittsbalken-Werte
PRGT:code,id,"Beschreibung" → Aktueller Task
PRGC:code,id,"Beschreibung" → Aktueller Sub-Task
MSG:code,flags,count,"Text" → Nachricht
```

Ripster's `progressParsers.js` parst diese Ausgabe für die Live-Fortschrittsanzeige.

---

## MakeMKV-Lizenz

MakeMKV ist **Beta-Software** und kostenlos für den persönlichen Gebrauch während der Beta-Phase. Eine Beta-Lizenz ist regelmäßig im [MakeMKV-Forum](https://www.makemkv.com/forum/viewtopic.php?t=1053) verfügbar.

Ohne gültige Lizenz können Blu-rays nicht entschlüsselt werden.

### Lizenz eintragen

Die Lizenz wird in den MakeMKV-Einstellungen eingetragen (GUI) oder direkt in:

```
~/.MakeMKV/settings.conf
```

```
app_Key = "XXXX-XXXX-XXXX-XXXX-XXXX"
```

---

## Konfiguration in Ripster

| Einstellung | Beschreibung |
|------------|-------------|
| `makemkv_command` | Pfad/Befehl für `makemkvcon` |
| `makemkv_min_length_minutes` | Mindest-Titellänge (Standard: 15 Min) |
| `makemkv_backup_mode` | Backup-Modus statt MKV |

---

## Troubleshooting

### MakeMKV erkennt Disc nicht

```bash
# Laufwerk-Berechtigungen prüfen
ls -la /dev/sr0
sudo chmod a+rw /dev/sr0

# Oder Benutzer zur Gruppe cdrom hinzufügen
sudo usermod -a -G cdrom $USER
```

### Langer Analyseprozess

Blu-ray-Analyse kann bei Discs mit vielen Playlists 5+ Minuten dauern. Dies ist normal.

### Fehlermeldung: "LibMMBD"

LibMMBD ist MakeMKVs interne Verschlüsselungsbibliothek. Bei Fehlern die MakeMKV-Version aktualisieren.
