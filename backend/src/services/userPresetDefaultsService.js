const { getDb } = require('../db/database');
const logger = require('./logger').child('USER_PRESET_DEFAULTS');

const SLOT_KEYS = Object.freeze([
  'bluray_movie',
  'bluray_series',
  'dvd_movie',
  'dvd_series'
]);
const SLOT_KEY_SET = new Set(SLOT_KEYS);
const SLOT_ALLOWED_MEDIA_TYPES = Object.freeze({
  bluray_movie: new Set(['bluray', 'all']),
  bluray_series: new Set(['bluray', 'all']),
  dvd_movie: new Set(['dvd', 'all']),
  dvd_series: new Set(['dvd', 'all'])
});

function normalizePresetId(value) {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'string' && value.trim() === '') {
    return null;
  }
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return null;
  }
  return Math.trunc(numeric);
}

function buildDefaultsMap(rows = []) {
  const map = Object.fromEntries(SLOT_KEYS.map((key) => [key, null]));
  for (const row of rows) {
    const slotKey = String(row?.slot_key || '').trim();
    if (!SLOT_KEY_SET.has(slotKey)) {
      continue;
    }
    const presetId = normalizePresetId(row?.preset_id);
    map[slotKey] = presetId;
  }
  return map;
}

async function listDefaults() {
  const db = await getDb();
  const rows = await db.all(
    `
      SELECT slot_key, preset_id
      FROM user_preset_defaults
      WHERE slot_key IN (${SLOT_KEYS.map(() => '?').join(', ')})
      ORDER BY slot_key ASC
    `,
    SLOT_KEYS
  );
  return buildDefaultsMap(rows);
}

async function updateDefaults(payload = {}) {
  const defaults = payload && typeof payload === 'object'
    ? (payload.defaults && typeof payload.defaults === 'object' ? payload.defaults : payload)
    : {};
  const updates = [];

  for (const [slotKey, rawPresetId] of Object.entries(defaults)) {
    if (!SLOT_KEY_SET.has(slotKey)) {
      const error = new Error(`Ungültiger Slot: ${slotKey}`);
      error.statusCode = 400;
      throw error;
    }
    updates.push({ slotKey, presetId: normalizePresetId(rawPresetId) });
  }

  if (updates.length === 0) {
    return listDefaults();
  }

  const db = await getDb();
  for (const update of updates) {
    if (update.presetId === null) {
      continue;
    }
    const exists = await db.get(
      `SELECT id, media_type FROM user_presets WHERE id = ? LIMIT 1`,
      [update.presetId]
    );
    if (!exists) {
      const error = new Error(`Preset ${update.presetId} nicht gefunden.`);
      error.statusCode = 404;
      throw error;
    }
    const mediaType = String(exists.media_type || '').trim().toLowerCase();
    const allowedMediaTypes = SLOT_ALLOWED_MEDIA_TYPES[update.slotKey] || new Set(['all']);
    if (!allowedMediaTypes.has(mediaType)) {
      const error = new Error(
        `Preset ${update.presetId} (${mediaType || 'unbekannt'}) ist für ${update.slotKey} nicht zulässig.`
      );
      error.statusCode = 400;
      throw error;
    }
  }

  await db.exec('BEGIN');
  try {
    for (const update of updates) {
      await db.run(
        `
          INSERT INTO user_preset_defaults (slot_key, preset_id)
          VALUES (?, ?)
          ON CONFLICT(slot_key) DO UPDATE SET preset_id = excluded.preset_id
        `,
        [update.slotKey, update.presetId]
      );
    }
    await db.exec('COMMIT');
  } catch (error) {
    await db.exec('ROLLBACK');
    throw error;
  }

  logger.info('update', {
    updates: updates.map((entry) => ({
      slotKey: entry.slotKey,
      presetId: entry.presetId
    }))
  });
  return listDefaults();
}

module.exports = {
  SLOT_KEYS,
  listDefaults,
  updateDefaults
};
