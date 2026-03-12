import { useState, useEffect } from 'react';
import { Dropdown } from 'primereact/dropdown';
import { Slider } from 'primereact/slider';
import { Button } from 'primereact/button';
import { ProgressBar } from 'primereact/progressbar';
import { Tag } from 'primereact/tag';
import { InputText } from 'primereact/inputtext';
import { InputNumber } from 'primereact/inputnumber';
import { CD_FORMATS, CD_FORMAT_SCHEMAS, getDefaultFormatOptions } from '../config/cdFormatSchemas';
import { api } from '../api/client';

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

function quoteShellArg(value) {
  const text = String(value || '');
  if (!text) {
    return "''";
  }
  if (/^[a-zA-Z0-9_./:-]+$/.test(text)) {
    return text;
  }
  return `'${text.replace(/'/g, "'\\''")}'`;
}

function buildCommandLine(cmd, args = []) {
  const normalizedArgs = Array.isArray(args) ? args : [];
  return [quoteShellArg(cmd), ...normalizedArgs.map((arg) => quoteShellArg(arg))].join(' ');
}

function buildEncodeCommandPreview({
  format,
  formatOptions,
  wavFile,
  outFile,
  trackTitle,
  trackArtist,
  albumTitle,
  year,
  trackNo
}) {
  const normalizedFormat = String(format || '').trim().toLowerCase();
  const title = String(trackTitle || `Track ${trackNo || 1}`).trim() || `Track ${trackNo || 1}`;
  const artist = String(trackArtist || '').trim();
  const album = String(albumTitle || '').trim();
  const releaseYear = year == null ? '' : String(year).trim();
  const number = String(trackNo || 1);

  if (normalizedFormat === 'wav') {
    return buildCommandLine('mv', [wavFile, outFile]);
  }

  if (normalizedFormat === 'flac') {
    const level = Math.max(0, Math.min(8, Number(formatOptions?.flacCompression ?? 5)));
    return buildCommandLine('flac', [
      `--compression-level-${level}`,
      '--tag', `TITLE=${title}`,
      '--tag', `ARTIST=${artist}`,
      '--tag', `ALBUM=${album}`,
      '--tag', `DATE=${releaseYear}`,
      '--tag', `TRACKNUMBER=${number}`,
      wavFile,
      '-o', outFile
    ]);
  }

  if (normalizedFormat === 'mp3') {
    const mode = String(formatOptions?.mp3Mode || 'cbr').trim().toLowerCase();
    const args = ['--id3v2-only', '--noreplaygain'];
    if (mode === 'vbr') {
      const quality = Math.max(0, Math.min(9, Number(formatOptions?.mp3Quality ?? 4)));
      args.push('-V', String(quality));
    } else {
      const bitrate = Number(formatOptions?.mp3Bitrate ?? 192);
      args.push('-b', String(bitrate));
    }
    args.push(
      '--tt', title,
      '--ta', artist,
      '--tl', album,
      '--ty', releaseYear,
      '--tn', number,
      wavFile,
      outFile
    );
    return buildCommandLine('lame', args);
  }

  if (normalizedFormat === 'opus') {
    const bitrate = Math.max(32, Math.min(512, Number(formatOptions?.opusBitrate ?? 160)));
    const complexity = Math.max(0, Math.min(10, Number(formatOptions?.opusComplexity ?? 10)));
    return buildCommandLine('opusenc', [
      '--bitrate', String(bitrate),
      '--comp', String(complexity),
      '--title', title,
      '--artist', artist,
      '--album', album,
      '--date', releaseYear,
      '--tracknumber', number,
      wavFile,
      outFile
    ]);
  }

  if (normalizedFormat === 'ogg') {
    const quality = Math.max(-1, Math.min(10, Number(formatOptions?.oggQuality ?? 6)));
    return buildCommandLine('oggenc', [
      '-q', String(quality),
      '-t', title,
      '-a', artist,
      '-l', album,
      '-d', releaseYear,
      '-N', number,
      '-o', outFile,
      wavFile
    ]);
  }

  return '';
}

function normalizePosition(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return Math.trunc(parsed);
}

function normalizeTrackText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizeYear(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return Math.trunc(parsed);
}

function formatTrackDuration(track) {
  const durationMs = Number(track?.durationMs);
  const durationSec = Number(track?.durationSec);
  const totalSec = Number.isFinite(durationMs) && durationMs > 0
    ? Math.round(durationMs / 1000)
    : (Number.isFinite(durationSec) && durationSec > 0 ? Math.round(durationSec) : 0);
  if (totalSec <= 0) {
    return '-';
  }
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}:${String(sec).padStart(2, '0')}`;
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
  const [settingsCdparanoiaCmd, setSettingsCdparanoiaCmd] = useState('');

  // Track selection: position → boolean
  const [selectedTracks, setSelectedTracks] = useState(() => {
    const map = {};
    for (const t of tracks) {
      const position = normalizePosition(t?.position);
      if (!position) {
        continue;
      }
      map[position] = t?.selected !== false;
    }
    return map;
  });
  // Editable track metadata in job overview (artist/title).
  const [trackFields, setTrackFields] = useState(() => {
    const map = {};
    const defaultArtist = normalizeTrackText(selectedMeta?.artist);
    for (const t of tracks) {
      const position = normalizePosition(t?.position);
      if (!position) {
        continue;
      }
      const fallbackTitle = `Track ${position}`;
      map[position] = {
        title: normalizeTrackText(t?.title) || fallbackTitle,
        artist: normalizeTrackText(t?.artist) || defaultArtist
      };
    }
    return map;
  });
  const [metaFields, setMetaFields] = useState(() => ({
    title: normalizeTrackText(selectedMeta?.title) || normalizeTrackText(context?.detectedTitle) || '',
    artist: normalizeTrackText(selectedMeta?.artist) || '',
    year: normalizeYear(selectedMeta?.year)
  }));

  useEffect(() => {
    setFormatOptions(getDefaultFormatOptions(format));
  }, [format]);

  useEffect(() => {
    setMetaFields({
      title: normalizeTrackText(selectedMeta?.title) || normalizeTrackText(context?.detectedTitle) || '',
      artist: normalizeTrackText(selectedMeta?.artist) || '',
      year: normalizeYear(selectedMeta?.year)
    });
  }, [context?.jobId, selectedMeta?.title, selectedMeta?.artist, selectedMeta?.year, context?.detectedTitle]);

  useEffect(() => {
    let cancelled = false;
    const refreshSettings = async () => {
      try {
        const response = await api.getSettings({ forceRefresh: true });
        if (cancelled) {
          return;
        }
        const value = String(response?.settings?.cdparanoia_command || '').trim();
        setSettingsCdparanoiaCmd(value);
      } catch (_error) {
        if (!cancelled) {
          setSettingsCdparanoiaCmd('');
        }
      }
    };
    refreshSettings();
    const intervalId = setInterval(refreshSettings, 5000);
    return () => {
      cancelled = true;
      clearInterval(intervalId);
    };
  }, [context?.jobId]);

  useEffect(() => {
    setSelectedTracks((prev) => {
      const next = {};
      for (const t of tracks) {
        const normalized = normalizePosition(t?.position);
        if (!normalized) {
          continue;
        }
        if (prev[normalized] !== undefined) {
          next[normalized] = prev[normalized];
        } else {
          next[normalized] = t?.selected !== false;
        }
      }
      return next;
    });
  }, [tracks]);

  useEffect(() => {
    const defaultArtist = normalizeTrackText(selectedMeta?.artist);
    setTrackFields((prev) => {
      const next = {};
      for (const t of tracks) {
        const position = normalizePosition(t?.position);
        if (!position) {
          continue;
        }
        const previous = prev[position] || {};
        const fallbackTitle = normalizeTrackText(t?.title) || `Track ${position}`;
        const fallbackArtist = normalizeTrackText(t?.artist) || defaultArtist;
        next[position] = {
          title: normalizeTrackText(previous.title) || fallbackTitle,
          artist: normalizeTrackText(previous.artist) || fallbackArtist
        };
      }
      return next;
    });
  }, [tracks, selectedMeta?.artist]);

  const handleFormatOptionChange = (key, value) => {
    setFormatOptions((prev) => ({ ...prev, [key]: value }));
  };

  const handleToggleTrack = (position) => {
    setSelectedTracks((prev) => ({ ...prev, [position]: !prev[position] }));
  };

  const handleToggleAll = () => {
    const allSelected = tracks.every((t) => {
      const position = normalizePosition(t?.position);
      return position ? selectedTracks[position] !== false : false;
    });
    const map = {};
    for (const t of tracks) {
      const position = normalizePosition(t?.position);
      if (!position) {
        continue;
      }
      map[position] = !allSelected;
    }
    setSelectedTracks(map);
  };

  const handleTrackFieldChange = (position, key, value) => {
    if (!position) {
      return;
    }
    setTrackFields((prev) => ({
      ...prev,
      [position]: {
        ...(prev[position] || {}),
        [key]: value
      }
    }));
  };

  const handleMetaFieldChange = (key, value) => {
    setMetaFields((prev) => ({
      ...prev,
      [key]: value
    }));
  };

  const handleStart = () => {
    const albumTitle = normalizeTrackText(metaFields?.title)
      || normalizeTrackText(selectedMeta?.title)
      || normalizeTrackText(context?.detectedTitle)
      || 'Audio CD';
    const albumArtist = normalizeTrackText(metaFields?.artist)
      || normalizeTrackText(selectedMeta?.artist)
      || null;
    const albumYear = normalizeYear(metaFields?.year);

    const normalizedTracks = tracks
      .map((t) => {
        const position = normalizePosition(t?.position);
        if (!position) {
          return null;
        }
        const baseTitle = normalizeTrackText(t?.title) || `Track ${position}`;
        const baseArtist = normalizeTrackText(t?.artist) || normalizeTrackText(selectedMeta?.artist);
        const edited = trackFields[position] || {};
        const title = normalizeTrackText(edited.title) || baseTitle;
        const artist = normalizeTrackText(edited.artist) || baseArtist || null;
        return {
          position,
          title,
          artist,
          selected: selectedTracks[position] !== false
        };
      })
      .filter(Boolean);

    const selected = normalizedTracks
      .filter((t) => t.selected)
      .map((t) => t.position);

    if (selected.length === 0) {
      return;
    }

    onStart && onStart({
      format,
      formatOptions,
      selectedTracks: selected,
      tracks: normalizedTracks,
      metadata: {
        title: albumTitle,
        artist: albumArtist,
        year: albumYear
      }
    });
  };

  const schema = CD_FORMAT_SCHEMAS[format] || { fields: [] };
  const visibleFields = schema.fields.filter((f) => isFieldVisible(f, formatOptions));

  const selectedCount = tracks.filter((t) => {
    const position = normalizePosition(t?.position);
    return position ? selectedTracks[position] !== false : false;
  }).length;
  const firstSelectedTrack = tracks.find((t) => {
    const position = normalizePosition(t?.position);
    return position ? selectedTracks[position] !== false : false;
  }) || null;
  const devicePath = String(context?.devicePath || context?.device?.path || '').trim();
  const cdparanoiaCmd = settingsCdparanoiaCmd
    || String(context?.cdparanoiaCmd || '').trim()
    || 'cdparanoia';
  const rawWavDir = String(context?.rawWavDir || '').trim();
  const commandTrackNumber = firstSelectedTrack ? Math.trunc(Number(firstSelectedTrack.position)) : null;
  const commandWavTarget = commandTrackNumber
    ? (
      rawWavDir
        ? `${rawWavDir}/track${String(commandTrackNumber).padStart(2, '0')}.cdda.wav`
        : `<temp>/track${String(commandTrackNumber).padStart(2, '0')}.cdda.wav`
    )
    : '<temp>/trackNN.cdda.wav';
  const cdparanoiaCommandPreview = [
    quoteShellArg(cdparanoiaCmd),
    '-d',
    quoteShellArg(devicePath || '<device>'),
    String(commandTrackNumber || '<trackNr>'),
    quoteShellArg(commandWavTarget)
  ].join(' ');
  const commandTrackNo = commandTrackNumber || 1;
  const commandTrackFields = trackFields[commandTrackNo] || {};
  const commandTrackTitle = normalizeTrackText(commandTrackFields.title)
    || normalizeTrackText(firstSelectedTrack?.title)
    || `Track ${commandTrackNo}`;
  const commandTrackArtist = normalizeTrackText(commandTrackFields.artist)
    || normalizeTrackText(firstSelectedTrack?.artist)
    || normalizeTrackText(metaFields?.artist)
    || normalizeTrackText(selectedMeta?.artist)
    || 'Unknown Artist';
  const commandAlbumTitle = normalizeTrackText(metaFields?.title)
    || normalizeTrackText(selectedMeta?.title)
    || normalizeTrackText(context?.detectedTitle)
    || 'Audio CD';
  const commandYear = normalizeYear(metaFields?.year) ?? normalizeYear(selectedMeta?.year);
  const commandOutputFile = `<output>/track${String(commandTrackNo).padStart(2, '0')}.${format}`;
  const encodeCommandPreview = buildEncodeCommandPreview({
    format,
    formatOptions,
    wavFile: commandWavTarget,
    outFile: commandOutputFile,
    trackTitle: commandTrackTitle,
    trackArtist: commandTrackArtist,
    albumTitle: commandAlbumTitle,
    year: commandYear,
    trackNo: commandTrackNo
  });
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
          <small>1) {cdparanoiaCommandPreview}</small>
          {encodeCommandPreview ? <small>2) {encodeCommandPreview}</small> : null}
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

      <div className="cd-meta-summary">
        <strong>Album-Metadaten</strong>
        <div className="metadata-grid" style={{ marginTop: '0.55rem' }}>
          <InputText
            value={metaFields.title}
            onChange={(e) => handleMetaFieldChange('title', e.target.value)}
            placeholder="Album"
            disabled={busy}
          />
          <InputText
            value={metaFields.artist}
            onChange={(e) => handleMetaFieldChange('artist', e.target.value)}
            placeholder="Interpret"
            disabled={busy}
          />
          <InputNumber
            value={metaFields.year}
            onValueChange={(e) => handleMetaFieldChange('year', normalizeYear(e.value))}
            placeholder="Jahr"
            useGrouping={false}
            min={1900}
            max={2100}
            disabled={busy}
          />
        </div>
      </div>

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
            <table className="cd-track-table">
              <thead>
                <tr>
                  <th className="check">Auswahl</th>
                  <th className="num">Nr</th>
                  <th className="artist">Interpret</th>
                  <th className="title">Titel</th>
                  <th className="duration">Länge</th>
                </tr>
              </thead>
              <tbody>
                {tracks.map((track) => {
                  const position = normalizePosition(track?.position);
                  if (!position) {
                    return null;
                  }
                  const isSelected = selectedTracks[position] !== false;
                  const fields = trackFields[position] || {};
                  const titleValue = normalizeTrackText(fields.title)
                    || normalizeTrackText(track?.title)
                    || `Track ${position}`;
                  const artistValue = normalizeTrackText(fields.artist)
                    || normalizeTrackText(track?.artist)
                    || normalizeTrackText(selectedMeta?.artist);
                  const duration = formatTrackDuration(track);
                  return (
                    <tr key={position} className={isSelected ? 'selected' : ''}>
                      <td className="check">
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => handleToggleTrack(position)}
                          disabled={busy}
                        />
                      </td>
                      <td className="num">{String(position).padStart(2, '0')}</td>
                      <td className="artist">
                        <InputText
                          value={artistValue}
                          onChange={(e) => handleTrackFieldChange(position, 'artist', e.target.value)}
                          placeholder="Interpret"
                          disabled={busy || !isSelected}
                        />
                      </td>
                      <td className="title">
                        <InputText
                          value={titleValue}
                          onChange={(e) => handleTrackFieldChange(position, 'title', e.target.value)}
                          placeholder={`Track ${position}`}
                          disabled={busy || !isSelected}
                        />
                      </td>
                      <td className="duration">{duration}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      <div className="cd-format-field">
        <label>Prompt-/Befehlskette (Preview)</label>
        <small>1) {cdparanoiaCommandPreview}</small>
        {encodeCommandPreview ? <small>2) {encodeCommandPreview}</small> : null}
      </div>

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
