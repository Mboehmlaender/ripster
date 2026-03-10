# Konfiguration

Die Hauptkonfiguration erfolgt über die UI (`Settings`) und wird in SQLite gespeichert.

---

## Pflichteinstellungen vor dem ersten Rip

### 1) Pfade

| Einstellung | Beschreibung | Beispiel |
|------------|-------------|---------|
| `raw_dir` | Basisverzeichnis für RAW-Rips | `/mnt/ripster/raw` |
| `movie_dir` | Basisverzeichnis für finale Encodes | `/mnt/ripster/movies` |
| `log_dir` | Verzeichnis für Prozess-/Backend-Logs | `/mnt/ripster/logs` |

Optional profilspezifisch:

- `raw_dir_bluray`, `raw_dir_dvd`, `raw_dir_other`
- `movie_dir_bluray`, `movie_dir_dvd`, `movie_dir_other`

### 2) Tools

| Einstellung | Standard |
|------------|---------|
| `makemkv_command` | `makemkvcon` |
| `handbrake_command` | `HandBrakeCLI` |
| `mediainfo_command` | `mediainfo` |

### 3) OMDb

| Einstellung | Beschreibung |
|------------|-------------|
| `omdb_api_key` | API-Key von omdbapi.com |
| `omdb_default_type` | `movie`, `series`, `episode` |

---

## Encode-Konfiguration (wichtig)

Ripster arbeitet profilspezifisch, typischerweise über:

- Blu-ray: `handbrake_preset_bluray`, `handbrake_extra_args_bluray`, `output_extension_bluray`, `filename_template_bluray`
- DVD: `handbrake_preset_dvd`, `handbrake_extra_args_dvd`, `output_extension_dvd`, `filename_template_dvd`

### Template-Platzhalter

Verfügbar in `filename_template_*` und `output_folder_template_*`:

- `${title}`
- `${year}`
- `${imdbId}`

Beispiel:

```text
${title} (${year})
-> Inception (2010).mkv
```

---

## MakeMKV-spezifisch

| Einstellung | Standard | Hinweis |
|------------|---------|--------|
| `makemkv_min_length_minutes` | `60` | Kandidaten-Filter |
| `makemkv_rip_mode_bluray` | `backup` | `mkv` oder `backup` |
| `makemkv_rip_mode_dvd` | `mkv` | `mkv` oder `backup` |
| `makemkv_registration_key` | leer | optional, wird via `makemkvcon reg` gesetzt |

---

## Monitoring & Queue

| Einstellung | Standard |
|------------|---------|
| `hardware_monitoring_enabled` | `true` |
| `hardware_monitoring_interval_ms` | `5000` |
| `pipeline_max_parallel_jobs` | `1` |

---

## PushOver (optional)

Basis:

- `pushover_enabled`
- `pushover_token`
- `pushover_user`

Zusätzlich pro Event ein/aus (z. B. `pushover_notify_job_finished`).

---

## Verwandte Doku

- [Einstellungsreferenz](../configuration/settings-reference.md)
- [Umgebungsvariablen](../configuration/environment.md)
