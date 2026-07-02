'use strict';

/**
 * Abstrakte Basisklasse für Source-Plugins.
 * Jedes Plugin implementiert die Pipeline-Phasen für einen Medientyp.
 *
 * Lifecycle: detect() → analyze() → rip() → review() → encode() → finalize()
 *
 * Alle async-Methoden können einen Fehler werfen — der Orchestrator fängt
 * diese ab und schreibt sie als Job-Fehler in die Datenbank.
 */
class SourcePlugin {
  /**
   * Eindeutiger Bezeichner des Plugins.
   * Erlaubte Werte: 'bluray' | 'dvd' | 'cd' | 'audiobook' | eigener String
   * @returns {string}
   */
  get id() {
    throw new Error(`${this.constructor.name}: id nicht implementiert`);
  }

  /**
   * Anzeigename des Plugins (für Logs und UI).
   * @returns {string}
   */
  get name() {
    throw new Error(`${this.constructor.name}: name nicht implementiert`);
  }

  /**
   * Priorität bei detect()-Konflikten. Höhere Zahl = höhere Priorität.
   * Standard: 0
   * @returns {number}
   */
  get priority() {
    return 0;
  }

  /**
   * Prüft, ob dieses Plugin für die erkannte Disc/Datei zuständig ist.
   * Wird vom PluginRegistry.findPlugin() aufgerufen.
   *
   * @param {object} discInfo - Disc-Informationen vom DiskDetectionService
   * @param {string} [discInfo.devicePath]
   * @param {string} [discInfo.discType]   - 'bluray' | 'dvd' | 'cd' | 'data'
   * @param {string} [discInfo.filesystem] - z.B. 'UDF', 'ISO9660', 'CDFS'
   * @param {string} [discInfo.driveModel]
   * @returns {boolean}
   */
  detect(discInfo) { // eslint-disable-line no-unused-vars
    throw new Error(`${this.constructor.name}: detect() nicht implementiert`);
  }

  /**
   * Analysiert das Medium (z.B. makemkvcon info, cdparanoia -Q, ffprobe).
   * Gibt die Rohdaten zurück, die der Orchestrator im Job speichert.
   *
   * @param {string} devicePath - Gerätepfad, z.B. '/dev/sr0'
   * @param {object} job        - Bestehender Job-Record aus der DB
   * @param {PluginContext} ctx
   * @returns {Promise<object>} Analyse-Ergebnis
   *   Empfohlene Felder: { encodePlan, handbrakeInfo, rawDiscInfo, ... }
   */
  async analyze(devicePath, job, ctx) { // eslint-disable-line no-unused-vars
    throw new Error(`${this.constructor.name}: analyze() nicht implementiert`);
  }

  /**
   * Rippt das Medium in den RAW-Ordner.
   * Fortschritt wird über ctx.emitProgress() gemeldet.
   *
   * @param {object} job
   * @param {PluginContext} ctx
   * @returns {Promise<void>}
   */
  async rip(job, ctx) { // eslint-disable-line no-unused-vars
    throw new Error(`${this.constructor.name}: rip() nicht implementiert`);
  }

  /**
   * Bereitet die Encode-Review vor (MediaInfo-Analyse, Einstellungsvorschau).
   * Optional — Plugins, die keine Review benötigen, können die Basis-Implementierung
   * behalten (gibt null zurück, Orchestrator überspringt dann den Review-Schritt).
   *
   * @param {object} job
   * @param {PluginContext} ctx
   * @returns {Promise<object|null>} Review-Daten oder null
   */
  async review(job, ctx) { // eslint-disable-line no-unused-vars
    return null;
  }

  /**
   * Encodiert die gerippten Dateien (HandBrake, ffmpeg, etc.).
   * Fortschritt wird über ctx.emitProgress() gemeldet.
   *
   * @param {object} job
   * @param {PluginContext} ctx
   * @returns {Promise<void>}
   */
  async encode(job, ctx) { // eslint-disable-line no-unused-vars
    throw new Error(`${this.constructor.name}: encode() nicht implementiert`);
  }

  /**
   * Abschlussarbeiten: Umbenennen, Aufräumen, Notifications, Post-Encode-Scripts usw.
   * Optional — Default-Implementierung tut nichts.
   *
   * @param {object} job
   * @param {PluginContext} ctx
   * @returns {Promise<void>}
   */
  async finalize(job, ctx) { // eslint-disable-line no-unused-vars
    // Default: kein Finalize-Schritt notwendig
  }

  /**
   * Abbruch-Handler: Laufende Prozesse beenden, temporäre Dateien aufräumen.
   * Wird vom Orchestrator bei cancel() aufgerufen.
   * Optional — Default-Implementierung tut nichts.
   *
   * @param {object} job
   * @param {PluginContext} ctx
   * @returns {Promise<void>}
   */
  async onCancel(job, ctx) { // eslint-disable-line no-unused-vars
    // Default: nichts zu tun
  }

  /**
   * Retry-Handler: Zustand zurücksetzen vor einem erneuten Versuch.
   * Wird vom Orchestrator vor retry() aufgerufen.
   * Optional — Default-Implementierung tut nichts.
   *
   * @param {object} job
   * @param {PluginContext} ctx
   * @returns {Promise<void>}
   */
  async onRetry(job, ctx) { // eslint-disable-line no-unused-vars
    // Default: nichts zu tun
  }

  /**
   * Plugin-spezifische Settings-Schema-Einträge.
   * Diese werden vom PluginRegistry.getSettingsSchemas() aggregiert
   * und können zur Laufzeit in die DB eingetragen werden.
   *
   * Format je Eintrag:
   *   { key, category, label, type, required, description,
   *     default_value, options_json, validation_json, order_index }
   *
   * @returns {Array<object>}
   */
  getSettingsSchema() {
    return [];
  }
}

module.exports = { SourcePlugin };
