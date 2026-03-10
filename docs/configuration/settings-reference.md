# Einstellungsreferenz

Alle Settings liegen in `settings_schema`/`settings_values` und werden über die UI verwaltet.

---

## Profil-System

Ripster arbeitet mit Media-Profilen:

- `bluray`
- `dvd`
- `other`

Viele Tool-/Pfad-Settings existieren als Profil-Varianten (`*_bluray`, `*_dvd`, `*_other`).

Wichtig:

- Für `raw_dir`, `movie_dir` und die zugehörigen `*_owner`-Keys gibt es **kein Cross-Profil-Fallback**.
- Für viele Tool-Keys werden profilspezifische Varianten bevorzugt.

---

## Template-Platzhalter

Datei-/Ordner-Templates unterstützen:

- `${title}`
- `${year}`
- `${imdbId}`

Nicht gesetzte Werte werden zu `unknown`.

---

## Kategorie: Pfade

| Key | Typ | Default |
|-----|-----|---------|
| `raw_dir` | path | `data/output/raw` |
| `raw_dir_bluray` | path | `null` |
| `raw_dir_dvd` | path | `null` |
| `raw_dir_other` | path | `null` |
| `raw_dir_bluray_owner` | string | `null` |
| `raw_dir_dvd_owner` | string | `null` |
| `raw_dir_other_owner` | string | `null` |
| `movie_dir` | path | `data/output/movies` |
| `movie_dir_bluray` | path | `null` |
| `movie_dir_dvd` | path | `null` |
| `movie_dir_other` | path | `null` |
| `movie_dir_bluray_owner` | string | `null` |
| `movie_dir_dvd_owner` | string | `null` |
| `movie_dir_other_owner` | string | `null` |
| `log_dir` | path | `data/logs` |

---

## Kategorie: Laufwerk

| Key | Typ | Default | Hinweis |
|-----|-----|---------|--------|
| `drive_mode` | select | `auto` | `auto` oder `explicit` |
| `drive_device` | path | `/dev/sr0` | bei `explicit` relevant |
| `makemkv_source_index` | number | `0` | MakeMKV Source-Index |
| `disc_poll_interval_ms` | number | `4000` | 1000..60000 |

---

## Kategorie: Monitoring

| Key | Typ | Default |
|-----|-----|---------|
| `hardware_monitoring_enabled` | boolean | `true` |
| `hardware_monitoring_interval_ms` | number | `5000` |

---

## Kategorie: Tools (global)

| Key | Typ | Default |
|-----|-----|---------|
| `makemkv_command` | string | `makemkvcon` |
| `makemkv_registration_key` | string | `null` |
| `mediainfo_command` | string | `mediainfo` |
| `makemkv_min_length_minutes` | number | `60` |
| `handbrake_command` | string | `HandBrakeCLI` |
| `handbrake_restart_delete_incomplete_output` | boolean | `true` |
| `pipeline_max_parallel_jobs` | number | `1` |

### Blu-ray-spezifisch

| Key | Typ | Default |
|-----|-----|---------|
| `mediainfo_extra_args_bluray` | string | `null` |
| `makemkv_rip_mode_bluray` | select | `backup` |
| `makemkv_analyze_extra_args_bluray` | string | `null` |
| `makemkv_rip_extra_args_bluray` | string | `null` |
| `handbrake_preset_bluray` | string | `H.264 MKV 1080p30` |
| `handbrake_extra_args_bluray` | string | `null` |
| `output_extension_bluray` | select | `mkv` |
| `filename_template_bluray` | string | `${title} (${year})` |
| `output_folder_template_bluray` | string | `null` |

### DVD-spezifisch

| Key | Typ | Default |
|-----|-----|---------|
| `mediainfo_extra_args_dvd` | string | `null` |
| `makemkv_rip_mode_dvd` | select | `mkv` |
| `makemkv_analyze_extra_args_dvd` | string | `null` |
| `makemkv_rip_extra_args_dvd` | string | `null` |
| `handbrake_preset_dvd` | string | `H.264 MKV 480p30` |
| `handbrake_extra_args_dvd` | string | `null` |
| `output_extension_dvd` | select | `mkv` |
| `filename_template_dvd` | string | `${title} (${year})` |
| `output_folder_template_dvd` | string | `null` |

---

## Kategorie: Metadaten

| Key | Typ | Default |
|-----|-----|---------|
| `omdb_api_key` | string | `null` |
| `omdb_default_type` | select | `movie` |

---

## Kategorie: Benachrichtigungen (PushOver)

| Key | Typ | Default |
|-----|-----|---------|
| `pushover_enabled` | boolean | `false` |
| `pushover_token` | string | `null` |
| `pushover_user` | string | `null` |
| `pushover_device` | string | `null` |
| `pushover_title_prefix` | string | `Ripster` |
| `pushover_priority` | number | `0` |
| `pushover_timeout_ms` | number | `7000` |
| `pushover_notify_metadata_ready` | boolean | `true` |
| `pushover_notify_rip_started` | boolean | `true` |
| `pushover_notify_encoding_started` | boolean | `true` |
| `pushover_notify_job_finished` | boolean | `true` |
| `pushover_notify_job_error` | boolean | `true` |
| `pushover_notify_job_cancelled` | boolean | `true` |
| `pushover_notify_reencode_started` | boolean | `true` |
| `pushover_notify_reencode_finished` | boolean | `true` |

---

## Entfernte Legacy-Keys

Diese Legacy-Keys werden bei Migration entfernt und sollten nicht mehr genutzt werden:

- `makemkv_backup_mode`
- `mediainfo_extra_args`
- `makemkv_rip_mode`
- `makemkv_analyze_extra_args`
- `makemkv_rip_extra_args`
- `handbrake_preset`
- `handbrake_extra_args`
- `output_extension`
- `filename_template`
- `output_folder_template`
- `pushover_notify_disc_detected`
