import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from 'primereact/button';
import { Card } from 'primereact/card';
import { Toast } from 'primereact/toast';
import { Badge } from 'primereact/badge';
import { Tag } from 'primereact/tag';
import { ProgressBar } from 'primereact/progressbar';
import { api } from '../api/client';
import { useWebSocket } from '../hooks/useWebSocket';
import AudiobookUploadPanel from '../components/AudiobookUploadPanel';
import AudiobookConfigPanel from '../components/AudiobookConfigPanel';
import { getStatusLabel, getStatusSeverity, normalizeStatus } from '../utils/statusPresentation';
import { resolveMediaType } from '../utils/jobTaxonomy';
import { confirmModal } from '../utils/confirmModal';

const TERMINAL_STATES = new Set(['DONE', 'FINISHED']);

function normalizeJobId(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return Math.trunc(parsed);
}

function hasOwn(source, key) {
  return source != null && Object.prototype.hasOwnProperty.call(source, key);
}

function normalizeLiveProgressForJob(job) {
  const live = job?.liveProgress && typeof job.liveProgress === 'object' ? job.liveProgress : null;
  if (!live) {
    return null;
  }
  const liveContext = live?.context && typeof live.context === 'object' ? live.context : {};
  return {
    progress: live?.progress ?? null,
    eta: live?.eta ?? null,
    statusText: live?.statusText ?? null,
    state: live?.state ?? null,
    currentChapter: liveContext?.currentChapter && typeof liveContext.currentChapter === 'object'
      ? liveContext.currentChapter
      : null,
    completedChapterCount: Number.isFinite(Number(liveContext?.completedChapterCount))
      ? Number(liveContext.completedChapterCount)
      : null
  };
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

function parseEncodePlan(job) {
  if (job?.encodePlan && typeof job.encodePlan === 'object') {
    return job.encodePlan;
  }
  try {
    return JSON.parse(job?.encode_plan_json || '{}');
  } catch (_error) {
    return {};
  }
}

function resolveAudiobookMetadata(job, encodePlan) {
  const handbrakeMeta = job?.handbrakeInfo?.metadata && typeof job.handbrakeInfo.metadata === 'object'
    ? job.handbrakeInfo.metadata
    : {};
  const selectedMeta = job?.makemkvInfo?.selectedMetadata && typeof job.makemkvInfo.selectedMetadata === 'object'
    ? job.makemkvInfo.selectedMetadata
    : {};
  const fallbackMeta = encodePlan?.metadata && typeof encodePlan.metadata === 'object'
    ? encodePlan.metadata
    : {};
  const merged = {
    ...fallbackMeta,
    ...selectedMeta,
    ...handbrakeMeta
  };
  const chapters = Array.isArray(merged?.chapters)
    ? merged.chapters
    : (Array.isArray(encodePlan?.chapters) ? encodePlan.chapters : []);

  return {
    title: String(job?.title || job?.detected_title || merged?.title || '').trim() || null,
    author: String(merged?.author || merged?.artist || '').trim() || null,
    narrator: String(merged?.narrator || '').trim() || null,
    description: String(merged?.description || '').trim() || null,
    series: String(merged?.series || '').trim() || null,
    part: Number.isFinite(Number(merged?.part)) ? Math.trunc(Number(merged.part)) : null,
    year: Number.isFinite(Number(job?.year))
      ? Math.trunc(Number(job.year))
      : (Number.isFinite(Number(merged?.year)) ? Math.trunc(Number(merged.year)) : null),
    chapters,
    durationMs: Number.isFinite(Number(merged?.durationMs)) ? Number(merged.durationMs) : 0,
    poster: String(job?.poster_url || merged?.poster || '').trim() || null
  };
}

function buildAudiobookJobMetaLine(jobId, metadata = {}, fallbackYear = null) {
  const author = String(metadata?.author || metadata?.artist || '').trim() || null;
  const narrator = String(metadata?.narrator || '').trim() || null;
  const chapterCount = Array.isArray(metadata?.chapters) ? metadata.chapters.length : 0;
  const year = Number.isFinite(Number(metadata?.year))
    ? Math.trunc(Number(metadata.year))
    : (Number.isFinite(Number(fallbackYear)) ? Math.trunc(Number(fallbackYear)) : null);
  return (
    `#${jobId}`
    + (author ? ` | ${author}` : '')
    + (narrator ? ` | ${narrator}` : '')
    + (chapterCount > 0 ? ` | ${chapterCount} Kapitel` : '')
    + (year ? ` | ${year}` : '')
  );
}

function buildAudiobookPipeline(job, progress = null) {
  const encodePlan = parseEncodePlan(job);
  const selectedMetadata = resolveAudiobookMetadata(job, encodePlan);
  const reviewData = job?.makemkvInfo?.selectedMetadata && typeof job.makemkvInfo.selectedMetadata === 'object'
    ? job.makemkvInfo.selectedMetadata
    : selectedMetadata;
  const state = String(progress?.state || job?.status || '').trim().toUpperCase() || 'UNKNOWN';
  return {
    state,
    activeJobId: Number(job?.id) || null,
    progress: Number.isFinite(Number(progress?.progress)) ? Number(progress.progress) : 0,
    eta: progress?.eta || null,
    statusText: progress?.statusText || null,
    context: {
      jobId: Number(job?.id) || null,
      mode: 'audiobook',
      mediaProfile: 'audiobook',
      selectedMetadata,
      audiobookConfig: {
        format: String(encodePlan?.format || job?.handbrakeInfo?.format || 'mp3').trim().toLowerCase() || 'mp3',
        formatOptions: encodePlan?.formatOptions && typeof encodePlan.formatOptions === 'object'
          ? encodePlan.formatOptions
          : {},
        preEncodeScriptIds: Array.isArray(encodePlan?.preEncodeScriptIds) ? encodePlan.preEncodeScriptIds : [],
        postEncodeScriptIds: Array.isArray(encodePlan?.postEncodeScriptIds) ? encodePlan.postEncodeScriptIds : [],
        preEncodeChainIds: Array.isArray(encodePlan?.preEncodeChainIds) ? encodePlan.preEncodeChainIds : [],
        postEncodeChainIds: Array.isArray(encodePlan?.postEncodeChainIds) ? encodePlan.postEncodeChainIds : [],
        preEncodeItems: Array.isArray(encodePlan?.preEncodeItems) ? encodePlan.preEncodeItems : [],
        postEncodeItems: Array.isArray(encodePlan?.postEncodeItems) ? encodePlan.postEncodeItems : []
      },
      mediaInfoReview: reviewData,
      outputPath: String(job?.output_path || encodePlan?.outputPath || '').trim() || null,
      currentChapter: progress?.currentChapter && typeof progress.currentChapter === 'object'
        ? progress.currentChapter
        : null,
      completedChapterCount: Number.isFinite(Number(progress?.completedChapterCount))
        ? Number(progress.completedChapterCount)
        : null
    }
  };
}

export default function AudiobooksPage({
  audiobookUpload,
  onAudiobookUpload,
  onCancelAudiobookUpload = null
}) {
  const toastRef = useRef(null);
  const [jobs, setJobs] = useState([]);
  const [loadingJobs, setLoadingJobs] = useState(false);
  const [expandedJobId, setExpandedJobId] = useState(undefined);
  const [jobProgress, setJobProgress] = useState({});
  const [actionBusyJobIds, setActionBusyJobIds] = useState(() => new Set());

  const setActionBusy = (jobId, busy) => {
    const normalizedJobId = normalizeJobId(jobId);
    if (!normalizedJobId) {
      return;
    }
    setActionBusyJobIds((prev) => {
      const next = new Set(prev);
      if (busy) {
        next.add(normalizedJobId);
      } else {
        next.delete(normalizedJobId);
      }
      return next;
    });
  };

  const loadJobs = useCallback(async () => {
    setLoadingJobs(true);
    try {
      const response = await api.getAudiobookJobs();
      const rows = Array.isArray(response?.jobs) ? response.jobs : [];
      const audiobookRows = rows
        .filter((job) => resolveMediaType(job) === 'audiobook')
        .sort((left, right) => Number(right?.id || 0) - Number(left?.id || 0));
      setJobs(audiobookRows);
      setJobProgress((prev) => {
        const next = {};
        for (const job of audiobookRows) {
          const jobId = normalizeJobId(job?.id);
          if (!jobId) {
            continue;
          }
          const status = String(job?.status || '').trim().toUpperCase();
          const isLiveStatus = ['ANALYZING', 'ENCODING'].includes(status);
          if (!isLiveStatus) {
            continue;
          }
          const serverProgress = normalizeLiveProgressForJob(job);
          if (serverProgress) {
            next[jobId] = serverProgress;
            continue;
          }
          if (prev?.[jobId] && typeof prev[jobId] === 'object') {
            next[jobId] = prev[jobId];
          }
        }
        return next;
      });
      return audiobookRows;
    } catch (error) {
      console.error('AudiobooksPage load jobs error:', error);
      return [];
    } finally {
      setLoadingJobs(false);
    }
  }, []);

  useEffect(() => {
    void loadJobs();
    const intervalId = setInterval(() => void loadJobs(), 5000);
    return () => clearInterval(intervalId);
  }, [loadJobs]);

  useWebSocket({
    onMessage: (message) => {
      if (!message?.type || !message?.payload) {
        return;
      }
      if (message.type === 'PIPELINE_PROGRESS') {
        const payload = message.payload;
        const jobId = normalizeJobId(payload?.activeJobId);
        if (!jobId) {
          return;
        }
        setJobProgress((prev) => {
          const previousEntry = prev?.[jobId] && typeof prev[jobId] === 'object' ? prev[jobId] : {};
          const contextPatch = payload?.contextPatch && typeof payload.contextPatch === 'object'
            ? payload.contextPatch
            : null;
          const nextCurrentChapter = hasOwn(contextPatch, 'currentChapter')
            ? (contextPatch?.currentChapter ?? null)
            : (previousEntry?.currentChapter ?? null);
          const nextCompletedChapterCount = hasOwn(contextPatch, 'completedChapterCount')
            ? (Number.isFinite(Number(contextPatch?.completedChapterCount))
              ? Number(contextPatch.completedChapterCount)
              : null)
            : (previousEntry?.completedChapterCount ?? null);
          return {
            ...prev,
            [jobId]: {
              progress: payload?.progress ?? previousEntry?.progress ?? null,
              eta: payload?.eta ?? previousEntry?.eta ?? null,
              statusText: payload?.statusText ?? previousEntry?.statusText ?? null,
              state: payload?.state ?? previousEntry?.state ?? null,
              currentChapter: nextCurrentChapter,
              completedChapterCount: nextCompletedChapterCount
            }
          };
        });
      }
      if (
        message.type === 'PIPELINE_UPDATE'
        || message.type === 'PIPELINE_STATE_CHANGED'
        || message.type === 'PIPELINE_QUEUE_CHANGED'
      ) {
        void loadJobs();
      }
    }
  });

  const activeJobs = useMemo(
    () => jobs.filter((job) => !TERMINAL_STATES.has(String(job?.status || '').trim().toUpperCase())),
    [jobs]
  );

  useEffect(() => {
    const normalizedExpanded = normalizeJobId(expandedJobId);
    const hasExpanded = activeJobs.some((job) => normalizeJobId(job?.id) === normalizedExpanded);
    if (hasExpanded) {
      return;
    }
    if (expandedJobId === null) {
      return;
    }
    if (activeJobs.length === 0) {
      return;
    }
    setExpandedJobId(normalizeJobId(activeJobs[0]?.id));
  }, [activeJobs, expandedJobId]);

  const handleAudiobookStart = async (jobId, audiobookConfig) => {
    const normalizedJobId = normalizeJobId(jobId);
    if (!normalizedJobId) {
      return;
    }
    setActionBusy(normalizedJobId, true);
    try {
      const response = await api.startAudiobook(normalizedJobId, audiobookConfig || {});
      const queued = Boolean(response?.result?.queued);
      toastRef.current?.show({
        severity: queued ? 'info' : 'success',
        summary: queued ? 'Job eingereiht' : 'Audiobook gestartet',
        detail: queued
          ? `Job #${normalizedJobId} wurde in die Warteschlange eingereiht.`
          : `Job #${normalizedJobId} wurde gestartet.`,
        life: 3200
      });
      await loadJobs();
    } catch (error) {
      toastRef.current?.show({
        severity: 'error',
        summary: 'Start fehlgeschlagen',
        detail: error?.message || 'Bitte Logs pruefen.',
        life: 4200
      });
    } finally {
      setActionBusy(normalizedJobId, false);
    }
  };

  const handleCancel = async (jobId) => {
    const normalizedJobId = normalizeJobId(jobId);
    if (!normalizedJobId) {
      return;
    }
    setActionBusy(normalizedJobId, true);
    try {
      await api.cancelPipeline(normalizedJobId);
      toastRef.current?.show({
        severity: 'info',
        summary: 'Abbruch angefordert',
        detail: `Job #${normalizedJobId} wird abgebrochen.`,
        life: 2600
      });
      await loadJobs();
    } catch (error) {
      toastRef.current?.show({
        severity: 'error',
        summary: 'Abbruch fehlgeschlagen',
        detail: error?.message || 'Bitte Logs pruefen.',
        life: 4200
      });
    } finally {
      setActionBusy(normalizedJobId, false);
    }
  };

  const handleDelete = async (jobId) => {
    const normalizedJobId = normalizeJobId(jobId);
    if (!normalizedJobId) {
      return;
    }
    const confirmed = await confirmModal({
      message: `Job #${normalizedJobId} wirklich aus der Historie entfernen?`,
      header: 'Job loeschen',
      icon: 'pi pi-exclamation-triangle',
      acceptClassName: 'p-button-danger',
      acceptLabel: 'Loeschen',
      rejectLabel: 'Abbrechen'
    });
    if (!confirmed) {
      return;
    }

    setActionBusy(normalizedJobId, true);
    try {
      await api.deleteJobEntry(normalizedJobId, 'none', { includeRelated: false });
      toastRef.current?.show({
        severity: 'success',
        summary: 'Job geloescht',
        detail: `Job #${normalizedJobId} wurde entfernt.`,
        life: 2800
      });
      if (normalizeJobId(expandedJobId) === normalizedJobId) {
        setExpandedJobId(null);
      }
      await loadJobs();
    } catch (error) {
      toastRef.current?.show({
        severity: 'error',
        summary: 'Loeschen fehlgeschlagen',
        detail: error?.message || 'Bitte Logs pruefen.',
        life: 4200
      });
    } finally {
      setActionBusy(normalizedJobId, false);
    }
  };

  const handleUploaded = async (uploadedJobId, response = null) => {
    const normalizedJobId = normalizeJobId(uploadedJobId)
      || extractUploadJobIdFromResponse(response);
    const rows = await loadJobs();
    const fallbackJobId = normalizeJobId(rows?.[0]?.id);
    const targetJobId = normalizedJobId || fallbackJobId;
    if (targetJobId) {
      setExpandedJobId(targetJobId);
    }
  };

  const jobsCardHeader = (
    <div className="converter-card-header">
      <div className="converter-card-title">
        <span>Audiobook Jobs</span>
        {activeJobs.length > 0 ? (
          <Badge value={activeJobs.length} severity="info" />
        ) : null}
      </div>
      <Button
        icon={loadingJobs ? 'pi pi-spin pi-spinner' : 'pi pi-refresh'}
        text
        rounded
        size="small"
        onClick={() => void loadJobs()}
        disabled={loadingJobs}
        aria-label="Jobs neu laden"
      />
    </div>
  );

  return (
    <div className="ripper-subpage-content">
      <Toast ref={toastRef} position="top-right" />

      <Card title="Audiobooks Upload" subTitle="AAX-Dateien importieren und als Audiobook-Job vorbereiten">
        <AudiobookUploadPanel
          audiobookUpload={audiobookUpload}
          onAudiobookUpload={onAudiobookUpload}
          onCancelUpload={onCancelAudiobookUpload}
          onUploaded={handleUploaded}
        />
      </Card>

      <Card header={jobsCardHeader}>
        {activeJobs.length === 0 ? (
          <p className="converter-jobs-empty-hint">
            <small>Keine aktiven Audiobook-Jobs vorhanden. Fertige Jobs findest du in der Historie.</small>
          </p>
        ) : (
          <div className="ripper-job-list">
            {activeJobs.map((job) => {
              const jobId = normalizeJobId(job?.id);
              if (!jobId) {
                return null;
              }
              const pipelineForJob = buildAudiobookPipeline(job, jobProgress[jobId] || null);
              const state = String(pipelineForJob?.state || job?.status || '').trim().toUpperCase();
              const isExpanded = normalizeJobId(expandedJobId) === jobId;
              const busy = actionBusyJobIds.has(jobId);
              const title = String(job?.title || job?.detected_title || `Job #${jobId}`).trim();
              const progressValue = Number.isFinite(Number(pipelineForJob?.progress))
                ? Math.max(0, Math.min(100, Number(pipelineForJob.progress)))
                : 0;
              const isRunning = ['ANALYZING', 'ENCODING'].includes(state);
              const showProgress = isRunning || progressValue > 0;
              const progressLabel = `${Math.trunc(progressValue)}%`;
              const etaLabel = String(pipelineForJob?.eta || '').trim();
              const currentChapter = pipelineForJob?.context?.currentChapter && typeof pipelineForJob.context.currentChapter === 'object'
                ? pipelineForJob.context.currentChapter
                : null;
              const chapterLabel = currentChapter?.index && currentChapter?.total
                ? ` | Kapitel ${currentChapter.index}/${currentChapter.total}${currentChapter.title ? `: ${currentChapter.title}` : ''}`
                : '';
              const metaLine = buildAudiobookJobMetaLine(jobId, pipelineForJob?.context?.selectedMetadata, job?.year);

              if (!isExpanded) {
                return (
                  <button
                    key={jobId}
                    type="button"
                    className="ripper-job-row"
                    onClick={() => setExpandedJobId(jobId)}
                  >
                    {(job?.poster_url && job.poster_url !== 'N/A') ? (
                      <img src={job.poster_url} alt={title} className="poster-thumb" />
                    ) : (
                      <div className="poster-thumb ripper-job-poster-fallback">Kein Cover</div>
                    )}
                    <div className="ripper-job-row-content">
                      <div className="ripper-job-row-main">
                        <strong className="ripper-job-title-line">
                          <i className="pi pi-headphones media-indicator-icon" style={{ fontSize: '1rem', color: 'var(--rip-muted)' }} />
                          <span>{title}</span>
                        </strong>
                        <small>{metaLine}</small>
                      </div>
                      <div className="ripper-job-badges">
                        <Tag value={getStatusLabel(state)} severity={getStatusSeverity(normalizeStatus(state))} />
                      </div>
                      {showProgress ? (
                        <div className="ripper-job-row-progress">
                          <ProgressBar value={progressValue} showValue={false} />
                          <small>{etaLabel ? `${progressLabel} | ETA ${etaLabel}` : `${progressLabel}${chapterLabel}`}</small>
                        </div>
                      ) : null}
                    </div>
                    <i className="pi pi-angle-down" aria-hidden="true" />
                  </button>
                );
              }

              return (
                <div key={jobId} className="ripper-job-expanded">
                  <div className="ripper-job-expanded-head">
                    {(job?.poster_url && job.poster_url !== 'N/A') ? (
                      <img src={job.poster_url} alt={title} className="poster-thumb" />
                    ) : (
                      <div className="poster-thumb ripper-job-poster-fallback">Kein Cover</div>
                    )}
                    <div className="ripper-job-expanded-title">
                      <strong className="ripper-job-title-line">
                        <i className="pi pi-headphones media-indicator-icon" style={{ fontSize: '1rem', color: 'var(--rip-muted)' }} />
                        <span>{title}</span>
                      </strong>
                      <small className="ripper-job-subtitle">{metaLine}</small>
                      <div className="ripper-job-badges">
                        <Tag value={getStatusLabel(state)} severity={getStatusSeverity(normalizeStatus(state))} />
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: '0.5rem' }}>
                      <Button
                        label="Einklappen"
                        icon="pi pi-angle-up"
                        severity="secondary"
                        outlined
                        onClick={() => setExpandedJobId(null)}
                        disabled={busy}
                      />
                    </div>
                  </div>
                  {showProgress ? (
                    <div className="ripper-job-row-progress">
                      <ProgressBar value={progressValue} showValue={false} />
                      <small>{etaLabel ? `${progressLabel} | ETA ${etaLabel}` : `${progressLabel}${chapterLabel}`}</small>
                    </div>
                  ) : null}
                  <AudiobookConfigPanel
                    pipeline={pipelineForJob}
                    onStart={(config) => void handleAudiobookStart(jobId, config)}
                    onCancel={() => void handleCancel(jobId)}
                    onDeleteJob={() => void handleDelete(jobId)}
                    busy={busy}
                  />
                </div>
              );
            })}
          </div>
        )}
      </Card>
    </div>
  );
}
