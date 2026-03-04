import { useEffect, useMemo, useRef, useState } from 'react';
import { Toast } from 'primereact/toast';
import { Card } from 'primereact/card';
import { Button } from 'primereact/button';
import { Tag } from 'primereact/tag';
import { ProgressBar } from 'primereact/progressbar';
import { Dialog } from 'primereact/dialog';
import { api } from '../api/client';
import PipelineStatusCard from '../components/PipelineStatusCard';
import MetadataSelectionDialog from '../components/MetadataSelectionDialog';
import blurayIndicatorIcon from '../assets/media-bluray.svg';
import discIndicatorIcon from '../assets/media-disc.svg';

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
  'ERROR'
]);
const statusSeverityMap = {
  IDLE: 'secondary',
  DISC_DETECTED: 'info',
  ANALYZING: 'warning',
  METADATA_SELECTION: 'warning',
  WAITING_FOR_USER_DECISION: 'warning',
  READY_TO_START: 'info',
  MEDIAINFO_CHECK: 'warning',
  READY_TO_ENCODE: 'info',
  RIPPING: 'warning',
  ENCODING: 'warning',
  FINISHED: 'success',
  ERROR: 'danger'
};

function normalizeJobId(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return Math.trunc(parsed);
}

function getAnalyzeContext(job) {
  return job?.makemkvInfo?.analyzeContext && typeof job.makemkvInfo.analyzeContext === 'object'
    ? job.makemkvInfo.analyzeContext
    : {};
}

function resolveMediaType(job) {
  const raw = String(job?.mediaType || job?.media_type || '').trim().toLowerCase();
  return raw === 'bluray' ? 'bluray' : 'disc';
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
    : {
      mediaType,
      src: discIndicatorIcon,
      alt: 'Disc',
      title: 'CD/sonstiges Medium'
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
  if (
    jobId
    && currentPipelineJobId
    && jobId === currentPipelineJobId
    && String(currentPipeline?.state || '').trim().toUpperCase() !== 'IDLE'
  ) {
    return currentPipeline;
  }

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
  const looksLikeCancelledEncode = jobStatus === 'ERROR' && (
    (errorText.includes('ABGEBROCHEN') || errorText.includes('CANCELLED'))
    && (hasOutputPath || Boolean(job?.encode_input_path) || Boolean(job?.handbrakeInfo))
  );
  const looksLikeEncodingError = jobStatus === 'ERROR' && (
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
      || looksLikeEncodingError
    )
  );

  return {
    state: jobStatus,
    activeJobId: jobId,
    progress: Number.isFinite(Number(job?.progress)) ? Number(job.progress) : 0,
    eta: job?.eta || null,
    statusText: job?.status_text || job?.error_message || null,
    context: {
      jobId,
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
      canRestartEncodeFromLastSettings
    }
  };
}

export default function DashboardPage({ pipeline, lastDiscEvent, refreshPipeline }) {
  const [busy, setBusy] = useState(false);
  const [metadataDialogVisible, setMetadataDialogVisible] = useState(false);
  const [cancelCleanupDialog, setCancelCleanupDialog] = useState({
    visible: false,
    jobId: null,
    outputPath: null
  });
  const [cancelCleanupBusy, setCancelCleanupBusy] = useState(false);
  const [liveJobLog, setLiveJobLog] = useState('');
  const [jobsLoading, setJobsLoading] = useState(false);
  const [dashboardJobs, setDashboardJobs] = useState([]);
  const [expandedJobId, setExpandedJobId] = useState(undefined);
  const toastRef = useRef(null);

  const state = String(pipeline?.state || 'IDLE').trim().toUpperCase();
  const currentPipelineJobId = normalizeJobId(pipeline?.activeJobId || pipeline?.context?.jobId);
  const isProcessing = processingStates.includes(state);

  const loadDashboardJobs = async () => {
    setJobsLoading(true);
    try {
      const response = await api.getJobs();
      const allJobs = Array.isArray(response?.jobs) ? response.jobs : [];
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
    if (pipeline?.state !== 'METADATA_SELECTION' && pipeline?.state !== 'WAITING_FOR_USER_DECISION') {
      setMetadataDialogVisible(false);
    }
  }, [pipeline?.state]);

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

  const showError = (error) => {
    toastRef.current?.show({
      severity: 'error',
      summary: 'Fehler',
      detail: error.message,
      life: 4500
    });
  };

  const handleAnalyze = async () => {
    setBusy(true);
    try {
      await api.analyzeDisc();
      await refreshPipeline();
      await loadDashboardJobs();
    } catch (error) {
      showError(error);
    } finally {
      setBusy(false);
    }
  };

  const handleReanalyze = async () => {
    const hasActiveJob = Boolean(pipeline?.context?.jobId || pipeline?.activeJobId);
    if (hasActiveJob && !['IDLE', 'DISC_DETECTED', 'FINISHED'].includes(state)) {
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

  const handleCancel = async () => {
    const cancelledState = state;
    const cancelledJobId = currentPipelineJobId;
    const cancelledJob = dashboardJobs.find((item) => normalizeJobId(item?.id) === cancelledJobId) || null;

    setBusy(true);
    try {
      await api.cancelPipeline();
      await refreshPipeline();
      await loadDashboardJobs();
      if (cancelledState === 'ENCODING' && cancelledJobId) {
        setCancelCleanupDialog({
          visible: true,
          jobId: cancelledJobId,
          outputPath: cancelledJob?.output_path || null
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
    if (!jobId) {
      setCancelCleanupDialog({ visible: false, jobId: null, outputPath: null });
      return;
    }

    setCancelCleanupBusy(true);
    try {
      const response = await api.deleteJobFiles(jobId, 'movie');
      const summary = response?.summary || {};
      toastRef.current?.show({
        severity: 'success',
        summary: 'Movie gelöscht',
        detail: `Entfernt: ${summary.movie?.filesDeleted ?? 0} Datei(en), ${summary.movie?.dirsRemoved ?? 0} Ordner.`,
        life: 4000
      });
      await loadDashboardJobs();
      await refreshPipeline();
      setCancelCleanupDialog({ visible: false, jobId: null, outputPath: null });
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
          selectedTrackSelection: startOptions.selectedTrackSelection ?? null
        });
      }
      await api.startJob(normalizedJobId);
      await refreshPipeline();
      await loadDashboardJobs();
      setExpandedJobId(normalizedJobId);
    } catch (error) {
      showError(error);
    } finally {
      setBusy(false);
    }
  };

  const handleConfirmReview = async (jobId, selectedEncodeTitleId = null, selectedTrackSelection = null) => {
    setBusy(true);
    try {
      await api.confirmEncodeReview(jobId, {
        selectedEncodeTitleId,
        selectedTrackSelection
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
      await api.retryJob(jobId);
      await refreshPipeline();
      await loadDashboardJobs();
      setExpandedJobId(normalizeJobId(jobId));
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
      await api.restartEncodeWithLastSettings(jobId);
      await refreshPipeline();
      await loadDashboardJobs();
      setExpandedJobId(normalizeJobId(jobId));
    } catch (error) {
      showError(error);
    } finally {
      setBusy(false);
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
    } catch (error) {
      showError(error);
    } finally {
      setBusy(false);
    }
  };

  const device = lastDiscEvent || pipeline?.context?.device;
  const canReanalyze = !processingStates.includes(state);
  const canOpenMetadataModal = pipeline?.state === 'METADATA_SELECTION' || pipeline?.state === 'WAITING_FOR_USER_DECISION';

  return (
    <div className="page-grid">
      <Toast ref={toastRef} />

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
              const isExpanded = normalizeJobId(expandedJobId) === jobId;
              const isCurrentSession = currentPipelineJobId === jobId && state !== 'IDLE';
              const isResumable = String(job?.status || '').trim().toUpperCase() === 'READY_TO_ENCODE' && !isCurrentSession;
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
                          <Tag value={String(job?.status || '-')} severity={statusSeverityMap[String(job?.status || '').trim().toUpperCase()] || 'secondary'} />
                          {isCurrentSession ? <Tag value="Aktive Session" severity="info" /> : null}
                          {isResumable ? <Tag value="Fortsetzbar" severity="success" /> : null}
                          {String(job?.status || '').trim().toUpperCase() === 'READY_TO_ENCODE'
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
                      onStart={handleStartJob}
                      onRestartEncode={handleRestartEncodeWithLastSettings}
                      onConfirmReview={handleConfirmReview}
                      onSelectPlaylist={handleSelectPlaylist}
                      onCancel={handleCancel}
                      onRetry={handleRetry}
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
                    <div className="dashboard-job-row-progress" aria-label={`Job Fortschritt ${progressLabel}`}>
                      <ProgressBar value={clampedProgress} showValue={false} />
                      <small>{etaLabel ? `${progressLabel} | ETA ${etaLabel}` : progressLabel}</small>
                    </div>
                  </div>
                  <div className="dashboard-job-badges">
                    <Tag value={String(job?.status || '-')} severity={statusSeverityMap[String(job?.status || '').trim().toUpperCase()] || 'secondary'} />
                    {isCurrentSession ? <Tag value="Aktive Session" severity="info" /> : null}
                    {isResumable ? <Tag value="Fortsetzbar" severity="success" /> : null}
                    {String(job?.status || '').trim().toUpperCase() === 'READY_TO_ENCODE'
                      ? <Tag value={reviewConfirmed ? 'Bestätigt' : 'Unbestätigt'} severity={reviewConfirmed ? 'success' : 'warning'} />
                      : null}
                    <JobStepChecks backupSuccess={Boolean(job?.backupSuccess)} encodeSuccess={Boolean(job?.encodeSuccess)} />
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
            onClick={() => setMetadataDialogVisible(true)}
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
        context={pipeline?.context || {}}
        onHide={() => setMetadataDialogVisible(false)}
        onSubmit={handleMetadataSubmit}
        onSearch={handleOmdbSearch}
        busy={busy}
      />

      <Dialog
        header="Encode abgebrochen"
        visible={Boolean(cancelCleanupDialog.visible)}
        onHide={() => setCancelCleanupDialog({ visible: false, jobId: null, outputPath: null })}
        style={{ width: '32rem', maxWidth: '96vw' }}
        modal
      >
        <p>
          Soll die bisher erzeugte Movie-Datei inklusive Job-Ordner im Ausgabeverzeichnis gelöscht werden?
        </p>
        {cancelCleanupDialog?.outputPath ? (
          <small className="muted-inline">Output-Pfad: {cancelCleanupDialog.outputPath}</small>
        ) : null}
        <div className="dialog-actions">
          <Button
            label="Behalten"
            severity="secondary"
            outlined
            onClick={() => setCancelCleanupDialog({ visible: false, jobId: null, outputPath: null })}
            disabled={cancelCleanupBusy}
          />
          <Button
            label="Movie löschen"
            icon="pi pi-trash"
            severity="danger"
            onClick={handleDeleteCancelledOutput}
            loading={cancelCleanupBusy}
          />
        </div>
      </Dialog>
    </div>
  );
}
