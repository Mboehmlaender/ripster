import { useEffect, useMemo, useRef, useState } from 'react';
import { Card } from 'primereact/card';
import { Button } from 'primereact/button';
import { Toast } from 'primereact/toast';
import { Dialog } from 'primereact/dialog';
import { TabView, TabPanel } from 'primereact/tabview';
import { InputText } from 'primereact/inputtext';
import { InputTextarea } from 'primereact/inputtextarea';
import { api } from '../api/client';
import DynamicSettingsForm from '../components/DynamicSettingsForm';

function buildValuesMap(categories) {
  const next = {};
  for (const category of categories || []) {
    for (const setting of category.settings || []) {
      next[setting.key] = setting.value;
    }
  }
  return next;
}

function isSameValue(a, b) {
  if (typeof a === 'number' && typeof b === 'number') {
    return Number(a) === Number(b);
  }
  return a === b;
}

function injectHandBrakePresetOptions(categories, presetPayload) {
  const list = Array.isArray(categories) ? categories : [];
  const sourceOptions = Array.isArray(presetPayload?.options) ? presetPayload.options : [];

  return list.map((category) => ({
    ...category,
    settings: (category?.settings || []).map((setting) => {
      if (setting?.key !== 'handbrake_preset') {
        return setting;
      }

      const normalizedOptions = [];
      const seenValues = new Set();
      const seenGroupLabels = new Set();
      const addGroupOption = (option) => {
        const rawLabel = String(option?.label || '').trim();
        if (!rawLabel || seenGroupLabels.has(rawLabel)) {
          return;
        }
        seenGroupLabels.add(rawLabel);
        normalizedOptions.push({
          ...option,
          label: rawLabel,
          value: String(option?.value || `__group__${rawLabel.toLowerCase().replace(/\s+/g, '_')}`),
          disabled: true
        });
      };
      const addSelectableOption = (optionValue, optionLabel = optionValue, option = null) => {
        const value = String(optionValue || '').trim();
        if (!value || seenValues.has(value)) {
          return;
        }
        seenValues.add(value);
        normalizedOptions.push({
          ...(option && typeof option === 'object' ? option : {}),
          label: String(optionLabel ?? value),
          value,
          disabled: false
        });
      };

      for (const option of sourceOptions) {
        if (option?.disabled) {
          addGroupOption(option);
          continue;
        }
        addSelectableOption(option?.value, option?.label, option);
      }
      addSelectableOption(setting?.value);
      addSelectableOption(setting?.defaultValue);

      if (normalizedOptions.length === 0) {
        return setting;
      }

      return {
        ...setting,
        type: 'select',
        options: normalizedOptions
      };
    })
  }));
}

export default function SettingsPage() {
  const [categories, setCategories] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testingPushover, setTestingPushover] = useState(false);
  const [activeTabIndex, setActiveTabIndex] = useState(0);
  const [initialValues, setInitialValues] = useState({});
  const [draftValues, setDraftValues] = useState({});
  const [errors, setErrors] = useState({});
  const [scripts, setScripts] = useState([]);
  const [scriptsLoading, setScriptsLoading] = useState(false);
  const [scriptSaving, setScriptSaving] = useState(false);
  const [scriptActionBusyId, setScriptActionBusyId] = useState(null);
  const [scriptEditor, setScriptEditor] = useState({
    mode: 'none',
    id: null,
    name: '',
    scriptBody: ''
  });
  const [scriptErrors, setScriptErrors] = useState({});
  const [lastScriptTestResult, setLastScriptTestResult] = useState(null);
  const toastRef = useRef(null);

  const loadScripts = async ({ silent = false } = {}) => {
    if (!silent) {
      setScriptsLoading(true);
    }
    try {
      const response = await api.getScripts();
      const next = Array.isArray(response?.scripts) ? response.scripts : [];
      setScripts(next);
    } catch (error) {
      if (!silent) {
        toastRef.current?.show({ severity: 'error', summary: 'Script-Liste', detail: error.message });
      }
    } finally {
      if (!silent) {
        setScriptsLoading(false);
      }
    }
  };

  const load = async () => {
    setLoading(true);
    try {
      const [settingsResponse, presetsResponse, scriptsResponse] = await Promise.allSettled([
        api.getSettings(),
        api.getHandBrakePresets(),
        api.getScripts()
      ]);
      if (settingsResponse.status !== 'fulfilled') {
        throw settingsResponse.reason;
      }
      let nextCategories = settingsResponse.value?.categories || [];
      const presetPayload = presetsResponse.status === 'fulfilled' ? presetsResponse.value : null;
      nextCategories = injectHandBrakePresetOptions(nextCategories, presetPayload);
      if (presetsResponse.status === 'fulfilled' && presetsResponse.value?.message) {
        toastRef.current?.show({
          severity: presetsResponse.value?.source === 'fallback' ? 'warn' : 'info',
          summary: 'HandBrake Presets',
          detail: presetsResponse.value.message
        });
      }
      if (presetsResponse.status === 'rejected') {
        toastRef.current?.show({
          severity: 'warn',
          summary: 'HandBrake Presets',
          detail: 'Preset-Liste konnte nicht geladen werden. Aktueller Wert bleibt auswählbar.'
        });
      }
      const values = buildValuesMap(nextCategories);
      setCategories(nextCategories);
      setInitialValues(values);
      setDraftValues(values);
      setErrors({});
      if (scriptsResponse.status === 'fulfilled') {
        setScripts(Array.isArray(scriptsResponse.value?.scripts) ? scriptsResponse.value.scripts : []);
      } else {
        toastRef.current?.show({
          severity: 'warn',
          summary: 'Scripte',
          detail: 'Script-Liste konnte nicht geladen werden.'
        });
      }
    } catch (error) {
      toastRef.current?.show({ severity: 'error', summary: 'Fehler', detail: error.message });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const dirtyKeys = useMemo(() => {
    const keys = new Set();
    const allKeys = new Set([...Object.keys(initialValues), ...Object.keys(draftValues)]);
    for (const key of allKeys) {
      if (!isSameValue(initialValues[key], draftValues[key])) {
        keys.add(key);
      }
    }
    return keys;
  }, [initialValues, draftValues]);

  const hasUnsavedChanges = dirtyKeys.size > 0;

  const handleFieldChange = (key, value) => {
    setDraftValues((prev) => ({ ...prev, [key]: value }));
    setErrors((prev) => ({ ...prev, [key]: null }));
  };

  const handleSave = async () => {
    if (!hasUnsavedChanges) {
      toastRef.current?.show({
        severity: 'info',
        summary: 'Settings',
        detail: 'Keine Änderungen zum Speichern.'
      });
      return;
    }

    const patch = {};
    for (const key of dirtyKeys) {
      patch[key] = draftValues[key];
    }

    setSaving(true);
    try {
      const response = await api.updateSettingsBulk(patch);
      setInitialValues((prev) => ({ ...prev, ...patch }));
      setErrors({});
      const reviewRefresh = response?.reviewRefresh || null;
      const reviewRefreshHint = reviewRefresh?.triggered
        ? ' Mediainfo-Prüfung wird mit den neuen Settings automatisch neu berechnet.'
        : '';
      toastRef.current?.show({
        severity: 'success',
        summary: 'Settings',
        detail: `${Object.keys(patch).length} Änderung(en) gespeichert.${reviewRefreshHint}`
      });
    } catch (error) {
      let detail = error?.message || 'Unbekannter Fehler';
      if (Array.isArray(error?.details)) {
        const nextErrors = {};
        for (const item of error.details) {
          if (item?.key) {
            nextErrors[item.key] = item.message || 'Ungültiger Wert';
          }
        }
        setErrors(nextErrors);
        detail = 'Mindestens ein Feld ist ungültig.';
      }
      toastRef.current?.show({ severity: 'error', summary: 'Speichern fehlgeschlagen', detail });
    } finally {
      setSaving(false);
    }
  };

  const handleDiscard = () => {
    setDraftValues(initialValues);
    setErrors({});
  };

  const handlePushoverTest = async () => {
    setTestingPushover(true);
    try {
      const response = await api.testPushover();
      const sent = response?.result?.sent;
      if (sent) {
        toastRef.current?.show({
          severity: 'success',
          summary: 'PushOver',
          detail: 'Testnachricht wurde versendet.'
        });
      } else {
        toastRef.current?.show({
          severity: 'warn',
          summary: 'PushOver',
          detail: `Nicht versendet (${response?.result?.reason || 'unbekannt'}).`
        });
      }
    } catch (error) {
      toastRef.current?.show({ severity: 'error', summary: 'PushOver Fehler', detail: error.message });
    } finally {
      setTestingPushover(false);
    }
  };

  const handleScriptEditorChange = (key, value) => {
    setScriptEditor((prev) => ({
      ...prev,
      [key]: value
    }));
    setScriptErrors((prev) => ({
      ...prev,
      [key]: null
    }));
  };

  const clearScriptEditor = () => {
    setScriptEditor({
      mode: 'none',
      id: null,
      name: '',
      scriptBody: ''
    });
    setScriptErrors({});
  };

  const startCreateScript = () => {
    setScriptEditor({
      mode: 'create',
      id: null,
      name: '',
      scriptBody: ''
    });
    setScriptErrors({});
    setLastScriptTestResult(null);
  };

  const startEditScript = (script) => {
    setScriptEditor({
      mode: 'edit',
      id: script?.id || null,
      name: script?.name || '',
      scriptBody: script?.scriptBody || ''
    });
    setScriptErrors({});
    setLastScriptTestResult(null);
  };

  const handleSaveScript = async () => {
    if (scriptEditor?.mode !== 'create' && scriptEditor?.mode !== 'edit') {
      return;
    }
    const payload = {
      name: String(scriptEditor?.name || '').trim(),
      scriptBody: String(scriptEditor?.scriptBody || '')
    };
    setScriptSaving(true);
    try {
      if (scriptEditor?.id) {
        await api.updateScript(scriptEditor.id, payload);
        toastRef.current?.show({
          severity: 'success',
          summary: 'Scripte',
          detail: 'Script aktualisiert.'
        });
      } else {
        await api.createScript(payload);
        toastRef.current?.show({
          severity: 'success',
          summary: 'Scripte',
          detail: 'Script angelegt.'
        });
      }
      await loadScripts({ silent: true });
      setScriptErrors({});
      clearScriptEditor();
    } catch (error) {
      const details = Array.isArray(error?.details) ? error.details : [];
      if (details.length > 0) {
        const nextErrors = {};
        for (const item of details) {
          if (item?.field) {
            nextErrors[item.field] = item.message || 'Ungültiger Wert';
          }
        }
        setScriptErrors(nextErrors);
      }
      toastRef.current?.show({
        severity: 'error',
        summary: 'Script speichern fehlgeschlagen',
        detail: error.message
      });
    } finally {
      setScriptSaving(false);
    }
  };

  const handleDeleteScript = async (script) => {
    const scriptId = Number(script?.id);
    if (!Number.isFinite(scriptId) || scriptId <= 0) {
      return;
    }
    const confirmed = window.confirm(`Script "${script?.name || scriptId}" wirklich löschen?`);
    if (!confirmed) {
      return;
    }
    setScriptActionBusyId(scriptId);
    try {
      await api.deleteScript(scriptId);
      toastRef.current?.show({
        severity: 'success',
        summary: 'Scripte',
        detail: 'Script gelöscht.'
      });
      await loadScripts({ silent: true });
      if (scriptEditor?.mode === 'edit' && Number(scriptEditor?.id) === scriptId) {
        clearScriptEditor();
      }
    } catch (error) {
      toastRef.current?.show({
        severity: 'error',
        summary: 'Script löschen fehlgeschlagen',
        detail: error.message
      });
    } finally {
      setScriptActionBusyId(null);
    }
  };

  const handleTestScript = async (script) => {
    const scriptId = Number(script?.id);
    if (!Number.isFinite(scriptId) || scriptId <= 0) {
      return;
    }
    setScriptActionBusyId(scriptId);
    try {
      const response = await api.testScript(scriptId);
      const result = response?.result || null;
      setLastScriptTestResult(result);
      if (result?.success) {
        toastRef.current?.show({
          severity: 'success',
          summary: 'Script-Test',
          detail: `"${script?.name || scriptId}" erfolgreich ausgeführt.`
        });
      } else {
        toastRef.current?.show({
          severity: 'warn',
          summary: 'Script-Test',
          detail: `"${script?.name || scriptId}" fehlgeschlagen (exit=${result?.exitCode ?? 'n/a'}).`
        });
      }
    } catch (error) {
      toastRef.current?.show({
        severity: 'error',
        summary: 'Script-Test fehlgeschlagen',
        detail: error.message
      });
    } finally {
      setScriptActionBusyId(null);
    }
  };

  return (
    <div className="page-grid">
      <Toast ref={toastRef} />

      <Card title="Einstellungen" subTitle="Änderungen werden erst beim Speichern in die Datenbank übernommen">
        <TabView
          className="settings-root-tabview"
          activeIndex={activeTabIndex}
          onTabChange={(event) => setActiveTabIndex(Number(event.index || 0))}
        >
          <TabPanel header="Konfiguration">
            <div className="actions-row">
              <Button
                label="Änderungen speichern"
                icon="pi pi-save"
                onClick={handleSave}
                loading={saving}
                disabled={!hasUnsavedChanges}
              />
              <Button
                label="Änderungen verwerfen"
                icon="pi pi-undo"
                severity="secondary"
                outlined
                onClick={handleDiscard}
                disabled={!hasUnsavedChanges || saving}
              />
              <Button
                label="Neu laden"
                icon="pi pi-refresh"
                severity="secondary"
                onClick={load}
                loading={loading}
                disabled={saving}
              />
              <Button
                label="PushOver Test"
                icon="pi pi-send"
                severity="info"
                onClick={handlePushoverTest}
                loading={testingPushover}
                disabled={saving}
              />
            </div>

            {loading ? (
              <p>Lade Settings ...</p>
            ) : (
              <DynamicSettingsForm
                categories={categories}
                values={draftValues}
                errors={errors}
                dirtyKeys={dirtyKeys}
                onChange={handleFieldChange}
              />
            )}
          </TabPanel>
          <TabPanel header="Scripte">
            <div className="script-manager-wrap">
              <div className="actions-row">
                <Button
                  label="Neues Skript hinzufügen"
                  icon="pi pi-plus"
                  onClick={startCreateScript}
                  severity="success"
                  outlined
                  disabled={scriptSaving || scriptEditor?.mode === 'create'}
                />
                <Button
                  label="Scripts neu laden"
                  icon="pi pi-refresh"
                  severity="secondary"
                  onClick={() => loadScripts()}
                  loading={scriptsLoading}
                  disabled={scriptSaving}
                />
              </div>

              <small>
                Die ausgewählten Scripts werden später pro Job nach erfolgreichem Encode in Reihenfolge ausgeführt.
              </small>

              <div className="script-list-box">
                <h4>Verfügbare Scripts</h4>
                {scriptsLoading ? (
                  <p>Lade Scripts ...</p>
                ) : (
                  <div className="script-list">
                    {scriptEditor?.mode === 'create' ? (
                      <div className="script-list-item script-list-item-editing">
                        <div className="script-list-main">
                          <div className="script-title-line">
                            <strong className="script-id-title">NEU - Titel</strong>
                            <InputText
                              id="script-name-new"
                              value={scriptEditor?.name || ''}
                              onChange={(event) => handleScriptEditorChange('name', event.target.value)}
                              placeholder="z.B. Library Refresh"
                              className="script-title-input"
                            />
                          </div>
                          {scriptErrors?.name ? <small className="error-text">{scriptErrors.name}</small> : null}
                        </div>
                        <div className="script-editor-fields">
                          <label htmlFor="script-body-new">Bash Script</label>
                          <InputTextarea
                            id="script-body-new"
                            value={scriptEditor?.scriptBody || ''}
                            onChange={(event) => handleScriptEditorChange('scriptBody', event.target.value)}
                            rows={12}
                            autoResize={false}
                            placeholder={'#!/usr/bin/env bash\necho "Post-Encode Script"'}
                          />
                          {scriptErrors?.scriptBody ? <small className="error-text">{scriptErrors.scriptBody}</small> : null}
                        </div>
                        <div className="script-list-actions">
                          <Button
                            label="Speichern"
                            icon="pi pi-save"
                            onClick={handleSaveScript}
                            loading={scriptSaving}
                          />
                          <Button
                            label="Verwerfen"
                            icon="pi pi-times"
                            severity="secondary"
                            outlined
                            onClick={clearScriptEditor}
                            disabled={scriptSaving}
                          />
                          <span className="script-action-spacer" aria-hidden />
                        </div>
                      </div>
                    ) : null}

                    {scripts.length === 0 ? <p>Keine Scripts vorhanden.</p> : null}

                    {scripts.map((script) => {
                      return (
                        <div key={script.id} className="script-list-item">
                          <div className="script-list-main">
                            <strong className="script-id-title">{`ID #${script.id} - ${script.name}`}</strong>
                          </div>

                          <div className="script-list-actions">
                            <Button
                              icon="pi pi-pencil"
                              label="Bearbeiten"
                              severity="secondary"
                              outlined
                              onClick={() => startEditScript(script)}
                              disabled={Boolean(scriptActionBusyId) || scriptSaving || scriptEditor?.mode === 'create'}
                            />
                            <Button
                              icon="pi pi-play"
                              label="Test"
                              severity="info"
                              onClick={() => handleTestScript(script)}
                              loading={scriptActionBusyId === script.id}
                              disabled={Boolean(scriptActionBusyId) && scriptActionBusyId !== script.id}
                            />
                            <Button
                              icon="pi pi-trash"
                              label="Löschen"
                              severity="danger"
                              outlined
                              onClick={() => handleDeleteScript(script)}
                              loading={scriptActionBusyId === script.id}
                              disabled={Boolean(scriptActionBusyId) && scriptActionBusyId !== script.id}
                            />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              <Dialog
                header={scriptEditor?.id ? `Script bearbeiten (#${scriptEditor.id})` : 'Script bearbeiten'}
                visible={scriptEditor?.mode === 'edit'}
                onHide={clearScriptEditor}
                style={{ width: 'min(52rem, calc(100vw - 1.5rem))' }}
                className="script-edit-dialog"
                dismissableMask
                draggable={false}
              >
                <div className="script-editor-fields">
                  <label htmlFor="script-edit-name">Name</label>
                  <InputText
                    id="script-edit-name"
                    value={scriptEditor?.name || ''}
                    onChange={(event) => handleScriptEditorChange('name', event.target.value)}
                    placeholder="z.B. Library Refresh"
                  />
                  {scriptErrors?.name ? <small className="error-text">{scriptErrors.name}</small> : null}
                  <label htmlFor="script-edit-body">Bash Script</label>
                  <InputTextarea
                    id="script-edit-body"
                    value={scriptEditor?.scriptBody || ''}
                    onChange={(event) => handleScriptEditorChange('scriptBody', event.target.value)}
                    rows={14}
                    autoResize={false}
                    placeholder={'#!/usr/bin/env bash\necho "Post-Encode Script"'}
                  />
                  {scriptErrors?.scriptBody ? <small className="error-text">{scriptErrors.scriptBody}</small> : null}
                </div>
                <div className="actions-row">
                  <Button
                    label="Script aktualisieren"
                    icon="pi pi-save"
                    onClick={handleSaveScript}
                    loading={scriptSaving}
                  />
                  <Button
                    label="Abbrechen"
                    icon="pi pi-times"
                    severity="secondary"
                    outlined
                    onClick={clearScriptEditor}
                    disabled={scriptSaving}
                  />
                </div>
              </Dialog>

              {lastScriptTestResult ? (
                <div className="script-test-result">
                  <h4>Letzter Script-Test: {lastScriptTestResult.scriptName}</h4>
                  <small>
                    Status: {lastScriptTestResult.success ? 'Erfolgreich' : 'Fehler'}
                    {' | '}exit={lastScriptTestResult.exitCode ?? 'n/a'}
                    {' | '}timeout={lastScriptTestResult.timedOut ? 'ja' : 'nein'}
                    {' | '}dauer={Number(lastScriptTestResult.durationMs || 0)}ms
                  </small>
                  <pre>{`${lastScriptTestResult.stdout || ''}${lastScriptTestResult.stderr ? `\n${lastScriptTestResult.stderr}` : ''}`.trim() || 'Keine Ausgabe.'}</pre>
                </div>
              ) : null}
            </div>
          </TabPanel>
        </TabView>
      </Card>
    </div>
  );
}
