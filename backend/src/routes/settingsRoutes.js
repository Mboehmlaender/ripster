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
const userPresetDefaultsService = require('../services/userPresetDefaultsService');
const activationBytesService = require('../services/activationBytesService');
const diskDetectionService = require('../services/diskDetectionService');
const coverArtRecoveryService = require('../services/coverArtRecoveryService');
const { fetchCurrentBetaKey, getCachedBetaKey } = require('../services/makemkvKeyService');
const logger = require('../services/logger').child('SETTINGS_ROUTE');

const { getDb } = require('../db/database');

const router = express.Router();

function isSensitiveSettingKey(key) {
  const normalized = String(key || '').trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  return /(token|password|secret|api_key|registration_key|pushover_user|subscriber_pin)/i.test(normalized);
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
  '/makemkv/beta-key',
  asyncHandler(async (req, res) => {
    logger.debug('get:settings:makemkv:beta-key', { reqId: req.reqId });
    const currentSettings = await settingsService.getSettingsMap({ forceRefresh: false });
    const existingKey = String(currentSettings?.makemkv_registration_key || '').trim();
    const cached = await getCachedBetaKey({ allowExpired: true });

    res.json({
      betaKey: cached?.key || '',
      sourceUrl: cached?.sourceUrl || null,
      validUntil: cached?.validUntil || null,
      fetchedAt: cached?.fetchedAt || null,
      cached: cached?.cached === true,
      stale: cached?.stale === true,
      appliedKey: existingKey || null,
      appliedMatchesCache: Boolean(cached?.key) && existingKey === cached.key
    });
  })
);

router.post(
  '/makemkv/beta-key/check',
  asyncHandler(async (req, res) => {
    logger.info('post:settings:makemkv:beta-key:check', { reqId: req.reqId });
    const betaKeyResult = await fetchCurrentBetaKey({ forceRefresh: true });
    res.json({
      betaKey: betaKeyResult.key,
      sourceUrl: betaKeyResult.sourceUrl,
      validUntil: betaKeyResult.validUntil || null,
      fetchedAt: betaKeyResult.fetchedAt || null,
      cached: betaKeyResult.cached === true,
      stale: betaKeyResult.stale === true
    });
  })
);

router.post(
  '/makemkv/beta-key/apply',
  asyncHandler(async (req, res) => {
    logger.info('post:settings:makemkv:beta-key:apply', { reqId: req.reqId });
    const requestedKey = String(req.body?.betaKey || '').trim();
    const cachedResult = requestedKey
      ? { key: requestedKey }
      : await getCachedBetaKey({ allowExpired: true });
    const betaKey = String(cachedResult?.key || '').trim();

    if (!betaKey) {
      const error = new Error('Kein geprüfter Betakey vorhanden. Bitte zuerst prüfen.');
      error.statusCode = 400;
      throw error;
    }

    const updated = await settingsService.setSettingValue('makemkv_registration_key', betaKey);
    wsService.broadcast('SETTINGS_UPDATED', updated);

    res.json({
      applied: true,
      setting: updated,
      betaKey,
      sourceUrl: String(cachedResult?.sourceUrl || '').trim() || null
    });
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

router.put(
  '/scripts/:id/favorite',
  asyncHandler(async (req, res) => {
    const scriptId = Number(req.params.id);
    const isFavorite = req.body?.isFavorite === true;
    logger.info('put:settings:scripts:favorite', {
      reqId: req.reqId,
      scriptId,
      isFavorite
    });
    const script = await scriptService.setScriptFavorite(scriptId, isFavorite);
    wsService.broadcast('SETTINGS_SCRIPTS_UPDATED', {
      action: 'favorite-updated',
      id: script.id,
      isFavorite: script.isFavorite === true
    });
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

router.put(
  '/script-chains/:id/favorite',
  asyncHandler(async (req, res) => {
    const chainId = Number(req.params.id);
    const isFavorite = req.body?.isFavorite === true;
    logger.info('put:settings:script-chains:favorite', { reqId: req.reqId, chainId, isFavorite });
    const chain = await scriptChainService.setChainFavorite(chainId, isFavorite);
    wsService.broadcast('SETTINGS_SCRIPT_CHAINS_UPDATED', {
      action: 'favorite-updated',
      id: chain.id,
      isFavorite: chain.isFavorite === true
    });
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

router.post(
  '/coverart/recover',
  asyncHandler(async (req, res) => {
    logger.info('post:settings:coverart:recover', { reqId: req.reqId });
    const result = await coverArtRecoveryService.runNow({
      trigger: 'manual',
      force: true,
      logFailures: true
    });
    res.json({
      result,
      scheduler: coverArtRecoveryService.getStatus()
    });
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

router.get(
  '/user-preset-defaults',
  asyncHandler(async (req, res) => {
    logger.debug('get:user-preset-defaults', { reqId: req.reqId });
    const defaults = await userPresetDefaultsService.listDefaults();
    res.json({ defaults });
  })
);

router.put(
  '/user-preset-defaults',
  asyncHandler(async (req, res) => {
    const payload = req.body || {};
    logger.info('put:user-preset-defaults:update', { reqId: req.reqId });
    const defaults = await userPresetDefaultsService.updateDefaults(payload);
    wsService.broadcast('USER_PRESETS_UPDATED', { action: 'defaults-updated' });
    res.json({ defaults });
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
    try {
      await coverArtRecoveryService.handleSettingsChanged([key]);
    } catch (error) {
      logger.warn('put:setting:coverart-scheduler-refresh-failed', {
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
    try {
      await coverArtRecoveryService.handleSettingsChanged(changes.map((item) => item.key));
    } catch (error) {
      logger.warn('put:settings:bulk:coverart-scheduler-refresh-failed', {
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

router.get(
  '/activation-bytes',
  asyncHandler(async (req, res) => {
    logger.debug('get:settings:activation-bytes', { reqId: req.reqId });
    const entries = await activationBytesService.listCachedEntries();
    res.json({ entries });
  })
);

router.post(
  '/activation-bytes',
  asyncHandler(async (req, res) => {
    const { checksum, activationBytes } = req.body || {};
    if (!checksum || !activationBytes) {
      const error = new Error('checksum und activationBytes sind erforderlich');
      error.statusCode = 400;
      throw error;
    }
    logger.debug('post:settings:activation-bytes', { reqId: req.reqId, checksum });
    const saved = await activationBytesService.saveActivationBytes(checksum, activationBytes);
    res.json({ success: true, checksum, activationBytes: saved });
  })
);

// ── Optical drive scan ────────────────────────────────────────────────────────
router.get(
  '/drives',
  asyncHandler(async (req, res) => {
    logger.debug('get:settings:drives', { reqId: req.reqId });
    const devices = await diskDetectionService.getBlockDeviceInfo();
    const drives = devices
      .filter((d) => d.type === 'rom')
      .map((d) => {
        const name = String(d.name || '');
        const devicePath = d.path || (name ? `/dev/${name}` : null);
        const resolvedIndex = Number(d.makemkvIndex);
        const discIndex = Number.isFinite(resolvedIndex) && resolvedIndex >= 0
          ? Math.trunc(resolvedIndex)
          : null;
        return {
          path: devicePath,
          name,
          model: d.model || null,
          discIndex,
          discArg: discIndex != null ? `disc:${discIndex}` : null
        };
      })
      .filter((d) => d.path);
    res.json({ drives });
  })
);

router.post(
  '/drives/force-unlock',
  asyncHandler(async (req, res) => {
    const { devicePath, all } = req.body || {};
    const settings = await settingsService.getSettingsMap();
    const expertMode = ['1', 'true', 'yes', 'on'].includes(String(settings?.ui_expert_mode || '').toLowerCase());
    if (!expertMode) {
      const error = new Error('Expertenmodus erforderlich.');
      error.statusCode = 403;
      throw error;
    }

    const devices = await diskDetectionService.getBlockDeviceInfo();
    const drives = devices
      .filter((d) => d.type === 'rom')
      .map((d) => {
        const name = String(d.name || '');
        return d.path || (name ? `/dev/${name}` : null);
      })
      .filter(Boolean);

    const activeLockPaths = (diskDetectionService.getActiveLocks?.() || [])
      .map((entry) => String(entry?.path || '').trim())
      .filter(Boolean);

    const targetPaths = all
      ? Array.from(new Set([...drives, ...activeLockPaths]))
      : [String(devicePath || '').trim()].filter(Boolean);
    if (targetPaths.length === 0) {
      const error = new Error('Kein Laufwerk angegeben.');
      error.statusCode = 400;
      throw error;
    }

    const results = [];
    for (const target of targetPaths) {
      const result = await pipelineService.forceUnlockDrive(target, { reason: 'settings_force_unlock' });
      results.push(result);
    }

    res.json({ results });
  })
);

// User preferences (UI state, persisted per-installation)
router.get(
  '/prefs/:key',
  asyncHandler(async (req, res) => {
    const { key } = req.params;
    const db = await getDb();
    const row = await db.get('SELECT value FROM user_prefs WHERE key = ?', [key]);
    res.json({ key, value: row ? row.value : null });
  })
);

router.put(
  '/prefs/:key',
  asyncHandler(async (req, res) => {
    const { key } = req.params;
    const { value } = req.body || {};
    const db = await getDb();
    await db.run(
      `INSERT INTO user_prefs (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      [key, value ?? null]
    );
    res.json({ key, value: value ?? null });
  })
);

module.exports = router;
