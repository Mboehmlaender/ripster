import { useEffect, useMemo, useRef, useState } from 'react';
import { Toast } from 'primereact/toast';
import { Card } from 'primereact/card';
import { Button } from 'primereact/button';
import { Tag } from 'primereact/tag';
import { ProgressBar } from 'primereact/progressbar';
import { Dialog } from 'primereact/dialog';
import { InputNumber } from 'primereact/inputnumber';
import { api } from '../api/client';
import PipelineStatusCard from '../components/PipelineStatusCard';
import MetadataSelectionDialog from '../components/MetadataSelectionDialog';
import blurayIndicatorIcon from '../assets/media-bluray.svg';
import discIndicatorIcon from '../assets/media-disc.svg';
import otherIndicatorIcon from '../assets/media-other.svg';
import { getStatusLabel, getStatusSeverity, normalizeStatus } from '../utils/statusPresentation';

const processingStates = ['ANALYZING', 'RIPPING', 'MEDIAINFO_CHECK', 'ENCODING'];
const dashboardStatuses = new Set([
  'ANALYZING',
  'METADATA_SELECTION',
  'WAITING_FOR_USER_DECISION',
  'READY_TO_START',
  'MEDIAINFO_CHECK',
  'READY_TO_ENCODE',
  'RIPPING',
  'ENCODING',
  'CANCELLED',
  'ERROR'
]);

function normalizeJobId(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return Math.trunc(parsed);
}

function formatPercent(value, digits = 1) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return 'n/a';
  }
  return `${parsed.toFixed(digits)}%`;
}

function formatTemperature(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return 'n/a';
  }
  return `${parsed.toFixed(1)}°C`;
}

function formatBytes(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return 'n/a';
  }
  if (parsed === 0) {
    return '0 B';
  }
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let unitIndex = 0;
  let current = parsed;
  while (current >= 1024 && unitIndex < units.length - 1) {
    current /= 1024;
    unitIndex += 1;
  }
  const digits = unitIndex <= 1 ? 0 : 2;
  return `${current.toFixed(digits)} ${units[unitIndex]}`;
}

function formatUpdatedAt(value) {
  if (!value) {
    return '-';
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '-';
  }
  return date.toLocaleString('de-DE');
}

function normalizeHardwareMonitoringPayload(rawPayload) {
  const payload = rawPayload && typeof rawPayload === 'object' ? rawPayload : {};
  return {
    enabled: Boolean(payload.enabled),
    intervalMs: Number(payload.intervalMs || 0),
    updatedAt: payload.updatedAt || null,
    sample: payload.sample && typeof payload.sample === 'object' ? payload.sample : null,
    error: payload.error ? String(payload.error) : null
  };
}

function getStorageUsageTone(usagePercent) {
  const value = Number(usagePercent);
  if (!Number.isFinite(value)) {
    return 'unknown';
  }
  if (value >= 95) {
    return 'critical';
  }
  if (value >= 85) {
    return 'high';
  }
  if (value >= 70) {
    return 'warn';
  }
  return 'ok';
}

function normalizeQueue(queue) {
  const payload = queue && typeof queue === 'object' ? queue : {};
  const runningJobs = Array.isArray(payload.runningJobs) ? payload.runningJobs : [];
  const queuedJobs = Array.isArray(payload.queuedJobs) ? payload.queuedJobs : [];
  return {
    maxParallelJobs: Number(payload.maxParallelJobs || 1),
    runningCount: Number(payload.runningCount || runningJobs.length || 0),
    runningJobs,
    queuedJobs,
    queuedCount: Number(payload.queuedCount || queuedJobs.length || 0),
    updatedAt: payload.updatedAt || null
  };
}

function getQueueActionResult(response) {
  return response?.result && typeof response.result === 'object' ? response.result : {};
}

function showQueuedToast(toastRef, actionLabel, result) {
  if (!toastRef?.current) {
    return;
  }
  const queuePosition = Number(result?.queuePosition || 0);
  const positionText = queuePosition > 0 ? `Position ${queuePosition}` : 'in der Warteschlange';
  toastRef.current.show({
    severity: 'info',
    summary: `${actionLabel} in Queue`,
    detail: `${actionLabel} wurde ${positionText} eingeplant.`,
    life: 3200
  });
}

function reorderQueuedItems(items, draggedEntryId, targetEntryId) {
  const list = Array.isArray(items) ? items : [];
  const from = list.findIndex((item) => Number(item?.entryId) === Number(draggedEntryId));
  const to = list.findIndex((item) => Number(item?.entryId) === Number(targetEntryId));
  if (from < 0 || to < 0 || from === to) {
    return list;
  }
  const next = [...list];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next.map((item, index) => ({
    ...item,
    position: index + 1
  }));
}

function queueEntryIcon(type) {
  if (type === 'script') return 'pi pi-code';
  if (type === 'chain') return 'pi pi-link';
  if (type === 'wait') return 'pi pi-clock';
  return 'pi pi-box';
}

function queueEntryLabel(item) {
  if (item.type === 'script') return `Skript: ${item.title}`;
  if (item.type === 'chain') return `Kette: ${item.title}`;
  if (item.type === 'wait') return `Warten: ${item.waitSeconds}s`;
  return item.title || `Job #${item.jobId}`;
}

function getAnalyzeContext(job) {
  return job?.makemkvInfo?.analyzeContext && typeof job.makemkvInfo.analyzeContext === 'object'
    ? job.makemkvInfo.analyzeContext
    : {};
}

function resolveMediaType(job) {
  const raw = String(job?.mediaType || job?.media_type || '').trim().toLowerCase();
  if (raw === 'bluray') {
    return 'bluray';
  }
  if (raw === 'dvd' || raw === 'disc') {
    return 'dvd';
  }
  return 'other';
}

function mediaIndicatorMeta(job) {
  const mediaType = resolveMediaType(job);
  return mediaType === 'bluray'
    ? {
      mediaType,
      src: blurayIndicatorIcon,
      alt: 'Blu-ray',
      title: 'Blu-ray'
    }
    : mediaType === 'dvd'
      ? {
        mediaType,
        src: discIndicatorIcon,
        alt: 'DVD',
        title: 'DVD'
      }
    : {
      mediaType,
      src: otherIndicatorIcon,
      alt: 'Sonstiges Medium',
      title: 'Sonstiges Medium'
    };
}

function JobStepChecks({ backupSuccess, encodeSuccess }) {
  const hasAny = Boolean(backupSuccess || encodeSuccess);
  if (!hasAny) {
    return null;
  }
  return (
    <div className="job-step-checks">
      {backupSuccess ? (
        <span className="job-step-inline-ok" title="Backup/Rip erfolgreich">
          <i className="pi pi-check-circle" aria-hidden="true" />
          <span>Backup</span>
        </span>
      ) : null}
      {encodeSuccess ? (
        <span className="job-step-inline-ok" title="Encode erfolgreich">
          <i className="pi pi-check-circle" aria-hidden="true" />
          <span>Encode</span>
        </span>
      ) : null}
    </div>
  );
}

function buildPipelineFromJob(job, currentPipeline, currentPipelineJobId) {
  const jobId = normalizeJobId(job?.id);
  const isCurrentSessionJob = Boolean(
    jobId
    && currentPipelineJobId
    && jobId === currentPipelineJobId
    && String(currentPipeline?.state || '').trim().toUpperCase() !== 'IDLE'
  );

  const encodePlan = job?.encodePlan && typeof job.encodePlan === 'object' ? job.encodePlan : null;
  const analyzeContext = getAnalyzeContext(job);
  const mode = String(encodePlan?.mode || 'rip').trim().toLowerCase();
  const isPreRip = mode === 'pre_rip' || Boolean(encodePlan?.preRip);
  const inputPath = isPreRip
    ? null
    : (job?.encode_input_path || encodePlan?.encodeInputPath || null);
  const reviewConfirmed = Boolean(Number(job?.encode_review_confirmed || 0) || encodePlan?.reviewConfirmed);
  const hasEncodableTitle = isPreRip
    ? Boolean(encodePlan?.encodeInputTitleId)
    : Boolean(inputPath || job?.raw_path);
  const jobStatus = String(job?.status || job?.last_state || 'IDLE').trim().toUpperCase() || 'IDLE';
  const lastState = String(job?.last_state || '').trim().toUpperCase();
  const errorText = String(job?.error_message || '').trim().toUpperCase();
  const hasOutputPath = Boolean(String(job?.output_path || '').trim());
  const hasEncodePlan = Boolean(encodePlan && Array.isArray(encodePlan?.titles) && encodePlan.titles.length > 0);
  const looksLikeCancelledEncode = (jobStatus === 'ERROR' || jobStatus === 'CANCELLED') && (
    (errorText.includes('ABGEBROCHEN') || errorText.includes('CANCELLED'))
    && (hasOutputPath || Boolean(job?.encode_input_path) || Boolean(job?.handbrakeInfo))
  );
  const looksLikeEncodingError = (jobStatus === 'ERROR' || jobStatus === 'CANCELLED') && (
    errorText.includes('ENCODING')
    || errorText.includes('HANDBRAKE')
    || lastState === 'ENCODING'
    || Boolean(job?.handbrakeInfo)
    || looksLikeCancelledEncode
  );
  const canRestartEncodeFromLastSettings = Boolean(
    hasEncodePlan
    && reviewConfirmed
    && hasEncodableTitle
    && (
      jobStatus === 'READY_TO_ENCODE'
      || jobStatus === 'ENCODING'
      || jobStatus === 'CANCELLED'
      || looksLikeEncodingError
    )
  );
  const canRestartReviewFromRaw = Boolean(
    job?.raw_path
    && !processingStates.includes(jobStatus)
  );
  const computedContext = {
    jobId,
    rawPath: job?.raw_path || null,
    detectedTitle: job?.detected_title || null,
    inputPath,
    hasEncodableTitle,
    reviewConfirmed,
    mode,
    sourceJobId: encodePlan?.sourceJobId || null,
    selectedMetadata: {
      title: job?.title || job?.detected_title || null,
      year: job?.year || null,
      imdbId: job?.imdb_id || null,
      poster: job?.poster_url || null
    },
    mediaInfoReview: encodePlan,
    playlistAnalysis: analyzeContext.playlistAnalysis || null,
    playlistDecisionRequired: Boolean(analyzeContext.playlistDecisionRequired),
    playlistCandidates: Array.isArray(analyzeContext?.playlistAnalysis?.evaluatedCandidates)
      ? analyzeContext.playlistAnalysis.evaluatedCandidates
      : [],
    selectedPlaylist: analyzeContext.selectedPlaylist || null,
    selectedTitleId: analyzeContext.selectedTitleId ?? null,
    omdbCandidates: [],
    canRestartEncodeFromLastSettings,
    canRestartReviewFromRaw
  };

  if (isCurrentSessionJob) {
    const existingContext = currentPipeline?.context && typeof currentPipeline.context === 'object'
      ? currentPipeline.context
      : {};
    return {
      ...currentPipeline,
      context: {
        ...computedContext,
        ...existingContext,
        rawPath: existingContext.rawPath || computedContext.rawPath,
        selectedMetadata: existingContext.selectedMetadata || computedContext.selectedMetadata,
        canRestartEncodeFromLastSettings:
          existingContext.canRestartEncodeFromLastSettings ?? computedContext.canRestartEncodeFromLastSettings,
        canRestartReviewFromRaw:
          existingContext.canRestartReviewFromRaw ?? computedContext.canRestartReviewFromRaw
      }
    };
  }

  // Use live per-job progress from the backend if available (concurrent jobs).
  const liveJobProgress = currentPipeline?.jobProgress && jobId
    ? (currentPipeline.jobProgress[jobId] || null)
    : null;

  return {
    state: liveJobProgress?.state || jobStatus,
    activeJobId: jobId,
    progress: liveJobProgress != null ? Number(liveJobProgress.progress ?? 0) : 0,
    eta: liveJobProgress?.eta || null,
    statusText: liveJobProgress?.statusText || job?.error_message || null,
    context: computedContext
  };
}

export default function DashboardPage({
  pipeline,
  hardwareMonitoring,
  lastDiscEvent,
  refreshPipeline
}) {
  const [busy, setBusy] = useState(false);
  const [metadataDialogVisible, setMetadataDialogVisible] = useState(false);
  const [metadataDialogContext, setMetadataDialogContext] = useState(null);
  const [cancelCleanupDialog, setCancelCleanupDialog] = useState({
    visible: false,
    jobId: null,
    target: null,
    path: null
  });
  const [cancelCleanupBusy, setCancelCleanupBusy] = useState(false);
  const [queueState, setQueueState] = useState(() => normalizeQueue(pipeline?.queue));
  const [queueReorderBusy, setQueueReorderBusy] = useState(false);
  const [draggingQueueEntryId, setDraggingQueueEntryId] = useState(null);
  const [insertQueueDialog, setInsertQueueDialog] = useState({ visible: false, afterEntryId: null });
  const [liveJobLog, setLiveJobLog] = useState('');
  const [jobsLoading, setJobsLoading] = useState(false);
  const [dashboardJobs, setDashboardJobs] = useState([]);
  const [expandedJobId, setExpandedJobId] = useState(undefined);
  const [cpuCoresExpanded, setCpuCoresExpanded] = useState(false);
  const [queueCatalog, setQueueCatalog] = useState({ scripts: [], chains: [] });
  const [insertWaitSeconds, setInsertWaitSeconds] = useState(30);
  const toastRef = useRef(null);

  const state = String(pipeline?.state || 'IDLE').trim().toUpperCase();
  const currentPipelineJobId = normalizeJobId(pipeline?.activeJobId || pipeline?.context?.jobId);
  const isProcessing = processingStates.includes(state);
  const monitoringState = useMemo(
    () => normalizeHardwareMonitoringPayload(hardwareMonitoring),
    [hardwareMonitoring]
  );
  const monitoringSample = monitoringState.sample;
  const cpuMetrics = monitoringSample?.cpu || null;
  const memoryMetrics = monitoringSample?.memory || null;
  const gpuMetrics = monitoringSample?.gpu || null;
  const storageMetrics = Array.isArray(monitoringSample?.storage) ? monitoringSample.storage : [];
  const storageGroups = useMemo(() => {
    const groups = [];
    const mountMap = new Map();
    for (const entry of storageMetrics) {
      const groupKey = entry?.mountPoint || `__no_mount_${entry?.key}`;
      if (!mountMap.has(groupKey)) {
        const group = { mountPoint: entry?.mountPoint || null, entries: [], representative: entry };
        mountMap.set(groupKey, group);
        groups.push(group);
      }
      mountMap.get(groupKey).entries.push(entry);
    }
    return groups;
  }, [storageMetrics]);
  const cpuPerCoreMetrics = Array.isArray(cpuMetrics?.perCore) ? cpuMetrics.perCore : [];
  const gpuDevices = Array.isArray(gpuMetrics?.devices) ? gpuMetrics.devices : [];

  const loadDashboardJobs = async () => {
    setJobsLoading(true);
    try {
      const [jobsResponse, queueResponse] = await Promise.allSettled([
        api.getJobs(),
        api.getPipelineQueue()
      ]);
      const allJobs = jobsResponse.status === 'fulfilled'
        ? (Array.isArray(jobsResponse.value?.jobs) ? jobsResponse.value.jobs : [])
        : [];
      if (queueResponse.status === 'fulfilled') {
        setQueueState(normalizeQueue(queueResponse.value?.queue));
      }
      const next = allJobs
        .filter((job) => dashboardStatuses.has(String(job?.status || '').trim().toUpperCase()))
        .sort((a, b) => Number(b?.id || 0) - Number(a?.id || 0));

      if (currentPipelineJobId && !next.some((job) => normalizeJobId(job?.id) === currentPipelineJobId)) {
        try {
          const active = await api.getJob(currentPipelineJobId);
          if (active?.job) {
            next.unshift(active.job);
          }
        } catch (_error) {
          // ignore; dashboard still shows available rows
        }
      }

      const seen = new Set();
      const deduped = [];
      for (const job of next) {
        const id = normalizeJobId(job?.id);
        if (!id || seen.has(String(id))) {
          continue;
        }
        seen.add(String(id));
        deduped.push(job);
      }

      setDashboardJobs(deduped);
    } catch (_error) {
      setDashboardJobs([]);
    } finally {
      setJobsLoading(false);
    }
  };

  useEffect(() => {
    if (!metadataDialogVisible) {
      return;
    }
    if (metadataDialogContext?.jobId) {
      return;
    }
    if (pipeline?.state !== 'METADATA_SELECTION' && pipeline?.state !== 'WAITING_FOR_USER_DECISION') {
      setMetadataDialogVisible(false);
    }
  }, [pipeline?.state, metadataDialogVisible, metadataDialogContext?.jobId]);

  useEffect(() => {
    setQueueState(normalizeQueue(pipeline?.queue));
  }, [pipeline?.queue]);

  useEffect(() => {
    void loadDashboardJobs();
  }, [pipeline?.state, pipeline?.activeJobId, pipeline?.context?.jobId]);

  useEffect(() => {
    const normalizedExpanded = normalizeJobId(expandedJobId);
    const hasExpanded = dashboardJobs.some((job) => normalizeJobId(job?.id) === normalizedExpanded);
    if (hasExpanded) {
      return;
    }

    // Respect explicit user collapse.
    if (expandedJobId === null) {
      return;
    }

    if (currentPipelineJobId && dashboardJobs.some((job) => normalizeJobId(job?.id) === currentPipelineJobId)) {
      setExpandedJobId(currentPipelineJobId);
      return;
    }
    setExpandedJobId(normalizeJobId(dashboardJobs[0]?.id));
  }, [dashboardJobs, expandedJobId, currentPipelineJobId]);

  useEffect(() => {
    if (!currentPipelineJobId || !isProcessing) {
      setLiveJobLog('');
      return undefined;
    }

    let cancelled = false;
    const refreshLiveLog = async () => {
      try {
        const response = await api.getJob(currentPipelineJobId, { includeLiveLog: true });
        if (!cancelled) {
          setLiveJobLog(response?.job?.log || '');
        }
      } catch (_error) {
        // ignore transient polling errors to avoid noisy toasts while background polling
      }
    };

    void refreshLiveLog();
    const interval = setInterval(refreshLiveLog, 2500);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [currentPipelineJobId, isProcessing]);

  const pipelineByJobId = useMemo(() => {
    const map = new Map();
    for (const job of dashboardJobs) {
      const id = normalizeJobId(job?.id);
      if (!id) {
        continue;
      }
      map.set(id, buildPipelineFromJob(job, pipeline, currentPipelineJobId));
    }
    return map;
  }, [dashboardJobs, pipeline, currentPipelineJobId]);

  const buildMetadataContextForJob = (jobId) => {
    const normalizedJobId = normalizeJobId(jobId);
    if (!normalizedJobId) {
      return null;
    }
    const job = dashboardJobs.find((item) => normalizeJobId(item?.id) === normalizedJobId) || null;
    const pipelineForJob = pipelineByJobId.get(normalizedJobId) || null;
    const context = pipelineForJob?.context && typeof pipelineForJob.context === 'object'
      ? pipelineForJob.context
      : {};
    const selectedMetadata = context.selectedMetadata && typeof context.selectedMetadata === 'object'
      ? context.selectedMetadata
      : {
        title: job?.title || job?.detected_title || context?.detectedTitle || '',
        year: job?.year || null,
        imdbId: job?.imdb_id || null,
        poster: job?.poster_url || null
      };
    return {
      ...context,
      jobId: normalizedJobId,
      detectedTitle: context?.detectedTitle || job?.detected_title || selectedMetadata?.title || '',
      selectedMetadata,
      omdbCandidates: Array.isArray(context?.omdbCandidates) ? context.omdbCandidates : []
    };
  };

  const defaultMetadataDialogContext = useMemo(() => {
    const currentState = String(pipeline?.state || '').trim().toUpperCase();
    const currentContext = pipeline?.context && typeof pipeline.context === 'object'
      ? pipeline.context
      : null;
    const currentContextJobId = normalizeJobId(currentContext?.jobId);
    if (
      (currentState === 'METADATA_SELECTION' || currentState === 'WAITING_FOR_USER_DECISION')
      && currentContextJobId
    ) {
      return {
        ...currentContext,
        jobId: currentContextJobId,
        selectedMetadata: currentContext?.selectedMetadata || {
          title: currentContext?.detectedTitle || '',
          year: null,
          imdbId: null,
          poster: null
        },
        omdbCandidates: Array.isArray(currentContext?.omdbCandidates) ? currentContext.omdbCandidates : []
      };
    }

    const pendingJob = dashboardJobs.find((job) => {
      const normalized = normalizeStatus(job?.status);
      return normalized === 'METADATA_SELECTION' || normalized === 'WAITING_FOR_USER_DECISION';
    });
    if (!pendingJob) {
      return null;
    }
    return buildMetadataContextForJob(pendingJob.id);
  }, [pipeline, dashboardJobs, pipelineByJobId]);

  const effectiveMetadataDialogContext = metadataDialogContext
    || defaultMetadataDialogContext
    || pipeline?.context
    || {};

  const showError = (error) => {
    toastRef.current?.show({
      severity: 'error',
      summary: 'Fehler',
      detail: error.message,
      life: 4500
    });
  };

  const handleOpenMetadataDialog = (jobId = null) => {
    const context = jobId ? buildMetadataContextForJob(jobId) : defaultMetadataDialogContext;
    if (!context?.jobId) {
      showError(new Error('Kein Job mit offener Metadaten-Auswahl gefunden.'));
      return;
    }
    setMetadataDialogContext(context);
    setMetadataDialogVisible(true);
  };

  const handleAnalyze = async () => {
    setBusy(true);
    try {
      const response = await api.analyzeDisc();
      await refreshPipeline();
      await loadDashboardJobs();
      const analyzedJobId = normalizeJobId(response?.result?.jobId);
      if (analyzedJobId && state === 'ENCODING') {
        setMetadataDialogContext({
          jobId: analyzedJobId,
          detectedTitle: response?.result?.detectedTitle || '',
          selectedMetadata: {
            title: response?.result?.detectedTitle || '',
            year: null,
            imdbId: null,
            poster: null
          },
          omdbCandidates: Array.isArray(response?.result?.omdbCandidates)
            ? response.result.omdbCandidates
            : []
        });
        setMetadataDialogVisible(true);
      }
    } catch (error) {
      showError(error);
    } finally {
      setBusy(false);
    }
  };

  const handleReanalyze = async () => {
    const hasActiveJob = Boolean(pipeline?.context?.jobId || pipeline?.activeJobId);
    if (state === 'ENCODING') {
      const confirmed = window.confirm(
        'Laufendes Encoding bleibt aktiv. Neue Disk jetzt als separaten Job analysieren?'
      );
      if (!confirmed) {
        return;
      }
    } else if (hasActiveJob && !['IDLE', 'DISC_DETECTED', 'FINISHED'].includes(state)) {
      const confirmed = window.confirm(
        'Aktuellen Ablauf verwerfen und die Disk ab der ersten MakeMKV-Analyse neu starten?'
      );
      if (!confirmed) {
        return;
      }
    }
    await handleAnalyze();
  };

  const handleRescan = async () => {
    setBusy(true);
    try {
      const response = await api.rescanDisc();
      const emitted = response?.result?.emitted || 'none';
      toastRef.current?.show({
        severity: emitted === 'discInserted' ? 'success' : 'info',
        summary: 'Laufwerk neu gelesen',
        detail:
          emitted === 'discInserted'
            ? 'Disk-Event wurde neu ausgelöst.'
            : 'Kein Medium erkannt.',
        life: 2800
      });
      await refreshPipeline();
      await loadDashboardJobs();
    } catch (error) {
      showError(error);
    } finally {
      setBusy(false);
    }
  };

  const handleCancel = async (jobId = null, jobState = null) => {
    const cancelledJobId = normalizeJobId(jobId) || currentPipelineJobId;
    const cancelledJob = dashboardJobs.find((item) => normalizeJobId(item?.id) === cancelledJobId) || null;
    const cancelledState = String(
      jobState
      || cancelledJob?.status
      || state
      || 'IDLE'
    ).trim().toUpperCase();

    setBusy(true);
    try {
      await api.cancelPipeline(cancelledJobId);
      await refreshPipeline();
      await loadDashboardJobs();
      if (cancelledState === 'ENCODING' && cancelledJobId) {
        setCancelCleanupDialog({
          visible: true,
          jobId: cancelledJobId,
          target: 'movie',
          path: cancelledJob?.output_path || null
        });
      } else if (cancelledState === 'RIPPING' && cancelledJobId) {
        setCancelCleanupDialog({
          visible: true,
          jobId: cancelledJobId,
          target: 'raw',
          path: cancelledJob?.raw_path || null
        });
      }
    } catch (error) {
      showError(error);
    } finally {
      setBusy(false);
    }
  };

  const handleDeleteCancelledOutput = async () => {
    const jobId = normalizeJobId(cancelCleanupDialog?.jobId);
    const target = String(cancelCleanupDialog?.target || '').trim().toLowerCase();
    const effectiveTarget = target === 'raw' ? 'raw' : 'movie';
    if (!jobId) {
      setCancelCleanupDialog({ visible: false, jobId: null, target: null, path: null });
      return;
    }

    setCancelCleanupBusy(true);
    try {
      const response = await api.deleteJobFiles(jobId, effectiveTarget);
      const summary = response?.summary || {};
      const deletedFiles = effectiveTarget === 'raw'
        ? (summary.raw?.filesDeleted ?? 0)
        : (summary.movie?.filesDeleted ?? 0);
      const removedDirs = effectiveTarget === 'raw'
        ? (summary.raw?.dirsRemoved ?? 0)
        : (summary.movie?.dirsRemoved ?? 0);
      toastRef.current?.show({
        severity: 'success',
        summary: effectiveTarget === 'raw' ? 'RAW gelöscht' : 'Movie gelöscht',
        detail: `Entfernt: ${deletedFiles} Datei(en), ${removedDirs} Ordner.`,
        life: 4000
      });
      await loadDashboardJobs();
      await refreshPipeline();
      setCancelCleanupDialog({ visible: false, jobId: null, target: null, path: null });
    } catch (error) {
      showError(error);
    } finally {
      setCancelCleanupBusy(false);
    }
  };

  const handleStartJob = async (jobId, options = null) => {
    const normalizedJobId = normalizeJobId(jobId);
    if (!normalizedJobId) {
      return;
    }

    const startOptions = options && typeof options === 'object' ? options : {};
    setBusy(true);
    try {
      if (startOptions.ensureConfirmed) {
        await api.confirmEncodeReview(normalizedJobId, {
          selectedEncodeTitleId: startOptions.selectedEncodeTitleId ?? null,
          selectedTrackSelection: startOptions.selectedTrackSelection ?? null,
          selectedPostEncodeScriptIds: startOptions.selectedPostEncodeScriptIds ?? [],
          selectedPreEncodeScriptIds: startOptions.selectedPreEncodeScriptIds ?? [],
          selectedPostEncodeChainIds: startOptions.selectedPostEncodeChainIds ?? [],
          selectedPreEncodeChainIds: startOptions.selectedPreEncodeChainIds ?? [],
          skipPipelineStateUpdate: true
        });
      }
      const response = await api.startJob(normalizedJobId);
      const result = getQueueActionResult(response);
      await refreshPipeline();
      await loadDashboardJobs();
      if (result.queued) {
        showQueuedToast(toastRef, 'Start', result);
      } else {
        setExpandedJobId(normalizedJobId);
      }
    } catch (error) {
      showError(error);
    } finally {
      setBusy(false);
    }
  };

  const handleConfirmReview = async (
    jobId,
    selectedEncodeTitleId = null,
    selectedTrackSelection = null,
    selectedPostEncodeScriptIds = undefined
  ) => {
    setBusy(true);
    try {
      await api.confirmEncodeReview(jobId, {
        selectedEncodeTitleId,
        selectedTrackSelection,
        selectedPostEncodeScriptIds
      });
      await refreshPipeline();
      await loadDashboardJobs();
      setExpandedJobId(normalizeJobId(jobId));
    } catch (error) {
      showError(error);
    } finally {
      setBusy(false);
    }
  };

  const handleSelectPlaylist = async (jobId, selectedPlaylist = null) => {
    setBusy(true);
    try {
      await api.selectMetadata({
        jobId,
        selectedPlaylist: selectedPlaylist || null
      });
      await refreshPipeline();
      await loadDashboardJobs();
      setExpandedJobId(normalizeJobId(jobId));
    } catch (error) {
      showError(error);
    } finally {
      setBusy(false);
    }
  };

  const handleRetry = async (jobId) => {
    setBusy(true);
    try {
      const response = await api.retryJob(jobId);
      const result = getQueueActionResult(response);
      await refreshPipeline();
      await loadDashboardJobs();
      if (result.queued) {
        showQueuedToast(toastRef, 'Retry', result);
      } else {
        setExpandedJobId(normalizeJobId(jobId));
      }
    } catch (error) {
      showError(error);
    } finally {
      setBusy(false);
    }
  };

  const handleRestartEncodeWithLastSettings = async (jobId) => {
    const job = dashboardJobs.find((item) => normalizeJobId(item?.id) === normalizeJobId(jobId)) || null;
    const title = job?.title || job?.detected_title || `Job #${jobId}`;
    if (job?.encodeSuccess) {
      const confirmed = window.confirm(
        `Encode für "${title}" ist bereits erfolgreich abgeschlossen. Wirklich erneut encodieren?\n` +
        'Es wird eine neue Datei mit Kollisionsprüfung angelegt.'
      );
      if (!confirmed) {
        return;
      }
    }

    setBusy(true);
    try {
      const response = await api.restartEncodeWithLastSettings(jobId);
      const result = getQueueActionResult(response);
      await refreshPipeline();
      await loadDashboardJobs();
      if (result.queued) {
        showQueuedToast(toastRef, 'Encode-Neustart', result);
      } else {
        setExpandedJobId(normalizeJobId(jobId));
      }
    } catch (error) {
      showError(error);
    } finally {
      setBusy(false);
    }
  };

  const handleRestartReviewFromRaw = async (jobId) => {
    const normalizedJobId = normalizeJobId(jobId);
    if (!normalizedJobId) {
      return;
    }

    setBusy(true);
    try {
      await api.restartReviewFromRaw(normalizedJobId);
      await refreshPipeline();
      await loadDashboardJobs();
      setExpandedJobId(normalizedJobId);
    } catch (error) {
      showError(error);
    } finally {
      setBusy(false);
    }
  };

  const handleQueueDragEnter = (targetEntryId) => {
    const targetId = Number(targetEntryId);
    const draggedId = Number(draggingQueueEntryId);
    if (!targetId || !draggedId || targetId === draggedId || queueReorderBusy) {
      return;
    }
    setQueueState((prev) => {
      const queuedJobs = reorderQueuedItems(prev?.queuedJobs || [], draggedId, targetId);
      return {
        ...normalizeQueue(prev),
        queuedJobs,
        queuedCount: queuedJobs.length
      };
    });
  };

  const handleQueueDrop = async () => {
    const draggedId = Number(draggingQueueEntryId);
    setDraggingQueueEntryId(null);
    if (!draggedId || queueReorderBusy) {
      return;
    }

    const orderedEntryIds = (Array.isArray(queueState?.queuedJobs) ? queueState.queuedJobs : [])
      .map((item) => Number(item?.entryId))
      .filter(Boolean);
    if (orderedEntryIds.length <= 1) {
      return;
    }

    setQueueReorderBusy(true);
    try {
      const response = await api.reorderPipelineQueue(orderedEntryIds);
      setQueueState(normalizeQueue(response?.queue));
    } catch (error) {
      showError(error);
      try {
        const latest = await api.getPipelineQueue();
        setQueueState(normalizeQueue(latest?.queue));
      } catch (_reloadError) {
        // ignore reload failures after reorder error
      }
    } finally {
      setQueueReorderBusy(false);
    }
  };

  const handleRemoveQueuedJob = async (jobId) => {
    const normalizedJobId = normalizeJobId(jobId);
    if (!normalizedJobId || queueReorderBusy) {
      return;
    }

    setQueueReorderBusy(true);
    try {
      await api.cancelPipeline(normalizedJobId);
      const latest = await api.getPipelineQueue();
      setQueueState(normalizeQueue(latest?.queue));
    } catch (error) {
      showError(error);
    } finally {
      setQueueReorderBusy(false);
    }
  };

  const handleRemoveQueueEntry = async (entryId) => {
    if (!entryId || queueReorderBusy) {
      return;
    }
    setQueueReorderBusy(true);
    try {
      const response = await api.removeQueueEntry(entryId);
      setQueueState(normalizeQueue(response?.queue));
    } catch (error) {
      showError(error);
    } finally {
      setQueueReorderBusy(false);
    }
  };

  const openInsertQueueDialog = async (afterEntryId) => {
    setInsertQueueDialog({ visible: true, afterEntryId: afterEntryId ?? null });
    try {
      const [scriptsRes, chainsRes] = await Promise.allSettled([api.getScripts(), api.getScriptChains()]);
      setQueueCatalog({
        scripts: scriptsRes.status === 'fulfilled' ? (Array.isArray(scriptsRes.value?.scripts) ? scriptsRes.value.scripts : []) : [],
        chains: chainsRes.status === 'fulfilled' ? (Array.isArray(chainsRes.value?.chains) ? chainsRes.value.chains : []) : []
      });
    } catch (_) { /* ignore */ }
  };

  const handleAddQueueEntry = async (type, params) => {
    const afterEntryId = insertQueueDialog.afterEntryId;
    setInsertQueueDialog({ visible: false, afterEntryId: null });
    try {
      const response = await api.addQueueEntry({ type, ...params, insertAfterEntryId: afterEntryId });
      setQueueState(normalizeQueue(response?.queue));
    } catch (error) {
      showError(error);
    }
  };

  const syncQueueFromServer = async () => {
    try {
      const latest = await api.getPipelineQueue();
      setQueueState(normalizeQueue(latest?.queue));
    } catch (_error) {
      // ignore sync failures
    }
  };

  const handleOmdbSearch = async (query) => {
    try {
      const response = await api.searchOmdb(query);
      return response.results || [];
    } catch (error) {
      showError(error);
      return [];
    }
  };

  const handleMetadataSubmit = async (payload) => {
    setBusy(true);
    try {
      await api.selectMetadata(payload);
      await refreshPipeline();
      await loadDashboardJobs();
      setMetadataDialogVisible(false);
      setMetadataDialogContext(null);
    } catch (error) {
      showError(error);
    } finally {
      setBusy(false);
    }
  };

  const device = lastDiscEvent || pipeline?.context?.device;
  const canReanalyze = state === 'ENCODING'
    ? Boolean(device)
    : !processingStates.includes(state);
  const canOpenMetadataModal = Boolean(defaultMetadataDialogContext?.jobId);
  const queueRunningJobs = Array.isArray(queueState?.runningJobs) ? queueState.runningJobs : [];
  const queuedJobs = Array.isArray(queueState?.queuedJobs) ? queueState.queuedJobs : [];
  const canReorderQueue = queuedJobs.length > 1 && !queueReorderBusy;
  const queuedJobIdSet = useMemo(() => {
    const set = new Set();
    for (const item of queuedJobs) {
      const id = normalizeJobId(item?.jobId);
      if (id) {
        set.add(id);
      }
    }
    return set;
  }, [queuedJobs]);

  return (
    <div className="page-grid">
      <Toast ref={toastRef} />

      <Card title="Hardware Monitoring" subTitle="CPU (inkl. Temperatur), RAM, GPU und freier Speicher in den konfigurierten Pfaden.">
        <div className="hardware-monitor-head">
          <Tag
            value={monitoringState.enabled ? 'Aktiv' : 'Deaktiviert'}
            severity={monitoringState.enabled ? 'success' : 'secondary'}
          />
          <Tag value={`Intervall: ${monitoringState.intervalMs || 0} ms`} severity="info" />
          <Tag value={`Letztes Update: ${formatUpdatedAt(monitoringState.updatedAt)}`} severity="warning" />
        </div>

        {monitoringState.error ? (
          <small className="error-text">{monitoringState.error}</small>
        ) : null}

        {!monitoringState.enabled ? (
          <p>Monitoring ist deaktiviert. Aktivierung in den Settings unter Kategorie "Monitoring".</p>
        ) : !monitoringSample ? (
          <p>Monitoring ist aktiv. Erste Messwerte werden gesammelt ...</p>
        ) : (
          <div className="hardware-monitor-grid">
            <section className="hardware-monitor-block">
              <h4>CPU</h4>
              <div className="hardware-cpu-summary">
                <div className="hardware-cpu-chip" title="CPU Gesamtauslastung">
                  <i className="pi pi-chart-line" />
                  <span>{formatPercent(cpuMetrics?.overallUsagePercent)}</span>
                </div>
                <div className="hardware-cpu-chip" title="CPU Gesamttemperatur">
                  <i className="pi pi-bolt" />
                  <span>{formatTemperature(cpuMetrics?.overallTemperatureC)}</span>
                </div>
                <div className="hardware-cpu-load-group">
                  <div className="hardware-cpu-chip" title="CPU Load Average">
                    <i className="pi pi-chart-bar" />
                    <span>{Array.isArray(cpuMetrics?.loadAverage) ? cpuMetrics.loadAverage.join(' / ') : '-'}</span>
                  </div>
                  {cpuPerCoreMetrics.length > 0 ? (
                    <button
                      type="button"
                      className="hardware-cpu-core-toggle-btn"
                      onClick={() => setCpuCoresExpanded((prev) => !prev)}
                      aria-label={cpuCoresExpanded ? 'CPU-Kerne ausblenden' : 'CPU-Kerne einblenden'}
                      aria-expanded={cpuCoresExpanded}
                    >
                      <i className={`pi ${cpuCoresExpanded ? 'pi-angle-up' : 'pi-angle-down'}`} />
                    </button>
                  ) : null}
                </div>
              </div>
              {cpuPerCoreMetrics.length === 0 ? (
                <small>Pro-Core-Daten sind noch nicht verfuegbar.</small>
              ) : null}
              {cpuPerCoreMetrics.length > 0 && cpuCoresExpanded ? (
                <div className="hardware-core-grid compact">
                  {cpuPerCoreMetrics.map((core) => (
                    <div key={`core-${core.index}`} className="hardware-core-item compact">
                      <div className="hardware-core-title">C{core.index}</div>
                      <div className="hardware-core-metric" title="Auslastung">
                        <i className="pi pi-chart-line" />
                        <small>{formatPercent(core.usagePercent)}</small>
                      </div>
                      <div className="hardware-core-metric" title="Temperatur">
                        <i className="pi pi-bolt" />
                        <small>{formatTemperature(core.temperatureC)}</small>
                      </div>
                    </div>
                  ))}
                </div>
              ) : null}
            </section>

            <section className="hardware-monitor-block">
              <h4>RAM</h4>
              <div className="hardware-cpu-summary">
                <div className="hardware-cpu-chip" title="RAM Auslastung">
                  <i className="pi pi-chart-pie" />
                  <span>{formatPercent(memoryMetrics?.usagePercent)}</span>
                </div>
                <div className="hardware-cpu-chip" title="RAM Belegt">
                  <i className="pi pi-arrow-up" />
                  <span>{formatBytes(memoryMetrics?.usedBytes)}</span>
                </div>
                <div className="hardware-cpu-chip" title="RAM Frei">
                  <i className="pi pi-arrow-down" />
                  <span>{formatBytes(memoryMetrics?.freeBytes)}</span>
                </div>
                <div className="hardware-cpu-chip" title="RAM Gesamt">
                  <i className="pi pi-database" />
                  <span>{formatBytes(memoryMetrics?.totalBytes)}</span>
                </div>
              </div>
            </section>

            <section className="hardware-monitor-block">
              <h4>GPU</h4>
              {!gpuMetrics?.available ? (
                <small>{gpuMetrics?.message || 'Keine GPU-Metriken verfuegbar.'}</small>
              ) : (
                <div className="hardware-gpu-list">
                  {gpuDevices.map((gpu, index) => (
                    <div key={`gpu-${gpu?.index ?? index}`} className="hardware-gpu-item">
                      <strong>
                        GPU {gpu?.index ?? index}
                        {gpu?.name ? ` | ${gpu.name}` : ''}
                      </strong>
                      <small>Load: {formatPercent(gpu?.utilizationPercent)}</small>
                      <small>Mem-Load: {formatPercent(gpu?.memoryUtilizationPercent)}</small>
                      <small>Temp: {formatTemperature(gpu?.temperatureC)}</small>
                      <small>VRAM: {formatBytes(gpu?.memoryUsedBytes)} / {formatBytes(gpu?.memoryTotalBytes)}</small>
                      <small>Power: {Number.isFinite(Number(gpu?.powerDrawW)) ? `${gpu.powerDrawW} W` : 'n/a'} / {Number.isFinite(Number(gpu?.powerLimitW)) ? `${gpu.powerLimitW} W` : 'n/a'}</small>
                    </div>
                  ))}
                </div>
              )}
            </section>

            <section className="hardware-monitor-block">
              <h4>Freier Speicher in Pfaden</h4>
              <div className="hardware-storage-list">
                {storageGroups.map((group) => {
                  const rep = group.representative;
                  const tone = getStorageUsageTone(rep?.usagePercent);
                  const usagePercent = Number(rep?.usagePercent);
                  const barValue = Number.isFinite(usagePercent)
                    ? Math.max(0, Math.min(100, usagePercent))
                    : 0;
                  const hasError = group.entries.every((e) => e?.error);
                  const groupKey = group.mountPoint || group.entries.map((e) => e?.key).join('-');
                  return (
                    <div
                      key={`storage-group-${groupKey}`}
                      className={`hardware-storage-item compact${hasError ? ' has-error' : ''}`}
                    >
                      <div className="hardware-storage-head">
                        <strong>{group.entries.map((e) => e?.label || e?.key || 'Pfad').join(' · ')}</strong>
                        <span className={`hardware-storage-percent tone-${tone}`}>
                          {hasError ? 'Fehler' : formatPercent(rep?.usagePercent)}
                        </span>
                      </div>

                      {hasError ? (
                        <small className="error-text">{rep?.error}</small>
                      ) : (
                        <>
                          <div className={`hardware-storage-bar tone-${tone}`}>
                            <ProgressBar value={barValue} showValue={false} />
                          </div>
                          <div className="hardware-storage-summary">
                            <small>Frei: {formatBytes(rep?.freeBytes)}</small>
                            <small>Gesamt: {formatBytes(rep?.totalBytes)}</small>
                          </div>
                        </>
                      )}

                      {group.entries.map((entry) => (
                        <div key={entry?.key} className="hardware-storage-paths">
                          <small className="hardware-storage-label-tag">{entry?.label || entry?.key}:</small>
                          <small className="hardware-storage-path" title={entry?.path || '-'}>
                            {entry?.path || '-'}
                          </small>
                          {entry?.queryPath && entry.queryPath !== entry.path ? (
                            <small className="hardware-storage-path" title={entry.queryPath}>
                              (Parent: {entry.queryPath})
                            </small>
                          ) : null}
                          {entry?.note ? <small className="hardware-storage-path">{entry.note}</small> : null}
                        </div>
                      ))}
                    </div>
                  );
                })}
              </div>
            </section>
          </div>
        )}
      </Card>

      <Card title="Job Queue" subTitle="Starts werden nach Parallel-Limit abgearbeitet. Queue-Elemente können per Drag-and-Drop umsortiert werden.">
        <div className="pipeline-queue-meta">
          <Tag value={`Parallel: ${queueState?.maxParallelJobs || 1}`} severity="info" />
          <Tag value={`Laufend: ${queueState?.runningCount || 0}`} severity={queueRunningJobs.length > 0 ? 'warning' : 'success'} />
          <Tag value={`Wartend: ${queueState?.queuedCount || 0}`} severity={queuedJobs.length > 0 ? 'warning' : 'success'} />
        </div>

        <div className="pipeline-queue-grid">
          <div className="pipeline-queue-col">
            <h4>Laufende Jobs</h4>
            {queueRunningJobs.length === 0 ? (
              <small>Keine laufenden Jobs.</small>
            ) : (
              queueRunningJobs.map((item) => (
                <div key={`running-${item.jobId}`} className="pipeline-queue-item running">
                  <strong>#{item.jobId} | {item.title || `Job #${item.jobId}`}</strong>
                  <small>{getStatusLabel(item.status)}</small>
                </div>
              ))
            )}
          </div>
          <div className="pipeline-queue-col">
            <div className="pipeline-queue-col-header">
              <h4>Warteschlange</h4>
              <button
                type="button"
                className="queue-add-entry-btn"
                title="Skript, Kette oder Wartezeit zur Queue hinzufügen"
                onClick={() => void openInsertQueueDialog(null)}
              >
                <i className="pi pi-plus" /> Hinzufügen
              </button>
            </div>
            {queuedJobs.length === 0 ? (
              <small className="queue-empty-hint">Queue ist leer.</small>
            ) : (
              <>
                {queuedJobs.map((item) => {
                  const entryId = Number(item?.entryId);
                  const isNonJob = item.type && item.type !== 'job';
                  const isDragging = Number(draggingQueueEntryId) === entryId;
                  return (
                    <div key={`queued-entry-${entryId}`} className="pipeline-queue-entry-wrap">
                      <div
                        className={`pipeline-queue-item queued${isDragging ? ' dragging' : ''}${isNonJob ? ' non-job' : ''}`}
                        draggable={canReorderQueue}
                        onDragStart={() => setDraggingQueueEntryId(entryId)}
                        onDragEnter={() => handleQueueDragEnter(entryId)}
                        onDragOver={(event) => event.preventDefault()}
                        onDrop={(event) => {
                          event.preventDefault();
                          void handleQueueDrop();
                        }}
                        onDragEnd={() => {
                          setDraggingQueueEntryId(null);
                          void syncQueueFromServer();
                        }}
                      >
                        <span className={`pipeline-queue-drag-handle${canReorderQueue ? '' : ' disabled'}`} title="Reihenfolge ändern">
                          <i className="pi pi-bars" />
                        </span>
                        <i className={`pipeline-queue-type-icon ${queueEntryIcon(item.type)}`} title={item.type || 'job'} />
                        <div className="pipeline-queue-item-main">
                          {isNonJob ? (
                            <strong>{item.position || '-'}. {queueEntryLabel(item)}</strong>
                          ) : (
                            <>
                              <strong>
                                {item.position || '-'} | #{item.jobId} | {item.title || `Job #${item.jobId}`}
                                {item.hasScripts ? <i className="pi pi-code queue-job-tag" title="Skripte hinterlegt" /> : null}
                                {item.hasChains ? <i className="pi pi-link queue-job-tag" title="Skriptketten hinterlegt" /> : null}
                              </strong>
                              <small>{item.actionLabel || item.action || '-'} | {getStatusLabel(item.status)}</small>
                            </>
                          )}
                        </div>
                        <Button
                          icon="pi pi-times"
                          severity="danger"
                          text
                          rounded
                          size="small"
                          className="pipeline-queue-remove-btn"
                          disabled={queueReorderBusy}
                          onClick={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            if (isNonJob) {
                              void handleRemoveQueueEntry(entryId);
                            } else {
                              void handleRemoveQueuedJob(item.jobId);
                            }
                          }}
                        />
                      </div>
                      <button
                        type="button"
                        className="queue-insert-btn"
                        title="Eintrag danach einfügen"
                        onClick={() => void openInsertQueueDialog(entryId)}
                      >
                        <i className="pi pi-plus" />
                      </button>
                    </div>
                  );
                })}
              </>
            )}
          </div>
        </div>
      </Card>

      <Card title="Job Übersicht" subTitle="Kompakte Liste; Klick auf Zeile öffnet die volle Job-Detailansicht mit passenden CTAs">
        {jobsLoading ? (
          <p>Jobs werden geladen ...</p>
        ) : dashboardJobs.length === 0 ? (
          <p>Keine relevanten Jobs im Dashboard (aktive/fortsetzbare Status).</p>
        ) : (
          <div className="dashboard-job-list">
            {dashboardJobs.map((job) => {
              const jobId = normalizeJobId(job?.id);
              if (!jobId) {
                return null;
              }
              const normalizedStatus = normalizeStatus(job?.status);
              const isQueued = queuedJobIdSet.has(jobId);
              const statusBadgeValue = getStatusLabel(job?.status, { queued: isQueued });
              const statusBadgeSeverity = getStatusSeverity(normalizedStatus, { queued: isQueued });
              const isExpanded = normalizeJobId(expandedJobId) === jobId;
              const isCurrentSession = currentPipelineJobId === jobId && state !== 'IDLE';
              const isResumable = normalizedStatus === 'READY_TO_ENCODE' && !isCurrentSession;
              const reviewConfirmed = Boolean(Number(job?.encode_review_confirmed || 0));
              const pipelineForJob = pipelineByJobId.get(jobId) || pipeline;
              const jobTitle = job?.title || job?.detected_title || `Job #${jobId}`;
              const mediaIndicator = mediaIndicatorMeta(job);
              const rawProgress = Number(pipelineForJob?.progress ?? 0);
              const clampedProgress = Number.isFinite(rawProgress)
                ? Math.max(0, Math.min(100, rawProgress))
                : 0;
              const progressLabel = `${Math.round(clampedProgress)}%`;
              const etaLabel = String(pipelineForJob?.eta || '').trim();

              if (isExpanded) {
                return (
                  <div key={jobId} className="dashboard-job-expanded">
                    <div className="dashboard-job-expanded-head">
                      <div className="dashboard-job-expanded-title">
                        <strong className="dashboard-job-title-line">
                          <img
                            src={mediaIndicator.src}
                            alt={mediaIndicator.alt}
                            title={mediaIndicator.title}
                            className="media-indicator-icon"
                          />
                          <span>#{jobId} | {jobTitle}</span>
                        </strong>
                        <div className="dashboard-job-badges">
                          <Tag value={statusBadgeValue} severity={statusBadgeSeverity} />
                          {isCurrentSession ? <Tag value="Aktive Session" severity="info" /> : null}
                          {isResumable ? <Tag value="Fortsetzbar" severity="success" /> : null}
                          {normalizedStatus === 'READY_TO_ENCODE'
                            ? <Tag value={reviewConfirmed ? 'Review bestätigt' : 'Review offen'} severity={reviewConfirmed ? 'success' : 'warning'} />
                            : null}
                          <JobStepChecks backupSuccess={Boolean(job?.backupSuccess)} encodeSuccess={Boolean(job?.encodeSuccess)} />
                        </div>
                      </div>
                      <Button
                        label="Einklappen"
                        icon="pi pi-angle-up"
                        severity="secondary"
                        outlined
                        onClick={() => setExpandedJobId(null)}
                        disabled={busy}
                      />
                    </div>
                    <PipelineStatusCard
                      pipeline={pipelineForJob}
                      onAnalyze={handleAnalyze}
                      onReanalyze={handleReanalyze}
                      onOpenMetadata={handleOpenMetadataDialog}
                      onStart={handleStartJob}
                      onRestartEncode={handleRestartEncodeWithLastSettings}
                      onRestartReview={handleRestartReviewFromRaw}
                      onConfirmReview={handleConfirmReview}
                      onSelectPlaylist={handleSelectPlaylist}
                      onCancel={handleCancel}
                      onRetry={handleRetry}
                      onRemoveFromQueue={handleRemoveQueuedJob}
                      isQueued={isQueued}
                      busy={busy}
                      liveJobLog={isCurrentSession ? liveJobLog : ''}
                    />
                  </div>
                );
              }

              return (
                <button
                  key={jobId}
                  type="button"
                  className="dashboard-job-row"
                  onClick={() => setExpandedJobId(jobId)}
                >
                  {job?.poster_url && job.poster_url !== 'N/A' ? (
                    <img src={job.poster_url} alt={jobTitle} className="poster-thumb" />
                  ) : (
                    <div className="poster-thumb dashboard-job-poster-fallback">Kein Poster</div>
                  )}
                  <div className="dashboard-job-row-content">
                    <div className="dashboard-job-row-main">
                      <strong className="dashboard-job-title-line">
                        <img
                          src={mediaIndicator.src}
                          alt={mediaIndicator.alt}
                          title={mediaIndicator.title}
                          className="media-indicator-icon"
                        />
                        <span>{jobTitle}</span>
                      </strong>
                      <small>
                        #{jobId}
                        {job?.year ? ` | ${job.year}` : ''}
                        {job?.imdb_id ? ` | ${job.imdb_id}` : ''}
                      </small>
                    </div>
                    <div className="dashboard-job-badges">
                      <Tag value={statusBadgeValue} severity={statusBadgeSeverity} />
                      {isCurrentSession ? <Tag value="Aktive Session" severity="info" /> : null}
                      {isResumable ? <Tag value="Fortsetzbar" severity="success" /> : null}
                      {normalizedStatus === 'READY_TO_ENCODE'
                        ? <Tag value={reviewConfirmed ? 'Bestätigt' : 'Unbestätigt'} severity={reviewConfirmed ? 'success' : 'warning'} />
                        : null}
                      <JobStepChecks backupSuccess={Boolean(job?.backupSuccess)} encodeSuccess={Boolean(job?.encodeSuccess)} />
                    </div>
                    <div className="dashboard-job-row-progress" aria-label={`Job Fortschritt ${progressLabel}`}>
                      <ProgressBar value={clampedProgress} showValue={false} />
                      <small>{etaLabel ? `${progressLabel} | ETA ${etaLabel}` : progressLabel}</small>
                    </div>
                  </div>
                  <i className="pi pi-angle-down" aria-hidden="true" />
                </button>
              );
            })}
          </div>
        )}
      </Card>

      <Card title="Disk-Information">
        <div className="actions-row">
          <Button
            label="Laufwerk neu lesen"
            icon="pi pi-refresh"
            severity="secondary"
            onClick={handleRescan}
            loading={busy}
          />
          <Button
            label="Disk neu analysieren"
            icon="pi pi-search"
            severity="warning"
            onClick={handleReanalyze}
            loading={busy}
            disabled={!canReanalyze}
          />
          <Button
            label="Metadaten-Modal öffnen"
            icon="pi pi-list"
            onClick={() => handleOpenMetadataDialog()}
            disabled={!canOpenMetadataModal}
          />
        </div>
        {device ? (
          <div className="device-meta">
            <div>
              <strong>Pfad:</strong> {device.path || '-'}
            </div>
            <div>
              <strong>Modell:</strong> {device.model || '-'}
            </div>
            <div>
              <strong>Disk-Label:</strong> {device.discLabel || '-'}
            </div>
            <div>
              <strong>Laufwerks-Label:</strong> {device.label || '-'}
            </div>
            <div>
              <strong>Mount:</strong> {device.mountpoint || '-'}
            </div>
          </div>
        ) : (
          <p>Aktuell keine Disk erkannt.</p>
        )}
      </Card>

      <MetadataSelectionDialog
        visible={metadataDialogVisible}
        context={effectiveMetadataDialogContext}
        onHide={() => {
          setMetadataDialogVisible(false);
          setMetadataDialogContext(null);
        }}
        onSubmit={handleMetadataSubmit}
        onSearch={handleOmdbSearch}
        busy={busy}
      />

      <Dialog
        header={cancelCleanupDialog?.target === 'raw' ? 'Rip abgebrochen' : 'Encode abgebrochen'}
        visible={Boolean(cancelCleanupDialog.visible)}
        onHide={() => setCancelCleanupDialog({ visible: false, jobId: null, target: null, path: null })}
        style={{ width: '32rem', maxWidth: '96vw' }}
        modal
      >
        <p>
          {cancelCleanupDialog?.target === 'raw'
            ? 'Soll der bisher erzeugte RAW-Ordner gelöscht werden?'
            : 'Soll die bisher erzeugte Movie-Datei inklusive Job-Ordner im Ausgabeverzeichnis gelöscht werden?'}
        </p>
        {cancelCleanupDialog?.path ? (
          <small className="muted-inline">
            {cancelCleanupDialog?.target === 'raw' ? 'RAW-Pfad' : 'Output-Pfad'}: {cancelCleanupDialog.path}
          </small>
        ) : null}
        <div className="dialog-actions">
          <Button
            label="Behalten"
            severity="secondary"
            outlined
            onClick={() => setCancelCleanupDialog({ visible: false, jobId: null, target: null, path: null })}
            disabled={cancelCleanupBusy}
          />
          <Button
            label={cancelCleanupDialog?.target === 'raw' ? 'RAW löschen' : 'Movie löschen'}
            icon="pi pi-trash"
            severity="danger"
            onClick={handleDeleteCancelledOutput}
            loading={cancelCleanupBusy}
          />
        </div>
      </Dialog>

      <Dialog
        header="Queue-Eintrag einfügen"
        visible={insertQueueDialog.visible}
        onHide={() => setInsertQueueDialog({ visible: false, afterEntryId: null })}
        style={{ width: '28rem', maxWidth: '96vw' }}
        modal
      >
        <div className="queue-insert-dialog-body">
          <p className="queue-insert-dialog-hint">
            {insertQueueDialog.afterEntryId
              ? 'Eintrag wird nach dem ausgewählten Element eingefügt.'
              : 'Eintrag wird am Ende der Queue eingefügt.'}
          </p>

          {queueCatalog.scripts.length > 0 ? (
            <div className="queue-insert-section">
              <strong><i className="pi pi-code" /> Skript</strong>
              <div className="queue-insert-options">
                {queueCatalog.scripts.map((script) => (
                  <button
                    key={`qi-script-${script.id}`}
                    type="button"
                    className="queue-insert-option"
                    onClick={() => void handleAddQueueEntry('script', { scriptId: script.id })}
                  >
                    {script.name}
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          {queueCatalog.chains.length > 0 ? (
            <div className="queue-insert-section">
              <strong><i className="pi pi-link" /> Skriptkette</strong>
              <div className="queue-insert-options">
                {queueCatalog.chains.map((chain) => (
                  <button
                    key={`qi-chain-${chain.id}`}
                    type="button"
                    className="queue-insert-option"
                    onClick={() => void handleAddQueueEntry('chain', { chainId: chain.id })}
                  >
                    {chain.name}
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          <div className="queue-insert-section">
            <strong><i className="pi pi-clock" /> Warten</strong>
            <div className="queue-insert-wait-row">
              <InputNumber
                value={insertWaitSeconds}
                onValueChange={(e) => setInsertWaitSeconds(e.value ?? 30)}
                min={1}
                max={3600}
                suffix="s"
                style={{ width: '7rem' }}
              />
              <Button
                label="Einfügen"
                icon="pi pi-check"
                onClick={() => void handleAddQueueEntry('wait', { waitSeconds: insertWaitSeconds })}
              />
            </div>
          </div>

          {queueCatalog.scripts.length === 0 && queueCatalog.chains.length === 0 ? (
            <small className="muted-inline">Keine Skripte oder Ketten konfiguriert. In den Settings anlegen.</small>
          ) : null}
        </div>
      </Dialog>
    </div>
  );
}
