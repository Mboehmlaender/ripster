const fs = require('fs');
const logger = require('./logger').child('AUDNEX');

const AUDNEX_BASE_URL = 'https://api.audnex.us';
const AUDNEX_TIMEOUT_MS = 10000;
const ASIN_PATTERN = /B0[0-9A-Z]{8}/u;

function normalizeAsin(value) {
  const raw = String(value || '').trim().toUpperCase();
  return ASIN_PATTERN.test(raw) ? raw : null;
}

async function extractAsinFromAaxFile(filePath) {
  const sourcePath = String(filePath || '').trim();
  if (!sourcePath) {
    return null;
  }

  return new Promise((resolve, reject) => {
    let printableWindow = '';
    let settled = false;
    const stream = fs.createReadStream(sourcePath, { highWaterMark: 64 * 1024 });

    const finish = (value) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(value);
    };

    stream.on('data', (chunk) => {
      if (settled) {
        return;
      }

      for (const byte of chunk) {
        if (byte >= 32 && byte <= 126) {
          printableWindow = `${printableWindow}${String.fromCharCode(byte)}`.slice(-48);
          const match = printableWindow.match(/B0[0-9A-Z]{8}/u);
          if (match?.[0]) {
            const asin = normalizeAsin(match[0]);
            if (asin) {
              logger.info('asin:detected', { filePath: sourcePath, asin });
              stream.destroy();
              finish(asin);
              return;
            }
          }
        } else {
          printableWindow = '';
        }
      }
    });

    stream.on('error', (error) => {
      if (settled) {
        return;
      }
      settled = true;
      reject(error);
    });

    stream.on('close', () => {
      if (!settled) {
        finish(null);
      }
    });
  });
}

async function audnexFetch(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AUDNEX_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'Ripster/1.0'
      },
      signal: controller.signal
    });
    clearTimeout(timer);
    if (!response.ok) {
      throw new Error(`Audnex Anfrage fehlgeschlagen (${response.status})`);
    }
    return response.json();
  } catch (error) {
    clearTimeout(timer);
    throw error;
  }
}

function extractChapterArray(payload) {
  if (Array.isArray(payload)) {
    return payload;
  }
  const candidates = [
    payload?.chapters,
    payload?.data?.chapters,
    payload?.content?.chapters,
    payload?.results?.chapters
  ];
  return candidates.find((entry) => Array.isArray(entry)) || [];
}

function normalizeAudnexChapter(entry, index) {
  const startOffsetMs = Number(
    entry?.startOffsetMs
    ?? entry?.startMs
    ?? entry?.offsetMs
    ?? 0
  );
  const lengthMs = Number(
    entry?.lengthMs
    ?? entry?.durationMs
    ?? entry?.length
    ?? 0
  );
  const title = String(entry?.title || entry?.chapterTitle || `Kapitel ${index + 1}`).trim() || `Kapitel ${index + 1}`;
  const safeStartMs = Number.isFinite(startOffsetMs) && startOffsetMs >= 0 ? Math.round(startOffsetMs) : 0;
  const safeLengthMs = Number.isFinite(lengthMs) && lengthMs > 0 ? Math.round(lengthMs) : 0;

  return {
    index: index + 1,
    title,
    startMs: safeStartMs,
    endMs: safeStartMs + safeLengthMs,
    startSeconds: Math.round(safeStartMs / 1000),
    endSeconds: Math.round((safeStartMs + safeLengthMs) / 1000)
  };
}

async function fetchChaptersByAsin(asin, region = 'de') {
  const normalizedAsin = normalizeAsin(asin);
  if (!normalizedAsin) {
    return [];
  }

  const url = new URL(`${AUDNEX_BASE_URL}/books/${normalizedAsin}/chapters`);
  url.searchParams.set('region', String(region || 'de').trim() || 'de');
  logger.info('chapters:fetch:start', { asin: normalizedAsin, url: url.toString() });

  const payload = await audnexFetch(url.toString());
  const chapters = extractChapterArray(payload)
    .map((entry, index) => normalizeAudnexChapter(entry, index))
    .filter((chapter) => chapter.endMs > chapter.startMs && chapter.title);

  logger.info('chapters:fetch:done', { asin: normalizedAsin, count: chapters.length });
  return chapters;
}

module.exports = {
  extractAsinFromAaxFile,
  fetchChaptersByAsin
};
