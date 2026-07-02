const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { getDb } = require('../db/database');
const loggerService = require('./logger');
const logger = loggerService.child('SETTINGS');
const {
  parseJson,
  normalizeValueByType,
  serializeValueByType,
  validateSetting,
  toBoolean
} = require('../utils/validators');
const { splitArgs } = require('../utils/commandLine');
const { setLogRootDir } = require('./logPathService');
const {
  syncRegistrationKeyToConfig,
  normalizeRegistrationKey
} = require('./makemkvKeyService');

const {
  defaultRawDir: DEFAULT_RAW_DIR,
  defaultMovieDir: DEFAULT_MOVIE_DIR,
  defaultSeriesDir: DEFAULT_SERIES_DIR,
  defaultCdDir: DEFAULT_CD_DIR,
  defaultAudiobookRawDir: DEFAULT_AUDIOBOOK_RAW_DIR,
  defaultAudiobookDir: DEFAULT_AUDIOBOOK_DIR,
  defaultDownloadDir: DEFAULT_DOWNLOAD_DIR,
  defaultConverterRawDir: DEFAULT_CONVERTER_RAW_DIR,
  defaultConverterMovieDir: DEFAULT_CONVERTER_MOVIE_DIR,
  defaultConverterAudioDir: DEFAULT_CONVERTER_AUDIO_DIR,
  tempDir: DEFAULT_TEMP_DIR
} = require('../config');

const DEFAULT_AUDIO_COPY_MASK = ['copy:aac', 'copy:ac3', 'copy:eac3', 'copy:truehd', 'copy:dts', 'copy:dtshd', 'copy:mp3', 'copy:flac'];
const HANDBRAKE_PRESET_LIST_TIMEOUT_MS = 30000;
const SETTINGS_CACHE_TTL_MS = 15000;
const HANDBRAKE_PRESET_CACHE_TTL_MS = 5 * 60 * 1000;
const HANDBRAKE_PRESET_RELEVANT_SETTING_KEYS = new Set([
  'handbrake_command',
  'handbrake_preset',
  'handbrake_preset_bluray',
  'handbrake_preset_dvd'
]);
const SENSITIVE_SETTING_KEYS = new Set([
  'makemkv_registration_key',
  'tmdb_api_read_access_token',
  'pushover_token',
  'pushover_user'
]);
const LEGACY_HIDDEN_SETTING_KEYS = new Set([
  'omdb_api_key',
  'omdb_default_type',
  'omdb_timeout_ms'
]);
const IMMUTABLE_SETTING_KEYS = new Set([
  'makemkv_command',
  'mediainfo_command',
  'handbrake_command',
  'ffmpeg_command',
  'ffprobe_command',
  'cdparanoia_command',
  'mkvmerge_command'
]);
const AUDIO_SELECTION_KEYS_WITH_VALUE = new Set(['-a', '--audio', '--audio-lang-list']);
const AUDIO_SELECTION_KEYS_FLAG_ONLY = new Set(['--all-audio', '--first-audio']);
const SUBTITLE_SELECTION_KEYS_WITH_VALUE = new Set(['-s', '--subtitle', '--subtitle-lang-list']);
const SUBTITLE_SELECTION_KEYS_FLAG_ONLY = new Set(['--all-subtitles', '--first-subtitle']);
const SUBTITLE_FLAG_KEYS_WITH_VALUE = new Set(['--subtitle-burned', '--subtitle-default', '--subtitle-forced']);
const TITLE_SELECTION_KEYS_WITH_VALUE = new Set(['-t', '--title']);
const LOG_DIR_SETTING_KEY = 'log_dir';
const SERVER_CONSOLE_LOG_OUTPUT_ENABLED_KEY = 'server_console_log_output_enabled';
const SERVER_CONSOLE_LOG_HTTP_ENABLED_KEY = 'server_console_log_http_enabled';
const SERVER_CONSOLE_LOG_DEBUG_ENABLED_KEY = 'server_console_log_debug_enabled';
const SERVER_CONSOLE_LOG_INFO_ENABLED_KEY = 'server_console_log_info_enabled';
const SERVER_CONSOLE_LOG_WARN_ENABLED_KEY = 'server_console_log_warn_enabled';
const SERVER_CONSOLE_LOG_ERROR_ENABLED_KEY = 'server_console_log_error_enabled';
const SERVER_CONSOLE_LOG_SETTING_KEYS = new Set([
  SERVER_CONSOLE_LOG_OUTPUT_ENABLED_KEY,
  SERVER_CONSOLE_LOG_HTTP_ENABLED_KEY,
  SERVER_CONSOLE_LOG_DEBUG_ENABLED_KEY,
  SERVER_CONSOLE_LOG_INFO_ENABLED_KEY,
  SERVER_CONSOLE_LOG_WARN_ENABLED_KEY,
  SERVER_CONSOLE_LOG_ERROR_ENABLED_KEY
]);
const MAKEMKV_REGISTRATION_KEY_SETTING_KEY = 'makemkv_registration_key';
const MEDIA_PROFILES = ['bluray', 'dvd', 'cd', 'audiobook'];
const PROFILED_SETTINGS = {
  raw_dir: {
    bluray: 'raw_dir_bluray',
    dvd: 'raw_dir_dvd',
    cd: 'raw_dir_cd',
    audiobook: 'raw_dir_audiobook'
  },
  raw_dir_owner: {
    bluray: 'raw_dir_bluray_owner',
    dvd: 'raw_dir_dvd_owner',
    cd: 'raw_dir_cd_owner',
    audiobook: 'raw_dir_audiobook_owner'
  },
  series_raw_dir: {
    bluray: 'raw_dir_bluray_series',
    dvd: 'raw_dir_dvd_series'
  },
  series_raw_dir_owner: {
    bluray: 'raw_dir_bluray_series_owner',
    dvd: 'raw_dir_dvd_series_owner'
  },
  movie_dir: {
    bluray: 'movie_dir_bluray',
    dvd: 'movie_dir_dvd',
    cd: 'movie_dir_cd',
    audiobook: 'movie_dir_audiobook'
  },
  series_dir: {
    bluray: 'series_dir_bluray',
    dvd: 'series_dir_dvd'
  },
  movie_dir_owner: {
    bluray: 'movie_dir_bluray_owner',
    dvd: 'movie_dir_dvd_owner',
    cd: 'movie_dir_cd_owner',
    audiobook: 'movie_dir_audiobook_owner'
  },
  series_dir_owner: {
    bluray: 'series_dir_bluray_owner',
    dvd: 'series_dir_dvd_owner'
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
  handbrake_review_audio_languages: {
    bluray: 'handbrake_review_audio_languages_bluray',
    dvd: 'handbrake_review_audio_languages_dvd'
  },
  handbrake_review_subtitle_languages: {
    bluray: 'handbrake_review_subtitle_languages_bluray',
    dvd: 'handbrake_review_subtitle_languages_dvd'
  },
  output_extension: {
    bluray: 'output_extension_bluray',
    dvd: 'output_extension_dvd'
  },
  output_template: {
    bluray: 'output_template_bluray',
    dvd: 'output_template_dvd',
    audiobook: 'output_template_audiobook'
  }
};
const STRICT_PROFILE_ONLY_SETTING_KEYS = new Set([
  'raw_dir',
  'raw_dir_owner',
  'series_raw_dir',
  'series_raw_dir_owner',
  'movie_dir',
  'movie_dir_owner',
  'series_dir',
  'series_dir_owner'
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

function normalizeBooleanSetting(rawValue, fallback = true) {
  const normalizedRaw = typeof rawValue === 'string' ? rawValue.trim() : rawValue;
  if (normalizedRaw === null || normalizedRaw === undefined || normalizedRaw === '') {
    return fallback;
  }
  return toBoolean(normalizedRaw);
}

function isHiddenSettingKey(key) {
  const normalized = String(key || '').trim().toLowerCase();
  return LEGACY_HIDDEN_SETTING_KEYS.has(normalized);
}

function applyRuntimeServerConsoleLoggingSettingsFromMap(settingsMap = {}) {
  const source = settingsMap && typeof settingsMap === 'object' ? settingsMap : {};
  const enabled = normalizeBooleanSetting(source[SERVER_CONSOLE_LOG_OUTPUT_ENABLED_KEY], true);
  const http = normalizeBooleanSetting(source[SERVER_CONSOLE_LOG_HTTP_ENABLED_KEY], true);
  const debug = normalizeBooleanSetting(source[SERVER_CONSOLE_LOG_DEBUG_ENABLED_KEY], true);
  const info = normalizeBooleanSetting(source[SERVER_CONSOLE_LOG_INFO_ENABLED_KEY], true);
  const warn = normalizeBooleanSetting(source[SERVER_CONSOLE_LOG_WARN_ENABLED_KEY], true);
  const error = normalizeBooleanSetting(source[SERVER_CONSOLE_LOG_ERROR_ENABLED_KEY], true);
  const applied = loggerService.configureConsoleOutput({
    enabled,
    http,
    levels: {
      debug,
      info,
      warn,
      error
    }
  });
  return applied;
}

function isImmutableSettingKey(key) {
  return IMMUTABLE_SETTING_KEYS.has(String(key || '').trim().toLowerCase());
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

function normalizeTrackIdSequence(rawList, options = {}) {
  const list = Array.isArray(rawList) ? rawList : [];
  const dedupe = options?.dedupe !== false;
  const seen = new Set();
  const output = [];
  for (const item of list) {
    const value = Number(item);
    if (!Number.isFinite(value) || value <= 0) {
      continue;
    }
    const normalized = String(Math.trunc(value));
    if (dedupe && seen.has(normalized)) {
      continue;
    }
    if (dedupe) {
      seen.add(normalized);
    }
    output.push(normalized);
  }
  return output;
}

function normalizePositiveIndexes(rawList, maxValue = null) {
  const values = normalizeTrackIds(rawList)
    .map((item) => Number(item))
    .filter((value) => Number.isFinite(value) && value > 0)
    .map((value) => Math.trunc(value));
  if (!Number.isFinite(maxValue) || maxValue <= 0) {
    return values;
  }
  const limit = Math.trunc(maxValue);
  return values.filter((value) => value <= limit);
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
    const isSubtitleSelectionWithValue = SUBTITLE_SELECTION_KEYS_WITH_VALUE.has(key);
    const isSubtitleFlagWithValue = SUBTITLE_FLAG_KEYS_WITH_VALUE.has(key);
    const isSubtitleWithValue = isSubtitleSelectionWithValue || isSubtitleFlagWithValue;
    const isSubtitleFlagOnly = SUBTITLE_SELECTION_KEYS_FLAG_ONLY.has(key);
    const isTitleWithValue = TITLE_SELECTION_KEYS_WITH_VALUE.has(key);
    const skip = isAudioWithValue || isAudioFlagOnly || isSubtitleWithValue || isSubtitleFlagOnly || isTitleWithValue;

    if (isSubtitleFlagWithValue) {
      const inlineValue = token.includes('=')
        ? token.slice(token.indexOf('=') + 1)
        : '';
      const hasAttachedValue = token.includes('=');
      const nextToken = String(args[i + 1] || '');
      const hasSeparateValue = !hasAttachedValue && nextToken && !nextToken.startsWith('-');
      const candidateValue = String(
        hasAttachedValue
          ? inlineValue
          : (hasSeparateValue ? nextToken : '')
      ).trim().toLowerCase();

      // Keep explicit "none" subtitle flags from extra args.
      // This allows users to intentionally clear subtitle burn/default/forced behavior.
      if (candidateValue === 'none') {
        filtered.push(token);
        if (hasSeparateValue) {
          filtered.push(nextToken);
          i += 1;
        }
        continue;
      }
    }

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

function normalizeSettingKey(value) {
  return String(value || '').trim().toLowerCase();
}

function runCommandCapture(cmd, args = [], options = {}) {
  const timeoutMs = Math.max(0, Number(options.timeout || 0));
  const maxBuffer = Math.max(1024, Number(options.maxBuffer || 8 * 1024 * 1024));
  const argv = Array.isArray(args) ? args : [];

  return new Promise((resolve, reject) => {
    let settled = false;
    let timedOut = false;
    let timer = null;
    let stdout = '';
    let stderr = '';
    let totalBytes = 0;

    const finish = (handler, payload) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      handler(payload);
    };

    const child = spawn(cmd, argv, {
      stdio: ['ignore', 'pipe', 'pipe']
    });

    const appendChunk = (chunk, target) => {
      if (settled) {
        return;
      }
      const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8');
      totalBytes += Buffer.byteLength(text, 'utf-8');
      if (totalBytes > maxBuffer) {
        try {
          child.kill('SIGKILL');
        } catch (_error) {
          // ignore kill errors
        }
        finish(reject, new Error(`Command output exceeded ${maxBuffer} bytes.`));
        return;
      }
      if (target === 'stdout') {
        stdout += text;
      } else {
        stderr += text;
      }
    };

    child.on('error', (error) => finish(reject, error));
    child.on('close', (status, signal) => {
      finish(resolve, {
        status,
        signal,
        timedOut,
        stdout,
        stderr
      });
    });

    if (child.stdout) {
      child.stdout.on('data', (chunk) => appendChunk(chunk, 'stdout'));
    }
    if (child.stderr) {
      child.stderr.on('data', (chunk) => appendChunk(chunk, 'stderr'));
    }

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        try {
          child.kill('SIGKILL');
        } catch (_error) {
          // ignore kill errors
        }
      }, timeoutMs);
    }
  });
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
  if (raw === 'cd' || raw === 'audio_cd') {
    return 'cd';
  }
  if (raw === 'audiobook' || raw === 'audio_book' || raw === 'audio book' || raw === 'book') {
    return 'audiobook';
  }
  return null;
}

function resolveProfileFallbackOrder(profile) {
  const normalized = normalizeMediaProfileValue(profile);
  if (normalized === 'audiobook') {
    return ['audiobook'];
  }
  if (normalized === 'bluray') {
    return ['bluray', 'dvd'];
  }
  if (normalized === 'dvd') {
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

/**
 * Parses the drive_devices JSON setting into a normalized array of {path, makemkvIndex}.
 * Supports both the legacy string format ["/dev/sr0"] and the object format
 * [{"path": "/dev/sr0", "makemkvIndex": 0}].
 * When makemkvIndex is missing, it is assigned by list order (0,1,2,...) so
 * sparse kernel names like /dev/sr2 still map to contiguous MakeMKV indices.
 */
function parseDriveDeviceEntries(raw) {
  try {
    const arr = JSON.parse(raw || '[]');
    if (!Array.isArray(arr)) {
      return [];
    }
    const normalized = arr.map((entry) => {
      if (typeof entry === 'string') {
        const p = entry.trim();
        if (!p) {
          return null;
        }
        return { path: p, makemkvIndex: null };
      }
      if (entry && typeof entry === 'object' && entry.path) {
        const p = String(entry.path || '').trim();
        if (!p) {
          return null;
        }
        const idxRaw = Number(entry.makemkvIndex);
        return {
          path: p,
          makemkvIndex: Number.isFinite(idxRaw) && idxRaw >= 0 ? Math.trunc(idxRaw) : null
        };
      }
      return null;
    }).filter(Boolean);

    const used = new Set();
    let nextAutoIndex = 0;
    return normalized.map((entry) => {
      if (entry.makemkvIndex != null) {
        used.add(entry.makemkvIndex);
        if (entry.makemkvIndex >= nextAutoIndex) {
          nextAutoIndex = entry.makemkvIndex + 1;
        }
        return entry;
      }
      while (used.has(nextAutoIndex)) {
        nextAutoIndex += 1;
      }
      const resolved = {
        path: entry.path,
        makemkvIndex: nextAutoIndex
      };
      used.add(nextAutoIndex);
      nextAutoIndex += 1;
      return resolved;
    });
  } catch (_error) {
    return [];
  }
}

class SettingsService {
  constructor() {
    this.settingsSnapshotCache = {
      expiresAt: 0,
      snapshot: null,
      inFlight: null
    };
    this.handBrakePresetCache = {
      expiresAt: 0,
      cacheKey: null,
      payload: null,
      inFlight: null
    };
  }

  buildSettingsSnapshot(flat = []) {
    const list = Array.isArray(flat) ? flat : [];
    const map = {};
    const byCategory = new Map();

    for (const item of list) {
      map[item.key] = item.value;
      if (!byCategory.has(item.category)) {
        byCategory.set(item.category, []);
      }
      byCategory.get(item.category).push(item);
    }

    return {
      flat: list,
      map,
      categorized: Array.from(byCategory.entries()).map(([category, settings]) => ({
        category,
        settings
      }))
    };
  }

  invalidateHandBrakePresetCache() {
    this.handBrakePresetCache = {
      expiresAt: 0,
      cacheKey: null,
      payload: null,
      inFlight: null
    };
  }

  invalidateSettingsCache(changedKeys = []) {
    this.settingsSnapshotCache = {
      expiresAt: 0,
      snapshot: null,
      inFlight: null
    };
    const normalizedKeys = Array.isArray(changedKeys)
      ? changedKeys.map((key) => normalizeSettingKey(key)).filter(Boolean)
      : [];
    const shouldInvalidatePresets = normalizedKeys.some((key) => HANDBRAKE_PRESET_RELEVANT_SETTING_KEYS.has(key));
    if (shouldInvalidatePresets) {
      this.invalidateHandBrakePresetCache();
    }
  }

  buildHandBrakePresetCacheKey(map = {}) {
    const source = map && typeof map === 'object' ? map : {};
    return JSON.stringify({
      cmd: String(source.handbrake_command || 'HandBrakeCLI').trim(),
      bluray: String(source.handbrake_preset_bluray || '').trim(),
      dvd: String(source.handbrake_preset_dvd || '').trim(),
      fallback: String(source.handbrake_preset || '').trim()
    });
  }

  async getSettingsSnapshot(options = {}) {
    const forceRefresh = Boolean(options?.forceRefresh);
    const now = Date.now();

    if (!forceRefresh && this.settingsSnapshotCache.snapshot && this.settingsSnapshotCache.expiresAt > now) {
      return this.settingsSnapshotCache.snapshot;
    }
    if (!forceRefresh && this.settingsSnapshotCache.inFlight) {
      return this.settingsSnapshotCache.inFlight;
    }

    let loadPromise = null;
    loadPromise = (async () => {
      const flat = await this.fetchFlatSettingsFromDb();
      const snapshot = this.buildSettingsSnapshot(flat);
      this.settingsSnapshotCache.snapshot = snapshot;
      this.settingsSnapshotCache.expiresAt = Date.now() + SETTINGS_CACHE_TTL_MS;
      return snapshot;
    })().finally(() => {
      if (this.settingsSnapshotCache.inFlight === loadPromise) {
        this.settingsSnapshotCache.inFlight = null;
      }
    });
    this.settingsSnapshotCache.inFlight = loadPromise;
    return loadPromise;
  }

  async getSchemaRows() {
    const db = await getDb();
    const rows = await db.all('SELECT * FROM settings_schema ORDER BY category ASC, order_index ASC');
    return rows.filter((row) => !isHiddenSettingKey(row?.key));
  }

  async getSettingsMap(options = {}) {
    const snapshot = await this.getSettingsSnapshot(options);
    return { ...(snapshot?.map || {}) };
  }

  applyRuntimeSettingsFromMap(settingsMap = {}) {
    const source = settingsMap && typeof settingsMap === 'object' ? settingsMap : {};
    const logDir = applyRuntimeLogDirSetting(source[LOG_DIR_SETTING_KEY]);
    const consoleLogConfig = applyRuntimeServerConsoleLoggingSettingsFromMap(source);
    return {
      logDir,
      serverConsoleLogConfig: consoleLogConfig
    };
  }

  async applyRuntimeSettings() {
    const map = await this.getSettingsMap();
    return this.applyRuntimeSettingsFromMap(map);
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
        // Fallback to hardcoded install defaults when no setting value is configured
        if (!hasUsableProfileSpecificValue(resolvedValue)) {
          if (legacyKey === 'raw_dir') {
            if (normalizedRequestedProfile === 'cd') {
              resolvedValue = DEFAULT_CD_DIR;
            } else if (normalizedRequestedProfile === 'audiobook') {
              resolvedValue = DEFAULT_AUDIOBOOK_RAW_DIR;
            } else {
              resolvedValue = DEFAULT_RAW_DIR;
            }
          } else if (legacyKey === 'series_dir') {
            resolvedValue = DEFAULT_SERIES_DIR;
          } else if (legacyKey === 'movie_dir') {
            if (normalizedRequestedProfile === 'cd') {
              resolvedValue = DEFAULT_CD_DIR;
            } else if (normalizedRequestedProfile === 'audiobook') {
              resolvedValue = DEFAULT_AUDIOBOOK_DIR;
            } else {
              resolvedValue = DEFAULT_MOVIE_DIR;
            }
          }
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

    effective.download_dir = String(sourceMap.download_dir || '').trim() || DEFAULT_DOWNLOAD_DIR;
    effective.download_dir_owner = String(sourceMap.download_dir_owner || '').trim() || null;

    return effective;
  }

  async getEffectiveSettingsMap(mediaProfile = null) {
    const map = await this.getSettingsMap();
    return this.resolveEffectiveToolSettings(map, mediaProfile);
  }

  async getEffectivePaths() {
    const map = await this.getSettingsMap();
    const bluray = this.resolveEffectiveToolSettings(map, 'bluray');
    const dvd = this.resolveEffectiveToolSettings(map, 'dvd');
    const cd = this.resolveEffectiveToolSettings(map, 'cd');
    const audiobook = this.resolveEffectiveToolSettings(map, 'audiobook');
    return {
      bluray: {
        raw: bluray.raw_dir,
        seriesRaw: bluray.series_raw_dir || bluray.raw_dir,
        movies: bluray.movie_dir,
        series: bluray.series_dir
      },
      dvd: { raw: dvd.raw_dir, seriesRaw: dvd.series_raw_dir || dvd.raw_dir, movies: dvd.movie_dir, series: dvd.series_dir },
      cd: { raw: cd.raw_dir, movies: cd.movie_dir },
      audiobook: { raw: audiobook.raw_dir, movies: audiobook.movie_dir },
      downloads: { path: bluray.download_dir },
      converter: {
        raw: String(map.converter_raw_dir || '').trim() || DEFAULT_CONVERTER_RAW_DIR,
        movies: String(map.converter_movie_dir || '').trim() || DEFAULT_CONVERTER_MOVIE_DIR,
        audio: String(map.converter_audio_dir || '').trim() || DEFAULT_CONVERTER_AUDIO_DIR
      },
      defaults: {
        raw: DEFAULT_RAW_DIR,
        movies: DEFAULT_MOVIE_DIR,
        series: DEFAULT_SERIES_DIR,
        cd: DEFAULT_CD_DIR,
        audiobookRaw: DEFAULT_AUDIOBOOK_RAW_DIR,
        audiobookMovies: DEFAULT_AUDIOBOOK_DIR,
        downloads: DEFAULT_DOWNLOAD_DIR,
        converterRaw: DEFAULT_CONVERTER_RAW_DIR,
        converterMovies: DEFAULT_CONVERTER_MOVIE_DIR,
        converterAudio: DEFAULT_CONVERTER_AUDIO_DIR
      }
    };
  }

  async fetchFlatSettingsFromDb() {
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
          s.depends_on,
          v.value as current_value
        FROM settings_schema s
        LEFT JOIN settings_values v ON v.key = s.key
        ORDER BY s.category ASC, s.order_index ASC
      `
    );

    return rows
      .filter((row) => !isHiddenSettingKey(row?.key))
      .map((row) => ({
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
      orderIndex: row.order_index,
      depends_on: row.depends_on ?? null
      }));
  }

  async getFlatSettings(options = {}) {
    const snapshot = await this.getSettingsSnapshot(options);
    return Array.isArray(snapshot?.flat) ? [...snapshot.flat] : [];
  }

  async getCategorizedSettings(options = {}) {
    const snapshot = await this.getSettingsSnapshot(options);
    return Array.isArray(snapshot?.categorized) ? [...snapshot.categorized] : [];
  }

  async setSettingValue(key, rawValue) {
    if (isImmutableSettingKey(key)) {
      const error = new Error(`Setting ${key} ist schreibgeschützt und kann nicht geändert werden.`);
      error.statusCode = 403;
      throw error;
    }

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
    const normalizedKey = String(key || '').trim().toLowerCase();

    try {
      await db.exec('BEGIN');
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
      if (normalizedKey === MAKEMKV_REGISTRATION_KEY_SETTING_KEY) {
        await syncRegistrationKeyToConfig(result.normalized);
      }
      await db.exec('COMMIT');
    } catch (error) {
      await db.exec('ROLLBACK');
      throw error;
    }
    logger.info('setting:updated', {
      key,
      value: SENSITIVE_SETTING_KEYS.has(String(key || '').trim().toLowerCase()) ? '[redacted]' : result.normalized
    });
    if (normalizedKey === LOG_DIR_SETTING_KEY) {
      applyRuntimeLogDirSetting(result.normalized);
    }
    if (SERVER_CONSOLE_LOG_SETTING_KEYS.has(normalizedKey)) {
      const map = await this.getSettingsMap({ forceRefresh: true });
      applyRuntimeServerConsoleLoggingSettingsFromMap(map);
    }
    this.invalidateSettingsCache([key]);

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
      if (isImmutableSettingKey(key)) {
        validationErrors.push({
          key,
          message: 'Dieses Setting ist schreibgeschützt und kann nicht geändert werden.'
        });
        continue;
      }

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
      error.statusCode = validationErrors.some((item) => String(item?.message || '').includes('schreibgeschützt'))
        ? 403
        : 400;
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
      const makemkvKeyChange = normalizedEntries.find(
        (item) => String(item?.key || '').trim().toLowerCase() === MAKEMKV_REGISTRATION_KEY_SETTING_KEY
      );
      if (makemkvKeyChange) {
        await syncRegistrationKeyToConfig(makemkvKeyChange.value);
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
    const consoleOutputChange = normalizedEntries.find(
      (item) => SERVER_CONSOLE_LOG_SETTING_KEYS.has(String(item?.key || '').trim().toLowerCase())
    );
    if (consoleOutputChange) {
      const map = await this.getSettingsMap({ forceRefresh: true });
      applyRuntimeServerConsoleLoggingSettingsFromMap(map);
    }

    this.invalidateSettingsCache(normalizedEntries.map((item) => item.key));
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
    const extraArgs = splitArgs(map.makemkv_analyze_extra_args);
    const disableMinLengthFilter = Boolean(options?.disableMinLengthFilter);
    const hasExplicitMinLength = extraArgs.some((arg) => /^--minlength(?:=|$)/i.test(String(arg || '').trim()));
    const minLengthMinutes = Number(map.makemkv_min_length_minutes || 0);
    const minLengthSeconds = Number.isFinite(minLengthMinutes) && minLengthMinutes > 0
      ? Math.round(minLengthMinutes * 60)
      : 0;
    const minLengthArgs = (!disableMinLengthFilter && !hasExplicitMinLength && minLengthSeconds > 0)
      ? [`--minlength=${minLengthSeconds}`]
      : [];
    const args = ['-r', ...minLengthArgs, ...extraArgs, 'info', this.resolveSourceArg(map, deviceInfo)];
    logger.debug('cli:makemkv:analyze', { cmd, args, deviceInfo, disableMinLengthFilter });
    return { cmd, args };
  }

  async buildMakeMKVAnalyzePathConfig(sourcePath, options = {}) {
    const rawMap = options?.settingsMap || await this.getSettingsMap();
    const map = this.resolveEffectiveToolSettings(rawMap, options?.mediaProfile || null);
    const cmd = map.makemkv_command;
    const sourceArg = `file:${sourcePath}`;
    const extraArgs = splitArgs(map.makemkv_analyze_extra_args);
    const disableMinLengthFilter = Boolean(options?.disableMinLengthFilter);
    const hasExplicitMinLength = extraArgs.some((arg) => /^--minlength(?:=|$)/i.test(String(arg || '').trim()));
    const minLengthMinutes = Number(map.makemkv_min_length_minutes || 0);
    const minLengthSeconds = Number.isFinite(minLengthMinutes) && minLengthMinutes > 0
      ? Math.round(minLengthMinutes * 60)
      : 0;
    const minLengthArgs = (!disableMinLengthFilter && !hasExplicitMinLength && minLengthSeconds > 0)
      ? [`--minlength=${minLengthSeconds}`]
      : [];
    const args = ['-r', ...minLengthArgs, ...extraArgs, 'info', sourceArg];
    const titleIdRaw = Number(options?.titleId);
    // "makemkvcon info" supports only <source>; title filtering is done in app parser.
    logger.debug('cli:makemkv:analyze:path', {
      cmd,
      args,
      sourcePath,
      disableMinLengthFilter,
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
    const sourceArgOverride = String(options?.sourceArgOverride || '').trim();
    const sourceArg = sourceArgOverride || this.resolveSourceArg(map, deviceInfo);
    const rawSelectedTitleId = normalizeNonNegativeInteger(options?.selectedTitleId);
    const disableMinLengthFilter = Boolean(options?.disableMinLengthFilter);
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
      const minLengthSeconds = Number.isFinite(minLength) && minLength > 0
        ? Math.round(minLength * 60)
        : 0;
      if (hasExplicitTitle) {
        baseArgs = [
          '-r', '--progress=-same',
          '--decrypt',
          'mkv',
          sourceArg,
          targetTitle,
          rawJobDir
        ];
      } else {
        const minLengthArgs = (!disableMinLengthFilter && minLengthSeconds > 0)
          ? [`--minlength=${minLengthSeconds}`]
          : [];
        baseArgs = [
          '-r', '--progress=-same',
          '--decrypt',
          ...minLengthArgs,
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
      disableMinLengthFilter: ripMode === 'mkv' ? disableMinLengthFilter : false,
      selectedTitleId: ripMode === 'mkv' && Number.isFinite(rawSelectedTitleId) && rawSelectedTitleId >= 0
        ? Math.trunc(rawSelectedTitleId)
        : null
    });
    return { cmd, args: [...baseArgs, ...extra] };
  }

  async syncMakeMKVRegistrationKeyFromSettings(options = {}) {
    const map = options?.settingsMap || await this.getSettingsMap();
    const registrationKey = normalizeRegistrationKey(map?.makemkv_registration_key);
    const fileInfo = await syncRegistrationKeyToConfig(registrationKey, options);
    return {
      applied: Boolean(registrationKey),
      key: registrationKey || null,
      path: fileInfo?.path || null,
      changed: Boolean(fileInfo?.changed)
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

    // User preset overrides settings-derived preset and extra args
    const userPreset = options?.userPreset || null;
    const effectiveHandbrakePreset = userPreset !== null
      ? (userPreset.handbrakePreset || null)
      : (map.handbrake_preset || null);
    const effectiveExtraArgs = userPreset !== null
      ? (userPreset.extraArgs || '')
      : (map.handbrake_extra_args || '');

    if (effectiveHandbrakePreset) {
      baseArgs.push('-Z', effectiveHandbrakePreset);
    }
    const extra = splitArgs(effectiveExtraArgs);
    const rawSelection = options?.trackSelection || null;
    const hasSelection = rawSelection && typeof rawSelection === 'object';

    if (!hasSelection) {
      logger.debug('cli:handbrake', {
        cmd,
        args: [...baseArgs, ...extra],
        inputFile,
        outputFile,
        selectedTitleId,
        userPresetId: userPreset?.id || null
      });
      return { cmd, args: [...baseArgs, ...extra] };
    }

    const audioTrackIds = normalizeTrackIds(rawSelection.audioTrackIds);
    const subtitleTrackIds = normalizeTrackIdSequence(rawSelection.subtitleTrackIds, { dedupe: false });
    const subtitleBurnTrackId = normalizeTrackIds([rawSelection.subtitleBurnTrackId])[0] || null;
    const subtitleDefaultTrackId = normalizeTrackIds([rawSelection.subtitleDefaultTrackId])[0] || null;
    const subtitleForcedTrackId = normalizeTrackIds([rawSelection.subtitleForcedTrackId])[0] || null;
    const subtitleForcedTrackIndexes = normalizePositiveIndexes(
      rawSelection.subtitleForcedTrackIndexes,
      subtitleTrackIds.length
    );
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
    if (subtitleForcedTrackIndexes.length > 0) {
      overrideArgs.push(`--subtitle-forced=${subtitleForcedTrackIndexes.join(',')}`);
    } else if (subtitleForcedTrackId !== null) {
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
        subtitleForcedTrackIndexes,
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
        subtitleForcedTrackIndexes,
        subtitleForcedTrackId,
        subtitleForcedOnly
      }
    };
  }

  resolveHandBrakeSourceArg(map, deviceInfo = null) {
    if (map.drive_mode === 'explicit') {
      const entries = parseDriveDeviceEntries(map.drive_devices);
      const firstPath = entries[0]?.path || String(map.drive_device || '').trim();
      if (!firstPath) {
        throw new Error('Kein Laufwerk konfiguriert, obwohl drive_mode=explicit gesetzt ist.');
      }
      return firstPath;
    }

    const detectedPath = String(deviceInfo?.path || '').trim();
    if (detectedPath) {
      return detectedPath;
    }

    // Fallback: first configured device or legacy drive_device
    const entries = parseDriveDeviceEntries(map.drive_devices);
    if (entries.length > 0) {
      return entries[0].path;
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
    const args = ['--scan', '--json', '-i', sourceArg];
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
    fs.mkdirSync(DEFAULT_TEMP_DIR, { recursive: true });
    const exportFile = path.join(DEFAULT_TEMP_DIR, `${exportName}.json`);
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
    const devicePath = String(deviceInfo?.path || '').trim();
    const deviceIndex = Number(deviceInfo?.makemkvIndex ?? deviceInfo?.index);
    const configuredEntries = parseDriveDeviceEntries(map.drive_devices);

    // In explicit mode: look up per-drive makemkvIndex from drive_devices
    if (devicePath && map.drive_mode === 'explicit') {
      const entry = configuredEntries.find((e) => e.path === devicePath);
      if (entry) {
        return `disc:${entry.makemkvIndex}`;
      }
    }

    // Prefer configured per-drive index when a path match exists (also in auto mode).
    if (devicePath) {
      const configured = configuredEntries.find((e) => e.path === devicePath);
      if (configured) {
        return `disc:${configured.makemkvIndex}`;
      }
    }

    // Prefer device-provided MakeMKV index from disk detection service.
    if (Number.isFinite(deviceIndex) && deviceIndex >= 0) {
      return `disc:${Math.trunc(deviceIndex)}`;
    }

    // Last automatic fallback: derive from device name (/dev/sr0 → disc:0).
    if (devicePath) {
      const match = devicePath.match(/sr(\d+)$/);
      if (match) {
        return `disc:${match[1]}`;
      }
    }

    // Fall back to global makemkv_source_index setting
    const sourceIndex = Number(map.makemkv_source_index ?? 0);
    return `disc:${Number.isFinite(sourceIndex) && sourceIndex >= 0 ? Math.trunc(sourceIndex) : 0}`;
  }

  async loadHandBrakePresetOptionsFromCli(map = {}) {
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
      const result = await runCommandCapture(cmd, args, {
        timeout: HANDBRAKE_PRESET_LIST_TIMEOUT_MS,
        maxBuffer: 8 * 1024 * 1024
      });

      if (result.timedOut) {
        return {
          source: 'fallback',
          message: 'Preset-Liste konnte nicht geladen werden (Timeout).',
          options: fallbackOptions
        };
      }

      if (Number(result.status) !== 0) {
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

  async refreshHandBrakePresetCache(map = null, cacheKey = null) {
    const resolvedMap = map && typeof map === 'object'
      ? map
      : await this.getSettingsMap();
    const resolvedCacheKey = String(cacheKey || this.buildHandBrakePresetCacheKey(resolvedMap));
    this.handBrakePresetCache.cacheKey = resolvedCacheKey;

    let loadPromise = null;
    loadPromise = this.loadHandBrakePresetOptionsFromCli(resolvedMap)
      .then((payload) => {
        this.handBrakePresetCache.payload = payload;
        this.handBrakePresetCache.cacheKey = resolvedCacheKey;
        this.handBrakePresetCache.expiresAt = Date.now() + HANDBRAKE_PRESET_CACHE_TTL_MS;
        return payload;
      })
      .finally(() => {
        if (this.handBrakePresetCache.inFlight === loadPromise) {
          this.handBrakePresetCache.inFlight = null;
        }
      });
    this.handBrakePresetCache.inFlight = loadPromise;
    return loadPromise;
  }

  async getHandBrakePresetOptions(options = {}) {
    const forceRefresh = Boolean(options?.forceRefresh);
    const map = options?.settingsMap && typeof options.settingsMap === 'object'
      ? options.settingsMap
      : await this.getSettingsMap();
    const cacheKey = this.buildHandBrakePresetCacheKey(map);
    const now = Date.now();

    if (
      !forceRefresh
      && this.handBrakePresetCache.payload
      && this.handBrakePresetCache.cacheKey === cacheKey
      && this.handBrakePresetCache.expiresAt > now
    ) {
      return this.handBrakePresetCache.payload;
    }

    if (
      !forceRefresh
      && this.handBrakePresetCache.payload
      && this.handBrakePresetCache.cacheKey === cacheKey
    ) {
      if (!this.handBrakePresetCache.inFlight) {
        void this.refreshHandBrakePresetCache(map, cacheKey);
      }
      return this.handBrakePresetCache.payload;
    }

    if (this.handBrakePresetCache.inFlight && this.handBrakePresetCache.cacheKey === cacheKey && !forceRefresh) {
      return this.handBrakePresetCache.inFlight;
    }

    return this.refreshHandBrakePresetCache(map, cacheKey);
  }
}

const settingsServiceInstance = new SettingsService();
settingsServiceInstance.DEFAULT_RAW_DIR = DEFAULT_RAW_DIR;
settingsServiceInstance.DEFAULT_MOVIE_DIR = DEFAULT_MOVIE_DIR;
settingsServiceInstance.DEFAULT_CD_DIR = DEFAULT_CD_DIR;
settingsServiceInstance.DEFAULT_AUDIOBOOK_RAW_DIR = DEFAULT_AUDIOBOOK_RAW_DIR;
settingsServiceInstance.DEFAULT_AUDIOBOOK_DIR = DEFAULT_AUDIOBOOK_DIR;
module.exports = settingsServiceInstance;
