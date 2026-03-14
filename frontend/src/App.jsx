import { useEffect, useState } from 'react';
import { Routes, Route, useLocation, useNavigate } from 'react-router-dom';
import { Button } from 'primereact/button';
import { api } from './api/client';
import { useWebSocket } from './hooks/useWebSocket';
import DashboardPage from './pages/DashboardPage';
import SettingsPage from './pages/SettingsPage';
import HistoryPage from './pages/HistoryPage';
import DatabasePage from './pages/DatabasePage';

function App() {
  const appVersion = __APP_VERSION__;
  const [pipeline, setPipeline] = useState({ state: 'IDLE', progress: 0, context: {} });
  const [hardwareMonitoring, setHardwareMonitoring] = useState(null);
  const [lastDiscEvent, setLastDiscEvent] = useState(null);
  const location = useLocation();
  const navigate = useNavigate();

  const refreshPipeline = async () => {
    const response = await api.getPipelineState();
    setPipeline(response.pipeline);
    setHardwareMonitoring(response?.hardwareMonitoring || null);
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
          // Update per-job progress map so concurrent jobs don't overwrite each other.
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
          // Update global snapshot fields only for the primary active job.
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
