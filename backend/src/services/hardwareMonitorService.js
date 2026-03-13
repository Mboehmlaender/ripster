const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const settingsService = require('./settingsService');
const wsService = require('./websocketService');
const logger = require('./logger').child('HWMON');
const { errorToMeta } = require('../utils/errorMeta');

const execFileAsync = promisify(execFile);

const DEFAULT_INTERVAL_MS = 5000;
const MIN_INTERVAL_MS = 1000;
const MAX_INTERVAL_MS = 60000;
const DF_TIMEOUT_MS = 1800;
const SENSORS_TIMEOUT_MS = 1800;
const NVIDIA_SMI_TIMEOUT_MS = 1800;
const RELEVANT_SETTINGS_KEYS = new Set([
  'hardware_monitoring_enabled',
  'hardware_monitoring_interval_ms',
  'raw_dir',
  'raw_dir_bluray',
  'raw_dir_dvd',
  'raw_dir_cd',
  'movie_dir',
  'movie_dir_bluray',
  'movie_dir_dvd',
  'log_dir'
]);

function nowIso() {
  return new Date().toISOString();
}

function toBoolean(value) {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return value !== 0;
  }
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  if (normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on') {
    return true;
  }
  if (normalized === 'false' || normalized === '0' || normalized === 'no' || normalized === 'off') {
    return false;
  }
  return Boolean(normalized);
}

function normalizePathSetting(value) {
  return String(value || '').trim();
}

function clampIntervalMs(rawValue) {
  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_INTERVAL_MS;
  }
  const clamped = Math.max(MIN_INTERVAL_MS, Math.min(MAX_INTERVAL_MS, Math.trunc(parsed)));
  return clamped || DEFAULT_INTERVAL_MS;
}

function roundNumber(rawValue, digits = 1) {
  const value = Number(rawValue);
  if (!Number.isFinite(value)) {
    return null;
  }
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function averageNumberList(values = []) {
  const list = (Array.isArray(values) ? values : []).filter((value) => Number.isFinite(Number(value)));
  if (list.length === 0) {
    return null;
  }
  const sum = list.reduce((acc, value) => acc + Number(value), 0);
  return sum / list.length;
}

function parseMaybeNumber(rawValue) {
  if (rawValue === null || rawValue === undefined) {
    return null;
  }
  if (typeof rawValue === 'number' && Number.isFinite(rawValue)) {
    return rawValue;
  }
  const normalized = String(rawValue).trim().replace(',', '.');
  if (!normalized) {
    return null;
  }
  const cleaned = normalized.replace(/[^0-9.+-]/g, '');
  if (!cleaned) {
    return null;
  }
  const parsed = Number(cleaned);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return parsed;
}

function normalizeTempC(rawValue) {
  const parsed = parseMaybeNumber(rawValue);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  let celsius = parsed;
  if (Math.abs(celsius) > 500) {
    celsius = celsius / 1000;
  }
  if (!Number.isFinite(celsius) || celsius <= -40 || celsius >= 160) {
    return null;
  }
  return roundNumber(celsius, 1);
}

function isCommandMissingError(error) {
  return String(error?.code || '').toUpperCase() === 'ENOENT';
}

function readTextFileSafe(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf-8').trim();
  } catch (_error) {
    return '';
  }
}

function collectTemperatureCandidates(node, pathParts = [], out = []) {
  if (!node || typeof node !== 'object') {
    return out;
  }

  for (const [key, value] of Object.entries(node)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      collectTemperatureCandidates(value, [...pathParts, key], out);
      continue;
    }
    if (!/^temp\d+_input$/i.test(String(key || ''))) {
      continue;
    }
    const normalizedTemp = normalizeTempC(value);
    if (normalizedTemp === null) {
      continue;
    }
    out.push({
      label: [...pathParts, key].join(' / '),
      value: normalizedTemp
    });
  }

  return out;
}

function mapTemperatureCandidates(candidates = []) {
  const perCoreSamples = new Map();
  const packageSamples = [];
  const genericSamples = [];

  for (const entry of Array.isArray(candidates) ? candidates : []) {
    const value = Number(entry?.value);
    if (!Number.isFinite(value)) {
      continue;
    }
    const label = String(entry?.label || '');
    const labelLower = label.toLowerCase();
    const coreMatch = labelLower.match(/\bcore\s*([0-9]+)\b/);
    if (coreMatch) {
      const index = Number(coreMatch[1]);
      if (Number.isFinite(index) && index >= 0) {
        const list = perCoreSamples.get(index) || [];
        list.push(value);
        perCoreSamples.set(index, list);
        continue;
      }
    }

    if (/package id|tdie|tctl|cpu package|physical id/.test(labelLower)) {
      packageSamples.push(value);
      continue;
    }

    genericSamples.push(value);
  }

  const perCore = Array.from(perCoreSamples.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([index, values]) => ({
      index,
      temperatureC: roundNumber(averageNumberList(values), 1)
    }))
    .filter((item) => item.temperatureC !== null);

  const overallRaw = packageSamples.length > 0
    ? averageNumberList(packageSamples)
    : (perCore.length > 0 ? averageNumberList(perCore.map((item) => item.temperatureC)) : averageNumberList(genericSamples));
  const overallC = roundNumber(overallRaw, 1);

  return {
    overallC,
    perCore,
    available: Boolean(overallC !== null || perCore.length > 0)
  };
}

function isLikelyCpuTemperatureLabel(label = '') {
  const normalized = String(label || '').trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  return /cpu|core|package|tdie|tctl|physical id|x86_pkg_temp|k10temp|zenpower|cpu-thermal|soc_thermal/.test(normalized);
}

function preferCpuTemperatureCandidates(candidates = []) {
  const list = Array.isArray(candidates) ? candidates : [];
  const cpuLikely = list.filter((item) => isLikelyCpuTemperatureLabel(item?.label));
  return cpuLikely.length > 0 ? cpuLikely : list;
}

function parseDfStats(rawOutput) {
  const lines = String(rawOutput || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length < 2) {
    return null;
  }
  const dataLine = lines[lines.length - 1];
  const columns = dataLine.split(/\s+/);
  if (columns.length < 6) {
    return null;
  }

  const totalKb = parseMaybeNumber(columns[1]);
  const usedKb = parseMaybeNumber(columns[2]);
  const availableKb = parseMaybeNumber(columns[3]);
  const usagePercent = parseMaybeNumber(String(columns[4]).replace('%', ''));
  const mountPoint = columns.slice(5).join(' ');

  if (!Number.isFinite(totalKb) || !Number.isFinite(usedKb) || !Number.isFinite(availableKb)) {
    return null;
  }

  return {
    totalBytes: Math.max(0, Math.round(totalKb * 1024)),
    usedBytes: Math.max(0, Math.round(usedKb * 1024)),
    freeBytes: Math.max(0, Math.round(availableKb * 1024)),
    usagePercent: Number.isFinite(usagePercent)
      ? roundNumber(usagePercent, 1)
      : (totalKb > 0 ? roundNumber((usedKb / totalKb) * 100, 1) : null),
    mountPoint: mountPoint || null
  };
}

function parseNvidiaCsvLine(line) {
  const columns = String(line || '').split(',').map((part) => part.trim());
  if (columns.length < 10) {
    return null;
  }

  const index = parseMaybeNumber(columns[0]);
  const memoryUsedMiB = parseMaybeNumber(columns[5]);
  const memoryTotalMiB = parseMaybeNumber(columns[6]);
  return {
    index: Number.isFinite(index) ? Math.trunc(index) : null,
    name: columns[1] || null,
    utilizationPercent: roundNumber(parseMaybeNumber(columns[2]), 1),
    memoryUtilizationPercent: roundNumber(parseMaybeNumber(columns[3]), 1),
    temperatureC: roundNumber(parseMaybeNumber(columns[4]), 1),
    memoryUsedBytes: Number.isFinite(memoryUsedMiB) ? Math.round(memoryUsedMiB * 1024 * 1024) : null,
    memoryTotalBytes: Number.isFinite(memoryTotalMiB) ? Math.round(memoryTotalMiB * 1024 * 1024) : null,
    powerDrawW: roundNumber(parseMaybeNumber(columns[7]), 1),
    powerLimitW: roundNumber(parseMaybeNumber(columns[8]), 1),
    fanPercent: roundNumber(parseMaybeNumber(columns[9]), 1)
  };
}

class HardwareMonitorService {
  constructor() {
    this.enabled = false;
    this.intervalMs = DEFAULT_INTERVAL_MS;
    this.monitoredPaths = [];
    this.running = false;
    this.timer = null;
    this.pollInFlight = false;
    this.lastCpuTimes = null;
    this.sensorsCommandAvailable = null;
    this.nvidiaSmiAvailable = null;
    this.lastSnapshot = {
      enabled: false,
      intervalMs: DEFAULT_INTERVAL_MS,
      updatedAt: null,
      sample: null,
      error: null
    };
  }

  async init() {
    await this.reloadFromSettings({
      forceBroadcast: true,
      forceImmediatePoll: true
    });
  }

  stop() {
    this.stopPolling();
  }

  getSnapshot() {
    return {
      enabled: Boolean(this.lastSnapshot?.enabled),
      intervalMs: Number(this.lastSnapshot?.intervalMs || DEFAULT_INTERVAL_MS),
      updatedAt: this.lastSnapshot?.updatedAt || null,
      sample: this.lastSnapshot?.sample || null,
      error: this.lastSnapshot?.error || null
    };
  }

  async handleSettingsChanged(changedKeys = []) {
    const normalizedKeys = (Array.isArray(changedKeys) ? changedKeys : [])
      .map((key) => String(key || '').trim().toLowerCase())
      .filter(Boolean);

    if (normalizedKeys.length === 0) {
      return;
    }

    const relevant = normalizedKeys.some((key) => RELEVANT_SETTINGS_KEYS.has(key));
    if (!relevant) {
      return;
    }

    await this.reloadFromSettings({
      forceImmediatePoll: true
    });
  }

  async reloadFromSettings(options = {}) {
    const forceBroadcast = Boolean(options?.forceBroadcast);
    const forceImmediatePoll = Boolean(options?.forceImmediatePoll);
    let settingsMap = {};
    try {
      settingsMap = await settingsService.getSettingsMap();
    } catch (error) {
      logger.warn('settings:load:failed', { error: errorToMeta(error) });
      return this.getSnapshot();
    }

    const nextEnabled = toBoolean(settingsMap.hardware_monitoring_enabled);
    const nextIntervalMs = clampIntervalMs(settingsMap.hardware_monitoring_interval_ms);
    const nextPaths = this.buildMonitoredPaths(settingsMap);
    const wasEnabled = this.enabled;
    const intervalChanged = nextIntervalMs !== this.intervalMs;
    const pathsChanged = this.pathsSignature(this.monitoredPaths) !== this.pathsSignature(nextPaths);

    this.enabled = nextEnabled;
    this.intervalMs = nextIntervalMs;
    this.monitoredPaths = nextPaths;
    this.lastSnapshot = {
      ...this.lastSnapshot,
      enabled: this.enabled,
      intervalMs: this.intervalMs
    };

    if (!this.enabled) {
      this.stopPolling();
      this.lastSnapshot = {
        enabled: false,
        intervalMs: this.intervalMs,
        updatedAt: nowIso(),
        sample: null,
        error: null
      };
      this.broadcastUpdate();
      return this.getSnapshot();
    }

    if (!this.running) {
      this.startPolling();
    } else if (intervalChanged || pathsChanged || forceImmediatePoll || !wasEnabled) {
      this.scheduleNext(25);
    }

    if (forceBroadcast || intervalChanged || !wasEnabled) {
      this.broadcastUpdate();
    }

    return this.getSnapshot();
  }

  buildMonitoredPaths(settingsMap = {}) {
    const sourceMap = settingsMap && typeof settingsMap === 'object' ? settingsMap : {};
    const bluray = settingsService.resolveEffectiveToolSettings(sourceMap, 'bluray');
    const dvd = settingsService.resolveEffectiveToolSettings(sourceMap, 'dvd');
    const cd = settingsService.resolveEffectiveToolSettings(sourceMap, 'cd');
    const blurayRawPath = normalizePathSetting(bluray?.raw_dir);
    const dvdRawPath = normalizePathSetting(dvd?.raw_dir);
    const cdRawPath = normalizePathSetting(cd?.raw_dir);
    const blurayMoviePath = normalizePathSetting(bluray?.movie_dir);
    const dvdMoviePath = normalizePathSetting(dvd?.movie_dir);
    const monitoredPaths = [];

    const addPath = (key, label, monitoredPath) => {
      monitoredPaths.push({
        key,
        label,
        path: normalizePathSetting(monitoredPath)
      });
    };

    if (blurayRawPath && dvdRawPath && blurayRawPath !== dvdRawPath) {
      addPath('raw_dir_bluray', 'RAW-Verzeichnis (Blu-ray)', blurayRawPath);
      addPath('raw_dir_dvd', 'RAW-Verzeichnis (DVD)', dvdRawPath);
    } else {
      addPath('raw_dir', 'RAW-Verzeichnis', blurayRawPath || dvdRawPath || sourceMap.raw_dir);
    }
    addPath('raw_dir_cd', 'CD RAW-Ordner', cdRawPath || sourceMap.raw_dir_cd);

    if (blurayMoviePath && dvdMoviePath && blurayMoviePath !== dvdMoviePath) {
      addPath('movie_dir_bluray', 'Movie-Verzeichnis (Blu-ray)', blurayMoviePath);
      addPath('movie_dir_dvd', 'Movie-Verzeichnis (DVD)', dvdMoviePath);
    } else {
      addPath('movie_dir', 'Movie-Verzeichnis', blurayMoviePath || dvdMoviePath || sourceMap.movie_dir);
    }

    addPath('log_dir', 'Log-Verzeichnis', sourceMap.log_dir);

    return monitoredPaths;
  }

  pathsSignature(paths = []) {
    return (Array.isArray(paths) ? paths : [])
      .map((item) => `${String(item?.key || '')}:${String(item?.path || '')}`)
      .join('|');
  }

  startPolling() {
    if (this.running) {
      return;
    }
    this.running = true;
    logger.info('start', {
      intervalMs: this.intervalMs,
      pathKeys: this.monitoredPaths.map((item) => item.key)
    });
    this.scheduleNext(20);
  }

  stopPolling() {
    const wasActive = this.running || this.pollInFlight || Boolean(this.timer);
    this.running = false;
    this.pollInFlight = false;
    this.lastCpuTimes = null;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (wasActive) {
      logger.info('stop');
    }
  }

  scheduleNext(delayMs) {
    if (!this.running) {
      return;
    }
    if (this.timer) {
      clearTimeout(this.timer);
    }
    const delay = Math.max(0, Math.trunc(Number(delayMs) || this.intervalMs));
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.pollOnce();
    }, delay);
  }

  async pollOnce() {
    if (!this.running || !this.enabled) {
      return;
    }
    if (this.pollInFlight) {
      this.scheduleNext(this.intervalMs);
      return;
    }
    this.pollInFlight = true;
    try {
      const sample = await this.collectSample();
      this.lastSnapshot = {
        enabled: true,
        intervalMs: this.intervalMs,
        updatedAt: nowIso(),
        sample,
        error: null
      };
      this.broadcastUpdate();
    } catch (error) {
      logger.warn('poll:failed', { error: errorToMeta(error) });
      this.lastSnapshot = {
        ...this.lastSnapshot,
        enabled: true,
        intervalMs: this.intervalMs,
        updatedAt: nowIso(),
        error: error?.message || 'Hardware-Monitoring fehlgeschlagen.'
      };
      this.broadcastUpdate();
    } finally {
      this.pollInFlight = false;
      if (this.running && this.enabled) {
        this.scheduleNext(this.intervalMs);
      }
    }
  }

  broadcastUpdate() {
    wsService.broadcast('HARDWARE_MONITOR_UPDATE', this.getSnapshot());
  }

  async collectSample() {
    const memory = this.collectMemoryMetrics();
    const [cpu, gpu, storage] = await Promise.all([
      this.collectCpuMetrics(),
      this.collectGpuMetrics(),
      this.collectStorageMetrics()
    ]);

    return {
      cpu,
      memory,
      gpu,
      storage
    };
  }

  collectMemoryMetrics() {
    const totalBytes = Number(os.totalmem() || 0);
    const freeBytes = Number(os.freemem() || 0);
    const usedBytes = Math.max(0, totalBytes - freeBytes);
    const usagePercent = totalBytes > 0
      ? roundNumber((usedBytes / totalBytes) * 100, 1)
      : null;
    return {
      totalBytes,
      usedBytes,
      freeBytes,
      usagePercent
    };
  }

  getCpuTimes() {
    const cpus = os.cpus() || [];
    return cpus.map((cpu) => {
      const times = cpu?.times || {};
      const idle = Number(times.idle || 0);
      const total = Object.values(times).reduce((sum, value) => sum + Number(value || 0), 0);
      return { idle, total };
    });
  }

  calculateCpuUsage(currentTimes = [], previousTimes = []) {
    const perCore = [];
    const coreCount = Math.min(currentTimes.length, previousTimes.length);
    if (coreCount <= 0) {
      return {
        overallUsagePercent: null,
        perCore
      };
    }

    let totalDelta = 0;
    let idleDelta = 0;
    for (let index = 0; index < coreCount; index += 1) {
      const prev = previousTimes[index];
      const cur = currentTimes[index];
      const deltaTotal = Number(cur?.total || 0) - Number(prev?.total || 0);
      const deltaIdle = Number(cur?.idle || 0) - Number(prev?.idle || 0);
      const usage = deltaTotal > 0
        ? roundNumber(((deltaTotal - deltaIdle) / deltaTotal) * 100, 1)
        : null;
      perCore.push({
        index,
        usagePercent: usage
      });
      if (deltaTotal > 0) {
        totalDelta += deltaTotal;
        idleDelta += deltaIdle;
      }
    }

    const overallUsagePercent = totalDelta > 0
      ? roundNumber(((totalDelta - idleDelta) / totalDelta) * 100, 1)
      : null;
    return {
      overallUsagePercent,
      perCore
    };
  }

  async collectCpuMetrics() {
    const cpus = os.cpus() || [];
    const currentTimes = this.getCpuTimes();
    const usage = this.calculateCpuUsage(currentTimes, this.lastCpuTimes || []);
    this.lastCpuTimes = currentTimes;

    const tempMetrics = await this.collectCpuTemperatures();
    const tempByCoreIndex = new Map(
      (tempMetrics.perCore || []).map((item) => [Number(item.index), item.temperatureC])
    );

    const perCore = usage.perCore.map((entry) => ({
      index: entry.index,
      usagePercent: entry.usagePercent,
      temperatureC: tempByCoreIndex.has(entry.index) ? tempByCoreIndex.get(entry.index) : null
    }));

    for (const tempEntry of tempMetrics.perCore || []) {
      const index = Number(tempEntry?.index);
      if (!Number.isFinite(index) || perCore.some((item) => item.index === index)) {
        continue;
      }
      perCore.push({
        index,
        usagePercent: null,
        temperatureC: tempEntry.temperatureC
      });
    }
    perCore.sort((a, b) => a.index - b.index);

    return {
      model: cpus[0]?.model || null,
      logicalCoreCount: cpus.length,
      loadAverage: os.loadavg().map((value) => roundNumber(value, 2)),
      overallUsagePercent: usage.overallUsagePercent,
      overallTemperatureC: tempMetrics.overallC,
      usageAvailable: usage.overallUsagePercent !== null,
      temperatureAvailable: Boolean(tempMetrics.available),
      temperatureSource: tempMetrics.source,
      perCore
    };
  }

  async collectCpuTemperatures() {
    const sensors = await this.collectTempsViaSensors();
    if (sensors.available) {
      return sensors;
    }

    const hwmon = this.collectTempsViaHwmon();
    if (hwmon.available) {
      return hwmon;
    }

    const thermalZones = this.collectTempsViaThermalZones();
    if (thermalZones.available) {
      return thermalZones;
    }

    return {
      source: 'none',
      overallC: null,
      perCore: [],
      available: false
    };
  }

  async collectTempsViaSensors() {
    if (this.sensorsCommandAvailable === false) {
      return {
        source: 'sensors',
        overallC: null,
        perCore: [],
        available: false
      };
    }

    try {
      const { stdout } = await execFileAsync('sensors', ['-j'], {
        timeout: SENSORS_TIMEOUT_MS,
        maxBuffer: 2 * 1024 * 1024
      });
      this.sensorsCommandAvailable = true;
      const parsed = JSON.parse(String(stdout || '{}'));
      const candidates = collectTemperatureCandidates(parsed);
      const preferred = preferCpuTemperatureCandidates(candidates);
      return {
        source: 'sensors',
        ...mapTemperatureCandidates(preferred)
      };
    } catch (error) {
      if (isCommandMissingError(error)) {
        this.sensorsCommandAvailable = false;
      }
      logger.debug('cpu-temp:sensors:failed', { error: errorToMeta(error) });
      return {
        source: 'sensors',
        overallC: null,
        perCore: [],
        available: false
      };
    }
  }

  collectTempsViaHwmon() {
    const hwmonRoot = '/sys/class/hwmon';
    if (!fs.existsSync(hwmonRoot)) {
      return {
        source: 'hwmon',
        overallC: null,
        perCore: [],
        available: false
      };
    }

    const candidates = [];
    let dirs = [];
    try {
      dirs = fs.readdirSync(hwmonRoot, { withFileTypes: true });
    } catch (_error) {
      dirs = [];
    }

    for (const dir of dirs) {
      if (!dir.isDirectory()) {
        continue;
      }
      const basePath = path.join(hwmonRoot, dir.name);
      const sensorName = readTextFileSafe(path.join(basePath, 'name')) || dir.name;
      let files = [];
      try {
        files = fs.readdirSync(basePath);
      } catch (_error) {
        files = [];
      }
      const tempInputFiles = files.filter((file) => /^temp\d+_input$/i.test(file));

      for (const fileName of tempInputFiles) {
        const tempValue = normalizeTempC(readTextFileSafe(path.join(basePath, fileName)));
        if (tempValue === null) {
          continue;
        }
        const labelFile = fileName.replace('_input', '_label');
        const label = readTextFileSafe(path.join(basePath, labelFile)) || fileName;
        candidates.push({
          label: `${sensorName} / ${label}`,
          value: tempValue
        });
      }
    }

    return {
      source: 'hwmon',
      ...mapTemperatureCandidates(preferCpuTemperatureCandidates(candidates))
    };
  }

  collectTempsViaThermalZones() {
    const thermalRoot = '/sys/class/thermal';
    if (!fs.existsSync(thermalRoot)) {
      return {
        source: 'thermal_zone',
        overallC: null,
        perCore: [],
        available: false
      };
    }

    let files = [];
    try {
      files = fs.readdirSync(thermalRoot, { withFileTypes: true });
    } catch (_error) {
      files = [];
    }

    const candidates = [];
    for (const dir of files) {
      if (!dir.isDirectory() || !dir.name.startsWith('thermal_zone')) {
        continue;
      }
      const basePath = path.join(thermalRoot, dir.name);
      const tempC = normalizeTempC(readTextFileSafe(path.join(basePath, 'temp')));
      if (tempC === null) {
        continue;
      }
      const zoneType = readTextFileSafe(path.join(basePath, 'type')) || dir.name;
      candidates.push({
        label: `${zoneType} / temp`,
        value: tempC
      });
    }

    return {
      source: 'thermal_zone',
      ...mapTemperatureCandidates(preferCpuTemperatureCandidates(candidates))
    };
  }

  async collectGpuMetrics() {
    if (this.nvidiaSmiAvailable === false) {
      return {
        source: 'nvidia-smi',
        available: false,
        devices: [],
        message: 'nvidia-smi ist nicht verfuegbar.'
      };
    }

    try {
      const { stdout } = await execFileAsync(
        'nvidia-smi',
        [
          '--query-gpu=index,name,utilization.gpu,utilization.memory,temperature.gpu,memory.used,memory.total,power.draw,power.limit,fan.speed',
          '--format=csv,noheader,nounits'
        ],
        {
          timeout: NVIDIA_SMI_TIMEOUT_MS,
          maxBuffer: 1024 * 1024
        }
      );

      this.nvidiaSmiAvailable = true;
      const devices = String(stdout || '')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => parseNvidiaCsvLine(line))
        .filter(Boolean);

      if (devices.length === 0) {
        return {
          source: 'nvidia-smi',
          available: false,
          devices: [],
          message: 'Keine GPU-Daten ueber nvidia-smi erkannt.'
        };
      }

      return {
        source: 'nvidia-smi',
        available: true,
        devices,
        message: null
      };
    } catch (error) {
      const commandMissing = isCommandMissingError(error);
      if (commandMissing) {
        this.nvidiaSmiAvailable = false;
      }
      logger.debug('gpu:nvidia-smi:failed', { error: errorToMeta(error) });
      return {
        source: 'nvidia-smi',
        available: false,
        devices: [],
        message: commandMissing
          ? 'nvidia-smi ist nicht verfuegbar.'
          : (String(error?.stderr || error?.message || 'GPU-Abfrage fehlgeschlagen').trim().slice(0, 220))
      };
    }
  }

  async collectStorageMetrics() {
    const list = [];
    for (const entry of this.monitoredPaths) {
      list.push(await this.collectStorageForPath(entry));
    }
    return list;
  }

  findNearestExistingPath(inputPath) {
    const normalized = String(inputPath || '').trim();
    if (!normalized) {
      return null;
    }
    let candidate = path.resolve(normalized);
    for (let depth = 0; depth < 64; depth += 1) {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
      const parent = path.dirname(candidate);
      if (!parent || parent === candidate) {
        break;
      }
      candidate = parent;
    }
    if (fs.existsSync(candidate)) {
      return candidate;
    }
    return null;
  }

  async collectStorageForPath(entry) {
    const key = String(entry?.key || '');
    const label = String(entry?.label || key || 'Pfad');
    const rawPath = String(entry?.path || '').trim();
    if (!rawPath) {
      return {
        key,
        label,
        path: null,
        queryPath: null,
        exists: false,
        totalBytes: null,
        usedBytes: null,
        freeBytes: null,
        usagePercent: null,
        mountPoint: null,
        note: null,
        error: 'Pfad ist leer.'
      };
    }

    const resolvedPath = path.isAbsolute(rawPath) ? path.normalize(rawPath) : path.resolve(rawPath);
    const exists = fs.existsSync(resolvedPath);
    const queryPath = exists ? resolvedPath : this.findNearestExistingPath(resolvedPath);

    if (!queryPath) {
      return {
        key,
        label,
        path: resolvedPath,
        queryPath: null,
        exists: false,
        totalBytes: null,
        usedBytes: null,
        freeBytes: null,
        usagePercent: null,
        mountPoint: null,
        note: null,
        error: 'Pfad oder Parent existiert nicht.'
      };
    }

    try {
      const { stdout } = await execFileAsync('df', ['-Pk', queryPath], {
        timeout: DF_TIMEOUT_MS,
        maxBuffer: 256 * 1024
      });
      const parsed = parseDfStats(stdout);
      if (!parsed) {
        return {
          key,
          label,
          path: resolvedPath,
          queryPath,
          exists,
          totalBytes: null,
          usedBytes: null,
          freeBytes: null,
          usagePercent: null,
          mountPoint: null,
          note: exists ? null : `Pfad fehlt, Parent verwendet (${queryPath}).`,
          error: 'Dateisystemdaten konnten nicht geparst werden.'
        };
      }

      return {
        key,
        label,
        path: resolvedPath,
        queryPath,
        exists,
        ...parsed,
        note: exists ? null : `Pfad fehlt, Parent verwendet (${queryPath}).`,
        error: null
      };
    } catch (error) {
      return {
        key,
        label,
        path: resolvedPath,
        queryPath,
        exists,
        totalBytes: null,
        usedBytes: null,
        freeBytes: null,
        usagePercent: null,
        mountPoint: null,
        note: null,
        error: String(error?.message || 'df Abfrage fehlgeschlagen')
      };
    }
  }
}

module.exports = new HardwareMonitorService();
