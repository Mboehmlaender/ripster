const { getDb } = require('../db/database');
const logger = require('./logger').child('USER_PRESET');

const VALID_MEDIA_TYPES = new Set(['bluray', 'dvd', 'other', 'all']);

function normalizeMediaType(value) {
  const v = String(value || '').trim().toLowerCase();
  return VALID_MEDIA_TYPES.has(v) ? v : 'all';
}

function rowToPreset(row) {
  if (!row) {
    return null;
  }
  return {
    id: row.id,
    name: row.name,
    mediaType: row.media_type,
    handbrakePreset: row.handbrake_preset || null,
    extraArgs: row.extra_args || null,
    description: row.description || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

async function listPresets(mediaType = null) {
  const db = await getDb();
  let rows;
  if (mediaType && VALID_MEDIA_TYPES.has(mediaType)) {
    rows = await db.all(
      `SELECT * FROM user_presets WHERE media_type = ? OR media_type = 'all' ORDER BY name ASC`,
      [mediaType]
    );
  } else {
    rows = await db.all(`SELECT * FROM user_presets ORDER BY media_type ASC, name ASC`);
  }
  return rows.map(rowToPreset);
}

async function getPresetById(id) {
  const db = await getDb();
  const row = await db.get(`SELECT * FROM user_presets WHERE id = ? LIMIT 1`, [id]);
  return rowToPreset(row);
}

async function createPreset(payload) {
  const name = String(payload?.name || '').trim();
  if (!name) {
    const error = new Error('Preset-Name darf nicht leer sein.');
    error.statusCode = 400;
    throw error;
  }

  const mediaType = normalizeMediaType(payload?.mediaType);
  const handbrakePreset = String(payload?.handbrakePreset || '').trim() || null;
  const extraArgs = String(payload?.extraArgs || '').trim() || null;
  const description = String(payload?.description || '').trim() || null;

  const db = await getDb();
  const result = await db.run(
    `INSERT INTO user_presets (name, media_type, handbrake_preset, extra_args, description)
     VALUES (?, ?, ?, ?, ?)`,
    [name, mediaType, handbrakePreset, extraArgs, description]
  );

  const preset = await getPresetById(result.lastID);
  logger.info('create', { id: preset.id, name: preset.name, mediaType: preset.mediaType });
  return preset;
}

async function updatePreset(id, payload) {
  const db = await getDb();
  const existing = await getPresetById(id);
  if (!existing) {
    const error = new Error(`Preset ${id} nicht gefunden.`);
    error.statusCode = 404;
    throw error;
  }

  const name = payload?.name !== undefined ? String(payload.name || '').trim() : existing.name;
  if (!name) {
    const error = new Error('Preset-Name darf nicht leer sein.');
    error.statusCode = 400;
    throw error;
  }

  const mediaType = payload?.mediaType !== undefined
    ? normalizeMediaType(payload.mediaType)
    : existing.mediaType;
  const handbrakePreset = payload?.handbrakePreset !== undefined
    ? (String(payload.handbrakePreset || '').trim() || null)
    : existing.handbrakePreset;
  const extraArgs = payload?.extraArgs !== undefined
    ? (String(payload.extraArgs || '').trim() || null)
    : existing.extraArgs;
  const description = payload?.description !== undefined
    ? (String(payload.description || '').trim() || null)
    : existing.description;

  await db.run(
    `UPDATE user_presets
     SET name = ?, media_type = ?, handbrake_preset = ?, extra_args = ?, description = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [name, mediaType, handbrakePreset, extraArgs, description, id]
  );

  const updated = await getPresetById(id);
  logger.info('update', { id: updated.id, name: updated.name });
  return updated;
}

async function deletePreset(id) {
  const db = await getDb();
  const existing = await getPresetById(id);
  if (!existing) {
    const error = new Error(`Preset ${id} nicht gefunden.`);
    error.statusCode = 404;
    throw error;
  }

  await db.run(`DELETE FROM user_presets WHERE id = ?`, [id]);
  logger.info('delete', { id: existing.id, name: existing.name });
  return existing;
}

module.exports = {
  listPresets,
  getPresetById,
  createPreset,
  updatePreset,
  deletePreset
};
