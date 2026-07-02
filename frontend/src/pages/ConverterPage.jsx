import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from 'primereact/button';
import { Card } from 'primereact/card';
import { Toast } from 'primereact/toast';
import { Badge } from 'primereact/badge';
import { Tag } from 'primereact/tag';
import { ProgressBar } from 'primereact/progressbar';
import { Divider } from 'primereact/divider';
import { Dialog } from 'primereact/dialog';
import { Dropdown } from 'primereact/dropdown';
import { RadioButton } from 'primereact/radiobutton';
import { api } from '../api/client';
import { useWebSocket } from '../hooks/useWebSocket';
import ConverterFileExplorer from '../components/ConverterFileExplorer';
import ConverterUploadPanel from '../components/ConverterUploadPanel';
import ConverterJobCard from '../components/ConverterJobCard';
import JobDetailDialog from '../components/JobDetailDialog';
import PipelineStatusCard from '../components/PipelineStatusCard';
import MetadataSelectionDialog from '../components/MetadataSelectionDialog';
import otherIndicatorIcon from '../assets/media-other.svg';
import { getStatusLabel, getStatusSeverity, normalizeStatus } from '../utils/statusPresentation';
import { confirmModal } from '../utils/confirmModal';

const AUDIO_EXTS = new Set(['.flac', '.mp3', '.wav', '.m4a', '.ogg', '.opus']);
const VIDEO_EXTS = new Set(['.mkv', '.mp4', '.m2ts', '.iso', '.avi', '.mov']);
const TERMINAL_JOB_STATUSES = new Set(['DONE', 'FINISHED', 'ERROR', 'CANCELLED']);
const DEFAULT_CONVERTER_SCAN_EXTENSIONS = [
  'mkv', 'mp4', 'm2ts', 'iso', 'avi', 'mov',
  'flac', 'mp3', 'wav', 'm4a', 'ogg', 'opus'
];
const VIDEO_OUTPUT_FORMATS = [
  { label: 'MKV', value: 'mkv' },
  { label: 'MP4', value: 'mp4' },
  { label: 'M4V', value: 'm4v' }
];

function parseConverterScanExtensions(value) {
  const seen = new Set();
  const parsed = String(value || '')
    .split(',')
    .map((item) => String(item || '').trim().toLowerCase())
    .filter((item) => {
      if (!item || !DEFAULT_CONVERTER_SCAN_EXTENSIONS.includes(item) || seen.has(item)) {
        return false;
      }
      seen.add(item);
      return true;
    });
  if (parsed.length === 0) {
    return [...DEFAULT_CONVERTER_SCAN_EXTENSIONS];
  }
  return parsed;
}

function isAudioEntry(e) {
  if (e.detectedMediaType === 'audio') return true;
  const p = (e.relPath || '').toLowerCase();
  const dot = p.lastIndexOf('.');
  if (dot === -1) return false;
  return AUDIO_EXTS.has(p.slice(dot));
}

function isVideoEntry(e) {
  if (e.detectedMediaType === 'video' || e.detectedMediaType === 'iso') return true;
  const p = (e.relPath || '').toLowerCase();
  const dot = p.lastIndexOf('.');
  if (dot === -1) return false;
  return VIDEO_EXTS.has(p.slice(dot));
}

function normalizeJobId(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : null;
}

function parseConverterPlan(job) {
  try {
    return JSON.parse(job?.encode_plan_json || '{}');
  } catch (_err) {
    return {};
  }
}

function buildConverterPipeline(job, plan, progress = null) {
  const metadata = plan?.metadata && typeof plan.metadata === 'object' ? plan.metadata : {};
  const review = plan && typeof plan === 'object' ? plan : {};
  const selectedMetadata = {
    title: String(job?.title || metadata?.title || job?.detected_title || '').trim() || null,
    year: Number.isFinite(Number(job?.year)) ? Math.trunc(Number(job.year)) : (Number.isFinite(Number(metadata?.year)) ? Math.trunc(Number(metadata.year)) : null),
    imdbId: String(job?.imdb_id || metadata?.imdbId || '').trim() || null,
    poster: String(job?.poster_url || metadata?.poster || '').trim() || null
  };
  return {
    state: String(progress?.state || job?.status || '').trim().toUpperCase() || 'UNKNOWN',
    activeJobId: Number(job?.id) || null,
    progress: Number.isFinite(Number(progress?.progress)) ? Number(progress.progress) : 0,
    eta: progress?.eta || null,
    statusText: progress?.statusText || null,
    context: {
      jobId: Number(job?.id) || null,
      mode: 'converter',
      mediaProfile: 'converter',
      selectedMetadata,
      mediaInfoReview: review,
      playlistAnalysis: review?.playlistAnalysis || null,
      playlistCandidates: Array.isArray(review?.playlistCandidates) ? review.playlistCandidates : [],
      handBrakeTitleDecisionRequired: Boolean(review?.handBrakeTitleDecisionRequired),
      handBrakeTitleCandidates: Array.isArray(review?.handBrakeTitleCandidates) ? review.handBrakeTitleCandidates : []
    }
  };
}

export default function ConverterPage() {
  const toastRef = useRef(null);
  const [jobs, setJobs] = useState([]);
  const [queuedJobIds, setQueuedJobIds] = useState([]);
  const [jobProgress, setJobProgress] = useState({});
  const [loadingJobs, setLoadingJobs] = useState(false);
  const [explorerRefreshToken, setExplorerRefreshToken] = useState(0);
  const [explorerNavigateTo, setExplorerNavigateTo] = useState(null);
  const [selectedEntries, setSelectedEntries] = useState([]);
  const [selectionResetToken, setSelectionResetToken] = useState(0);
  const [jobModeVisible, setJobModeVisible] = useState(false);
  const [audioMode, setAudioMode] = useState('individual');
  const [jobModalAction, setJobModalAction] = useState('create');
  const [assignTargetJobId, setAssignTargetJobId] = useState(null);
  const [creatingJobs, setCreatingJobs] = useState(false);
  const [jobEntries, setJobEntries] = useState([]);
  const [detailVisible, setDetailVisible] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [selectedJob, setSelectedJob] = useState(null);
  const [metadataDialogVisible, setMetadataDialogVisible] = useState(false);
  const [metadataDialogContext, setMetadataDialogContext] = useState(null);
  const [metadataDialogBusy, setMetadataDialogBusy] = useState(false);
  const [actionBusyJobIds, setActionBusyJobIds] = useState(new Set());
  const [logLoadingMode, setLogLoadingMode] = useState(null);
  const [deleteEntryBusy, setDeleteEntryBusy] = useState(false);
  const [cancelDetailBusy, setCancelDetailBusy] = useState(false);
  const [expandedJobId, setExpandedJobId] = useState(undefined);
  const [videoUserPresets, setVideoUserPresets] = useState([]);
  const [videoHbPresets, setVideoHbPresets] = useState([]);
  const [uploadExtensions, setUploadExtensions] = useState(() => [...DEFAULT_CONVERTER_SCAN_EXTENSIONS]);
  // Entries werden beim Öffnen des Modals gesichert, damit ein außerhalb-Click
  // die Selection nicht löscht bevor die Jobs erstellt werden
  const jobEntriesRef = useRef([]);
  const previousJobStatusesRef = useRef(new Map());

  const loadUploadExtensions = useCallback(async () => {
    try {
      const response = await api.getSettings({ forceRefresh: true });
      const allSettings = (response?.categories || []).flatMap((category) => category?.settings || []);
      const setting = allSettings.find((item) => String(item?.key || '').trim() === 'converter_scan_extensions');
      const value = setting?.value ?? setting?.default_value ?? '';
      setUploadExtensions(parseConverterScanExtensions(value));
    } catch (_error) {
      setUploadExtensions([...DEFAULT_CONVERTER_SCAN_EXTENSIONS]);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    const loadPresets = async () => {
      try {
        const [userResponse, hbResponse] = await Promise.allSettled([
          api.getUserPresets('video'),
          api.getHandBrakePresets()
        ]);
        if (cancelled) return;
        const userPresets = userResponse.status === 'fulfilled'
          ? (Array.isArray(userResponse.value?.presets) ? userResponse.value.presets : [])
          : [];
        const hbPresets = hbResponse.status === 'fulfilled'
          ? (Array.isArray(hbResponse.value?.presets) ? hbResponse.value.presets : [])
          : [];
        setVideoUserPresets(userPresets);
        setVideoHbPresets(hbPresets);
      } catch (_error) {
        if (!cancelled) {
          setVideoUserPresets([]);
          setVideoHbPresets([]);
        }
      }
    };
    loadPresets();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    void loadUploadExtensions();
  }, [loadUploadExtensions]);

  const loadJobs = useCallback(async () => {
    setLoadingJobs(true);
    try {
      const [jobsResponse, queueResponse] = await Promise.allSettled([
        api.getConverterJobs(),
        api.getPipelineQueue()
      ]);
      const nextJobs = jobsResponse.status === 'fulfilled' && Array.isArray(jobsResponse.value?.jobs)
        ? jobsResponse.value.jobs
        : [];
      if (queueResponse.status === 'fulfilled') {
        const queuedRows = Array.isArray(queueResponse.value?.queue?.queuedJobs)
          ? queueResponse.value.queue.queuedJobs
          : [];
        setQueuedJobIds(
          queuedRows
            .map((item) => normalizeJobId(item?.jobId))
            .filter(Boolean)
        );
      } else {
        setQueuedJobIds([]);
      }
      setJobs(nextJobs);
      const runningStates = new Set(['ANALYZING', 'RIPPING', 'ENCODING', 'MEDIAINFO_CHECK']);
      setJobProgress((prev) => {
        const next = { ...prev };
        for (const job of nextJobs) {
          const jobId = normalizeJobId(job?.id);
          if (!jobId) continue;
          const status = String(job?.status || '').trim().toUpperCase();
          if (!runningStates.has(status) && next[jobId]) {
            delete next[jobId];
          }
        }
        return next;
      });

      const previousStatuses = previousJobStatusesRef.current;
      const nextStatuses = new Map();
      let hasStatusChanges = false;
      let hasCompletedJobTransitions = false;

      for (const job of nextJobs) {
        const jobId = normalizeJobId(job?.id);
        if (!jobId) continue;
        const nextStatus = String(job?.status || '').trim().toUpperCase();
        const prevStatus = previousStatuses.get(jobId) || null;
        nextStatuses.set(jobId, nextStatus);
        if (prevStatus !== nextStatus) {
          hasStatusChanges = true;
          if (prevStatus && !TERMINAL_JOB_STATUSES.has(prevStatus) && TERMINAL_JOB_STATUSES.has(nextStatus)) {
            hasCompletedJobTransitions = true;
          }
        }
      }

      if (previousStatuses.size !== nextStatuses.size) {
        hasStatusChanges = true;
      }

      const isFirstSnapshot = previousStatuses.size === 0;
      previousJobStatusesRef.current = nextStatuses;

      if (!isFirstSnapshot && hasStatusChanges) {
        setExplorerRefreshToken((t) => t + 1);
      }
      if (!isFirstSnapshot && hasCompletedJobTransitions) {
        setSelectedEntries([]);
        setSelectionResetToken((t) => t + 1);
      }
    } catch (err) {
      console.error('Load converter jobs error:', err);
    } finally {
      setLoadingJobs(false);
    }
  }, []);

  useEffect(() => {
    loadJobs();
    const interval = setInterval(loadJobs, 5000);
    return () => clearInterval(interval);
  }, [loadJobs]);

  useWebSocket({
    onMessage: (message) => {
      if (!message?.type) return;

      if (message.type === 'PIPELINE_PROGRESS') {
        const payload = message.payload;
        const jobId = normalizeJobId(payload?.activeJobId);
        if (jobId) {
          setJobProgress((prev) => ({
            ...prev,
            [jobId]: {
              progress: payload?.progress ?? null,
              eta: payload?.eta ?? null,
              statusText: payload?.statusText ?? null,
              state: payload?.state ?? null
            }
          }));
        }
      }

      if (
        message.type === 'PIPELINE_UPDATE' ||
        message.type === 'PIPELINE_STATE_CHANGED' ||
        message.type === 'PIPELINE_QUEUE_CHANGED' ||
        message.type === 'CONVERTER_SCAN_UPDATE'
      ) {
        loadJobs();
        if (message.type === 'CONVERTER_SCAN_UPDATE' || message.type === 'PIPELINE_STATE_CHANGED') {
          setExplorerRefreshToken((t) => t + 1);
        }
      }

      if (message.type === 'SETTINGS_UPDATED') {
        if (String(message?.payload?.key || '').trim() === 'converter_scan_extensions') {
          void loadUploadExtensions();
        }
      }

      if (message.type === 'SETTINGS_BULK_UPDATED') {
        const keys = Array.isArray(message?.payload?.keys) ? message.payload.keys : [];
        if (keys.includes('converter_scan_extensions')) {
          void loadUploadExtensions();
        }
      }
    }
  });

  const queuedJobIdSet = useMemo(() => {
    const next = new Set();
    for (const value of queuedJobIds) {
      const jobId = normalizeJobId(value);
      if (jobId) {
        next.add(jobId);
      }
    }
    return next;
  }, [queuedJobIds]);

  const assignableJobs = useMemo(() => (
    jobs
      .map((job) => ({ job, plan: parseConverterPlan(job) }))
      .filter(({ job, plan }) => {
        const status = String(job?.status || '').trim().toUpperCase();
        const mediaType = String(plan?.converterMediaType || '').trim().toLowerCase();
        return status === 'READY_TO_START' && mediaType === 'audio' && !Boolean(plan?.isFolder);
      })
      .map(({ job, plan }) => {
        const rawTitle = String(job?.title || '').trim();
        const title = rawTitle ? `#${job.id} | ${rawTitle}` : `#${job.id}`;
        const fileCount = Array.isArray(plan?.inputPaths) && plan.inputPaths.length > 0
          ? plan.inputPaths.length
          : (plan?.inputPath ? 1 : 0);
        return {
          label: `${title}${fileCount > 0 ? ` (${fileCount} Datei${fileCount !== 1 ? 'en' : ''})` : ''}`,
          value: job.id
        };
      })
  ), [jobs]);

  const handleSelectionChange = (entries) => setSelectedEntries(entries || []);

  const handleOpenJobModal = () => {
    // Explorer expandiert Ordner bereits zu Einzel-Dateien
    const entries = [...selectedEntries];
    jobEntriesRef.current = entries;
    setJobEntries(entries);

    const hasAudio = entries.some(isAudioEntry);
    const hasAssignableJobs = assignableJobs.length > 0;
    if (!hasAudio && !hasAssignableJobs) {
      // Nur Videos oder sonstige Dateien → direkt individual erstellen
      handleCreateJobsFromSelection('individual');
      return;
    }

    setAudioMode('individual');
    setJobModalAction('create');
    setAssignTargetJobId(assignableJobs[0]?.value || null);
    setJobModeVisible(true);
  };

  const handleCreateJobsFromSelection = async (explicitAudioMode) => {
    const entries = jobEntriesRef.current;
    if (entries.length === 0) return;
    const resolvedAudioMode = typeof explicitAudioMode === 'string' ? explicitAudioMode : audioMode;
    setCreatingJobs(true);
    setJobModeVisible(false);
    try {
      const relPaths = entries.map((e) => e.relPath).filter(Boolean);
      const result = await api.converterCreateJobsFromSelection(relPaths, resolvedAudioMode);
      const newJobs = result?.jobs || [];
      toastRef.current?.show({
        severity: 'success',
        summary: 'Jobs erstellt',
        detail: `${newJobs.length} Converter-Job${newJobs.length !== 1 ? 's' : ''} erstellt.`,
        life: 3500
      });
      jobEntriesRef.current = [];
      setJobEntries([]);
      setSelectedEntries([]);
      setSelectionResetToken((t) => t + 1);
      setExplorerRefreshToken((t) => t + 1);
      await loadJobs();
    } catch (err) {
      toastRef.current?.show({
        severity: 'error',
        summary: 'Fehler',
        detail: err.message || 'Jobs konnten nicht erstellt werden.',
        life: 4500
      });
    } finally {
      setCreatingJobs(false);
    }
  };

  const handleAssignSelectionToJob = async (targetJobId) => {
    const entries = jobEntriesRef.current;
    if (entries.length === 0) return;
    const normalizedJobId = Number(targetJobId);
    if (!Number.isFinite(normalizedJobId) || normalizedJobId <= 0) return;

    setCreatingJobs(true);
    setJobModeVisible(false);
    try {
      const relPaths = entries.map((e) => e.relPath).filter(Boolean);
      const result = await api.converterAssignFilesToJob(normalizedJobId, relPaths);
      const addedCount = Array.isArray(result?.addedRelPaths) ? result.addedRelPaths.length : 0;
      toastRef.current?.show({
        severity: 'success',
        summary: 'Dateien zugewiesen',
        detail: addedCount > 0
          ? `${addedCount} Datei${addedCount !== 1 ? 'en' : ''} zu Job #${normalizedJobId} hinzugefügt.`
          : `Keine neuen Dateien zu Job #${normalizedJobId} hinzugefügt.`,
        life: 3600
      });
      jobEntriesRef.current = [];
      setJobEntries([]);
      setSelectedEntries([]);
      setSelectionResetToken((t) => t + 1);
      setExplorerRefreshToken((t) => t + 1);
      await loadJobs();
    } catch (err) {
      toastRef.current?.show({
        severity: 'error',
        summary: 'Fehler',
        detail: err.message || 'Dateien konnten dem Job nicht zugewiesen werden.',
        life: 4600
      });
    } finally {
      setCreatingJobs(false);
    }
  };

  const handleJobModeConfirm = async ({ action, audioMode: selectedAudioMode, jobId }) => {
    if (action === 'assign') {
      await handleAssignSelectionToJob(jobId || assignTargetJobId);
      return;
    }
    await handleCreateJobsFromSelection(selectedAudioMode || audioMode);
  };

  const handleUploaded = (folders) => {
    setExplorerRefreshToken((t) => t + 1);
    if (folders?.length > 0) {
      setExplorerNavigateTo({ path: folders[0].folderRelPath, ts: Date.now() });
      toastRef.current?.show({
        severity: 'success',
        summary: 'Upload abgeschlossen',
        detail: `${folders.length} Ordner hochgeladen. Dateien auswählen und Jobs anlegen.`,
        life: 4000
      });
    }
  };

  const runJobAction = useCallback(async (jobId, action) => {
    const normalizedJobId = normalizeJobId(jobId);
    if (!normalizedJobId || typeof action !== 'function') return;
    setActionBusyJobIds((prev) => new Set([...prev, normalizedJobId]));
    try {
      await action(normalizedJobId);
      await loadJobs();
    } catch (error) {
      toastRef.current?.show({
        severity: 'error',
        summary: 'Aktion fehlgeschlagen',
        detail: error?.message || 'Unbekannter Fehler',
        life: 4200
      });
    } finally {
      setActionBusyJobIds((prev) => {
        const next = new Set(prev);
        next.delete(normalizedJobId);
        return next;
      });
    }
  }, [loadJobs]);

  const handleOpenMetadataDialog = async (jobId) => {
    const normalizedJobId = normalizeJobId(jobId);
    if (!normalizedJobId) return;
    const row = jobs.find((entry) => normalizeJobId(entry?.id) === normalizedJobId) || null;
    if (!row) return;
    const plan = parseConverterPlan(row);
    const metadata = plan?.metadata && typeof plan.metadata === 'object' ? plan.metadata : {};
    setMetadataDialogContext({
      jobId: normalizedJobId,
      detectedTitle: row?.detected_title || row?.title || metadata?.title || '',
      selectedMetadata: {
        title: row?.title || metadata?.title || row?.detected_title || '',
        year: row?.year || metadata?.year || null,
        imdbId: row?.imdb_id || metadata?.imdbId || null,
        poster: row?.poster_url || metadata?.poster || null
      },
      metadataCandidates: []
    });
    setMetadataDialogVisible(true);
  };

  const handleMetadataSubmit = async (payload) => {
    setMetadataDialogBusy(true);
    try {
      await api.selectMetadata(payload || {});
      setMetadataDialogVisible(false);
      setMetadataDialogContext(null);
      await loadJobs();
      toastRef.current?.show({
        severity: 'success',
        summary: 'Metadaten übernommen',
        detail: `Job #${payload?.jobId} wurde aktualisiert.`,
        life: 3200
      });
    } catch (error) {
      toastRef.current?.show({
        severity: 'error',
        summary: 'Metadaten fehlgeschlagen',
        detail: error.message || 'Unbekannter Fehler',
        life: 4200
      });
    } finally {
      setMetadataDialogBusy(false);
    }
  };

  const handleMetadataSearch = async (query) => {
    try {
      const response = await api.searchTmdbMovie(query);
      return Array.isArray(response?.results) ? response.results : [];
    } catch (_error) {
      return [];
    }
  };

  const handleStartPipelineJob = async (jobId, options = null) => {
    await runJobAction(jobId, async (resolvedJobId) => {
      const startOptions = options && typeof options === 'object' ? options : {};
      if (startOptions.ensureConfirmed) {
        const confirmPayload = {
          selectedEncodeTitleId: startOptions.selectedEncodeTitleId ?? null,
          selectedTrackSelection: startOptions.selectedTrackSelection ?? null,
          skipPipelineStateUpdate: true
        };
        if (startOptions.selectedPostEncodeScriptIds !== undefined) {
          confirmPayload.selectedPostEncodeScriptIds = startOptions.selectedPostEncodeScriptIds;
        }
        if (startOptions.selectedPreEncodeScriptIds !== undefined) {
          confirmPayload.selectedPreEncodeScriptIds = startOptions.selectedPreEncodeScriptIds;
        }
        if (startOptions.selectedPostEncodeChainIds !== undefined) {
          confirmPayload.selectedPostEncodeChainIds = startOptions.selectedPostEncodeChainIds;
        }
        if (startOptions.selectedPreEncodeChainIds !== undefined) {
          confirmPayload.selectedPreEncodeChainIds = startOptions.selectedPreEncodeChainIds;
        }
        if (startOptions.selectedUserPresetId !== undefined) {
          confirmPayload.selectedUserPresetId = startOptions.selectedUserPresetId;
        }
        if (startOptions.selectedHandBrakePreset !== undefined) {
          confirmPayload.selectedHandBrakePreset = startOptions.selectedHandBrakePreset;
        }
        await api.confirmEncodeReview(resolvedJobId, confirmPayload);
      }

      await api.startJob(resolvedJobId);
      toastRef.current?.show({
        severity: 'success',
        summary: 'Job gestartet',
        detail: `Job #${resolvedJobId} wurde gestartet.`,
        life: 2800
      });
    });
  };

  const handleConfirmReview = async (jobId, payload = {}) => {
    await runJobAction(jobId, async (resolvedJobId) => {
      await api.confirmEncodeReview(resolvedJobId, payload || {});
      toastRef.current?.show({
        severity: 'success',
        summary: 'Review bestätigt',
        detail: `Encode für Job #${resolvedJobId} ist freigegeben.`,
        life: 3000
      });
    });
  };

  const handleSelectPlaylist = async (jobId, selectedPlaylist) => {
    await runJobAction(jobId, async (resolvedJobId) => {
      await api.selectMetadata({ jobId: resolvedJobId, selectedPlaylist });
    });
  };

  const handleSelectHandBrakeTitle = async (jobId, selectedHandBrakeTitleId) => {
    await runJobAction(jobId, async (resolvedJobId) => {
      await api.selectMetadata({ jobId: resolvedJobId, selectedHandBrakeTitleId });
    });
  };

  const handleCancelPipelineJob = async (jobId) => {
    const normalizedJobId = normalizeJobId(jobId);
    if (!normalizedJobId) return;
    const confirmed = await confirmModal({
      header: 'Job abbrechen',
      message: `Job #${normalizedJobId} abbrechen?`,
      acceptLabel: 'Abbrechen',
      rejectLabel: 'Zurück',
      danger: true
    });
    if (!confirmed) return;
    await runJobAction(normalizedJobId, async (resolvedJobId) => {
      await api.cancelPipeline(resolvedJobId);
      handleJobCancelledImmediate(resolvedJobId);
      toastRef.current?.show({
        severity: 'success',
        summary: 'Abbruch gesendet',
        detail: `Job #${resolvedJobId} wird abgebrochen.`,
        life: 2800
      });
    });
  };

  const handleRetryJob = async (jobId) => {
    await runJobAction(jobId, async (resolvedJobId) => {
      await api.retryJob(resolvedJobId);
      toastRef.current?.show({
        severity: 'success',
        summary: 'Retry gestartet',
        detail: `Job #${resolvedJobId} wurde neu eingeplant.`,
        life: 3000
      });
    });
  };

  const handleDeleteConverterJob = async (jobId) => {
    const normalizedJobId = normalizeJobId(jobId);
    if (!normalizedJobId) return;
    const confirmed = await confirmModal({
      header: 'Job löschen',
      message: `Job #${normalizedJobId} wirklich löschen?`,
      acceptLabel: 'Löschen',
      rejectLabel: 'Abbrechen',
      danger: true
    });
    if (!confirmed) return;
    await runJobAction(normalizedJobId, async (resolvedJobId) => {
      await api.deleteConverterJob(resolvedJobId);
      handleJobDeleted(resolvedJobId);
      toastRef.current?.show({
        severity: 'success',
        summary: 'Job gelöscht',
        detail: `Job #${resolvedJobId} wurde entfernt.`,
        life: 3000
      });
    });
  };

  const handleRemoveFromQueue = async (jobId) => {
    await runJobAction(jobId, async (resolvedJobId) => {
      await api.cancelPipeline(resolvedJobId);
      handleJobCancelledImmediate(resolvedJobId);
      toastRef.current?.show({
        severity: 'success',
        summary: 'Aus Queue entfernt',
        detail: `Job #${resolvedJobId} wurde aus der Queue entfernt.`,
        life: 3000
      });
    });
  };

  const handleJobStarted = async (jobId) => {
    await loadJobs();
    toastRef.current?.show({
      severity: 'success',
      summary: 'Gestartet',
      detail: `Converter-Job ${jobId} läuft.`,
      life: 3000
    });
  };

  const handleOpenJobDetails = async (row) => {
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
      toastRef.current?.show({
        severity: 'error',
        summary: 'Details konnten nicht geladen werden',
        detail: error.message || 'Unbekannter Fehler',
        life: 4200
      });
    } finally {
      setDetailLoading(false);
    }
  };

  const handleLoadDetailLog = async (job, mode = 'tail') => {
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
      toastRef.current?.show({
        severity: 'error',
        summary: 'Log konnte nicht geladen werden',
        detail: error.message || 'Unbekannter Fehler',
        life: 4200
      });
    } finally {
      setLogLoadingMode(null);
    }
  };

  const handleDeleteDetailEntry = async (job) => {
    const jobId = Number(job?.id || 0);
    if (!jobId) {
      return;
    }
    const confirmed = await confirmModal({
      header: 'Historieneintrag löschen',
      message: `Historieneintrag Job #${jobId} löschen?`,
      acceptLabel: 'Löschen',
      rejectLabel: 'Abbrechen',
      danger: true
    });
    if (!confirmed) {
      return;
    }
    setDeleteEntryBusy(true);
    try {
      await api.deleteConverterJob(jobId);
      handleJobDeleted(jobId);
      setDetailVisible(false);
      setSelectedJob(null);
      toastRef.current?.show({
        severity: 'success',
        summary: 'Eintrag gelöscht',
        detail: `Job #${jobId} wurde entfernt.`,
        life: 3200
      });
      await loadJobs();
    } catch (error) {
      toastRef.current?.show({
        severity: 'error',
        summary: 'Löschen fehlgeschlagen',
        detail: error.message || 'Unbekannter Fehler',
        life: 4200
      });
    } finally {
      setDeleteEntryBusy(false);
    }
  };

  const handleCancelDetailJob = async (job) => {
    const jobId = Number(job?.id || selectedJob?.id || 0);
    if (!jobId) {
      return;
    }
    const confirmed = await confirmModal({
      header: 'Job abbrechen',
      message: `Job #${jobId} abbrechen?`,
      acceptLabel: 'Abbrechen',
      rejectLabel: 'Zurück',
      danger: true
    });
    if (!confirmed) {
      return;
    }
    setCancelDetailBusy(true);
    try {
      await api.cancelConverterJob(jobId);
      handleJobCancelledImmediate(jobId);
      toastRef.current?.show({
        severity: 'success',
        summary: 'Abbruch gesendet',
        detail: `Job #${jobId} wird abgebrochen.`,
        life: 2800
      });
      await loadJobs();
      if (detailVisible) {
        const response = await api.getJob(jobId, { includeLogs: false, forceRefresh: true });
        setSelectedJob(response.job);
      }
    } catch (error) {
      toastRef.current?.show({
        severity: 'error',
        summary: 'Abbruch fehlgeschlagen',
        detail: error.message || 'Unbekannter Fehler',
        life: 4200
      });
    } finally {
      setCancelDetailBusy(false);
    }
  };

  const handleJobDeleted = (jobId) => {
    setJobs((prev) => prev.filter((j) => j.id !== jobId));
    setJobProgress((prev) => {
      const next = { ...prev };
      delete next[jobId];
      return next;
    });
    setExplorerRefreshToken((t) => t + 1);
    if (Number(selectedJob?.id || 0) === Number(jobId || 0)) {
      setDetailVisible(false);
      setSelectedJob(null);
      setDetailLoading(false);
      setLogLoadingMode(null);
    }
  };

  const handleJobCancelledImmediate = (jobId) => {
    const normalizedJobId = normalizeJobId(jobId);
    if (!normalizedJobId) {
      return;
    }
    setJobs((prev) => prev.map((job) => (
      Number(job?.id) === normalizedJobId
        ? { ...job, status: 'CANCELLED' }
        : job
    )));
    setJobProgress((prev) => {
      const next = { ...prev };
      delete next[normalizedJobId];
      return next;
    });
    if (Number(selectedJob?.id || 0) === normalizedJobId) {
      setSelectedJob((prev) => (prev ? { ...prev, status: 'CANCELLED' } : prev));
    }
  };

  const handleJobCancelled = () => setTimeout(loadJobs, 1000);
  const handleJobInputsChanged = async (_jobId, _payload) => {
    setExplorerRefreshToken((t) => t + 1);
    await loadJobs();
  };

  const activeJobs = jobs.filter((j) => !['DONE', 'FINISHED', 'ERROR'].includes(String(j.status || '').toUpperCase()));

  // Auto-expand: ersten Job aufklappen, wenn keiner expanded ist (außer user hat explizit zugeklappt)
  useEffect(() => {
    const normalizedExpanded = Number(expandedJobId) || null;
    const hasExpanded = activeJobs.some((j) => Number(j.id) === normalizedExpanded);
    if (hasExpanded) return;
    if (expandedJobId === null) return; // explizit vom User zugeklappt
    if (activeJobs.length === 0) return;
    setExpandedJobId(Number(activeJobs[0].id));
  }, [activeJobs, expandedJobId]);

  const jobsCardHeader = (
    <div className="converter-card-header">
      <div className="converter-card-title">
        <span>Converter Jobs</span>
        {activeJobs.length > 0 && (
          <Badge value={activeJobs.length} severity="info" />
        )}
      </div>
      <Button
        icon={loadingJobs ? 'pi pi-spin pi-spinner' : 'pi pi-refresh'}
        text
        rounded
        size="small"
        onClick={loadJobs}
        disabled={loadingJobs}
        aria-label="Jobs neu laden"
      />
    </div>
  );

  return (
    <div className="ripper-subpage-content">
      <Toast ref={toastRef} position="top-right" />

      <div className="converter-beta-notice" role="note" aria-live="polite">
        <i className="pi pi-exclamation-triangle" aria-hidden="true" />
        <span>
          Hinweis: Der Converter befindet sich aktuell im Beta-Stadium und ist noch nicht vollständig geprüft.
        </span>
      </div>

      {/* Import-Ordner */}
      <Card title="Import-Ordner" subTitle="Dateien aus dem Raw-Ordner auswählen und als Job anlegen">
        <ConverterFileExplorer
          onSelectionChange={handleSelectionChange}
          refreshToken={explorerRefreshToken}
          selectionResetToken={selectionResetToken}
          navigateToPath={explorerNavigateTo}
          onAssignmentChanged={loadJobs}
        />
        {selectedEntries.length > 0 && (
          <div className="converter-selection-bar">
            <span>
              <Badge value={selectedEntries.length} severity="info" /> ausgewählt
            </span>
            <Button
              label="Job(s) anlegen"
              icon={creatingJobs ? 'pi pi-spin pi-spinner' : 'pi pi-plus'}
              disabled={creatingJobs}
              onClick={handleOpenJobModal}
            />
          </div>
        )}
      </Card>

      {/* Jobs */}
      <Card header={jobsCardHeader}>
        {activeJobs.length === 0 ? (
          <p className="converter-jobs-empty-hint">
            <small>Keine aktiven Converter-Jobs vorhanden. Abgeschlossene Jobs findest du in der Historie.</small>
          </p>
        ) : (
          <div className="ripper-job-list converter-jobs-list">
            {activeJobs.map((job) => {
              const plan = parseConverterPlan(job);
              const converterMediaType = String(plan?.converterMediaType || '').trim().toLowerCase();
              const isAudioJob = converterMediaType === 'audio';
              if (isAudioJob) {
                return (
                  <ConverterJobCard
                    key={job.id}
                    job={job}
                    jobProgress={jobProgress[job.id] || null}
                    isExpanded={Number(job.id) === Number(expandedJobId)}
                    onExpand={() => setExpandedJobId(Number(job.id))}
                    onCollapse={() => setExpandedJobId(null)}
                    onStarted={handleJobStarted}
                    onDeleted={handleJobDeleted}
                    onCancelled={handleJobCancelled}
                    onOpenDetails={handleOpenJobDetails}
                    onInputsChanged={handleJobInputsChanged}
                  />
                );
              }
              return (
                <ConverterVideoJobCard
                  key={job.id}
                  job={job}
                  plan={plan}
                  jobProgress={jobProgress[job.id] || null}
                  isQueued={queuedJobIdSet.has(Number(job.id))}
                  busy={actionBusyJobIds.has(Number(job.id))}
                  userPresets={videoUserPresets}
                  hbPresets={videoHbPresets}
                  isExpanded={Number(job.id) === Number(expandedJobId)}
                  onExpand={() => setExpandedJobId(Number(job.id))}
                  onCollapse={() => setExpandedJobId(null)}
                  onOpenMetadata={handleOpenMetadataDialog}
                  onReassignMetadata={handleOpenMetadataDialog}
                  onStart={handleStartPipelineJob}
                  onConfirmReview={handleConfirmReview}
                  onSelectPlaylist={handleSelectPlaylist}
                  onSelectHandBrakeTitle={handleSelectHandBrakeTitle}
                  onCancel={handleCancelPipelineJob}
                  onRetry={handleRetryJob}
                  onDeleteJob={handleDeleteConverterJob}
                  onRemoveFromQueue={handleRemoveFromQueue}
                  onInputsChanged={handleJobInputsChanged}
                />
              );
            })}
          </div>
        )}
      </Card>

      {/* Upload */}
      <Card title="Datei-Upload" subTitle="Einzelne Dateien oder ganze Ordner (Album) hochladen">
        <ConverterUploadPanel
          onUploaded={handleUploaded}
          allowedExtensions={uploadExtensions}
        />
      </Card>

      <JobModeDialog
        visible={jobModeVisible}
        entries={jobEntries}
        audioMode={audioMode}
        onAudioModeChange={setAudioMode}
        action={jobModalAction}
        onActionChange={setJobModalAction}
        assignableJobs={assignableJobs}
        assignJobId={assignTargetJobId}
        onAssignJobIdChange={setAssignTargetJobId}
        busy={creatingJobs}
        onConfirm={handleJobModeConfirm}
        onHide={() => setJobModeVisible(false)}
      />

      <MetadataSelectionDialog
        visible={metadataDialogVisible}
        context={metadataDialogContext}
        onHide={() => {
          if (metadataDialogBusy) return;
          setMetadataDialogVisible(false);
          setMetadataDialogContext(null);
        }}
        onSubmit={handleMetadataSubmit}
        onSearch={handleMetadataSearch}
        busy={metadataDialogBusy}
      />

      <JobDetailDialog
        visible={detailVisible}
        job={selectedJob}
        detailLoading={detailLoading}
        onLoadLog={handleLoadDetailLog}
        logLoadingMode={logLoadingMode}
        onCancel={handleCancelDetailJob}
        cancelBusy={cancelDetailBusy}
        onDeleteEntry={handleDeleteDetailEntry}
        deleteEntryBusy={deleteEntryBusy}
        onHide={() => {
          setDetailVisible(false);
          setSelectedJob(null);
          setDetailLoading(false);
          setLogLoadingMode(null);
          setDeleteEntryBusy(false);
          setCancelDetailBusy(false);
        }}
      />
    </div>
  );
}

// ── Job-Modus-Dialog ──────────────────────────────────────────────────────────

function JobModeDialog({
  visible,
  entries,
  audioMode,
  onAudioModeChange,
  action,
  onActionChange,
  assignableJobs,
  assignJobId,
  onAssignJobIdChange,
  busy,
  onConfirm,
  onHide
}) {
  const audioEntries = entries.filter(isAudioEntry);
  const videoEntries = entries.filter(isVideoEntry);
  const otherEntries = entries.filter((e) => !isAudioEntry(e) && !isVideoEntry(e));

  const hasAudio = audioEntries.length > 0;
  const hasVideo = videoEntries.length > 0;
  const hasOther = otherEntries.length > 0;
  const hasAssignableJobs = Array.isArray(assignableJobs) && assignableJobs.length > 0;

  // Videos immer individual, audio per Modus
  const audioJobCount = audioMode === 'shared' ? 1 : audioEntries.length;
  const totalJobs = videoEntries.length + otherEntries.length + audioJobCount;
  const isAssignMode = action === 'assign';
  const confirmLabel = isAssignMode
    ? 'Dateien zuweisen'
    : `${totalJobs} Job${totalJobs !== 1 ? 's' : ''} anlegen`;

  const footer = (
    <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
      <Button label="Abbrechen" outlined onClick={onHide} disabled={busy} />
      <Button
        label={confirmLabel}
        icon={busy ? 'pi pi-spin pi-spinner' : 'pi pi-plus'}
        disabled={busy || (isAssignMode && !assignJobId)}
        onClick={() => onConfirm({ action, audioMode, jobId: assignJobId })}
      />
    </div>
  );

  return (
    <Dialog
      header="Jobs anlegen"
      visible={visible}
      onHide={onHide}
      footer={footer}
      style={{ width: '440px' }}
      modal
    >
      {/* Videos / Sonstige immer individual */}
      {(hasVideo || hasOther) && (
        <p style={{ marginTop: 0, marginBottom: hasAudio ? 8 : 0, lineHeight: 1.6 }}>
          <strong>Videos / Sonstige ({videoEntries.length + otherEntries.length}):</strong> Je eine Datei ein eigener Job.
        </p>
      )}

      {hasAudio && (hasVideo || hasOther) && <Divider style={{ margin: '8px 0' }} />}

      {/* Audio: Abfrage */}
      {hasAudio && (
        <div>
          <p style={{ marginTop: 0, marginBottom: 12 }}>
            Wie sollen die <strong>{audioEntries.length} Audiodatei{audioEntries.length !== 1 ? 'en' : ''}</strong> verarbeitet werden?
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, opacity: isAssignMode ? 0.6 : 1 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
              <RadioButton
                value="individual"
                checked={audioMode === 'individual'}
                disabled={isAssignMode}
                onChange={() => onAudioModeChange('individual')}
              />
              <span>Für jede Datei ein eigener Job <small style={{ color: 'var(--rip-muted)' }}>({audioEntries.length} Jobs)</small></span>
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
              <RadioButton
                value="shared"
                checked={audioMode === 'shared'}
                disabled={isAssignMode}
                onChange={() => onAudioModeChange('shared')}
              />
              <span>Ein gemeinsamer Job für alle Dateien <small style={{ color: 'var(--rip-muted)' }}>(1 Job)</small></span>
            </label>
          </div>
        </div>
      )}

      {hasAssignableJobs && (
        <>
          <Divider style={{ margin: '12px 0' }} />
          <div>
            <p style={{ marginTop: 0, marginBottom: 10 }}>
              Optional: Dateien einem <strong>nicht gestarteten Job</strong> direkt zuweisen.
            </p>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', marginBottom: 8 }}>
              <RadioButton
                value="create"
                checked={!isAssignMode}
                onChange={() => onActionChange('create')}
              />
              <span>Neue Jobs anlegen</span>
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', marginBottom: 8 }}>
              <RadioButton
                value="assign"
                checked={isAssignMode}
                onChange={() => onActionChange('assign')}
              />
              <span>Zu bestehendem Job zuweisen</span>
            </label>
            <Dropdown
              value={assignJobId}
              options={assignableJobs}
              onChange={(e) => onAssignJobIdChange(e.value)}
              placeholder="Job auswählen …"
              disabled={!isAssignMode}
              style={{ width: '100%' }}
            />
          </div>
        </>
      )}
    </Dialog>
  );
}

function ConverterVideoJobCard({
  job,
  plan,
  jobProgress,
  isQueued,
  busy,
  userPresets,
  hbPresets,
  isExpanded,
  onExpand,
  onCollapse,
  onOpenMetadata,
  onReassignMetadata,
  onStart,
  onConfirmReview,
  onSelectPlaylist,
  onSelectHandBrakeTitle,
  onCancel,
  onRetry,
  onDeleteJob,
  onRemoveFromQueue,
  onInputsChanged
}) {
  const jobId = Number(job?.id || 0);
  const status = String(job?.status || '').trim().toUpperCase() || 'UNKNOWN';
  const title = String(job?.title || job?.detected_title || `Job #${jobId}`).trim() || `Job #${jobId}`;
  const state = String(jobProgress?.state || status).trim().toUpperCase() || status;
  const pipeline = buildConverterPipeline(job, plan, jobProgress);
  const progressValue = Number(jobProgress?.progress);
  const hasProgress = Number.isFinite(progressValue);

  if (!isExpanded) {
    return (
      <button
        type="button"
        className="ripper-job-row"
        onClick={onExpand}
      >
        {job?.poster_url && job.poster_url !== 'N/A' ? (
          <img src={job.poster_url} alt={title} className="poster-thumb" />
        ) : (
          <div className="poster-thumb ripper-job-poster-fallback">Kein Poster</div>
        )}
        <div className="ripper-job-row-content">
          <div className="ripper-job-row-main">
            <strong className="ripper-job-title-line">
              <i className="pi pi-video media-indicator-icon" style={{ fontSize: '1rem', color: 'var(--rip-muted)' }} />
              <span>{title}</span>
            </strong>
            <small>#{jobId}</small>
          </div>
          <div className="ripper-job-badges">
            <Tag value={getStatusLabel(status, { queued: isQueued })} severity={getStatusSeverity(normalizeStatus(state), { queued: isQueued })} />
          </div>
          {hasProgress && (
            <div className="ripper-job-row-progress">
              <ProgressBar value={Math.max(0, Math.min(100, progressValue))} showValue={false} />
            </div>
          )}
        </div>
        <i className="pi pi-angle-down" aria-hidden="true" />
      </button>
    );
  }

  return (
    <div className="ripper-job-expanded">
      <div className="ripper-job-expanded-head">
        {job?.poster_url && job.poster_url !== 'N/A' ? (
          <img src={job.poster_url} alt={title} className="poster-thumb" />
        ) : (
          <div className="poster-thumb ripper-job-poster-fallback">Kein Poster</div>
        )}
        <div className="ripper-job-expanded-title">
          <strong className="ripper-job-title-line">
            <i className="pi pi-video media-indicator-icon" style={{ fontSize: '1rem', color: 'var(--rip-muted)' }} />
            <span>#{jobId} | {title}</span>
          </strong>
          <div className="ripper-job-badges">
            <Tag value={getStatusLabel(status, { queued: isQueued })} severity={getStatusSeverity(normalizeStatus(state), { queued: isQueued })} />
            <Tag value="Converter" severity="info" />
          </div>
        </div>
        <Button
          label="Einklappen"
          icon="pi pi-angle-up"
          severity="secondary"
          outlined
          onClick={onCollapse}
          disabled={busy}
        />
      </div>

      <PipelineStatusCard
        jobId={jobId}
        jobRow={job}
        pipeline={pipeline}
        onOpenMetadata={onOpenMetadata}
        onReassignMetadata={onReassignMetadata}
        onStart={onStart}
        onConfirmReview={onConfirmReview}
        onSelectPlaylist={onSelectPlaylist}
        onSelectHandBrakeTitle={onSelectHandBrakeTitle}
        onCancel={onCancel}
        onRetry={onRetry}
        onDeleteJob={onDeleteJob}
        onRemoveFromQueue={onRemoveFromQueue}
        onInputsChanged={onInputsChanged}
        isQueued={isQueued}
        busy={busy}
      />
    </div>
  );
}

function ConverterVideoConfigPanel({
  job,
  plan,
  userPresets,
  hbPresets,
  disabled,
  onConfigSaved
}) {
  const [outputFormat, setOutputFormat] = useState(
    String(plan?.outputFormat || 'mkv').trim().toLowerCase() || 'mkv'
  );
  const [selectedUserPreset, setSelectedUserPreset] = useState(
    Number.isFinite(Number(plan?.userPreset?.id)) ? Math.trunc(Number(plan.userPreset.id)) : null
  );
  const [selectedHbPreset, setSelectedHbPreset] = useState(
    Number.isFinite(Number(plan?.userPreset?.id))
      ? ''
      : String(plan?.userPreset?.handbrakePreset || '').trim()
  );
  const [draftSaving, setDraftSaving] = useState(false);
  const [draftError, setDraftError] = useState(null);
  const latestSavedRef = useRef(null);
  const saveTimeoutRef = useRef(null);

  useEffect(() => {
    setOutputFormat(String(plan?.outputFormat || 'mkv').trim().toLowerCase() || 'mkv');
    if (Number.isFinite(Number(plan?.userPreset?.id))) {
      setSelectedUserPreset(Math.trunc(Number(plan.userPreset.id)));
      setSelectedHbPreset('');
    } else {
      setSelectedUserPreset(null);
      setSelectedHbPreset(String(plan?.userPreset?.handbrakePreset || '').trim());
    }
  }, [job?.id, plan?.outputFormat, plan?.userPreset?.id, plan?.userPreset?.handbrakePreset]);

  const draftPayload = useMemo(() => {
    let userPreset = null;
    if (selectedUserPreset) {
      const preset = (Array.isArray(userPresets) ? userPresets : [])
        .find((p) => Number(p?.id) === Number(selectedUserPreset));
      userPreset = preset
        ? { id: preset.id, handbrakePreset: preset.handbrake_preset || null, extraArgs: preset.extra_args || '' }
        : { id: selectedUserPreset };
    } else if (selectedHbPreset) {
      userPreset = { handbrakePreset: selectedHbPreset, extraArgs: '' };
    }
    return {
      converterMediaType: String(plan?.converterMediaType || 'video').trim().toLowerCase() || 'video',
      outputFormat,
      userPreset
    };
  }, [outputFormat, plan?.converterMediaType, selectedUserPreset, selectedHbPreset, userPresets]);

  const draftSerialized = useMemo(() => JSON.stringify(draftPayload), [draftPayload]);

  useEffect(() => {
    if (disabled) return;
    if (latestSavedRef.current === null) {
      latestSavedRef.current = draftSerialized;
      return;
    }
    if (draftSerialized === latestSavedRef.current) return;
    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    saveTimeoutRef.current = setTimeout(async () => {
      setDraftSaving(true);
      setDraftError(null);
      try {
        await api.converterUpdateJobConfig(job.id, draftPayload);
        latestSavedRef.current = draftSerialized;
        onConfigSaved?.(job.id, draftPayload);
      } catch (err) {
        setDraftError(err?.message || 'Konfiguration konnte nicht gespeichert werden.');
      } finally {
        setDraftSaving(false);
      }
    }, 650);
    return () => {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
        saveTimeoutRef.current = null;
      }
    };
  }, [disabled, draftPayload, draftSerialized, job.id]);

  const userPresetOptions = [
    { label: '— Kein User-Preset —', value: null },
    ...(Array.isArray(userPresets) ? userPresets : []).map((p) => ({ label: p.name, value: p.id }))
  ];
  const hbPresetOptions = [
    { label: '— Kein Preset (Standard) —', value: '' },
    ...(Array.isArray(hbPresets) ? hbPresets : []).map((p) => ({
      label: p.category ? `[${p.category}] ${p.name}` : p.name,
      value: p.name
    }))
  ];

  return (
    <div className="cjc-config" style={{ marginBottom: '0.75rem' }}>
      <div className="cjc-config-row">
        <div className="cjc-config-field">
          <label className="cjc-config-label">Ausgabeformat</label>
          <Dropdown
            value={outputFormat}
            options={VIDEO_OUTPUT_FORMATS}
            onChange={(e) => setOutputFormat(e.value)}
            style={{ width: '100%' }}
            disabled={disabled}
          />
        </div>
        <div className="cjc-config-field">
          <label className="cjc-config-label">User-Preset</label>
          <Dropdown
            value={selectedUserPreset}
            options={userPresetOptions}
            onChange={(e) => { setSelectedUserPreset(e.value); if (e.value) setSelectedHbPreset(''); }}
            style={{ width: '100%' }}
            disabled={disabled}
          />
        </div>
        <div className="cjc-config-field">
          <label className="cjc-config-label">HandBrake-Preset</label>
          <Dropdown
            value={selectedHbPreset}
            options={hbPresetOptions}
            onChange={(e) => setSelectedHbPreset(e.value)}
            filter
            placeholder="Preset auswählen …"
            style={{ width: '100%' }}
            disabled={disabled || Boolean(selectedUserPreset)}
          />
          {selectedUserPreset ? (
            <small style={{ color: 'var(--text-color-secondary)' }}>Deaktiviert, solange ein User-Preset aktiv ist.</small>
          ) : null}
        </div>
      </div>
      {draftError ? (
        <small style={{ color: 'var(--red-600)' }}>{draftError}</small>
      ) : (
        <small style={{ color: 'var(--text-color-secondary)' }}>
          {draftSaving ? 'Speichere Konfiguration …' : 'Konfiguration gespeichert'}
        </small>
      )}
    </div>
  );
}
