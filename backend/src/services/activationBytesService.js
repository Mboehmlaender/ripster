const fs = require('fs');
const crypto = require('crypto');
const { getDb } = require('../db/database');
const logger = require('./logger').child('ActivationBytes');

const FIXED_KEY = Buffer.from([0x77, 0x21, 0x4d, 0x4b, 0x19, 0x6a, 0x87, 0xcd, 0x52, 0x00, 0x45, 0xfd, 0x20, 0xa5, 0x1d, 0x67]);
const AAX_CHECKSUM_OFFSET = 653;
const AAX_CHECKSUM_LENGTH = 20;

function sha1(data) {
  return crypto.createHash('sha1').update(data).digest();
}

function verifyActivationBytes(activationBytesHex, expectedChecksumHex) {
  const bytes = Buffer.from(activationBytesHex, 'hex');
  const ik = sha1(Buffer.concat([FIXED_KEY, bytes]));
  const iv = sha1(Buffer.concat([FIXED_KEY, ik, bytes]));
  const checksum = sha1(Buffer.concat([ik.subarray(0, 16), iv.subarray(0, 16)]));
  return checksum.toString('hex') === expectedChecksumHex;
}

function readAaxChecksum(filePath) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(AAX_CHECKSUM_LENGTH);
    const bytesRead = fs.readSync(fd, buf, 0, AAX_CHECKSUM_LENGTH, AAX_CHECKSUM_OFFSET);
    if (bytesRead !== AAX_CHECKSUM_LENGTH) {
      throw new Error(`Konnte Checksum nicht lesen (nur ${bytesRead} Bytes)`);
    }
    return buf.toString('hex');
  } finally {
    fs.closeSync(fd);
  }
}

async function lookupCached(checksum) {
  const db = await getDb();
  const row = await db.get('SELECT activation_bytes FROM aax_activation_bytes WHERE checksum = ?', checksum);
  return row ? row.activation_bytes : null;
}

async function saveActivationBytes(checksum, activationBytesHex) {
  const normalized = String(activationBytesHex || '').trim().toLowerCase();
  if (!/^[0-9a-f]{8}$/.test(normalized)) {
    throw new Error('Activation Bytes müssen genau 8 Hex-Zeichen (4 Bytes) sein');
  }
  if (!verifyActivationBytes(normalized, checksum)) {
    throw new Error('Activation Bytes passen nicht zur Checksum – bitte nochmals prüfen');
  }
  const db = await getDb();
  await db.run(
    'INSERT OR REPLACE INTO aax_activation_bytes (checksum, activation_bytes) VALUES (?, ?)',
    checksum,
    normalized
  );
  logger.info({ checksum, activationBytes: normalized }, 'Activation Bytes manuell gespeichert');
  return normalized;
}

async function resolveActivationBytes(filePath) {
  const checksum = readAaxChecksum(filePath);
  logger.info({ checksum }, 'AAX Checksum gelesen');

  const cached = await lookupCached(checksum);
  if (cached) {
    logger.info({ checksum }, 'Activation Bytes aus lokalem Cache');
    return { checksum, activationBytes: cached };
  }

  logger.info({ checksum }, 'Keine Activation Bytes im Cache – manuelle Eingabe erforderlich');
  return { checksum, activationBytes: null };
}

async function listCachedEntries() {
  const db = await getDb();
  return db.all('SELECT checksum, activation_bytes, created_at FROM aax_activation_bytes ORDER BY created_at DESC');
}

module.exports = { resolveActivationBytes, readAaxChecksum, saveActivationBytes, verifyActivationBytes, listCachedEntries };
