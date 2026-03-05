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
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_scripts_name ON scripts(name);

CREATE TABLE script_chains (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_script_chains_name ON script_chains(name);

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
