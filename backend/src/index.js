// SPDX-License-Identifier: GPL-2.0-or-later

require('dotenv').config();

const http = require('http');
const express = require('express');
const cors = require('cors');
const { port, corsOrigin } = require('./config');
const { initDatabase } = require('./db/database');
const errorHandler = require('./middleware/errorHandler');
const requestLogger = require('./middleware/requestLogger');
const settingsRoutes = require('./routes/settingsRoutes');
const pipelineRoutes = require('./routes/pipelineRoutes');
const historyRoutes = require('./routes/historyRoutes');
const downloadRoutes = require('./routes/downloadRoutes');
const cronRoutes = require('./routes/cronRoutes');
const runtimeRoutes = require('./routes/runtimeRoutes');
const converterRoutes = require('./routes/converterRoutes');
const wsService = require('./services/websocketService');
const pipelineService = require('./services/pipelineService');
const settingsService = require('./services/settingsService');
const converterScanService = require('./services/converterScanService');
const cronService = require('./services/cronService');
const downloadService = require('./services/downloadService');
const diskDetectionService = require('./services/diskDetectionService');
const hardwareMonitorService = require('./services/hardwareMonitorService');
const coverArtRecoveryService = require('./services/coverArtRecoveryService');
const tempCleanupService = require('./services/tempCleanupService');
const { fetchCurrentBetaKey } = require('./services/makemkvKeyService');
const logger = require('./services/logger').child('BOOT');
const { errorToMeta } = require('./utils/errorMeta');
const { getThumbnailsDir, migrateExistingThumbnails } = require('./services/thumbnailService');

function getDelayUntilNextBetaKeyCheck(now = new Date()) {
  const next = new Date(now);
  next.setHours(0, 1, 0, 0);
  if (next.getTime() <= now.getTime()) {
    next.setDate(next.getDate() + 1);
  }
  return Math.max(1000, next.getTime() - now.getTime());
}

async function start() {
  logger.info('backend:start:init');
  await initDatabase();
  try {
    const runtimeSettings = await settingsService.applyRuntimeSettings();
    logger.info('backend:runtime-settings:applied', runtimeSettings);
  } catch (error) {
    logger.warn('backend:runtime-settings:apply-failed', { error: errorToMeta(error) });
  }
  let betaKeyRefreshTimer = null;
  const scheduleBetaKeyRefresh = () => {
    clearTimeout(betaKeyRefreshTimer);
    const delayMs = getDelayUntilNextBetaKeyCheck();
    betaKeyRefreshTimer = setTimeout(runBetaKeyRefresh, delayMs);
    betaKeyRefreshTimer.unref?.();
    logger.info('beta-key:daily-check:scheduled', {
      delayMs,
      nextRunAt: new Date(Date.now() + delayMs).toISOString()
    });
  };
  const runBetaKeyRefresh = async () => {
    try {
      const result = await fetchCurrentBetaKey({ forceRefresh: true });
      logger.info('beta-key:daily-check:done', {
        sourceUrl: result?.sourceUrl || null,
        validUntil: result?.validUntil || null,
        fetchedAt: result?.fetchedAt || null
      });
    } catch (error) {
      logger.warn('beta-key:daily-check:failed', { error: errorToMeta(error) });
    } finally {
      scheduleBetaKeyRefresh();
    }
  };
  scheduleBetaKeyRefresh();
  await tempCleanupService.init();
  await pipelineService.init();
  await converterScanService.startPolling();
  await cronService.init();
  await downloadService.init();
  await coverArtRecoveryService.init();

  const app = express();
  app.use(cors({ origin: corsOrigin }));
  app.use(express.json({ limit: '2mb' }));
  app.use(requestLogger);

  app.get('/api/health', (req, res) => {
    res.json({ ok: true, now: new Date().toISOString() });
  });

  app.use('/api/settings', settingsRoutes);
  app.use('/api/pipeline', pipelineRoutes);
  app.use('/api/history', historyRoutes);
  app.use('/api/downloads', downloadRoutes);
  app.use('/api/crons', cronRoutes);
  app.use('/api/runtime', runtimeRoutes);
  app.use('/api/converter', converterRoutes);
  app.use('/api/thumbnails', express.static(getThumbnailsDir(), { maxAge: '30d', immutable: true }));

  app.use(errorHandler);

  const server = http.createServer(app);
  wsService.init(server);
  await hardwareMonitorService.init();

  diskDetectionService.on('discInserted', (device) => {
    logger.info('disk:inserted:event', { device });
    pipelineService.onDiscInserted(device).catch((error) => {
      logger.error('pipeline:onDiscInserted:failed', { error: errorToMeta(error), device });
      wsService.broadcast('PIPELINE_ERROR', { message: error.message });
    });
  });

  diskDetectionService.on('discRemoved', (device) => {
    logger.info('disk:removed:event', { device });
    pipelineService.onDiscRemoved(device).catch((error) => {
      logger.error('pipeline:onDiscRemoved:failed', { error: errorToMeta(error), device });
      wsService.broadcast('PIPELINE_ERROR', { message: error.message });
    });
  });

  diskDetectionService.on('error', (error) => {
    logger.error('diskDetection:error:event', { error: errorToMeta(error) });
    wsService.broadcast('DISK_DETECTION_ERROR', { message: error.message });
  });

  diskDetectionService.start();

  server.listen(port, () => {
    logger.info('backend:listening', { port });
    // Bestehende Job-Bilder im Hintergrund migrieren (blockiert nicht den Start)
    migrateExistingThumbnails().catch(() => {});
  });

  const shutdown = () => {
    logger.warn('backend:shutdown:received');
    converterScanService.stopPolling();
    diskDetectionService.stop();
    coverArtRecoveryService.stop();
    hardwareMonitorService.stop();
    cronService.stop();
    tempCleanupService.stop();
    clearTimeout(betaKeyRefreshTimer);
    server.close(() => {
      logger.warn('backend:shutdown:completed');
      process.exit(0);
    });
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  process.on('uncaughtException', (error) => {
    logger.error('process:uncaughtException', { error: errorToMeta(error) });
  });

  process.on('unhandledRejection', (reason) => {
    logger.error('process:unhandledRejection', {
      reason: reason instanceof Error ? errorToMeta(reason) : String(reason)
    });
  });
}

start().catch((error) => {
  logger.error('backend:start:failed', { error: errorToMeta(error) });
  process.exit(1);
});
