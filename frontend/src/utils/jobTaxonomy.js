function safeParseJson(value, fallback = null) {
  if (!value) {
    return fallback;
  }
  if (typeof value === 'object') {
    return value;
  }
  try {
    return JSON.parse(value);
  } catch (_error) {
    return fallback;
  }
}

function getEncodePlan(job) {
  if (!job || typeof job !== 'object') {
    return null;
  }
  return safeParseJson(job.encodePlan || job.encode_plan_json, null);
}

function normalizeConverterMediaType(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (raw === 'audio' || raw === 'video' || raw === 'iso') {
    return raw;
  }
  return null;
}

function normalizeMediaType(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) {
    return null;
  }
  if (['bluray', 'blu-ray', 'blu_ray', 'bd', 'bdmv', 'bdrom', 'bd-rom', 'bd-r', 'bd-re'].includes(raw)) {
    return 'bluray';
  }
  if (['dvd', 'disc', 'dvdvideo', 'dvd-video', 'dvdrom', 'dvd-rom', 'video_ts', 'iso9660'].includes(raw)) {
    return 'dvd';
  }
  if (['cd', 'audio_cd', 'audio cd'].includes(raw)) {
    return 'cd';
  }
  if (['audiobook', 'audio_book', 'audio book', 'book'].includes(raw)) {
    return 'audiobook';
  }
  if (raw === 'converter') {
    return 'converter';
  }
  return null;
}

function normalizeJobKind(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) {
    return null;
  }
  if (
    [
      'audiobook',
      'cd',
      'dvd',
      'bluray',
      'dvd_series_container',
      'dvd_series_child',
      'multipart_movie_container',
      'multipart_movie_child',
      'multipart_movie_merge',
      'converter_audio',
      'converter_video',
      'converter_iso'
    ].includes(raw)
  ) {
    return raw;
  }
  if (raw === 'converter') {
    return 'converter_video';
  }
  if (raw === 'converter-audio' || raw === 'converter audio') {
    return 'converter_audio';
  }
  if (raw === 'converter-video' || raw === 'converter video') {
    return 'converter_video';
  }
  if (raw === 'converter-iso' || raw === 'converter iso') {
    return 'converter_iso';
  }
  return null;
}

function converterJobKindFromMediaType(converterMediaType) {
  const normalized = normalizeConverterMediaType(converterMediaType);
  if (normalized === 'audio') {
    return 'converter_audio';
  }
  if (normalized === 'iso') {
    return 'converter_iso';
  }
  return 'converter_video';
}

function mediaTypeFromJobKind(jobKind) {
  const normalized = normalizeJobKind(jobKind);
  if (!normalized) {
    return null;
  }
  if (normalized.startsWith('converter_')) {
    return 'converter';
  }
  if (
    normalized === 'dvd_series_container'
    || normalized === 'dvd_series_child'
    || normalized === 'multipart_movie_container'
    || normalized === 'multipart_movie_child'
    || normalized === 'multipart_movie_merge'
  ) {
    return null;
  }
  return normalized;
}

export function resolveJobKind(job) {
  const encodePlan = getEncodePlan(job);
  const converterMediaType = normalizeConverterMediaType(
    encodePlan?.converterMediaType || job?.converterMediaType
  );
  const directCandidates = [
    job?.job_kind,
    job?.jobKind,
    encodePlan?.jobKind,
    job?.makemkvInfo?.jobKind,
    job?.makemkvInfo?.analyzeContext?.jobKind,
    job?.mediainfoInfo?.jobKind,
    job?.handbrakeInfo?.jobKind
  ];
  for (const candidate of directCandidates) {
    const normalized = normalizeJobKind(candidate);
    if (!normalized) {
      continue;
    }
    if (normalized.startsWith('converter_')) {
      return converterMediaType ? converterJobKindFromMediaType(converterMediaType) : normalized;
    }
    return normalized;
  }

  const mediaCandidates = [
    job?.mediaType,
    job?.media_type,
    job?.mediaProfile,
    job?.media_profile,
    encodePlan?.mediaProfile,
    job?.makemkvInfo?.analyzeContext?.mediaProfile,
    job?.makemkvInfo?.mediaProfile,
    job?.mediainfoInfo?.mediaProfile
  ];
  for (const candidate of mediaCandidates) {
    const normalized = normalizeMediaType(candidate);
    if (!normalized) {
      continue;
    }
    if (normalized === 'converter') {
      return converterJobKindFromMediaType(converterMediaType);
    }
    return normalized;
  }

  if (converterMediaType) {
    return converterJobKindFromMediaType(converterMediaType);
  }

  const statusCandidates = [job?.status, job?.last_state, job?.makemkvInfo?.lastState];
  if (statusCandidates.some((value) => String(value || '').trim().toUpperCase().startsWith('CD_'))) {
    return 'cd';
  }

  const planFormat = String(encodePlan?.format || '').trim().toLowerCase();
  const hasCdTracksInPlan = Array.isArray(encodePlan?.selectedTracks) && encodePlan.selectedTracks.length > 0;
  if (hasCdTracksInPlan && ['flac', 'wav', 'mp3', 'opus', 'ogg'].includes(planFormat)) {
    return 'cd';
  }
  if (String(job?.handbrakeInfo?.mode || '').trim().toLowerCase() === 'cd_rip') {
    return 'cd';
  }
  if (Array.isArray(job?.makemkvInfo?.tracks) && job.makemkvInfo.tracks.length > 0) {
    return 'cd';
  }
  if (['audiobook_encode', 'audiobook_encode_split'].includes(String(job?.handbrakeInfo?.mode || '').trim().toLowerCase())) {
    return 'audiobook';
  }
  if (String(encodePlan?.mode || '').trim().toLowerCase() === 'audiobook') {
    return 'audiobook';
  }

  return null;
}

export function resolveMediaType(job) {
  const jobKind = resolveJobKind(job);
  const mediaTypeFromKind = mediaTypeFromJobKind(jobKind);
  if (mediaTypeFromKind) {
    return mediaTypeFromKind;
  }

  const encodePlan = getEncodePlan(job);
  const directCandidates = [
    job?.mediaType,
    job?.media_type,
    job?.mediaProfile,
    job?.media_profile,
    encodePlan?.mediaProfile,
    job?.makemkvInfo?.analyzeContext?.mediaProfile,
    job?.makemkvInfo?.mediaProfile,
    job?.mediainfoInfo?.mediaProfile
  ];
  for (const candidate of directCandidates) {
    const normalized = normalizeMediaType(candidate);
    if (normalized) {
      return normalized;
    }
  }

  const converterMediaType = normalizeConverterMediaType(encodePlan?.converterMediaType || job?.converterMediaType);
  if (converterMediaType) {
    return 'converter';
  }

  return 'other';
}

export function isSeriesVideoJob(job) {
  const mediaType = resolveMediaType(job);
  if (mediaType !== 'dvd' && mediaType !== 'bluray') {
    return false;
  }

  const analyzeContext = job?.makemkvInfo?.analyzeContext && typeof job.makemkvInfo.analyzeContext === 'object'
    ? job.makemkvInfo.analyzeContext
    : {};
  const selectedMetadata = analyzeContext?.selectedMetadata && typeof analyzeContext.selectedMetadata === 'object'
    ? analyzeContext.selectedMetadata
    : (job?.makemkvInfo?.selectedMetadata && typeof job.makemkvInfo.selectedMetadata === 'object'
      ? job.makemkvInfo.selectedMetadata
      : {});
  const workflowKind = String(
    selectedMetadata?.workflowKind
    || analyzeContext?.workflowKind
    || ''
  ).trim().toLowerCase();
  if (['film', 'movie', 'feature'].includes(workflowKind)) {
    return false;
  }
  if (['series', 'tv', 'season', 'episode'].includes(workflowKind)) {
    return true;
  }

  const metadataKind = String(
    selectedMetadata?.metadataKind
    || analyzeContext?.metadataKind
    || ''
  ).trim().toLowerCase();
  if (['film', 'movie', 'feature'].includes(metadataKind)) {
    return false;
  }
  const seasonNumberRaw = selectedMetadata?.seasonNumber ?? analyzeContext?.seriesLookupHint?.seasonNumber ?? null;
  const seasonNumberText = String(seasonNumberRaw ?? '').trim();
  const parsedSeasonNumber = Number(seasonNumberText.replace(',', '.'));
  const hasSeasonNumber = seasonNumberText
    ? (Number.isFinite(parsedSeasonNumber) ? parsedSeasonNumber > 0 : true)
    : false;
  const seasonName = String(selectedMetadata?.seasonName || '').trim();
  const episodeCount = Number(selectedMetadata?.episodeCount ?? 0);
  const hasEpisodeList = Array.isArray(selectedMetadata?.episodes) && selectedMetadata.episodes.length > 0;
  const isSeriesKind = ['series', 'season', 'tv', 'tv_series', 'tv-season', 'tv_season'].includes(metadataKind);

  if (isSeriesKind || hasSeasonNumber || Boolean(seasonName) || hasEpisodeList || (Number.isFinite(episodeCount) && episodeCount > 0)) {
    return true;
  }

  return false;
}

export function isSeriesDvdJob(job) {
  return isSeriesVideoJob(job);
}

export function isConverterJob(job) {
  return resolveMediaType(job) === 'converter';
}
