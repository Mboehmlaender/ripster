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

## LibDriveIO-Modus (Pflicht)

!!! danger "Laufwerk muss im LibDriveIO-Modus betrieben werden"
    MakeMKV greift auf Discs über **LibDriveIO** zu – eine Bibliothek, die direkt auf Rohdaten des Laufwerks zugreift und den Standard-OS-Treiber umgeht. Ohne diesen Modus kann MakeMKV verschlüsselte Blu-rays (insbesondere UHD) **nicht lesen**.

### Was ist LibDriveIO?

LibDriveIO ist MakeMKVs interne Treiberschicht für den direkten Laufwerkszugriff. Sie ermöglicht:

- Lesen von verschlüsselten Blu-ray-Sektoren (AACS, BD+, AACS2)
- Zugriff auf Disc-Strukturen, die über Standard-OS-APIs nicht erreichbar sind
- UHD-Blu-ray-Entschlüsselung ohne externe Bibliotheken

### Voraussetzungen für den LibDriveIO-Modus

Das Laufwerk muss **LibDriveIO-kompatibel** sein und entsprechend betrieben werden:

1. **Kompatibles Laufwerk** – Nicht alle Laufwerke unterstützen den Rohdatenzugriff. UHD-kompatible Laufwerke (z. B. LG, Pioneer bestimmter Firmware-Versionen) sind erforderlich.

2. **Laufwerk-Berechtigungen** – Der Prozess benötigt direkten Zugriff auf das Blockdevice:
   ```bash
   sudo chmod a+rw /dev/sr0
   # oder dauerhaft über udev-Regel
   ```

3. **Kein OS-seitiger Disc-Mount** – Das Laufwerk darf beim Ripping **nicht** durch das OS automatisch gemountet sein (AutoMount deaktivieren):
   ```bash
   # Automount temporär deaktivieren (GNOME)
   gsettings set org.gnome.desktop.media-handling automount false
   ```

### How-To: LibDriveIO einrichten

Die vollständige Anleitung zur Einrichtung und zu kompatiblen Laufwerken findet sich im offiziellen MakeMKV-Forum:

[:octicons-link-external-24: MakeMKV Forum – LibDriveIO How-To](https://www.makemkv.com/forum/viewtopic.php?t=18856){ .md-button }

!!! tip "Prüfen ob LibDriveIO aktiv ist"
    In der MakeMKV-Ausgabe erscheint beim Laufwerkszugriff `LibDriveIO` statt `LibMMMBD`, wenn der direkte Modus aktiv ist.

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
