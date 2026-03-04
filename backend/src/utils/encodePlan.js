const path = require('path');
const { splitArgs } = require('./commandLine');

const DEFAULT_AUDIO_COPY_MASK = ['aac', 'ac3', 'eac3', 'truehd', 'dts', 'dtshd', 'mp3', 'flac'];
const DEFAULT_AUDIO_FALLBACK = 'av_aac';
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

  const subtitleTracks = tracks
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
      format: item?.Format || null
    }));

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

function buildBaseTrackSelectors(settings, presetProfile = null) {
  const profile = presetProfile && typeof presetProfile === 'object' ? presetProfile : {};
  const audioLanguages = Array.isArray(profile.audioLanguages)
    ? profile.audioLanguages.map((item) => normalizeSelectionLanguage(item)).filter(Boolean)
    : [];
  const subtitleLanguages = Array.isArray(profile.subtitleLanguages)
    ? profile.subtitleLanguages.map((item) => normalizeSelectionLanguage(item)).filter(Boolean)
    : [];
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

  return {
    preset: settings?.handbrake_preset || null,
    extraArgs: settings?.handbrake_extra_args || '',
    presetProfileSource: profile.source || 'fallback',
    presetProfileMessage: profile.message || null,
    audio: {
      mode: baseAudioMode,
      languages: audioLanguages.filter((item) => item !== 'none'),
      explicitIds: [],
      firstOnly: baseAudioMode === 'first',
      selectionSource: profile.source === 'preset-export' ? 'preset' : 'default',
      encoders: audioEncoders,
      encoderSource: audioEncoders.length > 0 ? (profile.source === 'preset-export' ? 'preset' : 'default') : 'default',
      copyMask: normalizedCopyMask.length > 0 ? normalizedCopyMask : [...DEFAULT_AUDIO_COPY_MASK],
      copyMaskSource: normalizedCopyMask.length > 0 ? (profile.source === 'preset-export' ? 'preset' : 'default') : 'default',
      fallbackEncoder: String(profile.audioFallback || DEFAULT_AUDIO_FALLBACK).trim().toLowerCase() || DEFAULT_AUDIO_FALLBACK,
      fallbackSource: profile.audioFallback ? (profile.source === 'preset-export' ? 'preset' : 'default') : 'default'
    },
    subtitle: {
      mode: baseSubtitleMode,
      languages: subtitleLanguages.filter((item) => item !== 'none'),
      explicitIds: [],
      firstOnly: baseSubtitleMode === 'first',
      selectionSource: profile.source === 'preset-export' ? 'preset' : 'default',
      burnBehavior: normalizeBurnBehavior(profile.subtitleBurnBehavior),
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
  if (available.length === 0) {
    return [];
  }

  if (selector.mode === 'none') {
    return [];
  }

  if (selector.mode === 'all') {
    if (selector.firstOnly) {
      return [available[0].id];
    }
    return available.map((track) => track.id);
  }

  if (selector.mode === 'explicit') {
    const explicit = available
      .filter((track) => selector.explicitIds.includes(track.id))
      .map((track) => track.id);
    if (selector.firstOnly) {
      return explicit.length > 0 ? [explicit[0]] : [];
    }
    return explicit;
  }

  if (selector.mode === 'language') {
    const matches = available.filter((track) => selector.languages.includes(track.language));
    if (selector.firstOnly) {
      return matches.length > 0 ? [matches[0].id] : [];
    }
    return matches.map((track) => track.id);
  }

  if (selector.mode === 'first') {
    return [available[0].id];
  }

  if (trackType === 'audio') {
    return [available[0].id];
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
    if (explicitCopyCodec) {
      canCopy = Boolean(sourceCodec && sourceCodec === explicitCopyCodec);
    } else if (sourceCodec && normalizedMask.length > 0) {
      canCopy = normalizedMask.includes(sourceCodec);
    }

    if (canCopy) {
      return {
        type: 'copy',
        encoder: normalizedToken,
        label: `Copy (${sourceCodec || track?.format || 'Quelle'})`
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
      const subtitlePreviewSummary = !selectedByRule
        ? 'Nicht übernommen'
        : (subtitleFlags.flags.length > 0
          ? `Übernehmen (${subtitleFlags.flags.join(', ')})`
          : 'Übernehmen');

      return {
        ...track,
        selectedByRule,
        subtitlePreviewSummary,
        subtitlePreviewFlags: subtitleFlags.flags,
        subtitlePreviewBurnIn: subtitleFlags.burned,
        subtitlePreviewForced: subtitleFlags.forced,
        subtitlePreviewForcedOnly: subtitleFlags.forcedOnly,
        subtitlePreviewDefaultTrack: subtitleFlags.default
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
  buildMediainfoReview
};
