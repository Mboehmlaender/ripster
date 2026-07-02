'use strict';

const { SourcePlugin } = require('./PluginBase');
const dvdSeriesScanService = require('../services/dvdSeriesScanService');
const tmdbService = require('../services/tmdbService');

/**
 * Companion-Plugin für Serien-DVDs.
 *
 * Dieses Plugin ersetzt den bestehenden DVDPlugin-Flow nicht. Es wird in einem
 * späteren Schritt explizit aus dem DVD-Flow aufgerufen, sobald ein Prescan eine
 * serientypische Titelstruktur vermuten lässt.
 */
class DVDSeriesPlugin extends SourcePlugin {
  get id() {
    return 'dvd_series';
  }

  get name() {
    return 'DVD Series';
  }

  detect() {
    return false;
  }

  async analyze(_devicePath, job, ctx) {
    ctx.markExecution('analyze', {
      pluginId: this.id,
      pluginName: this.name,
      pluginFile: 'DVDSeriesPlugin.js'
    });

    const fallbackSeriesLookupHint = dvdSeriesScanService.deriveSeriesLookupHint([
      {
        value: ctx.extra?.detectedTitle || '',
        source: 'detected_title'
      }
    ]);

    const scanText = String(ctx.extra?.scanText || '').trim();
    if (!scanText) {
      return {
        parsedScan: null,
        seriesAnalysis: null,
        seriesLookupHint: fallbackSeriesLookupHint,
        providerConfigured: await tmdbService.isConfigured()
      };
    }

    const result = dvdSeriesScanService.analyzeHandBrakeScan(scanText, ctx.extra?.seriesOptions || {});
    const seriesLookupHint = dvdSeriesScanService.deriveSeriesLookupHint([
      {
        value: result?.parsed?.discTitle || '',
        source: 'handbrake_disc_title'
      },
      {
        value: ctx.extra?.detectedTitle || '',
        source: 'detected_title'
      }
    ]) || fallbackSeriesLookupHint;
    return {
      parsedScan: result.parsed,
      seriesAnalysis: result.analysis,
      seriesLookupHint,
      providerConfigured: await tmdbService.isConfigured()
    };
  }

  async review(_job, ctx) {
    ctx.markExecution('review', {
      pluginId: this.id,
      pluginName: this.name,
      pluginFile: 'DVDSeriesPlugin.js'
    });
    return null;
  }

  async rip() {
    throw new Error('DVDSeriesPlugin.rip() ist ein Companion-Plugin und wird nicht direkt ausgeführt.');
  }

  async encode() {
    throw new Error('DVDSeriesPlugin.encode() ist ein Companion-Plugin und wird nicht direkt ausgeführt.');
  }

  async searchSeries(query, options = {}) {
    return tmdbService.searchSeries(query, options);
  }

  async searchSeriesWithSeason(query, seasonNumber, options = {}) {
    return tmdbService.searchSeriesWithSeason(query, seasonNumber, options);
  }

  getSettingsSchema() {
    return [
      {
        key: 'tmdb_api_read_access_token',
        category: 'Metadaten',
        label: 'TMDb Read Access Token',
        type: 'string',
        required: 0,
        description: 'Read Access Token für Serien-Metadaten über TheMovieDB (TMDb).',
        default_value: null,
        options_json: '[]',
        validation_json: '{}',
        order_index: 401
      }
    ];
  }
}

module.exports = { DVDSeriesPlugin };
