import React, { useEffect, useRef, useState } from 'react';
import { TabView, TabPanel } from 'primereact/tabview';
import { Accordion, AccordionTab } from 'primereact/accordion';
import { InputText } from 'primereact/inputtext';
import { InputNumber } from 'primereact/inputnumber';
import { InputSwitch } from 'primereact/inputswitch';
import { Dropdown } from 'primereact/dropdown';
import { Checkbox } from 'primereact/checkbox';
import { Tag } from 'primereact/tag';
import { Button } from 'primereact/button';
import { api } from '../api/client';

function normalizeText(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeSettingKey(value) {
  return String(value || '').trim().toLowerCase();
}

const GENERAL_TOOL_KEYS = new Set([
  'makemkv_command',
  'makemkv_registration_key',
  'makemkv_min_length_minutes',
  'playlist_tmdb_runtime_subtract_percent',
  'mediainfo_command',
  'handbrake_command',
  'ffmpeg_command',
  'mkvmerge_command',
  'ffprobe_command',
  'handbrake_restart_delete_incomplete_output',
  'script_test_timeout_ms'
]);

const HANDBRAKE_PRESET_SETTING_KEYS = new Set([
  'handbrake_preset',
  'handbrake_preset_bluray',
  'handbrake_preset_dvd'
]);

const NOTIFICATION_EVENT_TOGGLE_KEYS = new Set([
  'pushover_notify_metadata_ready',
  'pushover_notify_rip_started',
  'pushover_notify_encoding_started',
  'pushover_notify_job_finished',
  'pushover_notify_job_error',
  'pushover_notify_job_cancelled',
  'pushover_notify_reencode_started',
  'pushover_notify_reencode_finished'
]);

const PUSHOVER_ENABLED_SETTING_KEY = 'pushover_enabled';
const EXPERT_MODE_SETTING_KEY = 'ui_expert_mode';
const EXTERNAL_STORAGE_PATHS_KEY = 'external_storage_paths';
const ALWAYS_HIDDEN_SETTING_KEYS = new Set([
  'drive_device',
  'makemkv_source_index', // auto-derived from drive path — shown as read-only in drive info
  'makemkv_rip_mode',
  'makemkv_rip_mode_bluray',
  'makemkv_rip_mode_dvd',
  'makemkv_backup_mode',
  'handbrake_review_audio_languages_bluray',
  'handbrake_review_subtitle_languages_bluray',
  'handbrake_review_audio_languages_dvd',
  'handbrake_review_subtitle_languages_dvd'
]);
const EXPERT_ONLY_SETTING_KEYS = new Set([
  'pushover_device',
  'pushover_priority',
  'pushover_timeout_ms',
  'disc_poll_interval_ms',
  'hardware_monitoring_interval_ms',
  'makemkv_command',
  'mediainfo_command',
  'handbrake_command',
  'mediainfo_extra_args_bluray',
  'mediainfo_extra_args_dvd',
  'makemkv_analyze_extra_args_bluray',
  'makemkv_analyze_extra_args_dvd',
  'makemkv_rip_extra_args_bluray',
  'makemkv_rip_extra_args_dvd',
  'cdparanoia_command',
  'script_test_timeout_ms'
]);
const EXPERT_ONLY_CATEGORY_NAMES = new Set([
  'logging'
]);

function toBoolean(value) {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return value !== 0;
  }
  const normalized = normalizeText(value);
  if (!normalized) {
    return false;
  }
  return normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on';
}

function DriveDevicesEditor({ value, onChange, settingKey }) {
  const parseDevices = (val) => {
    try {
      const parsed = JSON.parse(val || '[]');
      if (!Array.isArray(parsed)) return [];
      const normalized = parsed.map((e) => {
        if (typeof e === 'string') {
          const p = e.trim();
          if (!p) return null;
          return { path: p, makemkvIndex: null };
        }
        if (e && typeof e === 'object') {
          const p = String(e.path || '').trim();
          if (!p) return null;
          const idxRaw = Number(e.makemkvIndex);
          return {
            path: p,
            makemkvIndex: Number.isFinite(idxRaw) && idxRaw >= 0 ? Math.trunc(idxRaw) : null
          };
        }
        return null;
      }).filter(Boolean);
      const used = new Set();
      let nextAutoIndex = 0;
      return normalized.map((entry) => {
        if (entry.makemkvIndex != null) {
          used.add(entry.makemkvIndex);
          if (entry.makemkvIndex >= nextAutoIndex) {
            nextAutoIndex = entry.makemkvIndex + 1;
          }
          return entry;
        }
        while (used.has(nextAutoIndex)) {
          nextAutoIndex += 1;
        }
        const resolved = { path: entry.path, makemkvIndex: nextAutoIndex };
        used.add(nextAutoIndex);
        nextAutoIndex += 1;
        return resolved;
      });
    } catch (_e) {
      return [];
    }
  };

  const devices = parseDevices(value);

  const updateDevices = (newDevices) => {
    onChange?.(settingKey, JSON.stringify(newDevices));
  };

  return (
    <div className="drive-devices-editor">
      {devices.length === 0 && (
        <p className="drive-devices-empty">Keine expliziten Laufwerke konfiguriert.</p>
      )}
      {devices.map((dev, idx) => (
        <div key={idx} className="drive-device-row">
          <InputText
            value={dev.path}
            placeholder="/dev/sr0"
            onChange={(e) => {
              const next = [...devices];
              const p = e.target.value;
              next[idx] = { ...next[idx], path: p };
              updateDevices(next);
            }}
            className="drive-device-input"
          />
          <InputNumber
            value={dev.makemkvIndex}
            min={0}
            max={9}
            showButtons={false}
            placeholder="Idx"
            title="MakeMKV disc index (disc:N)"
            style={{ width: '4rem' }}
            inputStyle={{ textAlign: 'center' }}
            onChange={(e) => {
              const next = [...devices];
              next[idx] = { ...next[idx], makemkvIndex: e.value ?? 0 };
              updateDevices(next);
            }}
          />
          <Button
            icon="pi pi-trash"
            severity="danger"
            text
            rounded
            size="small"
            onClick={() => updateDevices(devices.filter((_, i) => i !== idx))}
            type="button"
            aria-label="Laufwerk entfernen"
          />
        </div>
      ))}
      <Button
        icon="pi pi-plus"
        label="Laufwerk hinzufügen"
        severity="secondary"
        text
        size="small"
        onClick={() => {
          const nextIdx = devices.length;
          updateDevices([...devices, { path: '', makemkvIndex: nextIdx }]);
        }}
        type="button"
      />
    </div>
  );
}

function ExternalStoragePathsEditor({ value, onChange, settingKey }) {
  const parsePaths = (rawValue) => {
    try {
      const parsed = JSON.parse(rawValue || '[]');
      if (!Array.isArray(parsed)) return [];
      const normalized = [];
      for (const entry of parsed) {
        if (typeof entry === 'string') {
          normalized.push({
            name: '',
            path: String(entry || '')
          });
          continue;
        }
        if (entry && typeof entry === 'object') {
          normalized.push({
            name: String(entry.name || entry.label || ''),
            path: String(entry.path || '')
          });
        }
      }
      return normalized;
    } catch (_error) {
      return [];
    }
  };

  const entries = parsePaths(value);

  const updatePaths = (nextPaths) => {
    const normalized = (Array.isArray(nextPaths) ? nextPaths : [])
      .map((entry) => ({
        name: String(entry?.name || ''),
        path: String(entry?.path || '')
      }));
    onChange?.(settingKey, JSON.stringify(normalized));
  };

  return (
    <div className="external-storage-editor">
      {entries.length === 0 && (
        <p className="external-storage-empty">Keine externen Speicherpfade konfiguriert.</p>
      )}
      {entries.map((entry, idx) => (
        <div key={`external-storage-${idx}`} className="external-storage-row">
          <InputText
            value={entry.name}
            placeholder="Name (z.B. USB HDD)"
            onChange={(event) => {
              const next = [...entries];
              next[idx] = { ...next[idx], name: event.target.value };
              updatePaths(next);
            }}
            className="external-storage-name-input"
          />
          <InputText
            value={entry.path}
            placeholder="/mnt/external-disk"
            onChange={(event) => {
              const next = [...entries];
              next[idx] = { ...next[idx], path: event.target.value };
              updatePaths(next);
            }}
            className="external-storage-input"
          />
          <Button
            icon="pi pi-trash"
            severity="danger"
            text
            rounded
            size="small"
            onClick={() => updatePaths(entries.filter((_, entryIndex) => entryIndex !== idx))}
            type="button"
            aria-label="Externen Speicherpfad entfernen"
          />
        </div>
      ))}
      <Button
        icon="pi pi-plus"
        label="Pfad hinzufügen"
        severity="secondary"
        text
        size="small"
        onClick={() => updatePaths([...entries, { name: '', path: '' }])}
        type="button"
      />
    </div>
  );
}

function DetectedDrivesInfo({ expertModeEnabled = false, onNotify = null }) {
  const [drives, setDrives] = useState(null);
  const [loading, setLoading] = useState(false);
  const [unlocking, setUnlocking] = useState(false);

  const load = () => {
    setLoading(true);
    api.getDetectedDrives()
      .then((res) => setDrives(Array.isArray(res?.drives) ? res.drives : []))
      .catch(() => setDrives([]))
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, []);

  const notify = (severity, summary, detail) => {
    if (typeof onNotify === 'function') {
      onNotify({ severity, summary, detail });
    }
  };

  const handleUnlockOne = async (devicePath) => {
    setUnlocking(true);
    try {
      await api.forceUnlockDrive({ devicePath });
      notify('success', 'Laufwerk freigegeben', `${devicePath} wurde entsperrt.`);
      load();
    } catch (error) {
      notify('error', 'Freigabe fehlgeschlagen', error?.message || 'Unbekannter Fehler');
    } finally {
      setUnlocking(false);
    }
  };

  const handleUnlockAll = async () => {
    setUnlocking(true);
    try {
      await api.forceUnlockDrive({ all: true });
      notify('success', 'Laufwerke freigegeben', 'Alle erkannten Laufwerke wurden entsperrt.');
      load();
    } catch (error) {
      notify('error', 'Freigabe fehlgeschlagen', error?.message || 'Unbekannter Fehler');
    } finally {
      setUnlocking(false);
    }
  };

  return (
    <div className="detected-drives-info">
      <div className="detected-drives-header">
        <span className="detected-drives-label">Erkannte optische Laufwerke</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.3rem' }}>
          {expertModeEnabled ? (
            <Button
              icon="pi pi-unlock"
              text
              rounded
              size="small"
              loading={unlocking}
              disabled={loading}
              onClick={handleUnlockAll}
              type="button"
              aria-label="Alle Laufwerke freigeben"
              title="Alle Laufwerke freigeben"
            />
          ) : null}
          <Button
            icon="pi pi-refresh"
            text
            rounded
            size="small"
            loading={loading}
            disabled={unlocking}
            onClick={load}
            type="button"
            aria-label="Laufwerke neu einlesen"
            title="Laufwerke neu einlesen"
          />
        </div>
      </div>
      {drives === null || loading
        ? <span className="detected-drives-empty">Wird geladen…</span>
        : drives.length === 0
          ? <span className="detected-drives-empty">Keine optischen Laufwerke erkannt.</span>
          : (
            <table className="detected-drives-table">
              <thead>
                <tr>
                  <th>Gerät</th>
                  <th>Modell</th>
                  <th>MakeMKV Index</th>
                  {expertModeEnabled ? <th>Freigabe</th> : null}
                </tr>
              </thead>
              <tbody>
                {drives.map((d) => (
                  <tr key={d.path}>
                    <td><code>{d.path}</code></td>
                    <td>{d.model || '—'}</td>
                    <td><Tag value={d.discArg ?? '—'} severity="info" /></td>
                    {expertModeEnabled ? (
                      <td>
                        <Button
                          label="Freigeben"
                          icon="pi pi-unlock"
                          size="small"
                          text
                          onClick={() => handleUnlockOne(d.path)}
                          loading={unlocking}
                          disabled={loading}
                        />
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
    </div>
  );
}

function shouldHideSettingByExpertMode(settingKey, expertModeEnabled) {
  const key = normalizeSettingKey(settingKey);
  if (!key) {
    return false;
  }
  if (ALWAYS_HIDDEN_SETTING_KEYS.has(key)) {
    return true;
  }
  if (key === EXPERT_MODE_SETTING_KEY) {
    return true;
  }
  return !expertModeEnabled && EXPERT_ONLY_SETTING_KEYS.has(key);
}

function filterSettingsByVisibility(settings, expertModeEnabled) {
  const list = Array.isArray(settings) ? settings : [];
  return list.filter((setting) => !shouldHideSettingByExpertMode(setting?.key, expertModeEnabled));
}

function shouldHideCategoryByExpertMode(categoryName, expertModeEnabled) {
  const normalizedCategory = normalizeText(categoryName);
  if (!normalizedCategory) {
    return false;
  }
  return !expertModeEnabled && EXPERT_ONLY_CATEGORY_NAMES.has(normalizedCategory);
}

function buildToolSections(settings) {
  const list = Array.isArray(settings) ? settings : [];
  const generalBucket = {
    id: 'general',
    title: 'General',
    description: 'Gemeinsame Tool-Settings für alle Medien.',
    settings: []
  };
  const blurayBucket = {
    id: 'bluray',
    title: 'BluRay',
    description: 'Profil-spezifische Settings für Blu-ray.',
    settings: []
  };
  const dvdBucket = {
    id: 'dvd',
    title: 'DVD',
    description: 'Profil-spezifische Settings für DVD.',
    settings: []
  };
  const audiobookBucket = {
    id: 'audiobook',
    title: 'Audiobook',
    description: 'Profil-spezifische Settings für Audiobooks.',
    settings: []
  };
  const fallbackBucket = {
    id: 'other',
    title: 'Weitere Tool-Settings',
    description: null,
    settings: []
  };

  for (const setting of list) {
    const key = normalizeSettingKey(setting?.key);
    if (GENERAL_TOOL_KEYS.has(key)) {
      generalBucket.settings.push(setting);
      continue;
    }
    if (key.endsWith('_bluray')) {
      blurayBucket.settings.push(setting);
      continue;
    }
    if (key.endsWith('_dvd')) {
      dvdBucket.settings.push(setting);
      continue;
    }
    if (key.endsWith('_audiobook')) {
      audiobookBucket.settings.push(setting);
      continue;
    }
    fallbackBucket.settings.push(setting);
  }

  const sections = [
    generalBucket,
    blurayBucket,
    dvdBucket,
    audiobookBucket
  ].filter((item) => item.settings.length > 0);
  if (fallbackBucket.settings.length > 0) {
    sections.push(fallbackBucket);
  }
  return sections;
}

// Path keys per medium — _owner keys are rendered inline
const BLURAY_PATH_KEYS = [
  'raw_dir_bluray',
  'raw_dir_bluray_series',
  'movie_dir_bluray',
  'series_dir_bluray',
  'output_template_bluray',
  'output_template_bluray_series_episode',
  'output_template_bluray_series_multi_episode'
];
const DVD_PATH_KEYS = [
  'raw_dir_dvd',
  'raw_dir_dvd_series',
  'movie_dir_dvd',
  'series_dir_dvd',
  'output_template_dvd',
  'output_template_dvd_series_episode',
  'output_template_dvd_series_multi_episode'
];
const CD_PATH_KEYS = ['raw_dir_cd', 'movie_dir_cd', 'cd_output_template'];
const AUDIOBOOK_PATH_KEYS = ['raw_dir_audiobook', 'movie_dir_audiobook', 'output_template_audiobook', 'output_chapter_template_audiobook', 'audiobook_raw_template'];
const DOWNLOAD_PATH_KEYS = ['download_dir'];
const LOG_PATH_KEYS = ['log_dir'];
const EXTERNAL_STORAGE_PATH_KEYS = [EXTERNAL_STORAGE_PATHS_KEY];
const CONVERTER_PATH_KEYS = ['converter_raw_dir', 'converter_movie_dir', 'converter_audio_dir', 'converter_output_template_video', 'converter_output_template_audio'];
const CONVERTER_SCAN_EXTENSION_KEY = 'converter_scan_extensions';
const CONVERTER_SCAN_EXTENSION_OPTIONS = [
  'mkv', 'mp4', 'm2ts', 'iso', 'avi', 'mov',
  'flac', 'mp3', 'wav', 'm4a', 'ogg', 'opus'
];
const READONLY_CLI_SETTING_KEYS = new Set([
  'makemkv_command',
  'mediainfo_command',
  'handbrake_command',
  'ffmpeg_command',
  'ffprobe_command',
  'cdparanoia_command',
  'mkvmerge_command'
]);

function parseConverterScanExtensions(value) {
  const tokens = String(value || '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  const known = new Set(CONVERTER_SCAN_EXTENSION_OPTIONS);
  const seen = new Set();
  const selected = [];
  for (const token of tokens) {
    if (!known.has(token) || seen.has(token)) {
      continue;
    }
    seen.add(token);
    selected.push(token);
  }
  return selected;
}

function serializeConverterScanExtensions(values) {
  const list = Array.isArray(values) ? values : [];
  const known = new Set(CONVERTER_SCAN_EXTENSION_OPTIONS);
  const seen = new Set();
  const normalized = [];
  for (const item of list) {
    const ext = String(item || '').trim().toLowerCase();
    if (!known.has(ext) || seen.has(ext)) {
      continue;
    }
    seen.add(ext);
    normalized.push(ext);
  }
  return normalized.join(',');
}

function ConverterScanExtensionsEditor({ value, onChange, settingKey }) {
  const selected = parseConverterScanExtensions(value);
  const selectedSet = new Set(selected);

  const handleToggle = (extension) => {
    const ext = String(extension || '').trim().toLowerCase();
    if (!ext) {
      return;
    }
    let next = selected.filter((item) => item !== ext);
    if (!selectedSet.has(ext)) {
      next = [...selected, ext];
    }
    // Setting ist required/minLength: mindestens eine Endung aktiv lassen.
    if (next.length === 0) {
      return;
    }
    onChange?.(settingKey, serializeConverterScanExtensions(next));
  };

  return (
    <div className="converter-scan-extensions-grid">
      {CONVERTER_SCAN_EXTENSION_OPTIONS.map((extension) => (
        <label key={extension} htmlFor={`${settingKey}-${extension}`} className="converter-scan-extension-option">
          <Checkbox
            inputId={`${settingKey}-${extension}`}
            checked={selectedSet.has(extension)}
            onChange={() => handleToggle(extension)}
          />
          <span>.{extension}</span>
        </label>
      ))}
    </div>
  );
}

function buildSectionsForCategory(categoryName, settings) {
  const list = Array.isArray(settings) ? settings : [];
  const normalizedCategory = normalizeText(categoryName);
  if (normalizedCategory === 'tools') {
    const sections = buildToolSections(list);
    if (sections.length > 0) {
      return sections;
    }
  }
  return [
    {
      id: 'all',
      title: null,
      description: null,
      settings: list
    }
  ];
}

function isHandBrakePresetSetting(setting) {
  const key = String(setting?.key || '').trim().toLowerCase();
  return HANDBRAKE_PRESET_SETTING_KEYS.has(key);
}

function isNotificationEventToggleSetting(setting) {
  return setting?.type === 'boolean' && NOTIFICATION_EVENT_TOGGLE_KEYS.has(normalizeSettingKey(setting?.key));
}

function isReadonlySetting(setting) {
  const key = normalizeSettingKey(setting?.key);
  if (READONLY_CLI_SETTING_KEYS.has(key)) {
    return true;
  }
  try {
    // API gibt validation als parsed object zurück, nicht validation_json als String
    const v = setting?.validation;
    if (v && typeof v === 'object') return v.readonly === true;
    return JSON.parse(setting?.validation_json || '{}')?.readonly === true;
  } catch {
    return false;
  }
}

function MakeMKVBetaKeyHint({ disabled = false, onNotify = null, onSettingApplied = null }) {
  const [loading, setLoading] = useState(true);
  const [checking, setChecking] = useState(false);
  const [applying, setApplying] = useState(false);
  const [betaKey, setBetaKey] = useState('');
  const [validUntil, setValidUntil] = useState('');
  const [fetchedAt, setFetchedAt] = useState('');
  const [appliedKey, setAppliedKey] = useState('');
  const [error, setError] = useState('');
  const [warning, setWarning] = useState('');

  const loadCachedState = async () => {
    setLoading(true);
    setError('');
    setWarning('');
    try {
      const response = await api.getMakeMKVBetaKey();
      setBetaKey(String(response?.betaKey || '').trim());
      setValidUntil(String(response?.validUntil || '').trim());
      setFetchedAt(String(response?.fetchedAt || '').trim());
      setAppliedKey(String(response?.appliedKey || '').trim());
      if (response?.stale) {
        setWarning('Zwischengespeicherter Betakey ist veraltet. Bitte bei Bedarf neu prüfen.');
      } else if (!response?.betaKey) {
        setWarning('Noch kein geprüfter Betakey im Cache. Prüfung startet nur per Button.');
      } else if (response?.appliedMatchesCache) {
        setWarning('Geprüfter Betakey ist bereits übernommen.');
      } else {
        setWarning('');
      }
    } catch (loadError) {
      setBetaKey('');
      setValidUntil('');
      setFetchedAt('');
      setAppliedKey('');
      setError(loadError?.message || 'Betakey konnte nicht geladen werden.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadCachedState();
  }, []);

  const handleCheck = async () => {
    setChecking(true);
    setError('');
    setWarning('');
    try {
      const response = await api.checkMakeMKVBetaKey();
      const nextKey = String(response?.betaKey || '').trim();
      setBetaKey(nextKey);
      setValidUntil(String(response?.validUntil || '').trim());
      setFetchedAt(String(response?.fetchedAt || '').trim());
      setWarning('');
      if (typeof onNotify === 'function') {
        onNotify({
          severity: 'success',
          summary: 'MakeMKV Betakey',
          detail: nextKey ? 'Betakey erfolgreich geprüft.' : 'Betakey-Prüfung abgeschlossen.'
        });
      }
    } catch (checkError) {
      setError(checkError?.message || 'Betakey konnte nicht geprüft werden.');
      if (typeof onNotify === 'function') {
        onNotify({
          severity: 'error',
          summary: 'MakeMKV Betakey',
          detail: checkError?.message || 'Betakey konnte nicht geprüft werden.'
        });
      }
    } finally {
      setChecking(false);
    }
  };

  const handleApply = async () => {
    if (!betaKey) {
      return;
    }
    setApplying(true);
    setError('');
    try {
      const response = await api.applyMakeMKVBetaKey({ betaKey });
      const nextAppliedKey = String(response?.betaKey || betaKey).trim();
      setAppliedKey(nextAppliedKey);
      setWarning('Geprüfter Betakey ist bereits übernommen.');
      if (typeof onSettingApplied === 'function') {
        onSettingApplied({
          key: 'makemkv_registration_key',
          value: nextAppliedKey
        });
      }
      if (typeof onNotify === 'function') {
        onNotify({
          severity: 'success',
          summary: 'MakeMKV Betakey',
          detail: 'Betakey wurde übernommen und gespeichert.'
        });
      }
    } catch (applyError) {
      setError(applyError?.message || 'Betakey konnte nicht übernommen werden.');
      if (typeof onNotify === 'function') {
        onNotify({
          severity: 'error',
          summary: 'MakeMKV Betakey',
          detail: applyError?.message || 'Betakey konnte nicht übernommen werden.'
        });
      }
    } finally {
      setApplying(false);
    }
  };

  return (
    <div className="makemkv-beta-key-box">
      <div className="makemkv-beta-key-head">
        <span className="makemkv-beta-key-title">Betakey</span>
        <div className="settings-inline-actions">
          <Button
            type="button"
            size="small"
            text
            label="prüfen"
            disabled={disabled || loading || checking || applying}
            onClick={() => void handleCheck()}
          />
          <Button
            type="button"
            size="small"
            text
            label="übernehmen"
            disabled={disabled || loading || checking || applying || !betaKey || betaKey === appliedKey}
            onClick={() => void handleApply()}
          />
        </div>
      </div>
      {loading ? (
        <small className="setting-description">Zwischengespeicherter Betakey wird geladen…</small>
      ) : null}
      {!loading && error ? (
        <small className="error-text">{error}</small>
      ) : null}
      {!loading && !error && warning ? (
        <small className="setting-description">{warning}</small>
      ) : null}
      {!loading && !error && fetchedAt ? (
        <small className="setting-description">Zuletzt geprüft: {new Date(fetchedAt).toLocaleString('de-DE')}</small>
      ) : null}
      {!loading && !error && validUntil ? (
        <small className="setting-description">Gültig bis: {new Date(validUntil).toLocaleString('de-DE')}</small>
      ) : null}
      {!loading && !error && betaKey ? (
        <code className="makemkv-beta-key-value">{betaKey}</code>
      ) : null}
    </div>
  );
}

function ActivationBytesCacheBox({ entries = [] }) {
  const list = Array.isArray(entries) ? entries : [];
  return (
    <section className="settings-section grouped activation-bytes-cache-box">
      <div className="settings-section-head">
        <h4>Activation Bytes Cache</h4>
        <small>Lokal gespeicherte AAX-Activation Bytes. Werden beim ersten Upload automatisch über die Audible-Tools API ermittelt.</small>
      </div>
      {list.length === 0 ? (
        <p>Keine Einträge vorhanden.</p>
      ) : (
        <div className="activation-bytes-table-wrap">
          <table className="activation-bytes-table">
            <thead>
              <tr>
                <th>Checksum</th>
                <th>Activation Bytes</th>
                <th>Gespeichert am</th>
              </tr>
            </thead>
            <tbody>
              {list.map((entry, index) => (
                <tr key={String(entry?.checksum || `activation-bytes-${index}`)}>
                  <td>{String(entry?.checksum || '-')}</td>
                  <td>{String(entry?.activation_bytes || '-')}</td>
                  <td>{entry?.created_at ? new Date(entry.created_at).toLocaleString('de-DE') : '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function SettingField({
  setting,
  value,
  error,
  dirty,
  ownerSetting,
  ownerValue,
  ownerError,
  ownerDirty,
  onChange,
  variant = 'default',
  disabled = false,
  onNotify = null,
  onSettingApplied = null
}) {
  const ownerKey = ownerSetting?.key;
  const pathHasValue = Boolean(String(value ?? '').trim());
  const isNotificationToggleBox = variant === 'notification-toggle' && setting?.type === 'boolean';
  const readonlySetting = isReadonlySetting(setting);
  const isDisabled = Boolean(disabled || readonlySetting);

  return (
    <div className={`setting-row${isNotificationToggleBox ? ' notification-toggle-box' : ''}`}>
      {isNotificationToggleBox ? (
        <div className="notification-toggle-head">
          <label htmlFor={setting.key}>
            {setting.label}
            {setting.required && <span className="required">*</span>}
          </label>
          <InputSwitch
            id={setting.key}
            checked={Boolean(value)}
            disabled={isDisabled}
            onChange={isDisabled ? undefined : (event) => onChange?.(setting.key, event.value)}
          />
        </div>
      ) : (
        <label htmlFor={setting.key} className={isDisabled ? 'setting-label--readonly' : undefined}>
          {setting.label}
          {setting.required && <span className="required">*</span>}
          {isDisabled ? (
            <span className="setting-badge--coming-soon">{readonlySetting ? ' (gesperrt)' : ' (bald)'}</span>
          ) : null}
        </label>
      )}

      {(setting.type === 'string' || setting.type === 'path')
      && setting.key !== 'drive_devices'
      && setting.key !== EXTERNAL_STORAGE_PATHS_KEY
      && setting.key !== CONVERTER_SCAN_EXTENSION_KEY ? (
        <InputText
          id={setting.key}
          value={value ?? ''}
          readOnly={isDisabled}
          disabled={isDisabled}
          onChange={isDisabled ? undefined : (event) => onChange?.(setting.key, event.target.value)}
        />
      ) : null}

      {setting.key === 'drive_devices' ? (
        <DriveDevicesEditor
          value={value}
          onChange={onChange}
          settingKey={setting.key}
        />
      ) : null}

      {setting.key === EXTERNAL_STORAGE_PATHS_KEY ? (
        <ExternalStoragePathsEditor
          value={value}
          onChange={onChange}
          settingKey={setting.key}
        />
      ) : null}

      {setting.key === CONVERTER_SCAN_EXTENSION_KEY ? (
        <ConverterScanExtensionsEditor
          value={value}
          onChange={onChange}
          settingKey={setting.key}
        />
      ) : null}

      {setting.type === 'number' ? (
        <InputNumber
          id={setting.key}
          value={value ?? 0}
          disabled={isDisabled}
          onValueChange={isDisabled ? undefined : (event) => onChange?.(setting.key, event.value)}
          mode="decimal"
          useGrouping={false}
        />
      ) : null}

      {setting.type === 'boolean' && !isNotificationToggleBox ? (
        <InputSwitch
          id={setting.key}
          checked={Boolean(value)}
          disabled={isDisabled}
          onChange={isDisabled ? undefined : (event) => onChange?.(setting.key, event.value)}
        />
      ) : null}

      {setting.type === 'select' ? (
        <Dropdown
          id={setting.key}
          value={value}
          options={setting.options}
          optionLabel="label"
          optionValue="value"
          optionDisabled="disabled"
          disabled={isDisabled}
          onChange={isDisabled ? undefined : (event) => onChange?.(setting.key, event.value)}
        />
      ) : null}

      <small className="setting-description">{setting.description || ''}</small>
      {isHandBrakePresetSetting(setting) ? (
        <small>
          Preset-Erklärung:{' '}
          <a
            href="https://handbrake.fr/docs/en/latest/technical/official-presets.html"
            target="_blank"
            rel="noreferrer"
          >
            HandBrake Official Presets
          </a>
        </small>
      ) : null}
      {normalizeSettingKey(setting?.key) === 'makemkv_registration_key' ? (
        <MakeMKVBetaKeyHint
          disabled={isDisabled}
          onNotify={onNotify}
          onSettingApplied={onSettingApplied}
        />
      ) : null}
      {error ? (
        <small className="error-text">{error}</small>
      ) : (
        <Tag
          value={dirty ? 'Ungespeichert' : 'Gespeichert'}
          severity={dirty ? 'warning' : 'success'}
          className="saved-tag"
        />
      )}

      {ownerSetting ? (
        <div className="setting-owner-row">
          <label htmlFor={ownerKey} className="setting-owner-label">
            Eigentümer (user:gruppe)
          </label>
          <InputText
            id={ownerKey}
            value={ownerValue ?? ''}
            placeholder="z.B. michael:ripster"
            disabled={isDisabled || !pathHasValue}
            onChange={isDisabled ? undefined : (event) => onChange?.(ownerKey, event.target.value)}
          />
          {ownerError ? (
            <small className="error-text">{ownerError}</small>
          ) : (
            <Tag
              value={ownerDirty ? 'Ungespeichert' : 'Gespeichert'}
              severity={ownerDirty ? 'warning' : 'success'}
              className="saved-tag"
            />
          )}
        </div>
      ) : null}
    </div>
  );
}


function PathCategoryTab({
  settings,
  values,
  errors,
  dirtyKeys,
  onChange,
  effectivePaths,
  onNotify,
  onSettingApplied
}) {
  const list = Array.isArray(settings) ? settings : [];
  const settingsByKey = new Map(list.map((s) => [s.key, s]));

  const bluraySettings = list.filter((s) => BLURAY_PATH_KEYS.includes(s.key) || (s.key.endsWith('_owner') && BLURAY_PATH_KEYS.includes(s.key.replace('_owner', ''))));
  const dvdSettings = list.filter((s) => DVD_PATH_KEYS.includes(s.key) || (s.key.endsWith('_owner') && DVD_PATH_KEYS.includes(s.key.replace('_owner', ''))));
  const cdSettings = list.filter((s) => CD_PATH_KEYS.includes(s.key) || (s.key.endsWith('_owner') && CD_PATH_KEYS.includes(s.key.replace('_owner', ''))));
  const audiobookSettings = list.filter((s) => AUDIOBOOK_PATH_KEYS.includes(s.key) || (s.key.endsWith('_owner') && AUDIOBOOK_PATH_KEYS.includes(s.key.replace('_owner', ''))));
  const downloadSettings = list.filter((s) => DOWNLOAD_PATH_KEYS.includes(s.key) || (s.key.endsWith('_owner') && DOWNLOAD_PATH_KEYS.includes(s.key.replace('_owner', ''))));
  const logSettings = list.filter((s) => LOG_PATH_KEYS.includes(s.key));
  const externalStorageSettings = list.filter((s) => EXTERNAL_STORAGE_PATH_KEYS.includes(s.key));
  const converterSettings = list.filter((s) => CONVERTER_PATH_KEYS.includes(s.key));

  const defaultRaw = effectivePaths?.defaults?.raw || 'data/output/raw';
  const defaultMovies = effectivePaths?.defaults?.movies || 'data/output/movies';
  const defaultSeries = effectivePaths?.defaults?.series || 'data/output/series';
  const defaultCd = effectivePaths?.defaults?.cd || 'data/output/cd';
  const defaultAudiobookRaw = effectivePaths?.defaults?.audiobookRaw || 'data/output/audiobook-raw';
  const defaultAudiobookMovies = effectivePaths?.defaults?.audiobookMovies || 'data/output/audiobooks';
  const defaultDownloads = effectivePaths?.defaults?.downloads || 'data/downloads';

  const defaultConverterRaw = effectivePaths?.defaults?.converterRaw || 'data/output/converter-raw';
  const defaultConverterMovies = effectivePaths?.defaults?.converterMovies || 'data/output/converted-movies';
  const defaultConverterAudio = effectivePaths?.defaults?.converterAudio || 'data/output/converted-audio';

  const ep = effectivePaths || {};
  const blurayRaw = ep.bluray?.raw || defaultRaw;
  const bluraySeriesRaw = ep.bluray?.seriesRaw || blurayRaw;
  const blurayMovies = ep.bluray?.movies || defaultMovies;
  const bluraySeries = ep.bluray?.series || defaultSeries;
  const dvdRaw = ep.dvd?.raw || defaultRaw;
  const dvdSeriesRaw = ep.dvd?.seriesRaw || dvdRaw;
  const dvdMovies = ep.dvd?.movies || defaultMovies;
  const dvdSeries = ep.dvd?.series || defaultSeries;
  const cdRaw = ep.cd?.raw || defaultCd;
  const cdMovies = ep.cd?.movies || cdRaw;
  const audiobookRaw = ep.audiobook?.raw || defaultAudiobookRaw;
  const audiobookMovies = ep.audiobook?.movies || defaultAudiobookMovies;
  const downloadPath = ep.downloads?.path || defaultDownloads;
  const converterRaw = ep.converter?.raw || defaultConverterRaw;
  const converterMovies = ep.converter?.movies || defaultConverterMovies;
  const converterAudio = ep.converter?.audio || defaultConverterAudio;

  const isDefault = (path, def) => path === def;

  return (
    <div className="path-category-tab">
      {/* Effektive Pfade Übersicht */}
      <div className="path-overview-card">
        <div className="path-overview-header">
          <h4>Effektive Pfade</h4>
          <small>Zeigt die tatsächlich verwendeten Pfade entsprechend der aktuellen Konfiguration.</small>
        </div>
        <table className="path-overview-table">
          <thead>
            <tr>
              <th>Medium</th>
              <th>RAW / Eingang</th>
              <th>Encode / Ausgang</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><strong>Blu-ray</strong></td>
              <td>
                <code>{blurayRaw}</code>
                {isDefault(blurayRaw, defaultRaw) && <span className="path-default-badge">Standard</span>}
              </td>
              <td>
                <code>{blurayMovies}</code>
                {isDefault(blurayMovies, defaultMovies) && <span className="path-default-badge">Standard</span>}
              </td>
            </tr>
            <tr>
              <td><strong>Blu-ray Serie</strong></td>
              <td>
                <code>{bluraySeriesRaw}</code>
                {isDefault(bluraySeriesRaw, blurayRaw) && <span className="path-default-badge">wie Blu-ray RAW</span>}
              </td>
              <td>
                <code>{bluraySeries}</code>
                {isDefault(bluraySeries, defaultSeries) && <span className="path-default-badge">Standard</span>}
              </td>
            </tr>
            <tr>
              <td><strong>DVD</strong></td>
              <td>
                <code>{dvdRaw}</code>
                {isDefault(dvdRaw, defaultRaw) && <span className="path-default-badge">Standard</span>}
              </td>
              <td>
                <code>{dvdMovies}</code>
                {isDefault(dvdMovies, defaultMovies) && <span className="path-default-badge">Standard</span>}
              </td>
            </tr>
            <tr>
              <td><strong>DVD Serie</strong></td>
              <td>
                <code>{dvdSeriesRaw}</code>
                {isDefault(dvdSeriesRaw, dvdRaw) && <span className="path-default-badge">wie DVD RAW</span>}
              </td>
              <td>
                <code>{dvdSeries}</code>
                {isDefault(dvdSeries, defaultSeries) && <span className="path-default-badge">Standard</span>}
              </td>
            </tr>
            <tr>
              <td><strong>CD / Audio</strong></td>
              <td>
                <code>{cdRaw}</code>
                {isDefault(cdRaw, defaultCd) && <span className="path-default-badge">Standard</span>}
              </td>
              <td>
                <code>{cdMovies}</code>
                {isDefault(cdMovies, cdRaw) && <span className="path-default-badge">Standard</span>}
              </td>
            </tr>
            <tr>
              <td><strong>Audiobook</strong></td>
              <td>
                <code>{audiobookRaw}</code>
                {isDefault(audiobookRaw, defaultAudiobookRaw) && <span className="path-default-badge">Standard</span>}
              </td>
              <td>
                <code>{audiobookMovies}</code>
                {isDefault(audiobookMovies, defaultAudiobookMovies) && <span className="path-default-badge">Standard</span>}
              </td>
            </tr>
            <tr>
              <td><strong>Zip-Downloads</strong></td>
              <td>
                <code>{downloadPath}</code>
                {isDefault(downloadPath, defaultDownloads) && <span className="path-default-badge">Standard</span>}
              </td>
              <td>---</td>
            </tr>
            <tr>
              <td><strong>Converter Raw</strong></td>
              <td>
                <code>{converterRaw}</code>
                {isDefault(converterRaw, defaultConverterRaw) && <span className="path-default-badge">Standard</span>}
              </td>
              <td>---</td>
            </tr>
            <tr>
              <td><strong>Converter Video</strong></td>
              <td>---</td>
              <td>
                <code>{converterMovies}</code>
                {isDefault(converterMovies, defaultConverterMovies) && <span className="path-default-badge">Standard</span>}
              </td>
            </tr>
            <tr>
              <td><strong>Converter Audio</strong></td>
              <td>---</td>
              <td>
                <code>{converterAudio}</code>
                {isDefault(converterAudio, defaultConverterAudio) && <span className="path-default-badge">Standard</span>}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      {/* Medium-Karten als Accordion */}
      <Accordion className="path-medium-accordion">
        {[
          { title: 'Blu-ray', pathSettings: bluraySettings },
          { title: 'DVD', pathSettings: dvdSettings },
          { title: 'CD / Audio', pathSettings: cdSettings },
          { title: 'Audiobook', pathSettings: audiobookSettings },
          { title: 'Converter', pathSettings: converterSettings },
          { title: 'Downloads', pathSettings: downloadSettings },
          ...(externalStorageSettings.length > 0 ? [{ title: 'Externe Speicher', pathSettings: externalStorageSettings }] : []),
          ...(logSettings.length > 0 ? [{ title: 'Logs', pathSettings: logSettings }] : [])
        ]
          .filter(({ pathSettings }) =>
            pathSettings.filter((s) => !String(s?.key || '').endsWith('_owner')).length > 0
          )
          .map(({ title, pathSettings }) => {
            const visibleSettings = pathSettings.filter(
              (s) => !String(s?.key || '').endsWith('_owner')
            );
            return (
              <AccordionTab key={title} header={title}>
                <div className="settings-grid">
                  {visibleSettings.map((setting) => {
                    const value = values?.[setting.key];
                    const error = errors?.[setting.key] || null;
                    const dirty = Boolean(dirtyKeys?.has?.(setting.key));
                    const ownerKey = `${setting.key}_owner`;
                    const ownerSetting = settingsByKey.get(ownerKey) || null;
                    const ownerValue = values?.[ownerKey];
                    const ownerError = errors?.[ownerKey] || null;
                    const ownerDirty = Boolean(dirtyKeys?.has?.(ownerKey));
                    return (
                      <SettingField
                        key={setting.key}
                        setting={setting}
                        value={value}
                        error={error}
                        dirty={dirty}
                        ownerSetting={ownerSetting}
                        ownerValue={ownerValue}
                        ownerError={ownerError}
                        ownerDirty={ownerDirty}
                        onChange={onChange}
                        onNotify={onNotify}
                        onSettingApplied={onSettingApplied}
                      />
                    );
                  })}
                </div>
              </AccordionTab>
            );
          })}
      </Accordion>
    </div>
  );
}

export default function DynamicSettingsForm({
  categories,
  values,
  errors,
  dirtyKeys,
  onChange,
  effectivePaths,
  activationBytes = [],
  onNotify,
  onSettingApplied
}) {
  const safeCategories = Array.isArray(categories) ? categories : [];
  const expertModeEnabled = toBoolean(values?.[EXPERT_MODE_SETTING_KEY]);
  const visibleCategories = safeCategories
    .filter((category) => !shouldHideCategoryByExpertMode(category?.category, expertModeEnabled))
    .map((category) => ({
      ...category,
      settings: filterSettingsByVisibility(category?.settings, expertModeEnabled)
    }))
    .filter((category) => Array.isArray(category?.settings) && category.settings.length > 0);
  const [activeIndex, setActiveIndex] = useState(0);
  const rootRef = useRef(null);

  useEffect(() => {
    if (visibleCategories.length === 0) {
      setActiveIndex(0);
      return;
    }
    if (activeIndex < 0 || activeIndex >= visibleCategories.length) {
      setActiveIndex(0);
    }
  }, [activeIndex, visibleCategories.length]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return undefined;
    }
    const syncToggleHeights = () => {
      const root = rootRef.current;
      if (!root) {
        return;
      }
      const grids = root.querySelectorAll('.notification-toggle-grid');
      for (const grid of grids) {
        const cards = Array.from(grid.querySelectorAll('.notification-toggle-box'));
        if (cards.length === 0) {
          continue;
        }
        for (const card of cards) {
          card.style.minHeight = '0px';
        }
        const maxHeight = cards.reduce((acc, card) => Math.max(acc, Number(card.offsetHeight || 0)), 0);
        if (maxHeight <= 0) {
          continue;
        }
        for (const card of cards) {
          card.style.minHeight = `${maxHeight}px`;
        }
      }
    };

    const frameId = window.requestAnimationFrame(syncToggleHeights);
    window.addEventListener('resize', syncToggleHeights);
    return () => {
      window.cancelAnimationFrame(frameId);
      window.removeEventListener('resize', syncToggleHeights);
    };
  }, [activeIndex, visibleCategories, values]);

  if (visibleCategories.length === 0) {
    return <p>Keine Kategorien vorhanden.</p>;
  }

  return (
    <div className="dynamic-settings-form" ref={rootRef}>
      <TabView
        className="settings-tabview"
        activeIndex={activeIndex}
        onTabChange={(event) => setActiveIndex(Number(event.index || 0))}
        scrollable
      >
        {visibleCategories.map((category, categoryIndex) => (
          <TabPanel
            key={`${category.category || 'category'}-${categoryIndex}`}
            header={category.category || `Kategorie ${categoryIndex + 1}`}
          >
            {normalizeText(category?.category) === 'pfade' ? (
              <PathCategoryTab
                settings={category?.settings || []}
                values={values}
                errors={errors}
                dirtyKeys={dirtyKeys}
                onChange={onChange}
                effectivePaths={effectivePaths}
                onNotify={onNotify}
                onSettingApplied={onSettingApplied}
              />
            ) : (() => {
              const sections = buildSectionsForCategory(category?.category, category?.settings || []);
              const grouped = sections.length > 1;
              const isNotificationCategory = normalizeText(category?.category) === 'benachrichtigungen';
              const pushoverEnabled = toBoolean(values?.[PUSHOVER_ENABLED_SETTING_KEY]);

              const isDriveCategory = normalizeText(category?.category) === 'laufwerk';
              const isToolsCategory = normalizeText(category?.category) === 'tools';
              return (
                <div className="settings-sections">
                  {isDriveCategory && <DetectedDrivesInfo expertModeEnabled={expertModeEnabled} onNotify={onNotify} />}
                  {sections.map((section) => (
                    <section
                      key={`${category?.category || 'category'}-${section.id}`}
                      className={`settings-section${grouped ? ' grouped' : ''}`}
                    >
                      {section.title ? (
                        <div className="settings-section-head">
                          <h4>{section.title}</h4>
                          {section.description ? <small>{section.description}</small> : null}
                        </div>
                      ) : null}
                      {(() => {
                        const ownerKeySet = new Set(
                          (section.settings || [])
                            .filter((s) => String(s.key || '').endsWith('_owner'))
                            .map((s) => s.key)
                        );
                        const settingsByKey = new Map(
                          (section.settings || []).map((s) => [s.key, s])
                        );
                        const baseSettings = (section.settings || []).filter(
                          (s) => !ownerKeySet.has(s.key)
                        );
                        const notificationToggleSettings = isNotificationCategory
                          ? baseSettings.filter((setting) => isNotificationEventToggleSetting(setting))
                          : [];
                        const notificationToggleKeys = new Set(
                          notificationToggleSettings.map((setting) => normalizeSettingKey(setting?.key))
                        );

                        // Abhängigkeitsbaum aufbauen: depends_on → Kinder
                        const dependentsByParent = new Map();
                        const rootSettings = [];
                        for (const setting of baseSettings) {
                          if (notificationToggleKeys.has(normalizeSettingKey(setting?.key))) continue;
                          const dep = setting?.depends_on;
                          if (dep) {
                            if (!dependentsByParent.has(dep)) dependentsByParent.set(dep, []);
                            dependentsByParent.get(dep).push(setting);
                          } else {
                            rootSettings.push(setting);
                          }
                        }

                        const renderSetting = (setting, variant = 'default', disabled = false, onChangeFn = onChange) => {
                          const value = values?.[setting.key];
                          const error = errors?.[setting.key] || null;
                          const dirty = Boolean(dirtyKeys?.has?.(setting.key));

                          const ownerKey = `${setting.key}_owner`;
                          const ownerSetting = settingsByKey.get(ownerKey) || null;
                          const ownerValue = values?.[ownerKey];
                          const ownerError = errors?.[ownerKey] || null;
                          const ownerDirty = Boolean(dirtyKeys?.has?.(ownerKey));

                          return (
                            <SettingField
                              key={setting.key}
                              setting={setting}
                              value={value}
                              error={error}
                              dirty={dirty}
                              ownerSetting={ownerSetting}
                              ownerValue={ownerValue}
                              ownerError={ownerError}
                              ownerDirty={ownerDirty}
                              onChange={onChangeFn}
                              variant={variant}
                              disabled={disabled}
                              onNotify={onNotify}
                              onSettingApplied={onSettingApplied}
                            />
                          );
                        };

                        // Alle Nachkommen eines Keys rekursiv auf false setzen
                        const cascadeOff = (key) => {
                          const children = dependentsByParent.get(key) || [];
                          for (const child of children) {
                            onChange?.(child.key, false);
                            cascadeOff(child.key);
                          }
                        };

                        // Rekursiv: Setting + seine Kinder rendern
                        // Wenn ein Parent auf false geht → alle Kinder werden auf false gesetzt
                        const renderWithChildren = (setting, depth = 0) => {
                          const children = dependentsByParent.get(setting.key) || [];
                          const readonly = depth > 0 && isReadonlySetting(setting);
                          const active = toBoolean(values?.[setting.key]);

                          const effectiveOnChange = children.length > 0
                            ? (key, value) => {
                                onChange?.(key, value);
                                if (!value) cascadeOff(key);
                              }
                            : onChange;

                          return (
                            <React.Fragment key={setting.key}>
                              {renderSetting(setting, 'default', readonly, effectiveOnChange)}
                              {children.length > 0 && active && !readonly ? (
                                <div className={`settings-grid settings-grid--depth-${depth + 1}`}>
                                  {children.map((child) => renderWithChildren(child, depth + 1))}
                                </div>
                              ) : null}
                            </React.Fragment>
                          );
                        };

                        return (
                          <>
                            {rootSettings.length > 0 ? (
                              <div className="settings-grid">
                                {rootSettings.map((setting) => renderWithChildren(setting, 0))}
                              </div>
                            ) : null}
                            {pushoverEnabled && notificationToggleSettings.length > 0 ? (
                              <div className="notification-toggle-grid">
                                {notificationToggleSettings.map((setting) => renderSetting(setting, 'notification-toggle'))}
                              </div>
                            ) : null}
                          </>
                        );
                      })()}
                    </section>
                  ))}
                  {isToolsCategory ? <ActivationBytesCacheBox entries={activationBytes} /> : null}
                </div>
              );
            })()}
          </TabPanel>
        ))}
      </TabView>
    </div>
  );
}
