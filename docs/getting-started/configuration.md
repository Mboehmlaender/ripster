# Konfiguration

Alle Einstellungen werden über die Web-Oberfläche unter **Einstellungen** verwaltet und in der SQLite-Datenbank gespeichert.

---

## Pflichteinstellungen

Diese Einstellungen müssen vor dem ersten Rip konfiguriert werden:

### Pfade

| Einstellung | Beschreibung | Beispiel |
|------------|-------------|---------|
| `raw_dir` | Verzeichnis für rohe MKV-Dateien | `/mnt/nas/raw` |
| `movie_dir` | Ausgabeverzeichnis für kodierte Filme | `/mnt/nas/movies` |
| `log_dir` | Verzeichnis für Log-Dateien | `/var/log/ripster` |

!!! warning "Berechtigungen"
    Der Ripster-Prozess benötigt **Schreibrechte** auf alle konfigurierten Verzeichnisse.

    ```bash
    # Verzeichnisse erstellen und Berechtigungen setzen
    sudo mkdir -p /mnt/nas/{raw,movies}
    sudo chown $USER:$USER /mnt/nas/{raw,movies}
    ```

### OMDb API

| Einstellung | Beschreibung |
|------------|-------------|
| `omdb_api_key` | API-Key von omdbapi.com |
| `omdb_default_type` | Standard-Suchtyp: `movie` oder `series` |

---

## Tool-Konfiguration

| Einstellung | Standard | Beschreibung |
|------------|---------|-------------|
| `makemkv_command` | `makemkvcon` | Pfad oder Befehl für MakeMKV |
| `handbrake_command` | `HandBrakeCLI` | Pfad oder Befehl für HandBrake |
| `mediainfo_command` | `mediainfo` | Pfad oder Befehl für MediaInfo |

!!! tip "Absolute Pfade"
    Falls die Tools nicht im `PATH` sind, verwende absolute Pfade:
    ```
    /usr/local/bin/HandBrakeCLI
    ```

---

## Encoding-Konfiguration

| Einstellung | Standard | Beschreibung |
|------------|---------|-------------|
| `handbrake_preset` | `H.265 MKV 1080p30` | HandBrake-Preset-Name |
| `handbrake_extra_args` | _(leer)_ | Zusätzliche HandBrake-Argumente |
| `output_extension` | `mkv` | Dateiendung der Ausgabedatei |
| `filename_template` | `{title} ({year})` | Template für Dateinamen |

### Dateiname-Template

Das Template unterstützt folgende Platzhalter:

| Platzhalter | Beschreibung | Beispiel |
|------------|-------------|---------|
| `{title}` | Filmtitel | `Inception` |
| `{year}` | Erscheinungsjahr | `2010` |
| `{imdb_id}` | IMDb-ID | `tt1375666` |
| `{type}` | `movie` oder `series` | `movie` |

**Beispiel-Template:**
```
{title} ({year})
→ Inception (2010).mkv
```

---

## Laufwerk-Konfiguration

| Einstellung | Standard | Beschreibung |
|------------|---------|-------------|
| `drive_mode` | `auto` | `auto` (automatisch erkennen) oder `explicit` (festes Gerät) |
| `drive_device` | `/dev/sr0` | Geräte-Pfad (nur bei `explicit`) |
| `disc_poll_interval_ms` | `5000` | Polling-Intervall in Millisekunden |

---

## MakeMKV-Konfiguration

| Einstellung | Standard | Beschreibung |
|------------|---------|-------------|
| `makemkv_min_length_minutes` | `15` | Mindestlänge für Titel in Minuten |
| `makemkv_backup_mode` | `false` | Backup-Modus statt MKV-Modus |

!!! info "Backup-Modus"
    Im Backup-Modus erstellt MakeMKV eine vollständige Kopie der Disc (inkl. Menüs). Der Standardmodus erstellt direkt MKV-Dateien.

---

## Benachrichtigungen (PushOver)

| Einstellung | Beschreibung |
|------------|-------------|
| `pushover_user_key` | Dein PushOver User-Key |
| `pushover_api_token` | API-Token deiner PushOver-App |

Nach der Eingabe kann die Verbindung mit dem **Test-Button** geprüft werden.

---

## Vollständige Einstellungsreferenz

Eine vollständige Liste aller Einstellungen mit Typen, Validierung und Standardwerten findest du unter:

[:octicons-arrow-right-24: Einstellungsreferenz](../configuration/settings-reference.md)
