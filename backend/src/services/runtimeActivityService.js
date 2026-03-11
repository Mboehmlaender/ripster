const wsService = require('./websocketService');

const MAX_RECENT_ACTIVITIES = 120;
const MAX_ACTIVITY_OUTPUT_CHARS = 12000;
const MAX_ACTIVITY_TEXT_CHARS = 2000;

function nowIso() {
  return new Date().toISOString();
}

function normalizeNumber(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return Math.trunc(parsed);
}

function normalizeText(value, { trim = true, maxChars = MAX_ACTIVITY_TEXT_CHARS } = {}) {
  if (value === null || value === undefined) {
    return null;
  }
  let text = String(value);
  if (trim) {
    text = text.trim();
  }
  if (!text) {
    return null;
  }
  if (text.length > maxChars) {
    const suffix = trim ? ' ...[gekürzt]' : '\n...[gekürzt]';
    text = `${text.slice(0, Math.max(0, maxChars - suffix.length))}${suffix}`;
  }
  return text;
}

function sanitizeActivity(input = {}) {
  const source = input && typeof input === 'object' ? input : {};
  const normalizedOutcome = normalizeText(source.outcome, { trim: true, maxChars: 40 });
  return {
    id: normalizeNumber(source.id),
    type: String(source.type || '').trim().toLowerCase() || 'task',
    name: String(source.name || '').trim() || null,
    status: String(source.status || '').trim().toLowerCase() || 'running',
    source: String(source.source || '').trim() || null,
    message: String(source.message || '').trim() || null,
    currentStep: String(source.currentStep || '').trim() || null,
    currentStepType: String(source.currentStepType || '').trim() || null,
    currentScriptName: String(source.currentScriptName || '').trim() || null,
    stepIndex: normalizeNumber(source.stepIndex),
    stepTotal: normalizeNumber(source.stepTotal),
    parentActivityId: normalizeNumber(source.parentActivityId),
    jobId: normalizeNumber(source.jobId),
    cronJobId: normalizeNumber(source.cronJobId),
    chainId: normalizeNumber(source.chainId),
    scriptId: normalizeNumber(source.scriptId),
    canCancel: Boolean(source.canCancel),
    canNextStep: Boolean(source.canNextStep),
    outcome: normalizedOutcome ? String(normalizedOutcome).toLowerCase() : null,
    errorMessage: normalizeText(source.errorMessage, { trim: true, maxChars: MAX_ACTIVITY_TEXT_CHARS }),
    output: normalizeText(source.output, { trim: false, maxChars: MAX_ACTIVITY_OUTPUT_CHARS }),
    stdout: normalizeText(source.stdout, { trim: false, maxChars: MAX_ACTIVITY_OUTPUT_CHARS }),
    stderr: normalizeText(source.stderr, { trim: false, maxChars: MAX_ACTIVITY_OUTPUT_CHARS }),
    stdoutTruncated: Boolean(source.stdoutTruncated),
    stderrTruncated: Boolean(source.stderrTruncated),
    startedAt: source.startedAt || nowIso(),
    finishedAt: source.finishedAt || null,
    durationMs: Number.isFinite(Number(source.durationMs)) ? Number(source.durationMs) : null,
    exitCode: Number.isFinite(Number(source.exitCode)) ? Number(source.exitCode) : null,
    success: source.success === null || source.success === undefined ? null : Boolean(source.success)
  };
}

class RuntimeActivityService {
  constructor() {
    this.nextId = 1;
    this.active = new Map();
    this.recent = [];
    this.controls = new Map();
  }

  buildSnapshot() {
    const active = Array.from(this.active.values())
      .sort((a, b) => String(b.startedAt || '').localeCompare(String(a.startedAt || '')));
    const recent = [...this.recent]
      .sort((a, b) => String(b.finishedAt || b.startedAt || '').localeCompare(String(a.finishedAt || a.startedAt || '')));
    return {
      active,
      recent,
      updatedAt: nowIso()
    };
  }

  broadcastSnapshot() {
    wsService.broadcast('RUNTIME_ACTIVITY_CHANGED', this.buildSnapshot());
  }

  startActivity(type, payload = {}) {
    const id = this.nextId;
    this.nextId += 1;
    const activity = sanitizeActivity({
      ...payload,
      id,
      type,
      status: 'running',
      outcome: 'running',
      startedAt: payload?.startedAt || nowIso(),
      finishedAt: null,
      durationMs: null,
      canCancel: Boolean(payload?.canCancel),
      canNextStep: Boolean(payload?.canNextStep)
    });
    this.active.set(id, activity);
    this.broadcastSnapshot();
    return id;
  }

  updateActivity(activityId, patch = {}) {
    const id = normalizeNumber(activityId);
    if (!id || !this.active.has(id)) {
      return null;
    }
    const current = this.active.get(id);
    const next = sanitizeActivity({
      ...current,
      ...patch,
      id: current.id,
      type: current.type,
      status: current.status === 'running' ? (patch?.status || current.status) : current.status,
      startedAt: current.startedAt
    });
    this.active.set(id, next);
    this.broadcastSnapshot();
    return next;
  }

  completeActivity(activityId, payload = {}) {
    const id = normalizeNumber(activityId);
    if (!id || !this.active.has(id)) {
      return null;
    }
    const current = this.active.get(id);
    const finishedAt = payload?.finishedAt || nowIso();
    const startedAtDate = new Date(current.startedAt);
    const finishedAtDate = new Date(finishedAt);
    const durationMs = Number.isFinite(startedAtDate.getTime()) && Number.isFinite(finishedAtDate.getTime())
      ? Math.max(0, finishedAtDate.getTime() - startedAtDate.getTime())
      : null;
    const status = String(payload?.status || '').trim().toLowerCase() || (payload?.success === false ? 'error' : 'success');
    let outcome = String(payload?.outcome || '').trim().toLowerCase();
    if (!outcome) {
      if (Boolean(payload?.cancelled)) {
        outcome = 'cancelled';
      } else if (Boolean(payload?.skipped)) {
        outcome = 'skipped';
      } else {
        outcome = status === 'success' ? 'success' : 'error';
      }
    }
    const finalized = sanitizeActivity({
      ...current,
      ...payload,
      id: current.id,
      type: current.type,
      status,
      outcome,
      canCancel: false,
      canNextStep: false,
      finishedAt,
      durationMs
    });
    this.active.delete(id);
    this.controls.delete(id);
    this.recent.unshift(finalized);
    if (this.recent.length > MAX_RECENT_ACTIVITIES) {
      this.recent = this.recent.slice(0, MAX_RECENT_ACTIVITIES);
    }
    this.broadcastSnapshot();
    return finalized;
  }

  getSnapshot() {
    return this.buildSnapshot();
  }

  setControls(activityId, handlers = {}) {
    const id = normalizeNumber(activityId);
    if (!id || !this.active.has(id)) {
      return null;
    }
    const safeHandlers = {
      cancel: typeof handlers?.cancel === 'function' ? handlers.cancel : null,
      nextStep: typeof handlers?.nextStep === 'function' ? handlers.nextStep : null
    };
    this.controls.set(id, safeHandlers);
    return this.updateActivity(id, {
      canCancel: Boolean(safeHandlers.cancel),
      canNextStep: Boolean(safeHandlers.nextStep)
    });
  }

  async invokeControl(activityId, control, payload = {}) {
    const id = normalizeNumber(activityId);
    if (!id || !this.active.has(id)) {
      return {
        ok: false,
        code: 'NOT_FOUND',
        message: 'Aktivität nicht gefunden oder bereits abgeschlossen.'
      };
    }
    const handlers = this.controls.get(id) || {};
    const key = control === 'nextStep' ? 'nextStep' : 'cancel';
    const fn = handlers[key];
    if (typeof fn !== 'function') {
      return {
        ok: false,
        code: 'UNSUPPORTED',
        message: key === 'nextStep'
          ? 'Nächster-Schritt ist für diese Aktivität nicht verfügbar.'
          : 'Abbrechen ist für diese Aktivität nicht verfügbar.'
      };
    }
    try {
      const result = await fn(payload);
      return {
        ok: true,
        code: 'OK',
        result: result && typeof result === 'object' ? result : null
      };
    } catch (error) {
      return {
        ok: false,
        code: 'FAILED',
        message: error?.message || 'Aktion fehlgeschlagen.'
      };
    }
  }

  async requestCancel(activityId, payload = {}) {
    return this.invokeControl(activityId, 'cancel', payload);
  }

  async requestNextStep(activityId, payload = {}) {
    return this.invokeControl(activityId, 'nextStep', payload);
  }
}

module.exports = new RuntimeActivityService();
