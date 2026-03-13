import { useEffect, useMemo, useRef, useState } from 'react';
import { Card } from 'primereact/card';
import { Button } from 'primereact/button';
import { Toast } from 'primereact/toast';
import { Dialog } from 'primereact/dialog';
import { TabView, TabPanel } from 'primereact/tabview';
import { InputText } from 'primereact/inputtext';
import { InputTextarea } from 'primereact/inputtextarea';
import { Dropdown } from 'primereact/dropdown';
import { InputSwitch } from 'primereact/inputswitch';
import { api } from '../api/client';
import DynamicSettingsForm from '../components/DynamicSettingsForm';
import CronJobsTab from '../components/CronJobsTab';

const EXPERT_MODE_SETTING_KEY = 'ui_expert_mode';

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

function toBoolean(value) {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return value !== 0;
  }
  const normalized = String(value || '').trim().toLowerCase();
  return normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on';
}

function reorderListById(items, sourceId, targetIndex) {
  const list = Array.isArray(items) ? items : [];
  const normalizedSourceId = Number(sourceId);
  const normalizedTargetIndex = Number(targetIndex);
  if (!Number.isFinite(normalizedSourceId) || normalizedSourceId <= 0 || !Number.isFinite(normalizedTargetIndex)) {
    return { changed: false, next: list };
  }
  const fromIndex = list.findIndex((item) => Number(item?.id) === normalizedSourceId);
  if (fromIndex < 0) {
    return { changed: false, next: list };
  }

  const boundedTarget = Math.max(0, Math.min(Math.trunc(normalizedTargetIndex), list.length));
  const insertAt = fromIndex < boundedTarget ? boundedTarget - 1 : boundedTarget;
  if (insertAt === fromIndex) {
    return { changed: false, next: list };
  }

  const next = [...list];
  const [moved] = next.splice(fromIndex, 1);
  next.splice(insertAt, 0, moved);
  return { changed: true, next };
}

function buildHandBrakePresetSelectOptions(sourceOptions, extraValues = []) {
  const rawOptions = Array.isArray(sourceOptions) ? sourceOptions : [];
  const rawExtraValues = Array.isArray(extraValues) ? extraValues : [];
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
    if (seenValues.has(value)) {
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

  normalizedOptions.push({ label: '(kein Preset – nur CLI-Parameter)', value: '', disabled: false });
  seenValues.add('');

  for (const option of rawOptions) {
    if (option?.disabled) {
      addGroupOption(option);
      continue;
    }
    addSelectableOption(option?.value, option?.label, option);
  }
  for (const value of rawExtraValues) {
    addSelectableOption(value);
  }

  return normalizedOptions;
}

function injectHandBrakePresetOptions(categories, presetPayload) {
  const list = Array.isArray(categories) ? categories : [];
  const sourceOptions = Array.isArray(presetPayload?.options) ? presetPayload.options : [];
  const presetSettingKeys = new Set(['handbrake_preset', 'handbrake_preset_bluray', 'handbrake_preset_dvd']);

  return list.map((category) => ({
    ...category,
    settings: (category?.settings || []).map((setting) => {
      if (!presetSettingKeys.has(String(setting?.key || '').trim().toLowerCase())) {
        return setting;
      }
      const normalizedOptions = buildHandBrakePresetSelectOptions(sourceOptions, [
        setting?.value,
        setting?.defaultValue
      ]);

      if (normalizedOptions.length <= 1) {
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
  const [updatingExpertMode, setUpdatingExpertMode] = useState(false);
  const [activeTabIndex, setActiveTabIndex] = useState(0);
  const [initialValues, setInitialValues] = useState({});
  const [draftValues, setDraftValues] = useState({});
  const [errors, setErrors] = useState({});
  const [scripts, setScripts] = useState([]);
  const [scriptsLoading, setScriptsLoading] = useState(false);
  const [scriptSaving, setScriptSaving] = useState(false);
  const [scriptReordering, setScriptReordering] = useState(false);
  const [scriptListDragSourceId, setScriptListDragSourceId] = useState(null);
  const [scriptActionBusyId, setScriptActionBusyId] = useState(null);
  const [scriptEditor, setScriptEditor] = useState({
    mode: 'none',
    id: null,
    name: '',
    scriptBody: ''
  });
  const [scriptErrors, setScriptErrors] = useState({});
  const [lastScriptTestResult, setLastScriptTestResult] = useState(null);

  // Script chains state
  const [chains, setChains] = useState([]);
  const [chainsLoading, setChainsLoading] = useState(false);
  const [chainSaving, setChainSaving] = useState(false);
  const [chainReordering, setChainReordering] = useState(false);
  const [chainListDragSourceId, setChainListDragSourceId] = useState(null);
  const [chainActionBusyId, setChainActionBusyId] = useState(null);
  const [lastChainTestResult, setLastChainTestResult] = useState(null);
  const [chainEditor, setChainEditor] = useState({ open: false, id: null, name: '', steps: [] });
  const [chainEditorErrors, setChainEditorErrors] = useState({});
  const [chainDragSource, setChainDragSource] = useState(null);

  // User presets state
  const [userPresets, setUserPresets] = useState([]);
  const [userPresetsLoading, setUserPresetsLoading] = useState(false);
  const [userPresetSaving, setUserPresetSaving] = useState(false);
  const [userPresetEditor, setUserPresetEditor] = useState({
    open: false,
    id: null,
    name: '',
    mediaType: 'all',
    handbrakePreset: '',
    extraArgs: '',
    description: ''
  });
  const [userPresetErrors, setUserPresetErrors] = useState({});
  const [handBrakePresetSourceOptions, setHandBrakePresetSourceOptions] = useState([]);
  const [effectivePaths, setEffectivePaths] = useState(null);

  const toastRef = useRef(null);

  const userPresetHandBrakeOptions = useMemo(
    () => buildHandBrakePresetSelectOptions(
      handBrakePresetSourceOptions,
      [userPresetEditor.handbrakePreset]
    ),
    [handBrakePresetSourceOptions, userPresetEditor.handbrakePreset]
  );

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

  const loadChains = async ({ silent = false } = {}) => {
    if (!silent) {
      setChainsLoading(true);
    }
    try {
      const response = await api.getScriptChains();
      setChains(Array.isArray(response?.chains) ? response.chains : []);
    } catch (error) {
      if (!silent) {
        toastRef.current?.show({ severity: 'error', summary: 'Skriptketten', detail: error.message });
      }
    } finally {
      if (!silent) {
        setChainsLoading(false);
      }
    }
  };

  const loadUserPresets = async ({ silent = false } = {}) => {
    if (!silent) {
      setUserPresetsLoading(true);
    }
    try {
      const response = await api.getUserPresets();
      setUserPresets(Array.isArray(response?.presets) ? response.presets : []);
    } catch (error) {
      if (!silent) {
        toastRef.current?.show({ severity: 'error', summary: 'User-Presets', detail: error.message });
      }
    } finally {
      if (!silent) {
        setUserPresetsLoading(false);
      }
    }
  };

  const openNewUserPreset = () => {
    setUserPresetEditor({ open: true, id: null, name: '', mediaType: 'all', handbrakePreset: '', extraArgs: '', description: '' });
    setUserPresetErrors({});
  };

  const openEditUserPreset = (preset) => {
    setUserPresetEditor({
      open: true,
      id: preset.id,
      name: preset.name || '',
      mediaType: preset.mediaType || 'all',
      handbrakePreset: preset.handbrakePreset || '',
      extraArgs: preset.extraArgs || '',
      description: preset.description || ''
    });
    setUserPresetErrors({});
  };

  const closeUserPresetEditor = () => {
    setUserPresetEditor((prev) => ({ ...prev, open: false }));
    setUserPresetErrors({});
  };

  const handleSaveUserPreset = async () => {
    const errors = {};
    if (!userPresetEditor.name.trim()) {
      errors.name = 'Name ist erforderlich.';
    }
    if (Object.keys(errors).length > 0) {
      setUserPresetErrors(errors);
      return;
    }
    setUserPresetSaving(true);
    try {
      const payload = {
        name: userPresetEditor.name.trim(),
        mediaType: userPresetEditor.mediaType,
        handbrakePreset: userPresetEditor.handbrakePreset.trim(),
        extraArgs: userPresetEditor.extraArgs.trim(),
        description: userPresetEditor.description.trim()
      };
      if (userPresetEditor.id) {
        await api.updateUserPreset(userPresetEditor.id, payload);
        toastRef.current?.show({ severity: 'success', summary: 'Preset', detail: 'Preset aktualisiert.' });
      } else {
        await api.createUserPreset(payload);
        toastRef.current?.show({ severity: 'success', summary: 'Preset', detail: 'Preset erstellt.' });
      }
      closeUserPresetEditor();
      await loadUserPresets({ silent: true });
    } catch (error) {
      toastRef.current?.show({ severity: 'error', summary: 'Preset speichern', detail: error.message });
    } finally {
      setUserPresetSaving(false);
    }
  };

  const handleDeleteUserPreset = async (presetId) => {
    try {
      await api.deleteUserPreset(presetId);
      toastRef.current?.show({ severity: 'success', summary: 'Preset', detail: 'Preset gelöscht.' });
      await loadUserPresets({ silent: true });
    } catch (error) {
      toastRef.current?.show({ severity: 'error', summary: 'Preset löschen', detail: error.message });
    }
  };

  const loadEffectivePaths = async ({ silent = false } = {}) => {
    try {
      const paths = await api.getEffectivePaths({ forceRefresh: true });
      setEffectivePaths(paths || null);
    } catch (_error) {
      if (!silent) {
        setEffectivePaths(null);
      }
    }
  };

  const load = async () => {
    setLoading(true);
    try {
      const settingsResponse = await api.getSettings();
      let nextCategories = settingsResponse?.categories || [];
      const values = buildValuesMap(nextCategories);
      setCategories(nextCategories);
      setInitialValues(values);
      setDraftValues(values);
      setErrors({});
      loadEffectivePaths({ silent: true });

      const presetsPromise = api.getHandBrakePresets();
      const scriptsPromise = api.getScripts();
      const chainsPromise = api.getScriptChains();
      const [scriptsResponse, chainsResponse] = await Promise.allSettled([scriptsPromise, chainsPromise]);
      if (scriptsResponse.status === 'fulfilled') {
        setScripts(Array.isArray(scriptsResponse.value?.scripts) ? scriptsResponse.value.scripts : []);
      } else {
        toastRef.current?.show({
          severity: 'warn',
          summary: 'Scripte',
          detail: 'Script-Liste konnte nicht geladen werden.'
        });
      }
      if (chainsResponse.status === 'fulfilled') {
        setChains(Array.isArray(chainsResponse.value?.chains) ? chainsResponse.value.chains : []);
      }

      presetsPromise
        .then((presetPayload) => {
          setHandBrakePresetSourceOptions(Array.isArray(presetPayload?.options) ? presetPayload.options : []);
          setCategories((prevCategories) => injectHandBrakePresetOptions(prevCategories, presetPayload));
          if (presetPayload?.message) {
            toastRef.current?.show({
              severity: presetPayload?.source === 'fallback' ? 'warn' : 'info',
              summary: 'HandBrake Presets',
              detail: presetPayload.message
            });
          }
        })
        .catch(() => {
          setHandBrakePresetSourceOptions([]);
          toastRef.current?.show({
            severity: 'warn',
            summary: 'HandBrake Presets',
            detail: 'Preset-Liste konnte nicht geladen werden. Aktueller Wert bleibt auswählbar.'
          });
        });
    } catch (error) {
      toastRef.current?.show({ severity: 'error', summary: 'Fehler', detail: error.message });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    loadUserPresets();
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
  const expertModeEnabled = toBoolean(draftValues?.[EXPERT_MODE_SETTING_KEY]);

  const handleFieldChange = (key, value) => {
    setDraftValues((prev) => ({ ...prev, [key]: value }));
    setErrors((prev) => ({ ...prev, [key]: null }));
  };

  const handleExpertModeToggle = async (checked) => {
    const previousDraftValue = draftValues?.[EXPERT_MODE_SETTING_KEY];
    const previousInitialValue = initialValues?.[EXPERT_MODE_SETTING_KEY];
    const nextValue = Boolean(checked);
    const currentValue = toBoolean(previousDraftValue);
    if (nextValue === currentValue) {
      return;
    }

    setUpdatingExpertMode(true);
    setDraftValues((prev) => ({ ...prev, [EXPERT_MODE_SETTING_KEY]: nextValue }));
    setInitialValues((prev) => ({ ...prev, [EXPERT_MODE_SETTING_KEY]: nextValue }));
    setErrors((prev) => ({ ...prev, [EXPERT_MODE_SETTING_KEY]: null }));
    try {
      await api.updateSetting(EXPERT_MODE_SETTING_KEY, nextValue);
    } catch (error) {
      setDraftValues((prev) => ({ ...prev, [EXPERT_MODE_SETTING_KEY]: previousDraftValue }));
      setInitialValues((prev) => ({ ...prev, [EXPERT_MODE_SETTING_KEY]: previousInitialValue }));
      toastRef.current?.show({
        severity: 'error',
        summary: 'Expertenmodus',
        detail: error.message
      });
    } finally {
      setUpdatingExpertMode(false);
    }
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
      loadEffectivePaths({ silent: true });
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

  const handleScriptListDragStart = (event, scriptId) => {
    if (scriptSaving || scriptsLoading || scriptReordering || scriptEditor?.mode === 'create' || Boolean(scriptActionBusyId)) {
      event.preventDefault();
      return;
    }
    setScriptListDragSourceId(Number(scriptId));
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', String(scriptId));
  };

  const handleScriptListDragOver = (event) => {
    const sourceId = Number(scriptListDragSourceId);
    if (!Number.isFinite(sourceId) || sourceId <= 0) {
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
  };

  const handleScriptListDrop = async (event, targetIndex) => {
    event.preventDefault();
    if (scriptReordering) {
      setScriptListDragSourceId(null);
      return;
    }
    const sourceId = Number(scriptListDragSourceId);
    setScriptListDragSourceId(null);
    const { changed, next } = reorderListById(scripts, sourceId, targetIndex);
    if (!changed) {
      return;
    }

    const orderedScriptIds = next
      .map((script) => Number(script?.id))
      .filter((id) => Number.isFinite(id) && id > 0);
    setScripts(next);
    setScriptReordering(true);
    try {
      await api.reorderScripts(orderedScriptIds);
    } catch (error) {
      toastRef.current?.show({
        severity: 'error',
        summary: 'Script-Reihenfolge',
        detail: error.message
      });
      await loadScripts({ silent: true });
    } finally {
      setScriptReordering(false);
    }
  };

  const handleTestChain = async (chain) => {
    const chainId = Number(chain?.id);
    if (!Number.isFinite(chainId) || chainId <= 0) {
      return;
    }
    setChainActionBusyId(chainId);
    setLastChainTestResult(null);
    try {
      const response = await api.testScriptChain(chainId);
      const result = response?.result || null;
      setLastChainTestResult(result);
      if (!result?.aborted) {
        toastRef.current?.show({
          severity: 'success',
          summary: 'Ketten-Test',
          detail: `"${chain?.name || chainId}" erfolgreich ausgeführt (${result?.succeeded ?? 0}/${result?.steps ?? 0} Schritte).`
        });
      } else {
        toastRef.current?.show({
          severity: 'warn',
          summary: 'Ketten-Test',
          detail: `"${chain?.name || chainId}" abgebrochen (${result?.succeeded ?? 0}/${result?.steps ?? 0} Schritte OK).`
        });
      }
    } catch (error) {
      toastRef.current?.show({ severity: 'error', summary: 'Ketten-Test fehlgeschlagen', detail: error.message });
    } finally {
      setChainActionBusyId(null);
    }
  };

  // Chain editor handlers
  const openChainEditor = (chain = null) => {
    if (chain) {
      setChainEditor({ open: true, id: chain.id, name: chain.name, steps: (chain.steps || []).map((s, i) => ({ ...s, _key: `${s.id || i}-${Date.now()}` })) });
    } else {
      setChainEditor({ open: true, id: null, name: '', steps: [] });
    }
    setChainEditorErrors({});
  };

  const closeChainEditor = () => {
    setChainEditor({ open: false, id: null, name: '', steps: [] });
    setChainEditorErrors({});
  };

  const addChainStep = (stepType, scriptId = null, scriptName = null) => {
    setChainEditor((prev) => ({
      ...prev,
      steps: [
        ...prev.steps,
        {
          _key: `new-${Date.now()}-${Math.random()}`,
          stepType,
          scriptId: stepType === 'script' ? scriptId : null,
          scriptName: stepType === 'script' ? scriptName : null,
          waitSeconds: stepType === 'wait' ? 10 : null
        }
      ]
    }));
  };

  const removeChainStep = (index) => {
    setChainEditor((prev) => ({ ...prev, steps: prev.steps.filter((_, i) => i !== index) }));
  };

  const updateChainStepWait = (index, seconds) => {
    setChainEditor((prev) => ({
      ...prev,
      steps: prev.steps.map((s, i) => i === index ? { ...s, waitSeconds: seconds } : s)
    }));
  };

  const moveChainStep = (fromIndex, toIndex) => {
    if (fromIndex === toIndex) {
      return;
    }
    setChainEditor((prev) => {
      const steps = [...prev.steps];
      const [moved] = steps.splice(fromIndex, 1);
      steps.splice(toIndex, 0, moved);
      return { ...prev, steps };
    });
  };

  const handleSaveChain = async () => {
    const name = String(chainEditor.name || '').trim();
    if (!name) {
      setChainEditorErrors({ name: 'Name darf nicht leer sein.' });
      return;
    }
    const payload = {
      name,
      steps: chainEditor.steps.map((s) => ({
        stepType: s.stepType,
        scriptId: s.stepType === 'script' ? s.scriptId : null,
        waitSeconds: s.stepType === 'wait' ? Number(s.waitSeconds || 10) : null
      }))
    };
    setChainSaving(true);
    try {
      if (chainEditor.id) {
        await api.updateScriptChain(chainEditor.id, payload);
        toastRef.current?.show({ severity: 'success', summary: 'Skriptkette', detail: 'Kette aktualisiert.' });
      } else {
        await api.createScriptChain(payload);
        toastRef.current?.show({ severity: 'success', summary: 'Skriptkette', detail: 'Kette angelegt.' });
      }
      await loadChains({ silent: true });
      closeChainEditor();
    } catch (error) {
      const details = Array.isArray(error?.details) ? error.details : [];
      if (details.length > 0) {
        const errs = {};
        for (const item of details) {
          if (item?.field) {
            errs[item.field] = item.message || 'Ungültig';
          }
        }
        setChainEditorErrors(errs);
      }
      toastRef.current?.show({ severity: 'error', summary: 'Kette speichern fehlgeschlagen', detail: error.message });
    } finally {
      setChainSaving(false);
    }
  };

  const handleDeleteChain = async (chain) => {
    const chainId = Number(chain?.id);
    if (!Number.isFinite(chainId) || chainId <= 0) {
      return;
    }
    if (!window.confirm(`Skriptkette "${chain?.name || chainId}" wirklich löschen?`)) {
      return;
    }
    try {
      await api.deleteScriptChain(chainId);
      toastRef.current?.show({ severity: 'success', summary: 'Skriptketten', detail: 'Kette gelöscht.' });
      await loadChains({ silent: true });
    } catch (error) {
      toastRef.current?.show({ severity: 'error', summary: 'Kette löschen fehlgeschlagen', detail: error.message });
    }
  };

  const handleChainListDragStart = (event, chainId) => {
    if (chainSaving || chainsLoading || chainReordering || Boolean(chainActionBusyId)) {
      event.preventDefault();
      return;
    }
    setChainListDragSourceId(Number(chainId));
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', String(chainId));
  };

  const handleChainListDragOver = (event) => {
    const sourceId = Number(chainListDragSourceId);
    if (!Number.isFinite(sourceId) || sourceId <= 0) {
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
  };

  const handleChainListDrop = async (event, targetIndex) => {
    event.preventDefault();
    if (chainReordering) {
      setChainListDragSourceId(null);
      return;
    }
    const sourceId = Number(chainListDragSourceId);
    setChainListDragSourceId(null);
    const { changed, next } = reorderListById(chains, sourceId, targetIndex);
    if (!changed) {
      return;
    }

    const orderedChainIds = next
      .map((chain) => Number(chain?.id))
      .filter((id) => Number.isFinite(id) && id > 0);
    setChains(next);
    setChainReordering(true);
    try {
      await api.reorderScriptChains(orderedChainIds);
    } catch (error) {
      toastRef.current?.show({
        severity: 'error',
        summary: 'Ketten-Reihenfolge',
        detail: error.message
      });
      await loadChains({ silent: true });
    } finally {
      setChainReordering(false);
    }
  };

  // Chain DnD handlers
  const handleChainPaletteDragStart = (event, data) => {
    setChainDragSource({ origin: 'palette', ...data });
    event.dataTransfer.effectAllowed = 'copy';
    event.dataTransfer.setData('text/plain', JSON.stringify(data));
  };

  const handleChainStepDragStart = (event, index) => {
    setChainDragSource({ origin: 'step', index });
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', String(index));
  };

  const handleChainDropzoneDrop = (event, targetIndex) => {
    event.preventDefault();
    if (!chainDragSource) {
      return;
    }
    if (chainDragSource.origin === 'palette') {
      const newStep = {
        _key: `new-${Date.now()}-${Math.random()}`,
        stepType: chainDragSource.stepType,
        scriptId: chainDragSource.stepType === 'script' ? chainDragSource.scriptId : null,
        scriptName: chainDragSource.stepType === 'script' ? chainDragSource.scriptName : null,
        waitSeconds: chainDragSource.stepType === 'wait' ? 10 : null
      };
      setChainEditor((prev) => {
        const steps = [...prev.steps];
        const insertAt = targetIndex != null ? targetIndex : steps.length;
        steps.splice(insertAt, 0, newStep);
        return { ...prev, steps };
      });
    } else if (chainDragSource.origin === 'step') {
      moveChainStep(chainDragSource.index, targetIndex != null ? targetIndex : chainEditor.steps.length - 1);
    }
    setChainDragSource(null);
  };

  const handleChainDragOver = (event) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = chainDragSource?.origin === 'palette' ? 'copy' : 'move';
  };

  const scriptListDnDDisabled = scriptSaving
    || scriptsLoading
    || scriptReordering
    || scriptEditor?.mode === 'create'
    || Boolean(scriptActionBusyId);
  const chainListDnDDisabled = chainSaving
    || chainsLoading
    || chainReordering
    || Boolean(chainActionBusyId);

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
                disabled={!hasUnsavedChanges || updatingExpertMode}
              />
              <Button
                label="Änderungen verwerfen"
                icon="pi pi-undo"
                severity="secondary"
                outlined
                onClick={handleDiscard}
                disabled={!hasUnsavedChanges || saving || updatingExpertMode}
              />
              <Button
                label="Neu laden"
                icon="pi pi-refresh"
                severity="secondary"
                onClick={load}
                loading={loading}
                disabled={saving || updatingExpertMode}
              />
              <Button
                label="PushOver Test"
                icon="pi pi-send"
                severity="info"
                onClick={handlePushoverTest}
                loading={testingPushover}
                disabled={saving || updatingExpertMode}
              />
              <div className="settings-expert-toggle">
                <span>Expertenmodus</span>
                <InputSwitch
                  checked={expertModeEnabled}
                  onChange={(event) => handleExpertModeToggle(event.value)}
                  disabled={loading || saving || updatingExpertMode}
                />
              </div>
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
                effectivePaths={effectivePaths}
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
                  disabled={scriptSaving || scriptReordering || scriptEditor?.mode === 'create'}
                />
                <Button
                  label="Scripts neu laden"
                  icon="pi pi-refresh"
                  severity="secondary"
                  onClick={() => loadScripts()}
                  loading={scriptsLoading}
                  disabled={scriptSaving || scriptReordering}
                />
              </div>

              <small>
                Die ausgewählten Scripts werden später pro Job nach erfolgreichem Encode in Reihenfolge ausgeführt.
              </small>
              <small className="muted-inline">
                Reihenfolge per Drag & Drop ändern.
                {scriptReordering ? ' Speichere Reihenfolge ...' : ''}
              </small>

              <div className="script-list-box">
                <h4>Verfügbare Scripts</h4>
                {scriptsLoading ? (
                  <p>Lade Scripts ...</p>
                ) : (
                  <div className="script-list script-list--reorderable">
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

                    {scripts.length === 0 ? (
                      <p>Keine Scripts vorhanden.</p>
                    ) : (
                      <div className="script-order-list">
                        {scripts.map((script, index) => {
                          const isDragging = Number(scriptListDragSourceId) === Number(script.id);
                          return (
                            <div key={script.id} className="script-order-wrapper">
                              <div
                                className="script-order-drop-zone"
                                onDragOver={handleScriptListDragOver}
                                onDrop={(event) => handleScriptListDrop(event, index)}
                              />
                              <div
                                className={`script-list-item${isDragging ? ' script-list-item--dragging' : ''}`}
                                draggable={!scriptListDnDDisabled}
                                onDragStart={(event) => handleScriptListDragStart(event, script.id)}
                                onDragEnd={() => setScriptListDragSourceId(null)}
                              >
                                <div
                                  className={`script-list-drag-handle${scriptListDnDDisabled ? ' disabled' : ''}`}
                                  title={scriptListDnDDisabled ? 'Sortierung aktuell nicht verfügbar' : 'Ziehen zum Sortieren'}
                                >
                                  <i className="pi pi-bars" />
                                </div>
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
                                    disabled={Boolean(scriptActionBusyId) || scriptSaving || scriptReordering || scriptEditor?.mode === 'create'}
                                  />
                                  <Button
                                    icon="pi pi-play"
                                    label="Test"
                                    severity="info"
                                    onClick={() => handleTestScript(script)}
                                    loading={scriptActionBusyId === script.id}
                                    disabled={scriptReordering || (Boolean(scriptActionBusyId) && scriptActionBusyId !== script.id)}
                                  />
                                  <Button
                                    icon="pi pi-trash"
                                    label="Löschen"
                                    severity="danger"
                                    outlined
                                    onClick={() => handleDeleteScript(script)}
                                    loading={scriptActionBusyId === script.id}
                                    disabled={scriptReordering || (Boolean(scriptActionBusyId) && scriptActionBusyId !== script.id)}
                                  />
                                </div>
                              </div>
                            </div>
                          );
                        })}
                        <div
                          className="script-order-drop-zone script-order-drop-zone--end"
                          onDragOver={handleScriptListDragOver}
                          onDrop={(event) => handleScriptListDrop(event, scripts.length)}
                        />
                      </div>
                    )}
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

          <TabPanel header="Skriptketten">
            <div className="script-manager-wrap">
              <div className="actions-row">
                <Button
                  label="Neue Kette erstellen"
                  icon="pi pi-plus"
                  severity="success"
                  outlined
                  onClick={() => openChainEditor()}
                  disabled={chainReordering}
                />
                <Button
                  label="Ketten neu laden"
                  icon="pi pi-refresh"
                  severity="secondary"
                  onClick={() => loadChains()}
                  loading={chainsLoading}
                  disabled={chainReordering}
                />
              </div>

              <small>
                Skriptketten kombinieren einzelne Scripte und Systemblöcke (z.B. Warten) zu einer ausführbaren Sequenz.
                Ketten können an Jobs als Pre- oder Post-Encode-Aktion hinterlegt werden.
              </small>
              <small className="muted-inline">
                Reihenfolge per Drag & Drop ändern.
                {chainReordering ? ' Speichere Reihenfolge ...' : ''}
              </small>

              <div className="script-list-box">
                <h4>Verfügbare Skriptketten</h4>
                {chainsLoading ? (
                  <p>Lade Skriptketten...</p>
                ) : chains.length === 0 ? (
                  <p>Keine Skriptketten vorhanden.</p>
                ) : (
                  <div className="script-list script-list--reorderable">
                    <div className="script-order-list">
                      {chains.map((chain, index) => {
                        const isDragging = Number(chainListDragSourceId) === Number(chain.id);
                        return (
                          <div key={chain.id} className="script-order-wrapper">
                            <div
                              className="script-order-drop-zone"
                              onDragOver={handleChainListDragOver}
                              onDrop={(event) => handleChainListDrop(event, index)}
                            />
                            <div
                              className={`script-list-item${isDragging ? ' script-list-item--dragging' : ''}`}
                              draggable={!chainListDnDDisabled}
                              onDragStart={(event) => handleChainListDragStart(event, chain.id)}
                              onDragEnd={() => setChainListDragSourceId(null)}
                            >
                              <div
                                className={`script-list-drag-handle${chainListDnDDisabled ? ' disabled' : ''}`}
                                title={chainListDnDDisabled ? 'Sortierung aktuell nicht verfügbar' : 'Ziehen zum Sortieren'}
                              >
                                <i className="pi pi-bars" />
                              </div>
                              <div className="script-list-main">
                                <strong className="script-id-title">{`ID #${chain.id} - ${chain.name}`}</strong>
                                <small>
                                  {chain.steps?.length ?? 0} Schritt(e):
                                  {' '}
                                  {(chain.steps || []).map((s, i) => (
                                    <span key={i}>
                                      {i > 0 ? ' → ' : ''}
                                      {s.stepType === 'wait'
                                        ? `⏱ ${s.waitSeconds}s`
                                        : (s.scriptName || `Script #${s.scriptId}`)}
                                    </span>
                                  ))}
                                </small>
                              </div>
                              <div className="script-list-actions">
                                <Button
                                  icon="pi pi-pencil"
                                  label="Bearbeiten"
                                  severity="secondary"
                                  outlined
                                  onClick={() => openChainEditor(chain)}
                                  disabled={chainReordering || Boolean(chainActionBusyId)}
                                />
                                <Button
                                  icon="pi pi-play"
                                  label="Test"
                                  severity="info"
                                  onClick={() => handleTestChain(chain)}
                                  loading={chainActionBusyId === chain.id}
                                  disabled={chainReordering || (Boolean(chainActionBusyId) && chainActionBusyId !== chain.id)}
                                />
                                <Button
                                  icon="pi pi-trash"
                                  label="Löschen"
                                  severity="danger"
                                  outlined
                                  onClick={() => handleDeleteChain(chain)}
                                  disabled={chainReordering || Boolean(chainActionBusyId)}
                                />
                              </div>
                            </div>
                          </div>
                        );
                      })}
                      <div
                        className="script-order-drop-zone script-order-drop-zone--end"
                        onDragOver={handleChainListDragOver}
                        onDrop={(event) => handleChainListDrop(event, chains.length)}
                      />
                    </div>
                  </div>
                )}
              </div>
            {lastChainTestResult ? (
              <div className="script-test-result">
                <h4>Letzter Ketten-Test: {lastChainTestResult.chainName}</h4>
                <small>
                  Status: {lastChainTestResult.aborted ? 'Abgebrochen' : 'Erfolgreich'}
                  {' | '}Schritte: {lastChainTestResult.succeeded ?? 0}/{lastChainTestResult.steps ?? 0}
                  {lastChainTestResult.failed > 0 ? ` | Fehler: ${lastChainTestResult.failed}` : ''}
                </small>
                {(lastChainTestResult.results || []).map((step, i) => (
                  <div key={i} className="script-test-step">
                    <strong>
                      {`Schritt ${i + 1}: `}
                      {step.stepType === 'wait'
                        ? `⏱ Warten (${step.waitSeconds}s)`
                        : (step.scriptName || `Script #${step.scriptId}`)}
                      {' — '}
                      {step.skipped ? 'Übersprungen' : (step.success ? '✓ OK' : `✗ Fehler (exit=${step.exitCode ?? 'n/a'})`)}
                    </strong>
                    {(step.stdout || step.stderr) ? (
                      <pre>{`${step.stdout || ''}${step.stderr ? `\n${step.stderr}` : ''}`.trim()}</pre>
                    ) : null}
                  </div>
                ))}
              </div>
            ) : null}
            </div>

            {/* Chain editor dialog */}
            <Dialog
              header={chainEditor.id ? `Skriptkette bearbeiten (#${chainEditor.id})` : 'Neue Skriptkette'}
              visible={chainEditor.open}
              onHide={closeChainEditor}
              style={{ width: 'min(70rem, calc(100vw - 1.5rem))' }}
              className="script-edit-dialog chain-editor-dialog"
              dismissableMask={false}
              draggable={false}
            >
              <div className="chain-editor-name-row">
                <label htmlFor="chain-name">Name der Kette</label>
                <InputText
                  id="chain-name"
                  value={chainEditor.name}
                  onChange={(e) => {
                    setChainEditor((prev) => ({ ...prev, name: e.target.value }));
                    setChainEditorErrors((prev) => ({ ...prev, name: null }));
                  }}
                  placeholder="z.B. Plex-Refresh + Cleanup"
                />
                {chainEditorErrors.name ? <small className="error-text">{chainEditorErrors.name}</small> : null}
              </div>

              <div className="chain-editor-body">
                {/* Palette */}
                <div className="chain-palette">
                  <h4>Bausteine</h4>
                  <p className="chain-palette-hint">Auf Schritt klicken oder in die Kette ziehen</p>

                  <div className="chain-palette-section">
                    <strong>Systemblöcke</strong>
                    <div
                      className="chain-palette-item chain-palette-item--system"
                      draggable
                      onDragStart={(e) => handleChainPaletteDragStart(e, { stepType: 'wait' })}
                      onClick={() => addChainStep('wait')}
                      title="Wartezeit zwischen zwei Schritten"
                    >
                      <i className="pi pi-clock" />
                      {' '}Warten (Sekunden)
                    </div>
                  </div>

                  {scripts.length > 0 ? (
                    <div className="chain-palette-section">
                      <strong>Scripte</strong>
                      {scripts.map((script) => (
                        <div
                          key={script.id}
                          className="chain-palette-item chain-palette-item--script"
                          draggable
                          onDragStart={(e) => handleChainPaletteDragStart(e, { stepType: 'script', scriptId: script.id, scriptName: script.name })}
                          onClick={() => addChainStep('script', script.id, script.name)}
                          title={`Script #${script.id} hinzufügen`}
                        >
                          <i className="pi pi-code" />
                          {' '}{script.name}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <small>Keine Scripte verfügbar. Zuerst Scripte anlegen.</small>
                  )}
                </div>

                {/* Chain canvas */}
                <div className="chain-canvas">
                  <h4>Kette ({chainEditor.steps.length} Schritt{chainEditor.steps.length !== 1 ? 'e' : ''})</h4>

                  {chainEditor.steps.length === 0 ? (
                    <div
                      className="chain-canvas-empty"
                      onDragOver={handleChainDragOver}
                      onDrop={(e) => handleChainDropzoneDrop(e, 0)}
                    >
                      Bausteine hierhin ziehen oder links anklicken
                    </div>
                  ) : (
                    <div className="chain-steps-list">
                      {chainEditor.steps.map((step, index) => (
                        <div key={step._key || index} className="chain-step-wrapper">
                          {/* Drop zone before step */}
                          <div
                            className="chain-drop-zone"
                            onDragOver={handleChainDragOver}
                            onDrop={(e) => handleChainDropzoneDrop(e, index)}
                          />
                          <div
                            className={`chain-step chain-step--${step.stepType}`}
                            draggable
                            onDragStart={(e) => handleChainStepDragStart(e, index)}
                            onDragEnd={() => setChainDragSource(null)}
                          >
                            <div className="chain-step-drag-handle">
                              <i className="pi pi-bars" />
                            </div>
                            <div className="chain-step-content">
                              {step.stepType === 'wait' ? (
                                <div className="chain-step-wait">
                                  <i className="pi pi-clock" />
                                  <span>Warten:</span>
                                  <input
                                    type="number"
                                    min="1"
                                    max="3600"
                                    value={step.waitSeconds ?? 10}
                                    onChange={(e) => updateChainStepWait(index, Number(e.target.value))}
                                    className="chain-wait-input"
                                    onClick={(e) => e.stopPropagation()}
                                  />
                                  <span>Sekunden</span>
                                </div>
                              ) : (
                                <div className="chain-step-script">
                                  <i className="pi pi-code" />
                                  <span>{step.scriptName || `Script #${step.scriptId}`}</span>
                                </div>
                              )}
                            </div>
                            <Button
                              icon="pi pi-times"
                              severity="danger"
                              text
                              rounded
                              className="chain-step-remove"
                              onClick={() => removeChainStep(index)}
                              title="Schritt entfernen"
                            />
                          </div>
                        </div>
                      ))}
                      {/* Drop zone after last step */}
                      <div
                        className="chain-drop-zone chain-drop-zone--end"
                        onDragOver={handleChainDragOver}
                        onDrop={(e) => handleChainDropzoneDrop(e, chainEditor.steps.length)}
                      />
                    </div>
                  )}
                </div>
              </div>

              <div className="actions-row" style={{ marginTop: '1rem' }}>
                <Button
                  label={chainEditor.id ? 'Kette aktualisieren' : 'Kette erstellen'}
                  icon="pi pi-save"
                  onClick={handleSaveChain}
                  loading={chainSaving}
                />
                <Button
                  label="Abbrechen"
                  icon="pi pi-times"
                  severity="secondary"
                  outlined
                  onClick={closeChainEditor}
                  disabled={chainSaving}
                />
              </div>
            </Dialog>
          </TabPanel>

          <TabPanel header="Encode-Presets">
            <div className="actions-row">
              <Button
                label="Neues Preset"
                icon="pi pi-plus"
                onClick={openNewUserPreset}
                severity="success"
                outlined
                disabled={userPresetSaving}
              />
              <Button
                label="Presets neu laden"
                icon="pi pi-refresh"
                severity="secondary"
                onClick={() => loadUserPresets()}
                loading={userPresetsLoading}
                disabled={userPresetSaving}
              />
            </div>

            <small>
              Encode-Presets fassen ein HandBrake-Preset und zusätzliche CLI-Argumente zusammen.
              Sie sind medienbezogen (Blu-ray, DVD oder Universell) und können vor dem Encode
              in der Mediainfo-Prüfung ausgewählt werden. Kein Preset gewählt = Fallback aus Einstellungen.
            </small>

            {userPresetsLoading ? (
              <p style={{ marginTop: '1rem' }}>Lade Presets ...</p>
            ) : userPresets.length === 0 ? (
              <p style={{ marginTop: '1rem' }}>Keine Presets vorhanden. Lege ein neues Preset an.</p>
            ) : (
              <div className="script-list script-list--reorderable" style={{ marginTop: '1rem' }}>
                {userPresets.map((preset) => (
                  <div key={preset.id} className="script-list-item">
                    <div className="script-list-main">
                      <div className="script-title-line">
                        <strong className="script-id-title">#{preset.id} - {preset.name}</strong>
                        <span className="preset-media-type-tag">
                          {preset.mediaType === 'bluray' ? 'Blu-ray'
                            : preset.mediaType === 'dvd' ? 'DVD'
                            : 'Universell'}
                        </span>
                      </div>
                      <small className="preset-description-line" title={preset.description || ''}>
                        {preset.description || '-'}
                      </small>
                    </div>
                    <div className="script-list-actions script-list-actions--two">
                      <Button
                        icon="pi pi-pencil"
                        label="Bearbeiten"
                        severity="secondary"
                        outlined
                        onClick={() => openEditUserPreset(preset)}
                      />
                      <Button
                        icon="pi pi-trash"
                        label="Löschen"
                        severity="danger"
                        outlined
                        onClick={() => handleDeleteUserPreset(preset.id)}
                      />
                    </div>
                  </div>
                ))}
              </div>
            )}

            <Dialog
              header={userPresetEditor.id ? 'Preset bearbeiten' : 'Neues Preset'}
              visible={userPresetEditor.open}
              style={{ width: '520px' }}
              onHide={closeUserPresetEditor}
              modal
            >
              <div className="script-editor-fields" style={{ display: 'flex', flexDirection: 'column', gap: '0.8rem' }}>
                <div>
                  <label htmlFor="preset-name" style={{ display: 'block', marginBottom: '0.3rem' }}>Name *</label>
                  <InputText
                    id="preset-name"
                    value={userPresetEditor.name}
                    onChange={(e) => setUserPresetEditor((prev) => ({ ...prev, name: e.target.value }))}
                    placeholder="z.B. Blu-ray HQ"
                    style={{ width: '100%' }}
                  />
                  {userPresetErrors.name && <small className="error-text">{userPresetErrors.name}</small>}
                </div>

                <div>
                  <label htmlFor="preset-media-type" style={{ display: 'block', marginBottom: '0.3rem' }}>Medientyp</label>
                  <select
                    id="preset-media-type"
                    value={userPresetEditor.mediaType}
                    onChange={(e) => setUserPresetEditor((prev) => ({ ...prev, mediaType: e.target.value }))}
                    style={{ width: '100%', padding: '0.5rem', borderRadius: '4px', border: '1px solid var(--surface-border, #ccc)', background: 'var(--surface-overlay, #fff)', color: 'var(--text-color, #000)' }}
                  >
                    <option value="all">Universell (alle Medien)</option>
                    <option value="bluray">Blu-ray</option>
                    <option value="dvd">DVD</option>
                  </select>
                </div>

                <div>
                  <label htmlFor="preset-hb-preset" style={{ display: 'block', marginBottom: '0.3rem' }}>HandBrake Preset (-Z)</label>
                  <Dropdown
                    id="preset-hb-preset"
                    value={userPresetEditor.handbrakePreset}
                    options={userPresetHandBrakeOptions}
                    optionLabel="label"
                    optionValue="value"
                    optionDisabled="disabled"
                    onChange={(e) => setUserPresetEditor((prev) => ({ ...prev, handbrakePreset: String(e.value || '') }))}
                    placeholder="Preset auswählen"
                    showClear
                    style={{ width: '100%' }}
                  />
                </div>

                <div>
                  <label htmlFor="preset-extra-args" style={{ display: 'block', marginBottom: '0.3rem' }}>Extra Args</label>
                  <InputText
                    id="preset-extra-args"
                    value={userPresetEditor.extraArgs}
                    onChange={(e) => setUserPresetEditor((prev) => ({ ...prev, extraArgs: e.target.value }))}
                    placeholder="z.B. -q 22 --encoder x264"
                    style={{ width: '100%' }}
                  />
                </div>

                <div>
                  <label htmlFor="preset-description" style={{ display: 'block', marginBottom: '0.3rem' }}>Beschreibung (optional)</label>
                  <InputTextarea
                    id="preset-description"
                    value={userPresetEditor.description}
                    onChange={(e) => setUserPresetEditor((prev) => ({ ...prev, description: e.target.value }))}
                    rows={3}
                    autoResize
                    placeholder="Kurzbeschreibung für dieses Preset"
                    style={{ width: '100%' }}
                  />
                </div>

                <div className="actions-row" style={{ marginTop: '0.5rem' }}>
                  <Button
                    label={userPresetEditor.id ? 'Aktualisieren' : 'Erstellen'}
                    icon="pi pi-save"
                    onClick={handleSaveUserPreset}
                    loading={userPresetSaving}
                  />
                  <Button
                    label="Abbrechen"
                    icon="pi pi-times"
                    severity="secondary"
                    outlined
                    onClick={closeUserPresetEditor}
                    disabled={userPresetSaving}
                  />
                </div>
              </div>
            </Dialog>
          </TabPanel>

          <TabPanel header="Cronjobs">
            <CronJobsTab />
          </TabPanel>
        </TabView>
      </Card>
    </div>
  );
}
