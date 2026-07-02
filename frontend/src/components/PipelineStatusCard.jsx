import { useEffect, useMemo, useRef, useState } from 'react';
import { Card } from 'primereact/card';
import { Tag } from 'primereact/tag';
import { ProgressBar } from 'primereact/progressbar';
import { Button } from 'primereact/button';
import { Dropdown } from 'primereact/dropdown';
import MediaInfoReviewPanel from './MediaInfoReviewPanel';
import { api } from '../api/client';
import { getStatusLabel, getStatusSeverity } from '../utils/statusPresentation';
import { confirmModal } from '../utils/confirmModal';

const CONVERTER_VIDEO_OUTPUT_FORMATS = [
  { label: 'MKV', value: 'mkv' },
  { label: 'MP4', value: 'mp4' },
  { label: 'M4V', value: 'm4v' }
];

function normalizeTitleId(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return Math.trunc(parsed);
}

function normalizeTitleIdList(values) {
  const list = Array.isArray(values) ? values : [];
  const seen = new Set();
  const output = [];
  for (const value of list) {
    const normalized = normalizeTitleId(value);
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

function normalizeJobId(value) {
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

function formatDurationClock(seconds) {
  const total = Number(seconds || 0);
  if (!Number.isFinite(total) || total <= 0) {
    return null;
  }
  const rounded = Math.max(0, Math.trunc(total));
  const h = Math.floor(rounded / 3600);
  const m = Math.floor((rounded % 3600) / 60);
  const s = rounded % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
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

function normalizeChainId(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return Math.trunc(parsed);
}

function normalizeMediaProfile(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) {
    return null;
  }
  if (['bluray', 'blu-ray', 'blu_ray', 'bd', 'bdmv', 'bdrom', 'bd-rom', 'bd-r', 'bd-re'].includes(raw)) {
    return 'bluray';
  }
  if (['dvd', 'disc', 'dvdvideo', 'dvd-video', 'dvdrom', 'dvd-rom', 'video_ts', 'iso9660'].includes(raw)) {
    return 'dvd';
  }
  if (['audiobook', 'audio_book', 'audio book', 'book'].includes(raw)) {
    return 'audiobook';
  }
  if (raw === 'converter') {
    return 'converter';
  }
  if (['other', 'sonstiges', 'unknown'].includes(raw)) {
    return 'other';
  }
  return null;
}

function resolvePipelineMediaProfile(pipeline, mediaInfoReview) {
  const context = pipeline?.context && typeof pipeline.context === 'object' ? pipeline.context : {};
  const device = context?.device && typeof context.device === 'object' ? context.device : {};
  const review = mediaInfoReview && typeof mediaInfoReview === 'object' ? mediaInfoReview : {};
  const candidates = [
    context?.mediaProfile,
    context?.media_profile,
    review?.mediaProfile,
    review?.media_profile,
    device?.mediaProfile,
    device?.media_profile,
    device?.profile,
    device?.type
  ];
  for (const candidate of candidates) {
    const normalized = normalizeMediaProfile(candidate);
    if (normalized) {
      return normalized;
    }
  }
  return null;
}

function normalizeMakeMkvRipIssueMessage(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function parseMakeMkvRipIssueLine(rawLine) {
  const line = String(rawLine || '').trim();
  if (!line) {
    return null;
  }

  const sourceMatch = line.match(/^\[[^\]]+\]\s+\[([A-Z0-9_]+)\]\s+/i);
  const source = String(sourceMatch?.[1] || '').trim().toUpperCase();
  if (source && source !== 'MAKEMKV_RIP') {
    return null;
  }

  const msgCodeMatch = line.match(/\bMSG:(\d+),/i);
  const parsedCode = msgCodeMatch ? Number(msgCodeMatch[1]) : null;
  const code = Number.isFinite(parsedCode) ? Math.trunc(parsedCode) : null;
  const quotedMessageMatch = line.match(/\bMSG:\d+,[^,]*,[^,]*,"((?:[^"\\]|\\.)*)"/i);
  const fallback = line
    .replace(/^\[[^\]]+\]\s+\[[^\]]+\]\s*/i, '')
    .trim();
  const rawMessage = quotedMessageMatch?.[1]
    ? quotedMessageMatch[1].replace(/\\"/g, '"')
    : (fallback || line);
  const message = normalizeMakeMkvRipIssueMessage(rawMessage);
  if (!message) {
    return null;
  }

  const isErrorLine = /\berror\b|\bfail(?:ed|ure)?\b|\bhash check\b|\buncorrectable\b/i.test(message);
  if (!isErrorLine) {
    return null;
  }

  return { code, message };
}

function extractMakeMkvRipIssues(makemkvInfo) {
  if (!makemkvInfo || typeof makemkvInfo !== 'object') {
    return [];
  }

  const sourceLines = [];
  if (Array.isArray(makemkvInfo?.highlights)) {
    sourceLines.push(...makemkvInfo.highlights);
  }

  const stdoutTail = String(makemkvInfo?.stdoutTail || '').trim();
  if (stdoutTail) {
    sourceLines.push(...stdoutTail.split('\n'));
  }

  const stderrTail = String(makemkvInfo?.stderrTail || '').trim();
  if (stderrTail) {
    sourceLines.push(...stderrTail.split('\n'));
  }

  const seen = new Set();
  const issues = [];
  for (const line of sourceLines) {
    const parsed = parseMakeMkvRipIssueLine(line);
    if (!parsed) {
      continue;
    }
    const key = `${parsed.code ?? '-'}|${parsed.message.toLowerCase()}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    issues.push(parsed);
    if (issues.length >= 12) {
      break;
    }
  }
  return issues;
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

function isDuplicateSubtitleTrack(track) {
  return Boolean(track?.duplicate);
}

function normalizeSubtitleLanguage(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) {
    return 'und';
  }
  if (raw.length >= 3) {
    return raw.slice(0, 3);
  }
  return raw;
}

function normalizeSubtitleVariantSelectionMap(rawSelection) {
  const map = {};
  if (!rawSelection || typeof rawSelection !== 'object') {
    return map;
  }
  for (const [language, value] of Object.entries(rawSelection)) {
    const normalizedLanguage = normalizeSubtitleLanguage(language);
    const full = Boolean(value?.full);
    const forced = Boolean(value?.forced);
    map[normalizedLanguage] = { full, forced };
  }
  return map;
}

function normalizeSubtitleLanguageOrder(rawOrder = []) {
  const list = Array.isArray(rawOrder) ? rawOrder : [];
  const seen = new Set();
  const output = [];
  for (const value of list) {
    const language = normalizeSubtitleLanguage(value);
    if (!language || seen.has(language)) {
      continue;
    }
    seen.add(language);
    output.push(language);
  }
  return output;
}

function normalizeSubtitleSelectionMode(value, fallback = 'variants') {
  const mode = String(value || '').trim().toLowerCase();
  if (mode === 'track_ids' || mode === 'variants') {
    return mode;
  }
  return fallback;
}

function resolveSubtitleTrackVariantFlags(track) {
  const subtitleType = String(track?.subtitleType || '').trim().toLowerCase();
  const isForcedOnly = Boolean(
    track?.isForcedOnly
    ?? track?.subtitlePreviewForcedOnly
    ?? track?.forcedOnly
    ?? subtitleType === 'forced'
  );
  const fullHasForced = !isForcedOnly && Boolean(
    track?.fullHasForced
    ?? track?.subtitleFullHasForced
    ?? track?.hasForcedVariant
  );
  return { isForcedOnly, fullHasForced };
}

function buildDefaultSubtitleVariantSelection(subtitleTracks, selectedTracks) {
  const tracks = Array.isArray(subtitleTracks) ? subtitleTracks : [];
  const selected = Array.isArray(selectedTracks) ? selectedTracks : [];
  const orderedTracks = [...tracks].sort((a, b) => {
    const aId = normalizeTrackId(a?.id) ?? Number.MAX_SAFE_INTEGER;
    const bId = normalizeTrackId(b?.id) ?? Number.MAX_SAFE_INTEGER;
    if (aId !== bId) {
      return aId - bId;
    }
    return String(a?.language || a?.languageLabel || '').localeCompare(String(b?.language || b?.languageLabel || ''));
  });

  const order = [];
  const orderSeen = new Set();
  for (const track of orderedTracks) {
    const language = normalizeSubtitleLanguage(track?.language || track?.languageLabel || 'und');
    if (!orderSeen.has(language)) {
      orderSeen.add(language);
      order.push(language);
    }
  }

  const selectionMap = {};
  for (const track of selected) {
    if (isBurnedSubtitleTrack(track) || isDuplicateSubtitleTrack(track)) {
      continue;
    }
    const language = normalizeSubtitleLanguage(track?.language || track?.languageLabel || 'und');
    if (!selectionMap[language]) {
      selectionMap[language] = { full: false, forced: false };
    }
    const flags = resolveSubtitleTrackVariantFlags(track);
    if (flags.isForcedOnly) {
      selectionMap[language].forced = true;
    } else {
      selectionMap[language].full = true;
    }
  }

  return {
    subtitleVariantSelection: selectionMap,
    subtitleLanguageOrder: order
  };
}

function buildDefaultTrackSelection(review) {
  const titles = Array.isArray(review?.titles) ? review.titles : [];
  const selection = {};
  const reviewEncodeInputTitleId = normalizeTitleId(review?.encodeInputTitleId);
  const manualSelection = review?.manualTrackSelection && typeof review.manualTrackSelection === 'object'
    ? review.manualTrackSelection
    : null;
  const manualTitleId = normalizeTitleId(manualSelection?.titleId);

  for (const title of titles) {
    const titleId = normalizeTitleId(title?.id);
    if (!titleId) {
      continue;
    }

    const audioTracks = Array.isArray(title?.audioTracks) ? title.audioTracks : [];
    const subtitleTracks = Array.isArray(title?.subtitleTracks) ? title.subtitleTracks : [];
    const isEncodeInputTitle = Boolean(
      title?.selectedForEncode
      || title?.encodeInput
      || (reviewEncodeInputTitleId && reviewEncodeInputTitleId === titleId)
    );
    const audioSelectionSource = isEncodeInputTitle
      ? audioTracks.filter((track) => Boolean(track?.selectedForEncode))
      : audioTracks.filter((track) => Boolean(track?.selectedByRule));
    const subtitleSelectionSource = isEncodeInputTitle
      ? subtitleTracks.filter((track) => Boolean(track?.selectedForEncode))
      : subtitleTracks.filter((track) => Boolean(track?.selectedByRule));
    const defaultSubtitleVariantSelection = buildDefaultSubtitleVariantSelection(
      subtitleTracks,
      subtitleSelectionSource
    );
    const manualSelectionMatchesTitle = Boolean(
      isEncodeInputTitle
      && manualSelection
      && (!manualTitleId || manualTitleId === titleId)
    );
    const manualAudioTrackIds = manualSelectionMatchesTitle
      ? normalizeTrackIdList(manualSelection?.audioTrackIds || [])
      : [];
    const manualSubtitleTrackIds = manualSelectionMatchesTitle
      ? normalizeTrackIdList(
        Array.isArray(manualSelection?.subtitleTrackIdsOrdered)
          ? manualSelection.subtitleTrackIdsOrdered
          : manualSelection?.subtitleTrackIds || []
      )
      : [];
    const manualSubtitleVariantSelection = manualSelectionMatchesTitle
      ? normalizeSubtitleVariantSelectionMap(manualSelection?.subtitleVariantSelection || {})
      : {};
    const manualSubtitleLanguageOrder = manualSelectionMatchesTitle
      ? normalizeSubtitleLanguageOrder(manualSelection?.subtitleLanguageOrder || [])
      : [];
    const manualHasVariants = Object.keys(manualSubtitleVariantSelection).length > 0;
    const subtitleSelectionMode = manualSelectionMatchesTitle
      ? normalizeSubtitleSelectionMode(
        manualSelection?.subtitleSelectionMode,
        manualHasVariants
          ? 'variants'
          : (manualSubtitleTrackIds.length > 0 ? 'track_ids' : 'variants')
      )
      : 'variants';

    selection[titleId] = {
      audioTrackIds: manualAudioTrackIds.length > 0
        ? manualAudioTrackIds
        : normalizeTrackIdList(audioSelectionSource.map((track) => track?.id)),
      subtitleTrackIds: manualSubtitleTrackIds.length > 0
        ? manualSubtitleTrackIds
        : normalizeTrackIdList(
          subtitleSelectionSource
            .filter((track) => !isBurnedSubtitleTrack(track) && !isDuplicateSubtitleTrack(track))
            .map((track) => track?.id)
        ),
      subtitleVariantSelection: Object.keys(manualSubtitleVariantSelection).length > 0
        ? manualSubtitleVariantSelection
        : defaultSubtitleVariantSelection.subtitleVariantSelection,
      subtitleLanguageOrder: manualSubtitleLanguageOrder.length > 0
        ? manualSubtitleLanguageOrder
        : defaultSubtitleVariantSelection.subtitleLanguageOrder,
      subtitleSelectionMode
    };
  }

  return selection;
}

function defaultTrackSelectionForTitle(review, titleId) {
  const defaults = buildDefaultTrackSelection(review);
  return defaults[titleId] || defaults[String(titleId)] || {
    audioTrackIds: [],
    subtitleTrackIds: [],
    subtitleVariantSelection: {},
    subtitleLanguageOrder: [],
    subtitleSelectionMode: 'variants'
  };
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

function transliterateForFilename(input) {
  return String(input || '')
    .replace(/ä/g, 'ae').replace(/Ä/g, 'Ae')
    .replace(/ö/g, 'oe').replace(/Ö/g, 'Oe')
    .replace(/ü/g, 'ue').replace(/Ü/g, 'Ue')
    .replace(/ß/g, 'ss')
    .replace(/å/g, 'a').replace(/Å/g, 'A')
    .replace(/æ/g, 'ae').replace(/Æ/g, 'Ae')
    .replace(/ø/g, 'o').replace(/Ø/g, 'O')
    .replace(/ð/g, 'd').replace(/Ð/g, 'D')
    .replace(/þ/g, 'th').replace(/Þ/g, 'Th')
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .replace(/[^\x00-\x7F]/g, '');
}

function sanitizeFileName(input) {
  return transliterateForFilename(String(input || 'untitled'))
    .replace(/[^a-zA-Z0-9 ()[\]_+-]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180);
}

function renderTemplate(template, values) {
  const parseToken = (rawToken) => {
    const token = String(rawToken || '').trim();
    if (!token) {
      return { format: '', key: '' };
    }
    const separatorIndex = token.indexOf(':');
    if (separatorIndex <= 0) {
      return { format: '', key: token };
    }
    return {
      format: token.slice(0, separatorIndex).trim(),
      key: token.slice(separatorIndex + 1).trim()
    };
  };
  const applyFormat = (value, format) => {
    const normalizedFormat = String(format || '').trim().toLowerCase();
    if (!normalizedFormat) {
      return String(value);
    }
    if (normalizedFormat === '0') {
      const raw = String(value);
      const match = raw.match(/^(-?)(\d+)$/);
      if (match) {
        const sign = match[1] || '';
        const digits = String(match[2] || '');
        return `${sign}${digits.padStart(2, '0')}`;
      }
    }
    return String(value);
  };
  return String(template || '${title} (${year})').replace(/\$\{([^}]+)\}|\{([^{}]+)\}/g, (_, keyA, keyB) => {
    const { format, key } = parseToken(keyA || keyB || '');
    const value = values[key];
    if (value === undefined || value === null || value === '') {
      return 'unknown';
    }
    return applyFormat(value, format);
  });
}

function normalizePositiveInt(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return Math.trunc(parsed);
}

function hasSeriesMetadataShape(source = null) {
  const metadata = source && typeof source === 'object' ? source : {};
  const seasonNumber = normalizePositiveInt(metadata?.seasonNumber ?? metadata?.season ?? null);
  const episodes = Array.isArray(metadata?.episodes) ? metadata.episodes : [];
  const workflowKind = String(metadata?.workflowKind || metadata?.kind || '').trim().toLowerCase();
  const metadataKind = String(metadata?.metadataKind || '').trim().toLowerCase();
  const episodeCount = Number(metadata?.episodeCount || 0) || 0;
  if (['film', 'movie', 'feature'].includes(workflowKind) || ['film', 'movie', 'feature'].includes(metadataKind)) {
    return false;
  }
  return Boolean(
    seasonNumber
    || episodeCount > 0
    || episodes.length > 0
    || workflowKind === 'series'
    || workflowKind === 'season'
    || workflowKind === 'tv'
    || metadataKind === 'series'
    || metadataKind === 'season'
    || metadataKind === 'tv'
  );
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
  mediaProfile = null,
  selectedMetadata = null,
  analyzeContext = null,
  pipelineContext = null,
  fallbackIsSeries = false
} = {}) {
  const normalizedMediaProfile = String(mediaProfile || '').trim().toLowerCase();
  if (normalizedMediaProfile !== 'dvd' && normalizedMediaProfile !== 'bluray') {
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
    hasSeriesMetadataShape(selected)
    || hasSeriesMetadataShape(analyze)
    || hasSeriesMetadataShape(pipelineCtx)
  ) {
    return 'series';
  }
  return null;
}

function getDiscWorkflowBadgeLabel(mediaProfile, workflowKind) {
  const normalizedMediaProfile = String(mediaProfile || '').trim().toLowerCase();
  if (normalizedMediaProfile !== 'dvd' && normalizedMediaProfile !== 'bluray') {
    return null;
  }
  const kind = normalizeDiscWorkflowKind(workflowKind);
  if (!kind) {
    return null;
  }
  if (normalizedMediaProfile === 'bluray') {
    return kind === 'series' ? 'Blu-ray-Serie' : 'Blu-ray-Film';
  }
  return kind === 'series' ? 'DVD-Serie' : 'DVD-Film';
}

function hasSeriesEpisodeAssignmentHints(titles = []) {
  const reviewTitles = Array.isArray(titles) ? titles : [];
  return reviewTitles.some((title) => {
    const seasonNumber = normalizePositiveInt(title?.seasonNumber ?? title?.season ?? null);
    const episodeNumber = normalizePositiveInt(title?.episodeNumber ?? title?.number ?? null);
    const episodeId = normalizePositiveInt(title?.episodeId ?? null);
    const episodeTitle = String(title?.episodeTitle || '').trim();
    const episodeTitleStart = String(title?.episodeTitleStart || '').trim();
    return Boolean(seasonNumber || episodeNumber || episodeId || episodeTitle || episodeTitleStart);
  });
}

function normalizeEpisodeReference(entry = {}) {
  const source = entry && typeof entry === 'object' ? entry : {};
  const episodeId = normalizePositiveInt(source?.episodeId ?? source?.id ?? null);
  const episodeNumber = normalizePositiveInt(source?.episodeNumber ?? source?.number ?? null);
  const seasonNumber = normalizePositiveInt(source?.seasonNumber ?? source?.season ?? null);
  if (!episodeId && !episodeNumber) {
    return null;
  }
  return {
    episodeId,
    episodeNumber,
    seasonNumber
  };
}

function buildEpisodeReferenceKey(entry = {}) {
  const normalized = normalizeEpisodeReference(entry);
  if (!normalized) {
    return null;
  }
  if (normalized.episodeId) {
    return `id:${normalized.episodeId}`;
  }
  if (normalized.seasonNumber && normalized.episodeNumber) {
    return `se:${normalized.seasonNumber}:${normalized.episodeNumber}`;
  }
  return normalized.episodeNumber ? `ep:${normalized.episodeNumber}` : null;
}

function collectEpisodeReferenceKeys(entry = {}) {
  const normalized = normalizeEpisodeReference(entry);
  if (!normalized) {
    return [];
  }
  const keys = [];
  if (normalized.episodeId) {
    keys.push(`id:${normalized.episodeId}`);
  }
  if (normalized.seasonNumber && normalized.episodeNumber) {
    keys.push(`se:${normalized.seasonNumber}:${normalized.episodeNumber}`);
  }
  if (normalized.episodeNumber) {
    keys.push(`ep:${normalized.episodeNumber}`);
  }
  return Array.from(new Set(keys));
}

function isSeriesBatchEpisodePlan(plan = null) {
  const source = plan && typeof plan === 'object' ? plan : {};
  if (Boolean(source?.seriesBatchChild) || Boolean(source?.seriesBatchVirtualEpisode)) {
    return true;
  }
  const parentJobId = normalizePositiveInt(source?.seriesBatchParentJobId);
  const childIndex = normalizePositiveInt(source?.seriesBatchChildIndex);
  const childCount = normalizePositiveInt(source?.seriesBatchChildCount);
  const titleId = normalizeTitleId(source?.seriesBatchTitleId);
  return Boolean(parentJobId && (childIndex || childCount || titleId));
}

function collectEpisodeReferencesFromPlan(plan = null) {
  const source = plan && typeof plan === 'object' ? plan : {};
  const refs = [];
  const assignments = source?.episodeAssignments && typeof source.episodeAssignments === 'object'
    ? Object.values(source.episodeAssignments)
    : [];
  for (const assignment of assignments) {
    const normalized = normalizeEpisodeReference(assignment);
    if (normalized) {
      refs.push(normalized);
    }
    const seasonNumber = normalizePositiveInt(assignment?.seasonNumber ?? assignment?.season ?? null);
    const episodeStart = normalizePositiveInt(
      assignment?.episodeNumberStart
      ?? assignment?.episodeNoStart
      ?? assignment?.episodeNumber
      ?? assignment?.number
      ?? null
    );
    const episodeEnd = normalizePositiveInt(
      assignment?.episodeNumberEnd
      ?? assignment?.episodeNoEnd
      ?? null
    );
    if (episodeStart && episodeEnd && episodeEnd > episodeStart && (episodeEnd - episodeStart) <= 64) {
      for (let number = episodeStart; number <= episodeEnd; number += 1) {
        refs.push({
          episodeId: null,
          episodeNumber: number,
          seasonNumber
        });
      }
    }
  }

  const titles = Array.isArray(source?.titles) ? source.titles : [];
  for (const title of titles) {
    if (!Boolean(title?.selectedForEncode) && !Boolean(title?.encodeInput)) {
      continue;
    }
    const normalized = normalizeEpisodeReference({
      episodeId: title?.episodeId,
      episodeNumber: title?.episodeNumber,
      seasonNumber: title?.seasonNumber
    });
    if (normalized) {
      refs.push(normalized);
    }
  }
  return refs;
}

function normalizeSeriesLanguage(value) {
  const raw = String(value || '').trim();
  if (!raw) {
    return 'unknown';
  }
  return raw;
}

function normalizeSeriesTitleForOutputPath(value, fallback = 'series') {
  const raw = String(value || '').trim();
  if (!raw) {
    return String(fallback || 'series').trim() || 'series';
  }
  const stripped = raw
    .replace(/\s*-\s*S\d{1,2}E\d{1,3}(?:-\d{1,3})?\b.*$/i, '')
    .trim();
  if (stripped) {
    return stripped;
  }
  return raw;
}

function normalizeSeriesBatchStatus(value) {
  return String(value || '').trim().toUpperCase() || 'UNKNOWN';
}

function normalizeSeriesBatchProgress(value, fallback = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    const fallbackValue = Number(fallback);
    return Number.isFinite(fallbackValue) ? Math.max(0, Math.min(100, fallbackValue)) : 0;
  }
  return Math.max(0, Math.min(100, parsed));
}

function formatPercentNoDecimals(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return '0%';
  }
  return `${Math.trunc(Math.max(0, Math.min(100, parsed)))}%`;
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

function getSeriesBatchTagSeverity(status) {
  const normalized = normalizeSeriesBatchStatus(status);
  if (normalized === 'FINISHED') {
    return 'success';
  }
  if (normalized === 'ERROR') {
    return 'danger';
  }
  if (normalized === 'CANCELLED') {
    return 'warning';
  }
  if (normalized === 'ENCODING' || normalized === 'RIPPING' || normalized === 'MEDIAINFO_CHECK') {
    return 'info';
  }
  return 'secondary';
}

function medianPositiveInt(values = []) {
  const nums = (Array.isArray(values) ? values : [])
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value > 0)
    .sort((left, right) => left - right);
  if (nums.length === 0) {
    return 0;
  }
  const middle = Math.floor(nums.length / 2);
  if (nums.length % 2 === 1) {
    return nums[middle];
  }
  return (nums[middle - 1] + nums[middle]) / 2;
}

function formatTemplateTwoDigit(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return String(value || '').trim() || '00';
  }
  if (Number.isInteger(numeric)) {
    return String(Math.trunc(numeric)).padStart(2, '0');
  }
  return String(value || '').trim() || String(numeric);
}

function resolveEpisodeAssignmentRange(assignment = null, title = null, fallbackEpisodeNumber = 1, options = {}) {
  const assignmentSource = assignment && typeof assignment === 'object' ? assignment : {};
  const titleSource = title && typeof title === 'object' ? title : {};
  const allowTitleEpisodeNumber = options?.allowTitleEpisodeNumber !== false;
  const fallbackNumber = normalizePositiveInt(fallbackEpisodeNumber) || 1;
  const episodeStart = normalizePositiveInt(
    assignmentSource?.episodeNumberStart
    ?? assignmentSource?.episodeNoStart
    ?? assignmentSource?.episodeNumber
    ?? (allowTitleEpisodeNumber ? titleSource?.episodeNumber : null)
    ?? fallbackNumber
  ) || fallbackNumber;
  const explicitEpisodeEnd = normalizePositiveInt(
    assignmentSource?.episodeNumberEnd
    ?? assignmentSource?.episodeNoEnd
    ?? null
  );
  const explicitSpan = normalizePositiveInt(
    assignmentSource?.episodeSpan
    ?? assignmentSource?.episodeCount
    ?? null
  );

  let episodeEnd = explicitEpisodeEnd;
  if (!episodeEnd && explicitSpan && explicitSpan > 1) {
    episodeEnd = episodeStart + explicitSpan - 1;
  }
  if (episodeEnd && episodeEnd < episodeStart) {
    episodeEnd = episodeStart;
  }
  const normalizedEnd = episodeEnd || episodeStart;
  const episodeSpan = Math.max(1, normalizedEnd - episodeStart + 1);
  return {
    start: episodeStart,
    end: normalizedEnd,
    span: episodeSpan,
    isMulti: normalizedEnd > episodeStart
  };
}

function hasExplicitEpisodeAssignmentRange(assignment = null) {
  const source = assignment && typeof assignment === 'object' ? assignment : null;
  if (!source) {
    return false;
  }
  const hasStart = normalizePositiveInt(
    source?.episodeNumberStart
    ?? source?.episodeNoStart
    ?? null
  ) !== null;
  const hasEnd = normalizePositiveInt(
    source?.episodeNumberEnd
    ?? source?.episodeNoEnd
    ?? null
  ) !== null;
  const hasSpan = normalizePositiveInt(
    source?.episodeSpan
    ?? source?.episodeCount
    ?? null
  ) !== null;
  const hasEpisodeNumber = normalizePositiveInt(source?.episodeNumber ?? null) !== null;
  const hasEpisodeIdStart = normalizePositiveInt(source?.episodeIdStart ?? null) !== null;
  const hasRangeToken = String(source?.episodeRange || '').trim().length > 0;
  return Boolean(hasStart || hasEnd || hasSpan || hasEpisodeNumber || hasEpisodeIdStart || hasRangeToken);
}

function buildEpisodeRangeToken(start, end) {
  const startToken = formatTemplateTwoDigit(start);
  const endToken = formatTemplateTwoDigit(end);
  if (Number(end) > Number(start)) {
    return `${startToken}-${endToken}`;
  }
  return startToken;
}

function buildEpisodePartsToken(episodeRange = null) {
  const start = normalizePositiveInt(episodeRange?.start) || 1;
  const end = normalizePositiveInt(episodeRange?.end) || start;
  const span = Math.max(1, end - start + 1);
  if (span <= 1) {
    return '1';
  }
  if (span === 2) {
    return '1+2';
  }
  return `1-${span}`;
}

function normalizeEpisodeTitleTokenForCompare(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .replace(/[^a-z0-9]+/g, '')
    .trim();
}

function findCommonEpisodeTitlePrefix(values = []) {
  const rows = (Array.isArray(values) ? values : [])
    .map((value) => String(value || '').trim())
    .filter(Boolean);
  if (rows.length === 0) {
    return '';
  }
  if (rows.length === 1) {
    return rows[0];
  }
  const tokenRows = rows.map((value) => value.split(/\s+/).filter(Boolean));
  const firstTokens = tokenRows[0];
  if (firstTokens.length === 0) {
    return '';
  }
  let prefixLength = 0;
  for (let index = 0; index < firstTokens.length; index += 1) {
    const tokenKey = normalizeEpisodeTitleTokenForCompare(firstTokens[index]);
    if (!tokenKey) {
      break;
    }
    const matchesAll = tokenRows.slice(1).every((tokens) => {
      const current = tokens[index];
      return normalizeEpisodeTitleTokenForCompare(current) === tokenKey;
    });
    if (!matchesAll) {
      break;
    }
    prefixLength += 1;
  }
  if (prefixLength <= 0) {
    return '';
  }
  return firstTokens
    .slice(0, prefixLength)
    .join(' ')
    .replace(/[-–—:.,\s]+$/g, '')
    .trim();
}

function stripEpisodePartSuffix(value) {
  const source = String(value || '').replace(/\s+/g, ' ').trim();
  if (!source) {
    return '';
  }
  // Output cleanup for multi-episode labels:
  // remove "Teil/Part" markers and pure numeric/roman suffixes in
  // parentheses like "(1)" / "(2)".
  const suffixPattern = /(?:\s*[-–—:.,]?\s*)(?:(?:\(?\s*(?:teil|part|pt)\s*(?:\d{1,2}|[ivxlcdm]{1,6})(?:\s*(?:\/|von|of)\s*(?:\d{1,2}|[ivxlcdm]{1,6}))?\s*\)?)|\(\s*(?:\d{1,2}|[ivxlcdm]{1,6})\s*\))\s*$/i;
  let normalized = source;
  let changed = false;
  for (let i = 0; i < 2; i += 1) {
    const next = normalized.replace(suffixPattern, '').replace(/[-–—:.,\s]+$/g, '').trim();
    if (!next || next === normalized) {
      break;
    }
    normalized = next;
    changed = true;
  }
  return changed ? (normalized || source) : source;
}

function normalizeEpisodeTitleForOutput(value, episodeRange = null) {
  const source = String(value || '').replace(/\s+/g, ' ').trim();
  if (!source) {
    return '';
  }
  if (!Boolean(episodeRange?.isMulti)) {
    return source;
  }
  const strippedSource = stripEpisodePartSuffix(source) || source;
  const rawSegments = source
    .split(/\s+(?:\+|\/|\||&)\s+/)
    .map((part) => String(part || '').trim())
    .filter(Boolean);
  if (rawSegments.length < 2) {
    return strippedSource;
  }
  const cleanedSegments = rawSegments
    .map((part) => stripEpisodePartSuffix(part) || part)
    .map((part) => String(part || '').replace(/[-–—:.,\s]+$/g, '').trim())
    .filter(Boolean);
  if (cleanedSegments.length === 0) {
    return strippedSource;
  }
  const uniqueSegments = [];
  const seen = new Set();
  for (const segment of cleanedSegments) {
    const key = normalizeEpisodeTitleTokenForCompare(segment);
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    uniqueSegments.push(segment);
  }
  if (uniqueSegments.length === 1) {
    return uniqueSegments[0];
  }
  const allSegmentsLookLikePartTitles = rawSegments.every((segment) => /\b(?:teil|part|pt)\b/i.test(segment));
  if (allSegmentsLookLikePartTitles) {
    const commonPrefix = findCommonEpisodeTitlePrefix(cleanedSegments);
    if (commonPrefix && commonPrefix.length >= 6) {
      return commonPrefix;
    }
    return uniqueSegments[0] || cleanedSegments[0] || strippedSource;
  }
  return strippedSource;
}

function resolveTitleDurationSeconds(title = null) {
  const fromSeconds = Number(title?.durationSeconds || 0);
  if (Number.isFinite(fromSeconds) && fromSeconds > 0) {
    return fromSeconds;
  }
  const fromMinutes = Number(title?.durationMinutes || 0);
  if (Number.isFinite(fromMinutes) && fromMinutes > 0) {
    return fromMinutes * 60;
  }
  return 0;
}

function estimateSeriesEpisodeSpanForTitle(title = null, allTitles = []) {
  const titleDuration = resolveTitleDurationSeconds(title);
  if (!Number.isFinite(titleDuration) || titleDuration <= 0) {
    return 1;
  }
  const durations = (Array.isArray(allTitles) ? allTitles : [])
    .map((item) => resolveTitleDurationSeconds(item))
    .filter((value) => Number.isFinite(value) && value > 0);
  if (durations.length === 0) {
    return 1;
  }
  const medianDuration = medianPositiveInt(durations);
  if (!medianDuration) {
    return 1;
  }
  const baselinePool = durations.filter((value) => value <= medianDuration * 1.35);
  const baselineDuration = medianPositiveInt(baselinePool.length > 0 ? baselinePool : durations) || medianDuration;
  if (!baselineDuration) {
    return 1;
  }
  const ratio = titleDuration / baselineDuration;
  const roundedSpan = Math.round(ratio);
  if (!Number.isFinite(roundedSpan) || roundedSpan < 2 || roundedSpan > 4) {
    return 1;
  }
  const minRatio = roundedSpan === 2 ? 1.55 : roundedSpan * 0.72;
  const maxRatio = roundedSpan * 1.32;
  if (ratio < minRatio || ratio > maxRatio) {
    return 1;
  }
  return roundedSpan;
}

function resolveEffectiveEpisodeRangeForTitle(assignment = null, title = null, allTitles = [], fallbackEpisodeNumber = 1) {
  const baseRange = resolveEpisodeAssignmentRange(assignment, title, fallbackEpisodeNumber);
  if (baseRange.isMulti) {
    return baseRange;
  }
  if (hasExplicitEpisodeAssignmentRange(assignment)) {
    return baseRange;
  }
  const spanHint = estimateSeriesEpisodeSpanForTitle(title, allTitles);
  if (spanHint <= 1) {
    return baseRange;
  }
  return {
    start: baseRange.start,
    end: baseRange.start + spanHint - 1,
    span: spanHint,
    isMulti: true
  };
}

function resolveSeriesTitleOrderForPreview(allTitles = [], selectedTitleIds = [], targetTitleId = null) {
  const explicitSelectedIds = normalizeTitleIdList(selectedTitleIds);
  const fallbackSelectedIds = explicitSelectedIds.length > 0
    ? explicitSelectedIds
    : normalizeTitleIdList(
      (Array.isArray(allTitles) ? allTitles : [])
        .filter((item) => Boolean(item?.selectedForEncode || item?.encodeInput))
        .map((item) => item?.id)
    );
  let ordered = fallbackSelectedIds;
  const normalizedTarget = normalizeTitleId(targetTitleId);
  if (normalizedTarget && !ordered.some((id) => Number(id) === Number(normalizedTarget))) {
    ordered = [...ordered, Number(normalizedTarget)];
  }
  if (ordered.length === 0 && normalizedTarget) {
    ordered = [Number(normalizedTarget)];
  }
  return ordered;
}

function resolveEpisodeRangeForTitleFromAssignments({
  assignmentByTitle = {},
  allTitles = [],
  selectedTitleIds = [],
  targetTitle = null,
  fallbackEpisodeNumber = 1
}) {
  const titles = Array.isArray(allTitles) ? allTitles : [];
  const titlesById = new Map();
  for (const item of titles) {
    const id = normalizeTitleId(item?.id);
    if (!id) {
      continue;
    }
    titlesById.set(Number(id), item);
  }
  const targetTitleId = normalizeTitleId(targetTitle?.id || null);
  const orderedTitleIds = resolveSeriesTitleOrderForPreview(titles, selectedTitleIds, targetTitleId);
  const fallbackStart = normalizePositiveInt(fallbackEpisodeNumber) || 1;
  let cursor = fallbackStart;
  let targetRange = null;

  for (const rawId of orderedTitleIds) {
    const currentId = normalizeTitleId(rawId);
    if (!currentId) {
      continue;
    }
    const assignment = assignmentByTitle?.[currentId] || assignmentByTitle?.[String(currentId)] || null;
    const currentTitle = titlesById.get(Number(currentId)) || null;
    const hasExplicitRange = hasExplicitEpisodeAssignmentRange(assignment);
    const range = resolveEpisodeAssignmentRange(
      assignment,
      currentTitle,
      cursor,
      { allowTitleEpisodeNumber: hasExplicitRange }
    );
    const normalizedEnd = normalizePositiveInt(range?.end);
    if (normalizedEnd !== null) {
      cursor = normalizedEnd + 1;
    }
    if (targetTitleId && Number(currentId) === Number(targetTitleId)) {
      targetRange = range;
      break;
    }
  }

  if (!targetRange) {
    const assignment = targetTitleId
      ? (assignmentByTitle?.[targetTitleId] || assignmentByTitle?.[String(targetTitleId)] || null)
      : null;
    const hasExplicitRange = hasExplicitEpisodeAssignmentRange(assignment);
    targetRange = resolveEpisodeAssignmentRange(
      assignment,
      targetTitle,
      cursor,
      { allowTitleEpisodeNumber: hasExplicitRange }
    );
  }

  return targetRange;
}

function templateUsesLeadingZeroForToken(template, token) {
  const source = String(template || '').trim();
  const normalizedToken = String(token || '').trim();
  if (!source || !normalizedToken) {
    return false;
  }
  const pattern = new RegExp(`\\{\\s*0\\s*:\\s*${normalizedToken}\\s*\\}`, 'i');
  return pattern.test(source);
}

function formatEpisodeNumberByTemplate(rawValue, template, token = 'episodeNr') {
  const numeric = Number(rawValue);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return String(rawValue || '').trim() || '0';
  }
  if (!Number.isInteger(numeric)) {
    return String(numeric);
  }
  const normalized = String(Math.trunc(numeric));
  if (templateUsesLeadingZeroForToken(template, token)) {
    return normalized.padStart(2, '0');
  }
  return normalized;
}

function buildFallbackEpisodeTitleForOutput(episodeRange = null, template = '') {
  const start = normalizePositiveInt(episodeRange?.start) || 1;
  const end = normalizePositiveInt(episodeRange?.end) || start;
  if (end > start) {
    const startToken = formatEpisodeNumberByTemplate(start, template, 'episodeNr');
    const endToken = formatEpisodeNumberByTemplate(end, template, 'episodeNr');
    return `Folge ${startToken}-${endToken}`;
  }
  const token = formatEpisodeNumberByTemplate(start, template, 'episodeNr');
  return `Folge ${token}`;
}

function buildDvdSeriesEpisodeOutputPathPreview(
  settings,
  mediaProfile,
  metadata,
  title,
  assignment = null,
  fallbackJobId = null,
  allTitles = [],
  assignmentByTitle = {},
  selectedTitleIds = []
) {
  const normalizedSeriesMediaProfile = String(mediaProfile || '').trim().toLowerCase() === 'bluray'
    ? 'bluray'
    : 'dvd';
  const seriesRootDir = String(
    (normalizedSeriesMediaProfile === 'bluray'
      ? (settings?.series_dir_bluray || settings?.series_dir_dvd || settings?.movie_dir_bluray || settings?.movie_dir_dvd)
      : (settings?.series_dir_dvd || settings?.series_dir_bluray || settings?.movie_dir_dvd || settings?.movie_dir_bluray))
    || settings?.movie_dir
    || ''
  ).trim();
  if (!seriesRootDir) {
    return null;
  }

  const seasonNumber = normalizePositiveInt(
    assignment?.seasonNumber ?? metadata?.seasonNumber ?? title?.seasonNumber ?? 1
  ) || 1;
  const normalizedSelectedIds = normalizeTitleIdList(selectedTitleIds);
  const targetTitleId = normalizeTitleId(title?.id);
  const fallbackEpisodeNumber = targetTitleId && normalizedSelectedIds.length > 0
    ? (normalizedSelectedIds.findIndex((id) => Number(id) === Number(targetTitleId)) + 1)
    : 1;
  const inferredRange = resolveEpisodeRangeForTitleFromAssignments({
    assignmentByTitle,
    allTitles,
    selectedTitleIds: normalizedSelectedIds,
    targetTitle: title,
    fallbackEpisodeNumber: fallbackEpisodeNumber > 0 ? fallbackEpisodeNumber : 1
  });
  const episodeRange = resolveEffectiveEpisodeRangeForTitle(
    assignment || {},
    title,
    allTitles,
    inferredRange?.start || (fallbackEpisodeNumber > 0 ? fallbackEpisodeNumber : 1)
  );
  const effectiveEpisodeRange = episodeRange;
  const episodeNumber = effectiveEpisodeRange.start;
  const episodeRangeToken = buildEpisodeRangeToken(effectiveEpisodeRange.start, effectiveEpisodeRange.end);
  const partsToken = buildEpisodePartsToken(effectiveEpisodeRange);
  const discNumber = normalizePositiveInt(metadata?.discNumber ?? assignment?.discNumber ?? null);
  const seriesTitle = normalizeSeriesTitleForOutputPath(
    metadata?.seriesTitle
      || metadata?.title
      || (fallbackJobId ? `job-${fallbackJobId}` : 'series'),
    fallbackJobId ? `job-${fallbackJobId}` : 'series'
  );
  const year = String(metadata?.year || new Date().getFullYear()).trim();
  const language = normalizeSeriesLanguage(settings?.dvd_series_language || metadata?.language || null);

  const singleTemplateRaw = String(
    (normalizedSeriesMediaProfile === 'bluray'
      ? settings?.output_template_bluray_series_episode
      : settings?.output_template_dvd_series_episode)
    || settings?.output_template_dvd_series_episode
    || settings?.output_template_bluray_series_episode
    || '{seriesTitle}/Staffel {seasonNr}/S{seasonNr}E{episodeNr} - {episodeTitle}'
  ).trim();
  const multiTemplateRaw = String(
    (normalizedSeriesMediaProfile === 'bluray'
      ? settings?.output_template_bluray_series_multi_episode
      : settings?.output_template_dvd_series_multi_episode)
    || settings?.output_template_dvd_series_multi_episode
    || settings?.output_template_bluray_series_multi_episode
    || '{seriesTitle}/Staffel {seasonNr}/S{0:seasonNr}E{episodeRange} - {episodeTitle} (Teil {parts})'
  ).trim();
  const singleTemplate = singleTemplateRaw || '{seriesTitle}/Staffel {seasonNr}/S{seasonNr}E{episodeNr} - {episodeTitle}';
  const multiTemplate = multiTemplateRaw || '{seriesTitle}/Staffel {seasonNr}/S{0:seasonNr}E{episodeRange} - {episodeTitle} (Teil {parts})';
  const template = effectiveEpisodeRange.isMulti ? multiTemplate : singleTemplate;
  const fallbackEpisodeTitle = buildFallbackEpisodeTitleForOutput(effectiveEpisodeRange, template);
  const episodeTitleRaw = String(
    assignment?.episodeTitle
    || title?.episodeTitle
    || fallbackEpisodeTitle
  ).trim();
  const rendered = renderTemplate(template, {
    seriesTitle,
    seasonNr: seasonNumber,
    episodeNr: episodeNumber,
    episodeNoStart: effectiveEpisodeRange.start,
    episodeNoEnd: effectiveEpisodeRange.end,
    episodeNumberStart: effectiveEpisodeRange.start,
    episodeNumberEnd: effectiveEpisodeRange.end,
    episodeRange: episodeRangeToken,
    episodeSpan: effectiveEpisodeRange.span,
    parts: partsToken,
    episodeTitle: normalizeEpisodeTitleForOutput(
      episodeTitleRaw || fallbackEpisodeTitle,
      effectiveEpisodeRange
    ) || fallbackEpisodeTitle,
    discNr: discNumber || '',
    year,
    language
  });

  const segments = rendered
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .replace(/^\/+|\/+$/g, '')
    .split('/')
    .map((seg) => sanitizeFileName(seg))
    .filter(Boolean);
  const baseName = segments.length > 0 ? segments[segments.length - 1] : 'untitled';
  const folderParts = segments.slice(0, -1);
  const ext = String(
    (normalizedSeriesMediaProfile === 'bluray'
      ? settings?.output_extension_bluray
      : settings?.output_extension_dvd)
    || settings?.output_extension_dvd
    || settings?.output_extension_bluray
    || settings?.output_extension
    || 'mkv'
  ).trim() || 'mkv';
  const root = seriesRootDir.replace(/\/+$/g, '');
  if (folderParts.length > 0) {
    return `${root}/${folderParts.join('/')}/${baseName}.${ext}`;
  }
  return `${root}/${baseName}.${ext}`;
}

function resolveProfiledSetting(settings, key, mediaProfile) {
  const profileKey = mediaProfile ? `${key}_${mediaProfile}` : null;
  if (profileKey && settings?.[profileKey] != null && settings[profileKey] !== '') {
    return settings[profileKey];
  }
  const fallbackProfiles = mediaProfile === 'bluray'
    ? ['dvd']
    : mediaProfile === 'dvd'
      ? ['bluray']
      : ['bluray', 'dvd', 'cd', 'audiobook'];
  for (const fb of fallbackProfiles) {
    const fbKey = `${key}_${fb}`;
    if (settings?.[fbKey] != null && settings[fbKey] !== '') {
      return settings[fbKey];
    }
  }
  return settings?.[key] ?? null;
}

function resolveMultipartDiscSuffixForPreview({
  jobRow = null,
  pipeline = null,
  mediaInfoReview = null,
  selectedMetadata = null
} = {}) {
  const context = pipeline?.context && typeof pipeline.context === 'object' ? pipeline.context : {};
  const review = mediaInfoReview && typeof mediaInfoReview === 'object' ? mediaInfoReview : {};
  const reviewSelectedMetadata = review?.selectedMetadata && typeof review.selectedMetadata === 'object'
    ? review.selectedMetadata
    : {};
  const contextSelectedMetadata = context?.selectedMetadata && typeof context.selectedMetadata === 'object'
    ? context.selectedMetadata
    : {};
  const jobMkInfo = jobRow?.makemkvInfo && typeof jobRow.makemkvInfo === 'object'
    ? jobRow.makemkvInfo
    : {};
  const jobAnalyzeContext = jobMkInfo?.analyzeContext && typeof jobMkInfo.analyzeContext === 'object'
    ? jobMkInfo.analyzeContext
    : {};
  const jobAnalyzeSelectedMetadata = jobAnalyzeContext?.selectedMetadata && typeof jobAnalyzeContext.selectedMetadata === 'object'
    ? jobAnalyzeContext.selectedMetadata
    : {};

  const jobKindCandidates = [
    jobRow?.job_kind,
    jobRow?.jobKind,
    context?.jobKind,
    review?.jobKind,
    review?.encodePlan?.jobKind
  ]
    .map((value) => String(value || '').trim().toLowerCase())
    .filter(Boolean);
  const isMultipartMerge = jobKindCandidates.includes('multipart_movie_merge');
  if (isMultipartMerge) {
    return '';
  }
  const isMultipartChild = jobKindCandidates.includes('multipart_movie_child')
    || Number(jobRow?.is_multipart_movie || jobRow?.isMultipartMovie || 0) === 1
    || Number(context?.isMultipartMovie || 0) === 1
    || Number(review?.isMultipartMovie || 0) === 1;
  if (!isMultipartChild) {
    return '';
  }

  const discNumber = normalizePositiveInt(
    jobRow?.disc_number
    ?? jobRow?.discNumber
    ?? selectedMetadata?.discNumber
    ?? contextSelectedMetadata?.discNumber
    ?? reviewSelectedMetadata?.discNumber
    ?? jobAnalyzeSelectedMetadata?.discNumber
    ?? context?.discNumber
    ?? null
  );
  if (!discNumber) {
    return '';
  }

  return `_Disc${discNumber}`;
}

function buildOutputPathPreview(settings, mediaProfile, metadata, fallbackJobId = null, options = {}) {
  const movieDir = String(resolveProfiledSetting(settings, 'movie_dir', mediaProfile) || '').trim();
  if (!movieDir) {
    return null;
  }

  const title = metadata?.title || (fallbackJobId ? `job-${fallbackJobId}` : 'job');
  const author = metadata?.author || metadata?.artist || 'unknown';
  const narrator = metadata?.narrator || 'unknown';
  const year = metadata?.year || new Date().getFullYear();
  const imdbId = metadata?.imdbId || (fallbackJobId ? `job-${fallbackJobId}` : 'noimdb');
  const DEFAULT_TEMPLATE = '${title} (${year})/${title} (${year})';
  const rawTemplate = resolveProfiledSetting(settings, 'output_template', mediaProfile);
  const template = String(rawTemplate || DEFAULT_TEMPLATE).trim() || DEFAULT_TEMPLATE;
  const rendered = renderTemplate(template, { title, year, imdbId, author, narrator });
  const segments = rendered
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .replace(/^\/+|\/+$/g, '')
    .split('/')
    .map((seg) => sanitizeFileName(seg))
    .filter(Boolean);
  const rawBaseName = segments.length > 0 ? segments[segments.length - 1] : 'untitled';
  const outputSuffix = String(options?.outputSuffix || '').trim();
  const baseName = outputSuffix ? `${rawBaseName}${outputSuffix}` : rawBaseName;
  const folderParts = segments.slice(0, -1);
  const rawExt = resolveProfiledSetting(settings, 'output_extension', mediaProfile);
  const ext = String(rawExt || 'mkv').trim() || 'mkv';
  const root = movieDir.replace(/\/+$/g, '');
  if (folderParts.length > 0) {
    return `${root}/${folderParts.join('/')}/${baseName}.${ext}`;
  }
  return `${root}/${baseName}.${ext}`;
}

function buildConverterOutputPathPreview(settings, review, metadata, fallbackJobId = null) {
  const explicitPath = String(review?.outputPath || review?.outputDir || '').trim();
  if (explicitPath) {
    return explicitPath;
  }

  const movieDir = String(settings?.converter_movie_dir || '').trim();
  if (!movieDir) {
    return null;
  }
  const title = metadata?.title || (fallbackJobId ? `job-${fallbackJobId}` : 'job');
  const year = metadata?.year || new Date().getFullYear();
  const template = String(settings?.converter_output_template_video || '{title}').trim() || '{title}';
  const rendered = renderTemplate(template, { title, year });
  const segments = rendered
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .replace(/^\/+|\/+$/g, '')
    .split('/')
    .map((seg) => sanitizeFileName(seg))
    .filter(Boolean);
  const baseName = segments.length > 0 ? segments[segments.length - 1] : 'untitled';
  const folderParts = segments.slice(0, -1);
  const ext = String(review?.outputFormat || 'mkv').trim() || 'mkv';
  const root = movieDir.replace(/\/+$/g, '');
  if (folderParts.length > 0) {
    return `${root}/${folderParts.join('/')}/${baseName}.${ext}`;
  }
  return `${root}/${baseName}.${ext}`;
}

export default function PipelineStatusCard({
  jobId = null,
  pipeline,
  onAnalyze,
  onReanalyze,
  onOpenMetadata,
  onReassignMetadata,
  onStart,
  onRemoveFromQueue,
  onRestartEncode,
  onRestartReview,
  onConfirmReview,
  onSelectPlaylist,
  onSelectHandBrakeTitle,
  onSubmitRawDecision,
  onCancel,
  onRetry,
  onDeleteJob,
  onInputsChanged,
  jobRow,
  isQueued = false,
  busy
}) {
  const state = pipeline?.state || 'IDLE';
  const stateLabel = getStatusLabel(state);
  const progress = Number(pipeline?.progress || 0);
  const running = state === 'ANALYZING' || state === 'RIPPING' || state === 'ENCODING' || state === 'MEDIAINFO_CHECK';
  const explicitJobId = normalizeJobId(jobId);
  const contextJobId = normalizeJobId(pipeline?.context?.jobId);
  const retryJobId = explicitJobId || contextJobId;
  const queueLocked = Boolean(isQueued && retryJobId);
  const orphanSource = String(
    jobRow?.makemkvInfo?.source
    || pipeline?.context?.source
    || pipeline?.context?.importSource
    || ''
  ).trim().toLowerCase();
  const isOrphanImport = orphanSource === 'orphan_raw_import';
  const isOrphanCancelled = isOrphanImport && (state === 'ERROR' || state === 'CANCELLED');
  const jobStatusUpper = String(jobRow?.status || state || '').trim().toUpperCase();
  const jobLastStateUpper = String(jobRow?.last_state || '').trim().toUpperCase();
  const jobErrorMessageLower = String(
    jobRow?.error_message
    || pipeline?.context?.errorMessage
    || ''
  ).trim().toLowerCase();
  const ripCompleted = Boolean(
    Number(jobRow?.rip_successful || jobRow?.ripSuccessful || pipeline?.context?.ripSuccessful || 0) === 1
    || jobRow?.raw_path
    || pipeline?.context?.rawPath
    || jobRow?.makemkvInfo?.rawPath
    || String(jobRow?.makemkvInfo?.status || '').trim().toUpperCase() === 'SUCCESS'
  );
  const selectedMetadata = pipeline?.context?.selectedMetadata || null;
  const analyzeContext = jobRow?.makemkvInfo?.analyzeContext && typeof jobRow.makemkvInfo.analyzeContext === 'object'
    ? jobRow.makemkvInfo.analyzeContext
    : null;
  const mediaInfoReview = pipeline?.context?.mediaInfoReview || null;
  const playlistAnalysis = pipeline?.context?.playlistAnalysis || null;
  const encodeInputPath = pipeline?.context?.inputPath || mediaInfoReview?.encodeInputPath || null;
  const reviewMode = String(mediaInfoReview?.mode || '').trim().toLowerCase();
  const isPreRipReview = reviewMode === 'pre_rip' || Boolean(mediaInfoReview?.preRip);
  const jobMediaProfile = resolvePipelineMediaProfile(pipeline, mediaInfoReview);
  const hasReviewRecoverableRaw = Boolean(
    !['converter', 'audiobook'].includes(String(jobMediaProfile || '').trim().toLowerCase())
    && ripCompleted
    && (
      jobRow?.raw_path
      || pipeline?.context?.rawPath
      || jobRow?.makemkvInfo?.rawPath
    )
  );
  const retryRipRecoveryRequired = Boolean(
    !running
    && retryJobId
    && typeof onRetry === 'function'
    && !queueLocked
    && !isOrphanCancelled
    && !hasReviewRecoverableRaw
    && ['ERROR', 'CANCELLED'].includes(jobStatusUpper)
    && (
      ['RIPPING', 'CD_RIPPING'].includes(jobLastStateUpper)
      || (
        jobErrorMessageLower.includes('server-neustart')
        && !hasReviewRecoverableRaw
      )
      || jobErrorMessageLower.includes('rip ist unvollständig')
      || jobErrorMessageLower.includes('rip-validierung fehlgeschlagen')
    )
  );
  const blockMetadataAndReviewForRipRetry = retryRipRecoveryRequired;
  const discTypeLabel = jobMediaProfile === 'bluray' ? 'Blu-ray' : 'DVD';
  const isDiscTitleSelectionRequired = Boolean(
    (jobMediaProfile === 'dvd' || jobMediaProfile === 'bluray')
    && (mediaInfoReview?.titleSelectionRequired || mediaInfoReview?.handBrakeTitleDecisionRequired)
  );
  const [liveJobLog, setLiveJobLog] = useState('');
  const [selectedEncodeTitleId, setSelectedEncodeTitleId] = useState(null);
  const [selectedEncodeTitleIds, setSelectedEncodeTitleIds] = useState([]);
  const [titleSelectionTouched, setTitleSelectionTouched] = useState(false);
  const [selectedPlaylistId, setSelectedPlaylistId] = useState(null);
  const [selectedHandBrakeTitleIdsState, setSelectedHandBrakeTitleIdsState] = useState([]);
  const [trackSelectionByTitle, setTrackSelectionByTitle] = useState({});
  const [episodeAssignmentsByTitle, setEpisodeAssignmentsByTitle] = useState({});
  const [selectedEpisodeFillStart, setSelectedEpisodeFillStart] = useState(null);
  const [containerUsedEpisodeKeys, setContainerUsedEpisodeKeys] = useState([]);
  const [containerSeasonEpisodes, setContainerSeasonEpisodes] = useState([]);
  const [multipartComparisonReviews, setMultipartComparisonReviews] = useState([]);
  const [settingsMap, setSettingsMap] = useState({});
  const [presetDisplayMap, setPresetDisplayMap] = useState({});
  const [scriptCatalog, setScriptCatalog] = useState([]);
  const [chainCatalog, setChainCatalog] = useState([]);
  // Unified ordered lists: [{type: 'script'|'chain', id: number}]
  const [preEncodeItems, setPreEncodeItems] = useState([]);
  const [postEncodeItems, setPostEncodeItems] = useState([]);
  const [userPresets, setUserPresets] = useState([]);
  const [selectedUserPresetId, setSelectedUserPresetId] = useState(null);
  const [handBrakePresetOptions, setHandBrakePresetOptions] = useState([]);
  const [selectedHandBrakePreset, setSelectedHandBrakePreset] = useState('');
  const [presetSelectionExplicitlyCleared, setPresetSelectionExplicitlyCleared] = useState(false);
  const [selectedOutputFormat, setSelectedOutputFormat] = useState('mkv');
  const [converterConfigSaving, setConverterConfigSaving] = useState(false);
  const [converterConfigError, setConverterConfigError] = useState(null);
  const converterConfigLatestRef = useRef(null);
  const converterConfigSaveTimeoutRef = useRef(null);
  const selectedMetadataEpisodes = useMemo(() => {
    const metadataEpisodes = Array.isArray(selectedMetadata?.episodes) && selectedMetadata.episodes.length > 0
      ? selectedMetadata.episodes
      : (Array.isArray(containerSeasonEpisodes) ? containerSeasonEpisodes : []);
    const rows = Array.isArray(metadataEpisodes) ? metadataEpisodes : [];
    const normalizedRows = rows
      .map((item) => {
        const episodeId = Number(item?.id ?? item?.episodeId ?? 0);
        const episodeIdStart = Number(item?.episodeIdStart ?? item?.idStart ?? item?.id ?? item?.episodeId ?? 0);
        const episodeIdEnd = Number(item?.episodeIdEnd ?? item?.idEnd ?? 0);
        const episodeNumberStart = Number(
          item?.episodeNumberStart
          ?? item?.numberStart
          ?? item?.episodeNoStart
          ?? item?.number
          ?? item?.episodeNumber
          ?? 0
        );
        const episodeNumberEnd = Number(
          item?.episodeNumberEnd
          ?? item?.numberEnd
          ?? item?.episodeNoEnd
          ?? 0
        );
        const episodeSpan = Number(item?.episodeSpan ?? item?.episodeCount ?? 0);
        const episodeNumber = Number(item?.number ?? item?.episodeNumber ?? episodeNumberStart ?? 0);
        const seasonNumber = Number(item?.seasonNumber ?? item?.season ?? 0);
        const title = String(item?.name || item?.title || '').trim();
        return {
          episodeId: Number.isFinite(episodeId) && episodeId > 0 ? Math.trunc(episodeId) : null,
          episodeIdStart: Number.isFinite(episodeIdStart) && episodeIdStart > 0 ? Math.trunc(episodeIdStart) : null,
          episodeIdEnd: Number.isFinite(episodeIdEnd) && episodeIdEnd > 0 ? Math.trunc(episodeIdEnd) : null,
          episodeNumber: Number.isFinite(episodeNumber) && episodeNumber > 0 ? Math.trunc(episodeNumber) : null,
          episodeNumberStart: Number.isFinite(episodeNumberStart) && episodeNumberStart > 0 ? Math.trunc(episodeNumberStart) : null,
          episodeNumberEnd: Number.isFinite(episodeNumberEnd) && episodeNumberEnd > 0 ? Math.trunc(episodeNumberEnd) : null,
          episodeSpan: Number.isFinite(episodeSpan) && episodeSpan > 0 ? Math.trunc(episodeSpan) : null,
          seasonNumber: Number.isFinite(seasonNumber) && seasonNumber > 0 ? Math.trunc(seasonNumber) : null,
          episodeTitle: title || null
        };
      })
      .filter((item) => item.episodeId || item.episodeNumber !== null)
      .sort((a, b) => {
        const aSeason = Number.isFinite(a.seasonNumber) ? a.seasonNumber : Number.MAX_SAFE_INTEGER;
        const bSeason = Number.isFinite(b.seasonNumber) ? b.seasonNumber : Number.MAX_SAFE_INTEGER;
        if (aSeason !== bSeason) {
          return aSeason - bSeason;
        }
        const aEpisode = Number.isFinite(a.episodeNumber) ? a.episodeNumber : Number.MAX_SAFE_INTEGER;
        const bEpisode = Number.isFinite(b.episodeNumber) ? b.episodeNumber : Number.MAX_SAFE_INTEGER;
        if (aEpisode !== bEpisode) {
          return aEpisode - bEpisode;
        }
        const aId = Number.isFinite(a.episodeId) ? a.episodeId : Number.MAX_SAFE_INTEGER;
        const bId = Number.isFinite(b.episodeId) ? b.episodeId : Number.MAX_SAFE_INTEGER;
        return aId - bId;
      });
    if (!Array.isArray(containerUsedEpisodeKeys) || containerUsedEpisodeKeys.length === 0) {
      return normalizedRows;
    }
    const usedKeySet = new Set(containerUsedEpisodeKeys);
    return normalizedRows.filter((episode) => {
      const keys = collectEpisodeReferenceKeys(episode);
      if (keys.length === 0) {
        return true;
      }
      return keys.every((key) => !usedKeySet.has(key));
    });
  }, [selectedMetadata?.episodes, containerSeasonEpisodes, containerUsedEpisodeKeys]);

  useEffect(() => {
    let cancelled = false;
    const loadSettings = async () => {
      try {
        const [settingsResponse, presetsResponse, scriptsResponse, chainsResponse, userPresetsResponse] = await Promise.allSettled([
          api.getSettings(),
          api.getHandBrakePresets(),
          api.getScripts(),
          api.getScriptChains(),
          api.getUserPresets(null, { forceRefresh: true })
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
          setHandBrakePresetOptions(Array.isArray(presetOptions) ? presetOptions : []);
          const scripts = scriptsResponse.status === 'fulfilled'
            ? (Array.isArray(scriptsResponse.value?.scripts) ? scriptsResponse.value.scripts : [])
            : [];
          setScriptCatalog(
            scripts.map((item) => ({
              id: item?.id,
              name: item?.name
            }))
          );
          const chains = chainsResponse.status === 'fulfilled'
            ? (Array.isArray(chainsResponse.value?.chains) ? chainsResponse.value.chains : [])
            : [];
          setChainCatalog(chains.map((item) => ({ id: item?.id, name: item?.name })));
          const allUserPresets = userPresetsResponse.status === 'fulfilled'
            ? (Array.isArray(userPresetsResponse.value?.presets) ? userPresetsResponse.value.presets : [])
            : [];
          setUserPresets(allUserPresets);
        }
      } catch (_error) {
        if (!cancelled) {
          setSettingsMap({});
          setPresetDisplayMap({});
          setScriptCatalog([]);
          setChainCatalog([]);
          setUserPresets([]);
          setHandBrakePresetOptions([]);
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
    const reviewTitles = Array.isArray(mediaInfoReview?.titles) ? mediaInfoReview.titles : [];
    const selectedFromReview = normalizeTitleIdList([
      ...(Array.isArray(mediaInfoReview?.selectedTitleIds) ? mediaInfoReview.selectedTitleIds : []),
      ...reviewTitles.filter((title) => Boolean(title?.selectedForEncode)).map((title) => title?.id),
      ...(fromReview ? [fromReview] : [])
    ]);
    const isSeriesVideoByMetadata = Boolean(
      (jobMediaProfile === 'dvd' || jobMediaProfile === 'bluray')
      && (
        hasSeriesMetadataShape(selectedMetadata)
        || hasSeriesMetadataShape(mediaInfoReview?.selectedMetadata)
        || hasSeriesEpisodeAssignmentHints(reviewTitles)
        || Boolean(mediaInfoReview?.seriesBatchParent)
      )
    );
    const defaultAllTitles = Boolean(
      (
        mediaInfoReview?.titleSelectionRequired
        || mediaInfoReview?.handBrakeTitleDecisionRequired
        || (isSeriesVideoByMetadata && reviewTitles.length > 1)
      )
      && reviewTitles.length > 0
    );
    const effectiveSelected = defaultAllTitles
      ? normalizeTitleIdList(reviewTitles.map((title) => title?.id))
      : selectedFromReview;
    setTitleSelectionTouched(false);
    setSelectedEncodeTitleIds(effectiveSelected);
    setSelectedEncodeTitleId(effectiveSelected[0] || fromReview || null);
    setTrackSelectionByTitle(buildDefaultTrackSelection(mediaInfoReview));
    const initialEpisodeAssignments = {};
    const allReviewTitles = Array.isArray(reviewTitles) ? reviewTitles : [];
    for (const title of reviewTitles) {
      const titleId = normalizeTitleId(title?.id);
      if (!titleId) {
        continue;
      }
      const episodeId = Number(title?.episodeId || 0);
      const episodeNumber = Number(title?.episodeNumber || 0);
      const seasonNumber = Number(title?.seasonNumber || 0);
      const rawEpisodeTitle = String(title?.episodeTitle || '').trim();
      const titleEpisodeRange = resolveEffectiveEpisodeRangeForTitle(
        title,
        title,
        allReviewTitles,
        titleId
      );
      const episodeTitle = rawEpisodeTitle
        ? normalizeEpisodeTitleForOutput(rawEpisodeTitle, titleEpisodeRange)
        : '';
      if (!episodeTitle && !episodeId && !episodeNumber && !seasonNumber) {
        continue;
      }
      initialEpisodeAssignments[titleId] = {
        episodeId: Number.isFinite(episodeId) && episodeId > 0 ? Math.trunc(episodeId) : null,
        episodeNumber: Number.isFinite(episodeNumber) && episodeNumber > 0 ? Math.trunc(episodeNumber) : null,
        seasonNumber: Number.isFinite(seasonNumber) && seasonNumber > 0 ? Math.trunc(seasonNumber) : null,
        episodeTitle: episodeTitle || null
      };
    }
    setEpisodeAssignmentsByTitle(initialEpisodeAssignments);
    setSelectedEpisodeFillStart(null);
    const normChain = (raw) => (Array.isArray(raw) ? raw : []).map(Number).filter((id) => Number.isFinite(id) && id > 0);
    setPreEncodeItems([
      ...normalizeScriptIdList(mediaInfoReview?.preEncodeScriptIds || []).map((id) => ({ type: 'script', id })),
      ...normChain(mediaInfoReview?.preEncodeChainIds).map((id) => ({ type: 'chain', id }))
    ]);
    setPostEncodeItems([
      ...normalizeScriptIdList(mediaInfoReview?.postEncodeScriptIds || []).map((id) => ({ type: 'script', id })),
      ...normChain(mediaInfoReview?.postEncodeChainIds).map((id) => ({ type: 'chain', id }))
    ]);
    const nextOutputFormat = String(mediaInfoReview?.outputFormat || 'mkv').trim().toLowerCase() || 'mkv';
    setSelectedOutputFormat(nextOutputFormat);
    const userPresetId = Number(mediaInfoReview?.userPreset?.id);
    const settingsPresetName = String(mediaInfoReview?.selectors?.preset || '').trim();
    setPresetSelectionExplicitlyCleared(false);
    if (Number.isFinite(userPresetId) && userPresetId > 0) {
      setSelectedUserPresetId(Math.trunc(userPresetId));
      setSelectedHandBrakePreset('');
    } else {
      setSelectedUserPresetId(null);
      const hbPresetName = String(
        mediaInfoReview?.userPreset?.handbrakePreset
        || settingsPresetName
        || ''
      ).trim();
      setSelectedHandBrakePreset(hbPresetName);
    }
  }, [
    mediaInfoReview?.encodeInputTitleId,
    mediaInfoReview?.generatedAt,
    mediaInfoReview?.reviewConfirmedAt,
    mediaInfoReview?.prefilledFromPreviousRunAt,
    mediaInfoReview?.outputFormat,
    mediaInfoReview?.userPreset?.id,
    mediaInfoReview?.userPreset?.handbrakePreset,
    mediaInfoReview?.selectors?.preset,
    selectedMetadata?.seasonNumber,
    selectedMetadata?.episodes,
    selectedMetadata?.metadataProvider,
    jobMediaProfile,
    retryJobId
  ]);

  useEffect(() => {
    if (mediaInfoReview) {
      return;
    }
    setTitleSelectionTouched(false);
    setSelectedEncodeTitleIds([]);
    setSelectedEncodeTitleId(null);
    setTrackSelectionByTitle({});
    setEpisodeAssignmentsByTitle({});
    setSelectedEpisodeFillStart(null);
    setPreEncodeItems([]);
    setPostEncodeItems([]);
    setSelectedUserPresetId(null);
    setSelectedHandBrakePreset('');
    setPresetSelectionExplicitlyCleared(false);
  }, [mediaInfoReview, retryJobId]);

  const resolveEffectiveSelectedTitleIds = (reviewTitles = []) => {
    const normalizedReviewTitles = Array.isArray(reviewTitles) ? reviewTitles : [];
    const explicitSelectedIds = normalizeTitleIdList(selectedEncodeTitleIds);
    if (titleSelectionTouched) {
      return explicitSelectedIds;
    }
    const fallbackSelectedIds = normalizeTitleIdList([
      ...explicitSelectedIds,
      selectedEncodeTitleId,
      mediaInfoReview?.encodeInputTitleId,
      ...normalizedReviewTitles.filter((title) => Boolean(title?.selectedForEncode)).map((title) => title?.id)
    ]);
    const selectedTitleIdsInReviewOrder = normalizedReviewTitles
      .map((title) => normalizeTitleId(title?.id))
      .filter((id) => id !== null && fallbackSelectedIds.includes(id));
    return selectedTitleIdsInReviewOrder.length > 0
      ? selectedTitleIdsInReviewOrder
      : fallbackSelectedIds;
  };

  useEffect(() => {
    const normalizedSelectedIds = normalizeTitleIdList(selectedEncodeTitleIds);
    const primaryTitleId = normalizeTitleId(selectedEncodeTitleId);
    if (normalizedSelectedIds.length === 0) {
      if (primaryTitleId !== null) {
        setSelectedEncodeTitleId(null);
      }
      return;
    }
    if (!primaryTitleId || !normalizedSelectedIds.includes(primaryTitleId)) {
      setSelectedEncodeTitleId(normalizedSelectedIds[0]);
    }
    setTrackSelectionByTitle((prev) => {
      const defaults = buildDefaultTrackSelection(mediaInfoReview);
      let next = prev;
      let changed = false;
      for (const titleId of normalizedSelectedIds) {
        if (next?.[titleId] || next?.[String(titleId)]) {
          continue;
        }
        const fallback = defaults[titleId] || {
          audioTrackIds: [],
          subtitleTrackIds: [],
          subtitleVariantSelection: {},
          subtitleLanguageOrder: []
        };
        if (!changed) {
          next = { ...(prev || {}) };
          changed = true;
        }
        next[titleId] = fallback;
      }
      return changed ? next : prev;
    });
  }, [selectedEncodeTitleId, selectedEncodeTitleIds, mediaInfoReview?.generatedAt]);

  const resolveEpisodeFillContext = () => {
    const episodeRows = Array.isArray(selectedMetadataEpisodes) ? selectedMetadataEpisodes : [];
    const reviewTitles = Array.isArray(mediaInfoReview?.titles) ? mediaInfoReview.titles : [];
    const selectedTitleIds = resolveEffectiveSelectedTitleIds(reviewTitles);
    const orderedTitles = reviewTitles
      .map((title) => ({
        id: normalizeTitleId(title?.id),
        title
      }))
      .filter((row) => row.id !== null);
    const orderedSelectedTitleRows = selectedTitleIds.length > 0
      ? orderedTitles.filter((row) => selectedTitleIds.includes(row.id))
      : [];
    const fallbackSelectedTitleRows = orderedSelectedTitleRows.length > 0
      ? orderedSelectedTitleRows
      : orderedTitles.filter((row) => selectedTitleIds.includes(row.id));
    return {
      episodeRows,
      reviewTitles,
      selectedTitleIds,
      fallbackSelectedTitleRows
    };
  };

  const buildGroupedEpisodeUnits = (episodeRows = [], selectedTitleRows = [], reviewTitles = []) => {
    const rows = Array.isArray(episodeRows) ? episodeRows : [];
    const selectedRows = Array.isArray(selectedTitleRows) ? selectedTitleRows : [];
    const allReviewTitles = Array.isArray(reviewTitles) ? reviewTitles : [];
    const normalizeEpisodeStart = (episode) => normalizePositiveInt(
      episode?.episodeNumberStart
      ?? episode?.episodeNoStart
      ?? episode?.episodeNumber
      ?? null
    );
    const normalizeEpisodeEnd = (episode, fallbackStart = null) => {
      const start = normalizePositiveInt(fallbackStart);
      const explicitEnd = normalizePositiveInt(
        episode?.episodeNumberEnd
        ?? episode?.episodeNoEnd
        ?? null
      );
      if (explicitEnd && (!start || explicitEnd >= start)) {
        return explicitEnd;
      }
      const explicitSpan = normalizePositiveInt(
        episode?.episodeSpan
        ?? episode?.episodeCount
        ?? null
      );
      if (start && explicitSpan && explicitSpan > 1) {
        return start + explicitSpan - 1;
      }
      return start;
    };
    const titleAnchorsByEpisodeIndex = new Map();
    if (rows.length > 0) {
      let episodeAnchorCursor = 0;
      for (const selectedTitleRow of selectedRows) {
        if (episodeAnchorCursor >= rows.length) {
          break;
        }
        const explicitSpan = normalizePositiveInt(
          selectedTitleRow?.title?.episodeSpan
          ?? selectedTitleRow?.title?.episodeCount
          ?? null
        );
        const estimatedSpan = estimateSeriesEpisodeSpanForTitle(selectedTitleRow?.title, allReviewTitles);
        const span = Math.max(1, explicitSpan || 1, estimatedSpan || 1);
        const safeSpan = Math.max(1, Math.min(span, rows.length - episodeAnchorCursor));
        titleAnchorsByEpisodeIndex.set(episodeAnchorCursor, { span: safeSpan });
        episodeAnchorCursor += safeSpan;
      }
    }

    const groupedEpisodeUnits = [];
    let sourceEpisodeIndex = 0;
    while (sourceEpisodeIndex < rows.length) {
      const startRow = rows[sourceEpisodeIndex];
      const rangeStart = normalizeEpisodeStart(startRow)
        ?? normalizePositiveInt(startRow?.episodeNumber)
        ?? null;
      const explicitRangeEnd = normalizeEpisodeEnd(startRow, rangeStart);
      const explicitRangeSpan = (
        rangeStart
        && explicitRangeEnd
        && explicitRangeEnd >= rangeStart
      )
        ? Math.max(1, Math.trunc(explicitRangeEnd - rangeStart + 1))
        : 1;

      if (explicitRangeSpan > 1) {
        groupedEpisodeUnits.push({
          startRow,
          endRow: startRow,
          rangeStart,
          rangeEnd: explicitRangeEnd || rangeStart,
          consumedRows: 1
        });
        sourceEpisodeIndex += 1;
        continue;
      }

      const anchor = titleAnchorsByEpisodeIndex.get(sourceEpisodeIndex) || null;
      const anchorSpan = normalizePositiveInt(anchor?.span) || 1;
      if (anchorSpan > 1) {
        const endIndex = Math.min(rows.length - 1, sourceEpisodeIndex + anchorSpan - 1);
        const endRow = rows[endIndex] || startRow;
        const endRowStart = normalizeEpisodeStart(endRow)
          ?? normalizePositiveInt(endRow?.episodeNumber)
          ?? null;
        const rangeEnd = (
          rangeStart
          && endRowStart
          && endRowStart >= rangeStart
        )
          ? endRowStart
          : (rangeStart ? (rangeStart + anchorSpan - 1) : endRowStart);
        groupedEpisodeUnits.push({
          startRow,
          endRow,
          rangeStart,
          rangeEnd,
          consumedRows: anchorSpan
        });
        sourceEpisodeIndex += anchorSpan;
        continue;
      }

      groupedEpisodeUnits.push({
        startRow,
        endRow: startRow,
        rangeStart,
        rangeEnd: rangeStart,
        consumedRows: 1
      });
      sourceEpisodeIndex += 1;
    }

    return groupedEpisodeUnits;
  };

  const applyEpisodeFillFrom = (startEpisodeRef = null) => {
    const { episodeRows, reviewTitles, selectedTitleIds, fallbackSelectedTitleRows } = resolveEpisodeFillContext();
    if (episodeRows.length === 0 || selectedTitleIds.length === 0) {
      return;
    }
    if (fallbackSelectedTitleRows.length === 0) {
      return;
    }
    const rawFillRef = String(startEpisodeRef || '').trim();
    const normalizedRefMatch = rawFillRef.match(/^fill:([^:]+):title:\d+$/i);
    const normalizedRef = normalizedRefMatch && normalizedRefMatch[1]
      ? String(normalizedRefMatch[1]).trim()
      : rawFillRef;

    const groupedEpisodeUnits = buildGroupedEpisodeUnits(
      episodeRows,
      fallbackSelectedTitleRows,
      reviewTitles
    );

    let startUnitIndex = 0;
    if (normalizedRef) {
      const foundUnitIndex = groupedEpisodeUnits.findIndex((unit) =>
        String(unit?.startRow?.episodeIdStart || '') === normalizedRef
        || String(unit?.startRow?.episodeId || '') === normalizedRef
        || String(unit?.startRow?.episodeNumberStart || '') === normalizedRef
        || String(unit?.startRow?.episodeNumber || '') === normalizedRef
      );
      if (foundUnitIndex >= 0) {
        startUnitIndex = foundUnitIndex;
      }
    }

    const nextAssignments = {};
    let unitCursor = startUnitIndex;

    fallbackSelectedTitleRows.forEach((row) => {
      const titleId = row.id;
      const unit = groupedEpisodeUnits[unitCursor];
      if (!unit || !titleId) {
        return;
      }
      const startRow = unit.startRow || null;
      const endRow = unit.endRow || startRow;
      const rangeStart = normalizePositiveInt(unit?.rangeStart)
        ?? normalizeEpisodeStart(startRow)
        ?? normalizePositiveInt(startRow?.episodeNumber)
        ?? null;
      let rangeEnd = normalizePositiveInt(unit?.rangeEnd)
        ?? normalizeEpisodeStart(endRow)
        ?? normalizePositiveInt(endRow?.episodeNumber)
        ?? rangeStart;
      if (rangeStart && rangeEnd && rangeEnd < rangeStart) {
        rangeEnd = rangeStart;
      }
      const normalizedSpan = (
        rangeStart
        && rangeEnd
        && rangeEnd >= rangeStart
      )
        ? Math.max(1, Math.trunc(rangeEnd - rangeStart + 1))
        : Math.max(1, normalizePositiveInt(unit?.consumedRows) || 1);
      const rangeToken = buildEpisodeRangeToken(
        rangeStart,
        rangeEnd
      );
      const assignmentRange = {
        start: rangeStart,
        end: rangeEnd,
        span: normalizedSpan,
        isMulti: normalizedSpan > 1
      };
      const episodeTitleRaw = String(startRow?.episodeTitle || '').trim();
      const endEpisodeTitleRaw = String(endRow?.episodeTitle || '').trim();
      const titleSource = episodeTitleRaw || endEpisodeTitleRaw;
      const mergedTitle = titleSource
        ? normalizeEpisodeTitleForOutput(titleSource, assignmentRange)
        : null;
      const episodeIdStart = normalizePositiveInt(
        startRow?.episodeIdStart
        ?? startRow?.episodeId
        ?? null
      );
      const endRowEpisodeId = normalizePositiveInt(
        endRow?.episodeIdStart
        ?? endRow?.episodeId
        ?? null
      );
      const explicitEpisodeIdEnd = normalizePositiveInt(startRow?.episodeIdEnd ?? null);
      const episodeIdEnd = endRowEpisodeId || explicitEpisodeIdEnd || episodeIdStart || null;
      nextAssignments[titleId] = {
        episodeId: episodeIdStart,
        episodeNumber: rangeStart,
        seasonNumber: startRow?.seasonNumber ?? null,
        episodeTitle: mergedTitle,
        episodeIdStart: episodeIdStart,
        episodeIdEnd,
        episodeNumberStart: rangeStart,
        episodeNumberEnd: rangeEnd,
        episodeSpan: normalizedSpan,
        episodeRange: rangeToken,
        episodeTitleStart: episodeTitleRaw || null,
        episodeTitleEnd: endEpisodeTitleRaw || episodeTitleRaw || null
      };
      unitCursor += 1;
    });
    setEpisodeAssignmentsByTitle((prev) => ({
      ...(prev && typeof prev === 'object' ? prev : {}),
      ...nextAssignments
    }));
  };

  const episodeFillOptions = useMemo(() => {
    const { episodeRows, reviewTitles, fallbackSelectedTitleRows } = resolveEpisodeFillContext();
    if (!Array.isArray(episodeRows) || episodeRows.length === 0) {
      return [];
    }
    const groupedUnits = buildGroupedEpisodeUnits(episodeRows, fallbackSelectedTitleRows, reviewTitles);
    return groupedUnits
      .map((unit) => {
        const startRow = unit?.startRow || null;
        const value = startRow?.episodeIdStart
          || startRow?.episodeId
          || startRow?.episodeNumberStart
          || startRow?.episodeNumber
          || null;
        if (!value) {
          return null;
        }
        return {
          value: String(value),
          startRef: String(value)
        };
      })
      .filter(Boolean);
  }, [selectedMetadataEpisodes, selectedEncodeTitleIds, mediaInfoReview?.titles, mediaInfoReview?.selectedTitleIds]);

  useEffect(() => {
    if (!Array.isArray(selectedMetadataEpisodes) || selectedMetadataEpisodes.length === 0) {
      return;
    }
    if (!Array.isArray(episodeFillOptions) || episodeFillOptions.length === 0) {
      return;
    }
    const normalizedSelection = String(selectedEpisodeFillStart || '').trim();
    const hasValidSelection = Boolean(
      normalizedSelection
      && episodeFillOptions.some((option) => String(option?.value || '').trim() === normalizedSelection)
    );
    const defaultStartRef = hasValidSelection
      ? normalizedSelection
      : (episodeFillOptions[0]?.value || episodeFillOptions[0]?.startRef || null);
    if (!defaultStartRef) {
      return;
    }
    if (!hasValidSelection) {
      setSelectedEpisodeFillStart(String(defaultStartRef));
      // Keep dropdown + episodentitel in sync when options change (e.g. Disc 2
      // after already used episodes were loaded from the container).
      applyEpisodeFillFrom(defaultStartRef);
      return;
    }

    const reviewTitles = Array.isArray(mediaInfoReview?.titles) ? mediaInfoReview.titles : [];
    const effectiveSelectedTitleIds = resolveEffectiveSelectedTitleIds(reviewTitles);

    const hasEpisodeAssignmentPayload = (assignment) => {
      if (!assignment || typeof assignment !== 'object') {
        return false;
      }
      const episodeId = Number(assignment?.episodeId || assignment?.episodeIdStart || 0);
      const episodeNumber = Number(assignment?.episodeNumber || assignment?.episodeNumberStart || 0);
      const seasonNumber = Number(assignment?.seasonNumber || 0);
      const episodeTitle = String(assignment?.episodeTitle || '').trim();
      return Boolean(episodeTitle || episodeId > 0 || episodeNumber > 0 || seasonNumber > 0);
    };

    const hasAnyEpisodeAssignment = effectiveSelectedTitleIds.some((titleId) => {
      const assignment = episodeAssignmentsByTitle?.[titleId]
        || episodeAssignmentsByTitle?.[String(titleId)]
        || null;
      return hasEpisodeAssignmentPayload(assignment);
    });
    const hasCompleteEpisodeAssignments = effectiveSelectedTitleIds.length > 0
      && effectiveSelectedTitleIds.every((titleId) => {
        const assignment = episodeAssignmentsByTitle?.[titleId]
          || episodeAssignmentsByTitle?.[String(titleId)]
          || null;
        return hasEpisodeAssignmentPayload(assignment);
      });

    if (hasCompleteEpisodeAssignments) {
      return;
    }
    if (hasAnyEpisodeAssignment && normalizedSelection) {
      return;
    }
    applyEpisodeFillFrom(defaultStartRef);
  }, [
    selectedMetadataEpisodes,
    selectedEncodeTitleIds,
    selectedEncodeTitleId,
    mediaInfoReview?.titles,
    mediaInfoReview?.encodeInputTitleId,
    mediaInfoReview?.generatedAt,
    episodeAssignmentsByTitle,
    episodeFillOptions,
    selectedEpisodeFillStart
  ]);

  const reviewPlaylistDecisionRequired = Boolean(mediaInfoReview?.playlistDecisionRequired);
  const hasSelectedEncodeTitle = normalizeTitleIdList(selectedEncodeTitleIds).length > 0;
  const canConfirmReview = !reviewPlaylistDecisionRequired || hasSelectedEncodeTitle;
  const trimmedHandBrakePreset = String(selectedHandBrakePreset || '').trim();
  const settingsPresetFallback = String(mediaInfoReview?.selectors?.preset || '').trim();
  const settingsExtraArgsFallback = String(mediaInfoReview?.selectors?.extraArgs || '').trim();
  const hasSelectedPreset = Boolean(selectedUserPresetId) || Boolean(trimmedHandBrakePreset);
  const hasSettingsPresetForValidation = !presetSelectionExplicitlyCleared && Boolean(settingsPresetFallback);
  const hasEffectiveSelectedPreset = hasSelectedPreset
    || hasSettingsPresetForValidation
    || Boolean(settingsExtraArgsFallback);
  const converterMediaType = String(mediaInfoReview?.converterMediaType || 'video').trim().toLowerCase() || 'video';
  const showConverterConfig = jobMediaProfile === 'converter' && converterMediaType !== 'audio';
  const requiresPresetSelection = showConverterConfig || jobMediaProfile === 'dvd' || jobMediaProfile === 'bluray';
  const multipartSettingsLock = mediaInfoReview?.multipartSettingsLock
    && typeof mediaInfoReview.multipartSettingsLock === 'object'
    ? mediaInfoReview.multipartSettingsLock
    : null;
  const multipartSettingsLocked = Boolean(
    multipartSettingsLock?.enabled
    && state === 'READY_TO_ENCODE'
  );
  const multipartLockSourceJobId = normalizeJobId(multipartSettingsLock?.sourceJobId);
  const multipartLockSourceDiscNumber = Number.isFinite(Number(multipartSettingsLock?.sourceDiscNumber))
    && Number(multipartSettingsLock.sourceDiscNumber) > 0
    ? Math.trunc(Number(multipartSettingsLock.sourceDiscNumber))
    : null;
  const allowReviewSelectionEdit = !queueLocked && !multipartSettingsLocked;
  const allowTitleSelectionInReview = (
    (state === 'READY_TO_ENCODE' || state === 'WAITING_FOR_USER_DECISION')
    && allowReviewSelectionEdit
  );
  const allowTrackSelectionInReview = state === 'READY_TO_ENCODE' && allowReviewSelectionEdit;
  const allowEncodeItemSelectionInReview = state === 'READY_TO_ENCODE' && allowReviewSelectionEdit;
  const alternativeTitleSelection = mediaInfoReview?.alternativeTitleSelection
    && typeof mediaInfoReview.alternativeTitleSelection === 'object'
    ? mediaInfoReview.alternativeTitleSelection
    : null;
  const hasAlternativeTitleSelection = Boolean(
    alternativeTitleSelection?.enabled
    && Array.isArray(mediaInfoReview?.titles)
    && mediaInfoReview.titles.length > 1
  );

  // Filter user presets by job media profile ('all' presets always shown)
  const filteredUserPresets = (Array.isArray(userPresets) ? userPresets : []).filter((p) => {
    const presetMediaType = normalizeMediaProfile(p?.mediaType) || 'all';
    if (!jobMediaProfile) {
      return true;
    }
    // Converter jobs may reuse any user preset; do not restrict by preset media type here.
    if (jobMediaProfile === 'converter') {
      return true;
    }
    return presetMediaType === 'all' || presetMediaType === jobMediaProfile;
  });
  const effectiveUserPresets = filteredUserPresets;
  const canStartReadyJob = (isPreRipReview
    ? Boolean(retryJobId)
    : Boolean(retryJobId && encodeInputPath))
    && (!requiresPresetSelection || hasEffectiveSelectedPreset);
  const canRestartEncodeFromLastSettings = Boolean(
    (state === 'ERROR' || state === 'CANCELLED')
    && retryJobId
    && pipeline?.context?.canRestartEncodeFromLastSettings
  );
  const canCancelReview = Boolean(
    !running
    && retryJobId
    && (state === 'READY_TO_ENCODE' || state === 'WAITING_FOR_USER_DECISION')
  );
  const canRestartReviewFromRaw = Boolean(
    retryJobId
    && !running
    && !blockMetadataAndReviewForRipRetry
    && (pipeline?.context?.canRestartReviewFromRaw || pipeline?.context?.rawPath)
  );
  const allowConverterConfigEdit = showConverterConfig && allowReviewSelectionEdit && state === 'READY_TO_ENCODE';

  const converterConfigPayload = useMemo(() => {
    if (!showConverterConfig) {
      return null;
    }
    let userPreset = null;
    if (selectedUserPresetId) {
      const preset = (Array.isArray(userPresets) ? userPresets : [])
        .find((p) => Number(p?.id) === Number(selectedUserPresetId));
      userPreset = preset
        ? { id: preset.id, handbrakePreset: preset.handbrake_preset || null, extraArgs: preset.extra_args || '' }
        : { id: selectedUserPresetId };
    } else if (trimmedHandBrakePreset) {
      userPreset = { handbrakePreset: trimmedHandBrakePreset, extraArgs: '' };
    }
    return {
      converterMediaType,
      outputFormat: selectedOutputFormat,
      userPreset
    };
  }, [
    showConverterConfig,
    converterMediaType,
    selectedOutputFormat,
    selectedUserPresetId,
    trimmedHandBrakePreset,
    userPresets
  ]);

  const converterConfigSerialized = useMemo(
    () => (converterConfigPayload ? JSON.stringify(converterConfigPayload) : null),
    [converterConfigPayload]
  );

  useEffect(() => {
    converterConfigLatestRef.current = null;
    setConverterConfigError(null);
    setConverterConfigSaving(false);
  }, [retryJobId]);

  useEffect(() => {
    if (!allowConverterConfigEdit || !converterConfigPayload || !retryJobId) {
      return;
    }
    if (converterConfigLatestRef.current === null) {
      converterConfigLatestRef.current = converterConfigSerialized;
      return;
    }
    if (converterConfigSerialized === converterConfigLatestRef.current) {
      return;
    }
    if (converterConfigSaveTimeoutRef.current) {
      clearTimeout(converterConfigSaveTimeoutRef.current);
    }
    converterConfigSaveTimeoutRef.current = setTimeout(async () => {
      setConverterConfigSaving(true);
      setConverterConfigError(null);
      try {
        await api.converterUpdateJobConfig(retryJobId, converterConfigPayload);
        converterConfigLatestRef.current = converterConfigSerialized;
        onInputsChanged?.(retryJobId, converterConfigPayload);
      } catch (error) {
        setConverterConfigError(error?.message || 'Konfiguration konnte nicht gespeichert werden.');
      } finally {
        setConverterConfigSaving(false);
      }
    }, 650);
    return () => {
      if (converterConfigSaveTimeoutRef.current) {
        clearTimeout(converterConfigSaveTimeoutRef.current);
        converterConfigSaveTimeoutRef.current = null;
      }
    };
  }, [
    allowConverterConfigEdit,
    converterConfigPayload,
    converterConfigSerialized,
    retryJobId,
    onInputsChanged
  ]);

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
        const durationSecondsRaw = Number(item?.durationSeconds ?? item?.duration ?? 0);
        const durationSeconds = Number.isFinite(durationSecondsRaw) && durationSecondsRaw > 0
          ? Math.trunc(durationSecondsRaw)
          : 0;
        const durationLabelRaw = String(item?.durationLabel || '').trim();
        const durationLabel = durationLabelRaw || formatDurationClock(durationSeconds);
        return {
          playlistId,
          playlistFile,
          titleId: Number.isFinite(Number(item?.titleId)) ? Number(item.titleId) : null,
          durationSeconds,
          durationLabel: durationLabel || null,
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
  const alternativeTitleOptions = useMemo(() => {
    if (!hasAlternativeTitleSelection) {
      return [];
    }
    const titles = Array.isArray(mediaInfoReview?.titles) ? mediaInfoReview.titles : [];
    return titles
      .map((title) => {
        const titleId = normalizeTitleId(title?.id);
        if (!titleId) {
          return null;
        }
        const playlistFile = String(title?.playlistFile || '').trim();
        const durationLabel = formatDurationClock(title?.durationSeconds) || null;
        const parts = [
          playlistFile || `Titel #${titleId}`,
          durationLabel
        ].filter(Boolean);
        return {
          value: titleId,
          label: parts.join(' | ')
        };
      })
      .filter(Boolean)
      .sort((left, right) => Number(left.value) - Number(right.value));
  }, [hasAlternativeTitleSelection, mediaInfoReview?.titles]);

  const handBrakeTitleDecisionRequired = state === 'WAITING_FOR_USER_DECISION'
    && Boolean(pipeline?.context?.handBrakeTitleDecisionRequired);
  const handBrakeDecisionMode = String(pipeline?.context?.handBrakeDecisionMode || '').trim().toLowerCase();
  const isSeriesPlayAllDecisionMode = handBrakeDecisionMode === 'series_playall_or_double';
  const handBrakeDecisionSummary = pipeline?.context?.handBrakeDecisionSummary
    && typeof pipeline.context.handBrakeDecisionSummary === 'object'
    ? pipeline.context.handBrakeDecisionSummary
    : null;
  const ambiguousLongestTitleId = normalizeTitleId(handBrakeDecisionSummary?.longestCandidateTitleId);
  const handBrakeDecisionCandidateTitleIds = useMemo(() => normalizeTitleIdList(
    (Array.isArray(pipeline?.context?.handBrakeTitleCandidates)
      ? pipeline.context.handBrakeTitleCandidates
      : []
    ).map((item) => item?.handBrakeTitleId)
  ), [pipeline?.context?.handBrakeTitleCandidates]);
  const handBrakeDecisionSelectableTitleIds = useMemo(() => {
    const explicit = normalizeTitleIdList(pipeline?.context?.handBrakeDecisionSelectableTitleIds);
    if (explicit.length > 0) {
      return explicit;
    }
    if (isSeriesPlayAllDecisionMode && ambiguousLongestTitleId) {
      return [ambiguousLongestTitleId];
    }
    return handBrakeDecisionCandidateTitleIds;
  }, [
    isSeriesPlayAllDecisionMode,
    ambiguousLongestTitleId,
    handBrakeDecisionCandidateTitleIds,
    pipeline?.context?.handBrakeDecisionSelectableTitleIds
  ]);
  const handBrakeDecisionSelectableTitleIdSet = useMemo(
    () => new Set(handBrakeDecisionSelectableTitleIds.map((id) => Number(id))),
    [handBrakeDecisionSelectableTitleIds]
  );

  const waitingHandBrakeTitleRows = useMemo(() => {
    const rawCandidates = Array.isArray(pipeline?.context?.handBrakeTitleCandidates)
      ? pipeline.context.handBrakeTitleCandidates
      : [];
    const rawAllTitles = isSeriesPlayAllDecisionMode && Array.isArray(pipeline?.context?.handBrakeAllTitles)
      ? pipeline.context.handBrakeAllTitles
      : [];
    const sourceRows = rawAllTitles.length > 0 ? rawAllTitles : rawCandidates;
    const candidateIdSet = new Set(
      normalizeTitleIdList(rawCandidates.map((item) => item?.handBrakeTitleId)).map((id) => Number(id))
    );
    return sourceRows
      .map((item) => {
        const titleId = normalizeTitleId(item?.handBrakeTitleId);
        if (!titleId) {
          return null;
        }
        const durationSeconds = Number(item?.durationSeconds || 0);
        const minutes = Math.floor(durationSeconds / 60);
        const seconds = durationSeconds % 60;
        const durationLabel = `${minutes}:${String(seconds).padStart(2, '0')} min`;
        return {
          handBrakeTitleId: Math.trunc(titleId),
          durationSeconds,
          durationLabel,
          durationMinutes: Number(item?.durationMinutes || 0),
          audioTrackCount: Number(item?.audioTrackCount || 0),
          subtitleTrackCount: Number(item?.subtitleTrackCount || 0),
          sizeBytes: Number(item?.sizeBytes || 0),
          decisionCandidate: candidateIdSet.has(Number(titleId))
        };
      })
      .filter(Boolean)
      .sort((a, b) => a.handBrakeTitleId - b.handBrakeTitleId);
  }, [
    isSeriesPlayAllDecisionMode,
    pipeline?.context?.handBrakeAllTitles,
    pipeline?.context?.handBrakeTitleCandidates
  ]);
  const visibleWaitingHandBrakeTitleRows = useMemo(() => {
    if (!isSeriesPlayAllDecisionMode) {
      return waitingHandBrakeTitleRows;
    }
    return waitingHandBrakeTitleRows.filter((row) => row.decisionCandidate);
  }, [isSeriesPlayAllDecisionMode, waitingHandBrakeTitleRows]);

  useEffect(() => {
    if (!handBrakeTitleDecisionRequired) {
      setSelectedHandBrakeTitleIdsState([]);
      return;
    }
    const contextSelectedIds = Array.isArray(pipeline?.context?.selectedHandBrakeTitleIds)
      ? pipeline.context.selectedHandBrakeTitleIds
      : [];
    const normalizedContextIds = contextSelectedIds
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value) && value > 0)
      .map((value) => Math.trunc(value));
    if (normalizedContextIds.length > 0) {
      setSelectedHandBrakeTitleIdsState(Array.from(new Set(normalizedContextIds)));
      return;
    }
    const singleContextId = Number(pipeline?.context?.selectedHandBrakeTitleId || 0);
    if (Number.isFinite(singleContextId) && singleContextId > 0) {
      setSelectedHandBrakeTitleIdsState([Math.trunc(singleContextId)]);
      return;
    }
    if (isSeriesPlayAllDecisionMode) {
      const lockedDefaultIds = waitingHandBrakeTitleRows
        .filter((row) => row.decisionCandidate && !handBrakeDecisionSelectableTitleIdSet.has(Number(row.handBrakeTitleId)))
        .map((row) => row.handBrakeTitleId);
      if (lockedDefaultIds.length > 0) {
        setSelectedHandBrakeTitleIdsState(normalizeTitleIdList(lockedDefaultIds));
        return;
      }
    }
    const firstSelectable = waitingHandBrakeTitleRows.find((row) => (
      !isSeriesPlayAllDecisionMode || handBrakeDecisionSelectableTitleIdSet.has(Number(row.handBrakeTitleId))
    ))?.handBrakeTitleId || null;
    setSelectedHandBrakeTitleIdsState(firstSelectable ? [firstSelectable] : []);
  }, [
    handBrakeTitleDecisionRequired,
    isSeriesPlayAllDecisionMode,
    retryJobId,
    handBrakeDecisionSelectableTitleIdSet,
    waitingHandBrakeTitleRows,
    pipeline?.context?.selectedHandBrakeTitleId,
    pipeline?.context?.selectedHandBrakeTitleIds
  ]);

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

  const seriesBatchRunningChildJobIdHint = useMemo(() => {
    const seriesBatch = pipeline?.context?.seriesBatch;
    if (!seriesBatch || typeof seriesBatch !== 'object') {
      return null;
    }
    const children = Array.isArray(seriesBatch?.children) ? seriesBatch.children : [];
    const runningChild = children.find((child) => normalizeSeriesBatchStatus(child?.status) === 'RUNNING') || null;
    return normalizeJobId(runningChild?.jobId);
  }, [pipeline?.context?.seriesBatch]);

  useEffect(() => {
    if (!running || !retryJobId) {
      setLiveJobLog('');
      return undefined;
    }
    let cancelled = false;
    const refresh = async () => {
      try {
        const response = await api.getJob(retryJobId, { includeLiveLog: true, lite: true });
        if (!cancelled) {
          const liveJob = response?.job && typeof response.job === 'object'
            ? response.job
            : null;
          const childRows = Array.isArray(liveJob?.children) ? liveJob.children : [];
          const liveHintChildId = normalizeJobId(seriesBatchRunningChildJobIdHint);
          const isSeriesBatchParentRun = Boolean(
            liveHintChildId
            || liveJob?.encodePlan?.seriesBatchParent
            || String(liveJob?.handbrakeInfo?.mode || '').trim().toLowerCase() === 'series_batch'
          );

          if (isSeriesBatchParentRun) {
            const activeChildStates = new Set(['ANALYZING', 'RIPPING', 'MEDIAINFO_CHECK', 'ENCODING', 'RUNNING']);
            let activeChild = liveHintChildId
              ? (childRows.find((child) => normalizeJobId(child?.id) === liveHintChildId) || null)
              : null;
            if (activeChild) {
              const hintChildStatus = String(activeChild?.status || activeChild?.last_state || '').trim().toUpperCase();
              if (!activeChildStates.has(hintChildStatus)) {
                activeChild = null;
              }
            }
            if (!activeChild) {
              activeChild = childRows.find((child) => (
                activeChildStates.has(String(child?.status || child?.last_state || '').trim().toUpperCase())
              )) || null;
            }
            setLiveJobLog(String(activeChild?.log || '').trim());
            return;
          }

          setLiveJobLog(String(liveJob?.log || '').trim());
        }
      } catch (_err) {
        if (_err?.status === 404) {
          cancelled = true;
          setLiveJobLog('');
          return;
        }
        // ignore transient polling errors
      }
    };
    void refresh();
    const interval = setInterval(refresh, 2500);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [running, retryJobId, seriesBatchRunningChildJobIdHint]);

  const manualDecisionState = pipeline?.context?.manualDecisionState || null;
  const rawDecisionRequiredBeforeStart = state === 'WAITING_FOR_USER_DECISION' && manualDecisionState === 'waiting_for_raw_decision';
  const rawDecisionOptions = pipeline?.context?.rawDecisionOptions && typeof pipeline.context.rawDecisionOptions === 'object'
    ? pipeline.context.rawDecisionOptions
    : null;
  const rawDecisionAllowsMultipartMergeWithOrphan = Boolean(
    rawDecisionRequiredBeforeStart
    && rawDecisionOptions?.allowMultipartMergeWithOrphan
  );
  const rawDecisionOrphanDiscNumber = normalizePositiveInt(rawDecisionOptions?.orphanDiscNumber);
  const rawDecisionCurrentDiscNumber = normalizePositiveInt(rawDecisionOptions?.currentDiscNumber);
  const playlistDecisionRequiredBeforeStart = state === 'WAITING_FOR_USER_DECISION' && !handBrakeTitleDecisionRequired && !rawDecisionRequiredBeforeStart;
  const isSeriesDvdReview = useMemo(() => {
    if (jobMediaProfile !== 'dvd' && jobMediaProfile !== 'bluray') {
      return false;
    }
    return Boolean(
      hasSeriesMetadataShape(selectedMetadata)
      || hasSeriesMetadataShape(mediaInfoReview?.selectedMetadata)
      || hasSeriesEpisodeAssignmentHints(mediaInfoReview?.titles)
      || Boolean(mediaInfoReview?.seriesBatchParent)
    );
  }, [
    jobMediaProfile,
    selectedMetadata?.seasonNumber,
    selectedMetadata?.episodes,
    selectedMetadata?.metadataProvider,
    selectedMetadata?.workflowKind,
    mediaInfoReview?.selectedMetadata?.seasonNumber,
    mediaInfoReview?.selectedMetadata?.episodes,
    mediaInfoReview?.selectedMetadata?.metadataProvider,
    mediaInfoReview?.selectedMetadata?.workflowKind,
    mediaInfoReview?.titles,
    mediaInfoReview?.seriesBatchParent
  ]);
  const discWorkflowKind = resolveDiscWorkflowKind({
    mediaProfile: jobMediaProfile,
    selectedMetadata,
    analyzeContext,
    pipelineContext: pipeline?.context || null,
    fallbackIsSeries: isSeriesDvdReview
  });
  const discWorkflowBadgeLabel = getDiscWorkflowBadgeLabel(jobMediaProfile, discWorkflowKind);
  useEffect(() => {
    let cancelled = false;

    const loadContainerUsedEpisodes = async () => {
      if (!isSeriesDvdReview || !retryJobId) {
        if (!cancelled) {
          setContainerUsedEpisodeKeys([]);
          setContainerSeasonEpisodes([]);
        }
        return;
      }

      try {
        const currentResponse = await api.getJob(retryJobId, { lite: true, forceRefresh: true });
        if (cancelled) {
          return;
        }
        const currentJob = currentResponse?.job && typeof currentResponse.job === 'object'
          ? currentResponse.job
          : null;
        const currentJobId = normalizeJobId(currentJob?.id || retryJobId);
        const normalizedCurrentKind = String(currentJob?.job_kind || '').trim().toLowerCase();
        const containerJobId = normalizedCurrentKind === 'dvd_series_container'
          ? normalizeJobId(currentJob?.id)
          : normalizeJobId(currentJob?.parent_job_id);

        if (!containerJobId) {
          if (!cancelled) {
            setContainerUsedEpisodeKeys([]);
            setContainerSeasonEpisodes([]);
          }
          return;
        }

        const containerResponse = await api.getJob(containerJobId, { lite: true, forceRefresh: true });
        if (cancelled) {
          return;
        }
        const containerJob = containerResponse?.job && typeof containerResponse.job === 'object'
          ? containerResponse.job
          : null;
        const children = Array.isArray(containerJob?.children) ? containerJob.children : [];
        const usedKeys = new Set();
        const extractEpisodesFromJob = (jobRow) => {
          const mkInfo = jobRow?.makemkvInfo && typeof jobRow.makemkvInfo === 'object'
            ? jobRow.makemkvInfo
            : {};
          const analyzeContext = mkInfo?.analyzeContext && typeof mkInfo.analyzeContext === 'object'
            ? mkInfo.analyzeContext
            : {};
          const selectedFromAnalyze = analyzeContext?.selectedMetadata && typeof analyzeContext.selectedMetadata === 'object'
            ? analyzeContext.selectedMetadata
            : {};
          const selectedFromRoot = mkInfo?.selectedMetadata && typeof mkInfo.selectedMetadata === 'object'
            ? mkInfo.selectedMetadata
            : {};
          const episodes = Array.isArray(selectedFromAnalyze?.episodes)
            ? selectedFromAnalyze.episodes
            : (Array.isArray(selectedFromRoot?.episodes) ? selectedFromRoot.episodes : []);
          return Array.isArray(episodes) ? episodes : [];
        };
        let fallbackEpisodes = extractEpisodesFromJob(containerJob);

        for (const child of children) {
          const childId = normalizeJobId(child?.id);
          if (currentJobId && childId && currentJobId === childId) {
            continue;
          }
          if (isSeriesBatchEpisodePlan(child?.encodePlan)) {
            continue;
          }

          const refs = collectEpisodeReferencesFromPlan(child?.encodePlan);
          for (const ref of refs) {
            const keys = collectEpisodeReferenceKeys(ref);
            for (const key of keys) {
              usedKeys.add(key);
            }
          }

          const batchEpisodes = Array.isArray(child?.handbrakeInfo?.seriesBatch?.episodes)
            ? child.handbrakeInfo.seriesBatch.episodes
            : [];
          for (const episode of batchEpisodes) {
            const keys = collectEpisodeReferenceKeys({
              episodeId: episode?.episodeId,
              episodeNumber: episode?.episodeNumber,
              seasonNumber: episode?.seasonNumber
            });
            for (const key of keys) {
              usedKeys.add(key);
            }
          }

          if ((!Array.isArray(fallbackEpisodes) || fallbackEpisodes.length === 0)) {
            const childEpisodes = extractEpisodesFromJob(child);
            if (Array.isArray(childEpisodes) && childEpisodes.length > 0) {
              fallbackEpisodes = childEpisodes;
            }
          }
        }

        if (!cancelled) {
          setContainerUsedEpisodeKeys(Array.from(usedKeys));
          setContainerSeasonEpisodes(Array.isArray(fallbackEpisodes) ? fallbackEpisodes : []);
        }
      } catch (_error) {
        if (!cancelled) {
          setContainerUsedEpisodeKeys([]);
          setContainerSeasonEpisodes([]);
        }
      }
    };

    void loadContainerUsedEpisodes();
    return () => {
      cancelled = true;
    };
  }, [
    isSeriesDvdReview,
    retryJobId,
    mediaInfoReview?.generatedAt,
    mediaInfoReview?.reviewConfirmedAt,
    selectedMetadata?.tmdbId,
    selectedMetadata?.seasonNumber
  ]);

  useEffect(() => {
    let cancelled = false;

    const parseEncodePlanCandidate = (value) => {
      if (value && typeof value === 'object') {
        return value;
      }
      if (typeof value !== 'string') {
        return null;
      }
      try {
        const parsed = JSON.parse(value);
        return parsed && typeof parsed === 'object' ? parsed : null;
      } catch (_error) {
        return null;
      }
    };

    const loadMultipartComparisonReviews = async () => {
      if (!retryJobId) {
        if (!cancelled) {
          setMultipartComparisonReviews([]);
        }
        return;
      }

      try {
        const currentResponse = await api.getJob(retryJobId, { lite: true, forceRefresh: true });
        if (cancelled) {
          return;
        }
        const currentJob = currentResponse?.job && typeof currentResponse.job === 'object'
          ? currentResponse.job
          : null;
        const currentJobId = normalizeJobId(currentJob?.id || retryJobId);
        const normalizedCurrentKind = String(currentJob?.job_kind || '').trim().toLowerCase();
        const currentIsMultipart = normalizedCurrentKind === 'multipart_movie_container'
          || normalizedCurrentKind === 'multipart_movie_child'
          || Number(currentJob?.is_multipart_movie || currentJob?.isMultipartMovie || 0) === 1;
        if (!currentIsMultipart) {
          if (!cancelled) {
            setMultipartComparisonReviews([]);
          }
          return;
        }
        const containerJobId = normalizedCurrentKind === 'multipart_movie_container'
          ? normalizeJobId(currentJob?.id)
          : normalizeJobId(currentJob?.parent_job_id);

        if (!containerJobId) {
          if (!cancelled) {
            setMultipartComparisonReviews([]);
          }
          return;
        }

        const containerResponse = await api.getJob(containerJobId, { lite: true, forceRefresh: true });
        if (cancelled) {
          return;
        }
        const containerJob = containerResponse?.job && typeof containerResponse.job === 'object'
          ? containerResponse.job
          : null;
        const children = Array.isArray(containerJob?.children) ? containerJob.children : [];
        const comparisonRows = children
          .map((child) => {
            const childId = normalizeJobId(child?.id);
            if (!childId || (currentJobId && currentJobId === childId)) {
              return null;
            }
            const childKind = String(child?.job_kind || '').trim().toLowerCase();
            const isMultipartChild = childKind === 'multipart_movie_child'
              || Number(child?.is_multipart_movie || child?.isMultipartMovie || 0) === 1;
            if (!isMultipartChild) {
              return null;
            }
            const encodePlan = parseEncodePlanCandidate(child?.encodePlan || child?.encode_plan_json);
            if (!encodePlan || !Array.isArray(encodePlan?.titles) || encodePlan.titles.length === 0) {
              return null;
            }
            const discNumberRaw = Number(
              child?.disc_number
              ?? child?.discNumber
              ?? encodePlan?.discNumber
              ?? 0
            );
            const discNumber = Number.isFinite(discNumberRaw) && discNumberRaw > 0
              ? Math.trunc(discNumberRaw)
              : null;
            return {
              jobId: childId,
              discNumber,
              review: encodePlan
            };
          })
          .filter(Boolean)
          .sort((left, right) => {
            const leftDisc = Number.isFinite(left?.discNumber) ? left.discNumber : Number.MAX_SAFE_INTEGER;
            const rightDisc = Number.isFinite(right?.discNumber) ? right.discNumber : Number.MAX_SAFE_INTEGER;
            if (leftDisc !== rightDisc) {
              return leftDisc - rightDisc;
            }
            return Number(left?.jobId || 0) - Number(right?.jobId || 0);
          });

        if (!cancelled) {
          setMultipartComparisonReviews(comparisonRows);
        }
      } catch (_error) {
        if (!cancelled) {
          setMultipartComparisonReviews([]);
        }
      }
    };

    void loadMultipartComparisonReviews();
    return () => {
      cancelled = true;
    };
  }, [retryJobId, mediaInfoReview?.generatedAt, mediaInfoReview?.reviewConfirmedAt]);

  const seriesBatchContext = useMemo(() => {
    const raw = pipeline?.context?.seriesBatch;
    if (!raw || typeof raw !== 'object') {
      return null;
    }
    const rawChildren = Array.isArray(raw?.children) ? raw.children : [];
    const children = rawChildren.map((child, index) => {
      const status = normalizeSeriesBatchStatus(child?.status);
      return {
        jobId: normalizeJobId(child?.jobId),
        title: String(child?.title || '').trim() || `Episode #${index + 1}`,
        status,
        progress: normalizeSeriesBatchProgress(child?.progress, status === 'FINISHED' ? 100 : 0),
        eta: child?.eta ?? null,
        episodeIndex: normalizePositiveInt(child?.episodeIndex),
        titleId: normalizeTitleId(child?.titleId)
      };
    });
    const totalCountRaw = Number(raw?.totalCount || 0);
    const totalCount = Number.isFinite(totalCountRaw) && totalCountRaw > 0
      ? Math.trunc(totalCountRaw)
      : children.length;
    const finishedCountRaw = Number(raw?.finishedCount || 0);
    const cancelledCountRaw = Number(raw?.cancelledCount || 0);
    const errorCountRaw = Number(raw?.errorCount || 0);
    const runningCountRaw = Number(raw?.runningCount || 0);
    const finishedCount = Number.isFinite(finishedCountRaw) ? Math.max(0, Math.trunc(finishedCountRaw)) : 0;
    const cancelledCount = Number.isFinite(cancelledCountRaw) ? Math.max(0, Math.trunc(cancelledCountRaw)) : 0;
    const errorCount = Number.isFinite(errorCountRaw) ? Math.max(0, Math.trunc(errorCountRaw)) : 0;
    const runningCount = Number.isFinite(runningCountRaw) ? Math.max(0, Math.trunc(runningCountRaw)) : 0;
    const aggregateProgress = totalCount > 0
      ? (
        children.reduce((sum, child) => {
          const status = normalizeSeriesBatchStatus(child?.status);
          if (status === 'FINISHED') {
            return sum + 100;
          }
          return sum + normalizeSeriesBatchProgress(child?.progress, 0);
        }, 0) / totalCount
      )
      : 0;
    const overallProgress = normalizeSeriesBatchProgress(raw?.overallProgress, aggregateProgress);
    return {
      totalCount,
      finishedCount,
      cancelledCount,
      errorCount,
      runningCount,
      overallProgress,
      children
    };
  }, [pipeline?.context?.seriesBatch]);
  const hasSeriesBatchProgress = Boolean(
    seriesBatchContext
    && (seriesBatchContext.totalCount > 0 || seriesBatchContext.children.length > 0)
  );
  const runningSeriesEpisode = hasSeriesBatchProgress
    ? (seriesBatchContext.children.find((child) => normalizeSeriesBatchStatus(child?.status) === 'RUNNING') || null)
    : null;
  const primaryProgressValue = hasSeriesBatchProgress
    ? normalizeSeriesBatchProgress(seriesBatchContext?.overallProgress, progress)
    : progress;
  const primaryEta = hasSeriesBatchProgress
    ? (runningSeriesEpisode?.eta || pipeline?.eta || null)
    : (pipeline?.eta || null);
  const primaryStatusText = hasSeriesBatchProgress
    ? (
      `Serien-Encoding ${formatPercentNoDecimals(primaryProgressValue)}`
      + `${runningSeriesEpisode?.title ? ` - ${runningSeriesEpisode.title}` : ''}`
    )
    : (pipeline?.statusText || 'Bereit');
  const showMediainfoIndeterminatePrimaryProgress = !hasSeriesBatchProgress
    && isMediainfoCheckStatus(state);
  const showIndeterminatePrimaryProgress = showMediainfoIndeterminatePrimaryProgress || (
    !hasSeriesBatchProgress
    && isPlaylistTrackPreparationStatus(pipeline?.statusText)
  );
  const ripIssueEntries = useMemo(
    () => extractMakeMkvRipIssues(jobRow?.makemkvInfo),
    [jobRow?.makemkvInfo]
  );
  const ripIssueVisibleEntries = ripIssueEntries.slice(0, 8);
  const hiddenRipIssueCount = Math.max(0, ripIssueEntries.length - ripIssueVisibleEntries.length);
  const ripIssueSummaryLabel = ripIssueEntries.length === 1
    ? '1 Rip-Fehler erkannt'
    : `${ripIssueEntries.length} Rip-Fehler erkannt`;
  const showRipIssueNotice = Boolean(
    (jobMediaProfile === 'dvd' || jobMediaProfile === 'bluray')
    && ripCompleted
    && ripIssueEntries.length > 0
    && !running
    && (
      state === 'WAITING_FOR_USER_DECISION'
      || state === 'READY_TO_ENCODE'
      || state === 'MEDIAINFO_CHECK'
      || Boolean(mediaInfoReview)
    )
  );
  const canTriggerRipRetry = Boolean(
    showRipIssueNotice
    && retryJobId
    && typeof onRetry === 'function'
    && !queueLocked
  );
  const isSeriesBatchParentReview = Boolean(
    mediaInfoReview?.seriesBatchParent
    || pipeline?.context?.mediaInfoReview?.seriesBatchParent
    || hasSeriesBatchProgress
  );
  const multipartDiscSuffixForCommandPreview = useMemo(() => resolveMultipartDiscSuffixForPreview({
    jobRow,
    pipeline,
    mediaInfoReview,
    selectedMetadata
  }), [jobRow, pipeline, mediaInfoReview, selectedMetadata]);
  const commandOutputPath = useMemo(() => {
    if (jobMediaProfile === 'converter') {
      const reviewWithOutput = mediaInfoReview
        ? { ...mediaInfoReview, outputFormat: selectedOutputFormat }
        : { outputFormat: selectedOutputFormat };
      return buildConverterOutputPathPreview(settingsMap, reviewWithOutput, selectedMetadata, retryJobId);
    }
    if (isSeriesDvdReview) {
      return null;
    }
    return buildOutputPathPreview(settingsMap, jobMediaProfile, selectedMetadata, retryJobId, {
      outputSuffix: multipartDiscSuffixForCommandPreview
    });
  }, [
    settingsMap,
    jobMediaProfile,
    mediaInfoReview,
    selectedMetadata,
    retryJobId,
    selectedOutputFormat,
    isSeriesDvdReview,
    multipartDiscSuffixForCommandPreview
  ]);
  const commandOutputPathByTitle = useMemo(() => {
    if (!isSeriesDvdReview) {
      return {};
    }
    const reviewTitles = Array.isArray(mediaInfoReview?.titles) ? mediaInfoReview.titles : [];
    const map = {};
    for (const title of reviewTitles) {
      const titleId = normalizeTitleId(title?.id);
      if (!titleId) {
        continue;
      }
      const assignment = episodeAssignmentsByTitle?.[titleId]
        || episodeAssignmentsByTitle?.[String(titleId)]
        || null;
      const path = buildDvdSeriesEpisodeOutputPathPreview(
        settingsMap,
        jobMediaProfile,
        selectedMetadata || {},
        title,
        assignment,
        retryJobId,
        Array.isArray(mediaInfoReview?.titles) ? mediaInfoReview.titles : [],
        episodeAssignmentsByTitle,
        selectedEncodeTitleIds
      );
      if (path) {
        map[titleId] = path;
      }
    }
    return map;
  }, [
    isSeriesDvdReview,
    mediaInfoReview?.titles,
    episodeAssignmentsByTitle,
    settingsMap,
    jobMediaProfile,
    selectedMetadata,
    retryJobId,
    selectedEncodeTitleIds
  ]);
  const multiEpisodeReviewWarnings = useMemo(() => {
    if (!isSeriesDvdReview) {
      return [];
    }
    const reviewTitles = Array.isArray(mediaInfoReview?.titles) ? mediaInfoReview.titles : [];
    if (reviewTitles.length === 0) {
      return [];
    }
    return reviewTitles
      .map((title) => {
        const titleId = normalizeTitleId(title?.id);
        if (!titleId) {
          return null;
        }
        const assignment = episodeAssignmentsByTitle?.[titleId]
          || episodeAssignmentsByTitle?.[String(titleId)]
          || null;
        const episodeRange = resolveEffectiveEpisodeRangeForTitle(
          assignment,
          title,
          reviewTitles,
          titleId
        );
        if (!episodeRange.isMulti) {
          return null;
        }
        const episodeRangeToken = buildEpisodeRangeToken(episodeRange.start, episodeRange.end);
        const partsToken = buildEpisodePartsToken(episodeRange);
        const rawTitle = String(
          assignment?.episodeTitle
          || title?.episodeTitle
          || title?.fileName
          || `Episode ${episodeRangeToken}`
        ).trim() || `Episode ${episodeRangeToken}`;
        const normalizedTitle = normalizeEpisodeTitleForOutput(rawTitle, episodeRange);
        const normalizedByHeuristic = normalizedTitle !== rawTitle;
        const listTitleRaw = String(title?.episodeTitle || '').trim();
        const normalizedListTitle = listTitleRaw
          ? normalizeEpisodeTitleForOutput(listTitleRaw, episodeRange)
          : '';
        const mismatchWithTitleList = Boolean(
          normalizedListTitle
          && normalizeEpisodeTitleTokenForCompare(normalizedTitle) !== normalizeEpisodeTitleTokenForCompare(normalizedListTitle)
        );
        return {
          titleId,
          episodeRangeToken,
          partsToken,
          rawTitle,
          normalizedTitle,
          normalizedByHeuristic,
          normalizedListTitle: normalizedListTitle || null,
          mismatchWithTitleList
        };
      })
      .filter(Boolean);
  }, [isSeriesDvdReview, mediaInfoReview?.titles, episodeAssignmentsByTitle]);
  const episodeRangeConflictWarnings = useMemo(() => {
    if (!isSeriesDvdReview) {
      return [];
    }
    const reviewTitles = Array.isArray(mediaInfoReview?.titles) ? mediaInfoReview.titles : [];
    if (reviewTitles.length === 0) {
      return [];
    }
    const metadataRows = (Array.isArray(selectedMetadataEpisodes) ? selectedMetadataEpisodes : [])
      .map((episode) => {
        const episodeNumber = normalizePositiveInt(
          episode?.episodeNumberStart
          ?? episode?.episodeNoStart
          ?? episode?.episodeNumber
          ?? episode?.number
          ?? null
        );
        const episodeTitle = String(
          episode?.episodeTitle
          || episode?.name
          || episode?.title
          || ''
        ).trim();
        return {
          episodeNumber,
          episodeTitle
        };
      })
      .filter((row) => row.episodeNumber);
    const titleAnchorSuggestionById = new Map();
    if (metadataRows.length > 0) {
      let cursor = 0;
      for (const title of reviewTitles) {
        const titleId = normalizeTitleId(title?.id);
        if (!titleId) {
          continue;
        }
        if (cursor >= metadataRows.length) {
          break;
        }
        const explicitSpan = normalizePositiveInt(
          title?.episodeSpan
          ?? title?.episodeCount
          ?? null
        );
        const estimatedSpan = estimateSeriesEpisodeSpanForTitle(title, reviewTitles);
        const span = Math.max(1, explicitSpan || 1, estimatedSpan || 1);
        const safeSpan = Math.max(1, Math.min(span, metadataRows.length - cursor));
        const spanRows = metadataRows.slice(cursor, cursor + safeSpan);
        const startNumber = normalizePositiveInt(spanRows[0]?.episodeNumber);
        const endNumber = normalizePositiveInt(spanRows[spanRows.length - 1]?.episodeNumber) || startNumber;
        const isMulti = Boolean(startNumber && endNumber && endNumber > startNumber);
        const sourceTitle = spanRows
          .map((row) => String(row?.episodeTitle || '').trim())
          .filter(Boolean)
          .join(' + ');
        const normalizedTitle = sourceTitle
          ? normalizeEpisodeTitleForOutput(
            sourceTitle,
            {
              start: startNumber || 1,
              end: endNumber || startNumber || 1,
              span: safeSpan,
              isMulti
            }
          )
          : '';
        titleAnchorSuggestionById.set(titleId, {
          suggestedTitle: normalizedTitle || '(ohne Titel)',
          isMulti
        });
        cursor += safeSpan;
      }
    }
    return reviewTitles
      .map((title) => {
        const titleId = normalizeTitleId(title?.id);
        if (!titleId) {
          return null;
        }
        const assignment = episodeAssignmentsByTitle?.[titleId]
          || episodeAssignmentsByTitle?.[String(titleId)]
          || null;
        if (!hasExplicitEpisodeAssignmentRange(assignment)) {
          return null;
        }
        const explicitRange = resolveEpisodeAssignmentRange(assignment, title, titleId);
        if (!explicitRange || explicitRange.isMulti) {
          return null;
        }
        const spanHint = estimateSeriesEpisodeSpanForTitle(title, reviewTitles);
        if (!Number.isFinite(spanHint) || spanHint <= 1) {
          return null;
        }
        const effectiveSpan = Math.max(1, Math.trunc(spanHint));
        const suggestedRange = {
          start: explicitRange.start,
          end: explicitRange.start + effectiveSpan - 1,
          span: effectiveSpan,
          isMulti: effectiveSpan > 1
        };
        const suggestedTitle = String(titleAnchorSuggestionById.get(titleId)?.suggestedTitle || '').trim();
        return {
          titleId,
          episodeTitle: String(
            assignment?.episodeTitle
            || title?.episodeTitle
            || title?.fileName
            || ''
          ).trim() || '(ohne Titel)',
          suggestedTitle: suggestedTitle || normalizeEpisodeTitleForOutput(
            String(assignment?.episodeTitle || title?.episodeTitle || '').trim() || '(ohne Titel)',
            suggestedRange
          )
        };
      })
      .filter(Boolean);
  }, [isSeriesDvdReview, mediaInfoReview?.titles, episodeAssignmentsByTitle, selectedMetadataEpisodes]);
  const episodeAssignmentWarningLines = useMemo(() => (
    episodeRangeConflictWarnings
      .map((item) => {
        const currentTitle = String(item?.episodeTitle || '').trim() || '(ohne Titel)';
        const suggestionTitle = String(item?.suggestedTitle || '').trim() || '(ohne Titel)';
        return `Titel ${item.titleId}: ${currentTitle} --> Vorschlag: ${suggestionTitle} (Heuristik vermutet Doppelfolge)`;
      })
      .filter(Boolean)
  ), [episodeRangeConflictWarnings]);
  const hasMultiEpisodeInJob = multiEpisodeReviewWarnings.length > 0 || episodeRangeConflictWarnings.length > 0;
  const presetDisplayValue = useMemo(() => {
    const preset = String(mediaInfoReview?.selectors?.preset || '').trim();
    if (!preset) {
      return '';
    }
    return presetDisplayMap[preset] || preset;
  }, [mediaInfoReview?.selectors?.preset, presetDisplayMap]);
  const converterUserPresetOptions = useMemo(() => {
    if (!showConverterConfig) {
      return [];
    }
    const userOptions = (Array.isArray(effectiveUserPresets) ? effectiveUserPresets : [])
      .map((preset) => ({
        label: String(preset?.name || '').trim(),
        value: Number(preset?.id)
      }))
      .filter((option) => option.label && Number.isFinite(option.value));
    return [{ label: 'Kein User-Preset', value: null }, ...userOptions];
  }, [showConverterConfig, effectiveUserPresets]);
  const converterHandBrakePresetOptions = useMemo(() => {
    if (!showConverterConfig) {
      return [];
    }
    const list = Array.isArray(handBrakePresetOptions) ? handBrakePresetOptions : [];
    const hbOptions = list
      .map((option) => {
        const label = String(option?.label || '').trim();
        if (!label) {
          return null;
        }
        const disabled = Boolean(option?.disabled);
        const lowerLabel = label.toLowerCase();
        if (lowerLabel.includes('handbrake cli') || lowerLabel.includes('cli default')) {
          return null;
        }
        if (!disabled && (lowerLabel.includes('kein preset') || lowerLabel.includes('cli-parameter'))) {
          return null;
        }
        const value = disabled
          ? String(option?.value || label)
          : String(option?.value || '').trim();
        if (!disabled && !value) {
          return null;
        }
        return {
          label,
          value,
          disabled
        };
      })
      .filter(Boolean);
    return [{ label: 'Kein HandBrake-Preset', value: '' }, ...hbOptions];
  }, [showConverterConfig, handBrakePresetOptions]);
  const buildSelectedTrackSelectionForCurrentTitle = () => {
    const reviewTitles = Array.isArray(mediaInfoReview?.titles) ? mediaInfoReview.titles : [];
    const titlesById = new Map(
      reviewTitles
        .map((title) => [normalizeTitleId(title?.id), title])
        .filter((entry) => entry[0] !== null)
    );
    const effectiveSelectedTitleIds = resolveEffectiveSelectedTitleIds(reviewTitles);
    const preferredPrimaryTitleId = normalizeTitleId(selectedEncodeTitleId)
      || normalizeTitleId(mediaInfoReview?.encodeInputTitleId)
      || null;
    const encodeTitleId = effectiveSelectedTitleIds.includes(preferredPrimaryTitleId)
      ? preferredPrimaryTitleId
      : (effectiveSelectedTitleIds[0] || null);
    const selectedTrackSelection = {};
    for (const titleId of effectiveSelectedTitleIds) {
      const selectionEntry = trackSelectionByTitle?.[titleId] || trackSelectionByTitle?.[String(titleId)] || null;
      const fallbackSelection = defaultTrackSelectionForTitle(mediaInfoReview, titleId);
      const effectiveSelection = selectionEntry || fallbackSelection;
      const encodeTitle = titlesById.get(titleId) || null;
      const blockedSubtitleTrackIds = new Set(
        (Array.isArray(encodeTitle?.subtitleTracks) ? encodeTitle.subtitleTracks : [])
          .filter((track) => isBurnedSubtitleTrack(track) || isDuplicateSubtitleTrack(track))
          .map((track) => normalizeTrackId(track?.id))
          .filter((id) => id !== null)
          .map((id) => String(id))
      );
      const availableSubtitleLanguages = new Set(
        (Array.isArray(encodeTitle?.subtitleTracks) ? encodeTitle.subtitleTracks : [])
          .filter((track) => !isBurnedSubtitleTrack(track) && !isDuplicateSubtitleTrack(track))
          .map((track) => normalizeSubtitleLanguage(track?.language || track?.languageLabel || 'und'))
      );
      const normalizedVariantSelection = normalizeSubtitleVariantSelectionMap(
        effectiveSelection?.subtitleVariantSelection || {}
      );
      const filteredVariantSelection = {};
      for (const [language, value] of Object.entries(normalizedVariantSelection)) {
        if (!availableSubtitleLanguages.has(language)) {
          continue;
        }
        filteredVariantSelection[language] = {
          full: Boolean(value?.full),
          forced: Boolean(value?.forced)
        };
      }
      const normalizedLanguageOrder = normalizeSubtitleLanguageOrder(effectiveSelection?.subtitleLanguageOrder || [])
        .filter((language) => availableSubtitleLanguages.has(language));
      const hasExplicitVariantSelection = Object.keys(filteredVariantSelection).length > 0;
      const filteredSubtitleTrackIds = normalizeTrackIdList(effectiveSelection?.subtitleTrackIds || [])
        .filter((id) => !blockedSubtitleTrackIds.has(String(id)));
      const subtitleSelectionMode = normalizeSubtitleSelectionMode(
        effectiveSelection?.subtitleSelectionMode,
        hasExplicitVariantSelection
          ? 'variants'
          : (filteredSubtitleTrackIds.length > 0 ? 'track_ids' : 'variants')
      );
      selectedTrackSelection[titleId] = {
        audioTrackIds: normalizeTrackIdList(effectiveSelection?.audioTrackIds || []),
        subtitleSelectionMode,
        subtitleTrackIds: subtitleSelectionMode === 'track_ids'
          ? filteredSubtitleTrackIds
          : (hasExplicitVariantSelection ? [] : filteredSubtitleTrackIds),
        ...(subtitleSelectionMode === 'variants'
          ? {
            subtitleVariantSelection: filteredVariantSelection,
            subtitleLanguageOrder: normalizedLanguageOrder
          }
          : {})
      };
    }
    const episodeAssignments = {};
    for (const titleId of effectiveSelectedTitleIds) {
      const assignment = episodeAssignmentsByTitle?.[titleId]
        || episodeAssignmentsByTitle?.[String(titleId)]
        || null;
      const title = titlesById.get(titleId) || null;
      const episodeId = Number(
        assignment?.episodeId
        || assignment?.episodeIdStart
        || title?.episodeId
        || 0
      );
      const episodeNumber = Number(
        assignment?.episodeNumber
        || assignment?.episodeNumberStart
        || title?.episodeNumber
        || 0
      );
      const seasonNumber = Number(assignment?.seasonNumber || title?.seasonNumber || 0);
      const episodeIdStart = Number(
        assignment?.episodeIdStart
        || assignment?.episodeId
        || 0
      );
      const episodeIdEnd = Number(
        assignment?.episodeIdEnd
        || 0
      );
      const episodeNumberStart = Number(
        assignment?.episodeNumberStart
        || assignment?.episodeNoStart
        || assignment?.episodeNumber
        || title?.episodeNumber
        || 0
      );
      const episodeNumberEnd = Number(
        assignment?.episodeNumberEnd
        || assignment?.episodeNoEnd
        || 0
      );
      const episodeSpanRaw = Number(assignment?.episodeSpan || assignment?.episodeCount || 0);
      const rawEpisodeTitle = String(assignment?.episodeTitle || title?.episodeTitle || '').trim();
      const normalizedEpisodeStart = Number.isFinite(episodeNumberStart) && episodeNumberStart > 0
        ? Math.trunc(episodeNumberStart)
        : (Number.isFinite(episodeNumber) && episodeNumber > 0 ? Math.trunc(episodeNumber) : null);
      const normalizedEpisodeEnd = Number.isFinite(episodeNumberEnd) && episodeNumberEnd > 0
        ? Math.trunc(episodeNumberEnd)
        : normalizedEpisodeStart;
      const normalizedEpisodeSpan = Number.isFinite(episodeSpanRaw) && episodeSpanRaw > 0
        ? Math.trunc(episodeSpanRaw)
        : (
          normalizedEpisodeStart && normalizedEpisodeEnd && normalizedEpisodeEnd >= normalizedEpisodeStart
            ? (normalizedEpisodeEnd - normalizedEpisodeStart + 1)
            : 1
        );
      const normalizedEpisodeRange = {
        start: normalizedEpisodeStart || 1,
        end: normalizedEpisodeEnd || normalizedEpisodeStart || 1,
        span: normalizedEpisodeSpan,
        isMulti: normalizedEpisodeSpan > 1
      };
      const normalizedEpisodeTitle = rawEpisodeTitle
        ? normalizeEpisodeTitleForOutput(rawEpisodeTitle, normalizedEpisodeRange)
        : '';
      if (!normalizedEpisodeTitle && !(episodeId > 0) && !(episodeNumber > 0) && !(seasonNumber > 0)) {
        continue;
      }
      const normalizedRangeToken = normalizedEpisodeStart
        ? buildEpisodeRangeToken(normalizedEpisodeStart, normalizedEpisodeEnd || normalizedEpisodeStart)
        : null;
      episodeAssignments[titleId] = {
        episodeId: Number.isFinite(episodeId) && episodeId > 0 ? Math.trunc(episodeId) : null,
        episodeNumber: Number.isFinite(episodeNumber) && episodeNumber > 0 ? Math.trunc(episodeNumber) : null,
        seasonNumber: Number.isFinite(seasonNumber) && seasonNumber > 0 ? Math.trunc(seasonNumber) : null,
        episodeTitle: normalizedEpisodeTitle || null,
        episodeIdStart: Number.isFinite(episodeIdStart) && episodeIdStart > 0 ? Math.trunc(episodeIdStart) : null,
        episodeIdEnd: Number.isFinite(episodeIdEnd) && episodeIdEnd > 0 ? Math.trunc(episodeIdEnd) : null,
        episodeNumberStart: normalizedEpisodeStart,
        episodeNumberEnd: normalizedEpisodeEnd || normalizedEpisodeStart,
        episodeSpan: normalizedEpisodeSpan,
        episodeRange: normalizedRangeToken,
        episodeTitleStart: String(assignment?.episodeTitleStart || '').trim() || null,
        episodeTitleEnd: String(assignment?.episodeTitleEnd || '').trim() || null
      };
    }
    const selectedPostScriptIds = postEncodeItems.filter((i) => i.type === 'script').map((i) => i.id);
    const selectedPreScriptIds = preEncodeItems.filter((i) => i.type === 'script').map((i) => i.id);
    const selectedPostChainIds = postEncodeItems.filter((i) => i.type === 'chain').map((i) => i.id);
    const selectedPreChainIds = preEncodeItems.filter((i) => i.type === 'chain').map((i) => i.id);
    return {
      encodeTitleId,
      selectedEncodeTitleIds: effectiveSelectedTitleIds,
      selectedTrackSelection: Object.keys(selectedTrackSelection).length > 0 ? selectedTrackSelection : null,
      episodeAssignments: Object.keys(episodeAssignments).length > 0 ? episodeAssignments : null,
      selectedPostScriptIds,
      selectedPreScriptIds,
      selectedPostChainIds,
      selectedPreChainIds,
      selectedHandBrakePreset: trimmedHandBrakePreset
    };
  };

  return (
    <Card title="Pipeline-Status" subTitle="Live-Zustand und Fortschritt">
      <div className="status-row">
        <Tag value={stateLabel} severity={getStatusSeverity(state)} />
        <span>{primaryStatusText}</span>
      </div>

      {running && (
        <div className="progress-wrap">
          {showIndeterminatePrimaryProgress ? (
            <ProgressBar mode="indeterminate" showValue={false} />
          ) : (
            <ProgressBar
              value={primaryProgressValue}
              showValue
              displayValueTemplate={(value) => formatPercentNoDecimals(value)}
            />
          )}
          <small>
            {showIndeterminatePrimaryProgress
              ? (showMediainfoIndeterminatePrimaryProgress ? 'Mediainfo-Prüfung läuft …' : 'Vorbereitung läuft …')
              : primaryEta
              ? (hasSeriesBatchProgress ? `ETA aktuelle Episode ${primaryEta}` : `ETA ${primaryEta}`)
              : 'ETA unbekannt'}
          </small>
        </div>
      )}

      {state === 'FINISHED' && (
        <div className="progress-wrap">
          <ProgressBar value={100} showValue />
        </div>
      )}

      {hasSeriesBatchProgress ? (
        <div className="series-batch-progress-wrap">
          <div className="series-batch-head">
            <strong>Serien-Encode Fortschritt</strong>
            <Tag
              value={`${seriesBatchContext.finishedCount}/${seriesBatchContext.totalCount || seriesBatchContext.children.length} fertig`}
              severity={seriesBatchContext.errorCount > 0 ? 'danger' : (seriesBatchContext.cancelledCount > 0 ? 'warning' : 'success')}
            />
          </div>
          <small>
            {`Laufend: ${seriesBatchContext.runningCount} | Fehler: ${seriesBatchContext.errorCount} | Abgebrochen: ${seriesBatchContext.cancelledCount}`}
          </small>
          <div className="series-batch-episodes">
            {seriesBatchContext.children.map((child, index) => (
              <div
                key={`series-batch-episode-${child.titleId || child.episodeIndex || index}`}
                className="series-batch-episode-row"
              >
                <div className="series-batch-episode-head">
                  <span className="series-batch-episode-title">{child.title}</span>
                  <Tag value={getStatusLabel(child.status)} severity={getSeriesBatchTagSeverity(child.status)} />
                </div>
                <ProgressBar value={child.progress} showValue={false} style={{ height: '5px' }} />
                <small>{child.eta ? `${formatPercentNoDecimals(child.progress)} | ETA ${child.eta}` : `${formatPercentNoDecimals(child.progress)}`}</small>
              </div>
            ))}
          </div>
        </div>
      ) : null}

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

            {(state === 'METADATA_SELECTION' || state === 'WAITING_FOR_USER_DECISION' || isOrphanCancelled)
              && retryJobId
              && typeof onOpenMetadata === 'function'
              && !blockMetadataAndReviewForRipRetry
              && !(jobMediaProfile === 'converter' && !selectedMetadata?.imdbId) ? (
              <Button
                label="Metadaten öffnen"
                icon="pi pi-list"
                severity="info"
                onClick={() => onOpenMetadata?.(retryJobId)}
                loading={busy}
              />
            ) : null}

            {state === 'METADATA_SELECTION' && jobMediaProfile === 'converter' && retryJobId ? (
              <Button
                label="Review starten"
                icon="pi pi-play"
                severity="info"
                onClick={() => onStart(retryJobId)}
                loading={busy}
              />
            ) : null}

            {!running
              && state !== 'METADATA_SELECTION'
              && state !== 'WAITING_FOR_USER_DECISION'
              && state !== 'IDLE'
              && state !== 'DISC_DETECTED'
              && retryJobId
              && typeof onReassignMetadata === 'function'
              && !isOrphanCancelled
              && !blockMetadataAndReviewForRipRetry
              && !(jobMediaProfile === 'converter' && state === 'READY_TO_START' && !selectedMetadata?.imdbId) ? (
              <Button
                label="Metadaten neu zuweisen"
                icon="pi pi-search"
                severity="info"
                size="small"
                onClick={() => onReassignMetadata?.(retryJobId)}
                loading={busy}
              />
            ) : null}

            {state === 'READY_TO_START' && retryJobId ? (
              <Button
                label={jobMediaProfile === 'converter' ? 'Review starten' : 'Job starten'}
                icon="pi pi-play"
                severity={jobMediaProfile === 'converter' ? 'info' : 'success'}
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

            {handBrakeTitleDecisionRequired && retryJobId && (
              <Button
                label={isSeriesPlayAllDecisionMode ? 'PlayAll/Doppelfolge bestätigen' : `${discTypeLabel} Titel bestätigen`}
                icon="pi pi-check"
                severity="warning"
                outlined
                onClick={() => onSelectHandBrakeTitle?.(retryJobId, selectedHandBrakeTitleIdsState)}
                loading={busy}
                disabled={selectedHandBrakeTitleIdsState.length === 0}
              />
            )}

            {state === 'READY_TO_ENCODE' && retryJobId ? (
              <Button
                label={isPreRipReview ? 'Backup + Encoding starten' : 'Encoding starten'}
                icon="pi pi-play"
                severity="success"
                onClick={async () => {
                  if (hasMultiEpisodeInJob) {
                    const introText = 'Im Job wurden Hinweise zur Episoden-Zuordnung erkannt. Bitte Episodentitel und Episodenbereich prüfen, bevor das Encoding startet.';
                    const rows = episodeAssignmentWarningLines;
                    const modalMessage = rows.length > 0
                      ? `${introText}\n\n${rows.join('\n')}`
                      : introText;
                    const confirmed = await confirmModal({
                      header: 'Episoden-Zuordnung prüfen',
                      message: modalMessage,
                      acceptLabel: 'Encoding starten',
                      rejectLabel: 'Abbrechen',
                      icon: 'pi pi-exclamation-triangle',
                      style: { width: '34rem', maxWidth: '92vw' },
                      breakpoints: {
                        '960px': '92vw',
                        '640px': '95vw'
                      }
                    });
                    if (!confirmed) {
                      return;
                    }
                  }
                  const {
                    encodeTitleId,
                    selectedEncodeTitleIds: selectedEncodeTitleIdsForPayload,
                    selectedTrackSelection,
                    episodeAssignments,
                    selectedPostScriptIds,
                    selectedPreScriptIds,
                    selectedPostChainIds,
                    selectedPreChainIds,
                    selectedHandBrakePreset
                  } = buildSelectedTrackSelectionForCurrentTitle();
                  const startPayload = {
                    ensureConfirmed: true,
                    selectedEncodeTitleId: encodeTitleId,
                    selectedEncodeTitleIds: selectedEncodeTitleIdsForPayload,
                    selectedTrackSelection,
                    episodeAssignments,
                    selectedPostEncodeScriptIds: selectedPostScriptIds,
                    selectedPreEncodeScriptIds: selectedPreScriptIds,
                    selectedPostEncodeChainIds: selectedPostChainIds,
                    selectedPreEncodeChainIds: selectedPreChainIds
                  };
                  startPayload.selectedUserPresetId = (
                    selectedUserPresetId !== null && selectedUserPresetId !== undefined
                      ? selectedUserPresetId
                      : null
                  );
                  startPayload.selectedHandBrakePreset = String(selectedHandBrakePreset || '').trim();
                  await onStart(retryJobId, startPayload);
                }}
                loading={busy}
                disabled={!canStartReadyJob || !canConfirmReview}
              />
            ) : null}

            {(running || canCancelReview) && (
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
              isSeriesBatchParentReview ? (
                <>
                  <Button
                    label="Alle neu starten"
                    icon="pi pi-play"
                    severity="success"
                    onClick={() => onRestartEncode?.(retryJobId, { restartMode: 'all' })}
                    loading={busy}
                    disabled={!retryJobId}
                  />
                  <Button
                    label="Neu starten ab Abbruch"
                    icon="pi pi-forward"
                    severity="warning"
                    outlined
                    onClick={() => onRestartEncode?.(retryJobId, { restartMode: 'from_abort' })}
                    loading={busy}
                    disabled={!retryJobId}
                  />
                </>
              ) : (
                <Button
                  label="Encode neu starten"
                  icon="pi pi-play"
                  severity="success"
                  onClick={() => onRestartEncode?.(retryJobId, { restartMode: 'all' })}
                  loading={busy}
                  disabled={!retryJobId}
                />
              )
            ) : null}

            {(state === 'ERROR' || state === 'CANCELLED') && retryJobId && !isOrphanCancelled && (retryRipRecoveryRequired || !ripCompleted) && (
              <Button
                label="Retry Rippen"
                icon="pi pi-refresh"
                severity="warning"
                onClick={() => onRetry(retryJobId)}
                loading={busy}
              />
            )}

            {(state === 'ERROR' || state === 'CANCELLED') && !isOrphanCancelled && !ripCompleted ? (
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
        {!running && retryJobId && typeof onDeleteJob === 'function' ? (
          <Button
            label="Job löschen"
            icon="pi pi-trash"
            severity="danger"
            outlined
            onClick={() => onDeleteJob?.(retryJobId)}
            loading={busy}
          />
        ) : null}
      </div>

      {running ? (
        <div className="live-log-block">
          <h4>Aktueller Job-Log</h4>
          <pre className="log-box">{liveJobLog || 'Noch keine Log-Ausgabe vorhanden.'}</pre>
        </div>
      ) : null}

      {showRipIssueNotice ? (
        <div className="rip-error-notice" role="alert" aria-live="polite">
          <div className="rip-error-notice-head">
            <i className="pi pi-exclamation-triangle" aria-hidden="true" />
            <strong>Hinweis: Beim Rip sind Fehler aufgetreten.</strong>
          </div>
          <small>{ripIssueSummaryLabel}. Bitte vor der Bestätigung von Playlist-/Spurauswahl prüfen.</small>
          <div className="rip-error-notice-list">
            {ripIssueVisibleEntries.map((entry, index) => (
              <div key={`rip-issue-${entry.code ?? 'none'}-${index}`} className="rip-error-notice-item">
                <span className="rip-error-notice-code">{entry.code !== null ? `MSG:${entry.code}` : 'Fehler'}</span>
                <span className="rip-error-notice-message">{entry.message}</span>
              </div>
            ))}
          </div>
          <small className="rip-error-notice-more">
            {hiddenRipIssueCount > 0
              ? `+${hiddenRipIssueCount} weitere Meldung(en) im Job-Log.`
              : 'Vollständige Details stehen im Job-Log.'}
          </small>
          {canTriggerRipRetry ? (
            <div className="rip-error-notice-actions">
              <Button
                label="Retry Rippen"
                icon="pi pi-refresh"
                severity="warning"
                outlined
                onClick={() => onRetry?.(retryJobId)}
                loading={busy}
                disabled={busy || queueLocked || !retryJobId}
              />
            </div>
          ) : null}
        </div>
      ) : null}

      {rawDecisionRequiredBeforeStart && !queueLocked ? (
        <div className="playlist-decision-block">
          <h3>RAW Entscheidung erforderlich</h3>
          <small>
            Vorhandenes Raw zur Disk gefunden. Wie soll weiter verfahren werden?
          </small>
          {rawDecisionAllowsMultipartMergeWithOrphan ? (
            <small className="muted-inline mt-2">
              Optional: Orphan-RAW als eigene Disc in einen Multipart-Container uebernehmen
              {(rawDecisionOrphanDiscNumber || rawDecisionCurrentDiscNumber)
                ? ` (Orphan Disc ${rawDecisionOrphanDiscNumber || '?'} | Laufwerk Disc ${rawDecisionCurrentDiscNumber || '?'})`
                : ''}.
            </small>
          ) : null}
          <div className="actions-row mt-3">
            <Button
              label="mit RAW weiter machen"
              icon="pi pi-check"
              severity="success"
              onClick={() => onSubmitRawDecision?.(retryJobId, 'continue')}
              loading={busy}
            />
            {rawDecisionAllowsMultipartMergeWithOrphan ? (
              <Button
                label="Multipart movie (Orphan + LW)"
                icon="pi pi-sitemap"
                severity="info"
                outlined
                onClick={() => onSubmitRawDecision?.(retryJobId, 'multipart_orphan_merge')}
                loading={busy}
              />
            ) : null}
            <Button
              label="RAW löschen und Rip erneut starten"
              icon="pi pi-trash"
              severity="danger"
              outlined
              onClick={() => onSubmitRawDecision?.(retryJobId, 'delete')}
              loading={busy}
            />
            <Button
              label="abbrechen"
              icon="pi pi-times"
              severity="secondary"
              outlined
              onClick={() => onSubmitRawDecision?.(retryJobId, 'cancel')}
              loading={busy}
            />
          </div>
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
                      {row.durationLabel ? ` | Dauer ${row.durationLabel}` : ''}
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

      {handBrakeTitleDecisionRequired && !queueLocked ? (
        <div className="playlist-decision-block">
          <h3>{isSeriesPlayAllDecisionMode ? 'Serien-Grenzfall: PlayAll oder Doppelfolge?' : `${discTypeLabel} Titelauswahl erforderlich`}</h3>
          <small>
            {isSeriesPlayAllDecisionMode
              ? 'Min. ein Titel passt zeitlich zur Summe der kürzeren Episoden. Bitte durch Auswahl entscheiden, ob PlayAll Multi-Episode (nicht anhaken) oder Doppelfolge (anhaken).'
              : `Mehrere ${discTypeLabel}-Titel gefunden, die die Mindestlänge erfüllen. Bitte einen oder mehrere Episodentitel auswählen.`}
          </small>
          {visibleWaitingHandBrakeTitleRows.length > 0 ? (
            <div className="playlist-decision-list">
              {visibleWaitingHandBrakeTitleRows.map((row) => {
                const isDecisionSelectable = !isSeriesPlayAllDecisionMode
                  || handBrakeDecisionSelectableTitleIdSet.has(Number(row.handBrakeTitleId));
                const isAmbiguousDecisionTitle = isSeriesPlayAllDecisionMode
                  && isDecisionSelectable
                  && (
                    Number(row.handBrakeTitleId) === Number(ambiguousLongestTitleId)
                    || handBrakeDecisionSelectableTitleIdSet.has(Number(row.handBrakeTitleId))
                  );
                const isRecognizedLocked = isSeriesPlayAllDecisionMode
                  && row.decisionCandidate
                  && !isDecisionSelectable;
                const isOutOfDecisionScope = isSeriesPlayAllDecisionMode
                  && !row.decisionCandidate;
                return (
                  <div key={row.handBrakeTitleId} className="playlist-decision-item">
                    <label className="readonly-check-row">
                      <input
                        type="checkbox"
                        checked={selectedHandBrakeTitleIdsState.includes(row.handBrakeTitleId)}
                        disabled={queueLocked || !isDecisionSelectable}
                        onChange={() => {
                          if (!isDecisionSelectable) {
                            return;
                          }
                          setSelectedHandBrakeTitleIdsState((prev) => {
                            const list = Array.isArray(prev) ? prev : [];
                            if (list.includes(row.handBrakeTitleId)) {
                              return list.filter((value) => value !== row.handBrakeTitleId);
                            }
                            return [...list, row.handBrakeTitleId];
                          });
                        }}
                      />
                      <span>
                        {isAmbiguousDecisionTitle ? <strong>{`Titel -t ${row.handBrakeTitleId}`}</strong> : `Titel -t ${row.handBrakeTitleId}`}
                        {isAmbiguousDecisionTitle ? ' | Grenzfalltitel (PlayAll/Doppelfolge)' : ''}
                        {isRecognizedLocked ? ' | automatisch erkannt (fix)' : ''}
                        {isOutOfDecisionScope ? ' | nicht entscheidungsrelevant' : ''}
                        {row.durationLabel ? ` | ${row.durationLabel}` : ''}
                        {row.audioTrackCount > 0 ? ` | Audio: ${row.audioTrackCount}` : ''}
                        {row.subtitleTrackCount > 0 ? ` | Untertitel: ${row.subtitleTrackCount}` : ''}
                      </span>
                    </label>
                  </div>
                );
              })}
            </div>
          ) : (
            <small>Keine Kandidaten verfügbar. Bitte Analyse erneut ausführen.</small>
          )}
        </div>
      ) : null}

      {selectedMetadata && !isDiscTitleSelectionRequired ? (
        <div className="pipeline-meta-inline">
          {selectedMetadata.poster ? (
            <img
              src={selectedMetadata.poster}
              alt={selectedMetadata.title || 'Poster'}
              className={jobMediaProfile === 'cd' || jobMediaProfile === 'audiobook' ? 'poster-large-audio' : 'poster-large'}
            />
          ) : (
            <div className={`${jobMediaProfile === 'cd' || jobMediaProfile === 'audiobook' ? 'poster-large-audio' : 'poster-large'} poster-fallback`}>Kein {jobMediaProfile === 'cd' || jobMediaProfile === 'audiobook' ? 'Cover' : 'Poster'}</div>
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

      {(mediaInfoReview || state === 'READY_TO_ENCODE') && !(handBrakeTitleDecisionRequired && isSeriesPlayAllDecisionMode) ? (
        <div className="mediainfo-review-block">
          {!isDiscTitleSelectionRequired ? <h3>Titel-/Spurprüfung</h3> : null}
          {state === 'READY_TO_ENCODE' && !queueLocked && !isDiscTitleSelectionRequired ? (
            <small>
              {isPreRipReview
                ? 'Spurauswahl kann direkt übernommen werden. Beim Klick auf "Backup + Encoding starten" wird automatisch bestätigt und gestartet.'
                : 'Spurauswahl kann direkt übernommen werden. Beim Klick auf "Encoding starten" wird automatisch bestätigt und gestartet.'}
              {reviewPlaylistDecisionRequired ? ' Bitte den korrekten Titel per Checkbox auswählen.' : ''}
            </small>
          ) : null}
          {showConverterConfig ? (
            <div style={{ marginTop: '0.75rem', marginBottom: '0.75rem', padding: '0.75rem', border: '1px solid var(--surface-border, #e0e0e0)', borderRadius: '6px', background: 'var(--surface-ground, #f8f8f8)' }}>
              <div style={{ display: 'grid', gap: '0.75rem', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))' }}>
                <div>
                  <label style={{ display: 'block', marginBottom: '0.35rem', fontWeight: 600 }}>Ausgabeformat</label>
                  <Dropdown
                    value={selectedOutputFormat}
                    options={CONVERTER_VIDEO_OUTPUT_FORMATS}
                    onChange={(e) => setSelectedOutputFormat(e.value)}
                    style={{ width: '100%' }}
                    disabled={!allowConverterConfigEdit}
                  />
                </div>
                <div>
                  <label style={{ display: 'block', marginBottom: '0.35rem', fontWeight: 600 }}>User-Preset</label>
                  <Dropdown
                    value={selectedUserPresetId}
                    options={converterUserPresetOptions}
                    optionLabel="label"
                    optionValue="value"
                    onChange={(e) => {
                      const rawValue = e?.value && typeof e.value === 'object' ? e.value.value : e?.value;
                      const nextValue = rawValue === null || rawValue === undefined || String(rawValue).trim() === ''
                        ? null
                        : Number(rawValue);
                      const normalized = Number.isFinite(nextValue) && nextValue > 0 ? Math.trunc(nextValue) : null;
                      setSelectedUserPresetId(normalized);
                      if (normalized) {
                        setSelectedHandBrakePreset('');
                      }
                    }}
                    style={{ width: '100%' }}
                    placeholder="User-Preset auswählen …"
                    showClear
                    disabled={!allowConverterConfigEdit || Boolean(trimmedHandBrakePreset) || converterUserPresetOptions.length <= 1}
                  />
                  {converterUserPresetOptions.length <= 1 ? (
                    <small style={{ color: 'var(--text-color-secondary)' }}>Keine User-Presets vorhanden.</small>
                  ) : null}
                </div>
                <div>
                  <label style={{ display: 'block', marginBottom: '0.35rem', fontWeight: 600 }}>HandBrake-Preset</label>
                  <Dropdown
                    value={trimmedHandBrakePreset}
                    options={converterHandBrakePresetOptions}
                    optionLabel="label"
                    optionValue="value"
                    onChange={(e) => {
                      const rawValue = e?.value && typeof e.value === 'object' ? e.value.value : e?.value;
                      const next = String(rawValue || '').trim();
                      setSelectedHandBrakePreset(next);
                      if (next) {
                        setSelectedUserPresetId(null);
                      }
                    }}
                    style={{ width: '100%' }}
                    placeholder="HandBrake-Preset auswählen …"
                    filter
                    optionDisabled="disabled"
                    showClear
                    disabled={!allowConverterConfigEdit || Boolean(selectedUserPresetId) || converterHandBrakePresetOptions.length <= 1}
                  />
                  {converterHandBrakePresetOptions.length <= 1 ? (
                    <small style={{ color: 'var(--text-color-secondary)' }}>Keine HandBrake-Presets geladen.</small>
                  ) : null}
                </div>
              </div>
              {allowConverterConfigEdit && !hasEffectiveSelectedPreset ? (
                <small style={{ display: 'block', marginTop: '0.5rem', color: 'var(--red-600)' }}>
                  Bitte wähle ein User- oder HandBrake-Preset aus, bevor das Encoding starten kann.
                </small>
              ) : null}
              {allowConverterConfigEdit ? (
                converterConfigError ? (
                  <small style={{ display: 'block', marginTop: '0.5rem', color: 'var(--red-600)' }}>
                    {converterConfigError}
                  </small>
                ) : (
                  <small style={{ display: 'block', marginTop: '0.5rem', color: 'var(--text-color-secondary)' }}>
                    {converterConfigSaving ? 'Speichere Konfiguration …' : 'Konfiguration gespeichert'}
                  </small>
                )
              ) : null}
            </div>
          ) : null}
          <MediaInfoReviewPanel
            review={mediaInfoReview}
            presetDisplayValue={presetDisplayValue}
            commandOutputPath={commandOutputPath}
            commandOutputPathByTitle={commandOutputPathByTitle}
            topContent={(
              <>
                {hasAlternativeTitleSelection ? (
                  <div className="playlist-decision-block">
                    <h3>Alternative Titel gefunden</h3>
                    <small>
                      Es wurden weitere gleichlange oder längere Titel erkannt. Das kann auf alternative Schnittfassungen
                      oder Playlist-Varianten derselben Disc hindeuten. Bitte waehle hier den Titel aus, der fuer Tracks,
                      Untertitel, Infos und den HandBrakeCLI-Command verwendet werden soll.
                    </small>
                    <div style={{ marginTop: '0.75rem' }}>
                      <label style={{ display: 'block', marginBottom: '0.35rem', fontWeight: 600 }}>
                        Zu verwendender Titel
                      </label>
                      <Dropdown
                        value={normalizeTitleId(selectedEncodeTitleId) || normalizeTitleId(mediaInfoReview?.encodeInputTitleId) || null}
                        options={alternativeTitleOptions}
                        optionLabel="label"
                        optionValue="value"
                        onChange={(e) => {
                          const nextTitleId = normalizeTitleId(e?.value);
                          if (!nextTitleId) {
                            return;
                          }
                          setSelectedEncodeTitleId(nextTitleId);
                          setSelectedEncodeTitleIds([nextTitleId]);
                          setTitleSelectionTouched(true);
                        }}
                        style={{ width: '100%' }}
                        disabled={!allowReviewSelectionEdit || alternativeTitleOptions.length <= 1}
                      />
                    </div>
                  </div>
                ) : null}
                {multipartSettingsLocked ? (
                  <div className="playlist-decision-block">
                    <h3>Multipart-Lock aktiv</h3>
                    <small>
                      Die Encode-Einstellungen wurden automatisch von der bereits vorhandenen Disc übernommen und sind gesperrt.
                      {multipartLockSourceJobId ? ` Quelle: Job #${multipartLockSourceJobId}.` : ''}
                      {multipartLockSourceDiscNumber ? ` Referenz-Disc: ${multipartLockSourceDiscNumber}.` : ''}
                    </small>
                  </div>
                ) : null}
                {isSeriesDvdReview && hasMultiEpisodeInJob ? (
                  <div className="playlist-decision-block">
                    <h3>Hinweis Episoden-Zuordnung</h3>
                    <small>
                      Im Job wurden Hinweise zur Episoden-Zuordnung erkannt. Bitte Episodentitel und Episodenbereich prüfen, bevor das Encoding startet.
                    </small>
                    {episodeAssignmentWarningLines.map((line, index) => (
                      <small key={`episode-assignment-warning-${index}`}>{line}</small>
                    ))}
                  </div>
                ) : null}
                {!showConverterConfig
                  && requiresPresetSelection
                  && allowReviewSelectionEdit
                  && !hasEffectiveSelectedPreset
                  && state === 'READY_TO_ENCODE'
                  && mediaInfoReview ? (
                  <div className="playlist-decision-block">
                    <h3>Preset-Auswahl erforderlich</h3>
                    <small>
                      Es ist kein gültiges Preset/CLI-Setup aktiv. Bitte Preset auswählen oder gültige Extra-Args hinterlegen.
                    </small>
                  </div>
                ) : null}
              </>
            )}
            selectedEncodeTitleId={normalizeTitleId(selectedEncodeTitleId)}
            selectedEncodeTitleIds={normalizeTitleIdList(selectedEncodeTitleIds)}
            displayOnlySelectedTitle={hasAlternativeTitleSelection}
            titleSelectionTouched={titleSelectionTouched}
            allowTitleSelection={allowTitleSelectionInReview}
            compactTitleSelection={isDiscTitleSelectionRequired}
            onSelectEncodeTitle={(titleId) => {
              const normalizedTitleId = normalizeTitleId(titleId);
              setSelectedEncodeTitleId(normalizedTitleId);
              setTitleSelectionTouched(true);
              if (!normalizedTitleId) {
                return;
              }
              setSelectedEncodeTitleIds((prev) => normalizeTitleIdList([...(Array.isArray(prev) ? prev : []), normalizedTitleId]));
            }}
            onToggleEncodeTitle={(titleId, checked) => {
              const normalizedTitleId = normalizeTitleId(titleId);
              if (!normalizedTitleId) {
                return;
              }
              setTitleSelectionTouched(true);
              setSelectedEncodeTitleIds((prev) => {
                const current = normalizeTitleIdList(prev);
                if (checked) {
                  const next = normalizeTitleIdList([...current, normalizedTitleId]);
                  setSelectedEncodeTitleId(normalizedTitleId);
                  return next;
                }
                const next = current.filter((id) => id !== normalizedTitleId);
                setSelectedEncodeTitleId((prevPrimary) => {
                  const normalizedPrimary = normalizeTitleId(prevPrimary);
                  if (normalizedPrimary === normalizedTitleId) {
                    return next[0] || null;
                  }
                  return normalizedPrimary;
                });
                return next;
              });
            }}
            allowTrackSelection={allowTrackSelectionInReview}
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
                  subtitleTrackIds: [],
                  subtitleVariantSelection: {},
                  subtitleLanguageOrder: [],
                  subtitleSelectionMode: 'variants'
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
                    [key]: next,
                    ...(trackType === 'subtitle'
                      ? {
                        subtitleSelectionMode: 'track_ids',
                        subtitleVariantSelection: {},
                        subtitleLanguageOrder: []
                      }
                      : {})
                  }
                };
              });
            }}
            onSubtitleVariantSelectionChange={(titleId, language, variant, checked) => {
              const normalizedTitleId = normalizeTitleId(titleId);
              const normalizedLanguage = normalizeSubtitleLanguage(language);
              const normalizedVariant = String(variant || '').trim().toLowerCase() === 'forced' ? 'forced' : 'full';
              if (!normalizedTitleId || !normalizedLanguage) {
                return;
              }

              setTrackSelectionByTitle((prev) => {
                const current = prev?.[normalizedTitleId] || prev?.[String(normalizedTitleId)] || {
                  audioTrackIds: [],
                  subtitleTrackIds: [],
                  subtitleVariantSelection: {},
                  subtitleLanguageOrder: [],
                  subtitleSelectionMode: 'variants'
                };
                const currentMap = normalizeSubtitleVariantSelectionMap(current?.subtitleVariantSelection || {});
                const nextMap = { ...currentMap };
                const currentEntry = nextMap[normalizedLanguage] || { full: false, forced: false };
                nextMap[normalizedLanguage] = {
                  ...currentEntry,
                  [normalizedVariant]: Boolean(checked)
                };
                const existingOrder = normalizeSubtitleLanguageOrder(current?.subtitleLanguageOrder || []);
                const fallbackOrder = normalizeSubtitleLanguageOrder(
                  defaultTrackSelectionForTitle(mediaInfoReview, normalizedTitleId)?.subtitleLanguageOrder || []
                );
                let nextOrder = existingOrder.length > 0
                  ? existingOrder
                  : fallbackOrder;
                if (nextOrder.length === 0) {
                  nextOrder = [normalizedLanguage];
                } else if (!nextOrder.includes(normalizedLanguage) && fallbackOrder.includes(normalizedLanguage)) {
                  nextOrder = fallbackOrder;
                } else if (!nextOrder.includes(normalizedLanguage)) {
                  nextOrder = [...nextOrder, normalizedLanguage];
                }

                return {
                  ...prev,
                  [normalizedTitleId]: {
                    ...current,
                    subtitleSelectionMode: 'variants',
                    subtitleVariantSelection: nextMap,
                    subtitleLanguageOrder: nextOrder
                  }
                };
              });
            }}
            selectedMetadataEpisodes={selectedMetadataEpisodes}
            selectedEpisodeFillStart={selectedEpisodeFillStart}
            onEpisodeFillStartChange={(episodeRef) => {
              const normalizedRef = String(episodeRef || '').trim();
              setSelectedEpisodeFillStart(normalizedRef || null);
              if (normalizedRef) {
                applyEpisodeFillFrom(normalizedRef);
              }
            }}
            episodeAssignmentsByTitle={episodeAssignmentsByTitle}
            allowEpisodeAssignments={isSeriesDvdReview && !multipartSettingsLocked}
            onEpisodeAssignmentChange={(titleId, patch = {}) => {
              const normalizedTitleId = normalizeTitleId(titleId);
              if (!normalizedTitleId || !patch || typeof patch !== 'object') {
                return;
              }
              const toNumberOrNull = (value) => {
                const parsed = Number(value);
                if (!Number.isFinite(parsed) || parsed <= 0) {
                  return null;
                }
                return Math.trunc(parsed);
              };
              setEpisodeAssignmentsByTitle((prev) => {
                const currentMap = prev && typeof prev === 'object' ? prev : {};
                const current = currentMap?.[normalizedTitleId] || currentMap?.[String(normalizedTitleId)] || {};
                const nextTitle = String(
                  patch.episodeTitle !== undefined
                    ? patch.episodeTitle
                    : current.episodeTitle || ''
                ).trim();
                const next = {
                  ...current,
                  episodeId: patch.episodeId !== undefined
                    ? toNumberOrNull(patch.episodeId)
                    : toNumberOrNull(current.episodeId),
                  episodeNumber: patch.episodeNumber !== undefined
                    ? toNumberOrNull(patch.episodeNumber)
                    : toNumberOrNull(current.episodeNumber),
                  seasonNumber: patch.seasonNumber !== undefined
                    ? toNumberOrNull(patch.seasonNumber)
                    : toNumberOrNull(current.seasonNumber),
                  episodeTitle: nextTitle || null
                };
                if (next.episodeNumber !== null && next.episodeNumberStart == null) {
                  next.episodeNumberStart = next.episodeNumber;
                }
                if (
                  next.episodeNumberStart !== null
                  && next.episodeNumberEnd !== null
                  && Number(next.episodeNumberEnd) < Number(next.episodeNumberStart)
                ) {
                  next.episodeNumberEnd = next.episodeNumberStart;
                }
                if (next.episodeNumberStart !== null && next.episodeNumberEnd == null) {
                  next.episodeNumberEnd = next.episodeNumberStart;
                }
                if (next.episodeNumberStart !== null) {
                  const start = Number(next.episodeNumberStart);
                  const end = Number(next.episodeNumberEnd ?? start);
                  if (Number.isFinite(start) && start > 0 && Number.isFinite(end) && end > 0) {
                    next.episodeSpan = Math.max(1, Math.trunc(end - start + 1));
                    next.episodeRange = buildEpisodeRangeToken(start, end);
                  }
                }
                return {
                  ...currentMap,
                  [normalizedTitleId]: next
                };
              });
            }}
            availableScripts={scriptCatalog}
            availableChains={chainCatalog}
            preEncodeItems={preEncodeItems}
            postEncodeItems={postEncodeItems}
            userPresets={effectiveUserPresets}
            selectedUserPresetId={selectedUserPresetId}
            onUserPresetChange={showConverterConfig || multipartSettingsLocked ? null : (presetId) => {
              const nextPresetId = Number.isFinite(Number(presetId)) && Number(presetId) > 0
                ? Math.trunc(Number(presetId))
                : null;
              setSelectedUserPresetId(nextPresetId);
              if (nextPresetId) {
                setSelectedHandBrakePreset('');
              }
            }}
            selectedHandBrakePreset={selectedHandBrakePreset}
            onHandBrakePresetChange={showConverterConfig || multipartSettingsLocked ? null : (presetName) => {
              const nextPresetName = String(presetName || '').trim();
              setSelectedHandBrakePreset(nextPresetName);
              if (nextPresetName) {
                setSelectedUserPresetId(null);
              }
            }}
            presetSelectionExplicitlyCleared={presetSelectionExplicitlyCleared}
            onPresetTokenChange={showConverterConfig || multipartSettingsLocked ? null : (token) => {
              const normalizedToken = String(token || '').trim().toLowerCase();
              setPresetSelectionExplicitlyCleared(normalizedToken === 'none');
            }}
            handBrakePresetOptions={handBrakePresetOptions}
            allowEncodeItemSelection={allowEncodeItemSelectionInReview}
            comparisonReviewItems={multipartComparisonReviews}
            onAddPreEncodeItem={(itemType) => {
              setPreEncodeItems((prev) => {
                const current = Array.isArray(prev) ? prev : [];
                if (itemType === 'chain') {
                  const selectedSet = new Set(
                    current
                      .filter((item) => item?.type === 'chain')
                      .map((item) => normalizeChainId(item?.id))
                      .filter((id) => id !== null)
                      .map((id) => String(id))
                  );
                  const nextCandidate = (Array.isArray(chainCatalog) ? chainCatalog : [])
                    .map((item) => normalizeChainId(item?.id))
                    .find((id) => id !== null && !selectedSet.has(String(id)));
                  if (nextCandidate === undefined || nextCandidate === null) {
                    return current;
                  }
                  return [...current, { type: 'chain', id: nextCandidate }];
                }
                const selectedSet = new Set(
                  current
                    .filter((item) => item?.type === 'script')
                    .map((item) => normalizeScriptId(item?.id))
                    .filter((id) => id !== null)
                    .map((id) => String(id))
                );
                const nextCandidate = (Array.isArray(scriptCatalog) ? scriptCatalog : [])
                  .map((item) => normalizeScriptId(item?.id))
                  .find((id) => id !== null && !selectedSet.has(String(id)));
                if (nextCandidate === undefined || nextCandidate === null) {
                  return current;
                }
                return [...current, { type: 'script', id: nextCandidate }];
              });
            }}
            onChangePreEncodeItem={(rowIndex, itemType, nextId) => {
              setPreEncodeItems((prev) => {
                const current = Array.isArray(prev) ? prev : [];
                const index = Number(rowIndex);
                if (!Number.isInteger(index) || index < 0 || index >= current.length) {
                  return current;
                }
                const type = itemType === 'chain' ? 'chain' : 'script';
                if (type === 'chain') {
                  const normalizedId = normalizeChainId(nextId);
                  if (normalizedId === null) {
                    return current;
                  }
                  const duplicate = current.some((item, idx) =>
                    idx !== index
                    && item?.type === 'chain'
                    && String(normalizeChainId(item?.id)) === String(normalizedId)
                  );
                  if (duplicate) {
                    return current;
                  }
                  const next = [...current];
                  next[index] = { type: 'chain', id: normalizedId };
                  return next;
                }
                const normalizedId = normalizeScriptId(nextId);
                if (normalizedId === null) {
                  return current;
                }
                const duplicate = current.some((item, idx) =>
                  idx !== index
                  && item?.type === 'script'
                  && String(normalizeScriptId(item?.id)) === String(normalizedId)
                );
                if (duplicate) {
                  return current;
                }
                const next = [...current];
                next[index] = { type: 'script', id: normalizedId };
                return next;
              });
            }}
            onRemovePreEncodeItem={(rowIndex) => {
              setPreEncodeItems((prev) => {
                const current = Array.isArray(prev) ? prev : [];
                const index = Number(rowIndex);
                if (!Number.isInteger(index) || index < 0 || index >= current.length) {
                  return current;
                }
                return current.filter((_, idx) => idx !== index);
              });
            }}
            onReorderPreEncodeItem={(fromIndex, toIndex) => {
              setPreEncodeItems((prev) => {
                const current = Array.isArray(prev) ? prev : [];
                const from = Number(fromIndex);
                const to = Number(toIndex);
                if (!Number.isInteger(from) || !Number.isInteger(to)) {
                  return current;
                }
                if (from < 0 || to < 0 || from >= current.length || to >= current.length || from === to) {
                  return current;
                }
                const next = [...current];
                const [moved] = next.splice(from, 1);
                next.splice(to, 0, moved);
                return next;
              });
            }}
            onAddPostEncodeItem={(itemType) => {
              setPostEncodeItems((prev) => {
                const current = Array.isArray(prev) ? prev : [];
                if (itemType === 'chain') {
                  const selectedSet = new Set(
                    current
                      .filter((item) => item?.type === 'chain')
                      .map((item) => normalizeChainId(item?.id))
                      .filter((id) => id !== null)
                      .map((id) => String(id))
                  );
                  const nextCandidate = (Array.isArray(chainCatalog) ? chainCatalog : [])
                    .map((item) => normalizeChainId(item?.id))
                    .find((id) => id !== null && !selectedSet.has(String(id)));
                  if (nextCandidate === undefined || nextCandidate === null) {
                    return current;
                  }
                  return [...current, { type: 'chain', id: nextCandidate }];
                }
                const selectedSet = new Set(
                  current
                    .filter((item) => item?.type === 'script')
                    .map((item) => normalizeScriptId(item?.id))
                    .filter((id) => id !== null)
                    .map((id) => String(id))
                );
                const nextCandidate = (Array.isArray(scriptCatalog) ? scriptCatalog : [])
                  .map((item) => normalizeScriptId(item?.id))
                  .find((id) => id !== null && !selectedSet.has(String(id)));
                if (nextCandidate === undefined || nextCandidate === null) {
                  return current;
                }
                return [...current, { type: 'script', id: nextCandidate }];
              });
            }}
            onChangePostEncodeItem={(rowIndex, itemType, nextId) => {
              setPostEncodeItems((prev) => {
                const current = Array.isArray(prev) ? prev : [];
                const index = Number(rowIndex);
                if (!Number.isInteger(index) || index < 0 || index >= current.length) {
                  return current;
                }
                const type = itemType === 'chain' ? 'chain' : 'script';
                if (type === 'chain') {
                  const normalizedId = normalizeChainId(nextId);
                  if (normalizedId === null) {
                    return current;
                  }
                  const duplicate = current.some((item, idx) =>
                    idx !== index
                    && item?.type === 'chain'
                    && String(normalizeChainId(item?.id)) === String(normalizedId)
                  );
                  if (duplicate) {
                    return current;
                  }
                  const next = [...current];
                  next[index] = { type: 'chain', id: normalizedId };
                  return next;
                }
                const normalizedId = normalizeScriptId(nextId);
                if (normalizedId === null) {
                  return current;
                }
                const duplicate = current.some((item, idx) =>
                  idx !== index
                  && item?.type === 'script'
                  && String(normalizeScriptId(item?.id)) === String(normalizedId)
                );
                if (duplicate) {
                  return current;
                }
                const next = [...current];
                next[index] = { type: 'script', id: normalizedId };
                return next;
              });
            }}
            onRemovePostEncodeItem={(rowIndex) => {
              setPostEncodeItems((prev) => {
                const current = Array.isArray(prev) ? prev : [];
                const index = Number(rowIndex);
                if (!Number.isInteger(index) || index < 0 || index >= current.length) {
                  return current;
                }
                return current.filter((_, idx) => idx !== index);
              });
            }}
            onReorderPostEncodeItem={(fromIndex, toIndex) => {
              setPostEncodeItems((prev) => {
                const current = Array.isArray(prev) ? prev : [];
                const from = Number(fromIndex);
                const to = Number(toIndex);
                if (!Number.isInteger(from) || !Number.isInteger(to)) {
                  return current;
                }
                if (from < 0 || to < 0 || from >= current.length || to >= current.length || from === to) {
                  return current;
                }
                const next = [...current];
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
