import { useEffect, useMemo, useRef, useState } from 'react';
import { Dialog } from 'primereact/dialog';
import { Button } from 'primereact/button';
import { DataTable } from 'primereact/datatable';
import { Column } from 'primereact/column';
import { InputText } from 'primereact/inputtext';

function normalizeWorkflowKind(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (['film', 'movie', 'feature'].includes(raw)) {
    return 'film';
  }
  if (['series', 'tv', 'season', 'episode', 'tv_series', 'tv-season', 'tv_season'].includes(raw)) {
    return 'series';
  }
  return null;
}

function normalizeResultType(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (raw === 'series') {
    return 'series';
  }
  if (raw === 'movie' || raw === 'film' || raw === 'movies') {
    return 'movie';
  }
  return null;
}

function normalizeMetadataRow(row = {}) {
  const workflowKind = normalizeWorkflowKind(
    row?.workflowKind
    || row?.kind
    || row?.metadataKind
    || null
  );
  const metadataKindRaw = String(row?.metadataKind || '').trim().toLowerCase();
  const metadataKind = metadataKindRaw || (workflowKind === 'series' ? 'series' : 'movie');
  const resultType = normalizeResultType(row?.resultType)
    || (workflowKind === 'series' ? 'series' : (workflowKind === 'film' ? 'movie' : null))
    || ((metadataKind === 'series' || metadataKind === 'season') ? 'series' : 'movie');
  const normalizedWorkflowKind = workflowKind || (resultType === 'series' ? 'series' : 'film');
  return {
    ...row,
    metadataKind,
    resultType,
    workflowKind: normalizedWorkflowKind
  };
}

export default function MetadataSelectionDialog({
  visible,
  context,
  onHide,
  onSubmit,
  onSearch,
  busy
}) {
  const toSearchTitleCase = (value) => String(value || '')
    .toLowerCase()
    .replace(/\b([a-z\u00c0-\u024f])([a-z\u00c0-\u024f0-9']*)/g, (_match, first, rest) => (
      `${first.toUpperCase()}${rest}`
    ));
  const stripTrailingDiscHint = (value) => {
    let working = String(value || '').trim();
    if (!working) {
      return '';
    }
    const patterns = [
      /\b(?:disc|disk|dvd|bd|br|cd|part|pt|vol|volume|season|staffel|episode|ep)\s*(?:\d{1,3}|[ivxlcdm]{1,8})\b$/i,
      /\b(?:[a-z]{1,3}\d{1,4}|\d{1,4}[a-z]{1,3})\b$/i
    ];
    for (let i = 0; i < 4; i += 1) {
      const before = working;
      for (const pattern of patterns) {
        working = working.replace(pattern, '').trim();
      }
      working = working.replace(/[-_.,;:]+$/g, '').trim();
      if (working === before || !working) {
        break;
      }
    }
    return working;
  };
  const buildSearchVariants = (rawValue) => {
    const raw = String(rawValue || '').trim();
    if (!raw) {
      return [];
    }
    if (/^tt\d{6,12}$/i.test(raw)) {
      return [raw.toLowerCase()];
    }
    const variants = [];
    const pushUnique = (candidate) => {
      const normalized = String(candidate || '').replace(/\s+/g, ' ').trim();
      if (!normalized) {
        return;
      }
      if (!variants.some((entry) => entry.toLowerCase() === normalized.toLowerCase())) {
        variants.push(normalized);
      }
    };
    const separatorNormalized = raw
      .replace(/[_]+/g, ' ')
      .replace(/[.]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const punctuationReduced = separatorNormalized
      .replace(/[|/\\]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const stripped = stripTrailingDiscHint(punctuationReduced);

    pushUnique(raw);
    pushUnique(separatorNormalized);
    pushUnique(punctuationReduced);
    pushUnique(toSearchTitleCase(separatorNormalized));
    pushUnique(stripped);
    pushUnique(toSearchTitleCase(stripped));

    return variants.slice(0, 6);
  };
  const normalizeDetectedTitleForMetadataInput = (rawValue) => {
    const raw = String(rawValue || '').trim();
    if (!raw) {
      return '';
    }
    const separatorNormalized = raw
      .replace(/[_]+/g, ' ')
      .replace(/[.]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const stripped = stripTrailingDiscHint(separatorNormalized);
    const preferred = stripped || separatorNormalized || raw;
    return toSearchTitleCase(preferred);
  };
  const parseDiscNumber = (rawValue) => {
    const text = String(rawValue ?? '').trim();
    if (!/^\d+$/.test(text)) {
      return null;
    }
    const parsed = Number(text);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return null;
    }
    return Math.trunc(parsed);
  };

  const [selected, setSelected] = useState(null);
  const [query, setQuery] = useState('');
  const [manualTitle, setManualTitle] = useState('');
  const [manualYear, setManualYear] = useState('');
  const [manualImdb, setManualImdb] = useState('');
  const [manualDiscNumber, setManualDiscNumber] = useState('');
  const [extraResults, setExtraResults] = useState([]);
  const [hasSearchOverride, setHasSearchOverride] = useState(false);
  const [searchBusy, setSearchBusy] = useState(false);
  const [searchError, setSearchError] = useState('');
  const [submitError, setSubmitError] = useState('');
  const [conflictState, setConflictState] = useState(null);
  const [conflictExistingDiscNumber, setConflictExistingDiscNumber] = useState('');
  const [conflictNewDiscNumber, setConflictNewDiscNumber] = useState('');
  const [conflictError, setConflictError] = useState('');
  const [seasonFilter, setSeasonFilter] = useState('');
  const [resultFilter, setResultFilter] = useState('all');
  const [discValidationError, setDiscValidationError] = useState('');
  const activeSearchRequestRef = useRef(0);
  const autoSearchDoneRef = useRef(false);
  const wasVisibleRef = useRef(false);
  const lastVisibleContextIdentityRef = useRef(null);

  const mediaProfile = String(
    context?.mediaProfile
    || context?.selectedMetadata?.mediaProfile
    || ''
  ).trim().toLowerCase();
  const metadataProvider = 'tmdb';
  const providerLabel = 'TMDb';
  const supportsExternalIdInput = false;
  const contextJobId = Number(context?.jobId || 0) || null;
  const contextIdentity = contextJobId
    ? `job:${contextJobId}`
    : `detected:${String(context?.detectedTitle || '').trim().toLowerCase()}`;

  useEffect(() => {
    if (!visible) {
      wasVisibleRef.current = false;
      lastVisibleContextIdentityRef.current = null;
      return;
    }
    const openingNow = !wasVisibleRef.current;
    const contextChanged = lastVisibleContextIdentityRef.current !== contextIdentity;
    if (!openingNow && !contextChanged) {
      return;
    }

    const selectedMetadata = context?.selectedMetadata || {};
    const rawDefaultTitle = selectedMetadata.title || context?.detectedTitle || '';
    const defaultTitle = normalizeDetectedTitleForMetadataInput(rawDefaultTitle) || rawDefaultTitle;
    const defaultYear = selectedMetadata.year ? String(selectedMetadata.year) : '';
    const defaultImdb = selectedMetadata.imdbId || '';

    setSelected(null);
    setQuery(defaultTitle);
    setManualTitle(defaultTitle);
    setManualYear(defaultYear);
    setManualImdb(defaultImdb);
    setManualDiscNumber('');
    setExtraResults([]);
    setHasSearchOverride(false);
    setSearchBusy(false);
    setSearchError('');
    setSubmitError('');
    setConflictState(null);
    setConflictExistingDiscNumber('');
    setConflictNewDiscNumber('');
    setConflictError('');
    setSeasonFilter('');
    setResultFilter('all');
    setDiscValidationError('');
    autoSearchDoneRef.current = false;
    activeSearchRequestRef.current += 1;
    wasVisibleRef.current = true;
    lastVisibleContextIdentityRef.current = contextIdentity;
  }, [visible, contextIdentity, context]);

  useEffect(() => {
    if (submitError) {
      setSubmitError('');
    }
  }, [manualDiscNumber, seasonFilter, selected, resultFilter, conflictExistingDiscNumber, conflictNewDiscNumber]);

  const rows = useMemo(() => {
    const base = Array.isArray(context?.metadataCandidates)
      ? context.metadataCandidates
      : [];
    const sourceRows = hasSearchOverride ? extraResults : base;
    const all = Array.isArray(sourceRows) ? sourceRows : [];
    const map = new Map();

    all.forEach((item) => {
      const normalized = normalizeMetadataRow(item);
      const rowType = normalizeResultType(normalized?.resultType) || 'movie';
      const rowKey = String(
        normalized?.providerId
        || `${rowType}:${normalized?.imdbId || normalized?.tmdbId || '-'}:${normalized?.seasonNumber || '-'}:${normalized?.title || '-'}:${normalized?.year || '-'}`
      ).trim();
      if (!rowKey) {
        return;
      }
      map.set(rowKey, {
        ...normalized,
        _metadataKey: rowKey
      });
    });

    return Array.from(map.values());
  }, [context, extraResults, hasSearchOverride]);

  const seriesRowsAvailable = useMemo(
    () => rows.some((row) => normalizeResultType(row?.resultType) === 'series'),
    [rows]
  );

  const selectedResultType = normalizeResultType(selected?.resultType)
    || (normalizeWorkflowKind(selected?.workflowKind) === 'series' ? 'series' : 'movie');
  const selectedIsSeries = Boolean(selected) && selectedResultType === 'series';
  const showSeasonFilter = resultFilter !== 'movies' && seriesRowsAvailable;

  const filteredRows = useMemo(() => {
    let output = [...rows];

    if (resultFilter === 'movies') {
      output = output.filter((row) => normalizeResultType(row?.resultType) !== 'series');
    } else if (resultFilter === 'series') {
      output = output.filter((row) => normalizeResultType(row?.resultType) === 'series');
    }

    if (showSeasonFilter) {
      const normalizedFilter = String(seasonFilter || '').trim().toLowerCase();
      if (normalizedFilter) {
        output = output.filter((row) => {
          if (normalizeResultType(row?.resultType) !== 'series') {
            return false;
          }
          const seasonNo = String(row?.seasonNumber ?? '').trim().toLowerCase();
          const seasonName = String(row?.seasonName || '').trim().toLowerCase();
          return seasonNo.includes(normalizedFilter) || seasonName.includes(normalizedFilter);
        });
      }
    }

    return output;
  }, [rows, resultFilter, seasonFilter, showSeasonFilter]);

  const effectiveDiscNumber = parseDiscNumber(manualDiscNumber);
  const hasValidDiscNumber = effectiveDiscNumber !== null;
  const requiresDiscNumber = metadataProvider === 'tmdb'
    && selectedIsSeries
    && (mediaProfile === 'dvd' || mediaProfile === 'bluray');

  useEffect(() => {
    if (!discValidationError) {
      return;
    }
    if (!requiresDiscNumber || hasValidDiscNumber) {
      setDiscValidationError('');
    }
  }, [discValidationError, requiresDiscNumber, hasValidDiscNumber]);

  const titleWithPosterBody = (row) => (
    <div className="metadata-row">
      {row.poster && row.poster !== 'N/A' ? (
        <img src={row.poster} alt={row.title} className="poster-thumb-lg" />
      ) : (
        <div className="poster-thumb-lg poster-fallback">-</div>
      )}
      <div>
        <div><strong>{row.title}</strong></div>
        <small>
          {row.year || '-'}
          {row.seasonNumber ? ` | Staffel ${row.seasonNumber}` : ''}
          {row.seasonName ? ` | ${row.seasonName}` : ''}
          {row.episodeCount ? ` | ${row.episodeCount} Episoden` : ''}
          {row.imdbId ? ` | ${row.imdbId}` : ''}
          {!row.imdbId && row.tmdbId ? ` | TMDb ${row.tmdbId}` : ''}
        </small>
      </div>
    </div>
  );

  const handleSearch = async () => {
    const trimmedQuery = String(query || '').trim();
    if (!trimmedQuery || typeof onSearch !== 'function') {
      return;
    }
    const queryVariants = buildSearchVariants(trimmedQuery);
    if (queryVariants.length === 0) {
      return;
    }
    const requestId = activeSearchRequestRef.current + 1;
    activeSearchRequestRef.current = requestId;
    setHasSearchOverride(true);
    setSearchBusy(true);
    setSearchError('');
    try {
      let effectiveResults = [];
      for (const candidateQuery of queryVariants) {
        const results = await onSearch(candidateQuery, {
          metadataProvider
        });
        if (activeSearchRequestRef.current !== requestId) {
          return;
        }
        if (Array.isArray(results) && results.length > 0) {
          effectiveResults = results;
          break;
        }
      }
      setExtraResults(Array.isArray(effectiveResults) ? effectiveResults : []);
    } catch (error) {
      if (activeSearchRequestRef.current !== requestId) {
        return;
      }
      setSearchError(error?.message || 'Suche fehlgeschlagen.');
    } finally {
      if (activeSearchRequestRef.current === requestId) {
        setSearchBusy(false);
      }
    }
  };

  useEffect(() => {
    if (!visible) {
      return;
    }
    if (typeof onSearch !== 'function') {
      autoSearchDoneRef.current = true;
      return;
    }
    const trimmedQuery = String(query || '').trim();
    if (!trimmedQuery) {
      return;
    }
    if (autoSearchDoneRef.current) {
      return;
    }
    autoSearchDoneRef.current = true;
    void handleSearch();
  }, [visible, query, onSearch]);

  const handleSubmitError = (error, pendingPayload = null) => {
    const details = Array.isArray(error?.details) ? error.details : [];
    const duplicateDetail = details.find(
      (detail) => String(detail?.code || '').trim().toUpperCase() === 'METADATA_DUPLICATE_FOUND'
    );
    if (duplicateDetail) {
      const existingJob = duplicateDetail?.existingJob && typeof duplicateDetail.existingJob === 'object'
        ? duplicateDetail.existingJob
        : null;
      const nextPendingPayload = pendingPayload && typeof pendingPayload === 'object'
        ? pendingPayload
        : (conflictState?.pendingPayload && typeof conflictState.pendingPayload === 'object'
          ? conflictState.pendingPayload
          : null);
      const pendingDiscNumber = parseDiscNumber(nextPendingPayload?.discNumber);
      const existingDiscNumber = parseDiscNumber(existingJob?.discNumber);
      setConflictState({
        existingJob,
        pendingPayload: nextPendingPayload
      });
      setConflictExistingDiscNumber(existingDiscNumber ? String(existingDiscNumber) : '');
      setConflictNewDiscNumber(pendingDiscNumber ? String(pendingDiscNumber) : '');
      setConflictError('');
      setSubmitError('');
      return;
    }

    const hasDuplicateDiscError = details.some(
      (detail) => String(detail?.code || '').trim().toUpperCase() === 'SERIES_DISC_ALREADY_EXISTS'
    );
    const message = String(error?.message || 'Metadaten konnten nicht uebernommen werden.').trim()
      || 'Metadaten konnten nicht uebernommen werden.';
    if (hasDuplicateDiscError) {
      setSubmitError(message);
      return;
    }
    setSubmitError(message);
  };

  const handleSubmit = async () => {
    setDiscValidationError('');
    setSubmitError('');
    setConflictError('');
    if (requiresDiscNumber && !hasValidDiscNumber) {
      setDiscValidationError('Disk-Nummer ist Pflicht und muss eine ganze Zahl >= 1 sein.');
      return;
    }

    const selectionWorkflowKind = selectedIsSeries ? 'series' : 'film';
    const manualWorkflowKind = resultFilter === 'series' ? 'series' : 'film';

    const payload = selected
      ? {
          jobId: context.jobId,
          title: selected.title,
          year: selected.year,
          imdbId: selected.imdbId,
          poster: selected.poster && selected.poster !== 'N/A' ? selected.poster : null,
          metadataProvider,
          workflowKind: selectionWorkflowKind,
          providerId: selected.providerId || null,
          tmdbId: selected.tmdbId || null,
          metadataKind: selected.metadataKind || (selectedIsSeries ? 'series' : 'movie'),
          voteAverage: Number.isFinite(Number(selected?.voteAverage))
            ? Number(Number(selected.voteAverage).toFixed(1))
            : null,
          imdbRating: String(
            selected?.imdbRating
            || selected?.tmdbDetails?.imdbRating
            || ''
          ).trim() || null,
          tmdbDetails: selected?.tmdbDetails && typeof selected.tmdbDetails === 'object'
            ? selected.tmdbDetails
            : null,
          seasonNumber: selectedIsSeries ? (selected.seasonNumber || null) : null,
          seasonName: selectedIsSeries ? (selected.seasonName || null) : null,
          episodeCount: selectedIsSeries ? (selected.episodeCount || 0) : 0,
          episodes: selectedIsSeries && Array.isArray(selected.episodes) ? selected.episodes : [],
          ...(effectiveDiscNumber ? { discNumber: effectiveDiscNumber } : {})
        }
      : {
          jobId: context.jobId,
          title: manualTitle,
          year: manualYear,
          imdbId: null,
          poster: null,
          metadataProvider,
          workflowKind: manualWorkflowKind,
          seasonNumber: null,
          ...(effectiveDiscNumber ? { discNumber: effectiveDiscNumber } : {})
        };

    try {
      await onSubmit(payload);
    } catch (error) {
      handleSubmitError(error, payload);
    }
  };

  const handleForceDuplicateSubmit = async () => {
    const pendingPayload = conflictState?.pendingPayload && typeof conflictState.pendingPayload === 'object'
      ? conflictState.pendingPayload
      : null;
    if (!pendingPayload) {
      setConflictError('Konflikt-Zustand ist unvollständig. Bitte erneut suchen.');
      return;
    }
    setConflictError('');
    setSubmitError('');
    try {
      await onSubmit({
        ...pendingPayload,
        duplicateAction: 'allow_new'
      });
    } catch (error) {
      handleSubmitError(error, pendingPayload);
    }
  };

  const handleSubmitMultipartMovie = async () => {
    const pendingPayload = conflictState?.pendingPayload && typeof conflictState.pendingPayload === 'object'
      ? conflictState.pendingPayload
      : null;
    const existingJob = conflictState?.existingJob && typeof conflictState.existingJob === 'object'
      ? conflictState.existingJob
      : null;
    if (!pendingPayload || !existingJob?.id) {
      setConflictError('Konflikt-Zustand ist unvollständig. Bitte erneut suchen.');
      return;
    }

    const existingDisc = parseDiscNumber(conflictExistingDiscNumber);
    const newDisc = parseDiscNumber(conflictNewDiscNumber);
    if (!existingDisc || !newDisc) {
      setConflictError('Für Multipart movie müssen beide Disc-Nummern gesetzt werden (>= 1).');
      return;
    }
    if (existingDisc === newDisc) {
      setConflictError('Disc-Nummern müssen unterschiedlich sein.');
      return;
    }

    setConflictError('');
    setSubmitError('');
    try {
      await onSubmit({
        ...pendingPayload,
        duplicateAction: 'multipart_movie',
        existingJobId: existingJob.id,
        discNumber: newDisc,
        existingDiscNumber: existingDisc
      });
    } catch (error) {
      handleSubmitError(error, pendingPayload);
    }
  };

  const handleHideRequest = () => {
    onHide?.();
  };

  if (conflictState) {
    const existingJob = conflictState?.existingJob && typeof conflictState.existingJob === 'object'
      ? conflictState.existingJob
      : null;
    return (
      <Dialog
        header="Metadaten bereits vorhanden"
        visible={visible}
        onHide={handleHideRequest}
        style={{ width: '38rem', maxWidth: '96vw' }}
        className="metadata-selection-dialog"
        breakpoints={{ '1200px': '92vw', '768px': '96vw', '560px': '98vw' }}
        modal
      >
        <p>
          Für diese Film-Metadaten existiert bereits ein Job in der Historie.
        </p>
        <p>
          Bestehender Job: <strong>#{existingJob?.id || '-'}</strong>
          {' | '}
          <strong>{existingJob?.title || '-'}</strong>
          {existingJob?.year ? ` (${existingJob.year})` : ''}
        </p>
        <p>
          Status: {existingJob?.status || '-'}
          {existingJob?.discNumber ? ` | Disc ${existingJob.discNumber}` : ''}
        </p>
        <div className="metadata-grid">
          <InputText
            value={conflictExistingDiscNumber}
            onChange={(event) => setConflictExistingDiscNumber(event.target.value)}
            placeholder="Disc-Nr bestehender Job"
            inputMode="numeric"
            disabled={busy}
          />
          <InputText
            value={conflictNewDiscNumber}
            onChange={(event) => setConflictNewDiscNumber(event.target.value)}
            placeholder="Disc-Nr neuer Job"
            inputMode="numeric"
            disabled={busy}
          />
        </div>
        {conflictError ? <small className="error-text">{conflictError}</small> : null}
        {submitError ? <small className="error-text">{submitError}</small> : null}
        <div className="dialog-actions">
          <Button
            label="Zurück zur Auswahl"
            severity="secondary"
            text
            onClick={() => {
              setConflictState(null);
              setConflictError('');
            }}
            disabled={busy}
          />
          <Button
            label="Übernahme erzwingen"
            severity="secondary"
            outlined
            onClick={handleForceDuplicateSubmit}
            loading={busy}
          />
          <Button
            label="Multipart movie"
            icon="pi pi-sitemap"
            onClick={handleSubmitMultipartMovie}
            loading={busy}
          />
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog
      header="Metadaten auswählen"
      visible={visible}
      onHide={handleHideRequest}
      style={{ width: '58.25rem', maxWidth: '95vw', maxHeight: '950px' }}
      className="metadata-selection-dialog"
      breakpoints={{ '1200px': '92vw', '768px': '96vw', '560px': '98vw' }}
      modal
    >
      <div className="metadata-dialog-controls">
        <div className="search-row">
          <InputText
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                void handleSearch();
              }
            }}
            placeholder="Titel suchen"
          />
          <Button label={`${providerLabel} Suche`} icon="pi pi-search" onClick={handleSearch} loading={searchBusy} disabled={searchBusy || busy} />
        </div>

        <div className={`metadata-filter-grid${showSeasonFilter ? '' : ' metadata-filter-grid-single'}`}>
          {showSeasonFilter ? (
            <InputText
              value={seasonFilter}
              onChange={(event) => setSeasonFilter(event.target.value)}
              placeholder="Staffel-Filter (optional, z.B. 1 oder 5.2)"
              disabled={searchBusy || busy}
            />
          ) : null}
          <div className="metadata-filter-disc">
            <InputText
              value={manualDiscNumber}
              onChange={(event) => setManualDiscNumber(event.target.value)}
              placeholder={requiresDiscNumber ? 'Disc-Nr (Pflicht)' : 'Disc-Nr (optional)'}
              inputMode="numeric"
              disabled={searchBusy || busy}
            />
            <small className="metadata-filter-subtitle">
              {requiresDiscNumber
                ? 'Pflichtfeld für Serien-DVD/Blu-ray. Ohne Disc-Nummer können die Metadaten nicht übernommen werden.'
                : 'Optional für Mapping und Output-Templates. Gespeichert werden nur Werte > 0.'}
            </small>
          </div>
        </div>

        <div className="metadata-result-filter-row">
          <Button
            label="Beides"
            severity={resultFilter === 'all' ? 'primary' : 'secondary'}
            outlined={resultFilter !== 'all'}
            onClick={() => setResultFilter('all')}
            disabled={searchBusy || busy}
          />
          <Button
            label="Filme"
            severity={resultFilter === 'movies' ? 'primary' : 'secondary'}
            outlined={resultFilter !== 'movies'}
            onClick={() => setResultFilter('movies')}
            disabled={searchBusy || busy}
          />
          <Button
            label="Serien"
            severity={resultFilter === 'series' ? 'primary' : 'secondary'}
            outlined={resultFilter !== 'series'}
            onClick={() => setResultFilter('series')}
            disabled={searchBusy || busy}
          />
        </div>
      </div>

      {searchError ? <small className="error-text">{searchError}</small> : null}
      {discValidationError ? <small className="error-text">{discValidationError}</small> : null}
      {submitError ? <small className="error-text">{submitError}</small> : null}

      <div className="table-scroll-wrap table-scroll-medium">
        <DataTable
          value={filteredRows}
          selectionMode="single"
          selection={selected}
          onSelectionChange={(event) => setSelected(event.value)}
          dataKey="_metadataKey"
          size="small"
          scrollable
          scrollHeight="22rem"
          emptyMessage="Keine Treffer"
          responsiveLayout="stack"
          breakpoint="960px"
        >
          <Column header="Titel" body={titleWithPosterBody} />
          <Column field="year" header="Jahr" style={{ width: '8rem' }} />
          <Column
            header="Typ"
            body={(row) => (normalizeResultType(row?.resultType) === 'series' ? 'Serie' : 'Film')}
            style={{ width: '7rem' }}
          />
          <Column
            header="Staffel"
            body={(row) => (normalizeResultType(row?.resultType) === 'series'
              ? (row.seasonNumber ? `S${row.seasonNumber}` : '-')
              : '-')}
            style={{ width: '8rem' }}
          />
        </DataTable>
      </div>

      <h4>Manuelle Eingabe</h4>
      <div className="metadata-grid">
        <InputText
          value={manualTitle}
          onChange={(event) => setManualTitle(event.target.value)}
          placeholder="Titel"
          disabled={!!selected}
        />
        <InputText
          value={manualYear}
          onChange={(event) => setManualYear(event.target.value)}
          placeholder="Jahr"
          disabled={!!selected}
        />
        <InputText
          value={manualImdb}
          onChange={(event) => setManualImdb(event.target.value)}
          placeholder={supportsExternalIdInput ? 'IMDb-ID' : 'Externe ID'}
          disabled={!!selected || !supportsExternalIdInput}
        />
      </div>

      <div className="dialog-actions">
        <Button
          label="Abbrechen"
          severity="secondary"
          text
          onClick={handleHideRequest}
        />
        <Button
          label="Auswahl übernehmen"
          icon="pi pi-play"
          onClick={handleSubmit}
          loading={busy}
          disabled={
            (!selected && !manualTitle.trim() && !manualImdb.trim())
            || (requiresDiscNumber && !hasValidDiscNumber)
          }
        />
      </div>
    </Dialog>
  );
}
