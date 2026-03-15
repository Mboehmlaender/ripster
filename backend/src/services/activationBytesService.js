const fs = require('fs');
const crypto = require('crypto');
const https = require('https');
const { getDb } = require('../db/database');
const logger = require('./logger').child('ActivationBytes');

const FIXED_KEY = Buffer.from([0x77, 0x21, 0x4d, 0x4b, 0x19, 0x6a, 0x87, 0xcd, 0x52, 0x00, 0x45, 0xfd, 0x20, 0xa5, 0x1d, 0x67]);
const AAX_CHECKSUM_OFFSET = 653;
const AAX_CHECKSUM_LENGTH = 20;
const AUDIBLE_TOOLS_API = 'https://aaxapiserverfunction20220831180001.azurewebsites.net';

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

async function saveToCache(checksum, activationBytes) {
  const db = await getDb();
  await db.run(
    'INSERT OR IGNORE INTO aax_activation_bytes (checksum, activation_bytes) VALUES (?, ?)',
    checksum,
    activationBytes
  );
}

function fetchFromApi(checksum) {
  return new Promise((resolve, reject) => {
    const url = `${AUDIBLE_TOOLS_API}/api/v2/activation/${checksum}`;
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          reject(new Error('Ungültige API-Antwort'));
        }
      });
    }).on('error', reject);
  });
}

async function resolveActivationBytes(filePath) {
  const checksum = readAaxChecksum(filePath);
  logger.info({ checksum }, 'AAX Checksum gelesen');

  // 1. Cache prüfen
  const cached = await lookupCached(checksum);
  if (cached) {
    logger.info({ checksum }, 'Activation Bytes aus lokalem Cache');
    return { checksum, activationBytes: cached, source: 'cache' };
  }

  // 2. Audible-Tools API anfragen
  logger.info({ checksum }, 'Frage Audible-Tools API an...');
  let activationBytes = null;
  try {
    const result = await fetchFromApi(checksum);
    if (result.success === true && result.activationBytes) {
      if (verifyActivationBytes(result.activationBytes, checksum)) {
        activationBytes = result.activationBytes;
        logger.info({ checksum, activationBytes }, 'Activation Bytes via API verifiziert');
      } else {
        logger.warn({ checksum }, 'API-Antwort konnte nicht verifiziert werden');
      }
    } else {
      logger.warn({ checksum }, 'Checksum der API unbekannt');
    }
  } catch (err) {
    logger.warn({ checksum, err: err.message }, 'API nicht erreichbar');
  }

  if (!activationBytes) {
    throw new Error(`Activation Bytes für Checksum ${checksum} nicht gefunden (API unbekannt oder nicht erreichbar)`);
  }

  // 3. Lokal cachen
  await saveToCache(checksum, activationBytes);
  return { checksum, activationBytes, source: 'api' };
}

async function listCachedEntries() {
  const db = await getDb();
  return db.all('SELECT checksum, activation_bytes, created_at FROM aax_activation_bytes ORDER BY created_at DESC');
}

module.exports = { resolveActivationBytes, readAaxChecksum, listCachedEntries };
