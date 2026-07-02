'use strict';

const fs = require('fs');
const path = require('path');
const { getDb } = require('../db/database');
const settingsService = require('./settingsService');
const wsService = require('./websocketService');
const logger = require('./logger').child('CONVERTER_SCAN');
const {
  defaultConverterRawDir
} = require('../config');

const VIDEO_EXTENSIONS = new Set(['mkv', 'mp4', 'm2ts', 'avi', 'mov']);
const AUDIO_EXTENSIONS = new Set(['flac', 'mp3', 'wav', 'm4a', 'ogg', 'opus']);
const ISO_EXTENSIONS = new Set(['iso']);
const SUPPORTED_SCAN_EXTENSIONS = new Set([...VIDEO_EXTENSIONS, ...AUDIO_EXTENSIONS, ...ISO_EXTENSIONS]);

let _pollingTimer = null;
let _pollingEnabled = false;
let _pollingInterval = 300;

function detectMediaType(fileName) {
  const ext = path.extname(String(fileName || '')).slice(1).toLowerCase();
  if (ISO_EXTENSIONS.has(ext)) return 'iso';
  if (VIDEO_EXTENSIONS.has(ext)) return 'video';
  if (AUDIO_EXTENSIONS.has(ext)) return 'audio';
  return null;
}

function detectFormat(fileName) {
  return path.extname(String(fileName || '')).slice(1).toLowerCase() || null;
}

function getConfiguredExtensions(settings) {
  const raw = String(settings?.converter_scan_extensions || '').trim();
  if (!raw) {
    return new Set(SUPPORTED_SCAN_EXTENSIONS);
  }
  const configured = raw.split(',')
    .map((ext) => ext.trim().toLowerCase())
    .filter(Boolean);
  const filtered = configured.filter((ext) => SUPPORTED_SCAN_EXTENSIONS.has(ext));
  if (filtered.length === 0) {
    return new Set(SUPPORTED_SCAN_EXTENSIONS);
  }
  return new Set(filtered);
}

function getFileSize(fullPath) {
  try {
    return fs.statSync(fullPath).size;
  } catch (_err) {
    return null;
  }
}

const SCAN_MAX_DEPTH = 4;

/**
 * Rekursiv alle Dateien und direkten Unterordner im rawDir scannen.
 * Gibt ein flaches Array von { relPath, entryType, fileSize, detectedMediaType, detectedFormat } zurück.
 * Maximale Tiefe: SCAN_MAX_DEPTH (verhindert unendliche Rekursion bei geschachtelten Ordnern).
 */
function scanDirectory(rawDir, allowedExtensions, parentRelPath = '', depth = 0) {
  const entries = [];

  if (depth >= SCAN_MAX_DEPTH) {
    return entries;
  }

  let dirEntries;
  try {
    dirEntries = fs.readdirSync(rawDir, { withFileTypes: true });
  } catch (_err) {
    return entries;
  }

  for (const dirent of dirEntries) {
    const relPath = parentRelPath ? `${parentRelPath}/${dirent.name}` : dirent.name;
    const fullPath = path.join(rawDir, relPath);

    if (dirent.isDirectory()) {
      entries.push({
        relPath,
        entryType: 'directory',
        fileSize: null,
        detectedMediaType: null,
        detectedFormat: null
      });
      // Rekursiv in Unterordner (mit Tiefenbegrenzung)
      const subEntries = scanDirectory(rawDir, allowedExtensions, relPath, depth + 1);
      entries.push(...subEntries);
    } else if (dirent.isFile()) {
      const ext = path.extname(dirent.name).slice(1).toLowerCase();
      if (!allowedExtensions.has(ext)) {
        continue;
      }
      entries.push({
        relPath,
        entryType: 'file',
        fileSize: getFileSize(fullPath),
        detectedMediaType: detectMediaType(dirent.name),
        detectedFormat: detectFormat(dirent.name)
      });
    }
  }

  return entries;
}

/**
 * Scan-Ergebnisse in die DB schreiben (INSERT OR REPLACE) und
 * nicht mehr vorhandene Einträge ohne Job entfernen.
 */
async function persistScanResults(rawDir, entries) {
  const db = await getDb();

  if (entries.length > 0) {
    const stmt = await db.prepare(`
      INSERT INTO converter_scan_entries (rel_path, entry_type, file_size, detected_media_type, detected_format, last_seen_at)
      VALUES (?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(rel_path) DO UPDATE SET
        entry_type = excluded.entry_type,
        file_size = excluded.file_size,
        detected_media_type = excluded.detected_media_type,
        detected_format = excluded.detected_format,
        last_seen_at = excluded.last_seen_at
    `);

    for (const entry of entries) {
      await stmt.run(
        entry.relPath,
        entry.entryType,
        entry.fileSize,
        entry.detectedMediaType,
        entry.detectedFormat
      );
    }
    await stmt.finalize();
  }

  // Einträge ohne zugewiesenen Job entfernen, wenn Datei nicht mehr vorhanden
  const existingEntries = await db.all(
    `SELECT rel_path FROM converter_scan_entries WHERE job_id IS NULL`
  );
  const currentRelPaths = new Set(entries.map((e) => e.relPath));

  for (const row of existingEntries) {
    if (!currentRelPaths.has(row.rel_path)) {
      const fullPath = path.join(rawDir, row.rel_path);
      if (!fs.existsSync(fullPath)) {
        await db.run(
          `DELETE FROM converter_scan_entries WHERE rel_path = ? AND job_id IS NULL`,
          [row.rel_path]
        );
      }
    }
  }
}

/**
 * Hauptmethode: rawDir scannen, DB aktualisieren, WebSocket-Event senden.
 */
async function scan() {
  const settings = await settingsService.getSettingsMap();
  const rawDir = String(settings?.converter_raw_dir || defaultConverterRawDir || '').trim();

  if (!rawDir) {
    logger.warn('converter:scan:no-raw-dir');
    return { rawDir: null, entryCount: 0 };
  }

  if (!fs.existsSync(rawDir)) {
    logger.warn('converter:scan:dir-missing', { rawDir });
    return { rawDir, entryCount: 0 };
  }

  const allowedExtensions = getConfiguredExtensions(settings);
  logger.info('converter:scan:start', { rawDir, allowedExtensions: [...allowedExtensions] });

  const entries = scanDirectory(rawDir, allowedExtensions);
  await persistScanResults(rawDir, entries);

  logger.info('converter:scan:done', { rawDir, entryCount: entries.length });

  wsService.broadcast('CONVERTER_SCAN_UPDATE', { entryCount: entries.length });

  return { rawDir, entryCount: entries.length };
}

/**
 * Alle Einträge für den File-Explorer zurückgeben.
 * Optionaler parentRelPath filtert auf Kinder eines bestimmten Verzeichnisses.
 */
async function getEntries(parentRelPath = null) {
  const db = await getDb();

  let rows;
  if (!parentRelPath) {
    // Root-Ebene: nur Einträge ohne '/' im rel_path
    rows = await db.all(`
      SELECT e.*, j.status AS job_status, j.title AS job_title
      FROM converter_scan_entries e
      LEFT JOIN jobs j ON j.id = e.job_id
      ORDER BY e.entry_type DESC, e.rel_path ASC
    `);
    // Nur direkte Kinder (kein '/' im rel_path)
    rows = rows.filter((r) => !String(r.rel_path).includes('/'));
  } else {
    const prefix = parentRelPath.endsWith('/') ? parentRelPath : `${parentRelPath}/`;
    rows = await db.all(`
      SELECT e.*, j.status AS job_status, j.title AS job_title
      FROM converter_scan_entries e
      LEFT JOIN jobs j ON j.id = e.job_id
      ORDER BY e.entry_type DESC, e.rel_path ASC
    `);
    // Direkte Kinder des angegebenen Verzeichnisses
    rows = rows.filter((r) => {
      const rel = String(r.rel_path);
      if (!rel.startsWith(prefix)) return false;
      const remainder = rel.slice(prefix.length);
      return !remainder.includes('/');
    });
  }

  return rows.map((r) => ({
    id: r.id,
    relPath: r.rel_path,
    entryType: r.entry_type,
    fileSize: r.file_size,
    detectedMediaType: r.detected_media_type,
    detectedFormat: r.detected_format,
    jobId: r.job_id,
    jobStatus: r.job_status || null,
    jobTitle: r.job_title || null,
    lastSeenAt: r.last_seen_at
  }));
}

async function getEntryById(id) {
  const db = await getDb();
  const row = await db.get(
    `SELECT * FROM converter_scan_entries WHERE id = ?`,
    [Number(id)]
  );
  return row || null;
}

async function getEntryByRelPath(relPath) {
  const db = await getDb();
  const row = await db.get(
    `SELECT * FROM converter_scan_entries WHERE rel_path = ?`,
    [relPath]
  );
  return row || null;
}

async function setEntryJobAssignment(relPath, jobId) {
  const normalizedRelPath = normalizeRelPath(relPath);
  if (normalizedRelPath === null || normalizedRelPath === '') {
    throw makeError('Ungültiger relPath für Job-Zuweisung.', 400);
  }
  const normalizedJobId = Number(jobId);
  if (!Number.isFinite(normalizedJobId) || normalizedJobId <= 0) {
    throw makeError('Ungültige jobId für Job-Zuweisung.', 400);
  }

  const db = await getDb();
  const existing = await db.get(
    `SELECT entry_type, file_size, detected_media_type, detected_format
     FROM converter_scan_entries
     WHERE rel_path = ?`,
    [normalizedRelPath]
  );

  let entryType = String(existing?.entry_type || 'file').trim() || 'file';
  let fileSize = existing?.file_size ?? null;
  let detectedMediaType = existing?.detected_media_type ?? null;
  let detectedFormat = existing?.detected_format ?? null;

  const rawDir = await getRawDir();
  const absPath = rawDir ? path.join(rawDir, normalizedRelPath) : null;
  if (absPath && fs.existsSync(absPath)) {
    try {
      const stat = fs.statSync(absPath);
      entryType = stat.isDirectory() ? 'directory' : 'file';
      fileSize = stat.isFile() ? stat.size : null;
      if (stat.isFile()) {
        const fileName = path.basename(normalizedRelPath);
        detectedMediaType = detectMediaType(fileName);
        detectedFormat = detectFormat(fileName);
      }
    } catch (_err) {
      // Keep existing metadata values if stat/read fails.
    }
  }

  await db.run(
    `
      INSERT INTO converter_scan_entries (
        rel_path,
        entry_type,
        file_size,
        detected_media_type,
        detected_format,
        job_id,
        last_seen_at
      )
      VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(rel_path) DO UPDATE SET
        entry_type = excluded.entry_type,
        file_size = excluded.file_size,
        detected_media_type = excluded.detected_media_type,
        detected_format = excluded.detected_format,
        job_id = excluded.job_id,
        last_seen_at = excluded.last_seen_at
    `,
    [
      normalizedRelPath,
      entryType,
      fileSize,
      detectedMediaType,
      detectedFormat,
      Math.trunc(normalizedJobId)
    ]
  );
}

async function clearEntryJobAssignment(relPath, expectedJobId = null) {
  const normalizedRelPath = normalizeRelPath(relPath);
  if (normalizedRelPath === null || normalizedRelPath === '') {
    throw makeError('Ungültiger relPath für Job-Entfernung.', 400);
  }
  const db = await getDb();
  const normalizedExpected = Number(expectedJobId);
  if (Number.isFinite(normalizedExpected) && normalizedExpected > 0) {
    await db.run(
      `UPDATE converter_scan_entries SET job_id = NULL WHERE rel_path = ? AND job_id = ?`,
      [normalizedRelPath, Math.trunc(normalizedExpected)]
    );
    return;
  }
  await db.run(
    `UPDATE converter_scan_entries SET job_id = NULL WHERE rel_path = ?`,
    [normalizedRelPath]
  );
}

async function clearAssignmentsForJob(jobId) {
  const normalizedJobId = Number(jobId);
  if (!Number.isFinite(normalizedJobId) || normalizedJobId <= 0) {
    throw makeError('Ungültige jobId für Job-Entfernung.', 400);
  }
  const db = await getDb();
  await db.run(
    `UPDATE converter_scan_entries SET job_id = NULL WHERE job_id = ?`,
    [Math.trunc(normalizedJobId)]
  );
}

async function assignEntriesToJob(relPaths, jobId) {
  const normalizedPaths = Array.isArray(relPaths) ? relPaths : [];
  for (const relPath of normalizedPaths) {
    await setEntryJobAssignment(relPath, jobId);
  }
}

async function markEntryAsJob(relPath, jobId) {
  await setEntryJobAssignment(relPath, jobId);
}

async function getRawDir() {
  const settings = await settingsService.getSettingsMap();
  return String(settings?.converter_raw_dir || defaultConverterRawDir || '').trim();
}

/**
 * Polling-Loop starten.
 */
async function startPolling() {
  const settings = await settingsService.getSettingsMap();
  _pollingEnabled = String(settings?.converter_polling_enabled || 'false').toLowerCase() === 'true';
  _pollingInterval = Math.max(30, Number(settings?.converter_polling_interval || 300)) * 1000;

  stopPolling();

  if (!_pollingEnabled) {
    logger.info('converter:polling:disabled');
    return;
  }

  logger.info('converter:polling:start', { intervalMs: _pollingInterval });

  const tick = async () => {
    try {
      await scan();
    } catch (error) {
      logger.error('converter:polling:error', { error: error?.message });
    }
    if (_pollingEnabled) {
      _pollingTimer = setTimeout(tick, _pollingInterval);
    }
  };

  _pollingTimer = setTimeout(tick, _pollingInterval);
}

function stopPolling() {
  if (_pollingTimer) {
    clearTimeout(_pollingTimer);
    _pollingTimer = null;
  }
}

async function restartPolling() {
  await startPolling();
}

// ── Datei-Operationen (Löschen, Umbenennen, Verschieben, Ordner erstellen) ──

/**
 * Relativen Pfad normalisieren und auf Path-Traversal prüfen.
 * Gibt null zurück wenn der Pfad ungültig ist.
 */
function normalizeRelPath(input) {
  if (input === null || input === undefined) return '';
  const raw = String(input).replace(/\\/g, '/').trim();
  if (!raw || raw === '.') return '';
  if (raw.startsWith('/')) return null;
  const normalized = path.posix.normalize(raw);
  if (normalized.startsWith('..')) return null;
  if (normalized === '.') return '';
  return normalized;
}

function makeError(msg, code) {
  const err = new Error(msg);
  err.statusCode = code;
  return err;
}

/**
 * Datei oder Ordner löschen. Aktualisiert DB-Einträge.
 */
async function deleteEntry(relPath) {
  const rawDir = await getRawDir();
  if (!rawDir) throw makeError('Kein RAW-Verzeichnis konfiguriert.', 400);

  const rel = normalizeRelPath(relPath);
  if (rel === null || rel === '') throw makeError('Ungültiger oder leerer Pfad (Root kann nicht gelöscht werden).', 400);

  const absPath = path.join(rawDir, rel);
  // Traversal-Schutz
  if (!absPath.startsWith(rawDir + path.sep)) throw makeError('Pfad außerhalb des RAW-Verzeichnisses.', 400);

  const db = await getDb();
  const entry = await db.get(`SELECT job_id FROM converter_scan_entries WHERE rel_path = ?`, [rel]);
  if (entry?.job_id) throw makeError('Eintrag ist einem Job zugewiesen und kann nicht gelöscht werden.', 409);

  if (!fs.existsSync(absPath)) throw makeError(`Pfad existiert nicht: ${rel}`, 404);

  fs.rmSync(absPath, { recursive: true, force: true });

  await db.run(
    `DELETE FROM converter_scan_entries WHERE rel_path = ? OR rel_path LIKE ?`,
    [rel, `${rel}/%`]
  );

  return { deleted: rel };
}

/**
 * Datei oder Ordner umbenennen. Aktualisiert DB-Einträge.
 */
async function renameEntry(relPath, newName) {
  const rawDir = await getRawDir();
  if (!rawDir) throw makeError('Kein RAW-Verzeichnis konfiguriert.', 400);

  const rel = normalizeRelPath(relPath);
  if (rel === null || rel === '') throw makeError('Ungültiger Quellpfad.', 400);

  const safeName = String(newName || '').trim();
  if (!safeName || safeName.includes('/') || safeName.includes('\\') || safeName === '.' || safeName === '..') {
    throw makeError('Ungültiger Name.', 400);
  }

  const parentRel = path.posix.dirname(rel);
  const newRel = (parentRel === '.' || parentRel === '') ? safeName : `${parentRel}/${safeName}`;

  const absOld = path.join(rawDir, rel);
  const absNew = path.join(rawDir, newRel);

  if (!absOld.startsWith(rawDir + path.sep)) throw makeError('Quellpfad außerhalb des RAW-Verzeichnisses.', 400);
  if (!absNew.startsWith(rawDir + path.sep)) throw makeError('Zielpfad außerhalb des RAW-Verzeichnisses.', 400);

  const db = await getDb();
  const entry = await db.get(`SELECT job_id FROM converter_scan_entries WHERE rel_path = ?`, [rel]);
  if (entry?.job_id) throw makeError('Eintrag ist einem Job zugewiesen und kann nicht umbenannt werden.', 409);

  if (!fs.existsSync(absOld)) throw makeError('Quelle nicht gefunden.', 404);
  if (fs.existsSync(absNew)) throw makeError('Ziel existiert bereits.', 409);

  fs.renameSync(absOld, absNew);

  const rows = await db.all(
    `SELECT rel_path FROM converter_scan_entries WHERE rel_path = ? OR rel_path LIKE ?`,
    [rel, `${rel}/%`]
  );
  for (const row of rows) {
    const updatedRel = newRel + row.rel_path.slice(rel.length);
    await db.run(`UPDATE converter_scan_entries SET rel_path = ? WHERE rel_path = ?`, [updatedRel, row.rel_path]);
  }

  return { oldRelPath: rel, newRelPath: newRel };
}

/**
 * Datei oder Ordner in ein anderes Verzeichnis verschieben. Aktualisiert DB-Einträge.
 */
async function moveEntry(relPath, targetParentRelPath) {
  const rawDir = await getRawDir();
  if (!rawDir) throw makeError('Kein RAW-Verzeichnis konfiguriert.', 400);

  const rel = normalizeRelPath(relPath);
  if (rel === null || rel === '') throw makeError('Ungültiger Quellpfad.', 400);

  const targetParentRel = normalizeRelPath(targetParentRelPath != null ? targetParentRelPath : '');
  if (targetParentRel === null) throw makeError('Ungültiger Zielpfad.', 400);

  const name = path.posix.basename(rel);
  const newRel = targetParentRel === '' ? name : `${targetParentRel}/${name}`;

  if (rel === newRel) throw makeError('Quelle und Ziel sind identisch.', 400);
  if (newRel.startsWith(`${rel}/`)) throw makeError('Kann nicht in eigenen Unterordner verschoben werden.', 400);

  const absOld = path.join(rawDir, rel);
  const absNew = path.join(rawDir, newRel);

  if (!absOld.startsWith(rawDir + path.sep)) throw makeError('Quellpfad außerhalb des RAW-Verzeichnisses.', 400);
  if (!absNew.startsWith(rawDir + path.sep) && absNew !== rawDir) throw makeError('Zielpfad außerhalb des RAW-Verzeichnisses.', 400);

  const db = await getDb();
  const entry = await db.get(`SELECT job_id FROM converter_scan_entries WHERE rel_path = ?`, [rel]);
  if (entry?.job_id) throw makeError('Eintrag ist einem Job zugewiesen und kann nicht verschoben werden.', 409);

  if (!fs.existsSync(absOld)) throw makeError('Quelle nicht gefunden.', 404);
  if (fs.existsSync(absNew)) throw makeError('Ziel existiert bereits.', 409);

  fs.renameSync(absOld, absNew);

  const rows = await db.all(
    `SELECT rel_path FROM converter_scan_entries WHERE rel_path = ? OR rel_path LIKE ?`,
    [rel, `${rel}/%`]
  );
  for (const row of rows) {
    const updatedRel = newRel + row.rel_path.slice(rel.length);
    await db.run(`UPDATE converter_scan_entries SET rel_path = ? WHERE rel_path = ?`, [updatedRel, row.rel_path]);
  }

  return { oldRelPath: rel, newRelPath: newRel, targetParentRelPath: targetParentRel };
}

/**
 * Neuen Ordner erstellen (kein DB-Eintrag — erscheint beim nächsten Scan).
 */
async function createFolder(parentRelPath, name) {
  const rawDir = await getRawDir();
  if (!rawDir) throw makeError('Kein RAW-Verzeichnis konfiguriert.', 400);

  const parentRel = normalizeRelPath(parentRelPath != null ? parentRelPath : '');
  if (parentRel === null) throw makeError('Ungültiger übergeordneter Pfad.', 400);

  const safeName = String(name || '').trim();
  if (!safeName || safeName.includes('/') || safeName.includes('\\') || safeName === '.' || safeName === '..') {
    throw makeError('Ungültiger Ordnername.', 400);
  }

  const newRel = parentRel === '' ? safeName : `${parentRel}/${safeName}`;
  const absPath = path.join(rawDir, newRel);

  if (!absPath.startsWith(rawDir + path.sep)) throw makeError('Pfad außerhalb des RAW-Verzeichnisses.', 400);
  if (fs.existsSync(absPath)) throw makeError('Ordner existiert bereits.', 409);

  fs.mkdirSync(absPath, { recursive: true });

  return { relPath: newRel };
}

// ── Reines FS-Baum-Listing (keine DB) ─────────────────────────────────────

const TREE_MAX_DEPTH = 8;

function buildRawTree(rawDir, relPath, depth, assignments = new Map()) {
  if (depth >= TREE_MAX_DEPTH) return [];
  const absDir = relPath ? path.join(rawDir, relPath) : rawDir;
  let dirents;
  try {
    dirents = fs.readdirSync(absDir, { withFileTypes: true });
  } catch (_) {
    return [];
  }

  dirents.sort((a, b) => {
    const ad = a.isDirectory() ? 0 : 1;
    const bd = b.isDirectory() ? 0 : 1;
    if (ad !== bd) return ad - bd;
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });

  const nodes = [];
  for (const dirent of dirents) {
    // Versteckte Einträge überspringen
    if (dirent.name.startsWith('.')) continue;
    const childRel = relPath ? `${relPath}/${dirent.name}` : dirent.name;
    if (dirent.isDirectory()) {
      const children = buildRawTree(rawDir, childRel, depth + 1, assignments);
      const size = children.reduce((s, c) => s + (c.size || 0), 0);
      nodes.push({ name: dirent.name, type: 'folder', path: childRel, size, children });
    } else if (dirent.isFile()) {
      let size = 0;
      try { size = fs.statSync(path.join(rawDir, childRel)).size; } catch (_) {}
      const assignment = assignments.get(childRel) || null;
      nodes.push({
        name: dirent.name,
        type: 'file',
        path: childRel,
        size,
        detectedMediaType: detectMediaType(dirent.name),
        detectedFormat: detectFormat(dirent.name),
        jobId: assignment?.jobId || null,
        jobTitle: assignment?.jobTitle || null,
        jobStatus: assignment?.jobStatus || null
      });
    }
  }
  return nodes;
}

async function getTree() {
  const rawDir = await getRawDir();
  if (!rawDir || !fs.existsSync(rawDir)) {
    return { rawDir: rawDir || null, tree: null };
  }
  const db = await getDb();
  const rows = await db.all(`
    SELECT
      e.rel_path,
      e.job_id,
      j.title AS job_title,
      j.detected_title AS job_detected_title,
      j.status AS job_status
    FROM converter_scan_entries e
    LEFT JOIN jobs j ON j.id = e.job_id
    WHERE e.job_id IS NOT NULL
  `);
  const assignments = new Map();
  for (const row of rows) {
    const rel = String(row?.rel_path || '').trim();
    const jobId = Number(row?.job_id);
    if (!rel || !Number.isFinite(jobId) || jobId <= 0) continue;
    assignments.set(rel, {
      jobId: Math.trunc(jobId),
      jobTitle: String(row?.job_title || row?.job_detected_title || '').trim() || null,
      jobStatus: String(row?.job_status || '').trim() || null
    });
  }
  const children = buildRawTree(rawDir, '', 0, assignments);
  const size = children.reduce((s, c) => s + (c.size || 0), 0);
  return {
    rawDir,
    tree: { name: path.basename(rawDir) || 'raw', type: 'folder', path: '', size, children }
  };
}

module.exports = {
  scan,
  getEntries,
  getEntryById,
  getEntryByRelPath,
  markEntryAsJob,
  setEntryJobAssignment,
  clearEntryJobAssignment,
  clearAssignmentsForJob,
  assignEntriesToJob,
  getRawDir,
  normalizeRelPath,
  getTree,
  startPolling,
  stopPolling,
  restartPolling,
  detectMediaType,
  detectFormat,
  deleteEntry,
  renameEntry,
  moveEntry,
  createFolder
};
