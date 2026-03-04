const fs = require('fs');
const path = require('path');

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function sanitizeFileName(input) {
  return String(input || 'untitled')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180);
}

function renderTemplate(template, values) {
  return String(template || '${title} (${year})').replace(/\$\{([^}]+)\}/g, (_, key) => {
    const val = values[key.trim()];
    if (val === undefined || val === null || val === '') {
      return 'unknown';
    }
    return String(val);
  });
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
  sanitizeFileName,
  renderTemplate,
  findLargestMediaFile,
  findMediaFiles
};
