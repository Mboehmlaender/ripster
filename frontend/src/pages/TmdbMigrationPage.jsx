import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Card } from 'primereact/card';
import { Button } from 'primereact/button';
import { Tag } from 'primereact/tag';
import { Toast } from 'primereact/toast';
import { DataTable } from 'primereact/datatable';
import { Column } from 'primereact/column';
import { ProgressSpinner } from 'primereact/progressspinner';
import { api } from '../api/client';
import MetadataSelectionDialog from '../components/MetadataSelectionDialog';
import { isSeriesVideoJob } from '../utils/jobTaxonomy';

function normalizeJobId(value) {
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
    if (raw === 'converter') {
      return 'converter';
    }
  }
  return 'other';
}

function buildMetadataContextFromJob(row) {
  const jobId = normalizeJobId(row?.id);
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

  return {
    jobId,
    status: row?.status || null,
    lastState: row?.last_state || null,
    submitMode: 'assign',
    mediaProfile: rowMediaType,
    detectedTitle: row?.detected_title || row?.title || '',
    selectedMetadata: {
      ...(selectedMetadata && typeof selectedMetadata === 'object' ? selectedMetadata : {}),
      title: row?.title || selectedMetadata?.title || row?.detected_title || '',
      year: row?.year || selectedMetadata?.year || null,
      imdbId: row?.imdb_id || selectedMetadata?.imdbId || null,
      poster: row?.poster_url || selectedMetadata?.poster || null,
      metadataProvider,
      workflowKind,
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
}

export default function TmdbMigrationPage() {
  const toastRef = useRef(null);
  const countdownIntervalRef = useRef(null);
  const nextJobTimeoutRef = useRef(null);
  const jobsRef = useRef([]);
  const runningRef = useRef(false);

  const [jobs, setJobs] = useState([]);
  const [loading, setLoading] = useState(false);
  const [running, setRunning] = useState(false);
  const [metadataDialogVisible, setMetadataDialogVisible] = useState(false);
  const [metadataDialogContext, setMetadataDialogContext] = useState(null);
  const [metadataAssignBusy, setMetadataAssignBusy] = useState(false);
  const [cooldownRemaining, setCooldownRemaining] = useState(0);

  useEffect(() => {
    jobsRef.current = Array.isArray(jobs) ? jobs : [];
  }, [jobs]);

  useEffect(() => {
    runningRef.current = running;
  }, [running]);

  const clearTimers = useCallback(() => {
    if (countdownIntervalRef.current) {
      clearInterval(countdownIntervalRef.current);
      countdownIntervalRef.current = null;
    }
    if (nextJobTimeoutRef.current) {
      clearTimeout(nextJobTimeoutRef.current);
      nextJobTimeoutRef.current = null;
    }
  }, []);

  useEffect(() => () => {
    clearTimers();
  }, [clearTimers]);

  const loadPendingJobs = useCallback(async () => {
    setLoading(true);
    try {
      const response = await api.getTmdbMigrationPendingJobs({ limit: 1000 });
      const rows = Array.isArray(response?.jobs) ? response.jobs : [];
      setJobs(rows);
    } catch (error) {
      toastRef.current?.show({
        severity: 'error',
        summary: 'Laden fehlgeschlagen',
        detail: error?.message || 'TMDb-Migrationsliste konnte nicht geladen werden.'
      });
      setJobs([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadPendingJobs();
  }, [loadPendingJobs]);

  const openJobInDialog = useCallback((job) => {
    if (!job) {
      return;
    }
    const context = buildMetadataContextFromJob(job);
    if (!context?.jobId) {
      return;
    }
    setMetadataDialogContext(context);
    setMetadataDialogVisible(true);
  }, []);

  const scheduleNextJob = useCallback((nextJob, seconds = 10) => {
    clearTimers();
    const normalizedSeconds = Math.max(0, Math.trunc(Number(seconds || 0)));
    if (!nextJob) {
      setRunning(false);
      setCooldownRemaining(0);
      setMetadataDialogVisible(false);
      setMetadataDialogContext(null);
      return;
    }

    setCooldownRemaining(normalizedSeconds);
    if (normalizedSeconds > 0) {
      countdownIntervalRef.current = setInterval(() => {
        setCooldownRemaining((prev) => {
          const next = Number(prev || 0) - 1;
          return next > 0 ? next : 0;
        });
      }, 1000);
    }

    nextJobTimeoutRef.current = setTimeout(() => {
      clearTimers();
      setCooldownRemaining(0);
      if (!runningRef.current) {
        return;
      }
      openJobInDialog(nextJob);
    }, normalizedSeconds * 1000);
  }, [clearTimers, openJobInDialog]);

  const startSequence = () => {
    const pending = jobsRef.current;
    if (!Array.isArray(pending) || pending.length === 0) {
      return;
    }
    clearTimers();
    setRunning(true);
    setMetadataDialogVisible(true);
    setCooldownRemaining(0);
    openJobInDialog(pending[0]);
  };

  const stopSequence = useCallback(() => {
    clearTimers();
    setRunning(false);
    setCooldownRemaining(0);
    setMetadataDialogVisible(false);
    setMetadataDialogContext(null);
  }, [clearTimers]);

  const handleMetadataSearch = async (query, options = {}) => {
    const workflow = String(
      options?.workflowKind
      || metadataDialogContext?.selectedMetadata?.workflowKind
      || ''
    ).trim().toLowerCase();
    try {
      const tmdbSeasonHint = metadataDialogContext?.selectedMetadata?.seasonNumber
        ?? metadataDialogContext?.seriesLookupHint?.seasonNumber
        ?? null;
      const response = workflow === 'series'
        ? await api.searchTmdbSeries(query, tmdbSeasonHint)
        : await api.searchTmdbMovie(query);
      return response?.results || [];
    } catch (error) {
      toastRef.current?.show({
        severity: 'error',
        summary: 'TMDb-Suche fehlgeschlagen',
        detail: error?.message || 'Suche fehlgeschlagen.'
      });
      return [];
    }
  };

  const handleMetadataSubmit = async (payload) => {
    const normalizedJobId = normalizeJobId(payload?.jobId);
    if (!normalizedJobId) {
      return;
    }

    setMetadataAssignBusy(true);
    clearTimers();
    setCooldownRemaining(0);

    try {
      await api.assignJobMetadata(normalizedJobId, payload || {});

      const remaining = jobsRef.current.filter((row) => normalizeJobId(row?.id) !== normalizedJobId);
      jobsRef.current = remaining;
      setJobs(remaining);

      toastRef.current?.show({
        severity: 'success',
        summary: 'Job migriert',
        detail: `Job #${normalizedJobId} wurde auf TMDb aktualisiert.`,
        life: 2600
      });

      if (remaining.length === 0) {
        setRunning(false);
        setMetadataDialogVisible(false);
        setMetadataDialogContext(null);
        toastRef.current?.show({
          severity: 'success',
          summary: 'Migration abgeschlossen',
          detail: 'Alle ausstehenden Jobs wurden abgearbeitet.',
          life: 3200
        });
        return;
      }

      if (!runningRef.current) {
        return;
      }
      scheduleNextJob(remaining[0], 10);
    } catch (error) {
      toastRef.current?.show({
        severity: 'error',
        summary: 'Migration fehlgeschlagen',
        detail: error?.message || 'Metadaten konnten nicht übernommen werden.'
      });
      throw error;
    } finally {
      setMetadataAssignBusy(false);
    }
  };

  const mediumTagBody = (row) => {
    const mediaType = resolveMediaType(row);
    const label = mediaType === 'bluray' ? 'Blu-ray' : mediaType === 'dvd' ? 'DVD' : mediaType === 'converter' ? 'Converter' : 'Other';
    return <Tag value={label} severity={mediaType === 'converter' ? 'info' : 'warning'} />;
  };

  const titleBody = (row) => String(row?.title || row?.detected_title || `Job #${row?.id || '-'}`).trim() || '-';

  const countdownProgressValue = useMemo(() => {
    if (cooldownRemaining <= 0) {
      return 0;
    }
    const elapsed = 10 - Math.min(10, cooldownRemaining);
    return Math.max(0, Math.min(100, Math.round((elapsed / 10) * 100)));
  }, [cooldownRemaining]);

  return (
    <div className="page-grid tmdb-migration-page">
      <Toast ref={toastRef} position="top-right" />

      <Card title="TMDb Migration (Direktlink)" subTitle="Diese Seite ist nicht in der Navigation verlinkt.">
        <div className="tmdb-migration-toolbar">
          <div className="tmdb-migration-toolbar-left">
            <Tag value={`${jobs.length} offen`} severity={jobs.length > 0 ? 'warning' : 'success'} />
            {running ? <Tag value="Sequenz aktiv" severity="info" /> : null}
          </div>
          <div className="tmdb-migration-toolbar-actions">
            <Button
              label="Liste neu laden"
              icon={loading ? 'pi pi-spin pi-spinner' : 'pi pi-refresh'}
              outlined
              onClick={() => {
                if (!metadataAssignBusy) {
                  void loadPendingJobs();
                }
              }}
              disabled={metadataAssignBusy}
            />
            {!running ? (
              <Button
                label="Start"
                icon="pi pi-play"
                onClick={startSequence}
                disabled={jobs.length === 0 || loading || metadataAssignBusy}
              />
            ) : (
              <Button
                label="Stop"
                icon="pi pi-stop"
                severity="secondary"
                onClick={stopSequence}
                disabled={metadataAssignBusy}
              />
            )}
          </div>
        </div>

        {running && cooldownRemaining > 0 ? (
          <div className="tmdb-migration-countdown">
            <ProgressSpinner style={{ width: '2rem', height: '2rem' }} strokeWidth="5" />
            <div className="tmdb-migration-countdown-copy">
              <strong>Nächste Suche startet in {cooldownRemaining}s</strong>
              <small>API-Wartezeit aktiv (mind. 10 Sekunden zwischen Jobs).</small>
            </div>
            <div className="tmdb-migration-countdown-progress" aria-label="Cooldown Fortschritt">
              <div className="tmdb-migration-countdown-bar" style={{ width: `${countdownProgressValue}%` }} />
            </div>
          </div>
        ) : null}

        <DataTable
          value={jobs}
          loading={loading}
          dataKey="id"
          emptyMessage="Keine offenen Jobs für TMDb-Migration."
          className="tmdb-migration-table"
          rows={50}
          paginator={jobs.length > 50}
        >
          <Column field="id" header="ID" style={{ width: '6rem' }} body={(row) => `#${row?.id || '-'}`} />
          <Column header="Titel" body={titleBody} />
          <Column field="year" header="Jahr" style={{ width: '8rem' }} body={(row) => row?.year || '-'} />
          <Column header="Medium" body={mediumTagBody} style={{ width: '10rem' }} />
          <Column
            header="Status"
            style={{ width: '14rem' }}
            body={(row) => String(row?.status || row?.last_state || '-').trim() || '-'}
          />
        </DataTable>
      </Card>

      <MetadataSelectionDialog
        visible={metadataDialogVisible}
        context={metadataDialogContext}
        onHide={stopSequence}
        onSubmit={handleMetadataSubmit}
        onSearch={handleMetadataSearch}
        busy={metadataAssignBusy || (running && cooldownRemaining > 0)}
      />
    </div>
  );
}
