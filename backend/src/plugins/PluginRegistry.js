'use strict';

const { SourcePlugin } = require('./PluginBase');
const logger = require('../services/logger').child('PLUGIN-REGISTRY');

/**
 * Registry für alle Source-Plugins.
 * Plugins werden beim Start registriert und anhand von detect() ausgewählt.
 *
 * Verwendung:
 *   const { registry } = require('./PluginRegistry');
 *   registry.register(new BluRayPlugin());
 *   const plugin = registry.findPlugin(discInfo); // → BluRayPlugin | null
 */
class PluginRegistry {
  constructor() {
    /** @type {Map<string, SourcePlugin>} */
    this._plugins = new Map();
  }

  /**
   * Registriert ein Plugin.
   * Wirft einen Fehler wenn das übergebene Objekt keine SourcePlugin-Instanz ist.
   * Überschreibt ein bereits vorhandenes Plugin mit gleicher ID (mit Warning).
   *
   * @param {SourcePlugin} plugin
   */
  register(plugin) {
    if (!(plugin instanceof SourcePlugin)) {
      throw new Error(
        `Plugin muss eine Instanz von SourcePlugin sein: ${plugin?.constructor?.name || typeof plugin}`
      );
    }
    const id = plugin.id;
    if (!id || typeof id !== 'string') {
      throw new Error(`Plugin muss eine nicht-leere String-ID haben (got: ${JSON.stringify(id)})`);
    }
    if (this._plugins.has(id)) {
      logger.warn('registry:plugin-overwrite', { id, existingName: this._plugins.get(id).name });
    }
    this._plugins.set(id, plugin);
    logger.info('registry:plugin-registered', { id, name: plugin.name, priority: plugin.priority });
  }

  /**
   * Findet das passende Plugin für eine erkannte Disc.
   *
   * Alle Plugins werden nach priority (absteigend) sortiert. Das erste,
   * dessen detect() true zurückgibt, wird verwendet.
   * Fehler in detect() werden geloggt und ignoriert (Plugin übersprungen).
   *
   * @param {object} discInfo - Disc-Informationen vom DiskDetectionService
   * @returns {SourcePlugin|null} Passendes Plugin oder null wenn keines matched
   */
  findPlugin(discInfo) {
    const sorted = [...this._plugins.values()]
      .sort((a, b) => (b.priority || 0) - (a.priority || 0));

    for (const plugin of sorted) {
      try {
        if (plugin.detect(discInfo)) {
          logger.debug('registry:plugin-matched', { id: plugin.id, discType: discInfo?.discType });
          return plugin;
        }
      } catch (error) {
        logger.warn('registry:detect-error', {
          id: plugin.id,
          error: error?.message || String(error)
        });
      }
    }

    logger.warn('registry:no-plugin-matched', { discType: discInfo?.discType, filesystem: discInfo?.filesystem });
    return null;
  }

  /**
   * Gibt ein Plugin anhand seiner ID zurück.
   *
   * @param {string} id
   * @returns {SourcePlugin|null}
   */
  getPlugin(id) {
    return this._plugins.get(id) ?? null;
  }

  /**
   * Gibt alle registrierten Plugins zurück (Reihenfolge: Registrierungsreihenfolge).
   *
   * @returns {SourcePlugin[]}
   */
  getAllPlugins() {
    return [...this._plugins.values()];
  }

  /**
   * Aggregiert die Settings-Schemata aller registrierten Plugins.
   * Kann genutzt werden, um Plugin-Settings dynamisch in die DB einzutragen.
   *
   * @returns {Array<object>}
   */
  getSettingsSchemas() {
    const schemas = [];
    for (const plugin of this._plugins.values()) {
      try {
        const pluginSchemas = plugin.getSettingsSchema();
        if (Array.isArray(pluginSchemas) && pluginSchemas.length > 0) {
          schemas.push(...pluginSchemas);
        }
      } catch (error) {
        logger.warn('registry:schema-error', {
          id: plugin.id,
          error: error?.message || String(error)
        });
      }
    }
    return schemas;
  }

  /**
   * Gibt die Anzahl der registrierten Plugins zurück.
   * @returns {number}
   */
  get size() {
    return this._plugins.size;
  }
}

// Modul-Level-Singleton — wird beim Start einmalig befüllt.
const registry = new PluginRegistry();

module.exports = { PluginRegistry, registry };
