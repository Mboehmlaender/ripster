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
  const normalizedTracks = media.flatMap((medium, mediumIdx) => {
    const mediumTracks = Array.isArray(medium.tracks) ? medium.tracks : [];
    return mediumTracks.map((track, trackIdx) => {
      const rawPosition = String(track.position || track.number || '').trim();
      const parsedPosition = Number.parseInt(rawPosition, 10);
      const fallbackPosition = mediumIdx * 100 + trackIdx + 1;
      const position = Number.isFinite(parsedPosition) && parsedPosition > 0
        ? parsedPosition
        : fallbackPosition;
      return {
        position,
      number: String(track.number || track.position || ''),
      title: String(track.title || ''),
      durationMs: Number(track.length || 0) || null,
      rawTrackArtistCredit: Array.isArray(track['artist-credit']) ? track['artist-credit'] : [],
      rawRecordingArtistCredit: Array.isArray(track?.recording?.['artist-credit']) ? track.recording['artist-credit'] : []
      };
    });
  }).map((track) => {
    const trackArtistCredit = Array.isArray(track?.rawTrackArtistCredit)
      ? track.rawTrackArtistCredit
      : [];
    const recordingArtistCredit = Array.isArray(track?.rawRecordingArtistCredit)
      ? track.rawRecordingArtistCredit
      : [];
    const artistFromTrack = trackArtistCredit.map((ac) => ac?.artist?.name || ac?.name || '').filter(Boolean).join(', ');
    const artistFromRecording = recordingArtistCredit.map((ac) => ac?.artist?.name || ac?.name || '').filter(Boolean).join(', ');
    return {
      position: track.position,
      number: track.number,
      title: track.title,
      durationMs: track.durationMs,
      artist: artistFromTrack || artistFromRecording || artistCredit || null
    };
  });
  const rawReleaseTrackCount = Number(release['track-count']);
  const mediaTrackCount = media.reduce((sum, medium) => {
    const mediumCount = Number(medium?.['track-count'] ?? medium?.trackCount);
    if (!Number.isFinite(mediumCount) || mediumCount <= 0) {
      return sum;
    }
    return sum + Math.trunc(mediumCount);
  }, 0);
  const trackCount = Number.isFinite(rawReleaseTrackCount) && rawReleaseTrackCount > 0
    ? Math.trunc(rawReleaseTrackCount)
    : (mediaTrackCount > 0 ? mediaTrackCount : normalizedTracks.length);

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
    tracks: normalizedTracks,
    trackCount
  };
}

class MusicBrainzService {
  async searchByTitle(query, options = {}) {
    const q = String(query || '').trim();
    if (!q) {
      return [];
    }
    const expectedTrackCountRaw = Number(options?.trackCount);
    const expectedTrackCount = Number.isFinite(expectedTrackCountRaw) && expectedTrackCountRaw > 0
      ? Math.trunc(expectedTrackCountRaw)
      : null;
    logger.info('search:start', { query: q });

    const url = new URL(`${MB_BASE}/release`);
    url.searchParams.set('query', q);
    url.searchParams.set('fmt', 'json');
    url.searchParams.set('limit', '10');
    url.searchParams.set('inc', 'artist-credits+labels+recordings+media');

    try {
      const data = await mbFetch(url.toString());
      const releases = Array.isArray(data.releases) ? data.releases : [];
      const normalizedReleases = releases.map(normalizeRelease).filter(Boolean);
      const results = expectedTrackCount
        ? normalizedReleases.filter((release) => Number(release?.trackCount || 0) === expectedTrackCount)
        : normalizedReleases;
      logger.info('search:done', {
        query: q,
        expectedTrackCount,
        sourceCount: normalizedReleases.length,
        count: results.length
      });
      return results;
    } catch (error) {
      logger.warn('search:failed', {
        query: q,
        expectedTrackCount,
        error: String(error?.message || error)
      });
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

    logger.info('getById:start', { mbId: id });

    const url = new URL(`${MB_BASE}/release/${id}`);
    url.searchParams.set('fmt', 'json');
    url.searchParams.set('inc', 'artist-credits+labels+recordings+media');

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
