const fs = require('fs');
const path = require('path');
const logger = require('./logger').child('TEMP_CLEANUP');
const { tempDir } = require('../config');

const TMP_ROOT = tempDir;
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;
const STALE_ENTRY_MIN_AGE_MS = 12 * 60 * 60 * 1000;

const TOP_LEVEL_PREFIXES = [
  'ripster-merge-',
  'ripster-script-',
  'ripster-export-'
];

const MANAGED_UPLOAD_DIRS = [
  'ripster-converter-uploads',
  'ripster-audiobook-uploads'
];

function getEntryAgeMs(stats) {
  const referenceTime = Math.max(
    Number(stats?.mtimeMs) || 0,
    Number(stats?.ctimeMs) || 0,
    Number(stats?.birthtimeMs) || 0
  );
  return Date.now() - referenceTime;
}

function isStale(stats, minAgeMs = STALE_ENTRY_MIN_AGE_MS) {
  return getEntryAgeMs(stats) >= minAgeMs;
}

function removeEntry(targetPath, stats) {
  const isDirectory = stats?.isDirectory?.() || false;
  fs.rmSync(targetPath, {
    recursive: isDirectory,
    force: true
  });
}

class TempCleanupService {
  constructor() {
    this.interval = null;
  }

  async init() {
    await this.runSweep('startup');

    if (!this.interval) {
      this.interval = setInterval(() => {
        this.runSweep('interval').catch((error) => {
          logger.warn('temp:sweep:interval-failed', { error: error?.message || String(error) });
        });
      }, SWEEP_INTERVAL_MS);
      this.interval.unref?.();
    }
  }

  stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  async runSweep(reason = 'manual') {
    fs.mkdirSync(TMP_ROOT, { recursive: true });
    const deleted = [];
    const skipped = [];
    const failed = [];

    let topLevelEntries = [];
    try {
      topLevelEntries = fs.readdirSync(TMP_ROOT, { withFileTypes: true });
    } catch (error) {
      logger.warn('temp:sweep:readdir-failed', {
        reason,
        tmpRoot: TMP_ROOT,
        error: error?.message || String(error)
      });
      return { deleted, skipped, failed };
    }

    for (const entry of topLevelEntries) {
      const entryName = String(entry?.name || '').trim();
      if (!entryName || !TOP_LEVEL_PREFIXES.some((prefix) => entryName.startsWith(prefix))) {
        continue;
      }
      const targetPath = path.join(TMP_ROOT, entryName);
      try {
        const stats = fs.lstatSync(targetPath);
        if (!isStale(stats)) {
          skipped.push({ path: targetPath, reason: 'fresh-top-level-entry' });
          continue;
        }
        removeEntry(targetPath, stats);
        deleted.push(targetPath);
      } catch (error) {
        failed.push({
          path: targetPath,
          error: error?.message || String(error)
        });
      }
    }

    for (const dirName of MANAGED_UPLOAD_DIRS) {
      const uploadDir = path.join(TMP_ROOT, dirName);
      if (!fs.existsSync(uploadDir)) {
        continue;
      }

      let uploadEntries = [];
      try {
        uploadEntries = fs.readdirSync(uploadDir, { withFileTypes: true });
      } catch (error) {
        failed.push({
          path: uploadDir,
          error: error?.message || String(error)
        });
        continue;
      }

      for (const entry of uploadEntries) {
        const targetPath = path.join(uploadDir, entry.name);
        try {
          const stats = fs.lstatSync(targetPath);
          if (!isStale(stats)) {
            skipped.push({ path: targetPath, reason: 'fresh-upload-entry' });
            continue;
          }
          removeEntry(targetPath, stats);
          deleted.push(targetPath);
        } catch (error) {
          failed.push({
            path: targetPath,
            error: error?.message || String(error)
          });
        }
      }
    }

    logger.info('temp:sweep:completed', {
      reason,
      tmpRoot: TMP_ROOT,
      deletedCount: deleted.length,
      skippedCount: skipped.length,
      failedCount: failed.length,
      deleted: deleted.slice(0, 50),
      failed: failed.slice(0, 20)
    });

    return { deleted, skipped, failed };
  }
}

module.exports = new TempCleanupService();
