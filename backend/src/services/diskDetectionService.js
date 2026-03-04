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
  return `${info.path || ''}|${info.discLabel || ''}|${info.label || ''}|${info.model || ''}|${info.mountpoint || ''}|${info.fstype || ''}`;
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

    const hasMedia = await this.checkMediaPresent(devicePath);
    if (!hasMedia) {
      logger.debug('detect:explicit:no-media', { devicePath });
      return null;
    }
    const discLabel = await this.getDiscLabel(devicePath);

    const details = await this.getBlockDeviceInfo();
    const match = details.find((entry) => entry.path === devicePath || `/dev/${entry.name}` === devicePath) || {};

    const detected = {
      mode: 'explicit',
      path: devicePath,
      name: match.name || devicePath.split('/').pop(),
      model: match.model || 'Unknown',
      label: match.label || null,
      discLabel: discLabel || null,
      mountpoint: match.mountpoint || null,
      fstype: match.fstype || null,
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

      const hasMedia = await this.checkMediaPresent(path);
      if (!hasMedia) {
        continue;
      }
      const discLabel = await this.getDiscLabel(path);

      const detected = {
        mode: 'auto',
        path,
        name: item.name,
        model: item.model || 'Optical Drive',
        label: item.label || null,
        discLabel: discLabel || null,
        mountpoint: item.mountpoint || null,
        fstype: item.fstype || null,
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
      const has = stdout.trim().length > 0;
      logger.debug('blkid:result', { devicePath, hasMedia: has, type: stdout.trim() });
      return has;
    } catch (error) {
      logger.debug('blkid:no-media-or-fail', { devicePath, error: errorToMeta(error) });
      return false;
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

  guessDiscIndex(name) {
    if (!name) {
      return 0;
    }

    const match = String(name).match(/(\d+)$/);
    return match ? Number(match[1]) : 0;
  }
}

module.exports = new DiskDetectionService();
