import { useEffect, useMemo, useState } from 'react';
import { Card } from 'primereact/card';
import { Tag } from 'primereact/tag';
import { ProgressBar } from 'primereact/progressbar';
import { Button } from 'primereact/button';
import MediaInfoReviewPanel from './MediaInfoReviewPanel';
import { api } from '../api/client';
import { getStatusLabel, getStatusSeverity } from '../utils/statusPresentation';

function normalizeTitleId(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return Math.trunc(parsed);
}

function normalizePlaylistId(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) {
    return null;
  }
  const match = raw.match(/(\d{1,5})(?:\.mpls)?$/i);
  return match ? String(match[1]).padStart(5, '0') : null;
}

function normalizeTrackId(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return Math.trunc(parsed);
}

function normalizeTrackIdList(values) {
  const list = Array.isArray(values) ? values : [];
  const seen = new Set();
  const output = [];
  for (const value of list) {
    const normalized = normalizeTrackId(value);
    if (normalized === null) {
      continue;
    }
    const key = String(normalized);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    output.push(normalized);
  }
  return output;
}

function normalizeScriptId(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return Math.trunc(parsed);
}

function normalizeScriptIdList(values) {
  const list = Array.isArray(values) ? values : [];
  const seen = new Set();
  const output = [];
  for (const value of list) {
    const normalized = normalizeScriptId(value);
    if (normalized === null) {
      continue;
    }
    const key = String(normalized);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    output.push(normalized);
  }
  return output;
}

function isBurnedSubtitleTrack(track) {
  const flags = Array.isArray(track?.subtitlePreviewFlags)
    ? track.subtitlePreviewFlags
    : (Array.isArray(track?.flags) ? track.flags : []);
  const hasBurnedFlag = flags.some((flag) => String(flag || '').trim().toLowerCase() === 'burned');
  const summary = `${track?.subtitlePreviewSummary || ''} ${track?.subtitleActionSummary || ''}`;
  return Boolean(
    track?.subtitlePreviewBurnIn
    || track?.burnIn
    || hasBurnedFlag
    || /burned/i.test(summary)
  );
}

function buildDefaultTrackSelection(review) {
  const titles = Array.isArray(review?.titles) ? review.titles : [];
  const selection = {};

  for (const title of titles) {
    const titleId = normalizeTitleId(title?.id);
    if (!titleId) {
      continue;
    }

    selection[titleId] = {
      audioTrackIds: normalizeTrackIdList(
        (Array.isArray(title?.audioTracks) ? title.audioTracks : [])
          .filter((track) => Boolean(track?.selectedByRule))
          .map((track) => track?.id)
      ),
      subtitleTrackIds: normalizeTrackIdList(
        (Array.isArray(title?.subtitleTracks) ? title.subtitleTracks : [])
          .filter((track) => Boolean(track?.selectedByRule) && !isBurnedSubtitleTrack(track))
          .map((track) => track?.id)
      )
    };
  }

  return selection;
}

function defaultTrackSelectionForTitle(review, titleId) {
  const defaults = buildDefaultTrackSelection(review);
  return defaults[titleId] || defaults[String(titleId)] || { audioTrackIds: [], subtitleTrackIds: [] };
}

function buildSettingsMap(categories) {
  const map = {};
  const list = Array.isArray(categories) ? categories : [];
  for (const category of list) {
    for (const setting of (Array.isArray(category?.settings) ? category.settings : [])) {
      map[setting.key] = setting.value;
    }
  }
  return map;
}

function buildPresetDisplayMap(options) {
  const map = {};
  const list = Array.isArray(options) ? options : [];
  for (const option of list) {
    if (!option || option.disabled) {
      continue;
    }
    const value = String(option.value || '').trim();
    if (!value) {
      continue;
    }
    const category = String(option.category || '').trim();
    map[value] = category ? `${category}/${value}` : value;
  }
  return map;
}

function sanitizeFileName(input) {
  return String(input || 'untitled')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180);
}

function renderTemplate(template, values) {
  return String(template || '${title} (${year})').replace(/\$\{([^}]+)\}/g, (_, key) => {
    const value = values[key.trim()];
    if (value === undefined || value === null || value === '') {
      return 'unknown';
    }
    return String(value);
  });
}

function buildOutputPathPreview(settings, metadata, fallbackJobId = null) {
  const movieDir = String(settings?.movie_dir || '').trim();
  if (!movieDir) {
    return null;
  }

  const title = metadata?.title || (fallbackJobId ? `job-${fallbackJobId}` : 'job');
  const year = metadata?.year || new Date().getFullYear();
  const imdbId = metadata?.imdbId || (fallbackJobId ? `job-${fallbackJobId}` : 'noimdb');
  const fileTemplate = settings?.filename_template || '${title} (${year})';
  const folderTemplate = String(settings?.output_folder_template || '').trim() || fileTemplate;
  const folderName = sanitizeFileName(renderTemplate(folderTemplate, { title, year, imdbId }));
  const baseName = sanitizeFileName(renderTemplate(fileTemplate, { title, year, imdbId }));
  const ext = String(settings?.output_extension || 'mkv').trim() || 'mkv';
  const root = movieDir.replace(/\/+$/g, '');
  return `${root}/${folderName}/${baseName}.${ext}`;
}

export default function PipelineStatusCard({
  pipeline,
  onAnalyze,
  onReanalyze,
  onOpenMetadata,
  onStart,
  onRemoveFromQueue,
  onRestartEncode,
  onRestartReview,
  onConfirmReview,
  onSelectPlaylist,
  onCancel,
  onRetry,
  isQueued = false,
  busy,
  liveJobLog = ''
}) {
  const state = pipeline?.state || 'IDLE';
  const stateLabel = getStatusLabel(state);
  const progress = Number(pipeline?.progress || 0);
  const running = state === 'ANALYZING' || state === 'RIPPING' || state === 'ENCODING' || state === 'MEDIAINFO_CHECK';
  const retryJobId = pipeline?.context?.jobId;
  const queueLocked = Boolean(isQueued && retryJobId);
  const selectedMetadata = pipeline?.context?.selectedMetadata || null;
  const mediaInfoReview = pipeline?.context?.mediaInfoReview || null;
  const playlistAnalysis = pipeline?.context?.playlistAnalysis || null;
  const encodeInputPath = pipeline?.context?.inputPath || mediaInfoReview?.encodeInputPath || null;
  const reviewConfirmed = Boolean(pipeline?.context?.reviewConfirmed || mediaInfoReview?.reviewConfirmed);
  const reviewMode = String(mediaInfoReview?.mode || '').trim().toLowerCase();
  const isPreRipReview = reviewMode === 'pre_rip' || Boolean(mediaInfoReview?.preRip);
  const [selectedEncodeTitleId, setSelectedEncodeTitleId] = useState(null);
  const [selectedPlaylistId, setSelectedPlaylistId] = useState(null);
  const [trackSelectionByTitle, setTrackSelectionByTitle] = useState({});
  const [settingsMap, setSettingsMap] = useState({});
  const [presetDisplayMap, setPresetDisplayMap] = useState({});
  const [scriptCatalog, setScriptCatalog] = useState([]);
  const [selectedPostEncodeScriptIds, setSelectedPostEncodeScriptIds] = useState([]);

  useEffect(() => {
    let cancelled = false;
    const loadSettings = async () => {
      try {
        const [settingsResponse, presetsResponse, scriptsResponse] = await Promise.allSettled([
          api.getSettings(),
          api.getHandBrakePresets(),
          api.getScripts()
        ]);
        if (!cancelled) {
          const categories = settingsResponse.status === 'fulfilled'
            ? (settingsResponse.value?.categories || [])
            : [];
          setSettingsMap(buildSettingsMap(categories));
          const presetOptions = presetsResponse.status === 'fulfilled'
            ? (presetsResponse.value?.options || [])
            : [];
          setPresetDisplayMap(buildPresetDisplayMap(presetOptions));
          const scripts = scriptsResponse.status === 'fulfilled'
            ? (Array.isArray(scriptsResponse.value?.scripts) ? scriptsResponse.value.scripts : [])
            : [];
          setScriptCatalog(
            scripts.map((item) => ({
              id: item?.id,
              name: item?.name
            }))
          );
        }
      } catch (_error) {
        if (!cancelled) {
          setSettingsMap({});
          setPresetDisplayMap({});
          setScriptCatalog([]);
        }
      }
    };
    loadSettings();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const fromReview = normalizeTitleId(mediaInfoReview?.encodeInputTitleId);
    setSelectedEncodeTitleId(fromReview);
    setTrackSelectionByTitle(buildDefaultTrackSelection(mediaInfoReview));
    setSelectedPostEncodeScriptIds(
      normalizeScriptIdList(mediaInfoReview?.postEncodeScriptIds || [])
    );
  }, [mediaInfoReview?.encodeInputTitleId, mediaInfoReview?.generatedAt, retryJobId]);

  useEffect(() => {
    const currentTitleId = normalizeTitleId(selectedEncodeTitleId);
    if (!currentTitleId) {
      return;
    }

    setTrackSelectionByTitle((prev) => {
      if (prev?.[currentTitleId] || prev?.[String(currentTitleId)]) {
        return prev;
      }

      const defaults = buildDefaultTrackSelection(mediaInfoReview);
      const fallback = defaults[currentTitleId] || { audioTrackIds: [], subtitleTrackIds: [] };
      return {
        ...prev,
        [currentTitleId]: fallback
      };
    });
  }, [selectedEncodeTitleId, mediaInfoReview?.generatedAt]);

  const reviewPlaylistDecisionRequired = Boolean(mediaInfoReview?.playlistDecisionRequired);
  const hasSelectedEncodeTitle = Boolean(normalizeTitleId(selectedEncodeTitleId));
  const canConfirmReview = !reviewPlaylistDecisionRequired || hasSelectedEncodeTitle;
  const canStartReadyJob = isPreRipReview
    ? Boolean(retryJobId)
    : Boolean(retryJobId && encodeInputPath);
  const canRestartEncodeFromLastSettings = Boolean(
    (state === 'ERROR' || state === 'CANCELLED')
    && retryJobId
    && pipeline?.context?.canRestartEncodeFromLastSettings
  );
  const canRestartReviewFromRaw = Boolean(
    retryJobId
    && !running
    && (pipeline?.context?.canRestartReviewFromRaw || pipeline?.context?.rawPath)
  );

  const waitingPlaylistRows = useMemo(() => {
    const evaluated = Array.isArray(playlistAnalysis?.evaluatedCandidates)
      ? playlistAnalysis.evaluatedCandidates
      : [];

    const rows = evaluated.length > 0
      ? evaluated
      : (Array.isArray(pipeline?.context?.playlistCandidates) ? pipeline.context.playlistCandidates : []);

    const normalized = rows
      .map((item) => {
        const playlistId = normalizePlaylistId(item?.playlistId || item?.playlistFile || item);
        if (!playlistId) {
          return null;
        }
        const playlistFile = `${playlistId}.mpls`;
        const score = Number(item?.score);
        const sequenceCoherence = Number(
          item?.structuralMetrics?.sequenceCoherence ?? item?.sequenceCoherence
        );
        const handBrakeTitleId = Number(item?.handBrakeTitleId);
        return {
          playlistId,
          playlistFile,
          titleId: Number.isFinite(Number(item?.titleId)) ? Number(item.titleId) : null,
          score: Number.isFinite(score) ? score : null,
          evaluationLabel: item?.evaluationLabel || null,
          segmentCommand: item?.segmentCommand
            || `strings BDMV/PLAYLIST/${playlistId}.mpls | grep m2ts`,
          segmentFiles: Array.isArray(item?.segmentFiles) ? item.segmentFiles : [],
          sequenceCoherence: Number.isFinite(sequenceCoherence) ? sequenceCoherence : null,
          recommended: Boolean(item?.recommended),
          handBrakeTitleId: Number.isFinite(handBrakeTitleId) && handBrakeTitleId > 0
            ? Math.trunc(handBrakeTitleId)
            : null,
          audioSummary: item?.audioSummary || null,
          audioTrackPreview: Array.isArray(item?.audioTrackPreview) ? item.audioTrackPreview : []
        };
      })
      .filter(Boolean);

    const dedup = [];
    const seen = new Set();
    for (const row of normalized) {
      if (seen.has(row.playlistId)) {
        continue;
      }
      seen.add(row.playlistId);
      dedup.push(row);
    }
    return dedup;
  }, [playlistAnalysis, pipeline?.context?.playlistCandidates]);

  useEffect(() => {
    if (state !== 'WAITING_FOR_USER_DECISION') {
      setSelectedPlaylistId(null);
      return;
    }

    const current = normalizePlaylistId(pipeline?.context?.selectedPlaylist);
    if (current) {
      setSelectedPlaylistId(current);
      return;
    }

    const recommendedFromRows = waitingPlaylistRows.find((item) => item.recommended)?.playlistId || null;
    const recommendedFromAnalysis = normalizePlaylistId(playlistAnalysis?.recommendation?.playlistId);
    const fallback = waitingPlaylistRows[0]?.playlistId || null;
    setSelectedPlaylistId(recommendedFromRows || recommendedFromAnalysis || fallback);
  }, [
    state,
    retryJobId,
    waitingPlaylistRows,
    playlistAnalysis?.recommendation?.playlistId,
    pipeline?.context?.selectedPlaylist
  ]);

  const playlistDecisionRequiredBeforeStart = state === 'WAITING_FOR_USER_DECISION';
  const commandOutputPath = useMemo(
    () => buildOutputPathPreview(settingsMap, selectedMetadata, retryJobId),
    [settingsMap, selectedMetadata, retryJobId]
  );
  const presetDisplayValue = useMemo(() => {
    const preset = String(mediaInfoReview?.selectors?.preset || '').trim();
    if (!preset) {
      return '';
    }
    return presetDisplayMap[preset] || preset;
  }, [mediaInfoReview?.selectors?.preset, presetDisplayMap]);
  const buildSelectedTrackSelectionForCurrentTitle = () => {
    const encodeTitleId = normalizeTitleId(selectedEncodeTitleId);
    const selectionEntry = encodeTitleId
      ? (trackSelectionByTitle?.[encodeTitleId] || trackSelectionByTitle?.[String(encodeTitleId)] || null)
      : null;
    const fallbackSelection = encodeTitleId
      ? defaultTrackSelectionForTitle(mediaInfoReview, encodeTitleId)
      : { audioTrackIds: [], subtitleTrackIds: [] };
    const effectiveSelection = selectionEntry || fallbackSelection;
    const encodeTitle = encodeTitleId
      ? (Array.isArray(mediaInfoReview?.titles)
        ? (mediaInfoReview.titles.find((title) => normalizeTitleId(title?.id) === encodeTitleId) || null)
        : null)
      : null;
    const blockedSubtitleTrackIds = new Set(
      (Array.isArray(encodeTitle?.subtitleTracks) ? encodeTitle.subtitleTracks : [])
        .filter((track) => isBurnedSubtitleTrack(track))
        .map((track) => normalizeTrackId(track?.id))
        .filter((id) => id !== null)
        .map((id) => String(id))
    );
    const selectedTrackSelection = encodeTitleId
      ? {
        [encodeTitleId]: {
          audioTrackIds: normalizeTrackIdList(effectiveSelection?.audioTrackIds || []),
          subtitleTrackIds: normalizeTrackIdList(effectiveSelection?.subtitleTrackIds || [])
            .filter((id) => !blockedSubtitleTrackIds.has(String(id)))
        }
      }
      : null;
    const selectedPostScriptIds = normalizeScriptIdList(selectedPostEncodeScriptIds);
    return {
      encodeTitleId,
      selectedTrackSelection,
      selectedPostScriptIds
    };
  };

  return (
    <Card title="Pipeline-Status" subTitle="Live-Zustand und Fortschritt">
      <div className="status-row">
        <Tag value={stateLabel} severity={getStatusSeverity(state)} />
        <span>{pipeline?.statusText || 'Bereit'}</span>
      </div>

      {running && (
        <div className="progress-wrap">
          <ProgressBar value={progress} showValue />
          <small>{pipeline?.eta ? `ETA ${pipeline.eta}` : 'ETA unbekannt'}</small>
        </div>
      )}

      {state === 'FINISHED' && (
        <div className="progress-wrap">
          <ProgressBar value={100} showValue />
        </div>
      )}

      <div className="actions-row">
        {queueLocked ? (
          <Button
            label="Aus Queue löschen"
            icon="pi pi-times"
            severity="danger"
            outlined
            onClick={() => onRemoveFromQueue?.(retryJobId)}
            loading={busy}
            disabled={typeof onRemoveFromQueue !== 'function'}
          />
        ) : (
          <>
            {(state === 'DISC_DETECTED' || state === 'IDLE') && (
              <Button
                label="Analyse starten"
                icon="pi pi-search"
                onClick={onAnalyze}
                loading={busy}
              />
            )}

            {(state === 'METADATA_SELECTION' || state === 'WAITING_FOR_USER_DECISION') && retryJobId && typeof onOpenMetadata === 'function' ? (
              <Button
                label="Metadaten öffnen"
                icon="pi pi-list"
                severity="info"
                onClick={() => onOpenMetadata?.(retryJobId)}
                loading={busy}
              />
            ) : null}

            {state === 'READY_TO_START' && retryJobId ? (
              <Button
                label="Job starten"
                icon="pi pi-play"
                severity="success"
                onClick={() => onStart(retryJobId)}
                loading={busy}
              />
            ) : null}

            {playlistDecisionRequiredBeforeStart && retryJobId && (
              <Button
                label="Playlist übernehmen"
                icon="pi pi-check"
                severity="warning"
                outlined
                onClick={() => onSelectPlaylist?.(retryJobId, selectedPlaylistId)}
                loading={busy}
                disabled={!normalizePlaylistId(selectedPlaylistId)}
              />
            )}

            {state === 'READY_TO_ENCODE' && retryJobId ? (
              <Button
                label={isPreRipReview ? 'Backup + Encoding starten' : 'Encoding starten'}
                icon="pi pi-play"
                severity="success"
                onClick={async () => {
                  const requiresAutoConfirm = !reviewConfirmed;
                  if (!requiresAutoConfirm) {
                    await onStart(retryJobId);
                    return;
                  }

                  const {
                    encodeTitleId,
                    selectedTrackSelection,
                    selectedPostScriptIds
                  } = buildSelectedTrackSelectionForCurrentTitle();
                  await onStart(retryJobId, {
                    ensureConfirmed: true,
                    selectedEncodeTitleId: encodeTitleId,
                    selectedTrackSelection,
                    selectedPostEncodeScriptIds: selectedPostScriptIds
                  });
                }}
                loading={busy}
                disabled={!canStartReadyJob || !canConfirmReview}
              />
            ) : null}

            {running && (
              <Button
                label="Abbrechen"
                icon="pi pi-stop"
                severity="danger"
                onClick={() => onCancel?.(retryJobId, state)}
                loading={busy}
              />
            )}

            {canRestartReviewFromRaw ? (
              <Button
                label="Review neu starten"
                icon="pi pi-refresh"
                severity="info"
                outlined
                onClick={() => onRestartReview?.(retryJobId)}
                loading={busy}
                disabled={!retryJobId}
              />
            ) : null}

            {canRestartEncodeFromLastSettings ? (
              <Button
                label="Encode neu starten"
                icon="pi pi-play"
                severity="success"
                onClick={() => onRestartEncode?.(retryJobId)}
                loading={busy}
                disabled={!retryJobId}
              />
            ) : null}

            {(state === 'ERROR' || state === 'CANCELLED') && retryJobId && (
              <Button
                label="Retry Rippen"
                icon="pi pi-refresh"
                severity="warning"
                onClick={() => onRetry(retryJobId)}
                loading={busy}
              />
            )}

            {(state === 'ERROR' || state === 'CANCELLED') ? (
              <Button
                label="Disk-Analyse neu starten"
                icon="pi pi-search"
                severity="secondary"
                onClick={onReanalyze || onAnalyze}
                loading={busy}
              />
            ) : null}
          </>
        )}
      </div>

      {running ? (
        <div className="live-log-block">
          <h4>Aktueller Job-Log</h4>
          <pre className="log-box">{liveJobLog || 'Noch keine Log-Ausgabe vorhanden.'}</pre>
        </div>
      ) : null}

      {playlistDecisionRequiredBeforeStart && !queueLocked ? (
        <div className="playlist-decision-block">
          <h3>Playlist-Auswahl erforderlich</h3>
          <small>
            Metadaten sind abgeschlossen. Vor Start muss ein Titel/Playlist manuell per Checkbox gewählt werden.
          </small>
          {waitingPlaylistRows.length > 0 ? (
            <div className="playlist-decision-list">
              {waitingPlaylistRows.map((row) => (
                <div key={row.playlistId} className="playlist-decision-item">
                  <label className="readonly-check-row">
                    <input
                      type="checkbox"
                      checked={normalizePlaylistId(selectedPlaylistId) === row.playlistId}
                      disabled={queueLocked}
                      onChange={() => {
                        const next = normalizePlaylistId(selectedPlaylistId) === row.playlistId ? null : row.playlistId;
                        setSelectedPlaylistId(next);
                      }}
                    />
                    <span>
                      {row.playlistFile}
                      {row.titleId !== null ? ` | Titel #${row.titleId}` : ''}
                      {row.score !== null ? ` | Score ${row.score}` : ''}
                      {row.recommended ? ' | empfohlen' : ''}
                    </span>
                  </label>
                  {row.evaluationLabel ? <small className="track-action-note">{row.evaluationLabel}</small> : null}
                  {row.sequenceCoherence !== null ? (
                    <small className="track-action-note">Sequenz-Kohärenz: {row.sequenceCoherence.toFixed(3)}</small>
                  ) : null}
                  {row.handBrakeTitleId !== null ? (
                    <small className="track-action-note">HandBrake Titel: -t {row.handBrakeTitleId}</small>
                  ) : null}
                  {row.audioSummary ? (
                    <small className="track-action-note">Audio: {row.audioSummary}</small>
                  ) : null}
                  {row.segmentCommand ? <small className="track-action-note">Info: {row.segmentCommand}</small> : null}
                  {Array.isArray(row.audioTrackPreview) && row.audioTrackPreview.length > 0 ? (
                    <details className="playlist-segment-toggle">
                      <summary>Audio-Spuren anzeigen ({row.audioTrackPreview.length})</summary>
                      <pre className="playlist-segment-output">{row.audioTrackPreview.join('\n')}</pre>
                    </details>
                  ) : null}
                  {Array.isArray(row.segmentFiles) && row.segmentFiles.length > 0 ? (
                    <details className="playlist-segment-toggle">
                      <summary>Segment-Dateien anzeigen ({row.segmentFiles.length})</summary>
                      <pre className="playlist-segment-output">{row.segmentFiles.join('\n')}</pre>
                    </details>
                  ) : (
                    <small className="track-action-note">Keine Segmentliste aus TINFO:26 verfügbar.</small>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <small>Keine Kandidaten gefunden. Bitte Analyse erneut ausführen.</small>
          )}
        </div>
      ) : null}

      {selectedMetadata ? (
        <div className="pipeline-meta-inline">
          {selectedMetadata.poster ? (
            <img
              src={selectedMetadata.poster}
              alt={selectedMetadata.title || 'Poster'}
              className="poster-large"
            />
          ) : (
            <div className="poster-large poster-fallback">Kein Poster</div>
          )}
          <div className="device-meta">
            <div>
              <strong>Titel:</strong> {selectedMetadata.title || '-'}
            </div>
            <div>
              <strong>Jahr:</strong> {selectedMetadata.year || '-'}
            </div>
            <div>
              <strong>IMDb:</strong> {selectedMetadata.imdbId || '-'}
            </div>
            <div>
              <strong>Status:</strong> {stateLabel}
            </div>
          </div>
        </div>
      ) : null}

      {(state === 'READY_TO_ENCODE' || state === 'MEDIAINFO_CHECK' || mediaInfoReview) ? (
        <div className="mediainfo-review-block">
          <h3>Titel-/Spurprüfung</h3>
          {state === 'READY_TO_ENCODE' && !reviewConfirmed && !queueLocked ? (
            <small>
              {isPreRipReview
                ? 'Spurauswahl kann direkt übernommen werden. Beim Klick auf "Backup + Encoding starten" wird automatisch bestätigt und gestartet.'
                : 'Spurauswahl kann direkt übernommen werden. Beim Klick auf "Encoding starten" wird automatisch bestätigt und gestartet.'}
              {reviewPlaylistDecisionRequired ? ' Bitte den korrekten Titel per Checkbox auswählen.' : ''}
            </small>
          ) : null}
          <MediaInfoReviewPanel
            review={mediaInfoReview}
            presetDisplayValue={presetDisplayValue}
            commandOutputPath={commandOutputPath}
            selectedEncodeTitleId={normalizeTitleId(selectedEncodeTitleId)}
            allowTitleSelection={state === 'READY_TO_ENCODE' && !reviewConfirmed && !queueLocked}
            onSelectEncodeTitle={(titleId) => setSelectedEncodeTitleId(normalizeTitleId(titleId))}
            allowTrackSelection={state === 'READY_TO_ENCODE' && !reviewConfirmed && !queueLocked}
            trackSelectionByTitle={trackSelectionByTitle}
            onTrackSelectionChange={(titleId, trackType, trackId, checked) => {
              const normalizedTitleId = normalizeTitleId(titleId);
              const normalizedTrackId = normalizeTrackId(trackId);
              if (!normalizedTitleId || normalizedTrackId === null) {
                return;
              }

              setTrackSelectionByTitle((prev) => {
                const current = prev?.[normalizedTitleId] || prev?.[String(normalizedTitleId)] || {
                  audioTrackIds: [],
                  subtitleTrackIds: []
                };
                const key = trackType === 'subtitle' ? 'subtitleTrackIds' : 'audioTrackIds';
                const existing = normalizeTrackIdList(current?.[key] || []);
                const next = checked
                  ? normalizeTrackIdList([...existing, normalizedTrackId])
                  : existing.filter((id) => id !== normalizedTrackId);

                return {
                  ...prev,
                  [normalizedTitleId]: {
                    ...current,
                    [key]: next
                  }
                };
              });
            }}
            availablePostScripts={scriptCatalog}
            selectedPostEncodeScriptIds={selectedPostEncodeScriptIds}
            allowPostScriptSelection={state === 'READY_TO_ENCODE' && !reviewConfirmed && !queueLocked}
            onAddPostEncodeScript={() => {
              setSelectedPostEncodeScriptIds((prev) => {
                const normalizedCurrent = normalizeScriptIdList(prev);
                const selectedSet = new Set(normalizedCurrent.map((id) => String(id)));
                const nextCandidate = (Array.isArray(scriptCatalog) ? scriptCatalog : [])
                  .map((item) => normalizeScriptId(item?.id))
                  .find((id) => id !== null && !selectedSet.has(String(id)));
                if (nextCandidate === undefined || nextCandidate === null) {
                  return normalizedCurrent;
                }
                return [...normalizedCurrent, nextCandidate];
              });
            }}
            onChangePostEncodeScript={(rowIndex, nextScriptId) => {
              setSelectedPostEncodeScriptIds((prev) => {
                const normalizedCurrent = normalizeScriptIdList(prev);
                if (!Number.isFinite(Number(rowIndex)) || rowIndex < 0 || rowIndex >= normalizedCurrent.length) {
                  return normalizedCurrent;
                }
                const normalizedScriptId = normalizeScriptId(nextScriptId);
                if (normalizedScriptId === null) {
                  return normalizedCurrent;
                }
                const duplicateAtOtherIndex = normalizedCurrent.some((id, idx) =>
                  idx !== rowIndex && String(id) === String(normalizedScriptId)
                );
                if (duplicateAtOtherIndex) {
                  return normalizedCurrent;
                }
                const next = [...normalizedCurrent];
                next[rowIndex] = normalizedScriptId;
                return next;
              });
            }}
            onRemovePostEncodeScript={(rowIndex) => {
              setSelectedPostEncodeScriptIds((prev) => {
                const normalizedCurrent = normalizeScriptIdList(prev);
                if (!Number.isFinite(Number(rowIndex)) || rowIndex < 0 || rowIndex >= normalizedCurrent.length) {
                  return normalizedCurrent;
                }
                return normalizedCurrent.filter((_, idx) => idx !== rowIndex);
              });
            }}
            onReorderPostEncodeScript={(fromIndex, toIndex) => {
              setSelectedPostEncodeScriptIds((prev) => {
                const normalizedCurrent = normalizeScriptIdList(prev);
                const from = Number(fromIndex);
                const to = Number(toIndex);
                if (!Number.isInteger(from) || !Number.isInteger(to)) {
                  return normalizedCurrent;
                }
                if (from < 0 || to < 0 || from >= normalizedCurrent.length || to >= normalizedCurrent.length) {
                  return normalizedCurrent;
                }
                if (from === to) {
                  return normalizedCurrent;
                }
                const next = [...normalizedCurrent];
                const [moved] = next.splice(from, 1);
                next.splice(to, 0, moved);
                return next;
              });
            }}
          />
        </div>
      ) : null}
    </Card>
  );
}
