'use strict';

const path = require('path');
const fs = require('fs');
const { SourcePlugin } = require('./PluginBase');
const audiobookService = require('../services/audiobookService');
const { spawnTrackedProcess } = require('../services/processRunner');
const { ensureDir } = require('../utils/files');

/**
 * Source-Plugin für Audiobooks (AAX-Dateien).
 *
 * Audiobooks unterscheiden sich von Disc-Medien grundlegend:
 * - Kein Laufwerk — der Nutzer lädt eine .aax-Datei hoch
 * - Kein Rip-Schritt — die AAX-Datei ist der Input
 * - Encode mit ffmpeg (Gesamt oder kapitelweise)
 *
 * Deshalb:
 *   rip()    → No-Op (Datei liegt bereits im rawDir)
 *   review() → null (kein HandBrake-Preview)
 *   encode() → ffmpeg Single-File oder kapitelweise
 *
 * detect() prüft das mediaProfile-Feld (gesetzt vom Orchestrator für
 * Datei-Uploads) oder eine Dateiendung im discInfo.
 *
 * Pflicht-Felder in ctx.extra für analyze():
 *   filePath         - Absoluter Pfad zur .aax-Datei
 *
 * Pflicht-Felder in ctx.extra für encode():
 *   inputPath        - Absoluter Pfad zur .aax-Input-Datei
 *   outputPath       - Absoluter Pfad für die Ausgabe (Datei oder Verzeichnis)
 *   outputFormat     - 'm4b' | 'mp3' | 'flac'
 *   formatOptions    - Encoder-Optionen { flacCompression, mp3Mode, mp3Bitrate, ... }
 *   metadata         - Metadata-Objekt aus analyze() oder encode_plan_json
 *   activationBytes  - AAX-Aktivierungsbytes (String, kann null sein bei nicht-DRM)
 *   isSplitOutput    - boolean: true = kapitelweise, false = Einzel-Datei
 *   chapterPlan      - { outputFiles, chapters } — nur benötigt wenn isSplitOutput = true
 *   isCancelled      - () => boolean
 *   onProcessHandle  - (handle) => void  [optional]
 */
class AudiobookPlugin extends SourcePlugin {
  get id() {
    return 'audiobook';
  }

  get name() {
    return 'Audiobook (AAX)';
  }

  get priority() {
    return 5;
  }

  /**
   * Erkennt Audiobooks.
   * Wird entweder via mediaProfile ('audiobook') oder Dateiendung erkannt.
   */
  detect(discInfo) {
    const profile = String(discInfo?.mediaProfile || '').trim().toLowerCase();
    if (profile === 'audiobook' || profile === 'audio_book') {
      return true;
    }
    const ext = path.extname(String(discInfo?.filePath || discInfo?.fileName || '')).trim().toLowerCase();
    return audiobookService.SUPPORTED_INPUT_EXTENSIONS.has(ext);
  }

  /**
   * Analysiert eine .aax-Datei mit ffprobe.
   * Gibt die extrahierten Metadaten zurück (Titel, Autor, Kapitel, Cover, etc.).
   *
   * @param {string} filePath  - Pfad zur .aax-Datei (in ctx.extra.filePath ODER als devicePath)
   * @param {object} job
   * @param {PluginContext} ctx
   * @returns {Promise<object>} Metadata-Objekt aus audiobookService.buildMetadataFromProbe()
   */
  async analyze(filePath, job, ctx) {
    ctx.markExecution('analyze', {
      pluginId: this.id,
      pluginName: this.name,
      pluginFile: 'AudiobookPlugin.js'
    });

    const inputPath = ctx.extra?.filePath || filePath;

    if (!inputPath || !fs.existsSync(inputPath)) {
      const error = new Error(`AudiobookPlugin.analyze(): Datei nicht gefunden: ${inputPath}`);
      error.statusCode = 400;
      throw error;
    }

    const settings = await ctx.settings.getSettingsMap();
    const ffprobeCommand = String(settings.ffprobe_command || 'ffprobe').trim() || 'ffprobe';
    const originalName = path.basename(inputPath);

    ctx.logger.info('audiobook:analyze:start', { jobId: job?.id, inputPath, ffprobeCommand });

    const probeConfig = audiobookService.buildProbeCommand(ffprobeCommand, inputPath);
    const captured = await _runCaptured(probeConfig.cmd, probeConfig.args, { jobId: job?.id });

    const probe = audiobookService.parseProbeOutput(captured.stdout);
    if (!probe) {
      const error = new Error('FFprobe-Ausgabe konnte nicht gelesen werden (kein gültiges JSON).');
      error.statusCode = 500;
      throw error;
    }

    const metadata = audiobookService.buildMetadataFromProbe(probe, originalName);

    ctx.logger.info('audiobook:analyze:done', {
      jobId: job?.id,
      title: metadata.title,
      author: metadata.author,
      chapterCount: metadata.chapters?.length || 0,
      durationMs: metadata.durationMs
    });

    return metadata;
  }

  /**
   * No-Op: Audiobooks haben keinen Rip-Schritt.
   * Die .aax-Datei wurde bereits beim Upload ins rawDir verschoben.
   */
  async rip(_job, _ctx) {
    _ctx.markExecution('rip', {
      pluginId: this.id,
      pluginName: this.name,
      pluginFile: 'AudiobookPlugin.js'
    });

    // Für Audiobooks gibt es keinen separaten Rip-Schritt
  }

  /**
   * Encodiert die .aax-Datei mit ffmpeg — als Einzel-Datei oder kapitelweise.
   *
   * @param {object} job
   * @param {PluginContext} ctx
   * @returns {Promise<{outputPath: string, format: string, chapterCount: number}>}
   */
  async encode(job, ctx) {
    ctx.markExecution('encode', {
      pluginId: this.id,
      pluginName: this.name,
      pluginFile: 'AudiobookPlugin.js'
    });

    const settings = await ctx.settings.getSettingsMap();
    if (!settings.audiobook_encoding_enabled) {
      ctx.logger.info('audiobook:encode:disabled', { jobId: job?.id });
      return;
    }

    const {
      inputPath,
      outputPath,
      outputFormat = 'mp3',
      formatOptions = {},
      metadata = {},
      activationBytes = null,
      isSplitOutput = false,
      chapterPlan = null,
      isCancelled,
      onProcessHandle
    } = ctx.extra || {};

    if (!inputPath) {
      throw new Error('AudiobookPlugin.encode(): ctx.extra.inputPath fehlt');
    }
    if (!outputPath) {
      throw new Error('AudiobookPlugin.encode(): ctx.extra.outputPath fehlt');
    }
    if (!fs.existsSync(inputPath)) {
      const error = new Error(`AudiobookPlugin.encode(): Input-Datei nicht gefunden: ${inputPath}`);
      error.statusCode = 400;
      throw error;
    }

    const ffmpegCommand = String(settings.ffmpeg_command || 'ffmpeg').trim() || 'ffmpeg';
    const normalizedFormat = audiobookService.normalizeOutputFormat(outputFormat);
    const normalizedOptions = audiobookService.normalizeFormatOptions(normalizedFormat, formatOptions);

    ctx.logger.info('audiobook:encode:start', {
      jobId: job?.id,
      format: normalizedFormat,
      isSplitOutput,
      inputPath
    });

    if (isSplitOutput) {
      await this._encodeChapters({
        job, ctx, ffmpegCommand, inputPath, chapterPlan,
        normalizedFormat, normalizedOptions, metadata, activationBytes,
        isCancelled, onProcessHandle
      });
    } else {
      await this._encodeSingleFile({
        job, ctx, ffmpegCommand, inputPath, outputPath,
        normalizedFormat, normalizedOptions, metadata, activationBytes,
        isCancelled, onProcessHandle
      });
    }

    ctx.logger.info('audiobook:encode:done', {
      jobId: job?.id,
      format: normalizedFormat,
      outputPath
    });

    ctx.extra.encodeResult = {
      outputPath,
      format: normalizedFormat,
      chapterCount: isSplitOutput
        ? (chapterPlan?.outputFiles?.length || 0)
        : 1
    };

    return ctx.extra.encodeResult;
  }

  /**
   * Audiobooks brauchen keine Encode-Review (kein HandBrake).
   */
  async review(_job, _ctx) {
    _ctx.markExecution('review', {
      pluginId: this.id,
      pluginName: this.name,
      pluginFile: 'AudiobookPlugin.js'
    });

    return null;
  }

  /**
   * Plugin-spezifische Settings für Audiobooks.
   */
  getSettingsSchema() {
    return [
      {
        key: 'audiobook_encoding_enabled',
        category: 'Features',
        label: 'Audiobook Encoding',
        type: 'boolean',
        required: 1,
        description: 'Audiobook-Encoding über das Plugin aktivieren.',
        default_value: 'true',
        options_json: '[]',
        validation_json: '{}',
        order_index: 100
      },
      {
        key: 'ffmpeg_command',
        category: 'Tools',
        label: 'FFmpeg Kommando',
        type: 'string',
        required: 1,
        description: 'Pfad oder Befehl für ffmpeg. Wird für Audiobook-Encoding genutzt.',
        default_value: 'ffmpeg',
        options_json: '[]',
        validation_json: '{"minLength":1}',
        order_index: 232
      },
      {
        key: 'ffprobe_command',
        category: 'Tools',
        label: 'FFprobe Kommando',
        type: 'string',
        required: 1,
        description: 'Pfad oder Befehl für ffprobe. Wird für Audiobook-Metadaten und Kapitel genutzt.',
        default_value: 'ffprobe',
        options_json: '[]',
        validation_json: '{"minLength":1}',
        order_index: 233
      },
      {
        key: 'output_template_audiobook',
        category: 'Pfade',
        label: 'Output Template (Audiobook)',
        type: 'string',
        required: 1,
        description: 'Template für relative Audiobook-Ausgabepfade ohne Dateiendung. Platzhalter: {author}, {title}, {year}, {narrator}, {series}, {part}, {format}. Unterordner über "/".',
        default_value: audiobookService.DEFAULT_AUDIOBOOK_OUTPUT_TEMPLATE,
        options_json: '[]',
        validation_json: '{"minLength":1}',
        order_index: 735
      }
    ];
  }

  // ── Private Encode-Methoden ──────────────────────────────────────────────────

  async _encodeSingleFile({ job, ctx, ffmpegCommand, inputPath, outputPath, normalizedFormat, normalizedOptions, metadata, activationBytes, isCancelled, onProcessHandle }) {
    ensureDir(path.dirname(outputPath));

    const ffmpegConfig = audiobookService.buildEncodeCommand(
      ffmpegCommand,
      inputPath,
      outputPath,
      normalizedFormat,
      normalizedOptions,
      { activationBytes, metadata }
    );

    ctx.logger.info('audiobook:encode:single-file', {
      jobId: job?.id,
      cmd: ffmpegConfig.cmd,
      outputPath
    });

    const progressParser = audiobookService.buildProgressParser(metadata?.durationMs || 0);
    await _spawnAndWait({
      cmd: ffmpegConfig.cmd,
      args: ffmpegConfig.args,
      jobId: job?.id,
      progressParser,
      onProgress: (pct) => ctx.emitProgress(Math.round(pct), 'Audiobook wird encodiert …'),
      isCancelled,
      onProcessHandle,
      context: { jobId: job?.id, source: 'AudiobookPlugin' }
    });
  }

  async _encodeChapters({ job, ctx, ffmpegCommand, inputPath, chapterPlan, normalizedFormat, normalizedOptions, metadata, activationBytes, isCancelled, onProcessHandle }) {
    const outputFiles = Array.isArray(chapterPlan?.outputFiles) ? chapterPlan.outputFiles : [];
    if (outputFiles.length === 0) {
      throw new Error('AudiobookPlugin: Keine Kapitel im chapterPlan für kapitelweise Ausgabe.');
    }

    for (let index = 0; index < outputFiles.length; index++) {
      _assertNotCancelled(isCancelled);

      const entry = outputFiles[index];
      const chapter = entry?.chapter || {};
      const chapterTitle = String(chapter?.title || `Kapitel ${index + 1}`).trim();
      const startPct = (index / outputFiles.length) * 100;
      const endPct = ((index + 1) / outputFiles.length) * 100;

      ensureDir(path.dirname(entry.outputPath));

      const ffmpegConfig = audiobookService.buildChapterEncodeCommand(
        ffmpegCommand,
        inputPath,
        entry.outputPath,
        normalizedFormat,
        normalizedOptions,
        metadata,
        chapter,
        outputFiles.length,
        { activationBytes }
      );

      ctx.logger.info('audiobook:encode:chapter', {
        jobId: job?.id,
        chapterIndex: index + 1,
        chapterTotal: outputFiles.length,
        chapterTitle,
        outputPath: entry.outputPath
      });

      const baseParser = audiobookService.buildProgressParser(chapter?.durationMs || 0);
      const scaledParser = baseParser
        ? (line) => {
          const progress = baseParser(line);
          if (!progress || progress.percent == null) {
            return null;
          }
          return {
            percent: startPct + (endPct - startPct) * (progress.percent / 100),
            eta: null
          };
        }
        : null;

      ctx.emitProgress(
        Math.round(startPct),
        `Audiobook-Encoding Kapitel ${index + 1}/${outputFiles.length}: ${chapterTitle}`
      );

      await _spawnAndWait({
        cmd: ffmpegConfig.cmd,
        args: ffmpegConfig.args,
        jobId: job?.id,
        progressParser: scaledParser,
        onProgress: (pct) => ctx.emitProgress(
          Math.round(pct),
          `Audiobook-Encoding Kapitel ${index + 1}/${outputFiles.length}: ${chapterTitle}`
        ),
        isCancelled,
        onProcessHandle,
        context: { jobId: job?.id, source: 'AudiobookPlugin', chapterIndex: index + 1 }
      });
    }
  }
}

// ── Hilfsfunktionen (privat) ─────────────────────────────────────────────────

function _assertNotCancelled(isCancelled) {
  if (typeof isCancelled === 'function' && isCancelled()) {
    const error = new Error('Job wurde vom Benutzer abgebrochen.');
    error.statusCode = 409;
    throw error;
  }
}

async function _runCaptured(cmd, args, _context = {}) {
  const { execFile } = require('child_process');
  const { promisify } = require('util');
  const execFileAsync = promisify(execFile);
  try {
    return await execFileAsync(cmd, args, { timeout: 30000, maxBuffer: 8 * 1024 * 1024 });
  } catch (error) {
    // execFile wirft bei non-zero exit; stdout/stderr können trotzdem valide sein
    return {
      stdout: String(error?.stdout || ''),
      stderr: String(error?.stderr || ''),
      exitCode: error?.code ?? 1
    };
  }
}

async function _spawnAndWait({ cmd, args, jobId, progressParser, onProgress, isCancelled, onProcessHandle, context }) {
  _assertNotCancelled(isCancelled);

  const handle = spawnTrackedProcess({
    cmd,
    args,
    onStdoutLine: () => {},
    onStderrLine: (line) => {
      if (progressParser && typeof onProgress === 'function') {
        const progress = progressParser(line);
        if (progress?.percent != null) {
          onProgress(progress.percent);
        }
      }
    },
    context: context || { jobId }
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
      const cancelError = new Error('Job wurde vom Benutzer abgebrochen.');
      cancelError.statusCode = 409;
      throw cancelError;
    }
    throw error;
  }
}

module.exports = { AudiobookPlugin };
