const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { getDb } = require('../db/database');
const logger = require('./logger').child('SETTINGS');
const {
  parseJson,
  normalizeValueByType,
  serializeValueByType,
  validateSetting
} = require('../utils/validators');
const { splitArgs } = require('../utils/commandLine');
const { setLogRootDir } = require('./logPathService');

const DEFAULT_AUDIO_COPY_MASK = ['copy:aac', 'copy:ac3', 'copy:eac3', 'copy:truehd', 'copy:dts', 'copy:dtshd', 'copy:mp3', 'copy:flac'];
const HANDBRAKE_PRESET_LIST_TIMEOUT_MS = 30000;
const SENSITIVE_SETTING_KEYS = new Set([
  'makemkv_registration_key',
  'omdb_api_key',
  'pushover_token',
  'pushover_user'
]);
const AUDIO_SELECTION_KEYS_WITH_VALUE = new Set(['-a', '--audio', '--audio-lang-list']);
const AUDIO_SELECTION_KEYS_FLAG_ONLY = new Set(['--all-audio', '--first-audio']);
const SUBTITLE_SELECTION_KEYS_WITH_VALUE = new Set(['-s', '--subtitle', '--subtitle-lang-list']);
const SUBTITLE_SELECTION_KEYS_FLAG_ONLY = new Set(['--all-subtitles', '--first-subtitle']);
const SUBTITLE_FLAG_KEYS_WITH_VALUE = new Set(['--subtitle-burned', '--subtitle-default', '--subtitle-forced']);
const TITLE_SELECTION_KEYS_WITH_VALUE = new Set(['-t', '--title']);
const LOG_DIR_SETTING_KEY = 'log_dir';
const MEDIA_PROFILES = ['bluray', 'dvd', 'other'];
const PROFILED_SETTINGS = {
  raw_dir: {
    bluray: 'raw_dir_bluray',
    dvd: 'raw_dir_dvd',
    other: 'raw_dir_other'
  },
  raw_dir_owner: {
    bluray: 'raw_dir_bluray_owner',
    dvd: 'raw_dir_dvd_owner',
    other: 'raw_dir_other_owner'
  },
  movie_dir: {
    bluray: 'movie_dir_bluray',
    dvd: 'movie_dir_dvd',
    other: 'movie_dir_other'
  },
  movie_dir_owner: {
    bluray: 'movie_dir_bluray_owner',
    dvd: 'movie_dir_dvd_owner',
    other: 'movie_dir_other_owner'
  },
  mediainfo_extra_args: {
    bluray: 'mediainfo_extra_args_bluray',
    dvd: 'mediainfo_extra_args_dvd'
  },
  makemkv_rip_mode: {
    bluray: 'makemkv_rip_mode_bluray',
    dvd: 'makemkv_rip_mode_dvd'
  },
  makemkv_analyze_extra_args: {
    bluray: 'makemkv_analyze_extra_args_bluray',
    dvd: 'makemkv_analyze_extra_args_dvd'
  },
  makemkv_rip_extra_args: {
    bluray: 'makemkv_rip_extra_args_bluray',
    dvd: 'makemkv_rip_extra_args_dvd'
  },
  handbrake_preset: {
    bluray: 'handbrake_preset_bluray',
    dvd: 'handbrake_preset_dvd'
  },
  handbrake_extra_args: {
    bluray: 'handbrake_extra_args_bluray',
    dvd: 'handbrake_extra_args_dvd'
  },
  output_extension: {
    bluray: 'output_extension_bluray',
    dvd: 'output_extension_dvd'
  },
  filename_template: {
    bluray: 'filename_template_bluray',
    dvd: 'filename_template_dvd'
  },
  output_folder_template: {
    bluray: 'output_folder_template_bluray',
    dvd: 'output_folder_template_dvd'
  }
};
const STRICT_PROFILE_ONLY_SETTING_KEYS = new Set([
  'raw_dir',
  'raw_dir_owner',
  'movie_dir',
  'movie_dir_owner'
]);

function applyRuntimeLogDirSetting(rawValue) {
  const resolved = setLogRootDir(rawValue);
  try {
    fs.mkdirSync(resolved, { recursive: true });
    return resolved;
  } catch (error) {
    const fallbackResolved = setLogRootDir(null);
    try {
      fs.mkdirSync(fallbackResolved, { recursive: true });
    } catch (_fallbackError) {
      // ignore fallback fs errors here; logger may still print to console
    }
    logger.warn('setting:log-dir:fallback', {
      configured: String(rawValue || '').trim() || null,
      resolved,
      fallbackResolved,
      error: error?.message || String(error)
    });
    return fallbackResolved;
  }
}

function normalizeTrackIds(rawList) {
  const list = Array.isArray(rawList) ? rawList : [];
  const seen = new Set();
  const output = [];
  for (const item of list) {
    const value = Number(item);
    if (!Number.isFinite(value) || value <= 0) {
      continue;
    }
    const normalized = String(Math.trunc(value));
    if (seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    output.push(normalized);
  }
  return output;
}

function normalizeNonNegativeInteger(rawValue) {
  if (rawValue === null || rawValue === undefined) {
    return null;
  }
  if (typeof rawValue === 'string' && rawValue.trim() === '') {
    return null;
  }
  const value = Number(rawValue);
  if (!Number.isFinite(value) || value < 0) {
    return null;
  }
  return Math.trunc(value);
}

function removeSelectionArgs(extraArgs) {
  const args = Array.isArray(extraArgs) ? extraArgs : [];
  const filtered = [];

  for (let i = 0; i < args.length; i += 1) {
    const token = String(args[i] || '');
    const key = token.includes('=') ? token.slice(0, token.indexOf('=')) : token;

    const isAudioWithValue = AUDIO_SELECTION_KEYS_WITH_VALUE.has(key);
    const isAudioFlagOnly = AUDIO_SELECTION_KEYS_FLAG_ONLY.has(key);
    const isSubtitleWithValue = SUBTITLE_SELECTION_KEYS_WITH_VALUE.has(key)
      || SUBTITLE_FLAG_KEYS_WITH_VALUE.has(key);
    const isSubtitleFlagOnly = SUBTITLE_SELECTION_KEYS_FLAG_ONLY.has(key);
    const isTitleWithValue = TITLE_SELECTION_KEYS_WITH_VALUE.has(key);
    const skip = isAudioWithValue || isAudioFlagOnly || isSubtitleWithValue || isSubtitleFlagOnly || isTitleWithValue;

    if (!skip) {
      filtered.push(token);
      continue;
    }

    if ((isAudioWithValue || isSubtitleWithValue || isTitleWithValue) && !token.includes('=')) {
      const nextToken = String(args[i + 1] || '');
      if (nextToken && !nextToken.startsWith('-')) {
        i += 1;
      }
    }
  }

  return filtered;
}

function flattenPresetList(input, output = []) {
  const list = Array.isArray(input) ? input : [];
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }
    if (Array.isArray(entry.ChildrenArray) && entry.ChildrenArray.length > 0) {
      flattenPresetList(entry.ChildrenArray, output);
      continue;
    }
    output.push(entry);
  }
  return output;
}

function buildFallbackPresetProfile(presetName, message = null) {
  return {
    source: 'fallback',
    message,
    presetName: presetName || null,
    audioTrackSelectionBehavior: 'first',
    audioLanguages: [],
    audioEncoders: [],
    audioCopyMask: DEFAULT_AUDIO_COPY_MASK,
    audioFallback: 'av_aac',
    subtitleTrackSelectionBehavior: 'none',
    subtitleLanguages: [],
    subtitleBurnBehavior: 'none'
  };
}

function stripAnsiEscapeCodes(value) {
  return String(value || '').replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
}

function uniqueOrderedValues(values) {
  const unique = [];
  const seen = new Set();
  for (const value of values || []) {
    const normalized = String(value || '').trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    unique.push(normalized);
  }
  return unique;
}

function uniquePresetEntries(entries) {
  const unique = [];
  const seenNames = new Set();
  for (const entry of entries || []) {
    const name = String(entry?.name || '').trim();
    if (!name || seenNames.has(name)) {
      continue;
    }
    seenNames.add(name);
    const categoryRaw = entry?.category;
    const category = categoryRaw === null || categoryRaw === undefined
      ? null
      : String(categoryRaw).trim() || null;
    unique.push({ name, category });
  }
  return unique;
}

function normalizeMediaProfileValue(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) {
    return null;
  }
  if (
    raw === 'bluray'
    || raw === 'blu-ray'
    || raw === 'blu_ray'
    || raw === 'bd'
    || raw === 'bdmv'
    || raw === 'bdrom'
    || raw === 'bd-rom'
    || raw === 'bd-r'
    || raw === 'bd-re'
  ) {
    return 'bluray';
  }
  if (
    raw === 'dvd'
    || raw === 'dvdvideo'
    || raw === 'dvd-video'
    || raw === 'dvdrom'
    || raw === 'dvd-rom'
    || raw === 'video_ts'
    || raw === 'iso9660'
  ) {
    return 'dvd';
  }
  if (raw === 'disc' || raw === 'other' || raw === 'sonstiges' || raw === 'cd') {
    return 'other';
  }
  return null;
}

function resolveProfileFallbackOrder(profile) {
  const normalized = normalizeMediaProfileValue(profile);
  if (normalized === 'bluray') {
    return ['bluray', 'dvd'];
  }
  if (normalized === 'dvd') {
    return ['dvd', 'bluray'];
  }
  if (normalized === 'other') {
    return ['dvd', 'bluray'];
  }
  return ['dvd', 'bluray'];
}

function hasUsableProfileSpecificValue(value) {
  if (value === null || value === undefined) {
    return false;
  }
  if (typeof value === 'string') {
    return value.trim().length > 0;
  }
  return true;
}

function normalizePresetListLines(rawOutput) {
  const lines = String(rawOutput || '').split(/\r?\n/);
  const normalized = [];

  for (const line of lines) {
    const sanitized = stripAnsiEscapeCodes(line || '').replace(/\r/g, '');
    if (!sanitized.trim()) {
      continue;
    }
    if (/^\s*\[[^\]]+\]/.test(sanitized)) {
      continue;
    }
    if (
      /^\s*(Cannot load|Compile-time|qsv:|HandBrake \d|Opening |No title found|libhb:|hb_init:|thread |bdj\.c:|stream:|scan:|bd:|libdvdnav:|libdvdread:)/i
        .test(sanitized)
    ) {
      continue;
    }
    if (/^\s*HandBrake has exited\.?\s*$/i.test(sanitized)) {
      continue;
    }
    const leadingWhitespace = (sanitized.match(/^[\t ]*/) || [''])[0];
    const indentation = leadingWhitespace.replace(/\t/g, '    ').length;
    const text = sanitized.trim();
    normalized.push({ indentation, text });
  }

  return normalized;
}

function parsePlusTreePresetEntries(lines) {
  const plusEntries = [];
  for (const line of lines || []) {
    const match = String(line?.text || '').match(/^\+\s+(.+?)\s*$/);
    if (!match) {
      continue;
    }
    plusEntries.push({
      indentation: Number(line?.indentation || 0),
      name: String(match[1] || '').trim()
    });
  }

  if (plusEntries.length === 0) {
    return [];
  }

  const leafEntries = [];
  for (let index = 0; index < plusEntries.length; index += 1) {
    const current = plusEntries[index];
    const next = plusEntries[index + 1];
    const hasChildren = Boolean(next) && next.indentation > current.indentation;
    if (!hasChildren) {
      let category = null;
      for (let parentIndex = index - 1; parentIndex >= 0; parentIndex -= 1) {
        const candidate = plusEntries[parentIndex];
        if (candidate.indentation < current.indentation) {
          category = candidate.name || null;
          break;
        }
      }
      leafEntries.push({
        name: current.name,
        category
      });
    }
  }

  return uniquePresetEntries(leafEntries);
}

function parseSlashTreePresetEntries(lines) {
  const list = Array.isArray(lines) ? lines : [];
  const presetEntries = [];
  let currentCategoryIndent = null;
  let currentCategoryName = null;
  let currentPresetIndent = null;

  for (const line of list) {
    const indentation = Number(line?.indentation || 0);
    const text = String(line?.text || '').trim();
    if (!text) {
      continue;
    }

    if (text.endsWith('/')) {
      currentCategoryIndent = indentation;
      currentCategoryName = String(text.slice(0, -1) || '').trim() || null;
      currentPresetIndent = null;
      continue;
    }

    if (currentCategoryIndent === null) {
      continue;
    }

    if (indentation <= currentCategoryIndent) {
      currentCategoryIndent = null;
      currentCategoryName = null;
      currentPresetIndent = null;
      continue;
    }

    if (currentPresetIndent === null) {
      currentPresetIndent = indentation;
    }

    if (indentation === currentPresetIndent) {
      presetEntries.push({
        name: text,
        category: currentCategoryName
      });
    }
  }

  return uniquePresetEntries(presetEntries);
}

function parseHandBrakePresetEntriesFromListOutput(rawOutput) {
  const lines = normalizePresetListLines(rawOutput);
  const plusTreeEntries = parsePlusTreePresetEntries(lines);
  if (plusTreeEntries.length > 0) {
    return plusTreeEntries;
  }
  return parseSlashTreePresetEntries(lines);
}

function mapPresetEntriesToOptions(entries) {
  const list = Array.isArray(entries) ? entries : [];
  const options = [];
  const seenCategories = new Set();
  const INDENT = '\u00A0\u00A0\u00A0';

  for (const entry of list) {
    const name = String(entry?.name || '').trim();
    if (!name) {
      continue;
    }
    const category = entry?.category ? String(entry.category).trim() : '';
    if (category && !seenCategories.has(category)) {
      seenCategories.add(category);
      options.push({
        label: `${category}/`,
        value: `__group__${category.toLowerCase().replace(/\s+/g, '_')}`,
        disabled: true,
        category
      });
    }
    options.push({
      label: category ? `${INDENT}${name}` : name,
      value: name,
      category: category || null
    });
  }

  return options;
}

class SettingsService {
  async getSchemaRows() {
    const db = await getDb();
    return db.all('SELECT * FROM settings_schema ORDER BY category ASC, order_index ASC');
  }

  async getSettingsMap() {
    const rows = await this.getFlatSettings();
    const map = {};

    for (const row of rows) {
      map[row.key] = row.value;
    }

    return map;
  }

  normalizeMediaProfile(value) {
    return normalizeMediaProfileValue(value);
  }

  resolveEffectiveToolSettings(settingsMap = {}, mediaProfile = null) {
    const sourceMap = settingsMap && typeof settingsMap === 'object' ? settingsMap : {};
    const normalizedRequestedProfile = normalizeMediaProfileValue(mediaProfile);
    const fallbackOrder = resolveProfileFallbackOrder(normalizedRequestedProfile);
    const resolvedMediaProfile = normalizedRequestedProfile || fallbackOrder[0] || 'dvd';
    const effective = {
      ...sourceMap,
      media_profile: resolvedMediaProfile
    };

    for (const [legacyKey, profileKeys] of Object.entries(PROFILED_SETTINGS)) {
      let resolvedValue = sourceMap[legacyKey];
      if (STRICT_PROFILE_ONLY_SETTING_KEYS.has(legacyKey)) {
        const selectedProfileKey = normalizedRequestedProfile
          ? profileKeys?.[normalizedRequestedProfile]
          : null;
        const selectedProfileValue = selectedProfileKey ? sourceMap[selectedProfileKey] : undefined;
        if (hasUsableProfileSpecificValue(selectedProfileValue)) {
          resolvedValue = selectedProfileValue;
        }
        effective[legacyKey] = resolvedValue;
        continue;
      }
      for (const profile of fallbackOrder) {
        const profileKey = profileKeys?.[profile];
        if (!profileKey) {
          continue;
        }
        if (sourceMap[profileKey] !== undefined) {
          resolvedValue = sourceMap[profileKey];
          break;
        }
      }
      effective[legacyKey] = resolvedValue;
    }

    return effective;
  }

  async getEffectiveSettingsMap(mediaProfile = null) {
    const map = await this.getSettingsMap();
    return this.resolveEffectiveToolSettings(map, mediaProfile);
  }

  async getFlatSettings() {
    const db = await getDb();
    const rows = await db.all(
      `
        SELECT
          s.key,
          s.category,
          s.label,
          s.type,
          s.required,
          s.description,
          s.default_value,
          s.options_json,
          s.validation_json,
          s.order_index,
          v.value as current_value
        FROM settings_schema s
        LEFT JOIN settings_values v ON v.key = s.key
        ORDER BY s.category ASC, s.order_index ASC
      `
    );

    return rows.map((row) => ({
      key: row.key,
      category: row.category,
      label: row.label,
      type: row.type,
      required: Boolean(row.required),
      description: row.description,
      defaultValue: row.default_value,
      options: parseJson(row.options_json, []),
      validation: parseJson(row.validation_json, {}),
      value: normalizeValueByType(row.type, row.current_value ?? row.default_value),
      orderIndex: row.order_index
    }));
  }

  async getCategorizedSettings() {
    const flat = await this.getFlatSettings();
    const byCategory = new Map();

    for (const item of flat) {
      if (!byCategory.has(item.category)) {
        byCategory.set(item.category, []);
      }
      byCategory.get(item.category).push(item);
    }

    return Array.from(byCategory.entries()).map(([category, settings]) => ({
      category,
      settings
    }));
  }

  async setSettingValue(key, rawValue) {
    const db = await getDb();
    const schema = await db.get('SELECT * FROM settings_schema WHERE key = ?', [key]);
    if (!schema) {
      const error = new Error(`Setting ${key} existiert nicht.`);
      error.statusCode = 404;
      throw error;
    }

    const result = validateSetting(schema, rawValue);
    if (!result.valid) {
      const error = new Error(result.errors.join(' '));
      error.statusCode = 400;
      throw error;
    }

    const serializedValue = serializeValueByType(schema.type, result.normalized);

    await db.run(
      `
        INSERT INTO settings_values (key, value, updated_at)
        VALUES (?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(key) DO UPDATE SET
          value = excluded.value,
          updated_at = CURRENT_TIMESTAMP
      `,
      [key, serializedValue]
    );
    logger.info('setting:updated', {
      key,
      value: SENSITIVE_SETTING_KEYS.has(String(key || '').trim().toLowerCase()) ? '[redacted]' : result.normalized
    });
    if (String(key || '').trim().toLowerCase() === LOG_DIR_SETTING_KEY) {
      applyRuntimeLogDirSetting(result.normalized);
    }

    return {
      key,
      value: result.normalized
    };
  }

  async setSettingsBulk(rawPatch) {
    if (!rawPatch || typeof rawPatch !== 'object' || Array.isArray(rawPatch)) {
      const error = new Error('Ungültiger Payload. Erwartet wird ein Objekt mit key/value Paaren.');
      error.statusCode = 400;
      throw error;
    }

    const entries = Object.entries(rawPatch);
    if (entries.length === 0) {
      return [];
    }

    const db = await getDb();
    const schemaRows = await db.all('SELECT * FROM settings_schema');
    const schemaByKey = new Map(schemaRows.map((row) => [row.key, row]));
    const normalizedEntries = [];
    const validationErrors = [];

    for (const [key, rawValue] of entries) {
      const schema = schemaByKey.get(key);
      if (!schema) {
        const error = new Error(`Setting ${key} existiert nicht.`);
        error.statusCode = 404;
        throw error;
      }

      const result = validateSetting(schema, rawValue);
      if (!result.valid) {
        validationErrors.push({
          key,
          message: result.errors.join(' ')
        });
        continue;
      }

      normalizedEntries.push({
        key,
        value: result.normalized,
        serializedValue: serializeValueByType(schema.type, result.normalized)
      });
    }

    if (validationErrors.length > 0) {
      const error = new Error('Mindestens ein Setting ist ungültig.');
      error.statusCode = 400;
      error.details = validationErrors;
      throw error;
    }

    try {
      await db.exec('BEGIN');
      for (const item of normalizedEntries) {
        await db.run(
          `
            INSERT INTO settings_values (key, value, updated_at)
            VALUES (?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(key) DO UPDATE SET
              value = excluded.value,
              updated_at = CURRENT_TIMESTAMP
          `,
          [item.key, item.serializedValue]
        );
      }
      await db.exec('COMMIT');
    } catch (error) {
      await db.exec('ROLLBACK');
      throw error;
    }

    const logDirChange = normalizedEntries.find(
      (item) => String(item?.key || '').trim().toLowerCase() === LOG_DIR_SETTING_KEY
    );
    if (logDirChange) {
      applyRuntimeLogDirSetting(logDirChange.value);
    }

    logger.info('settings:bulk-updated', { count: normalizedEntries.length });
    return normalizedEntries.map((item) => ({
      key: item.key,
      value: item.value
    }));
  }

  async buildMakeMKVAnalyzeConfig(deviceInfo = null, options = {}) {
    const rawMap = options?.settingsMap || await this.getSettingsMap();
    const map = this.resolveEffectiveToolSettings(
      rawMap,
      options?.mediaProfile || deviceInfo?.mediaProfile || null
    );
    const cmd = map.makemkv_command;
    const args = ['-r', 'info', this.resolveSourceArg(map, deviceInfo), ...splitArgs(map.makemkv_analyze_extra_args)];
    logger.debug('cli:makemkv:analyze', { cmd, args, deviceInfo });
    return { cmd, args };
  }

  async buildMakeMKVAnalyzePathConfig(sourcePath, options = {}) {
    const rawMap = options?.settingsMap || await this.getSettingsMap();
    const map = this.resolveEffectiveToolSettings(rawMap, options?.mediaProfile || null);
    const cmd = map.makemkv_command;
    const sourceArg = `file:${sourcePath}`;
    const args = ['-r', 'info', sourceArg, ...splitArgs(map.makemkv_analyze_extra_args)];
    const titleIdRaw = Number(options?.titleId);
    // "makemkvcon info" supports only <source>; title filtering is done in app parser.
    logger.debug('cli:makemkv:analyze:path', {
      cmd,
      args,
      sourcePath,
      requestedTitleId: Number.isFinite(titleIdRaw) && titleIdRaw >= 0 ? Math.trunc(titleIdRaw) : null
    });
    return { cmd, args, sourceArg };
  }

  async buildMakeMKVRipConfig(rawJobDir, deviceInfo = null, options = {}) {
    const rawMap = options?.settingsMap || await this.getSettingsMap();
    const map = this.resolveEffectiveToolSettings(
      rawMap,
      options?.mediaProfile || deviceInfo?.mediaProfile || null
    );
    const cmd = map.makemkv_command;
    const ripMode = String(map.makemkv_rip_mode || 'mkv').trim().toLowerCase() === 'backup'
      ? 'backup'
      : 'mkv';
    const sourceArg = this.resolveSourceArg(map, deviceInfo);
    const rawSelectedTitleId = normalizeNonNegativeInteger(options?.selectedTitleId);
    const parsedExtra = splitArgs(map.makemkv_rip_extra_args);
    let extra = [];
    let baseArgs = [];

    if (ripMode === 'backup') {
      if (parsedExtra.length > 0) {
        logger.warn('cli:makemkv:rip:backup:ignored-extra-args', {
          ignored: parsedExtra
        });
      }
      const normalizedProfile = normalizeMediaProfileValue(options?.mediaProfile || deviceInfo?.mediaProfile || null);
      const isDvd = normalizedProfile === 'dvd';
      if (isDvd) {
        const backupBase = options?.backupOutputBase
          ? path.join(rawJobDir, options.backupOutputBase)
          : rawJobDir;
        baseArgs = ['-r', '--progress=-same', 'backup', '--decrypt', '--noscan', sourceArg, backupBase];
      } else {
        baseArgs = ['-r', '--progress=-same', 'backup', '--decrypt', sourceArg, rawJobDir];
      }
    } else {
      extra = parsedExtra;
      const minLength = Number(map.makemkv_min_length_minutes || 60);
      const hasExplicitTitle = rawSelectedTitleId !== null;
      const targetTitle = hasExplicitTitle ? String(Math.trunc(rawSelectedTitleId)) : 'all';
      if (hasExplicitTitle) {
        baseArgs = [
          '-r', '--progress=-same',
          'mkv',
          sourceArg,
          targetTitle,
          rawJobDir
        ];
      } else {
        baseArgs = [
          '-r', '--progress=-same',
          '--minlength=' + Math.round(minLength * 60),
          'mkv',
          sourceArg,
          targetTitle,
          rawJobDir
        ];
      }
    }
    logger.debug('cli:makemkv:rip', {
      cmd,
      args: [...baseArgs, ...extra],
      ripMode,
      rawJobDir,
      deviceInfo,
      selectedTitleId: ripMode === 'mkv' && Number.isFinite(rawSelectedTitleId) && rawSelectedTitleId >= 0
        ? Math.trunc(rawSelectedTitleId)
        : null
    });
    return { cmd, args: [...baseArgs, ...extra] };
  }

  async buildMakeMKVRegisterConfig() {
    const map = await this.getSettingsMap();
    const registrationKey = String(map.makemkv_registration_key || '').trim();
    if (!registrationKey) {
      return null;
    }

    const cmd = map.makemkv_command || 'makemkvcon';
    const args = ['reg', registrationKey];
    logger.debug('cli:makemkv:register', { cmd, args: ['reg', '<redacted>'] });
    return {
      cmd,
      args,
      argsForLog: ['reg', '<redacted>']
    };
  }

  async buildMediaInfoConfig(inputPath, options = {}) {
    const rawMap = options?.settingsMap || await this.getSettingsMap();
    const map = this.resolveEffectiveToolSettings(rawMap, options?.mediaProfile || null);
    const cmd = map.mediainfo_command || 'mediainfo';
    const baseArgs = ['--Output=JSON'];
    const extra = splitArgs(map.mediainfo_extra_args);
    const args = [...baseArgs, ...extra, inputPath];
    logger.debug('cli:mediainfo', { cmd, args, inputPath });
    return { cmd, args };
  }

  async buildHandBrakeConfig(inputFile, outputFile, options = {}) {
    const rawMap = options?.settingsMap || await this.getSettingsMap();
    const map = this.resolveEffectiveToolSettings(rawMap, options?.mediaProfile || null);
    const cmd = map.handbrake_command;
    const rawTitleId = Number(options?.titleId);
    const selectedTitleId = Number.isFinite(rawTitleId) && rawTitleId > 0
      ? Math.trunc(rawTitleId)
      : null;
    const baseArgs = ['-i', inputFile, '-o', outputFile];
    if (selectedTitleId !== null) {
      baseArgs.push('-t', String(selectedTitleId));
    }
    if (map.handbrake_preset) {
      baseArgs.push('-Z', map.handbrake_preset);
    }
    const extra = splitArgs(map.handbrake_extra_args);
    const rawSelection = options?.trackSelection || null;
    const hasSelection = rawSelection && typeof rawSelection === 'object';

    if (!hasSelection) {
      logger.debug('cli:handbrake', {
        cmd,
        args: [...baseArgs, ...extra],
        inputFile,
        outputFile,
        selectedTitleId
      });
      return { cmd, args: [...baseArgs, ...extra] };
    }

    const audioTrackIds = normalizeTrackIds(rawSelection.audioTrackIds);
    const subtitleTrackIds = normalizeTrackIds(rawSelection.subtitleTrackIds);
    const subtitleBurnTrackId = normalizeTrackIds([rawSelection.subtitleBurnTrackId])[0] || null;
    const subtitleDefaultTrackId = normalizeTrackIds([rawSelection.subtitleDefaultTrackId])[0] || null;
    const subtitleForcedTrackId = normalizeTrackIds([rawSelection.subtitleForcedTrackId])[0] || null;
    const subtitleForcedOnly = Boolean(rawSelection.subtitleForcedOnly);
    const filteredExtra = removeSelectionArgs(extra);
    const overrideArgs = [
      '-a',
      audioTrackIds.length > 0 ? audioTrackIds.join(',') : 'none',
      '-s',
      subtitleTrackIds.length > 0 ? subtitleTrackIds.join(',') : 'none'
    ];
    if (subtitleBurnTrackId !== null) {
      overrideArgs.push(`--subtitle-burned=${subtitleBurnTrackId}`);
    }
    if (subtitleDefaultTrackId !== null) {
      overrideArgs.push(`--subtitle-default=${subtitleDefaultTrackId}`);
    }
    if (subtitleForcedTrackId !== null) {
      overrideArgs.push(`--subtitle-forced=${subtitleForcedTrackId}`);
    } else if (subtitleForcedOnly) {
      overrideArgs.push('--subtitle-forced');
    }
    const args = [...baseArgs, ...filteredExtra, ...overrideArgs];

    logger.debug('cli:handbrake:with-selection', {
      cmd,
      args,
      inputFile,
      outputFile,
      selectedTitleId,
      trackSelection: {
        audioTrackIds,
        subtitleTrackIds,
        subtitleBurnTrackId,
        subtitleDefaultTrackId,
        subtitleForcedTrackId,
        subtitleForcedOnly
      }
    });

    return {
      cmd,
      args,
      trackSelection: {
        audioTrackIds,
        subtitleTrackIds,
        subtitleBurnTrackId,
        subtitleDefaultTrackId,
        subtitleForcedTrackId,
        subtitleForcedOnly
      }
    };
  }

  resolveHandBrakeSourceArg(map, deviceInfo = null) {
    if (map.drive_mode === 'explicit') {
      const device = String(map.drive_device || '').trim();
      if (!device) {
        throw new Error('drive_device ist leer, obwohl drive_mode=explicit gesetzt ist.');
      }
      return device;
    }

    const detectedPath = String(deviceInfo?.path || '').trim();
    if (detectedPath) {
      return detectedPath;
    }

    const configuredPath = String(map.drive_device || '').trim();
    if (configuredPath) {
      return configuredPath;
    }

    return '/dev/sr0';
  }

  async buildHandBrakeScanConfig(deviceInfo = null, options = {}) {
    const rawMap = options?.settingsMap || await this.getSettingsMap();
    const map = this.resolveEffectiveToolSettings(
      rawMap,
      options?.mediaProfile || deviceInfo?.mediaProfile || null
    );
    const cmd = map.handbrake_command || 'HandBrakeCLI';
    const sourceArg = this.resolveHandBrakeSourceArg(map, deviceInfo);
    // Match legacy rip.sh behavior: scan all titles, then decide in app logic.
    const args = ['--scan', '--json', '-i', sourceArg, '-t', '0'];
    logger.debug('cli:handbrake:scan', {
      cmd,
      args,
      deviceInfo
    });
    return { cmd, args, sourceArg };
  }

  async buildHandBrakeScanConfigForInput(inputPath, options = {}) {
    const rawMap = options?.settingsMap || await this.getSettingsMap();
    const map = this.resolveEffectiveToolSettings(rawMap, options?.mediaProfile || null);
    const cmd = map.handbrake_command || 'HandBrakeCLI';
    // RAW backup folders must be scanned as full BD source to get usable title list.
    const rawTitleId = Number(options?.titleId);
    const titleId = Number.isFinite(rawTitleId) && rawTitleId > 0
      ? Math.trunc(rawTitleId)
      : 0;
    const args = ['--scan', '--json', '-i', inputPath, '-t', String(titleId)];
    logger.debug('cli:handbrake:scan:input', {
      cmd,
      args,
      inputPath,
      titleId: titleId > 0 ? titleId : null
    });
    return { cmd, args, sourceArg: inputPath };
  }

  async buildHandBrakePresetProfile(sampleInputPath = null, options = {}) {
    const rawMap = options?.settingsMap || await this.getSettingsMap();
    const map = this.resolveEffectiveToolSettings(rawMap, options?.mediaProfile || null);
    const cmd = map.handbrake_command || 'HandBrakeCLI';
    const presetName = map.handbrake_preset || null;
    const rawTitleId = Number(options?.titleId);
    const presetScanTitleId = Number.isFinite(rawTitleId) && rawTitleId > 0
      ? Math.trunc(rawTitleId)
      : 1;

    if (!presetName) {
      return buildFallbackPresetProfile(null, 'Kein HandBrake-Preset konfiguriert.');
    }

    if (!sampleInputPath || !fs.existsSync(sampleInputPath)) {
      return buildFallbackPresetProfile(
        presetName,
        'Preset-Export übersprungen: kein gültiger Sample-Input für HandBrake-Scan.'
      );
    }

    const exportName = `ripster-export-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
    const exportFile = path.join(os.tmpdir(), `${exportName}.json`);
    const args = [
      '--scan',
      '-i',
      sampleInputPath,
      '-t',
      String(presetScanTitleId),
      '-Z',
      presetName,
      '--preset-export',
      exportName,
      '--preset-export-file',
      exportFile
    ];

    try {
      const result = spawnSync(cmd, args, {
        encoding: 'utf-8',
        timeout: 180000,
        maxBuffer: 10 * 1024 * 1024
      });

      if (result.error) {
        return buildFallbackPresetProfile(
          presetName,
          `Preset-Export fehlgeschlagen: ${result.error.message}`
        );
      }

      if (result.status !== 0) {
        const stderr = String(result.stderr || '').trim();
        const stdout = String(result.stdout || '').trim();
        const tail = stderr || stdout || `exit=${result.status}`;
        return buildFallbackPresetProfile(
          presetName,
          `Preset-Export fehlgeschlagen (${tail.slice(0, 280)})`
        );
      }

      if (!fs.existsSync(exportFile)) {
        return buildFallbackPresetProfile(
          presetName,
          'Preset-Export fehlgeschlagen: Exportdatei wurde nicht erzeugt.'
        );
      }

      const raw = fs.readFileSync(exportFile, 'utf-8');
      const parsed = JSON.parse(raw);
      const presetEntries = flattenPresetList(parsed?.PresetList || []);
      const exported = presetEntries.find((entry) => entry.PresetName === exportName) || presetEntries[0];

      if (!exported) {
        return buildFallbackPresetProfile(
          presetName,
          'Preset-Export fehlgeschlagen: Kein Preset in Exportdatei gefunden.'
        );
      }

      return {
        source: 'preset-export',
        message: null,
        presetName,
        audioTrackSelectionBehavior: exported.AudioTrackSelectionBehavior || 'first',
        audioLanguages: Array.isArray(exported.AudioLanguageList) ? exported.AudioLanguageList : [],
        audioEncoders: Array.isArray(exported.AudioList)
          ? exported.AudioList
            .map((item) => item?.AudioEncoder)
            .filter(Boolean)
          : [],
        audioCopyMask: Array.isArray(exported.AudioCopyMask)
          ? exported.AudioCopyMask
          : DEFAULT_AUDIO_COPY_MASK,
        audioFallback: exported.AudioEncoderFallback || 'av_aac',
        subtitleTrackSelectionBehavior: exported.SubtitleTrackSelectionBehavior || 'none',
        subtitleLanguages: Array.isArray(exported.SubtitleLanguageList) ? exported.SubtitleLanguageList : [],
        subtitleBurnBehavior: exported.SubtitleBurnBehavior || 'none'
      };
    } catch (error) {
      return buildFallbackPresetProfile(
        presetName,
        `Preset-Export Ausnahme: ${error.message}`
      );
    } finally {
      try {
        if (fs.existsSync(exportFile)) {
          fs.unlinkSync(exportFile);
        }
      } catch (_error) {
        // ignore cleanup errors
      }
    }
  }

  resolveSourceArg(map, deviceInfo = null) {
    const mode = map.drive_mode;
    if (mode === 'explicit') {
      const device = map.drive_device;
      if (!device) {
        throw new Error('drive_device ist leer, obwohl drive_mode=explicit gesetzt ist.');
      }
      return `dev:${device}`;
    }

    if (deviceInfo && deviceInfo.index !== undefined && deviceInfo.index !== null) {
      return `disc:${deviceInfo.index}`;
    }

    return `disc:${map.makemkv_source_index ?? 0}`;
  }

  async getHandBrakePresetOptions() {
    const map = await this.getSettingsMap();
    const configuredPresets = uniqueOrderedValues([
      map.handbrake_preset_bluray,
      map.handbrake_preset_dvd,
      map.handbrake_preset
    ]);
    const fallbackOptions = configuredPresets.map((preset) => ({ label: preset, value: preset }));
    const rawCommand = String(map.handbrake_command || 'HandBrakeCLI').trim();
    const commandTokens = splitArgs(rawCommand);
    const cmd = commandTokens[0] || 'HandBrakeCLI';
    const baseArgs = commandTokens.slice(1);
    const args = [...baseArgs, '-z'];

    try {
      const result = spawnSync(cmd, args, {
        encoding: 'utf-8',
        timeout: HANDBRAKE_PRESET_LIST_TIMEOUT_MS,
        maxBuffer: 8 * 1024 * 1024
      });

      if (result.error) {
        return {
          source: 'fallback',
          message: `Preset-Liste konnte nicht geladen werden: ${result.error.message}`,
          options: fallbackOptions
        };
      }

      if (result.status !== 0) {
        const stderr = String(result.stderr || '').trim();
        const stdout = String(result.stdout || '').trim();
        const detail = (stderr || stdout || `exit=${result.status}`).slice(0, 280);
        return {
          source: 'fallback',
          message: `Preset-Liste konnte nicht geladen werden (${detail})`,
          options: fallbackOptions
        };
      }

      const combinedOutput = `${String(result.stdout || '')}\n${String(result.stderr || '')}`;
      const entries = parseHandBrakePresetEntriesFromListOutput(combinedOutput);
      const options = mapPresetEntriesToOptions(entries);
      if (options.length === 0) {
        return {
          source: 'fallback',
          message: 'Preset-Liste konnte aus HandBrakeCLI -z nicht geparst werden.',
          options: fallbackOptions
        };
      }
      if (configuredPresets.length === 0) {
        return {
          source: 'handbrake-cli',
          message: null,
          options
        };
      }

      const missingConfiguredPresets = configuredPresets.filter(
        (preset) => !options.some((option) => option.value === preset)
      );
      if (missingConfiguredPresets.length === 0) {
        return {
          source: 'handbrake-cli',
          message: null,
          options
        };
      }

      return {
        source: 'handbrake-cli',
        message: `Konfigurierte Presets wurden in HandBrakeCLI -z nicht gefunden: ${missingConfiguredPresets.join(', ')}`,
        options: [
          ...missingConfiguredPresets.map((preset) => ({ label: preset, value: preset })),
          ...options
        ]
      };
    } catch (error) {
      return {
        source: 'fallback',
        message: `Preset-Liste konnte nicht geladen werden: ${error.message}`,
        options: fallbackOptions
      };
    }
  }
}

module.exports = new SettingsService();
