const { getDb } = require('../db/database');
const logger = require('./logger').child('HISTORY');
const fs = require('fs');
const path = require('path');
const settingsService = require('./settingsService');
const omdbService = require('./omdbService');
const { getJobLogDir } = require('./logPathService');

function parseJsonSafe(raw, fallback = null) {
  if (!raw) {
    return fallback;
  }

  try {
    return JSON.parse(raw);
  } catch (error) {
    return fallback;
  }
}

const PROCESS_LOG_TAIL_MAX_BYTES = 1024 * 1024;
const processLogStreams = new Map();

function inspectDirectory(dirPath) {
  if (!dirPath) {
    return {
      path: null,
      exists: false,
      isDirectory: false,
      isEmpty: null,
      entryCount: null
    };
  }

  try {
    const stat = fs.statSync(dirPath);
    if (!stat.isDirectory()) {
      return {
        path: dirPath,
        exists: true,
        isDirectory: false,
        isEmpty: null,
        entryCount: null
      };
    }

    const entries = fs.readdirSync(dirPath);
    return {
      path: dirPath,
      exists: true,
      isDirectory: true,
      isEmpty: entries.length === 0,
      entryCount: entries.length
    };
  } catch (error) {
    return {
      path: dirPath,
      exists: false,
      isDirectory: false,
      isEmpty: null,
      entryCount: null
    };
  }
}

function inspectOutputFile(filePath) {
  if (!filePath) {
    return {
      path: null,
      exists: false,
      isFile: false,
      sizeBytes: null
    };
  }

  try {
    const stat = fs.statSync(filePath);
    return {
      path: filePath,
      exists: true,
      isFile: stat.isFile(),
      sizeBytes: stat.size
    };
  } catch (error) {
    return {
      path: filePath,
      exists: false,
      isFile: false,
      sizeBytes: null
    };
  }
}

function parseInfoFromValue(value, fallback = null) {
  if (!value) {
    return fallback;
  }
  if (typeof value === 'object') {
    return value;
  }
  return parseJsonSafe(value, fallback);
}

function hasBlurayStructure(rawPath) {
  const basePath = String(rawPath || '').trim();
  if (!basePath) {
    return false;
  }

  const bdmvPath = path.join(basePath, 'BDMV');
  const streamPath = path.join(bdmvPath, 'STREAM');

  try {
    if (fs.existsSync(streamPath)) {
      const streamStat = fs.statSync(streamPath);
      if (streamStat.isDirectory()) {
        return true;
      }
    }
  } catch (_error) {
    // ignore fs errors and continue with fallback checks
  }

  try {
    if (fs.existsSync(bdmvPath)) {
      const bdmvStat = fs.statSync(bdmvPath);
      if (bdmvStat.isDirectory()) {
        return true;
      }
    }
  } catch (_error) {
    // ignore fs errors
  }

  return false;
}

function inferMediaType(job, makemkvInfo, mediainfoInfo, encodePlan) {
  const mkInfo = parseInfoFromValue(makemkvInfo, null);
  const miInfo = parseInfoFromValue(mediainfoInfo, null);
  const plan = parseInfoFromValue(encodePlan, null);
  const rawPath = String(job?.raw_path || '').trim();
  const encodeInputPath = String(job?.encode_input_path || plan?.encodeInputPath || '').trim();

  if (hasBlurayStructure(rawPath)) {
    return 'bluray';
  }

  const mkSource = String(mkInfo?.source || '').trim().toLowerCase();
  const mkRipMode = String(mkInfo?.ripMode || mkInfo?.rip_mode || '').trim().toLowerCase();
  if (
    mkRipMode === 'backup'
    || mkSource.includes('backup')
    || mkSource.includes('raw_backup')
    || Boolean(mkInfo?.analyzeContext?.playlistAnalysis)
  ) {
    return 'bluray';
  }

  const planMode = String(plan?.mode || '').trim().toLowerCase();
  if (planMode === 'pre_rip' || Boolean(plan?.preRip)) {
    return 'bluray';
  }

  const mediainfoSource = String(miInfo?.source || '').trim().toLowerCase();
  if (mediainfoSource.includes('raw_backup') || Number(miInfo?.handbrakeTitleId) > 0) {
    return 'bluray';
  }

  if (
    /(^|\/)bdmv(\/|$)/i.test(rawPath)
    || /(^|\/)bdmv(\/|$)/i.test(encodeInputPath)
    || /\.m2ts(\.|$)/i.test(encodeInputPath)
  ) {
    return 'bluray';
  }

  return 'disc';
}

function toProcessLogPath(jobId) {
  const normalizedId = Number(jobId);
  if (!Number.isFinite(normalizedId) || normalizedId <= 0) {
    return null;
  }
  return path.join(getJobLogDir(), `job-${Math.trunc(normalizedId)}.process.log`);
}

function hasProcessLogFile(jobId) {
  const filePath = toProcessLogPath(jobId);
  return Boolean(filePath && fs.existsSync(filePath));
}

function toProcessLogStreamKey(jobId) {
  const normalizedId = Number(jobId);
  if (!Number.isFinite(normalizedId) || normalizedId <= 0) {
    return null;
  }
  return String(Math.trunc(normalizedId));
}

function enrichJobRow(job) {
  const rawStatus = inspectDirectory(job.raw_path);
  const outputStatus = inspectOutputFile(job.output_path);
  const movieDir = job.output_path ? path.dirname(job.output_path) : null;
  const movieDirStatus = inspectDirectory(movieDir);
  const makemkvInfo = parseJsonSafe(job.makemkv_info_json, null);
  const handbrakeInfo = parseJsonSafe(job.handbrake_info_json, null);
  const mediainfoInfo = parseJsonSafe(job.mediainfo_info_json, null);
  const omdbInfo = parseJsonSafe(job.omdb_json, null);
  const encodePlan = parseJsonSafe(job.encode_plan_json, null);
  const mediaType = inferMediaType(job, makemkvInfo, mediainfoInfo, encodePlan);
  const backupSuccess = String(makemkvInfo?.status || '').trim().toUpperCase() === 'SUCCESS';
  const encodeSuccess = String(handbrakeInfo?.status || '').trim().toUpperCase() === 'SUCCESS';

  return {
    ...job,
    makemkvInfo,
    handbrakeInfo,
    mediainfoInfo,
    omdbInfo,
    encodePlan,
    mediaType,
    backupSuccess,
    encodeSuccess,
    rawStatus,
    outputStatus,
    movieDirStatus
  };
}

function resolveSafe(inputPath) {
  return path.resolve(String(inputPath || ''));
}

function isPathInside(basePath, candidatePath) {
  if (!basePath || !candidatePath) {
    return false;
  }

  const base = resolveSafe(basePath);
  const candidate = resolveSafe(candidatePath);
  return candidate === base || candidate.startsWith(`${base}${path.sep}`);
}

function normalizeComparablePath(inputPath) {
  return resolveSafe(String(inputPath || '')).replace(/[\\/]+$/, '');
}

function parseRawFolderMetadata(folderName) {
  const rawName = String(folderName || '').trim();
  const folderJobIdMatch = rawName.match(/-\s*RAW\s*-\s*job-(\d+)\s*$/i);
  const folderJobId = folderJobIdMatch ? Number(folderJobIdMatch[1]) : null;
  let working = rawName.replace(/\s*-\s*RAW\s*-\s*job-\d+\s*$/i, '').trim();

  const imdbMatch = working.match(/\[(tt\d{6,12})\]/i);
  const imdbId = imdbMatch ? String(imdbMatch[1] || '').toLowerCase() : null;
  if (imdbMatch) {
    working = working.replace(imdbMatch[0], '').trim();
  }

  const yearMatch = working.match(/\((19|20)\d{2}\)/);
  const year = yearMatch ? Number(String(yearMatch[0]).replace(/[()]/g, '')) : null;
  if (yearMatch) {
    working = working.replace(yearMatch[0], '').trim();
  }

  const title = working.replace(/\s{2,}/g, ' ').trim() || null;

  return {
    title,
    year: Number.isFinite(year) ? year : null,
    imdbId,
    folderJobId: Number.isFinite(folderJobId) ? Math.trunc(folderJobId) : null
  };
}

function buildRawPathForJobId(rawPath, jobId) {
  const normalizedJobId = Number(jobId);
  if (!Number.isFinite(normalizedJobId) || normalizedJobId <= 0) {
    return rawPath;
  }

  const absRawPath = normalizeComparablePath(rawPath);
  const folderName = path.basename(absRawPath);
  const replaced = folderName.replace(/(\s-\sRAW\s-\sjob-)\d+\s*$/i, `$1${Math.trunc(normalizedJobId)}`);
  if (replaced === folderName) {
    return absRawPath;
  }
  return path.join(path.dirname(absRawPath), replaced);
}

function deleteFilesRecursively(rootPath, keepRoot = true) {
  const result = {
    filesDeleted: 0,
    dirsRemoved: 0
  };

  const visit = (current, isRoot = false) => {
    if (!fs.existsSync(current)) {
      return;
    }

    const stat = fs.lstatSync(current);
    if (stat.isDirectory()) {
      const entries = fs.readdirSync(current, { withFileTypes: true });
      for (const entry of entries) {
        const abs = path.join(current, entry.name);
        if (entry.isDirectory()) {
          visit(abs, false);
        } else {
          fs.unlinkSync(abs);
          result.filesDeleted += 1;
        }
      }

      const remaining = fs.readdirSync(current);
      if (remaining.length === 0 && (!isRoot || !keepRoot)) {
        fs.rmdirSync(current);
        result.dirsRemoved += 1;
      }
      return;
    }

    fs.unlinkSync(current);
    result.filesDeleted += 1;
  };

  visit(rootPath, true);
  return result;
}

class HistoryService {
  async createJob({ discDevice = null, status = 'ANALYZING', detectedTitle = null }) {
    const db = await getDb();
    const startTime = new Date().toISOString();

    const result = await db.run(
      `
        INSERT INTO jobs (disc_device, status, start_time, detected_title, last_state, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `,
      [discDevice, status, startTime, detectedTitle, status]
    );
    logger.info('job:created', {
      jobId: result.lastID,
      discDevice,
      status,
      detectedTitle
    });

    return this.getJobById(result.lastID);
  }

  async updateJob(jobId, patch) {
    const db = await getDb();
    const fields = [];
    const values = [];

    for (const [key, value] of Object.entries(patch)) {
      fields.push(`${key} = ?`);
      values.push(value);
    }

    fields.push('updated_at = CURRENT_TIMESTAMP');
    values.push(jobId);

    await db.run(`UPDATE jobs SET ${fields.join(', ')} WHERE id = ?`, values);
    logger.debug('job:updated', { jobId, patchKeys: Object.keys(patch) });
    return this.getJobById(jobId);
  }

  async updateJobStatus(jobId, status, extra = {}) {
    return this.updateJob(jobId, {
      status,
      last_state: status,
      ...extra
    });
  }

  appendLog(jobId, source, message) {
    this.appendProcessLog(jobId, source, message);
  }

  appendProcessLog(jobId, source, message) {
    const filePath = toProcessLogPath(jobId);
    const streamKey = toProcessLogStreamKey(jobId);
    if (!filePath || !streamKey) {
      return;
    }
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      let stream = processLogStreams.get(streamKey);
      if (!stream) {
        stream = fs.createWriteStream(filePath, {
          flags: 'a',
          encoding: 'utf-8'
        });
        stream.on('error', (error) => {
          logger.warn('job:process-log:stream-error', {
            jobId,
            source,
            error: error?.message || String(error)
          });
        });
        processLogStreams.set(streamKey, stream);
      }
      const line = `[${new Date().toISOString()}] [${source}] ${String(message || '')}\n`;
      stream.write(line);
    } catch (error) {
      logger.warn('job:process-log:append-failed', {
        jobId,
        source,
        error: error?.message || String(error)
      });
    }
  }

  async closeProcessLog(jobId) {
    const streamKey = toProcessLogStreamKey(jobId);
    if (!streamKey) {
      return;
    }
    const stream = processLogStreams.get(streamKey);
    if (!stream) {
      return;
    }
    processLogStreams.delete(streamKey);
    await new Promise((resolve) => {
      stream.end(resolve);
    });
  }

  async resetProcessLog(jobId) {
    await this.closeProcessLog(jobId);
    const filePath = toProcessLogPath(jobId);
    if (!filePath || !fs.existsSync(filePath)) {
      return;
    }
    try {
      fs.unlinkSync(filePath);
    } catch (error) {
      logger.warn('job:process-log:reset-failed', {
        jobId,
        path: filePath,
        error: error?.message || String(error)
      });
    }
  }

  async readProcessLogLines(jobId, options = {}) {
    const includeAll = Boolean(options.includeAll);
    const parsedTail = Number(options.tailLines);
    const tailLines = Number.isFinite(parsedTail) && parsedTail > 0
      ? Math.trunc(parsedTail)
      : 800;
    const filePath = toProcessLogPath(jobId);
    if (!filePath || !fs.existsSync(filePath)) {
      return {
        exists: false,
        lines: [],
        returned: 0,
        total: 0,
        truncated: false
      };
    }

    if (includeAll) {
      const raw = await fs.promises.readFile(filePath, 'utf-8');
      const lines = String(raw || '')
        .split(/\r\n|\n|\r/)
        .filter((line) => line.length > 0);
      return {
        exists: true,
        lines,
        returned: lines.length,
        total: lines.length,
        truncated: false
      };
    }

    const stat = await fs.promises.stat(filePath);
    if (!stat.isFile() || stat.size <= 0) {
      return {
        exists: true,
        lines: [],
        returned: 0,
        total: 0,
        truncated: false
      };
    }

    const readBytes = Math.min(stat.size, PROCESS_LOG_TAIL_MAX_BYTES);
    const start = Math.max(0, stat.size - readBytes);
    const handle = await fs.promises.open(filePath, 'r');
    let buffer = Buffer.alloc(0);
    try {
      buffer = Buffer.alloc(readBytes);
      const { bytesRead } = await handle.read(buffer, 0, readBytes, start);
      buffer = buffer.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }

    let text = buffer.toString('utf-8');
    if (start > 0) {
      const parts = text.split(/\r\n|\n|\r/);
      parts.shift();
      text = parts.join('\n');
    }

    let lines = text.split(/\r\n|\n|\r/).filter((line) => line.length > 0);
    let truncated = start > 0;
    if (lines.length > tailLines) {
      lines = lines.slice(-tailLines);
      truncated = true;
    }

    return {
      exists: true,
      lines,
      returned: lines.length,
      total: lines.length,
      truncated
    };
  }

  async getJobById(jobId) {
    const db = await getDb();
    return db.get('SELECT * FROM jobs WHERE id = ?', [jobId]);
  }

  async getJobs(filters = {}) {
    const db = await getDb();
    const where = [];
    const values = [];

    if (filters.status) {
      where.push('status = ?');
      values.push(filters.status);
    }

    if (filters.search) {
      where.push('(title LIKE ? OR imdb_id LIKE ? OR detected_title LIKE ?)');
      values.push(`%${filters.search}%`, `%${filters.search}%`, `%${filters.search}%`);
    }

    const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

    const jobs = await db.all(
      `
        SELECT j.*
        FROM jobs j
        ${whereClause}
        ORDER BY j.created_at DESC
        LIMIT 500
      `,
      values
    );

    return jobs.map((job) => ({
      ...enrichJobRow(job),
      log_count: hasProcessLogFile(job.id) ? 1 : 0
    }));
  }

  async getJobWithLogs(jobId, options = {}) {
    const db = await getDb();
    const job = await db.get('SELECT * FROM jobs WHERE id = ?', [jobId]);
    if (!job) {
      return null;
    }

    const parsedTail = Number(options.logTailLines);
    const logTailLines = Number.isFinite(parsedTail) && parsedTail > 0
      ? Math.trunc(parsedTail)
      : 800;
    const includeLiveLog = Boolean(options.includeLiveLog);
    const includeLogs = Boolean(options.includeLogs);
    const includeAllLogs = Boolean(options.includeAllLogs);
    const shouldLoadLogs = includeLiveLog || includeLogs;
    const hasProcessLog = hasProcessLogFile(jobId);
    const baseLogCount = hasProcessLog ? 1 : 0;

    if (!shouldLoadLogs) {
      return {
        ...enrichJobRow(job),
        log_count: baseLogCount,
        logs: [],
        log: '',
        logMeta: {
          loaded: false,
          total: baseLogCount,
          returned: 0,
          truncated: false
        }
      };
    }

    const processLog = await this.readProcessLogLines(jobId, {
      includeAll: includeAllLogs,
      tailLines: logTailLines
    });

    return {
      ...enrichJobRow(job),
      log_count: processLog.exists ? processLog.total : 0,
      logs: [],
      log: processLog.lines.join('\n'),
      logMeta: {
        loaded: true,
        total: includeAllLogs ? processLog.total : processLog.returned,
        returned: processLog.returned,
        truncated: processLog.truncated
      }
    };
  }

  async getDatabaseRows(filters = {}) {
    const jobs = await this.getJobs(filters);
    return jobs.map((job) => ({
      ...job,
      rawFolderName: job.raw_path ? path.basename(job.raw_path) : null
    }));
  }

  async getOrphanRawFolders() {
    const settings = await settingsService.getSettingsMap();
    const rawDir = String(settings.raw_dir || '').trim();
    if (!rawDir) {
      const error = new Error('raw_dir ist nicht konfiguriert.');
      error.statusCode = 400;
      throw error;
    }

    const rawDirInfo = inspectDirectory(rawDir);
    if (!rawDirInfo.exists || !rawDirInfo.isDirectory) {
      return {
        rawDir,
        rows: []
      };
    }

    const db = await getDb();
    const linkedRows = await db.all(
      `
        SELECT id, raw_path, status
        FROM jobs
        WHERE raw_path IS NOT NULL AND TRIM(raw_path) <> ''
      `
    );

    const linkedPathMap = new Map();
    for (const row of linkedRows) {
      const normalized = normalizeComparablePath(row.raw_path);
      if (!normalized) {
        continue;
      }
      if (!linkedPathMap.has(normalized)) {
        linkedPathMap.set(normalized, []);
      }
      linkedPathMap.get(normalized).push({
        id: row.id,
        status: row.status
      });
    }

    const dirEntries = fs.readdirSync(rawDir, { withFileTypes: true });
    const orphanRows = [];

    for (const entry of dirEntries) {
      if (!entry.isDirectory()) {
        continue;
      }

      const rawPath = path.join(rawDir, entry.name);
      const normalizedPath = normalizeComparablePath(rawPath);
      if (linkedPathMap.has(normalizedPath)) {
        continue;
      }

      const dirInfo = inspectDirectory(rawPath);
      if (!dirInfo.exists || !dirInfo.isDirectory || dirInfo.isEmpty) {
        continue;
      }

      const stat = fs.statSync(rawPath);
      const metadata = parseRawFolderMetadata(entry.name);
      orphanRows.push({
        rawPath,
        folderName: entry.name,
        title: metadata.title,
        year: metadata.year,
        imdbId: metadata.imdbId,
        folderJobId: metadata.folderJobId,
        entryCount: Number(dirInfo.entryCount || 0),
        hasBlurayStructure: fs.existsSync(path.join(rawPath, 'BDMV', 'STREAM')),
        lastModifiedAt: stat.mtime.toISOString()
      });
    }

    orphanRows.sort((a, b) => String(b.lastModifiedAt).localeCompare(String(a.lastModifiedAt)));
    return {
      rawDir,
      rows: orphanRows
    };
  }

  async importOrphanRawFolder(rawPath) {
    const settings = await settingsService.getSettingsMap();
    const rawDir = String(settings.raw_dir || '').trim();
    const requestedRawPath = String(rawPath || '').trim();

    if (!requestedRawPath) {
      const error = new Error('rawPath fehlt.');
      error.statusCode = 400;
      throw error;
    }

    if (!rawDir) {
      const error = new Error('raw_dir ist nicht konfiguriert.');
      error.statusCode = 400;
      throw error;
    }

    if (!isPathInside(rawDir, requestedRawPath)) {
      const error = new Error(`RAW-Pfad liegt außerhalb von raw_dir: ${requestedRawPath}`);
      error.statusCode = 400;
      throw error;
    }

    const absRawPath = normalizeComparablePath(requestedRawPath);
    const dirInfo = inspectDirectory(absRawPath);
    if (!dirInfo.exists || !dirInfo.isDirectory) {
      const error = new Error(`RAW-Pfad existiert nicht als Verzeichnis: ${absRawPath}`);
      error.statusCode = 400;
      throw error;
    }
    if (dirInfo.isEmpty) {
      const error = new Error(`RAW-Pfad ist leer: ${absRawPath}`);
      error.statusCode = 400;
      throw error;
    }

    const db = await getDb();
    const linkedRows = await db.all(
      `
        SELECT id, raw_path
        FROM jobs
        WHERE raw_path IS NOT NULL AND TRIM(raw_path) <> ''
      `
    );
    const existing = linkedRows.find((row) => normalizeComparablePath(row.raw_path) === absRawPath);
    if (existing) {
      const error = new Error(`Für RAW-Pfad existiert bereits Job #${existing.id}.`);
      error.statusCode = 409;
      throw error;
    }

    const folderName = path.basename(absRawPath);
    const metadata = parseRawFolderMetadata(folderName);
    let omdbById = null;
    if (metadata.imdbId) {
      try {
        omdbById = await omdbService.fetchByImdbId(metadata.imdbId);
      } catch (error) {
        logger.warn('job:import-orphan-raw:omdb-fetch-failed', {
          rawPath: absRawPath,
          imdbId: metadata.imdbId,
          message: error.message
        });
      }
    }
    const effectiveTitle = omdbById?.title || metadata.title || folderName;
    const importedAt = new Date().toISOString();
    const created = await this.createJob({
      discDevice: null,
      status: 'FINISHED',
      detectedTitle: effectiveTitle
    });

    let finalRawPath = absRawPath;
    const renamedRawPath = buildRawPathForJobId(absRawPath, created.id);
    const shouldRenameRawFolder = normalizeComparablePath(renamedRawPath) !== absRawPath;
    if (shouldRenameRawFolder) {
      if (fs.existsSync(renamedRawPath)) {
        await db.run('DELETE FROM jobs WHERE id = ?', [created.id]);
        const error = new Error(`RAW-Ordner für neue Job-ID existiert bereits: ${renamedRawPath}`);
        error.statusCode = 409;
        throw error;
      }

      try {
        fs.renameSync(absRawPath, renamedRawPath);
        finalRawPath = normalizeComparablePath(renamedRawPath);
      } catch (error) {
        await db.run('DELETE FROM jobs WHERE id = ?', [created.id]);
        const wrapped = new Error(`RAW-Ordner konnte nicht auf neue Job-ID umbenannt werden: ${error.message}`);
        wrapped.statusCode = 500;
        throw wrapped;
      }
    }

    await this.updateJob(created.id, {
      status: 'FINISHED',
      last_state: 'FINISHED',
      title: omdbById?.title || metadata.title || null,
      year: Number.isFinite(Number(omdbById?.year)) ? Number(omdbById.year) : metadata.year,
      imdb_id: omdbById?.imdbId || metadata.imdbId || null,
      poster_url: omdbById?.poster || null,
      omdb_json: omdbById?.raw ? JSON.stringify(omdbById.raw) : null,
      selected_from_omdb: omdbById ? 1 : 0,
      raw_path: finalRawPath,
      output_path: null,
      handbrake_info_json: null,
      mediainfo_info_json: null,
      encode_plan_json: null,
      encode_input_path: null,
      encode_review_confirmed: 0,
      error_message: null,
      end_time: importedAt,
      makemkv_info_json: JSON.stringify({
        status: 'SUCCESS',
        source: 'orphan_raw_import',
        importedAt,
        rawPath: finalRawPath
      })
    });

    await this.appendLog(
      created.id,
      'SYSTEM',
      shouldRenameRawFolder
        ? `Historieneintrag aus RAW erstellt. Ordner umbenannt: ${absRawPath} -> ${finalRawPath}`
        : `Historieneintrag aus bestehendem RAW-Ordner erstellt: ${finalRawPath}`
    );
    if (metadata.imdbId) {
      await this.appendLog(
        created.id,
        'SYSTEM',
        omdbById
          ? `OMDb-Zuordnung via IMDb-ID übernommen: ${omdbById.imdbId} (${omdbById.title || '-'})`
          : `OMDb-Zuordnung via IMDb-ID fehlgeschlagen: ${metadata.imdbId}`
      );
    }

    logger.info('job:import-orphan-raw', {
      jobId: created.id,
      rawPath: absRawPath
    });

    const imported = await this.getJobById(created.id);
    return enrichJobRow(imported);
  }

  async assignOmdbMetadata(jobId, payload = {}) {
    const job = await this.getJobById(jobId);
    if (!job) {
      const error = new Error('Job nicht gefunden.');
      error.statusCode = 404;
      throw error;
    }

    const imdbIdInput = String(payload.imdbId || '').trim().toLowerCase();
    let omdb = null;
    if (imdbIdInput) {
      omdb = await omdbService.fetchByImdbId(imdbIdInput);
      if (!omdb) {
        const error = new Error(`OMDb Eintrag für ${imdbIdInput} nicht gefunden.`);
        error.statusCode = 404;
        throw error;
      }
    }

    const manualTitle = String(payload.title || '').trim();
    const manualYearRaw = Number(payload.year);
    const manualYear = Number.isFinite(manualYearRaw) ? Math.trunc(manualYearRaw) : null;
    const manualPoster = String(payload.poster || '').trim() || null;
    const hasManual = manualTitle.length > 0 || manualYear !== null || imdbIdInput.length > 0;
    if (!omdb && !hasManual) {
      const error = new Error('Keine OMDb-/Metadaten zum Aktualisieren angegeben.');
      error.statusCode = 400;
      throw error;
    }

    const title = omdb?.title || manualTitle || job.title || job.detected_title || null;
    const year = Number.isFinite(Number(omdb?.year))
      ? Number(omdb.year)
      : (manualYear !== null ? manualYear : (job.year ?? null));
    const imdbId = omdb?.imdbId || (imdbIdInput || job.imdb_id || null);
    const posterUrl = omdb?.poster || manualPoster || job.poster_url || null;
    const selectedFromOmdb = omdb ? 1 : Number(payload.fromOmdb ? 1 : 0);

    await this.updateJob(jobId, {
      title,
      year,
      imdb_id: imdbId,
      poster_url: posterUrl,
      omdb_json: omdb?.raw ? JSON.stringify(omdb.raw) : (job.omdb_json || null),
      selected_from_omdb: selectedFromOmdb
    });

    await this.appendLog(
      jobId,
      'USER_ACTION',
      omdb
        ? `OMDb-Zuordnung aktualisiert: ${omdb.imdbId} (${omdb.title || '-'})`
        : `Metadaten manuell aktualisiert: title="${title || '-'}", year="${year || '-'}", imdb="${imdbId || '-'}"`
    );

    const updated = await this.getJobById(jobId);
    return enrichJobRow(updated);
  }

  async deleteJobFiles(jobId, target = 'both') {
    const allowedTargets = new Set(['raw', 'movie', 'both']);
    if (!allowedTargets.has(target)) {
      const error = new Error(`Ungültiges target '${target}'. Erlaubt: raw, movie, both.`);
      error.statusCode = 400;
      throw error;
    }

    const job = await this.getJobById(jobId);
    if (!job) {
      const error = new Error('Job nicht gefunden.');
      error.statusCode = 404;
      throw error;
    }

    const settings = await settingsService.getSettingsMap();
    const summary = {
      target,
      raw: { attempted: false, deleted: false, filesDeleted: 0, dirsRemoved: 0, reason: null },
      movie: { attempted: false, deleted: false, filesDeleted: 0, dirsRemoved: 0, reason: null }
    };

    if (target === 'raw' || target === 'both') {
      summary.raw.attempted = true;
      if (!job.raw_path) {
        summary.raw.reason = 'Kein raw_path im Job gesetzt.';
      } else if (!isPathInside(settings.raw_dir, job.raw_path)) {
        const error = new Error(`RAW-Pfad liegt außerhalb von raw_dir: ${job.raw_path}`);
        error.statusCode = 400;
        throw error;
      } else if (!fs.existsSync(job.raw_path)) {
        summary.raw.reason = 'RAW-Pfad existiert nicht.';
      } else {
        const result = deleteFilesRecursively(job.raw_path, true);
        summary.raw.deleted = true;
        summary.raw.filesDeleted = result.filesDeleted;
        summary.raw.dirsRemoved = result.dirsRemoved;
      }
    }

    if (target === 'movie' || target === 'both') {
      summary.movie.attempted = true;
      if (!job.output_path) {
        summary.movie.reason = 'Kein output_path im Job gesetzt.';
      } else if (!isPathInside(settings.movie_dir, job.output_path)) {
        const error = new Error(`Movie-Pfad liegt außerhalb von movie_dir: ${job.output_path}`);
        error.statusCode = 400;
        throw error;
      } else if (!fs.existsSync(job.output_path)) {
        summary.movie.reason = 'Movie-Datei/Pfad existiert nicht.';
      } else {
        const outputPath = normalizeComparablePath(job.output_path);
        const movieRoot = normalizeComparablePath(settings.movie_dir);
        const stat = fs.lstatSync(outputPath);
        if (stat.isDirectory()) {
          const keepRoot = outputPath === movieRoot;
          const result = deleteFilesRecursively(outputPath, keepRoot ? true : false);
          summary.movie.deleted = true;
          summary.movie.filesDeleted = result.filesDeleted;
          summary.movie.dirsRemoved = result.dirsRemoved;
        } else {
          const parentDir = normalizeComparablePath(path.dirname(outputPath));
          const canDeleteParentDir = parentDir
            && parentDir !== movieRoot
            && isPathInside(movieRoot, parentDir)
            && fs.existsSync(parentDir)
            && fs.lstatSync(parentDir).isDirectory();

          if (canDeleteParentDir) {
            const result = deleteFilesRecursively(parentDir, false);
            summary.movie.deleted = true;
            summary.movie.filesDeleted = result.filesDeleted;
            summary.movie.dirsRemoved = result.dirsRemoved;
          } else {
            fs.unlinkSync(outputPath);
            summary.movie.deleted = true;
            summary.movie.filesDeleted = 1;
            summary.movie.dirsRemoved = 0;
          }
        }
      }
    }

    await this.appendLog(
      jobId,
      'USER_ACTION',
      `Dateien gelöscht (${target}) - raw=${JSON.stringify(summary.raw)} movie=${JSON.stringify(summary.movie)}`
    );
    logger.info('job:delete-files', { jobId, summary });

    const updated = await this.getJobById(jobId);
    return {
      summary,
      job: enrichJobRow(updated)
    };
  }

  async deleteJob(jobId, fileTarget = 'none') {
    const allowedTargets = new Set(['none', 'raw', 'movie', 'both']);
    if (!allowedTargets.has(fileTarget)) {
      const error = new Error(`Ungültiges target '${fileTarget}'. Erlaubt: none, raw, movie, both.`);
      error.statusCode = 400;
      throw error;
    }

    const existing = await this.getJobById(jobId);
    if (!existing) {
      const error = new Error('Job nicht gefunden.');
      error.statusCode = 404;
      throw error;
    }

    let fileSummary = null;
    if (fileTarget !== 'none') {
      const fileResult = await this.deleteJobFiles(jobId, fileTarget);
      fileSummary = fileResult.summary;
    }

    const db = await getDb();
    const pipelineRow = await db.get(
      'SELECT state, active_job_id FROM pipeline_state WHERE id = 1'
    );

    const isActivePipelineJob = Number(pipelineRow?.active_job_id || 0) === Number(jobId);
    const runningStates = new Set(['ANALYZING', 'RIPPING', 'MEDIAINFO_CHECK', 'ENCODING']);

    if (isActivePipelineJob && runningStates.has(String(pipelineRow?.state || ''))) {
      const error = new Error('Aktiver Pipeline-Job kann nicht gelöscht werden. Bitte zuerst abbrechen.');
      error.statusCode = 409;
      throw error;
    }

    await db.exec('BEGIN');
    try {
      if (isActivePipelineJob) {
        await db.run(
          `
            UPDATE pipeline_state
            SET
              state = 'IDLE',
              active_job_id = NULL,
              progress = 0,
              eta = NULL,
              status_text = 'Bereit',
              context_json = '{}',
              updated_at = CURRENT_TIMESTAMP
            WHERE id = 1
          `
        );
      } else {
        await db.run(
          `
            UPDATE pipeline_state
            SET
              active_job_id = NULL,
              updated_at = CURRENT_TIMESTAMP
            WHERE id = 1 AND active_job_id = ?
          `,
          [jobId]
        );
      }

      await db.run('DELETE FROM jobs WHERE id = ?', [jobId]);
      await db.exec('COMMIT');
    } catch (error) {
      await db.exec('ROLLBACK');
      throw error;
    }

    await this.closeProcessLog(jobId);
    const processLogPath = toProcessLogPath(jobId);
    if (processLogPath && fs.existsSync(processLogPath)) {
      try {
        fs.unlinkSync(processLogPath);
      } catch (error) {
        logger.warn('job:process-log:delete-failed', {
          jobId,
          path: processLogPath,
          error: error?.message || String(error)
        });
      }
    }

    logger.warn('job:deleted', {
      jobId,
      fileTarget,
      pipelineStateReset: isActivePipelineJob,
      filesDeleted: fileSummary
        ? {
          raw: fileSummary.raw?.filesDeleted ?? 0,
          movie: fileSummary.movie?.filesDeleted ?? 0
        }
        : { raw: 0, movie: 0 }
    });

    return {
      deleted: true,
      jobId,
      fileTarget,
      fileSummary
    };
  }
}

module.exports = new HistoryService();
