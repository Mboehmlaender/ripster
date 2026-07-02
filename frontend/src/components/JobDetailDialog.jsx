import { useState } from 'react';
import { Dialog } from 'primereact/dialog';
import { Button } from 'primereact/button';
import { Tag } from 'primereact/tag';
import blurayIndicatorIcon from '../assets/media-bluray.svg';
import discIndicatorIcon from '../assets/media-disc.svg';
import otherIndicatorIcon from '../assets/media-other.svg';
import mergeIndicatorIcon from '../assets/media-merge.svg';
import { getProcessStatusLabel, getStatusLabel } from '../utils/statusPresentation';
import { isSeriesVideoJob } from '../utils/jobTaxonomy';

const CD_FORMAT_LABELS = {
  flac: 'FLAC',
  wav: 'WAV',
  mp3: 'MP3',
  opus: 'Opus',
  ogg: 'Ogg Vorbis'
};

function JsonView({ title, value }) {
  return (
    <div>
      <h4>{title}</h4>
      <pre className="json-box">{value ? JSON.stringify(value, null, 2) : '-'}</pre>
    </div>
  );
}

function ScriptResultRow({ result }) {
  const statusCode = String(result?.status || '').toUpperCase();
  const status = getProcessStatusLabel(statusCode);
  const isSuccess = statusCode === 'SUCCESS';
  const isError = statusCode === 'ERROR';
  const icon = isSuccess ? 'pi-check-circle' : isError ? 'pi-times-circle' : 'pi-minus-circle';
  const tone = isSuccess ? 'success' : isError ? 'danger' : 'warning';
  return (
    <div className="script-result-row">
      <span className={`job-step-inline-${isSuccess ? 'ok' : isError ? 'no' : 'warn'}`}>
        <i className={`pi ${icon}`} aria-hidden="true" />
      </span>
      <span className="script-result-name">{result?.scriptName || result?.chainName || `#${result?.scriptId ?? result?.chainId ?? '?'}`}</span>
      <span className={`script-result-status tone-${tone}`}>{status}</span>
      {result?.error ? <span className="script-result-error">{result.error}</span> : null}
    </div>
  );
}

function ScriptSummarySection({ title, summary }) {
  if (!summary || summary.configured === 0) return null;
  const results = Array.isArray(summary.results) ? summary.results : [];
  return (
    <div className="script-summary-block">
      <strong>{title}:</strong>
      <span className="script-summary-counts">
        {summary.succeeded > 0 ? <span className="tone-success">{summary.succeeded} OK</span> : null}
        {summary.failed > 0 ? <span className="tone-danger">{summary.failed} Fehler</span> : null}
        {summary.skipped > 0 ? <span className="tone-warning">{summary.skipped} übersprungen</span> : null}
      </span>
      {results.length > 0 ? (
        <div className="script-result-list">
          {results.map((r, i) => <ScriptResultRow key={i} result={r} />)}
        </div>
      ) : null}
    </div>
  );
}

function normalizeIdList(values) {
  const list = Array.isArray(values) ? values : [];
  const seen = new Set();
  const output = [];
  for (const value of list) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      continue;
    }
    const id = Math.trunc(parsed);
    const key = String(id);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    output.push(id);
  }
  return output;
}

function normalizePositiveInteger(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return Math.trunc(parsed);
}

function normalizeCdText(value) {
  return String(value || '')
    .normalize('NFC')
    .replace(/\s+/g, ' ')
    .trim();
}

function isPlaceholderCdTrackTitle(value) {
  const normalized = normalizeCdText(value).toLowerCase();
  if (!normalized) {
    return true;
  }
  return /^track\s*\d+$/i.test(normalized);
}

function formatDurationSeconds(totalSeconds) {
  const parsed = Number(totalSeconds);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
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

function shellQuote(value) {
  const raw = String(value ?? '');
  if (raw.length === 0) {
    return "''";
  }
  if (/^[A-Za-z0-9_./:=,+-]+$/.test(raw)) {
    return raw;
  }
  return `'${raw.replace(/'/g, `'"'"'`)}'`;
}

function trackLang(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return 'und';
  if (raw === 'und' || raw === 'unknown' || raw === 'un') return 'und';
  const map = { en: 'en', eng: 'en', de: 'de', deu: 'de', ger: 'de', tr: 'tr', tur: 'tr', fr: 'fr', fra: 'fr', fre: 'fr', es: 'es', spa: 'es', it: 'it', ita: 'it' };
  if (map[raw]) return map[raw];
  return raw.length >= 2 ? raw.slice(0, 2) : raw;
}

function trackCodec(type, value, hint = null) {
  const raw = String(value || '').trim();
  const merged = `${raw} ${String(hint || '')}`.toLowerCase();
  if (!raw) return '-';
  if (type === 'subtitle') return merged.includes('pgs') ? 'PGS' : raw.toUpperCase();
  if (merged.includes('dts-hd ma') || merged.includes('dts hd ma')) return 'DTS-HD MA';
  if (merged.includes('dts-hd')) return 'DTS-HD';
  if (merged.includes('dts') || merged.includes('dca')) return 'DTS';
  if (merged.includes('truehd')) return 'TRUEHD';
  if (merged.includes('e-ac-3') || merged.includes('eac3') || merged.includes('dd+')) return 'E-AC-3';
  if (merged.includes('ac-3') || merged.includes('ac3') || merged.includes('dolby digital')) return 'AC-3';
  return raw.toUpperCase();
}

function trackChLayout(rawValue) {
  const raw = String(rawValue || '').trim().toLowerCase();
  if (!raw) return null;
  if (raw.includes('7.1')) return '8ch | Surround 7.1';
  if (raw.includes('5.1')) return '6ch | Surround 5.1';
  if (raw.includes('stereo') || raw.includes('2.0') || raw.includes('downmix')) return '2ch | Stereo';
  if (raw.includes('mono') || raw.includes('1.0')) return '1ch | Mono';
  const nMatch = raw.match(/^([\d.]+)$/);
  if (nMatch) {
    const n = Number(nMatch[1]);
    if (Number.isFinite(n) && n > 0) return `${Math.trunc(n)}ch`;
  }
  const chMatch = raw.match(/(\d+)\s*ch/);
  if (chMatch) return `${chMatch[1]}ch`;
  return null;
}

function trackSizeFormat(bytes) {
  const value = Number(bytes || 0);
  if (!Number.isFinite(value) || value <= 0) return '-';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = value;
  let i = 0;
  while (size >= 1024 && i < units.length - 1) { size /= 1024; i++; }
  return `${size.toFixed(2)} ${units[i]}`;
}

function resolveManualTrackSelectionForTitle(encodePlan, titleId) {
  const plan = encodePlan && typeof encodePlan === 'object' ? encodePlan : {};
  const normalizedTitleId = normalizePositiveInteger(titleId);
  if (!normalizedTitleId) {
    return null;
  }
  const byTitle = plan?.manualTrackSelectionByTitle && typeof plan.manualTrackSelectionByTitle === 'object'
    ? plan.manualTrackSelectionByTitle
    : {};
  const directSelection = byTitle[normalizedTitleId] || byTitle[String(normalizedTitleId)] || null;
  if (directSelection && typeof directSelection === 'object') {
    return directSelection;
  }
  const fallbackSelection = plan?.manualTrackSelection && typeof plan.manualTrackSelection === 'object'
    ? plan.manualTrackSelection
    : null;
  if (!fallbackSelection) {
    return null;
  }
  const fallbackTitleId = normalizePositiveInteger(fallbackSelection?.titleId);
  return fallbackTitleId === normalizedTitleId ? fallbackSelection : null;
}

function buildEffectiveTitleTrackSelection(encodePlan, title) {
  const manualSelection = resolveManualTrackSelectionForTitle(encodePlan, title?.id);
  const hasManualAudio = Array.isArray(manualSelection?.audioTrackIds);
  const hasManualSubtitle = Array.isArray(manualSelection?.subtitleTrackIdsOrdered) || Array.isArray(manualSelection?.subtitleTrackIds);
  const selectedAudioIds = hasManualAudio
    ? normalizeIdList(manualSelection.audioTrackIds)
    : normalizeIdList((Array.isArray(title?.audioTracks) ? title.audioTracks : [])
      .filter((track) => Boolean(track?.selectedForEncode))
      .map((track) => track?.id));
  const selectedSubtitleIds = hasManualSubtitle
    ? normalizeIdList(
      Array.isArray(manualSelection?.subtitleTrackIdsOrdered) && manualSelection.subtitleTrackIdsOrdered.length > 0
        ? manualSelection.subtitleTrackIdsOrdered
        : manualSelection?.subtitleTrackIds
    )
    : normalizeIdList((Array.isArray(title?.subtitleTracks) ? title.subtitleTracks : [])
      .filter((track) => Boolean(track?.selectedForEncode))
      .map((track) => track?.id));

  return {
    selectedAudioSet: new Set(selectedAudioIds.map((id) => String(id))),
    selectedSubtitleSet: new Set(selectedSubtitleIds.map((id) => String(id))),
    hasManualAudio,
    hasManualSubtitle
  };
}

function getTrackActionLabel({
  selected = false,
  summary = '',
  manualSelection = false,
  fallback = 'Übernehmen'
}) {
  if (!selected) {
    return 'Nicht übernommen';
  }
  const rawSummary = String(summary || '').trim();
  if (!rawSummary) {
    return manualSelection ? `${fallback} (manuell)` : fallback;
  }
  if (/^nicht übernommen/i.test(rawSummary)) {
    return manualSelection ? `${fallback} (manuell)` : fallback;
  }
  if (/^preset-default\b/i.test(rawSummary) || /Preset-Default \(HandBrake\)/i.test(rawSummary)) {
    return manualSelection ? `${fallback} (manuell)` : 'Übernehmen';
  }
  return rawSummary;
}

function buildExecutedHandBrakeCommand(handbrakeInfo) {
  const cmd = String(handbrakeInfo?.cmd || '').trim();
  const args = Array.isArray(handbrakeInfo?.args) ? handbrakeInfo.args : [];
  if (!cmd) {
    return null;
  }
  return `${cmd} ${args.map((arg) => shellQuote(arg)).join(' ')}`.trim();
}

function normalizeSeriesEpisodeStatus(status) {
  const normalized = String(status || '').trim().toUpperCase();
  if (['QUEUED', 'RUNNING', 'FINISHED', 'ERROR', 'CANCELLED'].includes(normalized)) {
    return normalized;
  }
  return 'QUEUED';
}

function seriesEpisodeStatusMeta(status) {
  const normalized = normalizeSeriesEpisodeStatus(status);
  if (normalized === 'FINISHED') {
    return { label: 'Fertig', severity: 'success' };
  }
  if (normalized === 'RUNNING') {
    return { label: 'Läuft', severity: 'info' };
  }
  if (normalized === 'ERROR') {
    return { label: 'Fehler', severity: 'danger' };
  }
  if (normalized === 'CANCELLED') {
    return { label: 'Abgebrochen', severity: 'warning' };
  }
  return { label: 'Wartend', severity: 'secondary' };
}

function formatDateTimeOrDash(value) {
  const text = String(value || '').trim();
  if (!text) {
    return '-';
  }
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) {
    return text;
  }
  return parsed.toLocaleString();
}

function mergeSeriesBatchEpisodes(job) {
  const planEpisodes = Array.isArray(job?.encodePlan?.seriesBatchEpisodes)
    ? job.encodePlan.seriesBatchEpisodes
    : [];
  const hbEpisodes = Array.isArray(job?.handbrakeInfo?.seriesBatch?.episodes)
    ? job.handbrakeInfo.seriesBatch.episodes
    : [];
  const map = new Map();

  const append = (list, sourcePriority) => {
    for (const item of list) {
      if (!item || typeof item !== 'object') {
        continue;
      }
      const episodeIndex = normalizePositiveInteger(item?.episodeIndex);
      const titleId = normalizePositiveInteger(item?.titleId);
      const key = `${episodeIndex || 0}:${titleId || 0}`;
      const existing = map.get(key);
      if (!existing) {
        map.set(key, {
          ...item,
          episodeIndex,
          titleId,
          sourcePriority
        });
        continue;
      }
      if (sourcePriority >= Number(existing.sourcePriority || 0)) {
        map.set(key, {
          ...existing,
          ...item,
          episodeIndex: episodeIndex || existing.episodeIndex || null,
          titleId: titleId || existing.titleId || null,
          sourcePriority
        });
      }
    }
  };

  append(planEpisodes, 1);
  append(hbEpisodes, 2);

  return Array.from(map.values())
    .map((entry, index) => ({
      ...entry,
      episodeIndex: normalizePositiveInteger(entry?.episodeIndex) || (index + 1),
      titleId: normalizePositiveInteger(entry?.titleId) || null,
      progress: Number.isFinite(Number(entry?.progress))
        ? Math.max(0, Math.min(100, Number(entry.progress)))
        : 0,
      status: normalizeSeriesEpisodeStatus(entry?.status)
    }))
    .sort((left, right) => left.episodeIndex - right.episodeIndex);
}

function buildConfiguredScriptAndChainSelection(job) {
  const plan = job?.encodePlan && typeof job.encodePlan === 'object' ? job.encodePlan : {};
  const handbrakeInfo = job?.handbrakeInfo && typeof job.handbrakeInfo === 'object' ? job.handbrakeInfo : {};
  const scriptNameById = new Map();
  const chainNameById = new Map();

  const addScriptHint = (idValue, nameValue) => {
    const id = normalizeIdList([idValue])[0] || null;
    const name = String(nameValue || '').trim();
    if (!id || !name || scriptNameById.has(id)) {
      return;
    }
    scriptNameById.set(id, name);
  };

  const addChainHint = (idValue, nameValue) => {
    const id = normalizeIdList([idValue])[0] || null;
    const name = String(nameValue || '').trim();
    if (!id || !name || chainNameById.has(id)) {
      return;
    }
    chainNameById.set(id, name);
  };

  const addScriptHintsFromList = (list) => {
    for (const item of (Array.isArray(list) ? list : [])) {
      addScriptHint(item?.id ?? item?.scriptId, item?.name ?? item?.scriptName);
    }
  };

  const addChainHintsFromList = (list) => {
    for (const item of (Array.isArray(list) ? list : [])) {
      addChainHint(item?.id ?? item?.chainId, item?.name ?? item?.chainName);
    }
  };

  addScriptHintsFromList(plan?.preEncodeScripts);
  addScriptHintsFromList(plan?.postEncodeScripts);
  addChainHintsFromList(plan?.preEncodeChains);
  addChainHintsFromList(plan?.postEncodeChains);

  const scriptSummaries = [handbrakeInfo?.preEncodeScripts, handbrakeInfo?.postEncodeScripts];
  for (const summary of scriptSummaries) {
    const results = Array.isArray(summary?.results) ? summary.results : [];
    for (const result of results) {
      addScriptHint(result?.scriptId, result?.scriptName);
      addChainHint(result?.chainId, result?.chainName);
    }
  }

  const preScriptIds = normalizeIdList([
    ...(Array.isArray(plan?.preEncodeScriptIds) ? plan.preEncodeScriptIds : []),
    ...(Array.isArray(plan?.preEncodeScripts) ? plan.preEncodeScripts.map((item) => item?.id ?? item?.scriptId) : [])
  ]);
  const postScriptIds = normalizeIdList([
    ...(Array.isArray(plan?.postEncodeScriptIds) ? plan.postEncodeScriptIds : []),
    ...(Array.isArray(plan?.postEncodeScripts) ? plan.postEncodeScripts.map((item) => item?.id ?? item?.scriptId) : [])
  ]);
  const preChainIds = normalizeIdList([
    ...(Array.isArray(plan?.preEncodeChainIds) ? plan.preEncodeChainIds : []),
    ...(Array.isArray(plan?.preEncodeChains) ? plan.preEncodeChains.map((item) => item?.id ?? item?.chainId) : [])
  ]);
  const postChainIds = normalizeIdList([
    ...(Array.isArray(plan?.postEncodeChainIds) ? plan.postEncodeChainIds : []),
    ...(Array.isArray(plan?.postEncodeChains) ? plan.postEncodeChains.map((item) => item?.id ?? item?.chainId) : [])
  ]);

  return {
    preScriptIds,
    postScriptIds,
    preChainIds,
    postChainIds,
    preScripts: preScriptIds.map((id) => scriptNameById.get(id) || `Skript #${id}`),
    postScripts: postScriptIds.map((id) => scriptNameById.get(id) || `Skript #${id}`),
    preChains: preChainIds.map((id) => chainNameById.get(id) || `Kette #${id}`),
    postChains: postChainIds.map((id) => chainNameById.get(id) || `Kette #${id}`),
    scriptCatalog: Array.from(scriptNameById.entries()).map(([id, name]) => ({ id, name })),
    chainCatalog: Array.from(chainNameById.entries()).map(([id, name]) => ({ id, name }))
  };
}

function resolveMediaType(job) {
  const encodePlan = job?.encodePlan && typeof job.encodePlan === 'object' ? job.encodePlan : null;
  const candidates = [
    job?.mediaType,
    job?.media_type,
    job?.mediaProfile,
    job?.media_profile,
    encodePlan?.mediaProfile,
    job?.makemkvInfo?.analyzeContext?.mediaProfile,
    job?.makemkvInfo?.mediaProfile,
    job?.mediainfoInfo?.mediaProfile
  ];
  for (const candidate of candidates) {
    const raw = String(candidate || '').trim().toLowerCase();
    if (!raw) {
      continue;
    }
    if (['bluray', 'blu-ray', 'blu_ray', 'bd', 'bdmv', 'bdrom', 'bd-rom', 'bd-r', 'bd-re'].includes(raw)) {
      return 'bluray';
    }
    if (['dvd', 'disc', 'dvdvideo', 'dvd-video', 'dvdrom', 'dvd-rom', 'video_ts', 'iso9660'].includes(raw)) {
      return 'dvd';
    }
    if (['cd', 'audio_cd', 'audio cd'].includes(raw)) {
      return 'cd';
    }
    if (['audiobook', 'audio_book', 'audio book', 'book'].includes(raw)) {
      return 'audiobook';
    }
    if (raw === 'converter') {
      return 'converter';
    }
  }
  if (String(encodePlan?.mediaProfile || '').trim().toLowerCase() === 'converter') {
    return 'converter';
  }
  if (String(job?.media_type || '').trim().toLowerCase() === 'converter') {
    return 'converter';
  }
  if (resolveConverterMediaType(job)) {
    return 'converter';
  }
  const statusCandidates = [job?.status, job?.last_state, job?.makemkvInfo?.lastState];
  if (statusCandidates.some((v) => String(v || '').trim().toUpperCase().startsWith('CD_'))) {
    return 'cd';
  }
  const planFormat = String(encodePlan?.format || '').trim().toLowerCase();
  const hasCdTracksInPlan = Array.isArray(encodePlan?.selectedTracks) && encodePlan.selectedTracks.length > 0;
  if (hasCdTracksInPlan && ['flac', 'wav', 'mp3', 'opus', 'ogg'].includes(planFormat)) {
    return 'cd';
  }
  if (String(job?.handbrakeInfo?.mode || '').trim().toLowerCase() === 'cd_rip') {
    return 'cd';
  }
  if (Array.isArray(job?.makemkvInfo?.tracks) && job.makemkvInfo.tracks.length > 0) {
    return 'cd';
  }
  if (['audiobook_encode', 'audiobook_encode_split'].includes(String(job?.handbrakeInfo?.mode || '').trim().toLowerCase())) {
    return 'audiobook';
  }
  if (String(encodePlan?.mode || '').trim().toLowerCase() === 'audiobook') {
    return 'audiobook';
  }
  return 'other';
}

function resolveConverterMediaType(job) {
  const encodePlan = job?.encodePlan && typeof job.encodePlan === 'object' ? job.encodePlan : null;
  const candidates = [
    encodePlan?.converterMediaType,
    job?.converterMediaType,
    job?.makemkvInfo?.converterMediaType,
    job?.mediainfoInfo?.converterMediaType
  ];
  for (const candidate of candidates) {
    const raw = String(candidate || '').trim().toLowerCase();
    if (!raw) {
      continue;
    }
    if (raw === 'audio' || raw === 'video' || raw === 'iso') {
      return raw;
    }
  }
  return null;
}

function resolveCdDetails(job) {
  const encodePlan = job?.encodePlan && typeof job.encodePlan === 'object' ? job.encodePlan : {};
  const makemkvInfo = job?.makemkvInfo && typeof job.makemkvInfo === 'object' ? job.makemkvInfo : {};
  const selectedMetadata = makemkvInfo?.selectedMetadata && typeof makemkvInfo.selectedMetadata === 'object'
    ? makemkvInfo.selectedMetadata
    : {};
  const tracksSource = Array.isArray(makemkvInfo?.tracks) && makemkvInfo.tracks.length > 0
    ? makemkvInfo.tracks
    : (Array.isArray(encodePlan?.tracks) ? encodePlan.tracks : []);
  const tracks = tracksSource
    .map((track) => {
      const position = normalizePositiveInteger(track?.position);
      if (!position) {
        return null;
      }
      return { ...track, position, selected: track?.selected !== false };
    })
    .filter(Boolean);
  const selectedTracksFromPlan = Array.isArray(encodePlan?.selectedTracks)
    ? encodePlan.selectedTracks.map((v) => normalizePositiveInteger(v)).filter(Boolean)
    : [];
  const selectedTrackPositions = selectedTracksFromPlan.length > 0
    ? selectedTracksFromPlan
    : tracks.filter((t) => t.selected !== false).map((t) => t.position);
  const fallbackArtist = tracks.map((t) => String(t?.artist || '').trim()).find(Boolean) || null;
  const fallbackAlbum = tracks.map((t) => String(t?.album || '').trim()).find(Boolean) || null;
  const totalDurationSec = tracks.reduce((sum, t) => {
    const ms = Number(t?.durationMs);
    const sec = Number(t?.durationSec);
    if (Number.isFinite(ms) && ms > 0) {
      return sum + ms / 1000;
    }
    if (Number.isFinite(sec) && sec > 0) {
      return sum + sec;
    }
    return sum;
  }, 0);
  const format = String(encodePlan?.format || '').trim().toLowerCase();
  const mbId = String(
    selectedMetadata?.mbId
    || selectedMetadata?.musicBrainzId
    || selectedMetadata?.musicbrainzId
    || selectedMetadata?.musicbrainz_id
    || selectedMetadata?.music_brainz_id
    || selectedMetadata?.musicbrainz
    || selectedMetadata?.mbid
    || job?.imdb_id
    || ''
  ).trim() || null;

  return {
    artist: String(selectedMetadata?.artist || '').trim() || fallbackArtist || null,
    album: String(selectedMetadata?.album || '').trim() || fallbackAlbum || null,
    trackCount: tracks.length,
    selectedTrackCount: selectedTrackPositions.length,
    format,
    formatLabel: format ? (CD_FORMAT_LABELS[format] || format.toUpperCase()) : null,
    totalDurationLabel: formatDurationSeconds(totalDurationSec),
    mbId
  };
}

function resolveAudiobookDetails(job) {
  const encodePlan = job?.encodePlan && typeof job.encodePlan === 'object' ? job.encodePlan : {};
  const makemkvInfo = job?.makemkvInfo && typeof job.makemkvInfo === 'object' ? job.makemkvInfo : {};
  const selectedMetadata = {
    ...(makemkvInfo?.selectedMetadata && typeof makemkvInfo.selectedMetadata === 'object'
      ? makemkvInfo.selectedMetadata
      : {}),
    ...(encodePlan?.metadata && typeof encodePlan.metadata === 'object' ? encodePlan.metadata : {})
  };
  const chapters = Array.isArray(selectedMetadata?.chapters)
    ? selectedMetadata.chapters
    : (Array.isArray(makemkvInfo?.chapters) ? makemkvInfo.chapters : []);
  const format = String(job?.handbrakeInfo?.format || encodePlan?.format || '').trim().toLowerCase() || null;
  const formatOptions = job?.handbrakeInfo?.formatOptions && typeof job.handbrakeInfo.formatOptions === 'object'
    ? job.handbrakeInfo.formatOptions
    : (encodePlan?.formatOptions && typeof encodePlan.formatOptions === 'object' ? encodePlan.formatOptions : {});
  const qualityLabel = format === 'mp3'
    ? (
      String(formatOptions?.mp3Mode || '').trim().toLowerCase() === 'vbr'
        ? `VBR V${Number(formatOptions?.mp3Quality ?? 4)}`
        : `CBR ${Number(formatOptions?.mp3Bitrate ?? 192)} kbps`
    )
    : (format === 'flac'
      ? `Kompression ${Number(formatOptions?.flacCompression ?? 5)}`
      : (format === 'm4b' ? 'Original-Audio' : null));
  return {
    author: String(selectedMetadata?.author || selectedMetadata?.artist || '').trim() || null,
    narrator: String(selectedMetadata?.narrator || '').trim() || null,
    series: String(selectedMetadata?.series || '').trim() || null,
    part: String(selectedMetadata?.part || '').trim() || null,
    chapterCount: chapters.length,
    formatLabel: format ? format.toUpperCase() : null,
    qualityLabel
  };
}

function statusBadgeMeta(status, queued = false, options = {}) {
  const normalized = String(status || '').trim().toUpperCase();
  const labelOverride = String(options?.label || '').trim();
  const label = labelOverride || getStatusLabel(normalized, { queued });
  if (queued) {
    return { label, icon: 'pi-list', tone: 'info' };
  }
  if (normalized === 'FINISHED') {
    return { label, icon: 'pi-check-circle', tone: 'success' };
  }
  if (normalized === 'ERROR') {
    return { label, icon: 'pi-times-circle', tone: 'danger' };
  }
  if (normalized === 'CANCELLED') {
    return { label, icon: 'pi-ban', tone: 'warning' };
  }
  if (normalized === 'READY_TO_ENCODE' || normalized === 'READY_TO_START') {
    return { label, icon: 'pi-play-circle', tone: 'info' };
  }
  if (normalized === 'CD_READY_TO_RIP') {
    return { label, icon: 'pi-play-circle', tone: 'info' };
  }
  if (normalized === 'WAITING_FOR_USER_DECISION') {
    return { label, icon: 'pi-exclamation-circle', tone: 'warning' };
  }
  if (normalized === 'METADATA_SELECTION') {
    return { label, icon: 'pi-list', tone: 'warning' };
  }
  if (normalized === 'CD_METADATA_SELECTION') {
    return { label, icon: 'pi-list', tone: 'warning' };
  }
  if (normalized === 'ANALYZING') {
    return { label, icon: 'pi-search', tone: 'warning' };
  }
  if (normalized === 'CD_ANALYZING') {
    return { label, icon: 'pi-search', tone: 'warning' };
  }
  if (normalized === 'RIPPING') {
    return { label, icon: 'pi-download', tone: 'warning' };
  }
  if (normalized === 'CD_RIPPING') {
    return { label, icon: 'pi-download', tone: 'warning' };
  }
  if (normalized === 'MEDIAINFO_CHECK') {
    return { label, icon: 'pi-sliders-h', tone: 'warning' };
  }
  if (normalized === 'ENCODING') {
    return { label, icon: 'pi-cog', tone: 'warning' };
  }
  if (normalized === 'CD_ENCODING') {
    return { label, icon: 'pi-cog', tone: 'warning' };
  }
  if (normalized === 'MERGING') {
    return { label, icon: 'pi-spinner pi-spin', tone: 'warning' };
  }
  return { label: label || '-', icon: 'pi-info-circle', tone: 'secondary' };
}

function normalizePathForCompare(value) {
  return String(value || '').trim().replace(/[\\/]+$/, '');
}

function isIncompleteRawPath(value) {
  const normalized = String(value || '').trim().replace(/[\\]+/g, '/');
  if (!normalized) {
    return false;
  }
  const segments = normalized.split('/').filter(Boolean);
  const baseName = segments[segments.length - 1] || '';
  return /^incomplete_/i.test(baseName);
}

function isIncompleteOutputPath(value) {
  const normalized = String(value || '').trim().replace(/[\\]+/g, '/');
  if (!normalized) {
    return false;
  }
  return /(^|\/)incomplete_job-\d+(\/|$)/i.test(normalized)
    || /(^|\/)incomplete_merge_[^/]+_job_\d+(\/|$)/i.test(normalized);
}

function buildMergeToolLogFallback(job = null) {
  const handbrakeInfo = job?.handbrakeInfo && typeof job.handbrakeInfo === 'object'
    ? job.handbrakeInfo
    : {};
  const lines = [];
  const highlights = Array.isArray(handbrakeInfo?.highlights) ? handbrakeInfo.highlights : [];
  for (const entry of highlights) {
    const text = String(entry || '').trim();
    if (text) {
      lines.push(text);
    }
  }
  const stdoutTail = String(handbrakeInfo?.stdoutTail || '').trim();
  if (stdoutTail) {
    lines.push(stdoutTail);
  }
  const stderrTail = String(handbrakeInfo?.stderrTail || '').trim();
  if (stderrTail) {
    lines.push(stderrTail);
  }
  if (lines.length === 0) {
    return '';
  }
  return lines.join('\n');
}

function metadataField(value) {
  const raw = String(value || '').trim();
  return raw || '-';
}

function normalizeMetadataProvider(value) {
  return String(value || '').trim().toLowerCase() || 'tmdb';
}

function resolveJobMetadataContext(job) {
  const mkInfo = job?.makemkvInfo && typeof job.makemkvInfo === 'object'
    ? job.makemkvInfo
    : {};
  const analyzeContext = mkInfo?.analyzeContext && typeof mkInfo.analyzeContext === 'object'
    ? mkInfo.analyzeContext
    : {};
  const analyzeSelectedMetadata = analyzeContext?.selectedMetadata && typeof analyzeContext.selectedMetadata === 'object'
    ? analyzeContext.selectedMetadata
    : {};
  const selectedMetadata = mkInfo?.selectedMetadata && typeof mkInfo.selectedMetadata === 'object'
    ? mkInfo.selectedMetadata
    : {};
  const encodeMetadata = job?.encodePlan?.metadata && typeof job.encodePlan.metadata === 'object'
    ? job.encodePlan.metadata
    : {};
  const mergedSelectedMetadata = {
    ...analyzeSelectedMetadata,
    ...selectedMetadata,
    ...encodeMetadata
  };
  const metadataProvider = normalizeMetadataProvider(
    mergedSelectedMetadata?.metadataProvider
    || analyzeContext?.metadataProvider
    || 'tmdb'
  );
  return {
    analyzeContext,
    selectedMetadata: mergedSelectedMetadata,
    metadataProvider
  };
}

function uniqueNameList(values, maxItems = 10) {
  const source = Array.isArray(values)
    ? values
    : (typeof values === 'string'
      ? values.split(',')
      : (values && typeof values === 'object'
        ? [values]
        : []));
  const limit = Math.max(1, Number(maxItems || 10));
  const output = [];
  const seen = new Set();
  for (const item of source) {
    const name = String(item?.name || item || '').trim();
    if (!name) {
      continue;
    }
    const key = name.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    output.push(name);
    if (output.length >= limit) {
      break;
    }
  }
  return output;
}

function formatRuntimeLabel(value) {
  if (Array.isArray(value)) {
    const values = value
      .map((entry) => Number(entry))
      .filter((entry) => Number.isFinite(entry) && entry > 0)
      .map((entry) => Math.trunc(entry));
    if (values.length === 0) {
      return null;
    }
    const min = Math.min(...values);
    const max = Math.max(...values);
    return min === max ? `${min} min` : `${min}-${max} min`;
  }
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) {
    return `${Math.trunc(numeric)} min`;
  }
  const text = String(value || '').trim();
  return text || null;
}

function resolveMetadataDetailsForDisplay(job) {
  const metadataContext = resolveJobMetadataContext(job);
  const selectedMetadata = metadataContext.selectedMetadata;
  const tmdbDetails = selectedMetadata?.tmdbDetails && typeof selectedMetadata.tmdbDetails === 'object'
    ? selectedMetadata.tmdbDetails
    : {};
  const genre = uniqueNameList(tmdbDetails?.genres || tmdbDetails?.genre, 3).join(', ') || null;
  const actors = uniqueNameList(tmdbDetails?.seasonCast || tmdbDetails?.actors, 6).join(', ') || null;
  const director = uniqueNameList(tmdbDetails?.createdBy || tmdbDetails?.director, 3).join(', ') || null;
  const runtime = tmdbDetails?.seasonRuntime || tmdbDetails?.runtime || formatRuntimeLabel(selectedMetadata?.episodeRunTime);
  const ratingNumber = Number(tmdbDetails?.seasonVoteAverage ?? tmdbDetails?.voteAverage ?? selectedMetadata?.voteAverage);
  const tmdbRating = Number.isFinite(ratingNumber) && ratingNumber > 0
    ? ratingNumber.toFixed(1)
    : null;
  const imdbId = String(selectedMetadata?.imdbId || tmdbDetails?.imdbId || '').trim() || null;
  const hasMatch = Boolean(selectedMetadata?.tmdbId || tmdbDetails?.tmdbId);

  return {
    provider: 'tmdb',
    title: 'TMDb Details',
    matchLabel: 'TMDb Match',
    hasMatch,
    imdbId,
    director: director || '-',
    actors: actors || '-',
    runtime: runtime || '-',
    genre: genre || '-',
    tmdbRating: tmdbRating || '-'
  };
}

function resolveSeriesDiscNumber(job) {
  const metadataContext = resolveJobMetadataContext(job);
  return normalizePositiveInteger(
    metadataContext?.selectedMetadata?.discNumber
    ?? metadataContext?.analyzeContext?.seriesLookupHint?.discNumber
    ?? job?.encodePlan?.discNumber
    ?? job?.disc_number
    ?? null
  );
}

function isSeriesBatchEpisodeChildJob(job) {
  const plan = job?.encodePlan && typeof job.encodePlan === 'object'
    ? job.encodePlan
    : null;
  if (!plan) {
    return false;
  }
  if (Boolean(plan?.seriesBatchChild) || Boolean(plan?.seriesBatchVirtualEpisode)) {
    return true;
  }
  const hasParent = normalizePositiveInteger(plan?.seriesBatchParentJobId) !== null;
  const hasEpisodeMarker = normalizePositiveInteger(plan?.seriesBatchTitleId) !== null
    || normalizePositiveInteger(plan?.seriesBatchChildIndex) !== null
    || normalizePositiveInteger(plan?.seriesBatchChildCount) !== null;
  return hasParent && hasEpisodeMarker;
}

function isMultipartMergeChildJob(job) {
  const jobKind = String(job?.job_kind || '').trim().toLowerCase();
  if (jobKind === 'multipart_movie_merge') {
    return true;
  }
  const plan = job?.encodePlan && typeof job.encodePlan === 'object'
    ? job.encodePlan
    : null;
  if (String(plan?.jobKind || '').trim().toLowerCase() === 'multipart_movie_merge') {
    return true;
  }
  const mode = String(plan?.mode || job?.handbrakeInfo?.mode || '').trim().toLowerCase();
  return mode === 'multipart_merge';
}

function buildSeriesContainerDiskChildren(children = []) {
  const rows = Array.isArray(children) ? children : [];
  const diskCandidates = rows.filter((child) => (
    !isSeriesBatchEpisodeChildJob(child)
    && !isMultipartMergeChildJob(child)
  ));
  const byDisc = new Map();
  const withoutDisc = [];

  for (const child of [...diskCandidates].sort((a, b) => Number(b?.id || 0) - Number(a?.id || 0))) {
    const discNumber = resolveSeriesDiscNumber(child);
    if (discNumber !== null) {
      if (!byDisc.has(discNumber)) {
        byDisc.set(discNumber, child);
      }
      continue;
    }
    withoutDisc.push(child);
  }

  const withDisc = Array.from(byDisc.entries())
    .sort((left, right) => left[0] - right[0])
    .map(([, child]) => child);
  const withoutDiscSorted = withoutDisc.sort(compareSeriesChildJobsByDisc);
  return [...withDisc, ...withoutDiscSorted];
}

function compareSeriesChildJobsByDisc(leftJob, rightJob) {
  const leftDisc = resolveSeriesDiscNumber(leftJob);
  const rightDisc = resolveSeriesDiscNumber(rightJob);
  if (leftDisc !== null && rightDisc !== null && leftDisc !== rightDisc) {
    return leftDisc - rightDisc;
  }
  if (leftDisc !== null && rightDisc === null) {
    return -1;
  }
  if (leftDisc === null && rightDisc !== null) {
    return 1;
  }
  return Number(leftJob?.id || 0) - Number(rightJob?.id || 0);
}

function BoolState({ value }) {
  const isTrue = Boolean(value);
  return isTrue ? (
    <span className="job-step-inline-ok" title="Ja">
      <i className="pi pi-check-circle" aria-hidden="true" />
    </span>
  ) : (
    <span className="job-step-inline-no" title="Nein">
      <i className="pi pi-times-circle" aria-hidden="true" />
    </span>
  );
}

function TriState({ existing = 0, expected = 0, labels = {} }) {
  const safeExpected = Number.isFinite(Number(expected)) ? Number(expected) : 0;
  const safeExisting = Number.isFinite(Number(existing)) ? Number(existing) : 0;
  if (safeExpected <= 0) {
    return <BoolState value={safeExisting > 0} />;
  }
  if (safeExisting <= 0) {
    return (
      <span className="job-step-inline-no" title={labels.none || `Nein (${safeExisting}/${safeExpected})`}>
        <i className="pi pi-times-circle" aria-hidden="true" />
      </span>
    );
  }
  if (safeExisting < safeExpected) {
    return (
      <span className="job-step-inline-warn" title={labels.partial || `Teilweise (${safeExisting}/${safeExpected})`}>
        <i className="pi pi-exclamation-circle" aria-hidden="true" />
      </span>
    );
  }
  return (
    <span className="job-step-inline-ok" title={labels.full || `Ja (${safeExisting}/${safeExpected})`}>
      <i className="pi pi-check-circle" aria-hidden="true" />
    </span>
  );
}

function resolveSelectionStateMeta({ selected, outcome }) {
  if (!selected) {
    return {
      label: 'Nicht ausgewählt',
      icon: 'pi-minus-circle',
      className: 'track-selection-inline-neutral',
      title: 'Nicht ausgewählt'
    };
  }
  if (outcome === 'success') {
    return {
      label: 'Ausgewählt',
      icon: 'pi-check-circle',
      className: 'job-step-inline-ok',
      title: 'Ausgewählt und erfolgreich'
    };
  }
  if (outcome === 'error') {
    return {
      label: 'Ausgewählt',
      icon: 'pi-times-circle',
      className: 'job-step-inline-no',
      title: 'Ausgewählt, aber nicht erfolgreich'
    };
  }
  if (outcome === 'cancelled') {
    return {
      label: 'Ausgewählt',
      icon: 'pi-ban',
      className: 'job-step-inline-warn',
      title: 'Ausgewählt, aber abgebrochen'
    };
  }
  return {
    label: 'Ausgewählt',
    icon: 'pi-clock',
    className: 'track-selection-inline-neutral',
    title: 'Ausgewählt'
  };
}

function SelectionStateNote({ selected, outcome }) {
  const meta = resolveSelectionStateMeta({ selected, outcome });
  return (
    <small className="track-action-note">
      <span className={meta.className} title={meta.title}>
        <span>{meta.label}</span>
        <i className={`pi ${meta.icon}`} aria-hidden="true" />
      </span>
    </small>
  );
}

function PathField({
  label,
  value,
  onDownload = null,
  downloadDisabled = false,
  downloadLoading = false
}) {
  const hasValue = Boolean(String(value || '').trim());
  const canDownload = hasValue && typeof onDownload === 'function' && !downloadDisabled;

  return (
    <div className="job-path-field">
      <strong>{label}</strong>
      <div className="job-path-field-value">
        <span>{hasValue ? value : '-'}</span>
        {canDownload ? (
          <Button
            type="button"
            icon="pi pi-download"
            text
            rounded
            size="small"
            className="job-path-download-button"
            aria-label={`${label} als ZIP vorbereiten`}
            tooltip={`${label} als ZIP vorbereiten`}
            tooltipOptions={{ position: 'top' }}
            onClick={onDownload}
            disabled={downloadDisabled || downloadLoading}
            loading={downloadLoading}
          />
        ) : null}
      </div>
    </div>
  );
}

export default function JobDetailDialog({
  visible,
  job,
  onHide,
  detailLoading = false,
  onLoadLog,
  logLoadingMode = null,
  onAssignMetadata,
  onAssignCdMetadata,
  onGenerateNfo,
  onAcknowledgeError,
  onResumeReady,
  onRestartEncode,
  onRestartReview,
  onRestartCdReview,
  onReencode,
  onRetry,
  onDeleteFiles,
  onDeleteEntry,
  onDownloadArchive,
  onDownloadOutputFolder,
  onRemoveFromQueue,
  onRestoreMultipartMerge,
  onCancel,
  isQueued = false,
  metadataAssignBusy = false,
  cdMetadataAssignBusy = false,
  acknowledgeErrorBusy = false,
  generateNfoBusy = false,
  actionBusy = false,
  cancelBusy = false,
  reencodeBusy = false,
  deleteEntryBusy = false,
  restoreMergeBusy = false,
  downloadBusyTarget = null,
  downloadFolderBusyPath = null
}) {
  const mkDone = Boolean(job?.ripSuccessful) || !job?.makemkvInfo || job?.makemkvInfo?.status === 'SUCCESS';
  const statusUpper = String(job?.status || '').trim().toUpperCase();
  const lastStateUpper = String(job?.last_state || '').trim().toUpperCase();
  const errorMessageLower = String(job?.error_message || '').trim().toLowerCase();
  const running = ['ANALYZING', 'RIPPING', 'MEDIAINFO_CHECK', 'ENCODING', 'CD_RIPPING', 'CD_ENCODING'].includes(statusUpper);
  const softCancelable = ['READY_TO_START', 'READY_TO_ENCODE', 'METADATA_SELECTION', 'WAITING_FOR_USER_DECISION', 'CD_METADATA_SELECTION', 'CD_READY_TO_RIP'].includes(statusUpper);
  const showCancelAction = (running || softCancelable) && typeof onCancel === 'function';
  const showFinalLog = !running;
  const mediaType = resolveMediaType(job);
  const isDvdSeries = (mediaType === 'dvd' || mediaType === 'bluray') && isSeriesVideoJob(job);
  const seriesBatchEpisodes = isDvdSeries ? mergeSeriesBatchEpisodes(job) : [];
  const seriesEpisodeAssignments = isDvdSeries && job?.encodePlan?.episodeAssignments && typeof job.encodePlan.episodeAssignments === 'object'
    ? job.encodePlan.episodeAssignments
    : {};
  const seriesBatchSummary = seriesBatchEpisodes.reduce((acc, episode) => {
    const status = normalizeSeriesEpisodeStatus(episode?.status);
    if (status === 'FINISHED') {
      acc.finished += 1;
    } else if (status === 'ERROR') {
      acc.error += 1;
    } else if (status === 'CANCELLED') {
      acc.cancelled += 1;
    } else if (status === 'RUNNING') {
      acc.running += 1;
    } else {
      acc.queued += 1;
    }
    return acc;
  }, {
    total: seriesBatchEpisodes.length,
    finished: 0,
    error: 0,
    cancelled: 0,
    running: 0,
    queued: 0
  });
  const isCd = mediaType === 'cd';
  const isAudiobook = mediaType === 'audiobook';
  const isConverter = mediaType === 'converter';
  const retryRipRecoveryReason = (
    errorMessageLower.includes('server-neustart')
    || errorMessageLower.includes('rip ist unvollständig')
    || errorMessageLower.includes('rip-validierung fehlgeschlagen')
  );
  const retryRipRequired = Boolean(
    !running
    && !isAudiobook
    && !isConverter
    && ['ERROR', 'CANCELLED'].includes(statusUpper)
    && (
      ['RIPPING', 'CD_RIPPING'].includes(lastStateUpper)
      || retryRipRecoveryReason
    )
  );
  const blockMetadataAndReviewUntilRetry = retryRipRequired;
  const converterMediaType = isConverter ? (resolveConverterMediaType(job) || 'video') : null;
  const converterMediaTypeLabel = converterMediaType === 'audio'
    ? 'Audio'
    : (converterMediaType === 'iso' ? 'ISO (Video)' : 'Video');
  const cdRawPathCandidates = [
    job?.raw_path,
    job?.makemkvInfo?.rawPath,
    job?.makemkvInfo?.importContext?.requestedRawPath,
    job?.makemkvInfo?.importContext?.originalRawPath
  ]
    .map((value) => String(value || '').trim())
    .filter(Boolean);
  const hasCdRawInputCandidate = Boolean(job?.rawStatus?.exists) || cdRawPathCandidates.length > 0;
  const hasReencodeRawInput = isCd
    ? hasCdRawInputCandidate
    : Boolean(job?.rawStatus?.exists && job?.rawStatus?.isEmpty !== true);
  const canReencode = !!(hasReencodeRawInput && !running && (isCd || mkDone));
  // For CDs: direct re-encode requires track data from the last run
  const cdEncodePlan = isCd && job?.encodePlan && typeof job.encodePlan === 'object' ? job.encodePlan : null;
  const cdSelectedMeta = isCd && job?.makemkvInfo?.selectedMetadata && typeof job.makemkvInfo.selectedMetadata === 'object'
    ? job.makemkvInfo.selectedMetadata
    : {};
  const cdPlanTracks = isCd && Array.isArray(cdEncodePlan?.tracks)
    ? cdEncodePlan.tracks
    : [];
  const cdSelectedTrackPositions = isCd
    ? (
      Array.isArray(cdEncodePlan?.selectedTracks) && cdEncodePlan.selectedTracks.length > 0
        ? cdEncodePlan.selectedTracks
        : cdPlanTracks.filter((track) => track?.selected !== false).map((track) => track?.position)
    )
      .map((value) => normalizePositiveInteger(value))
      .filter(Boolean)
    : [];
  const cdTrackByPosition = new Map(
    cdPlanTracks
      .map((track) => {
        const position = normalizePositiveInteger(track?.position);
        if (!position) {
          return null;
        }
        return [position, track];
      })
      .filter(Boolean)
  );
  const cdHasCoreMetadata = Boolean(
    normalizeCdText(cdSelectedMeta?.title || cdSelectedMeta?.album || job?.title || job?.detected_title)
    && normalizeCdText(cdSelectedMeta?.artist)
  );
  const cdHasMeaningfulTrackTitles = cdSelectedTrackPositions.some((position) => {
    const track = cdTrackByPosition.get(position);
    const title = normalizeCdText(track?.title);
    return Boolean(title) && !isPlaceholderCdTrackTitle(title);
  });
  const cdHasPriorRunEvidence = Boolean(
    cdEncodePlan?.directReencodeReady
    || (Array.isArray(job?.handbrakeInfo?.tracks) && job.handbrakeInfo.tracks.length > 0)
    || String(job?.handbrakeInfo?.status || '').trim().toUpperCase() === 'SUCCESS'
  );
  const cdHasLastRunData = Boolean(
    cdEncodePlan
    && Array.isArray(cdEncodePlan.tracks)
    && cdEncodePlan.tracks.length > 0
    && cdEncodePlan.format
  );
  const canCdDirectEncode = Boolean(
    canReencode
    && cdHasLastRunData
    && cdHasCoreMetadata
    && cdHasMeaningfulTrackTitles
    && cdHasPriorRunEvidence
  );
  const canCdStartReview = !!(hasCdRawInputCandidate && !running
    && isCd && typeof onRestartCdReview === 'function');
  const canResumeReady = Boolean(
    (String(job?.status || '').trim().toUpperCase() === 'READY_TO_ENCODE' || String(job?.last_state || '').trim().toUpperCase() === 'READY_TO_ENCODE')
    && !running
    && typeof onResumeReady === 'function'
  );
  const hasConfirmedPlan = Boolean(
    job?.encodePlan
    && Array.isArray(job?.encodePlan?.titles)
    && job?.encodePlan?.titles.length > 0
    && Number(job?.encode_review_confirmed || 0) === 1
  );
  const hasRestartInput = Boolean(job?.encode_input_path || job?.raw_path || job?.encodePlan?.encodeInputPath);
  const canRestartEncode = Boolean(hasConfirmedPlan && hasRestartInput && !running && job?.rawStatus?.exists);
  const canRestartReview = Boolean(
    job?.rawStatus?.exists
    && job?.rawStatus?.isEmpty !== true
    && !running
    && (isAudiobook || !blockMetadataAndReviewUntilRetry)
    && typeof onRestartReview === 'function'
  );
  const converterPlan = isConverter && job?.encodePlan && typeof job.encodePlan === 'object'
    ? job.encodePlan
    : {};
  const converterMetadata = isConverter && converterPlan?.metadata && typeof converterPlan.metadata === 'object'
    ? converterPlan.metadata
    : {};
  const converterInputPaths = isConverter
    ? (
      Array.isArray(converterPlan?.inputPaths) && converterPlan.inputPaths.length > 0
        ? converterPlan.inputPaths
        : [converterPlan?.inputPath || job?.raw_path]
    )
      .map((value) => String(value || '').trim())
      .filter(Boolean)
    : [];
  const converterTrackList = isConverter && Array.isArray(converterPlan?.tracks)
    ? converterPlan.tracks
    : [];
  const converterOutputFormat = String(
    converterPlan?.outputFormat
    || job?.handbrakeInfo?.format
    || converterPlan?.format
    || ''
  ).trim().toLowerCase();
  const converterPresetLabel = String(
    converterPlan?.userPreset?.name
    || converterPlan?.userPreset?.handbrakePreset
    || ''
  ).trim() || null;
  const converterAudioQualityLabel = isConverter && converterMediaType === 'audio'
    ? (() => {
      const opts = converterPlan?.audioFormatOptions && typeof converterPlan.audioFormatOptions === 'object'
        ? converterPlan.audioFormatOptions
        : {};
      if (converterOutputFormat === 'flac') {
        return `Kompression ${Number(opts?.flacCompression ?? 5)}`;
      }
      if (converterOutputFormat === 'mp3') {
        const mode = String(opts?.mp3Mode || 'cbr').trim().toLowerCase();
        if (mode === 'vbr') {
          return `VBR V${Number(opts?.mp3Quality ?? 4)}`;
        }
        return `CBR ${Number(opts?.mp3Bitrate ?? 192)} kbps`;
      }
      if (converterOutputFormat === 'opus') {
        return `${Number(opts?.opusBitrate ?? 160)} kbps`;
      }
      if (converterOutputFormat === 'ogg') {
        return `Qualität ${Number(opts?.oggQuality ?? 6)}`;
      }
      return converterOutputFormat ? converterOutputFormat.toUpperCase() : '-';
    })()
    : null;
  const canDeleteEntry = !running && typeof onDeleteEntry === 'function';
  const nfoStatus = job?.nfoStatus && typeof job.nfoStatus === 'object'
    ? job.nfoStatus
    : {};
  const canGenerateNfo = Boolean(
    !running
    && typeof onGenerateNfo === 'function'
    && nfoStatus?.canGenerateManual
  );
  const queueLocked = Boolean(isQueued && job?.id);
  const logCount = Number(job?.log_count || 0);
  const logMeta = job?.logMeta && typeof job.logMeta === 'object' ? job.logMeta : null;
  const logLoaded = Boolean(logMeta?.loaded) || Boolean(job?.log);
  const logTruncated = Boolean(logMeta?.truncated);
  const cdDetails = isCd ? resolveCdDetails(job) : null;
  const audiobookDetails = isAudiobook ? resolveAudiobookDetails(job) : null;
  const canRetry = !running && typeof onRetry === 'function' && (isCd || retryRipRequired);
  const mediaTypeLabel = mediaType === 'bluray'
    ? (isDvdSeries ? 'Blu-ray Serie' : 'Blu-ray')
    : mediaType === 'dvd'
      ? (isDvdSeries ? 'DVD Serie' : 'DVD')
      : isCd
        ? 'Audio CD'
        : (isAudiobook ? 'Audiobook' : (isConverter ? `Converter ${converterMediaTypeLabel}` : 'Sonstiges Medium'));
  const mediaTypeIcon = mediaType === 'bluray'
    ? blurayIndicatorIcon
    : mediaType === 'dvd'
      ? discIndicatorIcon
      : otherIndicatorIcon;
  const mediaTypeAlt = mediaTypeLabel;
  const jobKindRaw = String(job?.job_kind || '').trim().toLowerCase();
  const isMultipartMergeJob = isMultipartMergeChildJob(job);
  const statusMeta = statusBadgeMeta(
    isMultipartMergeJob && statusUpper === 'ENCODING' ? 'MERGING' : job?.status,
    queueLocked,
    { label: isMultipartMergeJob && statusUpper === 'ENCODING' ? 'Merging' : '' }
  );
  const metadataContext = resolveJobMetadataContext(job);
  const metadataDetails = resolveMetadataDetailsForDisplay(job);
  const seriesDiscNumber = isDvdSeries ? resolveSeriesDiscNumber(job) : null;
  const seriesDiscLabel = seriesDiscNumber ? `Disk ${seriesDiscNumber}` : 'Disk unbekannt';
  const isSeriesContainer = isDvdSeries && jobKindRaw === 'dvd_series_container';
  const isMultipartContainer = jobKindRaw === 'multipart_movie_container';
  const isMultipartChild = jobKindRaw === 'multipart_movie_child'
    || (
      Number(job?.is_multipart_movie || 0) === 1
      && Boolean(normalizePositiveInteger(job?.parent_job_id))
      && !isMultipartMergeJob
      && !isMultipartContainer
    );
  const isMultipartJob = Boolean(isMultipartContainer || isMultipartMergeJob || isMultipartChild);
  const isDiskContainer = isSeriesContainer || isMultipartContainer;
  const allChildJobs = Array.isArray(job?.children)
    ? [...job.children].sort(compareSeriesChildJobsByDisc)
    : [];
  const childJobs = Array.isArray(job?.children)
    ? (
      isDiskContainer
        ? buildSeriesContainerDiskChildren(allChildJobs)
        : allChildJobs
    )
    : [];
  const mergeChildJobs = isMultipartContainer
    ? allChildJobs.filter((child) => isMultipartMergeChildJob(child))
    : [];
  const seriesChildSummary = job?.seriesChildSummary || null;
  const seriesBackupSummary = isDiskContainer ? seriesChildSummary?.backup : null;
  const seriesEncodeSummary = isDiskContainer ? seriesChildSummary?.encode : null;
  const seriesMergeSummary = isMultipartContainer && seriesChildSummary?.merge && typeof seriesChildSummary.merge === 'object'
    ? seriesChildSummary.merge
    : null;
  const multipartMergeSummary = isMultipartContainer
    ? (
      seriesMergeSummary
      || (() => {
        const inputExpected = childJobs.length;
        const inputReady = childJobs.reduce((count, child) => (
          count + (
            child?.outputStatus?.exists
            || Boolean(String(child?.output_path || '').trim())
            || (Array.isArray(child?.outputFolders) && child.outputFolders.length > 0)
              ? 1
              : 0
          )
        ), 0);
        const hasJob = mergeChildJobs.length > 0;
        const active = mergeChildJobs.some((child) => String(child?.status || child?.last_state || '').trim().toUpperCase() === 'ENCODING');
        const completed = mergeChildJobs.some((child) => (
          String(child?.status || child?.last_state || '').trim().toUpperCase() === 'FINISHED'
          || child?.encodeSuccess
          || child?.outputStatus?.exists
          || Boolean(String(child?.output_path || '').trim())
          || String(child?.handbrakeInfo?.status || '').trim().toUpperCase() === 'SUCCESS'
        ));
        const ready = inputExpected >= 2 && inputReady >= inputExpected;
        let state = 'missing';
        if (active) {
          state = 'active';
        } else if (completed) {
          state = 'done';
        } else if (ready) {
          state = hasJob ? 'ready' : 'restorable';
        } else if (hasJob) {
          state = 'blocked';
        }
        return {
          hasJob,
          jobId: hasJob ? Number(mergeChildJobs[0]?.id || 0) || null : null,
          active,
          completed,
          ready,
          inputReady,
          inputExpected,
          missingInputs: Math.max(0, inputExpected - inputReady),
          state
        };
      })()
    )
    : null;
  const mergeStatusMeta = (() => {
    if (isMultipartContainer) {
      const state = String(multipartMergeSummary?.state || '').trim().toLowerCase();
      const inputReady = Number(multipartMergeSummary?.inputReady || 0);
      const inputExpected = Number(multipartMergeSummary?.inputExpected || 0);
      const countSuffix = inputExpected > 0 ? ` (${inputReady}/${inputExpected})` : '';
      if (state === 'active') {
        return { tone: 'info', icon: 'pi-spinner pi-spin', label: `Aktiv${countSuffix}` };
      }
      if (state === 'done') {
        return { tone: 'success', icon: 'pi-check-circle', label: 'Ja' };
      }
      if (state === 'ready' || state === 'restorable') {
        return { tone: 'warning', icon: 'pi-play-circle', label: `Bereit${countSuffix}` };
      }
      return { tone: 'danger', icon: 'pi-times-circle', label: `Nein${countSuffix}` };
    }
    if (isMultipartMergeJob) {
      const mergeStatus = String(job?.status || job?.last_state || '').trim().toUpperCase();
      if (mergeStatus === 'ENCODING') {
        return { tone: 'info', icon: 'pi-spinner pi-spin', label: 'Aktiv' };
      }
      if (
        mergeStatus === 'FINISHED'
        || job?.encodeSuccess
        || job?.outputStatus?.exists
        || Boolean(String(job?.output_path || '').trim())
      ) {
        return { tone: 'success', icon: 'pi-check-circle', label: 'Ja' };
      }
      if (mergeStatus === 'READY_TO_START' || mergeStatus === 'READY_TO_ENCODE') {
        return { tone: 'warning', icon: 'pi-play-circle', label: 'Bereit' };
      }
      return { tone: 'danger', icon: 'pi-times-circle', label: 'Nein' };
    }
    return null;
  })();
  const canRestoreMultipartMerge = Boolean(
    isMultipartContainer
    && mergeChildJobs.length === 0
    && Number(multipartMergeSummary?.inputExpected || 0) >= 2
    && Number(multipartMergeSummary?.inputReady || 0) >= Number(multipartMergeSummary?.inputExpected || 0)
  );
  const displayedImdbId = metadataDetails?.imdbId || job?.imdb_id || null;
  const metadataJsonTitle = 'TMDb Info';
  const metadataJsonValue = metadataContext?.selectedMetadata?.tmdbDetails || metadataContext?.selectedMetadata || null;
  const metadataAssignProvider = isDvdSeries
    ? 'tmdb'
    : 'tmdb';
  const metadataAssignButtonLabel = 'TMDb neu zuweisen';
  const metadataAssignActionDescription = metadataAssignProvider === 'tmdb'
    ? 'Öffnet die TMDb-Suche, um Metadaten (Titel, Staffel/Episoden bzw. Film) neu zuzuweisen.'
    : 'Öffnet die TMDb-Suche, um Metadaten neu zuzuweisen.';
  const configuredSelection = buildConfiguredScriptAndChainSelection(job);
  const hasConfiguredSelection = configuredSelection.preScriptIds.length > 0
    || configuredSelection.postScriptIds.length > 0
    || configuredSelection.preChainIds.length > 0
    || configuredSelection.postChainIds.length > 0;
  const encodePlanUserPreset = job?.encodePlan?.userPreset && typeof job.encodePlan.userPreset === 'object'
    ? job.encodePlan.userPreset
    : null;
  const reviewSelectedEncodeTitleId = job?.encodePlan?.encodeInputTitleId ?? null;
  const encodePlanTitles = Array.isArray(job?.encodePlan?.titles) ? job.encodePlan.titles : [];
  const selectedEncodeTitles = encodePlanTitles.filter(
    (title) => title.selectedForEncode || title.encodeInput || String(title.id) === String(reviewSelectedEncodeTitleId)
  );
  const trackDisplayTitles = selectedEncodeTitles.length > 0 ? selectedEncodeTitles : encodePlanTitles;
  const executedHandBrakeCommand = buildExecutedHandBrakeCommand(job?.handbrakeInfo);
  const posterUrl = String(
    job?.poster_url
    || metadataContext?.selectedMetadata?.poster
    || metadataContext?.selectedMetadata?.coverUrl
    || metadataContext?.selectedMetadata?.posterUrl
    || job?.encodePlan?.metadata?.poster
    || ''
  ).trim() || null;
  const resolvedRawPath = job?.rawStatus?.path || job?.raw_path || null;
  const jobMediaType = resolveMediaType(job);
  const isDiscMediaJob = ['dvd', 'bluray', 'cd'].includes(jobMediaType);
  const jobStatusUpper = String(job?.status || '').trim().toUpperCase();
  const outputDownloadReady = Boolean(
    job?.output_path
    && job?.outputStatus?.exists
    && !isIncompleteOutputPath(job.output_path)
    && (job?.encodeSuccess || jobStatusUpper === 'FINISHED')
  );
  const rawDownloadReady = Boolean(
    resolvedRawPath
    && job?.rawStatus?.exists
    && job?.rawStatus?.isEmpty !== true
    && !isIncompleteRawPath(resolvedRawPath)
    && (!isDiscMediaJob || Boolean(job?.ripSuccessful))
  );
  const canDownloadRaw = Boolean(rawDownloadReady && typeof onDownloadArchive === 'function');
  const canDownloadOutput = Boolean(outputDownloadReady && typeof onDownloadArchive === 'function');
  const outputFolders = (() => {
    const baseFolders = Array.isArray(job?.outputFolders) ? job.outputFolders : [];
    if (!isDiskContainer) {
      return baseFolders;
    }
    const merged = [];
    const seen = new Set();
    const addFolder = (folder, fallbackId = null) => {
      const outputPath = String(folder?.output_path || '').trim();
      if (!outputPath || seen.has(outputPath)) {
        return;
      }
      seen.add(outputPath);
      merged.push({
        id: folder?.id ?? fallbackId ?? outputPath,
        output_path: outputPath,
        job_id: normalizePositiveInteger(folder?.job_id ?? folder?.jobId ?? null) || null,
        exists: folder?.exists === undefined ? undefined : Boolean(folder?.exists)
      });
    };
    for (const folder of baseFolders) {
      addFolder(folder);
    }
    for (const child of childJobs) {
      const childOutputFolders = Array.isArray(child?.outputFolders) ? child.outputFolders : [];
      for (const childFolder of childOutputFolders) {
        addFolder(
          {
            ...childFolder,
            job_id: childFolder?.job_id ?? child?.id ?? null
          },
          `child-folder-${child?.id || 'x'}-${String(childFolder?.output_path || '')}`
        );
      }
      if (child?.output_path) {
        addFolder(
          { output_path: child.output_path, job_id: child?.id ?? null },
          `child-output-${child?.id || 'x'}-${String(child.output_path || '')}`
        );
      }
    }
    return merged;
  })();
  const mergeOutputPathCandidates = new Set(
    [
      ...(isMultipartMergeJob ? [job?.output_path] : []),
      ...(isMultipartContainer ? mergeChildJobs.map((child) => child?.output_path) : [])
    ]
      .map((value) => normalizePathForCompare(value))
      .filter(Boolean)
  );
  const hasAnyOutputFolder = outputFolders.length > 0 || Boolean(job?.outputStatus?.exists);
  const mergeToolLogFallback = isMultipartMergeJob ? buildMergeToolLogFallback(job) : '';
  const canShowGeneralEncodeActions = canResumeReady
    || typeof onRestartEncode === 'function'
    || typeof onRestartReview === 'function'
    || typeof onReencode === 'function';
  const isContainerWithDiskActions = isDiskContainer && childJobs.length > 0;
  const resolveChildActionState = (child) => {
    const childStatusUpper = String(child?.status || '').trim().toUpperCase();
    const childLastStateUpper = String(child?.last_state || '').trim().toUpperCase();
    const childErrorMessageLower = String(child?.error_message || '').trim().toLowerCase();
    const childRunning = ['ANALYZING', 'RIPPING', 'MEDIAINFO_CHECK', 'ENCODING', 'CD_RIPPING', 'CD_ENCODING'].includes(childStatusUpper);
    const childCanResumeReady = Boolean(
      (childStatusUpper === 'READY_TO_ENCODE' || childLastStateUpper === 'READY_TO_ENCODE')
      && !childRunning
      && typeof onResumeReady === 'function'
    );
    const childMediaType = resolveMediaType(child);
    const childMkDone = Boolean(child?.ripSuccessful) || !child?.makemkvInfo || child?.makemkvInfo?.status === 'SUCCESS';
    const childHasReencodeRawInput = childMediaType === 'cd'
      ? Boolean(child?.rawStatus?.exists || child?.raw_path || child?.output_path)
      : Boolean(child?.rawStatus?.exists && child?.rawStatus?.isEmpty !== true);
    const childCanReencode = !!(childHasReencodeRawInput && !childRunning && (childMediaType === 'cd' || childMkDone));
    const childHasConfirmedPlan = Boolean(
      child?.encodePlan
      && Array.isArray(child?.encodePlan?.titles)
      && child?.encodePlan?.titles.length > 0
      && Number(child?.encode_review_confirmed || 0) === 1
    );
    const childHasRestartInput = Boolean(child?.encode_input_path || child?.raw_path || child?.encodePlan?.encodeInputPath);
    const childHasRaw = Boolean(child?.rawStatus?.exists || child?.raw_path || child?.encode_input_path);
    const childCanRestartEncode = Boolean(childHasConfirmedPlan && childHasRestartInput && !childRunning && childHasRaw);
    const childRetryRipRecoveryReason = (
      childErrorMessageLower.includes('server-neustart')
      || childErrorMessageLower.includes('rip ist unvollständig')
      || childErrorMessageLower.includes('rip-validierung fehlgeschlagen')
    );
    const childRetryRipRequired = Boolean(
      !childRunning
      && childMediaType !== 'audiobook'
      && childMediaType !== 'converter'
      && ['ERROR', 'CANCELLED'].includes(childStatusUpper)
      && (
        ['RIPPING', 'CD_RIPPING'].includes(childLastStateUpper)
        || childRetryRipRecoveryReason
      )
    );
    const childCanRestartReview = Boolean(
      child?.rawStatus?.exists
      && child?.rawStatus?.isEmpty !== true
      && !childRunning
      && childMediaType !== 'audiobook'
      && !childRetryRipRequired
      && typeof onRestartReview === 'function'
    );
    const childCanAssignMetadata = !childRunning && !childRetryRipRequired;
    const childCanRetry = !childRunning && typeof onRetry === 'function' && (childMediaType === 'cd' || childRetryRipRequired);
    const childOutputFolders = Array.isArray(child?.outputFolders) ? child.outputFolders : [];
    const childSeriesOutputExisting = Number(child?.seriesOutputSummary?.existing || 0);
    const childHasAnyOutput = childOutputFolders.length > 0
      || childSeriesOutputExisting > 0
      || Boolean(child?.outputStatus?.exists || child?.output_path);
    return {
      childRunning,
      childCanResumeReady,
      childCanReencode,
      childCanRestartEncode,
      childCanRestartReview,
      childCanAssignMetadata,
      childCanRetry,
      childRetryRipRequired,
      childHasRaw,
      childHasAnyOutput
    };
  };
  const useAudioPosterLayout = isCd || isAudiobook || (isConverter && converterMediaType === 'audio');
  const dialogHeader = (
    <span className="job-step-cell">
      <span>{`Job #${job?.id || ''}`}</span>
      {isMultipartJob ? (
        <img src={mergeIndicatorIcon} alt="Multipart" title="Multipart" className="media-indicator-icon" />
      ) : null}
    </span>
  );

  return (
    <Dialog
      header={dialogHeader}
      visible={visible}
      onHide={onHide}
      style={{ width: '70rem', maxWidth: '96vw' }}
      className="job-detail-dialog"
      breakpoints={{ '1440px': '94vw', '1024px': '96vw', '640px': '98vw' }}
      modal
    >
      {!job ? null : (
        <div className="job-detail-body">
          {detailLoading ? <p>Details werden geladen ...</p> : null}

          <div className="job-head-row">
            {posterUrl && posterUrl !== 'N/A' ? (
              <img src={posterUrl} alt={job.title || 'Poster'} className={useAudioPosterLayout ? 'poster-large-audio' : 'poster-large'} />
            ) : (
              <div className={`${useAudioPosterLayout ? 'poster-large-audio' : 'poster-large'} poster-fallback`}>{useAudioPosterLayout ? 'Kein Cover' : 'Kein Poster'}</div>
            )}

            <div className="job-film-info-grid">
              {isCd ? (
                <section className="job-meta-block job-meta-block-film">
                  <h4>Musik-Infos</h4>
                  <div className="job-meta-list">
                    <div className="job-meta-item">
                      <strong>Album:</strong>
                      <span>{job.title || job.detected_title || cdDetails?.album || '-'}</span>
                    </div>
                    <div className="job-meta-item">
                      <strong>Interpret:</strong>
                      <span>{cdDetails?.artist || '-'}</span>
                    </div>
                    <div className="job-meta-item">
                      <strong>Jahr:</strong>
                      <span>{job.year || '-'}</span>
                    </div>
                    <div className="job-meta-item">
                      <strong>Tracks:</strong>
                      <span>
                        {cdDetails?.trackCount > 0
                          ? (cdDetails.selectedTrackCount > 0 && cdDetails.selectedTrackCount !== cdDetails.trackCount
                            ? `${cdDetails.selectedTrackCount}/${cdDetails.trackCount}`
                            : String(cdDetails.trackCount))
                          : '-'}
                      </span>
                    </div>
                    <div className="job-meta-item">
                      <strong>Format:</strong>
                      <span>{cdDetails?.formatLabel || '-'}</span>
                    </div>
                    <div className="job-meta-item">
                      <strong>Gesamtdauer:</strong>
                      <span>{cdDetails?.totalDurationLabel || '-'}</span>
                    </div>
                    <div className="job-meta-item">
                      <strong>MusicBrainz ID:</strong>
                      <span>{cdDetails?.mbId || '-'}</span>
                    </div>
                    <div className="job-meta-item">
                      <strong>Medium:</strong>
                      <span className="job-step-cell">
                        <img src={mediaTypeIcon} alt={mediaTypeAlt} title={mediaTypeLabel} className="media-indicator-icon" />
                        <span>{mediaTypeLabel}</span>
                      </span>
                    </div>
                  </div>
                </section>
              ) : isConverter ? (
                <section className="job-meta-block job-meta-block-film">
                  <h4>{converterMediaType === 'audio' ? 'Converter Audio' : 'Converter Video'}</h4>
                  <div className="job-meta-list">
                    <div className="job-meta-item">
                      <strong>Titel:</strong>
                      <span>{job.title || converterMetadata?.albumTitle || (job?.id ? `Job #${job.id}` : '-')}</span>
                    </div>
                    <div className="job-meta-item">
                      <strong>Typ:</strong>
                      <span>{converterMediaTypeLabel}</span>
                    </div>
                    <div className="job-meta-item">
                      <strong>Eingaben:</strong>
                      <span>{converterInputPaths.length > 0 ? `${converterInputPaths.length} Datei${converterInputPaths.length !== 1 ? 'en' : ''}` : '-'}</span>
                    </div>
                    <div className="job-meta-item">
                      <strong>Format:</strong>
                      <span>{converterOutputFormat ? converterOutputFormat.toUpperCase() : '-'}</span>
                    </div>
                    {converterMediaType === 'audio' ? (
                      <>
                        <div className="job-meta-item">
                          <strong>Album:</strong>
                          <span>{converterMetadata?.albumTitle || job?.title || (job?.id ? `Job #${job.id}` : '-')}</span>
                        </div>
                        <div className="job-meta-item">
                          <strong>Interpret:</strong>
                          <span>{converterMetadata?.albumArtist || '-'}</span>
                        </div>
                        <div className="job-meta-item">
                          <strong>Jahr:</strong>
                          <span>{converterMetadata?.albumYear || job?.year || '-'}</span>
                        </div>
                        <div className="job-meta-item">
                          <strong>Tracks:</strong>
                          <span>{converterTrackList.length > 0 ? converterTrackList.length : converterInputPaths.length || '-'}</span>
                        </div>
                        <div className="job-meta-item">
                          <strong>Qualität:</strong>
                          <span>{converterAudioQualityLabel || '-'}</span>
                        </div>
                      </>
                    ) : (
                      <>
                        <div className="job-meta-item">
                          <strong>Preset:</strong>
                          <span>{converterPresetLabel || '-'}</span>
                        </div>
                        <div className="job-meta-item">
                          <strong>HandBrake Titel:</strong>
                          <span>{converterPlan?.handBrakeTitleId || '-'}</span>
                        </div>
                      </>
                    )}
                    <div className="job-meta-item">
                      <strong>Medium:</strong>
                      <span className="job-step-cell">
                        <img src={mediaTypeIcon} alt={mediaTypeAlt} title={mediaTypeLabel} className="media-indicator-icon" />
                        <span>{mediaTypeLabel}</span>
                      </span>
                    </div>
                  </div>
                </section>
              ) : (
                <>
                  <section className="job-meta-block job-meta-block-film">
                    <h4>{isAudiobook ? 'Audiobook-Infos' : (isDvdSeries ? 'Serieninfos' : 'Film-Infos')}</h4>
                    <div className="job-meta-list">
                      <div className="job-meta-item">
                        <strong>Titel:</strong>
                        <span>{job.title || job.detected_title || '-'}</span>
                      </div>
                      {isDvdSeries ? (
                        <div className="job-meta-item">
                          <strong>Staffel:</strong>
                          <span>{metadataContext?.selectedMetadata?.seasonNumber ?? '-'}</span>
                        </div>
                      ) : null}
                      {isDvdSeries ? (
                        <div className="job-meta-item">
                          <strong>{isSeriesContainer ? 'Container' : 'Disk'}:</strong>
                          <span>{isSeriesContainer ? 'Ja' : (seriesDiscNumber ? `Disk ${seriesDiscNumber}` : '-')}</span>
                        </div>
                      ) : null}
                      <div className="job-meta-item">
                        <strong>Jahr:</strong>
                        <span>{job.year || '-'}</span>
                      </div>
                      {isAudiobook ? (
                        <>
                          <div className="job-meta-item">
                            <strong>Autor:</strong>
                            <span>{audiobookDetails?.author || '-'}</span>
                          </div>
                          <div className="job-meta-item">
                            <strong>Sprecher:</strong>
                            <span>{audiobookDetails?.narrator || '-'}</span>
                          </div>
                          <div className="job-meta-item">
                            <strong>Serie:</strong>
                            <span>{audiobookDetails?.series || '-'}</span>
                          </div>
                          <div className="job-meta-item">
                            <strong>Teil:</strong>
                            <span>{audiobookDetails?.part || '-'}</span>
                          </div>
                          <div className="job-meta-item">
                            <strong>Kapitel:</strong>
                            <span>{audiobookDetails?.chapterCount || '-'}</span>
                          </div>
                          <div className="job-meta-item">
                            <strong>Format:</strong>
                            <span>{audiobookDetails?.formatLabel || '-'}</span>
                          </div>
                          <div className="job-meta-item">
                            <strong>Qualität:</strong>
                            <span>{audiobookDetails?.qualityLabel || '-'}</span>
                          </div>
                        </>
                      ) : (
                        <>
                          <div className="job-meta-item">
                            <strong>IMDb:</strong>
                            <span>{displayedImdbId || '-'}</span>
                          </div>
                      {isDvdSeries ? (
                        <div className="job-meta-item">
                          <strong>TMDb:</strong>
                          <span>{metadataContext?.selectedMetadata?.tmdbId || '-'}</span>
                        </div>
                      ) : null}
                          <div className="job-meta-item">
                            <strong>{metadataDetails.matchLabel}:</strong>
                            <BoolState value={metadataDetails.hasMatch} />
                          </div>
                        </>
                      )}
                      <div className="job-meta-item">
                        <strong>Medium:</strong>
                        <span className="job-step-cell">
                          <img src={mediaTypeIcon} alt={mediaTypeAlt} title={mediaTypeLabel} className="media-indicator-icon" />
                          <span>{mediaTypeLabel}</span>
                        </span>
                      </div>
                    </div>
                  </section>

                  {!isAudiobook ? (
                    <section className="job-meta-block job-meta-block-film">
                      <h4>{metadataDetails.title}</h4>
                      <div className="job-meta-list">
                        <div className="job-meta-item">
                          <strong>Regisseur:</strong>
                          <span>{metadataField(metadataDetails.director)}</span>
                        </div>
                        <div className="job-meta-item">
                          <strong>Schauspieler:</strong>
                          <span>{metadataField(metadataDetails.actors)}</span>
                        </div>
                        <div className="job-meta-item">
                          <strong>Laufzeit:</strong>
                          <span>{metadataField(metadataDetails.runtime)}</span>
                        </div>
                        <div className="job-meta-item">
                          <strong>Genre:</strong>
                          <span>{metadataField(metadataDetails.genre)}</span>
                        </div>
                        <div className="job-meta-item">
                          <strong>TMDb Rating:</strong>
                          <span>{metadataField(metadataDetails.tmdbRating)}</span>
                        </div>
                      </div>
                    </section>
                  ) : null}
                </>
              )}
            </div>
          </div>

          <section className="job-meta-block job-meta-block-full">
            <div className="job-infos-header">
              <h4>Job-Infos</h4>
              <div className="job-infos-badges">
                <span>
                  <strong>Status:</strong>{' '}
                  <span
                    className={`job-status-icon tone-${statusMeta.tone}`}
                    title={statusMeta.label}
                    aria-label={statusMeta.label}
                  >
                    <i className={`pi ${statusMeta.icon}`} aria-hidden="true" />
                  </span>
                </span>
                <span className="job-infos-sep">|</span>
                {isCd ? (
                  <>
                    <span><strong>Rip:</strong> <BoolState value={job?.ripSuccessful} /></span>
                    <span className="job-infos-sep">|</span>
                    <span><strong>Backup:</strong> <BoolState value={job?.backupSuccess} /></span>
                  </>
                ) : (
                  <>
                    <span><strong>{isAudiobook || isConverter ? 'Import:' : 'Backup:'}</strong> {isDiskContainer && seriesBackupSummary ? (
                      <TriState existing={seriesBackupSummary.existing} expected={seriesBackupSummary.expected} />
                    ) : (
                      <BoolState value={job?.backupSuccess} />
                    )}</span>
                    <span className="job-infos-sep">|</span>
                    <span><strong>Encode:</strong> {isDiskContainer && seriesEncodeSummary ? (
                      <TriState existing={seriesEncodeSummary.existing} expected={seriesEncodeSummary.expected} />
                    ) : (
                      <BoolState value={job?.encodeSuccess} />
                    )}</span>
                    {mergeStatusMeta ? (
                      <>
                        <span className="job-infos-sep">|</span>
                        <span>
                          <strong>Merge:</strong>{' '}
                          <span
                            className={`job-status-icon tone-${mergeStatusMeta.tone}`}
                            title={mergeStatusMeta.label}
                            aria-label={mergeStatusMeta.label}
                          >
                            <i className={`pi ${mergeStatusMeta.icon}`} aria-hidden="true" />
                          </span>
                        </span>
                      </>
                    ) : null}
                  </>
                )}
              </div>
            </div>
            <div className="job-infos-layout">
              {/* Zeile 1: Start | Ende */}
                <div><strong>Start:</strong> {job.start_time || '-'}</div>
                <div><strong>Ende:</strong> {job.end_time || '-'}</div>
              {/* Zeile 3+4: Pfade */}
              {!isDiskContainer && !isMultipartMergeJob ? (
                <PathField
                  label={isCd ? 'WAV:' : (isConverter ? 'Input:' : 'RAW:')}
                  value={isCd ? (job.raw_path || job.output_path) : resolvedRawPath}
                  onDownload={canDownloadRaw ? () => onDownloadArchive?.(job, 'raw') : null}
                  downloadDisabled={!canDownloadRaw}
                  downloadLoading={downloadBusyTarget === 'raw'}
                />
              ) : null}
              {isDiskContainer && childJobs.length > 0 ? (
                childJobs.map((child) => {
                  const childDiscNumber = resolveSeriesDiscNumber(child);
                  const childLabel = childDiscNumber ? `Disk ${childDiscNumber} RAW:` : 'Disk RAW:';
                  const childRawPath = child?.raw_path || child?.output_path || null;
                  const childMediaType = resolveMediaType(child);
                  const childIsDiscMedia = ['dvd', 'bluray', 'cd'].includes(childMediaType);
                  const childRawDownloadReady = Boolean(
                    childRawPath
                    && child?.rawStatus?.exists
                    && child?.rawStatus?.isEmpty !== true
                    && !isIncompleteRawPath(childRawPath)
                    && (!childIsDiscMedia || Boolean(child?.ripSuccessful))
                  );
                  const canDownloadChildRaw = Boolean(childRawDownloadReady && typeof onDownloadArchive === 'function');
                  return (
                    <PathField
                      key={`child-raw-${child.id}`}
                      label={childLabel}
                      value={childRawPath}
                      onDownload={canDownloadChildRaw ? () => onDownloadArchive?.(child, 'raw') : null}
                      downloadDisabled={!canDownloadChildRaw}
                      downloadLoading={downloadBusyTarget === 'raw'}
                    />
                  );
                })
              ) : null}
              {outputFolders.length > 0 ? (
                outputFolders.map((folder, idx) => {
                  const folderPath = String(folder?.output_path || '').trim();
                  if (!folderPath) {
                    return null;
                  }
                  const folderOwnerJobId = normalizePositiveInteger(folder?.job_id) || normalizePositiveInteger(job?.id);
                  const folderOwner = folderOwnerJobId === normalizePositiveInteger(job?.id)
                    ? job
                    : (childJobs.find((child) => normalizePositiveInteger(child?.id) === folderOwnerJobId) || job);
                  const folderOwnerStatusUpper = String(folderOwner?.status || '').trim().toUpperCase();
                  const folderExists = folder?.exists !== undefined
                    ? Boolean(folder?.exists)
                    : Boolean(folderOwner?.outputStatus?.exists);
                  const folderDownloadReady = Boolean(
                    folderExists
                    && !isIncompleteOutputPath(folderPath)
                    && (folderOwner?.encodeSuccess || folderOwnerStatusUpper === 'FINISHED')
                  );
                  const normalizedFolderPath = normalizePathForCompare(folderPath);
                  const isMergeOutput = Boolean(
                    (normalizedFolderPath && mergeOutputPathCandidates.has(normalizedFolderPath))
                    || /_merged\.[^/.]+$/i.test(folderPath)
                  );
                  const outputLabel = outputFolders.length > 1 ? `Output ${idx + 1}` : 'Output';
                  const label = isMergeOutput ? `${outputLabel} (Merge):` : `${outputLabel}:`;
                  const canDownloadFolder = Boolean(folderDownloadReady && typeof onDownloadOutputFolder === 'function');
                  return (
                    <PathField
                      key={folder.id || folderPath}
                      label={label}
                      value={folderPath}
                      onDownload={canDownloadFolder ? () => onDownloadOutputFolder?.(job, folderPath, folderOwnerJobId) : null}
                      downloadDisabled={!canDownloadFolder}
                      downloadLoading={downloadFolderBusyPath === folderPath}
                    />
                  );
                })
              ) : (
                <PathField
                  label={isMultipartMergeJob ? 'Output (Merge):' : 'Output:'}
                  value={job.output_path}
                  onDownload={canDownloadOutput ? () => onDownloadArchive?.(job, 'output') : null}
                  downloadDisabled={!canDownloadOutput}
                  downloadLoading={downloadBusyTarget === 'output'}
                />
              )}
              {job.error_message ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
                  <span><strong>Fehler:</strong> {job.error_message}</span>
                  {typeof onAcknowledgeError === 'function' ? (
                    <Button
                      icon="pi pi-check-circle"
                      rounded
                      text
                      size="small"
                      severity="success"
                      title="Fehler quittieren"
                      aria-label="Fehler quittieren"
                      onClick={() => onAcknowledgeError(job)}
                      loading={acknowledgeErrorBusy}
                      disabled={acknowledgeErrorBusy}
                    />
                  ) : null}
                </div>
              ) : null}
            </div>
          </section>

          {isConverter ? (
            <section className="job-meta-block job-meta-block-full">
              <h4>Encode-Konfiguration</h4>
              <div className="job-meta-grid job-meta-grid-compact">
                <div>
                  <strong>Typ:</strong> {converterMediaTypeLabel}
                </div>
                <div>
                  <strong>Format:</strong> {converterOutputFormat ? converterOutputFormat.toUpperCase() : '-'}
                </div>
                <div>
                  <strong>Eingabe-Modus:</strong> {converterPlan?.isFolder ? 'Ordner' : (converterPlan?.isSharedAudio ? 'Gemeinsam' : 'Einzeln')}
                </div>
                <div>
                  <strong>Eingabe-Dateien:</strong> {converterInputPaths.length > 0 ? converterInputPaths.length : '-'}
                </div>
                <div>
                  <strong>Preset:</strong> {converterPresetLabel || '-'}
                </div>
                <div>
                  <strong>HandBrake Titel:</strong> {converterPlan?.handBrakeTitleId || '-'}
                </div>
              </div>
              {converterMediaType === 'audio' ? (
                <div className="job-meta-grid job-meta-grid-compact">
                  <div>
                    <strong>Album:</strong> {converterMetadata?.albumTitle || job?.title || (job?.id ? `Job #${job.id}` : '-')}
                  </div>
                  <div>
                    <strong>Interpret:</strong> {converterMetadata?.albumArtist || '-'}
                  </div>
                  <div>
                    <strong>Jahr:</strong> {converterMetadata?.albumYear || job?.year || '-'}
                  </div>
                  <div>
                    <strong>Qualität:</strong> {converterAudioQualityLabel || '-'}
                  </div>
                </div>
              ) : null}
              {converterInputPaths.length > 0 ? (
                <div className="track-group">
                  {converterInputPaths.map((inputPath, index) => (
                    <div key={`${inputPath}-${index}`} className="track-item">
                      <span>#{index + 1} | {inputPath}</span>
                    </div>
                  ))}
                </div>
              ) : null}
              {converterMediaType === 'audio' && converterTrackList.length > 0 ? (
                <div className="track-group">
                  {converterTrackList.map((track, index) => {
                    const position = Number(track?.position) > 0 ? Math.trunc(Number(track.position)) : (index + 1);
                    const title = String(track?.title || '').trim() || `Track ${position}`;
                    const artist = String(track?.artist || '').trim();
                    return (
                      <div key={`${position}-${title}`} className="track-item">
                        <span>#{position} | {artist ? `${artist} - ` : ''}{title}</span>
                      </div>
                    );
                  })}
                </div>
              ) : null}
            </section>
          ) : null}

          {isDvdSeries && seriesBatchEpisodes.length > 0 ? (
            <section className="job-meta-block job-meta-block-full">
              <h4>Serien-Episoden</h4>
              <div className="series-batch-progress-wrap">
                <div className="series-batch-head">
                  <div>
                    <strong>Gesamt:</strong>{' '}
                    {`${seriesBatchSummary.finished}/${seriesBatchSummary.total} fertig`}
                    {seriesBatchSummary.running > 0 ? ` | laufend: ${seriesBatchSummary.running}` : ''}
                    {seriesBatchSummary.queued > 0 ? ` | wartend: ${seriesBatchSummary.queued}` : ''}
                    {seriesBatchSummary.error > 0 ? ` | fehler: ${seriesBatchSummary.error}` : ''}
                    {seriesBatchSummary.cancelled > 0 ? ` | abgebrochen: ${seriesBatchSummary.cancelled}` : ''}
                  </div>
                </div>
                <div className="series-batch-episodes">
                  {seriesBatchEpisodes.map((episode) => {
                    const assignment = seriesEpisodeAssignments[String(episode?.titleId)]
                      || seriesEpisodeAssignments[Number(episode?.titleId)]
                      || null;
                    const statusMeta = seriesEpisodeStatusMeta(episode?.status);
                    const episodeLabel = String(
                      episode?.label
                      || assignment?.episodeTitle
                      || `Episode ${episode?.episodeIndex || '?'}`
                    ).trim();
                    const episodeCode = (() => {
                      const seasonNo = normalizePositiveInteger(assignment?.seasonNumber ?? episode?.seasonNumber);
                      const episodeNoRaw = Number(assignment?.episodeNumber ?? episode?.episodeNumber);
                      const episodeNo = Number.isFinite(episodeNoRaw) && episodeNoRaw > 0
                        ? episodeNoRaw
                        : null;
                      if (!seasonNo && !episodeNo) {
                        return null;
                      }
                      const seasonToken = seasonNo ? String(seasonNo).padStart(2, '0') : '--';
                      const episodeToken = episodeNo
                        ? (
                          Number.isInteger(episodeNo)
                            ? String(Math.trunc(episodeNo)).padStart(2, '0')
                            : String(episodeNo)
                        )
                        : '--';
                      return `S${seasonToken}E${episodeToken}`;
                    })();
                    const trackSelection = episode?.trackSelection && typeof episode.trackSelection === 'object'
                      ? episode.trackSelection
                      : null;
                    const audioTrackIds = Array.isArray(trackSelection?.audioTrackIds) ? trackSelection.audioTrackIds : [];
                    const subtitleTrackIds = Array.isArray(trackSelection?.subtitleTrackIds) ? trackSelection.subtitleTrackIds : [];
                    const subtitleForcedIndexes = Array.isArray(trackSelection?.subtitleForcedTrackIndexes)
                      ? trackSelection.subtitleForcedTrackIndexes
                      : [];
                    const episodeCommand = buildExecutedHandBrakeCommand(episode?.handbrakeInfo);
                    const boundedProgress = Number.isFinite(Number(episode?.progress))
                      ? Math.max(0, Math.min(100, Number(episode.progress)))
                      : 0;
                    return (
                      <details key={`series-episode-${episode.episodeIndex}-${episode.titleId || 'na'}`} className="episode-track-accordion">
                        <summary className="series-batch-episode-head">
                          <span className="series-batch-episode-title">
                            {`#${episode?.episodeIndex || '?'} | ${episodeLabel}${episodeCode ? ` | ${episodeCode}` : ''}${seriesDiscNumber ? ` | Disk ${seriesDiscNumber}` : ''}`}
                          </span>
                          <Tag value={statusMeta.label} severity={statusMeta.severity} />
                        </summary>
                        <div className="track-group">
                          <div className="track-item">
                            <span><strong>Titel-ID:</strong> {episode?.titleId || '-'}</span>
                          </div>
                          <div className="track-item">
                            <span><strong>Fortschritt:</strong> {`${Math.trunc(boundedProgress)}%`}</span>
                          </div>
                          <div className="track-item">
                            <span><strong>Gestartet:</strong> {formatDateTimeOrDash(episode?.startedAt)}</span>
                          </div>
                          <div className="track-item">
                            <span><strong>Beendet:</strong> {formatDateTimeOrDash(episode?.finishedAt)}</span>
                          </div>
                          <div className="track-item">
                            <span><strong>Audio-Spuren:</strong> {audioTrackIds.length > 0 ? audioTrackIds.join(', ') : '-'}</span>
                          </div>
                          <div className="track-item">
                            <span><strong>Subtitle-Spuren:</strong> {subtitleTrackIds.length > 0 ? subtitleTrackIds.join(', ') : '-'}</span>
                          </div>
                          <div className="track-item">
                            <span><strong>Subtitle Forced-Index:</strong> {subtitleForcedIndexes.length > 0 ? subtitleForcedIndexes.join(', ') : '-'}</span>
                          </div>
                          {episode?.outputPath ? (
                            <div className="track-item">
                              <span><strong>Output:</strong> {episode.outputPath}</span>
                            </div>
                          ) : null}
                          {episode?.error ? (
                            <div className="track-item">
                              <span><strong>Fehler:</strong> {episode.error}</span>
                            </div>
                          ) : null}
                          {episodeCommand ? (
                            <div className="track-item">
                              <span><strong>Command:</strong> {episodeCommand}</span>
                            </div>
                          ) : null}
                          <div className="track-item">
                            <small className="track-action-note">Hinweis: Alle Episoden-Logs liegen im Hauptjob-Log.</small>
                          </div>
                        </div>
                      </details>
                    );
                  })}
                </div>
              </div>
            </section>
          ) : null}

          {!isCd && !isAudiobook && !isConverter && (hasConfiguredSelection || encodePlanUserPreset || job.encodePlan?.minLengthMinutes != null || Array.isArray(job.encodePlan?.titles)) ? (
            <section className="job-meta-block job-meta-block-full">
              <h4>Encode-Konfiguration</h4>
              {/* Zeile 1: Preset + Mindestlaufzeit */}
              <div className="job-meta-grid job-meta-grid-compact">
                {encodePlanUserPreset ? (
                  <div>
                    <strong>Preset:</strong> {encodePlanUserPreset.name || '-'}
                  </div>
                ) : null}
                {job.encodePlan?.minLengthMinutes != null ? (
                  <div>
                    <strong>Mindestlaufzeit:</strong> {job.encodePlan.minLengthMinutes} Min.
                  </div>
                ) : null}
              </div>
              {/* Zeile 2: Skripte */}
              {hasConfiguredSelection ? (
                <div className="job-meta-grid job-meta-grid-compact">
                  <div>
                    <strong>Pre-Skripte:</strong>{' '}
                    {configuredSelection.preScripts.length > 0
                      ? configuredSelection.preScripts.join(', ')
                      : configuredSelection.preChains.length > 0
                        ? configuredSelection.preChains.join(', ')
                        : '-'}
                  </div>
                  <div>
                    <strong>Post-Skripte:</strong>{' '}
                    {configuredSelection.postScripts.length > 0
                      ? configuredSelection.postScripts.join(', ')
                      : configuredSelection.postChains.length > 0
                        ? configuredSelection.postChains.join(', ')
                        : '-'}
                  </div>
                </div>
              ) : null}
              {/* Spurauswahl – read-only */}
              {trackDisplayTitles.length > 0 ? (
                isDvdSeries ? (
                  <details className="episode-track-accordion">
                    <summary className="series-batch-episode-head">
                      <span className="series-batch-episode-title">{seriesDiscLabel}</span>
                    </summary>
                    <div className="spurauswahl-block">
                      <div className="spurauswahl-label">Spurauswahl</div>
                      {trackDisplayTitles.map((title) => {
                        const audioTracks = Array.isArray(title.audioTracks) ? title.audioTracks : [];
                        const subtitleTracks = Array.isArray(title.subtitleTracks) ? title.subtitleTracks : [];
                        const trackSelection = buildEffectiveTitleTrackSelection(job?.encodePlan, title);
                        return (
                          <div key={title.id} className="track-title-block">
                            <div className="track-title-row">
                              <span>#{title.id} | {title.fileName} | {title.durationMinutes != null ? `${Number(title.durationMinutes).toFixed(2)} min` : '-'}</span>
                            </div>
                            <div className="track-groups-row">
                              {audioTracks.length > 0 ? (
                                <div className="track-group">
                                  <div className="track-group-label">Tonspuren (Titel #{title.id})</div>
                                  {audioTracks.map((track) => {
                                    const lang = trackLang(track.language || track.languageLabel);
                                    const codec = trackCodec('audio', track.format, track.description || track.title);
                                    const chLayout = trackChLayout(track.channels);
                                    let displayText = `#${track.id} | ${lang} | ${codec}`;
                                    if (chLayout) displayText += ` | ${chLayout}`;
                                    const normalizedTrackId = normalizePositiveInteger(track?.id);
                                    const selected = normalizedTrackId
                                      ? trackSelection.selectedAudioSet.has(String(normalizedTrackId))
                                      : Boolean(track?.selectedForEncode);
                                    const actionInfo = getTrackActionLabel({
                                      selected,
                                      summary: track.encodeActionSummary || track.encodePreviewSummary,
                                      manualSelection: trackSelection.hasManualAudio,
                                      fallback: 'Übernehmen'
                                    });
                                    return (
                                      <div key={track.id} className="track-item">
                                        <span>{displayText}</span>
                                        <small className="track-action-note">Encode: {actionInfo}</small>
                                      </div>
                                    );
                                  })}
                                </div>
                              ) : null}
                              {subtitleTracks.length > 0 ? (
                                <div className="track-group">
                                  <div className="track-group-label">Subtitles (Titel #{title.id})</div>
                                  {subtitleTracks.map((track) => {
                                    const lang = trackLang(track.language || track.languageLabel);
                                    const codec = trackCodec('subtitle', track.format);
                                    const displayText = `#${track.id} | ${lang} | ${codec}`;
                                    const normalizedTrackId = normalizePositiveInteger(track?.id);
                                    const selected = normalizedTrackId
                                      ? trackSelection.selectedSubtitleSet.has(String(normalizedTrackId))
                                      : Boolean(track?.selectedForEncode);
                                    const actionInfo = getTrackActionLabel({
                                      selected,
                                      summary: track.subtitleActionSummary || track.subtitlePreviewSummary,
                                      manualSelection: trackSelection.hasManualSubtitle,
                                      fallback: 'Übernehmen'
                                    });
                                    return (
                                      <div key={track.id} className="track-item">
                                        <span>{displayText}</span>
                                        <small className="track-action-note">Encode: {actionInfo}</small>
                                      </div>
                                    );
                                  })}
                                </div>
                              ) : null}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </details>
                ) : (
                  <div className="spurauswahl-block">
                    <div className="spurauswahl-label">Spurauswahl</div>
                    {trackDisplayTitles.map((title) => {
                      const audioTracks = Array.isArray(title.audioTracks) ? title.audioTracks : [];
                      const subtitleTracks = Array.isArray(title.subtitleTracks) ? title.subtitleTracks : [];
                      const trackSelection = buildEffectiveTitleTrackSelection(job?.encodePlan, title);
                      return (
                        <div key={title.id} className="track-title-block">
                          <div className="track-title-row">
                            <span>#{title.id} | {title.fileName} | {title.durationMinutes != null ? `${Number(title.durationMinutes).toFixed(2)} min` : '-'}</span>
                          </div>
                          <div className="track-groups-row">
                            {audioTracks.length > 0 ? (
                              <div className="track-group">
                                <div className="track-group-label">Tonspuren (Titel #{title.id})</div>
                                {audioTracks.map((track) => {
                                  const lang = trackLang(track.language || track.languageLabel);
                                  const codec = trackCodec('audio', track.format, track.description || track.title);
                                  const chLayout = trackChLayout(track.channels);
                                  let displayText = `#${track.id} | ${lang} | ${codec}`;
                                  if (chLayout) displayText += ` | ${chLayout}`;
                                  const normalizedTrackId = normalizePositiveInteger(track?.id);
                                  const selected = normalizedTrackId
                                    ? trackSelection.selectedAudioSet.has(String(normalizedTrackId))
                                    : Boolean(track?.selectedForEncode);
                                  const actionInfo = getTrackActionLabel({
                                    selected,
                                    summary: track.encodeActionSummary || track.encodePreviewSummary,
                                    manualSelection: trackSelection.hasManualAudio,
                                    fallback: 'Übernehmen'
                                  });
                                  return (
                                    <div key={track.id} className="track-item">
                                      <span>{displayText}</span>
                                      <small className="track-action-note">Encode: {actionInfo}</small>
                                    </div>
                                  );
                                })}
                              </div>
                            ) : null}
                            {subtitleTracks.length > 0 ? (
                              <div className="track-group">
                                <div className="track-group-label">Subtitles (Titel #{title.id})</div>
                                {subtitleTracks.map((track) => {
                                  const lang = trackLang(track.language || track.languageLabel);
                                  const codec = trackCodec('subtitle', track.format);
                                  const displayText = `#${track.id} | ${lang} | ${codec}`;
                                  const normalizedTrackId = normalizePositiveInteger(track?.id);
                                  const selected = normalizedTrackId
                                    ? trackSelection.selectedSubtitleSet.has(String(normalizedTrackId))
                                    : Boolean(track?.selectedForEncode);
                                  const actionInfo = getTrackActionLabel({
                                    selected,
                                    summary: track.subtitleActionSummary || track.subtitlePreviewSummary,
                                    manualSelection: trackSelection.hasManualSubtitle,
                                    fallback: 'Übernehmen'
                                  });
                                  return (
                                    <div key={track.id} className="track-item">
                                      <span>{displayText}</span>
                                      <small className="track-action-note">Encode: {actionInfo}</small>
                                    </div>
                                  );
                                })}
                              </div>
                            ) : null}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )
              ) : null}
            </section>
          ) : null}

          {(isCd || isAudiobook) && job.encodePlan ? (
            <section className="job-meta-block job-meta-block-full">
              <h4>{isCd ? 'Titelauswahl' : 'Kapitelauswahl'}</h4>
              {isCd ? (() => {
                const tracksRaw = Array.isArray(job.makemkvInfo?.tracks) && job.makemkvInfo.tracks.length > 0
                  ? job.makemkvInfo.tracks
                  : (Array.isArray(job.encodePlan?.tracks) ? job.encodePlan.tracks : []);
                const selectedSet = Array.isArray(job.encodePlan?.selectedTracks) && job.encodePlan.selectedTracks.length > 0
                  ? new Set(job.encodePlan.selectedTracks.map(Number))
                  : null;
                const encodeResultMap = new Map(
                  (Array.isArray(job.handbrakeInfo?.tracks) ? job.handbrakeInfo.tracks : [])
                    .map((r) => [Number(r.position), r])
                );
                if (tracksRaw.length === 0) return <p className="job-meta-subtle">Keine Tracks vorhanden.</p>;
                return (
                  <div className="track-group">
                    {tracksRaw.map((track, i) => {
                      const pos = Number(track.position ?? (i + 1));
                      const label = String(track.title || track.name || `Track ${pos}`).trim();
                      const artist = String(track.artist || '').trim() || String(job?.makemkvInfo?.selectedMetadata?.artist || '').trim();
                      const selected = selectedSet ? selectedSet.has(pos) : track.selected !== false;
                      const encodeResult = encodeResultMap.get(pos);
                      const outcome = !selected
                        ? null
                        : encodeResult
                          ? (encodeResult.success ? 'success' : 'error')
                          : (job?.ripSuccessful != null ? (job.ripSuccessful ? 'success' : 'error') : null);
                      return (
                        <div key={pos} className="track-item track-item-inline-status">
                          <span className="track-item-main">#{pos} {artist ? `${artist} - ` : ''}{label}</span>
                          <SelectionStateNote selected={selected} outcome={outcome} />
                        </div>
                      );
                    })}
                  </div>
                );
              })() : (() => {
                const audiobookFormat = String(job?.handbrakeInfo?.format || job?.encodePlan?.format || '').trim().toLowerCase();
                const isSplitAudiobook = Boolean(audiobookFormat) && audiobookFormat !== 'm4b';
                const chapters = Array.isArray(job.handbrakeInfo?.metadata?.chapters) && job.handbrakeInfo.metadata.chapters.length > 0
                  ? job.handbrakeInfo.metadata.chapters
                  : (Array.isArray(job.makemkvInfo?.chapters) && job.makemkvInfo.chapters.length > 0
                    ? job.makemkvInfo.chapters
                    : (Array.isArray(job.encodePlan?.metadata?.chapters) ? job.encodePlan.metadata.chapters : []));
                const stepsByIndex = new Map(
                  (Array.isArray(job.handbrakeInfo?.steps) ? job.handbrakeInfo.steps : [])
                    .map((s) => [Number(s.chapterIndex), s])
                );
                if (chapters.length === 0) return <p className="job-meta-subtle">Keine Kapitelinformationen vorhanden.</p>;
                return (
                  <div className="track-group">
                    {chapters.map((chapter, i) => {
                      const id = Number(chapter.id ?? chapter.index ?? chapter.position ?? (i + 1));
                      const label = String(chapter.title || chapter.name || `Kapitel ${id}`).trim();
                      const durationSec = Number(chapter.durationMs || 0) > 0
                        ? Number(chapter.durationMs) / 1000
                        : Number(chapter.durationSec || 0);
                      const durLabel = durationSec > 0
                        ? `${Math.floor(durationSec / 60)}:${String(Math.floor(durationSec % 60)).padStart(2, '0')} min`
                        : '-';
                      const step = stepsByIndex.get(id);
                      const stepStatus = step ? String(step.status || '').toUpperCase() : null;
                      const outcome = stepStatus === 'SUCCESS'
                        ? 'success'
                        : stepStatus === 'ERROR'
                          ? 'error'
                          : stepStatus === 'CANCELLED'
                            ? 'cancelled'
                            : (job?.encodeSuccess != null
                              ? (job.encodeSuccess ? 'success' : (String(job?.status || '').trim().toUpperCase() === 'CANCELLED' ? 'cancelled' : 'error'))
                              : null);
                      const encodeLabel = stepStatus === 'SUCCESS' ? 'Erfolgreich'
                        : stepStatus === 'ERROR' ? 'Fehler'
                        : stepStatus === 'CANCELLED' ? 'Abgebrochen'
                        : stepStatus ? stepStatus
                        : 'Übernommen';
                      const encodeClass = stepStatus === 'SUCCESS' ? 'tone-ok'
                        : stepStatus === 'ERROR' ? 'tone-no'
                        : '';
                      return (
                        <div key={id} className={`track-item${isSplitAudiobook ? ' track-item-inline-status' : ''}`}>
                          <span className={isSplitAudiobook ? 'track-item-main' : undefined}>#{id} | {label} | {durLabel}</span>
                          {isSplitAudiobook ? (
                            <SelectionStateNote selected outcome={outcome} />
                          ) : (
                            <small className={`track-action-note ${encodeClass}`}>Encode: {encodeLabel}</small>
                          )}
                        </div>
                      );
                    })}
                  </div>
                );
              })()}
            </section>
          ) : null}

          <section className="job-meta-block job-meta-block-full">
            <h4>{isDiskContainer ? 'Disks' : 'Logs'}</h4>
            {isDiskContainer && (childJobs.length > 0 || mergeChildJobs.length > 0) ? (
              <>
                <div className="job-json-grid">
                  {!isCd && !isAudiobook && !isConverter ? <JsonView title={metadataJsonTitle} value={metadataJsonValue} /> : null}
                </div>
                {childJobs.map((child) => {
                  const childDiscNumber = resolveSeriesDiscNumber(child);
                  const childDiscLabel = childDiscNumber ? `Disk ${childDiscNumber}` : 'Disk unbekannt';
                  const childActionState = resolveChildActionState(child);
                  const childOutputDeleteLabel = isMultipartContainer
                    ? 'Movie löschen (Eintrag bleibt)'
                    : 'Folgen löschen (Eintrag bleibt)';
                  const childRawDeleteDescription = isMultipartContainer
                    ? 'Löscht nur die RAW-Quelldatei dieser Disk (nicht die Movie-Subjobs).'
                    : 'Löscht nur die RAW-Quelldatei dieser Disk (nicht die Folgen-Subjobs).';
                  const childMovieDeleteDescription = isMultipartContainer
                    ? 'Löscht den encodierten Movie-Output dieser Disk (inkl. Child-/Subjobs).'
                    : 'Löscht die encodierten Folgen dieser Disk (inkl. Child-/Subjobs).';
                  const childBothDeleteDescription = isMultipartContainer
                    ? 'Löscht Disk-RAW plus Movie-Output dieser Disk gemeinsam.'
                    : 'Löscht Disk-RAW plus Folgen dieser Disk gemeinsam.';
                  const childCanShowGeneralEncodeActions = childActionState.childCanResumeReady
                    || typeof onRestartEncode === 'function'
                    || typeof onRestartReview === 'function'
                    || typeof onReencode === 'function';
                  return (
                    <details key={`child-log-${child.id}`} className="episode-track-accordion">
                      <summary className="series-batch-episode-head">
                        <span className="series-batch-episode-title">{childDiscLabel}</span>
                      </summary>
                      <div className="job-json-grid">
                        <JsonView title={isCd ? 'cdparanoia Info' : (isAudiobook ? 'Audiobook Info' : (isConverter ? 'Converter Analyze Info' : 'MakeMKV Info'))} value={child.makemkvInfo} />
                        {!isCd && !isAudiobook ? <JsonView title="Mediainfo Info" value={child.mediainfoInfo} /> : null}
                        <JsonView title={isCd ? 'Rip-Plan' : (isConverter ? 'Converter Plan' : 'Encode Plan')} value={child.encodePlan} />
                        <JsonView title={isCd ? 'Rip-Info' : (isAudiobook ? 'FFmpeg Info' : (isConverter ? 'Converter Encode Info' : 'HandBrake Info'))} value={child.handbrakeInfo} />
                      </div>
                      <div className="actions-section">
                        {childCanShowGeneralEncodeActions ? (
                          <div className="actions-group">
                            <div className="actions-group-label"><i className="pi pi-play-circle" /> Kodierung</div>
                            {childActionState.childCanResumeReady ? (
                              <div className="action-item">
                                <Button
                                  label="Im Ripper öffnen"
                                  icon="pi pi-window-maximize"
                                  severity="info"
                                  outlined
                                  size="small"
                                  onClick={() => onResumeReady?.(child)}
                                  loading={actionBusy}
                                />
                                <span className="action-desc">Öffnet den wartenden Job im Ripper zur Weiterverarbeitung.</span>
                              </div>
                            ) : null}
                            {typeof onRestartEncode === 'function' ? (
                              <div className="action-item">
                                <Button
                                  label="Encode neu starten"
                                  icon="pi pi-play"
                                  severity="success"
                                  size="small"
                                  onClick={() => onRestartEncode?.(child)}
                                  loading={actionBusy}
                                  disabled={!childActionState.childCanRestartEncode}
                                />
                                <span className="action-desc">Startet HandBrake mit den zuletzt gespeicherten Einstellungen direkt neu — ohne Review.</span>
                              </div>
                            ) : null}
                            {typeof onRestartReview === 'function' ? (
                              <div className="action-item">
                                <Button
                                  label="Spur-Auswahl öffnen"
                                  icon="pi pi-list"
                                  severity="info"
                                  outlined
                                  size="small"
                                  onClick={() => onRestartReview?.(child)}
                                  loading={actionBusy}
                                  disabled={!childActionState.childCanRestartReview}
                                />
                                <span className="action-desc">Öffnet die Spur- und Preset-Auswahl erneut, um Einstellungen vor dem Encode zu ändern.</span>
                              </div>
                            ) : null}
                            {typeof onReencode === 'function' ? (
                              <div className="action-item">
                                <Button
                                  label="Neustart"
                                  icon="pi pi-sync"
                                  severity="info"
                                  size="small"
                                  onClick={() => onReencode?.(child)}
                                  loading={reencodeBusy}
                                  disabled={!childActionState.childCanReencode}
                                />
                                <span className="action-desc">Analysiert die Quelldatei neu (MediaInfo, Playlist-Check) und öffnet dann die Spur-Auswahl. Unterschied zu „Spur-Auswahl öffnen": der Analyse-Schritt wird komplett wiederholt.</span>
                              </div>
                            ) : null}
                          </div>
                        ) : null}

                        {childActionState.childCanRetry ? (
                          <div className="actions-group">
                            <div className="actions-group-label"><i className="pi pi-refresh" /> Recovery</div>
                            <div className="action-item">
                              <Button
                                label="Retry Rip"
                                icon="pi pi-refresh"
                                severity="warning"
                                size="small"
                                onClick={() => onRetry?.(child)}
                                loading={actionBusy}
                              />
                              <span className="action-desc">Löscht das alte RAW und startet den Rip erneut.</span>
                            </div>
                          </div>
                        ) : null}

                        {!isCd && !isAudiobook && !isConverter && !childActionState.childRetryRipRequired && typeof onAssignMetadata === 'function' ? (
                          <div className="actions-group">
                            <div className="actions-group-label"><i className="pi pi-search" /> Metadaten</div>
                            <div className="action-item">
                              <Button
                                label={metadataAssignButtonLabel}
                                icon="pi pi-search"
                                severity="secondary"
                                outlined
                                size="small"
                                onClick={() => onAssignMetadata?.(child)}
                                loading={metadataAssignBusy}
                                disabled={!childActionState.childCanAssignMetadata}
                              />
                              <span className="action-desc">{metadataAssignActionDescription}</span>
                            </div>
                          </div>
                        ) : null}

                        {typeof onDeleteFiles === 'function' ? (
                          <div className="actions-group">
                            <div className="actions-group-label"><i className="pi pi-trash" /> Dateien löschen</div>
                            <div className="action-item">
                              <Button
                                label="RAW löschen (Eintrag bleibt)"
                                icon="pi pi-trash"
                                severity="warning"
                                outlined
                                size="small"
                                onClick={() => onDeleteFiles?.(child, 'raw')}
                                loading={actionBusy}
                                disabled={!childActionState.childHasRaw}
                              />
                              <span className="action-desc">{childRawDeleteDescription}</span>
                            </div>
                            <div className="action-item">
                              <Button
                                label={childOutputDeleteLabel}
                                icon="pi pi-trash"
                                severity="warning"
                                outlined
                                size="small"
                                onClick={() => onDeleteFiles?.(child, 'movie')}
                                loading={actionBusy}
                                disabled={!childActionState.childHasAnyOutput}
                              />
                              <span className="action-desc">{childMovieDeleteDescription}</span>
                            </div>
                            <div className="action-item">
                              <Button
                                label="Beides löschen (Eintrag bleibt)"
                                icon="pi pi-times"
                                severity="danger"
                                size="small"
                                onClick={() => onDeleteFiles?.(child, 'both')}
                                loading={actionBusy}
                                disabled={!childActionState.childHasRaw && !childActionState.childHasAnyOutput}
                              />
                              <span className="action-desc">{childBothDeleteDescription}</span>
                            </div>
                          </div>
                        ) : null}

                        {typeof onDeleteEntry === 'function' ? (
                          <div className="actions-group">
                            <div className="actions-group-label"><i className="pi pi-database" /> Historie</div>
                            <div className="action-item">
                              <Button
                                label="Historieneintrag löschen"
                                icon="pi pi-trash"
                                severity="danger"
                                outlined
                                size="small"
                                onClick={() => onDeleteEntry?.(child, { includeRelated: true })}
                                loading={deleteEntryBusy}
                                disabled={childActionState.childRunning}
                              />
                              <span className="action-desc">Öffnet die Löschauswahl für diese Disk (Child-Job inkl. Subjobs). Wenn dies die letzte Disk ist, wird auch der Container entfernt.</span>
                            </div>
                          </div>
                        ) : null}
                      </div>
                    </details>
                  );
                })}
                {isMultipartContainer ? (
                  <>
                    <h4>Merge</h4>
                    {mergeChildJobs.length > 0 ? (
                      mergeChildJobs.map((child) => (
                        <details key={`merge-log-${child.id}`} className="episode-track-accordion">
                          <summary className="series-batch-episode-head">
                            <span className="series-batch-episode-title">{`Merge${child?.id ? ` #${child.id}` : ''}`}</span>
                          </summary>
                          <p>Für Merge-Jobs wird nur das Merge-Tool-Log angezeigt.</p>
                          {typeof onDeleteEntry === 'function' ? (
                            <div className="actions-section">
                              <div className="action-item">
                                <Button
                                  label="Merge-Job löschen"
                                  icon="pi pi-trash"
                                  severity="danger"
                                  outlined
                                  size="small"
                                  onClick={() => onDeleteEntry?.(child, { includeRelated: false })}
                                  loading={deleteEntryBusy}
                                  disabled={String(child?.status || '').trim().toUpperCase() === 'ENCODING'}
                                />
                                <span className="action-desc">Entfernt nur den Merge-Job. Ob die Merge-Datei ebenfalls gelöscht wird, kann im nächsten Schritt gewählt werden.</span>
                              </div>
                            </div>
                          ) : null}
                        </details>
                      ))
                    ) : (
                      <details className="episode-track-accordion" open>
                        <summary className="series-batch-episode-head">
                          <span className="series-batch-episode-title">Merge-Job fehlt</span>
                        </summary>
                        <div className="actions-section">
                          <div className="action-item">
                            <Button
                              label="Merge-Job wiederherstellen"
                              icon="pi pi-refresh"
                              severity="info"
                              outlined
                              size="small"
                              onClick={() => onRestoreMultipartMerge?.(job)}
                              loading={restoreMergeBusy}
                              disabled={!canRestoreMultipartMerge || typeof onRestoreMultipartMerge !== 'function'}
                            />
                            <span className="action-desc">
                              {canRestoreMultipartMerge
                                ? 'Erstellt den Merge-Job neu auf Basis der vorhandenen Disc-Outputs.'
                                : `Nur möglich, wenn alle Disc-Outputs vorhanden sind (${Number(multipartMergeSummary?.inputReady || 0)}/${Number(multipartMergeSummary?.inputExpected || 0)}).`}
                            </span>
                          </div>
                        </div>
                      </details>
                    )}
                  </>
                ) : null}
              </>
            ) : isMultipartMergeJob ? (
              <p>Für Merge-Jobs wird nur das Merge-Tool-Log angezeigt.</p>
            ) : isDvdSeries ? (
              <details className="episode-track-accordion">
                <summary className="series-batch-episode-head">
                  <span className="series-batch-episode-title">{seriesDiscLabel}</span>
                </summary>
                <div className="job-json-grid">
                  {!isCd && !isAudiobook && !isConverter ? <JsonView title={metadataJsonTitle} value={metadataJsonValue} /> : null}
                  {isCd ? <JsonView title="MusicBrainz" value={job.makemkvInfo?.selectedMetadata ?? null} /> : null}
                  {isAudiobook ? <JsonView title="Metadaten" value={job.handbrakeInfo?.metadata ?? job.makemkvInfo?.selectedMetadata ?? null} /> : null}
                  <JsonView title={isCd ? 'cdparanoia Info' : (isAudiobook ? 'Audiobook Info' : (isConverter ? 'Converter Analyze Info' : 'MakeMKV Info'))} value={job.makemkvInfo} />
                  {!isCd && !isAudiobook ? <JsonView title="Mediainfo Info" value={job.mediainfoInfo} /> : null}
                  <JsonView title={isCd ? 'Rip-Plan' : (isConverter ? 'Converter Plan' : 'Encode Plan')} value={job.encodePlan} />
                  <JsonView title={isCd ? 'Rip-Info' : (isAudiobook ? 'FFmpeg Info' : (isConverter ? 'Converter Encode Info' : 'HandBrake Info'))} value={job.handbrakeInfo} />
                </div>
              </details>
            ) : (
              <div className="job-json-grid">
                {!isCd && !isAudiobook && !isConverter ? <JsonView title={metadataJsonTitle} value={metadataJsonValue} /> : null}
                {isCd ? <JsonView title="MusicBrainz" value={job.makemkvInfo?.selectedMetadata ?? null} /> : null}
                {isAudiobook ? <JsonView title="Metadaten" value={job.handbrakeInfo?.metadata ?? job.makemkvInfo?.selectedMetadata ?? null} /> : null}
                <JsonView title={isCd ? 'cdparanoia Info' : (isAudiobook ? 'Audiobook Info' : (isConverter ? 'Converter Analyze Info' : 'MakeMKV Info'))} value={job.makemkvInfo} />
                {!isCd && !isAudiobook ? <JsonView title="Mediainfo Info" value={job.mediainfoInfo} /> : null}
                <JsonView title={isCd ? 'Rip-Plan' : (isConverter ? 'Converter Plan' : 'Encode Plan')} value={job.encodePlan} />
                <JsonView title={isCd ? 'Rip-Info' : (isAudiobook ? 'FFmpeg Info' : (isConverter ? 'Converter Encode Info' : 'HandBrake Info'))} value={job.handbrakeInfo} />
              </div>
            )}
          </section>



          <h4>Log</h4>
          {showFinalLog ? (
            <>
              <div className="actions-row">
                <Button
                  label={logLoaded ? 'Tail neu laden (800)' : 'Tail laden (800)'}
                  icon="pi pi-download"
                  severity="secondary"
                  outlined
                  size="small"
                  onClick={() => onLoadLog?.(job, 'tail')}
                  loading={logLoadingMode === 'tail'}
                />
                <Button
                  label="Vollständiges Log laden"
                  icon="pi pi-list"
                  severity="secondary"
                  outlined
                  size="small"
                  onClick={() => onLoadLog?.(job, 'all')}
                  loading={logLoadingMode === 'all'}
                  disabled={logCount <= 0}
                />
                <small>{`Log-Zeilen: ${logCount}`}</small>
                {logTruncated ? <small>(gekürzt auf letzte 800 Zeilen)</small> : null}
              </div>
              {logLoaded ? (
                isDiskContainer && (childJobs.length > 0 || mergeChildJobs.length > 0) ? (
                  <div className="log-box">
                    {childJobs.map((child) => {
                      const childDiscNumber = resolveSeriesDiscNumber(child);
                      const childDiscLabel = childDiscNumber ? `Disk ${childDiscNumber}` : 'Disk unbekannt';
                      return (
                        <details key={`child-log-text-${child.id}`} className="episode-track-accordion">
                          <summary className="series-batch-episode-head">
                            <span className="series-batch-episode-title">{childDiscLabel}</span>
                          </summary>
                          <pre>{child.log || ''}</pre>
                        </details>
                      );
                    })}
                    {mergeChildJobs.map((child) => (
                      <details key={`merge-log-text-${child.id}`} className="episode-track-accordion">
                        <summary className="series-batch-episode-head">
                          <span className="series-batch-episode-title">{`Merge${child?.id ? ` #${child.id}` : ''}`}</span>
                        </summary>
                        <pre>{child.log || buildMergeToolLogFallback(child) || ''}</pre>
                      </details>
                    ))}
                  </div>
                ) : (
                  <pre className="log-box">{job.log || (isMultipartMergeJob ? mergeToolLogFallback : '') || ''}</pre>
                )
              ) : (
                isMultipartMergeJob && mergeToolLogFallback
                  ? <pre className="log-box">{mergeToolLogFallback}</pre>
                  : <p>Log nicht vorgeladen. Über die Buttons oben laden.</p>
              )}
            </>
          ) : (
            <p>Live-Log wird nur im Ripper während laufender Analyse/Rip/Encode angezeigt.</p>
          )}

          {queueLocked || !isContainerWithDiskActions ? (
            <>
              <h4>Aktionen</h4>
              {queueLocked ? (
                <div className="actions-row">
                  <Button
                    label="Aus Queue löschen"
                    icon="pi pi-times"
                    severity="danger"
                    outlined
                    size="small"
                    onClick={() => onRemoveFromQueue?.(job)}
                    loading={actionBusy}
                    disabled={typeof onRemoveFromQueue !== 'function'}
                  />
                </div>
              ) : (
                <div className="actions-section">
              {showCancelAction ? (
                <div className="actions-group">
                  <div className="actions-group-label"><i className="pi pi-ban" /> {running ? 'Laufender Job' : 'Wartender Job'}</div>
                  <div className="action-item">
                    <Button
                      label="Job abbrechen"
                      icon="pi pi-times"
                      severity="warning"
                      size="small"
                      onClick={() => onCancel?.(job)}
                      loading={cancelBusy}
                    />
                    <span className="action-desc">
                      {running
                        ? 'Bricht den aktuell laufenden Job sofort ab.'
                        : `Bricht den wartenden Job im Status ${statusUpper || '-'} ab.`}
                    </span>
                  </div>
                </div>
              ) : null}

              {isCd ? (
                <div className="actions-group">
                  <div className="actions-group-label"><i className="pi pi-play-circle" /> Audio CD</div>
                  <div className="action-item">
                    <Button
                      label="Encode neu starten"
                      icon="pi pi-sync"
                      severity="info"
                      size="small"
                      onClick={() => onReencode?.(job)}
                      loading={reencodeBusy}
                      disabled={!canCdDirectEncode || typeof onReencode !== 'function'}
                    />
                    <span className="action-desc">
                      {canCdDirectEncode
                        ? 'Encodiert die vorhandenen WAV-Rohdaten mit den zuletzt bestätigten Einstellungen erneut — ohne die CD neu zu lesen.'
                        : 'Direktes Encoding ist gesperrt, solange kein bestätigter Vorlauf mit vollständigen Metadaten vorhanden ist. Bitte zuerst "Vorprüfung starten".'}
                    </span>
                  </div>
                  <div className="action-item">
                    <Button
                      label="Vorprüfung starten"
                      icon="pi pi-search"
                      severity="secondary"
                      outlined
                      size="small"
                      onClick={() => onRestartCdReview?.(job)}
                      loading={actionBusy}
                      disabled={!canCdStartReview}
                    />
                    <span className="action-desc">Öffnet den Vorprüfungs-Workflow mit den zuletzt verwendeten CD-Metadaten: Trackauswahl und Ausgabeeinstellungen prüfen, dann Encode aus vorhandenen WAV-Daten starten.</span>
                  </div>
                  <div className="action-item">
                    <Button
                      label="MusicBrainz neu zuweisen"
                      icon="pi pi-tag"
                      severity="secondary"
                      outlined
                      size="small"
                      onClick={() => onAssignCdMetadata?.(job)}
                      loading={cdMetadataAssignBusy}
                      disabled={running || typeof onAssignCdMetadata !== 'function'}
                    />
                    <span className="action-desc">Öffnet die MusicBrainz-Suche, um Album-Metadaten (Titel, Interpret, Tracks) neu zuzuweisen.</span>
                  </div>
                </div>
              ) : isAudiobook ? (
                <div className="actions-group">
                  <div className="actions-group-label"><i className="pi pi-play-circle" /> Audiobook</div>
                  {typeof onReencode === 'function' ? (
                    <div className="action-item">
                      <Button
                        label="Encode neu starten"
                        icon="pi pi-sync"
                        severity="info"
                        size="small"
                        onClick={() => onReencode?.(job)}
                        loading={reencodeBusy}
                        disabled={!canReencode}
                      />
                      <span className="action-desc">Startet FFmpeg direkt mit den zuletzt bestätigten Einstellungen neu. Es gibt dabei keinen Anpassungsschritt.</span>
                    </div>
                  ) : null}
                  {typeof onRestartReview === 'function' ? (
                    <div className="action-item">
                      <Button
                        label="Vorprüfung starten"
                        icon="pi pi-search"
                        severity="secondary"
                        outlined
                        size="small"
                        onClick={() => onRestartReview?.(job)}
                        loading={actionBusy}
                        disabled={!canRestartReview}
                      />
                      <span className="action-desc">Legt den Job neu aus der Quelldatei an und öffnet ihn im Ripper, damit Einstellungen vor dem Encode angepasst werden können.</span>
                    </div>
                  ) : null}
                </div>
              ) : (
                canShowGeneralEncodeActions ? (
                  <div className="actions-group">
                    <div className="actions-group-label"><i className="pi pi-play-circle" /> Kodierung</div>
                    {canResumeReady ? (
                      <div className="action-item">
                        <Button
                          label="Im Ripper öffnen"
                          icon="pi pi-window-maximize"
                          severity="info"
                          outlined
                          size="small"
                          onClick={() => onResumeReady?.(job)}
                          loading={actionBusy}
                        />
                        <span className="action-desc">Öffnet den wartenden Job im Ripper zur Weiterverarbeitung.</span>
                      </div>
                    ) : null}
                    {typeof onRestartEncode === 'function' ? (
                      <div className="action-item">
                        <Button
                          label="Encode neu starten"
                          icon="pi pi-play"
                          severity="success"
                          size="small"
                          onClick={() => onRestartEncode?.(job)}
                          loading={actionBusy}
                          disabled={!canRestartEncode}
                        />
                        <span className="action-desc">Startet {isAudiobook ? 'FFmpeg' : 'HandBrake'} mit den zuletzt gespeicherten Einstellungen direkt neu — ohne Review.</span>
                      </div>
                    ) : null}
                    {typeof onRestartReview === 'function' ? (
                      <div className="action-item">
                        <Button
                          label={isAudiobook ? 'Kapitel-Auswahl öffnen' : 'Spur-Auswahl öffnen'}
                          icon="pi pi-list"
                          severity="info"
                          outlined
                          size="small"
                          onClick={() => onRestartReview?.(job)}
                          loading={actionBusy}
                          disabled={!canRestartReview}
                        />
                        <span className="action-desc">{isAudiobook
                          ? 'Öffnet die Kapitel-Auswahl erneut, um Kapitel anzupassen bevor der Encode startet.'
                          : 'Öffnet die Spur- und Preset-Auswahl erneut, um Einstellungen vor dem Encode zu ändern.'
                        }</span>
                      </div>
                    ) : null}
                    {typeof onReencode === 'function' ? (
                      <div className="action-item">
                        <Button
                          label="Neustart"
                          icon="pi pi-sync"
                          severity="info"
                          size="small"
                          onClick={() => onReencode?.(job)}
                          loading={reencodeBusy}
                          disabled={!canReencode}
                        />
                        <span className="action-desc">{isAudiobook
                          ? 'Liest die AAX-Datei neu ein und öffnet danach die Kapitel-Auswahl. Sinnvoll wenn sich die Quelldatei geändert hat.'
                          : 'Analysiert die Quelldatei neu (MediaInfo, Playlist-Check) und öffnet dann die Spur-Auswahl. Unterschied zu „Spur-Auswahl öffnen": der Analyse-Schritt wird komplett wiederholt.'
                        }</span>
                      </div>
                    ) : null}
                  </div>
                ) : null
              )}

              {canRetry ? (
                <div className="actions-group">
                  <div className="actions-group-label"><i className="pi pi-refresh" /> Recovery</div>
                  <div className="action-item">
                    <Button
                      label={isCd ? 'CD-Rip neu starten' : 'Retry Rip'}
                      icon="pi pi-refresh"
                      severity="warning"
                      size="small"
                      onClick={() => onRetry?.(job)}
                      loading={actionBusy}
                    />
                    <span className="action-desc">
                      {isCd
                        ? 'Startet den CD-Rip neu.'
                        : 'Löscht das alte RAW und startet den Rip erneut.'}
                    </span>
                  </div>
                </div>
              ) : null}

              {!isCd && !isAudiobook && !isConverter && !blockMetadataAndReviewUntilRetry && typeof onAssignMetadata === 'function' ? (
                <div className="actions-group">
                  <div className="actions-group-label"><i className="pi pi-search" /> Metadaten</div>
                  <div className="action-item">
                    <Button
                      label={metadataAssignButtonLabel}
                      icon="pi pi-search"
                      severity="secondary"
                      outlined
                      size="small"
                      onClick={() => onAssignMetadata?.(job)}
                      loading={metadataAssignBusy}
                      disabled={running}
                    />
                    <span className="action-desc">{metadataAssignActionDescription}</span>
                  </div>
                </div>
              ) : null}

              {canGenerateNfo ? (
                <div className="actions-group">
                  <div className="actions-group-label"><i className="pi pi-file" /> NFO</div>
                  <div className="action-item">
                    <Button
                      label="NFO erzeugen"
                      icon="pi pi-file-edit"
                      severity="info"
                      outlined
                      size="small"
                      onClick={() => onGenerateNfo?.(job)}
                      loading={generateNfoBusy}
                      disabled={actionBusy}
                    />
                    <span className="action-desc">Erstellt eine .nfo-Datei neben der Output-Datei (manuell aus der Historie).</span>
                  </div>
                </div>
              ) : null}

              {typeof onDeleteFiles === 'function' ? (
                <div className="actions-group">
                  <div className="actions-group-label"><i className="pi pi-trash" /> Dateien löschen</div>
                  <div className="action-item">
                    <Button
                      label="RAW löschen (Eintrag bleibt)"
                      icon="pi pi-trash"
                      severity="warning"
                      outlined
                      size="small"
                      onClick={() => onDeleteFiles?.(job, 'raw')}
                      loading={actionBusy}
                      disabled={!job.rawStatus?.exists}
                    />
                    <span className="action-desc">Löscht die Quelldateien nach dem Rip ({isCd ? 'Audio-Rohdaten' : isAudiobook ? 'AAX/MP3-Quelldatei' : isConverter ? 'Quelldatei aus dem Converter-Import' : 'MKV-Datei von MakeMKV'}).</span>
                  </div>
                  <div className="action-item">
                    <Button
                      label={isCd ? 'Audio löschen (Eintrag bleibt)' : (isAudiobook ? 'Ausgabe löschen (Eintrag bleibt)' : (isConverter ? 'Output löschen (Eintrag bleibt)' : 'Movie löschen (Eintrag bleibt)'))}
                      icon="pi pi-trash"
                      severity="warning"
                      outlined
                      size="small"
                      onClick={() => onDeleteFiles?.(job, 'movie')}
                      loading={actionBusy}
                      disabled={!hasAnyOutputFolder}
                    />
                    <span className="action-desc">Löscht {isCd ? 'die fertig gerippten Audiodateien' : isAudiobook ? 'die fertig konvertierte Audiobook-Ausgabe' : isConverter ? 'die fertig konvertierte Ausgabe' : 'die fertig encodierte Filmdatei'}.</span>
                  </div>
                  <div className="action-item">
                    <Button
                      label="Beides löschen (Eintrag bleibt)"
                      icon="pi pi-times"
                      severity="danger"
                      size="small"
                      onClick={() => onDeleteFiles?.(job, 'both')}
                      loading={actionBusy}
                      disabled={!job.rawStatus?.exists && !job.outputStatus?.exists}
                    />
                    <span className="action-desc">Löscht RAW-Quelldateien und Ausgabe gemeinsam.</span>
                  </div>
                </div>
              ) : null}

                </div>
              )}
            </>
          ) : null}

          {!queueLocked ? (
            <div className="action-delete-entry">
              <span className="action-desc">
                {isMultipartMergeJob
                  ? 'Entfernt diesen Merge-Job aus der Verlaufsliste. Im nächsten Schritt kann gewählt werden, ob die Merge-Datei ebenfalls gelöscht werden soll.'
                  : 'Entfernt diesen Eintrag aus der Verlaufsliste — Dateien auf der Festplatte bleiben erhalten.'}
              </span>
              <Button
                label={isMultipartMergeJob ? 'Merge-Job löschen' : 'Historieneintrag löschen'}
                icon="pi pi-trash"
                severity="danger"
                outlined
                size="small"
                onClick={() => onDeleteEntry?.(job, { includeRelated: !isMultipartMergeJob })}
                loading={deleteEntryBusy}
                disabled={!canDeleteEntry}
              />
            </div>
          ) : null}
        </div>
      )}
    </Dialog>
  );
}
