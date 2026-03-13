'use strict';

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { dataDir } = require('../config');
const { getDb } = require('../db/database');
const logger = require('./logger').child('THUMBNAIL');

const THUMBNAILS_DIR = path.join(dataDir, 'thumbnails');
const CACHE_DIR = path.join(THUMBNAILS_DIR, 'cache');
const MAX_REDIRECTS = 5;

function ensureDirs() {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.mkdirSync(THUMBNAILS_DIR, { recursive: true });
}

function cacheFilePath(jobId) {
  return path.join(CACHE_DIR, `job-${jobId}.jpg`);
}

function persistentFilePath(jobId) {
  return path.join(THUMBNAILS_DIR, `job-${jobId}.jpg`);
}

function localUrl(jobId) {
  return `/api/thumbnails/job-${jobId}.jpg`;
}

function isLocalUrl(url) {
  return typeof url === 'string' && url.startsWith('/api/thumbnails/');
}

function downloadImage(url, destPath, redirectsLeft = MAX_REDIRECTS) {
  return new Promise((resolve, reject) => {
    if (redirectsLeft <= 0) {
      return reject(new Error('Zu viele Weiterleitungen beim Bild-Download'));
    }

    const proto = url.startsWith('https') ? https : http;
    const file = fs.createWriteStream(destPath);

    const cleanup = () => {
      try { file.destroy(); } catch (_) {}
      try { if (fs.existsSync(destPath)) fs.unlinkSync(destPath); } catch (_) {}
    };

    proto.get(url, { timeout: 15000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        file.close(() => {
          try { if (fs.existsSync(destPath)) fs.unlinkSync(destPath); } catch (_) {}
          downloadImage(res.headers.location, destPath, redirectsLeft - 1).then(resolve).catch(reject);
        });
        return;
      }

      if (res.statusCode !== 200) {
        res.resume();
        cleanup();
        return reject(new Error(`HTTP ${res.statusCode} beim Bild-Download`));
      }

      res.pipe(file);
      file.on('finish', () => file.close(() => resolve()));
      file.on('error', (err) => { cleanup(); reject(err); });
    }).on('error', (err) => {
      cleanup();
      reject(err);
    }).on('timeout', function () {
      this.destroy();
      cleanup();
      reject(new Error('Timeout beim Bild-Download'));
    });
  });
}

/**
 * Lädt das Bild einer extern-URL in den Cache herunter.
 * Wird aufgerufen sobald poster_url bekannt ist (vor Rip-Start).
 * @returns {Promise<string|null>} lokaler Pfad oder null
 */
async function cacheJobThumbnail(jobId, posterUrl) {
  if (!posterUrl || isLocalUrl(posterUrl)) return null;

  try {
    ensureDirs();
    const dest = cacheFilePath(jobId);
    await downloadImage(posterUrl, dest);
    logger.info('thumbnail:cached', { jobId, posterUrl, dest });
    return dest;
  } catch (err) {
    logger.warn('thumbnail:cache:failed', { jobId, posterUrl, error: err.message });
    return null;
  }
}

/**
 * Verschiebt das gecachte Bild in den persistenten Ordner.
 * Gibt die lokale API-URL zurück, oder null wenn kein Bild vorhanden.
 * Wird nach erfolgreichem Rip aufgerufen.
 * @returns {string|null} lokale URL (/api/thumbnails/job-{id}.jpg) oder null
 */
function promoteJobThumbnail(jobId) {
  try {
    ensureDirs();
    const src = cacheFilePath(jobId);
    const dest = persistentFilePath(jobId);

    if (fs.existsSync(src)) {
      fs.renameSync(src, dest);
      logger.info('thumbnail:promoted', { jobId, dest });
      return localUrl(jobId);
    }

    // Falls kein Cache vorhanden, aber persistente Datei schon existiert
    if (fs.existsSync(dest)) {
      return localUrl(jobId);
    }

    logger.warn('thumbnail:promote:no-source', { jobId });
    return null;
  } catch (err) {
    logger.warn('thumbnail:promote:failed', { jobId, error: err.message });
    return null;
  }
}

/**
 * Gibt den Pfad zum persistenten Thumbnail-Ordner zurück (für Static-Serving).
 */
function getThumbnailsDir() {
  return THUMBNAILS_DIR;
}

/**
 * Kopiert das persistente Thumbnail von sourceJobId zu targetJobId.
 * Wird bei Rip-Neustart genutzt, damit der neue Job ein eigenes Bild hat
 * und nicht auf die Datei des alten Jobs angewiesen ist.
 * @returns {string|null} neue lokale URL oder null
 */
function copyThumbnail(sourceJobId, targetJobId) {
  try {
    const src = persistentFilePath(sourceJobId);
    if (!fs.existsSync(src)) return null;
    ensureDirs();
    const dest = persistentFilePath(targetJobId);
    fs.copyFileSync(src, dest);
    logger.info('thumbnail:copied', { sourceJobId, targetJobId });
    return localUrl(targetJobId);
  } catch (err) {
    logger.warn('thumbnail:copy:failed', { sourceJobId, targetJobId, error: err.message });
    return null;
  }
}

/**
 * Löscht Cache- und persistente Thumbnail-Datei eines Jobs.
 * Wird beim Löschen eines Jobs aufgerufen.
 */
function deleteThumbnail(jobId) {
  for (const filePath of [persistentFilePath(jobId), cacheFilePath(jobId)]) {
    try {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch (err) {
      logger.warn('thumbnail:delete:failed', { jobId, filePath, error: err.message });
    }
  }
}

/**
 * Migriert bestehende Jobs: lädt alle externen poster_url-Bilder herunter
 * und speichert sie lokal. Läuft beim Start im Hintergrund, sequenziell
 * mit kurzem Delay um externe Server nicht zu überlasten.
 */
async function migrateExistingThumbnails() {
  try {
    ensureDirs();
    const db = await getDb();

    // Alle abgeschlossenen Jobs mit externer poster_url, die noch kein lokales Bild haben
    const jobs = await db.all(
      `SELECT id, poster_url FROM jobs
       WHERE rip_successful = 1
         AND poster_url IS NOT NULL
         AND poster_url != ''
         AND poster_url NOT LIKE '/api/thumbnails/%'
       ORDER BY id ASC`
    );

    if (!jobs.length) {
      logger.info('thumbnail:migrate:nothing-to-do');
      return;
    }

    logger.info('thumbnail:migrate:start', { count: jobs.length });
    let succeeded = 0;
    let failed = 0;

    for (const job of jobs) {
      // Persistente Datei bereits vorhanden? Dann nur DB aktualisieren.
      const dest = persistentFilePath(job.id);
      if (fs.existsSync(dest)) {
        await db.run('UPDATE jobs SET poster_url = ? WHERE id = ?', [localUrl(job.id), job.id]);
        succeeded++;
        continue;
      }

      try {
        await downloadImage(job.poster_url, dest);
        await db.run('UPDATE jobs SET poster_url = ? WHERE id = ?', [localUrl(job.id), job.id]);
        logger.info('thumbnail:migrate:ok', { jobId: job.id });
        succeeded++;
      } catch (err) {
        logger.warn('thumbnail:migrate:failed', { jobId: job.id, url: job.poster_url, error: err.message });
        failed++;
      }

      // Kurze Pause zwischen Downloads (externe Server schonen)
      await new Promise((r) => setTimeout(r, 300));
    }

    logger.info('thumbnail:migrate:done', { succeeded, failed, total: jobs.length });
  } catch (err) {
    logger.error('thumbnail:migrate:error', { error: err.message });
  }
}

module.exports = {
  cacheJobThumbnail,
  promoteJobThumbnail,
  copyThumbnail,
  deleteThumbnail,
  getThumbnailsDir,
  migrateExistingThumbnails,
  isLocalUrl
};
