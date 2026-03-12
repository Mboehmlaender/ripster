import { useState, useEffect } from 'react';
import { Dropdown } from 'primereact/dropdown';
import { Slider } from 'primereact/slider';
import { Button } from 'primereact/button';
import { ProgressBar } from 'primereact/progressbar';
import { Tag } from 'primereact/tag';
import { CD_FORMATS, CD_FORMAT_SCHEMAS, getDefaultFormatOptions } from '../config/cdFormatSchemas';

function isFieldVisible(field, values) {
  if (!field.showWhen) {
    return true;
  }
  return values[field.showWhen.field] === field.showWhen.value;
}

function FormatField({ field, value, onChange }) {
  if (field.type === 'slider') {
    return (
      <div className="cd-format-field">
        <label>
          {field.label}: <strong>{value}</strong>
        </label>
        {field.description ? <small>{field.description}</small> : null}
        <Slider
          value={value}
          onChange={(e) => onChange(field.key, e.value)}
          min={field.min}
          max={field.max}
          step={field.step || 1}
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
          onChange={(e) => onChange(field.key, e.value)}
        />
      </div>
    );
  }

  return null;
}

export default function CdRipConfigPanel({
  pipeline,
  onStart,
  onCancel,
  busy
}) {
  const context = pipeline?.context && typeof pipeline.context === 'object' ? pipeline.context : {};
  const tracks = Array.isArray(context.tracks) ? context.tracks : [];
  const selectedMeta = context.selectedMetadata || {};
  const state = String(pipeline?.state || '').trim().toUpperCase();

  const isRipping = state === 'CD_RIPPING' || state === 'CD_ENCODING';
  const isFinished = state === 'FINISHED';

  const [format, setFormat] = useState('flac');
  const [formatOptions, setFormatOptions] = useState(() => getDefaultFormatOptions('flac'));

  // Track selection: position → boolean
  const [selectedTracks, setSelectedTracks] = useState(() => {
    const map = {};
    for (const t of tracks) {
      map[t.position] = true;
    }
    return map;
  });

  useEffect(() => {
    setFormatOptions(getDefaultFormatOptions(format));
  }, [format]);

  useEffect(() => {
    const map = {};
    for (const t of tracks) {
      map[t.position] = selectedTracks[t.position] !== false;
    }
    setSelectedTracks(map);
  }, [tracks.length]);

  const handleFormatOptionChange = (key, value) => {
    setFormatOptions((prev) => ({ ...prev, [key]: value }));
  };

  const handleToggleTrack = (position) => {
    setSelectedTracks((prev) => ({ ...prev, [position]: !prev[position] }));
  };

  const handleToggleAll = () => {
    const allSelected = tracks.every((t) => selectedTracks[t.position] !== false);
    const map = {};
    for (const t of tracks) {
      map[t.position] = !allSelected;
    }
    setSelectedTracks(map);
  };

  const handleStart = () => {
    const selected = tracks
      .filter((t) => selectedTracks[t.position] !== false)
      .map((t) => t.position);

    if (selected.length === 0) {
      return;
    }

    onStart && onStart({
      format,
      formatOptions,
      selectedTracks: selected
    });
  };

  const schema = CD_FORMAT_SCHEMAS[format] || { fields: [] };
  const visibleFields = schema.fields.filter((f) => isFieldVisible(f, formatOptions));

  const selectedCount = tracks.filter((t) => selectedTracks[t.position] !== false).length;
  const progress = Number(pipeline?.progress ?? 0);
  const clampedProgress = Math.max(0, Math.min(100, progress));
  const eta = String(pipeline?.eta || '').trim();
  const statusText = String(pipeline?.statusText || '').trim();

  if (isRipping || isFinished) {
    return (
      <div className="cd-rip-config-panel">
        <div className="cd-rip-status">
          <Tag
            value={state === 'CD_RIPPING' ? 'Ripping' : state === 'CD_ENCODING' ? 'Encodierung' : 'Fertig'}
            severity={isFinished ? 'success' : 'info'}
          />
          {statusText ? <small>{statusText}</small> : null}
          {!isFinished ? (
            <>
              <ProgressBar value={clampedProgress} />
              <small>{Math.round(clampedProgress)}%{eta ? ` | ETA ${eta}` : ''}</small>
            </>
          ) : null}
        </div>
        {!isFinished ? (
          <Button
            label="Abbrechen"
            icon="pi pi-times"
            severity="danger"
            outlined
            onClick={() => onCancel && onCancel()}
            disabled={busy}
          />
        ) : null}
      </div>
    );
  }

  return (
    <div className="cd-rip-config-panel">
      <h4 style={{ marginTop: 0, marginBottom: '0.75rem' }}>CD-Rip Konfiguration</h4>

      {selectedMeta.title ? (
        <div className="cd-meta-summary">
          <strong>{selectedMeta.artist ? `${selectedMeta.artist} – ` : ''}{selectedMeta.title}</strong>
          {selectedMeta.year ? <span> ({selectedMeta.year})</span> : null}
        </div>
      ) : null}

      {/* Format selection */}
      <div className="cd-format-field">
        <label>Ausgabeformat</label>
        <Dropdown
          value={format}
          options={CD_FORMATS}
          optionLabel="label"
          optionValue="value"
          onChange={(e) => setFormat(e.value)}
          disabled={busy}
        />
      </div>

      {/* Format-specific options */}
      {visibleFields.map((field) => (
        <FormatField
          key={field.key}
          field={field}
          value={formatOptions[field.key] ?? field.default}
          onChange={handleFormatOptionChange}
        />
      ))}

      {/* Track selection */}
      {tracks.length > 0 ? (
        <div className="cd-track-selection">
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '0.5rem' }}>
            <strong>Tracks ({selectedCount} / {tracks.length} ausgewählt)</strong>
            <Button
              label={selectedCount === tracks.length ? 'Alle abwählen' : 'Alle auswählen'}
              size="small"
              severity="secondary"
              outlined
              onClick={handleToggleAll}
              disabled={busy}
            />
          </div>
          <div className="cd-track-list">
            {tracks.map((track) => {
              const isSelected = selectedTracks[track.position] !== false;
              const totalSec = Math.round((track.durationMs || track.durationSec * 1000 || 0) / 1000);
              const min = Math.floor(totalSec / 60);
              const sec = totalSec % 60;
              const duration = totalSec > 0 ? `${min}:${String(sec).padStart(2, '0')}` : '-';
              return (
                <button
                  key={track.position}
                  type="button"
                  className={`cd-track-row selectable${isSelected ? ' selected' : ''}`}
                  onClick={() => !busy && handleToggleTrack(track.position)}
                  disabled={busy}
                >
                  <span className="cd-track-num">{String(track.position).padStart(2, '0')}</span>
                  <span className="cd-track-title">{track.title || `Track ${track.position}`}</span>
                  <span className="cd-track-duration">{duration}</span>
                </button>
              );
            })}
          </div>
        </div>
      ) : null}

      {/* Actions */}
      <div className="actions-row" style={{ marginTop: '1rem' }}>
        <Button
          label="Abbrechen"
          severity="secondary"
          outlined
          onClick={() => onCancel && onCancel()}
          disabled={busy}
        />
        <Button
          label="Rip starten"
          icon="pi pi-play"
          onClick={handleStart}
          loading={busy}
          disabled={selectedCount === 0}
        />
      </div>
    </div>
  );
}
