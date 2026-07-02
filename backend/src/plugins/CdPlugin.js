'use strict';

const { SourcePlugin } = require('./PluginBase');
const cdRipService = require('../services/cdRipService');

/**
 * Source-Plugin für Audio-CDs.
 *
 * Delegiert die gesamte Arbeit an den bereits fertig ausgelagerten
 * cdRipService — dieser Plugin ist ein dünner Adapter-Wrapper.
 *
 * CD-Besonderheit: Rip und Encode sind bei CDs Track-für-Track
 * verzahnt (rip track → encode track → nächster Track).
 * Deshalb ist encode() ein No-Op; die gesamte Arbeit liegt in rip().
 *
 * Erwartete ctx.extra-Felder für rip():
 *   ripConfig        - Das ripConfig-Objekt aus dem API-Request (format, formatOptions,
 *                      selectedTracks, tracks, metadata, ...)
 *   rawWavDir        - Absoluter Pfad zum WAV-Temp-/RAW-Ordner
 *   outputDir        - Absoluter Pfad zum finalen Ausgabeordner
 *   outputTemplate   - CD-Output-Template String
 *   isCancelled      - () => boolean — Abbruchsignal vom Orchestrator
 *   onProcessHandle  - Callback mit dem Prozess-Handle (für Abbruch)
 */
class CdPlugin extends SourcePlugin {
  get id() {
    return 'cd';
  }

  get name() {
    return 'Audio CD';
  }

  get priority() {
    return 10;
  }

  /**
   * Erkennt Audio-CDs anhand des mediaProfile-Feldes, das vom
   * DiskDetectionService / diskDetectionService.inferMediaProfile() gesetzt wird.
   *
   * Akzeptierte Werte: 'cd', 'audio_cd'
   */
  detect(discInfo) {
    const profile = String(discInfo?.mediaProfile || '').trim().toLowerCase();
    const fstype = String(discInfo?.fstype || '').trim().toLowerCase();
    return profile === 'cd' || profile === 'audio_cd' || fstype === 'audio_cd';
  }

  /**
   * Liest das TOC der CD mit cdparanoia -Q und gibt die Trackliste zurück.
   *
   * @param {string} devicePath   - z.B. '/dev/sr0'
   * @param {object} job          - Job-Record (id wird für Logging genutzt)
   * @param {PluginContext} ctx
   * @returns {Promise<{tracks: Array, cdparanoiaCmd: string, detectedTitle: string}>}
   */
  async analyze(devicePath, job, ctx) {
    ctx.markExecution('analyze', {
      pluginId: this.id,
      pluginName: this.name,
      pluginFile: 'CdPlugin.js'
    });

    const settings = await ctx.settings.getSettingsMap();
    const cdparanoiaCmd = String(settings.cdparanoia_command || 'cdparanoia').trim() || 'cdparanoia';
    const detectedTitle = String(
      ctx.extra?.discInfo?.discLabel || ctx.extra?.discInfo?.label || ctx.extra?.discInfo?.model || 'Audio CD'
    ).trim();

    ctx.logger.info('cd:analyze:start', { devicePath, jobId: job?.id, detectedTitle });

    const tracks = await cdRipService.readToc(devicePath, cdparanoiaCmd);

    if (!tracks.length) {
      const error = new Error('Keine Audio-Tracks erkannt. Bitte Laufwerk/Medium prüfen (cdparanoia -Q).');
      error.statusCode = 400;
      throw error;
    }

    ctx.logger.info('cd:analyze:done', { devicePath, jobId: job?.id, trackCount: tracks.length });

    return {
      tracks,
      cdparanoiaCmd,
      detectedTitle
    };
  }

  /**
   * Rippt und encodiert alle ausgewählten Tracks der CD.
   *
   * Bei CDs sind Rip und Encode Track-für-Track verzahnt — alles
   * läuft hier in einem einzigen cdRipService.ripAndEncode()-Aufruf.
   *
   * Pflicht-Felder in ctx.extra:
   *   ripConfig        - { format, formatOptions, selectedTracks, tracks, metadata, skipRip, skipEncode }
   *   rawWavDir        - Pfad für temporäre WAV-Dateien (= RAW-Ordner)
   *   outputDir        - Finaler Ausgabeordner (optional bei skipEncode=true)
   *   outputTemplate   - Template-String für Dateinamen
   *   isCancelled      - () => boolean
   *   onProcessHandle  - (handle) => void  [optional]
   *
   * @param {object} job
   * @param {PluginContext} ctx
   * @returns {Promise<{outputDir, format, trackCount, encodeResults}>}
   */
  async rip(job, ctx) {
    ctx.markExecution('rip', {
      pluginId: this.id,
      pluginName: this.name,
      pluginFile: 'CdPlugin.js'
    });

    const {
      ripConfig = {},
      rawWavDir,
      outputDir,
      outputTemplate,
      isCancelled,
      onProcessHandle,
      onProgress: onRawProgress,
      onLog: onExternalLog
    } = ctx.extra || {};

    if (!rawWavDir) {
      throw new Error('CdPlugin.rip(): ctx.extra.rawWavDir fehlt');
    }
    const skipRip = Boolean(ripConfig?.skipRip);
    const skipEncode = Boolean(ripConfig?.skipEncode);

    if (!skipEncode && !outputDir) {
      throw new Error('CdPlugin.rip(): ctx.extra.outputDir fehlt');
    }

    const cdInfo = _safeParseJson(job?.makemkv_info_json) || {};
    const settings = await ctx.settings.getSettingsMap();
    const cdparanoiaCmd = String(cdInfo.cdparanoiaCmd || settings.cdparanoia_command || 'cdparanoia').trim() || 'cdparanoia';
    const devicePath = String(job?.disc_device || '').trim();
    if (!devicePath && !skipRip) {
      throw new Error('CdPlugin.rip(): Kein CD-Gerätepfad im Job gefunden (disc_device leer).');
    }

    const format = String(ripConfig.format || 'flac').trim().toLowerCase();
    const formatOptions = ripConfig.formatOptions || {};
    const effectiveTemplate = outputTemplate || cdRipService.DEFAULT_CD_OUTPUT_TEMPLATE;

    // Trackliste: TOC-Tracks aus DB, optional mit Metadaten aus ripConfig überschrieben
    const tocTracks = Array.isArray(cdInfo.tracks) ? cdInfo.tracks : [];
    const incomingTracks = Array.isArray(ripConfig.tracks) ? ripConfig.tracks : [];
    const incomingByPos = new Map(
      incomingTracks
        .filter((t) => Number.isFinite(Number(t?.position)) && Number(t.position) > 0)
        .map((t) => [Math.trunc(Number(t.position)), t])
    );

    const mergedTracks = tocTracks
      .map((track) => {
        const pos = Math.trunc(Number(track?.position));
        if (!Number.isFinite(pos) || pos <= 0) {
          return null;
        }
        const incoming = incomingByPos.get(pos) || null;
        return {
          ...track,
          position: pos,
          title: incoming?.title || track.title || `Track ${pos}`,
          artist: incoming?.artist || track.artist || null,
          selected: incoming ? Boolean(incoming.selected) : (track.selected !== false)
        };
      })
      .filter(Boolean);

    const selectedMeta = cdInfo.selectedMetadata || {};
    const incomingMeta = (ripConfig.metadata && typeof ripConfig.metadata === 'object')
      ? ripConfig.metadata
      : {};
    const meta = {
      title: _normText(incomingMeta.title) || _normText(selectedMeta.title) || _normText(job?.title) || 'Audio CD',
      artist: _normText(incomingMeta.artist) || _normText(selectedMeta.artist) || null,
      year: _normYear(incomingMeta.year) ?? _normYear(selectedMeta.year) ?? _normYear(job?.year) ?? null,
      album: _normText(incomingMeta.title) || _normText(selectedMeta.title) || _normText(job?.title) || 'Audio CD'
    };

    const rawSelectedPositions = Array.isArray(ripConfig.selectedTracks)
      ? ripConfig.selectedTracks
        .map((v) => Math.trunc(Number(v)))
        .filter((v) => Number.isFinite(v) && v > 0)
      : [];
    const selectedTrackPositions = rawSelectedPositions.length > 0
      ? rawSelectedPositions
      : mergedTracks.filter((t) => t.selected !== false).map((t) => t.position);

    ctx.logger.info('cd:rip:start', {
      jobId: job?.id,
      devicePath: devicePath || null,
      skipRip,
      skipEncode,
      format,
      trackCount: selectedTrackPositions.length
    });

    const result = await cdRipService.ripAndEncode({
      jobId: job?.id,
      devicePath: devicePath || null,
      cdparanoiaCmd,
      rawWavDir,
      outputDir,
      format,
      formatOptions,
      selectedTracks: selectedTrackPositions,
      tracks: mergedTracks,
      meta,
      outputTemplate: effectiveTemplate,
      skipRip,
      skipEncode,
      onProgress: (progressEvent) => {
        if (typeof onRawProgress === 'function') {
          onRawProgress(progressEvent);
        }
        const pct = Number(progressEvent?.percent ?? 0);
        const phase = progressEvent?.phase === 'encode' ? 'Encodiere' : 'Rippe';
        const trackIdx = progressEvent?.trackIndex || 1;
        const trackTotal = progressEvent?.trackTotal || 1;
        ctx.emitProgress(
          Math.round(pct),
          `${phase} Track ${trackIdx}/${trackTotal} …`
        );
      },
      onLog: (level, msg) => {
        if (ctx.logger[level]) {
          ctx.logger[level](msg, { jobId: job?.id });
        }
        if (typeof onExternalLog === 'function') {
          onExternalLog(level, msg);
        }
      },
      onProcessHandle,
      isCancelled,
      context: { jobId: job?.id, source: 'CdPlugin' }
    });

    ctx.logger.info('cd:rip:done', {
      jobId: job?.id,
      format,
      trackCount: result.trackCount,
      outputDir: result.outputDir
    });

    // Ergebnis in ctx.extra ablegen, damit der Orchestrator darauf zugreifen kann
    ctx.extra.ripResult = result;

    return result;
  }

  /**
   * No-Op: Bei CDs ist der Encode-Schritt bereits in rip() integriert.
   */
  async encode(_job, _ctx) {
    _ctx.markExecution('encode', {
      pluginId: this.id,
      pluginName: this.name,
      pluginFile: 'CdPlugin.js'
    });

    // CD Rip und Encode sind in rip() verzahnt — nichts zu tun
  }

  /**
   * CDs brauchen keine Encode-Review (kein HandBrake).
   */
  async review(_job, _ctx) {
    _ctx.markExecution('review', {
      pluginId: this.id,
      pluginName: this.name,
      pluginFile: 'CdPlugin.js'
    });

    return null;
  }

  /**
   * Plugin-spezifische Settings für Audio CDs.
   */
  getSettingsSchema() {
    return [
      {
        key: 'cdparanoia_command',
        category: 'Tools',
        label: 'cdparanoia Kommando',
        type: 'string',
        required: 1,
        description: 'Pfad oder Befehl für cdparanoia. Wird für Audio-CD-Ripping genutzt.',
        default_value: 'cdparanoia',
        options_json: '[]',
        validation_json: '{"minLength":1}',
        order_index: 240
      },
      {
        key: 'cd_output_template',
        category: 'Pfade',
        label: 'CD Output Template',
        type: 'string',
        required: 1,
        description: `Template für relative CD-Ausgabepfade ohne Dateiendung. Platzhalter: {artist}, {album}, {year}, {trackNr}, {title}. Unterordner über "/".`,
        default_value: cdRipService.DEFAULT_CD_OUTPUT_TEMPLATE,
        options_json: '[]',
        validation_json: '{"minLength":1}',
        order_index: 730
      }
    ];
  }
}

// ── Hilfsfunktionen (privat, nicht exportiert) ────────────────────────────────

function _safeParseJson(value) {
  try {
    return value ? JSON.parse(value) : null;
  } catch {
    return null;
  }
}

function _normText(value) {
  const s = String(value == null ? '' : value)
    .normalize('NFC')
    .replace(/[♥❤♡❥❣❦❧]/gu, ' ')
    .replace(/\p{C}+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return s || null;
}

function _normYear(value) {
  if (value === null || value === undefined || String(value).trim() === '') {
    return null;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return Math.trunc(parsed);
}

module.exports = { CdPlugin };
