import { useEffect, useState } from 'react';
import { Routes, Route, useLocation, useNavigate } from 'react-router-dom';
import { Button } from 'primereact/button';
import { ProgressBar } from 'primereact/progressbar';
import { Tag } from 'primereact/tag';
import { api } from './api/client';
import { useWebSocket } from './hooks/useWebSocket';
import DashboardPage from './pages/DashboardPage';
import SettingsPage from './pages/SettingsPage';
import HistoryPage from './pages/HistoryPage';
import DatabasePage from './pages/DatabasePage';

function normalizeJobId(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return Math.trunc(parsed);
}

function clampPercent(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return 0;
  }
  return Math.max(0, Math.min(100, parsed));
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
    startedAt: null,
    finishedAt: null
  };
}

function getAudiobookUploadTagMeta(phase) {
  const normalized = String(phase || '').trim().toLowerCase();
  if (normalized === 'uploading') {
    return { label: 'Upload läuft', severity: 'warning' };
  }
  if (normalized === 'processing') {
    return { label: 'Server verarbeitet', severity: 'info' };
  }
  if (normalized === 'completed') {
    return { label: 'Bereit', severity: 'success' };
  }
  if (normalized === 'error') {
    return { label: 'Fehler', severity: 'danger' };
  }
  return { label: 'Inaktiv', severity: 'secondary' };
}

function App() {
  const appVersion = __APP_VERSION__;
  const [pipeline, setPipeline] = useState({ state: 'IDLE', progress: 0, context: {} });
  const [hardwareMonitoring, setHardwareMonitoring] = useState(null);
  const [lastDiscEvent, setLastDiscEvent] = useState(null);
  const [audiobookUpload, setAudiobookUpload] = useState(() => createInitialAudiobookUploadState());
  const [dashboardJobsRefreshToken, setDashboardJobsRefreshToken] = useState(0);
  const [pendingDashboardJobId, setPendingDashboardJobId] = useState(null);
  const location = useLocation();
  const navigate = useNavigate();

  const refreshPipeline = async () => {
    const response = await api.getPipelineState();
    setPipeline(response.pipeline);
    setHardwareMonitoring(response?.hardwareMonitoring || null);
    return response;
  };

  const clearAudiobookUpload = () => {
    setAudiobookUpload(createInitialAudiobookUploadState());
  };

  const handleAudiobookUpload = async (file, payload = {}) => {
    if (!file) {
      throw new Error('Bitte zuerst eine AAX-Datei auswählen.');
    }

    const fallbackTotalBytes = Number.isFinite(Number(file.size)) && Number(file.size) > 0
      ? Number(file.size)
      : 0;

    setAudiobookUpload({
      phase: 'uploading',
      fileName: String(file.name || '').trim() || 'upload.aax',
      loadedBytes: 0,
      totalBytes: fallbackTotalBytes,
      progressPercent: 0,
      statusText: 'AAX-Datei wird hochgeladen ...',
      errorMessage: null,
      jobId: null,
      startedAt: new Date().toISOString(),
      finishedAt: null
    });

    try {
      const response = await api.uploadAudiobook(file, payload, {
        onProgress: ({ loaded, total, percent }) => {
          const nextLoaded = Number.isFinite(Number(loaded)) && Number(loaded) >= 0
            ? Number(loaded)
            : 0;
          const nextTotal = Number.isFinite(Number(total)) && Number(total) > 0
            ? Number(total)
            : fallbackTotalBytes;
          const nextPercent = Number.isFinite(Number(percent))
            ? clampPercent(Number(percent))
            : (nextTotal > 0 ? clampPercent((nextLoaded / nextTotal) * 100) : 0);
          const transferComplete = nextTotal > 0 && nextLoaded >= nextTotal;

          setAudiobookUpload((prev) => ({
            ...prev,
            phase: transferComplete ? 'processing' : 'uploading',
            loadedBytes: nextLoaded,
            totalBytes: nextTotal,
            progressPercent: nextPercent,
            statusText: transferComplete
              ? 'Upload abgeschlossen, AAX wird serverseitig verarbeitet ...'
              : 'AAX-Datei wird hochgeladen ...'
          }));
        }
      });

      const uploadedJobId = normalizeJobId(response?.result?.jobId);
      await refreshPipeline().catch(() => null);
      setDashboardJobsRefreshToken((prev) => prev + 1);
      if (uploadedJobId) {
        setPendingDashboardJobId(uploadedJobId);
      }

      setAudiobookUpload((prev) => ({
        ...prev,
        phase: 'completed',
        loadedBytes: prev.totalBytes || prev.loadedBytes || fallbackTotalBytes,
        totalBytes: prev.totalBytes || fallbackTotalBytes,
        progressPercent: 100,
        statusText: uploadedJobId
          ? `Upload abgeschlossen. Job #${uploadedJobId} ist bereit fuer den naechsten Schritt.`
          : 'Upload abgeschlossen.',
        errorMessage: null,
        jobId: uploadedJobId,
        finishedAt: new Date().toISOString()
      }));

      return response;
    } catch (error) {
      setAudiobookUpload((prev) => ({
        ...prev,
        phase: 'error',
        errorMessage: error?.message || 'Upload fehlgeschlagen.',
        statusText: error?.message || 'Upload fehlgeschlagen.',
        finishedAt: new Date().toISOString()
      }));
      throw error;
    }
  };

  const handleDashboardJobFocusConsumed = (jobId) => {
    const normalizedJobId = normalizeJobId(jobId);
    if (!normalizedJobId) {
      return;
    }
    setPendingDashboardJobId((prev) => (
      normalizeJobId(prev) === normalizedJobId ? null : prev
    ));
  };

  useEffect(() => {
    refreshPipeline().catch(() => null);
  }, []);

  useWebSocket({
    onMessage: (message) => {
      if (message.type === 'PIPELINE_STATE_CHANGED') {
        setPipeline(message.payload);
      }

      if (message.type === 'PIPELINE_PROGRESS') {
        const payload = message.payload;
        const progressJobId = payload?.activeJobId;
        const contextPatch = payload?.contextPatch && typeof payload.contextPatch === 'object'
          ? payload.contextPatch
          : null;
        setPipeline((prev) => {
          const next = { ...prev };
          if (progressJobId != null) {
            const previousJobProgress = prev?.jobProgress?.[progressJobId] || {};
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
                state: payload.state,
                progress: payload.progress,
                eta: payload.eta,
                statusText: payload.statusText,
                ...(mergedJobContext !== undefined ? { context: mergedJobContext } : {})
              }
            };
          }
          if (progressJobId === prev?.activeJobId || progressJobId == null) {
            next.state = payload.state ?? prev?.state;
            next.progress = payload.progress ?? prev?.progress;
            next.eta = payload.eta ?? prev?.eta;
            next.statusText = payload.statusText ?? prev?.statusText;
            if (contextPatch) {
              next.context = {
                ...(prev?.context && typeof prev.context === 'object' ? prev.context : {}),
                ...contextPatch
              };
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
      }

      if (message.type === 'DISC_DETECTED') {
        setLastDiscEvent(message.payload?.device || null);
      }

      if (message.type === 'DISC_REMOVED') {
        setLastDiscEvent(null);
      }

      if (message.type === 'HARDWARE_MONITOR_UPDATE') {
        setHardwareMonitoring(message.payload || null);
      }
    }
  });

  const nav = [
    { label: 'Dashboard', path: '/' },
    { label: 'Settings', path: '/settings' },
    { label: 'Historie', path: '/history' }
  ];
  const uploadPhase = String(audiobookUpload?.phase || 'idle').trim().toLowerCase();
  const showAudiobookUploadBanner = uploadPhase !== 'idle';
  const uploadProgress = clampPercent(audiobookUpload?.progressPercent);
  const uploadTagMeta = getAudiobookUploadTagMeta(uploadPhase);
  const uploadLoadedBytes = Number(audiobookUpload?.loadedBytes || 0);
  const uploadTotalBytes = Number(audiobookUpload?.totalBytes || 0);
  const uploadBytesLabel = uploadTotalBytes > 0
    ? `${formatBytes(uploadLoadedBytes)} / ${formatBytes(uploadTotalBytes)}`
    : (uploadLoadedBytes > 0 ? `${formatBytes(uploadLoadedBytes)} hochgeladen` : null);
  const canDismissUploadBanner = uploadPhase === 'completed' || uploadPhase === 'error';
  const hasUploadedJob = Boolean(normalizeJobId(audiobookUpload?.jobId));
  const isDashboardRoute = location.pathname === '/';

  return (
    <div className="app-shell">
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
              className={location.pathname === item.path ? 'nav-btn nav-btn-active' : 'nav-btn'}
              outlined={location.pathname !== item.path}
            />
          ))}
        </div>
      </header>

      {showAudiobookUploadBanner ? (
        <section className={`app-upload-banner phase-${uploadPhase}`}>
          <div className="app-upload-banner-copy">
            <div className="app-upload-banner-head">
              <strong>Audiobook Upload</strong>
              <Tag value={uploadTagMeta.label} severity={uploadTagMeta.severity} />
            </div>
            <small>{audiobookUpload?.statusText || 'Upload aktiv.'}</small>
            {audiobookUpload?.fileName ? <small>Datei: {audiobookUpload.fileName}</small> : null}
          </div>

          <div
            className="app-upload-banner-progress"
            aria-label={`Audiobook Upload ${Math.round(uploadProgress)} Prozent`}
          >
            <ProgressBar value={uploadProgress} showValue={false} />
            <small>
              {uploadPhase === 'processing'
                ? `100% | ${uploadBytesLabel || 'Upload abgeschlossen'}`
                : uploadBytesLabel
                  ? `${Math.round(uploadProgress)}% | ${uploadBytesLabel}`
                  : `${Math.round(uploadProgress)}%`}
            </small>
          </div>

          <div className="app-upload-banner-actions">
            {hasUploadedJob && !isDashboardRoute ? (
              <Button
                label="Zum Dashboard"
                icon="pi pi-arrow-right"
                severity="secondary"
                outlined
                onClick={() => {
                  const targetJobId = normalizeJobId(audiobookUpload?.jobId);
                  if (targetJobId) {
                    setPendingDashboardJobId(targetJobId);
                  }
                  navigate('/');
                }}
              />
            ) : null}
            {canDismissUploadBanner ? (
              <Button
                icon="pi pi-times"
                rounded
                text
                severity="secondary"
                aria-label="Upload-Hinweis schliessen"
                onClick={clearAudiobookUpload}
              />
            ) : null}
          </div>
        </section>
      ) : null}

      <main className="app-main">
        <Routes>
          <Route
            path="/"
            element={
              <DashboardPage
                pipeline={pipeline}
                hardwareMonitoring={hardwareMonitoring}
                lastDiscEvent={lastDiscEvent}
                refreshPipeline={refreshPipeline}
                audiobookUpload={audiobookUpload}
                onAudiobookUpload={handleAudiobookUpload}
                jobsRefreshToken={dashboardJobsRefreshToken}
                pendingExpandedJobId={pendingDashboardJobId}
                onPendingExpandedJobHandled={handleDashboardJobFocusConsumed}
              />
            }
          />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/history" element={<HistoryPage />} />
          <Route path="/database" element={<DatabasePage />} />
        </Routes>
      </main>
    </div>
  );
}

export default App;
