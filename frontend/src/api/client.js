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
      return Promise.resolve(current.value);
    }
    if (!current.promise) {
      void refreshCachedGet(path, ttlMs);
    }
    return Promise.resolve(current.value);
  }

  if (!forceRefresh && current?.promise) {
    return current.promise;
  }

  return refreshCachedGet(path, ttlMs);
}

function afterMutationInvalidate(prefixes = []) {
  invalidateCachedGet(prefixes);
}

function buildHandBrakePresetList(payload) {
  const existing = Array.isArray(payload?.presets) ? payload.presets : [];
  if (existing.length > 0) {
    return existing;
  }
  const options = Array.isArray(payload?.options) ? payload.options : [];
  const list = [];
  for (const option of options) {
    if (!option || option.disabled) {
      continue;
    }
    const rawValue = option.value ?? option.name ?? option.label ?? '';
    const name = String(rawValue || '').trim();
    if (!name || name.startsWith('__group__')) {
      continue;
    }
    const category = option.category ? String(option.category).trim() : '';
    list.push({
      name,
      category: category || null
    });
  }
  return list;
}

function normalizeHandBrakePresetPayload(payload) {
  if (!payload || typeof payload !== 'object') {
    return payload;
  }
  const existing = Array.isArray(payload.presets) ? payload.presets : [];
  if (existing.length > 0) {
    return payload;
  }
  return {
    ...payload,
    presets: buildHandBrakePresetList(payload)
  };
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

function resolveFilenameFromDisposition(contentDisposition, fallback = 'download.zip') {
  const raw = String(contentDisposition || '').trim();
  if (!raw) {
    return fallback;
  }

  const encodedMatch = raw.match(/filename\*\s*=\s*UTF-8''([^;]+)/i);
  if (encodedMatch?.[1]) {
    try {
      return decodeURIComponent(encodedMatch[1]);
    } catch (_error) {
      // ignore malformed content-disposition values
    }
  }

  const plainMatch = raw.match(/filename\s*=\s*"([^"]+)"/i) || raw.match(/filename\s*=\s*([^;]+)/i);
  if (plainMatch?.[1]) {
    return String(plainMatch[1]).trim();
  }

  return fallback;
}

async function download(path, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: options?.headers || {},
    method: options?.method || 'GET'
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

  const blob = await response.blob();
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement('a');
  const fallbackFilename = String(options?.filename || 'download.zip').trim() || 'download.zip';
  const filename = resolveFilenameFromDisposition(response.headers.get('content-disposition'), fallbackFilename);

  link.href = objectUrl;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);

  return {
    filename,
    sizeBytes: blob.size
  };
}

async function requestWithXhr(path, options = {}) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const method = String(options?.method || 'GET').trim().toUpperCase() || 'GET';
    const url = `${API_BASE}${path}`;
    const headers = options?.headers && typeof options.headers === 'object' ? options.headers : {};
    const signal = options?.signal;
    const onUploadProgress = typeof options?.onUploadProgress === 'function'
      ? options.onUploadProgress
      : null;

    let finished = false;
    let abortListener = null;

    const cleanup = () => {
      if (signal && abortListener) {
        signal.removeEventListener('abort', abortListener);
      }
    };

    const settle = (callback) => {
      if (finished) {
        return;
      }
      finished = true;
      cleanup();
      callback();
    };

    xhr.open(method, url, true);
    xhr.responseType = 'text';

    Object.entries(headers).forEach(([key, value]) => {
      if (value == null) {
        return;
      }
      xhr.setRequestHeader(key, String(value));
    });

    if (onUploadProgress && xhr.upload) {
      xhr.upload.onprogress = (event) => {
        const loaded = Number(event?.loaded || 0);
        const total = Number(event?.total || 0);
        const hasKnownTotal = Boolean(event?.lengthComputable && total > 0);
        onUploadProgress({
          loaded,
          total: hasKnownTotal ? total : null,
          percent: hasKnownTotal ? (loaded / total) * 100 : null
        });
      };
    }

    xhr.onerror = () => {
      settle(() => {
        if (Number(xhr.status || 0) === 0) {
          const abortLikeError = new Error('Request unterbrochen.');
          abortLikeError.name = 'AbortError';
          reject(abortLikeError);
          return;
        }
        reject(new Error('Netzwerkfehler'));
      });
    };

    xhr.onabort = () => {
      settle(() => {
        const error = new Error('Request abgebrochen.');
        error.name = 'AbortError';
        reject(error);
      });
    };

    xhr.onload = () => {
      settle(() => {
        const contentType = xhr.getResponseHeader('content-type') || '';
        const rawText = xhr.responseText || '';

        if (xhr.status < 200 || xhr.status >= 300) {
          let errorPayload = null;
          let message = `HTTP ${xhr.status}`;
          try {
            errorPayload = rawText ? JSON.parse(rawText) : null;
            message = errorPayload?.error?.message || message;
          } catch (_error) {
            // ignore parse errors
          }
          const error = new Error(message);
          error.status = xhr.status;
          error.details = errorPayload?.error?.details || null;
          reject(error);
          return;
        }

        if (contentType.includes('application/json')) {
          try {
            resolve(rawText ? JSON.parse(rawText) : {});
          } catch (_error) {
            reject(new Error('Ungültige JSON-Antwort vom Server.'));
          }
          return;
        }

        resolve(rawText);
      });
    };

    if (signal) {
      if (signal.aborted) {
        xhr.abort();
        return;
      }
      abortListener = () => {
        if (!finished) {
          xhr.abort();
        }
      };
      signal.addEventListener('abort', abortListener, { once: true });
    }

    xhr.send(options?.body ?? null);
  });
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
  getActivationBytes(options = {}) {
    return requestCachedGet('/settings/activation-bytes', {
      ttlMs: 0,
      forceRefresh: options.forceRefresh ?? true
    });
  },
  async saveActivationBytes(checksum, activationBytes) {
    const result = await request('/settings/activation-bytes', {
      method: 'POST',
      body: JSON.stringify({ checksum, activationBytes })
    });
    afterMutationInvalidate(['/settings/activation-bytes']);
    return result;
  },
  getPendingActivation() {
    return request('/pipeline/audiobook/pending-activation');
  },
  getDetectedDrives() {
    return request('/settings/drives');
  },
  forceUnlockDrive(payload = {}) {
    return request('/settings/drives/force-unlock', {
      method: 'POST',
      body: JSON.stringify(payload || {})
    });
  },
  async getHandBrakePresets(options = {}) {
    const result = await requestCachedGet('/settings/handbrake-presets', {
      ttlMs: 10 * 60 * 1000,
      forceRefresh: options.forceRefresh
    });
    return normalizeHandBrakePresetPayload(result);
  },
  getMakeMKVBetaKey(options = {}) {
    return requestCachedGet('/settings/makemkv/beta-key', {
      ttlMs: 10 * 60 * 1000,
      forceRefresh: options.forceRefresh
    });
  },
  async checkMakeMKVBetaKey() {
    const result = await request('/settings/makemkv/beta-key/check', {
      method: 'POST'
    });
    afterMutationInvalidate(['/settings/makemkv/beta-key']);
    return result;
  },
  async applyMakeMKVBetaKey(payload = {}) {
    const result = await request('/settings/makemkv/beta-key/apply', {
      method: 'POST',
      body: JSON.stringify(payload || {})
    });
    afterMutationInvalidate(['/settings/makemkv/beta-key', '/settings']);
    return result;
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
  async setScriptFavorite(scriptId, isFavorite) {
    const result = await request(`/settings/scripts/${encodeURIComponent(scriptId)}/favorite`, {
      method: 'PUT',
      body: JSON.stringify({ isFavorite: isFavorite === true })
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
  async setScriptChainFavorite(chainId, isFavorite) {
    const result = await request(`/settings/script-chains/${encodeURIComponent(chainId)}/favorite`, {
      method: 'PUT',
      body: JSON.stringify({ isFavorite: isFavorite === true })
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
  async getPref(key) {
    return request(`/settings/prefs/${encodeURIComponent(key)}`);
  },
  async setPref(key, value) {
    return request(`/settings/prefs/${encodeURIComponent(key)}`, {
      method: 'PUT',
      body: JSON.stringify({ value })
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
  async recoverMissingCoverArt(payload = {}) {
    const result = await request('/settings/coverart/recover', {
      method: 'POST',
      body: JSON.stringify(payload || {})
    });
    afterMutationInvalidate(['/history', '/settings']);
    return result;
  },
  getPipelineState() {
    return request('/pipeline/state');
  },
  getHardwareHistory(options = {}) {
    const hoursRaw = Number(options?.hours);
    const maxPointsRaw = Number(options?.maxPoints);
    const hours = Number.isFinite(hoursRaw) ? Math.max(1, Math.min(96, Math.trunc(hoursRaw))) : 24;
    const maxPoints = Number.isFinite(maxPointsRaw) ? Math.max(120, Math.min(5000, Math.trunc(maxPointsRaw))) : 720;
    const query = new URLSearchParams({
      hours: String(hours),
      maxPoints: String(maxPoints)
    });
    const path = `/pipeline/hardware/history?${query.toString()}`;
    return requestCachedGet(path, {
      ttlMs: 10 * 1000,
      forceRefresh: options.forceRefresh
    });
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
  async analyzeDisc(devicePath = null) {
    const body = devicePath ? { devicePath } : {};
    const result = await request('/pipeline/analyze', {
      method: 'POST',
      body: JSON.stringify(body)
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
  async rescanDrive(devicePath) {
    const result = await request('/pipeline/rescan-drive', {
      method: 'POST',
      body: JSON.stringify({ devicePath })
    });
    return result;
  },
  searchTmdbMovie(q) {
    return request(`/pipeline/tmdb/movie/search?q=${encodeURIComponent(q)}`);
  },
  searchTmdbSeries(q, seasonNumber = null) {
    const params = new URLSearchParams();
    params.set('q', String(q || ''));
    if (seasonNumber !== undefined && seasonNumber !== null && String(seasonNumber).trim() !== '') {
      params.set('season', String(seasonNumber).trim());
    }
    return request(`/pipeline/tmdb/series/search?${params.toString()}`);
  },
  searchMusicBrainz(q, options = {}) {
    const params = new URLSearchParams();
    params.set('q', String(q || ''));
    const expectedTrackCount = Number(options?.trackCount);
    if (Number.isFinite(expectedTrackCount) && expectedTrackCount > 0) {
      params.set('trackCount', String(Math.trunc(expectedTrackCount)));
    }
    return request(`/pipeline/cd/musicbrainz/search?${params.toString()}`);
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
  async uploadAudiobook(file, payload = {}, options = {}) {
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
    const result = await requestWithXhr('/pipeline/audiobook/upload', {
      method: 'POST',
      body: formData,
      signal: options?.signal,
      onUploadProgress: options?.onProgress
    });
    afterMutationInvalidate(['/history', '/pipeline/queue']);
    return result;
  },
  async startAudiobook(jobId, payload = {}) {
    const result = await request(`/pipeline/audiobook/start/${jobId}`, {
      method: 'POST',
      body: JSON.stringify(payload || {})
    });
    afterMutationInvalidate(['/history', '/pipeline/queue']);
    return result;
  },
  getAudiobookJobs() {
    return request('/pipeline/audiobook/jobs');
  },
  async selectMetadata(payload) {
    const result = await request('/pipeline/select-metadata', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
    afterMutationInvalidate(['/history', '/pipeline/queue']);
    return result;
  },
  async submitRawDecision(jobId, decision) {
    const result = await request(`/pipeline/jobs/${jobId}/raw-decision`, {
      method: 'POST',
      body: JSON.stringify({ decision })
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
  async reorderMultipartMergeSources(jobId, orderedSourceJobIds = []) {
    const result = await request(`/pipeline/multipart-merge/${jobId}/reorder`, {
      method: 'POST',
      body: JSON.stringify({
        orderedSourceJobIds: Array.isArray(orderedSourceJobIds) ? orderedSourceJobIds : []
      })
    });
    afterMutationInvalidate(['/history', '/pipeline/queue']);
    return result;
  },
  async updateMultipartMergeSettings(jobId, settings = {}) {
    const result = await request(`/pipeline/multipart-merge/${jobId}/settings`, {
      method: 'POST',
      body: JSON.stringify({
        deleteInputsAfterMerge: Boolean(settings?.deleteInputsAfterMerge)
      })
    });
    afterMutationInvalidate(['/history', '/pipeline/queue']);
    return result;
  },
  getMultipartMergePreview(jobId) {
    return request(`/pipeline/multipart-merge/${jobId}/preview`);
  },
  async restoreMultipartMergeJob(containerJobId) {
    const result = await request(`/pipeline/multipart-merge/${containerJobId}/restore`, {
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
  async retryJob(jobId, options = {}) {
    const body = {};
    if (options.createNewJob) body.createNewJob = true;
    const result = await request(`/pipeline/retry/${jobId}`, {
      method: 'POST',
      body: Object.keys(body).length > 0 ? JSON.stringify(body) : undefined
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
  async reencodeJob(jobId, options = {}) {
    const body = {};
    if (options.keepBoth) body.keepBoth = true;
    if (Array.isArray(options.deleteFolders) && options.deleteFolders.length > 0) body.deleteFolders = options.deleteFolders;
    const result = await request(`/pipeline/reencode/${jobId}`, {
      method: 'POST',
      body: Object.keys(body).length > 0 ? JSON.stringify(body) : undefined
    });
    afterMutationInvalidate(['/history', '/pipeline/queue']);
    return result;
  },
  async restartReviewFromRaw(jobId, options = {}) {
    const body = {};
    if (options.keepBoth) body.keepBoth = true;
    if (Array.isArray(options.deleteFolders) && options.deleteFolders.length > 0) body.deleteFolders = options.deleteFolders;
    if (options.reuseCurrentJob) body.reuseCurrentJob = true;
    if (options.createNewJob) body.createNewJob = true;
    const result = await request(`/pipeline/restart-review/${jobId}`, {
      method: 'POST',
      body: Object.keys(body).length > 0 ? JSON.stringify(body) : undefined
    });
    afterMutationInvalidate(['/history', '/pipeline/queue']);
    return result;
  },
  async restartEncodeWithLastSettings(jobId, options = {}) {
    const body = {};
    if (options.keepBoth) body.keepBoth = true;
    if (Array.isArray(options.deleteFolders) && options.deleteFolders.length > 0) body.deleteFolders = options.deleteFolders;
    if (options.restartMode) body.restartMode = options.restartMode;
    if (options.createNewJob) body.createNewJob = true;
    const result = await request(`/pipeline/restart-encode/${jobId}`, {
      method: 'POST',
      body: Object.keys(body).length > 0 ? JSON.stringify(body) : undefined
    });
    afterMutationInvalidate(['/history', '/pipeline/queue']);
    return result;
  },
  getOutputFolders(jobId) {
    return request(`/pipeline/output-folders/${jobId}`);
  },
  async deleteOutputFolders(jobId, folderPaths = []) {
    const result = await request(`/pipeline/delete-output-folders/${jobId}`, {
      method: 'POST',
      body: JSON.stringify({ folderPaths })
    });
    afterMutationInvalidate(['/history']);
    return result;
  },
  async restartCdReviewFromRaw(jobId, options = {}) {
    const body = {};
    if (options.keepBoth) body.keepBoth = true;
    if (Array.isArray(options.deleteFolders) && options.deleteFolders.length > 0) body.deleteFolders = options.deleteFolders;
    const result = await request(`/pipeline/restart-cd-review/${jobId}`, {
      method: 'POST',
      body: Object.keys(body).length > 0 ? JSON.stringify(body) : undefined
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
    if (params.includeChildren) {
      query.set('includeChildren', '1');
    }
    const suffix = query.toString() ? `?${query.toString()}` : '';
    return request(`/history${suffix}`);
  },
  getTmdbMigrationPendingJobs(params = {}) {
    const query = new URLSearchParams();
    if (Number.isFinite(Number(params.limit)) && Number(params.limit) > 0) {
      query.set('limit', String(Math.trunc(Number(params.limit))));
    }
    const suffix = query.toString() ? `?${query.toString()}` : '';
    return request(`/history/tmdb-migration/pending${suffix}`);
  },
  async setJobTmdbMigrationFlag(jobId, migrated = false) {
    const result = await request(`/history/${jobId}/tmdb-migration`, {
      method: 'POST',
      body: JSON.stringify({
        migrated: Boolean(migrated)
      })
    });
    afterMutationInvalidate(['/history']);
    return result;
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
  async deleteOrphanRawFolder(rawPath) {
    const result = await request('/history/orphan-raw/delete', {
      method: 'POST',
      body: JSON.stringify({ rawPath })
    });
    afterMutationInvalidate(['/history']);
    return result;
  },
  async assignJobMetadata(jobId, payload = {}) {
    const result = await request(`/history/${jobId}/metadata/assign`, {
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
  async acknowledgeJobError(jobId) {
    const result = await request(`/history/${jobId}/error/ack`, {
      method: 'POST'
    });
    afterMutationInvalidate(['/history']);
    return result;
  },
  async generateJobNfo(jobId) {
    const result = await request(`/history/${jobId}/nfo/generate`, {
      method: 'POST'
    });
    afterMutationInvalidate(['/history']);
    return result;
  },
  async deleteJobFiles(jobId, target = 'both', options = {}) {
    const includeRelated = Boolean(options?.includeRelated);
    const selectedJobIds = Array.isArray(options?.selectedJobIds)
      ? options.selectedJobIds
        .map((item) => Number(item))
        .filter((value) => Number.isFinite(value) && value > 0)
        .map((value) => Math.trunc(value))
      : null;
    const selectedRawPaths = Array.isArray(options?.selectedRawPaths)
      ? options.selectedRawPaths
        .map((item) => String(item || '').trim())
        .filter(Boolean)
      : null;
    const selectedMoviePaths = Array.isArray(options?.selectedMoviePaths)
      ? options.selectedMoviePaths
        .map((item) => String(item || '').trim())
        .filter(Boolean)
      : null;
    const result = await request(`/history/${jobId}/delete-files`, {
      method: 'POST',
      body: JSON.stringify({
        target,
        includeRelated,
        ...(selectedJobIds ? { selectedJobIds } : {}),
        ...(selectedRawPaths ? { selectedRawPaths } : {}),
        ...(selectedMoviePaths ? { selectedMoviePaths } : {})
      })
    });
    afterMutationInvalidate(['/history']);
    return result;
  },
  getJobDeletePreview(jobId, options = {}) {
    const includeRelated = options?.includeRelated !== false;
    const selectedJobIds = Array.isArray(options?.selectedJobIds)
      ? options.selectedJobIds
        .map((item) => Number(item))
        .filter((value) => Number.isFinite(value) && value > 0)
        .map((value) => Math.trunc(value))
      : null;
    const query = new URLSearchParams();
    query.set('includeRelated', includeRelated ? '1' : '0');
    if (selectedJobIds) {
      query.set('selectedJobIds', selectedJobIds.join(','));
    }
    return request(`/history/${jobId}/delete-preview?${query.toString()}`);
  },
  async deleteJobEntry(jobId, target = 'none', options = {}) {
    const includeRelated = Boolean(options?.includeRelated);
    const resetDriveState = Boolean(options?.resetDriveState);
    const preserveRawForImportJobs = Boolean(options?.preserveRawForImportJobs);
    const selectedJobIds = Array.isArray(options?.selectedJobIds)
      ? options.selectedJobIds
        .map((item) => Number(item))
        .filter((value) => Number.isFinite(value) && value > 0)
        .map((value) => Math.trunc(value))
      : null;
    const selectedRawPaths = Array.isArray(options?.selectedRawPaths)
      ? options.selectedRawPaths
        .map((item) => String(item || '').trim())
        .filter(Boolean)
      : null;
    const selectedMoviePaths = Array.isArray(options?.selectedMoviePaths)
      ? options.selectedMoviePaths
        .map((item) => String(item || '').trim())
        .filter(Boolean)
      : null;
    const hasKeepDetectedDevice = options?.keepDetectedDevice !== undefined;
    const keepDetectedDevice = hasKeepDetectedDevice
      ? Boolean(options.keepDetectedDevice)
      : null;
    const result = await request(`/history/${jobId}/delete`, {
      method: 'POST',
      body: JSON.stringify({
        target,
        includeRelated,
        resetDriveState,
        preserveRawForImportJobs,
        ...(selectedJobIds ? { selectedJobIds } : {}),
        ...(hasKeepDetectedDevice ? { keepDetectedDevice } : {}),
        ...(selectedRawPaths ? { selectedRawPaths } : {}),
        ...(selectedMoviePaths ? { selectedMoviePaths } : {})
      })
    });
    afterMutationInvalidate(['/history', '/pipeline/queue']);
    return result;
  },
  requestJobArchive(jobId, target = 'raw', options = {}) {
    const outputPath = String(options?.outputPath || '').trim();
    return request(`/downloads/history/${jobId}`, {
      method: 'POST',
      body: JSON.stringify({
        target,
        ...(outputPath ? { outputPath } : {})
      })
    });
  },
  getDownloads() {
    return request('/downloads');
  },
  getDownloadsSummary() {
    return request('/downloads/summary');
  },
  downloadPreparedArchive(downloadId) {
    const link = document.createElement('a');
    link.href = `${API_BASE}/downloads/${encodeURIComponent(downloadId)}/file`;
    link.download = '';
    document.body.appendChild(link);
    link.click();
    link.remove();
    return Promise.resolve();
  },
  deleteDownload(downloadId) {
    return request(`/downloads/${encodeURIComponent(downloadId)}`, {
      method: 'DELETE'
    });
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
  getUserPresetDefaults(options = {}) {
    return requestCachedGet('/settings/user-preset-defaults', {
      ttlMs: 2 * 60 * 1000,
      forceRefresh: options.forceRefresh
    });
  },
  async updateUserPresetDefaults(defaults = {}) {
    const result = await request('/settings/user-preset-defaults', {
      method: 'PUT',
      body: JSON.stringify({ defaults })
    });
    afterMutationInvalidate(['/settings/user-preset-defaults']);
    return result;
  },
  async createUserPreset(payload = {}) {
    const result = await request('/settings/user-presets', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
    afterMutationInvalidate(['/settings/user-presets', '/settings/user-preset-defaults']);
    return result;
  },
  async updateUserPreset(id, payload = {}) {
    const result = await request(`/settings/user-presets/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify(payload)
    });
    afterMutationInvalidate(['/settings/user-presets', '/settings/user-preset-defaults']);
    return result;
  },
  async deleteUserPreset(id) {
    const result = await request(`/settings/user-presets/${encodeURIComponent(id)}`, {
      method: 'DELETE'
    });
    afterMutationInvalidate(['/settings/user-presets', '/settings/user-preset-defaults']);
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
  },

  // ── Converter ──────────────────────────────────────────────────────────────
  converterGetTree() {
    return request('/converter/tree');
  },
  converterBrowse(parent = null) {
    const q = parent ? `?parent=${encodeURIComponent(parent)}` : '';
    return request(`/converter/browse${q}`);
  },
  converterScan() {
    return request('/converter/scan', { method: 'POST' });
  },
  converterCreateJobs(entries) {
    return request('/converter/create-jobs', {
      method: 'POST',
      body: JSON.stringify({ entries })
    });
  },
  converterCreateJobsFromSelection(relPaths, audioMode = 'individual') {
    return request('/converter/jobs/from-selection', {
      method: 'POST',
      body: JSON.stringify({ relPaths, audioMode })
    });
  },
  converterAssignFilesToJob(jobId, relPaths = []) {
    afterMutationInvalidate(['/converter/jobs']);
    return request(`/converter/jobs/${encodeURIComponent(jobId)}/assign-files`, {
      method: 'POST',
      body: JSON.stringify({ relPaths })
    });
  },
  converterRemoveFileFromJob(jobId, relPath) {
    afterMutationInvalidate(['/converter/jobs']);
    return request(`/converter/jobs/${encodeURIComponent(jobId)}/remove-file`, {
      method: 'POST',
      body: JSON.stringify({ relPath })
    });
  },
  converterRemoveInputFromJob(jobId, inputPath) {
    afterMutationInvalidate(['/converter/jobs']);
    return request(`/converter/jobs/${encodeURIComponent(jobId)}/remove-input`, {
      method: 'POST',
      body: JSON.stringify({ inputPath })
    });
  },
  converterUpdateJobConfig(jobId, config = {}) {
    return request(`/converter/jobs/${encodeURIComponent(jobId)}/config`, {
      method: 'POST',
      body: JSON.stringify(config)
    });
  },
  converterUploadFiles(formData) {
    return request('/converter/upload', { method: 'POST', body: formData });
  },
  getConverterJobs() {
    return request('/converter/jobs');
  },
  startConverterJob(jobId, config = {}) {
    afterMutationInvalidate(['/converter/jobs']);
    return request(`/converter/jobs/${encodeURIComponent(jobId)}/start`, {
      method: 'POST',
      body: JSON.stringify(config)
    });
  },
  cancelConverterJob(jobId) {
    afterMutationInvalidate(['/converter/jobs']);
    return request(`/converter/jobs/${encodeURIComponent(jobId)}/cancel`, {
      method: 'POST'
    });
  },
  deleteConverterJob(jobId) {
    afterMutationInvalidate(['/converter/jobs']);
    return request(`/converter/jobs/${encodeURIComponent(jobId)}`, {
      method: 'DELETE'
    });
  },

  // ── Converter Datei-Operationen ──────────────────────────────────────────
  converterDeleteFile(relPath) {
    return request('/converter/files', { method: 'DELETE', body: JSON.stringify({ relPath }) });
  },
  converterRenameFile(relPath, newName) {
    return request('/converter/files/rename', { method: 'POST', body: JSON.stringify({ relPath, newName }) });
  },
  converterMoveFile(relPath, targetParentRelPath) {
    return request('/converter/files/move', { method: 'POST', body: JSON.stringify({ relPath, targetParentRelPath }) });
  },
  converterCreateFolder(parentRelPath, name) {
    return request('/converter/files/folder', { method: 'POST', body: JSON.stringify({ parentRelPath, name }) });
  }
};

export { API_BASE };
