import { useEffect, useRef, useState } from 'react';
import { TabView, TabPanel } from 'primereact/tabview';
import { InputText } from 'primereact/inputtext';
import { InputNumber } from 'primereact/inputnumber';
import { InputSwitch } from 'primereact/inputswitch';
import { Dropdown } from 'primereact/dropdown';
import { Tag } from 'primereact/tag';

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
  'mediainfo_command',
  'handbrake_command',
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
const ALWAYS_HIDDEN_SETTING_KEYS = new Set([
  'drive_device',
  'makemkv_rip_mode',
  'makemkv_rip_mode_bluray',
  'makemkv_rip_mode_dvd',
  'makemkv_backup_mode'
]);
const EXPERT_ONLY_SETTING_KEYS = new Set([
  'pushover_device',
  'pushover_priority',
  'pushover_timeout_ms',
  'makemkv_source_index',
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
  'cdparanoia_command'
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
    fallbackBucket.settings.push(setting);
  }

  const sections = [
    generalBucket,
    blurayBucket,
    dvdBucket
  ].filter((item) => item.settings.length > 0);
  if (fallbackBucket.settings.length > 0) {
    sections.push(fallbackBucket);
  }
  return sections;
}

// Path keys per medium — _owner keys are rendered inline
const BLURAY_PATH_KEYS = ['raw_dir_bluray', 'movie_dir_bluray', 'output_template_bluray'];
const DVD_PATH_KEYS = ['raw_dir_dvd', 'movie_dir_dvd', 'output_template_dvd'];
const CD_PATH_KEYS = ['raw_dir_cd', 'movie_dir_cd', 'cd_output_template'];
const LOG_PATH_KEYS = ['log_dir'];

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
  variant = 'default'
}) {
  const ownerKey = ownerSetting?.key;
  const pathHasValue = Boolean(String(value ?? '').trim());
  const isNotificationToggleBox = variant === 'notification-toggle' && setting?.type === 'boolean';

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
            onChange={(event) => onChange?.(setting.key, event.value)}
          />
        </div>
      ) : (
        <label htmlFor={setting.key}>
          {setting.label}
          {setting.required && <span className="required">*</span>}
        </label>
      )}

      {setting.type === 'string' || setting.type === 'path' ? (
        <InputText
          id={setting.key}
          value={value ?? ''}
          onChange={(event) => onChange?.(setting.key, event.target.value)}
        />
      ) : null}

      {setting.type === 'number' ? (
        <InputNumber
          id={setting.key}
          value={value ?? 0}
          onValueChange={(event) => onChange?.(setting.key, event.value)}
          mode="decimal"
          useGrouping={false}
        />
      ) : null}

      {setting.type === 'boolean' && !isNotificationToggleBox ? (
        <InputSwitch
          id={setting.key}
          checked={Boolean(value)}
          onChange={(event) => onChange?.(setting.key, event.value)}
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
          onChange={(event) => onChange?.(setting.key, event.value)}
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
            disabled={!pathHasValue}
            onChange={(event) => onChange?.(ownerKey, event.target.value)}
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

function PathMediumCard({ title, pathSettings, settingsByKey, values, errors, dirtyKeys, onChange }) {
  // Filter out _owner keys since they're rendered inline
  const visibleSettings = pathSettings.filter(
    (s) => !String(s?.key || '').endsWith('_owner')
  );

  if (visibleSettings.length === 0) {
    return null;
  }

  return (
    <div className="path-medium-card">
      <div className="path-medium-card-header">
        <h4>{title}</h4>
      </div>
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
            />
          );
        })}
      </div>
    </div>
  );
}

function PathCategoryTab({ settings, values, errors, dirtyKeys, onChange, effectivePaths }) {
  const list = Array.isArray(settings) ? settings : [];
  const settingsByKey = new Map(list.map((s) => [s.key, s]));

  const bluraySettings = list.filter((s) => BLURAY_PATH_KEYS.includes(s.key) || (s.key.endsWith('_owner') && BLURAY_PATH_KEYS.includes(s.key.replace('_owner', ''))));
  const dvdSettings = list.filter((s) => DVD_PATH_KEYS.includes(s.key) || (s.key.endsWith('_owner') && DVD_PATH_KEYS.includes(s.key.replace('_owner', ''))));
  const cdSettings = list.filter((s) => CD_PATH_KEYS.includes(s.key) || (s.key.endsWith('_owner') && CD_PATH_KEYS.includes(s.key.replace('_owner', ''))));
  const logSettings = list.filter((s) => LOG_PATH_KEYS.includes(s.key));

  const defaultRaw = effectivePaths?.defaults?.raw || 'data/output/raw';
  const defaultMovies = effectivePaths?.defaults?.movies || 'data/output/movies';
  const defaultCd = effectivePaths?.defaults?.cd || 'data/output/cd';

  const ep = effectivePaths || {};
  const blurayRaw = ep.bluray?.raw || defaultRaw;
  const blurayMovies = ep.bluray?.movies || defaultMovies;
  const dvdRaw = ep.dvd?.raw || defaultRaw;
  const dvdMovies = ep.dvd?.movies || defaultMovies;
  const cdRaw = ep.cd?.raw || defaultCd;
  const cdMovies = ep.cd?.movies || cdRaw;

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
              <th>RAW-Ordner</th>
              <th>Film-Ordner</th>
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
          </tbody>
        </table>
      </div>

      {/* Medium-Karten */}
      <div className="path-medium-cards">
        <PathMediumCard
          title="Blu-ray"
          pathSettings={bluraySettings}
          settingsByKey={settingsByKey}
          values={values}
          errors={errors}
          dirtyKeys={dirtyKeys}
          onChange={onChange}
        />
        <PathMediumCard
          title="DVD"
          pathSettings={dvdSettings}
          settingsByKey={settingsByKey}
          values={values}
          errors={errors}
          dirtyKeys={dirtyKeys}
          onChange={onChange}
        />
        <PathMediumCard
          title="CD / Audio"
          pathSettings={cdSettings}
          settingsByKey={settingsByKey}
          values={values}
          errors={errors}
          dirtyKeys={dirtyKeys}
          onChange={onChange}
        />
      </div>

      {/* Log-Ordner */}
      {logSettings.length > 0 && (
        <div className="path-medium-card">
          <div className="path-medium-card-header">
            <h4>Logs</h4>
          </div>
          <div className="settings-grid">
            {logSettings.map((setting) => {
              const value = values?.[setting.key];
              const error = errors?.[setting.key] || null;
              const dirty = Boolean(dirtyKeys?.has?.(setting.key));
              return (
                <SettingField
                  key={setting.key}
                  setting={setting}
                  value={value}
                  error={error}
                  dirty={dirty}
                  ownerSetting={null}
                  ownerValue={null}
                  ownerError={null}
                  ownerDirty={false}
                  onChange={onChange}
                />
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

export default function DynamicSettingsForm({
  categories,
  values,
  errors,
  dirtyKeys,
  onChange,
  effectivePaths
}) {
  const safeCategories = Array.isArray(categories) ? categories : [];
  const expertModeEnabled = toBoolean(values?.[EXPERT_MODE_SETTING_KEY]);
  const visibleCategories = safeCategories
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
              />
            ) : (() => {
              const sections = buildSectionsForCategory(category?.category, category?.settings || []);
              const grouped = sections.length > 1;
              const isNotificationCategory = normalizeText(category?.category) === 'benachrichtigungen';
              const pushoverEnabled = toBoolean(values?.[PUSHOVER_ENABLED_SETTING_KEY]);

              return (
                <div className="settings-sections">
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
                        const regularSettings = baseSettings.filter(
                          (setting) => !notificationToggleKeys.has(normalizeSettingKey(setting?.key))
                        );
                        const renderSetting = (setting, variant = 'default') => {
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
                              variant={variant}
                            />
                          );
                        };

                        return (
                          <>
                            {regularSettings.length > 0 ? (
                              <div className="settings-grid">
                                {regularSettings.map((setting) => renderSetting(setting))}
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
                </div>
              );
            })()}
          </TabPanel>
        ))}
      </TabView>
    </div>
  );
}
