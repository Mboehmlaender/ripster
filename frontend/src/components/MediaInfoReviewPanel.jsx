import { Button } from 'primereact/button';
import { Dropdown } from 'primereact/dropdown';

function formatDuration(minutes) {
  const value = Number(minutes || 0);
  if (!Number.isFinite(value)) {
    return '-';
  }
  return `${value.toFixed(2)} min`;
}

function formatBytes(bytes) {
  const value = Number(bytes || 0);
  if (!Number.isFinite(value) || value <= 0) {
    return '-';
  }
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = value;
  let index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  return `${size.toFixed(2)} ${units[index]}`;
}

function normalizeTrackId(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return Math.trunc(parsed);
}

function normalizePositiveInt(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return Math.trunc(parsed);
}

function formatTwoDigit(value) {
  const normalized = normalizePositiveInt(value);
  if (normalized === null) {
    return '??';
  }
  return String(normalized).padStart(2, '0');
}

function buildEpisodeRangeToken(start, end) {
  const startNormalized = normalizePositiveInt(start);
  const endNormalized = normalizePositiveInt(end);
  if (!startNormalized) {
    return '??';
  }
  if (!endNormalized || endNormalized <= startNormalized) {
    return formatTwoDigit(startNormalized);
  }
  return `${formatTwoDigit(startNormalized)}-${formatTwoDigit(endNormalized)}`;
}

function buildEpisodePartsToken(start, end) {
  const startNormalized = normalizePositiveInt(start) || 1;
  const endNormalized = normalizePositiveInt(end) || startNormalized;
  const span = Math.max(1, endNormalized - startNormalized + 1);
  if (span <= 1) {
    return '1';
  }
  if (span === 2) {
    return '1+2';
  }
  return `1-${span}`;
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

function normalizeEpisodeFillTitle(value, isMulti = false) {
  const source = String(value || '').replace(/\s+/g, ' ').trim();
  if (!source) {
    return '';
  }
  if (!isMulti) {
    return source;
  }
  return stripEpisodePartSuffix(source) || source;
}

function resolveTitleDurationSecondsForFill(title = null) {
  const durationSeconds = Number(title?.durationSeconds || 0);
  if (Number.isFinite(durationSeconds) && durationSeconds > 0) {
    return durationSeconds;
  }
  const durationMinutes = Number(title?.durationMinutes || 0);
  if (Number.isFinite(durationMinutes) && durationMinutes > 0) {
    return durationMinutes * 60;
  }
  return 0;
}

function medianPositiveNumber(values = []) {
  const numbers = (Array.isArray(values) ? values : [])
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value > 0)
    .sort((a, b) => a - b);
  if (numbers.length === 0) {
    return 0;
  }
  const middle = Math.floor(numbers.length / 2);
  if (numbers.length % 2 === 1) {
    return numbers[middle];
  }
  return (numbers[middle - 1] + numbers[middle]) / 2;
}

function estimateEpisodeSpanForFill(title = null, allTitles = []) {
  const titleDuration = resolveTitleDurationSecondsForFill(title);
  if (!Number.isFinite(titleDuration) || titleDuration <= 0) {
    return 1;
  }
  const durations = (Array.isArray(allTitles) ? allTitles : [])
    .map((item) => resolveTitleDurationSecondsForFill(item))
    .filter((value) => Number.isFinite(value) && value > 0);
  if (durations.length === 0) {
    return 1;
  }
  const medianDuration = medianPositiveNumber(durations);
  if (!medianDuration) {
    return 1;
  }
  const baselinePool = durations.filter((value) => value <= medianDuration * 1.35);
  const baselineDuration = medianPositiveNumber(baselinePool.length > 0 ? baselinePool : durations) || medianDuration;
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

function normalizeTrackIdSequence(values, options = {}) {
  const list = Array.isArray(values) ? values : [];
  const dedupe = options?.dedupe !== false;
  const seen = new Set();
  const output = [];
  for (const value of list) {
    const normalized = normalizeTrackId(value);
    if (normalized === null) {
      continue;
    }
    const key = String(normalized);
    if (dedupe && seen.has(key)) {
      continue;
    }
    if (dedupe) {
      seen.add(key);
    }
    output.push(normalized);
  }
  return output;
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

function normalizeSubtitleLanguageOrder(rawOrder = []) {
  const list = Array.isArray(rawOrder) ? rawOrder : [];
  const seen = new Set();
  const output = [];
  for (const item of list) {
    const language = normalizeSubtitleLanguage(item);
    if (!language || seen.has(language)) {
      continue;
    }
    seen.add(language);
    output.push(language);
  }
  return output;
}

function normalizeSubtitleVariantSelectionMap(rawSelection) {
  const map = {};
  if (!rawSelection || typeof rawSelection !== 'object') {
    return map;
  }
  for (const [language, value] of Object.entries(rawSelection)) {
    const normalizedLanguage = normalizeSubtitleLanguage(language);
    map[normalizedLanguage] = {
      full: Boolean(value?.full),
      forced: Boolean(value?.forced)
    };
  }
  return map;
}

function normalizeSubtitleSelectionMode(value, fallback = 'variants') {
  const mode = String(value || '').trim().toLowerCase();
  if (mode === 'track_ids' || mode === 'variants') {
    return mode;
  }
  return fallback;
}

function normalizeSubtitleConfidenceValue(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (raw === 'high' || raw === 'medium' || raw === 'low') {
    return raw;
  }
  return 'low';
}

function subtitleConfidenceScore(value) {
  const normalized = normalizeSubtitleConfidenceValue(value);
  if (normalized === 'high') {
    return 3;
  }
  if (normalized === 'medium') {
    return 2;
  }
  return 1;
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

function isClosedCaptionSubtitleTrack(track) {
  if (Boolean(track?.sdhLikely)) {
    return true;
  }
  const title = String(track?.title || track?.description || '').trim();
  if (!title) {
    return false;
  }
  return /\b(closed\s*caption|cc|sdh|hoh|hearing\s*impaired)\b/i.test(title);
}

function compareForcedSubtitleCandidate(a, b) {
  const defaultDiff = Number(Boolean(b?.defaultFlag)) - Number(Boolean(a?.defaultFlag));
  if (defaultDiff !== 0) {
    return defaultDiff;
  }
  const confidenceDiff = subtitleConfidenceScore(b?.confidence) - subtitleConfidenceScore(a?.confidence);
  if (confidenceDiff !== 0) {
    return confidenceDiff;
  }
  if (a.id !== b.id) {
    return a.id - b.id;
  }
  return a.originalIndex - b.originalIndex;
}

function compareFullSubtitleCandidate(a, b) {
  const defaultDiff = Number(Boolean(b?.defaultFlag)) - Number(Boolean(a?.defaultFlag));
  if (defaultDiff !== 0) {
    return defaultDiff;
  }
  if (a.id !== b.id) {
    return a.id - b.id;
  }
  return a.originalIndex - b.originalIndex;
}

function buildSubtitleVariantSelectionForPreviewFromTrackIds(subtitleTracks, selectedTrackIds = []) {
  const selectedSet = new Set(normalizeTrackIdList(selectedTrackIds).map((id) => String(id)));
  const map = {};
  const tracks = Array.isArray(subtitleTracks) ? subtitleTracks : [];
  for (const track of tracks) {
    if (!selectedSet.has(String(track?.id))) {
      continue;
    }
    const language = normalizeSubtitleLanguage(track?.language || track?.languageLabel || 'und');
    if (!map[language]) {
      map[language] = { full: false, forced: false };
    }
    if (track.isForcedOnly) {
      map[language].forced = true;
    } else {
      map[language].full = true;
    }
  }
  return map;
}

function resolveDeterministicSubtitleCliSelectionForPreview({
  subtitleTracks,
  subtitleVariantSelection,
  subtitleLanguageOrder,
  fallbackSelectedSubtitleTrackIds = [],
  fallbackSelectedSubtitleTrackIdsOrdered = [],
  hasExplicitVariantSelection = false
}) {
  const tracks = (Array.isArray(subtitleTracks) ? subtitleTracks : [])
    .map((track, index) => {
      const id = normalizeTrackId(track?.id ?? track?.sourceTrackId);
      if (id === null) {
        return null;
      }
      if (isBurnedSubtitleTrack(track) || isDuplicateSubtitleTrack(track)) {
        return null;
      }
      const flags = resolveSubtitleTrackVariantFlags(track);
      return {
        id,
        language: normalizeSubtitleLanguage(track?.language || track?.languageLabel || 'und'),
        isForcedOnly: flags.isForcedOnly,
        fullHasForced: flags.fullHasForced,
        defaultFlag: Boolean(track?.defaultFlag ?? track?.subtitlePreviewDefaultTrack ?? track?.defaultTrack),
        confidence: normalizeSubtitleConfidenceValue(track?.sourceConfidence || track?.confidence),
        selectedForEncode: Boolean(track?.selectedForEncode),
        originalIndex: index
      };
    })
    .filter(Boolean);

  const grouped = new Map();
  for (const track of tracks) {
    if (!grouped.has(track.language)) {
      grouped.set(track.language, []);
    }
    grouped.get(track.language).push(track);
  }

  const normalizedVariantSelection = normalizeSubtitleVariantSelectionMap(subtitleVariantSelection || {});
  const normalizedLanguageOrder = normalizeSubtitleLanguageOrder(subtitleLanguageOrder || []);
  const fallbackSelectionFromTrackIds = normalizeSubtitleVariantSelectionMap(
    buildSubtitleVariantSelectionForPreviewFromTrackIds(tracks, fallbackSelectedSubtitleTrackIds)
  );
  const fallbackSelectionFromOrderedTrackIds = normalizeSubtitleVariantSelectionMap(
    buildSubtitleVariantSelectionForPreviewFromTrackIds(
      tracks,
      normalizeTrackIdSequence(fallbackSelectedSubtitleTrackIdsOrdered, { dedupe: false })
    )
  );
  const fallbackSelectionSet = new Set(normalizeTrackIdList(fallbackSelectedSubtitleTrackIds).map((id) => String(id)));
  const sortedLanguages = Array.from(grouped.entries())
    .map(([language, languageTracks]) => ({
      language,
      minId: languageTracks.reduce((minValue, track) => Math.min(minValue, track.id), Number.MAX_SAFE_INTEGER)
    }))
    .sort((a, b) => a.minId - b.minId || a.language.localeCompare(b.language))
    .map((item) => item.language);

  const order = [];
  const seen = new Set();
  const pushLanguage = (language) => {
    if (!grouped.has(language) || seen.has(language)) {
      return;
    }
    seen.add(language);
    order.push(language);
  };
  normalizedLanguageOrder.forEach(pushLanguage);
  if (!hasExplicitVariantSelection) {
    Object.keys(normalizedVariantSelection).forEach(pushLanguage);
    Object.keys(fallbackSelectionFromOrderedTrackIds).forEach(pushLanguage);
    Object.keys(fallbackSelectionFromTrackIds).forEach(pushLanguage);
  }
  sortedLanguages.forEach(pushLanguage);

  const subtitleTrackIds = [];
  const subtitleForcedTrackIndexes = [];
  for (const language of order) {
    const languageTracks = grouped.get(language) || [];
    const forcedOnly = languageTracks.filter((track) => track.isForcedOnly).sort(compareForcedSubtitleCandidate)[0] || null;
    const fullTracks = languageTracks.filter((track) => !track.isForcedOnly).sort(compareFullSubtitleCandidate);
    const bestFull = fullTracks[0] || null;
    const bestFullHasForced = fullTracks.filter((track) => track.fullHasForced).sort(compareFullSubtitleCandidate)[0] || null;

    const explicitEntry = normalizedVariantSelection[language] || null;
    const fallbackEntryFromOrderedTrackIds = fallbackSelectionFromOrderedTrackIds[language] || null;
    const fallbackEntryFromTrackIds = fallbackSelectionFromTrackIds[language] || null;
    const hasAnyFallbackSelectedTrack = languageTracks.some((track) => (
      fallbackSelectionSet.has(String(track.id)) || track.selectedForEncode
    ));
    let requestedFull = false;
    let requestedForced = false;
    if (explicitEntry) {
      requestedFull = Boolean(explicitEntry.full);
      requestedForced = Boolean(explicitEntry.forced);
    } else if (hasExplicitVariantSelection) {
      requestedFull = false;
      requestedForced = false;
    } else if (fallbackEntryFromOrderedTrackIds) {
      requestedFull = Boolean(fallbackEntryFromOrderedTrackIds.full);
      requestedForced = Boolean(fallbackEntryFromOrderedTrackIds.forced);
    } else if (fallbackEntryFromTrackIds) {
      requestedFull = Boolean(fallbackEntryFromTrackIds.full);
      requestedForced = Boolean(fallbackEntryFromTrackIds.forced);
    } else if (hasAnyFallbackSelectedTrack) {
      requestedFull = Boolean(bestFull);
      requestedForced = Boolean(forcedOnly);
    } else {
      requestedFull = Boolean(bestFull);
      requestedForced = Boolean(forcedOnly);
    }
    if (!requestedFull && !requestedForced) {
      continue;
    }

    if (forcedOnly) {
      subtitleTrackIds.push(forcedOnly.id);
      if (requestedFull && bestFull) {
        subtitleTrackIds.push(bestFull.id);
      }
      continue;
    }

    if (bestFullHasForced) {
      if (requestedFull && requestedForced) {
        subtitleTrackIds.push(bestFullHasForced.id);
        subtitleTrackIds.push(bestFullHasForced.id);
        subtitleForcedTrackIndexes.push(subtitleTrackIds.length);
      } else if (requestedForced) {
        subtitleTrackIds.push(bestFullHasForced.id);
        subtitleForcedTrackIndexes.push(subtitleTrackIds.length);
      } else if (requestedFull) {
        subtitleTrackIds.push(bestFullHasForced.id);
      }
      continue;
    }

    if (requestedFull && bestFull) {
      subtitleTrackIds.push(bestFull.id);
    }
  }

  return {
    subtitleTrackIds,
    subtitleForcedTrackIndexes
  };
}

function splitArgs(input) {
  if (!input || typeof input !== 'string') {
    return [];
  }

  const args = [];
  let current = '';
  let quote = null;
  let escaping = false;

  for (const ch of input) {
    if (escaping) {
      current += ch;
      escaping = false;
      continue;
    }

    if (ch === '\\') {
      escaping = true;
      continue;
    }

    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }

    if (/\s/.test(ch)) {
      if (current.length > 0) {
        args.push(current);
        current = '';
      }
      continue;
    }

    current += ch;
  }

  if (current.length > 0) {
    args.push(current);
  }

  return args;
}

const AUDIO_SELECTION_KEYS_WITH_VALUE = new Set(['-a', '--audio', '--audio-lang-list']);
const AUDIO_SELECTION_KEYS_FLAG_ONLY = new Set(['--all-audio', '--first-audio']);
const SUBTITLE_SELECTION_KEYS_WITH_VALUE = new Set(['-s', '--subtitle', '--subtitle-lang-list']);
const SUBTITLE_SELECTION_KEYS_FLAG_ONLY = new Set(['--all-subtitles', '--first-subtitle']);
const SUBTITLE_FLAG_KEYS_WITH_VALUE = new Set(['--subtitle-burned', '--subtitle-default', '--subtitle-forced']);
const TITLE_SELECTION_KEYS_WITH_VALUE = new Set(['-t', '--title']);

function removeSelectionArgs(extraArgs) {
  const args = Array.isArray(extraArgs) ? extraArgs : [];
  const filtered = [];

  for (let i = 0; i < args.length; i += 1) {
    const token = String(args[i] || '');
    const key = token.includes('=') ? token.slice(0, token.indexOf('=')) : token;

    const isAudioWithValue = AUDIO_SELECTION_KEYS_WITH_VALUE.has(key);
    const isAudioFlagOnly = AUDIO_SELECTION_KEYS_FLAG_ONLY.has(key);
    const isSubtitleSelectionWithValue = SUBTITLE_SELECTION_KEYS_WITH_VALUE.has(key);
    const isSubtitleFlagWithValue = SUBTITLE_FLAG_KEYS_WITH_VALUE.has(key);
    const isSubtitleWithValue = isSubtitleSelectionWithValue || isSubtitleFlagWithValue;
    const isSubtitleFlagOnly = SUBTITLE_SELECTION_KEYS_FLAG_ONLY.has(key);
    const isTitleWithValue = TITLE_SELECTION_KEYS_WITH_VALUE.has(key);
    const skip = isAudioWithValue || isAudioFlagOnly || isSubtitleWithValue || isSubtitleFlagOnly || isTitleWithValue;

    if (isSubtitleFlagWithValue) {
      const inlineValue = token.includes('=')
        ? token.slice(token.indexOf('=') + 1)
        : '';
      const hasAttachedValue = token.includes('=');
      const nextToken = String(args[i + 1] || '');
      const hasSeparateValue = !hasAttachedValue && nextToken && !nextToken.startsWith('-');
      const candidateValue = String(
        hasAttachedValue
          ? inlineValue
          : (hasSeparateValue ? nextToken : '')
      ).trim().toLowerCase();

      // Keep explicit "none" subtitle flags in preview, same as backend command builder.
      if (candidateValue === 'none') {
        filtered.push(token);
        if (hasSeparateValue) {
          filtered.push(nextToken);
          i += 1;
        }
        continue;
      }
    }

    if (!skip) {
      filtered.push(token);
      continue;
    }

    if ((isAudioWithValue || isSubtitleWithValue || isTitleWithValue) && !token.includes('=')) {
      const nextToken = String(args[i + 1] || '');
      if (nextToken && !nextToken.startsWith('-')) {
        i += 1;
      }
    }
  }

  return filtered;
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

function sanitizePathSegment(value) {
  return transliterateForFilename(String(value || ''))
    .replace(/[^a-zA-Z0-9 ().[\]_+-]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function sanitizeOutputPathForCommand(pathValue) {
  const raw = String(pathValue || '').trim();
  if (!raw) {
    return null;
  }
  const normalizedPath = raw.replace(/\\/g, '/');
  const hasLeadingSlash = normalizedPath.startsWith('/');
  const segments = normalizedPath
    .split('/')
    .map((segment) => sanitizePathSegment(segment))
    .filter(Boolean);
  if (segments.length === 0) {
    return hasLeadingSlash ? '/' : null;
  }
  return `${hasLeadingSlash ? '/' : ''}${segments.join('/')}`;
}

function buildHandBrakeCommandPreview({
  review,
  title,
  selectedAudioTrackIds,
  selectedSubtitleTrackIds,
  selectedSubtitleSelectionMode = 'variants',
  selectedSubtitleVariantSelection = {},
  selectedSubtitleLanguageOrder = [],
  commandOutputPath = null,
  presetOverride = null
}) {
  const inputPath = String(title?.filePath || review?.encodeInputPath || '').trim();
  const handBrakeCmd = String(
    review?.selectors?.handbrakeCommand
    || review?.selectors?.handBrakeCommand
    || 'HandBrakeCLI'
  ).trim() || 'HandBrakeCLI';
  const preset = presetOverride !== null
    ? String(presetOverride.handbrakePreset || '').trim()
    : String(review?.selectors?.preset || '').trim();
  const extraArgs = presetOverride !== null
    ? String(presetOverride.extraArgs || '').trim()
    : String(review?.selectors?.extraArgs || '').trim();
  const rawMappedTitleId = Number(
    title?.handBrakeTitleId
    ?? title?.titleIndex
    ?? title?.id
    ?? review?.handBrakeTitleId
  );
  const mappedTitleId = Number.isFinite(rawMappedTitleId) && rawMappedTitleId > 0
    ? Math.trunc(rawMappedTitleId)
    : null;

  const normalizedSelectedVariantSelection = normalizeSubtitleVariantSelectionMap(selectedSubtitleVariantSelection || {});
  const hasExplicitSelectedVariantSelection = Object.keys(normalizedSelectedVariantSelection).length > 0;
  const normalizedSubtitleSelectionMode = normalizeSubtitleSelectionMode(
    selectedSubtitleSelectionMode,
    hasExplicitSelectedVariantSelection ? 'variants' : 'track_ids'
  );
  const normalizedSelectedSubtitleTrackIds = normalizeTrackIdSequence(selectedSubtitleTrackIds, { dedupe: false });

  const resolvedSubtitleSelection = resolveDeterministicSubtitleCliSelectionForPreview({
    subtitleTracks: Array.isArray(title?.subtitleTracks) ? title.subtitleTracks : [],
    subtitleVariantSelection: normalizedSubtitleSelectionMode === 'variants'
      ? normalizedSelectedVariantSelection
      : {},
    subtitleLanguageOrder: selectedSubtitleLanguageOrder,
    fallbackSelectedSubtitleTrackIds: normalizedSelectedSubtitleTrackIds,
    fallbackSelectedSubtitleTrackIdsOrdered: normalizedSelectedSubtitleTrackIds,
    // Track-ID mode must use fallbackSelectedSubtitleTrackIds instead of forcing
    // variant-explicit mode, otherwise preview can incorrectly collapse to "-s none".
    hasExplicitVariantSelection: normalizedSubtitleSelectionMode === 'variants'
      && hasExplicitSelectedVariantSelection
  });
  const subtitleTrackIds = normalizedSubtitleSelectionMode === 'track_ids'
    ? normalizedSelectedSubtitleTrackIds
    : (
      resolvedSubtitleSelection.subtitleTrackIds.length > 0
        ? resolvedSubtitleSelection.subtitleTrackIds
        : (hasExplicitSelectedVariantSelection
          ? []
          : normalizedSelectedSubtitleTrackIds)
    );
  const selectedSubtitleSet = new Set(normalizeTrackIdList(subtitleTrackIds).map((id) => String(id)));
  const selectedSubtitleTracks = (Array.isArray(title?.subtitleTracks) ? title.subtitleTracks : []).filter((track) => {
    const id = normalizeTrackId(track?.id);
    return id !== null && selectedSubtitleSet.has(String(id));
  });

  const subtitleBurnTrackId = normalizeTrackIdList(
    selectedSubtitleTracks.filter((track) => Boolean(track?.subtitlePreviewBurnIn || track?.burnIn)).map((track) => track?.id)
  )[0] || null;
  const subtitleDefaultTrackId = normalizeTrackIdList(
    selectedSubtitleTracks.filter((track) => Boolean(track?.subtitlePreviewDefaultTrack || track?.defaultTrack)).map((track) => track?.id)
  )[0] || null;

  const sanitizedOutputPath = sanitizeOutputPathForCommand(commandOutputPath);
  const baseArgs = [
    '-i',
    inputPath || '<encode-input>',
    '-o',
    String(sanitizedOutputPath || '').trim() || '<encode-output>'
  ];

  if (mappedTitleId !== null) {
    baseArgs.push('-t', String(mappedTitleId));
  }

  if (preset) {
    baseArgs.push('-Z', preset);
  }

  const filteredExtra = removeSelectionArgs(splitArgs(extraArgs));
  const overrideArgs = [
    '-a',
    normalizeTrackIdList(selectedAudioTrackIds).join(',') || 'none',
    '-s',
    subtitleTrackIds.length > 0 ? subtitleTrackIds.join(',') : 'none'
  ];

  if (subtitleBurnTrackId !== null) {
    overrideArgs.push(`--subtitle-burned=${subtitleBurnTrackId}`);
  }
  if (subtitleDefaultTrackId !== null) {
    overrideArgs.push(`--subtitle-default=${subtitleDefaultTrackId}`);
  }
  if (normalizedSubtitleSelectionMode !== 'track_ids' && resolvedSubtitleSelection.subtitleForcedTrackIndexes.length > 0) {
    overrideArgs.push(`--subtitle-forced=${resolvedSubtitleSelection.subtitleForcedTrackIndexes.join(',')}`);
  }

  const finalArgs = [...baseArgs, ...filteredExtra, ...overrideArgs];
  return `${handBrakeCmd} ${finalArgs.map((arg) => shellQuote(arg)).join(' ')}`;
}

function toLang2(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) {
    return 'und';
  }
  if (raw === 'und' || raw === 'unknown' || raw === 'un') {
    return 'und';
  }
  const map = {
    en: 'en',
    eng: 'en',
    de: 'de',
    deu: 'de',
    ger: 'de',
    tr: 'tr',
    tur: 'tr',
    fr: 'fr',
    fra: 'fr',
    fre: 'fr',
    es: 'es',
    spa: 'es',
    it: 'it',
    ita: 'it'
  };
  if (map[raw]) {
    return map[raw];
  }
  if (raw.length === 2) {
    return raw;
  }
  if (raw.length >= 3) {
    return raw.slice(0, 2);
  }
  return raw;
}

function simplifyCodec(type, value, hint = null) {
  const raw = String(value || '').trim();
  const hintRaw = String(hint || '').trim();
  const lower = raw.toLowerCase();
  const merged = `${raw} ${hintRaw}`.toLowerCase();
  if (!raw) {
    return '-';
  }

  if (type === 'subtitle') {
    if (merged.includes('pgs')) {
      return 'PGS';
    }
    return raw.toUpperCase();
  }

  if (merged.includes('dts-hd ma') || merged.includes('dts hd ma')) {
    return 'DTS-HD MA';
  }
  if (merged.includes('dts-hd hra') || merged.includes('dts hd hra')) {
    return 'DTS-HD HRA';
  }
  if (merged.includes('dts-hd') || merged.includes('dts hd')) {
    return 'DTS-HD';
  }
  if (merged.includes('dts') || merged.includes('dca')) {
    return 'DTS';
  }
  if (merged.includes('truehd')) {
    return 'TRUEHD';
  }
  if (merged.includes('e-ac-3') || merged.includes('eac3') || merged.includes('dd+')) {
    return 'E-AC-3';
  }
  if (merged.includes('ac-3') || merged.includes('ac3') || merged.includes('dolby digital')) {
    return 'AC-3';
  }

  const numeric = Number(raw);
  if (Number.isFinite(numeric)) {
    if (numeric === 262144) {
      return 'DTS-HD';
    }
    if (numeric === 131072) {
      return 'DTS';
    }
  }

  return raw.toUpperCase();
}

function extractAudioVariant(hint) {
  const raw = String(hint || '').trim();
  if (!raw) {
    return '';
  }

  const paren = raw.match(/\(([^)]+)\)/);
  if (!paren) {
    return '';
  }

  const parts = paren[1]
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

  const extras = parts.filter((item) => {
    const lower = item.toLowerCase();
    if (lower.includes('dts') || lower.includes('ac3') || lower.includes('e-ac3') || lower.includes('eac3')) {
      return false;
    }
    if (/\d+(?:\.\d+)?\s*ch/i.test(item)) {
      return false;
    }
    if (/\d+\s*kbps/i.test(lower)) {
      return false;
    }
    return true;
  });

  return extras.join(', ');
}

function channelCount(rawValue) {
  const raw = String(rawValue || '').trim().toLowerCase();
  if (!raw) {
    return null;
  }

  if (raw.includes('7.1')) {
    return 8;
  }
  if (raw.includes('5.1')) {
    return 6;
  }
  if (raw.includes('stereo') || raw.includes('2.0') || raw.includes('downmix')) {
    return 2;
  }
  if (raw.includes('mono') || raw.includes('1.0')) {
    return 1;
  }

  const numeric = Number(raw);
  if (Number.isFinite(numeric) && numeric > 0) {
    if (Math.abs(numeric - 7.1) < 0.2) {
      return 8;
    }
    if (Math.abs(numeric - 5.1) < 0.2) {
      return 6;
    }
    return Math.trunc(numeric);
  }

  const match = raw.match(/(\d+)\s*ch/);
  if (match) {
    const value = Number(match[1]);
    return Number.isFinite(value) && value > 0 ? Math.trunc(value) : null;
  }

  return null;
}

function audioChannelLabel(rawValue) {
  const raw = String(rawValue || '').trim().toLowerCase();
  const count = channelCount(rawValue);

  if (raw.includes('7.1') || count === 8) {
    return 'Surround 7.1';
  }
  if (raw.includes('5.1') || count === 6) {
    return 'Surround 5.1';
  }
  if (raw.includes('stereo') || raw.includes('2.0') || raw.includes('downmix') || count === 2) {
    return 'Stereo';
  }
  if (count === 1) {
    return 'Mono';
  }
  return '';
}

const DEFAULT_AUDIO_FALLBACK_PREVIEW = 'av_aac';

function mapTrackToCopyCodec(track) {
  const raw = [
    track?.codecToken,
    track?.format,
    track?.codecName,
    track?.description,
    track?.title
  ]
    .map((value) => String(value || '').trim().toLowerCase())
    .filter(Boolean)
    .join(' ');

  if (!raw) {
    return null;
  }
  if (raw.includes('e-ac-3') || raw.includes('eac3') || raw.includes('dd+')) {
    return 'eac3';
  }
  if (raw.includes('ac-3') || raw.includes('ac3') || raw.includes('dolby digital')) {
    return 'ac3';
  }
  if (raw.includes('truehd')) {
    return 'truehd';
  }
  if (raw.includes('dts-hd') || raw.includes('dtshd')) {
    return 'dtshd';
  }
  if (raw.includes('dca') || raw.includes('dts')) {
    return 'dts';
  }
  if (raw.includes('aac')) {
    return 'aac';
  }
  if (raw.includes('flac')) {
    return 'flac';
  }
  if (raw.includes('mp3') || raw.includes('mpeg audio')) {
    return 'mp3';
  }
  if (raw.includes('opus')) {
    return 'opus';
  }
  if (raw.includes('pcm') || raw.includes('lpcm')) {
    return 'lpcm';
  }
  return null;
}

function resolveAudioEncoderPreviewLabel(track, encoderToken, copyMask, fallbackEncoder) {
  const normalizedToken = String(encoderToken || '').trim().toLowerCase();
  if (!normalizedToken || normalizedToken === 'preset-default') {
    return 'Preset-Default (HandBrake)';
  }

  if (normalizedToken.startsWith('copy')) {
    const sourceCodec = mapTrackToCopyCodec(track);
    const explicitCopyCodec = normalizedToken.includes(':')
      ? normalizedToken.split(':').slice(1).join(':').trim().toLowerCase()
      : null;
    const normalizedCopyMask = Array.isArray(copyMask)
      ? copyMask.map((item) => String(item || '').trim().toLowerCase()).filter(Boolean)
      : [];

    let canCopy = false;
    let effectiveCodec = sourceCodec;
    if (explicitCopyCodec) {
      canCopy = Boolean(sourceCodec && sourceCodec === explicitCopyCodec);
    } else if (sourceCodec && normalizedCopyMask.length > 0) {
      canCopy = normalizedCopyMask.includes(sourceCodec);
      // DTS-HD MA contains an embedded DTS core. When dtshd is not in the copy
      // mask but dts is, HandBrake will extract and copy the DTS core layer.
      if (!canCopy && sourceCodec === 'dtshd' && normalizedCopyMask.includes('dts')) {
        canCopy = true;
        effectiveCodec = 'dts';
      }
    }

    if (canCopy) {
      return `Copy (${effectiveCodec || track?.format || 'Quelle'})`;
    }

    const fallback = String(fallbackEncoder || DEFAULT_AUDIO_FALLBACK_PREVIEW).trim().toLowerCase() || DEFAULT_AUDIO_FALLBACK_PREVIEW;
    return `Fallback Transcode (${fallback})`;
  }

  return `Transcode (${normalizedToken})`;
}

function parseAudioSelectorFromArgs(extraArgsString, baseSelector) {
  const base = baseSelector && typeof baseSelector === 'object' ? baseSelector : {};
  const args = String(extraArgsString || '').trim();
  if (!args) {
    return base;
  }

  const tokens = tokenizeCliArgs(args);

  const result = { ...base };

  const getNext = (i) => (i + 1 < tokens.length ? tokens[i + 1] : null);

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];

    // Support both --flag=value and --flag value
    const eqIdx = token.indexOf('=');
    const flag = eqIdx !== -1 ? token.slice(0, eqIdx) : token;
    const inlineVal = eqIdx !== -1 ? token.slice(eqIdx + 1) : null;

    const getValue = () => {
      if (inlineVal !== null) return inlineVal;
      const next = getNext(i);
      if (next && !next.startsWith('-')) {
        i++;
        return next;
      }
      return null;
    };

    if (flag === '--aencoder') {
      const val = getValue();
      if (val) {
        result.encoders = val.split(',').map((s) => s.trim()).filter(Boolean);
        result.encoderSource = 'args';
      }
    } else if (flag === '--audio-copy-mask') {
      const val = getValue();
      if (val) {
        result.copyMask = val.split(',').map((s) => s.trim()).filter(Boolean);
      }
    } else if (flag === '--audio-fallback') {
      const val = getValue();
      if (val) {
        result.fallbackEncoder = val.trim();
      }
    }
  }

  return result;
}

function parseSubtitleSelectorFromArgs(extraArgsString, baseSelector) {
  const base = baseSelector && typeof baseSelector === 'object' ? baseSelector : {};
  const args = String(extraArgsString || '').trim();
  if (!args) {
    return base;
  }

  const tokens = tokenizeCliArgs(args);
  const result = { ...base };
  const getNext = (i) => (i + 1 < tokens.length ? tokens[i + 1] : null);
  const parseTrackId = (raw) => {
    const first = String(raw || '').split(',').map((item) => String(item || '').trim()).filter(Boolean)[0] || '';
    const parsed = Number(first);
    return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : null;
  };

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const eqIdx = token.indexOf('=');
    const flag = eqIdx !== -1 ? token.slice(0, eqIdx) : token;
    const inlineVal = eqIdx !== -1 ? token.slice(eqIdx + 1) : null;

    const getValue = () => {
      if (inlineVal !== null) return inlineVal;
      const next = getNext(i);
      if (next && !next.startsWith('-')) {
        i++;
        return next;
      }
      return null;
    };

    if (flag === '--all-subtitles') {
      result.mode = 'all';
    } else if (flag === '--first-subtitle') {
      result.mode = 'first';
      result.firstOnly = true;
    } else if (flag === '--subtitle-lang-list') {
      const val = getValue();
      if (val) {
        result.mode = 'language';
        result.languages = val.split(',').map((item) => String(item || '').trim()).filter(Boolean);
      }
    } else if (flag === '--subtitle' || flag === '-s') {
      const val = getValue();
      if (val) {
        const normalized = String(val || '').trim().toLowerCase();
        result.mode = normalized === 'none' ? 'none' : 'explicit';
      }
    } else if (flag === '--subtitle-burned') {
      result.burnBehavior = 'first';
      const val = getValue();
      const parsedTrack = parseTrackId(val);
      if (parsedTrack !== null) {
        result.burnedTrackId = parsedTrack;
      }
    } else if (flag === '--subtitle-default') {
      const val = getValue();
      const parsedTrack = parseTrackId(val);
      if (parsedTrack !== null) {
        result.defaultTrackId = parsedTrack;
      }
    } else if (flag === '--subtitle-forced') {
      const val = getValue();
      const parsedTrack = parseTrackId(val);
      if (parsedTrack !== null) {
        result.forcedTrackId = parsedTrack;
        result.forcedOnly = false;
      } else {
        result.forcedOnly = true;
      }
    }
  }

  return result;
}

function tokenizeCliArgs(argsString) {
  const source = String(argsString || '');
  const tokens = [];
  let current = '';
  let inQuote = null;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (inQuote) {
      if (ch === inQuote) {
        inQuote = null;
      } else {
        current += ch;
      }
    } else if (ch === '"' || ch === "'") {
      inQuote = ch;
    } else if (ch === ' ' || ch === '\t') {
      if (current) {
        tokens.push(current);
        current = '';
      }
    } else {
      current += ch;
    }
  }
  if (current) {
    tokens.push(current);
  }
  return tokens;
}

function buildAudioActionPreviewSummary(track, selectedIndex, audioSelector) {
  const selector = audioSelector && typeof audioSelector === 'object' ? audioSelector : {};
  const availableEncoders = Array.isArray(selector.encoders) ? selector.encoders : [];
  let encoderPlan = [];

  if (selector.encoderSource === 'args' && availableEncoders.length > 0) {
    const safeIndex = Number.isFinite(selectedIndex) && selectedIndex >= 0 ? selectedIndex : 0;
    encoderPlan = [availableEncoders[Math.min(safeIndex, availableEncoders.length - 1)]];
  } else if (availableEncoders.length > 0) {
    encoderPlan = [...availableEncoders];
  } else {
    encoderPlan = ['preset-default'];
  }

  const labels = encoderPlan
    .map((token) => resolveAudioEncoderPreviewLabel(track, token, selector.copyMask, selector.fallbackEncoder))
    .filter(Boolean);

  return labels.join(' + ') || 'Übernehmen';
}

function TrackList({
  title,
  tracks,
  type = 'generic',
  allowSelection = false,
  selectedTrackIds = [],
  selectedSubtitleVariantSelection = {},
  selectedSubtitleLanguageOrder = [],
  onToggleTrack = null,
  onToggleSubtitleVariant = null,
  audioSelector = null
}) {
  const orderedTracks = (Array.isArray(tracks) ? [...tracks] : [])
    .sort((a, b) => {
      const aId = normalizeTrackId(a?.id) ?? Number.MAX_SAFE_INTEGER;
      const bId = normalizeTrackId(b?.id) ?? Number.MAX_SAFE_INTEGER;
      if (aId !== bId) {
        return aId - bId;
      }
      return String(a?.language || '').localeCompare(String(b?.language || ''));
    });

  if (type === 'subtitle') {
    const selectedVariants = normalizeSubtitleVariantSelectionMap(selectedSubtitleVariantSelection || {});
    const selectedTrackIdSet = new Set(normalizeTrackIdList(selectedTrackIds).map((id) => String(id)));
    const sortedSubtitleTracks = orderedTracks
      .filter((track) => !isDuplicateSubtitleTrack(track));

    const renderVariantRow = ({
      key,
      checked,
      disabled,
      onChange,
      text,
      confidence = null,
      indent = false
    }) => {
      const confidenceColor = confidence === 'high'
        ? '#2e7d32'
        : confidence === 'medium'
          ? '#f57c00'
          : '#c62828';

      return (
        <div key={key} className="media-track-item" style={indent ? { paddingLeft: '1.4rem' } : null}>
          <label className="readonly-check-row">
            <input
              type="checkbox"
              checked={checked}
              onChange={onChange}
              readOnly={disabled}
              disabled={disabled}
            />
            <span>
              {text}
              {confidence ? <span style={{ color: confidenceColor, marginLeft: '0.35rem' }}>●</span> : null}
            </span>
          </label>
        </div>
      );
    };
    const resolveSubtitleActionInfo = (track, selected) => {
      const base = String(track?.subtitlePreviewSummary || track?.subtitleActionSummary || '').trim();
      if (allowSelection) {
        return selected ? 'Übernehmen' : 'Nicht übernommen';
      }
      return base || (selected ? 'Übernehmen' : 'Nicht übernommen');
    };

    return (
      <div>
        <h4>{title}</h4>
        {!tracks || tracks.length === 0 ? (
          <p>Keine Einträge.</p>
        ) : (
          <div className="media-track-list">
            {sortedSubtitleTracks.map((track) => {
              const burned = isBurnedSubtitleTrack(track);
              const trackId = normalizeTrackId(track?.id);
              const language = normalizeSubtitleLanguage(track?.language || track?.languageLabel || 'und');
              const displayLanguage = toLang2(track?.language || track?.languageLabel || 'und');
              const displayCodec = simplifyCodec('subtitle', track?.format, track?.description || track?.title);
              const flags = resolveSubtitleTrackVariantFlags(track);
              const isClosedCaption = isClosedCaptionSubtitleTrack(track);
              const ccSuffix = isClosedCaption ? ' | Closed Caption (CC/SDH)' : '';
              const confidenceRaw = String(track?.sourceConfidence || '').trim().toLowerCase();
              const confidence = confidenceRaw === 'high' || confidenceRaw === 'medium' || confidenceRaw === 'low'
                ? confidenceRaw
                : 'low';
              const languageSelection = selectedVariants[language] || { full: false, forced: false };

              if (flags.isForcedOnly) {
                const checked = allowSelection ? Boolean(languageSelection.forced) : Boolean(track?.selectedForEncode);
                const disabled = !allowSelection || burned;
                const actionInfo = resolveSubtitleActionInfo(track, checked);
                return (
                  <div key={`${title}-${track.id}-forced-only-group`} className="media-track-item">
                    {renderVariantRow({
                      key: `${title}-${track.id}-forced-only`,
                      checked,
                      disabled,
                      onChange: (event) => {
                        if (disabled || typeof onToggleSubtitleVariant !== 'function') {
                          return;
                        }
                        onToggleSubtitleVariant(language, 'forced', event.target.checked);
                      },
                      text: `#${track.id} | ${displayLanguage} | Automatische Übersetzungen (${displayCodec})${ccSuffix}`,
                      confidence
                    })}
                    <small className="track-action-note">Untertitel: {actionInfo}</small>
                  </div>
                );
              }

              if (flags.fullHasForced) {
                const checkedFull = allowSelection ? Boolean(languageSelection.full) : Boolean(track?.selectedForEncode);
                const checkedForced = allowSelection ? Boolean(languageSelection.forced) : false;
                const disabled = !allowSelection || burned;
                const actionInfo = resolveSubtitleActionInfo(track, checkedFull || checkedForced);
                return (
                  <div key={`${title}-${track.id}-combo`} className="media-track-item">
                    <div className="media-track-item">
                      <small className="track-action-note">{`#${track.id} | ${displayLanguage}${ccSuffix}`}</small>
                    </div>
                    {renderVariantRow({
                      key: `${title}-${track.id}-combo-full`,
                      checked: checkedFull,
                      disabled,
                      onChange: (event) => {
                        if (disabled || typeof onToggleSubtitleVariant !== 'function') {
                          return;
                        }
                        onToggleSubtitleVariant(language, 'full', event.target.checked);
                      },
                      text: `Komplette Untertitel (${displayCodec})`,
                      indent: true
                    })}
                    {renderVariantRow({
                      key: `${title}-${track.id}-combo-forced`,
                      checked: checkedForced,
                      disabled,
                      onChange: (event) => {
                        if (disabled || typeof onToggleSubtitleVariant !== 'function') {
                          return;
                        }
                        onToggleSubtitleVariant(language, 'forced', event.target.checked);
                      },
                      text: `Automatische Übersetzungen (${displayCodec})`,
                      confidence,
                      indent: true
                    })}
                    <small className="track-action-note">Untertitel: {actionInfo}</small>
                  </div>
                );
              }

              const checked = allowSelection
                ? (trackId !== null && selectedTrackIdSet.has(String(trackId)))
                : Boolean(track?.selectedForEncode);
              const disabled = !allowSelection || burned;
              const actionInfo = resolveSubtitleActionInfo(track, checked);
              return (
                <div key={`${title}-${track.id}-full-group`} className="media-track-item">
                  {renderVariantRow({
                    key: `${title}-${track.id}-full`,
                    checked,
                    disabled,
                    onChange: (event) => {
                      if (disabled || typeof onToggleTrack !== 'function' || trackId === null) {
                        return;
                      }
                      onToggleTrack(trackId, event.target.checked);
                    },
                    text: `#${track.id} | ${displayLanguage} | Komplette Untertitel (${displayCodec})${ccSuffix}`
                  })}
                  <small className="track-action-note">Untertitel: {actionInfo}</small>
                </div>
              );
            })}
          </div>
        )}
        <div className="subtitle-footnote-list">
          <small className="track-action-note">
            Automatische Übersetzungen werden nur eingeblendet, wenn im Film eine andere Sprache gesprochen wird. Komplette Untertitel zeigen alle Dialoge an. Blu-ray Untertitel liegen meist als PGS (Bildformat) vor.
          </small>
          <small className="track-action-note">
            Confidence-Index (nur für Automatische Übersetzungen): <span style={{ color: '#2e7d32' }}>●</span> high = explizites Track-Signal erkannt, <span style={{ color: '#f57c00' }}>●</span> medium = "forced" im Titel erkannt, <span style={{ color: '#c62828' }}>●</span> low = heuristische Einschätzung.
          </small>
        </div>
      </div>

    );
  }

  const selectedIds = normalizeTrackIdList(selectedTrackIds);
  const checkedTrackOrder = orderedTracks
    .map((track) => normalizeTrackId(track?.id))
    .filter((trackId, index) => {
      if (trackId === null) {
        return false;
      }
      if (allowSelection) {
        return selectedIds.includes(trackId);
      }
      const track = orderedTracks[index];
      return Boolean(track?.selectedForEncode);
    });

  return (
    <div>
      <h4>{title}</h4>
      {!tracks || tracks.length === 0 ? (
        <p>Keine Einträge.</p>
      ) : (
        <div className="media-track-list">
          {orderedTracks.map((track) => {
            const trackId = normalizeTrackId(track.id);
            const checked = allowSelection
              ? (trackId !== null && selectedIds.includes(trackId))
              : Boolean(track.selectedForEncode);
            const selectedIndex = trackId !== null
              ? checkedTrackOrder.indexOf(trackId)
              : -1;
            const actionInfo = type === 'audio'
              ? (checked
                ? (() => {
                  // When encoder comes from user preset extraArgs, always recompute
                  // (server-stored summary reflects a different/default preset)
                  if (audioSelector?.encoderSource === 'args') {
                    return buildAudioActionPreviewSummary(track, selectedIndex, audioSelector);
                  }
                  const base = String(track.encodePreviewSummary || track.encodeActionSummary || '').trim();
                  const staleUnselectedSummary = /^nicht übernommen$/i.test(base);
                  if (staleUnselectedSummary) {
                    return buildAudioActionPreviewSummary(track, selectedIndex, audioSelector);
                  }
                  return base || buildAudioActionPreviewSummary(track, selectedIndex, audioSelector);
                })()
                : 'Nicht übernommen')
              : null;
            const displayLanguage = toLang2(track.language || track.languageLabel || 'und');
            const displayHint = track.description || track.title;
            const displayCodec = simplifyCodec(type, track.format, displayHint);
            const displayChannelCount = channelCount(track.channels);
            const displayAudioTitle = audioChannelLabel(track.channels);
            const audioVariant = type === 'audio' ? extractAudioVariant(displayHint) : '';
            const disabled = !allowSelection;

            let displayText = `#${track.id} | ${displayLanguage} | ${displayCodec}`;
            if (type === 'audio') {
              if (displayChannelCount !== null) {
                displayText += ` | ${displayChannelCount}ch`;
              }
              if (displayAudioTitle) {
                displayText += ` | ${displayAudioTitle}`;
              }
              if (audioVariant) {
                displayText += ` | ${audioVariant}`;
              }
            }
            return (
              <div key={`${title}-${track.id}`} className="media-track-item">
                <label className="readonly-check-row">
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={(event) => {
                      if (disabled || typeof onToggleTrack !== 'function' || trackId === null) {
                        return;
                      }
                      onToggleTrack(trackId, event.target.checked);
                    }}
                    readOnly={disabled}
                    disabled={disabled}
                  />
                  <span>
                    {displayText}
                  </span>
                </label>
                {actionInfo ? <small className="track-action-note">Encode: {actionInfo}</small> : null}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function normalizeTitleId(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return Math.trunc(parsed);
}

function normalizeScriptId(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return Math.trunc(parsed);
}

function normalizeChainId(value) {
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

export default function MediaInfoReviewPanel({
  review,
  presetDisplayValue = '',
  commandOutputPath = null,
  commandOutputPathByTitle = {},
  selectedEncodeTitleId = null,
  selectedEncodeTitleIds = [],
  displayOnlySelectedTitle = false,
  titleSelectionTouched = false,
  allowTitleSelection = false,
  compactTitleSelection = false,
  onSelectEncodeTitle = null,
  onToggleEncodeTitle = null,
  allowTrackSelection = false,
  trackSelectionByTitle = {},
  onTrackSelectionChange = null,
  onSubtitleVariantSelectionChange = null,
  selectedMetadataEpisodes = [],
  selectedEpisodeFillStart = null,
  onEpisodeFillStartChange = null,
  episodeAssignmentsByTitle = {},
  onEpisodeAssignmentChange = null,
  allowEpisodeAssignments = false,
  availableScripts = [],
  availableChains = [],
  preEncodeItems = [],
  postEncodeItems = [],
  allowEncodeItemSelection = false,
  onAddPreEncodeItem = null,
  onChangePreEncodeItem = null,
  onRemovePreEncodeItem = null,
  onReorderPreEncodeItem = null,
  onAddPostEncodeItem = null,
  onChangePostEncodeItem = null,
  onRemovePostEncodeItem = null,
  onReorderPostEncodeItem = null,
  userPresets = [],
  selectedUserPresetId = null,
  onUserPresetChange = null,
  selectedHandBrakePreset = '',
  onHandBrakePresetChange = null,
  presetSelectionExplicitlyCleared = false,
  onPresetTokenChange = null,
  handBrakePresetOptions = [],
  comparisonReviewItems = [],
  topContent = null
}) {
  if (!review) {
    return <p>Keine Mediainfo-Daten vorhanden.</p>;
  }

  const titles = review.titles || [];
  const candidateTitles = compactTitleSelection && Array.isArray(review?.handBrakeTitleCandidates)
    ? review.handBrakeTitleCandidates
        .map((candidate) => {
          const id = normalizeTitleId(candidate?.handBrakeTitleId);
          if (id === null) return null;
          const durationSeconds = Number(candidate?.durationSeconds || 0);
          const durationMinutes = Number.isFinite(durationSeconds) && durationSeconds > 0
            ? Number((durationSeconds / 60).toFixed(2))
            : Number(candidate?.durationMinutes || 0);
          return {
            id,
            fileName: `Titel #${id}`,
            durationSeconds: Number.isFinite(durationSeconds) ? durationSeconds : 0,
            durationMinutes: Number.isFinite(durationMinutes) ? durationMinutes : 0,
            sizeBytes: Number(candidate?.sizeBytes || 0),
            audioTrackCount: Number(candidate?.audioTrackCount || 0),
            subtitleTrackCount: Number(candidate?.subtitleTrackCount || 0),
            audioTracks: [],
            subtitleTracks: [],
            selectedForEncode: false
          };
        })
        .filter(Boolean)
    : null;
  const displayTitles = candidateTitles && candidateTitles.length > 0 ? candidateTitles : titles;
  const explicitSelectedTitleIds = normalizeTrackIdList(selectedEncodeTitleIds);
  const fallbackSelectedTitleIds = normalizeTrackIdList([
    ...normalizeTrackIdList(review?.selectedTitleIds || []),
    ...displayTitles.filter((item) => Boolean(item?.selectedForEncode)).map((item) => item?.id)
  ]);
  const selectedTitleIds = titleSelectionTouched
    ? explicitSelectedTitleIds
    : (explicitSelectedTitleIds.length > 0 ? explicitSelectedTitleIds : fallbackSelectedTitleIds);
  const currentSelectedId = normalizeTitleId(selectedEncodeTitleId)
    || (titleSelectionTouched ? null : normalizeTitleId(review.encodeInputTitleId))
    || selectedTitleIds[0]
    || null;
  const selectedTitleIdSet = new Set(selectedTitleIds.map((id) => String(id)));
  const visibleDisplayTitles = displayOnlySelectedTitle && currentSelectedId !== null
    ? displayTitles.filter((title) => normalizeTitleId(title?.id) === currentSelectedId)
    : displayTitles;
  const normalizedComparisonReviews = (Array.isArray(comparisonReviewItems) ? comparisonReviewItems : [])
    .map((item) => {
      const reviewCandidate = item?.review && typeof item.review === 'object'
        ? item.review
        : null;
      if (!reviewCandidate || !Array.isArray(reviewCandidate?.titles) || reviewCandidate.titles.length === 0) {
        return null;
      }
      const jobId = normalizeTitleId(item?.jobId);
      const discNumber = normalizePositiveInt(item?.discNumber);
      return {
        jobId,
        discNumber,
        review: reviewCandidate
      };
    })
    .filter(Boolean);
  const encodeInputTitle = displayTitles.find((item) => item.id === currentSelectedId) || null;
  const normalizedEpisodeRows = (Array.isArray(selectedMetadataEpisodes) ? selectedMetadataEpisodes : [])
    .map((episode) => {
      const episodeId = Number(episode?.episodeId ?? episode?.id ?? 0);
      const episodeIdStart = Number(episode?.episodeIdStart ?? episode?.idStart ?? episode?.episodeId ?? episode?.id ?? 0);
      const episodeIdEnd = Number(episode?.episodeIdEnd ?? episode?.idEnd ?? 0);
      const episodeNumberStart = Number(
        episode?.episodeNumberStart
        ?? episode?.numberStart
        ?? episode?.episodeNoStart
        ?? episode?.episodeNumber
        ?? episode?.number
        ?? 0
      );
      const episodeNumberEnd = Number(
        episode?.episodeNumberEnd
        ?? episode?.numberEnd
        ?? episode?.episodeNoEnd
        ?? 0
      );
      const episodeSpan = Number(episode?.episodeSpan ?? episode?.episodeCount ?? 0);
      const episodeNumber = Number(episode?.episodeNumber ?? episode?.number ?? episodeNumberStart ?? 0);
      const seasonNumber = Number(episode?.seasonNumber ?? episode?.season ?? 0);
      const episodeTitle = String(episode?.episodeTitle || episode?.name || episode?.title || '').trim();
      return {
        episodeId: Number.isFinite(episodeId) && episodeId > 0 ? Math.trunc(episodeId) : null,
        episodeIdStart: Number.isFinite(episodeIdStart) && episodeIdStart > 0 ? Math.trunc(episodeIdStart) : null,
        episodeIdEnd: Number.isFinite(episodeIdEnd) && episodeIdEnd > 0 ? Math.trunc(episodeIdEnd) : null,
        episodeNumber: Number.isFinite(episodeNumber) && episodeNumber > 0 ? Math.trunc(episodeNumber) : null,
        episodeNumberStart: Number.isFinite(episodeNumberStart) && episodeNumberStart > 0 ? Math.trunc(episodeNumberStart) : null,
        episodeNumberEnd: Number.isFinite(episodeNumberEnd) && episodeNumberEnd > 0 ? Math.trunc(episodeNumberEnd) : null,
        episodeSpan: Number.isFinite(episodeSpan) && episodeSpan > 0 ? Math.trunc(episodeSpan) : null,
        seasonNumber: Number.isFinite(seasonNumber) && seasonNumber > 0 ? Math.trunc(seasonNumber) : null,
        episodeTitle: episodeTitle || null
      };
    })
    .filter((episode) => episode.episodeId || episode.episodeNumber !== null);
  const selectedTitlesForFill = selectedTitleIds.length > 0
    ? displayTitles.filter((title) => selectedTitleIdSet.has(String(normalizeTitleId(title?.id))))
    : displayTitles.filter((title) => Boolean(title?.selectedForEncode));
  const titleAnchorsByEpisodeIndex = (() => {
    const anchors = new Map();
    const rows = Array.isArray(normalizedEpisodeRows) ? normalizedEpisodeRows : [];
    if (rows.length === 0) {
      return anchors;
    }
    let cursor = 0;
    for (const title of selectedTitlesForFill) {
      if (cursor >= rows.length) {
        break;
      }
      const explicitSpan = normalizePositiveInt(
        title?.episodeSpan
        ?? title?.episodeCount
        ?? null
      );
      const estimatedSpan = estimateEpisodeSpanForFill(title, selectedTitlesForFill);
      const span = Math.max(1, explicitSpan || 1, estimatedSpan || 1);
      const safeSpan = Math.max(1, Math.min(span, rows.length - cursor));
      anchors.set(cursor, { span: safeSpan });
      cursor += safeSpan;
    }
    return anchors;
  })();

  const fallbackEpisodeFillOptions = (() => {
    const rows = Array.isArray(normalizedEpisodeRows) ? normalizedEpisodeRows : [];
    const options = [];
    let index = 0;
    while (index < rows.length) {
      const startRow = rows[index];
      const seasonNumber = normalizePositiveInt(startRow?.seasonNumber ?? null);
      const seasonLabel = seasonNumber !== null ? `S${String(seasonNumber).padStart(2, '0')}` : 'S??';
      const rangeStart = normalizePositiveInt(
        startRow?.episodeNumberStart
        ?? startRow?.episodeNoStart
        ?? startRow?.episodeNumber
        ?? null
      );
      const explicitRangeEnd = normalizePositiveInt(
        startRow?.episodeNumberEnd
        ?? startRow?.episodeNoEnd
        ?? null
      );
      const explicitRangeSpan = normalizePositiveInt(
        startRow?.episodeSpan
        ?? startRow?.episodeCount
        ?? null
      );
      let consumedRows = 1;
      let rangeEnd = explicitRangeEnd || rangeStart;

      if (
        rangeStart
        && (
          (explicitRangeEnd && explicitRangeEnd > rangeStart)
          || (explicitRangeSpan && explicitRangeSpan > 1)
        )
      ) {
        const effectiveSpan = explicitRangeEnd && explicitRangeEnd > rangeStart
          ? Math.max(1, explicitRangeEnd - rangeStart + 1)
          : Math.max(1, explicitRangeSpan || 1);
        rangeEnd = rangeStart + effectiveSpan - 1;
        consumedRows = 1;
      } else {
        const anchor = titleAnchorsByEpisodeIndex.get(index) || null;
        const anchorSpan = normalizePositiveInt(anchor?.span) || 1;
        if (anchorSpan > 1) {
          const endIndex = Math.min(rows.length - 1, index + anchorSpan - 1);
          const endRow = rows[endIndex];
          const endRowStart = normalizePositiveInt(
            endRow?.episodeNumberStart
            ?? endRow?.episodeNoStart
            ?? endRow?.episodeNumber
            ?? null
          );
          rangeEnd = endRowStart || (rangeStart ? (rangeStart + anchorSpan - 1) : null);
          consumedRows = anchorSpan;
        }
      }

      if (rangeStart && rangeEnd && rangeEnd < rangeStart) {
        rangeEnd = rangeStart;
      }
      const isMulti = Boolean(rangeStart && rangeEnd && rangeEnd > rangeStart);
      const episodeRangeToken = buildEpisodeRangeToken(rangeStart, rangeEnd);
      const partsToken = buildEpisodePartsToken(rangeStart, rangeEnd);
      const baseTitle = String(startRow?.episodeTitle || '(ohne Titel)').trim() || '(ohne Titel)';
      const normalizedTitle = normalizeEpisodeFillTitle(baseTitle, isMulti);
      const titleLabel = isMulti
        ? `${normalizedTitle} (Teil ${partsToken})`
        : normalizedTitle;
      const episodeLabel = rangeStart ? `E${episodeRangeToken}` : 'E??';
      const value = String(
        startRow?.episodeIdStart
        || startRow?.episodeId
        || rangeStart
        || ''
      );
      if (value) {
        options.push({
          label: `${seasonLabel}${episodeLabel} - ${titleLabel}`,
          value,
          startRef: value
        });
      }
      index += Math.max(1, consumedRows);
    }
    return options;
  })();
  const episodeFillOptions = fallbackEpisodeFillOptions;
  const selectedEpisodeFillValue = (() => {
    const raw = String(selectedEpisodeFillStart || '').trim();
    if (!raw) {
      return null;
    }
    const direct = episodeFillOptions.find((option) => String(option?.value || '').trim() === raw);
    if (direct) {
      return direct.value;
    }
    const byStartRef = episodeFillOptions.find((option) => String(option?.startRef || '').trim() === raw);
    if (byStartRef) {
      return byStartRef.value;
    }
    const tokenMatch = raw.match(/^fill:([^:]+):title:\d+$/i);
    if (tokenMatch && tokenMatch[1]) {
      const byTokenRef = episodeFillOptions.find((option) => String(option?.startRef || '').trim() === String(tokenMatch[1]).trim());
      if (byTokenRef) {
        return byTokenRef.value;
      }
    }
    return null;
  })();
  const processedFiles = Number(review.processedFiles || displayTitles.length || 0);
  const totalFiles = Number(review.totalFiles || displayTitles.length || 0);
  const playlistRecommendation = review.playlistRecommendation || null;
  const selectedPlaylistId = String(
    review?.selectedPlaylistId
    ?? review?.selectedPlaylist
    ?? ''
  ).trim();
  const rawPreset = String(review.selectors?.preset || '').trim();
  const presetLabel = String(presetDisplayValue || rawPreset).trim() || '(kein Preset)';
  const multipartSettingsLock = review?.multipartSettingsLock && typeof review.multipartSettingsLock === 'object'
    ? review.multipartSettingsLock
    : null;
  const multipartSettingsLocked = Boolean(multipartSettingsLock?.enabled);
  const multipartLockSourceJobId = Number.isFinite(Number(multipartSettingsLock?.sourceJobId))
    && Number(multipartSettingsLock.sourceJobId) > 0
    ? Math.trunc(Number(multipartSettingsLock.sourceJobId))
    : null;
  const multipartLockSourceDiscNumber = Number.isFinite(Number(multipartSettingsLock?.sourceDiscNumber))
    && Number(multipartSettingsLock.sourceDiscNumber) > 0
    ? Math.trunc(Number(multipartSettingsLock.sourceDiscNumber))
    : null;
  const isTitleSelectionMode = Boolean(
    review?.playlistDecisionRequired
    || review?.titleSelectionRequired
    || review?.handBrakeTitleDecisionRequired
  );
  const playlistAlreadyAccepted = !isTitleSelectionMode && Boolean(selectedPlaylistId);
  const hiddenTechnicalNotePatternsWhenPlaylistAccepted = [
    /^Preset:\s/i,
    /^Extra Args:\s/i,
    /^Preset-Quelle:\s/i,
    /^Preset-Defaults werden als Basis genutzt\./i,
    /^Preset-Hinweis:\s/i,
    /^Manuelle Playlist-Auswahl aktiv:\s/i,
    /^MakeMKV Full-Analyse wurde einmal für Playlist-\/Titel-Mapping verwendet\./i,
    /^HandBrake Track-Analyse aktiv:\s/i
  ];
  const visibleReviewNotes = Array.isArray(review.notes)
    ? review.notes.filter((note) => {
      const normalized = String(note || '').trim();
      if (!normalized) {
        return false;
      }
      if (!playlistAlreadyAccepted) {
        return true;
      }
      return !hiddenTechnicalNotePatternsWhenPlaylistAccepted
        .some((pattern) => pattern.test(normalized));
    })
    : [];

  // User preset resolution
  const normalizedUserPresets = Array.isArray(userPresets) ? userPresets : [];
  const normalizedHandBrakePresetOptions = Array.isArray(handBrakePresetOptions) ? handBrakePresetOptions : [];
  const selectedUserPreset = selectedUserPresetId
    ? normalizedUserPresets.find((p) => Number(p.id) === Number(selectedUserPresetId)) || null
    : null;
  const hasUserPresets = normalizedUserPresets.length > 0;
  const hasHandBrakePresetOptions = normalizedHandBrakePresetOptions.some((option) => !option?.disabled);
  const allowPresetSelection = allowEncodeItemSelection
    && (typeof onUserPresetChange === 'function' || typeof onHandBrakePresetChange === 'function')
    && (hasUserPresets || hasHandBrakePresetOptions);
  const isUserPresetActive = Boolean(selectedUserPreset);
  const trimmedHandBrakePreset = String(selectedHandBrakePreset || '').trim();
  const isHandBrakePresetActive = !isUserPresetActive && Boolean(trimmedHandBrakePreset);
  const settingsPresetFallback = String(review?.selectors?.preset || '').trim();
  const settingsExtraArgsFallback = String(review?.selectors?.extraArgs || '').trim();
  const hasNoExplicitPresetSelected = !isUserPresetActive && !isHandBrakePresetActive;
  const effectiveSettingsPresetFallback = presetSelectionExplicitlyCleared ? '' : settingsPresetFallback;
  const hasSettingsPresetFallback = Boolean(effectiveSettingsPresetFallback);
  const hasSettingsExtraArgsFallback = Boolean(settingsExtraArgsFallback);
  const hasInvalidPresetConfig = hasNoExplicitPresetSelected
    && !hasSettingsPresetFallback
    && !hasSettingsExtraArgsFallback;
  const hasSettingsArgsOnlyConfig = hasNoExplicitPresetSelected
    && !hasSettingsPresetFallback
    && hasSettingsExtraArgsFallback;
  const effectivePresetOverride = isUserPresetActive
    ? { handbrakePreset: selectedUserPreset.handbrakePreset || '', extraArgs: selectedUserPreset.extraArgs || '' }
    : (isHandBrakePresetActive
      ? { handbrakePreset: trimmedHandBrakePreset, extraArgs: settingsExtraArgsFallback }
      : (presetSelectionExplicitlyCleared
        ? { handbrakePreset: '', extraArgs: settingsExtraArgsFallback }
        : null));
  const effectiveAudioSelector = effectivePresetOverride?.extraArgs
    ? parseAudioSelectorFromArgs(effectivePresetOverride.extraArgs, review?.selectors?.audio)
    : (review?.selectors?.audio || null);
  const activePresetDisplayLabel = isUserPresetActive
    ? 'User-Preset'
    : (isHandBrakePresetActive
      ? 'HandBrake-Preset'
      : (presetSelectionExplicitlyCleared ? 'Kein Preset' : (String(presetLabel || '').trim() ? 'HandBrake-Preset' : '(kein Preset)')));
  const minLengthMinutes = Number(review?.minLengthMinutes);
  const minLengthLabel = Number.isFinite(minLengthMinutes)
    ? (minLengthMinutes <= 0
      ? 'Kein Mindestwert (deaktiviert)'
      : `${Math.trunc(minLengthMinutes)} Minute(n)`)
    : '-';
  const subtitleSelector = review?.selectors?.subtitle && typeof review.selectors.subtitle === 'object'
    ? review.selectors.subtitle
    : {};
  const effectiveSubtitleSelector = effectivePresetOverride?.extraArgs
    ? parseSubtitleSelectorFromArgs(effectivePresetOverride.extraArgs, subtitleSelector)
    : subtitleSelector;
  const subtitleModeLabelMap = {
    all: 'Alle Spuren',
    first: 'Erste Spur',
    language: 'Nach Sprache',
    explicit: 'Manuell (Track-IDs)',
    none: 'Keine Spuren'
  };
  const subtitleModeLabel = subtitleModeLabelMap[String(effectiveSubtitleSelector?.mode || '').trim().toLowerCase()] || '-';
  const subtitleFlagLabels = [];
  if (effectiveSubtitleSelector?.burnBehavior === 'first') {
    subtitleFlagLabels.push('Burn-In (erste Subtitle-Spur)');
  }
  if (effectiveSubtitleSelector?.defaultTrackId != null) {
    subtitleFlagLabels.push(`Default-Track #${effectiveSubtitleSelector.defaultTrackId}`);
  }
  if (effectiveSubtitleSelector?.forcedTrackId != null) {
    subtitleFlagLabels.push(`Forced-Track #${effectiveSubtitleSelector.forcedTrackId}`);
  } else if (effectiveSubtitleSelector?.forcedOnly) {
    subtitleFlagLabels.push('Forced-Only');
  }
  const subtitleFlagsLabel = subtitleFlagLabels.join(', ') || 'Keine';
  const audioEncoderSourceLabel = String(effectiveAudioSelector?.encoderSource || '').trim() || 'default';
  const audioCopyMaskSourceLabel = String(effectiveAudioSelector?.copyMaskSource || '').trim() || 'default';
  const audioFallbackSourceLabel = String(effectiveAudioSelector?.fallbackSource || '').trim() || 'default';
  const presetDropdownOptions = (() => {
    const options = [{ label: 'Kein Preset', value: 'none' }];
    if (hasUserPresets) {
      options.push({ label: 'User-Presets/', value: '__group__userpresets', disabled: true });
      for (const preset of normalizedUserPresets) {
        const presetId = Number(preset?.id);
        if (!Number.isFinite(presetId) || presetId <= 0) {
          continue;
        }
        const mediaType = String(preset?.mediaType || '').trim().toLowerCase();
        const mediaTypeLabel = mediaType && mediaType !== 'all'
          ? ` [${mediaType === 'bluray' ? 'Blu-ray' : mediaType === 'dvd' ? 'DVD' : mediaType}]`
          : '';
        options.push({
          label: `\u00A0\u00A0\u00A0${String(preset?.name || `Preset #${presetId}`).trim() || `Preset #${presetId}`}${mediaTypeLabel}`,
          value: `user:${Math.trunc(presetId)}`
        });
      }
    }
    for (const option of normalizedHandBrakePresetOptions) {
      if (!option) {
        continue;
      }
      if (option.disabled) {
        options.push({
          label: String(option?.label || '').trim() || 'HandBrake/',
          value: String(option?.value || option?.label || '').trim() || `__group__hb_${options.length}`,
          disabled: true
        });
        continue;
      }
      const value = String(option?.value || '').trim();
      if (!value) {
        continue;
      }
      options.push({
        label: String(option?.label || value).trim() || value,
        value: `hb:${value}`
      });
    }
    const selectedPresetValue = String(selectedHandBrakePreset || '').trim();
    if (selectedPresetValue && !options.some((entry) => String(entry?.value || '').trim() === `hb:${selectedPresetValue}`)) {
      options.push({
        label: selectedPresetValue,
        value: `hb:${selectedPresetValue}`
      });
    }
    return options;
  })();
  const selectedPresetToken = isUserPresetActive
    ? `user:${selectedUserPreset.id}`
    : (trimmedHandBrakePreset ? `hb:${trimmedHandBrakePreset}` : 'none');

  const scriptCatalog = (Array.isArray(availableScripts) ? availableScripts : [])
    .map((item) => ({
      id: normalizeScriptId(item?.id),
      name: String(item?.name || '').trim()
    }))
    .filter((item) => item.id !== null && item.name.length > 0);
  const scriptById = new Map(scriptCatalog.map((item) => [item.id, item]));
  const chainCatalog = (Array.isArray(availableChains) ? availableChains : [])
    .map((item) => ({ id: normalizeChainId(item?.id), name: String(item?.name || '').trim() }))
    .filter((item) => item.id !== null && item.name.length > 0);
  const chainById = new Map(chainCatalog.map((item) => [item.id, item]));

  const makeHandleDrop = (items, onReorder) => (event, targetIndex) => {
    if (!allowEncodeItemSelection || typeof onReorder !== 'function' || items.length < 2) {
      return;
    }
    event.preventDefault();
    const fromIndex = Number(event.dataTransfer?.getData('text/plain'));
    if (!Number.isInteger(fromIndex)) {
      return;
    }
    onReorder(fromIndex, targetIndex);
  };

  const handlePreDrop = makeHandleDrop(preEncodeItems, onReorderPreEncodeItem);
  const handlePostDrop = makeHandleDrop(postEncodeItems, onReorderPostEncodeItem);

  const resolveTitleSelectionState = (title) => {
    const titleSelectionEntry = trackSelectionByTitle?.[title.id] || trackSelectionByTitle?.[String(title.id)] || {};
    const subtitleTracks = Array.isArray(title.subtitleTracks) ? title.subtitleTracks : [];
    const selectableSubtitleTrackIds = subtitleTracks
      .filter((track) => !isBurnedSubtitleTrack(track) && !isDuplicateSubtitleTrack(track))
      .map((track) => normalizeTrackId(track?.id))
      .filter((id) => id !== null);
    const selectableSubtitleTrackIdSet = new Set(selectableSubtitleTrackIds.map((id) => String(id)));
    const sortedSelectableSubtitleTracks = subtitleTracks
      .filter((track) => !isBurnedSubtitleTrack(track) && !isDuplicateSubtitleTrack(track))
      .slice()
      .sort((a, b) => (normalizeTrackId(a?.id) || Number.MAX_SAFE_INTEGER) - (normalizeTrackId(b?.id) || Number.MAX_SAFE_INTEGER));
    const defaultAudioTrackIds = (Array.isArray(title.audioTracks) ? title.audioTracks : [])
      .filter((track) => Boolean(track?.selectedByRule))
      .map((track) => normalizeTrackId(track?.id))
      .filter((id) => id !== null);
    const defaultSubtitleTrackIds = subtitleTracks
      .filter((track) => Boolean(track?.selectedByRule) && !isBurnedSubtitleTrack(track) && !isDuplicateSubtitleTrack(track))
      .map((track) => normalizeTrackId(track?.id))
      .filter((id) => id !== null);
    const defaultSubtitleVariantSelection = {};
    const defaultSubtitleLanguageOrder = [];
    const subtitleLanguageOrderSeen = new Set();
    for (const track of sortedSelectableSubtitleTracks) {
      const language = normalizeSubtitleLanguage(track?.language || track?.languageLabel || 'und');
      if (!subtitleLanguageOrderSeen.has(language)) {
        subtitleLanguageOrderSeen.add(language);
        defaultSubtitleLanguageOrder.push(language);
      }
      if (!Boolean(track?.selectedByRule)) {
        continue;
      }
      if (!defaultSubtitleVariantSelection[language]) {
        defaultSubtitleVariantSelection[language] = { full: false, forced: false };
      }
      const flags = resolveSubtitleTrackVariantFlags(track);
      if (flags.isForcedOnly) {
        defaultSubtitleVariantSelection[language].forced = true;
      } else {
        defaultSubtitleVariantSelection[language].full = true;
      }
    }

    const selectedAudioTrackIds = normalizeTrackIdList(
      Array.isArray(titleSelectionEntry?.audioTrackIds)
        ? titleSelectionEntry.audioTrackIds
        : defaultAudioTrackIds
    );
    const selectedSubtitleTrackIds = normalizeTrackIdList(
      Array.isArray(titleSelectionEntry?.subtitleTrackIds)
        ? titleSelectionEntry.subtitleTrackIds
        : defaultSubtitleTrackIds
    ).filter((id) => selectableSubtitleTrackIdSet.has(String(id)));
    const selectedSubtitleVariantSelection = normalizeSubtitleVariantSelectionMap(
      titleSelectionEntry?.subtitleVariantSelection || defaultSubtitleVariantSelection
    );
    const selectedSubtitleSelectionMode = normalizeSubtitleSelectionMode(
      titleSelectionEntry?.subtitleSelectionMode,
      Object.keys(selectedSubtitleVariantSelection).length > 0
        ? 'variants'
        : 'track_ids'
    );
    const selectedSubtitleLanguageOrder = normalizeSubtitleLanguageOrder(
      Array.isArray(titleSelectionEntry?.subtitleLanguageOrder)
        ? titleSelectionEntry.subtitleLanguageOrder
        : defaultSubtitleLanguageOrder
    );
    return {
      titleSelectionEntry,
      subtitleTracks,
      selectedAudioTrackIds,
      selectedSubtitleTrackIds,
      selectedSubtitleSelectionMode,
      selectedSubtitleVariantSelection,
      selectedSubtitleLanguageOrder
    };
  };

  const normalizeTrackSignatureText = (value) => String(value || '').trim().toLowerCase();
  const buildAudioSignature = (track) => [
    normalizeTrackSignatureText(track?.language || track?.languageLabel || 'und'),
    normalizeTrackSignatureText(track?.format || track?.codecName || ''),
    normalizeTrackSignatureText(track?.channels || ''),
    normalizeTrackSignatureText(track?.description || track?.title || '')
  ].join('|');
  const buildSubtitleSignature = (track) => {
    const flags = resolveSubtitleTrackVariantFlags(track);
    return [
      normalizeTrackSignatureText(track?.language || track?.languageLabel || 'und'),
      normalizeTrackSignatureText(track?.format || track?.codecName || ''),
      flags.isForcedOnly ? 'forced' : 'full',
      flags.fullHasForced ? 'with_forced_variant' : 'plain'
    ].join('|');
  };

  const selectedTitlesForGlobal = selectedTitleIds.length > 0
    ? titles.filter((title) => selectedTitleIdSet.has(String(normalizeTitleId(title?.id))))
    : titles;
  const masterGlobalTitle = selectedTitlesForGlobal[0] || titles[0] || null;
  const globalMasterSelectionState = masterGlobalTitle ? resolveTitleSelectionState(masterGlobalTitle) : null;
  const globalAudioTrackMaps = new Map();
  const globalSubtitleLanguagesByTitle = new Map();
  const globalTrackCompatibility = (() => {
    if (!masterGlobalTitle || selectedTitlesForGlobal.length < 2) {
      return { audio: false, subtitle: false };
    }
    const masterAudioTracks = Array.isArray(masterGlobalTitle.audioTracks) ? masterGlobalTitle.audioTracks : [];
    const masterSubtitleTracks = (Array.isArray(masterGlobalTitle.subtitleTracks) ? masterGlobalTitle.subtitleTracks : [])
      .filter((track) => !isBurnedSubtitleTrack(track) && !isDuplicateSubtitleTrack(track));
    const masterAudioSignatures = masterAudioTracks.map((track) => buildAudioSignature(track)).sort();
    const masterSubtitleSignatures = masterSubtitleTracks.map((track) => buildSubtitleSignature(track)).sort();
    const masterSubtitleLanguages = Array.from(new Set(masterSubtitleTracks.map((track) =>
      normalizeSubtitleLanguage(track?.language || track?.languageLabel || 'und')
    ))).sort();

    let audioCompatible = true;
    let subtitleCompatible = true;
    for (const title of selectedTitlesForGlobal) {
      const titleId = normalizeTitleId(title?.id);
      if (!titleId) {
        continue;
      }
      const audioMap = new Map();
      const titleAudioTracks = Array.isArray(title.audioTracks) ? title.audioTracks : [];
      const titleAudioSignatures = titleAudioTracks.map((track) => {
        const signature = buildAudioSignature(track);
        const trackId = normalizeTrackId(track?.id);
        if (trackId !== null && !audioMap.has(signature)) {
          audioMap.set(signature, trackId);
        }
        return signature;
      }).sort();
      globalAudioTrackMaps.set(titleId, audioMap);
      if (titleAudioSignatures.join('||') !== masterAudioSignatures.join('||')) {
        audioCompatible = false;
      }

      const subtitleTracks = (Array.isArray(title.subtitleTracks) ? title.subtitleTracks : [])
        .filter((track) => !isBurnedSubtitleTrack(track) && !isDuplicateSubtitleTrack(track));
      const subtitleSignatures = subtitleTracks.map((track) => buildSubtitleSignature(track)).sort();
      const subtitleLanguages = Array.from(new Set(subtitleTracks.map((track) =>
        normalizeSubtitleLanguage(track?.language || track?.languageLabel || 'und')
      ))).sort();
      globalSubtitleLanguagesByTitle.set(titleId, subtitleLanguages);
      if (subtitleSignatures.join('||') !== masterSubtitleSignatures.join('||')) {
        subtitleCompatible = false;
      }
      if (subtitleLanguages.join('||') !== masterSubtitleLanguages.join('||')) {
        subtitleCompatible = false;
      }
    }
    return { audio: audioCompatible, subtitle: subtitleCompatible };
  })();
  const showGlobalEpisodeTrackControls = Boolean(
    allowTrackSelection
    && allowTitleSelection
    && masterGlobalTitle
    && selectedTitlesForGlobal.length > 1
    && globalTrackCompatibility.audio
    && globalTrackCompatibility.subtitle
  );
  const useEpisodeTrackAccordion = Boolean(
    masterGlobalTitle
    && selectedTitlesForGlobal.length > 1
    && globalTrackCompatibility.audio
    && globalTrackCompatibility.subtitle
  );

  return (
    <div className="media-review-wrap">
      {topContent}
      {!compactTitleSelection && allowPresetSelection && (
        <div className="user-preset-selector" style={{ marginBottom: '0.75rem', padding: '0.75rem', border: '1px solid var(--surface-border, #e0e0e0)', borderRadius: '6px', background: 'var(--surface-ground, #f8f8f8)' }}>
          <label style={{ display: 'block', marginBottom: '0.4rem', fontWeight: 600 }}>
            Encode-Preset auswählen
          </label>
          <Dropdown
            value={selectedPresetToken}
            options={presetDropdownOptions}
            optionLabel="label"
            optionValue="value"
            optionDisabled="disabled"
            onChange={(e) => {
              const value = String(e?.value || '').trim();
              if (typeof onPresetTokenChange === 'function') {
                onPresetTokenChange(value);
              }
              if (value.startsWith('user:')) {
                const presetId = Number(value.slice(5));
                if (typeof onUserPresetChange === 'function') {
                  onUserPresetChange(Number.isFinite(presetId) && presetId > 0 ? Math.trunc(presetId) : null);
                }
                if (typeof onHandBrakePresetChange === 'function') {
                  onHandBrakePresetChange('');
                }
                return;
              }
              if (value.startsWith('hb:')) {
                const presetName = value.slice(3);
                if (typeof onUserPresetChange === 'function') {
                  onUserPresetChange(null);
                }
                if (typeof onHandBrakePresetChange === 'function') {
                  onHandBrakePresetChange(presetName);
                }
                return;
              }
              if (value === 'none') {
                if (typeof onUserPresetChange === 'function') {
                  onUserPresetChange(null);
                }
                if (typeof onHandBrakePresetChange === 'function') {
                  onHandBrakePresetChange('');
                }
              }
            }}
            placeholder="Preset auswählen …"
            filter
            style={{ width: '100%' }}
          />
          {selectedUserPreset && (
            <div style={{ marginTop: '0.4rem', fontSize: '0.8rem', opacity: 0.8 }}>
              {selectedUserPreset.handbrakePreset
                ? <span><strong>-Z</strong> {selectedUserPreset.handbrakePreset}</span>
                : <span style={{ opacity: 0.6 }}>(kein Preset-Name)</span>}
              {selectedUserPreset.extraArgs && (
                <span style={{ marginLeft: '1rem' }}><strong>Args:</strong> {selectedUserPreset.extraArgs}</span>
              )}
              {selectedUserPreset.description && (
                <span style={{ marginLeft: '1rem', opacity: 0.7 }}>{selectedUserPreset.description}</span>
              )}
            </div>
          )}
        </div>
      )}
      {!compactTitleSelection && !isTitleSelectionMode && hasInvalidPresetConfig ? (
        <div className="media-review-notes">
          <small>
            Warnung: Weder HandBrake-Preset noch Extra-Args sind in den Settings gesetzt. Der CLI-Command kann so nicht valide gebaut werden.
          </small>
        </div>
      ) : null}
      {!compactTitleSelection && !isTitleSelectionMode && hasSettingsArgsOnlyConfig ? (
        <div className="media-review-notes">
          <small>
            Hinweis: Es wird kein Preset verwendet. Nur CLI-Parameter aus den Settings werden genutzt - bitte auf Korrektheit prüfen.
          </small>
        </div>
      ) : null}
      {!compactTitleSelection && !isTitleSelectionMode ? (
        <div className="media-review-meta">
          <div>
            <strong>Preset:</strong>{' '}
          {activePresetDisplayLabel}
        </div>
        <div><strong>Titel-Mindestlänge:</strong> {minLengthLabel}</div>
   </div>
      ) : null}

      {!compactTitleSelection && review.partial ? (
        <small>Zwischenstand: {processedFiles}/{totalFiles} Datei(en) analysiert.</small>
      ) : null}

      {!compactTitleSelection && !isTitleSelectionMode && !playlistAlreadyAccepted && playlistRecommendation ? (
        <div className="playlist-recommendation-box">
          <small>
            <strong>Empfehlung:</strong> {playlistRecommendation.playlistFile || '-'}
            {playlistRecommendation.reviewTitleId ? ` (Titel #${playlistRecommendation.reviewTitleId})` : ''}
          </small>
          {playlistRecommendation.reason ? <small>{playlistRecommendation.reason}</small> : null}
        </div>
      ) : null}

      {!compactTitleSelection && !isTitleSelectionMode && visibleReviewNotes.length > 0 ? (
        <div className="media-review-notes">
          {visibleReviewNotes.map((note, idx) => (
            <small key={`${idx}-${note}`}>{note}</small>
          ))}
        </div>
      ) : null}
      {!compactTitleSelection && multipartSettingsLocked ? (
        <div className="media-review-notes">
          <small>
            Multipart-Lock aktiv: Auswahl wurde von der Referenz-Disc übernommen und ist in diesem Review nicht editierbar.
            {multipartLockSourceJobId ? ` Quelle Job #${multipartLockSourceJobId}.` : ''}
            {multipartLockSourceDiscNumber ? ` Referenz-Disc ${multipartLockSourceDiscNumber}.` : ''}
          </small>
        </div>
      ) : null}

      {!compactTitleSelection ? (
        <div className="encode-automation-grid">
          {/* Pre-Encode Items (scripts + chains unified) */}
          {(allowEncodeItemSelection || preEncodeItems.length > 0) ? (
            <div className="post-script-box">
          <h4>Pre-Encode Ausführungen (optional)</h4>
          {scriptCatalog.length === 0 && chainCatalog.length === 0 ? (
            <small>Keine Skripte oder Ketten konfiguriert. In den Settings anlegen.</small>
          ) : null}
          {preEncodeItems.length === 0 ? (
            <small>Keine Pre-Encode Ausführungen ausgewählt.</small>
          ) : null}
          {preEncodeItems.map((item, rowIndex) => {
            const isScript = item.type === 'script';
            const canDrag = allowEncodeItemSelection && preEncodeItems.length > 1;
            const scriptObj = isScript ? (scriptById.get(normalizeScriptId(item.id)) || null) : null;
            const chainObj = !isScript ? (chainById.get(Number(item.id)) || null) : null;
            const name = isScript
              ? (scriptObj?.name || `Skript #${item.id}`)
              : (chainObj?.name || `Kette #${item.id}`);
            const usedScriptIds = new Set(
              preEncodeItems
                .filter((it, i) => it.type === 'script' && i !== rowIndex)
                .map((it) => normalizeScriptId(it.id))
                .filter((id) => id !== null)
                .map((id) => String(id))
            );
            const usedChainIds = new Set(
              preEncodeItems
                .filter((it, i) => it.type === 'chain' && i !== rowIndex)
                .map((it) => normalizeChainId(it.id))
                .filter((id) => id !== null)
                .map((id) => String(id))
            );
            const scriptOptions = scriptCatalog.map((s) => ({
              label: s.name,
              value: s.id,
              disabled: usedScriptIds.has(String(s.id))
            }));
            const chainOptions = chainCatalog.map((c) => ({
              label: c.name,
              value: c.id,
              disabled: usedChainIds.has(String(c.id))
            }));
            return (
              <div
                key={`pre-item-${rowIndex}-${item.type}-${item.id}`}
                className={`post-script-row${allowEncodeItemSelection ? ' editable' : ''}`}
                onDragOver={(event) => {
                  if (!canDrag) return;
                  event.preventDefault();
                  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
                }}
                onDrop={(event) => handlePreDrop(event, rowIndex)}
              >
                {allowEncodeItemSelection ? (
                  <>
                    <span
                      className={`post-script-drag-handle pi pi-bars${canDrag ? '' : ' disabled'}`}
                      title={canDrag ? 'Ziehen zum Umordnen' : 'Mindestens zwei Einträge zum Umordnen'}
                      draggable={canDrag}
                      onDragStart={(event) => {
                        if (!canDrag) return;
                        event.dataTransfer.effectAllowed = 'move';
                        event.dataTransfer.setData('text/plain', String(rowIndex));
                      }}
                    />
                    <i className={`post-script-type-icon pi ${isScript ? 'pi-code' : 'pi-link'}`} title={isScript ? 'Skript' : 'Kette'} />
                    {isScript ? (
                      <Dropdown
                        value={normalizeScriptId(item.id)}
                        options={scriptOptions}
                        optionLabel="label"
                        optionValue="value"
                        optionDisabled="disabled"
                        onChange={(event) => onChangePreEncodeItem?.(rowIndex, 'script', event.value)}
                        className="full-width"
                      />
                    ) : (
                      <Dropdown
                        value={normalizeChainId(item.id)}
                        options={chainOptions}
                        optionLabel="label"
                        optionValue="value"
                        optionDisabled="disabled"
                        onChange={(event) => onChangePreEncodeItem?.(rowIndex, 'chain', event.value)}
                        className="full-width"
                      />
                    )}
                    <Button icon="pi pi-times" severity="danger" outlined onClick={() => onRemovePreEncodeItem?.(rowIndex)} />
                  </>
                ) : (
                  <small><i className={`pi ${isScript ? 'pi-code' : 'pi-link'}`} /> {`${rowIndex + 1}. ${name}`}</small>
                )}
              </div>
            );
          })}
          {allowEncodeItemSelection ? (
            <div className="encode-item-add-row">
              {scriptCatalog.length > preEncodeItems.filter((i) => i.type === 'script').length ? (
                <Button
                  label="Skript hinzufügen"
                  icon="pi pi-code"
                  severity="secondary"
                  outlined
                  onClick={() => onAddPreEncodeItem?.('script')}
                />
              ) : null}
              {chainCatalog.length > preEncodeItems.filter((i) => i.type === 'chain').length ? (
                <Button
                  label="Kette hinzufügen"
                  icon="pi pi-link"
                  severity="secondary"
                  outlined
                  onClick={() => onAddPreEncodeItem?.('chain')}
                />
              ) : null}
            </div>
          ) : null}
              <small>Ausführung vor dem Encoding, strikt nacheinander. Bei Fehler wird der Encode abgebrochen.</small>
            </div>
          ) : null}

          {/* Post-Encode Items (scripts + chains unified) */}
          <div className="post-script-box">
        <h4>Post-Encode Ausführungen (optional)</h4>
        {scriptCatalog.length === 0 && chainCatalog.length === 0 ? (
          <small>Keine Skripte oder Ketten konfiguriert. In den Settings anlegen.</small>
        ) : null}
        {postEncodeItems.length === 0 ? (
          <small>Keine Post-Encode Ausführungen ausgewählt.</small>
        ) : null}
        {postEncodeItems.map((item, rowIndex) => {
          const isScript = item.type === 'script';
          const canDrag = allowEncodeItemSelection && postEncodeItems.length > 1;
          const scriptObj = isScript ? (scriptById.get(normalizeScriptId(item.id)) || null) : null;
          const chainObj = !isScript ? (chainById.get(Number(item.id)) || null) : null;
          const name = isScript
            ? (scriptObj?.name || `Skript #${item.id}`)
            : (chainObj?.name || `Kette #${item.id}`);
          const usedScriptIds = new Set(
            postEncodeItems
              .filter((it, i) => it.type === 'script' && i !== rowIndex)
              .map((it) => normalizeScriptId(it.id))
              .filter((id) => id !== null)
              .map((id) => String(id))
          );
          const usedChainIds = new Set(
            postEncodeItems
              .filter((it, i) => it.type === 'chain' && i !== rowIndex)
              .map((it) => normalizeChainId(it.id))
              .filter((id) => id !== null)
              .map((id) => String(id))
          );
          const scriptOptions = scriptCatalog.map((s) => ({
            label: s.name,
            value: s.id,
            disabled: usedScriptIds.has(String(s.id))
          }));
          const chainOptions = chainCatalog.map((c) => ({
            label: c.name,
            value: c.id,
            disabled: usedChainIds.has(String(c.id))
          }));
          return (
            <div
              key={`post-item-${rowIndex}-${item.type}-${item.id}`}
              className={`post-script-row${allowEncodeItemSelection ? ' editable' : ''}`}
              onDragOver={(event) => {
                if (!canDrag) return;
                event.preventDefault();
                if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
              }}
              onDrop={(event) => handlePostDrop(event, rowIndex)}
            >
              {allowEncodeItemSelection ? (
                <>
                  <span
                    className={`post-script-drag-handle pi pi-bars${canDrag ? '' : ' disabled'}`}
                    title={canDrag ? 'Ziehen zum Umordnen' : 'Mindestens zwei Einträge zum Umordnen'}
                    draggable={canDrag}
                    onDragStart={(event) => {
                      if (!canDrag) return;
                      event.dataTransfer.effectAllowed = 'move';
                      event.dataTransfer.setData('text/plain', String(rowIndex));
                    }}
                  />
                  <i className={`post-script-type-icon pi ${isScript ? 'pi-code' : 'pi-link'}`} title={isScript ? 'Skript' : 'Kette'} />
                  {isScript ? (
                    <Dropdown
                      value={normalizeScriptId(item.id)}
                      options={scriptOptions}
                      optionLabel="label"
                      optionValue="value"
                      optionDisabled="disabled"
                      onChange={(event) => onChangePostEncodeItem?.(rowIndex, 'script', event.value)}
                      className="full-width"
                    />
                  ) : (
                    <Dropdown
                      value={normalizeChainId(item.id)}
                      options={chainOptions}
                      optionLabel="label"
                      optionValue="value"
                      optionDisabled="disabled"
                      onChange={(event) => onChangePostEncodeItem?.(rowIndex, 'chain', event.value)}
                      className="full-width"
                    />
                  )}
                  <Button icon="pi pi-times" severity="danger" outlined onClick={() => onRemovePostEncodeItem?.(rowIndex)} />
                </>
              ) : (
                <small><i className={`pi ${isScript ? 'pi-code' : 'pi-link'}`} /> {`${rowIndex + 1}. ${name}`}</small>
              )}
            </div>
          );
        })}
        {allowEncodeItemSelection ? (
          <div className="encode-item-add-row">
            {scriptCatalog.length > postEncodeItems.filter((i) => i.type === 'script').length ? (
              <Button
                label="Skript hinzufügen"
                icon="pi pi-code"
                severity="secondary"
                outlined
                onClick={() => onAddPostEncodeItem?.('script')}
              />
            ) : null}
            {chainCatalog.length > postEncodeItems.filter((i) => i.type === 'chain').length ? (
              <Button
                label="Kette hinzufügen"
                icon="pi pi-link"
                severity="secondary"
                outlined
                onClick={() => onAddPostEncodeItem?.('chain')}
              />
            ) : null}
          </div>
        ) : null}
            <small>Ausführung nach erfolgreichem Encode, strikt nacheinander (Drag-and-Drop möglich).</small>
          </div>
        </div>
      ) : null}

      <h4>Titel</h4>
      {episodeFillOptions.length > 0 ? (
        <div className="episode-fill-box">
          <div className="episode-fill-field">
            <label>Episodentitel befüllen ab Episode</label>
            <Dropdown
              value={selectedEpisodeFillValue}
              options={episodeFillOptions}
              optionLabel="label"
              optionValue="value"
              onChange={(event) => onEpisodeFillStartChange?.(event?.value || null)}
              placeholder="Episode auswählen …"
              disabled={!allowTitleSelection}
              style={{ width: '100%' }}
              filter
            />
            <small>
              Startet bei der gewählten Episode und befüllt alle ausgewählten Episoden-Titel der Reihe nach.
              Multi-Episoden werden als Bereich (z.B. E16-17 | Teil 1+2) angezeigt.
            </small>
          </div>
        </div>
      ) : null}
      {showGlobalEpisodeTrackControls ? (
        <div className="episode-global-selection-box">
          <h4>Spurauswahl für alle Episoden</h4>
          <small>Gilt für alle aktuell gewählten Episoden. Einzelne Episoden können danach weiterhin manuell überschrieben werden.</small>
          <div className="media-track-grid">
            {globalTrackCompatibility.audio && globalMasterSelectionState ? (
              <TrackList
                title="Tonspuren (alle Episoden)"
                tracks={masterGlobalTitle?.audioTracks || []}
                type="audio"
                allowSelection={allowTrackSelection}
                selectedTrackIds={globalMasterSelectionState.selectedAudioTrackIds}
                audioSelector={effectiveAudioSelector}
                onToggleTrack={(masterTrackId, checked) => {
                  if (!allowTrackSelection || typeof onTrackSelectionChange !== 'function') {
                    return;
                  }
                  const masterTrack = (Array.isArray(masterGlobalTitle?.audioTracks) ? masterGlobalTitle.audioTracks : [])
                    .find((track) => normalizeTrackId(track?.id) === normalizeTrackId(masterTrackId));
                  if (!masterTrack) {
                    return;
                  }
                  const signature = buildAudioSignature(masterTrack);
                  for (const title of selectedTitlesForGlobal) {
                    const titleId = normalizeTitleId(title?.id);
                    if (!titleId) {
                      continue;
                    }
                    const titleTrackMap = globalAudioTrackMaps.get(titleId);
                    const mappedTrackId = titleTrackMap?.get(signature) ?? null;
                    if (!mappedTrackId) {
                      continue;
                    }
                    onTrackSelectionChange(titleId, 'audio', mappedTrackId, checked);
                  }
                }}
              />
            ) : (
              <div>
                <h4>Tonspuren (alle Episoden)</h4>
                <small>Globale Auswahl nicht verfügbar, da die Tonspur-Layouts zwischen Episoden abweichen.</small>
              </div>
            )}
            {globalTrackCompatibility.subtitle && globalMasterSelectionState ? (
              <TrackList
                title="Subtitles (alle Episoden)"
                tracks={(Array.isArray(masterGlobalTitle?.subtitleTracks) ? masterGlobalTitle.subtitleTracks : [])
                  .filter((track) => !isBurnedSubtitleTrack(track))}
                type="subtitle"
                allowSelection={allowTrackSelection}
                selectedTrackIds={globalMasterSelectionState.selectedSubtitleTrackIds}
                selectedSubtitleVariantSelection={globalMasterSelectionState.selectedSubtitleVariantSelection}
                selectedSubtitleLanguageOrder={globalMasterSelectionState.selectedSubtitleLanguageOrder}
                onToggleSubtitleVariant={(language, variant, checked) => {
                  if (!allowTrackSelection || typeof onSubtitleVariantSelectionChange !== 'function') {
                    return;
                  }
                  const normalizedLanguage = normalizeSubtitleLanguage(language);
                  for (const title of selectedTitlesForGlobal) {
                    const titleId = normalizeTitleId(title?.id);
                    if (!titleId) {
                      continue;
                    }
                    const subtitleLanguages = globalSubtitleLanguagesByTitle.get(titleId) || [];
                    if (!subtitleLanguages.includes(normalizedLanguage)) {
                      continue;
                    }
                    onSubtitleVariantSelectionChange(titleId, normalizedLanguage, variant, checked);
                  }
                }}
              />
            ) : (
              <div>
                <h4>Subtitles (alle Episoden)</h4>
                <small>Globale Auswahl nicht verfügbar, da die Untertitel-Layouts zwischen Episoden abweichen.</small>
              </div>
            )}
          </div>
        </div>
      ) : null}
      <div className="media-title-list">
        {visibleDisplayTitles.length === 0 ? (
          <p>Keine Titel analysiert.</p>
        ) : visibleDisplayTitles.map((title) => {
          const normalizedTitleId = normalizeTitleId(title.id);
          const displayTitleId = normalizeTitleId(title?.handBrakeTitleId) || normalizedTitleId;
          const titleChecked = (allowTitleSelection || displayOnlySelectedTitle)
            ? (selectedTitleIdSet.size > 0
              ? selectedTitleIdSet.has(String(normalizedTitleId))
              : Boolean(title.selectedForEncode))
            : Boolean(title.selectedForEncode);
          const titleIsPrimary = currentSelectedId !== null && currentSelectedId === normalizedTitleId;
          const titleEpisodeAssignment = episodeAssignmentsByTitle?.[normalizedTitleId]
            || episodeAssignmentsByTitle?.[String(normalizedTitleId)]
            || null;
          const episodeInputValue = String(
            titleEpisodeAssignment?.episodeTitle
            || title?.episodeTitle
            || ''
          );
          const titleSelectionEntry = trackSelectionByTitle?.[title.id] || trackSelectionByTitle?.[String(title.id)] || {};
          const subtitleTracks = Array.isArray(title.subtitleTracks) ? title.subtitleTracks : [];
          const audioCount = Number.isFinite(Number(title?.audioTrackCount))
            ? Number(title.audioTrackCount)
            : (Array.isArray(title.audioTracks) ? title.audioTracks.length : 0);
          const subtitleCount = Number.isFinite(Number(title?.subtitleTrackCount))
            ? Number(title.subtitleTrackCount)
            : subtitleTracks.length;
          const selectableSubtitleTrackIds = subtitleTracks
            .filter((track) => !isBurnedSubtitleTrack(track) && !isDuplicateSubtitleTrack(track))
            .map((track) => normalizeTrackId(track?.id))
            .filter((id) => id !== null);
          const selectableSubtitleTrackIdSet = new Set(selectableSubtitleTrackIds.map((id) => String(id)));
          const sortedSelectableSubtitleTracks = subtitleTracks
            .filter((track) => !isBurnedSubtitleTrack(track) && !isDuplicateSubtitleTrack(track))
            .slice()
            .sort((a, b) => (normalizeTrackId(a?.id) || Number.MAX_SAFE_INTEGER) - (normalizeTrackId(b?.id) || Number.MAX_SAFE_INTEGER));
          const defaultAudioTrackIds = (Array.isArray(title.audioTracks) ? title.audioTracks : [])
            .filter((track) => Boolean(track?.selectedByRule))
            .map((track) => normalizeTrackId(track?.id))
            .filter((id) => id !== null);
          const defaultSubtitleTrackIds = subtitleTracks
            .filter((track) => Boolean(track?.selectedByRule) && !isBurnedSubtitleTrack(track) && !isDuplicateSubtitleTrack(track))
            .map((track) => normalizeTrackId(track?.id))
            .filter((id) => id !== null);
          const defaultSubtitleVariantSelection = {};
          const defaultSubtitleLanguageOrder = [];
          const subtitleLanguageOrderSeen = new Set();
          for (const track of sortedSelectableSubtitleTracks) {
            const language = normalizeSubtitleLanguage(track?.language || track?.languageLabel || 'und');
            if (!subtitleLanguageOrderSeen.has(language)) {
              subtitleLanguageOrderSeen.add(language);
              defaultSubtitleLanguageOrder.push(language);
            }
            if (!Boolean(track?.selectedByRule)) {
              continue;
            }
            if (!defaultSubtitleVariantSelection[language]) {
              defaultSubtitleVariantSelection[language] = { full: false, forced: false };
            }
            const flags = resolveSubtitleTrackVariantFlags(track);
            if (flags.isForcedOnly) {
              defaultSubtitleVariantSelection[language].forced = true;
            } else {
              defaultSubtitleVariantSelection[language].full = true;
            }
          }
          const selectedAudioTrackIds = normalizeTrackIdList(
            Array.isArray(titleSelectionEntry?.audioTrackIds)
              ? titleSelectionEntry.audioTrackIds
              : defaultAudioTrackIds
          );
          const selectedSubtitleTrackIds = normalizeTrackIdList(
            Array.isArray(titleSelectionEntry?.subtitleTrackIds)
              ? titleSelectionEntry.subtitleTrackIds
              : defaultSubtitleTrackIds
          ).filter((id) => selectableSubtitleTrackIdSet.has(String(id)));
          const selectedSubtitleVariantSelection = normalizeSubtitleVariantSelectionMap(
            titleSelectionEntry?.subtitleVariantSelection || defaultSubtitleVariantSelection
          );
          const selectedSubtitleSelectionMode = normalizeSubtitleSelectionMode(
            titleSelectionEntry?.subtitleSelectionMode,
            Object.keys(selectedSubtitleVariantSelection).length > 0
              ? 'variants'
              : 'track_ids'
          );
          const selectedSubtitleLanguageOrder = normalizeSubtitleLanguageOrder(
            Array.isArray(titleSelectionEntry?.subtitleLanguageOrder)
              ? titleSelectionEntry.subtitleLanguageOrder
              : defaultSubtitleLanguageOrder
          );
          const allowTrackSelectionForTitle = Boolean(
            allowTrackSelection
            && titleChecked
            && (allowTitleSelection || displayOnlySelectedTitle)
          );

          return (
            <div key={title.id} className="media-title-block">
              <label className="readonly-check-row">
                <input
                  type="checkbox"
                  checked={titleChecked}
                  onChange={(event) => {
                    if (!allowTitleSelection) {
                      return;
                    }
                    if (displayOnlySelectedTitle) {
                      if (typeof onToggleEncodeTitle === 'function') {
                        onToggleEncodeTitle(normalizedTitleId, true);
                      }
                      if (typeof onSelectEncodeTitle === 'function') {
                        onSelectEncodeTitle(normalizedTitleId);
                      }
                      return;
                    }
                    const checked = Boolean(event?.target?.checked);
                    if (typeof onToggleEncodeTitle === 'function') {
                      onToggleEncodeTitle(normalizedTitleId, checked);
                    }
                    if (checked && typeof onSelectEncodeTitle === 'function') {
                      onSelectEncodeTitle(normalizedTitleId);
                    }
                  }}
                  readOnly={!allowTitleSelection}
                  disabled={!allowTitleSelection}
                />
                <span>
                  #{displayTitleId ?? '-'} | {title.fileName} | {formatDuration(title.durationMinutes)}
                  {audioCount > 0 ? ` | Audio: ${audioCount}` : ''}
                  {subtitleCount > 0 ? ` | Untertitel: ${subtitleCount}` : ''}
                  {title.encodeInput ? ' | Encode-Input' : ''}
                  {titleIsPrimary ? ' | Primär' : ''}
                </span>
              </label>

              {allowEpisodeAssignments && titleChecked ? (
                <div className="episode-title-input-row">
                  <label htmlFor={`episode-title-${title.id}`}>Episodentitel</label>
                  <input
                    id={`episode-title-${title.id}`}
                    className="p-inputtext p-component"
                    type="text"
                    value={episodeInputValue}
                    onChange={(event) => {
                      if (!allowTitleSelection || typeof onEpisodeAssignmentChange !== 'function') {
                        return;
                      }
                      onEpisodeAssignmentChange(normalizedTitleId, {
                        episodeTitle: event?.target?.value || ''
                      });
                    }}
                    placeholder="Episodentitel"
                    disabled={!allowTitleSelection}
                  />
                </div>
              ) : null}

              {title.playlistFile || title.playlistEvaluationLabel || title.playlistSegmentCommand ? (
                <div className="playlist-info-box">
                  <small>
                    <strong>Playlist:</strong> {title.playlistFile || '-'}
                    {title.playlistRecommended ? ' | empfohlen' : ''}
                  </small>
                  {title.playlistEvaluationLabel ? (
                    <small><strong>Bewertung:</strong> {title.playlistEvaluationLabel}</small>
                  ) : null}
                  {title.playlistSegmentCommand ? (
                    <small><strong>Analyse-Command:</strong> {title.playlistSegmentCommand}</small>
                  ) : null}
                  {Array.isArray(title.playlistSegmentFiles) && title.playlistSegmentFiles.length > 0 ? (
                    <details className="playlist-segment-toggle">
                      <summary>Segment-Dateien anzeigen ({title.playlistSegmentFiles.length})</summary>
                      <pre className="playlist-segment-output">{title.playlistSegmentFiles.join('\n')}</pre>
                    </details>
                  ) : (
                    <small>Segment-Ausgabe: keine m2ts-Einträge gefunden.</small>
                  )}
                </div>
              ) : null}

              {!compactTitleSelection && useEpisodeTrackAccordion ? (
                <details className="episode-track-accordion">
                  <summary>Tonspuren und Untertitel</summary>
                  <div className="media-track-grid">
                    <TrackList
                      title={`Tonspuren (Titel #${displayTitleId ?? '-'})`}
                      tracks={title.audioTracks || []}
                      type="audio"
                      allowSelection={allowTrackSelectionForTitle}
                      selectedTrackIds={selectedAudioTrackIds}
                      audioSelector={effectiveAudioSelector}
                      onToggleTrack={(trackId, checked) => {
                        if (!allowTrackSelectionForTitle || typeof onTrackSelectionChange !== 'function') {
                          return;
                        }
                        onTrackSelectionChange(title.id, 'audio', trackId, checked);
                      }}
                    />
                    <TrackList
                      title={`Subtitles (Titel #${displayTitleId ?? '-'})`}
                      tracks={allowTrackSelectionForTitle
                        ? subtitleTracks.filter((track) => !isBurnedSubtitleTrack(track))
                        : subtitleTracks}
                      type="subtitle"
                      allowSelection={allowTrackSelectionForTitle}
                      selectedTrackIds={selectedSubtitleTrackIds}
                      selectedSubtitleVariantSelection={selectedSubtitleVariantSelection}
                      selectedSubtitleLanguageOrder={selectedSubtitleLanguageOrder}
                      onToggleTrack={(trackId, checked) => {
                        if (!allowTrackSelectionForTitle || typeof onTrackSelectionChange !== 'function') {
                          return;
                        }
                        onTrackSelectionChange(title.id, 'subtitle', trackId, checked);
                      }}
                      onToggleSubtitleVariant={(language, variant, checked) => {
                        if (!allowTrackSelectionForTitle || typeof onSubtitleVariantSelectionChange !== 'function') {
                          return;
                        }
                        onSubtitleVariantSelectionChange(title.id, language, variant, checked);
                      }}
                    />
                  </div>
                </details>
              ) : (!compactTitleSelection ? (
                <div className="media-track-grid">
                  <TrackList
                    title={`Tonspuren (Titel #${displayTitleId ?? '-'})`}
                    tracks={title.audioTracks || []}
                    type="audio"
                    allowSelection={allowTrackSelectionForTitle}
                    selectedTrackIds={selectedAudioTrackIds}
                    audioSelector={effectiveAudioSelector}
                    onToggleTrack={(trackId, checked) => {
                      if (!allowTrackSelectionForTitle || typeof onTrackSelectionChange !== 'function') {
                        return;
                      }
                      onTrackSelectionChange(title.id, 'audio', trackId, checked);
                    }}
                  />
                  <TrackList
                    title={`Subtitles (Titel #${displayTitleId ?? '-'})`}
                    tracks={allowTrackSelectionForTitle
                      ? subtitleTracks.filter((track) => !isBurnedSubtitleTrack(track))
                      : subtitleTracks}
                    type="subtitle"
                    allowSelection={allowTrackSelectionForTitle}
                    selectedTrackIds={selectedSubtitleTrackIds}
                    selectedSubtitleVariantSelection={selectedSubtitleVariantSelection}
                    selectedSubtitleLanguageOrder={selectedSubtitleLanguageOrder}
                    onToggleTrack={(trackId, checked) => {
                      if (!allowTrackSelectionForTitle || typeof onTrackSelectionChange !== 'function') {
                        return;
                      }
                      onTrackSelectionChange(title.id, 'subtitle', trackId, checked);
                    }}
                    onToggleSubtitleVariant={(language, variant, checked) => {
                      if (!allowTrackSelectionForTitle || typeof onSubtitleVariantSelectionChange !== 'function') {
                        return;
                      }
                      onSubtitleVariantSelectionChange(title.id, language, variant, checked);
                    }}
                  />
                </div>
              ) : null)}
              {!compactTitleSelection && titleChecked ? (() => {
                const resolvedCommandOutputPath = String(
                  commandOutputPathByTitle?.[normalizeTitleId(title?.id)]
                  || commandOutputPathByTitle?.[String(normalizeTitleId(title?.id))]
                  || commandOutputPath
                  || ''
                ).trim() || null;
                const commandPreview = buildHandBrakeCommandPreview({
                  review,
                  title,
                  selectedAudioTrackIds,
                  selectedSubtitleTrackIds,
                  selectedSubtitleSelectionMode,
                  selectedSubtitleVariantSelection,
                  selectedSubtitleLanguageOrder,
                  commandOutputPath: resolvedCommandOutputPath,
                  presetOverride: effectivePresetOverride
                });
                return (
                  <div className="handbrake-command-preview">
                    <small><strong>Finaler HandBrakeCLI-Befehl (Preview):</strong></small>
                    <pre>{commandPreview}</pre>
                  </div>
                );
              })() : null}
            </div>
          );
        })}
      </div>

      {!compactTitleSelection && normalizedComparisonReviews.length > 0 ? (
        <div className="media-review-notes" style={{ marginTop: '0.85rem' }}>
          <small><strong>Vergleich Andere Discs (read-only)</strong></small>
          {normalizedComparisonReviews.map((comparisonItem, comparisonIndex) => {
            const comparisonReview = comparisonItem?.review || {};
            const comparisonTitles = Array.isArray(comparisonReview?.titles) ? comparisonReview.titles : [];
            const comparisonSelectedTitleIds = normalizeTrackIdList([
              ...normalizeTrackIdList(comparisonReview?.selectedTitleIds || []),
              ...comparisonTitles.filter((title) => Boolean(title?.selectedForEncode)).map((title) => title?.id),
              comparisonReview?.encodeInputTitleId
            ]);
            const comparisonSelectedTitleSet = new Set(comparisonSelectedTitleIds.map((id) => String(id)));
            const comparisonPrimaryTitleId = normalizeTitleId(comparisonReview?.encodeInputTitleId);
            const comparisonLabelParts = [];
            if (comparisonItem?.discNumber) {
              comparisonLabelParts.push(`Disc ${comparisonItem.discNumber}`);
            }
            if (comparisonItem?.jobId) {
              comparisonLabelParts.push(`Job #${comparisonItem.jobId}`);
            }
            const comparisonLabel = comparisonLabelParts.join(' | ') || `Referenz ${comparisonIndex + 1}`;

            return (
              <div key={`comparison-review-${comparisonItem?.jobId || comparisonIndex}`} className="media-title-block">
                <small><strong>{comparisonLabel}</strong></small>
                {comparisonTitles.length === 0 ? (
                  <small>Keine Titel in der Referenz-Disc gefunden.</small>
                ) : comparisonTitles.map((title) => {
                  const normalizedTitleId = normalizeTitleId(title?.id);
                  const displayTitleId = normalizeTitleId(title?.handBrakeTitleId) || normalizedTitleId;
                  const titleChecked = normalizedTitleId !== null
                    && comparisonSelectedTitleSet.has(String(normalizedTitleId));
                  const titleIsPrimary = normalizedTitleId !== null
                    && normalizedTitleId === comparisonPrimaryTitleId;
                  const subtitleTracks = Array.isArray(title?.subtitleTracks) ? title.subtitleTracks : [];
                  const audioCount = Number.isFinite(Number(title?.audioTrackCount))
                    ? Number(title.audioTrackCount)
                    : (Array.isArray(title?.audioTracks) ? title.audioTracks.length : 0);
                  const subtitleCount = Number.isFinite(Number(title?.subtitleTrackCount))
                    ? Number(title.subtitleTrackCount)
                    : subtitleTracks.length;

                  return (
                    <div key={`comparison-title-${comparisonItem?.jobId || comparisonIndex}-${title?.id}`} className="media-title-block" style={{ marginTop: '0.65rem' }}>
                      <label className="readonly-check-row">
                        <input
                          type="checkbox"
                          checked={titleChecked}
                          readOnly
                          disabled
                        />
                        <span>
                          #{displayTitleId ?? '-'} | {title.fileName} | {formatDuration(title.durationMinutes)}
                          {audioCount > 0 ? ` | Audio: ${audioCount}` : ''}
                          {subtitleCount > 0 ? ` | Untertitel: ${subtitleCount}` : ''}
                          {title.encodeInput ? ' | Encode-Input' : ''}
                          {titleIsPrimary ? ' | Primär' : ''}
                        </span>
                      </label>

                      {title.playlistFile || title.playlistEvaluationLabel || title.playlistSegmentCommand ? (
                        <div className="playlist-info-box">
                          <small>
                            <strong>Playlist:</strong> {title.playlistFile || '-'}
                            {title.playlistRecommended ? ' | empfohlen' : ''}
                          </small>
                          {title.playlistEvaluationLabel ? (
                            <small><strong>Bewertung:</strong> {title.playlistEvaluationLabel}</small>
                          ) : null}
                          {title.playlistSegmentCommand ? (
                            <small><strong>Analyse-Command:</strong> {title.playlistSegmentCommand}</small>
                          ) : null}
                          {Array.isArray(title.playlistSegmentFiles) && title.playlistSegmentFiles.length > 0 ? (
                            <details className="playlist-segment-toggle">
                              <summary>Segment-Dateien anzeigen ({title.playlistSegmentFiles.length})</summary>
                              <pre className="playlist-segment-output">{title.playlistSegmentFiles.join('\n')}</pre>
                            </details>
                          ) : (
                            <small>Segment-Ausgabe: keine m2ts-Einträge gefunden.</small>
                          )}
                        </div>
                      ) : null}

                      <div className="media-track-grid">
                        <TrackList
                          title={`Tonspuren (Titel #${displayTitleId ?? '-'})`}
                          tracks={title.audioTracks || []}
                          type="audio"
                          allowSelection={false}
                        />
                        <TrackList
                          title={`Subtitles (Titel #${displayTitleId ?? '-'})`}
                          tracks={subtitleTracks}
                          type="subtitle"
                          allowSelection={false}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
