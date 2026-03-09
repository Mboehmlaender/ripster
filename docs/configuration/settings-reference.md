# Einstellungsreferenz

Vollständige Übersicht aller Ripster-Einstellungen. Alle Einstellungen werden über die Web-Oberfläche unter **Einstellungen** verwaltet und in SQLite gespeichert.

---

## Profil-System

Ripster erkennt den Medientyp einer eingelegten Disc (Blu-ray / DVD / CD) und wählt automatisch die passenden profil-spezifischen Einstellungen. Für viele Schlüssel gibt es zusätzlich zur globalen Einstellung eine Variante pro Profil:

| Profil | Erkennungsmerkmale |
|--------|--------------------|
| `bluray` | UDF-Dateisystem, Laufwerk-Modell enthält „Blu-ray", Disc-Label wie BDMV |
| `dvd` | ISO9660/UDF, Laufwerk-Modell enthält „DVD", VIDEO_TS-Struktur |
| `other` | Alles andere (CD, unbekannt) |

**Auflösungsreihenfolge für profil-spezifische Einstellungen:**

1. Profil-spezifischer Wert (`_bluray` / `_dvd`) – wenn gesetzt, hat dieser Vorrang
2. Alternativ-Profil als Fallback (Blu-ray → DVD-Wert als Fallback und umgekehrt)

Pfad-Einstellungen (`raw_dir`, `movie_dir`) und Besitz-Einstellungen (`raw_dir_owner`, `movie_dir_owner`) werden **ausschließlich** aus dem passenden Profil bezogen – kein Cross-Profil-Fallback.

---

## Kategorie: Pfade

| Schlüssel | Typ | Pflicht | Beschreibung |
|-----------|-----|---------|-------------|
| `raw_dir` | string | ✅ | Verzeichnis für rohe MKV-Dateien (Fallback wenn kein Profil-Wert) |
| `raw_dir_bluray` | string | — | Raw-Verzeichnis für Blu-rays |
| `raw_dir_dvd` | string | — | Raw-Verzeichnis für DVDs |
| `raw_dir_other` | string | — | Raw-Verzeichnis für sonstige Medien |
| `raw_dir_owner` | string | — | Besitzer für Raw-Verzeichnis (`user:group`, Fallback) |
| `raw_dir_bluray_owner` | string | — | Besitzer für Raw-Verzeichnis (Blu-ray) |
| `raw_dir_dvd_owner` | string | — | Besitzer für Raw-Verzeichnis (DVD) |
| `raw_dir_other_owner` | string | — | Besitzer für Raw-Verzeichnis (Sonstiges) |
| `movie_dir` | string | ✅ | Ausgabeverzeichnis für Filme (Fallback) |
| `movie_dir_bluray` | string | — | Ausgabeverzeichnis für Blu-rays |
| `movie_dir_dvd` | string | — | Ausgabeverzeichnis für DVDs |
| `movie_dir_other` | string | — | Ausgabeverzeichnis für sonstige Medien |
| `movie_dir_owner` | string | — | Besitzer für Ausgabeverzeichnis (Fallback) |
| `movie_dir_bluray_owner` | string | — | Besitzer für Ausgabeverzeichnis (Blu-ray) |
| `movie_dir_dvd_owner` | string | — | Besitzer für Ausgabeverzeichnis (DVD) |
| `movie_dir_other_owner` | string | — | Besitzer für Ausgabeverzeichnis (Sonstiges) |
| `log_dir` | string | — | Verzeichnis für Log-Dateien (Standard: `./logs`) |

---

## Kategorie: Laufwerk

| Schlüssel | Typ | Standard | Beschreibung |
|-----------|-----|---------|-------------|
| `drive_mode` | select | `auto` | `auto` = automatisch erkennen, `explicit` = festes Gerät |
| `drive_device` | string | `/dev/sr0` | Geräte-Pfad (nur bei `explicit`) |
| `disc_poll_interval_ms` | number | `4000` | Polling-Intervall in Millisekunden (1000–60000) |
| `makemkv_source_index` | number | `0` | Laufwerk-Index für MakeMKV (bei mehreren Laufwerken) |

---

## Kategorie: Tools (global)

| Schlüssel | Typ | Standard | Beschreibung |
|-----------|-----|---------|-------------|
| `makemkv_command` | string | `makemkvcon` | Befehl oder absoluter Pfad zu MakeMKV |
| `handbrake_command` | string | `HandBrakeCLI` | Befehl oder absoluter Pfad zu HandBrake |
| `mediainfo_command` | string | `mediainfo` | Befehl oder absoluter Pfad zu MediaInfo |
| `makemkv_min_length_minutes` | number | `15` | Mindest-Titellänge in Minuten (0–999) |
| `pipeline_max_parallel_jobs` | number | `1` | Maximale Anzahl parallel laufender Jobs (1–12) |
| `handbrake_restart_delete_incomplete_output` | boolean | `true` | Unvollständige Ausgabedatei beim Encode-Neustart löschen |

### Kategorie: Tools – Blu-ray

| Schlüssel | Typ | Standard | Beschreibung |
|-----------|-----|---------|-------------|
| `makemkv_rip_mode_bluray` | select | `backup` | Rip-Modus: `mkv` oder `backup` |
| `makemkv_analyze_extra_args_bluray` | string | — | Zusatz-CLI-Parameter für Analyse (Blu-ray) |
| `makemkv_rip_extra_args_bluray` | string | — | Zusatz-CLI-Parameter für Rip (Blu-ray) |
| `mediainfo_extra_args_bluray` | string | — | Zusatz-CLI-Parameter für mediainfo (Blu-ray) |
| `handbrake_preset_bluray` | string | `H.264 MKV 1080p30` | HandBrake-Preset für Blu-rays |
| `handbrake_extra_args_bluray` | string | — | Zusatz-CLI-Argumente für HandBrake (Blu-ray) |
| `output_extension_bluray` | select | `mkv` | Ausgabeformat: `mkv` oder `mp4` |
| `filename_template_bluray` | string | `${title} (${year})` | Dateiname-Template (Blu-ray) |
| `output_folder_template_bluray` | string | — | Ordnername-Template (Blu-ray, leer = Dateiname-Template) |

### Kategorie: Tools – DVD

| Schlüssel | Typ | Standard | Beschreibung |
|-----------|-----|---------|-------------|
| `makemkv_rip_mode_dvd` | select | `mkv` | Rip-Modus: `mkv` oder `backup` |
| `makemkv_analyze_extra_args_dvd` | string | — | Zusatz-CLI-Parameter für Analyse (DVD) |
| `makemkv_rip_extra_args_dvd` | string | — | Zusatz-CLI-Parameter für Rip (DVD) |
| `mediainfo_extra_args_dvd` | string | — | Zusatz-CLI-Parameter für mediainfo (DVD) |
| `handbrake_preset_dvd` | string | `H.264 MKV 480p30` | HandBrake-Preset für DVDs |
| `handbrake_extra_args_dvd` | string | — | Zusatz-CLI-Argumente für HandBrake (DVD) |
| `output_extension_dvd` | select | `mkv` | Ausgabeformat: `mkv` oder `mp4` |
| `filename_template_dvd` | string | `${title} (${year})` | Dateiname-Template (DVD) |
| `output_folder_template_dvd` | string | — | Ordnername-Template (DVD, leer = Dateiname-Template) |

### Globale Fallback-Einstellungen für Encode

Diese Werte werden verwendet, wenn kein profil-spezifischer Wert konfiguriert ist:

| Schlüssel | Typ | Standard | Beschreibung |
|-----------|-----|---------|-------------|
| `handbrake_preset` | string | `H.265 MKV 1080p30` | Fallback HandBrake-Preset |
| `handbrake_extra_args` | string | — | Fallback Extra-Args |
| `makemkv_rip_mode` | select | `mkv` | Fallback Rip-Modus |
| `makemkv_analyze_extra_args` | string | — | Fallback Analyse-Args |
| `makemkv_rip_extra_args` | string | — | Fallback Rip-Args |
| `mediainfo_extra_args` | string | — | Fallback MediaInfo-Args |
| `output_extension` | select | `mkv` | Fallback Ausgabeformat |
| `filename_template` | string | `${title} (${year})` | Fallback Dateiname-Template |
| `output_folder_template` | string | — | Fallback Ordnername-Template |

### Template-Platzhalter

| Platzhalter | Beispiel |
|------------|---------|
| `${title}` | `Inception` |
| `${year}` | `2010` |
| `${imdbId}` | `tt1375666` |

---

## Kategorie: Metadaten

| Schlüssel | Typ | Standard | Beschreibung |
|-----------|-----|---------|-------------|
| `omdb_api_key` | string | — | API-Key von [omdbapi.com](https://www.omdbapi.com/) |
| `omdb_default_type` | select | `movie` | Vorauswahl für OMDb-Suche: `movie`, `series`, `episode` |

---

## Kategorie: Benachrichtigungen (PushOver)

| Schlüssel | Typ | Standard | Beschreibung |
|-----------|-----|---------|-------------|
| `pushover_enabled` | boolean | `false` | Master-Schalter für PushOver |
| `pushover_token` | string | — | Application-Token |
| `pushover_user` | string | — | User-Key |
| `pushover_device` | string | — | Optionales Ziel-Device |
| `pushover_title_prefix` | string | `Ripster` | Präfix im Benachrichtigungstitel |
| `pushover_priority` | number | `0` | Priorität (-2 bis 2) |
| `pushover_timeout_ms` | number | `7000` | HTTP-Timeout für PushOver-Requests (ms) |

### Granulare Event-Schalter

| Schlüssel | Standard | Beschreibung |
|-----------|---------|-------------|
| `pushover_notify_metadata_ready` | `true` | Bei Metadaten-Auswahl benachrichtigen |
| `pushover_notify_rip_started` | `true` | Bei MakeMKV-Rip-Start |
| `pushover_notify_encoding_started` | `true` | Bei HandBrake-Start |
| `pushover_notify_job_finished` | `true` | Bei erfolgreichem Abschluss |
| `pushover_notify_job_error` | `true` | Bei Fehler |
| `pushover_notify_job_cancelled` | `true` | Bei manuellem Abbruch |
| `pushover_notify_reencode_started` | `true` | Bei Re-Encode-Start |
| `pushover_notify_reencode_finished` | `true` | Bei erfolgreichem Re-Encode |

---

## Kategorie: Monitoring

| Schlüssel | Typ | Standard | Beschreibung |
|-----------|-----|---------|-------------|
| `hardware_monitoring_enabled` | boolean | `false` | Hardware-Monitoring aktivieren (CPU, RAM, Temp.) |
| `hardware_monitoring_interval_ms` | number | `5000` | Monitoring-Polling-Intervall (ms) |

---

## Standard-Einstellungen zurücksetzen

Einen einzelnen Wert über die Datenbank zurücksetzen:

```bash
sqlite3 backend/data/ripster.db \
  "DELETE FROM settings_values WHERE key = 'handbrake_preset_bluray';"
```

Beim nächsten Laden wird der Standardwert aus `settings_schema.default_value` verwendet.
