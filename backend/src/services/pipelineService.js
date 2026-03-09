const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { getDb } = require('../db/database');
const settingsService = require('./settingsService');
const historyService = require('./historyService');
const omdbService = require('./omdbService');
const scriptService = require('./scriptService');
const scriptChainService = require('./scriptChainService');
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

const RUNNING_STATES = new Set(['ANALYZING', 'RIPPING', 'ENCODING', 'MEDIAINFO_CHECK']);
const REVIEW_REFRESH_SETTING_PREFIXES = [
  'handbrake_',
  'mediainfo_',
  'makemkv_rip_',
  'makemkv_analyze_',
  'output_extension_',
  'filename_template_',
  'output_folder_template_'
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
  'filename_template',
  'output_folder_template'
]);
const QUEUE_ACTIONS = {
  START_PREPARED: 'START_PREPARED',
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
  [QUEUE_ACTIONS.RESTART_REVIEW]: 'Review neu berechnen'
};
const PRE_ENCODE_PROGRESS_RESERVE = 10;
const POST_ENCODE_PROGRESS_RESERVE = 10;
const POST_ENCODE_FINISH_BUFFER = 1;
const MIN_EXTENSIONLESS_DISC_IMAGE_BYTES = 256 * 1024 * 1024;
const RAW_INCOMPLETE_PREFIX = 'Incomplete_';

function nowIso() {
  return new Date().toISOString();
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
  if (raw === 'disc' || raw === 'other' || raw === 'sonstiges' || raw === 'cd') {
    return 'other';
  }
  return null;
}

function isSpecificMediaProfile(value) {
  return value === 'bluray' || value === 'dvd';
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
    if (hasBlurayModelMarker) {
      return 'bluray';
    }
    if (hasDvdModelMarker) {
      return 'dvd';
    }
    return 'dvd';
  }

  if (fstype.includes('iso9660') || fstype.includes('cdfs')) {
    if (hasBlurayModelMarker) {
      return 'bluray';
    }
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

  const markerText = [
    device.discLabel,
    device.label,
    device.fstype,
    device.model
  ]
    .map((value) => String(value || '').trim().toLowerCase())
    .filter(Boolean)
    .join(' ');

  if (/(^|[\s_-])bdmv($|[\s_-])|blu[\s-]?ray|bd-rom|bd-r|bd-re/.test(markerText)) {
    return 'bluray';
  }
  if (/(^|[\s_-])video_ts($|[\s_-])|dvd/.test(markerText)) {
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

function resolveOutputFileName(settings, values) {
  const fileTemplate = settings.filename_template || '${title} (${year})';
  return sanitizeFileName(renderTemplate(fileTemplate, values));
}

function resolveFinalOutputFolderName(settings, values) {
  const folderTemplateRaw = String(settings.output_folder_template || '').trim();
  const fallbackTemplate = settings.filename_template || '${title} (${year})';
  const folderTemplate = folderTemplateRaw || fallbackTemplate;
  return sanitizeFileName(renderTemplate(folderTemplate, values));
}

function buildFinalOutputPathFromJob(settings, job, fallbackJobId = null) {
  const movieDir = settings.movie_dir;
  const values = resolveOutputTemplateValues(job, fallbackJobId);
  const folderName = resolveFinalOutputFolderName(settings, values);
  const baseName = resolveOutputFileName(settings, values);
  const ext = String(settings.output_extension || 'mkv').trim() || 'mkv';
  return path.join(movieDir, folderName, `${baseName}.${ext}`);
}

function buildIncompleteOutputPathFromJob(settings, job, fallbackJobId = null) {
  const movieDir = settings.movie_dir;
  const values = resolveOutputTemplateValues(job, fallbackJobId);
  const baseName = resolveOutputFileName(settings, values);
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
  return /error|fail|warn|title\s+#|saving|encoding:|muxing|copying|decrypt/i.test(line);
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

function normalizeTrackLanguage(raw) {
  const value = String(raw || '').trim();
  if (!value) {
    return 'und';
  }
  return value.toLowerCase().slice(0, 3);
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
  const tracks = [];
  tracks.push({
    '@type': 'General',
    Duration: String(Number(titleInfo?.durationSeconds || 0))
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

function resolveHandBrakeTitleIdForPlaylist(scanJson, playlistIdRaw) {
  const playlistId = normalizePlaylistId(playlistIdRaw);
  if (!playlistId) {
    return null;
  }

  const titleList = pickScanTitleList(scanJson);
  const matches = titleList
    .map((title, idx) => {
      const handBrakeTitleId = normalizeScanTrackId(
        title?.Index ?? title?.index ?? title?.Title ?? title?.title,
        idx
      );
      const playlist = normalizePlaylistId(
        title?.Playlist
        || title?.playlist
        || title?.PlaylistName
        || title?.playlistName
        || null
      );
      const durationSeconds = parseHandBrakeDurationSeconds(
        title?.Duration ?? title?.duration ?? title?.Length ?? title?.length
      );
      return {
        handBrakeTitleId,
        playlist,
        durationSeconds
      };
    })
    .filter((item) => item.playlist === playlistId);

  if (matches.length === 0) {
    return null;
  }

  const best = matches.sort((a, b) => b.durationSeconds - a.durationSeconds || a.handBrakeTitleId - b.handBrakeTitleId)[0];
  return best?.handBrakeTitleId || null;
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

    const subtitleTracks = (Array.isArray(title?.SubtitleList) ? title.SubtitleList : [])
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
    const sortedCandidates = [...candidates].sort((a, b) =>
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

    const subtitleTracks = subtitleList.map((item, trackIndex) => {
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
  const folderPattern = new RegExp(
    `^(?:${escapedIncompletePrefix})?${escapedBase}(?:\\s\\[tt\\d{6,12}\\])?\\s-\\sRAW\\s-\\sjob-\\d+\\s*$`,
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

function buildRawDirName(metadataBase, jobId, options = {}) {
  const incomplete = options?.incomplete !== undefined ? Boolean(options.incomplete) : true;
  const baseName = sanitizeFileName(`${metadataBase} - RAW - job-${jobId}`);
  return incomplete ? sanitizeFileName(`${RAW_INCOMPLETE_PREFIX}${baseName}`) : baseName;
}

function buildCompletedRawPath(rawPath) {
  const sourcePath = String(rawPath || '').trim();
  if (!sourcePath) {
    return null;
  }
  const folderName = path.basename(sourcePath);
  if (!new RegExp(`^${RAW_INCOMPLETE_PREFIX}`, 'i').test(folderName)) {
    return sourcePath;
  }
  const completedFolderName = folderName.replace(new RegExp(`^${RAW_INCOMPLETE_PREFIX}`, 'i'), '');
  if (!completedFolderName) {
    return sourcePath;
  }
  return path.join(path.dirname(sourcePath), completedFolderName);
}

function normalizeComparablePath(inputPath) {
  const source = String(inputPath || '').trim();
  if (!source) {
    return '';
  }
  return path.resolve(source).replace(/[\\/]+$/, '');
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

      return {
        playlistId,
        playlistFile: toPlaylistFile(playlistId),
        titleId: Number.isFinite(titleId) ? Math.trunc(titleId) : null,
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
        audioSummary: source?.audioSummary || null,
        audioTrackPreview: Array.isArray(source?.audioTrackPreview) ? source.audioTrackPreview : []
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
  const candidateIds = Array.from(new Set(
    (Array.isArray(playlistCandidates) ? playlistCandidates : [])
      .map((item) => normalizePlaylistId(item?.playlistId || item?.playlistFile || item))
      .filter(Boolean)
  ));

  const byPlaylist = {};
  for (const playlistId of candidateIds) {
    const handBrakeTitleId = resolveHandBrakeTitleIdForPlaylist(scanJson, playlistId);
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

  resolveCurrentRawPath(rawBaseDir, storedRawPath) {
    const stored = String(storedRawPath || '').trim();
    if (!stored) {
      return null;
    }
    const candidates = [stored];
    if (rawBaseDir) {
      const byFolder = path.join(rawBaseDir, path.basename(stored));
      if (!candidates.includes(byFolder)) {
        candidates.push(byFolder);
      }
    }
    for (const candidate of candidates) {
      try {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
          return candidate;
        }
      } catch (_error) {
        // ignore fs errors
      }
    }
    return null;
  }

  async migrateRawFolderNamingOnStartup(db) {
    const settings = await settingsService.getSettingsMap();
    const rawBaseDir = String(settings?.raw_dir || '').trim();
    if (!rawBaseDir || !fs.existsSync(rawBaseDir)) {
      return;
    }

    const rows = await db.all(`
      SELECT id, title, year, detected_title, raw_path, status, last_state, rip_successful, makemkv_info_json
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

    try {
      const dirEntries = fs.readdirSync(rawBaseDir, { withFileTypes: true });
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
        const candidatePath = path.join(rawBaseDir, entry.name);
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
        rawBaseDir,
        error: errorToMeta(scanError)
      });
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

      const currentRawPath = this.resolveCurrentRawPath(rawBaseDir, row.raw_path)
        || discoveredByJobId.get(jobId)?.path
        || null;
      if (!currentRawPath) {
        missingCount += 1;
        continue;
      }

      const currentFolderName = path.basename(currentRawPath).replace(/^Incomplete_/i, '').trim();
      const folderYearMatch = currentFolderName.match(/\((19|20)\d{2}\)/);
      const fallbackYear = folderYearMatch
        ? Number(String(folderYearMatch[0]).replace(/[()]/g, ''))
        : null;
      const metadataBase = buildRawMetadataBase({
        title: row.title || row.detected_title || null,
        year: row.year || null,
        fallbackYear
      }, jobId);
      const shouldBeIncomplete = !isJobFinished(row);
      const desiredRawPath = path.join(
        rawBaseDir,
        buildRawDirName(metadataBase, jobId, { incomplete: shouldBeIncomplete })
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
        rawBaseDir
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

    if (RUNNING_STATES.has(this.snapshot.state) && this.snapshot.activeJobId) {
      const message = `Server-Neustart während ${this.snapshot.state} am ${new Date().toISOString()}`;
      await historyService.updateJobStatus(this.snapshot.activeJobId, 'ERROR', {
        end_time: nowIso(),
        error_message: message
      });
      await historyService.appendLog(this.snapshot.activeJobId, 'SYSTEM', message);

      await this.setState('ERROR', {
        activeJobId: this.snapshot.activeJobId,
        progress: 0,
        eta: null,
        statusText: message,
        context: {
          jobId: this.snapshot.activeJobId,
          stage: 'RECOVERY',
          error: message
        }
      });
      logger.warn('init:recovered-running-job', { jobId: this.snapshot.activeJobId, previousState: this.snapshot.state });
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

  findQueueEntryIndexByJobId(jobId) {
    return this.queueEntries.findIndex((entry) => Number(entry?.jobId) === Number(jobId));
  }

  async getQueueSnapshot() {
    const maxParallelJobs = await this.getMaxParallelJobs();
    const runningJobs = await historyService.getRunningJobs();
    const runningEncodeCount = runningJobs.filter((job) => job.status === 'ENCODING').length;
    const queuedJobIds = this.queueEntries
      .filter((entry) => !entry.type || entry.type === 'job')
      .map((entry) => Number(entry.jobId))
      .filter((id) => Number.isFinite(id) && id > 0);
    const queuedRows = queuedJobIds.length > 0
      ? await historyService.getJobsByIds(queuedJobIds)
      : [];
    const queuedById = new Map(queuedRows.map((row) => [Number(row.id), row]));

    const queue = {
      maxParallelJobs,
      runningCount: runningEncodeCount,
      runningJobs: runningJobs.map((job) => ({
        jobId: Number(job.id),
        title: job.title || job.detected_title || `Job #${job.id}`,
        status: job.status,
        lastState: job.last_state || null
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
        let hasScripts = false;
        let hasChains = false;
        if (row?.encode_plan_json) {
          try {
            const plan = JSON.parse(row.encode_plan_json);
            hasScripts = Boolean(
              (Array.isArray(plan?.preEncodeScriptIds) && plan.preEncodeScriptIds.length > 0)
              || (Array.isArray(plan?.postEncodeScriptIds) && plan.postEncodeScriptIds.length > 0)
            );
            hasChains = Boolean(
              (Array.isArray(plan?.preEncodeChainIds) && plan.preEncodeChainIds.length > 0)
              || (Array.isArray(plan?.postEncodeChainIds) && plan.postEncodeChainIds.length > 0)
            );
          } catch (_) { /* ignore */ }
        }
        return {
          ...base,
          jobId: Number(entry.jobId),
          action: entry.action,
          actionLabel: QUEUE_ACTION_LABELS[entry.action] || entry.action,
          title: row?.title || row?.detected_title || `Job #${entry.jobId}`,
          status: row?.status || null,
          lastState: row?.last_state || null,
          hasScripts,
          hasChains
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

    const maxParallelJobs = await this.getMaxParallelJobs();
    const runningEncodeJobs = await historyService.getRunningEncodeJobs();
    const shouldQueue = this.queueEntries.length > 0 || runningEncodeJobs.length >= maxParallelJobs;
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
      let prepared = null;
      try {
        prepared = await scriptService.createExecutableScriptFile(script, { source: 'queue', scriptId: script.id, scriptName: script.name });
        const { spawn } = require('child_process');
        await new Promise((resolve, reject) => {
          const child = spawn(prepared.cmd, prepared.args, { env: process.env, stdio: 'ignore' });
          child.on('error', reject);
          child.on('close', (code) => {
            logger.info('queue:script:done', { scriptId: script.id, exitCode: code });
            resolve();
          });
        });
      } catch (err) {
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
        const firstEntry = this.queueEntries[0];
        const isNonJob = firstEntry?.type && firstEntry.type !== 'job';

        if (!isNonJob) {
          // Job entries: respect the parallel encode limit.
          const maxParallelJobs = await this.getMaxParallelJobs();
          const runningEncodeJobs = await historyService.getRunningEncodeJobs();
          if (runningEncodeJobs.length >= maxParallelJobs) {
            break;
          }
        }

        const entry = this.queueEntries.shift();
        if (!entry) {
          break;
        }

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
            this.queueEntries.unshift(entry);
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
      this.jobProgress.set(Number(patch.activeJobId), {
        state,
        progress: patch.progress ?? 0,
        eta: patch.eta ?? null,
        statusText: patch.statusText ?? null
      });
    } else if (patch.activeJobId === null && previousActiveJobId != null) {
      // Job slot cleared – remove the finished job's live entry so it falls
      // back to DB data in the frontend.
      this.jobProgress.delete(Number(previousActiveJobId));
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

  async updateProgress(stage, percent, eta, statusText, jobIdOverride = null) {
    const effectiveJobId = jobIdOverride != null ? Number(jobIdOverride) : this.snapshot.activeJobId;
    const effectiveProgress = percent ?? this.snapshot.progress;
    const effectiveEta = eta ?? this.snapshot.eta;
    const effectiveStatusText = statusText ?? this.snapshot.statusText;

    // Update per-job progress so concurrent jobs don't overwrite each other.
    if (effectiveJobId != null) {
      this.jobProgress.set(effectiveJobId, {
        state: stage,
        progress: effectiveProgress,
        eta: effectiveEta,
        statusText: effectiveStatusText
      });
    }

    // Only update the global snapshot fields when this update belongs to the
    // currently active job (avoids the snapshot jumping between parallel jobs).
    if (effectiveJobId === this.snapshot.activeJobId || effectiveJobId == null) {
      this.snapshot = {
        ...this.snapshot,
        state: stage,
        progress: effectiveProgress,
        eta: effectiveEta,
        statusText: effectiveStatusText
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
      statusText: effectiveStatusText
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
    if (keys.includes('pipeline_max_parallel_jobs')) {
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

    if (!job.raw_path || !fs.existsSync(job.raw_path)) {
      return {
        triggered: false,
        reason: 'raw_path_missing',
        relevantKeys,
        jobId: activeJobId,
        rawPath: job.raw_path || null
      };
    }

    const existingPlan = this.safeParseJson(job.encode_plan_json);
    const mode = existingPlan?.mode || this.snapshot.context?.mode || 'rip';
    const sourceJobId = existingPlan?.sourceJobId || this.snapshot.context?.sourceJobId || null;

    await historyService.appendLog(
      activeJobId,
      'SYSTEM',
      `Settings gespeichert (${relevantKeys.join(', ')}). Titel-/Spurprüfung wird mit aktueller Konfiguration neu gestartet.`
    );

    this.runReviewForRawJob(activeJobId, job.raw_path, { mode, sourceJobId }).catch((error) => {
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
    const mkInfo = this.safeParseJson(job.makemkv_info_json);
    const mediaProfile = this.resolveMediaProfileForJob(job, {
      mediaProfile: options?.mediaProfile,
      rawPath,
      makemkvInfo: mkInfo
    });
    const settings = await settingsService.getEffectiveSettingsMap(mediaProfile);
    const analyzeContext = mkInfo?.analyzeContext || {};
    let playlistAnalysis = analyzeContext.playlistAnalysis || this.snapshot.context?.playlistAnalysis || null;
    let handBrakePlaylistScan = normalizeHandBrakePlaylistScanCache(analyzeContext.handBrakePlaylistScan || null);
    if (playlistAnalysis && handBrakePlaylistScan) {
      playlistAnalysis = enrichPlaylistAnalysisWithHandBrakeCache(playlistAnalysis, handBrakePlaylistScan);
    }
    const selectedPlaylistSource = forcePlaylistReselection
      ? (options?.selectedPlaylist || null)
      : (options?.selectedPlaylist || analyzeContext.selectedPlaylist || this.snapshot.context?.selectedPlaylist || null);
    const selectedPlaylistId = normalizePlaylistId(
      selectedPlaylistSource
    );
    const selectedTitleSource = forcePlaylistReselection
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
          'HandBrake Trackdaten für Playlist-Auswahl werden vorbereitet'
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
        const recommendedLabel = candidate?.recommended ? ' (empfohlen)' : '';
        const evaluationLabel = candidate?.evaluationLabel ? ` | ${candidate.evaluationLabel}` : '';
        await historyService.appendLog(
          jobId,
          'SYSTEM',
          `${playlistFile} -> Score ${scoreLabel}${recommendedLabel}${evaluationLabel}`
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
    const hasCachedHandBrakeEntry = Boolean(
      cachedHandBrakePlaylistEntry
      && cachedHandBrakePlaylistEntry.titleInfo
      && Number.isFinite(Number(cachedHandBrakePlaylistEntry.handBrakeTitleId))
      && Number(cachedHandBrakePlaylistEntry.handBrakeTitleId) > 0
    );

    if (this.isPrimaryJob(jobId)) {
      await this.updateProgress(
        'MEDIAINFO_CHECK',
        30,
        null,
        hasCachedHandBrakeEntry
          ? `HandBrake Trackdaten aus Cache (${toPlaylistFile(resolvedPlaylistId) || resolvedPlaylistId})`
          : `HandBrake Titel-/Spurscan läuft (${toPlaylistFile(resolvedPlaylistId) || resolvedPlaylistId})`
      );
    }

    let handBrakeResolveRunInfo = null;
    let handBrakeTitleRunInfo = null;
    let resolvedHandBrakeTitleId = null;
    const reviewTitleSource = 'handbrake';
    let reviewTitleInfo = null;
    if (hasCachedHandBrakeEntry) {
      resolvedHandBrakeTitleId = Math.trunc(Number(cachedHandBrakePlaylistEntry.handBrakeTitleId));
      reviewTitleInfo = cachedHandBrakePlaylistEntry.titleInfo;
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

        resolvedHandBrakeTitleId = resolveHandBrakeTitleIdForPlaylist(resolveScanJson, resolvedPlaylistId);
        if (!resolvedHandBrakeTitleId) {
          const error = new Error(`Kein HandBrake-Titel für ${toPlaylistFile(resolvedPlaylistId)} gefunden.`);
          error.statusCode = 400;
          error.runInfo = handBrakeResolveRunInfo;
          throw error;
        }

        reviewTitleInfo = parseHandBrakeSelectedTitleInfo(resolveScanJson, {
          playlistId: resolvedPlaylistId,
          handBrakeTitleId: resolvedHandBrakeTitleId
        });
        if (!reviewTitleInfo) {
          const error = new Error(
            `HandBrake lieferte keine verwertbaren Trackdaten für ${toPlaylistFile(resolvedPlaylistId)} (-t ${resolvedHandBrakeTitleId}).`
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
    const normalizedTitles = (Array.isArray(review.titles) ? review.titles : [])
      .slice(0, 1)
      .map((title) => ({
        ...title,
        filePath: rawPath,
        fileName: reviewTitleInfo?.fileName || title?.fileName || `Title #${selectedTitleForReview}`,
        durationSeconds: Number(reviewTitleInfo?.durationSeconds || title?.durationSeconds || 0),
        durationMinutes: Number((((reviewTitleInfo?.durationSeconds || title?.durationSeconds || 0) / 60)).toFixed(2)),
        sizeBytes: Number(reviewTitleInfo?.sizeBytes || title?.sizeBytes || 0),
        playlistId: resolvedPlaylistInfo.playlistId || title?.playlistId || null,
        playlistFile: resolvedPlaylistInfo.playlistFile || title?.playlistFile || null,
        playlistRecommended: Boolean(resolvedPlaylistInfo.recommended || title?.playlistRecommended),
        playlistEvaluationLabel: resolvedPlaylistInfo.evaluationLabel || title?.playlistEvaluationLabel || null,
        playlistSegmentCommand: resolvedPlaylistInfo.segmentCommand || title?.playlistSegmentCommand || null,
        playlistSegmentFiles: Array.isArray(resolvedPlaylistInfo.segmentFiles) && resolvedPlaylistInfo.segmentFiles.length > 0
          ? resolvedPlaylistInfo.segmentFiles
          : (Array.isArray(title?.playlistSegmentFiles) ? title.playlistSegmentFiles : [])
      }));

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
      const renamedDirName = buildRawDirName(metadataBase, jobId, { incomplete: true });
      const renamedRawPath = path.join(settings.raw_dir, renamedDirName);
      if (existingRawPath !== renamedRawPath && !fs.existsSync(renamedRawPath)) {
        try {
          fs.renameSync(existingRawPath, renamedRawPath);
          updatedRawPath = renamedRawPath;
          await historyService.updateRawPathByOldPath(existingRawPath, renamedRawPath);
          logger.info('metadata:raw-dir-renamed', { from: existingRawPath, to: renamedRawPath, jobId });
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

    const job = await historyService.getJobById(jobId);
    if (!job) {
      const error = new Error(`Job ${jobId} nicht gefunden.`);
      error.statusCode = 404;
      throw error;
    }

    if (job.status !== 'READY_TO_ENCODE' && job.last_state !== 'READY_TO_ENCODE') {
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

    const normalizeChainIdList = (raw) => {
      const list = Array.isArray(raw) ? raw : [];
      return list.map(Number).filter((id) => Number.isFinite(id) && id > 0).map(Math.trunc);
    };

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
      reviewConfirmedAt: nowIso()
    };
    const inputPath = isPreRipMode
      ? null
      : (job.encode_input_path || confirmedPlan.encodeInputPath || this.snapshot.context?.inputPath || null);
    const hasEncodableTitle = isPreRipMode
      ? Boolean(confirmedPlan?.encodeInputTitleId)
      : Boolean(inputPath);

    await historyService.updateJob(jobId, {
      encode_review_confirmed: 1,
      encode_plan_json: JSON.stringify(confirmedPlan),
      encode_input_path: inputPath
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

    const reencodeSettings = await settingsService.getSettingsMap();
    const reencodeRawBaseDir = String(reencodeSettings?.raw_dir || '').trim();
    const resolvedReencodeRawPath = this.resolveCurrentRawPath(reencodeRawBaseDir, sourceJob.raw_path);
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
      await this.updateProgress('MEDIAINFO_CHECK', percent, null, `Mediainfo ${i + 1}/${mediaFiles.length}: ${path.basename(file.path)}`);

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

    const enrichedReview = {
      ...review,
      mode: options.mode || 'rip',
      mediaProfile,
      sourceJobId: options.sourceJobId || null,
      reviewConfirmed: false,
      partial: false,
      processedFiles: mediaFiles.length,
      totalFiles: mediaFiles.length
    };
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
          stage: 'ENCODING',
          source: 'PRE_ENCODE_SCRIPT',
          cmd: prepared.cmd,
          args: prepared.args,
          argsForLog: prepared.argsForLog
        });
        succeeded += 1;
        results.push({ scriptId: script.id, scriptName: script.name, status: 'SUCCESS', runInfo });
        await historyService.appendLog(jobId, 'SYSTEM', `Pre-Encode Skript erfolgreich: ${script.name}`);
        if (progressTracker?.onStepComplete) {
          await progressTracker.onStepComplete('pre', 'script', index + 1, scriptIds.length, script.name, true);
        }
      } catch (error) {
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
          stage: 'ENCODING',
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
        await historyService.appendLog(
          jobId,
          'SYSTEM',
          `Post-Encode Skript erfolgreich: ${script.name}`
        );
        if (progressTracker?.onStepComplete) {
          await progressTracker.onStepComplete('post', 'script', index + 1, scriptIds.length, script.name, true);
        }
      } catch (error) {
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
    const movieDir = settings.movie_dir;
    ensureDir(movieDir);
    const mode = encodePlan?.mode || this.snapshot.context?.mode || 'rip';
    let inputPath = job.encode_input_path || encodePlan?.encodeInputPath || this.snapshot.context?.inputPath || null;

    if (!inputPath && job.raw_path) {
      const playlistDecision = this.resolvePlaylistDecisionForJob(jobId, job);
      inputPath = findPreferredRawInput(job.raw_path, {
        playlistAnalysis: playlistDecision.playlistAnalysis,
        selectedPlaylistId: playlistDecision.selectedPlaylist
      })?.path || null;
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
      encode_input_path: inputPath
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
      rawPath: job.raw_path || null,
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
          handBrakeTitleId = resolveHandBrakeTitleIdForPlaylist(titleResolveParsed, selectedPlaylistId);
          if (!handBrakeTitleId) {
            const error = new Error(`Kein HandBrake-Titel für Playlist ${selectedPlaylistId}.mpls gefunden.`);
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
        settingsMap: settings
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
          rawPath: job.raw_path || null
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
      let finalizedRawPath = job.raw_path || null;
      if (job.raw_path) {
        const currentRawPath = String(job.raw_path || '').trim();
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
              `RAW-Ordner konnte nicht als abgeschlossen markiert werden (Ziel existiert bereits): ${completedRawPath}`
            );
          } else {
            try {
              fs.renameSync(currentRawPath, completedRawPath);
              await historyService.updateRawPathByOldPath(currentRawPath, completedRawPath);
              finalizedRawPath = completedRawPath;
              await historyService.appendLog(
                jobId,
                'SYSTEM',
                `RAW-Ordner als abgeschlossen markiert: ${currentRawPath} -> ${completedRawPath}`
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
                `RAW-Ordner konnte nicht als abgeschlossen markiert werden: ${rawRenameError.message}`
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
    const rawDirName = buildRawDirName(metadataBase, jobId, { incomplete: true });
    const rawJobDir = path.join(rawBaseDir, rawDirName);
    ensureDir(rawJobDir);
    chownRecursive(rawJobDir, settings.raw_dir_owner);
    logger.info('rip:raw-dir-created', { jobId, rawJobDir });

    const deviceCandidate = this.detectedDisc || this.snapshot.context?.device || {
      path: job.disc_device,
      index: Number(settings.makemkv_source_index || 0)
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

      const mkInfoBeforeRip = this.safeParseJson(job.makemkv_info_json);
      await historyService.updateJob(jobId, {
        makemkv_info_json: JSON.stringify(this.withAnalyzeContextMediaProfile({
          ...makemkvInfo,
          analyzeContext: mkInfoBeforeRip?.analyzeContext || null
        }, mediaProfile)),
        rip_successful: 1
      });

      // Rename Incomplete_ prefix away now that the rip is complete and successful.
      let activeRawJobDir = rawJobDir;
      const completedRawJobDir = buildCompletedRawPath(rawJobDir);
      if (completedRawJobDir && completedRawJobDir !== rawJobDir) {
        if (fs.existsSync(completedRawJobDir)) {
          logger.warn('rip:raw-complete:rename-skip', { jobId, rawJobDir, completedRawJobDir });
          await historyService.appendLog(
            jobId,
            'SYSTEM',
            `RAW-Ordner konnte nach Rip nicht umbenannt werden (Zielordner existiert): ${completedRawJobDir}`
          );
        } else {
          try {
            fs.renameSync(rawJobDir, completedRawJobDir);
            activeRawJobDir = completedRawJobDir;
            chownRecursive(activeRawJobDir, settings.raw_dir_owner);
            await historyService.updateRawPathByOldPath(rawJobDir, completedRawJobDir);
            await historyService.appendLog(
              jobId,
              'SYSTEM',
              `RAW-Ordner nach erfolgreichem Rip umbenannt: ${rawJobDir} → ${completedRawJobDir}`
            );
          } catch (renameError) {
            logger.warn('rip:raw-complete:rename-failed', {
              jobId,
              rawJobDir,
              completedRawJobDir,
              error: errorToMeta(renameError)
            });
            await historyService.appendLog(
              jobId,
              'SYSTEM',
              `RAW-Ordner konnte nach Rip nicht umbenannt werden: ${renameError.message}`
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

    const job = await historyService.getJobById(jobId);
    if (!job) {
      const error = new Error(`Job ${jobId} nicht gefunden.`);
      error.statusCode = 404;
      throw error;
    }

    if (!job.title && !job.detected_title) {
      const error = new Error('Retry nicht möglich: keine Metadaten vorhanden.');
      error.statusCode = 400;
      throw error;
    }

    await historyService.resetProcessLog(jobId);

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
      logger.error('retry:background-failed', { jobId, error: errorToMeta(error) });
    });

    return { started: true };
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
    const inputPath = isPreRipMode
      ? null
      : (job.encode_input_path || encodePlan?.encodeInputPath || null);
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

    return historyService.getJobById(jobId);
  }

  async restartEncodeWithLastSettings(jobId, options = {}) {
    const immediate = Boolean(options?.immediate);
    if (!immediate) {
      return this.enqueueOrStartAction(
        QUEUE_ACTIONS.RESTART_ENCODE,
        jobId,
        () => this.restartEncodeWithLastSettings(jobId, { ...options, immediate: true })
      );
    }

    this.ensureNotBusy('restartEncodeWithLastSettings', jobId);
    logger.info('restartEncodeWithLastSettings:requested', { jobId });
    this.cancelRequestedByJob.delete(Number(jobId));

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

    await historyService.updateJob(jobId, {
      status: 'READY_TO_ENCODE',
      last_state: 'READY_TO_ENCODE',
      error_message: null,
      end_time: null,
      output_path: null,
      handbrake_info_json: null
    });
    await historyService.appendLog(
      jobId,
      'USER_ACTION',
      previousOutputPath
        ? `Encode-Neustart angefordert. Letzte bestätigte Auswahl wird verwendet. Vorheriger Output-Pfad: ${previousOutputPath}. autoDeleteIncomplete=${restartDeleteIncompleteOutput ? 'on' : 'off'}`
        : 'Encode-Neustart angefordert. Letzte bestätigte Auswahl wird verwendet.'
    );

    const result = await this.startPreparedJob(jobId, { immediate: true });
    return {
      restarted: true,
      ...result
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

    const reviewSettings = await settingsService.getSettingsMap();
    const reviewRawBaseDir = String(reviewSettings?.raw_dir || '').trim();
    const resolvedReviewRawPath = this.resolveCurrentRawPath(reviewRawBaseDir, sourceJob.raw_path);
    if (!resolvedReviewRawPath) {
      const error = new Error(`Review-Neustart nicht möglich: RAW-Pfad existiert nicht (${sourceJob.raw_path}).`);
      error.statusCode = 400;
      throw error;
    }

    const hasRawInput = Boolean(
      hasBluRayBackupStructure(resolvedReviewRawPath)
      || findPreferredRawInput(resolvedReviewRawPath)
    );
    if (!hasRawInput) {
      const error = new Error('Review-Neustart nicht möglich: keine Mediendateien im RAW-Pfad gefunden. Disc muss zuerst gerippt werden.');
      error.statusCode = 400;
      throw error;
    }

    const currentStatus = String(sourceJob.status || '').trim().toUpperCase();
    if (['ANALYZING', 'RIPPING', 'MEDIAINFO_CHECK', 'ENCODING'].includes(currentStatus)) {
      const error = new Error(`Review-Neustart nicht möglich: Job ${jobId} ist noch aktiv (${currentStatus}).`);
      error.statusCode = 409;
      throw error;
    }

    const staleQueueIndex = this.findQueueEntryIndexByJobId(Number(jobId));
    if (staleQueueIndex >= 0) {
      const [removed] = this.queueEntries.splice(staleQueueIndex, 1);
      await historyService.appendLog(
        jobId,
        'USER_ACTION',
        `Queue-Eintrag entfernt (Review-Neustart): ${QUEUE_ACTION_LABELS[removed?.action] || removed?.action || 'Aktion'}`
      );
      await this.emitQueueChanged();
    }

    await historyService.resetProcessLog(jobId);

    const forcePlaylistReselection = Boolean(options?.forcePlaylistReselection);
    const mkInfo = this.safeParseJson(sourceJob.makemkv_info_json);
    const nextMakemkvInfoJson = mkInfo && typeof mkInfo === 'object'
      ? JSON.stringify({
        ...mkInfo,
        analyzeContext: forcePlaylistReselection
          ? {
            ...(mkInfo?.analyzeContext || {}),
            selectedPlaylist: null,
            selectedTitleId: null
          }
          : (mkInfo?.analyzeContext || null)
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
      encode_input_path: null,
      encode_review_confirmed: 0,
      makemkv_info_json: nextMakemkvInfoJson
    };
    if (resolvedReviewRawPath !== sourceJob.raw_path) {
      jobUpdatePayload.raw_path = resolvedReviewRawPath;
    }
    await historyService.updateJob(jobId, jobUpdatePayload);
    await historyService.appendLog(
      jobId,
      'USER_ACTION',
      `Review-Neustart aus RAW angefordert.${forcePlaylistReselection ? ' Playlist-Auswahl wird zurückgesetzt.' : ''}`
    );

    await this.setState('MEDIAINFO_CHECK', {
      activeJobId: jobId,
      progress: 0,
      eta: null,
      statusText: 'Titel-/Spurprüfung wird neu gestartet...',
      context: {
        ...(this.snapshot.context || {}),
        jobId,
        reviewConfirmed: false,
        mediaInfoReview: null
      }
    });

    this.runReviewForRawJob(jobId, resolvedReviewRawPath, {
      mode: options?.mode || 'reencode',
      sourceJobId: jobId,
      forcePlaylistReselection
    }).catch((error) => {
      logger.error('restartReviewFromRaw:background-failed', { jobId, error: errorToMeta(error) });
      this.failJob(jobId, 'MEDIAINFO_CHECK', error).catch((failError) => {
        logger.error('restartReviewFromRaw:background-failJob-failed', {
          jobId,
          error: errorToMeta(failError)
        });
      });
    });

    return {
      restarted: true,
      started: true,
      stage: 'MEDIAINFO_CHECK',
      jobId
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

    const processHandle = this.activeProcesses.get(normalizedJobId) || null;
    if (!processHandle) {
      const runningJob = await historyService.getJobById(normalizedJobId);
      const status = String(runningJob?.status || '').trim().toUpperCase();

      if (status === 'READY_TO_ENCODE') {
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

      if (['ANALYZING', 'RIPPING', 'MEDIAINFO_CHECK', 'ENCODING'].includes(status)) {
        this.cancelRequestedByJob.add(normalizedJobId);
        await historyService.appendLog(
          normalizedJobId,
          'USER_ACTION',
          'Abbruch angefordert. Wird beim nächsten Prozessschritt angewendet.'
        );
        return {
          cancelled: true,
          queuedOnly: false,
          pending: true,
          jobId: normalizedJobId
        };
      }

      const error = new Error(`Kein laufender Prozess für Job #${normalizedJobId} zum Abbrechen.`);
      error.statusCode = 409;
      throw error;
    }

    logger.warn('cancel:requested', {
      state: this.snapshot.state,
      activeJobId: this.snapshot.activeJobId,
      requestedJobId: normalizedJobId
    });
    this.cancelRequestedByJob.add(normalizedJobId);
    processHandle.cancel();
    return {
      cancelled: true,
      queuedOnly: false,
      jobId: normalizedJobId
    };
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
      await historyService.closeProcessLog(jobId);
      this.activeProcesses.delete(Number(normalizedJobId));
      this.syncPrimaryActiveProcess();
      this.cancelRequestedByJob.delete(Number(normalizedJobId));
      await this.emitQueueChanged();
      void this.pumpQueue();
    }
  }

  async failJob(jobId, stage, error) {
    const message = error?.message || String(error);
    const isCancelled = /abgebrochen|cancelled/i.test(message)
      || String(error?.runInfo?.status || '').trim().toUpperCase() === 'CANCELLED';
    const job = await historyService.getJobById(jobId);
    const title = job?.title || job?.detected_title || `Job #${jobId}`;
    const finalState = isCancelled ? 'CANCELLED' : 'ERROR';
    logger[isCancelled ? 'warn' : 'error']('job:failed', { jobId, stage, error: errorToMeta(error) });
    const encodePlan = this.safeParseJson(job?.encode_plan_json);
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

    await this.setState(finalState, {
      activeJobId: jobId,
      progress: this.snapshot.progress,
      eta: null,
      statusText: message,
      context: {
        jobId,
        stage,
        error: message,
        rawPath: job?.raw_path || null,
        inputPath: job?.encode_input_path || encodePlan?.encodeInputPath || null,
        selectedMetadata: {
          title: job?.title || job?.detected_title || null,
          year: job?.year || null,
          imdbId: job?.imdb_id || null,
          poster: job?.poster_url || null
        },
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

}

module.exports = new PipelineService();
