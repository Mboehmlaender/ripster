function clampPercent(value) {
  if (Number.isNaN(value) || value === Infinity || value === -Infinity) {
    return null;
  }

  return Math.max(0, Math.min(100, Number(value.toFixed(2))));
}

function parseGenericPercent(line) {
  const match = line.match(/(\d{1,3}(?:\.\d+)?)\s?%/);
  if (!match) {
    return null;
  }

  return clampPercent(Number(match[1]));
}

function parseEta(line) {
  const etaMatch = line.match(/ETA\s+([0-9:.hms-]+)/i);
  if (!etaMatch) {
    return null;
  }

  const value = etaMatch[1].trim();
  if (!value || value.includes('--')) {
    return null;
  }

  return value.replace(/[),.;]+$/, '');
}

function parseMakeMkvProgress(line) {
  const prgv = line.match(/PRGV:(\d+),(\d+),(\d+)/);
  if (prgv) {
    // Format: PRGV:current,total,max  (official makemkv docs)
    // current = per-file progress, total = overall progress across all files
    const total = Number(prgv[2]);
    const max = Number(prgv[3]);

    if (max > 0) {
      return { percent: clampPercent((total / max) * 100), eta: null };
    }
  }

  const percent = parseGenericPercent(line);
  if (percent !== null) {
    return { percent, eta: null };
  }

  return null;
}

function parseHandBrakeProgress(line) {
  const normalized = String(line || '').replace(/\s+/g, ' ').trim();
  const match = normalized.match(/Encoding:\s*(?:task\s+\d+\s+of\s+\d+,\s*)?(\d+(?:\.\d+)?)\s?%/i);
  if (match) {
    return {
      percent: clampPercent(Number(match[1])),
      eta: parseEta(normalized)
    };
  }

  return null;
}

function parseCdParanoiaProgress(line) {
  // cdparanoia writes progress to stderr with \r overwrites.
  // Formats seen in the wild:
  //   "Ripping track  1 of 12  progress: ( 34.21%)"
  //   "###: 14 [wrote  ]  (track  3 of 12  [  0:12.33])"
  const normalized = String(line || '').replace(/\s+/g, ' ').trim();

  const progressMatch = normalized.match(/progress:\s*\(\s*(\d+(?:\.\d+)?)\s*%\s*\)/i);
  if (progressMatch) {
    const trackMatch = normalized.match(/track\s+(\d+)\s+of\s+(\d+)/i);
    const currentTrack = trackMatch ? Number(trackMatch[1]) : null;
    const totalTracks = trackMatch ? Number(trackMatch[2]) : null;
    return {
      percent: clampPercent(Number(progressMatch[1])),
      currentTrack,
      totalTracks,
      eta: null
    };
  }

  // "###: 14 [wrote  ]  (track  3 of 12 [ 0:12.33])" style – no clear percent here
  // Fall back to generic percent match
  const percent = parseGenericPercent(normalized);
  if (percent !== null) {
    return { percent, currentTrack: null, totalTracks: null, eta: null };
  }

  return null;
}

module.exports = {
  parseMakeMkvProgress,
  parseHandBrakeProgress,
  parseCdParanoiaProgress
};
