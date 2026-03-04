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
    const a = Number(prgv[1]);
    const b = Number(prgv[2]);
    const c = Number(prgv[3]);

    if (c > 0) {
      return { percent: clampPercent((a / c) * 100), eta: null };
    }

    if (b > 0) {
      return { percent: clampPercent((a / b) * 100), eta: null };
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

module.exports = {
  parseMakeMkvProgress,
  parseHandBrakeProgress
};
