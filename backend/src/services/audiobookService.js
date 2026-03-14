const path = require('path');
const { sanitizeFileName } = require('../utils/files');

const SUPPORTED_INPUT_EXTENSIONS = new Set(['.aax']);
const SUPPORTED_OUTPUT_FORMATS = new Set(['m4b', 'mp3', 'flac']);
const DEFAULT_AUDIOBOOK_RAW_TEMPLATE = '{author} - {title} ({year})';
const DEFAULT_AUDIOBOOK_OUTPUT_TEMPLATE = '{author}/{author} - {title} ({year})';

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

function normalizeOutputFormat(value) {
  const format = String(value || '').trim().toLowerCase();
  return SUPPORTED_OUTPUT_FORMATS.has(format) ? format : 'mp3';
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

function buildChapterList(probe = null) {
  const chapters = Array.isArray(probe?.chapters) ? probe.chapters : [];
  return chapters.map((chapter, index) => {
    const tags = normalizeTagMap(chapter?.tags);
    const startSeconds = Number(chapter?.start_time || chapter?.start || 0);
    const endSeconds = Number(chapter?.end_time || chapter?.end || 0);
    const title = tags.title || tags.chapter || `Kapitel ${index + 1}`;
    return {
      index: index + 1,
      title,
      startSeconds: Number.isFinite(startSeconds) ? startSeconds : 0,
      endSeconds: Number.isFinite(endSeconds) ? endSeconds : 0
    };
  });
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
  const author = pickTag(tags, ['artist', 'album_artist', 'composer']) || 'Unknown Author';
  const narrator = pickTag(tags, ['narrator', 'performer', 'comment']) || null;
  const series = pickTag(tags, ['series', 'grouping']) || null;
  const part = pickTag(tags, ['part', 'disc', 'track']) || null;
  const year = parseOptionalYear(pickTag(tags, ['date', 'year']));
  const durationSeconds = Number(format.duration || 0);
  const durationMs = Number.isFinite(durationSeconds) && durationSeconds > 0
    ? Math.round(durationSeconds * 1000)
    : 0;
  const chapters = buildChapterList(probe);
  return {
    title,
    author,
    narrator,
    series,
    part,
    year,
    album: title,
    artist: author,
    durationMs,
    chapters,
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

function buildTemplateValues(metadata = {}, format = null) {
  const author = sanitizeFileName(normalizeText(metadata.author || metadata.artist || 'Unknown Author'));
  const title = sanitizeFileName(normalizeText(metadata.title || metadata.album || 'Unknown Audiobook'));
  const narrator = sanitizeFileName(normalizeText(metadata.narrator || ''), 'unknown');
  const series = sanitizeFileName(normalizeText(metadata.series || ''), 'unknown');
  const part = sanitizeFileName(normalizeText(metadata.part || ''), 'unknown');
  const year = metadata.year ? String(metadata.year) : '';
  return {
    author,
    title,
    narrator: narrator === 'unknown' ? '' : narrator,
    series: series === 'unknown' ? '' : series,
    part: part === 'unknown' ? '' : part,
    year,
    format: format ? String(format).trim().toLowerCase() : ''
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

function buildEncodeCommand(ffmpegCommand, inputPath, outputPath, outputFormat = 'mp3') {
  const cmd = String(ffmpegCommand || 'ffmpeg').trim() || 'ffmpeg';
  const format = normalizeOutputFormat(outputFormat);
  const codecArgs = format === 'm4b'
    ? ['-codec', 'copy']
    : (format === 'flac'
      ? ['-codec:a', 'flac']
      : ['-codec:a', 'libmp3lame']);
  return {
    cmd,
    args: ['-y', '-i', inputPath, ...codecArgs, outputPath]
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
  normalizeOutputFormat,
  isSupportedInputFile,
  buildMetadataFromProbe,
  buildRawStoragePaths,
  buildOutputPath,
  buildProbeCommand,
  parseProbeOutput,
  buildEncodeCommand,
  buildProgressParser
};
