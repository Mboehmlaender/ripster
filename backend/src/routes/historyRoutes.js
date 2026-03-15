const express = require('express');
const asyncHandler = require('../middleware/asyncHandler');
const historyService = require('../services/historyService');
const pipelineService = require('../services/pipelineService');
const logger = require('../services/logger').child('HISTORY_ROUTE');

const router = express.Router();

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
    logger.info('get:jobs', {
      reqId: req.reqId,
      status: req.query.status,
      statuses: statuses.length > 0 ? statuses : null,
      search: req.query.search,
      limit,
      lite
    });

    const jobs = await historyService.getJobs({
      status: req.query.status,
      statuses,
      search: req.query.search,
      limit,
      includeFsChecks: !lite
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

    // Rename raw/output folders to reflect new metadata (best-effort, non-blocking)
    pipelineService.renameJobFolders(id).catch((err) => {
      logger.warn('post:job:omdb:assign:rename-failed', { id, error: err.message });
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

    const job = await historyService.assignCdMetadata(id, payload);

    // Rename raw/output folders to reflect new metadata (best-effort, non-blocking)
    pipelineService.renameJobFolders(id).catch((err) => {
      logger.warn('post:job:cd:assign:rename-failed', { id, error: err.message });
    });

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

router.get(
  '/:id/delete-preview',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const includeRelated = ['1', 'true', 'yes'].includes(String(req.query.includeRelated || '1').toLowerCase());

    logger.info('get:delete-preview', {
      reqId: req.reqId,
      id,
      includeRelated
    });

    const preview = await historyService.getJobDeletePreview(id, { includeRelated });
    res.json({ preview });
  })
);

router.post(
  '/:id/delete',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const target = String(req.body?.target || 'none');
    const includeRelated = ['1', 'true', 'yes'].includes(String(req.body?.includeRelated || 'false').toLowerCase());

    logger.warn('post:delete-job', {
      reqId: req.reqId,
      id,
      target,
      includeRelated
    });

    const result = await historyService.deleteJob(id, target, { includeRelated });
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
