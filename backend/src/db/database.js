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
    legacyKey: 'output_template',
    profileKeys: ['output_template_bluray', 'output_template_dvd']
  }
];
const INSTALL_PATH_SETTING_DEFAULTS = [
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
  await migrateOutputTemplates(dbInstance);
  await removeDeprecatedSettings(dbInstance);
  await migrateTmdbMigrationFlags(dbInstance);
  await migrateSettingsSchemaMetadata(dbInstance);
  await ensurePipelineStateRow(dbInstance);
  await backfillJobOutputFolders(dbInstance);
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

async function migrateOutputTemplates(db) {
  // Combine legacy filename_template_X + output_folder_template_X into output_template_X.
  // Only sets the new key if it has no user value yet (preserves any existing value).
  // The last "/" in the combined template separates folder from filename.
  for (const profile of ['bluray', 'dvd']) {
    const newKey = `output_template_${profile}`;
    const filenameKey = `filename_template_${profile}`;
    const folderKey = `output_folder_template_${profile}`;

    const existing = await db.get(
      `SELECT sv.value FROM settings_values sv WHERE sv.key = ? AND sv.value IS NOT NULL`,
      [newKey]
    );
    if (existing) {
      continue; // already set, don't overwrite
    }

    const filenameRow = await db.get(
      `SELECT sv.value FROM settings_values sv WHERE sv.key = ? AND sv.value IS NOT NULL`,
      [filenameKey]
    );
    const folderRow = await db.get(
      `SELECT sv.value FROM settings_values sv WHERE sv.key = ? AND sv.value IS NOT NULL`,
      [folderKey]
    );

    const filenameVal = filenameRow ? String(filenameRow.value || '').trim() : '';
    const folderVal = folderRow ? String(folderRow.value || '').trim() : '';

    if (!filenameVal) {
      continue; // nothing to migrate
    }

    const combined = folderVal ? `${folderVal}/${filenameVal}` : `${filenameVal}/${filenameVal}`;
    await db.run(
      `INSERT INTO settings_values (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`,
      [newKey, combined]
    );
    logger.info('migrate:output-template-combined', { profile, combined });
  }
}

async function removeDeprecatedSettings(db) {
  const deprecatedKeys = [
    'pushover_notify_disc_detected',
    'pushover_notify_cron_success',
    'pushover_notify_cron_error',
    'mediainfo_extra_args',
    'makemkv_rip_mode',
    'makemkv_analyze_extra_args',
    'makemkv_rip_extra_args',
    'handbrake_preset',
    'handbrake_extra_args',
    'output_extension',
    'filename_template',
    'output_folder_template',
    'makemkv_backup_mode',
    'raw_dir',
    'movie_dir',
    'raw_dir_other',
    'raw_dir_other_owner',
    'movie_dir_other',
    'movie_dir_other_owner',
    'filename_template_bluray',
    'filename_template_dvd',
    'output_folder_template_bluray',
    'output_folder_template_dvd',
    'output_extension_audiobook',
    'use_plugin_architecture',
    'use_plugin_architecture_bluray',
    'use_plugin_architecture_bluray_analyze',
    'use_plugin_architecture_bluray_rip',
    'use_plugin_architecture_bluray_review',
    'use_plugin_architecture_bluray_encode',
    'use_plugin_architecture_dvd',
    'use_plugin_architecture_dvd_analyze',
    'use_plugin_architecture_dvd_rip',
    'use_plugin_architecture_dvd_review',
    'use_plugin_architecture_dvd_encode',
    'use_plugin_architecture_cd',
    'use_plugin_architecture_cd_analyze',
    'use_plugin_architecture_cd_rip',
    'use_plugin_architecture_audiobook',
    'use_plugin_architecture_audiobook_analyze',
    'use_plugin_architecture_audiobook_encode',
    'dvd_series_plugin_enabled',
    'dvd_series_prescan_enabled',
    'dvd_series_reuse_disc_profiles',
    'musicbrainz_enabled'
  ];
  for (const key of deprecatedKeys) {
    const schemaResult = await db.run('DELETE FROM settings_schema WHERE key = ?', [key]);
    const valuesResult = await db.run('DELETE FROM settings_values WHERE key = ?', [key]);
    if (schemaResult?.changes > 0 || valuesResult?.changes > 0) {
      logger.info('migrate:remove-deprecated-setting', { key });
    }
  }

  // Reset raw_dir_cd if it still holds the old hardcoded absolute path from a prior install
  await db.run(
    `UPDATE settings_values SET value = NULL, updated_at = CURRENT_TIMESTAMP
     WHERE key = 'raw_dir_cd' AND value = '/opt/ripster/backend/data/output/cd'`
  );
}

async function migrateTmdbMigrationFlags(db) {
  // Keep this migration idempotent. It helps initialize the new migrate_tmdb flag
  // for existing rows after OMDb -> TMDb transition.
  const nullableReset = await db.run(
    `
      UPDATE jobs
      SET migrate_tmdb = 0
      WHERE migrate_tmdb IS NULL
    `
  );

  // Audio-only domains are outside TMDb migration scope.
  const nonVideoMarked = await db.run(
    `
      UPDATE jobs
      SET migrate_tmdb = 1
      WHERE COALESCE(migrate_tmdb, 0) = 0
        AND LOWER(TRIM(COALESCE(media_type, ''))) IN ('cd', 'audiobook')
    `
  );

  // Rows with obvious TMDb assignment can be marked as migrated.
  const obviousTmdbMarked = await db.run(
    `
      UPDATE jobs
      SET migrate_tmdb = 1
      WHERE COALESCE(migrate_tmdb, 0) = 0
        AND (
          makemkv_info_json LIKE '%"metadataProvider":"tmdb"%'
          OR makemkv_info_json LIKE '%"tmdbId":%'
          OR encode_plan_json LIKE '%"metadataProvider":"tmdb"%'
          OR encode_plan_json LIKE '%"tmdbId":%'
        )
    `
  );

  // Explicit OMDb footprints must stay pending for manual migration.
  const explicitOmdbPending = await db.run(
    `
      UPDATE jobs
      SET migrate_tmdb = 0
      WHERE (
        COALESCE(selected_from_omdb, 0) = 1
        OR (omdb_json IS NOT NULL AND TRIM(omdb_json) <> '')
        OR makemkv_info_json LIKE '%"metadataProvider":"omdb"%'
        OR encode_plan_json LIKE '%"metadataProvider":"omdb"%'
      )
    `
  );

  logger.info('migrate:tmdb-flag:done', {
    nullableReset: Number(nullableReset?.changes || 0),
    nonVideoMarked: Number(nonVideoMarked?.changes || 0),
    obviousTmdbMarked: Number(obviousTmdbMarked?.changes || 0),
    explicitOmdbPending: Number(explicitOmdbPending?.changes || 0)
  });
}

// Aktualisiert settings_schema-Metadaten (required, description, validation_json)
// für bestehende Einträge, ohne user-konfigurierte Werte in settings_values anzutasten.
const SETTINGS_SCHEMA_METADATA_UPDATES = [
  {
    key: 'makemkv_registration_key',
    required: 0,
    description: 'Optionaler Registrierungsschlüssel. Wird beim Speichern nach ~/.MakeMKV/settings.conf synchronisiert. Darunter kann der aktuelle Betakey per API übernommen werden.',
    validation_json: '{}'
  },
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
  },
  {
    key: 'dvd_series_language',
    required: 1,
    description: 'Bevorzugte TMDb-Sprache für Film- und Serienmetadaten (DVD/Blu-ray), z.B. de-DE oder en-US.',
    validation_json: '{"minLength":2}'
  },
  {
    key: 'dvd_series_fallback_languages',
    required: 1,
    description: 'Kommagetrennte TMDb-Fallback-Sprachen für Film- und Serienmetadaten (DVD/Blu-ray), z.B. de-DE,en-US,fr-FR.',
    validation_json: '{"minLength":2}'
  },
  {
    key: 'output_template_bluray_series_episode',
    required: 1,
    description: 'Template für einzelne Blu-ray-Serienepisoden ohne Dateiendung. Platzhalter: {seriesTitle}, {seasonNr}, {episodeNr}, {episodeTitle}, {discNr}, {year}, {language}. Optional mit führender Null: {0:seasonNr}, {0:episodeNr}.',
    validation_json: '{"minLength":1}'
  },
  {
    key: 'output_template_bluray_series_multi_episode',
    required: 1,
    description: 'Template für zusammengefasste Blu-ray-Serienepisoden ohne Dateiendung. Platzhalter: {seriesTitle}, {seasonNr}, {episodeNoStart}, {episodeNoEnd}, {episodeRange}, {episodeTitle}, {parts}, {discNr}, {year}, {language}. Optional mit führender Null: {0:seasonNr}, {0:episodeNoStart}, {0:episodeNoEnd}.',
    validation_json: '{"minLength":1}'
  },
  {
    key: 'output_template_dvd_series_episode',
    required: 1,
    description: 'Template für einzelne DVD-Serienepisoden ohne Dateiendung. Platzhalter: {seriesTitle}, {seasonNr}, {episodeNr}, {episodeTitle}, {discNr}, {year}, {language}. Optional mit führender Null: {0:seasonNr}, {0:episodeNr}.',
    validation_json: '{"minLength":1}'
  },
  {
    key: 'output_template_dvd_series_multi_episode',
    required: 1,
    description: 'Template für zusammengefasste DVD-Serienepisoden ohne Dateiendung. Platzhalter: {seriesTitle}, {seasonNr}, {episodeNoStart}, {episodeNoEnd}, {episodeRange}, {episodeTitle}, {parts}, {discNr}, {year}, {language}. Optional mit führender Null: {0:seasonNr}, {0:episodeNoStart}, {0:episodeNoEnd}.',
    validation_json: '{"minLength":1}'
  }
];

// Settings, die von einer Kategorie in eine andere verschoben werden
const SETTINGS_CATEGORY_MOVES = [
  { key: 'cd_output_template', category: 'Pfade' },
  { key: 'output_template_bluray', category: 'Pfade' },
  { key: 'output_template_bluray_series_episode', category: 'Pfade' },
  { key: 'output_template_bluray_series_multi_episode', category: 'Pfade' },
  { key: 'output_template_dvd', category: 'Pfade' },
  { key: 'output_template_audiobook', category: 'Pfade' },
  { key: 'output_chapter_template_audiobook', category: 'Pfade' },
  { key: 'audiobook_raw_template', category: 'Pfade' },
  { key: 'converter_raw_dir', category: 'Pfade' },
  { key: 'converter_movie_dir', category: 'Pfade' },
  { key: 'converter_audio_dir', category: 'Pfade' },
  { key: 'converter_output_template_video', category: 'Pfade' },
  { key: 'converter_output_template_audio', category: 'Pfade' },
  { key: 'server_console_log_output_enabled', category: 'Logging' },
  { key: 'server_console_log_http_enabled', category: 'Logging' },
  { key: 'server_console_log_debug_enabled', category: 'Logging' },
  { key: 'server_console_log_info_enabled', category: 'Logging' },
  { key: 'server_console_log_warn_enabled', category: 'Logging' },
  { key: 'server_console_log_error_enabled', category: 'Logging' }
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
  for (const move of SETTINGS_CATEGORY_MOVES) {
    const result = await db.run(
      `UPDATE settings_schema SET category = ?, updated_at = CURRENT_TIMESTAMP
       WHERE key = ? AND category != ?`,
      [move.category, move.key, move.category]
    );
    if (result?.changes > 0) {
      logger.info('migrate:settings-schema-category-moved', { key: move.key, category: move.category });
    }
  }

  const rawDirCdLabel = 'CD RAW-Ordner';
  const rawDirCdDescription = 'Basisordner für rohe CD-WAV-Dateien (cdparanoia-Output). Leer = Standardpfad (data/output/cd).';
  const rawDirCdResult = await db.run(
    `UPDATE settings_schema
     SET label = ?, description = ?, updated_at = CURRENT_TIMESTAMP
     WHERE key = 'raw_dir_cd' AND (label != ? OR description != ?)`,
    [rawDirCdLabel, rawDirCdDescription, rawDirCdLabel, rawDirCdDescription]
  );
  if (rawDirCdResult?.changes > 0) {
    logger.info('migrate:settings-schema-cd-raw-updated', {
      key: 'raw_dir_cd',
      label: rawDirCdLabel
    });
  }

  const externalStorageDescription = 'Wird links unter "Freie Speicher" angezeigt.';
  const externalStorageDescResult = await db.run(
    `UPDATE settings_schema
     SET description = ?, updated_at = CURRENT_TIMESTAMP
     WHERE key = 'external_storage_paths' AND description != ?`,
    [externalStorageDescription, externalStorageDescription]
  );
  if (externalStorageDescResult?.changes > 0) {
    logger.info('migrate:settings-schema-external-storage-description-updated', {
      key: 'external_storage_paths'
    });
  }

  const metadataReadyNotifyLabel = 'Bei manueller Auswahl senden';
  const metadataReadyNotifyDescription = 'Sendet, wenn ein Job eine manuelle Auswahl/Entscheidung benötigt (z.B. Metadaten, Titel oder Playlist).';
  const metadataReadyNotifyResult = await db.run(
    `UPDATE settings_schema
     SET label = ?, description = ?, updated_at = CURRENT_TIMESTAMP
     WHERE key = 'pushover_notify_metadata_ready' AND (label != ? OR description != ?)`,
    [
      metadataReadyNotifyLabel,
      metadataReadyNotifyDescription,
      metadataReadyNotifyLabel,
      metadataReadyNotifyDescription
    ]
  );
  if (metadataReadyNotifyResult?.changes > 0) {
    logger.info('migrate:settings-schema-metadata-ready-notify-updated', {
      key: 'pushover_notify_metadata_ready',
      label: metadataReadyNotifyLabel
    });
  }

  const metadataLanguageLabel = 'Film-Sprache';
  const metadataLanguageDescription = 'Bevorzugte TMDb-Sprache für Film- und Serienmetadaten (DVD/Blu-ray), z.B. de-DE oder en-US.';
  const metadataLanguageResult = await db.run(
    `UPDATE settings_schema
     SET label = ?, description = ?, updated_at = CURRENT_TIMESTAMP
     WHERE key = 'dvd_series_language' AND (label != ? OR description != ?)`,
    [metadataLanguageLabel, metadataLanguageDescription, metadataLanguageLabel, metadataLanguageDescription]
  );
  if (metadataLanguageResult?.changes > 0) {
    logger.info('migrate:settings-schema-language-updated', {
      key: 'dvd_series_language',
      label: metadataLanguageLabel
    });
  }

  const metadataFallbackLanguageLabel = 'Fallback Sprache';
  const metadataFallbackLanguageDescription = 'Kommagetrennte TMDb-Fallback-Sprachen für Film- und Serienmetadaten (DVD/Blu-ray), z.B. de-DE,en-US,fr-FR.';
  const metadataFallbackLanguageResult = await db.run(
    `UPDATE settings_schema
     SET label = ?, description = ?, updated_at = CURRENT_TIMESTAMP
     WHERE key = 'dvd_series_fallback_languages' AND (label != ? OR description != ?)`,
    [
      metadataFallbackLanguageLabel,
      metadataFallbackLanguageDescription,
      metadataFallbackLanguageLabel,
      metadataFallbackLanguageDescription
    ]
  );
  if (metadataFallbackLanguageResult?.changes > 0) {
    logger.info('migrate:settings-schema-fallback-language-updated', {
      key: 'dvd_series_fallback_languages',
      label: metadataFallbackLanguageLabel
    });
  }

  const dvdSeriesMultiEpisodeTemplateDefault = '{seriesTitle}/Staffel {seasonNr}/S{0:seasonNr}E{episodeRange} - {episodeTitle} (Teil {parts})';
  const legacyDvdSeriesMultiEpisodeTemplateDefaults = [
    '{seriesTitle}/Staffel {seasonNr}/S{seasonNr}E{episodeRange}'
  ];
  const legacyTemplatePlaceholders = legacyDvdSeriesMultiEpisodeTemplateDefaults.map(() => '?').join(', ');
  await db.run(
    `
      UPDATE settings_schema
      SET default_value = ?, updated_at = CURRENT_TIMESTAMP
      WHERE key = 'output_template_dvd_series_multi_episode'
        AND (
          default_value IS NULL
          OR TRIM(default_value) = ''
          OR default_value IN (${legacyTemplatePlaceholders})
        )
    `,
    [dvdSeriesMultiEpisodeTemplateDefault, ...legacyDvdSeriesMultiEpisodeTemplateDefaults]
  );
  await db.run(
    `
      INSERT INTO settings_values (key, value, updated_at)
      VALUES ('output_template_dvd_series_multi_episode', ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO NOTHING
    `,
    [dvdSeriesMultiEpisodeTemplateDefault]
  );
  await db.run(
    `
      UPDATE settings_values
      SET value = ?, updated_at = CURRENT_TIMESTAMP
      WHERE key = 'output_template_dvd_series_multi_episode'
        AND (
          value IS NULL
          OR TRIM(value) = ''
          OR value IN (${legacyTemplatePlaceholders})
        )
    `,
    [dvdSeriesMultiEpisodeTemplateDefault, ...legacyDvdSeriesMultiEpisodeTemplateDefaults]
  );

  // Migrate raw_dir_cd_owner label
  await db.run(
    `UPDATE settings_schema SET label = 'Eigentümer CD RAW-Ordner', updated_at = CURRENT_TIMESTAMP
     WHERE key = 'raw_dir_cd_owner' AND label != 'Eigentümer CD RAW-Ordner'`
  );

  // depends_on-Spalte zu settings_schema hinzufügen, bevor neue abhängige
  // Settings per INSERT OR IGNORE angelegt werden.
  {
    const cols = await db.all(`PRAGMA table_info(settings_schema)`);
    if (!cols.some((c) => c.name === 'depends_on')) {
      await db.run(`ALTER TABLE settings_schema ADD COLUMN depends_on TEXT DEFAULT NULL`);
      logger.info('migrate:settings-schema-add-depends_on');
    }
  }

  // Add movie_dir_cd if not already present
  await db.run(
    `INSERT OR IGNORE INTO settings_schema (key, category, label, type, required, description, default_value, options_json, validation_json, order_index)
     VALUES ('movie_dir_cd', 'Pfade', 'CD Output-Ordner', 'path', 0, 'Zielordner für encodierte CD-Ausgaben (FLAC, MP3 usw.). Leer = gleicher Ordner wie CD RAW-Ordner.', NULL, '[]', '{}', 114)`
  );
  await db.run(`INSERT OR IGNORE INTO settings_values (key, value) VALUES ('movie_dir_cd', NULL)`);

  // Add movie_dir_cd_owner if not already present
  await db.run(
    `INSERT OR IGNORE INTO settings_schema (key, category, label, type, required, description, default_value, options_json, validation_json, order_index)
     VALUES ('movie_dir_cd_owner', 'Pfade', 'Eigentümer CD Output-Ordner', 'string', 0, 'Eigentümer der encodierten CD-Ausgaben im Format user:gruppe. Leer = Standardbenutzer des Dienstes.', NULL, '[]', '{}', 1145)`
  );
  await db.run(`INSERT OR IGNORE INTO settings_values (key, value) VALUES ('movie_dir_cd_owner', NULL)`);

  await db.run(
    `INSERT OR IGNORE INTO settings_schema (key, category, label, type, required, description, default_value, options_json, validation_json, order_index)
     VALUES ('ffmpeg_command', 'Tools', 'FFmpeg Kommando', 'string', 1, 'Pfad oder Befehl für ffmpeg. Wird für Audiobook-Encoding genutzt.', 'ffmpeg', '[]', '{"minLength":1}', 232)`
  );
  await db.run(`INSERT OR IGNORE INTO settings_values (key, value) VALUES ('ffmpeg_command', 'ffmpeg')`);

  await db.run(
    `INSERT OR IGNORE INTO settings_schema (key, category, label, type, required, description, default_value, options_json, validation_json, order_index)
     VALUES ('mkvmerge_command', 'Tools', 'mkvmerge Kommando', 'string', 1, 'Pfad oder Befehl für mkvmerge. Wird für Multipart-Movie-Merges genutzt.', 'mkvmerge', '[]', '{"minLength":1}', 2325)`
  );
  await db.run(`INSERT OR IGNORE INTO settings_values (key, value) VALUES ('mkvmerge_command', 'mkvmerge')`);

  await db.run(
    `INSERT OR IGNORE INTO settings_schema (key, category, label, type, required, description, default_value, options_json, validation_json, order_index)
     VALUES ('ffprobe_command', 'Tools', 'FFprobe Kommando', 'string', 1, 'Pfad oder Befehl für ffprobe. Wird für Audiobook-Metadaten und Kapitel genutzt.', 'ffprobe', '[]', '{"minLength":1}', 233)`
  );
  await db.run(`INSERT OR IGNORE INTO settings_values (key, value) VALUES ('ffprobe_command', 'ffprobe')`);

  await db.run(
    `INSERT OR IGNORE INTO settings_schema (key, category, label, type, required, description, default_value, options_json, validation_json, order_index)
     VALUES ('playlist_tmdb_runtime_subtract_percent', 'Tools', 'TMDb Runtime-Abzug für Playlistfilter (%)', 'number', 1, 'Zieht optional einen Prozentwert von der TMDb-Laufzeit ab, um kürzere alternative Filmfassungen weiterhin als Playlist-Kandidaten zuzulassen. Mindesttoleranz nach unten bleibt immer 2 Minuten.', '0', '[]', '{"min":0,"max":100}', 211)`
  );
  await db.run(`INSERT OR IGNORE INTO settings_values (key, value) VALUES ('playlist_tmdb_runtime_subtract_percent', '0')`);

  await db.run(`DELETE FROM settings_values WHERE key = 'series_playall_tolerance_lower_pct'`);
  await db.run(`DELETE FROM settings_schema WHERE key = 'series_playall_tolerance_lower_pct'`);
  await db.run(`DELETE FROM settings_values WHERE key = 'series_playall_tolerance_upper_pct'`);
  await db.run(`DELETE FROM settings_schema WHERE key = 'series_playall_tolerance_upper_pct'`);

  await db.run(`DELETE FROM settings_values WHERE key = 'handbrake_pre_metadata_scan_enabled'`);
  await db.run(`DELETE FROM settings_schema WHERE key = 'handbrake_pre_metadata_scan_enabled'`);

  await db.run(
    `INSERT OR IGNORE INTO settings_schema (key, category, label, type, required, description, default_value, options_json, validation_json, order_index)
     VALUES ('server_console_log_output_enabled', 'Logging', 'Terminal-Ausgabe aktiv', 'boolean', 1, 'Master-Schalter für die Ausgabe der Server-Logs im Terminal (z.B. start.sh). Das Schreiben in Log-Dateien bleibt immer aktiv.', 'true', '[]', '{}', 150)`
  );
  await db.run(`INSERT OR IGNORE INTO settings_values (key, value) VALUES ('server_console_log_output_enabled', 'true')`);

  await db.run(
    `INSERT OR IGNORE INTO settings_schema (key, category, label, type, required, description, default_value, options_json, validation_json, order_index)
     VALUES ('server_console_log_http_enabled', 'Logging', 'HTTP-Logs im Terminal', 'boolean', 1, 'Steuert HTTP Request-Logs im Terminal (z.B. request:start). Dateilogs bleiben unverändert.', 'true', '[]', '{}', 151)`
  );
  await db.run(`INSERT OR IGNORE INTO settings_values (key, value) VALUES ('server_console_log_http_enabled', 'true')`);

  await db.run(
    `INSERT OR IGNORE INTO settings_schema (key, category, label, type, required, description, default_value, options_json, validation_json, order_index)
     VALUES ('server_console_log_debug_enabled', 'Logging', 'DEBUG im Terminal', 'boolean', 1, 'Steuert DEBUG-Meldungen in der Terminal-Ausgabe. Dateilogs bleiben unverändert.', 'true', '[]', '{}', 152)`
  );
  await db.run(`INSERT OR IGNORE INTO settings_values (key, value) VALUES ('server_console_log_debug_enabled', 'true')`);

  await db.run(
    `INSERT OR IGNORE INTO settings_schema (key, category, label, type, required, description, default_value, options_json, validation_json, order_index)
     VALUES ('server_console_log_info_enabled', 'Logging', 'INFO im Terminal', 'boolean', 1, 'Steuert INFO-Meldungen in der Terminal-Ausgabe. Dateilogs bleiben unverändert.', 'true', '[]', '{}', 153)`
  );
  await db.run(`INSERT OR IGNORE INTO settings_values (key, value) VALUES ('server_console_log_info_enabled', 'true')`);

  await db.run(
    `INSERT OR IGNORE INTO settings_schema (key, category, label, type, required, description, default_value, options_json, validation_json, order_index)
     VALUES ('server_console_log_warn_enabled', 'Logging', 'WARN im Terminal', 'boolean', 1, 'Steuert WARN-Meldungen in der Terminal-Ausgabe. Dateilogs bleiben unverändert.', 'true', '[]', '{}', 154)`
  );
  await db.run(`INSERT OR IGNORE INTO settings_values (key, value) VALUES ('server_console_log_warn_enabled', 'true')`);

  await db.run(
    `INSERT OR IGNORE INTO settings_schema (key, category, label, type, required, description, default_value, options_json, validation_json, order_index)
     VALUES ('server_console_log_error_enabled', 'Logging', 'ERROR im Terminal', 'boolean', 1, 'Steuert ERROR-Meldungen in der Terminal-Ausgabe. Dateilogs bleiben unverändert.', 'true', '[]', '{}', 155)`
  );
  await db.run(`INSERT OR IGNORE INTO settings_values (key, value) VALUES ('server_console_log_error_enabled', 'true')`);


  await db.run(
    `INSERT OR IGNORE INTO settings_schema (key, category, label, type, required, description, default_value, options_json, validation_json, order_index)
     VALUES ('output_template_audiobook', 'Pfade', 'Output Template (Audiobook)', 'string', 1, 'Template für relative Audiobook-Ausgabepfade ohne Dateiendung. Platzhalter: {author}, {title}, {year}, {narrator}, {series}, {part}, {format}. Unterordner sind über "/" möglich.', '{author}/{author} - {title} ({year})', '[]', '{"minLength":1}', 735)`
  );
  await db.run(`INSERT OR IGNORE INTO settings_values (key, value) VALUES ('output_template_audiobook', '{author}/{author} - {title} ({year})')`);

  await db.run(
    `INSERT OR IGNORE INTO settings_schema (key, category, label, type, required, description, default_value, options_json, validation_json, order_index)
     VALUES ('output_chapter_template_audiobook', 'Pfade', 'Kapitel Template (Audiobook)', 'string', 1, 'Template für kapitelweise Audiobook-Ausgaben (MP3/FLAC) ohne Dateiendung. Platzhalter: {author}, {title}, {year}, {narrator}, {series}, {part}, {format}, {chapterNr}, {chapterNo}, {chapterTitle}. Unterordner sind über "/" möglich.', '{author}/{author} - {title} ({year})/{chapterNr} {chapterTitle}', '[]', '{"minLength":1}', 7355)`
  );
  await db.run(`INSERT OR IGNORE INTO settings_values (key, value) VALUES ('output_chapter_template_audiobook', '{author}/{author} - {title} ({year})/{chapterNr} {chapterTitle}')`);

  await db.run(
    `INSERT OR IGNORE INTO settings_schema (key, category, label, type, required, description, default_value, options_json, validation_json, order_index)
     VALUES ('audiobook_raw_template', 'Pfade', 'Audiobook RAW Template', 'string', 1, 'Template für relative Audiobook-RAW-Ordner. Platzhalter: {author}, {title}, {year}, {narrator}, {series}, {part}.', '{author} - {title} ({year})', '[]', '{"minLength":1}', 736)`
  );
  await db.run(`INSERT OR IGNORE INTO settings_values (key, value) VALUES ('audiobook_raw_template', '{author} - {title} ({year})')`);

  await db.run(
    `INSERT OR IGNORE INTO settings_schema (key, category, label, type, required, description, default_value, options_json, validation_json, order_index)
     VALUES ('raw_dir_audiobook', 'Pfade', 'Audiobook RAW-Ordner', 'path', 0, 'Basisordner für hochgeladene AAX-Dateien. Leer = Standardpfad (data/output/audiobook-raw).', NULL, '[]', '{}', 105)`
  );
  await db.run(`INSERT OR IGNORE INTO settings_values (key, value) VALUES ('raw_dir_audiobook', NULL)`);

  await db.run(
    `INSERT OR IGNORE INTO settings_schema (key, category, label, type, required, description, default_value, options_json, validation_json, order_index)
     VALUES ('raw_dir_audiobook_owner', 'Pfade', 'Eigentümer Audiobook RAW-Ordner', 'string', 0, 'Eigentümer der Audiobook-RAW-Dateien im Format user:gruppe. Nur aktiv wenn ein Pfad gesetzt ist. Leer = Standardbenutzer des Dienstes.', NULL, '[]', '{}', 1055)`
  );
  await db.run(`INSERT OR IGNORE INTO settings_values (key, value) VALUES ('raw_dir_audiobook_owner', NULL)`);

  await db.run(
    `INSERT OR IGNORE INTO settings_schema (key, category, label, type, required, description, default_value, options_json, validation_json, order_index)
     VALUES ('movie_dir_audiobook', 'Pfade', 'Audiobook Output-Ordner', 'path', 0, 'Zielordner für encodierte Audiobook-Dateien. Leer = Standardpfad (data/output/audiobooks).', NULL, '[]', '{}', 115)`
  );
  await db.run(`INSERT OR IGNORE INTO settings_values (key, value) VALUES ('movie_dir_audiobook', NULL)`);

  await db.run(
    `INSERT OR IGNORE INTO settings_schema (key, category, label, type, required, description, default_value, options_json, validation_json, order_index)
     VALUES ('movie_dir_audiobook_owner', 'Pfade', 'Eigentümer Audiobook Output-Ordner', 'string', 0, 'Eigentümer der encodierten Audiobook-Dateien im Format user:gruppe. Leer = Standardbenutzer des Dienstes.', NULL, '[]', '{}', 1155)`
  );
  await db.run(`INSERT OR IGNORE INTO settings_values (key, value) VALUES ('movie_dir_audiobook_owner', NULL)`);

  await db.run(
    `INSERT OR IGNORE INTO settings_schema (key, category, label, type, required, description, default_value, options_json, validation_json, order_index)
     VALUES ('raw_dir_bluray_series', 'Pfade', 'RAW-Ordner (Blu-ray Serie)', 'path', 0, 'RAW-Zielpfad für Blu-ray-Serien. Leer = gleicher Pfad wie RAW-Ordner (Blu-ray).', NULL, '[]', '{}', 1011)`
  );
  await db.run(`INSERT OR IGNORE INTO settings_values (key, value) VALUES ('raw_dir_bluray_series', NULL)`);

  await db.run(
    `INSERT OR IGNORE INTO settings_schema (key, category, label, type, required, description, default_value, options_json, validation_json, order_index)
     VALUES ('raw_dir_bluray_series_owner', 'Pfade', 'Eigentümer RAW-Ordner (Blu-ray Serie)', 'string', 0, 'Eigentümer der Dateien im Format user:gruppe für Blu-ray-Serien-RAW. Leer = Eigentümer Raw-Ordner (Blu-ray).', NULL, '[]', '{}', 1012)`
  );
  await db.run(`INSERT OR IGNORE INTO settings_values (key, value) VALUES ('raw_dir_bluray_series_owner', NULL)`);

  await db.run(
    `INSERT OR IGNORE INTO settings_schema (key, category, label, type, required, description, default_value, options_json, validation_json, order_index)
     VALUES ('raw_dir_dvd_series', 'Pfade', 'RAW-Ordner (DVD Serie)', 'path', 0, 'RAW-Zielpfad für DVD-Serien. Leer = gleicher Pfad wie RAW-Ordner (DVD).', NULL, '[]', '{}', 1021)`
  );
  await db.run(`INSERT OR IGNORE INTO settings_values (key, value) VALUES ('raw_dir_dvd_series', NULL)`);

  await db.run(
    `INSERT OR IGNORE INTO settings_schema (key, category, label, type, required, description, default_value, options_json, validation_json, order_index)
     VALUES ('raw_dir_dvd_series_owner', 'Pfade', 'Eigentümer RAW-Ordner (DVD Serie)', 'string', 0, 'Eigentümer der Dateien im Format user:gruppe für DVD-Serien-RAW. Leer = Eigentümer Raw-Ordner (DVD).', NULL, '[]', '{}', 1022)`
  );
  await db.run(`INSERT OR IGNORE INTO settings_values (key, value) VALUES ('raw_dir_dvd_series_owner', NULL)`);

  await db.run(
    `INSERT OR IGNORE INTO settings_schema (key, category, label, type, required, description, default_value, options_json, validation_json, order_index)
     VALUES ('series_dir_bluray', 'Pfade', 'Serien-Ordner (Blu-ray)', 'path', 0, 'Zielordner für Blu-ray-Serienfolgen. Leer = Standardpfad (data/output/series).', NULL, '[]', '{}', 110)`
  );
  await db.run(`INSERT OR IGNORE INTO settings_values (key, value) VALUES ('series_dir_bluray', NULL)`);

  await db.run(
    `INSERT OR IGNORE INTO settings_schema (key, category, label, type, required, description, default_value, options_json, validation_json, order_index)
     VALUES ('series_dir_bluray_owner', 'Pfade', 'Eigentümer Serien-Ordner (Blu-ray)', 'string', 0, 'Eigentümer der Blu-ray-Serienausgaben im Format user:gruppe. Leer = Standardbenutzer des Dienstes.', NULL, '[]', '{}', 1105)`
  );
  await db.run(`INSERT OR IGNORE INTO settings_values (key, value) VALUES ('series_dir_bluray_owner', NULL)`);

  await db.run(
    `INSERT OR IGNORE INTO settings_schema (key, category, label, type, required, description, default_value, options_json, validation_json, order_index)
     VALUES ('series_dir_dvd', 'Pfade', 'Serien-Ordner (DVD)', 'path', 0, 'Zielordner für DVD-Serienfolgen. Leer = Standardpfad (data/output/series).', NULL, '[]', '{}', 113)`
  );
  await db.run(`INSERT OR IGNORE INTO settings_values (key, value) VALUES ('series_dir_dvd', NULL)`);

  await db.run(
    `INSERT OR IGNORE INTO settings_schema (key, category, label, type, required, description, default_value, options_json, validation_json, order_index)
     VALUES ('series_dir_dvd_owner', 'Pfade', 'Eigentümer Serien-Ordner (DVD)', 'string', 0, 'Eigentümer der DVD-Serienausgaben im Format user:gruppe. Leer = Standardbenutzer des Dienstes.', NULL, '[]', '{}', 1135)`
  );
  await db.run(`INSERT OR IGNORE INTO settings_values (key, value) VALUES ('series_dir_dvd_owner', NULL)`);

  await db.run(
    `INSERT OR IGNORE INTO settings_schema (key, category, label, type, required, description, default_value, options_json, validation_json, order_index)
     VALUES ('output_template_bluray_series_episode', 'Pfade', 'Output Template (Blu-ray Serie, Episode)', 'string', 1, 'Template für einzelne Blu-ray-Serienepisoden ohne Dateiendung. Platzhalter: {seriesTitle}, {seasonNr}, {episodeNr}, {episodeTitle}, {discNr}, {year}, {language}. Optional mit führender Null: {0:seasonNr}, {0:episodeNr}.', '{seriesTitle}/Staffel {seasonNr}/S{seasonNr}E{episodeNr} - {episodeTitle}', '[]', '{"minLength":1}', 336)`
  );
  await db.run(`INSERT OR IGNORE INTO settings_values (key, value) VALUES ('output_template_bluray_series_episode', '{seriesTitle}/Staffel {seasonNr}/S{seasonNr}E{episodeNr} - {episodeTitle}')`);

  await db.run(
    `INSERT OR IGNORE INTO settings_schema (key, category, label, type, required, description, default_value, options_json, validation_json, order_index)
     VALUES ('output_template_bluray_series_multi_episode', 'Pfade', 'Output Template (Blu-ray Serie, Multi-Episode)', 'string', 1, 'Template für zusammengefasste Blu-ray-Serienepisoden ohne Dateiendung. Platzhalter: {seriesTitle}, {seasonNr}, {episodeNoStart}, {episodeNoEnd}, {episodeRange}, {episodeTitle}, {parts}, {discNr}, {year}, {language}. Optional mit führender Null: {0:seasonNr}, {0:episodeNoStart}, {0:episodeNoEnd}.', '{seriesTitle}/Staffel {seasonNr}/S{0:seasonNr}E{episodeRange} - {episodeTitle} (Teil {parts})', '[]', '{"minLength":1}', 337)`
  );
  await db.run(`INSERT OR IGNORE INTO settings_values (key, value) VALUES ('output_template_bluray_series_multi_episode', '{seriesTitle}/Staffel {seasonNr}/S{0:seasonNr}E{episodeRange} - {episodeTitle} (Teil {parts})')`);

  await db.run(
    `INSERT OR IGNORE INTO settings_schema (key, category, label, type, required, description, default_value, options_json, validation_json, order_index)
     VALUES ('output_template_dvd_series_episode', 'Pfade', 'Output Template (DVD Serie, Episode)', 'string', 1, 'Template für einzelne DVD-Serienepisoden ohne Dateiendung. Platzhalter: {seriesTitle}, {seasonNr}, {episodeNr}, {episodeTitle}, {discNr}, {year}, {language}. Optional mit führender Null: {0:seasonNr}, {0:episodeNr}.', '{seriesTitle}/Staffel {seasonNr}/S{seasonNr}E{episodeNr} - {episodeTitle}', '[]', '{"minLength":1}', 536)`
  );
  await db.run(`INSERT OR IGNORE INTO settings_values (key, value) VALUES ('output_template_dvd_series_episode', '{seriesTitle}/Staffel {seasonNr}/S{seasonNr}E{episodeNr} - {episodeTitle}')`);

  await db.run(
    `INSERT OR IGNORE INTO settings_schema (key, category, label, type, required, description, default_value, options_json, validation_json, order_index)
     VALUES ('output_template_dvd_series_multi_episode', 'Pfade', 'Output Template (DVD Serie, Multi-Episode)', 'string', 1, 'Template für zusammengefasste DVD-Serienepisoden ohne Dateiendung. Platzhalter: {seriesTitle}, {seasonNr}, {episodeNoStart}, {episodeNoEnd}, {episodeRange}, {episodeTitle}, {parts}, {discNr}, {year}, {language}. Optional mit führender Null: {0:seasonNr}, {0:episodeNoStart}, {0:episodeNoEnd}.', '{seriesTitle}/Staffel {seasonNr}/S{0:seasonNr}E{episodeRange} - {episodeTitle} (Teil {parts})', '[]', '{"minLength":1}', 537)`
  );
  await db.run(`INSERT OR IGNORE INTO settings_values (key, value) VALUES ('output_template_dvd_series_multi_episode', '{seriesTitle}/Staffel {seasonNr}/S{0:seasonNr}E{episodeRange} - {episodeTitle} (Teil {parts})')`);

  await db.run(
    `INSERT OR IGNORE INTO settings_schema (key, category, label, type, required, description, default_value, options_json, validation_json, order_index)
     VALUES ('tmdb_api_read_access_token', 'Metadaten', 'TMDb Read Access Token', 'string', 0, 'Read Access Token für Serien-Metadaten über TheMovieDB (TMDb).', NULL, '[]', '{}', 401)`
  );
  await db.run(`INSERT OR IGNORE INTO settings_values (key, value) VALUES ('tmdb_api_read_access_token', NULL)`);

  await db.run(
    `INSERT OR IGNORE INTO settings_schema (key, category, label, type, required, description, default_value, options_json, validation_json, order_index)
     VALUES ('dvd_series_language', 'Metadaten', 'Film-Sprache', 'string', 1, 'Bevorzugte TMDb-Sprache für Film- und Serienmetadaten (DVD/Blu-ray), z.B. de-DE oder en-US.', 'de-DE', '[]', '{"minLength":2}', 403)`
  );
  await db.run(`INSERT OR IGNORE INTO settings_values (key, value) VALUES ('dvd_series_language', 'de-DE')`);

  await db.run(
    `INSERT OR IGNORE INTO settings_schema (key, category, label, type, required, description, default_value, options_json, validation_json, order_index)
     VALUES ('dvd_series_fallback_languages', 'Metadaten', 'Fallback Sprache', 'string', 1, 'Kommagetrennte TMDb-Fallback-Sprachen für Film- und Serienmetadaten (DVD/Blu-ray), z.B. de-DE,en-US,fr-FR.', 'de-DE,en-US', '[]', '{"minLength":2}', 404)`
  );
  await db.run(`INSERT OR IGNORE INTO settings_values (key, value) VALUES ('dvd_series_fallback_languages', 'de-DE,en-US')`);

  await db.run(`DELETE FROM settings_values WHERE key IN ('tvdb_api_key', 'tvdb_subscriber_pin')`);
  await db.run(`DELETE FROM settings_schema WHERE key IN ('tvdb_api_key', 'tvdb_subscriber_pin')`);
  await db.run(`DELETE FROM settings_values WHERE key = 'dvd_series_order_preference'`);
  await db.run(`DELETE FROM settings_schema WHERE key = 'dvd_series_order_preference'`);

  // Converter-Pfade und Eigentümer
  await db.run(
    `INSERT OR IGNORE INTO settings_schema (key, category, label, type, required, description, default_value, options_json, validation_json, order_index)
     VALUES ('converter_raw_dir', 'Pfade', 'Converter RAW-Ordner', 'path', 0, 'Quellordner für Converter-Eingabedateien. Leer = Standardpfad.', NULL, '[]', '{}', 106)`
  );
  await db.run(`INSERT OR IGNORE INTO settings_values (key, value) VALUES ('converter_raw_dir', NULL)`);

  await db.run(
    `INSERT OR IGNORE INTO settings_schema (key, category, label, type, required, description, default_value, options_json, validation_json, order_index)
     VALUES ('converter_movie_dir', 'Pfade', 'Converter Video Output-Ordner', 'path', 0, 'Zielordner für konvertierte Video-Dateien. Leer = Standardpfad.', NULL, '[]', '{}', 116)`
  );
  await db.run(`INSERT OR IGNORE INTO settings_values (key, value) VALUES ('converter_movie_dir', NULL)`);

  await db.run(
    `INSERT OR IGNORE INTO settings_schema (key, category, label, type, required, description, default_value, options_json, validation_json, order_index)
     VALUES ('converter_audio_dir', 'Pfade', 'Converter Audio Output-Ordner', 'path', 0, 'Zielordner für konvertierte Audio-Dateien. Leer = Standardpfad.', NULL, '[]', '{}', 117)`
  );
  await db.run(`INSERT OR IGNORE INTO settings_values (key, value) VALUES ('converter_audio_dir', NULL)`);

  await db.run(
    `INSERT OR IGNORE INTO settings_schema (key, category, label, type, required, description, default_value, options_json, validation_json, order_index)
     VALUES ('converter_output_template_video', 'Pfade', 'Converter Video Output-Template', 'string', 0, 'Template für Video-Ausgabedateinamen, z.B. {title}. Leer = Titel des Jobs.', NULL, '[]', '{}', 738)`
  );
  await db.run(`INSERT OR IGNORE INTO settings_values (key, value) VALUES ('converter_output_template_video', NULL)`);

  await db.run(
    `INSERT OR IGNORE INTO settings_schema (key, category, label, type, required, description, default_value, options_json, validation_json, order_index)
     VALUES ('converter_output_template_audio', 'Pfade', 'Converter Audio Output-Template', 'string', 0, 'Template für Audio-Ausgabedateinamen, z.B. {artist} - {title}. Leer = Titel des Jobs.', NULL, '[]', '{}', 739)`
  );
  await db.run(`INSERT OR IGNORE INTO settings_values (key, value) VALUES ('converter_output_template_audio', NULL)`);

  await db.run(
    `INSERT OR IGNORE INTO settings_schema (key, category, label, type, required, description, default_value, options_json, validation_json, order_index)
     VALUES ('converter_raw_dir_owner', 'Pfade', 'Eigentümer Converter RAW-Ordner', 'string', 0, 'Eigentümer der Converter-Eingabedateien im Format user:gruppe. Leer = Standardbenutzer des Dienstes.', NULL, '[]', '{}', 1065)`
  );
  await db.run(`INSERT OR IGNORE INTO settings_values (key, value) VALUES ('converter_raw_dir_owner', NULL)`);

  await db.run(
    `INSERT OR IGNORE INTO settings_schema (key, category, label, type, required, description, default_value, options_json, validation_json, order_index)
     VALUES ('converter_movie_dir_owner', 'Pfade', 'Eigentümer Converter Video Output-Ordner', 'string', 0, 'Eigentümer der konvertierten Video-Dateien im Format user:gruppe. Leer = Standardbenutzer des Dienstes.', NULL, '[]', '{}', 1165)`
  );
  await db.run(`INSERT OR IGNORE INTO settings_values (key, value) VALUES ('converter_movie_dir_owner', NULL)`);

  await db.run(
    `INSERT OR IGNORE INTO settings_schema (key, category, label, type, required, description, default_value, options_json, validation_json, order_index)
     VALUES ('converter_audio_dir_owner', 'Pfade', 'Eigentümer Converter Audio Output-Ordner', 'string', 0, 'Eigentümer der konvertierten Audio-Dateien im Format user:gruppe. Leer = Standardbenutzer des Dienstes.', NULL, '[]', '{}', 1166)`
  );
  await db.run(`INSERT OR IGNORE INTO settings_values (key, value) VALUES ('converter_audio_dir_owner', NULL)`);

  await db.run(
    `INSERT OR IGNORE INTO settings_schema (key, category, label, type, required, description, default_value, options_json, validation_json, order_index)
     VALUES ('download_dir', 'Pfade', 'Download ZIP-Ordner', 'path', 0, 'Zielordner für vorbereitete ZIP-Downloads. Leer = Standardpfad (data/downloads).', NULL, '[]', '{}', 118)`
  );
  await db.run(`INSERT OR IGNORE INTO settings_values (key, value) VALUES ('download_dir', NULL)`);

  await db.run(
    `INSERT OR IGNORE INTO settings_schema (key, category, label, type, required, description, default_value, options_json, validation_json, order_index)
     VALUES ('download_dir_owner', 'Pfade', 'Eigentümer Download ZIP-Ordner', 'string', 0, 'Eigentümer der vorbereiteten ZIP-Dateien im Format user:gruppe. Leer = Standardbenutzer des Dienstes.', NULL, '[]', '{}', 1185)`
  );
  await db.run(`INSERT OR IGNORE INTO settings_values (key, value) VALUES ('download_dir_owner', NULL)`);

  await db.run(
    `INSERT OR IGNORE INTO settings_schema (key, category, label, type, required, description, default_value, options_json, validation_json, order_index)
     VALUES ('external_storage_paths', 'Pfade', 'Externe Speicher', 'path', 0, 'Wird links unter "Freie Speicher" angezeigt.', '[]', '[]', '{}', 119)`
  );
  await db.run(`INSERT OR IGNORE INTO settings_values (key, value) VALUES ('external_storage_paths', '[]')`);

  await db.run(
    `INSERT OR IGNORE INTO settings_schema (key, category, label, type, required, description, default_value, options_json, validation_json, order_index)
     VALUES ('drive_devices', 'Laufwerk', 'Explizite Laufwerke', 'path', 0, 'Laufwerke für den expliziten Modus als JSON-Array mit Pfad und MakeMKV-Index, z.B. [{\"path\":\"/dev/sr0\",\"makemkvIndex\":0},{\"path\":\"/dev/sr1\",\"makemkvIndex\":1}]. Nur relevant wenn Modus = Explizites Device.', '[]', '[]', '{}', 15)`
  );
  await db.run(`INSERT OR IGNORE INTO settings_values (key, value) VALUES ('drive_devices', '[]')`);

  await db.run(
    `INSERT OR IGNORE INTO settings_schema (key, category, label, type, required, description, default_value, options_json, validation_json, order_index)
     VALUES ('auto_eject_after_rip', 'Laufwerk', 'Laufwerk nach Rip auswerfen', 'boolean', 1, 'Wenn aktiv, wird das Laufwerk nach erfolgreichem Abschluss eines Rip-Vorgangs automatisch ausgeworfen (eject).', 'false', '[]', '{}', 45)`
  );
  await db.run(`INSERT OR IGNORE INTO settings_values (key, value) VALUES ('auto_eject_after_rip', 'false')`);

  await db.run(
    `INSERT OR IGNORE INTO settings_schema (key, category, label, type, required, description, default_value, options_json, validation_json, order_index)
     VALUES ('coverart_recovery_enabled', 'Metadaten', 'Coverart-Nachladen aktiv', 'boolean', 1, 'Wenn aktiv, werden fehlende Coverarts automatisch in Intervallen geprüft und nachgeladen.', 'true', '[]', '{}', 430)`
  );
  await db.run(`INSERT OR IGNORE INTO settings_values (key, value) VALUES ('coverart_recovery_enabled', 'true')`);

  await db.run(
    `INSERT OR IGNORE INTO settings_schema (key, category, label, type, required, description, default_value, options_json, validation_json, order_index)
     VALUES ('coverart_recovery_interval_hours', 'Metadaten', 'Coverart-Prüfintervall (Stunden)', 'number', 1, 'Intervall für automatische Prüfung fehlender Coverarts in Stunden.', '6', '[]', '{"min":1,"max":168}', 431)`
  );
  await db.run(`INSERT OR IGNORE INTO settings_values (key, value) VALUES ('coverart_recovery_interval_hours', '6')`);

  await db.run(
    `INSERT OR IGNORE INTO settings_schema (key, category, label, type, required, description, default_value, options_json, validation_json, order_index)
     VALUES ('generate_nfo_after_encode', 'Metadaten', 'NFO nach Encode erzeugen', 'boolean', 1, 'Erstellt nach erfolgreichem Encode automatisch eine .nfo-Datei neben der Ausgabedatei.', 'false', '[]', '{}', 432)`
  );
  await db.run(`INSERT OR IGNORE INTO settings_values (key, value) VALUES ('generate_nfo_after_encode', 'false')`);

  await db.run(`
    CREATE TABLE IF NOT EXISTS user_prefs (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await db.run(`
    CREATE TABLE IF NOT EXISTS dvd_series_disc_profiles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL DEFAULT 'tmdb',
      provider_series_id TEXT,
      provider_series_name TEXT,
      season_number INTEGER,
      season_type TEXT NOT NULL DEFAULT 'dvd',
      disc_label TEXT,
      disc_serial TEXT,
      disc_number INTEGER,
      language TEXT,
      disc_signature TEXT NOT NULL,
      fingerprint_json TEXT,
      episode_map_json TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_dvd_series_disc_profiles_signature ON dvd_series_disc_profiles(disc_signature)`);
  await db.run(`CREATE INDEX IF NOT EXISTS idx_dvd_series_disc_profiles_series ON dvd_series_disc_profiles(provider, provider_series_id, season_number)`);
  await db.run(`UPDATE dvd_series_disc_profiles SET provider = 'tmdb' WHERE provider = 'tvdb'`);

  await db.run(`
    CREATE TABLE IF NOT EXISTS dvd_series_title_mappings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      parent_job_id INTEGER NOT NULL,
      disc_profile_id INTEGER,
      title_index INTEGER NOT NULL,
      title_kind TEXT NOT NULL,
      confidence REAL NOT NULL DEFAULT 0,
      selected INTEGER NOT NULL DEFAULT 1,
      provider TEXT NOT NULL DEFAULT 'tmdb',
      provider_series_id TEXT,
      season_number INTEGER,
      episode_start INTEGER,
      episode_end INTEGER,
      episode_ids_json TEXT,
      mapping_json TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (parent_job_id) REFERENCES jobs(id) ON DELETE CASCADE,
      FOREIGN KEY (disc_profile_id) REFERENCES dvd_series_disc_profiles(id) ON DELETE SET NULL
    )
  `);
  await db.run(`CREATE INDEX IF NOT EXISTS idx_dvd_series_title_mappings_parent_job ON dvd_series_title_mappings(parent_job_id, title_index)`);
  await db.run(`CREATE INDEX IF NOT EXISTS idx_dvd_series_title_mappings_series ON dvd_series_title_mappings(provider, provider_series_id, season_number)`);
  await db.run(`UPDATE dvd_series_title_mappings SET provider = 'tmdb' WHERE provider = 'tvdb'`);
}

async function backfillJobOutputFolders(db) {
  // Remove duplicate (job_id, output_path) rows before unique index is enforced.
  await db.run(`
    DELETE FROM job_output_folders
    WHERE id NOT IN (
      SELECT MIN(id) FROM job_output_folders GROUP BY job_id, output_path
    )
  `);

  // Populate job_output_folders from jobs.output_path for pre-feature jobs.
  // Only inserts rows where no entry exists for the job yet.
  const rows = await db.all(`
    SELECT j.id AS job_id, j.output_path
    FROM jobs j
    WHERE j.output_path IS NOT NULL
      AND j.output_path != ''
      AND NOT EXISTS (
        SELECT 1 FROM job_output_folders f WHERE f.job_id = j.id
      )
  `);
  if (!Array.isArray(rows) || rows.length === 0) return;
  let inserted = 0;
  for (const row of rows) {
    try {
      await db.run(
        'INSERT OR IGNORE INTO job_output_folders (job_id, output_path) VALUES (?, ?)',
        [row.job_id, row.output_path]
      );
      inserted += 1;
    } catch (err) {
      logger.warn('backfill:job-output-folders:insert-failed', { jobId: row.job_id, error: err?.message });
    }
  }
  if (inserted > 0) {
    logger.info('backfill:job-output-folders:done', { inserted });
  }
}

async function getDb() {
  return initDatabase();
}

module.exports = {
  initDatabase,
  getDb
};
