const { spawn } = require('child_process');
const { getDb } = require('../db/database');
const logger = require('./logger').child('SCRIPT_CHAINS');
const runtimeActivityService = require('./runtimeActivityService');
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
    orderIndex: Number(row.order_index || 0),
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

function terminateChildProcess(child) {
  if (!child) {
    return;
  }
  try {
    child.kill('SIGTERM');
  } catch (_error) {
    return;
  }
  const forceKillTimer = setTimeout(() => {
    try {
      if (!child.killed) {
        child.kill('SIGKILL');
      }
    } catch (_error) {
      // ignore
    }
  }, 2000);
  if (typeof forceKillTimer.unref === 'function') {
    forceKillTimer.unref();
  }
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
        SELECT id, name, order_index, created_at, updated_at
        FROM script_chains
        ORDER BY order_index ASC, id ASC
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
      `SELECT id, name, order_index, created_at, updated_at FROM script_chains WHERE id = ?`,
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
      `SELECT id, name, order_index, created_at, updated_at FROM script_chains WHERE id IN (${placeholders})`,
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
      const nextOrderIndex = await this._getNextOrderIndex(db);
      const result = await db.run(
        `
          INSERT INTO script_chains (name, order_index, created_at, updated_at)
          VALUES (?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        `,
        [name, nextOrderIndex]
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

  async reorderChains(orderedIds = []) {
    const providedIds = Array.isArray(orderedIds)
      ? orderedIds.map(normalizeChainId).filter(Boolean)
      : [];
    const db = await getDb();
    const rows = await db.all(
      `
        SELECT id
        FROM script_chains
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
            UPDATE script_chains
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

    return this.listChains();
  }

  async _getNextOrderIndex(db) {
    const row = await db.get(
      `
        SELECT COALESCE(MAX(order_index), 0) AS max_order_index
        FROM script_chains
      `
    );
    const maxOrder = Number(row?.max_order_index || 0);
    if (!Number.isFinite(maxOrder) || maxOrder < 0) {
      return 1;
    }
    return Math.trunc(maxOrder) + 1;
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
    const totalSteps = chain.steps.length;
    const activityId = runtimeActivityService.startActivity('chain', {
      name: chain.name,
      source: context?.source || 'chain',
      chainId: chain.id,
      jobId: context?.jobId || null,
      cronJobId: context?.cronJobId || null,
      parentActivityId: context?.runtimeParentActivityId || null,
      currentStep: totalSteps > 0 ? `Schritt 1/${totalSteps}` : 'Keine Schritte'
    });
    const controlState = {
      cancelRequested: false,
      cancelReason: null,
      currentStepType: null,
      activeWaitResolve: null,
      activeChild: null,
      activeChildTermination: null
    };
    const emitRuntimeStep = (payload = {}) => {
      if (typeof context?.onRuntimeStep !== 'function') {
        return;
      }
      try {
        context.onRuntimeStep({
          chainId: chain.id,
          chainName: chain.name,
          ...payload
        });
      } catch (_error) {
        // ignore runtime callback errors
      }
    };
    const requestCancel = async (payload = {}) => {
      if (controlState.cancelRequested) {
        return { accepted: true, alreadyRequested: true, message: 'Abbruch bereits angefordert.' };
      }
      controlState.cancelRequested = true;
      controlState.cancelReason = String(payload?.reason || '').trim() || 'Von Benutzer abgebrochen';
      runtimeActivityService.updateActivity(activityId, {
        message: 'Abbruch angefordert',
        currentStep: controlState.currentStepType ? `Abbruch läuft (${controlState.currentStepType})` : 'Abbruch angefordert'
      });
      if (typeof appendLog === 'function') {
        try {
          await appendLog('SYSTEM', `Kette "${chain.name}" - Abbruch angefordert.`);
        } catch (_error) {
          // ignore appendLog failures for control actions
        }
      }
      if (controlState.currentStepType === STEP_TYPE_WAIT && typeof controlState.activeWaitResolve === 'function') {
        controlState.activeWaitResolve('cancel');
      } else if (controlState.currentStepType === STEP_TYPE_SCRIPT && controlState.activeChild) {
        controlState.activeChildTermination = 'cancel';
        terminateChildProcess(controlState.activeChild);
      }
      return { accepted: true, message: 'Abbruch angefordert.' };
    };
    const requestNextStep = async () => {
      if (controlState.cancelRequested) {
        return { accepted: false, message: 'Kette wird bereits abgebrochen.' };
      }
      if (controlState.currentStepType === STEP_TYPE_WAIT && typeof controlState.activeWaitResolve === 'function') {
        controlState.activeWaitResolve('skip');
        runtimeActivityService.updateActivity(activityId, {
          message: 'Nächster Schritt angefordert (Wait übersprungen)'
        });
        if (typeof appendLog === 'function') {
          try {
            await appendLog('SYSTEM', `Kette "${chain.name}" - Wait-Schritt manuell übersprungen.`);
          } catch (_error) {
            // ignore appendLog failures for control actions
          }
        }
        return { accepted: true, message: 'Wait-Schritt übersprungen.' };
      }
      if (controlState.currentStepType === STEP_TYPE_SCRIPT && controlState.activeChild) {
        controlState.activeChildTermination = 'skip';
        terminateChildProcess(controlState.activeChild);
        runtimeActivityService.updateActivity(activityId, {
          message: 'Nächster Schritt angefordert (aktuelles Skript wird übersprungen)'
        });
        if (typeof appendLog === 'function') {
          try {
            await appendLog('SYSTEM', `Kette "${chain.name}" - Skript-Schritt manuell übersprungen.`);
          } catch (_error) {
            // ignore appendLog failures for control actions
          }
        }
        return { accepted: true, message: 'Skript-Schritt wird übersprungen.' };
      }
      return { accepted: false, message: 'Kein aktiver Schritt zum Überspringen.' };
    };
    runtimeActivityService.setControls(activityId, {
      cancel: requestCancel,
      nextStep: requestNextStep
    });

    const results = [];
    let completionPayload = null;
    let abortedByUser = false;
    try {
      for (let index = 0; index < chain.steps.length; index += 1) {
        if (controlState.cancelRequested) {
          abortedByUser = true;
          break;
        }
        const step = chain.steps[index];
        const stepIndex = index + 1;
        if (step.stepType === STEP_TYPE_WAIT) {
          const seconds = Math.max(1, Number(step.waitSeconds || 1));
          const waitLabel = `Warte ${seconds} Sekunde(n)`;
          controlState.currentStepType = STEP_TYPE_WAIT;
          runtimeActivityService.updateActivity(activityId, {
            currentStepType: 'wait',
            currentStep: waitLabel,
            currentScriptName: null,
            stepIndex,
            stepTotal: totalSteps
          });
          emitRuntimeStep({
            stepType: 'wait',
            stepIndex,
            stepTotal: totalSteps,
            currentStep: waitLabel
          });
          logger.info('chain:step:wait', { chainId, seconds });
          if (typeof appendLog === 'function') {
            await appendLog('SYSTEM', `Kette "${chain.name}" - Warte ${seconds} Sekunde(n)...`);
          }
          const waitOutcome = await new Promise((resolve) => {
            const timer = setTimeout(() => {
              controlState.activeWaitResolve = null;
              resolve('done');
            }, seconds * 1000);
            controlState.activeWaitResolve = (mode = 'done') => {
              clearTimeout(timer);
              controlState.activeWaitResolve = null;
              resolve(mode);
            };
          });
          controlState.currentStepType = null;
          if (waitOutcome === 'skip') {
            results.push({ stepType: 'wait', waitSeconds: seconds, success: true, skipped: true, reason: 'skipped_by_user' });
            continue;
          }
          if (waitOutcome === 'cancel' || controlState.cancelRequested) {
            abortedByUser = true;
            results.push({ stepType: 'wait', waitSeconds: seconds, success: false, aborted: true, reason: 'cancelled_by_user' });
            break;
          }
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

          controlState.currentStepType = STEP_TYPE_SCRIPT;
          runtimeActivityService.updateActivity(activityId, {
            currentStepType: 'script',
            currentStep: `Skript: ${script.name}`,
            currentScriptName: script.name,
            stepIndex,
            stepTotal: totalSteps,
            scriptId: script.id
          });
          emitRuntimeStep({
            stepType: 'script',
            stepIndex,
            stepTotal: totalSteps,
            scriptId: script.id,
            scriptName: script.name,
            currentScriptName: script.name,
            currentStep: `Skript: ${script.name}`
          });

          if (typeof appendLog === 'function') {
            await appendLog('SYSTEM', `Kette "${chain.name}" - Skript: ${script.name}`);
          }

          const scriptActivityId = runtimeActivityService.startActivity('script', {
            name: script.name,
            source: context?.source || 'chain',
            scriptId: script.id,
            chainId: chain.id,
            jobId: context?.jobId || null,
            cronJobId: context?.cronJobId || null,
            parentActivityId: activityId,
            currentStep: `Kette: ${chain.name}`
          });

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
              controlState.activeChild = child;
              controlState.activeChildTermination = null;
              let stdout = '';
              let stderr = '';
              child.stdout?.on('data', (chunk) => { stdout += String(chunk); });
              child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
              child.on('error', (error) => {
                controlState.activeChild = null;
                reject(error);
              });
              child.on('close', (code, signal) => {
                const termination = controlState.activeChildTermination;
                controlState.activeChild = null;
                controlState.activeChildTermination = null;
                resolve({ code, signal, stdout, stderr, termination });
              });
            });
            controlState.currentStepType = null;

            if (run.termination === 'skip') {
              runtimeActivityService.completeActivity(scriptActivityId, {
                status: 'success',
                success: true,
                outcome: 'skipped',
                skipped: true,
                currentStep: null,
                message: 'Schritt übersprungen',
                output: [run.stdout || '', run.stderr || ''].filter(Boolean).join('\n').trim() || null
              });
              if (typeof appendLog === 'function') {
                try {
                  await appendLog('SYSTEM', `Kette "${chain.name}" - Skript "${script.name}" übersprungen.`);
                } catch (_error) {
                  // ignore appendLog failures on skip path
                }
              }
              results.push({
                stepType: 'script',
                scriptId: script.id,
                scriptName: script.name,
                success: true,
                skipped: true,
                reason: 'skipped_by_user'
              });
              continue;
            }

            if (run.termination === 'cancel' || controlState.cancelRequested) {
              abortedByUser = true;
              runtimeActivityService.completeActivity(scriptActivityId, {
                status: 'error',
                success: false,
                outcome: 'cancelled',
                cancelled: true,
                currentStep: null,
                message: controlState.cancelReason || 'Von Benutzer abgebrochen',
                output: [run.stdout || '', run.stderr || ''].filter(Boolean).join('\n').trim() || null,
                errorMessage: controlState.cancelReason || 'Von Benutzer abgebrochen'
              });
              if (typeof appendLog === 'function') {
                try {
                  await appendLog('SYSTEM', `Kette "${chain.name}" - Skript "${script.name}" abgebrochen.`);
                } catch (_error) {
                  // ignore appendLog failures on cancel path
                }
              }
              results.push({
                stepType: 'script',
                scriptId: script.id,
                scriptName: script.name,
                success: false,
                aborted: true,
                reason: 'cancelled_by_user'
              });
              break;
            }

            const success = run.code === 0;
            runtimeActivityService.completeActivity(scriptActivityId, {
              status: success ? 'success' : 'error',
              success,
              outcome: success ? 'success' : 'error',
              exitCode: run.code,
              currentStep: null,
              message: success ? null : `Fehler (Exit ${run.code})`,
              output: success ? null : [run.stdout || '', run.stderr || ''].filter(Boolean).join('\n').trim() || null,
              stderr: success ? null : (run.stderr || null),
              stdout: success ? null : (run.stdout || null),
              errorMessage: success ? null : `Fehler (Exit ${run.code})`
            });
            logger.info('chain:step:script-done', { chainId, scriptId: script.id, exitCode: run.code, success });
            if (typeof appendLog === 'function') {
              await appendLog(
                success ? 'SYSTEM' : 'ERROR',
                `Kette "${chain.name}" - Skript "${script.name}": ${success ? 'OK' : `Fehler (Exit ${run.code})`}`
              );
            }
            results.push({ stepType: 'script', scriptId: script.id, scriptName: script.name, success, exitCode: run.code, stdout: run.stdout || '', stderr: run.stderr || '' });

            if (!success) {
              logger.warn('chain:step:script-failed', { chainId, scriptId: script.id, exitCode: run.code });
              break;
            }
          } catch (error) {
            controlState.currentStepType = null;
            if (controlState.cancelRequested) {
              abortedByUser = true;
              runtimeActivityService.completeActivity(scriptActivityId, {
                status: 'error',
                success: false,
                outcome: 'cancelled',
                cancelled: true,
                message: controlState.cancelReason || 'Von Benutzer abgebrochen',
                errorMessage: controlState.cancelReason || 'Von Benutzer abgebrochen'
              });
              if (typeof appendLog === 'function') {
                try {
                  await appendLog('SYSTEM', `Kette "${chain.name}" - Skript "${script.name}" abgebrochen.`);
                } catch (_error) {
                  // ignore appendLog failures on cancel path
                }
              }
              results.push({
                stepType: 'script',
                scriptId: script.id,
                scriptName: script.name,
                success: false,
                aborted: true,
                reason: 'cancelled_by_user'
              });
              break;
            }
            runtimeActivityService.completeActivity(scriptActivityId, {
              status: 'error',
              success: false,
              outcome: 'error',
              message: error?.message || 'unknown',
              errorMessage: error?.message || 'unknown'
            });
            logger.error('chain:step:script-error', { chainId, scriptId: step.scriptId, error: errorToMeta(error) });
            if (typeof appendLog === 'function') {
              await appendLog('ERROR', `Kette "${chain.name}" - Skript-Fehler: ${error.message}`);
            }
            results.push({ stepType: 'script', scriptId: step.scriptId, success: false, error: error.message });
            break;
          } finally {
            controlState.activeChild = null;
            controlState.activeChildTermination = null;
            if (prepared?.cleanup) {
              await prepared.cleanup();
            }
          }
        }
      }

      const succeeded = results.filter((r) => r.success).length;
      const skipped = results.filter((r) => r.skipped).length;
      const failed = results.filter((r) => !r.success && !r.skipped && !r.aborted).length;
      logger.info('chain:execute:done', { chainId, steps: results.length, succeeded, failed, skipped, abortedByUser });
      if (abortedByUser) {
        completionPayload = {
          status: 'error',
          success: false,
          outcome: 'cancelled',
          cancelled: true,
          currentStep: null,
          currentScriptName: null,
          message: controlState.cancelReason || 'Von Benutzer abgebrochen',
          errorMessage: controlState.cancelReason || 'Von Benutzer abgebrochen'
        };
        emitRuntimeStep({
          finished: true,
          success: false,
          aborted: true,
          failed,
          succeeded
        });
        return {
          chainId,
          chainName: chain.name,
          steps: results.length,
          succeeded,
          failed,
          skipped,
          aborted: true,
          abortedByUser: true,
          results
        };
      }
      completionPayload = {
        status: failed > 0 ? 'error' : 'success',
        success: failed === 0,
        outcome: failed > 0 ? 'error' : (skipped > 0 ? 'skipped' : 'success'),
        skipped: skipped > 0,
        currentStep: null,
        currentScriptName: null,
        message: failed > 0
          ? `${failed} Schritt(e) fehlgeschlagen`
          : (skipped > 0
            ? `${succeeded} Schritt(e) erfolgreich, ${skipped} übersprungen`
            : `${succeeded} Schritt(e) erfolgreich`)
      };
      emitRuntimeStep({
        finished: true,
        success: failed === 0,
        failed,
        succeeded
      });

      return {
        chainId,
        chainName: chain.name,
        steps: results.length,
        succeeded,
        failed,
        skipped,
        aborted: failed > 0,
        results
      };
    } catch (error) {
      completionPayload = {
        status: 'error',
        success: false,
        outcome: 'error',
        message: error?.message || 'unknown',
        errorMessage: error?.message || 'unknown',
        currentStep: null
      };
      throw error;
    } finally {
      runtimeActivityService.completeActivity(activityId, completionPayload || {
        status: 'error',
        success: false,
        outcome: 'error',
        message: 'Kette unerwartet beendet',
        errorMessage: 'Kette unerwartet beendet',
        currentStep: null
      });
    }
  }
}

module.exports = new ScriptChainService();
