const express = require('express');
const asyncHandler = require('../middleware/asyncHandler');
const historyService = require('../services/historyService');
const pipelineService = require('../services/pipelineService');
const logger = require('../services/logger').child('HISTORY_ROUTE');

const router = express.Router();

function parseSelectedJobIds(value, options = {}) {
  const { hasExplicitValue = true } = options;
  if (!hasExplicitValue) {
    return null;
  }
  const sourceValues = Array.isArray(value)
    ? value
    : String(value || '')
      .split(',');
  return sourceValues
    .map((entry) => Number(entry))
    .filter((entry) => Number.isFinite(entry) && entry > 0)
    .map((entry) => Math.trunc(entry));
}

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const parsedLimit = Number(req.query.limit);
    const limit = Number.isFinite(parsedLimit) && parsedLimit > 0
      ? Math.trunc(parsedLimit)
      : null;
    const statuses = String(req.query.statuses || '')
      .split(',')
      .map((value) => String(value || '').trim())
      .filter(Boolean);
    const lite = ['1', 'true', 'yes'].includes(String(req.query.lite || '').toLowerCase());
    const includeChildren = ['1', 'true', 'yes'].includes(String(req.query.includeChildren || '').toLowerCase());
    logger.info('get:jobs', {
      reqId: req.reqId,
      status: req.query.status,
      statuses: statuses.length > 0 ? statuses : null,
      search: req.query.search,
      limit,
      lite,
      includeChildren
    });

    const jobs = await historyService.getJobs({
      status: req.query.status,
      statuses,
      search: req.query.search,
      limit,
      includeFsChecks: !lite,
      includeChildren
    });

    res.json({ jobs });
  })
);

router.get(
  '/orphan-raw',
  asyncHandler(async (req, res) => {
    logger.info('get:orphan-raw', { reqId: req.reqId });
    const result = await historyService.getOrphanRawFolders();
    res.json(result);
  })
);

router.get(
  '/tmdb-migration/pending',
  asyncHandler(async (req, res) => {
    const parsedLimit = Number(req.query.limit);
    const limit = Number.isFinite(parsedLimit) && parsedLimit > 0
      ? Math.trunc(parsedLimit)
      : 500;
    logger.info('get:tmdb-migration:pending', {
      reqId: req.reqId,
      limit
    });
    const jobs = await historyService.getTmdbMigrationPendingJobs({
      limit,
      includeFsChecks: false
    });
    res.json({ jobs });
  })
);

router.post(
  '/:id/tmdb-migration',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const migrated = ['1', 'true', 'yes', 'on'].includes(
      String(req.body?.migrated ?? req.body?.migrateTMDB ?? '').trim().toLowerCase()
    );
    logger.info('post:tmdb-migration:flag', {
      reqId: req.reqId,
      id,
      migrated
    });
    const job = await historyService.setTmdbMigrationFlag(id, migrated);
    res.json({ job });
  })
);

router.post(
  '/orphan-raw/import',
  asyncHandler(async (req, res) => {
    const rawPath = String(req.body?.rawPath || '').trim();
    logger.info('post:orphan-raw:import', { reqId: req.reqId, rawPath });
    const importedJob = await historyService.importOrphanRawFolder(rawPath);
    const importedJobId = Number(importedJob?.id || 0);
    let activation = null;
    let activationError = null;
    if (Number.isFinite(importedJobId) && importedJobId > 0) {
      try {
        activation = await pipelineService.analyzeRawImportJob(importedJobId, {
          rawPath: importedJob?.raw_path || rawPath
        });
      } catch (error) {
        activationError = error?.message || String(error);
        logger.warn('post:orphan-raw:import:activation-failed', {
          reqId: req.reqId,
          jobId: importedJobId,
          rawPath,
          error: activationError
        });
      }
    }

    const refreshedJob = importedJobId > 0
      ? await historyService.getJobById(importedJobId)
      : null;

    res.json({
      job: refreshedJob || importedJob,
      activation,
      ...(activationError ? { activationError } : {})
    });
  })
);

router.post(
  '/orphan-raw/delete',
  asyncHandler(async (req, res) => {
    const rawPath = String(req.body?.rawPath || '').trim();
    logger.warn('post:orphan-raw:delete', { reqId: req.reqId, rawPath });
    const result = await historyService.deleteOrphanRawFolder(rawPath);
    res.json(result);
  })
);

router.post(
  '/:id/metadata/assign',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const payload = req.body || {};
    logger.info('post:job:metadata:assign', {
      reqId: req.reqId,
      id,
      imdbId: payload?.imdbId || null,
      hasTitle: Boolean(payload?.title),
      hasYear: Boolean(payload?.year)
    });

    const job = await historyService.assignMetadata(id, payload);

    // Rename raw/output folders to reflect new metadata (best-effort, non-blocking)
    pipelineService.renameJobFolders(id).catch((err) => {
      logger.warn('post:job:metadata:assign:rename-failed', { id, error: err.message });
    });

    res.json({ job });
  })
);

router.post(
  '/:id/cd/assign',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const payload = req.body || {};
    logger.info('post:job:cd:assign', {
      reqId: req.reqId,
      id,
      mbId: payload?.mbId || null,
      hasTitle: Boolean(payload?.title),
      hasArtist: Boolean(payload?.artist),
      trackCount: Array.isArray(payload?.tracks) ? payload.tracks.length : 0
    });

    const job = await pipelineService.selectCdMetadata({
      jobId: id,
      title: payload?.title,
      artist: payload?.artist,
      year: payload?.year,
      mbId: payload?.mbId,
      coverUrl: payload?.coverUrl,
      tracks: payload?.tracks
    });

    // Rename raw/output folders to reflect new metadata (best-effort, non-blocking)
    pipelineService.renameJobFolders(id).catch((err) => {
      logger.warn('post:job:cd:assign:rename-failed', { id, error: err.message });
    });

    res.json({ job });
  })
);

router.post(
  '/:id/error/ack',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    logger.info('post:job:error:ack', { reqId: req.reqId, id });
    const job = await historyService.acknowledgeJobError(id);
    res.json({ job });
  })
);

router.post(
  '/:id/nfo/generate',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    logger.info('post:job:nfo:generate', { reqId: req.reqId, id });
    const result = await historyService.generateJobNfo(id, {
      mode: 'manual',
      requireSettingDisabled: true,
      failIfExists: true,
      failIfOutputMissing: true
    });
    const job = await historyService.getJobWithLogs(id, { includeFsChecks: true });
    res.json({ result, job });
  })
);

router.post(
  '/:id/delete-files',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const target = String(req.body?.target || 'both');
    const includeRelated = ['1', 'true', 'yes'].includes(String(req.body?.includeRelated || 'false').toLowerCase());
    const selectedJobIds = parseSelectedJobIds(req.body?.selectedJobIds, {
      hasExplicitValue: Object.prototype.hasOwnProperty.call(req.body || {}, 'selectedJobIds')
    });
    const selectedRawPaths = Array.isArray(req.body?.selectedRawPaths)
      ? req.body.selectedRawPaths
        .map((item) => String(item || '').trim())
        .filter(Boolean)
      : null;
    const selectedMoviePaths = Array.isArray(req.body?.selectedMoviePaths)
      ? req.body.selectedMoviePaths
        .map((item) => String(item || '').trim())
        .filter(Boolean)
      : null;

    logger.warn('post:delete-files', {
      reqId: req.reqId,
      id,
      target,
      includeRelated,
      selectedJobIdCount: selectedJobIds ? selectedJobIds.length : 0,
      selectedRawPathCount: selectedRawPaths ? selectedRawPaths.length : 0,
      selectedMoviePathCount: selectedMoviePaths ? selectedMoviePaths.length : 0
    });

    const result = await historyService.deleteJobFiles(id, target, {
      includeRelated,
      selectedJobIds,
      selectedRawPaths,
      selectedMoviePaths
    });
    res.json(result);
  })
);

router.get(
  '/:id/delete-preview',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const includeRelated = ['1', 'true', 'yes'].includes(String(req.query.includeRelated || '1').toLowerCase());
    const selectedJobIds = parseSelectedJobIds(req.query.selectedJobIds, {
      hasExplicitValue: Object.prototype.hasOwnProperty.call(req.query || {}, 'selectedJobIds')
    });

    logger.info('get:delete-preview', {
      reqId: req.reqId,
      id,
      includeRelated,
      selectedJobIdCount: selectedJobIds ? selectedJobIds.length : 0
    });

    const preview = await historyService.getJobDeletePreview(id, { includeRelated, selectedJobIds });
    res.json({ preview });
  })
);

router.post(
  '/:id/delete',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const target = String(req.body?.target || 'none');
    const includeRelated = ['1', 'true', 'yes'].includes(String(req.body?.includeRelated || 'false').toLowerCase());
    const selectedJobIds = parseSelectedJobIds(req.body?.selectedJobIds, {
      hasExplicitValue: Object.prototype.hasOwnProperty.call(req.body || {}, 'selectedJobIds')
    });
    const requestedResetDriveState = ['1', 'true', 'yes'].includes(String(req.body?.resetDriveState || 'false').toLowerCase());
    const preserveRawForImportJobs = ['1', 'true', 'yes'].includes(String(req.body?.preserveRawForImportJobs || 'false').toLowerCase());
    const hasRequestedKeepDetectedDevice = req.body?.keepDetectedDevice !== undefined;
    const requestedKeepDetectedDevice = hasRequestedKeepDetectedDevice
      ? ['1', 'true', 'yes'].includes(String(req.body?.keepDetectedDevice || 'false').toLowerCase())
      : null;
    const selectedRawPaths = Array.isArray(req.body?.selectedRawPaths)
      ? req.body.selectedRawPaths
        .map((item) => String(item || '').trim())
        .filter(Boolean)
      : null;
    const selectedMoviePaths = Array.isArray(req.body?.selectedMoviePaths)
      ? req.body.selectedMoviePaths
        .map((item) => String(item || '').trim())
        .filter(Boolean)
      : null;

    logger.warn('post:delete-job', {
      reqId: req.reqId,
      id,
      target,
      includeRelated,
      selectedJobIdCount: selectedJobIds ? selectedJobIds.length : 0,
      requestedResetDriveState,
      preserveRawForImportJobs,
      requestedKeepDetectedDevice,
      selectedRawPathCount: selectedRawPaths ? selectedRawPaths.length : 0,
      selectedMoviePathCount: selectedMoviePaths ? selectedMoviePaths.length : 0
    });

    const preview = await historyService.getJobDeletePreview(id, { includeRelated, selectedJobIds });
    const containsOrphanRawImportJob = Boolean(
      preview?.flags?.containsOrphanRawImportJob
      || (Array.isArray(preview?.relatedJobs) && preview.relatedJobs.some(
        (row) => Boolean(row?.selected) && Boolean(row?.orphanRawImport)
      ))
    );
    const selectedDeleteJobIds = Array.isArray(preview?.selectedJobIds)
      ? preview.selectedJobIds
      : [id];
    const selectedDeleteJobs = await historyService.getJobsByIds(selectedDeleteJobIds).catch(() => []);
    const autoResetDriveStateForPhysicalCd = Array.isArray(selectedDeleteJobs) && selectedDeleteJobs.some((job) => {
      const mediaType = String(job?.media_type || job?.mediaType || '').trim().toLowerCase();
      const jobKind = String(job?.job_kind || job?.jobKind || '').trim().toLowerCase();
      const status = String(job?.status || '').trim().toUpperCase();
      const lastState = String(job?.last_state || '').trim().toUpperCase();
      const isCdJob = mediaType === 'cd'
        || jobKind === 'cd'
        || status.startsWith('CD_')
        || lastState.startsWith('CD_');
      if (!isCdJob) {
        return false;
      }
      const discDevice = String(job?.disc_device || job?.discDevice || '').trim();
      return Boolean(discDevice) && !discDevice.startsWith('__virtual__');
    });

    const requestedResetDriveStateEffective = requestedResetDriveState || autoResetDriveStateForPhysicalCd;
    const resetDriveState = containsOrphanRawImportJob
      ? false
      : requestedResetDriveStateEffective;
    const keepDetectedDevice = containsOrphanRawImportJob
      ? true
      : (hasRequestedKeepDetectedDevice
          ? requestedKeepDetectedDevice
          : !requestedResetDriveStateEffective);

    if (containsOrphanRawImportJob && requestedResetDriveState) {
      logger.info('post:delete-job:orphan-drive-reset-skipped', {
        reqId: req.reqId,
        id
      });
    }

    if (autoResetDriveStateForPhysicalCd && !requestedResetDriveState) {
      logger.info('post:delete-job:auto-drive-reset-cd', {
        reqId: req.reqId,
        id,
        selectedJobIds: selectedDeleteJobIds
      });
    }

    const relatedDevicePaths = Array.isArray(preview?.relatedJobs)
      ? preview.relatedJobs
        .filter((row) => Boolean(row?.selected))
        .map((row) => String(row?.discDevice || '').trim())
        .filter(Boolean)
      : [];
    const result = await historyService.deleteJob(id, target, {
      includeRelated,
      selectedJobIds,
      selectedRawPaths,
      selectedMoviePaths,
      preserveRawForImportJobs
    });
    await pipelineService.onJobsDeleted(result?.deletedJobIds || [id], {
      resetDriveState,
      devicePaths: relatedDevicePaths
    }).catch((error) => {
      logger.warn('post:delete-job:cleanup-failed', { id, error: error?.message || String(error) });
    });
    const uiReset = await pipelineService.resetFrontendState('history_delete', {
      keepDetectedDevice
    });
    res.json({
      ...result,
      uiReset,
      safeguards: {
        containsOrphanRawImportJob,
        resetDriveStateApplied: resetDriveState,
        keepDetectedDeviceApplied: keepDetectedDevice
      }
    });
  })
);

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const includeLiveLog = ['1', 'true', 'yes'].includes(String(req.query.includeLiveLog || '').toLowerCase());
    const includeLogs = ['1', 'true', 'yes'].includes(String(req.query.includeLogs || '').toLowerCase());
    const includeAllLogs = ['1', 'true', 'yes'].includes(String(req.query.includeAllLogs || '').toLowerCase());
    const lite = ['1', 'true', 'yes'].includes(String(req.query.lite || '').toLowerCase());
    const parsedTail = Number(req.query.logTailLines);
    const logTailLines = Number.isFinite(parsedTail) && parsedTail > 0
      ? Math.trunc(parsedTail)
      : null;
    const includeFsChecks = !(lite || includeLiveLog);

    logger.info('get:job-detail', {
      reqId: req.reqId,
      id,
      includeLiveLog,
      includeLogs,
      includeAllLogs,
      logTailLines,
      lite,
      includeFsChecks
    });
    const job = await historyService.getJobWithLogs(id, {
      includeLiveLog,
      includeLogs,
      includeAllLogs,
      logTailLines,
      includeFsChecks
    });
    if (!job) {
      const error = new Error('Job nicht gefunden.');
      error.statusCode = 404;
      throw error;
    }

    res.json({ job });
  })
);

module.exports = router;
