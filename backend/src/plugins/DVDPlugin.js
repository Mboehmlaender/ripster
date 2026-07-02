'use strict';

const { VideoDiscPlugin } = require('./VideoDiscPlugin');

/**
 * Source-Plugin für DVD-Discs.
 *
 * Erbt die gesamte Rip/Encode-Logik von VideoDiscPlugin.
 * Überschreibt nur die Identifikations-Properties und detect().
 *
 * Erkennungsmerkmale:
 *   - mediaProfile === 'dvd'
 *   - Dateisystem: UDF (1.02) oder ISO9660
 *   - Laufwerksmodell enthält 'dvd', aber KEIN Blu-ray-Marker
 */
class DVDPlugin extends VideoDiscPlugin {
  get id() {
    return 'dvd';
  }

  get name() {
    return 'DVD';
  }

  get mediaProfile() {
    return 'dvd';
  }

  /**
   * Niedrigere Priorität als Blu-ray (5 < 10), da Blu-ray-Laufwerke
   * auch DVDs lesen können — BluRayPlugin soll für BD-Discs bevorzugt werden.
   */
  get priority() {
    return 5;
  }

  /**
   * Erkennt DVD-Discs.
   * Prüft das vom DiskDetectionService gesetzte mediaProfile-Feld.
   *
   * @param {object} discInfo
   * @param {string} [discInfo.mediaProfile] - 'dvd'
   * @param {string} [discInfo.fstype]       - 'udf' | 'iso9660'
   * @param {string} [discInfo.driveModel]
   * @returns {boolean}
   */
  detect(discInfo) {
    const profile = String(discInfo?.mediaProfile || '').trim().toLowerCase();
    if (profile === 'dvd') {
      return true;
    }
    // Fallback: ISO9660 oder UDF ohne Blu-ray-Modell-Marker
    const fstype = String(discInfo?.fstype || '').trim().toLowerCase();
    const model = String(discInfo?.driveModel || discInfo?.model || '').trim().toLowerCase();
    const hasBlurayMarker = /(blu[\s-]?ray|bd[\s_-]?rom|bd-r\b|bd-re\b)/i.test(model);
    if (hasBlurayMarker) {
      return false; // Blu-ray-Laufwerk → BluRayPlugin übernimmt
    }
    if (fstype === 'iso9660' || (fstype === 'udf' && /dvd/i.test(model))) {
      return true;
    }
    return false;
  }
}

module.exports = { DVDPlugin };
