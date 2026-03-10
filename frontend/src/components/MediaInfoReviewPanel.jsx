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

function isForcedOnlySubtitleTrack(track) {
  const summary = `${track?.title || ''} ${track?.description || ''} ${track?.languageLabel || ''}`.toLowerCase();
  return Boolean(
    track?.forcedTrack
    || /forced only/.test(summary)
    || /nur erzwungen/.test(summary)
    || /\berzwungen\b/.test(summary)
  );
}

function hasForcedSubtitleAvailable(track) {
  const sourceTrackIds = normalizeTrackIdList(
    Array.isArray(track?.forcedSourceTrackIds) ? track.forcedSourceTrackIds : []
  );
  return Boolean(track?.forcedAvailable || sourceTrackIds.length > 0);
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
    const isSubtitleWithValue = SUBTITLE_SELECTION_KEYS_WITH_VALUE.has(key)
      || SUBTITLE_FLAG_KEYS_WITH_VALUE.has(key);
    const isSubtitleFlagOnly = SUBTITLE_SELECTION_KEYS_FLAG_ONLY.has(key);
    const isTitleWithValue = TITLE_SELECTION_KEYS_WITH_VALUE.has(key);
    const skip = isAudioWithValue || isAudioFlagOnly || isSubtitleWithValue || isSubtitleFlagOnly || isTitleWithValue;

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

function buildHandBrakeCommandPreview({
  review,
  title,
  selectedAudioTrackIds,
  selectedSubtitleTrackIds,
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
  const rawMappedTitleId = Number(review?.handBrakeTitleId);
  const mappedTitleId = Number.isFinite(rawMappedTitleId) && rawMappedTitleId > 0
    ? Math.trunc(rawMappedTitleId)
    : null;

  const selectedSubtitleSet = new Set(normalizeTrackIdList(selectedSubtitleTrackIds).map((id) => String(id)));
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
  const subtitleForcedTrackId = normalizeTrackIdList(
    selectedSubtitleTracks.filter((track) => Boolean(track?.subtitlePreviewForced || track?.forced)).map((track) => track?.id)
  )[0] || null;
  const subtitleForcedOnly = selectedSubtitleTracks.some((track) => Boolean(track?.subtitlePreviewForcedOnly || track?.forcedOnly));

  const baseArgs = [
    '-i',
    inputPath || '<encode-input>',
    '-o',
    String(commandOutputPath || '').trim() || '<encode-output>'
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
    normalizeTrackIdList(selectedSubtitleTrackIds).join(',') || 'none'
  ];

  if (subtitleBurnTrackId !== null) {
    overrideArgs.push(`--subtitle-burned=${subtitleBurnTrackId}`);
  }
  if (subtitleDefaultTrackId !== null) {
    overrideArgs.push(`--subtitle-default=${subtitleDefaultTrackId}`);
  }
  if (subtitleForcedTrackId !== null) {
    overrideArgs.push(`--subtitle-forced=${subtitleForcedTrackId}`);
  } else if (subtitleForcedOnly) {
    overrideArgs.push('--subtitle-forced');
  }

  const finalArgs = [...baseArgs, ...filteredExtra, ...overrideArgs];
  return `${handBrakeCmd} ${finalArgs.map((arg) => shellQuote(arg)).join(' ')}`;
}

function toLang2(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) {
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
  onToggleTrack = null,
  audioSelector = null
}) {
  const selectedIds = normalizeTrackIdList(selectedTrackIds);
  const checkedTrackOrder = (Array.isArray(tracks) ? tracks : [])
    .map((track) => normalizeTrackId(track?.id))
    .filter((trackId, index) => {
      if (trackId === null) {
        return false;
      }
      if (allowSelection) {
        return selectedIds.includes(trackId);
      }
      const track = tracks[index];
      return Boolean(track?.selectedForEncode);
    });

  return (
    <div>
      <h4>{title}</h4>
      {!tracks || tracks.length === 0 ? (
        <p>Keine Einträge.</p>
      ) : (
        <div className="media-track-list">
          {tracks.map((track) => {
            const trackId = normalizeTrackId(track.id);
            const burned = type === 'subtitle' ? isBurnedSubtitleTrack(track) : false;
            const checked = allowSelection
              ? (trackId !== null && selectedIds.includes(trackId) && !(type === 'subtitle' && burned))
              : Boolean(track.selectedForEncode);
            const selectedIndex = trackId !== null
              ? checkedTrackOrder.indexOf(trackId)
              : -1;
            const actionInfo = type === 'audio'
              ? (checked
                ? (() => {
                  const base = String(track.encodePreviewSummary || track.encodeActionSummary || '').trim();
                  const staleUnselectedSummary = /^nicht übernommen$/i.test(base);
                  if (staleUnselectedSummary) {
                    return buildAudioActionPreviewSummary(track, selectedIndex, audioSelector);
                  }
                  return base || buildAudioActionPreviewSummary(track, selectedIndex, audioSelector);
                })()
                : 'Nicht übernommen')
              : type === 'subtitle'
                ? (checked
                  ? (() => {
                    const base = String(track.subtitlePreviewSummary || track.subtitleActionSummary || '').trim();
                    return /^nicht übernommen$/i.test(base) ? 'Übernehmen' : (base || 'Übernehmen');
                  })()
                  : 'Nicht übernommen')
                : null;
            const displayLanguage = toLang2(track.language || track.languageLabel || 'und');
            const displayHint = track.description || track.title;
            const displayCodec = simplifyCodec(type, track.format, displayHint);
            const displayChannelCount = channelCount(track.channels);
            const displayAudioTitle = audioChannelLabel(track.channels);
            const audioVariant = type === 'audio' ? extractAudioVariant(displayHint) : '';
            const disabled = !allowSelection || (type === 'subtitle' && burned);
            const forcedOnlyTrack = type === 'subtitle' ? isForcedOnlySubtitleTrack(track) : false;
            const forcedAvailable = type === 'subtitle' ? hasForcedSubtitleAvailable(track) : false;

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
            if (type === 'subtitle' && burned) {
              displayText += ' | burned';
            } else if (type === 'subtitle' && forcedOnlyTrack) {
              displayText += ' | forced-only';
            } else if (type === 'subtitle' && forcedAvailable) {
              displayText += ' | forced verfügbar';
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
                  <span>{displayText}</span>
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
  selectedEncodeTitleId = null,
  allowTitleSelection = false,
  onSelectEncodeTitle = null,
  allowTrackSelection = false,
  trackSelectionByTitle = {},
  onTrackSelectionChange = null,
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
  onUserPresetChange = null
}) {
  if (!review) {
    return <p>Keine Mediainfo-Daten vorhanden.</p>;
  }

  const titles = review.titles || [];
  const currentSelectedId = normalizeTitleId(selectedEncodeTitleId) || normalizeTitleId(review.encodeInputTitleId);
  const encodeInputTitle = titles.find((item) => item.id === currentSelectedId) || null;
  const processedFiles = Number(review.processedFiles || titles.length || 0);
  const totalFiles = Number(review.totalFiles || titles.length || 0);
  const playlistRecommendation = review.playlistRecommendation || null;
  const rawPreset = String(review.selectors?.preset || '').trim();
  const presetLabel = String(presetDisplayValue || rawPreset).trim() || '(kein Preset)';

  // User preset resolution
  const normalizedUserPresets = Array.isArray(userPresets) ? userPresets : [];
  const selectedUserPreset = selectedUserPresetId
    ? normalizedUserPresets.find((p) => Number(p.id) === Number(selectedUserPresetId)) || null
    : null;
  const effectivePresetOverride = selectedUserPreset
    ? { handbrakePreset: selectedUserPreset.handbrakePreset || '', extraArgs: selectedUserPreset.extraArgs || '' }
    : null;
  const hasUserPresets = normalizedUserPresets.length > 0;
  const allowUserPresetSelection = hasUserPresets && typeof onUserPresetChange === 'function' && allowEncodeItemSelection;

  const scriptCatalog = (Array.isArray(availableScripts) ? availableScripts : [])
    .map((item) => ({
      id: normalizeScriptId(item?.id),
      name: String(item?.name || '').trim()
    }))
    .filter((item) => item.id !== null && item.name.length > 0);
  const scriptById = new Map(scriptCatalog.map((item) => [item.id, item]));
  const chainCatalog = (Array.isArray(availableChains) ? availableChains : [])
    .map((item) => ({ id: Number(item?.id), name: String(item?.name || '').trim() }))
    .filter((item) => Number.isFinite(item.id) && item.id > 0 && item.name.length > 0);
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

  return (
    <div className="media-review-wrap">
      {allowUserPresetSelection && (
        <div className="user-preset-selector" style={{ marginBottom: '0.75rem', padding: '0.75rem', border: '1px solid var(--surface-border, #e0e0e0)', borderRadius: '6px', background: 'var(--surface-ground, #f8f8f8)' }}>
          <label style={{ display: 'block', marginBottom: '0.4rem', fontWeight: 600 }}>
            Encode-Preset auswählen
          </label>
          <Dropdown
            value={selectedUserPresetId ? Number(selectedUserPresetId) : null}
            options={[
              { label: '(Einstellungen-Fallback)', value: null },
              ...normalizedUserPresets.map((p) => ({
                label: `${p.name}${p.mediaType !== 'all' ? ` [${p.mediaType === 'bluray' ? 'Blu-ray' : p.mediaType === 'dvd' ? 'DVD' : 'Sonstiges'}]` : ''}`,
                value: Number(p.id)
              }))
            ]}
            onChange={(e) => onUserPresetChange(e.value)}
            placeholder="(Einstellungen-Fallback)"
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

      <div className="media-review-meta">
        <div>
          <strong>Preset:</strong>{' '}
          {effectivePresetOverride
            ? (effectivePresetOverride.handbrakePreset || '(kein Preset)')
            : presetLabel}
          {effectivePresetOverride && <span style={{ marginLeft: '0.5rem', fontSize: '0.75rem', opacity: 0.7 }}>(User-Preset: {selectedUserPreset?.name})</span>}
        </div>
        <div>
          <strong>Extra Args:</strong>{' '}
          {effectivePresetOverride
            ? (effectivePresetOverride.extraArgs || '(keine)')
            : (review.selectors?.extraArgs || '(keine)')}
          {effectivePresetOverride && !selectedUserPreset?.extraArgs && <span style={{ marginLeft: '0.5rem', fontSize: '0.75rem', opacity: 0.7 }}>(aus User-Preset)</span>}
        </div>
        <div><strong>Preset-Profil:</strong> {effectivePresetOverride ? 'user-preset' : (review.selectors?.presetProfileSource || '-')}</div>
        <div><strong>MIN_LENGTH_MINUTES:</strong> {review.minLengthMinutes}</div>
        <div><strong>Encode Input:</strong> {encodeInputTitle?.fileName || '-'}</div>
        <div><strong>Audio Auswahl:</strong> {review.selectors?.audio?.mode || '-'}</div>
        <div><strong>Audio Encoder:</strong> {(review.selectors?.audio?.encoders || []).join(', ') || 'Preset-Default'}</div>
        <div><strong>Audio Copy-Mask:</strong> {(review.selectors?.audio?.copyMask || []).join(', ') || '-'}</div>
        <div><strong>Audio Fallback:</strong> {review.selectors?.audio?.fallbackEncoder || '-'}</div>
        <div><strong>Subtitle Auswahl:</strong> {review.selectors?.subtitle?.mode || '-'}</div>
        <div><strong>Subtitle Flags:</strong> {review.selectors?.subtitle?.forcedOnly ? 'forced-only' : '-'}{review.selectors?.subtitle?.burnBehavior === 'first' ? ' + burned(first)' : ''}</div>
      </div>

      {review.partial ? (
        <small>Zwischenstand: {processedFiles}/{totalFiles} Datei(en) analysiert.</small>
      ) : null}

      {playlistRecommendation ? (
        <div className="playlist-recommendation-box">
          <small>
            <strong>Empfehlung:</strong> {playlistRecommendation.playlistFile || '-'}
            {playlistRecommendation.reviewTitleId ? ` (Titel #${playlistRecommendation.reviewTitleId})` : ''}
          </small>
          {playlistRecommendation.reason ? <small>{playlistRecommendation.reason}</small> : null}
        </div>
      ) : null}

      {Array.isArray(review.notes) && review.notes.length > 0 ? (
        <div className="media-review-notes">
          {review.notes.map((note, idx) => (
            <small key={`${idx}-${note}`}>{note}</small>
          ))}
        </div>
      ) : null}

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
              preEncodeItems.filter((it, i) => it.type === 'script' && i !== rowIndex).map((it) => String(normalizeScriptId(it.id)))
            );
            const scriptOptions = scriptCatalog.map((s) => ({
              label: s.name,
              value: s.id,
              disabled: usedScriptIds.has(String(s.id))
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
                      <span className="post-script-chain-name">{name}</span>
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
            postEncodeItems.filter((it, i) => it.type === 'script' && i !== rowIndex).map((it) => String(normalizeScriptId(it.id)))
          );
          const scriptOptions = scriptCatalog.map((s) => ({
            label: s.name,
            value: s.id,
            disabled: usedScriptIds.has(String(s.id))
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
                    <span className="post-script-chain-name">{name}</span>
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

      <h4>Titel</h4>
      <div className="media-title-list">
        {titles.length === 0 ? (
          <p>Keine Titel analysiert.</p>
        ) : titles.map((title) => {
          const titleEligible = title?.eligibleForEncode !== false;
          const titleChecked = allowTitleSelection
            ? (currentSelectedId !== null
              ? currentSelectedId === normalizeTitleId(title.id)
              : Boolean(title.selectedForEncode))
            : Boolean(title.selectedForEncode);
          const titleSelectionEntry = trackSelectionByTitle?.[title.id] || trackSelectionByTitle?.[String(title.id)] || {};
          const subtitleTracks = Array.isArray(title.subtitleTracks) ? title.subtitleTracks : [];
          const selectableSubtitleTrackIds = subtitleTracks
            .filter((track) => !isBurnedSubtitleTrack(track))
            .map((track) => normalizeTrackId(track?.id))
            .filter((id) => id !== null);
          const selectableSubtitleTrackIdSet = new Set(selectableSubtitleTrackIds.map((id) => String(id)));
          const defaultAudioTrackIds = (Array.isArray(title.audioTracks) ? title.audioTracks : [])
            .filter((track) => Boolean(track?.selectedByRule))
            .map((track) => normalizeTrackId(track?.id))
            .filter((id) => id !== null);
          const defaultSubtitleTrackIds = subtitleTracks
            .filter((track) => Boolean(track?.selectedByRule) && !isBurnedSubtitleTrack(track))
            .map((track) => normalizeTrackId(track?.id))
            .filter((id) => id !== null);
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
          const allowTrackSelectionForTitle = Boolean(
            allowTrackSelection
            && allowTitleSelection
            && titleChecked
          );

          return (
            <div key={title.id} className="media-title-block">
              <label className="readonly-check-row">
                <input
                  type="checkbox"
                  checked={titleChecked}
                  onChange={() => {
                    if (!allowTitleSelection || typeof onSelectEncodeTitle !== 'function') {
                      return;
                    }
                    onSelectEncodeTitle(normalizeTitleId(title.id));
                  }}
                  readOnly={!allowTitleSelection}
                  disabled={!allowTitleSelection}
                />
                <span>
                  #{title.id} | {title.fileName} | {formatDuration(title.durationMinutes)} | {formatBytes(title.sizeBytes)}
                  {title.encodeInput ? ' | Encode-Input' : ''}
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
                  title={`Tonspuren (Titel #${title.id})`}
                  tracks={title.audioTracks || []}
                  type="audio"
                  allowSelection={allowTrackSelectionForTitle}
                  selectedTrackIds={selectedAudioTrackIds}
                  audioSelector={review?.selectors?.audio || null}
                  onToggleTrack={(trackId, checked) => {
                    if (!allowTrackSelectionForTitle || typeof onTrackSelectionChange !== 'function') {
                      return;
                    }
                    onTrackSelectionChange(title.id, 'audio', trackId, checked);
                  }}
                />
                <TrackList
                  title={`Subtitles (Titel #${title.id})`}
                  tracks={allowTrackSelectionForTitle ? subtitleTracks.filter((track) => !isBurnedSubtitleTrack(track)) : subtitleTracks}
                  type="subtitle"
                  allowSelection={allowTrackSelectionForTitle}
                  selectedTrackIds={selectedSubtitleTrackIds}
                  onToggleTrack={(trackId, checked) => {
                    if (!allowTrackSelectionForTitle || typeof onTrackSelectionChange !== 'function') {
                      return;
                    }
                    onTrackSelectionChange(title.id, 'subtitle', trackId, checked);
                  }}
                />
              </div>
              {titleChecked ? (() => {
                const commandPreview = buildHandBrakeCommandPreview({
                  review,
                  title,
                  selectedAudioTrackIds,
                  selectedSubtitleTrackIds,
                  commandOutputPath,
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
    </div>
  );
}
