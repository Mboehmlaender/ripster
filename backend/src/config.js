const path = require('path');

const rootDir = path.resolve(__dirname, '..');
const rawDbPath = process.env.DB_PATH || path.join(rootDir, 'data', 'ripster.db');
const rawLogDir = process.env.LOG_DIR || path.join(rootDir, 'logs');

module.exports = {
  port: process.env.PORT ? Number(process.env.PORT) : 3001,
  dbPath: path.isAbsolute(rawDbPath) ? rawDbPath : path.resolve(rootDir, rawDbPath),
  corsOrigin: process.env.CORS_ORIGIN || '*',
  logDir: path.isAbsolute(rawLogDir) ? rawLogDir : path.resolve(rootDir, rawLogDir),
  logLevel: process.env.LOG_LEVEL || 'info'
};
