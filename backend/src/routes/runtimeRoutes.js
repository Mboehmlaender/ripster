const express = require('express');
const asyncHandler = require('../middleware/asyncHandler');
const runtimeActivityService = require('../services/runtimeActivityService');
const logger = require('../services/logger').child('RUNTIME_ROUTE');

const router = express.Router();

router.get(
  '/activities',
  asyncHandler(async (req, res) => {
    logger.debug('get:runtime:activities', { reqId: req.reqId });
    const snapshot = runtimeActivityService.getSnapshot();
    res.json(snapshot);
  })
);

router.post(
  '/activities/:id/cancel',
  asyncHandler(async (req, res) => {
    const activityId = Number(req.params.id);
    const reason = String(req.body?.reason || '').trim() || null;
    logger.info('post:runtime:activities:cancel', { reqId: req.reqId, activityId, reason });
    const action = await runtimeActivityService.requestCancel(activityId, { reason });
    if (!action?.ok) {
      const error = new Error(action?.message || 'Abbrechen fehlgeschlagen.');
      error.statusCode = action?.code === 'NOT_FOUND' ? 404 : 409;
      throw error;
    }
    res.json({
      ok: true,
      action: action.result || null,
      snapshot: runtimeActivityService.getSnapshot()
    });
  })
);

router.post(
  '/activities/:id/next-step',
  asyncHandler(async (req, res) => {
    const activityId = Number(req.params.id);
    logger.info('post:runtime:activities:next-step', { reqId: req.reqId, activityId });
    const action = await runtimeActivityService.requestNextStep(activityId, {});
    if (!action?.ok) {
      const error = new Error(action?.message || 'Nächster Schritt fehlgeschlagen.');
      error.statusCode = action?.code === 'NOT_FOUND' ? 404 : 409;
      throw error;
    }
    res.json({
      ok: true,
      action: action.result || null,
      snapshot: runtimeActivityService.getSnapshot()
    });
  })
);

module.exports = router;
