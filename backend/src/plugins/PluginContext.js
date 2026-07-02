'use strict';

function normalizeExecutionStage(value) {
  const stage = String(value || '').trim().toLowerCase();
  return stage || 'unknown';
}

function normalizePluginExecutionState(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const pluginId = String(value.pluginId || '').trim().toLowerCase() || 'unknown';
  const pluginName = String(value.pluginName || '').trim() || pluginId;
  const pluginFile = String(value.pluginFile || '').trim() || null;
  const markerSource = String(value.markerSource || '').trim().toLowerCase() || 'plugin-file';
  const firstMarkedAt = String(value.firstMarkedAt || '').trim() || null;
  const lastMarkedAt = String(value.lastMarkedAt || '').trim() || null;
  const rawLastStage = String(value.lastStage || '').trim();
  const lastStage = rawLastStage ? normalizeExecutionStage(rawLastStage) : null;
  const jobIdRaw = Number(value.jobId);
  const jobId = Number.isFinite(jobIdRaw) && jobIdRaw > 0 ? Math.trunc(jobIdRaw) : null;
  const byStageRaw = value.byStage && typeof value.byStage === 'object' && !Array.isArray(value.byStage)
    ? value.byStage
    : {};
  const byStage = {};
  for (const [stageKey, stageMeta] of Object.entries(byStageRaw)) {
    const normalizedStage = normalizeExecutionStage(stageKey);
    const count = Number(stageMeta?.count);
    byStage[normalizedStage] = {
      count: Number.isFinite(count) && count > 0 ? Math.trunc(count) : 1,
      lastMarkedAt: String(stageMeta?.lastMarkedAt || '').trim() || null
    };
  }
  const explicitStages = Array.isArray(value.stages)
    ? value.stages.map((stage) => normalizeExecutionStage(stage)).filter(Boolean)
    : [];
  const stages = Array.from(new Set([
    ...explicitStages,
    ...Object.keys(byStage),
    ...(lastStage ? [lastStage] : [])
  ]));

  return {
    markerSource,
    pluginId,
    pluginName,
    pluginFile,
    jobId,
    firstMarkedAt,
    lastMarkedAt,
    lastStage,
    stages,
    byStage
  };
}

function mergePluginExecutionState(existingState, marker) {
  const existing = normalizePluginExecutionState(existingState);
  const normalizedMarker = marker && typeof marker === 'object' ? marker : null;
  if (!normalizedMarker) {
    return existing;
  }

  const stage = normalizeExecutionStage(normalizedMarker.stage);
  const markedAt = String(normalizedMarker.markedAt || '').trim() || new Date().toISOString();
  const previousStageMeta = existing?.byStage?.[stage] || null;
  const nextStageCount = Number(previousStageMeta?.count || 0) + 1;
  const nextByStage = {
    ...(existing?.byStage || {}),
    [stage]: {
      count: nextStageCount,
      lastMarkedAt: markedAt
    }
  };
  const nextStages = Array.from(new Set([
    ...(Array.isArray(existing?.stages) ? existing.stages : []),
    stage
  ]));

  return {
    markerSource: 'plugin-file',
    pluginId: String(normalizedMarker.pluginId || existing?.pluginId || '').trim().toLowerCase() || 'unknown',
    pluginName: String(normalizedMarker.pluginName || existing?.pluginName || '').trim()
      || String(normalizedMarker.pluginId || existing?.pluginId || '').trim()
      || 'unknown',
    pluginFile: String(normalizedMarker.pluginFile || existing?.pluginFile || '').trim() || null,
    jobId: Number.isFinite(Number(normalizedMarker.jobId)) && Number(normalizedMarker.jobId) > 0
      ? Math.trunc(Number(normalizedMarker.jobId))
      : (existing?.jobId || null),
    firstMarkedAt: existing?.firstMarkedAt || markedAt,
    lastMarkedAt: markedAt,
    lastStage: stage,
    stages: nextStages,
    byStage: nextByStage
  };
}

/**
 * Kontext-Objekt, das an alle Plugin-Methoden weitergegeben wird.
 * Kapselt den Zugriff auf alle Services, die ein Plugin benötigt,
 * ohne direkte Abhängigkeiten auf Singletons zu erzwingen.
 *
 * Wird vom PluginOrchestrator befüllt und ist read-only für Plugins.
 */
class PluginContext {
  /**
   * @param {object} options
   * @param {object}   options.settings       - settingsService (mit get(), getAll() etc.)
   * @param {object}   options.db             - SQLite-Datenbankinstanz (getDb())
   * @param {object}   options.logger         - Logger-Instanz (child-Logger empfohlen)
   * @param {object}   options.websocket      - websocketService (broadcast() etc.)
   * @param {object}   options.processRunner  - processRunner (spawnTrackedProcess etc.)
   * @param {Function} options.emitProgress   - (progress: number, statusText: string, eta?: number) => void
   * @param {Function} options.emitState      - (newState: string, context?: object) => void
   * @param {Function} options.onPluginExecution - Callback für echte Plugin-Datei-Ausführung
   * @param {object}   [options.extra]        - Beliebige plugin-spezifische Extras
   */
  constructor({
    settings,
    db,
    logger,
    websocket,
    processRunner,
    emitProgress,
    emitState,
    onPluginExecution,
    extra = {}
  } = {}) {
    this.settings = settings;
    this.db = db;
    this.logger = logger;
    this.websocket = websocket;
    this.processRunner = processRunner;
    this.emitProgress = typeof emitProgress === 'function' ? emitProgress : () => {};
    this.emitState = typeof emitState === 'function' ? emitState : () => {};
    this.onPluginExecution = typeof onPluginExecution === 'function' ? onPluginExecution : () => {};
    this.extra = extra;
    this.pluginExecution = null;
  }

  markExecution(stage, payload = {}) {
    const jobIdRaw = Number(payload?.jobId ?? this.extra?.jobId ?? this.extra?.job?.id ?? 0);
    const marker = {
      markerSource: 'plugin-file',
      pluginId: String(payload?.pluginId || this.extra?.pluginId || '').trim().toLowerCase() || 'unknown',
      pluginName: String(payload?.pluginName || '').trim()
        || String(payload?.pluginId || this.extra?.pluginId || '').trim()
        || 'unknown',
      pluginFile: String(payload?.pluginFile || '').trim() || null,
      jobId: Number.isFinite(jobIdRaw) && jobIdRaw > 0 ? Math.trunc(jobIdRaw) : null,
      stage: normalizeExecutionStage(stage),
      markedAt: new Date().toISOString()
    };

    this.pluginExecution = mergePluginExecutionState(this.pluginExecution, marker);

    try {
      this.onPluginExecution(marker, this.getPluginExecution());
    } catch (error) {
      if (this.logger && typeof this.logger.warn === 'function') {
        this.logger.warn('plugin:execution:callback-failed', {
          pluginId: marker.pluginId,
          pluginFile: marker.pluginFile,
          stage: marker.stage,
          error: error?.message || String(error)
        });
      }
    }

    return this.getPluginExecution();
  }

  getPluginExecution() {
    const normalized = normalizePluginExecutionState(this.pluginExecution);
    if (!normalized) {
      return null;
    }
    return {
      ...normalized,
      stages: [...normalized.stages],
      byStage: Object.fromEntries(
        Object.entries(normalized.byStage || {}).map(([stage, meta]) => [
          stage,
          {
            count: Number(meta?.count || 1),
            lastMarkedAt: meta?.lastMarkedAt || null
          }
        ])
      )
    };
  }
}

module.exports = { PluginContext };
