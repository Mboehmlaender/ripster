'use strict';

const fs = require('fs');
const path = require('path');
const { SourcePlugin } = require('./PluginBase');
const { spawnTrackedProcess } = require('../services/processRunner');
const { syncRegistrationKeyToConfig } = require('../services/makemkvKeyService');
const { parseHandBrakeProgress, parseMakeMkvProgress } = require('../utils/progressParsers');
const { ensureDir, sanitizeFileName, renderTemplate } = require('../utils/files');

const VIDEO_EXTENSIONS = new Set(['mkv', 'mp4', 'm2ts', 'avi', 'mov']);
const AUDIO_EXTENSIONS = new Set(['flac', 'mp3', 'wav', 'm4a', 'ogg', 'opus']);
const ISO_EXTENSIONS = new Set(['iso']);

const AUDIO_OUTPUT_FORMATS = new Set(['flac', 'mp3', 'opus', 'wav', 'ogg']);
const VIDEO_OUTPUT_FORMATS = new Set(['mkv', 'mp4', 'm4v']);

/**
 * Erkennt den Medientyp anhand der Dateiendung.
 * @returns {'video'|'audio'|'iso'|null}
 */
function detectMediaTypeFromPath(filePath) {
  const ext = path.extname(String(filePath || '')).slice(1).toLowerCase();
  if (ISO_EXTENSIONS.has(ext)) return 'iso';
  if (VIDEO_EXTENSIONS.has(ext)) return 'video';
  if (AUDIO_EXTENSIONS.has(ext)) return 'audio';
  return null;
}

function isAudioExt(ext) {
  return AUDIO_EXTENSIONS.has(String(ext).toLowerCase());
}

/**
 * Alle Audio-Dateien in einem Verzeichnis auflisten (nicht rekursiv).
 */
function listAudioFilesInDir(dirPath) {
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && isAudioExt(path.extname(e.name).slice(1)))
      .map((e) => e.name)
      .sort();
  } catch (_err) {
    return [];
  }
}

/**
 * ffmpeg-Args zum Konvertieren einer einzelnen Audio-Datei.
 */
function buildAudioFfmpegArgs(ffmpegCmd, inputFile, outputFile, format, opts = {}) {
  const args = ['-y', '-i', inputFile];

  if (format === 'flac') {
    const level = Math.max(0, Math.min(12, Number(opts.flacCompression ?? 5)));
    args.push('-codec:a', 'flac', '-compression_level', String(level));
  } else if (format === 'mp3') {
    const mode = String(opts.mp3Mode || 'cbr').trim().toLowerCase();
    args.push('-codec:a', 'libmp3lame');
    if (mode === 'vbr') {
      args.push('-q:a', String(Math.max(0, Math.min(9, Number(opts.mp3Quality ?? 4)))));
    } else {
      args.push('-b:a', `${Number(opts.mp3Bitrate ?? 192)}k`);
    }
  } else if (format === 'opus') {
    args.push('-codec:a', 'libopus', '-b:a', `${Number(opts.opusBitrate ?? 160)}k`);
  } else if (format === 'ogg') {
    args.push('-codec:a', 'libvorbis', '-q:a', String(Math.max(-1, Math.min(10, Number(opts.oggQuality ?? 6)))));
  } else if (format === 'wav') {
    args.push('-codec:a', 'pcm_s16le');
  } else {
    args.push('-codec:a', 'copy');
  }

  // Metadata tags
  const trackTitle = opts.trackTitle ? String(opts.trackTitle).trim() : null;
  const trackArtist = (opts.trackArtist || opts.albumArtist)
    ? String(opts.trackArtist || opts.albumArtist).trim() : null;
  const albumTitle = opts.albumTitle ? String(opts.albumTitle).trim() : null;
  const albumYear = opts.albumYear ? String(opts.albumYear).trim() : null;
  const trackNumber = opts.trackNumber != null ? String(opts.trackNumber) : null;

  if (trackTitle) args.push('-metadata', `title=${trackTitle}`);
  if (trackArtist) args.push('-metadata', `artist=${trackArtist}`);
  if (albumTitle) args.push('-metadata', `album=${albumTitle}`);
  if (albumYear) args.push('-metadata', `date=${albumYear}`);
  if (trackNumber) args.push('-metadata', `track=${trackNumber}`);

  args.push(outputFile);
  return { cmd: ffmpegCmd, args };
}

/**
 * Source-Plugin für den Converter.
 *
 * Unterstützte Eingaben:
 *   - Video-Dateien (mkv, mp4, avi, mov, ...): HandBrake-Encode
 *   - Audio-Dateien (flac, mp3, wav, ...): ffmpeg-Encode
 *   - Audio-Ordner: alle enthaltenen Audio-Dateien mit ffmpeg
 *   - ISO: MakeMKV-Rip → HandBrake-Encode
 *
 * Erkennung via mediaProfile === 'converter'.
 *
 * Erforderliche Felder in ctx.extra für encode():
 *   inputPath         - Absoluter Pfad zur Eingabedatei/-ordner (nach Rip: raw_path)
 *   outputDir         - Ausgabeverzeichnis (für Audio/ISO-Ordner) oder
 *   outputPath        - Ausgabedatei (für einzelne Video/Audio-Dateien)
 *   encodePlan        - aus encode_plan_json
 *   isCancelled       - () => boolean
 *   onProcessHandle   - (handle) => void [optional]
 */
class ConverterPlugin extends SourcePlugin {
  get id() { return 'converter'; }
  get name() { return 'Converter'; }
  get priority() { return 3; }

  detect(discInfo) {
    const profile = String(discInfo?.mediaProfile || '').trim().toLowerCase();
    return profile === 'converter';
  }

  /**
   * Analysiert die Eingabedatei/-ordner.
   * - Video/ISO: HandBrake --scan für Track-Info
   * - Audio: ffprobe für Metadaten
   * - Audio-Ordner: Dateiliste + ffprobe auf erste Datei
   */
  async analyze(inputPath, job, ctx) {
    ctx.markExecution('analyze', {
      pluginId: this.id, pluginName: this.name, pluginFile: 'ConverterPlugin.js'
    });

    const actualInput = ctx.extra?.filePath || inputPath;
    const encodePlan = ctx.extra?.encodePlan || {};
    const converterMediaType = encodePlan.converterMediaType
      || detectMediaTypeFromPath(actualInput);

    ctx.logger.info('converter:analyze:start', {
      jobId: job?.id, inputPath: actualInput, converterMediaType
    });

    const settings = await ctx.settings.getSettingsMap();
    const ffprobeCmd = String(settings?.ffprobe_command || 'ffprobe').trim() || 'ffprobe';
    const handbrakeCmd = String(settings?.handbrake_command || 'HandBrakeCLI').trim() || 'HandBrakeCLI';

    let analysisResult = { converterMediaType, inputPath: actualInput };

    if (converterMediaType === 'video' || converterMediaType === 'iso') {
      // HandBrake --scan für Track-Informationen
      try {
        const scanConfig = await ctx.settings.buildHandBrakeScanConfigForInput(actualInput);
        const captured = await this._runCaptured(scanConfig.cmd, scanConfig.args, { jobId: job?.id });
        const hbInfo = this._parseHandBrakeScan(captured.stdout);
        analysisResult.handbrakeInfo = hbInfo;
        ctx.logger.info('converter:analyze:handbrake-scan', {
          jobId: job?.id,
          titleCount: hbInfo?.TitleList?.length || 0
        });
      } catch (scanError) {
        ctx.logger.warn('converter:analyze:handbrake-scan-failed', {
          jobId: job?.id, error: scanError?.message
        });
      }
    }

    if (converterMediaType === 'audio') {
      const stat = fs.statSync(actualInput);
      if (stat.isDirectory()) {
        // Ordner mit Audio-Dateien
        const audioFiles = listAudioFilesInDir(actualInput);
        analysisResult.isFolder = true;
        analysisResult.audioFiles = audioFiles;
        // Erster Track: ffprobe für Metadaten
        if (audioFiles.length > 0) {
          const firstFile = path.join(actualInput, audioFiles[0]);
          try {
            const meta = await this._ffprobeMetadata(ffprobeCmd, firstFile, { jobId: job?.id });
            analysisResult.folderMeta = meta;
          } catch (_err) {
            // Metadaten optional
          }
        }
        ctx.logger.info('converter:analyze:audio-folder', {
          jobId: job?.id, fileCount: audioFiles.length
        });
      } else {
        // Einzelne Audio-Datei
        analysisResult.isFolder = false;
        try {
          const meta = await this._ffprobeMetadata(ffprobeCmd, actualInput, { jobId: job?.id });
          analysisResult.fileMeta = meta;
        } catch (_err) {
          // Metadaten optional
        }
        ctx.logger.info('converter:analyze:audio-file', { jobId: job?.id });
      }
    }

    return analysisResult;
  }

  /**
   * Rip-Schritt:
   * - Video/Audio-Dateien: No-Op (Datei liegt bereits vor)
   * - ISO: MakeMKV backup → raw_path
   */
  async rip(job, ctx) {
    ctx.markExecution('rip', {
      pluginId: this.id, pluginName: this.name, pluginFile: 'ConverterPlugin.js'
    });

    const encodePlan = ctx.extra?.encodePlan || {};
    const converterMediaType = encodePlan.converterMediaType;

    if (converterMediaType !== 'iso') {
      ctx.logger.info('converter:rip:no-op', { jobId: job?.id, converterMediaType });
      return;
    }

    // ISO: MakeMKV backup
    const {
      inputPath,
      rawJobDir,
      isCancelled,
      onProcessHandle
    } = ctx.extra || {};

    if (!inputPath) {
      throw new Error('ConverterPlugin.rip(): ctx.extra.inputPath fehlt');
    }
    if (!rawJobDir) {
      throw new Error('ConverterPlugin.rip(): ctx.extra.rawJobDir fehlt');
    }

    ensureDir(rawJobDir);

    const settings = await ctx.settings.getSettingsMap();
    const makemkvCmd = String(settings?.makemkv_command || 'makemkvcon').trim() || 'makemkvcon';
    await syncRegistrationKeyToConfig(settings?.makemkv_registration_key || '');

    const args = ['--noscan', '--decrypt', '-r', 'backup', `iso:${inputPath}`, rawJobDir];

    ctx.logger.info('converter:rip:iso:start', {
      jobId: job?.id, inputPath, rawJobDir, cmd: makemkvCmd
    });
    ctx.emitProgress(0, 'ISO: MakeMKV Backup läuft …');

    const runInfo = await _spawnAndWait({
      cmd: makemkvCmd, args,
      jobId: job?.id,
      progressParser: parseMakeMkvProgress,
      onProgress: (pct, statusText) => ctx.emitProgress(Math.round(pct), statusText),
      isCancelled,
      onProcessHandle,
      context: { jobId: job?.id, source: 'ConverterPlugin.rip', stage: 'RIPPING' }
    });

    ctx.logger.info('converter:rip:iso:done', {
      jobId: job?.id, exitCode: runInfo?.exitCode ?? null
    });

    ctx.extra.ripRunInfo = runInfo;
  }

  /**
   * Encode-Schritt:
   * - Video: HandBrakeCLI
   * - Audio Einzeldatei: ffmpeg
   * - Audio Ordner: ffmpeg je Datei
   */
  async encode(job, ctx) {
    ctx.markExecution('encode', {
      pluginId: this.id, pluginName: this.name, pluginFile: 'ConverterPlugin.js'
    });

    const {
      inputPath,
      outputPath,
      outputDir,
      encodePlan = {},
      isCancelled,
      onProcessHandle
    } = ctx.extra || {};

    const converterMediaType = encodePlan.converterMediaType;

    if (!inputPath) {
      throw new Error('ConverterPlugin.encode(): ctx.extra.inputPath fehlt');
    }

    const settings = await ctx.settings.getSettingsMap();

    if (converterMediaType === 'video' || converterMediaType === 'iso') {
      await this._encodeVideo({
        job, ctx, settings, inputPath, outputPath, encodePlan, isCancelled, onProcessHandle
      });
    } else if (converterMediaType === 'audio') {
      await this._encodeAudio({
        job, ctx, settings, inputPath, outputPath, outputDir, encodePlan, isCancelled, onProcessHandle
      });
    } else {
      throw new Error(`ConverterPlugin.encode(): Unbekannter converterMediaType: ${converterMediaType}`);
    }
  }

  // ── Video-Encode (HandBrake) ─────────────────────────────────────────────

  async _encodeVideo({ job, ctx, settings, inputPath, outputPath, encodePlan, isCancelled, onProcessHandle }) {
    if (!outputPath) {
      throw new Error('ConverterPlugin._encodeVideo(): outputPath fehlt');
    }

    ensureDir(path.dirname(outputPath));

    const handBrakeConfig = await ctx.settings.buildHandBrakeConfig(inputPath, outputPath, {
      trackSelection: encodePlan.trackSelection || null,
      titleId: encodePlan.handBrakeTitleId || null,
      mediaProfile: null,
      settingsMap: settings,
      userPreset: encodePlan.userPreset || null
    });

    ctx.logger.info('converter:encode:video:start', {
      jobId: job?.id, cmd: handBrakeConfig.cmd, titleId: encodePlan.handBrakeTitleId || null
    });
    ctx.emitProgress(0, 'Converter: Video Encoding läuft …');

    const runInfo = await _spawnAndWait({
      cmd: handBrakeConfig.cmd, args: handBrakeConfig.args,
      jobId: job?.id,
      progressParser: parseHandBrakeProgress,
      onProgress: (pct, statusText, eta) => ctx.emitProgress(
        Math.round(pct),
        statusText || `Encoding ${pct}%`,
        eta ?? null
      ),
      appendLogLine: ctx?.extra?.appendLogLine,
      logSource: 'HANDBRAKE',
      isCancelled,
      onProcessHandle,
      context: { jobId: job?.id, source: 'ConverterPlugin.encode', stage: 'ENCODING' }
    });

    ctx.logger.info('converter:encode:video:done', {
      jobId: job?.id, outputPath, exitCode: runInfo.exitCode
    });

    ctx.extra.encodeRunInfo = runInfo;
  }

  // ── Audio-Encode (ffmpeg) ────────────────────────────────────────────────

  async _encodeAudio({ job, ctx, settings, inputPath, outputPath, outputDir, encodePlan, isCancelled, onProcessHandle }) {
    const ffmpegCmd = String(settings?.ffmpeg_command || 'ffmpeg').trim() || 'ffmpeg';
    const outputFormat = String(encodePlan.outputFormat || encodePlan.audioFormat || 'flac').trim().toLowerCase();
    const formatOptions = encodePlan.audioFormatOptions || {};
    const isFolder = Boolean(encodePlan.isFolder);
    const isSharedAudio = Boolean(encodePlan.isSharedAudio)
      || (Array.isArray(encodePlan.inputPaths) && encodePlan.inputPaths.length > 0 && !isFolder);

    // Metadata from user config
    const planMetadata = encodePlan.metadata || {};
    const planTracks = Array.isArray(encodePlan.tracks) ? encodePlan.tracks : [];

    if (!AUDIO_OUTPUT_FORMATS.has(outputFormat)) {
      throw new Error(`Unbekanntes Audio-Ausgabeformat: ${outputFormat}`);
    }

    /** Build per-track metadata opts merged with album-level metadata */
    function trackMetaOpts(position, defaultBaseName) {
      const trackMeta = planTracks.find((t) => t.position === position) || {};
      return {
        ...formatOptions,
        trackTitle: trackMeta.title || defaultBaseName || null,
        trackArtist: trackMeta.artist || planMetadata.albumArtist || null,
        albumTitle: planMetadata.albumTitle || null,
        albumArtist: planMetadata.albumArtist || null,
        albumYear: planMetadata.albumYear ? String(planMetadata.albumYear) : null,
        trackNumber: position
      };
    }

    /** Build output filename with optional track number + title */
    function buildOutputFileName(position, trackMeta, defaultBaseName) {
      const numStr = String(position).padStart(2, '0');
      const title = trackMeta?.title ? sanitizeFileName(trackMeta.title) : null;
      const templateRaw = String(encodePlan.audioTrackTemplate || '').trim();
      if (templateRaw) {
        const rendered = renderTemplate(templateRaw, {
          trackNr: numStr,
          trackNumber: String(position),
          title: title || sanitizeFileName(defaultBaseName) || `Track ${numStr}`,
          artist: sanitizeFileName(trackMeta?.artist || planMetadata.albumArtist || '') || 'unknown',
          album: sanitizeFileName(planMetadata.albumTitle || '') || 'unknown',
          year: planMetadata.albumYear || 'unknown'
        });
        const sanitized = sanitizeFileName(rendered);
        if (sanitized) {
          return `${sanitized}.${outputFormat}`;
        }
      }
      if (title) return `${numStr} - ${title}.${outputFormat}`;
      return `${sanitizeFileName(defaultBaseName) || numStr}.${outputFormat}`;
    }

    if (isSharedAudio) {
      // Freigegebene Audio-Dateien (mehrere Einzeldateien in einem Job)
      const inputPaths = encodePlan.inputPaths || [];
      if (inputPaths.length === 0) {
        throw new Error('ConverterPlugin._encodeAudio(): inputPaths leer für shared-audio-Job');
      }
      if (!outputDir) {
        throw new Error('ConverterPlugin._encodeAudio(): outputDir fehlt für shared-audio-Job');
      }
      ensureDir(outputDir);

      ctx.logger.info('converter:encode:audio:shared:start', {
        jobId: job?.id, fileCount: inputPaths.length, outputDir, format: outputFormat
      });

      for (let i = 0; i < inputPaths.length; i++) {
        if (typeof isCancelled === 'function' && isCancelled()) {
          const err = new Error('Job wurde vom Benutzer abgebrochen.');
          err.statusCode = 409;
          throw err;
        }

        const inputFile = inputPaths[i];
        const fileName = path.basename(inputFile);
        const baseName = path.basename(fileName, path.extname(fileName));
        const position = i + 1;
        const trackMeta = planTracks.find((t) => t.position === position) || {};
        const outputFileName = buildOutputFileName(position, trackMeta, baseName);
        const outputFile = path.join(outputDir, outputFileName);

        ctx.logger.info(`converter:encode:audio:track:${position}`, { inputFile, outputFile });
        ctx.emitProgress(
          Math.round((i / inputPaths.length) * 100),
          `Audio: ${position}/${inputPaths.length} — ${fileName}`
        );

        const encodeConfig = buildAudioFfmpegArgs(
          ffmpegCmd, inputFile, outputFile, outputFormat,
          trackMetaOpts(position, baseName)
        );

        await _spawnAndWait({
          cmd: encodeConfig.cmd, args: encodeConfig.args,
          jobId: job?.id,
          appendLogLine: ctx?.extra?.appendLogLine,
          logSource: 'FFMPEG',
          isCancelled,
          onProcessHandle,
          context: { jobId: job?.id, source: 'ConverterPlugin.encode', stage: 'ENCODING' }
        });
      }

      ctx.logger.info('converter:encode:audio:shared:done', {
        jobId: job?.id, fileCount: inputPaths.length, outputDir
      });

      ctx.extra.encodeResult = { outputDir, format: outputFormat, fileCount: inputPaths.length };
    } else if (isFolder) {
      // Ordner-Modus: alle Audio-Dateien im Ordner konvertieren
      const audioFiles = encodePlan.audioFiles || listAudioFilesInDir(inputPath);

      if (!outputDir) {
        throw new Error('ConverterPlugin._encodeAudio(): outputDir fehlt für Ordner-Job');
      }
      ensureDir(outputDir);

      ctx.logger.info('converter:encode:audio:folder:start', {
        jobId: job?.id, inputPath, outputDir, format: outputFormat, fileCount: audioFiles.length
      });

      for (let i = 0; i < audioFiles.length; i++) {
        if (typeof isCancelled === 'function' && isCancelled()) {
          const err = new Error('Job wurde vom Benutzer abgebrochen.');
          err.statusCode = 409;
          throw err;
        }

        const fileName = audioFiles[i];
        const inputFile = path.join(inputPath, fileName);
        const baseName = path.basename(fileName, path.extname(fileName));
        const position = i + 1;
        const trackMeta = planTracks.find((t) => t.position === position) || {};
        const outputFileName = buildOutputFileName(position, trackMeta, baseName);
        const outputFile = path.join(outputDir, outputFileName);

        ctx.logger.info(`converter:encode:audio:track:${position}`, { inputFile, outputFile });
        ctx.emitProgress(
          Math.round((i / audioFiles.length) * 100),
          `Audio: ${position}/${audioFiles.length} — ${fileName}`
        );

        const encodeConfig = buildAudioFfmpegArgs(
          ffmpegCmd, inputFile, outputFile, outputFormat,
          trackMetaOpts(position, baseName)
        );

        await _spawnAndWait({
          cmd: encodeConfig.cmd, args: encodeConfig.args,
          jobId: job?.id,
          appendLogLine: ctx?.extra?.appendLogLine,
          logSource: 'FFMPEG',
          isCancelled,
          onProcessHandle,
          context: { jobId: job?.id, source: 'ConverterPlugin.encode', stage: 'ENCODING' }
        });
      }

      ctx.logger.info('converter:encode:audio:folder:done', {
        jobId: job?.id, fileCount: audioFiles.length, outputDir
      });

      ctx.extra.encodeResult = { outputDir, format: outputFormat, fileCount: audioFiles.length };
    } else {
      // Einzelne Datei
      if (!outputPath) {
        throw new Error('ConverterPlugin._encodeAudio(): outputPath fehlt');
      }
      ensureDir(path.dirname(outputPath));

      ctx.logger.info('converter:encode:audio:file:start', {
        jobId: job?.id, inputPath, outputPath, format: outputFormat
      });
      ctx.emitProgress(0, `Audio: Encoding läuft …`);

      const baseName = path.basename(inputPath, path.extname(inputPath));
      const encodeConfig = buildAudioFfmpegArgs(
        ffmpegCmd, inputPath, outputPath, outputFormat,
        trackMetaOpts(1, baseName)
      );

      await _spawnAndWait({
        cmd: encodeConfig.cmd, args: encodeConfig.args,
        jobId: job?.id,
        appendLogLine: ctx?.extra?.appendLogLine,
        logSource: 'FFMPEG',
        isCancelled,
        onProcessHandle,
        context: { jobId: job?.id, source: 'ConverterPlugin.encode', stage: 'ENCODING' }
      });

      ctx.logger.info('converter:encode:audio:file:done', {
        jobId: job?.id, outputPath
      });

      ctx.extra.encodeResult = { outputPath, format: outputFormat };
    }
  }

  // ── Hilfsmethoden ───────────────────────────────────────────────────────

  async _runCaptured(cmd, args, options = {}) {
    return new Promise((resolve, reject) => {
      const { spawn } = require('child_process');
      let stdout = '';
      let stderr = '';
      const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      child.stdout?.on('data', (chunk) => { stdout += chunk.toString(); });
      child.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });
      child.on('error', reject);
      child.on('close', (code) => resolve({ exitCode: code, stdout, stderr }));
    });
  }

  _parseHandBrakeScan(rawOutput) {
    try {
      const jsonStart = rawOutput.indexOf('{');
      if (jsonStart < 0) return null;
      return JSON.parse(rawOutput.slice(jsonStart));
    } catch (_err) {
      return null;
    }
  }

  async _ffprobeMetadata(ffprobeCmd, filePath, options = {}) {
    const args = [
      '-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', filePath
    ];
    const result = await this._runCaptured(ffprobeCmd, args, options);
    try {
      return JSON.parse(result.stdout);
    } catch (_err) {
      return null;
    }
  }

  getSettingsSchema() {
    return [];
  }
}

async function _spawnAndWait({
  cmd,
  args,
  jobId,
  progressParser,
  onProgress,
  appendLogLine,
  logSource = 'PROCESS',
  isCancelled,
  onProcessHandle,
  context
}) {
  if (typeof isCancelled === 'function' && isCancelled()) {
    const err = new Error('Job wurde vom Benutzer abgebrochen.');
    err.statusCode = 409;
    throw err;
  }

  const handleLine = (stream, line) => {
    if (progressParser && typeof onProgress === 'function') {
      const progress = progressParser(line);
      if (progress?.percent != null) {
        onProgress(progress.percent, progress.detail || null, progress.eta ?? null);
      }
    }
    if (typeof appendLogLine === 'function') {
      try {
        appendLogLine(logSource, line, stream);
      } catch (_error) {
        // ignore log append errors in process stream
      }
    }
  };

  const handle = spawnTrackedProcess({
    cmd,
    args,
    onStdoutLine: (line) => handleLine('stdout', line),
    onStderrLine: (line) => handleLine('stderr', line),
    context: context || { jobId }
  });

  if (typeof onProcessHandle === 'function') {
    onProcessHandle(handle);
  }

  if (typeof isCancelled === 'function' && isCancelled()) {
    handle.cancel();
  }

  try {
    const result = await handle.promise;
    return result;
  } catch (error) {
    if (typeof isCancelled === 'function' && isCancelled()) {
      const cancelError = new Error('Job wurde vom Benutzer abgebrochen.');
      cancelError.statusCode = 409;
      throw cancelError;
    }
    throw error;
  }
}

module.exports = { ConverterPlugin };
