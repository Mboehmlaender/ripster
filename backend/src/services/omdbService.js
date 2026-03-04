const settingsService = require('./settingsService');
const logger = require('./logger').child('OMDB');

class OmdbService {
  async search(query) {
    if (!query || query.trim().length === 0) {
      return [];
    }
    logger.info('search:start', { query });

    const settings = await settingsService.getSettingsMap();
    const apiKey = settings.omdb_api_key;
    if (!apiKey) {
      return [];
    }

    const type = settings.omdb_default_type || 'movie';
    const url = new URL('https://www.omdbapi.com/');
    url.searchParams.set('apikey', apiKey);
    url.searchParams.set('s', query.trim());
    url.searchParams.set('type', type);

    const response = await fetch(url);
    if (!response.ok) {
      logger.error('search:http-failed', { query, status: response.status });
      throw new Error(`OMDb Anfrage fehlgeschlagen (${response.status})`);
    }

    const data = await response.json();
    if (data.Response === 'False' || !Array.isArray(data.Search)) {
      logger.warn('search:no-results', { query, response: data.Response, error: data.Error });
      return [];
    }
    const results = data.Search.map((item) => ({
      title: item.Title,
      year: item.Year,
      imdbId: item.imdbID,
      type: item.Type,
      poster: item.Poster
    }));
    logger.info('search:done', { query, count: results.length });
    return results;
  }

  async fetchByImdbId(imdbId) {
    const normalizedId = String(imdbId || '').trim().toLowerCase();
    if (!/^tt\d{6,12}$/.test(normalizedId)) {
      return null;
    }

    logger.info('fetchByImdbId:start', { imdbId: normalizedId });
    const settings = await settingsService.getSettingsMap();
    const apiKey = settings.omdb_api_key;
    if (!apiKey) {
      return null;
    }

    const url = new URL('https://www.omdbapi.com/');
    url.searchParams.set('apikey', apiKey);
    url.searchParams.set('i', normalizedId);
    url.searchParams.set('plot', 'full');

    const response = await fetch(url);
    if (!response.ok) {
      logger.error('fetchByImdbId:http-failed', { imdbId: normalizedId, status: response.status });
      throw new Error(`OMDb Anfrage fehlgeschlagen (${response.status})`);
    }

    const data = await response.json();
    if (data.Response === 'False') {
      logger.warn('fetchByImdbId:not-found', { imdbId: normalizedId, error: data.Error });
      return null;
    }

    const yearMatch = String(data.Year || '').match(/\b(19|20)\d{2}\b/);
    const year = yearMatch ? Number(yearMatch[0]) : null;
    const poster = data.Poster && data.Poster !== 'N/A' ? data.Poster : null;

    const result = {
      title: data.Title || null,
      year: Number.isFinite(year) ? year : null,
      imdbId: String(data.imdbID || normalizedId),
      type: data.Type || null,
      poster,
      raw: data
    };
    logger.info('fetchByImdbId:done', { imdbId: result.imdbId, title: result.title });
    return result;
  }
}

module.exports = new OmdbService();
