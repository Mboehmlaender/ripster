const express = require('express');
const asyncHandler = require('../middleware/asyncHandler');
const downloadService = require('../services/downloadService');
const logger = require('../services/logger').child('DOWNLOAD_ROUTE');

const router = express.Router();

router.get(
  '/',
  asyncHandler(async (req, res) => {
    logger.debug('get:downloads', { reqId: req.reqId });
    const items = await downloadService.listItems();
    res.json({
      items,
      summary: downloadService.getSummary()
    });
  })
);

router.get(
  '/summary',
  asyncHandler(async (req, res) => {
    await downloadService.init();
    res.json({ summary: downloadService.getSummary() });
  })
);

router.post(
  '/history/:jobId',
  asyncHandler(async (req, res) => {
    const jobId = Number(req.params.jobId);
    const target = String(req.body?.target || 'raw').trim();
    logger.info('post:downloads:history', {
      reqId: req.reqId,
      jobId,
      target
    });
    const result = await downloadService.enqueueHistoryJob(jobId, target);
    res.status(result.created ? 201 : 200).json({
      ...result,
      summary: downloadService.getSummary()
    });
  })
);

router.get(
  '/:id/file',
  asyncHandler(async (req, res) => {
    const descriptor = await downloadService.getDownloadDescriptor(req.params.id);
    res.download(descriptor.path, descriptor.archiveName);
  })
);

router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    logger.info('delete:downloads:item', {
      reqId: req.reqId,
      id: req.params.id
    });
    const result = await downloadService.deleteItem(req.params.id);
    res.json({
      ...result,
      summary: downloadService.getSummary()
    });
  })
);

module.exports = router;
