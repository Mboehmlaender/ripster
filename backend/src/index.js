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
const wsService = require('./services/websocketService');
const pipelineService = require('./services/pipelineService');
const cronService = require('./services/cronService');
const downloadService = require('./services/downloadService');
const diskDetectionService = require('./services/diskDetectionService');
const hardwareMonitorService = require('./services/hardwareMonitorService');
const logger = require('./services/logger').child('BOOT');
const { errorToMeta } = require('./utils/errorMeta');
const { getThumbnailsDir, migrateExistingThumbnails } = require('./services/thumbnailService');

async function start() {
  logger.info('backend:start:init');
  await initDatabase();
  await pipelineService.init();
  await cronService.init();
  await downloadService.init();

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
    diskDetectionService.stop();
    hardwareMonitorService.stop();
    cronService.stop();
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
