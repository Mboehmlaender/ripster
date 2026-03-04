const fs = require('fs');
const path = require('path');
const { logLevel } = require('../config');
const { getBackendLogDir, getFallbackLogRootDir } = require('./logPathService');

const LEVELS = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
};

const ACTIVE_LEVEL = LEVELS[String(logLevel || 'info').toLowerCase()] || LEVELS.info;

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

  const timestamp = new Date().toISOString();
  const payload = {
    timestamp,
    level: normLevel,
    scope,
    message,
    meta: sanitizeMeta(meta)
  };

  const line = safeJson(payload);
  writeLine(line);

  const print = `[${timestamp}] [${normLevel.toUpperCase()}] [${scope}] ${message}`;
  if (normLevel === 'error') {
    console.error(print, payload.meta ? payload.meta : '');
  } else if (normLevel === 'warn') {
    console.warn(print, payload.meta ? payload.meta : '');
  } else {
    console.log(print, payload.meta ? payload.meta : '');
  }
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

module.exports = {
  child,
  emit
};
