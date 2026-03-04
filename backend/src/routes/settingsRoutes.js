const express = require('express');
const asyncHandler = require('../middleware/asyncHandler');
const settingsService = require('../services/settingsService');
const scriptService = require('../services/scriptService');
const notificationService = require('../services/notificationService');
const pipelineService = require('../services/pipelineService');
const wsService = require('../services/websocketService');
const logger = require('../services/logger').child('SETTINGS_ROUTE');

const router = express.Router();

function isSensitiveSettingKey(key) {
  const normalized = String(key || '').trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  return /(token|password|secret|api_key|registration_key|pushover_user)/i.test(normalized);
}

router.get(
  '/',
  asyncHandler(async (req, res) => {
    logger.debug('get:settings', { reqId: req.reqId });
    const categories = await settingsService.getCategorizedSettings();
    res.json({ categories });
  })
);

router.get(
  '/handbrake-presets',
  asyncHandler(async (req, res) => {
    logger.debug('get:settings:handbrake-presets', { reqId: req.reqId });
    const presets = await settingsService.getHandBrakePresetOptions();
    res.json(presets);
  })
);

router.get(
  '/scripts',
  asyncHandler(async (req, res) => {
    logger.debug('get:settings:scripts', { reqId: req.reqId });
    const scripts = await scriptService.listScripts();
    res.json({ scripts });
  })
);

router.post(
  '/scripts',
  asyncHandler(async (req, res) => {
    const payload = req.body || {};
    logger.info('post:settings:scripts:create', {
      reqId: req.reqId,
      name: String(payload?.name || '').trim() || null,
      scriptBodyLength: String(payload?.scriptBody || '').length
    });
    const script = await scriptService.createScript(payload);
    wsService.broadcast('SETTINGS_SCRIPTS_UPDATED', { action: 'created', id: script.id });
    res.status(201).json({ script });
  })
);

router.put(
  '/scripts/:id',
  asyncHandler(async (req, res) => {
    const scriptId = Number(req.params.id);
    const payload = req.body || {};
    logger.info('put:settings:scripts:update', {
      reqId: req.reqId,
      scriptId,
      name: String(payload?.name || '').trim() || null,
      scriptBodyLength: String(payload?.scriptBody || '').length
    });
    const script = await scriptService.updateScript(scriptId, payload);
    wsService.broadcast('SETTINGS_SCRIPTS_UPDATED', { action: 'updated', id: script.id });
    res.json({ script });
  })
);

router.delete(
  '/scripts/:id',
  asyncHandler(async (req, res) => {
    const scriptId = Number(req.params.id);
    logger.info('delete:settings:scripts', {
      reqId: req.reqId,
      scriptId
    });
    const removed = await scriptService.deleteScript(scriptId);
    wsService.broadcast('SETTINGS_SCRIPTS_UPDATED', { action: 'deleted', id: removed.id });
    res.json({ removed });
  })
);

router.post(
  '/scripts/:id/test',
  asyncHandler(async (req, res) => {
    const scriptId = Number(req.params.id);
    logger.info('post:settings:scripts:test', {
      reqId: req.reqId,
      scriptId
    });
    const result = await scriptService.testScript(scriptId);
    res.json({ result });
  })
);

router.put(
  '/:key',
  asyncHandler(async (req, res) => {
    const { key } = req.params;
    const { value } = req.body;

    logger.info('put:setting', {
      reqId: req.reqId,
      key,
      value: isSensitiveSettingKey(key) ? '[redacted]' : value
    });
    const updated = await settingsService.setSettingValue(key, value);
    let reviewRefresh = null;
    try {
      reviewRefresh = await pipelineService.refreshEncodeReviewAfterSettingsSave([key]);
      if (reviewRefresh?.triggered) {
        logger.info('put:setting:review-refresh-started', {
          reqId: req.reqId,
          key,
          jobId: reviewRefresh.jobId
        });
      }
    } catch (error) {
      logger.warn('put:setting:review-refresh-failed', {
        reqId: req.reqId,
        key,
        error: {
          name: error?.name,
          message: error?.message
        }
      });
      reviewRefresh = {
        triggered: false,
        reason: 'refresh_error',
        message: error?.message || 'unknown'
      };
    }
    wsService.broadcast('SETTINGS_UPDATED', updated);

    res.json({ setting: updated, reviewRefresh });
  })
);

router.put(
  '/',
  asyncHandler(async (req, res) => {
    const { settings } = req.body || {};
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
      const error = new Error('settings fehlt oder ist ungültig.');
      error.statusCode = 400;
      throw error;
    }

    logger.info('put:settings:bulk', { reqId: req.reqId, count: Object.keys(settings).length });
    const changes = await settingsService.setSettingsBulk(settings);
    let reviewRefresh = null;
    try {
      reviewRefresh = await pipelineService.refreshEncodeReviewAfterSettingsSave(changes.map((item) => item.key));
      if (reviewRefresh?.triggered) {
        logger.info('put:settings:bulk:review-refresh-started', {
          reqId: req.reqId,
          jobId: reviewRefresh.jobId,
          relevantKeys: reviewRefresh.relevantKeys
        });
      }
    } catch (error) {
      logger.warn('put:settings:bulk:review-refresh-failed', {
        reqId: req.reqId,
        error: {
          name: error?.name,
          message: error?.message
        }
      });
      reviewRefresh = {
        triggered: false,
        reason: 'refresh_error',
        message: error?.message || 'unknown'
      };
    }
    wsService.broadcast('SETTINGS_BULK_UPDATED', { count: changes.length, keys: changes.map((item) => item.key) });

    res.json({ changes, reviewRefresh });
  })
);

router.post(
  '/pushover/test',
  asyncHandler(async (req, res) => {
    const title = req.body?.title;
    const message = req.body?.message;
    logger.info('post:pushover:test', {
      reqId: req.reqId,
      hasTitle: Boolean(title),
      hasMessage: Boolean(message)
    });
    const result = await notificationService.sendTest({ title, message });
    res.json({ result });
  })
);

module.exports = router;
