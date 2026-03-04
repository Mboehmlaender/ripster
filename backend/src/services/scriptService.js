const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { getDb } = require('../db/database');
const logger = require('./logger').child('SCRIPTS');
const { errorToMeta } = require('../utils/errorMeta');

const SCRIPT_NAME_MAX_LENGTH = 120;
const SCRIPT_BODY_MAX_LENGTH = 200000;
const SCRIPT_TEST_TIMEOUT_MS = 120000;
const SCRIPT_OUTPUT_MAX_CHARS = 150000;

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

function runProcessCapture({ cmd, args, timeoutMs = SCRIPT_TEST_TIMEOUT_MS, cwd = process.cwd() }) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const child = spawn(cmd, args, {
      cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => {
        if (!child.killed) {
          child.kill('SIGKILL');
        }
      }, 2000);
    }, Math.max(1000, Number(timeoutMs || SCRIPT_TEST_TIMEOUT_MS)));

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

    child.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });

    child.on('close', (code, signal) => {
      clearTimeout(timeout);
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

class ScriptService {
  async listScripts() {
    const db = await getDb();
    const rows = await db.all(
      `
        SELECT id, name, script_body, created_at, updated_at
        FROM scripts
        ORDER BY LOWER(name) ASC, id ASC
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
        SELECT id, name, script_body, created_at, updated_at
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
      const result = await db.run(
        `
          INSERT INTO scripts (name, script_body, created_at, updated_at)
          VALUES (?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        `,
        [normalized.name, normalized.scriptBody]
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
        SELECT id, name, script_body, created_at, updated_at
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
    const timeoutMs = Number(options?.timeoutMs);
    const prepared = await this.createExecutableScriptFile(script, {
      source: 'settings_test',
      mode: 'test'
    });

    try {
      const run = await runProcessCapture({
        cmd: prepared.cmd,
        args: prepared.args,
        timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : SCRIPT_TEST_TIMEOUT_MS
      });
      const success = run.code === 0 && !run.timedOut;
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
    } finally {
      await prepared.cleanup();
    }
  }
}

module.exports = new ScriptService();
