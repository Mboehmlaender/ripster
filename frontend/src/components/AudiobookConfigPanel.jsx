import { useEffect, useMemo, useState } from 'react';
import { Dropdown } from 'primereact/dropdown';
import { Slider } from 'primereact/slider';
import { Button } from 'primereact/button';
import { ProgressBar } from 'primereact/progressbar';
import { Tag } from 'primereact/tag';
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

  useEffect(() => {
    const nextFormat = normalizeFormat(audiobookConfig?.format);
    setFormat(nextFormat);
    setFormatOptions(buildFormatOptions(nextFormat, audiobookConfig?.formatOptions));
  }, [jobId, audiobookConfig?.format, JSON.stringify(audiobookConfig?.formatOptions || {})]);

  const schema = AUDIOBOOK_FORMAT_SCHEMAS[format] || AUDIOBOOK_FORMAT_SCHEMAS.mp3;
  const canStart = Boolean(jobId) && (state === 'READY_TO_START' || state === 'ERROR' || state === 'CANCELLED');
  const isRunning = state === 'ENCODING';
  const progress = Number.isFinite(Number(pipeline?.progress)) ? Math.max(0, Math.min(100, Number(pipeline.progress))) : 0;
  const outputPath = String(context?.outputPath || '').trim() || null;
  const statusLabel = getStatusLabel(state);
  const statusSeverity = getStatusSeverity(state);

  const visibleFields = useMemo(
    () => (Array.isArray(schema?.fields) ? schema.fields.filter((field) => isFieldVisible(field, formatOptions)) : []),
    [schema, formatOptions]
  );

  return (
    <div className="audiobook-config-panel">
      <div className="audiobook-config-head">
        <div className="device-meta">
          <div><strong>Titel:</strong> {metadata?.title || '-'}</div>
          <div><strong>Autor:</strong> {metadata?.author || '-'}</div>
          <div><strong>Sprecher:</strong> {metadata?.narrator || '-'}</div>
          <div><strong>Serie:</strong> {metadata?.series || '-'}</div>
          <div><strong>Teil:</strong> {metadata?.part || '-'}</div>
          <div><strong>Jahr:</strong> {metadata?.year || '-'}</div>
          <div><strong>Kapitel:</strong> {chapters.length || '-'}</div>
        </div>
        <div className="audiobook-config-tags">
          <Tag value={statusLabel} severity={statusSeverity} />
          <Tag value={`Format: ${format.toUpperCase()}`} severity="info" />
          {metadata?.durationMs ? <Tag value={`Dauer: ${Math.round(Number(metadata.durationMs) / 60000)} min`} severity="secondary" /> : null}
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
            Metadaten und Kapitel werden aus der AAX-Datei gelesen. Erst nach Klick auf Start wird `ffmpeg` ausgeführt.
          </small>
        </div>

        <div className="audiobook-config-chapters">
          <h4>Kapitelvorschau</h4>
          {chapters.length === 0 ? (
            <small>Keine Kapitel in der Quelle erkannt.</small>
          ) : (
            <div className="audiobook-chapter-list">
              {chapters.map((chapter, index) => (
                <div key={`${chapter?.index || index}-${chapter?.title || ''}`} className="audiobook-chapter-row">
                  <strong>#{chapter?.index || index + 1}</strong>
                  <span>{chapter?.title || `Kapitel ${index + 1}`}</span>
                  <small>
                    {formatChapterTime(chapter?.startSeconds)} - {formatChapterTime(chapter?.endSeconds)}
                  </small>
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
            onClick={() => onStart?.({ format, formatOptions })}
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
    </div>
  );
}
