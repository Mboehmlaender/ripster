const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { getDb } = require('../db/database');
const settingsService = require('./settingsService');
const historyService = require('./historyService');
const omdbService = require('./omdbService');
const musicBrainzService = require('./musicBrainzService');
const cdRipService = require('./cdRipService');
const scriptService = require('./scriptService');
const scriptChainService = require('./scriptChainService');
const runtimeActivityService = require('./runtimeActivityService');
const wsService = require('./websocketService');
const diskDetectionService = require('./diskDetectionService');
const notificationService = require('./notificationService');
const logger = require('./logger').child('PIPELINE');
const { spawnTrackedProcess } = require('./processRunner');
const { parseMakeMkvProgress, parseHandBrakeProgress } = require('../utils/progressParsers');
const { ensureDir, sanitizeFileName, renderTemplate, findMediaFiles } = require('../utils/files');
const { buildMediainfoReview } = require('../utils/encodePlan');
const { analyzePlaylistObfuscation, normalizePlaylistId } = require('../utils/playlistAnalysis');
const { errorToMeta } = require('../utils/errorMeta');
const userPresetService = require('./userPresetService');
const thumbnailService = require('./thumbnailService');

const RUNNING_STATES = new Set(['ANALYZING', 'RIPPING', 'ENCODING', 'MEDIAINFO_CHECK', 'CD_ANALYZING', 'CD_RIPPING', 'CD_ENCODING']);
const REVIEW_REFRESH_SETTING_PREFIXES = [
  'handbrake_',
  'mediainfo_',
  'makemkv_rip_',
  'makemkv_analyze_',
  'output_extension_',
  'output_template_'
];
const REVIEW_REFRESH_SETTING_KEYS = new Set([
  'makemkv_min_length_minutes',
  'handbrake_preset',
  'handbrake_extra_args',
  'mediainfo_extra_args',
  'makemkv_rip_mode',
  'makemkv_analyze_extra_args',
  'makemkv_rip_extra_args',
  'output_extension',
  'output_template'
]);
const QUEUE_ACTIONS = {
  START_PREPARED: 'START_PREPARED',
  START_CD: 'START_CD',
  RETRY: 'RETRY',
  REENCODE: 'REENCODE',
  RESTART_ENCODE: 'RESTART_ENCODE',
  RESTART_REVIEW: 'RESTART_REVIEW'
};
const QUEUE_ACTION_LABELS = {
  [QUEUE_ACTIONS.START_PREPARED]: 'Start',
  [QUEUE_ACTIONS.RETRY]: 'Retry Rippen',
  [QUEUE_ACTIONS.REENCODE]: 'RAW neu encodieren',
  [QUEUE_ACTIONS.RESTART_ENCODE]: 'Encode neu starten',
  [QUEUE_ACTIONS.RESTART_REVIEW]: 'Review neu berechnen',
  [QUEUE_ACTIONS.START_CD]: 'Audio CD starten'
};
const PRE_ENCODE_PROGRESS_RESERVE = 10;
const POST_ENCODE_PROGRESS_RESERVE = 10;
const POST_ENCODE_FINISH_BUFFER = 1;
const MIN_EXTENSIONLESS_DISC_IMAGE_BYTES = 256 * 1024 * 1024;
const MAKEMKV_BACKUP_FAILURE_MSG_CODES = new Set([5069, 5080]);
const RAW_INCOMPLETE_PREFIX = 'Incomplete_';
const RAW_RIP_COMPLETE_PREFIX = 'Rip_Complete_';
const RAW_FOLDER_STATES = Object.freeze({
  INCOMPLETE: 'incomplete',
  RIP_COMPLETE: 'rip_complete',
  COMPLETE: 'complete'
});

function nowIso() {
  return new Date().toISOString();
}

function normalizeCdTrackText(value) {
  return String(value || '')
    .normalize('NFC')
    // Keep umlauts/special letters, but strip heart symbols from imported metadata.
    .replace(/[♥❤♡❥❣❦❧]/gu, ' ')
    .replace(/\p{C}+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizePositiveInteger(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return Math.trunc(parsed);
}

function normalizeCdTrackPositionList(values = []) {
  const source = Array.isArray(values) ? values : [];
  const seen = new Set();
  const output = [];
  for (const value of source) {
    const normalized = normalizePositiveInteger(value);
    if (!normalized) {
      continue;
    }
    const key = String(normalized);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    output.push(normalized);
  }
  return output;
}

function parseCdTrackDurationSec(track = null) {
  const durationSec = Number(track?.durationSec);
  if (Number.isFinite(durationSec) && durationSec > 0) {
    return Math.max(0, Math.trunc(durationSec));
  }
  const durationMs = Number(track?.durationMs);
  if (Number.isFinite(durationMs) && durationMs > 0) {
    return Math.max(0, Math.round(durationMs / 1000));
  }
  return 0;
}

function buildCdLiveTrackRows(selectedTrackPositions = [], tocTracks = [], fallbackArtist = null) {
  const orderedPositions = normalizeCdTrackPositionList(selectedTrackPositions);
  const byPosition = new Map(
    (Array.isArray(tocTracks) ? tocTracks : [])
      .map((track) => {
        const position = normalizePositiveInteger(track?.position);
        if (!position) {
          return null;
        }
        return [position, track];
      })
      .filter(Boolean)
  );

  return orderedPositions.map((position, index) => {
    const track = byPosition.get(position) || {};
    return {
      order: index + 1,
      position,
      title: normalizeCdTrackText(track?.title) || `Track ${position}`,
      artist: normalizeCdTrackText(track?.artist) || normalizeCdTrackText(fallbackArtist) || '',
      durationSec: parseCdTrackDurationSec(track)
    };
  });
}

function buildCdLiveProgressSnapshot({
  trackRows = [],
  phase = 'rip',
  trackIndex = 0,
  trackTotal = null,
  trackPosition = null,
  ripCompletedCount = 0,
  encodeCompletedCount = 0,
  failedTrackPosition = null
}) {
  const rows = Array.isArray(trackRows) ? trackRows : [];
  const total = rows.length;
  const normalizedPhase = String(phase || '').trim().toLowerCase() === 'encode'
    ? 'encode'
    : 'rip';
  const normalizedTrackTotal = normalizePositiveInteger(trackTotal) || total;
  const normalizedTrackIndex = normalizePositiveInteger(trackIndex);
  const normalizedTrackPosition = normalizePositiveInteger(trackPosition);
  const normalizedFailedTrackPosition = normalizePositiveInteger(failedTrackPosition);
  const safeRipCompleted = Math.max(0, Math.min(total, Math.trunc(Number(ripCompletedCount) || 0)));
  const safeEncodeCompleted = Math.max(0, Math.min(total, Math.trunc(Number(encodeCompletedCount) || 0)));
  const selectedTrackPositions = rows.map((row) => row.position);
  const ripCompletedTrackPositions = selectedTrackPositions.slice(0, safeRipCompleted);
  const encodeCompletedTrackPositions = selectedTrackPositions.slice(0, safeEncodeCompleted);

  const trackStates = rows.map((row, index) => {
    const ripDone = index < safeRipCompleted;
    const encodeDone = index < safeEncodeCompleted;
    let ripStatus = ripDone ? 'done' : 'pending';
    let encodeStatus = encodeDone ? 'done' : 'pending';

    if (!ripDone && normalizedPhase === 'rip' && normalizedTrackPosition && row.position === normalizedTrackPosition) {
      ripStatus = 'in_progress';
    } else if (!ripDone && normalizedPhase === 'rip' && normalizedFailedTrackPosition && row.position === normalizedFailedTrackPosition) {
      ripStatus = 'error';
    }

    if (!encodeDone && normalizedPhase === 'encode' && normalizedTrackPosition && row.position === normalizedTrackPosition) {
      encodeStatus = 'in_progress';
    } else if (!encodeDone && normalizedPhase === 'encode' && normalizedFailedTrackPosition && row.position === normalizedFailedTrackPosition) {
      encodeStatus = 'error';
    }

    return {
      ...row,
      selected: true,
      ripStatus,
      encodeStatus
    };
  });

  return {
    phase: normalizedPhase,
    trackIndex: normalizedTrackIndex || 0,
    trackTotal: normalizedTrackTotal,
    trackPosition: normalizedTrackPosition || null,
    ripCompleted: safeRipCompleted,
    encodeCompleted: safeEncodeCompleted,
    selectedTrackPositions,
    ripCompletedTrackPositions,
    encodeCompletedTrackPositions,
    trackStates,
    updatedAt: nowIso()
  };
}

function normalizeMediaProfile(value) {
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

function isSpecificMediaProfile(value) {
  return value === 'bluray' || value === 'dvd' || value === 'cd';
}

function inferMediaProfileFromFsTypeAndModel(rawFsType, rawModel) {
  const fstype = String(rawFsType || '').trim().toLowerCase();
  const model = String(rawModel || '').trim().toLowerCase();
  const hasBlurayModelMarker = /(blu[\s-]?ray|bd[\s_-]?rom|bd-r|bd-re)/.test(model);
  const hasDvdModelMarker = /dvd/.test(model);
  const hasCdOnlyModelMarker = /(^|[\s_-])cd([\s_-]|$)|cd-?rom/.test(model) && !hasBlurayModelMarker && !hasDvdModelMarker;

  if (!fstype) {
    if (hasBlurayModelMarker) {
      return 'bluray';
    }
    if (hasDvdModelMarker) {
      return 'dvd';
    }
    return null;
  }

  if (fstype.includes('udf')) {
    // UDF is used by both DVDs (UDF 1.02) and Blu-rays (UDF 2.5/2.6).
    // Drive model alone (hasBlurayModelMarker) is not reliable: a BD-ROM drive
    // with a DVD inside would incorrectly be detected as Blu-ray.
    // Return null so the mountpoint BDMV/VIDEO_TS check can decide.
    if (hasBlurayModelMarker) {
      return null;
    }
    if (hasDvdModelMarker) {
      return 'dvd';
    }
    return 'dvd';
  }

  if (fstype.includes('iso9660') || fstype.includes('cdfs')) {
    // iso9660/cdfs is never used by Blu-ray discs (they use UDF 2.5/2.6).
    // Ignore hasBlurayModelMarker here – it only reflects drive capability.
    if (hasCdOnlyModelMarker) {
      return 'other';
    }
    return 'dvd';
  }

  return null;
}

function isLikelyExtensionlessDvdImageFile(filePath, knownSize = null) {
  if (path.extname(String(filePath || '')).toLowerCase() !== '') {
    return false;
  }

  let size = Number(knownSize);
  if (!Number.isFinite(size) || size < 0) {
    try {
      size = Number(fs.statSync(filePath).size || 0);
    } catch (_error) {
      return false;
    }
  }

  return size >= MIN_EXTENSIONLESS_DISC_IMAGE_BYTES;
}

function listTopLevelExtensionlessDvdImages(dirPath) {
  const sourceDir = String(dirPath || '').trim();
  if (!sourceDir) {
    return [];
  }

  let entries;
  try {
    entries = fs.readdirSync(sourceDir, { withFileTypes: true });
  } catch (_error) {
    return [];
  }

  const results = [];
  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }

    const absPath = path.join(sourceDir, entry.name);
    let stat;
    try {
      stat = fs.statSync(absPath);
    } catch (_error) {
      continue;
    }

    if (!isLikelyExtensionlessDvdImageFile(absPath, stat.size)) {
      continue;
    }

    results.push({
      path: absPath,
      size: Number(stat.size || 0)
    });
  }

  results.sort((a, b) => b.size - a.size || a.path.localeCompare(b.path));
  return results;
}

function inferMediaProfileFromRawPath(rawPath) {
  const source = String(rawPath || '').trim();
  if (!source) {
    return null;
  }
  try {
    const sourceStat = fs.statSync(source);
    if (sourceStat.isFile()) {
      if (isLikelyExtensionlessDvdImageFile(source, sourceStat.size)) {
        return 'dvd';
      }
      return null;
    }
  } catch (_error) {
    // ignore fs errors
  }

  const bdmvPath = path.join(source, 'BDMV');
  const bdmvStreamPath = path.join(bdmvPath, 'STREAM');
  try {
    if (fs.existsSync(bdmvStreamPath) || fs.existsSync(bdmvPath)) {
      return 'bluray';
    }
  } catch (_error) {
    // ignore fs errors
  }

  const videoTsPath = path.join(source, 'VIDEO_TS');
  try {
    if (fs.existsSync(videoTsPath)) {
      return 'dvd';
    }
  } catch (_error) {
    // ignore fs errors
  }

  if (listTopLevelExtensionlessDvdImages(source).length > 0) {
    return 'dvd';
  }

  return null;
}

function inferMediaProfileFromDeviceInfo(deviceInfo = null) {
  const device = deviceInfo && typeof deviceInfo === 'object'
    ? deviceInfo
    : null;
  if (!device) {
    return null;
  }

  const explicit = normalizeMediaProfile(
    device.mediaProfile || device.profile || device.type || null
  );
  if (explicit) {
    return explicit;
  }

  // Only use disc-specific fields for keyword detection, NOT device.model.
  // The drive model describes drive capability (e.g. "BD-ROM"), not disc type.
  // A BD-ROM drive with a DVD inserted would otherwise be misdetected as Blu-ray.
  const discMarkerText = [
    device.discLabel,
    device.label,
    device.fstype,
  ]
    .map((value) => String(value || '').trim().toLowerCase())
    .filter(Boolean)
    .join(' ');

  if (/(^|[\s_-])bdmv($|[\s_-])|blu[\s-]?ray|bd-rom|bd-r|bd-re/.test(discMarkerText)) {
    return 'bluray';
  }
  if (/(^|[\s_-])video_ts($|[\s_-])|dvd/.test(discMarkerText)) {
    return 'dvd';
  }

  const byFsTypeAndModel = inferMediaProfileFromFsTypeAndModel(device.fstype, device.model);
  if (byFsTypeAndModel) {
    return byFsTypeAndModel;
  }

  const mountpoint = String(device.mountpoint || '').trim();
  if (mountpoint) {
    try {
      if (fs.existsSync(path.join(mountpoint, 'BDMV'))) {
        return 'bluray';
      }
    } catch (_error) {
      // ignore fs errors
    }
    try {
      if (fs.existsSync(path.join(mountpoint, 'VIDEO_TS'))) {
        return 'dvd';
      }
    } catch (_error) {
      // ignore fs errors
    }
  }

  return null;
}

function fileTimestamp() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const h = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  const s = String(d.getSeconds()).padStart(2, '0');
  return `${y}${m}${day}-${h}${min}${s}`;
}

function withTimestampBeforeExtension(targetPath, suffix) {
  const dir = path.dirname(targetPath);
  const ext = path.extname(targetPath);
  const base = path.basename(targetPath, ext);
  return path.join(dir, `${base}_${suffix}${ext}`);
}

function resolveOutputTemplateValues(job, fallbackJobId = null) {
  return {
    title: job.title || job.detected_title || (fallbackJobId ? `job-${fallbackJobId}` : 'job'),
    year: job.year || new Date().getFullYear(),
    imdbId: job.imdb_id || (fallbackJobId ? `job-${fallbackJobId}` : 'noimdb')
  };
}

const DEFAULT_OUTPUT_TEMPLATE = '${title} (${year})/${title} (${year})';

function resolveOutputPathParts(settings, values) {
  const template = String(settings.output_template || DEFAULT_OUTPUT_TEMPLATE).trim()
    || DEFAULT_OUTPUT_TEMPLATE;
  const rendered = renderTemplate(template, values);
  const segments = rendered
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .replace(/^\/+|\/+$/g, '')
    .split('/')
    .map((seg) => sanitizeFileName(seg))
    .filter(Boolean);

  if (segments.length === 0) {
    return { folderPath: '', baseName: 'untitled' };
  }
  const baseName = segments[segments.length - 1];
  const folderParts = segments.slice(0, -1);
  return {
    folderPath: folderParts.length > 0 ? path.join(...folderParts) : '',
    baseName
  };
}

function buildFinalOutputPathFromJob(settings, job, fallbackJobId = null) {
  const movieDir = settings.movie_dir;
  const values = resolveOutputTemplateValues(job, fallbackJobId);
  const { folderPath, baseName } = resolveOutputPathParts(settings, values);
  const ext = String(settings.output_extension || 'mkv').trim() || 'mkv';
  if (folderPath) {
    return path.join(movieDir, folderPath, `${baseName}.${ext}`);
  }
  return path.join(movieDir, `${baseName}.${ext}`);
}

function buildIncompleteOutputPathFromJob(settings, job, fallbackJobId = null) {
  const movieDir = settings.movie_dir;
  const values = resolveOutputTemplateValues(job, fallbackJobId);
  const { baseName } = resolveOutputPathParts(settings, values);
  const ext = String(settings.output_extension || 'mkv').trim() || 'mkv';
  const numericJobId = Number(fallbackJobId || job?.id || 0);
  const incompleteFolder = Number.isFinite(numericJobId) && numericJobId > 0
    ? `Incomplete_job-${numericJobId}`
    : 'Incomplete_job-unknown';
  return path.join(movieDir, incompleteFolder, `${baseName}.${ext}`);
}

function ensureUniqueOutputPath(outputPath) {
  if (!fs.existsSync(outputPath)) {
    return outputPath;
  }

  const ts = fileTimestamp();
  let attempt = withTimestampBeforeExtension(outputPath, ts);
  let i = 1;
  while (fs.existsSync(attempt)) {
    attempt = withTimestampBeforeExtension(outputPath, `${ts}-${i}`);
    i += 1;
  }
  return attempt;
}

function chownRecursive(targetPath, ownerSpec) {
  const spec = String(ownerSpec || '').trim();
  if (!spec || !targetPath) {
    return;
  }
  try {
    const { spawnSync } = require('child_process');
    const result = spawnSync('chown', ['-R', spec, targetPath], { timeout: 15000 });
    if (result.status !== 0) {
      logger.warn('chown:failed', { targetPath, spec, stderr: String(result.stderr || '') });
    }
  } catch (error) {
    logger.warn('chown:error', { targetPath, spec, error: error?.message });
  }
}

function moveFileWithFallback(sourcePath, targetPath) {
  try {
    fs.renameSync(sourcePath, targetPath);
  } catch (error) {
    if (error?.code !== 'EXDEV') {
      throw error;
    }
    fs.copyFileSync(sourcePath, targetPath);
    fs.unlinkSync(sourcePath);
  }
}

function removeDirectoryIfEmpty(directoryPath) {
  try {
    const entries = fs.readdirSync(directoryPath);
    if (entries.length === 0) {
      fs.rmdirSync(directoryPath);
    }
  } catch (_error) {
    // Best effort cleanup.
  }
}

function finalizeOutputPathForCompletedEncode(incompleteOutputPath, preferredFinalOutputPath) {
  const sourcePath = String(incompleteOutputPath || '').trim();
  if (!sourcePath) {
    throw new Error('Encode-Finalisierung fehlgeschlagen: temporärer Output-Pfad fehlt.');
  }
  if (!fs.existsSync(sourcePath)) {
    throw new Error(`Encode-Finalisierung fehlgeschlagen: temporäre Datei fehlt (${sourcePath}).`);
  }

  const plannedTargetPath = String(preferredFinalOutputPath || '').trim();
  if (!plannedTargetPath) {
    throw new Error('Encode-Finalisierung fehlgeschlagen: finaler Output-Pfad fehlt.');
  }

  const sourceResolved = path.resolve(sourcePath);
  const targetPath = ensureUniqueOutputPath(plannedTargetPath);
  const targetResolved = path.resolve(targetPath);
  const outputPathWithTimestamp = targetPath !== plannedTargetPath;

  if (sourceResolved === targetResolved) {
    return {
      outputPath: targetPath,
      outputPathWithTimestamp
    };
  }

  ensureDir(path.dirname(targetPath));
  moveFileWithFallback(sourcePath, targetPath);
  removeDirectoryIfEmpty(path.dirname(sourcePath));

  return {
    outputPath: targetPath,
    outputPathWithTimestamp
  };
}

function truncateLine(value, max = 180) {
  const raw = String(value || '').replace(/\s+/g, ' ').trim();
  if (raw.length <= max) {
    return raw;
  }
  return `${raw.slice(0, max)}...`;
}

function extractProgressDetail(source, line) {
  const text = truncateLine(line, 220);
  if (!text) {
    return null;
  }

  if (source.startsWith('MAKEMKV')) {
    const prgc = text.match(/^PRGC:\d+,\d+,\"([^\"]+)\"/i);
    if (prgc) {
      return truncateLine(prgc[1], 160);
    }
    if (/Title\s+#?\d+/i.test(text)) {
      return text;
    }
    if (/copying|saving|writing|decrypt/i.test(text)) {
      return text;
    }
    if (/operation|progress|processing/i.test(text)) {
      return text;
    }
  }

  if (source === 'HANDBRAKE') {
    if (/Encoding:\s*task/i.test(text)) {
      return text;
    }
    if (/Muxing|work result|subtitle scan|frame/i.test(text)) {
      return text;
    }
  }

  return null;
}

function composeStatusText(stage, percent, detail) {
  const base = percent !== null && percent !== undefined
    ? `${stage} ${percent.toFixed(2)}%`
    : stage;

  if (detail) {
    return `${base} - ${detail}`;
  }

  return base;
}

function clampProgressPercent(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return Math.max(0, Math.min(100, parsed));
}

function composeEncodeScriptStatusText(percent, phase, itemType, index, total, label, statusWord = null) {
  const phaseLabel = phase === 'pre' ? 'Pre-Encode' : 'Post-Encode';
  const itemLabel = itemType === 'chain' ? 'Kette' : 'Skript';
  const position = Number.isFinite(index) && Number.isFinite(total) && total > 0
    ? ` ${index}/${total}`
    : '';
  const status = statusWord ? ` ${statusWord}` : '';
  const detail = String(label || '').trim();
  return `ENCODING ${percent.toFixed(2)}% - ${phaseLabel} ${itemLabel}${position}${status}${detail ? `: ${detail}` : ''}`;
}

function parseMakeMkvMessageCode(line) {
  const match = String(line || '').match(/\bMSG:(\d+),/i);
  if (!match) {
    return null;
  }
  const code = Number(match[1]);
  if (!Number.isFinite(code)) {
    return null;
  }
  return Math.trunc(code);
}

function isMakeMkvBackupFailureMarker(line) {
  const text = String(line || '').trim();
  if (!text) {
    return false;
  }
  const code = parseMakeMkvMessageCode(text);
  if (code !== null && MAKEMKV_BACKUP_FAILURE_MSG_CODES.has(code)) {
    return true;
  }
  return /backup\s+failed/i.test(text) || /backup\s+fehlgeschlagen/i.test(text);
}

function findMakeMkvBackupFailureMarker(lines) {
  if (!Array.isArray(lines)) {
    return null;
  }
  return lines.find((line) => isMakeMkvBackupFailureMarker(line)) || null;
}

function createEncodeScriptProgressTracker({
  jobId,
  preSteps = 0,
  postSteps = 0,
  updateProgress
}) {
  const preTotal = Math.max(0, Math.trunc(Number(preSteps) || 0));
  const postTotal = Math.max(0, Math.trunc(Number(postSteps) || 0));
  const hasPre = preTotal > 0;
  const hasPost = postTotal > 0;
  const preReserve = hasPre ? PRE_ENCODE_PROGRESS_RESERVE : 0;
  const postReserve = hasPost ? POST_ENCODE_PROGRESS_RESERVE : 0;
  const finalPercentBeforeFinish = hasPost ? (100 - POST_ENCODE_FINISH_BUFFER) : 100;
  const handBrakeStart = preReserve;
  const handBrakeEnd = Math.max(handBrakeStart, finalPercentBeforeFinish - postReserve);

  let preCompleted = 0;
  let postCompleted = 0;

  const clampPhasePercent = (value) => {
    const clamped = clampProgressPercent(value);
    if (clamped === null) {
      return 0;
    }
    return Number(clamped.toFixed(2));
  };

  const calculatePrePercent = () => {
    if (preTotal <= 0) {
      return clampPhasePercent(handBrakeStart);
    }
    return clampPhasePercent((preCompleted / preTotal) * preReserve);
  };

  const calculatePostPercent = () => {
    if (postTotal <= 0) {
      return clampPhasePercent(handBrakeEnd);
    }
    return clampPhasePercent(handBrakeEnd + ((postCompleted / postTotal) * postReserve));
  };

  const callProgress = async (percent, statusText) => {
    if (typeof updateProgress !== 'function') {
      return;
    }
    await updateProgress('ENCODING', percent, null, statusText, jobId);
  };

  return {
    hasScriptSteps: hasPre || hasPost,
    handBrakeStart,
    handBrakeEnd,

    mapHandBrakePercent(percent) {
      if (!this.hasScriptSteps) {
        return percent;
      }
      const normalized = clampProgressPercent(percent);
      if (normalized === null) {
        return percent;
      }
      const ratio = normalized / 100;
      return clampPhasePercent(handBrakeStart + ((handBrakeEnd - handBrakeStart) * ratio));
    },

    async onStepStart(phase, itemType, index, total, label) {
      if (phase === 'pre' && preTotal <= 0) {
        return;
      }
      if (phase === 'post' && postTotal <= 0) {
        return;
      }
      const percent = phase === 'pre'
        ? calculatePrePercent()
        : calculatePostPercent();
      await callProgress(percent, composeEncodeScriptStatusText(percent, phase, itemType, index, total, label, 'startet'));
    },

    async onStepComplete(phase, itemType, index, total, label, success = true) {
      if (phase === 'pre' && preTotal <= 0) {
        return;
      }
      if (phase === 'post' && postTotal <= 0) {
        return;
      }

      if (phase === 'pre') {
        preCompleted = Math.min(preTotal, preCompleted + 1);
      } else {
        postCompleted = Math.min(postTotal, postCompleted + 1);
      }

      const percent = phase === 'pre'
        ? calculatePrePercent()
        : calculatePostPercent();
      await callProgress(
        percent,
        composeEncodeScriptStatusText(
          percent,
          phase,
          itemType,
          index,
          total,
          label,
          success ? 'OK' : 'Fehler'
        )
      );
    }
  };
}

function shouldKeepHighlight(line) {
  return /error|fail|warn|fehl|title\s+#|saving|encoding:|muxing|copying|decrypt/i.test(line)
    || isMakeMkvBackupFailureMarker(line);
}

function normalizeNonNegativeInteger(rawValue) {
  if (rawValue === null || rawValue === undefined) {
    return null;
  }
  if (typeof rawValue === 'string' && rawValue.trim() === '') {
    return null;
  }
  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return null;
  }
  return Math.trunc(parsed);
}

function parseDetectedTitle(lines) {
  const candidates = [];
  const blockedPatterns = [
    /evaluierungsversion/i,
    /evaluation version/i,
    /es verbleiben noch/i,
    /days remaining/i,
    /makemkv/i,
    /www\./i,
    /beta/i
  ];

  const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();

  for (const line of lines) {
    const cinfoMatch = line.match(/CINFO:2,0,"([^"]+)"/i);
    if (cinfoMatch) {
      candidates.push(cinfoMatch[1]);
    }

    const tinfoMatch = line.match(/TINFO:\d+,2,\d+,"([^"]+)"/i);
    if (tinfoMatch) {
      candidates.push(tinfoMatch[1]);
    }
  }

  const clean = candidates
    .map(normalize)
    .filter((value) => value.length > 2 && !value.startsWith('/'))
    .filter((value) => !blockedPatterns.some((pattern) => pattern.test(value)))
    .filter((value) => !/^disc\s*\d*$/i.test(value))
    .filter((value) => !/^unknown/i.test(value));

  if (clean.length === 0) {
    return null;
  }

  clean.sort((a, b) => b.length - a.length);
  return clean[0];
}

function parseMediainfoJsonOutput(rawOutput) {
  const text = String(rawOutput || '').trim();
  if (!text) {
    return null;
  }

  const extractJsonObjects = (value) => {
    const source = String(value || '');
    const objects = [];
    let start = -1;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = 0; i < source.length; i += 1) {
      const ch = source[i];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (ch === '\\') {
          escaped = true;
        } else if (ch === '"') {
          inString = false;
        }
        continue;
      }

      if (ch === '"') {
        inString = true;
        continue;
      }
      if (ch === '{') {
        if (depth === 0) {
          start = i;
        }
        depth += 1;
        continue;
      }
      if (ch === '}' && depth > 0) {
        depth -= 1;
        if (depth === 0 && start >= 0) {
          objects.push(source.slice(start, i + 1));
          start = -1;
        }
      }
    }
    return objects;
  };

  const parsedObjects = [];
  const rawObjects = extractJsonObjects(text);
  for (const candidate of rawObjects) {
    try {
      parsedObjects.push(JSON.parse(candidate));
    } catch (_error) {
      // ignore malformed blocks and continue
    }
  }

  if (parsedObjects.length === 0) {
    try {
      return JSON.parse(text);
    } catch (_error) {
      return null;
    }
  }

  const hasTitleList = (entry) =>
    Array.isArray(entry?.TitleList)
    || Array.isArray(entry?.Scan?.TitleList)
    || Array.isArray(entry?.title_list);

  const hasMediaTrack = (entry) =>
    Array.isArray(entry?.media?.track)
    || Array.isArray(entry?.Media?.track);

  const getTitleList = (entry) => {
    if (Array.isArray(entry?.TitleList)) {
      return entry.TitleList;
    }
    if (Array.isArray(entry?.Scan?.TitleList)) {
      return entry.Scan.TitleList;
    }
    if (Array.isArray(entry?.title_list)) {
      return entry.title_list;
    }
    return [];
  };

  const titleSets = parsedObjects
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => hasTitleList(entry))
    .map(({ entry, index }) => {
      const titles = getTitleList(entry);
      let audioTracks = 0;
      let subtitleTracks = 0;
      let validAudioTracks = 0;
      let validSubtitleTracks = 0;

      for (const title of titles) {
        const audioList = Array.isArray(title?.AudioList) ? title.AudioList : [];
        const subtitleList = Array.isArray(title?.SubtitleList) ? title.SubtitleList : [];
        audioTracks += audioList.length;
        subtitleTracks += subtitleList.length;
        validAudioTracks += audioList.filter((track) => Number.isFinite(Number(track?.TrackNumber)) && Number(track.TrackNumber) > 0).length;
        validSubtitleTracks += subtitleList.filter((track) => Number.isFinite(Number(track?.TrackNumber)) && Number(track.TrackNumber) > 0).length;
      }

      return {
        entry,
        index,
        titleCount: titles.length,
        audioTracks,
        subtitleTracks,
        validAudioTracks,
        validSubtitleTracks
      };
    });

  if (titleSets.length > 0) {
    titleSets.sort((a, b) =>
      b.validAudioTracks - a.validAudioTracks
      || b.validSubtitleTracks - a.validSubtitleTracks
      || b.audioTracks - a.audioTracks
      || b.subtitleTracks - a.subtitleTracks
      || b.titleCount - a.titleCount
      || b.index - a.index
    );
    return titleSets[0].entry;
  }

  const mediaSets = parsedObjects
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => hasMediaTrack(entry))
    .map(({ entry, index }) => {
      const tracks = Array.isArray(entry?.media?.track)
        ? entry.media.track
        : (Array.isArray(entry?.Media?.track) ? entry.Media.track : []);
      return {
        entry,
        index,
        trackCount: tracks.length
      };
    });

  if (mediaSets.length > 0) {
    mediaSets.sort((a, b) => b.trackCount - a.trackCount || b.index - a.index);
    return mediaSets[0].entry;
  }

  return parsedObjects[parsedObjects.length - 1] || null;
}

function getMediaInfoTrackList(mediaInfoJson) {
  if (Array.isArray(mediaInfoJson?.media?.track)) {
    return mediaInfoJson.media.track;
  }
  if (Array.isArray(mediaInfoJson?.Media?.track)) {
    return mediaInfoJson.Media.track;
  }
  return [];
}

function countMediaInfoTrackTypes(mediaInfoJson) {
  const tracks = getMediaInfoTrackList(mediaInfoJson);
  let audioCount = 0;
  let subtitleCount = 0;
  for (const track of tracks) {
    const type = String(track?.['@type'] || '').trim().toLowerCase();
    if (type === 'audio') {
      audioCount += 1;
      continue;
    }
    if (type === 'text' || type === 'subtitle') {
      subtitleCount += 1;
    }
  }
  return {
    audioCount,
    subtitleCount
  };
}

function shouldRunDvdTrackFallback(parsedMediaInfo, mediaProfile, inputPath) {
  if (normalizeMediaProfile(mediaProfile) !== 'dvd') {
    return false;
  }
  if (path.extname(String(inputPath || '')).toLowerCase() !== '') {
    return false;
  }
  const counts = countMediaInfoTrackTypes(parsedMediaInfo);
  return counts.audioCount === 0 && counts.subtitleCount === 0;
}

function parseHmsDurationToSeconds(raw) {
  const value = String(raw || '').trim();
  if (!value) {
    return 0;
  }
  const match = value.match(/^(\d{1,2}):(\d{2}):(\d{2})(?:\.\d+)?$/);
  if (!match) {
    return 0;
  }
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes) || !Number.isFinite(seconds)) {
    return 0;
  }
  return (hours * 3600) + (minutes * 60) + seconds;
}

function parseHandBrakeDurationSeconds(rawDuration) {
  if (rawDuration && typeof rawDuration === 'object') {
    const hours = Number(rawDuration.Hours ?? rawDuration.hours ?? 0);
    const minutes = Number(rawDuration.Minutes ?? rawDuration.minutes ?? 0);
    const seconds = Number(rawDuration.Seconds ?? rawDuration.seconds ?? 0);
    if (Number.isFinite(hours) && Number.isFinite(minutes) && Number.isFinite(seconds)) {
      return Math.max(0, Math.trunc((hours * 3600) + (minutes * 60) + seconds));
    }
  }

  const parsedHms = parseHmsDurationToSeconds(rawDuration);
  if (parsedHms > 0) {
    return parsedHms;
  }

  const asNumber = Number(rawDuration);
  if (Number.isFinite(asNumber) && asNumber > 0) {
    return Math.max(0, Math.trunc(asNumber));
  }

  return 0;
}

function formatDurationClock(seconds) {
  const total = Number(seconds || 0);
  if (!Number.isFinite(total) || total <= 0) {
    return null;
  }
  const rounded = Math.max(0, Math.trunc(total));
  const h = Math.floor(rounded / 3600);
  const m = Math.floor((rounded % 3600) / 60);
  const s = rounded % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function normalizeTrackLanguage(raw) {
  const value = String(raw || '').trim();
  if (!value) {
    return 'und';
  }
  return value.toLowerCase().slice(0, 3);
}

function normalizePositiveTrackId(rawValue) {
  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return Math.trunc(parsed);
}

function isLikelyForcedSubtitleTrack(track) {
  const text = [
    track?.title,
    track?.description,
    track?.name,
    track?.format,
    track?.label
  ]
    .map((value) => String(value || '').trim().toLowerCase())
    .filter(Boolean)
    .join(' ');
  if (!text) {
    return false;
  }
  if (/\bnot forced\b/.test(text)) {
    return false;
  }
  return (
    /\bforced(?:\s+only)?\b/.test(text)
    || /nur\s+erzwungen/.test(text)
    || /\berzwungen\b/.test(text)
  );
}

function annotateSubtitleForcedAvailability(handBrakeSubtitleTracks, makeMkvSubtitleTracks) {
  const hbTracks = Array.isArray(handBrakeSubtitleTracks) ? handBrakeSubtitleTracks : [];
  if (hbTracks.length === 0) {
    return [];
  }

  const mkTracks = Array.isArray(makeMkvSubtitleTracks) ? makeMkvSubtitleTracks : [];
  const forcedSourceIdsByLanguage = new Map();

  for (const track of mkTracks) {
    if (!isLikelyForcedSubtitleTrack(track)) {
      continue;
    }
    const language = normalizeTrackLanguage(track?.language || track?.languageLabel || 'und');
    const sourceTrackId = normalizePositiveTrackId(track?.sourceTrackId ?? track?.id);
    if (!sourceTrackId) {
      continue;
    }
    if (!forcedSourceIdsByLanguage.has(language)) {
      forcedSourceIdsByLanguage.set(language, []);
    }
    const list = forcedSourceIdsByLanguage.get(language);
    if (!list.includes(sourceTrackId)) {
      list.push(sourceTrackId);
    }
  }

  return hbTracks.map((track) => {
    const language = normalizeTrackLanguage(track?.language || track?.languageLabel || 'und');
    const forcedSourceTrackIds = normalizeTrackIdList(forcedSourceIdsByLanguage.get(language) || []);
    const forcedTrack = isLikelyForcedSubtitleTrack(track);
    return {
      ...track,
      forcedTrack,
      forcedAvailable: forcedTrack || forcedSourceTrackIds.length > 0,
      forcedSourceTrackIds
    };
  });
}

function enrichTitleInfoWithForcedSubtitleAvailability(titleInfo, makeMkvSubtitleTracks) {
  if (!titleInfo || typeof titleInfo !== 'object') {
    return titleInfo;
  }
  return {
    ...titleInfo,
    subtitleTracks: annotateSubtitleForcedAvailability(
      Array.isArray(titleInfo?.subtitleTracks) ? titleInfo.subtitleTracks : [],
      makeMkvSubtitleTracks
    )
  };
}

function pickScanTitleList(scanJson) {
  if (!scanJson || typeof scanJson !== 'object') {
    return [];
  }

  const direct = Array.isArray(scanJson.TitleList) ? scanJson.TitleList : null;
  if (direct) {
    return direct;
  }

  const scanNode = scanJson.Scan && typeof scanJson.Scan === 'object' ? scanJson.Scan : null;
  if (scanNode) {
    const scanTitles = Array.isArray(scanNode.TitleList) ? scanNode.TitleList : null;
    if (scanTitles) {
      return scanTitles;
    }
  }

  const alt = Array.isArray(scanJson.title_list) ? scanJson.title_list : null;
  return alt || [];
}

function resolvePlaylistInfoFromAnalysis(playlistAnalysis, playlistIdRaw) {
  const playlistId = normalizePlaylistId(playlistIdRaw);
  if (!playlistId || !playlistAnalysis) {
    return {
      playlistId: playlistId || null,
      playlistFile: playlistId ? `${playlistId}.mpls` : null,
      recommended: false,
      evaluationLabel: null,
      segmentCommand: playlistId ? `strings BDMV/PLAYLIST/${playlistId}.mpls | grep m2ts` : null,
      segmentFiles: []
    };
  }

  const recommended = normalizePlaylistId(playlistAnalysis?.recommendation?.playlistId) === playlistId;
  const evaluated = (Array.isArray(playlistAnalysis?.evaluatedCandidates) ? playlistAnalysis.evaluatedCandidates : [])
    .find((item) => normalizePlaylistId(item?.playlistId) === playlistId) || null;
  const segmentMap = playlistAnalysis.playlistSegments && typeof playlistAnalysis.playlistSegments === 'object'
    ? playlistAnalysis.playlistSegments
    : {};
  const segmentEntry = segmentMap[playlistId] || segmentMap[`${playlistId}.mpls`] || null;
  const segmentFiles = Array.isArray(segmentEntry?.segmentFiles)
    ? segmentEntry.segmentFiles.filter((item) => String(item || '').trim().length > 0)
    : [];

  return {
    playlistId,
    playlistFile: `${playlistId}.mpls`,
    recommended,
    evaluationLabel: evaluated?.evaluationLabel || (recommended ? 'wahrscheinlich korrekt (Heuristik)' : null),
    segmentCommand: segmentEntry?.segmentCommand || `strings BDMV/PLAYLIST/${playlistId}.mpls | grep m2ts`,
    segmentFiles
  };
}

function normalizeScanTrackId(rawValue, fallbackIndex) {
  const parsed = Number(rawValue);
  if (Number.isFinite(parsed) && parsed > 0) {
    return Math.trunc(parsed);
  }
  return Math.max(1, Math.trunc(fallbackIndex) + 1);
}

function parseSizeToBytes(rawValue) {
  const text = String(rawValue || '').trim();
  if (!text) {
    return 0;
  }

  if (/^\d+$/.test(text)) {
    const numeric = Number(text);
    if (Number.isFinite(numeric) && numeric > 0) {
      return Math.trunc(numeric);
    }
  }

  const match = text.match(/([0-9]+(?:[.,][0-9]+)?)\s*([kmgt]?b)/i);
  if (!match) {
    return 0;
  }

  const value = Number(String(match[1]).replace(',', '.'));
  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }

  const unit = String(match[2] || 'b').toLowerCase();
  const factorMap = {
    b: 1,
    kb: 1024,
    mb: 1024 ** 2,
    gb: 1024 ** 3,
    tb: 1024 ** 4
  };
  const factor = factorMap[unit] || 1;
  return Math.max(0, Math.trunc(value * factor));
}

function parseMakeMkvDurationSeconds(rawValue) {
  const hms = parseHmsDurationToSeconds(rawValue);
  if (hms > 0) {
    return hms;
  }

  const text = String(rawValue || '').trim();
  if (!text) {
    return 0;
  }

  const hours = Number((text.match(/(\d+)\s*h/i) || [])[1] || 0);
  const minutes = Number((text.match(/(\d+)\s*m/i) || [])[1] || 0);
  const seconds = Number((text.match(/(\d+)\s*s/i) || [])[1] || 0);
  if (hours || minutes || seconds) {
    return (hours * 3600) + (minutes * 60) + seconds;
  }

  const numeric = Number(text);
  if (Number.isFinite(numeric) && numeric > 0) {
    return Math.trunc(numeric);
  }

  return 0;
}

function buildSyntheticMediaInfoFromMakeMkvTitle(titleInfo) {
  const durationSeconds = Math.max(0, Math.trunc(Number(titleInfo?.durationSeconds || 0)));
  const tracks = [];
  tracks.push({
    '@type': 'General',
    // MediaInfo reports numeric Duration as milliseconds. Keep this format so
    // parseDurationSeconds() does not misinterpret long titles.
    Duration: String(durationSeconds * 1000),
    Duration_String3: formatDurationClock(durationSeconds) || null
  });

  const audioTracks = Array.isArray(titleInfo?.audioTracks) ? titleInfo.audioTracks : [];
  const subtitleTracks = Array.isArray(titleInfo?.subtitleTracks) ? titleInfo.subtitleTracks : [];

  for (const track of audioTracks) {
    tracks.push({
      '@type': 'Audio',
      ID: String(track?.sourceTrackId ?? track?.id ?? ''),
      Language: track?.language || 'und',
      Language_String3: track?.language || 'und',
      Title: track?.title || null,
      Format: track?.codecName || track?.format || null,
      Channels: track?.channels || null
    });
  }

  for (const track of subtitleTracks) {
    tracks.push({
      '@type': 'Text',
      ID: String(track?.sourceTrackId ?? track?.id ?? ''),
      Language: track?.language || 'und',
      Language_String3: track?.language || 'und',
      Title: track?.title || null,
      Format: track?.format || null
    });
  }

  return {
    media: {
      track: tracks
    }
  };
}

function remapReviewTrackIdsToSourceIds(review) {
  if (!review || !Array.isArray(review.titles)) {
    return review;
  }

  const normalizeSourceId = (track) => {
    const normalized = normalizeTrackIdList([track?.sourceTrackId ?? track?.id])[0] || null;
    return normalized;
  };

  const titles = review.titles.map((title) => ({
    ...title,
    audioTracks: (Array.isArray(title?.audioTracks) ? title.audioTracks : []).map((track) => {
      const sourceTrackId = normalizeSourceId(track);
      return {
        ...track,
        id: sourceTrackId || track?.id || null,
        sourceTrackId: sourceTrackId || track?.sourceTrackId || track?.id || null
      };
    }),
    subtitleTracks: (Array.isArray(title?.subtitleTracks) ? title.subtitleTracks : []).map((track) => {
      const sourceTrackId = normalizeSourceId(track);
      return {
        ...track,
        id: sourceTrackId || track?.id || null,
        sourceTrackId: sourceTrackId || track?.sourceTrackId || track?.id || null
      };
    })
  }));

  return {
    ...review,
    titles
  };
}

function extractPlaylistIdFromHandBrakeTitle(title) {
  const directCandidates = [
    title?.Playlist,
    title?.playlist,
    title?.PlaylistName,
    title?.playlistName,
    title?.SourcePlaylist,
    title?.sourcePlaylist
  ];
  for (const candidate of directCandidates) {
    const normalized = normalizePlaylistId(candidate);
    if (normalized) {
      return normalized;
    }
  }

  const textCandidates = [
    title?.Path,
    title?.path,
    title?.Name,
    title?.name,
    title?.File,
    title?.file,
    title?.TitleName,
    title?.titleName,
    title?.SourceName,
    title?.sourceName
  ];
  for (const candidate of textCandidates) {
    const text = String(candidate || '').trim();
    if (!text) {
      continue;
    }
    const match = text.match(/(\d{1,5})\.mpls\b/i);
    if (!match) {
      continue;
    }
    const normalized = normalizePlaylistId(match[1]);
    if (normalized) {
      return normalized;
    }
  }

  return null;
}

function parseHandBrakeScanSizeBytes(title) {
  const numeric = Number(title?.Size?.Bytes ?? title?.Bytes ?? 0);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return 0;
  }
  return Math.trunc(numeric);
}

function buildHandBrakeScanTitleRows(scanJson) {
  const titleList = pickScanTitleList(scanJson);
  return titleList
    .map((title, idx) => {
      const handBrakeTitleId = normalizeScanTrackId(
        title?.Index ?? title?.index ?? title?.Title ?? title?.title,
        idx
      );
      const playlist = extractPlaylistIdFromHandBrakeTitle(title);
      const durationSeconds = parseHandBrakeDurationSeconds(
        title?.Duration ?? title?.duration ?? title?.Length ?? title?.length
      );
      const sizeBytes = parseHandBrakeScanSizeBytes(title);
      const audioTrackCount = Array.isArray(title?.AudioList) ? title.AudioList.length : 0;
      const subtitleTrackCount = Array.isArray(title?.SubtitleList) ? title.SubtitleList.length : 0;
      return {
        handBrakeTitleId,
        playlist,
        durationSeconds,
        sizeBytes,
        audioTrackCount,
        subtitleTrackCount
      };
    })
    .filter((item) => Number.isFinite(item.handBrakeTitleId) && item.handBrakeTitleId > 0);
}

function listAvailableHandBrakePlaylists(scanJson) {
  const rows = buildHandBrakeScanTitleRows(scanJson);
  return Array.from(new Set(
    rows
      .map((item) => normalizePlaylistId(item?.playlist))
      .filter(Boolean)
  )).sort();
}

function resolveHandBrakeTitleIdForPlaylist(scanJson, playlistIdRaw, options = {}) {
  const playlistId = normalizePlaylistId(playlistIdRaw);
  if (!playlistId) {
    return null;
  }

  const expectedMakemkvTitleIdRaw = Number(options?.expectedMakemkvTitleId);
  const expectedMakemkvTitleId = Number.isFinite(expectedMakemkvTitleIdRaw) && expectedMakemkvTitleIdRaw >= 0
    ? Math.trunc(expectedMakemkvTitleIdRaw)
    : null;
  const expectedDurationRaw = Number(options?.expectedDurationSeconds);
  const expectedDurationSeconds = Number.isFinite(expectedDurationRaw) && expectedDurationRaw > 0
    ? Math.trunc(expectedDurationRaw)
    : null;
  const expectedSizeRaw = Number(options?.expectedSizeBytes);
  const expectedSizeBytes = Number.isFinite(expectedSizeRaw) && expectedSizeRaw > 0
    ? Math.trunc(expectedSizeRaw)
    : null;
  const durationToleranceRaw = Number(options?.durationToleranceSeconds);
  const durationToleranceSeconds = Number.isFinite(durationToleranceRaw) && durationToleranceRaw >= 0
    ? Math.trunc(durationToleranceRaw)
    : 5;

  const rows = buildHandBrakeScanTitleRows(scanJson);
  const matches = rows.filter((item) => item.playlist === playlistId);

  const scoreForExpected = (row) => {
    const durationDelta = expectedDurationSeconds !== null
      ? Math.abs(Number(row?.durationSeconds || 0) - expectedDurationSeconds)
      : Number.MAX_SAFE_INTEGER;
    const sizeDelta = expectedSizeBytes !== null
      ? Math.abs(Number(row?.sizeBytes || 0) - expectedSizeBytes)
      : Number.MAX_SAFE_INTEGER;
    const trackRichness = Number(row?.audioTrackCount || 0) + Number(row?.subtitleTrackCount || 0);
    return {
      row,
      durationDelta,
      sizeDelta,
      trackRichness
    };
  };

  const sortByExpectedScore = (a, b) =>
    a.durationDelta - b.durationDelta
    || a.sizeDelta - b.sizeDelta
    || b.trackRichness - a.trackRichness
    || b.row.durationSeconds - a.row.durationSeconds
    || b.row.sizeBytes - a.row.sizeBytes
    || a.row.handBrakeTitleId - b.row.handBrakeTitleId;

  if (matches.length > 0) {
    if (expectedDurationSeconds !== null || expectedSizeBytes !== null) {
      const scored = matches.map(scoreForExpected).sort(sortByExpectedScore);
      if (expectedDurationSeconds !== null) {
        const withinTolerance = scored.filter((item) => item.durationDelta <= durationToleranceSeconds);
        if (withinTolerance.length > 0) {
          return withinTolerance[0].row.handBrakeTitleId;
        }
      }
      return scored[0].row.handBrakeTitleId;
    }
    const best = matches.sort((a, b) =>
      b.durationSeconds - a.durationSeconds
      || b.sizeBytes - a.sizeBytes
      || a.handBrakeTitleId - b.handBrakeTitleId
    )[0];
    return best?.handBrakeTitleId || null;
  }

  // Fallback 1: choose closest duration/size if playlist metadata is absent in scan JSON.
  if ((expectedDurationSeconds !== null || expectedSizeBytes !== null) && rows.length > 0) {
    const scored = rows.map(scoreForExpected).sort(sortByExpectedScore);
    if (expectedDurationSeconds !== null) {
      const withinTolerance = scored.filter((item) => item.durationDelta <= durationToleranceSeconds);
      if (withinTolerance.length > 0) {
        return withinTolerance[0].row.handBrakeTitleId;
      }
    }
    return scored[0].row.handBrakeTitleId;
  }

  // Fallback 2: map MakeMKV title-id to HandBrake title-id if ordering matches.
  if (expectedMakemkvTitleId !== null) {
    const byPlusOne = rows.find((item) => item.handBrakeTitleId === (expectedMakemkvTitleId + 1));
    if (byPlusOne) {
      return byPlusOne.handBrakeTitleId;
    }
    const byEqual = rows.find((item) => item.handBrakeTitleId === expectedMakemkvTitleId);
    if (byEqual) {
      return byEqual.handBrakeTitleId;
    }
  }

  if (rows.length === 1) {
    return rows[0].handBrakeTitleId;
  }

  return null;
}

function isHandBrakePlaylistCacheEntryCompatible(entry, playlistIdRaw, options = {}) {
  const playlistId = normalizePlaylistId(playlistIdRaw);
  if (!playlistId) {
    return false;
  }
  if (!entry || typeof entry !== 'object') {
    return false;
  }
  const handBrakeTitleId = Number(entry?.handBrakeTitleId);
  if (!Number.isFinite(handBrakeTitleId) || handBrakeTitleId <= 0) {
    return false;
  }
  const titleInfo = entry?.titleInfo && typeof entry.titleInfo === 'object' ? entry.titleInfo : null;
  if (!titleInfo) {
    return false;
  }

  const cachedPlaylistId = normalizePlaylistId(titleInfo?.playlistId || null);
  if (cachedPlaylistId && cachedPlaylistId !== playlistId) {
    return false;
  }

  const expectedDurationRaw = Number(options?.expectedDurationSeconds);
  const expectedDurationSeconds = Number.isFinite(expectedDurationRaw) && expectedDurationRaw > 0
    ? Math.trunc(expectedDurationRaw)
    : null;
  const cachedDurationRaw = Number(titleInfo?.durationSeconds);
  const cachedDurationSeconds = Number.isFinite(cachedDurationRaw) && cachedDurationRaw > 0
    ? Math.trunc(cachedDurationRaw)
    : null;
  if (expectedDurationSeconds !== null && cachedDurationSeconds !== null) {
    // Reject clearly wrong cache mappings (e.g. 30s instead of 6681s movie title).
    if (Math.abs(expectedDurationSeconds - cachedDurationSeconds) > 120) {
      return false;
    }
  }

  const expectedSizeRaw = Number(options?.expectedSizeBytes);
  const expectedSizeBytes = Number.isFinite(expectedSizeRaw) && expectedSizeRaw > 0
    ? Math.trunc(expectedSizeRaw)
    : null;
  const cachedSizeRaw = Number(titleInfo?.sizeBytes);
  const cachedSizeBytes = Number.isFinite(cachedSizeRaw) && cachedSizeRaw > 0
    ? Math.trunc(cachedSizeRaw)
    : null;
  if (expectedSizeBytes !== null && cachedSizeBytes !== null) {
    const delta = Math.abs(expectedSizeBytes - cachedSizeBytes);
    if (delta > (512 * 1024 * 1024)) {
      return false;
    }
  }

  return true;
}

function normalizeCodecNumber(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return null;
  }
  return Math.trunc(numeric);
}

function hasDtsHdMarker(track) {
  const text = `${track?.description || ''} ${track?.title || ''} ${track?.format || ''} ${track?.codecName || ''}`
    .toLowerCase();
  const codec = normalizeCodecNumber(track?.codec);
  return text.includes('dts-hd') || text.includes('dts hd') || codec === 262144;
}

function isLikelyDtsCoreTrack(track) {
  const text = `${track?.description || ''} ${track?.title || ''} ${track?.format || ''} ${track?.codecName || ''}`
    .toLowerCase();
  const codec = normalizeCodecNumber(track?.codec);
  const looksDts = text.includes('dts') || text.includes('dca');
  const looksHd = text.includes('dts-hd') || text.includes('dts hd') || codec === 262144;
  if (!looksDts || looksHd) {
    return false;
  }

  // HandBrake uses 8192 for DTS core in scan JSON.
  if (codec !== null && codec !== 8192) {
    return false;
  }
  return true;
}

function filterDtsCoreFallbackTracks(audioTracks) {
  const tracks = Array.isArray(audioTracks) ? audioTracks : [];
  if (tracks.length === 0) {
    return [];
  }

  const hdLanguages = new Set(
    tracks
      .filter((track) => hasDtsHdMarker(track))
      .map((track) => String(track?.language || 'und'))
  );

  if (hdLanguages.size === 0) {
    return tracks;
  }

  return tracks.filter((track) => {
    const language = String(track?.language || 'und');
    if (!hdLanguages.has(language)) {
      return true;
    }
    return !isLikelyDtsCoreTrack(track);
  });
}

function parseHandBrakeSelectedTitleInfo(scanJson, options = {}) {
  const titleList = pickScanTitleList(scanJson);
  if (!Array.isArray(titleList) || titleList.length === 0) {
    return null;
  }

  const preferredPlaylistId = normalizePlaylistId(options?.playlistId || null);
  const rawPreferredHandBrakeTitleId = Number(options?.handBrakeTitleId);
  const preferredHandBrakeTitleId = Number.isFinite(rawPreferredHandBrakeTitleId) && rawPreferredHandBrakeTitleId > 0
    ? Math.trunc(rawPreferredHandBrakeTitleId)
    : null;
  const makeMkvSubtitleTracks = Array.isArray(options?.makeMkvSubtitleTracks)
    ? options.makeMkvSubtitleTracks
    : [];

  const parsedTitles = titleList.map((title, idx) => {
    const handBrakeTitleId = normalizeScanTrackId(
      title?.Index ?? title?.index ?? title?.Title ?? title?.title,
      idx
    );
    const playlistId = normalizePlaylistId(
      title?.Playlist
      || title?.playlist
      || title?.PlaylistName
      || title?.playlistName
      || null
    );
    const durationSeconds = parseHandBrakeDurationSeconds(
      title?.Duration ?? title?.duration ?? title?.Length ?? title?.length
    );
    const sizeBytes = Number(title?.Size?.Bytes ?? title?.Bytes ?? 0) || 0;
    const rawFileName = String(
      title?.Name
      || title?.TitleName
      || title?.File
      || title?.SourceName
      || ''
    ).trim();
    const fileName = rawFileName || `Title #${handBrakeTitleId}`;

    const audioTracksRaw = (Array.isArray(title?.AudioList) ? title.AudioList : [])
      .map((track, trackIndex) => {
        const sourceTrackId = normalizeScanTrackId(
          // Prefer source numbering from HandBrake JSON so UI/CLI IDs stay stable
          // (e.g. audio 2..10, subtitle 11..21 on some Blu-rays).
          track?.TrackNumber
          ?? track?.Track
          ?? track?.id
          ?? track?.ID
          ?? track?.Index,
          trackIndex
        );
        const languageCode = normalizeTrackLanguage(
          track?.LanguageCode
          || track?.ISO639_2
          || track?.Language
          || track?.language
          || 'und'
        );
        const languageLabel = String(
          track?.Language
          || track?.LanguageCode
          || track?.language
          || languageCode
        ).trim() || languageCode;

        return {
          id: sourceTrackId,
          sourceTrackId,
          language: languageCode,
          languageLabel,
          title: track?.Name || track?.Description || null,
          description: track?.Description || null,
          codec: track?.Codec ?? null,
          codecName: track?.CodecName || null,
          format: track?.Codec || track?.CodecName || track?.CodecParam || null,
          channels: track?.ChannelLayoutName || track?.ChannelLayout || track?.Channels || null
        };
      })
      .filter((track) => Number.isFinite(Number(track?.sourceTrackId)) && Number(track.sourceTrackId) > 0);
    const audioTracks = filterDtsCoreFallbackTracks(audioTracksRaw);

    const subtitleTracksRaw = (Array.isArray(title?.SubtitleList) ? title.SubtitleList : [])
      .map((track, trackIndex) => {
        const sourceTrackId = normalizeScanTrackId(
          track?.TrackNumber
          ?? track?.Track
          ?? track?.id
          ?? track?.ID
          ?? track?.Index,
          trackIndex
        );
        const languageCode = normalizeTrackLanguage(
          track?.LanguageCode
          || track?.ISO639_2
          || track?.Language
          || track?.language
          || 'und'
        );
        const languageLabel = String(
          track?.Language
          || track?.LanguageCode
          || track?.language
          || languageCode
        ).trim() || languageCode;

        return {
          id: sourceTrackId,
          sourceTrackId,
          language: languageCode,
          languageLabel,
          title: track?.Name || track?.Description || null,
          format: track?.SourceName || track?.Format || track?.Codec || null,
          channels: null
        };
      })
      .filter((track) => Number.isFinite(Number(track?.sourceTrackId)) && Number(track.sourceTrackId) > 0);
    const subtitleTracks = annotateSubtitleForcedAvailability(subtitleTracksRaw, makeMkvSubtitleTracks);

    return {
      handBrakeTitleId,
      playlistId,
      durationSeconds,
      sizeBytes,
      fileName,
      audioTracks,
      subtitleTracks
    };
  });

  let selected = null;
  if (preferredHandBrakeTitleId) {
    selected = parsedTitles.find((title) => title.handBrakeTitleId === preferredHandBrakeTitleId) || null;
  }
  if (!selected && preferredPlaylistId) {
    const playlistMatches = parsedTitles
      .filter((title) => normalizePlaylistId(title?.playlistId) === preferredPlaylistId)
      .sort((a, b) => b.durationSeconds - a.durationSeconds || b.sizeBytes - a.sizeBytes || a.handBrakeTitleId - b.handBrakeTitleId);
    selected = playlistMatches[0] || null;
  }
  if (!selected) {
    selected = parsedTitles
      .slice()
      .sort((a, b) => b.durationSeconds - a.durationSeconds || b.sizeBytes - a.sizeBytes || a.handBrakeTitleId - b.handBrakeTitleId)[0] || null;
  }
  if (!selected) {
    return null;
  }

  return {
    source: 'handbrake_scan',
    titleId: selected.handBrakeTitleId,
    handBrakeTitleId: selected.handBrakeTitleId,
    fileName: selected.fileName,
    durationSeconds: selected.durationSeconds,
    sizeBytes: selected.sizeBytes,
    playlistId: selected.playlistId || preferredPlaylistId || null,
    audioTracks: selected.audioTracks,
    subtitleTracks: selected.subtitleTracks
  };
}

function pickTitleIdForTrackReview(playlistAnalysis, selectedTitleId = null) {
  const explicit = normalizeNonNegativeInteger(selectedTitleId);
  if (explicit !== null) {
    return explicit;
  }

  const recommendationTitleId = Number(playlistAnalysis?.recommendation?.titleId);
  if (Number.isFinite(recommendationTitleId) && recommendationTitleId >= 0) {
    return Math.trunc(recommendationTitleId);
  }

  const candidates = Array.isArray(playlistAnalysis?.candidates) ? playlistAnalysis.candidates : [];
  if (candidates.length > 0) {
    const candidatesWithPlaylist = candidates.filter((item) => normalizePlaylistId(item?.playlistId));
    const sortPool = candidatesWithPlaylist.length > 0 ? candidatesWithPlaylist : candidates;
    const sortedCandidates = [...sortPool].sort((a, b) =>
      Number(b?.durationSeconds || 0) - Number(a?.durationSeconds || 0)
      || Number(b?.sizeBytes || 0) - Number(a?.sizeBytes || 0)
      || Number(a?.titleId || 0) - Number(b?.titleId || 0)
    );
    const candidateTitleId = Number(sortedCandidates[0]?.titleId);
    if (Number.isFinite(candidateTitleId) && candidateTitleId >= 0) {
      return Math.trunc(candidateTitleId);
    }
  }

  const titles = Array.isArray(playlistAnalysis?.titles) ? playlistAnalysis.titles : [];
  if (titles.length > 0) {
    const sortedTitles = [...titles].sort((a, b) =>
      Number(b?.durationSeconds || 0) - Number(a?.durationSeconds || 0)
      || Number(b?.sizeBytes || 0) - Number(a?.sizeBytes || 0)
      || Number(a?.titleId || 0) - Number(b?.titleId || 0)
    );
    const titleId = Number(sortedTitles[0]?.titleId);
    if (Number.isFinite(titleId) && titleId >= 0) {
      return Math.trunc(titleId);
    }
  }

  return null;
}

function isCandidateTitleId(playlistAnalysis, titleId) {
  const normalizedTitleId = normalizeNonNegativeInteger(titleId);
  if (normalizedTitleId === null) {
    return false;
  }
  const candidates = Array.isArray(playlistAnalysis?.candidates) ? playlistAnalysis.candidates : [];
  return candidates.some((item) => Number(item?.titleId) === normalizedTitleId);
}

function buildDiscScanReview({
  scanJson,
  settings,
  playlistAnalysis = null,
  selectedPlaylistId = null,
  selectedMakemkvTitleId = null,
  mediaProfile = null,
  sourceArg = null,
  mode = 'pre_rip',
  preRip = true,
  encodeInputPath = null
}) {
  const minLengthMinutes = Number(settings?.makemkv_min_length_minutes || 0);
  const minLengthSeconds = Math.max(0, Math.round(minLengthMinutes * 60));
  const selectedPlaylist = normalizePlaylistId(selectedPlaylistId);
  const selectedMakemkvId = Number(selectedMakemkvTitleId);

  const titleList = pickScanTitleList(scanJson);
  const parsedTitles = titleList.map((title, idx) => {
    const reviewTitleId = normalizeScanTrackId(
      title?.Index ?? title?.index ?? title?.Title ?? title?.title,
      idx
    );
    const durationSeconds = parseHandBrakeDurationSeconds(
      title?.Duration ?? title?.duration ?? title?.Length ?? title?.length
    );
    const durationMinutes = Number((durationSeconds / 60).toFixed(2));
    const rawPlaylist = title?.Playlist
      || title?.playlist
      || title?.PlaylistName
      || title?.playlistName
      || null;
    const playlistInfo = resolvePlaylistInfoFromAnalysis(playlistAnalysis, rawPlaylist);
    const mappedMakemkvTitle = Array.isArray(playlistAnalysis?.titles)
      ? (playlistAnalysis.titles.find((item) =>
        normalizePlaylistId(item?.playlistId) === normalizePlaylistId(playlistInfo.playlistId)
      ) || null)
      : null;
    const makemkvTitleId = Number.isFinite(Number(mappedMakemkvTitle?.titleId))
      ? Math.trunc(Number(mappedMakemkvTitle.titleId))
      : null;

    const audioList = Array.isArray(title?.AudioList) ? title.AudioList : [];
    const subtitleList = Array.isArray(title?.SubtitleList) ? title.SubtitleList : [];

    const audioTracksRaw = audioList.map((item, trackIndex) => {
      const trackId = normalizeScanTrackId(item?.TrackNumber ?? item?.Track ?? item?.id, trackIndex);
      const languageLabel = String(item?.Language || item?.LanguageCode || item?.language || 'und');
      const format = item?.Codec || item?.CodecName || item?.CodecParam || item?.Name || null;
      return {
        id: trackId,
        sourceTrackId: trackId,
        language: normalizeTrackLanguage(item?.LanguageCode || item?.ISO639_2 || languageLabel),
        languageLabel,
        title: item?.Name || item?.Description || null,
        description: item?.Description || null,
        codec: item?.Codec ?? null,
        codecName: item?.CodecName || null,
        format,
        channels: item?.ChannelLayoutName || item?.ChannelLayout || item?.Channels || null,
        selectedByRule: true,
        encodePreviewActions: [],
        encodePreviewSummary: 'Übernehmen'
      };
    });
    const audioTracks = filterDtsCoreFallbackTracks(audioTracksRaw);

    const subtitleTracksRaw = subtitleList.map((item, trackIndex) => {
      const trackId = normalizeScanTrackId(item?.TrackNumber ?? item?.Track ?? item?.id, trackIndex);
      const languageLabel = String(item?.Language || item?.LanguageCode || item?.language || 'und');
      return {
        id: trackId,
        sourceTrackId: trackId,
        language: normalizeTrackLanguage(item?.LanguageCode || item?.ISO639_2 || languageLabel),
        languageLabel,
        title: item?.Name || item?.Description || null,
        format: item?.SourceName || item?.Format || null,
        selectedByRule: true,
        subtitlePreviewSummary: 'Übernehmen',
        subtitlePreviewFlags: [],
        subtitlePreviewBurnIn: false,
        subtitlePreviewForced: false,
        subtitlePreviewForcedOnly: false,
        subtitlePreviewDefaultTrack: false
      };
    });
    const subtitleTracks = annotateSubtitleForcedAvailability(
      subtitleTracksRaw,
      Array.isArray(mappedMakemkvTitle?.subtitleTracks) ? mappedMakemkvTitle.subtitleTracks : []
    );

    return {
      id: reviewTitleId,
      filePath: encodeInputPath || `disc-track-scan://title-${reviewTitleId}`,
      fileName: `Disc Title ${reviewTitleId}`,
      makemkvTitleId,
      sizeBytes: Number(title?.Size?.Bytes ?? title?.Bytes ?? 0) || 0,
      durationSeconds,
      durationMinutes,
      selectedByMinLength: durationSeconds >= minLengthSeconds,
      playlistMatch: playlistInfo,
      audioTracks,
      subtitleTracks
    };
  });

  const encodeCandidates = parsedTitles.filter((item) => item.selectedByMinLength);
  const selectedPlaylistCandidate = selectedPlaylist
    ? encodeCandidates.filter((item) => normalizePlaylistId(item?.playlistMatch?.playlistId) === selectedPlaylist)
    : [];
  const selectedMakemkvCandidate = Number.isFinite(selectedMakemkvId) && selectedMakemkvId >= 0
    ? encodeCandidates.find((item) => Number(item?.makemkvTitleId) === Math.trunc(selectedMakemkvId)) || null
    : null;
  const preferredByIndex = Number.isFinite(selectedMakemkvId) && selectedMakemkvId >= 0
    ? encodeCandidates.find((item) => Number(item?.id) === Math.trunc(selectedMakemkvId)) || null
    : null;

  let encodeInputTitle = null;
  if (selectedPlaylistCandidate.length > 0) {
    encodeInputTitle = selectedPlaylistCandidate.reduce((best, current) => (
      !best || current.durationSeconds > best.durationSeconds ? current : best
    ), null);
  } else if (selectedMakemkvCandidate) {
    encodeInputTitle = selectedMakemkvCandidate;
  } else if (preferredByIndex) {
    encodeInputTitle = preferredByIndex;
  } else {
    encodeInputTitle = encodeCandidates.reduce((best, current) => (
      !best || current.durationSeconds > best.durationSeconds ? current : best
    ), null);
  }

  const playlistDecisionRequired = Boolean(playlistAnalysis?.manualDecisionRequired && !selectedPlaylist);
  const normalizedTitles = parsedTitles.map((title) => {
    const isEncodeInput = Boolean(encodeInputTitle && Number(encodeInputTitle.id) === Number(title.id));
    return {
      ...title,
      selectedForEncode: isEncodeInput,
      encodeInput: isEncodeInput,
      eligibleForEncode: title.selectedByMinLength,
      playlistId: title.playlistMatch?.playlistId || null,
      playlistFile: title.playlistMatch?.playlistFile || null,
      playlistRecommended: Boolean(title.playlistMatch?.recommended),
      playlistEvaluationLabel: title.playlistMatch?.evaluationLabel || null,
      playlistSegmentCommand: title.playlistMatch?.segmentCommand || null,
      playlistSegmentFiles: Array.isArray(title.playlistMatch?.segmentFiles) ? title.playlistMatch.segmentFiles : [],
      audioTracks: title.audioTracks.map((track) => {
        const selectedForEncode = isEncodeInput && Boolean(track.selectedByRule);
        return {
          ...track,
          selectedForEncode,
          encodeActions: [],
          encodeActionSummary: selectedForEncode ? 'Übernehmen' : 'Nicht übernommen'
        };
      }),
      subtitleTracks: title.subtitleTracks.map((track) => {
        const selectedForEncode = isEncodeInput && Boolean(track.selectedByRule);
        return {
          ...track,
          selectedForEncode,
          burnIn: false,
          forced: false,
          forcedOnly: false,
          defaultTrack: false,
          flags: [],
          subtitleActionSummary: selectedForEncode ? 'Übernehmen' : 'Nicht übernommen'
        };
      })
    };
  });

  const selectedTitleIds = normalizedTitles.filter((item) => item.selectedByMinLength).map((item) => item.id);
  const recommendedPlaylistId = normalizePlaylistId(playlistAnalysis?.recommendation?.playlistId || null);
  const recommendedReviewTitle = normalizedTitles.find((item) => item.playlistId === recommendedPlaylistId) || null;

  return {
    generatedAt: nowIso(),
    mode,
    mediaProfile: normalizeMediaProfile(mediaProfile) || null,
    preRip: Boolean(preRip),
    reviewConfirmed: false,
    minLengthMinutes,
    minLengthSeconds,
    selectedTitleIds,
    selectors: {
      preset: settings?.handbrake_preset || '-',
      extraArgs: settings?.handbrake_extra_args || '',
      presetProfileSource: 'disc-scan',
      audio: {
        mode: 'manual',
        encoders: [],
        copyMask: [],
        fallbackEncoder: '-'
      },
      subtitle: {
        mode: 'manual',
        forcedOnly: false,
        burnBehavior: 'none'
      }
    },
    notes: [
      preRip
        ? `Vorab-Spurprüfung von Disc-Quelle ${sourceArg || '-'}.`
        : `Titel-/Spurprüfung aus RAW-Quelle ${sourceArg || '-'}.`,
      preRip
        ? 'Backup/Rip startet erst nach manueller Bestätigung und CTA.'
        : 'Encode startet erst nach manueller Bestätigung und CTA.'
    ],
    titles: normalizedTitles,
    encodeInputPath: encodeInputTitle ? (encodeInputPath || `disc-track-scan://title-${encodeInputTitle.id}`) : null,
    encodeInputTitleId: encodeInputTitle ? encodeInputTitle.id : null,
    playlistDecisionRequired,
    playlistRecommendation: recommendedPlaylistId
      ? {
        playlistId: recommendedPlaylistId,
        playlistFile: `${recommendedPlaylistId}.mpls`,
        reviewTitleId: recommendedReviewTitle?.id || null,
        reason: playlistAnalysis?.recommendation?.reason || null
      }
      : null,
    titleSelectionRequired: Boolean(playlistDecisionRequired && !encodeInputTitle)
  };
}

function findExistingRawDirectory(rawBaseDir, metadataBase) {
  if (!rawBaseDir || !metadataBase) {
    return null;
  }

  if (!fs.existsSync(rawBaseDir)) {
    return null;
  }

  let entries;
  try {
    entries = fs.readdirSync(rawBaseDir, { withFileTypes: true });
  } catch (_error) {
    return null;
  }

  const normalizedBase = sanitizeFileName(metadataBase);
  const escapedBase = normalizedBase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const escapedIncompletePrefix = RAW_INCOMPLETE_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const escapedRipCompletePrefix = RAW_RIP_COMPLETE_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const folderPattern = new RegExp(
    `^(?:(?:${escapedIncompletePrefix}|${escapedRipCompletePrefix}))?${escapedBase}(?:\\s\\[tt\\d{6,12}\\])?\\s-\\sRAW\\s-\\sjob-\\d+\\s*$`,
    'i'
  );
  const candidates = entries
    .filter((entry) => entry.isDirectory() && folderPattern.test(entry.name))
    .map((entry) => {
      const absPath = path.join(rawBaseDir, entry.name);
      try {
        const dirEntries = fs.readdirSync(absPath);
        const stat = fs.statSync(absPath);
        return {
          path: absPath,
          entryCount: dirEntries.length,
          mtimeMs: Number(stat.mtimeMs || 0)
        };
      } catch (_error) {
        return null;
      }
    })
    .filter((item) => item && item.entryCount > 0)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  return candidates.length > 0 ? candidates[0].path : null;
}

function buildRawMetadataBase(jobLike = {}, fallbackJobId = null) {
  const normalizedJobId = Number(fallbackJobId || jobLike?.id || 0);
  const fallbackTitle = Number.isFinite(normalizedJobId) && normalizedJobId > 0
    ? `job-${Math.trunc(normalizedJobId)}`
    : 'job-unknown';
  const rawYear = Number(jobLike?.year ?? jobLike?.fallbackYear ?? null);
  const yearValue = Number.isFinite(rawYear) && rawYear > 0
    ? Math.trunc(rawYear)
    : new Date().getFullYear();
  return sanitizeFileName(
    renderTemplate('${title} (${year})', {
      title: jobLike?.title || jobLike?.detected_title || jobLike?.detectedTitle || fallbackTitle,
      year: yearValue
    })
  );
}

function normalizeRawFolderState(rawState, fallback = RAW_FOLDER_STATES.INCOMPLETE) {
  const state = String(rawState || '').trim().toLowerCase();
  if (!state) {
    return fallback;
  }
  if (state === RAW_FOLDER_STATES.INCOMPLETE) {
    return RAW_FOLDER_STATES.INCOMPLETE;
  }
  if (state === RAW_FOLDER_STATES.RIP_COMPLETE || state === 'ripcomplete' || state === 'rip-complete') {
    return RAW_FOLDER_STATES.RIP_COMPLETE;
  }
  if (state === RAW_FOLDER_STATES.COMPLETE || state === 'none' || state === 'final') {
    return RAW_FOLDER_STATES.COMPLETE;
  }
  return fallback;
}

function stripRawStatePrefix(folderName) {
  const rawName = String(folderName || '').trim();
  if (!rawName) {
    return '';
  }
  return rawName
    .replace(/^Incomplete_/i, '')
    .replace(/^Rip_Complete_/i, '')
    .trim();
}

function applyRawFolderStateToName(folderName, state) {
  const baseName = stripRawStatePrefix(folderName);
  if (!baseName) {
    return baseName;
  }
  const normalizedState = normalizeRawFolderState(state, RAW_FOLDER_STATES.COMPLETE);
  if (normalizedState === RAW_FOLDER_STATES.INCOMPLETE) {
    return `${RAW_INCOMPLETE_PREFIX}${baseName}`;
  }
  if (normalizedState === RAW_FOLDER_STATES.RIP_COMPLETE) {
    return `${RAW_RIP_COMPLETE_PREFIX}${baseName}`;
  }
  return baseName;
}

function resolveRawFolderStateFromPath(rawPath) {
  const sourcePath = String(rawPath || '').trim();
  if (!sourcePath) {
    return RAW_FOLDER_STATES.COMPLETE;
  }
  const folderName = path.basename(sourcePath);
  if (/^Incomplete_/i.test(folderName)) {
    return RAW_FOLDER_STATES.INCOMPLETE;
  }
  if (/^Rip_Complete_/i.test(folderName)) {
    return RAW_FOLDER_STATES.RIP_COMPLETE;
  }
  return RAW_FOLDER_STATES.COMPLETE;
}

function resolveRawFolderStateFromOptions(options = {}) {
  if (options && Object.prototype.hasOwnProperty.call(options, 'state')) {
    return normalizeRawFolderState(options.state, RAW_FOLDER_STATES.INCOMPLETE);
  }
  if (options && options.ripComplete) {
    return RAW_FOLDER_STATES.RIP_COMPLETE;
  }
  if (options && Object.prototype.hasOwnProperty.call(options, 'incomplete')) {
    return options.incomplete ? RAW_FOLDER_STATES.INCOMPLETE : RAW_FOLDER_STATES.COMPLETE;
  }
  return RAW_FOLDER_STATES.INCOMPLETE;
}

function buildRawDirName(metadataBase, jobId, options = {}) {
  const state = resolveRawFolderStateFromOptions(options);
  const baseName = sanitizeFileName(`${metadataBase} - RAW - job-${jobId}`);
  return sanitizeFileName(applyRawFolderStateToName(baseName, state));
}

function buildRawPathForState(rawPath, state) {
  const sourcePath = String(rawPath || '').trim();
  if (!sourcePath) {
    return null;
  }
  const folderName = path.basename(sourcePath);
  const nextFolderName = applyRawFolderStateToName(folderName, state);
  if (!nextFolderName) {
    return sourcePath;
  }
  return path.join(path.dirname(sourcePath), nextFolderName);
}

function buildRipCompleteRawPath(rawPath) {
  return buildRawPathForState(rawPath, RAW_FOLDER_STATES.RIP_COMPLETE);
}

function buildCompletedRawPath(rawPath) {
  return buildRawPathForState(rawPath, RAW_FOLDER_STATES.COMPLETE);
}

function normalizeComparablePath(inputPath) {
  const source = String(inputPath || '').trim();
  if (!source) {
    return '';
  }
  return path.resolve(source).replace(/[\\/]+$/, '');
}

function isPathInsideDirectory(parentPath, candidatePath) {
  const parent = normalizeComparablePath(parentPath);
  const candidate = normalizeComparablePath(candidatePath);
  if (!parent || !candidate) {
    return false;
  }
  if (candidate === parent) {
    return true;
  }
  const parentWithSep = parent.endsWith(path.sep) ? parent : `${parent}${path.sep}`;
  return candidate.startsWith(parentWithSep);
}

function isEncodeInputMismatchedWithRaw(rawPath, encodeInputPath) {
  const raw = normalizeComparablePath(rawPath);
  const input = normalizeComparablePath(encodeInputPath);
  if (!raw || !input) {
    return true;
  }
  if (raw === input) {
    return false;
  }
  return !isPathInsideDirectory(raw, input);
}

function isJobFinished(jobLike = null) {
  const status = String(jobLike?.status || '').trim().toUpperCase();
  const lastState = String(jobLike?.last_state || '').trim().toUpperCase();
  return status === 'FINISHED' || lastState === 'FINISHED';
}

function toPlaylistFile(playlistId) {
  const normalized = normalizePlaylistId(playlistId);
  return normalized ? `${normalized}.mpls` : null;
}

function describePlaylistManualDecision(playlistAnalysis) {
  const obfuscationDetected = Boolean(playlistAnalysis?.obfuscationDetected);
  const candidateCount = Array.isArray(playlistAnalysis?.candidates)
    ? playlistAnalysis.candidates.length
    : 0;
  const reasonCodeRaw = String(playlistAnalysis?.manualDecisionReason || '').trim();
  const reasonCode = reasonCodeRaw || (
    obfuscationDetected
      ? 'multiple_similar_candidates'
      : (candidateCount > 1 ? 'multiple_candidates_after_min_length' : 'manual_selection_required')
  );
  const detailText = obfuscationDetected
    ? 'Blu-ray verwendet Playlist-Obfuscation (mehrere gleichlange Kandidaten).'
    : (candidateCount > 1
      ? `Mehrere Playlists erfüllen MIN_LENGTH_MINUTES (${candidateCount} Kandidaten).`
      : 'Manuelle Playlist-Auswahl erforderlich.');

  return {
    obfuscationDetected,
    candidateCount,
    reasonCode,
    detailText
  };
}

function buildPlaylistCandidates(playlistAnalysis) {
  const rawList = Array.isArray(playlistAnalysis?.candidatePlaylists)
    ? playlistAnalysis.candidatePlaylists
    : [];
  const sourceRows = [
    ...(Array.isArray(playlistAnalysis?.evaluatedCandidates) ? playlistAnalysis.evaluatedCandidates : []),
    ...(Array.isArray(playlistAnalysis?.candidates) ? playlistAnalysis.candidates : []),
    ...(Array.isArray(playlistAnalysis?.titles) ? playlistAnalysis.titles : [])
  ];
  const segmentMap = playlistAnalysis?.playlistSegments && typeof playlistAnalysis.playlistSegments === 'object'
    ? playlistAnalysis.playlistSegments
    : {};

  return rawList
    .map((playlistId) => normalizePlaylistId(playlistId))
    .filter(Boolean)
    .map((playlistId) => {
      const source = sourceRows.find((item) => normalizePlaylistId(item?.playlistId || item?.playlistFile) === playlistId) || null;
      const segmentEntry = segmentMap[playlistId] || segmentMap[`${playlistId}.mpls`] || null;
      const score = Number(source?.score);
      const sequenceCoherence = Number(source?.structuralMetrics?.sequenceCoherence);
      const titleId = Number(source?.titleId ?? source?.id);
      const handBrakeTitleId = Number(source?.handBrakeTitleId);
      const durationSecondsRaw = Number(source?.durationSeconds ?? source?.duration ?? 0);
      const durationSeconds = Number.isFinite(durationSecondsRaw) && durationSecondsRaw > 0
        ? Math.trunc(durationSecondsRaw)
        : 0;
      const sizeBytesRaw = Number(source?.sizeBytes ?? source?.size ?? 0);
      const sizeBytes = Number.isFinite(sizeBytesRaw) && sizeBytesRaw > 0
        ? Math.trunc(sizeBytesRaw)
        : 0;
      const durationLabelRaw = String(source?.durationLabel || '').trim();
      const durationLabel = durationLabelRaw || formatDurationClock(durationSeconds);
      const sourceAudioTracks = Array.isArray(source?.audioTracks) ? source.audioTracks : [];
      const fallbackAudioTrackPreview = sourceAudioTracks
        .slice(0, 8)
        .map((track) => {
          const rawTrackId = Number(track?.sourceTrackId ?? track?.id);
          const trackId = Number.isFinite(rawTrackId) && rawTrackId > 0 ? Math.trunc(rawTrackId) : null;
          const language = normalizeTrackLanguage(track?.language || track?.languageLabel || 'und');
          const languageLabel = String(track?.languageLabel || track?.language || language).trim() || language;
          const format = String(track?.format || '').trim();
          const channels = String(track?.channels || '').trim();
          const parts = [];
          if (trackId !== null) {
            parts.push(`#${trackId}`);
          }
          parts.push(language);
          parts.push(languageLabel);
          if (format) {
            parts.push(format);
          }
          if (channels) {
            parts.push(channels);
          }
          return parts.join(' | ');
        })
        .filter((line) => line.length > 0);
      const sourceAudioTrackPreview = Array.isArray(source?.audioTrackPreview)
        ? source.audioTrackPreview.map((line) => String(line || '').trim()).filter((line) => line.length > 0)
        : [];
      const audioTrackPreview = sourceAudioTrackPreview.length > 0 ? sourceAudioTrackPreview : fallbackAudioTrackPreview;
      const audioSummary = String(source?.audioSummary || '').trim() || buildHandBrakeAudioSummary(audioTrackPreview);

      return {
        playlistId,
        playlistFile: toPlaylistFile(playlistId),
        titleId: Number.isFinite(titleId) ? Math.trunc(titleId) : null,
        durationSeconds,
        durationLabel: durationLabel || null,
        sizeBytes,
        score: Number.isFinite(score) ? score : null,
        recommended: Boolean(source?.recommended),
        evaluationLabel: source?.evaluationLabel || null,
        sequenceCoherence: Number.isFinite(sequenceCoherence) ? sequenceCoherence : null,
        segmentCommand: source?.segmentCommand
          || segmentEntry?.segmentCommand
          || `strings BDMV/PLAYLIST/${playlistId}.mpls | grep m2ts`,
        segmentFiles: Array.isArray(source?.segmentFiles) && source.segmentFiles.length > 0
          ? source.segmentFiles
          : (Array.isArray(segmentEntry?.segmentFiles) ? segmentEntry.segmentFiles : []),
        handBrakeTitleId: Number.isFinite(handBrakeTitleId) && handBrakeTitleId > 0
          ? Math.trunc(handBrakeTitleId)
          : null,
        audioSummary: audioSummary || null,
        audioTrackPreview
      };
    });
}

function buildHandBrakeAudioTrackPreview(titleInfo) {
  const tracks = Array.isArray(titleInfo?.audioTracks) ? titleInfo.audioTracks : [];
  return tracks
    .map((track) => {
      const rawTrackId = Number(track?.sourceTrackId ?? track?.id);
      const trackId = Number.isFinite(rawTrackId) && rawTrackId > 0 ? Math.trunc(rawTrackId) : null;
      const language = normalizeTrackLanguage(track?.language || track?.languageLabel || 'und');
      const description = String(track?.description || track?.title || '').trim();
      const codec = String(track?.codecName || track?.format || '').trim();
      const channels = String(track?.channels || '').trim();

      const parts = [];
      if (trackId !== null) {
        parts.push(`#${trackId}`);
      }
      parts.push(language);
      if (description) {
        parts.push(description);
      } else {
        if (codec) {
          parts.push(codec);
        }
        if (channels) {
          parts.push(channels);
        }
      }
      return parts.join(' | ').trim();
    })
    .filter((line) => line.length > 0);
}

function buildHandBrakeAudioSummary(previewLines) {
  const lines = Array.isArray(previewLines)
    ? previewLines.filter((line) => String(line || '').trim().length > 0)
    : [];
  if (lines.length === 0) {
    return null;
  }
  return lines.slice(0, 3).join(' || ');
}

function normalizeHandBrakePlaylistScanCache(rawCache) {
  if (!rawCache || typeof rawCache !== 'object') {
    return null;
  }

  const inputPath = String(rawCache?.inputPath || '').trim() || null;
  const source = String(rawCache?.source || '').trim() || 'HANDBRAKE_SCAN_PLAYLIST_MAP';
  const generatedAt = String(rawCache?.generatedAt || '').trim() || null;

  const rawEntries = [];
  if (rawCache?.byPlaylist && typeof rawCache.byPlaylist === 'object') {
    for (const [key, value] of Object.entries(rawCache.byPlaylist)) {
      rawEntries.push({ key, value });
    }
  } else if (Array.isArray(rawCache?.playlists)) {
    for (const item of rawCache.playlists) {
      rawEntries.push({ key: item?.playlistId || item?.playlistFile || null, value: item });
    }
  }

  const byPlaylist = {};
  for (const entry of rawEntries) {
    const row = entry?.value && typeof entry.value === 'object' ? entry.value : null;
    const playlistId = normalizePlaylistId(row?.playlistId || row?.playlistFile || entry?.key || null);
    if (!playlistId) {
      continue;
    }
    const rawHandBrakeTitleId = Number(row?.handBrakeTitleId ?? row?.titleId);
    const handBrakeTitleId = Number.isFinite(rawHandBrakeTitleId) && rawHandBrakeTitleId > 0
      ? Math.trunc(rawHandBrakeTitleId)
      : null;
    const titleInfo = row?.titleInfo && typeof row.titleInfo === 'object' ? row.titleInfo : null;
    const audioTrackPreview = Array.isArray(row?.audioTrackPreview)
      ? row.audioTrackPreview.map((line) => String(line || '').trim()).filter((line) => line.length > 0)
      : buildHandBrakeAudioTrackPreview(titleInfo);
    const audioSummary = String(row?.audioSummary || '').trim() || buildHandBrakeAudioSummary(audioTrackPreview);

    byPlaylist[playlistId] = {
      playlistId,
      handBrakeTitleId,
      titleInfo,
      audioTrackPreview,
      audioSummary: audioSummary || null
    };
  }

  if (Object.keys(byPlaylist).length === 0) {
    return null;
  }

  return {
    generatedAt,
    source,
    inputPath,
    byPlaylist
  };
}

function getCachedHandBrakePlaylistEntry(scanCache, playlistIdRaw) {
  const playlistId = normalizePlaylistId(playlistIdRaw);
  if (!playlistId) {
    return null;
  }
  const normalized = normalizeHandBrakePlaylistScanCache(scanCache);
  if (!normalized) {
    return null;
  }
  return normalized.byPlaylist[playlistId] || null;
}

function hasCachedHandBrakeDataForPlaylistCandidates(scanCache, playlistCandidates = []) {
  const normalized = normalizeHandBrakePlaylistScanCache(scanCache);
  if (!normalized) {
    return false;
  }

  const candidateIds = (Array.isArray(playlistCandidates) ? playlistCandidates : [])
    .map((item) => normalizePlaylistId(item?.playlistId || item?.playlistFile || item))
    .filter(Boolean);
  if (candidateIds.length === 0) {
    return false;
  }

  return candidateIds.every((playlistId) => {
    const row = normalized.byPlaylist[playlistId];
    return Boolean(row && row.handBrakeTitleId && row.titleInfo);
  });
}

function buildHandBrakePlaylistScanCache(scanJson, playlistCandidates = [], rawPath = null) {
  const candidateMetaByPlaylist = new Map();
  for (const row of (Array.isArray(playlistCandidates) ? playlistCandidates : [])) {
    const playlistId = normalizePlaylistId(row?.playlistId || row?.playlistFile || row);
    if (!playlistId || candidateMetaByPlaylist.has(playlistId)) {
      continue;
    }
    candidateMetaByPlaylist.set(playlistId, {
      expectedMakemkvTitleId: normalizeNonNegativeInteger(row?.titleId),
      expectedDurationSeconds: Number(row?.durationSeconds || 0) || null,
      expectedSizeBytes: Number(row?.sizeBytes || 0) || null
    });
  }

  const candidateIds = Array.from(new Set(
    (Array.isArray(playlistCandidates) ? playlistCandidates : [])
      .map((item) => normalizePlaylistId(item?.playlistId || item?.playlistFile || item))
      .filter(Boolean)
  ));

  const byPlaylist = {};
  for (const playlistId of candidateIds) {
    const expected = candidateMetaByPlaylist.get(playlistId) || {};
    const handBrakeTitleId = resolveHandBrakeTitleIdForPlaylist(scanJson, playlistId, expected);
    if (!handBrakeTitleId) {
      continue;
    }
    const titleInfo = parseHandBrakeSelectedTitleInfo(scanJson, {
      playlistId,
      handBrakeTitleId
    });
    if (!titleInfo) {
      continue;
    }
    if (!isHandBrakePlaylistCacheEntryCompatible({
      playlistId,
      handBrakeTitleId,
      titleInfo
    }, playlistId, expected)) {
      continue;
    }
    const audioTrackPreview = buildHandBrakeAudioTrackPreview(titleInfo);
    byPlaylist[playlistId] = {
      playlistId,
      handBrakeTitleId,
      titleInfo,
      audioTrackPreview,
      audioSummary: buildHandBrakeAudioSummary(audioTrackPreview)
    };
  }

  return normalizeHandBrakePlaylistScanCache({
    generatedAt: nowIso(),
    source: 'HANDBRAKE_SCAN_PLAYLIST_MAP',
    inputPath: rawPath || null,
    byPlaylist
  });
}

function enrichPlaylistAnalysisWithHandBrakeCache(playlistAnalysis, scanCache) {
  const analysis = playlistAnalysis && typeof playlistAnalysis === 'object' ? playlistAnalysis : null;
  const normalizedCache = normalizeHandBrakePlaylistScanCache(scanCache);
  if (!analysis || !normalizedCache) {
    return analysis;
  }

  const enrichRow = (row) => {
    const playlistId = normalizePlaylistId(row?.playlistId || row?.playlistFile || null);
    if (!playlistId) {
      return row;
    }
    const cached = normalizedCache.byPlaylist[playlistId];
    if (!cached) {
      return row;
    }
    return {
      ...row,
      handBrakeTitleId: cached.handBrakeTitleId || null,
      audioSummary: cached.audioSummary || null,
      audioTrackPreview: Array.isArray(cached.audioTrackPreview) ? cached.audioTrackPreview : []
    };
  };

  const recommendationPlaylistId = normalizePlaylistId(analysis?.recommendation?.playlistId);
  const recommendationCached = recommendationPlaylistId
    ? normalizedCache.byPlaylist[recommendationPlaylistId] || null
    : null;

  return {
    ...analysis,
    evaluatedCandidates: Array.isArray(analysis?.evaluatedCandidates)
      ? analysis.evaluatedCandidates.map((row) => enrichRow(row))
      : [],
    candidates: Array.isArray(analysis?.candidates)
      ? analysis.candidates.map((row) => enrichRow(row))
      : [],
    titles: Array.isArray(analysis?.titles)
      ? analysis.titles.map((row) => enrichRow(row))
      : [],
    recommendation: analysis?.recommendation && typeof analysis.recommendation === 'object'
      ? {
        ...analysis.recommendation,
        handBrakeTitleId: recommendationCached?.handBrakeTitleId || null,
        audioSummary: recommendationCached?.audioSummary || null,
        audioTrackPreview: Array.isArray(recommendationCached?.audioTrackPreview)
          ? recommendationCached.audioTrackPreview
          : []
      }
      : analysis?.recommendation || null
  };
}

function pickTitleIdForPlaylist(playlistAnalysis, playlistId) {
  const normalized = normalizePlaylistId(playlistId);
  if (!normalized || !playlistAnalysis) {
    return null;
  }

  const playlistMap = playlistAnalysis?.playlistToTitleId
    && typeof playlistAnalysis.playlistToTitleId === 'object'
    ? playlistAnalysis.playlistToTitleId
    : null;
  if (playlistMap) {
    const byFile = Number(playlistMap[`${normalized}.mpls`]);
    if (Number.isFinite(byFile) && byFile >= 0) {
      return Math.trunc(byFile);
    }
    const byId = Number(playlistMap[normalized]);
    if (Number.isFinite(byId) && byId >= 0) {
      return Math.trunc(byId);
    }
  }

  const sources = [
    ...(Array.isArray(playlistAnalysis?.evaluatedCandidates) ? playlistAnalysis.evaluatedCandidates : []),
    ...(Array.isArray(playlistAnalysis?.candidates) ? playlistAnalysis.candidates : []),
    ...(Array.isArray(playlistAnalysis?.titles) ? playlistAnalysis.titles : [])
  ];

  const matches = sources
    .filter((item) => normalizePlaylistId(item?.playlistId) === normalized)
    .map((item) => ({
      titleId: Number(item?.titleId ?? item?.id),
      durationSeconds: Number(item?.durationSeconds || 0),
      sizeBytes: Number(item?.sizeBytes || 0)
    }))
    .filter((item) => Number.isFinite(item.titleId) && item.titleId >= 0)
    .sort((a, b) => b.durationSeconds - a.durationSeconds || b.sizeBytes - a.sizeBytes || a.titleId - b.titleId);

  return matches.length > 0 ? matches[0].titleId : null;
}

function normalizeReviewTitleId(rawValue) {
  const value = Number(rawValue);
  if (!Number.isFinite(value) || value <= 0) {
    return null;
  }
  return Math.trunc(value);
}

function applyEncodeTitleSelectionToPlan(encodePlan, selectedEncodeTitleId) {
  const normalizedTitleId = normalizeReviewTitleId(selectedEncodeTitleId);
  if (!normalizedTitleId) {
    return {
      plan: encodePlan,
      selectedTitle: null
    };
  }

  const titles = Array.isArray(encodePlan?.titles) ? encodePlan.titles : [];
  const selectedTitle = titles.find((item) => Number(item?.id) === normalizedTitleId) || null;
  if (!selectedTitle) {
    const error = new Error(`Gewählter Titel #${normalizedTitleId} ist nicht vorhanden.`);
    error.statusCode = 400;
    throw error;
  }

  const eligible = selectedTitle?.eligibleForEncode !== undefined
    ? Boolean(selectedTitle.eligibleForEncode)
    : Boolean(selectedTitle?.selectedByMinLength);
  if (!eligible) {
    const error = new Error(`Titel #${normalizedTitleId} ist laut MIN_LENGTH_MINUTES nicht encodierbar.`);
    error.statusCode = 400;
    throw error;
  }

  const remappedTitles = titles.map((title) => {
    const isEncodeInput = Number(title?.id) === normalizedTitleId;

    const audioTracks = (Array.isArray(title?.audioTracks) ? title.audioTracks : []).map((track) => {
      const selectedByRule = Boolean(track?.selectedByRule);
      const selectedForEncode = isEncodeInput && selectedByRule;
      const previewActions = Array.isArray(track?.encodePreviewActions) ? track.encodePreviewActions : [];
      const previewSummary = track?.encodePreviewSummary || 'Nicht übernommen';

      return {
        ...track,
        selectedForEncode,
        encodeActions: selectedForEncode ? previewActions : [],
        encodeActionSummary: selectedForEncode ? previewSummary : 'Nicht übernommen'
      };
    });

    const subtitleTracks = (Array.isArray(title?.subtitleTracks) ? title.subtitleTracks : []).map((track) => {
      const selectedByRule = Boolean(track?.selectedByRule);
      const selectedForEncode = isEncodeInput && selectedByRule;
      const previewFlags = Array.isArray(track?.subtitlePreviewFlags) ? track.subtitlePreviewFlags : [];
      const previewSummary = track?.subtitlePreviewSummary || 'Nicht übernommen';

      return {
        ...track,
        selectedForEncode,
        burnIn: selectedForEncode ? Boolean(track?.subtitlePreviewBurnIn) : false,
        forced: selectedForEncode ? Boolean(track?.subtitlePreviewForced) : false,
        forcedOnly: selectedForEncode ? Boolean(track?.subtitlePreviewForcedOnly) : false,
        defaultTrack: selectedForEncode ? Boolean(track?.subtitlePreviewDefaultTrack) : false,
        flags: selectedForEncode ? previewFlags : [],
        subtitleActionSummary: selectedForEncode ? previewSummary : 'Nicht übernommen'
      };
    });

    return {
      ...title,
      encodeInput: isEncodeInput,
      selectedForEncode: isEncodeInput,
      audioTracks,
      subtitleTracks
    };
  });

  return {
    plan: {
      ...encodePlan,
      titles: remappedTitles,
      encodeInputTitleId: normalizedTitleId,
      encodeInputPath: selectedTitle?.filePath || null,
      titleSelectionRequired: false
    },
    selectedTitle
  };
}

function normalizeTrackIdList(rawList) {
  const list = Array.isArray(rawList) ? rawList : [];
  const seen = new Set();
  const output = [];
  for (const item of list) {
    const value = Number(item);
    if (!Number.isFinite(value) || value <= 0) {
      continue;
    }
    const normalized = Math.trunc(value);
    const key = String(normalized);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    output.push(normalized);
  }
  return output;
}

function isBurnedSubtitleTrack(track) {
  const previewFlags = Array.isArray(track?.subtitlePreviewFlags)
    ? track.subtitlePreviewFlags
    : (Array.isArray(track?.flags) ? track.flags : []);
  const hasBurnedFlag = previewFlags.some((flag) => String(flag || '').trim().toLowerCase() === 'burned');
  const summary = `${track?.subtitlePreviewSummary || ''} ${track?.subtitleActionSummary || ''}`;
  return Boolean(
    track?.subtitlePreviewBurnIn
    || track?.burnIn
    || hasBurnedFlag
    || /burned/i.test(summary)
  );
}

function normalizeScriptIdList(rawList) {
  const list = Array.isArray(rawList) ? rawList : [];
  const seen = new Set();
  const output = [];
  for (const item of list) {
    const value = Number(item);
    if (!Number.isFinite(value) || value <= 0) {
      continue;
    }
    const normalized = Math.trunc(value);
    const key = String(normalized);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    output.push(normalized);
  }
  return output;
}

function applyManualTrackSelectionToPlan(encodePlan, selectedTrackSelection) {
  const plan = encodePlan && typeof encodePlan === 'object' ? encodePlan : null;
  if (!plan || !Array.isArray(plan.titles)) {
    return {
      plan: encodePlan,
      selectionApplied: false,
      audioTrackIds: [],
      subtitleTrackIds: []
    };
  }

  const encodeInputTitleId = normalizeReviewTitleId(plan.encodeInputTitleId);
  if (!encodeInputTitleId) {
    return {
      plan,
      selectionApplied: false,
      audioTrackIds: [],
      subtitleTrackIds: []
    };
  }

  const selectionPayload = selectedTrackSelection && typeof selectedTrackSelection === 'object'
    ? selectedTrackSelection
    : null;
  if (!selectionPayload) {
    return {
      plan,
      selectionApplied: false,
      audioTrackIds: [],
      subtitleTrackIds: []
    };
  }

  const rawSelection = selectionPayload[encodeInputTitleId]
    || selectionPayload[String(encodeInputTitleId)]
    || selectionPayload;
  if (!rawSelection || typeof rawSelection !== 'object') {
    return {
      plan,
      selectionApplied: false,
      audioTrackIds: [],
      subtitleTrackIds: []
    };
  }

  const encodeTitle = plan.titles.find((title) => Number(title?.id) === encodeInputTitleId) || null;
  if (!encodeTitle) {
    return {
      plan,
      selectionApplied: false,
      audioTrackIds: [],
      subtitleTrackIds: []
    };
  }

  const validAudioTrackIds = new Set(
    (Array.isArray(encodeTitle.audioTracks) ? encodeTitle.audioTracks : [])
      .map((track) => Number(track?.id))
      .filter((id) => Number.isFinite(id))
      .map((id) => Math.trunc(id))
  );
  const validSubtitleTrackIds = new Set(
    (Array.isArray(encodeTitle.subtitleTracks) ? encodeTitle.subtitleTracks : [])
      .filter((track) => !isBurnedSubtitleTrack(track))
      .map((track) => Number(track?.id))
      .filter((id) => Number.isFinite(id))
      .map((id) => Math.trunc(id))
  );

  const requestedAudioTrackIds = normalizeTrackIdList(rawSelection.audioTrackIds)
    .filter((id) => validAudioTrackIds.has(id));
  const requestedSubtitleTrackIds = normalizeTrackIdList(rawSelection.subtitleTrackIds)
    .filter((id) => validSubtitleTrackIds.has(id));

  const audioSelectionSet = new Set(requestedAudioTrackIds.map((id) => String(id)));
  const subtitleSelectionSet = new Set(requestedSubtitleTrackIds.map((id) => String(id)));

  const remappedTitles = plan.titles.map((title) => {
    const isEncodeInput = Number(title?.id) === encodeInputTitleId;

    const audioTracks = (Array.isArray(title?.audioTracks) ? title.audioTracks : []).map((track) => {
      const trackId = Number(track?.id);
      const selectedForEncode = isEncodeInput && audioSelectionSet.has(String(Math.trunc(trackId)));
      const previewActions = Array.isArray(track?.encodePreviewActions) ? track.encodePreviewActions : [];
      const previewSummary = track?.encodePreviewSummary || 'Nicht übernommen';
      return {
        ...track,
        selectedForEncode,
        encodeActions: selectedForEncode ? previewActions : [],
        encodeActionSummary: selectedForEncode ? previewSummary : 'Nicht übernommen'
      };
    });

    const subtitleTracks = (Array.isArray(title?.subtitleTracks) ? title.subtitleTracks : []).map((track) => {
      const trackId = Number(track?.id);
      const selectedForEncode = isEncodeInput && subtitleSelectionSet.has(String(Math.trunc(trackId)));
      const previewFlags = Array.isArray(track?.subtitlePreviewFlags) ? track.subtitlePreviewFlags : [];
      const previewSummary = track?.subtitlePreviewSummary || 'Nicht übernommen';
      return {
        ...track,
        selectedForEncode,
        burnIn: selectedForEncode ? Boolean(track?.subtitlePreviewBurnIn) : false,
        forced: selectedForEncode ? Boolean(track?.subtitlePreviewForced) : false,
        forcedOnly: selectedForEncode ? Boolean(track?.subtitlePreviewForcedOnly) : false,
        defaultTrack: selectedForEncode ? Boolean(track?.subtitlePreviewDefaultTrack) : false,
        flags: selectedForEncode ? previewFlags : [],
        subtitleActionSummary: selectedForEncode ? previewSummary : 'Nicht übernommen'
      };
    });

    return {
      ...title,
      encodeInput: isEncodeInput,
      selectedForEncode: isEncodeInput,
      audioTracks,
      subtitleTracks
    };
  });

  return {
    plan: {
      ...plan,
      titles: remappedTitles,
      manualTrackSelection: {
        titleId: encodeInputTitleId,
        audioTrackIds: requestedAudioTrackIds,
        subtitleTrackIds: requestedSubtitleTrackIds,
        updatedAt: nowIso()
      }
    },
    selectionApplied: true,
    audioTrackIds: requestedAudioTrackIds,
    subtitleTrackIds: requestedSubtitleTrackIds
  };
}

function extractHandBrakeTrackSelectionFromPlan(encodePlan, inputPath = null) {
  const plan = encodePlan && typeof encodePlan === 'object' ? encodePlan : null;
  if (!plan || !Array.isArray(plan.titles)) {
    return null;
  }

  const encodeInputTitleId = normalizeReviewTitleId(plan.encodeInputTitleId);
  let encodeTitle = null;

  if (encodeInputTitleId) {
    encodeTitle = plan.titles.find((title) => Number(title?.id) === encodeInputTitleId) || null;
  }
  if (!encodeTitle && inputPath) {
    encodeTitle = plan.titles.find((title) => String(title?.filePath || '') === String(inputPath || '')) || null;
  }

  if (!encodeTitle) {
    return null;
  }

  const audioTrackIds = normalizeTrackIdList(
    (Array.isArray(encodeTitle.audioTracks) ? encodeTitle.audioTracks : [])
      .filter((track) => Boolean(track?.selectedForEncode))
      .map((track) => track?.sourceTrackId ?? track?.id)
  );
  const subtitleTrackIds = normalizeTrackIdList(
    (Array.isArray(encodeTitle.subtitleTracks) ? encodeTitle.subtitleTracks : [])
      .filter((track) => Boolean(track?.selectedForEncode))
      .map((track) => track?.sourceTrackId ?? track?.id)
  );
  const selectedSubtitleTracks = (Array.isArray(encodeTitle.subtitleTracks) ? encodeTitle.subtitleTracks : [])
    .filter((track) => Boolean(track?.selectedForEncode));
  const subtitleBurnTrackId = normalizeTrackIdList(
    selectedSubtitleTracks.filter((track) => Boolean(track?.burnIn)).map((track) => track?.sourceTrackId ?? track?.id)
  )[0] || null;
  const subtitleDefaultTrackId = normalizeTrackIdList(
    selectedSubtitleTracks.filter((track) => Boolean(track?.defaultTrack)).map((track) => track?.sourceTrackId ?? track?.id)
  )[0] || null;
  const subtitleForcedTrackId = normalizeTrackIdList(
    selectedSubtitleTracks.filter((track) => Boolean(track?.forced)).map((track) => track?.sourceTrackId ?? track?.id)
  )[0] || null;
  const subtitleForcedOnly = selectedSubtitleTracks.some((track) => Boolean(track?.forcedOnly));

  return {
    titleId: Number(encodeTitle?.id) || null,
    audioTrackIds,
    subtitleTrackIds,
    subtitleBurnTrackId,
    subtitleDefaultTrackId,
    subtitleForcedTrackId,
    subtitleForcedOnly
  };
}

function buildPlaylistSegmentFileSet(playlistAnalysis, selectedPlaylistId = null) {
  const analysis = playlistAnalysis && typeof playlistAnalysis === 'object' ? playlistAnalysis : null;
  if (!analysis) {
    return new Set();
  }

  const segmentMap = analysis.playlistSegments && typeof analysis.playlistSegments === 'object'
    ? analysis.playlistSegments
    : {};

  const set = new Set();
  const appendSegments = (playlistIdRaw) => {
    const playlistId = normalizePlaylistId(playlistIdRaw);
    if (!playlistId) {
      return;
    }
    const segmentEntry = segmentMap[playlistId] || segmentMap[`${playlistId}.mpls`] || null;
    const segmentFiles = Array.isArray(segmentEntry?.segmentFiles) ? segmentEntry.segmentFiles : [];
    for (const file of segmentFiles) {
      const name = path.basename(String(file || '').trim()).toLowerCase();
      if (!name) {
        continue;
      }
      set.add(name);
    }
  };

  if (selectedPlaylistId) {
    appendSegments(selectedPlaylistId);
    return set;
  }

  appendSegments(analysis?.recommendation?.playlistId || null);
  if (set.size > 0) {
    return set;
  }

  const candidates = Array.isArray(analysis.evaluatedCandidates) ? analysis.evaluatedCandidates : [];
  for (const candidate of candidates) {
    appendSegments(candidate?.playlistId || null);
  }
  return set;
}


function collectRawMediaCandidates(rawPath, { playlistAnalysis = null, selectedPlaylistId = null } = {}) {
  const sourcePath = String(rawPath || '').trim();
  if (!sourcePath) {
    return {
      mediaFiles: [],
      source: 'none'
    };
  }

  try {
    const sourceStat = fs.statSync(sourcePath);
    if (sourceStat.isFile()) {
      const ext = path.extname(sourcePath).toLowerCase();
      if (
        ext === '.mkv'
        || ext === '.mp4'
        || isLikelyExtensionlessDvdImageFile(sourcePath, sourceStat.size)
      ) {
        return {
          mediaFiles: [{ path: sourcePath, size: Number(sourceStat.size || 0) }],
          source: ext === '' ? 'single_extensionless' : 'single_file'
        };
      }
      return {
        mediaFiles: [],
        source: 'none'
      };
    }
  } catch (_error) {
    return {
      mediaFiles: [],
      source: 'none'
    };
  }

  const topLevelExtensionlessImages = listTopLevelExtensionlessDvdImages(sourcePath);
  if (topLevelExtensionlessImages.length > 0) {
    return {
      mediaFiles: topLevelExtensionlessImages,
      source: 'dvd_image'
    };
  }

  const primary = findMediaFiles(sourcePath, ['.mkv', '.mp4']);
  if (primary.length > 0) {
    return {
      mediaFiles: primary,
      source: 'mkv'
    };
  }

  const streamDir = path.join(sourcePath, 'BDMV', 'STREAM');
  const backupRoot = fs.existsSync(streamDir) ? streamDir : sourcePath;
  let backupFiles = findMediaFiles(backupRoot, ['.m2ts']);
  if (backupFiles.length === 0) {
    const vobFiles = findMediaFiles(sourcePath, ['.vob']);
    if (vobFiles.length > 0) {
      return {
        mediaFiles: vobFiles,
        source: 'dvd'
      };
    }
    return {
      mediaFiles: [],
      source: 'none'
    };
  }

  const allowedSegments = buildPlaylistSegmentFileSet(playlistAnalysis, selectedPlaylistId);
  if (allowedSegments.size > 0) {
    const filtered = backupFiles.filter((file) => allowedSegments.has(path.basename(file.path).toLowerCase()));
    if (filtered.length > 0) {
      backupFiles = filtered;
    }
  }

  return {
    mediaFiles: backupFiles,
    source: 'backup'
  };
}

function hasBluRayBackupStructure(rawPath) {
  if (!rawPath) {
    return false;
  }

  const bdmvDir = path.join(rawPath, 'BDMV');
  const streamDir = path.join(bdmvDir, 'STREAM');

  try {
    return fs.existsSync(bdmvDir) && fs.existsSync(streamDir);
  } catch (_error) {
    return false;
  }
}

function findPreferredRawInput(rawPath, options = {}) {
  const { mediaFiles } = collectRawMediaCandidates(rawPath, options);
  if (!Array.isArray(mediaFiles) || mediaFiles.length === 0) {
    return null;
  }
  return mediaFiles[0];
}

function extractManualSelectionPayloadFromPlan(encodePlan) {
  const selection = extractHandBrakeTrackSelectionFromPlan(encodePlan);
  if (!selection) {
    return null;
  }
  return {
    audioTrackIds: normalizeTrackIdList(selection.audioTrackIds),
    subtitleTrackIds: normalizeTrackIdList(selection.subtitleTrackIds)
  };
}

function normalizeChainIdList(rawList) {
  const list = Array.isArray(rawList) ? rawList : [];
  const seen = new Set();
  const output = [];
  for (const item of list) {
    const value = Number(item);
    if (!Number.isFinite(value) || value <= 0) {
      continue;
    }
    const normalized = Math.trunc(value);
    const key = String(normalized);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    output.push(normalized);
  }
  return output;
}

function normalizeUserPresetForPlan(rawPreset) {
  if (!rawPreset || typeof rawPreset !== 'object') {
    return null;
  }
  const rawId = Number(rawPreset.id);
  const presetId = Number.isFinite(rawId) && rawId > 0 ? Math.trunc(rawId) : null;
  const name = String(rawPreset.name || '').trim();
  const handbrakePreset = String(rawPreset.handbrakePreset || '').trim();
  const extraArgs = String(rawPreset.extraArgs || '').trim();
  if (!presetId && !name && !handbrakePreset && !extraArgs) {
    return null;
  }
  return {
    id: presetId,
    name: name || (presetId ? `Preset #${presetId}` : 'User-Preset'),
    handbrakePreset: handbrakePreset || null,
    extraArgs: extraArgs || null
  };
}

function buildScriptDescriptorList(scriptIds, sourceScripts = []) {
  const normalizedIds = normalizeScriptIdList(scriptIds);
  if (normalizedIds.length === 0) {
    return [];
  }
  const source = Array.isArray(sourceScripts) ? sourceScripts : [];
  const namesById = new Map(
    source
      .map((item) => {
        const id = Number(item?.id ?? item?.scriptId);
        const normalizedId = Number.isFinite(id) && id > 0 ? Math.trunc(id) : null;
        const name = String(item?.name || '').trim();
        if (!normalizedId || !name) {
          return null;
        }
        return [normalizedId, name];
      })
      .filter(Boolean)
  );
  return normalizedIds.map((id) => ({
    id,
    name: namesById.get(id) || `Skript #${id}`
  }));
}

function findSelectedTitleInPlan(encodePlan) {
  if (!encodePlan || !Array.isArray(encodePlan.titles) || encodePlan.titles.length === 0) {
    return null;
  }
  const preferredTitleId = normalizeReviewTitleId(encodePlan.encodeInputTitleId);
  if (preferredTitleId) {
    const byId = encodePlan.titles.find((title) => normalizeReviewTitleId(title?.id) === preferredTitleId) || null;
    if (byId) {
      return byId;
    }
  }
  return encodePlan.titles.find((title) => Boolean(title?.selectedForEncode || title?.encodeInput)) || null;
}

function resolvePrefillEncodeTitleId(reviewPlan, previousPlan) {
  const reviewTitles = Array.isArray(reviewPlan?.titles) ? reviewPlan.titles : [];
  if (reviewTitles.length === 0) {
    return null;
  }

  const previousSelectedTitle = findSelectedTitleInPlan(previousPlan);
  if (!previousSelectedTitle) {
    return null;
  }

  const previousPlaylistId = normalizePlaylistId(
    previousSelectedTitle?.playlistId
    || previousPlan?.selectedPlaylistId
    || null
  );
  if (previousPlaylistId) {
    const byPlaylist = reviewTitles.find((title) => normalizePlaylistId(title?.playlistId) === previousPlaylistId) || null;
    const id = normalizeReviewTitleId(byPlaylist?.id);
    if (id) {
      return id;
    }
  }

  const previousMakemkvTitleId = normalizeNonNegativeInteger(
    previousSelectedTitle?.makemkvTitleId
    ?? previousPlan?.selectedMakemkvTitleId
    ?? null
  );
  if (previousMakemkvTitleId !== null) {
    const byMakemkvTitleId = reviewTitles.find((title) => (
      normalizeNonNegativeInteger(title?.makemkvTitleId) === previousMakemkvTitleId
    )) || null;
    const id = normalizeReviewTitleId(byMakemkvTitleId?.id);
    if (id) {
      return id;
    }
  }

  const previousFileName = path.basename(
    String(previousSelectedTitle?.filePath || previousSelectedTitle?.fileName || '').trim()
  ).toLowerCase();
  if (previousFileName) {
    const byFileName = reviewTitles.find((title) => {
      const candidate = path.basename(
        String(title?.filePath || title?.fileName || '').trim()
      ).toLowerCase();
      return candidate && candidate === previousFileName;
    }) || null;
    const id = normalizeReviewTitleId(byFileName?.id);
    if (id) {
      return id;
    }
  }

  const previousTitleId = normalizeReviewTitleId(previousPlan?.encodeInputTitleId);
  if (!previousTitleId) {
    return null;
  }
  const fallback = reviewTitles.find((title) => normalizeReviewTitleId(title?.id) === previousTitleId) || null;
  return normalizeReviewTitleId(fallback?.id);
}

function mapSelectedSourceTrackIdsToTargetTrackIds(targetTracks, sourceTrackIds, { excludeBurned = false } = {}) {
  const tracks = Array.isArray(targetTracks) ? targetTracks : [];
  const allowedTracks = excludeBurned
    ? tracks.filter((track) => !isBurnedSubtitleTrack(track))
    : tracks;
  const requested = normalizeTrackIdList(sourceTrackIds);
  if (requested.length === 0 || allowedTracks.length === 0) {
    return [];
  }

  const mapped = [];
  const seen = new Set();
  for (const sourceTrackId of requested) {
    const match = allowedTracks.find((track) => {
      const sourceId = normalizeTrackIdList([track?.sourceTrackId])[0] || null;
      const reviewId = normalizeTrackIdList([track?.id])[0] || null;
      return sourceId === sourceTrackId || reviewId === sourceTrackId;
    }) || null;
    const targetId = normalizeTrackIdList([match?.id])[0] || null;
    if (targetId === null) {
      continue;
    }
    const key = String(targetId);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    mapped.push(targetId);
  }
  return mapped;
}

function applyPreviousSelectionDefaultsToReviewPlan(reviewPlan, previousPlan = null) {
  const hasReviewTitles = reviewPlan && Array.isArray(reviewPlan?.titles) && reviewPlan.titles.length > 0;
  const hasPreviousTitles = previousPlan && Array.isArray(previousPlan?.titles) && previousPlan.titles.length > 0;
  if (!hasReviewTitles || !hasPreviousTitles) {
    return {
      plan: reviewPlan,
      applied: false,
      selectedEncodeTitleId: normalizeReviewTitleId(reviewPlan?.encodeInputTitleId),
      preEncodeScriptCount: 0,
      postEncodeScriptCount: 0,
      preEncodeChainCount: 0,
      postEncodeChainCount: 0,
      userPresetApplied: false
    };
  }

  let nextPlan = reviewPlan;
  const prefillTitleId = resolvePrefillEncodeTitleId(nextPlan, previousPlan);
  let selectedTitleApplied = false;
  if (prefillTitleId) {
    try {
      const remapped = applyEncodeTitleSelectionToPlan(nextPlan, prefillTitleId);
      nextPlan = remapped.plan;
      selectedTitleApplied = true;
    } catch (_error) {
      // Keep calculated review defaults when title from previous run is no longer available.
    }
  }

  const previousSelectedTitle = findSelectedTitleInPlan(previousPlan);
  const nextSelectedTitle = findSelectedTitleInPlan(nextPlan);
  let trackSelectionApplied = false;
  if (previousSelectedTitle && nextSelectedTitle) {
    const previousAudioSourceIds = normalizeTrackIdList(
      (Array.isArray(previousSelectedTitle?.audioTracks) ? previousSelectedTitle.audioTracks : [])
        .filter((track) => Boolean(track?.selectedForEncode))
        .map((track) => track?.sourceTrackId ?? track?.id)
    );
    const previousSubtitleSourceIds = normalizeTrackIdList(
      (Array.isArray(previousSelectedTitle?.subtitleTracks) ? previousSelectedTitle.subtitleTracks : [])
        .filter((track) => Boolean(track?.selectedForEncode))
        .map((track) => track?.sourceTrackId ?? track?.id)
    );

    const mappedAudioTrackIds = mapSelectedSourceTrackIdsToTargetTrackIds(
      nextSelectedTitle?.audioTracks,
      previousAudioSourceIds
    );
    const mappedSubtitleTrackIds = mapSelectedSourceTrackIdsToTargetTrackIds(
      nextSelectedTitle?.subtitleTracks,
      previousSubtitleSourceIds,
      { excludeBurned: true }
    );
    const fallbackAudioTrackIds = normalizeTrackIdList(
      (Array.isArray(nextSelectedTitle?.audioTracks) ? nextSelectedTitle.audioTracks : [])
        .filter((track) => Boolean(track?.selectedByRule))
        .map((track) => track?.id)
    );
    const fallbackSubtitleTrackIds = normalizeTrackIdList(
      (Array.isArray(nextSelectedTitle?.subtitleTracks) ? nextSelectedTitle.subtitleTracks : [])
        .filter((track) => Boolean(track?.selectedByRule) && !isBurnedSubtitleTrack(track))
        .map((track) => track?.id)
    );
    const effectiveAudioTrackIds = previousAudioSourceIds.length > 0 && mappedAudioTrackIds.length === 0
      ? fallbackAudioTrackIds
      : mappedAudioTrackIds;
    const effectiveSubtitleTrackIds = previousSubtitleSourceIds.length > 0 && mappedSubtitleTrackIds.length === 0
      ? fallbackSubtitleTrackIds
      : mappedSubtitleTrackIds;

    const targetTitleId = normalizeReviewTitleId(nextSelectedTitle?.id || nextPlan?.encodeInputTitleId);
    if (targetTitleId) {
      const trackSelectionResult = applyManualTrackSelectionToPlan(nextPlan, {
        [targetTitleId]: {
          audioTrackIds: effectiveAudioTrackIds,
          subtitleTrackIds: effectiveSubtitleTrackIds
        }
      });
      nextPlan = trackSelectionResult.plan;
      trackSelectionApplied = Boolean(trackSelectionResult.selectionApplied);
    }
  }

  const preEncodeScriptIds = normalizeScriptIdList(previousPlan?.preEncodeScriptIds || []);
  const postEncodeScriptIds = normalizeScriptIdList(previousPlan?.postEncodeScriptIds || []);
  const preEncodeChainIds = normalizeChainIdList(previousPlan?.preEncodeChainIds || []);
  const postEncodeChainIds = normalizeChainIdList(previousPlan?.postEncodeChainIds || []);
  const userPreset = normalizeUserPresetForPlan(previousPlan?.userPreset || null);

  nextPlan = {
    ...nextPlan,
    preEncodeScriptIds,
    postEncodeScriptIds,
    preEncodeScripts: buildScriptDescriptorList(preEncodeScriptIds, previousPlan?.preEncodeScripts || []),
    postEncodeScripts: buildScriptDescriptorList(postEncodeScriptIds, previousPlan?.postEncodeScripts || []),
    preEncodeChainIds,
    postEncodeChainIds,
    userPreset,
    reviewConfirmed: false,
    reviewConfirmedAt: null,
    prefilledFromPreviousRun: true,
    prefilledFromPreviousRunAt: nowIso()
  };

  const applied = selectedTitleApplied
    || trackSelectionApplied
    || preEncodeScriptIds.length > 0
    || postEncodeScriptIds.length > 0
    || preEncodeChainIds.length > 0
    || postEncodeChainIds.length > 0
    || Boolean(userPreset);

  return {
    plan: nextPlan,
    applied,
    selectedEncodeTitleId: normalizeReviewTitleId(nextPlan?.encodeInputTitleId),
    preEncodeScriptCount: preEncodeScriptIds.length,
    postEncodeScriptCount: postEncodeScriptIds.length,
    preEncodeChainCount: preEncodeChainIds.length,
    postEncodeChainCount: postEncodeChainIds.length,
    userPresetApplied: Boolean(userPreset)
  };
}

class PipelineService extends EventEmitter {
  constructor() {
    super();
    this.snapshot = {
      state: 'IDLE',
      activeJobId: null,
      progress: 0,
      eta: null,
      statusText: null,
      context: {}
    };
    this.detectedDisc = null;
    this.activeProcess = null;
    this.activeProcesses = new Map();
    this.cancelRequestedByJob = new Set();
    this.jobProgress = new Map();
    this.lastPersistAt = 0;
    this.lastProgressKey = null;
    this.queueEntries = [];
    this.queuePumpRunning = false;
    this.queueEntrySeq = 1;
    this.lastQueueSnapshot = {
      maxParallelJobs: 1,
      runningCount: 0,
      runningJobs: [],
      queuedJobs: [],
      queuedCount: 0,
      updatedAt: nowIso()
    };
  }

  isRipSuccessful(job = null) {
    if (Number(job?.rip_successful || 0) === 1) {
      return true;
    }
    if (isJobFinished(job)) {
      return true;
    }
    const mkInfo = this.safeParseJson(job?.makemkv_info_json);
    return String(mkInfo?.status || '').trim().toUpperCase() === 'SUCCESS';
  }

  isEncodeSuccessful(job = null) {
    const handBrakeInfo = this.safeParseJson(job?.handbrake_info_json);
    return String(handBrakeInfo?.status || '').trim().toUpperCase() === 'SUCCESS';
  }

  resolveDesiredRawFolderState(job = null) {
    if (!this.isRipSuccessful(job)) {
      return RAW_FOLDER_STATES.INCOMPLETE;
    }
    if (this.isEncodeSuccessful(job)) {
      return RAW_FOLDER_STATES.COMPLETE;
    }
    return RAW_FOLDER_STATES.RIP_COMPLETE;
  }

  resolveCurrentRawPath(rawBaseDir, storedRawPath, extraBaseDirs = []) {
    const stored = String(storedRawPath || '').trim();
    if (!stored) {
      return null;
    }
    const folderName = path.basename(stored);
    const currentBaseDir = path.dirname(stored);
    const allBaseDirs = [currentBaseDir, rawBaseDir, ...extraBaseDirs].filter(Boolean);
    const uniqueBaseDirs = Array.from(new Set(allBaseDirs.map((item) => String(item).trim()).filter(Boolean)));
    const variantFolderNames = Array.from(
      new Set(
        [
          folderName,
          applyRawFolderStateToName(folderName, RAW_FOLDER_STATES.RIP_COMPLETE),
          applyRawFolderStateToName(folderName, RAW_FOLDER_STATES.INCOMPLETE),
          applyRawFolderStateToName(folderName, RAW_FOLDER_STATES.COMPLETE)
        ].map((item) => String(item || '').trim()).filter(Boolean)
      )
    );
    const candidates = [];
    const pushCandidate = (candidatePath) => {
      const normalized = String(candidatePath || '').trim();
      if (!normalized || candidates.includes(normalized)) {
        return;
      }
      candidates.push(normalized);
    };
    pushCandidate(stored);
    for (const baseDir of uniqueBaseDirs) {
      for (const variantFolderName of variantFolderNames) {
        pushCandidate(path.join(baseDir, variantFolderName));
      }
    }
    const existingDirectories = [];
    for (const candidate of candidates) {
      try {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
          existingDirectories.push(candidate);
        }
      } catch (_error) {
        // ignore fs errors
      }
    }
    if (existingDirectories.length === 0) {
      return null;
    }

    for (const candidate of existingDirectories) {
      try {
        if (hasBluRayBackupStructure(candidate) || findPreferredRawInput(candidate)) {
          return candidate;
        }
      } catch (_error) {
        // ignore fs errors
      }
    }

    return existingDirectories[0];
  }

  buildRawPathLookupConfig(settingsMap = {}, mediaProfile = null) {
    const sourceMap = settingsMap && typeof settingsMap === 'object' ? settingsMap : {};
    const normalizedMediaProfile = normalizeMediaProfile(mediaProfile);
    const effectiveSettings = settingsService.resolveEffectiveToolSettings(sourceMap, normalizedMediaProfile);
    const preferredDefaultRawDir = normalizedMediaProfile === 'cd'
      ? settingsService.DEFAULT_CD_DIR
      : settingsService.DEFAULT_RAW_DIR;
    const uniqueRawDirs = Array.from(
      new Set(
        [
          effectiveSettings?.raw_dir,
          sourceMap?.raw_dir,
          sourceMap?.raw_dir_bluray,
          sourceMap?.raw_dir_dvd,
          sourceMap?.raw_dir_cd,
          preferredDefaultRawDir,
          settingsService.DEFAULT_RAW_DIR,
          settingsService.DEFAULT_CD_DIR
        ]
          .map((item) => String(item || '').trim())
          .filter(Boolean)
      )
    );

    return {
      effectiveSettings,
      rawBaseDir: uniqueRawDirs[0] || String(preferredDefaultRawDir || '').trim() || null,
      rawExtraDirs: uniqueRawDirs.slice(1)
    };
  }

  resolveCurrentRawPathForSettings(settingsMap = {}, mediaProfile = null, storedRawPath = null) {
    const stored = String(storedRawPath || '').trim();
    if (!stored) {
      return null;
    }
    const { rawBaseDir, rawExtraDirs } = this.buildRawPathLookupConfig(settingsMap, mediaProfile);
    return this.resolveCurrentRawPath(rawBaseDir, stored, rawExtraDirs);
  }

  async migrateRawFolderNamingOnStartup(db) {
    const settings = await settingsService.getSettingsMap();
    const rawBaseDir = String(settings?.raw_dir || settingsService.DEFAULT_RAW_DIR || '').trim();
    const rawExtraDirs = [
      settings?.raw_dir_bluray,
      settings?.raw_dir_dvd,
      settings?.raw_dir_cd,
      settingsService.DEFAULT_CD_DIR
    ].map((d) => String(d || '').trim()).filter(Boolean);
    const allRawDirs = [rawBaseDir, settingsService.DEFAULT_RAW_DIR, ...rawExtraDirs]
      .filter((d, i, arr) => arr.indexOf(d) === i && d && fs.existsSync(d));
    if (allRawDirs.length === 0) {
      return;
    }

    const rows = await db.all(`
      SELECT id, title, year, detected_title, raw_path, status, last_state, rip_successful, makemkv_info_json, handbrake_info_json
      FROM jobs
      WHERE raw_path IS NOT NULL AND TRIM(raw_path) <> ''
    `);
    if (!Array.isArray(rows) || rows.length === 0) {
      return;
    }

    let renamedCount = 0;
    let pathUpdateCount = 0;
    let ripFlagUpdateCount = 0;
    let conflictCount = 0;
    let missingCount = 0;
    const discoveredByJobId = new Map();

    for (const scanDir of allRawDirs) {
      try {
        const dirEntries = fs.readdirSync(scanDir, { withFileTypes: true });
        for (const entry of dirEntries) {
          if (!entry.isDirectory()) {
            continue;
          }
          const match = String(entry.name || '').match(/-\s*RAW\s*-\s*job-(\d+)\s*$/i);
          if (!match) {
            continue;
          }
          const mappedJobId = Number(match[1]);
          if (!Number.isFinite(mappedJobId) || mappedJobId <= 0) {
            continue;
          }
          const candidatePath = path.join(scanDir, entry.name);
          let mtimeMs = 0;
          try {
            mtimeMs = Number(fs.statSync(candidatePath).mtimeMs || 0);
          } catch (_error) {
            // ignore fs errors and keep zero mtime
          }
          const current = discoveredByJobId.get(mappedJobId);
          if (!current || mtimeMs > current.mtimeMs) {
            discoveredByJobId.set(mappedJobId, {
              path: candidatePath,
              mtimeMs
            });
          }
        }
      } catch (scanError) {
        logger.warn('startup:raw-dir-migrate:scan-failed', {
          scanDir,
          error: errorToMeta(scanError)
        });
      }
    }

    for (const row of rows) {
      const jobId = Number(row?.id);
      if (!Number.isFinite(jobId) || jobId <= 0) {
        continue;
      }

      const ripSuccessful = this.isRipSuccessful(row);
      if (ripSuccessful && Number(row?.rip_successful || 0) !== 1) {
        await historyService.updateJob(jobId, { rip_successful: 1 });
        ripFlagUpdateCount += 1;
      }

      const currentRawPath = this.resolveCurrentRawPath(rawBaseDir, row.raw_path, rawExtraDirs)
        || discoveredByJobId.get(jobId)?.path
        || null;
      if (!currentRawPath) {
        missingCount += 1;
        continue;
      }

      // Keep renamed folder in the same base dir as the current path
      const currentBaseDir = path.dirname(currentRawPath);
      const currentFolderName = stripRawStatePrefix(path.basename(currentRawPath));
      const folderYearMatch = currentFolderName.match(/\((19|20)\d{2}\)/);
      const fallbackYear = folderYearMatch
        ? Number(String(folderYearMatch[0]).replace(/[()]/g, ''))
        : null;
      const metadataBase = buildRawMetadataBase({
        title: row.title || row.detected_title || null,
        year: row.year || null,
        fallbackYear
      }, jobId);
      const desiredRawFolderState = this.resolveDesiredRawFolderState(row);
      const desiredRawPath = path.join(
        currentBaseDir,
        buildRawDirName(metadataBase, jobId, { state: desiredRawFolderState })
      );

      let finalRawPath = currentRawPath;
      if (normalizeComparablePath(currentRawPath) !== normalizeComparablePath(desiredRawPath)) {
        if (fs.existsSync(desiredRawPath)) {
          conflictCount += 1;
          logger.warn('startup:raw-dir-migrate:target-exists', {
            jobId,
            currentRawPath,
            desiredRawPath
          });
        } else {
          try {
            fs.renameSync(currentRawPath, desiredRawPath);
            finalRawPath = desiredRawPath;
            renamedCount += 1;
          } catch (renameError) {
            logger.warn('startup:raw-dir-migrate:rename-failed', {
              jobId,
              currentRawPath,
              desiredRawPath,
              error: errorToMeta(renameError)
            });
            continue;
          }
        }
      }

      if (normalizeComparablePath(row.raw_path) !== normalizeComparablePath(finalRawPath)) {
        await historyService.updateRawPathByOldPath(row.raw_path, finalRawPath);
        pathUpdateCount += 1;
      }
    }

    if (renamedCount > 0 || pathUpdateCount > 0 || ripFlagUpdateCount > 0 || conflictCount > 0 || missingCount > 0) {
      logger.info('startup:raw-dir-migrate:done', {
        renamedCount,
        pathUpdateCount,
        ripFlagUpdateCount,
        conflictCount,
        missingCount,
        scannedDirs: allRawDirs
      });
    }
  }

  async init() {
    const db = await getDb();
    try {
      await this.migrateRawFolderNamingOnStartup(db);
    } catch (migrationError) {
      logger.warn('init:raw-dir-migrate-failed', {
        error: errorToMeta(migrationError)
      });
    }
    const row = await db.get('SELECT * FROM pipeline_state WHERE id = 1');

    if (row) {
      this.snapshot = {
        state: row.state,
        activeJobId: row.active_job_id,
        progress: Number(row.progress || 0),
        eta: row.eta,
        statusText: row.status_text,
        context: this.safeParseJson(row.context_json)
      };
      logger.info('init:loaded-snapshot', { snapshot: this.snapshot });
    }

    try {
      await this.recoverStaleRunningJobsOnStartup(db);
    } catch (recoveryError) {
      logger.warn('init:stale-running-recovery-failed', {
        error: errorToMeta(recoveryError)
      });
    }

    // Always start with a clean dashboard/session snapshot after server restart.
    const hasContextKeys = this.snapshot.context
      && typeof this.snapshot.context === 'object'
      && Object.keys(this.snapshot.context).length > 0;
    if (this.snapshot.state !== 'IDLE' || this.snapshot.activeJobId || hasContextKeys) {
      await this.resetFrontendState('server_restart', {
        force: true,
        keepDetectedDevice: false
      });
    }
    await this.emitQueueChanged();
    void this.pumpQueue();
  }

  async recoverStaleRunningJobsOnStartup(db) {
    const staleRows = await db.all(`
      SELECT id, status, last_state
      FROM jobs
      WHERE status IN ('ANALYZING', 'RIPPING', 'MEDIAINFO_CHECK', 'ENCODING')
      ORDER BY updated_at ASC, id ASC
    `);
    const rows = Array.isArray(staleRows) ? staleRows : [];
    if (rows.length === 0) {
      return {
        scanned: 0,
        preparedReadyToEncode: 0,
        markedError: 0,
        skipped: 0
      };
    }

    let preparedReadyToEncode = 0;
    let markedError = 0;
    let skipped = 0;

    for (const row of rows) {
      const jobId = this.normalizeQueueJobId(row?.id);
      if (!jobId) {
        skipped += 1;
        continue;
      }
      const rawStage = String(row?.status || row?.last_state || '').trim().toUpperCase();
      const stage = RUNNING_STATES.has(rawStage) ? rawStage : 'ENCODING';
      const message = `Server-Neustart erkannt während ${stage}. Laufender Prozess wurde beendet.`;

      if (stage === 'ENCODING') {
        try {
          await historyService.appendLog(jobId, 'SYSTEM', message);
        } catch (_error) {
          // keep recovery path even if log append fails
        }
        try {
          await this.restartEncodeWithLastSettings(jobId, {
            immediate: true,
            triggerReason: 'server_restart'
          });
          preparedReadyToEncode += 1;
          continue;
        } catch (error) {
          logger.warn('startup:recover-stale-encoding:restart-failed', {
            jobId,
            error: errorToMeta(error)
          });
          try {
            await historyService.appendLog(
              jobId,
              'SYSTEM',
              `Startup-Recovery Encode fehlgeschlagen, setze Job auf ERROR: ${error?.message || 'unknown'}`
            );
          } catch (_logError) {
            // ignore logging fallback errors
          }
        }
      }

      await historyService.updateJobStatus(jobId, 'ERROR', {
        end_time: nowIso(),
        error_message: message
      });
      try {
        await historyService.appendLog(jobId, 'SYSTEM', message);
      } catch (_error) {
        // ignore logging failures during startup recovery
      }
      markedError += 1;
    }

    logger.warn('startup:recover-stale-running-jobs', {
      scanned: rows.length,
      preparedReadyToEncode,
      markedError,
      skipped
    });
    return {
      scanned: rows.length,
      preparedReadyToEncode,
      markedError,
      skipped
    };
  }

  safeParseJson(raw) {
    if (!raw) {
      return {};
    }

    try {
      return JSON.parse(raw);
    } catch (error) {
      logger.warn('safeParseJson:failed', { raw, error: errorToMeta(error) });
      return {};
    }
  }

  getSnapshot() {
    const jobProgress = {};
    for (const [id, data] of this.jobProgress) {
      jobProgress[id] = data;
    }
    return {
      ...this.snapshot,
      jobProgress,
      queue: this.lastQueueSnapshot
    };
  }

  normalizeParallelJobsLimit(rawValue) {
    const value = Number(rawValue);
    if (!Number.isFinite(value) || value < 1) {
      return 1;
    }
    return Math.max(1, Math.min(12, Math.trunc(value)));
  }

  normalizeQueueJobId(rawValue) {
    const value = Number(rawValue);
    if (!Number.isFinite(value) || value <= 0) {
      return null;
    }
    return Math.trunc(value);
  }

  isJobRunningStatus(status) {
    return RUNNING_STATES.has(String(status || '').trim().toUpperCase());
  }

  syncPrimaryActiveProcess() {
    if (this.activeProcesses.size === 0) {
      this.activeProcess = null;
      return;
    }
    const first = Array.from(this.activeProcesses.values())[0] || null;
    this.activeProcess = first;
  }

  async getMaxParallelJobs() {
    const settings = await settingsService.getSettingsMap();
    return this.normalizeParallelJobsLimit(settings?.pipeline_max_parallel_jobs);
  }

  async getMaxParallelCdEncodes() {
    const settings = await settingsService.getSettingsMap();
    return this.normalizeParallelJobsLimit(settings?.pipeline_max_parallel_cd_encodes ?? 2);
  }

  async getMaxTotalEncodes() {
    const settings = await settingsService.getSettingsMap();
    const value = Number(settings?.pipeline_max_total_encodes);
    return Number.isFinite(value) && value >= 1 ? Math.min(24, Math.trunc(value)) : 3;
  }

  async getCdBypassesQueue() {
    const settings = await settingsService.getSettingsMap();
    const value = settings?.pipeline_cd_bypasses_queue;
    return value === 'true' || value === true;
  }

  findQueueEntryIndexByJobId(jobId) {
    return this.queueEntries.findIndex((entry) => Number(entry?.jobId) === Number(jobId));
  }

  normalizeQueueChainIdList(rawList) {
    const list = Array.isArray(rawList) ? rawList : [];
    const seen = new Set();
    const output = [];
    for (const item of list) {
      const value = Number(item);
      if (!Number.isFinite(value) || value <= 0) {
        continue;
      }
      const normalized = Math.trunc(value);
      const key = String(normalized);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      output.push(normalized);
    }
    return output;
  }

  extractQueueJobPlan(row) {
    const source = row && typeof row === 'object' ? row : null;
    if (!source) {
      return null;
    }
    if (source.encodePlan && typeof source.encodePlan === 'object') {
      return source.encodePlan;
    }
    if (source.encode_plan_json) {
      try {
        const parsed = JSON.parse(source.encode_plan_json);
        if (parsed && typeof parsed === 'object') {
          return parsed;
        }
      } catch (_) {
        // ignore parse errors for queue decorations
      }
    }
    return null;
  }

  async buildQueueJobScriptMeta(rows = []) {
    const list = Array.isArray(rows) ? rows : [];
    const byJobId = new Map();
    const allScriptIds = new Set();
    const allChainIds = new Set();
    const scriptNameHints = new Map();
    const chainNameHints = new Map();

    const addScriptHints = (items) => {
      for (const item of (Array.isArray(items) ? items : [])) {
        if (!item || typeof item !== 'object') {
          continue;
        }
        const id = normalizeScriptIdList([item.id ?? item.scriptId])[0] || null;
        const name = String(item.name || item.scriptName || '').trim();
        if (!id) {
          continue;
        }
        allScriptIds.add(id);
        if (name) {
          scriptNameHints.set(id, name);
        }
      }
    };

    const addChainHints = (items) => {
      for (const item of (Array.isArray(items) ? items : [])) {
        if (!item || typeof item !== 'object') {
          continue;
        }
        const id = this.normalizeQueueChainIdList([item.id ?? item.chainId])[0] || null;
        const name = String(item.name || item.chainName || '').trim();
        if (!id) {
          continue;
        }
        allChainIds.add(id);
        if (name) {
          chainNameHints.set(id, name);
        }
      }
    };

    for (const row of list) {
      const jobId = this.normalizeQueueJobId(row?.id);
      if (!jobId) {
        continue;
      }
      const plan = this.extractQueueJobPlan(row);
      if (!plan) {
        continue;
      }

      const preScriptIds = normalizeScriptIdList([
        ...normalizeScriptIdList(plan?.preEncodeScriptIds || []),
        ...normalizeScriptIdList((Array.isArray(plan?.preEncodeScripts) ? plan.preEncodeScripts : []).map((item) => item?.id ?? item?.scriptId))
      ]);
      const postScriptIds = normalizeScriptIdList([
        ...normalizeScriptIdList(plan?.postEncodeScriptIds || []),
        ...normalizeScriptIdList((Array.isArray(plan?.postEncodeScripts) ? plan.postEncodeScripts : []).map((item) => item?.id ?? item?.scriptId))
      ]);
      const preChainIds = this.normalizeQueueChainIdList([
        ...this.normalizeQueueChainIdList(plan?.preEncodeChainIds || []),
        ...this.normalizeQueueChainIdList((Array.isArray(plan?.preEncodeChains) ? plan.preEncodeChains : []).map((item) => item?.id ?? item?.chainId))
      ]);
      const postChainIds = this.normalizeQueueChainIdList([
        ...this.normalizeQueueChainIdList(plan?.postEncodeChainIds || []),
        ...this.normalizeQueueChainIdList((Array.isArray(plan?.postEncodeChains) ? plan.postEncodeChains : []).map((item) => item?.id ?? item?.chainId))
      ]);

      addScriptHints(plan?.preEncodeScripts);
      addScriptHints(plan?.postEncodeScripts);
      addChainHints(plan?.preEncodeChains);
      addChainHints(plan?.postEncodeChains);

      for (const id of preScriptIds) allScriptIds.add(id);
      for (const id of postScriptIds) allScriptIds.add(id);
      for (const id of preChainIds) allChainIds.add(id);
      for (const id of postChainIds) allChainIds.add(id);

      byJobId.set(jobId, {
        preScriptIds,
        postScriptIds,
        preChainIds,
        postChainIds
      });
    }

    if (byJobId.size === 0) {
      return new Map();
    }

    const scriptNameById = new Map();
    const chainNameById = new Map();
    for (const [id, name] of scriptNameHints.entries()) {
      scriptNameById.set(id, name);
    }
    for (const [id, name] of chainNameHints.entries()) {
      chainNameById.set(id, name);
    }

    if (allScriptIds.size > 0) {
      const scriptService = require('./scriptService');
      try {
        const scripts = await scriptService.resolveScriptsByIds(Array.from(allScriptIds), { strict: false });
        for (const script of scripts) {
          const id = Number(script?.id);
          const name = String(script?.name || '').trim();
          if (Number.isFinite(id) && id > 0 && name) {
            scriptNameById.set(id, name);
          }
        }
      } catch (error) {
        logger.warn('queue:script-summary:resolve-failed', { error: errorToMeta(error) });
      }
    }

    if (allChainIds.size > 0) {
      const scriptChainService = require('./scriptChainService');
      try {
        const chains = await scriptChainService.getChainsByIds(Array.from(allChainIds));
        for (const chain of chains) {
          const id = Number(chain?.id);
          const name = String(chain?.name || '').trim();
          if (Number.isFinite(id) && id > 0 && name) {
            chainNameById.set(id, name);
          }
        }
      } catch (error) {
        logger.warn('queue:chain-summary:resolve-failed', { error: errorToMeta(error) });
      }
    }

    const output = new Map();
    for (const [jobId, data] of byJobId.entries()) {
      const preScripts = data.preScriptIds.map((id) => scriptNameById.get(id) || `Skript #${id}`);
      const postScripts = data.postScriptIds.map((id) => scriptNameById.get(id) || `Skript #${id}`);
      const preChains = data.preChainIds.map((id) => chainNameById.get(id) || `Kette #${id}`);
      const postChains = data.postChainIds.map((id) => chainNameById.get(id) || `Kette #${id}`);
      const hasScripts = preScripts.length > 0 || postScripts.length > 0;
      const hasChains = preChains.length > 0 || postChains.length > 0;
      output.set(jobId, {
        hasScripts,
        hasChains,
        summary: {
          preScripts,
          postScripts,
          preChains,
          postChains
        }
      });
    }
    return output;
  }

  async getQueueSnapshot() {
    const [maxParallelJobs, maxParallelCdEncodes, maxTotalEncodes, cdBypassesQueue] = await Promise.all([
      this.getMaxParallelJobs(),
      this.getMaxParallelCdEncodes(),
      this.getMaxTotalEncodes(),
      this.getCdBypassesQueue()
    ]);
    const runningJobs = await historyService.getRunningJobs();
    const runningEncodeCount = runningJobs.filter((job) => job.status === 'ENCODING').length;
    const runningCdCount = runningJobs.filter((job) => ['CD_RIPPING', 'CD_ENCODING'].includes(job.status)).length;
    const queuedJobIds = this.queueEntries
      .filter((entry) => !entry.type || entry.type === 'job')
      .map((entry) => Number(entry.jobId))
      .filter((id) => Number.isFinite(id) && id > 0);
    const queuedRows = queuedJobIds.length > 0
      ? await historyService.getJobsByIds(queuedJobIds)
      : [];
    const queuedById = new Map(queuedRows.map((row) => [Number(row.id), row]));
    const scriptMetaByJobId = await this.buildQueueJobScriptMeta(
      Array.from(
        new Map(
          [...runningJobs, ...queuedRows].map((row) => [Number(row?.id), row])
        ).values()
      )
    );

    const queue = {
      maxParallelJobs,
      maxParallelCdEncodes,
      maxTotalEncodes,
      cdBypassesQueue,
      runningCount: runningEncodeCount,
      runningCdCount,
      runningJobs: runningJobs.map((job) => ({
        jobId: Number(job.id),
        title: job.title || job.detected_title || `Job #${job.id}`,
        status: job.status,
        lastState: job.last_state || null,
        hasScripts: Boolean(scriptMetaByJobId.get(Number(job.id))?.hasScripts),
        hasChains: Boolean(scriptMetaByJobId.get(Number(job.id))?.hasChains),
        scriptSummary: scriptMetaByJobId.get(Number(job.id))?.summary || null
      })),
      queuedJobs: this.queueEntries.map((entry, index) => {
        const entryType = entry.type || 'job';
        const base = {
          entryId: entry.id,
          position: index + 1,
          type: entryType,
          enqueuedAt: entry.enqueuedAt
        };

        if (entryType === 'script') {
          return { ...base, scriptId: entry.scriptId, title: entry.scriptName || `Skript #${entry.scriptId}`, status: 'QUEUED' };
        }
        if (entryType === 'chain') {
          return { ...base, chainId: entry.chainId, title: entry.chainName || `Kette #${entry.chainId}`, status: 'QUEUED' };
        }
        if (entryType === 'wait') {
          return { ...base, waitSeconds: entry.waitSeconds, title: `Warten ${entry.waitSeconds}s`, status: 'QUEUED' };
        }

        // type === 'job'
        const row = queuedById.get(Number(entry.jobId));
        const scriptMeta = scriptMetaByJobId.get(Number(entry.jobId)) || null;
        return {
          ...base,
          jobId: Number(entry.jobId),
          action: entry.action,
          actionLabel: QUEUE_ACTION_LABELS[entry.action] || entry.action,
          title: row?.title || row?.detected_title || `Job #${entry.jobId}`,
          status: row?.status || null,
          lastState: row?.last_state || null,
          hasScripts: Boolean(scriptMeta?.hasScripts),
          hasChains: Boolean(scriptMeta?.hasChains),
          scriptSummary: scriptMeta?.summary || null
        };
      }),
      queuedCount: this.queueEntries.length,
      updatedAt: nowIso()
    };

    return queue;
  }

  async emitQueueChanged() {
    try {
      this.lastQueueSnapshot = await this.getQueueSnapshot();
      wsService.broadcast('PIPELINE_QUEUE_CHANGED', this.lastQueueSnapshot);
    } catch (error) {
      logger.warn('queue:emit:failed', { error: errorToMeta(error) });
    }
  }

  async reorderQueue(orderedEntryIds = []) {
    const incoming = Array.isArray(orderedEntryIds)
      ? orderedEntryIds.map((value) => Number(value)).filter((v) => Number.isFinite(v) && v > 0)
      : [];
    if (incoming.length !== this.queueEntries.length) {
      const error = new Error('Queue-Reihenfolge ungültig: Anzahl passt nicht.');
      error.statusCode = 400;
      throw error;
    }

    const currentIdSet = new Set(this.queueEntries.map((entry) => entry.id));
    const incomingSet = new Set(incoming);
    if (incomingSet.size !== incoming.length || incoming.some((id) => !currentIdSet.has(id))) {
      const error = new Error('Queue-Reihenfolge ungültig: IDs passen nicht zur aktuellen Queue.');
      error.statusCode = 400;
      throw error;
    }

    const byEntryId = new Map(this.queueEntries.map((entry) => [entry.id, entry]));
    this.queueEntries = incoming.map((id) => byEntryId.get(id)).filter(Boolean);
    await this.emitQueueChanged();
    return this.lastQueueSnapshot;
  }

  async enqueueNonJobEntry(type, params = {}, insertAfterEntryId = null) {
    const validTypes = new Set(['script', 'chain', 'wait']);
    if (!validTypes.has(type)) {
      const error = new Error(`Unbekannter Queue-Eintragstyp: ${type}`);
      error.statusCode = 400;
      throw error;
    }

    let entry;
    if (type === 'script') {
      const scriptId = Number(params.scriptId);
      if (!Number.isFinite(scriptId) || scriptId <= 0) {
        const error = new Error('scriptId fehlt oder ist ungültig.');
        error.statusCode = 400;
        throw error;
      }
      const scriptService = require('./scriptService');
      let script;
      try { script = await scriptService.getScriptById(scriptId); } catch (_) { /* ignore */ }
      entry = { id: this.queueEntrySeq++, type: 'script', scriptId, scriptName: script?.name || null, enqueuedAt: nowIso() };
    } else if (type === 'chain') {
      const chainId = Number(params.chainId);
      if (!Number.isFinite(chainId) || chainId <= 0) {
        const error = new Error('chainId fehlt oder ist ungültig.');
        error.statusCode = 400;
        throw error;
      }
      const scriptChainService = require('./scriptChainService');
      let chain;
      try { chain = await scriptChainService.getChainById(chainId); } catch (_) { /* ignore */ }
      entry = { id: this.queueEntrySeq++, type: 'chain', chainId, chainName: chain?.name || null, enqueuedAt: nowIso() };
    } else {
      const waitSeconds = Math.round(Number(params.waitSeconds));
      if (!Number.isFinite(waitSeconds) || waitSeconds < 1 || waitSeconds > 3600) {
        const error = new Error('waitSeconds muss zwischen 1 und 3600 liegen.');
        error.statusCode = 400;
        throw error;
      }
      entry = { id: this.queueEntrySeq++, type: 'wait', waitSeconds, enqueuedAt: nowIso() };
    }

    if (insertAfterEntryId != null) {
      const idx = this.queueEntries.findIndex((e) => e.id === Number(insertAfterEntryId));
      if (idx >= 0) {
        this.queueEntries.splice(idx + 1, 0, entry);
      } else {
        this.queueEntries.push(entry);
      }
    } else {
      this.queueEntries.push(entry);
    }

    await this.emitQueueChanged();
    void this.pumpQueue();
    return { entryId: entry.id, type, position: this.queueEntries.indexOf(entry) + 1 };
  }

  async removeQueueEntry(entryId) {
    const normalizedId = Number(entryId);
    if (!Number.isFinite(normalizedId) || normalizedId <= 0) {
      const error = new Error('Ungültige entryId.');
      error.statusCode = 400;
      throw error;
    }
    const idx = this.queueEntries.findIndex((e) => e.id === normalizedId);
    if (idx < 0) {
      const error = new Error(`Queue-Eintrag #${normalizedId} nicht gefunden.`);
      error.statusCode = 404;
      throw error;
    }
    this.queueEntries.splice(idx, 1);
    await this.emitQueueChanged();
    return this.lastQueueSnapshot;
  }

  async enqueueOrStartAction(action, jobId, startNow) {
    const normalizedJobId = this.normalizeQueueJobId(jobId);
    if (!normalizedJobId) {
      const error = new Error('Ungültige Job-ID für Queue-Aktion.');
      error.statusCode = 400;
      throw error;
    }
    if (!Object.values(QUEUE_ACTIONS).includes(action)) {
      const error = new Error(`Unbekannte Queue-Aktion '${action}'.`);
      error.statusCode = 400;
      throw error;
    }
    if (typeof startNow !== 'function') {
      const error = new Error('Queue-Aktion kann nicht gestartet werden (startNow fehlt).');
      error.statusCode = 500;
      throw error;
    }

    const existingQueueIndex = this.findQueueEntryIndexByJobId(normalizedJobId);
    if (existingQueueIndex >= 0) {
      return {
        queued: true,
        started: false,
        queuePosition: existingQueueIndex + 1,
        action
      };
    }

    const [maxFilm, maxTotal] = await Promise.all([
      this.getMaxParallelJobs(),
      this.getMaxTotalEncodes()
    ]);
    const [filmRunning, cdRunning] = await Promise.all([
      historyService.getRunningFilmEncodeJobs().then((r) => r.length),
      historyService.getRunningCdEncodeJobs().then((r) => r.length)
    ]);
    const totalRunning = filmRunning + cdRunning;
    const shouldQueue = this.queueEntries.length > 0 || filmRunning >= maxFilm || totalRunning >= maxTotal;
    if (!shouldQueue) {
      const result = await startNow();
      await this.emitQueueChanged();
      return {
        queued: false,
        started: true,
        action,
        ...(result && typeof result === 'object' ? result : {})
      };
    }

    this.queueEntries.push({
      id: this.queueEntrySeq++,
      jobId: normalizedJobId,
      action,
      enqueuedAt: nowIso()
    });
    await historyService.appendLog(
      normalizedJobId,
      'USER_ACTION',
      `In Queue aufgenommen: ${QUEUE_ACTION_LABELS[action] || action}`
    );
    await this.emitQueueChanged();
    void this.pumpQueue();

    return {
      queued: true,
      started: false,
      queuePosition: this.queueEntries.length,
      action
    };
  }

  async enqueueOrStartCdAction(jobId, ripConfig, startNow) {
    const normalizedJobId = this.normalizeQueueJobId(jobId);
    if (!normalizedJobId) {
      const error = new Error('Ungültige Job-ID für CD Queue-Aktion.');
      error.statusCode = 400;
      throw error;
    }
    if (typeof startNow !== 'function') {
      const error = new Error('CD Queue-Aktion kann nicht gestartet werden (startNow fehlt).');
      error.statusCode = 500;
      throw error;
    }

    const existingQueueIndex = this.findQueueEntryIndexByJobId(normalizedJobId);
    if (existingQueueIndex >= 0) {
      return {
        queued: true,
        started: false,
        queuePosition: existingQueueIndex + 1,
        action: QUEUE_ACTIONS.START_CD
      };
    }

    const [maxCd, maxTotal, cdBypass] = await Promise.all([
      this.getMaxParallelCdEncodes(),
      this.getMaxTotalEncodes(),
      this.getCdBypassesQueue()
    ]);
    const [filmRunning, cdRunning] = await Promise.all([
      historyService.getRunningFilmEncodeJobs().then((r) => r.length),
      historyService.getRunningCdEncodeJobs().then((r) => r.length)
    ]);
    const totalRunning = filmRunning + cdRunning;

    let shouldQueue;
    if (cdBypass) {
      const cdQueueLength = this.queueEntries.filter(
        (e) => (!e.type || e.type === 'job') && e.action === QUEUE_ACTIONS.START_CD
      ).length;
      shouldQueue = cdQueueLength > 0 || cdRunning >= maxCd || totalRunning >= maxTotal;
    } else {
      shouldQueue = this.queueEntries.length > 0 || cdRunning >= maxCd || totalRunning >= maxTotal;
    }

    if (!shouldQueue) {
      const result = await startNow();
      await this.emitQueueChanged();
      return {
        queued: false,
        started: true,
        action: QUEUE_ACTIONS.START_CD,
        ...(result && typeof result === 'object' ? result : {})
      };
    }

    this.queueEntries.push({
      id: this.queueEntrySeq++,
      jobId: normalizedJobId,
      action: QUEUE_ACTIONS.START_CD,
      ripConfig: ripConfig || {},
      enqueuedAt: nowIso()
    });
    await historyService.appendLog(
      normalizedJobId,
      'USER_ACTION',
      `In Queue aufgenommen: ${QUEUE_ACTION_LABELS[QUEUE_ACTIONS.START_CD]}`
    );
    await this.emitQueueChanged();
    void this.pumpQueue();

    return {
      queued: true,
      started: false,
      queuePosition: this.queueEntries.length,
      action: QUEUE_ACTIONS.START_CD
    };
  }

  async dispatchNonJobEntry(entry) {
    const type = entry?.type;
    logger.info('queue:non-job:dispatch', { type, entryId: entry?.id });

    if (type === 'wait') {
      const seconds = Math.max(1, Number(entry.waitSeconds || 1));
      logger.info('queue:wait:start', { seconds });
      await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
      logger.info('queue:wait:done', { seconds });
      return;
    }

    if (type === 'script') {
      const scriptService = require('./scriptService');
      let script;
      try { script = await scriptService.getScriptById(entry.scriptId); } catch (_) { /* ignore */ }
      if (!script) {
        logger.warn('queue:script:not-found', { scriptId: entry.scriptId });
        return;
      }
      const activityId = runtimeActivityService.startActivity('script', {
        name: script.name,
        source: 'queue',
        scriptId: script.id,
        currentStep: 'Queue-Ausfuehrung'
      });
      let prepared = null;
      try {
        prepared = await scriptService.createExecutableScriptFile(script, { source: 'queue', scriptId: script.id, scriptName: script.name });
        const { spawn } = require('child_process');
        await new Promise((resolve, reject) => {
          const child = spawn(prepared.cmd, prepared.args, { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
          let stdout = '';
          let stderr = '';
          child.stdout?.on('data', (chunk) => {
            stdout += String(chunk);
            if (stdout.length > 12000) {
              stdout = `${stdout.slice(0, 12000)}\n...[truncated]`;
            }
          });
          child.stderr?.on('data', (chunk) => {
            stderr += String(chunk);
            if (stderr.length > 12000) {
              stderr = `${stderr.slice(0, 12000)}\n...[truncated]`;
            }
          });
          child.on('error', reject);
          child.on('close', (code) => {
            logger.info('queue:script:done', { scriptId: script.id, exitCode: code });
            const output = [stdout, stderr].filter(Boolean).join('\n').trim();
            const success = Number(code) === 0;
            runtimeActivityService.completeActivity(activityId, {
              status: success ? 'success' : 'error',
              success,
              outcome: success ? 'success' : 'error',
              exitCode: Number.isFinite(Number(code)) ? Number(code) : null,
              message: success ? 'Queue-Skript abgeschlossen' : `Queue-Skript fehlgeschlagen (Exit ${code})`,
              output: output || null,
              stdout: stdout || null,
              stderr: stderr || null,
              errorMessage: success ? null : `Queue-Skript fehlgeschlagen (Exit ${code})`
            });
            resolve();
          });
        });
      } catch (err) {
        runtimeActivityService.completeActivity(activityId, {
          status: 'error',
          success: false,
          outcome: 'error',
          message: err?.message || 'Queue-Skript Fehler',
          errorMessage: err?.message || 'Queue-Skript Fehler'
        });
        logger.error('queue:script:error', { scriptId: entry.scriptId, error: errorToMeta(err) });
      } finally {
        if (prepared?.cleanup) await prepared.cleanup();
      }
      return;
    }

    if (type === 'chain') {
      const scriptChainService = require('./scriptChainService');
      try {
        await scriptChainService.executeChain(entry.chainId, { source: 'queue' });
      } catch (err) {
        logger.error('queue:chain:error', { chainId: entry.chainId, error: errorToMeta(err) });
      }
    }
  }

  async dispatchQueuedEntry(entry) {
    const action = entry?.action;
    const jobId = Number(entry?.jobId);
    if (!Number.isFinite(jobId) || jobId <= 0) {
      return;
    }
    switch (action) {
      case QUEUE_ACTIONS.START_PREPARED:
        await this.startPreparedJob(jobId, { immediate: true });
        break;
      case QUEUE_ACTIONS.RETRY:
        await this.retry(jobId, { immediate: true });
        break;
      case QUEUE_ACTIONS.REENCODE:
        await this.reencodeFromRaw(jobId, { immediate: true });
        break;
      case QUEUE_ACTIONS.RESTART_ENCODE:
        await this.restartEncodeWithLastSettings(jobId, { immediate: true });
        break;
      case QUEUE_ACTIONS.RESTART_REVIEW:
        await this.restartReviewFromRaw(jobId, { immediate: true });
        break;
      case QUEUE_ACTIONS.START_CD:
        await this.startCdRip(jobId, entry.ripConfig || {});
        break;
      default: {
        const error = new Error(`Unbekannte Queue-Aktion: ${String(action || '-')}`);
        error.statusCode = 400;
        throw error;
      }
    }
  }

  async pumpQueue() {
    if (this.queuePumpRunning) {
      return;
    }
    this.queuePumpRunning = true;
    try {
      while (this.queueEntries.length > 0) {
        // Get current running counts and limits
        const [filmRunning, cdRunning, maxFilm, maxCd, maxTotal, cdBypass] = await Promise.all([
          historyService.getRunningFilmEncodeJobs().then((r) => r.length),
          historyService.getRunningCdEncodeJobs().then((r) => r.length),
          this.getMaxParallelJobs(),
          this.getMaxParallelCdEncodes(),
          this.getMaxTotalEncodes(),
          this.getCdBypassesQueue()
        ]);
        const totalRunning = filmRunning + cdRunning;

        // Find next startable entry
        let entryIndex = -1;
        for (let i = 0; i < this.queueEntries.length; i++) {
          const candidate = this.queueEntries[i];
          const isNonJob = candidate.type && candidate.type !== 'job';

          if (isNonJob) {
            // Non-job entries (script, chain, wait) always start immediately
            entryIndex = i;
            break;
          }

          // Job entry: check hierarchical limits
          if (totalRunning >= maxTotal) {
            // Total limit reached – nothing can start
            break;
          }

          const isCdEntry = candidate.action === QUEUE_ACTIONS.START_CD;
          if (isCdEntry) {
            if (cdRunning < maxCd) {
              entryIndex = i;
              break;
            }
            // CD limit reached
            if (!cdBypass) break; // Strict FIFO: stop scanning
            continue; // Bypass mode: skip this blocked CD entry
          } else {
            // Film/video job entry
            if (filmRunning < maxFilm) {
              entryIndex = i;
              break;
            }
            // Film limit reached
            if (!cdBypass) break; // Strict FIFO: stop scanning
            continue; // Bypass mode: skip this blocked film entry
          }
        }

        if (entryIndex < 0) {
          break; // Nothing can start right now
        }

        const entry = this.queueEntries.splice(entryIndex, 1)[0];
        if (!entry) {
          break;
        }

        const isNonJob = entry.type && entry.type !== 'job';
        await this.emitQueueChanged();
        try {
          if (isNonJob) {
            await this.dispatchNonJobEntry(entry);
            continue;
          }
          await historyService.appendLog(
            entry.jobId,
            'SYSTEM',
            `Queue-Start: ${QUEUE_ACTION_LABELS[entry.action] || entry.action}`
          );
          await this.dispatchQueuedEntry(entry);
        } catch (error) {
          if (Number(error?.statusCode || 0) === 409) {
            this.queueEntries.splice(entryIndex, 0, entry);
            await this.emitQueueChanged();
            break;
          }
          logger.error('queue:entry:failed', {
            type: entry.type || 'job',
            action: entry.action,
            jobId: entry.jobId,
            error: errorToMeta(error)
          });
          if (entry.jobId) {
            await historyService.appendLog(
              entry.jobId,
              'SYSTEM',
              `Queue-Start fehlgeschlagen (${QUEUE_ACTION_LABELS[entry.action] || entry.action}): ${error.message}`
            );
          }
        }
      }
    } finally {
      this.queuePumpRunning = false;
      await this.emitQueueChanged();
    }
  }

  async resetFrontendState(reason = 'manual', options = {}) {
    const force = Boolean(options?.force);
    const keepDetectedDevice = options?.keepDetectedDevice !== false;

    if (!force && (this.activeProcesses.size > 0 || RUNNING_STATES.has(this.snapshot.state))) {
      logger.warn('ui:reset:skipped-busy', {
        reason,
        state: this.snapshot.state,
        activeJobId: this.snapshot.activeJobId
      });
      return {
        reset: false,
        skipped: 'busy'
      };
    }

    const device = keepDetectedDevice ? (this.detectedDisc || null) : null;
    const nextState = device ? 'DISC_DETECTED' : 'IDLE';
    const statusText = device ? 'Neue Disk erkannt' : 'Bereit';

    logger.warn('ui:reset', {
      reason,
      previousState: this.snapshot.state,
      previousActiveJobId: this.snapshot.activeJobId,
      nextState,
      keepDetectedDevice
    });

    await this.setState(nextState, {
      activeJobId: null,
      progress: 0,
      eta: null,
      statusText,
      context: device ? { device } : {}
    });

    return {
      reset: true,
      state: nextState
    };
  }

  async notifyPushover(eventKey, payload = {}) {
    try {
      const result = await notificationService.notify(eventKey, payload);
      logger.debug('notify:event', {
        eventKey,
        sent: Boolean(result?.sent),
        reason: result?.reason || null
      });
    } catch (error) {
      logger.warn('notify:event:failed', {
        eventKey,
        error: errorToMeta(error)
      });
    }
  }

  normalizeDiscValue(value) {
    return String(value || '').trim().toLowerCase();
  }

  isSameDisc(a, b) {
    const aDiscLabel = this.normalizeDiscValue(a?.discLabel);
    const bDiscLabel = this.normalizeDiscValue(b?.discLabel);
    if (aDiscLabel && bDiscLabel) {
      return aDiscLabel === bDiscLabel;
    }

    const aPath = this.normalizeDiscValue(a?.path);
    const bPath = this.normalizeDiscValue(b?.path);
    if (aPath && bPath) {
      return aPath === bPath;
    }

    const aLabel = this.normalizeDiscValue(a?.label);
    const bLabel = this.normalizeDiscValue(b?.label);
    if (aLabel && bLabel) {
      return aLabel === bLabel;
    }

    return false;
  }

  async setState(state, patch = {}) {
    const previous = this.snapshot.state;
    const previousActiveJobId = this.snapshot.activeJobId;
    const contextPatch = patch.context && typeof patch.context === 'object' && !Array.isArray(patch.context)
      ? patch.context
      : null;
    this.snapshot = {
      ...this.snapshot,
      state,
      activeJobId: patch.activeJobId !== undefined ? patch.activeJobId : this.snapshot.activeJobId,
      progress: patch.progress !== undefined ? patch.progress : this.snapshot.progress,
      eta: patch.eta !== undefined ? patch.eta : this.snapshot.eta,
      statusText: patch.statusText !== undefined ? patch.statusText : this.snapshot.statusText,
      context: patch.context !== undefined ? patch.context : this.snapshot.context
    };

    // Keep per-job progress map in sync when a job starts or finishes.
    if (patch.activeJobId != null) {
      const activeJobId = Number(patch.activeJobId);
      const previousJobProgress = this.jobProgress.get(activeJobId) || {};
      const mergedContext = contextPatch
        ? {
          ...(previousJobProgress.context && typeof previousJobProgress.context === 'object'
            ? previousJobProgress.context
            : {}),
          ...contextPatch
        }
        : (previousJobProgress.context && typeof previousJobProgress.context === 'object'
            ? previousJobProgress.context
            : null);
      const nextProgress = {
        ...previousJobProgress,
        state,
        progress: patch.progress ?? 0,
        eta: patch.eta ?? null,
        statusText: patch.statusText ?? null
      };
      if (mergedContext && Object.keys(mergedContext).length > 0) {
        nextProgress.context = mergedContext;
      }
      this.jobProgress.set(activeJobId, nextProgress);
    } else if (patch.activeJobId === null) {
      // Job slot cleared – remove the finished job's live entry so it falls
      // back to DB data in the frontend.
      // Use patch.finishingJobId when provided (parallel-safe); fall back to
      // previousActiveJobId only when no parallel job has overwritten the slot.
      const finishingJobId = patch.finishingJobId != null
        ? Number(patch.finishingJobId)
        : (previousActiveJobId != null ? Number(previousActiveJobId) : null);
      if (finishingJobId != null) {
        this.jobProgress.delete(finishingJobId);
      }
    }
    logger.info('state:changed', {
      from: previous,
      to: state,
      activeJobId: this.snapshot.activeJobId,
      statusText: this.snapshot.statusText
    });

    await this.persistSnapshot();
    const snapshotPayload = this.getSnapshot();
    wsService.broadcast('PIPELINE_STATE_CHANGED', snapshotPayload);
    this.emit('stateChanged', snapshotPayload);
    void this.emitQueueChanged();
    void this.pumpQueue();
  }

  async persistSnapshot(force = true) {
    if (!force) {
      const now = Date.now();
      if (now - this.lastPersistAt < 300) {
        return;
      }
      this.lastPersistAt = now;
    }

    const db = await getDb();
    await db.run(
      `
        UPDATE pipeline_state
        SET
          state = ?,
          active_job_id = ?,
          progress = ?,
          eta = ?,
          status_text = ?,
          context_json = ?,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = 1
      `,
      [
        this.snapshot.state,
        this.snapshot.activeJobId,
        this.snapshot.progress,
        this.snapshot.eta,
        this.snapshot.statusText,
        JSON.stringify(this.snapshot.context || {})
      ]
    );
  }

  async updateProgress(stage, percent, eta, statusText, jobIdOverride = null, options = {}) {
    const effectiveJobId = jobIdOverride != null ? Number(jobIdOverride) : this.snapshot.activeJobId;
    const effectiveProgress = percent ?? this.snapshot.progress;
    const effectiveEta = eta ?? this.snapshot.eta;
    const effectiveStatusText = statusText ?? this.snapshot.statusText;
    const progressOptions = options && typeof options === 'object' ? options : {};
    const contextPatch = progressOptions.contextPatch && typeof progressOptions.contextPatch === 'object'
      && !Array.isArray(progressOptions.contextPatch)
      ? progressOptions.contextPatch
      : null;

    // Update per-job progress so concurrent jobs don't overwrite each other.
    if (effectiveJobId != null) {
      const previousJobProgress = this.jobProgress.get(effectiveJobId) || {};
      const mergedContext = contextPatch
        ? {
          ...(previousJobProgress.context && typeof previousJobProgress.context === 'object'
            ? previousJobProgress.context
            : {}),
          ...contextPatch
        }
        : (previousJobProgress.context && typeof previousJobProgress.context === 'object'
            ? previousJobProgress.context
            : null);
      const nextProgress = {
        ...previousJobProgress,
        state: stage,
        progress: effectiveProgress,
        eta: effectiveEta,
        statusText: effectiveStatusText
      };
      if (mergedContext && Object.keys(mergedContext).length > 0) {
        nextProgress.context = mergedContext;
      }
      this.jobProgress.set(effectiveJobId, nextProgress);
    }

    // Only update the global snapshot fields when this update belongs to the
    // currently active job (avoids the snapshot jumping between parallel jobs).
    if (effectiveJobId === this.snapshot.activeJobId || effectiveJobId == null) {
      const nextContext = contextPatch
        ? {
          ...(this.snapshot.context && typeof this.snapshot.context === 'object'
            ? this.snapshot.context
            : {}),
          ...contextPatch
        }
        : this.snapshot.context;
      this.snapshot = {
        ...this.snapshot,
        state: stage,
        progress: effectiveProgress,
        eta: effectiveEta,
        statusText: effectiveStatusText,
        context: nextContext
      };
      await this.persistSnapshot(false);
    }

    const rounded = Number((effectiveProgress || 0).toFixed(2));
    const key = `${effectiveJobId}:${stage}:${rounded}`;
    if (key !== this.lastProgressKey) {
      this.lastProgressKey = key;
      logger.debug('progress:update', {
        stage,
        activeJobId: effectiveJobId,
        progress: rounded,
        eta: effectiveEta,
        statusText: effectiveStatusText
      });
    }
    wsService.broadcast('PIPELINE_PROGRESS', {
      state: stage,
      activeJobId: effectiveJobId,
      progress: effectiveProgress,
      eta: effectiveEta,
      statusText: effectiveStatusText,
      contextPatch
    });
  }

  async onDiscInserted(deviceInfo) {
    const rawDevice = deviceInfo && typeof deviceInfo === 'object'
      ? deviceInfo
      : {};
    const explicitProfile = normalizeMediaProfile(rawDevice.mediaProfile);
    const inferredProfile = inferMediaProfileFromDeviceInfo(rawDevice);
    const resolvedMediaProfile = isSpecificMediaProfile(explicitProfile)
      ? explicitProfile
      : (isSpecificMediaProfile(inferredProfile)
          ? inferredProfile
          : (explicitProfile || inferredProfile || 'other'));
    const resolvedDevice = {
      ...rawDevice,
      mediaProfile: resolvedMediaProfile
    };

    const previousDevice = this.snapshot.context?.device || this.detectedDisc;
    const previousState = this.snapshot.state;
    const previousJobId = this.snapshot.context?.jobId || this.snapshot.activeJobId || null;
    const discChanged = previousDevice ? !this.isSameDisc(previousDevice, resolvedDevice) : false;

    this.detectedDisc = resolvedDevice;
    logger.info('disc:inserted', { deviceInfo: resolvedDevice, mediaProfile: resolvedMediaProfile });

    wsService.broadcast('DISC_DETECTED', {
      device: resolvedDevice
    });

    if (discChanged && !RUNNING_STATES.has(previousState) && previousState !== 'DISC_DETECTED' && previousState !== 'READY_TO_ENCODE') {
      const message = `Disk gewechselt (${resolvedDevice.discLabel || resolvedDevice.path || 'unbekannt'}). Bitte neu analysieren.`;
      logger.info('disc:changed:reset', {
        fromState: previousState,
        previousDevice,
        newDevice: resolvedDevice,
        previousJobId
      });

      if (previousJobId && (previousState === 'METADATA_SELECTION' || previousState === 'READY_TO_START' || previousState === 'WAITING_FOR_USER_DECISION')) {
        await historyService.updateJob(previousJobId, {
          status: 'ERROR',
          last_state: 'ERROR',
          end_time: nowIso(),
          error_message: message
        });
        await historyService.appendLog(previousJobId, 'SYSTEM', message);
      }

      await this.setState('DISC_DETECTED', {
        activeJobId: null,
        progress: 0,
        eta: null,
        statusText: 'Neue Disk erkannt',
        context: {
          device: resolvedDevice
        }
      });
      return;
    }

    if (this.snapshot.state === 'IDLE' || this.snapshot.state === 'FINISHED' || this.snapshot.state === 'ERROR' || this.snapshot.state === 'DISC_DETECTED') {
      await this.setState('DISC_DETECTED', {
        activeJobId: null,
        progress: 0,
        eta: null,
        statusText: 'Neue Disk erkannt',
        context: {
          device: resolvedDevice
        }
      });
    }
  }

  async onDiscRemoved(deviceInfo) {
    logger.info('disc:removed', { deviceInfo });
    wsService.broadcast('DISC_REMOVED', {
      device: deviceInfo
    });

    this.detectedDisc = null;
    if (this.snapshot.state === 'DISC_DETECTED') {
      await this.setState('IDLE', {
        activeJobId: null,
        progress: 0,
        eta: null,
        statusText: 'Keine Disk erkannt',
        context: {}
      });
    }
  }

  ensureNotBusy(action, jobId = null) {
    const normalizedJobId = this.normalizeQueueJobId(jobId);
    if (!normalizedJobId) {
      return;
    }
    if (this.activeProcesses.has(normalizedJobId)) {
      const error = new Error(`Job #${normalizedJobId} ist bereits aktiv. Aktion '${action}' aktuell nicht möglich.`);
      error.statusCode = 409;
      logger.warn('busy:blocked-action', {
        action,
        jobId: normalizedJobId,
        activeState: this.snapshot.state,
        activeJobId: this.snapshot.activeJobId
      });
      throw error;
    }
  }

  isPrimaryJob(jobId) {
    const activeState = String(this.snapshot.state || '').toUpperCase();
    if (!['ENCODING', 'RIPPING'].includes(activeState)) {
      return true;
    }
    return Number(this.snapshot.activeJobId) === Number(jobId);
  }

  withAnalyzeContextMediaProfile(makemkvInfo, mediaProfile) {
    const normalizedProfile = normalizeMediaProfile(mediaProfile);
    const base = makemkvInfo && typeof makemkvInfo === 'object'
      ? makemkvInfo
      : {};
    return {
      ...base,
      analyzeContext: {
        ...(base.analyzeContext || {}),
        mediaProfile: normalizedProfile || null
      }
    };
  }

  resolveMediaProfileForJob(job, options = {}) {
    const pickSpecificProfile = (value) => {
      const normalized = normalizeMediaProfile(value);
      if (!normalized) {
        return null;
      }
      if (isSpecificMediaProfile(normalized)) {
        return normalized;
      }
      return null;
    };

    const explicitProfile = pickSpecificProfile(options?.mediaProfile);
    if (explicitProfile) {
      return explicitProfile;
    }

    const encodePlan = options?.encodePlan && typeof options.encodePlan === 'object'
      ? options.encodePlan
      : null;
    const profileFromPlan = pickSpecificProfile(encodePlan?.mediaProfile);
    if (profileFromPlan) {
      return profileFromPlan;
    }

    const mkInfo = options?.makemkvInfo && typeof options.makemkvInfo === 'object'
      ? options.makemkvInfo
      : this.safeParseJson(job?.makemkv_info_json);
    const analyzeContext = mkInfo?.analyzeContext || {};
    const profileFromAnalyze = pickSpecificProfile(
      analyzeContext.mediaProfile || mkInfo?.mediaProfile
    );
    if (profileFromAnalyze) {
      return profileFromAnalyze;
    }

    const currentContextProfile = (
      Number(this.snapshot.context?.jobId) === Number(job?.id)
        ? pickSpecificProfile(this.snapshot.context?.mediaProfile)
        : null
    );
    if (currentContextProfile) {
      return currentContextProfile;
    }

    const deviceProfile = inferMediaProfileFromDeviceInfo(
      options?.deviceInfo
      || this.detectedDisc
      || this.snapshot.context?.device
      || null
    );
    if (isSpecificMediaProfile(deviceProfile)) {
      return deviceProfile;
    }

    const rawPathProfile = inferMediaProfileFromRawPath(options?.rawPath || job?.raw_path || null);
    if (rawPathProfile) {
      return rawPathProfile;
    }

    return 'other';
  }

  async getEffectiveSettingsForJob(job, options = {}) {
    const mediaProfile = this.resolveMediaProfileForJob(job, options);
    const settings = await settingsService.getEffectiveSettingsMap(mediaProfile);
    return {
      settings,
      mediaProfile
    };
  }

  async ensureMakeMKVRegistration(jobId, stage) {
    const registrationConfig = await settingsService.buildMakeMKVRegisterConfig();
    if (!registrationConfig) {
      return { applied: false, reason: 'not_configured' };
    }

    await historyService.appendLog(
      jobId,
      'SYSTEM',
      'Setze MakeMKV-Registrierungsschlüssel aus den Settings (makemkvcon reg).'
    );

    await this.runCommand({
      jobId,
      stage,
      source: 'MAKEMKV_REG',
      cmd: registrationConfig.cmd,
      args: registrationConfig.args,
      argsForLog: registrationConfig.argsForLog
    });

    return { applied: true };
  }

  isReviewRefreshSettingKey(key) {
    const normalized = String(key || '').trim().toLowerCase();
    if (!normalized) {
      return false;
    }

    if (REVIEW_REFRESH_SETTING_KEYS.has(normalized)) {
      return true;
    }

    return REVIEW_REFRESH_SETTING_PREFIXES.some((prefix) => normalized.startsWith(prefix));
  }

  async refreshEncodeReviewAfterSettingsSave(changedKeys = []) {
    const keys = Array.isArray(changedKeys)
      ? changedKeys.map((item) => String(item || '').trim()).filter(Boolean)
      : [];
    const queueLimitKeys = ['pipeline_max_parallel_jobs', 'pipeline_max_parallel_cd_encodes', 'pipeline_max_total_encodes', 'pipeline_cd_bypasses_queue'];
    if (keys.some((k) => queueLimitKeys.includes(k))) {
      await this.emitQueueChanged();
      void this.pumpQueue();
    }
    const relevantKeys = keys.filter((key) => this.isReviewRefreshSettingKey(key));
    if (relevantKeys.length === 0) {
      return {
        triggered: false,
        reason: 'no_relevant_setting_changes',
        relevantKeys: []
      };
    }

    if (this.activeProcesses.size > 0 || RUNNING_STATES.has(this.snapshot.state)) {
      return {
        triggered: false,
        reason: 'pipeline_busy',
        relevantKeys
      };
    }

    const rawJobId = Number(this.snapshot.activeJobId || this.snapshot.context?.jobId || null);
    const activeJobId = Number.isFinite(rawJobId) && rawJobId > 0 ? Math.trunc(rawJobId) : null;
    if (!activeJobId) {
      return {
        triggered: false,
        reason: 'no_active_job',
        relevantKeys
      };
    }

    const job = await historyService.getJobById(activeJobId);
    if (!job) {
      return {
        triggered: false,
        reason: 'active_job_not_found',
        relevantKeys,
        jobId: activeJobId
      };
    }

    if (job.status !== 'READY_TO_ENCODE' && job.last_state !== 'READY_TO_ENCODE') {
      return {
        triggered: false,
        reason: 'active_job_not_ready_to_encode',
        relevantKeys,
        jobId: activeJobId,
        status: job.status,
        lastState: job.last_state
      };
    }

    const existingPlan = this.safeParseJson(job.encode_plan_json);
    const refreshSettings = await settingsService.getSettingsMap();
    const refreshMediaProfile = this.resolveMediaProfileForJob(job, {
      encodePlan: existingPlan,
      rawPath: job.raw_path
    });
    const resolvedRefreshRawPath = this.resolveCurrentRawPathForSettings(
      refreshSettings,
      refreshMediaProfile,
      job.raw_path
    );

    if (!resolvedRefreshRawPath) {
      return {
        triggered: false,
        reason: 'raw_path_missing',
        relevantKeys,
        jobId: activeJobId,
        rawPath: job.raw_path || null
      };
    }

    if (resolvedRefreshRawPath !== job.raw_path) {
      await historyService.updateJob(activeJobId, { raw_path: resolvedRefreshRawPath });
    }

    const mode = existingPlan?.mode || this.snapshot.context?.mode || 'rip';
    const sourceJobId = existingPlan?.sourceJobId || this.snapshot.context?.sourceJobId || null;

    await historyService.appendLog(
      activeJobId,
      'SYSTEM',
      `Settings gespeichert (${relevantKeys.join(', ')}). Titel-/Spurprüfung wird mit aktueller Konfiguration neu gestartet.`
    );

    this.runReviewForRawJob(activeJobId, resolvedRefreshRawPath, { mode, sourceJobId }).catch((error) => {
      logger.error('settings:refresh-review:failed', {
        jobId: activeJobId,
        relevantKeys,
        error: errorToMeta(error)
      });
    });

    return {
      triggered: true,
      reason: 'refresh_started',
      relevantKeys,
      jobId: activeJobId,
      mode
    };
  }

  resolvePlaylistDecisionForJob(jobId, job, selectionOverride = null) {
    const activeContext = this.snapshot.context?.jobId === jobId
      ? (this.snapshot.context || {})
      : {};

    const mkInfo = this.safeParseJson(job?.makemkv_info_json);
    const analyzeContext = mkInfo?.analyzeContext || {};
    const playlistAnalysis = activeContext.playlistAnalysis || analyzeContext.playlistAnalysis || mkInfo?.playlistAnalysis || null;

    const playlistDecisionRequired = Boolean(
      activeContext.playlistDecisionRequired !== undefined
        ? activeContext.playlistDecisionRequired
        : (analyzeContext.playlistDecisionRequired !== undefined
          ? analyzeContext.playlistDecisionRequired
          : playlistAnalysis?.manualDecisionRequired)
    );

    const rawSelection = selectionOverride
      || activeContext.selectedPlaylist
      || analyzeContext.selectedPlaylist
      || null;
    const selectedPlaylist = normalizePlaylistId(rawSelection);

    const rawSelectedTitleId = activeContext.selectedTitleId ?? analyzeContext.selectedTitleId ?? null;
    let selectedTitleId = null;
    if (selectedPlaylist) {
      selectedTitleId = pickTitleIdForPlaylist(playlistAnalysis, selectedPlaylist);
    }
    if (selectedTitleId === null) {
      const parsedSelectedTitleId = normalizeNonNegativeInteger(rawSelectedTitleId);
      if (parsedSelectedTitleId !== null) {
        selectedTitleId = parsedSelectedTitleId;
      }
    }
    if (!selectedPlaylist && selectedTitleId !== null && !isCandidateTitleId(playlistAnalysis, selectedTitleId)) {
      selectedTitleId = null;
    }

    const candidatePlaylists = buildPlaylistCandidates(playlistAnalysis);
    const recommendation = playlistAnalysis?.recommendation || null;

    return {
      playlistAnalysis,
      playlistDecisionRequired,
      candidatePlaylists,
      selectedPlaylist,
      selectedTitleId,
      recommendation
    };
  }

  async analyzeDisc() {
    this.ensureNotBusy('analyze');
    logger.info('analyze:start');

    const device = this.detectedDisc || this.snapshot.context?.device;
    if (!device) {
      const error = new Error('Keine Disk erkannt.');
      error.statusCode = 400;
      logger.warn('analyze:no-disc');
      throw error;
    }

    const detectedTitle = String(
      device.discLabel
      || device.label
      || device.model
      || 'Unknown Disc'
    ).trim();
    const explicitProfile = normalizeMediaProfile(device?.mediaProfile);
    const inferredProfile = inferMediaProfileFromDeviceInfo(device);
    const mediaProfile = isSpecificMediaProfile(explicitProfile)
      ? explicitProfile
      : (isSpecificMediaProfile(inferredProfile)
          ? inferredProfile
          : (explicitProfile || inferredProfile || 'other'));
    const deviceWithProfile = {
      ...device,
      mediaProfile
    };

    // Route audio CDs to the dedicated CD pipeline
    if (mediaProfile === 'cd') {
      return this.analyzeCd(deviceWithProfile);
    }

    const job = await historyService.createJob({
      discDevice: device.path,
      status: 'METADATA_SELECTION',
      detectedTitle
    });

    try {
      const omdbCandidates = await omdbService.search(detectedTitle).catch(() => []);
      logger.info('metadata:prepare:result', {
        jobId: job.id,
        detectedTitle,
        omdbCandidateCount: omdbCandidates.length
      });

      await historyService.updateJob(job.id, {
        status: 'METADATA_SELECTION',
        last_state: 'METADATA_SELECTION',
        detected_title: detectedTitle,
        makemkv_info_json: JSON.stringify(this.withAnalyzeContextMediaProfile({
          phase: 'PREPARE',
          preparedAt: nowIso(),
          analyzeContext: {
            playlistAnalysis: null,
            playlistDecisionRequired: false,
            selectedPlaylist: null,
            selectedTitleId: null
          }
        }, mediaProfile))
      });
      await historyService.appendLog(
        job.id,
        'SYSTEM',
        `Disk erkannt. Metadaten-Suche vorbereitet mit Query "${detectedTitle}".`
      );

      const runningJobs = await historyService.getRunningJobs();
      const foreignRunningJobs = runningJobs.filter((item) => Number(item?.id) !== Number(job.id));
      const keepCurrentPipelineSession = foreignRunningJobs.length > 0;
      if (!keepCurrentPipelineSession) {
        await this.setState('METADATA_SELECTION', {
          activeJobId: job.id,
          progress: 0,
          eta: null,
          statusText: 'Metadaten auswählen',
          context: {
            jobId: job.id,
            device: deviceWithProfile,
            detectedTitle,
            detectedTitleSource: device.discLabel ? 'discLabel' : 'fallback',
            omdbCandidates,
            mediaProfile,
            playlistAnalysis: null,
            playlistDecisionRequired: false,
            playlistCandidates: [],
            selectedPlaylist: null,
            selectedTitleId: null
          }
        });
      } else {
        await historyService.appendLog(
          job.id,
          'SYSTEM',
          `Metadaten-Auswahl im Hintergrund vorbereitet. Aktive Session bleibt bei laufendem Job #${foreignRunningJobs.map((item) => item.id).join(',')}.`
        );
      }

      void this.notifyPushover('metadata_ready', {
        title: 'Ripster - Metadaten bereit',
        message: `Job #${job.id}: ${detectedTitle} (${omdbCandidates.length} Treffer)`
      });

      return {
        jobId: job.id,
        detectedTitle,
        omdbCandidates
      };
    } catch (error) {
      logger.error('metadata:prepare:failed', { jobId: job.id, error: errorToMeta(error) });
      await this.failJob(job.id, 'METADATA_SELECTION', error);
      throw error;
    }
  }

  async searchOmdb(query) {
    logger.info('omdb:search', { query });
    const results = await omdbService.search(query);
    logger.info('omdb:search:done', { query, count: results.length });
    return results;
  }

  async runDiscTrackReviewForJob(jobId, deviceInfo = null, options = {}) {
    this.ensureNotBusy('runDiscTrackReviewForJob', jobId);
    logger.info('disc-track-review:start', { jobId, deviceInfo, options });

    const job = await historyService.getJobById(jobId);
    if (!job) {
      const error = new Error(`Job ${jobId} nicht gefunden.`);
      error.statusCode = 404;
      throw error;
    }
    const mkInfo = this.safeParseJson(job.makemkv_info_json);
    const mediaProfile = this.resolveMediaProfileForJob(job, {
      mediaProfile: options?.mediaProfile,
      deviceInfo,
      makemkvInfo: mkInfo
    });
    const settings = await settingsService.getEffectiveSettingsMap(mediaProfile);
    const analyzeContext = mkInfo?.analyzeContext || {};
    const playlistAnalysis = analyzeContext.playlistAnalysis || this.snapshot.context?.playlistAnalysis || null;
    const selectedPlaylistId = normalizePlaylistId(
      options?.selectedPlaylist
      || analyzeContext.selectedPlaylist
      || this.snapshot.context?.selectedPlaylist
      || null
    );
    const selectedMakemkvTitleIdRaw =
      options?.selectedTitleId
      ?? analyzeContext.selectedTitleId
      ?? this.snapshot.context?.selectedTitleId
      ?? null;
    const selectedMakemkvTitleId = normalizeNonNegativeInteger(selectedMakemkvTitleIdRaw);
    const selectedMetadata = {
      title: job.title || job.detected_title || null,
      year: job.year || null,
      imdbId: job.imdb_id || null,
      poster: job.poster_url || null
    };

    await this.setState('MEDIAINFO_CHECK', {
      activeJobId: jobId,
      progress: 0,
      eta: null,
      statusText: 'Vorab-Spurprüfung (Disc) läuft',
      context: {
        ...(this.snapshot.context || {}),
        jobId,
        reviewConfirmed: false,
        mode: 'pre_rip',
        mediaProfile,
        selectedMetadata
      }
    });

    await historyService.updateJob(jobId, {
      status: 'MEDIAINFO_CHECK',
      last_state: 'MEDIAINFO_CHECK',
      error_message: null,
      makemkv_info_json: JSON.stringify(this.withAnalyzeContextMediaProfile(mkInfo, mediaProfile)),
      mediainfo_info_json: null,
      encode_plan_json: null,
      encode_input_path: null,
      encode_review_confirmed: 0
    });

    const lines = [];
    const scanConfig = await settingsService.buildHandBrakeScanConfig(deviceInfo, { mediaProfile });
    logger.info('disc-track-review:command', {
      jobId,
      cmd: scanConfig.cmd,
      args: scanConfig.args,
      sourceArg: scanConfig.sourceArg,
      selectedTitleId: selectedMakemkvTitleId
    });

    const runInfo = await this.runCommand({
      jobId,
      stage: 'MEDIAINFO_CHECK',
      source: 'HANDBRAKE_SCAN',
      cmd: scanConfig.cmd,
      args: scanConfig.args,
      collectLines: lines,
      collectStderrLines: false
    });

    const parsed = parseMediainfoJsonOutput(lines.join('\n'));
    if (!parsed) {
      const error = new Error('HandBrake Scan-Ausgabe konnte nicht als JSON gelesen werden.');
      error.runInfo = runInfo;
      throw error;
    }

    const review = buildDiscScanReview({
      scanJson: parsed,
      settings,
      playlistAnalysis,
      selectedPlaylistId,
      selectedMakemkvTitleId,
      mediaProfile,
      sourceArg: scanConfig.sourceArg
    });

    if (!Array.isArray(review.titles) || review.titles.length === 0) {
      const error = new Error('Vorab-Spurprüfung lieferte keine Titel.');
      error.statusCode = 400;
      throw error;
    }

    await historyService.updateJob(jobId, {
      status: 'READY_TO_ENCODE',
      last_state: 'READY_TO_ENCODE',
      error_message: null,
      mediainfo_info_json: JSON.stringify({
        generatedAt: nowIso(),
        source: 'disc_scan',
        runInfo
      }),
      encode_plan_json: JSON.stringify(review),
      encode_input_path: review.encodeInputPath || null,
      encode_review_confirmed: 0
    });

    await historyService.appendLog(
      jobId,
      'SYSTEM',
      `Vorab-Spurprüfung abgeschlossen: ${review.titles.length} Titel, Auswahl=${review.encodeInputTitleId ? `Titel #${review.encodeInputTitleId}` : 'keine'}.`
    );

    await this.setState('READY_TO_ENCODE', {
      activeJobId: jobId,
      progress: 0,
      eta: null,
      statusText: review.titleSelectionRequired
        ? 'Vorab-Spurprüfung fertig - Titel per Checkbox wählen'
        : 'Vorab-Spurprüfung fertig - Auswahl bestätigen, dann Backup/Encode starten',
      context: {
        ...(this.snapshot.context || {}),
        jobId,
        inputPath: review.encodeInputPath || null,
        hasEncodableTitle: Boolean(review.encodeInputTitleId),
        reviewConfirmed: false,
        mode: 'pre_rip',
        mediaProfile,
        mediaInfoReview: review,
        selectedMetadata
      }
    });

    return review;
  }

  async handleDiscTrackReviewFailure(jobId, error, context = {}) {
    const message = error?.message || String(error);
    const runInfo = error?.runInfo && typeof error.runInfo === 'object'
      ? error.runInfo
      : null;
    const isDiscScanFailure = String(runInfo?.source || '').toUpperCase() === 'HANDBRAKE_SCAN'
      || /no title found/i.test(message);

    if (!isDiscScanFailure) {
      await this.failJob(jobId, 'MEDIAINFO_CHECK', error);
      return;
    }

    logger.warn('disc-track-review:fallback-to-manual-rip', {
      jobId,
      message,
      runInfo: runInfo || null
    });

    await historyService.updateJob(jobId, {
      status: 'READY_TO_START',
      last_state: 'READY_TO_START',
      error_message: null,
      mediainfo_info_json: JSON.stringify({
        source: 'disc_scan',
        failedAt: nowIso(),
        error: message,
        runInfo
      }),
      encode_plan_json: null,
      encode_input_path: null,
      encode_review_confirmed: 0
    });

    await historyService.appendLog(
      jobId,
      'SYSTEM',
      `Vorab-Spurprüfung fehlgeschlagen (${message}). Fallback: Backup/Rip kann manuell gestartet werden; Spurauswahl erfolgt danach.`
    );

    await this.setState('READY_TO_START', {
      activeJobId: jobId,
      progress: 0,
      eta: null,
      statusText: 'Vorab-Spurprüfung fehlgeschlagen - Backup manuell starten',
      context: {
        ...(this.snapshot.context || {}),
        jobId,
        selectedMetadata: context.selectedMetadata || this.snapshot.context?.selectedMetadata || null,
        playlistAnalysis: context.playlistAnalysis || this.snapshot.context?.playlistAnalysis || null,
        playlistDecisionRequired: Boolean(context.playlistDecisionRequired ?? this.snapshot.context?.playlistDecisionRequired),
        playlistCandidates: context.playlistCandidates || this.snapshot.context?.playlistCandidates || [],
        selectedPlaylist: context.selectedPlaylist || this.snapshot.context?.selectedPlaylist || null,
        selectedTitleId: context.selectedTitleId ?? this.snapshot.context?.selectedTitleId ?? null,
        preRipScanFailed: true,
        preRipScanError: message
      }
    });
  }

  async runBackupTrackReviewForJob(jobId, rawPath, options = {}) {
    this.ensureNotBusy('runBackupTrackReviewForJob', jobId);
    logger.info('backup-track-review:start', { jobId, rawPath, options });

    const job = await historyService.getJobById(jobId);
    if (!job) {
      const error = new Error(`Job ${jobId} nicht gefunden.`);
      error.statusCode = 404;
      throw error;
    }

    if (!rawPath || !fs.existsSync(rawPath)) {
      const error = new Error(`RAW-Pfad nicht gefunden (${rawPath || '-'})`);
      error.statusCode = 400;
      throw error;
    }

    const mode = String(options?.mode || 'rip').trim().toLowerCase() || 'rip';
    const forcePlaylistReselection = Boolean(options?.forcePlaylistReselection);
    const forceFreshAnalyze = Boolean(options?.forceFreshAnalyze);
    const mkInfo = this.safeParseJson(job.makemkv_info_json);
    const mediaProfile = this.resolveMediaProfileForJob(job, {
      mediaProfile: options?.mediaProfile,
      rawPath,
      makemkvInfo: mkInfo
    });
    const settings = await settingsService.getEffectiveSettingsMap(mediaProfile);
    const analyzeContext = mkInfo?.analyzeContext || {};
    let playlistAnalysis = forceFreshAnalyze
      ? null
      : (analyzeContext.playlistAnalysis || this.snapshot.context?.playlistAnalysis || null);
    let handBrakePlaylistScan = forceFreshAnalyze
      ? null
      : normalizeHandBrakePlaylistScanCache(analyzeContext.handBrakePlaylistScan || null);
    if (playlistAnalysis && handBrakePlaylistScan) {
      playlistAnalysis = enrichPlaylistAnalysisWithHandBrakeCache(playlistAnalysis, handBrakePlaylistScan);
    }
    const selectedPlaylistSource = (forcePlaylistReselection || forceFreshAnalyze)
      ? (options?.selectedPlaylist || null)
      : (options?.selectedPlaylist || analyzeContext.selectedPlaylist || this.snapshot.context?.selectedPlaylist || null);
    const selectedPlaylistId = normalizePlaylistId(
      selectedPlaylistSource
    );
    const selectedTitleSource = (forcePlaylistReselection || forceFreshAnalyze)
      ? (options?.selectedTitleId ?? null)
      : (options?.selectedTitleId ?? analyzeContext.selectedTitleId ?? this.snapshot.context?.selectedTitleId ?? null);
    const selectedMakemkvTitleId = normalizeNonNegativeInteger(selectedTitleSource);
    const selectedMetadata = {
      title: job.title || job.detected_title || null,
      year: job.year || null,
      imdbId: job.imdb_id || null,
      poster: job.poster_url || null
    };

    if (this.isPrimaryJob(jobId)) {
      await this.setState('MEDIAINFO_CHECK', {
        activeJobId: jobId,
        progress: 0,
        eta: null,
        statusText: 'Titel-/Spurprüfung aus RAW-Backup läuft',
        context: {
          ...(this.snapshot.context || {}),
          jobId,
          rawPath,
          inputPath: null,
          hasEncodableTitle: false,
          reviewConfirmed: false,
          mode,
          mediaProfile,
          sourceJobId: options.sourceJobId || null,
          selectedMetadata
        }
      });
    }

    await historyService.updateJob(jobId, {
      status: 'MEDIAINFO_CHECK',
      last_state: 'MEDIAINFO_CHECK',
      error_message: null,
      makemkv_info_json: JSON.stringify(this.withAnalyzeContextMediaProfile(mkInfo, mediaProfile)),
      mediainfo_info_json: null,
      encode_plan_json: null,
      encode_input_path: null,
      encode_review_confirmed: 0
    });

    if (forcePlaylistReselection && !selectedPlaylistId) {
      await historyService.appendLog(
        jobId,
        'SYSTEM',
        'Re-Encode: gespeicherte Playlist-Auswahl wird ignoriert. Bitte Playlist manuell neu auswählen.'
      );
    }
    if (forceFreshAnalyze) {
      await historyService.appendLog(
        jobId,
        'SYSTEM',
        'Review-Neustart erzwingt frische MakeMKV Full-Analyse (kein Reuse von Playlist-/HandBrake-Cache).'
      );
    }

    // Build playlist->TITLE_ID mapping once from MakeMKV full robot scan on RAW backup.
    let makeMkvAnalyzeRunInfo = null;
    let analyzedFromFreshRun = false;
    const existingPostBackupAnalyze = mkInfo?.postBackupAnalyze && typeof mkInfo.postBackupAnalyze === 'object'
      ? mkInfo.postBackupAnalyze
      : null;

    await this.ensureMakeMKVRegistration(jobId, 'MEDIAINFO_CHECK');
    if (selectedPlaylistId) {
      if (!playlistAnalysis || !Array.isArray(playlistAnalysis?.titles) || playlistAnalysis.titles.length === 0) {
        const error = new Error(
          'Playlist-Auswahl kann nicht fortgesetzt werden: MakeMKV-Mapping fehlt. Bitte zuerst die RAW-Analyse erneut starten.'
        );
        error.statusCode = 409;
        throw error;
      }
      await historyService.appendLog(
        jobId,
        'SYSTEM',
        'Verwende vorhandenes MakeMKV-Playlist-Mapping aus dem letzten Full-Scan (kein erneuter Full-Scan).'
      );
    } else {
      const analyzeLines = [];
      const analyzeConfig = await settingsService.buildMakeMKVAnalyzePathConfig(rawPath, { mediaProfile });
      logger.info('backup-track-review:makemkv-analyze-command', {
        jobId,
        cmd: analyzeConfig.cmd,
        args: analyzeConfig.args,
        sourceArg: analyzeConfig.sourceArg
      });

      makeMkvAnalyzeRunInfo = await this.runCommand({
        jobId,
        stage: 'MEDIAINFO_CHECK',
        source: 'MAKEMKV_ANALYZE_BACKUP',
        cmd: analyzeConfig.cmd,
        args: analyzeConfig.args,
        parser: parseMakeMkvProgress,
        collectLines: analyzeLines,
        silent: !this.isPrimaryJob(jobId)
      });

      const analyzed = analyzePlaylistObfuscation(
        analyzeLines,
        Number(settings.makemkv_min_length_minutes || 60),
        {}
      );
      playlistAnalysis = analyzed || null;
      analyzedFromFreshRun = true;
    }

    const playlistDecisionRequired = Boolean(playlistAnalysis?.manualDecisionRequired);
    let playlistCandidates = buildPlaylistCandidates(playlistAnalysis);
    const selectedTitleFromPlaylist = selectedPlaylistId
      ? pickTitleIdForPlaylist(playlistAnalysis, selectedPlaylistId)
      : null;
    const selectedTitleFromContext = (!selectedPlaylistId && !isCandidateTitleId(playlistAnalysis, selectedMakemkvTitleId))
      ? null
      : selectedMakemkvTitleId;
    const selectedTitleForContext = selectedTitleFromPlaylist ?? selectedTitleFromContext ?? null;
    if (selectedPlaylistId && playlistCandidates.length > 0) {
      const isKnownPlaylist = playlistCandidates.some((item) => item.playlistId === selectedPlaylistId);
      if (!isKnownPlaylist) {
        const error = new Error(`Playlist ${selectedPlaylistId}.mpls ist nicht in den erkannten Kandidaten enthalten.`);
        error.statusCode = 400;
        throw error;
      }
    }

    const shouldPrepareHandBrakeDecisionData = Boolean(
      playlistDecisionRequired
      && !selectedPlaylistId
      && playlistCandidates.length > 0
    );
    if (shouldPrepareHandBrakeDecisionData) {
      const hasCompleteCache = hasCachedHandBrakeDataForPlaylistCandidates(handBrakePlaylistScan, playlistCandidates);
      if (!hasCompleteCache) {
        await this.updateProgress(
          'MEDIAINFO_CHECK',
          25,
          null,
          'HandBrake Trackdaten für Playlist-Auswahl werden vorbereitet',
          jobId
        );
        try {
          const resolveScanLines = [];
          const resolveScanConfig = await settingsService.buildHandBrakeScanConfigForInput(rawPath, { mediaProfile });
          logger.info('backup-track-review:handbrake-predecision-command', {
            jobId,
            cmd: resolveScanConfig.cmd,
            args: resolveScanConfig.args,
            sourceArg: resolveScanConfig.sourceArg,
            candidatePlaylists: playlistCandidates.map((item) => item.playlistFile || item.playlistId)
          });

          await this.runCommand({
            jobId,
            stage: 'MEDIAINFO_CHECK',
            source: 'HANDBRAKE_SCAN_PLAYLIST_MAP',
            cmd: resolveScanConfig.cmd,
            args: resolveScanConfig.args,
            collectLines: resolveScanLines,
            collectStderrLines: false
          });

          const resolveScanJson = parseMediainfoJsonOutput(resolveScanLines.join('\n'));
          if (resolveScanJson) {
            const preparedCache = buildHandBrakePlaylistScanCache(resolveScanJson, playlistCandidates, rawPath);
            if (preparedCache) {
              handBrakePlaylistScan = preparedCache;
              playlistAnalysis = enrichPlaylistAnalysisWithHandBrakeCache(playlistAnalysis, handBrakePlaylistScan);
              playlistCandidates = buildPlaylistCandidates(playlistAnalysis);
              await historyService.appendLog(
                jobId,
                'SYSTEM',
                `HandBrake Playlist-Trackdaten vorbereitet: ${Object.keys(preparedCache.byPlaylist || {}).length} Kandidaten aus --scan -t 0 analysiert.`
              );
            } else {
              await historyService.appendLog(
                jobId,
                'SYSTEM',
                'HandBrake Playlist-Trackdaten konnten aus --scan -t 0 nicht auf Kandidaten abgebildet werden.'
              );
            }
          } else {
            await historyService.appendLog(
              jobId,
              'SYSTEM',
              'HandBrake Playlist-Trackdaten konnten nicht geparst werden (Warteansicht ohne Audiodetails).'
            );
          }
        } catch (error) {
          logger.warn('backup-track-review:handbrake-predecision-failed', {
            jobId,
            error: errorToMeta(error)
          });
          await historyService.appendLog(
            jobId,
            'SYSTEM',
            `HandBrake Voranalyse für Playlist-Auswahl fehlgeschlagen: ${error.message}`
          );
        }
      } else {
        playlistAnalysis = enrichPlaylistAnalysisWithHandBrakeCache(playlistAnalysis, handBrakePlaylistScan);
        playlistCandidates = buildPlaylistCandidates(playlistAnalysis);
        await historyService.appendLog(
          jobId,
          'SYSTEM',
          'HandBrake Playlist-Trackdaten aus Cache übernommen (kein erneuter --scan -t 0).'
        );
      }
    }

    const updatedMakemkvInfo = {
      ...mkInfo,
      analyzeContext: {
        ...(mkInfo?.analyzeContext || {}),
        mediaProfile,
        playlistAnalysis: playlistAnalysis || null,
        playlistDecisionRequired,
        selectedPlaylist: selectedPlaylistId || null,
        selectedTitleId: selectedTitleForContext,
        handBrakePlaylistScan: handBrakePlaylistScan || null
      },
      postBackupAnalyze: analyzedFromFreshRun
        ? {
          analyzedAt: nowIso(),
          source: 'MAKEMKV_ANALYZE_BACKUP',
          runInfo: makeMkvAnalyzeRunInfo,
          error: null
        }
        : {
          analyzedAt: existingPostBackupAnalyze?.analyzedAt || nowIso(),
          source: 'MAKEMKV_ANALYZE_BACKUP',
          runInfo: existingPostBackupAnalyze?.runInfo || null,
          reused: true,
          error: null
        }
    };

    if (playlistDecisionRequired && !selectedPlaylistId) {
      const evaluated = Array.isArray(playlistAnalysis?.evaluatedCandidates)
        ? playlistAnalysis.evaluatedCandidates
        : [];
      const recommendationFile = toPlaylistFile(playlistAnalysis?.recommendation?.playlistId);
      const decisionContext = describePlaylistManualDecision(playlistAnalysis);

      await historyService.updateJob(jobId, {
        status: 'WAITING_FOR_USER_DECISION',
        last_state: 'WAITING_FOR_USER_DECISION',
        error_message: null,
        makemkv_info_json: JSON.stringify(updatedMakemkvInfo),
        mediainfo_info_json: JSON.stringify({
          generatedAt: nowIso(),
          source: 'makemkv_backup_robot',
          runInfo: makeMkvAnalyzeRunInfo
        }),
        encode_plan_json: null,
        encode_input_path: null,
        encode_review_confirmed: 0
      });

      await historyService.appendLog(jobId, 'SYSTEM', 'Mehrere mögliche Haupttitel erkannt!');
      await historyService.appendLog(jobId, 'SYSTEM', decisionContext.detailText);
      for (const candidate of evaluated) {
        const playlistFile = toPlaylistFile(candidate?.playlistId) || `Titel #${candidate?.titleId || '-'}`;
        const score = Number(candidate?.score);
        const scoreLabel = Number.isFinite(score) ? score.toFixed(0) : '-';
        const durationLabel = String(candidate?.durationLabel || '').trim() || formatDurationClock(candidate?.durationSeconds) || '-';
        const recommendedLabel = candidate?.recommended ? ' (empfohlen)' : '';
        const evaluationLabel = candidate?.evaluationLabel ? ` | ${candidate.evaluationLabel}` : '';
        await historyService.appendLog(
          jobId,
          'SYSTEM',
          `${playlistFile} -> Dauer ${durationLabel} | Score ${scoreLabel}${recommendedLabel}${evaluationLabel}`
        );
      }
      await historyService.appendLog(
        jobId,
        'SYSTEM',
        `Status=awaiting_playlist_selection${recommendationFile ? ` | Empfehlung=${recommendationFile}` : ''}`
      );

      await this.setState('WAITING_FOR_USER_DECISION', {
        activeJobId: jobId,
        progress: 0,
        eta: null,
        statusText: 'awaiting_playlist_selection',
        context: {
          ...(this.snapshot.context || {}),
          jobId,
          rawPath,
          inputPath: null,
          hasEncodableTitle: false,
          reviewConfirmed: false,
          mode,
          mediaProfile,
          sourceJobId: options.sourceJobId || null,
          selectedMetadata,
          playlistAnalysis: playlistAnalysis || null,
          playlistDecisionRequired: true,
          playlistCandidates,
          selectedPlaylist: null,
          selectedTitleId: null,
          waitingForManualPlaylistSelection: true,
          manualDecisionState: 'awaiting_playlist_selection',
          mediaInfoReview: null
        }
      });

      const notificationMessage = [
        '⚠️ Manuelle Prüfung erforderlich!',
        decisionContext.obfuscationDetected
          ? 'Mehrere gleichlange Playlists erkannt.'
          : 'Mehrere Playlists erfüllen MIN_LENGTH_MINUTES.',
        '',
        'Empfehlung:',
        recommendationFile || '(keine eindeutige Empfehlung)',
        '',
        'Bitte Titel manuell bestätigen,',
        'bevor Encoding gestartet wird.'
      ].join('\n');
      void this.notifyPushover('metadata_ready', {
        title: 'Ripster - Playlist-Auswahl erforderlich',
        message: notificationMessage,
        priority: 1
      });

      return {
        awaitingPlaylistSelection: true,
        playlistAnalysis,
        playlistCandidates,
        recommendation: playlistAnalysis?.recommendation || null
      };
    }

    if (selectedPlaylistId) {
      await historyService.appendLog(
        jobId,
        'USER_ACTION',
        `Playlist-Auswahl übernommen: ${toPlaylistFile(selectedPlaylistId) || selectedPlaylistId}.`
      );
    }

    const selectedTitleForReview = pickTitleIdForTrackReview(playlistAnalysis, selectedTitleForContext);
    if (selectedTitleForReview === null) {
      const error = new Error('Titel-/Spurprüfung aus RAW nicht möglich: keine auflösbare Titel-ID vorhanden.');
      error.statusCode = 400;
      throw error;
    }

    const selectedTitleFromAnalysis = Array.isArray(playlistAnalysis?.titles)
      ? (playlistAnalysis.titles.find((item) => Number(item?.titleId) === Number(selectedTitleForReview)) || null)
      : null;
    const resolvedPlaylistId = normalizePlaylistId(
      selectedPlaylistId
      || selectedTitleFromAnalysis?.playlistId
      || playlistAnalysis?.recommendation?.playlistId
      || null
    );
    if (!resolvedPlaylistId) {
      const error = new Error(
        `Playlist konnte für MakeMKV Titel #${selectedTitleForReview} nicht aufgelöst werden.`
      );
      error.statusCode = 400;
      throw error;
    }

    if (updatedMakemkvInfo && updatedMakemkvInfo.analyzeContext) {
      updatedMakemkvInfo.analyzeContext.selectedTitleId = selectedTitleForReview;
      updatedMakemkvInfo.analyzeContext.selectedPlaylist = resolvedPlaylistId;
    }

    const cachedHandBrakePlaylistEntry = getCachedHandBrakePlaylistEntry(handBrakePlaylistScan, resolvedPlaylistId);
    const expectedDurationForCache = Number(selectedTitleFromAnalysis?.durationSeconds || 0) || null;
    const expectedSizeForCache = Number(selectedTitleFromAnalysis?.sizeBytes || 0) || null;
    const hasCachedHandBrakeEntry = Boolean(
      isHandBrakePlaylistCacheEntryCompatible(
        cachedHandBrakePlaylistEntry,
        resolvedPlaylistId,
        {
          expectedDurationSeconds: expectedDurationForCache,
          expectedSizeBytes: expectedSizeForCache
        }
      )
    );
    if (cachedHandBrakePlaylistEntry && !hasCachedHandBrakeEntry) {
      await historyService.appendLog(
        jobId,
        'SYSTEM',
        `HandBrake Cache für ${toPlaylistFile(resolvedPlaylistId)} verworfen (inkompatible Playlist-/Dauerdaten).`
      );
    }

    await this.updateProgress(
      'MEDIAINFO_CHECK',
      30,
      null,
      hasCachedHandBrakeEntry
        ? `HandBrake Trackdaten aus Cache (${toPlaylistFile(resolvedPlaylistId) || resolvedPlaylistId})`
        : `HandBrake Titel-/Spurscan läuft (${toPlaylistFile(resolvedPlaylistId) || resolvedPlaylistId})`,
      jobId
    );

    let handBrakeResolveRunInfo = null;
    let handBrakeTitleRunInfo = null;
    let resolvedHandBrakeTitleId = null;
    const reviewTitleSource = 'handbrake';
    const makeMkvSubtitleTracksForSelection = Array.isArray(selectedTitleFromAnalysis?.subtitleTracks)
      ? selectedTitleFromAnalysis.subtitleTracks
      : [];
    let reviewTitleInfo = null;
    if (hasCachedHandBrakeEntry) {
      resolvedHandBrakeTitleId = Math.trunc(Number(cachedHandBrakePlaylistEntry.handBrakeTitleId));
      reviewTitleInfo = enrichTitleInfoWithForcedSubtitleAvailability(
        cachedHandBrakePlaylistEntry.titleInfo,
        makeMkvSubtitleTracksForSelection
      );
      handBrakeResolveRunInfo = {
        source: 'HANDBRAKE_SCAN_PLAYLIST_MAP_CACHE',
        stage: 'MEDIAINFO_CHECK',
        status: 'CACHED',
        exitCode: 0,
        startedAt: handBrakePlaylistScan?.generatedAt || null,
        endedAt: nowIso(),
        durationMs: 0,
        cmd: 'cache',
        args: [`playlist=${resolvedPlaylistId}`, `title=${resolvedHandBrakeTitleId}`],
        highlights: [
          `Cache verwendet: ${toPlaylistFile(resolvedPlaylistId)} -> -t ${resolvedHandBrakeTitleId}`
        ]
      };
      handBrakeTitleRunInfo = handBrakeResolveRunInfo;
      await historyService.appendLog(
        jobId,
        'SYSTEM',
        `HandBrake Track-Analyse aus Cache: ${toPlaylistFile(resolvedPlaylistId)} -> -t ${resolvedHandBrakeTitleId} (kein erneuter --scan).`
      );
    } else {
      try {
        const resolveScanLines = [];
        const resolveScanConfig = await settingsService.buildHandBrakeScanConfigForInput(rawPath, { mediaProfile });
        logger.info('backup-track-review:handbrake-resolve-command', {
          jobId,
          cmd: resolveScanConfig.cmd,
          args: resolveScanConfig.args,
          sourceArg: resolveScanConfig.sourceArg,
          selectedPlaylistId: resolvedPlaylistId,
          selectedMakemkvTitleId: selectedTitleForReview
        });

        handBrakeResolveRunInfo = await this.runCommand({
          jobId,
          stage: 'MEDIAINFO_CHECK',
          source: 'HANDBRAKE_SCAN_PLAYLIST_MAP',
          cmd: resolveScanConfig.cmd,
          args: resolveScanConfig.args,
          collectLines: resolveScanLines,
          collectStderrLines: false,
          silent: !this.isPrimaryJob(jobId)
        });

        const resolveScanJson = parseMediainfoJsonOutput(resolveScanLines.join('\n'));
        if (!resolveScanJson) {
          const error = new Error('HandBrake Playlist-Mapping lieferte kein parsebares JSON.');
          error.runInfo = handBrakeResolveRunInfo;
          throw error;
        }

        resolvedHandBrakeTitleId = resolveHandBrakeTitleIdForPlaylist(resolveScanJson, resolvedPlaylistId, {
          expectedMakemkvTitleId: selectedTitleForReview,
          expectedDurationSeconds: expectedDurationForCache,
          expectedSizeBytes: expectedSizeForCache
        });
        if (!resolvedHandBrakeTitleId) {
          const knownPlaylists = listAvailableHandBrakePlaylists(resolveScanJson);
          const error = new Error(
            `Kein HandBrake-Titel für ${toPlaylistFile(resolvedPlaylistId)} gefunden.`
            + ` ${knownPlaylists.length > 0 ? `Scan-Playlists: ${knownPlaylists.map((id) => `${id}.mpls`).join(', ')}` : 'Scan enthält keine erkennbaren Playlist-IDs.'}`
          );
          error.statusCode = 400;
          error.runInfo = handBrakeResolveRunInfo;
          throw error;
        }

        reviewTitleInfo = parseHandBrakeSelectedTitleInfo(resolveScanJson, {
          playlistId: resolvedPlaylistId,
          handBrakeTitleId: resolvedHandBrakeTitleId,
          makeMkvSubtitleTracks: makeMkvSubtitleTracksForSelection
        });
        if (!reviewTitleInfo) {
          const error = new Error(
            `HandBrake lieferte keine verwertbaren Trackdaten für ${toPlaylistFile(resolvedPlaylistId)} (-t ${resolvedHandBrakeTitleId}).`
          );
          error.statusCode = 400;
          error.runInfo = handBrakeResolveRunInfo;
          throw error;
        }
        if (!isHandBrakePlaylistCacheEntryCompatible({
          playlistId: resolvedPlaylistId,
          handBrakeTitleId: resolvedHandBrakeTitleId,
          titleInfo: reviewTitleInfo
        }, resolvedPlaylistId, {
          expectedDurationSeconds: expectedDurationForCache,
          expectedSizeBytes: expectedSizeForCache
        })) {
          const error = new Error(
            `HandBrake Titel-Mapping inkonsistent für ${toPlaylistFile(resolvedPlaylistId)} (-t ${resolvedHandBrakeTitleId}).`
          );
          error.statusCode = 400;
          error.runInfo = handBrakeResolveRunInfo;
          throw error;
        }

        handBrakeTitleRunInfo = handBrakeResolveRunInfo;
        await historyService.appendLog(
          jobId,
          'SYSTEM',
          `HandBrake Track-Analyse aktiv: ${toPlaylistFile(resolvedPlaylistId)} -> -t ${resolvedHandBrakeTitleId} (aus --scan -t 0).`
        );

        const audioTrackPreview = buildHandBrakeAudioTrackPreview(reviewTitleInfo);
        const fallbackCache = normalizeHandBrakePlaylistScanCache(handBrakePlaylistScan) || {
          generatedAt: nowIso(),
          source: 'HANDBRAKE_SCAN_PLAYLIST_MAP',
          inputPath: rawPath,
          byPlaylist: {}
        };
        fallbackCache.byPlaylist[resolvedPlaylistId] = {
          playlistId: resolvedPlaylistId,
          handBrakeTitleId: Math.trunc(Number(resolvedHandBrakeTitleId)),
          titleInfo: reviewTitleInfo,
          audioTrackPreview,
          audioSummary: buildHandBrakeAudioSummary(audioTrackPreview)
        };
        handBrakePlaylistScan = normalizeHandBrakePlaylistScanCache(fallbackCache);
        playlistAnalysis = enrichPlaylistAnalysisWithHandBrakeCache(playlistAnalysis, handBrakePlaylistScan);
      } catch (error) {
        logger.warn('backup-track-review:handbrake-scan-failed', {
          jobId,
          selectedPlaylistId: resolvedPlaylistId,
          selectedTitleForReview,
          error: errorToMeta(error)
        });
        throw error;
      }
    }

    if (updatedMakemkvInfo && updatedMakemkvInfo.analyzeContext) {
      updatedMakemkvInfo.analyzeContext.handBrakePlaylistScan = handBrakePlaylistScan || null;
    }
    playlistCandidates = buildPlaylistCandidates(playlistAnalysis);

    let presetProfile = null;
    try {
      presetProfile = await settingsService.buildHandBrakePresetProfile(rawPath, {
        titleId: resolvedHandBrakeTitleId,
        mediaProfile
      });
    } catch (error) {
      logger.warn('backup-track-review:preset-profile-failed', {
        jobId,
        error: errorToMeta(error)
      });
      presetProfile = {
        source: 'fallback',
        message: `Preset-Profil konnte nicht geladen werden: ${error.message}`
      };
    }

    const syntheticFilePath = path.join(
      rawPath,
      reviewTitleSource === 'handbrake' && Number.isFinite(Number(resolvedHandBrakeTitleId)) && Number(resolvedHandBrakeTitleId) > 0
        ? `handbrake_t${String(Math.trunc(Number(resolvedHandBrakeTitleId))).padStart(2, '0')}.mkv`
        : `makemkv_t${String(selectedTitleForReview).padStart(2, '0')}.mkv`
    );
    const syntheticMediaInfoByPath = {
      [syntheticFilePath]: buildSyntheticMediaInfoFromMakeMkvTitle(reviewTitleInfo)
    };
    let review = buildMediainfoReview({
      mediaFiles: [{
        path: syntheticFilePath,
        size: Number(reviewTitleInfo?.sizeBytes || 0)
      }],
      mediaInfoByPath: syntheticMediaInfoByPath,
      settings,
      presetProfile,
      playlistAnalysis,
      preferredEncodeTitleId: selectedTitleForReview,
      selectedPlaylistId: resolvedPlaylistId || reviewTitleInfo?.playlistId || null,
      selectedMakemkvTitleId: selectedTitleForReview
    });
    review = remapReviewTrackIdsToSourceIds(review);

    const resolvedPlaylistInfo = resolvePlaylistInfoFromAnalysis(playlistAnalysis, resolvedPlaylistId);
    const minLengthMinutesForReview = Number(review?.minLengthMinutes ?? settings?.makemkv_min_length_minutes ?? 0);
    const minLengthSecondsForReview = Math.max(0, Math.round(minLengthMinutesForReview * 60));
    const subtitleTrackMetaBySourceId = new Map(
      (Array.isArray(reviewTitleInfo?.subtitleTracks) ? reviewTitleInfo.subtitleTracks : [])
        .map((track) => {
          const sourceTrackId = normalizeTrackIdList([track?.sourceTrackId ?? track?.id])[0] || null;
          return sourceTrackId ? [sourceTrackId, track] : null;
        })
        .filter(Boolean)
    );
    const normalizedTitles = (Array.isArray(review.titles) ? review.titles : [])
      .slice(0, 1)
      .map((title) => {
        const durationSeconds = Number(reviewTitleInfo?.durationSeconds || title?.durationSeconds || 0);
        const eligibleForEncode = durationSeconds >= minLengthSecondsForReview;
        const subtitleTracks = (Array.isArray(title?.subtitleTracks) ? title.subtitleTracks : []).map((track) => {
          const sourceTrackId = normalizeTrackIdList([track?.sourceTrackId ?? track?.id])[0] || null;
          const sourceMeta = sourceTrackId ? (subtitleTrackMetaBySourceId.get(sourceTrackId) || null) : null;
          return {
            ...track,
            id: sourceTrackId || track?.id || null,
            sourceTrackId: sourceTrackId || track?.sourceTrackId || track?.id || null,
            language: sourceMeta?.language || track?.language || 'und',
            languageLabel: sourceMeta?.languageLabel || track?.languageLabel || track?.language || 'und',
            title: sourceMeta?.title ?? track?.title ?? null,
            format: sourceMeta?.format || track?.format || null,
            forcedTrack: Boolean(sourceMeta?.forcedTrack),
            forcedAvailable: Boolean(sourceMeta?.forcedAvailable),
            forcedSourceTrackIds: normalizeTrackIdList(sourceMeta?.forcedSourceTrackIds || [])
          };
        });

        return {
          ...title,
          filePath: rawPath,
          fileName: reviewTitleInfo?.fileName || title?.fileName || `Title #${selectedTitleForReview}`,
          durationSeconds,
          durationMinutes: Number(((durationSeconds / 60)).toFixed(2)),
          selectedByMinLength: eligibleForEncode,
          eligibleForEncode,
          sizeBytes: Number(reviewTitleInfo?.sizeBytes || title?.sizeBytes || 0),
          playlistId: resolvedPlaylistInfo.playlistId || title?.playlistId || null,
          playlistFile: resolvedPlaylistInfo.playlistFile || title?.playlistFile || null,
          playlistRecommended: Boolean(resolvedPlaylistInfo.recommended || title?.playlistRecommended),
          playlistEvaluationLabel: resolvedPlaylistInfo.evaluationLabel || title?.playlistEvaluationLabel || null,
          playlistSegmentCommand: resolvedPlaylistInfo.segmentCommand || title?.playlistSegmentCommand || null,
          playlistSegmentFiles: Array.isArray(resolvedPlaylistInfo.segmentFiles) && resolvedPlaylistInfo.segmentFiles.length > 0
            ? resolvedPlaylistInfo.segmentFiles
            : (Array.isArray(title?.playlistSegmentFiles) ? title.playlistSegmentFiles : []),
          subtitleTracks
        };
      });

    const encodeInputTitleId = Number(normalizedTitles[0]?.id || review.encodeInputTitleId || null) || null;
    review = {
      ...review,
      mode,
      mediaProfile,
      sourceJobId: options.sourceJobId || null,
      reviewConfirmed: false,
      partial: false,
      processedFiles: 1,
      totalFiles: 1,
      handBrakeTitleId: resolvedHandBrakeTitleId || null,
      selectedPlaylistId: resolvedPlaylistId || null,
      selectedMakemkvTitleId: selectedTitleForReview,
      titleSelectionRequired: false,
      titles: normalizedTitles,
      selectedTitleIds: encodeInputTitleId ? [encodeInputTitleId] : [],
      encodeInputTitleId,
      encodeInputPath: rawPath,
      notes: [
        ...(Array.isArray(review.notes) ? review.notes : []),
        'MakeMKV Full-Analyse wurde einmal für Playlist-/Titel-Mapping verwendet.',
        `HandBrake Track-Analyse aktiv: ${toPlaylistFile(resolvedPlaylistId)} -> -t ${resolvedHandBrakeTitleId} (aus --scan -t 0).`
      ]
    };

    const reviewPrefillResult = applyPreviousSelectionDefaultsToReviewPlan(
      review,
      options?.previousEncodePlan && typeof options.previousEncodePlan === 'object'
        ? options.previousEncodePlan
        : null
    );
    review = reviewPrefillResult.plan;

    if (!Array.isArray(review.titles) || review.titles.length === 0) {
      const error = new Error('Titel-/Spurprüfung aus RAW lieferte keine Titel.');
      error.statusCode = 400;
      throw error;
    }

    await historyService.updateJob(jobId, {
      status: 'READY_TO_ENCODE',
      last_state: 'READY_TO_ENCODE',
      error_message: null,
      makemkv_info_json: JSON.stringify(updatedMakemkvInfo),
      mediainfo_info_json: JSON.stringify({
        generatedAt: nowIso(),
        source: 'raw_backup_handbrake_playlist_scan',
        makemkvAnalyzeRunInfo: makeMkvAnalyzeRunInfo,
        makemkvTitleAnalyzeRunInfo: null,
        handbrakePlaylistResolveRunInfo: handBrakeResolveRunInfo,
        handbrakeTitleRunInfo: handBrakeTitleRunInfo,
        handbrakeTitleId: resolvedHandBrakeTitleId || null
      }),
      encode_plan_json: JSON.stringify(review),
      encode_input_path: review.encodeInputPath || null,
      encode_review_confirmed: 0
    });

    await historyService.appendLog(
      jobId,
      'SYSTEM',
      `Titel-/Spurprüfung aus RAW abgeschlossen (MakeMKV Titel #${selectedTitleForReview}): ${review.titles.length} Titel, Vorauswahl=${review.encodeInputTitleId ? `Titel #${review.encodeInputTitleId}` : 'keine'}.`
    );
    if (reviewPrefillResult.applied) {
      await historyService.appendLog(
        jobId,
        'SYSTEM',
        `Vorherige Encode-Auswahl als Standard übernommen: Titel #${reviewPrefillResult.selectedEncodeTitleId || '-'}, `
        + `Pre-Skripte=${reviewPrefillResult.preEncodeScriptCount}, Pre-Ketten=${reviewPrefillResult.preEncodeChainCount}, `
        + `Post-Skripte=${reviewPrefillResult.postEncodeScriptCount}, Post-Ketten=${reviewPrefillResult.postEncodeChainCount}, `
        + `User-Preset=${reviewPrefillResult.userPresetApplied ? 'ja' : 'nein'}.`
      );
    }
    if (playlistDecisionRequired) {
      const playlistFiles = playlistCandidates.map((item) => item.playlistFile).filter(Boolean);
      const recommendationFile = toPlaylistFile(playlistAnalysis?.recommendation?.playlistId);
      const decisionContext = describePlaylistManualDecision(playlistAnalysis);
      await historyService.appendLog(
        jobId,
        'SYSTEM',
        `${decisionContext.detailText} (RAW). Kandidaten: ${playlistFiles.join(', ') || 'keine'}.`
      );
      if (recommendationFile) {
        await historyService.appendLog(
          jobId,
          'SYSTEM',
          `Playlist-Empfehlung: ${recommendationFile}`
        );
      }
    }

    const hasEncodableTitle = Boolean(review.encodeInputPath && review.encodeInputTitleId);
    if (this.isPrimaryJob(jobId)) {
      await this.setState('READY_TO_ENCODE', {
        activeJobId: jobId,
        progress: 0,
        eta: null,
        statusText: review.titleSelectionRequired
          ? 'Titel-/Spurprüfung fertig - Titel per Checkbox wählen'
          : (hasEncodableTitle
            ? 'Titel-/Spurprüfung fertig - Auswahl bestätigen, dann Encode manuell starten'
            : 'Titel-/Spurprüfung fertig - kein Titel erfüllt MIN_LENGTH_MINUTES'),
        context: {
          ...(this.snapshot.context || {}),
          jobId,
          rawPath,
          inputPath: review.encodeInputPath || null,
          hasEncodableTitle,
          reviewConfirmed: false,
          mode,
          mediaProfile,
          sourceJobId: options.sourceJobId || null,
          mediaInfoReview: review,
          selectedMetadata,
          playlistAnalysis: playlistAnalysis || null,
          playlistDecisionRequired,
          playlistCandidates,
          selectedPlaylist: resolvedPlaylistId || null,
          selectedTitleId: selectedTitleForReview
        }
      });
    }

    void this.notifyPushover('metadata_ready', {
      title: 'Ripster - RAW geprüft',
      message: `Job #${jobId}: bereit zum manuellen Encode-Start`
    });

    return review;
  }

  async runReviewForRawJob(jobId, rawPath, options = {}) {
    const useBackupReview = hasBluRayBackupStructure(rawPath);
    logger.info('review:dispatch', {
      jobId,
      rawPath,
      mode: options?.mode || 'rip',
      useBackupReview
    });

    if (useBackupReview) {
      return this.runBackupTrackReviewForJob(jobId, rawPath, options);
    }
    return this.runMediainfoReviewForJob(jobId, rawPath, options);
  }

  async selectMetadata({ jobId, title, year, imdbId, poster, fromOmdb = null, selectedPlaylist = null }) {
    this.ensureNotBusy('selectMetadata', jobId);
    logger.info('metadata:selected', { jobId, title, year, imdbId, poster, fromOmdb, selectedPlaylist });

    const job = await historyService.getJobById(jobId);
    if (!job) {
      const error = new Error(`Job ${jobId} nicht gefunden.`);
      error.statusCode = 404;
      throw error;
    }
    const mkInfo = this.safeParseJson(job.makemkv_info_json);
    const mediaProfile = this.resolveMediaProfileForJob(job, { makemkvInfo: mkInfo });

    const normalizedSelectedPlaylist = normalizePlaylistId(selectedPlaylist);
    const waitingForPlaylistSelection = (
      job.status === 'WAITING_FOR_USER_DECISION'
      || job.last_state === 'WAITING_FOR_USER_DECISION'
    );
    const hasExplicitMetadataPayload = (
      title !== undefined
      || year !== undefined
      || imdbId !== undefined
      || poster !== undefined
      || (fromOmdb !== null && fromOmdb !== undefined)
    );
    if (normalizedSelectedPlaylist && waitingForPlaylistSelection && job.raw_path && !hasExplicitMetadataPayload) {
      const currentMkInfo = mkInfo;
      const currentAnalyzeContext = currentMkInfo?.analyzeContext || {};
      const currentPlaylistAnalysis = currentAnalyzeContext.playlistAnalysis || this.snapshot.context?.playlistAnalysis || null;
      const selectedTitleId = pickTitleIdForPlaylist(currentPlaylistAnalysis, normalizedSelectedPlaylist);
      const updatedMkInfo = this.withAnalyzeContextMediaProfile({
        ...currentMkInfo,
        analyzeContext: {
          ...currentAnalyzeContext,
          playlistAnalysis: currentPlaylistAnalysis || null,
          playlistDecisionRequired: Boolean(currentPlaylistAnalysis?.manualDecisionRequired),
          selectedPlaylist: normalizedSelectedPlaylist,
          selectedTitleId: selectedTitleId ?? null
        }
      }, mediaProfile);

      await historyService.updateJob(jobId, {
        status: 'MEDIAINFO_CHECK',
        last_state: 'MEDIAINFO_CHECK',
        error_message: null,
        makemkv_info_json: JSON.stringify(updatedMkInfo),
        mediainfo_info_json: null,
        encode_plan_json: null,
        encode_input_path: null,
        encode_review_confirmed: 0
      });
      await historyService.appendLog(
        jobId,
        'USER_ACTION',
        `Playlist-Auswahl gesetzt: ${toPlaylistFile(normalizedSelectedPlaylist) || normalizedSelectedPlaylist}.`
      );

      try {
        await this.runBackupTrackReviewForJob(jobId, job.raw_path, {
          mode: 'rip',
          selectedPlaylist: normalizedSelectedPlaylist,
          selectedTitleId: selectedTitleId ?? null,
          mediaProfile
        });
      } catch (error) {
        logger.error('metadata:playlist-selection:review-failed', {
          jobId,
          selectedPlaylist: normalizedSelectedPlaylist,
          selectedTitleId: selectedTitleId ?? null,
          error: errorToMeta(error)
        });
        await this.failJob(jobId, 'MEDIAINFO_CHECK', error);
        throw error;
      }
      return historyService.getJobById(jobId);
    }

    const hasTitleInput = title !== undefined && title !== null && String(title).trim().length > 0;
    const effectiveTitle = hasTitleInput
      ? String(title).trim()
      : (job.title || job.detected_title || 'Unknown Title');
    const hasYearInput = year !== undefined && year !== null && String(year).trim() !== '';
    let effectiveYear = job.year ?? null;
    if (hasYearInput) {
      const parsedYear = Number(year);
      effectiveYear = Number.isNaN(parsedYear) ? null : parsedYear;
    }
    const effectiveImdbId = imdbId === undefined
      ? (job.imdb_id || null)
      : (imdbId || null);
    const selectedFromOmdb = fromOmdb === null || fromOmdb === undefined
      ? Number(job.selected_from_omdb || 0)
      : (fromOmdb ? 1 : 0);
    const posterValue = poster === undefined
      ? (job.poster_url || null)
      : (poster || null);

    // Fetch full OMDb details when selecting from OMDb with a valid IMDb ID.
    let omdbJsonValue = job.omdb_json || null;
    if (fromOmdb && effectiveImdbId) {
      try {
        const omdbFull = await omdbService.fetchByImdbId(effectiveImdbId);
        if (omdbFull?.raw) {
          omdbJsonValue = JSON.stringify(omdbFull.raw);
        }
      } catch (omdbErr) {
        logger.warn('metadata:omdb-fetch-failed', { jobId, imdbId: effectiveImdbId, error: errorToMeta(omdbErr) });
      }
    }

    const selectedMetadata = {
      title: effectiveTitle,
      year: effectiveYear,
      imdbId: effectiveImdbId,
      poster: posterValue
    };
    const settings = await settingsService.getEffectiveSettingsMap(mediaProfile);
    const ripMode = String(settings.makemkv_rip_mode || 'mkv').trim().toLowerCase() === 'backup'
      ? 'backup'
      : 'mkv';
    const isBackupMode = ripMode === 'backup';
    const metadataBase = buildRawMetadataBase({
      title: selectedMetadata.title || job.detected_title || null,
      year: selectedMetadata.year || null
    }, jobId);
    const existingRawPath = findExistingRawDirectory(settings.raw_dir, metadataBase);
    let updatedRawPath = existingRawPath || null;
    if (existingRawPath) {
      const existingRawState = resolveRawFolderStateFromPath(existingRawPath);
      const renameState = existingRawState === RAW_FOLDER_STATES.INCOMPLETE
        ? RAW_FOLDER_STATES.INCOMPLETE
        : RAW_FOLDER_STATES.RIP_COMPLETE;
      const renamedDirName = buildRawDirName(metadataBase, jobId, { state: renameState });
      const renamedRawPath = path.join(settings.raw_dir, renamedDirName);
      if (existingRawPath !== renamedRawPath && !fs.existsSync(renamedRawPath)) {
        try {
          fs.renameSync(existingRawPath, renamedRawPath);
          updatedRawPath = renamedRawPath;
          await historyService.updateRawPathByOldPath(existingRawPath, renamedRawPath);
          logger.info('metadata:raw-dir-renamed', { from: existingRawPath, to: renamedRawPath, jobId, state: renameState });
        } catch (renameError) {
          logger.warn('metadata:raw-dir-rename-failed', { existingRawPath, renamedRawPath, error: errorToMeta(renameError) });
        }
      }
    }
    const basePlaylistDecision = this.resolvePlaylistDecisionForJob(jobId, job, selectedPlaylist);
    const playlistDecision = isBackupMode
      ? {
        ...basePlaylistDecision,
        playlistAnalysis: null,
        playlistDecisionRequired: false,
        candidatePlaylists: [],
        selectedPlaylist: null,
        selectedTitleId: null,
        recommendation: null
      }
      : basePlaylistDecision;
    const requiresManualPlaylistSelection = Boolean(
      playlistDecision.playlistDecisionRequired && playlistDecision.selectedTitleId === null
    );
    const nextStatus = requiresManualPlaylistSelection ? 'WAITING_FOR_USER_DECISION' : 'READY_TO_START';

    const updatedMakemkvInfo = this.withAnalyzeContextMediaProfile({
      ...mkInfo,
      analyzeContext: {
        ...(mkInfo?.analyzeContext || {}),
        playlistAnalysis: playlistDecision.playlistAnalysis || mkInfo?.analyzeContext?.playlistAnalysis || null,
        playlistDecisionRequired: Boolean(playlistDecision.playlistDecisionRequired),
        selectedPlaylist: playlistDecision.selectedPlaylist || null,
        selectedTitleId: playlistDecision.selectedTitleId ?? null
      }
    }, mediaProfile);

    await historyService.updateJob(jobId, {
      title: effectiveTitle,
      year: effectiveYear,
      imdb_id: effectiveImdbId,
      poster_url: posterValue,
      selected_from_omdb: selectedFromOmdb,
      omdb_json: omdbJsonValue,
      status: nextStatus,
      last_state: nextStatus,
      raw_path: updatedRawPath,
      makemkv_info_json: JSON.stringify(updatedMakemkvInfo)
    });

    // Bild in Cache laden (async, blockiert nicht)
    if (posterValue && !thumbnailService.isLocalUrl(posterValue)) {
      thumbnailService.cacheJobThumbnail(jobId, posterValue).catch(() => {});
    }

    const runningJobs = await historyService.getRunningJobs();
    const foreignRunningJobs = runningJobs.filter((item) => Number(item?.id) !== Number(jobId));
    const keepCurrentPipelineSession = foreignRunningJobs.length > 0;

    if (existingRawPath) {
      await historyService.appendLog(
        jobId,
        'SYSTEM',
        `Vorhandenes RAW-Verzeichnis erkannt: ${existingRawPath}`
      );
    } else {
      await historyService.appendLog(
        jobId,
        'SYSTEM',
        `Kein bestehendes RAW-Verzeichnis zu den Metadaten gefunden (${metadataBase}).`
      );
    }

    if (!keepCurrentPipelineSession) {
      await this.setState(nextStatus, {
        activeJobId: jobId,
        progress: 0,
        eta: null,
        statusText: requiresManualPlaylistSelection
          ? 'waiting_for_manual_playlist_selection'
          : (existingRawPath
            ? 'Metadaten übernommen - vorhandenes RAW erkannt'
            : 'Metadaten übernommen - bereit zum Start'),
        context: {
          ...(this.snapshot.context || {}),
          jobId,
          rawPath: updatedRawPath,
          mediaProfile,
          selectedMetadata,
          playlistAnalysis: playlistDecision.playlistAnalysis || null,
          playlistDecisionRequired: Boolean(playlistDecision.playlistDecisionRequired),
          playlistCandidates: playlistDecision.candidatePlaylists,
          selectedPlaylist: playlistDecision.selectedPlaylist || null,
          selectedTitleId: playlistDecision.selectedTitleId ?? null,
          waitingForManualPlaylistSelection: requiresManualPlaylistSelection,
          manualDecisionState: requiresManualPlaylistSelection
            ? 'waiting_for_manual_playlist_selection'
            : null
        }
      });
    } else {
      await historyService.appendLog(
        jobId,
        'SYSTEM',
        `Metadaten übernommen. Aktive Session bleibt bei laufendem Job #${foreignRunningJobs.map((item) => item.id).join(',')}.`
      );
    }

    if (requiresManualPlaylistSelection) {
      const playlistFiles = playlistDecision.candidatePlaylists
        .map((item) => item.playlistFile)
        .filter(Boolean);
      const recommendationFile = toPlaylistFile(playlistDecision.recommendation?.playlistId);
      const decisionContext = describePlaylistManualDecision(playlistDecision.playlistAnalysis);
      await historyService.appendLog(
        jobId,
        'SYSTEM',
        `${decisionContext.detailText} Status=waiting_for_manual_playlist_selection. Kandidaten: ${playlistFiles.join(', ') || 'keine'}.`
      );
      if (recommendationFile) {
        await historyService.appendLog(jobId, 'SYSTEM', `Empfehlung laut MakeMKV-TINFO-Analyse: ${recommendationFile}`);
      }
      await historyService.appendLog(
        jobId,
        'SYSTEM',
        'Bitte selected_playlist setzen (z.B. 00800 oder 00800.mpls), bevor Backup/Encoding gestartet wird.'
      );
      return historyService.getJobById(jobId);
    }

    if (playlistDecision.playlistDecisionRequired && playlistDecision.selectedPlaylist) {
      await historyService.appendLog(
        jobId,
        'SYSTEM',
        `Manuelle Playlist-Auswahl übernommen: ${toPlaylistFile(playlistDecision.selectedPlaylist) || playlistDecision.selectedPlaylist}`
      );
    }

    if (existingRawPath) {
      await historyService.appendLog(
        jobId,
        'SYSTEM',
        'Metadaten übernommen. Starte automatische Spur-Ermittlung (Mediainfo) mit vorhandenem RAW.'
      );
      const startResult = await this.startPreparedJob(jobId);
      logger.info('metadata:auto-track-review-started', {
        jobId,
        stage: startResult?.stage || null,
        reusedRaw: Boolean(startResult?.reusedRaw),
        selectedPlaylist: playlistDecision.selectedPlaylist || null,
        selectedTitleId: playlistDecision.selectedTitleId ?? null
      });
      return historyService.getJobById(jobId);
    }

    await historyService.appendLog(
      jobId,
      'SYSTEM',
      'Metadaten übernommen. Starte Backup/Rip automatisch.'
    );
    const startResult = await this.startPreparedJob(jobId);
    logger.info('metadata:auto-start', {
      jobId,
      stage: startResult?.stage || null,
      reusedRaw: Boolean(startResult?.reusedRaw),
      selectedPlaylist: playlistDecision.selectedPlaylist || null,
      selectedTitleId: playlistDecision.selectedTitleId ?? null
    });

    return historyService.getJobById(jobId);
  }

  async startPreparedJob(jobId, options = {}) {
    const immediate = Boolean(options?.immediate);
    if (!immediate) {
      const preloadedJob = await historyService.getJobById(jobId);
      if (!preloadedJob) {
        const error = new Error(`Job ${jobId} nicht gefunden.`);
        error.statusCode = 404;
        throw error;
      }
      if (!preloadedJob.title && !preloadedJob.detected_title) {
        const error = new Error('Start nicht möglich: keine Metadaten vorhanden.');
        error.statusCode = 400;
        throw error;
      }

      const isReadyToEncode = preloadedJob.status === 'READY_TO_ENCODE' || preloadedJob.last_state === 'READY_TO_ENCODE';
      if (isReadyToEncode) {
        // Check whether this confirmed job will rip first (pre_rip mode) or encode directly.
        // Pre-rip jobs bypass the encode queue because the next step is a rip, not an encode.
        const jobEncodePlan = this.safeParseJson(preloadedJob.encode_plan_json);
        const jobMode = String(jobEncodePlan?.mode || '').trim().toLowerCase();
        const willRipFirst = jobMode === 'pre_rip' || Boolean(jobEncodePlan?.preRip);
        if (willRipFirst) {
          return this.startPreparedJob(jobId, { ...options, immediate: true });
        }
        return this.enqueueOrStartAction(
          QUEUE_ACTIONS.START_PREPARED,
          jobId,
          () => this.startPreparedJob(jobId, { ...options, immediate: true })
        );
      }

      let hasUsableRawInput = false;
      if (preloadedJob.raw_path) {
        try {
          if (fs.existsSync(preloadedJob.raw_path)) {
            const playlistDecision = this.resolvePlaylistDecisionForJob(jobId, preloadedJob);
            hasUsableRawInput = Boolean(findPreferredRawInput(preloadedJob.raw_path, {
              playlistAnalysis: playlistDecision.playlistAnalysis,
              selectedPlaylistId: playlistDecision.selectedPlaylist
            }));
          }
        } catch (_error) {
          hasUsableRawInput = false;
        }
      }

      if (!hasUsableRawInput) {
        // No raw input yet → will rip from disc. Bypass the encode queue entirely.
        return this.startPreparedJob(jobId, { ...options, immediate: true });
      }

      return this.startPreparedJob(jobId, { ...options, immediate: true, preloadedJob });
    }

    this.ensureNotBusy('startPreparedJob', jobId);
    logger.info('startPreparedJob:requested', { jobId });
    this.cancelRequestedByJob.delete(Number(jobId));

    const job = options?.preloadedJob || await historyService.getJobById(jobId);
    if (!job) {
      const error = new Error(`Job ${jobId} nicht gefunden.`);
      error.statusCode = 404;
      throw error;
    }

    if (!job.title && !job.detected_title) {
      const error = new Error('Start nicht möglich: keine Metadaten vorhanden.');
      error.statusCode = 400;
      throw error;
    }

    await historyService.resetProcessLog(jobId);

    const encodePlanForReadyState = this.safeParseJson(job.encode_plan_json);
    const readyMode = String(encodePlanForReadyState?.mode || '').trim().toLowerCase();
    const isPreRipReadyState = readyMode === 'pre_rip' || Boolean(encodePlanForReadyState?.preRip);
    const isReadyToEncode = job.status === 'READY_TO_ENCODE' || job.last_state === 'READY_TO_ENCODE';
    if (isReadyToEncode) {
      if (!Number(job.encode_review_confirmed || 0)) {
        const error = new Error('Encode-Start nicht erlaubt: Mediainfo-Prüfung muss zuerst bestätigt werden.');
        error.statusCode = 409;
        throw error;
      }

      if (isPreRipReadyState) {
        await historyService.updateJob(jobId, {
          status: 'RIPPING',
          last_state: 'RIPPING',
          error_message: null,
          end_time: null
        });

        this.startRipEncode(jobId).catch((error) => {
          logger.error('startPreparedJob:rip-background-failed', { jobId, error: errorToMeta(error) });
        });

        return { started: true, stage: 'RIPPING' };
      }

      await historyService.updateJob(jobId, {
        status: 'ENCODING',
        last_state: 'ENCODING',
        error_message: null,
        end_time: null
      });

      this.startEncodingFromPrepared(jobId).catch((error) => {
        logger.error('startPreparedJob:encode-background-failed', { jobId, error: errorToMeta(error) });
        if (error?.jobAlreadyFailed) {
          return;
        }
        this.failJob(jobId, 'ENCODING', error).catch((failError) => {
          logger.error('startPreparedJob:encode-background-failJob-failed', {
            jobId,
            error: errorToMeta(failError)
          });
        });
      });

      return { started: true, stage: 'ENCODING' };
    }

    const playlistDecision = this.resolvePlaylistDecisionForJob(jobId, job);
    const mediaProfile = this.resolveMediaProfileForJob(job, {
      encodePlan: encodePlanForReadyState
    });
    const settings = await settingsService.getEffectiveSettingsMap(mediaProfile);
    const ripMode = String(settings.makemkv_rip_mode || 'mkv').trim().toLowerCase() === 'backup'
      ? 'backup'
      : 'mkv';
    const enforcePlaylistBeforeStart = ripMode !== 'backup';
    if (enforcePlaylistBeforeStart && playlistDecision.playlistDecisionRequired && playlistDecision.selectedTitleId === null) {
      const error = new Error(
        'Start nicht möglich: waiting_for_manual_playlist_selection aktiv. Bitte zuerst selected_playlist setzen.'
      );
      error.statusCode = 409;
      throw error;
    }

    let existingRawInput = null;
    if (job.raw_path) {
      try {
        if (fs.existsSync(job.raw_path)) {
          existingRawInput = findPreferredRawInput(job.raw_path, {
            playlistAnalysis: playlistDecision.playlistAnalysis,
            selectedPlaylistId: playlistDecision.selectedPlaylist
          });
        }
      } catch (error) {
        logger.warn('startPreparedJob:existing-raw-check-failed', {
          jobId,
          rawPath: job.raw_path,
          error: errorToMeta(error)
        });
      }
    }

    if (existingRawInput) {
      await historyService.updateJob(jobId, {
        status: 'MEDIAINFO_CHECK',
        last_state: 'MEDIAINFO_CHECK',
        start_time: nowIso(),
        end_time: null,
        error_message: null,
        output_path: null,
        handbrake_info_json: null,
        mediainfo_info_json: null,
        encode_plan_json: null,
        encode_input_path: null,
        encode_review_confirmed: 0
      });

      await historyService.appendLog(
        jobId,
        'SYSTEM',
        `Vorhandenes RAW wird verwendet. Starte Titel-/Spurprüfung: ${job.raw_path}`
      );

      this.runReviewForRawJob(jobId, job.raw_path, {
        mode: 'rip',
        mediaProfile
      }).catch((error) => {
        logger.error('startPreparedJob:review-background-failed', { jobId, error: errorToMeta(error) });
        this.failJob(jobId, 'MEDIAINFO_CHECK', error).catch((failError) => {
          logger.error('startPreparedJob:review-background-failJob-failed', {
            jobId,
            error: errorToMeta(failError)
          });
        });
      });

      return {
        started: true,
        stage: 'MEDIAINFO_CHECK',
        reusedRaw: true,
        rawPath: job.raw_path
      };
    }

    if (job.raw_path) {
      await historyService.appendLog(
        jobId,
        'SYSTEM',
        `Kein verwertbares RAW unter ${job.raw_path} gefunden. Starte neuen Rip.`
      );
    }

    await historyService.updateJob(jobId, {
      status: 'RIPPING',
      last_state: 'RIPPING',
      error_message: null,
      end_time: null,
      handbrake_info_json: null,
      mediainfo_info_json: null,
      encode_plan_json: null,
      encode_input_path: null,
      encode_review_confirmed: 0,
      output_path: null
    });

    this.startRipEncode(jobId).catch((error) => {
      logger.error('startPreparedJob:background-failed', { jobId, error: errorToMeta(error) });
    });

    return { started: true, stage: 'RIPPING' };
  }

  async confirmEncodeReview(jobId, options = {}) {
    this.ensureNotBusy('confirmEncodeReview', jobId);
    const skipPipelineStateUpdate = Boolean(options?.skipPipelineStateUpdate);
    logger.info('confirmEncodeReview:requested', {
      jobId,
      selectedEncodeTitleId: options?.selectedEncodeTitleId ?? null,
      selectedTrackSelectionProvided: Boolean(options?.selectedTrackSelection),
      skipPipelineStateUpdate,
      selectedPostEncodeScriptIdsCount: Array.isArray(options?.selectedPostEncodeScriptIds)
        ? options.selectedPostEncodeScriptIds.length
        : 0
    });

    let job = await historyService.getJobById(jobId);
    if (!job) {
      const error = new Error(`Job ${jobId} nicht gefunden.`);
      error.statusCode = 404;
      throw error;
    }

    if (job.status !== 'READY_TO_ENCODE' && job.last_state !== 'READY_TO_ENCODE') {
      const currentStatus = String(job.status || job.last_state || '').trim().toUpperCase();
      const recoverableStatus = currentStatus === 'ERROR' || currentStatus === 'CANCELLED';
      const recoveryPlan = this.safeParseJson(job.encode_plan_json);
      const recoveryMode = String(recoveryPlan?.mode || '').trim().toLowerCase();
      const recoveryPreRip = recoveryMode === 'pre_rip' || Boolean(recoveryPlan?.preRip);
      const recoveryHasInput = recoveryPreRip
        ? Boolean(recoveryPlan?.encodeInputTitleId)
        : Boolean(job?.encode_input_path || recoveryPlan?.encodeInputPath || job?.raw_path);
      const recoveryHasConfirmedPlan = Boolean(
        recoveryPlan
        && Array.isArray(recoveryPlan?.titles)
        && recoveryPlan.titles.length > 0
        && (Number(job?.encode_review_confirmed || 0) === 1 || Boolean(recoveryPlan?.reviewConfirmed))
        && recoveryHasInput
      );
      if (recoverableStatus && recoveryHasConfirmedPlan) {
        await historyService.appendLog(
          jobId,
          'SYSTEM',
          `Bestätigung angefordert obwohl Status ${currentStatus}. Letzte Encode-Auswahl wird automatisch geladen.`
        );
        await this.restartEncodeWithLastSettings(jobId, {
          immediate: true,
          triggerReason: 'confirm_auto_prepare'
        });
        job = await historyService.getJobById(jobId);
      }
    }

    if (!job || (job.status !== 'READY_TO_ENCODE' && job.last_state !== 'READY_TO_ENCODE')) {
      const error = new Error('Bestätigung nicht möglich: Job ist nicht im Status READY_TO_ENCODE.');
      error.statusCode = 409;
      throw error;
    }

    const encodePlan = this.safeParseJson(job.encode_plan_json);
    if (!encodePlan || !Array.isArray(encodePlan.titles)) {
      const error = new Error('Bestätigung nicht möglich: keine Mediainfo-Auswertung vorhanden.');
      error.statusCode = 400;
      throw error;
    }

    const selectedEncodeTitleId = options?.selectedEncodeTitleId ?? null;
    const planWithSelectionResult = applyEncodeTitleSelectionToPlan(encodePlan, selectedEncodeTitleId);
    let planForConfirm = planWithSelectionResult.plan;
    const trackSelectionResult = applyManualTrackSelectionToPlan(
      planForConfirm,
      options?.selectedTrackSelection || null
    );
    planForConfirm = trackSelectionResult.plan;
    const hasExplicitPostScriptSelection = options?.selectedPostEncodeScriptIds !== undefined;
    const selectedPostEncodeScriptIds = hasExplicitPostScriptSelection
      ? normalizeScriptIdList(options?.selectedPostEncodeScriptIds || [])
      : normalizeScriptIdList(planForConfirm?.postEncodeScriptIds || encodePlan?.postEncodeScriptIds || []);
    const selectedPostEncodeScripts = await scriptService.resolveScriptsByIds(selectedPostEncodeScriptIds, {
      strict: true
    });

    const hasExplicitPreScriptSelection = options?.selectedPreEncodeScriptIds !== undefined;
    const selectedPreEncodeScriptIds = hasExplicitPreScriptSelection
      ? normalizeScriptIdList(options?.selectedPreEncodeScriptIds || [])
      : normalizeScriptIdList(planForConfirm?.preEncodeScriptIds || encodePlan?.preEncodeScriptIds || []);
    const selectedPreEncodeScripts = await scriptService.resolveScriptsByIds(selectedPreEncodeScriptIds, { strict: true });

    const hasExplicitPostChainSelection = options?.selectedPostEncodeChainIds !== undefined;
    const selectedPostEncodeChainIds = hasExplicitPostChainSelection
      ? normalizeChainIdList(options?.selectedPostEncodeChainIds || [])
      : normalizeChainIdList(planForConfirm?.postEncodeChainIds || encodePlan?.postEncodeChainIds || []);

    const hasExplicitPreChainSelection = options?.selectedPreEncodeChainIds !== undefined;
    const selectedPreEncodeChainIds = hasExplicitPreChainSelection
      ? normalizeChainIdList(options?.selectedPreEncodeChainIds || [])
      : normalizeChainIdList(planForConfirm?.preEncodeChainIds || encodePlan?.preEncodeChainIds || []);

    const confirmedMode = String(planForConfirm?.mode || encodePlan?.mode || 'rip').trim().toLowerCase();
    const isPreRipMode = confirmedMode === 'pre_rip' || Boolean(planForConfirm?.preRip);

    if (planForConfirm?.playlistDecisionRequired && !planForConfirm?.encodeInputPath && !planForConfirm?.encodeInputTitleId) {
      const error = new Error('Bestätigung nicht möglich: Bitte zuerst einen Titel per Checkbox auswählen.');
      error.statusCode = 400;
      throw error;
    }

    // Resolve user preset: explicit payload wins, otherwise preserve currently selected preset from encode plan.
    const hasExplicitUserPresetSelection = Object.prototype.hasOwnProperty.call(options || {}, 'selectedUserPresetId');
    let resolvedUserPreset = null;
    if (hasExplicitUserPresetSelection) {
      const rawUserPresetId = options?.selectedUserPresetId;
      const userPresetId = rawUserPresetId !== null && rawUserPresetId !== undefined && String(rawUserPresetId).trim() !== ''
        ? Number(rawUserPresetId)
        : null;
      if (Number.isFinite(userPresetId) && userPresetId > 0) {
        resolvedUserPreset = await userPresetService.getPresetById(userPresetId);
        if (!resolvedUserPreset) {
          const error = new Error(`User-Preset ${userPresetId} nicht gefunden.`);
          error.statusCode = 404;
          throw error;
        }
      }
    } else {
      resolvedUserPreset = normalizeUserPresetForPlan(encodePlan?.userPreset || null);
    }

    const confirmedPlan = {
      ...planForConfirm,
      postEncodeScriptIds: selectedPostEncodeScripts.map((item) => Number(item.id)),
      postEncodeScripts: selectedPostEncodeScripts.map((item) => ({
        id: Number(item.id),
        name: item.name
      })),
      preEncodeScriptIds: selectedPreEncodeScripts.map((item) => Number(item.id)),
      preEncodeScripts: selectedPreEncodeScripts.map((item) => ({
        id: Number(item.id),
        name: item.name
      })),
      postEncodeChainIds: selectedPostEncodeChainIds,
      preEncodeChainIds: selectedPreEncodeChainIds,
      reviewConfirmed: true,
      reviewConfirmedAt: nowIso(),
      userPreset: normalizeUserPresetForPlan(resolvedUserPreset)
    };
    const readyMediaProfile = this.resolveMediaProfileForJob(job, {
      encodePlan: confirmedPlan
    });
    const confirmSettings = await settingsService.getEffectiveSettingsMap(readyMediaProfile);
    const resolvedConfirmRawPath = this.resolveCurrentRawPathForSettings(
      confirmSettings,
      readyMediaProfile,
      job.raw_path
    );
    const activeConfirmRawPath = resolvedConfirmRawPath || String(job.raw_path || '').trim() || null;

    let inputPath = isPreRipMode
      ? null
      : (job.encode_input_path || confirmedPlan.encodeInputPath || this.snapshot.context?.inputPath || null);
    if (!isPreRipMode && activeConfirmRawPath) {
      const needsInputRefresh = !inputPath
        || !fs.existsSync(inputPath)
        || !isPathInsideDirectory(activeConfirmRawPath, inputPath);
      if (needsInputRefresh) {
        const selectedPlaylistId = normalizePlaylistId(
          confirmedPlan?.selectedPlaylistId
          || confirmedPlan?.selectedPlaylist
          || null
        );
        if (hasBluRayBackupStructure(activeConfirmRawPath)) {
          inputPath = activeConfirmRawPath;
        } else {
          const playlistDecision = this.resolvePlaylistDecisionForJob(jobId, job, selectedPlaylistId);
          inputPath = findPreferredRawInput(activeConfirmRawPath, {
            playlistAnalysis: playlistDecision.playlistAnalysis,
            selectedPlaylistId: selectedPlaylistId || playlistDecision.selectedPlaylist
          })?.path || null;
        }
      }
    }
    confirmedPlan.encodeInputPath = inputPath;
    const hasEncodableTitle = isPreRipMode
      ? Boolean(confirmedPlan?.encodeInputTitleId)
      : Boolean(inputPath);

    await historyService.updateJob(jobId, {
      encode_review_confirmed: 1,
      encode_plan_json: JSON.stringify(confirmedPlan),
      encode_input_path: inputPath,
      ...(activeConfirmRawPath ? { raw_path: activeConfirmRawPath } : {})
    });
    await historyService.appendLog(
      jobId,
      'USER_ACTION',
      `Mediainfo-Prüfung bestätigt.${isPreRipMode ? ' Backup/Rip darf gestartet werden.' : ' Encode darf gestartet werden.'}${confirmedPlan.encodeInputTitleId ? ` Gewählter Titel #${confirmedPlan.encodeInputTitleId}.` : ''}`
      + ` Audio-Spuren: ${trackSelectionResult.audioTrackIds.length > 0 ? trackSelectionResult.audioTrackIds.join(',') : 'none'}.`
      + ` Subtitle-Spuren: ${trackSelectionResult.subtitleTrackIds.length > 0 ? trackSelectionResult.subtitleTrackIds.join(',') : 'none'}.`
      + ` Pre-Encode-Scripte: ${selectedPreEncodeScripts.length > 0 ? selectedPreEncodeScripts.map((item) => item.name).join(' -> ') : 'none'}.`
      + ` Pre-Encode-Ketten: ${selectedPreEncodeChainIds.length > 0 ? selectedPreEncodeChainIds.join(',') : 'none'}.`
      + ` Post-Encode-Scripte: ${selectedPostEncodeScripts.length > 0 ? selectedPostEncodeScripts.map((item) => item.name).join(' -> ') : 'none'}.`
      + ` Post-Encode-Ketten: ${selectedPostEncodeChainIds.length > 0 ? selectedPostEncodeChainIds.join(',') : 'none'}.`
      + (resolvedUserPreset
        ? ` User-Preset: "${resolvedUserPreset.name}"${resolvedUserPreset.id ? ` (ID ${resolvedUserPreset.id})` : ''}.`
        : '')
    );

    if (!skipPipelineStateUpdate) {
      await this.setState('READY_TO_ENCODE', {
        activeJobId: jobId,
        progress: 0,
        eta: null,
        statusText: hasEncodableTitle
          ? (isPreRipMode
            ? 'Spurauswahl bestätigt - Backup/Rip + Encode manuell starten'
            : 'Mediainfo bestätigt - Encode manuell starten')
          : (isPreRipMode
            ? 'Spurauswahl bestätigt - kein passender Titel gewählt'
            : 'Mediainfo bestätigt - kein Titel erfüllt MIN_LENGTH_MINUTES'),
        context: {
          ...(this.snapshot.context || {}),
          jobId,
          inputPath,
          hasEncodableTitle,
          mediaProfile: readyMediaProfile,
          mediaInfoReview: confirmedPlan,
          reviewConfirmed: true
        }
      });
    }

    return historyService.getJobById(jobId);
  }

  async reencodeFromRaw(sourceJobId, options = {}) {
    this.ensureNotBusy('reencodeFromRaw', sourceJobId);
    logger.info('reencodeFromRaw:requested', { sourceJobId });
    this.cancelRequestedByJob.delete(Number(sourceJobId));

    const sourceJob = await historyService.getJobById(sourceJobId);
    if (!sourceJob) {
      const error = new Error(`Quelle-Job ${sourceJobId} nicht gefunden.`);
      error.statusCode = 404;
      throw error;
    }

    if (!sourceJob.raw_path) {
      const error = new Error('Re-Encode nicht möglich: raw_path fehlt.');
      error.statusCode = 400;
      throw error;
    }

    if (['ANALYZING', 'RIPPING', 'MEDIAINFO_CHECK', 'ENCODING'].includes(sourceJob.status)) {
      const error = new Error('Re-Encode nicht möglich: Quelljob ist noch aktiv.');
      error.statusCode = 409;
      throw error;
    }

    const mkInfo = this.safeParseJson(sourceJob.makemkv_info_json);
    const ripSuccessful = this.isRipSuccessful(sourceJob);
    if (!ripSuccessful) {
      const error = new Error(
        `Re-Encode nicht möglich: RAW-Rip ist nicht abgeschlossen (MakeMKV Status ${mkInfo?.status || 'unknown'}).`
      );
      error.statusCode = 400;
      throw error;
    }

    const reencodeMediaProfile = this.resolveMediaProfileForJob(sourceJob, {
      makemkvInfo: mkInfo,
      rawPath: sourceJob.raw_path
    });
    const reencodeSettings = await settingsService.getSettingsMap();
    const resolvedReencodeRawPath = this.resolveCurrentRawPathForSettings(
      reencodeSettings,
      reencodeMediaProfile,
      sourceJob.raw_path
    );
    if (!resolvedReencodeRawPath) {
      const error = new Error(`Re-Encode nicht möglich: RAW-Pfad existiert nicht (${sourceJob.raw_path}).`);
      error.statusCode = 400;
      throw error;
    }

    await historyService.resetProcessLog(sourceJobId);

    const rawInput = findPreferredRawInput(resolvedReencodeRawPath);
    if (!rawInput) {
      const error = new Error('Re-Encode nicht möglich: keine Datei im RAW-Pfad gefunden.');
      error.statusCode = 400;
      throw error;
    }

    const resetMakemkvInfoJson = (mkInfo && typeof mkInfo === 'object')
      ? JSON.stringify({
        ...mkInfo,
        analyzeContext: {
          ...(mkInfo?.analyzeContext || {}),
          selectedPlaylist: null,
          selectedTitleId: null
        }
      })
      : (sourceJob.makemkv_info_json || null);

    const reencodeJobUpdate = {
      status: 'MEDIAINFO_CHECK',
      last_state: 'MEDIAINFO_CHECK',
      start_time: nowIso(),
      end_time: null,
      error_message: null,
      output_path: null,
      handbrake_info_json: null,
      mediainfo_info_json: null,
      encode_plan_json: null,
      encode_input_path: null,
      encode_review_confirmed: 0,
      makemkv_info_json: resetMakemkvInfoJson
    };
    if (resolvedReencodeRawPath !== sourceJob.raw_path) {
      reencodeJobUpdate.raw_path = resolvedReencodeRawPath;
    }
    await historyService.updateJob(sourceJobId, reencodeJobUpdate);
    await historyService.appendLog(
      sourceJobId,
      'USER_ACTION',
      `Re-Encode angefordert. Bestehender Job wird wiederverwendet. Input-Kandidat: ${rawInput.path}`
    );

    this.runReviewForRawJob(sourceJobId, resolvedReencodeRawPath, {
      mode: 'reencode',
      sourceJobId,
      forcePlaylistReselection: true,
      mediaProfile: this.resolveMediaProfileForJob(sourceJob, { makemkvInfo: mkInfo, rawPath: resolvedReencodeRawPath })
    }).catch((error) => {
      logger.error('reencodeFromRaw:background-failed', { jobId: sourceJobId, sourceJobId, error: errorToMeta(error) });
      this.failJob(sourceJobId, 'MEDIAINFO_CHECK', error).catch((failError) => {
        logger.error('reencodeFromRaw:background-failJob-failed', {
          jobId: sourceJobId,
          sourceJobId,
          error: errorToMeta(failError)
        });
      });
    });

    return {
      started: true,
      stage: 'MEDIAINFO_CHECK',
      sourceJobId,
      jobId: sourceJobId
    };
  }

  async runMediainfoForFile(jobId, inputPath, options = {}) {
    const lines = [];
    const config = await settingsService.buildMediaInfoConfig(inputPath, {
      mediaProfile: options?.mediaProfile || null,
      settingsMap: options?.settingsMap || null
    });
    logger.info('mediainfo:command', { jobId, inputPath, cmd: config.cmd, args: config.args });

    const runInfo = await this.runCommand({
      jobId,
      stage: 'MEDIAINFO_CHECK',
      source: 'MEDIAINFO',
      cmd: config.cmd,
      args: config.args,
      collectLines: lines,
      collectStderrLines: false
    });

    const parsed = parseMediainfoJsonOutput(lines.join('\n'));
    if (!parsed) {
      const error = new Error(`Mediainfo-Ausgabe konnte nicht als JSON gelesen werden (${path.basename(inputPath)}).`);
      error.runInfo = runInfo;
      throw error;
    }

    return {
      runInfo,
      parsed
    };
  }

  async runDvdTrackFallbackForFile(jobId, inputPath, options = {}) {
    const lines = [];
    const scanConfig = await settingsService.buildHandBrakeScanConfigForInput(inputPath, {
      mediaProfile: options?.mediaProfile || null,
      settingsMap: options?.settingsMap || null
    });
    logger.info('mediainfo:track-fallback:handbrake-scan:command', {
      jobId,
      inputPath,
      cmd: scanConfig.cmd,
      args: scanConfig.args
    });

    const runInfo = await this.runCommand({
      jobId,
      stage: 'MEDIAINFO_CHECK',
      source: 'HANDBRAKE_SCAN_DVD_TRACK_FALLBACK',
      cmd: scanConfig.cmd,
      args: scanConfig.args,
      collectLines: lines,
      collectStderrLines: false
    });

    const parsedScan = parseMediainfoJsonOutput(lines.join('\n'));
    if (!parsedScan) {
      return {
        runInfo,
        parsedMediaInfo: null,
        titleInfo: null
      };
    }

    const titleInfo = parseHandBrakeSelectedTitleInfo(parsedScan);
    if (!titleInfo) {
      return {
        runInfo,
        parsedMediaInfo: null,
        titleInfo: null
      };
    }

    return {
      runInfo,
      parsedMediaInfo: buildSyntheticMediaInfoFromMakeMkvTitle(titleInfo),
      titleInfo
    };
  }

  async runMediainfoReviewForJob(jobId, rawPath, options = {}) {
    this.ensureNotBusy('runMediainfoReviewForJob', jobId);
    logger.info('mediainfo:review:start', { jobId, rawPath, options });

    const job = await historyService.getJobById(jobId);
    if (!job) {
      const error = new Error(`Job ${jobId} nicht gefunden.`);
      error.statusCode = 404;
      throw error;
    }

    const mkInfo = this.safeParseJson(job.makemkv_info_json);
    const mediaProfile = this.resolveMediaProfileForJob(job, {
      mediaProfile: options?.mediaProfile,
      makemkvInfo: mkInfo,
      rawPath
    });
    const settings = await settingsService.getEffectiveSettingsMap(mediaProfile);
    const analyzeContext = mkInfo?.analyzeContext || {};
    const selectedPlaylistId = normalizePlaylistId(
      analyzeContext.selectedPlaylist
      || this.snapshot.context?.selectedPlaylist
      || null
    );
    const playlistAnalysis = analyzeContext.playlistAnalysis
      || this.snapshot.context?.playlistAnalysis
      || null;
    const preferredEncodeTitleId = normalizeNonNegativeInteger(analyzeContext.selectedTitleId);
    const rawMedia = collectRawMediaCandidates(rawPath, {
      playlistAnalysis,
      selectedPlaylistId
    });
    const mediaFiles = rawMedia.mediaFiles;
    if (mediaFiles.length === 0) {
      const error = new Error('Mediainfo-Prüfung nicht möglich: keine Datei im RAW-Pfad gefunden.');
      error.statusCode = 400;
      throw error;
    }
    await historyService.appendLog(
      jobId,
      'SYSTEM',
      `Mediainfo-Quelle: ${rawMedia.source} (${mediaFiles.length} Datei(en))`
    );
    let presetProfile = null;
    try {
      presetProfile = await settingsService.buildHandBrakePresetProfile(mediaFiles[0].path, {
        mediaProfile,
        settingsMap: settings
      });
    } catch (error) {
      logger.warn('mediainfo:review:preset-profile-failed', {
        jobId,
        error: errorToMeta(error)
      });
      presetProfile = {
        source: 'fallback',
        message: `Preset-Profil konnte nicht geladen werden: ${error.message}`
      };
    }

    const selectedMetadata = {
      title: job.title || job.detected_title || null,
      year: job.year || null,
      imdbId: job.imdb_id || null,
      poster: job.poster_url || null
    };

    if (this.isPrimaryJob(jobId)) {
      await this.setState('MEDIAINFO_CHECK', {
        activeJobId: jobId,
        progress: 0,
        eta: null,
        statusText: 'Mediainfo-Prüfung läuft',
        context: {
          jobId,
          rawPath,
          reviewConfirmed: false,
          mode: options.mode || 'rip',
          mediaProfile,
          sourceJobId: options.sourceJobId || null,
          selectedMetadata
        }
      });
    }

    await historyService.updateJob(jobId, {
      status: 'MEDIAINFO_CHECK',
      last_state: 'MEDIAINFO_CHECK',
      makemkv_info_json: JSON.stringify(this.withAnalyzeContextMediaProfile(mkInfo, mediaProfile))
    });

    const mediaInfoByPath = {};
    const mediaInfoRuns = [];
    const buildReviewSnapshot = (processedCount) => {
      const processedFiles = mediaFiles
        .slice(0, processedCount)
        .filter((item) => Boolean(mediaInfoByPath[item.path]));

      if (processedFiles.length === 0) {
        return null;
      }

      return {
        ...buildMediainfoReview({
          mediaFiles: processedFiles,
          mediaInfoByPath,
          settings,
          presetProfile,
          playlistAnalysis,
          preferredEncodeTitleId,
          selectedPlaylistId,
          selectedMakemkvTitleId: preferredEncodeTitleId
        }),
        mode: options.mode || 'rip',
        mediaProfile,
        sourceJobId: options.sourceJobId || null,
        reviewConfirmed: false,
        partial: processedFiles.length < mediaFiles.length,
        processedFiles: processedFiles.length,
        totalFiles: mediaFiles.length
      };
    };

    for (let i = 0; i < mediaFiles.length; i += 1) {
      const file = mediaFiles[i];
      const percent = Number((((i + 1) / mediaFiles.length) * 100).toFixed(2));
      await this.updateProgress('MEDIAINFO_CHECK', percent, null, `Mediainfo ${i + 1}/${mediaFiles.length}: ${path.basename(file.path)}`, jobId);

      const result = await this.runMediainfoForFile(jobId, file.path, {
        mediaProfile,
        settingsMap: settings
      });
      let parsedMediaInfo = result.parsed;
      let fallbackRunInfo = null;
      if (shouldRunDvdTrackFallback(parsedMediaInfo, mediaProfile, file.path)) {
        try {
          const fallback = await this.runDvdTrackFallbackForFile(jobId, file.path, {
            mediaProfile,
            settingsMap: settings
          });
          if (fallback?.parsedMediaInfo) {
            parsedMediaInfo = fallback.parsedMediaInfo;
            fallbackRunInfo = fallback.runInfo || null;
            const audioCount = Array.isArray(fallback?.titleInfo?.audioTracks)
              ? fallback.titleInfo.audioTracks.length
              : 0;
            const subtitleCount = Array.isArray(fallback?.titleInfo?.subtitleTracks)
              ? fallback.titleInfo.subtitleTracks.length
              : 0;
            await historyService.appendLog(
              jobId,
              'SYSTEM',
              `DVD Track-Fallback aktiv (${path.basename(file.path)}): Audio=${audioCount}, Subtitle=${subtitleCount}.`
            );
          } else {
            await historyService.appendLog(
              jobId,
              'SYSTEM',
              `DVD Track-Fallback ohne Ergebnis (${path.basename(file.path)}).`
            );
          }
        } catch (error) {
          logger.warn('mediainfo:track-fallback:failed', {
            jobId,
            inputPath: file.path,
            error: errorToMeta(error)
          });
        }
      }

      mediaInfoByPath[file.path] = parsedMediaInfo;
      mediaInfoRuns.push({
        filePath: file.path,
        runInfo: result.runInfo,
        fallbackRunInfo
      });

      const partialReview = buildReviewSnapshot(i + 1);
      if (this.isPrimaryJob(jobId)) {
        await this.setState('MEDIAINFO_CHECK', {
          activeJobId: jobId,
          progress: percent,
          eta: null,
          statusText: `Mediainfo ${i + 1}/${mediaFiles.length} analysiert: ${path.basename(file.path)}`,
          context: {
            jobId,
            rawPath,
            inputPath: partialReview?.encodeInputPath || null,
            hasEncodableTitle: Boolean(partialReview?.encodeInputPath),
            reviewConfirmed: false,
            mode: options.mode || 'rip',
            mediaProfile,
            sourceJobId: options.sourceJobId || null,
            mediaInfoReview: partialReview,
            selectedMetadata
          }
        });
      }
    }

    const review = buildMediainfoReview({
      mediaFiles,
      mediaInfoByPath,
      settings,
      presetProfile,
      playlistAnalysis,
      preferredEncodeTitleId,
      selectedPlaylistId,
      selectedMakemkvTitleId: preferredEncodeTitleId
    });

    let enrichedReview = {
      ...review,
      mode: options.mode || 'rip',
      mediaProfile,
      sourceJobId: options.sourceJobId || null,
      reviewConfirmed: false,
      partial: false,
      processedFiles: mediaFiles.length,
      totalFiles: mediaFiles.length
    };
    const reviewPrefillResult = applyPreviousSelectionDefaultsToReviewPlan(
      enrichedReview,
      options?.previousEncodePlan && typeof options.previousEncodePlan === 'object'
        ? options.previousEncodePlan
        : null
    );
    enrichedReview = reviewPrefillResult.plan;
    const hasEncodableTitle = Boolean(enrichedReview.encodeInputPath);
    const titleSelectionRequired = Boolean(enrichedReview.titleSelectionRequired);
    if (!hasEncodableTitle && !titleSelectionRequired) {
      enrichedReview.notes = [
        ...(Array.isArray(enrichedReview.notes) ? enrichedReview.notes : []),
        'Kein Titel erfüllt aktuell MIN_LENGTH_MINUTES. Bitte Konfiguration prüfen.'
      ];
    }

    await historyService.updateJob(jobId, {
      status: 'READY_TO_ENCODE',
      last_state: 'READY_TO_ENCODE',
      error_message: null,
      mediainfo_info_json: JSON.stringify({
        generatedAt: nowIso(),
        files: mediaInfoRuns
      }),
      encode_plan_json: JSON.stringify(enrichedReview),
      encode_input_path: enrichedReview.encodeInputPath || null,
      encode_review_confirmed: 0
    });

    await historyService.appendLog(
      jobId,
      'SYSTEM',
      `Mediainfo-Prüfung abgeschlossen: ${enrichedReview.titles.length} Titel, Input=${enrichedReview.encodeInputPath || (titleSelectionRequired ? 'Titelauswahl erforderlich' : 'kein passender Titel')}`
    );
    if (reviewPrefillResult.applied) {
      await historyService.appendLog(
        jobId,
        'SYSTEM',
        `Vorherige Encode-Auswahl als Standard übernommen: Titel #${reviewPrefillResult.selectedEncodeTitleId || '-'}, `
        + `Pre-Skripte=${reviewPrefillResult.preEncodeScriptCount}, Pre-Ketten=${reviewPrefillResult.preEncodeChainCount}, `
        + `Post-Skripte=${reviewPrefillResult.postEncodeScriptCount}, Post-Ketten=${reviewPrefillResult.postEncodeChainCount}, `
        + `User-Preset=${reviewPrefillResult.userPresetApplied ? 'ja' : 'nein'}.`
      );
    }

    if (this.isPrimaryJob(jobId)) {
      await this.setState('READY_TO_ENCODE', {
        activeJobId: jobId,
        progress: 0,
        eta: null,
        statusText: titleSelectionRequired
          ? 'Mediainfo geprüft - Titelauswahl per Checkbox erforderlich'
          : (hasEncodableTitle
          ? 'Mediainfo geprüft - Encode manuell starten'
          : 'Mediainfo geprüft - kein Titel erfüllt MIN_LENGTH_MINUTES'),
        context: {
          jobId,
          rawPath,
          inputPath: enrichedReview.encodeInputPath || null,
          hasEncodableTitle,
          reviewConfirmed: false,
          mode: options.mode || 'rip',
          mediaProfile,
          sourceJobId: options.sourceJobId || null,
          mediaInfoReview: enrichedReview,
          selectedMetadata
        }
      });
    }

    void this.notifyPushover('metadata_ready', {
      title: 'Ripster - Mediainfo geprüft',
      message: `Job #${jobId}: bereit zum manuellen Encode-Start`
    });

    return enrichedReview;
  }

  async runEncodeChains(jobId, chainIds, context = {}, phase = 'post', progressTracker = null) {
    const ids = Array.isArray(chainIds) ? chainIds.map(Number).filter((id) => Number.isFinite(id) && id > 0) : [];
    if (ids.length === 0) {
      return { configured: 0, succeeded: 0, failed: 0, results: [] };
    }
    const results = [];
    let succeeded = 0;
    let failed = 0;
    for (let index = 0; index < ids.length; index += 1) {
      const chainId = ids[index];
      const chainLabel = `#${chainId}`;
      if (progressTracker?.onStepStart) {
        await progressTracker.onStepStart(phase, 'chain', index + 1, ids.length, chainLabel);
      }
      await historyService.appendLog(jobId, 'SYSTEM', `${phase === 'pre' ? 'Pre' : 'Post'}-Encode Kette startet (ID ${chainId})...`);
      try {
        const chainResult = await scriptChainService.executeChain(chainId, {
          ...context,
          jobId,
          source: phase === 'pre' ? 'pre_encode_chain' : 'post_encode_chain'
        }, {
          appendLog: (src, msg) => historyService.appendLog(jobId, src, msg)
        });
        if (chainResult.aborted || chainResult.failed > 0) {
          failed += 1;
          await historyService.appendLog(jobId, 'ERROR', `${phase === 'pre' ? 'Pre' : 'Post'}-Encode Kette "${chainResult.chainName}" fehlgeschlagen.`);
        } else {
          succeeded += 1;
          await historyService.appendLog(jobId, 'SYSTEM', `${phase === 'pre' ? 'Pre' : 'Post'}-Encode Kette "${chainResult.chainName}" erfolgreich.`);
        }
        if (progressTracker?.onStepComplete) {
          await progressTracker.onStepComplete(
            phase,
            'chain',
            index + 1,
            ids.length,
            chainResult.chainName || chainLabel,
            !(chainResult.aborted || chainResult.failed > 0)
          );
        }
        results.push({ chainId, ...chainResult });
      } catch (error) {
        failed += 1;
        results.push({ chainId, success: false, error: error.message });
        await historyService.appendLog(jobId, 'ERROR', `${phase === 'pre' ? 'Pre' : 'Post'}-Encode Kette ${chainId} Fehler: ${error.message}`);
        logger.warn(`encode:${phase}-chain:failed`, { jobId, chainId, error: errorToMeta(error) });
        if (progressTracker?.onStepComplete) {
          await progressTracker.onStepComplete(phase, 'chain', index + 1, ids.length, chainLabel, false);
        }
      }
    }
    return { configured: ids.length, succeeded, failed, results };
  }

  async runPreEncodeScripts(jobId, encodePlan, context = {}, progressTracker = null) {
    const scriptIds = normalizeScriptIdList(encodePlan?.preEncodeScriptIds || []);
    const chainIds = Array.isArray(encodePlan?.preEncodeChainIds) ? encodePlan.preEncodeChainIds : [];
    const executionStage = String(context?.pipelineStage || 'ENCODING').trim().toUpperCase() || 'ENCODING';
    if (scriptIds.length === 0 && chainIds.length === 0) {
      return { configured: 0, attempted: 0, succeeded: 0, failed: 0, skipped: 0, results: [] };
    }

    const scripts = await scriptService.resolveScriptsByIds(scriptIds, { strict: false });
    const scriptById = new Map(scripts.map((item) => [Number(item.id), item]));
    const results = [];
    let succeeded = 0;
    let failed = 0;
    let skipped = 0;
    let aborted = false;

    for (let index = 0; index < scriptIds.length; index += 1) {
      const scriptId = scriptIds[index];
      const script = scriptById.get(Number(scriptId));
      const scriptLabel = script?.name || `#${scriptId}`;
      if (progressTracker?.onStepStart) {
        await progressTracker.onStepStart('pre', 'script', index + 1, scriptIds.length, scriptLabel);
      }
      if (!script) {
        failed += 1;
        aborted = true;
        results.push({ scriptId, scriptName: null, status: 'ERROR', error: 'missing' });
        await historyService.appendLog(jobId, 'SYSTEM', `Pre-Encode Skript #${scriptId} nicht gefunden. Kette abgebrochen.`);
        if (progressTracker?.onStepComplete) {
          await progressTracker.onStepComplete('pre', 'script', index + 1, scriptIds.length, scriptLabel, false);
        }
        break;
      }
      await historyService.appendLog(jobId, 'SYSTEM', `Pre-Encode Skript startet (${index + 1}/${scriptIds.length}): ${script.name}`);
      const activityId = runtimeActivityService.startActivity('script', {
        name: script.name,
        source: 'pre_encode',
        scriptId: script.id,
        jobId,
        currentStep: `Pre-Encode ${index + 1}/${scriptIds.length}`
      });
      let prepared = null;
      try {
        prepared = await scriptService.createExecutableScriptFile(script, {
          source: 'pre_encode',
          mode: context?.mode || null,
          jobId,
          jobTitle: context?.jobTitle || null,
          inputPath: context?.inputPath || null,
          outputPath: context?.outputPath || null,
          rawPath: context?.rawPath || null
        });
        const runInfo = await this.runCommand({
          jobId,
          stage: executionStage,
          source: 'PRE_ENCODE_SCRIPT',
          cmd: prepared.cmd,
          args: prepared.args,
          argsForLog: prepared.argsForLog
        });
        succeeded += 1;
        results.push({ scriptId: script.id, scriptName: script.name, status: 'SUCCESS', runInfo });
        const runOutput = Array.isArray(runInfo?.highlights) ? runInfo.highlights.join('\n').trim() : '';
        runtimeActivityService.completeActivity(activityId, {
          status: 'success',
          success: true,
          outcome: 'success',
          exitCode: Number.isFinite(Number(runInfo?.exitCode)) ? Number(runInfo.exitCode) : null,
          message: 'Pre-Encode Skript erfolgreich',
          output: runOutput || null
        });
        await historyService.appendLog(jobId, 'SYSTEM', `Pre-Encode Skript erfolgreich: ${script.name}`);
        if (progressTracker?.onStepComplete) {
          await progressTracker.onStepComplete('pre', 'script', index + 1, scriptIds.length, script.name, true);
        }
      } catch (error) {
        const runInfo = error?.runInfo && typeof error.runInfo === 'object' ? error.runInfo : null;
        const runOutput = Array.isArray(runInfo?.highlights) ? runInfo.highlights.join('\n').trim() : '';
        const runStatus = String(runInfo?.status || '').trim().toUpperCase();
        const cancelled = runStatus === 'CANCELLED';
        runtimeActivityService.completeActivity(activityId, {
          status: 'error',
          success: false,
          outcome: cancelled ? 'cancelled' : 'error',
          cancelled,
          message: error?.message || 'Pre-Encode Skriptfehler',
          errorMessage: error?.message || 'Pre-Encode Skriptfehler',
          output: runOutput || null
        });
        failed += 1;
        aborted = true;
        results.push({ scriptId: script.id, scriptName: script.name, status: 'ERROR', error: error?.message || 'unknown' });
        await historyService.appendLog(jobId, 'SYSTEM', `Pre-Encode Skript fehlgeschlagen: ${script.name} (${error?.message || 'unknown'})`);
        logger.warn('encode:pre-script:failed', { jobId, scriptId: script.id, error: errorToMeta(error) });
        if (progressTracker?.onStepComplete) {
          await progressTracker.onStepComplete('pre', 'script', index + 1, scriptIds.length, script.name, false);
        }
        break;
      } finally {
        if (prepared?.cleanup) {
          await prepared.cleanup();
        }
      }
    }

    if (!aborted && chainIds.length > 0) {
      const chainResult = await this.runEncodeChains(jobId, chainIds, context, 'pre', progressTracker);
      if (chainResult.failed > 0) {
        aborted = true;
        failed += chainResult.failed;
      }
      succeeded += chainResult.succeeded;
      results.push(...chainResult.results);
    }

    if (aborted) {
      const pendingScripts = scriptIds.slice(results.filter((r) => r.scriptId != null).length);
      for (const pendingId of pendingScripts) {
        const s = scriptById.get(Number(pendingId));
        skipped += 1;
        results.push({ scriptId: Number(pendingId), scriptName: s?.name || null, status: 'SKIPPED_ABORTED' });
      }
      throw Object.assign(new Error('Pre-Encode Skripte fehlgeschlagen - Encode wird nicht gestartet.'), { statusCode: 500, preEncodeFailed: true });
    }

    return {
      configured: scriptIds.length + chainIds.length,
      attempted: scriptIds.length - skipped + chainIds.length,
      succeeded,
      failed,
      skipped,
      aborted,
      results
    };
  }

  async runPostEncodeScripts(jobId, encodePlan, context = {}, progressTracker = null) {
    const scriptIds = normalizeScriptIdList(encodePlan?.postEncodeScriptIds || []);
    const chainIds = Array.isArray(encodePlan?.postEncodeChainIds) ? encodePlan.postEncodeChainIds : [];
    const executionStage = String(context?.pipelineStage || 'ENCODING').trim().toUpperCase() || 'ENCODING';
    if (scriptIds.length === 0 && chainIds.length === 0) {
      return {
        configured: 0,
        attempted: 0,
        succeeded: 0,
        failed: 0,
        skipped: 0,
        results: []
      };
    }

    const scripts = await scriptService.resolveScriptsByIds(scriptIds, { strict: false });
    const scriptById = new Map(scripts.map((item) => [Number(item.id), item]));
    const results = [];
    let succeeded = 0;
    let failed = 0;
    let skipped = 0;
    let aborted = false;
    let abortReason = null;
    let failedScriptName = null;
    let failedScriptId = null;
    const titleForPush = context?.jobTitle || `Job #${jobId}`;

    for (let index = 0; index < scriptIds.length; index += 1) {
      const scriptId = scriptIds[index];
      const script = scriptById.get(Number(scriptId));
      const scriptLabel = script?.name || `#${scriptId}`;
      if (progressTracker?.onStepStart) {
        await progressTracker.onStepStart('post', 'script', index + 1, scriptIds.length, scriptLabel);
      }
      if (!script) {
        failed += 1;
        aborted = true;
        failedScriptId = Number(scriptId);
        failedScriptName = `Script #${scriptId}`;
        abortReason = `Post-Encode Skript #${scriptId} wurde nicht gefunden (${index + 1}/${scriptIds.length}).`;
        await historyService.appendLog(jobId, 'SYSTEM', abortReason);
        results.push({
          scriptId,
          scriptName: null,
          status: 'ERROR',
          error: 'missing'
        });
        if (progressTracker?.onStepComplete) {
          await progressTracker.onStepComplete('post', 'script', index + 1, scriptIds.length, scriptLabel, false);
        }
        break;
      }

      await historyService.appendLog(
        jobId,
        'SYSTEM',
        `Post-Encode Skript startet (${index + 1}/${scriptIds.length}): ${script.name}`
      );
      const activityId = runtimeActivityService.startActivity('script', {
        name: script.name,
        source: 'post_encode',
        scriptId: script.id,
        jobId,
        currentStep: `Post-Encode ${index + 1}/${scriptIds.length}`
      });

      let prepared = null;
      try {
        prepared = await scriptService.createExecutableScriptFile(script, {
          source: 'post_encode',
          mode: context?.mode || null,
          jobId,
          jobTitle: context?.jobTitle || null,
          inputPath: context?.inputPath || null,
          outputPath: context?.outputPath || null,
          rawPath: context?.rawPath || null
        });
        const runInfo = await this.runCommand({
          jobId,
          stage: executionStage,
          source: 'POST_ENCODE_SCRIPT',
          cmd: prepared.cmd,
          args: prepared.args,
          argsForLog: prepared.argsForLog
        });

        succeeded += 1;
        results.push({
          scriptId: script.id,
          scriptName: script.name,
          status: 'SUCCESS',
          runInfo
        });
        const runOutput = Array.isArray(runInfo?.highlights) ? runInfo.highlights.join('\n').trim() : '';
        runtimeActivityService.completeActivity(activityId, {
          status: 'success',
          success: true,
          outcome: 'success',
          exitCode: Number.isFinite(Number(runInfo?.exitCode)) ? Number(runInfo.exitCode) : null,
          message: 'Post-Encode Skript erfolgreich',
          output: runOutput || null
        });
        await historyService.appendLog(
          jobId,
          'SYSTEM',
          `Post-Encode Skript erfolgreich: ${script.name}`
        );
        if (progressTracker?.onStepComplete) {
          await progressTracker.onStepComplete('post', 'script', index + 1, scriptIds.length, script.name, true);
        }
      } catch (error) {
        const runInfo = error?.runInfo && typeof error.runInfo === 'object' ? error.runInfo : null;
        const runOutput = Array.isArray(runInfo?.highlights) ? runInfo.highlights.join('\n').trim() : '';
        const runStatus = String(runInfo?.status || '').trim().toUpperCase();
        const cancelled = runStatus === 'CANCELLED';
        runtimeActivityService.completeActivity(activityId, {
          status: 'error',
          success: false,
          outcome: cancelled ? 'cancelled' : 'error',
          cancelled,
          message: error?.message || 'Post-Encode Skriptfehler',
          errorMessage: error?.message || 'Post-Encode Skriptfehler',
          output: runOutput || null
        });
        failed += 1;
        aborted = true;
        failedScriptId = Number(script.id);
        failedScriptName = script.name;
        abortReason = error?.message || 'unknown';
        results.push({
          scriptId: script.id,
          scriptName: script.name,
          status: 'ERROR',
          error: abortReason
        });
        await historyService.appendLog(
          jobId,
          'SYSTEM',
          `Post-Encode Skript fehlgeschlagen: ${script.name} (${abortReason})`
        );
        logger.warn('encode:post-script:failed', {
          jobId,
          scriptId: script.id,
          scriptName: script.name,
          error: errorToMeta(error)
        });
        if (progressTracker?.onStepComplete) {
          await progressTracker.onStepComplete('post', 'script', index + 1, scriptIds.length, script.name, false);
        }
        break;
      } finally {
        if (prepared?.cleanup) {
          await prepared.cleanup();
        }
      }
    }

    if (aborted) {
      const executedScriptIds = new Set(results.map((item) => Number(item?.scriptId)));
      for (const pendingScriptId of scriptIds) {
        const numericId = Number(pendingScriptId);
        if (executedScriptIds.has(numericId)) {
          continue;
        }
        const pendingScript = scriptById.get(numericId);
        skipped += 1;
        results.push({
          scriptId: numericId,
          scriptName: pendingScript?.name || null,
          status: 'SKIPPED_ABORTED'
        });
      }

      await historyService.appendLog(
        jobId,
        'SYSTEM',
        `Post-Encode Skriptkette abgebrochen nach Fehler in ${failedScriptName || `Script #${failedScriptId || 'unknown'}`}.`
      );
      void this.notifyPushover('job_error', {
        title: 'Ripster - Post-Encode Skriptfehler',
        message: `${titleForPush}: ${failedScriptName || `Script #${failedScriptId || 'unknown'}`} fehlgeschlagen (${abortReason || 'unknown'}). Skriptkette abgebrochen.`
      });
    }

    if (!aborted && chainIds.length > 0) {
      const chainResult = await this.runEncodeChains(jobId, chainIds, context, 'post', progressTracker);
      if (chainResult.failed > 0) {
        aborted = true;
        failed += chainResult.failed;
        abortReason = `Post-Encode Kette fehlgeschlagen`;
        void this.notifyPushover('job_error', {
          title: 'Ripster - Post-Encode Kettenfehler',
          message: `${context?.jobTitle || `Job #${jobId}`}: Eine Post-Encode Kette ist fehlgeschlagen.`
        });
      }
      succeeded += chainResult.succeeded;
      results.push(...chainResult.results);
    }

    return {
      configured: scriptIds.length + chainIds.length,
      attempted: scriptIds.length - skipped + chainIds.length,
      succeeded,
      failed,
      skipped,
      aborted,
      abortReason,
      failedScriptId,
      failedScriptName,
      results
    };
  }

  async startEncodingFromPrepared(jobId) {
    this.ensureNotBusy('startEncodingFromPrepared', jobId);
    logger.info('encode:start-from-prepared', { jobId });

    const job = await historyService.getJobById(jobId);
    if (!job) {
      const error = new Error(`Job ${jobId} nicht gefunden.`);
      error.statusCode = 404;
      throw error;
    }

    const encodePlan = this.safeParseJson(job.encode_plan_json);
    const mediaProfile = this.resolveMediaProfileForJob(job, {
      encodePlan,
      rawPath: job.raw_path
    });
    const settings = await settingsService.getEffectiveSettingsMap(mediaProfile);
    const resolvedRawPath = this.resolveCurrentRawPathForSettings(settings, mediaProfile, job.raw_path);
    const activeRawPath = resolvedRawPath || String(job.raw_path || '').trim() || null;
    if (activeRawPath && normalizeComparablePath(activeRawPath) !== normalizeComparablePath(job.raw_path)) {
      await historyService.updateJob(jobId, { raw_path: activeRawPath });
      await historyService.appendLog(
        jobId,
        'SYSTEM',
        `RAW-Pfad für Encode-Start aktualisiert: ${job.raw_path} -> ${activeRawPath}`
      );
    }
    const movieDir = settings.movie_dir;
    ensureDir(movieDir);
    const mode = encodePlan?.mode || this.snapshot.context?.mode || 'rip';
    let inputPath = job.encode_input_path || encodePlan?.encodeInputPath || this.snapshot.context?.inputPath || null;
    let playlistDecision = null;
    const resolveInputFromRaw = (rawPathCandidate) => {
      if (!rawPathCandidate) {
        return null;
      }
      if (hasBluRayBackupStructure(rawPathCandidate)) {
        return rawPathCandidate;
      }
      if (!playlistDecision) {
        playlistDecision = this.resolvePlaylistDecisionForJob(jobId, job);
      }
      return findPreferredRawInput(rawPathCandidate, {
        playlistAnalysis: playlistDecision.playlistAnalysis,
        selectedPlaylistId: playlistDecision.selectedPlaylist
      })?.path || null;
    };

    if (inputPath && !fs.existsSync(inputPath)) {
      const recoveredInputPath = resolveInputFromRaw(activeRawPath);
      if (recoveredInputPath && fs.existsSync(recoveredInputPath)) {
        await historyService.appendLog(
          jobId,
          'SYSTEM',
          `Encode-Input wurde auf aktuellen RAW-Pfad korrigiert: ${inputPath} -> ${recoveredInputPath}`
        );
        inputPath = recoveredInputPath;
      }
    }

    if (!inputPath) {
      inputPath = resolveInputFromRaw(activeRawPath);
    }

    if (!inputPath) {
      const error = new Error('Encode-Start nicht möglich: kein Input-Pfad vorhanden.');
      error.statusCode = 400;
      throw error;
    }

    if (!fs.existsSync(inputPath)) {
      const error = new Error(`Encode-Start nicht möglich: Input-Datei fehlt (${inputPath}).`);
      error.statusCode = 400;
      throw error;
    }

    const incompleteOutputPath = buildIncompleteOutputPathFromJob(settings, job, jobId);
    const preferredFinalOutputPath = buildFinalOutputPathFromJob(settings, job, jobId);
    ensureDir(path.dirname(incompleteOutputPath));

    await this.setState('ENCODING', {
      activeJobId: jobId,
      progress: 0,
      eta: null,
      statusText: mode === 'reencode' ? 'Re-Encoding mit HandBrake' : 'Encoding mit HandBrake',
      context: {
        jobId,
        mode,
        inputPath,
        outputPath: incompleteOutputPath,
        reviewConfirmed: true,
        mediaProfile,
        mediaInfoReview: encodePlan || null,
        selectedMetadata: {
          title: job.title || job.detected_title || null,
          year: job.year || null,
          imdbId: job.imdb_id || null,
          poster: job.poster_url || null
        }
      }
    });

    await historyService.updateJob(jobId, {
      status: 'ENCODING',
      last_state: 'ENCODING',
      output_path: incompleteOutputPath,
      encode_input_path: inputPath,
      ...(activeRawPath ? { raw_path: activeRawPath } : {})
    });

    await historyService.appendLog(
      jobId,
      'SYSTEM',
      `Temporärer Encode-Output: ${incompleteOutputPath} (wird nach erfolgreichem Encode in den finalen Zielordner verschoben).`
    );

    if (mode === 'reencode') {
      void this.notifyPushover('reencode_started', {
        title: 'Ripster - Re-Encode gestartet',
        message: `${job.title || job.detected_title || `Job #${jobId}`} -> ${preferredFinalOutputPath}`
      });
    } else {
      void this.notifyPushover('encoding_started', {
        title: 'Ripster - Encoding gestartet',
        message: `${job.title || job.detected_title || `Job #${jobId}`} -> ${preferredFinalOutputPath}`
      });
    }

    const preEncodeContext = {
      mode,
      jobId,
      jobTitle: job.title || job.detected_title || null,
      inputPath,
      rawPath: activeRawPath,
      mediaProfile
    };
    const preScriptIds = normalizeScriptIdList(encodePlan?.preEncodeScriptIds || []);
    const preChainIds = Array.isArray(encodePlan?.preEncodeChainIds) ? encodePlan.preEncodeChainIds : [];
    const postScriptIds = normalizeScriptIdList(encodePlan?.postEncodeScriptIds || []);
    const postChainIds = Array.isArray(encodePlan?.postEncodeChainIds) ? encodePlan.postEncodeChainIds : [];
    const normalizedPreChainIds = Array.isArray(preChainIds)
      ? preChainIds.map(Number).filter((id) => Number.isFinite(id) && id > 0)
      : [];
    const normalizedPostChainIds = Array.isArray(postChainIds)
      ? postChainIds.map(Number).filter((id) => Number.isFinite(id) && id > 0)
      : [];
    const encodeScriptProgressTracker = createEncodeScriptProgressTracker({
      jobId,
      preSteps: preScriptIds.length + normalizedPreChainIds.length,
      postSteps: postScriptIds.length + normalizedPostChainIds.length,
      updateProgress: this.updateProgress.bind(this)
    });
    let preEncodeScriptsSummary = { configured: 0, attempted: 0, succeeded: 0, failed: 0, skipped: 0, results: [] };
    if (preScriptIds.length > 0 || preChainIds.length > 0) {
      await historyService.appendLog(jobId, 'SYSTEM', 'Pre-Encode Skripte/Ketten werden ausgeführt...');
      try {
        preEncodeScriptsSummary = await this.runPreEncodeScripts(
          jobId,
          encodePlan,
          preEncodeContext,
          encodeScriptProgressTracker
        );
      } catch (preError) {
        if (preError.preEncodeFailed) {
          await this.failJob(jobId, 'ENCODING', preError);
          throw preError;
        }
        throw preError;
      }
      await historyService.appendLog(jobId, 'SYSTEM', 'Pre-Encode Skripte/Ketten abgeschlossen.');
    }

    try {
      const trackSelection = extractHandBrakeTrackSelectionFromPlan(encodePlan, inputPath);
      let handBrakeTitleId = null;
      let directoryInput = false;
      try {
        if (fs.existsSync(inputPath) && fs.statSync(inputPath).isDirectory()) {
          directoryInput = true;
        }
      } catch (_error) {
        directoryInput = false;
        handBrakeTitleId = null;
      }
      if (directoryInput) {
        const reviewMappedTitleId = normalizeReviewTitleId(encodePlan?.handBrakeTitleId);
        if (reviewMappedTitleId) {
          handBrakeTitleId = reviewMappedTitleId;
          await historyService.appendLog(
            jobId,
            'SYSTEM',
            `HandBrake Titel-Mapping aus Vorbereitung übernommen: -t ${handBrakeTitleId}`
          );
        }
        const selectedPlaylistId = normalizePlaylistId(
          encodePlan?.selectedPlaylistId
          || (Array.isArray(encodePlan?.titles)
            ? (encodePlan.titles.find((title) => Boolean(title?.selectedForEncode))?.playlistId || null)
            : null)
          || this.snapshot.context?.selectedPlaylist
          || null
        );
        const selectedEncodeTitle = Array.isArray(encodePlan?.titles)
          ? (
            encodePlan.titles.find((title) =>
              Boolean(title?.selectedForEncode) && normalizePlaylistId(title?.playlistId) === selectedPlaylistId
            )
            || encodePlan.titles.find((title) => Boolean(title?.selectedForEncode))
            || null
          )
          : null;
        const expectedMakemkvTitleIdForResolve = normalizeNonNegativeInteger(
          selectedEncodeTitle?.makemkvTitleId
          ?? encodePlan?.playlistRecommendation?.makemkvTitleId
          ?? this.snapshot.context?.selectedTitleId
          ?? null
        );
        const expectedDurationSecondsForResolve = Number(selectedEncodeTitle?.durationSeconds || 0) || null;
        const expectedSizeBytesForResolve = Number(selectedEncodeTitle?.sizeBytes || 0) || null;
        if (!handBrakeTitleId && selectedPlaylistId) {
          const titleResolveScanLines = [];
          const titleResolveScanConfig = await settingsService.buildHandBrakeScanConfigForInput(inputPath, {
            mediaProfile,
            settingsMap: settings
          });
          logger.info('encoding:title-resolve-scan:command', {
            jobId,
            cmd: titleResolveScanConfig.cmd,
            args: titleResolveScanConfig.args,
            sourceArg: titleResolveScanConfig.sourceArg,
            selectedPlaylistId
          });
          const titleResolveRunInfo = await this.runCommand({
            jobId,
            stage: 'ENCODING',
            source: 'HANDBRAKE_SCAN_TITLE_RESOLVE',
            cmd: titleResolveScanConfig.cmd,
            args: titleResolveScanConfig.args,
            collectLines: titleResolveScanLines,
            collectStderrLines: false
          });
          const titleResolveParsed = parseMediainfoJsonOutput(titleResolveScanLines.join('\n'));
          if (!titleResolveParsed) {
            const error = new Error('HandBrake Scan-Ausgabe für Titel-Mapping konnte nicht als JSON gelesen werden.');
            error.runInfo = titleResolveRunInfo;
            throw error;
          }
          handBrakeTitleId = resolveHandBrakeTitleIdForPlaylist(titleResolveParsed, selectedPlaylistId, {
            expectedMakemkvTitleId: expectedMakemkvTitleIdForResolve,
            expectedDurationSeconds: expectedDurationSecondsForResolve,
            expectedSizeBytes: expectedSizeBytesForResolve
          });
          if (!handBrakeTitleId) {
            const knownPlaylists = listAvailableHandBrakePlaylists(titleResolveParsed);
            const error = new Error(
              `Kein HandBrake-Titel für Playlist ${selectedPlaylistId}.mpls gefunden.`
              + ` ${knownPlaylists.length > 0 ? `Scan-Playlists: ${knownPlaylists.map((id) => `${id}.mpls`).join(', ')}` : 'Scan enthält keine erkennbaren Playlist-IDs.'}`
            );
            error.statusCode = 400;
            throw error;
          }
          await historyService.appendLog(
            jobId,
            'SYSTEM',
            `HandBrake Titel-Mapping: ${selectedPlaylistId}.mpls -> -t ${handBrakeTitleId}`
          );
        } else if (!handBrakeTitleId) {
          handBrakeTitleId = normalizeReviewTitleId(encodePlan?.handBrakeTitleId ?? encodePlan?.encodeInputTitleId);
        }
      }
      const handBrakeConfig = await settingsService.buildHandBrakeConfig(inputPath, incompleteOutputPath, {
        trackSelection,
        titleId: handBrakeTitleId,
        mediaProfile,
        settingsMap: settings,
        userPreset: encodePlan?.userPreset || null
      });
      if (trackSelection) {
        await historyService.appendLog(
          jobId,
          'SYSTEM',
          `HandBrake Track-Override: audio=${trackSelection.audioTrackIds.length > 0 ? trackSelection.audioTrackIds.join(',') : 'none'}, subtitles=${trackSelection.subtitleTrackIds.length > 0 ? trackSelection.subtitleTrackIds.join(',') : 'none'}, subtitle-burned=${trackSelection.subtitleBurnTrackId ?? 'none'}, subtitle-default=${trackSelection.subtitleDefaultTrackId ?? 'none'}, subtitle-forced=${trackSelection.subtitleForcedTrackId ?? (trackSelection.subtitleForcedOnly ? 'forced-only' : 'none')}`
        );
      }
      if (handBrakeTitleId) {
        await historyService.appendLog(
          jobId,
          'SYSTEM',
          `HandBrake Titel-Selektion aktiv: -t ${handBrakeTitleId}`
        );
      }
      logger.info('encoding:command', { jobId, cmd: handBrakeConfig.cmd, args: handBrakeConfig.args });
      const handBrakeProgressParser = encodeScriptProgressTracker.hasScriptSteps
        ? (line) => {
          const parsed = parseHandBrakeProgress(line);
          if (!parsed || parsed.percent === null || parsed.percent === undefined) {
            return parsed;
          }
          return {
            ...parsed,
            percent: encodeScriptProgressTracker.mapHandBrakePercent(parsed.percent)
          };
        }
        : parseHandBrakeProgress;
      const handbrakeInfo = await this.runCommand({
        jobId,
        stage: 'ENCODING',
        source: 'HANDBRAKE',
        cmd: handBrakeConfig.cmd,
        args: handBrakeConfig.args,
        parser: handBrakeProgressParser
      });
      const outputFinalization = finalizeOutputPathForCompletedEncode(
        incompleteOutputPath,
        preferredFinalOutputPath
      );
      const finalizedOutputPath = outputFinalization.outputPath;
      chownRecursive(path.dirname(finalizedOutputPath), settings.movie_dir_owner);
      if (outputFinalization.outputPathWithTimestamp) {
        await historyService.appendLog(
          jobId,
          'SYSTEM',
          `Finaler Output existierte bereits. Neuer Zielpfad mit Timestamp: ${finalizedOutputPath}`
        );
      }
      await historyService.appendLog(
        jobId,
        'SYSTEM',
        `Encode-Output finalisiert: ${finalizedOutputPath}`
      );
      let postEncodeScriptsSummary = {
        configured: 0,
        attempted: 0,
        succeeded: 0,
        failed: 0,
        skipped: 0,
        results: []
      };
      try {
        postEncodeScriptsSummary = await this.runPostEncodeScripts(jobId, encodePlan, {
          mode,
          jobTitle: job.title || job.detected_title || null,
          inputPath,
          outputPath: finalizedOutputPath,
          rawPath: activeRawPath
        }, encodeScriptProgressTracker);
      } catch (error) {
        logger.warn('encode:post-script:summary-failed', {
          jobId,
          error: errorToMeta(error)
        });
        await historyService.appendLog(
          jobId,
          'SYSTEM',
          `Post-Encode Skripte konnten nicht vollständig ausgeführt werden: ${error?.message || 'unknown'}`
        );
      }
      if (postEncodeScriptsSummary.configured > 0) {
        await historyService.appendLog(
          jobId,
          'SYSTEM',
          `Post-Encode Skripte abgeschlossen: ${postEncodeScriptsSummary.succeeded} erfolgreich, ${postEncodeScriptsSummary.failed} fehlgeschlagen, ${postEncodeScriptsSummary.skipped} übersprungen.${postEncodeScriptsSummary.aborted ? ' Kette wurde abgebrochen.' : ''}`
        );
      }
      let finalizedRawPath = activeRawPath || null;
      if (activeRawPath) {
        const currentRawPath = String(activeRawPath || '').trim();
        const completedRawPath = buildCompletedRawPath(currentRawPath);
        if (completedRawPath && completedRawPath !== currentRawPath) {
          if (fs.existsSync(completedRawPath)) {
            logger.warn('encoding:raw-dir-finalize:target-exists', {
              jobId,
              sourceRawPath: currentRawPath,
              targetRawPath: completedRawPath
            });
            await historyService.appendLog(
              jobId,
              'SYSTEM',
              `RAW-Ordner konnte nicht finalisiert werden (Ziel existiert bereits): ${completedRawPath}`
            );
          } else {
            try {
              fs.renameSync(currentRawPath, completedRawPath);
              await historyService.updateRawPathByOldPath(currentRawPath, completedRawPath);
              finalizedRawPath = completedRawPath;
              await historyService.appendLog(
                jobId,
                'SYSTEM',
                `RAW-Ordner nach erfolgreichem Encode finalisiert (Prefix entfernt): ${currentRawPath} -> ${completedRawPath}`
              );
            } catch (rawRenameError) {
              logger.warn('encoding:raw-dir-finalize:rename-failed', {
                jobId,
                sourceRawPath: currentRawPath,
                targetRawPath: completedRawPath,
                error: errorToMeta(rawRenameError)
              });
              await historyService.appendLog(
                jobId,
                'SYSTEM',
                `RAW-Ordner konnte nach Encode nicht finalisiert werden: ${rawRenameError.message}`
              );
            }
          }
        }
      }

      const handbrakeInfoWithPostScripts = {
        ...handbrakeInfo,
        preEncodeScripts: preEncodeScriptsSummary,
        postEncodeScripts: postEncodeScriptsSummary
      };

      await historyService.updateJob(jobId, {
        handbrake_info_json: JSON.stringify(handbrakeInfoWithPostScripts),
        status: 'FINISHED',
        last_state: 'FINISHED',
        end_time: nowIso(),
        raw_path: finalizedRawPath,
        rip_successful: 1,
        output_path: finalizedOutputPath,
        error_message: null
      });

      // Thumbnail aus Cache in persistenten Ordner verschieben
      const promotedUrl = thumbnailService.promoteJobThumbnail(jobId);
      if (promotedUrl) {
        await historyService.updateJob(jobId, { poster_url: promotedUrl }).catch(() => {});
      }

      logger.info('encoding:finished', { jobId, mode, outputPath: finalizedOutputPath });
      const finishedStatusTextBase = mode === 'reencode' ? 'Re-Encode abgeschlossen' : 'Job abgeschlossen';
      const finishedStatusText = postEncodeScriptsSummary.failed > 0
        ? `${finishedStatusTextBase} (${postEncodeScriptsSummary.failed} Skript(e) fehlgeschlagen)`
        : finishedStatusTextBase;

      await this.setState('FINISHED', {
        activeJobId: jobId,
        progress: 100,
        eta: null,
        statusText: finishedStatusText,
        context: {
          jobId,
          mode,
          outputPath: finalizedOutputPath
        }
      });

      if (mode === 'reencode') {
        void this.notifyPushover('reencode_finished', {
          title: 'Ripster - Re-Encode abgeschlossen',
          message: `${job.title || job.detected_title || `Job #${jobId}`} -> ${finalizedOutputPath}`
        });
      } else {
        void this.notifyPushover('job_finished', {
          title: 'Ripster - Job abgeschlossen',
          message: `${job.title || job.detected_title || `Job #${jobId}`} -> ${finalizedOutputPath}`
        });
      }

      setTimeout(async () => {
        if (this.snapshot.state === 'FINISHED' && this.snapshot.activeJobId === jobId) {
          await this.setState('IDLE', {
            finishingJobId: jobId,
            activeJobId: null,
            progress: 0,
            eta: null,
            statusText: 'Bereit',
            context: {}
          });
        }
      }, 3000);
    } catch (error) {
      if (error.runInfo && error.runInfo.source === 'HANDBRAKE') {
        await historyService.updateJob(jobId, {
          handbrake_info_json: JSON.stringify(error.runInfo)
        });
      }
      logger.error('encode:start-from-prepared:failed', { jobId, mode, error: errorToMeta(error) });
      await this.failJob(jobId, 'ENCODING', error);
      error.jobAlreadyFailed = true;
      throw error;
    }
  }

  async startRipEncode(jobId) {
    this.ensureNotBusy('startRipEncode', jobId);
    logger.info('ripEncode:start', { jobId });

    let job = await historyService.getJobById(jobId);
    if (!job) {
      const error = new Error(`Job ${jobId} nicht gefunden.`);
      error.statusCode = 404;
      throw error;
    }
    const preRipPlanBeforeRip = this.safeParseJson(job.encode_plan_json);
    const preRipModeBeforeRip = String(preRipPlanBeforeRip?.mode || '').trim().toLowerCase();
    const hasPreRipConfirmedSelection = (preRipModeBeforeRip === 'pre_rip' || Boolean(preRipPlanBeforeRip?.preRip))
      && Number(job.encode_review_confirmed || 0) === 1;
    const preRipTrackSelectionPayload = hasPreRipConfirmedSelection
      ? extractManualSelectionPayloadFromPlan(preRipPlanBeforeRip)
      : null;
    const preRipPostEncodeScriptIds = hasPreRipConfirmedSelection
      ? normalizeScriptIdList(preRipPlanBeforeRip?.postEncodeScriptIds || [])
      : [];
    const preRipPreEncodeScriptIds = hasPreRipConfirmedSelection
      ? normalizeScriptIdList(preRipPlanBeforeRip?.preEncodeScriptIds || [])
      : [];
    const preRipPostEncodeChainIds = hasPreRipConfirmedSelection
      ? (Array.isArray(preRipPlanBeforeRip?.postEncodeChainIds) ? preRipPlanBeforeRip.postEncodeChainIds : [])
        .map(Number).filter((id) => Number.isFinite(id) && id > 0)
      : [];
    const preRipPreEncodeChainIds = hasPreRipConfirmedSelection
      ? (Array.isArray(preRipPlanBeforeRip?.preEncodeChainIds) ? preRipPlanBeforeRip.preEncodeChainIds : [])
        .map(Number).filter((id) => Number.isFinite(id) && id > 0)
      : [];
    const mkInfo = this.safeParseJson(job.makemkv_info_json);
    const mediaProfile = this.resolveMediaProfileForJob(job, {
      encodePlan: preRipPlanBeforeRip,
      makemkvInfo: mkInfo,
      deviceInfo: this.detectedDisc || this.snapshot.context?.device || null
    });
    const playlistDecision = this.resolvePlaylistDecisionForJob(jobId, job);
    const selectedTitleId = playlistDecision.selectedTitleId;
    const selectedPlaylist = playlistDecision.selectedPlaylist;
    const selectedPlaylistFile = toPlaylistFile(selectedPlaylist);

    const settings = await settingsService.getEffectiveSettingsMap(mediaProfile);
    const rawBaseDir = settings.raw_dir;
    const ripMode = String(settings.makemkv_rip_mode || 'mkv').trim().toLowerCase() === 'backup'
      ? 'backup'
      : 'mkv';
    const effectiveSelectedTitleId = ripMode === 'mkv' ? (selectedTitleId ?? null) : null;
    const effectiveSelectedPlaylist = ripMode === 'mkv' ? (selectedPlaylist || null) : null;
    const effectiveSelectedPlaylistFile = ripMode === 'mkv' ? selectedPlaylistFile : null;
    const selectedPlaylistTitleInfo = ripMode === 'mkv' && Array.isArray(playlistDecision.playlistAnalysis?.titles)
      ? (playlistDecision.playlistAnalysis.titles.find((item) =>
        Number(item?.titleId) === Number(selectedTitleId)
      ) || null)
      : null;
    logger.info('rip:playlist-resolution', {
      jobId,
      ripMode,
      selectedPlaylist: effectiveSelectedPlaylistFile,
      selectedTitleId: effectiveSelectedTitleId,
      selectedTitleDurationSeconds: Number(selectedPlaylistTitleInfo?.durationSeconds || 0),
      selectedTitleDurationLabel: selectedPlaylistTitleInfo?.durationLabel || null
    });
    logger.debug('ripEncode:paths', { jobId, rawBaseDir });

    ensureDir(rawBaseDir);

    const metadataBase = buildRawMetadataBase({
      title: job.title || job.detected_title || null,
      year: job.year || null
    }, jobId);
    const rawDirName = buildRawDirName(metadataBase, jobId, { state: RAW_FOLDER_STATES.INCOMPLETE });
    const rawJobDir = path.join(rawBaseDir, rawDirName);
    ensureDir(rawJobDir);
    chownRecursive(rawJobDir, settings.raw_dir_owner);
    logger.info('rip:raw-dir-created', { jobId, rawJobDir });

    const deviceCandidate = this.detectedDisc || this.snapshot.context?.device || {
      path: job.disc_device,
      index: 0
    };
    const deviceProfile = normalizeMediaProfile(deviceCandidate?.mediaProfile)
      || inferMediaProfileFromDeviceInfo(deviceCandidate)
      || mediaProfile;
    const device = {
      ...deviceCandidate,
      mediaProfile: deviceProfile
    };
    const devicePath = device.path || null;

    await this.setState('RIPPING', {
      activeJobId: jobId,
      progress: 0,
      eta: null,
      statusText: ripMode === 'backup' ? 'Backup mit MakeMKV' : 'Ripping mit MakeMKV',
      context: {
        jobId,
        device,
        mediaProfile,
        ripMode,
        playlistDecisionRequired: Boolean(playlistDecision.playlistDecisionRequired),
        playlistCandidates: playlistDecision.candidatePlaylists,
        selectedPlaylist: effectiveSelectedPlaylist,
        selectedTitleId: effectiveSelectedTitleId,
        preRipSelectionLocked: hasPreRipConfirmedSelection,
        selectedMetadata: {
          title: job.title || job.detected_title || null,
          year: job.year || null,
          imdbId: job.imdb_id || null,
          poster: job.poster_url || null
        }
      }
    });

    void this.notifyPushover('rip_started', {
      title: ripMode === 'backup' ? 'Ripster - Backup gestartet' : 'Ripster - Rip gestartet',
      message: `${job.title || job.detected_title || `Job #${jobId}`} (${device.path || 'disc'})`
    });

    const backupOutputBase = ripMode === 'backup' && mediaProfile === 'dvd'
      ? sanitizeFileName(job.title || job.detected_title || `disc-${jobId}`)
      : null;

    await historyService.updateJob(jobId, {
      status: 'RIPPING',
      last_state: 'RIPPING',
      raw_path: rawJobDir,
      handbrake_info_json: null,
      mediainfo_info_json: null,
      encode_plan_json: null,
      encode_input_path: null,
      encode_review_confirmed: 0,
      output_path: null,
      error_message: null,
      end_time: null
    });
    job = await historyService.getJobById(jobId);

    let makemkvInfo = null;
    try {
      await this.ensureMakeMKVRegistration(jobId, 'RIPPING');

      const ripConfig = await settingsService.buildMakeMKVRipConfig(rawJobDir, device, {
        selectedTitleId: effectiveSelectedTitleId,
        mediaProfile,
        settingsMap: settings,
        backupOutputBase
      });
      logger.info('rip:command', {
        jobId,
        cmd: ripConfig.cmd,
        args: ripConfig.args,
        ripMode,
        selectedPlaylist: effectiveSelectedPlaylistFile,
        selectedTitleId: effectiveSelectedTitleId
      });
      if (ripMode === 'backup') {
        await historyService.appendLog(
          jobId,
          'SYSTEM',
          'Backup-Modus aktiv: MakeMKV erstellt 1:1 Backup ohne Titel-/Playlist-Einschränkungen.'
        );
      } else if (effectiveSelectedPlaylistFile) {
        await historyService.appendLog(
          jobId,
          'SYSTEM',
          `Manuelle Playlist-Auswahl aktiv: ${effectiveSelectedPlaylistFile} (Titel ${effectiveSelectedTitleId}).`
        );
        if (selectedPlaylistTitleInfo) {
          await historyService.appendLog(
            jobId,
            'SYSTEM',
            `Playlist-Auflösung: Titel ${effectiveSelectedTitleId} Dauer ${selectedPlaylistTitleInfo.durationLabel || `${selectedPlaylistTitleInfo.durationSeconds || 0}s`}.`
          );
        }
      } else if (playlistDecision.playlistDecisionRequired) {
        const decisionContext = describePlaylistManualDecision(playlistDecision.playlistAnalysis);
        await historyService.appendLog(
          jobId,
          'SYSTEM',
          `${decisionContext.detailText} Rip läuft ohne Vorauswahl. Finale Titelwahl erfolgt in der Mediainfo-Prüfung per Checkbox.`
        );
      }
      if (devicePath) {
        diskDetectionService.lockDevice(devicePath, {
          jobId,
          stage: 'RIPPING',
          source: 'MAKEMKV_RIP'
        });
      }
      try {
        makemkvInfo = await this.runCommand({
          jobId,
          stage: 'RIPPING',
          source: 'MAKEMKV_RIP',
          cmd: ripConfig.cmd,
          args: ripConfig.args,
          parser: parseMakeMkvProgress
        });
      } finally {
        if (devicePath) {
          diskDetectionService.unlockDevice(devicePath, {
            jobId,
            stage: 'RIPPING',
            source: 'MAKEMKV_RIP'
          });
        }
      }

      // Check for MakeMKV backup failure even when exit code is 0.
      // MakeMKV can emit localized failure text while still exiting with 0.
      const backupFailureLine = ripMode === 'backup'
        ? findMakeMkvBackupFailureMarker(makemkvInfo?.highlights)
        : null;
      if (backupFailureLine) {
        const msgCode = parseMakeMkvMessageCode(backupFailureLine);
        throw Object.assign(
          new Error(`MakeMKV Backup fehlgeschlagen${msgCode !== null ? ` (MSG:${msgCode})` : ''}: ${backupFailureLine}`),
          { runInfo: makemkvInfo }
        );
      }

      const mkInfoBeforeRip = this.safeParseJson(job.makemkv_info_json);
      await historyService.updateJob(jobId, {
        makemkv_info_json: JSON.stringify(this.withAnalyzeContextMediaProfile({
          ...makemkvInfo,
          analyzeContext: mkInfoBeforeRip?.analyzeContext || null
        }, mediaProfile)),
        rip_successful: 1
      });

      // Mark RAW as rip-complete until encode succeeds.
      let activeRawJobDir = rawJobDir;
      const ripCompleteRawJobDir = buildRipCompleteRawPath(rawJobDir);
      if (ripCompleteRawJobDir && ripCompleteRawJobDir !== rawJobDir) {
        if (fs.existsSync(ripCompleteRawJobDir)) {
          logger.warn('rip:raw-complete:rename-skip', { jobId, rawJobDir, ripCompleteRawJobDir });
          await historyService.appendLog(
            jobId,
            'SYSTEM',
            `RAW-Ordner konnte nach Rip nicht als Rip_Complete markiert werden (Zielordner existiert): ${ripCompleteRawJobDir}`
          );
        } else {
          try {
            fs.renameSync(rawJobDir, ripCompleteRawJobDir);
            activeRawJobDir = ripCompleteRawJobDir;
            chownRecursive(activeRawJobDir, settings.raw_dir_owner);
            await historyService.updateRawPathByOldPath(rawJobDir, ripCompleteRawJobDir);
            await historyService.appendLog(
              jobId,
              'SYSTEM',
              `RAW-Ordner nach erfolgreichem Rip als Rip_Complete markiert: ${rawJobDir} → ${ripCompleteRawJobDir}`
            );
          } catch (renameError) {
            logger.warn('rip:raw-complete:rename-failed', {
              jobId,
              rawJobDir,
              ripCompleteRawJobDir,
              error: errorToMeta(renameError)
            });
            await historyService.appendLog(
              jobId,
              'SYSTEM',
              `RAW-Ordner konnte nach Rip nicht als Rip_Complete markiert werden: ${renameError.message}`
            );
          }
        }
      }

      const review = await this.runReviewForRawJob(jobId, activeRawJobDir, {
        mode: 'rip',
        mediaProfile
      });
      logger.info('rip:review-ready', {
        jobId,
        encodeInputPath: review.encodeInputPath,
        selectedTitleCount: Array.isArray(review.selectedTitleIds)
          ? review.selectedTitleIds.length
          : (Array.isArray(review.titles)
            ? review.titles.filter((item) => Boolean(item?.selectedForEncode)).length
            : 0)
      });
      if (hasPreRipConfirmedSelection && !review?.awaitingPlaylistSelection) {
        await historyService.appendLog(
          jobId,
          'SYSTEM',
          'Vorab bestätigte Spurauswahl erkannt. Übernehme Auswahl automatisch und starte Encode.'
        );
        await this.confirmEncodeReview(jobId, {
          selectedEncodeTitleId: review?.encodeInputTitleId || null,
          selectedTrackSelection: preRipTrackSelectionPayload || null,
          selectedPostEncodeScriptIds: preRipPostEncodeScriptIds,
          selectedPreEncodeScriptIds: preRipPreEncodeScriptIds,
          selectedPostEncodeChainIds: preRipPostEncodeChainIds,
          selectedPreEncodeChainIds: preRipPreEncodeChainIds
        });
        const autoStartResult = await this.startPreparedJob(jobId);
        logger.info('rip:auto-encode-started', {
          jobId,
          stage: autoStartResult?.stage || null
        });
      }
    } catch (error) {
      if (error.runInfo && error.runInfo.source === 'MAKEMKV_RIP') {
        const mkInfoBeforeRip = this.safeParseJson(job.makemkv_info_json);
        await historyService.updateJob(jobId, {
          makemkv_info_json: JSON.stringify(this.withAnalyzeContextMediaProfile({
            ...error.runInfo,
            analyzeContext: mkInfoBeforeRip?.analyzeContext || null
          }, mediaProfile))
        });
      }
      if (
        error.runInfo
        && [
          'MEDIAINFO',
          'HANDBRAKE_SCAN',
          'HANDBRAKE_SCAN_PLAYLIST_MAP',
          'HANDBRAKE_SCAN_SELECTED_TITLE',
          'MAKEMKV_ANALYZE_BACKUP'
        ].includes(error.runInfo.source)
      ) {
        await historyService.updateJob(jobId, {
          mediainfo_info_json: JSON.stringify({
            failedAt: nowIso(),
            runInfo: error.runInfo
          })
        });
      }
      logger.error('ripEncode:failed', { jobId, stage: this.snapshot.state, error: errorToMeta(error) });
      await this.failJob(jobId, this.snapshot.state, error);
      throw error;
    }
  }

  async retry(jobId, options = {}) {
    const immediate = Boolean(options?.immediate);
    if (!immediate) {
      // Retry always starts a rip → bypass the encode queue entirely.
      return this.retry(jobId, { ...options, immediate: true });
    }

    this.ensureNotBusy('retry', jobId);
    logger.info('retry:start', { jobId });
    this.cancelRequestedByJob.delete(Number(jobId));

    let sourceJob = await historyService.getJobById(jobId);
    if (!sourceJob) {
      const error = new Error(`Job ${jobId} nicht gefunden.`);
      error.statusCode = 404;
      throw error;
    }

    if (!sourceJob.title && !sourceJob.detected_title) {
      const error = new Error('Retry nicht möglich: keine Metadaten vorhanden.');
      error.statusCode = 400;
      throw error;
    }

    const sourceStatus = String(sourceJob.status || '').trim().toUpperCase();
    const sourceLastState = String(sourceJob.last_state || '').trim().toUpperCase();
    const retryable = ['ERROR', 'CANCELLED'].includes(sourceStatus)
      || ['ERROR', 'CANCELLED'].includes(sourceLastState);
    if (!retryable) {
      const error = new Error(
        `Retry nicht möglich: Job ${jobId} ist nicht im Status ERROR/CANCELLED (aktuell ${sourceStatus || sourceLastState || '-'}).`
      );
      error.statusCode = 409;
      throw error;
    }

    const sourceMakemkvInfo = this.safeParseJson(sourceJob.makemkv_info_json);
    const sourceEncodePlan = this.safeParseJson(sourceJob.encode_plan_json);
    const mediaProfile = this.resolveMediaProfileForJob(sourceJob, {
      makemkvInfo: sourceMakemkvInfo,
      encodePlan: sourceEncodePlan
    });
    const isCdRetry = mediaProfile === 'cd';

    let cdRetryConfig = null;
    if (isCdRetry) {
      const normalizeTrackPosition = (value) => {
        const parsed = Number(value);
        if (!Number.isFinite(parsed) || parsed <= 0) {
          return null;
        }
        return Math.trunc(parsed);
      };
      const sourceTracks = Array.isArray(sourceMakemkvInfo?.tracks)
        ? sourceMakemkvInfo.tracks
        : (Array.isArray(sourceEncodePlan?.tracks) ? sourceEncodePlan.tracks : []);
      if (sourceTracks.length === 0) {
        const error = new Error('Retry nicht möglich: keine CD-Trackdaten im Quelljob vorhanden.');
        error.statusCode = 400;
        throw error;
      }
      const selectedTracks = normalizeCdTrackPositionList(
        Array.isArray(sourceEncodePlan?.selectedTracks)
          ? sourceEncodePlan.selectedTracks
          : sourceTracks.filter((track) => track?.selected !== false).map((track) => normalizeTrackPosition(track?.position))
      );
      const selectedMetadata = sourceMakemkvInfo?.selectedMetadata && typeof sourceMakemkvInfo.selectedMetadata === 'object'
        ? sourceMakemkvInfo.selectedMetadata
        : {};
      cdRetryConfig = {
        format: String(sourceEncodePlan?.format || 'flac').trim().toLowerCase() || 'flac',
        formatOptions: sourceEncodePlan?.formatOptions && typeof sourceEncodePlan.formatOptions === 'object'
          ? sourceEncodePlan.formatOptions
          : {},
        selectedTracks: selectedTracks.length > 0
          ? selectedTracks
          : sourceTracks
            .map((track) => normalizeTrackPosition(track?.position))
            .filter((value) => Number.isFinite(value) && value > 0),
        tracks: sourceTracks,
        metadata: {
          title: selectedMetadata?.title || sourceJob.title || sourceJob.detected_title || 'Audio CD',
          artist: selectedMetadata?.artist || null,
          year: selectedMetadata?.year ?? sourceJob.year ?? null,
          mbId: selectedMetadata?.mbId
            || selectedMetadata?.musicBrainzId
            || selectedMetadata?.musicbrainzId
            || selectedMetadata?.mbid
            || null,
          coverUrl: selectedMetadata?.coverUrl
            || selectedMetadata?.poster
            || selectedMetadata?.posterUrl
            || sourceJob.poster_url
            || null
        },
        selectedPreEncodeScriptIds: normalizeScriptIdList(sourceEncodePlan?.preEncodeScriptIds || []),
        selectedPostEncodeScriptIds: normalizeScriptIdList(sourceEncodePlan?.postEncodeScriptIds || []),
        selectedPreEncodeChainIds: normalizeChainIdList(sourceEncodePlan?.preEncodeChainIds || []),
        selectedPostEncodeChainIds: normalizeChainIdList(sourceEncodePlan?.postEncodeChainIds || [])
      };
    } else {
      const retrySettings = await settingsService.getEffectiveSettingsMap(mediaProfile);
      const { rawBaseDir: retryRawBaseDir, rawExtraDirs: retryRawExtraDirs } = this.buildRawPathLookupConfig(
        retrySettings,
        mediaProfile
      );
      const resolvedOldRawPath = this.resolveCurrentRawPathForSettings(
        retrySettings,
        mediaProfile,
        sourceJob.raw_path
      );

      if (resolvedOldRawPath) {
        const oldRawFolderName = path.basename(resolvedOldRawPath);
        const oldRawLooksLikeJobFolder = /\s-\sRAW\s-\sjob-\d+\s*$/i.test(stripRawStatePrefix(oldRawFolderName));
        if (!oldRawLooksLikeJobFolder) {
          const error = new Error(`Retry nicht möglich: alter RAW-Pfad ist kein Job-RAW-Ordner (${resolvedOldRawPath}).`);
          error.statusCode = 400;
          throw error;
        }

        const rawDeletionRoots = Array.from(new Set(
          [
            retryRawBaseDir,
            ...retryRawExtraDirs,
            path.dirname(String(sourceJob.raw_path || '').trim())
          ]
            .map((dirPath) => normalizeComparablePath(dirPath))
            .filter(Boolean)
        ));
        const oldRawPathAllowed = rawDeletionRoots.some((rootPath) => isPathInsideDirectory(rootPath, resolvedOldRawPath));
        if (!oldRawPathAllowed) {
          const error = new Error(
            `Retry nicht möglich: alter RAW-Pfad liegt außerhalb der erlaubten RAW-Verzeichnisse (${resolvedOldRawPath}).`
          );
          error.statusCode = 400;
          throw error;
        }

        try {
          fs.rmSync(resolvedOldRawPath, { recursive: true, force: true });
        } catch (deleteError) {
          const error = new Error(`Retry nicht möglich: alter RAW-Ordner konnte nicht gelöscht werden (${deleteError.message}).`);
          error.statusCode = 500;
          throw error;
        }
        await historyService.appendLog(
          jobId,
          'USER_ACTION',
          `Retry: alter RAW-Ordner wurde entfernt: ${resolvedOldRawPath}`
        );
        sourceJob = await historyService.updateJob(jobId, {
          raw_path: null,
          rip_successful: 0
        });
      } else if (sourceJob.raw_path) {
        await historyService.appendLog(
          jobId,
          'SYSTEM',
          `Retry: alter RAW-Pfad ist nicht mehr vorhanden und wird aus dem Job entfernt (${sourceJob.raw_path}).`
        );
        sourceJob = await historyService.updateJob(jobId, {
          raw_path: null,
          rip_successful: 0
        });
      }
    }

    const retryJob = await historyService.createJob({
      discDevice: sourceJob.disc_device || null,
      status: isCdRetry ? 'CD_READY_TO_RIP' : 'RIPPING',
      detectedTitle: sourceJob.detected_title || sourceJob.title || null
    });
    const retryJobId = Number(retryJob?.id || 0);
    if (!Number.isFinite(retryJobId) || retryJobId <= 0) {
      throw new Error('Retry fehlgeschlagen: neuer Job konnte nicht erstellt werden.');
    }

    const retryUpdatePayload = {
      parent_job_id: Number(jobId),
      title: sourceJob.title || null,
      year: sourceJob.year ?? null,
      imdb_id: sourceJob.imdb_id || null,
      poster_url: sourceJob.poster_url || null,
      omdb_json: sourceJob.omdb_json || null,
      selected_from_omdb: Number(sourceJob.selected_from_omdb || 0),
      makemkv_info_json: sourceJob.makemkv_info_json || null,
      rip_successful: 0,
      error_message: null,
      end_time: null,
      handbrake_info_json: null,
      mediainfo_info_json: null,
      encode_plan_json: isCdRetry
        ? (sourceJob.encode_plan_json || null)
        : null,
      encode_input_path: null,
      encode_review_confirmed: 0,
      output_path: null,
      status: isCdRetry ? 'CD_READY_TO_RIP' : 'RIPPING',
      last_state: isCdRetry ? 'CD_READY_TO_RIP' : 'RIPPING'
    };
    await historyService.updateJob(retryJobId, retryUpdatePayload);

    // Thumbnail für neuen Job kopieren, damit er nicht auf die Datei des alten Jobs angewiesen ist
    if (thumbnailService.isLocalUrl(sourceJob.poster_url)) {
      const copiedUrl = thumbnailService.copyThumbnail(Number(jobId), retryJobId);
      if (copiedUrl) {
        await historyService.updateJob(retryJobId, { poster_url: copiedUrl }).catch(() => {});
      }
    }

    await historyService.appendLog(
      retryJobId,
      'USER_ACTION',
      `Retry aus Job #${jobId} gestartet (${isCdRetry ? 'CD' : 'Disc'}).`
    );
    await historyService.retireJobInFavorOf(jobId, retryJobId, {
      reason: isCdRetry ? 'cd_retry' : 'retry'
    });
    this.cancelRequestedByJob.delete(retryJobId);

    if (isCdRetry) {
      this.startCdRip(retryJobId, cdRetryConfig || {}).catch((error) => {
        logger.error('retry:cd:background-failed', {
          jobId: retryJobId,
          sourceJobId: jobId,
          error: errorToMeta(error)
        });
      });
    } else {
      this.startRipEncode(retryJobId).catch((error) => {
        logger.error('retry:background-failed', { jobId: retryJobId, sourceJobId: jobId, error: errorToMeta(error) });
      });
    }

    return {
      started: true,
      sourceJobId: Number(jobId),
      jobId: retryJobId,
      replacedSourceJob: true
    };
  }

  async resumeReadyToEncodeJob(jobId) {
    this.ensureNotBusy('resumeReadyToEncodeJob', jobId);
    logger.info('resumeReadyToEncodeJob:requested', { jobId });

    const job = await historyService.getJobById(jobId);
    if (!job) {
      const error = new Error(`Job ${jobId} nicht gefunden.`);
      error.statusCode = 404;
      throw error;
    }

    const isReadyToEncode = job.status === 'READY_TO_ENCODE' || job.last_state === 'READY_TO_ENCODE';
    if (!isReadyToEncode) {
      const error = new Error(`Job ${jobId} ist nicht im Status READY_TO_ENCODE.`);
      error.statusCode = 409;
      throw error;
    }

    const encodePlan = this.safeParseJson(job.encode_plan_json);
    if (!encodePlan || !Array.isArray(encodePlan.titles)) {
      const error = new Error('READY_TO_ENCODE Job kann nicht geladen werden: encode_plan fehlt.');
      error.statusCode = 400;
      throw error;
    }

    const mode = String(encodePlan?.mode || 'rip').trim().toLowerCase();
    const isPreRipMode = mode === 'pre_rip' || Boolean(encodePlan?.preRip);
    const reviewConfirmed = Boolean(Number(job.encode_review_confirmed || 0) || encodePlan?.reviewConfirmed);
    const readyMediaProfile = this.resolveMediaProfileForJob(job, { encodePlan });
    const resumeSettings = await settingsService.getEffectiveSettingsMap(readyMediaProfile);
    const resolvedResumeRawPath = this.resolveCurrentRawPathForSettings(
      resumeSettings,
      readyMediaProfile,
      job.raw_path
    );
    const activeResumeRawPath = resolvedResumeRawPath || String(job.raw_path || '').trim() || null;

    let inputPath = isPreRipMode
      ? null
      : (job.encode_input_path || encodePlan?.encodeInputPath || null);
    if (!isPreRipMode && activeResumeRawPath) {
      const needsInputRefresh = !inputPath
        || !fs.existsSync(inputPath)
        || !isPathInsideDirectory(activeResumeRawPath, inputPath);
      if (needsInputRefresh) {
        const selectedPlaylistId = normalizePlaylistId(
          encodePlan?.selectedPlaylistId
          || encodePlan?.selectedPlaylist
          || null
        );
        if (hasBluRayBackupStructure(activeResumeRawPath)) {
          inputPath = activeResumeRawPath;
        } else {
          const playlistDecision = this.resolvePlaylistDecisionForJob(jobId, job, selectedPlaylistId);
          inputPath = findPreferredRawInput(activeResumeRawPath, {
            playlistAnalysis: playlistDecision.playlistAnalysis,
            selectedPlaylistId: selectedPlaylistId || playlistDecision.selectedPlaylist
          })?.path || null;
        }
      }
    }
    const hasEncodableTitle = isPreRipMode
      ? Boolean(encodePlan?.encodeInputTitleId)
      : Boolean(inputPath);
    const selectedMetadata = {
      title: job.title || job.detected_title || null,
      year: job.year || null,
      imdbId: job.imdb_id || null,
      poster: job.poster_url || null
    };
    await this.setState('READY_TO_ENCODE', {
      activeJobId: jobId,
      progress: 0,
      eta: null,
      statusText: hasEncodableTitle
        ? (reviewConfirmed
          ? (isPreRipMode
            ? 'Spurauswahl geladen - Backup/Rip + Encode startbereit'
            : 'Mediainfo geladen - Encode startbereit')
          : (isPreRipMode
            ? 'Spurauswahl geladen - bitte bestätigen'
            : 'Mediainfo geladen - bitte bestätigen'))
        : (isPreRipMode
          ? 'Spurauswahl geladen - kein passender Titel gewählt'
          : 'Mediainfo geladen - kein Titel erfüllt MIN_LENGTH_MINUTES'),
      context: {
        ...(this.snapshot.context || {}),
        jobId,
        inputPath,
        hasEncodableTitle,
        reviewConfirmed,
        mode,
        mediaProfile: readyMediaProfile,
        sourceJobId: encodePlan?.sourceJobId || null,
        selectedMetadata,
        mediaInfoReview: encodePlan
      }
    });

    await historyService.appendLog(
      jobId,
      'USER_ACTION',
      'READY_TO_ENCODE Job nach Neustart ins Dashboard geladen.'
    );

    if (
      (activeResumeRawPath && normalizeComparablePath(activeResumeRawPath) !== normalizeComparablePath(job.raw_path))
      || (!isPreRipMode && inputPath && normalizeComparablePath(inputPath) !== normalizeComparablePath(job.encode_input_path))
    ) {
      const resumeUpdatePayload = {};
      if (activeResumeRawPath && normalizeComparablePath(activeResumeRawPath) !== normalizeComparablePath(job.raw_path)) {
        resumeUpdatePayload.raw_path = activeResumeRawPath;
      }
      if (!isPreRipMode) {
        resumeUpdatePayload.encode_input_path = inputPath;
      }
      await historyService.updateJob(jobId, resumeUpdatePayload);
    }

    return historyService.getJobById(jobId);
  }

  async restartEncodeWithLastSettings(jobId, options = {}) {
    const immediate = Boolean(options?.immediate);
    if (!immediate) {
      // Restart-Encode now prepares an editable READY_TO_ENCODE state first.
      // No queue slot is needed because encoding is not started automatically here.
      return this.restartEncodeWithLastSettings(jobId, { ...options, immediate: true });
    }

    this.ensureNotBusy('restartEncodeWithLastSettings', jobId);
    logger.info('restartEncodeWithLastSettings:requested', { jobId });
    this.cancelRequestedByJob.delete(Number(jobId));
    const triggerReason = String(options?.triggerReason || 'manual').trim().toLowerCase();

    const job = await historyService.getJobById(jobId);
    if (!job) {
      const error = new Error(`Job ${jobId} nicht gefunden.`);
      error.statusCode = 404;
      throw error;
    }

    const currentStatus = String(job.status || '').trim().toUpperCase();
    if (['ANALYZING', 'RIPPING', 'MEDIAINFO_CHECK'].includes(currentStatus)) {
      const error = new Error(`Encode-Neustart nicht möglich: Job ${jobId} ist noch aktiv (${currentStatus}).`);
      error.statusCode = 409;
      throw error;
    }

    const encodePlan = this.safeParseJson(job.encode_plan_json);
    if (!encodePlan || !Array.isArray(encodePlan.titles) || encodePlan.titles.length === 0) {
      const error = new Error('Encode-Neustart nicht möglich: encode_plan fehlt.');
      error.statusCode = 400;
      throw error;
    }

    const mode = String(encodePlan?.mode || 'rip').trim().toLowerCase();
    const isPreRipMode = mode === 'pre_rip' || Boolean(encodePlan?.preRip);
    const reviewConfirmed = Boolean(Number(job.encode_review_confirmed || 0) || encodePlan?.reviewConfirmed);
    if (!reviewConfirmed) {
      const error = new Error('Encode-Neustart nicht möglich: Spurauswahl wurde noch nicht bestätigt.');
      error.statusCode = 409;
      throw error;
    }

    const hasEncodableInput = isPreRipMode
      ? Boolean(encodePlan?.encodeInputTitleId)
      : Boolean(job.encode_input_path || encodePlan?.encodeInputPath || job.raw_path);
    if (!hasEncodableInput) {
      const error = new Error('Encode-Neustart nicht möglich: kein verwertbarer Encode-Input vorhanden.');
      error.statusCode = 400;
      throw error;
    }

    const settings = await settingsService.getSettingsMap();
    const restartDeleteIncompleteOutput = settings?.handbrake_restart_delete_incomplete_output !== undefined
      ? Boolean(settings.handbrake_restart_delete_incomplete_output)
      : true;
    const handBrakeInfo = this.safeParseJson(job.handbrake_info_json);
    const encodePreviouslySuccessful = String(handBrakeInfo?.status || '').trim().toUpperCase() === 'SUCCESS';
    const previousOutputPath = String(job.output_path || '').trim() || null;

    if (previousOutputPath && restartDeleteIncompleteOutput && !encodePreviouslySuccessful) {
      try {
        const deleteResult = await historyService.deleteJobFiles(jobId, 'movie');
        await historyService.appendLog(
          jobId,
          'USER_ACTION',
          `Encode-Neustart: unvollständigen Output vor Start entfernt (movie files=${deleteResult?.summary?.movie?.filesDeleted ?? 0}, dirs=${deleteResult?.summary?.movie?.dirsRemoved ?? 0}).`
        );
      } catch (error) {
        logger.warn('restartEncodeWithLastSettings:delete-incomplete-output-failed', {
          jobId,
          outputPath: previousOutputPath,
          error: errorToMeta(error)
        });
      }
    }

    const restartPlan = {
      ...encodePlan,
      reviewConfirmed: false,
      reviewConfirmedAt: null,
      prefilledFromPreviousRun: true,
      prefilledFromPreviousRunAt: nowIso()
    };
    const selectedMetadata = {
      title: job.title || job.detected_title || null,
      year: job.year || null,
      imdbId: job.imdb_id || null,
      poster: job.poster_url || null
    };
    const readyMediaProfile = this.resolveMediaProfileForJob(job, {
      encodePlan: restartPlan
    });
    const restartSettings = await settingsService.getEffectiveSettingsMap(readyMediaProfile);
    const resolvedRestartRawPath = this.resolveCurrentRawPathForSettings(
      restartSettings,
      readyMediaProfile,
      job.raw_path
    );
    const activeRestartRawPath = resolvedRestartRawPath || String(job.raw_path || '').trim() || null;

    let inputPath = isPreRipMode
      ? null
      : (job.encode_input_path || restartPlan.encodeInputPath || null);
    if (!isPreRipMode && activeRestartRawPath) {
      const needsInputRefresh = !inputPath
        || !fs.existsSync(inputPath)
        || !isPathInsideDirectory(activeRestartRawPath, inputPath);
      if (needsInputRefresh) {
        const selectedPlaylistId = normalizePlaylistId(
          restartPlan?.selectedPlaylistId
          || restartPlan?.selectedPlaylist
          || null
        );
        if (hasBluRayBackupStructure(activeRestartRawPath)) {
          inputPath = activeRestartRawPath;
        } else {
          const playlistDecision = this.resolvePlaylistDecisionForJob(jobId, job, selectedPlaylistId);
          inputPath = findPreferredRawInput(activeRestartRawPath, {
            playlistAnalysis: playlistDecision.playlistAnalysis,
            selectedPlaylistId: selectedPlaylistId || playlistDecision.selectedPlaylist
          })?.path || null;
        }
      }
    }
    restartPlan.encodeInputPath = inputPath;
    const hasEncodableTitle = isPreRipMode
      ? Boolean(restartPlan?.encodeInputTitleId)
      : Boolean(inputPath);

    const replacementJob = await historyService.createJob({
      discDevice: job.disc_device || null,
      status: 'READY_TO_ENCODE',
      detectedTitle: job.detected_title || job.title || null
    });
    const replacementJobId = Number(replacementJob?.id || 0);
    if (!Number.isFinite(replacementJobId) || replacementJobId <= 0) {
      throw new Error('Encode-Neustart fehlgeschlagen: neuer Job konnte nicht erstellt werden.');
    }

    await historyService.updateJob(replacementJobId, {
      parent_job_id: Number(jobId),
      title: job.title || null,
      year: job.year ?? null,
      imdb_id: job.imdb_id || null,
      poster_url: job.poster_url || null,
      omdb_json: job.omdb_json || null,
      selected_from_omdb: Number(job.selected_from_omdb || 0),
      status: 'READY_TO_ENCODE',
      last_state: 'READY_TO_ENCODE',
      error_message: null,
      end_time: null,
      output_path: null,
      disc_device: job.disc_device || null,
      raw_path: activeRestartRawPath || null,
      rip_successful: Number(job.rip_successful || 0),
      makemkv_info_json: job.makemkv_info_json || null,
      handbrake_info_json: null,
      mediainfo_info_json: job.mediainfo_info_json || null,
      encode_plan_json: JSON.stringify(restartPlan),
      encode_input_path: inputPath,
      encode_review_confirmed: 0
    });
    const loadedSelectionText = (
      previousOutputPath
        ? `Letzte bestätigte Auswahl wurde geladen und kann angepasst werden. Vorheriger Output-Pfad: ${previousOutputPath}. autoDeleteIncomplete=${restartDeleteIncompleteOutput ? 'on' : 'off'}`
        : 'Letzte bestätigte Auswahl wurde geladen und kann angepasst werden.'
    );
    let restartLogMessage;
    if (triggerReason === 'cancelled_encode') {
      restartLogMessage = `Encode wurde abgebrochen. ${loadedSelectionText}`;
    } else if (triggerReason === 'failed_encode') {
      restartLogMessage = `Encode ist fehlgeschlagen. ${loadedSelectionText}`;
    } else if (triggerReason === 'server_restart') {
      restartLogMessage = `Server-Neustart während Encode erkannt. ${loadedSelectionText}`;
    } else if (triggerReason === 'confirm_auto_prepare') {
      restartLogMessage = `Status war nicht READY_TO_ENCODE. ${loadedSelectionText}`;
    } else {
      restartLogMessage = `Encode-Neustart angefordert. ${loadedSelectionText}`;
    }
    await historyService.appendLog(replacementJobId, 'USER_ACTION', restartLogMessage);
    await historyService.retireJobInFavorOf(jobId, replacementJobId, {
      reason: 'restart_encode'
    });

    await this.setState('READY_TO_ENCODE', {
      activeJobId: replacementJobId,
      progress: 0,
      eta: null,
      statusText: hasEncodableTitle
        ? (isPreRipMode
          ? 'Vorherige Spurauswahl geladen - anpassen und Backup/Rip + Encode starten'
          : 'Vorherige Encode-Auswahl geladen - anpassen und Encoding starten')
        : (isPreRipMode
        ? 'Vorherige Spurauswahl geladen - kein passender Titel gewählt'
          : 'Vorherige Encode-Auswahl geladen - kein Titel erfüllt MIN_LENGTH_MINUTES'),
      context: {
        ...(this.snapshot.context || {}),
        jobId: replacementJobId,
        inputPath,
        hasEncodableTitle,
        reviewConfirmed: false,
        mode,
        mediaProfile: readyMediaProfile,
        sourceJobId: Number(jobId),
        selectedMetadata,
        mediaInfoReview: restartPlan
      }
    });

    return {
      restarted: true,
      started: false,
      stage: 'READY_TO_ENCODE',
      reviewConfirmed: false,
      sourceJobId: Number(jobId),
      jobId: replacementJobId,
      replacedSourceJob: true
    };
  }

  async restartReviewFromRaw(jobId, options = {}) {
    this.ensureNotBusy('restartReviewFromRaw', jobId);
    logger.info('restartReviewFromRaw:requested', { jobId, options });
    this.cancelRequestedByJob.delete(Number(jobId));

    const sourceJob = await historyService.getJobById(jobId);
    if (!sourceJob) {
      const error = new Error(`Job ${jobId} nicht gefunden.`);
      error.statusCode = 404;
      throw error;
    }

    if (!sourceJob.raw_path) {
      const error = new Error('Review-Neustart nicht möglich: raw_path fehlt.');
      error.statusCode = 400;
      throw error;
    }

    const reviewMakemkvInfo = this.safeParseJson(sourceJob.makemkv_info_json);
    const reviewEncodePlan = this.safeParseJson(sourceJob.encode_plan_json);
    const reviewMediaProfile = this.resolveMediaProfileForJob(sourceJob, {
      makemkvInfo: reviewMakemkvInfo,
      encodePlan: reviewEncodePlan,
      rawPath: sourceJob.raw_path
    });
    const reviewSettings = await settingsService.getSettingsMap();
    const resolvedReviewRawPath = this.resolveCurrentRawPathForSettings(
      reviewSettings,
      reviewMediaProfile,
      sourceJob.raw_path
    );
    if (!resolvedReviewRawPath) {
      const error = new Error(`Review-Neustart nicht möglich: RAW-Pfad existiert nicht (${sourceJob.raw_path}).`);
      error.statusCode = 400;
      throw error;
    }

    const resolvedReviewInput = hasBluRayBackupStructure(resolvedReviewRawPath)
      ? { path: resolvedReviewRawPath }
      : findPreferredRawInput(resolvedReviewRawPath);
    const hasRawInput = Boolean(resolvedReviewInput?.path);
    if (!hasRawInput) {
      let hasAnyRawEntries = false;
      try {
        hasAnyRawEntries = fs.readdirSync(resolvedReviewRawPath).length > 0;
      } catch (_error) {
        hasAnyRawEntries = false;
      }
      if (!hasAnyRawEntries) {
        const error = new Error('Review-Neustart nicht möglich: keine Mediendateien im RAW-Pfad gefunden. Disc muss zuerst gerippt werden.');
        error.statusCode = 400;
        throw error;
      }
      await historyService.appendLog(
        jobId,
        'SYSTEM',
        `Review-Neustart: keine direkten Mediendateien erkannt, versuche Analyse trotzdem mit RAW-Pfad ${resolvedReviewRawPath}.`
      );
    }

    const existingEncodeInputPath = String(sourceJob.encode_input_path || '').trim() || null;
    const shouldRealignEncodeInput = Boolean(
      resolvedReviewInput?.path
      && (
        !existingEncodeInputPath
        || !fs.existsSync(existingEncodeInputPath)
        || isEncodeInputMismatchedWithRaw(resolvedReviewRawPath, existingEncodeInputPath)
      )
    );
    const normalizedReviewInputPath = shouldRealignEncodeInput
      ? resolvedReviewInput.path
      : existingEncodeInputPath;

    const currentStatus = String(sourceJob.status || '').trim().toUpperCase();
    if (['ANALYZING', 'RIPPING', 'MEDIAINFO_CHECK', 'ENCODING'].includes(currentStatus)) {
      const error = new Error(`Review-Neustart nicht möglich: Job ${jobId} ist noch aktiv (${currentStatus}).`);
      error.statusCode = 409;
      throw error;
    }

    const staleQueueIndex = this.findQueueEntryIndexByJobId(Number(jobId));
    let removedQueueActionLabel = null;
    if (staleQueueIndex >= 0) {
      const [removed] = this.queueEntries.splice(staleQueueIndex, 1);
      removedQueueActionLabel = QUEUE_ACTION_LABELS[removed?.action] || removed?.action || 'Aktion';
      await this.emitQueueChanged();
    }

    const forcePlaylistReselection = Boolean(options?.forcePlaylistReselection);
    const previousEncodePlan = this.safeParseJson(sourceJob.encode_plan_json);
    const mkInfo = this.safeParseJson(sourceJob.makemkv_info_json);
    const nextMakemkvInfoJson = mkInfo && typeof mkInfo === 'object'
      ? JSON.stringify({
        ...mkInfo,
        analyzeContext: {
          ...(mkInfo?.analyzeContext || {}),
          playlistAnalysis: null,
          playlistDecisionRequired: false,
          selectedPlaylist: null,
          selectedTitleId: null,
          handBrakePlaylistScan: null
        },
        postBackupAnalyze: null
      })
      : sourceJob.makemkv_info_json;

    const jobUpdatePayload = {
      status: 'MEDIAINFO_CHECK',
      last_state: 'MEDIAINFO_CHECK',
      start_time: nowIso(),
      end_time: null,
      error_message: null,
      output_path: null,
      handbrake_info_json: null,
      mediainfo_info_json: null,
      encode_plan_json: null,
      encode_input_path: normalizedReviewInputPath || null,
      encode_review_confirmed: 0,
      makemkv_info_json: nextMakemkvInfoJson,
      raw_path: resolvedReviewRawPath
    };

    const replacementJob = await historyService.createJob({
      discDevice: sourceJob.disc_device || null,
      status: 'MEDIAINFO_CHECK',
      detectedTitle: sourceJob.detected_title || sourceJob.title || null
    });
    const replacementJobId = Number(replacementJob?.id || 0);
    if (!Number.isFinite(replacementJobId) || replacementJobId <= 0) {
      throw new Error('Review-Neustart fehlgeschlagen: neuer Job konnte nicht erstellt werden.');
    }

    await historyService.updateJob(replacementJobId, {
      parent_job_id: Number(jobId),
      title: sourceJob.title || null,
      year: sourceJob.year ?? null,
      imdb_id: sourceJob.imdb_id || null,
      poster_url: sourceJob.poster_url || null,
      omdb_json: sourceJob.omdb_json || null,
      selected_from_omdb: Number(sourceJob.selected_from_omdb || 0),
      disc_device: sourceJob.disc_device || null,
      rip_successful: Number(sourceJob.rip_successful || 0),
      output_path: null,
      handbrake_info_json: null,
      mediainfo_info_json: null,
      encode_plan_json: null,
      encode_input_path: null,
      encode_review_confirmed: 0,
      ...jobUpdatePayload
    });

    // Thumbnail für neuen Job kopieren, damit er nicht auf die Datei des alten Jobs angewiesen ist
    if (thumbnailService.isLocalUrl(sourceJob.poster_url)) {
      const copiedUrl = thumbnailService.copyThumbnail(Number(jobId), replacementJobId);
      if (copiedUrl) {
        await historyService.updateJob(replacementJobId, { poster_url: copiedUrl }).catch(() => {});
      }
    }

    if (removedQueueActionLabel) {
      await historyService.appendLog(
        replacementJobId,
        'USER_ACTION',
        `Queue-Eintrag entfernt (Review-Neustart): ${removedQueueActionLabel}`
      );
    }
    if (shouldRealignEncodeInput) {
      await historyService.appendLog(
        replacementJobId,
        'SYSTEM',
        `Review-Neustart: Encode-Input auf aktuellen RAW-Pfad abgeglichen: ${existingEncodeInputPath || '-'} -> ${normalizedReviewInputPath}`
      );
    }
    await historyService.appendLog(
      replacementJobId,
      'USER_ACTION',
      `Review-Neustart aus RAW angefordert.${forcePlaylistReselection ? ' Playlist-Auswahl wird zurückgesetzt.' : ''} MakeMKV Full-Analyse wird vollständig neu ausgeführt.`
    );
    await historyService.retireJobInFavorOf(jobId, replacementJobId, {
      reason: 'restart_review'
    });

    await this.setState('MEDIAINFO_CHECK', {
      activeJobId: replacementJobId,
      progress: 0,
      eta: null,
      statusText: 'Titel-/Spurprüfung wird neu gestartet...',
      context: {
        ...(this.snapshot.context || {}),
        jobId: replacementJobId,
        reviewConfirmed: false,
        mediaInfoReview: null
      }
    });

    this.runReviewForRawJob(replacementJobId, resolvedReviewRawPath, {
      mode: options?.mode || 'reencode',
      sourceJobId: Number(jobId),
      forcePlaylistReselection,
      forceFreshAnalyze: true,
      previousEncodePlan
    }).catch((error) => {
      logger.error('restartReviewFromRaw:background-failed', { jobId: replacementJobId, sourceJobId: jobId, error: errorToMeta(error) });
      this.failJob(replacementJobId, 'MEDIAINFO_CHECK', error).catch((failError) => {
        logger.error('restartReviewFromRaw:background-failJob-failed', {
          jobId: replacementJobId,
          error: errorToMeta(failError)
        });
      });
    });

    return {
      restarted: true,
      started: true,
      stage: 'MEDIAINFO_CHECK',
      sourceJobId: Number(jobId),
      jobId: replacementJobId,
      replacedSourceJob: true
    };
  }

  async cancel(jobId = null) {
    const normalizedJobId = this.normalizeQueueJobId(jobId)
      || this.normalizeQueueJobId(this.snapshot.activeJobId)
      || this.normalizeQueueJobId(this.snapshot.context?.jobId)
      || this.normalizeQueueJobId(Array.from(this.activeProcesses.keys())[0]);

    if (!normalizedJobId) {
      const error = new Error('Kein laufender Prozess zum Abbrechen.');
      error.statusCode = 409;
      throw error;
    }

    const processHandle = this.activeProcesses.get(normalizedJobId) || null;
    if (!processHandle) {
      const queuedIndex = this.findQueueEntryIndexByJobId(normalizedJobId);
      if (queuedIndex >= 0) {
        const [removed] = this.queueEntries.splice(queuedIndex, 1);
        await historyService.appendLog(
          normalizedJobId,
          'USER_ACTION',
          `Aus Queue entfernt: ${QUEUE_ACTION_LABELS[removed?.action] || removed?.action || 'Aktion'}`
        );
        await this.emitQueueChanged();
        return {
          cancelled: true,
          queuedOnly: true,
          jobId: normalizedJobId
        };
      }
    }

    const buildForcedCancelError = (message) => {
      const reason = String(message || 'Vom Benutzer hart abgebrochen.').trim() || 'Vom Benutzer hart abgebrochen.';
      const endedAt = nowIso();
      const error = new Error(reason);
      error.statusCode = 409;
      error.runInfo = {
        source: 'USER_CANCEL',
        stage: this.snapshot.state || null,
        cmd: null,
        args: [],
        startedAt: endedAt,
        endedAt,
        durationMs: 0,
        status: 'CANCELLED',
        exitCode: null,
        stdoutLines: 0,
        stderrLines: 0,
        lastProgress: 0,
        eta: null,
        lastDetail: null,
        highlights: []
      };
      return error;
    };

    const forceFinalizeCancelledJob = async (reason, stageHint = null) => {
      const rawStage = String(stageHint || this.snapshot.state || '').trim().toUpperCase();
      const effectiveStage = RUNNING_STATES.has(rawStage)
        ? rawStage
        : (
          RUNNING_STATES.has(String(this.snapshot.state || '').trim().toUpperCase())
            ? String(this.snapshot.state || '').trim().toUpperCase()
            : 'ENCODING'
        );
      try {
        await historyService.appendLog(normalizedJobId, 'USER_ACTION', reason);
      } catch (_error) {
        // continue with force-cancel even if logging failed
      }
      try {
        await this.failJob(normalizedJobId, effectiveStage, buildForcedCancelError(reason));
      } catch (forceError) {
        logger.error('cancel:force-finalize:failed', {
          jobId: normalizedJobId,
          stage: effectiveStage,
          reason,
          error: errorToMeta(forceError)
        });
        const fallbackJob = await historyService.getJobById(normalizedJobId);
        await historyService.updateJob(normalizedJobId, {
          status: 'CANCELLED',
          last_state: 'CANCELLED',
          end_time: nowIso(),
          error_message: reason
        });
        await this.setState('CANCELLED', {
          activeJobId: normalizedJobId,
          progress: this.snapshot.progress,
          eta: null,
          statusText: reason,
          context: {
            jobId: normalizedJobId,
            rawPath: fallbackJob?.raw_path || null,
            error: reason,
            canRestartReviewFromRaw: Boolean(fallbackJob?.raw_path)
          }
        });
      } finally {
        this.cancelRequestedByJob.delete(normalizedJobId);
        this.activeProcesses.delete(normalizedJobId);
        this.syncPrimaryActiveProcess();
      }
      return {
        cancelled: true,
        queuedOnly: false,
        forced: true,
        jobId: normalizedJobId
      };
    };

    const runningJob = await historyService.getJobById(normalizedJobId);
    const runningStatus = String(
      runningJob?.status
      || runningJob?.last_state
      || this.snapshot.state
      || ''
    ).trim().toUpperCase();

    if (!processHandle) {
      if (runningStatus === 'READY_TO_ENCODE') {
        // Kein laufender Prozess – Job direkt abbrechen
        await historyService.updateJob(normalizedJobId, {
          status: 'CANCELLED',
          last_state: 'CANCELLED',
          end_time: nowIso(),
          error_message: 'Vom Benutzer abgebrochen.'
        });
        await historyService.appendLog(normalizedJobId, 'USER_ACTION', 'Abbruch im Status READY_TO_ENCODE.');
        await this.setState('CANCELLED', {
          activeJobId: normalizedJobId,
          progress: 0,
          eta: null,
          statusText: 'Vom Benutzer abgebrochen.',
          context: {
            jobId: normalizedJobId,
            rawPath: runningJob?.raw_path || null,
            error: 'Vom Benutzer abgebrochen.',
            canRestartReviewFromRaw: Boolean(runningJob?.raw_path)
          }
        });
        return { cancelled: true, queuedOnly: false, jobId: normalizedJobId };
      }

      if (RUNNING_STATES.has(runningStatus)) {
        return forceFinalizeCancelledJob(
          `Abbruch erzwungen: kein aktiver Prozess-Handle gefunden (Status ${runningStatus}).`,
          runningStatus
        );
      }

      const error = new Error(`Kein laufender Prozess für Job #${normalizedJobId} zum Abbrechen.`);
      error.statusCode = 409;
      throw error;
    }

    let removedQueuedActionLabel = null;
    const staleQueueIndex = this.findQueueEntryIndexByJobId(normalizedJobId);
    if (staleQueueIndex >= 0) {
      const [removed] = this.queueEntries.splice(staleQueueIndex, 1);
      removedQueuedActionLabel = QUEUE_ACTION_LABELS[removed?.action] || removed?.action || 'Aktion';
      await this.emitQueueChanged();
      try {
        await historyService.appendLog(
          normalizedJobId,
          'SYSTEM',
          `Veralteter Queue-Eintrag beim Abbruch entfernt: ${removedQueuedActionLabel}`
        );
      } catch (_error) {
        // keep cancel flow even if stale queue entry logging fails
      }
    }

    logger.warn('cancel:requested', {
      state: this.snapshot.state,
      activeJobId: this.snapshot.activeJobId,
      requestedJobId: normalizedJobId,
      pid: processHandle?.child?.pid || null,
      removedQueuedAction: removedQueuedActionLabel
    });
    this.cancelRequestedByJob.add(normalizedJobId);
    processHandle.cancel();
    try {
      await historyService.appendLog(
        normalizedJobId,
        'USER_ACTION',
        `Abbruch angefordert (hard-cancel). Status=${runningStatus || '-'}.`
      );
    } catch (_error) {
      // keep hard-cancel flow even if logging fails
    }

    const settleResult = await Promise.race([
      Promise.resolve(processHandle.promise)
        .then(() => 'settled')
        .catch(() => 'settled'),
      new Promise((resolve) => setTimeout(() => resolve('timeout'), 2200))
    ]);
    const stillActive = this.activeProcesses.has(normalizedJobId);
    if (settleResult === 'settled' && !stillActive) {
      return {
        cancelled: true,
        queuedOnly: false,
        jobId: normalizedJobId
      };
    }

    logger.error('cancel:hard-timeout', {
      jobId: normalizedJobId,
      runningStatus,
      settleResult,
      stillActive,
      pid: processHandle?.child?.pid || null
    });
    try {
      processHandle.cancel();
    } catch (_error) {
      // ignore second cancel errors
    }
    const childPid = Number(processHandle?.child?.pid);
    if (Number.isFinite(childPid) && childPid > 0) {
      try { process.kill(-childPid, 'SIGKILL'); } catch (_error) { /* noop */ }
      try { process.kill(childPid, 'SIGKILL'); } catch (_error) { /* noop */ }
    }
    try {
      processHandle?.child?.kill?.('SIGKILL');
    } catch (_error) {
      // noop
    }
    this.activeProcesses.delete(normalizedJobId);
    this.syncPrimaryActiveProcess();
    return forceFinalizeCancelledJob(
      `Abbruch erzwungen: Prozess reagierte nicht rechtzeitig auf Kill-Signal (Status ${runningStatus || '-'}).`,
      runningStatus
    );
  }

  async runCommand({
    jobId,
    stage,
    source,
    cmd,
    args,
    parser,
    collectLines = null,
    collectStdoutLines = true,
    collectStderrLines = true,
    argsForLog = null,
    silent = false
  }) {
    const normalizedJobId = this.normalizeQueueJobId(jobId) || Number(jobId) || jobId;
    const loggableArgs = Array.isArray(argsForLog) ? argsForLog : args;
    if (this.cancelRequestedByJob.has(Number(normalizedJobId))) {
      const cancelError = new Error('Job wurde vom Benutzer abgebrochen.');
      cancelError.statusCode = 409;
      const endedAt = nowIso();
      cancelError.runInfo = {
        source,
        stage,
        cmd,
        args: loggableArgs,
        startedAt: endedAt,
        endedAt,
        durationMs: 0,
        status: 'CANCELLED',
        exitCode: null,
        stdoutLines: 0,
        stderrLines: 0,
        lastProgress: 0,
        eta: null,
        lastDetail: null,
        highlights: []
      };
      logger.warn('command:cancelled-before-spawn', { jobId: normalizedJobId, stage, source });
      throw cancelError;
    }

    await historyService.appendLog(jobId, 'SYSTEM', `Spawn ${cmd} ${loggableArgs.join(' ')}`);
    logger.info('command:spawn', { jobId, stage, source, cmd, args: loggableArgs });

    const runInfo = {
      source,
      stage,
      cmd,
      args: loggableArgs,
      startedAt: nowIso(),
      endedAt: null,
      durationMs: null,
      status: 'RUNNING',
      exitCode: null,
      stdoutLines: 0,
      stderrLines: 0,
      lastProgress: 0,
      eta: null,
      lastDetail: null,
      highlights: []
    };

    const applyLine = (line, isStderr) => {
      const text = truncateLine(line, 400);
      if (isStderr) {
        runInfo.stderrLines += 1;
      } else {
        runInfo.stdoutLines += 1;
      }

      const detail = extractProgressDetail(source, text);
      if (detail) {
        runInfo.lastDetail = detail;
      }

      if (runInfo.highlights.length < 120 && shouldKeepHighlight(text)) {
        runInfo.highlights.push(text);
      }

      if (parser && !silent) {
        const progress = parser(text);
        if (progress && progress.percent !== null) {
          runInfo.lastProgress = progress.percent;
          runInfo.eta = progress.eta || runInfo.eta;
          const statusText = composeStatusText(stage, progress.percent, runInfo.lastDetail);
          void this.updateProgress(stage, progress.percent, progress.eta, statusText, normalizedJobId);
        } else if (detail) {
          const jobEntry = this.jobProgress.get(Number(normalizedJobId));
          const currentProgress = jobEntry?.progress ?? Number(this.snapshot.progress || 0);
          const currentEta = jobEntry?.eta ?? this.snapshot.eta;
          const statusText = composeStatusText(stage, currentProgress, runInfo.lastDetail);
          void this.updateProgress(stage, currentProgress, currentEta, statusText, normalizedJobId);
        }
      }
    };

    const processHandle = spawnTrackedProcess({
      cmd,
      args,
      context: { jobId, stage, source },
      onStdoutLine: (line) => {
        if (collectLines && collectStdoutLines) {
          collectLines.push(line);
        }
        void historyService.appendProcessLog(jobId, source, line);
        applyLine(line, false);
      },
      onStderrLine: (line) => {
        if (collectLines && collectStderrLines) {
          collectLines.push(line);
        }
        void historyService.appendProcessLog(jobId, `${source}_ERR`, line);
        applyLine(line, true);
      }
    });

    this.activeProcesses.set(Number(normalizedJobId), processHandle);
    this.syncPrimaryActiveProcess();

    try {
      const procResult = await processHandle.promise;
      runInfo.status = 'SUCCESS';
      runInfo.exitCode = procResult.code;
      runInfo.endedAt = nowIso();
      runInfo.durationMs = new Date(runInfo.endedAt).getTime() - new Date(runInfo.startedAt).getTime();
      await historyService.appendLog(jobId, 'SYSTEM', `${source} abgeschlossen.`);
      logger.info('command:completed', { jobId, stage, source });
      return runInfo;
    } catch (error) {
      if (this.cancelRequestedByJob.has(Number(normalizedJobId))) {
        const cancelError = new Error('Job wurde vom Benutzer abgebrochen.');
        cancelError.statusCode = 409;
        runInfo.status = 'CANCELLED';
        runInfo.exitCode = null;
        runInfo.endedAt = nowIso();
        runInfo.durationMs = new Date(runInfo.endedAt).getTime() - new Date(runInfo.startedAt).getTime();
        cancelError.runInfo = runInfo;
        logger.warn('command:cancelled', { jobId, stage, source });
        throw cancelError;
      }
      runInfo.status = 'ERROR';
      runInfo.exitCode = error.code ?? null;
      runInfo.endedAt = nowIso();
      runInfo.durationMs = new Date(runInfo.endedAt).getTime() - new Date(runInfo.startedAt).getTime();
      runInfo.errorMessage = error.message;
      error.runInfo = runInfo;
      logger.error('command:failed', { jobId, stage, source, error: errorToMeta(error) });
      throw error;
    } finally {
      this.activeProcesses.delete(Number(normalizedJobId));
      this.cancelRequestedByJob.delete(Number(normalizedJobId));
      this.syncPrimaryActiveProcess();
      await historyService.closeProcessLog(jobId);
      await this.emitQueueChanged();
      void this.pumpQueue();
    }
  }

  async failJob(jobId, stage, error) {
    const message = error?.message || String(error);
    const isCancelled = /abgebrochen|cancelled/i.test(message)
      || String(error?.runInfo?.status || '').trim().toUpperCase() === 'CANCELLED';
    const normalizedStage = String(stage || '').trim().toUpperCase();
    const job = await historyService.getJobById(jobId);
    const title = job?.title || job?.detected_title || `Job #${jobId}`;
    const finalState = isCancelled ? 'CANCELLED' : 'ERROR';
    logger[isCancelled ? 'warn' : 'error']('job:failed', { jobId, stage, error: errorToMeta(error) });
    const makemkvInfo = this.safeParseJson(job?.makemkv_info_json);
    const encodePlan = this.safeParseJson(job?.encode_plan_json);
    const resolvedMediaProfile = this.resolveMediaProfileForJob(job, {
      encodePlan,
      makemkvInfo,
      mediaProfile: normalizedStage.startsWith('CD_') ? 'cd' : null
    });
    const isCdFailure = resolvedMediaProfile === 'cd'
      || normalizedStage.startsWith('CD_')
      || String(job?.status || '').trim().toUpperCase().startsWith('CD_')
      || String(job?.last_state || '').trim().toUpperCase().startsWith('CD_')
      || (Array.isArray(makemkvInfo?.tracks) && makemkvInfo.tracks.length > 0);
    const mode = String(encodePlan?.mode || '').trim().toLowerCase();
    const isPreRipMode = mode === 'pre_rip' || Boolean(encodePlan?.preRip);
    const hasEncodableInput = isPreRipMode
      ? Boolean(encodePlan?.encodeInputTitleId)
      : Boolean(job?.encode_input_path || encodePlan?.encodeInputPath || job?.raw_path);
    const hasConfirmedPlan = Boolean(
      encodePlan
      && Array.isArray(encodePlan?.titles)
      && encodePlan.titles.length > 0
      && (Number(job?.encode_review_confirmed || 0) === 1 || Boolean(encodePlan?.reviewConfirmed))
      && hasEncodableInput
    );
    let hasRawPath = false;
    try {
      hasRawPath = Boolean(
        job?.raw_path
        && fs.existsSync(job.raw_path)
        && (hasBluRayBackupStructure(job.raw_path) || findPreferredRawInput(job.raw_path))
      );
    } catch (_error) {
      hasRawPath = false;
    }

    if (normalizedStage === 'ENCODING' && hasConfirmedPlan && !isCancelled) {
      try {
        await historyService.appendLog(
          jobId,
          'SYSTEM',
          `Fehler in ${stage}: ${message}. Letzte Encode-Auswahl wird zur direkten Anpassung geladen.`
        );
        await this.restartEncodeWithLastSettings(jobId, {
          immediate: true,
          triggerReason: 'failed_encode'
        });
        this.cancelRequestedByJob.delete(Number(jobId));
        return;
      } catch (recoveryError) {
        logger.error('job:encoding:auto-recover-failed', {
          jobId,
          stage,
          error: errorToMeta(recoveryError)
        });
        await historyService.appendLog(
          jobId,
          'SYSTEM',
          `Auto-Recovery nach Encode-Abbruch fehlgeschlagen: ${recoveryError?.message || 'unknown'}`
        );
      }
    }

    await historyService.updateJob(jobId, {
      status: finalState,
      last_state: finalState,
      end_time: nowIso(),
      error_message: message
    });
    await historyService.appendLog(
      jobId,
      'SYSTEM',
      `${isCancelled ? 'Abbruch' : 'Fehler'} in ${stage}: ${message}`
    );
    const jobProgressContext = this.jobProgress.get(Number(jobId))?.context;
    const cdSelectedMetadata = makemkvInfo?.selectedMetadata && typeof makemkvInfo.selectedMetadata === 'object'
      ? makemkvInfo.selectedMetadata
      : {};
    const fallbackCdArtist = Array.isArray(makemkvInfo?.tracks)
      ? (
        makemkvInfo.tracks
          .map((track) => String(track?.artist || '').trim())
          .find(Boolean) || null
      )
      : null;
    const resolvedCdMbId = String(
      cdSelectedMetadata?.mbId
      || cdSelectedMetadata?.musicBrainzId
      || cdSelectedMetadata?.musicbrainzId
      || cdSelectedMetadata?.mbid
      || ''
    ).trim() || null;
    const resolvedCdCoverUrl = String(
      cdSelectedMetadata?.coverUrl
      || cdSelectedMetadata?.poster
      || cdSelectedMetadata?.posterUrl
      || job?.poster_url
      || ''
    ).trim() || null;
    const resolvedSelectedMetadata = isCdFailure
      ? {
        title: cdSelectedMetadata?.title || job?.title || job?.detected_title || null,
        artist: cdSelectedMetadata?.artist || fallbackCdArtist || null,
        year: cdSelectedMetadata?.year ?? job?.year ?? null,
        mbId: resolvedCdMbId,
        coverUrl: resolvedCdCoverUrl,
        imdbId: job?.imdb_id || null,
        poster: job?.poster_url || resolvedCdCoverUrl || null
      }
      : {
        title: job?.title || job?.detected_title || null,
        year: job?.year || null,
        imdbId: job?.imdb_id || null,
        poster: job?.poster_url || null
      };
    const resolvedTracks = isCdFailure
      ? (
        Array.isArray(jobProgressContext?.tracks) && jobProgressContext.tracks.length > 0
          ? jobProgressContext.tracks
          : (Array.isArray(makemkvInfo?.tracks) ? makemkvInfo.tracks : [])
      )
      : [];
    const resolvedCdRipConfig = isCdFailure
      ? (
        jobProgressContext?.cdRipConfig && typeof jobProgressContext.cdRipConfig === 'object'
          ? jobProgressContext.cdRipConfig
          : (encodePlan && typeof encodePlan === 'object' ? encodePlan : null)
      )
      : null;

    await this.setState(finalState, {
      activeJobId: jobId,
      progress: this.snapshot.progress,
      eta: null,
      statusText: message,
      context: {
        ...(jobProgressContext && typeof jobProgressContext === 'object' ? jobProgressContext : {}),
        jobId,
        stage,
        error: message,
        rawPath: job?.raw_path || null,
        outputPath: job?.output_path || null,
        mediaProfile: isCdFailure ? 'cd' : resolvedMediaProfile,
        inputPath: job?.encode_input_path || encodePlan?.encodeInputPath || null,
        selectedMetadata: resolvedSelectedMetadata,
        ...(isCdFailure ? {
          tracks: resolvedTracks,
          cdRipConfig: resolvedCdRipConfig,
          cdLive: jobProgressContext?.cdLive || null,
          devicePath: String(job?.disc_device || jobProgressContext?.devicePath || '').trim() || null,
          cdparanoiaCmd: String(makemkvInfo?.cdparanoiaCmd || jobProgressContext?.cdparanoiaCmd || '').trim() || null
        } : {}),
        canRestartEncodeFromLastSettings: hasConfirmedPlan,
        canRestartReviewFromRaw: hasRawPath
      }
    });
    this.cancelRequestedByJob.delete(Number(jobId));

    void this.notifyPushover(isCancelled ? 'job_cancelled' : 'job_error', {
      title: isCancelled ? 'Ripster - Job abgebrochen' : 'Ripster - Job Fehler',
      message: `${title} (${stage}): ${message}`
    });
  }

  // ── CD Pipeline ─────────────────────────────────────────────────────────────

  async analyzeCd(device) {
    const devicePath = String(device?.path || '').trim();
    const detectedTitle = String(
      device?.discLabel || device?.label || device?.model || 'Audio CD'
    ).trim();

    logger.info('cd:analyze:start', { devicePath, detectedTitle });

    const job = await historyService.createJob({
      discDevice: devicePath,
      status: 'CD_METADATA_SELECTION',
      detectedTitle
    });

    try {
      const settings = await settingsService.getSettingsMap();
      const cdparanoiaCmd = String(settings.cdparanoia_command || 'cdparanoia').trim() || 'cdparanoia';

      // Read TOC
      await this.setState('CD_ANALYZING', {
        activeJobId: job.id,
        progress: 0,
        eta: null,
        statusText: 'CD wird analysiert …',
        context: { jobId: job.id, device, mediaProfile: 'cd' }
      });

      const tracks = await cdRipService.readToc(devicePath, cdparanoiaCmd);
      logger.info('cd:analyze:toc', { jobId: job.id, trackCount: tracks.length });
      if (!tracks.length) {
        const error = new Error('Keine Audio-Tracks erkannt. Bitte Laufwerk/Medium prüfen (cdparanoia -Q).');
        error.statusCode = 400;
        throw error;
      }

      const cdInfo = {
        phase: 'PREPARE',
        mediaProfile: 'cd',
        preparedAt: nowIso(),
        cdparanoiaCmd,
        tracks,
        detectedTitle
      };

      await historyService.updateJob(job.id, {
        status: 'CD_METADATA_SELECTION',
        last_state: 'CD_METADATA_SELECTION',
        detected_title: detectedTitle,
        makemkv_info_json: JSON.stringify(cdInfo)
      });
      await historyService.appendLog(
        job.id,
        'SYSTEM',
        `CD analysiert: ${tracks.length} Track(s) gefunden.`
      );

      const runningJobs = await historyService.getRunningJobs();
      const foreignRunningJobs = runningJobs.filter((item) => Number(item?.id) !== Number(job.id));
      if (!foreignRunningJobs.length) {
        const previewTrackPos = tracks[0]?.position ? Number(tracks[0].position) : null;
        const cdparanoiaCommandPreview = `${cdparanoiaCmd} -d ${devicePath || '<device>'} ${previewTrackPos || '<trackNr>'} <temp>/trackNN.cdda.wav`;
        await this.setState('CD_METADATA_SELECTION', {
          activeJobId: job.id,
          progress: 0,
          eta: null,
          statusText: 'CD-Metadaten auswählen',
          context: {
            jobId: job.id,
            device,
            mediaProfile: 'cd',
            devicePath,
            cdparanoiaCmd,
            cdparanoiaCommandPreview,
            detectedTitle,
            tracks
          }
        });
      }

      return { jobId: job.id, detectedTitle, tracks };
    } catch (error) {
      logger.error('cd:analyze:failed', { jobId: job.id, error: errorToMeta(error) });
      await this.failJob(job.id, 'CD_ANALYZING', error);
      throw error;
    }
  }

  async searchMusicBrainz(query) {
    logger.info('musicbrainz:search', { query });
    const results = await musicBrainzService.searchByTitle(query);
    logger.info('musicbrainz:search:done', { query, count: results.length });
    return results;
  }

  async getMusicBrainzReleaseById(mbId) {
    const id = String(mbId || '').trim();
    if (!id) {
      const error = new Error('mbId fehlt.');
      error.statusCode = 400;
      throw error;
    }
    logger.info('musicbrainz:get-by-id', { mbId: id });
    const release = await musicBrainzService.getReleaseById(id);
    if (!release) {
      const error = new Error(`MusicBrainz Release ${id} nicht gefunden.`);
      error.statusCode = 404;
      throw error;
    }
    logger.info('musicbrainz:get-by-id:done', { mbId: id, trackCount: Array.isArray(release.tracks) ? release.tracks.length : 0 });
    return release;
  }

  async selectCdMetadata(payload) {
    const {
      jobId,
      title,
      artist,
      year,
      mbId,
      coverUrl,
      tracks: selectedTracks
    } = payload || {};

    if (!jobId) {
      const error = new Error('jobId fehlt.');
      error.statusCode = 400;
      throw error;
    }

    const job = await historyService.getJobById(jobId);
    if (!job) {
      const error = new Error(`Job ${jobId} nicht gefunden.`);
      error.statusCode = 404;
      throw error;
    }

    logger.info('cd:select-metadata', { jobId, title, artist, year, mbId });

    const cdInfo = this.safeParseJson(job.makemkv_info_json) || {};

    // Merge track metadata from selection into existing TOC tracks
    const tocTracks = Array.isArray(cdInfo.tracks) ? cdInfo.tracks : [];
    const mergedTracks = tocTracks.map((t) => {
      const selected = Array.isArray(selectedTracks)
        ? selectedTracks.find((st) => Number(st.position) === Number(t.position))
        : null;
      const resolvedTitle = normalizeCdTrackText(selected?.title) || t.title || `Track ${t.position}`;
      const resolvedArtist = normalizeCdTrackText(selected?.artist) || t.artist || artist || null;
      return {
        ...t,
        title: resolvedTitle,
        artist: resolvedArtist,
        selected: selected ? Boolean(selected.selected) : true
      };
    });

    const updatedCdInfo = {
      ...cdInfo,
      tracks: mergedTracks,
      selectedMetadata: { title, artist, year, mbId, coverUrl }
    };

    await historyService.updateJob(jobId, {
      title: title || null,
      year: year ? Number(year) : null,
      poster_url: coverUrl || null,
      status: 'CD_READY_TO_RIP',
      last_state: 'CD_READY_TO_RIP',
      makemkv_info_json: JSON.stringify(updatedCdInfo)
    });

    // Bild in Cache laden (async, blockiert nicht)
    if (coverUrl) {
      thumbnailService.cacheJobThumbnail(jobId, coverUrl).catch(() => {});
    }

    await historyService.appendLog(
      jobId,
      'SYSTEM',
      `Metadaten gesetzt: "${title}" (${artist || '-'}, ${year || '-'}).`
    );

    if (this.isPrimaryJob(jobId)) {
      const resolvedDevicePath = String(job?.disc_device || this.snapshot?.context?.device?.path || '').trim() || null;
      const resolvedCdparanoiaCmd = String(cdInfo?.cdparanoiaCmd || 'cdparanoia').trim() || 'cdparanoia';
      const previewTrackPos = mergedTracks[0]?.position ? Number(mergedTracks[0].position) : null;
      const cdparanoiaCommandPreview = `${resolvedCdparanoiaCmd} -d ${resolvedDevicePath || '<device>'} ${previewTrackPos || '<trackNr>'} <temp>/trackNN.cdda.wav`;
      await this.setState('CD_READY_TO_RIP', {
        activeJobId: jobId,
        progress: 0,
        eta: null,
        statusText: 'CD bereit zum Rippen',
        context: {
          ...(this.snapshot.context || {}),
          jobId,
          mediaProfile: 'cd',
          tracks: mergedTracks,
          selectedMetadata: { title, artist, year, mbId, coverUrl },
          devicePath: resolvedDevicePath,
          cdparanoiaCmd: resolvedCdparanoiaCmd,
          cdparanoiaCommandPreview
        }
      });
    }

    return historyService.getJobById(jobId);
  }

  async renameJobFolders(jobId) {
    const job = await historyService.getJobById(jobId);
    if (!job) {
      return { renamed: [] };
    }

    const renamed = [];
    const mediaProfile = this.resolveMediaProfileForJob(job);
    const isCd = mediaProfile === 'cd';
    const settings = await settingsService.getEffectiveSettingsMap(mediaProfile);

    // Rename raw folder
    const currentRawPath = job.raw_path ? path.resolve(job.raw_path) : null;
    if (currentRawPath && fs.existsSync(currentRawPath)) {
      const rawBaseDir = path.dirname(currentRawPath);
      const newMetadataBase = buildRawMetadataBase({
        title: job.title || job.detected_title || null,
        year: job.year || null
      }, jobId);
      const currentState = resolveRawFolderStateFromPath(currentRawPath);
      const newRawDirName = buildRawDirName(newMetadataBase, jobId, { state: currentState });
      const newRawPath = path.join(rawBaseDir, newRawDirName);

      if (normalizeComparablePath(currentRawPath) !== normalizeComparablePath(newRawPath) && !fs.existsSync(newRawPath)) {
        try {
          fs.renameSync(currentRawPath, newRawPath);
          await historyService.updateJob(jobId, { raw_path: newRawPath });
          renamed.push({ type: 'raw', from: currentRawPath, to: newRawPath });
          logger.info('rename-job-folders:raw', { jobId, from: currentRawPath, to: newRawPath });
        } catch (err) {
          logger.warn('rename-job-folders:raw-failed', { jobId, error: err.message });
        }
      }
    }

    // Rename output file (film) or output directory (CD)
    const currentOutputPath = job.output_path ? path.resolve(job.output_path) : null;
    if (currentOutputPath && fs.existsSync(currentOutputPath)) {
      try {
        if (isCd) {
          const cdInfo = this.safeParseJson(job.makemkv_info_json) || {};
          const selectedMeta = cdInfo.selectedMetadata && typeof cdInfo.selectedMetadata === 'object'
            ? cdInfo.selectedMetadata
            : {};
          const cdMeta = {
            artist: String(selectedMeta.artist || '').trim() || String(job.title || '').trim() || null,
            album: String(job.title || selectedMeta.title || '').trim() || null,
            year: job.year || selectedMeta.year || null
          };
          const cdOutputBaseDir = String(settings.movie_dir || '').trim();
          const cdOutputTemplate = String(settings.cd_output_template || cdRipService.DEFAULT_CD_OUTPUT_TEMPLATE).trim();
          if (cdOutputBaseDir) {
            const newCdOutputDir = cdRipService.buildOutputDir(cdMeta, cdOutputBaseDir, cdOutputTemplate);
            if (normalizeComparablePath(currentOutputPath) !== normalizeComparablePath(newCdOutputDir) && !fs.existsSync(newCdOutputDir)) {
              fs.mkdirSync(path.dirname(newCdOutputDir), { recursive: true });
              fs.renameSync(currentOutputPath, newCdOutputDir);
              await historyService.updateJob(jobId, { output_path: newCdOutputDir });
              renamed.push({ type: 'output', from: currentOutputPath, to: newCdOutputDir });
              logger.info('rename-job-folders:cd-output', { jobId, from: currentOutputPath, to: newCdOutputDir });
            }
          }
        } else {
          const newOutputPath = buildFinalOutputPathFromJob(settings, job, jobId);
          if (normalizeComparablePath(currentOutputPath) !== normalizeComparablePath(newOutputPath) && !fs.existsSync(newOutputPath)) {
            fs.mkdirSync(path.dirname(newOutputPath), { recursive: true });
            moveFileWithFallback(currentOutputPath, newOutputPath);
            try {
              const oldParentDir = path.dirname(currentOutputPath);
              if (fs.readdirSync(oldParentDir).length === 0) {
                fs.rmdirSync(oldParentDir);
              }
            } catch (_ignoreErr) {}
            await historyService.updateJob(jobId, { output_path: newOutputPath });
            renamed.push({ type: 'output', from: currentOutputPath, to: newOutputPath });
            logger.info('rename-job-folders:film-output', { jobId, from: currentOutputPath, to: newOutputPath });
          }
        }
      } catch (err) {
        logger.warn('rename-job-folders:output-failed', { jobId, isCd, error: err.message });
      }
    }

    return { renamed };
  }

  async startCdRip(jobId, ripConfig) {
    this.ensureNotBusy('startCdRip', jobId);
    this.cancelRequestedByJob.delete(Number(jobId));

    const sourceJob = await historyService.getJobById(jobId);
    if (!sourceJob) {
      const error = new Error(`Job ${jobId} nicht gefunden.`);
      error.statusCode = 404;
      throw error;
    }

    let activeJobId = Number(jobId);
    let activeJob = sourceJob;
    const sourceStatus = String(sourceJob.status || sourceJob.last_state || '').trim().toUpperCase();
    const shouldReplaceSourceJob = sourceStatus === 'CANCELLED' || sourceStatus === 'ERROR';
    if (shouldReplaceSourceJob) {
      const replacementJob = await historyService.createJob({
        discDevice: sourceJob.disc_device || null,
        status: 'CD_READY_TO_RIP',
        detectedTitle: sourceJob.detected_title || sourceJob.title || null
      });
      const replacementJobId = Number(replacementJob?.id || 0);
      if (!Number.isFinite(replacementJobId) || replacementJobId <= 0) {
        throw new Error('CD-Neustart fehlgeschlagen: neuer Job konnte nicht erstellt werden.');
      }

      await historyService.updateJob(replacementJobId, {
        parent_job_id: Number(jobId),
        title: sourceJob.title || null,
        year: sourceJob.year ?? null,
        imdb_id: sourceJob.imdb_id || null,
        poster_url: sourceJob.poster_url || null,
        omdb_json: sourceJob.omdb_json || null,
        selected_from_omdb: Number(sourceJob.selected_from_omdb || 0),
        status: 'CD_READY_TO_RIP',
        last_state: 'CD_READY_TO_RIP',
        error_message: null,
        end_time: null,
        output_path: null,
        disc_device: sourceJob.disc_device || null,
        raw_path: null,
        rip_successful: 0,
        makemkv_info_json: sourceJob.makemkv_info_json || null,
        handbrake_info_json: null,
        mediainfo_info_json: null,
        encode_plan_json: null,
        encode_input_path: null,
        encode_review_confirmed: 0
      });
      // Thumbnail für neuen Job kopieren, damit er nicht auf die Datei des alten Jobs angewiesen ist
      if (thumbnailService.isLocalUrl(sourceJob.poster_url)) {
        const copiedUrl = thumbnailService.copyThumbnail(Number(jobId), replacementJobId);
        if (copiedUrl) {
          await historyService.updateJob(replacementJobId, { poster_url: copiedUrl }).catch(() => {});
        }
      }

      await historyService.appendLog(
        replacementJobId,
        'USER_ACTION',
        `CD-Rip Neustart aus Job #${jobId}. Alter Job wurde durch neuen Job ersetzt.`
      );
      await historyService.retireJobInFavorOf(jobId, replacementJobId, {
        reason: 'cd_restart_rip'
      });

      activeJobId = replacementJobId;
      activeJob = await historyService.getJobById(replacementJobId);
      this.cancelRequestedByJob.delete(replacementJobId);
      if (!activeJob) {
        throw new Error(`CD-Neustart fehlgeschlagen: neuer Job #${replacementJobId} konnte nicht geladen werden.`);
      }
    }

    const cdInfo = this.safeParseJson(activeJob.makemkv_info_json) || {};
    const device = this.detectedDisc || this.snapshot.context?.device;
    const devicePath = String(device?.path || activeJob.disc_device || '').trim();

    if (!devicePath) {
      const error = new Error('Kein CD-Laufwerk bekannt.');
      error.statusCode = 400;
      throw error;
    }

    const format = String(ripConfig?.format || 'flac').trim().toLowerCase();
    const formatOptions = ripConfig?.formatOptions || {};
    const normalizeTrackPosition = (value) => {
      const parsed = Number(value);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        return null;
      }
      return Math.trunc(parsed);
    };
    const selectedTrackPositions = Array.isArray(ripConfig?.selectedTracks)
      ? ripConfig.selectedTracks
        .map(normalizeTrackPosition)
        .filter((value) => Number.isFinite(value) && value > 0)
      : [];
    const normalizeOptionalYear = (value) => {
      if (value === null || value === undefined || String(value).trim() === '') {
        return null;
      }
      const parsed = Number(value);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        return null;
      }
      return Math.trunc(parsed);
    };

    const tocTracks = Array.isArray(cdInfo.tracks) ? cdInfo.tracks : [];
    const incomingTracks = Array.isArray(ripConfig?.tracks) ? ripConfig.tracks : [];
    const incomingByPosition = new Map();
    for (const incoming of incomingTracks) {
      const position = normalizeTrackPosition(incoming?.position);
      if (!position) {
        continue;
      }
      incomingByPosition.set(position, incoming);
    }
    const selectedMeta = cdInfo.selectedMetadata || {};
    const incomingMeta = ripConfig?.metadata && typeof ripConfig.metadata === 'object'
      ? ripConfig.metadata
      : {};
    const effectiveSelectedMeta = {
      ...selectedMeta,
      title: normalizeCdTrackText(incomingMeta?.title)
        || normalizeCdTrackText(selectedMeta?.title)
        || normalizeCdTrackText(activeJob?.title)
        || normalizeCdTrackText(cdInfo?.detectedTitle)
        || 'Audio CD',
      artist: normalizeCdTrackText(incomingMeta?.artist)
        || normalizeCdTrackText(selectedMeta?.artist)
        || null,
      year: normalizeOptionalYear(incomingMeta?.year)
        ?? normalizeOptionalYear(selectedMeta?.year)
        ?? normalizeOptionalYear(activeJob?.year)
        ?? null
    };
    const mergedTracks = tocTracks.map((track) => {
      const position = normalizeTrackPosition(track?.position);
      if (!position) {
        return null;
      }
      const incoming = incomingByPosition.get(position) || null;
      const fallbackTitle = normalizeCdTrackText(track?.title) || `Track ${position}`;
      const fallbackArtist = normalizeCdTrackText(track?.artist) || normalizeCdTrackText(effectiveSelectedMeta?.artist) || '';
      const title = normalizeCdTrackText(incoming?.title) || fallbackTitle;
      const artist = normalizeCdTrackText(incoming?.artist) || fallbackArtist || null;
      const selected = incoming
        ? Boolean(incoming?.selected)
        : (track?.selected !== false);
      return {
        ...track,
        position,
        title,
        artist,
        selected
      };
    }).filter(Boolean);

    const effectiveSelectedTrackPositions = selectedTrackPositions.length > 0
      ? selectedTrackPositions
      : mergedTracks.filter((track) => track?.selected !== false).map((track) => track.position);
    const selectedPreEncodeScriptIds = normalizeScriptIdList(ripConfig?.selectedPreEncodeScriptIds || []);
    const selectedPostEncodeScriptIds = normalizeScriptIdList(ripConfig?.selectedPostEncodeScriptIds || []);
    const selectedPreEncodeChainIds = normalizeChainIdList(ripConfig?.selectedPreEncodeChainIds || []);
    const selectedPostEncodeChainIds = normalizeChainIdList(ripConfig?.selectedPostEncodeChainIds || []);

    const [
      selectedPreEncodeScripts,
      selectedPostEncodeScripts,
      selectedPreEncodeChains,
      selectedPostEncodeChains
    ] = await Promise.all([
      scriptService.resolveScriptsByIds(selectedPreEncodeScriptIds, { strict: true }),
      scriptService.resolveScriptsByIds(selectedPostEncodeScriptIds, { strict: true }),
      scriptChainService.getChainsByIds(selectedPreEncodeChainIds),
      scriptChainService.getChainsByIds(selectedPostEncodeChainIds)
    ]);

    const ensureResolvedChains = (requestedIds, resolvedChains, fieldName) => {
      const resolved = Array.isArray(resolvedChains) ? resolvedChains : [];
      const resolvedSet = new Set(
        resolved
          .map((chain) => Number(chain?.id))
          .filter((id) => Number.isFinite(id) && id > 0)
          .map((id) => Math.trunc(id))
      );
      const missing = requestedIds.filter((id) => !resolvedSet.has(Number(id)));
      if (missing.length === 0) {
        return;
      }
      const error = new Error(`Skriptkette(n) nicht gefunden: ${missing.join(', ')}`);
      error.statusCode = 400;
      error.details = [{ field: fieldName, message: `Nicht gefunden: ${missing.join(', ')}` }];
      throw error;
    };
    ensureResolvedChains(selectedPreEncodeChainIds, selectedPreEncodeChains, 'selectedPreEncodeChainIds');
    ensureResolvedChains(selectedPostEncodeChainIds, selectedPostEncodeChains, 'selectedPostEncodeChainIds');

    const toScriptDescriptor = (script) => {
      const id = Number(script?.id);
      const normalizedId = Number.isFinite(id) && id > 0 ? Math.trunc(id) : null;
      if (!normalizedId) {
        return null;
      }
      const name = String(script?.name || '').trim() || `Skript #${normalizedId}`;
      return { id: normalizedId, name };
    };
    const toChainDescriptor = (chain) => {
      const id = Number(chain?.id);
      const normalizedId = Number.isFinite(id) && id > 0 ? Math.trunc(id) : null;
      if (!normalizedId) {
        return null;
      }
      const name = String(chain?.name || '').trim() || `Kette #${normalizedId}`;
      return { id: normalizedId, name };
    };

    const settings = await settingsService.getEffectiveSettingsMap('cd');
    const cdparanoiaCmd = String(settings.cdparanoia_command || 'cdparanoia').trim() || 'cdparanoia';
    const cdOutputTemplate = String(
      settings.cd_output_template || cdRipService.DEFAULT_CD_OUTPUT_TEMPLATE
    ).trim() || cdRipService.DEFAULT_CD_OUTPUT_TEMPLATE;
    const cdRawBaseDir = String(settings.raw_dir || '').trim() || settingsService.DEFAULT_CD_DIR;
    const cdOutputBaseDir = String(settings.movie_dir || '').trim() || cdRawBaseDir;
    const cdRawOwner = String(settings.raw_dir_owner || '').trim();
    const cdOutputOwner = String(settings.movie_dir_owner || settings.raw_dir_owner || '').trim();
    const cdMetadataBase = buildRawMetadataBase({
      title: effectiveSelectedMeta?.album || effectiveSelectedMeta?.title || null,
      year: effectiveSelectedMeta?.year || null
    }, activeJobId);
    const rawDirName = buildRawDirName(cdMetadataBase, activeJobId, { state: RAW_FOLDER_STATES.INCOMPLETE });
    const rawJobDir = path.join(cdRawBaseDir, rawDirName);
    const rawWavDir = rawJobDir;
    const outputDir = cdRipService.buildOutputDir(effectiveSelectedMeta, cdOutputBaseDir, cdOutputTemplate);
    ensureDir(cdRawBaseDir);
    ensureDir(rawJobDir);
    ensureDir(outputDir);
    chownRecursive(rawJobDir, cdRawOwner);
    chownRecursive(outputDir, cdOutputOwner);
    const previewTrackPos = effectiveSelectedTrackPositions[0] || mergedTracks[0]?.position || 1;
    const previewWavPath = path.join(rawWavDir, `track${String(previewTrackPos).padStart(2, '0')}.cdda.wav`);
    const cdparanoiaCommandPreview = `${cdparanoiaCmd} -d ${devicePath} ${previewTrackPos} ${previewWavPath}`;
    const cdLiveTrackRows = buildCdLiveTrackRows(
      effectiveSelectedTrackPositions,
      mergedTracks,
      effectiveSelectedMeta?.artist
    );
    const initialCdLive = buildCdLiveProgressSnapshot({
      trackRows: cdLiveTrackRows,
      phase: 'rip',
      trackIndex: cdLiveTrackRows.length > 0 ? 1 : 0,
      trackTotal: cdLiveTrackRows.length,
      trackPosition: cdLiveTrackRows[0]?.position || null,
      ripCompletedCount: 0,
      encodeCompletedCount: 0
    });
    const cdEncodePlan = {
      format,
      formatOptions,
      selectedTracks: effectiveSelectedTrackPositions,
      tracks: mergedTracks,
      outputTemplate: cdOutputTemplate,
      preEncodeScriptIds: selectedPreEncodeScripts.map((item) => Number(item.id)),
      postEncodeScriptIds: selectedPostEncodeScripts.map((item) => Number(item.id)),
      preEncodeScripts: selectedPreEncodeScripts.map(toScriptDescriptor).filter(Boolean),
      postEncodeScripts: selectedPostEncodeScripts.map(toScriptDescriptor).filter(Boolean),
      preEncodeChainIds: selectedPreEncodeChainIds,
      postEncodeChainIds: selectedPostEncodeChainIds,
      preEncodeChains: selectedPreEncodeChains.map(toChainDescriptor).filter(Boolean),
      postEncodeChains: selectedPostEncodeChains.map(toChainDescriptor).filter(Boolean)
    };

    const updatedCdInfo = {
      ...cdInfo,
      tracks: mergedTracks,
      selectedMetadata: effectiveSelectedMeta
    };

    await historyService.updateJob(activeJobId, {
      title: effectiveSelectedMeta?.title || null,
      year: normalizeOptionalYear(effectiveSelectedMeta?.year),
      status: 'CD_RIPPING',
      last_state: 'CD_RIPPING',
      error_message: null,
      raw_path: rawJobDir,
      output_path: outputDir,
      handbrake_info_json: null,
      mediainfo_info_json: null,
      makemkv_info_json: JSON.stringify(updatedCdInfo),
      encode_plan_json: JSON.stringify(cdEncodePlan)
    });

    await this.setState('CD_RIPPING', {
      activeJobId,
      progress: 0,
      eta: null,
      statusText: 'CD wird gerippt …',
      context: {
        ...(this.snapshot.context || {}),
        jobId: activeJobId,
        mediaProfile: 'cd',
        tracks: mergedTracks,
        selectedMetadata: effectiveSelectedMeta,
        devicePath,
        cdparanoiaCmd,
        rawWavDir,
        outputPath: outputDir,
        outputTemplate: cdOutputTemplate,
        cdRipConfig: cdEncodePlan,
        cdLive: initialCdLive,
        cdparanoiaCommandPreview
      }
    });

    logger.info('cd:rip:start', { jobId: activeJobId, devicePath, format, trackCount: effectiveSelectedTrackPositions.length });
    await historyService.appendLog(
      activeJobId,
      'SYSTEM',
      `CD-Rip gestartet: Format=${format}, Tracks=${effectiveSelectedTrackPositions.join(',') || 'alle'}`
    );
    if (
      selectedPreEncodeScripts.length > 0
      || selectedPreEncodeChains.length > 0
      || selectedPostEncodeScripts.length > 0
      || selectedPostEncodeChains.length > 0
    ) {
      await historyService.appendLog(
        activeJobId,
        'SYSTEM',
        `CD Skript-Auswahl: Pre-Skripte=${selectedPreEncodeScripts.length}, Pre-Ketten=${selectedPreEncodeChains.length}, `
        + `Post-Skripte=${selectedPostEncodeScripts.length}, Post-Ketten=${selectedPostEncodeChains.length}.`
      );
    }

    // Run asynchronously so the HTTP response returns immediately
    this._runCdRip({
      jobId: activeJobId,
      devicePath,
      cdparanoiaCmd,
      rawWavDir,
      rawBaseDir: cdRawBaseDir,
      cdMetadataBase,
      outputDir,
      format,
      formatOptions,
      outputTemplate: cdOutputTemplate,
      rawOwner: cdRawOwner,
      outputOwner: cdOutputOwner,
      selectedTrackPositions: effectiveSelectedTrackPositions,
      tocTracks: mergedTracks,
      selectedMeta: effectiveSelectedMeta,
      encodePlan: cdEncodePlan
    }).catch((error) => {
      logger.error('cd:rip:unhandled', { jobId: activeJobId, error: errorToMeta(error) });
    });

    return {
      jobId: activeJobId,
      sourceJobId: shouldReplaceSourceJob ? Number(jobId) : null,
      replacedSourceJob: shouldReplaceSourceJob,
      started: true
    };
  }

  async _runCdRip({
    jobId,
    devicePath,
    cdparanoiaCmd,
    rawWavDir,
    rawBaseDir,
    cdMetadataBase,
    outputDir,
    format,
    formatOptions,
    outputTemplate,
    rawOwner,
    outputOwner,
    selectedTrackPositions,
    tocTracks,
    selectedMeta,
    encodePlan = null
  }) {
    const processKey = Number(jobId);
    let currentProcessHandle = null;
    let lifecycleResolve = null;
    let lifecycleSettled = false;
    const lifecyclePromise = new Promise((resolve) => {
      lifecycleResolve = resolve;
    });
    const settleLifecycle = () => {
      if (lifecycleSettled) {
        return;
      }
      lifecycleSettled = true;
      lifecycleResolve({ settled: true });
    };
    const sharedHandle = {
      child: null,
      promise: lifecyclePromise,
      cancel: () => {
        try {
          currentProcessHandle?.cancel?.();
        } catch (_error) {
          // ignore cancel race errors
        }
      }
    };
    this.activeProcesses.set(processKey, sharedHandle);
    this.syncPrimaryActiveProcess();

    try {
      const normalizedEncodePlan = encodePlan && typeof encodePlan === 'object' ? encodePlan : {};
      const preScriptIds = normalizeScriptIdList(normalizedEncodePlan?.preEncodeScriptIds || []);
      const preChainIds = normalizeChainIdList(normalizedEncodePlan?.preEncodeChainIds || []);
      const postScriptIds = normalizeScriptIdList(normalizedEncodePlan?.postEncodeScriptIds || []);
      const postChainIds = normalizeChainIdList(normalizedEncodePlan?.postEncodeChainIds || []);
      let preEncodeScriptsSummary = {
        configured: 0,
        attempted: 0,
        succeeded: 0,
        failed: 0,
        skipped: 0,
        results: []
      };
      let postEncodeScriptsSummary = {
        configured: 0,
        attempted: 0,
        succeeded: 0,
        failed: 0,
        skipped: 0,
        results: []
      };
      const selectedTrackOrder = normalizeCdTrackPositionList(selectedTrackPositions);
      const liveTrackRows = buildCdLiveTrackRows(selectedTrackOrder, tocTracks, selectedMeta?.artist);
      const effectiveTrackTotal = liveTrackRows.length;
      let ripCompletedCount = 0;
      let encodeCompletedCount = 0;
      let currentPhase = 'rip';
      let currentTrackIndex = effectiveTrackTotal > 0 ? 1 : 0;
      let currentTrackPosition = liveTrackRows[0]?.position || null;
      const buildLiveContext = (failedTrackPosition = null) => buildCdLiveProgressSnapshot({
        trackRows: liveTrackRows,
        phase: currentPhase,
        trackIndex: currentTrackIndex,
        trackTotal: effectiveTrackTotal,
        trackPosition: currentTrackPosition,
        ripCompletedCount,
        encodeCompletedCount,
        failedTrackPosition
      });
      if (preScriptIds.length > 0 || preChainIds.length > 0) {
        await historyService.appendLog(jobId, 'SYSTEM', 'Pre-Rip Skripte/Ketten werden ausgeführt...');
        preEncodeScriptsSummary = await this.runPreEncodeScripts(jobId, normalizedEncodePlan, {
          mode: 'cd_rip',
          jobId,
          jobTitle: selectedMeta?.title || `Job #${jobId}`,
          inputPath: devicePath || null,
          outputPath: outputDir || null,
          rawPath: rawWavDir || null,
          mediaProfile: 'cd',
          pipelineStage: 'CD_RIPPING'
        });
        await historyService.appendLog(jobId, 'SYSTEM', 'Pre-Rip Skripte/Ketten abgeschlossen.');
      }
      let encodeStateApplied = false;
      let lastProgressPercent = 0;
      const bindProcessHandle = (handle) => {
        currentProcessHandle = handle && typeof handle === 'object' ? handle : null;
        sharedHandle.child = currentProcessHandle?.child || null;
        this.syncPrimaryActiveProcess();
        if (this.cancelRequestedByJob.has(processKey)) {
          try {
            currentProcessHandle?.cancel?.();
          } catch (_error) {
            // ignore cancel race errors
          }
        }
      };
      await cdRipService.ripAndEncode({
        jobId,
        devicePath,
        cdparanoiaCmd,
        rawWavDir,
        outputDir,
        format,
        formatOptions,
        outputTemplate,
        selectedTracks: selectedTrackPositions,
        tracks: tocTracks,
        meta: selectedMeta,
        onProcessHandle: bindProcessHandle,
        isCancelled: () => this.cancelRequestedByJob.has(processKey),
        onProgress: async ({ phase, percent, trackIndex, trackTotal, trackPosition, trackEvent }) => {
          const normalizedPhase = phase === 'encode' ? 'encode' : 'rip';
          const stage = normalizedPhase === 'rip' ? 'CD_RIPPING' : 'CD_ENCODING';
          const normalizedTrackTotal = normalizePositiveInteger(trackTotal) || effectiveTrackTotal;
          const normalizedTrackIndex = normalizePositiveInteger(trackIndex)
            || currentTrackIndex
            || (normalizedTrackTotal > 0 ? 1 : 0);
          const normalizedTrackPosition = normalizePositiveInteger(trackPosition) || currentTrackPosition || null;
          const normalizedTrackEvent = String(trackEvent || '').trim().toLowerCase();
          let clampedPercent = Math.max(0, Math.min(100, Number(percent) || 0));
          if (normalizedPhase === 'rip') {
            clampedPercent = Math.min(clampedPercent, 50);
          } else {
            clampedPercent = Math.max(50, clampedPercent);
          }
          if (clampedPercent < lastProgressPercent) {
            clampedPercent = lastProgressPercent;
          }
          clampedPercent = Number(clampedPercent.toFixed(2));
          lastProgressPercent = clampedPercent;

          if (normalizedPhase === 'rip') {
            currentPhase = 'rip';
            currentTrackIndex = normalizedTrackIndex;
            currentTrackPosition = normalizedTrackPosition;
            if (normalizedTrackEvent === 'complete') {
              ripCompletedCount = Math.max(ripCompletedCount, normalizedTrackIndex);
              if (ripCompletedCount >= normalizedTrackTotal) {
                currentTrackPosition = null;
              }
            } else {
              ripCompletedCount = Math.max(ripCompletedCount, Math.max(0, normalizedTrackIndex - 1));
            }
          } else {
            currentPhase = 'encode';
            ripCompletedCount = Math.max(ripCompletedCount, normalizedTrackTotal);
            currentTrackIndex = normalizedTrackIndex;
            currentTrackPosition = normalizedTrackPosition;
            if (normalizedTrackEvent === 'complete') {
              encodeCompletedCount = Math.max(encodeCompletedCount, normalizedTrackIndex);
              if (encodeCompletedCount >= normalizedTrackTotal) {
                currentTrackPosition = null;
              }
            } else {
              encodeCompletedCount = Math.max(encodeCompletedCount, Math.max(0, normalizedTrackIndex - 1));
            }
          }

          if (normalizedPhase === 'encode' && !encodeStateApplied) {
            encodeStateApplied = true;
            await historyService.updateJob(jobId, {
              status: 'CD_ENCODING',
              last_state: 'CD_ENCODING'
            });
          }

          const detail = Number.isFinite(Number(trackIndex)) && Number.isFinite(Number(trackTotal)) && Number(trackTotal) > 0
            ? ` (${Math.trunc(Number(trackIndex))}/${Math.trunc(Number(trackTotal))})`
            : '';
          const statusText = normalizedPhase === 'rip'
            ? `CD wird gerippt …${detail}`
            : `Tracks werden encodiert …${detail}`;

          await this.updateProgress(stage, clampedPercent, null, statusText, processKey, {
            contextPatch: {
              cdLive: buildLiveContext(null)
            }
          });
        },
        onLog: async (level, msg) => {
          await historyService.appendLog(jobId, 'SYSTEM', msg).catch(() => {});
        },
        context: { jobId: processKey }
      });
      settleLifecycle();

      if (postScriptIds.length > 0 || postChainIds.length > 0) {
        await historyService.appendLog(jobId, 'SYSTEM', 'Post-Rip Skripte/Ketten werden ausgeführt...');
        try {
          postEncodeScriptsSummary = await this.runPostEncodeScripts(jobId, normalizedEncodePlan, {
            mode: 'cd_rip',
            jobId,
            jobTitle: selectedMeta?.title || `Job #${jobId}`,
            inputPath: devicePath || null,
            outputPath: outputDir || null,
            rawPath: rawWavDir || null,
            mediaProfile: 'cd',
            pipelineStage: 'CD_ENCODING'
          });
        } catch (error) {
          logger.warn('cd:rip:post-script:failed', { jobId, error: errorToMeta(error) });
          await historyService.appendLog(
            jobId,
            'SYSTEM',
            `Post-Rip Skripte/Ketten konnten nicht vollständig ausgeführt werden: ${error?.message || 'unknown'}`
          );
        }
        await historyService.appendLog(
          jobId,
          'SYSTEM',
          `Post-Rip Skripte/Ketten abgeschlossen: ${postEncodeScriptsSummary.succeeded} erfolgreich, `
          + `${postEncodeScriptsSummary.failed} fehlgeschlagen, ${postEncodeScriptsSummary.skipped} übersprungen.`
        );
      }

      // RAW-Verzeichnis von Incomplete_ → finalen Namen umbenennen
      let activeRawDir = rawWavDir;
      try {
        const completedRawDirName = buildRawDirName(cdMetadataBase, jobId, { state: RAW_FOLDER_STATES.COMPLETE });
        const completedRawDir = path.join(rawBaseDir, completedRawDirName);
        if (activeRawDir !== completedRawDir && fs.existsSync(activeRawDir) && !fs.existsSync(completedRawDir)) {
          fs.renameSync(activeRawDir, completedRawDir);
          activeRawDir = completedRawDir;
        }
      } catch (_renameError) {
        // ignore – raw dir bleibt unter Incomplete_-Name zugänglich
      }

      // Success
      await historyService.updateJob(jobId, {
        status: 'FINISHED',
        last_state: 'FINISHED',
        end_time: nowIso(),
        rip_successful: 1,
        raw_path: activeRawDir,
        output_path: outputDir,
        handbrake_info_json: JSON.stringify({
          mode: 'cd_rip',
          preEncodeScripts: preEncodeScriptsSummary,
          postEncodeScripts: postEncodeScriptsSummary
        })
      });

      // Thumbnail aus Cache in persistenten Ordner verschieben
      const cdPromotedUrl = thumbnailService.promoteJobThumbnail(jobId);
      if (cdPromotedUrl) {
        await historyService.updateJob(jobId, { poster_url: cdPromotedUrl }).catch(() => {});
      }

      chownRecursive(activeRawDir, rawOwner || outputOwner);
      chownRecursive(outputDir, outputOwner);
      await historyService.appendLog(jobId, 'SYSTEM', `CD-Rip abgeschlossen. Ausgabe: ${outputDir}`);
      const finishedStatusText = postEncodeScriptsSummary.failed > 0
        ? `CD-Rip abgeschlossen (${postEncodeScriptsSummary.failed} Skript(e) fehlgeschlagen)`
        : 'CD-Rip abgeschlossen';
      currentPhase = 'encode';
      ripCompletedCount = effectiveTrackTotal;
      encodeCompletedCount = effectiveTrackTotal;
      currentTrackIndex = effectiveTrackTotal;
      currentTrackPosition = null;
      const finishedCdLive = buildLiveContext(null);

      await this.setState('FINISHED', {
        activeJobId: jobId,
        progress: 100,
        eta: null,
        statusText: finishedStatusText,
        context: {
          jobId,
          mediaProfile: 'cd',
          tracks: tocTracks,
          outputDir,
          outputPath: outputDir,
          cdRipConfig: normalizedEncodePlan,
          cdLive: finishedCdLive,
          selectedMetadata: selectedMeta
        }
      });

      void this.notifyPushover('job_finished', {
        title: 'Ripster - CD Rip erfolgreich',
        message: `Job #${jobId}: ${selectedMeta?.title || 'Audio CD'}`
      });
    } catch (error) {
      settleLifecycle();
      const failedCdLive = buildLiveContext(currentTrackPosition || null);
      await this.updateProgress(
        this.snapshot.state === 'CD_ENCODING' ? 'CD_ENCODING' : 'CD_RIPPING',
        this.snapshot.progress,
        null,
        this.snapshot.statusText,
        processKey,
        {
          contextPatch: {
            cdLive: failedCdLive
          }
        }
      );
      logger.error('cd:rip:failed', { jobId, error: errorToMeta(error) });
      await this.failJob(jobId, this.snapshot.state === 'CD_ENCODING' ? 'CD_ENCODING' : 'CD_RIPPING', error);
    } finally {
      this.activeProcesses.delete(processKey);
      this.syncPrimaryActiveProcess();
    }
  }

}

module.exports = new PipelineService();
