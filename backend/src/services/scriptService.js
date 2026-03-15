const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { getDb } = require('../db/database');
const logger = require('./logger').child('SCRIPTS');
const settingsService = require('./settingsService');
const runtimeActivityService = require('./runtimeActivityService');
const { streamLines } = require('./processRunner');
const { errorToMeta } = require('../utils/errorMeta');

const SCRIPT_NAME_MAX_LENGTH = 120;
const SCRIPT_BODY_MAX_LENGTH = 200000;
const SCRIPT_TEST_TIMEOUT_SETTING_KEY = 'script_test_timeout_ms';
const DEFAULT_SCRIPT_TEST_TIMEOUT_MS = 0;
const SCRIPT_TEST_TIMEOUT_MS = (() => {
  const parsed = Number(process.env.RIPSTER_SCRIPT_TEST_TIMEOUT_MS);
  if (Number.isFinite(parsed)) {
    return Math.max(0, Math.trunc(parsed));
  }
  return DEFAULT_SCRIPT_TEST_TIMEOUT_MS;
})();
const SCRIPT_OUTPUT_MAX_CHARS = 150000;

function normalizeScriptTestTimeoutMs(rawValue, fallbackMs = SCRIPT_TEST_TIMEOUT_MS) {
  const parsed = Number(rawValue);
  if (Number.isFinite(parsed)) {
    return Math.max(0, Math.trunc(parsed));
  }
  if (fallbackMs === null || fallbackMs === undefined) {
    return null;
  }
  const parsedFallback = Number(fallbackMs);
  if (Number.isFinite(parsedFallback)) {
    return Math.max(0, Math.trunc(parsedFallback));
  }
  return 0;
}

function normalizeScriptId(rawValue) {
  const value = Number(rawValue);
  if (!Number.isFinite(value) || value <= 0) {
    return null;
  }
  return Math.trunc(value);
}

function normalizeScriptIdList(rawList) {
  const list = Array.isArray(rawList) ? rawList : [];
  const seen = new Set();
  const output = [];
  for (const item of list) {
    const normalized = normalizeScriptId(item);
    if (!normalized) {
      continue;
    }
    const key = String(normalized);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    output.push(normalized);
  }
  return output;
}

function normalizeScriptName(rawValue) {
  return String(rawValue || '').trim();
}

function normalizeScriptBody(rawValue) {
  return String(rawValue || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function createValidationError(message, details = null) {
  const error = new Error(message);
  error.statusCode = 400;
  if (details) {
    error.details = details;
  }
  return error;
}

function validateScriptPayload(payload, { partial = false } = {}) {
  const body = payload && typeof payload === 'object' ? payload : {};
  const hasName = Object.prototype.hasOwnProperty.call(body, 'name');
  const hasScriptBody = Object.prototype.hasOwnProperty.call(body, 'scriptBody');
  const normalized = {};
  const errors = [];

  if (!partial || hasName) {
    const name = normalizeScriptName(body.name);
    if (!name) {
      errors.push({ field: 'name', message: 'Name darf nicht leer sein.' });
    } else if (name.length > SCRIPT_NAME_MAX_LENGTH) {
      errors.push({ field: 'name', message: `Name darf maximal ${SCRIPT_NAME_MAX_LENGTH} Zeichen enthalten.` });
    } else {
      normalized.name = name;
    }
  }

  if (!partial || hasScriptBody) {
    const scriptBody = normalizeScriptBody(body.scriptBody);
    if (!scriptBody.trim()) {
      errors.push({ field: 'scriptBody', message: 'Skript darf nicht leer sein.' });
    } else if (scriptBody.length > SCRIPT_BODY_MAX_LENGTH) {
      errors.push({ field: 'scriptBody', message: `Skript darf maximal ${SCRIPT_BODY_MAX_LENGTH} Zeichen enthalten.` });
    } else {
      normalized.scriptBody = scriptBody;
    }
  }

  if (errors.length > 0) {
    throw createValidationError('Skript ist ungültig.', errors);
  }

  return normalized;
}

function mapScriptRow(row) {
  if (!row) {
    return null;
  }
  return {
    id: Number(row.id),
    name: String(row.name || ''),
    scriptBody: String(row.script_body || ''),
    orderIndex: Number(row.order_index || 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function quoteForBashSingle(value) {
  return `'${String(value || '').replace(/'/g, `'\"'\"'`)}'`;
}

function buildScriptEnvironment(context = {}) {
  const now = new Date().toISOString();
  const entries = {
    RIPSTER_SCRIPT_RUN_AT: now,
    RIPSTER_JOB_ID: context?.jobId ?? '',
    RIPSTER_JOB_TITLE: context?.jobTitle ?? '',
    RIPSTER_MODE: context?.mode ?? '',
    RIPSTER_INPUT_PATH: context?.inputPath ?? '',
    RIPSTER_OUTPUT_PATH: context?.outputPath ?? '',
    RIPSTER_RAW_PATH: context?.rawPath ?? '',
    RIPSTER_SCRIPT_ID: context?.scriptId ?? '',
    RIPSTER_SCRIPT_NAME: context?.scriptName ?? '',
    RIPSTER_SCRIPT_SOURCE: context?.source ?? ''
  };

  const output = {};
  for (const [key, value] of Object.entries(entries)) {
    output[key] = String(value ?? '');
  }
  return output;
}

function buildScriptWrapper(scriptBody, context = {}) {
  const envVars = buildScriptEnvironment(context);
  const exportLines = Object.entries(envVars)
    .map(([key, value]) => `export ${key}=${quoteForBashSingle(value)}`)
    .join('\n');
  // Wait for potential background jobs started by the script before returning.
  return `${exportLines}\n\n${String(scriptBody || '')}\n\nwait\n`;
}

function appendWithCap(current, chunk, maxChars) {
  const value = String(chunk || '');
  if (!value) {
    return { value: current, truncated: false };
  }
  const currentText = String(current || '');
  if (currentText.length >= maxChars) {
    return { value: currentText, truncated: true };
  }
  const available = maxChars - currentText.length;
  if (value.length <= available) {
    return { value: `${currentText}${value}`, truncated: false };
  }
  return {
    value: `${currentText}${value.slice(0, available)}`,
    truncated: true
  };
}

function killChildProcessTree(child, signal = 'SIGTERM') {
  if (!child) {
    return false;
  }
  const pid = Number(child.pid);
  if (Number.isFinite(pid) && pid > 0) {
    try {
      // If spawned as detached=true this targets the full process group.
      process.kill(-pid, signal);
      return true;
    } catch (_error) {
      // Fallback below.
    }
  }
  try {
    child.kill(signal);
    return true;
  } catch (_error) {
    return false;
  }
}

function runProcessCapture({
  cmd,
  args,
  timeoutMs = SCRIPT_TEST_TIMEOUT_MS,
  cwd = process.cwd(),
  onChild = null,
  onStdoutLine = null,
  onStderrLine = null
}) {
  return new Promise((resolve, reject) => {
    const effectiveTimeoutMs = normalizeScriptTestTimeoutMs(timeoutMs, SCRIPT_TEST_TIMEOUT_MS);
    const startedAt = Date.now();
    let ended = false;
    const child = spawn(cmd, args, {
      cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true
    });
    if (typeof onChild === 'function') {
      try {
        onChild(child);
      } catch (_error) {
        // ignore observer errors
      }
    }

    let stdout = '';
    let stderr = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;

    let timeout = null;
    if (effectiveTimeoutMs > 0) {
      timeout = setTimeout(() => {
        timedOut = true;
        killChildProcessTree(child, 'SIGTERM');
        setTimeout(() => {
          if (!ended) {
            killChildProcessTree(child, 'SIGKILL');
          }
        }, 2000);
      }, effectiveTimeoutMs);
    }

    const onData = (streamName, chunk) => {
      if (streamName === 'stdout') {
        const next = appendWithCap(stdout, chunk, SCRIPT_OUTPUT_MAX_CHARS);
        stdout = next.value;
        stdoutTruncated = stdoutTruncated || next.truncated;
      } else {
        const next = appendWithCap(stderr, chunk, SCRIPT_OUTPUT_MAX_CHARS);
        stderr = next.value;
        stderrTruncated = stderrTruncated || next.truncated;
      }
    };

    child.stdout?.on('data', (chunk) => onData('stdout', chunk));
    child.stderr?.on('data', (chunk) => onData('stderr', chunk));

    if (child.stdout && typeof onStdoutLine === 'function') {
      streamLines(child.stdout, onStdoutLine);
    }
    if (child.stderr && typeof onStderrLine === 'function') {
      streamLines(child.stderr, onStderrLine);
    }

    child.on('error', (error) => {
      ended = true;
      if (timeout) {
        clearTimeout(timeout);
      }
      reject(error);
    });

    child.on('close', (code, signal) => {
      ended = true;
      if (timeout) {
        clearTimeout(timeout);
      }
      const endedAt = Date.now();
      resolve({
        code: Number.isFinite(Number(code)) ? Number(code) : null,
        signal: signal || null,
        durationMs: Math.max(0, endedAt - startedAt),
        timedOut,
        stdout,
        stderr,
        stdoutTruncated,
        stderrTruncated
      });
    });
  });
}

async function resolveScriptTestTimeoutMs(options = {}) {
  const timeoutFromOptions = normalizeScriptTestTimeoutMs(options?.timeoutMs, null);
  if (timeoutFromOptions !== null) {
    return timeoutFromOptions;
  }
  try {
    const settingsMap = await settingsService.getSettingsMap();
    return normalizeScriptTestTimeoutMs(
      settingsMap?.[SCRIPT_TEST_TIMEOUT_SETTING_KEY],
      SCRIPT_TEST_TIMEOUT_MS
    );
  } catch (error) {
    logger.warn('script:test-timeout:settings-read-failed', { error: errorToMeta(error) });
    return SCRIPT_TEST_TIMEOUT_MS;
  }
}

class ScriptService {
  async listScripts() {
    const db = await getDb();
    const rows = await db.all(
      `
        SELECT id, name, script_body, order_index, created_at, updated_at
        FROM scripts
        ORDER BY order_index ASC, id ASC
      `
    );
    return rows.map(mapScriptRow);
  }

  async getScriptById(scriptId) {
    const normalizedId = normalizeScriptId(scriptId);
    if (!normalizedId) {
      throw createValidationError('Ungültige scriptId.');
    }
    const db = await getDb();
    const row = await db.get(
      `
        SELECT id, name, script_body, order_index, created_at, updated_at
        FROM scripts
        WHERE id = ?
      `,
      [normalizedId]
    );
    if (!row) {
      const error = new Error(`Skript #${normalizedId} wurde nicht gefunden.`);
      error.statusCode = 404;
      throw error;
    }
    return mapScriptRow(row);
  }

  async createScript(payload = {}) {
    const normalized = validateScriptPayload(payload, { partial: false });
    const db = await getDb();
    try {
      const nextOrderIndex = await this._getNextOrderIndex(db);
      const result = await db.run(
        `
          INSERT INTO scripts (name, script_body, order_index, created_at, updated_at)
          VALUES (?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        `,
        [normalized.name, normalized.scriptBody, nextOrderIndex]
      );
      return this.getScriptById(result.lastID);
    } catch (error) {
      if (String(error?.message || '').includes('UNIQUE constraint failed')) {
        throw createValidationError(`Skriptname "${normalized.name}" existiert bereits.`, [
          { field: 'name', message: 'Name muss eindeutig sein.' }
        ]);
      }
      throw error;
    }
  }

  async updateScript(scriptId, payload = {}) {
    const normalizedId = normalizeScriptId(scriptId);
    if (!normalizedId) {
      throw createValidationError('Ungültige scriptId.');
    }
    const normalized = validateScriptPayload(payload, { partial: false });
    const db = await getDb();
    await this.getScriptById(normalizedId);
    try {
      await db.run(
        `
          UPDATE scripts
          SET
            name = ?,
            script_body = ?,
            updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `,
        [normalized.name, normalized.scriptBody, normalizedId]
      );
    } catch (error) {
      if (String(error?.message || '').includes('UNIQUE constraint failed')) {
        throw createValidationError(`Skriptname "${normalized.name}" existiert bereits.`, [
          { field: 'name', message: 'Name muss eindeutig sein.' }
        ]);
      }
      throw error;
    }
    return this.getScriptById(normalizedId);
  }

  async deleteScript(scriptId) {
    const normalizedId = normalizeScriptId(scriptId);
    if (!normalizedId) {
      throw createValidationError('Ungültige scriptId.');
    }
    const db = await getDb();
    const existing = await this.getScriptById(normalizedId);
    await db.run('DELETE FROM scripts WHERE id = ?', [normalizedId]);
    return existing;
  }

  async getScriptsByIds(rawIds = []) {
    const ids = normalizeScriptIdList(rawIds);
    if (ids.length === 0) {
      return [];
    }
    const db = await getDb();
    const placeholders = ids.map(() => '?').join(', ');
    const rows = await db.all(
      `
        SELECT id, name, script_body, order_index, created_at, updated_at
        FROM scripts
        WHERE id IN (${placeholders})
      `,
      ids
    );
    const byId = new Map(rows.map((row) => [Number(row.id), mapScriptRow(row)]));
    return ids.map((id) => byId.get(id)).filter(Boolean);
  }

  async resolveScriptsByIds(rawIds = [], options = {}) {
    const ids = normalizeScriptIdList(rawIds);
    if (ids.length === 0) {
      return [];
    }
    const strict = options?.strict !== false;
    const scripts = await this.getScriptsByIds(ids);
    if (!strict) {
      return scripts;
    }
    const foundIds = new Set(scripts.map((item) => Number(item.id)));
    const missing = ids.filter((id) => !foundIds.has(Number(id)));
    if (missing.length > 0) {
      throw createValidationError(`Skript(e) nicht gefunden: ${missing.join(', ')}`, [
        { field: 'selectedPostEncodeScriptIds', message: `Nicht gefunden: ${missing.join(', ')}` }
      ]);
    }
    return scripts;
  }

  async reorderScripts(orderedIds = []) {
    const db = await getDb();
    const providedIds = normalizeScriptIdList(orderedIds);
    const rows = await db.all(
      `
        SELECT id
        FROM scripts
        ORDER BY order_index ASC, id ASC
      `
    );
    if (rows.length === 0) {
      return [];
    }

    const existingIds = rows.map((row) => Number(row.id)).filter((id) => Number.isFinite(id) && id > 0);
    const existingSet = new Set(existingIds);
    const used = new Set();
    const nextOrder = [];

    for (const id of providedIds) {
      if (!existingSet.has(id) || used.has(id)) {
        continue;
      }
      used.add(id);
      nextOrder.push(id);
    }

    for (const id of existingIds) {
      if (used.has(id)) {
        continue;
      }
      used.add(id);
      nextOrder.push(id);
    }

    await db.exec('BEGIN');
    try {
      for (let i = 0; i < nextOrder.length; i += 1) {
        await db.run(
          `
            UPDATE scripts
            SET order_index = ?, updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
          `,
          [i + 1, nextOrder[i]]
        );
      }
      await db.exec('COMMIT');
    } catch (error) {
      await db.exec('ROLLBACK');
      throw error;
    }

    return this.listScripts();
  }

  async _getNextOrderIndex(db) {
    const row = await db.get(
      `
        SELECT COALESCE(MAX(order_index), 0) AS max_order_index
        FROM scripts
      `
    );
    const maxOrder = Number(row?.max_order_index || 0);
    if (!Number.isFinite(maxOrder) || maxOrder < 0) {
      return 1;
    }
    return Math.trunc(maxOrder) + 1;
  }

  async createExecutableScriptFile(script, context = {}) {
    const name = String(script?.name || '').trim() || `script-${script?.id || 'unknown'}`;
    const scriptBody = normalizeScriptBody(script?.scriptBody);
    const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ripster-script-'));
    const scriptPath = path.join(tempDir, 'script.sh');
    const wrapped = buildScriptWrapper(scriptBody, {
      ...context,
      scriptId: script?.id ?? context?.scriptId ?? '',
      scriptName: name,
      source: context?.source || 'post_encode'
    });

    await fs.promises.writeFile(scriptPath, wrapped, {
      encoding: 'utf-8',
      mode: 0o700
    });

    const cleanup = async () => {
      try {
        await fs.promises.rm(tempDir, { recursive: true, force: true });
      } catch (error) {
        logger.warn('script:temp-cleanup-failed', {
          scriptId: script?.id ?? null,
          scriptName: name,
          tempDir,
          error: errorToMeta(error)
        });
      }
    };

    return {
      tempDir,
      scriptPath,
      cmd: '/usr/bin/env',
      args: ['bash', scriptPath],
      argsForLog: ['bash', `<script:${name}>`],
      cleanup
    };
  }

  async testScript(scriptId, options = {}) {
    const script = await this.getScriptById(scriptId);
    const effectiveTimeoutMs = await resolveScriptTestTimeoutMs(options);
    const prepared = await this.createExecutableScriptFile(script, {
      source: 'settings_test',
      mode: 'test'
    });
    const activityId = runtimeActivityService.startActivity('script', {
      name: script.name,
      source: 'settings_test',
      scriptId: script.id,
      currentStep: 'Skript-Test läuft'
    });
    const controlState = {
      cancelRequested: false,
      cancelReason: null,
      child: null,
      cancelSignalSent: false
    };
    runtimeActivityService.setControls(activityId, {
      cancel: async (payload = {}) => {
        if (controlState.cancelRequested) {
          return { accepted: true, alreadyRequested: true, message: 'Abbruch bereits angefordert.' };
        }
        controlState.cancelRequested = true;
        controlState.cancelReason = String(payload?.reason || '').trim() || 'Von Benutzer abgebrochen';
        runtimeActivityService.updateActivity(activityId, {
          message: 'Abbruch angefordert'
        });
        if (controlState.child) {
          // User cancel should stop instantly.
          controlState.cancelSignalSent = killChildProcessTree(controlState.child, 'SIGKILL') || controlState.cancelSignalSent;
        }
        return { accepted: true, message: 'Abbruch angefordert.' };
      }
    });

    try {
      const run = await runProcessCapture({
        cmd: prepared.cmd,
        args: prepared.args,
        timeoutMs: effectiveTimeoutMs,
        onChild: (child) => {
          controlState.child = child;
        },
        onStdoutLine: (line) => {
          runtimeActivityService.appendActivityOutput(activityId, { stdout: line });
        },
        onStderrLine: (line) => {
          runtimeActivityService.appendActivityOutput(activityId, { stderr: line });
        }
      });
      const exitCode = Number.isFinite(Number(run.code)) ? Number(run.code) : null;
      const finishedSuccessfully = exitCode === 0 && !run.timedOut;
      const cancelledByUser = Boolean(controlState.cancelRequested)
        && (Boolean(controlState.cancelSignalSent) || !finishedSuccessfully);
      const success = finishedSuccessfully;
      const message = cancelledByUser
        ? (controlState.cancelReason || 'Von Benutzer abgebrochen')
        : (run.timedOut
          ? `Skript-Test Timeout nach ${Math.round(effectiveTimeoutMs / 1000)}s`
          : (success ? 'Skript-Test abgeschlossen' : `Skript-Test fehlgeschlagen (Exit ${run.code ?? 'n/a'})`));
      const errorMessage = success
        ? null
        : (cancelledByUser
          ? (controlState.cancelReason || 'Von Benutzer abgebrochen')
          : (run.timedOut
            ? `Skript-Test Timeout nach ${Math.round(effectiveTimeoutMs / 1000)}s`
            : `Skript-Test fehlgeschlagen (Exit ${run.code ?? 'n/a'})`));
      runtimeActivityService.completeActivity(activityId, {
        status: success ? 'success' : 'error',
        success,
        outcome: cancelledByUser ? 'cancelled' : (success ? 'success' : 'error'),
        cancelled: cancelledByUser,
        exitCode,
        stdout: run.stdout || null,
        stderr: run.stderr || null,
        stdoutTruncated: Boolean(run.stdoutTruncated),
        stderrTruncated: Boolean(run.stderrTruncated),
        errorMessage,
        message
      });
      return {
        scriptId: script.id,
        scriptName: script.name,
        success,
        exitCode: run.code,
        signal: run.signal,
        timedOut: run.timedOut,
        durationMs: run.durationMs,
        stdout: run.stdout,
        stderr: run.stderr,
        stdoutTruncated: run.stdoutTruncated,
        stderrTruncated: run.stderrTruncated
      };
    } catch (error) {
      runtimeActivityService.completeActivity(activityId, {
        status: 'error',
        success: false,
        outcome: controlState.cancelRequested ? 'cancelled' : 'error',
        cancelled: Boolean(controlState.cancelRequested),
        errorMessage: controlState.cancelRequested
          ? (controlState.cancelReason || 'Von Benutzer abgebrochen')
          : (error?.message || 'Skript-Test Fehler'),
        message: controlState.cancelRequested
          ? (controlState.cancelReason || 'Von Benutzer abgebrochen')
          : (error?.message || 'Skript-Test Fehler')
      });
      throw error;
    } finally {
      controlState.child = null;
      await prepared.cleanup();
    }
  }
}

module.exports = new ScriptService();
