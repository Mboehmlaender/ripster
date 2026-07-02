'use strict';

const { VideoDiscPlugin } = require('./VideoDiscPlugin');

/**
 * Source-Plugin für Blu-ray Discs.
 *
 * Erbt die gesamte Rip/Encode-Logik von VideoDiscPlugin.
 * Überschreibt nur die Identifikations-Properties und detect().
 *
 * Erkennungsmerkmale:
 *   - mediaProfile === 'bluray'
 *   - Dateisystem: UDF (Versionen 2.5 / 2.6)
 *   - Laufwerksmodell enthält 'blu-ray', 'bdrom', 'bd-r', 'bd-re'
 */
class BluRayPlugin extends VideoDiscPlugin {
  get id() {
    return 'bluray';
  }

  get name() {
    return 'Blu-ray';
  }

  get mediaProfile() {
    return 'bluray';
  }

  /**
   * Höhere Priorität als DVD (10 > 5) damit ein UDF-Laufwerk mit
   * blu-ray-Modell-Marker korrekt erkannt wird, auch wenn beide Plugins
   * theoretisch auf UDF-Discs matchen könnten.
   */
  get priority() {
    return 10;
  }

  /**
   * Erkennt Blu-ray Discs.
   * Prüft das vom DiskDetectionService gesetzte mediaProfile-Feld.
   *
   * @param {object} discInfo
   * @param {string} [discInfo.mediaProfile] - 'bluray'
   * @param {string} [discInfo.fstype]       - 'udf'
   * @param {string} [discInfo.driveModel]
   * @returns {boolean}
   */
  detect(discInfo) {
    const profile = String(discInfo?.mediaProfile || '').trim().toLowerCase();
    if (profile === 'bluray' || profile === 'blu-ray' || profile === 'blu_ray') {
      return true;
    }
    // Wenn mediaProfile explizit auf einen anderen Medientyp gesetzt ist
    // (z.B. 'dvd' für eine DVD im Blu-ray-Laufwerk), dem DiskDetectionService
    // vertrauen und nicht via Modell-Marker überschreiben.
    if (profile) {
      return false;
    }
    // Fallback: nur wenn kein mediaProfile bekannt ist.
    // UDF-Dateisystem + Laufwerks-Modell enthält Blu-ray-Marker.
    const fstype = String(discInfo?.fstype || '').trim().toLowerCase();
    const model = String(discInfo?.driveModel || discInfo?.model || '').trim().toLowerCase();
    if (fstype === 'udf' && /(blu[\s-]?ray|bd[\s_-]?rom|\bbd-?r\b|\bbd-?re\b|\bbdr\b)/i.test(model)) {
      return true;
    }
    return false;
  }
}

module.exports = { BluRayPlugin };
