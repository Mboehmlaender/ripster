const { spawn } = require('child_process');
const { getDb } = require('../db/database');
const logger = require('./logger').child('SCRIPT_CHAINS');
const { errorToMeta } = require('../utils/errorMeta');

const CHAIN_NAME_MAX_LENGTH = 120;
const STEP_TYPE_SCRIPT = 'script';
const STEP_TYPE_WAIT = 'wait';
const VALID_STEP_TYPES = new Set([STEP_TYPE_SCRIPT, STEP_TYPE_WAIT]);

function normalizeChainId(rawValue) {
  const value = Number(rawValue);
  if (!Number.isFinite(value) || value <= 0) {
    return null;
  }
  return Math.trunc(value);
}

function createValidationError(message, details = null) {
  const error = new Error(message);
  error.statusCode = 400;
  if (details) {
    error.details = details;
  }
  return error;
}

function mapChainRow(row, steps = []) {
  if (!row) {
    return null;
  }
  return {
    id: Number(row.id),
    name: String(row.name || ''),
    steps: steps.map(mapStepRow),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapStepRow(row) {
  if (!row) {
    return null;
  }
  return {
    id: Number(row.id),
    position: Number(row.position),
    stepType: String(row.step_type || ''),
    scriptId: row.script_id != null ? Number(row.script_id) : null,
    scriptName: row.script_name != null ? String(row.script_name) : null,
    waitSeconds: row.wait_seconds != null ? Number(row.wait_seconds) : null
  };
}

function validateSteps(rawSteps) {
  const steps = Array.isArray(rawSteps) ? rawSteps : [];
  const errors = [];
  const normalized = [];

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i] && typeof steps[i] === 'object' ? steps[i] : {};
    const stepType = String(step.stepType || step.step_type || '').trim();

    if (!VALID_STEP_TYPES.has(stepType)) {
      errors.push({ field: `steps[${i}].stepType`, message: `Ungültiger Schritt-Typ: '${stepType}'. Erlaubt: script, wait.` });
      continue;
    }

    if (stepType === STEP_TYPE_SCRIPT) {
      const scriptId = Number(step.scriptId ?? step.script_id);
      if (!Number.isFinite(scriptId) || scriptId <= 0) {
        errors.push({ field: `steps[${i}].scriptId`, message: 'scriptId fehlt oder ist ungültig.' });
        continue;
      }
      normalized.push({ stepType, scriptId: Math.trunc(scriptId), waitSeconds: null });
    } else if (stepType === STEP_TYPE_WAIT) {
      const waitSeconds = Number(step.waitSeconds ?? step.wait_seconds);
      if (!Number.isFinite(waitSeconds) || waitSeconds < 1 || waitSeconds > 3600) {
        errors.push({ field: `steps[${i}].waitSeconds`, message: 'waitSeconds muss zwischen 1 und 3600 liegen.' });
        continue;
      }
      normalized.push({ stepType, scriptId: null, waitSeconds: Math.round(waitSeconds) });
    }
  }

  if (errors.length > 0) {
    throw createValidationError('Ungültige Schritte in der Skriptkette.', errors);
  }

  return normalized;
}

async function getStepsForChain(db, chainId) {
  return db.all(
    `
      SELECT
        s.id,
        s.chain_id,
        s.position,
        s.step_type,
        s.script_id,
        s.wait_seconds,
        sc.name AS script_name
      FROM script_chain_steps s
      LEFT JOIN scripts sc ON sc.id = s.script_id
      WHERE s.chain_id = ?
      ORDER BY s.position ASC, s.id ASC
    `,
    [chainId]
  );
}

class ScriptChainService {
  async listChains() {
    const db = await getDb();
    const rows = await db.all(
      `
        SELECT id, name, created_at, updated_at
        FROM script_chains
        ORDER BY LOWER(name) ASC, id ASC
      `
    );

    if (rows.length === 0) {
      return [];
    }

    const chainIds = rows.map((row) => Number(row.id));
    const placeholders = chainIds.map(() => '?').join(', ');
    const stepRows = await db.all(
      `
        SELECT
          s.id,
          s.chain_id,
          s.position,
          s.step_type,
          s.script_id,
          s.wait_seconds,
          sc.name AS script_name
        FROM script_chain_steps s
        LEFT JOIN scripts sc ON sc.id = s.script_id
        WHERE s.chain_id IN (${placeholders})
        ORDER BY s.chain_id ASC, s.position ASC, s.id ASC
      `,
      chainIds
    );

    const stepsByChain = new Map();
    for (const step of stepRows) {
      const cid = Number(step.chain_id);
      if (!stepsByChain.has(cid)) {
        stepsByChain.set(cid, []);
      }
      stepsByChain.get(cid).push(step);
    }

    return rows.map((row) => mapChainRow(row, stepsByChain.get(Number(row.id)) || []));
  }

  async getChainById(chainId) {
    const normalizedId = normalizeChainId(chainId);
    if (!normalizedId) {
      throw createValidationError('Ungültige chainId.');
    }
    const db = await getDb();
    const row = await db.get(
      `SELECT id, name, created_at, updated_at FROM script_chains WHERE id = ?`,
      [normalizedId]
    );
    if (!row) {
      const error = new Error(`Skriptkette #${normalizedId} wurde nicht gefunden.`);
      error.statusCode = 404;
      throw error;
    }
    const steps = await getStepsForChain(db, normalizedId);
    return mapChainRow(row, steps);
  }

  async getChainsByIds(rawIds = []) {
    const ids = Array.isArray(rawIds)
      ? rawIds.map(normalizeChainId).filter(Boolean)
      : [];
    if (ids.length === 0) {
      return [];
    }
    const db = await getDb();
    const placeholders = ids.map(() => '?').join(', ');
    const rows = await db.all(
      `SELECT id, name, created_at, updated_at FROM script_chains WHERE id IN (${placeholders})`,
      ids
    );
    const stepRows = await db.all(
      `
        SELECT
          s.id, s.chain_id, s.position, s.step_type, s.script_id, s.wait_seconds,
          sc.name AS script_name
        FROM script_chain_steps s
        LEFT JOIN scripts sc ON sc.id = s.script_id
        WHERE s.chain_id IN (${placeholders})
        ORDER BY s.chain_id ASC, s.position ASC, s.id ASC
      `,
      ids
    );
    const stepsByChain = new Map();
    for (const step of stepRows) {
      const cid = Number(step.chain_id);
      if (!stepsByChain.has(cid)) {
        stepsByChain.set(cid, []);
      }
      stepsByChain.get(cid).push(step);
    }
    const byId = new Map(rows.map((row) => [
      Number(row.id),
      mapChainRow(row, stepsByChain.get(Number(row.id)) || [])
    ]));
    return ids.map((id) => byId.get(id)).filter(Boolean);
  }

  async createChain(payload = {}) {
    const body = payload && typeof payload === 'object' ? payload : {};
    const name = String(body.name || '').trim();
    if (!name) {
      throw createValidationError('Skriptkettenname darf nicht leer sein.', [{ field: 'name', message: 'Name darf nicht leer sein.' }]);
    }
    if (name.length > CHAIN_NAME_MAX_LENGTH) {
      throw createValidationError('Skriptkettenname zu lang.', [{ field: 'name', message: `Maximal ${CHAIN_NAME_MAX_LENGTH} Zeichen.` }]);
    }
    const steps = validateSteps(body.steps);

    const db = await getDb();
    try {
      const result = await db.run(
        `INSERT INTO script_chains (name, created_at, updated_at) VALUES (?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [name]
      );
      const chainId = result.lastID;
      await this._saveSteps(db, chainId, steps);
      return this.getChainById(chainId);
    } catch (error) {
      if (String(error?.message || '').includes('UNIQUE constraint failed')) {
        throw createValidationError(`Skriptkettenname "${name}" existiert bereits.`, [{ field: 'name', message: 'Name muss eindeutig sein.' }]);
      }
      throw error;
    }
  }

  async updateChain(chainId, payload = {}) {
    const normalizedId = normalizeChainId(chainId);
    if (!normalizedId) {
      throw createValidationError('Ungültige chainId.');
    }
    const body = payload && typeof payload === 'object' ? payload : {};
    const name = String(body.name || '').trim();
    if (!name) {
      throw createValidationError('Skriptkettenname darf nicht leer sein.', [{ field: 'name', message: 'Name darf nicht leer sein.' }]);
    }
    if (name.length > CHAIN_NAME_MAX_LENGTH) {
      throw createValidationError('Skriptkettenname zu lang.', [{ field: 'name', message: `Maximal ${CHAIN_NAME_MAX_LENGTH} Zeichen.` }]);
    }
    const steps = validateSteps(body.steps);

    await this.getChainById(normalizedId);

    const db = await getDb();
    try {
      await db.run(
        `UPDATE script_chains SET name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
        [name, normalizedId]
      );
      await db.run(`DELETE FROM script_chain_steps WHERE chain_id = ?`, [normalizedId]);
      await this._saveSteps(db, normalizedId, steps);
      return this.getChainById(normalizedId);
    } catch (error) {
      if (String(error?.message || '').includes('UNIQUE constraint failed')) {
        throw createValidationError(`Skriptkettenname "${name}" existiert bereits.`, [{ field: 'name', message: 'Name muss eindeutig sein.' }]);
      }
      throw error;
    }
  }

  async deleteChain(chainId) {
    const normalizedId = normalizeChainId(chainId);
    if (!normalizedId) {
      throw createValidationError('Ungültige chainId.');
    }
    const existing = await this.getChainById(normalizedId);
    const db = await getDb();
    await db.run(`DELETE FROM script_chains WHERE id = ?`, [normalizedId]);
    return existing;
  }

  async _saveSteps(db, chainId, steps) {
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      await db.run(
        `
          INSERT INTO script_chain_steps (chain_id, position, step_type, script_id, wait_seconds, created_at)
          VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        `,
        [chainId, i + 1, step.stepType, step.scriptId ?? null, step.waitSeconds ?? null]
      );
    }
  }

  async executeChain(chainId, context = {}, { appendLog = null } = {}) {
    const chain = await this.getChainById(chainId);
    logger.info('chain:execute:start', { chainId, chainName: chain.name, steps: chain.steps.length });

    const results = [];

    for (const step of chain.steps) {
      if (step.stepType === STEP_TYPE_WAIT) {
        const seconds = Math.max(1, Number(step.waitSeconds || 1));
        logger.info('chain:step:wait', { chainId, seconds });
        if (typeof appendLog === 'function') {
          await appendLog('SYSTEM', `Kette "${chain.name}" - Warte ${seconds} Sekunde(n)...`);
        }
        await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
        results.push({ stepType: 'wait', waitSeconds: seconds, success: true });
      } else if (step.stepType === STEP_TYPE_SCRIPT) {
        if (!step.scriptId) {
          logger.warn('chain:step:script-missing', { chainId, stepId: step.id });
          results.push({ stepType: 'script', scriptId: null, success: false, skipped: true, reason: 'scriptId fehlt' });
          continue;
        }

        const scriptService = require('./scriptService');
        let script;
        try {
          script = await scriptService.getScriptById(step.scriptId);
        } catch (error) {
          logger.warn('chain:step:script-not-found', { chainId, scriptId: step.scriptId, error: errorToMeta(error) });
          results.push({ stepType: 'script', scriptId: step.scriptId, success: false, skipped: true, reason: 'Skript nicht gefunden' });
          continue;
        }

        if (typeof appendLog === 'function') {
          await appendLog('SYSTEM', `Kette "${chain.name}" - Skript: ${script.name}`);
        }

        let prepared = null;
        try {
          prepared = await scriptService.createExecutableScriptFile(script, {
            ...context,
            scriptId: script.id,
            scriptName: script.name,
            source: context?.source || 'chain'
          });
          const run = await new Promise((resolve, reject) => {
            const child = spawn(prepared.cmd, prepared.args, {
              env: process.env,
              stdio: ['ignore', 'pipe', 'pipe']
            });
            let stdout = '';
            let stderr = '';
            child.stdout?.on('data', (chunk) => { stdout += String(chunk); });
            child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
            child.on('error', reject);
            child.on('close', (code) => resolve({ code, stdout, stderr }));
          });

          const success = run.code === 0;
          logger.info('chain:step:script-done', { chainId, scriptId: script.id, exitCode: run.code, success });
          if (typeof appendLog === 'function') {
            await appendLog(
              success ? 'SYSTEM' : 'ERROR',
              `Kette "${chain.name}" - Skript "${script.name}": ${success ? 'OK' : `Fehler (Exit ${run.code})`}`
            );
          }
          results.push({ stepType: 'script', scriptId: script.id, scriptName: script.name, success, exitCode: run.code });

          if (!success) {
            logger.warn('chain:step:script-failed', { chainId, scriptId: script.id, exitCode: run.code });
            break;
          }
        } catch (error) {
          logger.error('chain:step:script-error', { chainId, scriptId: step.scriptId, error: errorToMeta(error) });
          if (typeof appendLog === 'function') {
            await appendLog('ERROR', `Kette "${chain.name}" - Skript-Fehler: ${error.message}`);
          }
          results.push({ stepType: 'script', scriptId: step.scriptId, success: false, error: error.message });
          break;
        } finally {
          if (prepared?.cleanup) {
            await prepared.cleanup();
          }
        }
      }
    }

    const succeeded = results.filter((r) => r.success).length;
    const failed = results.filter((r) => !r.success && !r.skipped).length;
    logger.info('chain:execute:done', { chainId, steps: results.length, succeeded, failed });

    return {
      chainId,
      chainName: chain.name,
      steps: results.length,
      succeeded,
      failed,
      aborted: failed > 0,
      results
    };
  }
}

module.exports = new ScriptChainService();
