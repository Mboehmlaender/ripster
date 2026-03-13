import { Dialog } from 'primereact/dialog';
import { Button } from 'primereact/button';
import MediaInfoReviewPanel from './MediaInfoReviewPanel';
import blurayIndicatorIcon from '../assets/media-bluray.svg';
import discIndicatorIcon from '../assets/media-disc.svg';
import otherIndicatorIcon from '../assets/media-other.svg';
import { getStatusLabel } from '../utils/statusPresentation';

const CD_FORMAT_LABELS = {
  flac: 'FLAC',
  wav: 'WAV',
  mp3: 'MP3',
  opus: 'Opus',
  ogg: 'Ogg Vorbis'
};

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

function normalizeIdList(values) {
  const list = Array.isArray(values) ? values : [];
  const seen = new Set();
  const output = [];
  for (const value of list) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      continue;
    }
    const id = Math.trunc(parsed);
    const key = String(id);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    output.push(id);
  }
  return output;
}

function normalizePositiveInteger(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return Math.trunc(parsed);
}

function formatDurationSeconds(totalSeconds) {
  const parsed = Number(totalSeconds);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  const rounded = Math.max(0, Math.trunc(parsed));
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);
  const seconds = rounded % 60;
  if (hours > 0) {
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function shellQuote(value) {
  const raw = String(value ?? '');
  if (raw.length === 0) {
    return "''";
  }
  if (/^[A-Za-z0-9_./:=,+-]+$/.test(raw)) {
    return raw;
  }
  return `'${raw.replace(/'/g, `'"'"'`)}'`;
}

function buildExecutedHandBrakeCommand(handbrakeInfo) {
  const cmd = String(handbrakeInfo?.cmd || '').trim();
  const args = Array.isArray(handbrakeInfo?.args) ? handbrakeInfo.args : [];
  if (!cmd) {
    return null;
  }
  return `${cmd} ${args.map((arg) => shellQuote(arg)).join(' ')}`.trim();
}

function buildConfiguredScriptAndChainSelection(job) {
  const plan = job?.encodePlan && typeof job.encodePlan === 'object' ? job.encodePlan : {};
  const handbrakeInfo = job?.handbrakeInfo && typeof job.handbrakeInfo === 'object' ? job.handbrakeInfo : {};
  const scriptNameById = new Map();
  const chainNameById = new Map();

  const addScriptHint = (idValue, nameValue) => {
    const id = normalizeIdList([idValue])[0] || null;
    const name = String(nameValue || '').trim();
    if (!id || !name || scriptNameById.has(id)) {
      return;
    }
    scriptNameById.set(id, name);
  };

  const addChainHint = (idValue, nameValue) => {
    const id = normalizeIdList([idValue])[0] || null;
    const name = String(nameValue || '').trim();
    if (!id || !name || chainNameById.has(id)) {
      return;
    }
    chainNameById.set(id, name);
  };

  const addScriptHintsFromList = (list) => {
    for (const item of (Array.isArray(list) ? list : [])) {
      addScriptHint(item?.id ?? item?.scriptId, item?.name ?? item?.scriptName);
    }
  };

  const addChainHintsFromList = (list) => {
    for (const item of (Array.isArray(list) ? list : [])) {
      addChainHint(item?.id ?? item?.chainId, item?.name ?? item?.chainName);
    }
  };

  addScriptHintsFromList(plan?.preEncodeScripts);
  addScriptHintsFromList(plan?.postEncodeScripts);
  addChainHintsFromList(plan?.preEncodeChains);
  addChainHintsFromList(plan?.postEncodeChains);

  const scriptSummaries = [handbrakeInfo?.preEncodeScripts, handbrakeInfo?.postEncodeScripts];
  for (const summary of scriptSummaries) {
    const results = Array.isArray(summary?.results) ? summary.results : [];
    for (const result of results) {
      addScriptHint(result?.scriptId, result?.scriptName);
      addChainHint(result?.chainId, result?.chainName);
    }
  }

  const preScriptIds = normalizeIdList([
    ...(Array.isArray(plan?.preEncodeScriptIds) ? plan.preEncodeScriptIds : []),
    ...(Array.isArray(plan?.preEncodeScripts) ? plan.preEncodeScripts.map((item) => item?.id ?? item?.scriptId) : [])
  ]);
  const postScriptIds = normalizeIdList([
    ...(Array.isArray(plan?.postEncodeScriptIds) ? plan.postEncodeScriptIds : []),
    ...(Array.isArray(plan?.postEncodeScripts) ? plan.postEncodeScripts.map((item) => item?.id ?? item?.scriptId) : [])
  ]);
  const preChainIds = normalizeIdList([
    ...(Array.isArray(plan?.preEncodeChainIds) ? plan.preEncodeChainIds : []),
    ...(Array.isArray(plan?.preEncodeChains) ? plan.preEncodeChains.map((item) => item?.id ?? item?.chainId) : [])
  ]);
  const postChainIds = normalizeIdList([
    ...(Array.isArray(plan?.postEncodeChainIds) ? plan.postEncodeChainIds : []),
    ...(Array.isArray(plan?.postEncodeChains) ? plan.postEncodeChains.map((item) => item?.id ?? item?.chainId) : [])
  ]);

  return {
    preScriptIds,
    postScriptIds,
    preChainIds,
    postChainIds,
    preScripts: preScriptIds.map((id) => scriptNameById.get(id) || `Skript #${id}`),
    postScripts: postScriptIds.map((id) => scriptNameById.get(id) || `Skript #${id}`),
    preChains: preChainIds.map((id) => chainNameById.get(id) || `Kette #${id}`),
    postChains: postChainIds.map((id) => chainNameById.get(id) || `Kette #${id}`),
    scriptCatalog: Array.from(scriptNameById.entries()).map(([id, name]) => ({ id, name })),
    chainCatalog: Array.from(chainNameById.entries()).map(([id, name]) => ({ id, name }))
  };
}

function resolveMediaType(job) {
  const encodePlan = job?.encodePlan && typeof job.encodePlan === 'object' ? job.encodePlan : null;
  const candidates = [
    job?.mediaType,
    job?.media_type,
    job?.mediaProfile,
    job?.media_profile,
    encodePlan?.mediaProfile,
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
    if (['cd', 'audio_cd', 'audio cd'].includes(raw)) {
      return 'cd';
    }
  }
  const statusCandidates = [job?.status, job?.last_state, job?.makemkvInfo?.lastState];
  if (statusCandidates.some((v) => String(v || '').trim().toUpperCase().startsWith('CD_'))) {
    return 'cd';
  }
  const planFormat = String(encodePlan?.format || '').trim().toLowerCase();
  const hasCdTracksInPlan = Array.isArray(encodePlan?.selectedTracks) && encodePlan.selectedTracks.length > 0;
  if (hasCdTracksInPlan && ['flac', 'wav', 'mp3', 'opus', 'ogg'].includes(planFormat)) {
    return 'cd';
  }
  if (String(job?.handbrakeInfo?.mode || '').trim().toLowerCase() === 'cd_rip') {
    return 'cd';
  }
  if (Array.isArray(job?.makemkvInfo?.tracks) && job.makemkvInfo.tracks.length > 0) {
    return 'cd';
  }
  return 'other';
}

function resolveCdDetails(job) {
  const encodePlan = job?.encodePlan && typeof job.encodePlan === 'object' ? job.encodePlan : {};
  const makemkvInfo = job?.makemkvInfo && typeof job.makemkvInfo === 'object' ? job.makemkvInfo : {};
  const selectedMetadata = makemkvInfo?.selectedMetadata && typeof makemkvInfo.selectedMetadata === 'object'
    ? makemkvInfo.selectedMetadata
    : {};
  const tracksSource = Array.isArray(makemkvInfo?.tracks) && makemkvInfo.tracks.length > 0
    ? makemkvInfo.tracks
    : (Array.isArray(encodePlan?.tracks) ? encodePlan.tracks : []);
  const tracks = tracksSource
    .map((track) => {
      const position = normalizePositiveInteger(track?.position);
      if (!position) {
        return null;
      }
      return { ...track, position, selected: track?.selected !== false };
    })
    .filter(Boolean);
  const selectedTracksFromPlan = Array.isArray(encodePlan?.selectedTracks)
    ? encodePlan.selectedTracks.map((v) => normalizePositiveInteger(v)).filter(Boolean)
    : [];
  const selectedTrackPositions = selectedTracksFromPlan.length > 0
    ? selectedTracksFromPlan
    : tracks.filter((t) => t.selected !== false).map((t) => t.position);
  const fallbackArtist = tracks.map((t) => String(t?.artist || '').trim()).find(Boolean) || null;
  const fallbackAlbum = tracks.map((t) => String(t?.album || '').trim()).find(Boolean) || null;
  const totalDurationSec = tracks.reduce((sum, t) => {
    const ms = Number(t?.durationMs);
    const sec = Number(t?.durationSec);
    if (Number.isFinite(ms) && ms > 0) {
      return sum + ms / 1000;
    }
    if (Number.isFinite(sec) && sec > 0) {
      return sum + sec;
    }
    return sum;
  }, 0);
  const format = String(encodePlan?.format || '').trim().toLowerCase();
  const mbId = String(
    selectedMetadata?.mbId
    || selectedMetadata?.musicBrainzId
    || selectedMetadata?.musicbrainzId
    || selectedMetadata?.mbid
    || ''
  ).trim() || null;

  return {
    artist: String(selectedMetadata?.artist || '').trim() || fallbackArtist || null,
    album: String(selectedMetadata?.album || '').trim() || fallbackAlbum || null,
    trackCount: tracks.length,
    selectedTrackCount: selectedTrackPositions.length,
    format,
    formatLabel: format ? (CD_FORMAT_LABELS[format] || format.toUpperCase()) : null,
    totalDurationLabel: formatDurationSeconds(totalDurationSec),
    mbId
  };
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
  onRetry,
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
  const isCd = mediaType === 'cd';
  const cdDetails = isCd ? resolveCdDetails(job) : null;
  const canRetry = isCd && !running && typeof onRetry === 'function';
  const mediaTypeLabel = mediaType === 'bluray'
    ? 'Blu-ray'
    : mediaType === 'dvd'
      ? 'DVD'
      : isCd
        ? 'Audio CD'
        : 'Sonstiges Medium';
  const mediaTypeIcon = mediaType === 'bluray'
    ? blurayIndicatorIcon
    : mediaType === 'dvd'
      ? discIndicatorIcon
      : otherIndicatorIcon;
  const mediaTypeAlt = mediaTypeLabel;
  const statusMeta = statusBadgeMeta(job?.status, queueLocked);
  const omdbInfo = job?.omdbInfo && typeof job.omdbInfo === 'object' ? job.omdbInfo : {};
  const configuredSelection = buildConfiguredScriptAndChainSelection(job);
  const hasConfiguredSelection = configuredSelection.preScriptIds.length > 0
    || configuredSelection.postScriptIds.length > 0
    || configuredSelection.preChainIds.length > 0
    || configuredSelection.postChainIds.length > 0;
  const reviewPreEncodeItems = [
    ...configuredSelection.preScriptIds.map((id) => ({ type: 'script', id })),
    ...configuredSelection.preChainIds.map((id) => ({ type: 'chain', id }))
  ];
  const reviewPostEncodeItems = [
    ...configuredSelection.postScriptIds.map((id) => ({ type: 'script', id })),
    ...configuredSelection.postChainIds.map((id) => ({ type: 'chain', id }))
  ];
  const encodePlanUserPreset = job?.encodePlan?.userPreset && typeof job.encodePlan.userPreset === 'object'
    ? job.encodePlan.userPreset
    : null;
  const encodePlanUserPresetId = Number(encodePlanUserPreset?.id);
  const reviewUserPresets = encodePlanUserPreset ? [encodePlanUserPreset] : [];
  const executedHandBrakeCommand = buildExecutedHandBrakeCommand(job?.handbrakeInfo);

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
              <div className="poster-large poster-fallback">{isCd ? 'Kein Cover' : 'Kein Poster'}</div>
            )}

            <div className="job-film-info-grid">
              {isCd ? (
                <section className="job-meta-block job-meta-block-film">
                  <h4>Musik-Infos</h4>
                  <div className="job-meta-list">
                    <div className="job-meta-item">
                      <strong>Album:</strong>
                      <span>{job.title || job.detected_title || cdDetails?.album || '-'}</span>
                    </div>
                    <div className="job-meta-item">
                      <strong>Interpret:</strong>
                      <span>{cdDetails?.artist || '-'}</span>
                    </div>
                    <div className="job-meta-item">
                      <strong>Jahr:</strong>
                      <span>{job.year || '-'}</span>
                    </div>
                    <div className="job-meta-item">
                      <strong>Tracks:</strong>
                      <span>
                        {cdDetails?.trackCount > 0
                          ? (cdDetails.selectedTrackCount > 0 && cdDetails.selectedTrackCount !== cdDetails.trackCount
                            ? `${cdDetails.selectedTrackCount}/${cdDetails.trackCount}`
                            : String(cdDetails.trackCount))
                          : '-'}
                      </span>
                    </div>
                    <div className="job-meta-item">
                      <strong>Format:</strong>
                      <span>{cdDetails?.formatLabel || '-'}</span>
                    </div>
                    <div className="job-meta-item">
                      <strong>Gesamtdauer:</strong>
                      <span>{cdDetails?.totalDurationLabel || '-'}</span>
                    </div>
                    <div className="job-meta-item">
                      <strong>MusicBrainz ID:</strong>
                      <span>{cdDetails?.mbId || '-'}</span>
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
              ) : (
                <>
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
                </>
              )}
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
                <strong>{isCd ? 'WAV Pfad:' : 'RAW Pfad:'}</strong> {job.raw_path || '-'}
              </div>
              <div>
                <strong>Output:</strong> {job.output_path || '-'}
              </div>
              {!isCd ? (
                <div>
                  <strong>Encode Input:</strong> {job.encode_input_path || '-'}
                </div>
              ) : null}
              <div>
                <strong>RAW vorhanden:</strong> <BoolState value={job.rawStatus?.exists} />
              </div>
              <div>
                <strong>{isCd ? 'Audio-Dateien vorhanden:' : 'Movie Datei vorhanden:'}</strong> <BoolState value={job.outputStatus?.exists} />
              </div>
              {isCd ? (
                <div>
                  <strong>Rip erfolgreich:</strong> <BoolState value={job?.ripSuccessful} />
                </div>
              ) : (
                <>
                  <div>
                    <strong>Backup erfolgreich:</strong> <BoolState value={job?.backupSuccess} />
                  </div>
                  <div>
                    <strong>Encode erfolgreich:</strong> <BoolState value={job?.encodeSuccess} />
                  </div>
                </>
              )}
              <div className="job-meta-col-span-2">
                <strong>Letzter Fehler:</strong> {job.error_message || '-'}
              </div>
            </div>
          </section>

          {!isCd && (hasConfiguredSelection || encodePlanUserPreset) ? (
            <section className="job-meta-block job-meta-block-full">
              <h4>Hinterlegte Encode-Auswahl</h4>
              <div className="job-configured-selection-grid">
                <div>
                  <strong>Pre-Encode Skripte:</strong> {configuredSelection.preScripts.length > 0 ? configuredSelection.preScripts.join(' | ') : '-'}
                </div>
                <div>
                  <strong>Pre-Encode Ketten:</strong> {configuredSelection.preChains.length > 0 ? configuredSelection.preChains.join(' | ') : '-'}
                </div>
                <div>
                  <strong>Post-Encode Skripte:</strong> {configuredSelection.postScripts.length > 0 ? configuredSelection.postScripts.join(' | ') : '-'}
                </div>
                <div>
                  <strong>Post-Encode Ketten:</strong> {configuredSelection.postChains.length > 0 ? configuredSelection.postChains.join(' | ') : '-'}
                </div>
                <div className="job-meta-col-span-2">
                  <strong>User-Preset:</strong>{' '}
                  {encodePlanUserPreset
                    ? `${encodePlanUserPreset.name || '-'} | Preset=${encodePlanUserPreset.handbrakePreset || '-'} | ExtraArgs=${encodePlanUserPreset.extraArgs || '-'}`
                    : '-'}
                </div>
              </div>
            </section>
          ) : null}

          {!isCd && executedHandBrakeCommand ? (
            <section className="job-meta-block job-meta-block-full">
              <h4>Ausgeführter Encode-Befehl</h4>
              <div className="handbrake-command-preview">
                <small><strong>HandBrakeCLI (tatsächlich gestartet):</strong></small>
                <pre>{executedHandBrakeCommand}</pre>
              </div>
            </section>
          ) : null}

          {!isCd && (job.handbrakeInfo?.preEncodeScripts?.configured > 0 || job.handbrakeInfo?.postEncodeScripts?.configured > 0) ? (
            <section className="job-meta-block job-meta-block-full">
              <h4>Skripte</h4>
              <div className="script-results-grid">
                <ScriptSummarySection title="Pre-Encode" summary={job.handbrakeInfo?.preEncodeScripts} />
                <ScriptSummarySection title="Post-Encode" summary={job.handbrakeInfo?.postEncodeScripts} />
              </div>
            </section>
          ) : null}

          <div className="job-json-grid">
            {!isCd ? <JsonView title="OMDb Info" value={job.omdbInfo} /> : null}
            <JsonView title={isCd ? 'cdparanoia Info' : 'MakeMKV Info'} value={job.makemkvInfo} />
            {!isCd ? <JsonView title="Mediainfo Info" value={job.mediainfoInfo} /> : null}
            <JsonView title={isCd ? 'Rip-Plan' : 'Encode Plan'} value={job.encodePlan} />
            {!isCd ? <JsonView title="HandBrake Info" value={job.handbrakeInfo} /> : null}
          </div>

          {!isCd && job.encodePlan ? (
            <>
              <h4>Mediainfo-Prüfung (Auswertung)</h4>
              <MediaInfoReviewPanel
                review={job.encodePlan}
                commandOutputPath={job.output_path || null}
                availableScripts={configuredSelection.scriptCatalog}
                availableChains={configuredSelection.chainCatalog}
                preEncodeItems={reviewPreEncodeItems}
                postEncodeItems={reviewPostEncodeItems}
                userPresets={reviewUserPresets}
                selectedUserPresetId={Number.isFinite(encodePlanUserPresetId) && encodePlanUserPresetId > 0
                  ? Math.trunc(encodePlanUserPresetId)
                  : null}
              />
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
                {!isCd ? (
                  <Button
                    label="OMDb neu zuordnen"
                    icon="pi pi-search"
                    severity="secondary"
                    size="small"
                    onClick={() => onAssignOmdb?.(job)}
                    loading={omdbAssignBusy}
                    disabled={running || typeof onAssignOmdb !== 'function'}
                  />
                ) : null}
                {!isCd && canResumeReady ? (
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
                {!isCd && typeof onRestartEncode === 'function' ? (
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
                {!isCd && typeof onRestartReview === 'function' ? (
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
                {!isCd ? (
                  <Button
                    label="RAW neu encodieren"
                    icon="pi pi-cog"
                    severity="info"
                    size="small"
                    onClick={() => onReencode?.(job)}
                    loading={reencodeBusy}
                    disabled={!canReencode || typeof onReencode !== 'function'}
                  />
                ) : null}
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
                  label={isCd ? 'Audio löschen' : 'Movie löschen'}
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
