const { getDb } = require('../db/database');
const logger = require('./logger').child('COVERART_RECOVERY');
const settingsService = require('./settingsService');
const historyService = require('./historyService');
const thumbnailService = require('./thumbnailService');

const COVERART_RECOVERY_ENABLED_KEY = 'coverart_recovery_enabled';
const COVERART_RECOVERY_INTERVAL_HOURS_KEY = 'coverart_recovery_interval_hours';
const DEFAULT_INTERVAL_HOURS = 6;
const MIN_INTERVAL_HOURS = 1;
const MAX_INTERVAL_HOURS = 168;
const RUNNING_JOB_STATUSES = new Set([
  'ANALYZING',
  'RIPPING',
  'MEDIAINFO_CHECK',
  'ENCODING',
  'CD_ANALYZING',
  'CD_RIPPING',
  'CD_ENCODING'
]);

function parseJsonSafe(raw, fallback = null) {
  if (!raw) {
    return fallback;
  }
  try {
    return JSON.parse(raw);
  } catch (_error) {
    return fallback;
  }
}

function toBoolean(value, fallback = false) {
  if (value === null || value === undefined) {
    return fallback;
  }
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return value !== 0;
  }
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) {
    return fallback;
  }
  return ['1', 'true', 'yes', 'on'].includes(normalized);
}

function normalizeIntervalHours(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_INTERVAL_HOURS;
  }
  return Math.max(MIN_INTERVAL_HOURS, Math.min(MAX_INTERVAL_HOURS, Math.trunc(parsed)));
}

function normalizeExternalUrl(value) {
  const normalized = String(value || '').trim();
  if (!normalized) {
    return null;
  }
  if (!/^https?:\/\//i.test(normalized)) {
    return null;
  }
  return normalized;
}

function deriveCoverArtArchiveUrl(mbId) {
  const normalized = String(mbId || '').trim();
  if (!normalized) {
    return null;
  }
  return `https://coverartarchive.org/release/${encodeURIComponent(normalized)}/front-250`;
}

function isLikelyMusicBrainzId(value) {
  const normalized = String(value || '').trim();
  if (!normalized) {
    return false;
  }
  if (/^tt\d{6,12}$/i.test(normalized)) {
    return false;
  }
  return /^[a-z0-9-]{8,}$/i.test(normalized);
}

function collectCoverCandidates(row) {
  const candidates = [];
  const seen = new Set();
  const push = (url, source) => {
    const normalized = normalizeExternalUrl(url);
    if (!normalized) {
      return;
    }
    const dedupeKey = normalized.toLowerCase();
    if (seen.has(dedupeKey)) {
      return;
    }
    seen.add(dedupeKey);
    candidates.push({
      url: normalized,
      source: String(source || '').trim() || null
    });
  };

  push(row?.poster_url, 'job.poster_url');

  const makemkvInfo = parseJsonSafe(row?.makemkv_info_json, {});
  const selectedMetadata = makemkvInfo?.selectedMetadata && typeof makemkvInfo.selectedMetadata === 'object'
    ? makemkvInfo.selectedMetadata
    : {};

  push(selectedMetadata?.coverUrl, 'selectedMetadata.coverUrl');
  push(selectedMetadata?.poster, 'selectedMetadata.poster');
  push(selectedMetadata?.posterUrl, 'selectedMetadata.posterUrl');

  const mbId = String(
    selectedMetadata?.mbId
    || selectedMetadata?.musicBrainzId
    || selectedMetadata?.musicbrainzId
    || selectedMetadata?.musicbrainz_id
    || selectedMetadata?.music_brainz_id
    || selectedMetadata?.musicbrainz
    || selectedMetadata?.mbid
    || row?.imdb_id
    || ''
  ).trim();
  if (isLikelyMusicBrainzId(mbId)) {
    push(deriveCoverArtArchiveUrl(mbId), 'musicbrainz.coverartarchive');
  }

  return candidates;
}

class CoverArtRecoveryService {
  constructor() {
    this.timer = null;
    this.inFlight = null;
    this.nextRunAt = null;
    this.schedulerEnabled = false;
    this.intervalHours = DEFAULT_INTERVAL_HOURS;
    this.lastRunSummary = null;
  }

  getStatus() {
    return {
      enabled: this.schedulerEnabled,
      intervalHours: this.intervalHours,
      nextRunAt: this.nextRunAt,
      running: Boolean(this.inFlight),
      lastRunSummary: this.lastRunSummary
    };
  }

  stop() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.nextRunAt = null;
  }

  async init() {
    await this.refreshSchedule({ runStartupCheck: true });
  }

  async handleSettingsChanged(changedKeys = []) {
    const normalizedKeys = Array.isArray(changedKeys)
      ? changedKeys.map((key) => String(key || '').trim().toLowerCase()).filter(Boolean)
      : [];
    if (
      normalizedKeys.length > 0
      && !normalizedKeys.includes(COVERART_RECOVERY_ENABLED_KEY)
      && !normalizedKeys.includes(COVERART_RECOVERY_INTERVAL_HOURS_KEY)
    ) {
      return this.getStatus();
    }
    return this.refreshSchedule({ runStartupCheck: false });
  }

  async refreshSchedule(options = {}) {
    const runStartupCheck = options?.runStartupCheck !== false;
    this.stop();

    const settings = await settingsService.getSettingsMap();
    this.schedulerEnabled = toBoolean(settings?.[COVERART_RECOVERY_ENABLED_KEY], true);
    this.intervalHours = normalizeIntervalHours(settings?.[COVERART_RECOVERY_INTERVAL_HOURS_KEY]);

    logger.info('scheduler:refresh', {
      enabled: this.schedulerEnabled,
      intervalHours: this.intervalHours,
      runStartupCheck
    });

    if (this.schedulerEnabled && runStartupCheck) {
      this.runNow({ trigger: 'startup' }).catch((error) => {
        logger.warn('scheduler:startup-run-failed', {
          error: error?.message || String(error)
        });
      });
    }

    if (this.schedulerEnabled) {
      this.scheduleNextAutoRun();
    }
    return this.getStatus();
  }

  scheduleNextAutoRun() {
    this.stop();
    if (!this.schedulerEnabled) {
      return;
    }
    const delayMs = this.intervalHours * 60 * 60 * 1000;
    this.nextRunAt = new Date(Date.now() + delayMs).toISOString();
    this.timer = setTimeout(() => {
      this.runNow({ trigger: 'auto' })
        .catch((error) => {
          logger.warn('scheduler:auto-run-failed', {
            error: error?.message || String(error)
          });
        })
        .finally(() => {
          this.scheduleNextAutoRun();
        });
    }, delayMs);
  }

  async runNow(options = {}) {
    if (this.inFlight) {
      return this.inFlight;
    }
    let promise = null;
    promise = this._runNowInternal(options)
      .finally(() => {
        if (this.inFlight === promise) {
          this.inFlight = null;
        }
      });
    this.inFlight = promise;
    return promise;
  }

  async _runNowInternal(options = {}) {
    const trigger = String(options?.trigger || 'manual').trim().toLowerCase() || 'manual';
    const force = Boolean(options?.force);
    const logFailures = options?.logFailures !== false;
    const startedMs = Date.now();
    const startedAt = new Date().toISOString();
    const settings = await settingsService.getSettingsMap();
    const enabled = toBoolean(settings?.[COVERART_RECOVERY_ENABLED_KEY], true);

    if (!enabled && !force) {
      const skipped = {
        trigger,
        startedAt,
        finishedAt: new Date().toISOString(),
        durationMs: 0,
        skipped: true,
        reason: 'disabled'
      };
      this.lastRunSummary = skipped;
      return skipped;
    }

    const db = await getDb();
    const rows = await db.all(
      `
        SELECT
          id,
          title,
          detected_title,
          status,
          poster_url,
          imdb_id,
          makemkv_info_json
        FROM jobs
        ORDER BY COALESCE(updated_at, created_at) DESC, id DESC
      `
    );

    const summary = {
      trigger,
      startedAt,
      finishedAt: null,
      durationMs: 0,
      scannedJobs: Array.isArray(rows) ? rows.length : 0,
      runningSkipped: 0,
      alreadyLocal: 0,
      noCandidate: 0,
      recovered: 0,
      failed: 0,
      failedJobs: []
    };

    for (const row of rows || []) {
      const jobId = Number(row?.id || 0);
      if (!jobId) {
        continue;
      }

      const status = String(row?.status || '').trim().toUpperCase();
      if (RUNNING_JOB_STATUSES.has(status)) {
        summary.runningSkipped += 1;
        continue;
      }

      const currentPosterUrl = String(row?.poster_url || '').trim();
      if (
        currentPosterUrl
        && thumbnailService.isLocalUrl(currentPosterUrl)
        && thumbnailService.localThumbnailUrlExists(currentPosterUrl)
      ) {
        summary.alreadyLocal += 1;
        continue;
      }

      const candidates = collectCoverCandidates(row);
      if (candidates.length === 0) {
        summary.noCandidate += 1;
        continue;
      }

      let recovered = false;
      let lastError = null;
      for (const candidate of candidates) {
        const result = await historyService.cacheAndPromoteExternalPoster(jobId, candidate.url, {
          source: 'Coverart',
          logFailures: false
        });
        if (result?.ok && result?.localUrl) {
          recovered = true;
          summary.recovered += 1;
          await historyService.appendLog(
            jobId,
            'SYSTEM',
            `Coverart nachgeladen (${trigger}): ${candidate.url}${candidate?.source ? ` [${candidate.source}]` : ''}`
          );
          break;
        }
        lastError = String(result?.error || result?.reason || 'download_failed');
      }

      if (!recovered) {
        summary.failed += 1;
        const failedInfo = {
          jobId,
          title: String(row?.title || row?.detected_title || `Job #${jobId}`),
          attemptedUrls: candidates.map((item) => item.url),
          error: lastError
        };
        summary.failedJobs.push(failedInfo);
        if (logFailures && trigger !== 'auto') {
          await historyService.appendLog(
            jobId,
            'SYSTEM',
            `Coverart-Download fehlgeschlagen (${trigger}). Versuchte Links: ${failedInfo.attemptedUrls.join(', ')}${lastError ? ` | Fehler: ${lastError}` : ''}`
          );
        }
      }
    }

    const finishedAt = new Date().toISOString();
    const durationMs = Math.max(0, Date.now() - startedMs);
    const result = {
      ...summary,
      finishedAt,
      durationMs
    };
    this.lastRunSummary = result;
    logger.info('recovery:done', {
      trigger: result.trigger,
      scannedJobs: result.scannedJobs,
      recovered: result.recovered,
      failed: result.failed,
      alreadyLocal: result.alreadyLocal,
      noCandidate: result.noCandidate,
      runningSkipped: result.runningSkipped,
      durationMs: result.durationMs
    });
    return result;
  }
}

module.exports = new CoverArtRecoveryService();
