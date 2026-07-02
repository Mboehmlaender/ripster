'use strict';

const settingsService = require('./settingsService');
const logger = require('./logger').child('TMDB');

const TMDB_BASE_URL = 'https://api.themoviedb.org/3';
const TMDB_IMAGE_BASE_URL = 'https://image.tmdb.org/t/p';
const TMDB_TIMEOUT_MS = 15000;

class TmdbService {
  hasCreditsPayload(details = null) {
    const credits = details?.credits && typeof details.credits === 'object'
      ? details.credits
      : null;
    if (!credits) {
      return false;
    }
    const crew = Array.isArray(credits.crew) ? credits.crew : [];
    const cast = Array.isArray(credits.cast) ? credits.cast : [];
    return crew.length > 0 || cast.length > 0;
  }

  mergeCreditsIntoDetails(details = null, credits = null) {
    const sourceDetails = details && typeof details === 'object' ? details : {};
    const sourceCredits = credits && typeof credits === 'object' ? credits : null;
    if (!sourceCredits) {
      return sourceDetails;
    }
    return {
      ...sourceDetails,
      credits: {
        ...(sourceDetails?.credits && typeof sourceDetails.credits === 'object' ? sourceDetails.credits : {}),
        ...(sourceCredits && typeof sourceCredits === 'object' ? sourceCredits : {})
      }
    };
  }

  extractDirectorNames(crewValues = []) {
    const crew = Array.isArray(crewValues) ? crewValues : [];
    const byJob = this.normalizeNameList(
      crew.filter((member) => String(member?.job || '').trim().toLowerCase() === 'director'),
      { maxItems: 5 }
    );
    if (byJob.length > 0) {
      return byJob;
    }
    // Fallback for edge cases where "Director" job is missing in localized/partial payloads.
    return this.normalizeNameList(
      crew.filter((member) => String(member?.department || '').trim().toLowerCase() === 'directing'),
      { maxItems: 5 }
    );
  }

  isAbortError(error) {
    const name = String(error?.name || '').trim().toLowerCase();
    const message = String(error?.message || '').trim().toLowerCase();
    return name === 'aborterror' || message.includes('aborted');
  }

  classifyRequestError(error) {
    if (this.isAbortError(error)) {
      return 'timeout';
    }
    const statusCode = Number(error?.statusCode || 0) || null;
    if (statusCode === 401 || statusCode === 403) {
      return 'auth';
    }
    if (statusCode >= 500) {
      return 'upstream';
    }
    if (statusCode >= 400) {
      return 'request_failed';
    }
    return 'network';
  }

  readFailureCode(rows) {
    const value = rows && typeof rows.tmdbFailureCode === 'string'
      ? rows.tmdbFailureCode
      : '';
    const normalized = String(value || '').trim().toLowerCase();
    return normalized || null;
  }

  attachFailureCode(rows, failureCode = null) {
    const output = Array.isArray(rows) ? rows : [];
    const normalized = String(failureCode || '').trim().toLowerCase();
    if (!normalized) {
      return output;
    }
    try {
      Object.defineProperty(output, 'tmdbFailureCode', {
        value: normalized,
        enumerable: false,
        configurable: true
      });
    } catch (_error) {
      output.tmdbFailureCode = normalized;
    }
    return output;
  }

  normalizeNameList(values = [], options = {}) {
    const maxItems = Math.max(1, Number(options.maxItems || 10));
    const source = Array.isArray(values) ? values : [];
    const output = [];
    const seen = new Set();
    for (const item of source) {
      const name = String(item?.name || item || '').trim();
      if (!name) {
        continue;
      }
      const key = name.toLowerCase();
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      output.push(name);
      if (output.length >= maxItems) {
        break;
      }
    }
    return output;
  }

  formatRuntimeLabel(value) {
    if (Array.isArray(value)) {
      const values = value
        .map((entry) => Number(entry))
        .filter((entry) => Number.isFinite(entry) && entry > 0)
        .map((entry) => Math.trunc(entry));
      if (values.length === 0) {
        return null;
      }
      const min = Math.min(...values);
      const max = Math.max(...values);
      return min === max ? `${min} min` : `${min}-${max} min`;
    }
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric > 0) {
      return `${Math.trunc(numeric)} min`;
    }
    const text = String(value || '').trim();
    return text || null;
  }

  async getConfig() {
    const settings = await settingsService.getSettingsMap();
    const fallbackLanguages = this.parseLanguageList(settings.dvd_series_fallback_languages);
    return {
      readAccessToken: String(settings.tmdb_api_read_access_token || '').trim() || null,
      language: String(settings.dvd_series_language || 'de-DE').trim() || 'de-DE',
      fallbackLanguages
    };
  }

  async isConfigured() {
    const config = await this.getConfig();
    return Boolean(config.readAccessToken);
  }

  async resolveLanguage(explicitLanguage = null) {
    const config = await this.getConfig();
    return String(explicitLanguage || config.language || 'de-DE').trim() || 'de-DE';
  }

  parseLanguageList(value) {
    const source = Array.isArray(value)
      ? value
      : String(value || '').split(',');
    const normalized = [];
    const seen = new Set();
    for (const item of source) {
      const lang = String(item || '').trim();
      if (!lang) {
        continue;
      }
      const dedupeKey = lang.toLowerCase();
      if (seen.has(dedupeKey)) {
        continue;
      }
      seen.add(dedupeKey);
      normalized.push(lang);
    }
    return normalized;
  }

  buildLanguageCandidates(primaryLanguage = null, fallbackLanguages = []) {
    const preferred = String(primaryLanguage || '').trim() || 'de-DE';
    const fallback = this.parseLanguageList(fallbackLanguages);
    const combined = [preferred, ...fallback];
    return this.parseLanguageList(combined);
  }

  async resolveLanguageCandidates(options = {}) {
    const config = await this.getConfig();
    const explicitLanguage = String(options.language || '').trim() || null;
    const explicitFallbackLanguages = options.fallbackLanguages !== undefined
      ? this.parseLanguageList(options.fallbackLanguages)
      : null;
    const primaryLanguage = explicitLanguage || String(config.language || '').trim() || 'de-DE';
    const fallbackLanguages = explicitFallbackLanguages ?? config.fallbackLanguages;
    return this.buildLanguageCandidates(primaryLanguage, fallbackLanguages);
  }

  async request(pathName, options = {}) {
    const config = await this.getConfig();
    if (!config.readAccessToken) {
      return null;
    }

    const timeoutMs = Math.max(1000, Number(options.timeoutMs || TMDB_TIMEOUT_MS));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const normalizedPath = String(pathName || '').replace(/^\/+/, '');
      const url = new URL(normalizedPath, `${TMDB_BASE_URL}/`);
      if (options.query && typeof options.query === 'object') {
        for (const [key, value] of Object.entries(options.query)) {
          if (value === undefined || value === null || value === '') {
            continue;
          }
          url.searchParams.set(key, String(value));
        }
      }

      const response = await fetch(url, {
        method: options.method || 'GET',
        headers: {
          'accept': 'application/json',
          'Authorization': `Bearer ${config.readAccessToken}`,
          'User-Agent': 'Ripster/1.0'
        },
        signal: controller.signal
      });

      if (!response.ok) {
        const error = new Error(`TMDb request failed (${response.status})`);
        error.statusCode = response.status;
        error.url = url.toString();
        throw error;
      }

      return response.json();
    } finally {
      clearTimeout(timer);
    }
  }

  buildImageUrl(imagePath, size = 'w342') {
    const normalizedPath = String(imagePath || '').trim();
    if (!normalizedPath) {
      return null;
    }
    return `${TMDB_IMAGE_BASE_URL}/${String(size || 'w342').trim()}/${normalizedPath.replace(/^\/+/, '')}`;
  }

  async searchSeries(query, options = {}) {
    const normalizedQuery = String(query || '').trim();
    if (!normalizedQuery || !(await this.isConfigured())) {
      return [];
    }
    const languageCandidates = await this.resolveLanguageCandidates(options);
    let lastFailureCode = null;
    let lastFailureStatusCode = null;
    let lastFailureMessage = null;

    for (const language of languageCandidates) {
      let data = null;
      try {
        data = await this.request('/search/tv', {
          query: {
            query: normalizedQuery,
            first_air_date_year: options.year || undefined,
            language,
            page: options.page || 1,
            include_adult: false
          }
        });
      } catch (error) {
        const failureCode = this.classifyRequestError(error);
        lastFailureCode = failureCode;
        lastFailureStatusCode = Number(error?.statusCode || 0) || null;
        lastFailureMessage = error?.message || String(error);
        logger.warn('search:failed', {
          query: normalizedQuery,
          language,
          error: lastFailureMessage,
          failureCode,
          statusCode: lastFailureStatusCode
        });
        continue;
      }

      const rows = Array.isArray(data?.results) ? data.results : [];
      const normalizedRows = rows
        .map((row) => ({
          id: Number(row?.id || 0) || null,
          title: String(row?.name || row?.original_name || '').trim() || null,
          originalTitle: String(row?.original_name || '').trim() || null,
          year: Number(String(row?.first_air_date || '').slice(0, 4)) || null,
          overview: String(row?.overview || '').trim() || null,
          posterPath: String(row?.poster_path || '').trim() || null,
          poster: this.buildImageUrl(row?.poster_path, 'w342'),
          backdropPath: String(row?.backdrop_path || '').trim() || null,
          backdrop: this.buildImageUrl(row?.backdrop_path, 'w780'),
          originalLanguage: String(row?.original_language || '').trim() || null,
          popularity: Number(row?.popularity || 0) || 0
        }))
        .filter((row) => row.id && row.title);
      if (normalizedRows.length > 0) {
        return this.attachFailureCode(normalizedRows, null);
      }
    }
    if (lastFailureCode) {
      logger.warn('search:failed:all-languages', {
        query: normalizedQuery,
        error: lastFailureMessage,
        failureCode: lastFailureCode,
        statusCode: lastFailureStatusCode
      });
    }
    return this.attachFailureCode([], lastFailureCode);
  }

  async searchMovies(query, options = {}) {
    const normalizedQuery = String(query || '').trim();
    if (!normalizedQuery || !(await this.isConfigured())) {
      return [];
    }
    const languageCandidates = await this.resolveLanguageCandidates(options);
    let lastFailureCode = null;
    let lastFailureStatusCode = null;
    let lastFailureMessage = null;

    for (const language of languageCandidates) {
      let data = null;
      try {
        data = await this.request('/search/movie', {
          query: {
            query: normalizedQuery,
            year: options.year || undefined,
            language,
            page: options.page || 1,
            include_adult: false
          }
        });
      } catch (error) {
        const failureCode = this.classifyRequestError(error);
        lastFailureCode = failureCode;
        lastFailureStatusCode = Number(error?.statusCode || 0) || null;
        lastFailureMessage = error?.message || String(error);
        logger.warn('movie:search:failed', {
          query: normalizedQuery,
          language,
          error: lastFailureMessage,
          failureCode,
          statusCode: lastFailureStatusCode
        });
        continue;
      }

      const rows = Array.isArray(data?.results) ? data.results : [];
      const normalizedRows = rows
        .map((row) => ({
          id: Number(row?.id || 0) || null,
          title: String(row?.title || row?.original_title || '').trim() || null,
          originalTitle: String(row?.original_title || '').trim() || null,
          year: Number(String(row?.release_date || '').slice(0, 4)) || null,
          overview: String(row?.overview || '').trim() || null,
          posterPath: String(row?.poster_path || '').trim() || null,
          poster: this.buildImageUrl(row?.poster_path, 'w342'),
          backdropPath: String(row?.backdrop_path || '').trim() || null,
          backdrop: this.buildImageUrl(row?.backdrop_path, 'w780'),
          originalLanguage: String(row?.original_language || '').trim() || null,
          popularity: Number(row?.popularity || 0) || 0
        }))
        .filter((row) => row.id && row.title);
      if (normalizedRows.length > 0) {
        return this.attachFailureCode(normalizedRows, null);
      }
    }
    if (lastFailureCode) {
      logger.warn('movie:search:failed:all-languages', {
        query: normalizedQuery,
        error: lastFailureMessage,
        failureCode: lastFailureCode,
        statusCode: lastFailureStatusCode
      });
    }
    return this.attachFailureCode([], lastFailureCode);
  }

  async getSeriesDetails(seriesId, options = {}) {
    const id = Number(seriesId);
    if (!Number.isFinite(id) || id <= 0 || !(await this.isConfigured())) {
      return null;
    }
    const languageCandidates = await this.resolveLanguageCandidates(options);
    const appendToResponse = Array.isArray(options.appendToResponse)
      ? options.appendToResponse.map((item) => String(item || '').trim()).filter(Boolean)
      : [];
    let fallbackDetails = null;
    for (const language of languageCandidates) {
      const details = await this.request(`/tv/${Math.trunc(id)}`, {
        query: {
          language,
          append_to_response: appendToResponse.length > 0 ? appendToResponse.join(',') : undefined
        }
      }).catch((error) => {
        logger.warn('series:details:failed', {
          seriesId: Math.trunc(id),
          language,
          error: error?.message || String(error)
        });
        return null;
      });
      if (!details) {
        continue;
      }
      const hasLocalizedPayload = Boolean(
        String(details?.name || '').trim()
        || String(details?.overview || '').trim()
      );
      if (hasLocalizedPayload) {
        return details;
      }
      fallbackDetails = fallbackDetails || details;
    }
    return fallbackDetails;
  }

  async getMovieDetails(movieId, options = {}) {
    const id = Number(movieId);
    if (!Number.isFinite(id) || id <= 0 || !(await this.isConfigured())) {
      return null;
    }
    const languageCandidates = await this.resolveLanguageCandidates(options);
    const appendToResponse = Array.isArray(options.appendToResponse)
      ? options.appendToResponse.map((item) => String(item || '').trim()).filter(Boolean)
      : [];
    let fallbackDetails = null;
    for (const language of languageCandidates) {
      const details = await this.request(`/movie/${Math.trunc(id)}`, {
        query: {
          language,
          append_to_response: appendToResponse.length > 0 ? appendToResponse.join(',') : undefined
        }
      }).catch((error) => {
        logger.warn('movie:details:failed', {
          movieId: Math.trunc(id),
          language,
          error: error?.message || String(error)
        });
        return null;
      });
      if (!details) {
        continue;
      }
      const hasLocalizedPayload = Boolean(
        String(details?.title || '').trim()
        || String(details?.overview || '').trim()
      );
      if (hasLocalizedPayload) {
        return details;
      }
      fallbackDetails = fallbackDetails || details;
    }
    return fallbackDetails;
  }

  async getMovieCredits(movieId, options = {}) {
    const id = Number(movieId);
    if (!Number.isFinite(id) || id <= 0 || !(await this.isConfigured())) {
      return null;
    }
    const language = await this.resolveLanguage(options.language);
    return this.request(`/movie/${Math.trunc(id)}/credits`, {
      query: {
        language
      }
    }).catch((error) => {
      logger.warn('movie:credits:failed', {
        movieId: Math.trunc(id),
        error: error?.message || String(error)
      });
      return null;
    });
  }

  async getMovieDetailsWithCredits(movieId, options = {}) {
    const details = await this.getMovieDetails(movieId, options);
    if (!details) {
      return null;
    }
    const ensureCredits = options?.ensureCredits === true;
    if (!ensureCredits || this.hasCreditsPayload(details)) {
      return details;
    }
    const credits = await this.getMovieCredits(movieId, options);
    return this.mergeCreditsIntoDetails(details, credits);
  }

  async getEpisodeGroups(seriesId) {
    const id = Number(seriesId);
    if (!Number.isFinite(id) || id <= 0 || !(await this.isConfigured())) {
      return [];
    }
    const response = await this.request(`/tv/${Math.trunc(id)}/episode_groups`).catch((error) => {
      logger.warn('series:episode-groups:failed', {
        seriesId: Math.trunc(id),
        error: error?.message || String(error)
      });
      return null;
    });
    return Array.isArray(response?.results) ? response.results : [];
  }

  async getEpisodeGroupDetails(groupId, options = {}) {
    const normalizedId = String(groupId || '').trim();
    if (!normalizedId || !(await this.isConfigured())) {
      return null;
    }
    const languageCandidates = await this.resolveLanguageCandidates(options);
    let fallbackDetails = null;
    for (const language of languageCandidates) {
      const details = await this.request(`/tv/episode_group/${normalizedId}`, {
        query: {
          language
        }
      }).catch((error) => {
        logger.warn('episode-group:details:failed', {
          groupId: normalizedId,
          language,
          error: error?.message || String(error)
        });
        return null;
      });
      if (!details) {
        continue;
      }
      const hasLocalizedPayload = Boolean(String(details?.name || '').trim() || String(details?.description || '').trim());
      if (hasLocalizedPayload) {
        return details;
      }
      fallbackDetails = fallbackDetails || details;
    }
    return fallbackDetails;
  }

  async getSeasonDetails(seriesId, seasonNumber, options = {}) {
    const id = Number(seriesId);
    const season = Number(seasonNumber);
    if (!Number.isFinite(id) || id <= 0 || !Number.isFinite(season) || season < 0 || !(await this.isConfigured())) {
      return null;
    }
    const languageCandidates = await this.resolveLanguageCandidates(options);
    let fallbackDetails = null;
    for (const language of languageCandidates) {
      const details = await this.request(`/tv/${Math.trunc(id)}/season/${Math.trunc(season)}`, {
        query: {
          language
        }
      }).catch(() => null);
      if (!details) {
        continue;
      }
      const hasLocalizedPayload = Boolean(
        String(details?.name || '').trim()
        || String(details?.overview || '').trim()
        || (Array.isArray(details?.episodes) && details.episodes.length > 0)
      );
      if (hasLocalizedPayload) {
        return details;
      }
      fallbackDetails = fallbackDetails || details;
    }
    return fallbackDetails;
  }

  async getSeasonCredits(seriesId, seasonNumber, options = {}) {
    const id = Number(seriesId);
    const season = Number(seasonNumber);
    if (!Number.isFinite(id) || id <= 0 || !Number.isFinite(season) || season < 0 || !(await this.isConfigured())) {
      return null;
    }
    const language = await this.resolveLanguage(options.language);
    return this.request(`/tv/${Math.trunc(id)}/season/${Math.trunc(season)}/credits`, {
      query: {
        language
      }
    }).catch((error) => {
      logger.warn('season:credits:failed', {
        seriesId: Math.trunc(id),
        seasonNumber: Math.trunc(season),
        error: error?.message || String(error)
      });
      return null;
    });
  }

  buildSeasonSummary(seasonDetails = null) {
    const details = seasonDetails && typeof seasonDetails === 'object' ? seasonDetails : {};
    const episodes = Array.isArray(details.episodes) ? details.episodes : [];
    return {
      seasonNumber: Number(details.season_number || details.seasonNumber || 0) || null,
      name: String(details.name || '').trim() || null,
      overview: String(details.overview || '').trim() || null,
      posterPath: String(details.poster_path || '').trim() || null,
      poster: this.buildImageUrl(details.poster_path, 'w342'),
      episodeCount: episodes.length,
      episodes: episodes.map((episode) => ({
        id: Number(episode?.id || 0) || null,
        number: Number(episode?.episode_number || episode?.episodeNumber || 0) || null,
        seasonNumber: Number(episode?.season_number || details.season_number || 0) || null,
        name: String(episode?.name || '').trim() || null,
        overview: String(episode?.overview || '').trim() || null,
        runtime: Number(episode?.runtime || 0) || null,
        airDate: String(episode?.air_date || '').trim() || null,
        stillPath: String(episode?.still_path || '').trim() || null,
        still: this.buildImageUrl(episode?.still_path, 'w300')
      })).filter((episode) => episode.id && episode.number)
    };
  }

  buildSeriesDetailsSummary(seriesDetails = null) {
    const details = seriesDetails && typeof seriesDetails === 'object' ? seriesDetails : {};
    const crew = Array.isArray(details?.credits?.crew) ? details.credits.crew : [];
    const cast = Array.isArray(details?.credits?.cast) ? details.credits.cast : [];
    const creators = Array.isArray(details?.created_by) ? details.created_by : [];
    const genres = Array.isArray(details?.genres) ? details.genres : [];
    const runtimeLabel = this.formatRuntimeLabel(details?.episode_run_time);
    const directorNames = this.extractDirectorNames(crew);
    const creatorNames = this.normalizeNameList(creators, { maxItems: 5 });
    const actorNames = this.normalizeNameList(cast, { maxItems: 10 });
    const genreNames = this.normalizeNameList(genres, { maxItems: 10 });
    const voteAverageRaw = Number(details?.vote_average || 0);
    const voteAverage = Number.isFinite(voteAverageRaw) && voteAverageRaw > 0
      ? Number(voteAverageRaw.toFixed(1))
      : null;
    const voteCount = Number(details?.vote_count || 0);
    const imdbId = String(details?.external_ids?.imdb_id || '').trim() || null;

    return {
      director: directorNames.length > 0
        ? directorNames.join(', ')
        : (creatorNames.length > 0 ? creatorNames.join(', ') : null),
      actors: actorNames.length > 0 ? actorNames.join(', ') : null,
      runtime: runtimeLabel,
      runtimeLabel,
      genre: genreNames.length > 0 ? genreNames.join(', ') : null,
      imdbRating: voteAverage !== null ? voteAverage.toFixed(1) : null,
      voteAverage,
      voteCount: Number.isFinite(voteCount) && voteCount > 0 ? Math.trunc(voteCount) : null,
      rottenTomatoes: null,
      imdbId,
      tmdbId: Number(details?.id || 0) || null,
      firstAirDate: String(details?.first_air_date || '').trim() || null
    };
  }

  buildMovieDetailsSummary(movieDetails = null) {
    const details = movieDetails && typeof movieDetails === 'object' ? movieDetails : {};
    const crew = Array.isArray(details?.credits?.crew) ? details.credits.crew : [];
    const cast = Array.isArray(details?.credits?.cast) ? details.credits.cast : [];
    const genres = Array.isArray(details?.genres) ? details.genres : [];
    const directorNames = this.extractDirectorNames(crew);
    const actorNames = this.normalizeNameList(cast, { maxItems: 10 });
    const genreNames = this.normalizeNameList(genres, { maxItems: 10 });
    const voteAverageRaw = Number(details?.vote_average || 0);
    const voteAverage = Number.isFinite(voteAverageRaw) && voteAverageRaw > 0
      ? Number(voteAverageRaw.toFixed(1))
      : null;
    const voteCount = Number(details?.vote_count || 0);
    const imdbId = String(details?.external_ids?.imdb_id || details?.imdb_id || '').trim() || null;
    const releaseDate = String(details?.release_date || '').trim() || null;
    const runtime = this.formatRuntimeLabel(details?.runtime);

    return {
      director: directorNames.length > 0 ? directorNames.join(', ') : null,
      actors: actorNames.length > 0 ? actorNames.join(', ') : null,
      runtime,
      runtimeLabel: runtime,
      genre: genreNames.length > 0 ? genreNames.join(', ') : null,
      imdbRating: voteAverage !== null ? voteAverage.toFixed(1) : null,
      voteAverage,
      voteCount: Number.isFinite(voteCount) && voteCount > 0 ? Math.trunc(voteCount) : null,
      rottenTomatoes: null,
      imdbId,
      tmdbId: Number(details?.id || 0) || null,
      releaseDate
    };
  }

  buildSeriesMetadataCandidate(series = {}, options = {}) {
    const season = series?.season && typeof series.season === 'object'
      ? series.season
      : null;
    const seasonNumber = Number(options.seasonNumber || season?.seasonNumber || 0) || null;
    const providerId = seasonNumber
      ? `tmdb:${series.id}:season:${seasonNumber}`
      : `tmdb:${series.id}`;

    return {
      provider: 'tmdb',
      providerId,
      metadataKind: seasonNumber ? 'season' : 'series',
      tmdbId: Number(series?.id || 0) || null,
      title: String(series?.title || '').trim() || null,
      originalTitle: String(series?.originalTitle || '').trim() || null,
      year: Number(series?.year || 0) || null,
      overview: String(series?.overview || '').trim() || null,
      poster: series?.poster || this.buildImageUrl(series?.posterPath, 'w342'),
      backdrop: series?.backdrop || this.buildImageUrl(series?.backdropPath, 'w780'),
      seasonNumber,
      seasonName: String(season?.name || '').trim() || null,
      seasonOverview: String(season?.overview || '').trim() || null,
      seasonPoster: season?.poster || this.buildImageUrl(season?.posterPath, 'w342'),
      episodeCount: Number(season?.episodeCount || 0) || 0,
      episodes: Array.isArray(season?.episodes) ? season.episodes : []
    };
  }

  buildMovieMetadataCandidate(movie = {}, options = {}) {
    const detailsSummary = options?.detailsSummary && typeof options.detailsSummary === 'object'
      ? options.detailsSummary
      : null;
    const tmdbId = Number(movie?.id || movie?.tmdbId || 0) || null;
    const releaseDate = String(movie?.releaseDate || detailsSummary?.releaseDate || '').trim() || null;
    const year = Number(movie?.year || Number(String(releaseDate || '').slice(0, 4)) || 0) || null;
    const imdbId = String(movie?.imdbId || detailsSummary?.imdbId || '').trim() || null;
    const providerId = tmdbId !== null ? `tmdb:${tmdbId}` : null;

    return {
      provider: 'tmdb',
      providerId,
      metadataKind: 'movie',
      workflowKind: 'film',
      tmdbId,
      imdbId,
      title: String(movie?.title || movie?.originalTitle || '').trim() || null,
      originalTitle: String(movie?.originalTitle || '').trim() || null,
      year,
      overview: String(movie?.overview || '').trim() || null,
      poster: movie?.poster || this.buildImageUrl(movie?.posterPath, 'w342'),
      backdrop: movie?.backdrop || this.buildImageUrl(movie?.backdropPath, 'w780'),
      runtime: detailsSummary?.runtime || null,
      genre: detailsSummary?.genre || null,
      voteAverage: detailsSummary?.voteAverage ?? null
    };
  }

  buildSeasonSummariesFromSeriesDetails(seriesDetails = null) {
    const details = seriesDetails && typeof seriesDetails === 'object' ? seriesDetails : {};
    const seasons = Array.isArray(details.seasons) ? details.seasons : [];
    return seasons
      .map((season) => ({
        seasonNumber: Number(season?.season_number || season?.seasonNumber || 0) || null,
        name: String(season?.name || '').trim() || null,
        overview: String(season?.overview || '').trim() || null,
        posterPath: String(season?.poster_path || '').trim() || null,
        poster: this.buildImageUrl(season?.poster_path, 'w342'),
        episodeCount: Number(season?.episode_count || season?.episodeCount || 0) || 0,
        episodes: []
      }))
      .filter((season) => season.seasonNumber !== null && season.episodeCount > 0);
  }

  async searchSeriesWithSeasons(query, options = {}) {
    const candidates = await this.searchSeries(query, options);
    const failureCode = this.readFailureCode(candidates);
    if (candidates.length === 0) {
      return this.attachFailureCode([], failureCode);
    }

    const limit = Math.max(1, Math.min(10, Number(options.limit || 5)));
    const selectedCandidates = candidates.slice(0, limit);

    const expanded = await Promise.all(selectedCandidates.map(async (candidate) => {
      const details = await this.getSeriesDetails(candidate.id, options);
      const seasons = this.buildSeasonSummariesFromSeriesDetails(details);
      if (seasons.length === 0) {
        return [this.buildSeriesMetadataCandidate(candidate)];
      }
      return seasons.map((season) => this.buildSeriesMetadataCandidate({
        ...candidate,
        season
      }, {
        seasonNumber: season.seasonNumber
      }));
    }));

    const normalized = expanded.flat().filter((item) => item?.tmdbId && item?.title);
    return this.attachFailureCode(normalized, failureCode);
  }

  async searchSeriesWithSeason(query, seasonNumber, options = {}) {
    const normalizedSeason = Number(seasonNumber);
    if (!Number.isFinite(normalizedSeason) || normalizedSeason < 0) {
      return [];
    }

    const candidates = await this.searchSeries(query, options);
    const failureCode = this.readFailureCode(candidates);
    if (candidates.length === 0) {
      return this.attachFailureCode([], failureCode);
    }

    const limit = Math.max(1, Math.min(10, Number(options.limit || 5)));
    const selectedCandidates = candidates.slice(0, limit);
    const withSeasons = await Promise.all(selectedCandidates.map(async (candidate) => {
      const seasonDetails = await this.getSeasonDetails(candidate.id, normalizedSeason, options);
      if (!seasonDetails) {
        return {
          ...candidate,
          season: null
        };
      }
      return {
        ...candidate,
        season: this.buildSeasonSummary(seasonDetails)
      };
    }));

    const normalized = withSeasons
      .filter((candidate) => candidate.season && candidate.season.episodeCount > 0)
      .map((candidate) => this.buildSeriesMetadataCandidate(candidate, {
        seasonNumber: normalizedSeason
      }));
    return this.attachFailureCode(normalized, failureCode);
  }

  async searchMoviesWithDetails(query, options = {}) {
    const candidates = await this.searchMovies(query, options);
    const failureCode = this.readFailureCode(candidates);
    if (candidates.length === 0) {
      return this.attachFailureCode([], failureCode);
    }

    const limit = Math.max(1, Math.min(15, Number(options.limit || 8)));
    const selectedCandidates = candidates.slice(0, limit);
    const language = await this.resolveLanguage(options.language);

    const expanded = await Promise.all(selectedCandidates.map(async (candidate) => {
      const details = await this.getMovieDetailsWithCredits(candidate.id, {
        language,
        appendToResponse: ['credits', 'external_ids'],
        ensureCredits: true
      });
      const summary = this.buildMovieDetailsSummary(details);
      const normalized = this.buildMovieMetadataCandidate({
        ...candidate,
        releaseDate: details?.release_date || null,
        imdbId: summary?.imdbId || null,
        posterPath: details?.poster_path || candidate?.posterPath || null
      }, {
        detailsSummary: summary
      });
      return {
        ...normalized,
        tmdbDetails: summary && typeof summary === 'object' ? summary : null
      };
    }));

    const normalized = expanded.filter((item) => item?.tmdbId && item?.title);
    return this.attachFailureCode(normalized, failureCode);
  }
}

module.exports = new TmdbService();
