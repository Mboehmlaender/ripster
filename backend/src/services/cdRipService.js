const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const settingsService = require('./settingsService');
const logger = require('./logger').child('CD_RIP');
const { spawnTrackedProcess } = require('./processRunner');
const { parseCdParanoiaProgress } = require('../utils/progressParsers');
const { ensureDir } = require('../utils/files');
const { errorToMeta } = require('../utils/errorMeta');

const execFileAsync = promisify(execFile);

const SUPPORTED_FORMATS = new Set(['wav', 'flac', 'mp3', 'opus', 'ogg']);

/**
 * Parse cdparanoia -Q output (stderr) to extract track information.
 * Example output:
 *   Table of contents (start sector, length [start sector, length]):
 *     track  1:   0 (00:00.00)   24218 (05:22.43)
 *     track  2: 24218 (05:22.43) 15120 (03:21.20)
 *   TOTAL   193984 (43:04.59)
 */
function parseToc(tocOutput) {
  const lines = String(tocOutput || '').split(/\r?\n/);
  const tracks = [];
  for (const line of lines) {
    const m = line.match(/^\s*track\s+(\d+)\s*:\s*(\d+)\s+\((\d+):(\d+)\.(\d+)\)\s+(\d+)\s+\((\d+):(\d+)\.(\d+)\)/i);
    if (!m) {
      continue;
    }
    const startSector = Number(m[2]);
    const lengthSector = Number(m[6]);
    // duration in seconds: sectors / 75
    const durationSec = Math.round(lengthSector / 75);
    tracks.push({
      position: Number(m[1]),
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
    // cdparanoia -Q writes to stderr, exits 0 on success
    const { stderr } = await execFileAsync(cdparanoia, ['-Q', '-d', devicePath], {
      timeout: 15000
    });
    const tracks = parseToc(stderr);
    logger.info('toc:done', { devicePath, trackCount: tracks.length });
    return tracks;
  } catch (error) {
    // cdparanoia -Q exits non-zero sometimes even on success; try parsing stderr
    const stderr = String(error?.stderr || '');
    const tracks = parseToc(stderr);
    if (tracks.length > 0) {
      logger.info('toc:done-from-stderr', { devicePath, trackCount: tracks.length });
      return tracks;
    }
    logger.warn('toc:failed', { devicePath, error: errorToMeta(error) });
    return [];
  }
}

function buildOutputFilename(track, meta, format) {
  const ext = format === 'wav' ? 'wav' : format;
  const num = String(track.position).padStart(2, '0');
  const trackTitle = (track.title || `Track ${track.position}`)
    .replace(/[/\\?%*:|"<>]/g, '-')
    .trim();
  return `${num}. ${trackTitle}.${ext}`;
}

function buildOutputDir(meta, baseDir) {
  const artist = (meta?.artist || 'Unknown Artist').replace(/[/\\?%*:|"<>]/g, '-').trim();
  const album = (meta?.title || 'Unknown Album').replace(/[/\\?%*:|"<>]/g, '-').trim();
  const year = meta?.year ? ` (${meta.year})` : '';
  const folderName = `${artist} - ${album}${year}`;
  return path.join(baseDir, folderName);
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
 * @param {Function} options.onProgress     - ({phase, trackIndex, trackTotal, percent, track}) => void
 * @param {Function} options.onLog          - (level, msg) => void
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
    onProgress,
    onLog,
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
    const track = tracksToRip[i];
    const wavFile = path.join(rawWavDir, `track${String(track.position).padStart(2, '0')}.cdda.wav`);

    log('info', `Rippe Track ${track.position} von ${tracks.length} …`);

    let lastTrackPercent = 0;

    const runInfo = await spawnTrackedProcess({
      cmd: cdparanoiaCmd,
      args: ['-d', devicePath, String(track.position), wavFile],
      cwd: rawWavDir,
      onStderrLine(line) {
        const parsed = parseCdParanoiaProgress(line);
        if (parsed && parsed.percent !== null) {
          lastTrackPercent = parsed.percent;
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
      context
    });

    if (runInfo.exitCode !== 0) {
      throw new Error(
        `cdparanoia fehlgeschlagen für Track ${track.position} (Exit ${runInfo.exitCode})`
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
      const track = tracksToRip[i];
      const wavFile = path.join(rawWavDir, `track${String(track.position).padStart(2, '0')}.cdda.wav`);
      const outFile = path.join(outputDir, buildOutputFilename(track, meta, 'wav'));
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
    const track = tracksToRip[i];
    const wavFile = path.join(rawWavDir, `track${String(track.position).padStart(2, '0')}.cdda.wav`);

    if (!fs.existsSync(wavFile)) {
      throw new Error(`WAV-Datei nicht gefunden für Track ${track.position}: ${wavFile}`);
    }

    const outFilename = buildOutputFilename(track, meta, format);
    const outFile = path.join(outputDir, outFilename);

    log('info', `Encodiere Track ${track.position} → ${outFilename} …`);

    const encodeArgs = buildEncodeArgs(format, formatOptions, track, meta, wavFile, outFile);

    await spawnTrackedProcess({
      cmd: encodeArgs.cmd,
      args: encodeArgs.args,
      cwd: rawWavDir,
      onStdoutLine() {},
      onStderrLine() {},
      context
    });

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
  const artist = meta?.artist || '';
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
  readToc,
  ripAndEncode,
  buildOutputDir,
  SUPPORTED_FORMATS
};
