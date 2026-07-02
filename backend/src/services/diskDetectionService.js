const fs = require('fs');
const { EventEmitter } = require('events');
const { execFile } = require('child_process');
const { promisify } = require('util');
const settingsService = require('./settingsService');
const logger = require('./logger').child('DISK');
const { parseToc } = require('./cdRipService');
const { errorToMeta } = require('../utils/errorMeta');

const execFileAsync = promisify(execFile);
const DEFAULT_POLL_INTERVAL_MS = 4000;
const MIN_POLL_INTERVAL_MS = 1000;
const MAX_POLL_INTERVAL_MS = 60000;

function toBoolean(value, fallback = false) {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return value !== 0;
  }
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) {
    return fallback;
  }
  if (normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on') {
    return true;
  }
  if (normalized === 'false' || normalized === '0' || normalized === 'no' || normalized === 'off') {
    return false;
  }
  return fallback;
}

function clampPollIntervalMs(rawValue) {
  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_POLL_INTERVAL_MS;
  }
  const clamped = Math.max(MIN_POLL_INTERVAL_MS, Math.min(MAX_POLL_INTERVAL_MS, Math.trunc(parsed)));
  return clamped || DEFAULT_POLL_INTERVAL_MS;
}

function flattenDevices(nodes, acc = []) {
  for (const node of nodes || []) {
    acc.push(node);
    if (Array.isArray(node.children)) {
      flattenDevices(node.children, acc);
    }
  }

  return acc;
}

function normalizeOpticalDevicePath(entry) {
  const directPath = String(entry?.path || '').trim();
  if (directPath) {
    return directPath;
  }
  const name = String(entry?.name || '').trim();
  return name ? `/dev/${name}` : '';
}

function compareOpticalDevicePaths(left, right) {
  return String(left || '').localeCompare(String(right || ''), undefined, {
    numeric: true,
    sensitivity: 'base'
  });
}

function buildMakeMkvIndexByDevicePath(entries = []) {
  const candidates = (Array.isArray(entries) ? entries : [])
    .filter((entry) => String(entry?.type || '').trim() === 'rom')
    .map((entry) => normalizeOpticalDevicePath(entry))
    .filter(Boolean);
  const sortedUniquePaths = Array.from(new Set(candidates)).sort(compareOpticalDevicePaths);
  const map = new Map();
  for (let index = 0; index < sortedUniquePaths.length; index += 1) {
    const devicePath = sortedUniquePaths[index];
    map.set(devicePath, index);
    const devName = devicePath.startsWith('/dev/') ? devicePath.slice(5) : '';
    if (devName) {
      map.set(devName, index);
    }
  }
  return map;
}

function buildSignature(info) {
  return `${info.path || ''}|${info.discLabel || ''}|${info.label || ''}|${info.model || ''}|${info.mountpoint || ''}|${info.fstype || ''}|${info.mediaProfile || ''}`;
}

function normalizeMediaProfile(rawValue) {
  const value = String(rawValue || '').trim().toLowerCase();
  if (!value) {
    return null;
  }
  if (
    value === 'bluray'
    || value === 'blu-ray'
    || value === 'blu_ray'
    || value === 'bd'
    || value === 'bdmv'
    || value === 'bdrom'
    || value === 'bd-rom'
    || value === 'bd-r'
    || value === 'bd-re'
  ) {
    return 'bluray';
  }
  if (
    value === 'dvd'
    || value === 'dvdvideo'
    || value === 'dvd-video'
    || value === 'dvdrom'
    || value === 'dvd-rom'
    || value === 'video_ts'
    || value === 'iso9660'
  ) {
    return 'dvd';
  }
  if (value === 'cd' || value === 'audio_cd') {
    return 'cd';
  }
  return null;
}

function isSpecificMediaProfile(value) {
  return value === 'bluray' || value === 'dvd' || value === 'cd';
}

function inferMediaProfileFromTextParts(parts) {
  const markerText = (parts || [])
    .map((value) => String(value || '').trim().toLowerCase())
    .filter(Boolean)
    .join(' ');

  if (!markerText) {
    return null;
  }
  if (/(^|[\s_-])bdmv($|[\s_-])|blu[\s-]?ray|bd[\s_-]?rom|bd-r|bd-re/.test(markerText)) {
    return 'bluray';
  }
  if (/(^|[\s_-])video_ts($|[\s_-])|dvd|iso9660/.test(markerText)) {
    return 'dvd';
  }
  return null;
}

function inferMediaProfileFromFsTypeAndModel(rawFsType, rawModel) {
  const fstype = String(rawFsType || '').trim().toLowerCase();
  if (fstype === 'audio_cd') {
    return 'cd';
  }
  const model = String(rawModel || '').trim().toLowerCase();
  const hasBlurayModelMarker = /(blu[\s-]?ray|bd[\s_-]?rom|bd-r|bd-re)/.test(model);
  const hasDvdModelMarker = /dvd/.test(model);
  const hasCdOnlyModelMarker = /(^|[\s_-])cd([\s_-]|$)|cd-?rom/.test(model) && !hasBlurayModelMarker && !hasDvdModelMarker;

  if (!fstype) {
    if (hasBlurayModelMarker) {
      return 'bluray';
    }
    if (hasDvdModelMarker) {
      return 'dvd';
    }
    return null;
  }

  if (fstype.includes('udf')) {
    // UDF is used by both DVDs (UDF 1.x) and Blu-rays (UDF 2.x).
    // Drive model alone (hasBlurayModelMarker) is not reliable: a BD-ROM drive
    // with a DVD inside would incorrectly be detected as Blu-ray.
    // Return null so UDF version detection via blkid can decide.
    if (hasBlurayModelMarker) {
      return null;
    }
    if (hasDvdModelMarker) {
      return 'dvd';
    }
    return 'dvd';
  }

  if (fstype.includes('iso9660') || fstype.includes('cdfs')) {
    // iso9660/cdfs is never used by Blu-ray discs (they use UDF 2.x).
    // Ignore hasBlurayModelMarker – it only reflects drive capability.
    if (hasCdOnlyModelMarker) {
      return 'other';
    }
    return 'dvd';
  }

  return null;
}

function isIsoLikeFsType(rawFsType) {
  const fstype = String(rawFsType || '').trim().toLowerCase();
  return fstype.includes('iso9660') || fstype.includes('cdfs');
}

function inferMediaProfileFromUdevProperties(properties = {}) {
  const flags = Object.entries(properties).reduce((acc, [key, rawValue]) => {
    const normalizedKey = String(key || '').trim().toUpperCase();
    if (!normalizedKey) {
      return acc;
    }

    acc[normalizedKey] = String(rawValue || '').trim();
    return acc;
  }, {});

  const parseTrackCount = (rawValue) => {
    const normalized = String(rawValue ?? '').trim();
    if (!normalized) {
      return null;
    }
    const parsed = Number.parseInt(normalized, 10);
    if (!Number.isFinite(parsed) || parsed < 0) {
      return null;
    }
    return parsed;
  };

  const hasExactFlag = (key) => flags[String(key || '').trim().toUpperCase()] === '1';
  // Only use exact media-presence keys here. Prefix matching would also catch
  // drive capability flags (e.g. ID_CDROM_MEDIA_BD_R=1) and misclassify DVDs
  // in BD-capable drives as Blu-ray media.
  const hasBD = hasExactFlag('ID_CDROM_MEDIA_BD');
  const hasDVD = hasExactFlag('ID_CDROM_MEDIA_DVD');
  const hasCD = hasExactFlag('ID_CDROM_MEDIA_CD');
  const audioTrackCount = parseTrackCount(flags.ID_CDROM_MEDIA_TRACK_COUNT_AUDIO);
  const dataTrackCount = parseTrackCount(flags.ID_CDROM_MEDIA_TRACK_COUNT_DATA);
  const hasAudioTracks = Number.isFinite(audioTrackCount) && audioTrackCount > 0;
  const hasDataTracks = Number.isFinite(dataTrackCount) && dataTrackCount > 0;

  // Prefer audio-CD detection when udev exposes track counters.
  if (hasCD && hasAudioTracks && !hasDataTracks) {
    return 'cd';
  }
  if (hasCD && !hasDVD && !hasBD) {
    return 'cd';
  }
  if (hasBD) {
    return 'bluray';
  }
  if (hasDVD) {
    return 'dvd';
  }
  if (hasCD) {
    return 'cd';
  }
  return null;
}

class DiskDetectionService extends EventEmitter {
  constructor() {
    super();
    this.running = false;
    this.timer = null;
    this.lastDetected = null;
    this.lastPresent = false;
    this.detectedDiscs = new Map(); // devicePath → device object (multi-drive tracking)
    this.deviceLocks = new Map();
    this.pollingSuspended = false;
  }

  start() {
    if (this.running) {
      return;
    }
    this.running = true;
    logger.info('start');
    this.scheduleNext(1000);
  }

  stop() {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    logger.info('stop');
  }

  suspendPolling() {
    if (!this.pollingSuspended) {
      this.pollingSuspended = true;
      logger.info('polling:suspended');
    }
  }

  resumePolling() {
    if (this.pollingSuspended) {
      this.pollingSuspended = false;
      logger.info('polling:resumed');
    }
  }

  scheduleNext(delayMs) {
    if (!this.running) {
      return;
    }

    this.timer = setTimeout(async () => {
      let nextDelay = DEFAULT_POLL_INTERVAL_MS;

      try {
        const map = await settingsService.getSettingsMap();
        nextDelay = clampPollIntervalMs(map.disc_poll_interval_ms);
        const autoDetectionEnabled = toBoolean(map.disc_auto_detection_enabled, true);
        logger.debug('poll:tick', {
          driveMode: map.drive_mode,
          driveDevice: map.drive_device,
          nextDelay,
          autoDetectionEnabled,
          suspended: this.pollingSuspended
        });
        if (this.pollingSuspended) {
          logger.debug('poll:skip:suspended', { nextDelay });
        } else if (autoDetectionEnabled) {
          const detectedList = await this.detectAllDiscs(map);
          this.applyMultiDetectionResults(detectedList, { forceInsertEvent: false });
        } else {
          logger.debug('poll:skip:auto-detection-disabled', { nextDelay });
        }
      } catch (error) {
        logger.error('poll:error', { error: errorToMeta(error) });
        this.emit('error', error);
      }

      this.scheduleNext(nextDelay);
    }, delayMs);
  }

  async rescanAndEmit() {
    try {
      const map = await settingsService.getSettingsMap();
      logger.info('rescan:requested', {
        driveMode: map.drive_mode,
        driveDevice: map.drive_device
      });

      const detectedList = await this.detectAllDiscs(map);
      const results = this.applyMultiDetectionResults(detectedList, { forceInsertEvent: true });

      const insertedResults = results.filter((r) => r.emitted === 'discInserted');
      const removedResults = results.filter((r) => r.emitted === 'discRemoved');
      const present = detectedList.length > 0;
      const firstInserted = insertedResults[0] || null;

      logger.info('rescan:done', {
        driveCount: detectedList.length,
        inserted: insertedResults.length,
        removed: removedResults.length
      });

      // Backward-compat return: report on first inserted device (or removed if nothing inserted)
      return {
        present,
        changed: insertedResults.length > 0 || removedResults.length > 0,
        emitted: insertedResults.length > 0
          ? 'discInserted'
          : (removedResults.length > 0 ? 'discRemoved' : 'none'),
        device: firstInserted?.device || null,
        allDetected: detectedList
      };
    } catch (error) {
      logger.error('rescan:error', { error: errorToMeta(error) });
      throw error;
    }
  }

  normalizeDevicePath(devicePath) {
    return String(devicePath || '').trim();
  }

  _resolveDeviceRealPath(devicePath) {
    const normalized = this.normalizeDevicePath(devicePath);
    if (!normalized || !normalized.startsWith('/')) {
      return null;
    }
    try {
      if (fs.realpathSync && typeof fs.realpathSync.native === 'function') {
        return fs.realpathSync.native(normalized);
      }
      return fs.realpathSync(normalized);
    } catch (_error) {
      return null;
    }
  }

  _deviceBaseName(devicePath) {
    const normalized = this.normalizeDevicePath(devicePath);
    if (!normalized) {
      return '';
    }
    const parts = normalized.split('/').filter(Boolean);
    return String(parts[parts.length - 1] || '').trim();
  }

  _isSameDevicePath(leftPath, rightPath) {
    const left = this.normalizeDevicePath(leftPath);
    const right = this.normalizeDevicePath(rightPath);
    if (!left || !right) {
      return false;
    }
    if (left === right) {
      return true;
    }
    const leftReal = this._resolveDeviceRealPath(left);
    const rightReal = this._resolveDeviceRealPath(right);
    if (leftReal && rightReal && leftReal === rightReal) {
      return true;
    }
    const leftBase = this._deviceBaseName(left);
    const rightBase = this._deviceBaseName(right);
    if (leftBase && rightBase && leftBase === rightBase && /^sr\d+$/i.test(leftBase)) {
      return true;
    }
    return false;
  }

  _resolveLockKey(devicePath) {
    const normalized = this.normalizeDevicePath(devicePath);
    if (!normalized) {
      return null;
    }
    return this._resolveDeviceRealPath(normalized) || normalized;
  }

  lockDevice(devicePath, owner = null) {
    const lockKey = this._resolveLockKey(devicePath);
    if (!lockKey) {
      return null;
    }

    const entry = this.deviceLocks.get(lockKey) || {
      count: 0,
      owners: []
    };

    entry.count += 1;
    if (owner) {
      entry.owners.push(owner);
    }
    this.deviceLocks.set(lockKey, entry);

    logger.info('lock:add', {
      devicePath: lockKey,
      count: entry.count,
      owner
    });

    return {
      devicePath: lockKey,
      owner
    };
  }

  unlockDevice(devicePath, owner = null) {
    const normalized = this.normalizeDevicePath(devicePath);
    if (!normalized) {
      return;
    }

    const directKey = this._resolveLockKey(normalized);
    const candidateKeys = Array.from(this.deviceLocks.keys());
    const lockKey = (directKey && this.deviceLocks.has(directKey))
      ? directKey
      : (candidateKeys.find((key) => this._isSameDevicePath(key, normalized)) || null);
    if (!lockKey) {
      return;
    }

    const entry = this.deviceLocks.get(lockKey);
    if (!entry) {
      return;
    }

    entry.count = Math.max(0, entry.count - 1);
    if (entry.count === 0) {
      this.deviceLocks.delete(lockKey);
      logger.info('lock:remove', {
        devicePath: lockKey,
        owner
      });
      return;
    }

    this.deviceLocks.set(lockKey, entry);
    logger.info('lock:decrement', {
      devicePath: lockKey,
      count: entry.count,
      owner
    });
  }

  forceUnlockDevice(devicePath, options = {}) {
    const normalized = this.normalizeDevicePath(devicePath);
    if (!normalized) {
      return 0;
    }

    const candidateKeys = Array.from(this.deviceLocks.keys())
      .filter((key) => this._isSameDevicePath(key, normalized));
    if (candidateKeys.length === 0) {
      return 0;
    }

    let removed = 0;
    for (const lockKey of candidateKeys) {
      const entry = this.deviceLocks.get(lockKey);
      const previousCount = Math.max(0, Number(entry?.count) || 0);
      removed += previousCount;
      this.deviceLocks.delete(lockKey);
      logger.warn('lock:force-remove', {
        devicePath: lockKey,
        previousCount,
        reason: String(options?.reason || '').trim() || null,
        deletedJobIds: Array.isArray(options?.deletedJobIds) ? options.deletedJobIds : []
      });
    }
    return removed;
  }

  isDeviceLocked(devicePath) {
    const normalized = this.normalizeDevicePath(devicePath);
    if (!normalized) {
      return false;
    }
    const directKey = this._resolveLockKey(normalized);
    if (directKey && this.deviceLocks.has(directKey)) {
      return true;
    }
    return Array.from(this.deviceLocks.keys()).some((key) => this._isSameDevicePath(key, normalized));
  }

  getActiveLocks() {
    return Array.from(this.deviceLocks.entries()).map(([path, info]) => ({
      path,
      count: info.count,
      owners: info.owners
    }));
  }

  applyDetectionResult(detected, { forceInsertEvent = false } = {}) {
    const isPresent = Boolean(detected);
    const changed =
      isPresent &&
      (!this.lastDetected || buildSignature(this.lastDetected) !== buildSignature(detected));

    if (isPresent) {
      const shouldEmitInserted = forceInsertEvent || !this.lastPresent || changed;
      this.lastDetected = detected;
      this.lastPresent = true;

      if (shouldEmitInserted) {
        logger.info('disc:inserted', { detected, forceInsertEvent, changed });
        this.emit('discInserted', detected);
        return {
          present: true,
          changed,
          emitted: 'discInserted',
          device: detected
        };
      }

      return {
        present: true,
        changed,
        emitted: 'none',
        device: detected
      };
    }

    if (!isPresent && this.lastPresent) {
      const removed = this.lastDetected;
      this.lastDetected = null;
      this.lastPresent = false;
      logger.info('disc:removed', { removed });
      this.emit('discRemoved', removed);
      return {
        present: false,
        changed: true,
        emitted: 'discRemoved',
        device: null
      };
    }

    return {
      present: false,
      changed: false,
      emitted: 'none',
      device: null
    };
  }

  async detectDisc(settingsMap) {
    if (settingsMap.drive_mode === 'explicit') {
      return this.detectExplicit(settingsMap.drive_device);
    }

    return this.detectAuto();
  }

  // Returns ALL discs with media (not just the first one)
  async detectAllDiscs(settingsMap) {
    if (settingsMap.drive_mode === 'explicit') {
      // drive_devices is a JSON array of paths; fall back to legacy drive_device
      let explicitPaths = [];
      try {
        const parsed = JSON.parse(settingsMap.drive_devices || '[]');
        if (Array.isArray(parsed)) {
          explicitPaths = parsed
            .map((e) => (typeof e === 'string' ? e.trim() : String(e?.path || '').trim()))
            .filter(Boolean);
        }
      } catch (_error) {
        // malformed JSON — ignore, fall through to legacy
      }
      if (explicitPaths.length === 0) {
        const legacy = String(settingsMap.drive_device || '').trim();
        if (legacy) {
          explicitPaths = [legacy];
        }
      }
      const results = await Promise.all(explicitPaths.map((p) => this.detectExplicit(p)));
      return results.filter(Boolean);
    }

    // Auto mode: scan all ROM drives via lsblk
    const autoResults = await this.detectAllAuto();

    // Fallback: if lsblk found no ROM drives but drive_device is configured, try it directly
    if (autoResults.length === 0) {
      const legacy = String(settingsMap.drive_device || '').trim();
      if (legacy) {
        logger.debug('detect:auto:lsblk-empty-fallback-explicit', { legacy });
        const legacyResult = await this.detectExplicit(legacy);
        if (legacyResult) {
          return [legacyResult];
        }
      }
    }

    // Supplement: any drive already tracked in detectedDiscs that was not found by auto-scan
    // gets a second chance via detectExplicit (which includes the sysfs-size fallback).
    // This prevents polling from falsely emitting discRemoved for drives that were manually
    // rescanned but cannot be auto-detected (e.g. VM/passthrough devices invisible to lsblk).
    const foundPaths = new Set(autoResults.map((d) => String(d.path || '')));
    const supplementChecks = [];
    for (const [trackedPath] of this.detectedDiscs) {
      if (!trackedPath.startsWith('__virtual__') && !foundPaths.has(trackedPath)) {
        supplementChecks.push(this.detectExplicit(trackedPath));
      }
    }
    if (supplementChecks.length > 0) {
      const supplementResults = await Promise.all(supplementChecks);
      for (const result of supplementResults) {
        if (result) {
          autoResults.push(result);
        }
      }
    }

    return autoResults;
  }

  // Rescan a single specific drive and emit the appropriate event
  async rescanDriveAndEmit(devicePath) {
    const normalized = this.normalizeDevicePath(devicePath);
    if (!normalized) {
      return { present: false, emitted: 'none', device: null };
    }
    if (this.isDeviceLocked(normalized)) {
      const existing = this.detectedDiscs.get(normalized) || null;
      logger.info('rescan-drive:skip-locked', {
        devicePath: normalized,
        activeLocks: this.getActiveLocks()
      });
      return {
        present: Boolean(existing),
        emitted: 'none',
        device: existing,
        locked: true
      };
    }
    try {
      logger.info('rescan-drive:requested', { devicePath: normalized });
      const detected = await this.detectExplicit(normalized);
      const previouslyTracked = this.detectedDiscs.has(normalized);

      if (detected) {
        const previous = this.detectedDiscs.get(normalized);
        const changed = previous ? buildSignature(previous) !== buildSignature(detected) : false;
        this.detectedDiscs.set(normalized, detected);
        this.lastDetected = detected;
        this.lastPresent = true;
        logger.info('rescan-drive:inserted', { devicePath: normalized, changed });
        this.emit('discInserted', detected);
        return { present: true, emitted: 'discInserted', device: detected };
      }

      // No disc found
      if (previouslyTracked) {
        const old = this.detectedDiscs.get(normalized);
        this.detectedDiscs.delete(normalized);
        if (this.detectedDiscs.size === 0) {
          this.lastDetected = null;
          this.lastPresent = false;
        }
        logger.info('rescan-drive:removed', { devicePath: normalized });
        this.emit('discRemoved', old || { path: normalized });
        return { present: false, emitted: 'discRemoved', device: null };
      }

      logger.info('rescan-drive:empty', { devicePath: normalized });
      return { present: false, emitted: 'none', device: null };
    } catch (error) {
      logger.error('rescan-drive:error', { devicePath: normalized, error: errorToMeta(error) });
      throw error;
    }
  }

  // Multi-drive: tracks per-device state and emits insert/remove events for each
  applyMultiDetectionResults(detectedList, { forceInsertEvent = false } = {}) {
    const detected = Array.isArray(detectedList) ? detectedList : [];
    const newMap = new Map();
    for (const device of detected) {
      if (device?.path) {
        newMap.set(device.path, device);
      }
    }

    const results = [];

    // Check for new or changed devices
    for (const [devicePath, device] of newMap) {
      const previous = this.detectedDiscs.get(devicePath);
      const changed = previous ? buildSignature(previous) !== buildSignature(device) : false;
      const shouldEmitInserted = forceInsertEvent || !previous || changed;
      if (shouldEmitInserted) {
        logger.info('disc:inserted', { device, forceInsertEvent, changed });
        this.emit('discInserted', device);
        results.push({ path: devicePath, emitted: 'discInserted', device });
      } else {
        results.push({ path: devicePath, emitted: 'none', device });
      }
    }

    // Preserve currently tracked locked devices that are intentionally skipped
    // by detectAll* while a rip lock is active.
    for (const [devicePath, device] of this.detectedDiscs) {
      if (newMap.has(devicePath) || !this.isDeviceLocked(devicePath)) {
        continue;
      }
      newMap.set(devicePath, device);
      results.push({ path: devicePath, emitted: 'none', device, locked: true });
    }

    // Check for removed devices
    for (const [devicePath, device] of this.detectedDiscs) {
      if (!newMap.has(devicePath)) {
        logger.info('disc:removed', { device });
        this.emit('discRemoved', device);
        results.push({ path: devicePath, emitted: 'discRemoved', device: null });
      }
    }

    this.detectedDiscs = newMap;

    // Update legacy single-disc tracking for backward compat
    if (newMap.size > 0) {
      this.lastDetected = Array.from(newMap.values())[0];
      this.lastPresent = true;
    } else {
      if (this.lastPresent) {
        this.lastDetected = null;
        this.lastPresent = false;
      }
    }

    return results;
  }

  async detectExplicit(devicePath) {
    if (this.isDeviceLocked(devicePath)) {
      logger.debug('detect:explicit:locked', {
        devicePath,
        activeLocks: this.getActiveLocks()
      });
      return null;
    }

    if (!devicePath || !fs.existsSync(devicePath)) {
      logger.debug('detect:explicit:not-found', { devicePath });
      return null;
    }

    const details = await this.getBlockDeviceInfo();
    const makemkvIndexByPath = buildMakeMkvIndexByDevicePath(details);
    const match = details.find((entry) => entry.path === devicePath || `/dev/${entry.name}` === devicePath) || {};
    const inferredIndex = Number(
      makemkvIndexByPath.get(devicePath)
      ?? makemkvIndexByPath.get(match.name || '')
      ?? match.makemkvIndex
    );

    // Always call checkMediaPresent to get the filesystem type (needed for accurate
    // mediaProfile detection). Use lsblk SIZE as fallback presence indicator for
    // drives where blkid/udevadm fail (VM/passthrough).
    const mediaState = await this.checkMediaPresent(devicePath);
    const hasSizeMedia = (match.sizeBytes || 0) > 0;
    if (!mediaState.hasMedia && !hasSizeMedia) {
      logger.debug('detect:explicit:no-media', { devicePath });
      return null;
    }
    if (!mediaState.hasMedia && hasSizeMedia) {
      logger.debug('detect:explicit:media-by-size-fallback', { devicePath, sizeBytes: match.sizeBytes });
    }
    const mediaType = String(mediaState.type || '').trim().toLowerCase() || null;
    const discLabel = await this.getDiscLabel(devicePath);
    // Preserve explicit audio-CD detection from checkMediaPresent even if lsblk
    // reports ambiguous optical fs markers like iso9660/cdfs.
    const detectedFsType = String(
      mediaType === 'audio_cd'
        ? mediaType
        : (match.fstype || mediaType || '')
    ).trim() || null;

    const mediaProfile = await this.inferMediaProfile(devicePath, {
      discLabel,
      label: match.label,
      model: match.model,
      fstype: detectedFsType,
      mountpoint: match.mountpoint
    });

    const detected = {
      mode: 'explicit',
      path: devicePath,
      name: match.name || devicePath.split('/').pop(),
      model: match.model || 'Unknown',
      label: match.label || null,
      discLabel: discLabel || null,
      mountpoint: match.mountpoint || null,
      fstype: detectedFsType,
      mediaProfile: mediaProfile || null,
      index: Number.isFinite(inferredIndex) && inferredIndex >= 0
        ? Math.trunc(inferredIndex)
        : this.guessDiscIndex(match.name || devicePath)
    };
    logger.debug('detect:explicit:success', { detected });
    return detected;
  }

  async detectAuto() {
    const details = await this.getBlockDeviceInfo();
    const makemkvIndexByPath = buildMakeMkvIndexByDevicePath(details);
    const romCandidates = details.filter((entry) => entry.type === 'rom');

    for (const item of romCandidates) {
      const path = item.path || (item.name ? `/dev/${item.name}` : null);
      if (!path) {
        continue;
      }

      if (this.isDeviceLocked(path)) {
        logger.debug('detect:auto:skip-locked', {
          path,
          activeLocks: this.getActiveLocks()
        });
        continue;
      }

      const mediaState = await this.checkMediaPresent(path);
      if (!mediaState.hasMedia) {
        continue;
      }
      const mediaType = String(mediaState.type || '').trim().toLowerCase() || null;
      const discLabel = await this.getDiscLabel(path);
      const detectedFsType = String(
        mediaType === 'audio_cd'
          ? mediaType
          : (item.fstype || mediaType || '')
      ).trim() || null;

      const mediaProfile = await this.inferMediaProfile(path, {
        discLabel,
        label: item.label,
        model: item.model,
        fstype: detectedFsType,
        mountpoint: item.mountpoint
      });
      const detectedIndex = Number(
        makemkvIndexByPath.get(path)
        ?? makemkvIndexByPath.get(item.name || '')
        ?? item.makemkvIndex
      );

      const detected = {
        mode: 'auto',
        path,
        name: item.name,
        model: item.model || 'Optical Drive',
        label: item.label || null,
        discLabel: discLabel || null,
        mountpoint: item.mountpoint || null,
        fstype: detectedFsType,
        mediaProfile: mediaProfile || null,
        index: Number.isFinite(detectedIndex) && detectedIndex >= 0
          ? Math.trunc(detectedIndex)
          : this.guessDiscIndex(item.name)
      };
      logger.debug('detect:auto:success', { detected });
      return detected;
    }

    logger.debug('detect:auto:none');
    return null;
  }

  async detectAllAuto() {
    const details = await this.getBlockDeviceInfo();
    const makemkvIndexByPath = buildMakeMkvIndexByDevicePath(details);
    const romCandidates = details.filter((entry) => entry.type === 'rom');
    const results = [];

    for (const item of romCandidates) {
      const path = item.path || (item.name ? `/dev/${item.name}` : null);
      if (!path) {
        continue;
      }

      if (this.isDeviceLocked(path)) {
        logger.debug('detect:all-auto:skip-locked', {
          path,
          activeLocks: this.getActiveLocks()
        });
        continue;
      }

      // Always call checkMediaPresent to get the filesystem type (needed for accurate
      // mediaProfile detection via inferMediaProfile). Use lsblk SIZE as a fallback
      // presence indicator for drives where blkid/udevadm fail (VM/passthrough).
      const mediaState = await this.checkMediaPresent(path);
      const hasSizeMedia = item.sizeBytes > 0;
      if (!mediaState.hasMedia && !hasSizeMedia) {
        logger.debug('detect:all-auto:no-media', { path, sizeBytes: item.sizeBytes });
        continue;
      }
      if (!mediaState.hasMedia && hasSizeMedia) {
        logger.debug('detect:all-auto:media-by-size-fallback', { path, sizeBytes: item.sizeBytes });
      }
      const mediaType = String(mediaState.type || '').trim().toLowerCase() || null;
      const discLabel = await this.getDiscLabel(path);
      const detectedFsType = String(
        mediaType === 'audio_cd'
          ? mediaType
          : (item.fstype || mediaType || '')
      ).trim() || null;

      const mediaProfile = await this.inferMediaProfile(path, {
        discLabel,
        label: item.label,
        model: item.model,
        fstype: detectedFsType,
        mountpoint: item.mountpoint
      });
      const detectedIndex = Number(
        makemkvIndexByPath.get(path)
        ?? makemkvIndexByPath.get(item.name || '')
        ?? item.makemkvIndex
      );

      const detected = {
        mode: 'auto',
        path,
        name: item.name,
        model: item.model || 'Optical Drive',
        label: item.label || null,
        discLabel: discLabel || null,
        mountpoint: item.mountpoint || null,
        fstype: detectedFsType,
        mediaProfile: mediaProfile || null,
        index: Number.isFinite(detectedIndex) && detectedIndex >= 0
          ? Math.trunc(detectedIndex)
          : this.guessDiscIndex(item.name)
      };
      logger.debug('detect:all-auto:found', { detected });
      results.push(detected);
    }

    logger.debug('detect:all-auto:done', { count: results.length });
    return results;
  }

  async getBlockDeviceInfo() {
    try {
      const { stdout } = await execFileAsync('lsblk', [
        '-J',
        '-b',
        '-o',
        'NAME,PATH,TYPE,MOUNTPOINT,FSTYPE,LABEL,MODEL,SIZE'
      ]);
      const parsed = JSON.parse(stdout);
      const devices = flattenDevices(parsed.blockdevices || []).map((entry) => ({
        name: entry.name,
        path: entry.path,
        type: entry.type,
        mountpoint: entry.mountpoint,
        fstype: entry.fstype,
        label: entry.label,
        model: entry.model,
        sizeBytes: Number(entry.size) || 0
      }));
      const makemkvIndexByPath = buildMakeMkvIndexByDevicePath(devices);
      const withMakeMkvIndex = devices.map((entry) => {
        if (entry.type !== 'rom') {
          return { ...entry, makemkvIndex: null };
        }
        const devicePath = normalizeOpticalDevicePath(entry);
        const inferredIndex = Number(
          makemkvIndexByPath.get(devicePath)
          ?? makemkvIndexByPath.get(entry.name || '')
        );
        return {
          ...entry,
          makemkvIndex: Number.isFinite(inferredIndex) && inferredIndex >= 0
            ? Math.trunc(inferredIndex)
            : null
        };
      });
      logger.debug('lsblk:ok', { deviceCount: devices.length });
      return withMakeMkvIndex;
    } catch (error) {
      logger.warn('lsblk:failed', { error: errorToMeta(error) });
      return [];
    }
  }

  async probeAudioCdWithCdparanoia(devicePath, command = 'cdparanoia') {
    const cdparanoiaCmd = String(command || '').trim() || 'cdparanoia';
    try {
      const { stdout, stderr } = await execFileAsync(cdparanoiaCmd, ['-Q', '-d', devicePath], { timeout: 10000 });
      const tracks = parseToc(`${stderr || ''}\n${stdout || ''}`);
      if (tracks.length > 0) {
        logger.debug('cdparanoia:audio-cd', { devicePath, cmd: cdparanoiaCmd, trackCount: tracks.length });
        return true;
      }
      logger.debug('cdparanoia:audio-cd-exit-0-no-parse', { devicePath, cmd: cdparanoiaCmd });
      return true;
    } catch (error) {
      const stderr = String(error?.stderr || '');
      const stdout = String(error?.stdout || '');
      const tracks = parseToc(`${stderr}\n${stdout}`);
      if (tracks.length > 0) {
        logger.debug('cdparanoia:audio-cd-from-error-streams', {
          devicePath,
          cmd: cdparanoiaCmd,
          trackCount: tracks.length
        });
        return true;
      }
      logger.debug('cdparanoia:no-audio-cd', {
        devicePath,
        cmd: cdparanoiaCmd,
        error: errorToMeta(error)
      });
      return false;
    }
  }

  async checkMediaPresent(devicePath) {
    let blkidType = null;
    let blkidError = null;
    try {
      const { stdout } = await execFileAsync('blkid', ['-o', 'value', '-s', 'TYPE', devicePath]);
      blkidType = String(stdout || '').trim().toLowerCase() || null;
    } catch (_error) {
      blkidError = String(_error?.message || _error || 'unknown');
      // blkid failed – could mean no disc, or an audio CD (no filesystem type)
    }
    logger.info('check-media:blkid', { devicePath, blkidType, blkidError });

    if (blkidType) {
      return { hasMedia: true, type: blkidType };
    }

    let hasOpticalMediaHintFromUdev = false;

    // blkid found nothing – audio CDs have no filesystem, so fall back to udevadm
    try {
      const { stdout } = await execFileAsync('udevadm', [
        'info',
        '--query=property',
        '--name',
        devicePath
      ]);
      const props = {};
      for (const line of String(stdout || '').split(/\r?\n/)) {
        const idx = line.indexOf('=');
        if (idx <= 0) {
          continue;
        }
        props[line.slice(0, idx).trim().toUpperCase()] = line.slice(idx + 1).trim();
      }
      const inferredByUdev = inferMediaProfileFromUdevProperties(props);
      const audioTrackCount = Number.parseInt(String(props.ID_CDROM_MEDIA_TRACK_COUNT_AUDIO || '').trim(), 10);
      const dataTrackCount = Number.parseInt(String(props.ID_CDROM_MEDIA_TRACK_COUNT_DATA || '').trim(), 10);
      logger.info('check-media:udevadm', {
        devicePath,
        inferredByUdev,
        audioTrackCount: Number.isFinite(audioTrackCount) ? audioTrackCount : null,
        dataTrackCount: Number.isFinite(dataTrackCount) ? dataTrackCount : null
      });
      if (inferredByUdev === 'cd') {
        logger.debug('udevadm:audio-cd', { devicePath });
        return { hasMedia: true, type: 'audio_cd' };
      }
      if (inferredByUdev === 'bluray' || inferredByUdev === 'dvd') {
        logger.debug('udevadm:optical-media', { devicePath, inferredByUdev });
        // Keep this as a presence hint, but still probe cdparanoia. Some drives
        // expose mixed DVD/CD flags for audio CDs and would otherwise be
        // downgraded to "other" before TOC probing.
        hasOpticalMediaHintFromUdev = true;
      }
    } catch (_udevError) {
      // udevadm not available or failed – ignore
    }

    // Last resort: cdparanoia can read the TOC of audio CDs directly.
    // Useful when udev media flags are not propagated (e.g. VM passthrough).
    // Some builds return non-zero even when TOC output exists, so parse both
    // stdout/stderr and treat valid TOC lines as "audio CD present".
    // Keep compatibility with previous behavior: exit 0 counts as media even
    // when TOC output format cannot be parsed.
    const hasAudioCdToc = await this.probeAudioCdWithCdparanoia(devicePath);
    if (hasAudioCdToc) {
      return { hasMedia: true, type: 'audio_cd' };
    }

    if (hasOpticalMediaHintFromUdev) {
      return { hasMedia: true, type: null };
    }

    // Final fallback: check block device size via sysfs.
    // In VM/passthrough environments udev metadata may be absent even though
    // the kernel reports a valid disc size (visible in lsblk). A non-zero
    // 512-byte block count means media is physically present.
    try {
      const devName = String(devicePath || '').split('/').pop();
      if (devName) {
        const sizeStr = fs.readFileSync(`/sys/block/${devName}/size`, 'utf8').trim();
        const sizeBlocks = parseInt(sizeStr, 10);
        if (Number.isFinite(sizeBlocks) && sizeBlocks > 0) {
          logger.info('check-media:sysfs-size', { devicePath, sizeBlocks });
          return { hasMedia: true, type: null };
        }
      }
    } catch (_sysError) {
      // sysfs not available or device not found there
    }

    logger.debug('blkid:no-media-or-fail', { devicePath });
    return { hasMedia: false, type: null };
  }

  async getDiscLabel(devicePath) {
    try {
      const { stdout } = await execFileAsync('blkid', ['-o', 'value', '-s', 'LABEL', devicePath]);
      const label = stdout.trim();
      logger.debug('blkid:label', { devicePath, discLabel: label || null });
      return label || null;
    } catch (error) {
      logger.debug('blkid:no-label', { devicePath, error: errorToMeta(error) });
      return null;
    }
  }

  async inferMediaProfileFromUdev(devicePath) {
    const normalizedPath = String(devicePath || '').trim();
    if (!normalizedPath) {
      return null;
    }

    try {
      const { stdout } = await execFileAsync('udevadm', ['info', '--query=property', '--name', normalizedPath]);
      const properties = {};
      for (const line of String(stdout || '').split(/\r?\n/)) {
        const idx = line.indexOf('=');
        if (idx <= 0) {
          continue;
        }
        const key = String(line.slice(0, idx)).trim();
        const value = String(line.slice(idx + 1)).trim();
        if (!key) {
          continue;
        }
        properties[key] = value;
      }

      const inferred = inferMediaProfileFromUdevProperties(properties);
      if (inferred) {
        logger.debug('udev:media-profile', { devicePath: normalizedPath, inferred });
      }
      return inferred;
    } catch (error) {
      logger.debug('udev:media-profile:failed', {
        devicePath: normalizedPath,
        error: errorToMeta(error)
      });
      return null;
    }
  }

  async inferMediaProfile(devicePath, hints = {}) {
    // Audio CDs have no filesystem – short-circuit immediately
    if (String(hints?.fstype || '').trim().toLowerCase() === 'audio_cd') {
      return 'cd';
    }

    const explicit = normalizeMediaProfile(hints?.mediaProfile);
    if (isSpecificMediaProfile(explicit)) {
      return explicit;
    }

    // Only pass disc-specific fields – NOT hints?.model (drive model).
    // Drive model (e.g. "BD-ROM") reflects drive capability, not disc type.
    // A BD-ROM drive with a DVD would otherwise be detected as Blu-ray here.
    const hinted = inferMediaProfileFromTextParts([
      hints?.discLabel,
      hints?.label,
      hints?.fstype,
    ]);
    if (hinted) {
      return hinted;
    }

    const mountpoint = String(hints?.mountpoint || '').trim();
    if (mountpoint) {
      try {
        if (fs.existsSync(`${mountpoint}/BDMV`)) {
          return 'bluray';
        }
      } catch (_error) {
        // ignore fs errors
      }
      try {
        if (fs.existsSync(`${mountpoint}/VIDEO_TS`)) {
          return 'dvd';
        }
      } catch (_error) {
        // ignore fs errors
      }
    }

    const byUdev = await this.inferMediaProfileFromUdev(devicePath);
    if (byUdev) {
      return byUdev;
    }

    const hintFstype = String(hints?.fstype || '').trim().toLowerCase();
    const byFsTypeHint = inferMediaProfileFromFsTypeAndModel(hints?.fstype, hints?.model);
    const udfHintFallback = hintFstype.includes('udf')
      ? inferMediaProfileFromFsTypeAndModel(hints?.fstype, null)
      : null;
    // UDF is used for both Blu-ray (UDF 2.x) and DVD (UDF 1.x). Without a clear model
    // marker identifying it as Blu-ray, a 'dvd' result from UDF is ambiguous. Skip the
    // early return and fall through to the blkid check which uses the UDF version number.
    // Also guard: when hintFstype is empty (no filesystem info at all), the drive model
    // alone is not a reliable disc-type indicator — a BD-RE drive can contain a DVD.
    // In that case skip this early return and let blkid -p determine the actual disc type.
    if (
      hintFstype
      && byFsTypeHint
      && !(hintFstype.includes('udf') && byFsTypeHint !== 'bluray')
      && !(isIsoLikeFsType(hintFstype) && byFsTypeHint === 'dvd')
    ) {
      return byFsTypeHint;
    }

    try {
      const { stdout } = await execFileAsync('blkid', ['-p', '-o', 'export', devicePath]);
      const payload = {};
      for (const line of String(stdout || '').split(/\r?\n/)) {
        const idx = line.indexOf('=');
        if (idx <= 0) {
          continue;
        }
        const key = String(line.slice(0, idx)).trim().toUpperCase();
        const value = String(line.slice(idx + 1)).trim();
        if (!key) {
          continue;
        }
        payload[key] = value;
      }

      // APPLICATION_ID contains disc-specific strings (e.g. "BDAV"/"BDMV" for Blu-ray,
      // "DVD_VIDEO" for DVD). Drive model is excluded – see reasoning above.
      const byBlkidMarker = inferMediaProfileFromTextParts([
        payload.LABEL,
        payload.TYPE,
        payload.VERSION,
        payload.APPLICATION_ID,
      ]);
      if (byBlkidMarker) {
        return byBlkidMarker;
      }

      const type = String(payload.TYPE || '').trim().toLowerCase();
      // For UDF, VERSION is the most reliable discriminator: 1.x → DVD, 2.x → Blu-ray.
      // This check must run independently of inferMediaProfileFromFsTypeAndModel so it
      // is not skipped when the drive model returns null (BD-ROM drive with DVD inside).
      if (type.includes('udf')) {
        const version = Number.parseFloat(String(payload.VERSION || '').replace(',', '.'));
        if (Number.isFinite(version)) {
          return version >= 2 ? 'bluray' : 'dvd';
        }
      }

      const byBlkidFsType = inferMediaProfileFromFsTypeAndModel(type, hints?.model);
      if (byBlkidFsType && !(isIsoLikeFsType(type) && byBlkidFsType === 'dvd')) {
        return byBlkidFsType;
      }

      // Last resort for drives that only expose TYPE=udf without VERSION/APPLICATION_ID:
      // prefer DVD over "other" so DVDs in BD-capable drives do not fall back to Misc.
      const byBlkidFsTypeWithoutModel = inferMediaProfileFromFsTypeAndModel(type, null);
      if (byBlkidFsTypeWithoutModel && !(isIsoLikeFsType(type) && byBlkidFsTypeWithoutModel === 'dvd')) {
        return byBlkidFsTypeWithoutModel;
      }
    } catch (error) {
      logger.debug('infer-media-profile:blkid-failed', {
        devicePath,
        error: errorToMeta(error)
      });
    }

    if (udfHintFallback) {
      return udfHintFallback;
    }

    const hasAudioCdToc = await this.probeAudioCdWithCdparanoia(devicePath);
    if (hasAudioCdToc) {
      return 'cd';
    }

    return 'other';
  }

  guessDiscIndex(name) {
    if (!name) {
      return 0;
    }

    const match = String(name).match(/(\d+)$/);
    return match ? Number(match[1]) : 0;
  }
}

module.exports = new DiskDetectionService();
