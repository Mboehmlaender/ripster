import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from 'primereact/button';
import { Dialog } from 'primereact/dialog';
import { InputText } from 'primereact/inputtext';
import { Dropdown } from 'primereact/dropdown';
import { InputSwitch } from 'primereact/inputswitch';
import { Toast } from 'primereact/toast';
import { api } from '../api/client';

// ── Hilfsfunktionen ──────────────────────────────────────────────────────────

function formatDateTime(iso) {
  if (!iso) return '–';
  try {
    return new Date(iso).toLocaleString('de-DE', {
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit'
    });
  } catch (_) {
    return iso;
  }
}

function StatusBadge({ status }) {
  if (!status) return <span className="cron-status cron-status--none">–</span>;
  const map = {
    success: { label: 'Erfolg', cls: 'success' },
    error:   { label: 'Fehler', cls: 'error' },
    running: { label: 'Läuft…', cls: 'running' }
  };
  const info = map[status] || { label: status, cls: 'none' };
  return <span className={`cron-status cron-status--${info.cls}`}>{info.label}</span>;
}

function normalizeActiveCronRuns(rawPayload) {
  const payload = rawPayload && typeof rawPayload === 'object' ? rawPayload : {};
  const active = Array.isArray(payload.active) ? payload.active : [];
  return active
    .map((item) => (item && typeof item === 'object' ? item : null))
    .filter(Boolean)
    .filter((item) => String(item.type || '').trim().toLowerCase() === 'cron')
    .map((item) => ({
      id: Number(item.id),
      cronJobId: Number(item.cronJobId || 0),
      currentStep: String(item.currentStep || '').trim() || null,
      currentScriptName: String(item.currentScriptName || '').trim() || null,
      startedAt: item.startedAt || null
    }))
    .filter((item) => Number.isFinite(item.cronJobId) && item.cronJobId > 0);
}

const EMPTY_FORM = {
  name: '',
  cronExpression: '',
  sourceType: 'script',
  sourceId: null,
  enabled: true,
  pushoverEnabled: true
};

// ── Hauptkomponente ───────────────────────────────────────────────────────────

export default function CronJobsTab({ onWsMessage }) {
  const toastRef = useRef(null);

  const [jobs, setJobs] = useState([]);
  const [loading, setLoading] = useState(false);
  const [scripts, setScripts] = useState([]);
  const [chains, setChains] = useState([]);
  const [activeCronRuns, setActiveCronRuns] = useState([]);

  // Editor-Dialog
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorMode, setEditorMode] = useState('create'); // 'create' | 'edit'
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);

  // Cron-Validierung
  const [exprValidation, setExprValidation] = useState(null); // { valid, error, nextRunAt }
  const [exprValidating, setExprValidating] = useState(false);
  const exprValidateTimer = useRef(null);

  // Logs-Dialog
  const [logsJob, setLogsJob] = useState(null);
  const [logs, setLogs] = useState([]);
  const [logsLoading, setLogsLoading] = useState(false);

  // Aktionen Busy-State per Job-ID
  const [busyId, setBusyId] = useState(null);

  // ── Daten laden ──────────────────────────────────────────────────────────────

  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      const [cronResp, scriptsResp, chainsResp, runtimeResp] = await Promise.allSettled([
        api.getCronJobs(),
        api.getScripts(),
        api.getScriptChains(),
        api.getRuntimeActivities()
      ]);
      if (cronResp.status === 'fulfilled') setJobs(cronResp.value?.jobs || []);
      if (scriptsResp.status === 'fulfilled') setScripts(scriptsResp.value?.scripts || []);
      if (chainsResp.status === 'fulfilled') setChains(chainsResp.value?.chains || []);
      if (runtimeResp.status === 'fulfilled') {
        setActiveCronRuns(normalizeActiveCronRuns(runtimeResp.value));
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  useEffect(() => {
    let cancelled = false;
    const refreshRuntime = async () => {
      try {
        const response = await api.getRuntimeActivities();
        if (!cancelled) {
          setActiveCronRuns(normalizeActiveCronRuns(response));
        }
      } catch (_error) {
        // ignore polling errors
      }
    };
    const interval = setInterval(refreshRuntime, 2500);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  const activeCronRunByJobId = useMemo(() => {
    const map = new Map();
    for (const item of activeCronRuns) {
      if (!item?.cronJobId) {
        continue;
      }
      map.set(item.cronJobId, item);
    }
    return map;
  }, [activeCronRuns]);

  // WebSocket: Cronjob-Updates empfangen
  useEffect(() => {
    if (!onWsMessage) return;
    // onWsMessage ist eine Funktion, die wir anmelden
  }, [onWsMessage]);

  // ── Cron-Ausdruck validieren (debounced) ─────────────────────────────────────

  useEffect(() => {
    const expr = form.cronExpression.trim();
    if (!expr) {
      setExprValidation(null);
      return;
    }
    if (exprValidateTimer.current) clearTimeout(exprValidateTimer.current);
    setExprValidating(true);
    exprValidateTimer.current = setTimeout(async () => {
      try {
        const result = await api.validateCronExpression(expr);
        setExprValidation(result);
      } catch (_) {
        setExprValidation({ valid: false, error: 'Validierung fehlgeschlagen.' });
      } finally {
        setExprValidating(false);
      }
    }, 500);
    return () => clearTimeout(exprValidateTimer.current);
  }, [form.cronExpression]);

  // ── Editor öffnen/schließen ──────────────────────────────────────────────────

  function openCreate() {
    setForm(EMPTY_FORM);
    setExprValidation(null);
    setEditorMode('create');
    setEditingId(null);
    setEditorOpen(true);
  }

  function openEdit(job) {
    setForm({
      name: job.name || '',
      cronExpression: job.cronExpression || '',
      sourceType: job.sourceType || 'script',
      sourceId: job.sourceId || null,
      enabled: job.enabled !== false,
      pushoverEnabled: job.pushoverEnabled !== false
    });
    setExprValidation(null);
    setEditorMode('edit');
    setEditingId(job.id);
    setEditorOpen(true);
  }

  function closeEditor() {
    setEditorOpen(false);
    setSaving(false);
  }

  // ── Speichern ────────────────────────────────────────────────────────────────

  async function handleSave() {
    const name = form.name.trim();
    const cronExpression = form.cronExpression.trim();

    if (!name) { toastRef.current?.show({ severity: 'warn', summary: 'Name fehlt', life: 3000 }); return; }
    if (!cronExpression) { toastRef.current?.show({ severity: 'warn', summary: 'Cron-Ausdruck fehlt', life: 3000 }); return; }
    if (exprValidation && !exprValidation.valid) { toastRef.current?.show({ severity: 'warn', summary: 'Ungültiger Cron-Ausdruck', life: 3000 }); return; }
    if (!form.sourceId) { toastRef.current?.show({ severity: 'warn', summary: 'Quelle fehlt', life: 3000 }); return; }

    setSaving(true);
    try {
      const payload = { ...form, name, cronExpression };
      if (editorMode === 'create') {
        await api.createCronJob(payload);
        toastRef.current?.show({ severity: 'success', summary: 'Cronjob erstellt', life: 3000 });
      } else {
        await api.updateCronJob(editingId, payload);
        toastRef.current?.show({ severity: 'success', summary: 'Cronjob gespeichert', life: 3000 });
      }
      closeEditor();
      await loadAll();
    } catch (error) {
      toastRef.current?.show({ severity: 'error', summary: 'Fehler', detail: error.message, life: 5000 });
    } finally {
      setSaving(false);
    }
  }

  // ── Toggle enabled/pushover ──────────────────────────────────────────────────

  async function handleToggle(job, field) {
    setBusyId(job.id);
    try {
      const updated = await api.updateCronJob(job.id, { [field]: !job[field] });
      setJobs((prev) => prev.map((j) => j.id === job.id ? updated.job : j));
    } catch (error) {
      toastRef.current?.show({ severity: 'error', summary: 'Fehler', detail: error.message, life: 4000 });
    } finally {
      setBusyId(null);
    }
  }

  // ── Löschen ──────────────────────────────────────────────────────────────────

  async function handleDelete(job) {
    if (!window.confirm(`Cronjob "${job.name}" wirklich löschen?`)) return;
    setBusyId(job.id);
    try {
      await api.deleteCronJob(job.id);
      toastRef.current?.show({ severity: 'success', summary: 'Gelöscht', life: 3000 });
      setJobs((prev) => prev.filter((j) => j.id !== job.id));
    } catch (error) {
      toastRef.current?.show({ severity: 'error', summary: 'Fehler', detail: error.message, life: 4000 });
    } finally {
      setBusyId(null);
    }
  }

  // ── Manuell ausführen ────────────────────────────────────────────────────────

  async function handleRunNow(job) {
    setBusyId(job.id);
    try {
      await api.runCronJobNow(job.id);
      toastRef.current?.show({ severity: 'info', summary: `"${job.name}" gestartet`, life: 3000 });
      // Kurz warten und dann neu laden
      setTimeout(() => loadAll(), 1500);
    } catch (error) {
      toastRef.current?.show({ severity: 'error', summary: 'Fehler', detail: error.message, life: 4000 });
    } finally {
      setBusyId(null);
    }
  }

  // ── Logs ─────────────────────────────────────────────────────────────────────

  async function openLogs(job) {
    setLogsJob(job);
    setLogs([]);
    setLogsLoading(true);
    try {
      const resp = await api.getCronJobLogs(job.id, 30);
      setLogs(resp.logs || []);
    } catch (error) {
      toastRef.current?.show({ severity: 'error', summary: 'Logs konnten nicht geladen werden', detail: error.message, life: 4000 });
    } finally {
      setLogsLoading(false);
    }
  }

  // ── Source-Optionen ──────────────────────────────────────────────────────────

  const sourceOptions = form.sourceType === 'script'
    ? scripts.map((s) => ({ label: s.name, value: s.id }))
    : chains.map((c) => ({ label: c.name, value: c.id }));

  // ── Render ────────────────────────────────────────────────────────────────────

  return (
    <div className="cron-tab">
      <Toast ref={toastRef} />

      <div className="actions-row">
        <Button
          label="Neuer Cronjob"
          icon="pi pi-plus"
          onClick={openCreate}
        />
        <Button
          label="Aktualisieren"
          icon="pi pi-refresh"
          severity="secondary"
          onClick={loadAll}
          loading={loading}
        />
      </div>

      {jobs.length === 0 && !loading && (
        <p className="cron-empty-hint">Keine Cronjobs vorhanden. Klicke auf &ldquo;Neuer Cronjob&rdquo;, um einen anzulegen.</p>
      )}

      {jobs.length > 0 && (
        <div className="cron-list">
          {jobs.map((job) => {
            const isBusy = busyId === job.id;
            const activeCronRun = activeCronRunByJobId.get(Number(job.id)) || null;
            return (
              <div key={job.id} className={`cron-item${job.enabled ? '' : ' cron-item--disabled'}`}>
                <div className="cron-item-header">
                  <span className="cron-item-name">{job.name}</span>
                  <code className="cron-item-expr">{job.cronExpression}</code>
                </div>

                <div className="cron-item-meta">
                  <span className="cron-meta-entry">
                    <span className="cron-meta-label">Quelle:</span>
                    <span className="cron-meta-value">
                      {job.sourceType === 'chain' ? '⛓ ' : '📜 '}
                      {job.sourceName || `#${job.sourceId}`}
                    </span>
                  </span>
                  <span className="cron-meta-entry">
                    <span className="cron-meta-label">Letzter Lauf:</span>
                    <span className="cron-meta-value">
                      {formatDateTime(job.lastRunAt)}
                      {job.lastRunStatus && <StatusBadge status={job.lastRunStatus} />}
                    </span>
                  </span>
                  <span className="cron-meta-entry">
                    <span className="cron-meta-label">Nächster Lauf:</span>
                    <span className="cron-meta-value">{formatDateTime(job.nextRunAt)}</span>
                  </span>
                  {activeCronRun ? (
                    <span className="cron-meta-entry">
                      <span className="cron-meta-label">Aktuell:</span>
                      <span className="cron-meta-value">
                        <StatusBadge status="running" />
                        {activeCronRun.currentScriptName
                          ? `Skript: ${activeCronRun.currentScriptName}`
                          : (activeCronRun.currentStep || 'Ausführung läuft')}
                      </span>
                    </span>
                  ) : null}
                </div>

                <div className="cron-item-toggles">
                  <label className="cron-toggle-label">
                    <InputSwitch
                      checked={job.enabled}
                      disabled={isBusy}
                      onChange={() => handleToggle(job, 'enabled')}
                    />
                    <span>Aktiviert</span>
                  </label>
                  <label className="cron-toggle-label">
                    <InputSwitch
                      checked={job.pushoverEnabled}
                      disabled={isBusy}
                      onChange={() => handleToggle(job, 'pushoverEnabled')}
                    />
                    <span>Pushover</span>
                  </label>
                </div>

                <div className="cron-item-actions">
                  <Button
                    icon="pi pi-play"
                    tooltip="Jetzt ausführen"
                    tooltipOptions={{ position: 'top' }}
                    size="small"
                    severity="success"
                    outlined
                    loading={isBusy && busyId === job.id}
                    disabled={isBusy}
                    onClick={() => handleRunNow(job)}
                  />
                  <Button
                    icon="pi pi-list"
                    tooltip="Logs anzeigen"
                    tooltipOptions={{ position: 'top' }}
                    size="small"
                    severity="info"
                    outlined
                    disabled={isBusy}
                    onClick={() => openLogs(job)}
                  />
                  <Button
                    icon="pi pi-pencil"
                    tooltip="Bearbeiten"
                    tooltipOptions={{ position: 'top' }}
                    size="small"
                    outlined
                    disabled={isBusy}
                    onClick={() => openEdit(job)}
                  />
                  <Button
                    icon="pi pi-trash"
                    tooltip="Löschen"
                    tooltipOptions={{ position: 'top' }}
                    size="small"
                    severity="danger"
                    outlined
                    disabled={isBusy}
                    onClick={() => handleDelete(job)}
                  />
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* ── Editor-Dialog ──────────────────────────────────────────────────── */}
      <Dialog
        header={editorMode === 'create' ? 'Neuer Cronjob' : 'Cronjob bearbeiten'}
        visible={editorOpen}
        onHide={closeEditor}
        style={{ width: '520px' }}
        footer={
          <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
            <Button label="Abbrechen" severity="secondary" outlined onClick={closeEditor} disabled={saving} />
            <Button label="Speichern" icon="pi pi-save" onClick={handleSave} loading={saving} />
          </div>
        }
      >
        <div className="cron-editor-fields">

          {/* Name */}
          <div className="cron-editor-field">
            <label className="cron-editor-label">Name</label>
            <InputText
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              placeholder="z.B. Tägliche Bereinigung"
              className="w-full"
            />
          </div>

          {/* Cron-Ausdruck */}
          <div className="cron-editor-field">
            <label className="cron-editor-label">
              Cron-Ausdruck
              <a
                href="https://crontab.guru/"
                target="_blank"
                rel="noopener noreferrer"
                className="cron-help-link"
                title="crontab.guru öffnen"
              >
                <i className="pi pi-question-circle" />
              </a>
            </label>
            <InputText
              value={form.cronExpression}
              onChange={(e) => setForm((f) => ({ ...f, cronExpression: e.target.value }))}
              placeholder="Minute Stunde Tag Monat Wochentag – z.B. 0 2 * * *"
              className={`w-full${exprValidation && !exprValidation.valid ? ' p-invalid' : ''}`}
            />
            {exprValidating && (
              <small className="cron-expr-hint cron-expr-hint--checking">Wird geprüft…</small>
            )}
            {!exprValidating && exprValidation && exprValidation.valid && (
              <small className="cron-expr-hint cron-expr-hint--ok">
                ✓ Gültig – nächste Ausführung: {formatDateTime(exprValidation.nextRunAt)}
              </small>
            )}
            {!exprValidating && exprValidation && !exprValidation.valid && (
              <small className="cron-expr-hint cron-expr-hint--err">✗ {exprValidation.error}</small>
            )}
            <div className="cron-expr-examples">
              {[
                { label: 'Stündlich', expr: '0 * * * *' },
                { label: 'Täglich 2 Uhr', expr: '0 2 * * *' },
                { label: 'Wöchentlich Mo', expr: '0 3 * * 1' },
                { label: 'Monatlich 1.', expr: '0 4 1 * *' }
              ].map(({ label, expr }) => (
                <button
                  key={expr}
                  type="button"
                  className="cron-expr-chip"
                  onClick={() => setForm((f) => ({ ...f, cronExpression: expr }))}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          {/* Quell-Typ */}
          <div className="cron-editor-field">
            <label className="cron-editor-label">Quell-Typ</label>
            <div className="cron-source-type-row">
              {[
                { value: 'script', label: '📜 Skript' },
                { value: 'chain',  label: '⛓ Skriptkette' }
              ].map(({ value, label }) => (
                <button
                  key={value}
                  type="button"
                  className={`cron-source-type-btn${form.sourceType === value ? ' active' : ''}`}
                  onClick={() => setForm((f) => ({ ...f, sourceType: value, sourceId: null }))}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          {/* Quelle auswählen */}
          <div className="cron-editor-field">
            <label className="cron-editor-label">
              {form.sourceType === 'script' ? 'Skript' : 'Skriptkette'}
            </label>
            <Dropdown
              value={form.sourceId}
              options={sourceOptions}
              onChange={(e) => setForm((f) => ({ ...f, sourceId: e.value }))}
              placeholder={`${form.sourceType === 'script' ? 'Skript' : 'Skriptkette'} wählen…`}
              className="w-full"
              emptyMessage={form.sourceType === 'script' ? 'Keine Skripte vorhanden' : 'Keine Ketten vorhanden'}
            />
          </div>

          {/* Toggles */}
          <div className="cron-editor-toggles">
            <label className="cron-toggle-label">
              <InputSwitch
                checked={form.enabled}
                onChange={(e) => setForm((f) => ({ ...f, enabled: e.value }))}
              />
              <span>Aktiviert</span>
            </label>
            <label className="cron-toggle-label">
              <InputSwitch
                checked={form.pushoverEnabled}
                onChange={(e) => setForm((f) => ({ ...f, pushoverEnabled: e.value }))}
              />
              <span>Pushover-Benachrichtigung</span>
            </label>
          </div>

        </div>
      </Dialog>

      {/* ── Logs-Dialog ──────────────────────────────────────────────────────── */}
      <Dialog
        header={logsJob ? `Logs: ${logsJob.name}` : 'Logs'}
        visible={Boolean(logsJob)}
        onHide={() => setLogsJob(null)}
        style={{ width: '720px' }}
        footer={
          <Button
            label="Schließen"
            severity="secondary"
            outlined
            onClick={() => setLogsJob(null)}
          />
        }
      >
        {logsLoading && <p>Lade Logs…</p>}
        {!logsLoading && logs.length === 0 && (
          <p className="cron-empty-hint">Noch keine Ausführungen protokolliert.</p>
        )}
        {!logsLoading && logs.length > 0 && (
          <div className="cron-log-list">
            {logs.map((log) => (
              <details key={log.id} className="cron-log-entry">
                <summary className="cron-log-summary">
                  <StatusBadge status={log.status} />
                  <span className="cron-log-time">{formatDateTime(log.startedAt)}</span>
                  {log.finishedAt && (
                    <span className="cron-log-duration">
                      {Math.round((new Date(log.finishedAt) - new Date(log.startedAt)) / 1000)}s
                    </span>
                  )}
                  {log.errorMessage && (
                    <span className="cron-log-errmsg">{log.errorMessage}</span>
                  )}
                </summary>
                {log.output && (
                  <pre className="cron-log-output">{log.output}</pre>
                )}
              </details>
            ))}
          </div>
        )}
      </Dialog>
    </div>
  );
}
