const { getDb } = require('../db/database');
const logger = require('./logger').child('HISTORY');
const fs = require('fs');
const path = require('path');
const settingsService = require('./settingsService');
const omdbService = require('./omdbService');
const { getJobLogDir } = require('./logPathService');
const thumbnailService = require('./thumbnailService');

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
const PROFILE_PATH_SUFFIXES = ['bluray', 'dvd', 'cd', 'other'];
const RAW_INCOMPLETE_PREFIX = 'Incomplete_';
const RAW_RIP_COMPLETE_PREFIX = 'Rip_Complete_';

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

    // Fast path: only determine whether directory is empty, avoid loading all entries.
    let firstEntry = null;
    let openError = null;
    try {
      const dir = fs.opendirSync(dirPath);
      try {
        firstEntry = dir.readSync();
      } finally {
        dir.closeSync();
      }
    } catch (error) {
      openError = error;
    }
    if (openError) {
      const entries = fs.readdirSync(dirPath);
      return {
        path: dirPath,
        exists: true,
        isDirectory: true,
        isEmpty: entries.length === 0,
        entryCount: entries.length
      };
    }
    return {
      path: dirPath,
      exists: true,
      isDirectory: true,
      isEmpty: !firstEntry,
      entryCount: firstEntry ? null : 0
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

function hasCdStructure(rawPath) {
  const basePath = String(rawPath || '').trim();
  if (!basePath) {
    return false;
  }

  try {
    if (!fs.existsSync(basePath)) {
      return false;
    }
    const stat = fs.statSync(basePath);
    if (!stat.isDirectory()) {
      return false;
    }
    const entries = fs.readdirSync(basePath);
    const audioExtensions = new Set(['.flac', '.wav', '.mp3', '.opus', '.ogg', '.aiff', '.aif']);
    return entries.some((entry) => audioExtensions.has(path.extname(entry).toLowerCase()));
  } catch (_error) {
    return false;
  }
}

function detectOrphanMediaType(rawPath) {
  if (hasBlurayStructure(rawPath)) {
    return 'bluray';
  }
  if (hasDvdStructure(rawPath)) {
    return 'dvd';
  }
  if (hasCdStructure(rawPath)) {
    return 'cd';
  }
  return 'other';
}

function hasDvdStructure(rawPath) {
  const basePath = String(rawPath || '').trim();
  if (!basePath) {
    return false;
  }

  const videoTsPath = path.join(basePath, 'VIDEO_TS');
  try {
    if (fs.existsSync(videoTsPath)) {
      const stat = fs.statSync(videoTsPath);
      if (stat.isDirectory()) {
        return true;
      }
    }
  } catch (_error) {
    // ignore fs errors
  }

  try {
    if (fs.existsSync(basePath)) {
      const stat = fs.statSync(basePath);
      if (stat.isDirectory()) {
        const entries = fs.readdirSync(basePath);
        if (entries.some((entry) => /^vts_\d{2}_\d\.(ifo|vob|bup)$/i.test(entry) || /^video_ts\.(ifo|vob|bup)$/i.test(entry))) {
          return true;
        }
      } else if (stat.isFile()) {
        return /(^|\/)video_ts\/.+\.(ifo|vob|bup)$/i.test(basePath) || /\.(ifo|vob|bup)$/i.test(basePath);
      }
    }
  } catch (_error) {
    // ignore fs errors and fallback to path checks
  }

  if (/(^|\/)video_ts(\/|$)/i.test(basePath)) {
    return true;
  }

  return false;
}

function normalizeMediaTypeValue(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) {
    return null;
  }
  if (
    raw === 'bluray'
    || raw === 'blu-ray'
    || raw === 'blu_ray'
    || raw === 'bd'
    || raw === 'bdmv'
    || raw === 'bdrom'
    || raw === 'bd-rom'
    || raw === 'bd-r'
    || raw === 'bd-re'
  ) {
    return 'bluray';
  }
  if (
    raw === 'dvd'
    || raw === 'dvdvideo'
    || raw === 'dvd-video'
    || raw === 'dvdrom'
    || raw === 'dvd-rom'
    || raw === 'video_ts'
    || raw === 'iso9660'
  ) {
    return 'dvd';
  }
  if (raw === 'cd' || raw === 'audio_cd') {
    return 'cd';
  }
  return null;
}

function inferMediaType(job, makemkvInfo, mediainfoInfo, encodePlan, handbrakeInfo = null) {
  const mkInfo = parseInfoFromValue(makemkvInfo, null);
  const miInfo = parseInfoFromValue(mediainfoInfo, null);
  const plan = parseInfoFromValue(encodePlan, null);
  const hbInfo = parseInfoFromValue(handbrakeInfo, null);
  const rawPath = String(job?.raw_path || '').trim();
  const encodeInputPath = String(job?.encode_input_path || plan?.encodeInputPath || '').trim();
  const profileHint = normalizeMediaTypeValue(
    plan?.mediaProfile
    || mkInfo?.analyzeContext?.mediaProfile
    || mkInfo?.mediaProfile
    || miInfo?.mediaProfile
    || job?.media_type
    || job?.mediaType
  );

  if (profileHint === 'bluray' || profileHint === 'dvd' || profileHint === 'cd') {
    return profileHint;
  }

  const statusCandidates = [
    job?.status,
    job?.last_state,
    mkInfo?.lastState
  ];
  if (statusCandidates.some((value) => String(value || '').trim().toUpperCase().startsWith('CD_'))) {
    return 'cd';
  }

  const planFormat = String(plan?.format || '').trim().toLowerCase();
  const hasCdTracksInPlan = Array.isArray(plan?.selectedTracks) && plan.selectedTracks.length > 0;
  if (hasCdTracksInPlan && ['flac', 'wav', 'mp3', 'opus', 'ogg'].includes(planFormat)) {
    return 'cd';
  }
  if (String(hbInfo?.mode || '').trim().toLowerCase() === 'cd_rip') {
    return 'cd';
  }
  if (Array.isArray(mkInfo?.tracks) && mkInfo.tracks.length > 0) {
    return 'cd';
  }

  if (hasBlurayStructure(rawPath)) {
    return 'bluray';
  }
  if (hasDvdStructure(rawPath)) {
    return 'dvd';
  }

  const mkSource = String(mkInfo?.source || '').trim().toLowerCase();
  const mkRipMode = String(mkInfo?.ripMode || mkInfo?.rip_mode || '').trim().toLowerCase();
  if (Boolean(mkInfo?.analyzeContext?.playlistAnalysis)) {
    return 'bluray';
  }
  if (mkRipMode === 'backup' || mkSource.includes('backup') || mkSource.includes('raw_backup')) {
    if (hasDvdStructure(rawPath) || hasDvdStructure(encodeInputPath)) {
      return 'dvd';
    }
    if (hasBlurayStructure(rawPath) || hasBlurayStructure(encodeInputPath)) {
      return 'bluray';
    }
  }

  const planMode = String(plan?.mode || '').trim().toLowerCase();
  if (planMode === 'pre_rip' || Boolean(plan?.preRip)) {
    return 'bluray';
  }

  const mediainfoSource = String(miInfo?.source || '').trim().toLowerCase();
  if (Number(miInfo?.handbrakeTitleId) > 0) {
    return 'bluray';
  }
  if (mediainfoSource.includes('raw_backup')) {
    if (hasDvdStructure(rawPath) || hasDvdStructure(encodeInputPath)) {
      return 'dvd';
    }
    if (hasBlurayStructure(rawPath) || hasBlurayStructure(encodeInputPath)) {
      return 'bluray';
    }
  }

  if (
    /(^|\/)bdmv(\/|$)/i.test(rawPath)
    || /(^|\/)bdmv(\/|$)/i.test(encodeInputPath)
    || /\.m2ts(\.|$)/i.test(encodeInputPath)
  ) {
    return 'bluray';
  }
  if (
    /(^|\/)video_ts(\/|$)/i.test(rawPath)
    || /(^|\/)video_ts(\/|$)/i.test(encodeInputPath)
    || /\.(ifo|vob|bup)(\.|$)/i.test(encodeInputPath)
  ) {
    return 'dvd';
  }

  return profileHint || 'other';
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

function resolveEffectiveRawPath(storedPath, rawDir, extraDirs = []) {
  const stored = String(storedPath || '').trim();
  if (!stored) return stored;
  const folderName = path.basename(stored);
  if (!folderName) return stored;

  const candidates = [];
  const seen = new Set();
  const pushCandidate = (candidatePath) => {
    const normalized = String(candidatePath || '').trim();
    if (!normalized) {
      return;
    }
    const comparable = normalizeComparablePath(normalized);
    if (!comparable || seen.has(comparable)) {
      return;
    }
    seen.add(comparable);
    candidates.push(normalized);
  };

  pushCandidate(stored);
  if (rawDir) {
    pushCandidate(path.join(String(rawDir).trim(), folderName));
  }
  for (const extraDir of Array.isArray(extraDirs) ? extraDirs : []) {
    pushCandidate(path.join(String(extraDir || '').trim(), folderName));
  }

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
        return candidate;
      }
    } catch (_error) {
      // ignore fs errors and continue with fallbacks
    }
  }

  return rawDir ? path.join(String(rawDir).trim(), folderName) : stored;
}

function resolveEffectiveOutputPath(storedPath, movieDir) {
  const stored = String(storedPath || '').trim();
  if (!stored || !movieDir) return stored;
  // output_path structure: {movie_dir}/{folderName}/{fileName}
  const fileName = path.basename(stored);
  const folderName = path.basename(path.dirname(stored));
  if (!fileName || !folderName || folderName === '.') return stored;
  return path.join(String(movieDir).trim(), folderName, fileName);
}

function getConfiguredMediaPathList(settings = {}, baseKey) {
  const source = settings && typeof settings === 'object' ? settings : {};
  const candidates = [source[baseKey], ...PROFILE_PATH_SUFFIXES.map((suffix) => source[`${baseKey}_${suffix}`])];
  const unique = [];
  const seen = new Set();

  for (const candidate of candidates) {
    const rawPath = String(candidate || '').trim();
    if (!rawPath) {
      continue;
    }
    const normalized = normalizeComparablePath(rawPath);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    unique.push(normalized);
  }

  return unique;
}

function resolveEffectiveStoragePathsForJob(settings = null, job = {}, parsed = {}) {
  const mkInfo = parsed?.makemkvInfo || parseJsonSafe(job?.makemkv_info_json, null);
  const miInfo = parsed?.mediainfoInfo || parseJsonSafe(job?.mediainfo_info_json, null);
  const plan = parsed?.encodePlan || parseJsonSafe(job?.encode_plan_json, null);
  const handbrakeInfo = parsed?.handbrakeInfo || parseJsonSafe(job?.handbrake_info_json, null);
  const mediaType = inferMediaType(job, mkInfo, miInfo, plan, handbrakeInfo);
  const effectiveSettings = settingsService.resolveEffectiveToolSettings(settings || {}, mediaType);
  const rawDir = String(effectiveSettings?.raw_dir || '').trim();
  const configuredMovieDir = String(effectiveSettings?.movie_dir || '').trim();
  const movieDir = configuredMovieDir || rawDir;
  const rawLookupDirs = getConfiguredMediaPathList(settings || {}, 'raw_dir')
    .filter((candidate) => normalizeComparablePath(candidate) !== normalizeComparablePath(rawDir));
  const effectiveRawPath = job?.raw_path
    ? resolveEffectiveRawPath(job.raw_path, rawDir, rawLookupDirs)
    : (job?.raw_path || null);
  // For CD, output_path is a directory (album folder) — skip path-relocation heuristic
  const effectiveOutputPath = (mediaType !== 'cd' && configuredMovieDir && job?.output_path)
    ? resolveEffectiveOutputPath(job.output_path, configuredMovieDir)
    : (job?.output_path || null);

  return {
    mediaType,
    rawDir,
    movieDir,
    effectiveRawPath,
    effectiveOutputPath,
    makemkvInfo: mkInfo,
    mediainfoInfo: miInfo,
    handbrakeInfo,
    encodePlan: plan
  };
}

function buildUnknownDirectoryStatus(dirPath = null) {
  return {
    path: dirPath || null,
    exists: null,
    isDirectory: null,
    isEmpty: null,
    entryCount: null
  };
}

function buildUnknownFileStatus(filePath = null) {
  return {
    path: filePath || null,
    exists: null,
    isFile: null,
    sizeBytes: null
  };
}

function enrichJobRow(job, settings = null, options = {}) {
  const includeFsChecks = options?.includeFsChecks !== false;
  const omdbInfo = parseJsonSafe(job.omdb_json, null);
  const resolvedPaths = resolveEffectiveStoragePathsForJob(settings, job);
  const handbrakeInfo = resolvedPaths.handbrakeInfo;
  const outputStatus = includeFsChecks
    ? (resolvedPaths.mediaType === 'cd'
      ? inspectDirectory(resolvedPaths.effectiveOutputPath)
      : inspectOutputFile(resolvedPaths.effectiveOutputPath))
    : (resolvedPaths.mediaType === 'cd'
      ? buildUnknownDirectoryStatus(resolvedPaths.effectiveOutputPath)
      : buildUnknownFileStatus(resolvedPaths.effectiveOutputPath));
  const rawStatus = includeFsChecks
    ? inspectDirectory(resolvedPaths.effectiveRawPath)
    : buildUnknownDirectoryStatus(resolvedPaths.effectiveRawPath);
  const movieDirPath = resolvedPaths.effectiveOutputPath ? path.dirname(resolvedPaths.effectiveOutputPath) : null;
  const movieDirStatus = includeFsChecks
    ? inspectDirectory(movieDirPath)
    : buildUnknownDirectoryStatus(movieDirPath);
  const makemkvInfo = resolvedPaths.makemkvInfo;
  const mediainfoInfo = resolvedPaths.mediainfoInfo;
  const encodePlan = resolvedPaths.encodePlan;
  const mediaType = resolvedPaths.mediaType;
  const ripSuccessful = Number(job?.rip_successful || 0) === 1
    || String(makemkvInfo?.status || '').trim().toUpperCase() === 'SUCCESS';
  const backupSuccess = ripSuccessful;
  const encodeSuccess = mediaType === 'cd'
    ? (String(job?.status || '').trim().toUpperCase() === 'FINISHED' && Boolean(outputStatus?.exists))
    : String(handbrakeInfo?.status || '').trim().toUpperCase() === 'SUCCESS';

  return {
    ...job,
    raw_path: resolvedPaths.effectiveRawPath,
    output_path: resolvedPaths.effectiveOutputPath,
    makemkvInfo,
    handbrakeInfo,
    mediainfoInfo,
    omdbInfo,
    encodePlan,
    mediaType,
    ripSuccessful,
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

function stripRawFolderStatePrefix(folderName) {
  const rawName = String(folderName || '').trim();
  if (!rawName) {
    return '';
  }
  return rawName
    .replace(new RegExp(`^${RAW_INCOMPLETE_PREFIX}`, 'i'), '')
    .replace(new RegExp(`^${RAW_RIP_COMPLETE_PREFIX}`, 'i'), '')
    .trim();
}

function applyRawFolderPrefix(folderName, prefix = '') {
  const normalized = stripRawFolderStatePrefix(folderName);
  if (!normalized) {
    return normalized;
  }
  const safePrefix = String(prefix || '').trim();
  return safePrefix ? `${safePrefix}${normalized}` : normalized;
}

function parseRawFolderMetadata(folderName) {
  const rawName = String(folderName || '').trim();
  const normalizedRawName = stripRawFolderStatePrefix(rawName);
  const folderJobIdMatch = normalizedRawName.match(/-\s*RAW\s*-\s*job-(\d+)\s*$/i);
  const folderJobId = folderJobIdMatch ? Number(folderJobIdMatch[1]) : null;
  let working = normalizedRawName.replace(/\s*-\s*RAW\s*-\s*job-\d+\s*$/i, '').trim();

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

function normalizeJobIdValue(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return Math.trunc(parsed);
}

function parseSourceJobIdFromPlan(encodePlanRaw) {
  const plan = parseInfoFromValue(encodePlanRaw, null);
  const sourceJobId = normalizeJobIdValue(plan?.sourceJobId);
  return sourceJobId || null;
}

function parseRetryLinkedJobIdsFromLogLines(lines = []) {
  const jobIds = new Set();
  const list = Array.isArray(lines) ? lines : [];
  for (const line of list) {
    const text = String(line || '');
    if (!text) {
      continue;
    }
    if (!/retry/i.test(text)) {
      continue;
    }
    const regex = /job\s*#(\d+)/ig;
    let match = regex.exec(text);
    while (match) {
      const id = normalizeJobIdValue(match?.[1]);
      if (id) {
        jobIds.add(id);
      }
      match = regex.exec(text);
    }
  }
  return Array.from(jobIds);
}

function normalizeLineageReason(value) {
  const normalized = String(value || '').trim();
  return normalized || null;
}

function inspectDeletionPath(targetPath) {
  const normalized = normalizeComparablePath(targetPath);
  if (!normalized) {
    return {
      path: null,
      exists: false,
      isDirectory: false,
      isFile: false
    };
  }
  try {
    const stat = fs.lstatSync(normalized);
    return {
      path: normalized,
      exists: true,
      isDirectory: stat.isDirectory(),
      isFile: stat.isFile()
    };
  } catch (_error) {
    return {
      path: normalized,
      exists: false,
      isDirectory: false,
      isFile: false
    };
  }
}

function buildJobDisplayTitle(job = null) {
  if (!job || typeof job !== 'object') {
    return '-';
  }
  return String(job.title || job.detected_title || `Job #${job.id || '-'}`).trim() || '-';
}

function isFilesystemRootPath(inputPath) {
  const raw = String(inputPath || '').trim();
  if (!raw) {
    return false;
  }
  const resolved = normalizeComparablePath(raw);
  const parsedRoot = path.parse(resolved).root;
  return Boolean(parsedRoot && resolved === normalizeComparablePath(parsedRoot));
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

  async updateRawPathByOldPath(oldRawPath, newRawPath) {
    const db = await getDb();
    const result = await db.run(
      'UPDATE jobs SET raw_path = ?, updated_at = CURRENT_TIMESTAMP WHERE raw_path = ?',
      [newRawPath, oldRawPath]
    );
    logger.info('job:raw-path-bulk-updated', { oldRawPath, newRawPath, changes: result.changes });
    return result.changes;
  }

  async listJobLineageArtifactsByJobIds(jobIds = []) {
    const normalizedIds = Array.isArray(jobIds)
      ? jobIds
        .map((value) => normalizeJobIdValue(value))
        .filter(Boolean)
      : [];
    if (normalizedIds.length === 0) {
      return new Map();
    }

    const db = await getDb();
    const placeholders = normalizedIds.map(() => '?').join(', ');
    const rows = await db.all(
      `
        SELECT id, job_id, source_job_id, media_type, raw_path, output_path, reason, note, created_at
        FROM job_lineage_artifacts
        WHERE job_id IN (${placeholders})
        ORDER BY id ASC
      `,
      normalizedIds
    );

    const byJobId = new Map();
    for (const row of rows) {
      const ownerJobId = normalizeJobIdValue(row?.job_id);
      if (!ownerJobId) {
        continue;
      }
      if (!byJobId.has(ownerJobId)) {
        byJobId.set(ownerJobId, []);
      }
      byJobId.get(ownerJobId).push({
        id: normalizeJobIdValue(row?.id),
        jobId: ownerJobId,
        sourceJobId: normalizeJobIdValue(row?.source_job_id),
        mediaType: normalizeMediaTypeValue(row?.media_type),
        rawPath: String(row?.raw_path || '').trim() || null,
        outputPath: String(row?.output_path || '').trim() || null,
        reason: normalizeLineageReason(row?.reason),
        note: String(row?.note || '').trim() || null,
        createdAt: String(row?.created_at || '').trim() || null
      });
    }

    return byJobId;
  }

  async transferJobLineageArtifacts(sourceJobId, replacementJobId, options = {}) {
    const fromJobId = normalizeJobIdValue(sourceJobId);
    const toJobId = normalizeJobIdValue(replacementJobId);
    if (!fromJobId || !toJobId || fromJobId === toJobId) {
      const error = new Error('Ungültige Job-IDs für Lineage-Transfer.');
      error.statusCode = 400;
      throw error;
    }

    const reason = normalizeLineageReason(options?.reason) || 'job_replaced';
    const note = String(options?.note || '').trim() || null;
    const sourceJob = await this.getJobById(fromJobId);
    if (!sourceJob) {
      const error = new Error(`Quell-Job ${fromJobId} nicht gefunden.`);
      error.statusCode = 404;
      throw error;
    }

    const settings = await settingsService.getSettingsMap();
    const resolvedPaths = resolveEffectiveStoragePathsForJob(settings, sourceJob);
    const rawPath = String(resolvedPaths?.effectiveRawPath || sourceJob?.raw_path || '').trim() || null;
    const outputPath = String(resolvedPaths?.effectiveOutputPath || sourceJob?.output_path || '').trim() || null;
    const mediaType = normalizeMediaTypeValue(resolvedPaths?.mediaType) || 'other';

    const db = await getDb();
    await db.exec('BEGIN');
    try {
      await db.run(
        `
          INSERT INTO job_lineage_artifacts (
            job_id, source_job_id, media_type, raw_path, output_path, reason, note, created_at
          )
          SELECT ?, source_job_id, media_type, raw_path, output_path, reason, note, created_at
          FROM job_lineage_artifacts
          WHERE job_id = ?
        `,
        [toJobId, fromJobId]
      );

      if (rawPath || outputPath) {
        await db.run(
          `
            INSERT INTO job_lineage_artifacts (
              job_id, source_job_id, media_type, raw_path, output_path, reason, note, created_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
          `,
          [toJobId, fromJobId, mediaType, rawPath, outputPath, reason, note]
        );
      }

      await db.exec('COMMIT');
    } catch (error) {
      await db.exec('ROLLBACK');
      throw error;
    }

    logger.info('job:lineage:transferred', {
      sourceJobId: fromJobId,
      replacementJobId: toJobId,
      mediaType,
      reason,
      hasRawPath: Boolean(rawPath),
      hasOutputPath: Boolean(outputPath)
    });
  }

  async retireJobInFavorOf(sourceJobId, replacementJobId, options = {}) {
    const fromJobId = normalizeJobIdValue(sourceJobId);
    const toJobId = normalizeJobIdValue(replacementJobId);
    if (!fromJobId || !toJobId || fromJobId === toJobId) {
      const error = new Error('Ungültige Job-IDs für Job-Ersatz.');
      error.statusCode = 400;
      throw error;
    }

    const reason = normalizeLineageReason(options?.reason) || 'job_replaced';
    const note = String(options?.note || '').trim() || null;

    await this.transferJobLineageArtifacts(fromJobId, toJobId, { reason, note });

    const db = await getDb();
    const pipelineRow = await db.get('SELECT active_job_id FROM pipeline_state WHERE id = 1');
    const activeJobId = normalizeJobIdValue(pipelineRow?.active_job_id);
    const sourceIsActive = activeJobId === fromJobId;

    await db.exec('BEGIN');
    try {
      if (sourceIsActive) {
        await db.run(
          `
            UPDATE pipeline_state
            SET active_job_id = ?, updated_at = CURRENT_TIMESTAMP
            WHERE id = 1
          `,
          [toJobId]
        );
      } else {
        await db.run(
          `
            UPDATE pipeline_state
            SET active_job_id = NULL, updated_at = CURRENT_TIMESTAMP
            WHERE id = 1 AND active_job_id = ?
          `,
          [fromJobId]
        );
      }

      await db.run('DELETE FROM jobs WHERE id = ?', [fromJobId]);
      await db.exec('COMMIT');
    } catch (error) {
      await db.exec('ROLLBACK');
      throw error;
    }

    await this.closeProcessLog(fromJobId);
    this._deleteProcessLogFile(fromJobId);

    logger.warn('job:retired', {
      sourceJobId: fromJobId,
      replacementJobId: toJobId,
      reason,
      sourceWasActive: sourceIsActive
    });

    return {
      retired: true,
      sourceJobId: fromJobId,
      replacementJobId: toJobId,
      reason
    };
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
    const includeFsChecks = filters?.includeFsChecks !== false;
    const rawStatuses = Array.isArray(filters?.statuses)
      ? filters.statuses
      : (typeof filters?.statuses === 'string'
        ? String(filters.statuses).split(',')
        : []);
    const normalizedStatuses = rawStatuses
      .map((value) => String(value || '').trim().toUpperCase())
      .filter(Boolean);
    const limitRaw = Number(filters?.limit);
    const limit = Number.isFinite(limitRaw) && limitRaw > 0
      ? Math.min(Math.trunc(limitRaw), 500)
      : 500;

    if (normalizedStatuses.length > 0) {
      const placeholders = normalizedStatuses.map(() => '?').join(', ');
      where.push(`status IN (${placeholders})`);
      values.push(...normalizedStatuses);
    } else if (filters.status) {
      where.push('status = ?');
      values.push(filters.status);
    }

    if (filters.search) {
      where.push('(title LIKE ? OR imdb_id LIKE ? OR detected_title LIKE ? OR makemkv_info_json LIKE ?)');
      values.push(`%${filters.search}%`, `%${filters.search}%`, `%${filters.search}%`, `%${filters.search}%`);
    }

    const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

    const [jobs, settings] = await Promise.all([
      db.all(
        `
        SELECT j.*
        FROM jobs j
        ${whereClause}
        ORDER BY j.created_at DESC
        LIMIT ${limit}
      `,
        values
      ),
      settingsService.getSettingsMap()
    ]);

    return jobs.map((job) => ({
      ...enrichJobRow(job, settings, { includeFsChecks }),
      log_count: includeFsChecks ? (hasProcessLogFile(job.id) ? 1 : 0) : 0
    }));
  }

  async getJobsByIds(jobIds = []) {
    const ids = Array.isArray(jobIds)
      ? jobIds
        .map((value) => Number(value))
        .filter((value) => Number.isFinite(value) && value > 0)
        .map((value) => Math.trunc(value))
      : [];
    if (ids.length === 0) {
      return [];
    }

    const [rows, settings] = await Promise.all([
      (async () => {
        const db = await getDb();
        const placeholders = ids.map(() => '?').join(', ');
        return db.all(`SELECT * FROM jobs WHERE id IN (${placeholders})`, ids);
      })(),
      settingsService.getSettingsMap()
    ]);
    const byId = new Map(rows.map((row) => [Number(row.id), row]));
    return ids
      .map((id) => byId.get(id))
      .filter(Boolean)
      .map((job) => ({
        ...enrichJobRow(job, settings),
        log_count: hasProcessLogFile(job.id) ? 1 : 0
      }));
  }

  async getRunningJobs() {
    const db = await getDb();
    const [rows, settings] = await Promise.all([
      db.all(
        `
        SELECT *
        FROM jobs
        WHERE status IN ('RIPPING', 'ENCODING', 'CD_ANALYZING', 'CD_RIPPING', 'CD_ENCODING')
        ORDER BY updated_at ASC, id ASC
      `
      ),
      settingsService.getSettingsMap()
    ]);
    return rows.map((job) => ({
      ...enrichJobRow(job, settings),
      log_count: hasProcessLogFile(job.id) ? 1 : 0
    }));
  }

  async getRunningEncodeJobs() {
    const db = await getDb();
    const [rows, settings] = await Promise.all([
      db.all(
        `
        SELECT *
        FROM jobs
        WHERE status IN ('ENCODING', 'CD_ENCODING')
        ORDER BY updated_at ASC, id ASC
      `
      ),
      settingsService.getSettingsMap()
    ]);
    return rows.map((job) => ({
      ...enrichJobRow(job, settings),
      log_count: hasProcessLogFile(job.id) ? 1 : 0
    }));
  }

  async getRunningFilmEncodeJobs() {
    const db = await getDb();
    const rows = await db.all(
      `SELECT id, status FROM jobs WHERE status = 'ENCODING' ORDER BY updated_at ASC, id ASC`
    );
    return rows;
  }

  async getRunningCdEncodeJobs() {
    const db = await getDb();
    const rows = await db.all(
      `SELECT id, status FROM jobs WHERE status IN ('CD_RIPPING', 'CD_ENCODING') ORDER BY updated_at ASC, id ASC`
    );
    return rows;
  }

  async getJobWithLogs(jobId, options = {}) {
    const db = await getDb();
    const includeFsChecks = options?.includeFsChecks !== false;
    const [job, settings] = await Promise.all([
      db.get('SELECT * FROM jobs WHERE id = ?', [jobId]),
      settingsService.getSettingsMap()
    ]);
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
    const hasProcessLog = (!shouldLoadLogs && includeFsChecks) ? hasProcessLogFile(jobId) : false;
    const baseLogCount = hasProcessLog ? 1 : 0;

    if (!shouldLoadLogs) {
      return {
        ...enrichJobRow(job, settings, { includeFsChecks }),
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
      ...enrichJobRow(job, settings, { includeFsChecks }),
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
    const rawDirs = getConfiguredMediaPathList(settings, 'raw_dir');
    if (rawDirs.length === 0) {
      const error = new Error('Kein RAW-Pfad konfiguriert (raw_dir oder raw_dir_{bluray,dvd,other}).');
      error.statusCode = 400;
      throw error;
    }

    const db = await getDb();
    const linkedRows = await db.all(
      `
        SELECT id, raw_path, status, makemkv_info_json, mediainfo_info_json, encode_plan_json, encode_input_path
        FROM jobs
        WHERE raw_path IS NOT NULL AND TRIM(raw_path) <> ''
      `
    );

    const linkedPathMap = new Map();
    for (const row of linkedRows) {
      const resolvedPaths = resolveEffectiveStoragePathsForJob(settings, row);
      const linkedCandidates = [
        normalizeComparablePath(row.raw_path),
        normalizeComparablePath(resolvedPaths.effectiveRawPath)
      ].filter(Boolean);

      for (const linkedPath of linkedCandidates) {
        if (!linkedPathMap.has(linkedPath)) {
          linkedPathMap.set(linkedPath, []);
        }
        linkedPathMap.get(linkedPath).push({
          id: row.id,
          status: row.status
        });
      }
    }

    const orphanRows = [];
    const seenOrphanPaths = new Set();

    for (const rawDir of rawDirs) {
      const rawDirInfo = inspectDirectory(rawDir);
      if (!rawDirInfo.exists || !rawDirInfo.isDirectory) {
        continue;
      }
      const dirEntries = fs.readdirSync(rawDir, { withFileTypes: true });

      for (const entry of dirEntries) {
        if (!entry.isDirectory()) {
          continue;
        }

        const rawPath = path.join(rawDir, entry.name);
        const normalizedPath = normalizeComparablePath(rawPath);
        if (!normalizedPath || linkedPathMap.has(normalizedPath) || seenOrphanPaths.has(normalizedPath)) {
          continue;
        }

        const dirInfo = inspectDirectory(rawPath);
        if (!dirInfo.exists || !dirInfo.isDirectory || dirInfo.isEmpty) {
          continue;
        }

        const stat = fs.statSync(rawPath);
        const metadata = parseRawFolderMetadata(entry.name);
        const detectedMediaType = detectOrphanMediaType(rawPath);
        orphanRows.push({
          rawPath,
          folderName: entry.name,
          title: metadata.title,
          year: metadata.year,
          imdbId: metadata.imdbId,
          folderJobId: metadata.folderJobId,
          entryCount: Number(dirInfo.entryCount || 0),
          detectedMediaType,
          hasBlurayStructure: detectedMediaType === 'bluray',
          hasDvdStructure: detectedMediaType === 'dvd',
          hasCdStructure: detectedMediaType === 'cd',
          lastModifiedAt: stat.mtime.toISOString()
        });
        seenOrphanPaths.add(normalizedPath);
      }
    }

    orphanRows.sort((a, b) => String(b.lastModifiedAt).localeCompare(String(a.lastModifiedAt)));
    return {
      rawDir: rawDirs[0] || null,
      rawDirs,
      rows: orphanRows
    };
  }

  async importOrphanRawFolder(rawPath) {
    const settings = await settingsService.getSettingsMap();
    const rawDirs = getConfiguredMediaPathList(settings, 'raw_dir');
    const requestedRawPath = String(rawPath || '').trim();

    if (!requestedRawPath) {
      const error = new Error('rawPath fehlt.');
      error.statusCode = 400;
      throw error;
    }

    if (rawDirs.length === 0) {
      const error = new Error('Kein RAW-Pfad konfiguriert (raw_dir oder raw_dir_{bluray,dvd,other}).');
      error.statusCode = 400;
      throw error;
    }

    const insideConfiguredRawDir = rawDirs.some((candidate) => isPathInside(candidate, requestedRawPath));
    if (!insideConfiguredRawDir) {
      const error = new Error(`RAW-Pfad liegt außerhalb der konfigurierten RAW-Verzeichnisse: ${requestedRawPath}`);
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

    const renameSteps = [];
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
        renameSteps.push({ from: absRawPath, to: finalRawPath });
      } catch (error) {
        await db.run('DELETE FROM jobs WHERE id = ?', [created.id]);
        const wrapped = new Error(`RAW-Ordner konnte nicht auf neue Job-ID umbenannt werden: ${error.message}`);
        wrapped.statusCode = 500;
        throw wrapped;
      }
    }

    const ripCompleteFolderName = applyRawFolderPrefix(path.basename(finalRawPath), RAW_RIP_COMPLETE_PREFIX);
    const ripCompleteRawPath = path.join(path.dirname(finalRawPath), ripCompleteFolderName);
    const shouldMarkRipComplete = normalizeComparablePath(ripCompleteRawPath) !== normalizeComparablePath(finalRawPath);
    if (shouldMarkRipComplete) {
      if (fs.existsSync(ripCompleteRawPath)) {
        await db.run('DELETE FROM jobs WHERE id = ?', [created.id]);
        const error = new Error(`RAW-Ordner für Rip_Complete-Zustand existiert bereits: ${ripCompleteRawPath}`);
        error.statusCode = 409;
        throw error;
      }

      try {
        const previousRawPath = finalRawPath;
        fs.renameSync(previousRawPath, ripCompleteRawPath);
        finalRawPath = normalizeComparablePath(ripCompleteRawPath);
        renameSteps.push({ from: previousRawPath, to: finalRawPath });
      } catch (error) {
        await db.run('DELETE FROM jobs WHERE id = ?', [created.id]);
        const wrapped = new Error(`RAW-Ordner konnte nicht als Rip_Complete markiert werden: ${error.message}`);
        wrapped.statusCode = 500;
        throw wrapped;
      }
    }

    const detectedMediaType = detectOrphanMediaType(finalRawPath);
    const orphanPosterUrl = omdbById?.poster || null;
    await this.updateJob(created.id, {
      status: 'FINISHED',
      last_state: 'FINISHED',
      title: omdbById?.title || metadata.title || null,
      year: Number.isFinite(Number(omdbById?.year)) ? Number(omdbById.year) : metadata.year,
      imdb_id: omdbById?.imdbId || metadata.imdbId || null,
      poster_url: orphanPosterUrl,
      omdb_json: omdbById?.raw ? JSON.stringify(omdbById.raw) : null,
      selected_from_omdb: omdbById ? 1 : 0,
      rip_successful: 1,
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
        rawPath: finalRawPath,
        mediaProfile: detectedMediaType,
        analyzeContext: {
          mediaProfile: detectedMediaType
        }
      })
    });

    // Bild direkt persistieren (kein Rip-Prozess, daher kein Cache-Zwischenschritt)
    if (orphanPosterUrl) {
      thumbnailService.cacheJobThumbnail(created.id, orphanPosterUrl)
        .then(() => {
          const promotedUrl = thumbnailService.promoteJobThumbnail(created.id);
          if (promotedUrl) return this.updateJob(created.id, { poster_url: promotedUrl });
        })
        .catch(() => {});
    }

    await this.appendLog(
      created.id,
      'SYSTEM',
      renameSteps.length > 0
        ? `Historieneintrag aus RAW erstellt (Medientyp: ${detectedMediaType}). Ordner umbenannt: ${renameSteps.map((step) => `${step.from} -> ${step.to}`).join(' | ')}`
        : `Historieneintrag aus bestehendem RAW-Ordner erstellt: ${finalRawPath} (Medientyp: ${detectedMediaType})`
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
      rawPath: absRawPath,
      detectedMediaType
    });

    const imported = await this.getJobById(created.id);
    return enrichJobRow(imported, settings);
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

    // Bild in Cache laden (async, blockiert nicht)
    if (posterUrl && !thumbnailService.isLocalUrl(posterUrl)) {
      thumbnailService.cacheJobThumbnail(jobId, posterUrl).catch(() => {});
    }

    await this.appendLog(
      jobId,
      'USER_ACTION',
      omdb
        ? `OMDb-Zuordnung aktualisiert: ${omdb.imdbId} (${omdb.title || '-'})`
        : `Metadaten manuell aktualisiert: title="${title || '-'}", year="${year || '-'}", imdb="${imdbId || '-'}"`
    );

    const [updated, settings] = await Promise.all([
      this.getJobById(jobId),
      settingsService.getSettingsMap()
    ]);
    return enrichJobRow(updated, settings);
  }

  async assignCdMetadata(jobId, payload = {}) {
    const job = await this.getJobById(jobId);
    if (!job) {
      const error = new Error('Job nicht gefunden.');
      error.statusCode = 404;
      throw error;
    }

    const title = String(payload.title || '').trim() || null;
    const artist = String(payload.artist || '').trim() || null;
    const yearRaw = Number(payload.year);
    const year = Number.isFinite(yearRaw) && yearRaw > 0 ? Math.trunc(yearRaw) : null;
    const mbId = String(payload.mbId || '').trim() || null;
    const coverUrl = String(payload.coverUrl || '').trim() || null;
    const selectedTracks = Array.isArray(payload.tracks) ? payload.tracks : null;

    if (!title && !artist && !mbId) {
      const error = new Error('Keine CD-Metadaten zum Aktualisieren angegeben.');
      error.statusCode = 400;
      throw error;
    }

    const cdInfo = parseJsonSafe(job.makemkv_info_json, {});
    const tocTracks = Array.isArray(cdInfo.tracks) ? cdInfo.tracks : [];

    let mergedTracks = tocTracks;
    if (selectedTracks && tocTracks.length > 0) {
      mergedTracks = tocTracks.map((t) => {
        const selected = selectedTracks.find((st) => Number(st.position) === Number(t.position));
        const resolvedTitle = String(selected?.title || t.title || `Track ${t.position}`).replace(/\s+/g, ' ').trim();
        const resolvedArtist = String(selected?.artist || t.artist || artist || '').replace(/\s+/g, ' ').trim() || null;
        return {
          ...t,
          title: resolvedTitle,
          artist: resolvedArtist,
          selected: selected ? Boolean(selected.selected) : true
        };
      });
    }

    const prevSelected = cdInfo.selectedMetadata && typeof cdInfo.selectedMetadata === 'object' ? cdInfo.selectedMetadata : {};
    const updatedCdInfo = {
      ...cdInfo,
      tracks: mergedTracks,
      selectedMetadata: {
        ...prevSelected,
        title: title || prevSelected.title || null,
        artist: artist || prevSelected.artist || null,
        year: year !== null ? year : (prevSelected.year || null),
        mbId: mbId || prevSelected.mbId || null,
        coverUrl: coverUrl || prevSelected.coverUrl || null
      }
    };

    await this.updateJob(jobId, {
      title: title || null,
      year: year || null,
      imdb_id: mbId || null,
      poster_url: coverUrl || null,
      makemkv_info_json: JSON.stringify(updatedCdInfo)
    });

    if (coverUrl && !thumbnailService.isLocalUrl(coverUrl)) {
      thumbnailService.cacheJobThumbnail(jobId, coverUrl).catch(() => {});
    }

    await this.appendLog(
      jobId,
      'USER_ACTION',
      `CD-Metadaten aktualisiert: album="${title || '-'}", artist="${artist || '-'}", year="${year || '-'}", mbId="${mbId || '-'}"`
    );

    const [updated, settings] = await Promise.all([
      this.getJobById(jobId),
      settingsService.getSettingsMap()
    ]);
    return enrichJobRow(updated, settings);
  }

  async _resolveRelatedJobsForDeletion(jobId, options = {}) {
    const includeRelated = options?.includeRelated !== false;
    const normalizedJobId = normalizeJobIdValue(jobId);
    if (!normalizedJobId) {
      const error = new Error('Ungültige Job-ID.');
      error.statusCode = 400;
      throw error;
    }

    const db = await getDb();
    const rows = await db.all('SELECT * FROM jobs ORDER BY id ASC');
    const byId = new Map(rows.map((row) => [Number(row.id), row]));
    const primary = byId.get(normalizedJobId);
    if (!primary) {
      const error = new Error('Job nicht gefunden.');
      error.statusCode = 404;
      throw error;
    }

    if (!includeRelated) {
      return [primary];
    }

    const childrenByParent = new Map();
    const childrenBySource = new Map();
    for (const row of rows) {
      const rowId = normalizeJobIdValue(row?.id);
      if (!rowId) {
        continue;
      }
      const parentJobId = normalizeJobIdValue(row?.parent_job_id);
      if (parentJobId) {
        if (!childrenByParent.has(parentJobId)) {
          childrenByParent.set(parentJobId, new Set());
        }
        childrenByParent.get(parentJobId).add(rowId);
      }
      const sourceJobId = parseSourceJobIdFromPlan(row?.encode_plan_json);
      if (sourceJobId) {
        if (!childrenBySource.has(sourceJobId)) {
          childrenBySource.set(sourceJobId, new Set());
        }
        childrenBySource.get(sourceJobId).add(rowId);
      }
    }

    const pending = [normalizedJobId];
    const visited = new Set();
    const enqueue = (value) => {
      const id = normalizeJobIdValue(value);
      if (!id || visited.has(id)) {
        return;
      }
      pending.push(id);
    };

    while (pending.length > 0) {
      const currentId = normalizeJobIdValue(pending.shift());
      if (!currentId || visited.has(currentId)) {
        continue;
      }
      visited.add(currentId);

      const row = byId.get(currentId);
      if (!row) {
        continue;
      }

      enqueue(row.parent_job_id);
      enqueue(parseSourceJobIdFromPlan(row.encode_plan_json));

      for (const childId of (childrenByParent.get(currentId) || [])) {
        enqueue(childId);
      }
      for (const childId of (childrenBySource.get(currentId) || [])) {
        enqueue(childId);
      }

      try {
        const processLog = await this.readProcessLogLines(currentId, { includeAll: true });
        const linkedJobIds = parseRetryLinkedJobIdsFromLogLines(processLog.lines);
        for (const linkedId of linkedJobIds) {
          enqueue(linkedId);
        }
      } catch (_error) {
        // optional fallback links from process logs; ignore read errors
      }
    }

    return Array.from(visited)
      .map((id) => byId.get(id))
      .filter(Boolean)
      .sort((left, right) => Number(left.id || 0) - Number(right.id || 0));
  }

  _collectDeleteCandidatesForJob(job, settings = null, options = {}) {
    const normalizedJobId = normalizeJobIdValue(job?.id);
    const resolvedPaths = resolveEffectiveStoragePathsForJob(settings, job);
    const lineageArtifacts = Array.isArray(options?.lineageArtifacts) ? options.lineageArtifacts : [];
    const toNormalizedPath = (value) => {
      const raw = String(value || '').trim();
      if (!raw) {
        return null;
      }
      return normalizeComparablePath(raw);
    };
    const unique = (values = []) => Array.from(new Set((Array.isArray(values) ? values : []).filter(Boolean)));
    const sanitizeRoots = (values = []) => unique(values).filter((root) => !isFilesystemRootPath(root));

    const artifactRawPaths = lineageArtifacts
      .map((artifact) => toNormalizedPath(artifact?.rawPath))
      .filter(Boolean);
    const artifactMoviePaths = lineageArtifacts
      .map((artifact) => toNormalizedPath(artifact?.outputPath))
      .filter(Boolean);

    const explicitRawPaths = unique([
      toNormalizedPath(job?.raw_path),
      toNormalizedPath(resolvedPaths?.effectiveRawPath),
      ...artifactRawPaths
    ]);
    const explicitMoviePaths = unique([
      toNormalizedPath(job?.output_path),
      toNormalizedPath(resolvedPaths?.effectiveOutputPath),
      ...artifactMoviePaths
    ]);

    const rawRoots = sanitizeRoots([
      ...getConfiguredMediaPathList(settings || {}, 'raw_dir'),
      toNormalizedPath(resolvedPaths?.rawDir),
      ...explicitRawPaths.map((candidatePath) => toNormalizedPath(path.dirname(candidatePath)))
    ]);
    const movieRoots = sanitizeRoots([
      ...getConfiguredMediaPathList(settings || {}, 'movie_dir'),
      toNormalizedPath(resolvedPaths?.movieDir),
      ...explicitMoviePaths.map((candidatePath) => toNormalizedPath(path.dirname(candidatePath)))
    ]);

    const rawCandidates = [];
    const movieCandidates = [];
    const addCandidate = (bucket, target, candidatePath, source, allowedRoots = []) => {
      const normalizedPath = toNormalizedPath(candidatePath);
      if (!normalizedPath) {
        return;
      }
      if (isFilesystemRootPath(normalizedPath)) {
        return;
      }
      const roots = Array.isArray(allowedRoots) ? allowedRoots.filter(Boolean) : [];
      if (roots.length > 0 && !roots.some((root) => isPathInside(root, normalizedPath))) {
        return;
      }
      bucket.push({
        target,
        path: normalizedPath,
        source,
        jobId: normalizedJobId
      });
    };

    const artifactRawPathSet = new Set(artifactRawPaths);
    for (const rawPath of explicitRawPaths) {
      addCandidate(
        rawCandidates,
        'raw',
        rawPath,
        artifactRawPathSet.has(rawPath) ? 'lineage_raw_path' : 'raw_path',
        rawRoots
      );
    }

    const rawFolderNames = new Set();
    for (const rawPath of explicitRawPaths) {
      const folderName = String(path.basename(rawPath || '') || '').trim();
      if (!folderName || folderName === '.' || folderName === path.sep) {
        continue;
      }
      rawFolderNames.add(folderName);
      const stripped = stripRawFolderStatePrefix(folderName);
      if (stripped) {
        rawFolderNames.add(stripped);
        rawFolderNames.add(applyRawFolderPrefix(stripped, RAW_INCOMPLETE_PREFIX));
        rawFolderNames.add(applyRawFolderPrefix(stripped, RAW_RIP_COMPLETE_PREFIX));
      }
    }
    for (const rootPath of rawRoots) {
      for (const folderName of rawFolderNames) {
        addCandidate(rawCandidates, 'raw', path.join(rootPath, folderName), 'raw_variant', rawRoots);
      }
    }

    if (normalizedJobId) {
      for (const rootPath of rawRoots) {
        try {
          if (!fs.existsSync(rootPath) || !fs.lstatSync(rootPath).isDirectory()) {
            continue;
          }
          const entries = fs.readdirSync(rootPath, { withFileTypes: true });
          for (const entry of entries) {
            if (!entry?.isDirectory?.()) {
              continue;
            }
            const metadata = parseRawFolderMetadata(entry.name);
            if (normalizeJobIdValue(metadata?.folderJobId) === normalizedJobId) {
              addCandidate(
                rawCandidates,
                'raw',
                path.join(rootPath, entry.name),
                'raw_jobid_scan',
                rawRoots
              );
            }
          }
        } catch (_error) {
          // ignore fs errors while collecting optional candidates
        }
      }
    }

    const artifactMoviePathSet = new Set(artifactMoviePaths);
    for (const outputPath of explicitMoviePaths) {
      addCandidate(
        movieCandidates,
        'movie',
        outputPath,
        artifactMoviePathSet.has(outputPath) ? 'lineage_output_path' : 'output_path',
        movieRoots
      );
      const parentDir = toNormalizedPath(path.dirname(outputPath));
      if (parentDir && !movieRoots.includes(parentDir)) {
        addCandidate(
          movieCandidates,
          'movie',
          parentDir,
          artifactMoviePathSet.has(outputPath) ? 'lineage_output_parent' : 'output_parent',
          movieRoots
        );
      }
    }

    if (normalizedJobId) {
      const incompleteName = `Incomplete_job-${normalizedJobId}`;
      for (const rootPath of movieRoots) {
        addCandidate(movieCandidates, 'movie', path.join(rootPath, incompleteName), 'movie_incomplete_folder', movieRoots);
        try {
          if (!fs.existsSync(rootPath) || !fs.lstatSync(rootPath).isDirectory()) {
            continue;
          }
          const entries = fs.readdirSync(rootPath, { withFileTypes: true });
          for (const entry of entries) {
            if (!entry?.isDirectory?.()) {
              continue;
            }
            const match = String(entry.name || '').match(/^incomplete_job-(\d+)\s*$/i);
            if (normalizeJobIdValue(match?.[1]) !== normalizedJobId) {
              continue;
            }
            addCandidate(
              movieCandidates,
              'movie',
              path.join(rootPath, entry.name),
              'movie_incomplete_scan',
              movieRoots
            );
          }
        } catch (_error) {
          // ignore fs errors while collecting optional candidates
        }
      }
    }

    return {
      rawCandidates,
      movieCandidates,
      rawRoots,
      movieRoots
    };
  }

  _buildDeletePreviewFromJobs(jobs = [], settings = null, lineageArtifactsByJobId = null) {
    const rows = Array.isArray(jobs) ? jobs : [];
    const artifactsMap = lineageArtifactsByJobId instanceof Map ? lineageArtifactsByJobId : new Map();
    const candidateMap = new Map();
    const protectedRoots = {
      raw: new Set(),
      movie: new Set()
    };
    const upsertCandidate = (candidate) => {
      const target = String(candidate?.target || '').trim().toLowerCase();
      const candidatePath = String(candidate?.path || '').trim();
      if (!target || !candidatePath) {
        return;
      }
      const key = `${target}:${candidatePath}`;
      if (!candidateMap.has(key)) {
        candidateMap.set(key, {
          target,
          path: candidatePath,
          jobIds: new Set(),
          sources: new Set()
        });
      }
      const row = candidateMap.get(key);
      const candidateJobId = normalizeJobIdValue(candidate?.jobId);
      if (candidateJobId) {
        row.jobIds.add(candidateJobId);
      }
      const source = String(candidate?.source || '').trim();
      if (source) {
        row.sources.add(source);
      }
    };

    for (const job of rows) {
      const lineageArtifacts = artifactsMap.get(normalizeJobIdValue(job?.id)) || [];
      const collected = this._collectDeleteCandidatesForJob(job, settings, { lineageArtifacts });
      for (const rootPath of collected.rawRoots || []) {
        protectedRoots.raw.add(rootPath);
      }
      for (const rootPath of collected.movieRoots || []) {
        protectedRoots.movie.add(rootPath);
      }
      for (const candidate of collected.rawCandidates || []) {
        upsertCandidate(candidate);
      }
      for (const candidate of collected.movieCandidates || []) {
        upsertCandidate(candidate);
      }
    }

    const buildList = (target) => Array.from(candidateMap.values())
      .filter((row) => row.target === target)
      .map((row) => {
        const inspection = inspectDeletionPath(row.path);
        return {
          target,
          path: row.path,
          exists: Boolean(inspection.exists),
          isDirectory: Boolean(inspection.isDirectory),
          isFile: Boolean(inspection.isFile),
          jobIds: Array.from(row.jobIds).sort((left, right) => left - right),
          sources: Array.from(row.sources).sort((left, right) => left.localeCompare(right))
        };
      })
      .sort((left, right) => String(left.path || '').localeCompare(String(right.path || ''), 'de'));

    return {
      pathCandidates: {
        raw: buildList('raw'),
        movie: buildList('movie')
      },
      protectedRoots: {
        raw: Array.from(protectedRoots.raw).sort((left, right) => left.localeCompare(right)),
        movie: Array.from(protectedRoots.movie).sort((left, right) => left.localeCompare(right))
      }
    };
  }

  async getJobDeletePreview(jobId, options = {}) {
    const includeRelated = options?.includeRelated !== false;
    const normalizedJobId = normalizeJobIdValue(jobId);
    if (!normalizedJobId) {
      const error = new Error('Ungültige Job-ID.');
      error.statusCode = 400;
      throw error;
    }

    const jobs = await this._resolveRelatedJobsForDeletion(normalizedJobId, { includeRelated });
    const settings = await settingsService.getSettingsMap();
    const lineageArtifactsByJobId = await this.listJobLineageArtifactsByJobIds(
      jobs.map((job) => normalizeJobIdValue(job?.id)).filter(Boolean)
    );
    const preview = this._buildDeletePreviewFromJobs(jobs, settings, lineageArtifactsByJobId);
    const relatedJobs = jobs.map((job) => ({
      id: Number(job.id),
      parentJobId: normalizeJobIdValue(job.parent_job_id),
      title: buildJobDisplayTitle(job),
      status: String(job.status || '').trim() || null,
      isPrimary: Number(job.id) === normalizedJobId,
      createdAt: String(job.created_at || '').trim() || null
    }));
    const existingRawCandidates = preview.pathCandidates.raw.filter((row) => row.exists).length;
    const existingMovieCandidates = preview.pathCandidates.movie.filter((row) => row.exists).length;

    return {
      jobId: normalizedJobId,
      includeRelated,
      relatedJobs,
      pathCandidates: preview.pathCandidates,
      protectedRoots: preview.protectedRoots,
      counts: {
        relatedJobs: relatedJobs.length,
        rawCandidates: preview.pathCandidates.raw.length,
        movieCandidates: preview.pathCandidates.movie.length,
        existingRawCandidates,
        existingMovieCandidates
      }
    };
  }

  _deletePathsFromPreview(preview, target = 'both') {
    const normalizedTarget = String(target || 'both').trim().toLowerCase();
    const includesRaw = normalizedTarget === 'raw' || normalizedTarget === 'both';
    const includesMovie = normalizedTarget === 'movie' || normalizedTarget === 'both';

    const summary = {
      target: normalizedTarget,
      raw: { attempted: includesRaw, deleted: false, filesDeleted: 0, dirsRemoved: 0, pathsDeleted: 0, reason: null },
      movie: { attempted: includesMovie, deleted: false, filesDeleted: 0, dirsRemoved: 0, pathsDeleted: 0, reason: null },
      deletedPaths: []
    };

    const applyTarget = (targetKey) => {
      const candidates = (Array.isArray(preview?.pathCandidates?.[targetKey]) ? preview.pathCandidates[targetKey] : [])
        .filter((item) => Boolean(item?.exists) && (Boolean(item?.isDirectory) || Boolean(item?.isFile)));
      if (candidates.length === 0) {
        summary[targetKey].reason = 'Keine passenden Dateien/Ordner gefunden.';
        return;
      }

      const protectedRoots = new Set(
        (Array.isArray(preview?.protectedRoots?.[targetKey]) ? preview.protectedRoots[targetKey] : [])
          .map((rootPath) => String(rootPath || '').trim())
          .filter(Boolean)
          .map((rootPath) => normalizeComparablePath(rootPath))
      );

      const orderedCandidates = [...candidates].sort(
        (left, right) => String(right?.path || '').length - String(left?.path || '').length
      );
      for (const candidate of orderedCandidates) {
        const candidatePath = String(candidate?.path || '').trim();
        if (!candidatePath) {
          continue;
        }
        const inspection = inspectDeletionPath(candidatePath);
        if (!inspection.exists) {
          continue;
        }

        if (inspection.isDirectory) {
          const keepRoot = protectedRoots.has(inspection.path);
          const result = deleteFilesRecursively(inspection.path, keepRoot);
          const filesDeleted = Number(result?.filesDeleted || 0);
          const dirsRemoved = Number(result?.dirsRemoved || 0);
          const directoryRemoved = !keepRoot && !fs.existsSync(inspection.path);
          const changed = filesDeleted > 0 || dirsRemoved > 0 || directoryRemoved;
          summary[targetKey].filesDeleted += filesDeleted;
          summary[targetKey].dirsRemoved += dirsRemoved;
          if (changed) {
            summary[targetKey].pathsDeleted += 1;
            summary.deletedPaths.push({
              target: targetKey,
              path: inspection.path,
              type: 'directory',
              keepRoot,
              jobIds: Array.isArray(candidate?.jobIds) ? candidate.jobIds : []
            });
          }
          continue;
        }

        fs.unlinkSync(inspection.path);
        summary[targetKey].filesDeleted += 1;
        summary[targetKey].pathsDeleted += 1;
        summary.deletedPaths.push({
          target: targetKey,
          path: inspection.path,
          type: 'file',
          keepRoot: false,
          jobIds: Array.isArray(candidate?.jobIds) ? candidate.jobIds : []
        });
      }

      summary[targetKey].deleted = summary[targetKey].pathsDeleted > 0
        || summary[targetKey].filesDeleted > 0
        || summary[targetKey].dirsRemoved > 0;
      if (!summary[targetKey].deleted) {
        summary[targetKey].reason = 'Keine vorhandenen Dateien/Ordner gelöscht.';
      }
    };

    if (includesRaw) {
      applyTarget('raw');
    }
    if (includesMovie) {
      applyTarget('movie');
    }

    return summary;
  }

  _deleteProcessLogFile(jobId) {
    const processLogPath = toProcessLogPath(jobId);
    if (!processLogPath || !fs.existsSync(processLogPath)) {
      return;
    }
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
    const resolvedPaths = resolveEffectiveStoragePathsForJob(settings, job);
    const effectiveRawPath = resolvedPaths.effectiveRawPath;
    const effectiveOutputPath = resolvedPaths.effectiveOutputPath;
    const effectiveRawDir = resolvedPaths.rawDir;
    const effectiveMovieDir = resolvedPaths.movieDir;
    const summary = {
      target,
      raw: { attempted: false, deleted: false, filesDeleted: 0, dirsRemoved: 0, reason: null },
      movie: { attempted: false, deleted: false, filesDeleted: 0, dirsRemoved: 0, reason: null }
    };

    if (target === 'raw' || target === 'both') {
      summary.raw.attempted = true;
      if (!effectiveRawPath) {
        summary.raw.reason = 'Kein raw_path im Job gesetzt.';
      } else if (!effectiveRawDir) {
        const error = new Error(`Kein gültiger RAW-Basispfad für Job ${jobId} (${resolvedPaths.mediaType || 'unknown'}).`);
        error.statusCode = 400;
        throw error;
      } else if (!isPathInside(effectiveRawDir, effectiveRawPath)) {
        const error = new Error(`RAW-Pfad liegt außerhalb des effektiven RAW-Basispfads: ${effectiveRawPath}`);
        error.statusCode = 400;
        throw error;
      } else if (!fs.existsSync(effectiveRawPath)) {
        summary.raw.reason = 'RAW-Pfad existiert nicht.';
      } else {
        const rawPath = normalizeComparablePath(effectiveRawPath);
        const rawRoot = normalizeComparablePath(effectiveRawDir);
        const keepRoot = rawPath === rawRoot;
        const result = deleteFilesRecursively(effectiveRawPath, keepRoot);
        summary.raw.deleted = true;
        summary.raw.filesDeleted = result.filesDeleted;
        summary.raw.dirsRemoved = result.dirsRemoved;
      }
    }

    if (target === 'movie' || target === 'both') {
      summary.movie.attempted = true;
      if (!effectiveOutputPath) {
        summary.movie.reason = 'Kein output_path im Job gesetzt.';
      } else if (!effectiveMovieDir) {
        const error = new Error(`Kein gültiger Movie-Basispfad für Job ${jobId} (${resolvedPaths.mediaType || 'unknown'}).`);
        error.statusCode = 400;
        throw error;
      } else if (!isPathInside(effectiveMovieDir, effectiveOutputPath)) {
        const error = new Error(`Movie-Pfad liegt außerhalb des effektiven Movie-Basispfads: ${effectiveOutputPath}`);
        error.statusCode = 400;
        throw error;
      } else if (!fs.existsSync(effectiveOutputPath)) {
        summary.movie.reason = 'Movie-Datei/Pfad existiert nicht.';
      } else {
        const outputPath = normalizeComparablePath(effectiveOutputPath);
        const movieRoot = normalizeComparablePath(effectiveMovieDir);
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

    const [updated, enrichSettings] = await Promise.all([
      this.getJobById(jobId),
      settingsService.getSettingsMap()
    ]);
    return {
      summary,
      job: enrichJobRow(updated, enrichSettings)
    };
  }

  async deleteJob(jobId, fileTarget = 'none', options = {}) {
    const allowedTargets = new Set(['none', 'raw', 'movie', 'both']);
    if (!allowedTargets.has(fileTarget)) {
      const error = new Error(`Ungültiges target '${fileTarget}'. Erlaubt: none, raw, movie, both.`);
      error.statusCode = 400;
      throw error;
    }

    const includeRelated = Boolean(options?.includeRelated);
    if (!includeRelated) {
      const existing = await this.getJobById(jobId);
      if (!existing) {
        const error = new Error('Job nicht gefunden.');
        error.statusCode = 404;
        throw error;
      }

      let fileSummary = null;
      if (fileTarget !== 'none') {
        const preview = await this.getJobDeletePreview(jobId, { includeRelated: false });
        fileSummary = this._deletePathsFromPreview(preview, fileTarget);
      }

      const db = await getDb();
      const pipelineRow = await db.get(
        'SELECT state, active_job_id FROM pipeline_state WHERE id = 1'
      );

      const isActivePipelineJob = Number(pipelineRow?.active_job_id || 0) === Number(jobId);
      const runningStates = new Set(['ANALYZING', 'RIPPING', 'MEDIAINFO_CHECK', 'ENCODING', 'CD_ANALYZING', 'CD_RIPPING', 'CD_ENCODING']);

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
      this._deleteProcessLogFile(jobId);
      thumbnailService.deleteThumbnail(jobId);

      logger.warn('job:deleted', {
        jobId,
        fileTarget,
        includeRelated: false,
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
        includeRelated: false,
        deletedJobIds: [Number(jobId)],
        fileSummary
      };
    }

    const normalizedJobId = normalizeJobIdValue(jobId);
    const preview = await this.getJobDeletePreview(normalizedJobId, { includeRelated: true });
    const deleteJobIds = Array.isArray(preview?.relatedJobs)
      ? preview.relatedJobs
        .map((row) => normalizeJobIdValue(row?.id))
        .filter(Boolean)
      : [];
    if (deleteJobIds.length === 0) {
      const error = new Error('Keine löschbaren Historien-Einträge gefunden.');
      error.statusCode = 404;
      throw error;
    }

    const db = await getDb();
    const pipelineRow = await db.get('SELECT state, active_job_id FROM pipeline_state WHERE id = 1');
    const activePipelineJobId = normalizeJobIdValue(pipelineRow?.active_job_id);
    const activeJobIncluded = Boolean(activePipelineJobId && deleteJobIds.includes(activePipelineJobId));
    const runningStates = new Set(['ANALYZING', 'RIPPING', 'MEDIAINFO_CHECK', 'ENCODING', 'CD_ANALYZING', 'CD_RIPPING', 'CD_ENCODING']);
    if (activeJobIncluded && runningStates.has(String(pipelineRow?.state || ''))) {
      const error = new Error('Aktiver Pipeline-Job kann nicht gelöscht werden. Bitte zuerst abbrechen.');
      error.statusCode = 409;
      throw error;
    }

    let fileSummary = null;
    if (fileTarget !== 'none') {
      fileSummary = this._deletePathsFromPreview(preview, fileTarget);
    }

    await db.exec('BEGIN');
    try {
      if (activeJobIncluded) {
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
        const placeholders = deleteJobIds.map(() => '?').join(', ');
        await db.run(
          `
            UPDATE pipeline_state
            SET
              active_job_id = NULL,
              updated_at = CURRENT_TIMESTAMP
            WHERE id = 1 AND active_job_id IN (${placeholders})
          `,
          deleteJobIds
        );
      }

      const deletePlaceholders = deleteJobIds.map(() => '?').join(', ');
      await db.run(`DELETE FROM jobs WHERE id IN (${deletePlaceholders})`, deleteJobIds);
      await db.exec('COMMIT');
    } catch (error) {
      await db.exec('ROLLBACK');
      throw error;
    }

    for (const deletedJobId of deleteJobIds) {
      await this.closeProcessLog(deletedJobId);
      this._deleteProcessLogFile(deletedJobId);
      thumbnailService.deleteThumbnail(deletedJobId);
    }

    logger.warn('job:deleted', {
      jobId: normalizedJobId,
      fileTarget,
      includeRelated: true,
      deletedJobIds: deleteJobIds,
      deletedJobCount: deleteJobIds.length,
      pipelineStateReset: activeJobIncluded,
      filesDeleted: fileSummary
        ? {
          raw: fileSummary.raw?.filesDeleted ?? 0,
          movie: fileSummary.movie?.filesDeleted ?? 0
        }
        : { raw: 0, movie: 0 }
    });

    return {
      deleted: true,
      jobId: normalizedJobId,
      fileTarget,
      includeRelated: true,
      deletedJobIds: deleteJobIds,
      deletedJobs: preview.relatedJobs,
      fileSummary
    };
  }
}

module.exports = new HistoryService();
