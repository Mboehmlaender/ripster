import { useEffect, useState } from 'react';
import { Routes, Route, useLocation, useNavigate } from 'react-router-dom';
import { Button } from 'primereact/button';
import { api } from './api/client';
import { useWebSocket } from './hooks/useWebSocket';
import DashboardPage from './pages/DashboardPage';
import SettingsPage from './pages/SettingsPage';
import DatabasePage from './pages/DatabasePage';

function App() {
  const [pipeline, setPipeline] = useState({ state: 'IDLE', progress: 0, context: {} });
  const [lastDiscEvent, setLastDiscEvent] = useState(null);
  const location = useLocation();
  const navigate = useNavigate();

  const refreshPipeline = async () => {
    const response = await api.getPipelineState();
    setPipeline(response.pipeline);
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
        setPipeline((prev) => ({
          ...prev,
          ...message.payload
        }));
      }

      if (message.type === 'DISC_DETECTED') {
        setLastDiscEvent(message.payload?.device || null);
      }

      if (message.type === 'DISC_REMOVED') {
        setLastDiscEvent(null);
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
            <p>Disc Ripping Control Center</p>
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
                lastDiscEvent={lastDiscEvent}
                refreshPipeline={refreshPipeline}
              />
            }
          />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/history" element={<DatabasePage />} />
          <Route path="/database" element={<DatabasePage />} />
        </Routes>
      </main>
    </div>
  );
}

export default App;
