'use strict';

const TITLE_KIND = Object.freeze({
  EPISODE_CANDIDATE: 'episode_candidate',
  PLAY_ALL: 'play_all',
  EXTRA: 'extra',
  DUPLICATE: 'duplicate',
  SHORT: 'short',
  UNKNOWN: 'unknown'
});

const DEFAULTS = Object.freeze({
  minEpisodeMinutes: 18,
  maxEpisodeMinutes: 75,
  minChapterCount: 3,
  shortTitleMinutes: 5
});

function nowIso() {
  return new Date().toISOString();
}

function parseDurationToSeconds(rawValue) {
  const text = String(rawValue || '').trim();
  const match = text.match(/^(\d{1,2}):(\d{2}):(\d{2})$/);
  if (!match) {
    return 0;
  }
  return (Number(match[1]) * 3600) + (Number(match[2]) * 60) + Number(match[3]);
}

function roundToStep(value, step) {
  const num = Number(value);
  if (!Number.isFinite(num) || step <= 0) {
    return 0;
  }
  return Math.round(num / step) * step;
}

function median(values = []) {
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

function normalizeLanguageCode(rawCode, fallbackLabel = null) {
  const raw = String(rawCode || '').trim().toLowerCase();
  if (raw && raw.length === 3) {
    return raw;
  }
  const label = String(fallbackLabel || '').trim().toLowerCase();
  if (label.startsWith('de')) return 'deu';
  if (label.startsWith('en')) return 'eng';
  if (label.startsWith('fr')) return 'fra';
  if (label.startsWith('es')) return 'spa';
  if (label.startsWith('nl')) return 'nld';
  return raw || 'und';
}

function normalizeSeriesLookupTitle(rawValue) {
  return String(rawValue || '')
    .replace(/[_./]+/g, ' ')
    .replace(/\bs\d{1,2}\s*d\d{1,2}\b/gi, ' ')
    .replace(/\bs(?:taffel|eason)?\s*\d{1,2}\s*(?:disc|dvd|cd|d)\s*\d{1,2}\b/gi, ' ')
    .replace(/\b(?:disc|dvd|cd)\s*\d+\b/gi, ' ')
    .replace(/\b(?:s(?:taffel|eason)?|season)\s*\d+\b/gi, ' ')
    .replace(/\b\d{1,2}x\b/gi, ' ')
    .replace(/\b(?:complete|collection|boxset)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function deriveSeriesLookupHint(inputs = []) {
  const normalizedInputs = (Array.isArray(inputs) ? inputs : [inputs])
    .map((entry) => {
      if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
        return {
          value: String(entry.value || '').trim(),
          source: String(entry.source || '').trim() || 'unknown'
        };
      }
      return {
        value: String(entry || '').trim(),
        source: 'unknown'
      };
    })
    .filter((entry) => entry.value);

  for (const entry of normalizedInputs) {
    const compactValue = entry.value.replace(/[_./]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (!compactValue) {
      continue;
    }

    const compactSeasonDiscMatch = compactValue.match(
      /(?:^|\s)s(?:taffel|eason)?\s*0?(\d{1,2})\s*(?:d|disc|dvd|cd)\s*0?(\d{1,2})(?=\s|$)/i
    );
    const seasonMatch = compactSeasonDiscMatch
      || compactValue.match(/(?:^|\s)(?:s(?:taffel|eason)?|season)\s*(\d{1,2})(?=\s|$)/i)
      || compactValue.match(/(?:^|\s)s\s*0?(\d{1,2})(?=\s|$)/i)
      || compactValue.match(/(?:^|\s)(\d{1,2})x(?=\s|$)/i);
    if (!seasonMatch) {
      continue;
    }

    const seasonNumber = Number(seasonMatch[1] || 0);
    if (!Number.isFinite(seasonNumber) || seasonNumber <= 0) {
      continue;
    }

    const discMatch = compactSeasonDiscMatch
      || compactValue.match(/(?:^|\s)(?:disc|dvd|cd|d)\s*0?(\d{1,2})(?=\s|$)/i);
    const compactDiscToken = compactSeasonDiscMatch ? compactSeasonDiscMatch[2] : null;
    const discNumber = discMatch
      ? Number(compactDiscToken || discMatch[1] || 0) || null
      : null;

    const baseTitle = normalizeSeriesLookupTitle(compactValue);
    if (!baseTitle) {
      continue;
    }

    return {
      query: baseTitle,
      seriesTitle: baseTitle,
      seasonNumber,
      discNumber,
      source: entry.source,
      sourceLabel: entry.value,
      confidence: discNumber ? 'high' : 'medium'
    };
  }

  return null;
}

function normalizeTitleRecord(title = {}) {
  const durationSeconds = Number(title.durationSeconds || 0);
  const chapterCount = Number(title.chapterCount || 0);
  const roundedDurationBucket = roundToStep(durationSeconds, 30);
  const audioLanguages = (Array.isArray(title.audioTracks) ? title.audioTracks : [])
    .map((track) => normalizeLanguageCode(track?.languageCode, track?.languageLabel))
    .filter(Boolean)
    .sort();
  const subtitleLanguages = (Array.isArray(title.subtitleTracks) ? title.subtitleTracks : [])
    .map((track) => normalizeLanguageCode(track?.languageCode, track?.languageLabel))
    .filter(Boolean)
    .sort();

  return {
    index: Number(title.index || 0),
    durationSeconds,
    durationLabel: String(title.durationLabel || '').trim() || null,
    chapterCount,
    chapterDurationsMs: Array.isArray(title.chapterDurationsMs) ? title.chapterDurationsMs : [],
    aspectRatio: String(title.aspectRatio || '').trim() || null,
    audioTracks: Array.isArray(title.audioTracks) ? title.audioTracks : [],
    subtitleTracks: Array.isArray(title.subtitleTracks) ? title.subtitleTracks : [],
    flags: Array.isArray(title.flags) ? title.flags : [],
    roundedDurationBucket,
    signature: JSON.stringify({
      duration: roundedDurationBucket,
      chapterCount,
      audioLanguages,
      subtitleLanguages
    })
  };
}

function buildBestEpisodeCluster(titles = [], options = {}) {
  const minEpisodeSeconds = Math.max(60, Math.round(Number(options.minEpisodeMinutes || DEFAULTS.minEpisodeMinutes) * 60));
  const maxEpisodeSeconds = Math.max(minEpisodeSeconds, Math.round(Number(options.maxEpisodeMinutes || DEFAULTS.maxEpisodeMinutes) * 60));
  const minChapterCount = Math.max(1, Number(options.minChapterCount || DEFAULTS.minChapterCount));
  const candidates = titles.filter((title) =>
    title.durationSeconds >= minEpisodeSeconds
    && title.durationSeconds <= maxEpisodeSeconds
    && title.chapterCount >= minChapterCount
  );

  if (candidates.length === 0) {
    return {
      titles: [],
      medianDurationSeconds: 0,
      medianChapterCount: 0
    };
  }

  let bestCluster = [];
  for (const anchor of candidates) {
    const durationTolerance = Math.max(90, Math.round(anchor.durationSeconds * 0.12));
    const cluster = candidates.filter((candidate) => {
      const durationGap = Math.abs(candidate.durationSeconds - anchor.durationSeconds);
      const chapterGap = Math.abs(candidate.chapterCount - anchor.chapterCount);
      return durationGap <= durationTolerance && chapterGap <= 2;
    });

    if (cluster.length > bestCluster.length) {
      bestCluster = cluster;
      continue;
    }
    if (cluster.length === bestCluster.length) {
      const clusterMedian = median(cluster.map((item) => item.durationSeconds));
      const bestMedian = median(bestCluster.map((item) => item.durationSeconds));
      if (clusterMedian > bestMedian) {
        bestCluster = cluster;
      }
    }
  }

  return {
    titles: bestCluster,
    medianDurationSeconds: median(bestCluster.map((item) => item.durationSeconds)),
    medianChapterCount: median(bestCluster.map((item) => item.chapterCount))
  };
}

function classifyTitles(titles = [], cluster = {}, options = {}) {
  const shortTitleSeconds = Math.max(60, Math.round(Number(options.shortTitleMinutes || DEFAULTS.shortTitleMinutes) * 60));
  const clusterTitleIds = new Set((cluster.titles || []).map((item) => Number(item.index)));
  const duplicateFirstBySignature = new Map();

  for (const title of titles) {
    if (!duplicateFirstBySignature.has(title.signature)) {
      duplicateFirstBySignature.set(title.signature, title.index);
    }
  }

  const playAllCandidate = (() => {
    if (!Array.isArray(cluster.titles) || cluster.titles.length < 2 || !cluster.medianDurationSeconds) {
      return null;
    }
    const minPlayAllSeconds = cluster.medianDurationSeconds * Math.max(2, cluster.titles.length - 1);
    return titles
      .filter((title) =>
        !clusterTitleIds.has(Number(title.index))
        && title.durationSeconds >= minPlayAllSeconds * 0.75
        && title.chapterCount >= Math.max(6, Math.round(cluster.medianChapterCount * cluster.titles.length * 0.6))
      )
      .sort((left, right) => right.durationSeconds - left.durationSeconds)[0] || null;
  })();

  return titles.map((title) => {
    const isFirstWithSignature = duplicateFirstBySignature.get(title.signature) === title.index;
    const isShort = title.durationSeconds > 0 && title.durationSeconds <= shortTitleSeconds;
    const isEpisodeCandidate = clusterTitleIds.has(Number(title.index));
    const isPlayAll = playAllCandidate && Number(playAllCandidate.index) === Number(title.index);
    const kind = isPlayAll
      ? TITLE_KIND.PLAY_ALL
      : isEpisodeCandidate
        ? TITLE_KIND.EPISODE_CANDIDATE
        : !isFirstWithSignature
          ? TITLE_KIND.DUPLICATE
          : isShort
            ? TITLE_KIND.SHORT
            : (title.durationSeconds > 0 ? TITLE_KIND.EXTRA : TITLE_KIND.UNKNOWN);

    let confidence = 0.2;
    if (kind === TITLE_KIND.EPISODE_CANDIDATE) confidence = 0.8;
    if (kind === TITLE_KIND.PLAY_ALL) confidence = 0.95;
    if (kind === TITLE_KIND.DUPLICATE) confidence = 0.85;
    if (kind === TITLE_KIND.SHORT) confidence = 0.9;
    if (kind === TITLE_KIND.EXTRA) confidence = 0.55;

    return {
      ...title,
      kind,
      confidence,
      duplicateOfTitleIndex: kind === TITLE_KIND.DUPLICATE
        ? duplicateFirstBySignature.get(title.signature)
        : null
    };
  });
}

function buildDiscSignature(parsedScan = {}) {
  return JSON.stringify({
    discTitle: String(parsedScan.discTitle || '').trim() || null,
    discSerial: String(parsedScan.discSerial || '').trim() || null,
    titleCount: Number(parsedScan.titleCount || 0),
    durations: (Array.isArray(parsedScan.titles) ? parsedScan.titles : [])
      .map((title) => ({
        index: Number(title.index || 0),
        durationBucket: roundToStep(title.durationSeconds || 0, 30),
        chapterCount: Number(title.chapterCount || 0)
      }))
  });
}

function summarizeSeriesLikelihood(classifiedTitles = [], cluster = {}) {
  const episodeCount = classifiedTitles.filter((title) => title.kind === TITLE_KIND.EPISODE_CANDIDATE).length;
  const playAllCount = classifiedTitles.filter((title) => title.kind === TITLE_KIND.PLAY_ALL).length;
  const duplicateCount = classifiedTitles.filter((title) => title.kind === TITLE_KIND.DUPLICATE).length;
  const extrasCount = classifiedTitles.filter((title) => title.kind === TITLE_KIND.EXTRA).length;

  const reasons = [];
  let confidence = 'low';
  let seriesLike = false;

  if (episodeCount >= 3) {
    seriesLike = true;
    confidence = playAllCount > 0 ? 'high' : 'medium';
    reasons.push(`${episodeCount} ähnlich lange Episodenkandidaten erkannt.`);
  } else if (episodeCount === 2) {
    seriesLike = true;
    confidence = 'medium';
    reasons.push('Mindestens zwei ähnlich lange Episodenkandidaten erkannt.');
  }

  if (playAllCount > 0) {
    reasons.push('Ein langer Play-All-Titel wurde erkannt.');
  }
  if (duplicateCount > 0) {
    reasons.push(`${duplicateCount} alternative/duplizierte Titel gefunden.`);
  }
  if (cluster.medianDurationSeconds > 0) {
    reasons.push(`Typische Episodenlänge ca. ${Math.round(cluster.medianDurationSeconds / 60)} Minuten.`);
  }
  if (extrasCount > 0) {
    reasons.push(`${extrasCount} Titel als Extras oder Sonderfälle klassifiziert.`);
  }

  return {
    seriesLike,
    confidence,
    reasons
  };
}

function parseHandBrakeScanText(rawOutput) {
  const lines = String(rawOutput || '').split(/\r?\n/);
  const parsed = {
    source: 'handbrake_scan_text',
    generatedAt: nowIso(),
    discTitle: null,
    discSerial: null,
    titleCount: 0,
    rawLineCount: lines.length,
    titles: []
  };

  let currentTitle = null;
  const ensureCurrentTitle = (index) => {
    const normalizedIndex = Number(index);
    if (!Number.isFinite(normalizedIndex) || normalizedIndex <= 0) {
      return null;
    }
    if (currentTitle && Number(currentTitle.index) === normalizedIndex) {
      return currentTitle;
    }
    const existing = parsed.titles.find((title) => Number(title.index) === normalizedIndex);
    if (existing) {
      currentTitle = existing;
      return currentTitle;
    }
    currentTitle = {
      index: normalizedIndex,
      durationLabel: null,
      durationSeconds: 0,
      chapterCount: 0,
      chapterDurationsMs: [],
      audioTracks: [],
      subtitleTracks: [],
      aspectRatio: null,
      flags: []
    };
    parsed.titles.push(currentTitle);
    return currentTitle;
  };

  for (const line of lines) {
    let match = line.match(/libdvdnav:\s+DVD Title:\s+(.+)\s*$/i);
    if (match) {
      parsed.discTitle = String(match[1] || '').trim() || null;
      continue;
    }

    match = line.match(/libdvdnav:\s+DVD Serial Number:\s+(.+)\s*$/i);
    if (match) {
      parsed.discSerial = String(match[1] || '').trim() || null;
      continue;
    }

    match = line.match(/scan:\s+DVD has\s+(\d+)\s+title/i);
    if (match) {
      parsed.titleCount = Number(match[1] || 0);
      continue;
    }
    match = line.match(/scan:\s+(?:BD|Blu-?ray)\s+has\s+(\d+)\s+title/i);
    if (match) {
      parsed.titleCount = Number(match[1] || 0);
      continue;
    }

    match = line.match(/scan:\s+scanning title\s+(\d+)/i);
    if (match) {
      ensureCurrentTitle(match[1]);
      continue;
    }
    match = line.match(/^\s*\+\s+title\s+(\d+):/i);
    if (match) {
      ensureCurrentTitle(match[1]);
      continue;
    }

    match = line.match(/scan:\s+duration is\s+(\d{1,2}:\d{2}:\d{2})/i);
    if (match && currentTitle) {
      currentTitle.durationLabel = match[1];
      currentTitle.durationSeconds = parseDurationToSeconds(match[1]);
      continue;
    }
    match = line.match(/^\s*\+\s+duration:\s+(\d{1,2}:\d{2}:\d{2})/i);
    if (match && currentTitle) {
      currentTitle.durationLabel = match[1];
      currentTitle.durationSeconds = parseDurationToSeconds(match[1]);
      continue;
    }

    match = line.match(/scan:\s+title\s+(\d+)\s+has\s+(\d+)\s+chapters/i);
    if (match) {
      const title = ensureCurrentTitle(match[1]);
      if (title) {
        title.chapterCount = Number(match[2] || 0);
      }
      continue;
    }
    match = line.match(/^\s*\+\s+chapters:\s+(\d+)/i);
    if (match && currentTitle) {
      currentTitle.chapterCount = Number(match[1] || 0);
      continue;
    }

    match = line.match(/scan:\s+chap\s+\d+,\s+(\d+)\s+ms/i);
    if (match && currentTitle) {
      currentTitle.chapterDurationsMs.push(Number(match[1] || 0));
      continue;
    }

    match = line.match(/scan:\s+id=0x[0-9a-f]+,\s+lang=(.+?)\s+\([^)]+\),\s+3cc=([a-z]{3})/i);
    if (match && currentTitle) {
      const track = {
        languageLabel: String(match[1] || '').trim() || null,
        languageCode: normalizeLanguageCode(match[2], match[1])
      };
      if (/\[VOBSUB\]/i.test(line)) {
        currentTitle.subtitleTracks.push(track);
      } else {
        currentTitle.audioTracks.push(track);
      }
      continue;
    }

    match = line.match(/scan:\s+aspect\s+=\s+(.+)$/i);
    if (match && currentTitle) {
      currentTitle.aspectRatio = String(match[1] || '').trim() || null;
      continue;
    }

    match = line.match(/scan:\s+ignoring title \(too short\)/i);
    if (match && currentTitle) {
      currentTitle.flags.push('ignored_too_short');
    }
  }

  parsed.titles.sort((left, right) => Number(left.index || 0) - Number(right.index || 0));
  if (!parsed.titleCount) {
    parsed.titleCount = parsed.titles.length;
  }
  return parsed;
}

function analyzeParsedScan(parsedScan = {}, options = {}) {
  const titles = (Array.isArray(parsedScan.titles) ? parsedScan.titles : []).map(normalizeTitleRecord);
  const cluster = buildBestEpisodeCluster(titles, options);
  const classifiedTitles = classifyTitles(titles, cluster, options);
  const summary = summarizeSeriesLikelihood(classifiedTitles, cluster);

  return {
    source: parsedScan.source || 'handbrake_scan_text',
    generatedAt: nowIso(),
    discTitle: parsedScan.discTitle || null,
    discSerial: parsedScan.discSerial || null,
    titleCount: Number(parsedScan.titleCount || titles.length || 0),
    discSignature: buildDiscSignature({
      discTitle: parsedScan.discTitle,
      discSerial: parsedScan.discSerial,
      titleCount: parsedScan.titleCount,
      titles
    }),
    summary: {
      ...summary,
      titleCount: classifiedTitles.length,
      episodeCandidateCount: classifiedTitles.filter((title) => title.kind === TITLE_KIND.EPISODE_CANDIDATE).length,
      playAllCount: classifiedTitles.filter((title) => title.kind === TITLE_KIND.PLAY_ALL).length,
      duplicateCount: classifiedTitles.filter((title) => title.kind === TITLE_KIND.DUPLICATE).length,
      extraCount: classifiedTitles.filter((title) => title.kind === TITLE_KIND.EXTRA).length,
      typicalEpisodeMinutes: cluster.medianDurationSeconds
        ? Number((cluster.medianDurationSeconds / 60).toFixed(2))
        : 0
    },
    titles: classifiedTitles
  };
}

function analyzeHandBrakeScan(rawOutput, options = {}) {
  const parsed = parseHandBrakeScanText(rawOutput);
  const analysis = analyzeParsedScan(parsed, options);
  return {
    parsed,
    analysis
  };
}

module.exports = {
  TITLE_KIND,
  parseHandBrakeScanText,
  analyzeParsedScan,
  analyzeHandBrakeScan,
  deriveSeriesLookupHint
};
