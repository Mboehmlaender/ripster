import { useEffect, useMemo, useRef, useState } from 'react';
import { Card } from 'primereact/card';
import { DataTable } from 'primereact/datatable';
import { Column } from 'primereact/column';
import { InputText } from 'primereact/inputtext';
import { Dropdown } from 'primereact/dropdown';
import { Tag } from 'primereact/tag';
import { Button } from 'primereact/button';
import { Toast } from 'primereact/toast';
import { api } from '../api/client';
import JobDetailDialog from '../components/JobDetailDialog';
import MetadataSelectionDialog from '../components/MetadataSelectionDialog';
import blurayIndicatorIcon from '../assets/media-bluray.svg';
import discIndicatorIcon from '../assets/media-disc.svg';
import otherIndicatorIcon from '../assets/media-other.svg';
import {
  getStatusLabel,
  getStatusSeverity,
  normalizeStatus,
  STATUS_FILTER_OPTIONS
} from '../utils/statusPresentation';

function resolveMediaType(row) {
  const raw = String(row?.mediaType || row?.media_type || '').trim().toLowerCase();
  if (raw === 'bluray') {
    return 'bluray';
  }
  if (raw === 'dvd' || raw === 'disc') {
    return 'dvd';
  }
  return 'other';
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

export default function DatabasePage() {
  const [rows, setRows] = useState([]);
  const [orphanRows, setOrphanRows] = useState([]);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [loading, setLoading] = useState(false);
  const [orphanLoading, setOrphanLoading] = useState(false);
  const [selectedJob, setSelectedJob] = useState(null);
  const [detailVisible, setDetailVisible] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [logLoadingMode, setLogLoadingMode] = useState(null);
  const [metadataDialogVisible, setMetadataDialogVisible] = useState(false);
  const [metadataDialogContext, setMetadataDialogContext] = useState(null);
  const [metadataDialogBusy, setMetadataDialogBusy] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const [reencodeBusyJobId, setReencodeBusyJobId] = useState(null);
  const [deleteEntryBusyJobId, setDeleteEntryBusyJobId] = useState(null);
  const [orphanImportBusyPath, setOrphanImportBusyPath] = useState(null);
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

  const loadRows = async () => {
    setLoading(true);
    try {
      const response = await api.getDatabaseRows({ search, status });
      setRows(response.rows || []);
    } catch (error) {
      toastRef.current?.show({ severity: 'error', summary: 'Fehler', detail: error.message });
    } finally {
      setLoading(false);
    }
  };

  const loadOrphans = async () => {
    setOrphanLoading(true);
    try {
      const response = await api.getOrphanRawFolders();
      setOrphanRows(response.rows || []);
    } catch (error) {
      toastRef.current?.show({ severity: 'error', summary: 'RAW-Prüfung fehlgeschlagen', detail: error.message });
    } finally {
      setOrphanLoading(false);
    }
  };

  const loadQueue = async () => {
    try {
      const response = await api.getPipelineQueue();
      const queuedRows = Array.isArray(response?.queue?.queuedJobs) ? response.queue.queuedJobs : [];
      const queuedIds = queuedRows
        .map((item) => normalizeJobId(item?.jobId))
        .filter(Boolean);
      setQueuedJobIds(queuedIds);
    } catch (_error) {
      setQueuedJobIds([]);
    }
  };

  const load = async () => {
    await Promise.all([loadRows(), loadOrphans(), loadQueue()]);
  };

  useEffect(() => {
    const timer = setTimeout(() => {
      load();
    }, 250);

    return () => clearTimeout(timer);
  }, [search, status]);

  useEffect(() => {
    if (!detailVisible || !selectedJob?.id) {
      return undefined;
    }

    const shouldPoll =
      ['ANALYZING', 'RIPPING', 'MEDIAINFO_CHECK', 'ENCODING'].includes(selectedJob.status) ||
      (selectedJob.status === 'READY_TO_ENCODE' && !selectedJob.encodePlan);

    if (!shouldPoll) {
      return undefined;
    }

    let cancelled = false;
    const refreshDetail = async () => {
      try {
        const response = await api.getJob(selectedJob.id, { includeLogs: false });
        if (!cancelled) {
          setSelectedJob(response.job);
        }
      } catch (_error) {
        // ignore polling errors; user can manually refresh
      }
    };

    const interval = setInterval(refreshDetail, 2500);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [detailVisible, selectedJob?.id, selectedJob?.status, selectedJob?.encodePlan]);

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

  const refreshDetailIfOpen = async (jobId) => {
    if (!detailVisible || !selectedJob || selectedJob.id !== jobId) {
      return;
    }

    const response = await api.getJob(jobId, { includeLogs: false });
    setSelectedJob(response.job);
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
    const confirmed = window.confirm(`Re-Encode aus RAW für "${title}" starten? Der bestehende Job wird aktualisiert.`);
    if (!confirmed) {
      return;
    }

    setReencodeBusyJobId(row.id);
    try {
      const response = await api.reencodeJob(row.id);
      toastRef.current?.show({
        severity: 'success',
        summary: 'Re-Encode gestartet',
        detail: 'Bestehender Job wurde in die Mediainfo-Prüfung gesetzt.',
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

  const handleRestartReview = async (row) => {
    setActionBusy(true);
    try {
      await api.restartReviewFromRaw(row.id);
      toastRef.current?.show({
        severity: 'success',
        summary: 'Review-Neustart gestartet',
        detail: 'Die Titel-/Spurprüfung wird aus dem RAW neu berechnet.',
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

  const handleResumeReady = async (row) => {
    setActionBusy(true);
    try {
      await api.resumeReadyJob(row.id);
      toastRef.current?.show({
        severity: 'success',
        summary: 'Job ins Dashboard geladen',
        detail: 'Job ist wieder im Dashboard aktiv.',
        life: 3200
      });
      await load();
      await refreshDetailIfOpen(row.id);
    } catch (error) {
      toastRef.current?.show({ severity: 'error', summary: 'Laden fehlgeschlagen', detail: error.message, life: 4500 });
    } finally {
      setActionBusy(false);
    }
  };

  const mapDeleteChoice = (value) => {
    const normalized = String(value || '').trim().toLowerCase();
    if (normalized === 'raw') return 'raw';
    if (normalized === 'fertig') return 'movie';
    if (normalized === 'beides') return 'both';
    if (normalized === 'nichts') return 'none';
    if (normalized === 'movie') return 'movie';
    if (normalized === 'both') return 'both';
    if (normalized === 'none') return 'none';
    return null;
  };

  const handleDeleteEntry = async (row) => {
    const title = row.title || row.detected_title || `Job #${row.id}`;
    const choiceRaw = window.prompt(
      `Was soll beim Löschen von "${title}" mit gelöscht werden?\n` +
      '- raw\n' +
      '- fertig\n' +
      '- beides\n' +
      '- nichts',
      'nichts'
    );

    if (choiceRaw === null) {
      return;
    }

    const target = mapDeleteChoice(choiceRaw);
    if (!target) {
      toastRef.current?.show({
        severity: 'warn',
        summary: 'Ungültige Eingabe',
        detail: 'Bitte genau eine Option verwenden: raw, fertig, beides, nichts.',
        life: 4200
      });
      return;
    }

    const confirmed = window.confirm(
      `Historieneintrag "${title}" wirklich löschen? Auswahl: ${target === 'movie' ? 'fertig' : target}`
    );
    if (!confirmed) {
      return;
    }

    setDeleteEntryBusyJobId(row.id);
    try {
      const response = await api.deleteJobEntry(row.id, target);
      const rawDeleted = response?.fileSummary?.raw?.filesDeleted ?? 0;
      const movieDeleted = response?.fileSummary?.movie?.filesDeleted ?? 0;
      toastRef.current?.show({
        severity: 'success',
        summary: 'Historieneintrag gelöscht',
        detail: `Dateien entfernt: RAW ${rawDeleted}, Fertig ${movieDeleted}`,
        life: 4200
      });
      if (selectedJob?.id === row.id) {
        setDetailVisible(false);
        setSelectedJob(null);
      }
      await load();
    } catch (error) {
      toastRef.current?.show({
        severity: 'error',
        summary: 'Löschen fehlgeschlagen',
        detail: error.message,
        life: 5000
      });
    } finally {
      setDeleteEntryBusyJobId(null);
    }
  };

  const handleImportOrphanRaw = async (row) => {
    const target = row?.rawPath || row?.folderName || '-';
    const confirmed = window.confirm(`Für RAW-Ordner "${target}" einen neuen Historienjob anlegen?`);
    if (!confirmed) {
      return;
    }

    setOrphanImportBusyPath(row.rawPath);
    try {
      const response = await api.importOrphanRawFolder(row.rawPath);
      toastRef.current?.show({
        severity: 'success',
        summary: 'Job angelegt',
        detail: `Historieneintrag #${response?.job?.id || '-'} wurde erstellt.`,
        life: 3500
      });
      await load();
    } catch (error) {
      toastRef.current?.show({
        severity: 'error',
        summary: 'Import fehlgeschlagen',
        detail: error.message,
        life: 4500
      });
    } finally {
      setOrphanImportBusyPath(null);
    }
  };

  const handleOmdbSearch = async (query) => {
    try {
      const response = await api.searchOmdb(query);
      return response.results || [];
    } catch (error) {
      toastRef.current?.show({ severity: 'error', summary: 'OMDb Suche fehlgeschlagen', detail: error.message, life: 4500 });
      return [];
    }
  };

  const openMetadataAssignDialog = (row) => {
    if (!row?.id) {
      return;
    }
    const detectedTitle = row.title || row.detected_title || '';
    const imdbId = String(row.imdb_id || '').trim();
    const seedRows = imdbId
      ? [{
          title: row.title || row.detected_title || detectedTitle || imdbId,
          year: row.year || '',
          imdbId,
          type: 'movie',
          poster: row.poster_url || null
        }]
      : [];

    setMetadataDialogContext({
      jobId: row.id,
      detectedTitle,
      selectedMetadata: {
        title: row.title || row.detected_title || '',
        year: row.year || '',
        imdbId,
        poster: row.poster_url || null
      },
      omdbCandidates: seedRows
    });
    setMetadataDialogVisible(true);
  };

  const handleMetadataAssignSubmit = async (payload) => {
    const jobId = Number(payload?.jobId || metadataDialogContext?.jobId || 0);
    if (!jobId) {
      return;
    }

    setMetadataDialogBusy(true);
    try {
      const response = await api.assignJobOmdb(jobId, payload);
      toastRef.current?.show({
        severity: 'success',
        summary: 'OMDb-Zuordnung aktualisiert',
        detail: `Job #${jobId} wurde aktualisiert.`,
        life: 3500
      });
      setMetadataDialogVisible(false);
      await load();
      if (detailVisible && selectedJob?.id === jobId && response?.job) {
        setSelectedJob(response.job);
      } else {
        await refreshDetailIfOpen(jobId);
      }
    } catch (error) {
      toastRef.current?.show({
        severity: 'error',
        summary: 'OMDb-Zuordnung fehlgeschlagen',
        detail: error.message,
        life: 5000
      });
    } finally {
      setMetadataDialogBusy(false);
    }
  };

  const posterBody = (row) =>
    row.poster_url && row.poster_url !== 'N/A' ? (
      <img src={row.poster_url} alt={row.title || row.detected_title || 'Poster'} className="poster-thumb" />
    ) : (
      <span>-</span>
    );

  const titleBody = (row) => (
    <div>
      <div><strong>{row.title || row.detected_title || '-'}</strong></div>
      <small>{row.year || '-'} | {row.imdb_id || '-'}</small>
    </div>
  );

  const stateBody = (row) => {
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
  const mediaBody = (row) => {
    const mediaType = resolveMediaType(row);
    const src = mediaType === 'bluray'
      ? blurayIndicatorIcon
      : (mediaType === 'dvd' ? discIndicatorIcon : otherIndicatorIcon);
    const alt = mediaType === 'bluray'
      ? 'Blu-ray'
      : (mediaType === 'dvd' ? 'DVD' : 'Sonstiges Medium');
    const title = mediaType === 'bluray'
      ? 'Blu-ray'
      : (mediaType === 'dvd' ? 'DVD' : 'Sonstiges Medium');
    const label = mediaType === 'bluray'
      ? 'Blu-ray'
      : (mediaType === 'dvd' ? 'DVD' : 'Sonstiges');
    return (
      <span className="job-step-cell">
        <img src={src} alt={alt} title={title} className="media-indicator-icon" />
        <span>{label}</span>
      </span>
    );
  };
  const orphanTitleBody = (row) => (
    <div>
      <div><strong>{row.title || '-'}</strong></div>
      <small>{row.year || '-'} | {row.imdbId || '-'}</small>
    </div>
  );
  const orphanPathBody = (row) => (
    <div className="orphan-path-cell">
      {row.rawPath}
    </div>
  );
  const orphanActionBody = (row) => (
    <Button
      label="Job anlegen"
      icon="pi pi-plus"
      size="small"
      onClick={() => handleImportOrphanRaw(row)}
      loading={orphanImportBusyPath === row.rawPath}
      disabled={Boolean(orphanImportBusyPath) || Boolean(actionBusy)}
    />
  );

  return (
    <div className="page-grid">
      <Toast ref={toastRef} />

      <Card title="Historie & Datenbank" subTitle="Kompakte Übersicht, Details im Job-Modal">
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
            value={rows}
            dataKey="id"
            paginator
            rows={10}
            loading={loading}
            onRowClick={(event) => openDetail(event.data)}
            className="clickable-table"
            emptyMessage="Keine Einträge"
            responsiveLayout="scroll"
          >
            <Column field="id" header="ID" style={{ width: '6rem' }} />
            <Column header="Bild" body={posterBody} style={{ width: '7rem' }} />
            <Column header="Medium" body={mediaBody} style={{ width: '10rem' }} />
            <Column header="Titel" body={titleBody} style={{ minWidth: '18rem' }} />
            <Column header="Status" body={stateBody} style={{ width: '11rem' }} />
            <Column field="start_time" header="Start" style={{ width: '16rem' }} />
            <Column field="end_time" header="Ende" style={{ width: '16rem' }} />
          </DataTable>
        </div>
      </Card>

      <Card title="RAW ohne Historie" subTitle="Ordner in raw_dir ohne zugehörigen Job können hier importiert werden">
        <div className="table-filters">
          <Button
            label="RAW prüfen"
            icon="pi pi-search"
            onClick={loadOrphans}
            loading={orphanLoading}
            disabled={Boolean(orphanImportBusyPath)}
          />
          <Tag value={`${orphanRows.length} gefunden`} severity={orphanRows.length > 0 ? 'warning' : 'success'} />
        </div>

        <div className="table-scroll-wrap table-scroll-wide">
          <DataTable
            value={orphanRows}
            dataKey="rawPath"
            paginator
            rows={5}
            loading={orphanLoading}
            emptyMessage="Keine verwaisten RAW-Ordner gefunden"
            responsiveLayout="scroll"
          >
            <Column field="folderName" header="RAW-Ordner" style={{ minWidth: '18rem' }} />
            <Column header="Titel" body={orphanTitleBody} style={{ minWidth: '14rem' }} />
            <Column field="entryCount" header="Dateien" style={{ width: '8rem' }} />
            <Column header="Pfad" body={orphanPathBody} style={{ minWidth: '22rem' }} />
            <Column field="lastModifiedAt" header="Geändert" style={{ width: '16rem' }} />
            <Column header="Aktion" body={orphanActionBody} style={{ width: '10rem' }} />
          </DataTable>
        </div>
      </Card>

      <JobDetailDialog
        visible={detailVisible}
        job={selectedJob}
        detailLoading={detailLoading}
        onLoadLog={handleLoadLog}
        logLoadingMode={logLoadingMode}
        onHide={() => {
          setDetailVisible(false);
          setDetailLoading(false);
          setLogLoadingMode(null);
        }}
        onAssignOmdb={openMetadataAssignDialog}
        onResumeReady={handleResumeReady}
        onRestartEncode={handleRestartEncode}
        onRestartReview={handleRestartReview}
        onReencode={handleReencode}
        onDeleteFiles={handleDeleteFiles}
        onDeleteEntry={handleDeleteEntry}
        onRemoveFromQueue={handleRemoveFromQueue}
        isQueued={Boolean(selectedJob?.id && queuedJobIdSet.has(normalizeJobId(selectedJob.id)))}
        omdbAssignBusy={metadataDialogBusy}
        actionBusy={actionBusy}
        reencodeBusy={reencodeBusyJobId === selectedJob?.id}
        deleteEntryBusy={deleteEntryBusyJobId === selectedJob?.id}
      />

      <MetadataSelectionDialog
        visible={metadataDialogVisible}
        context={metadataDialogContext || {}}
        onHide={() => setMetadataDialogVisible(false)}
        onSubmit={handleMetadataAssignSubmit}
        onSearch={handleOmdbSearch}
        busy={metadataDialogBusy}
      />
    </div>
  );
}
