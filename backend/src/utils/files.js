const fs = require('fs');
const path = require('path');

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function transliterateForFilename(input) {
  return String(input || '')
    // German — must come before NFD to get ae/oe/ue instead of just a/o/u
    .replace(/ä/g, 'ae').replace(/Ä/g, 'Ae')
    .replace(/ö/g, 'oe').replace(/Ö/g, 'Oe')
    .replace(/ü/g, 'ue').replace(/Ü/g, 'Ue')
    .replace(/ß/g, 'ss')
    // Danish / Norwegian / Swedish
    .replace(/å/g, 'a').replace(/Å/g, 'A')
    .replace(/æ/g, 'ae').replace(/Æ/g, 'Ae')
    .replace(/ø/g, 'o').replace(/Ø/g, 'O')
    // Icelandic
    .replace(/ð/g, 'd').replace(/Ð/g, 'D')
    .replace(/þ/g, 'th').replace(/Þ/g, 'Th')
    // NFD decomposition + strip combining diacritical marks (handles é→e, ñ→n, ç→c, etc.)
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    // Drop any remaining non-ASCII characters
    .replace(/[^\x00-\x7F]/g, '');
}

function sanitizeFileName(input) {
  return transliterateForFilename(String(input || 'untitled'))
    .replace(/[^a-zA-Z0-9 ()[\]_+-]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180);
}

function sanitizeFileNameWithExtension(input) {
  const str = String(input || 'untitled');
  const ext = path.extname(str);
  const base = ext ? str.slice(0, -ext.length) : str;
  const cleanBase = sanitizeFileName(base);
  const cleanExt = ext.toLowerCase().replace(/[^a-z0-9.]/g, '');
  return (cleanBase || 'untitled') + cleanExt;
}

function renderTemplate(template, values) {
  const rawSource = String(template || '${title} (${year})');
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
    // {0:key} => number with leading zero (width 2), e.g. 2 -> 02
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
  const resolveToken = (rawKey) => {
    const { format, key } = parseToken(rawKey);
    const val = values[key];
    if (val === undefined || val === null || val === '') {
      return 'unknown';
    }
    return applyFormat(val, format);
  };

  const source = (
    /[{}]/.test(rawSource)
      ? rawSource
      : rawSource.replace(/\b(trackNr|trackNumber|artist|album|title|year)\b/g, '{$1}')
  );

  // Support both ${key} and legacy {key} placeholders (+ recovered bare tokens).
  return source
    .replace(/\$\{([^}]+)\}/g, (_m, key) => resolveToken(key))
    .replace(/\{([^{}$]+)\}/g, (_m, key) => resolveToken(key));
}

function findLargestMediaFile(dirPath, extensions = ['.mkv', '.mp4']) {
  const files = findMediaFiles(dirPath, extensions);
  if (files.length === 0) {
    return null;
  }

  return files.reduce((largest, file) => (largest === null || file.size > largest.size ? file : largest), null);
}

function findMediaFiles(dirPath, extensions = ['.mkv', '.mp4']) {
  const results = [];

  function walk(current) {
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const abs = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
      } else {
        const ext = path.extname(entry.name).toLowerCase();
        if (!extensions.includes(ext)) {
          continue;
        }

        const stat = fs.statSync(abs);
        results.push({
          path: abs,
          size: stat.size
        });
      }
    }
  }

  walk(dirPath);
  results.sort((a, b) => b.size - a.size || a.path.localeCompare(b.path));
  return results;
}

module.exports = {
  ensureDir,
  transliterateForFilename,
  sanitizeFileName,
  sanitizeFileNameWithExtension,
  renderTemplate,
  findLargestMediaFile,
  findMediaFiles
};
