import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from 'primereact/button';
import { Dialog } from 'primereact/dialog';
import { Dropdown } from 'primereact/dropdown';
import { InputNumber } from 'primereact/inputnumber';
import { InputText } from 'primereact/inputtext';
import { ProgressBar } from 'primereact/progressbar';
import { Slider } from 'primereact/slider';
import { Tag } from 'primereact/tag';
import { Message } from 'primereact/message';
import { api } from '../api/client';
import MetadataSelectionDialog from './MetadataSelectionDialog';
import CdMetadataDialog from './CdMetadataDialog';
import { CD_FORMATS, CD_FORMAT_SCHEMAS, getDefaultFormatOptions } from '../config/cdFormatSchemas';
import { getStatusLabel, getStatusSeverity } from '../utils/statusPresentation';
import { confirmModal } from '../utils/confirmModal';

const VIDEO_OUTPUT_FORMATS = [
  { label: 'MKV', value: 'mkv' },
  { label: 'MP4', value: 'mp4' },
  { label: 'M4V', value: 'm4v' }
];

// ── Shared helpers (mirrored from CdRipConfigPanel) ───────────────────────────

function normalizeTrackText(value) {
  return String(value || '')
    .normalize('NFC')
    .replace(/[♥❤♡❥❣❦❧]/gu, ' ')
    .replace(/\p{C}+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isFieldVisible(field, values) {
  if (!field.showWhen) return true;
  return values[field.showWhen.field] === field.showWhen.value;
}

function FormatField({ field, value, onChange }) {
  if (field.type === 'slider') {
    return (
      <div className="cd-format-field">
        <label>{field.label}: <strong>{value}</strong></label>
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

function normalizeScriptId(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : null;
}

function normalizeChainId(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : null;
}

function normalizeIdList(values, kind = 'script') {
  const list = Array.isArray(values) ? values : [];
  const seen = new Set();
  const output = [];
  for (const value of list) {
    const normalized = kind === 'chain' ? normalizeChainId(value) : normalizeScriptId(value);
    if (normalized === null) continue;
    const key = String(normalized);
    if (seen.has(key)) continue;
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
      if (type !== 'script' && type !== 'chain') return null;
      const id = type === 'chain'
        ? normalizeChainId(item?.id ?? item?.chainId)
        : normalizeScriptId(item?.id ?? item?.scriptId);
      if (!id) return null;
      return { type, id };
    })
    .filter(Boolean);
  if (fromExplicit.length > 0) return fromExplicit;
  const scriptIds = normalizeIdList(source[`${prefix}EncodeScriptIds`], 'script');
  const chainIds = normalizeIdList(source[`${prefix}EncodeChainIds`], 'chain');
  return [
    ...scriptIds.map((id) => ({ type: 'script', id })),
    ...chainIds.map((id) => ({ type: 'chain', id }))
  ];
}


function normalizeTrackStageStatus(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (raw === 'done' || raw === 'complete' || raw === 'completed' || raw === 'ok' || raw === 'success') return 'done';
  if (raw === 'in_progress' || raw === 'running' || raw === 'active' || raw === 'processing') return 'in_progress';
  if (raw === 'error' || raw === 'failed' || raw === 'cancelled' || raw === 'aborted') return 'error';
  return 'pending';
}

function trackStatusTagMeta(value) {
  const normalized = normalizeTrackStageStatus(value);
  if (normalized === 'done') return { label: 'Fertig', severity: 'success' };
  if (normalized === 'in_progress') return { label: 'Läuft', severity: 'info' };
  if (normalized === 'error') return { label: 'Fehler', severity: 'danger' };
  return { label: 'Offen', severity: 'secondary' };
}

// ── Helper: derive audio tracks from plan ─────────────────────────────────────

function deriveAudioTracks(plan) {
  if (Array.isArray(plan?.inputPaths) && plan.inputPaths.length > 0) {
    return plan.inputPaths.map((p, i) => ({
      position: i + 1,
      filePath: p,
      defaultTitle: p.split('/').pop().replace(/\.[^.]+$/, '')
    }));
  }
  const p = plan?.inputPath || '';
  if (p && !plan?.isFolder) {
    return [{ position: 1, filePath: p, defaultTitle: p.split('/').pop().replace(/\.[^.]+$/, '') }];
  }
  return [];
}

function normalizePositiveInt(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return Math.trunc(parsed);
}

function buildVideoMetadataPayload(sourceMetadata, fallbackTitle = '') {
  const source = sourceMetadata && typeof sourceMetadata === 'object' ? sourceMetadata : {};
  const normalized = {
    title: String(source?.title || fallbackTitle || '').trim() || null,
    year: Number.isFinite(Number(source?.year)) ? Math.trunc(Number(source.year)) : null,
    imdbId: String(source?.imdbId || '').trim() || null,
    poster: String(source?.poster || '').trim() || null
  };

  const metadataProvider = String(source?.metadataProvider || '').trim() || null;
  const workflowKind = String(source?.workflowKind || '').trim() || null;
  const providerId = String(source?.providerId || '').trim() || null;
  const metadataKind = String(source?.metadataKind || '').trim() || null;
  const seasonName = String(source?.seasonName || '').trim() || null;
  const imdbRating = String(source?.imdbRating || '').trim() || null;
  const tmdbId = normalizePositiveInt(source?.tmdbId);
  const seasonNumber = normalizePositiveInt(source?.seasonNumber);
  const discNumber = normalizePositiveInt(source?.discNumber);
  const episodeCount = Number(source?.episodeCount || 0);
  const voteAverageRaw = Number(source?.voteAverage || 0);
  const voteAverage = Number.isFinite(voteAverageRaw) && voteAverageRaw > 0
    ? Number(voteAverageRaw.toFixed(1))
    : null;
  const episodes = Array.isArray(source?.episodes) ? source.episodes : [];
  const tmdbDetails = source?.tmdbDetails && typeof source.tmdbDetails === 'object' && !Array.isArray(source.tmdbDetails)
    ? source.tmdbDetails
    : null;

  if (metadataProvider) normalized.metadataProvider = metadataProvider;
  if (workflowKind) normalized.workflowKind = workflowKind;
  if (providerId) normalized.providerId = providerId;
  if (metadataKind) normalized.metadataKind = metadataKind;
  if (tmdbId) normalized.tmdbId = tmdbId;
  if (seasonNumber) normalized.seasonNumber = seasonNumber;
  if (seasonName) normalized.seasonName = seasonName;
  if (discNumber) normalized.discNumber = discNumber;
  if (Number.isFinite(episodeCount) && episodeCount > 0) normalized.episodeCount = Math.trunc(episodeCount);
  if (episodes.length > 0) normalized.episodes = episodes;
  if (voteAverage !== null) normalized.voteAverage = voteAverage;
  if (imdbRating) normalized.imdbRating = imdbRating;
  if (tmdbDetails) normalized.tmdbDetails = tmdbDetails;

  return normalized;
}

// ── Status helpers ────────────────────────────────────────────────────────────

function mediaTypeBadge(type) {
  const map = {
    video: { label: 'Video', severity: 'info' },
    audio: { label: 'Audio', severity: 'success' },
    iso:   { label: 'ISO', severity: 'warning' }
  };
  const m = map[type] || { label: type || '?', severity: 'secondary' };
  return <Tag value={m.label} severity={m.severity} style={{ fontSize: 11 }} />;
}

function isActiveStatus(status) {
  return ['ANALYZING', 'RIPPING', 'ENCODING', 'MEDIAINFO_CHECK'].includes(String(status || '').toUpperCase());
}

function isTerminal(status) {
  return ['DONE', 'FINISHED', 'ERROR', 'CANCELLED'].includes(String(status || '').toUpperCase());
}

// ── Inline-Konfiguration ──────────────────────────────────────────────────────

function InlineConfig({ job, plan, onStarted, onDeleted, onCancelled, onInputsChanged }) {
  const converterMediaType = plan?.converterMediaType || 'video';
  const isVideo = converterMediaType === 'video' || converterMediaType === 'iso';
  const isAudio = converterMediaType === 'audio';
  const planMetadata = plan?.metadata && typeof plan.metadata === 'object' ? plan.metadata : {};
  const planTracks = Array.isArray(plan?.tracks) ? plan.tracks : [];
  const planMusicBrainz = plan?.musicBrainz && typeof plan.musicBrainz === 'object' ? plan.musicBrainz : {};

  // ── Format state ────────────────────────────────────────────────────────────
  const audioFormatValues = new Set(CD_FORMATS.map((e) => e.value));
  const videoFormatValues = new Set(VIDEO_OUTPUT_FORMATS.map((e) => e.value));
  const initialOutputFormat = String(plan?.outputFormat || (isAudio ? 'flac' : 'mkv')).trim().toLowerCase();
  const [outputFormat, setOutputFormat] = useState(
    isAudio
      ? (audioFormatValues.has(initialOutputFormat) ? initialOutputFormat : 'flac')
      : (videoFormatValues.has(initialOutputFormat) ? initialOutputFormat : 'mkv')
  );
  const [audioFormatOptions, setAudioFormatOptions] = useState(() => ({
    ...getDefaultFormatOptions(initialOutputFormat),
    ...(plan?.audioFormatOptions && typeof plan.audioFormatOptions === 'object' ? plan.audioFormatOptions : {})
  }));

  // Sync format options defaults when format changes
  useEffect(() => {
    if (!isAudio) return;
    setAudioFormatOptions((prev) => ({
      ...getDefaultFormatOptions(outputFormat),
      ...prev
    }));
  }, [outputFormat, isAudio]);

  // ── Video presets ───────────────────────────────────────────────────────────
  const [userPresets, setUserPresets] = useState([]);
  const [hbPresets, setHbPresets] = useState([]);
  const [selectedUserPreset, setSelectedUserPreset] = useState(
    Number.isFinite(Number(plan?.userPreset?.id)) ? Math.trunc(Number(plan.userPreset.id)) : null
  );
  const [selectedHbPreset, setSelectedHbPreset] = useState(
    String(plan?.userPreset?.handbrakePreset || '').trim()
  );

  // ── Audio tracks ────────────────────────────────────────────────────────────
  const audioTrackInputPathsKey = Array.isArray(plan?.inputPaths) ? plan.inputPaths.join('|') : '';
  const audioTracks = useMemo(
    () => deriveAudioTracks(plan),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [plan?.inputPath, plan?.isFolder, audioTrackInputPathsKey]
  );

  // ── Audio metadata ──────────────────────────────────────────────────────────
  const [albumTitle, setAlbumTitle] = useState(
    String(planMetadata?.albumTitle || job.title || job.detected_title || '').trim()
  );
  const [albumArtist, setAlbumArtist] = useState(String(planMetadata?.albumArtist || '').trim());
  const [albumYear, setAlbumYear] = useState(() => {
    const y = Number(planMetadata?.albumYear);
    return Number.isFinite(y) ? Math.trunc(y) : null;
  });
  const [coverUrl, setCoverUrl] = useState(
    String(planMetadata?.coverUrl || job?.poster_url || '').trim() || null
  );
  const [trackFields, setTrackFields] = useState(() => {
    const map = {};
    for (const { position, defaultTitle } of audioTracks) {
      const savedTrack = planTracks.find((t) => Number(t?.position) === Number(position)) || {};
      map[position] = {
        title: String(savedTrack?.title || defaultTitle || '').trim(),
        artist: String(savedTrack?.artist || '').trim()
      };
    }
    return map;
  });

  // ── MusicBrainz ─────────────────────────────────────────────────────────────
  const [selectedMb, setSelectedMb] = useState(
    planMusicBrainz?.selected && typeof planMusicBrainz.selected === 'object'
      ? planMusicBrainz.selected
      : null
  );
  const [mbQuery] = useState(String(planMusicBrainz?.query || '').trim());
  const [mbResults] = useState(Array.isArray(planMusicBrainz?.results) ? planMusicBrainz.results : []);

  // ── Video metadata ──────────────────────────────────────────────────────────
  const [videoMetadata, setVideoMetadata] = useState(() => ({
    ...buildVideoMetadataPayload(
      planMetadata,
      String(job.title || job.detected_title || '').trim()
    )
  }));

  // ── Script / Chain catalog ──────────────────────────────────────────────────
  const [scriptCatalog, setScriptCatalog] = useState([]);
  const [chainCatalog, setChainCatalog] = useState([]);
  const [preItems, setPreItems] = useState(() => buildEncodeItemsFromConfig(plan, 'pre'));
  const [postItems, setPostItems] = useState(() => buildEncodeItemsFromConfig(plan, 'post'));

  useEffect(() => {
    if (!isAudio) return;
    let cancelled = false;
    const loadCatalog = async () => {
      try {
        const [scriptsRes, chainsRes] = await Promise.allSettled([api.getScripts(), api.getScriptChains()]);
        if (cancelled) return;
        setScriptCatalog(
          scriptsRes.status === 'fulfilled'
            ? (Array.isArray(scriptsRes.value?.scripts) ? scriptsRes.value.scripts : []).map((s) => ({ id: s.id, name: s.name }))
            : []
        );
        setChainCatalog(
          chainsRes.status === 'fulfilled'
            ? (Array.isArray(chainsRes.value?.chains) ? chainsRes.value.chains : []).map((c) => ({ id: c.id, name: c.name }))
            : []
        );
      } catch {
        if (!cancelled) { setScriptCatalog([]); setChainCatalog([]); }
      }
    };
    void loadCatalog();
    return () => { cancelled = true; };
  }, [isAudio]);

  // ── Misc state ──────────────────────────────────────────────────────────────
  const [metadataDialogVisible, setMetadataDialogVisible] = useState(false);
  const [cdMetadataDialogVisible, setCdMetadataDialogVisible] = useState(false);
  const [searchDialogBusy, setSearchDialogBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [draftSaving, setDraftSaving] = useState(false);
  const [draftError, setDraftError] = useState(null);
  const saveTimeoutRef = useRef(null);
  const initializedRef = useRef(false);
  const latestSavedRef = useRef(null);

  // ── Video presets loader ────────────────────────────────────────────────────
  useEffect(() => {
    if (!isVideo) return;
    api.getUserPresets?.('video')
      .then((d) => setUserPresets(Array.isArray(d?.presets) ? d.presets : []))
      .catch(() => setUserPresets([]));
    api.getHandBrakePresets?.()
      .then((d) => setHbPresets(Array.isArray(d?.presets) ? d.presets : []))
      .catch(() => setHbPresets([]));
  }, [isVideo]);

  // ── Sync trackFields when audioTracks change ────────────────────────────────
  useEffect(() => {
    if (!isAudio || audioTracks.length === 0) return;
    setTrackFields((prev) => {
      const next = {};
      for (const { position, defaultTitle } of audioTracks) {
        const savedTrack = planTracks.find((t) => Number(t?.position) === Number(position)) || {};
        const existing = prev[position] || null;
        next[position] = {
          title: String(existing?.title || savedTrack?.title || defaultTitle || '').trim(),
          artist: String(existing?.artist || savedTrack?.artist || '').trim()
        };
      }
      const prevKeys = Object.keys(prev);
      const nextKeys = Object.keys(next);
      if (prevKeys.length === nextKeys.length) {
        const equal = nextKeys.every((key) => (
          String(prev[key]?.title || '') === String(next[key]?.title || '')
          && String(prev[key]?.artist || '') === String(next[key]?.artist || '')
        ));
        if (equal) return prev;
      }
      return next;
    });
  }, [isAudio, audioTracks, planTracks]);

  // ── Draft payload ───────────────────────────────────────────────────────────
  const draftPayload = useMemo(() => {
    let userPreset = null;
    if (selectedUserPreset) {
      const preset = userPresets.find((p) => Number(p?.id) === Number(selectedUserPreset));
      userPreset = preset
        ? { id: preset.id, handbrakePreset: preset.handbrake_preset || null, extraArgs: preset.extra_args || '' }
        : { id: selectedUserPreset };
    } else if (selectedHbPreset) {
      userPreset = { handbrakePreset: selectedHbPreset, extraArgs: '' };
    }

    const tracks = isAudio
      ? audioTracks.map(({ position, defaultTitle }) => {
          const f = trackFields[position] || {};
          return {
            position,
            title: String(f.title || defaultTitle || '').trim() || defaultTitle || `Track ${position}`,
            artist: String(f.artist || '').trim() || null
          };
        })
      : null;

    const metadata = isAudio
      ? {
          albumTitle: String(albumTitle || '').trim() || job.detected_title || '',
          albumArtist: String(albumArtist || '').trim() || null,
          albumYear: Number.isFinite(Number(albumYear)) ? Math.trunc(Number(albumYear)) : null,
          mbId: selectedMb?.mbId || null,
          coverUrl: coverUrl || null
        }
      : {
          ...buildVideoMetadataPayload(
            videoMetadata,
            String(job.title || job.detected_title || '').trim()
          )
        };

    return {
      converterMediaType,
      outputFormat,
      userPreset,
      audioFormatOptions: isAudio ? audioFormatOptions : null,
      metadata,
      tracks,
      musicBrainz: isAudio
        ? { query: mbQuery, selected: selectedMb || null, results: Array.isArray(mbResults) ? mbResults.slice(0, 50) : [] }
        : null,
      preEncodeItems: isAudio ? preItems : null,
      postEncodeItems: isAudio ? postItems : null
    };
  }, [
    selectedUserPreset, selectedHbPreset, userPresets, isAudio, audioTracks, trackFields,
    albumTitle, albumArtist, albumYear, coverUrl, selectedMb, converterMediaType, outputFormat,
    audioFormatOptions, mbQuery, mbResults, job.detected_title, job.title, videoMetadata,
    preItems, postItems
  ]);

  const draftSerialized = useMemo(() => JSON.stringify(draftPayload), [draftPayload]);

  useEffect(() => {
    if (!initializedRef.current) {
      initializedRef.current = true;
      latestSavedRef.current = draftSerialized;
      return;
    }
    if (busy || draftSerialized === latestSavedRef.current) return;
    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    saveTimeoutRef.current = setTimeout(async () => {
      setDraftSaving(true);
      setDraftError(null);
      try {
        await api.converterUpdateJobConfig(job.id, draftPayload);
        latestSavedRef.current = draftSerialized;
      } catch (err) {
        setDraftError(err?.message || 'Draft konnte nicht gespeichert werden.');
      } finally {
        setDraftSaving(false);
      }
    }, 650);
    return () => {
      if (saveTimeoutRef.current) { clearTimeout(saveTimeoutRef.current); saveTimeoutRef.current = null; }
    };
  }, [busy, draftPayload, draftSerialized, job.id]);

  // ── Dialog contexts ─────────────────────────────────────────────────────────
  const metadataDialogContext = useMemo(() => ({
    jobId: job.id,
    detectedTitle: videoMetadata?.title || job.title || job.detected_title || '',
    selectedMetadata: {
      ...videoMetadata,
      title: videoMetadata?.title || job.title || job.detected_title || '',
      year: videoMetadata?.year || null,
      imdbId: videoMetadata?.imdbId || null,
      poster: videoMetadata?.poster || null
    },
    metadataCandidates: []
  }), [job.id, job.title, job.detected_title, videoMetadata]);

  const cdMetadataDialogContext = useMemo(() => ({
    jobId: job.id,
    tracks: audioTracks.map(({ position, defaultTitle }) => ({
      position,
      title: String(trackFields[position]?.title || defaultTitle || '').trim() || `Track ${position}`,
      artist: String(trackFields[position]?.artist || '').trim() || null
    }))
  }), [job.id, audioTracks, trackFields]);

  // ── Dialog handlers ─────────────────────────────────────────────────────────
  const handleMetadataSearch = async (query, options = {}) => {
    try {
      const filterRaw = String(options?.resultFilter || '').trim().toLowerCase();
      const includeMovies = filterRaw !== 'series';
      const includeSeries = filterRaw !== 'movies' && filterRaw !== 'movie';
      const [movieResponse, seriesResponse] = await Promise.all([
        includeMovies ? api.searchTmdbMovie(query) : Promise.resolve({ results: [] }),
        includeSeries ? api.searchTmdbSeries(query) : Promise.resolve({ results: [] })
      ]);
      const movieRows = Array.isArray(movieResponse?.results)
        ? movieResponse.results.map((row) => ({
          ...row,
          workflowKind: 'film',
          metadataKind: 'movie',
          resultType: 'movie'
        }))
        : [];
      const seriesRows = Array.isArray(seriesResponse?.results)
        ? seriesResponse.results.map((row) => ({
          ...row,
          workflowKind: 'series',
          metadataKind: String(row?.metadataKind || '').trim().toLowerCase() || 'series',
          resultType: 'series'
        }))
        : [];
      return [...movieRows, ...seriesRows];
    } catch { return []; }
  };

  const handleMetadataSubmit = async (payload) => {
    setSearchDialogBusy(true);
    try {
      setVideoMetadata(buildVideoMetadataPayload(payload, String(job.title || job.detected_title || '').trim()));
      setMetadataDialogVisible(false);
    } finally {
      setSearchDialogBusy(false);
    }
  };

  const handleMusicBrainzSearchDialog = async (query, options = {}) => {
    try {
      const response = await api.searchMusicBrainz(query, {
        trackCount: Number(options?.trackCount || 0) > 0 ? Math.trunc(Number(options.trackCount)) : null
      });
      return Array.isArray(response?.results) ? response.results : [];
    } catch { return []; }
  };

  const handleMusicBrainzReleaseFetch = async (mbId) => {
    try {
      const response = await api.getMusicBrainzRelease(mbId);
      return response?.release || null;
    } catch { return null; }
  };

  const handleCdMetadataSubmit = async (payload) => {
    setSearchDialogBusy(true);
    try {
      const title = String(payload?.title || '').trim();
      const artist = String(payload?.artist || '').trim();
      const year = Number(payload?.year);
      const tracks = Array.isArray(payload?.tracks) ? payload.tracks : [];
      if (title) setAlbumTitle(title);
      setAlbumArtist(artist);
      setAlbumYear(Number.isFinite(year) ? Math.trunc(year) : null);
      setSelectedMb(payload?.mbId ? {
        mbId: payload.mbId,
        title: title || null,
        artist: artist || null,
        year: Number.isFinite(year) ? Math.trunc(year) : null
      } : null);
      setCoverUrl(String(payload?.coverUrl || '').trim() || null);
      if (tracks.length > 0) {
        setTrackFields((prev) => {
          const next = { ...prev };
          tracks.forEach((track, index) => {
            const position = Number.isFinite(Number(track?.position)) && Number(track.position) > 0
              ? Math.trunc(Number(track.position))
              : (index + 1);
            next[position] = {
              title: String(track?.title || next[position]?.title || `Track ${position}`).trim(),
              artist: String(track?.artist || next[position]?.artist || '').trim()
            };
          });
          return next;
        });
      }
      setCdMetadataDialogVisible(false);
    } finally {
      setSearchDialogBusy(false);
    }
  };

  // ── Track field handlers ────────────────────────────────────────────────────
  const handleTrackField = (position, key, value) => {
    setTrackFields((prev) => ({ ...prev, [position]: { ...(prev[position] || {}), [key]: value } }));
  };

  const handleDeleteTrack = async (filePath) => {
    try {
      await api.converterRemoveInputFromJob(job.id, filePath);
      onInputsChanged?.(job.id);
    } catch (err) {
      // silently ignore — UI will refresh via onInputsChanged
    }
  };

  // ── Encode item handlers ────────────────────────────────────────────────────
  const moveItem = (phase, index, direction) => {
    const updater = phase === 'post' ? setPostItems : setPreItems;
    updater((prev) => {
      const list = Array.isArray(prev) ? [...prev] : [];
      const from = Number(index);
      const to = from + (direction === 'up' ? -1 : 1);
      if (!Number.isInteger(from) || from < 0 || from >= list.length || to < 0 || to >= list.length) return list;
      const [moved] = list.splice(from, 1);
      list.splice(to, 0, moved);
      return list;
    });
  };

  const addItem = (phase, type) => {
    const normalizedType = type === 'chain' ? 'chain' : 'script';
    const updater = phase === 'post' ? setPostItems : setPreItems;
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
      if (candidate === undefined || candidate === null) return current;
      return [...current, { type: normalizedType, id: candidate }];
    });
  };

  const changeItem = (phase, index, type, nextId) => {
    const normalizedType = type === 'chain' ? 'chain' : 'script';
    const normalizedId = normalizedType === 'chain' ? normalizeChainId(nextId) : normalizeScriptId(nextId);
    if (normalizedId === null) return;
    const updater = phase === 'post' ? setPostItems : setPreItems;
    updater((prev) => {
      const current = Array.isArray(prev) ? prev : [];
      const rowIndex = Number(index);
      if (!Number.isInteger(rowIndex) || rowIndex < 0 || rowIndex >= current.length) return current;
      const duplicate = current.some((item, itemIndex) => {
        if (itemIndex === rowIndex) return false;
        if (item?.type !== normalizedType) return false;
        const existingId = normalizedType === 'chain' ? normalizeChainId(item?.id) : normalizeScriptId(item?.id);
        return existingId !== null && String(existingId) === String(normalizedId);
      });
      if (duplicate) return current;
      const next = [...current];
      next[rowIndex] = { type: normalizedType, id: normalizedId };
      return next;
    });
  };

  const removeItem = (phase, index) => {
    const updater = phase === 'post' ? setPostItems : setPreItems;
    updater((prev) => {
      const current = Array.isArray(prev) ? prev : [];
      const rowIndex = Number(index);
      if (!Number.isInteger(rowIndex) || rowIndex < 0 || rowIndex >= current.length) return current;
      return current.filter((_, itemIndex) => itemIndex !== rowIndex);
    });
  };

  // ── Start handler ───────────────────────────────────────────────────────────
  const handleStart = async () => {
    setBusy(true);
    setError(null);
    try {
      let userPreset = null;
      if (selectedUserPreset) {
        const found = userPresets.find((p) => p.id === selectedUserPreset);
        if (found) userPreset = { id: found.id, handbrakePreset: found.handbrake_preset || null, extraArgs: found.extra_args || '' };
      } else if (selectedHbPreset) {
        userPreset = { handbrakePreset: selectedHbPreset, extraArgs: '' };
      }

      const tracks = isAudio
        ? audioTracks.map(({ position, defaultTitle }) => {
            const f = trackFields[position] || {};
            return {
              position,
              title: (f.title || '').trim() || defaultTitle,
              artist: (f.artist || '').trim() || albumArtist.trim() || null
            };
          })
        : undefined;

      const metadata = isAudio
        ? {
            albumTitle: albumTitle.trim() || job.detected_title || '',
            albumArtist: albumArtist.trim() || null,
            albumYear: albumYear || null,
            mbId: selectedMb?.mbId || null,
            coverUrl: coverUrl || null
          }
        : {
            ...buildVideoMetadataPayload(
              videoMetadata,
              String(job.title || job.detected_title || '').trim()
            )
          };

      await api.startConverterJob(job.id, {
        converterMediaType,
        outputFormat,
        userPreset,
        audioFormatOptions: isAudio ? audioFormatOptions : null,
        metadata,
        tracks,
        preEncodeItems: isAudio ? preItems : null,
        postEncodeItems: isAudio ? postItems : null
      });

      onStarted?.(job.id);
    } catch (err) {
      setError(err.message || 'Fehler beim Starten.');
      setBusy(false);
    }
  };

  // ── Format fields (audio) ───────────────────────────────────────────────────
  const audioSchema = CD_FORMAT_SCHEMAS[outputFormat] || { fields: [] };
  const visibleAudioFields = audioSchema.fields.filter((f) => isFieldVisible(f, audioFormatOptions));

  // ── Encode item section renderer ────────────────────────────────────────────
  const renderEncodeSection = (phase, items) => {
    const label = phase === 'post' ? 'Post-Rip Ausführungen (optional)' : 'Pre-Rip Ausführungen (optional)';
    const hint = phase === 'post'
      ? 'Ausführung nach erfolgreichem Rippen/Encodieren, strikt nacheinander.'
      : 'Ausführung vor dem Rippen, strikt nacheinander. Bei Fehler wird der CD-Rip abgebrochen.';

    return (
      <div className="post-script-box">
        <h4>{label}</h4>
        {scriptCatalog.length === 0 && chainCatalog.length === 0 ? (
          <small>Keine Skripte oder Ketten konfiguriert. In den Settings anlegen.</small>
        ) : null}
        {items.length === 0 ? (
          <small>Keine {phase === 'post' ? 'Post' : 'Pre'}-Rip Ausführungen ausgewählt.</small>
        ) : null}
        {items.map((item, rowIndex) => {
          const isScript = item?.type === 'script';
          const usedScriptIds = new Set(
            items.filter((e, i) => e?.type === 'script' && i !== rowIndex)
              .map((e) => normalizeScriptId(e?.id)).filter((id) => id !== null).map((id) => String(id))
          );
          const usedChainIds = new Set(
            items.filter((e, i) => e?.type === 'chain' && i !== rowIndex)
              .map((e) => normalizeChainId(e?.id)).filter((id) => id !== null).map((id) => String(id))
          );
          const scriptOptions = scriptCatalog.map((e) => ({
            label: e?.name || `Skript #${e?.id}`,
            value: normalizeScriptId(e?.id),
            disabled: usedScriptIds.has(String(normalizeScriptId(e?.id)))
          })).filter((e) => e.value !== null);
          const chainOptions = chainCatalog.map((e) => ({
            label: e?.name || `Kette #${e?.id}`,
            value: normalizeChainId(e?.id),
            disabled: usedChainIds.has(String(normalizeChainId(e?.id)))
          })).filter((e) => e.value !== null);
          return (
            <div key={`${phase}-${rowIndex}-${item?.type}-${item?.id}`} className="post-script-row editable">
              <i className={`post-script-type-icon pi ${isScript ? 'pi-code' : 'pi-link'}`} title={isScript ? 'Skript' : 'Kette'} />
              <div className="cd-encode-item-order">
                <Button icon="pi pi-angle-up" severity="secondary" text rounded onClick={() => moveItem(phase, rowIndex, 'up')} disabled={busy || rowIndex <= 0} />
                <Button icon="pi pi-angle-down" severity="secondary" text rounded onClick={() => moveItem(phase, rowIndex, 'down')} disabled={busy || rowIndex >= items.length - 1} />
              </div>
              {isScript ? (
                <Dropdown
                  value={normalizeScriptId(item?.id)}
                  options={scriptOptions}
                  optionLabel="label" optionValue="value" optionDisabled="disabled"
                  onChange={(e) => changeItem(phase, rowIndex, 'script', e.value)}
                  className="full-width" disabled={busy}
                />
              ) : (
                <Dropdown
                  value={normalizeChainId(item?.id)}
                  options={chainOptions}
                  optionLabel="label" optionValue="value" optionDisabled="disabled"
                  onChange={(e) => changeItem(phase, rowIndex, 'chain', e.value)}
                  className="full-width" disabled={busy}
                />
              )}
              <Button icon="pi pi-times" severity="danger" outlined onClick={() => removeItem(phase, rowIndex)} disabled={busy} />
            </div>
          );
        })}
        <div className="actions-row">
          {scriptCatalog.length > items.filter((e) => e?.type === 'script').length ? (
            <Button label="Skript hinzufügen" icon="pi pi-code" severity="secondary" outlined onClick={() => addItem(phase, 'script')} disabled={busy} />
          ) : null}
          {chainCatalog.length > items.filter((e) => e?.type === 'chain').length ? (
            <Button label="Kette hinzufügen" icon="pi pi-link" severity="secondary" outlined onClick={() => addItem(phase, 'chain')} disabled={busy} />
          ) : null}
        </div>
        <small>{hint}</small>
      </div>
    );
  };

  // ── Render ──────────────────────────────────────────────────────────────────
  if (isAudio) {
    return (
      <div className="cd-rip-config-panel">
        {error && <Message severity="error" text={error} style={{ marginBottom: 10, width: '100%' }} />}

        <h4 style={{ marginTop: 0, marginBottom: '0.75rem' }}>Converter Konfiguration</h4>

        {/* Album-Metadaten */}
        <div className="cd-meta-summary">
          <strong>Album-Metadaten</strong>
          {coverUrl && (
            <div className="cd-media-meta-layout" style={{ marginTop: '0.55rem' }}>
              <div className="cd-cover-wrap">
                <img src={coverUrl} alt={albumTitle || 'Cover'} className="cd-cover-image" />
              </div>
            </div>
          )}
          <div className="metadata-grid" style={{ marginTop: '0.55rem' }}>
            <InputText
              value={normalizeTrackText(albumTitle)}
              onChange={(e) => setAlbumTitle(e.target.value)}
              placeholder="Album"
              disabled={busy}
            />
            <InputText
              value={normalizeTrackText(albumArtist)}
              onChange={(e) => setAlbumArtist(e.target.value)}
              placeholder="Interpret"
              disabled={busy}
            />
            <InputNumber
              value={albumYear}
              onValueChange={(e) => setAlbumYear(e.value || null)}
              placeholder="Jahr"
              useGrouping={false}
              min={1900} max={2100}
              disabled={busy}
            />
          </div>
        </div>

        {/* Ausgabeformat */}
        <div className="cd-format-field">
          <label>Ausgabeformat</label>
          <Dropdown
            value={outputFormat}
            options={CD_FORMATS}
            optionLabel="label"
            optionValue="value"
            onChange={(e) => setOutputFormat(e.value)}
            disabled={busy}
          />
        </div>

        {/* Format-spezifische Felder */}
        {visibleAudioFields.map((field) => (
          <FormatField
            key={field.key}
            field={field}
            value={audioFormatOptions[field.key] ?? field.default}
            onChange={(key, value) => setAudioFormatOptions((prev) => ({ ...prev, [key]: value }))}
          />
        ))}

        {/* Track-Auswahl */}
        {audioTracks.length > 0 && (
          <div className="cd-track-selection">
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '0.5rem' }}>
              <strong>Tracks ({audioTracks.length})</strong>
            </div>
            <div className="cd-track-list">
              <table className="cd-track-table">
                <thead>
                  <tr>
                    <th className="check"></th>
                    <th className="num">Nr</th>
                    <th className="artist">Interpret</th>
                    <th className="title">Titel</th>
                    <th className="duration">Länge</th>
                  </tr>
                </thead>
                <tbody>
                  {audioTracks.map(({ position, filePath, defaultTitle }) => {
                    const f = trackFields[position] || {};
                    return (
                      <tr key={position} className="selected">
                        <td className="check">
                          <Button
                            icon="pi pi-trash"
                            severity="danger"
                            text
                            rounded
                            size="small"
                            onClick={() => handleDeleteTrack(filePath)}
                            disabled={busy}
                            title="Track entfernen"
                          />
                        </td>
                        <td className="num">{String(position).padStart(2, '0')}</td>
                        <td className="artist">
                          <InputText
                            value={normalizeTrackText(f.artist)}
                            onChange={(e) => handleTrackField(position, 'artist', e.target.value)}
                            placeholder={normalizeTrackText(albumArtist) || 'Interpret'}
                            disabled={busy}
                          />
                        </td>
                        <td className="title">
                          <InputText
                            value={normalizeTrackText(f.title) || defaultTitle}
                            onChange={(e) => handleTrackField(position, 'title', e.target.value)}
                            placeholder={defaultTitle}
                            disabled={busy}
                          />
                        </td>
                        <td className="duration">-</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {plan?.isFolder && audioTracks.length === 0 && (
          <p style={{ margin: '8px 0 0', color: 'var(--rip-muted)', fontSize: '0.82rem' }}>
            Track-Liste wird beim Start aus dem Ordner gelesen.
          </p>
        )}

        {/* Pre / Post Ausführungen */}
        <div className="encode-automation-grid">
          {renderEncodeSection('pre', preItems)}
          {renderEncodeSection('post', postItems)}
        </div>

        {/* Aktionen */}
        <div className="actions-row" style={{ marginTop: '1rem' }}>
          <Button
            label="Metadaten ändern"
            icon="pi pi-pencil"
            severity="secondary"
            outlined
            onClick={() => setCdMetadataDialogVisible(true)}
            disabled={busy}
          />
          <Button
            label="Job löschen"
            icon="pi pi-trash"
            severity="danger"
            outlined
            onClick={() => onDeleted?.(job.id)}
            disabled={busy}
          />
          <Button
            label="Encode starten"
            icon={busy ? 'pi pi-spin pi-spinner' : 'pi pi-play'}
            onClick={handleStart}
            loading={busy}
            disabled={audioTracks.length === 0}
          />
        </div>

        {draftError && (
          <small style={{ color: 'var(--red-600)', display: 'block', marginTop: 6 }}>{draftError}</small>
        )}
        {!draftError && (
          <small style={{ color: 'var(--text-color-secondary)', display: 'block', marginTop: 6 }}>
            {draftSaving ? 'Speichere Entwurf …' : 'Entwurf gespeichert'}
          </small>
        )}

        <CdMetadataDialog
          visible={cdMetadataDialogVisible}
          context={cdMetadataDialogContext}
          onHide={() => setCdMetadataDialogVisible(false)}
          onSubmit={handleCdMetadataSubmit}
          onSearch={handleMusicBrainzSearchDialog}
          onFetchRelease={handleMusicBrainzReleaseFetch}
          busy={searchDialogBusy}
        />
      </div>
    );
  }

  // ── Video render (unchanged layout) ─────────────────────────────────────────
  return (
    <div className="cjc-config">
      {error && <Message severity="error" text={error} style={{ marginBottom: 10, width: '100%' }} />}

      {isVideo && (
        <div className="converter-job-card-actions" style={{ marginTop: 0 }}>
          <Button
            label="Metadaten neu zuweisen"
            icon="pi pi-search"
            severity="info"
            outlined
            size="small"
            onClick={() => setMetadataDialogVisible(true)}
            disabled={busy}
          />
        </div>
      )}

      <div className="cjc-config-row">
        <div className="cjc-config-field">
          <label className="cjc-config-label">Medientyp</label>
          <div className="cjc-config-value">
            {mediaTypeBadge(converterMediaType)}
            {converterMediaType === 'iso' && (
              <small style={{ marginLeft: 6, color: 'var(--text-color-secondary)' }}>MakeMKV → HandBrake</small>
            )}
          </div>
        </div>
        <div className="cjc-config-field">
          <label className="cjc-config-label">Ausgabeformat</label>
          <Dropdown
            value={outputFormat}
            options={VIDEO_OUTPUT_FORMATS}
            onChange={(e) => setOutputFormat(e.value)}
            style={{ width: '100%' }}
          />
        </div>
      </div>

      {isVideo && (
        <div className="cjc-config-row">
          <div className="cjc-config-field">
            <label className="cjc-config-label">User-Preset</label>
            <Dropdown
              value={selectedUserPreset}
              options={[
                { label: '— Kein User-Preset —', value: null },
                ...userPresets.map((p) => ({ label: p.name, value: p.id }))
              ]}
              onChange={(e) => { setSelectedUserPreset(e.value); if (e.value) setSelectedHbPreset(''); }}
              style={{ width: '100%' }}
            />
          </div>
          {!selectedUserPreset && (
            <div className="cjc-config-field">
              <label className="cjc-config-label">HandBrake-Preset</label>
              <Dropdown
                value={selectedHbPreset}
                options={[
                  { label: '— Kein Preset (Standard) —', value: '' },
                  ...hbPresets.map((p) => ({ label: p.category ? `[${p.category}] ${p.name}` : p.name, value: p.name }))
                ]}
                onChange={(e) => setSelectedHbPreset(e.value)}
                filter
                placeholder="Preset auswählen …"
                style={{ width: '100%' }}
              />
            </div>
          )}
        </div>
      )}

      <div className="cjc-config-actions">
        {draftError ? (
          <small style={{ color: 'var(--red-600)' }}>{draftError}</small>
        ) : (
          <small style={{ color: 'var(--text-color-secondary)' }}>
            {draftSaving ? 'Speichere Entwurf …' : 'Entwurf gespeichert'}
          </small>
        )}
        <Button
          label="Encoding starten"
          icon={busy ? 'pi pi-spin pi-spinner' : 'pi pi-play'}
          disabled={busy}
          onClick={handleStart}
        />
      </div>

      <MetadataSelectionDialog
        visible={metadataDialogVisible}
        context={metadataDialogContext}
        onHide={() => setMetadataDialogVisible(false)}
        onSubmit={handleMetadataSubmit}
        onSearch={handleMetadataSearch}
        busy={searchDialogBusy}
      />
    </div>
  );
}

// ── Job-Karte ─────────────────────────────────────────────────────────────────

export default function ConverterJobCard({
  job,
  jobProgress,
  isExpanded,
  onExpand,
  onCollapse,
  onStarted,
  onDeleted,
  onCancelled,
  onOpenDetails,
  onInputsChanged
}) {
  const [cancelBusy, setCancelBusy] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteConfirmVisible, setDeleteConfirmVisible] = useState(false);

  const plan = (() => {
    try { return JSON.parse(job.encode_plan_json || '{}'); } catch { return {}; }
  })();

  const jobIdLabel = Number.isFinite(Number(job?.id)) ? `Job #${Math.trunc(Number(job.id))}` : 'Job';
  const ripperTitleId = Number.isFinite(Number(job?.id)) ? `#${Math.trunc(Number(job.id))}` : '#-';
  const customTitle = String(job?.title || '').trim();
  const title = customTitle ? `${ripperTitleId} | ${customTitle}` : ripperTitleId;
  const status = job.status || 'UNKNOWN';
  const statusLabel = getStatusLabel(status);
  const statusSeverity = getStatusSeverity(status);
  const converterMediaType = plan?.converterMediaType;
  const isAudio = converterMediaType === 'audio';
  const active = isActiveStatus(status);
  const terminal = isTerminal(status);
  const isReady = String(status).toUpperCase() === 'READY_TO_START';

  const liveProgress = jobProgress?.progress ?? null;
  const liveEta = jobProgress?.eta || null;
  const liveStatusText = jobProgress?.statusText || null;
  const progressValue = liveProgress !== null ? Math.trunc(liveProgress) : null;

  // ── Audio details (for active/terminal state) ─────────────────────────────
  const audioTracks = isAudio ? deriveAudioTracks(plan) : [];
  const planTracks = Array.isArray(plan?.tracks) ? plan.tracks : [];
  const planMetadata = plan?.metadata && typeof plan.metadata === 'object' ? plan.metadata : {};
  const coverUrl = String(planMetadata?.coverUrl || plan?.musicBrainz?.selected?.coverUrl || job?.poster_url || '').trim() || null;

  const albumTitle = String(planMetadata?.albumTitle || job.title || job.detected_title || '').trim() || '-';
  const albumArtist = String(planMetadata?.albumArtist || '').trim() || '-';
  const albumYear = planMetadata?.albumYear || '-';
  const mbId = String(planMetadata?.mbId || '').trim() || '-';
  const outputFormatLabel = (CD_FORMATS.find((f) => f.value === plan?.outputFormat)?.label) || (plan?.outputFormat ? String(plan.outputFormat).toUpperCase() : '-');
  const outputPath = String(job.output_path || '').trim() || '-';

  // Derive pre/post script names for summary
  const preItems = buildEncodeItemsFromConfig(plan, 'pre');
  const postItems = buildEncodeItemsFromConfig(plan, 'post');
  const preNames = [
    ...(Array.isArray(plan?.preEncodeScripts) ? plan.preEncodeScripts.map((s) => String(s?.name || '').trim()).filter(Boolean) : []),
    ...preItems.filter((i) => i.type === 'script').map((i) => `Skript #${i.id}`)
  ];
  const postNames = [
    ...(Array.isArray(plan?.postEncodeScripts) ? plan.postEncodeScripts.map((s) => String(s?.name || '').trim()).filter(Boolean) : []),
    ...postItems.filter((i) => i.type === 'script').map((i) => `Skript #${i.id}`)
  ];
  const preChainNames = [
    ...(Array.isArray(plan?.preEncodeChains) ? plan.preEncodeChains.map((c) => String(c?.name || '').trim()).filter(Boolean) : []),
    ...preItems.filter((i) => i.type === 'chain').map((i) => `Kette #${i.id}`)
  ];
  const postChainNames = [
    ...(Array.isArray(plan?.postEncodeChains) ? plan.postEncodeChains.map((c) => String(c?.name || '').trim()).filter(Boolean) : []),
    ...postItems.filter((i) => i.type === 'chain').map((i) => `Kette #${i.id}`)
  ];

  const isFinishedOk = terminal && !['ERROR', 'CANCELLED'].includes(String(status).toUpperCase());
  const completedEncodeCount = (() => {
    if (isFinishedOk) return audioTracks.length;
    if (!active || audioTracks.length === 0) return 0;
    // "Audio: N/M — filename" is emitted by the backend at the START of track N.
    // N-1 tracks are done, track N is in progress.
    const statusMatch = liveStatusText?.match(/^Audio:\s*(\d+)\s*\//);
    if (statusMatch) {
      const pos = parseInt(statusMatch[1], 10);
      return Math.max(0, Math.min(audioTracks.length, pos - 1));
    }
    // Fallback: use progress percentage (Math.round avoids floor precision loss)
    if (progressValue !== null) {
      return Math.min(audioTracks.length, Math.round((progressValue / 100) * audioTracks.length));
    }
    return 0;
  })();

  // ── Action handlers ───────────────────────────────────────────────────────
  const handleCancel = async () => {
    const statusUpper = String(status || '').toUpperCase();
    const confirmText = statusUpper === 'READY_TO_START'
      ? `${jobIdLabel} wirklich abbrechen?\nDer Job wird auf "Abgebrochen" gesetzt.`
      : `${jobIdLabel} wirklich abbrechen?`;
    const confirmed = await confirmModal({
      header: 'Job abbrechen',
      message: confirmText,
      acceptLabel: 'Abbrechen',
      rejectLabel: 'Zurück',
      danger: true
    });
    if (!confirmed) return;
    setCancelBusy(true);
    try {
      await api.cancelConverterJob(job.id);
      onCancelled?.(job.id);
    } catch (err) {
      console.error('Cancel error:', err);
    } finally {
      setCancelBusy(false);
    }
  };

  const handleDelete = () => setDeleteConfirmVisible(true);

  const handleDeleteConfirmed = async () => {
    setDeleteConfirmVisible(false);
    setDeleteBusy(true);
    try {
      await api.deleteConverterJob(job.id);
      onDeleted?.(job.id);
    } catch (err) {
      console.error('Delete error:', err);
      window.alert(`Fehler beim Löschen:\n${err?.message || 'Unbekannter Fehler'}`);
    } finally {
      setDeleteBusy(false);
    }
  };

  // ── Eingeklappt ───────────────────────────────────────────────────────────
  if (!isExpanded) {
    const fileCount = Array.isArray(plan?.inputPaths) && plan.inputPaths.length > 0
      ? plan.inputPaths.length
      : null;
    return (
      <button
        type="button"
        className="ripper-job-row"
        onClick={onExpand}
      >
        <div className="poster-thumb ripper-job-poster-fallback">
          {isAudio ? 'Audio' : 'Video'}
        </div>
        <div className="ripper-job-row-content">
          <div className="ripper-job-row-main">
            <strong className="ripper-job-title-line">
              <i className="pi pi-circle-fill media-indicator-icon" style={{ color: 'var(--rip-muted)', fontSize: '0.65rem' }} />
              <span>{title}</span>
            </strong>
            <small>
              {fileCount != null ? `${fileCount} Datei${fileCount !== 1 ? 'en' : ''}` : null}
            </small>
          </div>
          <div className="ripper-job-badges">
            {converterMediaType && mediaTypeBadge(converterMediaType)}
            <Tag value={statusLabel} severity={statusSeverity} />
          </div>
          {active && progressValue !== null && (
            <div className="ripper-job-row-progress">
              <ProgressBar value={progressValue} showValue={false} />
              <small>
                {liveEta ? `${progressValue}% | ETA ${liveEta}` : `${progressValue}%`}
              </small>
            </div>
          )}
        </div>
        <i className="pi pi-angle-down" aria-hidden="true" />
      </button>
    );
  }

  // ── Ausgeklappt ───────────────────────────────────────────────────────────
  return (
    <div className={`ripper-job-expanded converter-job-card status-${status.toLowerCase()}${isReady ? ' is-ready' : ''}`}>
      {/* Header */}
      <div className="ripper-job-expanded-head">
        {job?.poster_url && job.poster_url !== 'N/A' ? (
          <img src={job.poster_url} alt={title} className="poster-thumb" />
        ) : (
          <div className="poster-thumb ripper-job-poster-fallback">Kein Poster</div>
        )}
        <div className="ripper-job-expanded-title">
          <strong className="ripper-job-title-line">
            <i className="pi pi-circle-fill media-indicator-icon" style={{ color: 'var(--rip-muted)', fontSize: '0.65rem' }} />
            <span>{title}</span>
          </strong>
          <div className="ripper-job-badges">
            {converterMediaType && mediaTypeBadge(converterMediaType)}
            <Tag value={statusLabel} severity={statusSeverity} />
          </div>
        </div>
        <Button
          label="Einklappen"
          icon="pi pi-angle-up"
          severity="secondary"
          outlined
          size="small"
          onClick={onCollapse}
        />
      </div>

      {/* READY: Inline-Konfiguration */}
      {isReady && (
        <InlineConfig
          job={job}
          plan={plan}
          onStarted={onStarted}
          onInputsChanged={onInputsChanged}
          onDeleted={handleDelete}
          onCancelled={handleCancel}
        />
      )}

      {/* READY: Aktions-Buttons für Video-Jobs */}
      {isReady && !isAudio && (
        <div className="converter-job-card-actions">
          <Button
            label="Job löschen"
            icon={deleteBusy ? 'pi pi-spin pi-spinner' : 'pi pi-trash'}
            size="small"
            severity="danger"
            outlined
            disabled={deleteBusy}
            onClick={handleDelete}
          />
        </div>
      )}

      {/* ACTIVE / TERMINAL: Details-Ansicht (Audio) */}
      {!isReady && isAudio && (
        <div className="cd-rip-config-panel">
          {/* Fortschritt */}
          {active && (
            <div className="progress-wrap">
              {progressValue !== null ? (
                <ProgressBar value={progressValue} showValue displayValueTemplate={() => `${progressValue}%`} />
              ) : (
                <ProgressBar value={0} showValue displayValueTemplate={() => '0%'} />
              )}
              <small>
                {`Encode fertig: ${completedEncodeCount}/${audioTracks.length}`}
                {liveEta ? ` | ETA ${liveEta}` : ''}
              </small>
              {liveStatusText && <small>{liveStatusText}</small>}
            </div>
          )}

          {/* Aktions-Buttons */}
          {active && (
            <div className="actions-row">
              <Button
                label="Abbrechen"
                icon="pi pi-stop"
                severity="danger"
                onClick={handleCancel}
                disabled={cancelBusy}
              />
              <Button
                label="Job löschen"
                icon="pi pi-trash"
                severity="danger"
                outlined
                onClick={handleDelete}
                disabled={deleteBusy}
              />
            </div>
          )}
          {terminal && (
            <div className="actions-row">
              <Button
                label="Details"
                icon="pi pi-eye"
                size="small"
                severity="secondary"
                outlined
                onClick={() => onOpenDetails?.(job)}
              />
              <Button
                label="Job löschen"
                icon={deleteBusy ? 'pi pi-spin pi-spinner' : 'pi pi-trash'}
                size="small"
                severity="danger"
                outlined
                disabled={deleteBusy}
                onClick={handleDelete}
              />
            </div>
          )}

          {/* CD-Details Zusammenfassung */}
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
                <div><strong>MusicBrainz:</strong> {mbId}</div>
                <div><strong>Status:</strong> {statusLabel}</div>
                <div><strong>Format:</strong> {outputFormatLabel}</div>
                <div><strong>Rip fertig:</strong> {audioTracks.length} / {audioTracks.length}</div>
                <div><strong>Encode fertig:</strong> {completedEncodeCount} / {audioTracks.length}</div>
                <div><strong>Pre-Skripte:</strong> {preNames.length > 0 ? preNames.join(' | ') : '-'}</div>
                <div><strong>Pre-Ketten:</strong> {preChainNames.length > 0 ? preChainNames.join(' | ') : '-'}</div>
                <div><strong>Post-Skripte:</strong> {postNames.length > 0 ? postNames.join(' | ') : '-'}</div>
                <div><strong>Post-Ketten:</strong> {postChainNames.length > 0 ? postChainNames.join(' | ') : '-'}</div>
                <div><strong>Auswahl:</strong> {audioTracks.map((t) => String(t.position).padStart(2, '0')).join(', ') || '-'}</div>
                <div><strong>Gesamtdauer:</strong> -</div>
                <div><strong>Output-Pfad:</strong> {outputPath}</div>
                <div><strong>Job-ID:</strong> #{job.id}</div>
              </div>
            </div>
          </div>

          {/* Zu encodierende Tracks */}
          {audioTracks.length > 0 && (
            <div className="cd-track-selection">
              <strong>Zu encodierende Tracks ({audioTracks.length})</strong>
              <div className="cd-track-list">
                <table className="cd-track-table">
                  <thead>
                    <tr>
                      <th className="num">Nr</th>
                      <th className="artist">Interpret</th>
                      <th className="title">Titel</th>
                      <th className="duration">Länge</th>
                      <th className="status">Rip</th>
                      <th className="status">Encode</th>
                    </tr>
                  </thead>
                  <tbody>
                    {audioTracks.map((track, trackIdx) => {
                      const saved = planTracks.find((t) => Number(t?.position) === track.position);
                      const trackTitle = saved?.title || track.defaultTitle || `Track ${track.position}`;
                      const trackArtist = saved?.artist || (albumArtist !== '-' ? albumArtist : '-');
                      const ripMeta = trackStatusTagMeta('done');
                      let encodeTrackStatus;
                      if (isFinishedOk) {
                        encodeTrackStatus = 'done';
                      } else if (trackIdx < completedEncodeCount) {
                        encodeTrackStatus = 'done';
                      } else if (active && trackIdx === completedEncodeCount) {
                        encodeTrackStatus = 'in_progress';
                      } else {
                        encodeTrackStatus = 'pending';
                      }
                      const encodeMeta = trackStatusTagMeta(encodeTrackStatus);
                      return (
                        <tr key={track.position} className="selected">
                          <td className="num">{String(track.position).padStart(2, '0')}</td>
                          <td className="artist">{trackArtist}</td>
                          <td className="title">{trackTitle}</td>
                          <td className="duration">-</td>
                          <td className="status"><Tag value={ripMeta.label} severity={ripMeta.severity} /></td>
                          <td className="status"><Tag value={encodeMeta.label} severity={encodeMeta.severity} /></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Fehler */}
          {status === 'ERROR' && job.error_message && (
            <div className="converter-job-card-error" style={{ marginTop: 8 }}>
              <small>{job.error_message}</small>
            </div>
          )}
        </div>
      )}

      {/* ACTIVE / TERMINAL: Video-Jobs (alte Darstellung) */}
      {!isReady && !isAudio && (
        <>
          {active && (
            <div className="converter-job-card-progress">
              {progressValue !== null ? (
                <ProgressBar value={progressValue} style={{ height: 6 }} displayValueTemplate={() => `${progressValue}%`} />
              ) : (
                <ProgressBar mode="indeterminate" style={{ height: 6 }} />
              )}
              {(liveStatusText || liveEta) && (
                <div className="converter-job-card-progress-meta">
                  {liveStatusText && <small>{liveStatusText}</small>}
                  {liveEta && <small>ETA: {liveEta}</small>}
                </div>
              )}
            </div>
          )}

          {status === 'ERROR' && job.error_message && (
            <div className="converter-job-card-error">
              <small>{job.error_message}</small>
            </div>
          )}

          {terminal && job.output_path && (
            <div className="converter-job-card-output">
              <small title={job.output_path}>→ {job.output_path.split('/').slice(-2).join('/')}</small>
            </div>
          )}

          <div className="converter-job-card-actions">
            <Button label="Details" icon="pi pi-eye" size="small" severity="secondary" outlined onClick={() => onOpenDetails?.(job)} />
            {!terminal && !isReady && (
              <Button
                label="Abbrechen"
                icon={cancelBusy ? 'pi pi-spin pi-spinner' : 'pi pi-times'}
                size="small" severity="warning" outlined
                disabled={cancelBusy}
                onClick={handleCancel}
              />
            )}
            {!active && (
              <Button
                label="Löschen"
                icon={deleteBusy ? 'pi pi-spin pi-spinner' : 'pi pi-trash'}
                size="small" severity="danger" outlined
                disabled={deleteBusy}
                onClick={handleDelete}
              />
            )}
          </div>
        </>
      )}

      <Dialog
        header="Job löschen"
        visible={deleteConfirmVisible}
        onHide={() => setDeleteConfirmVisible(false)}
        modal
        style={{ width: '22rem' }}
        footer={
          <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
            <Button
              label="Abbrechen"
              severity="secondary"
              outlined
              size="small"
              onClick={() => setDeleteConfirmVisible(false)}
            />
            <Button
              label="Löschen"
              icon="pi pi-trash"
              severity="danger"
              size="small"
              onClick={handleDeleteConfirmed}
            />
          </div>
        }
      >
        <p style={{ margin: 0 }}>
          {jobIdLabel} wirklich löschen?<br />
          <small>Es wird nur der Job-Eintrag entfernt, keine Dateien.</small>
        </p>
      </Dialog>
    </div>
  );
}
