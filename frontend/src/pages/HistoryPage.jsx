import { useEffect, useMemo, useRef, useState } from 'react';
import { Card } from 'primereact/card';
import { DataTable } from 'primereact/datatable';
import { Column } from 'primereact/column';
import { InputText } from 'primereact/inputtext';
import { Dropdown } from 'primereact/dropdown';
import { Button } from 'primereact/button';
import { Tag } from 'primereact/tag';
import { Toast } from 'primereact/toast';
import { api } from '../api/client';
import JobDetailDialog from '../components/JobDetailDialog';
import blurayIndicatorIcon from '../assets/media-bluray.svg';
import discIndicatorIcon from '../assets/media-disc.svg';
import {
  getStatusLabel,
  getStatusSeverity,
  getProcessStatusLabel,
  normalizeStatus,
  STATUS_FILTER_OPTIONS
} from '../utils/statusPresentation';

function resolveMediaType(row) {
  const raw = String(row?.mediaType || row?.media_type || '').trim().toLowerCase();
  return raw === 'bluray' ? 'bluray' : 'disc';
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

export default function HistoryPage() {
  const [jobs, setJobs] = useState([]);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [selectedJob, setSelectedJob] = useState(null);
  const [detailVisible, setDetailVisible] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [logLoadingMode, setLogLoadingMode] = useState(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [reencodeBusyJobId, setReencodeBusyJobId] = useState(null);
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
        const queuedRows = Array.isArray(queueResponse.value?.queue?.queuedJobs) ? queueResponse.value.queue.queuedJobs : [];
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
  }, [search, status]);

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
    const label = target === 'raw' ? 'RAW-Dateien' : target === 'movie' ? 'Movie-Datei(en)' : 'RAW + Movie';
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
        detail: `RAW: ${summary.raw?.filesDeleted ?? 0}, MOVIE: ${summary.movie?.filesDeleted ?? 0}`,
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
        `Encode für "${title}" ist bereits erfolgreich abgeschlossen. Wirklich erneut encodieren?\n` +
        'Es wird eine neue Datei mit Kollisionsprüfung angelegt.'
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

  const statusBody = (row) => {
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
  const mkBody = (row) => (
    <span className="job-step-cell">
      {row?.backupSuccess ? <i className="pi pi-check-circle job-step-ok-icon" aria-label="Backup erfolgreich" title="Backup erfolgreich" /> : null}
      <span>
        {row.makemkvInfo
          ? `${getProcessStatusLabel(row.makemkvInfo.status)} ${typeof row.makemkvInfo.lastProgress === 'number' ? `${row.makemkvInfo.lastProgress.toFixed(1)}%` : ''}`
          : '-'}
      </span>
    </span>
  );
  const hbBody = (row) => (
    <span className="job-step-cell">
      {row?.encodeSuccess ? <i className="pi pi-check-circle job-step-ok-icon" aria-label="Encode erfolgreich" title="Encode erfolgreich" /> : null}
      <span>
        {row.handbrakeInfo
          ? `${getProcessStatusLabel(row.handbrakeInfo.status)} ${typeof row.handbrakeInfo.lastProgress === 'number' ? `${row.handbrakeInfo.lastProgress.toFixed(1)}%` : ''}`
          : '-'}
      </span>
    </span>
  );
  const mediaBody = (row) => {
    const mediaType = resolveMediaType(row);
    const src = mediaType === 'bluray' ? blurayIndicatorIcon : discIndicatorIcon;
    const alt = mediaType === 'bluray' ? 'Blu-ray' : 'Disc';
    const title = mediaType === 'bluray' ? 'Blu-ray' : 'CD/sonstiges Medium';
    return <img src={src} alt={alt} title={title} className="media-indicator-icon" />;
  };
  const posterBody = (row) =>
    row.poster_url && row.poster_url !== 'N/A' ? (
      <img src={row.poster_url} alt={row.title || row.detected_title || 'Poster'} className="poster-thumb" />
    ) : (
      <span>-</span>
    );

  return (
    <div className="page-grid">
      <Toast ref={toastRef} />

      <Card title="Historie" subTitle="Alle Jobs mit Details und Logs">
        <div className="table-filters">
          <InputText
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Suche nach Titel oder IMDb"
          />
          <Dropdown
            value={status}
            options={STATUS_FILTER_OPTIONS}
            optionLabel="label"
            optionValue="value"
            onChange={(event) => setStatus(event.value)}
            placeholder="Status"
          />
          <Button label="Neu laden" icon="pi pi-refresh" onClick={load} loading={loading} />
        </div>

        <div className="table-scroll-wrap table-scroll-wide">
          <DataTable
            value={jobs}
            dataKey="id"
            paginator
            rows={10}
            loading={loading}
            onRowClick={(event) => openDetail(event.data)}
            className="clickable-table"
            emptyMessage="Keine Einträge"
            responsiveLayout="scroll"
          >
            <Column field="id" header="#" style={{ width: '5rem' }} />
            <Column header="Medium" body={mediaBody} style={{ width: '6rem' }} />
            <Column header="Poster" body={posterBody} style={{ width: '7rem' }} />
            <Column field="title" header="Titel" body={(row) => row.title || row.detected_title || '-'} />
            <Column field="year" header="Jahr" style={{ width: '6rem' }} />
            <Column field="imdb_id" header="IMDb" style={{ width: '10rem' }} />
            <Column field="status" header="Status" body={statusBody} style={{ width: '12rem' }} />
            <Column header="MakeMKV" body={mkBody} style={{ width: '12rem' }} />
            <Column header="HandBrake" body={hbBody} style={{ width: '12rem' }} />
            <Column field="start_time" header="Start" style={{ width: '16rem' }} />
            <Column field="end_time" header="Ende" style={{ width: '16rem' }} />
            <Column field="output_path" header="Output" />
          </DataTable>
        </div>
      </Card>

      <JobDetailDialog
        visible={detailVisible}
        job={selectedJob}
        detailLoading={detailLoading}
        onLoadLog={handleLoadLog}
        logLoadingMode={logLoadingMode}
        onRestartEncode={handleRestartEncode}
        onReencode={handleReencode}
        onDeleteFiles={handleDeleteFiles}
        onRemoveFromQueue={handleRemoveFromQueue}
        isQueued={Boolean(selectedJob?.id && queuedJobIdSet.has(normalizeJobId(selectedJob.id)))}
        actionBusy={actionBusy}
        reencodeBusy={reencodeBusyJobId === selectedJob?.id}
        onHide={() => {
          setDetailVisible(false);
          setDetailLoading(false);
          setLogLoadingMode(null);
        }}
      />
    </div>
  );
}
