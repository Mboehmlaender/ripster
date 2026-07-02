const fs = require('fs');
const path = require('path');
const { logLevel } = require('../config');
const { getBackendLogDir, getFallbackLogRootDir } = require('./logPathService');
const { getServerTimestamp } = require('../utils/serverTime');

const LEVELS = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
};

const ACTIVE_LEVEL = LEVELS[String(logLevel || 'info').toLowerCase()] || LEVELS.info;
let consoleConfig = {
  enabled: true,
  levels: {
    debug: true,
    info: true,
    warn: true,
    error: true
  },
  http: true
};

function normalizeBoolean(value, fallback = true) {
  if (value === null || value === undefined) {
    return fallback;
  }
  return Boolean(value);
}

function ensureLogDir(logDirPath) {
  try {
    fs.mkdirSync(logDirPath, { recursive: true });
    return true;
  } catch (_error) {
    return false;
  }
}

function resolveWritableBackendLogDir() {
  const preferred = getBackendLogDir();
  if (ensureLogDir(preferred)) {
    return preferred;
  }

  const fallback = path.join(getFallbackLogRootDir(), 'backend');
  if (fallback !== preferred && ensureLogDir(fallback)) {
    return fallback;
  }

  return null;
}

function getDailyFileName() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `backend-${y}-${m}-${day}.log`;
}

function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch (error) {
    return JSON.stringify({ serializationError: error.message });
  }
}

function truncateString(value, maxLen = 3000) {
  const str = String(value);
  if (str.length <= maxLen) {
    return str;
  }
  return `${str.slice(0, maxLen)}...[truncated ${str.length - maxLen} chars]`;
}

function sanitizeMeta(meta) {
  if (!meta || typeof meta !== 'object') {
    return meta;
  }

  const out = Array.isArray(meta) ? [] : {};

  for (const [key, val] of Object.entries(meta)) {
    if (val instanceof Error) {
      out[key] = {
        name: val.name,
        message: val.message,
        stack: val.stack
      };
      continue;
    }

    if (typeof val === 'string') {
      out[key] = truncateString(val, 5000);
      continue;
    }

    out[key] = val;
  }

  return out;
}

function writeLine(line) {
  const backendLogDir = resolveWritableBackendLogDir();
  if (!backendLogDir) {
    return;
  }
  const daily = path.join(backendLogDir, getDailyFileName());
  const latest = path.join(backendLogDir, 'backend-latest.log');

  fs.appendFile(daily, `${line}\n`, (_error) => null);
  fs.appendFile(latest, `${line}\n`, (_error) => null);
}

function emit(level, scope, message, meta = null) {
  const normLevel = String(level || 'info').toLowerCase();
  const lvl = LEVELS[normLevel] || LEVELS.info;
  if (lvl < ACTIVE_LEVEL) {
    return;
  }

  const timestamp = getServerTimestamp();
  const payload = {
    timestamp,
    level: normLevel,
    scope,
    message,
    meta: sanitizeMeta(meta)
  };

  const line = safeJson(payload);
  writeLine(line);

  if (!shouldEmitToConsole(normLevel, scope)) {
    return;
  }

  const print = `[${timestamp}] [${normLevel.toUpperCase()}] [${scope}] ${message}`;
  if (normLevel === 'error') {
    console.error(print, payload.meta ? payload.meta : '');
  } else if (normLevel === 'warn') {
    console.warn(print, payload.meta ? payload.meta : '');
  } else {
    console.log(print, payload.meta ? payload.meta : '');
  }
}

function shouldEmitToConsole(level, scope) {
  if (!consoleConfig.enabled) {
    return false;
  }

  const normalizedLevel = String(level || 'info').toLowerCase();
  if (consoleConfig.levels[normalizedLevel] === false) {
    return false;
  }

  const normalizedScope = String(scope || '').trim().toUpperCase();
  if (normalizedScope === 'HTTP' && !consoleConfig.http) {
    return false;
  }

  return true;
}

function child(scope) {
  return {
    debug(message, meta) {
      emit('debug', scope, message, meta);
    },
    info(message, meta) {
      emit('info', scope, message, meta);
    },
    warn(message, meta) {
      emit('warn', scope, message, meta);
    },
    error(message, meta) {
      emit('error', scope, message, meta);
    }
  };
}

function setConsoleOutputEnabled(enabled) {
  consoleConfig.enabled = Boolean(enabled);
  return consoleConfig.enabled;
}

function isConsoleOutputEnabled() {
  return consoleConfig.enabled;
}

function configureConsoleOutput(options = {}) {
  const opts = options && typeof options === 'object' ? options : {};
  if (Object.prototype.hasOwnProperty.call(opts, 'enabled')) {
    consoleConfig.enabled = normalizeBoolean(opts.enabled, true);
  }

  if (opts.levels && typeof opts.levels === 'object') {
    const sourceLevels = opts.levels;
    for (const level of Object.keys(LEVELS)) {
      if (Object.prototype.hasOwnProperty.call(sourceLevels, level)) {
        consoleConfig.levels[level] = normalizeBoolean(sourceLevels[level], true);
      }
    }
  }

  if (Object.prototype.hasOwnProperty.call(opts, 'http')) {
    consoleConfig.http = normalizeBoolean(opts.http, true);
  }

  return getConsoleOutputConfig();
}

function getConsoleOutputConfig() {
  return {
    enabled: Boolean(consoleConfig.enabled),
    levels: {
      debug: Boolean(consoleConfig.levels.debug),
      info: Boolean(consoleConfig.levels.info),
      warn: Boolean(consoleConfig.levels.warn),
      error: Boolean(consoleConfig.levels.error)
    },
    http: Boolean(consoleConfig.http)
  };
}

module.exports = {
  child,
  emit,
  setConsoleOutputEnabled,
  isConsoleOutputEnabled,
  configureConsoleOutput,
  getConsoleOutputConfig
};
