const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const { dbPath } = require('../config');
const logger = require('../services/logger').child('DB');
const { errorToMeta } = require('../utils/errorMeta');
const { setLogRootDir, getJobLogDir } = require('../services/logPathService');

const schemaFilePath = path.resolve(__dirname, '../../../db/schema.sql');
const LEGACY_PROFILE_SETTING_MIGRATIONS = [
  {
    legacyKey: 'mediainfo_extra_args',
    profileKeys: ['mediainfo_extra_args_bluray', 'mediainfo_extra_args_dvd']
  },
  {
    legacyKey: 'makemkv_rip_mode',
    profileKeys: ['makemkv_rip_mode_bluray', 'makemkv_rip_mode_dvd']
  },
  {
    legacyKey: 'makemkv_analyze_extra_args',
    profileKeys: ['makemkv_analyze_extra_args_bluray', 'makemkv_analyze_extra_args_dvd']
  },
  {
    legacyKey: 'makemkv_rip_extra_args',
    profileKeys: ['makemkv_rip_extra_args_bluray', 'makemkv_rip_extra_args_dvd']
  },
  {
    legacyKey: 'handbrake_preset',
    profileKeys: ['handbrake_preset_bluray', 'handbrake_preset_dvd']
  },
  {
    legacyKey: 'handbrake_extra_args',
    profileKeys: ['handbrake_extra_args_bluray', 'handbrake_extra_args_dvd']
  },
  {
    legacyKey: 'output_extension',
    profileKeys: ['output_extension_bluray', 'output_extension_dvd']
  },
  {
    legacyKey: 'filename_template',
    profileKeys: ['filename_template_bluray', 'filename_template_dvd']
  },
  {
    legacyKey: 'output_folder_template',
    profileKeys: ['output_folder_template_bluray', 'output_folder_template_dvd']
  }
];
const INSTALL_PATH_SETTING_DEFAULTS = [
  {
    key: 'raw_dir',
    pathParts: ['output', 'raw'],
    legacyDefaults: ['data/output/raw', './data/output/raw']
  },
  {
    key: 'movie_dir',
    pathParts: ['output', 'movies'],
    legacyDefaults: ['data/output/movies', './data/output/movies']
  },
  {
    key: 'log_dir',
    pathParts: ['logs'],
    legacyDefaults: ['data/logs', './data/logs']
  }
];

let dbInstance;

function nowFileStamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function isSqliteCorruptionError(error) {
  if (!error) {
    return false;
  }

  const code = String(error.code || '').toUpperCase();
  const msg = String(error.message || '').toLowerCase();

  return (
    code === 'SQLITE_CORRUPT' ||
    msg.includes('database disk image is malformed') ||
    msg.includes('file is not a database')
  );
}

function moveIfExists(sourcePath, targetPath) {
  if (!fs.existsSync(sourcePath)) {
    return false;
  }
  fs.renameSync(sourcePath, targetPath);
  return true;
}

function quarantineCorruptDatabaseFiles() {
  const dir = path.dirname(dbPath);
  const base = path.basename(dbPath);
  const stamp = nowFileStamp();
  const archiveDir = path.join(dir, 'corrupt-backups');

  fs.mkdirSync(archiveDir, { recursive: true });

  const moved = [];
  const candidates = [
    dbPath,
    `${dbPath}-wal`,
    `${dbPath}-shm`
  ];

  for (const sourcePath of candidates) {
    const fileName = path.basename(sourcePath);
    const targetPath = path.join(archiveDir, `${fileName}.${stamp}.corrupt`);
    if (moveIfExists(sourcePath, targetPath)) {
      moved.push({
        from: sourcePath,
        to: targetPath
      });
    }
  }

  logger.warn('recovery:quarantine-complete', {
    dbPath,
    base,
    movedCount: moved.length,
    moved
  });
}

function quoteIdentifier(identifier) {
  return `"${String(identifier || '').replace(/"/g, '""')}"`;
}

function normalizeSqlType(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').toUpperCase();
}

function normalizeDefault(value) {
  if (value === null || value === undefined) {
    return '';
  }
  return String(value).trim().replace(/\s+/g, ' ').toUpperCase();
}

function sameTableShape(current = [], desired = []) {
  if (current.length !== desired.length) {
    return false;
  }
  for (let i = 0; i < current.length; i += 1) {
    const left = current[i];
    const right = desired[i];
    if (!left || !right) {
      return false;
    }
    if (String(left.name || '') !== String(right.name || '')) {
      return false;
    }
    if (normalizeSqlType(left.type) !== normalizeSqlType(right.type)) {
      return false;
    }
    if (Number(left.notnull || 0) !== Number(right.notnull || 0)) {
      return false;
    }
    if (Number(left.pk || 0) !== Number(right.pk || 0)) {
      return false;
    }
    if (normalizeDefault(left.dflt_value) !== normalizeDefault(right.dflt_value)) {
      return false;
    }
  }
  return true;
}

function sameForeignKeys(current = [], desired = []) {
  if (current.length !== desired.length) {
    return false;
  }
  for (let i = 0; i < current.length; i += 1) {
    const left = current[i];
    const right = desired[i];
    if (!left || !right) {
      return false;
    }
    if (Number(left.id || 0) !== Number(right.id || 0)) {
      return false;
    }
    if (Number(left.seq || 0) !== Number(right.seq || 0)) {
      return false;
    }
    if (String(left.table || '') !== String(right.table || '')) {
      return false;
    }
    if (String(left.from || '') !== String(right.from || '')) {
      return false;
    }
    if (String(left.to || '') !== String(right.to || '')) {
      return false;
    }
    if (String(left.on_update || '') !== String(right.on_update || '')) {
      return false;
    }
    if (String(left.on_delete || '') !== String(right.on_delete || '')) {
      return false;
    }
    if (String(left.match || '') !== String(right.match || '')) {
      return false;
    }
  }
  return true;
}

async function tableExists(db, tableName) {
  const row = await db.get(
    `SELECT 1 as ok FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1`,
    [tableName]
  );
  return Boolean(row);
}

async function getTableInfo(db, tableName) {
  return db.all(`PRAGMA table_info(${quoteIdentifier(tableName)})`);
}

async function getForeignKeyInfo(db, tableName) {
  return db.all(`PRAGMA foreign_key_list(${quoteIdentifier(tableName)})`);
}

async function readConfiguredLogDirSetting(db) {
  const hasSchemaTable = await tableExists(db, 'settings_schema');
  const hasValuesTable = await tableExists(db, 'settings_values');
  if (!hasSchemaTable || !hasValuesTable) {
    return null;
  }

  try {
    const row = await db.get(
      `
        SELECT
          COALESCE(v.value, s.default_value, '') AS value
        FROM settings_schema s
        LEFT JOIN settings_values v ON v.key = s.key
        WHERE s.key = ?
        LIMIT 1
      `,
      ['log_dir']
    );
    const value = String(row?.value || '').trim();
    return value || null;
  } catch (error) {
    logger.warn('log-root:read-setting-failed', {
      error: error?.message || String(error)
    });
    return null;
  }
}

async function configureRuntimeLogRootFromSettings(db, options = {}) {
  const ensure = Boolean(options.ensure);
  const configured = await readConfiguredLogDirSetting(db);
  let resolved = setLogRootDir(configured);
  if (ensure) {
    try {
      fs.mkdirSync(resolved, { recursive: true });
    } catch (error) {
      const fallbackResolved = setLogRootDir(null);
      try {
        fs.mkdirSync(fallbackResolved, { recursive: true });
      } catch (_fallbackError) {
        // ignored: logger itself is hardened and may still write to console only
      }
      logger.warn('log-root:ensure-failed', {
        configured: configured || null,
        resolved,
        fallbackResolved,
        error: error?.message || String(error)
      });
      resolved = fallbackResolved;
    }
  }
  return {
    configured,
    resolved
  };
}

async function loadSchemaModel() {
  if (!fs.existsSync(schemaFilePath)) {
    const error = new Error(`Schema-Datei fehlt: ${schemaFilePath}`);
    error.code = 'SCHEMA_FILE_MISSING';
    throw error;
  }

  const schemaSql = fs.readFileSync(schemaFilePath, 'utf-8');
  const memDb = await open({
    filename: ':memory:',
    driver: sqlite3.Database
  });

  try {
    await memDb.exec(schemaSql);
    const tables = await memDb.all(`
      SELECT name, sql
      FROM sqlite_master
      WHERE type = 'table'
        AND name NOT LIKE 'sqlite_%'
      ORDER BY rowid ASC
    `);
    const indexes = await memDb.all(`
      SELECT name, tbl_name AS tableName, sql
      FROM sqlite_master
      WHERE type = 'index'
        AND name NOT LIKE 'sqlite_%'
        AND sql IS NOT NULL
      ORDER BY rowid ASC
    `);
    const tableInfos = {};
    const tableForeignKeys = {};
    for (const table of tables) {
      tableInfos[table.name] = await getTableInfo(memDb, table.name);
      tableForeignKeys[table.name] = await getForeignKeyInfo(memDb, table.name);
    }

    return {
      schemaSql,
      tables,
      indexes,
      tableInfos,
      tableForeignKeys
    };
  } finally {
    await memDb.close();
  }
}

async function rebuildTable(db, tableName, createSql) {
  const oldName = `${tableName}__old_${Date.now()}`;
  const tableNameQuoted = quoteIdentifier(tableName);
  const oldNameQuoted = quoteIdentifier(oldName);
  const beforeInfo = await getTableInfo(db, tableName);

  await db.exec(`ALTER TABLE ${tableNameQuoted} RENAME TO ${oldNameQuoted}`);
  await db.exec(createSql);

  const afterInfo = await getTableInfo(db, tableName);
  const beforeColumns = new Set(beforeInfo.map((column) => String(column.name)));
  const commonColumns = afterInfo
    .map((column) => String(column.name))
    .filter((name) => beforeColumns.has(name));

  if (commonColumns.length > 0) {
    const columnList = commonColumns.map((name) => quoteIdentifier(name)).join(', ');
    await db.exec(`
      INSERT INTO ${tableNameQuoted} (${columnList})
      SELECT ${columnList}
      FROM ${oldNameQuoted}
    `);
  }

  await db.exec(`DROP TABLE ${oldNameQuoted}`);
}

async function syncSchemaToModel(db, model) {
  const desiredTables = Array.isArray(model?.tables) ? model.tables : [];
  const desiredIndexes = Array.isArray(model?.indexes) ? model.indexes : [];
  const desiredTableInfo = model?.tableInfos && typeof model.tableInfos === 'object'
    ? model.tableInfos
    : {};
  const desiredTableForeignKeys = model?.tableForeignKeys && typeof model.tableForeignKeys === 'object'
    ? model.tableForeignKeys
    : {};

  const currentTables = await db.all(`
    SELECT name, sql
    FROM sqlite_master
    WHERE type = 'table'
      AND name NOT LIKE 'sqlite_%'
    ORDER BY rowid ASC
  `);
  const currentByName = new Map(currentTables.map((table) => [table.name, table]));
  const desiredTableNameSet = new Set(desiredTables.map((table) => table.name));

  for (const table of desiredTables) {
    const tableName = String(table.name || '');
    const createSql = String(table.sql || '').trim();
    if (!tableName || !createSql) {
      continue;
    }

    if (!currentByName.has(tableName)) {
      await db.exec(createSql);
      logger.info('schema:create-table', { table: tableName });
      continue;
    }

    const currentInfo = await getTableInfo(db, tableName);
    const wantedInfo = Array.isArray(desiredTableInfo[tableName]) ? desiredTableInfo[tableName] : [];
    const currentFks = await getForeignKeyInfo(db, tableName);
    const wantedFks = Array.isArray(desiredTableForeignKeys[tableName]) ? desiredTableForeignKeys[tableName] : [];
    const shapeMatches = sameTableShape(currentInfo, wantedInfo);
    const foreignKeysMatch = sameForeignKeys(currentFks, wantedFks);
    if (!shapeMatches || !foreignKeysMatch) {
      await rebuildTable(db, tableName, createSql);
      logger.warn('schema:rebuild-table', {
        table: tableName,
        reason: !shapeMatches ? 'shape-mismatch' : 'foreign-key-mismatch'
      });
    }
  }

  for (const table of currentTables) {
    if (desiredTableNameSet.has(table.name)) {
      continue;
    }
    await db.exec(`DROP TABLE IF EXISTS ${quoteIdentifier(table.name)}`);
    logger.warn('schema:drop-table', { table: table.name });
  }

  const currentIndexes = await db.all(`
    SELECT name, tbl_name AS tableName, sql
    FROM sqlite_master
    WHERE type = 'index'
      AND name NOT LIKE 'sqlite_%'
      AND sql IS NOT NULL
    ORDER BY rowid ASC
  `);
  const desiredIndexNameSet = new Set(desiredIndexes.map((index) => index.name));

  for (const index of currentIndexes) {
    if (desiredIndexNameSet.has(index.name)) {
      continue;
    }
    await db.exec(`DROP INDEX IF EXISTS ${quoteIdentifier(index.name)}`);
    logger.warn('schema:drop-index', { index: index.name, table: index.tableName });
  }

  for (const index of desiredIndexes) {
    let sql = String(index.sql || '').trim();
    if (!sql) {
      continue;
    }
    if (/^CREATE\s+UNIQUE\s+INDEX\s+/i.test(sql)) {
      sql = sql.replace(/^CREATE\s+UNIQUE\s+INDEX\s+/i, 'CREATE UNIQUE INDEX IF NOT EXISTS ');
    } else if (/^CREATE\s+INDEX\s+/i.test(sql)) {
      sql = sql.replace(/^CREATE\s+INDEX\s+/i, 'CREATE INDEX IF NOT EXISTS ');
    }
    await db.exec(sql);
  }
}

async function exportLegacyJobLogsToFiles(db) {
  const hasJobLogsTable = await tableExists(db, 'job_logs');
  if (!hasJobLogsTable) {
    return;
  }

  const rows = await db.all(`
    SELECT job_id, source, message, timestamp
    FROM job_logs
    ORDER BY job_id ASC, id ASC
  `);
  if (!Array.isArray(rows) || rows.length === 0) {
    logger.info('legacy-job-logs:export:skip-empty');
    return;
  }

  const targetDir = getJobLogDir();
  fs.mkdirSync(targetDir, { recursive: true });
  const streams = new Map();

  try {
    for (const row of rows) {
      const jobId = Number(row?.job_id);
      if (!Number.isFinite(jobId) || jobId <= 0) {
        continue;
      }
      const key = String(Math.trunc(jobId));
      if (!streams.has(key)) {
        const filePath = path.join(targetDir, `job-${key}.process.log`);
        const stream = fs.createWriteStream(filePath, {
          flags: 'w',
          encoding: 'utf-8'
        });
        streams.set(key, stream);
      }
      const line = `[${String(row?.timestamp || '')}] [${String(row?.source || 'SYSTEM')}] ${String(row?.message || '')}\n`;
      streams.get(key).write(line);
    }
  } finally {
    await Promise.all(
      [...streams.values()].map(
        (stream) =>
          new Promise((resolve) => {
            stream.end(resolve);
          })
      )
    );
  }

  logger.warn('legacy-job-logs:exported', {
    lines: rows.length,
    jobs: streams.size,
    targetDir
  });
}

async function applySchemaModel(db, model) {
  await db.exec('PRAGMA foreign_keys = OFF;');
  await db.exec('BEGIN');
  try {
    await syncSchemaToModel(db, model);
    await db.exec('COMMIT');
  } catch (error) {
    await db.exec('ROLLBACK');
    throw error;
  } finally {
    await db.exec('PRAGMA foreign_keys = ON;');
  }
}

async function openAndPrepareDatabase() {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  logger.info('init:open', { dbPath });

  dbInstance = await open({
    filename: dbPath,
    driver: sqlite3.Database
  });

  await dbInstance.exec('PRAGMA journal_mode = WAL;');
  await dbInstance.exec('PRAGMA foreign_keys = ON;');
  const initialLogRoot = await configureRuntimeLogRootFromSettings(dbInstance, { ensure: true });
  logger.info('log-root:initialized', {
    configured: initialLogRoot.configured || null,
    resolved: initialLogRoot.resolved
  });
  await exportLegacyJobLogsToFiles(dbInstance);
  const schemaModel = await loadSchemaModel();
  await applySchemaModel(dbInstance, schemaModel);

  await seedFromSchemaFile(dbInstance);
  await syncInstallPathSettingDefaults(dbInstance);
  await migrateLegacyProfiledToolSettings(dbInstance);
  await removeDeprecatedSettings(dbInstance);
  await migrateSettingsSchemaMetadata(dbInstance);
  await ensurePipelineStateRow(dbInstance);
  const syncedLogRoot = await configureRuntimeLogRootFromSettings(dbInstance, { ensure: true });
  logger.info('log-root:synced', {
    configured: syncedLogRoot.configured || null,
    resolved: syncedLogRoot.resolved
  });
  logger.info('init:done');
  return dbInstance;
}

async function initDatabase({ allowRecovery = true } = {}) {
  if (dbInstance) {
    return dbInstance;
  }

  try {
    return await openAndPrepareDatabase();
  } catch (error) {
    logger.error('init:failed', { error: errorToMeta(error), allowRecovery });

    if (dbInstance) {
      try {
        await dbInstance.close();
      } catch (_closeError) {
        // ignore close errors during failed init
      }
      dbInstance = undefined;
    }

    if (allowRecovery && isSqliteCorruptionError(error)) {
      logger.warn('recovery:corrupt-db-detected', { dbPath });
      quarantineCorruptDatabaseFiles();
      return initDatabase({ allowRecovery: false });
    }

    throw error;
  }

}

async function seedFromSchemaFile(db) {
  const schemaSql = fs.readFileSync(schemaFilePath, 'utf-8');
  // Kommentarzeilen vor dem Split entfernen, damit der erste INSERT-Block nicht
  // mit vorangehenden Kommentaren in einem Chunk landet und durch den
  // /^INSERT\b/-Filter herausfällt.
  const strippedSql = schemaSql.replace(/^--[^\n]*$/gm, '');
  const statements = strippedSql
    .split(/;\s*\n/)
    .map((s) => s.trim())
    .filter((s) => /^INSERT\b/i.test(s));
  for (const stmt of statements) {
    await db.run(stmt);
  }
  logger.info('seed:settings', { count: statements.length });
}

async function syncInstallPathSettingDefaults(db) {
  const dataDir = path.dirname(dbPath);
  const updates = INSTALL_PATH_SETTING_DEFAULTS.map((item) => ({
    key: item.key,
    value: path.join(dataDir, ...item.pathParts),
    legacyDefaults: Array.isArray(item.legacyDefaults) ? item.legacyDefaults : []
  }));

  await db.exec('BEGIN');
  try {
    for (const update of updates) {
      const placeholders = update.legacyDefaults.map(() => '?').join(', ');

      await db.run(
        `
          UPDATE settings_schema
          SET default_value = ?, updated_at = CURRENT_TIMESTAMP
          WHERE key = ?
            AND (
              default_value IS NULL
              OR TRIM(default_value) = ''
              OR default_value IN (${placeholders})
            )
        `,
        [update.value, update.key, ...update.legacyDefaults]
      );

      await db.run(
        `
          INSERT INTO settings_values (key, value, updated_at)
          VALUES (?, ?, CURRENT_TIMESTAMP)
          ON CONFLICT(key) DO NOTHING
        `,
        [update.key, update.value]
      );

      await db.run(
        `
          UPDATE settings_values
          SET value = ?, updated_at = CURRENT_TIMESTAMP
          WHERE key = ?
            AND (
              value IS NULL
              OR TRIM(value) = ''
              OR value IN (${placeholders})
            )
        `,
        [update.value, update.key, ...update.legacyDefaults]
      );
    }
    await db.exec('COMMIT');
  } catch (error) {
    await db.exec('ROLLBACK');
    throw error;
  }

  logger.info('seed:path-defaults-synced', {
    dataDir,
    settings: updates.map((item) => ({ key: item.key, value: item.value }))
  });
}

async function readCurrentOrDefaultSettingValue(db, key) {
  if (!key) {
    return null;
  }
  return db.get(
    `
      SELECT
        s.default_value AS defaultValue,
        v.value AS currentValue,
        COALESCE(v.value, s.default_value) AS effectiveValue
      FROM settings_schema s
      LEFT JOIN settings_values v ON v.key = s.key
      WHERE s.key = ?
      LIMIT 1
    `,
    [key]
  );
}

async function migrateLegacyProfiledToolSettings(db) {
  let copiedCount = 0;
  for (const migration of LEGACY_PROFILE_SETTING_MIGRATIONS) {
    const legacyRow = await readCurrentOrDefaultSettingValue(db, migration.legacyKey);
    if (!legacyRow) {
      continue;
    }

    for (const targetKey of migration.profileKeys || []) {
      const targetRow = await readCurrentOrDefaultSettingValue(db, targetKey);
      if (!targetRow) {
        continue;
      }

      const currentValue = targetRow.currentValue;
      const defaultValue = targetRow.defaultValue;
      const shouldCopy = (
        currentValue === null
        || currentValue === undefined
        || String(currentValue) === String(defaultValue ?? '')
      );
      if (!shouldCopy) {
        continue;
      }

      await db.run(
        `
          INSERT INTO settings_values (key, value, updated_at)
          VALUES (?, ?, CURRENT_TIMESTAMP)
          ON CONFLICT(key) DO UPDATE SET
            value = excluded.value,
            updated_at = CURRENT_TIMESTAMP
        `,
        [targetKey, legacyRow.effectiveValue ?? null]
      );
      copiedCount += 1;
      logger.info('migrate:legacy-tool-setting-copied', {
        from: migration.legacyKey,
        to: targetKey
      });
    }
  }
  if (copiedCount > 0) {
    logger.info('migrate:legacy-tool-settings:done', { copiedCount });
  }
}

async function ensurePipelineStateRow(db) {
  await db.run(
    `
      INSERT INTO pipeline_state (id, state, active_job_id, progress, eta, status_text, context_json)
      VALUES (1, 'IDLE', NULL, 0, NULL, NULL, '{}')
      ON CONFLICT(id) DO NOTHING
    `
  );
}

async function removeDeprecatedSettings(db) {
  const deprecatedKeys = [
    'pushover_notify_disc_detected',
    'mediainfo_extra_args',
    'makemkv_rip_mode',
    'makemkv_analyze_extra_args',
    'makemkv_rip_extra_args',
    'handbrake_preset',
    'handbrake_extra_args',
    'output_extension',
    'filename_template',
    'output_folder_template',
    'makemkv_backup_mode'
  ];
  for (const key of deprecatedKeys) {
    const result = await db.run('DELETE FROM settings_schema WHERE key = ?', [key]);
    if (result?.changes > 0) {
      logger.info('migrate:remove-deprecated-setting', { key });
    }
  }
}

// Aktualisiert settings_schema-Metadaten (required, description, validation_json)
// für bestehende Einträge, ohne user-konfigurierte Werte in settings_values anzutasten.
const SETTINGS_SCHEMA_METADATA_UPDATES = [
  {
    key: 'handbrake_preset_bluray',
    required: 0,
    description: 'Preset Name für -Z (Blu-ray). Leer = kein Preset, nur CLI-Parameter werden verwendet.',
    validation_json: '{}'
  },
  {
    key: 'handbrake_preset_dvd',
    required: 0,
    description: 'Preset Name für -Z (DVD). Leer = kein Preset, nur CLI-Parameter werden verwendet.',
    validation_json: '{}'
  }
];

async function migrateSettingsSchemaMetadata(db) {
  for (const update of SETTINGS_SCHEMA_METADATA_UPDATES) {
    const result = await db.run(
      `UPDATE settings_schema
       SET required = ?, description = ?, validation_json = ?, updated_at = CURRENT_TIMESTAMP
       WHERE key = ? AND (required != ? OR description != ? OR validation_json != ?)`,
      [
        update.required, update.description, update.validation_json,
        update.key,
        update.required, update.description, update.validation_json
      ]
    );
    if (result?.changes > 0) {
      logger.info('migrate:settings-schema-metadata', { key: update.key });
    }
  }
}

async function getDb() {
  return initDatabase();
}

module.exports = {
  initDatabase,
  getDb
};
