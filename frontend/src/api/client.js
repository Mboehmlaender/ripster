const API_BASE = import.meta.env.VITE_API_BASE || '/api';

async function request(path, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {})
    },
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
  getSettings() {
    return request('/settings');
  },
  getHandBrakePresets() {
    return request('/settings/handbrake-presets');
  },
  getScripts() {
    return request('/settings/scripts');
  },
  createScript(payload = {}) {
    return request('/settings/scripts', {
      method: 'POST',
      body: JSON.stringify(payload || {})
    });
  },
  reorderScripts(orderedScriptIds = []) {
    return request('/settings/scripts/reorder', {
      method: 'POST',
      body: JSON.stringify({
        orderedScriptIds: Array.isArray(orderedScriptIds) ? orderedScriptIds : []
      })
    });
  },
  updateScript(scriptId, payload = {}) {
    return request(`/settings/scripts/${encodeURIComponent(scriptId)}`, {
      method: 'PUT',
      body: JSON.stringify(payload || {})
    });
  },
  deleteScript(scriptId) {
    return request(`/settings/scripts/${encodeURIComponent(scriptId)}`, {
      method: 'DELETE'
    });
  },
  testScript(scriptId) {
    return request(`/settings/scripts/${encodeURIComponent(scriptId)}/test`, {
      method: 'POST'
    });
  },
  getScriptChains() {
    return request('/settings/script-chains');
  },
  createScriptChain(payload = {}) {
    return request('/settings/script-chains', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
  },
  reorderScriptChains(orderedChainIds = []) {
    return request('/settings/script-chains/reorder', {
      method: 'POST',
      body: JSON.stringify({
        orderedChainIds: Array.isArray(orderedChainIds) ? orderedChainIds : []
      })
    });
  },
  updateScriptChain(chainId, payload = {}) {
    return request(`/settings/script-chains/${encodeURIComponent(chainId)}`, {
      method: 'PUT',
      body: JSON.stringify(payload)
    });
  },
  deleteScriptChain(chainId) {
    return request(`/settings/script-chains/${encodeURIComponent(chainId)}`, {
      method: 'DELETE'
    });
  },
  testScriptChain(chainId) {
    return request(`/settings/script-chains/${encodeURIComponent(chainId)}/test`, {
      method: 'POST'
    });
  },
  updateSetting(key, value) {
    return request(`/settings/${encodeURIComponent(key)}`, {
      method: 'PUT',
      body: JSON.stringify({ value })
    });
  },
  updateSettingsBulk(settings) {
    return request('/settings', {
      method: 'PUT',
      body: JSON.stringify({ settings })
    });
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
  analyzeDisc() {
    return request('/pipeline/analyze', {
      method: 'POST'
    });
  },
  rescanDisc() {
    return request('/pipeline/rescan-disc', {
      method: 'POST'
    });
  },
  searchOmdb(q) {
    return request(`/pipeline/omdb/search?q=${encodeURIComponent(q)}`);
  },
  selectMetadata(payload) {
    return request('/pipeline/select-metadata', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
  },
  startJob(jobId) {
    return request(`/pipeline/start/${jobId}`, {
      method: 'POST'
    });
  },
  confirmEncodeReview(jobId, payload = {}) {
    return request(`/pipeline/confirm-encode/${jobId}`, {
      method: 'POST',
      body: JSON.stringify(payload || {})
    });
  },
  cancelPipeline(jobId = null) {
    return request('/pipeline/cancel', {
      method: 'POST',
      body: JSON.stringify({ jobId })
    });
  },
  retryJob(jobId) {
    return request(`/pipeline/retry/${jobId}`, {
      method: 'POST'
    });
  },
  resumeReadyJob(jobId) {
    return request(`/pipeline/resume-ready/${jobId}`, {
      method: 'POST'
    });
  },
  reencodeJob(jobId) {
    return request(`/pipeline/reencode/${jobId}`, {
      method: 'POST'
    });
  },
  restartReviewFromRaw(jobId) {
    return request(`/pipeline/restart-review/${jobId}`, {
      method: 'POST'
    });
  },
  restartEncodeWithLastSettings(jobId) {
    return request(`/pipeline/restart-encode/${jobId}`, {
      method: 'POST'
    });
  },
  getPipelineQueue() {
    return request('/pipeline/queue');
  },
  reorderPipelineQueue(orderedEntryIds = []) {
    return request('/pipeline/queue/reorder', {
      method: 'POST',
      body: JSON.stringify({ orderedEntryIds: Array.isArray(orderedEntryIds) ? orderedEntryIds : [] })
    });
  },
  addQueueEntry(payload = {}) {
    return request('/pipeline/queue/entry', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
  },
  removeQueueEntry(entryId) {
    return request(`/pipeline/queue/entry/${encodeURIComponent(entryId)}`, {
      method: 'DELETE'
    });
  },
  getJobs(params = {}) {
    const query = new URLSearchParams();
    if (params.status) query.set('status', params.status);
    if (params.search) query.set('search', params.search);
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
  importOrphanRawFolder(rawPath) {
    return request('/history/orphan-raw/import', {
      method: 'POST',
      body: JSON.stringify({ rawPath })
    });
  },
  assignJobOmdb(jobId, payload = {}) {
    return request(`/history/${jobId}/omdb/assign`, {
      method: 'POST',
      body: JSON.stringify(payload || {})
    });
  },
  deleteJobFiles(jobId, target = 'both') {
    return request(`/history/${jobId}/delete-files`, {
      method: 'POST',
      body: JSON.stringify({ target })
    });
  },
  deleteJobEntry(jobId, target = 'none') {
    return request(`/history/${jobId}/delete`, {
      method: 'POST',
      body: JSON.stringify({ target })
    });
  },
  getJob(jobId, options = {}) {
    const query = new URLSearchParams();
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
    const suffix = query.toString() ? `?${query.toString()}` : '';
    return request(`/history/${jobId}${suffix}`);
  },

  // ── User Presets ───────────────────────────────────────────────────────────
  getUserPresets(mediaType = null) {
    const suffix = mediaType ? `?media_type=${encodeURIComponent(mediaType)}` : '';
    return request(`/settings/user-presets${suffix}`);
  },
  createUserPreset(payload = {}) {
    return request('/settings/user-presets', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
  },
  updateUserPreset(id, payload = {}) {
    return request(`/settings/user-presets/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify(payload)
    });
  },
  deleteUserPreset(id) {
    return request(`/settings/user-presets/${encodeURIComponent(id)}`, {
      method: 'DELETE'
    });
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
