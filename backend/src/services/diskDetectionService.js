const fs = require('fs');
const { EventEmitter } = require('events');
const { execFile } = require('child_process');
const { promisify } = require('util');
const settingsService = require('./settingsService');
const logger = require('./logger').child('DISK');
const { errorToMeta } = require('../utils/errorMeta');

const execFileAsync = promisify(execFile);

function flattenDevices(nodes, acc = []) {
  for (const node of nodes || []) {
    acc.push(node);
    if (Array.isArray(node.children)) {
      flattenDevices(node.children, acc);
    }
  }

  return acc;
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
  if (value === 'disc' || value === 'other' || value === 'sonstiges' || value === 'cd') {
    return 'other';
  }
  return null;
}

function isSpecificMediaProfile(value) {
  return value === 'bluray' || value === 'dvd';
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

function inferMediaProfileFromUdevProperties(properties = {}) {
  const flags = Object.entries(properties).reduce((acc, [key, rawValue]) => {
    const normalizedKey = String(key || '').trim().toUpperCase();
    if (!normalizedKey) {
      return acc;
    }

    acc[normalizedKey] = String(rawValue || '').trim();
    return acc;
  }, {});

  const hasFlag = (prefix) => Object.entries(flags).some(([key, value]) => key.startsWith(prefix) && value === '1');
  if (hasFlag('ID_CDROM_MEDIA_BD')) {
    return 'bluray';
  }
  if (hasFlag('ID_CDROM_MEDIA_DVD')) {
    return 'dvd';
  }
  if (hasFlag('ID_CDROM_MEDIA_CD')) {
    return 'other';
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
    this.deviceLocks = new Map();
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

  scheduleNext(delayMs) {
    if (!this.running) {
      return;
    }

    this.timer = setTimeout(async () => {
      let nextDelay = 4000;

      try {
        const map = await settingsService.getSettingsMap();
        nextDelay = Number(map.disc_poll_interval_ms || 4000);
        logger.debug('poll:tick', {
          driveMode: map.drive_mode,
          driveDevice: map.drive_device,
          nextDelay
        });
        const detected = await this.detectDisc(map);
        this.applyDetectionResult(detected, { forceInsertEvent: false });
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

      const detected = await this.detectDisc(map);
      const result = this.applyDetectionResult(detected, { forceInsertEvent: true });

      logger.info('rescan:done', {
        present: result.present,
        emitted: result.emitted,
        changed: result.changed,
        detected: result.device || null
      });

      return result;
    } catch (error) {
      logger.error('rescan:error', { error: errorToMeta(error) });
      throw error;
    }
  }

  normalizeDevicePath(devicePath) {
    return String(devicePath || '').trim();
  }

  lockDevice(devicePath, owner = null) {
    const normalized = this.normalizeDevicePath(devicePath);
    if (!normalized) {
      return null;
    }

    const entry = this.deviceLocks.get(normalized) || {
      count: 0,
      owners: []
    };

    entry.count += 1;
    if (owner) {
      entry.owners.push(owner);
    }
    this.deviceLocks.set(normalized, entry);

    logger.info('lock:add', {
      devicePath: normalized,
      count: entry.count,
      owner
    });

    return {
      devicePath: normalized,
      owner
    };
  }

  unlockDevice(devicePath, owner = null) {
    const normalized = this.normalizeDevicePath(devicePath);
    if (!normalized) {
      return;
    }

    const entry = this.deviceLocks.get(normalized);
    if (!entry) {
      return;
    }

    entry.count = Math.max(0, entry.count - 1);
    if (entry.count === 0) {
      this.deviceLocks.delete(normalized);
      logger.info('lock:remove', {
        devicePath: normalized,
        owner
      });
      return;
    }

    this.deviceLocks.set(normalized, entry);
    logger.info('lock:decrement', {
      devicePath: normalized,
      count: entry.count,
      owner
    });
  }

  isDeviceLocked(devicePath) {
    const normalized = this.normalizeDevicePath(devicePath);
    if (!normalized) {
      return false;
    }
    return this.deviceLocks.has(normalized);
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

    const mediaState = await this.checkMediaPresent(devicePath);
    if (!mediaState.hasMedia) {
      logger.debug('detect:explicit:no-media', { devicePath });
      return null;
    }
    const discLabel = await this.getDiscLabel(devicePath);

    const details = await this.getBlockDeviceInfo();
    const match = details.find((entry) => entry.path === devicePath || `/dev/${entry.name}` === devicePath) || {};
    const detectedFsType = String(match.fstype || mediaState.type || '').trim() || null;

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
      index: this.guessDiscIndex(match.name || devicePath)
    };
    logger.debug('detect:explicit:success', { detected });
    return detected;
  }

  async detectAuto() {
    const details = await this.getBlockDeviceInfo();
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
      const discLabel = await this.getDiscLabel(path);
      const detectedFsType = String(item.fstype || mediaState.type || '').trim() || null;

      const mediaProfile = await this.inferMediaProfile(path, {
        discLabel,
        label: item.label,
        model: item.model,
        fstype: detectedFsType,
        mountpoint: item.mountpoint
      });

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
        index: this.guessDiscIndex(item.name)
      };
      logger.debug('detect:auto:success', { detected });
      return detected;
    }

    logger.debug('detect:auto:none');
    return null;
  }

  async getBlockDeviceInfo() {
    try {
      const { stdout } = await execFileAsync('lsblk', [
        '-J',
        '-o',
        'NAME,PATH,TYPE,MOUNTPOINT,FSTYPE,LABEL,MODEL'
      ]);
      const parsed = JSON.parse(stdout);
      const devices = flattenDevices(parsed.blockdevices || []).map((entry) => ({
        name: entry.name,
        path: entry.path,
        type: entry.type,
        mountpoint: entry.mountpoint,
        fstype: entry.fstype,
        label: entry.label,
        model: entry.model
      }));
      logger.debug('lsblk:ok', { deviceCount: devices.length });
      return devices;
    } catch (error) {
      logger.warn('lsblk:failed', { error: errorToMeta(error) });
      return [];
    }
  }

  async checkMediaPresent(devicePath) {
    try {
      const { stdout } = await execFileAsync('blkid', ['-o', 'value', '-s', 'TYPE', devicePath]);
      const type = String(stdout || '').trim().toLowerCase();
      const has = type.length > 0;
      logger.debug('blkid:result', { devicePath, hasMedia: has, type });
      return {
        hasMedia: has,
        type: type || null
      };
    } catch (error) {
      logger.debug('blkid:no-media-or-fail', { devicePath, error: errorToMeta(error) });
      return {
        hasMedia: false,
        type: null
      };
    }
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
    if (byFsTypeHint && !(hintFstype.includes('udf') && byFsTypeHint !== 'bluray')) {
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
      if (byBlkidFsType) {
        return byBlkidFsType;
      }

      // Last resort for drives that only expose TYPE=udf without VERSION/APPLICATION_ID:
      // prefer DVD over "other" so DVDs in BD-capable drives do not fall back to Misc.
      const byBlkidFsTypeWithoutModel = inferMediaProfileFromFsTypeAndModel(type, null);
      if (byBlkidFsTypeWithoutModel) {
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
