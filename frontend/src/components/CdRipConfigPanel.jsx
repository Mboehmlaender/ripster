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
import { getStatusLabel, getStatusSeverity } from '../utils/statusPresentation';

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

function formatTotalDuration(totalSec) {
  const parsed = Number(totalSec);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return '-';
  }
  const rounded = Math.max(0, Math.trunc(parsed));
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);
  const seconds = rounded % 60;
  if (hours > 0) {
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function formatProgressLabel(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return '0%';
  }
  const clamped = Math.max(0, Math.min(100, parsed));
  const rounded = Math.round(clamped * 10) / 10;
  if (Number.isInteger(rounded)) {
    return `${rounded}%`;
  }
  return `${rounded.toFixed(1)}%`;
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

function describeEncodeItem(item, scriptById, chainById) {
  if (!item || typeof item !== 'object') {
    return '-';
  }
  if (item.type === 'chain') {
    const chain = chainById.get(normalizeChainId(item.id));
    return chain?.name || `Kette #${item.id}`;
  }
  const script = scriptById.get(normalizeScriptId(item.id));
  return script?.name || `Skript #${item.id}`;
}

export default function CdRipConfigPanel({
  pipeline,
  onStart,
  onCancel,
  onRetry,
  onOpenMetadata,
  busy
}) {
  const context = pipeline?.context && typeof pipeline.context === 'object' ? pipeline.context : {};
  const tracks = Array.isArray(context.tracks) ? context.tracks : [];
  const selectedMeta = context.selectedMetadata || {};
  const state = String(pipeline?.state || '').trim().toUpperCase();
  const jobId = normalizePosition(context?.jobId);

  const isRipping = state === 'CD_RIPPING' || state === 'CD_ENCODING';
  const isFinished = state === 'FINISHED';
  const isTerminalFailure = state === 'CANCELLED' || state === 'ERROR';

  const [format, setFormat] = useState('flac');
  const [formatOptions, setFormatOptions] = useState(() => getDefaultFormatOptions('flac'));

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
  const [scriptCatalog, setScriptCatalog] = useState([]);
  const [chainCatalog, setChainCatalog] = useState([]);
  const [preRipItems, setPreRipItems] = useState([]);
  const [postRipItems, setPostRipItems] = useState([]);
  const cdRipConfig = context?.cdRipConfig && typeof context.cdRipConfig === 'object' ? context.cdRipConfig : {};
  const scriptById = new Map(
    (Array.isArray(scriptCatalog) ? scriptCatalog : [])
      .map((item) => [normalizeScriptId(item?.id), item])
      .filter(([id]) => id !== null)
  );
  const chainById = new Map(
    (Array.isArray(chainCatalog) ? chainCatalog : [])
      .map((item) => [normalizeChainId(item?.id), item])
      .filter(([id]) => id !== null)
  );
  const cdRipConfigKey = JSON.stringify({
    preEncodeScriptIds: normalizeIdList(cdRipConfig?.preEncodeScriptIds, 'script'),
    postEncodeScriptIds: normalizeIdList(cdRipConfig?.postEncodeScriptIds, 'script'),
    preEncodeChainIds: normalizeIdList(cdRipConfig?.preEncodeChainIds, 'chain'),
    postEncodeChainIds: normalizeIdList(cdRipConfig?.postEncodeChainIds, 'chain')
  });

  useEffect(() => {
    setFormatOptions(getDefaultFormatOptions(format));
  }, [format]);

  useEffect(() => {
    const configuredFormat = String(cdRipConfig?.format || '').trim().toLowerCase();
    if (!configuredFormat || !CD_FORMAT_SCHEMAS[configuredFormat]) {
      return;
    }
    setFormat(configuredFormat);
    setFormatOptions((prev) => ({
      ...getDefaultFormatOptions(configuredFormat),
      ...(prev && typeof prev === 'object' ? prev : {}),
      ...(cdRipConfig?.formatOptions && typeof cdRipConfig.formatOptions === 'object' ? cdRipConfig.formatOptions : {})
    }));
  }, [context?.jobId, cdRipConfig?.format, JSON.stringify(cdRipConfig?.formatOptions || {})]);

  useEffect(() => {
    setMetaFields({
      title: normalizeTrackText(selectedMeta?.title) || normalizeTrackText(context?.detectedTitle) || '',
      artist: normalizeTrackText(selectedMeta?.artist) || '',
      year: normalizeYear(selectedMeta?.year)
    });
  }, [context?.jobId, selectedMeta?.title, selectedMeta?.artist, selectedMeta?.year, context?.detectedTitle]);

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
    setPreRipItems(buildEncodeItemsFromConfig(cdRipConfig, 'pre'));
    setPostRipItems(buildEncodeItemsFromConfig(cdRipConfig, 'post'));
  }, [context?.jobId, cdRipConfigKey]);

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

  const handleStart = () => {
    const albumTitle = normalizeTrackText(metaFields?.title)
      || normalizeTrackText(selectedMeta?.title)
      || normalizeTrackText(context?.detectedTitle)
      || 'Audio CD';
    const fallbackArtistFromTracks = tracks
      .map((track) => normalizeTrackText(track?.artist))
      .find(Boolean) || null;
    const albumArtist = normalizeTrackText(metaFields?.artist)
      || normalizeTrackText(selectedMeta?.artist)
      || fallbackArtistFromTracks
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

    const selectedPreEncodeScriptIds = normalizeIdList(
      preRipItems.filter((item) => item?.type === 'script').map((item) => item?.id),
      'script'
    );
    const selectedPostEncodeScriptIds = normalizeIdList(
      postRipItems.filter((item) => item?.type === 'script').map((item) => item?.id),
      'script'
    );
    const selectedPreEncodeChainIds = normalizeIdList(
      preRipItems.filter((item) => item?.type === 'chain').map((item) => item?.id),
      'chain'
    );
    const selectedPostEncodeChainIds = normalizeIdList(
      postRipItems.filter((item) => item?.type === 'chain').map((item) => item?.id),
      'chain'
    );

    onStart && onStart({
      format,
      formatOptions,
      selectedTracks: selected,
      tracks: normalizedTracks,
      selectedPreEncodeScriptIds,
      selectedPostEncodeScriptIds,
      selectedPreEncodeChainIds,
      selectedPostEncodeChainIds,
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
  const progress = Number(pipeline?.progress ?? 0);
  const clampedProgress = Math.max(0, Math.min(100, progress));
  const roundedProgress = Math.round(clampedProgress * 10) / 10;
  const eta = String(pipeline?.eta || '').trim();
  const statusText = String(pipeline?.statusText || '').trim();
  const stateLabel = getStatusLabel(state);
  const stateSeverity = getStatusSeverity(state);
  const cdLive = context?.cdLive && typeof context.cdLive === 'object' ? context.cdLive : {};
  const cdLiveTrackStates = Array.isArray(cdLive?.trackStates) ? cdLive.trackStates : [];
  const cdLiveTrackStateByPosition = new Map(
    cdLiveTrackStates
      .map((item) => [normalizePosition(item?.position), item])
      .filter(([position]) => position !== null)
  );
  const cdLiveSelectedTrackPositions = Array.isArray(cdLive?.selectedTrackPositions)
    ? cdLive.selectedTrackPositions
      .map((value) => normalizePosition(value))
      .filter((value) => value !== null)
    : [];
  const cdLiveSelectedTrackSet = new Set(cdLiveSelectedTrackPositions.map((value) => String(value)));
  const livePhase = String(cdLive?.phase || '').trim().toLowerCase();
  const livePhaseLabel = livePhase === 'encode' ? 'Encode' : 'Rip';
  const albumTitle = normalizeTrackText(metaFields?.title)
    || normalizeTrackText(selectedMeta?.title)
    || normalizeTrackText(context?.detectedTitle)
    || '-';
  const fallbackArtistFromTracks = tracks
    .map((track) => normalizeTrackText(track?.artist))
    .find(Boolean) || '-';
  const albumArtist = normalizeTrackText(metaFields?.artist)
    || normalizeTrackText(selectedMeta?.artist)
    || fallbackArtistFromTracks
    || '-';
  const albumYear = normalizeYear(metaFields?.year)
    ?? normalizeYear(selectedMeta?.year)
    ?? '-';
  const musicBrainzId = normalizeTrackText(
    selectedMeta?.mbId
    || selectedMeta?.musicBrainzId
    || selectedMeta?.musicbrainzId
    || selectedMeta?.mbid
    || ''
  ) || '-';
  const coverUrl = normalizeTrackText(
    selectedMeta?.coverUrl
    || selectedMeta?.poster
    || selectedMeta?.posterUrl
    || ''
  ) || null;
  const devicePath = normalizeTrackText(context?.devicePath) || '-';
  const outputPath = normalizeTrackText(context?.outputPath) || '-';
  const formatValue = String(cdRipConfig?.format || '').trim().toLowerCase();
  const formatLabel = (Array.isArray(CD_FORMATS)
    ? CD_FORMATS.find((entry) => String(entry?.value || '').trim().toLowerCase() === formatValue)?.label
    : null) || (formatValue ? formatValue.toUpperCase() : '-');
  const effectiveTrackRows = tracks
    .map((track) => {
      const position = normalizePosition(track?.position);
      if (!position) {
        return null;
      }
      const selected = cdLiveSelectedTrackSet.size > 0
        ? cdLiveSelectedTrackSet.has(String(position))
        : (selectedTracks[position] !== false);
      const trackDurationSec = Number.isFinite(Number(track?.durationMs)) && Number(track.durationMs) > 0
        ? Math.round(Number(track.durationMs) / 1000)
        : (Number.isFinite(Number(track?.durationSec)) && Number(track.durationSec) > 0
          ? Math.round(Number(track.durationSec))
          : 0);
      const liveTrackState = cdLiveTrackStateByPosition.get(position) || null;
      const fallbackRipStatus = isFinished && selected ? 'done' : 'pending';
      const fallbackEncodeStatus = isFinished && selected ? 'done' : 'pending';
      return {
        position,
        selected,
        title: normalizeTrackText(trackFields?.[position]?.title)
          || normalizeTrackText(track?.title)
          || `Track ${position}`,
        artist: normalizeTrackText(trackFields?.[position]?.artist)
          || normalizeTrackText(track?.artist)
          || normalizeTrackText(selectedMeta?.artist)
          || '-',
        durationLabel: formatTrackDuration(track),
        durationSec: trackDurationSec,
        ripStatus: normalizeTrackStageStatus(liveTrackState?.ripStatus || fallbackRipStatus),
        encodeStatus: normalizeTrackStageStatus(liveTrackState?.encodeStatus || fallbackEncodeStatus)
      };
    })
    .filter(Boolean);
  if (effectiveTrackRows.length === 0 && cdLiveTrackStates.length > 0) {
    for (const trackState of cdLiveTrackStates) {
      const position = normalizePosition(trackState?.position);
      if (!position) {
        continue;
      }
      const trackDurationSec = Number(trackState?.durationSec);
      effectiveTrackRows.push({
        position,
        selected: true,
        title: normalizeTrackText(trackState?.title) || `Track ${position}`,
        artist: normalizeTrackText(trackState?.artist) || '-',
        durationLabel: formatTotalDuration(trackDurationSec),
        durationSec: Number.isFinite(trackDurationSec) && trackDurationSec > 0 ? Math.trunc(trackDurationSec) : 0,
        ripStatus: normalizeTrackStageStatus(trackState?.ripStatus),
        encodeStatus: normalizeTrackStageStatus(trackState?.encodeStatus)
      });
    }
  }
  const selectedTrackRows = effectiveTrackRows.filter((track) => track.selected);
  const displayTrackRows = selectedTrackRows.length > 0 ? selectedTrackRows : effectiveTrackRows;
  const selectedTrackNumbers = selectedTrackRows
    .map((track) => String(track.position).padStart(2, '0'))
    .join(', ');
  const selectedTrackDurationSec = selectedTrackRows.reduce(
    (sum, track) => sum + (Number.isFinite(track.durationSec) ? track.durationSec : 0),
    0
  );
  const completedRipCount = selectedTrackRows.filter((track) => track.ripStatus === 'done').length;
  const completedEncodeCount = selectedTrackRows.filter((track) => track.encodeStatus === 'done').length;
  const liveCurrentTrackPosition = normalizePosition(cdLive?.trackPosition);
  const lastState = String(context?.lastState || '').trim().toUpperCase();
  const preScriptNamesFromConfig = (Array.isArray(cdRipConfig?.preEncodeScripts) ? cdRipConfig.preEncodeScripts : [])
    .map((item) => String(item?.name || '').trim())
    .filter(Boolean);
  const postScriptNamesFromConfig = (Array.isArray(cdRipConfig?.postEncodeScripts) ? cdRipConfig.postEncodeScripts : [])
    .map((item) => String(item?.name || '').trim())
    .filter(Boolean);
  const preChainNamesFromConfig = (Array.isArray(cdRipConfig?.preEncodeChains) ? cdRipConfig.preEncodeChains : [])
    .map((item) => String(item?.name || '').trim())
    .filter(Boolean);
  const postChainNamesFromConfig = (Array.isArray(cdRipConfig?.postEncodeChains) ? cdRipConfig.postEncodeChains : [])
    .map((item) => String(item?.name || '').trim())
    .filter(Boolean);
  const preScriptNames = preScriptNamesFromConfig.length > 0
    ? preScriptNamesFromConfig
    : preRipItems
      .filter((item) => item?.type === 'script')
      .map((item) => describeEncodeItem(item, scriptById, chainById));
  const postScriptNames = postScriptNamesFromConfig.length > 0
    ? postScriptNamesFromConfig
    : postRipItems
      .filter((item) => item?.type === 'script')
      .map((item) => describeEncodeItem(item, scriptById, chainById));
  const preChainNames = preChainNamesFromConfig.length > 0
    ? preChainNamesFromConfig
    : preRipItems
      .filter((item) => item?.type === 'chain')
      .map((item) => describeEncodeItem(item, scriptById, chainById));
  const postChainNames = postChainNamesFromConfig.length > 0
    ? postChainNamesFromConfig
    : postRipItems
      .filter((item) => item?.type === 'chain')
      .map((item) => describeEncodeItem(item, scriptById, chainById));

  if (isRipping || isFinished || isTerminalFailure) {
    return (
      <div className="cd-rip-config-panel">
        <div className="status-row">
          <Tag value={stateLabel} severity={stateSeverity} />
          <span>{statusText || 'Bereit'}</span>
        </div>
        {isRipping ? (
          <div className="progress-wrap">
            <ProgressBar
              value={roundedProgress}
              showValue
              displayValueTemplate={(value) => formatProgressLabel(value)}
            />
            <small>
              {`Fortschritt: ${formatProgressLabel(roundedProgress)} | ${livePhaseLabel} ${completedRipCount}/${selectedTrackRows.length || effectiveTrackRows.length} Rip | ${completedEncodeCount}/${selectedTrackRows.length || effectiveTrackRows.length} Encode`}
            </small>
            <small>{eta ? `ETA ${eta}` : 'ETA unbekannt'}</small>
          </div>
        ) : isFinished ? (
          <div className="progress-wrap">
            <ProgressBar value={100} showValue displayValueTemplate={() => '100%'} />
          </div>
        ) : null}
        {isRipping ? (
          <div className="actions-row">
            <Button
              label="Abbrechen"
              icon="pi pi-stop"
              severity="danger"
              onClick={() => onCancel && onCancel()}
              disabled={busy}
            />
          </div>
        ) : null}
        {isTerminalFailure ? (
          <div className="actions-row">
            {jobId ? (
              <Button
                label="Retry Rippen"
                icon="pi pi-refresh"
                severity="warning"
                onClick={() => onRetry && onRetry()}
                loading={busy}
              />
            ) : null}
            <Button
              label="Metadaten ändern"
              icon="pi pi-pencil"
              severity="secondary"
              onClick={() => onOpenMetadata && onOpenMetadata()}
              loading={busy}
            />
          </div>
        ) : null}

        <div className="cd-meta-summary">
          <strong>CD-Details</strong>
          <div className="cd-media-meta-layout">
            {coverUrl ? (
              <div className="cd-cover-wrap">
                <img src={coverUrl} alt={`Cover ${albumTitle}`} className="cd-cover-image" />
              </div>
            ) : null}
            <div className="device-meta" style={{ marginTop: '0.55rem' }}>
              <div><strong>Album:</strong> {albumTitle}</div>
              <div><strong>Interpret:</strong> {albumArtist}</div>
              <div><strong>Jahr:</strong> {albumYear}</div>
              <div><strong>MusicBrainz:</strong> {musicBrainzId}</div>
              <div><strong>Status:</strong> {stateLabel}</div>
              <div><strong>Format:</strong> {formatLabel}</div>
              <div><strong>Rip fertig:</strong> {completedRipCount} / {selectedTrackRows.length || effectiveTrackRows.length}</div>
              <div><strong>Encode fertig:</strong> {completedEncodeCount} / {selectedTrackRows.length || effectiveTrackRows.length}</div>
              <div><strong>Aktueller Track:</strong> {liveCurrentTrackPosition ? String(liveCurrentTrackPosition).padStart(2, '0') : '-'}</div>
              <div><strong>Pre-Skripte:</strong> {preScriptNames.length > 0 ? preScriptNames.join(' | ') : '-'}</div>
              <div><strong>Pre-Ketten:</strong> {preChainNames.length > 0 ? preChainNames.join(' | ') : '-'}</div>
              <div><strong>Post-Skripte:</strong> {postScriptNames.length > 0 ? postScriptNames.join(' | ') : '-'}</div>
              <div><strong>Post-Ketten:</strong> {postChainNames.length > 0 ? postChainNames.join(' | ') : '-'}</div>
              <div><strong>Tracks fertig:</strong> {completedEncodeCount} / {selectedTrackRows.length || effectiveTrackRows.length}</div>
              <div><strong>Auswahl:</strong> {selectedTrackNumbers || '-'}</div>
              <div><strong>Gesamtdauer:</strong> {formatTotalDuration(selectedTrackDurationSec)}</div>
              <div><strong>Laufwerk:</strong> {devicePath}</div>
              <div><strong>Output-Pfad:</strong> {outputPath}</div>
              {lastState ? <div><strong>Letzter Pipeline-State:</strong> {lastState}</div> : null}
              {jobId ? <div><strong>Job-ID:</strong> #{jobId}</div> : null}
            </div>
          </div>
        </div>

        {displayTrackRows.length > 0 ? (
          <div className="cd-track-selection">
            <strong>Zu rippende Tracks ({displayTrackRows.length})</strong>
            <div className="cd-track-list">
              <table className="cd-track-table">
                <thead>
                  <tr>
                    <th className="check">Auswahl</th>
                    <th className="num">Nr</th>
                    <th className="artist">Interpret</th>
                    <th className="title">Titel</th>
                    <th className="duration">Länge</th>
                    <th className="status">Rip</th>
                    <th className="status">Encode</th>
                  </tr>
                </thead>
                <tbody>
                  {displayTrackRows.map((track) => {
                    const ripMeta = trackStatusTagMeta(track?.ripStatus);
                    const encodeMeta = trackStatusTagMeta(track?.encodeStatus);
                    return (
                    <tr key={track.position} className={track.selected ? 'selected' : ''}>
                      <td className="check">{track.selected ? 'Ja' : 'Nein'}</td>
                      <td className="num">{String(track.position).padStart(2, '0')}</td>
                      <td className="artist">{track.artist || '-'}</td>
                      <td className="title">{track.title || '-'}</td>
                      <td className="duration">{track.durationLabel}</td>
                      <td className="status"><Tag value={ripMeta.label} severity={ripMeta.severity} /></td>
                      <td className="status"><Tag value={encodeMeta.label} severity={encodeMeta.severity} /></td>
                    </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
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
            <div key={`cd-pre-${rowIndex}-${item?.type}-${item?.id}`} className="post-script-row editable">
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
        <small>Ausführung vor dem Rippen, strikt nacheinander. Bei Fehler wird der CD-Rip abgebrochen.</small>
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
            <div key={`cd-post-${rowIndex}-${item?.type}-${item?.id}`} className="post-script-row editable">
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

      {/* Actions */}
      <div className="actions-row" style={{ marginTop: '1rem' }}>
        {jobId ? (
          <Button
            label="Metadaten ändern"
            icon="pi pi-pencil"
            severity="secondary"
            outlined
            onClick={() => onOpenMetadata && onOpenMetadata()}
            disabled={busy}
          />
        ) : null}
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
