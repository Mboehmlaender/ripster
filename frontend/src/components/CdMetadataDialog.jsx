import { useEffect, useRef, useState } from 'react';
import { Dialog } from 'primereact/dialog';
import { Button } from 'primereact/button';
import { DataTable } from 'primereact/datatable';
import { Column } from 'primereact/column';
import { InputText } from 'primereact/inputtext';
import { InputNumber } from 'primereact/inputnumber';

function CoverThumb({ url, alt }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setFailed(false);
  }, [url]);
  if (!url || failed) {
    return <div className="poster-thumb-lg poster-fallback">-</div>;
  }
  return (
    <img
      src={url}
      alt={alt}
      className="poster-thumb-lg"
      loading="eager"
      decoding="sync"
      onError={() => setFailed(true)}
    />
  );
}

const COVER_PRELOAD_TIMEOUT_MS = 3000;

function preloadCoverImage(url) {
  const src = String(url || '').trim();
  if (!src) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const image = new Image();
    let settled = false;
    const cleanup = () => {
      image.onload = null;
      image.onerror = null;
    };
    const done = () => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve();
    };
    const timer = window.setTimeout(done, COVER_PRELOAD_TIMEOUT_MS);
    image.onload = () => {
      window.clearTimeout(timer);
      done();
    };
    image.onerror = () => {
      window.clearTimeout(timer);
      done();
    };
    image.src = src;
  });
}

export default function CdMetadataDialog({
  visible,
  context,
  onHide,
  onSubmit,
  onSearch,
  onFetchRelease,
  busy
}) {
  const [selected, setSelected] = useState(null);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [searchBusy, setSearchBusy] = useState(false);
  const searchRunRef = useRef(0);

  // Manual metadata inputs
  const [manualTitle, setManualTitle] = useState('');
  const [manualArtist, setManualArtist] = useState('');
  const [manualYear, setManualYear] = useState(null);

  // Track titles are pre-filled from MusicBrainz and edited in the next step.
  const [trackTitles, setTrackTitles] = useState({});

  const tocTracks = Array.isArray(context?.tracks) ? context.tracks : [];

  useEffect(() => {
    if (!visible) {
      return;
    }
    setSelected(null);
    setQuery('');
    setManualTitle(context?.detectedTitle || '');
    setManualArtist('');
    setManualYear(null);
    setResults([]);
    setSearchBusy(false);

    const titles = {};
    for (const t of tocTracks) {
      titles[t.position] = t.title || `Track ${t.position}`;
    }
    setTrackTitles(titles);
  }, [visible, context]);

  useEffect(() => {
    if (!selected) {
      return;
    }
    setManualTitle(selected.title || '');
    setManualArtist(selected.artist || '');
    setManualYear(selected.year || null);

    // Pre-fill track titles from the MusicBrainz result
    if (Array.isArray(selected.tracks) && selected.tracks.length > 0) {
      const titles = {};
      for (const t of selected.tracks) {
        if (t.position <= tocTracks.length) {
          titles[t.position] = t.title || `Track ${t.position}`;
        }
      }
      // Fill any remaining tracks not in MB result
      for (const t of tocTracks) {
        if (!titles[t.position]) {
          titles[t.position] = t.title || `Track ${t.position}`;
        }
      }
      setTrackTitles(titles);
    }
  }, [selected]);

  const handleSearch = async () => {
    const trimmedQuery = query.trim();
    if (!trimmedQuery) {
      return;
    }
    setSearchBusy(true);
    const searchRunId = searchRunRef.current + 1;
    searchRunRef.current = searchRunId;
    try {
      const searchResults = await onSearch(trimmedQuery);
      const normalizedResults = Array.isArray(searchResults) ? searchResults : [];
      await Promise.all(normalizedResults.map((item) => preloadCoverImage(item?.coverArtUrl)));
      if (searchRunRef.current !== searchRunId) {
        return;
      }
      setResults(normalizedResults);
      setSelected(null);
    } finally {
      if (searchRunRef.current === searchRunId) {
        setSearchBusy(false);
      }
    }
  };

  const handleSubmit = async () => {
    const normalizeTrackText = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    let releaseDetails = selected;
    if (selected?.mbId && (!Array.isArray(selected?.tracks) || selected.tracks.length === 0) && typeof onFetchRelease === 'function') {
      const fetched = await onFetchRelease(selected.mbId);
      if (fetched && typeof fetched === 'object') {
        releaseDetails = fetched;
      }
    }

    const releaseTracks = Array.isArray(releaseDetails?.tracks) ? releaseDetails.tracks : [];
    const releaseTracksByPosition = new Map();
    releaseTracks.forEach((track, index) => {
      const parsedPosition = Number(track?.position);
      const normalizedPosition = Number.isFinite(parsedPosition) && parsedPosition > 0
        ? Math.trunc(parsedPosition)
        : index + 1;
      if (!releaseTracksByPosition.has(normalizedPosition)) {
        releaseTracksByPosition.set(normalizedPosition, track);
      }
    });

    const tracks = tocTracks.map((t, index) => {
      const position = Number(t.position);
      const byPosition = releaseTracksByPosition.get(position);
      const byIndex = releaseTracks[index];
      return {
        position,
        title: normalizeTrackText(
          byPosition?.title
          || byIndex?.title
          || trackTitles[t.position]
        ) || `Track ${t.position}`,
        artist: normalizeTrackText(
          byPosition?.artist
          || byIndex?.artist
          || manualArtist.trim()
          || releaseDetails?.artist
        ) || null,
        selected: true
      };
    });

    const payload = {
      jobId: context.jobId,
      title: manualTitle.trim() || context?.detectedTitle || 'Audio CD',
      artist: manualArtist.trim() || null,
      year: manualYear || null,
      mbId: releaseDetails?.mbId || selected?.mbId || null,
      coverUrl: releaseDetails?.coverArtUrl || selected?.coverArtUrl || null,
      tracks
    };

    await onSubmit(payload);
  };

  const mbTitleBody = (row) => (
    <div className="mb-result-row">
      <CoverThumb url={row.coverArtUrl} alt={row.title} />
      <div>
        <div><strong>{row.title}</strong></div>
        <small>{row.artist}{row.year ? ` | ${row.year}` : ''}</small>
        {row.label ? <small> | {row.label}</small> : null}
      </div>
    </div>
  );

  return (
    <Dialog
      header="CD-Metadaten auswählen"
      visible={visible}
      onHide={onHide}
      style={{ width: '58rem', maxWidth: '97vw' }}
      className="cd-metadata-dialog"
      breakpoints={{ '1200px': '92vw', '768px': '96vw', '560px': '98vw' }}
      modal
    >
      {/* MusicBrainz search */}
      <div className="search-row">
        <InputText
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
          placeholder="Album / Interpret suchen"
        />
        <Button
          label="MusicBrainz Suche"
          icon="pi pi-search"
          onClick={handleSearch}
          loading={busy || searchBusy}
        />
      </div>

      {results.length > 0 ? (
        <div className="table-scroll-wrap table-scroll-medium">
          <DataTable
            value={results}
            selectionMode="single"
            selection={selected}
            onSelectionChange={(e) => setSelected(e.value)}
            dataKey="mbId"
            size="small"
            scrollable
            scrollHeight="16rem"
            emptyMessage="Keine Treffer"
          >
            <Column header="Album" body={mbTitleBody} />
            <Column field="year" header="Jahr" style={{ width: '6rem' }} />
            <Column field="country" header="Land" style={{ width: '6rem' }} />
          </DataTable>
        </div>
      ) : null}

      {/* Manual metadata */}
      <h4 style={{ marginTop: '1rem', marginBottom: '0.5rem' }}>Metadaten</h4>
      <div className="metadata-grid">
        <InputText
          value={manualTitle}
          onChange={(e) => setManualTitle(e.target.value)}
          placeholder="Album-Titel"
        />
        <InputText
          value={manualArtist}
          onChange={(e) => setManualArtist(e.target.value)}
          placeholder="Interpret / Band"
        />
        <InputNumber
          value={manualYear}
          onValueChange={(e) => setManualYear(e.value)}
          placeholder="Jahr"
          useGrouping={false}
          min={1900}
          max={2100}
        />
      </div>

      {/* Track selection/editing moved to CD-Rip configuration panel */}
      {tocTracks.length > 0 ? (
        <small style={{ display: 'block', marginTop: '0.9rem' }}>
          {tocTracks.length} Tracks erkannt. Auswahl/Feinschliff (Checkboxen, Interpret, Titel, Länge) erfolgt im nächsten Schritt in der Job-Übersicht.
        </small>
      ) : null}

      <div className="dialog-actions" style={{ marginTop: '1rem' }}>
        <Button label="Abbrechen" severity="secondary" text onClick={onHide} />
        <Button
          label="Weiter"
          icon="pi pi-arrow-right"
          onClick={handleSubmit}
          loading={busy}
          disabled={!manualTitle.trim() && !context?.detectedTitle}
        />
      </div>
    </Dialog>
  );
}
