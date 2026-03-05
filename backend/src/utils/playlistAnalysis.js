const LARGE_JUMP_THRESHOLD = 20;
const DEFAULT_DURATION_SIMILARITY_SECONDS = 90;

function parseDurationSeconds(raw) {
  const text = String(raw || '').trim();
  if (!text) {
    return 0;
  }

  const hms = text.match(/^(\d{1,2}):(\d{2}):(\d{2})(?:\.\d+)?$/);
  if (hms) {
    const h = Number(hms[1]);
    const m = Number(hms[2]);
    const s = Number(hms[3]);
    return (h * 3600) + (m * 60) + s;
  }

  const hm = text.match(/^(\d{1,2}):(\d{2})(?:\.\d+)?$/);
  if (hm) {
    const m = Number(hm[1]);
    const s = Number(hm[2]);
    return (m * 60) + s;
  }

  const asNumber = Number(text);
  if (Number.isFinite(asNumber) && asNumber > 0) {
    return Math.round(asNumber);
  }

  return 0;
}

function formatDuration(seconds) {
  const total = Number(seconds || 0);
  if (!Number.isFinite(total) || total <= 0) {
    return '-';
  }

  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function parseSizeBytes(raw) {
  const text = String(raw || '').trim();
  if (!text) {
    return 0;
  }

  if (/^\d+$/.test(text)) {
    const direct = Number(text);
    return Number.isFinite(direct) ? Math.max(0, Math.round(direct)) : 0;
  }

  const match = text.match(/([\d.]+)\s*(B|KB|MB|GB|TB)/i);
  if (!match) {
    return 0;
  }

  const value = Number(match[1]);
  if (!Number.isFinite(value)) {
    return 0;
  }

  const unit = String(match[2] || '').toUpperCase();
  const factorByUnit = {
    B: 1,
    KB: 1024,
    MB: 1024 ** 2,
    GB: 1024 ** 3,
    TB: 1024 ** 4
  };
  const factor = factorByUnit[unit] || 1;
  return Math.max(0, Math.round(value * factor));
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

function toSegmentFile(segmentNumber) {
  const value = Number(segmentNumber);
  if (!Number.isFinite(value) || value < 0) {
    return null;
  }
  return `${String(Math.trunc(value)).padStart(5, '0')}.m2ts`;
}

function parseSegmentNumbers(raw) {
  const text = String(raw || '').trim();
  if (!text) {
    return [];
  }

  const matches = text.match(/\d{1,6}/g) || [];
  return matches
    .map((item) => Number(item))
    .filter((value) => Number.isFinite(value) && value >= 0)
    .map((value) => Math.trunc(value));
}

function extractPlaylistMapping(line) {
  const raw = String(line || '');

  // Robot message typically maps playlist to title id.
  const msgMatch = raw.match(/MSG:3016.*,"(\d{5}\.mpls)","(\d+)"/i);
  if (msgMatch) {
    return {
      playlistId: normalizePlaylistId(msgMatch[1]),
      titleId: Number(msgMatch[2])
    };
  }

  const textMatch = raw.match(/(?:file|datei)\s+(\d{5}\.mpls).*?(?:title\s*#|titel\s*#?\s*)(\d+)/i);
  if (textMatch) {
    return {
      playlistId: normalizePlaylistId(textMatch[1]),
      titleId: Number(textMatch[2])
    };
  }

  return null;
}

function parseAnalyzeTitles(lines) {
  const titleMap = new Map();

  const ensureTitle = (titleId) => {
    if (!titleMap.has(titleId)) {
      titleMap.set(titleId, {
        titleId,
        playlistId: null,
        playlistIdFromMap: null,
        playlistIdFromField16: null,
        playlistFile: null,
        durationSeconds: 0,
        durationLabel: null,
        sizeBytes: 0,
        sizeLabel: null,
        chapters: 0,
        segmentNumbers: [],
        segmentFiles: [],
        fields: {}
      });
    }
    return titleMap.get(titleId);
  };

  for (const line of lines || []) {
    const mapping = extractPlaylistMapping(line);
    if (mapping && Number.isFinite(mapping.titleId) && mapping.titleId >= 0) {
      const title = ensureTitle(mapping.titleId);
      title.playlistIdFromMap = normalizePlaylistId(mapping.playlistId);
    }

    const tinfo = String(line || '').match(/^TINFO:(\d+),(\d+),\d+,"([^"]*)"/i);
    if (!tinfo) {
      continue;
    }

    const titleId = Number(tinfo[1]);
    const fieldId = Number(tinfo[2]);
    const value = String(tinfo[3] || '').trim();
    if (!Number.isFinite(titleId) || titleId < 0) {
      continue;
    }

    const title = ensureTitle(titleId);
    title.fields[fieldId] = value;

    if (fieldId === 16) {
      const fromField = normalizePlaylistId(value);
      if (fromField) {
        title.playlistIdFromField16 = fromField;
      }
      continue;
    }

    if (fieldId === 26) {
      const segmentNumbers = parseSegmentNumbers(value);
      if (segmentNumbers.length > 0) {
        title.segmentNumbers = segmentNumbers;
      }
      continue;
    }

    if (fieldId === 9) {
      const seconds = parseDurationSeconds(value);
      if (seconds > 0) {
        title.durationSeconds = seconds;
        title.durationLabel = formatDuration(seconds);
      }
      continue;
    }

    if (fieldId === 10 || fieldId === 11) {
      const bytes = parseSizeBytes(value);
      if (bytes > 0) {
        title.sizeBytes = bytes;
        title.sizeLabel = value;
      }
      continue;
    }

    if (fieldId === 8 || fieldId === 7) {
      const chapters = Number(value);
      if (Number.isFinite(chapters) && chapters >= 0) {
        title.chapters = Math.trunc(chapters);
      }
    }

    if (!title.durationSeconds && /\d+:\d{2}:\d{2}/.test(value)) {
      const seconds = parseDurationSeconds(value);
      if (seconds > 0) {
        title.durationSeconds = seconds;
        title.durationLabel = formatDuration(seconds);
      }
    }

    if (!title.sizeBytes && /(kb|mb|gb|tb)\b/i.test(value)) {
      const bytes = parseSizeBytes(value);
      if (bytes > 0) {
        title.sizeBytes = bytes;
        title.sizeLabel = value;
      }
    }
  }

  return Array.from(titleMap.values())
    .map((item) => {
      const playlistId = normalizePlaylistId(item.playlistId);
      const playlistIdFromMap = normalizePlaylistId(item.playlistIdFromMap);
      const playlistIdFromField16 = normalizePlaylistId(item.playlistIdFromField16);
      // Prefer explicit title<->playlist map lines from MakeMKV (MSG:3016).
      const resolvedPlaylistId = playlistIdFromMap || playlistIdFromField16 || playlistId;
      const segmentNumbers = Array.isArray(item.segmentNumbers) ? item.segmentNumbers : [];
      const segmentFiles = segmentNumbers
        .map((number) => toSegmentFile(number))
        .filter(Boolean);

      return {
        ...item,
        playlistId: resolvedPlaylistId,
        playlistIdFromMap,
        playlistIdFromField16,
        playlistFile: resolvedPlaylistId ? `${resolvedPlaylistId}.mpls` : null,
        durationLabel: item.durationLabel || formatDuration(item.durationSeconds),
        segmentNumbers,
        segmentFiles
      };
    })
    .sort((a, b) => a.titleId - b.titleId);
}

function uniqueOrdered(values) {
  const seen = new Set();
  const output = [];
  for (const value of values || []) {
    const normalized = String(value || '').trim().toLowerCase();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    output.push(String(value).trim());
  }
  return output;
}

function buildSimilarityGroups(candidates, durationSimilaritySeconds) {
  const list = Array.isArray(candidates) ? [...candidates] : [];
  const tolerance = Math.max(0, Math.round(Number(durationSimilaritySeconds || 0)));
  const groups = [];
  const used = new Set();

  for (let i = 0; i < list.length; i += 1) {
    if (used.has(i)) {
      continue;
    }

    const base = list[i];
    const currentGroup = [base];
    used.add(i);

    for (let j = i + 1; j < list.length; j += 1) {
      if (used.has(j)) {
        continue;
      }
      const candidate = list[j];
      if (Math.abs(Number(candidate.durationSeconds || 0) - Number(base.durationSeconds || 0)) <= tolerance) {
        currentGroup.push(candidate);
        used.add(j);
      }
    }

    if (currentGroup.length > 1) {
      const sortedTitles = currentGroup
        .slice()
        .sort((a, b) => b.durationSeconds - a.durationSeconds || b.sizeBytes - a.sizeBytes || a.titleId - b.titleId);
      const referenceDuration = Number(sortedTitles[0]?.durationSeconds || 0);
      groups.push({
        durationSeconds: referenceDuration,
        durationLabel: formatDuration(referenceDuration),
        titles: sortedTitles
      });
    }
  }

  return groups.sort((a, b) =>
    b.durationSeconds - a.durationSeconds || b.titles.length - a.titles.length
  );
}

function computeSegmentMetrics(segmentNumbers) {
  const numbers = Array.isArray(segmentNumbers)
    ? segmentNumbers.filter((value) => Number.isFinite(value)).map((value) => Math.trunc(value))
    : [];

  if (numbers.length === 0) {
    return {
      segmentCount: 0,
      segmentNumbers: [],
      directSequenceSteps: 0,
      backwardJumps: 0,
      largeJumps: 0,
      alternatingJumps: 0,
      alternatingPairs: 0,
      alternatingRatio: 0,
      sequenceCoherence: 0,
      monotonicRatio: 0,
      score: 0
    };
  }

  let directSequenceSteps = 0;
  let backwardJumps = 0;
  let largeJumps = 0;
  let alternatingJumps = 0;
  let alternatingPairs = 0;
  let prevDiff = null;

  for (let i = 1; i < numbers.length; i += 1) {
    const current = numbers[i - 1];
    const next = numbers[i];
    const diff = next - current;

    if (next < current) {
      backwardJumps += 1;
    }
    if (Math.abs(diff) > LARGE_JUMP_THRESHOLD) {
      largeJumps += 1;
    }
    if (diff === 1) {
      directSequenceSteps += 1;
    }

    if (prevDiff !== null) {
      const largePair = Math.abs(prevDiff) > LARGE_JUMP_THRESHOLD && Math.abs(diff) > LARGE_JUMP_THRESHOLD;
      if (largePair) {
        alternatingPairs += 1;
        const signChanged = (prevDiff < 0 && diff > 0) || (prevDiff > 0 && diff < 0);
        if (signChanged) {
          alternatingJumps += 1;
        }
      }
    }
    prevDiff = diff;
  }

  const transitions = Math.max(1, numbers.length - 1);
  const sequenceCoherence = Number((directSequenceSteps / transitions).toFixed(4));
  const alternatingRatio = alternatingPairs > 0
    ? Number((alternatingJumps / alternatingPairs).toFixed(4))
    : 0;

  const score = (directSequenceSteps * 2) - (backwardJumps * 3) - (largeJumps * 2);

  return {
    segmentCount: numbers.length,
    segmentNumbers: numbers,
    directSequenceSteps,
    backwardJumps,
    largeJumps,
    alternatingJumps,
    alternatingPairs,
    alternatingRatio,
    sequenceCoherence,
    monotonicRatio: sequenceCoherence,
    score
  };
}

function buildEvaluationLabel(metrics) {
  if (!metrics || metrics.segmentCount === 0) {
    return 'Keine Segmentliste aus TINFO:26 verfügbar';
  }
  if (metrics.alternatingRatio >= 0.55 && metrics.alternatingPairs >= 3) {
    return 'Fake-Struktur (alternierendes Sprungmuster)';
  }
  if (metrics.backwardJumps > 0 || metrics.largeJumps > 0) {
    return 'Auffällige Segmentreihenfolge';
  }
  return 'wahrscheinlich korrekt (lineare Segmentfolge)';
}

function scoreCandidates(groupTitles) {
  const titles = Array.isArray(groupTitles) ? groupTitles : [];
  if (titles.length === 0) {
    return [];
  }

  return titles
    .map((title) => {
      const metrics = computeSegmentMetrics(title.segmentNumbers);
      const reasons = [
        `sequence_steps=${metrics.directSequenceSteps}`,
        `sequence_coherence=${metrics.sequenceCoherence.toFixed(3)}`,
        `backward_jumps=${metrics.backwardJumps}`,
        `large_jumps=${metrics.largeJumps}`,
        `alternating_ratio=${metrics.alternatingRatio.toFixed(3)}`
      ];

      return {
        ...title,
        score: Number(metrics.score || 0),
        reasons,
        structuralMetrics: metrics,
        evaluationLabel: buildEvaluationLabel(metrics)
      };
    })
    .sort((a, b) =>
      b.score - a.score
      || b.structuralMetrics.sequenceCoherence - a.structuralMetrics.sequenceCoherence
      || b.durationSeconds - a.durationSeconds
      || b.sizeBytes - a.sizeBytes
      || a.titleId - b.titleId
    )
    .map((item, index) => ({
      ...item,
      recommended: index === 0
    }));
}

function buildPlaylistSegmentMap(titles) {
  const map = {};
  for (const title of titles || []) {
    const playlistId = normalizePlaylistId(title?.playlistId);
    if (!playlistId || map[playlistId]) {
      continue;
    }

    map[playlistId] = {
      playlistId,
      playlistFile: `${playlistId}.mpls`,
      playlistPath: `BDMV/PLAYLIST/${playlistId}.mpls`,
      segmentCommand: `strings BDMV/PLAYLIST/${playlistId}.mpls | grep m2ts`,
      segmentFiles: Array.isArray(title?.segmentFiles) ? title.segmentFiles : [],
      segmentNumbers: Array.isArray(title?.segmentNumbers) ? title.segmentNumbers : [],
      fileExists: null,
      source: 'makemkv_tinfo_26'
    };
  }
  return map;
}

function buildPlaylistToTitleIdMap(titles) {
  const map = {};
  for (const title of titles || []) {
    const playlistId = normalizePlaylistId(title?.playlistId || title?.playlistFile || null);
    const titleId = Number(title?.titleId);
    if (!playlistId || !Number.isFinite(titleId) || titleId < 0) {
      continue;
    }
    const normalizedTitleId = Math.trunc(titleId);
    if (map[playlistId] === undefined) {
      map[playlistId] = normalizedTitleId;
    }
    const playlistFile = `${playlistId}.mpls`;
    if (map[playlistFile] === undefined) {
      map[playlistFile] = normalizedTitleId;
    }
  }
  return map;
}

function extractWarningLines(lines) {
  return (Array.isArray(lines) ? lines : [])
    .filter((line) => /warn|warning|error|fehler|decode|decoder|timeout|corrupt/i.test(String(line || '')))
    .slice(0, 40)
    .map((line) => String(line || '').slice(0, 260));
}

function extractPlaylistMismatchWarnings(titles) {
  return (Array.isArray(titles) ? titles : [])
    .filter((title) => title?.playlistIdFromMap && title?.playlistIdFromField16)
    .filter((title) => String(title.playlistIdFromMap) !== String(title.playlistIdFromField16))
    .slice(0, 25)
    .map((title) =>
      `Titel #${title.titleId}: MSG-Playlist=${title.playlistIdFromMap}.mpls, TINFO16=${title.playlistIdFromField16}.mpls (MSG bevorzugt)`
    );
}

function analyzePlaylistObfuscation(lines, minLengthMinutes = 60, options = {}) {
  const parsedTitles = parseAnalyzeTitles(lines);
  const minSeconds = Math.max(0, Math.round(Number(minLengthMinutes || 0) * 60));
  const durationSimilaritySeconds = Math.max(
    0,
    Math.round(Number(options.durationSimilaritySeconds || DEFAULT_DURATION_SIMILARITY_SECONDS))
  );

  const candidates = parsedTitles
    .filter((item) => Number(item.durationSeconds || 0) >= minSeconds)
    .sort((a, b) => b.durationSeconds - a.durationSeconds || b.sizeBytes - a.sizeBytes || a.titleId - b.titleId);

  const similarityGroups = buildSimilarityGroups(candidates, durationSimilaritySeconds);
  const obfuscationDetected = similarityGroups.length > 0;
  const multipleCandidatesDetected = candidates.length > 1;
  const manualDecisionRequired = multipleCandidatesDetected;
  const decisionPool = manualDecisionRequired ? candidates : [];
  const evaluatedCandidates = decisionPool.length > 0 ? scoreCandidates(decisionPool) : [];
  const recommendation = evaluatedCandidates[0] || null;
  const candidatePlaylists = manualDecisionRequired
    ? uniqueOrdered(decisionPool.map((item) => item.playlistId).filter(Boolean))
    : [];
  const playlistSegments = buildPlaylistSegmentMap(decisionPool);
  const playlistToTitleId = buildPlaylistToTitleIdMap(parsedTitles);

  return {
    generatedAt: new Date().toISOString(),
    minLengthMinutes: Number(minLengthMinutes || 0),
    minLengthSeconds: minSeconds,
    durationSimilaritySeconds,
    titles: parsedTitles,
    candidates,
    duplicateDurationGroups: similarityGroups,
    obfuscationDetected,
    manualDecisionRequired,
    manualDecisionReason: manualDecisionRequired
      ? (obfuscationDetected ? 'multiple_similar_candidates' : 'multiple_candidates_after_min_length')
      : null,
    candidatePlaylists,
    candidatePlaylistFiles: candidatePlaylists.map((item) => `${item}.mpls`),
    playlistToTitleId,
    recommendation: recommendation
      ? {
        titleId: recommendation.titleId,
        playlistId: recommendation.playlistId,
        score: Number(recommendation.score || 0),
        reason: Array.isArray(recommendation.reasons) && recommendation.reasons.length > 0
          ? recommendation.reasons.join('; ')
          : 'höchster Struktur-Score'
      }
      : null,
    evaluatedCandidates,
    playlistSegments,
    structuralAnalysis: {
      method: 'makemkv_tinfo_26',
      sourceCommand: 'makemkvcon -r info disc:0 --robot',
      analyzedPlaylists: Object.keys(playlistSegments).length
    },
    warningLines: [
      ...extractWarningLines(lines),
      ...extractPlaylistMismatchWarnings(parsedTitles)
    ].slice(0, 60)
  };
}

module.exports = {
  normalizePlaylistId,
  analyzePlaylistObfuscation
};
