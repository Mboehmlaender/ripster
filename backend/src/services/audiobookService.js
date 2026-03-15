const path = require('path');
const { sanitizeFileName } = require('../utils/files');

const SUPPORTED_INPUT_EXTENSIONS = new Set(['.aax']);
const SUPPORTED_OUTPUT_FORMATS = new Set(['m4b', 'mp3', 'flac']);
const DEFAULT_AUDIOBOOK_RAW_TEMPLATE = '{author} - {title} ({year})';
const DEFAULT_AUDIOBOOK_OUTPUT_TEMPLATE = '{author}/{author} - {title} ({year})';
const DEFAULT_AUDIOBOOK_CHAPTER_OUTPUT_TEMPLATE = '{author}/{author} - {title} ({year})/{chapterNr} {chapterTitle}';
const AUDIOBOOK_FORMAT_DEFAULTS = {
  m4b: {},
  flac: {
    flacCompression: 5
  },
  mp3: {
    mp3Mode: 'cbr',
    mp3Bitrate: 192,
    mp3Quality: 4
  }
};

function normalizeText(value) {
  return String(value || '')
    .normalize('NFC')
    .replace(/[♥❤♡❥❣❦❧]/gu, ' ')
    .replace(/\p{C}+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseOptionalYear(value) {
  const text = normalizeText(value);
  if (!text) {
    return null;
  }
  const match = text.match(/\b(19|20)\d{2}\b/);
  if (!match) {
    return null;
  }
  return Number(match[0]);
}

function parseOptionalNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseTimebaseToSeconds(value) {
  const raw = String(value || '').trim();
  if (!raw) {
    return null;
  }
  if (/^\d+\/\d+$/u.test(raw)) {
    const [num, den] = raw.split('/').map(Number);
    if (Number.isFinite(num) && Number.isFinite(den) && den !== 0) {
      return num / den;
    }
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function secondsToMs(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return null;
  }
  return Math.max(0, Math.round(parsed * 1000));
}

function ticksToMs(value, timebase) {
  const ticks = Number(value);
  const factor = parseTimebaseToSeconds(timebase);
  if (!Number.isFinite(ticks) || ticks < 0 || !Number.isFinite(factor) || factor <= 0) {
    return null;
  }
  return Math.max(0, Math.round(ticks * factor * 1000));
}

function normalizeOutputFormat(value) {
  const format = String(value || '').trim().toLowerCase();
  return SUPPORTED_OUTPUT_FORMATS.has(format) ? format : 'mp3';
}

function clonePlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? { ...value } : {};
}

function clampInteger(value, min, max, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.trunc(parsed)));
}

function getDefaultFormatOptions(format) {
  const normalizedFormat = normalizeOutputFormat(format);
  return clonePlainObject(AUDIOBOOK_FORMAT_DEFAULTS[normalizedFormat]);
}

function normalizeFormatOptions(format, formatOptions = {}) {
  const normalizedFormat = normalizeOutputFormat(format);
  const source = clonePlainObject(formatOptions);
  const defaults = getDefaultFormatOptions(normalizedFormat);

  if (normalizedFormat === 'flac') {
    return {
      flacCompression: clampInteger(source.flacCompression, 0, 8, defaults.flacCompression)
    };
  }

  if (normalizedFormat === 'mp3') {
    const mp3Mode = String(source.mp3Mode || defaults.mp3Mode || 'cbr').trim().toLowerCase() === 'vbr'
      ? 'vbr'
      : 'cbr';
    const allowedBitrates = new Set([128, 160, 192, 256, 320]);
    const normalizedBitrate = clampInteger(source.mp3Bitrate, 96, 320, defaults.mp3Bitrate);
    return {
      mp3Mode,
      mp3Bitrate: allowedBitrates.has(normalizedBitrate) ? normalizedBitrate : defaults.mp3Bitrate,
      mp3Quality: clampInteger(source.mp3Quality, 0, 9, defaults.mp3Quality)
    };
  }

  return {};
}

function normalizeInputExtension(filePath) {
  return path.extname(String(filePath || '')).trim().toLowerCase();
}

function isSupportedInputFile(filePath) {
  return SUPPORTED_INPUT_EXTENSIONS.has(normalizeInputExtension(filePath));
}

function normalizeTagMap(tags = null) {
  const source = tags && typeof tags === 'object' ? tags : {};
  const result = {};
  for (const [key, value] of Object.entries(source)) {
    const normalizedKey = String(key || '').trim().toLowerCase();
    if (!normalizedKey) {
      continue;
    }
    const normalizedValue = normalizeText(value);
    if (!normalizedValue) {
      continue;
    }
    result[normalizedKey] = normalizedValue;
  }
  return result;
}

function pickTag(tags, keys = []) {
  const normalized = normalizeTagMap(tags);
  for (const key of keys) {
    const value = normalized[String(key || '').trim().toLowerCase()];
    if (value) {
      return value;
    }
  }
  return null;
}

function sanitizeTemplateValue(value, fallback = '') {
  const normalized = normalizeText(value);
  if (!normalized) {
    return fallback;
  }
  return sanitizeFileName(normalized);
}

function normalizeChapterTitle(value, index) {
  const normalized = normalizeText(value);
  return normalized || `Kapitel ${index}`;
}

function buildChapterList(probe = null) {
  const chapters = Array.isArray(probe?.chapters) ? probe.chapters : [];
  return chapters.map((chapter, index) => {
    const chapterIndex = index + 1;
    const tags = normalizeTagMap(chapter?.tags);
    const startSeconds = parseOptionalNumber(chapter?.start_time);
    const endSeconds = parseOptionalNumber(chapter?.end_time);
    const startMs = secondsToMs(startSeconds) ?? ticksToMs(chapter?.start, chapter?.time_base) ?? 0;
    const endMs = secondsToMs(endSeconds) ?? ticksToMs(chapter?.end, chapter?.time_base) ?? 0;
    const title = normalizeChapterTitle(tags.title || tags.chapter, chapterIndex);
    return {
      index: chapterIndex,
      title,
      startSeconds: Number((startMs / 1000).toFixed(3)),
      endSeconds: Number((endMs / 1000).toFixed(3)),
      startMs,
      endMs,
      timeBase: String(chapter?.time_base || '').trim() || null
    };
  });
}

function normalizeChapterList(chapters = [], options = {}) {
  const source = Array.isArray(chapters) ? chapters : [];
  const durationMs = Number(options?.durationMs || 0);
  const fallbackTitle = normalizeText(options?.fallbackTitle || '');
  const createFallback = options?.createFallback === true;

  const normalized = source.map((chapter, index) => {
    const chapterIndex = Number(chapter?.index);
    const safeIndex = Number.isFinite(chapterIndex) && chapterIndex > 0
      ? Math.trunc(chapterIndex)
      : index + 1;
    const rawStartMs = parseOptionalNumber(chapter?.startMs)
      ?? secondsToMs(chapter?.startSeconds)
      ?? ticksToMs(chapter?.start, chapter?.timeBase || chapter?.time_base)
      ?? 0;
    const rawEndMs = parseOptionalNumber(chapter?.endMs)
      ?? secondsToMs(chapter?.endSeconds)
      ?? ticksToMs(chapter?.end, chapter?.timeBase || chapter?.time_base)
      ?? 0;
    return {
      index: safeIndex,
      title: normalizeChapterTitle(chapter?.title, safeIndex),
      startMs: Math.max(0, rawStartMs),
      endMs: Math.max(0, rawEndMs)
    };
  });

  const repaired = normalized.map((chapter, index) => {
    const nextStartMs = normalized[index + 1]?.startMs ?? null;
    let endMs = chapter.endMs;
    if (!(endMs > chapter.startMs)) {
      if (Number.isFinite(nextStartMs) && nextStartMs > chapter.startMs) {
        endMs = nextStartMs;
      } else if (durationMs > chapter.startMs) {
        endMs = durationMs;
      } else {
        endMs = chapter.startMs;
      }
    }
    return {
      ...chapter,
      endMs,
      startSeconds: Number((chapter.startMs / 1000).toFixed(3)),
      endSeconds: Number((endMs / 1000).toFixed(3)),
      durationMs: Math.max(0, endMs - chapter.startMs)
    };
  }).filter((chapter) => chapter.endMs > chapter.startMs || normalized.length === 1);

  if (repaired.length > 0) {
    return repaired;
  }

  if (createFallback && durationMs > 0) {
    return [{
      index: 1,
      title: fallbackTitle || 'Kapitel 1',
      startMs: 0,
      endMs: durationMs,
      startSeconds: 0,
      endSeconds: Number((durationMs / 1000).toFixed(3)),
      durationMs
    }];
  }

  return [];
}

function looksLikeDescription(value) {
  const normalized = normalizeText(value);
  if (!normalized) {
    return false;
  }
  return normalized.length >= 120 || /[.!?]\s/u.test(normalized);
}

function detectCoverStream(probe = null) {
  const streams = Array.isArray(probe?.streams) ? probe.streams : [];
  for (const stream of streams) {
    const codecType = String(stream?.codec_type || '').trim().toLowerCase();
    const codecName = String(stream?.codec_name || '').trim().toLowerCase();
    const dispositionAttachedPic = Number(stream?.disposition?.attached_pic || 0) === 1;
    const mimetype = String(stream?.tags?.mimetype || '').trim().toLowerCase();
    const looksLikeImageStream = codecType === 'video'
      && (dispositionAttachedPic || mimetype.startsWith('image/') || ['jpeg', 'jpg', 'png', 'mjpeg'].includes(codecName));

    if (!looksLikeImageStream) {
      continue;
    }

    const streamIndex = Number(stream?.index);
    return {
      streamIndex: Number.isFinite(streamIndex) ? Math.trunc(streamIndex) : 0,
      codecName: codecName || null,
      mimetype: mimetype || null,
      attachedPic: dispositionAttachedPic
    };
  }
  return null;
}

function parseProbeOutput(rawOutput) {
  if (!rawOutput) {
    return null;
  }
  try {
    return JSON.parse(rawOutput);
  } catch (_error) {
    return null;
  }
}

function buildMetadataFromProbe(probe = null, originalName = null) {
  const format = probe?.format && typeof probe.format === 'object' ? probe.format : {};
  const tags = normalizeTagMap(format.tags);
  const originalBaseName = path.basename(String(originalName || ''), path.extname(String(originalName || '')));
  const fallbackTitle = normalizeText(originalBaseName) || 'Audiobook';
  const title = pickTag(tags, ['title', 'album']) || fallbackTitle;
  const author = pickTag(tags, ['author', 'artist', 'writer', 'album_artist', 'composer']) || 'Unknown Author';
  const description = pickTag(tags, [
    'description',
    'synopsis',
    'summary',
    'long_description',
    'longdescription',
    'publisher_summary',
    'publishersummary',
    'comment'
  ]) || null;
  let narrator = pickTag(tags, ['narrator', 'performer', 'album_artist']) || null;
  if (narrator && (narrator === author || narrator === description || looksLikeDescription(narrator))) {
    narrator = null;
  }
  const series = pickTag(tags, ['series', 'grouping', 'series_title', 'show']) || null;
  const part = pickTag(tags, ['part', 'part_number', 'disc', 'discnumber', 'volume']) || null;
  const year = parseOptionalYear(pickTag(tags, ['date', 'year', 'creation_time']));
  const durationSeconds = Number(format.duration || 0);
  const durationMs = Number.isFinite(durationSeconds) && durationSeconds > 0
    ? Math.round(durationSeconds * 1000)
    : 0;
  const chapters = normalizeChapterList(buildChapterList(probe), {
    durationMs,
    fallbackTitle: title,
    createFallback: false
  });
  const cover = detectCoverStream(probe);
  return {
    title,
    author,
    narrator,
    description,
    series,
    part,
    year,
    album: title,
    artist: author,
    durationMs,
    chapters,
    cover,
    hasEmbeddedCover: Boolean(cover),
    tags
  };
}

function normalizeTemplateTokenKey(rawKey) {
  const key = String(rawKey || '').trim().toLowerCase();
  if (!key) {
    return '';
  }
  if (key === 'artist') {
    return 'author';
  }
  if (key === 'chapternr' || key === 'chapternumberpadded' || key === 'chapternopadded') {
    return 'chapterNr';
  }
  if (key === 'chapterno' || key === 'chapternumber' || key === 'chapternum') {
    return 'chapterNo';
  }
  if (key === 'chaptertitle') {
    return 'chapterTitle';
  }
  return key;
}

function cleanupRenderedTemplate(value) {
  return String(value || '')
    .replace(/\(\s*\)/g, '')
    .replace(/\[\s*]/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function renderTemplate(template, values) {
  const source = String(template || DEFAULT_AUDIOBOOK_OUTPUT_TEMPLATE).trim()
    || DEFAULT_AUDIOBOOK_OUTPUT_TEMPLATE;
  const rendered = source.replace(/\$\{([^}]+)\}|\{([^{}]+)\}/g, (_, keyA, keyB) => {
    const normalizedKey = normalizeTemplateTokenKey(keyA || keyB);
    const rawValue = values?.[normalizedKey];
    if (rawValue === undefined || rawValue === null || rawValue === '') {
      return '';
    }
    return String(rawValue);
  });
  return cleanupRenderedTemplate(rendered);
}

function buildTemplateValues(metadata = {}, format = null, chapter = null) {
  const chapterIndex = Number(chapter?.index || chapter?.chapterNo || 0);
  const safeChapterIndex = Number.isFinite(chapterIndex) && chapterIndex > 0 ? Math.trunc(chapterIndex) : 1;
  const author = sanitizeTemplateValue(metadata.author || metadata.artist || 'Unknown Author', 'Unknown Author');
  const title = sanitizeTemplateValue(metadata.title || metadata.album || 'Unknown Audiobook', 'Unknown Audiobook');
  const narrator = sanitizeTemplateValue(metadata.narrator || '');
  const series = sanitizeTemplateValue(metadata.series || '');
  const part = sanitizeTemplateValue(metadata.part || '');
  const chapterTitle = sanitizeTemplateValue(chapter?.title || `Kapitel ${safeChapterIndex}`, `Kapitel ${safeChapterIndex}`);
  const year = metadata.year ? String(metadata.year) : '';
  return {
    author,
    title,
    narrator,
    series,
    part,
    year,
    format: format ? String(format).trim().toLowerCase() : '',
    chapterNr: String(safeChapterIndex).padStart(2, '0'),
    chapterNo: String(safeChapterIndex),
    chapterTitle
  };
}

function splitRenderedPath(value) {
  return String(value || '')
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .replace(/^\/+|\/+$/g, '')
    .split('/')
    .map((segment) => sanitizeFileName(segment))
    .filter(Boolean);
}

function resolveTemplatePathParts(template, values, fallbackBaseName) {
  const rendered = renderTemplate(template, values);
  const parts = splitRenderedPath(rendered);
  if (parts.length === 0) {
    return {
      folderParts: [],
      baseName: sanitizeFileName(fallbackBaseName || 'untitled')
    };
  }
  return {
    folderParts: parts.slice(0, -1),
    baseName: parts[parts.length - 1]
  };
}

function buildRawStoragePaths(metadata, jobId, rawBaseDir, rawTemplate = DEFAULT_AUDIOBOOK_RAW_TEMPLATE, inputFileName = 'input.aax') {
  const ext = normalizeInputExtension(inputFileName) || '.aax';
  const values = buildTemplateValues(metadata);
  const fallbackBaseName = path.basename(String(inputFileName || 'input.aax'), ext);
  const { folderParts, baseName } = resolveTemplatePathParts(rawTemplate, values, fallbackBaseName);
  const rawDirName = `${baseName} - RAW - job-${jobId}`;
  const rawDir = path.join(String(rawBaseDir || ''), ...folderParts, rawDirName);
  const rawFilePath = path.join(rawDir, `${baseName}${ext}`);
  return {
    rawDir,
    rawFilePath,
    rawFileName: `${baseName}${ext}`,
    rawDirName
  };
}

function buildOutputPath(metadata, movieBaseDir, outputTemplate = DEFAULT_AUDIOBOOK_OUTPUT_TEMPLATE, outputFormat = 'mp3') {
  const normalizedFormat = normalizeOutputFormat(outputFormat);
  const values = buildTemplateValues(metadata, normalizedFormat);
  const fallbackBaseName = values.title || 'audiobook';
  const { folderParts, baseName } = resolveTemplatePathParts(outputTemplate, values, fallbackBaseName);
  return path.join(String(movieBaseDir || ''), ...folderParts, `${baseName}.${normalizedFormat}`);
}

function findCommonDirectory(paths = []) {
  const segmentsList = (Array.isArray(paths) ? paths : [])
    .map((entry) => String(entry || '').trim())
    .filter(Boolean)
    .map((entry) => path.resolve(entry).split(path.sep).filter((segment, index, list) => !(index === 0 && list[0] === '')));

  if (segmentsList.length === 0) {
    return null;
  }

  const common = [...segmentsList[0]];
  for (let index = 1; index < segmentsList.length; index += 1) {
    const next = segmentsList[index];
    let matchLength = 0;
    while (matchLength < common.length && matchLength < next.length && common[matchLength] === next[matchLength]) {
      matchLength += 1;
    }
    common.length = matchLength;
    if (common.length === 0) {
      break;
    }
  }

  if (common.length === 0) {
    return null;
  }

  return path.join(path.sep, ...common);
}

function buildChapterOutputPlan(
  metadata,
  chapters,
  movieBaseDir,
  chapterTemplate = DEFAULT_AUDIOBOOK_CHAPTER_OUTPUT_TEMPLATE,
  outputFormat = 'mp3'
) {
  const normalizedFormat = normalizeOutputFormat(outputFormat);
  const normalizedChapters = normalizeChapterList(chapters, {
    durationMs: metadata?.durationMs,
    fallbackTitle: metadata?.title || metadata?.album || 'Audiobook',
    createFallback: true
  });
  const outputFiles = normalizedChapters.map((chapter, index) => {
    const values = buildTemplateValues(metadata, normalizedFormat, chapter);
    const fallbackBaseName = `${values.chapterNr} ${values.chapterTitle}`.trim() || `Kapitel ${index + 1}`;
    const { folderParts, baseName } = resolveTemplatePathParts(chapterTemplate, values, fallbackBaseName);
    const outputPath = path.join(String(movieBaseDir || ''), ...folderParts, `${baseName}.${normalizedFormat}`);
    return {
      chapter,
      outputPath
    };
  });
  const outputDir = findCommonDirectory(outputFiles.map((entry) => path.dirname(entry.outputPath)))
    || String(movieBaseDir || '').trim()
    || '.';

  return {
    outputDir,
    outputFiles,
    chapters: normalizedChapters,
    format: normalizedFormat
  };
}

function buildProbeCommand(ffprobeCommand, inputPath) {
  const cmd = String(ffprobeCommand || 'ffprobe').trim() || 'ffprobe';
  return {
    cmd,
    args: [
      '-v', 'quiet',
      '-print_format', 'json',
      '-show_format',
      '-show_streams',
      '-show_chapters',
      inputPath
    ]
  };
}

function pushMetadataArg(args, key, value) {
  const normalizedKey = String(key || '').trim();
  const normalizedValue = normalizeText(value);
  if (!normalizedKey || !normalizedValue) {
    return;
  }
  args.push('-metadata', `${normalizedKey}=${normalizedValue}`);
}

function buildMetadataArgs(metadata = {}, options = {}) {
  const source = metadata && typeof metadata === 'object' ? metadata : {};
  const titleOverride = normalizeText(options?.title || '');
  const albumOverride = normalizeText(options?.album || '');
  const trackNo = Number(options?.trackNo || 0);
  const trackTotal = Number(options?.trackTotal || 0);
  const args = [];
  const bookTitle = normalizeText(source.title || source.album || '');
  const author = normalizeText(source.author || source.artist || '');

  pushMetadataArg(args, 'title', titleOverride || bookTitle);
  pushMetadataArg(args, 'album', albumOverride || bookTitle);
  pushMetadataArg(args, 'artist', author);
  pushMetadataArg(args, 'album_artist', author);
  pushMetadataArg(args, 'author', author);
  pushMetadataArg(args, 'narrator', source.narrator);
  pushMetadataArg(args, 'performer', source.narrator);
  pushMetadataArg(args, 'grouping', source.series);
  pushMetadataArg(args, 'series', source.series);
  pushMetadataArg(args, 'disc', source.part);
  pushMetadataArg(args, 'description', source.description);
  pushMetadataArg(args, 'comment', source.description);
  if (source.year) {
    pushMetadataArg(args, 'date', String(source.year));
    pushMetadataArg(args, 'year', String(source.year));
  }
  if (Number.isFinite(trackNo) && trackNo > 0) {
    const formattedTrack = Number.isFinite(trackTotal) && trackTotal > 0
      ? `${Math.trunc(trackNo)}/${Math.trunc(trackTotal)}`
      : String(Math.trunc(trackNo));
    pushMetadataArg(args, 'track', formattedTrack);
  }
  return args;
}

function buildCodecArgs(format, normalizedOptions) {
  if (format === 'm4b') {
    return ['-c:a', 'copy'];
  }
  if (format === 'flac') {
    return ['-codec:a', 'flac', '-compression_level', String(normalizedOptions.flacCompression)];
  }
  if (normalizedOptions.mp3Mode === 'vbr') {
    return ['-codec:a', 'libmp3lame', '-q:a', String(normalizedOptions.mp3Quality)];
  }
  return ['-codec:a', 'libmp3lame', '-b:a', `${normalizedOptions.mp3Bitrate}k`];
}

function buildEncodeCommand(ffmpegCommand, inputPath, outputPath, outputFormat = 'mp3', formatOptions = {}, options = {}) {
  const cmd = String(ffmpegCommand || 'ffmpeg').trim() || 'ffmpeg';
  const format = normalizeOutputFormat(outputFormat);
  const normalizedOptions = normalizeFormatOptions(format, formatOptions);
  const extra = options && typeof options === 'object' ? options : {};
  const commonArgs = [
    '-y',
    '-i', inputPath
  ];
  if (extra.chapterMetadataPath) {
    commonArgs.push('-f', 'ffmetadata', '-i', extra.chapterMetadataPath);
  }
  commonArgs.push(
    '-map', '0:a:0?',
    '-map_metadata', '0',
    '-map_chapters', extra.chapterMetadataPath ? '1' : '0',
    '-vn',
    '-sn',
    '-dn'
  );
  const metadataArgs = buildMetadataArgs(extra.metadata, extra.metadataOptions);
  const codecArgs = buildCodecArgs(format, normalizedOptions);
  return {
    cmd,
    args: [...commonArgs, ...codecArgs, ...metadataArgs, outputPath],
    metadataArgs,
    formatOptions: normalizedOptions
  };
}

function formatSecondsArg(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return '0';
  }
  return parsed.toFixed(3).replace(/\.?0+$/u, '');
}

function buildChapterEncodeCommand(
  ffmpegCommand,
  inputPath,
  outputPath,
  outputFormat = 'mp3',
  formatOptions = {},
  metadata = {},
  chapter = {},
  chapterTotal = 1
) {
  const cmd = String(ffmpegCommand || 'ffmpeg').trim() || 'ffmpeg';
  const format = normalizeOutputFormat(outputFormat);
  const normalizedOptions = normalizeFormatOptions(format, formatOptions);
  const safeChapter = normalizeChapterList([chapter], {
    durationMs: metadata?.durationMs,
    fallbackTitle: metadata?.title || 'Kapitel',
    createFallback: true
  })[0];
  const durationSeconds = Number(((safeChapter?.durationMs || 0) / 1000).toFixed(3));
  const metadataArgs = buildMetadataArgs(metadata, {
    title: safeChapter?.title,
    album: metadata?.title || metadata?.album || null,
    trackNo: safeChapter?.index || 1,
    trackTotal: chapterTotal
  });
  const codecArgs = buildCodecArgs(format, normalizedOptions);
  return {
    cmd,
    args: [
      '-y',
      '-i', inputPath,
      '-ss', formatSecondsArg(safeChapter?.startSeconds),
      '-t', formatSecondsArg(durationSeconds),
      '-map', '0:a:0?',
      '-map_metadata', '-1',
      '-map_chapters', '-1',
      '-vn',
      '-sn',
      '-dn',
      ...codecArgs,
      ...metadataArgs,
      outputPath
    ],
    metadataArgs,
    formatOptions: normalizedOptions
  };
}

function escapeFfmetadataValue(value) {
  return String(value == null ? '' : value)
    .replace(/\\/g, '\\\\')
    .replace(/=/g, '\\=')
    .replace(/;/g, '\\;')
    .replace(/#/g, '\\#')
    .replace(/\r?\n/g, ' ');
}

function buildChapterMetadataContent(chapters = [], metadata = {}) {
  const normalizedChapters = normalizeChapterList(chapters, {
    durationMs: metadata?.durationMs,
    fallbackTitle: metadata?.title || metadata?.album || 'Audiobook',
    createFallback: true
  });

  const chapterBlocks = normalizedChapters.map((chapter) => {
    const startMs = Math.max(0, Math.round(chapter.startMs || 0));
    const endMs = Math.max(startMs, Math.round(chapter.endMs || startMs));
    return [
      '[CHAPTER]',
      'TIMEBASE=1/1000',
      `START=${startMs}`,
      `END=${endMs}`,
      `title=${escapeFfmetadataValue(chapter.title || `Kapitel ${chapter.index || 1}`)}`
    ].join('\n');
  }).join('\n\n');

  return `;FFMETADATA1\n\n${chapterBlocks}`;
}

function buildCoverExtractionCommand(ffmpegCommand, inputPath, outputPath, cover = null) {
  const cmd = String(ffmpegCommand || 'ffmpeg').trim() || 'ffmpeg';
  const streamIndex = Number(cover?.streamIndex);
  const streamSpecifier = Number.isFinite(streamIndex) && streamIndex >= 0
    ? `0:${Math.trunc(streamIndex)}`
    : '0:v:0';
  return {
    cmd,
    args: [
      '-y',
      '-i', inputPath,
      '-map', streamSpecifier,
      '-an',
      '-sn',
      '-dn',
      '-frames:v', '1',
      '-c:v', 'mjpeg',
      '-q:v', '2',
      outputPath
    ]
  };
}

function parseFfmpegTimestampToMs(rawValue) {
  const value = String(rawValue || '').trim();
  const match = value.match(/^(\d+):(\d{2}):(\d{2})(?:\.(\d+))?$/);
  if (!match) {
    return null;
  }
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  const fraction = match[4] ? Number(`0.${match[4]}`) : 0;
  if (!Number.isFinite(hours) || !Number.isFinite(minutes) || !Number.isFinite(seconds)) {
    return null;
  }
  return Math.round((((hours * 60) + minutes) * 60 + seconds + fraction) * 1000);
}

function buildProgressParser(totalDurationMs) {
  const durationMs = Number(totalDurationMs || 0);
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    return null;
  }
  return (line) => {
    const match = String(line || '').match(/time=(\d+:\d{2}:\d{2}(?:\.\d+)?)/i);
    if (!match) {
      return null;
    }
    const currentMs = parseFfmpegTimestampToMs(match[1]);
    if (!Number.isFinite(currentMs)) {
      return null;
    }
    const percent = Math.max(0, Math.min(100, Number(((currentMs / durationMs) * 100).toFixed(2))));
    return {
      percent,
      eta: null
    };
  };
}

module.exports = {
  SUPPORTED_INPUT_EXTENSIONS,
  SUPPORTED_OUTPUT_FORMATS,
  DEFAULT_AUDIOBOOK_RAW_TEMPLATE,
  DEFAULT_AUDIOBOOK_OUTPUT_TEMPLATE,
  DEFAULT_AUDIOBOOK_CHAPTER_OUTPUT_TEMPLATE,
  AUDIOBOOK_FORMAT_DEFAULTS,
  normalizeOutputFormat,
  getDefaultFormatOptions,
  normalizeFormatOptions,
  isSupportedInputFile,
  buildMetadataFromProbe,
  normalizeChapterList,
  buildRawStoragePaths,
  buildOutputPath,
  buildChapterOutputPlan,
  buildProbeCommand,
  parseProbeOutput,
  buildEncodeCommand,
  buildChapterEncodeCommand,
  buildChapterMetadataContent,
  buildCoverExtractionCommand,
  buildProgressParser
};
