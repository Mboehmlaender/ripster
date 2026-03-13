const express = require('express');
const asyncHandler = require('../middleware/asyncHandler');
const settingsService = require('../services/settingsService');
const scriptService = require('../services/scriptService');
const scriptChainService = require('../services/scriptChainService');
const notificationService = require('../services/notificationService');
const pipelineService = require('../services/pipelineService');
const wsService = require('../services/websocketService');
const hardwareMonitorService = require('../services/hardwareMonitorService');
const userPresetService = require('../services/userPresetService');
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
  '/effective-paths',
  asyncHandler(async (req, res) => {
    logger.debug('get:settings:effective-paths', { reqId: req.reqId });
    const paths = await settingsService.getEffectivePaths();
    res.json(paths);
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

router.post(
  '/scripts/reorder',
  asyncHandler(async (req, res) => {
    const orderedScriptIds = Array.isArray(req.body?.orderedScriptIds) ? req.body.orderedScriptIds : [];
    logger.info('post:settings:scripts:reorder', {
      reqId: req.reqId,
      count: orderedScriptIds.length
    });
    const scripts = await scriptService.reorderScripts(orderedScriptIds);
    wsService.broadcast('SETTINGS_SCRIPTS_UPDATED', { action: 'reordered', count: scripts.length });
    res.json({ scripts });
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

router.post(
  '/script-chains/:id/test',
  asyncHandler(async (req, res) => {
    const chainId = Number(req.params.id);
    logger.info('post:settings:script-chains:test', { reqId: req.reqId, chainId });
    const result = await scriptChainService.executeChain(chainId, { source: 'settings_test', mode: 'test' });
    res.json({ result });
  })
);

router.get(
  '/script-chains',
  asyncHandler(async (req, res) => {
    logger.debug('get:settings:script-chains', { reqId: req.reqId });
    const chains = await scriptChainService.listChains();
    res.json({ chains });
  })
);

router.post(
  '/script-chains',
  asyncHandler(async (req, res) => {
    const payload = req.body || {};
    logger.info('post:settings:script-chains:create', { reqId: req.reqId, name: payload?.name });
    const chain = await scriptChainService.createChain(payload);
    wsService.broadcast('SETTINGS_SCRIPT_CHAINS_UPDATED', { action: 'created', id: chain.id });
    res.status(201).json({ chain });
  })
);

router.post(
  '/script-chains/reorder',
  asyncHandler(async (req, res) => {
    const orderedChainIds = Array.isArray(req.body?.orderedChainIds) ? req.body.orderedChainIds : [];
    logger.info('post:settings:script-chains:reorder', {
      reqId: req.reqId,
      count: orderedChainIds.length
    });
    const chains = await scriptChainService.reorderChains(orderedChainIds);
    wsService.broadcast('SETTINGS_SCRIPT_CHAINS_UPDATED', { action: 'reordered', count: chains.length });
    res.json({ chains });
  })
);

router.get(
  '/script-chains/:id',
  asyncHandler(async (req, res) => {
    const chainId = Number(req.params.id);
    logger.debug('get:settings:script-chains:one', { reqId: req.reqId, chainId });
    const chain = await scriptChainService.getChainById(chainId);
    res.json({ chain });
  })
);

router.put(
  '/script-chains/:id',
  asyncHandler(async (req, res) => {
    const chainId = Number(req.params.id);
    const payload = req.body || {};
    logger.info('put:settings:script-chains:update', { reqId: req.reqId, chainId, name: payload?.name });
    const chain = await scriptChainService.updateChain(chainId, payload);
    wsService.broadcast('SETTINGS_SCRIPT_CHAINS_UPDATED', { action: 'updated', id: chain.id });
    res.json({ chain });
  })
);

router.delete(
  '/script-chains/:id',
  asyncHandler(async (req, res) => {
    const chainId = Number(req.params.id);
    logger.info('delete:settings:script-chains', { reqId: req.reqId, chainId });
    const removed = await scriptChainService.deleteChain(chainId);
    wsService.broadcast('SETTINGS_SCRIPT_CHAINS_UPDATED', { action: 'deleted', id: removed.id });
    res.json({ removed });
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
    try {
      await hardwareMonitorService.handleSettingsChanged([key]);
    } catch (error) {
      logger.warn('put:setting:hardware-monitor-refresh-failed', {
        reqId: req.reqId,
        key,
        error: {
          name: error?.name,
          message: error?.message
        }
      });
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
    try {
      await hardwareMonitorService.handleSettingsChanged(changes.map((item) => item.key));
    } catch (error) {
      logger.warn('put:settings:bulk:hardware-monitor-refresh-failed', {
        reqId: req.reqId,
        error: {
          name: error?.name,
          message: error?.message
        }
      });
    }
    wsService.broadcast('SETTINGS_BULK_UPDATED', { count: changes.length, keys: changes.map((item) => item.key) });

    res.json({ changes, reviewRefresh });
  })
);

// ── User Presets ──────────────────────────────────────────────────────────────

router.get(
  '/user-presets',
  asyncHandler(async (req, res) => {
    const mediaType = req.query.media_type || null;
    logger.debug('get:user-presets', { reqId: req.reqId, mediaType });
    const presets = await userPresetService.listPresets(mediaType);
    res.json({ presets });
  })
);

router.post(
  '/user-presets',
  asyncHandler(async (req, res) => {
    const payload = req.body || {};
    logger.info('post:user-presets:create', { reqId: req.reqId, name: payload?.name });
    const preset = await userPresetService.createPreset(payload);
    wsService.broadcast('USER_PRESETS_UPDATED', { action: 'created', id: preset.id });
    res.status(201).json({ preset });
  })
);

router.put(
  '/user-presets/:id',
  asyncHandler(async (req, res) => {
    const presetId = Number(req.params.id);
    const payload = req.body || {};
    logger.info('put:user-presets:update', { reqId: req.reqId, presetId });
    const preset = await userPresetService.updatePreset(presetId, payload);
    wsService.broadcast('USER_PRESETS_UPDATED', { action: 'updated', id: preset.id });
    res.json({ preset });
  })
);

router.delete(
  '/user-presets/:id',
  asyncHandler(async (req, res) => {
    const presetId = Number(req.params.id);
    logger.info('delete:user-presets', { reqId: req.reqId, presetId });
    const removed = await userPresetService.deletePreset(presetId);
    wsService.broadcast('USER_PRESETS_UPDATED', { action: 'deleted', id: removed.id });
    res.json({ removed });
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
