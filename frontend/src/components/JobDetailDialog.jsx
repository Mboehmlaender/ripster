import { Dialog } from 'primereact/dialog';
import { Tag } from 'primereact/tag';
import { Button } from 'primereact/button';
import MediaInfoReviewPanel from './MediaInfoReviewPanel';

function JsonView({ title, value }) {
  return (
    <div>
      <h4>{title}</h4>
      <pre className="json-box">{value ? JSON.stringify(value, null, 2) : '-'}</pre>
    </div>
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
  onReencode,
  onDeleteFiles,
  onDeleteEntry,
  omdbAssignBusy = false,
  actionBusy = false,
  reencodeBusy = false,
  deleteEntryBusy = false
}) {
  const mkDone = !job?.makemkvInfo || job?.makemkvInfo?.status === 'SUCCESS';
  const running = ['ANALYZING', 'RIPPING', 'MEDIAINFO_CHECK', 'ENCODING'].includes(job?.status);
  const showFinalLog = !running;
  const canReencode = !!(job?.rawStatus?.exists && job?.rawStatus?.isEmpty !== true && mkDone && !running);
  const canDeleteEntry = !running;
  const logCount = Number(job?.log_count || 0);
  const logMeta = job?.logMeta && typeof job.logMeta === 'object' ? job.logMeta : null;
  const logLoaded = Boolean(logMeta?.loaded) || Boolean(job?.log);
  const logTruncated = Boolean(logMeta?.truncated);

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

            <div className="job-meta-grid">
              <div>
                <strong>Titel:</strong> {job.title || job.detected_title || '-'}
              </div>
              <div>
                <strong>Jahr:</strong> {job.year || '-'}
              </div>
              <div>
                <strong>IMDb:</strong> {job.imdb_id || '-'}
              </div>
              <div>
                <strong>OMDb Match:</strong>{' '}
                <Tag value={job.selected_from_omdb ? 'Ja' : 'Nein'} severity={job.selected_from_omdb ? 'success' : 'secondary'} />
              </div>
              <div>
                <strong>Status:</strong> <Tag value={job.status} />
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
                <strong>Mediainfo bestätigt:</strong> {job.encode_review_confirmed ? 'ja' : 'nein'}
              </div>
              <div>
                <strong>RAW vorhanden:</strong> {job.rawStatus?.exists ? 'ja' : 'nein'}
              </div>
              <div>
                <strong>RAW leer:</strong> {job.rawStatus?.isEmpty === null ? '-' : job.rawStatus?.isEmpty ? 'ja' : 'nein'}
              </div>
              <div>
                <strong>Movie Datei vorhanden:</strong> {job.outputStatus?.exists ? 'ja' : 'nein'}
              </div>
              <div>
                <strong>Movie-Dir leer:</strong> {job.movieDirStatus?.isEmpty === null ? '-' : job.movieDirStatus?.isEmpty ? 'ja' : 'nein'}
              </div>
              <div>
                <strong>Fehler:</strong> {job.error_message || '-'}
              </div>
            </div>
          </div>

          <div className="job-json-grid">
            <JsonView title="OMDb Info" value={job.omdbInfo} />
            <JsonView title="MakeMKV Info" value={job.makemkvInfo} />
            <JsonView title="HandBrake Info" value={job.handbrakeInfo} />
            <JsonView title="Mediainfo Info" value={job.mediainfoInfo} />
            <JsonView title="Encode Plan" value={job.encodePlan} />
          </div>

          {job.encodePlan ? (
            <>
              <h4>Mediainfo-Prüfung (Auswertung)</h4>
              <MediaInfoReviewPanel review={job.encodePlan} />
            </>
          ) : null}

          <h4>Aktionen</h4>
          <div className="actions-row">
            <Button
              label="OMDb neu zuordnen"
              icon="pi pi-search"
              severity="secondary"
              size="small"
              onClick={() => onAssignOmdb?.(job)}
              loading={omdbAssignBusy}
              disabled={running}
            />
            <Button
              label="RAW neu encodieren"
              icon="pi pi-cog"
              severity="info"
              size="small"
              onClick={() => onReencode?.(job)}
              loading={reencodeBusy}
              disabled={!canReencode}
            />
            <Button
              label="RAW löschen"
              icon="pi pi-trash"
              severity="warning"
              outlined
              size="small"
              onClick={() => onDeleteFiles?.(job, 'raw')}
              loading={actionBusy}
              disabled={!job.rawStatus?.exists}
            />
            <Button
              label="Movie löschen"
              icon="pi pi-trash"
              severity="warning"
              outlined
              size="small"
              onClick={() => onDeleteFiles?.(job, 'movie')}
              loading={actionBusy}
              disabled={!job.outputStatus?.exists}
            />
            <Button
              label="Beides löschen"
              icon="pi pi-times"
              severity="danger"
              size="small"
              onClick={() => onDeleteFiles?.(job, 'both')}
              loading={actionBusy}
              disabled={!job.rawStatus?.exists && !job.outputStatus?.exists}
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
