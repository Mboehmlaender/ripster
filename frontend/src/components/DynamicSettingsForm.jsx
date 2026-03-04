import { useEffect, useState } from 'react';
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

function buildToolSections(settings) {
  const list = Array.isArray(settings) ? settings : [];
  const definitions = [
    {
      id: 'makemkv',
      title: 'MakeMKV',
      description: 'Disc-Analyse und Rip-Einstellungen.',
      match: (key) => key.startsWith('makemkv_')
    },
    {
      id: 'mediainfo',
      title: 'MediaInfo',
      description: 'Track-Analyse und zusätzliche mediainfo Parameter.',
      match: (key) => key.startsWith('mediainfo_')
    },
    {
      id: 'handbrake',
      title: 'HandBrake',
      description: 'Preset, Encoding-CLI und HandBrake-Optionen.',
      match: (key) => key.startsWith('handbrake_')
    },
    {
      id: 'output',
      title: 'Output',
      description: 'Container-Format sowie Datei- und Ordnernamen-Template.',
      match: (key) => key === 'output_extension' || key === 'filename_template' || key === 'output_folder_template'
    }
  ];

  const buckets = definitions.map((item) => ({
    ...item,
    settings: []
  }));
  const fallbackBucket = {
    id: 'other',
    title: 'Weitere Tool-Settings',
    description: null,
    settings: []
  };

  for (const setting of list) {
    const key = normalizeSettingKey(setting?.key);
    let assigned = false;
    for (const bucket of buckets) {
      if (bucket.match(key)) {
        bucket.settings.push(setting);
        assigned = true;
        break;
      }
    }
    if (!assigned) {
      fallbackBucket.settings.push(setting);
    }
  }

  const sections = buckets.filter((item) => item.settings.length > 0);
  if (fallbackBucket.settings.length > 0) {
    sections.push(fallbackBucket);
  }
  return sections;
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
  return String(setting?.key || '').trim().toLowerCase() === 'handbrake_preset';
}

export default function DynamicSettingsForm({
  categories,
  values,
  errors,
  dirtyKeys,
  onChange
}) {
  const safeCategories = Array.isArray(categories) ? categories : [];
  const [activeIndex, setActiveIndex] = useState(0);

  useEffect(() => {
    if (safeCategories.length === 0) {
      setActiveIndex(0);
      return;
    }
    if (activeIndex < 0 || activeIndex >= safeCategories.length) {
      setActiveIndex(0);
    }
  }, [activeIndex, safeCategories.length]);

  if (safeCategories.length === 0) {
    return <p>Keine Kategorien vorhanden.</p>;
  }

  return (
    <TabView
      className="settings-tabview"
      activeIndex={activeIndex}
      onTabChange={(event) => setActiveIndex(Number(event.index || 0))}
      scrollable
    >
      {safeCategories.map((category, categoryIndex) => (
        <TabPanel
          key={`${category.category || 'category'}-${categoryIndex}`}
          header={category.category || `Kategorie ${categoryIndex + 1}`}
        >
          {(() => {
            const sections = buildSectionsForCategory(category?.category, category?.settings || []);
            const grouped = sections.length > 1;

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
                    <div className="settings-grid">
                      {(section.settings || []).map((setting) => {
                        const value = values?.[setting.key];
                        const error = errors?.[setting.key] || null;
                        const dirty = Boolean(dirtyKeys?.has?.(setting.key));

                        return (
                          <div key={setting.key} className="setting-row">
                            <label htmlFor={setting.key}>
                              {setting.label}
                              {setting.required && <span className="required">*</span>}
                            </label>

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

                            {setting.type === 'boolean' ? (
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

                            <small>{setting.description || ''}</small>
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
                          </div>
                        );
                      })}
                    </div>
                  </section>
                ))}
              </div>
            );
          })()}
        </TabPanel>
      ))}
    </TabView>
  );
}
