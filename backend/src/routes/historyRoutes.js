const express = require('express');
const asyncHandler = require('../middleware/asyncHandler');
const historyService = require('../services/historyService');
const pipelineService = require('../services/pipelineService');
const logger = require('../services/logger').child('HISTORY_ROUTE');

const router = express.Router();

router.get(
  '/',
  asyncHandler(async (req, res) => {
    logger.info('get:jobs', {
      reqId: req.reqId,
      status: req.query.status,
      search: req.query.search
    });

    const jobs = await historyService.getJobs({
      status: req.query.status,
      search: req.query.search
    });

    res.json({ jobs });
  })
);

router.get(
  '/database',
  asyncHandler(async (req, res) => {
    logger.info('get:database', {
      reqId: req.reqId,
      status: req.query.status,
      search: req.query.search
    });

    const rows = await historyService.getDatabaseRows({
      status: req.query.status,
      search: req.query.search
    });

    res.json({ rows });
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

router.post(
  '/orphan-raw/import',
  asyncHandler(async (req, res) => {
    const rawPath = String(req.body?.rawPath || '').trim();
    logger.info('post:orphan-raw:import', { reqId: req.reqId, rawPath });
    const job = await historyService.importOrphanRawFolder(rawPath);
    const uiReset = await pipelineService.resetFrontendState('history_orphan_import');
    res.json({ job, uiReset });
  })
);

router.post(
  '/:id/omdb/assign',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const payload = req.body || {};
    logger.info('post:job:omdb:assign', {
      reqId: req.reqId,
      id,
      imdbId: payload?.imdbId || null,
      hasTitle: Boolean(payload?.title),
      hasYear: Boolean(payload?.year)
    });

    const job = await historyService.assignOmdbMetadata(id, payload);
    res.json({ job });
  })
);

router.post(
  '/:id/delete-files',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const target = String(req.body?.target || 'both');

    logger.warn('post:delete-files', {
      reqId: req.reqId,
      id,
      target
    });

    const result = await historyService.deleteJobFiles(id, target);
    res.json(result);
  })
);

router.post(
  '/:id/delete',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const target = String(req.body?.target || 'none');

    logger.warn('post:delete-job', {
      reqId: req.reqId,
      id,
      target
    });

    const result = await historyService.deleteJob(id, target);
    const uiReset = await pipelineService.resetFrontendState('history_delete');
    res.json({ ...result, uiReset });
  })
);

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const includeLiveLog = ['1', 'true', 'yes'].includes(String(req.query.includeLiveLog || '').toLowerCase());
    const includeLogs = ['1', 'true', 'yes'].includes(String(req.query.includeLogs || '').toLowerCase());
    const includeAllLogs = ['1', 'true', 'yes'].includes(String(req.query.includeAllLogs || '').toLowerCase());
    const parsedTail = Number(req.query.logTailLines);
    const logTailLines = Number.isFinite(parsedTail) && parsedTail > 0
      ? Math.trunc(parsedTail)
      : null;

    logger.info('get:job-detail', {
      reqId: req.reqId,
      id,
      includeLiveLog,
      includeLogs,
      includeAllLogs,
      logTailLines
    });
    const job = await historyService.getJobWithLogs(id, {
      includeLiveLog,
      includeLogs,
      includeAllLogs,
      logTailLines
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
