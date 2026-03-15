const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { spawnSync } = require('child_process');
const archiver = require('archiver');
const settingsService = require('./settingsService');
const historyService = require('./historyService');
const wsService = require('./websocketService');
const logger = require('./logger').child('DOWNLOADS');

function safeJsonParse(raw, fallback = null) {
  if (!raw) {
    return fallback;
  }
  try {
    return JSON.parse(raw);
  } catch (_error) {
    return fallback;
  }
}

function normalizeDownloadId(value) {
  const raw = String(value || '').trim();
  return raw || null;
}

function normalizeStatus(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (['queued', 'processing', 'ready', 'failed'].includes(raw)) {
    return raw;
  }
  return 'failed';
}

function normalizeTarget(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (raw === 'raw') {
    return 'raw';
  }
  if (raw === 'output') {
    return 'output';
  }
  return 'output';
}

function normalizeDateString(value) {
  const raw = String(value || '').trim();
  if (!raw) {
    return null;
  }
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function normalizeNumber(value, fallback = null) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function compareCreatedDesc(a, b) {
  const left = String(a?.createdAt || '');
  const right = String(b?.createdAt || '');
  return right.localeCompare(left) || String(b?.id || '').localeCompare(String(a?.id || ''));
}

function applyOwnerToPath(targetPath, ownerSpec) {
  const spec = String(ownerSpec || '').trim();
  if (!targetPath || !spec) {
    return;
  }
  try {
    const result = spawnSync('chown', [spec, targetPath], { timeout: 15000 });
    if (result.status !== 0) {
      logger.warn('download:chown:failed', {
        targetPath,
        spec,
        stderr: String(result.stderr || '').trim() || null
      });
    }
  } catch (error) {
    logger.warn('download:chown:error', {
      targetPath,
      spec,
      error: error?.message || String(error)
    });
  }
}

class DownloadService {
  constructor() {
    this.items = new Map();
    this.activeTasks = new Map();
    this.initPromise = null;
  }

  async init() {
    if (!this.initPromise) {
      this.initPromise = this._init();
    }
    return this.initPromise;
  }

  async _init() {
    const settings = await settingsService.getEffectiveSettingsMap(null);
    const downloadDir = String(settings?.download_dir || '').trim();
    const owner = String(settings?.download_dir_owner || '').trim() || null;
    await fs.promises.mkdir(downloadDir, { recursive: true });
    applyOwnerToPath(downloadDir, owner);

    let entries = [];
    try {
      entries = await fs.promises.readdir(downloadDir, { withFileTypes: true });
    } catch (error) {
      logger.warn('download:init:readdir-failed', {
        downloadDir,
        error: error?.message || String(error)
      });
      entries = [];
    }

    const nowIso = new Date().toISOString();

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) {
        continue;
      }
      const metaPath = path.join(downloadDir, entry.name);
      const parsed = safeJsonParse(await fs.promises.readFile(metaPath, 'utf-8').catch(() => null), null);
      if (!parsed || typeof parsed !== 'object') {
        continue;
      }
      const item = this._normalizeLoadedItem(parsed, downloadDir);
      if (!item) {
        continue;
      }

      let changed = false;
      if (item.status === 'queued' || item.status === 'processing') {
        item.status = 'failed';
        item.errorMessage = 'ZIP-Erstellung wurde durch einen Server-Neustart unterbrochen.';
        item.finishedAt = nowIso;
        changed = true;
        await this._safeUnlink(item.partialPath);
      } else if (item.status === 'ready') {
        const exists = await this._pathExists(item.archivePath);
        if (!exists) {
          item.status = 'failed';
          item.errorMessage = 'ZIP-Datei wurde nicht gefunden.';
          item.finishedAt = nowIso;
          item.sizeBytes = null;
          changed = true;
        }
      }

      this.items.set(item.id, item);
      if (changed) {
        await this._persistItem(item);
      }
    }
  }

  _normalizeLoadedItem(rawItem, fallbackDir) {
    const id = normalizeDownloadId(rawItem?.id);
    if (!id) {
      return null;
    }
    const downloadDir = String(rawItem?.downloadDir || fallbackDir || '').trim();
    if (!downloadDir) {
      return null;
    }
    return {
      id,
      kind: String(rawItem?.kind || 'history').trim() || 'history',
      jobId: normalizeNumber(rawItem?.jobId, null),
      target: normalizeTarget(rawItem?.target),
      label: String(rawItem?.label || (rawItem?.target === 'raw' ? 'RAW' : 'Encode')).trim() || 'Download',
      displayTitle: String(rawItem?.displayTitle || '').trim() || null,
      sourcePath: String(rawItem?.sourcePath || '').trim() || null,
      sourceType: String(rawItem?.sourceType || '').trim() === 'file' ? 'file' : 'directory',
      sourceMtimeMs: normalizeNumber(rawItem?.sourceMtimeMs, null),
      sourceModifiedAt: normalizeDateString(rawItem?.sourceModifiedAt),
      entryName: String(rawItem?.entryName || '').trim() || null,
      archiveName: String(rawItem?.archiveName || `${id}.zip`).trim() || `${id}.zip`,
      downloadDir,
      archivePath: String(rawItem?.archivePath || path.join(downloadDir, `${id}.zip`)).trim(),
      partialPath: String(rawItem?.partialPath || path.join(downloadDir, `${id}.partial.zip`)).trim(),
      metaPath: String(rawItem?.metaPath || path.join(downloadDir, `${id}.json`)).trim(),
      ownerSpec: String(rawItem?.ownerSpec || '').trim() || null,
      status: normalizeStatus(rawItem?.status),
      createdAt: normalizeDateString(rawItem?.createdAt) || new Date().toISOString(),
      startedAt: normalizeDateString(rawItem?.startedAt),
      finishedAt: normalizeDateString(rawItem?.finishedAt),
      errorMessage: String(rawItem?.errorMessage || '').trim() || null,
      sizeBytes: normalizeNumber(rawItem?.sizeBytes, null)
    };
  }

  _serializeItem(item) {
    return {
      id: item.id,
      kind: item.kind,
      jobId: item.jobId,
      target: item.target,
      label: item.label,
      displayTitle: item.displayTitle,
      sourcePath: item.sourcePath,
      sourceType: item.sourceType,
      archiveName: item.archiveName,
      downloadDir: item.downloadDir,
      status: item.status,
      createdAt: item.createdAt,
      startedAt: item.startedAt,
      finishedAt: item.finishedAt,
      errorMessage: item.errorMessage,
      sizeBytes: item.sizeBytes,
      downloadUrl: item.status === 'ready' ? `/api/downloads/${encodeURIComponent(item.id)}/file` : null
    };
  }

  getSummary() {
    const items = Array.from(this.items.values());
    const queuedCount = items.filter((item) => item.status === 'queued').length;
    const processingCount = items.filter((item) => item.status === 'processing').length;
    const readyCount = items.filter((item) => item.status === 'ready').length;
    const failedCount = items.filter((item) => item.status === 'failed').length;

    return {
      totalCount: items.length,
      queuedCount,
      processingCount,
      activeCount: queuedCount + processingCount,
      readyCount,
      failedCount
    };
  }

  _broadcastUpdate(reason, item = null) {
    wsService.broadcast('DOWNLOADS_UPDATED', {
      reason: String(reason || 'updated').trim() || 'updated',
      summary: this.getSummary(),
      item: item ? this._serializeItem(item) : null
    });
  }

  async listItems() {
    await this.init();
    return Array.from(this.items.values())
      .sort(compareCreatedDesc)
      .map((item) => this._serializeItem(item));
  }

  async getItem(id) {
    await this.init();
    const normalizedId = normalizeDownloadId(id);
    if (!normalizedId || !this.items.has(normalizedId)) {
      const error = new Error('Download nicht gefunden.');
      error.statusCode = 404;
      throw error;
    }
    return this.items.get(normalizedId);
  }

  async enqueueHistoryJob(jobId, target) {
    await this.init();
    const descriptor = await historyService.getJobArchiveDescriptor(jobId, target);
    const settings = await settingsService.getEffectiveSettingsMap(null);
    const downloadDir = String(settings?.download_dir || '').trim();
    const ownerSpec = String(settings?.download_dir_owner || '').trim() || null;
    await fs.promises.mkdir(downloadDir, { recursive: true });
    applyOwnerToPath(downloadDir, ownerSpec);

    const reusable = await this._findReusableHistoryItem(descriptor, downloadDir);
    if (reusable) {
      return {
        item: this._serializeItem(reusable),
        reused: true,
        created: false
      };
    }

    const id = randomUUID();
    const nowIso = new Date().toISOString();
    const item = {
      id,
      kind: 'history',
      jobId: descriptor.jobId,
      target: descriptor.target,
      label: descriptor.target === 'raw' ? 'RAW' : 'Encode',
      displayTitle: descriptor.displayTitle,
      sourcePath: descriptor.sourcePath,
      sourceType: descriptor.sourceType,
      sourceMtimeMs: descriptor.sourceMtimeMs,
      sourceModifiedAt: descriptor.sourceModifiedAt,
      entryName: descriptor.entryName,
      archiveName: descriptor.archiveName,
      downloadDir,
      archivePath: path.join(downloadDir, `${id}.zip`),
      partialPath: path.join(downloadDir, `${id}.partial.zip`),
      metaPath: path.join(downloadDir, `${id}.json`),
      ownerSpec,
      status: 'queued',
      createdAt: nowIso,
      startedAt: null,
      finishedAt: null,
      errorMessage: null,
      sizeBytes: null
    };

    this.items.set(id, item);
    await this._persistItem(item);
    this._broadcastUpdate('queued', item);

    setImmediate(() => {
      void this._startArchiveJob(id);
    });

    return {
      item: this._serializeItem(item),
      reused: false,
      created: true
    };
  }

  async _findReusableHistoryItem(descriptor, downloadDir) {
    for (const item of this.items.values()) {
      if (item.kind !== 'history') {
        continue;
      }
      if (item.jobId !== descriptor.jobId || item.target !== descriptor.target) {
        continue;
      }
      if (item.sourcePath !== descriptor.sourcePath || item.sourceMtimeMs !== descriptor.sourceMtimeMs) {
        continue;
      }
      if (item.downloadDir !== downloadDir) {
        continue;
      }
      if (!['queued', 'processing', 'ready'].includes(item.status)) {
        continue;
      }
      if (item.status === 'ready' && !(await this._pathExists(item.archivePath))) {
        item.status = 'failed';
        item.errorMessage = 'ZIP-Datei wurde nicht gefunden.';
        item.finishedAt = new Date().toISOString();
        item.sizeBytes = null;
        await this._persistItem(item);
        this._broadcastUpdate('failed', item);
        continue;
      }
      return item;
    }
    return null;
  }

  async _startArchiveJob(id) {
    const item = this.items.get(id);
    if (!item) {
      return;
    }
    if (this.activeTasks.has(id)) {
      return this.activeTasks.get(id);
    }

    const promise = this._runArchiveJob(item)
      .catch((error) => {
        logger.warn('download:job:failed', {
          id,
          archiveName: item.archiveName,
          error: error?.message || String(error)
        });
      })
      .finally(() => {
        this.activeTasks.delete(id);
      });

    this.activeTasks.set(id, promise);
    return promise;
  }

  async _runArchiveJob(item) {
    item.status = 'processing';
    item.startedAt = new Date().toISOString();
    item.finishedAt = null;
    item.errorMessage = null;
    item.sizeBytes = null;
    await this._safeUnlink(item.partialPath);
    await this._persistItem(item);
    this._broadcastUpdate('processing', item);

    await fs.promises.mkdir(item.downloadDir, { recursive: true });
    applyOwnerToPath(item.downloadDir, item.ownerSpec);

    await new Promise((resolve, reject) => {
      let settled = false;
      const output = fs.createWriteStream(item.partialPath);
      const archive = archiver('zip', { zlib: { level: 9 } });

      const finishError = (error) => {
        if (settled) {
          return;
        }
        settled = true;
        output.destroy();
        reject(error);
      };

      output.on('close', () => {
        if (settled) {
          return;
        }
        settled = true;
        resolve();
      });
      output.on('error', finishError);
      archive.on('warning', finishError);
      archive.on('error', finishError);

      archive.pipe(output);
      if (item.sourceType === 'directory') {
        archive.directory(item.sourcePath, item.entryName);
      } else {
        archive.file(item.sourcePath, { name: item.entryName });
      }

      try {
        const finalizeResult = archive.finalize();
        if (finalizeResult && typeof finalizeResult.catch === 'function') {
          finalizeResult.catch(finishError);
        }
      } catch (error) {
        finishError(error);
      }
    }).catch(async (error) => {
      await this._safeUnlink(item.partialPath);
      item.status = 'failed';
      item.finishedAt = new Date().toISOString();
      item.errorMessage = error?.message || 'ZIP-Erstellung fehlgeschlagen.';
      item.sizeBytes = null;
      await this._persistItem(item);
      this._broadcastUpdate('failed', item);
      throw error;
    });

    await fs.promises.rename(item.partialPath, item.archivePath);
    applyOwnerToPath(item.archivePath, item.ownerSpec);

    const stat = await fs.promises.stat(item.archivePath);
    item.status = 'ready';
    item.finishedAt = new Date().toISOString();
    item.errorMessage = null;
    item.sizeBytes = stat.size;
    await this._persistItem(item);
    this._broadcastUpdate('ready', item);
  }

  async getDownloadDescriptor(id) {
    const item = await this.getItem(id);
    if (item.status !== 'ready') {
      const error = new Error('ZIP-Datei ist noch nicht fertig.');
      error.statusCode = 409;
      throw error;
    }
    const exists = await this._pathExists(item.archivePath);
    if (!exists) {
      item.status = 'failed';
      item.finishedAt = new Date().toISOString();
      item.errorMessage = 'ZIP-Datei wurde nicht gefunden.';
      item.sizeBytes = null;
      await this._persistItem(item);
      this._broadcastUpdate('failed', item);
      const error = new Error('ZIP-Datei wurde nicht gefunden.');
      error.statusCode = 404;
      throw error;
    }
    return {
      path: item.archivePath,
      archiveName: item.archiveName
    };
  }

  async deleteItem(id) {
    const item = await this.getItem(id);
    if (item.status === 'queued' || item.status === 'processing' || this.activeTasks.has(item.id)) {
      const error = new Error('Laufende ZIP-Jobs können nicht gelöscht werden.');
      error.statusCode = 409;
      throw error;
    }

    await this._safeUnlink(item.archivePath);
    await this._safeUnlink(item.partialPath);
    await this._safeUnlink(item.metaPath);
    this.items.delete(item.id);
    this._broadcastUpdate('deleted', item);
    return {
      deleted: true,
      id: item.id
    };
  }

  async _persistItem(item) {
    const next = {
      ...item,
      metaPath: item.metaPath,
      archivePath: item.archivePath,
      partialPath: item.partialPath
    };
    const tmpMetaPath = `${item.metaPath}.tmp`;
    await fs.promises.writeFile(tmpMetaPath, JSON.stringify(next, null, 2), 'utf-8');
    await fs.promises.rename(tmpMetaPath, item.metaPath);
    applyOwnerToPath(item.metaPath, item.ownerSpec);
  }

  async _safeUnlink(targetPath) {
    if (!targetPath) {
      return;
    }
    try {
      await fs.promises.rm(targetPath, { force: true });
    } catch (_error) {
      // ignore cleanup errors
    }
  }

  async _pathExists(targetPath) {
    if (!targetPath) {
      return false;
    }
    try {
      await fs.promises.access(targetPath, fs.constants.F_OK);
      return true;
    } catch (_error) {
      return false;
    }
  }
}

module.exports = new DownloadService();
