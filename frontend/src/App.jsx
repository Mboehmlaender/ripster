// SPDX-License-Identifier: GPL-2.0-or-later

import { useEffect, useRef, useState } from 'react';
import { Navigate, Outlet, Routes, Route, useLocation, useNavigate } from 'react-router-dom';
import { Button } from 'primereact/button';
import { Toast } from 'primereact/toast';
import { ConfirmDialog } from 'primereact/confirmdialog';
import { api } from './api/client';
import { useWebSocket } from './hooks/useWebSocket';
import RipperPage from './pages/RipperPage';
import SettingsPage from './pages/SettingsPage';
import HistoryPage from './pages/HistoryPage';
import DatabasePage from './pages/DatabasePage';
import DownloadsPage from './pages/DownloadsPage';
import ConverterPage from './pages/ConverterPage';
import AudiobooksPage from './pages/AudiobooksPage';
import TmdbMigrationPage from './pages/TmdbMigrationPage';
import HardwarePage from './pages/HardwarePage';

function normalizeJobId(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return Math.trunc(parsed);
}

function extractUploadJobIdFromResponse(response) {
  const payload = response && typeof response === 'object' ? response : {};
  const result = payload?.result && typeof payload.result === 'object' ? payload.result : {};
  return (
    normalizeJobId(result?.jobId)
    || normalizeJobId(payload?.jobId)
    || normalizeJobId(result?.id)
    || normalizeJobId(payload?.id)
    || normalizeJobId(result?.job?.id)
    || normalizeJobId(payload?.job?.id)
    || null
  );
}

function clampPercent(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return 0;
  }
  return Math.max(0, Math.min(100, parsed));
}

function normalizeStage(value) {
  return String(value || '').trim().toUpperCase();
}

function isRunningStage(value) {
  const normalized = normalizeStage(value);
  return normalized === 'ANALYZING'
    || normalized === 'RIPPING'
    || normalized === 'MEDIAINFO_CHECK'
    || normalized === 'ENCODING'
    || normalized === 'CD_ANALYZING'
    || normalized === 'CD_RIPPING'
    || normalized === 'CD_ENCODING';
}

function isTerminalStage(value) {
  const normalized = normalizeStage(value);
  return normalized === 'FINISHED' || normalized === 'ERROR' || normalized === 'CANCELLED';
}

function isInteractiveReviewStage(value) {
  const normalized = normalizeStage(value);
  return normalized === 'METADATA_LOOKUP'
    || normalized === 'METADATA_SELECTION'
    || normalized === 'WAITING_FOR_USER_DECISION'
    || normalized === 'READY_TO_ENCODE';
}

function parseTimestamp(value) {
  if (!value) {
    return 0;
  }
  const ts = Date.parse(String(value));
  return Number.isFinite(ts) ? ts : 0;
}

function mergePipelineStatePreservingNewestQueue(previousPipeline, incomingPipeline) {
  const prev = previousPipeline && typeof previousPipeline === 'object' ? previousPipeline : {};
  const incoming = incomingPipeline && typeof incomingPipeline === 'object' ? incomingPipeline : {};
  const prevQueue = prev?.queue && typeof prev.queue === 'object' ? prev.queue : null;
  const incomingQueue = incoming?.queue && typeof incoming.queue === 'object' ? incoming.queue : null;
  if (!prevQueue || !incomingQueue) {
    return {
      ...prev,
      ...incoming
    };
  }
  const prevQueueTs = parseTimestamp(prevQueue.updatedAt);
  const incomingQueueTs = parseTimestamp(incomingQueue.updatedAt);
  const queue = incomingQueueTs >= prevQueueTs ? incomingQueue : prevQueue;
  return {
    ...prev,
    ...incoming,
    queue
  };
}

function createInitialAudiobookUploadState() {
  return {
    phase: 'idle',
    fileName: null,
    loadedBytes: 0,
    totalBytes: 0,
    progressPercent: 0,
    statusText: null,
    errorMessage: null,
    jobId: null,
    uploadSessionId: null,
    fileLastModified: null,
    fileFingerprint: null,
    startedAt: null,
    finishedAt: null
  };
}

function getDownloadIndicatorMeta(summary) {
  const activeCount = Number(summary?.activeCount || 0);
  const failedCount = Number(summary?.failedCount || 0);
  const totalCount = Number(summary?.totalCount || 0);

  if (activeCount > 0) {
    return {
      icon: 'pi pi-spinner pi-spin',
      label: activeCount === 1 ? '1 ZIP aktiv' : `${activeCount} ZIPs aktiv`,
      className: 'zip-status-indicator-active'
    };
  }
  if (totalCount > 0) {
    return {
      icon: 'pi pi-check',
      label: failedCount > 0 ? 'ZIP-Jobs beendet' : 'ZIPs fertig',
      className: 'zip-status-indicator-ready'
    };
  }
  return {
    icon: 'pi pi-download',
    label: 'ZIPs',
    className: 'zip-status-indicator-idle'
  };
}

const HARDWARE_MONITOR_SETTING_KEYS = new Set([
  'hardware_monitoring_enabled',
  'hardware_monitoring_interval_ms'
]);

function App() {
  const appVersion = __APP_VERSION__;
  const [pipeline, setPipeline] = useState({ state: 'IDLE', progress: 0, context: {} });
  const [hardwareMonitoring, setHardwareMonitoring] = useState(null);
  const [lastDiscEvent, setLastDiscEvent] = useState(null);
  const [expertMode, setExpertMode] = useState(false);
  const [audiobookUpload, setAudiobookUpload] = useState(() => createInitialAudiobookUploadState());
  const [ripperJobsRefreshToken, setRipperJobsRefreshToken] = useState(0);
  const [historyJobsRefreshToken, setHistoryJobsRefreshToken] = useState(0);
  const [downloadsRefreshToken, setDownloadsRefreshToken] = useState(0);
  const [downloadSummary, setDownloadSummary] = useState(null);
  const location = useLocation();
  const navigate = useNavigate();
  const globalToastRef = useRef(null);
  const prevCdDrivesRef = useRef({});
  const prevJobProgressStatesRef = useRef({});
  const hardwareWarmupRef = useRef({ timer: null, attempts: 0 });
  const audiobookUploadAbortRef = useRef(null);

  const clearHardwareWarmupRetry = () => {
    if (hardwareWarmupRef.current?.timer) {
      clearTimeout(hardwareWarmupRef.current.timer);
      hardwareWarmupRef.current.timer = null;
    }
  };

  // When a virtual CD drive is removed (CD encode/rip finished or failed),
  // or when a CD drive transitions away from an active job, force both
  // Ripper and History to re-fetch so jobs leave the live list reliably.
  useEffect(() => {
    const current = pipeline?.cdDrives || {};
    const prev = prevCdDrivesRef.current;
    const normalizeState = (value) => String(value || '').trim().toUpperCase();
    const ACTIVE_CD_STATES = new Set(['CD_ANALYZING', 'CD_METADATA_SELECTION', 'CD_READY_TO_RIP', 'CD_RIPPING', 'CD_ENCODING']);
    const TERMINAL_CD_STATES = new Set(['FINISHED', 'ERROR', 'CANCELLED']);
    let shouldRefresh = false;

    for (const [devicePath, previousDrive] of Object.entries(prev)) {
      const previousJobId = normalizeJobId(previousDrive?.jobId);
      if (!previousJobId) {
        continue;
      }
      const previousState = normalizeState(previousDrive?.state);
      const currentDrive = current?.[devicePath] || null;
      const currentJobId = normalizeJobId(currentDrive?.jobId);
      const currentState = normalizeState(currentDrive?.state);
      const driveRemoved = !currentDrive;
      const jobChanged = currentJobId !== previousJobId;
      const movedToTerminal = currentJobId === previousJobId
        && TERMINAL_CD_STATES.has(currentState)
        && currentState !== previousState;
      const leftActiveLifecycle = ACTIVE_CD_STATES.has(previousState)
        && (driveRemoved || jobChanged || !ACTIVE_CD_STATES.has(currentState));
      if (movedToTerminal || leftActiveLifecycle) {
        shouldRefresh = true;
        break;
      }
    }

    if (shouldRefresh) {
      setRipperJobsRefreshToken((t) => t + 1);
      setHistoryJobsRefreshToken((t) => t + 1);
    }
    prevCdDrivesRef.current = current;
  }, [pipeline?.cdDrives]);

  // Trigger a jobs refresh when a tracked job transitions into a terminal or
  // interactive review state through PIPELINE_PROGRESS, so Ripper/History
  // update immediately without a manual page reload.
  useEffect(() => {
    const current = pipeline?.jobProgress && typeof pipeline.jobProgress === 'object'
      ? pipeline.jobProgress
      : {};
    const previousStates = prevJobProgressStatesRef.current || {};
    const nextStates = {};
    let shouldRefresh = false;

    for (const [jobId, entry] of Object.entries(current)) {
      const currentState = normalizeStage(entry?.state);
      const previousState = normalizeStage(previousStates[jobId]);
      if (currentState) {
        nextStates[jobId] = currentState;
      }
      if (
        currentState
        && isTerminalStage(currentState)
        && currentState !== previousState
        && !isTerminalStage(previousState)
      ) {
        shouldRefresh = true;
      }
      if (
        currentState
        && isInteractiveReviewStage(currentState)
        && currentState !== previousState
      ) {
        shouldRefresh = true;
      }
    }

    prevJobProgressStatesRef.current = nextStates;
    if (shouldRefresh) {
      setRipperJobsRefreshToken((token) => token + 1);
      setHistoryJobsRefreshToken((token) => token + 1);
    }
  }, [pipeline?.jobProgress]);

  const refreshPipeline = async () => {
    const response = await api.getPipelineState();
    setPipeline(response.pipeline);
    const monitoringPayload = response?.hardwareMonitoring || null;
    setHardwareMonitoring(monitoringPayload);
    const monitoringEnabled = Boolean(monitoringPayload?.enabled);
    const hasSample = Boolean(monitoringPayload?.sample && typeof monitoringPayload.sample === 'object');
    if (monitoringEnabled && !hasSample) {
      const nextAttempts = Number(hardwareWarmupRef.current?.attempts || 0) + 1;
      hardwareWarmupRef.current.attempts = nextAttempts;
      if (nextAttempts <= 10 && !hardwareWarmupRef.current.timer) {
        hardwareWarmupRef.current.timer = setTimeout(() => {
          hardwareWarmupRef.current.timer = null;
          refreshPipeline().catch(() => null);
        }, 1000);
      }
    } else {
      hardwareWarmupRef.current.attempts = 0;
      clearHardwareWarmupRetry();
    }
    return response;
  };

  const handleAudiobookUpload = async (file, payload = {}) => {
    if (!file) {
      throw new Error('Bitte zuerst eine AAX-Datei auswählen.');
    }
    const fileName = String(file.name || '').trim() || 'upload.aax';
    const totalBytes = Number(file.size || 0);
    const abortController = new AbortController();
    audiobookUploadAbortRef.current = abortController;

    setAudiobookUpload({
      phase: 'uploading',
      fileName,
      loadedBytes: 0,
      totalBytes,
      progressPercent: 0,
      statusText: 'AAX-Datei wird hochgeladen ...',
      errorMessage: null,
      jobId: null,
      uploadSessionId: null,
      fileLastModified: Number.isFinite(Number(file.lastModified))
        ? Math.trunc(Number(file.lastModified))
        : null,
      fileFingerprint: null,
      startedAt: new Date().toISOString(),
      finishedAt: null
    });

    try {
      const response = await api.uploadAudiobook(file, payload, {
        signal: abortController.signal,
        onProgress: ({ loaded, total, percent }) => {
          const loadedBytes = Number.isFinite(Number(loaded)) ? Number(loaded) : 0;
          const totalSize = Number.isFinite(Number(total)) && Number(total) > 0 ? Number(total) : totalBytes;
          const progressPercent = Number.isFinite(Number(percent))
            ? clampPercent(Number(percent))
            : (totalSize > 0 ? clampPercent((loadedBytes / totalSize) * 100) : 0);
          setAudiobookUpload((prev) => ({
            ...prev,
            phase: 'uploading',
            loadedBytes,
            totalBytes: totalSize,
            progressPercent,
            statusText: 'AAX-Datei wird hochgeladen ...',
            errorMessage: null
          }));
        }
      });
      const uploadedJobId = extractUploadJobIdFromResponse(response);
      const started = Boolean(response?.result?.started);
      const queued = Boolean(response?.result?.queued);
      await refreshPipeline().catch(() => null);
      setRipperJobsRefreshToken((prev) => prev + 1);
      setHistoryJobsRefreshToken((prev) => prev + 1);
      setAudiobookUpload((prev) => ({
        ...prev,
        phase: 'completed',
        loadedBytes: prev.totalBytes || totalBytes,
        totalBytes: prev.totalBytes || totalBytes,
        progressPercent: 100,
        statusText: uploadedJobId
          ? (
            queued
              ? `Upload abgeschlossen. Job #${uploadedJobId} wurde in die Queue eingereiht.`
              : (started
                ? `Upload abgeschlossen. Job #${uploadedJobId} wurde gestartet.`
                : `Upload abgeschlossen. Job #${uploadedJobId} ist bereit.`)
          )
          : 'Upload abgeschlossen.',
        errorMessage: null,
        jobId: uploadedJobId,
        finishedAt: new Date().toISOString()
      }));
      return response;
    } catch (error) {
      if (error?.name === 'AbortError') {
        setAudiobookUpload(createInitialAudiobookUploadState());
        throw error;
      }
      setAudiobookUpload((prev) => ({
        ...prev,
        phase: 'error',
        errorMessage: error?.message || 'Upload fehlgeschlagen.',
        statusText: error?.message || 'Upload fehlgeschlagen.',
        finishedAt: new Date().toISOString()
      }));
      throw error;
    } finally {
      if (audiobookUploadAbortRef.current === abortController) {
        audiobookUploadAbortRef.current = null;
      }
    }
  };

  const handleCancelAudiobookUpload = () => {
    const activeAbortController = audiobookUploadAbortRef.current;
    if (activeAbortController) {
      activeAbortController.abort();
      return;
    }
    setAudiobookUpload(createInitialAudiobookUploadState());
  };

  useEffect(() => {
    refreshPipeline().catch(() => null);
    api.getDownloadsSummary()
      .then((response) => {
        setDownloadSummary(response?.summary || null);
      })
      .catch(() => null);
    api.getSettings()
      .then((response) => {
        const allSettings = (response?.categories || []).flatMap((c) => c.settings || []);
        const val = allSettings.find((s) => s.key === 'ui_expert_mode')?.value;
        setExpertMode(val === 'true' || val === true);
      })
      .catch(() => null);
    return () => {
      clearHardwareWarmupRetry();
    };
  }, []);

  useWebSocket({
    onMessage: (message) => {
      if (message.type === 'WS_CONNECTED') {
        refreshPipeline().catch(() => null);
      }

      if (message.type === 'PIPELINE_STATE_CHANGED') {
        setPipeline((prev) => mergePipelineStatePreservingNewestQueue(prev, message.payload));
        const nextState = normalizeStage(message?.payload?.state);
        if (isTerminalStage(nextState) || isInteractiveReviewStage(nextState)) {
          setRipperJobsRefreshToken((token) => token + 1);
          setHistoryJobsRefreshToken((token) => token + 1);
        }
      }

      if (message.type === 'PIPELINE_PROGRESS') {
        const payload = message.payload;
        const progressJobId = payload?.activeJobId;
        const contextPatch = payload?.contextPatch && typeof payload.contextPatch === 'object'
          ? payload.contextPatch
          : null;
        setPipeline((prev) => {
          const next = { ...prev };
          const normalizedProgressJobId = normalizeJobId(progressJobId);
          const progressStage = normalizeStage(payload?.state);
          const isCdProgressStage = progressStage === 'CD_ANALYZING'
            || progressStage === 'CD_RIPPING'
            || progressStage === 'CD_ENCODING';
          const incomingIsRunning = isRunningStage(progressStage);
          const incomingIsTerminal = isTerminalStage(progressStage);
          const prevActiveJobId = normalizeJobId(prev?.activeJobId || prev?.context?.jobId);
          const prevJobProgress = normalizedProgressJobId
            ? (prev?.jobProgress?.[normalizedProgressJobId] || null)
            : null;
          const prevJobProgressState = normalizeStage(prevJobProgress?.state);
          const prevJobProgressIsRunning = isRunningStage(prevJobProgressState);
          const prevJobProgressIsTerminal = isTerminalStage(prevJobProgressState);
          const matchingCdDriveEntry = normalizedProgressJobId
            ? Object.values(prev?.cdDrives || {}).find((driveState) => normalizeJobId(driveState?.jobId) === normalizedProgressJobId)
            : null;
          const matchingCdDriveState = normalizeStage(matchingCdDriveEntry?.state);
          const matchingCdDriveIsRunning = isRunningStage(matchingCdDriveState);
          const matchingCdDriveIsTerminal = isTerminalStage(matchingCdDriveEntry?.state);
          const previousGlobalStage = normalizeStage(prev?.state);
          const previousGlobalIsRunning = isRunningStage(previousGlobalStage);
          const previousGlobalIsTerminal = isTerminalStage(previousGlobalStage);
          const hasKnownBinding = Boolean(
            normalizedProgressJobId
            && (
              prevActiveJobId === normalizedProgressJobId
              || prevJobProgress
              || matchingCdDriveEntry
            )
          );
          const regressesStableJobState = Boolean(
            normalizedProgressJobId
            && incomingIsRunning
            && (
              (prevJobProgressState && !prevJobProgressIsRunning && !prevJobProgressIsTerminal)
              || (matchingCdDriveState && !matchingCdDriveIsRunning && !matchingCdDriveIsTerminal)
              || (
                prevActiveJobId === normalizedProgressJobId
                && previousGlobalStage
                && !previousGlobalIsRunning
                && !previousGlobalIsTerminal
              )
            )
          );
          const isUnknownRunningProgress = Boolean(
            normalizedProgressJobId
            && incomingIsRunning
            && !hasKnownBinding
          );
          const allowRunningTransitionFromTerminal = Boolean(
            normalizedProgressJobId
            && incomingIsRunning
            && prevActiveJobId === normalizedProgressJobId
          );

          // Ignore late/stale progress packets that arrive after a terminal state
          // or regress a job from an interactive/ready state back into an
          // earlier running stage because an older progress packet arrived late.
          if (
            normalizedProgressJobId
            && !incomingIsTerminal
            && !allowRunningTransitionFromTerminal
            && (
              prevJobProgressIsTerminal
              || matchingCdDriveIsTerminal
              || isUnknownRunningProgress
              || regressesStableJobState
            )
          ) {
            return prev;
          }

          if (progressJobId != null) {
            const previousJobProgress = prev?.jobProgress?.[progressJobId] || {};
            const previousJobStage = normalizeStage(previousJobProgress?.state);
            const keepPreviousJobStage = isTerminalStage(previousJobStage)
              && !incomingIsTerminal
              && !allowRunningTransitionFromTerminal;
            const mergedJobContext = contextPatch
              ? {
                ...(previousJobProgress?.context && typeof previousJobProgress.context === 'object'
                  ? previousJobProgress.context
                  : {}),
                ...contextPatch
              }
              : (previousJobProgress?.context && typeof previousJobProgress.context === 'object'
                  ? previousJobProgress.context
                  : undefined);
            next.jobProgress = {
              ...(prev?.jobProgress || {}),
              [progressJobId]: {
                ...previousJobProgress,
                state: keepPreviousJobStage ? previousJobProgress.state : payload.state,
                progress: keepPreviousJobStage ? previousJobProgress.progress : payload.progress,
                eta: keepPreviousJobStage ? previousJobProgress.eta : payload.eta,
                statusText: keepPreviousJobStage ? previousJobProgress.statusText : payload.statusText,
                ...(mergedJobContext !== undefined ? { context: mergedJobContext } : {})
              }
            };
          }
          if (progressJobId === prev?.activeJobId || progressJobId == null) {
            const keepPreviousGlobalStage = isTerminalStage(previousGlobalStage)
              && !incomingIsTerminal
              && !allowRunningTransitionFromTerminal;
            next.state = keepPreviousGlobalStage ? prev?.state : (payload.state ?? prev?.state);
            next.progress = keepPreviousGlobalStage ? prev?.progress : (payload.progress ?? prev?.progress);
            next.eta = keepPreviousGlobalStage ? prev?.eta : (payload.eta ?? prev?.eta);
            next.statusText = keepPreviousGlobalStage ? prev?.statusText : (payload.statusText ?? prev?.statusText);
            if (contextPatch) {
              next.context = {
                ...(prev?.context && typeof prev.context === 'object' ? prev.context : {}),
                ...contextPatch
              };
            }
          }

          // Keep per-drive CD progress in sync with live progress events.
          // Backend sends frequent PIPELINE_PROGRESS updates, while cdDrives
          // snapshots are only broadcast on state transitions.
          if (isCdProgressStage && prev?.cdDrives && typeof prev.cdDrives === 'object') {
            const cdDrivesEntries = Object.entries(prev.cdDrives);
            const nextCdDrives = { ...prev.cdDrives };
            const patchDrive = (driveState) => {
              const currentDriveStage = normalizeStage(driveState?.state);
              if (isTerminalStage(currentDriveStage) && !incomingIsTerminal) {
                return driveState;
              }
              const mergedContext = contextPatch
                ? {
                  ...(driveState?.context && typeof driveState.context === 'object' ? driveState.context : {}),
                  ...contextPatch
                }
                : driveState?.context;
              return {
                ...driveState,
                state: payload?.state ?? driveState?.state,
                progress: payload?.progress ?? driveState?.progress,
                eta: payload?.eta ?? driveState?.eta,
                statusText: payload?.statusText ?? driveState?.statusText,
                ...(mergedContext !== undefined ? { context: mergedContext } : {})
              };
            };

            let updated = false;
            if (normalizedProgressJobId) {
              for (const [drivePath, driveState] of cdDrivesEntries) {
                if (normalizeJobId(driveState?.jobId) === normalizedProgressJobId) {
                  nextCdDrives[drivePath] = patchDrive(driveState);
                  updated = true;
                }
              }
            }

            if (!updated) {
              const activeCdEntries = cdDrivesEntries.filter(([, driveState]) => {
                const driveStage = String(driveState?.state || '').trim().toUpperCase();
                return driveStage === 'CD_ANALYZING'
                  || driveStage === 'CD_RIPPING'
                  || driveStage === 'CD_ENCODING';
              });
              if (activeCdEntries.length === 1) {
                const [drivePath, driveState] = activeCdEntries[0];
                nextCdDrives[drivePath] = patchDrive(driveState);
                updated = true;
              }
            }

            if (updated) {
              next.cdDrives = nextCdDrives;
            }
          }

          return next;
        });
      }

      if (message.type === 'PIPELINE_QUEUE_CHANGED') {
        setPipeline((prev) => ({
          ...(prev || {}),
          queue: message.payload || null
        }));
        setRipperJobsRefreshToken((prev) => prev + 1);
        setHistoryJobsRefreshToken((prev) => prev + 1);
      }

      if (message.type === 'DISC_DETECTED') {
        setLastDiscEvent(message.payload?.device || null);
        refreshPipeline().catch(() => null);
      }

      if (message.type === 'DISC_REMOVED') {
        setLastDiscEvent(null);
      }

      if (message.type === 'HARDWARE_MONITOR_UPDATE') {
        setHardwareMonitoring(message.payload || null);
      }

      if (message.type === 'SETTINGS_UPDATED') {
        const setting = message.payload;
        if (setting?.key === 'ui_expert_mode') {
          const val = setting?.value;
          setExpertMode(val === 'true' || val === true);
        }
        const normalizedKey = String(setting?.key || '').trim().toLowerCase();
        if (HARDWARE_MONITOR_SETTING_KEYS.has(normalizedKey)) {
          refreshPipeline().catch(() => null);
        }
      }

      if (message.type === 'SETTINGS_BULK_UPDATED') {
        const keys = message.payload?.keys || [];
        const normalizedKeys = keys.map((key) => String(key || '').trim().toLowerCase());
        if (keys.includes('ui_expert_mode')) {
          api.getSettings({ forceRefresh: true })
            .then((response) => {
              const allSettings = (response?.categories || []).flatMap((c) => c.settings || []);
              const val = allSettings.find((s) => s.key === 'ui_expert_mode')?.value;
              setExpertMode(val === 'true' || val === true);
            })
            .catch(() => null);
        }
        if (normalizedKeys.some((key) => HARDWARE_MONITOR_SETTING_KEYS.has(key))) {
          refreshPipeline().catch(() => null);
        }
      }

      if (message.type === 'DOWNLOADS_UPDATED') {
        const summary = message.payload?.summary && typeof message.payload.summary === 'object'
          ? message.payload.summary
          : null;
        const reason = String(message.payload?.reason || '').trim().toLowerCase();
        const item = message.payload?.item && typeof message.payload.item === 'object'
          ? message.payload.item
          : null;

        if (summary) {
          setDownloadSummary(summary);
        }
        setDownloadsRefreshToken((prev) => prev + 1);

        if (reason === 'ready' && item) {
          globalToastRef.current?.show({
            severity: 'success',
            summary: 'ZIP fertig',
            detail: `${item.archiveName || 'ZIP-Datei'} steht jetzt auf der Downloads-Seite bereit.`,
            life: 4500
          });
        }

        if (reason === 'failed' && item) {
          globalToastRef.current?.show({
            severity: 'error',
            summary: 'ZIP fehlgeschlagen',
            detail: item.errorMessage || `${item.archiveName || 'ZIP-Datei'} konnte nicht erstellt werden.`,
            life: 5000
          });
        }
      }
    }
  });

  const nav = [
    { label: 'Ripper', path: '/ripper' },
    { label: 'Converter', path: '/converter' },
    { label: 'Audiobooks', path: '/audiobooks' },
    { label: 'Settings', path: '/settings' },
    { label: 'Historie', path: '/history' },
    { label: 'Downloads', path: '/downloads' },
    ...(expertMode ? [{ label: 'Database', path: '/database' }] : [])
  ];
  const downloadIndicator = getDownloadIndicatorMeta(downloadSummary);
  const isNavActive = (path) => {
    if (path === '/ripper') {
      return location.pathname === '/' || location.pathname === '/ripper';
    }
    return location.pathname === path;
  };

  return (
    <div className="app-shell">
      <Toast ref={globalToastRef} position="top-right" />
      <ConfirmDialog />

      <header className="app-header">
        <div className="brand-block">
          <img src="/logo.png" alt="Ripster Logo" className="brand-logo" />
          <div className="brand-copy">
            <h1>Ripster</h1>
            <div className="brand-meta">
              <p>Disc Ripping Control Center</p>
              <span className="app-version" aria-label={`Version ${appVersion}`}>
                v{appVersion}
              </span>
            </div>
          </div>
        </div>
        <div className="nav-buttons">
          {nav.map((item) => (
            <Button
              key={item.path}
              label={item.label}
              onClick={() => navigate(item.path)}
              className={isNavActive(item.path) ? 'nav-btn nav-btn-active' : 'nav-btn'}
              outlined={!isNavActive(item.path)}
            />
          ))}
        </div>
      </header>

      <main className="app-main">
        <Routes>
          <Route
            path="/"
            element={
              <RipperPage
                pipeline={pipeline}
                hardwareMonitoring={hardwareMonitoring}
                lastDiscEvent={lastDiscEvent}
                refreshPipeline={refreshPipeline}
                jobsRefreshToken={ripperJobsRefreshToken}
                downloadSummary={downloadSummary}
              >
                <Outlet />
              </RipperPage>
            }
          >
            <Route index element={<Navigate to="ripper" replace />} />
            <Route path="ripper" element={null} />
            <Route path="settings" element={<SettingsPage />} />
            <Route path="history" element={<HistoryPage refreshToken={historyJobsRefreshToken} />} />
            <Route path="tmdb-migration" element={<TmdbMigrationPage />} />
            <Route path="downloads" element={<DownloadsPage refreshToken={downloadsRefreshToken} />} />
            <Route path="database" element={<DatabasePage />} />
            <Route path="converter" element={<ConverterPage />} />
            <Route path="hardware" element={<HardwarePage hardwareMonitoring={hardwareMonitoring} />} />
            <Route
              path="audiobooks"
              element={
                <AudiobooksPage
                  audiobookUpload={audiobookUpload}
                  onAudiobookUpload={handleAudiobookUpload}
                  onCancelAudiobookUpload={handleCancelAudiobookUpload}
                />
              }
            />
          </Route>
        </Routes>
      </main>
    </div>
  );
}

export default App;
