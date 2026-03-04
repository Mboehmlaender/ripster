# Einstellungsreferenz

Vollständige Übersicht aller Ripster-Einstellungen. Alle Einstellungen werden über die Web-Oberfläche unter **Einstellungen** verwaltet.

---

## Kategorie: Pfade (paths)

| Schlüssel | Typ | Standard | Pflicht | Beschreibung |
|---------|-----|---------|---------|-------------|
| `raw_dir` | string | — | ✅ | Verzeichnis für rohe MKV-Dateien nach dem Ripping |
| `movie_dir` | string | — | ✅ | Ausgabeverzeichnis für encodierte Filme |
| `log_dir` | string | `./logs` | — | Verzeichnis für Log-Dateien |

!!! example "Beispielkonfiguration"
    ```
    raw_dir   = /mnt/nas/raw
    movie_dir = /mnt/nas/movies
    log_dir   = /var/log/ripster
    ```

---

## Kategorie: Tools (tools)

| Schlüssel | Typ | Standard | Beschreibung |
|---------|-----|---------|-------------|
| `makemkv_command` | string | `makemkvcon` | Befehl oder absoluter Pfad zu MakeMKV |
| `handbrake_command` | string | `HandBrakeCLI` | Befehl oder absoluter Pfad zu HandBrake |
| `mediainfo_command` | string | `mediainfo` | Befehl oder absoluter Pfad zu MediaInfo |

!!! tip "Absolute Pfade verwenden"
    Falls die Tools nicht im `PATH` des Systems sind:
    ```
    makemkv_command   = /usr/local/bin/makemkvcon
    handbrake_command = /usr/local/bin/HandBrakeCLI
    mediainfo_command = /usr/bin/mediainfo
    ```

---

## Kategorie: Encoding (encoding)

| Schlüssel | Typ | Standard | Beschreibung |
|---------|-----|---------|-------------|
| `handbrake_preset` | string | `H.265 MKV 1080p30` | Name des HandBrake-Presets |
| `handbrake_extra_args` | string | _(leer)_ | Zusätzliche HandBrake CLI-Argumente |
| `output_extension` | string | `mkv` | Dateiendung der Ausgabedatei |
| `filename_template` | string | `{title} ({year})` | Template für den Dateinamen |

### Verfügbare HandBrake-Presets

Eine vollständige Liste der verfügbaren Presets:

```bash
HandBrakeCLI --preset-list
```

Häufig verwendete Presets:

| Preset | Beschreibung |
|--------|-------------|
| `H.265 MKV 1080p30` | H.265/HEVC, Full-HD, 30fps |
| `H.265 MKV 720p30` | H.265/HEVC, HD, 30fps |
| `H.264 MKV 1080p30` | H.264/AVC, Full-HD, 30fps |
| `HQ 1080p30 Surround` | Hohe Qualität, Full-HD mit Surround |

### Dateiname-Template-Platzhalter

| Platzhalter | Beispiel |
|------------|---------|
| `{title}` | `Inception` |
| `{year}` | `2010` |
| `{imdb_id}` | `tt1375666` |
| `{type}` | `movie` |

---

## Kategorie: Laufwerk (drive)

| Schlüssel | Typ | Standard | Optionen | Beschreibung |
|---------|-----|---------|---------|-------------|
| `drive_mode` | select | `auto` | `auto`, `explicit` | Laufwerk-Erkennungsmodus |
| `drive_device` | string | `/dev/sr0` | — | Geräte-Pfad (nur bei `explicit`) |
| `disc_poll_interval_ms` | number | `5000` | 1000–60000 | Polling-Intervall in Millisekunden |

**`drive_mode` Optionen:**

| Modus | Beschreibung |
|------|-------------|
| `auto` | Ripster erkennt das Laufwerk automatisch |
| `explicit` | Verwendet das in `drive_device` konfigurierte Gerät |

---

## Kategorie: MakeMKV (makemkv)

| Schlüssel | Typ | Standard | Min | Max | Beschreibung |
|---------|-----|---------|-----|-----|-------------|
| `makemkv_min_length_minutes` | number | `15` | `0` | `999` | Mindest-Titellänge in Minuten |
| `makemkv_backup_mode` | boolean | `false` | — | — | Backup-Modus statt MKV-Modus |

**`makemkv_min_length_minutes`:** Titel kürzer als dieser Wert werden von MakeMKV ignoriert. Verhindert das Rippen von Menü-Schleifen und kurzen Extra-Clips.

**`makemkv_backup_mode`:** Im Backup-Modus erstellt MakeMKV eine vollständige Disc-Kopie mit Menüs. Im Standard-Modus werden direkt MKV-Dateien erstellt.

---

## Kategorie: OMDb (omdb)

| Schlüssel | Typ | Standard | Pflicht | Beschreibung |
|---------|-----|---------|---------|-------------|
| `omdb_api_key` | string | — | ✅ | API-Key von [omdbapi.com](https://www.omdbapi.com/) |
| `omdb_default_type` | select | `movie` | — | Standard-Suchtyp: `movie` oder `series` |

---

## Kategorie: Benachrichtigungen (notifications)

| Schlüssel | Typ | Standard | Beschreibung |
|---------|-----|---------|-------------|
| `pushover_user_key` | string | — | PushOver User-Key |
| `pushover_api_token` | string | — | PushOver API-Token |

Beide Felder müssen konfiguriert sein, um PushOver-Benachrichtigungen zu aktivieren. Die Verbindung kann mit dem **Test-Button** in den Einstellungen geprüft werden.

---

## Standard-Einstellungen zurücksetzen

Über die Datenbank können Einstellungen auf Standardwerte zurückgesetzt werden:

```bash
sqlite3 backend/data/ripster.db \
  "DELETE FROM settings_values WHERE key = 'handbrake_preset';"
```

Beim nächsten Laden der Einstellungen wird der Standardwert verwendet.
