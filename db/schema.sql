PRAGMA foreign_keys = ON;

CREATE TABLE settings_schema (
  key TEXT PRIMARY KEY,
  category TEXT NOT NULL,
  label TEXT NOT NULL,
  type TEXT NOT NULL,
  required INTEGER NOT NULL DEFAULT 0,
  description TEXT,
  default_value TEXT,
  options_json TEXT,
  validation_json TEXT,
  order_index INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE settings_values (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (key) REFERENCES settings_schema(key) ON DELETE CASCADE
);

CREATE TABLE jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT,
  year INTEGER,
  imdb_id TEXT,
  poster_url TEXT,
  omdb_json TEXT,
  selected_from_omdb INTEGER DEFAULT 0,
  start_time TEXT,
  end_time TEXT,
  status TEXT NOT NULL,
  output_path TEXT,
  disc_device TEXT,
  error_message TEXT,
  detected_title TEXT,
  last_state TEXT,
  raw_path TEXT,
  rip_successful INTEGER NOT NULL DEFAULT 0,
  makemkv_info_json TEXT,
  handbrake_info_json TEXT,
  mediainfo_info_json TEXT,
  encode_plan_json TEXT,
  encode_input_path TEXT,
  encode_review_confirmed INTEGER DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_jobs_status ON jobs(status);
CREATE INDEX idx_jobs_created_at ON jobs(created_at DESC);

CREATE TABLE scripts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  script_body TEXT NOT NULL,
  order_index INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_scripts_name ON scripts(name);
CREATE INDEX idx_scripts_order_index ON scripts(order_index, id);

CREATE TABLE script_chains (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  order_index INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_script_chains_name ON script_chains(name);
CREATE INDEX idx_script_chains_order_index ON script_chains(order_index, id);

CREATE TABLE script_chain_steps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chain_id INTEGER NOT NULL,
  position INTEGER NOT NULL,
  step_type TEXT NOT NULL,
  script_id INTEGER,
  wait_seconds INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (chain_id) REFERENCES script_chains(id) ON DELETE CASCADE,
  FOREIGN KEY (script_id) REFERENCES scripts(id) ON DELETE SET NULL
);

CREATE INDEX idx_script_chain_steps_chain ON script_chain_steps(chain_id, position);

CREATE TABLE pipeline_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  state TEXT NOT NULL,
  active_job_id INTEGER,
  progress REAL DEFAULT 0,
  eta TEXT,
  status_text TEXT,
  context_json TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (active_job_id) REFERENCES jobs(id)
);

CREATE TABLE cron_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  cron_expression TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_id INTEGER NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  pushover_enabled INTEGER NOT NULL DEFAULT 1,
  last_run_at TEXT,
  last_run_status TEXT,
  next_run_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_cron_jobs_enabled ON cron_jobs(enabled);

CREATE TABLE cron_run_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cron_job_id INTEGER NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL,
  output TEXT,
  error_message TEXT,
  FOREIGN KEY (cron_job_id) REFERENCES cron_jobs(id) ON DELETE CASCADE
);

CREATE INDEX idx_cron_run_logs_job ON cron_run_logs(cron_job_id, id DESC);

-- =============================================================================
--  Default Settings Seed
-- =============================================================================

-- Pfade – Eigentümer für alternative Verzeichnisse (inline in DynamicSettingsForm gerendert)
INSERT OR IGNORE INTO settings_schema (key, category, label, type, required, description, default_value, options_json, validation_json, order_index)
VALUES ('raw_dir_bluray_owner', 'Pfade', 'Eigentümer Raw-Ordner (Blu-ray)', 'string', 0, 'Eigentümer der Dateien im Format user:gruppe. Nur aktiv wenn ein alternativer Pfad gesetzt ist. Leer = Standardbenutzer des Dienstes.', NULL, '[]', '{}', 1015);
INSERT OR IGNORE INTO settings_values (key, value) VALUES ('raw_dir_bluray_owner', NULL);

INSERT OR IGNORE INTO settings_schema (key, category, label, type, required, description, default_value, options_json, validation_json, order_index)
VALUES ('raw_dir_dvd_owner', 'Pfade', 'Eigentümer Raw-Ordner (DVD)', 'string', 0, 'Eigentümer der Dateien im Format user:gruppe. Nur aktiv wenn ein alternativer Pfad gesetzt ist. Leer = Standardbenutzer des Dienstes.', NULL, '[]', '{}', 1025);
INSERT OR IGNORE INTO settings_values (key, value) VALUES ('raw_dir_dvd_owner', NULL);

INSERT OR IGNORE INTO settings_schema (key, category, label, type, required, description, default_value, options_json, validation_json, order_index)
VALUES ('raw_dir_other_owner', 'Pfade', 'Eigentümer Raw-Ordner (Sonstiges)', 'string', 0, 'Eigentümer der Dateien im Format user:gruppe. Nur aktiv wenn ein alternativer Pfad gesetzt ist. Leer = Standardbenutzer des Dienstes.', NULL, '[]', '{}', 1035);
INSERT OR IGNORE INTO settings_values (key, value) VALUES ('raw_dir_other_owner', NULL);

INSERT OR IGNORE INTO settings_schema (key, category, label, type, required, description, default_value, options_json, validation_json, order_index)
VALUES ('movie_dir_bluray_owner', 'Pfade', 'Eigentümer Film-Ordner (Blu-ray)', 'string', 0, 'Eigentümer der Dateien im Format user:gruppe. Nur aktiv wenn ein alternativer Pfad gesetzt ist. Leer = Standardbenutzer des Dienstes.', NULL, '[]', '{}', 1115);
INSERT OR IGNORE INTO settings_values (key, value) VALUES ('movie_dir_bluray_owner', NULL);

INSERT OR IGNORE INTO settings_schema (key, category, label, type, required, description, default_value, options_json, validation_json, order_index)
VALUES ('movie_dir_dvd_owner', 'Pfade', 'Eigentümer Film-Ordner (DVD)', 'string', 0, 'Eigentümer der Dateien im Format user:gruppe. Nur aktiv wenn ein alternativer Pfad gesetzt ist. Leer = Standardbenutzer des Dienstes.', NULL, '[]', '{}', 1125);
INSERT OR IGNORE INTO settings_values (key, value) VALUES ('movie_dir_dvd_owner', NULL);

INSERT OR IGNORE INTO settings_schema (key, category, label, type, required, description, default_value, options_json, validation_json, order_index)
VALUES ('movie_dir_other_owner', 'Pfade', 'Eigentümer Film-Ordner (Sonstiges)', 'string', 0, 'Eigentümer der Dateien im Format user:gruppe. Nur aktiv wenn ein alternativer Pfad gesetzt ist. Leer = Standardbenutzer des Dienstes.', NULL, '[]', '{}', 1135);
INSERT OR IGNORE INTO settings_values (key, value) VALUES ('movie_dir_other_owner', NULL);

-- Laufwerk
INSERT OR IGNORE INTO settings_schema (key, category, label, type, required, description, default_value, options_json, validation_json, order_index)
VALUES ('drive_mode', 'Laufwerk', 'Laufwerksmodus', 'select', 1, 'Auto-Discovery oder explizites Device.', 'auto', '[{"label":"Auto Discovery","value":"auto"},{"label":"Explizites Device","value":"explicit"}]', '{}', 10);
INSERT OR IGNORE INTO settings_values (key, value) VALUES ('drive_mode', 'auto');

INSERT OR IGNORE INTO settings_schema (key, category, label, type, required, description, default_value, options_json, validation_json, order_index)
VALUES ('drive_device', 'Laufwerk', 'Device Pfad', 'path', 0, 'Nur für expliziten Modus, z.B. /dev/sr0.', '/dev/sr0', '[]', '{}', 20);
INSERT OR IGNORE INTO settings_values (key, value) VALUES ('drive_device', '/dev/sr0');

INSERT OR IGNORE INTO settings_schema (key, category, label, type, required, description, default_value, options_json, validation_json, order_index)
VALUES ('makemkv_source_index', 'Laufwerk', 'MakeMKV Source Index', 'number', 1, 'Disc Index im Auto-Modus.', '0', '[]', '{"min":0,"max":20}', 30);
INSERT OR IGNORE INTO settings_values (key, value) VALUES ('makemkv_source_index', '0');

INSERT OR IGNORE INTO settings_schema (key, category, label, type, required, description, default_value, options_json, validation_json, order_index)
VALUES ('disc_poll_interval_ms', 'Laufwerk', 'Polling Intervall (ms)', 'number', 1, 'Intervall für Disk-Erkennung.', '4000', '[]', '{"min":1000,"max":60000}', 40);
INSERT OR IGNORE INTO settings_values (key, value) VALUES ('disc_poll_interval_ms', '4000');

-- Pfade
INSERT OR IGNORE INTO settings_schema (key, category, label, type, required, description, default_value, options_json, validation_json, order_index)
VALUES ('raw_dir', 'Pfade', 'Raw Ausgabeordner', 'path', 1, 'Zwischenablage für MakeMKV Rip.', 'data/output/raw', '[]', '{"minLength":1}', 100);
INSERT OR IGNORE INTO settings_values (key, value) VALUES ('raw_dir', 'data/output/raw');

INSERT OR IGNORE INTO settings_schema (key, category, label, type, required, description, default_value, options_json, validation_json, order_index)
VALUES ('raw_dir_bluray', 'Pfade', 'Raw Ausgabeordner (Blu-ray)', 'path', 0, 'Optionaler RAW-Zielpfad nur für Blu-ray. Leer = Fallback auf "Raw Ausgabeordner".', NULL, '[]', '{}', 101);
INSERT OR IGNORE INTO settings_values (key, value) VALUES ('raw_dir_bluray', NULL);

INSERT OR IGNORE INTO settings_schema (key, category, label, type, required, description, default_value, options_json, validation_json, order_index)
VALUES ('raw_dir_dvd', 'Pfade', 'Raw Ausgabeordner (DVD)', 'path', 0, 'Optionaler RAW-Zielpfad nur für DVD. Leer = Fallback auf "Raw Ausgabeordner".', NULL, '[]', '{}', 102);
INSERT OR IGNORE INTO settings_values (key, value) VALUES ('raw_dir_dvd', NULL);

INSERT OR IGNORE INTO settings_schema (key, category, label, type, required, description, default_value, options_json, validation_json, order_index)
VALUES ('raw_dir_other', 'Pfade', 'Raw Ausgabeordner (Sonstiges)', 'path', 0, 'Optionaler RAW-Zielpfad nur für Sonstiges. Leer = Fallback auf "Raw Ausgabeordner".', NULL, '[]', '{}', 103);
INSERT OR IGNORE INTO settings_values (key, value) VALUES ('raw_dir_other', NULL);

INSERT OR IGNORE INTO settings_schema (key, category, label, type, required, description, default_value, options_json, validation_json, order_index)
VALUES ('movie_dir', 'Pfade', 'Film Ausgabeordner', 'path', 1, 'Finale HandBrake Ausgabe.', 'data/output/movies', '[]', '{"minLength":1}', 110);
INSERT OR IGNORE INTO settings_values (key, value) VALUES ('movie_dir', 'data/output/movies');

INSERT OR IGNORE INTO settings_schema (key, category, label, type, required, description, default_value, options_json, validation_json, order_index)
VALUES ('movie_dir_bluray', 'Pfade', 'Film Ausgabeordner (Blu-ray)', 'path', 0, 'Optionaler Encode-Zielpfad nur für Blu-ray. Leer = Fallback auf "Film Ausgabeordner".', NULL, '[]', '{}', 111);
INSERT OR IGNORE INTO settings_values (key, value) VALUES ('movie_dir_bluray', NULL);

INSERT OR IGNORE INTO settings_schema (key, category, label, type, required, description, default_value, options_json, validation_json, order_index)
VALUES ('movie_dir_dvd', 'Pfade', 'Film Ausgabeordner (DVD)', 'path', 0, 'Optionaler Encode-Zielpfad nur für DVD. Leer = Fallback auf "Film Ausgabeordner".', NULL, '[]', '{}', 112);
INSERT OR IGNORE INTO settings_values (key, value) VALUES ('movie_dir_dvd', NULL);

INSERT OR IGNORE INTO settings_schema (key, category, label, type, required, description, default_value, options_json, validation_json, order_index)
VALUES ('movie_dir_other', 'Pfade', 'Film Ausgabeordner (Sonstiges)', 'path', 0, 'Optionaler Encode-Zielpfad nur für Sonstiges. Leer = Fallback auf "Film Ausgabeordner".', NULL, '[]', '{}', 113);
INSERT OR IGNORE INTO settings_values (key, value) VALUES ('movie_dir_other', NULL);

INSERT OR IGNORE INTO settings_schema (key, category, label, type, required, description, default_value, options_json, validation_json, order_index)
VALUES ('log_dir', 'Pfade', 'Log Ordner', 'path', 1, 'Basisordner für Logs. Job-Logs liegen direkt hier, Backend-Logs in /backend.', 'data/logs', '[]', '{"minLength":1}', 120);
INSERT OR IGNORE INTO settings_values (key, value) VALUES ('log_dir', 'data/logs');

-- Monitoring
INSERT OR IGNORE INTO settings_schema (key, category, label, type, required, description, default_value, options_json, validation_json, order_index)
VALUES ('hardware_monitoring_enabled', 'Monitoring', 'Hardware Monitoring aktiviert', 'boolean', 1, 'Master-Schalter: aktiviert/deaktiviert das komplette Hardware-Monitoring (Polling + Berechnung + WebSocket-Updates).', 'true', '[]', '{}', 130);
INSERT OR IGNORE INTO settings_values (key, value) VALUES ('hardware_monitoring_enabled', 'true');

INSERT OR IGNORE INTO settings_schema (key, category, label, type, required, description, default_value, options_json, validation_json, order_index)
VALUES ('hardware_monitoring_interval_ms', 'Monitoring', 'Hardware Monitoring Intervall (ms)', 'number', 1, 'Polling-Intervall für CPU/RAM/GPU/Storage-Metriken.', '5000', '[]', '{"min":1000,"max":60000}', 140);
INSERT OR IGNORE INTO settings_values (key, value) VALUES ('hardware_monitoring_interval_ms', '5000');

-- Tools
INSERT OR IGNORE INTO settings_schema (key, category, label, type, required, description, default_value, options_json, validation_json, order_index)
VALUES ('makemkv_command', 'Tools', 'MakeMKV Kommando', 'string', 1, 'Pfad oder Befehl für makemkvcon.', 'makemkvcon', '[]', '{"minLength":1}', 200);
INSERT OR IGNORE INTO settings_values (key, value) VALUES ('makemkv_command', 'makemkvcon');

INSERT OR IGNORE INTO settings_schema (key, category, label, type, required, description, default_value, options_json, validation_json, order_index)
VALUES ('makemkv_registration_key', 'Tools', 'MakeMKV Key', 'string', 0, 'Optionaler Registrierungsschlüssel. Wird vor Analyze/Rip automatisch per "makemkvcon reg" gesetzt.', NULL, '[]', '{}', 202);
INSERT OR IGNORE INTO settings_values (key, value) VALUES ('makemkv_registration_key', NULL);

INSERT OR IGNORE INTO settings_schema (key, category, label, type, required, description, default_value, options_json, validation_json, order_index)
VALUES ('mediainfo_command', 'Tools', 'Mediainfo Kommando', 'string', 1, 'Pfad oder Befehl für mediainfo.', 'mediainfo', '[]', '{"minLength":1}', 205);
INSERT OR IGNORE INTO settings_values (key, value) VALUES ('mediainfo_command', 'mediainfo');

INSERT OR IGNORE INTO settings_schema (key, category, label, type, required, description, default_value, options_json, validation_json, order_index)
VALUES ('makemkv_min_length_minutes', 'Tools', 'Minimale Titellänge (Minuten)', 'number', 1, 'Filtert kurze Titel beim Rip.', '60', '[]', '{"min":1,"max":1000}', 210);
INSERT OR IGNORE INTO settings_values (key, value) VALUES ('makemkv_min_length_minutes', '60');

INSERT OR IGNORE INTO settings_schema (key, category, label, type, required, description, default_value, options_json, validation_json, order_index)
VALUES ('handbrake_command', 'Tools', 'HandBrake Kommando', 'string', 1, 'Pfad oder Befehl für HandBrakeCLI.', 'HandBrakeCLI', '[]', '{"minLength":1}', 215);
INSERT OR IGNORE INTO settings_values (key, value) VALUES ('handbrake_command', 'HandBrakeCLI');

INSERT OR IGNORE INTO settings_schema (key, category, label, type, required, description, default_value, options_json, validation_json, order_index)
VALUES ('handbrake_restart_delete_incomplete_output', 'Tools', 'Encode-Neustart: unvollständige Ausgabe löschen', 'boolean', 1, 'Wenn aktiv, wird bei "Encode neu starten" der bisherige (nicht erfolgreiche) Output vor Start entfernt.', 'true', '[]', '{}', 220);
INSERT OR IGNORE INTO settings_values (key, value) VALUES ('handbrake_restart_delete_incomplete_output', 'true');

INSERT OR IGNORE INTO settings_schema (key, category, label, type, required, description, default_value, options_json, validation_json, order_index)
VALUES ('pipeline_max_parallel_jobs', 'Tools', 'Parallele Jobs', 'number', 1, 'Maximale Anzahl parallel laufender Jobs. Weitere Starts landen in der Queue.', '1', '[]', '{"min":1,"max":12}', 225);
INSERT OR IGNORE INTO settings_values (key, value) VALUES ('pipeline_max_parallel_jobs', '1');

-- Tools – Blu-ray
INSERT OR IGNORE INTO settings_schema (key, category, label, type, required, description, default_value, options_json, validation_json, order_index)
VALUES ('mediainfo_extra_args_bluray', 'Tools', 'Mediainfo Extra Args', 'string', 0, 'Zusätzliche CLI-Parameter für mediainfo (Blu-ray).', NULL, '[]', '{}', 300);
INSERT OR IGNORE INTO settings_values (key, value) VALUES ('mediainfo_extra_args_bluray', NULL);

INSERT OR IGNORE INTO settings_schema (key, category, label, type, required, description, default_value, options_json, validation_json, order_index)
VALUES ('makemkv_rip_mode_bluray', 'Tools', 'MakeMKV Rip Modus', 'select', 1, 'mkv: direkte MKV-Dateien; backup: vollständige Blu-ray Struktur im RAW-Ordner.', 'backup', '[{"label":"MKV","value":"mkv"},{"label":"Backup","value":"backup"}]', '{}', 305);
INSERT OR IGNORE INTO settings_values (key, value) VALUES ('makemkv_rip_mode_bluray', 'backup');

INSERT OR IGNORE INTO settings_schema (key, category, label, type, required, description, default_value, options_json, validation_json, order_index)
VALUES ('makemkv_analyze_extra_args_bluray', 'Tools', 'MakeMKV Analyze Extra Args', 'string', 0, 'Zusätzliche CLI-Parameter für Analyze (Blu-ray).', NULL, '[]', '{}', 310);
INSERT OR IGNORE INTO settings_values (key, value) VALUES ('makemkv_analyze_extra_args_bluray', NULL);

INSERT OR IGNORE INTO settings_schema (key, category, label, type, required, description, default_value, options_json, validation_json, order_index)
VALUES ('makemkv_rip_extra_args_bluray', 'Tools', 'MakeMKV Rip Extra Args', 'string', 0, 'Zusätzliche CLI-Parameter für Rip (Blu-ray).', NULL, '[]', '{}', 315);
INSERT OR IGNORE INTO settings_values (key, value) VALUES ('makemkv_rip_extra_args_bluray', NULL);

INSERT OR IGNORE INTO settings_schema (key, category, label, type, required, description, default_value, options_json, validation_json, order_index)
VALUES ('handbrake_preset_bluray', 'Tools', 'HandBrake Preset', 'string', 1, 'Preset Name für -Z (Blu-ray).', 'H.264 MKV 1080p30', '[]', '{"minLength":1}', 320);
INSERT OR IGNORE INTO settings_values (key, value) VALUES ('handbrake_preset_bluray', 'H.264 MKV 1080p30');

INSERT OR IGNORE INTO settings_schema (key, category, label, type, required, description, default_value, options_json, validation_json, order_index)
VALUES ('handbrake_extra_args_bluray', 'Tools', 'HandBrake Extra Args', 'string', 0, 'Zusätzliche CLI-Argumente (Blu-ray).', NULL, '[]', '{}', 325);
INSERT OR IGNORE INTO settings_values (key, value) VALUES ('handbrake_extra_args_bluray', NULL);

INSERT OR IGNORE INTO settings_schema (key, category, label, type, required, description, default_value, options_json, validation_json, order_index)
VALUES ('output_extension_bluray', 'Tools', 'Ausgabeformat', 'select', 1, 'Dateiendung für finale Datei (Blu-ray).', 'mkv', '[{"label":"MKV","value":"mkv"},{"label":"MP4","value":"mp4"}]', '{}', 330);
INSERT OR IGNORE INTO settings_values (key, value) VALUES ('output_extension_bluray', 'mkv');

INSERT OR IGNORE INTO settings_schema (key, category, label, type, required, description, default_value, options_json, validation_json, order_index)
VALUES ('filename_template_bluray', 'Tools', 'Dateiname Template', 'string', 1, 'Verfügbare Tokens: ${title}, ${year}, ${imdbId} (Blu-ray).', '${title} (${year})', '[]', '{"minLength":1}', 335);
INSERT OR IGNORE INTO settings_values (key, value) VALUES ('filename_template_bluray', '${title} (${year})');

INSERT OR IGNORE INTO settings_schema (key, category, label, type, required, description, default_value, options_json, validation_json, order_index)
VALUES ('output_folder_template_bluray', 'Tools', 'Ordnername Template', 'string', 0, 'Optional. Verfügbare Tokens: ${title}, ${year}, ${imdbId}. Leer = Dateiname-Template (Blu-ray).', NULL, '[]', '{}', 340);
INSERT OR IGNORE INTO settings_values (key, value) VALUES ('output_folder_template_bluray', NULL);

-- Tools – DVD
INSERT OR IGNORE INTO settings_schema (key, category, label, type, required, description, default_value, options_json, validation_json, order_index)
VALUES ('mediainfo_extra_args_dvd', 'Tools', 'Mediainfo Extra Args', 'string', 0, 'Zusätzliche CLI-Parameter für mediainfo (DVD).', NULL, '[]', '{}', 500);
INSERT OR IGNORE INTO settings_values (key, value) VALUES ('mediainfo_extra_args_dvd', NULL);

INSERT OR IGNORE INTO settings_schema (key, category, label, type, required, description, default_value, options_json, validation_json, order_index)
VALUES ('makemkv_rip_mode_dvd', 'Tools', 'MakeMKV Rip Modus', 'select', 1, 'mkv: direkte MKV-Dateien; backup: vollständige Disc-Struktur im RAW-Ordner.', 'mkv', '[{"label":"MKV","value":"mkv"},{"label":"Backup","value":"backup"}]', '{}', 505);
INSERT OR IGNORE INTO settings_values (key, value) VALUES ('makemkv_rip_mode_dvd', 'mkv');

INSERT OR IGNORE INTO settings_schema (key, category, label, type, required, description, default_value, options_json, validation_json, order_index)
VALUES ('makemkv_analyze_extra_args_dvd', 'Tools', 'MakeMKV Analyze Extra Args', 'string', 0, 'Zusätzliche CLI-Parameter für Analyze (DVD).', NULL, '[]', '{}', 510);
INSERT OR IGNORE INTO settings_values (key, value) VALUES ('makemkv_analyze_extra_args_dvd', NULL);

INSERT OR IGNORE INTO settings_schema (key, category, label, type, required, description, default_value, options_json, validation_json, order_index)
VALUES ('makemkv_rip_extra_args_dvd', 'Tools', 'MakeMKV Rip Extra Args', 'string', 0, 'Zusätzliche CLI-Parameter für Rip (DVD).', NULL, '[]', '{}', 515);
INSERT OR IGNORE INTO settings_values (key, value) VALUES ('makemkv_rip_extra_args_dvd', NULL);

INSERT OR IGNORE INTO settings_schema (key, category, label, type, required, description, default_value, options_json, validation_json, order_index)
VALUES ('handbrake_preset_dvd', 'Tools', 'HandBrake Preset', 'string', 1, 'Preset Name für -Z (DVD).', 'H.264 MKV 480p30', '[]', '{"minLength":1}', 520);
INSERT OR IGNORE INTO settings_values (key, value) VALUES ('handbrake_preset_dvd', 'H.264 MKV 480p30');

INSERT OR IGNORE INTO settings_schema (key, category, label, type, required, description, default_value, options_json, validation_json, order_index)
VALUES ('handbrake_extra_args_dvd', 'Tools', 'HandBrake Extra Args', 'string', 0, 'Zusätzliche CLI-Argumente (DVD).', NULL, '[]', '{}', 525);
INSERT OR IGNORE INTO settings_values (key, value) VALUES ('handbrake_extra_args_dvd', NULL);

INSERT OR IGNORE INTO settings_schema (key, category, label, type, required, description, default_value, options_json, validation_json, order_index)
VALUES ('output_extension_dvd', 'Tools', 'Ausgabeformat', 'select', 1, 'Dateiendung für finale Datei (DVD).', 'mkv', '[{"label":"MKV","value":"mkv"},{"label":"MP4","value":"mp4"}]', '{}', 530);
INSERT OR IGNORE INTO settings_values (key, value) VALUES ('output_extension_dvd', 'mkv');

INSERT OR IGNORE INTO settings_schema (key, category, label, type, required, description, default_value, options_json, validation_json, order_index)
VALUES ('filename_template_dvd', 'Tools', 'Dateiname Template', 'string', 1, 'Verfügbare Tokens: ${title}, ${year}, ${imdbId} (DVD).', '${title} (${year})', '[]', '{"minLength":1}', 535);
INSERT OR IGNORE INTO settings_values (key, value) VALUES ('filename_template_dvd', '${title} (${year})');

INSERT OR IGNORE INTO settings_schema (key, category, label, type, required, description, default_value, options_json, validation_json, order_index)
VALUES ('output_folder_template_dvd', 'Tools', 'Ordnername Template', 'string', 0, 'Optional. Verfügbare Tokens: ${title}, ${year}, ${imdbId}. Leer = Dateiname-Template (DVD).', NULL, '[]', '{}', 540);
INSERT OR IGNORE INTO settings_values (key, value) VALUES ('output_folder_template_dvd', NULL);

-- Metadaten
INSERT OR IGNORE INTO settings_schema (key, category, label, type, required, description, default_value, options_json, validation_json, order_index)
VALUES ('omdb_api_key', 'Metadaten', 'OMDb API Key', 'string', 0, 'API Key für Metadatensuche.', NULL, '[]', '{}', 400);
INSERT OR IGNORE INTO settings_values (key, value) VALUES ('omdb_api_key', NULL);

INSERT OR IGNORE INTO settings_schema (key, category, label, type, required, description, default_value, options_json, validation_json, order_index)
VALUES ('omdb_default_type', 'Metadaten', 'OMDb Typ', 'select', 1, 'Vorauswahl für Suche.', 'movie', '[{"label":"Movie","value":"movie"},{"label":"Series","value":"series"},{"label":"Episode","value":"episode"}]', '{}', 410);
INSERT OR IGNORE INTO settings_values (key, value) VALUES ('omdb_default_type', 'movie');

-- Benachrichtigungen
INSERT OR IGNORE INTO settings_schema (key, category, label, type, required, description, default_value, options_json, validation_json, order_index)
VALUES ('pushover_enabled', 'Benachrichtigungen', 'PushOver aktiviert', 'boolean', 1, 'Master-Schalter für PushOver Versand.', 'false', '[]', '{}', 500);
INSERT OR IGNORE INTO settings_values (key, value) VALUES ('pushover_enabled', 'false');

INSERT OR IGNORE INTO settings_schema (key, category, label, type, required, description, default_value, options_json, validation_json, order_index)
VALUES ('pushover_token', 'Benachrichtigungen', 'PushOver Token', 'string', 0, 'Application Token für PushOver.', NULL, '[]', '{}', 510);
INSERT OR IGNORE INTO settings_values (key, value) VALUES ('pushover_token', NULL);

INSERT OR IGNORE INTO settings_schema (key, category, label, type, required, description, default_value, options_json, validation_json, order_index)
VALUES ('pushover_user', 'Benachrichtigungen', 'PushOver User', 'string', 0, 'User-Key für PushOver.', NULL, '[]', '{}', 520);
INSERT OR IGNORE INTO settings_values (key, value) VALUES ('pushover_user', NULL);

INSERT OR IGNORE INTO settings_schema (key, category, label, type, required, description, default_value, options_json, validation_json, order_index)
VALUES ('pushover_device', 'Benachrichtigungen', 'PushOver Device (optional)', 'string', 0, 'Optionales Ziel-Device in PushOver.', NULL, '[]', '{}', 530);
INSERT OR IGNORE INTO settings_values (key, value) VALUES ('pushover_device', NULL);

INSERT OR IGNORE INTO settings_schema (key, category, label, type, required, description, default_value, options_json, validation_json, order_index)
VALUES ('pushover_title_prefix', 'Benachrichtigungen', 'PushOver Titel-Präfix', 'string', 1, 'Prefix im PushOver Titel.', 'Ripster', '[]', '{"minLength":1}', 540);
INSERT OR IGNORE INTO settings_values (key, value) VALUES ('pushover_title_prefix', 'Ripster');

INSERT OR IGNORE INTO settings_schema (key, category, label, type, required, description, default_value, options_json, validation_json, order_index)
VALUES ('pushover_priority', 'Benachrichtigungen', 'PushOver Priority', 'number', 1, 'Priorität -2 bis 2.', '0', '[]', '{"min":-2,"max":2}', 550);
INSERT OR IGNORE INTO settings_values (key, value) VALUES ('pushover_priority', '0');

INSERT OR IGNORE INTO settings_schema (key, category, label, type, required, description, default_value, options_json, validation_json, order_index)
VALUES ('pushover_timeout_ms', 'Benachrichtigungen', 'PushOver Timeout (ms)', 'number', 1, 'HTTP Timeout für PushOver Requests.', '7000', '[]', '{"min":1000,"max":60000}', 560);
INSERT OR IGNORE INTO settings_values (key, value) VALUES ('pushover_timeout_ms', '7000');

INSERT OR IGNORE INTO settings_schema (key, category, label, type, required, description, default_value, options_json, validation_json, order_index)
VALUES ('pushover_notify_metadata_ready', 'Benachrichtigungen', 'Bei Metadaten-Auswahl senden', 'boolean', 1, 'Sendet wenn Metadaten zur Auswahl bereitstehen.', 'true', '[]', '{}', 570);
INSERT OR IGNORE INTO settings_values (key, value) VALUES ('pushover_notify_metadata_ready', 'true');

INSERT OR IGNORE INTO settings_schema (key, category, label, type, required, description, default_value, options_json, validation_json, order_index)
VALUES ('pushover_notify_rip_started', 'Benachrichtigungen', 'Bei Rip-Start senden', 'boolean', 1, 'Sendet beim Start des MakeMKV-Rips.', 'true', '[]', '{}', 580);
INSERT OR IGNORE INTO settings_values (key, value) VALUES ('pushover_notify_rip_started', 'true');

INSERT OR IGNORE INTO settings_schema (key, category, label, type, required, description, default_value, options_json, validation_json, order_index)
VALUES ('pushover_notify_encoding_started', 'Benachrichtigungen', 'Bei Encode-Start senden', 'boolean', 1, 'Sendet beim Start von HandBrake.', 'true', '[]', '{}', 590);
INSERT OR IGNORE INTO settings_values (key, value) VALUES ('pushover_notify_encoding_started', 'true');

INSERT OR IGNORE INTO settings_schema (key, category, label, type, required, description, default_value, options_json, validation_json, order_index)
VALUES ('pushover_notify_job_finished', 'Benachrichtigungen', 'Bei Erfolg senden', 'boolean', 1, 'Sendet bei erfolgreich abgeschlossenem Job.', 'true', '[]', '{}', 600);
INSERT OR IGNORE INTO settings_values (key, value) VALUES ('pushover_notify_job_finished', 'true');

INSERT OR IGNORE INTO settings_schema (key, category, label, type, required, description, default_value, options_json, validation_json, order_index)
VALUES ('pushover_notify_job_error', 'Benachrichtigungen', 'Bei Fehler senden', 'boolean', 1, 'Sendet bei Fehlern in der Pipeline.', 'true', '[]', '{}', 610);
INSERT OR IGNORE INTO settings_values (key, value) VALUES ('pushover_notify_job_error', 'true');

INSERT OR IGNORE INTO settings_schema (key, category, label, type, required, description, default_value, options_json, validation_json, order_index)
VALUES ('pushover_notify_job_cancelled', 'Benachrichtigungen', 'Bei Abbruch senden', 'boolean', 1, 'Sendet wenn Job manuell abgebrochen wurde.', 'true', '[]', '{}', 620);
INSERT OR IGNORE INTO settings_values (key, value) VALUES ('pushover_notify_job_cancelled', 'true');

INSERT OR IGNORE INTO settings_schema (key, category, label, type, required, description, default_value, options_json, validation_json, order_index)
VALUES ('pushover_notify_reencode_started', 'Benachrichtigungen', 'Bei Re-Encode Start senden', 'boolean', 1, 'Sendet beim Start von RAW Re-Encode.', 'true', '[]', '{}', 630);
INSERT OR IGNORE INTO settings_values (key, value) VALUES ('pushover_notify_reencode_started', 'true');

INSERT OR IGNORE INTO settings_schema (key, category, label, type, required, description, default_value, options_json, validation_json, order_index)
VALUES ('pushover_notify_reencode_finished', 'Benachrichtigungen', 'Bei Re-Encode Erfolg senden', 'boolean', 1, 'Sendet bei erfolgreichem RAW Re-Encode.', 'true', '[]', '{}', 640);
INSERT OR IGNORE INTO settings_values (key, value) VALUES ('pushover_notify_reencode_finished', 'true');
