const path = require('path');
const { splitArgs } = require('./commandLine');

const DEFAULT_AUDIO_COPY_MASK = ['aac', 'ac3', 'eac3', 'truehd', 'dts', 'dtshd', 'mp3', 'flac'];
const DEFAULT_AUDIO_FALLBACK = 'av_aac';
const SUBTITLE_CONFIDENCE_SCORES = Object.freeze({
  low: 1,
  medium: 2,
  high: 3
});
const FORCED_SUBTITLE_EVENT_RATIO_THRESHOLD = 0.35;
const FORCED_SUBTITLE_SIZE_RATIO_THRESHOLD = 0.35;
const FORCED_SUBTITLE_MAX_EVENT_COUNT = 220;
const FORCED_SUBTITLE_MIN_EVENT_GAP = 12;
const FORCED_SUBTITLE_MIN_SIZE_GAP_BYTES = 64 * 1024;
const ISO2_TO_3_LANGUAGE = {
  de: 'deu',
  en: 'eng',
  fr: 'fra',
  es: 'spa',
  it: 'ita',
  tr: 'tur',
  pt: 'por',
  ru: 'rus',
  pl: 'pol',
  nl: 'nld',
  sv: 'swe',
  no: 'nor',
  da: 'dan',
  fi: 'fin',
  cs: 'ces',
  hu: 'hun',
  ro: 'ron',
  uk: 'ukr',
  ja: 'jpn',
  jp: 'jpn',
  ko: 'kor',
  zh: 'zho',
  ar: 'ara'
};

function clampNumber(value, fallback = 0) {
  const num = Number(value);
  if (Number.isFinite(num)) {
    return num;
  }
  return fallback;
}

function normalizeLanguage(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw || raw === 'und' || raw === 'unknown') {
    return 'und';
  }
  if (raw.length === 2 && ISO2_TO_3_LANGUAGE[raw]) {
    return ISO2_TO_3_LANGUAGE[raw];
  }
  if (raw.length === 3) {
    return raw;
  }
  if (raw.startsWith('de')) {
    return 'deu';
  }
  if (raw.startsWith('en')) {
    return 'eng';
  }
  if (raw.startsWith('fr')) {
    return 'fra';
  }
  if (raw.startsWith('es')) {
    return 'spa';
  }
  if (raw.startsWith('it')) {
    return 'ita';
  }
  if (raw.length === 2) {
    return raw;
  }
  return raw.slice(0, 3);
}

function normalizeSelectionLanguage(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) {
    return null;
  }
  if (raw === 'any' || raw === 'none') {
    return raw;
  }
  return normalizeLanguage(raw);
}

function parseDurationSeconds(raw) {
  if (raw === null || raw === undefined) {
    return 0;
  }

  const numeric = Number(raw);
  if (Number.isFinite(numeric) && numeric > 0) {
    if (numeric > 10000) {
      return Math.round(numeric / 1000);
    }
    return Math.round(numeric);
  }

  const text = String(raw).trim();
  if (!text) {
    return 0;
  }

  let seconds = 0;
  const hourMatch = text.match(/(\d+(?:\.\d+)?)\s*h/i);
  const minuteMatch = text.match(/(\d+(?:\.\d+)?)\s*mn?/i);
  const secondMatch = text.match(/(\d+(?:\.\d+)?)\s*s/i);

  if (hourMatch || minuteMatch || secondMatch) {
    seconds += hourMatch ? Number(hourMatch[1]) * 3600 : 0;
    seconds += minuteMatch ? Number(minuteMatch[1]) * 60 : 0;
    seconds += secondMatch ? Number(secondMatch[1]) : 0;
    return Math.round(seconds);
  }

  const colonMatch = text.match(/(\d{1,2}):(\d{2}):(\d{2})/);
  if (colonMatch) {
    const h = Number(colonMatch[1]);
    const m = Number(colonMatch[2]);
    const s = Number(colonMatch[3]);
    return (h * 3600) + (m * 60) + s;
  }

  return 0;
}

function pickTrackId(track, fallbackIndex) {
  const rawId = track?.ID ?? track?.ID_String ?? track?.StreamOrder ?? track?.StreamOrder_String;
  if (rawId === undefined || rawId === null || rawId === '') {
    return fallbackIndex + 1;
  }

  const match = String(rawId).match(/\d+/);
  if (!match) {
    return fallbackIndex + 1;
  }

  return Number(match[0]);
}

function mapAudioFormatToCopyCodec(format) {
  const raw = String(format || '').toLowerCase();
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
  if (raw.includes('dca')) {
    return 'dts';
  }
  if (raw.includes('dts')) {
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

function normalizePlaylistId(raw) {
  const value = String(raw || '').trim().toLowerCase();
  if (!value) {
    return null;
  }
  const match = value.match(/(\d{1,5})(?:\.mpls)?$/i);
  if (!match) {
    return null;
  }
  return String(match[1]).padStart(5, '0');
}

function parseMakemkvTitleIdFromFileName(fileName) {
  const match = String(fileName || '').match(/_t(\d{1,3})\./i);
  if (!match) {
    return null;
  }
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value < 0) {
    return null;
  }
  return value;
}

function emptyPlaylistMatch() {
  return {
    playlistId: null,
    playlistFile: null,
    recommended: false,
    evaluationLabel: null,
    segmentCommand: null,
    segmentFiles: []
  };
}

function resolvePlaylistMatchByPlaylistId(analysis, rawPlaylistId) {
  const playlistId = normalizePlaylistId(rawPlaylistId);
  if (!analysis || !playlistId) {
    return emptyPlaylistMatch();
  }

  const recommendation = analysis.recommendation || null;
  const recommended = normalizePlaylistId(recommendation?.playlistId) === playlistId;

  const evaluated = (Array.isArray(analysis.evaluatedCandidates) ? analysis.evaluatedCandidates : [])
    .find((item) => normalizePlaylistId(item?.playlistId) === playlistId) || null;

  const segmentMap = (analysis.playlistSegments && typeof analysis.playlistSegments === 'object')
    ? analysis.playlistSegments
    : {};
  const segmentEntry = segmentMap[playlistId] || segmentMap[`${playlistId}.mpls`] || null;
  const segmentFiles = Array.isArray(segmentEntry?.segmentFiles)
    ? segmentEntry.segmentFiles.filter((item) => String(item || '').trim().length > 0)
    : [];

  return {
    playlistId,
    playlistFile: `${playlistId}.mpls`,
    recommended,
    evaluationLabel: evaluated?.evaluationLabel || (recommended ? 'wahrscheinlich korrekt (Heuristik)' : null),
    segmentCommand: segmentEntry?.segmentCommand || `strings BDMV/PLAYLIST/${playlistId}.mpls | grep m2ts`,
    segmentFiles
  };
}

function findPlaylistMatchForTitle(playlistAnalysis, makemkvTitleId) {
  const analysis = playlistAnalysis && typeof playlistAnalysis === 'object' ? playlistAnalysis : null;
  if (!analysis || makemkvTitleId === null || makemkvTitleId === undefined) {
    return emptyPlaylistMatch();
  }

  const titles = Array.isArray(analysis.titles) ? analysis.titles : [];
  const mapping = titles.find((item) => Number(item?.titleId) === Number(makemkvTitleId)) || null;
  return resolvePlaylistMatchByPlaylistId(analysis, mapping?.playlistId || null);
}

function parseMediaInfoFile(mediaInfoJson, fileInfo, index) {
  const tracks = Array.isArray(mediaInfoJson?.media?.track) ? mediaInfoJson.media.track : [];
  const general = tracks.find((item) => String(item?.['@type'] || '').toLowerCase() === 'general') || {};
  const durationSeconds = parseDurationSeconds(general?.Duration || general?.Duration_String3 || general?.Duration_String);
  const durationMinutes = Number((durationSeconds / 60).toFixed(2));
  const fileName = path.basename(fileInfo.path);

  const audioTracks = tracks
    .filter((item) => String(item?.['@type'] || '').toLowerCase() === 'audio')
    .map((item, idx) => ({
      id: idx + 1,
      sourceTrackId: pickTrackId(item, idx),
      language: normalizeLanguage(item?.Language || item?.Language_String3 || item?.Language_String || 'und'),
      languageLabel: item?.Language_String3 || item?.Language || item?.Language_String || 'und',
      title: item?.Title || null,
      format: item?.Format || null,
      codecToken: mapAudioFormatToCopyCodec(item?.Format || null),
      channels: item?.Channels || item?.Channel_s_ || null
    }));

  const subtitleTracksRaw = tracks
    .filter((item) => {
      const type = String(item?.['@type'] || '').toLowerCase();
      return type === 'text' || type === 'subtitle';
    })
    .map((item, idx) => ({
      id: idx + 1,
      sourceTrackId: pickTrackId(item, idx),
      language: normalizeLanguage(item?.Language || item?.Language_String3 || item?.Language_String || 'und'),
      languageLabel: item?.Language_String3 || item?.Language || item?.Language_String || 'und',
      title: item?.Title || null,
      format: item?.Format || null,
      defaultFlag: parseBooleanFlag(item?.Default ?? item?.Default_String ?? item?.IsDefault ?? item?.isDefault),
      forcedFlag: parseBooleanFlagNullable(item?.Forced ?? item?.Forced_String ?? item?.IsForced ?? item?.isForced),
      sdhFlag: parseSubtitleSdhFlag(item),
      eventCount: parseSubtitleEventCount(item),
      streamSizeBytes: parseSubtitleStreamSizeBytes(item)
    }));
  const subtitleTracks = annotateSubtitleTracks(subtitleTracksRaw);

  const videoTracks = tracks
    .filter((item) => String(item?.['@type'] || '').toLowerCase() === 'video')
    .map((item, idx) => ({
      id: idx + 1,
      sourceTrackId: pickTrackId(item, idx),
      format: item?.Format || null,
      codecId: item?.CodecID || null,
      width: item?.Width || null,
      height: item?.Height || null,
      frameRate: item?.FrameRate || null
    }));

  return {
    id: index + 1,
    filePath: fileInfo.path,
    fileName,
    makemkvTitleId: parseMakemkvTitleIdFromFileName(fileName),
    sizeBytes: clampNumber(fileInfo.size, 0),
    durationSeconds,
    durationMinutes,
    audioTracks,
    subtitleTracks,
    videoTracks
  };
}

function parseArgValue(args, index) {
  const token = args[index];
  if (!token) {
    return { value: null, consumed: 0 };
  }

  if (token.includes('=')) {
    return {
      value: token.slice(token.indexOf('=') + 1),
      consumed: 0
    };
  }

  if (index + 1 < args.length && !String(args[index + 1]).startsWith('-')) {
    return {
      value: args[index + 1],
      consumed: 1
    };
  }

  return { value: null, consumed: 0 };
}

function parseList(raw, mapper = normalizeSelectionLanguage) {
  return String(raw || '')
    .split(',')
    .map((item) => mapper(item))
    .filter(Boolean);
}

function parseTrackIdList(raw) {
  return String(raw || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => Number(item))
    .filter((item) => Number.isFinite(item));
}

function parseBooleanFlag(value) {
  return parseBooleanFlagNullable(value) === true;
}

function parseBooleanFlagNullable(value) {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return value === 1;
  }
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) {
    return null;
  }
  if (raw === 'yes' || raw === 'true' || raw === '1') {
    return true;
  }
  if (raw === 'no' || raw === 'false' || raw === '0') {
    return false;
  }
  return null;
}

function parseSubtitleForcedFlag(track) {
  if (!track || typeof track !== 'object') {
    return null;
  }
  const candidates = [
    track?.forcedFlag,
    track?.forced,
    track?.Forced,
    track?.isForced,
    track?.IsForced,
    track?.forced_only,
    track?.forcedOnly,
    track?.Attributes?.Forced
  ];
  for (const candidate of candidates) {
    const parsed = parseBooleanFlagNullable(candidate);
    if (parsed === true || parsed === false) {
      return parsed;
    }
  }
  return null;
}

function parseSubtitleSdhFlag(track) {
  if (!track || typeof track !== 'object') {
    return null;
  }
  const candidates = [
    track?.sdhFlag,
    track?.hearingImpaired,
    track?.HearingImpaired,
    track?.isHearingImpaired,
    track?.IsHearingImpaired,
    track?.Hearing_Impaired,
    track?.closedCaptions,
    track?.ClosedCaptions,
    track?.Attributes?.HearingImpaired,
    track?.Attributes?.ClosedCaptions
  ];
  for (const candidate of candidates) {
    const parsed = parseBooleanFlagNullable(candidate);
    if (parsed === true || parsed === false) {
      return parsed;
    }
  }

  const serviceKind = String(track?.serviceKind || track?.ServiceKind || '').trim().toLowerCase();
  if (!serviceKind) {
    return null;
  }
  if (serviceKind.includes('sdh') || serviceKind.includes('cc') || serviceKind.includes('hearing')) {
    return true;
  }
  return null;
}

function parseSubtitleEventCount(track) {
  const candidates = [
    track?.CountOfEvents,
    track?.countOfEvents,
    track?.EventCount,
    track?.eventCount,
    track?.ElementCount,
    track?.elementCount
  ];
  for (const candidate of candidates) {
    const numeric = Number(candidate);
    if (Number.isFinite(numeric) && numeric >= 0) {
      return Math.trunc(numeric);
    }
  }
  return null;
}

function parseSubtitleStreamSizeBytes(track) {
  const numericCandidates = [
    track?.StreamSize,
    track?.streamSize,
    track?.StreamSize_Original,
    track?.streamSizeOriginal,
    track?.Bytes,
    track?.bytes
  ];
  for (const candidate of numericCandidates) {
    const numeric = Number(candidate);
    if (Number.isFinite(numeric) && numeric > 0) {
      return Math.trunc(numeric);
    }
  }

  const textCandidates = [
    track?.StreamSize_String,
    track?.streamSizeString,
    track?.StreamSize_Original_String,
    track?.streamSizeOriginalString,
    track?.Size_String,
    track?.sizeString
  ];
  for (const candidate of textCandidates) {
    const text = String(candidate || '').trim();
    if (!text) {
      continue;
    }
    const match = text.match(/([0-9]+(?:[.,][0-9]+)?)\s*([kmgt]?b)/i);
    if (!match) {
      continue;
    }
    const value = Number(String(match[1]).replace(',', '.'));
    if (!Number.isFinite(value) || value <= 0) {
      continue;
    }
    const unit = String(match[2] || 'b').toLowerCase();
    const factorByUnit = {
      b: 1,
      kb: 1024,
      mb: 1024 ** 2,
      gb: 1024 ** 3,
      tb: 1024 ** 4
    };
    const factor = factorByUnit[unit] || 1;
    return Math.max(0, Math.trunc(value * factor));
  }
  return null;
}

function normalizeSubtitleConfidence(raw) {
  const value = String(raw || '').trim().toLowerCase();
  if (value === 'high' || value === 'medium' || value === 'low') {
    return value;
  }
  return 'low';
}

function subtitleConfidenceScore(raw) {
  return SUBTITLE_CONFIDENCE_SCORES[normalizeSubtitleConfidence(raw)] || 0;
}

function collectSubtitleText(track) {
  return [
    track?.title,
    track?.description,
    track?.name,
    track?.format,
    track?.label
  ]
    .map((value) => String(value || '').trim().toLowerCase())
    .filter(Boolean)
    .join(' ');
}

function isLikelyBitmapSubtitleFormat(track) {
  const text = [
    track?.format,
    track?.codec,
    track?.codecName,
    track?.title,
    track?.description,
    track?.name,
    track?.label
  ]
    .map((value) => String(value || '').trim().toLowerCase())
    .filter(Boolean)
    .join(' ');
  if (!text) {
    return false;
  }
  return (
    /\bpgs\b/.test(text)
    || /\bhdmv\b/.test(text)
    || /\bsup\b/.test(text)
    || /\bvobsub\b/.test(text)
    || /\bdvd[-_\s]?sub/.test(text)
    || /\bdvb[-_\s]?sub/.test(text)
  );
}

function isLikelySdhSubtitleTrack(track) {
  const text = collectSubtitleText(track);
  if (!text) {
    return false;
  }
  return (
    /\bsdh\b/.test(text)
    || /\bcc\b/.test(text)
    || /\bhoh\b/.test(text)
    || /\bcaptions?\b/.test(text)
    || /hard[-\s]?of[-\s]?hearing/.test(text)
    || /hearing\s+impaired/.test(text)
    || /(?:gehörlos|hoergeschaedigt|hörgeschädigt)/.test(text)
  );
}

function isLikelyForcedSubtitleTrack(track) {
  const text = collectSubtitleText(track);
  if (!text) {
    return false;
  }
  if (isLikelySdhSubtitleTrack(track) || /\bnot forced\b/.test(text)) {
    return false;
  }
  return (
    /\bforced(?:\s+only)?\b/.test(text)
    || /nur\s+erzwungen/.test(text)
    || /\berzwungen\b/.test(text)
  );
}

function compareSubtitleTracksByForcedHeuristic(a, b) {
  const aSdh = Number(Boolean(a?.sdhLikely));
  const bSdh = Number(Boolean(b?.sdhLikely));
  if (aSdh !== bSdh) {
    return aSdh - bSdh;
  }

  const aDefault = Number(Boolean(a?.defaultFlag));
  const bDefault = Number(Boolean(b?.defaultFlag));
  if (aDefault !== bDefault) {
    return aDefault - bDefault;
  }

  const aEventKnown = Number.isFinite(a?.eventCount) ? 0 : 1;
  const bEventKnown = Number.isFinite(b?.eventCount) ? 0 : 1;
  if (aEventKnown !== bEventKnown) {
    return aEventKnown - bEventKnown;
  }
  if (aEventKnown === 0 && a.eventCount !== b.eventCount) {
    return a.eventCount - b.eventCount;
  }

  const aSizeKnown = Number.isFinite(a?.streamSizeBytes) ? 0 : 1;
  const bSizeKnown = Number.isFinite(b?.streamSizeBytes) ? 0 : 1;
  if (aSizeKnown !== bSizeKnown) {
    return aSizeKnown - bSizeKnown;
  }
  if (aSizeKnown === 0 && a.streamSizeBytes !== b.streamSizeBytes) {
    return a.streamSizeBytes - b.streamSizeBytes;
  }

  const aTrackId = Number.isFinite(a?.id) && a.id > 0 ? a.id : Number.MAX_SAFE_INTEGER;
  const bTrackId = Number.isFinite(b?.id) && b.id > 0 ? b.id : Number.MAX_SAFE_INTEGER;
  if (aTrackId !== bTrackId) {
    return aTrackId - bTrackId;
  }
  return a.originalIndex - b.originalIndex;
}

function compareSubtitleTracksForDedup(a, b) {
  const aSdh = Number(Boolean(a?.sdhLikely));
  const bSdh = Number(Boolean(b?.sdhLikely));
  if (aSdh !== bSdh) {
    return aSdh - bSdh;
  }

  const defaultDiff = Number(Boolean(b?.defaultFlag)) - Number(Boolean(a?.defaultFlag));
  if (defaultDiff !== 0) {
    return defaultDiff;
  }
  const confidenceDiff = subtitleConfidenceScore(b?.sourceConfidence) - subtitleConfidenceScore(a?.sourceConfidence);
  if (confidenceDiff !== 0) {
    return confidenceDiff;
  }
  const aTrackId = Number.isFinite(a?.id) && a.id > 0 ? a.id : Number.MAX_SAFE_INTEGER;
  const bTrackId = Number.isFinite(b?.id) && b.id > 0 ? b.id : Number.MAX_SAFE_INTEGER;
  if (aTrackId !== bTrackId) {
    return aTrackId - bTrackId;
  }
  return a.originalIndex - b.originalIndex;
}

function isHeuristicForcedSubtitleCandidate(languageEntries, candidate) {
  if (!candidate) {
    return false;
  }
  if (!isLikelyBitmapSubtitleFormat(candidate)) {
    return false;
  }
  const comparable = (Array.isArray(languageEntries) ? languageEntries : [])
    .filter((entry) => entry !== candidate && !entry.sdhLikely && isLikelyBitmapSubtitleFormat(entry));
  if (comparable.length === 0) {
    return false;
  }

  const candidateEventCount = Number(candidate?.eventCount);
  const comparableEventCounts = comparable
    .map((entry) => Number(entry?.eventCount))
    .filter((value) => Number.isFinite(value) && value > 0);
  const maxComparableEventCount = comparableEventCounts.length > 0
    ? Math.max(...comparableEventCounts)
    : null;
  const hasEventSignal = Number.isFinite(candidateEventCount)
    && candidateEventCount >= 0
    && Number.isFinite(maxComparableEventCount)
    && maxComparableEventCount > 0
    && candidateEventCount <= FORCED_SUBTITLE_MAX_EVENT_COUNT
    && (candidateEventCount / maxComparableEventCount) <= FORCED_SUBTITLE_EVENT_RATIO_THRESHOLD
    && (maxComparableEventCount - candidateEventCount) >= FORCED_SUBTITLE_MIN_EVENT_GAP;

  const candidateStreamSize = Number(candidate?.streamSizeBytes);
  const comparableSizes = comparable
    .map((entry) => Number(entry?.streamSizeBytes))
    .filter((value) => Number.isFinite(value) && value > 0);
  const maxComparableSize = comparableSizes.length > 0
    ? Math.max(...comparableSizes)
    : null;
  const hasSizeSignal = Number.isFinite(candidateStreamSize)
    && candidateStreamSize > 0
    && Number.isFinite(maxComparableSize)
    && maxComparableSize > 0
    && (candidateStreamSize / maxComparableSize) <= FORCED_SUBTITLE_SIZE_RATIO_THRESHOLD
    && (maxComparableSize - candidateStreamSize) >= FORCED_SUBTITLE_MIN_SIZE_GAP_BYTES;

  const signalCount = Number(hasEventSignal) + Number(hasSizeSignal);
  if (signalCount === 0) {
    return false;
  }

  if (candidate.defaultFlag && signalCount < 2) {
    return false;
  }
  return true;
}

function annotateSubtitleTracks(subtitleTracks) {
  const tracks = Array.isArray(subtitleTracks) ? subtitleTracks : [];
  if (tracks.length === 0) {
    return [];
  }

  const entries = tracks.map((track, index) => ({
    ...track,
    language: normalizeLanguage(track?.language || track?.languageLabel || 'und'),
    defaultFlag: Boolean(track?.defaultFlag),
    forcedFlag: parseSubtitleForcedFlag(track),
    forcedTrack: false,
    sourceConfidence: null,
    confidenceSource: 'heuristic',
    duplicate: false,
    selected: false,
    subtitleType: 'full',
    forcedAvailable: false,
    forcedSourceTrackIds: [],
    sdhLikely: (parseSubtitleSdhFlag(track) === true) || Boolean(track?.sdhLikely) || isLikelySdhSubtitleTrack(track),
    originalIndex: index
  }));

  const byLanguage = new Map();
  for (const entry of entries) {
    if (!byLanguage.has(entry.language)) {
      byLanguage.set(entry.language, []);
    }
    byLanguage.get(entry.language).push(entry);
  }

  for (const languageEntries of byLanguage.values()) {
    for (const entry of languageEntries) {
      const forcedByFlag = entry.forcedFlag === true;
      const forcedBlockedByFlag = entry.forcedFlag === false;
      const forcedByTitle = !entry.sdhLikely && !forcedBlockedByFlag && isLikelyForcedSubtitleTrack(entry);

      if (forcedByFlag) {
        entry.forcedTrack = true;
        entry.sourceConfidence = 'high';
        entry.confidenceSource = 'explicit_flag';
      } else if (forcedByTitle) {
        entry.forcedTrack = true;
        entry.sourceConfidence = 'medium';
        entry.confidenceSource = 'title';
      }
    }

    if (!languageEntries.some((entry) => entry.forcedTrack)) {
      const candidates = languageEntries
        .filter((entry) => !entry.sdhLikely && entry.forcedFlag !== false)
        .sort(compareSubtitleTracksByForcedHeuristic);
      const forcedCandidate = candidates[0] || null;
      if (forcedCandidate && isHeuristicForcedSubtitleCandidate(languageEntries, forcedCandidate)) {
        forcedCandidate.forcedTrack = true;
        forcedCandidate.sourceConfidence = 'low';
        forcedCandidate.confidenceSource = 'heuristic';
      }
    }

    for (const entry of languageEntries) {
      if (!entry.forcedTrack) {
        continue;
      }
      entry.sourceConfidence = normalizeSubtitleConfidence(entry.sourceConfidence || 'low');
    }

    const forcedEntries = languageEntries.filter((entry) => entry.forcedTrack);
    const fullEntries = languageEntries.filter((entry) => !entry.forcedTrack && !entry.sdhLikely);
    const sdhEntries = languageEntries.filter((entry) => !entry.forcedTrack && entry.sdhLikely);
    const forcedWinner = forcedEntries.length > 0 ? [...forcedEntries].sort(compareSubtitleTracksForDedup)[0] : null;
    const fullWinner = fullEntries.length > 0 ? [...fullEntries].sort(compareSubtitleTracksForDedup)[0] : null;
    const sdhWinner = sdhEntries.length > 0 ? [...sdhEntries].sort(compareSubtitleTracksForDedup)[0] : null;
    const forcedSourceTrackIds = forcedEntries
      .map((entry) => Number(entry?.sourceTrackId ?? entry?.id))
      .filter((value) => Number.isFinite(value) && value > 0)
      .map((value) => Math.trunc(value));
    const forcedAvailable = Boolean(forcedWinner);

    for (const entry of languageEntries) {
      const typeWinner = entry.forcedTrack
        ? forcedWinner
        : (entry.sdhLikely ? sdhWinner : fullWinner);
      entry.duplicate = Boolean(typeWinner && typeWinner !== entry);
      if (entry.forcedTrack) {
        entry.selected = Boolean(typeWinner && typeWinner === entry && !entry.duplicate);
      } else if (entry.sdhLikely) {
        entry.selected = Boolean(!fullWinner && typeWinner && typeWinner === entry && !entry.duplicate);
      } else {
        entry.selected = Boolean(typeWinner && typeWinner === entry && !entry.duplicate);
      }
      entry.subtitleType = entry.forcedTrack ? 'forced' : 'full';
      entry.forcedAvailable = forcedAvailable;
      entry.forcedSourceTrackIds = forcedSourceTrackIds;
      const fullHasForced = !entry.forcedTrack && Boolean(
        entry.fullHasForced
        ?? entry.subtitleFullHasForced
        ?? entry.hasForcedVariant
      );
      const explicitForcedOnly = entry.isForcedOnly ?? entry.forcedOnly ?? entry.subtitlePreviewForcedOnly;
      entry.isForcedOnly = typeof explicitForcedOnly === 'boolean'
        ? explicitForcedOnly
        : (entry.forcedTrack && !fullHasForced);
      entry.fullHasForced = fullHasForced;
    }
  }

  return entries
    .sort((a, b) => a.originalIndex - b.originalIndex)
    .map((entry) => {
      const { originalIndex, ...rest } = entry;
      return rest;
    });
}

function parseEncoderList(raw) {
  return String(raw || '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

function parseCopyMaskList(raw) {
  return String(raw || '')
    .split(',')
    .map((item) => String(item || '').trim().toLowerCase())
    .map((item) => item.replace(/^copy:/, ''))
    .filter(Boolean);
}

function normalizeTrackSelectionMode(raw, trackType) {
  const value = String(raw || '').trim().toLowerCase();
  if (value === 'all') {
    return 'all';
  }
  if (value === 'first') {
    return 'first';
  }
  if (value === 'none') {
    return 'none';
  }
  if (value === 'language') {
    return 'language';
  }
  return trackType === 'audio' ? 'first' : 'none';
}

function normalizeBurnBehavior(raw) {
  const value = String(raw || '').trim().toLowerCase();
  if (!value || value === 'none') {
    return 'none';
  }
  if (value === 'foreign' || value === 'foreign_first') {
    return 'first';
  }
  if (value === 'first') {
    return 'first';
  }
  return 'none';
}

function hasConfiguredLanguageSelection(rawValue) {
  return parseList(rawValue, normalizeSelectionLanguage)
    .filter((item) => item !== 'none' && item !== 'any')
    .length > 0;
}

function hasExplicitPresetTrackSelection(profile = {}, trackType = 'audio') {
  const source = String(profile?.source || '').trim().toLowerCase();
  if (source !== 'preset-export') {
    return false;
  }

  if (trackType === 'audio') {
    const behavior = String(profile?.audioTrackSelectionBehavior || '').trim().toLowerCase();
    const languages = Array.isArray(profile?.audioLanguages) ? profile.audioLanguages : [];
    return behavior === 'all' || behavior === 'language' || behavior === 'none' || languages.length > 0;
  }

  const behavior = String(profile?.subtitleTrackSelectionBehavior || '').trim().toLowerCase();
  const languages = Array.isArray(profile?.subtitleLanguages) ? profile.subtitleLanguages : [];
  return behavior === 'all' || behavior === 'language' || behavior === 'first' || languages.length > 0;
}

function buildBaseTrackSelectors(settings, presetProfile = null) {
  const profile = presetProfile && typeof presetProfile === 'object' ? presetProfile : {};
  const audioLanguages = Array.isArray(profile.audioLanguages)
    ? profile.audioLanguages.map((item) => normalizeSelectionLanguage(item)).filter(Boolean)
    : [];
  const subtitleLanguages = Array.isArray(profile.subtitleLanguages)
    ? profile.subtitleLanguages.map((item) => normalizeSelectionLanguage(item)).filter(Boolean)
    : [];
  const configuredAudioLanguages = parseList(settings?.handbrake_review_audio_languages, normalizeSelectionLanguage)
    .filter((item) => item !== 'none' && item !== 'any');
  const configuredSubtitleLanguages = parseList(settings?.handbrake_review_subtitle_languages, normalizeSelectionLanguage)
    .filter((item) => item !== 'none' && item !== 'any');
  const useConfiguredAudioLanguages = configuredAudioLanguages.length > 0 && !hasExplicitPresetTrackSelection(profile, 'audio');
  const useConfiguredSubtitleLanguages = configuredSubtitleLanguages.length > 0 && !hasExplicitPresetTrackSelection(profile, 'subtitle');
  const effectiveAudioLanguages = useConfiguredAudioLanguages ? configuredAudioLanguages : audioLanguages;
  const effectiveSubtitleLanguages = useConfiguredSubtitleLanguages ? configuredSubtitleLanguages : subtitleLanguages;
  const audioEncoders = Array.isArray(profile.audioEncoders)
    ? profile.audioEncoders.map((item) => String(item || '').trim().toLowerCase()).filter(Boolean)
    : [];

  const rawCopyMask = Array.isArray(profile.audioCopyMask)
    ? profile.audioCopyMask
    : [];

  const normalizedCopyMask = rawCopyMask
    .map((item) => String(item || '').trim().toLowerCase())
    .map((item) => item.replace(/^copy:/, ''))
    .filter(Boolean);

  const baseAudioMode = normalizeTrackSelectionMode(profile.audioTrackSelectionBehavior, 'audio');
  const baseSubtitleMode = normalizeTrackSelectionMode(profile.subtitleTrackSelectionBehavior, 'subtitle');
  const effectiveAudioMode = useConfiguredAudioLanguages && !hasConfiguredLanguageSelection(profile?.audioLanguages)
    ? 'language'
    : baseAudioMode;
  const effectiveSubtitleMode = useConfiguredSubtitleLanguages && !hasConfiguredLanguageSelection(profile?.subtitleLanguages)
    ? 'language'
    : baseSubtitleMode;
  const audioSelectionSource = useConfiguredAudioLanguages
    ? 'settings'
    : (profile.source === 'preset-export' ? 'preset' : 'default');
  const subtitleSelectionSource = useConfiguredSubtitleLanguages
    ? 'settings'
    : (profile.source === 'preset-export' ? 'preset' : 'default');

  return {
    preset: settings?.handbrake_preset || null,
    extraArgs: settings?.handbrake_extra_args || '',
    presetProfileSource: profile.source || 'fallback',
    presetProfileMessage: profile.message || null,
    audio: {
      mode: effectiveAudioMode,
      languages: effectiveAudioLanguages.filter((item) => item !== 'none'),
      explicitIds: [],
      firstOnly: effectiveAudioMode === 'first',
      selectionSource: audioSelectionSource,
      encoders: audioEncoders,
      encoderSource: audioEncoders.length > 0 ? (profile.source === 'preset-export' ? 'preset' : 'default') : 'default',
      copyMask: normalizedCopyMask.length > 0 ? normalizedCopyMask : [...DEFAULT_AUDIO_COPY_MASK],
      copyMaskSource: normalizedCopyMask.length > 0 ? (profile.source === 'preset-export' ? 'preset' : 'default') : 'default',
      fallbackEncoder: String(profile.audioFallback || DEFAULT_AUDIO_FALLBACK).trim().toLowerCase() || DEFAULT_AUDIO_FALLBACK,
      fallbackSource: profile.audioFallback ? (profile.source === 'preset-export' ? 'preset' : 'default') : 'default'
    },
    subtitle: {
      mode: effectiveSubtitleMode,
      languages: effectiveSubtitleLanguages.filter((item) => item !== 'none'),
      explicitIds: [],
      firstOnly: effectiveSubtitleMode === 'first',
      selectionSource: subtitleSelectionSource,
      // Do not auto-burn subtitle tracks from exported preset metadata.
      // Burn-in should only be activated via explicit CLI args/selection.
      burnBehavior: 'none',
      burnedTrackId: null,
      defaultTrackId: null,
      forcedTrackId: null,
      forcedOnly: false
    }
  };
}

function applyArgOverrides(selectors, args) {
  const audio = selectors.audio;
  const subtitle = selectors.subtitle;

  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];

    if (token === '--all-audio') {
      audio.mode = 'all';
      audio.firstOnly = false;
      audio.selectionSource = 'args';
      continue;
    }

    if (token === '--first-audio') {
      audio.firstOnly = true;
      if (audio.mode !== 'explicit' && audio.mode !== 'language') {
        audio.mode = 'first';
      }
      audio.selectionSource = 'args';
      continue;
    }

    if (token === '--audio' || token.startsWith('--audio=') || token === '-a' || token.startsWith('-a=')) {
      const parsed = parseArgValue(args, i);
      const raw = String(parsed.value || '').trim().toLowerCase();
      if (raw === 'none') {
        audio.mode = 'none';
        audio.explicitIds = [];
      } else {
        audio.explicitIds = parseTrackIdList(parsed.value);
        audio.mode = 'explicit';
      }
      audio.firstOnly = false;
      audio.selectionSource = 'args';
      i += parsed.consumed;
      continue;
    }

    if (token === '--audio-lang-list' || token.startsWith('--audio-lang-list=')) {
      const parsed = parseArgValue(args, i);
      const langs = parseList(parsed.value, normalizeSelectionLanguage).filter((item) => item !== 'none');
      if (langs.includes('any')) {
        audio.mode = 'all';
        audio.languages = [];
      } else {
        audio.mode = 'language';
        audio.languages = langs;
      }
      audio.selectionSource = 'args';
      i += parsed.consumed;
      continue;
    }

    if (token === '--aencoder' || token.startsWith('--aencoder=') || token === '-E' || token.startsWith('-E=')) {
      const parsed = parseArgValue(args, i);
      const encoders = parseEncoderList(parsed.value);
      if (encoders.length > 0) {
        audio.encoders = encoders;
        audio.encoderSource = 'args';
      }
      i += parsed.consumed;
      continue;
    }

    if (token === '--audio-copy-mask' || token.startsWith('--audio-copy-mask=')) {
      const parsed = parseArgValue(args, i);
      audio.copyMask = parseCopyMaskList(parsed.value);
      audio.copyMaskSource = 'args';
      i += parsed.consumed;
      continue;
    }

    if (token === '--audio-fallback' || token.startsWith('--audio-fallback=')) {
      const parsed = parseArgValue(args, i);
      const fallback = String(parsed.value || '').trim().toLowerCase();
      if (fallback) {
        audio.fallbackEncoder = fallback;
        audio.fallbackSource = 'args';
      }
      i += parsed.consumed;
      continue;
    }

    if (token === '--all-subtitles') {
      subtitle.mode = 'all';
      subtitle.firstOnly = false;
      subtitle.selectionSource = 'args';
      continue;
    }

    if (token === '--first-subtitle') {
      subtitle.firstOnly = true;
      if (subtitle.mode !== 'explicit' && subtitle.mode !== 'language') {
        subtitle.mode = 'first';
      }
      subtitle.selectionSource = 'args';
      continue;
    }

    if (token === '--subtitle' || token.startsWith('--subtitle=') || token === '-s' || token.startsWith('-s=')) {
      const parsed = parseArgValue(args, i);
      const raw = String(parsed.value || '').trim().toLowerCase();
      if (raw === 'none') {
        subtitle.mode = 'none';
        subtitle.explicitIds = [];
      } else {
        subtitle.explicitIds = parseTrackIdList(parsed.value);
        subtitle.mode = 'explicit';
      }
      subtitle.firstOnly = false;
      subtitle.selectionSource = 'args';
      i += parsed.consumed;
      continue;
    }

    if (token === '--subtitle-lang-list' || token.startsWith('--subtitle-lang-list=')) {
      const parsed = parseArgValue(args, i);
      const langs = parseList(parsed.value, normalizeSelectionLanguage).filter((item) => item !== 'none');
      if (langs.includes('any')) {
        subtitle.mode = 'all';
        subtitle.languages = [];
      } else {
        subtitle.mode = 'language';
        subtitle.languages = langs;
      }
      subtitle.selectionSource = 'args';
      i += parsed.consumed;
      continue;
    }

    if (token === '--subtitle-burned' || token.startsWith('--subtitle-burned=')) {
      const parsed = parseArgValue(args, i);
      const specificTrackId = parsed.value ? Number(parsed.value) : null;
      if (Number.isFinite(specificTrackId) && specificTrackId > 0) {
        subtitle.burnedTrackId = specificTrackId;
      } else {
        subtitle.burnBehavior = 'first';
      }
      i += parsed.consumed;
      continue;
    }

    if (token === '--subtitle-default' || token.startsWith('--subtitle-default=')) {
      const parsed = parseArgValue(args, i);
      const specificTrackId = parsed.value ? Number(parsed.value) : null;
      if (Number.isFinite(specificTrackId) && specificTrackId > 0) {
        subtitle.defaultTrackId = specificTrackId;
      }
      i += parsed.consumed;
      continue;
    }

    if (token === '--subtitle-forced' || token.startsWith('--subtitle-forced=')) {
      subtitle.forcedOnly = true;
      const parsed = parseArgValue(args, i);
      const specificTrackId = parsed.value ? Number(parsed.value) : null;
      if (Number.isFinite(specificTrackId) && specificTrackId > 0) {
        subtitle.forcedTrackId = specificTrackId;
      }
      i += parsed.consumed;
    }
  }
}

function buildTrackSelectors(settings, presetProfile) {
  const selectors = buildBaseTrackSelectors(settings || {}, presetProfile || null);
  const args = splitArgs(settings?.handbrake_extra_args || '');
  applyArgOverrides(selectors, args);

  if (selectors.audio.mode === 'language' && selectors.audio.languages.length === 0) {
    selectors.audio.mode = selectors.audio.firstOnly ? 'first' : 'all';
  }

  if (selectors.subtitle.mode === 'language' && selectors.subtitle.languages.length === 0) {
    selectors.subtitle.mode = selectors.subtitle.firstOnly ? 'first' : 'none';
  }

  return selectors;
}

function selectTrackIds(tracks, selector, trackType) {
  const available = Array.isArray(tracks) ? tracks : [];
  const selectable = trackType === 'subtitle'
    ? available.filter((track) => !Boolean(track?.duplicate))
    : available;
  if (selectable.length === 0) {
    return [];
  }

  if (selector.mode === 'none') {
    return [];
  }

  if (selector.mode === 'all') {
    if (selector.firstOnly) {
      return [selectable[0].id];
    }
    return selectable.map((track) => track.id);
  }

  if (selector.mode === 'explicit') {
    const explicit = selectable
      .filter((track) => selector.explicitIds.includes(track.id))
      .map((track) => track.id);
    if (selector.firstOnly) {
      return explicit.length > 0 ? [explicit[0]] : [];
    }
    return explicit;
  }

  if (selector.mode === 'language') {
    const matches = selectable.filter((track) => selector.languages.includes(track.language));
    if (selector.firstOnly) {
      return matches.length > 0 ? [matches[0].id] : [];
    }
    return matches.map((track) => track.id);
  }

  if (selector.mode === 'first') {
    return [selectable[0].id];
  }

  if (trackType === 'audio') {
    return [selectable[0].id];
  }

  return [];
}

function resolveAudioEncoderAction(track, encoderToken, copyMask, fallbackEncoder) {
  const normalizedToken = String(encoderToken || '').trim().toLowerCase();
  const sourceCodec = track?.codecToken || null;

  if (!normalizedToken || normalizedToken === 'preset-default') {
    return {
      type: 'preset-default',
      encoder: 'preset-default',
      label: 'Preset-Default (HandBrake)'
    };
  }

  if (normalizedToken.startsWith('copy')) {
    const explicitCopyCodec = normalizedToken.includes(':')
      ? normalizedToken.split(':').slice(1).join(':').trim().toLowerCase()
      : null;

    const normalizedMask = Array.isArray(copyMask) ? copyMask : [];
    let canCopy = false;
    let effectiveCodec = sourceCodec;
    if (explicitCopyCodec) {
      canCopy = Boolean(sourceCodec && sourceCodec === explicitCopyCodec);
    } else if (sourceCodec && normalizedMask.length > 0) {
      canCopy = normalizedMask.includes(sourceCodec);
      // DTS-HD MA contains an embedded DTS core track. When dtshd is not in
      // the copy mask but dts is, HandBrake will extract and copy the DTS core.
      if (!canCopy && sourceCodec === 'dtshd' && normalizedMask.includes('dts')) {
        canCopy = true;
        effectiveCodec = 'dts';
      }
    }

    if (canCopy) {
      return {
        type: 'copy',
        encoder: normalizedToken,
        label: `Copy (${effectiveCodec || track?.format || 'Quelle'})`
      };
    }

    const fallback = String(fallbackEncoder || DEFAULT_AUDIO_FALLBACK).trim().toLowerCase() || DEFAULT_AUDIO_FALLBACK;
    return {
      type: 'fallback',
      encoder: fallback,
      label: `Fallback Transcode (${fallback})`
    };
  }

  return {
    type: 'transcode',
    encoder: normalizedToken,
    label: `Transcode (${normalizedToken})`
  };
}

function computeAudioTrackActions(track, selectedIndex, selector) {
  const availableEncoders = Array.isArray(selector.encoders) ? selector.encoders : [];

  let encoderPlan = [];
  if (selector.encoderSource === 'args' && availableEncoders.length > 0) {
    const chosen = availableEncoders[Math.min(selectedIndex, availableEncoders.length - 1)];
    encoderPlan = [chosen];
  } else if (availableEncoders.length > 0) {
    encoderPlan = [...availableEncoders];
  } else {
    encoderPlan = ['preset-default'];
  }

  const actions = encoderPlan.map((encoderToken) => resolveAudioEncoderAction(
    track,
    encoderToken,
    selector.copyMask,
    selector.fallbackEncoder
  ));

  return {
    actions,
    summary: actions.map((item) => item.label).join(' + ')
  };
}

function refreshAudioTrackActionsForPlanTitles(titles, settings = {}, presetProfile = null) {
  const sourceTitles = Array.isArray(titles) ? titles : [];
  if (sourceTitles.length === 0) {
    return sourceTitles;
  }

  const selectors = buildTrackSelectors(settings || {}, presetProfile || null);
  const audioSelector = selectors?.audio && typeof selectors.audio === 'object'
    ? selectors.audio
    : {};

  return sourceTitles.map((title) => {
    const audioTracks = Array.isArray(title?.audioTracks) ? title.audioTracks : [];
    if (audioTracks.length === 0) {
      return title;
    }

    const selectedTracks = audioTracks.filter((track) => Boolean(track?.selectedForEncode));
    const selectedIndexById = new Map(
      selectedTracks
        .map((track, index) => {
          const trackId = Number(track?.id);
          if (!Number.isFinite(trackId)) {
            return null;
          }
          return [Math.trunc(trackId), index];
        })
        .filter(Boolean)
    );

    const nextAudioTracks = audioTracks.map((track) => {
      if (!track?.selectedForEncode) {
        return {
          ...track,
          encodeActions: [],
          encodeActionSummary: 'Nicht übernommen'
        };
      }
      const numericTrackId = Number(track?.id);
      const normalizedTrackId = Number.isFinite(numericTrackId) ? Math.trunc(numericTrackId) : null;
      const selectedIndex = (normalizedTrackId !== null && selectedIndexById.has(normalizedTrackId))
        ? selectedIndexById.get(normalizedTrackId)
        : 0;
      const actions = computeAudioTrackActions(track, selectedIndex, audioSelector);
      return {
        ...track,
        encodePreviewActions: actions.actions,
        encodePreviewSummary: actions.summary,
        encodeActions: actions.actions,
        encodeActionSummary: actions.summary
      };
    });

    return {
      ...title,
      audioTracks: nextAudioTracks
    };
  });
}

function computeSubtitleFlags(trackId, selectedTrackIds, selector) {
  const selected = selectedTrackIds.includes(trackId);
  if (!selected) {
    return {
      burned: false,
      forced: false,
      forcedOnly: false,
      default: false,
      flags: []
    };
  }

  const firstSelectedId = selectedTrackIds[0] || null;
  const burned = selector.burnedTrackId
    ? trackId === selector.burnedTrackId
    : selector.burnBehavior === 'first' && trackId === firstSelectedId;

  const forced = selector.forcedTrackId
    ? trackId === selector.forcedTrackId
    : false;

  const forcedOnly = Boolean(selector.forcedOnly);

  const isDefault = selector.defaultTrackId
    ? trackId === selector.defaultTrackId
    : false;

  const flags = [];
  if (burned) {
    flags.push('burned');
  }
  if (forced) {
    flags.push('forced');
  }
  if (forcedOnly) {
    flags.push('forced-only');
  }
  if (isDefault) {
    flags.push('default');
  }

  return {
    burned,
    forced,
    forcedOnly,
    default: isDefault,
    flags
  };
}

function buildMediainfoReview({
  mediaFiles,
  mediaInfoByPath,
  settings,
  presetProfile,
  playlistAnalysis = null,
  preferredEncodeTitleId = null,
  selectedPlaylistId = null,
  selectedMakemkvTitleId = null
}) {
  const minLengthMinutes = clampNumber(settings?.makemkv_min_length_minutes, 0);
  const minDurationSeconds = Math.max(0, Math.round(minLengthMinutes * 60));
  const trackSelectors = buildTrackSelectors(settings || {}, presetProfile || null);
  const lockedPlaylistId = normalizePlaylistId(selectedPlaylistId);
  const manualSelectionMakemkvTitle = Number(selectedMakemkvTitleId);
  const selectedPlaylistMatch = lockedPlaylistId
    ? resolvePlaylistMatchByPlaylistId(playlistAnalysis, lockedPlaylistId)
    : null;
  const playlistDecisionRequired = Boolean(playlistAnalysis?.manualDecisionRequired && !lockedPlaylistId);

  const titles = (mediaFiles || []).map((file, index) => {
    const parsed = parseMediaInfoFile(mediaInfoByPath[file.path] || {}, file, index);
    let playlistMatch = findPlaylistMatchForTitle(playlistAnalysis, parsed.makemkvTitleId);
    if (lockedPlaylistId) {
      const hasMappedPlaylist = Boolean(normalizePlaylistId(playlistMatch?.playlistId));
      if (!hasMappedPlaylist || selectedPlaylistMatch?.playlistId) {
        playlistMatch = selectedPlaylistMatch || {
          ...emptyPlaylistMatch(),
          playlistId: lockedPlaylistId,
          playlistFile: `${lockedPlaylistId}.mpls`,
          segmentCommand: `strings BDMV/PLAYLIST/${lockedPlaylistId}.mpls | grep m2ts`
        };
      }
    }
    return {
      ...parsed,
      selectedByMinLength: parsed.durationSeconds >= minDurationSeconds,
      playlistMatch
    };
  });

  const selectedTitleIds = titles
    .filter((title) => title.selectedByMinLength)
    .map((title) => title.id);

  const candidateTitles = titles.filter((title) => selectedTitleIds.includes(title.id));
  const lockedCandidates = lockedPlaylistId
    ? candidateTitles.filter((item) => normalizePlaylistId(item?.playlistMatch?.playlistId) === lockedPlaylistId)
    : [];
  const preferredTitleId = Number(preferredEncodeTitleId);
  const preferredTitle = Number.isFinite(preferredTitleId) && preferredTitleId >= 0
    ? candidateTitles.find((item) => Number(item.makemkvTitleId) === preferredTitleId) || null
    : null;
  const preferredByManualSelection = Number.isFinite(manualSelectionMakemkvTitle) && manualSelectionMakemkvTitle >= 0
    ? candidateTitles.find((item) => Number(item.makemkvTitleId) === manualSelectionMakemkvTitle) || null
    : null;

  let encodeInputTitle = null;
  if (preferredByManualSelection && (!lockedPlaylistId || lockedCandidates.includes(preferredByManualSelection))) {
    encodeInputTitle = preferredByManualSelection;
  } else if (preferredTitle && (!lockedPlaylistId || lockedCandidates.includes(preferredTitle))) {
    encodeInputTitle = preferredTitle;
  } else if (lockedPlaylistId && lockedCandidates.length > 0) {
    encodeInputTitle = lockedCandidates.reduce((best, current) => (
      !best || current.sizeBytes > best.sizeBytes ? current : best
    ), null);
  } else if (!playlistDecisionRequired) {
    encodeInputTitle = candidateTitles.reduce((best, current) => (
      !best || current.sizeBytes > best.sizeBytes ? current : best
    ), null);
  }

  let normalizedTitles = titles.map((title) => {
    const isEncodeInput = encodeInputTitle ? title.id === encodeInputTitle.id : false;
    const selectedAudioIds = selectTrackIds(title.audioTracks, trackSelectors.audio, 'audio');
    const selectedSubtitleIds = selectTrackIds(title.subtitleTracks, trackSelectors.subtitle, 'subtitle');

    const audioIndexById = new Map(selectedAudioIds.map((id, index) => [id, index]));

    const normalizedAudio = title.audioTracks.map((track) => {
      const selectedByRule = selectedAudioIds.includes(track.id);
      if (!selectedByRule) {
        return {
          ...track,
          selectedByRule: false,
          encodePreviewActions: [],
          encodePreviewSummary: 'Nicht übernommen'
        };
      }

      const selectedIndex = audioIndexById.get(track.id) || 0;
      const actions = computeAudioTrackActions(track, selectedIndex, trackSelectors.audio);
      return {
        ...track,
        selectedByRule: true,
        encodePreviewActions: actions.actions,
        encodePreviewSummary: actions.summary
      };
    });

    const normalizedSubtitle = title.subtitleTracks.map((track) => {
      const selectedByRule = selectedSubtitleIds.includes(track.id);
      const subtitleFlags = computeSubtitleFlags(track.id, selectedSubtitleIds, trackSelectors.subtitle);
      const inferredForced = Boolean(
        track?.forcedTrack
        || String(track?.subtitleType || '').trim().toLowerCase() === 'forced'
      );
      const inferredForcedOnly = Boolean(
        track?.isForcedOnly
        ?? track?.forcedOnly
        ?? track?.subtitlePreviewForcedOnly
        ?? inferredForced
      );
      const inferredDefault = Boolean(track?.defaultFlag);
      const subtitlePreviewFlags = [];
      if (subtitleFlags.burned) {
        subtitlePreviewFlags.push('burned');
      }
      if (subtitleFlags.forced || inferredForced) {
        subtitlePreviewFlags.push('forced');
      }
      if (subtitleFlags.forcedOnly || inferredForcedOnly) {
        subtitlePreviewFlags.push('forced-only');
      }
      if (subtitleFlags.default || inferredDefault) {
        subtitlePreviewFlags.push('default');
      }
      const subtitlePreviewSummary = !selectedByRule
        ? 'Nicht übernommen'
        : (subtitlePreviewFlags.length > 0
          ? `Übernehmen (${subtitlePreviewFlags.join(', ')})`
          : 'Übernehmen');

      return {
        ...track,
        selectedByRule,
        subtitlePreviewSummary,
        subtitlePreviewFlags: selectedByRule ? subtitlePreviewFlags : [],
        subtitlePreviewBurnIn: subtitleFlags.burned,
        subtitlePreviewForced: selectedByRule ? (subtitleFlags.forced || inferredForced) : false,
        subtitlePreviewForcedOnly: selectedByRule ? (subtitleFlags.forcedOnly || inferredForcedOnly) : false,
        subtitlePreviewDefaultTrack: selectedByRule ? (subtitleFlags.default || inferredDefault) : false
      };
    });

    return {
      ...title,
      selectedForEncode: isEncodeInput,
      encodeInput: isEncodeInput,
      eligibleForEncode: title.selectedByMinLength,
      playlistId: title.playlistMatch?.playlistId || null,
      playlistFile: title.playlistMatch?.playlistFile || null,
      playlistRecommended: Boolean(title.playlistMatch?.recommended),
      playlistEvaluationLabel: title.playlistMatch?.evaluationLabel || null,
      playlistSegmentCommand: title.playlistMatch?.segmentCommand || null,
      playlistSegmentFiles: Array.isArray(title.playlistMatch?.segmentFiles) ? title.playlistMatch.segmentFiles : [],
      audioTracks: normalizedAudio.map((track) => {
        const selectedForEncode = isEncodeInput && track.selectedByRule;
        return {
          ...track,
          selectedForEncode,
          encodeActions: selectedForEncode ? track.encodePreviewActions : [],
          encodeActionSummary: selectedForEncode ? track.encodePreviewSummary : 'Nicht übernommen'
        };
      }),
      subtitleTracks: normalizedSubtitle.map((track) => {
        const selectedForEncode = isEncodeInput && track.selectedByRule;
        return {
          ...track,
          selectedForEncode,
          burnIn: selectedForEncode ? track.subtitlePreviewBurnIn : false,
          forced: selectedForEncode ? track.subtitlePreviewForced : false,
          forcedOnly: selectedForEncode ? track.subtitlePreviewForcedOnly : false,
          defaultTrack: selectedForEncode ? track.subtitlePreviewDefaultTrack : false,
          flags: selectedForEncode ? track.subtitlePreviewFlags : [],
          subtitleActionSummary: selectedForEncode ? track.subtitlePreviewSummary : 'Nicht übernommen'
        };
      })
    };
  });

  if (lockedPlaylistId && encodeInputTitle) {
    normalizedTitles = normalizedTitles.filter((item) => item.id === encodeInputTitle.id);
  }

  const encodeInputPath = encodeInputTitle ? encodeInputTitle.filePath : null;

  const notes = [
    `Preset: ${trackSelectors.preset || '-'}`,
    `Extra Args: ${trackSelectors.extraArgs || '(keine)'}`,
    `Preset-Quelle: ${trackSelectors.presetProfileSource}`,
    'Preset-Defaults werden als Basis genutzt. HB_ARGS überschreibt diese, sobald Optionen gesetzt sind.'
  ];

  if (trackSelectors.presetProfileMessage) {
    notes.push(`Preset-Hinweis: ${trackSelectors.presetProfileMessage}`);
  }
  if (lockedPlaylistId) {
    notes.push(`Manuelle Playlist-Auswahl aktiv: ${lockedPlaylistId}.mpls`);
  }

  const recommendedPlaylistId = normalizePlaylistId(playlistAnalysis?.recommendation?.playlistId || null);
  const recommendedMakemkvTitleId = Number(playlistAnalysis?.recommendation?.titleId);
  const recommendedReviewTitle = normalizedTitles.find((item) => item.playlistId === recommendedPlaylistId)
    || (Number.isFinite(recommendedMakemkvTitleId)
      ? normalizedTitles.find((item) => Number(item.makemkvTitleId) === recommendedMakemkvTitleId)
      : null);

  return {
    generatedAt: new Date().toISOString(),
    minLengthMinutes,
    selectors: trackSelectors,
    playlistDecisionRequired,
    playlistRecommendation: recommendedPlaylistId
      ? {
        playlistId: recommendedPlaylistId,
        playlistFile: `${recommendedPlaylistId}.mpls`,
        makemkvTitleId: Number.isFinite(recommendedMakemkvTitleId) ? recommendedMakemkvTitleId : null,
        reviewTitleId: recommendedReviewTitle?.id || null,
        reason: playlistAnalysis?.recommendation?.reason || null
      }
      : null,
    titles: normalizedTitles,
    selectedTitleIds,
    encodeInputTitleId: encodeInputTitle?.id || null,
    encodeInputPath,
    titleSelectionRequired: Boolean(playlistDecisionRequired && !encodeInputPath),
    notes
  };
}

module.exports = {
  parseDurationSeconds,
  buildMediainfoReview,
  refreshAudioTrackActionsForPlanTitles
};
