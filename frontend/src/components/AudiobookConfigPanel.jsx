import { useEffect, useMemo, useState } from 'react';
import { Dialog } from 'primereact/dialog';
import { Dropdown } from 'primereact/dropdown';
import { Slider } from 'primereact/slider';
import { Button } from 'primereact/button';
import { ProgressBar } from 'primereact/progressbar';
import { Tag } from 'primereact/tag';
import { InputText } from 'primereact/inputtext';
import { AUDIOBOOK_FORMATS, AUDIOBOOK_FORMAT_SCHEMAS, getDefaultAudiobookFormatOptions } from '../config/audiobookFormatSchemas';
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

function truncateDescription(value, maxLength = 220) {
  const normalized = String(value || '').replace(/\s+/g, ' ').trim();
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
  onRetry,
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

  useEffect(() => {
    const nextFormat = normalizeFormat(audiobookConfig?.format);
    setFormat(nextFormat);
    setFormatOptions(buildFormatOptions(nextFormat, audiobookConfig?.formatOptions));
  }, [jobId, audiobookConfig?.format, JSON.stringify(audiobookConfig?.formatOptions || {})]);

  useEffect(() => {
    setEditableChapters(normalizeEditableChapters(chapters));
  }, [jobId, JSON.stringify(chapters || [])]);

  const schema = AUDIOBOOK_FORMAT_SCHEMAS[format] || AUDIOBOOK_FORMAT_SCHEMAS.mp3;
  const canStart = Boolean(jobId) && (state === 'READY_TO_START' || state === 'ERROR' || state === 'CANCELLED');
  const isRunning = state === 'ENCODING';
  const progress = Number.isFinite(Number(pipeline?.progress)) ? Math.max(0, Math.min(100, Number(pipeline.progress))) : 0;
  const outputPath = String(context?.outputPath || '').trim() || null;
  const statusLabel = getStatusLabel(state);
  const statusSeverity = getStatusSeverity(state);
  const description = String(metadata?.description || '').trim();
  const descriptionPreview = truncateDescription(description);
  const posterUrl = String(metadata?.poster || '').trim() || null;

  const visibleFields = useMemo(
    () => (Array.isArray(schema?.fields) ? schema.fields.filter((field) => isFieldVisible(field, formatOptions)) : []),
    [schema, formatOptions]
  );

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
            <div><strong>Serie:</strong> {metadata?.series || '-'}</div>
            <div><strong>Teil:</strong> {metadata?.part || '-'}</div>
            <div><strong>Jahr:</strong> {metadata?.year || '-'}</div>
            <div><strong>Kapitel:</strong> {editableChapters.length || '-'}</div>
            {descriptionPreview ? (
              <div className="audiobook-description-preview">
                <strong>Beschreibung:</strong>
                <span>{descriptionPreview}</span>
                {description.length > descriptionPreview.length ? (
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

        <div className="audiobook-config-tags">
          <Tag value={statusLabel} severity={statusSeverity} />
          <Tag value={`Format: ${format.toUpperCase()}`} severity="info" />
          {metadata?.durationMs ? <Tag value={`Dauer: ${Math.round(Number(metadata.durationMs) / 60000)} min`} severity="secondary" /> : null}
          {posterUrl ? <Tag value="Cover erkannt" severity="success" /> : null}
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
      </div>

      {isRunning ? (
        <div className="dashboard-job-row-progress" aria-label={`Audiobook Fortschritt ${Math.round(progress)}%`}>
          <ProgressBar value={progress} showValue={false} />
          <small>{Math.round(progress)}%</small>
        </div>
      ) : null}

      {outputPath ? (
        <div className="audiobook-output-path">
          <strong>Ausgabe:</strong> <code>{outputPath}</code>
        </div>
      ) : null}

      <div className="actions-row">
        {canStart ? (
          <Button
            label={state === 'READY_TO_START' ? 'Encoding starten' : 'Mit diesen Einstellungen starten'}
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
              }))
            })}
            loading={busy}
            disabled={!jobId}
          />
        ) : null}

        {isRunning ? (
          <Button
            label="Abbrechen"
            icon="pi pi-stop"
            severity="danger"
            onClick={() => onCancel?.()}
            loading={busy}
            disabled={!jobId}
          />
        ) : null}

        {(state === 'ERROR' || state === 'CANCELLED') ? (
          <Button
            label="Retry-Job anlegen"
            icon="pi pi-refresh"
            severity="warning"
            outlined
            onClick={() => onRetry?.()}
            loading={busy}
            disabled={!jobId}
          />
        ) : null}
      </div>

      <Dialog
        header="Beschreibung"
        visible={descriptionDialogVisible}
        style={{ width: 'min(48rem, 92vw)' }}
        onHide={() => setDescriptionDialogVisible(false)}
      >
        <div className="audiobook-description-dialog">
          <p>{description || 'Keine Beschreibung vorhanden.'}</p>
        </div>
      </Dialog>
    </div>
  );
}
