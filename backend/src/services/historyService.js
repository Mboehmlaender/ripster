const { getDb } = require('../db/database');
const logger = require('./logger').child('HISTORY');
const fs = require('fs');
const path = require('path');
const { defaultConverterRawDir } = require('../config');
const settingsService = require('./settingsService');
const tmdbService = require('./tmdbService');
const cdRipService = require('./cdRipService');
const { getJobLogDir } = require('./logPathService');
const thumbnailService = require('./thumbnailService');
const { getServerTimestamp } = require('../utils/serverTime');

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
const PROFILE_PATH_SUFFIXES = ['bluray', 'dvd', 'cd', 'audiobook', 'converter', 'other'];
const RAW_INCOMPLETE_PREFIX = 'Incomplete_';
const RAW_RIP_COMPLETE_PREFIX = 'Rip_Complete_';
const PROCESS_LOG_FILE_PATTERN = /^job-(\d+)\.process\.log$/i;
const CD_OUTPUT_AUDIO_EXTENSIONS = new Set(['.flac', '.wav', '.mp3', '.opus', '.ogg']);
const CD_RAW_TRACK_FILE_PATTERN = /^track(\d{1,3})\.cdda\.wav$/i;
const INCOMPLETE_OUTPUT_PATH_PATTERN = /(^|[\\/])incomplete_job-\d+([\\/]|$)/i;
const INCOMPLETE_MERGE_OUTPUT_PATH_PATTERN = /(^|[\\/])incomplete_merge_[^\\/]+_job_\d+([\\/]|$)/i;

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

function isIncompleteRawStoragePath(rawPath) {
  const normalized = String(rawPath || '').trim();
  if (!normalized) {
    return false;
  }
  const baseName = path.basename(normalized);
  return /^incomplete_/i.test(baseName);
}

function isIncompleteOutputStoragePath(outputPath) {
  const normalized = String(outputPath || '').trim();
  if (!normalized) {
    return false;
  }
  return INCOMPLETE_OUTPUT_PATH_PATTERN.test(normalized)
    || INCOMPLETE_MERGE_OUTPUT_PATH_PATTERN.test(normalized);
}

function parseBooleanValue(value, fallback = false) {
  if (value === null || value === undefined) {
    return fallback;
  }
  if (typeof value === 'boolean') {
    return value;
  }
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) {
    return fallback;
  }
  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }
  return fallback;
}

function resolveNfoPathFromOutputPath(outputPath) {
  const normalizedOutputPath = String(outputPath || '').trim();
  if (!normalizedOutputPath) {
    return null;
  }
  const parsed = path.parse(normalizedOutputPath);
  const extension = String(parsed.ext || '').trim();
  const baseName = String(parsed.name || '').trim();
  if (!extension || !baseName) {
    return null;
  }
  return path.join(parsed.dir, `${baseName}.nfo`);
}

function inspectNfoFileStatus(nfoPath, options = {}) {
  const includeFsChecks = options?.includeFsChecks !== false;
  if (!nfoPath) {
    return {
      path: null,
      exists: false,
      isFile: false,
      sizeBytes: null
    };
  }
  if (!includeFsChecks) {
    return {
      path: nfoPath,
      exists: null,
      isFile: null,
      sizeBytes: null
    };
  }
  try {
    const stat = fs.statSync(nfoPath);
    return {
      path: nfoPath,
      exists: true,
      isFile: stat.isFile(),
      sizeBytes: stat.size
    };
  } catch (_error) {
    return {
      path: nfoPath,
      exists: false,
      isFile: false,
      sizeBytes: null
    };
  }
}

function escapeXml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function resolveNfoMetadataFromJob(job = {}) {
  const mkInfo = parseInfoFromValue(job?.makemkvInfo ?? job?.makemkv_info_json, {});
  const selectedMetadata = extractSelectedMetadataFromMakemkvInfo(mkInfo);
  const encodePlan = parseInfoFromValue(job?.encodePlan ?? job?.encode_plan_json, {});
  const planMetadata = encodePlan?.metadata && typeof encodePlan.metadata === 'object'
    ? encodePlan.metadata
    : {};

  const title = String(
    job?.title
    || selectedMetadata?.title
    || selectedMetadata?.seriesTitle
    || planMetadata?.title
    || job?.detected_title
    || ''
  ).trim();
  const rawYear = Number(
    job?.year
    ?? selectedMetadata?.year
    ?? planMetadata?.year
    ?? null
  );
  const year = Number.isFinite(rawYear) && rawYear > 0
    ? Math.trunc(rawYear)
    : null;
  const imdbId = String(
    job?.imdb_id
    || selectedMetadata?.imdbId
    || planMetadata?.imdbId
    || ''
  ).trim();

  return {
    title,
    year,
    imdbId
  };
}

function buildNfoXml(metadata = {}) {
  const title = escapeXml(metadata?.title || '');
  const year = metadata?.year !== null && metadata?.year !== undefined
    ? escapeXml(String(metadata.year))
    : '';
  const imdbId = escapeXml(metadata?.imdbId || '');
  return [
    '<movie>',
    `  <title>${title}</title>`,
    `  <year>${year}</year>`,
    `  <imdbid>${imdbId}</imdbid>`,
    '</movie>',
    ''
  ].join('\n');
}

function resolveConverterMediaTypeForNfo(job = {}, encodePlan = null) {
  const plan = encodePlan && typeof encodePlan === 'object'
    ? encodePlan
    : parseInfoFromValue(job?.encodePlan ?? job?.encode_plan_json, {});
  const mkInfo = parseInfoFromValue(job?.makemkvInfo ?? job?.makemkv_info_json, {});
  const miInfo = parseInfoFromValue(job?.mediainfoInfo ?? job?.mediainfo_info_json, {});
  const candidates = [
    plan?.converterMediaType,
    job?.converterMediaType,
    mkInfo?.converterMediaType,
    miInfo?.converterMediaType
  ];
  for (const candidate of candidates) {
    const raw = String(candidate || '').trim().toLowerCase();
    if (raw === 'audio' || raw === 'video' || raw === 'iso') {
      return raw;
    }
  }
  return null;
}

function resolveNfoSupportForJob(job = {}, settings = {}, options = {}) {
  const mkInfo = parseInfoFromValue(job?.makemkvInfo ?? job?.makemkv_info_json, {});
  const miInfo = parseInfoFromValue(job?.mediainfoInfo ?? job?.mediainfo_info_json, {});
  const plan = parseInfoFromValue(job?.encodePlan ?? job?.encode_plan_json, {});
  const hbInfo = parseInfoFromValue(job?.handbrakeInfo ?? job?.handbrake_info_json, {});
  const selectedMetadata = extractSelectedMetadataFromMakemkvInfo(mkInfo);
  const analyzeContext = mkInfo?.analyzeContext && typeof mkInfo.analyzeContext === 'object'
    ? mkInfo.analyzeContext
    : {};
  const mediaType = normalizeMediaTypeValue(options?.mediaType)
    || normalizeMediaTypeValue(job?.mediaType)
    || normalizeMediaTypeValue(job?.media_type)
    || inferMediaType(job, mkInfo, miInfo, plan, hbInfo);
  const normalizedJobKind = String(job?.job_kind || job?.jobKind || '').trim().toLowerCase();
  const hasSeriesJobKind = normalizedJobKind === 'dvd_series_child' || normalizedJobKind === 'dvd_series_container';
  const hasSeriesMetadata = hasSeriesMetadataSignals(selectedMetadata, analyzeContext);
  const hasSeriesRawPathHint = isLikelySeriesRawPath(job?.raw_path, settings || {});
  const seriesBatchMode = String(hbInfo?.mode || '').trim().toLowerCase() === 'series_batch'
    || Boolean(plan?.seriesBatchChild)
    || Boolean(plan?.seriesBatchVirtualEpisode);
  const isSeriesMedia = (mediaType === 'dvd' || mediaType === 'bluray') && (
    hasSeriesJobKind
    || hasSeriesMetadata
    || hasSeriesRawPathHint
    || seriesBatchMode
  );

  const outputPath = String(options?.outputPath || '').trim();
  const outputExt = String(path.extname(outputPath || '') || '').trim().toLowerCase();
  const audioOutputExtensions = new Set([
    '.flac', '.wav', '.mp3', '.opus', '.ogg', '.m4a', '.m4b', '.aac', '.alac', '.aif', '.aiff', '.wma'
  ]);
  const converterMediaType = resolveConverterMediaTypeForNfo(job, plan);

  let supported = false;
  if (mediaType === 'bluray' || mediaType === 'dvd') {
    supported = !isSeriesMedia;
  } else if (mediaType === 'converter') {
    if (converterMediaType === 'audio') {
      supported = false;
    } else if (converterMediaType === 'video' || converterMediaType === 'iso') {
      supported = true;
    } else {
      supported = !audioOutputExtensions.has(outputExt);
    }
  }

  return {
    supported,
    mediaType: mediaType || null,
    converterMediaType,
    isSeriesMedia
  };
}

function buildNfoStatusForJob({
  job = {},
  outputPath = null,
  outputStatus = null,
  includeFsChecks = true,
  settings = {},
  mediaType = null
} = {}) {
  const normalizedOutputPath = String(outputPath || '').trim() || null;
  const nfoPath = resolveNfoPathFromOutputPath(normalizedOutputPath);
  const nfoStatus = inspectNfoFileStatus(nfoPath, { includeFsChecks });
  const nfoSettingEnabled = parseBooleanValue(
    settings?.generate_nfo_after_encode,
    false
  );
  const supportInfo = resolveNfoSupportForJob(job, settings, {
    mediaType,
    outputPath: normalizedOutputPath
  });
  const outputExists = Boolean(outputStatus?.exists);
  const outputIsFile = Boolean(outputStatus?.isFile);
  const canGenerateManual = Boolean(supportInfo?.supported)
    && !nfoSettingEnabled
    && Boolean(nfoPath)
    && outputExists
    && outputIsFile
    && !Boolean(nfoStatus?.exists);

  let reason = null;
  if (!supportInfo?.supported) {
    reason = 'unsupported_media';
  } else if (nfoSettingEnabled) {
    reason = 'setting_enabled';
  } else if (!nfoPath) {
    reason = 'output_not_file';
  } else if (!outputExists || !outputIsFile) {
    reason = 'output_missing';
  } else if (Boolean(nfoStatus?.exists)) {
    reason = 'nfo_exists';
  } else {
    reason = 'eligible';
  }

  return {
    settingEnabled: nfoSettingEnabled,
    supported: Boolean(supportInfo?.supported),
    mediaType: supportInfo?.mediaType || null,
    converterMediaType: supportInfo?.converterMediaType || null,
    isSeriesMedia: Boolean(supportInfo?.isSeriesMedia),
    outputPath: normalizedOutputPath,
    nfoPath,
    outputExists: includeFsChecks ? outputExists : null,
    outputIsFile: includeFsChecks ? outputIsFile : null,
    nfoExists: includeFsChecks ? Boolean(nfoStatus?.exists) : null,
    canGenerateManual,
    reason
  };
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

function isOrphanRawImportMakemkvInfo(makemkvInfo = null) {
  const info = makemkvInfo && typeof makemkvInfo === 'object' ? makemkvInfo : {};
  const source = String(
    info?.source
    || info?.importRecovery?.source
    || ''
  ).trim().toLowerCase();
  return source === 'orphan_raw_import';
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

function hasAudiobookStructure(rawPath) {
  const basePath = String(rawPath || '').trim();
  if (!basePath) {
    return false;
  }

  try {
    if (!fs.existsSync(basePath)) {
      return false;
    }
    const stat = fs.statSync(basePath);
    if (stat.isFile()) {
      return path.extname(basePath).toLowerCase() === '.aax';
    }
    if (!stat.isDirectory()) {
      return false;
    }
    const entries = fs.readdirSync(basePath);
    return entries.some((entry) => path.extname(entry).toLowerCase() === '.aax');
  } catch (_error) {
    return false;
  }
}

function hasNestedMediaStructure(rawPath, detector, maxDepth = 2) {
  const startPath = String(rawPath || '').trim();
  if (!startPath || typeof detector !== 'function') {
    return false;
  }

  const normalizedMaxDepth = Number.isFinite(Number(maxDepth))
    ? Math.max(0, Math.trunc(Number(maxDepth)))
    : 0;
  const queue = [{ currentPath: startPath, depth: 0 }];
  const visited = new Set();

  while (queue.length > 0) {
    const next = queue.shift();
    const currentPath = String(next?.currentPath || '').trim();
    const depth = Number(next?.depth || 0);
    if (!currentPath) {
      continue;
    }
    const normalizedPath = normalizeComparablePath(currentPath);
    if (!normalizedPath || visited.has(normalizedPath)) {
      continue;
    }
    visited.add(normalizedPath);

    if (detector(currentPath)) {
      return true;
    }
    if (depth >= normalizedMaxDepth) {
      continue;
    }

    try {
      const entries = fs.readdirSync(currentPath, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry?.isDirectory?.() || isHiddenDirectoryName(entry.name)) {
          continue;
        }
        queue.push({
          currentPath: path.join(currentPath, entry.name),
          depth: depth + 1
        });
      }
    } catch (_error) {
      // ignore fs errors while traversing nested structures
    }
  }

  return false;
}

function detectOrphanMediaType(rawPath, options = {}) {
  if (hasBlurayStructure(rawPath)) {
    return 'bluray';
  }
  if (hasDvdStructure(rawPath)) {
    return 'dvd';
  }
  // Some RAW folders contain one or two nested disc directories (e.g. ".../Rip_Complete_XYZ/.../VIDEO_TS").
  // Inspect nested folders as fallback so these imports are not classified as "other".
  if (hasNestedMediaStructure(rawPath, hasBlurayStructure, 2)) {
    return 'bluray';
  }
  if (hasNestedMediaStructure(rawPath, hasDvdStructure, 2)) {
    return 'dvd';
  }
  if (hasCdStructure(rawPath)) {
    return 'cd';
  }
  if (hasAudiobookStructure(rawPath)) {
    return 'audiobook';
  }
  if (options?.seriesRawPathHint) {
    return 'dvd';
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
  if (raw === 'audiobook' || raw === 'audio_book' || raw === 'audio book' || raw === 'book') {
    return 'audiobook';
  }
  return null;
}

function normalizeJobKindValue(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) {
    return null;
  }
  if (
    raw === 'audiobook'
    || raw === 'cd'
    || raw === 'dvd'
    || raw === 'bluray'
    || raw === 'dvd_series_container'
    || raw === 'dvd_series_child'
    || raw === 'multipart_movie_container'
    || raw === 'multipart_movie_child'
    || raw === 'multipart_movie_merge'
  ) {
    return raw;
  }
  if (raw === 'converter_audio' || raw === 'converter_video' || raw === 'converter_iso') {
    return raw;
  }
  return null;
}

function inferMediaTypeFromJobKind(value) {
  const normalized = normalizeJobKindValue(value);
  if (normalized === 'converter_audio' || normalized === 'converter_video' || normalized === 'converter_iso') {
    return 'converter';
  }
  if (normalized === 'audiobook' || normalized === 'cd' || normalized === 'dvd' || normalized === 'bluray') {
    return normalized;
  }
  const legacy = String(value || '').trim().toLowerCase();
  if (legacy === 'converter') {
    return 'converter';
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

  if (profileHint === 'bluray' || profileHint === 'dvd' || profileHint === 'cd' || profileHint === 'audiobook') {
    return profileHint;
  }

  const profileFromJobKind = inferMediaTypeFromJobKind(
    job?.job_kind
    || plan?.jobKind
    || mkInfo?.jobKind
    || mkInfo?.analyzeContext?.jobKind
    || miInfo?.jobKind
    || hbInfo?.jobKind
  );
  if (profileFromJobKind) {
    return profileFromJobKind;
  }

  // Converter jobs: detected via media_type field (plan.mediaProfile = 'converter')
  const rawMediaType = normalizeMediaTypeValue(job?.media_type);
  const rawMediaTypeLegacy = String(job?.media_type || '').trim().toLowerCase();
  const rawPlanProfile = String(plan?.mediaProfile || '').trim().toLowerCase();
  const converterMediaTypeHint = String(plan?.converterMediaType || '').trim().toLowerCase();
  const hasConverterPathHint = (value) => {
    const normalized = String(value || '')
      .trim()
      .replace(/\\/g, '/')
      .toLowerCase();
    if (!normalized) {
      return false;
    }
    return /(^|\/)converter(\/|$)/.test(normalized);
  };
  if (
    rawPlanProfile === 'converter'
    || rawMediaType === 'converter'
    || rawMediaTypeLegacy === 'converter'
    || converterMediaTypeHint === 'video'
    || converterMediaTypeHint === 'audio'
    || converterMediaTypeHint === 'iso'
    || hasConverterPathHint(rawPath)
    || hasConverterPathHint(encodeInputPath)
    || hasConverterPathHint(plan?.inputPath)
  ) {
    return 'converter';
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
  if (hasAudiobookStructure(rawPath) || hasAudiobookStructure(encodeInputPath)) {
    return 'audiobook';
  }
  if (['audiobook_encode', 'audiobook_encode_split'].includes(String(hbInfo?.mode || '').trim().toLowerCase())) {
    return 'audiobook';
  }
  if (String(plan?.mode || '').trim().toLowerCase() === 'audiobook') {
    return 'audiobook';
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
  // Fallback for jobs without complete metadata/structure hints (e.g. multipart history rows).
  // Prefer explicit profile folder segments when present.
  const normalizedRawPathForHint = rawPath.replace(/\\/g, '/').toLowerCase();
  const normalizedEncodeInputPathForHint = encodeInputPath.replace(/\\/g, '/').toLowerCase();
  if (
    /(^|\/)raw\/bluray(\/|$)/.test(normalizedRawPathForHint)
    || /(^|\/)raw\/bluray(\/|$)/.test(normalizedEncodeInputPathForHint)
  ) {
    return 'bluray';
  }
  if (
    /(^|\/)raw\/dvd(\/|$)/.test(normalizedRawPathForHint)
    || /(^|\/)raw\/dvd(\/|$)/.test(normalizedEncodeInputPathForHint)
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

function buildArchivedProcessLogPath(sourceJobId, options = {}) {
  const normalizedId = Number(sourceJobId);
  if (!Number.isFinite(normalizedId) || normalizedId <= 0) {
    return null;
  }
  const targetJobId = Number(options?.replacementJobId);
  const safeReason = String(options?.reason || 'retired')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    || 'retired';
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const archiveDir = path.join(getJobLogDir(), 'archived');
  const targetSuffix = Number.isFinite(targetJobId) && targetJobId > 0
    ? `.to-${Math.trunc(targetJobId)}`
    : '';
  return {
    archiveDir,
    archivePath: path.join(
      archiveDir,
      `job-${Math.trunc(normalizedId)}.process.${safeReason}${targetSuffix}.${timestamp}.log`
    )
  };
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
  const baseFolderName = path.basename(stored);
  if (!baseFolderName) return stored;
  const folderNames = [baseFolderName];
  const stripped = stripRawFolderStatePrefix(baseFolderName);
  if (stripped) {
    folderNames.push(applyRawFolderPrefix(stripped, RAW_RIP_COMPLETE_PREFIX));
    folderNames.push(applyRawFolderPrefix(stripped, RAW_INCOMPLETE_PREFIX));
  }

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
  const storedParent = path.dirname(stored);
  for (const name of folderNames) {
    if (!name) continue;
    if (storedParent && storedParent !== '.') {
      pushCandidate(path.join(storedParent, name));
    }
    if (rawDir) {
      pushCandidate(path.join(String(rawDir).trim(), name));
    }
    for (const extraDir of Array.isArray(extraDirs) ? extraDirs : []) {
      pushCandidate(path.join(String(extraDir || '').trim(), name));
    }
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

  return rawDir ? path.join(String(rawDir).trim(), baseFolderName) : stored;
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

function getSeriesRawPathCandidates(settings = {}) {
  const source = settings && typeof settings === 'object' ? settings : {};
  const unique = [];
  const seen = new Set();
  const pushPath = (candidate) => {
    const rawPath = String(candidate || '').trim();
    if (!rawPath) {
      return;
    }
    const normalized = normalizeComparablePath(rawPath);
    if (!normalized || seen.has(normalized)) {
      return;
    }
    seen.add(normalized);
    unique.push(normalized);
  };

  for (const candidate of getConfiguredMediaPathList(source, 'series_raw_dir')) {
    pushPath(candidate);
  }
  pushPath(source.raw_dir_bluray_series);
  pushPath(source.raw_dir_dvd_series);

  const blurayEffective = settingsService.resolveEffectiveToolSettings(source, 'bluray') || {};
  pushPath(blurayEffective.series_raw_dir);
  const dvdEffective = settingsService.resolveEffectiveToolSettings(source, 'dvd') || {};
  pushPath(dvdEffective.series_raw_dir);

  return unique;
}

function resolveRawRootForPath(settings = {}, currentRawDir = null, rawPath = null) {
  const normalizedRawPath = normalizeComparablePath(rawPath);
  if (!normalizedRawPath) {
    return String(currentRawDir || '').trim() || null;
  }

  const unique = [];
  const seen = new Set();
  const pushPath = (candidate) => {
    const normalized = normalizeComparablePath(candidate);
    if (!normalized || seen.has(normalized)) {
      return;
    }
    seen.add(normalized);
    unique.push(normalized);
  };

  pushPath(currentRawDir);
  for (const candidate of getConfiguredMediaPathList(settings || {}, 'raw_dir')) {
    pushPath(candidate);
  }
  for (const candidate of getSeriesRawPathCandidates(settings || {})) {
    pushPath(candidate);
  }

  const matchingRoots = unique
    .filter((candidateRoot) => isPathInside(candidateRoot, normalizedRawPath))
    .sort((left, right) => right.length - left.length);
  if (matchingRoots.length > 0) {
    return matchingRoots[0];
  }
  return String(currentRawDir || '').trim() || null;
}

function isLikelySeriesRawPath(rawPath, settings = {}) {
  const normalizedRawPath = normalizeComparablePath(rawPath);
  if (!normalizedRawPath) {
    return false;
  }

  const seriesRoots = getSeriesRawPathCandidates(settings);
  if (seriesRoots.some((candidate) => isPathInside(candidate, normalizedRawPath))) {
    return true;
  }

  // Fallback for common default layouts when series raw dir is not explicitly configured.
  return /(^|\/)raw\/(?:dvd|bluray)\/series(\/|$)/i.test(normalizedRawPath);
}

function getOrphanRawScanPathList(settings = {}) {
  const source = settings && typeof settings === 'object' ? settings : {};
  const unique = [];
  const seen = new Set();
  const pushPath = (candidate) => {
    const rawPath = String(candidate || '').trim();
    if (!rawPath) {
      return;
    }
    const normalized = normalizeComparablePath(rawPath);
    if (!normalized || seen.has(normalized)) {
      return;
    }
    seen.add(normalized);
    unique.push(normalized);
  };

  // Explicitly configured RAW roots (legacy + profiled keys)
  for (const candidate of getConfiguredMediaPathList(source, 'raw_dir')) {
    pushPath(candidate);
  }
  for (const candidate of getConfiguredMediaPathList(source, 'series_raw_dir')) {
    pushPath(candidate);
  }
  pushPath(source.raw_dir_bluray_series);
  pushPath(source.raw_dir_dvd_series);
  pushPath(source.converter_raw_dir);

  // Effective settings roots per profile (covers fallback behavior in settings service)
  for (const profile of ['bluray', 'dvd', 'cd', 'audiobook']) {
    const effective = settingsService.resolveEffectiveToolSettings(source, profile) || {};
    pushPath(effective.raw_dir);
    if (profile === 'dvd' || profile === 'bluray') {
      pushPath(effective.series_raw_dir);
    }
  }

  // Hard defaults (even when no explicit setting exists yet)
  pushPath(settingsService.DEFAULT_RAW_DIR);
  pushPath(settingsService.DEFAULT_AUDIOBOOK_RAW_DIR);
  pushPath(defaultConverterRawDir);

  return unique;
}

function isDirectoryLikeOutput(mediaType, encodePlan = null, handbrakeInfo = null) {
  if (mediaType === 'cd') {
    return true;
  }
  if (mediaType !== 'audiobook') {
    return false;
  }
  const hbMode = String(handbrakeInfo?.mode || '').trim().toLowerCase();
  if (hbMode === 'audiobook_encode_split') {
    return true;
  }
  const format = String(encodePlan?.format || '').trim().toLowerCase();
  return Boolean(format && format !== 'm4b');
}

function resolveEffectiveStoragePathsForJob(settings = null, job = {}, parsed = {}) {
  const mkInfo = parsed?.makemkvInfo || parseJsonSafe(job?.makemkv_info_json, null);
  const miInfo = parsed?.mediainfoInfo || parseJsonSafe(job?.mediainfo_info_json, null);
  const plan = parsed?.encodePlan || parseJsonSafe(job?.encode_plan_json, null);
  const handbrakeInfo = parsed?.handbrakeInfo || parseJsonSafe(job?.handbrake_info_json, null);
  const mediaType = inferMediaType(job, mkInfo, miInfo, plan, handbrakeInfo);
  const directoryLikeOutput = isDirectoryLikeOutput(mediaType, plan, handbrakeInfo);
  const selectedMetadata = mkInfo?.analyzeContext?.selectedMetadata || mkInfo?.selectedMetadata || {};
  const metadataKind = String(selectedMetadata?.metadataKind || '').trim().toLowerCase();
  const normalizedJobKind = String(job?.job_kind || '').trim().toLowerCase();
  const hasSeriesJobKind = normalizedJobKind === 'dvd_series_child' || normalizedJobKind === 'dvd_series_container';
  const hasParentJob = normalizeJobIdValue(job?.parent_job_id) !== null;
  const isMultipartJobKind = (
    normalizedJobKind === 'multipart_movie_container'
    || normalizedJobKind === 'multipart_movie_child'
    || normalizedJobKind === 'multipart_movie_merge'
  );
  // Parent-ID alone is not a reliable series signal: multipart movie jobs also use parent_job_id.
  const hasSeriesParent = hasParentJob && !isMultipartJobKind;
  const hasSeriesRawPathHint = isLikelySeriesRawPath(job?.raw_path, settings || {});
  const hasSeriesMetadataHint = hasSeriesMetadataSignals(
    selectedMetadata,
    mkInfo?.analyzeContext && typeof mkInfo.analyzeContext === 'object' ? mkInfo.analyzeContext : {}
  );
  const seriesSignals = (
    Number(selectedMetadata?.tmdbId || 0) > 0
    || Number(selectedMetadata?.seasonNumber || 0) > 0
    || (Array.isArray(selectedMetadata?.episodes) && selectedMetadata.episodes.length > 0)
    || Number(selectedMetadata?.episodeCount || 0) > 0
    || ['series', 'season', 'tv', 'tv_series', 'tv-season', 'tv_season'].includes(metadataKind)
  );
  const isSeriesDisc = (mediaType === 'dvd' || mediaType === 'bluray') && (
    seriesSignals
    || hasSeriesMetadataHint
    || hasSeriesJobKind
    || hasSeriesParent
    || hasSeriesRawPathHint
  );

  // Converter jobs use their own storage dirs — do not remap output path
  if (mediaType === 'converter') {
    const s = settings || {};
    const converterMediaType = String(plan?.converterMediaType || '').trim().toLowerCase();
    const converterMovieDir = converterMediaType === 'audio'
      ? (String(s.converter_audio_dir || '').trim() || String(s.converter_movie_dir || '').trim())
      : String(s.converter_movie_dir || '').trim();
    const converterRawDir = String(s.converter_raw_dir || '').trim();
    return {
      mediaType: 'converter',
      directoryLikeOutput: false,
      rawDir: converterRawDir,
      movieDir: converterMovieDir,
      effectiveRawPath: job?.raw_path || null,
      effectiveOutputPath: job?.output_path || null,
      makemkvInfo: mkInfo,
      mediainfoInfo: miInfo,
      handbrakeInfo,
      encodePlan: plan
    };
  }

  const effectiveSettings = settingsService.resolveEffectiveToolSettings(settings || {}, mediaType);
  const seriesRawDir = String(effectiveSettings?.series_raw_dir || '').trim();
  const seriesMovieDir = String(effectiveSettings?.series_dir || '').trim();
  const defaultRawDir = String(effectiveSettings?.raw_dir || '').trim();
  let rawDir = isSeriesDisc ? (seriesRawDir || defaultRawDir) : defaultRawDir;
  if (isSeriesDisc) {
    const normalizedStoredRawPath = normalizeComparablePath(job?.raw_path);
    if (normalizedStoredRawPath) {
      const seriesRawCandidates = getSeriesRawPathCandidates(settings || {});
      const matchedSeriesRawDir = seriesRawCandidates.find((candidate) => isPathInside(candidate, normalizedStoredRawPath));
      if (matchedSeriesRawDir) {
        rawDir = matchedSeriesRawDir;
      }
    }
  }
  const configuredMovieDir = isSeriesDisc
    ? (seriesMovieDir || String(effectiveSettings?.movie_dir || '').trim())
    : String(effectiveSettings?.movie_dir || '').trim();
  const movieDir = configuredMovieDir || rawDir;
  const rawLookupDirsBase = isSeriesDisc
    ? getSeriesRawPathCandidates(settings || {})
    : getConfiguredMediaPathList(settings || {}, 'raw_dir');
  const rawLookupDirs = rawLookupDirsBase
    .filter((candidate) => normalizeComparablePath(candidate) !== normalizeComparablePath(rawDir));
  const effectiveRawPath = job?.raw_path
    ? resolveEffectiveRawPath(job.raw_path, rawDir, rawLookupDirs)
    : (job?.raw_path || null);
  rawDir = resolveRawRootForPath(settings || {}, rawDir, effectiveRawPath);
  const effectiveOutputPath = (!directoryLikeOutput && configuredMovieDir && job?.output_path && !isSeriesDisc)
    ? resolveEffectiveOutputPath(job.output_path, configuredMovieDir)
    : (job?.output_path || null);

  return {
    mediaType,
    directoryLikeOutput,
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
  const resolvedPaths = resolveEffectiveStoragePathsForJob(settings, job);
  const handbrakeInfo = resolvedPaths.handbrakeInfo;
  const directoryLikeOutput = Boolean(resolvedPaths.directoryLikeOutput);
  const outputStatus = includeFsChecks
    ? (directoryLikeOutput
      ? inspectDirectory(resolvedPaths.effectiveOutputPath)
      : inspectOutputFile(resolvedPaths.effectiveOutputPath))
    : (directoryLikeOutput
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
  const analyzeContext = makemkvInfo?.analyzeContext && typeof makemkvInfo.analyzeContext === 'object'
    ? makemkvInfo.analyzeContext
    : {};
  const selectedMetadata = analyzeContext?.selectedMetadata && typeof analyzeContext.selectedMetadata === 'object'
    ? analyzeContext.selectedMetadata
    : (makemkvInfo?.selectedMetadata && typeof makemkvInfo.selectedMetadata === 'object'
      ? makemkvInfo.selectedMetadata
      : {});
  const resolvedPosterUrl = String(
    job?.poster_url
    || selectedMetadata?.poster
    || selectedMetadata?.coverUrl
    || selectedMetadata?.posterUrl
    || encodePlan?.metadata?.poster
    || encodePlan?.metadata?.coverUrl
    || ''
  ).trim() || null;
  const mediaType = resolvedPaths.mediaType;
  const normalizedJobStatus = String(job?.status || '').trim().toUpperCase();
  const ripSuccessful = Number(job?.rip_successful || 0) === 1
    || String(makemkvInfo?.status || '').trim().toUpperCase() === 'SUCCESS';
  const backupSuccess = ripSuccessful;
  const finishedWithOutput = normalizedJobStatus === 'FINISHED'
    && (includeFsChecks ? Boolean(outputStatus?.exists) : true);
  const seriesBatchSummary = handbrakeInfo?.seriesBatch && typeof handbrakeInfo.seriesBatch === 'object'
    ? handbrakeInfo.seriesBatch
    : null;
  const seriesBatchMode = String(handbrakeInfo?.mode || '').trim().toLowerCase() === 'series_batch';
  const seriesBatchTotal = Number(seriesBatchSummary?.totalCount || 0);
  const seriesBatchFinished = Number(seriesBatchSummary?.finishedCount || 0);
  const seriesBatchErrors = Number(seriesBatchSummary?.errorCount || 0);
  const seriesBatchCancelled = Number(seriesBatchSummary?.cancelledCount || 0);
  const seriesBatchEncodeSuccess = seriesBatchMode
    && seriesBatchTotal > 0
    && seriesBatchFinished >= seriesBatchTotal
    && seriesBatchErrors <= 0
    && seriesBatchCancelled <= 0;
  const encodeSuccess = directoryLikeOutput
    ? finishedWithOutput
    : (
      seriesBatchEncodeSuccess
      || (mediaType === 'converter'
        ? finishedWithOutput
        : String(handbrakeInfo?.status || '').trim().toUpperCase() === 'SUCCESS')
    );
  const nfoStatus = buildNfoStatusForJob({
    job,
    outputPath: resolvedPaths.effectiveOutputPath,
    outputStatus,
    includeFsChecks,
    settings,
    mediaType
  });

  return {
    ...job,
    poster_url: resolvedPosterUrl,
    raw_path: resolvedPaths.effectiveRawPath,
    output_path: resolvedPaths.effectiveOutputPath,
    makemkvInfo,
    handbrakeInfo,
    mediainfoInfo,
    encodePlan,
    mediaType,
    ripSuccessful,
    backupSuccess,
    encodeSuccess,
    rawStatus,
    outputStatus,
    movieDirStatus,
    nfoStatus
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

function escapeRegExp(input) {
  return String(input || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseNumberedFolderName(folderName) {
  const raw = String(folderName || '').trim();
  if (!raw) {
    return { baseName: '', suffixNumber: 0, numbered: false };
  }
  const match = raw.match(/^(.*)_([0-9]+)$/);
  if (!match) {
    return { baseName: raw, suffixNumber: 0, numbered: false };
  }
  const baseName = String(match[1] || '').trim() || raw;
  const suffixNumber = Number(match[2] || 0);
  return {
    baseName,
    suffixNumber: Number.isFinite(suffixNumber) && suffixNumber > 0 ? Math.trunc(suffixNumber) : 0,
    numbered: true
  };
}

function inferSiblingOutputFolders(outputPath) {
  const normalizedOutputPath = normalizeComparablePath(outputPath);
  if (!normalizedOutputPath) {
    return [];
  }

  let outputStat = null;
  try {
    outputStat = fs.statSync(normalizedOutputPath);
  } catch (_error) {
    return [];
  }
  if (!outputStat?.isDirectory?.()) {
    return [];
  }

  const parentDir = path.dirname(normalizedOutputPath);
  const folderName = path.basename(normalizedOutputPath);
  const parsedName = parseNumberedFolderName(folderName);
  const baseName = parsedName.baseName || folderName;
  if (!baseName) {
    return [normalizedOutputPath];
  }

  const siblingRegex = new RegExp(`^${escapeRegExp(baseName)}(?:_(\\d+))?$`);
  let entries = [];
  try {
    entries = fs.readdirSync(parentDir, { withFileTypes: true });
  } catch (_error) {
    return [normalizedOutputPath];
  }

  const candidates = [];
  for (const entry of entries) {
    if (!entry?.isDirectory?.()) {
      continue;
    }
    const name = String(entry.name || '').trim();
    if (!name) {
      continue;
    }
    const match = name.match(siblingRegex);
    if (!match) {
      continue;
    }
    const suffixNumber = match[1] ? Number(match[1]) : 0;
    const fullPath = normalizeComparablePath(path.join(parentDir, name));
    candidates.push({
      path: fullPath,
      suffixNumber: Number.isFinite(suffixNumber) && suffixNumber > 0 ? Math.trunc(suffixNumber) : 0
    });
  }

  if (candidates.length === 0) {
    return [normalizedOutputPath];
  }

  candidates.sort((left, right) => {
    if (left.suffixNumber !== right.suffixNumber) {
      return left.suffixNumber - right.suffixNumber;
    }
    return String(left.path || '').localeCompare(String(right.path || ''), 'de-DE');
  });
  return candidates.map((item) => item.path);
}

function resolveExistingOutputPathVariant(outputPath) {
  const normalizedOutputPath = normalizeComparablePath(outputPath);
  if (!normalizedOutputPath) {
    return null;
  }
  try {
    if (fs.existsSync(normalizedOutputPath)) {
      return normalizedOutputPath;
    }
  } catch (_error) {
    // Ignore and continue with fallback probing.
  }

  const parsed = path.parse(normalizedOutputPath);
  const parentDir = normalizeComparablePath(parsed.dir);
  if (!parentDir) {
    return null;
  }

  const candidatePaths = [];
  const candidateSet = new Set();
  const pushCandidate = (candidatePath) => {
    const normalized = normalizeComparablePath(candidatePath);
    if (!normalized || candidateSet.has(normalized)) {
      return;
    }
    candidateSet.add(normalized);
    candidatePaths.push(normalized);
  };

  // If parent directory is numbered (e.g. "Staffel 3_2"), prefer base folder first.
  const parentName = path.basename(parentDir);
  const parsedParentName = parseNumberedFolderName(parentName);
  const parentRoot = path.dirname(parentDir);
  const siblingBaseName = parsedParentName.baseName || parentName;
  if (parsedParentName.numbered && parsedParentName.baseName) {
    pushCandidate(path.join(parentRoot, parsedParentName.baseName, parsed.base));
  }

  // If filename is numbered (e.g. "Episode_2.mkv"), prefer base filename first.
  const parsedFileName = parseNumberedFolderName(parsed.name);
  if (parsedFileName.numbered && parsedFileName.baseName) {
    pushCandidate(path.join(parentDir, `${parsedFileName.baseName}${parsed.ext}`));
  }

  // Probe sibling directories with same base name (base, _2, _3, ...).
  if (parentRoot && siblingBaseName) {
    try {
      const siblingRegex = new RegExp(`^${escapeRegExp(siblingBaseName)}(?:_(\\d+))?$`);
      const siblingDirs = fs.readdirSync(parentRoot, { withFileTypes: true })
        .filter((entry) => entry?.isDirectory?.())
        .map((entry) => {
          const name = String(entry?.name || '').trim();
          const match = name.match(siblingRegex);
          if (!match) {
            return null;
          }
          const suffixNumber = match[1] ? Number(match[1]) : 0;
          return {
            dirPath: path.join(parentRoot, name),
            suffixNumber: Number.isFinite(suffixNumber) && suffixNumber > 0 ? Math.trunc(suffixNumber) : 0
          };
        })
        .filter(Boolean)
        .sort((left, right) => {
          if (left.suffixNumber !== right.suffixNumber) {
            return left.suffixNumber - right.suffixNumber;
          }
          return String(left.dirPath || '').localeCompare(String(right.dirPath || ''), 'de-DE');
        });
      for (const sibling of siblingDirs) {
        pushCandidate(path.join(sibling.dirPath, parsed.base));
      }
    } catch (_error) {
      // Best effort.
    }
  }

  for (const candidatePath of candidatePaths) {
    try {
      if (fs.existsSync(candidatePath)) {
        return candidatePath;
      }
    } catch (_error) {
      // Ignore and continue.
    }
  }

  return null;
}

function compareOutputFolderPaths(leftPath, rightPath) {
  const leftNormalized = normalizeComparablePath(leftPath);
  const rightNormalized = normalizeComparablePath(rightPath);
  const leftParent = normalizeComparablePath(path.dirname(leftNormalized));
  const rightParent = normalizeComparablePath(path.dirname(rightNormalized));
  const parentCompare = leftParent.localeCompare(rightParent, 'de-DE');
  if (parentCompare !== 0) {
    return parentCompare;
  }

  const leftName = String(path.basename(leftNormalized) || '').trim();
  const rightName = String(path.basename(rightNormalized) || '').trim();
  const leftParsed = parseNumberedFolderName(leftName);
  const rightParsed = parseNumberedFolderName(rightName);
  const baseCompare = String(leftParsed.baseName || '').localeCompare(String(rightParsed.baseName || ''), 'de-DE');
  if (baseCompare !== 0) {
    return baseCompare;
  }

  const leftSuffix = Number(leftParsed?.suffixNumber || 0);
  const rightSuffix = Number(rightParsed?.suffixNumber || 0);
  if (leftSuffix !== rightSuffix) {
    return leftSuffix - rightSuffix;
  }

  return leftNormalized.localeCompare(rightNormalized, 'de-DE');
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

function stripRawFolderJobSuffix(folderName) {
  const rawName = String(folderName || '').trim();
  if (!rawName) {
    return '';
  }
  return rawName.replace(/(?:\s*-\s*RAW\s*-\s*job-\d+\s*)+$/i, '').trim();
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
  const folderJobIdMatches = Array.from(normalizedRawName.matchAll(/-\s*RAW\s*-\s*job-(\d+)/ig));
  const folderJobId = folderJobIdMatches.length > 0
    ? Number(folderJobIdMatches[folderJobIdMatches.length - 1][1])
    : null;
  let working = stripRawFolderJobSuffix(normalizedRawName);

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

function normalizePositiveNumberOrNull(value) {
  const raw = String(value ?? '').trim();
  if (!raw) {
    return null;
  }
  const parsed = Number(raw.replace(',', '.'));
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return parsed;
}

function normalizePositiveIntegerOrNull(value) {
  const parsed = normalizePositiveNumberOrNull(value);
  if (parsed === null) {
    return null;
  }
  return Math.trunc(parsed);
}

function normalizeDvdMetadataWorkflowKind(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) {
    return null;
  }
  if (['film', 'movie', 'feature'].includes(raw)) {
    return 'film';
  }
  if (['series', 'tv', 'season', 'episode'].includes(raw)) {
    return 'series';
  }
  return null;
}

function resolveSeriesAssignmentEpisodeSpan(assignment = null) {
  const source = assignment && typeof assignment === 'object' ? assignment : {};
  const start = normalizePositiveIntegerOrNull(
    source?.episodeNumberStart
    ?? source?.episodeNoStart
    ?? source?.episodeNumber
    ?? source?.number
    ?? null
  );
  const explicitEnd = normalizePositiveIntegerOrNull(
    source?.episodeNumberEnd
    ?? source?.episodeNoEnd
    ?? null
  );
  const explicitSpan = normalizePositiveIntegerOrNull(
    source?.episodeSpan
    ?? source?.episodeCount
    ?? null
  );
  if (start && explicitEnd && explicitEnd >= start) {
    return Math.max(1, Math.trunc(explicitEnd - start + 1));
  }
  if (explicitSpan && explicitSpan > 0) {
    return Math.max(1, Math.trunc(explicitSpan));
  }
  if (start) {
    return 1;
  }
  return 0;
}

function countSelectedEpisodeSlotsFromPlan(plan = null) {
  const sourcePlan = plan && typeof plan === 'object' ? plan : {};
  const titles = Array.isArray(sourcePlan?.titles) ? sourcePlan.titles : [];
  const selectedFromFlags = titles
    .filter((title) => Boolean(title?.selectedForEncode || title?.encodeInput))
    .map((title) => normalizePositiveIntegerOrNull(title?.id))
    .filter(Boolean);
  const selectedFromPlan = Array.isArray(sourcePlan?.selectedTitleIds)
    ? sourcePlan.selectedTitleIds
      .map((value) => normalizePositiveIntegerOrNull(value))
      .filter(Boolean)
    : [];
  const selectedFromInput = normalizePositiveIntegerOrNull(sourcePlan?.encodeInputTitleId);
  const selectedTitleIds = Array.from(new Set([
    ...selectedFromFlags,
    ...selectedFromPlan,
    ...(selectedFromInput ? [selectedFromInput] : [])
  ]));
  if (selectedTitleIds.length === 0) {
    return 0;
  }
  const assignments = sourcePlan?.episodeAssignments && typeof sourcePlan.episodeAssignments === 'object'
    ? sourcePlan.episodeAssignments
    : {};
  let total = 0;
  for (const titleId of selectedTitleIds) {
    const assignment = assignments[String(titleId)] || assignments[titleId] || null;
    const span = resolveSeriesAssignmentEpisodeSpan(assignment);
    total += span > 0 ? span : 1;
  }
  return Math.max(0, total);
}

function isSeriesBatchEpisodeSubJobPlan(encodePlan = null) {
  const plan = encodePlan && typeof encodePlan === 'object' ? encodePlan : {};
  if (Boolean(plan?.seriesBatchChild) || Boolean(plan?.seriesBatchVirtualEpisode)) {
    return true;
  }
  const parentJobId = normalizePositiveIntegerOrNull(plan?.seriesBatchParentJobId);
  const titleId = normalizePositiveIntegerOrNull(plan?.seriesBatchTitleId);
  const childIndex = normalizePositiveIntegerOrNull(plan?.seriesBatchChildIndex);
  const childCount = normalizePositiveIntegerOrNull(plan?.seriesBatchChildCount);
  if (parentJobId && (titleId || childIndex || childCount)) {
    return true;
  }
  return false;
}

function isSeriesBatchEpisodeSubJobRow(row = null) {
  const source = row && typeof row === 'object' ? row : {};
  const plan = source?.encodePlan && typeof source.encodePlan === 'object'
    ? source.encodePlan
    : parseJsonSafe(source?.encode_plan_json, null);
  return isSeriesBatchEpisodeSubJobPlan(plan);
}

function extractSeasonNumberFromText(value) {
  const text = String(value || '').trim();
  if (!text) {
    return null;
  }

  const directPattern = text.match(/(?:staffel|season|serie|series|s)\s*[-_.:]?\s*(\d{1,3}(?:[.,]\d+)?)/i);
  if (directPattern?.[1]) {
    return normalizePositiveNumberOrNull(directPattern[1]);
  }

  const tokenPattern = text.match(/(?:^|[\s._-])s(\d{1,3}(?:[.,]\d+)?)(?:$|[\s._-])/i);
  if (tokenPattern?.[1]) {
    return normalizePositiveNumberOrNull(tokenPattern[1]);
  }

  return null;
}

function extractDiscNumberFromText(value) {
  const text = String(value || '').trim();
  if (!text) {
    return null;
  }

  const directPattern = text.match(/(?:disc|disk|dvd|cd)\s*[-_.:]?\s*(\d{1,2})/i);
  if (directPattern?.[1]) {
    return normalizePositiveIntegerOrNull(directPattern[1]);
  }

  const tokenPattern = text.match(/(?:^|[\s._-])d(?:isc)?[-_.:]?\s*(\d{1,2})(?:$|[\s._-])/i);
  if (tokenPattern?.[1]) {
    return normalizePositiveIntegerOrNull(tokenPattern[1]);
  }

  return null;
}

function extractSelectedMetadataFromMakemkvInfo(makemkvInfo = {}) {
  const source = makemkvInfo && typeof makemkvInfo === 'object' ? makemkvInfo : {};
  const analyzeContext = source.analyzeContext && typeof source.analyzeContext === 'object'
    ? source.analyzeContext
    : {};
  const analyzeSelected = analyzeContext.selectedMetadata && typeof analyzeContext.selectedMetadata === 'object'
    ? analyzeContext.selectedMetadata
    : {};
  const topLevelSelected = source.selectedMetadata && typeof source.selectedMetadata === 'object'
    ? source.selectedMetadata
    : {};
  const merged = {
    ...analyzeSelected,
    ...topLevelSelected
  };

  if (!merged.metadataProvider && analyzeContext.metadataProvider) {
    merged.metadataProvider = analyzeContext.metadataProvider;
  }
  if (!merged.metadataKind && analyzeContext.metadataKind) {
    merged.metadataKind = analyzeContext.metadataKind;
  }

  return merged;
}

function hasSeriesMetadataSignals(selectedMetadata = {}, analyzeContext = {}) {
  const metadata = selectedMetadata && typeof selectedMetadata === 'object' ? selectedMetadata : {};
  const analyze = analyzeContext && typeof analyzeContext === 'object' ? analyzeContext : {};
  const workflowKind = normalizeDvdMetadataWorkflowKind(
    metadata.workflowKind
    || analyze.workflowKind
    || null
  );
  if (workflowKind === 'film') {
    return false;
  }
  if (workflowKind === 'series') {
    return true;
  }
  const metadataKind = String(metadata.metadataKind || analyze.metadataKind || '').trim().toLowerCase();
  const seasonNumber = normalizePositiveNumberOrNull(
    metadata.seasonNumber ?? analyze?.seriesLookupHint?.seasonNumber ?? null
  );
  const seasonName = String(metadata.seasonName || '').trim();
  const episodeCount = Number(metadata.episodeCount || 0) || 0;
  const hasEpisodeList = Array.isArray(metadata.episodes) && metadata.episodes.length > 0;
  const tmdbId = normalizePositiveIntegerOrNull(
    metadata.tmdbId ?? analyze.tmdbId ?? metadata.providerId ?? analyze.providerId ?? null
  );
  const provider = String(
    metadata.metadataProvider
    || analyze.metadataProvider
    || ''
  ).trim().toLowerCase();
  const providerIsTmdb = provider === 'tmdb' || provider === 'themoviedb';
  const seriesKind = ['series', 'season', 'tv', 'tv_series', 'tv-season', 'tv_season'].includes(metadataKind);

  if (seriesKind || seasonNumber !== null || Boolean(seasonName) || episodeCount > 0 || hasEpisodeList || tmdbId !== null) {
    return true;
  }
  return providerIsTmdb && Boolean(String(analyze?.seriesLookupHint?.query || '').trim());
}

function buildSeriesImportHints({
  folderName = '',
  rawPath = '',
  metadata = {},
  sourceSelectedMetadata = {},
  sourceAnalyzeContext = {}
} = {}) {
  const safeMetadata = metadata && typeof metadata === 'object' ? metadata : {};
  const selected = sourceSelectedMetadata && typeof sourceSelectedMetadata === 'object'
    ? sourceSelectedMetadata
    : {};
  const analyze = sourceAnalyzeContext && typeof sourceAnalyzeContext === 'object'
    ? sourceAnalyzeContext
    : {};
  const titleSource = String(
    selected.title
    || selected.seriesTitle
    || safeMetadata.title
    || ''
  ).trim();
  const combinedText = [folderName, path.basename(String(rawPath || '').trim())]
    .filter(Boolean)
    .join(' ');
  const seasonNumber = normalizePositiveNumberOrNull(
    selected.seasonNumber
    ?? analyze?.seriesLookupHint?.seasonNumber
    ?? extractSeasonNumberFromText(combinedText)
  );
  const discNumber = normalizePositiveIntegerOrNull(
    selected.discNumber
    ?? analyze?.seriesLookupHint?.discNumber
    ?? extractDiscNumberFromText(combinedText)
  );

  const seriesLookupHint = {
    query: titleSource || null,
    seasonNumber,
    discNumber
  };
  const metadataHasSeriesSignals = hasSeriesMetadataSignals(selected, analyze);
  if (!metadataHasSeriesSignals && !seriesLookupHint.query && seriesLookupHint.seasonNumber === null && seriesLookupHint.discNumber === null) {
    return null;
  }

  return {
    selectedMetadata: {
      ...selected,
      metadataProvider: String(selected.metadataProvider || analyze.metadataProvider || 'tmdb').trim().toLowerCase() || 'tmdb',
      metadataKind: String(selected.metadataKind || analyze.metadataKind || 'series').trim().toLowerCase() || 'series',
      title: titleSource || null,
      seasonNumber,
      discNumber
    },
    analyzeContextPatch: {
      metadataProvider: String(
        analyze.metadataProvider
        || selected.metadataProvider
        || 'tmdb'
      ).trim().toLowerCase() || 'tmdb',
      metadataKind: String(
        analyze.metadataKind
        || selected.metadataKind
        || 'series'
      ).trim().toLowerCase() || 'series',
      seriesLookupHint: {
        ...(analyze.seriesLookupHint && typeof analyze.seriesLookupHint === 'object'
          ? analyze.seriesLookupHint
          : {}),
        ...seriesLookupHint
      },
      seriesAnalysis: {
        ...(analyze.seriesAnalysis && typeof analyze.seriesAnalysis === 'object'
          ? analyze.seriesAnalysis
          : {}),
        summary: {
          ...(analyze?.seriesAnalysis?.summary && typeof analyze.seriesAnalysis.summary === 'object'
            ? analyze.seriesAnalysis.summary
            : {}),
          seriesLike: true,
          confidence: analyze?.seriesAnalysis?.summary?.confidence || 'medium'
        }
      }
    }
  };
}

function buildRawPathForJobId(rawPath, jobId) {
  const normalizedJobId = Number(jobId);
  if (!Number.isFinite(normalizedJobId) || normalizedJobId <= 0) {
    return rawPath;
  }

  const absRawPath = normalizeComparablePath(rawPath);
  const folderName = path.basename(absRawPath);
  const statePrefix = /^Rip_Complete_/i.test(folderName)
    ? RAW_RIP_COMPLETE_PREFIX
    : /^Incomplete_/i.test(folderName)
      ? RAW_INCOMPLETE_PREFIX
      : '';
  const stripped = stripRawFolderJobSuffix(stripRawFolderStatePrefix(folderName));
  if (!stripped) {
    return absRawPath;
  }
  const withJobId = `${statePrefix}${stripped} - RAW - job-${Math.trunc(normalizedJobId)}`;
  return path.join(path.dirname(absRawPath), withJobId);
}

function normalizeCdFormat(value) {
  const raw = String(value || '').trim().toLowerCase();
  return cdRipService.SUPPORTED_FORMATS.has(raw) ? raw : null;
}

function normalizeAudioPathToken(value) {
  let raw = String(value || '').trim();
  if (!raw) {
    return null;
  }

  // Unwrap common wrappers like "(...)" or quotes around the full token.
  let changed = true;
  while (changed && raw.length > 0) {
    changed = false;
    if (
      (raw.startsWith('"') && raw.endsWith('"'))
      || (raw.startsWith("'") && raw.endsWith("'"))
      || (raw.startsWith('`') && raw.endsWith('`'))
      || (raw.startsWith('(') && raw.endsWith(')'))
    ) {
      raw = raw.slice(1, -1).trim();
      changed = true;
    }
  }

  // Strip leading quotes and trailing punctuation (but keep balanced ')').
  raw = raw
    .replace(/^["'`]+/, '')
    .replace(/[,"'`;]+$/g, '')
    .trim();

  // Remove only dangling unmatched ')' at the end (e.g. ".../path)")
  // while preserving valid directory names like "... (2007)".
  let openCount = (raw.match(/\(/g) || []).length;
  let closeCount = (raw.match(/\)/g) || []).length;
  while (closeCount > openCount && raw.endsWith(')')) {
    raw = raw.slice(0, -1).trimEnd();
    closeCount -= 1;
  }

  if (!raw.startsWith('/')) {
    return null;
  }
  return raw;
}

function resolveExistingAudioPathCandidate(candidate) {
  const normalized = normalizeAudioPathToken(candidate) || String(candidate || '').trim() || null;
  if (!normalized || !normalized.startsWith('/')) {
    return null;
  }

  try {
    if (fs.existsSync(normalized)) {
      return normalized;
    }
  } catch (_error) {
    // ignore fs errors while probing possible output paths
  }

  const openCount = (normalized.match(/\(/g) || []).length;
  const closeCount = (normalized.match(/\)/g) || []).length;
  if (openCount <= closeCount) {
    return null;
  }

  let repaired = normalized;
  for (let missing = closeCount; missing < openCount; missing += 1) {
    repaired = `${repaired})`;
    try {
      if (fs.existsSync(repaired)) {
        return repaired;
      }
    } catch (_error) {
      // ignore fs errors while probing repaired variants
    }
  }

  return null;
}

function extractAbsolutePathTokens(text) {
  const source = String(text || '');
  const tokens = [];
  const seen = new Set();
  const pushToken = (value) => {
    const normalized = normalizeAudioPathToken(value);
    if (!normalized || seen.has(normalized)) {
      return;
    }
    seen.add(normalized);
    tokens.push(normalized);
  };

  let match;
  const quotedPattern = /'([^']+)'|"([^"]+)"/g;
  while ((match = quotedPattern.exec(source)) !== null) {
    pushToken(match[1] || match[2] || '');
  }

  const sanitized = source.replace(/'[^']*'|"[^"]*"/g, ' ');
  const barePattern = /(^|\s)(\/[^\s]+)/g;
  while ((match = barePattern.exec(sanitized)) !== null) {
    pushToken(match[2] || '');
  }

  return tokens;
}

function parseProcessLogTimestamp(line) {
  const match = String(line || '').match(/^\[([^\]]+)\]/);
  if (!match) {
    return null;
  }
  const parsed = Date.parse(match[1]);
  return Number.isFinite(parsed) ? parsed : null;
}

function readProcessLogFileLines(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    return String(raw || '')
      .split(/\r\n|\n|\r/)
      .filter((line) => line.length > 0);
  } catch (_error) {
    return [];
  }
}

function listJobProcessLogFiles() {
  const logDir = getJobLogDir();
  try {
    if (!fs.existsSync(logDir) || !fs.statSync(logDir).isDirectory()) {
      return [];
    }
    return fs.readdirSync(logDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && PROCESS_LOG_FILE_PATTERN.test(entry.name))
      .map((entry) => {
        const match = entry.name.match(PROCESS_LOG_FILE_PATTERN);
        const jobId = match ? Number(match[1]) : null;
        return {
          fileName: entry.name,
          filePath: path.join(logDir, entry.name),
          jobId: Number.isFinite(jobId) ? Math.trunc(jobId) : null
        };
      });
  } catch (_error) {
    return [];
  }
}

function pickPreferredExistingPath(candidates = []) {
  const normalizedCandidates = [];
  const seen = new Set();

  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    const normalized = normalizeAudioPathToken(candidate) || String(candidate || '').trim() || null;
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    normalizedCandidates.push(normalized);
  }

  for (let index = normalizedCandidates.length - 1; index >= 0; index -= 1) {
    const candidate = normalizedCandidates[index];
    const existingCandidate = resolveExistingAudioPathCandidate(candidate);
    if (existingCandidate) {
      return existingCandidate;
    }
  }

  return normalizedCandidates[normalizedCandidates.length - 1] || null;
}

function collectAudioFilesRecursively(rootPath, options = {}) {
  const maxDepth = Number.isFinite(Number(options.maxDepth)) ? Math.max(0, Math.trunc(Number(options.maxDepth))) : 6;
  const maxFiles = Number.isFinite(Number(options.maxFiles)) ? Math.max(1, Math.trunc(Number(options.maxFiles))) : 2000;
  const result = [];
  const normalizedRoot = String(rootPath || '').trim();
  if (!normalizedRoot || !fs.existsSync(normalizedRoot)) {
    return result;
  }

  const pushFile = (filePath) => {
    if (result.length >= maxFiles) {
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    if (CD_OUTPUT_AUDIO_EXTENSIONS.has(ext)) {
      result.push(filePath);
    }
  };

  try {
    const stat = fs.statSync(normalizedRoot);
    if (stat.isFile()) {
      pushFile(normalizedRoot);
      return result;
    }
  } catch (_error) {
    return result;
  }

  const queue = [{ dirPath: normalizedRoot, depth: 0 }];
  while (queue.length > 0 && result.length < maxFiles) {
    const current = queue.shift();
    if (!current) {
      continue;
    }
    let entries = [];
    try {
      entries = fs.readdirSync(current.dirPath, { withFileTypes: true });
    } catch (_error) {
      continue;
    }

    entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
    for (const entry of entries) {
      const absPath = path.join(current.dirPath, entry.name);
      if (entry.isFile()) {
        pushFile(absPath);
      } else if (entry.isDirectory() && current.depth < maxDepth) {
        queue.push({ dirPath: absPath, depth: current.depth + 1 });
      }
      if (result.length >= maxFiles) {
        break;
      }
    }
  }

  return result;
}

function parseCdOutputTrackFromPath(filePath) {
  const ext = path.extname(String(filePath || '')).toLowerCase();
  if (!CD_OUTPUT_AUDIO_EXTENSIONS.has(ext)) {
    return null;
  }

  const baseName = path.basename(filePath, ext).replace(/\s+/g, ' ').trim();
  if (!baseName) {
    return null;
  }

  const numberMatch = baseName.match(/^(\d{1,3})(.*)$/);
  const parsedPosition = numberMatch ? Number(numberMatch[1]) : null;
  const position = Number.isFinite(parsedPosition) && parsedPosition > 0 ? Math.trunc(parsedPosition) : null;
  let remainder = numberMatch ? String(numberMatch[2] || '').replace(/^[-._\s]+/, '').trim() : baseName;
  let artist = null;
  let title = remainder || baseName;

  const separatorIndex = remainder.indexOf(' - ');
  if (separatorIndex > 0) {
    artist = remainder.slice(0, separatorIndex).trim() || null;
    title = remainder.slice(separatorIndex + 3).trim() || remainder;
  }

  return {
    position,
    artist,
    title: title || baseName,
    format: normalizeCdFormat(ext.replace(/^\./, '')),
    filePath
  };
}

function assignMissingTrackPositions(entries = []) {
  const used = new Set(
    (Array.isArray(entries) ? entries : [])
      .map((entry) => Number(entry?.position))
      .filter((value) => Number.isFinite(value) && value > 0)
      .map((value) => Math.trunc(value))
  );

  let nextPosition = 1;
  return (Array.isArray(entries) ? entries : []).map((entry) => {
    const current = Number(entry?.position);
    if (Number.isFinite(current) && current > 0) {
      return {
        ...entry,
        position: Math.trunc(current)
      };
    }

    while (used.has(nextPosition)) {
      nextPosition += 1;
    }
    const assigned = nextPosition;
    used.add(assigned);
    nextPosition += 1;
    return {
      ...entry,
      position: assigned
    };
  });
}

function findMostCommonString(values = []) {
  const counts = new Map();
  for (const value of Array.isArray(values) ? values : []) {
    const normalized = String(value || '').trim();
    if (!normalized) {
      continue;
    }
    counts.set(normalized, (counts.get(normalized) || 0) + 1);
  }

  let bestValue = null;
  let bestCount = 0;
  for (const [value, count] of counts.entries()) {
    if (count > bestCount) {
      bestValue = value;
      bestCount = count;
    }
  }
  return bestValue;
}

function normalizeComparableLabel(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[^\x00-\x7F]+/g, '')
    .replace(/[^A-Za-z0-9]+/g, ' ')
    .trim()
    .toLowerCase();
}

function parseCdFolderMetadataFromOutputDir(outputDir) {
  const normalized = String(outputDir || '').trim();
  if (!normalized) {
    return {
      artist: null,
      album: null,
      year: null
    };
  }

  let working = path.basename(normalized).replace(/\s+/g, ' ').trim();
  if (!working || working === '.' || working === path.sep) {
    return {
      artist: null,
      album: null,
      year: null
    };
  }

  const yearMatch = working.match(/\((19|20)\d{2}\)\s*$/);
  const year = yearMatch ? Number(String(yearMatch[0]).replace(/[()]/g, '')) : null;
  if (yearMatch) {
    working = working.slice(0, working.length - yearMatch[0].length).trim();
  }

  const separatorIndex = working.indexOf(' - ');
  const artist = separatorIndex > 0 ? working.slice(0, separatorIndex).trim() || null : null;
  const album = separatorIndex > 0
    ? working.slice(separatorIndex + 3).trim() || null
    : (working || null);

  return {
    artist,
    album,
    year: Number.isFinite(year) ? year : null
  };
}

function directoryContainsAudioFiles(dirPath) {
  try {
    if (!dirPath || !fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) {
      return false;
    }
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const absPath = path.join(dirPath, entry.name);
      if (entry.isFile()) {
        if (CD_OUTPUT_AUDIO_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
          return true;
        }
      } else if (entry.isDirectory()) {
        const nestedEntries = fs.readdirSync(absPath, { withFileTypes: true });
        if (nestedEntries.some((nested) => nested.isFile() && CD_OUTPUT_AUDIO_EXTENSIONS.has(path.extname(nested.name).toLowerCase()))) {
          return true;
        }
      }
    }
  } catch (_error) {
    return false;
  }
  return false;
}

function findCdOutputDirByMetadata(options = {}) {
  const settings = options.settings && typeof options.settings === 'object' ? options.settings : {};
  const baseMetadata = options.baseMetadata && typeof options.baseMetadata === 'object'
    ? options.baseMetadata
    : {};
  const outputTemplate = String(options.outputTemplate || settings.cd_output_template || cdRipService.DEFAULT_CD_OUTPUT_TEMPLATE).trim()
    || cdRipService.DEFAULT_CD_OUTPUT_TEMPLATE;
  const effectiveSettings = settingsService.resolveEffectiveToolSettings(settings, 'cd');
  const outputBaseDir = String(effectiveSettings?.movie_dir || effectiveSettings?.raw_dir || '').trim() || null;
  if (!outputBaseDir) {
    return null;
  }

  const metadataVariants = [];
  const pushMetadataVariant = (candidate) => {
    if (!candidate || typeof candidate !== 'object') {
      return;
    }
    const title = String(candidate.title || candidate.album || '').trim() || null;
    const artist = String(candidate.artist || '').trim() || null;
    const yearRaw = Number(candidate.year);
    const year = Number.isFinite(yearRaw) && yearRaw > 0 ? Math.trunc(yearRaw) : null;
    if (!title && !artist && !year) {
      return;
    }
    const key = JSON.stringify({ title, artist, year });
    if (metadataVariants.some((entry) => entry.key === key)) {
      return;
    }
    metadataVariants.push({
      key,
      meta: {
        title,
        album: title,
        artist,
        year
      }
    });
  };

  pushMetadataVariant(baseMetadata);
  pushMetadataVariant({
    title: baseMetadata.album || baseMetadata.title || null,
    artist: null,
    year: baseMetadata.year || null
  });

  for (const variant of metadataVariants) {
    try {
      if (!variant.meta.title) {
        continue;
      }
      const candidatePath = cdRipService.buildOutputDir(variant.meta, outputBaseDir, outputTemplate);
      if (candidatePath && fs.existsSync(candidatePath) && directoryContainsAudioFiles(candidatePath)) {
        return candidatePath;
      }
    } catch (_error) {
      // ignore template/render errors and continue with directory scan fallback
    }
  }

  try {
    if (!fs.existsSync(outputBaseDir) || !fs.statSync(outputBaseDir).isDirectory()) {
      return null;
    }
    const targetAlbum = normalizeComparableLabel(baseMetadata.album || baseMetadata.title || '');
    const targetArtist = normalizeComparableLabel(baseMetadata.artist || '');
    const targetYearRaw = Number(baseMetadata.year);
    const targetYear = Number.isFinite(targetYearRaw) && targetYearRaw > 0 ? Math.trunc(targetYearRaw) : null;
    let best = null;
    let bestScore = -1;
    const entries = fs.readdirSync(outputBaseDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const candidatePath = path.join(outputBaseDir, entry.name);
      if (!directoryContainsAudioFiles(candidatePath)) {
        continue;
      }
      const parsed = parseCdFolderMetadataFromOutputDir(candidatePath);
      const candidateAlbum = normalizeComparableLabel(parsed.album || '');
      const candidateArtist = normalizeComparableLabel(parsed.artist || '');
      const candidateYearRaw = Number(parsed.year);
      const candidateYear = Number.isFinite(candidateYearRaw) && candidateYearRaw > 0 ? Math.trunc(candidateYearRaw) : null;

      let score = 0;
      if (targetAlbum && candidateAlbum === targetAlbum) {
        score += 10;
      } else if (targetAlbum && candidateAlbum.includes(targetAlbum)) {
        score += 6;
      } else if (targetAlbum && targetAlbum.includes(candidateAlbum) && candidateAlbum) {
        score += 4;
      }
      if (targetYear && candidateYear === targetYear) {
        score += 5;
      }
      if (targetArtist && candidateArtist === targetArtist) {
        score += 3;
      }
      if (score > bestScore) {
        best = candidatePath;
        bestScore = score;
      }
    }
    return bestScore > 0 ? best : null;
  } catch (_error) {
    return null;
  }
}

function extractCommandToken(commandLine) {
  const raw = String(commandLine || '').trim();
  if (!raw) {
    return null;
  }
  const match = raw.match(/^'([^']+)'|"([^"]+)"|(\S+)/);
  return String(match?.[1] || match?.[2] || match?.[3] || '').trim() || null;
}

function findRelatedJobLogSources(options = {}) {
  const relatedJobIds = Array.isArray(options.relatedJobIds)
    ? options.relatedJobIds
      .map((value) => normalizeJobIdValue(value))
      .filter(Boolean)
    : [];
  const excludeJobIds = new Set(
    (Array.isArray(options.excludeJobIds) ? options.excludeJobIds : [])
      .map((value) => normalizeJobIdValue(value))
      .filter(Boolean)
  );
  const rawPathCandidates = Array.isArray(options.rawPathCandidates)
    ? options.rawPathCandidates
      .map((value) => String(value || '').trim())
      .filter(Boolean)
    : [];
  const pathNeedles = Array.from(new Set(
    rawPathCandidates
      .map((value) => normalizeComparablePath(value))
      .filter(Boolean)
  ));

  const collected = new Map();
  const addSource = (filePath, matchedBy) => {
    const normalizedFilePath = String(filePath || '').trim();
    if (!normalizedFilePath || collected.has(normalizedFilePath)) {
      return;
    }
    const lines = readProcessLogFileLines(normalizedFilePath);
    if (lines.length === 0) {
      return;
    }
    const fileName = path.basename(normalizedFilePath);
    const match = fileName.match(PROCESS_LOG_FILE_PATTERN);
    const parsedJobId = match ? Number(match[1]) : null;
    const jobId = Number.isFinite(parsedJobId) ? Math.trunc(parsedJobId) : null;
    if (jobId && excludeJobIds.has(jobId)) {
      return;
    }
    const firstTimestampMs = lines.reduce((found, line) => {
      if (found !== null) {
        return found;
      }
      return parseProcessLogTimestamp(line);
    }, null);
    collected.set(normalizedFilePath, {
      filePath: normalizedFilePath,
      fileName,
      jobId,
      matchedBy: matchedBy ? [matchedBy] : [],
      lines,
      firstTimestampMs
    });
  };

  for (const relatedJobId of relatedJobIds) {
    if (excludeJobIds.has(relatedJobId)) {
      continue;
    }
    const directPath = toProcessLogPath(relatedJobId);
    if (directPath && fs.existsSync(directPath)) {
      addSource(directPath, `jobId:${relatedJobId}`);
    }
  }

  if (pathNeedles.length > 0) {
    for (const entry of listJobProcessLogFiles()) {
      if (!entry?.filePath || collected.has(entry.filePath)) {
        continue;
      }
      if (entry.jobId && excludeJobIds.has(entry.jobId)) {
        continue;
      }

      let rawText = '';
      try {
        rawText = fs.readFileSync(entry.filePath, 'utf-8');
      } catch (_error) {
        continue;
      }

      const matchedNeedle = pathNeedles.find((needle) => rawText.includes(needle));
      if (matchedNeedle) {
        addSource(entry.filePath, `path:${matchedNeedle}`);
      }
    }
  }

  return Array.from(collected.values())
    .sort((a, b) => {
      if (a.firstTimestampMs !== null && b.firstTimestampMs !== null && a.firstTimestampMs !== b.firstTimestampMs) {
        return a.firstTimestampMs - b.firstTimestampMs;
      }
      if (a.jobId && b.jobId && a.jobId !== b.jobId) {
        return a.jobId - b.jobId;
      }
      return a.fileName.localeCompare(b.fileName, undefined, { numeric: true, sensitivity: 'base' });
    });
}

function recoverCdJobArtifactsForImport(options = {}) {
  const currentRawPath = String(options.currentRawPath || '').trim() || null;
  const settings = options.settings && typeof options.settings === 'object' ? options.settings : {};
  const baseMetadata = options.baseMetadata && typeof options.baseMetadata === 'object'
    ? options.baseMetadata
    : {};
  const rawPathCandidates = Array.isArray(options.rawPathCandidates)
    ? options.rawPathCandidates
    : [];
  const relatedJobIds = Array.isArray(options.relatedJobIds)
    ? options.relatedJobIds
    : [];
  const excludeJobIds = Array.isArray(options.excludeJobIds)
    ? options.excludeJobIds
    : [];
  const logSources = findRelatedJobLogSources({
    rawPathCandidates: [currentRawPath, ...rawPathCandidates],
    relatedJobIds,
    excludeJobIds
  });
  const logLines = logSources.flatMap((source) => source.lines || []);

  let formatFromLogs = null;
  let selectedTracksFromLogs = [];
  let selectedTracksLogSaysAll = false;
  let cdparanoiaCmd = null;
  const explicitOutputDirs = [];
  const outputFilePathsFromLogs = [];
  const seenOutputFilePath = new Set();

  for (const line of logLines) {
    const message = String(line || '').replace(/^\[[^\]]+\]\s+\[[^\]]+\]\s*/, '');
    if (!message) {
      continue;
    }

    const startMatch = message.match(/CD-Rip gestartet:\s*Format=([a-z0-9]+)\s*,\s*Tracks=(.+)$/i);
    if (startMatch) {
      formatFromLogs = normalizeCdFormat(startMatch[1]) || formatFromLogs;
      const selectedTrackText = String(startMatch[2] || '').trim();
      if (/^alle$/i.test(selectedTrackText)) {
        selectedTracksLogSaysAll = true;
        selectedTracksFromLogs = [];
      } else {
        selectedTracksFromLogs = selectedTrackText
          .split(',')
          .map((value) => Number(value))
          .filter((value) => Number.isFinite(value) && value > 0)
          .map((value) => Math.trunc(value));
      }
    }

    const completionMatch = message.match(/CD-Rip abgeschlossen\.\s*Ausgabe:\s*(.+)$/i);
    if (completionMatch) {
      const outputDir = normalizeAudioPathToken(completionMatch[1]) || String(completionMatch[1] || '').trim();
      if (outputDir) {
        explicitOutputDirs.push(outputDir);
      }
    }

    if (!cdparanoiaCmd) {
      const ripMatch = message.match(/Promptkette \[Rip \d+\/\d+]:\s*(.+)$/i);
      if (ripMatch) {
        cdparanoiaCmd = extractCommandToken(ripMatch[1]);
      }
    }

    for (const token of extractAbsolutePathTokens(message)) {
      const ext = path.extname(token).toLowerCase();
      if (!CD_OUTPUT_AUDIO_EXTENSIONS.has(ext)) {
        continue;
      }
      if (CD_RAW_TRACK_FILE_PATTERN.test(path.basename(token))) {
        continue;
      }
      if (!seenOutputFilePath.has(token)) {
        seenOutputFilePath.add(token);
        outputFilePathsFromLogs.push(token);
      }
    }
  }

  const outputPath = pickPreferredExistingPath([
    ...(options.fallbackOutputPath ? [options.fallbackOutputPath] : []),
    ...explicitOutputDirs,
    ...outputFilePathsFromLogs.map((filePath) => path.dirname(filePath))
  ]);

  const outputAudioFiles = outputPath ? collectAudioFilesRecursively(outputPath) : [];
  const parsedOutputTracks = assignMissingTrackPositions(
    (outputAudioFiles.length > 0 ? outputAudioFiles : outputFilePathsFromLogs)
      .map((filePath) => parseCdOutputTrackFromPath(filePath))
      .filter(Boolean)
  );

  const rawTracks = [];
  if (currentRawPath && fs.existsSync(currentRawPath)) {
    try {
      const rawEntries = fs.readdirSync(currentRawPath, { withFileTypes: true });
      for (const entry of rawEntries) {
        if (!entry.isFile()) {
          continue;
        }
        const match = entry.name.match(CD_RAW_TRACK_FILE_PATTERN);
        if (!match) {
          continue;
        }
        const parsedPosition = Number(match[1]);
        if (!Number.isFinite(parsedPosition) || parsedPosition <= 0) {
          continue;
        }
        rawTracks.push({
          position: Math.trunc(parsedPosition),
          title: `Track ${Math.trunc(parsedPosition)}`,
          artist: null
        });
      }
    } catch (_error) {
      // ignore raw dir read errors during best-effort import recovery
    }
  }

  const folderMetadata = parseRawFolderMetadata(path.basename(currentRawPath || rawPathCandidates[0] || ''));
  const outputFolderMetadata = parseCdFolderMetadataFromOutputDir(outputPath);
  const selectedTrackSet = new Set(
    selectedTracksFromLogs
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value) && value > 0)
      .map((value) => Math.trunc(value))
  );
  const trackPositionSet = new Set();
  for (const track of rawTracks) {
    trackPositionSet.add(track.position);
  }
  for (const track of parsedOutputTracks) {
    if (Number.isFinite(Number(track?.position)) && Number(track.position) > 0) {
      trackPositionSet.add(Math.trunc(Number(track.position)));
    }
  }
  for (const position of selectedTrackSet) {
    trackPositionSet.add(position);
  }

  const trackPositions = Array.from(trackPositionSet).sort((a, b) => a - b);
  const outputTrackByPosition = new Map(
    parsedOutputTracks
      .filter((track) => Number.isFinite(Number(track?.position)) && Number(track.position) > 0)
      .map((track) => [Math.trunc(Number(track.position)), track])
  );
  const rawTrackByPosition = new Map(
    rawTracks
      .filter((track) => Number.isFinite(Number(track?.position)) && Number(track.position) > 0)
      .map((track) => [Math.trunc(Number(track.position)), track])
  );

  const tracks = trackPositions.map((position) => {
    const outputTrack = outputTrackByPosition.get(position) || null;
    const rawTrack = rawTrackByPosition.get(position) || null;
    return {
      position,
      title: String(outputTrack?.title || rawTrack?.title || `Track ${position}`).trim() || `Track ${position}`,
      artist: String(outputTrack?.artist || rawTrack?.artist || '').trim() || null,
      selected: selectedTrackSet.size > 0 ? selectedTrackSet.has(position) : true
    };
  });

  const selectedTracks = selectedTracksLogSaysAll || selectedTrackSet.size === 0
    ? trackPositions
    : trackPositions.filter((position) => selectedTrackSet.has(position));
  const artistHints = [
    ...parsedOutputTracks.map((track) => track.artist),
    ...tracks.map((track) => track.artist),
    baseMetadata.artist,
    outputFolderMetadata.artist
  ].filter(Boolean);
  const formatHints = [
    formatFromLogs,
    ...parsedOutputTracks.map((track) => track.format)
  ].filter(Boolean);
  const inferredArtist = findMostCommonString(artistHints);
  const inferredFormat = findMostCommonString(formatHints);
  const normalizedYear = Number(baseMetadata.year);
  const year = Number.isFinite(normalizedYear) && normalizedYear > 0
    ? Math.trunc(normalizedYear)
    : (outputFolderMetadata.year || folderMetadata.year || null);
  const title = String(
    baseMetadata.title
    || baseMetadata.album
    || outputFolderMetadata.album
    || folderMetadata.title
    || ''
  ).trim() || null;
  const artist = String(baseMetadata.artist || inferredArtist || '').trim() || null;
  const selectedMetadata = {
    title,
    album: title,
    artist,
    year
  };
  const outputTemplate = String(settings.cd_output_template || cdRipService.DEFAULT_CD_OUTPUT_TEMPLATE).trim()
    || cdRipService.DEFAULT_CD_OUTPUT_TEMPLATE;
  const outputPathFromMetadata = findCdOutputDirByMetadata({
    settings,
    baseMetadata: selectedMetadata,
    outputTemplate
  });
  const resolvedOutputPath = outputPath || outputPathFromMetadata || null;

  return {
    logSources,
    outputPath: resolvedOutputPath,
    outputPathExists: Boolean(resolvedOutputPath && fs.existsSync(resolvedOutputPath)),
    format: normalizeCdFormat(inferredFormat),
    tracks,
    selectedTracks,
    selectedMetadata,
    cdparanoiaCmd: String(cdparanoiaCmd || 'cdparanoia').trim() || 'cdparanoia',
    outputTemplate,
    importedLogFiles: logSources.map((source) => ({
      fileName: source.fileName,
      jobId: source.jobId,
      matchedBy: Array.isArray(source.matchedBy) ? source.matchedBy : [],
      lineCount: Array.isArray(source.lines) ? source.lines.length : 0
    }))
  };
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

function collectFilesRecursively(rootPath) {
  const normalizedRoot = normalizeComparablePath(rootPath);
  if (!normalizedRoot) {
    return [];
  }
  const result = [];
  const visit = (currentPath) => {
    let stat = null;
    try {
      stat = fs.lstatSync(currentPath);
    } catch (_error) {
      return;
    }
    if (stat.isDirectory()) {
      let entries = [];
      try {
        entries = fs.readdirSync(currentPath, { withFileTypes: true });
      } catch (_error) {
        return;
      }
      for (const entry of entries) {
        visit(path.join(currentPath, entry.name));
      }
      return;
    }
    result.push(normalizeComparablePath(currentPath));
  };
  visit(normalizedRoot);
  return Array.from(new Set(result.filter(Boolean))).sort((left, right) => left.localeCompare(right, 'de'));
}

function removeEmptyParentDirectories(startPath, options = {}) {
  const start = normalizeComparablePath(startPath);
  if (!start) {
    return [];
  }
  const protectedRoots = new Set(
    (Array.isArray(options?.protectedRoots) ? options.protectedRoots : [])
      .map((entry) => normalizeComparablePath(entry))
      .filter(Boolean)
  );
  const allowedRoots = Array.from(protectedRoots);
  const removed = [];
  const removedSet = new Set();

  let current = start;
  while (current && !isFilesystemRootPath(current)) {
    if (protectedRoots.has(current)) {
      break;
    }
    if (allowedRoots.length > 0 && !allowedRoots.some((rootPath) => isPathInside(rootPath, current))) {
      break;
    }
    let stat = null;
    try {
      stat = fs.lstatSync(current);
    } catch (_error) {
      break;
    }
    if (!stat.isDirectory()) {
      break;
    }
    let entries = [];
    try {
      entries = fs.readdirSync(current);
    } catch (_error) {
      break;
    }
    if (entries.length > 0) {
      break;
    }
    try {
      fs.rmdirSync(current);
      if (!removedSet.has(current)) {
        removedSet.add(current);
        removed.push(current);
      }
    } catch (_error) {
      break;
    }
    const parentDir = normalizeComparablePath(path.dirname(current));
    if (!parentDir || parentDir === current) {
      break;
    }
    current = parentDir;
  }

  return removed;
}

function normalizeJobIdValue(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return Math.trunc(parsed);
}

function isSeriesContainerRow(row) {
  return String(row?.job_kind || '').trim().toLowerCase() === 'dvd_series_container';
}

function isMultipartContainerRow(row) {
  return String(row?.job_kind || '').trim().toLowerCase() === 'multipart_movie_container';
}

function isDiskContainerRow(row) {
  return isSeriesContainerRow(row) || isMultipartContainerRow(row);
}

function isSeriesChildRow(row) {
  return String(row?.job_kind || '').trim().toLowerCase() === 'dvd_series_child';
}

function isMultipartChildRow(row) {
  return String(row?.job_kind || '').trim().toLowerCase() === 'multipart_movie_child';
}

function isMultipartMergeRow(row) {
  const jobKind = String(row?.job_kind || '').trim().toLowerCase();
  if (jobKind === 'multipart_movie_merge') {
    return true;
  }
  const encodePlan = parseInfoFromValue(row?.encodePlan ?? row?.encode_plan_json, null);
  const handbrakeInfo = parseInfoFromValue(row?.handbrakeInfo ?? row?.handbrake_info_json, null);
  const planJobKind = String(encodePlan?.jobKind || '').trim().toLowerCase();
  if (planJobKind === 'multipart_movie_merge') {
    return true;
  }
  const mode = String(encodePlan?.mode || handbrakeInfo?.mode || '').trim().toLowerCase();
  return mode === 'multipart_merge';
}

function normalizeArchiveTarget(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (raw === 'raw') {
    return 'raw';
  }
  if (raw === 'output' || raw === 'movie' || raw === 'encode') {
    return 'output';
  }
  return null;
}

function sanitizeArchiveNamePart(value, fallback = 'job') {
  const normalized = String(value || '')
    .normalize('NFKD')
    .replace(/[^\x00-\x7F]+/g, '');
  const safe = normalized
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^[_-]+|[_-]+$/g, '')
    .slice(0, 80);
  return safe || fallback;
}

function buildJobArchiveName(job, target) {
  const jobId = normalizeJobIdValue(job?.id) || 'unknown';
  const titlePart = sanitizeArchiveNamePart(job?.title || job?.detected_title || '', 'job');
  const targetPart = target === 'raw' ? 'raw' : 'encode';
  return `job-${jobId}-${titlePart}-${targetPart}.zip`;
}

function parseSourceJobIdFromPlan(encodePlanRaw) {
  const plan = parseInfoFromValue(encodePlanRaw, null);
  const sourceJobId = normalizeJobIdValue(plan?.sourceJobId);
  return sourceJobId || null;
}

function extractDiscNumberFromDeleteContext(row) {
  const values = [
    row?.raw_path,
    row?.title,
    row?.detected_title
  ];
  for (const value of values) {
    const raw = String(value || '').trim();
    if (!raw) continue;
    const match = raw.match(/(?:^|\W)D(?:ISC)?\s*[-_ ]?(\d+)(?:\W|$)/i)
      || raw.match(/-\s*D(\d+)\s*-\s*RAW/i);
    const discNumber = normalizeJobIdValue(match?.[1]);
    if (discNumber) {
      return discNumber;
    }
  }
  return null;
}

function resolveDeletePreviewRole(row) {
  if (!row || typeof row !== 'object') {
    return { roleKey: 'job', roleLabel: 'Job' };
  }
  if (isSeriesContainerRow(row) || isMultipartContainerRow(row)) {
    return { roleKey: 'container', roleLabel: 'Container' };
  }
  if (isMultipartMergeRow(row)) {
    return { roleKey: 'merge', roleLabel: 'Merge' };
  }
  if (isSeriesChildRow(row) || isMultipartChildRow(row)) {
    const discNumber = extractDiscNumberFromDeleteContext(row);
    return {
      roleKey: 'disc',
      roleLabel: discNumber ? `Disk ${discNumber}` : 'Disk/Child'
    };
  }
  if (normalizeJobIdValue(row?.parent_job_id)) {
    return { roleKey: 'child', roleLabel: 'Child-Job' };
  }
  return { roleKey: 'job', roleLabel: 'Einzeljob' };
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

function isHiddenDirectoryName(value) {
  return String(value || '').trim().startsWith('.');
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
  async createJob({
    discDevice = null,
    status = 'ANALYZING',
    detectedTitle = null,
    mediaType = null,
    jobKind = null
  }) {
    const db = await getDb();
    const startTime = new Date().toISOString();
    const normalizedMediaType = (() => {
      const normalized = normalizeMediaTypeValue(mediaType);
      if (normalized) {
        return normalized;
      }
      const legacy = String(mediaType || '').trim().toLowerCase();
      return legacy === 'converter' ? 'converter' : null;
    })();
    const normalizedJobKind = normalizeJobKindValue(jobKind);

    const result = await db.run(
      `
        INSERT INTO jobs (disc_device, status, start_time, detected_title, last_state, media_type, job_kind, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `,
      [discDevice, status, startTime, detectedTitle, status, normalizedMediaType, normalizedJobKind]
    );
    logger.info('job:created', {
      jobId: result.lastID,
      discDevice,
      status,
      detectedTitle,
      mediaType: normalizedMediaType,
      jobKind: normalizedJobKind
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
    return this.getJobById(jobId, { skipRepair: true });
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

      // Preserve known output folders when replacing a job.
      await db.run(
        `
          INSERT OR IGNORE INTO job_output_folders (job_id, output_path, label, created_at)
          SELECT ?, output_path, label, created_at
          FROM job_output_folders
          WHERE job_id = ?
        `,
        [toJobId, fromJobId]
      );
      if (outputPath) {
        await db.run(
          'INSERT OR IGNORE INTO job_output_folders (job_id, output_path, label) VALUES (?, ?, ?)',
          [toJobId, outputPath, 'Lineage-Output']
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
    const archivedProcessLogPath = this._archiveProcessLogFile(fromJobId, {
      replacementJobId: toJobId,
      reason
    });
    if (archivedProcessLogPath) {
      this.appendProcessLog(
        toJobId,
        'SYSTEM',
        `Vorheriger Prozess-Log von Job #${fromJobId} archiviert: ${archivedProcessLogPath}`
      );
    }

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
      reason,
      archivedProcessLogPath: archivedProcessLogPath || null
    };
  }

  async appendLog(jobId, source, message) {
    this.appendProcessLog(jobId, source, message);
  }

  async cacheAndPromoteExternalPoster(jobId, posterUrl, options = {}) {
    const normalizedJobId = normalizeJobIdValue(jobId);
    const normalizedPosterUrl = String(posterUrl || '').trim();
    const logFailures = options?.logFailures !== false;
    const sourceLabel = String(options?.source || 'Poster').trim() || 'Poster';
    const logPrefix = `${sourceLabel} Link`;

    if (!normalizedJobId) {
      return { ok: false, reason: 'invalid_job_id', localUrl: null };
    }
    if (!normalizedPosterUrl || thumbnailService.isLocalUrl(normalizedPosterUrl)) {
      return { ok: false, reason: 'no_external_url', localUrl: null };
    }

    const cacheResult = await thumbnailService.cacheJobThumbnailDetailed(normalizedJobId, normalizedPosterUrl);
    if (!cacheResult?.ok) {
      if (logFailures) {
        await this.appendLog(
          normalizedJobId,
          'SYSTEM',
          `${logPrefix} konnte nicht heruntergeladen werden: ${normalizedPosterUrl}${cacheResult?.error ? ` (${cacheResult.error})` : ''}`
        );
      }
      return {
        ok: false,
        reason: 'cache_failed',
        localUrl: null,
        error: cacheResult?.error || null
      };
    }

    const promotedUrl = thumbnailService.promoteJobThumbnail(normalizedJobId);
    if (!promotedUrl) {
      if (logFailures) {
        await this.appendLog(
          normalizedJobId,
          'SYSTEM',
          `${logPrefix} konnte nicht finalisiert werden: ${normalizedPosterUrl}`
        );
      }
      return { ok: false, reason: 'promote_failed', localUrl: null };
    }

    try {
      await this.updateJob(normalizedJobId, { poster_url: promotedUrl });
      return { ok: true, reason: 'ok', localUrl: promotedUrl, sourceUrl: normalizedPosterUrl };
    } catch (error) {
      logger.warn('thumbnail:update-job-failed', {
        jobId: normalizedJobId,
        posterUrl: normalizedPosterUrl,
        promotedUrl,
        error: error?.message || String(error)
      });
      if (logFailures) {
        await this.appendLog(
          normalizedJobId,
          'SYSTEM',
          `${logPrefix} wurde heruntergeladen, konnte aber nicht am Job gespeichert werden: ${normalizedPosterUrl}`
        );
      }
      return {
        ok: false,
        reason: 'update_failed',
        localUrl: null,
        error: error?.message || String(error)
      };
    }
  }

  queuePosterCache(jobId, posterUrl, options = {}) {
    const normalizedJobId = normalizeJobIdValue(jobId);
    if (!normalizedJobId) {
      return;
    }
    this.cacheAndPromoteExternalPoster(normalizedJobId, posterUrl, options).catch((error) => {
      logger.warn('thumbnail:queue-cache-failed', {
        jobId: normalizedJobId,
        posterUrl: String(posterUrl || '').trim() || null,
        error: error?.message || String(error)
      });
    });
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
      const line = `[${getServerTimestamp()}] [${source}] ${String(message || '')}\n`;
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

  buildRecoveredCdEncodePlan(recovery = {}) {
    const tracks = Array.isArray(recovery?.tracks) ? recovery.tracks : [];
    const selectedTracks = Array.isArray(recovery?.selectedTracks) ? recovery.selectedTracks : [];
    const format = normalizeCdFormat(recovery?.format) || null;
    const outputTemplate = String(recovery?.outputTemplate || cdRipService.DEFAULT_CD_OUTPUT_TEMPLATE).trim()
      || cdRipService.DEFAULT_CD_OUTPUT_TEMPLATE;

    if (tracks.length === 0 && selectedTracks.length === 0 && !format) {
      return null;
    }

    return {
      format,
      formatOptions: {},
      selectedTracks: selectedTracks.length > 0
        ? selectedTracks
        : tracks
          .map((track) => Number(track?.position))
          .filter((value) => Number.isFinite(value) && value > 0)
          .map((value) => Math.trunc(value)),
      tracks,
      outputTemplate,
      recoveredFrom: {
        source: 'orphan_raw_import',
        importedLogFiles: Array.isArray(recovery?.importedLogFiles) ? recovery.importedLogFiles : [],
        outputPath: recovery?.outputPath || null,
        outputPathExists: Boolean(recovery?.outputPathExists)
      }
    };
  }

  buildOrphanRawImportMakemkvInfo(options = {}) {
    const mediaProfile = normalizeMediaTypeValue(options.mediaProfile) || 'other';
    const importedAt = String(options.importedAt || new Date().toISOString()).trim() || new Date().toISOString();
    const rawPath = String(options.rawPath || '').trim() || null;
    const stripRecoveryMetadata = Boolean(options.stripRecoveryMetadata);
    const existingInfo = options.existingInfo && typeof options.existingInfo === 'object'
      ? options.existingInfo
      : {};
    const recovery = options.recovery && typeof options.recovery === 'object'
      ? options.recovery
      : null;
    const analyzeContextPatch = options.analyzeContextPatch && typeof options.analyzeContextPatch === 'object'
      ? options.analyzeContextPatch
      : {};
    const providedSelectedMetadata = options.selectedMetadata && typeof options.selectedMetadata === 'object'
      ? options.selectedMetadata
      : {};
    const compactMetadataObject = (input) => Object.fromEntries(
      Object.entries(input || {}).filter(([, value]) => {
        if (value === null || value === undefined) {
          return false;
        }
        if (typeof value === 'string') {
          return value.trim().length > 0;
        }
        return true;
      })
    );
    const existingSelectedMetadata = compactMetadataObject(extractSelectedMetadataFromMakemkvInfo(existingInfo));
    const normalizedProvidedSelectedMetadata = compactMetadataObject(providedSelectedMetadata);
    const mergedSelectedMetadata = {
      ...existingSelectedMetadata,
      ...normalizedProvidedSelectedMetadata
    };
    const existingAnalyzeContext = existingInfo.analyzeContext && typeof existingInfo.analyzeContext === 'object'
      ? existingInfo.analyzeContext
      : {};
    const previousImportContext = existingInfo.importContext && typeof existingInfo.importContext === 'object'
      ? existingInfo.importContext
      : {};
    const nextImportContext = {
      ...previousImportContext,
      requestedRawPath: String(options.requestedRawPath || previousImportContext.requestedRawPath || rawPath || '').trim() || null,
      sourceFolderJobId: normalizeJobIdValue(
        options.sourceFolderJobId
        ?? previousImportContext.sourceFolderJobId
        ?? null
      )
    };

    if (recovery?.outputPath) {
      nextImportContext.recoveredOutputPath = recovery.outputPath;
    }
    if (Array.isArray(recovery?.importedLogFiles) && recovery.importedLogFiles.length > 0) {
      nextImportContext.importedLogFiles = recovery.importedLogFiles;
    }

    const nextInfo = {
      ...existingInfo,
      status: 'SUCCESS',
      source: 'orphan_raw_import',
      importedAt,
      rawPath,
      mediaProfile,
      analyzeContext: {
        ...existingAnalyzeContext,
        ...analyzeContextPatch,
        mediaProfile
      },
      importContext: nextImportContext
    };

    if (Object.keys(mergedSelectedMetadata).length > 0) {
      nextInfo.selectedMetadata = mergedSelectedMetadata;
      nextInfo.analyzeContext = {
        ...nextInfo.analyzeContext,
        selectedMetadata: {
          ...(existingAnalyzeContext.selectedMetadata && typeof existingAnalyzeContext.selectedMetadata === 'object'
            ? existingAnalyzeContext.selectedMetadata
            : {}),
          ...mergedSelectedMetadata
        }
      };
    }

    if (mediaProfile === 'cd' && recovery) {
      if (Array.isArray(recovery.tracks) && recovery.tracks.length > 0) {
        nextInfo.tracks = recovery.tracks;
      }
      if (!stripRecoveryMetadata && recovery.selectedMetadata && typeof recovery.selectedMetadata === 'object') {
        const recoverySelectedMetadata = compactMetadataObject(recovery.selectedMetadata);
        nextInfo.selectedMetadata = {
          ...(nextInfo.selectedMetadata && typeof nextInfo.selectedMetadata === 'object'
            ? nextInfo.selectedMetadata
            : {}),
          ...recoverySelectedMetadata
        };
        nextInfo.analyzeContext = {
          ...nextInfo.analyzeContext,
          selectedMetadata: {
            ...(nextInfo.analyzeContext?.selectedMetadata && typeof nextInfo.analyzeContext.selectedMetadata === 'object'
              ? nextInfo.analyzeContext.selectedMetadata
              : {}),
            ...nextInfo.selectedMetadata
          }
        };
      }
      nextInfo.cdparanoiaCmd = String(
        recovery.cdparanoiaCmd
        || existingInfo.cdparanoiaCmd
        || 'cdparanoia'
      ).trim() || 'cdparanoia';
      nextInfo.importRecovery = {
        source: 'orphan_raw_import',
        importedAt,
        logFiles: Array.isArray(recovery.importedLogFiles) ? recovery.importedLogFiles : [],
        outputPath: recovery.outputPath || null,
        outputPathExists: Boolean(recovery.outputPathExists),
        recoveredFormat: normalizeCdFormat(recovery.format),
        selectedTracks: Array.isArray(recovery.selectedTracks) ? recovery.selectedTracks : []
      };
    }

    return nextInfo;
  }

  async restoreImportedProcessLog(jobId, logSources = [], options = {}) {
    const normalizedJobId = normalizeJobIdValue(jobId);
    if (!normalizedJobId) {
      return {
        imported: false,
        sourceCount: 0,
        lineCount: 0
      };
    }

    const normalizedSources = (Array.isArray(logSources) ? logSources : [])
      .filter((source) => source && source.filePath && Array.isArray(source.lines) && source.lines.length > 0);
    const importInfo = options.importInfo && typeof options.importInfo === 'object'
      ? options.importInfo
      : null;
    const shouldAppend = Boolean(options.append);
    if (normalizedSources.length === 0 && !importInfo) {
      return {
        imported: false,
        sourceCount: 0,
        lineCount: 0
      };
    }

    const filePath = toProcessLogPath(normalizedJobId);
    if (!filePath) {
      return {
        imported: false,
        sourceCount: 0,
        lineCount: 0
      };
    }

    await this.closeProcessLog(normalizedJobId);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    if (!shouldAppend) {
      try {
        fs.unlinkSync(filePath);
      } catch (_error) {
        // ignore missing file on overwrite
      }
    }

    const lines = [];
    if (normalizedSources.length > 0) {
      const fileSummary = normalizedSources
        .map((source) => source.fileName || path.basename(source.filePath))
        .filter(Boolean)
        .join(', ');
      lines.push(
        `[${getServerTimestamp()}] [SYSTEM] Importierte vorhandene Job-Logs: ${fileSummary}`
      );
      for (const source of normalizedSources) {
        lines.push(...source.lines);
      }
    }
    if (importInfo) {
      lines.push(
        `[${getServerTimestamp()}] [SYSTEM] Orphan-RAW-Import Zusatzinfo: ${JSON.stringify(importInfo)}`
      );
    }

    if (lines.length === 0) {
      return {
        imported: false,
        sourceCount: normalizedSources.length,
        lineCount: 0
      };
    }

    try {
      const prefix = shouldAppend && fs.existsSync(filePath) && fs.statSync(filePath).size > 0 ? '\n' : '';
      fs.writeFileSync(filePath, `${prefix}${lines.join('\n')}\n`, {
        encoding: 'utf-8',
        flag: shouldAppend ? 'a' : 'w'
      });
    } catch (error) {
      logger.warn('job:process-log:restore-failed', {
        jobId: normalizedJobId,
        path: filePath,
        error: error?.message || String(error)
      });
      return {
        imported: false,
        sourceCount: normalizedSources.length,
        lineCount: 0
      };
    }

    return {
      imported: normalizedSources.length > 0,
      sourceCount: normalizedSources.length,
      lineCount: lines.length
    };
  }

  async resolveOrphanImportSourceJob(options = {}) {
    const candidateJobIds = Array.isArray(options.candidateJobIds)
      ? options.candidateJobIds
        .map((value) => normalizeJobIdValue(value))
        .filter(Boolean)
      : [];
    const desiredMediaProfile = normalizeMediaTypeValue(options.mediaProfile) || null;
    if (candidateJobIds.length === 0) {
      return null;
    }

    const uniqueCandidateIds = Array.from(new Set(candidateJobIds));
    const db = await getDb();
    const placeholders = uniqueCandidateIds.map(() => '?').join(', ');
    const rows = await db.all(
      `SELECT * FROM jobs WHERE id IN (${placeholders})`,
      uniqueCandidateIds
    );
    if (!Array.isArray(rows) || rows.length === 0) {
      return null;
    }

    const byId = new Map(rows.map((row) => [normalizeJobIdValue(row?.id), row]));
    let best = null;
    let bestScore = -1;

    for (const candidateId of uniqueCandidateIds) {
      const row = byId.get(candidateId);
      if (!row) {
        continue;
      }

      const makemkvInfo = parseJsonSafe(row.makemkv_info_json, {});
      const selectedMetadata = extractSelectedMetadataFromMakemkvInfo(makemkvInfo);
      const analyzeContext = makemkvInfo?.analyzeContext && typeof makemkvInfo.analyzeContext === 'object'
        ? makemkvInfo.analyzeContext
        : {};
      const rowMediaProfile = normalizeMediaTypeValue(
        makemkvInfo?.analyzeContext?.mediaProfile
        || makemkvInfo?.mediaProfile
        || inferMediaTypeFromJobKind(row?.job_kind)
        || row?.media_type
      );
      const posterCandidate = String(
        row?.poster_url
        || selectedMetadata?.coverUrl
        || selectedMetadata?.poster
        || selectedMetadata?.posterUrl
        || ''
      ).trim() || null;
      const hasTitle = Boolean(String(
        selectedMetadata?.title
        || selectedMetadata?.album
        || row?.title
        || row?.detected_title
        || ''
      ).trim());
      const hasArtist = Boolean(String(selectedMetadata?.artist || '').trim());
      const hasPoster = Boolean(posterCandidate);
      const hasExternalMetadata = Boolean(
        row?.imdb_id
        || selectedMetadata?.tmdbId
        || analyzeContext?.tmdbId
        || selectedMetadata?.mbId
        || selectedMetadata?.musicBrainzId
        || selectedMetadata?.musicbrainzId
        || selectedMetadata?.musicbrainz_id
        || selectedMetadata?.music_brainz_id
        || selectedMetadata?.musicbrainz
        || selectedMetadata?.mbid
      );
      const isFinished = String(row?.status || row?.last_state || '').trim().toUpperCase() === 'FINISHED';

      let score = 0;
      if (desiredMediaProfile && rowMediaProfile === desiredMediaProfile) {
        score += 10;
      }
      if (hasTitle) {
        score += 6;
      }
      if (desiredMediaProfile === 'cd' && hasArtist) {
        score += 4;
      }
      if (hasPoster) {
        score += 3;
      }
      if (hasExternalMetadata) {
        score += 2;
      }
      if (isFinished) {
        score += 1;
      }

      if (score > bestScore) {
        bestScore = score;
        best = {
          job: row,
          makemkvInfo,
          selectedMetadata,
          analyzeContext,
          mediaProfile: rowMediaProfile,
          posterCandidate
        };
      }
    }

    return best;
  }

  getPreferredPosterCandidateForImport(sourceContext = null, explicitPosterUrl = null) {
    const explicit = String(explicitPosterUrl || '').trim() || null;
    if (explicit) {
      return explicit;
    }
    const sourceJob = sourceContext?.job && typeof sourceContext.job === 'object'
      ? sourceContext.job
      : null;
    const selectedMetadata = sourceContext?.selectedMetadata && typeof sourceContext.selectedMetadata === 'object'
      ? sourceContext.selectedMetadata
      : {};
    return String(
      sourceJob?.poster_url
      || selectedMetadata?.coverUrl
      || selectedMetadata?.poster
      || selectedMetadata?.posterUrl
      || ''
    ).trim() || null;
  }

  async restoreImportedPoster(jobId, sourceContext = null, explicitPosterUrl = null) {
    const normalizedJobId = normalizeJobIdValue(jobId);
    if (!normalizedJobId) {
      return null;
    }

    const sourceJob = sourceContext?.job && typeof sourceContext.job === 'object'
      ? sourceContext.job
      : null;
    const sourceJobId = normalizeJobIdValue(sourceJob?.id);
    const sourcePosterUrl = String(sourceJob?.poster_url || '').trim() || null;
    if (sourceJobId && sourcePosterUrl && thumbnailService.isLocalUrl(sourcePosterUrl)) {
      const copiedUrl = thumbnailService.copyThumbnail(sourceJobId, normalizedJobId);
      if (copiedUrl) {
        await this.updateJob(normalizedJobId, { poster_url: copiedUrl });
        return copiedUrl;
      }
    }

    const preferredPosterUrl = this.getPreferredPosterCandidateForImport(sourceContext, explicitPosterUrl);
    if (!preferredPosterUrl || thumbnailService.isLocalUrl(preferredPosterUrl)) {
      return null;
    }

    const result = await this.cacheAndPromoteExternalPoster(normalizedJobId, preferredPosterUrl, {
      source: 'Coverart',
      logFailures: true
    });
    if (!result?.ok || !result.localUrl) {
      return null;
    }
    return result.localUrl;
  }

  async repairImportedCdJobArtifacts(job, settings = null) {
    if (!job || typeof job !== 'object') {
      return job;
    }

    const makemkvInfo = parseJsonSafe(job.makemkv_info_json, null);
    const mediaProfile = normalizeMediaTypeValue(
      makemkvInfo?.mediaProfile
      || makemkvInfo?.analyzeContext?.mediaProfile
      || inferMediaTypeFromJobKind(job?.job_kind)
      || job?.media_type
    );
    if (String(makemkvInfo?.source || '').trim().toLowerCase() !== 'orphan_raw_import' || mediaProfile !== 'cd') {
      return job;
    }

    const hasTracks = Array.isArray(makemkvInfo?.tracks) && makemkvInfo.tracks.length > 0;
    const hasEncodePlan = Boolean(String(job?.encode_plan_json || '').trim());
    const outputPathRaw = String(job?.output_path || '').trim();
    const hasOutputPath = Boolean(outputPathRaw);
    const outputPathExists = hasOutputPath && (() => {
      try {
        return fs.existsSync(outputPathRaw);
      } catch (_error) {
        return false;
      }
    })();
    const hasExistingLog = hasProcessLogFile(job.id);
    if (hasTracks && hasEncodePlan && hasOutputPath && outputPathExists && hasExistingLog) {
      return job;
    }

    const importContext = makemkvInfo?.importContext && typeof makemkvInfo.importContext === 'object'
      ? makemkvInfo.importContext
      : {};
    const rawPathCandidates = [
      job?.raw_path,
      makemkvInfo?.rawPath,
      importContext?.requestedRawPath,
      importContext?.originalRawPath
    ].filter(Boolean);
    const currentRawPath = String(job?.raw_path || makemkvInfo?.rawPath || '').trim() || null;
    const rawFolderMeta = parseRawFolderMetadata(path.basename(currentRawPath || rawPathCandidates[0] || ''));
    const recovery = recoverCdJobArtifactsForImport({
      currentRawPath,
      rawPathCandidates,
      relatedJobIds: [
        importContext?.sourceFolderJobId,
        rawFolderMeta.folderJobId
      ],
      excludeJobIds: [],
      settings: settings || {},
      baseMetadata: {
        title: job?.title || makemkvInfo?.selectedMetadata?.title || null,
        album: makemkvInfo?.selectedMetadata?.album || job?.title || null,
        artist: makemkvInfo?.selectedMetadata?.artist || null,
        year: makemkvInfo?.selectedMetadata?.year || job?.year || null
      },
      fallbackOutputPath: job?.output_path || null
    });
    const sourceJobContext = await this.resolveOrphanImportSourceJob({
      candidateJobIds: [
        importContext?.sourceFolderJobId,
        rawFolderMeta.folderJobId,
        ...recovery.logSources.map((source) => source?.jobId)
      ],
      mediaProfile: 'cd'
    });
    const sourceJob = sourceJobContext?.job || null;
    const sourceSelectedMetadata = sourceJobContext?.selectedMetadata && typeof sourceJobContext.selectedMetadata === 'object'
      ? sourceJobContext.selectedMetadata
      : {};
    const sourcePosterCandidate = this.getPreferredPosterCandidateForImport(sourceJobContext, null);

    const recoveryHasData = recovery.outputPath || recovery.logSources.length > 0 || recovery.tracks.length > 0;
    if (!recoveryHasData && !sourceJob) {
      return job;
    }

    const importedAt = String(makemkvInfo?.importedAt || job?.end_time || new Date().toISOString()).trim()
      || new Date().toISOString();
    const nextMakemkvInfo = this.buildOrphanRawImportMakemkvInfo({
      importedAt,
      rawPath: currentRawPath,
      requestedRawPath: importContext?.requestedRawPath || currentRawPath,
      sourceFolderJobId: importContext?.sourceFolderJobId || rawFolderMeta.folderJobId || null,
      mediaProfile: 'cd',
      existingInfo: makemkvInfo,
      recovery
    });
    const nextEncodePlan = this.buildRecoveredCdEncodePlan(recovery);
    const patch = {};
    const nextMakemkvInfoJson = JSON.stringify(nextMakemkvInfo);

    if (nextMakemkvInfoJson !== String(job?.makemkv_info_json || '')) {
      patch.makemkv_info_json = nextMakemkvInfoJson;
    }
    if (!hasEncodePlan && nextEncodePlan) {
      patch.encode_plan_json = JSON.stringify(nextEncodePlan);
    }
    const recoveredOutputPath = String(recovery.outputPath || '').trim() || null;
    const normalizedOutputPath = hasOutputPath ? normalizeComparablePath(outputPathRaw) : null;
    const normalizedRecoveredOutputPath = recoveredOutputPath ? normalizeComparablePath(recoveredOutputPath) : null;
    const recoveredOutputPathExists = Boolean(recovery.outputPathExists);
    const shouldPatchOutputPath = Boolean(
      recoveredOutputPath
      && (
        !hasOutputPath
        || (
          !outputPathExists
          && (
            recoveredOutputPathExists
            || recovery.logSources.length > 0
          )
        )
      )
      && normalizedRecoveredOutputPath !== normalizedOutputPath
    );
    if (shouldPatchOutputPath) {
      patch.output_path = recoveredOutputPath;
    }
    if (!job?.title && nextMakemkvInfo?.selectedMetadata?.title) {
      patch.title = nextMakemkvInfo.selectedMetadata.title;
    } else if (!job?.title && (sourceSelectedMetadata?.title || sourceSelectedMetadata?.album || sourceJob?.title)) {
      patch.title = sourceSelectedMetadata.title || sourceSelectedMetadata.album || sourceJob.title;
    }
    if (!job?.year && nextMakemkvInfo?.selectedMetadata?.year) {
      patch.year = nextMakemkvInfo.selectedMetadata.year;
    } else if (!job?.year && (sourceSelectedMetadata?.year || sourceJob?.year)) {
      patch.year = sourceSelectedMetadata.year ?? sourceJob.year ?? null;
    }
    if (!job?.imdb_id) {
      const recoveredMbId = String(
        sourceSelectedMetadata?.mbId
        || sourceSelectedMetadata?.musicBrainzId
        || sourceSelectedMetadata?.musicbrainzId
        || sourceSelectedMetadata?.musicbrainz_id
        || sourceSelectedMetadata?.music_brainz_id
        || sourceSelectedMetadata?.musicbrainz
        || sourceSelectedMetadata?.mbid
        || sourceJob?.imdb_id
        || ''
      ).trim() || null;
      if (recoveredMbId) {
        patch.imdb_id = recoveredMbId;
      }
    }
    if (!job?.poster_url && sourcePosterCandidate && !thumbnailService.isLocalUrl(sourcePosterCandidate)) {
      patch.poster_url = sourcePosterCandidate;
    }

    if (!hasExistingLog && recovery.logSources.length > 0) {
      await this.restoreImportedProcessLog(job.id, recovery.logSources, {
        importInfo: nextMakemkvInfo
      });
    }

    let updatedJob = job;
    if (Object.keys(patch).length > 0) {
      updatedJob = await this.updateJob(job.id, patch);
    }

    if (!job?.poster_url && sourcePosterCandidate) {
      await this.restoreImportedPoster(job.id, sourceJobContext, sourcePosterCandidate);
      updatedJob = await this.getJobById(job.id);
    }

    return updatedJob;
  }

  async repairImportedOrphanJobClassification(job, settings = null) {
    if (!job || typeof job !== 'object') {
      return job;
    }

    const makemkvInfo = parseJsonSafe(job.makemkv_info_json, null);
    if (String(makemkvInfo?.source || '').trim().toLowerCase() !== 'orphan_raw_import') {
      return job;
    }

    const settingsMap = settings && typeof settings === 'object'
      ? settings
      : {};
    const resolvedRawPath = String(
      job?.raw_path
      || makemkvInfo?.rawPath
      || ''
    ).trim() || null;
    const folderMeta = parseRawFolderMetadata(path.basename(String(resolvedRawPath || '').trim()));
    const seriesRawPathHint = isLikelySeriesRawPath(resolvedRawPath, settingsMap);
    const detectedMediaType = detectOrphanMediaType(resolvedRawPath, { seriesRawPathHint });
    const mkMediaType = normalizeMediaTypeValue(
      makemkvInfo?.analyzeContext?.mediaProfile
      || makemkvInfo?.mediaProfile
      || inferMediaTypeFromJobKind(job?.job_kind)
      || job?.media_type
    );
    const effectiveMediaType = detectedMediaType === 'other'
      ? (mkMediaType || (seriesRawPathHint ? 'dvd' : 'other'))
      : detectedMediaType;
    const patch = {};

    if (['bluray', 'dvd', 'cd', 'audiobook'].includes(effectiveMediaType)) {
      if (normalizeMediaTypeValue(job?.media_type) !== effectiveMediaType) {
        patch.media_type = effectiveMediaType;
      }
      if (normalizeJobKindValue(job?.job_kind) !== effectiveMediaType) {
        patch.job_kind = effectiveMediaType;
      }
    }

    let nextMakemkvInfo = makemkvInfo && typeof makemkvInfo === 'object'
      ? makemkvInfo
      : {};
    const selectedMetadata = extractSelectedMetadataFromMakemkvInfo(nextMakemkvInfo);
    const analyzeContext = nextMakemkvInfo?.analyzeContext && typeof nextMakemkvInfo.analyzeContext === 'object'
      ? nextMakemkvInfo.analyzeContext
      : {};
    const hasSeriesSignals = hasSeriesMetadataSignals(selectedMetadata, analyzeContext);

    if (effectiveMediaType === 'dvd' && seriesRawPathHint && !hasSeriesSignals) {
      const seriesImportHints = buildSeriesImportHints({
        folderName: path.basename(String(resolvedRawPath || '').trim()),
        rawPath: resolvedRawPath,
        metadata: folderMeta,
        sourceSelectedMetadata: selectedMetadata,
        sourceAnalyzeContext: analyzeContext
      });
      if (seriesImportHints) {
        nextMakemkvInfo = this.buildOrphanRawImportMakemkvInfo({
          importedAt: nextMakemkvInfo?.importedAt || job?.end_time || new Date().toISOString(),
          rawPath: resolvedRawPath,
          requestedRawPath: nextMakemkvInfo?.importContext?.requestedRawPath || resolvedRawPath,
          sourceFolderJobId: nextMakemkvInfo?.importContext?.sourceFolderJobId || folderMeta.folderJobId || null,
          mediaProfile: effectiveMediaType,
          existingInfo: nextMakemkvInfo,
          selectedMetadata: seriesImportHints.selectedMetadata,
          analyzeContextPatch: seriesImportHints.analyzeContextPatch
        });
      }
    } else if (
      effectiveMediaType !== 'other'
      && normalizeMediaTypeValue(nextMakemkvInfo?.analyzeContext?.mediaProfile || nextMakemkvInfo?.mediaProfile) !== effectiveMediaType
    ) {
      nextMakemkvInfo = this.buildOrphanRawImportMakemkvInfo({
        importedAt: nextMakemkvInfo?.importedAt || job?.end_time || new Date().toISOString(),
        rawPath: resolvedRawPath,
        requestedRawPath: nextMakemkvInfo?.importContext?.requestedRawPath || resolvedRawPath,
        sourceFolderJobId: nextMakemkvInfo?.importContext?.sourceFolderJobId || folderMeta.folderJobId || null,
        mediaProfile: effectiveMediaType,
        existingInfo: nextMakemkvInfo
      });
    }

    const nextMakemkvInfoJson = JSON.stringify(nextMakemkvInfo || {});
    if (nextMakemkvInfoJson !== String(job?.makemkv_info_json || '')) {
      patch.makemkv_info_json = nextMakemkvInfoJson;
    }

    if (Object.keys(patch).length === 0) {
      return job;
    }
    return this.updateJob(job.id, patch);
  }

  async getJobById(jobId, options = {}) {
    const db = await getDb();
    const row = await db.get('SELECT * FROM jobs WHERE id = ?', [jobId]);
    if (!row || options?.skipRepair) {
      return row;
    }
    const settings = options?.settings && typeof options.settings === 'object'
      ? options.settings
      : await settingsService.getSettingsMap();
    return this.repairImportedOrphanJobClassification(row, settings);
  }

  async getJobs(filters = {}) {
    const db = await getDb();
    const where = [];
    const values = [];
    const includeFsChecks = filters?.includeFsChecks !== false;
    const includeChildren = filters?.includeChildren === true;
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

    if (!includeChildren) {
      where.push(`parent_job_id IS NULL`);
    }

    const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

    const [jobs, settings] = await Promise.all([
      db.all(
        `
        SELECT j.*
        FROM jobs j
        ${whereClause}
        ORDER BY COALESCE(j.updated_at, j.created_at) DESC, j.id DESC
        LIMIT ${limit}
      `,
        values
      ),
      settingsService.getSettingsMap()
    ]);

    const repairedJobs = await Promise.all(
      jobs.map((job) => this.repairImportedOrphanJobClassification(job, settings))
    );
    const derivedParentIds = new Set(
      repairedJobs
        .map((job) => normalizeJobIdValue(job?.parent_job_id))
        .filter(Boolean)
    );
    const adjustedJobs = repairedJobs.map((job) => {
      const normalizedId = normalizeJobIdValue(job?.id);
      const hasParent = normalizeJobIdValue(job?.parent_job_id) !== null;
      const jobKind = String(job?.job_kind || '').trim().toLowerCase();
      if (hasParent && !jobKind) {
        return { ...job, job_kind: 'dvd_series_child' };
      }
      if (!hasParent && normalizedId && derivedParentIds.has(normalizedId) && !jobKind) {
        return { ...job, job_kind: 'dvd_series_container' };
      }
      return job;
    });

    const containerJobs = adjustedJobs.filter((job) => isDiskContainerRow(job));
    const containerIds = containerJobs.map((job) => normalizeJobIdValue(job?.id)).filter(Boolean);
    const seriesCandidates = adjustedJobs.filter((job) => {
      const mkInfo = parseJsonSafe(job?.makemkv_info_json, {});
      const analyzeContext = mkInfo?.analyzeContext && typeof mkInfo.analyzeContext === 'object'
        ? mkInfo.analyzeContext
        : {};
      const selected = mkInfo?.analyzeContext?.selectedMetadata || mkInfo?.selectedMetadata || {};
      const tmdbId = Number(selected?.tmdbId || 0) || null;
      const seasonNumber = Number(selected?.seasonNumber || 0) || null;
      return (tmdbId && seasonNumber) || hasSeriesMetadataSignals(selected, analyzeContext);
    });
    const seriesCandidateIds = seriesCandidates.map((job) => normalizeJobIdValue(job?.id)).filter(Boolean);
    let childRows = [];
    let nestedChildRows = [];
    let outputFolders = [];
    if (containerIds.length > 0) {
      const placeholders = containerIds.map(() => '?').join(', ');
      childRows = await db.all(
        `SELECT id, parent_job_id, output_path, raw_path, handbrake_info_json, status, encode_plan_json, makemkv_info_json, rip_successful FROM jobs WHERE parent_job_id IN (${placeholders})`,
        containerIds
      );
      const childIds = childRows.map((row) => normalizeJobIdValue(row?.id)).filter(Boolean);
      if (childIds.length > 0) {
        const childPlaceholders = childIds.map(() => '?').join(', ');
        nestedChildRows = await db.all(
          `SELECT id, parent_job_id, output_path, raw_path, handbrake_info_json, status, encode_plan_json, makemkv_info_json, rip_successful FROM jobs WHERE parent_job_id IN (${childPlaceholders})`,
          childIds
        );
      }
      const summaryJobIds = Array.from(new Set([
        ...childRows.map((row) => normalizeJobIdValue(row?.id)).filter(Boolean),
        ...nestedChildRows.map((row) => normalizeJobIdValue(row?.id)).filter(Boolean)
      ]));
      if (summaryJobIds.length > 0) {
        const childPlaceholders = summaryJobIds.map(() => '?').join(', ');
        outputFolders = await db.all(
          `SELECT job_id, output_path FROM job_output_folders WHERE job_id IN (${childPlaceholders})`,
          summaryJobIds
        );
      }
    }

    const allContainerChildRows = [...childRows, ...nestedChildRows];
    const directDiskRowsByContainerId = new Map();
    const directEpisodeRowsByContainerId = new Map();
    const directChildRowById = new Map();
    for (const row of childRows) {
      const containerId = normalizeJobIdValue(row?.parent_job_id);
      const isEpisodeSubJob = isSeriesBatchEpisodeSubJobRow(row);
      if (containerId) {
        const map = isEpisodeSubJob
          ? directEpisodeRowsByContainerId
          : directDiskRowsByContainerId;
        if (!map.has(containerId)) {
          map.set(containerId, []);
        }
        map.get(containerId).push(row);
      }
      if (isEpisodeSubJob) {
        continue;
      }
      const childId = normalizeJobIdValue(row?.id);
      if (childId) {
        directChildRowById.set(childId, row);
      }
    }
    const nestedRowsByParentId = new Map();
    for (const row of nestedChildRows) {
      const parentId = normalizeJobIdValue(row?.parent_job_id);
      if (!parentId) {
        continue;
      }
      if (!nestedRowsByParentId.has(parentId)) {
        nestedRowsByParentId.set(parentId, []);
      }
      nestedRowsByParentId.get(parentId).push(row);
    }

    const childOutputMap = new Map();
    for (const child of allContainerChildRows) {
      const childId = normalizeJobIdValue(child?.id);
      if (!childId) {
        continue;
      }
      if (!childOutputMap.has(childId)) {
        childOutputMap.set(childId, new Set());
      }
      const childSet = childOutputMap.get(childId);
      const directOutput = String(child?.output_path || '').trim();
      if (directOutput) {
        childSet.add(directOutput);
      }
    }
    for (const folder of outputFolders) {
      const childId = normalizeJobIdValue(folder?.job_id);
      if (!childId) {
        continue;
      }
      if (!childOutputMap.has(childId)) {
        childOutputMap.set(childId, new Set());
      }
      const outputPath = String(folder?.output_path || '').trim();
      if (outputPath) {
        childOutputMap.get(childId).add(outputPath);
      }
    }

    const containerOutputSummary = new Map();
    const containerRawSummary = new Map();
    const containerEncodeSummary = new Map();
    const containerChildSummary = new Map();
    for (const container of containerJobs) {
      const containerId = normalizeJobIdValue(container?.id);
      if (!containerId) {
        continue;
      }
      const containerKind = String(container?.job_kind || '').trim().toLowerCase();
      const isMultipartContainer = containerKind === 'multipart_movie_container';
      const mkInfo = parseJsonSafe(container?.makemkv_info_json, {});
      const selectedMetadata = mkInfo?.analyzeContext?.selectedMetadata || mkInfo?.selectedMetadata || {};
      const episodeCount = Number(selectedMetadata?.episodeCount || 0);
      const episodesLength = Array.isArray(selectedMetadata?.episodes) ? selectedMetadata.episodes.length : 0;
      const containerChildRowsRaw = directDiskRowsByContainerId.get(containerId) || [];
      const containerChildRows = isMultipartContainer
        ? containerChildRowsRaw.filter((row) => !isMultipartMergeRow(row))
        : containerChildRowsRaw;
      const containerEpisodeRows = directEpisodeRowsByContainerId.get(containerId) || [];
      const expectedTotal = isMultipartContainer
        ? containerChildRows.length
        : (episodeCount > 0 ? episodeCount : (episodesLength > 0 ? episodesLength : 0));
      const childIds = containerChildRows
        .map((row) => normalizeJobIdValue(row?.id))
        .filter(Boolean);
      let rawExistsAny = false;
      let encodeSuccessAny = false;
      let rawExistsCount = 0;
      let backupSuccessCount = 0;
      let encodeSuccessCount = 0;
      let expectedFromPlans = 0;
      const seenOutputs = new Set();
      let existingCount = 0;
      let existingCountFromSeriesBatch = 0;
      const totalChildren = childIds.length;
      for (const childId of childIds) {
        const childRow = directChildRowById.get(childId) || null;
        const descendantRows = nestedRowsByParentId.get(childId) || [];
        const relatedRows = [childRow, ...descendantRows].filter(Boolean);
        if (childRow) {
          const rawPath = String(childRow?.raw_path || '').trim();
          if (rawPath) {
            const resolvedChildPaths = resolveEffectiveStoragePathsForJob(settings, childRow);
            const rawStatus = includeFsChecks
              ? inspectDirectory(resolvedChildPaths.effectiveRawPath)
              : buildUnknownDirectoryStatus(resolvedChildPaths.effectiveRawPath);
            if (rawStatus?.exists) {
              rawExistsAny = true;
              rawExistsCount += 1;
            }
          }
          const mkInfo = parseJsonSafe(childRow?.makemkv_info_json, null);
          const ripSuccessful = Number(childRow?.rip_successful || 0) === 1
            || String(mkInfo?.status || '').trim().toUpperCase() === 'SUCCESS';
          if (ripSuccessful) {
            backupSuccessCount += 1;
          }
          let selectedCount = 0;
          const childPlan = parseJsonSafe(childRow?.encode_plan_json, null);
          if (childPlan && typeof childPlan === 'object') {
            selectedCount = countSelectedEpisodeSlotsFromPlan(childPlan);
          }
          const handbrakeInfo = parseJsonSafe(childRow?.handbrake_info_json, null);
          const hbStatus = String(handbrakeInfo?.status || '').trim().toUpperCase();
          const seriesBatchSummary = handbrakeInfo?.seriesBatch && typeof handbrakeInfo.seriesBatch === 'object'
            ? handbrakeInfo.seriesBatch
            : null;
          const seriesBatchTotal = Number(seriesBatchSummary?.totalCount || 0);
          const seriesBatchFinished = Number(seriesBatchSummary?.finishedCount || 0);
          const seriesBatchErrors = Number(seriesBatchSummary?.errorCount || 0);
          const seriesBatchCancelled = Number(seriesBatchSummary?.cancelledCount || 0);
          const expectedFromNested = descendantRows.length > 0 ? descendantRows.length : 0;
          const expectedFromChild = seriesBatchTotal > 0
            ? seriesBatchTotal
            : (selectedCount > 0 ? selectedCount : expectedFromNested);
          if (expectedFromChild > 0) {
            expectedFromPlans += expectedFromChild;
          }
          if (seriesBatchFinished > 0) {
            existingCountFromSeriesBatch += seriesBatchFinished;
          }

          let childEncodeSuccess = hbStatus === 'SUCCESS';
          if (
            !childEncodeSuccess
            && seriesBatchTotal > 0
            && seriesBatchFinished >= seriesBatchTotal
            && seriesBatchErrors <= 0
            && seriesBatchCancelled <= 0
          ) {
            childEncodeSuccess = true;
          }
          if (!childEncodeSuccess && descendantRows.length > 0) {
            let finishedDescendants = 0;
            let errorDescendants = 0;
            let cancelledDescendants = 0;
            for (const row of descendantRows) {
              const rowState = String(row?.status || row?.last_state || '').trim().toUpperCase();
              if (rowState === 'FINISHED') {
                finishedDescendants += 1;
              } else if (rowState === 'ERROR') {
                errorDescendants += 1;
              } else if (rowState === 'CANCELLED') {
                cancelledDescendants += 1;
              }
            }
            childEncodeSuccess = finishedDescendants >= descendantRows.length
              && errorDescendants === 0
              && cancelledDescendants === 0;
          }
          if (childEncodeSuccess) {
            encodeSuccessAny = true;
            encodeSuccessCount += 1;
          }
        } else if (descendantRows.length > 0) {
          expectedFromPlans += descendantRows.length;
        }
        for (const relatedRow of relatedRows) {
          const relatedRowId = normalizeJobIdValue(relatedRow?.id);
          if (!relatedRowId) {
            continue;
          }
          const outputs = Array.from(childOutputMap.get(relatedRowId) || []);
          for (const outputPath of outputs) {
            if (!outputPath || seenOutputs.has(outputPath)) {
              continue;
            }
            seenOutputs.add(outputPath);
            if (!includeFsChecks || fs.existsSync(outputPath)) {
              existingCount += 1;
            }
          }
        }
      }
      for (const episodeRow of containerEpisodeRows) {
        const episodeRowId = normalizeJobIdValue(episodeRow?.id);
        if (!episodeRowId) {
          continue;
        }
        const outputs = Array.from(childOutputMap.get(episodeRowId) || []);
        for (const outputPath of outputs) {
          if (!outputPath || seenOutputs.has(outputPath)) {
            continue;
          }
          seenOutputs.add(outputPath);
          if (!includeFsChecks || fs.existsSync(outputPath)) {
            existingCount += 1;
          }
        }
      }
      // For History UI with FS checks enabled, never override real filesystem
      // counts with stale series-batch metadata counters.
      if (!includeFsChecks && existingCountFromSeriesBatch > existingCount) {
        existingCount = existingCountFromSeriesBatch;
      }
      if (!encodeSuccessAny && existingCount > 0) {
        encodeSuccessAny = true;
        if (encodeSuccessCount === 0 && totalChildren > 0) {
          encodeSuccessCount = Math.min(1, totalChildren);
        }
      }
      let mergeSummary = null;
      if (isMultipartContainer) {
        const mergeRows = containerChildRowsRaw.filter((row) => isMultipartMergeRow(row));
        let mergeJobId = null;
        let mergeActive = false;
        let mergeCompleted = false;
        let mergeOutputExists = false;
        for (const mergeRow of mergeRows) {
          const mergeRowId = normalizeJobIdValue(mergeRow?.id);
          if (mergeRowId && (!mergeJobId || mergeRowId > mergeJobId)) {
            mergeJobId = mergeRowId;
          }
          const mergeStatus = String(mergeRow?.status || mergeRow?.last_state || '').trim().toUpperCase();
          if (mergeStatus === 'ENCODING') {
            mergeActive = true;
          }
          const outputCandidates = new Set();
          const directOutputPath = String(mergeRow?.output_path || '').trim();
          if (directOutputPath) {
            outputCandidates.add(directOutputPath);
          }
          if (mergeRowId) {
            const linkedOutputs = Array.from(childOutputMap.get(mergeRowId) || []);
            for (const outputPath of linkedOutputs) {
              if (outputPath) {
                outputCandidates.add(outputPath);
              }
            }
          }
          let rowOutputExists = false;
          for (const outputPath of outputCandidates) {
            if (!outputPath) {
              continue;
            }
            if (!includeFsChecks || fs.existsSync(outputPath)) {
              rowOutputExists = true;
              break;
            }
          }
          if (rowOutputExists) {
            mergeOutputExists = true;
          }
          const mergeHbInfo = parseJsonSafe(mergeRow?.handbrake_info_json, null);
          const mergeHbStatus = String(mergeHbInfo?.status || '').trim().toUpperCase();
          if (mergeStatus === 'FINISHED' || mergeHbStatus === 'SUCCESS' || rowOutputExists) {
            mergeCompleted = true;
          }
        }
        const mergeInputExpected = totalChildren;
        const mergeInputReady = mergeInputExpected > 0
          ? Math.min(existingCount, mergeInputExpected)
          : 0;
        const mergeReady = mergeInputExpected >= 2 && mergeInputReady >= mergeInputExpected;
        const mergeMissingInputs = mergeInputExpected > mergeInputReady
          ? (mergeInputExpected - mergeInputReady)
          : 0;
        let mergeState = 'missing';
        if (mergeActive) {
          mergeState = 'active';
        } else if (mergeCompleted) {
          mergeState = 'done';
        } else if (mergeReady) {
          mergeState = mergeRows.length > 0 ? 'ready' : 'restorable';
        } else if (mergeRows.length > 0) {
          mergeState = 'blocked';
        }
        mergeSummary = {
          hasJob: mergeRows.length > 0,
          jobId: mergeJobId,
          active: mergeActive,
          completed: mergeCompleted,
          ready: mergeReady,
          outputExists: mergeOutputExists,
          inputReady: mergeInputReady,
          inputExpected: mergeInputExpected,
          missingInputs: mergeMissingInputs,
          state: mergeState
        };
      }
      const expectedFinal = isMultipartContainer
        ? (totalChildren > 0 ? totalChildren : existingCount)
        : (expectedFromPlans > 0
          ? expectedFromPlans
          : (expectedTotal > 0 ? expectedTotal : existingCount));
      containerOutputSummary.set(containerId, {
        existing: existingCount,
        expected: expectedFinal
      });
      containerRawSummary.set(containerId, { exists: rawExistsAny });
      containerEncodeSummary.set(containerId, { success: encodeSuccessAny });
      containerChildSummary.set(containerId, {
        raw: { existing: rawExistsCount, expected: totalChildren },
        backup: { existing: backupSuccessCount, expected: totalChildren },
        encode: { existing: encodeSuccessCount, expected: totalChildren },
        ...(mergeSummary ? { merge: mergeSummary } : {})
      });
    }

    const standaloneSeriesOutputSummary = new Map();
    if (seriesCandidateIds.length > 0) {
      const placeholders = seriesCandidateIds.map(() => '?').join(', ');
      const seriesOutputRows = await db.all(
        `SELECT job_id, output_path FROM job_output_folders WHERE job_id IN (${placeholders})`,
        seriesCandidateIds
      );
      const outputsByJobId = new Map();
      for (const row of seriesOutputRows) {
        const jobId = normalizeJobIdValue(row?.job_id);
        if (!jobId) continue;
        if (!outputsByJobId.has(jobId)) outputsByJobId.set(jobId, new Set());
        const pathValue = String(row?.output_path || '').trim();
        if (pathValue) outputsByJobId.get(jobId).add(pathValue);
      }
      for (const job of seriesCandidates) {
        const jobId = normalizeJobIdValue(job?.id);
        if (!jobId || containerIds.includes(jobId)) {
          continue;
        }
        const mkInfo = parseJsonSafe(job?.makemkv_info_json, {});
        const selected = mkInfo?.analyzeContext?.selectedMetadata || mkInfo?.selectedMetadata || {};
        const episodeCount = Number(selected?.episodeCount || 0);
        const episodesLength = Array.isArray(selected?.episodes) ? selected.episodes.length : 0;
        const expectedFromMetadata = episodeCount > 0 ? episodeCount : (episodesLength > 0 ? episodesLength : 0);
        const plan = parseJsonSafe(job?.encode_plan_json, null);
        const expectedFromPlan = countSelectedEpisodeSlotsFromPlan(plan);
        const expectedFinal = expectedFromPlan > 0 ? expectedFromPlan : expectedFromMetadata;
        const outputSet = outputsByJobId.get(jobId) || new Set();
        const directOutput = String(job?.output_path || '').trim();
        if (directOutput) outputSet.add(directOutput);
        let existingCount = 0;
        for (const outputPath of outputSet) {
          if (!outputPath) continue;
          if (!includeFsChecks || fs.existsSync(outputPath)) {
            existingCount += 1;
          }
        }
        standaloneSeriesOutputSummary.set(jobId, {
          existing: existingCount,
          expected: expectedFinal > 0 ? expectedFinal : existingCount
        });
      }
    }

    return adjustedJobs.map((job) => {
      const enriched = enrichJobRow(job, settings, { includeFsChecks });
      const containerId = normalizeJobIdValue(job?.id);
      const summary = containerId
        ? (containerOutputSummary.get(containerId) || standaloneSeriesOutputSummary.get(containerId) || null)
        : (standaloneSeriesOutputSummary.get(containerId) || null);
      const rawSummary = containerId ? containerRawSummary.get(containerId) : null;
      const encodeSummary = containerId ? containerEncodeSummary.get(containerId) : null;
      const childSummary = containerId ? containerChildSummary.get(containerId) : null;
      const rawStatus = rawSummary
        ? {
          ...enriched.rawStatus,
          exists: rawSummary.exists,
          isDirectory: rawSummary.exists
        }
        : enriched.rawStatus;
      const outputStatus = summary
        ? {
          ...enriched.outputStatus,
          exists: summary.existing > 0,
          isFile: summary.existing > 0
        }
        : enriched.outputStatus;
      const encodeSuccess = encodeSummary ? Boolean(encodeSummary.success) : enriched.encodeSuccess;
      return {
        ...enriched,
        rawStatus,
        outputStatus,
        encodeSuccess,
        ...(childSummary ? { seriesChildSummary: childSummary } : {}),
        ...(summary ? { seriesOutputSummary: summary } : {}),
        log_count: includeFsChecks ? (hasProcessLogFile(job.id) ? 1 : 0) : 0
      };
    });
  }

  async getTmdbMigrationPendingJobs(options = {}) {
    const db = await getDb();
    const limitRaw = Number(options?.limit);
    const limit = Number.isFinite(limitRaw) && limitRaw > 0
      ? Math.min(Math.trunc(limitRaw), 2000)
      : 1000;
    const includeFsChecks = options?.includeFsChecks === true;

    const [rows, settings] = await Promise.all([
      db.all(
        `
          SELECT *
          FROM jobs
          WHERE COALESCE(migrate_tmdb, 0) = 0
            AND LOWER(TRIM(COALESCE(media_type, ''))) NOT IN ('cd', 'audiobook')
            AND LOWER(TRIM(COALESCE(job_kind, ''))) NOT IN ('cd', 'audiobook')
          ORDER BY COALESCE(updated_at, created_at) DESC, id DESC
          LIMIT ?
        `,
        [limit]
      ),
      settingsService.getSettingsMap()
    ]);

    const repairedRows = await Promise.all(
      (Array.isArray(rows) ? rows : []).map((row) => this.repairImportedOrphanJobClassification(row, settings))
    );
    return repairedRows.map((row) => enrichJobRow(row, settings, { includeFsChecks }));
  }

  async setTmdbMigrationFlag(jobId, migrated = false) {
    const normalizedJobId = normalizeJobIdValue(jobId);
    if (!normalizedJobId) {
      const error = new Error('Ungültige Job-ID.');
      error.statusCode = 400;
      throw error;
    }

    const existing = await this.getJobById(normalizedJobId);
    if (!existing) {
      const error = new Error('Job nicht gefunden.');
      error.statusCode = 404;
      throw error;
    }

    await this.updateJob(normalizedJobId, {
      migrate_tmdb: migrated ? 1 : 0
    });

    const [updated, settings] = await Promise.all([
      this.getJobById(normalizedJobId),
      settingsService.getSettingsMap()
    ]);
    return enrichJobRow(updated, settings);
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
    const repairedRows = await Promise.all(
      ids
        .map((id) => byId.get(id))
        .filter(Boolean)
        .map((job) => this.repairImportedOrphanJobClassification(job, settings))
    );

    const repairedById = new Map(
      repairedRows
        .filter(Boolean)
        .map((row) => [Number(row.id), row])
    );

    return ids
      .map((id) => repairedById.get(id))
      .filter(Boolean)
      .map((job) => ({
        ...enrichJobRow(job, settings),
        log_count: hasProcessLogFile(job.id) ? 1 : 0
      }));
  }

  async findSeriesContainerJob(tmdbId, seasonNumber) {
    const normalizedTmdbId = Number(tmdbId || 0) || null;
    const normalizedSeason = Number(seasonNumber || 0) || null;
    if (!normalizedTmdbId || !normalizedSeason) {
      return null;
    }
    const db = await getDb();
    const row = await db.get(
      `
        SELECT *
        FROM jobs
        WHERE job_kind = 'dvd_series_container'
          AND (
            json_extract(makemkv_info_json, '$.analyzeContext.selectedMetadata.tmdbId') = ?
            OR json_extract(makemkv_info_json, '$.selectedMetadata.tmdbId') = ?
          )
          AND (
            json_extract(makemkv_info_json, '$.analyzeContext.selectedMetadata.seasonNumber') = ?
            OR json_extract(makemkv_info_json, '$.selectedMetadata.seasonNumber') = ?
          )
        ORDER BY id DESC
        LIMIT 1
      `,
      [normalizedTmdbId, normalizedTmdbId, normalizedSeason, normalizedSeason]
    );
    return row || null;
  }

  async findLikelySeriesContainerJob({ title = null, year = null } = {}) {
    const normalizedTitle = normalizeComparableLabel(title || '');
    const normalizedYear = Number.isFinite(Number(year)) && Number(year) > 0
      ? Math.trunc(Number(year))
      : null;
    if (!normalizedTitle) {
      return null;
    }

    const db = await getDb();
    const rows = await db.all(
      `
        SELECT *
        FROM jobs
        WHERE job_kind = 'dvd_series_container'
        ORDER BY id DESC
      `
    );
    const candidates = [];
    for (const row of (Array.isArray(rows) ? rows : [])) {
      const mkInfo = parseJsonSafe(row?.makemkv_info_json, {}) || {};
      const selected = extractSelectedMetadataFromMakemkvInfo(mkInfo);
      const containerTitle = String(
        selected?.title
        || selected?.seriesTitle
        || row?.title
        || row?.detected_title
        || ''
      ).trim();
      const containerNormalizedTitle = normalizeComparableLabel(containerTitle);
      if (!containerNormalizedTitle) {
        continue;
      }

      let score = 0;
      if (containerNormalizedTitle === normalizedTitle) {
        score += 10;
      } else if (containerNormalizedTitle.includes(normalizedTitle) || normalizedTitle.includes(containerNormalizedTitle)) {
        score += 6;
      } else {
        continue;
      }

      const containerYearRaw = Number(selected?.year || row?.year || 0);
      const containerYear = Number.isFinite(containerYearRaw) && containerYearRaw > 0
        ? Math.trunc(containerYearRaw)
        : null;
      if (normalizedYear && containerYear === normalizedYear) {
        score += 4;
      } else if (normalizedYear && containerYear && Math.abs(containerYear - normalizedYear) <= 1) {
        score += 2;
      }

      const tmdbId = normalizePositiveIntegerOrNull(selected?.tmdbId || selected?.providerId || null);
      const seasonNumber = normalizePositiveIntegerOrNull(selected?.seasonNumber || null);
      if (tmdbId && seasonNumber) {
        score += 3;
      }

      candidates.push({
        row,
        score
      });
    }

    if (candidates.length === 0) {
      return null;
    }

    candidates.sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      return Number(right.row?.id || 0) - Number(left.row?.id || 0);
    });

    const best = candidates[0];
    const second = candidates[1] || null;
    if (second && second.score === best.score) {
      return null;
    }
    return best.row || null;
  }

  async listSeriesSiblingJobs(tmdbId, seasonNumber) {
    const normalizedTmdbId = Number(tmdbId || 0) || null;
    const normalizedSeason = Number(seasonNumber || 0) || null;
    if (!normalizedTmdbId || !normalizedSeason) {
      return [];
    }
    const db = await getDb();
    const rows = await db.all(
      `
        SELECT *
        FROM jobs
        WHERE job_kind != 'dvd_series_container'
          AND (
            json_extract(makemkv_info_json, '$.analyzeContext.selectedMetadata.tmdbId') = ?
            OR json_extract(makemkv_info_json, '$.selectedMetadata.tmdbId') = ?
          )
          AND (
            json_extract(makemkv_info_json, '$.analyzeContext.selectedMetadata.seasonNumber') = ?
            OR json_extract(makemkv_info_json, '$.selectedMetadata.seasonNumber') = ?
          )
        ORDER BY id ASC
      `,
      [normalizedTmdbId, normalizedTmdbId, normalizedSeason, normalizedSeason]
    );
    return Array.isArray(rows) ? rows : [];
  }

  async listChildJobs(parentJobId) {
    const normalizedParentJobId = normalizeJobIdValue(parentJobId);
    if (!normalizedParentJobId) {
      return [];
    }
    const db = await getDb();
    const rows = await db.all(
      `SELECT * FROM jobs WHERE parent_job_id = ? ORDER BY id ASC`,
      [normalizedParentJobId]
    );
    return Array.isArray(rows) ? rows : [];
  }

  async findLatestReplacementJobId(sourceJobId) {
    const normalizedSourceJobId = normalizeJobIdValue(sourceJobId);
    if (!normalizedSourceJobId) {
      return null;
    }

    const db = await getDb();
    const rows = await db.all(
      `
        SELECT a.job_id
        FROM job_lineage_artifacts a
        JOIN jobs j ON j.id = a.job_id
        WHERE a.source_job_id = ?
        ORDER BY a.id DESC
      `,
      [normalizedSourceJobId]
    );

    for (const row of (Array.isArray(rows) ? rows : [])) {
      const candidateJobId = normalizeJobIdValue(row?.job_id);
      if (!candidateJobId || candidateJobId === normalizedSourceJobId) {
        continue;
      }
      return candidateJobId;
    }

    return null;
  }

  async getJobByIdOrReplacement(jobId) {
    const normalizedJobId = normalizeJobIdValue(jobId);
    if (!normalizedJobId) {
      return {
        requestedJobId: null,
        resolvedJobId: null,
        replaced: false,
        job: null
      };
    }

    const directJob = await this.getJobById(normalizedJobId);
    if (directJob) {
      return {
        requestedJobId: normalizedJobId,
        resolvedJobId: normalizedJobId,
        replaced: false,
        job: directJob
      };
    }

    const replacementJobId = await this.findLatestReplacementJobId(normalizedJobId);
    if (!replacementJobId) {
      return {
        requestedJobId: normalizedJobId,
        resolvedJobId: normalizedJobId,
        replaced: false,
        job: null
      };
    }

    const replacementJob = await this.getJobById(replacementJobId);
    return {
      requestedJobId: normalizedJobId,
      resolvedJobId: replacementJobId,
      replaced: Boolean(replacementJob),
      job: replacementJob || null
    };
  }

  async getRunningJobs() {
    const db = await getDb();
    const [rows, settings] = await Promise.all([
      db.all(
        `
        SELECT *
        FROM jobs
        WHERE status IN ('ANALYZING', 'METADATA_LOOKUP', 'RIPPING', 'ENCODING', 'MEDIAINFO_CHECK', 'CD_ANALYZING', 'CD_RIPPING', 'CD_ENCODING')
          AND COALESCE(job_kind, '') != 'dvd_series_container'
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

  async getQueueIdleJobs() {
    const db = await getDb();
    const [rows, settings] = await Promise.all([
      db.all(
        `
        SELECT *
        FROM jobs
        WHERE status IN (
          'METADATA_SELECTION',
          'WAITING_FOR_USER_DECISION',
          'READY_TO_START',
          'READY_TO_ENCODE',
          'CD_METADATA_SELECTION',
          'CD_READY_TO_RIP'
        )
          AND COALESCE(job_kind, '') != 'dvd_series_container'
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
    const [loadedJob, settings] = await Promise.all([
      db.get('SELECT * FROM jobs WHERE id = ?', [jobId]),
      settingsService.getSettingsMap()
    ]);
    if (!loadedJob) {
      return null;
    }
    const classifiedJob = await this.repairImportedOrphanJobClassification(loadedJob, settings);
    const job = await this.repairImportedCdJobArtifacts(classifiedJob, settings);
    const childRows = await this.listChildJobs(jobId);
    const childJobs = await Promise.all(
      childRows.map((row) => this.repairImportedOrphanJobClassification(row, settings))
    );
    const isSeriesContainer = String(job?.job_kind || '').trim().toLowerCase() === 'dvd_series_container';
    const isMultipartContainer = String(job?.job_kind || '').trim().toLowerCase() === 'multipart_movie_container';
    const isDiskContainer = isSeriesContainer || isMultipartContainer;
    const detailChildJobs = isSeriesContainer
      ? childJobs.filter((child) => !isSeriesBatchEpisodeSubJobRow(child))
      : childJobs;
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
    const enrichedChildren = await Promise.all(
      detailChildJobs.map(async (child) => {
        const base = {
          ...enrichJobRow(child, settings, { includeFsChecks }),
          log_count: includeFsChecks ? (hasProcessLogFile(child.id) ? 1 : 0) : 0
        };
        if (!shouldLoadLogs) {
          return {
            ...base,
            logs: [],
            log: '',
            logMeta: {
              loaded: false,
              total: base.log_count,
              returned: 0,
              truncated: false
            }
          };
        }
        const childLog = await this.readProcessLogLines(child.id, {
          includeAll: includeAllLogs,
          tailLines: logTailLines
        });
        return {
          ...base,
          log: childLog.lines.join('\n'),
          logMeta: {
            loaded: true,
            total: includeAllLogs ? childLog.total : childLog.returned,
            returned: childLog.returned,
            truncated: childLog.truncated
          }
        };
      })
    );

    let seriesChildSummary = null;
    if (isDiskContainer && enrichedChildren.length > 0) {
      const summaryChildren = isMultipartContainer
        ? enrichedChildren.filter((child) => !isMultipartMergeRow(child))
        : enrichedChildren;
      const mergeChildren = isMultipartContainer
        ? enrichedChildren.filter((child) => isMultipartMergeRow(child))
        : [];
      const total = summaryChildren.length;
      const outputReadyCount = summaryChildren.reduce((count, child) => (
        count + (child?.outputStatus?.exists ? 1 : 0)
      ), 0);
      const buildMergeSummary = () => {
        if (!isMultipartContainer) {
          return null;
        }
        let mergeJobId = null;
        let mergeActive = false;
        let mergeCompleted = false;
        let mergeOutputExists = false;
        for (const child of mergeChildren) {
          const mergeRowId = normalizeJobIdValue(child?.id);
          if (mergeRowId && (!mergeJobId || mergeRowId > mergeJobId)) {
            mergeJobId = mergeRowId;
          }
          const mergeStatus = String(child?.status || child?.last_state || '').trim().toUpperCase();
          if (mergeStatus === 'ENCODING') {
            mergeActive = true;
          }
          const hasOutput = Boolean(child?.outputStatus?.exists || String(child?.output_path || '').trim());
          if (hasOutput) {
            mergeOutputExists = true;
          }
          if (
            mergeStatus === 'FINISHED'
            || child?.encodeSuccess
            || hasOutput
            || String(child?.handbrakeInfo?.status || '').trim().toUpperCase() === 'SUCCESS'
          ) {
            mergeCompleted = true;
          }
        }
        const mergeInputExpected = total;
        const mergeInputReady = mergeInputExpected > 0
          ? Math.min(outputReadyCount, mergeInputExpected)
          : 0;
        const mergeReady = mergeInputExpected >= 2 && mergeInputReady >= mergeInputExpected;
        const mergeMissingInputs = mergeInputExpected > mergeInputReady
          ? (mergeInputExpected - mergeInputReady)
          : 0;
        let mergeState = 'missing';
        if (mergeActive) {
          mergeState = 'active';
        } else if (mergeCompleted) {
          mergeState = 'done';
        } else if (mergeReady) {
          mergeState = mergeChildren.length > 0 ? 'ready' : 'restorable';
        } else if (mergeChildren.length > 0) {
          mergeState = 'blocked';
        }
        return {
          hasJob: mergeChildren.length > 0,
          jobId: mergeJobId,
          active: mergeActive,
          completed: mergeCompleted,
          ready: mergeReady,
          outputExists: mergeOutputExists,
          inputReady: mergeInputReady,
          inputExpected: mergeInputExpected,
          missingInputs: mergeMissingInputs,
          state: mergeState
        };
      };
      if (total <= 0) {
        seriesChildSummary = {
          raw: { existing: 0, expected: 0 },
          backup: { existing: 0, expected: 0 },
          encode: { existing: 0, expected: 0 },
          ...(isMultipartContainer ? { merge: buildMergeSummary() } : {})
        };
      }
      let rawCount = 0;
      let backupCount = 0;
      let encodeCount = 0;
      for (const child of summaryChildren) {
        if (child?.rawStatus?.exists) {
          rawCount += 1;
        }
        // Backup should be considered present when rip-success markers are set
        // or when RAW is physically available for that child.
        const backupPresent = Boolean(
          child?.backupSuccess
          || child?.rawStatus?.exists
          || String(child?.makemkvInfo?.status || '').trim().toUpperCase() === 'SUCCESS'
        );
        if (backupPresent) {
          backupCount += 1;
        }
        if (child?.encodeSuccess) {
          encodeCount += 1;
        }
      }
      if (total > 0) {
        seriesChildSummary = {
          raw: { existing: rawCount, expected: total },
          backup: { existing: backupCount, expected: total },
          encode: { existing: encodeCount, expected: total },
          ...(isMultipartContainer ? { merge: buildMergeSummary() } : {})
        };
      }
    }

    const outputFolders = await this.getJobOutputFoldersForLineage(jobId);

    if (!shouldLoadLogs) {
      return {
        ...enrichJobRow(job, settings, { includeFsChecks }),
        outputFolders,
        log_count: baseLogCount,
        children: enrichedChildren,
        ...(seriesChildSummary ? { seriesChildSummary } : {}),
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
      outputFolders,
      log_count: processLog.exists ? processLog.total : 0,
      children: enrichedChildren,
      ...(seriesChildSummary ? { seriesChildSummary } : {}),
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

  async generateJobNfo(jobId, options = {}) {
    const normalizedJobId = normalizeJobIdValue(jobId);
    if (!normalizedJobId) {
      const error = new Error('Ungültige Job-ID.');
      error.statusCode = 400;
      throw error;
    }

    const mode = String(options?.mode || 'manual').trim().toLowerCase() || 'manual';
    const requireSettingEnabled = Boolean(options?.requireSettingEnabled);
    const requireSettingDisabled = Boolean(options?.requireSettingDisabled);
    const failIfExists = Boolean(options?.failIfExists);
    const failIfOutputMissing = Boolean(options?.failIfOutputMissing);

    const [job, settings] = await Promise.all([
      this.getJobById(normalizedJobId),
      settingsService.getSettingsMap()
    ]);
    if (!job) {
      const error = new Error('Job nicht gefunden.');
      error.statusCode = 404;
      throw error;
    }

    const enriched = enrichJobRow(job, settings, { includeFsChecks: true });
    const nfoStatus = enriched?.nfoStatus && typeof enriched.nfoStatus === 'object'
      ? enriched.nfoStatus
      : buildNfoStatusForJob({
        job: enriched,
        outputPath: enriched?.output_path || null,
        outputStatus: enriched?.outputStatus || null,
        includeFsChecks: true,
        settings,
        mediaType: enriched?.mediaType || null
      });

    if (!nfoStatus.supported) {
      if (mode === 'auto') {
        return {
          generated: false,
          skipped: true,
          reason: 'unsupported_media',
          nfoStatus
        };
      }
      const error = new Error(
        'NFO-Generierung ist nur für Filme verfügbar (nicht für Serien, Audiobooks oder CDs).'
      );
      error.statusCode = 409;
      throw error;
    }

    if (requireSettingEnabled && !nfoStatus.settingEnabled) {
      return {
        generated: false,
        skipped: true,
        reason: 'setting_disabled',
        nfoStatus
      };
    }

    if (requireSettingDisabled && nfoStatus.settingEnabled) {
      const error = new Error('NFO-Generierung ist in den Settings aktiv. Manuelle Generierung ist nur bei deaktivierter Auto-NFO erlaubt.');
      error.statusCode = 409;
      throw error;
    }

    if (!nfoStatus.nfoPath) {
      const error = new Error('Für diesen Job kann keine NFO-Datei erzeugt werden (Output ist keine Datei).');
      error.statusCode = 409;
      throw error;
    }

    if (!nfoStatus.outputExists || !nfoStatus.outputIsFile) {
      if (failIfOutputMissing) {
        const error = new Error('NFO kann nicht erzeugt werden: Output-Datei fehlt.');
        error.statusCode = 409;
        throw error;
      }
      return {
        generated: false,
        skipped: true,
        reason: 'output_missing',
        nfoStatus
      };
    }

    if (nfoStatus.nfoExists) {
      if (failIfExists) {
        const error = new Error('NFO-Datei existiert bereits.');
        error.statusCode = 409;
        throw error;
      }
      return {
        generated: false,
        skipped: true,
        reason: 'nfo_exists',
        nfoStatus
      };
    }

    const metadata = resolveNfoMetadataFromJob(enriched);
    const xml = buildNfoXml(metadata);
    fs.writeFileSync(nfoStatus.nfoPath, xml, 'utf8');

    const refreshedNfoStatus = buildNfoStatusForJob({
      job: enriched,
      outputPath: enriched?.output_path || null,
      outputStatus: enriched?.outputStatus || null,
      includeFsChecks: true,
      settings,
      mediaType: enriched?.mediaType || null
    });

    await this.appendLog(
      normalizedJobId,
      'SYSTEM',
      `NFO-Datei erstellt (${mode}): ${nfoStatus.nfoPath}`
    ).catch(() => {});

    logger.info('job:nfo:generated', {
      jobId: normalizedJobId,
      mode,
      nfoPath: nfoStatus.nfoPath
    });

    return {
      generated: true,
      skipped: false,
      mode,
      nfoPath: nfoStatus.nfoPath,
      metadata,
      nfoStatus: refreshedNfoStatus
    };
  }

  async getJobArchiveDescriptor(jobId, target, options = {}) {
    const normalizedJobId = normalizeJobIdValue(jobId);
    if (!normalizedJobId) {
      const error = new Error('Ungültige Job-ID.');
      error.statusCode = 400;
      throw error;
    }

    const normalizedTarget = normalizeArchiveTarget(target);
    if (!normalizedTarget) {
      const error = new Error('Ungültiges Download-Ziel. Erlaubt sind raw und output.');
      error.statusCode = 400;
      throw error;
    }

    const [job, settings] = await Promise.all([
      this.getJobById(normalizedJobId),
      settingsService.getSettingsMap()
    ]);

    if (!job) {
      const error = new Error('Job nicht gefunden.');
      error.statusCode = 404;
      throw error;
    }

    const resolvedPaths = resolveEffectiveStoragePathsForJob(settings, job);
    const enrichedJob = enrichJobRow(job, settings, { includeFsChecks: true });
    const requestedOutputPath = normalizedTarget === 'output'
      ? (String(options?.outputPath || '').trim() || null)
      : null;
    let sourcePath = normalizedTarget === 'raw'
      ? resolvedPaths.effectiveRawPath
      : resolvedPaths.effectiveOutputPath;

    if (normalizedTarget === 'output' && requestedOutputPath) {
      const trackedFolders = await this.getJobOutputFoldersForLineage(normalizedJobId);
      const allowedOutputPathMap = new Map();
      const registerAllowedOutputPath = (candidatePath) => {
        const raw = String(candidatePath || '').trim();
        if (!raw) {
          return;
        }
        const normalized = normalizeComparablePath(raw);
        if (!normalized || allowedOutputPathMap.has(normalized)) {
          return;
        }
        allowedOutputPathMap.set(normalized, raw);
      };

      registerAllowedOutputPath(resolvedPaths.effectiveOutputPath);
      registerAllowedOutputPath(job?.output_path);
      for (const folder of trackedFolders) {
        registerAllowedOutputPath(folder?.output_path);
      }

      const normalizedRequestedOutputPath = normalizeComparablePath(requestedOutputPath);
      if (!normalizedRequestedOutputPath || !allowedOutputPathMap.has(normalizedRequestedOutputPath)) {
        const error = new Error('Der angeforderte Output-Ordner gehört nicht zu diesem Job.');
        error.statusCode = 404;
        throw error;
      }

      sourcePath = allowedOutputPathMap.get(normalizedRequestedOutputPath);
    }

    if (!sourcePath) {
      const error = new Error(
        normalizedTarget === 'raw'
          ? 'Kein RAW-Pfad für diesen Job vorhanden.'
          : 'Kein Output-Pfad für diesen Job vorhanden.'
      );
      error.statusCode = 404;
      throw error;
    }

    if (normalizedTarget === 'raw') {
      const discMediaType = String(resolvedPaths?.mediaType || '').trim().toLowerCase();
      const isDiscMedia = ['dvd', 'bluray', 'cd'].includes(discMediaType);
      const rawExists = Boolean(enrichedJob?.rawStatus?.exists);
      const rawNotEmpty = enrichedJob?.rawStatus?.isEmpty !== true;
      if (isIncompleteRawStoragePath(sourcePath) || !rawExists || !rawNotEmpty) {
        const error = new Error('RAW ist noch nicht vollständig und kann nicht heruntergeladen werden.');
        error.statusCode = 409;
        throw error;
      }
      if (isDiscMedia && !Boolean(enrichedJob?.ripSuccessful)) {
        const error = new Error('RAW-Rip ist noch nicht abgeschlossen und kann nicht heruntergeladen werden.');
        error.statusCode = 409;
        throw error;
      }
    }

    if (normalizedTarget === 'output') {
      const statusUpper = String(enrichedJob?.status || '').trim().toUpperCase();
      const outputReady = Boolean(enrichedJob?.encodeSuccess || statusUpper === 'FINISHED');
      const outputExists = Boolean(enrichedJob?.outputStatus?.exists);
      if (isIncompleteOutputStoragePath(sourcePath) || !outputExists || !outputReady) {
        const error = new Error('Output ist noch nicht vollständig und kann nicht heruntergeladen werden.');
        error.statusCode = 409;
        throw error;
      }
    }

    let sourceStat;
    try {
      sourceStat = await fs.promises.stat(sourcePath);
    } catch (_error) {
      const error = new Error(
        normalizedTarget === 'raw'
          ? 'RAW-Pfad wurde nicht gefunden.'
          : 'Output-Pfad wurde nicht gefunden.'
      );
      error.statusCode = 404;
      throw error;
    }

    if (!sourceStat.isDirectory() && !sourceStat.isFile()) {
      const error = new Error('Nur Dateien oder Verzeichnisse können als ZIP heruntergeladen werden.');
      error.statusCode = 400;
      throw error;
    }

    return {
      jobId: normalizedJobId,
      displayTitle: buildJobDisplayTitle(job),
      target: normalizedTarget,
      sourcePath,
      sourceType: sourceStat.isDirectory() ? 'directory' : 'file',
      sourceMtimeMs: Number(sourceStat.mtimeMs || 0),
      sourceModifiedAt: sourceStat.mtime ? sourceStat.mtime.toISOString() : null,
      entryName: path.basename(sourcePath) || (normalizedTarget === 'raw' ? 'raw' : 'output'),
      archiveName: buildJobArchiveName(job, normalizedTarget)
    };
  }

  async getOrphanRawFolders() {
    const settings = await settingsService.getSettingsMap();
    const rawDirs = getOrphanRawScanPathList(settings);
    if (rawDirs.length === 0) {
      const error = new Error('Kein RAW-Pfad verfügbar (weder Settings noch Default-Pfade).');
      error.statusCode = 400;
      throw error;
    }

    const db = await getDb();
    const [linkedRows, existingJobIdRows] = await Promise.all([
      db.all(
        `
          SELECT id, raw_path, status, makemkv_info_json, mediainfo_info_json, encode_plan_json, encode_input_path
          FROM jobs
          WHERE raw_path IS NOT NULL AND TRIM(raw_path) <> ''
        `
      ),
      db.all(`SELECT id FROM jobs`)
    ]);
    const existingJobIdSet = new Set(
      (Array.isArray(existingJobIdRows) ? existingJobIdRows : [])
        .map((row) => normalizeJobIdValue(row?.id))
        .filter(Boolean)
    );

    const linkedPathMap = new Map();
    const addLinkedPath = (candidatePath, rowRef) => {
      const normalizedPath = normalizeComparablePath(candidatePath);
      if (!normalizedPath) {
        return;
      }
      if (!linkedPathMap.has(normalizedPath)) {
        linkedPathMap.set(normalizedPath, []);
      }
      linkedPathMap.get(normalizedPath).push(rowRef);
    };
    for (const row of linkedRows) {
      const resolvedPaths = resolveEffectiveStoragePathsForJob(settings, row);
      const linkedCandidates = [
        normalizeComparablePath(row.raw_path),
        normalizeComparablePath(resolvedPaths.effectiveRawPath)
      ].filter(Boolean);

      for (const linkedPath of linkedCandidates) {
        const rowRef = {
          id: row.id,
          status: row.status
        };
        addLinkedPath(linkedPath, rowRef);

        // /database scannt nur Top-Level-Ordner je RAW-Root.
        // Viele Jobs (insb. Disc-Backups) speichern raw_path jedoch auf einer tieferen Ebene.
        // Deshalb markieren wir zusätzlich den zugehörigen Top-Level-Ordner als "linked".
        for (const rawRoot of rawDirs) {
          const normalizedRawRoot = normalizeComparablePath(rawRoot);
          if (!normalizedRawRoot || !isPathInside(normalizedRawRoot, linkedPath)) {
            continue;
          }
          const relative = String(path.relative(normalizedRawRoot, linkedPath) || '').trim();
          if (!relative || relative === '.' || relative.startsWith('..')) {
            continue;
          }
          const topSegment = relative.split(path.sep).find((segment) => String(segment || '').trim() && segment !== '.');
          if (!topSegment) {
            continue;
          }
          addLinkedPath(path.join(normalizedRawRoot, topSegment), rowRef);
        }
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
        if (!entry.isDirectory() || isHiddenDirectoryName(entry.name)) {
          continue;
        }
        if (/^incomplete_/i.test(String(entry.name || '').trim())) {
          // Incomplete RAW folders represent unfinished rips and are intentionally
          // not re-importable from /database.
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
        if (metadata.folderJobId && existingJobIdSet.has(Number(metadata.folderJobId))) {
          continue;
        }
        const detectedMediaType = detectOrphanMediaType(rawPath, {
          seriesRawPathHint: isLikelySeriesRawPath(rawPath, settings)
        });
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
          hasAudiobookStructure: detectedMediaType === 'audiobook',
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

  async deleteOrphanRawFolder(rawPath) {
    const settings = await settingsService.getSettingsMap();
    const rawDirs = getOrphanRawScanPathList(settings);
    const requestedRawPath = String(rawPath || '').trim();

    if (!requestedRawPath) {
      const error = new Error('rawPath fehlt.');
      error.statusCode = 400;
      throw error;
    }

    if (rawDirs.length === 0) {
      const error = new Error('Kein RAW-Pfad verfügbar (weder Settings noch Default-Pfade).');
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
      error.statusCode = 404;
      throw error;
    }

    const orphanScan = await this.getOrphanRawFolders();
    const orphanRows = Array.isArray(orphanScan?.rows) ? orphanScan.rows : [];
    const orphanRow = orphanRows.find((row) => normalizeComparablePath(row?.rawPath) === absRawPath);
    if (!orphanRow) {
      const error = new Error('RAW-Ordner ist nicht als verwaister /database-Eintrag verfügbar (ggf. bereits verknüpft).');
      error.statusCode = 409;
      throw error;
    }

    try {
      const deleteResult = deleteFilesRecursively(absRawPath, false);
      return {
        deleted: true,
        rawPath: absRawPath,
        folderName: String(orphanRow?.folderName || path.basename(absRawPath)).trim() || path.basename(absRawPath),
        filesDeleted: Number(deleteResult?.filesDeleted || 0),
        dirsRemoved: Number(deleteResult?.dirsRemoved || 0)
      };
    } catch (deleteError) {
      const error = new Error(`RAW-Ordner konnte nicht gelöscht werden: ${deleteError?.message || deleteError}`);
      error.statusCode = 500;
      throw error;
    }
  }

  async importOrphanRawFolder(rawPath) {
    const settings = await settingsService.getSettingsMap();
    const rawDirs = getOrphanRawScanPathList(settings);
    const requestedRawPath = String(rawPath || '').trim();

    if (!requestedRawPath) {
      const error = new Error('rawPath fehlt.');
      error.statusCode = 400;
      throw error;
    }

    if (rawDirs.length === 0) {
      const error = new Error('Kein RAW-Pfad verfügbar (weder Settings noch Default-Pfade).');
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
    const effectiveTitle = metadata.title || folderName;
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

    const seriesRawPathHint = isLikelySeriesRawPath(finalRawPath, settings);
    const detectedMediaType = detectOrphanMediaType(finalRawPath, {
      seriesRawPathHint
    });
    const initialSourceJobContext = await this.resolveOrphanImportSourceJob({
      candidateJobIds: [metadata.folderJobId],
      mediaProfile: detectedMediaType
    });
    const fallbackMediaTypeFromSource = normalizeMediaTypeValue(
      initialSourceJobContext?.mediaProfile
      || initialSourceJobContext?.makemkvInfo?.analyzeContext?.mediaProfile
      || initialSourceJobContext?.makemkvInfo?.mediaProfile
      || null
    );
    const effectiveDetectedMediaType = detectedMediaType === 'other'
      ? (fallbackMediaTypeFromSource || (seriesRawPathHint ? 'dvd' : 'other'))
      : detectedMediaType;
    const initialSourceJob = initialSourceJobContext?.job || null;
    const initialSourceSelectedMetadata = initialSourceJobContext?.selectedMetadata && typeof initialSourceJobContext.selectedMetadata === 'object'
      ? initialSourceJobContext.selectedMetadata
      : {};
    const cdRecovery = effectiveDetectedMediaType === 'cd'
      ? recoverCdJobArtifactsForImport({
        currentRawPath: finalRawPath,
        rawPathCandidates: [
          absRawPath,
          renamedRawPath,
          finalRawPath
        ],
        relatedJobIds: [metadata.folderJobId],
        excludeJobIds: [created.id],
        settings,
        baseMetadata: {
          title: initialSourceSelectedMetadata?.title || initialSourceSelectedMetadata?.album || initialSourceJob?.title || metadata.title || null,
          album: initialSourceSelectedMetadata?.album || initialSourceSelectedMetadata?.title || initialSourceJob?.title || metadata.title || null,
          artist: initialSourceSelectedMetadata?.artist || null,
          year: initialSourceSelectedMetadata?.year || initialSourceJob?.year || metadata.year || null
        }
      })
      : null;
    const sourceJobContext = await this.resolveOrphanImportSourceJob({
      candidateJobIds: [
        metadata.folderJobId,
        ...(cdRecovery?.logSources || []).map((source) => source?.jobId)
      ],
      mediaProfile: effectiveDetectedMediaType
    }) || initialSourceJobContext;
    const orphanImportInfo = this.buildOrphanRawImportMakemkvInfo({
      importedAt,
      rawPath: finalRawPath,
      requestedRawPath: absRawPath,
      sourceFolderJobId: metadata.folderJobId || null,
      mediaProfile: effectiveDetectedMediaType,
      // RAW-Import soll wie "Disk analysieren" starten:
      // keine geerbte Serien-/Metadatenzuordnung vor dem eigentlichen Analyse-Scan.
      existingInfo: null,
      recovery: cdRecovery,
      selectedMetadata: null,
      analyzeContextPatch: null,
      stripRecoveryMetadata: true
    });
    await this.updateJob(created.id, {
      ...(effectiveDetectedMediaType === 'audiobook' ? { job_kind: 'audiobook', media_type: 'audiobook' } : {}),
      ...(effectiveDetectedMediaType === 'cd' ? { job_kind: 'cd', media_type: 'cd' } : {}),
      ...(effectiveDetectedMediaType === 'dvd' ? { job_kind: 'dvd', media_type: 'dvd', parent_job_id: null } : {}),
      ...(effectiveDetectedMediaType === 'bluray' ? { job_kind: 'bluray', media_type: 'bluray' } : {}),
      status: 'FINISHED',
      last_state: 'FINISHED',
      // /database-Import startet bewusst metadata-clean: keine Übernahme aus früheren Läufen.
      title: null,
      year: null,
      imdb_id: null,
      poster_url: null,
      omdb_json: null,
      selected_from_omdb: 0,
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
      makemkv_info_json: JSON.stringify(orphanImportInfo)
    });

    if (cdRecovery?.logSources?.length > 0) {
      await this.restoreImportedProcessLog(created.id, cdRecovery.logSources, {
        importInfo: orphanImportInfo
      });
    }

    if (!cdRecovery?.logSources?.length) {
      await this.appendLog(
        created.id,
        'SYSTEM',
        `Orphan-RAW-Import Zusatzinfo: ${JSON.stringify(orphanImportInfo)}`
      );
    }

    await this.appendLog(
      created.id,
      'SYSTEM',
      renameSteps.length > 0
        ? `Historieneintrag aus RAW erstellt (Medientyp: ${effectiveDetectedMediaType}). Ordner umbenannt: ${renameSteps.map((step) => `${step.from} -> ${step.to}`).join(' | ')}`
        : `Historieneintrag aus bestehendem RAW-Ordner erstellt: ${finalRawPath} (Medientyp: ${effectiveDetectedMediaType})`
    );
    await this.appendLog(
      created.id,
      'SYSTEM',
      'Metadaten aus früheren Läufen wurden beim /database-Import verworfen (metadata-clean Start).'
    );

    logger.info('job:import-orphan-raw', {
      jobId: created.id,
      rawPath: absRawPath,
      detectedMediaType: effectiveDetectedMediaType,
      detectedMediaTypeRaw: detectedMediaType,
      seriesRawPathHint
    });

    const imported = await this.getJobById(created.id);
    return enrichJobRow(imported, settings);
  }

  async assignMetadata(jobId, payload = {}) {
    const job = await this.getJobById(jobId);
    if (!job) {
      const error = new Error('Job nicht gefunden.');
      error.statusCode = 404;
      throw error;
    }

    const parseTmdbId = (value) => {
      const direct = normalizePositiveIntegerOrNull(value);
      if (direct !== null) {
        return direct;
      }
      const text = String(value || '').trim();
      if (!text) {
        return null;
      }
      const providerMatch = text.match(/tmdb:(\d+)/i);
      if (providerMatch?.[1]) {
        return normalizePositiveIntegerOrNull(providerMatch[1]);
      }
      return null;
    };
    const requestedProviderRaw = String(payload.metadataProvider || '').trim().toLowerCase();
    const requestedTmdbId = parseTmdbId(payload?.tmdbId ?? payload?.providerId ?? null);
    const requestedWorkflowKind = normalizeDvdMetadataWorkflowKind(payload?.workflowKind);
    const metadataProvider = requestedProviderRaw === 'themoviedb'
      ? 'tmdb'
      : (requestedProviderRaw || (requestedTmdbId !== null ? 'tmdb' : 'tmdb'));
    const makemkvInfo = parseJsonSafe(job.makemkv_info_json, {});
    const analyzeContext = makemkvInfo?.analyzeContext && typeof makemkvInfo.analyzeContext === 'object'
      ? makemkvInfo.analyzeContext
      : {};
    const existingSelectedMetadata = extractSelectedMetadataFromMakemkvInfo(makemkvInfo);

    if (metadataProvider === 'tmdb') {
      const manualTitle = String(payload.title || '').trim();
      const manualYearRaw = Number(payload.year);
      const manualYear = Number.isFinite(manualYearRaw) ? Math.trunc(manualYearRaw) : null;
      const manualImdbId = String(payload.imdbId || '').trim().toLowerCase() || null;
      const manualPoster = String(payload.poster || '').trim() || null;
      const manualSeasonName = String(payload.seasonName || '').trim() || null;
      const manualSeasonNumber = normalizePositiveNumberOrNull(payload.seasonNumber);
      const manualDiscNumber = normalizePositiveIntegerOrNull(payload.discNumber);
      const manualEpisodeCountRaw = Number(payload.episodeCount);
      const manualEpisodeCount = Number.isFinite(manualEpisodeCountRaw) && manualEpisodeCountRaw > 0
        ? Math.trunc(manualEpisodeCountRaw)
        : null;
      const manualEpisodes = Array.isArray(payload.episodes) ? payload.episodes : null;
      const hasExplicitManualEpisodes = Boolean(manualEpisodes && manualEpisodes.length > 0);
      const manualMetadataKind = String(payload.metadataKind || '').trim().toLowerCase() || null;
      const manualProviderId = String(payload.providerId || '').trim() || null;

      let effectiveTmdbId = requestedTmdbId;
      if (effectiveTmdbId === null) {
        effectiveTmdbId = parseTmdbId(
          existingSelectedMetadata?.tmdbId
          ?? existingSelectedMetadata?.providerId
          ?? analyzeContext?.tmdbId
          ?? analyzeContext?.providerId
          ?? null
        );
      }

      const hasTmdbManualData = Boolean(
        manualTitle
        || manualYear !== null
        || manualImdbId
        || manualPoster
        || manualSeasonName
        || manualSeasonNumber !== null
        || manualDiscNumber !== null
        || manualEpisodeCount !== null
        || (manualEpisodes && manualEpisodes.length > 0)
      );
      if (effectiveTmdbId === null && !hasTmdbManualData) {
        const error = new Error('Keine TMDb-/Metadaten zum Aktualisieren angegeben.');
        error.statusCode = 400;
        throw error;
      }

      const existingYearRaw = Number(existingSelectedMetadata?.year);
      const existingYear = Number.isFinite(existingYearRaw) ? Math.trunc(existingYearRaw) : null;
      const existingWorkflowKind = normalizeDvdMetadataWorkflowKind(
        existingSelectedMetadata?.workflowKind
        || analyzeContext?.workflowKind
        || null
      );
      const resolvedWorkflowKind = requestedWorkflowKind
        || existingWorkflowKind
        || (manualSeasonNumber !== null ? 'series' : 'film');
      const isFilmWorkflow = resolvedWorkflowKind === 'film';
      let title = manualTitle
        || String(existingSelectedMetadata?.title || '').trim()
        || job.title
        || job.detected_title
        || null;
      let year = manualYear !== null
        ? manualYear
        : (existingYear !== null ? existingYear : (job.year ?? null));
      let imdbId = manualImdbId
        || String(existingSelectedMetadata?.imdbId || job.imdb_id || '').trim().toLowerCase()
        || null;
      let posterUrl = manualPoster
        || String(existingSelectedMetadata?.poster || job.poster_url || '').trim()
        || null;
      let shouldQueuePosterCache = false;
      if (posterUrl && !thumbnailService.isLocalUrl(posterUrl)) {
        try {
          const cacheResult = await this.cacheAndPromoteExternalPoster(jobId, posterUrl, {
            source: 'TMDb Poster',
            logFailures: false
          });
          if (cacheResult?.ok && cacheResult?.localUrl) {
            posterUrl = cacheResult.localUrl;
          } else {
            shouldQueuePosterCache = true;
          }
        } catch (_error) {
          shouldQueuePosterCache = true;
        }
      }
      let seasonNumber = manualSeasonNumber !== null
        ? manualSeasonNumber
        : normalizePositiveNumberOrNull(
          existingSelectedMetadata?.seasonNumber
          ?? analyzeContext?.seriesLookupHint?.seasonNumber
          ?? null
        );
      let seasonName = manualSeasonName
        || String(existingSelectedMetadata?.seasonName || '').trim()
        || null;
      let episodeCount = manualEpisodeCount !== null
        ? manualEpisodeCount
        : (Number(existingSelectedMetadata?.episodeCount || 0) || 0);
      let episodes = hasExplicitManualEpisodes
        ? manualEpisodes
        : (Array.isArray(existingSelectedMetadata?.episodes) ? existingSelectedMetadata.episodes : []);
      const discNumber = manualDiscNumber !== null
        ? manualDiscNumber
        : normalizePositiveIntegerOrNull(
          existingSelectedMetadata?.discNumber
          ?? analyzeContext?.seriesLookupHint?.discNumber
          ?? null
        );
      const resolvedJobMediaType = inferMediaType(
        job,
        makemkvInfo,
        job?.mediainfo_info_json,
        job?.encode_plan_json,
        job?.handbrake_info_json
      );
      if (!isFilmWorkflow && (resolvedJobMediaType === 'dvd' || resolvedJobMediaType === 'bluray') && discNumber === null) {
        const seriesDiscLabel = resolvedJobMediaType === 'bluray' ? 'Blu-ray' : 'DVD';
        const error = new Error(`Serien-${seriesDiscLabel} erkannt: Disk-Nummer ist Pflicht (Start bei 1).`);
        error.statusCode = 400;
        throw error;
      }
      let metadataKind = manualMetadataKind
        || String(
          existingSelectedMetadata?.metadataKind
          || analyzeContext?.metadataKind
          || ''
        ).trim().toLowerCase()
        || null;
      if (!metadataKind) {
        metadataKind = isFilmWorkflow ? 'movie' : (seasonNumber !== null ? 'season' : 'series');
      }
      let providerId = manualProviderId
        || String(existingSelectedMetadata?.providerId || '').trim()
        || null;
      if (!providerId && effectiveTmdbId !== null) {
        providerId = isFilmWorkflow
          ? `tmdb:${effectiveTmdbId}`
          : (seasonNumber !== null
            ? `tmdb:${effectiveTmdbId}:season:${seasonNumber}`
            : `tmdb:${effectiveTmdbId}`);
      }
      let tmdbLanguage = null;
      try {
        const dvdSettings = await settingsService.getEffectiveSettingsMap('dvd');
        tmdbLanguage = String(dvdSettings?.dvd_series_language || '').trim() || null;
      } catch (_settingsError) {
        tmdbLanguage = null;
      }

      let tmdbDetails = existingSelectedMetadata?.tmdbDetails && typeof existingSelectedMetadata.tmdbDetails === 'object'
        ? { ...existingSelectedMetadata.tmdbDetails }
        : null;
      if (effectiveTmdbId !== null && !isFilmWorkflow) {
        try {
          const seriesDetails = await tmdbService.getSeriesDetails(effectiveTmdbId, {
            language: tmdbLanguage,
            appendToResponse: ['credits', 'external_ids']
          });
          if (seriesDetails) {
            const detailsSummary = tmdbService.buildSeriesDetailsSummary(seriesDetails);
            const createdBy = tmdbService.normalizeNameList(seriesDetails?.created_by, { maxItems: 3 });
            const genres = tmdbService.normalizeNameList(seriesDetails?.genres, { maxItems: 3 });
            tmdbDetails = {
              ...(detailsSummary && typeof detailsSummary === 'object' ? detailsSummary : {}),
              createdBy,
              genres
            };
            if (!title) {
              title = String(seriesDetails?.name || seriesDetails?.original_name || '').trim() || null;
            }
            if ((!year || Number(year) <= 0) && tmdbDetails?.firstAirDate) {
              const tmdbYear = Number(String(tmdbDetails.firstAirDate).slice(0, 4));
              if (Number.isFinite(tmdbYear) && tmdbYear > 0) {
                year = Math.trunc(tmdbYear);
              }
            }
            if (!imdbId && tmdbDetails?.imdbId) {
              imdbId = String(tmdbDetails.imdbId).trim().toLowerCase() || null;
            }
            if (!posterUrl) {
              posterUrl = tmdbService.buildImageUrl(seriesDetails?.poster_path, 'w342') || null;
            }
          }
        } catch (tmdbDetailsErr) {
          logger.warn('assignMetadata:tmdb-series-details-fetch-failed', {
            jobId,
            tmdbId: effectiveTmdbId,
            message: tmdbDetailsErr?.message || String(tmdbDetailsErr)
          });
        }
      }

      if (effectiveTmdbId !== null && isFilmWorkflow) {
        try {
          const movieDetails = await tmdbService.getMovieDetails(effectiveTmdbId, {
            language: tmdbLanguage,
            appendToResponse: ['credits', 'external_ids']
          });
          const detailsSummary = tmdbService.buildMovieDetailsSummary(movieDetails);
          const genres = tmdbService.normalizeNameList(movieDetails?.genres, { maxItems: 3 });
          const cast = tmdbService.normalizeNameList(movieDetails?.credits?.cast, { maxItems: 6 });
          tmdbDetails = {
            ...(detailsSummary && typeof detailsSummary === 'object' ? detailsSummary : {}),
            genres,
            seasonCast: cast
          };
          if (!title) {
            title = String(movieDetails?.title || movieDetails?.original_title || '').trim() || null;
          }
          if ((!year || Number(year) <= 0) && tmdbDetails?.releaseDate) {
            const tmdbYear = Number(String(tmdbDetails.releaseDate).slice(0, 4));
            if (Number.isFinite(tmdbYear) && tmdbYear > 0) {
              year = Math.trunc(tmdbYear);
            }
          }
          if (!imdbId && tmdbDetails?.imdbId) {
            imdbId = String(tmdbDetails.imdbId).trim().toLowerCase() || null;
          }
          if (!posterUrl) {
            posterUrl = tmdbService.buildImageUrl(movieDetails?.poster_path, 'w342') || null;
          }
        } catch (tmdbMovieErr) {
          logger.warn('assignMetadata:tmdb-movie-details-fetch-failed', {
            jobId,
            tmdbId: effectiveTmdbId,
            message: tmdbMovieErr?.message || String(tmdbMovieErr)
          });
        }
      }

      if (!isFilmWorkflow && effectiveTmdbId !== null && seasonNumber !== null) {
        try {
          const seasonDetails = await tmdbService.getSeasonDetails(effectiveTmdbId, seasonNumber, {
            language: tmdbLanguage
          });
          const seasonCredits = await tmdbService.getSeasonCredits(effectiveTmdbId, seasonNumber, {
            language: tmdbLanguage
          });
          const seasonSummary = tmdbService.buildSeasonSummary(seasonDetails);
          if (seasonSummary) {
            const fetchedEpisodes = Array.isArray(seasonSummary.episodes) ? seasonSummary.episodes : [];
            if (fetchedEpisodes.length > 0 && !hasExplicitManualEpisodes) {
              episodes = fetchedEpisodes;
            }
            const fetchedEpisodeCount = Number(seasonSummary.episodeCount || 0) || 0;
            if (fetchedEpisodeCount > 0) {
              episodeCount = fetchedEpisodeCount;
            }
            if (!seasonName && seasonSummary.name) {
              seasonName = String(seasonSummary.name).trim() || null;
            }
          }
          const seasonVoteAverageRaw = Number(seasonDetails?.vote_average || 0);
          const seasonVoteAverage = Number.isFinite(seasonVoteAverageRaw) && seasonVoteAverageRaw > 0
            ? Number(seasonVoteAverageRaw.toFixed(1))
            : null;
          const seasonRuntimeValues = Array.isArray(seasonDetails?.episodes)
            ? seasonDetails.episodes
              .map((episode) => Number(episode?.runtime || 0))
              .filter((value) => Number.isFinite(value) && value > 0)
            : [];
          const seasonRuntime = tmdbService.formatRuntimeLabel(seasonRuntimeValues);
          const seasonCast = tmdbService.normalizeNameList(seasonCredits?.cast, { maxItems: 6 });
          tmdbDetails = {
            ...(tmdbDetails && typeof tmdbDetails === 'object' ? tmdbDetails : {}),
            seasonNumber,
            seasonVoteAverage,
            seasonRuntime,
            runtime: seasonRuntime || (tmdbDetails?.runtime || null),
            seasonCast
          };
        } catch (tmdbSeasonErr) {
          logger.warn('assignMetadata:tmdb-season-fetch-failed', {
            jobId,
            tmdbId: effectiveTmdbId,
            seasonNumber,
            message: tmdbSeasonErr?.message || String(tmdbSeasonErr)
          });
        }
      }

      const nextSelectedMetadata = {
        ...(existingSelectedMetadata && typeof existingSelectedMetadata === 'object' ? existingSelectedMetadata : {}),
        title,
        year,
        imdbId,
        poster: posterUrl,
        workflowKind: isFilmWorkflow ? 'film' : 'series',
        metadataProvider: 'tmdb',
        providerId,
        tmdbId: effectiveTmdbId,
        metadataKind,
        seasonNumber: isFilmWorkflow ? null : seasonNumber,
        seasonName: isFilmWorkflow ? null : seasonName,
        episodeCount: isFilmWorkflow ? 0 : episodeCount,
        episodes: isFilmWorkflow ? [] : (Array.isArray(episodes) ? episodes : []),
        ...(isFilmWorkflow ? {} : (discNumber !== null ? { discNumber } : {})),
        ...(tmdbDetails && typeof tmdbDetails === 'object' ? { tmdbDetails } : {})
      };
      const existingAnalyzeSelected = analyzeContext?.selectedMetadata && typeof analyzeContext.selectedMetadata === 'object'
        ? analyzeContext.selectedMetadata
        : {};
      const existingSeriesLookupHint = analyzeContext?.seriesLookupHint && typeof analyzeContext.seriesLookupHint === 'object'
        ? analyzeContext.seriesLookupHint
        : {};
      const nextAnalyzeContext = {
        ...analyzeContext,
        workflowKind: isFilmWorkflow ? 'film' : 'series',
        metadataProvider: 'tmdb',
        metadataKind,
        selectedMetadata: {
          ...existingAnalyzeSelected,
          ...nextSelectedMetadata
        },
        seriesLookupHint: isFilmWorkflow
          ? {
              ...existingSeriesLookupHint,
              seasonNumber: null,
              discNumber: null
            }
          : {
              ...existingSeriesLookupHint,
              query: String(existingSeriesLookupHint.query || title || '').trim() || null,
              seasonNumber: seasonNumber !== null
                ? seasonNumber
                : normalizePositiveNumberOrNull(existingSeriesLookupHint.seasonNumber ?? null),
              discNumber: discNumber !== null
                ? discNumber
                : normalizePositiveIntegerOrNull(existingSeriesLookupHint.discNumber ?? null)
            }
      };
      const topLevelSelected = makemkvInfo?.selectedMetadata && typeof makemkvInfo.selectedMetadata === 'object'
        ? makemkvInfo.selectedMetadata
        : {};
      const nextMakemkvInfo = {
        ...(makemkvInfo && typeof makemkvInfo === 'object' ? makemkvInfo : {}),
        selectedMetadata: {
          ...topLevelSelected,
          ...nextSelectedMetadata
        },
        analyzeContext: nextAnalyzeContext
      };

      await this.updateJob(jobId, {
        title,
        year,
        imdb_id: imdbId,
        poster_url: posterUrl,
        omdb_json: null,
        selected_from_omdb: 0,
        migrate_tmdb: 1,
        makemkv_info_json: JSON.stringify(nextMakemkvInfo)
      });

      if (shouldQueuePosterCache && posterUrl && !thumbnailService.isLocalUrl(posterUrl)) {
        this.queuePosterCache(jobId, posterUrl, {
          source: 'TMDb Poster',
          logFailures: true
        });
      }

      await this.appendLog(
        jobId,
        'USER_ACTION',
        effectiveTmdbId !== null
          ? `TMDb-Zuordnung aktualisiert: ${effectiveTmdbId}${!isFilmWorkflow && seasonNumber !== null ? ` (Staffel ${seasonNumber})` : ''} (${title || '-'})`
          : `TMDb-Metadaten manuell aktualisiert: title="${title || '-'}", year="${year || '-'}", imdb="${imdbId || '-'}"`
      );

      const [updated, settings] = await Promise.all([
        this.getJobById(jobId),
        settingsService.getSettingsMap()
      ]);
      return enrichJobRow(updated, settings);
    }

    const unsupportedError = new Error('Nur TMDb-Metadaten werden unterstützt.');
    unsupportedError.statusCode = 400;
    throw unsupportedError;
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
    let coverUrl = String(payload.coverUrl || '').trim() || null;
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

    let shouldQueueCoverCache = false;
    if (coverUrl && !thumbnailService.isLocalUrl(coverUrl)) {
      try {
        const cacheResult = await this.cacheAndPromoteExternalPoster(jobId, coverUrl, {
          source: 'Coverart',
          logFailures: false
        });
        if (cacheResult?.ok && cacheResult?.localUrl) {
          coverUrl = cacheResult.localUrl;
        } else {
          shouldQueueCoverCache = true;
        }
      } catch (_error) {
        shouldQueueCoverCache = true;
      }
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

    if (shouldQueueCoverCache && coverUrl && !thumbnailService.isLocalUrl(coverUrl)) {
      this.queuePosterCache(jobId, coverUrl, {
        source: 'Coverart',
        logFailures: true
      });
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

  async acknowledgeJobError(jobId) {
    const normalizedJobId = normalizeJobIdValue(jobId);
    if (!normalizedJobId) {
      const error = new Error('Ungültige Job-ID.');
      error.statusCode = 400;
      throw error;
    }

    const job = await this.getJobById(normalizedJobId);
    if (!job) {
      const error = new Error('Job nicht gefunden.');
      error.statusCode = 404;
      throw error;
    }

    const hasErrorMessage = Boolean(String(job?.error_message || '').trim());
    const statusUpper = String(job?.status || '').trim().toUpperCase();
    const setCancelled = statusUpper === 'ERROR';

    if (!hasErrorMessage && !setCancelled) {
      const [updatedUnchanged, unchangedSettings] = await Promise.all([
        this.getJobById(normalizedJobId),
        settingsService.getSettingsMap()
      ]);
      return enrichJobRow(updatedUnchanged, unchangedSettings);
    }

    await this.updateJob(normalizedJobId, {
      error_message: null,
      ...(setCancelled ? { status: 'CANCELLED' } : {}),
      ...(!job?.end_time ? { end_time: new Date().toISOString() } : {})
    });

    await this.appendLog(
      normalizedJobId,
      'USER_ACTION',
      'Fehlermeldung quittiert.'
    );

    const [updated, settings] = await Promise.all([
      this.getJobById(normalizedJobId),
      settingsService.getSettingsMap()
    ]);
    return enrichJobRow(updated, settings);
  }

  async _resolveRelatedJobsForDeletion(jobId, options = {}) {
    const includeRelated = options?.includeRelated !== false;
    const includeLogLinks = options?.includeLogLinks !== false;
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
    const parentRow = normalizeJobIdValue(primary?.parent_job_id) !== null
      ? byId.get(normalizeJobIdValue(primary?.parent_job_id))
      : null;
    const isPrimarySeriesChild = isSeriesChildRow(primary)
      || (parentRow && isSeriesContainerRow(parentRow));
    const isPrimaryMultipartChild = isMultipartChildRow(primary)
      || isMultipartMergeRow(primary)
      || (parentRow && isMultipartContainerRow(parentRow));
    const isPrimarySeriesContainer = isSeriesContainerRow(primary);
    const isPrimaryMultipartContainer = isMultipartContainerRow(primary);
    const isPrimaryScopedChild = isPrimarySeriesChild || isPrimaryMultipartChild;
    const isPrimaryDiskContainer = isPrimarySeriesContainer || isPrimaryMultipartContainer;
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

      if (!(isPrimaryScopedChild || isPrimaryDiskContainer)) {
        enqueue(row.parent_job_id);
        enqueue(parseSourceJobIdFromPlan(row.encode_plan_json));
      }

      for (const childId of (childrenByParent.get(currentId) || [])) {
        enqueue(childId);
      }
      for (const childId of (childrenBySource.get(currentId) || [])) {
        enqueue(childId);
      }

      if (includeLogLinks && !(isPrimaryScopedChild || isPrimaryDiskContainer)) {
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
    }

    if (isPrimaryScopedChild && parentRow && isDiskContainerRow(parentRow)) {
      const parentId = normalizeJobIdValue(parentRow?.id);
      if (parentId) {
        const remainingChildren = rows.filter((row) => {
          const rowId = normalizeJobIdValue(row?.id);
          if (!rowId) {
            return false;
          }
          if (normalizeJobIdValue(row?.parent_job_id) !== parentId) {
            return false;
          }
          return !visited.has(rowId);
        });
        if (remainingChildren.length === 0) {
          visited.add(parentId);
        }
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
    const trackedOutputPaths = Array.isArray(options?.trackedOutputPaths)
      ? options.trackedOutputPaths
      : [];
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
    const explicitMovieSeedPaths = unique([
      toNormalizedPath(job?.output_path),
      toNormalizedPath(resolvedPaths?.effectiveOutputPath),
      ...trackedOutputPaths.map((candidatePath) => toNormalizedPath(candidatePath)),
      ...artifactMoviePaths
    ]);
    const inferredSiblingMoviePaths = explicitMovieSeedPaths.flatMap((candidatePath) => inferSiblingOutputFolders(candidatePath));
    const explicitMoviePaths = unique([
      ...explicitMovieSeedPaths,
      ...inferredSiblingMoviePaths.map((candidatePath) => toNormalizedPath(candidatePath))
    ]);

    const rawRoots = sanitizeRoots([
      toNormalizedPath(resolvedPaths?.rawDir),
      ...explicitRawPaths.map((candidatePath) => toNormalizedPath(path.dirname(candidatePath)))
    ]);
    // Only effective base dir for this job becomes protectedRoot (must never be deleted itself)
    const movieRoots = sanitizeRoots([
      toNormalizedPath(resolvedPaths?.movieDir)
    ]);
    // Includes parent dirs of output files for addCandidate safety checks
    const movieAllowedPaths = sanitizeRoots([
      ...movieRoots,
      ...explicitMoviePaths,
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
        movieAllowedPaths
      );
    }

    if (normalizedJobId && resolvedPaths?.mediaType !== 'cd') {
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

  _buildDeletePreviewFromJobs(jobs = [], settings = null, lineageArtifactsByJobId = null, outputFoldersByJobId = null) {
    const rows = Array.isArray(jobs) ? jobs : [];
    const artifactsMap = lineageArtifactsByJobId instanceof Map ? lineageArtifactsByJobId : new Map();
    const trackedFoldersMap = outputFoldersByJobId instanceof Map ? outputFoldersByJobId : new Map();
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
      const trackedFolders = trackedFoldersMap.get(normalizeJobIdValue(job?.id)) || [];
      const collected = this._collectDeleteCandidatesForJob(job, settings, {
        lineageArtifacts,
        trackedOutputPaths: trackedFolders
          .map((folder) => String(folder?.output_path || '').trim())
          .filter(Boolean)
      });
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

    const hasTrackedOutputSource = (sources = []) => {
      const normalizedSources = Array.isArray(sources)
        ? sources
          .map((source) => String(source || '').trim().toLowerCase())
          .filter(Boolean)
        : [];
      return normalizedSources.includes('output_path') || normalizedSources.includes('lineage_output_path');
    };

    const buildList = (target) => {
      const rows = Array.from(candidateMap.values())
        .filter((row) => row.target === target);
      if (target !== 'movie') {
        return rows
          .map((row) => {
            const inspection = inspectDeletionPath(row.path);
            const sources = Array.from(row.sources).sort((left, right) => left.localeCompare(right));
            return {
              target,
              path: row.path,
              exists: Boolean(inspection.exists),
              isDirectory: Boolean(inspection.isDirectory),
              isFile: Boolean(inspection.isFile),
              jobIds: Array.from(row.jobIds).sort((left, right) => left - right),
              sources
            };
          })
          .filter((row) => Boolean(row?.exists))
          .filter(Boolean)
          .sort((left, right) => String(left.path || '').localeCompare(String(right.path || ''), 'de'));
      }

      const moviePathMap = new Map();
      const upsertMoviePath = ({ path: candidatePath, exists, isDirectory, isFile, jobIds, sources }) => {
        const normalizedPath = normalizeComparablePath(candidatePath);
        if (!normalizedPath) {
          return;
        }
        if (!moviePathMap.has(normalizedPath)) {
          moviePathMap.set(normalizedPath, {
            target: 'movie',
            path: normalizedPath,
            exists: Boolean(exists),
            isDirectory: Boolean(isDirectory),
            isFile: Boolean(isFile),
            jobIds: new Set(),
            sources: new Set()
          });
        }
        const row = moviePathMap.get(normalizedPath);
        row.exists = row.exists || Boolean(exists);
        row.isDirectory = row.isDirectory || Boolean(isDirectory);
        row.isFile = row.isFile || Boolean(isFile);
        for (const jobId of (Array.isArray(jobIds) ? jobIds : [])) {
          const normalizedJobId = normalizeJobIdValue(jobId);
          if (normalizedJobId) {
            row.jobIds.add(normalizedJobId);
          }
        }
        for (const source of (Array.isArray(sources) ? sources : [])) {
          const normalizedSource = String(source || '').trim();
          if (normalizedSource) {
            row.sources.add(normalizedSource);
          }
        }
      };

      for (const row of rows) {
        const inspection = inspectDeletionPath(row.path);
        const sources = Array.from(row.sources).sort((left, right) => left.localeCompare(right));
        // Do not expose stale output paths from DB/lineage in delete preview.
        if (!inspection.exists && hasTrackedOutputSource(sources)) {
          continue;
        }
        if (!inspection.exists) {
          // Output candidates must stay file-based only. Missing paths are not actionable.
          continue;
        }
        if (inspection.isDirectory) {
          const files = collectFilesRecursively(inspection.path);
          for (const filePath of files) {
            upsertMoviePath({
              path: filePath,
              exists: true,
              isDirectory: false,
              isFile: true,
              jobIds: Array.from(row.jobIds),
              sources
            });
          }
          continue;
        }
        upsertMoviePath({
          path: inspection.path,
          exists: true,
          isDirectory: false,
          isFile: true,
          jobIds: Array.from(row.jobIds),
          sources
        });
      }

      return Array.from(moviePathMap.values())
        .map((row) => ({
          target: row.target,
          path: row.path,
          exists: Boolean(row.exists),
          isDirectory: false,
          isFile: true,
          jobIds: Array.from(row.jobIds).sort((left, right) => left - right),
          sources: Array.from(row.sources).sort((left, right) => left.localeCompare(right))
        }))
        .sort((left, right) => String(left.path || '').localeCompare(String(right.path || ''), 'de'));
    };

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
    const requestedSelectedJobIds = Array.isArray(options?.selectedJobIds)
      ? options.selectedJobIds
        .map((item) => normalizeJobIdValue(item))
        .filter(Boolean)
      : null;
    const normalizedJobId = normalizeJobIdValue(jobId);
    if (!normalizedJobId) {
      const error = new Error('Ungültige Job-ID.');
      error.statusCode = 400;
      throw error;
    }

    const jobs = await this._resolveRelatedJobsForDeletion(normalizedJobId, { includeRelated });
    const allJobIds = jobs.map((job) => normalizeJobIdValue(job?.id)).filter(Boolean);
    const allJobIdSet = new Set(allJobIds);
    const hasExplicitSelectedJobIds = Array.isArray(requestedSelectedJobIds);
    const effectiveSelectedJobIds = includeRelated
      ? (hasExplicitSelectedJobIds
        ? requestedSelectedJobIds.filter((id) => allJobIdSet.has(id))
        : allJobIds)
      : [normalizedJobId];
    const effectiveSelectedJobIdSet = new Set(effectiveSelectedJobIds);
    const selectedJobs = jobs.filter((job) => effectiveSelectedJobIdSet.has(normalizeJobIdValue(job?.id)));

    const settings = await settingsService.getSettingsMap();
    const relatedJobIds = selectedJobs.map((job) => normalizeJobIdValue(job?.id)).filter(Boolean);
    const [lineageArtifactsByJobId, outputFoldersByJobId] = relatedJobIds.length > 0
      ? await Promise.all([
        this.listJobLineageArtifactsByJobIds(relatedJobIds),
        this.listJobOutputFoldersByJobIds(relatedJobIds)
      ])
      : [new Map(), new Map()];
    const preview = this._buildDeletePreviewFromJobs(
      selectedJobs,
      settings,
      lineageArtifactsByJobId,
      outputFoldersByJobId
    );
    const relatedJobs = jobs.map((job) => {
      const mkInfo = parseJsonSafe(job?.makemkv_info_json, {});
      const roleMeta = resolveDeletePreviewRole(job);
      const id = normalizeJobIdValue(job?.id);
      return {
        id: Number(job.id),
        parentJobId: normalizeJobIdValue(job.parent_job_id),
        title: buildJobDisplayTitle(job),
        status: String(job.status || '').trim() || null,
        discDevice: String(job.disc_device || '').trim() || null,
        isPrimary: Number(job.id) === normalizedJobId,
        selected: Boolean(id && effectiveSelectedJobIdSet.has(id)),
        roleKey: roleMeta.roleKey,
        roleLabel: roleMeta.roleLabel,
        createdAt: String(job.created_at || '').trim() || null,
        orphanRawImport: isOrphanRawImportMakemkvInfo(mkInfo)
      };
    });
    const orphanRawImportJobs = relatedJobs.filter(
      (row) => Boolean(row?.selected) && Boolean(row?.orphanRawImport)
    ).length;
    const existingRawCandidates = preview.pathCandidates.raw.filter((row) => row.exists).length;
    const existingMovieCandidates = preview.pathCandidates.movie.filter((row) => row.exists).length;

    return {
      jobId: normalizedJobId,
      includeRelated,
      selectedJobIds: effectiveSelectedJobIds,
      relatedJobs,
      pathCandidates: preview.pathCandidates,
      protectedRoots: preview.protectedRoots,
      flags: {
        containsOrphanRawImportJob: orphanRawImportJobs > 0
      },
      counts: {
        relatedJobs: relatedJobs.length,
        selectedJobs: effectiveSelectedJobIds.length,
        orphanRawImportJobs,
        rawCandidates: preview.pathCandidates.raw.length,
        movieCandidates: preview.pathCandidates.movie.length,
        existingRawCandidates,
        existingMovieCandidates
      }
    };
  }

  _deletePathsFromPreview(preview, target = 'both', options = {}) {
    const normalizedTarget = String(target || 'both').trim().toLowerCase();
    const includesRaw = normalizedTarget === 'raw' || normalizedTarget === 'both';
    const includesMovie = normalizedTarget === 'movie' || normalizedTarget === 'both';
    const selectedRawPathFilter = new Set(
      (Array.isArray(options?.selectedRawPaths) ? options.selectedRawPaths : [])
        .map((rawPath) => String(rawPath || '').trim())
        .filter(Boolean)
        .map((rawPath) => normalizeComparablePath(rawPath))
    );
    const selectedMoviePathFilter = new Set(
      (Array.isArray(options?.selectedMoviePaths) ? options.selectedMoviePaths : [])
        .map((moviePath) => String(moviePath || '').trim())
        .filter(Boolean)
        .map((moviePath) => normalizeComparablePath(moviePath))
    );

    const summary = {
      target: normalizedTarget,
      raw: { attempted: includesRaw, deleted: false, filesDeleted: 0, dirsRemoved: 0, pathsDeleted: 0, reason: null },
      movie: { attempted: includesMovie, deleted: false, filesDeleted: 0, dirsRemoved: 0, pathsDeleted: 0, reason: null },
      selectedRawPaths: Array.from(selectedRawPathFilter),
      selectedMoviePaths: Array.from(selectedMoviePathFilter),
      deletedPaths: []
    };

    const applyTarget = (targetKey) => {
      let candidates = (Array.isArray(preview?.pathCandidates?.[targetKey]) ? preview.pathCandidates[targetKey] : [])
        .filter((item) => Boolean(item?.exists) && (Boolean(item?.isDirectory) || Boolean(item?.isFile)));
      if (targetKey === 'raw' && selectedRawPathFilter.size > 0) {
        candidates = candidates.filter((item) => {
          const candidatePath = String(item?.path || '').trim();
          if (!candidatePath) {
            return false;
          }
          return selectedRawPathFilter.has(normalizeComparablePath(candidatePath));
        });
      }
      if (targetKey === 'movie' && selectedMoviePathFilter.size > 0) {
        candidates = candidates.filter((item) => {
          const candidatePath = String(item?.path || '').trim();
          if (!candidatePath) {
            return false;
          }
          return selectedMoviePathFilter.has(normalizeComparablePath(candidatePath));
        });

        // If selected movie paths are passed explicitly, trust this list as source of
        // truth as well. This protects against stale preview maps after path renames.
        const candidatePathSet = new Set(
          candidates
            .map((item) => normalizeComparablePath(item?.path))
            .filter(Boolean)
        );
        for (const selectedPath of selectedMoviePathFilter) {
          if (!selectedPath || candidatePathSet.has(selectedPath)) {
            continue;
          }
          const inspection = inspectDeletionPath(selectedPath);
          if (!inspection.exists || (!inspection.isDirectory && !inspection.isFile)) {
            continue;
          }
          candidates.push({
            target: 'movie',
            path: inspection.path,
            exists: true,
            isDirectory: Boolean(inspection.isDirectory),
            isFile: Boolean(inspection.isFile),
            jobIds: [],
            sources: ['selected_movie_paths']
          });
          candidatePathSet.add(inspection.path);
        }
      }
      if (candidates.length === 0) {
        if (targetKey === 'raw' && selectedRawPathFilter.size > 0) {
          summary[targetKey].reason = 'Keine ausgewählten RAW-Dateien/Ordner gefunden.';
        } else if (targetKey === 'movie' && selectedMoviePathFilter.size > 0) {
          summary[targetKey].reason = 'Keine ausgewählten Audio/Video-Dateien gefunden.';
        } else {
          summary[targetKey].reason = 'Keine passenden Dateien/Ordner gefunden.';
        }
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
          if (targetKey === 'movie') {
            const filesInDirectory = collectFilesRecursively(inspection.path);
            let filesDeleted = 0;
            for (const filePath of filesInDirectory) {
              const fileInspection = inspectDeletionPath(filePath);
              if (!fileInspection.exists) {
                continue;
              }
              if (fileInspection.isDirectory) {
                continue;
              }
              try {
                fs.unlinkSync(fileInspection.path);
                filesDeleted += 1;
                summary.deletedPaths.push({
                  target: targetKey,
                  path: fileInspection.path,
                  type: 'file',
                  keepRoot: false,
                  jobIds: Array.isArray(candidate?.jobIds) ? candidate.jobIds : []
                });
              } catch (_error) {
                // continue best-effort for remaining files
              }
            }
            summary[targetKey].filesDeleted += filesDeleted;

            const keepRoot = protectedRoots.has(inspection.path);
            const dirDeleteResult = deleteFilesRecursively(inspection.path, keepRoot);
            const dirsRemoved = Number(dirDeleteResult?.dirsRemoved || 0);
            if (dirsRemoved > 0 || filesDeleted > 0) {
              summary[targetKey].dirsRemoved += dirsRemoved;
              summary[targetKey].pathsDeleted += 1;
              summary.deletedPaths.push({
                target: targetKey,
                path: inspection.path,
                type: 'directory',
                keepRoot,
                jobIds: Array.isArray(candidate?.jobIds) ? candidate.jobIds : []
              });
            }
            const removedParentDirs = removeEmptyParentDirectories(path.dirname(inspection.path), {
              protectedRoots: Array.from(protectedRoots)
            });
            for (const removedPath of removedParentDirs) {
              summary[targetKey].dirsRemoved += 1;
              summary.deletedPaths.push({
                target: targetKey,
                path: removedPath,
                type: 'directory',
                keepRoot: false,
                jobIds: Array.isArray(candidate?.jobIds) ? candidate.jobIds : []
              });
            }
            continue;
          }
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

        if (targetKey === 'movie') {
          const parentDir = normalizeComparablePath(path.dirname(inspection.path));
          const removedParentDirs = removeEmptyParentDirectories(parentDir, {
            protectedRoots: Array.from(protectedRoots)
          });
          for (const removedPath of removedParentDirs) {
            summary[targetKey].dirsRemoved += 1;
            summary.deletedPaths.push({
              target: targetKey,
              path: removedPath,
              type: 'directory',
              keepRoot: false,
              jobIds: Array.isArray(candidate?.jobIds) ? candidate.jobIds : []
            });
          }
        }
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

  _archiveProcessLogFile(jobId, options = {}) {
    const processLogPath = toProcessLogPath(jobId);
    if (!processLogPath || !fs.existsSync(processLogPath)) {
      return null;
    }
    const archiveTarget = buildArchivedProcessLogPath(jobId, options);
    if (!archiveTarget?.archivePath) {
      return null;
    }

    try {
      fs.mkdirSync(archiveTarget.archiveDir, { recursive: true });
      fs.renameSync(processLogPath, archiveTarget.archivePath);
      return archiveTarget.archivePath;
    } catch (error) {
      logger.warn('job:process-log:archive-failed', {
        jobId,
        fromPath: processLogPath,
        toPath: archiveTarget.archivePath,
        reason: String(options?.reason || '').trim() || null,
        replacementJobId: Number(options?.replacementJobId) || null,
        error: error?.message || String(error)
      });
      return null;
    }
  }

  async deleteJobFiles(jobId, target = 'both', options = {}) {
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

    const includeRelated = Boolean(options?.includeRelated);
    const selectedJobIds = Array.isArray(options?.selectedJobIds)
      ? options.selectedJobIds
        .map((item) => normalizeJobIdValue(item))
        .filter(Boolean)
      : null;
    const selectedRawPaths = Array.isArray(options?.selectedRawPaths)
      ? options.selectedRawPaths
        .map((item) => String(item || '').trim())
        .filter(Boolean)
      : null;
    const selectedMoviePaths = Array.isArray(options?.selectedMoviePaths)
      ? options.selectedMoviePaths
        .map((item) => String(item || '').trim())
        .filter(Boolean)
      : null;

    const hasSelectedJobFilter = Array.isArray(options?.selectedJobIds);
    if (
      includeRelated
      || hasSelectedJobFilter
      || (selectedRawPaths && selectedRawPaths.length > 0)
      || (selectedMoviePaths && selectedMoviePaths.length > 0)
    ) {
      const normalizedJobId = normalizeJobIdValue(jobId);
      const preview = await this.getJobDeletePreview(normalizedJobId, { includeRelated, selectedJobIds });
      const summary = this._deletePathsFromPreview(preview, target, { selectedRawPaths, selectedMoviePaths });
      const relatedJobIds = Array.from(new Set(
        (Array.isArray(preview?.selectedJobIds) ? preview.selectedJobIds : [])
          .map((row) => normalizeJobIdValue(row))
          .filter(Boolean)
      ));

      if (summary.movie?.deleted) {
        await this.removeMissingJobOutputFoldersFromJobs(
          relatedJobIds.length > 0 ? relatedJobIds : [normalizedJobId]
        );
      }

      await this.appendLog(
        normalizedJobId,
        'USER_ACTION',
        `Dateien gelöscht (${target}) - includeRelated=${includeRelated} - raw=${JSON.stringify(summary.raw)} movie=${JSON.stringify(summary.movie)}`
      );
      logger.info('job:delete-files', {
        jobId: normalizedJobId,
        includeRelated,
        selectedJobIdCount: selectedJobIds ? selectedJobIds.length : 0,
        selectedRawPathCount: selectedRawPaths ? selectedRawPaths.length : 0,
        selectedMoviePathCount: selectedMoviePaths ? selectedMoviePaths.length : 0,
        summary
      });

      const [updated, enrichSettings] = await Promise.all([
        this.getJobById(normalizedJobId),
        settingsService.getSettingsMap()
      ]);
      return {
        summary,
        includeRelated,
        relatedJobIds,
        job: enrichJobRow(updated, enrichSettings)
      };
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
    let movieDeletedPathForTracking = null;
    let movieCandidatePathForTracking = null;

    if (target === 'raw' || target === 'both') {
      summary.raw.attempted = true;
      if (!effectiveRawPath) {
        summary.raw.reason = 'Kein raw_path im Job gesetzt.';
      } else if (!effectiveRawDir) {
        const error = new Error(`Kein gültiger RAW-Basispfad für Job ${jobId} (${resolvedPaths.mediaType || 'unknown'}).`);
        error.statusCode = 400;
        throw error;
      } else if (!isPathInside(effectiveRawDir, effectiveRawPath)) {
        const error = new Error(
          `RAW-Pfad liegt außerhalb des effektiven RAW-Basispfads. raw_path=${effectiveRawPath} raw_base=${effectiveRawDir}`
        );
        error.statusCode = 400;
        throw error;
      } else if (!fs.existsSync(effectiveRawPath)) {
        summary.raw.reason = 'RAW-Pfad existiert nicht.';
      } else {
        const rawPath = normalizeComparablePath(effectiveRawPath);
        const rawRoot = normalizeComparablePath(effectiveRawDir);
        const stat = fs.lstatSync(rawPath);
        const isFile = stat.isFile();
        const plan = resolvedPaths.encodePlan || {};

        // Für Converter-Jobs: nur die zum Job gehörenden Dateien löschen.
        // Der übergeordnete Ordner wird nur entfernt, wenn er danach leer ist.
        // Ausnahme: Ordner-Jobs (isFolder=true) haben einen dedizierten Ordner → komplett löschen.
        const isConverterFolder = resolvedPaths.mediaType === 'converter' && Boolean(plan.isFolder);
        const isSharedAudio = resolvedPaths.mediaType === 'converter' && Boolean(plan.isSharedAudio);
        const isConverterFileJob = resolvedPaths.mediaType === 'converter' && !isConverterFolder;

        if (isConverterFileJob) {
          // Bestimme die zu löschenden Dateien dieses Jobs
          let filesToDelete = null;
          if (isSharedAudio && Array.isArray(plan.inputPaths) && plan.inputPaths.length > 0) {
            // Shared-Audio-Job: nur die explizit gelisteten Einzeldateien entfernen
            filesToDelete = plan.inputPaths.map(normalizeComparablePath).filter(Boolean);
          } else if (isFile) {
            // Einzeldatei-Job: nur diese eine Datei entfernen
            filesToDelete = [rawPath];
          }

          if (filesToDelete) {
            let filesDeleted = 0;
            const parentDirs = new Set();
            for (const filePath of filesToDelete) {
              if (!isPathInside(rawRoot, filePath)) continue;
              if (!fs.existsSync(filePath)) continue;
              const fStat = fs.lstatSync(filePath);
              if (!fStat.isFile()) continue;
              fs.unlinkSync(filePath);
              filesDeleted++;
              const parentDir = normalizeComparablePath(path.dirname(filePath));
              if (parentDir && parentDir !== rawRoot && isPathInside(rawRoot, parentDir)) {
                parentDirs.add(parentDir);
              }
            }
            // Übergeordneten Ordner löschen, wenn er nach dem Löschen leer ist
            let dirsRemoved = 0;
            for (const parentDir of parentDirs) {
              try {
                if (!fs.existsSync(parentDir)) continue;
                const remaining = fs.readdirSync(parentDir);
                if (remaining.length === 0) {
                  fs.rmdirSync(parentDir);
                  dirsRemoved++;
                }
              } catch (_err) { /* ignore */ }
            }
            summary.raw.deleted = true;
            summary.raw.filesDeleted = filesDeleted;
            summary.raw.dirsRemoved = dirsRemoved;
          } else {
            // Fallback: rawPath ist ein Verzeichnis ohne explizite Dateiliste
            const keepRoot = rawPath === rawRoot;
            const result = deleteFilesRecursively(rawPath, keepRoot);
            summary.raw.deleted = true;
            summary.raw.filesDeleted = result.filesDeleted;
            summary.raw.dirsRemoved = result.dirsRemoved;
          }
        } else {
          // Regulärer Job oder dedizierter Converter-Ordner-Job (isFolder=true): gesamten Pfad löschen
          const keepRoot = rawPath === rawRoot;
          const result = deleteFilesRecursively(rawPath, keepRoot);
          summary.raw.deleted = true;
          summary.raw.filesDeleted = result.filesDeleted;
          summary.raw.dirsRemoved = result.dirsRemoved;
        }
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
        const error = new Error(
          `Movie-Pfad liegt außerhalb des effektiven Movie-Basispfads. output_path=${effectiveOutputPath} movie_base=${effectiveMovieDir}`
        );
        error.statusCode = 400;
        throw error;
      } else if (!fs.existsSync(effectiveOutputPath)) {
        const movieRoot = normalizeComparablePath(effectiveMovieDir);
        const pruneEmptyMovieParents = (startPath) => {
          if (!startPath || !movieRoot) {
            return [];
          }
          return removeEmptyParentDirectories(startPath, {
            protectedRoots: [movieRoot]
          });
        };
        const trackedFolders = await this.getJobOutputFolders(jobId);
        const trackedExistingPaths = Array.from(new Set(
          trackedFolders
            .map((row) => normalizeComparablePath(row?.output_path))
            .filter(Boolean)
            .filter((candidatePath) => isPathInside(effectiveMovieDir, candidatePath))
            .filter((candidatePath) => candidatePath !== movieRoot)
            .filter((candidatePath) => fs.existsSync(candidatePath))
        ));

        if (trackedExistingPaths.length === 1) {
          const trackedPath = trackedExistingPaths[0];
          const stat = fs.lstatSync(trackedPath);
          if (stat.isDirectory()) {
            const keepRoot = trackedPath === movieRoot;
            const result = deleteFilesRecursively(trackedPath, keepRoot);
            const removedParentDirs = keepRoot
              ? []
              : pruneEmptyMovieParents(path.dirname(trackedPath));
            summary.movie.deleted = true;
            summary.movie.filesDeleted = result.filesDeleted;
            summary.movie.dirsRemoved = result.dirsRemoved + Number(removedParentDirs.length || 0);
            movieDeletedPathForTracking = trackedPath;
            movieCandidatePathForTracking = trackedPath;
            summary.movie.reason = null;
          } else {
            const parentDir = normalizeComparablePath(path.dirname(trackedPath));
            const isConverterJob = resolvedPaths.mediaType === 'converter';
            const canDeleteParentDir = !isConverterJob
              && parentDir
              && parentDir !== movieRoot
              && isPathInside(movieRoot, parentDir)
              && fs.existsSync(parentDir)
              && fs.lstatSync(parentDir).isDirectory();

            if (canDeleteParentDir) {
              const result = deleteFilesRecursively(parentDir, false);
              const removedParentDirs = pruneEmptyMovieParents(path.dirname(parentDir));
              summary.movie.deleted = true;
              summary.movie.filesDeleted = result.filesDeleted;
              summary.movie.dirsRemoved = result.dirsRemoved + Number(removedParentDirs.length || 0);
              movieDeletedPathForTracking = parentDir;
              movieCandidatePathForTracking = trackedPath;
            } else {
              fs.unlinkSync(trackedPath);
              const removedParentDirs = pruneEmptyMovieParents(parentDir);
              summary.movie.deleted = true;
              summary.movie.filesDeleted = 1;
              summary.movie.dirsRemoved = Number(removedParentDirs.length || 0);
              movieDeletedPathForTracking = trackedPath;
              movieCandidatePathForTracking = trackedPath;
            }
            summary.movie.reason = null;
          }
        } else if (trackedExistingPaths.length > 1) {
          summary.movie.reason = 'Mehrere bekannte Output-Ordner gefunden. Bitte gezielt über die Ordnerauswahl löschen.';
        } else {
          summary.movie.reason = 'Movie-Datei/Pfad existiert nicht.';
        }
      } else {
        const outputPath = normalizeComparablePath(effectiveOutputPath);
        const movieRoot = normalizeComparablePath(effectiveMovieDir);
        const pruneEmptyMovieParents = (startPath) => {
          if (!startPath || !movieRoot) {
            return [];
          }
          return removeEmptyParentDirectories(startPath, {
            protectedRoots: [movieRoot]
          });
        };
        const stat = fs.lstatSync(outputPath);
        if (stat.isDirectory()) {
          const keepRoot = outputPath === movieRoot;
          const result = deleteFilesRecursively(outputPath, keepRoot ? true : false);
          const removedParentDirs = keepRoot
            ? []
            : pruneEmptyMovieParents(path.dirname(outputPath));
          summary.movie.deleted = true;
          summary.movie.filesDeleted = result.filesDeleted;
          summary.movie.dirsRemoved = result.dirsRemoved + Number(removedParentDirs.length || 0);
          movieDeletedPathForTracking = outputPath;
          movieCandidatePathForTracking = outputPath;
        } else {
          const parentDir = normalizeComparablePath(path.dirname(outputPath));
          const parentDirName = String(path.basename(parentDir || '') || '').trim();
          const isIncompleteMergeParentDir = /^incomplete_merge_.+_job_\d+\s*$/i.test(parentDirName);
          // Converter jobs output a single file — never delete the parent dir
          const isConverterJob = resolvedPaths.mediaType === 'converter';
          const canDeleteParentDir = !isConverterJob
            && !isIncompleteMergeParentDir
            && parentDir
            && parentDir !== movieRoot
            && isPathInside(movieRoot, parentDir)
            && fs.existsSync(parentDir)
            && fs.lstatSync(parentDir).isDirectory();

          if (canDeleteParentDir) {
            const result = deleteFilesRecursively(parentDir, false);
            const removedParentDirs = pruneEmptyMovieParents(path.dirname(parentDir));
            summary.movie.deleted = true;
            summary.movie.filesDeleted = result.filesDeleted;
            summary.movie.dirsRemoved = result.dirsRemoved + Number(removedParentDirs.length || 0);
            movieDeletedPathForTracking = parentDir;
            movieCandidatePathForTracking = outputPath;
          } else {
            fs.unlinkSync(outputPath);
            const removedParentDirs = pruneEmptyMovieParents(parentDir);
            summary.movie.deleted = true;
            summary.movie.filesDeleted = 1;
            summary.movie.dirsRemoved = Number(removedParentDirs.length || 0);
            movieDeletedPathForTracking = outputPath;
            movieCandidatePathForTracking = outputPath;
          }
        }
      }
    }

    // Remove deleted movie paths from output folders tracking
    if (summary.movie?.deleted) {
      const trackingCleanupPaths = Array.from(new Set([
        movieCandidatePathForTracking,
        movieDeletedPathForTracking
      ].filter(Boolean)));
      for (const candidatePath of trackingCleanupPaths) {
        await this.removeJobOutputFolder(jobId, candidatePath);
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

  async addJobOutputFolder(jobId, outputPath, label = null) {
    const normalizedJobId = Number(jobId);
    const normalizedPath = String(outputPath || '').trim();
    if (!normalizedJobId || !normalizedPath) return null;
    const db = await getDb();
    await db.run(
      'INSERT OR IGNORE INTO job_output_folders (job_id, output_path, label) VALUES (?, ?, ?)',
      [normalizedJobId, normalizedPath, label || null]
    );
  }

  async getJobOutputFolders(jobId) {
    const normalizedJobId = Number(jobId);
    if (!normalizedJobId) return [];
    const db = await getDb();
    const rows = await db.all(
      'SELECT id, job_id, output_path, label, created_at FROM job_output_folders WHERE job_id = ? ORDER BY id ASC',
      [normalizedJobId]
    );
    return rows || [];
  }

  async listJobOutputFoldersByJobIds(jobIds = []) {
    const normalizedJobIds = Array.isArray(jobIds)
      ? jobIds
        .map((value) => normalizeJobIdValue(value))
        .filter(Boolean)
      : [];
    if (normalizedJobIds.length === 0) {
      return new Map();
    }

    const db = await getDb();
    const placeholders = normalizedJobIds.map(() => '?').join(', ');
    const rows = await db.all(
      `
        SELECT id, job_id, output_path, label, created_at
        FROM job_output_folders
        WHERE job_id IN (${placeholders})
        ORDER BY id ASC
      `,
      normalizedJobIds
    );

    const byJobId = new Map();
    for (const row of (Array.isArray(rows) ? rows : [])) {
      const ownerJobId = normalizeJobIdValue(row?.job_id);
      if (!ownerJobId) {
        continue;
      }
      if (!byJobId.has(ownerJobId)) {
        byJobId.set(ownerJobId, []);
      }
      byJobId.get(ownerJobId).push({
        id: normalizeJobIdValue(row?.id),
        job_id: ownerJobId,
        output_path: String(row?.output_path || '').trim() || null,
        label: String(row?.label || '').trim() || null,
        created_at: String(row?.created_at || '').trim() || null
      });
    }

    return byJobId;
  }

  async getJobOutputFoldersForLineage(jobId, options = {}) {
    const normalizedJobId = normalizeJobIdValue(jobId);
    if (!normalizedJobId) return [];
    const includeMissing = Boolean(options?.includeMissing);

    const relatedJobs = await this._resolveRelatedJobsForDeletion(normalizedJobId, {
      includeRelated: true,
      includeLogLinks: false
    });
    const relatedJobIds = Array.from(new Set(
      relatedJobs
        .map((row) => normalizeJobIdValue(row?.id))
        .filter(Boolean)
    ));
    if (relatedJobIds.length === 0) {
      return [];
    }

    const db = await getDb();
    const placeholders = relatedJobIds.map(() => '?').join(', ');
    const trackedRows = await db.all(
      `
        SELECT id, job_id, output_path, label, created_at
        FROM job_output_folders
        WHERE job_id IN (${placeholders})
        ORDER BY id ASC
      `,
      relatedJobIds
    );
    const artifactsByJobId = await this.listJobLineageArtifactsByJobIds(relatedJobIds);

    const merged = [];
    const seen = new Set();
    const addFolder = (rawFolder, defaults = {}) => {
      const outputPathRaw = String(rawFolder?.output_path || rawFolder?.outputPath || '').trim();
      if (!outputPathRaw) {
        return;
      }
      const normalizedRawPath = normalizeComparablePath(outputPathRaw);
      if (!normalizedRawPath) {
        return;
      }
      let exists = false;
      let resolvedOutputPath = normalizedRawPath;
      try {
        exists = fs.existsSync(normalizedRawPath);
      } catch (_error) {
        exists = false;
      }
      if (!exists) {
        const repairedPath = resolveExistingOutputPathVariant(normalizedRawPath);
        if (repairedPath) {
          resolvedOutputPath = repairedPath;
          try {
            exists = fs.existsSync(repairedPath);
          } catch (_error) {
            exists = false;
          }
        }
      }
      const normalized = normalizeComparablePath(resolvedOutputPath);
      if (!normalized || seen.has(normalized)) {
        return;
      }
      if (!includeMissing && !exists) {
        return;
      }
      seen.add(normalized);
      merged.push({
        id: normalizeJobIdValue(rawFolder?.id),
        job_id: normalizeJobIdValue(rawFolder?.job_id ?? rawFolder?.jobId ?? defaults.job_id ?? normalizedJobId),
        output_path: resolvedOutputPath,
        label: String(rawFolder?.label || defaults.label || '').trim() || null,
        created_at: String(rawFolder?.created_at || rawFolder?.createdAt || '').trim() || null,
        exists
      });
    };

    for (const row of (Array.isArray(trackedRows) ? trackedRows : [])) {
      addFolder(row);
    }
    for (const relatedJob of relatedJobs) {
      addFolder({
        output_path: relatedJob?.output_path || null,
        job_id: relatedJob?.id || null
      });
      const artifacts = artifactsByJobId.get(normalizeJobIdValue(relatedJob?.id)) || [];
      for (const artifact of artifacts) {
        addFolder({
          output_path: artifact?.outputPath || null,
          job_id: relatedJob?.id || null,
          label: 'Lineage-Output',
          created_at: artifact?.createdAt || null
        });
      }
    }

    // Fallback for legacy runs before output-folder tracking:
    // detect numbered sibling directories on filesystem
    //   /path/Album (1995), /path/Album (1995)_2, /path/Album (1995)_3, ...
    const seedPaths = merged
      .filter((row) => Boolean(row?.exists))
      .map((row) => String(row?.output_path || '').trim())
      .filter(Boolean);
    for (const seedPath of seedPaths) {
      const siblings = inferSiblingOutputFolders(seedPath);
      for (const siblingPath of siblings) {
        addFolder({
          output_path: siblingPath,
          job_id: normalizedJobId,
          label: 'Auto-erkannt'
        });
      }
    }

    merged.sort((left, right) => compareOutputFolderPaths(left?.output_path, right?.output_path));
    return merged;
  }

  async removeJobOutputFolder(jobId, outputPath) {
    const normalizedJobId = Number(jobId);
    const normalizedPath = normalizeComparablePath(outputPath);
    if (!normalizedJobId || !normalizedPath) return;
    const db = await getDb();
    const rows = await db.all(
      'SELECT id, output_path FROM job_output_folders WHERE job_id = ?',
      [normalizedJobId]
    );
    for (const row of (Array.isArray(rows) ? rows : [])) {
      const candidatePath = normalizeComparablePath(row?.output_path);
      if (!candidatePath || candidatePath !== normalizedPath) {
        continue;
      }
      await db.run('DELETE FROM job_output_folders WHERE id = ?', [Number(row.id)]);
    }
  }

  async removeJobOutputFolderFromJobs(jobIds = [], outputPath) {
    const normalizedPath = normalizeComparablePath(outputPath);
    const normalizedJobIds = Array.isArray(jobIds)
      ? jobIds
        .map((value) => normalizeJobIdValue(value))
        .filter(Boolean)
      : [];
    if (!normalizedPath || normalizedJobIds.length === 0) return;
    const db = await getDb();
    const placeholders = normalizedJobIds.map(() => '?').join(', ');
    const rows = await db.all(
      `SELECT id, output_path FROM job_output_folders WHERE job_id IN (${placeholders})`,
      normalizedJobIds
    );
    for (const row of (Array.isArray(rows) ? rows : [])) {
      const candidatePath = normalizeComparablePath(row?.output_path);
      if (!candidatePath || candidatePath !== normalizedPath) {
        continue;
      }
      await db.run('DELETE FROM job_output_folders WHERE id = ?', [Number(row.id)]);
    }
  }

  async removeMissingJobOutputFoldersFromJobs(jobIds = []) {
    const normalizedJobIds = Array.isArray(jobIds)
      ? jobIds
        .map((value) => normalizeJobIdValue(value))
        .filter(Boolean)
      : [];
    if (normalizedJobIds.length === 0) {
      return { removed: 0, removedPaths: [] };
    }
    const db = await getDb();
    const placeholders = normalizedJobIds.map(() => '?').join(', ');
    const rows = await db.all(
      `SELECT id, output_path FROM job_output_folders WHERE job_id IN (${placeholders})`,
      normalizedJobIds
    );
    const removedPaths = [];
    for (const row of (Array.isArray(rows) ? rows : [])) {
      const normalizedPath = normalizeComparablePath(row?.output_path);
      let removeEntry = false;
      if (!normalizedPath) {
        removeEntry = true;
      } else if (!fs.existsSync(normalizedPath)) {
        removeEntry = true;
      } else {
        try {
          const stat = fs.lstatSync(normalizedPath);
          if (stat.isDirectory()) {
            const entries = fs.readdirSync(normalizedPath);
            if (entries.length === 0) {
              fs.rmdirSync(normalizedPath);
              removeEntry = true;
            }
          }
        } catch (_error) {
          removeEntry = true;
        }
      }
      if (!removeEntry) {
        continue;
      }
      await db.run('DELETE FROM job_output_folders WHERE id = ?', [Number(row.id)]);
      if (normalizedPath) {
        removedPaths.push(normalizedPath);
      }
    }
    return {
      removed: removedPaths.length,
      removedPaths: Array.from(new Set(removedPaths)).sort((left, right) => left.localeCompare(right, 'de'))
    };
  }

  async deleteSpecificOutputFolders(jobId, folderPaths = []) {
    const paths = Array.isArray(folderPaths) ? folderPaths.filter((p) => typeof p === 'string' && p.trim()) : [];
    if (paths.length === 0) return { deleted: [], failed: [] };

    const job = await this.getJobById(jobId);
    if (!job) {
      const error = new Error('Job nicht gefunden.');
      error.statusCode = 404;
      throw error;
    }

    const settings = await settingsService.getSettingsMap();
    const resolvedPaths = resolveEffectiveStoragePathsForJob(settings, job);
    const effectiveMovieDir = resolvedPaths.movieDir;
    if (!effectiveMovieDir) {
      const error = new Error('Kein gültiger Movie-Basispfad konfiguriert.');
      error.statusCode = 400;
      throw error;
    }

    const deleted = [];
    const failed = [];
    const relatedJobs = await this._resolveRelatedJobsForDeletion(jobId, {
      includeRelated: true,
      includeLogLinks: false
    });
    const relatedJobIds = Array.from(new Set(
      relatedJobs
        .map((row) => normalizeJobIdValue(row?.id))
        .filter(Boolean)
    ));
    const trackedOutputFolders = await this.getJobOutputFoldersForLineage(jobId, { includeMissing: true });
    const trackedOutputPathSet = new Set(
      trackedOutputFolders
        .map((folder) => normalizeComparablePath(folder?.output_path))
        .filter(Boolean)
    );

    for (const folderPath of paths) {
      const normalizedFolderPath = normalizeComparablePath(folderPath);
      const isInsideEffectiveRoot = isPathInside(effectiveMovieDir, normalizedFolderPath);
      const isTrackedPath = trackedOutputPathSet.has(normalizedFolderPath);
      if (!isInsideEffectiveRoot && !isTrackedPath) {
        failed.push({ path: folderPath, reason: 'Pfad liegt außerhalb des Output-Verzeichnisses.' });
        continue;
      }
      if (!fs.existsSync(normalizedFolderPath)) {
        await this.removeJobOutputFolderFromJobs(relatedJobIds, normalizedFolderPath);
        deleted.push(normalizedFolderPath);
        continue;
      }
      try {
        const stat = fs.lstatSync(normalizedFolderPath);
        const movieRoot = normalizeComparablePath(effectiveMovieDir);
        if (stat.isDirectory()) {
          const keepRoot = normalizedFolderPath === movieRoot;
          deleteFilesRecursively(normalizedFolderPath, keepRoot);
          if (!keepRoot) {
            removeEmptyParentDirectories(path.dirname(normalizedFolderPath), {
              protectedRoots: [movieRoot]
            });
          }
        } else {
          const parentDir = normalizeComparablePath(path.dirname(normalizedFolderPath));
          const canDeleteParent = parentDir && parentDir !== movieRoot
            && isPathInside(movieRoot, parentDir)
            && fs.existsSync(parentDir)
            && fs.lstatSync(parentDir).isDirectory();
          if (canDeleteParent) {
            deleteFilesRecursively(parentDir, false);
            removeEmptyParentDirectories(path.dirname(parentDir), {
              protectedRoots: [movieRoot]
            });
          } else {
            fs.unlinkSync(normalizedFolderPath);
            if (parentDir) {
              removeEmptyParentDirectories(parentDir, {
                protectedRoots: [movieRoot]
              });
            }
          }
        }
        await this.removeJobOutputFolderFromJobs(relatedJobIds, normalizedFolderPath);
        deleted.push(normalizedFolderPath);
      } catch (error) {
        failed.push({ path: folderPath, reason: error.message });
      }
    }

    await this.appendLog(
      jobId,
      'USER_ACTION',
      `Output-Ordner gelöscht: ${deleted.length > 0 ? deleted.join(', ') : 'keine'}${failed.length > 0 ? ` | Fehler: ${failed.map((f) => f.path).join(', ')}` : ''}`
    );
    return { deleted, failed };
  }

  async _cleanupEmptyDirectoriesForDeletedJobs(jobRows = [], options = {}) {
    const rows = Array.isArray(jobRows)
      ? jobRows.filter((row) => normalizeJobIdValue(row?.id))
      : [];
    if (rows.length === 0) {
      return {
        attemptedCandidates: { raw: 0, movie: 0 },
        removed: { raw: 0, movie: 0, total: 0 },
        removedPaths: [],
        failures: []
      };
    }

    const jobIds = Array.from(new Set(
      rows
        .map((row) => normalizeJobIdValue(row?.id))
        .filter(Boolean)
    ));

    const settings = options?.settings && typeof options.settings === 'object'
      ? options.settings
      : await settingsService.getSettingsMap();
    const lineageArtifactsByJobId = options?.lineageArtifactsByJobId instanceof Map
      ? options.lineageArtifactsByJobId
      : await this.listJobLineageArtifactsByJobIds(jobIds).catch(() => new Map());
    const outputFoldersByJobId = options?.outputFoldersByJobId instanceof Map
      ? options.outputFoldersByJobId
      : await this.listJobOutputFoldersByJobIds(jobIds).catch(() => new Map());

    const candidateSets = {
      raw: new Set(),
      movie: new Set()
    };
    const protectedRootSets = {
      raw: new Set(),
      movie: new Set()
    };
    for (const row of rows) {
      const rowId = normalizeJobIdValue(row?.id);
      if (!rowId) {
        continue;
      }
      const lineageArtifacts = lineageArtifactsByJobId.get(rowId) || [];
      const trackedOutputPaths = (outputFoldersByJobId.get(rowId) || [])
        .map((folder) => String(folder?.output_path || '').trim())
        .filter(Boolean);
      const collected = this._collectDeleteCandidatesForJob(row, settings, {
        lineageArtifacts,
        trackedOutputPaths
      });
      for (const rootPath of (collected?.rawRoots || [])) {
        const normalizedRoot = normalizeComparablePath(rootPath);
        if (normalizedRoot && !isFilesystemRootPath(normalizedRoot)) {
          protectedRootSets.raw.add(normalizedRoot);
        }
      }
      for (const rootPath of (collected?.movieRoots || [])) {
        const normalizedRoot = normalizeComparablePath(rootPath);
        if (normalizedRoot && !isFilesystemRootPath(normalizedRoot)) {
          protectedRootSets.movie.add(normalizedRoot);
        }
      }
      for (const candidate of (collected?.rawCandidates || [])) {
        const normalizedPath = normalizeComparablePath(candidate?.path);
        if (normalizedPath && !isFilesystemRootPath(normalizedPath)) {
          candidateSets.raw.add(normalizedPath);
        }
      }
      for (const candidate of (collected?.movieCandidates || [])) {
        const normalizedPath = normalizeComparablePath(candidate?.path);
        if (normalizedPath && !isFilesystemRootPath(normalizedPath)) {
          candidateSets.movie.add(normalizedPath);
        }
      }
    }

    const removedPaths = [];
    const removedPathSet = new Set();
    const failures = [];
    const removedCountByTarget = {
      raw: 0,
      movie: 0
    };

    const rememberRemovedPath = (target, candidatePath) => {
      const normalizedPath = normalizeComparablePath(candidatePath);
      if (!normalizedPath || removedPathSet.has(normalizedPath)) {
        return;
      }
      removedPathSet.add(normalizedPath);
      removedPaths.push(normalizedPath);
      if (target === 'raw' || target === 'movie') {
        removedCountByTarget[target] += 1;
      }
    };

    const cleanupTarget = (target) => {
      const protectedRoots = Array.from(protectedRootSets[target] || []);
      const protectedRootSet = new Set(protectedRoots);
      const candidates = Array.from(candidateSets[target] || [])
        .filter(Boolean)
        .sort((left, right) => String(right || '').length - String(left || '').length);

      for (const candidatePathRaw of candidates) {
        const candidatePath = normalizeComparablePath(candidatePathRaw);
        if (!candidatePath || isFilesystemRootPath(candidatePath)) {
          continue;
        }

        const inspection = inspectDeletionPath(candidatePath);
        if (inspection.exists && inspection.isDirectory) {
          if (protectedRootSet.has(inspection.path)) {
            continue;
          }
          if (protectedRoots.length > 0 && !protectedRoots.some((rootPath) => isPathInside(rootPath, inspection.path))) {
            continue;
          }
          try {
            const entries = fs.readdirSync(inspection.path);
            if (entries.length > 0) {
              continue;
            }
            fs.rmdirSync(inspection.path);
            rememberRemovedPath(target, inspection.path);
            if (protectedRoots.length > 0) {
              const removedParentDirs = removeEmptyParentDirectories(path.dirname(inspection.path), {
                protectedRoots
              });
              for (const removedPath of removedParentDirs) {
                rememberRemovedPath(target, removedPath);
              }
            }
          } catch (error) {
            if (error?.code !== 'ENOENT') {
              failures.push({
                target,
                path: inspection.path,
                error: error?.message || String(error)
              });
            }
          }
          continue;
        }

        const parentDir = normalizeComparablePath(path.dirname(candidatePath));
        if (!parentDir || isFilesystemRootPath(parentDir)) {
          continue;
        }
        if (protectedRoots.length === 0) {
          continue;
        }
        if (!protectedRoots.some((rootPath) => isPathInside(rootPath, parentDir))) {
          continue;
        }
        try {
          const removedParentDirs = removeEmptyParentDirectories(parentDir, {
            protectedRoots
          });
          for (const removedPath of removedParentDirs) {
            rememberRemovedPath(target, removedPath);
          }
        } catch (error) {
          failures.push({
            target,
            path: parentDir,
            error: error?.message || String(error)
          });
        }
      }
    };

    cleanupTarget('raw');
    cleanupTarget('movie');

    return {
      attemptedCandidates: {
        raw: (candidateSets.raw || new Set()).size,
        movie: (candidateSets.movie || new Set()).size
      },
      removed: {
        raw: removedCountByTarget.raw,
        movie: removedCountByTarget.movie,
        total: removedPaths.length
      },
      removedPaths: [...removedPaths].sort((left, right) => left.localeCompare(right, 'de')),
      failures
    };
  }

  async deleteJob(jobId, fileTarget = 'none', options = {}) {
    const allowedTargets = new Set(['none', 'raw', 'movie', 'both']);
    if (!allowedTargets.has(fileTarget)) {
      const error = new Error(`Ungültiges target '${fileTarget}'. Erlaubt: none, raw, movie, both.`);
      error.statusCode = 400;
      throw error;
    }

    const preserveRawForImportJobs = Boolean(options?.preserveRawForImportJobs);
    const isOrphanRawImportJobRow = (row) => {
      if (!row || typeof row !== 'object') {
        return false;
      }
      const mkInfo = parseJsonSafe(row?.makemkv_info_json, {});
      return isOrphanRawImportMakemkvInfo(mkInfo);
    };
    const resolveEffectiveFileTarget = (requestedTarget, row) => {
      if (!preserveRawForImportJobs || !isOrphanRawImportJobRow(row)) {
        return requestedTarget;
      }
      const normalizedRequested = String(requestedTarget || 'none').trim().toLowerCase();
      if (normalizedRequested === 'raw') {
        return 'none';
      }
      if (normalizedRequested === 'both') {
        return 'movie';
      }
      return normalizedRequested;
    };
    const collectIncompleteMoviePathsFromPreview = (preview) => {
      const rows = Array.isArray(preview?.pathCandidates?.movie) ? preview.pathCandidates.movie : [];
      const incompleteJobPattern = /(^|[\\/])incomplete_job-\d+([\\/]|$)/i;
      const incompleteMergePattern = /(^|[\\/])incomplete_merge_[^\\/]+_job_\d+([\\/]|$)/i;
      return rows
        .filter((row) => Boolean(row?.exists))
        .filter((row) => {
          const candidatePath = String(row?.path || '').trim();
          if (!candidatePath) {
            return false;
          }
          if (incompleteJobPattern.test(candidatePath)) {
            return true;
          }
          if (incompleteMergePattern.test(candidatePath)) {
            // Shared multipart merge folders must never be auto-selected as a whole directory.
            return Boolean(row?.isFile);
          }
          return false;
        })
        .map((row) => String(row?.path || '').trim())
        .filter(Boolean);
    };
    const collectIncompleteRawPathsFromPreview = (preview, selectedJobRows = []) => {
      const rows = Array.isArray(selectedJobRows) ? selectedJobRows : [];
      if (rows.length === 0) {
        return [];
      }

      const incompleteCancelledJobIds = new Set(
        rows
          .filter((row) => {
            if (!row || typeof row !== 'object') {
              return false;
            }
            if (isOrphanRawImportJobRow(row)) {
              return false;
            }
            const status = String(row?.status || '').trim().toUpperCase();
            const lastState = String(row?.last_state || '').trim().toUpperCase();
            const isCancelled = status === 'CANCELLED' || lastState === 'CANCELLED';
            if (!isCancelled) {
              return false;
            }
            return Number(row?.rip_successful || 0) !== 1;
          })
          .map((row) => normalizeJobIdValue(row?.id))
          .filter(Boolean)
      );
      if (incompleteCancelledJobIds.size === 0) {
        return [];
      }

      const rawRows = Array.isArray(preview?.pathCandidates?.raw) ? preview.pathCandidates.raw : [];
      return rawRows
        .filter((row) => Boolean(row?.exists))
        .filter((row) => {
          const jobIds = Array.isArray(row?.jobIds) ? row.jobIds : [];
          return jobIds.some((jobId) => incompleteCancelledJobIds.has(normalizeJobIdValue(jobId)));
        })
        .map((row) => String(row?.path || '').trim())
        .filter(Boolean);
    };
    const cleanupIncompleteMovieFoldersForJobs = async (jobRows = [], ownerJobIds = []) => {
      const normalizedOwnerJobIds = Array.from(new Set(
        (Array.isArray(ownerJobIds) ? ownerJobIds : [])
          .map((value) => normalizeJobIdValue(value))
          .filter(Boolean)
      ));
      const rows = Array.isArray(jobRows) ? jobRows : [];
      if (rows.length === 0) {
        return { attempted: 0, deleted: 0, failed: 0, paths: [] };
      }

      const settings = await settingsService.getSettingsMap();
      const candidatePaths = new Set();
      const fallbackIncompletePattern = /^incomplete_job-(\d+)\s*$/i;

      for (const row of rows) {
        const rowId = normalizeJobIdValue(row?.id);
        if (!rowId) {
          continue;
        }
        const resolvedPaths = resolveEffectiveStoragePathsForJob(settings, row);
        const movieRoot = normalizeComparablePath(resolvedPaths?.movieDir);
        if (!movieRoot || isFilesystemRootPath(movieRoot)) {
          continue;
        }
        const canonicalPath = normalizeComparablePath(path.join(movieRoot, `Incomplete_job-${rowId}`));
        if (canonicalPath && isPathInside(movieRoot, canonicalPath)) {
          candidatePaths.add(canonicalPath);
        }
        try {
          if (!fs.existsSync(movieRoot) || !fs.lstatSync(movieRoot).isDirectory()) {
            continue;
          }
          const entries = fs.readdirSync(movieRoot, { withFileTypes: true });
          for (const entry of entries) {
            if (!entry?.isDirectory?.()) {
              continue;
            }
            const match = String(entry?.name || '').match(fallbackIncompletePattern);
            if (normalizeJobIdValue(match?.[1]) !== rowId) {
              continue;
            }
            const scannedPath = normalizeComparablePath(path.join(movieRoot, entry.name));
            if (scannedPath && isPathInside(movieRoot, scannedPath)) {
              candidatePaths.add(scannedPath);
            }
          }
        } catch (_error) {
          // best-effort scan
        }
      }

      if (candidatePaths.size === 0) {
        return { attempted: 0, deleted: 0, failed: 0, paths: [] };
      }

      const deletedPaths = [];
      let failedCount = 0;
      for (const candidatePath of candidatePaths) {
        try {
          const inspection = inspectDeletionPath(candidatePath);
          if (!inspection.exists) {
            await this.removeJobOutputFolderFromJobs(normalizedOwnerJobIds, candidatePath);
            deletedPaths.push(candidatePath);
            continue;
          }
          if (inspection.isDirectory) {
            deleteFilesRecursively(inspection.path, false);
          } else if (inspection.isFile) {
            fs.unlinkSync(inspection.path);
          }
          await this.removeJobOutputFolderFromJobs(normalizedOwnerJobIds, candidatePath);
          deletedPaths.push(candidatePath);
        } catch (_error) {
          failedCount += 1;
        }
      }

      return {
        attempted: candidatePaths.size,
        deleted: deletedPaths.length,
        failed: failedCount,
        paths: deletedPaths
      };
    };
    const normalizedSelectedRawPaths = Array.isArray(options?.selectedRawPaths)
      ? options.selectedRawPaths
        .map((item) => String(item || '').trim())
        .filter(Boolean)
      : null;
    const normalizedSelectedMoviePaths = Array.isArray(options?.selectedMoviePaths)
      ? options.selectedMoviePaths
        .map((item) => String(item || '').trim())
        .filter(Boolean)
      : null;
    const normalizedSelectedJobIds = Array.isArray(options?.selectedJobIds)
      ? options.selectedJobIds
        .map((item) => normalizeJobIdValue(item))
        .filter(Boolean)
      : null;

    const includeRelated = Boolean(options?.includeRelated);
    if (!includeRelated) {
      const resolved = await this.getJobByIdOrReplacement(jobId);
      const existing = resolved?.job || null;
      const normalizedJobId = normalizeJobIdValue(resolved?.resolvedJobId || jobId);
      if (!existing) {
        const error = new Error('Job nicht gefunden.');
        error.statusCode = 404;
        throw error;
      }
      if (!normalizedJobId) {
        const error = new Error('Ungültige Job-ID.');
        error.statusCode = 400;
        throw error;
      }
      if (isDiskContainerRow(existing)) {
        const containerChildren = await this.listChildJobs(normalizedJobId);
        if (Array.isArray(containerChildren) && containerChildren.length > 0) {
          const error = new Error(
            'Container kann nicht einzeln gelöscht werden, solange noch Child-Jobs vorhanden sind.'
          );
          error.statusCode = 409;
          throw error;
        }
      }

      const cleanupDeletedJobRows = [existing];
      let emptyDirectoryCleanupContext = {
        settings: null,
        lineageArtifactsByJobId: new Map(),
        outputFoldersByJobId: new Map()
      };
      try {
        const [cleanupSettings, cleanupLineageArtifactsByJobId, cleanupOutputFoldersByJobId] = await Promise.all([
          settingsService.getSettingsMap(),
          this.listJobLineageArtifactsByJobIds([normalizedJobId]),
          this.listJobOutputFoldersByJobIds([normalizedJobId])
        ]);
        emptyDirectoryCleanupContext = {
          settings: cleanupSettings,
          lineageArtifactsByJobId: cleanupLineageArtifactsByJobId,
          outputFoldersByJobId: cleanupOutputFoldersByJobId
        };
      } catch (error) {
        logger.warn('job:delete:empty-dir-context-failed', {
          jobId: normalizedJobId,
          includeRelated: false,
          error: error?.message || String(error)
        });
      }

      let effectiveFileTarget = resolveEffectiveFileTarget(fileTarget, existing);
      let selectedRawPathsForDelete = normalizedSelectedRawPaths;
      let selectedMoviePathsForDelete = normalizedSelectedMoviePaths;
      let preview = null;
      let fileSummary = null;
      if (effectiveFileTarget === 'none') {
        preview = await this.getJobDeletePreview(normalizedJobId, { includeRelated: false });
        const autoIncompleteMoviePaths = collectIncompleteMoviePathsFromPreview(preview);
        const autoIncompleteRawPaths = collectIncompleteRawPathsFromPreview(preview, [existing]);
        if (autoIncompleteRawPaths.length > 0) {
          effectiveFileTarget = autoIncompleteMoviePaths.length > 0 ? 'both' : 'raw';
          if (!selectedRawPathsForDelete || selectedRawPathsForDelete.length === 0) {
            selectedRawPathsForDelete = autoIncompleteRawPaths;
          }
        }
        if (autoIncompleteMoviePaths.length > 0) {
          effectiveFileTarget = effectiveFileTarget === 'raw' ? 'both' : 'movie';
          if (!selectedMoviePathsForDelete || selectedMoviePathsForDelete.length === 0) {
            selectedMoviePathsForDelete = autoIncompleteMoviePaths;
          }
        }
      }
      if (effectiveFileTarget !== 'none') {
        if (!preview) {
          preview = await this.getJobDeletePreview(normalizedJobId, { includeRelated: false });
        }
        fileSummary = this._deletePathsFromPreview(preview, effectiveFileTarget, {
          selectedRawPaths: selectedRawPathsForDelete,
          selectedMoviePaths: selectedMoviePathsForDelete
        });
        if (fileSummary?.movie?.deleted) {
          await this.removeMissingJobOutputFoldersFromJobs([normalizedJobId]);
        }
      }

      const db = await getDb();
      const pipelineRow = await db.get(
        'SELECT state, active_job_id FROM pipeline_state WHERE id = 1'
      );

      const isActivePipelineJob = Number(pipelineRow?.active_job_id || 0) === Number(normalizedJobId);
      const runningStates = new Set(['ANALYZING', 'METADATA_LOOKUP', 'RIPPING', 'MEDIAINFO_CHECK', 'ENCODING', 'CD_ANALYZING', 'CD_RIPPING', 'CD_ENCODING']);

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
            [normalizedJobId]
          );
        }

        await db.run('DELETE FROM jobs WHERE id = ?', [normalizedJobId]);
        const stillExists = await db.get('SELECT id FROM jobs WHERE id = ?', [normalizedJobId]);
        if (stillExists) {
          const error = new Error(`Job #${normalizedJobId} konnte nicht aus der Datenbank entfernt werden.`);
          error.statusCode = 409;
          throw error;
        }
        await db.exec('COMMIT');
      } catch (error) {
        await db.exec('ROLLBACK');
        throw error;
      }

      await this.closeProcessLog(normalizedJobId);
      this._deleteProcessLogFile(normalizedJobId);
      thumbnailService.deleteThumbnail(normalizedJobId);
      const includeMovieCleanup = effectiveFileTarget === 'movie' || effectiveFileTarget === 'both';
      let incompleteCleanupSummary = null;
      if (includeMovieCleanup) {
        incompleteCleanupSummary = await cleanupIncompleteMovieFoldersForJobs([existing], [normalizedJobId]);
      }
      let emptyDirectoryCleanup = null;
      try {
        emptyDirectoryCleanup = await this._cleanupEmptyDirectoriesForDeletedJobs(
          cleanupDeletedJobRows,
          emptyDirectoryCleanupContext
        );
      } catch (error) {
        logger.warn('job:delete:empty-dir-cleanup-failed', {
          jobId: normalizedJobId,
          includeRelated: false,
          error: error?.message || String(error)
        });
      }

      logger.warn('job:deleted', {
        jobId: normalizedJobId,
        fileTarget: effectiveFileTarget,
        requestedFileTarget: fileTarget,
        includeRelated: false,
        pipelineStateReset: isActivePipelineJob,
        incompleteCleanup: incompleteCleanupSummary,
        emptyDirectoryCleanup,
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
        fileTarget: effectiveFileTarget,
        requestedFileTarget: fileTarget,
        includeRelated: false,
        deletedJobIds: [Number(normalizedJobId)],
        fileSummary,
        incompleteCleanup: incompleteCleanupSummary,
        emptyDirectoryCleanup
      };
    }

    const resolved = await this.getJobByIdOrReplacement(jobId);
    const existing = resolved?.job || null;
    const normalizedJobId = normalizeJobIdValue(resolved?.resolvedJobId || jobId);
    const preview = await this.getJobDeletePreview(normalizedJobId, {
      includeRelated: true,
      selectedJobIds: normalizedSelectedJobIds
    });
    let deleteJobIds = Array.isArray(preview?.selectedJobIds)
      ? preview.selectedJobIds
        .map((row) => normalizeJobIdValue(row))
        .filter(Boolean)
      : [];
    let rowById = new Map();
    const hasExplicitSelectedJobFilter = Array.isArray(normalizedSelectedJobIds);
    if (!hasExplicitSelectedJobFilter && normalizedJobId && !deleteJobIds.includes(normalizedJobId)) {
      deleteJobIds = [...deleteJobIds, normalizedJobId];
    }
    if (deleteJobIds.length > 0) {
      const db = await getDb();
      const placeholders = deleteJobIds.map(() => '?').join(', ');
      const rows = await db.all(
        `SELECT * FROM jobs WHERE id IN (${placeholders})`,
        deleteJobIds
      );
      rowById = new Map(
        (Array.isArray(rows) ? rows : [])
          .map((row) => [normalizeJobIdValue(row?.id), row])
          .filter(([id]) => Boolean(id))
      );
      const deleteSet = new Set(deleteJobIds);
      // Safety net: never delete a series container while it would still have
      // other children afterwards.
      for (const candidateId of [...deleteJobIds]) {
        const row = rowById.get(candidateId);
        if (!row || !isDiskContainerRow(row)) {
          continue;
        }
        const childRows = await db.all(
          `SELECT id FROM jobs WHERE parent_job_id = ?`,
          [candidateId]
        );
        const hasRemainingChildOutsideDeleteSet = (Array.isArray(childRows) ? childRows : []).some((childRow) => {
          const childId = normalizeJobIdValue(childRow?.id);
          return Boolean(childId && !deleteSet.has(childId));
        });
        if (hasRemainingChildOutsideDeleteSet) {
          deleteSet.delete(candidateId);
        }
      }
      deleteJobIds = Array.from(deleteSet);
    }
    if (deleteJobIds.length === 0) {
      const error = new Error('Keine löschbaren Historien-Einträge gefunden.');
      error.statusCode = 404;
      throw error;
    }

    const db = await getDb();
    const pipelineRow = await db.get('SELECT state, active_job_id FROM pipeline_state WHERE id = 1');
    const activePipelineJobId = normalizeJobIdValue(pipelineRow?.active_job_id);
    const activeJobIncluded = Boolean(activePipelineJobId && deleteJobIds.includes(activePipelineJobId));
    const runningStates = new Set(['ANALYZING', 'METADATA_LOOKUP', 'RIPPING', 'MEDIAINFO_CHECK', 'ENCODING', 'CD_ANALYZING', 'CD_RIPPING', 'CD_ENCODING']);
    if (activeJobIncluded && runningStates.has(String(pipelineRow?.state || ''))) {
      const error = new Error('Aktiver Pipeline-Job kann nicht gelöscht werden. Bitte zuerst abbrechen.');
      error.statusCode = 409;
      throw error;
    }

    const deletedJobRows = deleteJobIds
      .map((id) => rowById.get(id))
      .filter(Boolean);
    let emptyDirectoryCleanupContext = {
      settings: null,
      lineageArtifactsByJobId: new Map(),
      outputFoldersByJobId: new Map()
    };
    try {
      const [cleanupSettings, cleanupLineageArtifactsByJobId, cleanupOutputFoldersByJobId] = await Promise.all([
        settingsService.getSettingsMap(),
        this.listJobLineageArtifactsByJobIds(deleteJobIds),
        this.listJobOutputFoldersByJobIds(deleteJobIds)
      ]);
      emptyDirectoryCleanupContext = {
        settings: cleanupSettings,
        lineageArtifactsByJobId: cleanupLineageArtifactsByJobId,
        outputFoldersByJobId: cleanupOutputFoldersByJobId
      };
    } catch (error) {
      logger.warn('job:delete:empty-dir-context-failed', {
        jobId: normalizedJobId,
        includeRelated: true,
        deleteJobIds,
        error: error?.message || String(error)
      });
    }

    let effectiveFileTarget = resolveEffectiveFileTarget(fileTarget, existing);
    let selectedRawPathsForDelete = normalizedSelectedRawPaths;
    let selectedMoviePathsForDelete = normalizedSelectedMoviePaths;
    if (effectiveFileTarget === 'none') {
      const autoIncompleteMoviePaths = collectIncompleteMoviePathsFromPreview(preview);
      const selectedDeleteRows = deleteJobIds
        .map((id) => rowById.get(id))
        .filter(Boolean);
      const autoIncompleteRawPaths = collectIncompleteRawPathsFromPreview(preview, selectedDeleteRows);
      if (autoIncompleteRawPaths.length > 0) {
        effectiveFileTarget = autoIncompleteMoviePaths.length > 0 ? 'both' : 'raw';
        if (!selectedRawPathsForDelete || selectedRawPathsForDelete.length === 0) {
          selectedRawPathsForDelete = autoIncompleteRawPaths;
        }
      }
      if (autoIncompleteMoviePaths.length > 0) {
        effectiveFileTarget = effectiveFileTarget === 'raw' ? 'both' : 'movie';
        if (!selectedMoviePathsForDelete || selectedMoviePathsForDelete.length === 0) {
          selectedMoviePathsForDelete = autoIncompleteMoviePaths;
        }
      }
    }
    let fileSummary = null;
    if (effectiveFileTarget !== 'none') {
      fileSummary = this._deletePathsFromPreview(preview, effectiveFileTarget, {
        selectedRawPaths: selectedRawPathsForDelete,
        selectedMoviePaths: selectedMoviePathsForDelete
      });
      if (fileSummary?.movie?.deleted) {
        await this.removeMissingJobOutputFoldersFromJobs(deleteJobIds);
      }
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
      const deletedVerificationRows = await db.all(
        `SELECT id FROM jobs WHERE id IN (${deletePlaceholders})`,
        deleteJobIds
      );
      if (Array.isArray(deletedVerificationRows) && deletedVerificationRows.length > 0) {
        const remainingIds = deletedVerificationRows
          .map((row) => normalizeJobIdValue(row?.id))
          .filter(Boolean);
        const error = new Error(
          `Folgende Jobs konnten nicht gelöscht werden: ${remainingIds.join(', ')}`
        );
        error.statusCode = 409;
        throw error;
      }
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
    const includeMovieCleanup = effectiveFileTarget === 'movie' || effectiveFileTarget === 'both';
    let incompleteCleanupSummary = null;
    if (includeMovieCleanup) {
      incompleteCleanupSummary = await cleanupIncompleteMovieFoldersForJobs(deletedJobRows, deleteJobIds);
    }
    let emptyDirectoryCleanup = null;
    try {
      emptyDirectoryCleanup = await this._cleanupEmptyDirectoriesForDeletedJobs(
        deletedJobRows,
        emptyDirectoryCleanupContext
      );
    } catch (error) {
      logger.warn('job:delete:empty-dir-cleanup-failed', {
        jobId: normalizedJobId,
        includeRelated: true,
        deleteJobIds,
        error: error?.message || String(error)
      });
    }

    const deletedJobIdSet = new Set(deleteJobIds);
    const deletedJobs = Array.isArray(preview?.relatedJobs)
      ? preview.relatedJobs.filter((row) => deletedJobIdSet.has(normalizeJobIdValue(row?.id)))
      : [];

    logger.warn('job:deleted', {
      jobId: normalizedJobId,
      fileTarget: effectiveFileTarget,
      requestedFileTarget: fileTarget,
      includeRelated: true,
      deletedJobIds: deleteJobIds,
      deletedJobCount: deleteJobIds.length,
      pipelineStateReset: activeJobIncluded,
      incompleteCleanup: incompleteCleanupSummary,
      emptyDirectoryCleanup,
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
      fileTarget: effectiveFileTarget,
      requestedFileTarget: fileTarget,
      includeRelated: true,
      deletedJobIds: deleteJobIds,
      deletedJobs,
      fileSummary,
      incompleteCleanup: incompleteCleanupSummary,
      emptyDirectoryCleanup
    };
  }
}

module.exports = new HistoryService();
