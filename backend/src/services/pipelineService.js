const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { getDb } = require('../db/database');
const settingsService = require('./settingsService');
const historyService = require('./historyService');
const omdbService = require('./omdbService');
const wsService = require('./websocketService');
const diskDetectionService = require('./diskDetectionService');
const notificationService = require('./notificationService');
const logger = require('./logger').child('PIPELINE');
const { spawnTrackedProcess } = require('./processRunner');
const { parseMakeMkvProgress, parseHandBrakeProgress } = require('../utils/progressParsers');
const { ensureDir, sanitizeFileName, renderTemplate, findMediaFiles } = require('../utils/files');
const { buildMediainfoReview } = require('../utils/encodePlan');
const { analyzePlaylistObfuscation, normalizePlaylistId } = require('../utils/playlistAnalysis');
const { errorToMeta } = require('../utils/errorMeta');

const RUNNING_STATES = new Set(['ANALYZING', 'RIPPING', 'ENCODING', 'MEDIAINFO_CHECK']);
const REVIEW_REFRESH_SETTING_PREFIXES = ['handbrake_', 'mediainfo_'];
const REVIEW_REFRESH_SETTING_KEYS = new Set(['makemkv_min_length_minutes']);

function nowIso() {
  return new Date().toISOString();
}

function fileTimestamp() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const h = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  const s = String(d.getSeconds()).padStart(2, '0');
  return `${y}${m}${day}-${h}${min}${s}`;
}

function withTimestampBeforeExtension(targetPath, suffix) {
  const dir = path.dirname(targetPath);
  const ext = path.extname(targetPath);
  const base = path.basename(targetPath, ext);
  return path.join(dir, `${base}_${suffix}${ext}`);
}

function buildOutputPathFromJob(settings, job, fallbackJobId = null) {
  const movieDir = settings.movie_dir;
  const title = job.title || job.detected_title || (fallbackJobId ? `job-${fallbackJobId}` : 'job');
  const year = job.year || new Date().getFullYear();
  const imdbId = job.imdb_id || (fallbackJobId ? `job-${fallbackJobId}` : 'noimdb');
  const template = settings.filename_template || '${title} (${year})';
  const folderName = sanitizeFileName(
    renderTemplate('${title} (${year})', {
      title,
      year,
      imdbId
    })
  );
  const baseName = sanitizeFileName(
    renderTemplate(template, {
      title,
      year,
      imdbId
    })
  );
  const ext = settings.output_extension || 'mkv';
  return path.join(movieDir, folderName, `${baseName}.${ext}`);
}

function ensureUniqueOutputPath(outputPath) {
  if (!fs.existsSync(outputPath)) {
    return outputPath;
  }

  const ts = fileTimestamp();
  let attempt = withTimestampBeforeExtension(outputPath, ts);
  let i = 1;
  while (fs.existsSync(attempt)) {
    attempt = withTimestampBeforeExtension(outputPath, `${ts}-${i}`);
    i += 1;
  }
  return attempt;
}

function truncateLine(value, max = 180) {
  const raw = String(value || '').replace(/\s+/g, ' ').trim();
  if (raw.length <= max) {
    return raw;
  }
  return `${raw.slice(0, max)}...`;
}

function extractProgressDetail(source, line) {
  const text = truncateLine(line, 220);
  if (!text) {
    return null;
  }

  if (source.startsWith('MAKEMKV')) {
    const prgc = text.match(/^PRGC:\d+,\d+,\"([^\"]+)\"/i);
    if (prgc) {
      return truncateLine(prgc[1], 160);
    }
    if (/Title\s+#?\d+/i.test(text)) {
      return text;
    }
    if (/copying|saving|writing|decrypt/i.test(text)) {
      return text;
    }
    if (/operation|progress|processing/i.test(text)) {
      return text;
    }
  }

  if (source === 'HANDBRAKE') {
    if (/Encoding:\s*task/i.test(text)) {
      return text;
    }
    if (/Muxing|work result|subtitle scan|frame/i.test(text)) {
      return text;
    }
  }

  return null;
}

function composeStatusText(stage, percent, detail) {
  const base = percent !== null && percent !== undefined
    ? `${stage} ${percent.toFixed(2)}%`
    : stage;

  if (detail) {
    return `${base} - ${detail}`;
  }

  return base;
}

function shouldKeepHighlight(line) {
  return /error|fail|warn|title\s+#|saving|encoding:|muxing|copying|decrypt/i.test(line);
}

function parseDetectedTitle(lines) {
  const candidates = [];
  const blockedPatterns = [
    /evaluierungsversion/i,
    /evaluation version/i,
    /es verbleiben noch/i,
    /days remaining/i,
    /makemkv/i,
    /www\./i,
    /beta/i
  ];

  const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();

  for (const line of lines) {
    const cinfoMatch = line.match(/CINFO:2,0,"([^"]+)"/i);
    if (cinfoMatch) {
      candidates.push(cinfoMatch[1]);
    }

    const tinfoMatch = line.match(/TINFO:\d+,2,\d+,"([^"]+)"/i);
    if (tinfoMatch) {
      candidates.push(tinfoMatch[1]);
    }
  }

  const clean = candidates
    .map(normalize)
    .filter((value) => value.length > 2 && !value.startsWith('/'))
    .filter((value) => !blockedPatterns.some((pattern) => pattern.test(value)))
    .filter((value) => !/^disc\s*\d*$/i.test(value))
    .filter((value) => !/^unknown/i.test(value));

  if (clean.length === 0) {
    return null;
  }

  clean.sort((a, b) => b.length - a.length);
  return clean[0];
}

function parseMediainfoJsonOutput(rawOutput) {
  const text = String(rawOutput || '').trim();
  if (!text) {
    return null;
  }

  const extractJsonObjects = (value) => {
    const source = String(value || '');
    const objects = [];
    let start = -1;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = 0; i < source.length; i += 1) {
      const ch = source[i];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (ch === '\\') {
          escaped = true;
        } else if (ch === '"') {
          inString = false;
        }
        continue;
      }

      if (ch === '"') {
        inString = true;
        continue;
      }
      if (ch === '{') {
        if (depth === 0) {
          start = i;
        }
        depth += 1;
        continue;
      }
      if (ch === '}' && depth > 0) {
        depth -= 1;
        if (depth === 0 && start >= 0) {
          objects.push(source.slice(start, i + 1));
          start = -1;
        }
      }
    }
    return objects;
  };

  const parsedObjects = [];
  const rawObjects = extractJsonObjects(text);
  for (const candidate of rawObjects) {
    try {
      parsedObjects.push(JSON.parse(candidate));
    } catch (_error) {
      // ignore malformed blocks and continue
    }
  }

  if (parsedObjects.length === 0) {
    try {
      return JSON.parse(text);
    } catch (_error) {
      return null;
    }
  }

  const hasTitleList = (entry) =>
    Array.isArray(entry?.TitleList)
    || Array.isArray(entry?.Scan?.TitleList)
    || Array.isArray(entry?.title_list);

  const hasMediaTrack = (entry) =>
    Array.isArray(entry?.media?.track)
    || Array.isArray(entry?.Media?.track);

  const getTitleList = (entry) => {
    if (Array.isArray(entry?.TitleList)) {
      return entry.TitleList;
    }
    if (Array.isArray(entry?.Scan?.TitleList)) {
      return entry.Scan.TitleList;
    }
    if (Array.isArray(entry?.title_list)) {
      return entry.title_list;
    }
    return [];
  };

  const titleSets = parsedObjects
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => hasTitleList(entry))
    .map(({ entry, index }) => {
      const titles = getTitleList(entry);
      let audioTracks = 0;
      let subtitleTracks = 0;
      let validAudioTracks = 0;
      let validSubtitleTracks = 0;

      for (const title of titles) {
        const audioList = Array.isArray(title?.AudioList) ? title.AudioList : [];
        const subtitleList = Array.isArray(title?.SubtitleList) ? title.SubtitleList : [];
        audioTracks += audioList.length;
        subtitleTracks += subtitleList.length;
        validAudioTracks += audioList.filter((track) => Number.isFinite(Number(track?.TrackNumber)) && Number(track.TrackNumber) > 0).length;
        validSubtitleTracks += subtitleList.filter((track) => Number.isFinite(Number(track?.TrackNumber)) && Number(track.TrackNumber) > 0).length;
      }

      return {
        entry,
        index,
        titleCount: titles.length,
        audioTracks,
        subtitleTracks,
        validAudioTracks,
        validSubtitleTracks
      };
    });

  if (titleSets.length > 0) {
    titleSets.sort((a, b) =>
      b.validAudioTracks - a.validAudioTracks
      || b.validSubtitleTracks - a.validSubtitleTracks
      || b.audioTracks - a.audioTracks
      || b.subtitleTracks - a.subtitleTracks
      || b.titleCount - a.titleCount
      || b.index - a.index
    );
    return titleSets[0].entry;
  }

  const mediaSets = parsedObjects
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => hasMediaTrack(entry))
    .map(({ entry, index }) => {
      const tracks = Array.isArray(entry?.media?.track)
        ? entry.media.track
        : (Array.isArray(entry?.Media?.track) ? entry.Media.track : []);
      return {
        entry,
        index,
        trackCount: tracks.length
      };
    });

  if (mediaSets.length > 0) {
    mediaSets.sort((a, b) => b.trackCount - a.trackCount || b.index - a.index);
    return mediaSets[0].entry;
  }

  return parsedObjects[parsedObjects.length - 1] || null;
}

function parseHmsDurationToSeconds(raw) {
  const value = String(raw || '').trim();
  if (!value) {
    return 0;
  }
  const match = value.match(/^(\d{1,2}):(\d{2}):(\d{2})(?:\.\d+)?$/);
  if (!match) {
    return 0;
  }
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes) || !Number.isFinite(seconds)) {
    return 0;
  }
  return (hours * 3600) + (minutes * 60) + seconds;
}

function parseHandBrakeDurationSeconds(rawDuration) {
  if (rawDuration && typeof rawDuration === 'object') {
    const hours = Number(rawDuration.Hours ?? rawDuration.hours ?? 0);
    const minutes = Number(rawDuration.Minutes ?? rawDuration.minutes ?? 0);
    const seconds = Number(rawDuration.Seconds ?? rawDuration.seconds ?? 0);
    if (Number.isFinite(hours) && Number.isFinite(minutes) && Number.isFinite(seconds)) {
      return Math.max(0, Math.trunc((hours * 3600) + (minutes * 60) + seconds));
    }
  }

  const parsedHms = parseHmsDurationToSeconds(rawDuration);
  if (parsedHms > 0) {
    return parsedHms;
  }

  const asNumber = Number(rawDuration);
  if (Number.isFinite(asNumber) && asNumber > 0) {
    return Math.max(0, Math.trunc(asNumber));
  }

  return 0;
}

function normalizeTrackLanguage(raw) {
  const value = String(raw || '').trim();
  if (!value) {
    return 'und';
  }
  return value.toLowerCase().slice(0, 3);
}

function pickScanTitleList(scanJson) {
  if (!scanJson || typeof scanJson !== 'object') {
    return [];
  }

  const direct = Array.isArray(scanJson.TitleList) ? scanJson.TitleList : null;
  if (direct) {
    return direct;
  }

  const scanNode = scanJson.Scan && typeof scanJson.Scan === 'object' ? scanJson.Scan : null;
  if (scanNode) {
    const scanTitles = Array.isArray(scanNode.TitleList) ? scanNode.TitleList : null;
    if (scanTitles) {
      return scanTitles;
    }
  }

  const alt = Array.isArray(scanJson.title_list) ? scanJson.title_list : null;
  return alt || [];
}

function resolvePlaylistInfoFromAnalysis(playlistAnalysis, playlistIdRaw) {
  const playlistId = normalizePlaylistId(playlistIdRaw);
  if (!playlistId || !playlistAnalysis) {
    return {
      playlistId: playlistId || null,
      playlistFile: playlistId ? `${playlistId}.mpls` : null,
      recommended: false,
      evaluationLabel: null,
      segmentCommand: playlistId ? `strings BDMV/PLAYLIST/${playlistId}.mpls | grep m2ts` : null,
      segmentFiles: []
    };
  }

  const recommended = normalizePlaylistId(playlistAnalysis?.recommendation?.playlistId) === playlistId;
  const evaluated = (Array.isArray(playlistAnalysis?.evaluatedCandidates) ? playlistAnalysis.evaluatedCandidates : [])
    .find((item) => normalizePlaylistId(item?.playlistId) === playlistId) || null;
  const segmentMap = playlistAnalysis.playlistSegments && typeof playlistAnalysis.playlistSegments === 'object'
    ? playlistAnalysis.playlistSegments
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

function normalizeScanTrackId(rawValue, fallbackIndex) {
  const parsed = Number(rawValue);
  if (Number.isFinite(parsed) && parsed > 0) {
    return Math.trunc(parsed);
  }
  return Math.max(1, Math.trunc(fallbackIndex) + 1);
}

function parseSizeToBytes(rawValue) {
  const text = String(rawValue || '').trim();
  if (!text) {
    return 0;
  }

  if (/^\d+$/.test(text)) {
    const numeric = Number(text);
    if (Number.isFinite(numeric) && numeric > 0) {
      return Math.trunc(numeric);
    }
  }

  const match = text.match(/([0-9]+(?:[.,][0-9]+)?)\s*([kmgt]?b)/i);
  if (!match) {
    return 0;
  }

  const value = Number(String(match[1]).replace(',', '.'));
  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }

  const unit = String(match[2] || 'b').toLowerCase();
  const factorMap = {
    b: 1,
    kb: 1024,
    mb: 1024 ** 2,
    gb: 1024 ** 3,
    tb: 1024 ** 4
  };
  const factor = factorMap[unit] || 1;
  return Math.max(0, Math.trunc(value * factor));
}

function parseMakeMkvDurationSeconds(rawValue) {
  const hms = parseHmsDurationToSeconds(rawValue);
  if (hms > 0) {
    return hms;
  }

  const text = String(rawValue || '').trim();
  if (!text) {
    return 0;
  }

  const hours = Number((text.match(/(\d+)\s*h/i) || [])[1] || 0);
  const minutes = Number((text.match(/(\d+)\s*m/i) || [])[1] || 0);
  const seconds = Number((text.match(/(\d+)\s*s/i) || [])[1] || 0);
  if (hours || minutes || seconds) {
    return (hours * 3600) + (minutes * 60) + seconds;
  }

  const numeric = Number(text);
  if (Number.isFinite(numeric) && numeric > 0) {
    return Math.trunc(numeric);
  }

  return 0;
}

function buildSyntheticMediaInfoFromMakeMkvTitle(titleInfo) {
  const tracks = [];
  tracks.push({
    '@type': 'General',
    Duration: String(Number(titleInfo?.durationSeconds || 0))
  });

  const audioTracks = Array.isArray(titleInfo?.audioTracks) ? titleInfo.audioTracks : [];
  const subtitleTracks = Array.isArray(titleInfo?.subtitleTracks) ? titleInfo.subtitleTracks : [];

  for (const track of audioTracks) {
    tracks.push({
      '@type': 'Audio',
      ID: String(track?.sourceTrackId ?? track?.id ?? ''),
      Language: track?.language || 'und',
      Language_String3: track?.language || 'und',
      Title: track?.title || null,
      Format: track?.format || null,
      Channels: track?.channels || null
    });
  }

  for (const track of subtitleTracks) {
    tracks.push({
      '@type': 'Text',
      ID: String(track?.sourceTrackId ?? track?.id ?? ''),
      Language: track?.language || 'und',
      Language_String3: track?.language || 'und',
      Title: track?.title || null,
      Format: track?.format || null
    });
  }

  return {
    media: {
      track: tracks
    }
  };
}

function remapReviewTrackIdsToSourceIds(review) {
  if (!review || !Array.isArray(review.titles)) {
    return review;
  }

  const normalizeSourceId = (track) => {
    const normalized = normalizeTrackIdList([track?.sourceTrackId ?? track?.id])[0] || null;
    return normalized;
  };

  const titles = review.titles.map((title) => ({
    ...title,
    audioTracks: (Array.isArray(title?.audioTracks) ? title.audioTracks : []).map((track) => {
      const sourceTrackId = normalizeSourceId(track);
      return {
        ...track,
        id: sourceTrackId || track?.id || null,
        sourceTrackId: sourceTrackId || track?.sourceTrackId || track?.id || null
      };
    }),
    subtitleTracks: (Array.isArray(title?.subtitleTracks) ? title.subtitleTracks : []).map((track) => {
      const sourceTrackId = normalizeSourceId(track);
      return {
        ...track,
        id: sourceTrackId || track?.id || null,
        sourceTrackId: sourceTrackId || track?.sourceTrackId || track?.id || null
      };
    })
  }));

  return {
    ...review,
    titles
  };
}

function resolveHandBrakeTitleIdForPlaylist(scanJson, playlistIdRaw) {
  const playlistId = normalizePlaylistId(playlistIdRaw);
  if (!playlistId) {
    return null;
  }

  const titleList = pickScanTitleList(scanJson);
  const matches = titleList
    .map((title, idx) => {
      const handBrakeTitleId = normalizeScanTrackId(
        title?.Index ?? title?.index ?? title?.Title ?? title?.title,
        idx
      );
      const playlist = normalizePlaylistId(
        title?.Playlist
        || title?.playlist
        || title?.PlaylistName
        || title?.playlistName
        || null
      );
      const durationSeconds = parseHandBrakeDurationSeconds(
        title?.Duration ?? title?.duration ?? title?.Length ?? title?.length
      );
      return {
        handBrakeTitleId,
        playlist,
        durationSeconds
      };
    })
    .filter((item) => item.playlist === playlistId);

  if (matches.length === 0) {
    return null;
  }

  const best = matches.sort((a, b) => b.durationSeconds - a.durationSeconds || a.handBrakeTitleId - b.handBrakeTitleId)[0];
  return best?.handBrakeTitleId || null;
}

function normalizeCodecNumber(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return null;
  }
  return Math.trunc(numeric);
}

function hasDtsHdMarker(track) {
  const text = `${track?.description || ''} ${track?.title || ''} ${track?.format || ''} ${track?.codecName || ''}`
    .toLowerCase();
  const codec = normalizeCodecNumber(track?.codec);
  return text.includes('dts-hd') || text.includes('dts hd') || codec === 262144;
}

function isLikelyDtsCoreTrack(track) {
  const text = `${track?.description || ''} ${track?.title || ''} ${track?.format || ''} ${track?.codecName || ''}`
    .toLowerCase();
  const codec = normalizeCodecNumber(track?.codec);
  const looksDts = text.includes('dts') || text.includes('dca');
  const looksHd = text.includes('dts-hd') || text.includes('dts hd') || codec === 262144;
  if (!looksDts || looksHd) {
    return false;
  }

  // HandBrake uses 8192 for DTS core in scan JSON.
  if (codec !== null && codec !== 8192) {
    return false;
  }
  return true;
}

function filterDtsCoreFallbackTracks(audioTracks) {
  const tracks = Array.isArray(audioTracks) ? audioTracks : [];
  if (tracks.length === 0) {
    return [];
  }

  const hdLanguages = new Set(
    tracks
      .filter((track) => hasDtsHdMarker(track))
      .map((track) => String(track?.language || 'und'))
  );

  if (hdLanguages.size === 0) {
    return tracks;
  }

  return tracks.filter((track) => {
    const language = String(track?.language || 'und');
    if (!hdLanguages.has(language)) {
      return true;
    }
    return !isLikelyDtsCoreTrack(track);
  });
}

function parseHandBrakeSelectedTitleInfo(scanJson, options = {}) {
  const titleList = pickScanTitleList(scanJson);
  if (!Array.isArray(titleList) || titleList.length === 0) {
    return null;
  }

  const preferredPlaylistId = normalizePlaylistId(options?.playlistId || null);
  const rawPreferredHandBrakeTitleId = Number(options?.handBrakeTitleId);
  const preferredHandBrakeTitleId = Number.isFinite(rawPreferredHandBrakeTitleId) && rawPreferredHandBrakeTitleId > 0
    ? Math.trunc(rawPreferredHandBrakeTitleId)
    : null;

  const parsedTitles = titleList.map((title, idx) => {
    const handBrakeTitleId = normalizeScanTrackId(
      title?.Index ?? title?.index ?? title?.Title ?? title?.title,
      idx
    );
    const playlistId = normalizePlaylistId(
      title?.Playlist
      || title?.playlist
      || title?.PlaylistName
      || title?.playlistName
      || null
    );
    const durationSeconds = parseHandBrakeDurationSeconds(
      title?.Duration ?? title?.duration ?? title?.Length ?? title?.length
    );
    const sizeBytes = Number(title?.Size?.Bytes ?? title?.Bytes ?? 0) || 0;
    const rawFileName = String(
      title?.Name
      || title?.TitleName
      || title?.File
      || title?.SourceName
      || ''
    ).trim();
    const fileName = rawFileName || `Title #${handBrakeTitleId}`;

    const audioTracksRaw = (Array.isArray(title?.AudioList) ? title.AudioList : [])
      .map((track, trackIndex) => {
        const sourceTrackId = normalizeScanTrackId(
          // Prefer source numbering from HandBrake JSON so UI/CLI IDs stay stable
          // (e.g. audio 2..10, subtitle 11..21 on some Blu-rays).
          track?.TrackNumber
          ?? track?.Track
          ?? track?.id
          ?? track?.ID
          ?? track?.Index,
          trackIndex
        );
        const languageCode = normalizeTrackLanguage(
          track?.LanguageCode
          || track?.ISO639_2
          || track?.Language
          || track?.language
          || 'und'
        );
        const languageLabel = String(
          track?.Language
          || track?.LanguageCode
          || track?.language
          || languageCode
        ).trim() || languageCode;

        return {
          id: sourceTrackId,
          sourceTrackId,
          language: languageCode,
          languageLabel,
          title: track?.Name || track?.Description || null,
          description: track?.Description || null,
          codec: track?.Codec ?? null,
          codecName: track?.CodecName || null,
          format: track?.Codec || track?.CodecName || track?.CodecParam || null,
          channels: track?.ChannelLayoutName || track?.ChannelLayout || track?.Channels || null
        };
      })
      .filter((track) => Number.isFinite(Number(track?.sourceTrackId)) && Number(track.sourceTrackId) > 0);
    const audioTracks = filterDtsCoreFallbackTracks(audioTracksRaw);

    const subtitleTracks = (Array.isArray(title?.SubtitleList) ? title.SubtitleList : [])
      .map((track, trackIndex) => {
        const sourceTrackId = normalizeScanTrackId(
          track?.TrackNumber
          ?? track?.Track
          ?? track?.id
          ?? track?.ID
          ?? track?.Index,
          trackIndex
        );
        const languageCode = normalizeTrackLanguage(
          track?.LanguageCode
          || track?.ISO639_2
          || track?.Language
          || track?.language
          || 'und'
        );
        const languageLabel = String(
          track?.Language
          || track?.LanguageCode
          || track?.language
          || languageCode
        ).trim() || languageCode;

        return {
          id: sourceTrackId,
          sourceTrackId,
          language: languageCode,
          languageLabel,
          title: track?.Name || track?.Description || null,
          format: track?.SourceName || track?.Format || track?.Codec || null,
          channels: null
        };
      })
      .filter((track) => Number.isFinite(Number(track?.sourceTrackId)) && Number(track.sourceTrackId) > 0);

    return {
      handBrakeTitleId,
      playlistId,
      durationSeconds,
      sizeBytes,
      fileName,
      audioTracks,
      subtitleTracks
    };
  });

  let selected = null;
  if (preferredHandBrakeTitleId) {
    selected = parsedTitles.find((title) => title.handBrakeTitleId === preferredHandBrakeTitleId) || null;
  }
  if (!selected && preferredPlaylistId) {
    const playlistMatches = parsedTitles
      .filter((title) => normalizePlaylistId(title?.playlistId) === preferredPlaylistId)
      .sort((a, b) => b.durationSeconds - a.durationSeconds || b.sizeBytes - a.sizeBytes || a.handBrakeTitleId - b.handBrakeTitleId);
    selected = playlistMatches[0] || null;
  }
  if (!selected) {
    selected = parsedTitles
      .slice()
      .sort((a, b) => b.durationSeconds - a.durationSeconds || b.sizeBytes - a.sizeBytes || a.handBrakeTitleId - b.handBrakeTitleId)[0] || null;
  }
  if (!selected) {
    return null;
  }

  return {
    source: 'handbrake_scan',
    titleId: selected.handBrakeTitleId,
    handBrakeTitleId: selected.handBrakeTitleId,
    fileName: selected.fileName,
    durationSeconds: selected.durationSeconds,
    sizeBytes: selected.sizeBytes,
    playlistId: selected.playlistId || preferredPlaylistId || null,
    audioTracks: selected.audioTracks,
    subtitleTracks: selected.subtitleTracks
  };
}

function pickTitleIdForTrackReview(playlistAnalysis, selectedTitleId = null) {
  const explicit = Number(selectedTitleId);
  if (Number.isFinite(explicit) && explicit >= 0) {
    return Math.trunc(explicit);
  }

  const recommendationTitleId = Number(playlistAnalysis?.recommendation?.titleId);
  if (Number.isFinite(recommendationTitleId) && recommendationTitleId >= 0) {
    return Math.trunc(recommendationTitleId);
  }

  const candidates = Array.isArray(playlistAnalysis?.candidates) ? playlistAnalysis.candidates : [];
  if (candidates.length > 0) {
    const sortedCandidates = [...candidates].sort((a, b) =>
      Number(b?.durationSeconds || 0) - Number(a?.durationSeconds || 0)
      || Number(b?.sizeBytes || 0) - Number(a?.sizeBytes || 0)
      || Number(a?.titleId || 0) - Number(b?.titleId || 0)
    );
    const candidateTitleId = Number(sortedCandidates[0]?.titleId);
    if (Number.isFinite(candidateTitleId) && candidateTitleId >= 0) {
      return Math.trunc(candidateTitleId);
    }
  }

  const titles = Array.isArray(playlistAnalysis?.titles) ? playlistAnalysis.titles : [];
  if (titles.length > 0) {
    const sortedTitles = [...titles].sort((a, b) =>
      Number(b?.durationSeconds || 0) - Number(a?.durationSeconds || 0)
      || Number(b?.sizeBytes || 0) - Number(a?.sizeBytes || 0)
      || Number(a?.titleId || 0) - Number(b?.titleId || 0)
    );
    const titleId = Number(sortedTitles[0]?.titleId);
    if (Number.isFinite(titleId) && titleId >= 0) {
      return Math.trunc(titleId);
    }
  }

  return null;
}

function buildDiscScanReview({
  scanJson,
  settings,
  playlistAnalysis = null,
  selectedPlaylistId = null,
  selectedMakemkvTitleId = null,
  sourceArg = null,
  mode = 'pre_rip',
  preRip = true,
  encodeInputPath = null
}) {
  const minLengthMinutes = Number(settings?.makemkv_min_length_minutes || 0);
  const minLengthSeconds = Math.max(0, Math.round(minLengthMinutes * 60));
  const selectedPlaylist = normalizePlaylistId(selectedPlaylistId);
  const selectedMakemkvId = Number(selectedMakemkvTitleId);

  const titleList = pickScanTitleList(scanJson);
  const parsedTitles = titleList.map((title, idx) => {
    const reviewTitleId = normalizeScanTrackId(
      title?.Index ?? title?.index ?? title?.Title ?? title?.title,
      idx
    );
    const durationSeconds = parseHandBrakeDurationSeconds(
      title?.Duration ?? title?.duration ?? title?.Length ?? title?.length
    );
    const durationMinutes = Number((durationSeconds / 60).toFixed(2));
    const rawPlaylist = title?.Playlist
      || title?.playlist
      || title?.PlaylistName
      || title?.playlistName
      || null;
    const playlistInfo = resolvePlaylistInfoFromAnalysis(playlistAnalysis, rawPlaylist);
    const mappedMakemkvTitle = Array.isArray(playlistAnalysis?.titles)
      ? (playlistAnalysis.titles.find((item) =>
        normalizePlaylistId(item?.playlistId) === normalizePlaylistId(playlistInfo.playlistId)
      ) || null)
      : null;
    const makemkvTitleId = Number.isFinite(Number(mappedMakemkvTitle?.titleId))
      ? Math.trunc(Number(mappedMakemkvTitle.titleId))
      : null;

    const audioList = Array.isArray(title?.AudioList) ? title.AudioList : [];
    const subtitleList = Array.isArray(title?.SubtitleList) ? title.SubtitleList : [];

    const audioTracksRaw = audioList.map((item, trackIndex) => {
      const trackId = normalizeScanTrackId(item?.TrackNumber ?? item?.Track ?? item?.id, trackIndex);
      const languageLabel = String(item?.Language || item?.LanguageCode || item?.language || 'und');
      const format = item?.Codec || item?.CodecName || item?.CodecParam || item?.Name || null;
      return {
        id: trackId,
        sourceTrackId: trackId,
        language: normalizeTrackLanguage(item?.LanguageCode || item?.ISO639_2 || languageLabel),
        languageLabel,
        title: item?.Name || item?.Description || null,
        description: item?.Description || null,
        codec: item?.Codec ?? null,
        codecName: item?.CodecName || null,
        format,
        channels: item?.ChannelLayoutName || item?.ChannelLayout || item?.Channels || null,
        selectedByRule: true,
        encodePreviewActions: [],
        encodePreviewSummary: 'Übernehmen'
      };
    });
    const audioTracks = filterDtsCoreFallbackTracks(audioTracksRaw);

    const subtitleTracks = subtitleList.map((item, trackIndex) => {
      const trackId = normalizeScanTrackId(item?.TrackNumber ?? item?.Track ?? item?.id, trackIndex);
      const languageLabel = String(item?.Language || item?.LanguageCode || item?.language || 'und');
      return {
        id: trackId,
        sourceTrackId: trackId,
        language: normalizeTrackLanguage(item?.LanguageCode || item?.ISO639_2 || languageLabel),
        languageLabel,
        title: item?.Name || item?.Description || null,
        format: item?.SourceName || item?.Format || null,
        selectedByRule: true,
        subtitlePreviewSummary: 'Übernehmen',
        subtitlePreviewFlags: [],
        subtitlePreviewBurnIn: false,
        subtitlePreviewForced: false,
        subtitlePreviewForcedOnly: false,
        subtitlePreviewDefaultTrack: false
      };
    });

    return {
      id: reviewTitleId,
      filePath: encodeInputPath || `disc-track-scan://title-${reviewTitleId}`,
      fileName: `Disc Title ${reviewTitleId}`,
      makemkvTitleId,
      sizeBytes: Number(title?.Size?.Bytes ?? title?.Bytes ?? 0) || 0,
      durationSeconds,
      durationMinutes,
      selectedByMinLength: durationSeconds >= minLengthSeconds,
      playlistMatch: playlistInfo,
      audioTracks,
      subtitleTracks
    };
  });

  const encodeCandidates = parsedTitles.filter((item) => item.selectedByMinLength);
  const selectedPlaylistCandidate = selectedPlaylist
    ? encodeCandidates.filter((item) => normalizePlaylistId(item?.playlistMatch?.playlistId) === selectedPlaylist)
    : [];
  const selectedMakemkvCandidate = Number.isFinite(selectedMakemkvId) && selectedMakemkvId >= 0
    ? encodeCandidates.find((item) => Number(item?.makemkvTitleId) === Math.trunc(selectedMakemkvId)) || null
    : null;
  const preferredByIndex = Number.isFinite(selectedMakemkvId) && selectedMakemkvId >= 0
    ? encodeCandidates.find((item) => Number(item?.id) === Math.trunc(selectedMakemkvId)) || null
    : null;

  let encodeInputTitle = null;
  if (selectedPlaylistCandidate.length > 0) {
    encodeInputTitle = selectedPlaylistCandidate.reduce((best, current) => (
      !best || current.durationSeconds > best.durationSeconds ? current : best
    ), null);
  } else if (selectedMakemkvCandidate) {
    encodeInputTitle = selectedMakemkvCandidate;
  } else if (preferredByIndex) {
    encodeInputTitle = preferredByIndex;
  } else {
    encodeInputTitle = encodeCandidates.reduce((best, current) => (
      !best || current.durationSeconds > best.durationSeconds ? current : best
    ), null);
  }

  const playlistDecisionRequired = Boolean(playlistAnalysis?.manualDecisionRequired && !selectedPlaylist);
  const normalizedTitles = parsedTitles.map((title) => {
    const isEncodeInput = Boolean(encodeInputTitle && Number(encodeInputTitle.id) === Number(title.id));
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
      audioTracks: title.audioTracks.map((track) => {
        const selectedForEncode = isEncodeInput && Boolean(track.selectedByRule);
        return {
          ...track,
          selectedForEncode,
          encodeActions: [],
          encodeActionSummary: selectedForEncode ? 'Übernehmen' : 'Nicht übernommen'
        };
      }),
      subtitleTracks: title.subtitleTracks.map((track) => {
        const selectedForEncode = isEncodeInput && Boolean(track.selectedByRule);
        return {
          ...track,
          selectedForEncode,
          burnIn: false,
          forced: false,
          forcedOnly: false,
          defaultTrack: false,
          flags: [],
          subtitleActionSummary: selectedForEncode ? 'Übernehmen' : 'Nicht übernommen'
        };
      })
    };
  });

  const selectedTitleIds = normalizedTitles.filter((item) => item.selectedByMinLength).map((item) => item.id);
  const recommendedPlaylistId = normalizePlaylistId(playlistAnalysis?.recommendation?.playlistId || null);
  const recommendedReviewTitle = normalizedTitles.find((item) => item.playlistId === recommendedPlaylistId) || null;

  return {
    generatedAt: nowIso(),
    mode,
    preRip: Boolean(preRip),
    reviewConfirmed: false,
    minLengthMinutes,
    minLengthSeconds,
    selectedTitleIds,
    selectors: {
      preset: settings?.handbrake_preset || '-',
      extraArgs: settings?.handbrake_extra_args || '',
      presetProfileSource: 'disc-scan',
      audio: {
        mode: 'manual',
        encoders: [],
        copyMask: [],
        fallbackEncoder: '-'
      },
      subtitle: {
        mode: 'manual',
        forcedOnly: false,
        burnBehavior: 'none'
      }
    },
    notes: [
      preRip
        ? `Vorab-Spurprüfung von Disc-Quelle ${sourceArg || '-'}.`
        : `Titel-/Spurprüfung aus RAW-Quelle ${sourceArg || '-'}.`,
      preRip
        ? 'Backup/Rip startet erst nach manueller Bestätigung und CTA.'
        : 'Encode startet erst nach manueller Bestätigung und CTA.'
    ],
    titles: normalizedTitles,
    encodeInputPath: encodeInputTitle ? (encodeInputPath || `disc-track-scan://title-${encodeInputTitle.id}`) : null,
    encodeInputTitleId: encodeInputTitle ? encodeInputTitle.id : null,
    playlistDecisionRequired,
    playlistRecommendation: recommendedPlaylistId
      ? {
        playlistId: recommendedPlaylistId,
        playlistFile: `${recommendedPlaylistId}.mpls`,
        reviewTitleId: recommendedReviewTitle?.id || null,
        reason: playlistAnalysis?.recommendation?.reason || null
      }
      : null,
    titleSelectionRequired: Boolean(playlistDecisionRequired && !encodeInputTitle)
  };
}

function findExistingRawDirectory(rawBaseDir, metadataBase) {
  if (!rawBaseDir || !metadataBase) {
    return null;
  }

  if (!fs.existsSync(rawBaseDir)) {
    return null;
  }

  let entries;
  try {
    entries = fs.readdirSync(rawBaseDir, { withFileTypes: true });
  } catch (_error) {
    return null;
  }

  const prefix = sanitizeFileName(`${metadataBase} - RAW - job-`);
  const candidates = entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(prefix))
    .map((entry) => {
      const absPath = path.join(rawBaseDir, entry.name);
      try {
        const dirEntries = fs.readdirSync(absPath);
        const stat = fs.statSync(absPath);
        return {
          path: absPath,
          entryCount: dirEntries.length,
          mtimeMs: Number(stat.mtimeMs || 0)
        };
      } catch (_error) {
        return null;
      }
    })
    .filter((item) => item && item.entryCount > 0)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  return candidates.length > 0 ? candidates[0].path : null;
}

function toPlaylistFile(playlistId) {
  const normalized = normalizePlaylistId(playlistId);
  return normalized ? `${normalized}.mpls` : null;
}

function buildPlaylistCandidates(playlistAnalysis) {
  const rawList = Array.isArray(playlistAnalysis?.candidatePlaylists)
    ? playlistAnalysis.candidatePlaylists
    : [];
  const sourceRows = [
    ...(Array.isArray(playlistAnalysis?.evaluatedCandidates) ? playlistAnalysis.evaluatedCandidates : []),
    ...(Array.isArray(playlistAnalysis?.candidates) ? playlistAnalysis.candidates : []),
    ...(Array.isArray(playlistAnalysis?.titles) ? playlistAnalysis.titles : [])
  ];
  const segmentMap = playlistAnalysis?.playlistSegments && typeof playlistAnalysis.playlistSegments === 'object'
    ? playlistAnalysis.playlistSegments
    : {};

  return rawList
    .map((playlistId) => normalizePlaylistId(playlistId))
    .filter(Boolean)
    .map((playlistId) => {
      const source = sourceRows.find((item) => normalizePlaylistId(item?.playlistId || item?.playlistFile) === playlistId) || null;
      const segmentEntry = segmentMap[playlistId] || segmentMap[`${playlistId}.mpls`] || null;
      const score = Number(source?.score);
      const sequenceCoherence = Number(source?.structuralMetrics?.sequenceCoherence);
      const titleId = Number(source?.titleId ?? source?.id);
      const handBrakeTitleId = Number(source?.handBrakeTitleId);

      return {
        playlistId,
        playlistFile: toPlaylistFile(playlistId),
        titleId: Number.isFinite(titleId) ? Math.trunc(titleId) : null,
        score: Number.isFinite(score) ? score : null,
        recommended: Boolean(source?.recommended),
        evaluationLabel: source?.evaluationLabel || null,
        sequenceCoherence: Number.isFinite(sequenceCoherence) ? sequenceCoherence : null,
        segmentCommand: source?.segmentCommand
          || segmentEntry?.segmentCommand
          || `strings BDMV/PLAYLIST/${playlistId}.mpls | grep m2ts`,
        segmentFiles: Array.isArray(source?.segmentFiles) && source.segmentFiles.length > 0
          ? source.segmentFiles
          : (Array.isArray(segmentEntry?.segmentFiles) ? segmentEntry.segmentFiles : []),
        handBrakeTitleId: Number.isFinite(handBrakeTitleId) && handBrakeTitleId > 0
          ? Math.trunc(handBrakeTitleId)
          : null,
        audioSummary: source?.audioSummary || null,
        audioTrackPreview: Array.isArray(source?.audioTrackPreview) ? source.audioTrackPreview : []
      };
    });
}

function buildHandBrakeAudioTrackPreview(titleInfo) {
  const tracks = Array.isArray(titleInfo?.audioTracks) ? titleInfo.audioTracks : [];
  return tracks
    .map((track) => {
      const rawTrackId = Number(track?.sourceTrackId ?? track?.id);
      const trackId = Number.isFinite(rawTrackId) && rawTrackId > 0 ? Math.trunc(rawTrackId) : null;
      const language = normalizeTrackLanguage(track?.language || track?.languageLabel || 'und');
      const description = String(track?.description || track?.title || '').trim();
      const codec = String(track?.codecName || track?.format || '').trim();
      const channels = String(track?.channels || '').trim();

      const parts = [];
      if (trackId !== null) {
        parts.push(`#${trackId}`);
      }
      parts.push(language);
      if (description) {
        parts.push(description);
      } else {
        if (codec) {
          parts.push(codec);
        }
        if (channels) {
          parts.push(channels);
        }
      }
      return parts.join(' | ').trim();
    })
    .filter((line) => line.length > 0);
}

function buildHandBrakeAudioSummary(previewLines) {
  const lines = Array.isArray(previewLines)
    ? previewLines.filter((line) => String(line || '').trim().length > 0)
    : [];
  if (lines.length === 0) {
    return null;
  }
  return lines.slice(0, 3).join(' || ');
}

function normalizeHandBrakePlaylistScanCache(rawCache) {
  if (!rawCache || typeof rawCache !== 'object') {
    return null;
  }

  const inputPath = String(rawCache?.inputPath || '').trim() || null;
  const source = String(rawCache?.source || '').trim() || 'HANDBRAKE_SCAN_PLAYLIST_MAP';
  const generatedAt = String(rawCache?.generatedAt || '').trim() || null;

  const rawEntries = [];
  if (rawCache?.byPlaylist && typeof rawCache.byPlaylist === 'object') {
    for (const [key, value] of Object.entries(rawCache.byPlaylist)) {
      rawEntries.push({ key, value });
    }
  } else if (Array.isArray(rawCache?.playlists)) {
    for (const item of rawCache.playlists) {
      rawEntries.push({ key: item?.playlistId || item?.playlistFile || null, value: item });
    }
  }

  const byPlaylist = {};
  for (const entry of rawEntries) {
    const row = entry?.value && typeof entry.value === 'object' ? entry.value : null;
    const playlistId = normalizePlaylistId(row?.playlistId || row?.playlistFile || entry?.key || null);
    if (!playlistId) {
      continue;
    }
    const rawHandBrakeTitleId = Number(row?.handBrakeTitleId ?? row?.titleId);
    const handBrakeTitleId = Number.isFinite(rawHandBrakeTitleId) && rawHandBrakeTitleId > 0
      ? Math.trunc(rawHandBrakeTitleId)
      : null;
    const titleInfo = row?.titleInfo && typeof row.titleInfo === 'object' ? row.titleInfo : null;
    const audioTrackPreview = Array.isArray(row?.audioTrackPreview)
      ? row.audioTrackPreview.map((line) => String(line || '').trim()).filter((line) => line.length > 0)
      : buildHandBrakeAudioTrackPreview(titleInfo);
    const audioSummary = String(row?.audioSummary || '').trim() || buildHandBrakeAudioSummary(audioTrackPreview);

    byPlaylist[playlistId] = {
      playlistId,
      handBrakeTitleId,
      titleInfo,
      audioTrackPreview,
      audioSummary: audioSummary || null
    };
  }

  if (Object.keys(byPlaylist).length === 0) {
    return null;
  }

  return {
    generatedAt,
    source,
    inputPath,
    byPlaylist
  };
}

function getCachedHandBrakePlaylistEntry(scanCache, playlistIdRaw) {
  const playlistId = normalizePlaylistId(playlistIdRaw);
  if (!playlistId) {
    return null;
  }
  const normalized = normalizeHandBrakePlaylistScanCache(scanCache);
  if (!normalized) {
    return null;
  }
  return normalized.byPlaylist[playlistId] || null;
}

function hasCachedHandBrakeDataForPlaylistCandidates(scanCache, playlistCandidates = []) {
  const normalized = normalizeHandBrakePlaylistScanCache(scanCache);
  if (!normalized) {
    return false;
  }

  const candidateIds = (Array.isArray(playlistCandidates) ? playlistCandidates : [])
    .map((item) => normalizePlaylistId(item?.playlistId || item?.playlistFile || item))
    .filter(Boolean);
  if (candidateIds.length === 0) {
    return false;
  }

  return candidateIds.every((playlistId) => {
    const row = normalized.byPlaylist[playlistId];
    return Boolean(row && row.handBrakeTitleId && row.titleInfo);
  });
}

function buildHandBrakePlaylistScanCache(scanJson, playlistCandidates = [], rawPath = null) {
  const candidateIds = Array.from(new Set(
    (Array.isArray(playlistCandidates) ? playlistCandidates : [])
      .map((item) => normalizePlaylistId(item?.playlistId || item?.playlistFile || item))
      .filter(Boolean)
  ));

  const byPlaylist = {};
  for (const playlistId of candidateIds) {
    const handBrakeTitleId = resolveHandBrakeTitleIdForPlaylist(scanJson, playlistId);
    if (!handBrakeTitleId) {
      continue;
    }
    const titleInfo = parseHandBrakeSelectedTitleInfo(scanJson, {
      playlistId,
      handBrakeTitleId
    });
    if (!titleInfo) {
      continue;
    }
    const audioTrackPreview = buildHandBrakeAudioTrackPreview(titleInfo);
    byPlaylist[playlistId] = {
      playlistId,
      handBrakeTitleId,
      titleInfo,
      audioTrackPreview,
      audioSummary: buildHandBrakeAudioSummary(audioTrackPreview)
    };
  }

  return normalizeHandBrakePlaylistScanCache({
    generatedAt: nowIso(),
    source: 'HANDBRAKE_SCAN_PLAYLIST_MAP',
    inputPath: rawPath || null,
    byPlaylist
  });
}

function enrichPlaylistAnalysisWithHandBrakeCache(playlistAnalysis, scanCache) {
  const analysis = playlistAnalysis && typeof playlistAnalysis === 'object' ? playlistAnalysis : null;
  const normalizedCache = normalizeHandBrakePlaylistScanCache(scanCache);
  if (!analysis || !normalizedCache) {
    return analysis;
  }

  const enrichRow = (row) => {
    const playlistId = normalizePlaylistId(row?.playlistId || row?.playlistFile || null);
    if (!playlistId) {
      return row;
    }
    const cached = normalizedCache.byPlaylist[playlistId];
    if (!cached) {
      return row;
    }
    return {
      ...row,
      handBrakeTitleId: cached.handBrakeTitleId || null,
      audioSummary: cached.audioSummary || null,
      audioTrackPreview: Array.isArray(cached.audioTrackPreview) ? cached.audioTrackPreview : []
    };
  };

  const recommendationPlaylistId = normalizePlaylistId(analysis?.recommendation?.playlistId);
  const recommendationCached = recommendationPlaylistId
    ? normalizedCache.byPlaylist[recommendationPlaylistId] || null
    : null;

  return {
    ...analysis,
    evaluatedCandidates: Array.isArray(analysis?.evaluatedCandidates)
      ? analysis.evaluatedCandidates.map((row) => enrichRow(row))
      : [],
    candidates: Array.isArray(analysis?.candidates)
      ? analysis.candidates.map((row) => enrichRow(row))
      : [],
    titles: Array.isArray(analysis?.titles)
      ? analysis.titles.map((row) => enrichRow(row))
      : [],
    recommendation: analysis?.recommendation && typeof analysis.recommendation === 'object'
      ? {
        ...analysis.recommendation,
        handBrakeTitleId: recommendationCached?.handBrakeTitleId || null,
        audioSummary: recommendationCached?.audioSummary || null,
        audioTrackPreview: Array.isArray(recommendationCached?.audioTrackPreview)
          ? recommendationCached.audioTrackPreview
          : []
      }
      : analysis?.recommendation || null
  };
}

function pickTitleIdForPlaylist(playlistAnalysis, playlistId) {
  const normalized = normalizePlaylistId(playlistId);
  if (!normalized || !playlistAnalysis) {
    return null;
  }

  const playlistMap = playlistAnalysis?.playlistToTitleId
    && typeof playlistAnalysis.playlistToTitleId === 'object'
    ? playlistAnalysis.playlistToTitleId
    : null;
  if (playlistMap) {
    const byFile = Number(playlistMap[`${normalized}.mpls`]);
    if (Number.isFinite(byFile) && byFile >= 0) {
      return Math.trunc(byFile);
    }
    const byId = Number(playlistMap[normalized]);
    if (Number.isFinite(byId) && byId >= 0) {
      return Math.trunc(byId);
    }
  }

  const sources = [
    ...(Array.isArray(playlistAnalysis?.evaluatedCandidates) ? playlistAnalysis.evaluatedCandidates : []),
    ...(Array.isArray(playlistAnalysis?.candidates) ? playlistAnalysis.candidates : []),
    ...(Array.isArray(playlistAnalysis?.titles) ? playlistAnalysis.titles : [])
  ];

  const matches = sources
    .filter((item) => normalizePlaylistId(item?.playlistId) === normalized)
    .map((item) => ({
      titleId: Number(item?.titleId ?? item?.id),
      durationSeconds: Number(item?.durationSeconds || 0),
      sizeBytes: Number(item?.sizeBytes || 0)
    }))
    .filter((item) => Number.isFinite(item.titleId) && item.titleId >= 0)
    .sort((a, b) => b.durationSeconds - a.durationSeconds || b.sizeBytes - a.sizeBytes || a.titleId - b.titleId);

  return matches.length > 0 ? matches[0].titleId : null;
}

function normalizeReviewTitleId(rawValue) {
  const value = Number(rawValue);
  if (!Number.isFinite(value) || value <= 0) {
    return null;
  }
  return Math.trunc(value);
}

function applyEncodeTitleSelectionToPlan(encodePlan, selectedEncodeTitleId) {
  const normalizedTitleId = normalizeReviewTitleId(selectedEncodeTitleId);
  if (!normalizedTitleId) {
    return {
      plan: encodePlan,
      selectedTitle: null
    };
  }

  const titles = Array.isArray(encodePlan?.titles) ? encodePlan.titles : [];
  const selectedTitle = titles.find((item) => Number(item?.id) === normalizedTitleId) || null;
  if (!selectedTitle) {
    const error = new Error(`Gewählter Titel #${normalizedTitleId} ist nicht vorhanden.`);
    error.statusCode = 400;
    throw error;
  }

  const eligible = selectedTitle?.eligibleForEncode !== undefined
    ? Boolean(selectedTitle.eligibleForEncode)
    : Boolean(selectedTitle?.selectedByMinLength);
  if (!eligible) {
    const error = new Error(`Titel #${normalizedTitleId} ist laut MIN_LENGTH_MINUTES nicht encodierbar.`);
    error.statusCode = 400;
    throw error;
  }

  const remappedTitles = titles.map((title) => {
    const isEncodeInput = Number(title?.id) === normalizedTitleId;

    const audioTracks = (Array.isArray(title?.audioTracks) ? title.audioTracks : []).map((track) => {
      const selectedByRule = Boolean(track?.selectedByRule);
      const selectedForEncode = isEncodeInput && selectedByRule;
      const previewActions = Array.isArray(track?.encodePreviewActions) ? track.encodePreviewActions : [];
      const previewSummary = track?.encodePreviewSummary || 'Nicht übernommen';

      return {
        ...track,
        selectedForEncode,
        encodeActions: selectedForEncode ? previewActions : [],
        encodeActionSummary: selectedForEncode ? previewSummary : 'Nicht übernommen'
      };
    });

    const subtitleTracks = (Array.isArray(title?.subtitleTracks) ? title.subtitleTracks : []).map((track) => {
      const selectedByRule = Boolean(track?.selectedByRule);
      const selectedForEncode = isEncodeInput && selectedByRule;
      const previewFlags = Array.isArray(track?.subtitlePreviewFlags) ? track.subtitlePreviewFlags : [];
      const previewSummary = track?.subtitlePreviewSummary || 'Nicht übernommen';

      return {
        ...track,
        selectedForEncode,
        burnIn: selectedForEncode ? Boolean(track?.subtitlePreviewBurnIn) : false,
        forced: selectedForEncode ? Boolean(track?.subtitlePreviewForced) : false,
        forcedOnly: selectedForEncode ? Boolean(track?.subtitlePreviewForcedOnly) : false,
        defaultTrack: selectedForEncode ? Boolean(track?.subtitlePreviewDefaultTrack) : false,
        flags: selectedForEncode ? previewFlags : [],
        subtitleActionSummary: selectedForEncode ? previewSummary : 'Nicht übernommen'
      };
    });

    return {
      ...title,
      encodeInput: isEncodeInput,
      selectedForEncode: isEncodeInput,
      audioTracks,
      subtitleTracks
    };
  });

  return {
    plan: {
      ...encodePlan,
      titles: remappedTitles,
      encodeInputTitleId: normalizedTitleId,
      encodeInputPath: selectedTitle?.filePath || null,
      titleSelectionRequired: false
    },
    selectedTitle
  };
}

function normalizeTrackIdList(rawList) {
  const list = Array.isArray(rawList) ? rawList : [];
  const seen = new Set();
  const output = [];
  for (const item of list) {
    const value = Number(item);
    if (!Number.isFinite(value) || value <= 0) {
      continue;
    }
    const normalized = Math.trunc(value);
    const key = String(normalized);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    output.push(normalized);
  }
  return output;
}

function applyManualTrackSelectionToPlan(encodePlan, selectedTrackSelection) {
  const plan = encodePlan && typeof encodePlan === 'object' ? encodePlan : null;
  if (!plan || !Array.isArray(plan.titles)) {
    return {
      plan: encodePlan,
      selectionApplied: false,
      audioTrackIds: [],
      subtitleTrackIds: []
    };
  }

  const encodeInputTitleId = normalizeReviewTitleId(plan.encodeInputTitleId);
  if (!encodeInputTitleId) {
    return {
      plan,
      selectionApplied: false,
      audioTrackIds: [],
      subtitleTrackIds: []
    };
  }

  const selectionPayload = selectedTrackSelection && typeof selectedTrackSelection === 'object'
    ? selectedTrackSelection
    : null;
  if (!selectionPayload) {
    return {
      plan,
      selectionApplied: false,
      audioTrackIds: [],
      subtitleTrackIds: []
    };
  }

  const rawSelection = selectionPayload[encodeInputTitleId]
    || selectionPayload[String(encodeInputTitleId)]
    || selectionPayload;
  if (!rawSelection || typeof rawSelection !== 'object') {
    return {
      plan,
      selectionApplied: false,
      audioTrackIds: [],
      subtitleTrackIds: []
    };
  }

  const encodeTitle = plan.titles.find((title) => Number(title?.id) === encodeInputTitleId) || null;
  if (!encodeTitle) {
    return {
      plan,
      selectionApplied: false,
      audioTrackIds: [],
      subtitleTrackIds: []
    };
  }

  const validAudioTrackIds = new Set(
    (Array.isArray(encodeTitle.audioTracks) ? encodeTitle.audioTracks : [])
      .map((track) => Number(track?.id))
      .filter((id) => Number.isFinite(id))
      .map((id) => Math.trunc(id))
  );
  const validSubtitleTrackIds = new Set(
    (Array.isArray(encodeTitle.subtitleTracks) ? encodeTitle.subtitleTracks : [])
      .map((track) => Number(track?.id))
      .filter((id) => Number.isFinite(id))
      .map((id) => Math.trunc(id))
  );

  const requestedAudioTrackIds = normalizeTrackIdList(rawSelection.audioTrackIds)
    .filter((id) => validAudioTrackIds.has(id));
  const requestedSubtitleTrackIds = normalizeTrackIdList(rawSelection.subtitleTrackIds)
    .filter((id) => validSubtitleTrackIds.has(id));

  const audioSelectionSet = new Set(requestedAudioTrackIds.map((id) => String(id)));
  const subtitleSelectionSet = new Set(requestedSubtitleTrackIds.map((id) => String(id)));

  const remappedTitles = plan.titles.map((title) => {
    const isEncodeInput = Number(title?.id) === encodeInputTitleId;

    const audioTracks = (Array.isArray(title?.audioTracks) ? title.audioTracks : []).map((track) => {
      const trackId = Number(track?.id);
      const selectedForEncode = isEncodeInput && audioSelectionSet.has(String(Math.trunc(trackId)));
      const previewActions = Array.isArray(track?.encodePreviewActions) ? track.encodePreviewActions : [];
      const previewSummary = track?.encodePreviewSummary || 'Nicht übernommen';
      return {
        ...track,
        selectedForEncode,
        encodeActions: selectedForEncode ? previewActions : [],
        encodeActionSummary: selectedForEncode ? previewSummary : 'Nicht übernommen'
      };
    });

    const subtitleTracks = (Array.isArray(title?.subtitleTracks) ? title.subtitleTracks : []).map((track) => {
      const trackId = Number(track?.id);
      const selectedForEncode = isEncodeInput && subtitleSelectionSet.has(String(Math.trunc(trackId)));
      const previewFlags = Array.isArray(track?.subtitlePreviewFlags) ? track.subtitlePreviewFlags : [];
      const previewSummary = track?.subtitlePreviewSummary || 'Nicht übernommen';
      return {
        ...track,
        selectedForEncode,
        burnIn: selectedForEncode ? Boolean(track?.subtitlePreviewBurnIn) : false,
        forced: selectedForEncode ? Boolean(track?.subtitlePreviewForced) : false,
        forcedOnly: selectedForEncode ? Boolean(track?.subtitlePreviewForcedOnly) : false,
        defaultTrack: selectedForEncode ? Boolean(track?.subtitlePreviewDefaultTrack) : false,
        flags: selectedForEncode ? previewFlags : [],
        subtitleActionSummary: selectedForEncode ? previewSummary : 'Nicht übernommen'
      };
    });

    return {
      ...title,
      encodeInput: isEncodeInput,
      selectedForEncode: isEncodeInput,
      audioTracks,
      subtitleTracks
    };
  });

  return {
    plan: {
      ...plan,
      titles: remappedTitles,
      manualTrackSelection: {
        titleId: encodeInputTitleId,
        audioTrackIds: requestedAudioTrackIds,
        subtitleTrackIds: requestedSubtitleTrackIds,
        updatedAt: nowIso()
      }
    },
    selectionApplied: true,
    audioTrackIds: requestedAudioTrackIds,
    subtitleTrackIds: requestedSubtitleTrackIds
  };
}

function extractHandBrakeTrackSelectionFromPlan(encodePlan, inputPath = null) {
  const plan = encodePlan && typeof encodePlan === 'object' ? encodePlan : null;
  if (!plan || !Array.isArray(plan.titles)) {
    return null;
  }

  const encodeInputTitleId = normalizeReviewTitleId(plan.encodeInputTitleId);
  let encodeTitle = null;

  if (encodeInputTitleId) {
    encodeTitle = plan.titles.find((title) => Number(title?.id) === encodeInputTitleId) || null;
  }
  if (!encodeTitle && inputPath) {
    encodeTitle = plan.titles.find((title) => String(title?.filePath || '') === String(inputPath || '')) || null;
  }

  if (!encodeTitle) {
    return null;
  }

  const audioTrackIds = normalizeTrackIdList(
    (Array.isArray(encodeTitle.audioTracks) ? encodeTitle.audioTracks : [])
      .filter((track) => Boolean(track?.selectedForEncode))
      .map((track) => track?.sourceTrackId ?? track?.id)
  );
  const subtitleTrackIds = normalizeTrackIdList(
    (Array.isArray(encodeTitle.subtitleTracks) ? encodeTitle.subtitleTracks : [])
      .filter((track) => Boolean(track?.selectedForEncode))
      .map((track) => track?.sourceTrackId ?? track?.id)
  );
  const selectedSubtitleTracks = (Array.isArray(encodeTitle.subtitleTracks) ? encodeTitle.subtitleTracks : [])
    .filter((track) => Boolean(track?.selectedForEncode));
  const subtitleBurnTrackId = normalizeTrackIdList(
    selectedSubtitleTracks.filter((track) => Boolean(track?.burnIn)).map((track) => track?.sourceTrackId ?? track?.id)
  )[0] || null;
  const subtitleDefaultTrackId = normalizeTrackIdList(
    selectedSubtitleTracks.filter((track) => Boolean(track?.defaultTrack)).map((track) => track?.sourceTrackId ?? track?.id)
  )[0] || null;
  const subtitleForcedTrackId = normalizeTrackIdList(
    selectedSubtitleTracks.filter((track) => Boolean(track?.forced)).map((track) => track?.sourceTrackId ?? track?.id)
  )[0] || null;
  const subtitleForcedOnly = selectedSubtitleTracks.some((track) => Boolean(track?.forcedOnly));

  return {
    titleId: Number(encodeTitle?.id) || null,
    audioTrackIds,
    subtitleTrackIds,
    subtitleBurnTrackId,
    subtitleDefaultTrackId,
    subtitleForcedTrackId,
    subtitleForcedOnly
  };
}

function buildPlaylistSegmentFileSet(playlistAnalysis, selectedPlaylistId = null) {
  const analysis = playlistAnalysis && typeof playlistAnalysis === 'object' ? playlistAnalysis : null;
  if (!analysis) {
    return new Set();
  }

  const segmentMap = analysis.playlistSegments && typeof analysis.playlistSegments === 'object'
    ? analysis.playlistSegments
    : {};

  const set = new Set();
  const appendSegments = (playlistIdRaw) => {
    const playlistId = normalizePlaylistId(playlistIdRaw);
    if (!playlistId) {
      return;
    }
    const segmentEntry = segmentMap[playlistId] || segmentMap[`${playlistId}.mpls`] || null;
    const segmentFiles = Array.isArray(segmentEntry?.segmentFiles) ? segmentEntry.segmentFiles : [];
    for (const file of segmentFiles) {
      const name = path.basename(String(file || '').trim()).toLowerCase();
      if (!name) {
        continue;
      }
      set.add(name);
    }
  };

  if (selectedPlaylistId) {
    appendSegments(selectedPlaylistId);
    return set;
  }

  appendSegments(analysis?.recommendation?.playlistId || null);
  if (set.size > 0) {
    return set;
  }

  const candidates = Array.isArray(analysis.evaluatedCandidates) ? analysis.evaluatedCandidates : [];
  for (const candidate of candidates) {
    appendSegments(candidate?.playlistId || null);
  }
  return set;
}

function collectRawMediaCandidates(rawPath, { playlistAnalysis = null, selectedPlaylistId = null } = {}) {
  const primary = findMediaFiles(rawPath, ['.mkv', '.mp4']);
  if (primary.length > 0) {
    return {
      mediaFiles: primary,
      source: 'mkv'
    };
  }

  const streamDir = path.join(rawPath, 'BDMV', 'STREAM');
  const backupRoot = fs.existsSync(streamDir) ? streamDir : rawPath;
  let backupFiles = findMediaFiles(backupRoot, ['.m2ts']);
  if (backupFiles.length === 0) {
    return {
      mediaFiles: [],
      source: 'none'
    };
  }

  const allowedSegments = buildPlaylistSegmentFileSet(playlistAnalysis, selectedPlaylistId);
  if (allowedSegments.size > 0) {
    const filtered = backupFiles.filter((file) => allowedSegments.has(path.basename(file.path).toLowerCase()));
    if (filtered.length > 0) {
      backupFiles = filtered;
    }
  }

  return {
    mediaFiles: backupFiles,
    source: 'backup'
  };
}

function hasBluRayBackupStructure(rawPath) {
  if (!rawPath) {
    return false;
  }

  const bdmvDir = path.join(rawPath, 'BDMV');
  const streamDir = path.join(bdmvDir, 'STREAM');

  try {
    return fs.existsSync(bdmvDir) && fs.existsSync(streamDir);
  } catch (_error) {
    return false;
  }
}

function findPreferredRawInput(rawPath, options = {}) {
  const { mediaFiles } = collectRawMediaCandidates(rawPath, options);
  if (!Array.isArray(mediaFiles) || mediaFiles.length === 0) {
    return null;
  }
  return mediaFiles[0];
}

function extractManualSelectionPayloadFromPlan(encodePlan) {
  const selection = extractHandBrakeTrackSelectionFromPlan(encodePlan);
  if (!selection) {
    return null;
  }
  return {
    audioTrackIds: normalizeTrackIdList(selection.audioTrackIds),
    subtitleTrackIds: normalizeTrackIdList(selection.subtitleTrackIds)
  };
}

class PipelineService extends EventEmitter {
  constructor() {
    super();
    this.snapshot = {
      state: 'IDLE',
      activeJobId: null,
      progress: 0,
      eta: null,
      statusText: null,
      context: {}
    };
    this.detectedDisc = null;
    this.activeProcess = null;
    this.cancelRequested = false;
    this.lastPersistAt = 0;
    this.lastProgressKey = null;
  }

  async init() {
    const db = await getDb();
    const row = await db.get('SELECT * FROM pipeline_state WHERE id = 1');

    if (row) {
      this.snapshot = {
        state: row.state,
        activeJobId: row.active_job_id,
        progress: Number(row.progress || 0),
        eta: row.eta,
        statusText: row.status_text,
        context: this.safeParseJson(row.context_json)
      };
      logger.info('init:loaded-snapshot', { snapshot: this.snapshot });
    }

    if (RUNNING_STATES.has(this.snapshot.state) && this.snapshot.activeJobId) {
      const message = `Server-Neustart während ${this.snapshot.state} am ${new Date().toISOString()}`;
      await historyService.updateJobStatus(this.snapshot.activeJobId, 'ERROR', {
        end_time: nowIso(),
        error_message: message
      });
      await historyService.appendLog(this.snapshot.activeJobId, 'SYSTEM', message);

      await this.setState('ERROR', {
        activeJobId: this.snapshot.activeJobId,
        progress: 0,
        eta: null,
        statusText: message,
        context: {
          jobId: this.snapshot.activeJobId,
          stage: 'RECOVERY',
          error: message
        }
      });
      logger.warn('init:recovered-running-job', { jobId: this.snapshot.activeJobId, previousState: this.snapshot.state });
    }

    // Always start with a clean dashboard/session snapshot after server restart.
    const hasContextKeys = this.snapshot.context
      && typeof this.snapshot.context === 'object'
      && Object.keys(this.snapshot.context).length > 0;
    if (this.snapshot.state !== 'IDLE' || this.snapshot.activeJobId || hasContextKeys) {
      await this.resetFrontendState('server_restart', {
        force: true,
        keepDetectedDevice: false
      });
    }
  }

  safeParseJson(raw) {
    if (!raw) {
      return {};
    }

    try {
      return JSON.parse(raw);
    } catch (error) {
      logger.warn('safeParseJson:failed', { raw, error: errorToMeta(error) });
      return {};
    }
  }

  getSnapshot() {
    return {
      ...this.snapshot
    };
  }

  async resetFrontendState(reason = 'manual', options = {}) {
    const force = Boolean(options?.force);
    const keepDetectedDevice = options?.keepDetectedDevice !== false;

    if (!force && (this.activeProcess || RUNNING_STATES.has(this.snapshot.state))) {
      logger.warn('ui:reset:skipped-busy', {
        reason,
        state: this.snapshot.state,
        activeJobId: this.snapshot.activeJobId
      });
      return {
        reset: false,
        skipped: 'busy'
      };
    }

    const device = keepDetectedDevice ? (this.detectedDisc || null) : null;
    const nextState = device ? 'DISC_DETECTED' : 'IDLE';
    const statusText = device ? 'Neue Disk erkannt' : 'Bereit';

    logger.warn('ui:reset', {
      reason,
      previousState: this.snapshot.state,
      previousActiveJobId: this.snapshot.activeJobId,
      nextState,
      keepDetectedDevice
    });

    await this.setState(nextState, {
      activeJobId: null,
      progress: 0,
      eta: null,
      statusText,
      context: device ? { device } : {}
    });

    return {
      reset: true,
      state: nextState
    };
  }

  async notifyPushover(eventKey, payload = {}) {
    try {
      const result = await notificationService.notify(eventKey, payload);
      logger.debug('notify:event', {
        eventKey,
        sent: Boolean(result?.sent),
        reason: result?.reason || null
      });
    } catch (error) {
      logger.warn('notify:event:failed', {
        eventKey,
        error: errorToMeta(error)
      });
    }
  }

  normalizeDiscValue(value) {
    return String(value || '').trim().toLowerCase();
  }

  isSameDisc(a, b) {
    const aDiscLabel = this.normalizeDiscValue(a?.discLabel);
    const bDiscLabel = this.normalizeDiscValue(b?.discLabel);
    if (aDiscLabel && bDiscLabel) {
      return aDiscLabel === bDiscLabel;
    }

    const aPath = this.normalizeDiscValue(a?.path);
    const bPath = this.normalizeDiscValue(b?.path);
    if (aPath && bPath) {
      return aPath === bPath;
    }

    const aLabel = this.normalizeDiscValue(a?.label);
    const bLabel = this.normalizeDiscValue(b?.label);
    if (aLabel && bLabel) {
      return aLabel === bLabel;
    }

    return false;
  }

  async setState(state, patch = {}) {
    const previous = this.snapshot.state;
    this.snapshot = {
      ...this.snapshot,
      state,
      activeJobId: patch.activeJobId !== undefined ? patch.activeJobId : this.snapshot.activeJobId,
      progress: patch.progress !== undefined ? patch.progress : this.snapshot.progress,
      eta: patch.eta !== undefined ? patch.eta : this.snapshot.eta,
      statusText: patch.statusText !== undefined ? patch.statusText : this.snapshot.statusText,
      context: patch.context !== undefined ? patch.context : this.snapshot.context
    };
    logger.info('state:changed', {
      from: previous,
      to: state,
      activeJobId: this.snapshot.activeJobId,
      statusText: this.snapshot.statusText
    });

    await this.persistSnapshot();
    wsService.broadcast('PIPELINE_STATE_CHANGED', this.snapshot);
    this.emit('stateChanged', this.snapshot);
  }

  async persistSnapshot(force = true) {
    if (!force) {
      const now = Date.now();
      if (now - this.lastPersistAt < 300) {
        return;
      }
      this.lastPersistAt = now;
    }

    const db = await getDb();
    await db.run(
      `
        UPDATE pipeline_state
        SET
          state = ?,
          active_job_id = ?,
          progress = ?,
          eta = ?,
          status_text = ?,
          context_json = ?,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = 1
      `,
      [
        this.snapshot.state,
        this.snapshot.activeJobId,
        this.snapshot.progress,
        this.snapshot.eta,
        this.snapshot.statusText,
        JSON.stringify(this.snapshot.context || {})
      ]
    );
  }

  async updateProgress(stage, percent, eta, statusText) {
    this.snapshot = {
      ...this.snapshot,
      state: stage,
      progress: percent ?? this.snapshot.progress,
      eta: eta ?? this.snapshot.eta,
      statusText: statusText ?? this.snapshot.statusText
    };

    await this.persistSnapshot(false);
    const rounded = Number((this.snapshot.progress || 0).toFixed(2));
    const key = `${stage}:${rounded}`;
    if (key !== this.lastProgressKey) {
      this.lastProgressKey = key;
      logger.debug('progress:update', {
        stage,
        activeJobId: this.snapshot.activeJobId,
        progress: rounded,
        eta: this.snapshot.eta,
        statusText: this.snapshot.statusText
      });
    }
    wsService.broadcast('PIPELINE_PROGRESS', {
      state: stage,
      activeJobId: this.snapshot.activeJobId,
      progress: this.snapshot.progress,
      eta: this.snapshot.eta,
      statusText: this.snapshot.statusText
    });
  }

  async onDiscInserted(deviceInfo) {
    const previousDevice = this.snapshot.context?.device || this.detectedDisc;
    const previousState = this.snapshot.state;
    const previousJobId = this.snapshot.context?.jobId || this.snapshot.activeJobId || null;
    const discChanged = previousDevice ? !this.isSameDisc(previousDevice, deviceInfo) : false;

    this.detectedDisc = deviceInfo;
    logger.info('disc:inserted', { deviceInfo });

    wsService.broadcast('DISC_DETECTED', {
      device: deviceInfo
    });

    if (discChanged && !RUNNING_STATES.has(previousState) && previousState !== 'DISC_DETECTED' && previousState !== 'READY_TO_ENCODE') {
      const message = `Disk gewechselt (${deviceInfo.discLabel || deviceInfo.path || 'unbekannt'}). Bitte neu analysieren.`;
      logger.info('disc:changed:reset', {
        fromState: previousState,
        previousDevice,
        newDevice: deviceInfo,
        previousJobId
      });

      if (previousJobId && (previousState === 'METADATA_SELECTION' || previousState === 'READY_TO_START' || previousState === 'WAITING_FOR_USER_DECISION')) {
        await historyService.updateJob(previousJobId, {
          status: 'ERROR',
          last_state: 'ERROR',
          end_time: nowIso(),
          error_message: message
        });
        await historyService.appendLog(previousJobId, 'SYSTEM', message);
      }

      await this.setState('DISC_DETECTED', {
        activeJobId: null,
        progress: 0,
        eta: null,
        statusText: 'Neue Disk erkannt',
        context: {
          device: deviceInfo
        }
      });
      return;
    }

    if (this.snapshot.state === 'IDLE' || this.snapshot.state === 'FINISHED' || this.snapshot.state === 'ERROR' || this.snapshot.state === 'DISC_DETECTED') {
      await this.setState('DISC_DETECTED', {
        activeJobId: null,
        progress: 0,
        eta: null,
        statusText: 'Neue Disk erkannt',
        context: {
          device: deviceInfo
        }
      });
    }
  }

  async onDiscRemoved(deviceInfo) {
    logger.info('disc:removed', { deviceInfo });
    wsService.broadcast('DISC_REMOVED', {
      device: deviceInfo
    });

    this.detectedDisc = null;
    if (this.snapshot.state === 'DISC_DETECTED') {
      await this.setState('IDLE', {
        activeJobId: null,
        progress: 0,
        eta: null,
        statusText: 'Keine Disk erkannt',
        context: {}
      });
    }
  }

  ensureNotBusy(action) {
    if (this.activeProcess) {
      const error = new Error(`Pipeline ist beschäftigt. Aktion '${action}' aktuell nicht möglich.`);
      error.statusCode = 409;
      logger.warn('busy:blocked-action', {
        action,
        activeState: this.snapshot.state,
        activeJobId: this.snapshot.activeJobId
      });
      throw error;
    }
  }

  async ensureMakeMKVRegistration(jobId, stage) {
    const registrationConfig = await settingsService.buildMakeMKVRegisterConfig();
    if (!registrationConfig) {
      return { applied: false, reason: 'not_configured' };
    }

    await historyService.appendLog(
      jobId,
      'SYSTEM',
      'Setze MakeMKV-Registrierungsschlüssel aus den Settings (makemkvcon reg).'
    );

    await this.runCommand({
      jobId,
      stage,
      source: 'MAKEMKV_REG',
      cmd: registrationConfig.cmd,
      args: registrationConfig.args,
      argsForLog: registrationConfig.argsForLog
    });

    return { applied: true };
  }

  isReviewRefreshSettingKey(key) {
    const normalized = String(key || '').trim().toLowerCase();
    if (!normalized) {
      return false;
    }

    if (REVIEW_REFRESH_SETTING_KEYS.has(normalized)) {
      return true;
    }

    return REVIEW_REFRESH_SETTING_PREFIXES.some((prefix) => normalized.startsWith(prefix));
  }

  async refreshEncodeReviewAfterSettingsSave(changedKeys = []) {
    const keys = Array.isArray(changedKeys)
      ? changedKeys.map((item) => String(item || '').trim()).filter(Boolean)
      : [];
    const relevantKeys = keys.filter((key) => this.isReviewRefreshSettingKey(key));
    if (relevantKeys.length === 0) {
      return {
        triggered: false,
        reason: 'no_relevant_setting_changes',
        relevantKeys: []
      };
    }

    if (this.activeProcess || RUNNING_STATES.has(this.snapshot.state)) {
      return {
        triggered: false,
        reason: 'pipeline_busy',
        relevantKeys
      };
    }

    const rawJobId = Number(this.snapshot.activeJobId || this.snapshot.context?.jobId || null);
    const activeJobId = Number.isFinite(rawJobId) && rawJobId > 0 ? Math.trunc(rawJobId) : null;
    if (!activeJobId) {
      return {
        triggered: false,
        reason: 'no_active_job',
        relevantKeys
      };
    }

    const job = await historyService.getJobById(activeJobId);
    if (!job) {
      return {
        triggered: false,
        reason: 'active_job_not_found',
        relevantKeys,
        jobId: activeJobId
      };
    }

    if (job.status !== 'READY_TO_ENCODE' && job.last_state !== 'READY_TO_ENCODE') {
      return {
        triggered: false,
        reason: 'active_job_not_ready_to_encode',
        relevantKeys,
        jobId: activeJobId,
        status: job.status,
        lastState: job.last_state
      };
    }

    if (!job.raw_path || !fs.existsSync(job.raw_path)) {
      return {
        triggered: false,
        reason: 'raw_path_missing',
        relevantKeys,
        jobId: activeJobId,
        rawPath: job.raw_path || null
      };
    }

    const existingPlan = this.safeParseJson(job.encode_plan_json);
    const mode = existingPlan?.mode || this.snapshot.context?.mode || 'rip';
    const sourceJobId = existingPlan?.sourceJobId || this.snapshot.context?.sourceJobId || null;

    await historyService.appendLog(
      activeJobId,
      'SYSTEM',
      `Settings gespeichert (${relevantKeys.join(', ')}). Titel-/Spurprüfung wird mit aktueller Konfiguration neu gestartet.`
    );

    this.runReviewForRawJob(activeJobId, job.raw_path, { mode, sourceJobId }).catch((error) => {
      logger.error('settings:refresh-review:failed', {
        jobId: activeJobId,
        relevantKeys,
        error: errorToMeta(error)
      });
    });

    return {
      triggered: true,
      reason: 'refresh_started',
      relevantKeys,
      jobId: activeJobId,
      mode
    };
  }

  resolvePlaylistDecisionForJob(jobId, job, selectionOverride = null) {
    const activeContext = this.snapshot.context?.jobId === jobId
      ? (this.snapshot.context || {})
      : {};

    const mkInfo = this.safeParseJson(job?.makemkv_info_json);
    const analyzeContext = mkInfo?.analyzeContext || {};
    const playlistAnalysis = activeContext.playlistAnalysis || analyzeContext.playlistAnalysis || mkInfo?.playlistAnalysis || null;

    const playlistDecisionRequired = Boolean(
      activeContext.playlistDecisionRequired !== undefined
        ? activeContext.playlistDecisionRequired
        : (analyzeContext.playlistDecisionRequired !== undefined
          ? analyzeContext.playlistDecisionRequired
          : playlistAnalysis?.manualDecisionRequired)
    );

    const rawSelection = selectionOverride
      || activeContext.selectedPlaylist
      || analyzeContext.selectedPlaylist
      || null;
    const selectedPlaylist = normalizePlaylistId(rawSelection);

    const rawSelectedTitleId = activeContext.selectedTitleId ?? analyzeContext.selectedTitleId ?? null;
    let selectedTitleId = null;
    if (selectedPlaylist) {
      selectedTitleId = pickTitleIdForPlaylist(playlistAnalysis, selectedPlaylist);
    }
    if (selectedTitleId === null && rawSelectedTitleId !== null && rawSelectedTitleId !== undefined && rawSelectedTitleId !== '') {
      const parsedSelectedTitleId = Number(rawSelectedTitleId);
      if (Number.isFinite(parsedSelectedTitleId) && parsedSelectedTitleId >= 0) {
        selectedTitleId = Math.trunc(parsedSelectedTitleId);
      }
    }

    const candidatePlaylists = buildPlaylistCandidates(playlistAnalysis);
    const recommendation = playlistAnalysis?.recommendation || null;

    return {
      playlistAnalysis,
      playlistDecisionRequired,
      candidatePlaylists,
      selectedPlaylist,
      selectedTitleId,
      recommendation
    };
  }

  async analyzeDisc() {
    this.ensureNotBusy('analyze');
    logger.info('analyze:start');

    const device = this.detectedDisc || this.snapshot.context?.device;
    if (!device) {
      const error = new Error('Keine Disk erkannt.');
      error.statusCode = 400;
      logger.warn('analyze:no-disc');
      throw error;
    }

    const detectedTitle = String(
      device.discLabel
      || device.label
      || device.model
      || 'Unknown Disc'
    ).trim();

    const job = await historyService.createJob({
      discDevice: device.path,
      status: 'METADATA_SELECTION',
      detectedTitle
    });

    try {
      const omdbCandidates = await omdbService.search(detectedTitle).catch(() => []);
      logger.info('metadata:prepare:result', {
        jobId: job.id,
        detectedTitle,
        omdbCandidateCount: omdbCandidates.length
      });

      await historyService.updateJob(job.id, {
        status: 'METADATA_SELECTION',
        last_state: 'METADATA_SELECTION',
        detected_title: detectedTitle,
        makemkv_info_json: JSON.stringify({
          phase: 'PREPARE',
          preparedAt: nowIso(),
          analyzeContext: {
            playlistAnalysis: null,
            playlistDecisionRequired: false,
            selectedPlaylist: null,
            selectedTitleId: null
          }
        })
      });
      await historyService.appendLog(
        job.id,
        'SYSTEM',
        `Disk erkannt. Metadaten-Suche vorbereitet mit Query "${detectedTitle}".`
      );

      await this.setState('METADATA_SELECTION', {
        activeJobId: job.id,
        progress: 0,
        eta: null,
        statusText: 'Metadaten auswählen',
        context: {
          jobId: job.id,
          device,
          detectedTitle,
          detectedTitleSource: device.discLabel ? 'discLabel' : 'fallback',
          omdbCandidates,
          playlistAnalysis: null,
          playlistDecisionRequired: false,
          playlistCandidates: [],
          selectedPlaylist: null,
          selectedTitleId: null
        }
      });

      void this.notifyPushover('metadata_ready', {
        title: 'Ripster - Metadaten bereit',
        message: `Job #${job.id}: ${detectedTitle} (${omdbCandidates.length} Treffer)`
      });

      return {
        jobId: job.id,
        detectedTitle,
        omdbCandidates
      };
    } catch (error) {
      logger.error('metadata:prepare:failed', { jobId: job.id, error: errorToMeta(error) });
      await this.failJob(job.id, 'METADATA_SELECTION', error);
      throw error;
    }
  }

  async searchOmdb(query) {
    logger.info('omdb:search', { query });
    const results = await omdbService.search(query);
    logger.info('omdb:search:done', { query, count: results.length });
    return results;
  }

  async runDiscTrackReviewForJob(jobId, deviceInfo = null, options = {}) {
    this.ensureNotBusy('runDiscTrackReviewForJob');
    logger.info('disc-track-review:start', { jobId, deviceInfo, options });

    const job = await historyService.getJobById(jobId);
    if (!job) {
      const error = new Error(`Job ${jobId} nicht gefunden.`);
      error.statusCode = 404;
      throw error;
    }

    const settings = await settingsService.getSettingsMap();
    const mkInfo = this.safeParseJson(job.makemkv_info_json);
    const analyzeContext = mkInfo?.analyzeContext || {};
    const playlistAnalysis = analyzeContext.playlistAnalysis || this.snapshot.context?.playlistAnalysis || null;
    const selectedPlaylistId = normalizePlaylistId(
      options?.selectedPlaylist
      || analyzeContext.selectedPlaylist
      || this.snapshot.context?.selectedPlaylist
      || null
    );
    const selectedMakemkvTitleIdRaw = Number(
      options?.selectedTitleId
      ?? analyzeContext.selectedTitleId
      ?? this.snapshot.context?.selectedTitleId
      ?? null
    );
    const selectedMakemkvTitleId = Number.isFinite(selectedMakemkvTitleIdRaw) && selectedMakemkvTitleIdRaw >= 0
      ? Math.trunc(selectedMakemkvTitleIdRaw)
      : null;
    const selectedMetadata = {
      title: job.title || job.detected_title || null,
      year: job.year || null,
      imdbId: job.imdb_id || null,
      poster: job.poster_url || null
    };

    await this.setState('MEDIAINFO_CHECK', {
      activeJobId: jobId,
      progress: 0,
      eta: null,
      statusText: 'Vorab-Spurprüfung (Disc) läuft',
      context: {
        ...(this.snapshot.context || {}),
        jobId,
        reviewConfirmed: false,
        mode: 'pre_rip',
        selectedMetadata
      }
    });

    await historyService.updateJob(jobId, {
      status: 'MEDIAINFO_CHECK',
      last_state: 'MEDIAINFO_CHECK',
      error_message: null,
      mediainfo_info_json: null,
      encode_plan_json: null,
      encode_input_path: null,
      encode_review_confirmed: 0
    });

    const lines = [];
    const scanConfig = await settingsService.buildHandBrakeScanConfig(deviceInfo);
    logger.info('disc-track-review:command', {
      jobId,
      cmd: scanConfig.cmd,
      args: scanConfig.args,
      sourceArg: scanConfig.sourceArg,
      selectedTitleId: selectedMakemkvTitleId
    });

    const runInfo = await this.runCommand({
      jobId,
      stage: 'MEDIAINFO_CHECK',
      source: 'HANDBRAKE_SCAN',
      cmd: scanConfig.cmd,
      args: scanConfig.args,
      collectLines: lines,
      collectStderrLines: false
    });

    const parsed = parseMediainfoJsonOutput(lines.join('\n'));
    if (!parsed) {
      const error = new Error('HandBrake Scan-Ausgabe konnte nicht als JSON gelesen werden.');
      error.runInfo = runInfo;
      throw error;
    }

    const review = buildDiscScanReview({
      scanJson: parsed,
      settings,
      playlistAnalysis,
      selectedPlaylistId,
      selectedMakemkvTitleId,
      sourceArg: scanConfig.sourceArg
    });

    if (!Array.isArray(review.titles) || review.titles.length === 0) {
      const error = new Error('Vorab-Spurprüfung lieferte keine Titel.');
      error.statusCode = 400;
      throw error;
    }

    await historyService.updateJob(jobId, {
      status: 'READY_TO_ENCODE',
      last_state: 'READY_TO_ENCODE',
      error_message: null,
      mediainfo_info_json: JSON.stringify({
        generatedAt: nowIso(),
        source: 'disc_scan',
        runInfo
      }),
      encode_plan_json: JSON.stringify(review),
      encode_input_path: review.encodeInputPath || null,
      encode_review_confirmed: 0
    });

    await historyService.appendLog(
      jobId,
      'SYSTEM',
      `Vorab-Spurprüfung abgeschlossen: ${review.titles.length} Titel, Auswahl=${review.encodeInputTitleId ? `Titel #${review.encodeInputTitleId}` : 'keine'}.`
    );

    await this.setState('READY_TO_ENCODE', {
      activeJobId: jobId,
      progress: 0,
      eta: null,
      statusText: review.titleSelectionRequired
        ? 'Vorab-Spurprüfung fertig - Titel per Checkbox wählen'
        : 'Vorab-Spurprüfung fertig - Auswahl bestätigen, dann Backup/Encode starten',
      context: {
        ...(this.snapshot.context || {}),
        jobId,
        inputPath: review.encodeInputPath || null,
        hasEncodableTitle: Boolean(review.encodeInputTitleId),
        reviewConfirmed: false,
        mode: 'pre_rip',
        mediaInfoReview: review,
        selectedMetadata
      }
    });

    return review;
  }

  async handleDiscTrackReviewFailure(jobId, error, context = {}) {
    const message = error?.message || String(error);
    const runInfo = error?.runInfo && typeof error.runInfo === 'object'
      ? error.runInfo
      : null;
    const isDiscScanFailure = String(runInfo?.source || '').toUpperCase() === 'HANDBRAKE_SCAN'
      || /no title found/i.test(message);

    if (!isDiscScanFailure) {
      await this.failJob(jobId, 'MEDIAINFO_CHECK', error);
      return;
    }

    logger.warn('disc-track-review:fallback-to-manual-rip', {
      jobId,
      message,
      runInfo: runInfo || null
    });

    await historyService.updateJob(jobId, {
      status: 'READY_TO_START',
      last_state: 'READY_TO_START',
      error_message: null,
      mediainfo_info_json: JSON.stringify({
        source: 'disc_scan',
        failedAt: nowIso(),
        error: message,
        runInfo
      }),
      encode_plan_json: null,
      encode_input_path: null,
      encode_review_confirmed: 0
    });

    await historyService.appendLog(
      jobId,
      'SYSTEM',
      `Vorab-Spurprüfung fehlgeschlagen (${message}). Fallback: Backup/Rip kann manuell gestartet werden; Spurauswahl erfolgt danach.`
    );

    await this.setState('READY_TO_START', {
      activeJobId: jobId,
      progress: 0,
      eta: null,
      statusText: 'Vorab-Spurprüfung fehlgeschlagen - Backup manuell starten',
      context: {
        ...(this.snapshot.context || {}),
        jobId,
        selectedMetadata: context.selectedMetadata || this.snapshot.context?.selectedMetadata || null,
        playlistAnalysis: context.playlistAnalysis || this.snapshot.context?.playlistAnalysis || null,
        playlistDecisionRequired: Boolean(context.playlistDecisionRequired ?? this.snapshot.context?.playlistDecisionRequired),
        playlistCandidates: context.playlistCandidates || this.snapshot.context?.playlistCandidates || [],
        selectedPlaylist: context.selectedPlaylist || this.snapshot.context?.selectedPlaylist || null,
        selectedTitleId: context.selectedTitleId ?? this.snapshot.context?.selectedTitleId ?? null,
        preRipScanFailed: true,
        preRipScanError: message
      }
    });
  }

  async runBackupTrackReviewForJob(jobId, rawPath, options = {}) {
    this.ensureNotBusy('runBackupTrackReviewForJob');
    logger.info('backup-track-review:start', { jobId, rawPath, options });

    const job = await historyService.getJobById(jobId);
    if (!job) {
      const error = new Error(`Job ${jobId} nicht gefunden.`);
      error.statusCode = 404;
      throw error;
    }

    if (!rawPath || !fs.existsSync(rawPath)) {
      const error = new Error(`RAW-Pfad nicht gefunden (${rawPath || '-'})`);
      error.statusCode = 400;
      throw error;
    }

    const mode = String(options?.mode || 'rip').trim().toLowerCase() || 'rip';
    const forcePlaylistReselection = Boolean(options?.forcePlaylistReselection);
    const settings = await settingsService.getSettingsMap();
    const mkInfo = this.safeParseJson(job.makemkv_info_json);
    const analyzeContext = mkInfo?.analyzeContext || {};
    let playlistAnalysis = analyzeContext.playlistAnalysis || this.snapshot.context?.playlistAnalysis || null;
    let handBrakePlaylistScan = normalizeHandBrakePlaylistScanCache(analyzeContext.handBrakePlaylistScan || null);
    if (playlistAnalysis && handBrakePlaylistScan) {
      playlistAnalysis = enrichPlaylistAnalysisWithHandBrakeCache(playlistAnalysis, handBrakePlaylistScan);
    }
    const selectedPlaylistSource = forcePlaylistReselection
      ? (options?.selectedPlaylist || null)
      : (options?.selectedPlaylist || analyzeContext.selectedPlaylist || this.snapshot.context?.selectedPlaylist || null);
    const selectedPlaylistId = normalizePlaylistId(
      selectedPlaylistSource
    );
    const selectedTitleSource = forcePlaylistReselection
      ? (options?.selectedTitleId ?? null)
      : (options?.selectedTitleId ?? analyzeContext.selectedTitleId ?? this.snapshot.context?.selectedTitleId ?? null);
    const selectedMakemkvTitleIdRaw = Number(
      selectedTitleSource
    );
    const selectedMakemkvTitleId = Number.isFinite(selectedMakemkvTitleIdRaw) && selectedMakemkvTitleIdRaw >= 0
      ? Math.trunc(selectedMakemkvTitleIdRaw)
      : null;
    const selectedMetadata = {
      title: job.title || job.detected_title || null,
      year: job.year || null,
      imdbId: job.imdb_id || null,
      poster: job.poster_url || null
    };

    await this.setState('MEDIAINFO_CHECK', {
      activeJobId: jobId,
      progress: 0,
      eta: null,
      statusText: 'Titel-/Spurprüfung aus RAW-Backup läuft',
      context: {
        ...(this.snapshot.context || {}),
        jobId,
        rawPath,
        inputPath: null,
        hasEncodableTitle: false,
        reviewConfirmed: false,
        mode,
        sourceJobId: options.sourceJobId || null,
        selectedMetadata
      }
    });

    await historyService.updateJob(jobId, {
      status: 'MEDIAINFO_CHECK',
      last_state: 'MEDIAINFO_CHECK',
      error_message: null,
      mediainfo_info_json: null,
      encode_plan_json: null,
      encode_input_path: null,
      encode_review_confirmed: 0
    });

    if (forcePlaylistReselection && !selectedPlaylistId) {
      await historyService.appendLog(
        jobId,
        'SYSTEM',
        'Re-Encode: gespeicherte Playlist-Auswahl wird ignoriert. Bitte Playlist manuell neu auswählen.'
      );
    }

    // Build playlist->TITLE_ID mapping once from MakeMKV full robot scan on RAW backup.
    let makeMkvAnalyzeRunInfo = null;
    let analyzedFromFreshRun = false;
    const existingPostBackupAnalyze = mkInfo?.postBackupAnalyze && typeof mkInfo.postBackupAnalyze === 'object'
      ? mkInfo.postBackupAnalyze
      : null;

    await this.ensureMakeMKVRegistration(jobId, 'MEDIAINFO_CHECK');
    if (selectedPlaylistId) {
      if (!playlistAnalysis || !Array.isArray(playlistAnalysis?.titles) || playlistAnalysis.titles.length === 0) {
        const error = new Error(
          'Playlist-Auswahl kann nicht fortgesetzt werden: MakeMKV-Mapping fehlt. Bitte zuerst die RAW-Analyse erneut starten.'
        );
        error.statusCode = 409;
        throw error;
      }
      await historyService.appendLog(
        jobId,
        'SYSTEM',
        'Verwende vorhandenes MakeMKV-Playlist-Mapping aus dem letzten Full-Scan (kein erneuter Full-Scan).'
      );
    } else {
      const analyzeLines = [];
      const analyzeConfig = await settingsService.buildMakeMKVAnalyzePathConfig(rawPath);
      logger.info('backup-track-review:makemkv-analyze-command', {
        jobId,
        cmd: analyzeConfig.cmd,
        args: analyzeConfig.args,
        sourceArg: analyzeConfig.sourceArg
      });

      makeMkvAnalyzeRunInfo = await this.runCommand({
        jobId,
        stage: 'MEDIAINFO_CHECK',
        source: 'MAKEMKV_ANALYZE_BACKUP',
        cmd: analyzeConfig.cmd,
        args: analyzeConfig.args,
        parser: parseMakeMkvProgress,
        collectLines: analyzeLines
      });

      const analyzed = analyzePlaylistObfuscation(
        analyzeLines,
        Number(settings.makemkv_min_length_minutes || 60),
        {}
      );
      playlistAnalysis = analyzed || null;
      analyzedFromFreshRun = true;
    }

    const playlistDecisionRequired = Boolean(playlistAnalysis?.manualDecisionRequired);
    let playlistCandidates = buildPlaylistCandidates(playlistAnalysis);
    const selectedTitleFromPlaylist = selectedPlaylistId
      ? pickTitleIdForPlaylist(playlistAnalysis, selectedPlaylistId)
      : null;
    const selectedTitleForContext = selectedTitleFromPlaylist ?? selectedMakemkvTitleId ?? null;
    if (selectedPlaylistId && playlistCandidates.length > 0) {
      const isKnownPlaylist = playlistCandidates.some((item) => item.playlistId === selectedPlaylistId);
      if (!isKnownPlaylist) {
        const error = new Error(`Playlist ${selectedPlaylistId}.mpls ist nicht in den erkannten Kandidaten enthalten.`);
        error.statusCode = 400;
        throw error;
      }
    }

    const shouldPrepareHandBrakeDecisionData = Boolean(
      playlistDecisionRequired
      && !selectedPlaylistId
      && playlistCandidates.length > 0
    );
    if (shouldPrepareHandBrakeDecisionData) {
      const hasCompleteCache = hasCachedHandBrakeDataForPlaylistCandidates(handBrakePlaylistScan, playlistCandidates);
      if (!hasCompleteCache) {
        await this.updateProgress(
          'MEDIAINFO_CHECK',
          25,
          null,
          'HandBrake Trackdaten für Playlist-Auswahl werden vorbereitet'
        );
        try {
          const resolveScanLines = [];
          const resolveScanConfig = await settingsService.buildHandBrakeScanConfigForInput(rawPath);
          logger.info('backup-track-review:handbrake-predecision-command', {
            jobId,
            cmd: resolveScanConfig.cmd,
            args: resolveScanConfig.args,
            sourceArg: resolveScanConfig.sourceArg,
            candidatePlaylists: playlistCandidates.map((item) => item.playlistFile || item.playlistId)
          });

          await this.runCommand({
            jobId,
            stage: 'MEDIAINFO_CHECK',
            source: 'HANDBRAKE_SCAN_PLAYLIST_MAP',
            cmd: resolveScanConfig.cmd,
            args: resolveScanConfig.args,
            collectLines: resolveScanLines,
            collectStderrLines: false
          });

          const resolveScanJson = parseMediainfoJsonOutput(resolveScanLines.join('\n'));
          if (resolveScanJson) {
            const preparedCache = buildHandBrakePlaylistScanCache(resolveScanJson, playlistCandidates, rawPath);
            if (preparedCache) {
              handBrakePlaylistScan = preparedCache;
              playlistAnalysis = enrichPlaylistAnalysisWithHandBrakeCache(playlistAnalysis, handBrakePlaylistScan);
              playlistCandidates = buildPlaylistCandidates(playlistAnalysis);
              await historyService.appendLog(
                jobId,
                'SYSTEM',
                `HandBrake Playlist-Trackdaten vorbereitet: ${Object.keys(preparedCache.byPlaylist || {}).length} Kandidaten aus --scan -t 0 analysiert.`
              );
            } else {
              await historyService.appendLog(
                jobId,
                'SYSTEM',
                'HandBrake Playlist-Trackdaten konnten aus --scan -t 0 nicht auf Kandidaten abgebildet werden.'
              );
            }
          } else {
            await historyService.appendLog(
              jobId,
              'SYSTEM',
              'HandBrake Playlist-Trackdaten konnten nicht geparst werden (Warteansicht ohne Audiodetails).'
            );
          }
        } catch (error) {
          logger.warn('backup-track-review:handbrake-predecision-failed', {
            jobId,
            error: errorToMeta(error)
          });
          await historyService.appendLog(
            jobId,
            'SYSTEM',
            `HandBrake Voranalyse für Playlist-Auswahl fehlgeschlagen: ${error.message}`
          );
        }
      } else {
        playlistAnalysis = enrichPlaylistAnalysisWithHandBrakeCache(playlistAnalysis, handBrakePlaylistScan);
        playlistCandidates = buildPlaylistCandidates(playlistAnalysis);
        await historyService.appendLog(
          jobId,
          'SYSTEM',
          'HandBrake Playlist-Trackdaten aus Cache übernommen (kein erneuter --scan -t 0).'
        );
      }
    }

    const updatedMakemkvInfo = {
      ...mkInfo,
      analyzeContext: {
        ...(mkInfo?.analyzeContext || {}),
        playlistAnalysis: playlistAnalysis || null,
        playlistDecisionRequired,
        selectedPlaylist: selectedPlaylistId || null,
        selectedTitleId: selectedTitleForContext,
        handBrakePlaylistScan: handBrakePlaylistScan || null
      },
      postBackupAnalyze: analyzedFromFreshRun
        ? {
          analyzedAt: nowIso(),
          source: 'MAKEMKV_ANALYZE_BACKUP',
          runInfo: makeMkvAnalyzeRunInfo,
          error: null
        }
        : {
          analyzedAt: existingPostBackupAnalyze?.analyzedAt || nowIso(),
          source: 'MAKEMKV_ANALYZE_BACKUP',
          runInfo: existingPostBackupAnalyze?.runInfo || null,
          reused: true,
          error: null
        }
    };

    if (playlistDecisionRequired && !selectedPlaylistId) {
      const evaluated = Array.isArray(playlistAnalysis?.evaluatedCandidates)
        ? playlistAnalysis.evaluatedCandidates
        : [];
      const recommendationFile = toPlaylistFile(playlistAnalysis?.recommendation?.playlistId);

      await historyService.updateJob(jobId, {
        status: 'WAITING_FOR_USER_DECISION',
        last_state: 'WAITING_FOR_USER_DECISION',
        error_message: null,
        makemkv_info_json: JSON.stringify(updatedMakemkvInfo),
        mediainfo_info_json: JSON.stringify({
          generatedAt: nowIso(),
          source: 'makemkv_backup_robot',
          runInfo: makeMkvAnalyzeRunInfo
        }),
        encode_plan_json: null,
        encode_input_path: null,
        encode_review_confirmed: 0
      });

      await historyService.appendLog(jobId, 'SYSTEM', 'Mehrere mögliche Haupttitel erkannt!');
      await historyService.appendLog(jobId, 'SYSTEM', 'Blu-ray verwendet Playlist-Obfuscation.');
      for (const candidate of evaluated) {
        const playlistFile = toPlaylistFile(candidate?.playlistId) || `Titel #${candidate?.titleId || '-'}`;
        const score = Number(candidate?.score);
        const scoreLabel = Number.isFinite(score) ? score.toFixed(0) : '-';
        const recommendedLabel = candidate?.recommended ? ' (empfohlen)' : '';
        const evaluationLabel = candidate?.evaluationLabel ? ` | ${candidate.evaluationLabel}` : '';
        await historyService.appendLog(
          jobId,
          'SYSTEM',
          `${playlistFile} -> Score ${scoreLabel}${recommendedLabel}${evaluationLabel}`
        );
      }
      await historyService.appendLog(
        jobId,
        'SYSTEM',
        `Status=awaiting_playlist_selection${recommendationFile ? ` | Empfehlung=${recommendationFile}` : ''}`
      );

      await this.setState('WAITING_FOR_USER_DECISION', {
        activeJobId: jobId,
        progress: 0,
        eta: null,
        statusText: 'awaiting_playlist_selection',
        context: {
          ...(this.snapshot.context || {}),
          jobId,
          rawPath,
          inputPath: null,
          hasEncodableTitle: false,
          reviewConfirmed: false,
          mode,
          sourceJobId: options.sourceJobId || null,
          selectedMetadata,
          playlistAnalysis: playlistAnalysis || null,
          playlistDecisionRequired: true,
          playlistCandidates,
          selectedPlaylist: null,
          selectedTitleId: null,
          waitingForManualPlaylistSelection: true,
          manualDecisionState: 'awaiting_playlist_selection',
          mediaInfoReview: null
        }
      });

      const notificationMessage = [
        '⚠️ Manuelle Prüfung erforderlich!',
        'Mehrere gleichlange Playlists erkannt.',
        '',
        'Empfehlung:',
        recommendationFile || '(keine eindeutige Empfehlung)',
        '',
        'Bitte Titel manuell bestätigen,',
        'bevor Encoding gestartet wird.'
      ].join('\n');
      void this.notifyPushover('metadata_ready', {
        title: 'Ripster - Playlist-Auswahl erforderlich',
        message: notificationMessage,
        priority: 1
      });

      return {
        awaitingPlaylistSelection: true,
        playlistAnalysis,
        playlistCandidates,
        recommendation: playlistAnalysis?.recommendation || null
      };
    }

    if (selectedPlaylistId) {
      await historyService.appendLog(
        jobId,
        'USER_ACTION',
        `Playlist-Auswahl übernommen: ${toPlaylistFile(selectedPlaylistId) || selectedPlaylistId}.`
      );
    }

    const selectedTitleForReview = pickTitleIdForTrackReview(playlistAnalysis, selectedTitleForContext);
    if (selectedTitleForReview === null) {
      const error = new Error('Titel-/Spurprüfung aus RAW nicht möglich: keine auflösbare Titel-ID vorhanden.');
      error.statusCode = 400;
      throw error;
    }

    const selectedTitleFromAnalysis = Array.isArray(playlistAnalysis?.titles)
      ? (playlistAnalysis.titles.find((item) => Number(item?.titleId) === Number(selectedTitleForReview)) || null)
      : null;
    const resolvedPlaylistId = normalizePlaylistId(
      selectedPlaylistId
      || selectedTitleFromAnalysis?.playlistId
      || playlistAnalysis?.recommendation?.playlistId
      || null
    );
    if (!resolvedPlaylistId) {
      const error = new Error(
        `Playlist konnte für MakeMKV Titel #${selectedTitleForReview} nicht aufgelöst werden.`
      );
      error.statusCode = 400;
      throw error;
    }

    if (updatedMakemkvInfo && updatedMakemkvInfo.analyzeContext) {
      updatedMakemkvInfo.analyzeContext.selectedTitleId = selectedTitleForReview;
      updatedMakemkvInfo.analyzeContext.selectedPlaylist = resolvedPlaylistId;
    }

    const cachedHandBrakePlaylistEntry = getCachedHandBrakePlaylistEntry(handBrakePlaylistScan, resolvedPlaylistId);
    const hasCachedHandBrakeEntry = Boolean(
      cachedHandBrakePlaylistEntry
      && cachedHandBrakePlaylistEntry.titleInfo
      && Number.isFinite(Number(cachedHandBrakePlaylistEntry.handBrakeTitleId))
      && Number(cachedHandBrakePlaylistEntry.handBrakeTitleId) > 0
    );

    await this.updateProgress(
      'MEDIAINFO_CHECK',
      30,
      null,
      hasCachedHandBrakeEntry
        ? `HandBrake Trackdaten aus Cache (${toPlaylistFile(resolvedPlaylistId) || resolvedPlaylistId})`
        : `HandBrake Titel-/Spurscan läuft (${toPlaylistFile(resolvedPlaylistId) || resolvedPlaylistId})`
    );

    let handBrakeResolveRunInfo = null;
    let handBrakeTitleRunInfo = null;
    let resolvedHandBrakeTitleId = null;
    const reviewTitleSource = 'handbrake';
    let reviewTitleInfo = null;
    if (hasCachedHandBrakeEntry) {
      resolvedHandBrakeTitleId = Math.trunc(Number(cachedHandBrakePlaylistEntry.handBrakeTitleId));
      reviewTitleInfo = cachedHandBrakePlaylistEntry.titleInfo;
      handBrakeResolveRunInfo = {
        source: 'HANDBRAKE_SCAN_PLAYLIST_MAP_CACHE',
        stage: 'MEDIAINFO_CHECK',
        status: 'CACHED',
        exitCode: 0,
        startedAt: handBrakePlaylistScan?.generatedAt || null,
        endedAt: nowIso(),
        durationMs: 0,
        cmd: 'cache',
        args: [`playlist=${resolvedPlaylistId}`, `title=${resolvedHandBrakeTitleId}`],
        highlights: [
          `Cache verwendet: ${toPlaylistFile(resolvedPlaylistId)} -> -t ${resolvedHandBrakeTitleId}`
        ]
      };
      handBrakeTitleRunInfo = handBrakeResolveRunInfo;
      await historyService.appendLog(
        jobId,
        'SYSTEM',
        `HandBrake Track-Analyse aus Cache: ${toPlaylistFile(resolvedPlaylistId)} -> -t ${resolvedHandBrakeTitleId} (kein erneuter --scan).`
      );
    } else {
      try {
        const resolveScanLines = [];
        const resolveScanConfig = await settingsService.buildHandBrakeScanConfigForInput(rawPath);
        logger.info('backup-track-review:handbrake-resolve-command', {
          jobId,
          cmd: resolveScanConfig.cmd,
          args: resolveScanConfig.args,
          sourceArg: resolveScanConfig.sourceArg,
          selectedPlaylistId: resolvedPlaylistId,
          selectedMakemkvTitleId: selectedTitleForReview
        });

        handBrakeResolveRunInfo = await this.runCommand({
          jobId,
          stage: 'MEDIAINFO_CHECK',
          source: 'HANDBRAKE_SCAN_PLAYLIST_MAP',
          cmd: resolveScanConfig.cmd,
          args: resolveScanConfig.args,
          collectLines: resolveScanLines,
          collectStderrLines: false
        });

        const resolveScanJson = parseMediainfoJsonOutput(resolveScanLines.join('\n'));
        if (!resolveScanJson) {
          const error = new Error('HandBrake Playlist-Mapping lieferte kein parsebares JSON.');
          error.runInfo = handBrakeResolveRunInfo;
          throw error;
        }

        resolvedHandBrakeTitleId = resolveHandBrakeTitleIdForPlaylist(resolveScanJson, resolvedPlaylistId);
        if (!resolvedHandBrakeTitleId) {
          const error = new Error(`Kein HandBrake-Titel für ${toPlaylistFile(resolvedPlaylistId)} gefunden.`);
          error.statusCode = 400;
          error.runInfo = handBrakeResolveRunInfo;
          throw error;
        }

        reviewTitleInfo = parseHandBrakeSelectedTitleInfo(resolveScanJson, {
          playlistId: resolvedPlaylistId,
          handBrakeTitleId: resolvedHandBrakeTitleId
        });
        if (!reviewTitleInfo) {
          const error = new Error(
            `HandBrake lieferte keine verwertbaren Trackdaten für ${toPlaylistFile(resolvedPlaylistId)} (-t ${resolvedHandBrakeTitleId}).`
          );
          error.statusCode = 400;
          error.runInfo = handBrakeResolveRunInfo;
          throw error;
        }

        handBrakeTitleRunInfo = handBrakeResolveRunInfo;
        await historyService.appendLog(
          jobId,
          'SYSTEM',
          `HandBrake Track-Analyse aktiv: ${toPlaylistFile(resolvedPlaylistId)} -> -t ${resolvedHandBrakeTitleId} (aus --scan -t 0).`
        );

        const audioTrackPreview = buildHandBrakeAudioTrackPreview(reviewTitleInfo);
        const fallbackCache = normalizeHandBrakePlaylistScanCache(handBrakePlaylistScan) || {
          generatedAt: nowIso(),
          source: 'HANDBRAKE_SCAN_PLAYLIST_MAP',
          inputPath: rawPath,
          byPlaylist: {}
        };
        fallbackCache.byPlaylist[resolvedPlaylistId] = {
          playlistId: resolvedPlaylistId,
          handBrakeTitleId: Math.trunc(Number(resolvedHandBrakeTitleId)),
          titleInfo: reviewTitleInfo,
          audioTrackPreview,
          audioSummary: buildHandBrakeAudioSummary(audioTrackPreview)
        };
        handBrakePlaylistScan = normalizeHandBrakePlaylistScanCache(fallbackCache);
        playlistAnalysis = enrichPlaylistAnalysisWithHandBrakeCache(playlistAnalysis, handBrakePlaylistScan);
      } catch (error) {
        logger.warn('backup-track-review:handbrake-scan-failed', {
          jobId,
          selectedPlaylistId: resolvedPlaylistId,
          selectedTitleForReview,
          error: errorToMeta(error)
        });
        throw error;
      }
    }

    if (updatedMakemkvInfo && updatedMakemkvInfo.analyzeContext) {
      updatedMakemkvInfo.analyzeContext.handBrakePlaylistScan = handBrakePlaylistScan || null;
    }
    playlistCandidates = buildPlaylistCandidates(playlistAnalysis);

    let presetProfile = null;
    try {
      presetProfile = await settingsService.buildHandBrakePresetProfile(rawPath, {
        titleId: resolvedHandBrakeTitleId
      });
    } catch (error) {
      logger.warn('backup-track-review:preset-profile-failed', {
        jobId,
        error: errorToMeta(error)
      });
      presetProfile = {
        source: 'fallback',
        message: `Preset-Profil konnte nicht geladen werden: ${error.message}`
      };
    }

    const syntheticFilePath = path.join(
      rawPath,
      reviewTitleSource === 'handbrake' && Number.isFinite(Number(resolvedHandBrakeTitleId)) && Number(resolvedHandBrakeTitleId) > 0
        ? `handbrake_t${String(Math.trunc(Number(resolvedHandBrakeTitleId))).padStart(2, '0')}.mkv`
        : `makemkv_t${String(selectedTitleForReview).padStart(2, '0')}.mkv`
    );
    const syntheticMediaInfoByPath = {
      [syntheticFilePath]: buildSyntheticMediaInfoFromMakeMkvTitle(reviewTitleInfo)
    };
    let review = buildMediainfoReview({
      mediaFiles: [{
        path: syntheticFilePath,
        size: Number(reviewTitleInfo?.sizeBytes || 0)
      }],
      mediaInfoByPath: syntheticMediaInfoByPath,
      settings,
      presetProfile,
      playlistAnalysis,
      preferredEncodeTitleId: selectedTitleForReview,
      selectedPlaylistId: resolvedPlaylistId || reviewTitleInfo?.playlistId || null,
      selectedMakemkvTitleId: selectedTitleForReview
    });
    review = remapReviewTrackIdsToSourceIds(review);

    const resolvedPlaylistInfo = resolvePlaylistInfoFromAnalysis(playlistAnalysis, resolvedPlaylistId);
    const normalizedTitles = (Array.isArray(review.titles) ? review.titles : [])
      .slice(0, 1)
      .map((title) => ({
        ...title,
        filePath: rawPath,
        fileName: reviewTitleInfo?.fileName || title?.fileName || `Title #${selectedTitleForReview}`,
        durationSeconds: Number(reviewTitleInfo?.durationSeconds || title?.durationSeconds || 0),
        durationMinutes: Number((((reviewTitleInfo?.durationSeconds || title?.durationSeconds || 0) / 60)).toFixed(2)),
        sizeBytes: Number(reviewTitleInfo?.sizeBytes || title?.sizeBytes || 0),
        playlistId: resolvedPlaylistInfo.playlistId || title?.playlistId || null,
        playlistFile: resolvedPlaylistInfo.playlistFile || title?.playlistFile || null,
        playlistRecommended: Boolean(resolvedPlaylistInfo.recommended || title?.playlistRecommended),
        playlistEvaluationLabel: resolvedPlaylistInfo.evaluationLabel || title?.playlistEvaluationLabel || null,
        playlistSegmentCommand: resolvedPlaylistInfo.segmentCommand || title?.playlistSegmentCommand || null,
        playlistSegmentFiles: Array.isArray(resolvedPlaylistInfo.segmentFiles) && resolvedPlaylistInfo.segmentFiles.length > 0
          ? resolvedPlaylistInfo.segmentFiles
          : (Array.isArray(title?.playlistSegmentFiles) ? title.playlistSegmentFiles : [])
      }));

    const encodeInputTitleId = Number(normalizedTitles[0]?.id || review.encodeInputTitleId || null) || null;
    review = {
      ...review,
      mode,
      sourceJobId: options.sourceJobId || null,
      reviewConfirmed: false,
      partial: false,
      processedFiles: 1,
      totalFiles: 1,
      handBrakeTitleId: resolvedHandBrakeTitleId || null,
      selectedPlaylistId: resolvedPlaylistId || null,
      selectedMakemkvTitleId: selectedTitleForReview,
      titleSelectionRequired: false,
      titles: normalizedTitles,
      selectedTitleIds: encodeInputTitleId ? [encodeInputTitleId] : [],
      encodeInputTitleId,
      encodeInputPath: rawPath,
      notes: [
        ...(Array.isArray(review.notes) ? review.notes : []),
        'MakeMKV Full-Analyse wurde einmal für Playlist-/Titel-Mapping verwendet.',
        `HandBrake Track-Analyse aktiv: ${toPlaylistFile(resolvedPlaylistId)} -> -t ${resolvedHandBrakeTitleId} (aus --scan -t 0).`
      ]
    };

    if (!Array.isArray(review.titles) || review.titles.length === 0) {
      const error = new Error('Titel-/Spurprüfung aus RAW lieferte keine Titel.');
      error.statusCode = 400;
      throw error;
    }

    await historyService.updateJob(jobId, {
      status: 'READY_TO_ENCODE',
      last_state: 'READY_TO_ENCODE',
      error_message: null,
      makemkv_info_json: JSON.stringify(updatedMakemkvInfo),
      mediainfo_info_json: JSON.stringify({
        generatedAt: nowIso(),
        source: 'raw_backup_handbrake_playlist_scan',
        makemkvAnalyzeRunInfo: makeMkvAnalyzeRunInfo,
        makemkvTitleAnalyzeRunInfo: null,
        handbrakePlaylistResolveRunInfo: handBrakeResolveRunInfo,
        handbrakeTitleRunInfo: handBrakeTitleRunInfo,
        handbrakeTitleId: resolvedHandBrakeTitleId || null
      }),
      encode_plan_json: JSON.stringify(review),
      encode_input_path: review.encodeInputPath || null,
      encode_review_confirmed: 0
    });

    await historyService.appendLog(
      jobId,
      'SYSTEM',
      `Titel-/Spurprüfung aus RAW abgeschlossen (MakeMKV Titel #${selectedTitleForReview}): ${review.titles.length} Titel, Vorauswahl=${review.encodeInputTitleId ? `Titel #${review.encodeInputTitleId}` : 'keine'}.`
    );
    if (playlistDecisionRequired) {
      const playlistFiles = playlistCandidates.map((item) => item.playlistFile).filter(Boolean);
      const recommendationFile = toPlaylistFile(playlistAnalysis?.recommendation?.playlistId);
      await historyService.appendLog(
        jobId,
        'SYSTEM',
        `Playlist-Obfuscation erkannt (RAW). Kandidaten: ${playlistFiles.join(', ') || 'keine'}.`
      );
      if (recommendationFile) {
        await historyService.appendLog(
          jobId,
          'SYSTEM',
          `Playlist-Empfehlung: ${recommendationFile}`
        );
      }
    }

    const hasEncodableTitle = Boolean(review.encodeInputPath && review.encodeInputTitleId);
    await this.setState('READY_TO_ENCODE', {
      activeJobId: jobId,
      progress: 0,
      eta: null,
      statusText: review.titleSelectionRequired
        ? 'Titel-/Spurprüfung fertig - Titel per Checkbox wählen'
        : (hasEncodableTitle
          ? 'Titel-/Spurprüfung fertig - Auswahl bestätigen, dann Encode manuell starten'
          : 'Titel-/Spurprüfung fertig - kein Titel erfüllt MIN_LENGTH_MINUTES'),
      context: {
        ...(this.snapshot.context || {}),
        jobId,
        rawPath,
        inputPath: review.encodeInputPath || null,
        hasEncodableTitle,
        reviewConfirmed: false,
        mode,
        sourceJobId: options.sourceJobId || null,
        mediaInfoReview: review,
        selectedMetadata,
        playlistAnalysis: playlistAnalysis || null,
        playlistDecisionRequired,
        playlistCandidates,
        selectedPlaylist: resolvedPlaylistId || null,
        selectedTitleId: selectedTitleForReview
      }
    });

    void this.notifyPushover('metadata_ready', {
      title: 'Ripster - RAW geprüft',
      message: `Job #${jobId}: bereit zum manuellen Encode-Start`
    });

    return review;
  }

  async runReviewForRawJob(jobId, rawPath, options = {}) {
    const useBackupReview = hasBluRayBackupStructure(rawPath);
    logger.info('review:dispatch', {
      jobId,
      rawPath,
      mode: options?.mode || 'rip',
      useBackupReview
    });

    if (useBackupReview) {
      return this.runBackupTrackReviewForJob(jobId, rawPath, options);
    }
    return this.runMediainfoReviewForJob(jobId, rawPath, options);
  }

  async selectMetadata({ jobId, title, year, imdbId, poster, fromOmdb = null, selectedPlaylist = null }) {
    this.ensureNotBusy('selectMetadata');
    logger.info('metadata:selected', { jobId, title, year, imdbId, poster, fromOmdb, selectedPlaylist });

    const job = await historyService.getJobById(jobId);
    if (!job) {
      const error = new Error(`Job ${jobId} nicht gefunden.`);
      error.statusCode = 404;
      throw error;
    }

    const normalizedSelectedPlaylist = normalizePlaylistId(selectedPlaylist);
    const waitingForPlaylistSelection = (
      job.status === 'WAITING_FOR_USER_DECISION'
      || job.last_state === 'WAITING_FOR_USER_DECISION'
    );
    const hasExplicitMetadataPayload = (
      title !== undefined
      || year !== undefined
      || imdbId !== undefined
      || poster !== undefined
      || (fromOmdb !== null && fromOmdb !== undefined)
    );
    if (normalizedSelectedPlaylist && waitingForPlaylistSelection && job.raw_path && !hasExplicitMetadataPayload) {
      const currentMkInfo = this.safeParseJson(job.makemkv_info_json);
      const currentAnalyzeContext = currentMkInfo?.analyzeContext || {};
      const currentPlaylistAnalysis = currentAnalyzeContext.playlistAnalysis || this.snapshot.context?.playlistAnalysis || null;
      const selectedTitleId = pickTitleIdForPlaylist(currentPlaylistAnalysis, normalizedSelectedPlaylist);
      const updatedMkInfo = {
        ...currentMkInfo,
        analyzeContext: {
          ...currentAnalyzeContext,
          playlistAnalysis: currentPlaylistAnalysis || null,
          playlistDecisionRequired: Boolean(currentPlaylistAnalysis?.manualDecisionRequired),
          selectedPlaylist: normalizedSelectedPlaylist,
          selectedTitleId: selectedTitleId ?? null
        }
      };

      await historyService.updateJob(jobId, {
        status: 'MEDIAINFO_CHECK',
        last_state: 'MEDIAINFO_CHECK',
        error_message: null,
        makemkv_info_json: JSON.stringify(updatedMkInfo),
        mediainfo_info_json: null,
        encode_plan_json: null,
        encode_input_path: null,
        encode_review_confirmed: 0
      });
      await historyService.appendLog(
        jobId,
        'USER_ACTION',
        `Playlist-Auswahl gesetzt: ${toPlaylistFile(normalizedSelectedPlaylist) || normalizedSelectedPlaylist}.`
      );

      try {
        await this.runBackupTrackReviewForJob(jobId, job.raw_path, {
          mode: 'rip',
          selectedPlaylist: normalizedSelectedPlaylist,
          selectedTitleId: selectedTitleId ?? null
        });
      } catch (error) {
        logger.error('metadata:playlist-selection:review-failed', {
          jobId,
          selectedPlaylist: normalizedSelectedPlaylist,
          selectedTitleId: selectedTitleId ?? null,
          error: errorToMeta(error)
        });
        await this.failJob(jobId, 'MEDIAINFO_CHECK', error);
        throw error;
      }
      return historyService.getJobById(jobId);
    }

    const hasTitleInput = title !== undefined && title !== null && String(title).trim().length > 0;
    const effectiveTitle = hasTitleInput
      ? String(title).trim()
      : (job.title || job.detected_title || 'Unknown Title');
    const hasYearInput = year !== undefined && year !== null && String(year).trim() !== '';
    let effectiveYear = job.year ?? null;
    if (hasYearInput) {
      const parsedYear = Number(year);
      effectiveYear = Number.isNaN(parsedYear) ? null : parsedYear;
    }
    const effectiveImdbId = imdbId === undefined
      ? (job.imdb_id || null)
      : (imdbId || null);
    const selectedFromOmdb = fromOmdb === null || fromOmdb === undefined
      ? Number(job.selected_from_omdb || 0)
      : (fromOmdb ? 1 : 0);
    const posterValue = poster === undefined
      ? (job.poster_url || null)
      : (poster || null);
    const selectedMetadata = {
      title: effectiveTitle,
      year: effectiveYear,
      imdbId: effectiveImdbId,
      poster: posterValue
    };
    const settings = await settingsService.getSettingsMap();
    const ripMode = String(settings.makemkv_rip_mode || 'mkv').trim().toLowerCase() === 'backup'
      ? 'backup'
      : 'mkv';
    const isBackupMode = ripMode === 'backup';
    const metadataBase = sanitizeFileName(
      renderTemplate('${title} (${year}) [${imdbId}]', {
        title: selectedMetadata.title || job.detected_title || `job-${jobId}`,
        year: selectedMetadata.year || new Date().getFullYear(),
        imdbId: selectedMetadata.imdbId || `job-${jobId}`
      })
    );
    const existingRawPath = findExistingRawDirectory(settings.raw_dir, metadataBase);
    const updatedRawPath = existingRawPath || null;
    const basePlaylistDecision = this.resolvePlaylistDecisionForJob(jobId, job, selectedPlaylist);
    const playlistDecision = isBackupMode
      ? {
        ...basePlaylistDecision,
        playlistAnalysis: null,
        playlistDecisionRequired: false,
        candidatePlaylists: [],
        selectedPlaylist: null,
        selectedTitleId: null,
        recommendation: null
      }
      : basePlaylistDecision;
    const requiresManualPlaylistSelection = Boolean(
      playlistDecision.playlistDecisionRequired && playlistDecision.selectedTitleId === null
    );
    const nextStatus = requiresManualPlaylistSelection ? 'WAITING_FOR_USER_DECISION' : 'READY_TO_START';

    const mkInfo = this.safeParseJson(job.makemkv_info_json);
    const updatedMakemkvInfo = {
      ...mkInfo,
      analyzeContext: {
        ...(mkInfo?.analyzeContext || {}),
        playlistAnalysis: playlistDecision.playlistAnalysis || mkInfo?.analyzeContext?.playlistAnalysis || null,
        playlistDecisionRequired: Boolean(playlistDecision.playlistDecisionRequired),
        selectedPlaylist: playlistDecision.selectedPlaylist || null,
        selectedTitleId: playlistDecision.selectedTitleId ?? null
      }
    };

    await historyService.updateJob(jobId, {
      title: effectiveTitle,
      year: effectiveYear,
      imdb_id: effectiveImdbId,
      poster_url: posterValue,
      selected_from_omdb: selectedFromOmdb,
      status: nextStatus,
      last_state: nextStatus,
      raw_path: updatedRawPath,
      makemkv_info_json: JSON.stringify(updatedMakemkvInfo)
    });

    if (existingRawPath) {
      await historyService.appendLog(
        jobId,
        'SYSTEM',
        `Vorhandenes RAW-Verzeichnis erkannt: ${existingRawPath}`
      );
    } else {
      await historyService.appendLog(
        jobId,
        'SYSTEM',
        `Kein bestehendes RAW-Verzeichnis zu den Metadaten gefunden (${metadataBase}).`
      );
    }

    await this.setState(nextStatus, {
      activeJobId: jobId,
      progress: 0,
      eta: null,
      statusText: requiresManualPlaylistSelection
        ? 'waiting_for_manual_playlist_selection'
        : (existingRawPath
          ? 'Metadaten übernommen - vorhandenes RAW erkannt'
          : 'Metadaten übernommen - bereit zum Start'),
      context: {
        ...(this.snapshot.context || {}),
        jobId,
        rawPath: updatedRawPath,
        selectedMetadata,
        playlistAnalysis: playlistDecision.playlistAnalysis || null,
        playlistDecisionRequired: Boolean(playlistDecision.playlistDecisionRequired),
        playlistCandidates: playlistDecision.candidatePlaylists,
        selectedPlaylist: playlistDecision.selectedPlaylist || null,
        selectedTitleId: playlistDecision.selectedTitleId ?? null,
        waitingForManualPlaylistSelection: requiresManualPlaylistSelection,
        manualDecisionState: requiresManualPlaylistSelection
          ? 'waiting_for_manual_playlist_selection'
          : null
      }
    });

    if (requiresManualPlaylistSelection) {
      const playlistFiles = playlistDecision.candidatePlaylists
        .map((item) => item.playlistFile)
        .filter(Boolean);
      const recommendationFile = toPlaylistFile(playlistDecision.recommendation?.playlistId);
      await historyService.appendLog(
        jobId,
        'SYSTEM',
        `Playlist-Obfuscation erkannt. Status=waiting_for_manual_playlist_selection. Kandidaten: ${playlistFiles.join(', ') || 'keine'}.`
      );
      if (recommendationFile) {
        await historyService.appendLog(jobId, 'SYSTEM', `Empfehlung laut MakeMKV-TINFO-Analyse: ${recommendationFile}`);
      }
      await historyService.appendLog(
        jobId,
        'SYSTEM',
        'Bitte selected_playlist setzen (z.B. 00800 oder 00800.mpls), bevor Backup/Encoding gestartet wird.'
      );
      return historyService.getJobById(jobId);
    }

    if (playlistDecision.playlistDecisionRequired && playlistDecision.selectedPlaylist) {
      await historyService.appendLog(
        jobId,
        'SYSTEM',
        `Manuelle Playlist-Auswahl übernommen: ${toPlaylistFile(playlistDecision.selectedPlaylist) || playlistDecision.selectedPlaylist}`
      );
    }

    if (existingRawPath) {
      await historyService.appendLog(
        jobId,
        'SYSTEM',
        'Metadaten übernommen. Starte automatische Spur-Ermittlung (Mediainfo) mit vorhandenem RAW.'
      );
      const startResult = await this.startPreparedJob(jobId);
      logger.info('metadata:auto-track-review-started', {
        jobId,
        stage: startResult?.stage || null,
        reusedRaw: Boolean(startResult?.reusedRaw),
        selectedPlaylist: playlistDecision.selectedPlaylist || null,
        selectedTitleId: playlistDecision.selectedTitleId ?? null
      });
      return historyService.getJobById(jobId);
    }

    await historyService.appendLog(
      jobId,
      'SYSTEM',
      'Metadaten übernommen. Starte Backup/Rip automatisch.'
    );
    const startResult = await this.startPreparedJob(jobId);
    logger.info('metadata:auto-start', {
      jobId,
      stage: startResult?.stage || null,
      reusedRaw: Boolean(startResult?.reusedRaw),
      selectedPlaylist: playlistDecision.selectedPlaylist || null,
      selectedTitleId: playlistDecision.selectedTitleId ?? null
    });

    return historyService.getJobById(jobId);
  }

  async startPreparedJob(jobId) {
    this.ensureNotBusy('startPreparedJob');
    logger.info('startPreparedJob:requested', { jobId });

    const job = await historyService.getJobById(jobId);
    if (!job) {
      const error = new Error(`Job ${jobId} nicht gefunden.`);
      error.statusCode = 404;
      throw error;
    }

    if (!job.title && !job.detected_title) {
      const error = new Error('Start nicht möglich: keine Metadaten vorhanden.');
      error.statusCode = 400;
      throw error;
    }

    await historyService.resetProcessLog(jobId);

    const encodePlanForReadyState = this.safeParseJson(job.encode_plan_json);
    const readyMode = String(encodePlanForReadyState?.mode || '').trim().toLowerCase();
    const isPreRipReadyState = readyMode === 'pre_rip' || Boolean(encodePlanForReadyState?.preRip);
    const isReadyToEncode = job.status === 'READY_TO_ENCODE' || job.last_state === 'READY_TO_ENCODE';
    if (isReadyToEncode) {
      if (!Number(job.encode_review_confirmed || 0)) {
        const error = new Error('Encode-Start nicht erlaubt: Mediainfo-Prüfung muss zuerst bestätigt werden.');
        error.statusCode = 409;
        throw error;
      }

      if (isPreRipReadyState) {
        await historyService.updateJob(jobId, {
          status: 'RIPPING',
          last_state: 'RIPPING',
          error_message: null,
          end_time: null
        });

        this.startRipEncode(jobId).catch((error) => {
          logger.error('startPreparedJob:rip-background-failed', { jobId, error: errorToMeta(error) });
        });

        return { started: true, stage: 'RIPPING' };
      }

      await historyService.updateJob(jobId, {
        status: 'ENCODING',
        last_state: 'ENCODING',
        error_message: null,
        end_time: null
      });

      this.startEncodingFromPrepared(jobId).catch((error) => {
        logger.error('startPreparedJob:encode-background-failed', { jobId, error: errorToMeta(error) });
      });

      return { started: true, stage: 'ENCODING' };
    }

    const playlistDecision = this.resolvePlaylistDecisionForJob(jobId, job);
    const settings = await settingsService.getSettingsMap();
    const ripMode = String(settings.makemkv_rip_mode || 'mkv').trim().toLowerCase() === 'backup'
      ? 'backup'
      : 'mkv';
    const enforcePlaylistBeforeStart = ripMode !== 'backup';
    if (enforcePlaylistBeforeStart && playlistDecision.playlistDecisionRequired && playlistDecision.selectedTitleId === null) {
      const error = new Error(
        'Start nicht möglich: waiting_for_manual_playlist_selection aktiv. Bitte zuerst selected_playlist setzen.'
      );
      error.statusCode = 409;
      throw error;
    }

    let existingRawInput = null;
    if (job.raw_path) {
      try {
        if (fs.existsSync(job.raw_path)) {
          existingRawInput = findPreferredRawInput(job.raw_path, {
            playlistAnalysis: playlistDecision.playlistAnalysis,
            selectedPlaylistId: playlistDecision.selectedPlaylist
          });
        }
      } catch (error) {
        logger.warn('startPreparedJob:existing-raw-check-failed', {
          jobId,
          rawPath: job.raw_path,
          error: errorToMeta(error)
        });
      }
    }

    if (existingRawInput) {
      await historyService.updateJob(jobId, {
        status: 'MEDIAINFO_CHECK',
        last_state: 'MEDIAINFO_CHECK',
        start_time: nowIso(),
        end_time: null,
        error_message: null,
        output_path: null,
        handbrake_info_json: null,
        mediainfo_info_json: null,
        encode_plan_json: null,
        encode_input_path: null,
        encode_review_confirmed: 0
      });

      await historyService.appendLog(
        jobId,
        'SYSTEM',
        `Vorhandenes RAW wird verwendet. Starte Titel-/Spurprüfung: ${job.raw_path}`
      );

      this.runReviewForRawJob(jobId, job.raw_path, {
        mode: 'rip'
      }).catch((error) => {
        logger.error('startPreparedJob:review-background-failed', { jobId, error: errorToMeta(error) });
        this.failJob(jobId, 'MEDIAINFO_CHECK', error).catch((failError) => {
          logger.error('startPreparedJob:review-background-failJob-failed', {
            jobId,
            error: errorToMeta(failError)
          });
        });
      });

      return {
        started: true,
        stage: 'MEDIAINFO_CHECK',
        reusedRaw: true,
        rawPath: job.raw_path
      };
    }

    if (job.raw_path) {
      await historyService.appendLog(
        jobId,
        'SYSTEM',
        `Kein verwertbares RAW unter ${job.raw_path} gefunden. Starte neuen Rip.`
      );
    }

    await historyService.updateJob(jobId, {
      status: 'RIPPING',
      last_state: 'RIPPING',
      error_message: null,
      end_time: null,
      handbrake_info_json: null,
      mediainfo_info_json: null,
      encode_plan_json: null,
      encode_input_path: null,
      encode_review_confirmed: 0,
      output_path: null
    });

    this.startRipEncode(jobId).catch((error) => {
      logger.error('startPreparedJob:background-failed', { jobId, error: errorToMeta(error) });
    });

    return { started: true, stage: 'RIPPING' };
  }

  async confirmEncodeReview(jobId, options = {}) {
    this.ensureNotBusy('confirmEncodeReview');
    logger.info('confirmEncodeReview:requested', {
      jobId,
      selectedEncodeTitleId: options?.selectedEncodeTitleId ?? null,
      selectedTrackSelectionProvided: Boolean(options?.selectedTrackSelection)
    });

    const job = await historyService.getJobById(jobId);
    if (!job) {
      const error = new Error(`Job ${jobId} nicht gefunden.`);
      error.statusCode = 404;
      throw error;
    }

    if (job.status !== 'READY_TO_ENCODE' && job.last_state !== 'READY_TO_ENCODE') {
      const error = new Error('Bestätigung nicht möglich: Job ist nicht im Status READY_TO_ENCODE.');
      error.statusCode = 409;
      throw error;
    }

    const encodePlan = this.safeParseJson(job.encode_plan_json);
    if (!encodePlan || !Array.isArray(encodePlan.titles)) {
      const error = new Error('Bestätigung nicht möglich: keine Mediainfo-Auswertung vorhanden.');
      error.statusCode = 400;
      throw error;
    }

    const selectedEncodeTitleId = options?.selectedEncodeTitleId ?? null;
    const planWithSelectionResult = applyEncodeTitleSelectionToPlan(encodePlan, selectedEncodeTitleId);
    let planForConfirm = planWithSelectionResult.plan;
    const trackSelectionResult = applyManualTrackSelectionToPlan(
      planForConfirm,
      options?.selectedTrackSelection || null
    );
    planForConfirm = trackSelectionResult.plan;
    const confirmedMode = String(planForConfirm?.mode || encodePlan?.mode || 'rip').trim().toLowerCase();
    const isPreRipMode = confirmedMode === 'pre_rip' || Boolean(planForConfirm?.preRip);

    if (planForConfirm?.playlistDecisionRequired && !planForConfirm?.encodeInputPath && !planForConfirm?.encodeInputTitleId) {
      const error = new Error('Bestätigung nicht möglich: Bitte zuerst einen Titel per Checkbox auswählen.');
      error.statusCode = 400;
      throw error;
    }

    const confirmedPlan = {
      ...planForConfirm,
      reviewConfirmed: true,
      reviewConfirmedAt: nowIso()
    };
    const inputPath = isPreRipMode
      ? null
      : (job.encode_input_path || confirmedPlan.encodeInputPath || this.snapshot.context?.inputPath || null);
    const hasEncodableTitle = isPreRipMode
      ? Boolean(confirmedPlan?.encodeInputTitleId)
      : Boolean(inputPath);

    await historyService.updateJob(jobId, {
      encode_review_confirmed: 1,
      encode_plan_json: JSON.stringify(confirmedPlan),
      encode_input_path: inputPath
    });
    await historyService.appendLog(
      jobId,
      'USER_ACTION',
      `Mediainfo-Prüfung bestätigt.${isPreRipMode ? ' Backup/Rip darf gestartet werden.' : ' Encode darf gestartet werden.'}${confirmedPlan.encodeInputTitleId ? ` Gewählter Titel #${confirmedPlan.encodeInputTitleId}.` : ''}`
      + ` Audio-Spuren: ${trackSelectionResult.audioTrackIds.length > 0 ? trackSelectionResult.audioTrackIds.join(',') : 'none'}.`
      + ` Subtitle-Spuren: ${trackSelectionResult.subtitleTrackIds.length > 0 ? trackSelectionResult.subtitleTrackIds.join(',') : 'none'}.`
    );

    await this.setState('READY_TO_ENCODE', {
      activeJobId: jobId,
      progress: 0,
      eta: null,
      statusText: hasEncodableTitle
        ? (isPreRipMode
          ? 'Spurauswahl bestätigt - Backup/Rip + Encode manuell starten'
          : 'Mediainfo bestätigt - Encode manuell starten')
        : (isPreRipMode
          ? 'Spurauswahl bestätigt - kein passender Titel gewählt'
          : 'Mediainfo bestätigt - kein Titel erfüllt MIN_LENGTH_MINUTES'),
      context: {
        ...(this.snapshot.context || {}),
        jobId,
        inputPath,
        hasEncodableTitle,
        mediaInfoReview: confirmedPlan,
        reviewConfirmed: true
      }
    });

    return historyService.getJobById(jobId);
  }

  async reencodeFromRaw(sourceJobId) {
    this.ensureNotBusy('reencodeFromRaw');
    logger.info('reencodeFromRaw:requested', { sourceJobId });

    const sourceJob = await historyService.getJobById(sourceJobId);
    if (!sourceJob) {
      const error = new Error(`Quelle-Job ${sourceJobId} nicht gefunden.`);
      error.statusCode = 404;
      throw error;
    }

    if (!sourceJob.raw_path) {
      const error = new Error('Re-Encode nicht möglich: raw_path fehlt.');
      error.statusCode = 400;
      throw error;
    }

    if (['ANALYZING', 'RIPPING', 'MEDIAINFO_CHECK', 'ENCODING'].includes(sourceJob.status)) {
      const error = new Error('Re-Encode nicht möglich: Quelljob ist noch aktiv.');
      error.statusCode = 409;
      throw error;
    }

    const mkInfo = this.safeParseJson(sourceJob.makemkv_info_json);
    if (mkInfo && mkInfo.status && mkInfo.status !== 'SUCCESS') {
      const error = new Error(`Re-Encode nicht möglich: RAW-Rip ist nicht abgeschlossen (MakeMKV Status ${mkInfo.status}).`);
      error.statusCode = 400;
      throw error;
    }

    if (!fs.existsSync(sourceJob.raw_path)) {
      const error = new Error(`Re-Encode nicht möglich: RAW-Pfad existiert nicht (${sourceJob.raw_path}).`);
      error.statusCode = 400;
      throw error;
    }

    await historyService.resetProcessLog(sourceJobId);

    const rawInput = findPreferredRawInput(sourceJob.raw_path);
    if (!rawInput) {
      const error = new Error('Re-Encode nicht möglich: keine Datei im RAW-Pfad gefunden.');
      error.statusCode = 400;
      throw error;
    }

    const resetMakemkvInfoJson = (mkInfo && typeof mkInfo === 'object')
      ? JSON.stringify({
        ...mkInfo,
        analyzeContext: {
          ...(mkInfo?.analyzeContext || {}),
          selectedPlaylist: null,
          selectedTitleId: null
        }
      })
      : (sourceJob.makemkv_info_json || null);

    await historyService.updateJob(sourceJobId, {
      status: 'MEDIAINFO_CHECK',
      last_state: 'MEDIAINFO_CHECK',
      start_time: nowIso(),
      end_time: null,
      error_message: null,
      output_path: null,
      handbrake_info_json: null,
      mediainfo_info_json: null,
      encode_plan_json: null,
      encode_input_path: null,
      encode_review_confirmed: 0,
      makemkv_info_json: resetMakemkvInfoJson
    });
    await historyService.appendLog(
      sourceJobId,
      'USER_ACTION',
      `Re-Encode angefordert. Bestehender Job wird wiederverwendet. Input-Kandidat: ${rawInput.path}`
    );

    this.runReviewForRawJob(sourceJobId, sourceJob.raw_path, {
      mode: 'reencode',
      sourceJobId,
      forcePlaylistReselection: true
    }).catch((error) => {
      logger.error('reencodeFromRaw:background-failed', { jobId: sourceJobId, sourceJobId, error: errorToMeta(error) });
      this.failJob(sourceJobId, 'MEDIAINFO_CHECK', error).catch((failError) => {
        logger.error('reencodeFromRaw:background-failJob-failed', {
          jobId: sourceJobId,
          sourceJobId,
          error: errorToMeta(failError)
        });
      });
    });

    return {
      started: true,
      stage: 'MEDIAINFO_CHECK',
      sourceJobId,
      jobId: sourceJobId
    };
  }

  async runMediainfoForFile(jobId, inputPath) {
    const lines = [];
    const config = await settingsService.buildMediaInfoConfig(inputPath);
    logger.info('mediainfo:command', { jobId, inputPath, cmd: config.cmd, args: config.args });

    const runInfo = await this.runCommand({
      jobId,
      stage: 'MEDIAINFO_CHECK',
      source: 'MEDIAINFO',
      cmd: config.cmd,
      args: config.args,
      collectLines: lines,
      collectStderrLines: false
    });

    const parsed = parseMediainfoJsonOutput(lines.join('\n'));
    if (!parsed) {
      const error = new Error(`Mediainfo-Ausgabe konnte nicht als JSON gelesen werden (${path.basename(inputPath)}).`);
      error.runInfo = runInfo;
      throw error;
    }

    return {
      runInfo,
      parsed
    };
  }

  async runMediainfoReviewForJob(jobId, rawPath, options = {}) {
    this.ensureNotBusy('runMediainfoReviewForJob');
    logger.info('mediainfo:review:start', { jobId, rawPath, options });

    const job = await historyService.getJobById(jobId);
    if (!job) {
      const error = new Error(`Job ${jobId} nicht gefunden.`);
      error.statusCode = 404;
      throw error;
    }

    const settings = await settingsService.getSettingsMap();
    const mkInfo = this.safeParseJson(job.makemkv_info_json);
    const analyzeContext = mkInfo?.analyzeContext || {};
    const selectedPlaylistId = normalizePlaylistId(
      analyzeContext.selectedPlaylist
      || this.snapshot.context?.selectedPlaylist
      || null
    );
    const playlistAnalysis = analyzeContext.playlistAnalysis
      || this.snapshot.context?.playlistAnalysis
      || null;
    const preferredEncodeTitleIdRaw = Number(analyzeContext.selectedTitleId);
    const preferredEncodeTitleId = Number.isFinite(preferredEncodeTitleIdRaw) && preferredEncodeTitleIdRaw >= 0
      ? Math.trunc(preferredEncodeTitleIdRaw)
      : null;
    const rawMedia = collectRawMediaCandidates(rawPath, {
      playlistAnalysis,
      selectedPlaylistId
    });
    const mediaFiles = rawMedia.mediaFiles;
    if (mediaFiles.length === 0) {
      const error = new Error('Mediainfo-Prüfung nicht möglich: keine Datei im RAW-Pfad gefunden.');
      error.statusCode = 400;
      throw error;
    }
    await historyService.appendLog(
      jobId,
      'SYSTEM',
      `Mediainfo-Quelle: ${rawMedia.source} (${mediaFiles.length} Datei(en))`
    );
    let presetProfile = null;
    try {
      presetProfile = await settingsService.buildHandBrakePresetProfile(mediaFiles[0].path);
    } catch (error) {
      logger.warn('mediainfo:review:preset-profile-failed', {
        jobId,
        error: errorToMeta(error)
      });
      presetProfile = {
        source: 'fallback',
        message: `Preset-Profil konnte nicht geladen werden: ${error.message}`
      };
    }

    const selectedMetadata = {
      title: job.title || job.detected_title || null,
      year: job.year || null,
      imdbId: job.imdb_id || null,
      poster: job.poster_url || null
    };

    await this.setState('MEDIAINFO_CHECK', {
      activeJobId: jobId,
      progress: 0,
      eta: null,
      statusText: 'Mediainfo-Prüfung läuft',
      context: {
        jobId,
        rawPath,
        reviewConfirmed: false,
        mode: options.mode || 'rip',
        sourceJobId: options.sourceJobId || null,
        selectedMetadata
      }
    });

    await historyService.updateJob(jobId, {
      status: 'MEDIAINFO_CHECK',
      last_state: 'MEDIAINFO_CHECK'
    });

    const mediaInfoByPath = {};
    const mediaInfoRuns = [];
    const buildReviewSnapshot = (processedCount) => {
      const processedFiles = mediaFiles
        .slice(0, processedCount)
        .filter((item) => Boolean(mediaInfoByPath[item.path]));

      if (processedFiles.length === 0) {
        return null;
      }

      return {
        ...buildMediainfoReview({
          mediaFiles: processedFiles,
          mediaInfoByPath,
          settings,
          presetProfile,
          playlistAnalysis,
          preferredEncodeTitleId,
          selectedPlaylistId,
          selectedMakemkvTitleId: preferredEncodeTitleId
        }),
        mode: options.mode || 'rip',
        sourceJobId: options.sourceJobId || null,
        reviewConfirmed: false,
        partial: processedFiles.length < mediaFiles.length,
        processedFiles: processedFiles.length,
        totalFiles: mediaFiles.length
      };
    };

    for (let i = 0; i < mediaFiles.length; i += 1) {
      const file = mediaFiles[i];
      const percent = Number((((i + 1) / mediaFiles.length) * 100).toFixed(2));
      await this.updateProgress('MEDIAINFO_CHECK', percent, null, `Mediainfo ${i + 1}/${mediaFiles.length}: ${path.basename(file.path)}`);

      const result = await this.runMediainfoForFile(jobId, file.path);
      mediaInfoByPath[file.path] = result.parsed;
      mediaInfoRuns.push({
        filePath: file.path,
        runInfo: result.runInfo
      });

      const partialReview = buildReviewSnapshot(i + 1);
      await this.setState('MEDIAINFO_CHECK', {
        activeJobId: jobId,
        progress: percent,
        eta: null,
        statusText: `Mediainfo ${i + 1}/${mediaFiles.length} analysiert: ${path.basename(file.path)}`,
        context: {
          jobId,
          rawPath,
          inputPath: partialReview?.encodeInputPath || null,
          hasEncodableTitle: Boolean(partialReview?.encodeInputPath),
          reviewConfirmed: false,
          mode: options.mode || 'rip',
          sourceJobId: options.sourceJobId || null,
          mediaInfoReview: partialReview,
          selectedMetadata
        }
      });
    }

    const review = buildMediainfoReview({
      mediaFiles,
      mediaInfoByPath,
      settings,
      presetProfile,
      playlistAnalysis,
      preferredEncodeTitleId,
      selectedPlaylistId,
      selectedMakemkvTitleId: preferredEncodeTitleId
    });

    const enrichedReview = {
      ...review,
      mode: options.mode || 'rip',
      sourceJobId: options.sourceJobId || null,
      reviewConfirmed: false,
      partial: false,
      processedFiles: mediaFiles.length,
      totalFiles: mediaFiles.length
    };
    const hasEncodableTitle = Boolean(enrichedReview.encodeInputPath);
    const titleSelectionRequired = Boolean(enrichedReview.titleSelectionRequired);
    if (!hasEncodableTitle && !titleSelectionRequired) {
      enrichedReview.notes = [
        ...(Array.isArray(enrichedReview.notes) ? enrichedReview.notes : []),
        'Kein Titel erfüllt aktuell MIN_LENGTH_MINUTES. Bitte Konfiguration prüfen.'
      ];
    }

    await historyService.updateJob(jobId, {
      status: 'READY_TO_ENCODE',
      last_state: 'READY_TO_ENCODE',
      error_message: null,
      mediainfo_info_json: JSON.stringify({
        generatedAt: nowIso(),
        files: mediaInfoRuns
      }),
      encode_plan_json: JSON.stringify(enrichedReview),
      encode_input_path: enrichedReview.encodeInputPath || null,
      encode_review_confirmed: 0
    });

    await historyService.appendLog(
      jobId,
      'SYSTEM',
      `Mediainfo-Prüfung abgeschlossen: ${enrichedReview.titles.length} Titel, Input=${enrichedReview.encodeInputPath || (titleSelectionRequired ? 'Titelauswahl erforderlich' : 'kein passender Titel')}`
    );

    await this.setState('READY_TO_ENCODE', {
      activeJobId: jobId,
      progress: 0,
      eta: null,
      statusText: titleSelectionRequired
        ? 'Mediainfo geprüft - Titelauswahl per Checkbox erforderlich'
        : (hasEncodableTitle
        ? 'Mediainfo geprüft - Encode manuell starten'
        : 'Mediainfo geprüft - kein Titel erfüllt MIN_LENGTH_MINUTES'),
      context: {
        jobId,
        rawPath,
        inputPath: enrichedReview.encodeInputPath || null,
        hasEncodableTitle,
        reviewConfirmed: false,
        mode: options.mode || 'rip',
        sourceJobId: options.sourceJobId || null,
        mediaInfoReview: enrichedReview,
        selectedMetadata
      }
    });

    void this.notifyPushover('metadata_ready', {
      title: 'Ripster - Mediainfo geprüft',
      message: `Job #${jobId}: bereit zum manuellen Encode-Start`
    });

    return enrichedReview;
  }

  async startEncodingFromPrepared(jobId) {
    this.ensureNotBusy('startEncodingFromPrepared');
    logger.info('encode:start-from-prepared', { jobId });

    const settings = await settingsService.getSettingsMap();
    const movieDir = settings.movie_dir;
    ensureDir(movieDir);

    const job = await historyService.getJobById(jobId);
    if (!job) {
      const error = new Error(`Job ${jobId} nicht gefunden.`);
      error.statusCode = 404;
      throw error;
    }

    const encodePlan = this.safeParseJson(job.encode_plan_json);
    const mode = encodePlan?.mode || this.snapshot.context?.mode || 'rip';
    let inputPath = job.encode_input_path || encodePlan?.encodeInputPath || this.snapshot.context?.inputPath || null;

    if (!inputPath && job.raw_path) {
      const playlistDecision = this.resolvePlaylistDecisionForJob(jobId, job);
      inputPath = findPreferredRawInput(job.raw_path, {
        playlistAnalysis: playlistDecision.playlistAnalysis,
        selectedPlaylistId: playlistDecision.selectedPlaylist
      })?.path || null;
    }

    if (!inputPath) {
      const error = new Error('Encode-Start nicht möglich: kein Input-Pfad vorhanden.');
      error.statusCode = 400;
      throw error;
    }

    if (!fs.existsSync(inputPath)) {
      const error = new Error(`Encode-Start nicht möglich: Input-Datei fehlt (${inputPath}).`);
      error.statusCode = 400;
      throw error;
    }

    const preferredOutputPath = buildOutputPathFromJob(settings, job, jobId);
    const outputPath = ensureUniqueOutputPath(preferredOutputPath);
    const outputPathWithTimestamp = outputPath !== preferredOutputPath;
    ensureDir(path.dirname(outputPath));

    await this.setState('ENCODING', {
      activeJobId: jobId,
      progress: 0,
      eta: null,
      statusText: mode === 'reencode' ? 'Re-Encoding mit HandBrake' : 'Encoding mit HandBrake',
      context: {
        jobId,
        mode,
        inputPath,
        outputPath,
        reviewConfirmed: true,
        mediaInfoReview: encodePlan || null,
        selectedMetadata: {
          title: job.title || job.detected_title || null,
          year: job.year || null,
          imdbId: job.imdb_id || null,
          poster: job.poster_url || null
        }
      }
    });

    await historyService.updateJob(jobId, {
      status: 'ENCODING',
      last_state: 'ENCODING',
      output_path: outputPath,
      encode_input_path: inputPath
    });

    if (outputPathWithTimestamp) {
      await historyService.appendLog(
        jobId,
        'SYSTEM',
        `Output existierte bereits. Neuer Output-Pfad mit Timestamp: ${outputPath}`
      );
    }

    if (mode === 'reencode') {
      void this.notifyPushover('reencode_started', {
        title: 'Ripster - Re-Encode gestartet',
        message: `${job.title || job.detected_title || `Job #${jobId}`} -> ${outputPath}`
      });
    } else {
      void this.notifyPushover('encoding_started', {
        title: 'Ripster - Encoding gestartet',
        message: `${job.title || job.detected_title || `Job #${jobId}`} -> ${outputPath}`
      });
    }

    try {
      const trackSelection = extractHandBrakeTrackSelectionFromPlan(encodePlan, inputPath);
      let handBrakeTitleId = null;
      let directoryInput = false;
      try {
        if (fs.existsSync(inputPath) && fs.statSync(inputPath).isDirectory()) {
          directoryInput = true;
        }
      } catch (_error) {
        directoryInput = false;
        handBrakeTitleId = null;
      }
      if (directoryInput) {
        const reviewMappedTitleId = normalizeReviewTitleId(encodePlan?.handBrakeTitleId);
        if (reviewMappedTitleId) {
          handBrakeTitleId = reviewMappedTitleId;
          await historyService.appendLog(
            jobId,
            'SYSTEM',
            `HandBrake Titel-Mapping aus Vorbereitung übernommen: -t ${handBrakeTitleId}`
          );
        }
        const selectedPlaylistId = normalizePlaylistId(
          encodePlan?.selectedPlaylistId
          || (Array.isArray(encodePlan?.titles)
            ? (encodePlan.titles.find((title) => Boolean(title?.selectedForEncode))?.playlistId || null)
            : null)
          || this.snapshot.context?.selectedPlaylist
          || null
        );
        if (!handBrakeTitleId && selectedPlaylistId) {
          const titleResolveScanLines = [];
          const titleResolveScanConfig = await settingsService.buildHandBrakeScanConfigForInput(inputPath);
          logger.info('encoding:title-resolve-scan:command', {
            jobId,
            cmd: titleResolveScanConfig.cmd,
            args: titleResolveScanConfig.args,
            sourceArg: titleResolveScanConfig.sourceArg,
            selectedPlaylistId
          });
          const titleResolveRunInfo = await this.runCommand({
            jobId,
            stage: 'ENCODING',
            source: 'HANDBRAKE_SCAN_TITLE_RESOLVE',
            cmd: titleResolveScanConfig.cmd,
            args: titleResolveScanConfig.args,
            collectLines: titleResolveScanLines,
            collectStderrLines: false
          });
          const titleResolveParsed = parseMediainfoJsonOutput(titleResolveScanLines.join('\n'));
          if (!titleResolveParsed) {
            const error = new Error('HandBrake Scan-Ausgabe für Titel-Mapping konnte nicht als JSON gelesen werden.');
            error.runInfo = titleResolveRunInfo;
            throw error;
          }
          handBrakeTitleId = resolveHandBrakeTitleIdForPlaylist(titleResolveParsed, selectedPlaylistId);
          if (!handBrakeTitleId) {
            const error = new Error(`Kein HandBrake-Titel für Playlist ${selectedPlaylistId}.mpls gefunden.`);
            error.statusCode = 400;
            throw error;
          }
          await historyService.appendLog(
            jobId,
            'SYSTEM',
            `HandBrake Titel-Mapping: ${selectedPlaylistId}.mpls -> -t ${handBrakeTitleId}`
          );
        } else if (!handBrakeTitleId) {
          handBrakeTitleId = normalizeReviewTitleId(encodePlan?.handBrakeTitleId ?? encodePlan?.encodeInputTitleId);
        }
      }
      const handBrakeConfig = await settingsService.buildHandBrakeConfig(inputPath, outputPath, {
        trackSelection,
        titleId: handBrakeTitleId
      });
      if (trackSelection) {
        await historyService.appendLog(
          jobId,
          'SYSTEM',
          `HandBrake Track-Override: audio=${trackSelection.audioTrackIds.length > 0 ? trackSelection.audioTrackIds.join(',') : 'none'}, subtitles=${trackSelection.subtitleTrackIds.length > 0 ? trackSelection.subtitleTrackIds.join(',') : 'none'}, subtitle-burned=${trackSelection.subtitleBurnTrackId ?? 'none'}, subtitle-default=${trackSelection.subtitleDefaultTrackId ?? 'none'}, subtitle-forced=${trackSelection.subtitleForcedTrackId ?? (trackSelection.subtitleForcedOnly ? 'forced-only' : 'none')}`
        );
      }
      if (handBrakeTitleId) {
        await historyService.appendLog(
          jobId,
          'SYSTEM',
          `HandBrake Titel-Selektion aktiv: -t ${handBrakeTitleId}`
        );
      }
      logger.info('encoding:command', { jobId, cmd: handBrakeConfig.cmd, args: handBrakeConfig.args });
      const handbrakeInfo = await this.runCommand({
        jobId,
        stage: 'ENCODING',
        source: 'HANDBRAKE',
        cmd: handBrakeConfig.cmd,
        args: handBrakeConfig.args,
        parser: parseHandBrakeProgress
      });

      await historyService.updateJob(jobId, {
        handbrake_info_json: JSON.stringify(handbrakeInfo),
        status: 'FINISHED',
        last_state: 'FINISHED',
        end_time: nowIso(),
        output_path: outputPath,
        error_message: null
      });

      logger.info('encoding:finished', { jobId, mode, outputPath });

      await this.setState('FINISHED', {
        activeJobId: jobId,
        progress: 100,
        eta: null,
        statusText: mode === 'reencode' ? 'Re-Encode abgeschlossen' : 'Job abgeschlossen',
        context: {
          jobId,
          mode,
          outputPath
        }
      });

      if (mode === 'reencode') {
        void this.notifyPushover('reencode_finished', {
          title: 'Ripster - Re-Encode abgeschlossen',
          message: `${job.title || job.detected_title || `Job #${jobId}`} -> ${outputPath}`
        });
      } else {
        void this.notifyPushover('job_finished', {
          title: 'Ripster - Job abgeschlossen',
          message: `${job.title || job.detected_title || `Job #${jobId}`} -> ${outputPath}`
        });
      }

      setTimeout(async () => {
        if (this.snapshot.state === 'FINISHED' && this.snapshot.activeJobId === jobId) {
          await this.setState('IDLE', {
            activeJobId: null,
            progress: 0,
            eta: null,
            statusText: 'Bereit',
            context: {}
          });
        }
      }, 3000);
    } catch (error) {
      if (error.runInfo && error.runInfo.source === 'HANDBRAKE') {
        await historyService.updateJob(jobId, {
          handbrake_info_json: JSON.stringify(error.runInfo)
        });
      }
      logger.error('encode:start-from-prepared:failed', { jobId, mode, error: errorToMeta(error) });
      await this.failJob(jobId, 'ENCODING', error);
      throw error;
    }
  }

  async startRipEncode(jobId) {
    this.ensureNotBusy('startRipEncode');
    logger.info('ripEncode:start', { jobId });

    let job = await historyService.getJobById(jobId);
    if (!job) {
      const error = new Error(`Job ${jobId} nicht gefunden.`);
      error.statusCode = 404;
      throw error;
    }
    const preRipPlanBeforeRip = this.safeParseJson(job.encode_plan_json);
    const preRipModeBeforeRip = String(preRipPlanBeforeRip?.mode || '').trim().toLowerCase();
    const hasPreRipConfirmedSelection = (preRipModeBeforeRip === 'pre_rip' || Boolean(preRipPlanBeforeRip?.preRip))
      && Number(job.encode_review_confirmed || 0) === 1;
    const preRipTrackSelectionPayload = hasPreRipConfirmedSelection
      ? extractManualSelectionPayloadFromPlan(preRipPlanBeforeRip)
      : null;
    const playlistDecision = this.resolvePlaylistDecisionForJob(jobId, job);
    const selectedTitleId = playlistDecision.selectedTitleId;
    const selectedPlaylist = playlistDecision.selectedPlaylist;
    const selectedPlaylistFile = toPlaylistFile(selectedPlaylist);

    const settings = await settingsService.getSettingsMap();
    const rawBaseDir = settings.raw_dir;
    const ripMode = String(settings.makemkv_rip_mode || 'mkv').trim().toLowerCase() === 'backup'
      ? 'backup'
      : 'mkv';
    const effectiveSelectedTitleId = ripMode === 'mkv' ? (selectedTitleId ?? null) : null;
    const effectiveSelectedPlaylist = ripMode === 'mkv' ? (selectedPlaylist || null) : null;
    const effectiveSelectedPlaylistFile = ripMode === 'mkv' ? selectedPlaylistFile : null;
    const selectedPlaylistTitleInfo = ripMode === 'mkv' && Array.isArray(playlistDecision.playlistAnalysis?.titles)
      ? (playlistDecision.playlistAnalysis.titles.find((item) =>
        Number(item?.titleId) === Number(selectedTitleId)
      ) || null)
      : null;
    logger.info('rip:playlist-resolution', {
      jobId,
      ripMode,
      selectedPlaylist: effectiveSelectedPlaylistFile,
      selectedTitleId: effectiveSelectedTitleId,
      selectedTitleDurationSeconds: Number(selectedPlaylistTitleInfo?.durationSeconds || 0),
      selectedTitleDurationLabel: selectedPlaylistTitleInfo?.durationLabel || null
    });
    logger.debug('ripEncode:paths', { jobId, rawBaseDir });

    ensureDir(rawBaseDir);

    const metadataBase = sanitizeFileName(
      renderTemplate('${title} (${year}) [${imdbId}]', {
        title: job.title || job.detected_title || `job-${jobId}`,
        year: job.year || new Date().getFullYear(),
        imdbId: job.imdb_id || `job-${jobId}`
      })
    );
    const rawDirName = sanitizeFileName(`${metadataBase} - RAW - job-${jobId}`);
    const rawJobDir = path.join(rawBaseDir, rawDirName);
    ensureDir(rawJobDir);
    logger.info('rip:raw-dir-created', { jobId, rawJobDir });

    const device = this.detectedDisc || this.snapshot.context?.device || {
      path: job.disc_device,
      index: Number(settings.makemkv_source_index || 0)
    };
    const devicePath = device.path || null;

    await this.setState('RIPPING', {
      activeJobId: jobId,
      progress: 0,
      eta: null,
      statusText: ripMode === 'backup' ? 'Backup mit MakeMKV' : 'Ripping mit MakeMKV',
      context: {
        jobId,
        device,
        ripMode,
        playlistDecisionRequired: Boolean(playlistDecision.playlistDecisionRequired),
        playlistCandidates: playlistDecision.candidatePlaylists,
        selectedPlaylist: effectiveSelectedPlaylist,
        selectedTitleId: effectiveSelectedTitleId,
        preRipSelectionLocked: hasPreRipConfirmedSelection,
        selectedMetadata: {
          title: job.title || job.detected_title || null,
          year: job.year || null,
          imdbId: job.imdb_id || null,
          poster: job.poster_url || null
        }
      }
    });

    void this.notifyPushover('rip_started', {
      title: ripMode === 'backup' ? 'Ripster - Backup gestartet' : 'Ripster - Rip gestartet',
      message: `${job.title || job.detected_title || `Job #${jobId}`} (${device.path || 'disc'})`
    });

    await historyService.updateJob(jobId, {
      status: 'RIPPING',
      last_state: 'RIPPING',
      raw_path: rawJobDir,
      handbrake_info_json: null,
      mediainfo_info_json: null,
      encode_plan_json: null,
      encode_input_path: null,
      encode_review_confirmed: 0,
      output_path: null,
      error_message: null,
      end_time: null
    });
    job = await historyService.getJobById(jobId);

    let makemkvInfo = null;
    try {
      await this.ensureMakeMKVRegistration(jobId, 'RIPPING');

      const ripConfig = await settingsService.buildMakeMKVRipConfig(rawJobDir, device, {
        selectedTitleId: effectiveSelectedTitleId
      });
      logger.info('rip:command', {
        jobId,
        cmd: ripConfig.cmd,
        args: ripConfig.args,
        ripMode,
        selectedPlaylist: effectiveSelectedPlaylistFile,
        selectedTitleId: effectiveSelectedTitleId
      });
      if (ripMode === 'backup') {
        await historyService.appendLog(
          jobId,
          'SYSTEM',
          'Backup-Modus aktiv: MakeMKV erstellt 1:1 Backup ohne Titel-/Playlist-Einschränkungen.'
        );
      } else if (effectiveSelectedPlaylistFile) {
        await historyService.appendLog(
          jobId,
          'SYSTEM',
          `Manuelle Playlist-Auswahl aktiv: ${effectiveSelectedPlaylistFile} (Titel ${effectiveSelectedTitleId}).`
        );
        if (selectedPlaylistTitleInfo) {
          await historyService.appendLog(
            jobId,
            'SYSTEM',
            `Playlist-Auflösung: Titel ${effectiveSelectedTitleId} Dauer ${selectedPlaylistTitleInfo.durationLabel || `${selectedPlaylistTitleInfo.durationSeconds || 0}s`}.`
          );
        }
      } else if (playlistDecision.playlistDecisionRequired) {
        await historyService.appendLog(
          jobId,
          'SYSTEM',
          'Playlist-Obfuscation erkannt: Rip läuft ohne Vorauswahl. Finale Titelwahl erfolgt in der Mediainfo-Prüfung per Checkbox.'
        );
      }
      if (devicePath) {
        diskDetectionService.lockDevice(devicePath, {
          jobId,
          stage: 'RIPPING',
          source: 'MAKEMKV_RIP'
        });
      }
      try {
        makemkvInfo = await this.runCommand({
          jobId,
          stage: 'RIPPING',
          source: 'MAKEMKV_RIP',
          cmd: ripConfig.cmd,
          args: ripConfig.args,
          parser: parseMakeMkvProgress
        });
      } finally {
        if (devicePath) {
          diskDetectionService.unlockDevice(devicePath, {
            jobId,
            stage: 'RIPPING',
            source: 'MAKEMKV_RIP'
          });
        }
      }
      const mkInfoBeforeRip = this.safeParseJson(job.makemkv_info_json);
      await historyService.updateJob(jobId, {
        makemkv_info_json: JSON.stringify({
          ...makemkvInfo,
          analyzeContext: mkInfoBeforeRip?.analyzeContext || null
        })
      });

      const review = await this.runReviewForRawJob(jobId, rawJobDir, { mode: 'rip' });
      logger.info('rip:review-ready', {
        jobId,
        encodeInputPath: review.encodeInputPath,
        selectedTitleCount: Array.isArray(review.selectedTitleIds)
          ? review.selectedTitleIds.length
          : (Array.isArray(review.titles)
            ? review.titles.filter((item) => Boolean(item?.selectedForEncode)).length
            : 0)
      });
      if (hasPreRipConfirmedSelection && !review?.awaitingPlaylistSelection) {
        await historyService.appendLog(
          jobId,
          'SYSTEM',
          'Vorab bestätigte Spurauswahl erkannt. Übernehme Auswahl automatisch und starte Encode.'
        );
        await this.confirmEncodeReview(jobId, {
          selectedEncodeTitleId: review?.encodeInputTitleId || null,
          selectedTrackSelection: preRipTrackSelectionPayload || null
        });
        const autoStartResult = await this.startPreparedJob(jobId);
        logger.info('rip:auto-encode-started', {
          jobId,
          stage: autoStartResult?.stage || null
        });
      }
    } catch (error) {
      if (error.runInfo && error.runInfo.source === 'MAKEMKV_RIP') {
        const mkInfoBeforeRip = this.safeParseJson(job.makemkv_info_json);
        await historyService.updateJob(jobId, {
          makemkv_info_json: JSON.stringify({
            ...error.runInfo,
            analyzeContext: mkInfoBeforeRip?.analyzeContext || null
          })
        });
      }
      if (
        error.runInfo
        && [
          'MEDIAINFO',
          'HANDBRAKE_SCAN',
          'HANDBRAKE_SCAN_PLAYLIST_MAP',
          'HANDBRAKE_SCAN_SELECTED_TITLE',
          'MAKEMKV_ANALYZE_BACKUP'
        ].includes(error.runInfo.source)
      ) {
        await historyService.updateJob(jobId, {
          mediainfo_info_json: JSON.stringify({
            failedAt: nowIso(),
            runInfo: error.runInfo
          })
        });
      }
      logger.error('ripEncode:failed', { jobId, stage: this.snapshot.state, error: errorToMeta(error) });
      await this.failJob(jobId, this.snapshot.state, error);
      throw error;
    }
  }

  async retry(jobId) {
    this.ensureNotBusy('retry');
    logger.info('retry:start', { jobId });

    const job = await historyService.getJobById(jobId);
    if (!job) {
      const error = new Error(`Job ${jobId} nicht gefunden.`);
      error.statusCode = 404;
      throw error;
    }

    if (!job.title && !job.detected_title) {
      const error = new Error('Retry nicht möglich: keine Metadaten vorhanden.');
      error.statusCode = 400;
      throw error;
    }

    await historyService.resetProcessLog(jobId);

    await historyService.updateJob(jobId, {
      status: 'RIPPING',
      last_state: 'RIPPING',
      error_message: null,
      end_time: null,
      handbrake_info_json: null,
      mediainfo_info_json: null,
      encode_plan_json: null,
      encode_input_path: null,
      encode_review_confirmed: 0,
      output_path: null
    });

    this.startRipEncode(jobId).catch((error) => {
      logger.error('retry:background-failed', { jobId, error: errorToMeta(error) });
    });

    return { started: true };
  }

  async resumeReadyToEncodeJob(jobId) {
    this.ensureNotBusy('resumeReadyToEncodeJob');
    logger.info('resumeReadyToEncodeJob:requested', { jobId });

    const job = await historyService.getJobById(jobId);
    if (!job) {
      const error = new Error(`Job ${jobId} nicht gefunden.`);
      error.statusCode = 404;
      throw error;
    }

    const isReadyToEncode = job.status === 'READY_TO_ENCODE' || job.last_state === 'READY_TO_ENCODE';
    if (!isReadyToEncode) {
      const error = new Error(`Job ${jobId} ist nicht im Status READY_TO_ENCODE.`);
      error.statusCode = 409;
      throw error;
    }

    const encodePlan = this.safeParseJson(job.encode_plan_json);
    if (!encodePlan || !Array.isArray(encodePlan.titles)) {
      const error = new Error('READY_TO_ENCODE Job kann nicht geladen werden: encode_plan fehlt.');
      error.statusCode = 400;
      throw error;
    }

    const mode = String(encodePlan?.mode || 'rip').trim().toLowerCase();
    const isPreRipMode = mode === 'pre_rip' || Boolean(encodePlan?.preRip);
    const reviewConfirmed = Boolean(Number(job.encode_review_confirmed || 0) || encodePlan?.reviewConfirmed);
    const inputPath = isPreRipMode
      ? null
      : (job.encode_input_path || encodePlan?.encodeInputPath || null);
    const hasEncodableTitle = isPreRipMode
      ? Boolean(encodePlan?.encodeInputTitleId)
      : Boolean(inputPath);
    const selectedMetadata = {
      title: job.title || job.detected_title || null,
      year: job.year || null,
      imdbId: job.imdb_id || null,
      poster: job.poster_url || null
    };

    await this.setState('READY_TO_ENCODE', {
      activeJobId: jobId,
      progress: 0,
      eta: null,
      statusText: hasEncodableTitle
        ? (reviewConfirmed
          ? (isPreRipMode
            ? 'Spurauswahl geladen - Backup/Rip + Encode startbereit'
            : 'Mediainfo geladen - Encode startbereit')
          : (isPreRipMode
            ? 'Spurauswahl geladen - bitte bestätigen'
            : 'Mediainfo geladen - bitte bestätigen'))
        : (isPreRipMode
          ? 'Spurauswahl geladen - kein passender Titel gewählt'
          : 'Mediainfo geladen - kein Titel erfüllt MIN_LENGTH_MINUTES'),
      context: {
        ...(this.snapshot.context || {}),
        jobId,
        inputPath,
        hasEncodableTitle,
        reviewConfirmed,
        mode,
        sourceJobId: encodePlan?.sourceJobId || null,
        selectedMetadata,
        mediaInfoReview: encodePlan
      }
    });

    await historyService.appendLog(
      jobId,
      'USER_ACTION',
      'READY_TO_ENCODE Job nach Neustart ins Dashboard geladen.'
    );

    return historyService.getJobById(jobId);
  }

  async restartEncodeWithLastSettings(jobId) {
    this.ensureNotBusy('restartEncodeWithLastSettings');
    logger.info('restartEncodeWithLastSettings:requested', { jobId });

    const job = await historyService.getJobById(jobId);
    if (!job) {
      const error = new Error(`Job ${jobId} nicht gefunden.`);
      error.statusCode = 404;
      throw error;
    }

    const currentStatus = String(job.status || '').trim().toUpperCase();
    if (['ANALYZING', 'RIPPING', 'MEDIAINFO_CHECK'].includes(currentStatus)) {
      const error = new Error(`Encode-Neustart nicht möglich: Job ${jobId} ist noch aktiv (${currentStatus}).`);
      error.statusCode = 409;
      throw error;
    }

    const encodePlan = this.safeParseJson(job.encode_plan_json);
    if (!encodePlan || !Array.isArray(encodePlan.titles) || encodePlan.titles.length === 0) {
      const error = new Error('Encode-Neustart nicht möglich: encode_plan fehlt.');
      error.statusCode = 400;
      throw error;
    }

    const mode = String(encodePlan?.mode || 'rip').trim().toLowerCase();
    const isPreRipMode = mode === 'pre_rip' || Boolean(encodePlan?.preRip);
    const reviewConfirmed = Boolean(Number(job.encode_review_confirmed || 0) || encodePlan?.reviewConfirmed);
    if (!reviewConfirmed) {
      const error = new Error('Encode-Neustart nicht möglich: Spurauswahl wurde noch nicht bestätigt.');
      error.statusCode = 409;
      throw error;
    }

    const hasEncodableInput = isPreRipMode
      ? Boolean(encodePlan?.encodeInputTitleId)
      : Boolean(job.encode_input_path || encodePlan?.encodeInputPath || job.raw_path);
    if (!hasEncodableInput) {
      const error = new Error('Encode-Neustart nicht möglich: kein verwertbarer Encode-Input vorhanden.');
      error.statusCode = 400;
      throw error;
    }

    const settings = await settingsService.getSettingsMap();
    const restartDeleteIncompleteOutput = settings?.handbrake_restart_delete_incomplete_output !== undefined
      ? Boolean(settings.handbrake_restart_delete_incomplete_output)
      : true;
    const handBrakeInfo = this.safeParseJson(job.handbrake_info_json);
    const encodePreviouslySuccessful = String(handBrakeInfo?.status || '').trim().toUpperCase() === 'SUCCESS';
    const previousOutputPath = String(job.output_path || '').trim() || null;

    if (previousOutputPath && restartDeleteIncompleteOutput && !encodePreviouslySuccessful) {
      try {
        const deleteResult = await historyService.deleteJobFiles(jobId, 'movie');
        await historyService.appendLog(
          jobId,
          'USER_ACTION',
          `Encode-Neustart: unvollständigen Output vor Start entfernt (movie files=${deleteResult?.summary?.movie?.filesDeleted ?? 0}, dirs=${deleteResult?.summary?.movie?.dirsRemoved ?? 0}).`
        );
      } catch (error) {
        logger.warn('restartEncodeWithLastSettings:delete-incomplete-output-failed', {
          jobId,
          outputPath: previousOutputPath,
          error: errorToMeta(error)
        });
      }
    }

    await historyService.updateJob(jobId, {
      status: 'READY_TO_ENCODE',
      last_state: 'READY_TO_ENCODE',
      error_message: null,
      end_time: null,
      output_path: null,
      handbrake_info_json: null
    });
    await historyService.appendLog(
      jobId,
      'USER_ACTION',
      previousOutputPath
        ? `Encode-Neustart angefordert. Letzte bestätigte Auswahl wird verwendet. Vorheriger Output-Pfad: ${previousOutputPath}. autoDeleteIncomplete=${restartDeleteIncompleteOutput ? 'on' : 'off'}`
        : 'Encode-Neustart angefordert. Letzte bestätigte Auswahl wird verwendet.'
    );

    const result = await this.startPreparedJob(jobId);
    return {
      restarted: true,
      ...result
    };
  }

  async cancel() {
    if (!this.activeProcess) {
      const error = new Error('Kein laufender Prozess zum Abbrechen.');
      error.statusCode = 409;
      throw error;
    }

    logger.warn('cancel:requested', {
      state: this.snapshot.state,
      activeJobId: this.snapshot.activeJobId
    });
    this.cancelRequested = true;
    this.activeProcess.cancel();
  }

  async runCommand({
    jobId,
    stage,
    source,
    cmd,
    args,
    parser,
    collectLines = null,
    collectStdoutLines = true,
    collectStderrLines = true,
    argsForLog = null
  }) {
    const loggableArgs = Array.isArray(argsForLog) ? argsForLog : args;
    await historyService.appendLog(jobId, 'SYSTEM', `Spawn ${cmd} ${loggableArgs.join(' ')}`);
    logger.info('command:spawn', { jobId, stage, source, cmd, args: loggableArgs });

    const runInfo = {
      source,
      stage,
      cmd,
      args: loggableArgs,
      startedAt: nowIso(),
      endedAt: null,
      durationMs: null,
      status: 'RUNNING',
      exitCode: null,
      stdoutLines: 0,
      stderrLines: 0,
      lastProgress: 0,
      eta: null,
      lastDetail: null,
      highlights: []
    };

    const applyLine = (line, isStderr) => {
      const text = truncateLine(line, 400);
      if (isStderr) {
        runInfo.stderrLines += 1;
      } else {
        runInfo.stdoutLines += 1;
      }

      const detail = extractProgressDetail(source, text);
      if (detail) {
        runInfo.lastDetail = detail;
      }

      if (runInfo.highlights.length < 120 && shouldKeepHighlight(text)) {
        runInfo.highlights.push(text);
      }

      if (parser) {
        const progress = parser(text);
        if (progress && progress.percent !== null) {
          runInfo.lastProgress = progress.percent;
          runInfo.eta = progress.eta || runInfo.eta;
          const statusText = composeStatusText(stage, progress.percent, runInfo.lastDetail);
          void this.updateProgress(stage, progress.percent, progress.eta, statusText);
        } else if (detail) {
          const statusText = composeStatusText(
            stage,
            Number(this.snapshot.progress || 0),
            runInfo.lastDetail
          );
          void this.updateProgress(
            stage,
            Number(this.snapshot.progress || 0),
            this.snapshot.eta,
            statusText
          );
        }
      }
    };

    this.cancelRequested = false;
    const processHandle = spawnTrackedProcess({
      cmd,
      args,
      context: { jobId, stage, source },
      onStdoutLine: (line) => {
        if (collectLines && collectStdoutLines) {
          collectLines.push(line);
        }
        void historyService.appendProcessLog(jobId, source, line);
        applyLine(line, false);
      },
      onStderrLine: (line) => {
        if (collectLines && collectStderrLines) {
          collectLines.push(line);
        }
        void historyService.appendProcessLog(jobId, `${source}_ERR`, line);
        applyLine(line, true);
      }
    });

    this.activeProcess = processHandle;

    try {
      const procResult = await processHandle.promise;
      runInfo.status = 'SUCCESS';
      runInfo.exitCode = procResult.code;
      runInfo.endedAt = nowIso();
      runInfo.durationMs = new Date(runInfo.endedAt).getTime() - new Date(runInfo.startedAt).getTime();
      await historyService.appendLog(jobId, 'SYSTEM', `${source} abgeschlossen.`);
      logger.info('command:completed', { jobId, stage, source });
      return runInfo;
    } catch (error) {
      if (this.cancelRequested) {
        const cancelError = new Error('Job wurde vom Benutzer abgebrochen.');
        cancelError.statusCode = 409;
        runInfo.status = 'CANCELLED';
        runInfo.exitCode = null;
        runInfo.endedAt = nowIso();
        runInfo.durationMs = new Date(runInfo.endedAt).getTime() - new Date(runInfo.startedAt).getTime();
        cancelError.runInfo = runInfo;
        logger.warn('command:cancelled', { jobId, stage, source });
        throw cancelError;
      }
      runInfo.status = 'ERROR';
      runInfo.exitCode = error.code ?? null;
      runInfo.endedAt = nowIso();
      runInfo.durationMs = new Date(runInfo.endedAt).getTime() - new Date(runInfo.startedAt).getTime();
      runInfo.errorMessage = error.message;
      error.runInfo = runInfo;
      logger.error('command:failed', { jobId, stage, source, error: errorToMeta(error) });
      throw error;
    } finally {
      await historyService.closeProcessLog(jobId);
      this.activeProcess = null;
      this.cancelRequested = false;
    }
  }

  async failJob(jobId, stage, error) {
    const message = error?.message || String(error);
    const isCancelled = /abgebrochen/i.test(message);
    const job = await historyService.getJobById(jobId);
    const title = job?.title || job?.detected_title || `Job #${jobId}`;
    logger.error('job:failed', { jobId, stage, error: errorToMeta(error) });
    await historyService.updateJob(jobId, {
      status: 'ERROR',
      last_state: 'ERROR',
      end_time: nowIso(),
      error_message: message
    });
    await historyService.appendLog(jobId, 'SYSTEM', `Fehler in ${stage}: ${message}`);

    await this.setState('ERROR', {
      activeJobId: jobId,
      progress: this.snapshot.progress,
      eta: null,
      statusText: message,
      context: {
        jobId,
        stage,
        error: message
      }
    });

    void this.notifyPushover(isCancelled ? 'job_cancelled' : 'job_error', {
      title: isCancelled ? 'Ripster - Job abgebrochen' : 'Ripster - Job Fehler',
      message: `${title} (${stage}): ${message}`
    });
  }

}

module.exports = new PipelineService();
