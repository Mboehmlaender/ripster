const express = require('express');
const asyncHandler = require('../middleware/asyncHandler');
const cronService = require('../services/cronService');
const wsService = require('../services/websocketService');
const logger = require('../services/logger').child('CRON_ROUTE');

const router = express.Router();

// GET /api/crons  – alle Cronjobs auflisten
router.get(
  '/',
  asyncHandler(async (req, res) => {
    logger.debug('get:crons', { reqId: req.reqId });
    const jobs = await cronService.listJobs();
    res.json({ jobs });
  })
);

// POST /api/crons/validate-expression  – Cron-Ausdruck validieren
router.post(
  '/validate-expression',
  asyncHandler(async (req, res) => {
    const expr = String(req.body?.cronExpression || '').trim();
    const validation = cronService.validateExpression(expr);
    const nextRunAt = validation.valid ? cronService.getNextRunTime(expr) : null;
    res.json({ ...validation, nextRunAt });
  })
);

// POST /api/crons  – neuen Cronjob anlegen
router.post(
  '/',
  asyncHandler(async (req, res) => {
    const payload = req.body || {};
    logger.info('post:crons:create', { reqId: req.reqId, name: payload?.name });
    const job = await cronService.createJob(payload);
    wsService.broadcast('CRON_JOBS_UPDATED', { action: 'created', id: job.id });
    res.status(201).json({ job });
  })
);

// GET /api/crons/:id  – einzelnen Cronjob abrufen
router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    logger.debug('get:crons:one', { reqId: req.reqId, cronJobId: id });
    const job = await cronService.getJobById(id);
    res.json({ job });
  })
);

// PUT /api/crons/:id  – Cronjob aktualisieren
router.put(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const payload = req.body || {};
    logger.info('put:crons:update', { reqId: req.reqId, cronJobId: id });
    const job = await cronService.updateJob(id, payload);
    wsService.broadcast('CRON_JOBS_UPDATED', { action: 'updated', id: job.id });
    res.json({ job });
  })
);

// DELETE /api/crons/:id  – Cronjob löschen
router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    logger.info('delete:crons', { reqId: req.reqId, cronJobId: id });
    const removed = await cronService.deleteJob(id);
    wsService.broadcast('CRON_JOBS_UPDATED', { action: 'deleted', id: removed.id });
    res.json({ removed });
  })
);

// GET /api/crons/:id/logs  – Ausführungs-Logs eines Cronjobs
router.get(
  '/:id/logs',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const limit = Math.min(Number(req.query?.limit) || 20, 100);
    logger.debug('get:crons:logs', { reqId: req.reqId, cronJobId: id, limit });
    const logs = await cronService.getJobLogs(id, limit);
    res.json({ logs });
  })
);

// POST /api/crons/:id/run  – Cronjob manuell auslösen
router.post(
  '/:id/run',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    logger.info('post:crons:run', { reqId: req.reqId, cronJobId: id });
    const result = await cronService.triggerJobManually(id);
    res.json(result);
  })
);

module.exports = router;
