const express = require('express');
const asyncHandler = require('../middleware/asyncHandler');
const pipelineService = require('../services/pipelineService');
const diskDetectionService = require('../services/diskDetectionService');
const hardwareMonitorService = require('../services/hardwareMonitorService');
const logger = require('../services/logger').child('PIPELINE_ROUTE');

const router = express.Router();

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

router.post(
  '/analyze',
  asyncHandler(async (req, res) => {
    logger.info('post:analyze', { reqId: req.reqId });
    const result = await pipelineService.analyzeDisc();
    res.json({ result });
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

router.get(
  '/omdb/search',
  asyncHandler(async (req, res) => {
    const query = req.query.q || '';
    logger.info('get:omdb:search', { reqId: req.reqId, query });
    const results = await pipelineService.searchOmdb(String(query));
    res.json({ results });
  })
);

router.post(
  '/select-metadata',
  asyncHandler(async (req, res) => {
    const { jobId, title, year, imdbId, poster, fromOmdb, selectedPlaylist } = req.body;

    if (!jobId) {
      const error = new Error('jobId fehlt.');
      error.statusCode = 400;
      throw error;
    }

    logger.info('post:select-metadata', {
      reqId: req.reqId,
      jobId,
      title,
      year,
      imdbId,
      poster,
      fromOmdb,
      selectedPlaylist
    });

    const job = await pipelineService.selectMetadata({
      jobId: Number(jobId),
      title,
      year,
      imdbId,
      poster,
      fromOmdb,
      selectedPlaylist
    });

    res.json({ job });
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
  '/confirm-encode/:jobId',
  asyncHandler(async (req, res) => {
    const jobId = Number(req.params.jobId);
    const selectedEncodeTitleId = req.body?.selectedEncodeTitleId ?? null;
    const selectedTrackSelection = req.body?.selectedTrackSelection ?? null;
    const selectedPostEncodeScriptIds = req.body?.selectedPostEncodeScriptIds;
    const selectedPreEncodeScriptIds = req.body?.selectedPreEncodeScriptIds;
    const selectedPostEncodeChainIds = req.body?.selectedPostEncodeChainIds;
    const selectedPreEncodeChainIds = req.body?.selectedPreEncodeChainIds;
    const skipPipelineStateUpdate = Boolean(req.body?.skipPipelineStateUpdate);
    const selectedUserPresetId = req.body?.selectedUserPresetId ?? null;
    logger.info('post:confirm-encode', {
      reqId: req.reqId,
      jobId,
      selectedEncodeTitleId,
      selectedTrackSelectionProvided: Boolean(selectedTrackSelection),
      skipPipelineStateUpdate,
      selectedUserPresetId,
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
      selectedTrackSelection,
      selectedPostEncodeScriptIds,
      selectedPreEncodeScriptIds,
      selectedPostEncodeChainIds,
      selectedPreEncodeChainIds,
      skipPipelineStateUpdate,
      selectedUserPresetId
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
    logger.info('post:retry', { reqId: req.reqId, jobId });
    const result = await pipelineService.retry(jobId);
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

router.post(
  '/reencode/:jobId',
  asyncHandler(async (req, res) => {
    const jobId = Number(req.params.jobId);
    logger.info('post:reencode', { reqId: req.reqId, jobId });
    const result = await pipelineService.reencodeFromRaw(jobId);
    res.json({ result });
  })
);

router.post(
  '/restart-review/:jobId',
  asyncHandler(async (req, res) => {
    const jobId = Number(req.params.jobId);
    logger.info('post:restart-review', { reqId: req.reqId, jobId });
    const result = await pipelineService.restartReviewFromRaw(jobId);
    res.json({ result });
  })
);

router.post(
  '/restart-encode/:jobId',
  asyncHandler(async (req, res) => {
    const jobId = Number(req.params.jobId);
    logger.info('post:restart-encode', { reqId: req.reqId, jobId });
    const result = await pipelineService.restartEncodeWithLastSettings(jobId);
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
