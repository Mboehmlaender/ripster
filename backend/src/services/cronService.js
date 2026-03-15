/**
 * cronService.js
 * Verwaltet und führt Cronjobs aus (Skripte oder Skriptketten).
 * Kein externer Package nötig – eigener Cron-Expression-Parser.
 */

const { getDb } = require('../db/database');
const logger = require('./logger').child('CRON');
const notificationService = require('./notificationService');
const settingsService = require('./settingsService');
const wsService = require('./websocketService');
const runtimeActivityService = require('./runtimeActivityService');
const { spawnTrackedProcess } = require('./processRunner');
const { errorToMeta } = require('../utils/errorMeta');

// Maximale Zeilen pro Log-Eintrag (Output-Truncation)
const MAX_OUTPUT_CHARS = 100000;
// Maximale Log-Einträge pro Cron-Job (ältere werden gelöscht)
const MAX_LOGS_PER_JOB = 50;

// ─── Cron-Expression-Parser ────────────────────────────────────────────────

// Parst ein einzelnes Cron-Feld (z.B. "* /5", "1,3,5", "1-5", "*") und gibt
// alle erlaubten Werte als Set zurück.
function parseCronField(field, min, max) {
  const values = new Set();

  for (const part of field.split(',')) {
    const trimmed = part.trim();
    if (trimmed === '*') {
      for (let i = min; i <= max; i++) values.add(i);
    } else if (trimmed.startsWith('*/')) {
      const step = parseInt(trimmed.slice(2), 10);
      if (!Number.isFinite(step) || step < 1) throw new Error(`Ungültiges Step: ${trimmed}`);
      for (let i = min; i <= max; i += step) values.add(i);
    } else if (trimmed.includes('-')) {
      const [startStr, endStr] = trimmed.split('-');
      const start = parseInt(startStr, 10);
      const end = parseInt(endStr, 10);
      if (!Number.isFinite(start) || !Number.isFinite(end)) throw new Error(`Ungültiger Bereich: ${trimmed}`);
      for (let i = Math.max(min, start); i <= Math.min(max, end); i++) values.add(i);
    } else {
      const num = parseInt(trimmed, 10);
      if (!Number.isFinite(num) || num < min || num > max) throw new Error(`Ungültiger Wert: ${trimmed}`);
      values.add(num);
    }
  }

  return values;
}

/**
 * Validiert eine Cron-Expression (5 Felder: minute hour day month weekday).
 * Gibt { valid: true } oder { valid: false, error: string } zurück.
 */
function validateCronExpression(expr) {
  try {
    const parts = String(expr || '').trim().split(/\s+/);
    if (parts.length !== 5) {
      return { valid: false, error: 'Cron-Ausdruck muss genau 5 Felder haben (Minute Stunde Tag Monat Wochentag).' };
    }
    parseCronField(parts[0], 0, 59);  // minute
    parseCronField(parts[1], 0, 23);  // hour
    parseCronField(parts[2], 1, 31);  // day of month
    parseCronField(parts[3], 1, 12);  // month
    parseCronField(parts[4], 0, 7);   // weekday (0 und 7 = Sonntag)
    return { valid: true };
  } catch (error) {
    return { valid: false, error: error.message };
  }
}

/**
 * Berechnet den nächsten Ausführungszeitpunkt nach einem Datum.
 * Gibt ein Date-Objekt zurück oder null bei Fehler.
 */
function getNextRunTime(expr, fromDate = new Date()) {
  try {
    const parts = String(expr || '').trim().split(/\s+/);
    if (parts.length !== 5) return null;

    const minutes  = parseCronField(parts[0], 0, 59);
    const hours    = parseCronField(parts[1], 0, 23);
    const days     = parseCronField(parts[2], 1, 31);
    const months   = parseCronField(parts[3], 1, 12);
    const weekdays = parseCronField(parts[4], 0, 7);

    // Normalisiere Wochentag: 7 → 0 (beide = Sonntag)
    if (weekdays.has(7)) weekdays.add(0);

    // Suche ab der nächsten Minute
    const candidate = new Date(fromDate);
    candidate.setSeconds(0, 0);
    candidate.setMinutes(candidate.getMinutes() + 1);

    // Maximal 2 Jahre in die Zukunft suchen
    const limit = new Date(fromDate);
    limit.setFullYear(limit.getFullYear() + 2);

    while (candidate < limit) {
      const month   = candidate.getMonth() + 1; // 1-12
      const day     = candidate.getDate();
      const hour    = candidate.getHours();
      const minute  = candidate.getMinutes();
      const weekday = candidate.getDay();       // 0 = Sonntag

      if (!months.has(month)) {
        candidate.setMonth(candidate.getMonth() + 1, 1);
        candidate.setHours(0, 0, 0, 0);
        continue;
      }
      if (!days.has(day) || !weekdays.has(weekday)) {
        candidate.setDate(candidate.getDate() + 1);
        candidate.setHours(0, 0, 0, 0);
        continue;
      }
      if (!hours.has(hour)) {
        candidate.setHours(candidate.getHours() + 1, 0, 0, 0);
        continue;
      }
      if (!minutes.has(minute)) {
        candidate.setMinutes(candidate.getMinutes() + 1, 0, 0);
        continue;
      }

      return candidate;
    }

    return null;
  } catch (_error) {
    return null;
  }
}

// ─── DB-Helpers ────────────────────────────────────────────────────────────

function mapJobRow(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    name: String(row.name || ''),
    cronExpression: String(row.cron_expression || ''),
    sourceType: String(row.source_type || ''),
    sourceId: Number(row.source_id),
    sourceName: row.source_name != null ? String(row.source_name) : null,
    enabled: Boolean(row.enabled),
    pushoverEnabled: Boolean(row.pushover_enabled),
    lastRunAt: row.last_run_at || null,
    lastRunStatus: row.last_run_status || null,
    nextRunAt: row.next_run_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapLogRow(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    cronJobId: Number(row.cron_job_id),
    startedAt: row.started_at,
    finishedAt: row.finished_at || null,
    status: String(row.status || ''),
    output: row.output || null,
    errorMessage: row.error_message || null
  };
}

async function fetchJobWithSource(db, id) {
  return db.get(
    `
    SELECT
      c.*,
      CASE c.source_type
        WHEN 'script' THEN (SELECT name FROM scripts WHERE id = c.source_id)
        WHEN 'chain'  THEN (SELECT name FROM script_chains WHERE id = c.source_id)
        ELSE NULL
      END AS source_name
    FROM cron_jobs c
    WHERE c.id = ?
    LIMIT 1
    `,
    [id]
  );
}

async function fetchAllJobsWithSource(db) {
  return db.all(
    `
    SELECT
      c.*,
      CASE c.source_type
        WHEN 'script' THEN (SELECT name FROM scripts WHERE id = c.source_id)
        WHEN 'chain'  THEN (SELECT name FROM script_chains WHERE id = c.source_id)
        ELSE NULL
      END AS source_name
    FROM cron_jobs c
    ORDER BY c.id ASC
    `
  );
}

// ─── Ausführungslogik ──────────────────────────────────────────────────────

async function runCronJob(job) {
  const db = await getDb();
  const startedAt = new Date().toISOString();
  const cronActivityId = runtimeActivityService.startActivity('cron', {
    name: job?.name || `Cron #${job?.id || '?'}`,
    source: 'cron',
    cronJobId: job?.id || null,
    currentStep: 'Starte Cronjob'
  });

  logger.info('cron:run:start', { cronJobId: job.id, name: job.name, sourceType: job.sourceType, sourceId: job.sourceId });

  // Log-Eintrag anlegen (status = 'running')
  const insertResult = await db.run(
    `INSERT INTO cron_run_logs (cron_job_id, started_at, status) VALUES (?, ?, 'running')`,
    [job.id, startedAt]
  );
  const logId = insertResult.lastID;

  // Job als laufend markieren
  await db.run(
    `UPDATE cron_jobs SET last_run_at = ?, last_run_status = 'running', updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    [startedAt, job.id]
  );
  wsService.broadcast('CRON_JOB_UPDATED', { id: job.id, lastRunStatus: 'running', lastRunAt: startedAt });

  let output = '';
  let errorMessage = null;
  let success = false;

  try {
    if (job.sourceType === 'script') {
      const scriptService = require('./scriptService');
      const script = await scriptService.getScriptById(job.sourceId);
      runtimeActivityService.updateActivity(cronActivityId, {
        currentStepType: 'script',
        currentStep: `Skript: ${script.name}`,
        currentScriptName: script.name,
        scriptId: script.id
      });
      const scriptActivityId = runtimeActivityService.startActivity('script', {
        name: script.name,
        source: 'cron',
        scriptId: script.id,
        cronJobId: job.id,
        parentActivityId: cronActivityId,
        currentStep: `Cronjob: ${job.name}`
      });
      let prepared = null;
      try {
        prepared = await scriptService.createExecutableScriptFile(script, { source: 'cron', cronJobId: job.id });
        let stdout = '';
        let stderr = '';
        let stdoutTruncated = false;
        let stderrTruncated = false;
        const processHandle = spawnTrackedProcess({
          cmd: prepared.cmd,
          args: prepared.args,
          context: { source: 'cron', cronJobId: job.id, scriptId: script.id },
          onStdoutLine: (line) => {
            const next = stdout.length <= MAX_OUTPUT_CHARS
              ? `${stdout}${line}\n`
              : stdout;
            stdout = next.length > MAX_OUTPUT_CHARS ? next.slice(-MAX_OUTPUT_CHARS) : next;
            stdoutTruncated = stdoutTruncated || next.length > MAX_OUTPUT_CHARS;
            runtimeActivityService.appendActivityOutput(scriptActivityId, { stdout: line });
          },
          onStderrLine: (line) => {
            const next = stderr.length <= MAX_OUTPUT_CHARS
              ? `${stderr}${line}\n`
              : stderr;
            stderr = next.length > MAX_OUTPUT_CHARS ? next.slice(-MAX_OUTPUT_CHARS) : next;
            stderrTruncated = stderrTruncated || next.length > MAX_OUTPUT_CHARS;
            runtimeActivityService.appendActivityOutput(scriptActivityId, { stderr: line });
          }
        });
        let exitCode = 0;
        try {
          const result = await processHandle.promise;
          exitCode = Number.isFinite(Number(result?.code)) ? Number(result.code) : 0;
        } catch (error) {
          exitCode = Number.isFinite(Number(error?.code)) ? Number(error.code) : null;
          if (exitCode === null) {
            throw error;
          }
        }

        output = [stdout, stderr].filter(Boolean).join('\n');
        if (output.length > MAX_OUTPUT_CHARS) output = output.slice(0, MAX_OUTPUT_CHARS) + '\n...[truncated]';
        success = exitCode === 0;
        if (!success) errorMessage = `Exit-Code ${exitCode}`;
        runtimeActivityService.completeActivity(scriptActivityId, {
          status: success ? 'success' : 'error',
          success,
          outcome: success ? 'success' : 'error',
          exitCode,
          message: success ? null : errorMessage,
          output: output || null,
          stdout: stdout || null,
          stderr: stderr || null,
          stdoutTruncated,
          stderrTruncated,
          errorMessage: success ? null : (errorMessage || null)
        });
      } catch (error) {
        runtimeActivityService.completeActivity(scriptActivityId, {
          status: 'error',
          success: false,
          outcome: 'error',
          message: error?.message || 'Skriptfehler',
          errorMessage: error?.message || 'Skriptfehler'
        });
        throw error;
      } finally {
        if (prepared?.cleanup) {
          await prepared.cleanup();
        }
      }
    } else if (job.sourceType === 'chain') {
      const scriptChainService = require('./scriptChainService');
      const logLines = [];
      runtimeActivityService.updateActivity(cronActivityId, {
        currentStepType: 'chain',
        currentStep: `Kette: ${job.sourceName || `#${job.sourceId}`}`,
        currentScriptName: null,
        chainId: job.sourceId
      });
      const result = await scriptChainService.executeChain(
        job.sourceId,
        {
          source: 'cron',
          cronJobId: job.id,
          runtimeParentActivityId: cronActivityId,
          onRuntimeStep: (payload = {}) => {
            const currentScriptName = payload?.stepType === 'script'
              ? (payload?.scriptName || payload?.currentScriptName || null)
              : null;
            runtimeActivityService.updateActivity(cronActivityId, {
              currentStepType: payload?.stepType || 'chain',
              currentStep: payload?.currentStep || null,
              currentScriptName,
              scriptId: payload?.scriptId || null
            });
          }
        },
        {
          appendLog: async (_source, line) => {
            logLines.push(line);
          }
        }
      );

      output = logLines.join('\n');
      if (output.length > MAX_OUTPUT_CHARS) output = output.slice(0, MAX_OUTPUT_CHARS) + '\n...[truncated]';
      success = result && typeof result === 'object'
        ? !(Boolean(result.aborted) || Number(result.failed || 0) > 0)
        : Boolean(result);
      if (!success) errorMessage = 'Kette enthielt fehlgeschlagene Schritte.';
    } else {
      throw new Error(`Unbekannter source_type: ${job.sourceType}`);
    }
  } catch (error) {
    success = false;
    errorMessage = error.message || String(error);
    logger.error('cron:run:error', { cronJobId: job.id, error: errorToMeta(error) });
  }

  const finishedAt = new Date().toISOString();
  const status = success ? 'success' : 'error';
  const nextRunAt = getNextRunTime(job.cronExpression)?.toISOString() || null;

  // Log-Eintrag abschließen
  await db.run(
    `UPDATE cron_run_logs SET finished_at = ?, status = ?, output = ?, error_message = ? WHERE id = ?`,
    [finishedAt, status, output || null, errorMessage, logId]
  );

  // Job-Status aktualisieren
  await db.run(
    `UPDATE cron_jobs SET last_run_status = ?, next_run_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    [status, nextRunAt, job.id]
  );

  // Alte Logs trimmen
  await db.run(
    `
    DELETE FROM cron_run_logs
    WHERE cron_job_id = ?
      AND id NOT IN (
        SELECT id FROM cron_run_logs WHERE cron_job_id = ? ORDER BY id DESC LIMIT ?
      )
    `,
    [job.id, job.id, MAX_LOGS_PER_JOB]
  );

  logger.info('cron:run:done', { cronJobId: job.id, status, durationMs: new Date(finishedAt) - new Date(startedAt) });
  runtimeActivityService.completeActivity(cronActivityId, {
    status,
    success,
    outcome: success ? 'success' : 'error',
    finishedAt,
    currentStep: null,
    currentScriptName: null,
    message: success ? 'Cronjob abgeschlossen' : (errorMessage || 'Cronjob fehlgeschlagen'),
    output: output || null,
    errorMessage: success ? null : (errorMessage || null)
  });

  wsService.broadcast('CRON_JOB_UPDATED', { id: job.id, lastRunStatus: status, lastRunAt: finishedAt, nextRunAt });

  // Pushover-Benachrichtigung (nur wenn am Cron aktiviert UND global aktiviert)
  if (job.pushoverEnabled) {
    try {
      const settings = await settingsService.getSettingsMap();
      const eventKey = success ? 'cron_success' : 'cron_error';
      const title = `Ripster Cron: ${job.name}`;
      const message = success
        ? `Cronjob "${job.name}" erfolgreich ausgeführt.`
        : `Cronjob "${job.name}" fehlgeschlagen: ${errorMessage || 'Unbekannter Fehler'}`;

      await notificationService.notifyWithSettings(settings, eventKey, { title, message });
    } catch (notifyError) {
      logger.warn('cron:run:notify-failed', { cronJobId: job.id, error: errorToMeta(notifyError) });
    }
  }

  return { success, status, output, errorMessage, finishedAt, nextRunAt };
}

// ─── Scheduler ─────────────────────────────────────────────────────────────

class CronService {
  constructor() {
    this._timer = null;
    this._running = new Set(); // IDs aktuell laufender Jobs
  }

  async init() {
    logger.info('cron:scheduler:init');
    // Beim Start next_run_at für alle enabled Jobs neu berechnen
    await this._recalcNextRuns();
    this._scheduleNextTick();
  }

  stop() {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    logger.info('cron:scheduler:stopped');
  }

  _scheduleNextTick() {
    // Auf den Beginn der nächsten vollen Minute warten
    const now = new Date();
    const msUntilNextMinute = (60 - now.getSeconds()) * 1000 - now.getMilliseconds() + 500;
    this._timer = setTimeout(() => this._tick(), msUntilNextMinute);
  }

  async _tick() {
    try {
      await this._checkAndRunDueJobs();
    } catch (error) {
      logger.error('cron:scheduler:tick-error', { error: errorToMeta(error) });
    }
    this._scheduleNextTick();
  }

  async _recalcNextRuns() {
    const db = await getDb();
    const jobs = await db.all(`SELECT id, cron_expression FROM cron_jobs WHERE enabled = 1`);
    for (const job of jobs) {
      const nextRunAt = getNextRunTime(job.cron_expression)?.toISOString() || null;
      await db.run(`UPDATE cron_jobs SET next_run_at = ? WHERE id = ?`, [nextRunAt, job.id]);
    }
  }

  async _checkAndRunDueJobs() {
    const db = await getDb();
    const now = new Date();
    const nowIso = now.toISOString();

    // Jobs, deren next_run_at <= jetzt ist und die nicht gerade laufen
    const dueJobs = await db.all(
      `SELECT * FROM cron_jobs WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?`,
      [nowIso]
    );

    for (const jobRow of dueJobs) {
      const id = Number(jobRow.id);
      if (this._running.has(id)) {
        logger.warn('cron:scheduler:skip-still-running', { cronJobId: id });
        continue;
      }

      const job = mapJobRow(jobRow);
      this._running.add(id);

      // Asynchron ausführen, damit der Scheduler nicht blockiert
      runCronJob(job)
        .catch((error) => {
          logger.error('cron:run:unhandled-error', { cronJobId: id, error: errorToMeta(error) });
        })
        .finally(() => {
          this._running.delete(id);
        });
    }
  }

  // ─── Public API ──────────────────────────────────────────────────────────

  async listJobs() {
    const db = await getDb();
    const rows = await fetchAllJobsWithSource(db);
    return rows.map(mapJobRow);
  }

  async getJobById(id) {
    const db = await getDb();
    const row = await fetchJobWithSource(db, id);
    if (!row) {
      const error = new Error(`Cronjob #${id} nicht gefunden.`);
      error.statusCode = 404;
      throw error;
    }
    return mapJobRow(row);
  }

  async createJob(payload) {
    const { name, cronExpression, sourceType, sourceId, enabled = true, pushoverEnabled = true } = payload || {};

    const trimmedName = String(name || '').trim();
    const trimmedExpr = String(cronExpression || '').trim();

    if (!trimmedName) throw Object.assign(new Error('Name fehlt.'), { statusCode: 400 });
    if (!trimmedExpr) throw Object.assign(new Error('Cron-Ausdruck fehlt.'), { statusCode: 400 });

    const validation = validateCronExpression(trimmedExpr);
    if (!validation.valid) throw Object.assign(new Error(validation.error), { statusCode: 400 });

    if (!['script', 'chain'].includes(sourceType)) {
      throw Object.assign(new Error('sourceType muss "script" oder "chain" sein.'), { statusCode: 400 });
    }

    const normalizedSourceId = Number(sourceId);
    if (!Number.isFinite(normalizedSourceId) || normalizedSourceId <= 0) {
      throw Object.assign(new Error('sourceId fehlt oder ist ungültig.'), { statusCode: 400 });
    }

    const nextRunAt = getNextRunTime(trimmedExpr)?.toISOString() || null;
    const db = await getDb();

    const result = await db.run(
      `
      INSERT INTO cron_jobs (name, cron_expression, source_type, source_id, enabled, pushover_enabled, next_run_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
      [trimmedName, trimmedExpr, sourceType, normalizedSourceId, enabled ? 1 : 0, pushoverEnabled ? 1 : 0, nextRunAt]
    );

    logger.info('cron:create', { cronJobId: result.lastID, name: trimmedName, cronExpression: trimmedExpr });
    return this.getJobById(result.lastID);
  }

  async updateJob(id, payload) {
    const db = await getDb();
    const existing = await this.getJobById(id);

    const trimmedName = Object.prototype.hasOwnProperty.call(payload, 'name')
      ? String(payload.name || '').trim()
      : existing.name;
    const trimmedExpr = Object.prototype.hasOwnProperty.call(payload, 'cronExpression')
      ? String(payload.cronExpression || '').trim()
      : existing.cronExpression;

    if (!trimmedName) throw Object.assign(new Error('Name fehlt.'), { statusCode: 400 });
    if (!trimmedExpr) throw Object.assign(new Error('Cron-Ausdruck fehlt.'), { statusCode: 400 });

    const validation = validateCronExpression(trimmedExpr);
    if (!validation.valid) throw Object.assign(new Error(validation.error), { statusCode: 400 });

    const sourceType = Object.prototype.hasOwnProperty.call(payload, 'sourceType') ? payload.sourceType : existing.sourceType;
    const sourceId   = Object.prototype.hasOwnProperty.call(payload, 'sourceId')   ? Number(payload.sourceId)   : existing.sourceId;
    const enabled        = Object.prototype.hasOwnProperty.call(payload, 'enabled')        ? Boolean(payload.enabled)        : existing.enabled;
    const pushoverEnabled = Object.prototype.hasOwnProperty.call(payload, 'pushoverEnabled') ? Boolean(payload.pushoverEnabled) : existing.pushoverEnabled;

    if (!['script', 'chain'].includes(sourceType)) {
      throw Object.assign(new Error('sourceType muss "script" oder "chain" sein.'), { statusCode: 400 });
    }
    if (!Number.isFinite(sourceId) || sourceId <= 0) {
      throw Object.assign(new Error('sourceId fehlt oder ist ungültig.'), { statusCode: 400 });
    }

    const nextRunAt = enabled ? (getNextRunTime(trimmedExpr)?.toISOString() || null) : null;

    await db.run(
      `
      UPDATE cron_jobs
      SET name = ?, cron_expression = ?, source_type = ?, source_id = ?,
          enabled = ?, pushover_enabled = ?, next_run_at = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
      `,
      [trimmedName, trimmedExpr, sourceType, sourceId, enabled ? 1 : 0, pushoverEnabled ? 1 : 0, nextRunAt, id]
    );

    logger.info('cron:update', { cronJobId: id });
    return this.getJobById(id);
  }

  async deleteJob(id) {
    const db = await getDb();
    const job = await this.getJobById(id);
    await db.run(`DELETE FROM cron_jobs WHERE id = ?`, [id]);
    logger.info('cron:delete', { cronJobId: id });
    return job;
  }

  async getJobLogs(id, limit = 20) {
    await this.getJobById(id); // Existenz prüfen
    const db = await getDb();
    const rows = await db.all(
      `SELECT * FROM cron_run_logs WHERE cron_job_id = ? ORDER BY id DESC LIMIT ?`,
      [id, Math.min(Number(limit) || 20, 100)]
    );
    return rows.map(mapLogRow);
  }

  async triggerJobManually(id) {
    const job = await this.getJobById(id);
    if (this._running.has(id)) {
      throw Object.assign(new Error('Cronjob läuft bereits.'), { statusCode: 409 });
    }
    this._running.add(id);
    logger.info('cron:manual-trigger', { cronJobId: id });

    // Asynchron starten
    runCronJob(job)
      .catch((error) => {
        logger.error('cron:manual-trigger:error', { cronJobId: id, error: errorToMeta(error) });
      })
      .finally(() => {
        this._running.delete(id);
      });

    return { triggered: true, cronJobId: id };
  }

  validateExpression(expr) {
    return validateCronExpression(expr);
  }

  getNextRunTime(expr) {
    const next = getNextRunTime(expr);
    return next ? next.toISOString() : null;
  }
}

module.exports = new CronService();
