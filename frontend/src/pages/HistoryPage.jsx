import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Card } from 'primereact/card';
import { DataView, DataViewLayoutOptions } from 'primereact/dataview';
import { InputText } from 'primereact/inputtext';
import { Dropdown } from 'primereact/dropdown';
import { Button } from 'primereact/button';
import { Tag } from 'primereact/tag';
import { Toast } from 'primereact/toast';
import { Dialog } from 'primereact/dialog';
import { api } from '../api/client';
import JobDetailDialog from '../components/JobDetailDialog';
import blurayIndicatorIcon from '../assets/media-bluray.svg';
import discIndicatorIcon from '../assets/media-disc.svg';
import otherIndicatorIcon from '../assets/media-other.svg';
import {
  getStatusLabel,
  getStatusSeverity,
  normalizeStatus,
  STATUS_FILTER_OPTIONS
} from '../utils/statusPresentation';

const MEDIA_FILTER_OPTIONS = [
  { label: 'Alle Medien', value: '' },
  { label: 'Blu-ray', value: 'bluray' },
  { label: 'DVD', value: 'dvd' },
  { label: 'Audio CD', value: 'cd' },
  { label: 'Audiobook', value: 'audiobook' },
  { label: 'Sonstiges', value: 'other' }
];

const SORT_OPTIONS = [
  { label: 'Startzeit: Neu -> Alt', value: '!start_time' },
  { label: 'Startzeit: Alt -> Neu', value: 'start_time' },
  { label: 'Endzeit: Neu -> Alt', value: '!end_time' },
  { label: 'Endzeit: Alt -> Neu', value: 'end_time' },
  { label: 'Titel: A -> Z', value: 'sortTitle' },
  { label: 'Titel: Z -> A', value: '!sortTitle' },
  { label: 'Medium: A -> Z', value: 'sortMediaType' },
  { label: 'Medium: Z -> A', value: '!sortMediaType' }
];

const CD_FORMAT_LABELS = {
  flac: 'FLAC',
  wav: 'WAV',
  mp3: 'MP3',
  opus: 'Opus',
  ogg: 'Ogg Vorbis'
};

function normalizePositiveInteger(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return Math.trunc(parsed);
}

function resolveMediaType(row) {
  const encodePlan = row?.encodePlan && typeof row.encodePlan === 'object' ? row.encodePlan : null;
  const candidates = [
    row?.mediaType,
    row?.media_type,
    row?.mediaProfile,
    row?.media_profile,
    encodePlan?.mediaProfile,
    row?.makemkvInfo?.analyzeContext?.mediaProfile,
    row?.makemkvInfo?.mediaProfile,
    row?.mediainfoInfo?.mediaProfile
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
  }
  const statusCandidates = [
    row?.status,
    row?.last_state,
    row?.makemkvInfo?.lastState
  ];
  if (statusCandidates.some((value) => String(value || '').trim().toUpperCase().startsWith('CD_'))) {
    return 'cd';
  }
  const planFormat = String(encodePlan?.format || '').trim().toLowerCase();
  const hasCdTracksInPlan = Array.isArray(encodePlan?.selectedTracks) && encodePlan.selectedTracks.length > 0;
  if (hasCdTracksInPlan && ['flac', 'wav', 'mp3', 'opus', 'ogg'].includes(planFormat)) {
    return 'cd';
  }
  if (String(row?.handbrakeInfo?.mode || '').trim().toLowerCase() === 'cd_rip') {
    return 'cd';
  }
  if (Array.isArray(row?.makemkvInfo?.tracks) && row.makemkvInfo.tracks.length > 0) {
    return 'cd';
  }
  if (['audiobook_encode', 'audiobook_encode_split'].includes(String(row?.handbrakeInfo?.mode || '').trim().toLowerCase())) {
    return 'audiobook';
  }
  if (String(encodePlan?.mode || '').trim().toLowerCase() === 'audiobook') {
    return 'audiobook';
  }
  return 'other';
}

function resolveMediaTypeMeta(row) {
  const mediaType = resolveMediaType(row);
  if (mediaType === 'bluray') {
    return {
      mediaType,
      icon: blurayIndicatorIcon,
      label: 'Blu-ray',
      alt: 'Blu-ray'
    };
  }
  if (mediaType === 'dvd') {
    return {
      mediaType,
      icon: discIndicatorIcon,
      label: 'DVD',
      alt: 'DVD'
    };
  }
  if (mediaType === 'cd') {
    return {
      mediaType,
      icon: otherIndicatorIcon,
      label: 'Audio CD',
      alt: 'Audio CD'
    };
  }
  if (mediaType === 'audiobook') {
    return {
      mediaType,
      icon: otherIndicatorIcon,
      label: 'Audiobook',
      alt: 'Audiobook'
    };
  }
  return {
    mediaType,
    icon: otherIndicatorIcon,
    label: 'Sonstiges',
    alt: 'Sonstiges Medium'
  };
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

function resolveCdDetails(row) {
  const encodePlan = row?.encodePlan && typeof row.encodePlan === 'object' ? row.encodePlan : {};
  const makemkvInfo = row?.makemkvInfo && typeof row.makemkvInfo === 'object' ? row.makemkvInfo : {};
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
      return {
        ...track,
        position,
        selected: track?.selected !== false
      };
    })
    .filter(Boolean);
  const selectedTracksFromPlan = Array.isArray(encodePlan?.selectedTracks)
    ? encodePlan.selectedTracks
      .map((value) => normalizePositiveInteger(value))
      .filter(Boolean)
    : [];
  const selectedTrackPositions = selectedTracksFromPlan.length > 0
    ? selectedTracksFromPlan
    : tracks.filter((track) => track.selected !== false).map((track) => track.position);
  const fallbackArtist = tracks
    .map((track) => String(track?.artist || '').trim())
    .find(Boolean) || null;
  const totalDurationSec = tracks.reduce((sum, track) => {
    const durationMs = Number(track?.durationMs);
    const durationSec = Number(track?.durationSec);
    if (Number.isFinite(durationMs) && durationMs > 0) {
      return sum + (durationMs / 1000);
    }
    if (Number.isFinite(durationSec) && durationSec > 0) {
      return sum + durationSec;
    }
    return sum;
  }, 0);
  const format = String(encodePlan?.format || '').trim().toLowerCase();
  const mbId = String(
    selectedMetadata?.mbId
    || selectedMetadata?.musicBrainzId
    || selectedMetadata?.musicbrainzId
    || selectedMetadata?.mbid
    || ''
  ).trim() || null;

  return {
    artist: String(selectedMetadata?.artist || '').trim() || fallbackArtist || null,
    trackCount: tracks.length,
    selectedTrackCount: selectedTrackPositions.length,
    format,
    formatLabel: format ? (CD_FORMAT_LABELS[format] || format.toUpperCase()) : null,
    totalDurationLabel: formatDurationSeconds(totalDurationSec),
    mbId
  };
}

function resolveAudiobookDetails(row) {
  const encodePlan = row?.encodePlan && typeof row.encodePlan === 'object' ? row.encodePlan : {};
  const selectedMetadata = row?.makemkvInfo?.selectedMetadata && typeof row.makemkvInfo.selectedMetadata === 'object'
    ? row.makemkvInfo.selectedMetadata
    : (encodePlan?.metadata && typeof encodePlan.metadata === 'object' ? encodePlan.metadata : {});
  const chapters = Array.isArray(selectedMetadata?.chapters)
    ? selectedMetadata.chapters
    : (Array.isArray(row?.makemkvInfo?.chapters) ? row.makemkvInfo.chapters : []);
  const format = String(
    row?.handbrakeInfo?.format
    || encodePlan?.format
    || ''
  ).trim().toLowerCase() || null;
  return {
    author: String(selectedMetadata?.author || selectedMetadata?.artist || '').trim() || null,
    narrator: String(selectedMetadata?.narrator || '').trim() || null,
    chapterCount: chapters.length,
    formatLabel: format ? format.toUpperCase() : null
  };
}

function getOutputLabelForRow(row) {
  const mediaType = resolveMediaType(row);
  if (mediaType === 'cd') {
    return 'Audio-Dateien';
  }
  if (mediaType === 'audiobook') {
    return 'Audiobook-Datei(en)';
  }
  return 'Movie-Datei(en)';
}

function getOutputShortLabelForRow(row) {
  const mediaType = resolveMediaType(row);
  if (mediaType === 'cd') {
    return 'Audio';
  }
  if (mediaType === 'audiobook') {
    return 'Audiobook';
  }
  return 'Movie';
}

function normalizeJobId(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return Math.trunc(parsed);
}

function getQueueActionResult(response) {
  return response?.result && typeof response.result === 'object' ? response.result : {};
}

function normalizeSortText(value) {
  return String(value || '').trim().toLocaleLowerCase('de-DE');
}

function sanitizeRating(value) {
  const raw = String(value || '').trim();
  if (!raw || raw.toUpperCase() === 'N/A') {
    return null;
  }
  return raw;
}

function findOmdbRatingBySource(omdbInfo, sourceName) {
  const ratings = Array.isArray(omdbInfo?.Ratings) ? omdbInfo.Ratings : [];
  const source = String(sourceName || '').trim().toLowerCase();
  const entry = ratings.find((item) => String(item?.Source || '').trim().toLowerCase() === source);
  return sanitizeRating(entry?.Value);
}

function resolveRatings(row) {
  const omdbInfo = row?.omdbInfo && typeof row.omdbInfo === 'object' ? row.omdbInfo : null;
  if (!omdbInfo) {
    return [];
  }

  const imdb = sanitizeRating(omdbInfo?.imdbRating)
    || findOmdbRatingBySource(omdbInfo, 'Internet Movie Database');
  const rotten = findOmdbRatingBySource(omdbInfo, 'Rotten Tomatoes');
  const metascore = sanitizeRating(omdbInfo?.Metascore);

  const ratings = [];
  if (imdb) {
    ratings.push({ key: 'imdb', label: 'IMDb', value: imdb });
  }
  if (rotten) {
    ratings.push({ key: 'rt', label: 'RT', value: rotten });
  }
  if (metascore) {
    ratings.push({ key: 'meta', label: 'Meta', value: metascore });
  }
  return ratings;
}

function formatDateTime(value) {
  if (!value) {
    return '-';
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return String(value);
  }
  return date.toLocaleString('de-DE', {
    dateStyle: 'short',
    timeStyle: 'short'
  });
}

export default function HistoryPage({ refreshToken = 0 }) {
  const location = useLocation();
  const navigate = useNavigate();
  const [jobs, setJobs] = useState([]);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [mediumFilter, setMediumFilter] = useState('');
  const [layout, setLayout] = useState('list');
  const [sortKey, setSortKey] = useState('!start_time');
  const [sortField, setSortField] = useState('start_time');
  const [sortOrder, setSortOrder] = useState(-1);
  const [selectedJob, setSelectedJob] = useState(null);
  const [detailVisible, setDetailVisible] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [logLoadingMode, setLogLoadingMode] = useState(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [reencodeBusyJobId, setReencodeBusyJobId] = useState(null);
  const [deleteEntryBusy, setDeleteEntryBusy] = useState(false);
  const [deleteEntryDialogVisible, setDeleteEntryDialogVisible] = useState(false);
  const [deleteEntryDialogRow, setDeleteEntryDialogRow] = useState(null);
  const [deleteEntryPreview, setDeleteEntryPreview] = useState(null);
  const [deleteEntryPreviewLoading, setDeleteEntryPreviewLoading] = useState(false);
  const [deleteEntryTargetBusy, setDeleteEntryTargetBusy] = useState(null);
  const [loading, setLoading] = useState(false);
  const [queuedJobIds, setQueuedJobIds] = useState([]);
  const toastRef = useRef(null);

  const queuedJobIdSet = useMemo(() => {
    const next = new Set();
    for (const value of Array.isArray(queuedJobIds) ? queuedJobIds : []) {
      const id = normalizeJobId(value);
      if (id) {
        next.add(id);
      }
    }
    return next;
  }, [queuedJobIds]);

  const preparedJobs = useMemo(
    () => jobs.map((job) => ({
      ...job,
      sortTitle: normalizeSortText(job?.title || job?.detected_title || ''),
      sortMediaType: resolveMediaType(job)
    })),
    [jobs]
  );

  const visibleJobs = useMemo(
    () => (mediumFilter
      ? preparedJobs.filter((job) => job.sortMediaType === mediumFilter)
      : preparedJobs),
    [preparedJobs, mediumFilter]
  );

  const load = async () => {
    setLoading(true);
    try {
      const [jobsResponse, queueResponse] = await Promise.allSettled([
        api.getJobs({ search, status }),
        api.getPipelineQueue()
      ]);
      if (jobsResponse.status === 'fulfilled') {
        setJobs(jobsResponse.value.jobs || []);
      } else {
        setJobs([]);
      }
      if (queueResponse.status === 'fulfilled') {
        const queuedRows = Array.isArray(queueResponse.value?.queue?.queuedJobs)
          ? queueResponse.value.queue.queuedJobs
          : [];
        const queuedIds = queuedRows
          .map((item) => normalizeJobId(item?.jobId))
          .filter(Boolean);
        setQueuedJobIds(queuedIds);
      } else {
        setQueuedJobIds([]);
      }
    } catch (error) {
      toastRef.current?.show({ severity: 'error', summary: 'Fehler', detail: error.message });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    const timer = setTimeout(() => {
      load();
    }, 300);

    return () => clearTimeout(timer);
  }, [search, status, refreshToken]);

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const openJobId = Number(params.get('open') || 0);
    if (!openJobId) {
      return;
    }
    // URL-Parameter entfernen, dann Job-Modal öffnen
    navigate('/history', { replace: true });
    openDetail({ id: openJobId });
  }, [location.search]);

  const onSortChange = (event) => {
    const value = String(event.value || '').trim();
    if (!value) {
      setSortKey('!start_time');
      setSortField('start_time');
      setSortOrder(-1);
      return;
    }

    if (value.startsWith('!')) {
      setSortOrder(-1);
      setSortField(value.substring(1));
    } else {
      setSortOrder(1);
      setSortField(value);
    }
    setSortKey(value);
  };

  const openDetail = async (row) => {
    const jobId = Number(row?.id || 0);
    if (!jobId) {
      return;
    }

    setSelectedJob({
      ...row,
      logs: [],
      log: '',
      logMeta: {
        loaded: false,
        total: Number(row?.log_count || 0),
        returned: 0,
        truncated: false
      }
    });
    setDetailVisible(true);
    setDetailLoading(true);

    try {
      const response = await api.getJob(jobId, { includeLogs: false });
      setSelectedJob(response.job);
    } catch (error) {
      toastRef.current?.show({ severity: 'error', summary: 'Fehler', detail: error.message });
    } finally {
      setDetailLoading(false);
    }
  };

  const handleLoadLog = async (job, mode = 'tail') => {
    const jobId = Number(job?.id || selectedJob?.id || 0);
    if (!jobId) {
      return;
    }

    setLogLoadingMode(mode);
    try {
      const response = await api.getJob(jobId, {
        includeLogs: true,
        includeAllLogs: mode === 'all',
        logTailLines: mode === 'all' ? null : 800
      });
      setSelectedJob(response.job);
    } catch (error) {
      toastRef.current?.show({ severity: 'error', summary: 'Log konnte nicht geladen werden', detail: error.message });
    } finally {
      setLogLoadingMode(null);
    }
  };

  const refreshDetailIfOpen = async (jobId) => {
    if (!detailVisible || Number(selectedJob?.id || 0) !== Number(jobId || 0)) {
      return;
    }
    const response = await api.getJob(jobId, { includeLogs: false });
    setSelectedJob(response.job);
  };

  const handleDeleteFiles = async (row, target) => {
    const outputLabel = getOutputLabelForRow(row);
    const outputShortLabel = getOutputShortLabelForRow(row);
    const label = target === 'raw' ? 'RAW-Dateien' : target === 'movie' ? outputLabel : `RAW + ${outputShortLabel}`;
    const title = row.title || row.detected_title || `Job #${row.id}`;
    const confirmed = window.confirm(`${label} für "${title}" wirklich löschen?`);
    if (!confirmed) {
      return;
    }

    setActionBusy(true);
    try {
      const response = await api.deleteJobFiles(row.id, target);
      const summary = response.summary || {};
      toastRef.current?.show({
        severity: 'success',
        summary: 'Dateien gelöscht',
        detail: `RAW: ${summary.raw?.filesDeleted ?? 0}, ${outputShortLabel}: ${summary.movie?.filesDeleted ?? 0}`,
        life: 3500
      });
      await load();
      await refreshDetailIfOpen(row.id);
    } catch (error) {
      toastRef.current?.show({ severity: 'error', summary: 'Löschen fehlgeschlagen', detail: error.message, life: 4500 });
    } finally {
      setActionBusy(false);
    }
  };

  const handleReencode = async (row) => {
    const title = row.title || row.detected_title || `Job #${row.id}`;
    const confirmed = window.confirm(`RAW neu encodieren für "${title}" starten?`);
    if (!confirmed) {
      return;
    }

    setReencodeBusyJobId(row.id);
    try {
      await api.reencodeJob(row.id);
      toastRef.current?.show({
        severity: 'success',
        summary: 'Re-Encode gestartet',
        detail: 'Job wurde in die Mediainfo-Prüfung gesetzt.',
        life: 3500
      });
      await load();
      await refreshDetailIfOpen(row.id);
    } catch (error) {
      toastRef.current?.show({ severity: 'error', summary: 'Re-Encode fehlgeschlagen', detail: error.message, life: 4500 });
    } finally {
      setReencodeBusyJobId(null);
    }
  };

  const handleRestartEncode = async (row) => {
    const title = row.title || row.detected_title || `Job #${row.id}`;
    if (row?.encodeSuccess) {
      const confirmed = window.confirm(
        `Encode für "${title}" ist bereits erfolgreich abgeschlossen. Wirklich erneut encodieren?\n`
        + 'Es wird eine neue Datei mit Kollisionsprüfung angelegt.'
      );
      if (!confirmed) {
        return;
      }
    }

    setActionBusy(true);
    try {
      const response = await api.restartEncodeWithLastSettings(row.id);
      const result = getQueueActionResult(response);
      if (result.queued) {
        const queuePosition = Number(result?.queuePosition || 0);
        toastRef.current?.show({
          severity: 'info',
          summary: 'Encode-Neustart in Queue',
          detail: queuePosition > 0
            ? `Job wurde auf Position ${queuePosition} eingeplant.`
            : 'Job wurde in die Warteschlange eingeplant.',
          life: 3500
        });
      } else {
        toastRef.current?.show({
          severity: 'success',
          summary: 'Encode-Neustart gestartet',
          detail: 'Letzte bestätigte Einstellungen werden verwendet.',
          life: 3500
        });
      }
      await load();
      await refreshDetailIfOpen(row.id);
    } catch (error) {
      toastRef.current?.show({ severity: 'error', summary: 'Encode-Neustart fehlgeschlagen', detail: error.message, life: 4500 });
    } finally {
      setActionBusy(false);
    }
  };

  const handleRestartReview = async (row) => {
    const title = row?.title || row?.detected_title || `Job #${row?.id}`;
    const confirmed = window.confirm(`Review für "${title}" neu starten?\nDer Job wird erneut analysiert. Spur- und Skriptauswahl kann danach im Dashboard neu getroffen werden.`);
    if (!confirmed) {
      return;
    }

    setActionBusy(true);
    try {
      await api.restartReviewFromRaw(row.id);
      toastRef.current?.show({
        severity: 'success',
        summary: 'Review-Neustart',
        detail: 'Analyse gestartet. Job ist jetzt im Dashboard verfügbar.',
        life: 3500
      });
      await load();
      await refreshDetailIfOpen(row.id);
    } catch (error) {
      toastRef.current?.show({ severity: 'error', summary: 'Review-Neustart fehlgeschlagen', detail: error.message, life: 4500 });
    } finally {
      setActionBusy(false);
    }
  };

  const handleRetry = async (row) => {
    const title = row?.title || row?.detected_title || `Job #${row?.id}`;
    const mediaType = resolveMediaType(row);
    const actionLabel = mediaType === 'cd' ? 'CD-Rip' : 'Retry';
    const confirmed = window.confirm(`${actionLabel} für "${title}" neu starten?`);
    if (!confirmed) {
      return;
    }

    setActionBusy(true);
    try {
      const response = await api.retryJob(row.id);
      const result = getQueueActionResult(response);
      const replacementJobId = normalizeJobId(result?.jobId);
      toastRef.current?.show({
        severity: result.queued ? 'info' : 'success',
        summary: mediaType === 'cd' ? 'CD-Rip neu gestartet' : 'Retry gestartet',
        detail: result.queued
          ? 'Job wurde in die Warteschlange eingeplant.'
          : (replacementJobId ? `Neuer Job #${replacementJobId} wurde erstellt.` : 'Job wurde neu gestartet.'),
        life: 4000
      });
      await load();
      if (replacementJobId) {
        const detailResponse = await api.getJob(replacementJobId, { includeLogs: false });
        setSelectedJob(detailResponse.job);
        setDetailVisible(true);
      } else {
        await refreshDetailIfOpen(row.id);
      }
    } catch (error) {
      toastRef.current?.show({
        severity: 'error',
        summary: mediaType === 'cd' ? 'CD-Rip Neustart fehlgeschlagen' : 'Retry fehlgeschlagen',
        detail: error.message,
        life: 4500
      });
    } finally {
      setActionBusy(false);
    }
  };

  const closeDeleteEntryDialog = () => {
    if (deleteEntryTargetBusy) {
      return;
    }
    setDeleteEntryDialogVisible(false);
    setDeleteEntryDialogRow(null);
    setDeleteEntryPreview(null);
    setDeleteEntryPreviewLoading(false);
    setDeleteEntryTargetBusy(null);
  };

  const handleDeleteEntry = async (row) => {
    const jobId = Number(row?.id || 0);
    if (!jobId) {
      return;
    }
    setDeleteEntryDialogRow(row);
    setDeleteEntryPreview(null);
    setDeleteEntryDialogVisible(true);
    setDeleteEntryPreviewLoading(true);
    setDeleteEntryBusy(true);
    try {
      const response = await api.getJobDeletePreview(jobId, { includeRelated: true });
      setDeleteEntryPreview(response?.preview || null);
    } catch (error) {
      toastRef.current?.show({
        severity: 'error',
        summary: 'Löschvorschau fehlgeschlagen',
        detail: error.message,
        life: 4500
      });
      setDeleteEntryDialogVisible(false);
      setDeleteEntryDialogRow(null);
      setDeleteEntryPreview(null);
    } finally {
      setDeleteEntryPreviewLoading(false);
      setDeleteEntryBusy(false);
    }
  };

  const confirmDeleteEntry = async (target) => {
    const normalizedTarget = String(target || '').trim().toLowerCase();
    if (!['raw', 'movie', 'both', 'none'].includes(normalizedTarget)) {
      return;
    }
    const jobId = Number(deleteEntryDialogRow?.id || 0);
    if (!jobId) {
      return;
    }

    setDeleteEntryBusy(true);
    setDeleteEntryTargetBusy(normalizedTarget);
    try {
      const response = await api.deleteJobEntry(jobId, normalizedTarget, { includeRelated: true });
      const deletedJobIds = Array.isArray(response?.deletedJobIds) ? response.deletedJobIds : [];
      const fileSummary = response?.fileSummary || {};
      const rawFiles = Number(fileSummary?.raw?.filesDeleted || 0);
      const movieFiles = Number(fileSummary?.movie?.filesDeleted || 0);
      const rawDirs = Number(fileSummary?.raw?.dirsRemoved || 0);
      const movieDirs = Number(fileSummary?.movie?.dirsRemoved || 0);

      const detail = normalizedTarget === 'none'
        ? `${deletedJobIds.length || 1} Eintrag/Einträge entfernt (Dateien bleiben erhalten)`
        : `${deletedJobIds.length || 1} Eintrag/Einträge entfernt | RAW: ${rawFiles} Dateien, ${rawDirs} Ordner | ${deleteEntryOutputShortLabel}: ${movieFiles} Dateien, ${movieDirs} Ordner`;
      toastRef.current?.show({
        severity: 'success',
        summary: 'Historie gelöscht',
        detail,
        life: 5000
      });

      closeDeleteEntryDialog();
      setDetailVisible(false);
      setSelectedJob(null);
      await load();
    } catch (error) {
      toastRef.current?.show({
        severity: 'error',
        summary: 'Löschen fehlgeschlagen',
        detail: error.message,
        life: 5000
      });
    } finally {
      setDeleteEntryTargetBusy(null);
      setDeleteEntryBusy(false);
    }
  };

  const handleRemoveFromQueue = async (row) => {
    const jobId = normalizeJobId(row?.id || row);
    if (!jobId) {
      return;
    }

    setActionBusy(true);
    try {
      await api.cancelPipeline(jobId);
      toastRef.current?.show({
        severity: 'success',
        summary: 'Aus Queue entfernt',
        detail: `Job #${jobId} wurde aus der Warteschlange entfernt.`,
        life: 3200
      });
      await load();
      await refreshDetailIfOpen(jobId);
    } catch (error) {
      toastRef.current?.show({
        severity: 'error',
        summary: 'Queue-Entfernung fehlgeschlagen',
        detail: error.message,
        life: 4500
      });
    } finally {
      setActionBusy(false);
    }
  };

  const renderStatusTag = (row) => {
    const normalizedStatus = normalizeStatus(row?.status);
    const rowId = normalizeJobId(row?.id);
    const isQueued = Boolean(rowId && queuedJobIdSet.has(rowId));
    return (
      <Tag
        value={getStatusLabel(row?.status, { queued: isQueued })}
        severity={getStatusSeverity(normalizedStatus, { queued: isQueued })}
      />
    );
  };

  const renderPoster = (row, className = 'history-dv-poster') => {
    const mediaMeta = resolveMediaTypeMeta(row);
    const title = row?.title || row?.detected_title || 'Poster';
    if (row?.poster_url && row.poster_url !== 'N/A') {
      return <img src={row.poster_url} alt={title} className={className} loading="lazy" />;
    }
    return <div className="history-dv-poster-fallback">{['cd', 'audiobook'].includes(mediaMeta.mediaType) ? 'Kein Cover' : 'Kein Poster'}</div>;
  };

  const renderPresenceChip = (label, available) => (
    <span className={`history-dv-chip ${available ? 'tone-ok' : 'tone-no'}`}>
      <i className={`pi ${available ? 'pi-check-circle' : 'pi-times-circle'}`} aria-hidden="true" />
      <span>{label}: {available ? 'Ja' : 'Nein'}</span>
    </span>
  );

  const renderSupplementalInfo = (row) => {
    if (resolveMediaType(row) === 'cd') {
      const cdDetails = resolveCdDetails(row);
      const infoItems = [];
      if (cdDetails.trackCount > 0) {
        infoItems.push({
          key: 'tracks',
          label: 'Tracks',
          value: cdDetails.selectedTrackCount > 0 && cdDetails.selectedTrackCount !== cdDetails.trackCount
            ? `${cdDetails.selectedTrackCount}/${cdDetails.trackCount}`
            : String(cdDetails.trackCount)
        });
      }
      if (cdDetails.formatLabel) {
        infoItems.push({ key: 'format', label: 'Format', value: cdDetails.formatLabel });
      }
      if (cdDetails.totalDurationLabel) {
        infoItems.push({ key: 'duration', label: 'Dauer', value: cdDetails.totalDurationLabel });
      }
      if (cdDetails.mbId) {
        infoItems.push({ key: 'mb', label: 'MusicBrainz', value: 'gesetzt' });
      }
      if (infoItems.length === 0) {
        return <span className="history-dv-subtle">Keine CD-Details</span>;
      }
      return infoItems.map((item) => (
        <span key={`${row?.id}-${item.key}`} className="history-dv-rating-chip">
          <strong>{item.label}</strong>
          <span>{item.value}</span>
        </span>
      ));
    }

    if (resolveMediaType(row) === 'audiobook') {
      const audiobookDetails = resolveAudiobookDetails(row);
      const infoItems = [];
      if (audiobookDetails.author) {
        infoItems.push({ key: 'author', label: 'Autor', value: audiobookDetails.author });
      }
      if (audiobookDetails.narrator) {
        infoItems.push({ key: 'narrator', label: 'Sprecher', value: audiobookDetails.narrator });
      }
      if (audiobookDetails.chapterCount > 0) {
        infoItems.push({ key: 'chapters', label: 'Kapitel', value: String(audiobookDetails.chapterCount) });
      }
      if (audiobookDetails.formatLabel) {
        infoItems.push({ key: 'format', label: 'Format', value: audiobookDetails.formatLabel });
      }
      if (infoItems.length === 0) {
        return <span className="history-dv-subtle">Keine Audiobook-Details</span>;
      }
      return infoItems.map((item) => (
        <span key={`${row?.id}-${item.key}`} className="history-dv-rating-chip">
          <strong>{item.label}</strong>
          <span>{item.value}</span>
        </span>
      ));
    }

    const ratings = resolveRatings(row);
    if (ratings.length === 0) {
      return <span className="history-dv-subtle">Keine Ratings</span>;
    }

    return ratings.map((rating) => (
      <span key={`${row?.id}-${rating.key}`} className="history-dv-rating-chip">
        <strong>{rating.label}</strong>
        <span>{rating.value}</span>
      </span>
    ));
  };

  const onItemKeyDown = (event, row) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      void openDetail(row);
    }
  };

  const listItem = (row) => {
    const mediaMeta = resolveMediaTypeMeta(row);
    const isCdJob = mediaMeta.mediaType === 'cd';
    const cdDetails = isCdJob ? resolveCdDetails(row) : null;
    const subtitle = isCdJob
      ? [
        `#${row?.id || '-'}`,
        cdDetails?.artist || '-',
        row?.year || null,
        cdDetails?.mbId ? 'MusicBrainz' : null
      ].filter(Boolean).join(' | ')
      : `#${row?.id || '-'} | ${row?.year || '-'} | ${row?.imdb_id || '-'}`;

    return (
      <div className="col-12" key={row.id}>
        <div
          className="history-dv-item history-dv-item-list"
          role="button"
          tabIndex={0}
          onKeyDown={(event) => onItemKeyDown(event, row)}
          onClick={() => {
            void openDetail(row);
          }}
        >
          <div className="history-dv-poster-wrap">
            {renderPoster(row)}
          </div>

          <div className="history-dv-main">
            <div className="history-dv-head">
              <div className="history-dv-title-block">
                <strong className="history-dv-title">{row?.title || row?.detected_title || '-'}</strong>
                <small className="history-dv-subtle">{subtitle}</small>
              </div>
              {renderStatusTag(row)}
            </div>

            <div className="history-dv-meta-row">
              <span className="job-step-cell">
                <img src={mediaMeta.icon} alt={mediaMeta.alt} title={mediaMeta.label} className="media-indicator-icon" />
                <span>{mediaMeta.label}</span>
              </span>
              <span className="history-dv-subtle">Start: {formatDateTime(row?.start_time)}</span>
              <span className="history-dv-subtle">Ende: {formatDateTime(row?.end_time)}</span>
            </div>

            <div className="history-dv-flags-row">
              {isCdJob ? (
                <>
                  {renderPresenceChip('Audio', Boolean(row?.outputStatus?.exists))}
                  {renderPresenceChip('Rip', Boolean(row?.ripSuccessful))}
                  {renderPresenceChip('Metadaten', Boolean(cdDetails?.artist || cdDetails?.mbId))}
                </>
              ) : (
                <>
                  {renderPresenceChip('RAW', Boolean(row?.rawStatus?.exists))}
                  {renderPresenceChip('Movie', Boolean(row?.outputStatus?.exists))}
                  {renderPresenceChip('Encode', Boolean(row?.encodeSuccess))}
                </>
              )}
            </div>

            <div className="history-dv-ratings-row">{renderSupplementalInfo(row)}</div>
          </div>

          <div className="history-dv-actions">
            <Button
              label="Details"
              icon="pi pi-search"
              size="small"
              onClick={(event) => {
                event.stopPropagation();
                void openDetail(row);
              }}
            />
          </div>
        </div>
      </div>
    );
  };

  const gridItem = (row) => {
    const mediaMeta = resolveMediaTypeMeta(row);
    const isCdJob = mediaMeta.mediaType === 'cd';
    const cdDetails = isCdJob ? resolveCdDetails(row) : null;
    const subtitle = isCdJob
      ? [
        `#${row?.id || '-'}`,
        cdDetails?.artist || '-',
        row?.year || null,
        cdDetails?.mbId ? 'MusicBrainz' : null
      ].filter(Boolean).join(' | ')
      : `#${row?.id || '-'} | ${row?.year || '-'} | ${row?.imdb_id || '-'}`;

    return (
      <div className="col-12 md-col-6 xl-col-4" key={row.id}>
        <div
          className="history-dv-item history-dv-item-grid"
          role="button"
          tabIndex={0}
          onKeyDown={(event) => onItemKeyDown(event, row)}
          onClick={() => {
            void openDetail(row);
          }}
        >
          <div className="history-dv-grid-poster-wrap">
            {renderPoster(row, 'history-dv-poster-grid')}
          </div>

          <div className="history-dv-grid-main">
            <div className="history-dv-head">
              <strong className="history-dv-title">{row?.title || row?.detected_title || '-'}</strong>
              {renderStatusTag(row)}
            </div>

            <small className="history-dv-subtle">{subtitle}</small>

            <div className="history-dv-meta-row">
              <span className="job-step-cell">
                <img src={mediaMeta.icon} alt={mediaMeta.alt} title={mediaMeta.label} className="media-indicator-icon" />
                <span>{mediaMeta.label}</span>
              </span>
              <span className="history-dv-subtle">Start: {formatDateTime(row?.start_time)}</span>
              <span className="history-dv-subtle">Ende: {formatDateTime(row?.end_time)}</span>
            </div>

            <div className="history-dv-flags-row">
              {isCdJob ? (
                <>
                  {renderPresenceChip('Audio', Boolean(row?.outputStatus?.exists))}
                  {renderPresenceChip('Rip', Boolean(row?.ripSuccessful))}
                  {renderPresenceChip('Metadaten', Boolean(cdDetails?.artist || cdDetails?.mbId))}
                </>
              ) : (
                <>
                  {renderPresenceChip('RAW', Boolean(row?.rawStatus?.exists))}
                  {renderPresenceChip('Movie', Boolean(row?.outputStatus?.exists))}
                  {renderPresenceChip('Encode', Boolean(row?.encodeSuccess))}
                </>
              )}
            </div>

            <div className="history-dv-ratings-row">{renderSupplementalInfo(row)}</div>
          </div>

          <div className="history-dv-actions history-dv-actions-grid">
            <Button
              label="Details"
              icon="pi pi-search"
              size="small"
              onClick={(event) => {
                event.stopPropagation();
                void openDetail(row);
              }}
            />
          </div>
        </div>
      </div>
    );
  };

  const itemTemplate = (row, currentLayout) => {
    if (!row) {
      return null;
    }
    return currentLayout === 'list' ? listItem(row) : gridItem(row);
  };

  const previewRelatedJobs = Array.isArray(deleteEntryPreview?.relatedJobs) ? deleteEntryPreview.relatedJobs : [];
  const previewRawPaths = Array.isArray(deleteEntryPreview?.pathCandidates?.raw) ? deleteEntryPreview.pathCandidates.raw : [];
  const previewMoviePaths = Array.isArray(deleteEntryPreview?.pathCandidates?.movie) ? deleteEntryPreview.pathCandidates.movie : [];
  const previewRawExisting = previewRawPaths.filter((item) => Boolean(item?.exists));
  const previewMovieExisting = previewMoviePaths.filter((item) => Boolean(item?.exists));
  const deleteTargetActionsDisabled = deleteEntryPreviewLoading || Boolean(deleteEntryTargetBusy) || !deleteEntryPreview;
  const deleteEntryOutputLabel = getOutputLabelForRow(deleteEntryDialogRow);
  const deleteEntryOutputShortLabel = getOutputShortLabelForRow(deleteEntryDialogRow);

  const header = (
    <div className="history-dv-toolbar">
      <InputText
        value={search}
        onChange={(event) => setSearch(event.target.value)}
        placeholder="Suche nach Titel, Interpret oder IMDb"
      />

      <Dropdown
        value={status}
        options={STATUS_FILTER_OPTIONS}
        optionLabel="label"
        optionValue="value"
        onChange={(event) => setStatus(event.value)}
        placeholder="Status"
      />

      <Dropdown
        value={mediumFilter}
        options={MEDIA_FILTER_OPTIONS}
        optionLabel="label"
        optionValue="value"
        onChange={(event) => setMediumFilter(event.value || '')}
        placeholder="Medium"
      />

      <Dropdown
        value={sortKey}
        options={SORT_OPTIONS}
        optionLabel="label"
        optionValue="value"
        onChange={onSortChange}
        placeholder="Sortieren"
      />

      <Button label="Neu laden" icon="pi pi-refresh" onClick={load} loading={loading} />

      <div className="history-dv-layout-toggle">
        <DataViewLayoutOptions layout={layout} onChange={(event) => setLayout(event.value)} />
      </div>
    </div>
  );

  return (
    <div className="page-grid">
      <Toast ref={toastRef} />

      <Card title="Historie" subTitle="PrimeReact DataView">
        <DataView
          value={visibleJobs}
          layout={layout}
          header={header}
          itemTemplate={itemTemplate}
          paginator
          rows={12}
          rowsPerPageOptions={[12, 24, 48]}
          sortField={sortField}
          sortOrder={sortOrder}
          loading={loading}
          emptyMessage="Keine Einträge"
          className="history-dataview"
        />
      </Card>

      <JobDetailDialog
        visible={detailVisible}
        job={selectedJob}
        detailLoading={detailLoading}
        onLoadLog={handleLoadLog}
        logLoadingMode={logLoadingMode}
        onRestartEncode={handleRestartEncode}
        onRestartReview={handleRestartReview}
        onReencode={handleReencode}
        onRetry={handleRetry}
        onDeleteFiles={handleDeleteFiles}
        onDeleteEntry={handleDeleteEntry}
        onRemoveFromQueue={handleRemoveFromQueue}
        isQueued={Boolean(selectedJob?.id && queuedJobIdSet.has(normalizeJobId(selectedJob.id)))}
        actionBusy={actionBusy}
        reencodeBusy={reencodeBusyJobId === selectedJob?.id}
        deleteEntryBusy={deleteEntryBusy}
        onHide={() => {
          setDetailVisible(false);
          setDetailLoading(false);
          setLogLoadingMode(null);
        }}
      />

      <Dialog
        header="Historien-Eintrag löschen"
        visible={deleteEntryDialogVisible}
        onHide={closeDeleteEntryDialog}
        style={{ width: '56rem', maxWidth: '96vw' }}
        className="history-delete-dialog"
        modal
      >
        <p>
          {`Es werden ${previewRelatedJobs.length || 1} Historien-Eintrag/Einträge entfernt.`}
        </p>

        {deleteEntryDialogRow ? (
          <small className="muted-inline">
            Job: {deleteEntryDialogRow?.title || deleteEntryDialogRow?.detected_title || `Job #${deleteEntryDialogRow?.id || '-'}`}
          </small>
        ) : null}

        {deleteEntryPreviewLoading ? (
          <p>Löschvorschau wird geladen ...</p>
        ) : (
          <div className="history-delete-preview-grid">
            <div>
              <h4>Rip/Encode Historie</h4>
              {previewRelatedJobs.length > 0 ? (
                <ul className="history-delete-preview-list">
                  {previewRelatedJobs.map((item) => (
                    <li key={`delete-related-${item.id}`}>
                      <strong>#{item.id}</strong> | {item.title || '-'} | {item.status || '-'} {item.isPrimary ? '(aktuell)' : '(Alt-Eintrag)'}
                    </li>
                  ))}
                </ul>
              ) : (
                <small className="history-dv-subtle">Keine verknüpften Alt-Einträge erkannt.</small>
              )}
            </div>

            <div>
              <h4>RAW</h4>
              {previewRawPaths.length > 0 ? (() => {
                const display = previewRawPaths.filter(p => p.exists).length > 0
                  ? previewRawPaths.filter(p => p.exists)
                  : previewRawPaths.slice(0, 1);
                return (
                  <ul className="history-delete-preview-list">
                    {display.map((item) => (
                      <li key={`delete-raw-${item.path}`}>
                        <span className={item.exists ? 'exists-yes' : 'exists-no'}>
                          {item.exists ? 'vorhanden' : 'nicht gefunden'}
                        </span>
                        {' '}| {item.path}
                      </li>
                    ))}
                  </ul>
                );
              })() : (
                <small className="history-dv-subtle">Keine RAW-Pfade.</small>
              )}
            </div>

            <div>
              <h4>{deleteEntryOutputShortLabel}</h4>
              {previewMoviePaths.length > 0 ? (() => {
                const display = previewMoviePaths.filter(p => p.exists).length > 0
                  ? previewMoviePaths.filter(p => p.exists)
                  : previewMoviePaths.slice(0, 1);
                return (
                  <ul className="history-delete-preview-list">
                    {display.map((item) => (
                      <li key={`delete-movie-${item.path}`}>
                        <span className={item.exists ? 'exists-yes' : 'exists-no'}>
                          {item.exists ? 'vorhanden' : 'nicht gefunden'}
                        </span>
                        {' '}| {item.path}
                      </li>
                    ))}
                  </ul>
                );
              })() : (
                <small className="history-dv-subtle">Keine Movie-Pfade.</small>
              )}
            </div>
          </div>
        )}

        <div className="dialog-actions">
          <Button
            label="Nur RAW löschen"
            icon="pi pi-trash"
            severity="warning"
            outlined
            onClick={() => confirmDeleteEntry('raw')}
            loading={deleteEntryTargetBusy === 'raw'}
            disabled={deleteTargetActionsDisabled}
          />
          <Button
            label={`Nur ${deleteEntryOutputShortLabel} löschen`}
            icon="pi pi-trash"
            severity="warning"
            outlined
            onClick={() => confirmDeleteEntry('movie')}
            loading={deleteEntryTargetBusy === 'movie'}
            disabled={deleteTargetActionsDisabled}
          />
          <Button
            label="Beides löschen"
            icon="pi pi-times"
            severity="danger"
            onClick={() => confirmDeleteEntry('both')}
            loading={deleteEntryTargetBusy === 'both'}
            disabled={deleteTargetActionsDisabled}
          />
          <Button
            label="Nur Eintrag löschen"
            icon="pi pi-database"
            severity="secondary"
            outlined
            onClick={() => confirmDeleteEntry('none')}
            loading={deleteEntryTargetBusy === 'none'}
            disabled={deleteTargetActionsDisabled}
          />
          <Button
            label="Abbrechen"
            severity="secondary"
            outlined
            onClick={closeDeleteEntryDialog}
            disabled={Boolean(deleteEntryTargetBusy)}
          />
        </div>
      </Dialog>
    </div>
  );
}
