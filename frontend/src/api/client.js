const API_BASE = import.meta.env.VITE_API_BASE || '/api';
const GET_RESPONSE_CACHE = new Map();

function invalidateCachedGet(prefixes = []) {
  const list = Array.isArray(prefixes) ? prefixes.filter(Boolean) : [];
  if (list.length === 0) {
    GET_RESPONSE_CACHE.clear();
    return;
  }
  for (const key of GET_RESPONSE_CACHE.keys()) {
    if (list.some((prefix) => key.startsWith(prefix))) {
      GET_RESPONSE_CACHE.delete(key);
    }
  }
}

function refreshCachedGet(path, ttlMs) {
  const cacheKey = String(path || '');
  const nextEntry = GET_RESPONSE_CACHE.get(cacheKey) || {
    value: undefined,
    expiresAt: 0,
    promise: null
  };
  const nextPromise = request(path)
    .then((payload) => {
      GET_RESPONSE_CACHE.set(cacheKey, {
        value: payload,
        expiresAt: Date.now() + Math.max(1000, Number(ttlMs || 0)),
        promise: null
      });
      return payload;
    })
    .catch((error) => {
      const current = GET_RESPONSE_CACHE.get(cacheKey);
      if (current && current.promise === nextPromise) {
        GET_RESPONSE_CACHE.set(cacheKey, {
          value: current.value,
          expiresAt: current.expiresAt || 0,
          promise: null
        });
      }
      throw error;
    });
  GET_RESPONSE_CACHE.set(cacheKey, {
    value: nextEntry.value,
    expiresAt: nextEntry.expiresAt || 0,
    promise: nextPromise
  });
  return nextPromise;
}

async function requestCachedGet(path, options = {}) {
  const ttlMs = Math.max(1000, Number(options?.ttlMs || 0));
  const forceRefresh = Boolean(options?.forceRefresh);
  const cacheKey = String(path || '');
  const current = GET_RESPONSE_CACHE.get(cacheKey);
  const now = Date.now();

  if (!forceRefresh && current && current.value !== undefined) {
    if (current.expiresAt > now) {
      return current.value;
    }
    if (!current.promise) {
      void refreshCachedGet(path, ttlMs);
    }
    return current.value;
  }

  if (!forceRefresh && current?.promise) {
    return current.promise;
  }

  return refreshCachedGet(path, ttlMs);
}

function afterMutationInvalidate(prefixes = []) {
  invalidateCachedGet(prefixes);
}

async function request(path, options = {}) {
  const isFormDataBody = typeof FormData !== 'undefined' && options?.body instanceof FormData;
  const mergedHeaders = {
    ...(isFormDataBody ? {} : { 'Content-Type': 'application/json' }),
    ...(options.headers || {})
  };
  const response = await fetch(`${API_BASE}${path}`, {
    headers: mergedHeaders,
    ...options
  });

  if (!response.ok) {
    let errorPayload = null;
    let message = `HTTP ${response.status}`;
    try {
      errorPayload = await response.json();
      message = errorPayload?.error?.message || message;
    } catch (_error) {
      // ignore parse errors
    }
    const error = new Error(message);
    error.status = response.status;
    error.details = errorPayload?.error?.details || null;
    throw error;
  }

  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    return response.json();
  }

  return response.text();
}

export const api = {
  getSettings(options = {}) {
    return requestCachedGet('/settings', {
      ttlMs: 5 * 60 * 1000,
      forceRefresh: options.forceRefresh
    });
  },
  getEffectivePaths(options = {}) {
    return requestCachedGet('/settings/effective-paths', {
      ttlMs: 30 * 1000,
      forceRefresh: options.forceRefresh
    });
  },
  getHandBrakePresets(options = {}) {
    return requestCachedGet('/settings/handbrake-presets', {
      ttlMs: 10 * 60 * 1000,
      forceRefresh: options.forceRefresh
    });
  },
  getScripts(options = {}) {
    return requestCachedGet('/settings/scripts', {
      ttlMs: 2 * 60 * 1000,
      forceRefresh: options.forceRefresh
    });
  },
  async createScript(payload = {}) {
    const result = await request('/settings/scripts', {
      method: 'POST',
      body: JSON.stringify(payload || {})
    });
    afterMutationInvalidate(['/settings/scripts']);
    return result;
  },
  async reorderScripts(orderedScriptIds = []) {
    const result = await request('/settings/scripts/reorder', {
      method: 'POST',
      body: JSON.stringify({
        orderedScriptIds: Array.isArray(orderedScriptIds) ? orderedScriptIds : []
      })
    });
    afterMutationInvalidate(['/settings/scripts']);
    return result;
  },
  async updateScript(scriptId, payload = {}) {
    const result = await request(`/settings/scripts/${encodeURIComponent(scriptId)}`, {
      method: 'PUT',
      body: JSON.stringify(payload || {})
    });
    afterMutationInvalidate(['/settings/scripts']);
    return result;
  },
  async deleteScript(scriptId) {
    const result = await request(`/settings/scripts/${encodeURIComponent(scriptId)}`, {
      method: 'DELETE'
    });
    afterMutationInvalidate(['/settings/scripts']);
    return result;
  },
  testScript(scriptId) {
    return request(`/settings/scripts/${encodeURIComponent(scriptId)}/test`, {
      method: 'POST'
    });
  },
  getScriptChains(options = {}) {
    return requestCachedGet('/settings/script-chains', {
      ttlMs: 2 * 60 * 1000,
      forceRefresh: options.forceRefresh
    });
  },
  async createScriptChain(payload = {}) {
    const result = await request('/settings/script-chains', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
    afterMutationInvalidate(['/settings/script-chains']);
    return result;
  },
  async reorderScriptChains(orderedChainIds = []) {
    const result = await request('/settings/script-chains/reorder', {
      method: 'POST',
      body: JSON.stringify({
        orderedChainIds: Array.isArray(orderedChainIds) ? orderedChainIds : []
      })
    });
    afterMutationInvalidate(['/settings/script-chains']);
    return result;
  },
  async updateScriptChain(chainId, payload = {}) {
    const result = await request(`/settings/script-chains/${encodeURIComponent(chainId)}`, {
      method: 'PUT',
      body: JSON.stringify(payload)
    });
    afterMutationInvalidate(['/settings/script-chains']);
    return result;
  },
  async deleteScriptChain(chainId) {
    const result = await request(`/settings/script-chains/${encodeURIComponent(chainId)}`, {
      method: 'DELETE'
    });
    afterMutationInvalidate(['/settings/script-chains']);
    return result;
  },
  testScriptChain(chainId) {
    return request(`/settings/script-chains/${encodeURIComponent(chainId)}/test`, {
      method: 'POST'
    });
  },
  async updateSetting(key, value) {
    const result = await request(`/settings/${encodeURIComponent(key)}`, {
      method: 'PUT',
      body: JSON.stringify({ value })
    });
    afterMutationInvalidate(['/settings', '/settings/handbrake-presets']);
    return result;
  },
  async updateSettingsBulk(settings) {
    const result = await request('/settings', {
      method: 'PUT',
      body: JSON.stringify({ settings })
    });
    afterMutationInvalidate(['/settings', '/settings/handbrake-presets']);
    return result;
  },
  testPushover(payload = {}) {
    return request('/settings/pushover/test', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
  },
  getPipelineState() {
    return request('/pipeline/state');
  },
  getRuntimeActivities() {
    return request('/runtime/activities');
  },
  cancelRuntimeActivity(activityId, payload = {}) {
    return request(`/runtime/activities/${encodeURIComponent(activityId)}/cancel`, {
      method: 'POST',
      body: JSON.stringify(payload || {})
    });
  },
  requestRuntimeNextStep(activityId, payload = {}) {
    return request(`/runtime/activities/${encodeURIComponent(activityId)}/next-step`, {
      method: 'POST',
      body: JSON.stringify(payload || {})
    });
  },
  clearRuntimeRecentActivities() {
    return request('/runtime/activities/clear-recent', {
      method: 'POST',
      body: JSON.stringify({})
    });
  },
  async analyzeDisc() {
    const result = await request('/pipeline/analyze', {
      method: 'POST'
    });
    afterMutationInvalidate(['/history', '/pipeline/queue']);
    return result;
  },
  async rescanDisc() {
    const result = await request('/pipeline/rescan-disc', {
      method: 'POST'
    });
    afterMutationInvalidate(['/history', '/pipeline/queue']);
    return result;
  },
  searchOmdb(q) {
    return request(`/pipeline/omdb/search?q=${encodeURIComponent(q)}`);
  },
  searchMusicBrainz(q) {
    return request(`/pipeline/cd/musicbrainz/search?q=${encodeURIComponent(q)}`);
  },
  getMusicBrainzRelease(mbId) {
    return request(`/pipeline/cd/musicbrainz/release/${encodeURIComponent(String(mbId || '').trim())}`);
  },
  async selectCdMetadata(payload) {
    const result = await request('/pipeline/cd/select-metadata', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
    afterMutationInvalidate(['/history', '/pipeline/queue']);
    return result;
  },
  async startCdRip(jobId, ripConfig) {
    const result = await request(`/pipeline/cd/start/${jobId}`, {
      method: 'POST',
      body: JSON.stringify(ripConfig || {})
    });
    afterMutationInvalidate(['/history', '/pipeline/queue']);
    return result;
  },
  async uploadAudiobook(file, payload = {}) {
    const formData = new FormData();
    if (file) {
      formData.append('file', file);
    }
    if (payload?.format) {
      formData.append('format', String(payload.format));
    }
    if (payload?.startImmediately !== undefined) {
      formData.append('startImmediately', String(payload.startImmediately));
    }
    const result = await request('/pipeline/audiobook/upload', {
      method: 'POST',
      body: formData
    });
    afterMutationInvalidate(['/history', '/pipeline/queue']);
    return result;
  },
  async selectMetadata(payload) {
    const result = await request('/pipeline/select-metadata', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
    afterMutationInvalidate(['/history', '/pipeline/queue']);
    return result;
  },
  async startJob(jobId) {
    const result = await request(`/pipeline/start/${jobId}`, {
      method: 'POST'
    });
    afterMutationInvalidate(['/history', '/pipeline/queue']);
    return result;
  },
  async confirmEncodeReview(jobId, payload = {}) {
    const result = await request(`/pipeline/confirm-encode/${jobId}`, {
      method: 'POST',
      body: JSON.stringify(payload || {})
    });
    afterMutationInvalidate(['/history', '/pipeline/queue']);
    return result;
  },
  async cancelPipeline(jobId = null) {
    const result = await request('/pipeline/cancel', {
      method: 'POST',
      body: JSON.stringify({ jobId })
    });
    afterMutationInvalidate(['/history', '/pipeline/queue']);
    return result;
  },
  async retryJob(jobId) {
    const result = await request(`/pipeline/retry/${jobId}`, {
      method: 'POST'
    });
    afterMutationInvalidate(['/history', '/pipeline/queue']);
    return result;
  },
  async resumeReadyJob(jobId) {
    const result = await request(`/pipeline/resume-ready/${jobId}`, {
      method: 'POST'
    });
    afterMutationInvalidate(['/history', '/pipeline/queue']);
    return result;
  },
  async reencodeJob(jobId) {
    const result = await request(`/pipeline/reencode/${jobId}`, {
      method: 'POST'
    });
    afterMutationInvalidate(['/history', '/pipeline/queue']);
    return result;
  },
  async restartReviewFromRaw(jobId) {
    const result = await request(`/pipeline/restart-review/${jobId}`, {
      method: 'POST'
    });
    afterMutationInvalidate(['/history', '/pipeline/queue']);
    return result;
  },
  async restartEncodeWithLastSettings(jobId) {
    const result = await request(`/pipeline/restart-encode/${jobId}`, {
      method: 'POST'
    });
    afterMutationInvalidate(['/history', '/pipeline/queue']);
    return result;
  },
  getPipelineQueue() {
    return request('/pipeline/queue');
  },
  async reorderPipelineQueue(orderedEntryIds = []) {
    const result = await request('/pipeline/queue/reorder', {
      method: 'POST',
      body: JSON.stringify({ orderedEntryIds: Array.isArray(orderedEntryIds) ? orderedEntryIds : [] })
    });
    afterMutationInvalidate(['/pipeline/queue']);
    return result;
  },
  async addQueueEntry(payload = {}) {
    const result = await request('/pipeline/queue/entry', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
    afterMutationInvalidate(['/pipeline/queue']);
    return result;
  },
  async removeQueueEntry(entryId) {
    const result = await request(`/pipeline/queue/entry/${encodeURIComponent(entryId)}`, {
      method: 'DELETE'
    });
    afterMutationInvalidate(['/pipeline/queue']);
    return result;
  },
  getJobs(params = {}) {
    const query = new URLSearchParams();
    if (params.status) query.set('status', params.status);
    if (Array.isArray(params.statuses) && params.statuses.length > 0) {
      query.set('statuses', params.statuses.join(','));
    }
    if (params.search) query.set('search', params.search);
    if (Number.isFinite(Number(params.limit)) && Number(params.limit) > 0) {
      query.set('limit', String(Math.trunc(Number(params.limit))));
    }
    if (params.lite) {
      query.set('lite', '1');
    }
    const suffix = query.toString() ? `?${query.toString()}` : '';
    return request(`/history${suffix}`);
  },
  getDatabaseRows(params = {}) {
    const query = new URLSearchParams();
    if (params.status) query.set('status', params.status);
    if (params.search) query.set('search', params.search);
    const suffix = query.toString() ? `?${query.toString()}` : '';
    return request(`/history/database${suffix}`);
  },
  getOrphanRawFolders() {
    return request('/history/orphan-raw');
  },
  async importOrphanRawFolder(rawPath) {
    const result = await request('/history/orphan-raw/import', {
      method: 'POST',
      body: JSON.stringify({ rawPath })
    });
    afterMutationInvalidate(['/history', '/pipeline/queue']);
    return result;
  },
  async assignJobOmdb(jobId, payload = {}) {
    const result = await request(`/history/${jobId}/omdb/assign`, {
      method: 'POST',
      body: JSON.stringify(payload || {})
    });
    afterMutationInvalidate(['/history']);
    return result;
  },
  async assignJobCdMetadata(jobId, payload = {}) {
    const result = await request(`/history/${jobId}/cd/assign`, {
      method: 'POST',
      body: JSON.stringify(payload || {})
    });
    afterMutationInvalidate(['/history']);
    return result;
  },
  async deleteJobFiles(jobId, target = 'both') {
    const result = await request(`/history/${jobId}/delete-files`, {
      method: 'POST',
      body: JSON.stringify({ target })
    });
    afterMutationInvalidate(['/history']);
    return result;
  },
  getJobDeletePreview(jobId, options = {}) {
    const includeRelated = options?.includeRelated !== false;
    const query = new URLSearchParams();
    query.set('includeRelated', includeRelated ? '1' : '0');
    return request(`/history/${jobId}/delete-preview?${query.toString()}`);
  },
  async deleteJobEntry(jobId, target = 'none', options = {}) {
    const includeRelated = Boolean(options?.includeRelated);
    const result = await request(`/history/${jobId}/delete`, {
      method: 'POST',
      body: JSON.stringify({ target, includeRelated })
    });
    afterMutationInvalidate(['/history', '/pipeline/queue']);
    return result;
  },
  getJob(jobId, options = {}) {
    const query = new URLSearchParams();
    const includeLiveLog = Boolean(options.includeLiveLog);
    const includeLogs = Boolean(options.includeLogs);
    const includeAllLogs = Boolean(options.includeAllLogs);
    if (options.includeLiveLog) {
      query.set('includeLiveLog', '1');
    }
    if (options.includeLogs) {
      query.set('includeLogs', '1');
    }
    if (options.includeAllLogs) {
      query.set('includeAllLogs', '1');
    }
    if (Number.isFinite(Number(options.logTailLines)) && Number(options.logTailLines) > 0) {
      query.set('logTailLines', String(Math.trunc(Number(options.logTailLines))));
    }
    if (options.lite) {
      query.set('lite', '1');
    }
    const suffix = query.toString() ? `?${query.toString()}` : '';
    const path = `/history/${jobId}${suffix}`;
    const canUseCache = !includeLiveLog && !includeLogs && !includeAllLogs;
    if (!canUseCache) {
      return request(path);
    }
    return requestCachedGet(path, {
      ttlMs: 8000,
      forceRefresh: options.forceRefresh
    });
  },

  // ── User Presets ───────────────────────────────────────────────────────────
  getUserPresets(mediaType = null, options = {}) {
    const suffix = mediaType ? `?media_type=${encodeURIComponent(mediaType)}` : '';
    return requestCachedGet(`/settings/user-presets${suffix}`, {
      ttlMs: 2 * 60 * 1000,
      forceRefresh: options.forceRefresh
    });
  },
  async createUserPreset(payload = {}) {
    const result = await request('/settings/user-presets', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
    afterMutationInvalidate(['/settings/user-presets']);
    return result;
  },
  async updateUserPreset(id, payload = {}) {
    const result = await request(`/settings/user-presets/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify(payload)
    });
    afterMutationInvalidate(['/settings/user-presets']);
    return result;
  },
  async deleteUserPreset(id) {
    const result = await request(`/settings/user-presets/${encodeURIComponent(id)}`, {
      method: 'DELETE'
    });
    afterMutationInvalidate(['/settings/user-presets']);
    return result;
  },

  // ── Cron Jobs ──────────────────────────────────────────────────────────────
  getCronJobs() {
    return request('/crons');
  },
  getCronJob(id) {
    return request(`/crons/${encodeURIComponent(id)}`);
  },
  createCronJob(payload = {}) {
    return request('/crons', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
  },
  updateCronJob(id, payload = {}) {
    return request(`/crons/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify(payload)
    });
  },
  deleteCronJob(id) {
    return request(`/crons/${encodeURIComponent(id)}`, {
      method: 'DELETE'
    });
  },
  getCronJobLogs(id, limit = 20) {
    return request(`/crons/${encodeURIComponent(id)}/logs?limit=${limit}`);
  },
  runCronJobNow(id) {
    return request(`/crons/${encodeURIComponent(id)}/run`, {
      method: 'POST'
    });
  },
  validateCronExpression(cronExpression) {
    return request('/crons/validate-expression', {
      method: 'POST',
      body: JSON.stringify({ cronExpression })
    });
  }
};

export { API_BASE };
