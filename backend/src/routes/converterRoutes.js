'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const asyncHandler = require('../middleware/asyncHandler');
const pipelineService = require('../services/pipelineService');
const converterScanService = require('../services/converterScanService');
const historyService = require('../services/historyService');
const logger = require('../services/logger').child('CONVERTER_ROUTE');
const { tempDir } = require('../config');

/** Pfadauflösung mit Traversal-Schutz (wie Klangkiste resolveMediaTarget) */
function resolveTarget(rawDir, input) {
  const rel = converterScanService.normalizeRelPath(input != null ? String(input) : '');
  if (rel === null) return { error: 'Ungültiger Pfad' };
  const absolute = path.join(rawDir, rel || '.');
  return { rel: rel || '', absolute };
}

const router = express.Router();
const converterUploadDir = path.join(tempDir, 'ripster-converter-uploads');
fs.mkdirSync(converterUploadDir, { recursive: true });

const converterUpload = multer({
  dest: converterUploadDir
});

// ── Scan ──────────────────────────────────────────────────────────────────

/**
 * GET /api/converter/tree
 * Vollständiger FS-Verzeichnisbaum des converter_raw_dir (keine DB).
 */
router.get(
  '/tree',
  asyncHandler(async (req, res) => {
    logger.debug('get:tree');
    const result = await converterScanService.getTree();
    res.json(result);
  })
);

/**
 * GET /api/converter/browse?parent=relPath
 * File-Explorer (DB-basiert, wird weiterhin für Job-Zuweisung gebraucht).
 */
router.get(
  '/browse',
  asyncHandler(async (req, res) => {
    const parent = req.query.parent ? String(req.query.parent).trim() : null;
    logger.debug('get:browse', { parent });
    const entries = await converterScanService.getEntries(parent);
    const rawDir = await converterScanService.getRawDir();
    res.json({ entries, rawDir });
  })
);

/**
 * POST /api/converter/scan
 * Manuellen Scan des converter_raw_dir auslösen.
 */
router.post(
  '/scan',
  asyncHandler(async (req, res) => {
    logger.info('post:scan');
    const result = await converterScanService.scan();
    res.json({ result });
  })
);

// ── Jobs erstellen ────────────────────────────────────────────────────────

/**
 * POST /api/converter/create-jobs
 * Body: { entries: [{ relPath, converterMediaType }] }
 * Erstellt Jobs aus Scan-Einträgen (File-Explorer-Auswahl).
 */
router.post(
  '/create-jobs',
  asyncHandler(async (req, res) => {
    const entries = Array.isArray(req.body?.entries) ? req.body.entries : [];
    if (entries.length === 0) {
      const error = new Error('Keine Einträge ausgewählt.');
      error.statusCode = 400;
      throw error;
    }
    logger.info('post:create-jobs', { count: entries.length });

    const jobs = [];
    for (const entry of entries) {
      const relPath = String(entry?.relPath || '').trim();
      if (!relPath) continue;
      const job = await pipelineService.createFileJob({
        kind: 'converter_entry',
        relPath,
        options: {
          converterMediaType: entry?.converterMediaType || null
        }
      });
      jobs.push(job);
    }
    res.json({ jobs });
  })
);

/**
 * POST /api/converter/upload
 * Datei(en) hochladen → Unterordner anlegen (kein Job-Anlegen).
 * Gibt { folders: [{folderRelPath, fileCount}] } zurück.
 */
router.post(
  '/upload',
  converterUpload.array('files', 50),
  asyncHandler(async (req, res) => {
    const files = Array.isArray(req.files) ? req.files : [];
    if (files.length === 0) {
      const error = new Error('Keine Dateien hochgeladen.');
      error.statusCode = 400;
      throw error;
    }
    const folderName = req.body?.folderName ? String(req.body.folderName).trim() : null;
    logger.info('post:upload', {
      fileCount: files.length,
      folderName,
      files: files.map((f) => ({ name: f.originalname, size: f.size }))
    });
    const result = await pipelineService.uploadConverterFiles(files, { folderName });
    res.json(result);
  })
);

/**
 * POST /api/converter/jobs/from-selection
 * Body: { relPaths: string[], audioMode: 'individual'|'shared' }
 * Erstellt Jobs aus im File-Explorer ausgewählten Dateien.
 */
router.post(
  '/jobs/from-selection',
  asyncHandler(async (req, res) => {
    const relPaths = Array.isArray(req.body?.relPaths) ? req.body.relPaths : [];
    const audioMode = String(req.body?.audioMode || 'individual');
    if (relPaths.length === 0) {
      const error = new Error('Keine Dateien ausgewählt.');
      error.statusCode = 400;
      throw error;
    }
    logger.info('post:jobs:from-selection', { count: relPaths.length, audioMode });
    const jobs = await pipelineService.createConverterJobsFromSelection(relPaths, audioMode);
    res.json({ jobs });
  })
);

/**
 * POST /api/converter/jobs/:jobId/assign-files
 * Body: { relPaths: string[] }
 * Fügt ausgewählte Dateien einem bestehenden (nicht gestarteten) Converter-Job hinzu.
 */
router.post(
  '/jobs/:jobId/assign-files',
  asyncHandler(async (req, res) => {
    const jobId = Number(req.params.jobId);
    const relPaths = Array.isArray(req.body?.relPaths) ? req.body.relPaths : [];
    if (!Number.isFinite(jobId) || jobId <= 0) {
      return res.status(400).json({ detail: 'Ungültige jobId.' });
    }
    if (relPaths.length === 0) {
      return res.status(400).json({ detail: 'Keine Dateien übergeben.' });
    }
    logger.info('post:jobs:assign-files', { jobId, count: relPaths.length });
    const result = await pipelineService.assignConverterFilesToJob(jobId, relPaths);
    res.json(result);
  })
);

/**
 * POST /api/converter/jobs/:jobId/remove-file
 * Body: { relPath: string }
 * Entfernt eine Datei aus einem bestehenden Converter-Job.
 */
router.post(
  '/jobs/:jobId/remove-file',
  asyncHandler(async (req, res) => {
    const jobId = Number(req.params.jobId);
    const relPath = String(req.body?.relPath || '').trim();
    if (!Number.isFinite(jobId) || jobId <= 0) {
      return res.status(400).json({ detail: 'Ungültige jobId.' });
    }
    if (!relPath) {
      return res.status(400).json({ detail: 'relPath fehlt.' });
    }
    logger.info('post:jobs:remove-file', { jobId, relPath });
    const result = await pipelineService.removeConverterFileFromJob(jobId, relPath);
    res.json(result);
  })
);

/**
 * POST /api/converter/jobs/:jobId/remove-input
 * Body: { inputPath: string }
 * Entfernt eine Datei aus einem Converter-Job anhand des absoluten Input-Pfads.
 */
router.post(
  '/jobs/:jobId/remove-input',
  asyncHandler(async (req, res) => {
    const jobId = Number(req.params.jobId);
    const inputPath = String(req.body?.inputPath || '').trim();
    if (!Number.isFinite(jobId) || jobId <= 0) {
      return res.status(400).json({ detail: 'Ungültige jobId.' });
    }
    if (!inputPath) {
      return res.status(400).json({ detail: 'inputPath fehlt.' });
    }
    logger.info('post:jobs:remove-input', { jobId, inputPath });
    const result = await pipelineService.removeConverterInputFromJob(jobId, inputPath);
    res.json(result);
  })
);

/**
 * POST /api/converter/jobs/:jobId/config
 * Body: partial config draft (outputFormat, presets, metadata, tracks, MusicBrainz-UI-Stand)
 * Speichert den Draft für READY_TO_START Jobs persistent im encode_plan_json.
 */
router.post(
  '/jobs/:jobId/config',
  asyncHandler(async (req, res) => {
    const jobId = Number(req.params.jobId);
    if (!Number.isFinite(jobId) || jobId <= 0) {
      return res.status(400).json({ detail: 'Ungültige jobId.' });
    }
    logger.debug('post:jobs:config', { jobId });
    const result = await pipelineService.updateConverterJobConfig(jobId, req.body || {});
    res.json(result);
  })
);

// ── Datei-Operationen (reines FS, keine DB) ───────────────────────────────

/**
 * DELETE /api/converter/files
 * Body: { relPath }
 * Datei oder Ordner löschen (fs.rmSync, ohne DB).
 */
router.delete(
  '/files',
  asyncHandler(async (req, res) => {
    const rawDir = await converterScanService.getRawDir();
    if (!rawDir) return res.status(400).json({ detail: 'Kein RAW-Verzeichnis konfiguriert.' });
    const relPath = String(req.body?.relPath || '').trim();
    if (!relPath) return res.status(400).json({ detail: 'relPath fehlt.' });
    const target = resolveTarget(rawDir, relPath);
    if (target.error || !target.rel) return res.status(400).json({ detail: target.error || 'Ungültiger Pfad.' });
    logger.info('delete:files', { relPath });
    fs.rmSync(target.absolute, { recursive: true, force: true });
    res.json({ ok: true });
  })
);

/**
 * POST /api/converter/files/rename
 * Body: { relPath, newName }
 * Umbenennen (fs.renameSync, ohne DB).
 */
router.post(
  '/files/rename',
  asyncHandler(async (req, res) => {
    const rawDir = await converterScanService.getRawDir();
    if (!rawDir) return res.status(400).json({ detail: 'Kein RAW-Verzeichnis konfiguriert.' });
    const relPath = String(req.body?.relPath || '').trim();
    const newName = String(req.body?.newName || '').trim();
    if (!relPath || !newName) return res.status(400).json({ detail: 'relPath und newName erforderlich.' });
    if (newName.includes('/') || newName.includes('\\')) return res.status(400).json({ detail: 'Ungültiger Name.' });
    const source = resolveTarget(rawDir, relPath);
    if (source.error || !source.rel) return res.status(400).json({ detail: source.error || 'Ungültiger Quellpfad.' });
    const parentAbs = path.dirname(source.absolute);
    const destAbs = path.join(parentAbs, newName);
    logger.info('post:files:rename', { relPath, newName });
    fs.renameSync(source.absolute, destAbs);
    res.json({ ok: true });
  })
);

/**
 * POST /api/converter/files/move
 * Body: { relPath, targetParentRelPath }
 * Verschieben (fs.renameSync, ohne DB). targetParentRelPath = '' → Root.
 */
router.post(
  '/files/move',
  asyncHandler(async (req, res) => {
    const rawDir = await converterScanService.getRawDir();
    if (!rawDir) return res.status(400).json({ detail: 'Kein RAW-Verzeichnis konfiguriert.' });
    const relPath = String(req.body?.relPath || '').trim();
    if (!relPath) return res.status(400).json({ detail: 'relPath erforderlich.' });
    const targetParentRelPath = req.body?.targetParentRelPath != null ? String(req.body.targetParentRelPath) : '';
    const source = resolveTarget(rawDir, relPath);
    if (source.error || !source.rel) return res.status(400).json({ detail: source.error || 'Ungültiger Quellpfad.' });
    const targetParent = resolveTarget(rawDir, targetParentRelPath);
    if (targetParent.error) return res.status(400).json({ detail: targetParent.error });
    const name = path.basename(source.absolute);
    const destAbs = path.join(targetParent.absolute, name);
    logger.info('post:files:move', { relPath, targetParentRelPath });
    fs.renameSync(source.absolute, destAbs);
    res.json({ ok: true });
  })
);

/**
 * POST /api/converter/files/folder
 * Body: { parentRelPath, name }
 * Neuen Ordner anlegen (fs.mkdirSync, ohne DB).
 */
router.post(
  '/files/folder',
  asyncHandler(async (req, res) => {
    const rawDir = await converterScanService.getRawDir();
    if (!rawDir) return res.status(400).json({ detail: 'Kein RAW-Verzeichnis konfiguriert.' });
    const parentRelPath = req.body?.parentRelPath != null ? String(req.body.parentRelPath) : '';
    const name = String(req.body?.name || '').trim();
    if (!name || name.includes('/') || name.includes('\\')) return res.status(400).json({ detail: 'Ungültiger Name.' });
    const parent = resolveTarget(rawDir, parentRelPath);
    if (parent.error) return res.status(400).json({ detail: parent.error });
    logger.info('post:files:folder', { parentRelPath, name });
    fs.mkdirSync(path.join(parent.absolute, name), { recursive: true });
    res.json({ ok: true });
  })
);

// ── Job-Status ────────────────────────────────────────────────────────────

/**
 * GET /api/converter/jobs
 * Alle Converter-Jobs zurückgeben.
 */
router.get(
  '/jobs',
  asyncHandler(async (req, res) => {
    const jobs = await pipelineService.getConverterJobs();
    res.json({ jobs });
  })
);

/**
 * GET /api/converter/jobs/:jobId
 * Einzelnen Converter-Job abrufen.
 */
router.get(
  '/jobs/:jobId',
  asyncHandler(async (req, res) => {
    const jobId = Number(req.params.jobId);
    const job = await historyService.getJobById(jobId);
    if (!job) {
      const error = new Error(`Job ${jobId} nicht gefunden.`);
      error.statusCode = 404;
      throw error;
    }
    res.json({ job });
  })
);

/**
 * POST /api/converter/jobs/:jobId/start
 * Job mit finaler Konfiguration starten.
 * Body: { converterMediaType, outputFormat, userPreset, trackSelection, handBrakeTitleId, audioFormatOptions }
 */
router.post(
  '/jobs/:jobId/start',
  asyncHandler(async (req, res) => {
    const jobId = Number(req.params.jobId);
    const config = req.body || {};
    logger.info('post:jobs:start', {
      jobId,
      converterMediaType: config.converterMediaType,
      outputFormat: config.outputFormat
    });
    const result = await pipelineService.startConverterJob(jobId, config);
    res.json({ result });
  })
);

/**
 * POST /api/converter/jobs/:jobId/cancel
 * Job abbrechen.
 */
router.post(
  '/jobs/:jobId/cancel',
  asyncHandler(async (req, res) => {
    const jobId = Number(req.params.jobId);
    logger.info('post:jobs:cancel', { jobId });
    const result = await pipelineService.cancel(jobId);
    res.json({ result });
  })
);

/**
 * DELETE /api/converter/jobs/:jobId
 * Job aus der DB löschen.
 */
router.delete(
  '/jobs/:jobId',
  asyncHandler(async (req, res) => {
    const jobId = Number(req.params.jobId);
    logger.info('delete:jobs', { jobId });
    await historyService.deleteJob(jobId, 'none', { includeRelated: false });
    await converterScanService.clearAssignmentsForJob(jobId);
    res.json({ ok: true });
  })
);

module.exports = router;
