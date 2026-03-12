const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const logger = require('./logger').child('CD_RIP');
const { spawnTrackedProcess } = require('./processRunner');
const { parseCdParanoiaProgress } = require('../utils/progressParsers');
const { ensureDir } = require('../utils/files');
const { errorToMeta } = require('../utils/errorMeta');

const execFileAsync = promisify(execFile);

const SUPPORTED_FORMATS = new Set(['wav', 'flac', 'mp3', 'opus', 'ogg']);
const DEFAULT_CD_OUTPUT_TEMPLATE = '{artist} - {album} ({year})/{trackNr} {artist} - {title}';

/**
 * Parse cdparanoia -Q output to extract track information.
 * Supports both bracket styles shown by different builds:
 *   track  1:   0 (00:00.00)   24218 (05:22.43)
 *   track  1:   0 [00:00.00]   24218 [05:22.43]
 */
function parseToc(tocOutput) {
  const lines = String(tocOutput || '').split(/\r?\n/);
  const tracks = [];

  for (const line of lines) {
    const trackMatch = line.match(/^\s*track\s+(\d+)\s*:\s*(.+)$/i);
    if (trackMatch) {
      const position = Number(trackMatch[1]);
      const payloadWithoutTimes = String(trackMatch[2] || '')
        .replace(/[\(\[]\s*\d+:\d+\.\d+\s*[\)\]]/g, ' ');
      const sectorValues = payloadWithoutTimes.match(/\d+/g) || [];
      if (sectorValues.length < 2) {
        continue;
      }

      const startSector = Number(sectorValues[0]);
      const lengthSector = Number(sectorValues[1]);
      if (!Number.isFinite(position) || !Number.isFinite(startSector) || !Number.isFinite(lengthSector)) {
        continue;
      }
      if (position <= 0 || startSector < 0 || lengthSector <= 0) {
        continue;
      }

      // duration in seconds: sectors / 75
      const durationSec = Math.round(lengthSector / 75);
      tracks.push({
        position,
        startSector,
        lengthSector,
        durationSec,
        durationMs: durationSec * 1000
      });
      continue;
    }

    // Alternative cdparanoia -Q table style:
    //   1.   16503 [03:40.03]        0 [00:00.00]    no   no  2
    //   ^    length sectors           ^ start sector
    const tableMatch = line.match(
      /^\s*(\d+)\.?\s+(\d+)\s+[\(\[]\d+:\d+\.\d+[\)\]]\s+(\d+)\s+[\(\[]\d+:\d+\.\d+[\)\]]/i
    );
    if (!tableMatch) {
      continue;
    }

    const position = Number(tableMatch[1]);
    const lengthSector = Number(tableMatch[2]);
    const startSector = Number(tableMatch[3]);
    if (!Number.isFinite(position) || !Number.isFinite(startSector) || !Number.isFinite(lengthSector)) {
      continue;
    }
    if (position <= 0 || startSector < 0 || lengthSector <= 0) {
      continue;
    }

    const durationSec = Math.round(lengthSector / 75);
    tracks.push({
      position,
      startSector,
      lengthSector,
      durationSec,
      durationMs: durationSec * 1000
    });
  }

  return tracks;
}

async function readToc(devicePath, cmd) {
  const cdparanoia = String(cmd || 'cdparanoia').trim() || 'cdparanoia';
  logger.info('toc:read', { devicePath, cmd: cdparanoia });
  try {
    // Depending on distro/build, TOC can appear on stderr and/or stdout.
    const { stdout, stderr } = await execFileAsync(cdparanoia, ['-Q', '-d', devicePath], {
      timeout: 15000
    });
    const tracks = parseToc(`${stderr || ''}\n${stdout || ''}`);
    logger.info('toc:done', { devicePath, trackCount: tracks.length });
    return tracks;
  } catch (error) {
    // cdparanoia -Q may exit non-zero even when TOC is readable.
    const stderr = String(error?.stderr || '');
    const stdout = String(error?.stdout || '');
    const tracks = parseToc(`${stderr}\n${stdout}`);
    if (tracks.length > 0) {
      logger.info('toc:done-from-error-streams', { devicePath, trackCount: tracks.length });
      return tracks;
    }
    logger.warn('toc:failed', { devicePath, error: errorToMeta(error) });
    return [];
  }
}

function buildOutputFilename(track, meta, format, outputTemplate = DEFAULT_CD_OUTPUT_TEMPLATE) {
  const relativeBasePath = buildTrackRelativeBasePath(track, meta, outputTemplate);
  const ext = String(format === 'wav' ? 'wav' : format).trim().toLowerCase() || 'wav';
  return `${relativeBasePath}.${ext}`;
}

function sanitizePathSegment(value, fallback = 'unknown') {
  const raw = String(value == null ? '' : value)
    .normalize('NFC')
    .replace(/[\\/:*?"<>|]/g, '-')
    // Keep umlauts/special letters, but filter heart symbols in filenames.
    .replace(/[♥❤♡❥❣❦❧]/gu, ' ')
    .replace(/\p{C}+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!raw || raw === '.' || raw === '..') {
    return fallback;
  }
  return raw.slice(0, 180);
}

function normalizeTemplateTokenKey(rawKey) {
  const key = String(rawKey || '').trim().toLowerCase();
  if (!key) {
    return '';
  }
  if (key === 'tracknr' || key === 'tracknumberpadded' || key === 'tracknopadded') {
    return 'trackNr';
  }
  if (key === 'tracknumber' || key === 'trackno' || key === 'tracknum' || key === 'track') {
    return 'trackNo';
  }
  if (key === 'trackartist' || key === 'track_artist') {
    return 'trackArtist';
  }
  if (key === 'albumartist') {
    return 'albumArtist';
  }
  if (key === 'interpret') {
    return 'artist';
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

function renderOutputTemplate(template, values) {
  const source = String(template || DEFAULT_CD_OUTPUT_TEMPLATE).trim() || DEFAULT_CD_OUTPUT_TEMPLATE;
  const rendered = source.replace(/\$\{([^}]+)\}|\{([^{}]+)\}/g, (_, keyA, keyB) => {
    const normalizedKey = normalizeTemplateTokenKey(keyA || keyB);
    const rawValue = values[normalizedKey];
    if (rawValue === undefined || rawValue === null) {
      return '';
    }
    return String(rawValue);
  });
  return cleanupRenderedTemplate(rendered);
}

function buildTemplateValues(track, meta, format = null) {
  const trackNo = Number(track?.position) > 0 ? Math.trunc(Number(track.position)) : 1;
  const trackTitle = sanitizePathSegment(track?.title || `Track ${trackNo}`, `Track ${trackNo}`);
  const albumArtist = sanitizePathSegment(meta?.artist || 'Unknown Artist', 'Unknown Artist');
  const trackArtist = sanitizePathSegment(track?.artist || meta?.artist || 'Unknown Artist', 'Unknown Artist');
  const album = sanitizePathSegment(meta?.title || meta?.album || 'Unknown Album', 'Unknown Album');
  const year = meta?.year == null ? '' : sanitizePathSegment(String(meta.year), '');
  return {
    artist: albumArtist,
    albumArtist,
    trackArtist,
    album,
    year,
    title: trackTitle,
    trackNr: String(trackNo).padStart(2, '0'),
    trackNo: String(trackNo),
    format: format ? String(format).trim().toLowerCase() : ''
  };
}

function buildTrackRelativeBasePath(track, meta, outputTemplate = DEFAULT_CD_OUTPUT_TEMPLATE, format = null) {
  const values = buildTemplateValues(track, meta, format);
  const rendered = renderOutputTemplate(outputTemplate, values)
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .replace(/^\/+|\/+$/g, '');

  const parts = rendered
    .split('/')
    .map((part) => sanitizePathSegment(part, 'unknown'))
    .filter(Boolean);

  if (parts.length === 0) {
    return `${String(track?.position || 1).padStart(2, '0')} Track ${String(track?.position || 1).padStart(2, '0')}`;
  }

  return path.join(...parts);
}

function buildOutputDir(meta, baseDir, outputTemplate = DEFAULT_CD_OUTPUT_TEMPLATE) {
  const sampleTrack = {
    position: 1,
    title: 'Track 1'
  };
  const relativeBasePath = buildTrackRelativeBasePath(sampleTrack, meta, outputTemplate);
  const relativeDir = path.dirname(relativeBasePath);
  if (!relativeDir || relativeDir === '.' || relativeDir === path.sep) {
    return baseDir;
  }
  return path.join(baseDir, relativeDir);
}

function splitPathSegments(value) {
  return String(value || '')
    .replace(/\\/g, '/')
    .split('/')
    .map((segment) => segment.trim())
    .filter(Boolean);
}

function outputDirAlreadyContainsRelativeDir(outputBaseDir, relativeDir) {
  const outputSegments = splitPathSegments(outputBaseDir);
  const relativeSegments = splitPathSegments(relativeDir);
  if (relativeSegments.length === 0 || outputSegments.length < relativeSegments.length) {
    return false;
  }
  const offset = outputSegments.length - relativeSegments.length;
  for (let i = 0; i < relativeSegments.length; i++) {
    if (outputSegments[offset + i] !== relativeSegments[i]) {
      return false;
    }
  }
  return true;
}

function stripLeadingRelativeDir(relativeFilePath, relativeDir) {
  const fileSegments = splitPathSegments(relativeFilePath);
  const dirSegments = splitPathSegments(relativeDir);
  if (dirSegments.length === 0 || fileSegments.length <= dirSegments.length) {
    return relativeFilePath;
  }
  for (let i = 0; i < dirSegments.length; i++) {
    if (fileSegments[i] !== dirSegments[i]) {
      return relativeFilePath;
    }
  }
  return path.join(...fileSegments.slice(dirSegments.length));
}

function buildOutputFilePath(outputBaseDir, track, meta, format, outputTemplate = DEFAULT_CD_OUTPUT_TEMPLATE) {
  const relativeBasePath = buildTrackRelativeBasePath(track, meta, outputTemplate, format);
  const ext = String(format === 'wav' ? 'wav' : format).trim().toLowerCase() || 'wav';
  const relativeDir = path.dirname(relativeBasePath);
  let relativeFilePath = `${relativeBasePath}.${ext}`;
  if (relativeDir && relativeDir !== '.' && relativeDir !== path.sep) {
    if (outputDirAlreadyContainsRelativeDir(outputBaseDir, relativeDir)) {
      relativeFilePath = stripLeadingRelativeDir(relativeFilePath, relativeDir);
    }
  }
  const outFile = path.join(outputBaseDir, relativeFilePath);
  return {
    outFile,
    relativeFilePath,
    outFilename: path.basename(relativeFilePath)
  };
}

function buildCancelledError() {
  const error = new Error('Job wurde vom Benutzer abgebrochen.');
  error.statusCode = 409;
  return error;
}

function assertNotCancelled(isCancelled) {
  if (typeof isCancelled === 'function' && isCancelled()) {
    throw buildCancelledError();
  }
}

function normalizeExitCode(error) {
  const code = Number(error?.code);
  if (Number.isFinite(code)) {
    return Math.trunc(code);
  }
  return 1;
}

function quoteShellArg(value) {
  const text = String(value == null ? '' : value);
  if (!text) {
    return "''";
  }
  if (/^[a-zA-Z0-9_./:@%+=,-]+$/.test(text)) {
    return text;
  }
  return `'${text.replace(/'/g, "'\\''")}'`;
}

function formatCommandLine(cmd, args = []) {
  const normalizedArgs = Array.isArray(args) ? args : [];
  return [quoteShellArg(cmd), ...normalizedArgs.map((arg) => quoteShellArg(arg))].join(' ');
}

async function runProcessTracked({
  cmd,
  args,
  cwd,
  onStdoutLine,
  onStderrLine,
  context,
  onProcessHandle,
  isCancelled
}) {
  assertNotCancelled(isCancelled);
  const handle = spawnTrackedProcess({
    cmd,
    args,
    cwd,
    onStdoutLine,
    onStderrLine,
    context
  });
  if (typeof onProcessHandle === 'function') {
    onProcessHandle(handle);
  }
  if (typeof isCancelled === 'function' && isCancelled()) {
    handle.cancel();
  }
  try {
    return await handle.promise;
  } catch (error) {
    if (typeof isCancelled === 'function' && isCancelled()) {
      throw buildCancelledError();
    }
    throw error;
  }
}

/**
 * Rip and encode a CD.
 *
 * @param {object} options
 * @param {string}   options.jobId          - Job ID for logging
 * @param {string}   options.devicePath     - e.g. /dev/sr0
 * @param {string}   options.cdparanoiaCmd  - path/cmd for cdparanoia
 * @param {string}   options.rawWavDir      - temp dir for WAV files
 * @param {string}   options.outputDir      - final output dir
 * @param {string}   options.format         - wav|flac|mp3|opus|ogg
 * @param {object}   options.formatOptions  - encoder-specific options
 * @param {number[]} options.selectedTracks - track positions to rip (empty = all)
 * @param {object[]} options.tracks         - TOC track list [{position, durationMs, title}]
 * @param {object}   options.meta           - album metadata {title, artist, year}
 * @param {string}   options.outputTemplate - template for relative output path without extension
 * @param {Function} options.onProgress     - ({phase, trackIndex, trackTotal, percent, track}) => void
 * @param {Function} options.onLog          - (level, msg) => void
 * @param {Function} options.onProcessHandle- called with spawned process handle for cancellation integration
 * @param {Function} options.isCancelled    - returns true when user requested cancellation
 * @param {object}   options.context        - passed to spawnTrackedProcess
 */
async function ripAndEncode(options) {
  const {
    jobId,
    devicePath,
    cdparanoiaCmd = 'cdparanoia',
    rawWavDir,
    outputDir,
    format = 'flac',
    formatOptions = {},
    selectedTracks = [],
    tracks = [],
    meta = {},
    outputTemplate = DEFAULT_CD_OUTPUT_TEMPLATE,
    onProgress,
    onLog,
    onProcessHandle,
    isCancelled,
    context
  } = options;

  if (!SUPPORTED_FORMATS.has(format)) {
    throw new Error(`Unbekanntes Ausgabeformat: ${format}`);
  }

  const tracksToRip = selectedTracks.length > 0
    ? tracks.filter((t) => selectedTracks.includes(t.position))
    : tracks;

  if (tracksToRip.length === 0) {
    throw new Error('Keine Tracks zum Rippen ausgewählt.');
  }

  await ensureDir(rawWavDir);
  await ensureDir(outputDir);

  logger.info('rip:start', {
    jobId,
    devicePath,
    format,
    trackCount: tracksToRip.length
  });

  const log = (level, msg) => {
    logger[level] && logger[level](msg, { jobId });
    onLog && onLog(level, msg);
  };

  // ── Phase 1: Rip each selected track to WAV ──────────────────────────────
  for (let i = 0; i < tracksToRip.length; i++) {
    assertNotCancelled(isCancelled);
    const track = tracksToRip[i];
    const wavFile = path.join(rawWavDir, `track${String(track.position).padStart(2, '0')}.cdda.wav`);
    const ripArgs = ['-d', devicePath, String(track.position), wavFile];

    log('info', `Rippe Track ${track.position} von ${tracksToRip.length} …`);
    log('info', `Promptkette [Rip ${i + 1}/${tracksToRip.length}]: ${formatCommandLine(cdparanoiaCmd, ripArgs)}`);

    try {
      await runProcessTracked({
        cmd: cdparanoiaCmd,
        args: ripArgs,
        cwd: rawWavDir,
        onStderrLine(line) {
          const parsed = parseCdParanoiaProgress(line);
          if (parsed && parsed.percent !== null) {
            const overallPercent = ((i + parsed.percent / 100) / tracksToRip.length) * 50;
            onProgress && onProgress({
              phase: 'rip',
              trackIndex: i + 1,
              trackTotal: tracksToRip.length,
              trackPosition: track.position,
              percent: overallPercent
            });
          }
        },
        context,
        onProcessHandle,
        isCancelled
      });
    } catch (error) {
      if (String(error?.message || '').toLowerCase().includes('abgebrochen')) {
        throw error;
      }
      throw new Error(
        `cdparanoia fehlgeschlagen für Track ${track.position} (Exit ${normalizeExitCode(error)})`
      );
    }

    onProgress && onProgress({
      phase: 'rip',
      trackIndex: i + 1,
      trackTotal: tracksToRip.length,
      trackPosition: track.position,
      percent: ((i + 1) / tracksToRip.length) * 50
    });

    log('info', `Track ${track.position} gerippt.`);
  }

  // ── Phase 2: Encode WAVs to target format ─────────────────────────────────
  if (format === 'wav') {
    // Just move WAV files to output dir with proper names
    for (let i = 0; i < tracksToRip.length; i++) {
      assertNotCancelled(isCancelled);
      const track = tracksToRip[i];
      const wavFile = path.join(rawWavDir, `track${String(track.position).padStart(2, '0')}.cdda.wav`);
      const { outFile } = buildOutputFilePath(outputDir, track, meta, 'wav', outputTemplate);
      ensureDir(path.dirname(outFile));
      log('info', `Promptkette [Move ${i + 1}/${tracksToRip.length}]: mv ${quoteShellArg(wavFile)} ${quoteShellArg(outFile)}`);
      fs.renameSync(wavFile, outFile);
      onProgress && onProgress({
        phase: 'encode',
        trackIndex: i + 1,
        trackTotal: tracksToRip.length,
        trackPosition: track.position,
        percent: 50 + ((i + 1) / tracksToRip.length) * 50
      });
      log('info', `WAV für Track ${track.position} gespeichert.`);
    }
    return { outputDir, format, trackCount: tracksToRip.length };
  }

  for (let i = 0; i < tracksToRip.length; i++) {
    assertNotCancelled(isCancelled);
    const track = tracksToRip[i];
    const wavFile = path.join(rawWavDir, `track${String(track.position).padStart(2, '0')}.cdda.wav`);

    if (!fs.existsSync(wavFile)) {
      throw new Error(`WAV-Datei nicht gefunden für Track ${track.position}: ${wavFile}`);
    }

    const { outFilename, outFile } = buildOutputFilePath(outputDir, track, meta, format, outputTemplate);
    ensureDir(path.dirname(outFile));

    log('info', `Encodiere Track ${track.position} → ${outFilename} …`);

    const encodeArgs = buildEncodeArgs(format, formatOptions, track, meta, wavFile, outFile);
    log('info', `Promptkette [Encode ${i + 1}/${tracksToRip.length}]: ${formatCommandLine(encodeArgs.cmd, encodeArgs.args)}`);

    try {
      await runProcessTracked({
        cmd: encodeArgs.cmd,
        args: encodeArgs.args,
        cwd: rawWavDir,
        onStdoutLine() {},
        onStderrLine() {},
        context,
        onProcessHandle,
        isCancelled
      });
    } catch (error) {
      if (String(error?.message || '').toLowerCase().includes('abgebrochen')) {
        throw error;
      }
      throw new Error(
        `${encodeArgs.cmd} fehlgeschlagen für Track ${track.position} (Exit ${normalizeExitCode(error)})`
      );
    }

    // Clean up WAV after encode
    try {
      fs.unlinkSync(wavFile);
    } catch (_error) {
      // ignore cleanup errors
    }

    onProgress && onProgress({
      phase: 'encode',
      trackIndex: i + 1,
      trackTotal: tracksToRip.length,
      trackPosition: track.position,
      percent: 50 + ((i + 1) / tracksToRip.length) * 50
    });

    log('info', `Track ${track.position} encodiert.`);
  }

  return { outputDir, format, trackCount: tracksToRip.length };
}

function buildEncodeArgs(format, opts, track, meta, wavFile, outFile) {
  const artist = track?.artist || meta?.artist || '';
  const album = meta?.title || '';
  const year = meta?.year ? String(meta.year) : '';
  const trackTitle = track.title || `Track ${track.position}`;
  const trackNum = String(track.position);

  if (format === 'flac') {
    const level = Number(opts.flacCompression ?? 5);
    const clampedLevel = Math.max(0, Math.min(8, level));
    return {
      cmd: 'flac',
      args: [
        `--compression-level-${clampedLevel}`,
        '--tag', `TITLE=${trackTitle}`,
        '--tag', `ARTIST=${artist}`,
        '--tag', `ALBUM=${album}`,
        '--tag', `DATE=${year}`,
        '--tag', `TRACKNUMBER=${trackNum}`,
        wavFile,
        '-o', outFile
      ]
    };
  }

  if (format === 'mp3') {
    const mode = String(opts.mp3Mode || 'cbr').trim().toLowerCase();
    const args = ['--id3v2-only', '--noreplaygain'];
    if (mode === 'vbr') {
      const quality = Math.max(0, Math.min(9, Number(opts.mp3Quality ?? 4)));
      args.push('-V', String(quality));
    } else {
      const bitrate = Number(opts.mp3Bitrate ?? 192);
      args.push('-b', String(bitrate));
    }
    args.push(
      '--tt', trackTitle,
      '--ta', artist,
      '--tl', album,
      '--ty', year,
      '--tn', trackNum,
      wavFile,
      outFile
    );
    return { cmd: 'lame', args };
  }

  if (format === 'opus') {
    const bitrate = Math.max(32, Math.min(512, Number(opts.opusBitrate ?? 160)));
    const complexity = Math.max(0, Math.min(10, Number(opts.opusComplexity ?? 10)));
    return {
      cmd: 'opusenc',
      args: [
        '--bitrate', String(bitrate),
        '--comp', String(complexity),
        '--title', trackTitle,
        '--artist', artist,
        '--album', album,
        '--date', year,
        '--tracknumber', trackNum,
        wavFile,
        outFile
      ]
    };
  }

  if (format === 'ogg') {
    const quality = Math.max(-1, Math.min(10, Number(opts.oggQuality ?? 6)));
    return {
      cmd: 'oggenc',
      args: [
        '-q', String(quality),
        '-t', trackTitle,
        '-a', artist,
        '-l', album,
        '-d', year,
        '-N', trackNum,
        '-o', outFile,
        wavFile
      ]
    };
  }

  throw new Error(`Unbekanntes Format: ${format}`);
}

module.exports = {
  parseToc,
  readToc,
  ripAndEncode,
  buildOutputDir,
  buildOutputFilename,
  DEFAULT_CD_OUTPUT_TEMPLATE,
  SUPPORTED_FORMATS
};
