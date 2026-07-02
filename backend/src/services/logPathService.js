const path = require('path');
const { logDir: fallbackLogDir } = require('../config');

function normalizeDir(value) {
  const raw = String(value || '').trim();
  if (!raw) {
    return null;
  }
  return path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(raw);
}

function getFallbackLogRootDir() {
  return path.resolve(fallbackLogDir);
}

function resolveLogRootDir(value) {
  return normalizeDir(value) || getFallbackLogRootDir();
}

let runtimeLogRootDir = getFallbackLogRootDir();

function setLogRootDir(value) {
  runtimeLogRootDir = resolveLogRootDir(value);
  return runtimeLogRootDir;
}

function getLogRootDir() {
  return runtimeLogRootDir || getFallbackLogRootDir();
}

function getBackendLogDir() {
  return path.join(getLogRootDir(), 'backend');
}

function getJobLogDir() {
  return getLogRootDir();
}

module.exports = {
  getFallbackLogRootDir,
  resolveLogRootDir,
  setLogRootDir,
  getLogRootDir,
  getBackendLogDir,
  getJobLogDir
};
