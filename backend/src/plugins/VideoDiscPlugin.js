'use strict';

const path = require('path');
const { SourcePlugin } = require('./PluginBase');
const tmdbService = require('../services/tmdbService');
const { spawnTrackedProcess } = require('../services/processRunner');
const { parseMakeMkvProgress, parseHandBrakeProgress } = require('../utils/progressParsers');
const { ensureDir } = require('../utils/files');

/**
 * Gemeinsame Basisklasse für Blu-ray und DVD Plugins.
 *
 * Implementiert die gemeinsame Pipeline-Logik für alle Video-Disc-Medien:
 *   analyze()  → TMDb-Suche + Disc-Metadaten vorbereiten
 *   review()   → HandBrake-Scan (liefert rohe Scandaten für den Orchestrator)
 *   rip()      → makemkvcon backup/mkv
 *   encode()   → HandBrakeCLI
 *
 * Subklassen müssen implementieren:
 *   get id()          → 'bluray' | 'dvd'
 *   get name()        → Anzeigename
 *   get mediaProfile() → 'bluray' | 'dvd'
 *   detect(discInfo)  → boolean
 *
 * ctx.extra-Felder für rip():
 *   rawJobDir       - Absoluter Pfad des RAW-Ausgabeordners
 *   deviceInfo      - { path, index, mediaProfile } vom DiskDetectionService
 *   selectedTitleId - MakeMKV-Titel-ID (optional, nur für mkv-Modus)
 *   ripMode         - 'backup' | 'mkv'  (Default: aus Settings)
 *   backupOutputBase - Basisname für DVD-Backup (nur für backup+DVD)
 *   isCancelled     - () => boolean
 *   onProcessHandle - (handle) => void  [optional]
 *
 * ctx.extra-Felder für encode():
 *   inputPath       - Absoluter Pfad zur gerippten Quelldatei/Verzeichnis
 *   outputPath      - Absoluter Pfad des fertigen Ausgabefiles (inkl. Temp-Präfix)
 *   encodePlan      - { handBrakeTitleId, trackSelection, userPreset } aus confirm-Review
 *   isCancelled     - () => boolean
 *   onProcessHandle - (handle) => void  [optional]
 *
 * ctx.extra-Felder für review():
 *   deviceInfo      - Disc-Device (für Pre-Rip-Scan) ODER
 *   rawJobDir       - RAW-Ordner (für Post-Rip-Scan)
 *   reviewMode      - 'pre_rip' | 'rip'  (Default: 'pre_rip')
 */
class VideoDiscPlugin extends SourcePlugin {
  /**
   * Gibt das Media-Profil zurück, das settingsService-Methoden verwenden.
   * Muss von Subklassen implementiert werden.
   * @returns {'bluray'|'dvd'}
   */
  get mediaProfile() {
    throw new Error(`${this.constructor.name}: mediaProfile nicht implementiert`);
  }

  /**
   * Führt eine TMDb-Suche für den erkannten Disc-Titel durch.
   * Gibt { detectedTitle, metadataCandidates } zurück.
   *
   * @param {string} devicePath
   * @param {object} job        - Vorbereiteter Job-Record (noch ohne Metadaten)
   * @param {PluginContext} ctx
   * @returns {Promise<{detectedTitle: string, metadataCandidates: Array}>}
   */
  async analyze(devicePath, job, ctx) {
    ctx.markExecution('analyze', {
      pluginId: this.id,
      pluginName: this.name,
      pluginFile: 'VideoDiscPlugin.js'
    });

    const discInfo = ctx.extra?.discInfo || {};
    const detectedTitle = String(
      discInfo.discLabel || discInfo.label || discInfo.model || job?.detected_title || 'Unknown Disc'
    ).trim();

    ctx.logger.info(`${this.id}:analyze:start`, { devicePath, jobId: job?.id, detectedTitle });

    const metadataCandidates = await tmdbService.searchMoviesWithDetails(detectedTitle).catch((error) => {
      ctx.logger.warn(`${this.id}:analyze:tmdb-failed`, {
        jobId: job?.id,
        error: error?.message || String(error)
      });
      return [];
    });

    ctx.logger.info(`${this.id}:analyze:done`, {
      jobId: job?.id,
      detectedTitle,
      metadataCandidates: metadataCandidates.length
    });

    return { detectedTitle, metadataCandidates };
  }

  /**
   * Führt einen HandBrake-Scan durch und gibt die rohen Scandaten zurück.
   * Der Orchestrator übernimmt die komplexe Auswertung (buildDiscScanReview).
   *
   * ctx.extra.reviewMode:
   *   'pre_rip' → Scan direkt vom Laufwerk (deviceInfo)
   *   'rip'     → Scan aus dem RAW-Ordner (rawJobDir)
   *
   * @param {object} job
   * @param {PluginContext} ctx
   * @returns {Promise<{scanLines: string[], runInfo: object}|null>}
   */
  async review(job, ctx) {
    ctx.markExecution('review', {
      pluginId: this.id,
      pluginName: this.name,
      pluginFile: 'VideoDiscPlugin.js'
    });

    const reviewMode = String(ctx.extra?.reviewMode || 'pre_rip').trim().toLowerCase();
    const deviceInfo = ctx.extra?.deviceInfo || null;
    const rawJobDir = ctx.extra?.rawJobDir || null;

    ctx.logger.info(`${this.id}:review:start`, {
      jobId: job?.id,
      reviewMode,
      deviceInfo: deviceInfo?.path || null,
      rawJobDir: rawJobDir || null
    });

    const settings = await ctx.settings.getEffectiveSettingsMap(this.mediaProfile);

    let scanConfig;
    if (reviewMode === 'rip' && rawJobDir) {
      // Post-Rip scan: scan from the ripped RAW folder
      scanConfig = await ctx.settings.buildHandBrakeScanConfigForInput(rawJobDir, {
        mediaProfile: this.mediaProfile,
        settingsMap: settings
      });
    } else {
      // Pre-Rip scan: scan directly from disc device
      scanConfig = await ctx.settings.buildHandBrakeScanConfig(deviceInfo, {
        mediaProfile: this.mediaProfile,
        settingsMap: settings
      });
    }

    ctx.logger.info(`${this.id}:review:scan-command`, {
      jobId: job?.id,
      cmd: scanConfig.cmd,
      args: scanConfig.args
    });

    const scanLines = [];
    const scanAnalysisLines = [];
    const runCommandFn = typeof ctx.extra?.runCommand === 'function' ? ctx.extra.runCommand : null;
    const reviewStage = String(ctx.extra?.reviewStage || 'MEDIAINFO_CHECK').trim().toUpperCase() || 'MEDIAINFO_CHECK';
    const reviewSource = String(ctx.extra?.reviewSource || 'HANDBRAKE_SCAN').trim().toUpperCase() || 'HANDBRAKE_SCAN';
    const reviewSilent = Boolean(ctx.extra?.reviewSilent);
    let runInfo;
    if (runCommandFn) {
      try {
        runInfo = await runCommandFn({
          jobId: job?.id,
          stage: reviewStage,
          source: reviewSource,
          cmd: scanConfig.cmd,
          args: scanConfig.args,
          collectLines: scanLines,
          // Keep JSON parsing stable by collecting only stdout in scanLines.
          // Stderr is still mirrored into scanAnalysisLines for heuristics.
          collectStderrLines: false,
          onStdoutLine: (line) => scanAnalysisLines.push(line),
          onStderrLine: (line) => scanAnalysisLines.push(line),
          silent: reviewSilent
        });
      } catch (cmdError) {
        // runCommand collected stdout lines via callbacks before throwing.
        // Recover the runInfo from the error so the caller can still parse
        // whatever output HandBrakeCLI produced (e.g. exit code 2 with valid JSON).
        runInfo = cmdError?.runInfo || {
          status: 'ERROR',
          exitCode: typeof cmdError?.code === 'number' ? cmdError.code : 1,
          errorMessage: cmdError?.message || String(cmdError)
        };
      }
    } else {
      runInfo = await _runCommandCaptured({
        cmd: scanConfig.cmd,
        args: scanConfig.args,
        onStdoutLine: (line) => {
          scanLines.push(line);
          scanAnalysisLines.push(line);
        },
        onStderrLine: (line) => scanAnalysisLines.push(line),
        context: { jobId: job?.id, source: `${this.id}Plugin.review` }
      });
    }

    ctx.logger.info(`${this.id}:review:scan-done`, {
      jobId: job?.id,
      exitCode: runInfo.exitCode,
      lineCount: scanAnalysisLines.length
    });

    // Return raw scan data — the Orchestrator (or legacy pipelineService)
    // processes this with buildDiscScanReview() / parseMediainfoJsonOutput().
    return {
      scanLines,
      scanAnalysisLines,
      runInfo,
      reviewMode,
      mediaProfile: this.mediaProfile,
      sourceArg: scanConfig.sourceArg || null
    };
  }

  /**
   * Rippt die Disc mit makemkvcon in den rawJobDir.
   *
   * @param {object} job
   * @param {PluginContext} ctx
   * @returns {Promise<object>} runInfo vom makemkvcon-Prozess
   */
  async rip(job, ctx) {
    ctx.markExecution('rip', {
      pluginId: this.id,
      pluginName: this.name,
      pluginFile: 'VideoDiscPlugin.js'
    });

    const {
      rawJobDir,
      deviceInfo,
      selectedTitleId = null,
      backupOutputBase = null,
      disableMinLengthFilter = false,
      sourceArgOverride = null,
      isCancelled,
      onProcessHandle
    } = ctx.extra || {};

    if (!rawJobDir) {
      throw new Error(`${this.constructor.name}.rip(): ctx.extra.rawJobDir fehlt`);
    }
    if (!deviceInfo) {
      throw new Error(`${this.constructor.name}.rip(): ctx.extra.deviceInfo fehlt`);
    }

    ensureDir(rawJobDir);

    const settings = await ctx.settings.getEffectiveSettingsMap(this.mediaProfile);
    const ripConfig = await ctx.settings.buildMakeMKVRipConfig(rawJobDir, deviceInfo, {
      selectedTitleId,
      mediaProfile: this.mediaProfile,
      settingsMap: settings,
      backupOutputBase,
      disableMinLengthFilter,
      sourceArgOverride
    });

    const ripMode = String(ripConfig.ripMode || settings.makemkv_rip_mode || 'mkv')
      .trim().toLowerCase() === 'backup' ? 'backup' : 'mkv';

    ctx.logger.info(`${this.id}:rip:start`, {
      jobId: job?.id,
      cmd: ripConfig.cmd,
      args: ripConfig.args,
      ripMode,
      rawJobDir,
      selectedTitleId,
      disableMinLengthFilter,
      sourceArgOverride: sourceArgOverride || null
    });

    ctx.emitProgress(0, ripMode === 'backup'
      ? `${this.name}: Backup läuft …`
      : `${this.name}: Ripping läuft …`
    );

    // Pipeline-integrierter Pfad: ctx.extra.runCommand delegiert an this.runCommand()
    // des PipelineService und liefert das volle runInfo (inkl. highlights, stdout-Log,
    // Prozess-Tracking, Cancellation). Fallback: _spawnAndWait für Standalone/Tests.
    const runCommandFn = typeof ctx.extra?.runCommand === 'function' ? ctx.extra.runCommand : null;
    const makeMkvLineFilter = typeof ctx.extra?.makeMkvLineFilter === 'function'
      ? ctx.extra.makeMkvLineFilter
      : null;
    let runInfo;
    if (runCommandFn) {
      runInfo = await runCommandFn({
        jobId: job?.id,
        stage: 'RIPPING',
        source: 'MAKEMKV_RIP',
        cmd: ripConfig.cmd,
        args: ripConfig.args,
        parser: parseMakeMkvProgress,
        lineFilter: makeMkvLineFilter
      });
    } else {
      runInfo = await _spawnAndWait({
        cmd: ripConfig.cmd,
        args: ripConfig.args,
        cwd: rawJobDir,
        jobId: job?.id,
        progressParser: parseMakeMkvProgress,
        onProgress: (pct, statusText) => ctx.emitProgress(Math.round(pct), statusText),
        isCancelled,
        onProcessHandle,
        context: { jobId: job?.id, source: `${this.id}Plugin.rip`, stage: 'RIPPING' }
      });
    }

    ctx.logger.info(`${this.id}:rip:done`, {
      jobId: job?.id,
      rawJobDir,
      exitCode: runInfo?.exitCode ?? runInfo?.code ?? null
    });

    ctx.extra.ripRunInfo = runInfo;
    return runInfo;
  }

  /**
   * Encodiert die gerippten Dateien mit HandBrakeCLI.
   *
   * @param {object} job
   * @param {PluginContext} ctx
   * @returns {Promise<object>} runInfo vom HandBrake-Prozess
   */
  async encode(job, ctx) {
    ctx.markExecution('encode', {
      pluginId: this.id,
      pluginName: this.name,
      pluginFile: 'VideoDiscPlugin.js'
    });

    const {
      inputPath,
      outputPath,
      encodePlan = {},
      isCancelled,
      onProcessHandle
    } = ctx.extra || {};

    if (!inputPath) {
      throw new Error(`${this.constructor.name}.encode(): ctx.extra.inputPath fehlt`);
    }
    if (!outputPath) {
      throw new Error(`${this.constructor.name}.encode(): ctx.extra.outputPath fehlt`);
    }

    ensureDir(path.dirname(outputPath));

    const settings = await ctx.settings.getEffectiveSettingsMap(this.mediaProfile);
    const handBrakeConfig = await ctx.settings.buildHandBrakeConfig(inputPath, outputPath, {
      trackSelection: encodePlan.trackSelection || null,
      titleId: encodePlan.handBrakeTitleId || null,
      mediaProfile: this.mediaProfile,
      settingsMap: settings,
      userPreset: encodePlan.userPreset || null
    });

    ctx.logger.info(`${this.id}:encode:start`, {
      jobId: job?.id,
      cmd: handBrakeConfig.cmd,
      args: handBrakeConfig.args,
      titleId: encodePlan.handBrakeTitleId || null
    });

    ctx.emitProgress(0, `${this.name}: Encoding läuft …`);

    const runCommandFn = typeof ctx.extra?.runCommand === 'function' ? ctx.extra.runCommand : null;
    const encodeSource = String(ctx.extra?.encodeSource || 'HANDBRAKE').trim().toUpperCase() || 'HANDBRAKE';
    const encodeStage = String(ctx.extra?.encodeStage || 'ENCODING').trim().toUpperCase() || 'ENCODING';
    const encodeParser = typeof ctx.extra?.progressParser === 'function'
      ? ctx.extra.progressParser
      : parseHandBrakeProgress;

    let runInfo;
    if (runCommandFn) {
      runInfo = await runCommandFn({
        jobId: job?.id,
        stage: encodeStage,
        source: encodeSource,
        cmd: handBrakeConfig.cmd,
        args: handBrakeConfig.args,
        parser: encodeParser
      });
    } else {
      runInfo = await _spawnAndWait({
        cmd: handBrakeConfig.cmd,
        args: handBrakeConfig.args,
        jobId: job?.id,
        progressParser: parseHandBrakeProgress,
        onProgress: (pct, statusText) => ctx.emitProgress(Math.round(pct), statusText || `${this.name}: Encoding ${pct}%`),
        isCancelled,
        onProcessHandle,
        context: { jobId: job?.id, source: `${this.id}Plugin.encode`, stage: 'ENCODING' }
      });
    }

    ctx.logger.info(`${this.id}:encode:done`, {
      jobId: job?.id,
      outputPath,
      exitCode: runInfo.exitCode
    });

    ctx.extra.encodeRunInfo = runInfo;
    return runInfo;
  }

  /**
   * Plugin-spezifische Settings (gemeinsam für BluRay + DVD, via this.mediaProfile).
   */
  getSettingsSchema() {
    const profile = this.mediaProfile;
    const label = profile === 'bluray' ? 'Blu-ray' : 'DVD';
    const orderBase = profile === 'bluray' ? 200 : 220;

    return [
      {
        key: `handbrake_preset_${profile}`,
        category: 'Tools',
        label: `HandBrake Preset (${label})`,
        type: 'string',
        required: 0,
        description: `Preset Name für -Z (${label}). Leer = kein Preset, nur CLI-Parameter werden verwendet.`,
        default_value: null,
        options_json: '[]',
        validation_json: '{}',
        order_index: orderBase
      },
      {
        key: `output_extension_${profile}`,
        category: 'Tools',
        label: `Ausgabe-Format (${label})`,
        type: 'select',
        required: 1,
        description: `Dateiendung des encodierten ${label}-Outputs.`,
        default_value: 'mkv',
        options_json: '["mkv","mp4"]',
        validation_json: '{}',
        order_index: orderBase + 1
      },
      {
        key: `output_template_${profile}`,
        category: 'Pfade',
        label: `Output Template (${label})`,
        type: 'string',
        required: 1,
        description: `Template für relative ${label}-Ausgabepfade ohne Dateiendung. Platzhalter: {title}, {year}. Unterordner über "/".`,
        default_value: '{title} ({year})/{title} ({year})',
        options_json: '[]',
        validation_json: '{"minLength":1}',
        order_index: 700 + (profile === 'bluray' ? 0 : 5)
      }
    ];
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

async function _runCommandCaptured({ cmd, args, onStdoutLine, onStderrLine, context }) {
  const lines = [];
  const handle = spawnTrackedProcess({
    cmd,
    args,
    onStdoutLine: (line) => {
      lines.push(line);
      if (typeof onStdoutLine === 'function') {
        onStdoutLine(line);
      }
    },
    onStderrLine: (line) => {
      lines.push(line);
      if (typeof onStderrLine === 'function') {
        onStderrLine(line);
      }
    },
    context: context || {}
  });

  try {
    await handle.promise;
    return { exitCode: 0, lines };
  } catch (error) {
    return {
      exitCode: typeof error?.code === 'number' ? error.code : 1,
      lines,
      error: error?.message || String(error)
    };
  }
}

async function _spawnAndWait({ cmd, args, cwd, jobId, progressParser, onProgress, isCancelled, onProcessHandle, context }) {
  _assertNotCancelled(isCancelled);

  const handle = spawnTrackedProcess({
    cmd,
    args,
    cwd,
    onStdoutLine: (line) => {
      if (progressParser && typeof onProgress === 'function') {
        const progress = progressParser(line);
        if (progress?.percent != null) {
          onProgress(progress.percent, progress.statusText || null);
        }
      }
    },
    onStderrLine: (line) => {
      if (progressParser && typeof onProgress === 'function') {
        const progress = progressParser(line);
        if (progress?.percent != null) {
          onProgress(progress.percent, progress.statusText || null);
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

module.exports = { VideoDiscPlugin };
