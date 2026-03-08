import { Dialog } from 'primereact/dialog';
import { Button } from 'primereact/button';
import MediaInfoReviewPanel from './MediaInfoReviewPanel';
import blurayIndicatorIcon from '../assets/media-bluray.svg';
import discIndicatorIcon from '../assets/media-disc.svg';
import otherIndicatorIcon from '../assets/media-other.svg';
import { getStatusLabel } from '../utils/statusPresentation';

function JsonView({ title, value }) {
  return (
    <div>
      <h4>{title}</h4>
      <pre className="json-box">{value ? JSON.stringify(value, null, 2) : '-'}</pre>
    </div>
  );
}

function ScriptResultRow({ result }) {
  const status = String(result?.status || '').toUpperCase();
  const isSuccess = status === 'SUCCESS';
  const isError = status === 'ERROR';
  const isSkipped = status.startsWith('SKIPPED');
  const icon = isSuccess ? 'pi-check-circle' : isError ? 'pi-times-circle' : 'pi-minus-circle';
  const tone = isSuccess ? 'success' : isError ? 'danger' : 'warning';
  return (
    <div className="script-result-row">
      <span className={`job-step-inline-${isSuccess ? 'ok' : isError ? 'no' : 'warn'}`}>
        <i className={`pi ${icon}`} aria-hidden="true" />
      </span>
      <span className="script-result-name">{result?.scriptName || result?.chainName || `#${result?.scriptId ?? result?.chainId ?? '?'}`}</span>
      <span className={`script-result-status tone-${tone}`}>{status}</span>
      {result?.error ? <span className="script-result-error">{result.error}</span> : null}
    </div>
  );
}

function ScriptSummarySection({ title, summary }) {
  if (!summary || summary.configured === 0) return null;
  const results = Array.isArray(summary.results) ? summary.results : [];
  return (
    <div className="script-summary-block">
      <strong>{title}:</strong>
      <span className="script-summary-counts">
        {summary.succeeded > 0 ? <span className="tone-success">{summary.succeeded} OK</span> : null}
        {summary.failed > 0 ? <span className="tone-danger">{summary.failed} Fehler</span> : null}
        {summary.skipped > 0 ? <span className="tone-warning">{summary.skipped} übersprungen</span> : null}
      </span>
      {results.length > 0 ? (
        <div className="script-result-list">
          {results.map((r, i) => <ScriptResultRow key={i} result={r} />)}
        </div>
      ) : null}
    </div>
  );
}

function resolveMediaType(job) {
  const candidates = [
    job?.mediaType,
    job?.media_type,
    job?.mediaProfile,
    job?.media_profile,
    job?.encodePlan?.mediaProfile,
    job?.makemkvInfo?.analyzeContext?.mediaProfile,
    job?.makemkvInfo?.mediaProfile,
    job?.mediainfoInfo?.mediaProfile
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
  }
  return 'other';
}

function statusBadgeMeta(status, queued = false) {
  const normalized = String(status || '').trim().toUpperCase();
  const label = getStatusLabel(normalized, { queued });
  if (queued) {
    return { label, icon: 'pi-list', tone: 'info' };
  }
  if (normalized === 'FINISHED') {
    return { label, icon: 'pi-check-circle', tone: 'success' };
  }
  if (normalized === 'ERROR') {
    return { label, icon: 'pi-times-circle', tone: 'danger' };
  }
  if (normalized === 'CANCELLED') {
    return { label, icon: 'pi-ban', tone: 'warning' };
  }
  if (normalized === 'READY_TO_ENCODE' || normalized === 'READY_TO_START') {
    return { label, icon: 'pi-play-circle', tone: 'info' };
  }
  if (normalized === 'WAITING_FOR_USER_DECISION') {
    return { label, icon: 'pi-exclamation-circle', tone: 'warning' };
  }
  if (normalized === 'METADATA_SELECTION') {
    return { label, icon: 'pi-list', tone: 'warning' };
  }
  if (normalized === 'ANALYZING') {
    return { label, icon: 'pi-search', tone: 'warning' };
  }
  if (normalized === 'RIPPING') {
    return { label, icon: 'pi-download', tone: 'warning' };
  }
  if (normalized === 'MEDIAINFO_CHECK') {
    return { label, icon: 'pi-sliders-h', tone: 'warning' };
  }
  if (normalized === 'ENCODING') {
    return { label, icon: 'pi-cog', tone: 'warning' };
  }
  return { label: label || '-', icon: 'pi-info-circle', tone: 'secondary' };
}

function omdbField(value) {
  const raw = String(value || '').trim();
  return raw || '-';
}

function omdbRottenTomatoesScore(omdbInfo) {
  const ratings = Array.isArray(omdbInfo?.Ratings) ? omdbInfo.Ratings : [];
  const entry = ratings.find((item) => String(item?.Source || '').trim().toLowerCase() === 'rotten tomatoes');
  return omdbField(entry?.Value);
}

function BoolState({ value }) {
  const isTrue = Boolean(value);
  return isTrue ? (
    <span className="job-step-inline-ok" title="Ja">
      <i className="pi pi-check-circle" aria-hidden="true" />
    </span>
  ) : (
    <span className="job-step-inline-no" title="Nein">
      <i className="pi pi-times-circle" aria-hidden="true" />
    </span>
  );
}

export default function JobDetailDialog({
  visible,
  job,
  onHide,
  detailLoading = false,
  onLoadLog,
  logLoadingMode = null,
  onAssignOmdb,
  onResumeReady,
  onRestartEncode,
  onRestartReview,
  onReencode,
  onDeleteFiles,
  onDeleteEntry,
  onRemoveFromQueue,
  isQueued = false,
  omdbAssignBusy = false,
  actionBusy = false,
  reencodeBusy = false,
  deleteEntryBusy = false
}) {
  const mkDone = Boolean(job?.ripSuccessful) || !job?.makemkvInfo || job?.makemkvInfo?.status === 'SUCCESS';
  const running = ['ANALYZING', 'RIPPING', 'MEDIAINFO_CHECK', 'ENCODING'].includes(job?.status);
  const showFinalLog = !running;
  const canReencode = !!(job?.rawStatus?.exists && job?.rawStatus?.isEmpty !== true && mkDone && !running);
  const canResumeReady = Boolean(
    (String(job?.status || '').trim().toUpperCase() === 'READY_TO_ENCODE' || String(job?.last_state || '').trim().toUpperCase() === 'READY_TO_ENCODE')
    && !running
    && typeof onResumeReady === 'function'
  );
  const hasConfirmedPlan = Boolean(
    job?.encodePlan
    && Array.isArray(job?.encodePlan?.titles)
    && job?.encodePlan?.titles.length > 0
    && Number(job?.encode_review_confirmed || 0) === 1
  );
  const hasRestartInput = Boolean(job?.encode_input_path || job?.raw_path || job?.encodePlan?.encodeInputPath);
  const canRestartEncode = Boolean(hasConfirmedPlan && hasRestartInput && !running);
  const canRestartReview = Boolean(
    job?.rawStatus?.exists
    && job?.rawStatus?.isEmpty !== true
    && !running
    && typeof onRestartReview === 'function'
  );
  const canDeleteEntry = !running && typeof onDeleteEntry === 'function';
  const queueLocked = Boolean(isQueued && job?.id);
  const logCount = Number(job?.log_count || 0);
  const logMeta = job?.logMeta && typeof job.logMeta === 'object' ? job.logMeta : null;
  const logLoaded = Boolean(logMeta?.loaded) || Boolean(job?.log);
  const logTruncated = Boolean(logMeta?.truncated);
  const mediaType = resolveMediaType(job);
  const mediaTypeLabel = mediaType === 'bluray'
    ? 'Blu-ray'
    : (mediaType === 'dvd' ? 'DVD' : 'Sonstiges Medium');
  const mediaTypeIcon = mediaType === 'bluray'
    ? blurayIndicatorIcon
    : (mediaType === 'dvd' ? discIndicatorIcon : otherIndicatorIcon);
  const mediaTypeAlt = mediaType === 'bluray'
    ? 'Blu-ray'
    : (mediaType === 'dvd' ? 'DVD' : 'Sonstiges Medium');
  const statusMeta = statusBadgeMeta(job?.status, queueLocked);
  const omdbInfo = job?.omdbInfo && typeof job.omdbInfo === 'object' ? job.omdbInfo : {};

  return (
    <Dialog
      header={`Job #${job?.id || ''}`}
      visible={visible}
      onHide={onHide}
      style={{ width: '70rem', maxWidth: '96vw' }}
      className="job-detail-dialog"
      breakpoints={{ '1440px': '94vw', '1024px': '96vw', '640px': '98vw' }}
      modal
    >
      {!job ? null : (
        <>
          {detailLoading ? <p>Details werden geladen ...</p> : null}

          <div className="job-head-row">
            {job.poster_url && job.poster_url !== 'N/A' ? (
              <img src={job.poster_url} alt={job.title || 'Poster'} className="poster-large" />
            ) : (
              <div className="poster-large poster-fallback">Kein Poster</div>
            )}

            <div className="job-film-info-grid">
              <section className="job-meta-block job-meta-block-film">
                <h4>Film-Infos</h4>
                <div className="job-meta-list">
                  <div className="job-meta-item">
                    <strong>Titel:</strong>
                    <span>{job.title || job.detected_title || '-'}</span>
                  </div>
                  <div className="job-meta-item">
                    <strong>Jahr:</strong>
                    <span>{job.year || '-'}</span>
                  </div>
                  <div className="job-meta-item">
                    <strong>IMDb:</strong>
                    <span>{job.imdb_id || '-'}</span>
                  </div>
                  <div className="job-meta-item">
                    <strong>OMDb Match:</strong>
                    <BoolState value={job.selected_from_omdb} />
                  </div>
                  <div className="job-meta-item">
                    <strong>Medium:</strong>
                    <span className="job-step-cell">
                      <img src={mediaTypeIcon} alt={mediaTypeAlt} title={mediaTypeLabel} className="media-indicator-icon" />
                      <span>{mediaTypeLabel}</span>
                    </span>
                  </div>
                </div>
              </section>

              <section className="job-meta-block job-meta-block-film">
                <h4>OMDb Details</h4>
                <div className="job-meta-list">
                  <div className="job-meta-item">
                    <strong>Regisseur:</strong>
                    <span>{omdbField(omdbInfo?.Director)}</span>
                  </div>
                  <div className="job-meta-item">
                    <strong>Schauspieler:</strong>
                    <span>{omdbField(omdbInfo?.Actors)}</span>
                  </div>
                  <div className="job-meta-item">
                    <strong>Laufzeit:</strong>
                    <span>{omdbField(omdbInfo?.Runtime)}</span>
                  </div>
                  <div className="job-meta-item">
                    <strong>Genre:</strong>
                    <span>{omdbField(omdbInfo?.Genre)}</span>
                  </div>
                  <div className="job-meta-item">
                    <strong>Rotten Tomatoes:</strong>
                    <span>{omdbRottenTomatoesScore(omdbInfo)}</span>
                  </div>
                  <div className="job-meta-item">
                    <strong>imdbRating:</strong>
                    <span>{omdbField(omdbInfo?.imdbRating)}</span>
                  </div>
                </div>
              </section>
            </div>
          </div>

          <section className="job-meta-block job-meta-block-full">
            <h4>Job-Infos</h4>
            <div className="job-meta-grid job-meta-grid-compact">
              <div>
                <strong>Aktueller Status:</strong>{' '}
                <span
                  className={`job-status-icon tone-${statusMeta.tone}`}
                  title={statusMeta.label}
                  aria-label={statusMeta.label}
                >
                  <i className={`pi ${statusMeta.icon}`} aria-hidden="true" />
                </span>
              </div>
              <div>
                <strong>Start:</strong> {job.start_time || '-'}
              </div>
              <div>
                <strong>Ende:</strong> {job.end_time || '-'}
              </div>
              <div>
                <strong>RAW Pfad:</strong> {job.raw_path || '-'}
              </div>
              <div>
                <strong>Output:</strong> {job.output_path || '-'}
              </div>
              <div>
                <strong>Encode Input:</strong> {job.encode_input_path || '-'}
              </div>
              <div>
                <strong>RAW vorhanden:</strong> <BoolState value={job.rawStatus?.exists} />
              </div>
              <div>
                <strong>Movie Datei vorhanden:</strong> <BoolState value={job.outputStatus?.exists} />
              </div>
              <div>
                <strong>Backup erfolgreich:</strong> <BoolState value={job?.backupSuccess} />
              </div>
              <div>
                <strong>Encode erfolgreich:</strong> <BoolState value={job?.encodeSuccess} />
              </div>
              <div className="job-meta-col-span-2">
                <strong>Letzter Fehler:</strong> {job.error_message || '-'}
              </div>
            </div>
          </section>

          {(job.handbrakeInfo?.preEncodeScripts?.configured > 0 || job.handbrakeInfo?.postEncodeScripts?.configured > 0) ? (
            <section className="job-meta-block job-meta-block-full">
              <h4>Skripte</h4>
              <div className="script-results-grid">
                <ScriptSummarySection title="Pre-Encode" summary={job.handbrakeInfo?.preEncodeScripts} />
                <ScriptSummarySection title="Post-Encode" summary={job.handbrakeInfo?.postEncodeScripts} />
              </div>
            </section>
          ) : null}

          <div className="job-json-grid">
            <JsonView title="OMDb Info" value={job.omdbInfo} />
            <JsonView title="MakeMKV Info" value={job.makemkvInfo} />
            <JsonView title="Mediainfo Info" value={job.mediainfoInfo} />
            <JsonView title="Encode Plan" value={job.encodePlan} />
            <JsonView title="HandBrake Info" value={job.handbrakeInfo} />
          </div>

          {job.encodePlan ? (
            <>
              <h4>Mediainfo-Prüfung (Auswertung)</h4>
              <MediaInfoReviewPanel review={job.encodePlan} />
            </>
          ) : null}

          <h4>Aktionen</h4>
          <div className="actions-row">
            {queueLocked ? (
              <Button
                label="Aus Queue löschen"
                icon="pi pi-times"
                severity="danger"
                outlined
                size="small"
                onClick={() => onRemoveFromQueue?.(job)}
                loading={actionBusy}
                disabled={typeof onRemoveFromQueue !== 'function'}
              />
            ) : (
              <>
                <Button
                  label="OMDb neu zuordnen"
                  icon="pi pi-search"
                  severity="secondary"
                  size="small"
                  onClick={() => onAssignOmdb?.(job)}
                  loading={omdbAssignBusy}
                  disabled={running || typeof onAssignOmdb !== 'function'}
                />
                {canResumeReady ? (
                  <Button
                    label="Im Dashboard öffnen"
                    icon="pi pi-window-maximize"
                    severity="info"
                    outlined
                    size="small"
                    onClick={() => onResumeReady?.(job)}
                    loading={actionBusy}
                  />
                ) : null}
                {typeof onRestartEncode === 'function' ? (
                  <Button
                    label="Encode neu starten"
                    icon="pi pi-play"
                    severity="success"
                    size="small"
                    onClick={() => onRestartEncode?.(job)}
                    loading={actionBusy}
                    disabled={!canRestartEncode}
                  />
                ) : null}
                {typeof onRestartReview === 'function' ? (
                  <Button
                    label="Review neu starten"
                    icon="pi pi-refresh"
                    severity="info"
                    outlined
                    size="small"
                    onClick={() => onRestartReview?.(job)}
                    loading={actionBusy}
                    disabled={!canRestartReview}
                  />
                ) : null}
                <Button
                  label="RAW neu encodieren"
                  icon="pi pi-cog"
                  severity="info"
                  size="small"
                  onClick={() => onReencode?.(job)}
                  loading={reencodeBusy}
                  disabled={!canReencode || typeof onReencode !== 'function'}
                />
                <Button
                  label="RAW löschen"
                  icon="pi pi-trash"
                  severity="warning"
                  outlined
                  size="small"
                  onClick={() => onDeleteFiles?.(job, 'raw')}
                  loading={actionBusy}
                  disabled={!job.rawStatus?.exists || typeof onDeleteFiles !== 'function'}
                />
                <Button
                  label="Movie löschen"
                  icon="pi pi-trash"
                  severity="warning"
                  outlined
                  size="small"
                  onClick={() => onDeleteFiles?.(job, 'movie')}
                  loading={actionBusy}
                  disabled={!job.outputStatus?.exists || typeof onDeleteFiles !== 'function'}
                />
                <Button
                  label="Beides löschen"
                  icon="pi pi-times"
                  severity="danger"
                  size="small"
                  onClick={() => onDeleteFiles?.(job, 'both')}
                  loading={actionBusy}
                  disabled={(!job.rawStatus?.exists && !job.outputStatus?.exists) || typeof onDeleteFiles !== 'function'}
                />
                <Button
                  label="Historieneintrag löschen"
                  icon="pi pi-trash"
                  severity="danger"
                  outlined
                  size="small"
                  onClick={() => onDeleteEntry?.(job)}
                  loading={deleteEntryBusy}
                  disabled={!canDeleteEntry}
                />
              </>
            )}
          </div>

          <h4>Log</h4>
          {showFinalLog ? (
            <>
              <div className="actions-row">
                <Button
                  label={logLoaded ? 'Tail neu laden (800)' : 'Tail laden (800)'}
                  icon="pi pi-download"
                  severity="secondary"
                  outlined
                  size="small"
                  onClick={() => onLoadLog?.(job, 'tail')}
                  loading={logLoadingMode === 'tail'}
                />
                <Button
                  label="Vollständiges Log laden"
                  icon="pi pi-list"
                  severity="secondary"
                  outlined
                  size="small"
                  onClick={() => onLoadLog?.(job, 'all')}
                  loading={logLoadingMode === 'all'}
                  disabled={logCount <= 0}
                />
                <small>{`Log-Zeilen: ${logCount}`}</small>
                {logTruncated ? <small>(gekürzt auf letzte 800 Zeilen)</small> : null}
              </div>
              {logLoaded ? (
                <pre className="log-box">{job.log || ''}</pre>
              ) : (
                <p>Log nicht vorgeladen. Über die Buttons oben laden.</p>
              )}
            </>
          ) : (
            <p>Live-Log wird nur im Dashboard während laufender Analyse/Rip/Encode angezeigt.</p>
          )}
        </>
      )}
    </Dialog>
  );
}
