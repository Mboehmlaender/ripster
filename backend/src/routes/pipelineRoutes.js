const express = require('express');
const asyncHandler = require('../middleware/asyncHandler');
const pipelineService = require('../services/pipelineService');
const diskDetectionService = require('../services/diskDetectionService');
const logger = require('../services/logger').child('PIPELINE_ROUTE');

const router = express.Router();

router.get(
  '/state',
  asyncHandler(async (req, res) => {
    logger.debug('get:state', { reqId: req.reqId });
    res.json({ pipeline: pipelineService.getSnapshot() });
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
    logger.info('post:confirm-encode', {
      reqId: req.reqId,
      jobId,
      selectedEncodeTitleId,
      selectedTrackSelectionProvided: Boolean(selectedTrackSelection),
      selectedPostEncodeScriptIdsCount: Array.isArray(selectedPostEncodeScriptIds)
        ? selectedPostEncodeScriptIds.length
        : 0
    });
    const job = await pipelineService.confirmEncodeReview(jobId, {
      selectedEncodeTitleId,
      selectedTrackSelection,
      selectedPostEncodeScriptIds
    });
    res.json({ job });
  })
);

router.post(
  '/cancel',
  asyncHandler(async (req, res) => {
    logger.warn('post:cancel', { reqId: req.reqId });
    await pipelineService.cancel();
    res.json({ ok: true });
  })
);

router.post(
  '/retry/:jobId',
  asyncHandler(async (req, res) => {
    const jobId = Number(req.params.jobId);
    logger.info('post:retry', { reqId: req.reqId, jobId });
    await pipelineService.retry(jobId);
    res.json({ ok: true });
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
  '/restart-encode/:jobId',
  asyncHandler(async (req, res) => {
    const jobId = Number(req.params.jobId);
    logger.info('post:restart-encode', { reqId: req.reqId, jobId });
    const result = await pipelineService.restartEncodeWithLastSettings(jobId);
    res.json({ result });
  })
);

module.exports = router;
