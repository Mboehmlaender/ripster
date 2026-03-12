const settingsService = require('./settingsService');
const logger = require('./logger').child('MUSICBRAINZ');

const MB_BASE = 'https://musicbrainz.org/ws/2';
const MB_USER_AGENT = 'Ripster/1.0 (https://github.com/ripster)';
const MB_TIMEOUT_MS = 10000;

async function mbFetch(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MB_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: {
        'Accept': 'application/json',
        'User-Agent': MB_USER_AGENT
      },
      signal: controller.signal
    });
    clearTimeout(timer);
    if (!response.ok) {
      throw new Error(`MusicBrainz Anfrage fehlgeschlagen (${response.status})`);
    }
    return response.json();
  } catch (error) {
    clearTimeout(timer);
    throw error;
  }
}

function normalizeRelease(release) {
  if (!release) {
    return null;
  }
  const artistCredit = Array.isArray(release['artist-credit'])
    ? release['artist-credit'].map((ac) => ac?.artist?.name || ac?.name || '').filter(Boolean).join(', ')
    : null;
  const date = String(release.date || '').trim();
  const yearMatch = date.match(/\b(\d{4})\b/);
  const year = yearMatch ? Number(yearMatch[1]) : null;

  const media = Array.isArray(release.media) ? release.media : [];
  const tracks = media.flatMap((medium, mediumIdx) => {
    const mediumTracks = Array.isArray(medium.tracks) ? medium.tracks : [];
    return mediumTracks.map((track) => ({
      position: Number(track.position || mediumIdx * 100 + 1),
      number: String(track.number || track.position || ''),
      title: String(track.title || ''),
      durationMs: Number(track.length || 0) || null
    }));
  });

  // Always generate the CAA URL when an id is present; the browser/onError
  // handles 404s for releases that have no front cover.
  const coverArtUrl = release.id
    ? `https://coverartarchive.org/release/${release.id}/front-250`
    : null;

  return {
    mbId: String(release.id || ''),
    title: String(release.title || ''),
    artist: artistCredit || null,
    year,
    date,
    country: String(release.country || '').trim() || null,
    label: Array.isArray(release['label-info'])
      ? release['label-info'].map((li) => li?.label?.name).filter(Boolean).join(', ') || null
      : null,
    coverArtUrl,
    tracks
  };
}

class MusicBrainzService {
  async isEnabled() {
    const settings = await settingsService.getSettingsMap();
    return settings.musicbrainz_enabled !== 'false';
  }

  async searchByTitle(query) {
    const q = String(query || '').trim();
    if (!q) {
      return [];
    }

    const enabled = await this.isEnabled();
    if (!enabled) {
      return [];
    }

    logger.info('search:start', { query: q });

    const url = new URL(`${MB_BASE}/release`);
    url.searchParams.set('query', q);
    url.searchParams.set('fmt', 'json');
    url.searchParams.set('limit', '10');
    url.searchParams.set('inc', 'artist-credits+labels+recordings');

    try {
      const data = await mbFetch(url.toString());
      const releases = Array.isArray(data.releases) ? data.releases : [];
      const results = releases.map(normalizeRelease).filter(Boolean);
      logger.info('search:done', { query: q, count: results.length });
      return results;
    } catch (error) {
      logger.warn('search:failed', { query: q, error: String(error?.message || error) });
      return [];
    }
  }

  async searchByDiscLabel(discLabel) {
    return this.searchByTitle(discLabel);
  }

  async getReleaseById(mbId) {
    const id = String(mbId || '').trim();
    if (!id) {
      return null;
    }

    const enabled = await this.isEnabled();
    if (!enabled) {
      return null;
    }

    logger.info('getById:start', { mbId: id });

    const url = new URL(`${MB_BASE}/release/${id}`);
    url.searchParams.set('fmt', 'json');
    url.searchParams.set('inc', 'artist-credits+labels+recordings+cover-art-archive');

    try {
      const data = await mbFetch(url.toString());
      const result = normalizeRelease(data);
      logger.info('getById:done', { mbId: id, title: result?.title });
      return result;
    } catch (error) {
      logger.warn('getById:failed', { mbId: id, error: String(error?.message || error) });
      return null;
    }
  }
}

module.exports = new MusicBrainzService();
