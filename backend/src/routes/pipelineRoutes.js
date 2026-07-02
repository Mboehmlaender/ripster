const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const asyncHandler = require('../middleware/asyncHandler');
const pipelineService = require('../services/pipelineService');
const historyService = require('../services/historyService');
const diskDetectionService = require('../services/diskDetectionService');
const hardwareMonitorService = require('../services/hardwareMonitorService');
const settingsService = require('../services/settingsService');
const logger = require('../services/logger').child('PIPELINE_ROUTE');
const activationBytesService = require('../services/activationBytesService');
const { tempDir } = require('../config');
const { getDb } = require('../db/database');

const router = express.Router();
const audiobookUploadDir = path.join(tempDir, 'ripster-audiobook-uploads');
fs.mkdirSync(audiobookUploadDir, { recursive: true });
const audiobookUpload = multer({
  dest: audiobookUploadDir
});

router.get(
  '/state',
  asyncHandler(async (req, res) => {
    logger.debug('get:state', { reqId: req.reqId });
    res.json({
      pipeline: pipelineService.getSnapshot(),
      hardwareMonitoring: hardwareMonitorService.getSnapshot()
    });
  })
);

router.get(
  '/hardware/history',
  asyncHandler(async (req, res) => {
    const hoursRaw = Number(req.query?.hours);
    const maxPointsRaw = Number(req.query?.maxPoints);
    const hours = Number.isFinite(hoursRaw) ? Math.max(1, Math.min(96, Math.trunc(hoursRaw))) : 24;
    const maxPoints = Number.isFinite(maxPointsRaw) ? Math.max(120, Math.min(5000, Math.trunc(maxPointsRaw))) : 720;
    const sinceIso = new Date(Date.now() - (hours * 60 * 60 * 1000)).toISOString();
    const db = await getDb();
    const rows = await db.all(
      `
        SELECT
          captured_at,
          cpu_usage_percent,
          cpu_temperature_c,
          ram_usage_percent,
          ram_used_bytes,
          ram_total_bytes,
          gpu_usage_percent,
          gpu_temperature_c,
          vram_used_bytes,
          vram_total_bytes
        FROM hardware_metrics_history
        WHERE captured_at >= ?
        ORDER BY captured_at ASC
      `,
      [sinceIso]
    );

    const stride = rows.length > maxPoints ? Math.ceil(rows.length / maxPoints) : 1;
    const sampled = [];
    for (let index = 0; index < rows.length; index += stride) {
      sampled.push(rows[index]);
    }
    if (rows.length > 0 && sampled[sampled.length - 1] !== rows[rows.length - 1]) {
      sampled.push(rows[rows.length - 1]);
    }

    const points = sampled.map((row) => ({
      capturedAt: row.captured_at,
      cpuUsagePercent: row.cpu_usage_percent,
      cpuTemperatureC: row.cpu_temperature_c,
      ramUsagePercent: row.ram_usage_percent,
      ramUsedBytes: row.ram_used_bytes,
      ramTotalBytes: row.ram_total_bytes,
      gpuUsagePercent: row.gpu_usage_percent,
      gpuTemperatureC: row.gpu_temperature_c,
      vramUsedBytes: row.vram_used_bytes,
      vramTotalBytes: row.vram_total_bytes
    }));

    res.json({
      history: {
        hours,
        maxPoints,
        totalPoints: rows.length,
        points
      }
    });
  })
);

router.post(
  '/analyze',
  asyncHandler(async (req, res) => {
    const devicePath = String(req.body?.devicePath || '').trim() || null;
    logger.info('post:analyze', { reqId: req.reqId, devicePath });
    const result = await pipelineService.analyzeDisc(devicePath);
    res.json({ result });
  })
);

router.get(
  '/cd/drives',
  asyncHandler(async (req, res) => {
    logger.debug('get:cd:drives', { reqId: req.reqId });
    const snapshot = pipelineService.getSnapshot();
    res.json({ cdDrives: snapshot.cdDrives || {} });
  })
);

router.post(
  '/rescan-disc',
  asyncHandler(async (req, res) => {
    logger.info('post:rescan-disc', { reqId: req.reqId });
    const result = await diskDetectionService.rescanAndEmit();
    res.json({ result });
  })
);

router.post(
  '/rescan-drive',
  asyncHandler(async (req, res) => {
    const devicePath = String(req.body?.devicePath || '').trim();
    logger.info('post:rescan-drive', { reqId: req.reqId, devicePath });
    if (!devicePath) {
      const err = new Error('devicePath ist erforderlich');
      err.statusCode = 400;
      throw err;
    }
    const result = await diskDetectionService.rescanDriveAndEmit(devicePath);
    res.json({ result });
  })
);

router.get(
  '/tmdb/movie/search',
  asyncHandler(async (req, res) => {
    const query = req.query.q || '';
    logger.info('get:tmdb:movie-search', { reqId: req.reqId, query });
    const results = await pipelineService.searchTmdbMovies(String(query));
    res.json({ results });
  })
);

router.get(
  '/tmdb/series/search',
  asyncHandler(async (req, res) => {
    const query = req.query.q || '';
    const seasonNumber = req.query.season || null;
    logger.info('get:tmdb:series-search', { reqId: req.reqId, query, seasonNumber });
    const results = await pipelineService.searchTmdbSeries(String(query), seasonNumber);
    res.json({ results });
  })
);

router.get(
  '/cd/musicbrainz/search',
  asyncHandler(async (req, res) => {
    const query = req.query.q || '';
    const trackCountRaw = Number(req.query.trackCount);
    const trackCount = Number.isFinite(trackCountRaw) && trackCountRaw > 0
      ? Math.trunc(trackCountRaw)
      : null;
    logger.info('get:cd:musicbrainz:search', { reqId: req.reqId, query, trackCount });
    const results = await pipelineService.searchMusicBrainz(String(query), { trackCount });
    res.json({ results });
  })
);

router.get(
  '/cd/musicbrainz/release/:mbId',
  asyncHandler(async (req, res) => {
    const mbId = String(req.params.mbId || '').trim();
    if (!mbId) {
      const error = new Error('mbId fehlt.');
      error.statusCode = 400;
      throw error;
    }
    logger.info('get:cd:musicbrainz:release', { reqId: req.reqId, mbId });
    const release = await pipelineService.getMusicBrainzReleaseById(mbId);
    res.json({ release });
  })
);

router.post(
  '/cd/select-metadata',
  asyncHandler(async (req, res) => {
    const { jobId, title, artist, year, mbId, coverUrl, tracks } = req.body;
    if (!jobId) {
      const error = new Error('jobId fehlt.');
      error.statusCode = 400;
      throw error;
    }
    logger.info('post:cd:select-metadata', { reqId: req.reqId, jobId, title, artist, year, mbId });
    const job = await pipelineService.selectCdMetadata({
      jobId: Number(jobId),
      title,
      artist,
      year,
      mbId,
      coverUrl,
      tracks
    });
    res.json({ job });
  })
);

router.post(
  '/cd/start/:jobId',
  asyncHandler(async (req, res) => {
    const jobId = Number(req.params.jobId);
    const ripConfig = req.body || {};
    logger.info('post:cd:start', {
      reqId: req.reqId,
      jobId,
      format: ripConfig.format,
      selectedPreEncodeScriptIdsCount: Array.isArray(ripConfig?.selectedPreEncodeScriptIds)
        ? ripConfig.selectedPreEncodeScriptIds.length
        : 0,
      selectedPostEncodeScriptIdsCount: Array.isArray(ripConfig?.selectedPostEncodeScriptIds)
        ? ripConfig.selectedPostEncodeScriptIds.length
        : 0,
      selectedPreEncodeChainIdsCount: Array.isArray(ripConfig?.selectedPreEncodeChainIds)
        ? ripConfig.selectedPreEncodeChainIds.length
        : 0,
      selectedPostEncodeChainIdsCount: Array.isArray(ripConfig?.selectedPostEncodeChainIds)
        ? ripConfig.selectedPostEncodeChainIds.length
        : 0
    });
    const result = await pipelineService.enqueueOrStartCdAction(
      jobId,
      ripConfig,
      () => pipelineService.startCdRip(jobId, ripConfig)
    );
    res.json({ result });
  })
);

router.post(
  '/audiobook/upload',
  audiobookUpload.single('file'),
  asyncHandler(async (req, res) => {
    if (!req.file) {
      const error = new Error('Upload-Datei fehlt.');
      error.statusCode = 400;
      throw error;
    }
    logger.info('post:audiobook:upload', {
      reqId: req.reqId,
      originalName: req.file.originalname,
      sizeBytes: Number(req.file.size || 0),
      mimeType: String(req.file.mimetype || '').trim() || null,
      tempPath: String(req.file.path || '').trim() || null
    });
    const result = await pipelineService.createFileJob({
      kind: 'audiobook_upload',
      file: req.file,
      options: {
        format: req.body?.format,
        startImmediately: req.body?.startImmediately
      }
    });
    res.json({ result });
  })
);

router.get(
  '/audiobook/pending-activation',
  asyncHandler(async (req, res) => {
    const db = await getDb();
    // Jobs die eine Checksum haben, aber noch keine Activation Bytes im Cache
    const pending = await db.all(`
      SELECT j.id AS jobId, j.aax_checksum AS checksum
      FROM jobs j
      WHERE j.aax_checksum IS NOT NULL
        AND j.status NOT IN ('DONE', 'ERROR', 'CANCELLED')
        AND NOT EXISTS (
          SELECT 1 FROM aax_activation_bytes ab WHERE ab.checksum = j.aax_checksum
        )
      ORDER BY j.created_at DESC
    `);
    res.json({ pending });
  })
);

router.post(
  '/audiobook/start/:jobId',
  asyncHandler(async (req, res) => {
    const jobId = Number(req.params.jobId);
    const config = req.body || {};
    logger.info('post:audiobook:start', {
      reqId: req.reqId,
      jobId,
      format: config?.format,
      formatOptions: config?.formatOptions && typeof config.formatOptions === 'object'
        ? config.formatOptions
        : null
    });
    const result = await pipelineService.startAudiobookWithConfig(jobId, config);
    res.json({ result });
  })
);

router.get(
  '/audiobook/jobs',
  asyncHandler(async (_req, res) => {
    const jobs = await pipelineService.getAudiobookJobs();
    res.json({ jobs });
  })
);

router.post(
  '/select-metadata',
  asyncHandler(async (req, res) => {
    const {
      jobId,
      title,
      artist,
      year,
      imdbId,
      poster,
      mbId,
      coverUrl,
      tracks,
      selectedPlaylist,
      selectedHandBrakeTitleId,
      selectedHandBrakeTitleIds,
      metadataProvider,
      providerId,
      tmdbId,
      metadataKind,
      workflowKind,
      seasonNumber,
      seasonName,
      episodeCount,
      episodes,
      discNumber,
      duplicateAction,
      existingJobId,
      existingDiscNumber
    } = req.body;

    if (!jobId) {
      const error = new Error('jobId fehlt.');
      error.statusCode = 400;
      throw error;
    }

    logger.info('post:select-metadata', {
      reqId: req.reqId,
      jobId,
      title,
      artist,
      year,
      imdbId,
      poster,
      mbId,
      coverUrl,
      trackCount: Array.isArray(tracks) ? tracks.length : null,
      selectedPlaylist,
      selectedHandBrakeTitleId,
      selectedHandBrakeTitleIds: Array.isArray(selectedHandBrakeTitleIds) ? selectedHandBrakeTitleIds : null,
      metadataProvider,
      providerId,
      tmdbId,
      workflowKind,
      seasonNumber,
      discNumber,
      duplicateAction,
      existingJobId,
      existingDiscNumber
    });

    const looksLikeCdMetadataPayload = (
      artist !== undefined
      || mbId !== undefined
      || coverUrl !== undefined
      || Array.isArray(tracks)
    );
    if (looksLikeCdMetadataPayload) {
      logger.warn('post:select-metadata:compat-cd-route', {
        reqId: req.reqId,
        jobId,
        trackCount: Array.isArray(tracks) ? tracks.length : 0
      });
      const job = await pipelineService.selectCdMetadata({
        jobId: Number(jobId),
        title,
        artist,
        year,
        mbId,
        coverUrl: coverUrl || poster || null,
        tracks
      });
      res.json({ job });
      return;
    }

    const job = await pipelineService.selectMetadata({
      jobId: Number(jobId),
      title,
      year,
      imdbId,
      poster,
      selectedPlaylist,
      selectedHandBrakeTitleId,
      selectedHandBrakeTitleIds,
      metadataProvider,
      providerId,
      tmdbId,
      metadataKind,
      workflowKind,
      seasonNumber,
      seasonName,
      episodeCount,
      episodes,
      discNumber,
      duplicateAction,
      existingJobId,
      existingDiscNumber
    });

    res.json({ job });
  })
);

router.post(
  '/jobs/:jobId/raw-decision',
  asyncHandler(async (req, res) => {
    const jobId = Number(req.params.jobId);
    const { decision } = req.body;
    logger.info('post:raw-decision', { reqId: req.reqId, jobId, decision });
    const result = await pipelineService.submitRawDecision(jobId, decision);
    res.json({ result });
  })
);

router.post(
  '/start/:jobId',
  asyncHandler(async (req, res) => {
    const jobId = Number(req.params.jobId);
    logger.info('post:start-job', { reqId: req.reqId, jobId });
    const result = await pipelineService.startPreparedJob(jobId);
    res.json({ result });
  })
);

router.post(
  '/multipart-merge/:jobId/reorder',
  asyncHandler(async (req, res) => {
    const jobId = Number(req.params.jobId);
    const orderedSourceJobIds = Array.isArray(req.body?.orderedSourceJobIds)
      ? req.body.orderedSourceJobIds
      : [];
    logger.info('post:multipart-merge:reorder', {
      reqId: req.reqId,
      jobId,
      orderedCount: orderedSourceJobIds.length
    });
    const job = await pipelineService.updateMultipartMergeSourceOrder(jobId, orderedSourceJobIds);
    res.json({ job });
  })
);

router.post(
  '/multipart-merge/:jobId/settings',
  asyncHandler(async (req, res) => {
    const jobId = Number(req.params.jobId);
    const deleteInputsAfterMerge = Boolean(req.body?.deleteInputsAfterMerge);
    logger.info('post:multipart-merge:settings', {
      reqId: req.reqId,
      jobId,
      deleteInputsAfterMerge
    });
    const job = await pipelineService.updateMultipartMergeSettings(jobId, {
      deleteInputsAfterMerge
    });
    res.json({ job });
  })
);

router.get(
  '/multipart-merge/:jobId/preview',
  asyncHandler(async (req, res) => {
    const jobId = Number(req.params.jobId);
    logger.info('get:multipart-merge:preview', {
      reqId: req.reqId,
      jobId
    });
    const preview = await pipelineService.getMultipartMergePreview(jobId);
    res.json({ preview });
  })
);

router.post(
  '/multipart-merge/:containerJobId/restore',
  asyncHandler(async (req, res) => {
    const containerJobId = Number(req.params.containerJobId);
    logger.info('post:multipart-merge:restore', {
      reqId: req.reqId,
      containerJobId
    });
    const job = await pipelineService.restoreMultipartMergeJobForContainer(containerJobId);
    await pipelineService.emitQueueChanged().catch((error) => {
      logger.warn('post:multipart-merge:restore:queue-emit-failed', {
        reqId: req.reqId,
        containerJobId,
        error: error?.message || String(error)
      });
    });
    res.json({
      result: {
        restored: true,
        mergeJobId: Number(job?.id || 0) || null
      },
      job
    });
  })
);

router.post(
  '/confirm-encode/:jobId',
  asyncHandler(async (req, res) => {
    const jobId = Number(req.params.jobId);
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const hasSelectedUserPresetId = Object.prototype.hasOwnProperty.call(body, 'selectedUserPresetId');
    const hasSelectedHandBrakePreset = Object.prototype.hasOwnProperty.call(body, 'selectedHandBrakePreset');
    const selectedEncodeTitleId = req.body?.selectedEncodeTitleId ?? null;
    const selectedEncodeTitleIds = req.body?.selectedEncodeTitleIds ?? null;
    const selectedTrackSelection = req.body?.selectedTrackSelection ?? null;
    const episodeAssignments = req.body?.episodeAssignments ?? null;
    const selectedPostEncodeScriptIds = req.body?.selectedPostEncodeScriptIds;
    const selectedPreEncodeScriptIds = req.body?.selectedPreEncodeScriptIds;
    const selectedPostEncodeChainIds = req.body?.selectedPostEncodeChainIds;
    const selectedPreEncodeChainIds = req.body?.selectedPreEncodeChainIds;
    const skipPipelineStateUpdate = Boolean(req.body?.skipPipelineStateUpdate);
    const selectedUserPresetId = hasSelectedUserPresetId
      ? body.selectedUserPresetId
      : undefined;
    const selectedHandBrakePreset = hasSelectedHandBrakePreset
      ? body.selectedHandBrakePreset
      : undefined;
    logger.info('post:confirm-encode', {
      reqId: req.reqId,
      jobId,
      selectedEncodeTitleId,
      selectedEncodeTitleIdsCount: Array.isArray(selectedEncodeTitleIds) ? selectedEncodeTitleIds.length : 0,
      selectedTrackSelectionProvided: Boolean(selectedTrackSelection),
      episodeAssignmentsProvided: Boolean(episodeAssignments && typeof episodeAssignments === 'object'),
      skipPipelineStateUpdate,
      selectedUserPresetId,
      selectedHandBrakePreset,
      selectedPostEncodeScriptIdsCount: Array.isArray(selectedPostEncodeScriptIds)
        ? selectedPostEncodeScriptIds.length
        : 0,
      selectedPreEncodeScriptIdsCount: Array.isArray(selectedPreEncodeScriptIds)
        ? selectedPreEncodeScriptIds.length
        : 0,
      selectedPostEncodeChainIdsCount: Array.isArray(selectedPostEncodeChainIds)
        ? selectedPostEncodeChainIds.length
        : 0,
      selectedPreEncodeChainIdsCount: Array.isArray(selectedPreEncodeChainIds)
        ? selectedPreEncodeChainIds.length
        : 0
    });
    const job = await pipelineService.confirmEncodeReview(jobId, {
      selectedEncodeTitleId,
      selectedEncodeTitleIds,
      selectedTrackSelection,
      episodeAssignments,
      selectedPostEncodeScriptIds,
      selectedPreEncodeScriptIds,
      selectedPostEncodeChainIds,
      selectedPreEncodeChainIds,
      skipPipelineStateUpdate,
      selectedUserPresetId,
      selectedHandBrakePreset
    });
    res.json({ job });
  })
);

router.post(
  '/cancel',
  asyncHandler(async (req, res) => {
    const rawJobId = req.body?.jobId;
    const jobId = rawJobId === null || rawJobId === undefined || String(rawJobId).trim() === ''
      ? null
      : Number(rawJobId);
    logger.warn('post:cancel', { reqId: req.reqId, jobId });
    const result = await pipelineService.cancel(jobId);
    res.json({ result });
  })
);

router.post(
  '/retry/:jobId',
  asyncHandler(async (req, res) => {
    const jobId = Number(req.params.jobId);
    const createNewJob = Boolean(req.body?.createNewJob);
    logger.info('post:retry', { reqId: req.reqId, jobId, createNewJob });
    const result = await pipelineService.retry(jobId, { createNewJob });
    res.json({ result });
  })
);

router.post(
  '/resume-ready/:jobId',
  asyncHandler(async (req, res) => {
    const jobId = Number(req.params.jobId);
    logger.info('post:resume-ready', { reqId: req.reqId, jobId });
    const job = await pipelineService.resumeReadyToEncodeJob(jobId);
    res.json({ job });
  })
);

router.get(
  '/output-folders/:jobId',
  asyncHandler(async (req, res) => {
    const jobId = Number(req.params.jobId);
    const folders = await historyService.getJobOutputFoldersForLineage(jobId);
    res.json({ folders });
  })
);

router.post(
  '/delete-output-folders/:jobId',
  asyncHandler(async (req, res) => {
    const jobId = Number(req.params.jobId);
    const folderPaths = Array.isArray(req.body?.folderPaths) ? req.body.folderPaths : [];
    logger.info('post:delete-output-folders', { reqId: req.reqId, jobId, count: folderPaths.length });
    const result = await historyService.deleteSpecificOutputFolders(jobId, folderPaths);
    res.json({ result });
  })
);

router.post(
  '/reencode/:jobId',
  asyncHandler(async (req, res) => {
    const jobId = Number(req.params.jobId);
    const keepBoth = Boolean(req.body?.keepBoth);
    const deleteFolders = Array.isArray(req.body?.deleteFolders) ? req.body.deleteFolders : [];
    logger.info('post:reencode', { reqId: req.reqId, jobId, keepBoth, deleteFolderCount: deleteFolders.length });
    const result = await pipelineService.reencodeFromRaw(jobId, { keepBoth, deleteFolders });
    res.json({ result });
  })
);

router.post(
  '/restart-review/:jobId',
  asyncHandler(async (req, res) => {
    const jobId = Number(req.params.jobId);
    const keepBoth = Boolean(req.body?.keepBoth);
    const deleteFolders = Array.isArray(req.body?.deleteFolders) ? req.body.deleteFolders : [];
    const createNewJob = Boolean(req.body?.createNewJob);
    const reuseCurrentJob = Object.prototype.hasOwnProperty.call(req.body || {}, 'reuseCurrentJob')
      ? Boolean(req.body?.reuseCurrentJob)
      : !createNewJob;
    logger.info('post:restart-review', {
      reqId: req.reqId,
      jobId,
      keepBoth,
      createNewJob,
      reuseCurrentJob,
      deleteFolderCount: deleteFolders.length
    });
    const result = await pipelineService.restartReviewFromRaw(jobId, {
      keepBoth,
      deleteFolders,
      reuseCurrentJob,
      createNewJob
    });
    res.json({ result });
  })
);

router.post(
  '/restart-encode/:jobId',
  asyncHandler(async (req, res) => {
    const jobId = Number(req.params.jobId);
    const keepBoth = Boolean(req.body?.keepBoth);
    const deleteFolders = Array.isArray(req.body?.deleteFolders) ? req.body.deleteFolders : [];
    const restartMode = String(req.body?.restartMode || 'all').trim().toLowerCase() || 'all';
    const createNewJob = Boolean(req.body?.createNewJob);
    logger.info('post:restart-encode', {
      reqId: req.reqId,
      jobId,
      keepBoth,
      createNewJob,
      restartMode,
      deleteFolderCount: deleteFolders.length
    });
    const result = await pipelineService.restartEncodeWithLastSettings(jobId, {
      keepBoth,
      deleteFolders,
      restartMode,
      createNewJob
    });
    res.json({ result });
  })
);

router.post(
  '/restart-cd-review/:jobId',
  asyncHandler(async (req, res) => {
    const jobId = Number(req.params.jobId);
    const keepBoth = Boolean(req.body?.keepBoth);
    const deleteFolders = Array.isArray(req.body?.deleteFolders) ? req.body.deleteFolders : [];
    logger.info('post:restart-cd-review', { reqId: req.reqId, jobId, keepBoth, deleteFolderCount: deleteFolders.length });
    const result = await pipelineService.restartCdReviewFromRaw(jobId, { keepBoth, deleteFolders });
    res.json({ result });
  })
);

router.get(
  '/queue',
  asyncHandler(async (req, res) => {
    logger.debug('get:queue', { reqId: req.reqId });
    const queue = await pipelineService.getQueueSnapshot();
    res.json({ queue });
  })
);

router.post(
  '/queue/reorder',
  asyncHandler(async (req, res) => {
    // Accept orderedEntryIds (new) or orderedJobIds (legacy fallback for job-only queues).
    const orderedEntryIds = Array.isArray(req.body?.orderedEntryIds)
      ? req.body.orderedEntryIds
      : (Array.isArray(req.body?.orderedJobIds) ? req.body.orderedJobIds : []);
    logger.info('post:queue:reorder', { reqId: req.reqId, orderedEntryIds });
    const queue = await pipelineService.reorderQueue(orderedEntryIds);
    res.json({ queue });
  })
);

router.post(
  '/queue/entry',
  asyncHandler(async (req, res) => {
    const { type, scriptId, chainId, waitSeconds, insertAfterEntryId } = req.body || {};
    logger.info('post:queue:entry', { reqId: req.reqId, type });
    const result = await pipelineService.enqueueNonJobEntry(
      type,
      { scriptId, chainId, waitSeconds },
      insertAfterEntryId ?? null
    );
    const queue = await pipelineService.getQueueSnapshot();
    res.json({ result, queue });
  })
);

router.delete(
  '/queue/entry/:entryId',
  asyncHandler(async (req, res) => {
    const entryId = req.params.entryId;
    logger.info('delete:queue:entry', { reqId: req.reqId, entryId });
    const queue = await pipelineService.removeQueueEntry(entryId);
    res.json({ queue });
  })
);

module.exports = router;
