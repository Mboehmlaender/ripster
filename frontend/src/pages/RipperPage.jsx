import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Toast } from 'primereact/toast';
import { Card } from 'primereact/card';
import { Button } from 'primereact/button';
import { Tag } from 'primereact/tag';
import { ProgressBar } from 'primereact/progressbar';
import { Dialog } from 'primereact/dialog';
import { InputNumber } from 'primereact/inputnumber';
import { InputText } from 'primereact/inputtext';
import { api } from '../api/client';
import { useWebSocket } from '../hooks/useWebSocket';
import PipelineStatusCard from '../components/PipelineStatusCard';
import MetadataSelectionDialog from '../components/MetadataSelectionDialog';
import CdMetadataDialog from '../components/CdMetadataDialog';
import CdRipConfigPanel from '../components/CdRipConfigPanel';
import AudiobookConfigPanel from '../components/AudiobookConfigPanel';
import blurayIndicatorIcon from '../assets/media-bluray.svg';
import discIndicatorIcon from '../assets/media-disc.svg';
import otherIndicatorIcon from '../assets/media-other.svg';
import audiobookIndicatorIcon from '../assets/media-audiobook.svg';
import mergeIndicatorIcon from '../assets/media-merge.svg';
import { getStatusLabel, getStatusSeverity, normalizeStatus } from '../utils/statusPresentation';
import { confirmModal } from '../utils/confirmModal';
import { isConverterJob, isSeriesVideoJob, resolveMediaType as resolveCentralMediaType } from '../utils/jobTaxonomy';

const processingStates = ['ANALYZING', 'METADATA_LOOKUP', 'RIPPING', 'MEDIAINFO_CHECK', 'ENCODING', 'CD_ANALYZING', 'CD_RIPPING', 'CD_ENCODING'];
const activeCdDriveStates = ['CD_ANALYZING', 'CD_METADATA_SELECTION', 'CD_READY_TO_RIP', 'CD_RIPPING', 'CD_ENCODING'];
const ripperStatuses = new Set([
  'ANALYZING',
  'METADATA_LOOKUP',
  'METADATA_SELECTION',
  'WAITING_FOR_USER_DECISION',
  'READY_TO_START',
  'MEDIAINFO_CHECK',
  'READY_TO_ENCODE',
  'RIPPING',
  'ENCODING',
  'CANCELLED',
  'ERROR',
  'CD_METADATA_SELECTION',
  'CD_READY_TO_RIP',
  'CD_ANALYZING',
  'CD_RIPPING',
  'CD_ENCODING'
]);
const hiddenCancelledReviewOrigins = new Set([
  'READY_TO_START',
  'READY_TO_ENCODE',
  'METADATA_LOOKUP',
  'METADATA_SELECTION',
  'WAITING_FOR_USER_DECISION',
  'CD_METADATA_SELECTION',
  'CD_READY_TO_RIP'
]);

function normalizeJobId(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return Math.trunc(parsed);
}

function hasSeriesWorkflowHints(source) {
  const value = source && typeof source === 'object' ? source : {};
  const seasonNumber = Number(
    value?.seasonNumber
    ?? value?.seriesLookupHint?.seasonNumber
    ?? value?.selectedMetadata?.seasonNumber
    ?? null
  );
  const episodeCount = Number(
    value?.episodeCount
    ?? value?.selectedMetadata?.episodeCount
    ?? 0
  );
  const directEpisodes = Array.isArray(value?.episodes) ? value.episodes : [];
  const nestedEpisodes = Array.isArray(value?.selectedMetadata?.episodes) ? value.selectedMetadata.episodes : [];
  return Boolean(
    (Number.isFinite(seasonNumber) && seasonNumber > 0)
    || (Number.isFinite(episodeCount) && episodeCount > 0)
    || directEpisodes.length > 0
    || nestedEpisodes.length > 0
    || (value?.seriesAnalysis && typeof value.seriesAnalysis === 'object')
  );
}

function isCdMetadataContext(context) {
  const rawContext = context && typeof context === 'object' ? context : {};
  const state = String(rawContext?.state || rawContext?.lastState || '').trim().toUpperCase();
  if (state.startsWith('CD_')) {
    return true;
  }
  const stage = String(rawContext?.stage || '').trim().toUpperCase();
  if (stage.startsWith('CD_')) {
    return true;
  }
  const mediaProfile = String(rawContext?.mediaProfile || rawContext?.selectedMetadata?.mediaProfile || '').trim().toLowerCase();
  if (mediaProfile === 'cd' || mediaProfile === 'audio_cd' || mediaProfile === 'audio cd') {
    return true;
  }
  // Strong negative signals: never route known non-CD jobs into MusicBrainz.
  if (['bluray', 'dvd', 'audiobook', 'converter', 'other'].includes(mediaProfile)) {
    return false;
  }
  if (String(rawContext?.cdparanoiaCmd || rawContext?.cdparanoiaCommandPreview || '').trim()) {
    return true;
  }
  const hasMusicBrainzSignals = Boolean(
    String(
      rawContext?.selectedMetadata?.mbId
      || rawContext?.selectedMetadata?.musicBrainzId
      || rawContext?.selectedMetadata?.musicbrainzId
      || rawContext?.selectedMetadata?.mbid
      || ''
    ).trim()
  );
  if (hasMusicBrainzSignals) {
    return true;
  }
  return false;
}

function isCdAnalyzeResponsePayload(payload) {
  const result = payload && typeof payload === 'object' ? payload : {};
  if (isCdMetadataContext(result)) {
    return true;
  }
  const mediaProfile = String(result?.mediaProfile || result?.selectedMetadata?.mediaProfile || '').trim().toLowerCase();
  const hasVideoSignals = ['bluray', 'dvd'].includes(mediaProfile)
    || hasSeriesWorkflowHints(result)
    || Boolean(
      String(
        result?.selectedMetadata?.imdbId
        || result?.selectedMetadata?.tmdbId
        || result?.selectedMetadata?.providerId
        || result?.imdbId
        || result?.tmdbId
        || ''
      ).trim()
    );
  if (hasVideoSignals) {
    return false;
  }
  if (Array.isArray(result?.tracks)) {
    const trackList = result.tracks.filter((track) => track && typeof track === 'object');
    const looksLikeCdTrackList = trackList.length > 0
      && trackList.every((track) => {
        const position = Number(track?.position);
        return Number.isFinite(position) && position > 0;
      });
    if (looksLikeCdTrackList) {
      return true;
    }
  }
  const status = String(result?.status || result?.state || result?.lastState || '').trim().toUpperCase();
  if (status.startsWith('CD_')) {
    return true;
  }
  return false;
}

function normalizeDrivePath(value) {
  return String(value || '').trim();
}

function getPathBaseName(value) {
  const normalized = String(value || '').trim().replace(/[\\]+/g, '/');
  if (!normalized) {
    return '';
  }
  const segments = normalized.split('/').filter(Boolean);
  return segments[segments.length - 1] || '';
}

function isIncompleteRawPath(rawPath) {
  const baseName = getPathBaseName(rawPath);
  return /^incomplete_/i.test(baseName);
}

function normalizePathForMatch(value) {
  return String(value || '').trim().replace(/[\\]+/g, '/');
}

function isIncompleteOutputPath(outputPath) {
  const normalized = normalizePathForMatch(outputPath);
  if (!normalized) {
    return false;
  }
  return /(^|\/)incomplete_job-\d+(\/|$)/i.test(normalized)
    || /(^|\/)incomplete_merge_[^/]+_job_\d+(\/|$)/i.test(normalized);
}

function isIncompleteMergeOutputPath(outputPath) {
  const normalized = normalizePathForMatch(outputPath);
  if (!normalized) {
    return false;
  }
  return /(^|\/)incomplete_merge_[^/]+_job_\d+(\/|$)/i.test(normalized);
}

function getIncompleteOutputSelectionPaths(outputPath) {
  const normalized = normalizePathForMatch(outputPath);
  if (!normalized) {
    return [];
  }
  const segments = normalized.split('/').filter(Boolean);
  const incompleteJobIndex = segments.findIndex((segment) => /^incomplete_job-\d+$/i.test(segment));
  if (incompleteJobIndex >= 0) {
    const folderPath = `/${segments.slice(0, incompleteJobIndex + 1).join('/')}`;
    return Array.from(new Set([normalized, folderPath]));
  }
  const incompleteMergeIndex = segments.findIndex((segment) => /^incomplete_merge_[^/]+_job_\d+$/i.test(segment));
  if (incompleteMergeIndex >= 0) {
    const mergeFolderPath = `/${segments.slice(0, incompleteMergeIndex + 1).join('/')}`;
    const normalizedLooksLikeFolder = incompleteMergeIndex === (segments.length - 1);
    return normalizedLooksLikeFolder
      ? [mergeFolderPath]
      : [normalized];
  }
  return [];
}

function formatPercent(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return 'n/a';
  }
  return `${Math.trunc(parsed)}%`;
}

function isPlaylistTrackPreparationStatus(value) {
  const normalized = String(value || '').trim().toUpperCase();
  if (!normalized) {
    return false;
  }
  return normalized.includes('PLAYLIST')
    && normalized.includes('TRACKDATEN')
    && normalized.includes('VORBEREIT');
}

function isMediainfoCheckStatus(value) {
  return String(value || '').trim().toUpperCase() === 'MEDIAINFO_CHECK';
}

function formatTemperature(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return 'n/a';
  }
  return `${parsed.toFixed(1)}°C`;
}

function formatBytes(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return 'n/a';
  }
  if (parsed === 0) {
    return '0 B';
  }
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let unitIndex = 0;
  let current = parsed;
  while (current >= 1024 && unitIndex < units.length - 1) {
    current /= 1024;
    unitIndex += 1;
  }
  const digits = unitIndex <= 1 ? 0 : 2;
  return `${current.toFixed(digits)} ${units[unitIndex]}`;
}

function formatBytesCompact(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return 'n/a';
  }
  if (parsed === 0) {
    return '0B';
  }
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let unitIndex = 0;
  let current = parsed;
  while (current >= 1024 && unitIndex < units.length - 1) {
    current /= 1024;
    unitIndex += 1;
  }
  return `${Math.round(current)}${units[unitIndex]}`;
}

function formatUsageCompact(usedValue, totalValue) {
  return `${formatBytesCompact(usedValue)}/${formatBytesCompact(totalValue)}`;
}

function formatUpdatedAt(value) {
  if (!value) {
    return '-';
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '-';
  }
  return date.toLocaleString('de-DE');
}

function formatDurationMs(value) {
  const ms = Number(value);
  if (!Number.isFinite(ms) || ms < 0) {
    return '-';
  }
  if (ms < 1000) {
    return `${Math.round(ms)} ms`;
  }
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const restSeconds = seconds % 60;
  return `${minutes}m ${restSeconds}s`;
}

function normalizeRuntimeActivitiesPayload(rawPayload) {
  const payload = rawPayload && typeof rawPayload === 'object' ? rawPayload : {};
  const normalizeItem = (item) => {
    const source = item && typeof item === 'object' ? item : {};
    const parsedId = Number(source.id);
    const id = Number.isFinite(parsedId) && parsedId > 0 ? Math.trunc(parsedId) : null;
    return {
      id,
      type: String(source.type || '').trim().toLowerCase() || 'task',
      name: String(source.name || '').trim() || '-',
      status: String(source.status || '').trim().toLowerCase() || 'running',
      outcome: String(source.outcome || '').trim().toLowerCase() || null,
      source: String(source.source || '').trim() || null,
      message: String(source.message || '').trim() || null,
      errorMessage: String(source.errorMessage || '').trim() || null,
      currentStep: String(source.currentStep || '').trim() || null,
      currentScriptName: String(source.currentScriptName || '').trim() || null,
      output: source.output != null ? String(source.output) : null,
      stdout: source.stdout != null ? String(source.stdout) : null,
      stderr: source.stderr != null ? String(source.stderr) : null,
      outputTruncated: Boolean(source.outputTruncated),
      stdoutTruncated: Boolean(source.stdoutTruncated),
      stderrTruncated: Boolean(source.stderrTruncated),
      exitCode: Number.isFinite(Number(source.exitCode)) ? Number(source.exitCode) : null,
      startedAt: source.startedAt || null,
      finishedAt: source.finishedAt || null,
      durationMs: Number.isFinite(Number(source.durationMs)) ? Number(source.durationMs) : null,
      jobId: Number.isFinite(Number(source.jobId)) && Number(source.jobId) > 0 ? Math.trunc(Number(source.jobId)) : null,
      cronJobId: Number.isFinite(Number(source.cronJobId)) && Number(source.cronJobId) > 0 ? Math.trunc(Number(source.cronJobId)) : null,
      chainId: Number.isFinite(Number(source.chainId)) && Number(source.chainId) > 0 ? Math.trunc(Number(source.chainId)) : null,
      scriptId: Number.isFinite(Number(source.scriptId)) && Number(source.scriptId) > 0 ? Math.trunc(Number(source.scriptId)) : null,
      canCancel: Boolean(source.canCancel),
      canNextStep: Boolean(source.canNextStep),
      parentActivityId: Number.isFinite(Number(source.parentActivityId)) && Number(source.parentActivityId) > 0
        ? Math.trunc(Number(source.parentActivityId))
        : null,
      stepIndex: Number.isFinite(Number(source.stepIndex)) ? Math.trunc(Number(source.stepIndex)) : null,
      stepTotal: Number.isFinite(Number(source.stepTotal)) && Number(source.stepTotal) > 0
        ? Math.trunc(Number(source.stepTotal))
        : null
    };
  };
  const active = (Array.isArray(payload.active) ? payload.active : []).map(normalizeItem);
  const recent = (Array.isArray(payload.recent) ? payload.recent : []).map(normalizeItem);
  return {
    active,
    recent,
    updatedAt: payload.updatedAt || null
  };
}

function runtimeTypeLabel(type) {
  const normalized = String(type || '').trim().toLowerCase();
  if (normalized === 'script') return 'Skript';
  if (normalized === 'chain') return 'Kette';
  if (normalized === 'cron') return 'Cronjob';
  return normalized || 'Task';
}

function runtimeStatusMeta(status) {
  const normalized = String(status || '').trim().toLowerCase();
  if (normalized === 'running') return { label: 'Läuft', severity: 'warning' };
  if (normalized === 'success') return { label: 'Abgeschlossen', severity: 'success' };
  if (normalized === 'error') return { label: 'Fehler', severity: 'danger' };
  return { label: normalized || '-', severity: 'secondary' };
}

function runtimeOutcomeMeta(outcome, status) {
  const normalized = String(outcome || '').trim().toLowerCase();
  if (normalized === 'success') return { label: 'Erfolg', severity: 'success' };
  if (normalized === 'error') return { label: 'Fehler', severity: 'danger' };
  if (normalized === 'cancelled') return { label: 'Abgebrochen', severity: 'warning' };
  if (normalized === 'skipped') return { label: 'Übersprungen', severity: 'info' };
  return runtimeStatusMeta(status);
}

function driveStateIconMeta(stateLabel) {
  const normalized = String(stateLabel || '').trim().toUpperCase();
  if (!normalized || normalized === 'LEER' || normalized === 'IDLE') {
    return { icon: 'pi-stop', spin: false };
  }
  if (normalized === 'DISC_DETECTED') {
    return { icon: 'pi-check', spin: false };
  }
  if (normalized === 'FINISHED') {
    return { icon: 'pi-check-circle', spin: false };
  }
  if (normalized === 'ERROR' || normalized === 'CANCELLED') {
    return { icon: 'pi-times-circle', spin: false };
  }
  if (processingStates.includes(normalized)) {
    return { icon: 'pi-spinner', spin: true };
  }
  if (
    normalized === 'METADATA_SELECTION'
    || normalized === 'CD_METADATA_SELECTION'
    || normalized === 'WAITING_FOR_USER_DECISION'
  ) {
    return { icon: 'pi-list', spin: false };
  }
  if (
    normalized === 'READY_TO_START'
    || normalized === 'READY_TO_ENCODE'
    || normalized === 'CD_READY_TO_RIP'
  ) {
    return { icon: 'pi-play', spin: false };
  }
  return { icon: 'pi-question-circle', spin: false };
}

function hasRuntimeOutputDetails(item) {
  if (!item || typeof item !== 'object') {
    return false;
  }
  const hasRelevantExitCode = Number.isFinite(Number(item.exitCode)) && Number(item.exitCode) !== 0;
  return Boolean(
    String(item.errorMessage || '').trim()
    || String(item.output || '').trim()
    || String(item.stdout || '').trim()
    || String(item.stderr || '').trim()
    || hasRelevantExitCode
  );
}

function hasRuntimeLogContent(item) {
  if (!item || typeof item !== 'object') {
    return false;
  }
  return Boolean(
    String(item.output || '').trim()
    || String(item.stdout || '').trim()
    || String(item.stderr || '').trim()
  );
}

function RuntimeActivityDetails({
  item,
  summary,
  emptyLabel = 'Noch keine Log-Ausgabe vorhanden.'
}) {
  const hasLogs = hasRuntimeLogContent(item);
  const hasOutput = Boolean(String(item?.output || '').trim());
  const hasStdout = Boolean(String(item?.stdout || '').trim());
  const hasStderr = Boolean(String(item?.stderr || '').trim());

  return (
    <details className="runtime-activity-details">
      <summary>{summary}</summary>
      {!hasLogs ? <small>{emptyLabel}</small> : null}
      {hasOutput ? (
        <div className="runtime-activity-details-block">
          <small><strong>Ausgabe:</strong>{item?.outputTruncated ? ' (gekürzt)' : ''}</small>
          <pre>{item.output}</pre>
        </div>
      ) : null}
      {hasStdout ? (
        <div className="runtime-activity-details-block">
          <small><strong>stdout:</strong>{item?.stdoutTruncated ? ' (gekürzt)' : ''}</small>
          <pre>{item.stdout}</pre>
        </div>
      ) : null}
      {hasStderr ? (
        <div className="runtime-activity-details-block">
          <small><strong>stderr:</strong>{item?.stderrTruncated ? ' (gekürzt)' : ''}</small>
          <pre>{item.stderr}</pre>
        </div>
      ) : null}
    </details>
  );
}

function normalizeHardwareMonitoringPayload(rawPayload) {
  const payload = rawPayload && typeof rawPayload === 'object' ? rawPayload : {};
  return {
    enabled: Boolean(payload.enabled),
    intervalMs: Number(payload.intervalMs || 0),
    updatedAt: payload.updatedAt || null,
    sample: payload.sample && typeof payload.sample === 'object' ? payload.sample : null,
    error: payload.error ? String(payload.error) : null
  };
}

function getStorageUsageTone(usagePercent) {
  const value = Number(usagePercent);
  if (!Number.isFinite(value)) {
    return 'unknown';
  }
  if (value >= 95) {
    return 'critical';
  }
  if (value >= 85) {
    return 'high';
  }
  if (value >= 70) {
    return 'warn';
  }
  return 'ok';
}

function normalizeQueue(queue) {
  const payload = queue && typeof queue === 'object' ? queue : {};
  const runningJobs = Array.isArray(payload.runningJobs) ? payload.runningJobs : [];
  const idleJobs = Array.isArray(payload.idleJobs) ? payload.idleJobs : [];
  const queuedJobs = Array.isArray(payload.queuedJobs) ? payload.queuedJobs : [];
  return {
    maxParallelJobs: Number(payload.maxParallelJobs || 1),
    maxParallelCdEncodes: Number(payload.maxParallelCdEncodes || 2),
    maxTotalEncodes: Number(payload.maxTotalEncodes || 3),
    cdBypassesQueue: Boolean(payload.cdBypassesQueue),
    runningCount: Number(payload.runningCount || runningJobs.length || 0),
    runningCdCount: Number(payload.runningCdCount || 0),
    runningJobs,
    idleCount: Number(payload.idleCount || idleJobs.length || 0),
    idleJobs,
    queuedJobs,
    queuedCount: Number(payload.queuedCount || queuedJobs.length || 0),
    updatedAt: payload.updatedAt || null
  };
}

function buildCdDriveLifecycleKey(cdDrives) {
  if (!cdDrives || typeof cdDrives !== 'object') {
    return '';
  }
  const entries = Object.entries(cdDrives)
    .map(([devicePath, driveState]) => {
      const state = String(driveState?.state || '').trim().toUpperCase();
      const jobId = normalizeJobId(driveState?.jobId || driveState?.context?.jobId) || 0;
      return `${devicePath}|${jobId}|${state}`;
    })
    .sort();
  return entries.join('::');
}

function getQueueActionResult(response) {
  return response?.result && typeof response.result === 'object' ? response.result : {};
}

function showQueuedToast(toastRef, actionLabel, result) {
  if (!toastRef?.current) {
    return;
  }
  const queuePosition = Number(result?.queuePosition || 0);
  const positionText = queuePosition > 0 ? `Position ${queuePosition}` : 'in der Warteschlange';
  toastRef.current.show({
    severity: 'info',
    summary: `${actionLabel} in Queue`,
    detail: `${actionLabel} wurde ${positionText} eingeplant.`,
    life: 3200
  });
}

function reorderQueuedItems(items, draggedEntryId, targetEntryId) {
  const list = Array.isArray(items) ? items : [];
  const from = list.findIndex((item) => Number(item?.entryId) === Number(draggedEntryId));
  const to = list.findIndex((item) => Number(item?.entryId) === Number(targetEntryId));
  if (from < 0 || to < 0 || from === to) {
    return list;
  }
  const next = [...list];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next.map((item, index) => ({
    ...item,
    position: index + 1
  }));
}

function queueEntryIcon(type) {
  if (type === 'script') return 'pi pi-code';
  if (type === 'chain') return 'pi pi-link';
  if (type === 'wait') return 'pi pi-clock';
  return 'pi pi-box';
}

function queueEntryLabel(item) {
  if (item.type === 'script') return `Skript: ${item.title}`;
  if (item.type === 'chain') return `Kette: ${item.title}`;
  if (item.type === 'wait') return `Warten: ${item.waitSeconds}s`;
  return item.title || `Job #${item.jobId}`;
}

function isGenericChainQueueLabel(value, chainId = null) {
  const text = String(value || '').trim();
  if (!text) {
    return true;
  }
  const compact = text.toLowerCase().replace(/\s+/g, ' ');
  if (/^kette\s*#?\s*\d+$/.test(compact)) {
    return true;
  }
  const normalizedChainId = Number(chainId);
  if (Number.isFinite(normalizedChainId) && normalizedChainId > 0) {
    const idToken = String(Math.trunc(normalizedChainId));
    if (compact === `kette ${idToken}` || compact === `kette #${idToken}`) {
      return true;
    }
  }
  return false;
}

function resolveChainQueueSubtitle(item, chainNameById = new Map()) {
  const chainIdRaw = Number(item?.chainId);
  const chainId = Number.isFinite(chainIdRaw) && chainIdRaw > 0 ? Math.trunc(chainIdRaw) : null;
  const explicitChainName = String(item?.chainName || '').trim();
  if (explicitChainName) {
    return explicitChainName;
  }
  const title = String(item?.title || '').trim();
  if (title && !isGenericChainQueueLabel(title, chainId)) {
    return title;
  }
  if (chainId && chainNameById instanceof Map) {
    const mappedName = String(chainNameById.get(chainId) || '').trim();
    if (mappedName) {
      return mappedName;
    }
  }
  return title || null;
}

function parseSeriesQueueEpisodeText(value) {
  const text = String(value || '').trim();
  if (!text) {
    return null;
  }
  const compactMatch = text.match(/\bS\d{1,3}E\d{1,3}(?:-\d{1,3})?\b/i);
  const spacedMatch = text.match(/\bS\s*(\d{1,3})\s*E\s*(\d{1,3})(?:\s*-\s*(\d{1,3}))?\b/i);
  const xStyleMatch = text.match(/\b(\d{1,3})\s*[xX]\s*(\d{1,3})(?:\s*-\s*(\d{1,3}))?\b/);
  const codeMatch = compactMatch || spacedMatch || xStyleMatch;
  if (!codeMatch) {
    return null;
  }

  let code = '';
  if (compactMatch) {
    code = String(compactMatch[0] || '').trim().toUpperCase().replace(/\s+/g, '');
  } else {
    const season = Number(codeMatch[1]);
    const episodeStart = Number(codeMatch[2]);
    const episodeEnd = Number(codeMatch[3]);
    const seasonToken = Number.isFinite(season) ? String(Math.trunc(season)).padStart(2, '0') : '??';
    const episodeStartToken = Number.isFinite(episodeStart) ? String(Math.trunc(episodeStart)).padStart(2, '0') : '??';
    const episodeEndToken = Number.isFinite(episodeEnd) ? String(Math.trunc(episodeEnd)).padStart(2, '0') : null;
    code = `S${seasonToken}E${episodeStartToken}${episodeEndToken ? `-${episodeEndToken}` : ''}`;
  }

  const index = Number(codeMatch.index || 0);
  const prefix = text.slice(0, index).trim().replace(/[-|:–—]+\s*$/u, '').trim();
  const matchedRaw = String(codeMatch[0] || '');
  const trailing = text.slice(index + matchedRaw.length).trim();
  const episodeTitle = trailing.replace(/^[-|:–—]+\s*/u, '').trim() || null;
  return {
    code,
    prefix: prefix || null,
    episodeTitle
  };
}

function resolveSeriesQueueDisplay(item) {
  const titleRaw = String(item?.title || '').trim();
  const subtitleRaw = String(item?.subtitle || '').trim();
  const titleParsed = parseSeriesQueueEpisodeText(titleRaw);
  const subtitleParsed = parseSeriesQueueEpisodeText(subtitleRaw);
  const parsed = subtitleParsed || titleParsed;
  if (!parsed) {
    return {
      isSeriesEpisode: false,
      title: titleRaw || `Job #${item?.jobId || '-'}`,
      subtitle: subtitleRaw || null
    };
  }

  let baseTitle = titleRaw;
  if (titleParsed?.prefix) {
    baseTitle = titleParsed.prefix;
  } else if (
    subtitleParsed?.prefix
    && (!baseTitle || baseTitle === subtitleRaw || /\bS\d{1,3}E\d{1,3}/i.test(baseTitle))
  ) {
    baseTitle = subtitleParsed.prefix;
  }

  const resolvedTitle = String(baseTitle || '').trim() || `Job #${item?.jobId || '-'}`;
  const episodeSubtitle = parsed.episodeTitle
    ? `${parsed.code} - ${parsed.episodeTitle}`
    : parsed.code;
  return {
    isSeriesEpisode: true,
    title: resolvedTitle,
    subtitle: episodeSubtitle
  };
}

function normalizeQueueNameList(values) {
  const list = Array.isArray(values) ? values : [];
  const seen = new Set();
  const output = [];
  for (const item of list) {
    const name = String(item || '').trim();
    if (!name) {
      continue;
    }
    const key = name.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    output.push(name);
  }
  return output;
}

function normalizeQueueScriptSummary(item) {
  const source = item?.scriptSummary && typeof item.scriptSummary === 'object' ? item.scriptSummary : {};
  return {
    preScripts: normalizeQueueNameList(source.preScripts),
    postScripts: normalizeQueueNameList(source.postScripts),
    preChains: normalizeQueueNameList(source.preChains),
    postChains: normalizeQueueNameList(source.postChains)
  };
}

function hasQueueScriptSummary(item) {
  const summary = normalizeQueueScriptSummary(item);
  return summary.preScripts.length > 0
    || summary.postScripts.length > 0
    || summary.preChains.length > 0
    || summary.postChains.length > 0;
}

function QueueJobScriptSummary({ item }) {
  const summary = normalizeQueueScriptSummary(item);
  const groups = [
    { key: 'pre-scripts', icon: 'pi pi-code', label: 'Pre-Encode Skripte', values: summary.preScripts },
    { key: 'post-scripts', icon: 'pi pi-code', label: 'Post-Encode Skripte', values: summary.postScripts },
    { key: 'pre-chains', icon: 'pi pi-link', label: 'Pre-Encode Ketten', values: summary.preChains },
    { key: 'post-chains', icon: 'pi pi-link', label: 'Post-Encode Ketten', values: summary.postChains }
  ].filter((group) => group.values.length > 0);

  if (groups.length === 0) {
    return null;
  }

  return (
    <div className="queue-job-script-details">
      {groups.map((group) => {
        const text = group.values.join(' | ');
        return (
          <div key={group.key} className="queue-job-script-group">
            <strong><i className={group.icon} /> {group.label}</strong>
            <small title={text}>{text}</small>
          </div>
        );
      })}
    </div>
  );
}

function getAnalyzeContext(job) {
  return job?.makemkvInfo?.analyzeContext && typeof job.makemkvInfo.analyzeContext === 'object'
    ? job.makemkvInfo.analyzeContext
    : {};
}

function getEncodePlan(job) {
  if (job?.encodePlan && typeof job.encodePlan === 'object') {
    return job.encodePlan;
  }
  if (job?.encode_plan_json && typeof job.encode_plan_json === 'object') {
    return job.encode_plan_json;
  }
  const rawPlan = String(job?.encode_plan_json || '').trim();
  if (!rawPlan) {
    return null;
  }
  try {
    const parsed = JSON.parse(rawPlan);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (_error) {
    return null;
  }
}

function resolveJobKindRaw(job) {
  return String(job?.job_kind || job?.jobKind || '').trim().toLowerCase();
}

function isMultipartMergeJob(job) {
  return resolveJobKindRaw(job) === 'multipart_movie_merge';
}

function getMergeAwareStatusLabel(job, status, options = {}) {
  const queued = Boolean(options?.queued);
  const normalizedStatus = normalizeStatus(status);
  if (!queued && isMultipartMergeJob(job) && normalizedStatus === 'ENCODING') {
    return 'Merging';
  }
  return getStatusLabel(status, options);
}

function extractMultipartMergeSources(job) {
  const encodePlan = getEncodePlan(job) || {};
  const sourceItems = Array.isArray(encodePlan?.sourceItems) ? encodePlan.sourceItems : [];
  const normalized = sourceItems
    .map((item) => {
      const sourceJobId = normalizeJobId(item?.jobId || item?.sourceJobId);
      const discNumberRaw = Number(item?.discNumber);
      const discNumber = Number.isFinite(discNumberRaw) && discNumberRaw > 0
        ? Math.trunc(discNumberRaw)
        : null;
      const outputPath = String(item?.outputPath || item?.path || '').trim();
      if (!sourceJobId || !outputPath) {
        return null;
      }
      return {
        sourceJobId,
        discNumber,
        outputPath,
        fileName: getPathBaseName(outputPath)
      };
    })
    .filter(Boolean);
  if (normalized.length === 0) {
    return [];
  }
  const orderedIds = Array.isArray(encodePlan?.orderedSourceJobIds)
    ? encodePlan.orderedSourceJobIds.map((value) => normalizeJobId(value)).filter(Boolean)
    : [];
  const byId = new Map(normalized.map((item) => [item.sourceJobId, item]));
  const ordered = [];
  const seen = new Set();
  for (const sourceJobId of orderedIds) {
    const item = byId.get(sourceJobId);
    if (!item || seen.has(sourceJobId)) {
      continue;
    }
    seen.add(sourceJobId);
    ordered.push(item);
  }
  for (const item of normalized) {
    if (seen.has(item.sourceJobId)) {
      continue;
    }
    seen.add(item.sourceJobId);
    ordered.push(item);
  }
  return ordered;
}

function shouldDeleteMultipartMergeInputsAfterSuccess(job) {
  const encodePlan = getEncodePlan(job) || {};
  return Boolean(encodePlan?.deleteInputsAfterMerge);
}

function formatMergeTrackLanguage(language) {
  const normalized = String(language || '').trim().toLowerCase();
  if (!normalized || normalized === 'und') {
    return 'und';
  }
  return normalized;
}

function formatMergeTrackSummary(track = {}, fallbackLabel = 'Track') {
  const source = track && typeof track === 'object' ? track : {};
  const orderRaw = Number(source.order);
  const order = Number.isFinite(orderRaw) && orderRaw > 0 ? Math.trunc(orderRaw) : null;
  const language = formatMergeTrackLanguage(source.language);
  const codec = String(source.codec || '?').trim() || '?';
  const title = String(source.title || '').trim();
  const channelsRaw = Number(source.channels);
  const channelInfo = Number.isFinite(channelsRaw) && channelsRaw > 0
    ? `${Math.trunc(channelsRaw)}ch`
    : null;
  const flags = [];
  if (source.default === true) {
    flags.push('default');
  }
  if (source.forced === true) {
    flags.push('forced');
  }
  const parts = [
    order ? `#${order}` : fallbackLabel,
    language,
    codec
  ];
  if (channelInfo) {
    parts.push(channelInfo);
  }
  if (title) {
    parts.push(title);
  }
  if (flags.length > 0) {
    parts.push(`[${flags.join(', ')}]`);
  }
  return parts.join(' | ');
}

function resolveMediaType(job) {
  const centralMediaType = resolveCentralMediaType(job);
  if (centralMediaType && centralMediaType !== 'other') {
    return centralMediaType;
  }

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
    if (['audiobook', 'audio_book', 'audio book', 'book'].includes(raw)) {
      return 'audiobook';
    }
  }
  const statusCandidates = [
    job?.status,
    job?.last_state,
    job?.makemkvInfo?.lastState
  ];
  if (statusCandidates.some((value) => String(value || '').trim().toUpperCase().startsWith('CD_'))) {
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
  if (['audiobook_encode', 'audiobook_encode_split'].includes(String(job?.handbrakeInfo?.mode || '').trim().toLowerCase())) {
    return 'audiobook';
  }
  if (String(encodePlan?.mode || '').trim().toLowerCase() === 'audiobook') {
    return 'audiobook';
  }
  return centralMediaType || 'other';
}

function mediaIndicatorMeta(job) {
  if (isMultipartMergeJob(job)) {
    return {
      mediaType: 'multipart_merge',
      src: mergeIndicatorIcon,
      alt: 'Merge Job',
      title: 'Multipart Merge Job'
    };
  }
  const mediaType = resolveMediaType(job);
  const isSeriesVideo = (mediaType === 'dvd' || mediaType === 'bluray') && isSeriesVideoJob(job);
  if (mediaType === 'bluray') {
    return {
      mediaType,
      src: blurayIndicatorIcon,
      alt: isSeriesVideo ? 'Blu-ray Serie' : 'Blu-ray',
      title: isSeriesVideo ? 'Blu-ray Serie' : 'Blu-ray',
      isSeriesDvd: isSeriesVideo,
      isSeriesVideo
    };
  }
  if (mediaType === 'dvd') {
    return {
      mediaType,
      src: discIndicatorIcon,
      alt: isSeriesVideo ? 'DVD Serie' : 'DVD',
      title: isSeriesVideo ? 'DVD Serie' : 'DVD',
      isSeriesDvd: isSeriesVideo,
      isSeriesVideo
    };
  }
  if (mediaType === 'cd') {
    return { mediaType, src: otherIndicatorIcon, alt: 'Audio CD', title: 'Audio CD' };
  }
  if (mediaType === 'audiobook') {
    return { mediaType, src: audiobookIndicatorIcon, alt: 'Audiobook', title: 'Audiobook' };
  }
  return { mediaType, src: otherIndicatorIcon, alt: 'Sonstiges Medium', title: 'Sonstiges Medium' };
}

function normalizeDiscWorkflowKind(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) {
    return null;
  }
  if (['series', 'tv', 'season', 'episode', 'tv_series', 'tv-season', 'tv_season'].includes(raw)) {
    return 'series';
  }
  if (['film', 'movie', 'feature'].includes(raw)) {
    return 'film';
  }
  return null;
}

function resolveDiscWorkflowKind({
  mediaType,
  selectedMetadata = null,
  analyzeContext = null,
  pipelineContext = null,
  fallbackIsSeries = false
} = {}) {
  if (mediaType !== 'dvd' && mediaType !== 'bluray') {
    return null;
  }
  const selected = selectedMetadata && typeof selectedMetadata === 'object' ? selectedMetadata : {};
  const analyze = analyzeContext && typeof analyzeContext === 'object' ? analyzeContext : {};
  const pipelineCtx = pipelineContext && typeof pipelineContext === 'object' ? pipelineContext : {};
  const workflowCandidates = [
    selected?.workflowKind,
    selected?.kind,
    analyze?.workflowKind,
    pipelineCtx?.workflowKind
  ];
  for (const candidate of workflowCandidates) {
    const normalized = normalizeDiscWorkflowKind(candidate);
    if (normalized) {
      return normalized;
    }
  }
  const metadataKindCandidates = [
    selected?.metadataKind,
    analyze?.metadataKind
  ];
  for (const candidate of metadataKindCandidates) {
    const normalized = normalizeDiscWorkflowKind(candidate);
    if (normalized) {
      return normalized;
    }
  }
  if (
    hasSeriesWorkflowHints(selected)
    || hasSeriesWorkflowHints(analyze)
    || hasSeriesWorkflowHints(pipelineCtx)
  ) {
    return 'series';
  }
  return null;
}

function getDiscWorkflowBadgeLabel(mediaType, workflowKind) {
  if (mediaType !== 'dvd' && mediaType !== 'bluray') {
    return null;
  }
  const kind = normalizeDiscWorkflowKind(workflowKind);
  if (!kind) {
    return null;
  }
  if (mediaType === 'bluray') {
    return kind === 'series' ? 'Blu-ray-Serie' : 'Blu-ray-Film';
  }
  return kind === 'series' ? 'DVD-Serie' : 'DVD-Film';
}

function resolveSeriesEpisodeJobIds(job, seriesBatchChildren = []) {
  const ids = [];
  const seen = new Set();
  const pushId = (value) => {
    const normalized = normalizeJobId(value);
    if (!normalized) {
      return;
    }
    const key = String(normalized);
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    ids.push(normalized);
  };

  const plan = getEncodePlan(job) || {};
  const planChildJobIds = Array.isArray(plan?.seriesBatchChildJobIds) ? plan.seriesBatchChildJobIds : [];
  for (const childId of planChildJobIds) {
    pushId(childId);
  }

  const batchChildren = Array.isArray(seriesBatchChildren) ? seriesBatchChildren : [];
  for (const child of batchChildren) {
    pushId(child?.jobId);
  }

  const containerChildren = Array.isArray(job?.children) ? job.children : [];
  for (const child of containerChildren) {
    const childId = normalizeJobId(child?.id);
    if (!childId) {
      continue;
    }
    const childPlan = getEncodePlan(child) || {};
    const looksLikeSeriesEpisodeJob = Boolean(
      childPlan?.seriesBatchChild
      || childPlan?.seriesBatchVirtualEpisode
      || normalizeJobId(childPlan?.seriesBatchParentJobId)
      || normalizeJobId(childPlan?.seriesBatchTitleId)
      || normalizeJobId(childPlan?.seriesBatchChildIndex)
    );
    if (looksLikeSeriesEpisodeJob) {
      pushId(childId);
    }
  }

  return ids.sort((left, right) => left - right);
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
  const isCurrentSessionJob = Boolean(
    jobId
    && currentPipelineJobId
    && jobId === currentPipelineJobId
    && String(currentPipeline?.state || '').trim().toUpperCase() !== 'IDLE'
  );

  const encodePlan = job?.encodePlan && typeof job.encodePlan === 'object' ? job.encodePlan : null;
  const makemkvInfo = job?.makemkvInfo && typeof job.makemkvInfo === 'object' ? job.makemkvInfo : {};
  const resolvedMediaType = resolveMediaType(job);
  const analyzeContext = getAnalyzeContext(job);
  const normalizePlanIdList = (values) => {
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
  };
  const buildNamedSelection = (ids, entries, fallbackLabel) => {
    const source = Array.isArray(entries) ? entries : [];
    const namesById = new Map(
      source
        .map((entry) => {
          const id = Number(entry?.id ?? entry?.scriptId ?? entry?.chainId);
          const normalized = Number.isFinite(id) && id > 0 ? Math.trunc(id) : null;
          const name = String(entry?.name || entry?.scriptName || entry?.chainName || '').trim();
          if (!normalized) {
            return null;
          }
          return [normalized, name || null];
        })
        .filter(Boolean)
    );
    return ids.map((id) => ({
      id,
      name: namesById.get(id) || `${fallbackLabel} #${id}`
    }));
  };
  const planPreScriptIds = normalizePlanIdList([
    ...(Array.isArray(encodePlan?.preEncodeScriptIds) ? encodePlan.preEncodeScriptIds : []),
    ...(Array.isArray(encodePlan?.preEncodeScripts) ? encodePlan.preEncodeScripts.map((entry) => entry?.id ?? entry?.scriptId) : [])
  ]);
  const planPostScriptIds = normalizePlanIdList([
    ...(Array.isArray(encodePlan?.postEncodeScriptIds) ? encodePlan.postEncodeScriptIds : []),
    ...(Array.isArray(encodePlan?.postEncodeScripts) ? encodePlan.postEncodeScripts.map((entry) => entry?.id ?? entry?.scriptId) : [])
  ]);
  const planPreChainIds = normalizePlanIdList([
    ...(Array.isArray(encodePlan?.preEncodeChainIds) ? encodePlan.preEncodeChainIds : []),
    ...(Array.isArray(encodePlan?.preEncodeChains) ? encodePlan.preEncodeChains.map((entry) => entry?.id ?? entry?.chainId) : [])
  ]);
  const planPostChainIds = normalizePlanIdList([
    ...(Array.isArray(encodePlan?.postEncodeChainIds) ? encodePlan.postEncodeChainIds : []),
    ...(Array.isArray(encodePlan?.postEncodeChains) ? encodePlan.postEncodeChains.map((entry) => entry?.id ?? entry?.chainId) : [])
  ]);
  const cdRipConfig = encodePlan && typeof encodePlan === 'object'
    ? {
      format: String(encodePlan?.format || '').trim().toLowerCase() || null,
      formatOptions: encodePlan?.formatOptions && typeof encodePlan.formatOptions === 'object'
        ? encodePlan.formatOptions
        : {},
      selectedTracks: Array.isArray(encodePlan?.selectedTracks)
        ? encodePlan.selectedTracks
          .map((value) => Number(value))
          .filter((value) => Number.isFinite(value) && value > 0)
          .map((value) => Math.trunc(value))
        : [],
      preEncodeScriptIds: planPreScriptIds,
      postEncodeScriptIds: planPostScriptIds,
      preEncodeChainIds: planPreChainIds,
      postEncodeChainIds: planPostChainIds,
      preEncodeScripts: buildNamedSelection(planPreScriptIds, encodePlan?.preEncodeScripts, 'Skript'),
      postEncodeScripts: buildNamedSelection(planPostScriptIds, encodePlan?.postEncodeScripts, 'Skript'),
      preEncodeChains: buildNamedSelection(planPreChainIds, encodePlan?.preEncodeChains, 'Kette'),
      postEncodeChains: buildNamedSelection(planPostChainIds, encodePlan?.postEncodeChains, 'Kette'),
      outputTemplate: String(encodePlan?.outputTemplate || '').trim() || null
    }
    : null;
  const cdTracks = Array.isArray(makemkvInfo?.tracks)
    ? makemkvInfo.tracks
      .map((track) => {
        const position = Number(track?.position);
        if (!Number.isFinite(position) || position <= 0) {
          return null;
        }
        return {
          ...track,
          position: Math.trunc(position),
          selected: track?.selected !== false
        };
      })
      .filter(Boolean)
    : [];
  const cdSelectedMeta = makemkvInfo?.selectedMetadata && typeof makemkvInfo.selectedMetadata === 'object'
    ? makemkvInfo.selectedMetadata
    : {};
  const fallbackCdArtist = cdTracks
    .map((track) => String(track?.artist || '').trim())
    .find(Boolean) || null;
  const resolvedCdMbId = String(
    cdSelectedMeta?.mbId
    || cdSelectedMeta?.musicBrainzId
    || cdSelectedMeta?.musicbrainzId
    || cdSelectedMeta?.mbid
    || ''
  ).trim() || null;
  const resolvedCdCoverUrl = String(
    cdSelectedMeta?.coverUrl
    || cdSelectedMeta?.poster
    || cdSelectedMeta?.posterUrl
    || job?.poster_url
    || ''
  ).trim() || null;
  const cdparanoiaCmd = String(makemkvInfo?.cdparanoiaCmd || 'cdparanoia').trim() || 'cdparanoia';
  const devicePath = String(job?.disc_device || '').trim() || null;
  const firstConfiguredTrack = Array.isArray(encodePlan?.selectedTracks) && encodePlan.selectedTracks.length > 0
    ? Number(encodePlan.selectedTracks[0])
    : null;
  const fallbackTrack = cdTracks[0]?.position ? Number(cdTracks[0].position) : null;
  const previewTrackPos = Number.isFinite(firstConfiguredTrack) && firstConfiguredTrack > 0
    ? Math.trunc(firstConfiguredTrack)
    : (Number.isFinite(fallbackTrack) && fallbackTrack > 0 ? Math.trunc(fallbackTrack) : null);
  const previewWavPath = previewTrackPos && job?.raw_path
    ? `${job.raw_path}/track${String(previewTrackPos).padStart(2, '0')}.cdda.wav`
    : '<temp>/trackNN.cdda.wav';
  const cdparanoiaCommandPreview = `${cdparanoiaCmd} -d ${devicePath || '<device>'} ${previewTrackPos || '<trackNr>'} ${previewWavPath}`;
  const audiobookSelectedMeta = {
    ...(makemkvInfo?.selectedMetadata && typeof makemkvInfo.selectedMetadata === 'object'
      ? makemkvInfo.selectedMetadata
      : {}),
    ...(encodePlan?.metadata && typeof encodePlan.metadata === 'object'
      ? encodePlan.metadata
      : {})
  };
  const selectedMetadata = resolvedMediaType === 'audiobook'
    ? {
      title: audiobookSelectedMeta?.title || job?.title || job?.detected_title || null,
      author: audiobookSelectedMeta?.author || audiobookSelectedMeta?.artist || null,
      narrator: audiobookSelectedMeta?.narrator || null,
      description: audiobookSelectedMeta?.description || null,
      series: audiobookSelectedMeta?.series || null,
      part: audiobookSelectedMeta?.part || null,
      year: audiobookSelectedMeta?.year ?? job?.year ?? null,
      chapters: Array.isArray(audiobookSelectedMeta?.chapters) ? audiobookSelectedMeta.chapters : [],
      durationMs: audiobookSelectedMeta?.durationMs || 0,
      poster: audiobookSelectedMeta?.poster || job?.poster_url || null
    }
    : {
      title: cdSelectedMeta?.title || job?.title || job?.detected_title || null,
      artist: cdSelectedMeta?.artist || fallbackCdArtist || null,
      year: cdSelectedMeta?.year ?? job?.year ?? null,
      mbId: resolvedCdMbId,
      coverUrl: resolvedCdCoverUrl,
      imdbId: job?.imdb_id || null,
      poster: job?.poster_url || resolvedCdCoverUrl || null,
      metadataProvider: analyzeContext?.metadataProvider || 'tmdb',
      providerId: analyzeContext?.selectedMetadata?.providerId || null,
      tmdbId: analyzeContext?.selectedMetadata?.tmdbId || null,
      metadataKind: analyzeContext?.selectedMetadata?.metadataKind || null,
      seasonNumber: analyzeContext?.selectedMetadata?.seasonNumber || analyzeContext?.seriesLookupHint?.seasonNumber || null,
      seasonName: analyzeContext?.selectedMetadata?.seasonName || null,
      episodeCount: analyzeContext?.selectedMetadata?.episodeCount || 0,
      episodes: Array.isArray(analyzeContext?.selectedMetadata?.episodes) ? analyzeContext.selectedMetadata.episodes : [],
      discNumber: analyzeContext?.selectedMetadata?.discNumber || analyzeContext?.seriesLookupHint?.discNumber || null
    };
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
  const looksLikeCancelledEncode = (jobStatus === 'ERROR' || jobStatus === 'CANCELLED') && (
    (errorText.includes('ABGEBROCHEN') || errorText.includes('CANCELLED'))
    && (hasOutputPath || Boolean(job?.encode_input_path) || Boolean(job?.handbrakeInfo))
  );
  const looksLikeEncodingError = (jobStatus === 'ERROR' || jobStatus === 'CANCELLED') && (
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
      || jobStatus === 'CANCELLED'
      || looksLikeEncodingError
    )
  );
  const canRestartReviewFromRaw = Boolean(
    job?.raw_path
    && !processingStates.includes(jobStatus)
    && resolvedMediaType !== 'audiobook'
  );
  const cdSkipRipReady = Boolean(
    resolvedMediaType === 'cd'
    && (
      Boolean(encodePlan?.skipRip)
      || (
        Number(job?.rip_successful || 0) === 1
        && Boolean(String(job?.raw_path || '').trim())
      )
    )
  );
  const computedContext = {
    jobId,
    rawPath: job?.raw_path || null,
    outputPath: job?.output_path || null,
    detectedTitle: job?.detected_title || null,
    mediaProfile: resolvedMediaType,
    lastState,
    devicePath,
    cdparanoiaCmd,
    cdparanoiaCommandPreview,
    skipRip: cdSkipRipReady ? true : undefined,
    cdRipConfig,
    tracks: cdTracks,
    inputPath,
    hasEncodableTitle,
    reviewConfirmed,
    mode,
    sourceJobId: encodePlan?.sourceJobId || null,
    selectedMetadata,
    audiobookConfig: resolvedMediaType === 'audiobook'
      ? {
        format: String(encodePlan?.format || '').trim().toLowerCase() || 'mp3',
        formatOptions: encodePlan?.formatOptions && typeof encodePlan.formatOptions === 'object'
          ? encodePlan.formatOptions
          : {}
      }
      : null,
    mediaInfoReview: encodePlan,
    playlistAnalysis: analyzeContext.playlistAnalysis || null,
    playlistDecisionRequired: Boolean(analyzeContext.playlistDecisionRequired),
    playlistCandidates: Array.isArray(analyzeContext?.playlistAnalysis?.evaluatedCandidates)
      ? analyzeContext.playlistAnalysis.evaluatedCandidates
      : [],
    selectedPlaylist: analyzeContext.selectedPlaylist || null,
    selectedTitleId: analyzeContext.selectedTitleId ?? null,
    metadataProvider: analyzeContext.metadataProvider || 'tmdb',
    metadataCandidates: Array.isArray(analyzeContext.metadataCandidates) ? analyzeContext.metadataCandidates : [],
    workflowKind: analyzeContext.workflowKind || null,
    seriesAnalysis: analyzeContext.seriesAnalysis || null,
    seriesLookupHint: analyzeContext.seriesLookupHint || null,
    seriesDecision: analyzeContext.seriesDecision || null,
    canRestartEncodeFromLastSettings,
    canRestartReviewFromRaw
  };

  if (isCurrentSessionJob) {
    const existingContext = currentPipeline?.context && typeof currentPipeline.context === 'object'
      ? currentPipeline.context
      : {};
    const mergedCurrentContext = {
      ...computedContext,
      ...existingContext,
      rawPath: existingContext.rawPath || computedContext.rawPath,
      outputPath: existingContext.outputPath || computedContext.outputPath,
      tracks: (Array.isArray(existingContext.tracks) && existingContext.tracks.length > 0)
        ? existingContext.tracks
        : computedContext.tracks,
      selectedMetadata: computedContext.selectedMetadata || existingContext.selectedMetadata,
      canRestartEncodeFromLastSettings:
        existingContext.canRestartEncodeFromLastSettings ?? computedContext.canRestartEncodeFromLastSettings,
      canRestartReviewFromRaw:
        existingContext.canRestartReviewFromRaw ?? computedContext.canRestartReviewFromRaw
    };
    // The card always represents `job.id`; never let stale live context override it.
    mergedCurrentContext.jobId = jobId;
    return {
      ...currentPipeline,
      context: mergedCurrentContext
    };
  }

  // Use live per-job progress from the backend if available (concurrent jobs).
  const liveJobProgress = currentPipeline?.jobProgress && jobId
    ? (currentPipeline.jobProgress[jobId] || null)
    : null;
  const liveContext = liveJobProgress?.context && typeof liveJobProgress.context === 'object'
    ? liveJobProgress.context
    : null;
  const liveState = String(liveJobProgress?.state || '').trim().toUpperCase();
  const isTerminalJobStatus = jobStatus === 'FINISHED' || jobStatus === 'ERROR' || jobStatus === 'CANCELLED';
  const jobStatusIsRunning = processingStates.includes(jobStatus);
  const ignoreStaleLiveProgress = (
    (isTerminalJobStatus && processingStates.includes(liveState))
    || (!jobStatusIsRunning && jobStatus !== 'IDLE' && processingStates.includes(liveState))
  );
  const effectiveLiveContext = ignoreStaleLiveProgress ? null : liveContext;
  const mergedContext = effectiveLiveContext
    ? {
      ...computedContext,
      ...effectiveLiveContext,
      // Prefer the DB plan when it has been confirmed but the live (jobProgress) plan hasn't —
      // this happens when confirmEncodeReview is called with skipPipelineStateUpdate=true
      // (always the case for queued jobs), leaving jobProgress with the pre-confirmation plan.
      mediaInfoReview: (computedContext.mediaInfoReview?.reviewConfirmedAt && !effectiveLiveContext.mediaInfoReview?.reviewConfirmedAt)
        ? computedContext.mediaInfoReview
        : (effectiveLiveContext.mediaInfoReview || computedContext.mediaInfoReview),
      tracks: (Array.isArray(effectiveLiveContext.tracks) && effectiveLiveContext.tracks.length > 0)
        ? effectiveLiveContext.tracks
        : computedContext.tracks,
      selectedMetadata: computedContext.selectedMetadata || effectiveLiveContext.selectedMetadata,
      cdRipConfig: effectiveLiveContext.cdRipConfig || computedContext.cdRipConfig
    }
    : computedContext;
  // The card always represents `job.id`; never let stale live context override it.
  mergedContext.jobId = jobId;

  return {
    state: ignoreStaleLiveProgress ? jobStatus : (liveJobProgress?.state || jobStatus),
    activeJobId: jobId,
    progress: ignoreStaleLiveProgress
      ? 0
      : (liveJobProgress != null ? Number(liveJobProgress.progress ?? 0) : 0),
    eta: ignoreStaleLiveProgress ? null : (liveJobProgress?.eta || null),
    statusText: ignoreStaleLiveProgress
      ? (job?.error_message || null)
      : (liveJobProgress?.statusText || job?.error_message || null),
    context: mergedContext
  };
}

export default function RipperPage({
  pipeline,
  hardwareMonitoring,
  lastDiscEvent,
  refreshPipeline,
  jobsRefreshToken,
  downloadSummary = null,
  children = null
}) {
  const location = useLocation();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [busyJobIds, setBusyJobIds] = useState(() => new Set());
  const setJobBusy = (jobId, isBusy) => {
    setBusyJobIds((prev) => {
      const next = new Set(prev);
      if (isBusy) {
        next.add(jobId);
      } else {
        next.delete(jobId);
      }
      return next;
    });
  };
  const [metadataDialogVisible, setMetadataDialogVisible] = useState(false);
  const [metadataDialogContext, setMetadataDialogContext] = useState(null);
  const [metadataDialogReassignMode, setMetadataDialogReassignMode] = useState(false);
  const [cdMetadataDialogVisible, setCdMetadataDialogVisible] = useState(false);
  const [cdMetadataDialogContext, setCdMetadataDialogContext] = useState(null);
  const [cdRipPanelJobId, setCdRipPanelJobId] = useState(null);
  const [cancelCleanupDialog, setCancelCleanupDialog] = useState({
    visible: false,
    jobId: null,
    target: null,
    path: null
  });
  const [cancelCleanupBusy, setCancelCleanupBusy] = useState(false);
  const [queueState, setQueueState] = useState(() => normalizeQueue(pipeline?.queue));
  const [queueReorderBusy, setQueueReorderBusy] = useState(false);
  const [draggingQueueEntryId, setDraggingQueueEntryId] = useState(null);
  const [draggingMergeSource, setDraggingMergeSource] = useState(null);
  const [insertQueueDialog, setInsertQueueDialog] = useState({ visible: false, afterEntryId: null });
  const [runtimeActivities, setRuntimeActivities] = useState(() => normalizeRuntimeActivitiesPayload(null));
  const [runtimeLoading, setRuntimeLoading] = useState(false);
  const [runtimeActionBusyKeys, setRuntimeActionBusyKeys] = useState(() => new Set());
  const [runtimeRecentClearing, setRuntimeRecentClearing] = useState(false);
  const [jobsLoading, setJobsLoading] = useState(false);
  const [ripperJobs, setRipperJobs] = useState([]);
  const [multipartMergePreviewByJobId, setMultipartMergePreviewByJobId] = useState({});
  const [multipartMergePreviewLoadingByJobId, setMultipartMergePreviewLoadingByJobId] = useState({});
  const [multipartMergeLiveLogByJobId, setMultipartMergeLiveLogByJobId] = useState({});
  const [multipartMergeLiveLogLoadingByJobId, setMultipartMergeLiveLogLoadingByJobId] = useState({});
  const [expandedJobId, setExpandedJobId] = useState(undefined);
  const [activationBytesDialog, setActivationBytesDialog] = useState({ visible: false, checksum: null, jobId: null });
  const [activationBytesInput, setActivationBytesInput] = useState('');
  const [activationBytesBusy, setActivationBytesBusy] = useState(false);
  const [pendingActivationJobIds, setPendingActivationJobIds] = useState(() => new Set());
  const [knownDrives, setKnownDrives] = useState([]);
  const [driveRescanBusy, setDriveRescanBusy] = useState(() => new Set());
  const [driveAnalyzeBusy, setDriveAnalyzeBusy] = useState(() => new Set());
  const [expandedQueueScriptKeys, setExpandedQueueScriptKeys] = useState(() => new Set());
  const [queueCatalog, setQueueCatalog] = useState({ scripts: [], chains: [] });
  const [quickAccessCatalog, setQuickAccessCatalog] = useState({ scripts: [], chains: [] });
  const [quickAccessBusyKeys, setQuickAccessBusyKeys] = useState(() => new Set());
  const [insertWaitSeconds, setInsertWaitSeconds] = useState(30);
  const toastRef = useRef(null);
  const dismissedCdMetadataJobIdsRef = useRef(new Set());
  const dismissedActivationDialogKeyRef = useRef(null);

  const state = String(pipeline?.state || 'IDLE').trim().toUpperCase();
  const currentPipelineJobId = normalizeJobId(pipeline?.activeJobId || pipeline?.context?.jobId);
  const isProcessing = processingStates.includes(state);
  const setQuickAccessBusy = (entryKey, isBusy) => {
    const normalizedKey = String(entryKey || '').trim().toLowerCase();
    if (!normalizedKey) {
      return;
    }
    setQuickAccessBusyKeys((prev) => {
      const next = new Set(prev);
      if (isBusy) {
        next.add(normalizedKey);
      } else {
        next.delete(normalizedKey);
      }
      return next;
    });
  };
  const monitoringState = useMemo(
    () => normalizeHardwareMonitoringPayload(hardwareMonitoring),
    [hardwareMonitoring]
  );
  const cdDriveLifecycleKey = useMemo(
    () => buildCdDriveLifecycleKey(pipeline?.cdDrives),
    [pipeline?.cdDrives]
  );
  // Detects when a background job reaches an interactive review/selection state via
  // PIPELINE_PROGRESS (e.g. METADATA_LOOKUP, METADATA_SELECTION, READY_TO_ENCODE, WAITING_FOR_USER_DECISION),
  // triggering a ripper jobs reload.
  const jobProgressInteractiveSignature = useMemo(() => Object.entries(pipeline?.jobProgress || {})
    .filter(([, v]) => {
      const s = String(v?.state || '').toUpperCase();
      return s === 'METADATA_LOOKUP'
        || s === 'METADATA_SELECTION'
        || s === 'READY_TO_ENCODE'
        || s === 'WAITING_FOR_USER_DECISION';
    })
    .map(([id, value]) => `${id}:${String(value?.state || '').trim().toUpperCase()}`)
    .sort()
    .join(','),
  [pipeline?.jobProgress]);
  const monitoringSample = monitoringState.sample;
  const cpuMetrics = monitoringSample?.cpu || null;
  const memoryMetrics = monitoringSample?.memory || null;
  const gpuMetrics = monitoringSample?.gpu || null;
  const storageMetrics = Array.isArray(monitoringSample?.storage) ? monitoringSample.storage : [];
  const storageGroups = useMemo(() => {
    // Phase 1: group by mountPoint
    const phase1 = [];
    const mountMap = new Map();
    for (const entry of storageMetrics) {
      const groupKey = entry?.mountPoint || `__no_mount_${entry?.key}`;
      if (!mountMap.has(groupKey)) {
        const group = { mountPoint: entry?.mountPoint || null, entries: [], representative: entry };
        mountMap.set(groupKey, group);
        phase1.push(group);
      }
      mountMap.get(groupKey).entries.push(entry);
    }

    // Phase 2: merge groups with identical disk signature (same physical disk)
    const merged = [];
    const diskSigMap = new Map();
    for (const group of phase1) {
      const totalBytes = Number(group.representative?.totalBytes);
      const freeBytes = Number(group.representative?.freeBytes);
      if (Number.isFinite(totalBytes) && totalBytes > 0 && Number.isFinite(freeBytes)) {
        const sig = `${totalBytes}:${freeBytes}`;
        if (diskSigMap.has(sig)) {
          diskSigMap.get(sig).entries.push(...group.entries);
        } else {
          diskSigMap.set(sig, group);
          merged.push(group);
        }
      } else {
        merged.push(group);
      }
    }
    return merged;
  }, [storageMetrics]);
  const gpuDevices = Array.isArray(gpuMetrics?.devices) ? gpuMetrics.devices : [];
  const primaryGpuMetrics = gpuDevices[0] || null;
  const gpuSummaryUsage = primaryGpuMetrics?.utilizationPercent;
  const gpuSummaryTemp = primaryGpuMetrics?.temperatureC;
  const isRipperMainRoute = location.pathname === '/' || location.pathname === '/ripper';
  const isSubpageRoute = !isRipperMainRoute;

  const loadRipperJobs = async () => {
    setJobsLoading(true);
    try {
      const [jobsResponse, queueResponse] = await Promise.allSettled([
        api.getJobs({
          statuses: Array.from(ripperStatuses),
          limit: 160,
          lite: true,
          includeChildren: true
        }),
        api.getPipelineQueue()
      ]);
      const allJobs = jobsResponse.status === 'fulfilled'
        ? (Array.isArray(jobsResponse.value?.jobs) ? jobsResponse.value.jobs : [])
        : [];
      if (queueResponse.status === 'fulfilled') {
        setQueueState(normalizeQueue(queueResponse.value?.queue));
      }
      const shouldDisplayOnRipper = (job) => {
        if (resolveMediaType(job) === 'audiobook') {
          return false;
        }
        if (isConverterJob(job)) {
          return false;
        }
        if (
          String(job?.job_kind || '').trim().toLowerCase() === 'dvd_series_container'
          || String(job?.job_kind || '').trim().toLowerCase() === 'multipart_movie_container'
        ) {
          return false;
        }
        const normalizedStatus = String(job?.status || '').trim().toUpperCase();
        if (!ripperStatuses.has(normalizedStatus)) {
          return false;
        }
        if (isMultipartMergeJob(job)) {
          const mergeToolStatus = String(job?.handbrakeInfo?.status || '').trim().toUpperCase();
          const mergeCompleted = Boolean(
            normalizedStatus === 'FINISHED'
            || job?.encodeSuccess
            || mergeToolStatus === 'SUCCESS'
          );
          if (mergeCompleted) {
            return false;
          }
        }
        if (normalizedStatus !== 'CANCELLED') {
          return true;
        }
        const cancelledOrigin = String(job?.last_state || '').trim().toUpperCase();
        return !hiddenCancelledReviewOrigins.has(cancelledOrigin);
      };
      const next = allJobs
        .filter((job) => shouldDisplayOnRipper(job))
        .sort((a, b) => Number(b?.id || 0) - Number(a?.id || 0));

      const pinnedJobIds = new Set();
      if (currentPipelineJobId) {
        pinnedJobIds.add(currentPipelineJobId);
      }
      for (const driveState of Object.values(pipeline?.cdDrives || {})) {
        const driveJobId = normalizeJobId(driveState?.jobId);
        if (driveJobId) {
          pinnedJobIds.add(driveJobId);
        }
      }
      const missingPinnedJobIds = Array.from(pinnedJobIds)
        .filter((jobId) => !next.some((job) => normalizeJobId(job?.id) === jobId));
      if (missingPinnedJobIds.length > 0) {
        const pinnedResults = await Promise.allSettled(
          missingPinnedJobIds.map((jobId) => api.getJob(jobId, { lite: true, forceRefresh: true }))
        );
        for (const result of pinnedResults) {
          if (result.status !== 'fulfilled') {
            continue;
          }
          const job = result.value?.job;
          if (job && shouldDisplayOnRipper(job)) {
            next.unshift(job);
          }
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
      const filteredJobs = deduped.filter((job) => {
        const isSeriesBatchChild = Boolean(job?.encodePlan?.seriesBatchChild);
        return !isSeriesBatchChild;
      });

      setRipperJobs(filteredJobs);

      // Prüfen ob Audiobook-Jobs auf Activation Bytes warten
      try {
        const { pending } = await api.getPendingActivation();
        if (Array.isArray(pending) && pending.length > 0) {
          setPendingActivationJobIds(new Set(pending.map((p) => p.jobId)));
          // Modal automatisch öffnen wenn noch nicht sichtbar
          setActivationBytesDialog((prev) => {
            if (prev.visible) return prev;
            const first = pending[0];
            const pendingKey = buildActivationDialogKey(first?.checksum, first?.jobId);
            if (pendingKey && dismissedActivationDialogKeyRef.current === pendingKey) {
              return prev;
            }
            setActivationBytesInput('');
            return { visible: true, checksum: first.checksum, jobId: first.jobId };
          });
        } else {
          setPendingActivationJobIds(new Set());
          dismissedActivationDialogKeyRef.current = null;
        }
      } catch (_err) {
        // ignorieren
      }
    } catch (_error) {
      setRipperJobs([]);
    } finally {
      setJobsLoading(false);
    }
  };

  const loadQuickAccessFavorites = async () => {
    try {
      const [scriptsRes, chainsRes] = await Promise.allSettled([
        api.getScripts({ forceRefresh: true }),
        api.getScriptChains({ forceRefresh: true })
      ]);
      setQuickAccessCatalog({
        scripts: scriptsRes.status === 'fulfilled' && Array.isArray(scriptsRes.value?.scripts)
          ? scriptsRes.value.scripts
          : [],
        chains: chainsRes.status === 'fulfilled' && Array.isArray(chainsRes.value?.chains)
          ? chainsRes.value.chains
          : []
      });
    } catch (_error) {
      setQuickAccessCatalog({ scripts: [], chains: [] });
    }
  };

  useEffect(() => {
    if (!metadataDialogVisible) {
      return;
    }
    if (metadataDialogContext?.jobId) {
      if (isCdMetadataContext(metadataDialogContext)) {
        setMetadataDialogVisible(false);
        setMetadataDialogContext(null);
        setMetadataDialogReassignMode(false);
      }
      return;
    }
    if (pipeline?.state !== 'METADATA_LOOKUP' && pipeline?.state !== 'METADATA_SELECTION' && pipeline?.state !== 'WAITING_FOR_USER_DECISION') {
      setMetadataDialogVisible(false);
    }
  }, [pipeline?.state, metadataDialogVisible, metadataDialogContext, cdMetadataDialogVisible]);

  // Auto-open CD metadata dialog when any drive enters CD_METADATA_SELECTION
  useEffect(() => {
    // Do not steal focus from active video metadata selection (TMDb dialog).
    if (metadataDialogVisible && !isCdMetadataContext(metadataDialogContext)) {
      return;
    }
    const cdDrives = pipeline?.cdDrives;
    if (!cdDrives || typeof cdDrives !== 'object') return;
    const activeCdMetadataJobIds = new Set();
    for (const drive of Object.values(cdDrives)) {
      const driveState = String(drive?.state || '').trim().toUpperCase();
      const ctx = drive?.context && typeof drive.context === 'object' ? drive.context : null;
      const driveJobId = normalizeJobId(ctx?.jobId || drive?.jobId);
      if (driveState === 'CD_METADATA_SELECTION' && driveJobId) {
        activeCdMetadataJobIds.add(String(driveJobId));
      }
    }

    if (dismissedCdMetadataJobIdsRef.current.size > 0) {
      const nextDismissed = new Set(
        Array.from(dismissedCdMetadataJobIdsRef.current).filter((jobId) => activeCdMetadataJobIds.has(jobId))
      );
      dismissedCdMetadataJobIdsRef.current = nextDismissed;
    }

    for (const drive of Object.values(cdDrives)) {
      const driveState = String(drive?.state || '').trim().toUpperCase();
      const ctx = drive?.context && typeof drive.context === 'object' ? drive.context : null;
      const driveJobId = normalizeJobId(ctx?.jobId || drive?.jobId);
      const dismissed = driveJobId ? dismissedCdMetadataJobIdsRef.current.has(String(driveJobId)) : false;
      if (driveState === 'CD_METADATA_SELECTION' && ctx?.jobId && !cdMetadataDialogVisible && !dismissed) {
        setMetadataDialogVisible(false);
        setMetadataDialogContext(null);
        setMetadataDialogReassignMode(false);
        setCdMetadataDialogContext(ctx);
        setCdMetadataDialogVisible(true);
        break;
      }
      if (driveState === 'CD_READY_TO_RIP' && driveJobId) {
        setCdRipPanelJobId(driveJobId);
      }
    }
  }, [pipeline?.cdDrives, metadataDialogVisible, metadataDialogContext]);

  useEffect(() => {
    if (!cdMetadataDialogVisible) {
      return;
    }
    const dialogJobId = normalizeJobId(cdMetadataDialogContext?.jobId);
    if (!dialogJobId) {
      return;
    }
    const cdDrives = pipeline?.cdDrives;
    if (!cdDrives || typeof cdDrives !== 'object') {
      return;
    }

    let stillInMetadataSelection = false;
    for (const drive of Object.values(cdDrives)) {
      const driveState = String(drive?.state || '').trim().toUpperCase();
      const ctx = drive?.context && typeof drive.context === 'object' ? drive.context : null;
      const driveJobId = normalizeJobId(ctx?.jobId || drive?.jobId);
      if (driveJobId === dialogJobId && driveState === 'CD_METADATA_SELECTION') {
        stillInMetadataSelection = true;
        break;
      }
    }

    if (!stillInMetadataSelection) {
      setCdMetadataDialogVisible(false);
      setCdMetadataDialogContext(null);
    }
  }, [cdMetadataDialogVisible, cdMetadataDialogContext?.jobId, pipeline?.cdDrives]);

  useEffect(() => {
    setQueueState(normalizeQueue(pipeline?.queue));
  }, [pipeline?.queue]);

  useEffect(() => {
    void loadRipperJobs();
  }, [pipeline?.state, pipeline?.activeJobId, pipeline?.context?.jobId, cdDriveLifecycleKey, jobsRefreshToken, jobProgressInteractiveSignature]);

  useEffect(() => {
    const normalizedPipelineState = String(pipeline?.state || '').trim().toUpperCase();
    const isReviewState = normalizedPipelineState === 'READY_TO_ENCODE'
      || normalizedPipelineState === 'WAITING_FOR_USER_DECISION';
    if (!isReviewState || !currentPipelineJobId) {
      return;
    }
    setExpandedJobId(currentPipelineJobId);
  }, [pipeline?.state, currentPipelineJobId]);

  useEffect(() => {
    api.getDetectedDrives()
      .then((res) => setKnownDrives(Array.isArray(res?.drives) ? res.drives : []))
      .catch(() => {});
  }, []);

  useEffect(() => {
    void loadQuickAccessFavorites();
  }, []);

  useEffect(() => {
    let cancelled = false;
    const load = async (silent = false) => {
      try {
        const response = await api.getRuntimeActivities();
        if (!cancelled) {
          setRuntimeActivities(normalizeRuntimeActivitiesPayload(response));
          if (!silent) {
            setRuntimeLoading(false);
          }
        }
      } catch (_error) {
        if (!cancelled && !silent) {
          setRuntimeActivities(normalizeRuntimeActivitiesPayload(null));
          setRuntimeLoading(false);
        }
      }
    };
    setRuntimeLoading(true);
    void load(false);
    const interval = setInterval(() => {
      void load(true);
    }, 10000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  useWebSocket({
    onMessage: (message) => {
      if (message?.type === 'RUNTIME_ACTIVITY_CHANGED') {
        setRuntimeActivities(normalizeRuntimeActivitiesPayload(message.payload));
        setRuntimeLoading(false);
        return;
      }
      if (message?.type === 'SETTINGS_SCRIPTS_UPDATED' || message?.type === 'SETTINGS_SCRIPT_CHAINS_UPDATED') {
        void loadQuickAccessFavorites();
        return;
      }
    }
  });

  useEffect(() => {
    const normalizedExpanded = normalizeJobId(expandedJobId);
    const hasExpanded = ripperJobs.some((job) => normalizeJobId(job?.id) === normalizedExpanded);
    if (hasExpanded) {
      return;
    }

    // Respect explicit user collapse.
    if (expandedJobId === null) {
      return;
    }

    if (currentPipelineJobId && ripperJobs.some((job) => normalizeJobId(job?.id) === currentPipelineJobId)) {
      setExpandedJobId(currentPipelineJobId);
      return;
    }
    setExpandedJobId(normalizeJobId(ripperJobs[0]?.id));
  }, [ripperJobs, expandedJobId, currentPipelineJobId]);

  useEffect(() => {
    const normalizedExpanded = normalizeJobId(expandedJobId);
    if (!normalizedExpanded) {
      return;
    }
    const expandedJob = ripperJobs.find((job) => normalizeJobId(job?.id) === normalizedExpanded) || null;
    if (!expandedJob || !isMultipartMergeJob(expandedJob)) {
      return;
    }
    void loadMultipartMergePreview(normalizedExpanded, { force: false, silent: true });
  }, [expandedJobId, ripperJobs]);

  useEffect(() => {
    const normalizedExpanded = normalizeJobId(expandedJobId);
    if (!normalizedExpanded) {
      return undefined;
    }
    const expandedJob = ripperJobs.find((job) => normalizeJobId(job?.id) === normalizedExpanded) || null;
    if (!expandedJob || !isMultipartMergeJob(expandedJob)) {
      return undefined;
    }
    const expandedStatus = String(expandedJob?.status || expandedJob?.last_state || '').trim().toUpperCase();
    if (expandedStatus !== 'ENCODING') {
      setMultipartMergeLiveLogLoadingByJobId((prev) => ({
        ...prev,
        [normalizedExpanded]: false
      }));
      return undefined;
    }

    let cancelled = false;
    const refresh = async () => {
      setMultipartMergeLiveLogLoadingByJobId((prev) => ({
        ...prev,
        [normalizedExpanded]: true
      }));
      try {
        const response = await api.getJob(normalizedExpanded, {
          includeLiveLog: true,
          lite: true,
          logTailLines: 400
        });
        if (cancelled) {
          return;
        }
        const liveJob = response?.job && typeof response.job === 'object'
          ? response.job
          : null;
        setMultipartMergeLiveLogByJobId((prev) => ({
          ...prev,
          [normalizedExpanded]: String(liveJob?.log || '').trim()
        }));
      } catch (_error) {
        if (_error?.status === 404) {
          cancelled = true;
          setMultipartMergeLiveLogByJobId((prev) => ({
            ...prev,
            [normalizedExpanded]: ''
          }));
          void loadRipperJobs();
          return;
        }
        if (!cancelled) {
          setMultipartMergeLiveLogByJobId((prev) => ({
            ...prev,
            [normalizedExpanded]: ''
          }));
        }
      } finally {
        if (!cancelled) {
          setMultipartMergeLiveLogLoadingByJobId((prev) => ({
            ...prev,
            [normalizedExpanded]: false
          }));
        }
      }
    };

    void refresh();
    const interval = setInterval(refresh, 2500);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [expandedJobId, ripperJobs]);

  const pipelineByJobId = useMemo(() => {
    const map = new Map();
    for (const job of ripperJobs) {
      const id = normalizeJobId(job?.id);
      if (!id) {
        continue;
      }
      map.set(id, buildPipelineFromJob(job, pipeline, currentPipelineJobId));
    }
    return map;
  }, [ripperJobs, pipeline, currentPipelineJobId]);

  const buildMetadataContextForJob = (jobId) => {
    const normalizedJobId = normalizeJobId(jobId);
    if (!normalizedJobId) {
      return null;
    }
    const job = ripperJobs.find((item) => normalizeJobId(item?.id) === normalizedJobId) || null;
    const pipelineForJob = pipelineByJobId.get(normalizedJobId) || null;
    const context = pipelineForJob?.context && typeof pipelineForJob.context === 'object'
      ? pipelineForJob.context
      : {};
    const selectedMetadata = context.selectedMetadata && typeof context.selectedMetadata === 'object'
      ? context.selectedMetadata
      : {
        title: job?.title || job?.detected_title || context?.detectedTitle || '',
        year: job?.year || null,
        imdbId: job?.imdb_id || null,
        poster: job?.poster_url || null,
        metadataProvider: context?.metadataProvider || 'tmdb',
        seasonNumber: null,
        discNumber: null
      };
    return {
      ...context,
      jobId: normalizedJobId,
      detectedTitle: context?.detectedTitle || job?.detected_title || selectedMetadata?.title || '',
      selectedMetadata,
      metadataProvider: selectedMetadata?.metadataProvider || context?.metadataProvider || 'tmdb',
      metadataCandidates: Array.isArray(context?.metadataCandidates) ? context.metadataCandidates : [],
      seriesAnalysis: context?.seriesAnalysis || null,
      seriesLookupHint: context?.seriesLookupHint || null
    };
  };

  const defaultMetadataDialogContext = useMemo(() => {
    const currentState = String(pipeline?.state || '').trim().toUpperCase();
    const currentContext = pipeline?.context && typeof pipeline.context === 'object'
      ? pipeline.context
      : null;
    const currentContextJobId = normalizeJobId(currentContext?.jobId);
    if (
      (currentState === 'METADATA_LOOKUP' || currentState === 'METADATA_SELECTION' || currentState === 'WAITING_FOR_USER_DECISION')
      && currentContextJobId
    ) {
      return {
        ...currentContext,
        jobId: currentContextJobId,
        selectedMetadata: currentContext?.selectedMetadata || {
          title: currentContext?.detectedTitle || '',
          year: null,
          imdbId: null,
          poster: null,
          metadataProvider: currentContext?.metadataProvider || 'tmdb',
          seasonNumber: null,
          discNumber: null
        },
        metadataProvider: currentContext?.selectedMetadata?.metadataProvider || currentContext?.metadataProvider || 'tmdb',
        metadataCandidates: Array.isArray(currentContext?.metadataCandidates) ? currentContext.metadataCandidates : [],
        seriesAnalysis: currentContext?.seriesAnalysis || null,
        seriesLookupHint: currentContext?.seriesLookupHint || null
      };
    }

    const pendingJob = ripperJobs.find((job) => {
      const normalized = normalizeStatus(job?.status);
      return normalized === 'METADATA_LOOKUP' || normalized === 'METADATA_SELECTION' || normalized === 'WAITING_FOR_USER_DECISION';
    });
    if (!pendingJob) {
      return null;
    }
    return buildMetadataContextForJob(pendingJob.id);
  }, [pipeline, ripperJobs, pipelineByJobId]);

  const effectiveMetadataDialogContext = metadataDialogContext
    || defaultMetadataDialogContext
    || pipeline?.context
    || {};
  const metadataDialogContextIsCd = isCdMetadataContext(effectiveMetadataDialogContext);
  const metadataDialogShouldBeVisible = metadataDialogVisible
    && !metadataDialogContextIsCd
    && !cdMetadataDialogVisible;

  const showError = (error) => {
    toastRef.current?.show({
      severity: 'error',
      summary: 'Fehler',
      detail: error.message,
      life: 4500
    });
  };

  const buildActivationDialogKey = (checksum, jobId) => {
    const normalizedJobId = normalizeJobId(jobId) || 0;
    const normalizedChecksum = String(checksum || '').trim().toLowerCase();
    return `${normalizedJobId}:${normalizedChecksum}`;
  };

  const hideCdMetadataDialog = () => {
    const dialogJobId = normalizeJobId(cdMetadataDialogContext?.jobId);
    if (dialogJobId) {
      dismissedCdMetadataJobIdsRef.current.add(String(dialogJobId));
    }
    setCdMetadataDialogVisible(false);
    setCdMetadataDialogContext(null);
  };

  const hideActivationBytesDialog = () => {
    const key = buildActivationDialogKey(activationBytesDialog?.checksum, activationBytesDialog?.jobId);
    if (key && key !== '0:') {
      dismissedActivationDialogKeyRef.current = key;
    }
    setActivationBytesDialog({ visible: false, checksum: null, jobId: null });
  };

  const normalizeCdTracks = (tracks) => {
    const source = Array.isArray(tracks) ? tracks : [];
    return source
      .map((track) => {
        const position = Number(track?.position);
        if (!Number.isFinite(position) || position <= 0) {
          return null;
        }
        return {
          ...track,
          position: Math.trunc(position),
          selected: track?.selected !== false
        };
      })
      .filter(Boolean);
  };

  const hydrateCdMetadataContext = async (rawContext, fallbackJobId = null) => {
    const context = rawContext && typeof rawContext === 'object' ? rawContext : {};
    const contextJobId = normalizeJobId(context?.jobId) || normalizeJobId(fallbackJobId);
    const existingTracks = normalizeCdTracks(context?.tracks);
    if (!contextJobId) {
      return {
        ...context,
        ...(contextJobId ? { jobId: contextJobId } : {}),
        tracks: existingTracks
      };
    }

    try {
      const response = await api.getJob(contextJobId, { forceRefresh: true });
      const job = response?.job && typeof response.job === 'object' ? response.job : null;
      const makemkvInfo = job?.makemkvInfo && typeof job.makemkvInfo === 'object' ? job.makemkvInfo : {};
      const encodePlan = job?.encodePlan && typeof job.encodePlan === 'object' ? job.encodePlan : {};
      const hydratedTracks = normalizeCdTracks(makemkvInfo?.tracks || encodePlan?.tracks || []);
      const selectedMetadata = makemkvInfo?.selectedMetadata && typeof makemkvInfo.selectedMetadata === 'object'
        ? makemkvInfo.selectedMetadata
        : {};
      const analyzeContext = makemkvInfo?.analyzeContext && typeof makemkvInfo.analyzeContext === 'object'
        ? makemkvInfo.analyzeContext
        : {};
      const detectedTitle = String(
        context?.detectedTitle
        || analyzeContext?.detectedTitle
        || job?.detected_title
        || selectedMetadata?.title
        || job?.title
        || ''
      ).trim();

      return {
        ...context,
        jobId: contextJobId,
        detectedTitle: detectedTitle || context?.detectedTitle || '',
        mediaProfile: context?.mediaProfile || analyzeContext?.mediaProfile || makemkvInfo?.mediaProfile || 'cd',
        selectedMetadata: context?.selectedMetadata && typeof context.selectedMetadata === 'object'
          ? context.selectedMetadata
          : selectedMetadata,
        tracks: hydratedTracks.length > 0 ? hydratedTracks : existingTracks
      };
    } catch (_error) {
      return {
        ...context,
        ...(contextJobId ? { jobId: contextJobId } : {}),
        tracks: existingTracks
      };
    }
  };

  const openCdMetadataDialogWithContext = async (rawContext, fallbackJobId = null) => {
    const hydratedContext = await hydrateCdMetadataContext(rawContext, fallbackJobId);
    const hydratedJobId = normalizeJobId(hydratedContext?.jobId);
    if (hydratedJobId) {
      dismissedCdMetadataJobIdsRef.current.delete(String(hydratedJobId));
    }
    setMetadataDialogVisible(false);
    setMetadataDialogContext(null);
    setMetadataDialogReassignMode(false);
    setCdMetadataDialogContext(hydratedContext);
    setCdMetadataDialogVisible(true);
  };

  const loadMultipartMergePreview = async (jobId, options = {}) => {
    const normalizedJobId = normalizeJobId(jobId);
    if (!normalizedJobId) {
      return null;
    }
    const force = options?.force === true;
    const silent = options?.silent !== false;
    if (!force) {
      const existingPreview = multipartMergePreviewByJobId[normalizedJobId];
      if (existingPreview) {
        return existingPreview;
      }
    }
    if (!force && multipartMergePreviewLoadingByJobId[normalizedJobId]) {
      return null;
    }
    setMultipartMergePreviewLoadingByJobId((prev) => ({
      ...prev,
      [normalizedJobId]: true
    }));
    try {
      const response = await api.getMultipartMergePreview(normalizedJobId);
      const preview = response?.preview && typeof response.preview === 'object'
        ? response.preview
        : null;
      setMultipartMergePreviewByJobId((prev) => ({
        ...prev,
        [normalizedJobId]: preview
      }));
      return preview;
    } catch (error) {
      if (!silent) {
        showError(error);
      }
      return null;
    } finally {
      setMultipartMergePreviewLoadingByJobId((prev) => ({
        ...prev,
        [normalizedJobId]: false
      }));
    }
  };

  const handleOpenMetadataDialog = async (jobId = null) => {
    const context = jobId ? buildMetadataContextForJob(jobId) : defaultMetadataDialogContext;
    if (!context?.jobId) {
      showError(new Error('Kein Job mit offener Metadaten-Auswahl gefunden.'));
      return;
    }
    if (isCdMetadataContext(context)) {
      await openCdMetadataDialogWithContext(context, jobId);
      return;
    }
    setMetadataDialogReassignMode(false);
    setCdMetadataDialogVisible(false);
    setCdMetadataDialogContext(null);
    setMetadataDialogContext(context);
    setMetadataDialogVisible(true);
  };

  const handleOpenReassignMetadataDialog = async (jobId) => {
    const context = buildMetadataContextForJob(jobId);
    if (!context?.jobId) {
      showError(new Error('Job nicht gefunden.'));
      return;
    }
    if (isCdMetadataContext(context)) {
      await openCdMetadataDialogWithContext(context, jobId);
      return;
    }
    setMetadataDialogReassignMode(true);
    setCdMetadataDialogVisible(false);
    setCdMetadataDialogContext(null);
    setMetadataDialogContext(context);
    setMetadataDialogVisible(true);
  };

  const handleAnalyze = async () => {
    setBusy(true);
    try {
      const response = await api.analyzeDisc();
      await refreshPipeline();
      await loadRipperJobs();
      const analyzedJobId = normalizeJobId(response?.result?.jobId);
      const isCdAnalyzeResult = isCdAnalyzeResponsePayload(response?.result);
      if (analyzedJobId) {
        if (isCdAnalyzeResult) {
          setMetadataDialogVisible(false);
          setMetadataDialogContext(null);
          setMetadataDialogReassignMode(false);
          setCdMetadataDialogContext({
            ...(pipeline?.context && typeof pipeline.context === 'object' ? pipeline.context : {}),
            jobId: analyzedJobId,
            mediaProfile: 'cd',
            detectedTitle: response?.result?.detectedTitle || '',
            tracks: Array.isArray(response?.result?.tracks) ? response.result.tracks : []
          });
          setCdMetadataDialogVisible(true);
          return;
        }
        setMetadataDialogContext({
          jobId: analyzedJobId,
          detectedTitle: response?.result?.detectedTitle || '',
          workflowKind: response?.result?.workflowKind || null,
          selectedMetadata: {
            title: response?.result?.detectedTitle || '',
            year: null,
            imdbId: null,
            poster: null,
            metadataProvider: response?.result?.metadataProvider || 'tmdb',
            seasonNumber: null
          },
          metadataProvider: response?.result?.metadataProvider || 'tmdb',
          metadataCandidates: Array.isArray(response?.result?.metadataCandidates)
            ? response.result.metadataCandidates
            : [],
          seriesAnalysis: response?.result?.seriesAnalysis || null,
          seriesLookupHint: response?.result?.seriesLookupHint || null,
          seriesDecision: response?.result?.seriesDecision || null
        });
        setCdMetadataDialogVisible(false);
        setCdMetadataDialogContext(null);
        setMetadataDialogVisible(true);
      }
    } catch (error) {
      showError(error);
    } finally {
      setBusy(false);
    }
  };

  const handleReanalyze = async () => {
    await handleAnalyze();
  };

  const handleAnalyzeForDrive = async (devicePath) => {
    setDriveAnalyzeBusy((prev) => new Set([...prev, devicePath]));
    try {
      const response = await api.analyzeDisc(devicePath);
      await refreshPipeline();
      await loadRipperJobs();
      const analyzedJobId = normalizeJobId(response?.result?.jobId);
      const isCdAnalyzeResult = isCdAnalyzeResponsePayload(response?.result);
      if (analyzedJobId) {
        if (isCdAnalyzeResult) {
          setMetadataDialogVisible(false);
          setMetadataDialogContext(null);
          setMetadataDialogReassignMode(false);
          setCdMetadataDialogContext({
            ...(pipeline?.context && typeof pipeline.context === 'object' ? pipeline.context : {}),
            jobId: analyzedJobId,
            mediaProfile: 'cd',
            detectedTitle: response?.result?.detectedTitle || '',
            tracks: Array.isArray(response?.result?.tracks) ? response.result.tracks : []
          });
          setCdMetadataDialogVisible(true);
          return;
        }
        setMetadataDialogContext({
          jobId: analyzedJobId,
          detectedTitle: response?.result?.detectedTitle || '',
          workflowKind: response?.result?.workflowKind || null,
          selectedMetadata: {
            title: response?.result?.detectedTitle || '',
            year: null,
            imdbId: null,
            poster: null,
            metadataProvider: response?.result?.metadataProvider || 'tmdb',
            seasonNumber: null
          },
          metadataProvider: response?.result?.metadataProvider || 'tmdb',
          metadataCandidates: Array.isArray(response?.result?.metadataCandidates)
            ? response.result.metadataCandidates
            : [],
          seriesAnalysis: response?.result?.seriesAnalysis || null,
          seriesLookupHint: response?.result?.seriesLookupHint || null,
          seriesDecision: response?.result?.seriesDecision || null
        });
        setCdMetadataDialogVisible(false);
        setCdMetadataDialogContext(null);
        setMetadataDialogVisible(true);
      }
    } catch (error) {
      showError(error);
    } finally {
      setDriveAnalyzeBusy((prev) => {
        const next = new Set(prev);
        next.delete(devicePath);
        return next;
      });
    }
  };

  const handleAnalyzeAll = async () => {
    const lockedPaths = new Set(
      (Array.isArray(pipeline?.driveLocks) ? pipeline.driveLocks : [])
        .filter((lock) => Number(lock?.count || 0) > 0)
        .map((lock) => normalizeDrivePath(lock?.path))
        .filter(Boolean)
    );
    const drivesToAnalyze = allDrives
      .filter((drv) => {
        if (lockedPaths.has(normalizeDrivePath(drv.path))) {
          return false;
        }
        const cdState = drv.cdDrive ? String(drv.cdDrive.state || '').toUpperCase() : null;
        if (cdState) return cdState === 'DISC_DETECTED';
        if (Boolean(drv.pipelineDevice) && String(drv.pipelineState || '').toUpperCase() === 'DISC_DETECTED') return true;
        return Boolean(drv.detectedDisc);
      })
      .map((drv) => drv.path);
    if (drivesToAnalyze.length === 0) return;
    await Promise.all(drivesToAnalyze.map((path) => handleAnalyzeForDrive(path)));
  };

  const handleRescan = async () => {
    setBusy(true);
    try {
      const response = await api.rescanDisc();
      refreshKnownDrives();
      const allDetected = Array.isArray(response?.result?.allDetected) ? response.result.allDetected : [];
      const count = allDetected.length;
      toastRef.current?.show({
        severity: count > 0 ? 'success' : 'info',
        summary: 'Laufwerke neu gelesen',
        detail: count > 0
          ? `${count > 1 ? `${count} Medien` : '1 Medium'} erkannt.`
          : 'Kein Medium erkannt.',
        life: 2800
      });
      await refreshPipeline();
      await loadRipperJobs();
    } catch (error) {
      showError(error);
    } finally {
      setBusy(false);
    }
  };

  const refreshKnownDrives = () => {
    api.getDetectedDrives()
      .then((res) => setKnownDrives(Array.isArray(res?.drives) ? res.drives : []))
      .catch(() => {});
  };

  const handleRescanDrive = async (devicePath) => {
    setDriveRescanBusy((prev) => new Set([...prev, devicePath]));
    try {
      const response = await api.rescanDrive(devicePath);
      refreshKnownDrives();
      const emitted = response?.result?.emitted || 'none';
      toastRef.current?.show({
        severity: emitted === 'discInserted' ? 'success' : 'info',
        summary: devicePath,
        detail: emitted === 'discInserted'
          ? 'Medium erkannt.'
          : emitted === 'discRemoved' ? 'Medium entfernt.' : 'Leer.',
        life: 2500
      });
      await refreshPipeline();
    } catch (error) {
      showError(error);
    } finally {
      setDriveRescanBusy((prev) => {
        const next = new Set(prev);
        next.delete(devicePath);
        return next;
      });
    }
  };

  const handleCancel = async (jobId = null, jobState = null) => {
    const cancelledJobId = normalizeJobId(jobId) || currentPipelineJobId;
    const cancelledJob = ripperJobs.find((item) => normalizeJobId(item?.id) === cancelledJobId) || null;
    const cancelledState = String(
      jobState
      || cancelledJob?.status
      || state
      || 'IDLE'
    ).trim().toUpperCase();

    if (cancelledJobId) setJobBusy(cancelledJobId, true);
    try {
      await api.cancelPipeline(cancelledJobId);
      await refreshPipeline();
      await loadRipperJobs();
      const terminalStatuses = new Set(['FINISHED', 'ERROR', 'CANCELLED']);
      const resolveLifecycleStatus = (job) => String(
        job?.status
        || job?.last_state
        || ''
      ).trim().toUpperCase();
      let latestCancelledJob = null;
      const fetchLatestCancelledJob = async () => {
        if (!cancelledJobId) {
          return null;
        }
        try {
          const latestResponse = await api.getJob(cancelledJobId, { lite: true, forceRefresh: true });
          return latestResponse?.job && typeof latestResponse.job === 'object'
            ? latestResponse.job
            : null;
        } catch (_error) {
          return null;
        }
      };
      latestCancelledJob = await fetchLatestCancelledJob();
      const initialObservedStatus = resolveLifecycleStatus(latestCancelledJob) || cancelledState;
      if (cancelledJobId && !terminalStatuses.has(initialObservedStatus)) {
        const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        for (let attempt = 0; attempt < 12; attempt += 1) {
          const latestStatus = resolveLifecycleStatus(latestCancelledJob);
          if (terminalStatuses.has(latestStatus)) {
            break;
          }
          await wait(300);
          latestCancelledJob = await fetchLatestCancelledJob();
          if ((attempt + 1) % 4 === 0) {
            await refreshPipeline();
          }
        }
      }
      await refreshPipeline();
      await loadRipperJobs();
      // No post-cancel cleanup dialog here; encode/rip cleanup is handled by settings or retry flows.
    } catch (error) {
      showError(error);
    } finally {
      if (cancelledJobId) setJobBusy(cancelledJobId, false);
    }
  };

  const handleDeleteCancelledOutput = async () => {
    const jobId = normalizeJobId(cancelCleanupDialog?.jobId);
    const target = String(cancelCleanupDialog?.target || '').trim().toLowerCase();
    const effectiveTarget = target === 'raw' ? 'raw' : 'movie';
    const jobRow = (Array.isArray(ripperJobs) ? ripperJobs : [])
      .find((row) => normalizeJobId(row?.id) === jobId) || null;
    const includeRelated = isSeriesVideoJob(jobRow);
    if (!jobId) {
      setCancelCleanupDialog({ visible: false, jobId: null, target: null, path: null });
      return;
    }

    setCancelCleanupBusy(true);
    try {
      const response = await api.deleteJobFiles(jobId, effectiveTarget, { includeRelated });
      const summary = response?.summary || {};
      const targetSummary = effectiveTarget === 'raw'
        ? (summary.raw || {})
        : (summary.movie || {});
      const deletedFiles = targetSummary.filesDeleted ?? 0;
      const removedDirs = targetSummary.dirsRemoved ?? 0;
      const deletedSomething = Boolean(targetSummary.deleted);

      if (!deletedSomething) {
        toastRef.current?.show({
          severity: 'warn',
          summary: effectiveTarget === 'raw' ? 'RAW nicht gelöscht' : 'Movie nicht gelöscht',
          detail: targetSummary.reason || 'Keine passenden Dateien/Ordner gefunden.',
          life: 4200
        });
      } else {
        toastRef.current?.show({
          severity: 'success',
          summary: effectiveTarget === 'raw' ? 'RAW gelöscht' : 'Movie gelöscht',
          detail: `Entfernt: ${deletedFiles} Datei(en), ${removedDirs} Ordner.`,
          life: 4000
        });
      }
      await loadRipperJobs();
      await refreshPipeline();
      setCancelCleanupDialog({ visible: false, jobId: null, target: null, path: null });
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
    const startJobRow = ripperJobs.find((item) => normalizeJobId(item?.id) === normalizedJobId) || null;
    const mediaType = resolveMediaType(startJobRow);
    setJobBusy(normalizedJobId, true);
    try {
      if (startOptions.ensureConfirmed) {
        const confirmPayload = {
          selectedEncodeTitleId: startOptions.selectedEncodeTitleId ?? null,
          selectedEncodeTitleIds: startOptions.selectedEncodeTitleIds ?? null,
          selectedTrackSelection: startOptions.selectedTrackSelection ?? null,
          episodeAssignments: startOptions.episodeAssignments ?? null,
          skipPipelineStateUpdate: true
        };
        if (startOptions.selectedPostEncodeScriptIds !== undefined) {
          confirmPayload.selectedPostEncodeScriptIds = startOptions.selectedPostEncodeScriptIds;
        }
        if (startOptions.selectedPreEncodeScriptIds !== undefined) {
          confirmPayload.selectedPreEncodeScriptIds = startOptions.selectedPreEncodeScriptIds;
        }
        if (startOptions.selectedPostEncodeChainIds !== undefined) {
          confirmPayload.selectedPostEncodeChainIds = startOptions.selectedPostEncodeChainIds;
        }
        if (startOptions.selectedPreEncodeChainIds !== undefined) {
          confirmPayload.selectedPreEncodeChainIds = startOptions.selectedPreEncodeChainIds;
        }
        if (startOptions.selectedUserPresetId !== undefined) {
          confirmPayload.selectedUserPresetId = startOptions.selectedUserPresetId;
        }
        if (startOptions.selectedHandBrakePreset !== undefined) {
          confirmPayload.selectedHandBrakePreset = startOptions.selectedHandBrakePreset;
        }
        await api.confirmEncodeReview(normalizedJobId, confirmPayload);
      }
      const response = mediaType === 'audiobook'
        ? await api.startJob(normalizedJobId)
        : await api.startJob(normalizedJobId);
      const result = getQueueActionResult(response);
      await refreshPipeline();
      await loadRipperJobs();
      if (result.queued) {
        showQueuedToast(toastRef, 'Start', result);
      } else {
        setExpandedJobId(normalizedJobId);
      }
    } catch (error) {
      showError(error);
    } finally {
      setJobBusy(normalizedJobId, false);
    }
  };

  const handleReorderMultipartMergeSources = async (jobId, orderedSourceJobIds = []) => {
    const normalizedJobId = normalizeJobId(jobId);
    if (!normalizedJobId) {
      return;
    }
    const normalizedOrderedIds = Array.isArray(orderedSourceJobIds)
      ? orderedSourceJobIds.map((value) => normalizeJobId(value)).filter(Boolean)
      : [];
    if (normalizedOrderedIds.length < 2) {
      return;
    }
    setJobBusy(normalizedJobId, true);
    try {
      await api.reorderMultipartMergeSources(normalizedJobId, normalizedOrderedIds);
      await refreshPipeline();
      await loadRipperJobs();
      await loadMultipartMergePreview(normalizedJobId, { force: true, silent: true });
      setExpandedJobId(normalizedJobId);
    } catch (error) {
      showError(error);
    } finally {
      setJobBusy(normalizedJobId, false);
    }
  };

  const handleUpdateMultipartMergeSettings = async (jobId, settings = {}) => {
    const normalizedJobId = normalizeJobId(jobId);
    if (!normalizedJobId) {
      return;
    }
    setJobBusy(normalizedJobId, true);
    try {
      await api.updateMultipartMergeSettings(normalizedJobId, settings);
      await refreshPipeline();
      await loadRipperJobs();
      setExpandedJobId(normalizedJobId);
    } catch (error) {
      showError(error);
    } finally {
      setJobBusy(normalizedJobId, false);
    }
  };

  const handleSaveActivationBytes = async () => {
    const { checksum, jobId } = activationBytesDialog;
    const bytes = activationBytesInput.trim().toLowerCase();
    setActivationBytesBusy(true);
    try {
      await api.saveActivationBytes(checksum, bytes);
      setPendingActivationJobIds(new Set());
      dismissedActivationDialogKeyRef.current = null;
      setActivationBytesDialog({ visible: false, checksum: null, jobId: null });
      toastRef.current?.show({
        severity: 'success',
        summary: 'Activation Bytes gespeichert',
        detail: jobId ? `Job #${jobId} kann jetzt gestartet werden.` : 'Bytes wurden lokal gespeichert.',
        life: 4000
      });
      await loadRipperJobs();
    } catch (error) {
      showError(error);
    } finally {
      setActivationBytesBusy(false);
    }
  };

  const handleAudiobookStart = async (jobId, audiobookConfig) => {
    const normalizedJobId = normalizeJobId(jobId);
    if (!normalizedJobId) {
      return;
    }
    if (pendingActivationJobIds.has(normalizedJobId)) {
      setActivationBytesInput('');
      const pending = await api.getPendingActivation().catch(() => ({ pending: [] }));
      const entry = (pending?.pending || []).find((p) => p.jobId === normalizedJobId);
      if (entry) {
        dismissedActivationDialogKeyRef.current = null;
        setActivationBytesDialog({ visible: true, checksum: entry.checksum, jobId: normalizedJobId });
      }
      return;
    }
    setJobBusy(normalizedJobId, true);
    try {
      const response = await api.startAudiobook(normalizedJobId, audiobookConfig || {});
      const result = getQueueActionResult(response);
      await refreshPipeline();
      await loadRipperJobs();
      if (result.queued) {
        showQueuedToast(toastRef, 'Audiobook', result);
      } else {
        setExpandedJobId(normalizedJobId);
      }
    } catch (error) {
      showError(error);
    } finally {
      setJobBusy(normalizedJobId, false);
    }
  };

  const handleConfirmReview = async (
    jobId,
    selectedEncodeTitleId = null,
    selectedTrackSelection = null,
    selectedPostEncodeScriptIds = undefined,
    selectedUserPresetId = undefined,
    selectedHandBrakePreset = undefined,
    selectedEncodeTitleIds = undefined,
    episodeAssignments = undefined
  ) => {
    const normalizedJobId = normalizeJobId(jobId);
    if (normalizedJobId) setJobBusy(normalizedJobId, true);
    try {
      const payload = {
        selectedEncodeTitleId,
        selectedTrackSelection
      };
      if (selectedEncodeTitleIds !== undefined) {
        payload.selectedEncodeTitleIds = selectedEncodeTitleIds;
      }
      if (selectedPostEncodeScriptIds !== undefined) {
        payload.selectedPostEncodeScriptIds = selectedPostEncodeScriptIds;
      }
      if (episodeAssignments !== undefined) {
        payload.episodeAssignments = episodeAssignments;
      }
      if (selectedUserPresetId !== undefined) {
        payload.selectedUserPresetId = selectedUserPresetId;
      }
      if (selectedHandBrakePreset !== undefined) {
        payload.selectedHandBrakePreset = selectedHandBrakePreset;
      }
      await api.confirmEncodeReview(jobId, payload);
      await refreshPipeline();
      await loadRipperJobs();
      setExpandedJobId(normalizedJobId);
    } catch (error) {
      showError(error);
    } finally {
      if (normalizedJobId) setJobBusy(normalizedJobId, false);
    }
  };

  const handleSelectPlaylist = async (jobId, selectedPlaylist = null) => {
    const normalizedJobId = normalizeJobId(jobId);
    if (normalizedJobId) setJobBusy(normalizedJobId, true);
    try {
      await api.selectMetadata({
        jobId,
        selectedPlaylist: selectedPlaylist || null
      });
      await refreshPipeline();
      await loadRipperJobs();
      setExpandedJobId(normalizedJobId);
    } catch (error) {
      showError(error);
    } finally {
      if (normalizedJobId) setJobBusy(normalizedJobId, false);
    }
  };

  const handleSelectHandBrakeTitle = async (jobId, selectedHandBrakeTitleIds = null) => {
    const normalizedJobId = normalizeJobId(jobId);
    if (normalizedJobId) setJobBusy(normalizedJobId, true);
    try {
      const normalizedIds = (Array.isArray(selectedHandBrakeTitleIds) ? selectedHandBrakeTitleIds : [selectedHandBrakeTitleIds])
        .map((value) => Number(value))
        .filter((value) => Number.isFinite(value) && value > 0)
        .map((value) => Math.trunc(value));
      const dedupedIds = Array.from(new Set(normalizedIds));
      await api.selectMetadata({
        jobId,
        selectedHandBrakeTitleId: dedupedIds[0] || null,
        selectedHandBrakeTitleIds: dedupedIds
      });
      await refreshPipeline();
      await loadRipperJobs();
      setExpandedJobId(normalizedJobId);
    } catch (error) {
      showError(error);
    } finally {
      if (normalizedJobId) setJobBusy(normalizedJobId, false);
    }
  };

  const handleSubmitRawDecision = async (jobId, decision) => {
    const normalizedJobId = normalizeJobId(jobId);
    if (normalizedJobId) setJobBusy(normalizedJobId, true);
    try {
      await api.submitRawDecision(jobId, decision);
      await refreshPipeline();
      await loadRipperJobs();
      setExpandedJobId(normalizedJobId);
    } catch (error) {
      showError(error);
    } finally {
      if (normalizedJobId) setJobBusy(normalizedJobId, false);
    }
  };

  const handleRetry = async (jobId) => {
    const normalizedJobId = normalizeJobId(jobId);
    const retryJobRow = ripperJobs.find((item) => normalizeJobId(item?.id) === normalizedJobId) || null;
    const title = retryJobRow?.title || retryJobRow?.detected_title || `Job #${normalizedJobId || jobId}`;
    const mediaType = retryJobRow ? resolveMediaType(retryJobRow) : null;
    const diskLabel = mediaType === 'cd' ? 'CD' : 'Disk';
    const confirmed = await confirmModal({
      header: 'Rip neu starten',
      message: `Bitte lege die korrekte ${diskLabel} für "${title}" ein.\nSoll der Rip jetzt gestartet werden?`,
      acceptLabel: 'Rip starten',
      rejectLabel: 'Abbrechen'
    });
    if (!confirmed) {
      return;
    }

    if (normalizedJobId) setJobBusy(normalizedJobId, true);
    try {
      const response = await api.retryJob(jobId);
      const result = getQueueActionResult(response);
      const retryJobId = normalizeJobId(result?.jobId) || normalizedJobId;
      await refreshPipeline();
      await loadRipperJobs();
      if (result.queued) {
        showQueuedToast(toastRef, 'Retry', result);
      } else {
        setExpandedJobId(retryJobId);
      }
    } catch (error) {
      showError(error);
    } finally {
      if (normalizedJobId) setJobBusy(normalizedJobId, false);
    }
  };

  const handleDeleteRipperJob = async (jobId) => {
    const normalizedJobId = normalizeJobId(jobId);
    if (!normalizedJobId) {
      return;
    }
    const job = ripperJobs.find((item) => normalizeJobId(item?.id) === normalizedJobId) || null;
    const orphanImportSource = String(
      job?.makemkvInfo?.source
      || job?.makemkvInfo?.importRecovery?.source
      || ''
    ).trim().toLowerCase();
    const isOrphanRawImportJob = orphanImportSource === 'orphan_raw_import';
    const jobKindRaw = String(job?.job_kind || '').trim().toLowerCase();
    const isMultipartChildJob = jobKindRaw === 'multipart_movie_child'
      || jobKindRaw === 'multipart_movie_merge'
      || (Number(job?.is_multipart_movie || 0) === 1 && Boolean(normalizeJobId(job?.parent_job_id)));
    const includeRelatedOnDelete = !isMultipartChildJob;
    const hasAnyOutputPath = Boolean(String(job?.output_path || '').trim());
    const deleteRaw = false;
    let movieSelectionPaths = [];
    let hasCompleteMovieCandidates = false;
    try {
      const deletePreview = await api.getJobDeletePreview(normalizedJobId, { includeRelated: includeRelatedOnDelete });
      const movieCandidates = Array.isArray(deletePreview?.preview?.pathCandidates?.movie)
        ? deletePreview.preview.pathCandidates.movie
        : [];
      const existingMovieSelectionPaths = Array.from(new Set(
        movieCandidates
          .filter((candidate) => Boolean(candidate?.exists))
          .map((candidate) => String(candidate?.path || '').trim())
          .filter(Boolean)
      ));
      movieSelectionPaths = existingMovieSelectionPaths;
      hasCompleteMovieCandidates = existingMovieSelectionPaths.length > 0;
      const incompleteMovieSelectionPaths = Array.from(new Set(
        movieCandidates
          .filter((candidate) => Boolean(candidate?.exists) && isIncompleteOutputPath(candidate?.path))
          .filter((candidate) => {
            if (!isIncompleteMergeOutputPath(candidate?.path)) {
              return true;
            }
            return Boolean(candidate?.isFile);
          })
          .map((candidate) => String(candidate?.path || '').trim())
          .filter(Boolean)
      ));
      if (!hasCompleteMovieCandidates && incompleteMovieSelectionPaths.length > 0) {
        movieSelectionPaths = incompleteMovieSelectionPaths;
      }
    } catch (_error) {
      movieSelectionPaths = [];
    }
    if (movieSelectionPaths.length === 0) {
      movieSelectionPaths = getIncompleteOutputSelectionPaths(job?.output_path);
    }
    if (movieSelectionPaths.length === 0 && hasAnyOutputPath) {
      movieSelectionPaths = [String(job.output_path).trim()].filter(Boolean);
    }
    const deleteMovie = movieSelectionPaths.length > 0;
    const deleteTarget = deleteMovie ? 'movie' : 'none';
    const resetDriveStateOnDelete = !isOrphanRawImportJob;
    const keepDetectedDeviceOnDelete = isOrphanRawImportJob;
    const title = String(job?.title || job?.detected_title || `Job #${normalizedJobId}`).trim();
    let deleteHint = 'Hinweis: Dateien bleiben erhalten. Vollständiges RAW ist anschließend über /database wiederherstellbar.';
    if (isOrphanRawImportJob) {
      deleteHint = 'Hinweis: Dieser /database-Job löscht beim Entfernen aus dem Ripper keine RAW-Dateien.';
    }
    if (deleteMovie) {
      deleteHint = 'Hinweis: Zugehörige Encode-Ausgabe (Dateien/Ordner) wird beim Löschen mit entfernt.';
    }
    const confirmed = await confirmModal({
      header: 'Job löschen',
      message:
      `Job #${normalizedJobId} wirklich löschen?\n` +
      `${title}\n\n` +
      deleteHint +
      (includeRelatedOnDelete
        ? '\nZugehörige Einträge (z.B. Serien-Container oder Folgejobs) werden ebenfalls entfernt.'
        : '\nEs wird nur dieser Job entfernt; andere zugehörige Disks bleiben erhalten.') +
      (isOrphanRawImportJob
        ? '\nOrphan-Import-Job: Das zugeordnete Laufwerk bleibt unverändert.'
        : '\nDas zugeordnete Laufwerk wird freigegeben und auf Leerzustand zurückgesetzt.'),
      acceptLabel: 'Löschen',
      rejectLabel: 'Abbrechen',
      danger: true
    });
    if (!confirmed) {
      return;
    }

    setJobBusy(normalizedJobId, true);
    try {
      const statusBeforeDelete = String(job?.status || '').trim().toUpperCase();
      if (processingStates.includes(statusBeforeDelete)) {
        await api.cancelPipeline(normalizedJobId);
        const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        for (let attempt = 0; attempt < 12; attempt += 1) {
          const latest = await api.getJob(normalizedJobId, { lite: true, forceRefresh: true }).catch(() => null);
          const latestStatus = String(latest?.job?.status || latest?.job?.last_state || '').trim().toUpperCase();
          if (!processingStates.includes(latestStatus)) {
            break;
          }
          await wait(250);
        }
      }
      await api.deleteJobEntry(normalizedJobId, deleteTarget, {
        includeRelated: includeRelatedOnDelete,
        ...(deleteMovie ? { selectedMoviePaths: movieSelectionPaths } : {}),
        resetDriveState: resetDriveStateOnDelete,
        keepDetectedDevice: keepDetectedDeviceOnDelete,
        preserveRawForImportJobs: true
      });
      await refreshPipeline();
      await loadRipperJobs();
      setExpandedJobId((prev) => (normalizeJobId(prev) === normalizedJobId ? null : prev));
      toastRef.current?.show({
        severity: 'success',
        summary: 'Job gelöscht',
        detail: `Job #${normalizedJobId} wurde entfernt.`,
        life: 3200
      });
    } catch (error) {
      showError(error);
    } finally {
      setJobBusy(normalizedJobId, false);
    }
  };

  const handleRestartEncodeWithLastSettings = async (jobId, restartOptions = {}) => {
    const job = ripperJobs.find((item) => normalizeJobId(item?.id) === normalizeJobId(jobId)) || null;
    const title = job?.title || job?.detected_title || `Job #${jobId}`;
    const restartMode = String(restartOptions?.restartMode || 'all').trim().toLowerCase() === 'from_abort'
      ? 'from_abort'
      : 'all';
    if (job?.encodeSuccess) {
      const confirmed = await confirmModal({
        header: 'Encode neu starten',
        message:
        `Encode für "${title}" ist bereits erfolgreich abgeschlossen. Wirklich erneut encodieren?\n` +
        'Es wird eine neue Datei mit Kollisionsprüfung angelegt.',
        acceptLabel: 'Neu encodieren',
        rejectLabel: 'Abbrechen'
      });
      if (!confirmed) {
        return;
      }
    }

    const normalizedJobId = normalizeJobId(jobId);
    if (normalizedJobId) setJobBusy(normalizedJobId, true);
    try {
      const response = await api.restartEncodeWithLastSettings(jobId, { restartMode });
      const result = getQueueActionResult(response);
      const replacementJobId = normalizeJobId(result?.jobId) || normalizedJobId;
      await refreshPipeline();
      await loadRipperJobs();
      if (result.queued) {
        showQueuedToast(toastRef, 'Encode-Neustart', result);
      } else {
        setExpandedJobId(replacementJobId);
      }
    } catch (error) {
      showError(error);
    } finally {
      if (normalizedJobId) setJobBusy(normalizedJobId, false);
    }
  };

  const handleRestartReviewFromRaw = async (jobId) => {
    const normalizedJobId = normalizeJobId(jobId);
    if (!normalizedJobId) {
      return;
    }

    setJobBusy(normalizedJobId, true);
    try {
      const response = await api.restartReviewFromRaw(normalizedJobId, { reuseCurrentJob: true });
      const result = getQueueActionResult(response);
      const replacementJobId = normalizeJobId(result?.jobId) || normalizedJobId;
      await refreshPipeline();
      await loadRipperJobs();
      setExpandedJobId(replacementJobId);
    } catch (error) {
      showError(error);
    } finally {
      setJobBusy(normalizedJobId, false);
    }
  };

  const handleRestartCdReviewFromRaw = async (jobId) => {
    const normalizedJobId = normalizeJobId(jobId);
    if (!normalizedJobId) {
      return;
    }

    setJobBusy(normalizedJobId, true);
    try {
      const response = await api.restartCdReviewFromRaw(normalizedJobId);
      const result = getQueueActionResult(response);
      const replacementJobId = normalizeJobId(result?.jobId) || normalizedJobId;
      await refreshPipeline();
      await loadRipperJobs();
      if (result.queued) {
        showQueuedToast(toastRef, 'CD-Vorprüfung', result);
      } else {
        setExpandedJobId(replacementJobId);
      }
    } catch (error) {
      showError(error);
    } finally {
      setJobBusy(normalizedJobId, false);
    }
  };

  const handleQueueDragEnter = (targetEntryId) => {
    const targetId = Number(targetEntryId);
    const draggedId = Number(draggingQueueEntryId);
    if (!targetId || !draggedId || targetId === draggedId || queueReorderBusy) {
      return;
    }
    setQueueState((prev) => {
      const queuedJobs = reorderQueuedItems(prev?.queuedJobs || [], draggedId, targetId);
      return {
        ...normalizeQueue(prev),
        queuedJobs,
        queuedCount: queuedJobs.length
      };
    });
  };

  const handleQueueDrop = async () => {
    const draggedId = Number(draggingQueueEntryId);
    setDraggingQueueEntryId(null);
    if (!draggedId || queueReorderBusy) {
      return;
    }

    const orderedEntryIds = (Array.isArray(queueState?.queuedJobs) ? queueState.queuedJobs : [])
      .map((item) => Number(item?.entryId))
      .filter(Boolean);
    if (orderedEntryIds.length <= 1) {
      return;
    }

    setQueueReorderBusy(true);
    try {
      const response = await api.reorderPipelineQueue(orderedEntryIds);
      setQueueState(normalizeQueue(response?.queue));
    } catch (error) {
      showError(error);
      try {
        const latest = await api.getPipelineQueue();
        setQueueState(normalizeQueue(latest?.queue));
      } catch (_reloadError) {
        // ignore reload failures after reorder error
      }
    } finally {
      setQueueReorderBusy(false);
    }
  };

  const handleRemoveQueuedJob = async (jobId) => {
    const normalizedJobId = normalizeJobId(jobId);
    if (!normalizedJobId || queueReorderBusy) {
      return;
    }

    setQueueReorderBusy(true);
    setJobBusy(normalizedJobId, true);
    try {
      await api.cancelPipeline(normalizedJobId);
      const latest = await api.getPipelineQueue();
      setQueueState(normalizeQueue(latest?.queue));
    } catch (error) {
      showError(error);
    } finally {
      setQueueReorderBusy(false);
      setJobBusy(normalizedJobId, false);
    }
  };

  const handleRemoveQueueEntry = async (entryId) => {
    if (!entryId || queueReorderBusy) {
      return;
    }
    setQueueReorderBusy(true);
    try {
      const response = await api.removeQueueEntry(entryId);
      setQueueState(normalizeQueue(response?.queue));
    } catch (error) {
      showError(error);
    } finally {
      setQueueReorderBusy(false);
    }
  };

  const openInsertQueueDialog = async (afterEntryId) => {
    const hasJob = (queueState?.runningJobs || []).some((i) => i.jobId != null)
      || (queueState?.queuedJobs || []).some((i) => i.jobId != null);
    if (!hasJob) {
      return;
    }
    setInsertQueueDialog({ visible: true, afterEntryId: afterEntryId ?? null });
    try {
      const [scriptsRes, chainsRes] = await Promise.allSettled([api.getScripts(), api.getScriptChains()]);
      setQueueCatalog({
        scripts: scriptsRes.status === 'fulfilled' ? (Array.isArray(scriptsRes.value?.scripts) ? scriptsRes.value.scripts : []) : [],
        chains: chainsRes.status === 'fulfilled' ? (Array.isArray(chainsRes.value?.chains) ? chainsRes.value.chains : []) : []
      });
    } catch (_) { /* ignore */ }
  };

  const handleAddQueueEntry = async (type, params) => {
    const afterEntryId = insertQueueDialog.afterEntryId;
    setInsertQueueDialog({ visible: false, afterEntryId: null });
    try {
      const response = await api.addQueueEntry({ type, ...params, insertAfterEntryId: afterEntryId });
      setQueueState(normalizeQueue(response?.queue));
    } catch (error) {
      showError(error);
    }
  };

  const syncQueueFromServer = async () => {
    try {
      const latest = await api.getPipelineQueue();
      setQueueState(normalizeQueue(latest?.queue));
    } catch (_error) {
      // ignore sync failures
    }
  };

  const handleMetadataSearch = async (query, options = {}) => {
    const filterRaw = String(options?.resultFilter || '').trim().toLowerCase();
    const includeMovies = filterRaw !== 'series';
    const includeSeries = filterRaw !== 'movies' && filterRaw !== 'movie';
    const [movieResponse, seriesResponse] = await Promise.all([
      includeMovies ? api.searchTmdbMovie(query) : Promise.resolve({ results: [] }),
      includeSeries ? api.searchTmdbSeries(query) : Promise.resolve({ results: [] })
    ]);
    const movieRows = Array.isArray(movieResponse?.results)
      ? movieResponse.results.map((row) => ({
        ...row,
        workflowKind: 'film',
        metadataKind: 'movie',
        resultType: 'movie'
      }))
      : [];
    const seriesRows = Array.isArray(seriesResponse?.results)
      ? seriesResponse.results.map((row) => ({
        ...row,
        workflowKind: 'series',
        metadataKind: String(row?.metadataKind || '').trim().toLowerCase() || 'series',
        resultType: 'series'
      }))
      : [];
    return [...movieRows, ...seriesRows];
  };

  const doSelectMetadata = async (payload, options = {}) => {
    const suppressErrorToast = Boolean(options?.suppressErrorToast);
    const submittedJobId = normalizeJobId(payload?.jobId);
    setBusy(true);
    try {
      let metadataResponse = null;
      if (metadataDialogReassignMode) {
        const duplicateAction = String(payload?.duplicateAction || '').trim().toLowerCase();
        const providerRaw = String(payload?.metadataProvider || '').trim().toLowerCase();
        const nextWorkflowKind = String(
          payload?.workflowKind
          || ''
        ).trim().toLowerCase();
        const reassignJob = ripperJobs.find((item) => normalizeJobId(item?.id) === normalizeJobId(payload?.jobId)) || null;
        const reassignMediaProfile = String(
          reassignJob?.media_type
          || reassignJob?.mediaType
          || effectiveMetadataDialogContext?.mediaProfile
          || ''
        ).trim().toLowerCase();
        const currentWorkflowKind = String(
          reassignJob?.makemkvInfo?.analyzeContext?.selectedMetadata?.workflowKind
          || reassignJob?.makemkvInfo?.analyzeContext?.workflowKind
          || reassignJob?.makemkvInfo?.selectedMetadata?.workflowKind
          || effectiveMetadataDialogContext?.selectedMetadata?.workflowKind
          || ''
        ).trim().toLowerCase();
        const currentProvider = String(
          reassignJob?.makemkvInfo?.analyzeContext?.metadataProvider
          || reassignJob?.makemkvInfo?.selectedMetadata?.metadataProvider
          || effectiveMetadataDialogContext?.metadataProvider
          || ''
        ).trim().toLowerCase();
        const shouldRestartReview = Boolean(
          nextWorkflowKind
          && currentWorkflowKind
          && nextWorkflowKind !== currentWorkflowKind
        ) || Boolean(
          currentProvider
          && providerRaw
          && currentProvider !== providerRaw
        );
        const forceFilmMetadataPath = ['dvd', 'bluray'].includes(reassignMediaProfile) && nextWorkflowKind === 'film';
        if (duplicateAction || shouldRestartReview || forceFilmMetadataPath) {
          metadataResponse = await api.selectMetadata(payload);
        } else {
          metadataResponse = await api.assignJobMetadata(payload.jobId, payload);
        }
      } else {
        metadataResponse = await api.selectMetadata(payload);
      }
      await refreshPipeline();
      await loadRipperJobs();
      const responseJobId = normalizeJobId(
        metadataResponse?.job?.id
        || metadataResponse?.result?.jobId
        || metadataResponse?.jobId
      );
      const expandedTargetJobId = responseJobId || submittedJobId;
      if (expandedTargetJobId) {
        setExpandedJobId(expandedTargetJobId);
      }
      setMetadataDialogVisible(false);
      setMetadataDialogContext(null);
      setMetadataDialogReassignMode(false);
    } catch (error) {
      if (suppressErrorToast) {
        throw error;
      }
      showError(error);
    } finally {
      setBusy(false);
    }
  };

  const handleMetadataSubmit = async (payload) => {
    await doSelectMetadata(payload, { suppressErrorToast: true });
  };

  const handleMusicBrainzSearch = async (query, options = {}) => {
    try {
      const response = await api.searchMusicBrainz(query, {
        trackCount: Number(options?.trackCount || 0) > 0 ? Math.trunc(Number(options.trackCount)) : null
      });
      return response.results || [];
    } catch (error) {
      showError(error);
      return [];
    }
  };

  const handleMusicBrainzReleaseFetch = async (mbId) => {
    try {
      const response = await api.getMusicBrainzRelease(mbId);
      return response?.release || null;
    } catch (error) {
      showError(error);
      return null;
    }
  };

  const handleCdMetadataSubmit = async (payload) => {
    setBusy(true);
    try {
      const response = await api.selectCdMetadata(payload);
      const expandedTargetJobId = normalizeJobId(response?.id) || normalizeJobId(payload?.jobId);
      let startRipError = null;
      if (expandedTargetJobId) {
        try {
          const startResponse = await api.startCdRip(expandedTargetJobId, { skipEncode: true });
          const result = getQueueActionResult(startResponse);
          if (result.queued) {
            showQueuedToast(toastRef, 'Audio CD', result);
          }
        } catch (error) {
          startRipError = error;
        }
      }
      await refreshPipeline();
      await loadRipperJobs();
      setCdMetadataDialogVisible(false);
      setCdMetadataDialogContext(null);
      if (expandedTargetJobId) {
        setExpandedJobId(expandedTargetJobId);
      }
      if (startRipError) {
        showError(startRipError);
      }
    } catch (error) {
      showError(error);
    } finally {
      setBusy(false);
    }
  };

  const handleCdRipStart = async (jobId, ripConfig) => {
    if (!jobId) {
      return;
    }
    const normalizedJobId = normalizeJobId(jobId);
    if (normalizedJobId) {
      setJobBusy(normalizedJobId, true);
    }
    try {
      const activePipelineForJob = normalizedJobId
        ? (pipelineByJobId.get(normalizedJobId) || null)
        : null;
      const shouldForceTwoStep = Boolean(
        activePipelineForJob?.context?.mediaProfile === 'cd'
        && activePipelineForJob?.context?.skipRip !== true
      );
      const effectiveRipConfig = shouldForceTwoStep
        ? {
            ...(ripConfig && typeof ripConfig === 'object' ? ripConfig : {}),
            skipEncode: true
          }
        : ripConfig;
      const response = await api.startCdRip(jobId, effectiveRipConfig);
      const result = getQueueActionResult(response);
      if (result.queued) {
        showQueuedToast(toastRef, 'Audio CD', result);
      }
      const replacementJobId = normalizeJobId(result?.jobId) || normalizedJobId;
      await refreshPipeline();
      await loadRipperJobs();
      if (replacementJobId) {
        setExpandedJobId(replacementJobId);
      }
    } catch (error) {
      showError(error);
    } finally {
      if (normalizedJobId) {
        setJobBusy(normalizedJobId, false);
      }
    }
  };

  // CD drives are tracked per-drive in pipeline.cdDrives — exclude them from the single-drive display
  const lastNonCdDiscEvent = lastDiscEvent?.mediaProfile !== 'cd' ? lastDiscEvent : null;
  const contextDevice = pipeline?.context?.device;
  const device = lastNonCdDiscEvent || (contextDevice?.mediaProfile !== 'cd' ? contextDevice : null);
  const driveLocksByPath = useMemo(() => {
    const map = new Map();
    const locks = Array.isArray(pipeline?.driveLocks) ? pipeline.driveLocks : [];
    for (const lock of locks) {
      const path = normalizeDrivePath(lock?.path);
      const count = Number(lock?.count || 0);
      if (!path || !Number.isFinite(count) || count <= 0) {
        continue;
      }
      const owners = Array.isArray(lock?.owners) ? lock.owners : [];
      const owner = owners.length > 0 ? owners[owners.length - 1] : null;
      map.set(path, {
        path,
        count,
        owner,
        owners
      });
    }
    return map;
  }, [pipeline?.driveLocks]);

  // Unified list of all known drives: merge lsblk drives + CD state + non-CD pipeline state
  const allDrives = useMemo(() => {
    const driveMap = new Map();
    for (const d of knownDrives) {
      driveMap.set(d.path, { path: d.path, model: d.model, discArg: d.discArg });
    }
    for (const [drivePath, drive] of Object.entries(pipeline?.cdDrives || {})) {
      const base = driveMap.get(drivePath) || { path: drivePath };
      driveMap.set(drivePath, { ...base, cdDrive: drive });
    }
    if (device?.path) {
      const base = driveMap.get(device.path) || { path: device.path, model: device.model };
      // When device comes from a recent DISC_DETECTED event, use 'DISC_DETECTED' as the
      // effective state for that drive even if the global pipeline state is ENCODING etc.
      const effectivePipelineState = lastNonCdDiscEvent ? 'DISC_DETECTED' : state;
      driveMap.set(device.path, { ...base, pipelineDevice: device, pipelineState: effectivePipelineState });
    }
    // For drives that the detection service found but aren't tracked by cdDrives or the global
    // state machine (e.g. a second non-CD disc), show DISC_DETECTED using detectedDiscs.
    for (const [drivePath, discDevice] of Object.entries(pipeline?.detectedDiscs || {})) {
      const existing = driveMap.get(drivePath);
      if (existing && !existing.cdDrive && !existing.pipelineDevice) {
        driveMap.set(drivePath, { ...existing, detectedDisc: discDevice });
      }
    }
    return Array.from(driveMap.values())
      .filter((drv) => !String(drv.path || '').startsWith('__virtual__'))
      .sort((a, b) => (a.path || '').localeCompare(b.path || ''));
  }, [knownDrives, pipeline?.cdDrives, pipeline?.detectedDiscs, device, state, lastNonCdDiscEvent]);
  const canRescan = !busy;
  const canOpenMetadataModal = Boolean(defaultMetadataDialogContext?.jobId);
  const queueRunningJobsRaw = Array.isArray(queueState?.runningJobs) ? queueState.runningJobs : [];
  const queueIdleJobsRaw = Array.isArray(queueState?.idleJobs) ? queueState.idleJobs : [];
  const queuedJobsRaw = Array.isArray(queueState?.queuedJobs) ? queueState.queuedJobs : [];
  const queueChainNameById = useMemo(() => {
    const map = new Map();
    const chains = Array.isArray(queueCatalog?.chains) ? queueCatalog.chains : [];
    for (const chain of chains) {
      const chainId = Number(chain?.id);
      const chainName = String(chain?.name || '').trim();
      if (!Number.isFinite(chainId) || chainId <= 0 || !chainName) {
        continue;
      }
      map.set(Math.trunc(chainId), chainName);
    }
    return map;
  }, [queueCatalog?.chains]);
  const isVisibleQueueItem = (_item) => true;
  const queueRunningJobs = queueRunningJobsRaw.filter((item) => isVisibleQueueItem(item));
  const queueRunningJobsDisplay = queueRunningJobs;
  const queueIdleJobs = queueIdleJobsRaw.filter((item) => isVisibleQueueItem(item));
  const queuedJobs = queuedJobsRaw.filter((item) => isVisibleQueueItem(item));
  const visibleRunningAudioCdCount = queueRunningJobs.filter(
    (item) => String(item?.poolType || '').trim().toLowerCase() === 'audio'
  ).length;
  const visibleRunningFilmCount = Math.max(0, queueRunningJobs.length - visibleRunningAudioCdCount);
  const visibleQueuedCount = queuedJobs.length;
  const visibleIdleCount = queueIdleJobs.length;
  const canReorderQueue = queuedJobs.length > 1 && !queueReorderBusy;
  const queueHasJobEntry = queueRunningJobs.some((i) => i.jobId != null)
    || queuedJobs.some((i) => i.jobId != null);
  const buildRunningQueueScriptKey = (jobId) => `running-${normalizeJobId(jobId) || '-'}`;
  const buildIdleQueueScriptKey = (jobId) => `idle-${normalizeJobId(jobId) || '-'}`;
  const buildQueuedQueueScriptKey = (entryId) => `queued-${Number(entryId) || '-'}`;
  const toggleQueueScriptDetails = (key) => {
    if (!key) {
      return;
    }
    setExpandedQueueScriptKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };
  useEffect(() => {
    const validKeys = new Set();
    for (const item of queueRunningJobs) {
      if (!hasQueueScriptSummary(item)) {
        continue;
      }
      validKeys.add(buildRunningQueueScriptKey(item?.jobId));
    }
    for (const item of queueIdleJobs) {
      if (!hasQueueScriptSummary(item)) {
        continue;
      }
      validKeys.add(buildIdleQueueScriptKey(item?.jobId));
    }
    for (const item of queuedJobs) {
      if (String(item?.type || 'job') !== 'job' || !hasQueueScriptSummary(item)) {
        continue;
      }
      validKeys.add(buildQueuedQueueScriptKey(item?.entryId));
    }
    setExpandedQueueScriptKeys((prev) => {
      let changed = false;
      const next = new Set();
      for (const key of prev) {
        if (validKeys.has(key)) {
          next.add(key);
        } else {
          changed = true;
        }
      }
      return changed ? next : prev;
      });
  }, [queueRunningJobs, queueIdleJobs, queuedJobs]);
  const queuedJobIdSet = useMemo(() => {
    const set = new Set();
    for (const item of queuedJobs) {
      const id = normalizeJobId(item?.jobId);
      if (id) {
        set.add(id);
      }
    }
    return set;
  }, [queuedJobs]);

  const setRuntimeActionBusy = (activityId, action, busyFlag) => {
    const key = `${Number(activityId) || 0}:${String(action || '')}`;
    setRuntimeActionBusyKeys((prev) => {
      const next = new Set(prev);
      if (busyFlag) {
        next.add(key);
      } else {
        next.delete(key);
      }
      return next;
    });
  };

  const isRuntimeActionBusy = (activityId, action) => runtimeActionBusyKeys.has(
    `${Number(activityId) || 0}:${String(action || '')}`
  );

  const handleRuntimeControl = async (item, action) => {
    const activityId = Number(item?.id);
    if (!Number.isFinite(activityId) || activityId <= 0) {
      return;
    }
    const normalizedAction = String(action || '').trim().toLowerCase();
    const actionLabel = normalizedAction === 'next-step' ? 'Nächster Schritt' : 'Abbrechen';
    setRuntimeActionBusy(activityId, normalizedAction, true);
    try {
      const response = normalizedAction === 'next-step'
        ? await api.requestRuntimeNextStep(activityId)
        : await api.cancelRuntimeActivity(activityId, { reason: 'Benutzerabbruch via Ripper' });
      if (response?.snapshot) {
        setRuntimeActivities(normalizeRuntimeActivitiesPayload(response.snapshot));
      } else {
        const fresh = await api.getRuntimeActivities();
        setRuntimeActivities(normalizeRuntimeActivitiesPayload(fresh));
      }
      const accepted = response?.action?.accepted !== false;
      const actionMessage = String(response?.action?.message || '').trim();
      toastRef.current?.show({
        severity: accepted ? 'info' : 'warn',
        summary: actionLabel,
        detail: actionMessage || (accepted ? 'Aktion ausgelöst.' : 'Aktion aktuell nicht möglich.'),
        life: 2600
      });
    } catch (error) {
      toastRef.current?.show({
        severity: 'error',
        summary: actionLabel,
        detail: error?.message || 'Aktion fehlgeschlagen.',
        life: 3200
      });
    } finally {
      setRuntimeActionBusy(activityId, normalizedAction, false);
    }
  };

  const handleClearRuntimeRecent = async () => {
    if (runtimeRecentClearing || runtimeRecentItems.length === 0) {
      return;
    }
    setRuntimeRecentClearing(true);
    try {
      const response = await api.clearRuntimeRecentActivities();
      if (response?.snapshot) {
        setRuntimeActivities(normalizeRuntimeActivitiesPayload(response.snapshot));
      } else {
        const fresh = await api.getRuntimeActivities();
        setRuntimeActivities(normalizeRuntimeActivitiesPayload(fresh));
      }
      toastRef.current?.show({
        severity: 'success',
        summary: 'Abgeschlossene Liste',
        detail: `Einträge entfernt: ${Number(response?.removed || 0)}`,
        life: 2200
      });
    } catch (error) {
      toastRef.current?.show({
        severity: 'error',
        summary: 'Liste leeren',
        detail: error?.message || 'Leeren fehlgeschlagen.',
        life: 3200
      });
    } finally {
      setRuntimeRecentClearing(false);
    }
  };

  const quickAccessItems = useMemo(() => {
    const scripts = Array.isArray(quickAccessCatalog?.scripts) ? quickAccessCatalog.scripts : [];
    const chains = Array.isArray(quickAccessCatalog?.chains) ? quickAccessCatalog.chains : [];
    const items = [];

    for (const script of scripts) {
      const scriptId = Number(script?.id);
      if (!Number.isFinite(scriptId) || scriptId <= 0 || script?.isFavorite !== true) {
        continue;
      }
      items.push({
        type: 'script',
        id: Math.trunc(scriptId),
        name: String(script?.name || '').trim() || `Skript #${scriptId}`
      });
    }

    for (const chain of chains) {
      const chainId = Number(chain?.id);
      if (!Number.isFinite(chainId) || chainId <= 0 || chain?.isFavorite !== true) {
        continue;
      }
      items.push({
        type: 'chain',
        id: Math.trunc(chainId),
        name: String(chain?.name || '').trim() || `Kette #${chainId}`
      });
    }

    return items.sort((left, right) => {
      if (left.id !== right.id) {
        return left.id - right.id;
      }
      if (left.type === right.type) {
        return 0;
      }
      return left.type === 'script' ? -1 : 1;
    });
  }, [quickAccessCatalog]);

  const handleRunQuickAccessItem = async (item) => {
    const type = String(item?.type || '').trim().toLowerCase();
    const id = Number(item?.id);
    if (!Number.isFinite(id) || id <= 0 || (type !== 'script' && type !== 'chain')) {
      return;
    }
    const normalizedId = Math.trunc(id);
    const entryKey = `${type}:${normalizedId}`;
    if (quickAccessRunningKeys.has(entryKey)) {
      return;
    }
    setQuickAccessBusy(entryKey, true);
    try {
      if (type === 'script') {
        const response = await api.testScript(normalizedId);
        const result = response?.result || null;
        toastRef.current?.show({
          severity: result?.success ? 'success' : 'warn',
          summary: 'Favoriten',
          detail: result?.success
            ? `Skript "${item?.name || normalizedId}" gestartet.`
            : `Skript "${item?.name || normalizedId}" mit Fehler beendet (exit=${result?.exitCode ?? 'n/a'}).`,
          life: 3000
        });
      } else {
        const response = await api.testScriptChain(normalizedId);
        const result = response?.result || null;
        toastRef.current?.show({
          severity: result?.aborted ? 'warn' : 'success',
          summary: 'Favoriten',
          detail: result?.aborted
            ? `Kette "${item?.name || normalizedId}" mit Abbruch beendet.`
            : `Kette "${item?.name || normalizedId}" gestartet.`,
          life: 3200
        });
      }
      const activities = await api.getRuntimeActivities();
      setRuntimeActivities(normalizeRuntimeActivitiesPayload(activities));
    } catch (error) {
      showError(error);
    } finally {
      setQuickAccessBusy(entryKey, false);
    }
  };

  const runtimeActiveItems = Array.isArray(runtimeActivities?.active) ? runtimeActivities.active : [];
  const quickAccessRunningKeys = useMemo(() => {
    const keys = new Set();
    for (const activity of runtimeActiveItems) {
      const type = String(activity?.type || '').trim().toLowerCase();
      if (type === 'script') {
        const scriptId = Number(activity?.scriptId);
        if (Number.isFinite(scriptId) && scriptId > 0) {
          keys.add(`script:${Math.trunc(scriptId)}`);
        }
      } else if (type === 'chain') {
        const chainId = Number(activity?.chainId);
        if (Number.isFinite(chainId) && chainId > 0) {
          keys.add(`chain:${Math.trunc(chainId)}`);
        }
      }
    }
    return keys;
  }, [runtimeActiveItems]);
  const runtimeRecentItems = Array.isArray(runtimeActivities?.recent)
    ? runtimeActivities.recent.slice(0, 8)
    : [];

  // Group chain activities with their current child script — hide child scripts from top level
  const activeChainChildIds = new Set(
    runtimeActiveItems.filter((i) => i.parentActivityId != null).map((i) => i.id)
  );
  const activeItemsDisplay = runtimeActiveItems.filter((i) => !activeChainChildIds.has(i.id));
  const findActiveChainChild = (chainId) => runtimeActiveItems.find((i) => i.parentActivityId === chainId) || null;

  const recentChainChildIds = new Set(
    runtimeRecentItems.filter((i) => i.parentActivityId != null).map((i) => i.id)
  );
  const recentItemsDisplay = runtimeRecentItems.filter((i) => !recentChainChildIds.has(i.id));

  return (
    <div className="page-grid">
      <Toast ref={toastRef} />

      <div className="ripper-3col-grid">
        <div className="ripper-col ripper-col-left">
          <Card title="Disk-Information">
        {/* Per-drive list */}
        {allDrives.length > 0 ? (
          <div className="drive-list">
            {allDrives.map((drv) => {
              const drivePath = drv.path;
              const cdDrive = drv.cdDrive;
              const pipelineDevice = drv.pipelineDevice;
              const isRescanBusy = driveRescanBusy.has(drivePath);
              const isAnalyzeBusy = driveAnalyzeBusy.has(drivePath);

              // Determine display state
              let stateLabel = null;
              let stateSeverity = 'secondary';
              let discInfo = null;

              if (cdDrive) {
                const s = String(cdDrive.state || '').toUpperCase();
                stateLabel = s;
                stateSeverity = s === 'FINISHED' ? 'success'
                  : s === 'ERROR' || s === 'CANCELLED' ? 'danger'
                  : ['CD_RIPPING', 'CD_ENCODING'].includes(s) ? 'warning'
                  : 'info';
                const cd = cdDrive.device || {};
                discInfo = cd.discLabel || cd.model || null;
              } else if (pipelineDevice) {
                const s = String(drv.pipelineState || '').toUpperCase();
                stateLabel = s || 'DISC_DETECTED';
                stateSeverity = s === 'FINISHED' ? 'success'
                  : s === 'ERROR' ? 'danger'
                  : processingStates.includes(s) ? 'warning'
                  : 'info';
                discInfo = pipelineDevice.discLabel || pipelineDevice.label || null;
              } else if (drv.detectedDisc) {
                stateLabel = 'DISC_DETECTED';
                stateSeverity = 'info';
                discInfo = drv.detectedDisc.discLabel || drv.detectedDisc.label || null;
              } else {
                stateLabel = 'LEER';
                stateSeverity = 'secondary';
              }

              const driveJobId = normalizeJobId(cdDrive?.jobId);
              const driveCtx = cdDrive?.context && typeof cdDrive.context === 'object' ? cdDrive.context : {};
              const cdState = cdDrive ? String(cdDrive.state || '').toUpperCase() : null;
              const pipelineState = String(drv.pipelineState || '').toUpperCase();
              const driveLockEntry = driveLocksByPath.get(normalizeDrivePath(drivePath)) || null;
              const isCdDriveLocked = cdState ? activeCdDriveStates.includes(cdState) : false;
              const isDriveLocked = Boolean(driveLockEntry) || isCdDriveLocked;
              const lockedByJobId = normalizeJobId(driveLockEntry?.owner?.jobId);
              const lockStage = String(driveLockEntry?.owner?.stage || '').trim().toUpperCase();
              const lockTitle = lockedByJobId
                ? `Laufwerk ist gesperrt (Job #${lockedByJobId}${lockStage ? `, ${lockStage}` : ''}).`
                : 'Laufwerk ist gesperrt, bis Rip/Encode abgeschlossen ist.';
              const canAnalyzeDrive = cdState
                ? cdState === 'DISC_DETECTED'
                : (Boolean(pipelineDevice) && pipelineState === 'DISC_DETECTED') || Boolean(drv.detectedDisc);
              const stateIconMeta = driveStateIconMeta(stateLabel);
              const discArg = String(drv.discArg || '').trim();

              return (
                <div key={drivePath} className="drive-list-item">
                  <div className="drive-list-row">
                    <div className="drive-list-info">
                      <code className="drive-list-path">{drivePath}</code>
                      {drv.model && <span className="drive-list-model">{drv.model}</span>}
                    </div>
                    <div className="drive-list-state">
                      {stateLabel ? (
                        <span
                          className={`drive-list-status-icon tone-${stateSeverity}`}
                          title={getStatusLabel(stateLabel)}
                          aria-label={`Status: ${getStatusLabel(stateLabel)}`}
                        >
                          <i className={`pi ${stateIconMeta.icon}${stateIconMeta.spin ? ' pi-spin' : ''}`} aria-hidden="true" />
                        </span>
                      ) : null}
                    </div>
                    <div className="drive-list-actions">
                      {isDriveLocked ? (
                        <Button
                          icon="pi pi-lock"
                          text
                          rounded
                          size="small"
                          severity="secondary"
                          className="drive-list-action-btn"
                          disabled
                          title={lockTitle}
                          aria-label="Laufwerk gesperrt"
                        />
                      ) : (
                        <>
                          <Button
                            icon="pi pi-refresh"
                            text
                            rounded
                            size="small"
                            severity="secondary"
                            className="drive-list-action-btn"
                            loading={isRescanBusy}
                            disabled={isRescanBusy}
                            onClick={() => handleRescanDrive(drivePath)}
                            title="Laufwerk neu lesen"
                            aria-label="Laufwerk neu lesen"
                          />
                          {canAnalyzeDrive && (
                            <Button
                              icon="pi pi-search"
                              text
                              rounded
                              size="small"
                              severity="secondary"
                              className="drive-list-action-btn"
                              loading={isAnalyzeBusy}
                              disabled={isAnalyzeBusy}
                              onClick={() => handleAnalyzeForDrive(drivePath)}
                              title="Disk analysieren"
                              aria-label="Disk analysieren"
                            />
                          )}
                        </>
                      )}
                      {cdState === 'CD_METADATA_SELECTION' && (
                        <Button
                          icon="pi pi-list"
                          text
                          rounded
                          size="small"
                          severity="info"
                          className="drive-list-action-btn"
                          onClick={() => {
                            setMetadataDialogVisible(false);
                            setMetadataDialogContext(null);
                            setMetadataDialogReassignMode(false);
                            setCdMetadataDialogContext({ ...driveCtx, jobId: driveJobId });
                            setCdMetadataDialogVisible(true);
                          }}
                          disabled={!driveJobId}
                          title="Metadaten auswählen"
                          aria-label="Metadaten auswählen"
                        />
                      )}
                      {(cdState === 'ERROR' || cdState === 'CANCELLED') && driveJobId && (
                        <Button
                          icon="pi pi-replay"
                          text
                          rounded
                          size="small"
                          severity="warning"
                          className="drive-list-action-btn"
                          onClick={() => handleAnalyzeForDrive(drivePath)}
                          loading={isAnalyzeBusy}
                          disabled={isAnalyzeBusy}
                          title="Erneut analysieren"
                          aria-label="Erneut analysieren"
                        />
                      )}
                    </div>
                  </div>
                  {(discArg || discInfo) ? (
                    <div className="drive-list-disc-meta">
                      {discArg ? <span className="drive-list-disc-arg">{discArg}</span> : null}
                      {discInfo ? <span className="drive-list-disc-label" title={discInfo}>{discInfo}</span> : null}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        ) : (
          <p className="drive-list-empty">Keine Laufwerke erkannt.</p>
        )}

        {/* Global action buttons — below drive list, side by side */}
        <div className="drive-list-global-actions">
          <Button
            label="Alle neu lesen"
            icon="pi pi-refresh"
            severity="secondary"
            size="small"
            onClick={handleRescan}
            loading={busy}
            disabled={!canRescan}
          />
          <Button
            label="Alle analysieren"
            icon="pi pi-search"
            severity="warning"
            size="small"
            onClick={handleAnalyzeAll}
            disabled={allDrives.every((drv) => {
              const cs = drv.cdDrive ? String(drv.cdDrive.state || '').toUpperCase() : null;
              if (cs) return cs !== 'DISC_DETECTED';
              if (Boolean(drv.pipelineDevice) && String(drv.pipelineState || '').toUpperCase() === 'DISC_DETECTED') return false;
              return !drv.detectedDisc;
            })}
          />
        </div>
      </Card>

      {quickAccessItems.length > 0 ? (
        <Card title="Favoriten">
          <div className="quick-access-list">
            {quickAccessItems.map((item) => {
              const entryKey = `${item.type}:${item.id}`;
              const isBusy = quickAccessBusyKeys.has(entryKey);
              const isRunning = quickAccessRunningKeys.has(entryKey);
              return (
                <div key={entryKey} className="quick-access-item">
                  <div className="quick-access-item-main">
                    <strong className="quick-access-item-title">
                      <i
                        className={`pi ${item.type === 'script' ? 'pi-code' : 'pi-link'} quick-access-item-title-icon`}
                        aria-hidden="true"
                      />
                      <span>{item.name}</span>
                    </strong>
                  </div>
                  <Button
                    icon="pi pi-play"
                    text
                    rounded
                    size="small"
                    severity="success"
                    className="quick-access-run-btn"
                    loading={isBusy || isRunning}
                    disabled={isBusy || isRunning}
                    onClick={() => handleRunQuickAccessItem(item)}
                    title="Starten"
                    aria-label={`${item.type === 'script' ? 'Skript' : 'Kette'} starten`}
                  />
                </div>
              );
            })}
          </div>
        </Card>
      ) : null}

      <Card title="Hardware">
        <div className="hardware-panel-section">
          <h4>Freier Speicher</h4>
          <div className="hardware-storage-list">
            {storageGroups.length === 0 ? (
              <small>Keine Speicherinformationen verfuegbar.</small>
            ) : storageGroups.map((group) => {
              const rep = group.representative;
              const tone = getStorageUsageTone(rep?.usagePercent);
              const usagePercent = Number(rep?.usagePercent);
              const barValue = Number.isFinite(usagePercent)
                ? Math.max(0, Math.min(100, usagePercent))
                : 0;
              const hasError = group.entries.every((e) => e?.error);
              const groupKey = group.mountPoint || group.entries.map((e) => e?.key).join('-');
              const labels = group.entries.map((e) => e?.label || e?.key || 'Pfad').join(' · ');
              return (
                <div
                  key={`storage-group-${groupKey}`}
                  className={`hardware-storage-item compact${hasError ? ' has-error' : ''}`}
                >
                  <small className="hardware-storage-group-label">{labels}</small>
                  {hasError ? (
                    <small className="error-text">{rep?.error}</small>
                  ) : (
                    <>
                      <div className="hardware-storage-bar-row">
                        <div className={`hardware-storage-bar tone-${tone}`}>
                          <ProgressBar value={barValue} showValue={false} />
                        </div>
                        <span className={`hardware-storage-percent tone-${tone}`}>
                          {formatPercent(rep?.usagePercent)}
                        </span>
                      </div>
                      <div className="hardware-storage-summary">
                        <small>Frei: {formatBytes(rep?.freeBytes)}</small>
                        <small>Gesamt: {formatBytes(rep?.totalBytes)}</small>
                      </div>
                    </>
                  )}
                </div>
              );
            })}
          </div>
        </div>
        {monitoringState.enabled ? (
          <>
            <div className="hardware-panel-divider" />
            <div className="hardware-panel-section">
              <div className="hardware-panel-section-head">
                <h4>Hardware-Monitor</h4>
                <Button
                  type="button"
                  icon="pi pi-link"
                  text
                  rounded
                  size="small"
                  className="hardware-panel-link-btn"
                  title="Zur Hardware-Seite"
                  aria-label="Zur Hardware-Seite"
                  onClick={() => navigate('/hardware')}
                />
              </div>
              {!monitoringSample ? (
                <small>Warte auf erste Messung ...</small>
              ) : (
                <div className="hardware-mini-monitor-list">
                  <div className="hardware-mini-monitor-item">
                    <strong>CPU</strong>
                    <small className="hardware-mini-monitor-line">
                      <span className="hardware-mini-monitor-metric" title="Gesamtauslastung">
                        <i className="pi pi-chart-line" />
                        <span>{formatPercent(cpuMetrics?.overallUsagePercent)}</span>
                      </span>
                      <span className="hardware-mini-monitor-sep">|</span>
                      <span className="hardware-mini-monitor-metric" title="Temperatur">
                        <i className="pi pi-bolt" />
                        <span>{formatTemperature(cpuMetrics?.overallTemperatureC)}</span>
                      </span>
                    </small>
                  </div>
                  <div className="hardware-mini-monitor-item">
                    <strong>RAM</strong>
                    <small className="hardware-mini-monitor-line">
                      <span className="hardware-mini-monitor-metric" title="Gesamtauslastung">
                        <i className="pi pi-chart-line" />
                        <span>{formatPercent(memoryMetrics?.usagePercent)}</span>
                      </span>
                      <span className="hardware-mini-monitor-sep">|</span>
                      <span className="hardware-mini-monitor-metric" title="Nutzung">
                        <i className="pi pi-database" />
                        <span>{formatUsageCompact(memoryMetrics?.usedBytes, memoryMetrics?.totalBytes)}</span>
                      </span>
                    </small>
                  </div>
                  <div className="hardware-mini-monitor-item">
                    <strong>GPU</strong>
                    <small className="hardware-mini-monitor-line">
                      <span className="hardware-mini-monitor-metric" title="Gesamtauslastung">
                        <i className="pi pi-chart-line" />
                        <span>{formatPercent(gpuSummaryUsage)}</span>
                      </span>
                      <span className="hardware-mini-monitor-sep">|</span>
                      <span className="hardware-mini-monitor-metric" title="Temperatur">
                        <i className="pi pi-bolt" />
                        <span>{formatTemperature(gpuSummaryTemp)}</span>
                      </span>
                      <span className="hardware-mini-monitor-sep">|</span>
                      <span className="hardware-mini-monitor-metric" title="VRAM Nutzung">
                        <i className="pi pi-database" />
                        <span>{formatUsageCompact(primaryGpuMetrics?.memoryUsedBytes, primaryGpuMetrics?.memoryTotalBytes)}</span>
                      </span>
                    </small>
                  </div>
                </div>
              )}
            </div>
          </>
        ) : null}
      </Card>
        </div>

        <div className="ripper-col ripper-col-center">
          {isSubpageRoute ? (
            <div className="ripper-subpage-content">
              {children}
            </div>
          ) : (
            <Card title="Job Übersicht" subTitle="Kompakte Liste; Klick auf Zeile öffnet die volle Job-Detailansicht mit passenden CTAs">
        {jobsLoading && ripperJobs.length === 0 ? (
          <p>Jobs werden geladen ...</p>
        ) : ripperJobs.length === 0 ? (
          <p>Keine relevanten Jobs im Ripper (aktive/fortsetzbare Status).</p>
        ) : (
          <div className="ripper-job-list">
            {ripperJobs.map((job) => {
              const jobId = normalizeJobId(job?.id);
              if (!jobId) {
                return null;
              }
              const pipelineForJob = pipelineByJobId.get(jobId) || buildPipelineFromJob(job, pipeline, currentPipelineJobId);
              const effectiveStatus = String(pipelineForJob?.state || job?.status || '').trim().toUpperCase();
              const normalizedStatus = normalizeStatus(effectiveStatus);
              const isQueued = queuedJobIdSet.has(jobId);
              const statusBadgeValue = getMergeAwareStatusLabel(job, effectiveStatus, { queued: isQueued });
              const statusBadgeSeverity = getStatusSeverity(normalizedStatus, { queued: isQueued });
              const isExpanded = normalizeJobId(expandedJobId) === jobId;
              const isCurrentSession = jobId === currentPipelineJobId && state !== 'IDLE';
              const reviewConfirmed = Boolean(Number(job?.encode_review_confirmed || 0));
              const jobTitle = job?.title || job?.detected_title || `Job #${jobId}`;
              const mediaIndicator = mediaIndicatorMeta(job);
              const isResumable = (
                normalizedStatus === 'READY_TO_ENCODE'
                || (mediaIndicator.mediaType === 'audiobook' && normalizedStatus === 'READY_TO_START')
              ) && !isCurrentSession;
              const analyzeContext = getAnalyzeContext(job);
              const selectedMetadata = pipelineForJob?.context?.selectedMetadata && typeof pipelineForJob.context.selectedMetadata === 'object'
                ? pipelineForJob.context.selectedMetadata
                : (analyzeContext?.selectedMetadata && typeof analyzeContext.selectedMetadata === 'object'
                  ? analyzeContext.selectedMetadata
                  : (job?.makemkvInfo?.selectedMetadata && typeof job.makemkvInfo.selectedMetadata === 'object'
                    ? job.makemkvInfo.selectedMetadata
                    : {}));
              const seriesSeasonNumber = mediaIndicator.isSeriesDvd
                ? (selectedMetadata?.seasonNumber ?? analyzeContext?.seriesLookupHint?.seasonNumber ?? null)
                : null;
              const seriesTmdbId = mediaIndicator.isSeriesDvd
                ? (selectedMetadata?.tmdbId ?? analyzeContext?.tmdbId ?? null)
                : null;
              const seriesDiscNumber = mediaIndicator.isSeriesDvd
                ? (selectedMetadata?.discNumber ?? analyzeContext?.seriesLookupHint?.discNumber ?? null)
                : null;
              const isSeriesContainer = mediaIndicator.isSeriesDvd
                && String(job?.job_kind || '').trim().toLowerCase() === 'dvd_series_container';
              const parentContainerId = normalizeJobId(job?.parent_job_id);
              const seriesTmdbText = String(seriesTmdbId ?? '').trim();
              const seriesSeasonLabel = mediaIndicator.isSeriesDvd && seriesSeasonNumber
                ? ` Staffel ${seriesSeasonNumber}`
                : '';
              const seriesDiscLabel = mediaIndicator.isSeriesDvd && seriesDiscNumber
                ? ` | Disk ${seriesDiscNumber}`
                : '';
              const seriesContainerLabel = isSeriesContainer
                ? ' | Container'
                : (parentContainerId ? ` | Container #${parentContainerId}` : '');
              const seriesTmdbLabel = mediaIndicator.isSeriesDvd && seriesTmdbText && seriesTmdbText !== '0'
                ? ` | TMDb ${seriesTmdbId}`
                : '';
              const seriesTitleSuffix = mediaIndicator.isSeriesDvd
                ? `${seriesSeasonLabel}${seriesDiscLabel}${seriesContainerLabel}`
                : '';
              const discWorkflowKind = resolveDiscWorkflowKind({
                mediaType: mediaIndicator.mediaType,
                selectedMetadata,
                analyzeContext,
                pipelineContext: pipelineForJob?.context || null,
                fallbackIsSeries: Boolean(mediaIndicator.isSeriesVideo)
              });
              const discWorkflowBadgeLabel = getDiscWorkflowBadgeLabel(mediaIndicator.mediaType, discWorkflowKind);
              const jobKindRaw = String(job?.job_kind || '').trim().toLowerCase();
              const isMultipartMovie = Number(job?.is_multipart_movie || 0) === 1
                || jobKindRaw === 'multipart_movie_child'
                || jobKindRaw === 'multipart_movie_container'
                || jobKindRaw === 'multipart_movie_merge';
              const isMultipartMerge = isMultipartMergeJob(job);
              const multipartDiscNumber = Number(job?.disc_number || selectedMetadata?.discNumber || 0) || null;
              const multipartContainerId = normalizeJobId(job?.parent_job_id);
              const multipartSubtitle = isMultipartMovie
                ? (
                  `${isMultipartMerge ? ' Merge' : `${multipartDiscNumber ? ` Disc ${multipartDiscNumber}` : ''}`}`
                  + `${multipartContainerId ? ` | Container #${multipartContainerId}` : ''}`
                ).trim()
                : '';
              const mediaProfile = String(pipelineForJob?.context?.mediaProfile || '').trim().toLowerCase();
              const jobState = effectiveStatus;
              const pipelineStage = String(pipelineForJob?.context?.stage || '').trim().toUpperCase();
              const pipelineStatusTextRaw = String(pipelineForJob?.statusText || '').trim();
              const pipelineStatusText = pipelineStatusTextRaw.toUpperCase();
              const isCdJob = jobState.startsWith('CD_')
                || pipelineStage.startsWith('CD_')
                || mediaProfile === 'cd'
                || mediaIndicator.mediaType === 'cd'
                || pipelineStatusText.includes('CD_');
              const isAudiobookJob = mediaProfile === 'audiobook'
                || mediaIndicator.mediaType === 'audiobook'
                || String(pipelineForJob?.context?.mode || '').trim().toLowerCase() === 'audiobook';
              const seriesBatchContext = pipelineForJob?.context?.seriesBatch && typeof pipelineForJob.context.seriesBatch === 'object'
                ? pipelineForJob.context.seriesBatch
                : null;
              const seriesBatchChildren = Array.isArray(seriesBatchContext?.children) ? seriesBatchContext.children : [];
              const seriesEpisodeJobIds = mediaIndicator.isSeriesDvd
                ? resolveSeriesEpisodeJobIds(job, seriesBatchChildren)
                : [];
              const seriesEpisodeJobsLabel = mediaIndicator.isSeriesDvd && seriesEpisodeJobIds.length > 0
                ? ` | Episoden #${seriesEpisodeJobIds.join(', #')}`
                : '';
              const seriesCollapsedSubtitle = mediaIndicator.isSeriesDvd
                ? `#${jobId}${seriesTitleSuffix}${seriesEpisodeJobsLabel}`
                : '';
              const hasSeriesBatchProgress = seriesBatchChildren.length > 0 || Number(seriesBatchContext?.totalCount || 0) > 0;
              const seriesBatchTotalCountRaw = Number(seriesBatchContext?.totalCount || 0);
              const seriesBatchTotalCount = Number.isFinite(seriesBatchTotalCountRaw) && seriesBatchTotalCountRaw > 0
                ? Math.trunc(seriesBatchTotalCountRaw)
                : seriesBatchChildren.length;
              const seriesBatchAggregateProgress = hasSeriesBatchProgress && seriesBatchTotalCount > 0
                ? (
                  seriesBatchChildren.reduce((sum, child) => {
                    const status = String(child?.status || '').trim().toUpperCase();
                    if (status === 'FINISHED') {
                      return sum + 100;
                    }
                    const childProgress = Number(child?.progress || 0);
                    return sum + (Number.isFinite(childProgress) ? Math.max(0, Math.min(100, childProgress)) : 0);
                  }, 0) / seriesBatchTotalCount
                )
                : 0;
              const runningSeriesChild = hasSeriesBatchProgress
                ? (
                  seriesBatchChildren.find((child) => String(child?.status || '').trim().toUpperCase() === 'RUNNING')
                  || null
                )
                : null;
              const isCancelledState = normalizedStatus === 'CANCELLED' || jobState === 'CANCELLED';
              const rawProgress = isCancelledState
                ? 0
                : (hasSeriesBatchProgress
                ? seriesBatchAggregateProgress
                : Number(pipelineForJob?.progress ?? 0));
              const clampedProgress = Number.isFinite(rawProgress)
                ? Math.max(0, Math.min(100, rawProgress))
                : 0;
              const progressLabel = `${Math.trunc(clampedProgress)}%`;
              const showMediainfoIndeterminateProgress = !hasSeriesBatchProgress
                && isMediainfoCheckStatus(normalizedStatus);
              const showIndeterminateProgress = showMediainfoIndeterminateProgress || (
                !hasSeriesBatchProgress
                && isPlaylistTrackPreparationStatus(pipelineStatusTextRaw)
              );
              const indeterminateProgressLabel = showMediainfoIndeterminateProgress
                ? 'Mediainfo-Prüfung läuft …'
                : 'Vorbereitung läuft …';
              const etaLabel = isCancelledState ? '' : String(
                hasSeriesBatchProgress
                  ? (runningSeriesChild?.eta || pipelineForJob?.eta || '')
                  : (pipelineForJob?.eta || '')
              ).trim();

              const audiobookMeta = pipelineForJob?.context?.selectedMetadata && typeof pipelineForJob.context.selectedMetadata === 'object'
                ? pipelineForJob.context.selectedMetadata
                : {};
              const audiobookChapterCount = Array.isArray(audiobookMeta?.chapters) ? audiobookMeta.chapters.length : 0;
              const cdMeta = isCdJob && pipelineForJob?.context?.selectedMetadata && typeof pipelineForJob.context.selectedMetadata === 'object'
                ? pipelineForJob.context.selectedMetadata
                : {};
              const cdAlbumTitle = isCdJob
                ? (String(cdMeta?.title || job?.title || job?.detected_title || `Job #${jobId}`).trim() || `Job #${jobId}`)
                : '';
              const cdArtist = isCdJob ? (String(cdMeta?.artist || '').trim() || null) : null;
              const cdYearValue = isCdJob
                ? (cdMeta?.year ?? job?.year ?? null)
                : null;
              const cdYear = isCdJob
                ? (String(cdYearValue ?? '').trim() || null)
                : null;
              const cdSubtitle = isCdJob
                ? [cdArtist, cdYear].filter(Boolean).join(' | ')
                : '';
              const cdMetaLine = isCdJob
                ? `#${jobId}${cdSubtitle ? ` | ${cdSubtitle}` : ''}`
                : '';
              const multipartMergeSources = isMultipartMerge ? extractMultipartMergeSources(job) : [];
              const hasMultipartMergeSources = multipartMergeSources.length > 0;
              const multipartMergePreview = isMultipartMerge
                ? (multipartMergePreviewByJobId[jobId] || null)
                : null;
              const multipartMergePreviewLoading = Boolean(
                isMultipartMerge && multipartMergePreviewLoadingByJobId[jobId]
              );
              const multipartMergeLiveLog = String(multipartMergeLiveLogByJobId[jobId] || '').trim();
              const multipartMergeLiveLogLoading = Boolean(
                isMultipartMerge && multipartMergeLiveLogLoadingByJobId[jobId]
              );
              const isMultipartMergeRunning = isMultipartMerge && normalizedStatus === 'ENCODING';
              const deleteInputsAfterMerge = isMultipartMerge
                ? shouldDeleteMultipartMergeInputsAfterSuccess(job)
                : false;
              const canEditMultipartMergeSettings = !busyJobIds.has(jobId)
                && !processingStates.includes(normalizedStatus)
                && !isQueued;
              const multipartMergeCommandPreview = String(multipartMergePreview?.command?.preview || '').trim();
              const multipartMergeChapterEntries = Array.isArray(multipartMergePreview?.chapters?.entries)
                ? multipartMergePreview.chapters.entries
                : [];
              const multipartMergeAudioTracks = Array.isArray(multipartMergePreview?.media?.audioTracks)
                ? multipartMergePreview.media.audioTracks
                : [];
              const multipartMergeSubtitleTracks = Array.isArray(multipartMergePreview?.media?.subtitleTracks)
                ? multipartMergePreview.media.subtitleTracks
                : [];
              const multipartMergeMediaAligned = Boolean(multipartMergePreview?.media?.allSourcesAligned);
              const multipartMergeMediaMismatchCount = Array.isArray(multipartMergePreview?.media?.mismatches)
                ? multipartMergePreview.media.mismatches.length
                : 0;
              if (isExpanded) {
                return (
                  <div key={jobId} className="ripper-job-expanded">
                    <div className="ripper-job-expanded-head">
                      {(job?.poster_url && job.poster_url !== 'N/A') ? (
                        <img src={job.poster_url} alt={jobTitle} className="poster-thumb" />
                      ) : (
                        <div className="poster-thumb ripper-job-poster-fallback">{isAudiobookJob ? 'Kein Cover' : 'Kein Poster'}</div>
                      )}
                      <div className="ripper-job-expanded-title">
                        <strong className="ripper-job-title-line">
                          <img
                            src={mediaIndicator.src}
                            alt={mediaIndicator.alt}
                            title={mediaIndicator.title}
                            className="media-indicator-icon"
                          />
                          <span>{isCdJob ? cdAlbumTitle : `#${jobId} | ${jobTitle}`}</span>
                        </strong>
                        {isCdJob ? (
                          <small className="ripper-job-subtitle">{cdMetaLine || '-'}</small>
                        ) : null}
                        {mediaIndicator.isSeriesDvd ? (
                          <small className="ripper-job-subtitle">{seriesTitleSuffix || '-'}</small>
                        ) : null}
                        {!mediaIndicator.isSeriesDvd && isMultipartMovie ? (
                          <small className="ripper-job-subtitle">{multipartSubtitle || 'Multipart Movie'}</small>
                        ) : null}
                        <div className="ripper-job-badges">
                          <Tag value={statusBadgeValue} severity={statusBadgeSeverity} />
                          {discWorkflowBadgeLabel ? <Tag value={discWorkflowBadgeLabel} severity="secondary" /> : null}
                          {isMultipartMerge ? <Tag value="Merge Job" severity="warning" /> : null}
                          {!isMultipartMerge && isMultipartMovie ? <Tag value="Multipart Movie" severity="secondary" /> : null}
                          {isCurrentSession ? <Tag value="Aktive Session" severity="info" /> : null}
                          {isResumable ? <Tag value="Fortsetzbar" severity="success" /> : null}
                          {normalizedStatus === 'READY_TO_ENCODE'
                            ? <Tag value={reviewConfirmed ? 'Review bestätigt' : 'Review offen'} severity={reviewConfirmed ? 'success' : 'warning'} />
                            : null}
                        </div>
                      </div>
                      <Button
                        label="Einklappen"
                        icon="pi pi-angle-up"
                        severity="secondary"
                        outlined
                        onClick={() => setExpandedJobId(null)}
                      />
                    </div>
                    {(() => {
                      if (isCdJob) {
                        return (
                          <>
                            {isCdJob ? (
                              <CdRipConfigPanel
                                pipeline={pipelineForJob}
                                onStart={(ripConfig) => handleCdRipStart(jobId, ripConfig)}
                                onCancel={() => handleCancel(jobId, jobState)}
                                onRetry={() => handleRetry(jobId)}
                                onRestartReview={() => handleRestartCdReviewFromRaw(jobId)}
                                onDeleteJob={() => handleDeleteRipperJob(jobId)}
                                onOpenMetadata={() => {
                                  const ctx = pipelineForJob?.context && typeof pipelineForJob.context === 'object'
                                    ? pipelineForJob.context
                                    : pipeline?.context || {};
                                  void openCdMetadataDialogWithContext({ ...ctx, jobId }, jobId);
                                }}
                                busy={busyJobIds.has(jobId)}
                              />
                            ) : null}
                          </>
                        );
                      }
                      if (isAudiobookJob) {
                        const needsBytes = pendingActivationJobIds.has(jobId);
                        return (
                          <>
                            {needsBytes && (
                              <div style={{ padding: '0.75rem 1rem', marginBottom: '0.5rem', background: 'var(--yellow-100)', border: '1px solid var(--yellow-400)', borderRadius: '6px', color: 'var(--yellow-900)', fontSize: '0.875rem' }}>
                                <i className="pi pi-lock" style={{ marginRight: '0.5rem' }} />
                                <strong>Activation Bytes fehlen.</strong>{' '}
                                <button type="button" style={{ background: 'none', border: 'none', color: 'var(--primary-color)', cursor: 'pointer', textDecoration: 'underline', padding: 0 }} onClick={() => handleAudiobookStart(jobId, null)}>
                                  Jetzt eintragen
                                </button>
                              </div>
                            )}
                            <AudiobookConfigPanel
                              pipeline={pipelineForJob}
                              onStart={(config) => handleAudiobookStart(jobId, config)}
                              onCancel={() => handleCancel(jobId, jobState)}
                              onRetry={() => handleRetry(jobId)}
                              onDeleteJob={() => handleDeleteRipperJob(jobId)}
                              busy={busyJobIds.has(jobId) || needsBytes}
                            />
                          </>
                        );
                      }
                      return null;
                    })()}
                    {!isCdJob && !isAudiobookJob ? (
                      isMultipartMerge ? (
                        <div className="multipart-merge-panel">
                          {!isMultipartMergeRunning ? (
                            <>
                              <div className="multipart-merge-head">
                                <strong>Merge-Quellen</strong>
                                <small>Drag-and-Drop ändert die Reihenfolge der Disc-Dateien.</small>
                              </div>
                              {hasMultipartMergeSources ? (
                                <div className="multipart-merge-list">
                                  {multipartMergeSources.map((source, sourceIndex) => {
                                    const sourceKey = `${jobId}-${source.sourceJobId}-${sourceIndex}`;
                                    const canReorder = !busyJobIds.has(jobId)
                                      && !processingStates.includes(normalizedStatus)
                                      && multipartMergeSources.length > 1;
                                    return (
                                      <div
                                        key={sourceKey}
                                        className="multipart-merge-item"
                                        draggable={canReorder}
                                        onDragStart={() => {
                                          if (!canReorder) return;
                                          setDraggingMergeSource({ jobId, sourceJobId: source.sourceJobId });
                                        }}
                                        onDragEnd={() => setDraggingMergeSource(null)}
                                        onDragOver={(event) => {
                                          if (!canReorder) return;
                                          if (!draggingMergeSource || draggingMergeSource.jobId !== jobId) return;
                                          event.preventDefault();
                                        }}
                                        onDrop={(event) => {
                                          if (!canReorder) return;
                                          if (!draggingMergeSource || draggingMergeSource.jobId !== jobId) return;
                                          event.preventDefault();
                                          const draggedId = normalizeJobId(draggingMergeSource.sourceJobId);
                                          const targetId = normalizeJobId(source.sourceJobId);
                                          if (!draggedId || !targetId || draggedId === targetId) {
                                            setDraggingMergeSource(null);
                                            return;
                                          }
                                          const currentOrder = multipartMergeSources
                                            .map((item) => normalizeJobId(item.sourceJobId))
                                            .filter(Boolean);
                                          const fromIndex = currentOrder.findIndex((id) => id === draggedId);
                                          const toIndex = currentOrder.findIndex((id) => id === targetId);
                                          if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) {
                                            setDraggingMergeSource(null);
                                            return;
                                          }
                                          const nextOrder = [...currentOrder];
                                          const [moved] = nextOrder.splice(fromIndex, 1);
                                          nextOrder.splice(toIndex, 0, moved);
                                          setDraggingMergeSource(null);
                                          handleReorderMultipartMergeSources(jobId, nextOrder);
                                        }}
                                      >
                                        <div className="multipart-merge-item-meta">
                                          <Tag value={`#${sourceIndex + 1}`} severity="contrast" />
                                          <Tag value={source.discNumber ? `Disc ${source.discNumber}` : 'Disc ?'} severity="info" />
                                          <Tag value={`Job #${source.sourceJobId}`} severity="secondary" />
                                        </div>
                                        <div className="multipart-merge-item-text">
                                          <strong>{source.fileName || source.outputPath}</strong>
                                          <small>{source.outputPath}</small>
                                        </div>
                                      </div>
                                    );
                                  })}
                                </div>
                              ) : (
                                <p className="muted-inline">Noch keine Merge-Quellen gefunden.</p>
                              )}
                            </>
                          ) : null}
                          {isMultipartMergeRunning ? (
                            <>
                              <div className="status-row multipart-merge-running-head">
                                <Tag value="Merging" severity="warning" />
                                <span>{String(pipelineForJob?.statusText || '').trim() || 'Merge läuft'}</span>
                              </div>
                              <div className="progress-wrap multipart-merge-running-progress">
                                <ProgressBar
                                  value={clampedProgress}
                                  showValue
                                  displayValueTemplate={() => progressLabel}
                                />
                                <small>
                                  {etaLabel ? `${progressLabel} | ETA ${etaLabel}` : progressLabel}
                                </small>
                              </div>
                              <div className="live-log-block multipart-merge-live-log">
                                <h4>Aktueller Merge-Log</h4>
                                <pre className="log-box">
                                  {multipartMergeLiveLog
                                    || (multipartMergeLiveLogLoading ? 'Live-Log wird geladen ...' : 'Noch keine Log-Ausgabe vorhanden.')}
                                </pre>
                              </div>
                            </>
                          ) : (
                            <div className="multipart-merge-preview">
                              <div className="multipart-merge-preview-head">
                                <strong>Merge Vorschau</strong>
                                <Button
                                  icon="pi pi-refresh"
                                  text
                                  severity="secondary"
                                  aria-label="Merge-Vorschau aktualisieren"
                                  onClick={() => loadMultipartMergePreview(jobId, { force: true, silent: false })}
                                  disabled={busyJobIds.has(jobId) || multipartMergePreviewLoading}
                                />
                              </div>
                              {multipartMergePreviewLoading ? (
                                <small className="muted-inline">Vorschau wird aktualisiert ...</small>
                              ) : null}
                              <div className="multipart-merge-preview-section">
                                <strong>1. CLI-Befehl</strong>
                                {multipartMergeCommandPreview ? (
                                  <code className="multipart-merge-command-preview">{multipartMergeCommandPreview}</code>
                                ) : (
                                  <small className="muted-inline">Noch keine Vorschau verfügbar.</small>
                                )}
                              </div>
                              <div className="multipart-merge-preview-section">
                                <strong>2. Kapitel (gesamt)</strong>
                                {multipartMergeChapterEntries.length > 0 ? (
                                  <div className="multipart-merge-chapter-list">
                                    {multipartMergeChapterEntries.map((entry) => (
                                      <div key={`merge-chapter-${jobId}-${entry.index}`} className="multipart-merge-chapter-item">
                                        <small>#{entry.index}</small>
                                        <small>{entry.startClock || entry.start || '-'}</small>
                                        <span>{entry.title || '-'}</span>
                                      </div>
                                    ))}
                                  </div>
                                ) : (
                                  <small className="muted-inline">Keine berechnete Kapitel-Gesamtliste verfügbar.</small>
                                )}
                              </div>
                              <div className="multipart-merge-preview-section">
                                <strong>3. Erwartete Medieninfos (nach Merge)</strong>
                                <div className="multipart-merge-track-columns">
                                  <div className="multipart-merge-track-column">
                                    <small className="multipart-merge-track-heading">Audio</small>
                                    {multipartMergeAudioTracks.length > 0 ? (
                                      <div className="multipart-merge-track-list">
                                        {multipartMergeAudioTracks.map((track) => (
                                          <small key={`merge-audio-${jobId}-${track.order || track.streamIndex}`}>
                                            {formatMergeTrackSummary(track, 'Audio')}
                                          </small>
                                        ))}
                                      </div>
                                    ) : (
                                      <small className="muted-inline">Keine Audio-Infos.</small>
                                    )}
                                  </div>
                                  <div className="multipart-merge-track-column">
                                    <small className="multipart-merge-track-heading">Untertitel</small>
                                    {multipartMergeSubtitleTracks.length > 0 ? (
                                      <div className="multipart-merge-track-list">
                                        {multipartMergeSubtitleTracks.map((track) => (
                                          <small key={`merge-sub-${jobId}-${track.order || track.streamIndex}`}>
                                            {formatMergeTrackSummary(track, 'UT')}
                                          </small>
                                        ))}
                                      </div>
                                    ) : (
                                      <small className="muted-inline">Keine Untertitel-Infos.</small>
                                    )}
                                  </div>
                                </div>
                                {multipartMergePreview?.media?.available ? (
                                  <small className={multipartMergeMediaAligned ? 'muted-inline' : 'error-text'}>
                                    {multipartMergeMediaAligned
                                      ? 'Track-Layout über alle Quellen konsistent.'
                                      : `Achtung: Track-Layout unterscheidet sich zwischen Quellen (${multipartMergeMediaMismatchCount} Abweichung(en)).`}
                                  </small>
                                ) : (
                                  <small className="muted-inline">Stream-Vergleich noch nicht verfügbar.</small>
                                )}
                              </div>
                            </div>
                          )}
                          {!isMultipartMergeRunning ? (
                            <div className="multipart-merge-settings">
                              <label className="multipart-merge-setting-toggle">
                                <input
                                  type="checkbox"
                                  checked={deleteInputsAfterMerge}
                                  onChange={(event) => {
                                    void handleUpdateMultipartMergeSettings(jobId, {
                                      deleteInputsAfterMerge: Boolean(event.target?.checked)
                                    });
                                  }}
                                  disabled={!canEditMultipartMergeSettings}
                                />
                                <span>Input-Dateien nach erfolgreichem Merge löschen</span>
                              </label>
                              <small className="muted-inline">
                                Bei Erfolg werden die Quell-Dateien der Discs aus dem Dateisystem entfernt.
                              </small>
                            </div>
                          ) : null}
                          <div className="multipart-merge-actions">
                            {(normalizedStatus === 'READY_TO_START' || normalizedStatus === 'READY_TO_ENCODE') ? (
                              <Button
                                label={isQueued ? 'In Queue' : 'Merge starten'}
                                icon="pi pi-play"
                                onClick={() => handleStartJob(jobId)}
                                disabled={busyJobIds.has(jobId) || isQueued}
                              />
                            ) : null}
                            {processingStates.includes(normalizedStatus) ? (
                              <Button
                                label="Abbrechen"
                                icon="pi pi-stop"
                                severity="warning"
                                outlined
                                onClick={() => handleCancel(jobId, jobState)}
                                disabled={busyJobIds.has(jobId)}
                              />
                            ) : null}
                            {(normalizedStatus === 'ERROR' || normalizedStatus === 'CANCELLED') ? (
                              <Button
                                label="Retry"
                                icon="pi pi-refresh"
                                severity="secondary"
                                outlined
                                onClick={() => handleRetry(jobId)}
                                disabled={busyJobIds.has(jobId)}
                              />
                            ) : null}
                            {!isMultipartMergeRunning ? (
                              <Button
                                label="Job löschen"
                                icon="pi pi-trash"
                                severity="danger"
                                outlined
                                onClick={() => handleDeleteRipperJob(jobId)}
                                disabled={busyJobIds.has(jobId)}
                              />
                            ) : null}
                          </div>
                        </div>
                      ) : (
                        <PipelineStatusCard
                          jobId={jobId}
                          jobRow={job}
                          pipeline={pipelineForJob}
                          onAnalyze={handleAnalyze}
                          onReanalyze={handleReanalyze}
                          onOpenMetadata={handleOpenMetadataDialog}
                          onReassignMetadata={handleOpenReassignMetadataDialog}
                          onStart={handleStartJob}
                          onRestartEncode={handleRestartEncodeWithLastSettings}
                          onRestartReview={handleRestartReviewFromRaw}
                          onConfirmReview={handleConfirmReview}
                          onSelectPlaylist={handleSelectPlaylist}
                          onSelectHandBrakeTitle={handleSelectHandBrakeTitle}
                          onSubmitRawDecision={handleSubmitRawDecision}
                          onCancel={handleCancel}
                          onRetry={handleRetry}
                          onDeleteJob={handleDeleteRipperJob}
                          onRemoveFromQueue={handleRemoveQueuedJob}
                          isQueued={isQueued}
                          busy={busyJobIds.has(jobId)}
                        />
                      )
                    ) : null}
                  </div>
                );
              }

              return (
                <button
                  key={jobId}
                  type="button"
                  className="ripper-job-row"
                  onClick={() => setExpandedJobId(jobId)}
                >
                  {job?.poster_url && job.poster_url !== 'N/A' ? (
                    <img src={job.poster_url} alt={jobTitle} className="poster-thumb" />
                  ) : (
                    <div className="poster-thumb ripper-job-poster-fallback">{isAudiobookJob ? 'Kein Cover' : 'Kein Poster'}</div>
                  )}
                  <div className="ripper-job-row-content">
                    <div className="ripper-job-row-main">
                      <strong className="ripper-job-title-line">
                        <img
                          src={mediaIndicator.src}
                          alt={mediaIndicator.alt}
                          title={mediaIndicator.title}
                          className="media-indicator-icon"
                        />
                        <span>{isCdJob ? cdAlbumTitle : jobTitle}</span>
                      </strong>
                      <small>
                        {isCdJob
                          ? (cdMetaLine || '-')
                          : mediaIndicator.isSeriesDvd
                          ? (seriesCollapsedSubtitle || '-')
                          : (
                            `#${jobId}`
                            + (isAudiobookJob
                              ? (
                                `${audiobookMeta?.author ? ` | ${audiobookMeta.author}` : ''}`
                                + `${audiobookMeta?.narrator ? ` | ${audiobookMeta.narrator}` : ''}`
                                + `${audiobookChapterCount > 0 ? ` | ${audiobookChapterCount} Kapitel` : ''}`
                              )
                              : (
                                `${job?.year ? ` | ${job.year}` : ''}`
                                + (mediaIndicator.isSeriesDvd ? seriesSeasonLabel : '')
                                + (mediaIndicator.isSeriesDvd ? seriesDiscLabel : '')
                                + (mediaIndicator.isSeriesDvd ? seriesContainerLabel : '')
                                + (mediaIndicator.isSeriesDvd ? seriesTmdbLabel : '')
                                + (!mediaIndicator.isSeriesDvd && isMultipartMovie
                                  ? `${isMultipartMerge ? ' | Merge' : ''}${multipartDiscNumber ? ` | Disc ${multipartDiscNumber}` : ''}${multipartContainerId ? ` | Container #${multipartContainerId}` : ''}`
                                  : '')
                                + (mediaIndicator.isSeriesDvd ? '' : `${job?.imdb_id ? ` | ${job.imdb_id}` : ''}`)
                              ))
                          )}
                      </small>
                    </div>
                    <div className="ripper-job-badges">
                      <Tag value={statusBadgeValue} severity={statusBadgeSeverity} />
                      {discWorkflowBadgeLabel ? <Tag value={discWorkflowBadgeLabel} severity="secondary" /> : null}
                      {isMultipartMerge ? <Tag value="Merge Job" severity="warning" /> : null}
                      {!isMultipartMerge && isMultipartMovie ? <Tag value="Multipart Movie" severity="secondary" /> : null}
                      {isCurrentSession ? <Tag value="Aktive Session" severity="info" /> : null}
                      {isResumable ? <Tag value="Fortsetzbar" severity="success" /> : null}
                      {normalizedStatus === 'READY_TO_ENCODE'
                        ? <Tag value={reviewConfirmed ? 'Bestätigt' : 'Unbestätigt'} severity={reviewConfirmed ? 'success' : 'warning'} />
                        : null}
                      <JobStepChecks backupSuccess={Boolean(job?.backupSuccess)} encodeSuccess={Boolean(job?.encodeSuccess)} />
                    </div>
                    <div
                      className="ripper-job-row-progress"
                      aria-label={showIndeterminateProgress ? 'Job Fortschritt läuft' : `Job Fortschritt ${progressLabel}`}
                    >
                      {showIndeterminateProgress ? (
                        <ProgressBar mode="indeterminate" showValue={false} />
                      ) : (
                        <ProgressBar value={clampedProgress} showValue={false} />
                      )}
                      <small>{showIndeterminateProgress ? indeterminateProgressLabel : (etaLabel ? `${progressLabel} | ETA ${etaLabel}` : progressLabel)}</small>
                    </div>
                  </div>
                  <i className="pi pi-angle-down" aria-hidden="true" />
                </button>
              );
            })}
          </div>
        )}
      </Card>
          )}
        </div>

        <div className="ripper-col ripper-col-right">
          <Card title="Job Queue" subTitle="Elemente können per Drag-and-Drop umsortiert werden.">
        <div className="pipeline-queue-meta">
          <Tag value={`Film max.: ${queueState?.maxParallelJobs || 1}`} severity="info" />
          <Tag value={`Audio/CD max.: ${queueState?.maxParallelCdEncodes || 2}`} severity="info" />
          <Tag value={`Gesamt max.: ${queueState?.maxTotalEncodes || 3}`} severity="info" />
          {queueState?.cdBypassesQueue && <Tag value="CD bypass" severity="secondary" title="Audio/CD-Jobs überspringen die Film-Queue-Reihenfolge" />}
          <Tag value={`Film laufend: ${visibleRunningFilmCount}`} severity={visibleRunningFilmCount > 0 ? 'warning' : 'success'} />
          <Tag value={`Audio/CD laufend: ${visibleRunningAudioCdCount}`} severity={visibleRunningAudioCdCount > 0 ? 'warning' : 'success'} />
          <Tag value={`Wartend: ${visibleQueuedCount}`} severity={visibleQueuedCount > 0 ? 'warning' : 'success'} />
          <Tag value={`Idle: ${visibleIdleCount}`} severity={visibleIdleCount > 0 ? 'info' : 'success'} />
        </div>

        <div className="pipeline-queue-grid">
          <div className="pipeline-queue-col queue-col-running">
            <h4>Laufende Jobs</h4>
            {queueRunningJobsDisplay.length === 0 ? (
              <small>Keine laufenden Jobs.</small>
            ) : (
              queueRunningJobsDisplay.map((item) => {
                const runningJobId = normalizeJobId(item?.jobId);
                const runningQueueDisplay = resolveSeriesQueueDisplay(item);
                const runningTitleBase = runningQueueDisplay.title || item?.title || `Job #${item?.jobId || '-'}`;
                const runningStatusLabel = getMergeAwareStatusLabel(item, item.status);
                const runningMetaLine = `#${runningJobId ?? '-'} | ${runningStatusLabel}`;
                const liveQueueProgressRaw = Number(
                  item?.progress
                  ?? pipeline?.jobProgress?.[runningJobId]?.progress
                );
                const hasLiveQueueProgress = Number.isFinite(liveQueueProgressRaw);
                const clampedQueueProgress = hasLiveQueueProgress
                  ? Math.max(0, Math.min(100, liveQueueProgressRaw))
                  : 0;
                const showQueueIndeterminateProgress = isMediainfoCheckStatus(item?.status) || !hasLiveQueueProgress;
                return (
                  <div key={String(item?.entryKey || `running-${item.jobId}`)} className="pipeline-queue-entry-wrap">
                    <div className="pipeline-queue-item running queue-job-item">
                      <div className="pipeline-queue-item-main">
                        <strong>{runningTitleBase}</strong>
                        <small>{runningMetaLine}</small>
                        <div className="queue-running-progress" aria-label={`Fortschritt Job #${runningJobId ?? '-'}`}>
                          {showQueueIndeterminateProgress ? (
                            <ProgressBar mode="indeterminate" showValue={false} />
                          ) : (
                            <ProgressBar value={clampedQueueProgress} showValue={false} />
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </div>
          <div className="pipeline-queue-col queue-col-idle">
            <h4>Idle</h4>
            {queueIdleJobs.length === 0 ? (
              <small>Keine Idle-Jobs.</small>
            ) : (
              queueIdleJobs.map((item) => {
                const hasScriptSummary = hasQueueScriptSummary(item);
                const detailKey = buildIdleQueueScriptKey(item?.jobId);
                const detailsExpanded = hasScriptSummary && expandedQueueScriptKeys.has(detailKey);
                const idleQueueDisplay = resolveSeriesQueueDisplay(item);
                const idleTitleBase = idleQueueDisplay.title || `Job #${item?.jobId || '-'}`;
                return (
                  <div key={`idle-${item.jobId}`} className="pipeline-queue-entry-wrap">
                    <div className="pipeline-queue-item idle queue-job-item">
                      <div className="pipeline-queue-item-main">
                        <strong>
                          {`${idleTitleBase} | #${item.jobId || '-'}`}
                          {item.hasScripts ? <i className="pi pi-code queue-job-tag" title="Skripte hinterlegt" /> : null}
                          {item.hasChains ? <i className="pi pi-link queue-job-tag" title="Skriptketten hinterlegt" /> : null}
                        </strong>
                        {idleQueueDisplay.subtitle ? <small>{idleQueueDisplay.subtitle}</small> : null}
                        <small>{getMergeAwareStatusLabel(item, item.status)}</small>
                      </div>
                      {hasScriptSummary ? (
                        <button
                          type="button"
                          className="queue-job-expand-btn"
                          aria-label={detailsExpanded ? 'Skriptdetails ausblenden' : 'Skriptdetails einblenden'}
                          aria-expanded={detailsExpanded}
                          onClick={() => toggleQueueScriptDetails(detailKey)}
                        >
                          <i className={`pi ${detailsExpanded ? 'pi-angle-up' : 'pi-angle-down'}`} />
                        </button>
                      ) : null}
                    </div>
                    {detailsExpanded ? <QueueJobScriptSummary item={item} /> : null}
                  </div>
                );
              })
            )}
          </div>
          <div className="pipeline-queue-col queue-col-queued">
            <div className="pipeline-queue-col-header">
              <h4>Warteschlange</h4>
              <button
                type="button"
                className="queue-add-entry-btn"
                title={queueHasJobEntry ? 'Skript, Kette oder Wartezeit zur Queue hinzufügen' : 'Nur möglich wenn mind. ein Job in der Queue ist'}
                disabled={!queueHasJobEntry}
                onClick={() => void openInsertQueueDialog(null)}
              >
                <i className="pi pi-plus" /> Hinzufügen
              </button>
            </div>
            {queuedJobs.length === 0 ? (
              <small className="queue-empty-hint">Queue ist leer.</small>
            ) : (
              <>
                {queuedJobs.map((item) => {
                  const entryId = Number(item?.entryId);
                  const isNonJob = item.type && item.type !== 'job';
                  const isScriptOrChainNonJob = isNonJob && (item.type === 'script' || item.type === 'chain');
                  const isDragging = Number(draggingQueueEntryId) === entryId;
                  const hasScriptSummary = !isNonJob && hasQueueScriptSummary(item);
                  const queuedQueueDisplay = !isNonJob ? resolveSeriesQueueDisplay(item) : null;
                  const detailKey = buildQueuedQueueScriptKey(entryId);
                  const detailsExpanded = hasScriptSummary && expandedQueueScriptKeys.has(detailKey);
                  const chainSubtitle = item.type === 'chain'
                    ? resolveChainQueueSubtitle(item, queueChainNameById)
                    : null;
                  const scriptOrChainTitle = item.type === 'chain'
                    ? (chainSubtitle || `Kette #${item.chainId || '-'}`)
                    : (item.title || `Skript #${item.scriptId || '-'}`);
                  return (
                    <div key={`queued-entry-${entryId}`} className="pipeline-queue-entry-wrap">
                      <div
                        className={`pipeline-queue-item queued${isDragging ? ' dragging' : ''}${isNonJob ? ' non-job' : ''}`}
                        draggable={canReorderQueue}
                        onDragStart={() => setDraggingQueueEntryId(entryId)}
                        onDragEnter={() => handleQueueDragEnter(entryId)}
                        onDragOver={(event) => event.preventDefault()}
                        onDrop={(event) => {
                          event.preventDefault();
                          void handleQueueDrop();
                        }}
                        onDragEnd={() => {
                          setDraggingQueueEntryId(null);
                          void syncQueueFromServer();
                        }}
                      >
                        <span className={`pipeline-queue-drag-handle${canReorderQueue ? '' : ' disabled'}`} title="Reihenfolge ändern">
                          <i className="pi pi-bars" />
                        </span>
                        {!isScriptOrChainNonJob ? (
                          <i className={`pipeline-queue-type-icon ${queueEntryIcon(item.type)}`} title={item.type || 'job'} />
                        ) : null}
                        <div className="pipeline-queue-item-main">
                          {isNonJob ? (
                            isScriptOrChainNonJob ? (
                              <small className="queue-nonjob-subtitle">
                                <i className={queueEntryIcon(item.type)} aria-hidden="true" />
                                <span>{scriptOrChainTitle}</span>
                              </small>
                            ) : (
                              <strong>{item.position || '-'}. {queueEntryLabel(item)}</strong>
                            )
                          ) : (
                            <>
                              <strong>
                                {`${queuedQueueDisplay?.title || item.title || `Job #${item.jobId}`} | #${item.jobId || '-'}`}
                                {item.hasScripts ? <i className="pi pi-code queue-job-tag" title="Skripte hinterlegt" /> : null}
                                {item.hasChains ? <i className="pi pi-link queue-job-tag" title="Skriptketten hinterlegt" /> : null}
                              </strong>
                              {queuedQueueDisplay?.subtitle ? <small>{queuedQueueDisplay.subtitle}</small> : null}
                              <small>{queuedQueueDisplay?.isSeriesEpisode ? `${item.position || '-'} | ${item.actionLabel || item.action || '-'} | ${getMergeAwareStatusLabel(item, item.status)}` : `${item.position || '-'} | #${item.jobId} | ${item.actionLabel || item.action || '-'} | ${getMergeAwareStatusLabel(item, item.status)}`}</small>
                            </>
                          )}
                        </div>
                        <div className="pipeline-queue-item-actions">
                          {hasScriptSummary ? (
                            <button
                              type="button"
                              className="queue-job-expand-btn"
                              aria-label={detailsExpanded ? 'Skriptdetails ausblenden' : 'Skriptdetails einblenden'}
                              aria-expanded={detailsExpanded}
                              onClick={(event) => {
                                event.preventDefault();
                                event.stopPropagation();
                                toggleQueueScriptDetails(detailKey);
                              }}
                            >
                              <i className={`pi ${detailsExpanded ? 'pi-angle-up' : 'pi-angle-down'}`} />
                            </button>
                          ) : null}
                          <Button
                            icon="pi pi-times"
                            severity="danger"
                            text
                            rounded
                            size="small"
                            className="pipeline-queue-remove-btn"
                            disabled={queueReorderBusy}
                            onClick={(event) => {
                              event.preventDefault();
                              event.stopPropagation();
                              if (isNonJob) {
                                void handleRemoveQueueEntry(entryId);
                              } else {
                                void handleRemoveQueuedJob(item.jobId);
                              }
                            }}
                          />
                        </div>
                      </div>
                      {detailsExpanded ? <QueueJobScriptSummary item={item} /> : null}
                      {queueHasJobEntry ? (
                        <button
                          type="button"
                          className="queue-insert-btn"
                          title="Eintrag danach einfügen"
                          onClick={() => void openInsertQueueDialog(entryId)}
                        >
                          <i className="pi pi-plus" />
                        </button>
                      ) : null}
                    </div>
                  );
                })}
              </>
            )}
          </div>
        </div>
      </Card>

          <Card title="Automatisierung">
        <div className="runtime-activity-meta pipeline-queue-meta">
          <Tag value={`Laufend: ${runtimeActiveItems.length}`} severity={runtimeActiveItems.length > 0 ? 'warning' : 'success'} />
          <Tag value={`Zuletzt: ${runtimeRecentItems.length}`} severity="info" />
          <Tag value={`Update: ${formatUpdatedAt(runtimeActivities?.updatedAt)}`} severity="secondary" />
          <Button
            type="button"
            icon="pi pi-trash"
            label="Liste leeren"
            severity="secondary"
            outlined
            size="small"
            onClick={() => {
              void handleClearRuntimeRecent();
            }}
            disabled={runtimeRecentItems.length === 0}
            loading={runtimeRecentClearing}
          />
        </div>

        {runtimeLoading && runtimeActiveItems.length === 0 && runtimeRecentItems.length === 0 ? (
          <p>Aktivitäten werden geladen ...</p>
        ) : (
          <div className="runtime-activity-grid pipeline-queue-grid">
            <div className="runtime-activity-col pipeline-queue-col">
              <h4>Aktiv</h4>
              {runtimeActiveItems.length === 0 ? (
                <small className="queue-empty-hint">Keine laufenden Skript-/Ketten-/Cron-Ausführungen.</small>
              ) : (
                <div className="runtime-activity-list">
                  {activeItemsDisplay.map((item, index) => {
                    const isChain = String(item?.type || '').trim().toLowerCase() === 'chain';
                    const chainChild = isChain ? findActiveChainChild(item?.id) : null;
                    const outputItem = chainChild || item;
                    const statusMeta = runtimeStatusMeta(item?.status);
                    const canCancel = Boolean(item?.canCancel);
                    const canNextStep = isChain && Boolean(item?.canNextStep);
                    const cancelBusy = isRuntimeActionBusy(item?.id, 'cancel');
                    const nextStepBusy = isRuntimeActionBusy(item?.id, 'next-step');
                    const stepLabel = item?.stepIndex != null && item?.stepTotal != null
                      ? `Schritt ${item.stepIndex}/${item.stepTotal}`
                      : item?.currentStep
                        ? 'Schritt'
                        : null;
                    return (
                      <div key={`runtime-active-${item?.id || index}`} className="runtime-activity-item running">
                        <div className="runtime-activity-head">
                          <strong>{item?.name || '-'}</strong>
                          <div className="runtime-activity-tags">
                            <Tag value={runtimeTypeLabel(item?.type)} severity="info" />
                            <Tag value={statusMeta.label} severity={statusMeta.severity} />
                          </div>
                        </div>
                        <small>
                          Quelle: {item?.source || '-'}
                          {item?.jobId ? ` | Job #${item.jobId}` : ''}
                          {item?.cronJobId ? ` | Cron #${item.cronJobId}` : ''}
                        </small>
                        {isChain && (chainChild || item?.currentStep || item?.currentScriptName) ? (
                          <div className="runtime-chain-current">
                            <small>
                              {stepLabel ? <strong>{stepLabel}: </strong> : null}
                              {chainChild?.name || item?.currentScriptName || item?.currentStep || null}
                            </small>
                            {chainChild?.message ? <small>{chainChild.message}</small> : null}
                          </div>
                        ) : null}
                        {!isChain && item?.currentStep ? <small>Schritt: {item.currentStep}</small> : null}
                        {!isChain && item?.message ? <small>{item.message}</small> : null}
                        <RuntimeActivityDetails
                          item={outputItem}
                          summary="Live-Ausgabe anzeigen"
                        />
                        <small>Gestartet: {formatUpdatedAt(item?.startedAt)}</small>
                        {canCancel || canNextStep ? (
                          <div className="runtime-activity-actions">
                            {canNextStep ? (
                              <Button
                                type="button"
                                icon="pi pi-step-forward"
                                label="Nächster Schritt"
                                outlined
                                severity="secondary"
                                size="small"
                                loading={nextStepBusy}
                                disabled={cancelBusy}
                                onClick={() => {
                                  void handleRuntimeControl(item, 'next-step');
                                }}
                              />
                            ) : null}
                            {canCancel ? (
                              <Button
                                type="button"
                                icon="pi pi-stop"
                                label="Abbrechen"
                                outlined
                                severity="danger"
                                size="small"
                                loading={cancelBusy}
                                disabled={nextStepBusy}
                                onClick={() => {
                                  void handleRuntimeControl(item, 'cancel');
                                }}
                              />
                            ) : null}
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            <div className="runtime-activity-col pipeline-queue-col">
              <h4>Zuletzt abgeschlossen</h4>
              {runtimeRecentItems.length === 0 ? (
                <small className="queue-empty-hint">Keine abgeschlossenen Einträge vorhanden.</small>
              ) : (
                <div className="runtime-activity-list">
                  {recentItemsDisplay.map((item, index) => {
                    const outcomeMeta = runtimeOutcomeMeta(item?.outcome, item?.status);
                    return (
                      <div key={`runtime-recent-${item?.id || index}`} className="runtime-activity-item done">
                        <div className="runtime-activity-head">
                          <strong>{item?.name || '-'}</strong>
                          <div className="runtime-activity-tags">
                            <Tag value={runtimeTypeLabel(item?.type)} severity="info" />
                            <Tag value={outcomeMeta.label} severity={outcomeMeta.severity} />
                          </div>
                        </div>
                        <small>
                          Quelle: {item?.source || '-'}
                          {item?.jobId ? ` | Job #${item.jobId}` : ''}
                          {item?.cronJobId ? ` | Cron #${item.cronJobId}` : ''}
                        </small>
                        {Number.isFinite(Number(item?.exitCode)) ? <small>Exit-Code: {item.exitCode}</small> : null}
                        {item?.message ? <small>{item.message}</small> : null}
                        {item?.errorMessage ? <small className="error-text">{item.errorMessage}</small> : null}
                        {hasRuntimeOutputDetails(item) ? (
                          <RuntimeActivityDetails
                            item={item}
                            summary="Details anzeigen"
                          />
                        ) : null}
                        <small>
                          Ende: {formatUpdatedAt(item?.finishedAt || item?.startedAt)}
                          {item?.durationMs != null ? ` | Dauer: ${formatDurationMs(item.durationMs)}` : ''}
                        </small>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        )}

        <div className="ripper-downloads-row">
          <h4>ZIP-Downloads</h4>
          <div className="ripper-downloads-meta">
            {downloadSummary?.activeCount > 0 ? (
              <Tag icon="pi pi-spinner" value={`${downloadSummary.activeCount} aktiv`} severity="warning" />
            ) : downloadSummary?.totalCount > 0 ? (
              <Tag icon="pi pi-check" value={downloadSummary.failedCount > 0 ? `Fertig (${downloadSummary.failedCount} fehlgeschlagen)` : `${downloadSummary.totalCount} fertig`} severity={downloadSummary.failedCount > 0 ? 'danger' : 'success'} />
            ) : (
              <Tag icon="pi pi-download" value="Keine aktiven Downloads" severity="secondary" />
            )}
            <Button
              label="Downloads öffnen"
              icon="pi pi-arrow-right"
              size="small"
              severity="secondary"
              outlined
              onClick={() => navigate('/downloads')}
            />
          </div>
        </div>
      </Card>

        </div>
      </div>

      <MetadataSelectionDialog
        visible={metadataDialogShouldBeVisible}
        context={effectiveMetadataDialogContext}
        onHide={() => {
          setMetadataDialogVisible(false);
          setMetadataDialogContext(null);
          setMetadataDialogReassignMode(false);
        }}
        onSubmit={handleMetadataSubmit}
        onSearch={handleMetadataSearch}
        busy={busy}
      />

      <CdMetadataDialog
        visible={cdMetadataDialogVisible}
        context={cdMetadataDialogContext || {}}
        onHide={hideCdMetadataDialog}
        onSubmit={handleCdMetadataSubmit}
        onSearch={handleMusicBrainzSearch}
        onFetchRelease={handleMusicBrainzReleaseFetch}
        busy={busy}
      />

      <Dialog
        header={cancelCleanupDialog?.target === 'raw' ? 'Rip abgebrochen' : 'Encode abgebrochen'}
        visible={Boolean(cancelCleanupDialog.visible)}
        onHide={() => setCancelCleanupDialog({ visible: false, jobId: null, target: null, path: null })}
        style={{ width: '32rem', maxWidth: '96vw' }}
        modal
      >
        <p>
          {cancelCleanupDialog?.target === 'raw'
            ? 'Soll der bisher erzeugte RAW-Ordner gelöscht werden?'
            : 'Soll die bisher erzeugte Movie-Datei inklusive Job-Ordner im Ausgabeverzeichnis gelöscht werden?'}
        </p>
        {cancelCleanupDialog?.path ? (
          <small className="muted-inline">
            {cancelCleanupDialog?.target === 'raw' ? 'RAW-Pfad' : 'Output-Pfad'}: {cancelCleanupDialog.path}
          </small>
        ) : null}
        <div className="dialog-actions">
          <Button
            label="Behalten"
            severity="secondary"
            outlined
            onClick={() => setCancelCleanupDialog({ visible: false, jobId: null, target: null, path: null })}
            disabled={cancelCleanupBusy}
          />
          <Button
            label={cancelCleanupDialog?.target === 'raw' ? 'RAW löschen' : 'Movie löschen'}
            icon="pi pi-trash"
            severity="danger"
            onClick={handleDeleteCancelledOutput}
            loading={cancelCleanupBusy}
          />
        </div>
      </Dialog>

      <Dialog
        header="Queue-Eintrag einfügen"
        visible={insertQueueDialog.visible}
        onHide={() => setInsertQueueDialog({ visible: false, afterEntryId: null })}
        style={{ width: '28rem', maxWidth: '96vw' }}
        modal
      >
        <div className="queue-insert-dialog-body">
          <p className="queue-insert-dialog-hint">
            {insertQueueDialog.afterEntryId
              ? 'Eintrag wird nach dem ausgewählten Element eingefügt.'
              : 'Eintrag wird am Ende der Queue eingefügt.'}
          </p>

          {queueCatalog.scripts.length > 0 ? (
            <div className="queue-insert-section">
              <span className="queue-insert-section-label"><i className="pi pi-code" /> Skript</span>
              <div className="queue-insert-options">
                {queueCatalog.scripts.map((script) => (
                  <button
                    key={`qi-script-${script.id}`}
                    type="button"
                    className="queue-insert-option"
                    onClick={() => void handleAddQueueEntry('script', { scriptId: script.id })}
                  >
                    {script.name}
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          {queueCatalog.chains.length > 0 ? (
            <div className="queue-insert-section">
              <span className="queue-insert-section-label"><i className="pi pi-link" /> Skriptkette</span>
              <div className="queue-insert-options">
                {queueCatalog.chains.map((chain) => (
                  <button
                    key={`qi-chain-${chain.id}`}
                    type="button"
                    className="queue-insert-option"
                    onClick={() => void handleAddQueueEntry('chain', { chainId: chain.id })}
                  >
                    {chain.name}
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          <div className="queue-insert-section">
            <span className="queue-insert-section-label"><i className="pi pi-desktop" /> System</span>
            <div className="queue-insert-options">
              <div className="queue-insert-system-block">
                <span className="queue-insert-system-name"><i className="pi pi-clock" /> Warten</span>
                <InputNumber
                  value={insertWaitSeconds}
                  onValueChange={(e) => setInsertWaitSeconds(e.value ?? 30)}
                  min={1}
                  max={3600}
                  suffix="s"
                  inputStyle={{ width: '4.5rem' }}
                />
                <Button
                  icon="pi pi-check"
                  size="small"
                  title="Einfügen"
                  onClick={() => void handleAddQueueEntry('wait', { waitSeconds: insertWaitSeconds })}
                />
              </div>
            </div>
          </div>

          {queueCatalog.scripts.length === 0 && queueCatalog.chains.length === 0 ? (
            <small className="muted-inline">Keine Skripte oder Ketten konfiguriert. In den Settings anlegen.</small>
          ) : null}
        </div>
      </Dialog>

      <Dialog
        header="Audible Activation Bytes eintragen"
        visible={activationBytesDialog.visible}
        onHide={hideActivationBytesDialog}
        style={{ width: '36rem', maxWidth: '96vw' }}
        modal
        footer={(
          <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
            <Button label="Abbrechen" severity="secondary" outlined onClick={hideActivationBytesDialog} disabled={activationBytesBusy} />
            <Button label="Speichern" icon="pi pi-check" onClick={() => void handleSaveActivationBytes()} loading={activationBytesBusy} disabled={activationBytesInput.trim().length !== 8} />
          </div>
        )}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          <div>
            <label style={{ display: 'block', marginBottom: '0.375rem', fontWeight: 600 }}>Checksum (aus der AAX-Datei)</label>
            <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
              <InputText
                value={activationBytesDialog.checksum || ''}
                readOnly
                style={{ flex: 1, fontFamily: 'monospace', fontSize: '0.85rem' }}
              />
              <Button
                icon="pi pi-copy"
                severity="secondary"
                outlined
                tooltip="Kopieren"
                onClick={() => navigator.clipboard.writeText(activationBytesDialog.checksum || '')}
              />
            </div>
          </div>
          <div>
            <label style={{ display: 'block', marginBottom: '0.375rem', fontWeight: 600 }}>Activation Bytes (8 Hex-Zeichen)</label>
            <InputText
              value={activationBytesInput}
              onChange={(e) => setActivationBytesInput(e.target.value)}
              placeholder="z.B. 1a2b3c4d"
              style={{ width: '100%', fontFamily: 'monospace' }}
              maxLength={8}
            />
          </div>
          <div style={{ background: 'var(--surface-100)', borderRadius: '6px', padding: '0.875rem', fontSize: '0.875rem', lineHeight: 1.6 }}>
            <strong>So bekommst du die Activation Bytes:</strong>
            <ol style={{ margin: '0.5rem 0 0 1.25rem', padding: 0 }}>
              <li>Öffne <strong>audible-tools.kamsker.at</strong></li>
              <li>Aktiviere den <strong>Experten-Modus</strong></li>
              <li>Gib die obige Checksum ein</li>
              <li>Kopiere die zurückgegebenen Activation Bytes hier rein</li>
            </ol>
            <p style={{ margin: '0.5rem 0 0', color: 'var(--text-color-secondary)' }}>
              Die Bytes werden lokal gespeichert und für alle weiteren AAX-Dateien desselben Accounts wiederverwendet.
            </p>
          </div>
        </div>
      </Dialog>
    </div>
  );
}
