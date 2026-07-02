const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { getDb } = require('../db/database');
const logger = require('./logger').child('MAKEMKV_KEY');
const backendPackage = require('../../package.json');

const MAKEMKV_BETA_KEY_API_URL = 'https://cable.ayra.ch/makemkv/api.php?json';
const MAKEMKV_BETA_KEY_CACHE_PREF_KEY = 'makemkv_beta_key_cache_v1';
const MAKEMKV_BETA_KEY_EXPIRY_GUARD_MS = 1000;
const MAKEMKV_BETA_KEY_FALLBACK_VALIDITY_HOURS = Math.max(
  1,
  Number(process.env.MAKEMKV_BETA_KEY_FALLBACK_VALIDITY_HOURS || 24)
);

const RIPSTER_VERSION = String(backendPackage?.version || 'dev').trim() || 'dev';
const DEFAULT_USER_AGENT = `Ripster/MakeMKVKey-${RIPSTER_VERSION} (linux/manual; Node/manual) +https://github.com/mboehmlaender/ripster`;
const MAKEMKV_BETA_KEY_API_USER_AGENT = process.env.MAKEMKV_BETA_KEY_API_USER_AGENT
  || DEFAULT_USER_AGENT;
const MAKEMKV_BETA_KEY_API_TIMEOUT_MS = Math.max(
  1000,
  Number(process.env.MAKEMKV_BETA_KEY_API_TIMEOUT_MS || 15000)
);
const MAKEMKV_BETA_KEY_BACKOFF_DEFAULT_MS = Math.max(
  30 * 1000,
  Number(process.env.MAKEMKV_BETA_KEY_BACKOFF_DEFAULT_MS || (15 * 60 * 1000))
);

let cachedBetaKeyEntry = null;
let blockedUntilMs = 0;

function parseBetaKeyCandidate(value, invalidMessage = 'Betakey-Antwort ist ungültig.') {
  const betaKey = String(value || '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{15,}$/.test(betaKey)) {
    const error = new Error(invalidMessage);
    error.statusCode = 502;
    throw error;
  }
  return betaKey;
}


function normalizeCacheEntry(rawEntry) {
  if (!rawEntry || typeof rawEntry !== 'object') {
    return null;
  }

  let key = '';
  try {
    key = parseBetaKeyCandidate(rawEntry.key || rawEntry.betaKey || '', 'Betakey-Cache ist ungültig.');
  } catch (_error) {
    return null;
  }

  const sourceUrl = String(rawEntry.sourceUrl || MAKEMKV_BETA_KEY_API_URL).trim() || MAKEMKV_BETA_KEY_API_URL;
  const validUntilIsoRaw = String(rawEntry.validUntil || rawEntry.validUntilIso || '').trim();
  const validUntilMs = Date.parse(validUntilIsoRaw);

  if (!Number.isFinite(validUntilMs)) {
    return null;
  }

  const fetchedAtIsoRaw = String(rawEntry.fetchedAt || rawEntry.fetchedAtIso || '').trim();
  const fetchedAtMs = Date.parse(fetchedAtIsoRaw);

  return {
    key,
    sourceUrl,
    validUntil: new Date(validUntilMs).toISOString(),
    validUntilMs,
    fetchedAt: Number.isFinite(fetchedAtMs) ? new Date(fetchedAtMs).toISOString() : null,
    fetchedAtMs: Number.isFinite(fetchedAtMs) ? fetchedAtMs : null
  };
}

function isCacheEntryValid(entry, nowMs = Date.now()) {
  return Boolean(
    entry
    && typeof entry === 'object'
    && typeof entry.key === 'string'
    && entry.key.length >= 16
    && Number.isFinite(entry.validUntilMs)
    && entry.validUntilMs > (nowMs + MAKEMKV_BETA_KEY_EXPIRY_GUARD_MS)
  );
}

function buildPublicResult(entry, options = {}) {
  return {
    key: entry.key,
    sourceUrl: entry.sourceUrl,
    validUntil: entry.validUntil,
    fetchedAt: entry.fetchedAt || null,
    cached: options.cached === true,
    stale: options.stale === true
  };
}

function setInMemoryCache(entry) {
  cachedBetaKeyEntry = normalizeCacheEntry(entry);
}

async function readPersistentCacheEntry() {
  try {
    const db = await getDb();
    const row = await db.get('SELECT value FROM user_prefs WHERE key = ? LIMIT 1', [MAKEMKV_BETA_KEY_CACHE_PREF_KEY]);
    if (!row?.value) {
      return null;
    }
    const parsed = JSON.parse(String(row.value));
    return normalizeCacheEntry(parsed);
  } catch (error) {
    logger.warn('beta-key:cache-db-read-failed', {
      error: error?.message || String(error)
    });
    return null;
  }
}

async function persistCacheEntry(entry) {
  const normalized = normalizeCacheEntry(entry);
  if (!normalized) {
    return;
  }

  const payload = JSON.stringify({
    key: normalized.key,
    sourceUrl: normalized.sourceUrl,
    validUntil: normalized.validUntil,
    fetchedAt: normalized.fetchedAt || new Date().toISOString()
  });

  try {
    const db = await getDb();
    await db.run(
      `INSERT INTO user_prefs (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      [MAKEMKV_BETA_KEY_CACHE_PREF_KEY, payload]
    );
  } catch (error) {
    logger.warn('beta-key:cache-db-write-failed', {
      error: error?.message || String(error)
    });
  }
}

async function tryUsePersistentCache(nowMs = Date.now()) {
  const persistent = await readPersistentCacheEntry();
  if (!isCacheEntryValid(persistent, nowMs)) {
    return null;
  }
  setInMemoryCache(persistent);
  return buildPublicResult(persistent, { cached: true, stale: false });
}

async function getCachedBetaKey(options = {}) {
  const nowMs = Date.now();
  const allowExpired = options?.allowExpired !== false;

  if (cachedBetaKeyEntry) {
    const stale = !isCacheEntryValid(cachedBetaKeyEntry, nowMs);
    if (!stale || allowExpired) {
      return buildPublicResult(cachedBetaKeyEntry, { cached: true, stale });
    }
  }

  const persistent = await readPersistentCacheEntry();
  if (!persistent) {
    return null;
  }

  setInMemoryCache(persistent);
  const stale = !isCacheEntryValid(persistent, nowMs);
  if (stale && !allowExpired) {
    return null;
  }

  return buildPublicResult(persistent, { cached: true, stale });
}

function createRateLimitError(retryAfterMs = 0) {
  const parsedRetryMs = Number(retryAfterMs || 0);
  const waitMs = parsedRetryMs > 0 ? parsedRetryMs : MAKEMKV_BETA_KEY_BACKOFF_DEFAULT_MS;
  blockedUntilMs = Math.max(blockedUntilMs, Date.now() + waitMs);

  const retryAtIso = new Date(blockedUntilMs).toISOString();
  const error = new Error(`Betakey-API limitiert Anfragen. Neuer Versuch nach ${retryAtIso}.`);
  error.statusCode = 429;
  error.retryAt = retryAtIso;
  error.retryAfterMs = Math.max(1000, blockedUntilMs - Date.now());
  return error;
}

function buildExistingBackoffError() {
  const retryAtMs = Math.max(Date.now() + 1000, Number(blockedUntilMs || 0));
  const retryAtIso = new Date(retryAtMs).toISOString();
  const error = new Error(`Betakey-API limitiert Anfragen. Neuer Versuch nach ${retryAtIso}.`);
  error.statusCode = 429;
  error.retryAt = retryAtIso;
  error.retryAfterMs = Math.max(1000, retryAtMs - Date.now());
  return error;
}

function resolveValidityOrFallback(validUntilIso, sourceUrl) {
  const parsedMs = Date.parse(String(validUntilIso || '').trim());
  if (Number.isFinite(parsedMs)) {
    return new Date(parsedMs).toISOString();
  }

  const fallbackIso = new Date(Date.now() + MAKEMKV_BETA_KEY_FALLBACK_VALIDITY_HOURS * 60 * 60 * 1000).toISOString();
  logger.warn('beta-key:validity-parse-fallback', {
    sourceUrl: sourceUrl || null,
    fallbackIso
  });
  return fallbackIso;
}

function normalizeRegistrationKey(rawValue) {
  return String(rawValue || '').trim();
}

function getMakeMKVConfigDir(homeDir = os.homedir()) {
  return path.join(String(homeDir || '').trim() || os.homedir(), '.MakeMKV');
}

function getMakeMKVSettingsFilePath(homeDir = os.homedir()) {
  return path.join(getMakeMKVConfigDir(homeDir), 'settings.conf');
}

function escapeKeyForSettingsFile(value) {
  return String(value || '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"');
}

function buildUpdatedSettingsContent(currentContent, registrationKey) {
  const existingLines = String(currentContent || '')
    .split(/\r?\n/)
    .filter((line) => !/^\s*app_Key\s*=/.test(line));
  const normalizedKey = normalizeRegistrationKey(registrationKey);

  while (existingLines.length > 0 && existingLines[existingLines.length - 1] === '') {
    existingLines.pop();
  }

  if (normalizedKey) {
    existingLines.push(`app_Key = "${escapeKeyForSettingsFile(normalizedKey)}"`);
  }

  return existingLines.length > 0 ? `${existingLines.join('\n')}\n` : '';
}

async function syncRegistrationKeyToConfig(rawValue, options = {}) {
  const normalizedKey = normalizeRegistrationKey(rawValue);
  const homeDir = String(options?.homeDir || '').trim() || os.homedir();
  const configDir = getMakeMKVConfigDir(homeDir);
  const settingsFilePath = getMakeMKVSettingsFilePath(homeDir);
  const fileExists = fs.existsSync(settingsFilePath);
  const currentContent = fileExists
    ? await fs.promises.readFile(settingsFilePath, 'utf8')
    : '';
  const nextContent = buildUpdatedSettingsContent(currentContent, normalizedKey);

  if (!normalizedKey && !fileExists) {
    return {
      changed: false,
      path: settingsFilePath,
      hasKey: false
    };
  }

  await fs.promises.mkdir(configDir, { recursive: true });

  if (nextContent) {
    await fs.promises.writeFile(settingsFilePath, nextContent, 'utf8');
    await fs.promises.chmod(settingsFilePath, 0o600).catch(() => {});
    logger.info('settings-conf:key-synced', {
      path: settingsFilePath,
      hasKey: true
    });
  } else {
    await fs.promises.writeFile(settingsFilePath, '', 'utf8');
    await fs.promises.chmod(settingsFilePath, 0o600).catch(() => {});
    logger.info('settings-conf:key-cleared', {
      path: settingsFilePath,
      hasKey: false
    });
  }

  return {
    changed: currentContent !== nextContent,
    path: settingsFilePath,
    hasKey: Boolean(normalizedKey)
  };
}

async function fetchCurrentBetaKey(options = {}) {
  const forceRefresh = options?.forceRefresh === true;
  const now = Date.now();

  if (!forceRefresh && isCacheEntryValid(cachedBetaKeyEntry, now)) {
    return buildPublicResult(cachedBetaKeyEntry, { cached: true, stale: false });
  }

  if (!forceRefresh) {
    const persistentCacheHit = await tryUsePersistentCache(now);
    if (persistentCacheHit) {
      return persistentCacheHit;
    }
  }

  if (!forceRefresh && blockedUntilMs > now) {
    throw buildExistingBackoffError();
  }

  try {
    const apiResult = await fetchCurrentBetaKeyViaCurl();
    const normalized = normalizeCacheEntry({
      ...apiResult,
      fetchedAt: new Date().toISOString()
    });

    if (!normalized) {
      const error = new Error('API-curl-Betakey konnte nicht normalisiert werden.');
      error.statusCode = 502;
      throw error;
    }

    blockedUntilMs = 0;
    setInMemoryCache(normalized);
    await persistCacheEntry(normalized);
    return buildPublicResult(normalized, { cached: false, stale: false });
  } catch (error) {
    logger.warn('beta-key:fetch-failed', {
      error: error?.message || String(error)
    });
    if (Number(error?.httpStatus || error?.statusCode || error?.status || 0) === 429) {
      throw createRateLimitError(Number(error?.retryAfterMs || 0));
    }
    const resolved = new Error(`Betakey konnte nicht geladen werden. Details: ${error?.message || String(error)}`);
    resolved.statusCode = Number(error?.httpStatus || error?.statusCode || error?.status || 502) || 502;
    throw resolved;
  }
}

function parseBetaKeyResponse(rawBody) {
  let payload = null;
  try {
    payload = JSON.parse(String(rawBody || '{}'));
  } catch (_error) {
    const error = new Error('Betakey-Antwort ist kein gültiges JSON.');
    error.statusCode = 502;
    throw error;
  }

  const betaKey = parseBetaKeyCandidate(String(payload?.key || '').trim(), 'Betakey-Antwort ist ungültig.');

  let validUntil = null;
  const unixExpiry = Number(payload?.keydate || payload?.expires || payload?.valid_until_unix || 0);
  if (Number.isFinite(unixExpiry) && unixExpiry > 0) {
    validUntil = new Date(unixExpiry * 1000).toISOString();
  }

  const resolvedValidUntil = resolveValidityOrFallback(validUntil, MAKEMKV_BETA_KEY_API_URL);

  return {
    key: betaKey,
    sourceUrl: MAKEMKV_BETA_KEY_API_URL,
    validUntil: resolvedValidUntil
  };
}

function fetchCurrentBetaKeyViaCurl() {
  return new Promise((resolve, reject) => {
    const curlArgs = [
      '-fsSL',
      '--max-time', String(Math.ceil(MAKEMKV_BETA_KEY_API_TIMEOUT_MS / 1000)),
      '-A', MAKEMKV_BETA_KEY_API_USER_AGENT,
      MAKEMKV_BETA_KEY_API_URL
    ];

    execFile(
      'curl',
      curlArgs,
      {
        timeout: MAKEMKV_BETA_KEY_API_TIMEOUT_MS,
        maxBuffer: 1024 * 1024
      },
      (error, stdout, stderr) => {
        if (error) {
          const resolvedError = new Error(
            `curl fehlgeschlagen (${error.code || 'unknown'}): ${String(stderr || error.message || '').trim() || 'keine Details'}`
          );
          resolvedError.statusCode = 502;
          if (/\b429\b/.test(String(stderr || ''))) {
            resolvedError.httpStatus = 429;
          }
          if (/\b403\b/.test(String(stderr || ''))) {
            resolvedError.httpStatus = 403;
          }
          reject(resolvedError);
          return;
        }

        try {
          resolve(parseBetaKeyResponse(stdout));
        } catch (parseError) {
          reject(parseError);
        }
      }
    );
  });
}

module.exports = {
  MAKEMKV_BETA_KEY_API_URL,
  fetchCurrentBetaKey,
  getCachedBetaKey,
  getMakeMKVConfigDir,
  getMakeMKVSettingsFilePath,
  normalizeRegistrationKey,
  syncRegistrationKeyToConfig
};
