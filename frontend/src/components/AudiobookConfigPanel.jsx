import { useEffect, useMemo, useState } from 'react';
import { Dialog } from 'primereact/dialog';
import { Dropdown } from 'primereact/dropdown';
import { Slider } from 'primereact/slider';
import { Button } from 'primereact/button';
import { Tag } from 'primereact/tag';
import { InputText } from 'primereact/inputtext';
import { AUDIOBOOK_FORMATS, AUDIOBOOK_FORMAT_SCHEMAS, getDefaultAudiobookFormatOptions } from '../config/audiobookFormatSchemas';
import { api } from '../api/client';
import { getStatusLabel, getStatusSeverity } from '../utils/statusPresentation';

function normalizeJobId(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return Math.trunc(parsed);
}

function normalizeFormat(value) {
  const raw = String(value || '').trim().toLowerCase();
  return AUDIOBOOK_FORMATS.some((entry) => entry.value === raw) ? raw : 'mp3';
}

function isFieldVisible(field, values) {
  if (!field?.showWhen) {
    return true;
  }
  return values?.[field.showWhen.field] === field.showWhen.value;
}

function buildFormatOptions(format, existingOptions = {}) {
  return {
    ...getDefaultAudiobookFormatOptions(format),
    ...(existingOptions && typeof existingOptions === 'object' ? existingOptions : {})
  };
}

function formatChapterTime(secondsValue) {
  const totalSeconds = Number(secondsValue || 0);
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) {
    return '-';
  }
  const rounded = Math.max(0, Math.round(totalSeconds));
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);
  const seconds = rounded % 60;
  if (hours > 0) {
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function stripHtml(value) {
  return String(value || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function truncateDescription(value, maxLength = 220) {
  const normalized = stripHtml(value);
  if (!normalized || normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength).trim()}...`;
}

function normalizeChapterTitle(value, index) {
  const normalized = String(value || '').replace(/\s+/g, ' ').trim();
  return normalized || `Kapitel ${index}`;
}

function normalizeEditableChapters(chapters = []) {
  const source = Array.isArray(chapters) ? chapters : [];
  return source.map((chapter, index) => {
    const safeIndex = Number(chapter?.index);
    const resolvedIndex = Number.isFinite(safeIndex) && safeIndex > 0 ? Math.trunc(safeIndex) : index + 1;
    return {
      index: resolvedIndex,
      title: normalizeChapterTitle(chapter?.title, resolvedIndex),
      startSeconds: Number(chapter?.startSeconds || 0),
      endSeconds: Number(chapter?.endSeconds || 0),
      startMs: Number(chapter?.startMs || 0),
      endMs: Number(chapter?.endMs || 0)
    };
  });
}

function formatChapterDuration(startSecondsValue, endSecondsValue) {
  const startSeconds = Number(startSecondsValue || 0);
  const endSeconds = Number(endSecondsValue || 0);
  if (!Number.isFinite(startSeconds) || !Number.isFinite(endSeconds) || endSeconds <= startSeconds) {
    return '-';
  }
  return formatChapterTime(endSeconds - startSeconds);
}

function normalizeTrackStageStatus(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (raw === 'done' || raw === 'complete' || raw === 'completed' || raw === 'ok' || raw === 'success') {
    return 'done';
  }
  if (raw === 'in_progress' || raw === 'running' || raw === 'active' || raw === 'processing') {
    return 'in_progress';
  }
  if (raw === 'error' || raw === 'failed' || raw === 'cancelled' || raw === 'aborted') {
    return 'error';
  }
  return 'pending';
}

function trackStatusTagMeta(value) {
  const normalized = normalizeTrackStageStatus(value);
  if (normalized === 'done') {
    return { label: 'Fertig', severity: 'success' };
  }
  if (normalized === 'in_progress') {
    return { label: 'Läuft', severity: 'info' };
  }
  if (normalized === 'error') {
    return { label: 'Fehler', severity: 'danger' };
  }
  return { label: 'Offen', severity: 'secondary' };
}

function normalizeScriptId(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return Math.trunc(parsed);
}

function normalizeChainId(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return Math.trunc(parsed);
}

function normalizeIdList(values, kind = 'script') {
  const list = Array.isArray(values) ? values : [];
  const seen = new Set();
  const output = [];
  for (const value of list) {
    const normalized = kind === 'chain' ? normalizeChainId(value) : normalizeScriptId(value);
    if (normalized === null) {
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

function buildEncodeItemsFromConfig(config, phase) {
  const source = config && typeof config === 'object' ? config : {};
  const prefix = phase === 'post' ? 'post' : 'pre';
  const explicitItems = Array.isArray(source[`${prefix}EncodeItems`]) ? source[`${prefix}EncodeItems`] : [];
  const fromExplicit = explicitItems
    .map((item) => {
      const type = String(item?.type || '').trim().toLowerCase();
      if (type !== 'script' && type !== 'chain') {
        return null;
      }
      const id = type === 'chain'
        ? normalizeChainId(item?.id ?? item?.chainId)
        : normalizeScriptId(item?.id ?? item?.scriptId);
      if (!id) {
        return null;
      }
      return { type, id };
    })
    .filter(Boolean);
  if (fromExplicit.length > 0) {
    return fromExplicit;
  }
  const scriptIds = normalizeIdList(source[`${prefix}EncodeScriptIds`], 'script');
  const chainIds = normalizeIdList(source[`${prefix}EncodeChainIds`], 'chain');
  return [
    ...scriptIds.map((id) => ({ type: 'script', id })),
    ...chainIds.map((id) => ({ type: 'chain', id }))
  ];
}

function FormatField({ field, value, onChange, disabled }) {
  if (field.type === 'slider') {
    return (
      <div className="cd-format-field">
        <label>
          {field.label}: <strong>{value}</strong>
        </label>
        {field.description ? <small>{field.description}</small> : null}
        <Slider
          value={value}
          onChange={(event) => onChange(field.key, event.value)}
          min={field.min}
          max={field.max}
          step={field.step || 1}
          disabled={disabled}
        />
      </div>
    );
  }

  if (field.type === 'select') {
    return (
      <div className="cd-format-field">
        <label>{field.label}</label>
        {field.description ? <small>{field.description}</small> : null}
        <Dropdown
          value={value}
          options={field.options}
          optionLabel="label"
          optionValue="value"
          onChange={(event) => onChange(field.key, event.value)}
          disabled={disabled}
        />
      </div>
    );
  }

  return null;
}

export default function AudiobookConfigPanel({
  pipeline,
  onStart,
  onCancel,
  onDeleteJob,
  busy
}) {
  const context = pipeline?.context && typeof pipeline.context === 'object' ? pipeline.context : {};
  const state = String(pipeline?.state || 'IDLE').trim().toUpperCase() || 'IDLE';
  const jobId = normalizeJobId(context?.jobId);
  const metadata = context?.selectedMetadata && typeof context.selectedMetadata === 'object'
    ? context.selectedMetadata
    : {};
  const audiobookConfig = context?.audiobookConfig && typeof context.audiobookConfig === 'object'
    ? context.audiobookConfig
    : (context?.mediaInfoReview && typeof context.mediaInfoReview === 'object' ? context.mediaInfoReview : {});
  const initialFormat = normalizeFormat(audiobookConfig?.format);
  const chapters = Array.isArray(metadata?.chapters)
    ? metadata.chapters
    : (Array.isArray(context?.chapters) ? context.chapters : []);
  const [format, setFormat] = useState(initialFormat);
  const [formatOptions, setFormatOptions] = useState(() => buildFormatOptions(initialFormat, audiobookConfig?.formatOptions));
  const [editableChapters, setEditableChapters] = useState(() => normalizeEditableChapters(chapters));
  const [descriptionDialogVisible, setDescriptionDialogVisible] = useState(false);
  const [scriptCatalog, setScriptCatalog] = useState([]);
  const [chainCatalog, setChainCatalog] = useState([]);
  const [preRipItems, setPreRipItems] = useState([]);
  const [postRipItems, setPostRipItems] = useState([]);
  const audiobookConfigKey = JSON.stringify({
    preEncodeScriptIds: normalizeIdList(audiobookConfig?.preEncodeScriptIds, 'script'),
    postEncodeScriptIds: normalizeIdList(audiobookConfig?.postEncodeScriptIds, 'script'),
    preEncodeChainIds: normalizeIdList(audiobookConfig?.preEncodeChainIds, 'chain'),
    postEncodeChainIds: normalizeIdList(audiobookConfig?.postEncodeChainIds, 'chain'),
    preEncodeItems: Array.isArray(audiobookConfig?.preEncodeItems) ? audiobookConfig.preEncodeItems : [],
    postEncodeItems: Array.isArray(audiobookConfig?.postEncodeItems) ? audiobookConfig.postEncodeItems : []
  });

  useEffect(() => {
    const nextFormat = normalizeFormat(audiobookConfig?.format);
    setFormat(nextFormat);
    setFormatOptions(buildFormatOptions(nextFormat, audiobookConfig?.formatOptions));
  }, [jobId, audiobookConfig?.format, JSON.stringify(audiobookConfig?.formatOptions || {})]);

  useEffect(() => {
    setEditableChapters(normalizeEditableChapters(chapters));
  }, [jobId, JSON.stringify(chapters || [])]);

  useEffect(() => {
    let cancelled = false;
    const loadCatalog = async () => {
      try {
        const [scriptsResponse, chainsResponse] = await Promise.allSettled([api.getScripts(), api.getScriptChains()]);
        if (cancelled) {
          return;
        }
        const scripts = scriptsResponse.status === 'fulfilled'
          ? (Array.isArray(scriptsResponse.value?.scripts) ? scriptsResponse.value.scripts : [])
          : [];
        const chains = chainsResponse.status === 'fulfilled'
          ? (Array.isArray(chainsResponse.value?.chains) ? chainsResponse.value.chains : [])
          : [];
        setScriptCatalog(scripts.map((item) => ({ id: item?.id, name: item?.name })));
        setChainCatalog(chains.map((item) => ({ id: item?.id, name: item?.name })));
      } catch (_error) {
        if (!cancelled) {
          setScriptCatalog([]);
          setChainCatalog([]);
        }
      }
    };
    void loadCatalog();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    setPreRipItems(buildEncodeItemsFromConfig(audiobookConfig, 'pre'));
    setPostRipItems(buildEncodeItemsFromConfig(audiobookConfig, 'post'));
  }, [jobId, audiobookConfigKey]);

  const schema = AUDIOBOOK_FORMAT_SCHEMAS[format] || AUDIOBOOK_FORMAT_SCHEMAS.mp3;
  const canStart = Boolean(jobId) && (
    state === 'READY_TO_START'
    || state === 'READY_TO_ENCODE'
    || state === 'ERROR'
    || state === 'CANCELLED'
  );
  const isRunning = state === 'ENCODING';
  const isFinished = state === 'FINISHED';
  const isSplitOutput = format === 'mp3' || format === 'flac';
  const showEditableChapters = !(isSplitOutput && isRunning);
  const currentChapter = context?.currentChapter && typeof context.currentChapter === 'object' ? context.currentChapter : null;
  const completedChapterCount = Number(context?.completedChapterCount ?? -1);
  const chapterTotal = Number(currentChapter?.total || editableChapters.length || 0);
  const statusLabel = getStatusLabel(state);
  const statusSeverity = getStatusSeverity(state);
  const description = String(metadata?.description || '').trim();
  const descriptionStripped = stripHtml(description);
  const descriptionPreview = truncateDescription(description);
  const posterUrl = String(metadata?.poster || '').trim() || null;

  const visibleFields = useMemo(
    () => (Array.isArray(schema?.fields) ? schema.fields.filter((field) => isFieldVisible(field, formatOptions)) : []),
    [schema, formatOptions]
  );

  const moveEncodeItem = (phase, index, direction) => {
    const updater = phase === 'post' ? setPostRipItems : setPreRipItems;
    updater((prev) => {
      const list = Array.isArray(prev) ? [...prev] : [];
      const from = Number(index);
      const to = from + (direction === 'up' ? -1 : 1);
      if (!Number.isInteger(from) || from < 0 || from >= list.length || to < 0 || to >= list.length) {
        return list;
      }
      const [moved] = list.splice(from, 1);
      list.splice(to, 0, moved);
      return list;
    });
  };

  const addEncodeItem = (phase, type) => {
    const normalizedType = type === 'chain' ? 'chain' : 'script';
    const updater = phase === 'post' ? setPostRipItems : setPreRipItems;
    updater((prev) => {
      const current = Array.isArray(prev) ? prev : [];
      const selectedIds = new Set(
        current
          .filter((item) => item?.type === normalizedType)
          .map((item) => normalizedType === 'chain' ? normalizeChainId(item?.id) : normalizeScriptId(item?.id))
          .filter((id) => id !== null)
          .map((id) => String(id))
      );
      const catalog = normalizedType === 'chain' ? chainCatalog : scriptCatalog;
      const candidate = (Array.isArray(catalog) ? catalog : [])
        .map((item) => normalizedType === 'chain' ? normalizeChainId(item?.id) : normalizeScriptId(item?.id))
        .find((id) => id !== null && !selectedIds.has(String(id)));
      if (candidate === undefined || candidate === null) {
        return current;
      }
      return [...current, { type: normalizedType, id: candidate }];
    });
  };

  const changeEncodeItem = (phase, index, type, nextId) => {
    const normalizedType = type === 'chain' ? 'chain' : 'script';
    const normalizedId = normalizedType === 'chain' ? normalizeChainId(nextId) : normalizeScriptId(nextId);
    if (normalizedId === null) {
      return;
    }
    const updater = phase === 'post' ? setPostRipItems : setPreRipItems;
    updater((prev) => {
      const current = Array.isArray(prev) ? prev : [];
      const rowIndex = Number(index);
      if (!Number.isInteger(rowIndex) || rowIndex < 0 || rowIndex >= current.length) {
        return current;
      }
      const duplicate = current.some((item, itemIndex) => {
        if (itemIndex === rowIndex) {
          return false;
        }
        if (item?.type !== normalizedType) {
          return false;
        }
        const existingId = normalizedType === 'chain' ? normalizeChainId(item?.id) : normalizeScriptId(item?.id);
        return existingId !== null && String(existingId) === String(normalizedId);
      });
      if (duplicate) {
        return current;
      }
      const next = [...current];
      next[rowIndex] = { type: normalizedType, id: normalizedId };
      return next;
    });
  };

  const removeEncodeItem = (phase, index) => {
    const updater = phase === 'post' ? setPostRipItems : setPreRipItems;
    updater((prev) => {
      const current = Array.isArray(prev) ? prev : [];
      const rowIndex = Number(index);
      if (!Number.isInteger(rowIndex) || rowIndex < 0 || rowIndex >= current.length) {
        return current;
      }
      return current.filter((_, itemIndex) => itemIndex !== rowIndex);
    });
  };

  return (
    <div className="audiobook-config-panel">
      <div className="audiobook-config-head">
        <div className="audiobook-config-summary">
          {posterUrl ? (
            <div className="audiobook-config-cover">
              <img src={posterUrl} alt={metadata?.title || 'Audiobook Cover'} />
            </div>
          ) : null}

          <div className="device-meta">
            <div><strong>Titel:</strong> {metadata?.title || '-'}</div>
            <div><strong>Autor:</strong> {metadata?.author || '-'}</div>
            <div><strong>Sprecher:</strong> {metadata?.narrator || '-'}</div>
            <div><strong>Jahr:</strong> {metadata?.year || '-'}</div>
            <div><strong>Kapitel:</strong> {editableChapters.length || '-'}</div>
            {descriptionPreview ? (
              <div className="audiobook-description-preview">
                <strong>Beschreibung:</strong>
                <span>{descriptionPreview}</span>
                {descriptionStripped.length > descriptionPreview.length ? (
                  <Button
                    type="button"
                    label="Vollständig anzeigen"
                    icon="pi pi-external-link"
                    text
                    size="small"
                    onClick={() => setDescriptionDialogVisible(true)}
                  />
                ) : null}
              </div>
            ) : null}
          </div>
        </div>

        <div className="ripper-job-badges">
          <Tag value={statusLabel} severity={statusSeverity} />
        </div>
      </div>

      <div className="audiobook-config-grid">
        <div className="audiobook-config-settings">
          <div className="cd-format-field">
            <label>Ausgabeformat</label>
            <Dropdown
              value={format}
              options={AUDIOBOOK_FORMATS}
              optionLabel="label"
              optionValue="value"
              onChange={(event) => {
                const nextFormat = normalizeFormat(event.value);
                setFormat(nextFormat);
                setFormatOptions(buildFormatOptions(nextFormat, {}));
              }}
              disabled={busy || isRunning}
            />
          </div>

          {visibleFields.map((field) => (
            <FormatField
              key={`${format}-${field.key}`}
              field={field}
              value={formatOptions?.[field.key] ?? field.default ?? null}
              onChange={(key, nextValue) => {
                setFormatOptions((prev) => ({
                  ...prev,
                  [key]: nextValue
                }));
              }}
              disabled={busy || isRunning}
            />
          ))}

          <small>
            <code>m4b</code> erzeugt eine Datei mit bearbeitbaren Kapiteln. <code>mp3</code> und <code>flac</code> werden kapitelweise als einzelne Dateien erzeugt.
          </small>
        </div>

        {showEditableChapters ? (
          <div className="audiobook-config-chapters">
            <h4>Kapitel</h4>
            {editableChapters.length === 0 ? (
              <small>Keine Kapitel in der Quelle erkannt.</small>
            ) : (
              <div className="audiobook-chapter-list">
                {editableChapters.map((chapter, index) => (
                  <div key={`${chapter.index}-${index}`} className="audiobook-chapter-row audiobook-chapter-row-editable">
                    <div className="audiobook-chapter-row-head">
                      <strong>#{chapter.index || index + 1}</strong>
                      <small>
                        {formatChapterTime(chapter.startSeconds)} - {formatChapterTime(chapter.endSeconds)}
                      </small>
                    </div>
                    <InputText
                      value={chapter.title}
                      onChange={(event) => {
                        const nextTitle = event.target.value;
                        setEditableChapters((prev) => prev.map((entry, entryIndex) => (
                          entryIndex === index
                            ? { ...entry, title: nextTitle }
                            : entry
                        )));
                      }}
                      disabled={busy || isRunning}
                    />
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : null}
      </div>

      {isSplitOutput && (isRunning || isFinished) && editableChapters.length > 0 ? (
        <div className="audiobook-chapter-status">
          <strong>Kapitel-Status ({completedChapterCount >= 0 ? completedChapterCount : (isFinished ? editableChapters.length : 0)}/{chapterTotal || editableChapters.length} fertig)</strong>
          <div className="cd-track-selection">
            <div className="cd-track-list">
              <table className="cd-track-table">
                <thead>
                  <tr>
                    <th className="check">Auswahl</th>
                    <th className="num">Nr</th>
                    <th className="title">Titel</th>
                    <th className="duration">Länge</th>
                    <th className="status">Rip</th>
                    <th className="status">Encode</th>
                  </tr>
                </thead>
                <tbody>
                  {editableChapters.map((chapter, idx) => {
                    const chIdx = chapter.index || idx + 1;
                    const isDone = isFinished || (completedChapterCount >= 0 && chIdx <= completedChapterCount);
                    const isActive = !isDone && currentChapter?.index === chIdx;
                    const ripMeta = trackStatusTagMeta('done');
                    const encodeMeta = trackStatusTagMeta(isDone ? 'done' : (isActive ? 'in_progress' : 'pending'));
                    return (
                      <tr key={chIdx} className="selected">
                        <td className="check">Ja</td>
                        <td className="num">{String(chIdx).padStart(2, '0')}</td>
                        <td className="title">{chapter.title || '-'}</td>
                        <td className="duration">{formatChapterDuration(chapter.startSeconds, chapter.endSeconds)}</td>
                        <td className="status"><Tag value={ripMeta.label} severity={ripMeta.severity} /></td>
                        <td className="status"><Tag value={encodeMeta.label} severity={encodeMeta.severity} /></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      ) : null}

      <div className="encode-automation-grid">
        <div className="post-script-box">
          <h4>Pre-Rip Ausführungen (optional)</h4>
          {scriptCatalog.length === 0 && chainCatalog.length === 0 ? (
            <small>Keine Skripte oder Ketten konfiguriert. In den Settings anlegen.</small>
          ) : null}
          {preRipItems.length === 0 ? (
            <small>Keine Pre-Rip Ausführungen ausgewählt.</small>
          ) : null}
          {preRipItems.map((item, rowIndex) => {
            const isScript = item?.type === 'script';
            const usedScriptIds = new Set(
              preRipItems
                .filter((entry, index) => entry?.type === 'script' && index !== rowIndex)
                .map((entry) => normalizeScriptId(entry?.id))
                .filter((id) => id !== null)
                .map((id) => String(id))
            );
            const usedChainIds = new Set(
              preRipItems
                .filter((entry, index) => entry?.type === 'chain' && index !== rowIndex)
                .map((entry) => normalizeChainId(entry?.id))
                .filter((id) => id !== null)
                .map((id) => String(id))
            );
            const scriptOptions = scriptCatalog.map((entry) => ({
              label: entry?.name || `Skript #${entry?.id}`,
              value: normalizeScriptId(entry?.id),
              disabled: usedScriptIds.has(String(normalizeScriptId(entry?.id)))
            })).filter((entry) => entry.value !== null);
            const chainOptions = chainCatalog.map((entry) => ({
              label: entry?.name || `Kette #${entry?.id}`,
              value: normalizeChainId(entry?.id),
              disabled: usedChainIds.has(String(normalizeChainId(entry?.id)))
            })).filter((entry) => entry.value !== null);
            return (
              <div key={`ab-pre-${rowIndex}-${item?.type}-${item?.id}`} className="post-script-row editable">
                <i className={`post-script-type-icon pi ${isScript ? 'pi-code' : 'pi-link'}`} title={isScript ? 'Skript' : 'Kette'} />
                <div className="cd-encode-item-order">
                  <Button
                    icon="pi pi-angle-up"
                    severity="secondary"
                    text
                    rounded
                    onClick={() => moveEncodeItem('pre', rowIndex, 'up')}
                    disabled={busy || rowIndex <= 0}
                  />
                  <Button
                    icon="pi pi-angle-down"
                    severity="secondary"
                    text
                    rounded
                    onClick={() => moveEncodeItem('pre', rowIndex, 'down')}
                    disabled={busy || rowIndex >= preRipItems.length - 1}
                  />
                </div>
                {isScript ? (
                  <Dropdown
                    value={normalizeScriptId(item?.id)}
                    options={scriptOptions}
                    optionLabel="label"
                    optionValue="value"
                    optionDisabled="disabled"
                    onChange={(event) => changeEncodeItem('pre', rowIndex, 'script', event.value)}
                    className="full-width"
                    disabled={busy}
                  />
                ) : (
                  <Dropdown
                    value={normalizeChainId(item?.id)}
                    options={chainOptions}
                    optionLabel="label"
                    optionValue="value"
                    optionDisabled="disabled"
                    onChange={(event) => changeEncodeItem('pre', rowIndex, 'chain', event.value)}
                    className="full-width"
                    disabled={busy}
                  />
                )}
                <Button
                  icon="pi pi-times"
                  severity="danger"
                  outlined
                  onClick={() => removeEncodeItem('pre', rowIndex)}
                  disabled={busy}
                />
              </div>
            );
          })}
          <div className="actions-row">
            {scriptCatalog.length > preRipItems.filter((entry) => entry?.type === 'script').length ? (
              <Button
                label="Skript hinzufügen"
                icon="pi pi-code"
                severity="secondary"
                outlined
                onClick={() => addEncodeItem('pre', 'script')}
                disabled={busy}
              />
            ) : null}
            {chainCatalog.length > preRipItems.filter((entry) => entry?.type === 'chain').length ? (
              <Button
                label="Kette hinzufügen"
                icon="pi pi-link"
                severity="secondary"
                outlined
                onClick={() => addEncodeItem('pre', 'chain')}
                disabled={busy}
              />
            ) : null}
          </div>
          <small>Ausführung vor dem Rippen, strikt nacheinander. Bei Fehler wird der Encode abgebrochen.</small>
        </div>

        <div className="post-script-box">
          <h4>Post-Rip Ausführungen (optional)</h4>
          {scriptCatalog.length === 0 && chainCatalog.length === 0 ? (
            <small>Keine Skripte oder Ketten konfiguriert. In den Settings anlegen.</small>
          ) : null}
          {postRipItems.length === 0 ? (
            <small>Keine Post-Rip Ausführungen ausgewählt.</small>
          ) : null}
          {postRipItems.map((item, rowIndex) => {
            const isScript = item?.type === 'script';
            const usedScriptIds = new Set(
              postRipItems
                .filter((entry, index) => entry?.type === 'script' && index !== rowIndex)
                .map((entry) => normalizeScriptId(entry?.id))
                .filter((id) => id !== null)
                .map((id) => String(id))
            );
            const usedChainIds = new Set(
              postRipItems
                .filter((entry, index) => entry?.type === 'chain' && index !== rowIndex)
                .map((entry) => normalizeChainId(entry?.id))
                .filter((id) => id !== null)
                .map((id) => String(id))
            );
            const scriptOptions = scriptCatalog.map((entry) => ({
              label: entry?.name || `Skript #${entry?.id}`,
              value: normalizeScriptId(entry?.id),
              disabled: usedScriptIds.has(String(normalizeScriptId(entry?.id)))
            })).filter((entry) => entry.value !== null);
            const chainOptions = chainCatalog.map((entry) => ({
              label: entry?.name || `Kette #${entry?.id}`,
              value: normalizeChainId(entry?.id),
              disabled: usedChainIds.has(String(normalizeChainId(entry?.id)))
            })).filter((entry) => entry.value !== null);
            return (
              <div key={`ab-post-${rowIndex}-${item?.type}-${item?.id}`} className="post-script-row editable">
                <i className={`post-script-type-icon pi ${isScript ? 'pi-code' : 'pi-link'}`} title={isScript ? 'Skript' : 'Kette'} />
                <div className="cd-encode-item-order">
                  <Button
                    icon="pi pi-angle-up"
                    severity="secondary"
                    text
                    rounded
                    onClick={() => moveEncodeItem('post', rowIndex, 'up')}
                    disabled={busy || rowIndex <= 0}
                  />
                  <Button
                    icon="pi pi-angle-down"
                    severity="secondary"
                    text
                    rounded
                    onClick={() => moveEncodeItem('post', rowIndex, 'down')}
                    disabled={busy || rowIndex >= postRipItems.length - 1}
                  />
                </div>
                {isScript ? (
                  <Dropdown
                    value={normalizeScriptId(item?.id)}
                    options={scriptOptions}
                    optionLabel="label"
                    optionValue="value"
                    optionDisabled="disabled"
                    onChange={(event) => changeEncodeItem('post', rowIndex, 'script', event.value)}
                    className="full-width"
                    disabled={busy}
                  />
                ) : (
                  <Dropdown
                    value={normalizeChainId(item?.id)}
                    options={chainOptions}
                    optionLabel="label"
                    optionValue="value"
                    optionDisabled="disabled"
                    onChange={(event) => changeEncodeItem('post', rowIndex, 'chain', event.value)}
                    className="full-width"
                    disabled={busy}
                  />
                )}
                <Button
                  icon="pi pi-times"
                  severity="danger"
                  outlined
                  onClick={() => removeEncodeItem('post', rowIndex)}
                  disabled={busy}
                />
              </div>
            );
          })}
          <div className="actions-row">
            {scriptCatalog.length > postRipItems.filter((entry) => entry?.type === 'script').length ? (
              <Button
                label="Skript hinzufügen"
                icon="pi pi-code"
                severity="secondary"
                outlined
                onClick={() => addEncodeItem('post', 'script')}
                disabled={busy}
              />
            ) : null}
            {chainCatalog.length > postRipItems.filter((entry) => entry?.type === 'chain').length ? (
              <Button
                label="Kette hinzufügen"
                icon="pi pi-link"
                severity="secondary"
                outlined
                onClick={() => addEncodeItem('post', 'chain')}
                disabled={busy}
              />
            ) : null}
          </div>
          <small>Ausführung nach erfolgreichem Rippen/Encodieren, strikt nacheinander.</small>
        </div>
      </div>

      <div className="actions-row" style={{ marginTop: '1rem' }}>
        {canStart ? (
          <Button
            label={(state === 'READY_TO_START' || state === 'READY_TO_ENCODE')
              ? 'Encode starten'
              : 'Mit diesen Einstellungen starten'}
            icon="pi pi-play"
            severity="success"
            onClick={() => onStart?.({
              format,
              formatOptions,
              chapters: editableChapters.map((chapter, index) => ({
                index: chapter.index || index + 1,
                title: normalizeChapterTitle(chapter.title, chapter.index || index + 1),
                startSeconds: chapter.startSeconds,
                endSeconds: chapter.endSeconds,
                startMs: chapter.startMs,
                endMs: chapter.endMs
              })),
              selectedPreEncodeScriptIds: normalizeIdList(
                preRipItems.filter((item) => item?.type === 'script').map((item) => item?.id),
                'script'
              ),
              selectedPostEncodeScriptIds: normalizeIdList(
                postRipItems.filter((item) => item?.type === 'script').map((item) => item?.id),
                'script'
              ),
              selectedPreEncodeChainIds: normalizeIdList(
                preRipItems.filter((item) => item?.type === 'chain').map((item) => item?.id),
                'chain'
              ),
              selectedPostEncodeChainIds: normalizeIdList(
                postRipItems.filter((item) => item?.type === 'chain').map((item) => item?.id),
                'chain'
              )
            })}
            loading={busy}
            disabled={!jobId}
          />
        ) : null}

        {jobId ? (
          <Button
            label="Job löschen"
            icon="pi pi-trash"
            severity="danger"
            outlined
            onClick={() => onDeleteJob?.(jobId)}
            loading={busy}
          />
        ) : null}

        <Button
          label="Abbrechen"
          severity="secondary"
          outlined
          onClick={() => onCancel?.()}
          loading={busy}
          disabled={!jobId}
        />

      </div>

      <Dialog
        header="Beschreibung"
        visible={descriptionDialogVisible}
        style={{ width: 'min(48rem, 92vw)' }}
        onHide={() => setDescriptionDialogVisible(false)}
      >
        <div
          className="audiobook-description-dialog"
          // eslint-disable-next-line react/no-danger
          dangerouslySetInnerHTML={{ __html: description || '<p>Keine Beschreibung vorhanden.</p>' }}
        />
      </Dialog>
    </div>
  );
}
