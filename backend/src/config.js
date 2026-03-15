const path = require('path');

const rootDir = path.resolve(__dirname, '..');
const rawDbPath = process.env.DB_PATH || path.join(rootDir, 'data', 'ripster.db');
const rawLogDir = process.env.LOG_DIR || path.join(rootDir, 'logs');
const resolvedDbPath = path.isAbsolute(rawDbPath) ? rawDbPath : path.resolve(rootDir, rawDbPath);
const dataDir = path.dirname(resolvedDbPath);

function resolveOutputPath(envValue, ...subParts) {
  const raw = String(envValue || '').trim();
  if (raw) {
    return path.isAbsolute(raw) ? raw : path.resolve(rootDir, raw);
  }
  return path.join(dataDir, ...subParts);
}

module.exports = {
  port: process.env.PORT ? Number(process.env.PORT) : 3001,
  dbPath: resolvedDbPath,
  dataDir,
  corsOrigin: process.env.CORS_ORIGIN || '*',
  logDir: path.isAbsolute(rawLogDir) ? rawLogDir : path.resolve(rootDir, rawLogDir),
  logLevel: process.env.LOG_LEVEL || 'info',
  defaultRawDir: resolveOutputPath(process.env.DEFAULT_RAW_DIR, 'output', 'raw'),
  defaultMovieDir: resolveOutputPath(process.env.DEFAULT_MOVIE_DIR, 'output', 'movies'),
  defaultCdDir: resolveOutputPath(process.env.DEFAULT_CD_DIR, 'output', 'cd'),
  defaultAudiobookRawDir: resolveOutputPath(process.env.DEFAULT_AUDIOBOOK_RAW_DIR, 'output', 'audiobook-raw'),
  defaultAudiobookDir: resolveOutputPath(process.env.DEFAULT_AUDIOBOOK_DIR, 'output', 'audiobooks'),
  defaultDownloadDir: resolveOutputPath(process.env.DEFAULT_DOWNLOAD_DIR, 'downloads')
};
