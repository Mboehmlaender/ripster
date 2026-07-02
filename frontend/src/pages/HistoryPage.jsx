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
import { useWebSocket } from '../hooks/useWebSocket';
import JobDetailDialog from '../components/JobDetailDialog';
import MetadataSelectionDialog from '../components/MetadataSelectionDialog';
import CdMetadataDialog from '../components/CdMetadataDialog';
import ReencodeConflictModal from '../components/ReencodeConflictModal';
import blurayIndicatorIcon from '../assets/media-bluray.svg';
import discIndicatorIcon from '../assets/media-disc.svg';
import otherIndicatorIcon from '../assets/media-other.svg';
import mergeIndicatorIcon from '../assets/media-merge.svg';
import {
  getStatusLabel,
  getStatusSeverity,
  normalizeStatus,
  STATUS_FILTER_OPTIONS
} from '../utils/statusPresentation';
import { confirmModal } from '../utils/confirmModal';
import { isSeriesVideoJob } from '../utils/jobTaxonomy';

const MEDIA_FILTER_OPTIONS = [
  { label: 'Alle Medien', value: '' },
  { label: 'Blu-ray', value: 'bluray' },
  { label: 'Blu-ray Serie', value: 'bluray_series' },
  { label: 'DVD', value: 'dvd' },
  { label: 'DVD Serie', value: 'dvd_series' },
  { label: 'Audio CD', value: 'cd' },
  { label: 'Audiobook', value: 'audiobook' },
  { label: 'Sonstiges', value: 'other' }
];

const SORT_OPTIONS = [
  { label: 'Startzeit: Neu -> Alt', value: '!sortStartTime' },
  { label: 'Startzeit: Alt -> Neu', value: 'sortStartTime' },
  { label: 'Endzeit: Neu -> Alt', value: '!sortEndTime' },
  { label: 'Endzeit: Alt -> Neu', value: 'sortEndTime' },
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

const MULTIPART_CONTAINER_LIVE_STATUSES = new Set([
  'ANALYZING',
  'METADATA_LOOKUP',
  'METADATA_SELECTION',
  'WAITING_FOR_USER_DECISION',
  'READY_TO_START',
  'MEDIAINFO_CHECK',
  'READY_TO_ENCODE',
  'RIPPING',
  'ENCODING',
  'POST_ENCODE_SCRIPTS',
  'CD_METADATA_SELECTION',
  'CD_READY_TO_RIP',
  'CD_ANALYZING',
  'CD_RIPPING',
  'CD_ENCODING'
]);

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
    if (raw === 'converter') {
      return 'converter';
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
  const isSeriesDvd = (mediaType === 'dvd' || mediaType === 'bluray') && isSeriesVideoJob(row);
  if (mediaType === 'bluray') {
    return {
      mediaType,
      icon: blurayIndicatorIcon,
      label: isSeriesDvd ? 'Blu-ray Serie' : 'Blu-ray',
      alt: isSeriesDvd ? 'Blu-ray Serie' : 'Blu-ray'
    };
  }
  if (mediaType === 'dvd') {
    return {
      mediaType,
      icon: discIndicatorIcon,
      label: isSeriesDvd ? 'DVD Serie' : 'DVD',
      alt: isSeriesDvd ? 'DVD Serie' : 'DVD'
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
  if (mediaType === 'converter') {
    return {
      mediaType,
      icon: otherIndicatorIcon,
      label: 'Converter',
      alt: 'Converter'
    };
  }
  return {
    mediaType,
    icon: otherIndicatorIcon,
    label: 'Sonstiges',
    alt: 'Sonstiges Medium'
  };
}

function isSeriesBatchChildHistoryRow(row) {
  const encodePlan = row?.encodePlan && typeof row.encodePlan === 'object' ? row.encodePlan : null;
  if (!encodePlan) {
    return false;
  }
  return Boolean(encodePlan?.seriesBatchChild || encodePlan?.seriesBatchVirtualEpisode);
}

function isContainerHistoryRow(row) {
  const kind = String(
    row?.job_kind
    || row?.jobKind
    || row?.encodePlan?.jobKind
    || ''
  ).trim().toLowerCase();
  return kind === 'dvd_series_container' || kind === 'multipart_movie_container';
}

function isMultipartContainerHistoryRow(row) {
  const kind = String(
    row?.job_kind
    || row?.jobKind
    || row?.encodePlan?.jobKind
    || ''
  ).trim().toLowerCase();
  return kind === 'multipart_movie_container';
}

function isMultipartMergeHistoryRow(row) {
  const kind = String(
    row?.job_kind
    || row?.jobKind
    || row?.encodePlan?.jobKind
    || ''
  ).trim().toLowerCase();
  return kind === 'multipart_movie_merge';
}

function isMultipartChildHistoryRow(row) {
  const kind = String(
    row?.job_kind
    || row?.jobKind
    || row?.encodePlan?.jobKind
    || ''
  ).trim().toLowerCase();
  return kind === 'multipart_movie_child';
}

function isMultipartHistoryRow(row) {
  if (isMultipartContainerHistoryRow(row) || isMultipartMergeHistoryRow(row) || isMultipartChildHistoryRow(row)) {
    return true;
  }
  return Number(row?.is_multipart_movie || 0) === 1;
}

function isSeriesChildHistoryRow(row) {
  const kind = String(
    row?.job_kind
    || row?.jobKind
    || row?.encodePlan?.jobKind
    || ''
  ).trim().toLowerCase();
  if (kind === 'dvd_series_child' || kind === 'multipart_movie_child') {
    return true;
  }
  return Boolean(normalizeJobId(row?.parent_job_id)) && isSeriesVideoJob(row);
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
    || selectedMetadata?.musicbrainz_id
    || selectedMetadata?.music_brainz_id
    || selectedMetadata?.musicbrainz
    || selectedMetadata?.mbid
    || row?.imdb_id
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

function resolveConverterMediaType(row) {
  const encodePlan = row?.encodePlan && typeof row.encodePlan === 'object' ? row.encodePlan : {};
  const value = String(
    encodePlan?.converterMediaType
    || row?.converterMediaType
    || ''
  ).trim().toLowerCase();
  if (value === 'audio') {
    return 'audio';
  }
  if (value === 'video' || value === 'iso') {
    return 'video';
  }
  return null;
}

function hasAudioOutput(row) {
  const mediaType = resolveMediaType(row);
  if (mediaType === 'cd' || mediaType === 'audiobook') {
    return true;
  }
  if (mediaType === 'converter') {
    return resolveConverterMediaType(row) === 'audio';
  }
  return false;
}

function getOutputLabelForRow(row) {
  if (isMultipartMergeHistoryRow(row)) {
    return 'Merge-Datei(en)';
  }
  if (isMultipartContainerHistoryRow(row) || isMultipartChildHistoryRow(row)) {
    return 'Movie-Datei(en)';
  }
  if (isSeriesVideoJob(row)) {
    return 'Folgen-Datei(en)';
  }
  if (resolveMediaType(row) === 'audiobook') {
    return 'Audiobook-Datei(en)';
  }
  if (hasAudioOutput(row)) {
    return 'Audio-Dateien';
  }
  return 'Movie-Datei(en)';
}

function getOutputShortLabelForRow(row) {
  if (isMultipartMergeHistoryRow(row)) {
    return 'Merge';
  }
  if (isMultipartContainerHistoryRow(row) || isMultipartChildHistoryRow(row)) {
    return 'Movie';
  }
  if (isSeriesVideoJob(row)) {
    return 'Folgen';
  }
  if (resolveMediaType(row) === 'audiobook') {
    return 'Audiobook';
  }
  if (hasAudioOutput(row)) {
    return 'Audio';
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

function isPipelineMetadataFlowStatus(value) {
  const normalized = String(value || '').trim().toUpperCase();
  return ['METADATA_LOOKUP', 'METADATA_SELECTION', 'READY_TO_START', 'WAITING_FOR_USER_DECISION'].includes(normalized);
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

function normalizeRatingValue(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const numericValue = Number(value);
  if (Number.isFinite(numericValue) && numericValue > 0) {
    return numericValue.toFixed(1);
  }
  return sanitizeRating(value);
}

function resolveRatings(row) {
  const makemkvInfo = row?.makemkvInfo && typeof row.makemkvInfo === 'object' ? row.makemkvInfo : {};
  const encodePlan = row?.encodePlan && typeof row.encodePlan === 'object' ? row.encodePlan : {};
  const analyzeContext = makemkvInfo?.analyzeContext && typeof makemkvInfo.analyzeContext === 'object'
    ? makemkvInfo.analyzeContext
    : {};
  const selectedMetadata = analyzeContext?.selectedMetadata && typeof analyzeContext.selectedMetadata === 'object'
    ? analyzeContext.selectedMetadata
    : (makemkvInfo?.selectedMetadata && typeof makemkvInfo.selectedMetadata === 'object'
      ? makemkvInfo.selectedMetadata
      : {});
  const planMetadata = encodePlan?.metadata && typeof encodePlan.metadata === 'object'
    ? encodePlan.metadata
    : {};
  const selectedTmdbDetails = selectedMetadata?.tmdbDetails && typeof selectedMetadata.tmdbDetails === 'object'
    ? selectedMetadata.tmdbDetails
    : null;
  const planTmdbDetails = planMetadata?.tmdbDetails && typeof planMetadata.tmdbDetails === 'object'
    ? planMetadata.tmdbDetails
    : null;
  const rowTmdbDetails = row?.tmdbDetails && typeof row.tmdbDetails === 'object'
    ? row.tmdbDetails
    : null;
  const tmdbDetails = selectedTmdbDetails || planTmdbDetails || rowTmdbDetails;

  const tmdbRating = normalizeRatingValue(
    tmdbDetails?.seasonVoteAverage
    ?? tmdbDetails?.voteAverage
    ?? tmdbDetails?.imdbRating
    ?? selectedMetadata?.seasonVoteAverage
    ?? selectedMetadata?.voteAverage
    ?? selectedMetadata?.imdbRating
    ?? planMetadata?.seasonVoteAverage
    ?? planMetadata?.voteAverage
    ?? planMetadata?.imdbRating
    ?? row?.voteAverage
    ?? row?.imdbRating
  );

  if (!tmdbRating) {
    return [];
  }

  const ratings = [];
  if (tmdbRating) {
    ratings.push({ key: 'tmdb', label: 'TMDb', value: tmdbRating });
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

function parseSortableTimestamp(value) {
  if (!value) {
    return null;
  }
  const ts = Date.parse(value);
  return Number.isFinite(ts) ? ts : null;
}

function resolveSortTimestamp(...candidates) {
  for (const candidate of candidates) {
    const ts = parseSortableTimestamp(candidate);
    if (ts != null) {
      return ts;
    }
  }
  return 0;
}

export default function HistoryPage({ refreshToken = 0 }) {
  const location = useLocation();
  const navigate = useNavigate();
  const [jobs, setJobs] = useState([]);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [mediumFilter, setMediumFilter] = useState('');
  const [layout, setLayout] = useState('grid');
  const [sortKey, setSortKey] = useState('!sortStartTime');
  const [sortField, setSortField] = useState('sortStartTime');
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
  const [deleteEntryIncludeRelated, setDeleteEntryIncludeRelated] = useState(true);
  const [deleteEntrySelectedJobIds, setDeleteEntrySelectedJobIds] = useState([]);
  const [deleteEntrySelectedRawPaths, setDeleteEntrySelectedRawPaths] = useState([]);
  const [deleteEntrySelectedMoviePaths, setDeleteEntrySelectedMoviePaths] = useState([]);
  const [downloadBusyTarget, setDownloadBusyTarget] = useState(null);
  const [downloadFolderBusyPath, setDownloadFolderBusyPath] = useState(null);
  const [metadataDialogVisible, setMetadataDialogVisible] = useState(false);
  const [metadataDialogContext, setMetadataDialogContext] = useState(null);
  const [metadataAssignBusy, setMetadataAssignBusy] = useState(false);
  const [cdMetadataDialogVisible, setCdMetadataDialogVisible] = useState(false);
  const [cdMetadataDialogContext, setCdMetadataDialogContext] = useState(null);
  const [cdMetadataAssignBusy, setCdMetadataAssignBusy] = useState(false);
  const [generateNfoBusy, setGenerateNfoBusy] = useState(false);
  const [acknowledgeErrorBusy, setAcknowledgeErrorBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [queuedJobIds, setQueuedJobIds] = useState([]);
  const [conflictModalVisible, setConflictModalVisible] = useState(false);
  const [conflictModalJob, setConflictModalJob] = useState(null);
  const [conflictModalFolders, setConflictModalFolders] = useState([]);
  const [conflictModalAction, setConflictModalAction] = useState(null); // 'reencode' | 'restart_encode' | 'restart_review' | 'restart_cd_review' | 'delete_output'
  const [conflictModalMode, setConflictModalMode] = useState('reencode'); // 'reencode' | 'delete'
  const [conflictModalBusy, setConflictModalBusy] = useState(false);
  const toastRef = useRef(null);
  const wsReloadTimerRef = useRef(null);
  const progressStateByJobRef = useRef(new Map());

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
    () => jobs
      .filter((job) => !isSeriesBatchChildHistoryRow(job))
      .map((job) => ({
        ...job,
        sortTitle: normalizeSortText(job?.title || job?.detected_title || ''),
        sortMediaType: resolveMediaType(job),
        sortStartTime: resolveSortTimestamp(job?.start_time, job?.updated_at, job?.created_at, job?.end_time),
        sortEndTime: resolveSortTimestamp(job?.end_time, job?.updated_at, job?.created_at, job?.start_time)
      })),
    [jobs]
  );

  const visibleJobs = useMemo(
    () => (mediumFilter
      ? preparedJobs.filter((job) => {
        if (mediumFilter === 'bluray_series') {
          return job.sortMediaType === 'bluray' && isSeriesVideoJob(job);
        }
        if (mediumFilter === 'dvd_series') {
          return job.sortMediaType === 'dvd' && isSeriesVideoJob(job);
        }
        return job.sortMediaType === mediumFilter;
      })
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

  const scheduleLiveReload = (delayMs = 120) => {
    if (wsReloadTimerRef.current) {
      return;
    }
    wsReloadTimerRef.current = setTimeout(() => {
      wsReloadTimerRef.current = null;
      void load();
    }, delayMs);
  };

  useEffect(() => {
    api.getPref('history_layout').then((res) => {
      if (res?.value === 'list' || res?.value === 'grid') {
        setLayout(res.value);
      }
    }).catch(() => {});
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => {
      load();
    }, 300);

    return () => clearTimeout(timer);
  }, [search, status, refreshToken]);

  useEffect(() => () => {
    if (wsReloadTimerRef.current) {
      clearTimeout(wsReloadTimerRef.current);
      wsReloadTimerRef.current = null;
    }
  }, []);

  useWebSocket({
    onMessage: (message) => {
      const type = String(message?.type || '').trim().toUpperCase();
      if (!type) {
        return;
      }

      if (
        type === 'PIPELINE_STATE_CHANGED'
        || type === 'PIPELINE_QUEUE_CHANGED'
        || type === 'DISC_DETECTED'
        || type === 'DISC_REMOVED'
      ) {
        scheduleLiveReload(80);
        return;
      }

      if (type !== 'PIPELINE_PROGRESS') {
        return;
      }

      const payload = message?.payload && typeof message.payload === 'object'
        ? message.payload
        : {};
      const normalizedJobId = normalizeJobId(payload?.activeJobId);
      if (!normalizedJobId) {
        return;
      }
      const nextState = String(payload?.state || '').trim().toUpperCase();
      if (!nextState) {
        return;
      }
      const key = String(normalizedJobId);
      const prevState = progressStateByJobRef.current.get(key) || '';
      if (nextState === prevState) {
        return;
      }
      progressStateByJobRef.current.set(key, nextState);
      scheduleLiveReload(120);
    }
  });

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
      setSortKey('!sortStartTime');
      setSortField('sortStartTime');
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
      const response = await api.getJob(jobId, { includeLogs: false, forceRefresh: true });
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
    const response = await api.getJob(jobId, { includeLogs: false, forceRefresh: true });
    setSelectedJob(response.job);
  };

  const refreshDetailAfterReplacement = async (sourceJobId, replacementJobId = null) => {
    if (!detailVisible) {
      return;
    }

    const sourceId = Number(sourceJobId || 0);
    const replacementId = Number(replacementJobId || 0);
    const selectedId = Number(selectedJob?.id || 0);
    const hasReplacement = replacementId > 0 && replacementId !== sourceId;

    if (hasReplacement && selectedId === sourceId) {
      const response = await api.getJob(replacementId, { includeLogs: false, forceRefresh: true });
      setSelectedJob(response.job);
      return;
    }

    await refreshDetailIfOpen(hasReplacement ? replacementId : sourceId);
  };

  // ── Conflict Modal Helpers ─────────────────────────────────────────────────

  const mergeOutputFoldersForJob = (job, folders = []) => {
    const normalizedJobId = Number(job?.id || 0);
    const merged = [];
    const seen = new Set();
    const addFolder = (folder) => {
      const outputPath = String(folder?.output_path || '').trim();
      if (!outputPath || seen.has(outputPath)) {
        return;
      }
      seen.add(outputPath);
      merged.push({
        id: folder?.id ?? 0,
        job_id: folder?.job_id ?? (normalizedJobId || null),
        output_path: outputPath,
        label: folder?.label || null,
        created_at: folder?.created_at || null
      });
    };

    for (const folder of (Array.isArray(folders) ? folders : [])) {
      addFolder(folder);
    }
    const currentPath = String(job?.output_path || '').trim();
    if (currentPath && !seen.has(currentPath) && Boolean(job?.outputStatus?.exists)) {
      addFolder({
        id: 0,
        job_id: normalizedJobId,
        output_path: currentPath,
        label: 'Aktuelle Ausgabe',
        created_at: null
      });
    }
    return merged;
  };

  const loadOutputFoldersForJob = async (job) => {
    if (!job?.id) {
      return [];
    }
    try {
      const response = await api.getOutputFolders(job.id);
      return mergeOutputFoldersForJob(job, response?.folders);
    } catch (_error) {
      return mergeOutputFoldersForJob(job, []);
    }
  };

  const openConflictModal = async (job, action, mode = 'reencode', preloadedFolders = null) => {
    const folders = Array.isArray(preloadedFolders)
      ? mergeOutputFoldersForJob(job, preloadedFolders)
      : await loadOutputFoldersForJob(job);
    if (folders.length === 0) {
      return false;
    }
    setConflictModalJob(job);
    setConflictModalAction(action);
    setConflictModalMode(mode);
    setConflictModalFolders(folders);
    setConflictModalVisible(true);
    return true;
  };

  const closeConflictModal = () => {
    if (conflictModalBusy) return;
    setConflictModalVisible(false);
    setConflictModalJob(null);
    setConflictModalAction(null);
    setConflictModalMode('reencode');
    setConflictModalFolders([]);
  };

  const executeHistoryAction = async (job, action, options = {}, executionOptions = {}) => {
    const skipConfirm = Boolean(executionOptions?.skipConfirm);
    if (action === 'reencode') {
      setReencodeBusyJobId(job.id);
      try {
        await api.reencodeJob(job.id, options);
        toastRef.current?.show({ severity: 'success', summary: 'Re-Encode gestartet', detail: 'Job wurde in die Mediainfo-Prüfung gesetzt.', life: 3500 });
        await load();
        await refreshDetailIfOpen(job.id);
      } catch (error) {
        toastRef.current?.show({ severity: 'error', summary: 'Re-Encode fehlgeschlagen', detail: error.message, life: 4500 });
      } finally {
        setReencodeBusyJobId(null);
      }
    } else if (action === 'restart_encode') {
      setActionBusy(true);
      try {
        const response = await api.restartEncodeWithLastSettings(job.id, {
          ...(options || {}),
          createNewJob: true
        });
        const result = getQueueActionResult(response);
        const replacementJobId = normalizeJobId(result?.jobId);
        if (result.queued) {
          toastRef.current?.show({ severity: 'info', summary: 'Encode-Neustart in Queue', detail: result.queuePosition > 0 ? `Position ${result.queuePosition}` : 'In der Warteschlange eingeplant.', life: 3500 });
        } else {
          toastRef.current?.show({ severity: 'success', summary: 'Encode-Neustart gestartet', detail: 'Letzte bestätigte Einstellungen werden verwendet.', life: 3500 });
        }
        await load();
        await refreshDetailAfterReplacement(job.id, replacementJobId);
      } catch (error) {
        toastRef.current?.show({ severity: 'error', summary: 'Encode-Neustart fehlgeschlagen', detail: error.message, life: 4500 });
      } finally {
        setActionBusy(false);
      }
    } else if (action === 'restart_review') {
      const title = job?.title || job?.detected_title || `Job #${job?.id}`;
      const isAudiobookJob = resolveMediaType(job) === 'audiobook';
      if (!skipConfirm) {
        const confirmed = await confirmModal({
          header: isAudiobookJob ? 'Vorprüfung starten' : 'Review neu starten',
          message: isAudiobookJob
            ? `Vorprüfung für "${title}" starten?\nDer Job wird neu angelegt und kann danach im Ripper vor dem Encode angepasst werden.`
            : `Review für "${title}" neu starten?\nDer Job wird erneut analysiert. Spur- und Skriptauswahl kann danach im Ripper neu getroffen werden.`,
          acceptLabel: isAudiobookJob ? 'Vorprüfung starten' : 'Review starten',
          rejectLabel: 'Abbrechen'
        });
        if (!confirmed) {
          return;
        }
      }
      setActionBusy(true);
      try {
        const response = await api.restartReviewFromRaw(job.id, {
          ...(options || {}),
          createNewJob: true
        });
        const result = getQueueActionResult(response);
        const replacementJobId = normalizeJobId(result?.jobId);
        toastRef.current?.show({
          severity: 'success',
          summary: isAudiobookJob ? 'Vorprüfung gestartet' : 'Review-Neustart',
          detail: isAudiobookJob
            ? 'Job neu angelegt. Im Ripper können die Encode-Einstellungen angepasst werden.'
            : 'Analyse gestartet. Job ist jetzt im Ripper verfügbar.',
          life: 3500
        });
        await load();
        await refreshDetailAfterReplacement(job.id, replacementJobId);
      } catch (error) {
        toastRef.current?.show({
          severity: 'error',
          summary: isAudiobookJob ? 'Vorprüfung fehlgeschlagen' : 'Review-Neustart fehlgeschlagen',
          detail: error.message,
          life: 4500
        });
      } finally {
        setActionBusy(false);
      }
    } else if (action === 'restart_cd_review') {
      const title = job?.title || job?.detected_title || `Job #${job?.id}`;
      if (!skipConfirm) {
        const confirmed = await confirmModal({
          header: 'CD-Vorprüfung starten',
          message: `CD-Vorprüfung für "${title}" starten?\nTrackauswahl und Ausgabeeinstellungen werden im Ripper geöffnet.`,
          acceptLabel: 'Vorprüfung starten',
          rejectLabel: 'Abbrechen'
        });
        if (!confirmed) {
          return;
        }
      }
      setActionBusy(true);
      try {
        await api.restartCdReviewFromRaw(job.id, options);
        toastRef.current?.show({
          severity: 'success',
          summary: 'CD-Vorprüfung gestartet',
          detail: 'Job ist jetzt im Ripper verfügbar — bitte Tracks und Einstellungen prüfen.',
          life: 4000
        });
        await load();
        await refreshDetailIfOpen(job.id);
      } catch (error) {
        toastRef.current?.show({ severity: 'error', summary: 'CD-Vorprüfung fehlgeschlagen', detail: error.message, life: 4500 });
      } finally {
        setActionBusy(false);
      }
    } else if (action === 'delete_output') {
      const deleteFolders = Array.isArray(options?.deleteFolders)
        ? options.deleteFolders.filter((value) => typeof value === 'string' && value.trim())
        : [];
      if (deleteFolders.length === 0) {
        toastRef.current?.show({
          severity: 'warn',
          summary: 'Keine Ordner gewählt',
          detail: 'Es wurden keine Output-Ordner zum Löschen erkannt.',
          life: 3500
        });
        return;
      }
      setActionBusy(true);
      try {
        const response = await api.deleteOutputFolders(job.id, deleteFolders);
        const result = response?.result && typeof response.result === 'object' ? response.result : {};
        const deletedCount = Array.isArray(result.deleted) ? result.deleted.length : 0;
        const failedCount = Array.isArray(result.failed) ? result.failed.length : 0;
        toastRef.current?.show({
          severity: failedCount > 0 ? 'warn' : 'success',
          summary: failedCount > 0 ? 'Output teilweise gelöscht' : 'Output gelöscht',
          detail: failedCount > 0
            ? `${deletedCount} Ordner gelöscht, ${failedCount} mit Fehler.`
            : `${deletedCount} Ordner gelöscht.`,
          life: 4000
        });
        await load();
        await refreshDetailIfOpen(job.id);
      } catch (error) {
        toastRef.current?.show({ severity: 'error', summary: 'Output löschen fehlgeschlagen', detail: error.message, life: 4500 });
      } finally {
        setActionBusy(false);
      }
    }
  };

  const handleConflictKeepBoth = async () => {
    const job = conflictModalJob;
    const action = conflictModalAction;
    setConflictModalBusy(true);
    try {
      await executeHistoryAction(job, action, { keepBoth: true }, { skipConfirm: true });
      closeConflictModal();
    } finally {
      setConflictModalBusy(false);
    }
  };

  const handleConflictDeleteSelected = async (selectedPaths) => {
    const job = conflictModalJob;
    const action = conflictModalAction;
    const selected = Array.isArray(selectedPaths)
      ? selectedPaths.filter((value) => typeof value === 'string' && value.trim())
      : [];
    const allKnownPaths = conflictModalFolders
      .map((folder) => String(folder?.output_path || '').trim())
      .filter(Boolean);
    const deleteFolders = selected.length > 0 ? selected : allKnownPaths;
    setConflictModalBusy(true);
    try {
      const options = deleteFolders.length > 0 ? { deleteFolders } : {};
      await executeHistoryAction(job, action, options, { skipConfirm: true });
      closeConflictModal();
    } finally {
      setConflictModalBusy(false);
    }
  };

  // ── File deletion ──────────────────────────────────────────────────────────

  const handleDeleteFiles = async (row, target) => {
    const isContainerRow = isContainerHistoryRow(row);
    const isMultipartContainerRow = isMultipartContainerHistoryRow(row);
    const isMultipartChildRow = isMultipartChildHistoryRow(row);
    const isSeriesChildRow = isSeriesChildHistoryRow(row);
    const includeRelated = isContainerRow
      || (isSeriesChildRow && (target === 'movie' || target === 'both'));

    if (target === 'movie' && !isSeriesChildRow) {
      const outputFolders = await loadOutputFoldersForJob(row);
      if (outputFolders.length > 1) {
        await openConflictModal(row, 'delete_output', 'delete', outputFolders);
        return;
      }
    }

    const outputLabel = getOutputLabelForRow(row);
    const outputShortLabel = getOutputShortLabelForRow(row);
    const label = target === 'raw' ? 'RAW-Dateien' : target === 'movie' ? outputLabel : `RAW + ${outputShortLabel}`;
    const title = row.title || row.detected_title || `Job #${row.id}`;
    const scopeSuffix = isContainerRow
      ? (isMultipartContainerRow
          ? '\nScope: kompletter Multipart-Container (alle zugehörigen RAWs/Outputs).'
          : '\nScope: kompletter Serien-Container (alle zugehörigen RAWs/Outputs).')
      : isSeriesChildRow && target === 'raw'
        ? '\nScope: nur RAW dieses Disk-Jobs.'
        : isSeriesChildRow && (target === 'movie' || target === 'both')
          ? (isMultipartChildRow
              ? '\nScope: diese Disk inkl. zugehöriger Child-/Subjobs (Movie).'
              : '\nScope: diese Disk inkl. zugehöriger Child-/Subjobs (Folgen).')
          : includeRelated
            ? '\nScope: verknüpfte Jobs werden einbezogen.'
            : '';
    const confirmed = await confirmModal({
      header: 'Dateien löschen',
      message: `${label} für "${title}" wirklich löschen?${scopeSuffix}`,
      acceptLabel: 'Löschen',
      rejectLabel: 'Abbrechen',
      danger: true
    });
    if (!confirmed) {
      return;
    }

    setActionBusy(true);
    try {
      let summary = {};
      if (target === 'both' && isSeriesChildRow) {
        // Disk-RAW nur am Disk-Job löschen, Folgen jedoch diskweit inkl. Subjobs.
        const rawResponse = await api.deleteJobFiles(row.id, 'raw', { includeRelated: false });
        const movieResponse = await api.deleteJobFiles(row.id, 'movie', { includeRelated: true });
        summary = {
          target: 'both',
          raw: rawResponse?.summary?.raw || {},
          movie: movieResponse?.summary?.movie || {}
        };
      } else {
        const response = await api.deleteJobFiles(row.id, target, { includeRelated });
        summary = response?.summary || {};
      }
      const rawSummary = summary.raw || {};
      const movieSummary = summary.movie || {};
      const deletedSomething = target === 'raw'
        ? Boolean(rawSummary.deleted)
        : target === 'movie'
          ? Boolean(movieSummary.deleted)
          : Boolean(rawSummary.deleted || movieSummary.deleted);

      if (!deletedSomething) {
        const reason = target === 'raw'
          ? (rawSummary.reason || 'Keine passenden RAW-Dateien/Ordner gefunden.')
          : target === 'movie'
            ? (movieSummary.reason || `Keine passenden ${outputShortLabel}-Dateien/Ordner gefunden.`)
            : (movieSummary.reason || rawSummary.reason || 'Keine passenden Dateien/Ordner gefunden.');
        toastRef.current?.show({
          severity: 'warn',
          summary: 'Nichts gelöscht',
          detail: reason,
          life: 4200
        });
      } else {
        toastRef.current?.show({
          severity: 'success',
          summary: 'Dateien gelöscht',
          detail: `RAW: ${rawSummary.filesDeleted ?? 0}, ${outputShortLabel}: ${movieSummary.filesDeleted ?? 0}`,
          life: 3500
        });
      }
      await load();
      await refreshDetailIfOpen(row.id);
    } catch (error) {
      toastRef.current?.show({ severity: 'error', summary: 'Löschen fehlgeschlagen', detail: error.message, life: 4500 });
    } finally {
      setActionBusy(false);
    }
  };

  const handleDownloadArchive = async (row, target) => {
    const jobId = Number(row?.id || selectedJob?.id || 0);
    const normalizedTarget = String(target || '').trim().toLowerCase();
    if (!jobId || !['raw', 'output'].includes(normalizedTarget)) {
      return;
    }

    setDownloadBusyTarget(normalizedTarget);
    try {
      const response = await api.requestJobArchive(jobId, normalizedTarget);
      const item = response?.item && typeof response.item === 'object' ? response.item : null;
      const label = normalizedTarget === 'raw' ? 'RAW' : 'Encode';
      const isReady = String(item?.status || '').trim().toLowerCase() === 'ready';
      const detail = isReady
        ? `${label}-ZIP ist bereits auf der Downloads-Seite verfuegbar.`
        : `${label}-ZIP wird im Hintergrund erstellt und erscheint danach auf der Downloads-Seite.`;
      toastRef.current?.show({
        severity: isReady ? 'success' : 'info',
        summary: isReady ? 'ZIP bereit' : 'ZIP wird erstellt',
        detail,
        life: 4000
      });
    } catch (error) {
      toastRef.current?.show({
        severity: 'error',
        summary: 'Download fehlgeschlagen',
        detail: error.message,
        life: 4500
      });
    } finally {
      setDownloadBusyTarget(null);
    }
  };

  const handleDownloadOutputFolder = async (row, folderPath, ownerJobId = null) => {
    const jobId = Number(ownerJobId || row?.id || selectedJob?.id || 0);
    if (!jobId || !folderPath) return;
    setDownloadFolderBusyPath(folderPath);
    try {
      const response = await api.requestJobArchive(jobId, 'output', { outputPath: folderPath });
      const item = response?.item && typeof response.item === 'object' ? response.item : null;
      const isReady = String(item?.status || '').trim().toLowerCase() === 'ready';
      toastRef.current?.show({
        severity: isReady ? 'success' : 'info',
        summary: isReady ? 'ZIP bereit' : 'ZIP wird erstellt',
        detail: isReady
          ? 'Output-ZIP ist bereits auf der Downloads-Seite verfügbar.'
          : 'Output-ZIP wird im Hintergrund erstellt und erscheint danach auf der Downloads-Seite.',
        life: 4000
      });
    } catch (error) {
      toastRef.current?.show({ severity: 'error', summary: 'Download fehlgeschlagen', detail: error.message, life: 4500 });
    } finally {
      setDownloadFolderBusyPath(null);
    }
  };

  const maybeOpenOutputConflictModal = async (row, action) => {
    const outputFolders = await loadOutputFoldersForJob(row);
    if (outputFolders.length === 0) {
      return false;
    }
    await openConflictModal(row, action, 'reencode', outputFolders);
    return true;
  };

  const handleReencode = async (row) => {
    if (await maybeOpenOutputConflictModal(row, 'reencode')) {
      return;
    }
    await executeHistoryAction(row, 'reencode');
  };

  const handleRestartEncode = async (row) => {
    if (await maybeOpenOutputConflictModal(row, 'restart_encode')) {
      return;
    }
    await executeHistoryAction(row, 'restart_encode');
  };

  const handleRestartReview = async (row) => {
    if (await maybeOpenOutputConflictModal(row, 'restart_review')) {
      return;
    }
    await executeHistoryAction(row, 'restart_review');
  };

  const handleRestartCdReview = async (row) => {
    if (await maybeOpenOutputConflictModal(row, 'restart_cd_review')) {
      return;
    }
    await executeHistoryAction(row, 'restart_cd_review');
  };

  const handleRetry = async (row) => {
    const title = row?.title || row?.detected_title || `Job #${row?.id}`;
    const mediaType = resolveMediaType(row);
    const diskLabel = mediaType === 'cd' ? 'CD' : 'Disk';
    const confirmed = await confirmModal({
      header: 'Rip neu starten',
      message: `Bitte lege die korrekte ${diskLabel} für "${title}" ein.\nSoll der Rip jetzt gestartet werden?`,
      acceptLabel: 'Rip starten',
      rejectLabel: 'Abbrechen'
    });
    if (!confirmed) {
      return;
    }

    setActionBusy(true);
    try {
      const response = await api.retryJob(row.id, { createNewJob: true });
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
        const detailResponse = await api.getJob(replacementJobId, { includeLogs: false, forceRefresh: true });
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

  const handleGenerateNfo = async (row) => {
    const jobId = Number(row?.id || 0);
    if (!jobId) {
      return;
    }
    setGenerateNfoBusy(true);
    try {
      const response = await api.generateJobNfo(jobId);
      const nfoPath = String(response?.result?.nfoPath || '').trim() || null;
      toastRef.current?.show({
        severity: 'success',
        summary: 'NFO erzeugt',
        detail: nfoPath ? `Datei erstellt: ${nfoPath}` : 'NFO-Datei wurde erstellt.',
        life: 4000
      });
      if (response?.job) {
        setSelectedJob(response.job);
      } else {
        await refreshDetailIfOpen(jobId);
      }
      await load();
    } catch (error) {
      toastRef.current?.show({
        severity: 'error',
        summary: 'NFO-Erzeugung fehlgeschlagen',
        detail: error.message,
        life: 4500
      });
    } finally {
      setGenerateNfoBusy(false);
    }
  };

  const handleAssignMetadata = (row) => {
    const jobId = Number(row?.id || 0);
    if (!jobId) return;
    const makemkvInfo = row?.makemkvInfo && typeof row.makemkvInfo === 'object' ? row.makemkvInfo : {};
    const analyzeContext = makemkvInfo?.analyzeContext && typeof makemkvInfo.analyzeContext === 'object'
      ? makemkvInfo.analyzeContext
      : {};
    const selectedMetadata = analyzeContext?.selectedMetadata && typeof analyzeContext.selectedMetadata === 'object'
      ? analyzeContext.selectedMetadata
      : (makemkvInfo?.selectedMetadata && typeof makemkvInfo.selectedMetadata === 'object'
        ? makemkvInfo.selectedMetadata
        : {});
    const workflowKindRaw = String(
      selectedMetadata?.workflowKind
      || analyzeContext?.workflowKind
      || ''
    ).trim().toLowerCase();
    const workflowKind = ['film', 'movie', 'feature'].includes(workflowKindRaw)
      ? 'film'
      : (['series', 'tv', 'season', 'episode'].includes(workflowKindRaw) ? 'series' : null);
    const rowMediaType = resolveMediaType(row);
    const isSeriesDvd = (rowMediaType === 'dvd' || rowMediaType === 'bluray') && isSeriesVideoJob(row);
    const metadataProvider = 'tmdb';
    const seasonNumber = selectedMetadata?.seasonNumber ?? analyzeContext?.seriesLookupHint?.seasonNumber ?? null;
    const discNumber = selectedMetadata?.discNumber ?? analyzeContext?.seriesLookupHint?.discNumber ?? null;
    const context = {
      jobId,
      status: row?.status || null,
      lastState: row?.last_state || null,
      submitMode: (
        isPipelineMetadataFlowStatus(row?.status)
        || isPipelineMetadataFlowStatus(row?.last_state)
      )
        ? 'pipeline'
        : 'assign',
      detectedTitle: row?.detected_title || row?.title || '',
      selectedMetadata: {
        ...(selectedMetadata && typeof selectedMetadata === 'object' ? selectedMetadata : {}),
        title: row?.title || selectedMetadata?.title || row?.detected_title || '',
        year: row?.year || selectedMetadata?.year || null,
        imdbId: row?.imdb_id || selectedMetadata?.imdbId || null,
        poster: row?.poster_url || selectedMetadata?.poster || null,
        metadataProvider,
        tmdbId: selectedMetadata?.tmdbId || null,
        providerId: selectedMetadata?.providerId || null,
        metadataKind: selectedMetadata?.metadataKind || (isSeriesDvd ? 'season' : null),
        seasonNumber,
        seasonName: selectedMetadata?.seasonName || null,
        episodeCount: selectedMetadata?.episodeCount || 0,
        episodes: Array.isArray(selectedMetadata?.episodes) ? selectedMetadata.episodes : [],
        ...(discNumber ? { discNumber } : {})
      },
      metadataProvider,
      workflowKind: workflowKind || analyzeContext?.workflowKind || null,
      metadataCandidates: Array.isArray(analyzeContext?.metadataCandidates) ? analyzeContext.metadataCandidates : [],
      seriesAnalysis: analyzeContext?.seriesAnalysis || null,
      seriesLookupHint: analyzeContext?.seriesLookupHint || null,
      seriesDecision: analyzeContext?.seriesDecision || null
    };
    setMetadataDialogContext(context);
    setMetadataDialogVisible(true);
  };

  const handleMetadataSearch = async (query, options = {}) => {
    try {
      const tmdbSeasonHint = metadataDialogContext?.selectedMetadata?.seasonNumber
        ?? metadataDialogContext?.seriesLookupHint?.seasonNumber
        ?? null;
      const filterRaw = String(options?.resultFilter || '').trim().toLowerCase();
      const includeMovies = filterRaw !== 'series';
      const includeSeries = filterRaw !== 'movies' && filterRaw !== 'movie';
      const [movieResponse, seriesResponse] = await Promise.all([
        includeMovies ? api.searchTmdbMovie(query) : Promise.resolve({ results: [] }),
        includeSeries ? api.searchTmdbSeries(query, tmdbSeasonHint) : Promise.resolve({ results: [] })
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
    } catch (error) {
      toastRef.current?.show({
        severity: 'error',
        summary: 'TMDb-Suche fehlgeschlagen',
        detail: error.message
      });
      return [];
    }
  };

  const handleMetadataSubmit = async (payload) => {
    const submitMode = String(metadataDialogContext?.submitMode || 'assign').trim().toLowerCase() || 'assign';
    const isPipelineFlow = submitMode === 'pipeline';
    setMetadataAssignBusy(true);
    try {
      if (isPipelineFlow) {
        const selectResponse = await api.selectMetadata(payload);
        const selectedJobUpdate = selectResponse?.job && typeof selectResponse.job === 'object'
          ? selectResponse.job
          : null;
        if (selectedJobUpdate?.id) {
          const normalizedSelectedId = Number(selectedJobUpdate.id);
          setJobs((prev) => (
            Array.isArray(prev)
              ? prev.map((row) => (Number(row?.id || 0) === normalizedSelectedId ? { ...row, ...selectedJobUpdate } : row))
              : prev
          ));
          setSelectedJob((prev) => (
            Number(prev?.id || 0) === normalizedSelectedId
              ? { ...(prev || {}), ...selectedJobUpdate }
              : prev
          ));
        }
        setMetadataDialogVisible(false);
        setMetadataDialogContext(null);

        try {
          const startResponse = await api.startJob(payload.jobId);
          const startResult = getQueueActionResult(startResponse);
          if (startResult.queued) {
            toastRef.current?.show({
              severity: 'info',
              summary: 'Job in Queue',
              detail: startResult.queuePosition > 0
                ? `Metadaten übernommen. Start wurde in Queue-Position ${startResult.queuePosition} eingeplant.`
                : 'Metadaten übernommen. Start wurde in der Queue eingeplant.',
              life: 3500
            });
          } else {
            toastRef.current?.show({
              severity: 'success',
              summary: 'Job gestartet',
              detail: 'Metadaten übernommen. Die Verarbeitung wurde gestartet.',
              life: 3200
            });
          }
        } catch (startError) {
          const startMessage = String(startError?.message || '').trim();
          const waitingForPlaylist = startMessage.includes('waiting_for_manual_playlist_selection');
          toastRef.current?.show({
            severity: waitingForPlaylist ? 'warn' : 'error',
            summary: waitingForPlaylist ? 'Metadaten übernommen' : 'Start fehlgeschlagen',
            detail: waitingForPlaylist
              ? 'Metadaten wurden übernommen, aber es fehlt noch eine Titel-/Playlist-Auswahl. Bitte im Ripper fortsetzen.'
              : (startMessage || 'Job konnte nach der Metadaten-Übernahme nicht gestartet werden.'),
            life: waitingForPlaylist ? 4200 : 4500
          });
        }

        await load();
        await refreshDetailIfOpen(payload.jobId);
        return;
      }

      const assignResponse = await api.assignJobMetadata(payload.jobId, payload);
      const assignedJobUpdate = assignResponse?.job && typeof assignResponse.job === 'object'
        ? assignResponse.job
        : null;
      if (assignedJobUpdate?.id) {
        const normalizedAssignedId = Number(assignedJobUpdate.id);
        setJobs((prev) => (
          Array.isArray(prev)
            ? prev.map((row) => (Number(row?.id || 0) === normalizedAssignedId ? { ...row, ...assignedJobUpdate } : row))
            : prev
        ));
        setSelectedJob((prev) => (
          Number(prev?.id || 0) === normalizedAssignedId
            ? { ...(prev || {}), ...assignedJobUpdate }
            : prev
        ));
      }
      toastRef.current?.show({
        severity: 'success',
        summary: 'Metadaten zugewiesen',
        detail: 'TMDb-Metadaten wurden aktualisiert.',
        life: 3000
      });
      setMetadataDialogVisible(false);
      setMetadataDialogContext(null);
      await load();
      await refreshDetailIfOpen(payload.jobId);
    } catch (error) {
      if (isPipelineFlow) {
        throw error;
      }
      toastRef.current?.show({
        severity: 'error',
        summary: 'TMDb-Zuweisung fehlgeschlagen',
        detail: error.message
      });
    } finally {
      setMetadataAssignBusy(false);
    }
  };

  const handleAssignCdMetadata = (row) => {
    const jobId = Number(row?.id || 0);
    if (!jobId) return;
    const makemkvInfo = row?.makemkvInfo && typeof row.makemkvInfo === 'object' ? row.makemkvInfo : {};
    const encodePlan = row?.encodePlan && typeof row.encodePlan === 'object' ? row.encodePlan : {};
    const tracks = Array.isArray(makemkvInfo?.tracks) && makemkvInfo.tracks.length > 0
      ? makemkvInfo.tracks
      : (Array.isArray(encodePlan?.tracks) ? encodePlan.tracks : []);
    const context = {
      jobId,
      detectedTitle: row?.detected_title || row?.title || '',
      tracks,
      selectedMetadata: makemkvInfo?.selectedMetadata || {}
    };
    setCdMetadataDialogContext(context);
    setCdMetadataDialogVisible(true);
  };

  const handleMusicBrainzSearch = async (query, options = {}) => {
    try {
      const response = await api.searchMusicBrainz(query, {
        trackCount: Number(options?.trackCount || 0) > 0 ? Math.trunc(Number(options.trackCount)) : null
      });
      return response.results || [];
    } catch (error) {
      toastRef.current?.show({ severity: 'error', summary: 'MusicBrainz-Suche fehlgeschlagen', detail: error.message });
      return [];
    }
  };

  const handleMusicBrainzReleaseFetch = async (mbId) => {
    try {
      const response = await api.getMusicBrainzRelease(mbId);
      return response?.release || null;
    } catch (error) {
      toastRef.current?.show({ severity: 'error', summary: 'MusicBrainz-Abruf fehlgeschlagen', detail: error.message });
      return null;
    }
  };

  const handleCdMetadataSubmit = async (payload) => {
    setCdMetadataAssignBusy(true);
    try {
      await api.assignJobCdMetadata(payload.jobId, payload);
      toastRef.current?.show({ severity: 'success', summary: 'Metadaten zugewiesen', detail: 'MusicBrainz-Metadaten wurden aktualisiert.', life: 3000 });
      setCdMetadataDialogVisible(false);
      setCdMetadataDialogContext(null);
      await load();
      await refreshDetailIfOpen(payload.jobId);
    } catch (error) {
      toastRef.current?.show({ severity: 'error', summary: 'Metadaten-Zuweisung fehlgeschlagen', detail: error.message });
    } finally {
      setCdMetadataAssignBusy(false);
    }
  };

  const handleAcknowledgeError = async (job) => {
    const jobId = normalizeJobId(job?.id || selectedJob?.id);
    if (!jobId) {
      return;
    }
    setAcknowledgeErrorBusy(true);
    try {
      const response = await api.acknowledgeJobError(jobId);
      const updated = response?.job || null;
      if (updated) {
        setSelectedJob(updated);
      }
      await load();
      toastRef.current?.show({
        severity: 'success',
        summary: 'Fehler quittiert',
        detail: `Job #${jobId} wurde quittiert.`,
        life: 2500
      });
    } catch (error) {
      toastRef.current?.show({
        severity: 'error',
        summary: 'Quittierung fehlgeschlagen',
        detail: error.message,
        life: 4500
      });
    } finally {
      setAcknowledgeErrorBusy(false);
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
    setDeleteEntryIncludeRelated(true);
    setDeleteEntrySelectedJobIds([]);
    setDeleteEntrySelectedRawPaths([]);
    setDeleteEntrySelectedMoviePaths([]);
  };

  const handleDeleteEntry = async (row, options = {}) => {
    const jobId = Number(row?.id || 0);
    if (!jobId) {
      return;
    }
    const isMergeJob = isMultipartMergeHistoryRow(row);
    const includeRelated = options?.includeRelated !== undefined
      ? options.includeRelated !== false
      : !isMergeJob;
    setDeleteEntryDialogRow(row);
    setDeleteEntryPreview(null);
    setDeleteEntryIncludeRelated(includeRelated);
    setDeleteEntrySelectedJobIds([]);
    setDeleteEntrySelectedRawPaths([]);
    setDeleteEntrySelectedMoviePaths([]);
    setDeleteEntryDialogVisible(true);
    setDeleteEntryPreviewLoading(true);
    setDeleteEntryBusy(true);
    try {
      const response = await api.getJobDeletePreview(jobId, { includeRelated });
      const preview = response?.preview || null;
      const relatedJobs = Array.isArray(preview?.relatedJobs) ? preview.relatedJobs : [];
      const selectedJobIds = Array.isArray(preview?.selectedJobIds)
        ? preview.selectedJobIds.map((id) => normalizeJobId(id)).filter(Boolean)
        : relatedJobs
          .map((item) => normalizeJobId(item?.id))
          .filter(Boolean);
      setDeleteEntryPreview(preview);
      setDeleteEntrySelectedJobIds(selectedJobIds);
      const rawCandidates = Array.isArray(preview?.pathCandidates?.raw) ? preview.pathCandidates.raw : [];
      const defaultSelectedRawPaths = rawCandidates
        .filter((item) => Boolean(item?.exists))
        .map((item) => String(item?.path || '').trim())
        .filter(Boolean);
      setDeleteEntrySelectedRawPaths(defaultSelectedRawPaths);
      const movieCandidates = Array.isArray(preview?.pathCandidates?.movie) ? preview.pathCandidates.movie : [];
      const defaultSelectedMoviePaths = movieCandidates
        .filter((item) => Boolean(item?.exists))
        .map((item) => String(item?.path || '').trim())
        .filter(Boolean);
      setDeleteEntrySelectedMoviePaths(defaultSelectedMoviePaths);
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
      setDeleteEntryIncludeRelated(true);
      setDeleteEntrySelectedJobIds([]);
      setDeleteEntrySelectedRawPaths([]);
      setDeleteEntrySelectedMoviePaths([]);
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
    const isMergeJob = isMultipartMergeHistoryRow(deleteEntryDialogRow);
    if (isMergeJob && (normalizedTarget === 'raw' || normalizedTarget === 'both')) {
      return;
    }
    const jobId = Number(deleteEntryDialogRow?.id || 0);
    if (!jobId) {
      return;
    }
    if (
      (normalizedTarget === 'raw' || normalizedTarget === 'both')
      && rawDeleteSelectionEnabled
      && deleteEntrySelectedRawPaths.length === 0
    ) {
      toastRef.current?.show({
        severity: 'warn',
        summary: 'RAW-Auswahl erforderlich',
        detail: 'Bitte mindestens einen RAW-Pfad zum Löschen auswählen.',
        life: 3500
      });
      return;
    }
    if (
      (normalizedTarget === 'movie' || normalizedTarget === 'both')
      && previewMovieExisting.length > 0
      && deleteEntrySelectedMoviePaths.length === 0
    ) {
      toastRef.current?.show({
        severity: 'warn',
        summary: `${deleteEntryOutputShortLabel}-Dateien auswählen`,
        detail: `Bitte mindestens eine ${deleteEntryOutputShortLabel}-Datei zum Löschen auswählen.`,
        life: 3500
      });
      return;
    }

    setDeleteEntryBusy(true);
    setDeleteEntryTargetBusy(normalizedTarget);
    try {
      const response = await api.deleteJobEntry(jobId, normalizedTarget, {
        includeRelated: deleteEntryIncludeRelated,
        selectedJobIds: deleteEntrySelectedJobIds,
        selectedRawPaths: deleteEntrySelectedRawPaths,
        selectedMoviePaths: deleteEntrySelectedMoviePaths
      });
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

  const confirmDeleteFilesOnly = async (target = 'both') => {
    const normalizedTarget = String(target || '').trim().toLowerCase();
    if (!['raw', 'movie', 'both'].includes(normalizedTarget)) {
      return;
    }
    const jobId = Number(deleteEntryDialogRow?.id || 0);
    if (!jobId) {
      return;
    }
    if (
      (normalizedTarget === 'raw' || normalizedTarget === 'both')
      && rawDeleteSelectionEnabled
      && deleteEntrySelectedRawPaths.length === 0
    ) {
      toastRef.current?.show({
        severity: 'warn',
        summary: 'RAW-Auswahl erforderlich',
        detail: 'Bitte mindestens einen RAW-Pfad zum Löschen auswählen.',
        life: 3500
      });
      return;
    }
    if (
      (normalizedTarget === 'movie' || normalizedTarget === 'both')
      && previewMovieExisting.length > 0
      && deleteEntrySelectedMoviePaths.length === 0
    ) {
      toastRef.current?.show({
        severity: 'warn',
        summary: `${deleteEntryOutputShortLabel}-Dateien auswählen`,
        detail: `Bitte mindestens eine ${deleteEntryOutputShortLabel}-Datei zum Löschen auswählen.`,
        life: 3500
      });
      return;
    }

    setDeleteEntryBusy(true);
    setDeleteEntryTargetBusy(`files-${normalizedTarget}`);
    try {
      const response = await api.deleteJobFiles(jobId, normalizedTarget, {
        includeRelated: deleteEntryIncludeRelated,
        selectedJobIds: deleteEntrySelectedJobIds,
        selectedRawPaths: deleteEntrySelectedRawPaths,
        selectedMoviePaths: deleteEntrySelectedMoviePaths
      });
      const summary = response?.summary || {};
      const rawFiles = Number(summary?.raw?.filesDeleted || 0);
      const movieFiles = Number(summary?.movie?.filesDeleted || 0);
      const rawDirs = Number(summary?.raw?.dirsRemoved || 0);
      const movieDirs = Number(summary?.movie?.dirsRemoved || 0);
      toastRef.current?.show({
        severity: 'success',
        summary: 'Dateien gelöscht',
        detail: `Einträge bleiben bestehen | RAW: ${rawFiles} Dateien, ${rawDirs} Ordner | ${deleteEntryOutputShortLabel}: ${movieFiles} Dateien, ${movieDirs} Ordner`,
        life: 5000
      });

      closeDeleteEntryDialog();
      await load();
    } catch (error) {
      toastRef.current?.show({
        severity: 'error',
        summary: 'Datei-Löschen fehlgeschlagen',
        detail: error.message,
        life: 5000
      });
    } finally {
      setDeleteEntryTargetBusy(null);
      setDeleteEntryBusy(false);
    }
  };

  const toggleDeleteMoviePathSelection = (moviePath, checked) => {
    const normalizedPath = String(moviePath || '').trim();
    if (!normalizedPath) {
      return;
    }
    setDeleteEntrySelectedMoviePaths((previous) => {
      const nextSet = new Set((Array.isArray(previous) ? previous : []).map((item) => String(item || '').trim()).filter(Boolean));
      if (checked) {
        nextSet.add(normalizedPath);
      } else {
        nextSet.delete(normalizedPath);
      }
      return previewMoviePaths
        .map((item) => String(item?.path || '').trim())
        .filter((itemPath) => itemPath && nextSet.has(itemPath));
    });
  };

  const toggleDeleteRawPathSelection = (rawPath, checked) => {
    const normalizedPath = String(rawPath || '').trim();
    if (!normalizedPath) {
      return;
    }
    setDeleteEntrySelectedRawPaths((previous) => {
      const nextSet = new Set((Array.isArray(previous) ? previous : []).map((item) => String(item || '').trim()).filter(Boolean));
      if (checked) {
        nextSet.add(normalizedPath);
      } else {
        nextSet.delete(normalizedPath);
      }
      return previewRawPaths
        .map((item) => String(item?.path || '').trim())
        .filter((itemPath) => itemPath && nextSet.has(itemPath));
    });
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

  const handleCancelJob = async (row) => {
    const jobId = normalizeJobId(row?.id || row);
    if (!jobId) {
      return;
    }

    const runningStates = new Set(['ANALYZING', 'RIPPING', 'MEDIAINFO_CHECK', 'ENCODING', 'CD_ANALYZING', 'CD_RIPPING', 'CD_ENCODING']);
    const initialStatus = String(row?.status || row?.last_state || '').trim().toUpperCase();
    const fetchLatestJob = async () => {
      try {
        const response = await api.getJob(jobId, { includeLogs: false, forceRefresh: true });
        return response?.job && typeof response.job === 'object' ? response.job : null;
      } catch (_error) {
        return null;
      }
    };

    setActionBusy(true);
    try {
      const response = await api.cancelPipeline(jobId);
      const result = response?.result && typeof response.result === 'object' ? response.result : {};

      // Persisted job status can lag behind the cancel request for a short moment.
      // Poll briefly so the history/detail view reflects cancellation without full page reload.
      let latestJob = await fetchLatestJob();
      if (runningStates.has(initialStatus)) {
        const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        for (let attempt = 0; attempt < 8; attempt += 1) {
          const latestStatus = String(latestJob?.status || latestJob?.last_state || '').trim().toUpperCase();
          if (latestStatus && !runningStates.has(latestStatus)) {
            break;
          }
          await wait(250);
          latestJob = await fetchLatestJob();
        }
      }

      await load();
      if (detailVisible && Number(selectedJob?.id || 0) === Number(jobId) && latestJob) {
        setSelectedJob(latestJob);
      } else {
        await refreshDetailIfOpen(jobId);
      }

      toastRef.current?.show({
        severity: 'success',
        summary: result?.queuedOnly ? 'Aus Queue entfernt' : 'Job abgebrochen',
        detail: result?.queuedOnly
          ? `Job #${jobId} wurde aus der Warteschlange entfernt.`
          : `Job #${jobId} wurde abgebrochen.`,
        life: 3500
      });
    } catch (error) {
      toastRef.current?.show({
        severity: 'error',
        summary: 'Abbruch fehlgeschlagen',
        detail: error.message,
        life: 4500
      });
    } finally {
      setActionBusy(false);
    }
  };

  const handleRestoreMultipartMerge = async (row) => {
    const containerJobId = normalizeJobId(row?.id || row);
    if (!containerJobId) {
      return;
    }
    setActionBusy(true);
    try {
      const response = await api.restoreMultipartMergeJob(containerJobId);
      const mergeJobId = normalizeJobId(response?.job?.id || response?.result?.mergeJobId);
      toastRef.current?.show({
        severity: 'success',
        summary: 'Merge-Job wiederhergestellt',
        detail: mergeJobId
          ? `Merge-Job #${mergeJobId} wurde neu erstellt.`
          : 'Merge-Job wurde neu erstellt.',
        life: 4200
      });
      void load();
      void refreshDetailIfOpen(containerJobId);
    } catch (error) {
      toastRef.current?.show({
        severity: 'error',
        summary: 'Merge-Wiederherstellung fehlgeschlagen',
        detail: error.message,
        life: 5500
      });
    } finally {
      setActionBusy(false);
    }
  };

  const renderStatusTag = (row) => {
    const normalizedStatus = normalizeStatus(row?.status || row?.last_state);
    const rowId = normalizeJobId(row?.id);
    const isQueued = Boolean(rowId && queuedJobIdSet.has(rowId));
    const renderDefaultStatusTag = () => (
      <div className="history-status-tag-wrap">
        <Tag
          value={getStatusLabel(row?.status || row?.last_state, { queued: isQueued })}
          severity={getStatusSeverity(normalizedStatus, { queued: isQueued })}
        />
      </div>
    );

    if (isMultipartContainerHistoryRow(row)) {
      const mergeSummary = row?.seriesChildSummary?.merge && typeof row.seriesChildSummary.merge === 'object'
        ? row.seriesChildSummary.merge
        : null;
      if (mergeSummary) {
        const mergeState = String(mergeSummary?.state || '').trim().toLowerCase();
        const mergeActive = Boolean(mergeSummary?.active) || mergeState === 'active';
        const hasMergeJob = Boolean(mergeSummary?.hasJob);
        const isCompleted = Boolean(mergeSummary?.completed);
        const filesReady = Boolean(mergeSummary?.ready);
        const mergeVisibleInRipper = hasMergeJob && !isCompleted;
        if (mergeActive) {
          return (
            <div className="history-status-tag-wrap">
              <Tag value="Merging" severity="warning" />
            </div>
          );
        }
        if (MULTIPART_CONTAINER_LIVE_STATUSES.has(normalizedStatus)) {
          return renderDefaultStatusTag();
        }
        if (mergeState === 'done' || isCompleted) {
          return (
            <div className="history-status-tag-wrap">
              <Tag value="Fertig" severity="success" />
            </div>
          );
        }
        if (mergeVisibleInRipper) {
          return (
            <div className="history-status-tag-wrap">
              <Tag value="Merge" severity="info" />
            </div>
          );
        }
        if (!hasMergeJob && filesReady) {
          return (
            <div className="history-status-tag-wrap">
              <Tag value="Merge bereit" severity="info" />
            </div>
          );
        }
        if (!filesReady) {
          return (
            <div className="history-status-tag-wrap">
              <Tag value="Merge" severity="danger" />
              <small className="history-status-tag-subtitle">Dateien nicht vollständig</small>
            </div>
          );
        }
      }
    }
    if (isMultipartMergeHistoryRow(row) && normalizeStatus(row?.status) === 'ENCODING') {
      return (
        <div className="history-status-tag-wrap">
          <Tag value="Merging" severity="warning" />
        </div>
      );
    }
    return renderDefaultStatusTag();
  };

  const renderPoster = (row, className = 'history-dv-poster') => {
    const mediaMeta = resolveMediaTypeMeta(row);
    const isAudioSquare = ['cd', 'audiobook'].includes(mediaMeta.mediaType);
    const audioClass = className === 'history-dv-poster-grid' ? 'history-dv-poster-grid-audio' : 'history-dv-poster-audio';
    const imgClass = isAudioSquare ? audioClass : className;
    const title = row?.title || row?.detected_title || 'Poster';
    if (row?.poster_url && row.poster_url !== 'N/A') {
      return <img src={row.poster_url} alt={title} className={imgClass} loading="lazy" />;
    }
    return <div className="history-dv-poster-fallback">{isAudioSquare ? 'Kein Cover' : 'Kein Poster'}</div>;
  };

  const renderPresenceChip = (label, available, tone = null, suffix = '') => {
    const resolvedTone = tone || (available ? 'tone-ok' : 'tone-no');
    const iconClass = available ? 'pi-check-circle' : 'pi-times-circle';
    return (
      <span className={`history-dv-chip ${resolvedTone}`}>
        <i className={`pi ${iconClass}`} aria-hidden="true" />
        <span>{label}: {available ? 'Ja' : 'Nein'}{suffix}</span>
      </span>
    );
  };

  const renderStateChip = (label, valueLabel, tone = 'tone-warn', iconClass = 'pi-spinner pi-spin') => (
    <span className={`history-dv-chip ${tone}`}>
      <i className={`pi ${iconClass}`} aria-hidden="true" />
      <span>{label}: {valueLabel}</span>
    </span>
  );

  const renderSeriesOutputChip = (row) => {
    const summary = row?.seriesOutputSummary || null;
    const label = isMultipartContainerHistoryRow(row) ? 'Movie' : 'Episoden';
    if (!summary) {
      return renderPresenceChip(label, Boolean(row?.outputStatus?.exists));
    }
    const expected = Number(summary.expected || 0);
    const existing = Number(summary.existing || 0);
    const hasExpected = Number.isFinite(expected) && expected > 0;
    const safeExpected = hasExpected ? expected : 0;
    const safeExisting = Number.isFinite(existing) && existing >= 0 ? existing : 0;
    const suffix = hasExpected ? ` (${safeExisting}/${safeExpected})` : '';
    if (safeExisting <= 0) {
      return renderPresenceChip(label, false, 'tone-no', suffix || ' (0/0)');
    }
    if (hasExpected && safeExisting < safeExpected) {
      return renderPresenceChip(label, true, 'tone-warn', suffix);
    }
    return renderPresenceChip(label, true, 'tone-ok', suffix || ` (${safeExisting}/${safeExpected || safeExisting})`);
  };

  const renderSeriesRawChip = (row) => {
    const summary = row?.seriesChildSummary?.raw || null;
    if (!summary) {
      return renderPresenceChip('RAW', Boolean(row?.rawStatus?.exists));
    }
    const expected = Number(summary.expected || 0);
    const existing = Number(summary.existing || 0);
    const hasExpected = Number.isFinite(expected) && expected > 0;
    const safeExpected = hasExpected ? expected : 0;
    const safeExisting = Number.isFinite(existing) && existing >= 0 ? existing : 0;
    const suffix = hasExpected ? ` (${safeExisting}/${safeExpected})` : '';
    if (safeExisting <= 0) {
      return renderPresenceChip('RAW', false, 'tone-no', suffix || ' (0/0)');
    }
    if (hasExpected && safeExisting < safeExpected) {
      return renderPresenceChip('RAW', true, 'tone-warn', suffix);
    }
    return renderPresenceChip('RAW', true, 'tone-ok', suffix || ` (${safeExisting}/${safeExpected || safeExisting})`);
  };

  const renderMultipartMergeChip = (row) => {
    if (!isMultipartHistoryRow(row)) {
      return null;
    }
    const mergeSummary = row?.seriesChildSummary?.merge && typeof row.seriesChildSummary.merge === 'object'
      ? row.seriesChildSummary.merge
      : null;
    const mergeState = String(mergeSummary?.state || '').trim().toLowerCase();
    const isMultipartContainer = isMultipartContainerHistoryRow(row);
    const rowStatus = String(row?.status || row?.last_state || '').trim().toUpperCase();
    const mergeRunning = mergeState === 'active' || rowStatus === 'ENCODING';
    if (mergeRunning) {
      return renderStateChip('Merge', 'Läuft', 'tone-warn', 'pi-spinner pi-spin');
    }
    const isCompleted = Boolean(
      isMultipartContainer
        ? (mergeSummary?.completed || mergeSummary?.outputExists || mergeState === 'done')
        : (
          mergeSummary?.completed
          || mergeSummary?.outputExists
          || row?.outputStatus?.exists
          || rowStatus === 'FINISHED'
        )
    );
    if (isCompleted) {
      return renderPresenceChip('Merge', true, 'tone-ok');
    }
    return renderPresenceChip('Merge', false, 'tone-no');
  };

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
        const narratorShort = audiobookDetails.narrator.length > 48
          ? `${audiobookDetails.narrator.slice(0, 48).trimEnd()}…`
          : audiobookDetails.narrator;
        infoItems.push({ key: 'narrator', label: 'Sprecher', value: narratorShort });
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
    const outputIsAudio = hasAudioOutput(row);
    const cdDetails = isCdJob ? resolveCdDetails(row) : null;
    const selectedMetadata = row?.makemkvInfo?.selectedMetadata && typeof row.makemkvInfo.selectedMetadata === 'object'
      ? row.makemkvInfo.selectedMetadata
      : {};
    const rowMediaType = resolveMediaType(row);
    const isSeriesDvd = (rowMediaType === 'dvd' || rowMediaType === 'bluray') && isSeriesVideoJob(row);
    const isContainerRow = isContainerHistoryRow(row);
    const useContainerSummaryChips = isSeriesDvd || isContainerRow;
    const seasonLabel = isSeriesDvd && selectedMetadata?.seasonNumber
      ? `Staffel ${selectedMetadata.seasonNumber}`
      : null;
    const tmdbLabel = isSeriesDvd && selectedMetadata?.tmdbId
      ? `TMDb ${selectedMetadata.tmdbId}`
      : null;
    const multipartLabel = isMultipartHistoryRow(row)
      ? (isMultipartMergeHistoryRow(row) ? 'Merge' : 'Multipart')
      : null;
    const subtitle = isCdJob
      ? [
        `#${row?.id || '-'}`,
        cdDetails?.artist || '-',
        row?.year || null,
        cdDetails?.mbId ? 'MusicBrainz' : null
      ].filter(Boolean).join(' | ')
      : [
        `#${row?.id || '-'}`,
        row?.year || '-',
        isSeriesDvd ? seasonLabel : (row?.imdb_id || '-'),
        tmdbLabel,
        multipartLabel
      ].filter(Boolean).join(' | ');

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
                <strong className="history-dv-title">
                  {isMultipartHistoryRow(row) ? (
                    <img
                      src={mergeIndicatorIcon}
                      alt="Multipart"
                      title="Multipart"
                      className="media-indicator-icon"
                    />
                  ) : null}
                  <span>{row?.title || row?.detected_title || '-'}</span>
                </strong>
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
              {useContainerSummaryChips
                ? renderSeriesRawChip(row)
                : renderPresenceChip('RAW', Boolean(row?.rawStatus?.exists))}
              {useContainerSummaryChips
                ? renderSeriesOutputChip(row)
                : renderPresenceChip(outputIsAudio ? 'Audio' : 'Movie', Boolean(row?.outputStatus?.exists))}
              {renderPresenceChip('Encode', Boolean(row?.encodeSuccess))}
              {renderMultipartMergeChip(row)}
            </div>

            <div className="history-dv-ratings-row">{renderSupplementalInfo(row)}</div>
          </div>


        </div>
      </div>
    );
  };

  const gridItem = (row) => {
    const mediaMeta = resolveMediaTypeMeta(row);
    const isCdJob = mediaMeta.mediaType === 'cd';
    const outputIsAudio = hasAudioOutput(row);
    const cdDetails = isCdJob ? resolveCdDetails(row) : null;
    const selectedMetadata = row?.makemkvInfo?.selectedMetadata && typeof row.makemkvInfo.selectedMetadata === 'object'
      ? row.makemkvInfo.selectedMetadata
      : {};
    const rowMediaType = resolveMediaType(row);
    const isSeriesDvd = (rowMediaType === 'dvd' || rowMediaType === 'bluray') && isSeriesVideoJob(row);
    const isContainerRow = isContainerHistoryRow(row);
    const useContainerSummaryChips = isSeriesDvd || isContainerRow;
    const seasonLabel = isSeriesDvd && selectedMetadata?.seasonNumber
      ? `Staffel ${selectedMetadata.seasonNumber}`
      : null;
    const tmdbLabel = isSeriesDvd && selectedMetadata?.tmdbId
      ? `TMDb ${selectedMetadata.tmdbId}`
      : null;
    const multipartLabel = isMultipartHistoryRow(row)
      ? (isMultipartMergeHistoryRow(row) ? 'Merge' : 'Multipart')
      : null;
    const subtitle = isCdJob
      ? [
        `#${row?.id || '-'}`,
        cdDetails?.artist || '-',
        row?.year || null,
        cdDetails?.mbId ? 'MusicBrainz' : null
      ].filter(Boolean).join(' | ')
      : [
        `#${row?.id || '-'}`,
        row?.year || '-',
        isSeriesDvd ? seasonLabel : (row?.imdb_id || '-'),
        tmdbLabel,
        multipartLabel
      ].filter(Boolean).join(' | ');

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
          <div className="history-dv-grid-status-overlay">
            {renderStatusTag(row)}
          </div>

          <div className="history-dv-grid-poster-wrap">
            {renderPoster(row, 'history-dv-poster-grid')}
          </div>

          <div className="history-dv-grid-main">
            <div className="history-dv-head">
              <strong className="history-dv-title">
                {isMultipartHistoryRow(row) ? (
                  <img
                    src={mergeIndicatorIcon}
                    alt="Multipart"
                    title="Multipart"
                    className="media-indicator-icon"
                  />
                ) : null}
                <span>{row?.title || row?.detected_title || '-'}</span>
              </strong>
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
              {useContainerSummaryChips
                ? renderSeriesRawChip(row)
                : renderPresenceChip('RAW', Boolean(row?.rawStatus?.exists))}
              {useContainerSummaryChips
                ? renderSeriesOutputChip(row)
                : renderPresenceChip(outputIsAudio ? 'Audio' : 'Movie', Boolean(row?.outputStatus?.exists))}
              {renderPresenceChip('Encode', Boolean(row?.encodeSuccess))}
              {renderMultipartMergeChip(row)}
            </div>

            <div className="history-dv-ratings-row">{renderSupplementalInfo(row)}</div>
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
  const deleteEntryIsMergeJob = isMultipartMergeHistoryRow(deleteEntryDialogRow);
  const deleteEntrySupportsFilesOnly = isContainerHistoryRow(deleteEntryDialogRow);
  const previewRawExisting = previewRawPaths.filter((item) => Boolean(item?.exists));
  const previewMovieExisting = previewMoviePaths.filter((item) => Boolean(item?.exists));
  const rawDeleteSelectionEnabled = !deleteEntryIsMergeJob && previewRawExisting.length > 0;
  const previewRawDisplay = previewRawPaths;
  const previewMovieDisplay = previewMoviePaths;
  const selectedDeleteRawPathSet = useMemo(
    () => new Set(deleteEntrySelectedRawPaths.map((item) => String(item || '').trim()).filter(Boolean)),
    [deleteEntrySelectedRawPaths]
  );
  const selectedDeleteMoviePathSet = useMemo(
    () => new Set(deleteEntrySelectedMoviePaths.map((item) => String(item || '').trim()).filter(Boolean)),
    [deleteEntrySelectedMoviePaths]
  );
  const rawDeleteSelectionRequired = !deleteEntryIsMergeJob
    && rawDeleteSelectionEnabled
    && deleteEntrySelectedRawPaths.length === 0;
  const movieDeleteSelectionRequired = previewMovieExisting.length > 0 && deleteEntrySelectedMoviePaths.length === 0;
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
        <DataViewLayoutOptions layout={layout} onChange={(event) => {
          setLayout(event.value);
          api.setPref('history_layout', event.value).catch(() => {});
        }} />
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
        onRestartEncode={resolveMediaType(selectedJob) === 'converter' ? null : handleRestartEncode}
        onRestartReview={resolveMediaType(selectedJob) === 'converter' ? null : handleRestartReview}
        onRestartCdReview={resolveMediaType(selectedJob) === 'converter' ? null : handleRestartCdReview}
        onReencode={resolveMediaType(selectedJob) === 'converter' ? null : handleReencode}
        onRetry={resolveMediaType(selectedJob) === 'converter' ? null : handleRetry}
        onAssignMetadata={handleAssignMetadata}
        onAssignCdMetadata={handleAssignCdMetadata}
        onGenerateNfo={handleGenerateNfo}
        onAcknowledgeError={handleAcknowledgeError}
        onDeleteFiles={handleDeleteFiles}
        onDeleteEntry={handleDeleteEntry}
        onDownloadArchive={handleDownloadArchive}
        onDownloadOutputFolder={handleDownloadOutputFolder}
        onRemoveFromQueue={handleRemoveFromQueue}
        onCancel={handleCancelJob}
        onRestoreMultipartMerge={handleRestoreMultipartMerge}
        isQueued={Boolean(selectedJob?.id && queuedJobIdSet.has(normalizeJobId(selectedJob.id)))}
        actionBusy={actionBusy}
        cancelBusy={actionBusy}
        restoreMergeBusy={actionBusy}
        metadataAssignBusy={metadataAssignBusy}
        cdMetadataAssignBusy={cdMetadataAssignBusy}
        generateNfoBusy={generateNfoBusy}
        acknowledgeErrorBusy={acknowledgeErrorBusy}
        reencodeBusy={reencodeBusyJobId === selectedJob?.id}
        deleteEntryBusy={deleteEntryBusy}
        downloadBusyTarget={downloadBusyTarget}
        downloadFolderBusyPath={downloadFolderBusyPath}
        onHide={() => {
          setDetailVisible(false);
          setDetailLoading(false);
          setLogLoadingMode(null);
          setDownloadBusyTarget(null);
          setDownloadFolderBusyPath(null);
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
          {`Es sind ${previewRelatedJobs.length || 1} Historien-Eintrag/Einträge im Lösch-Scope enthalten.`}
        </p>
        <small className="history-dv-subtle">
          {deleteEntryIsMergeJob
            ? 'Hinweis: Die Aktion "Eintrag + Merge" löscht den Historien-Eintrag plus ausgewählte Merge-Datei(en).'
            : 'Hinweis: In diesem Dialog löschen alle ersten drei Buttons immer den Historien-Eintrag plus ausgewählte Dateien.'}
        </small>

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
                      <span>
                        <strong>#{item.id}</strong>
                        {' '}| {item.title || '-'}
                        {' '}| {item.roleLabel || 'Job'}
                        {' '}| {getStatusLabel(item.status)}
                        {' '}{item.isPrimary ? '(aktuell)' : '(verknüpft)'}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <small className="history-dv-subtle">Keine verknüpften Alt-Einträge erkannt.</small>
              )}
            </div>

            {!deleteEntryIsMergeJob ? (
              <div>
                <h4>RAW</h4>
                {previewRawPaths.length > 0 ? (() => {
                  return (
                    <ul className="history-delete-preview-list">
                      {previewRawDisplay.map((item) => (
                        <li key={`delete-raw-${item.path}`}>
                          {rawDeleteSelectionEnabled && item.exists ? (
                            <label className="history-delete-preview-checkbox-row">
                              <input
                                type="checkbox"
                                checked={selectedDeleteRawPathSet.has(String(item.path || '').trim())}
                                onChange={(event) => toggleDeleteRawPathSelection(item.path, Boolean(event.target.checked))}
                              />
                              <span className={item.exists ? 'exists-yes' : 'exists-no'}>
                                {item.exists ? 'vorhanden' : 'nicht gefunden'}
                              </span>
                              <span>| {item.path}</span>
                            </label>
                          ) : (
                            <>
                              <span className={item.exists ? 'exists-yes' : 'exists-no'}>
                                {item.exists ? 'vorhanden' : 'nicht gefunden'}
                              </span>
                              {' '}| {item.path}
                            </>
                          )}
                        </li>
                      ))}
                    </ul>
                  );
                })() : (
                  <small className="history-dv-subtle">Keine RAW-Pfade.</small>
                )}
                {rawDeleteSelectionEnabled ? (
                  <small className="history-dv-subtle">
                    RAW-Auswahl aktiv: {deleteEntrySelectedRawPaths.length}/{previewRawExisting.length} ausgewählt.
                  </small>
                ) : null}
              </div>
            ) : null}

            <div>
              <h4>{deleteEntryOutputShortLabel} (Dateien)</h4>
              {previewMoviePaths.length > 0 ? (() => {
                return (
                  <ul className="history-delete-preview-list">
                    {previewMovieDisplay.map((item) => (
                      <li key={`delete-movie-${item.path}`}>
                        {item.exists ? (
                          <label className="history-delete-preview-checkbox-row">
                            <input
                              type="checkbox"
                              checked={selectedDeleteMoviePathSet.has(String(item.path || '').trim())}
                              onChange={(event) => toggleDeleteMoviePathSelection(item.path, Boolean(event.target.checked))}
                            />
                            <span className={item.exists ? 'exists-yes' : 'exists-no'}>
                              {item.exists ? 'vorhanden' : 'nicht gefunden'}
                            </span>
                            <span>| {item.path}</span>
                          </label>
                        ) : (
                          <>
                            <span className={item.exists ? 'exists-yes' : 'exists-no'}>
                              {item.exists ? 'vorhanden' : 'nicht gefunden'}
                            </span>
                            {' '}| {item.path}
                          </>
                        )}
                      </li>
                    ))}
                  </ul>
                );
              })() : (
                <small className="history-dv-subtle">Keine Output-Dateien.</small>
              )}
            </div>
          </div>
        )}

        <div className="dialog-actions">
          {deleteEntryIsMergeJob ? (
            <Button
              label="Eintrag + Merge"
              icon="pi pi-trash"
              severity="warning"
              outlined
              onClick={() => confirmDeleteEntry('movie')}
              loading={deleteEntryTargetBusy === 'movie'}
              disabled={deleteTargetActionsDisabled || movieDeleteSelectionRequired}
            />
          ) : (
            <>
              <Button
                label="Eintrag + nur RAW-Dateien"
                icon="pi pi-trash"
                severity="warning"
                outlined
                onClick={() => confirmDeleteEntry('raw')}
                loading={deleteEntryTargetBusy === 'raw'}
                disabled={deleteTargetActionsDisabled || rawDeleteSelectionRequired}
              />
              <Button
                label={`Eintrag + nur ${deleteEntryOutputShortLabel}`}
                icon="pi pi-trash"
                severity="warning"
                outlined
                onClick={() => confirmDeleteEntry('movie')}
                loading={deleteEntryTargetBusy === 'movie'}
                disabled={deleteTargetActionsDisabled || movieDeleteSelectionRequired}
              />
              <Button
                label={`Eintrag + RAW & ${deleteEntryOutputShortLabel}`}
                icon="pi pi-times"
                severity="danger"
                onClick={() => confirmDeleteEntry('both')}
                loading={deleteEntryTargetBusy === 'both'}
                disabled={deleteTargetActionsDisabled || movieDeleteSelectionRequired || rawDeleteSelectionRequired}
              />
            </>
          )}
          {deleteEntrySupportsFilesOnly ? (
            <Button
              label="Nur ausgewählte Dateien löschen"
              icon="pi pi-folder-minus"
              severity="help"
              outlined
              onClick={() => confirmDeleteFilesOnly('both')}
              loading={deleteEntryTargetBusy === 'files-both'}
              disabled={deleteTargetActionsDisabled || movieDeleteSelectionRequired || rawDeleteSelectionRequired}
            />
          ) : null}
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

      <MetadataSelectionDialog
        visible={metadataDialogVisible}
        context={metadataDialogContext || {}}
        onHide={() => {
          setMetadataDialogVisible(false);
          setMetadataDialogContext(null);
        }}
        onSubmit={handleMetadataSubmit}
        onSearch={handleMetadataSearch}
        busy={metadataAssignBusy}
      />

      <CdMetadataDialog
        visible={cdMetadataDialogVisible}
        context={cdMetadataDialogContext || {}}
        onHide={() => {
          setCdMetadataDialogVisible(false);
          setCdMetadataDialogContext(null);
        }}
        onSubmit={handleCdMetadataSubmit}
        onSearch={handleMusicBrainzSearch}
        onFetchRelease={handleMusicBrainzReleaseFetch}
        busy={cdMetadataAssignBusy}
      />

      <ReencodeConflictModal
        visible={conflictModalVisible}
        onHide={closeConflictModal}
        job={conflictModalJob}
        existingFolders={conflictModalFolders}
        mode={conflictModalMode}
        onKeepBoth={handleConflictKeepBoth}
        onDeleteSelected={handleConflictDeleteSelected}
        busy={conflictModalBusy}
      />
    </div>
  );
}
