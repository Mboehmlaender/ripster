import { useEffect, useState } from 'react';
import { Dialog } from 'primereact/dialog';
import { Button } from 'primereact/button';
import { DataTable } from 'primereact/datatable';
import { Column } from 'primereact/column';
import { InputText } from 'primereact/inputtext';
import { InputNumber } from 'primereact/inputnumber';
import { Checkbox } from 'primereact/checkbox';

function formatDurationMs(ms) {
  const totalSec = Math.round((ms || 0) / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}:${String(sec).padStart(2, '0')}`;
}

export default function CdMetadataDialog({
  visible,
  context,
  onHide,
  onSubmit,
  onSearch,
  busy
}) {
  const [selected, setSelected] = useState(null);
  const [query, setQuery] = useState('');
  const [extraResults, setExtraResults] = useState([]);

  // Manual metadata inputs
  const [manualTitle, setManualTitle] = useState('');
  const [manualArtist, setManualArtist] = useState('');
  const [manualYear, setManualYear] = useState(null);

  // Per-track title editing
  const [trackTitles, setTrackTitles] = useState({});
  const [selectedTrackPositions, setSelectedTrackPositions] = useState(new Set());

  const tocTracks = Array.isArray(context?.tracks) ? context.tracks : [];

  useEffect(() => {
    if (!visible) {
      return;
    }
    setSelected(null);
    setQuery(context?.detectedTitle || '');
    setManualTitle(context?.detectedTitle || '');
    setManualArtist('');
    setManualYear(null);
    setExtraResults([]);

    const titles = {};
    const positions = new Set();
    for (const t of tocTracks) {
      titles[t.position] = t.title || `Track ${t.position}`;
      positions.add(t.position);
    }
    setTrackTitles(titles);
    setSelectedTrackPositions(positions);
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

  const allMbRows = [
    ...(Array.isArray(context?.mbCandidates) ? context.mbCandidates : []),
    ...extraResults
  ].filter(Boolean);

  // Deduplicate by mbId
  const mbRows = [];
  const seen = new Set();
  for (const r of allMbRows) {
    if (r.mbId && !seen.has(r.mbId)) {
      seen.add(r.mbId);
      mbRows.push(r);
    }
  }

  const handleSearch = async () => {
    if (!query.trim()) {
      return;
    }
    const results = await onSearch(query.trim());
    setExtraResults(results || []);
  };

  const handleToggleTrack = (position) => {
    setSelectedTrackPositions((prev) => {
      const next = new Set(prev);
      if (next.has(position)) {
        next.delete(position);
      } else {
        next.add(position);
      }
      return next;
    });
  };

  const handleToggleAll = () => {
    if (selectedTrackPositions.size === tocTracks.length) {
      setSelectedTrackPositions(new Set());
    } else {
      setSelectedTrackPositions(new Set(tocTracks.map((t) => t.position)));
    }
  };

  const handleSubmit = async () => {
    const tracks = tocTracks.map((t) => ({
      position: t.position,
      title: trackTitles[t.position] || `Track ${t.position}`,
      selected: selectedTrackPositions.has(t.position)
    }));

    const payload = {
      jobId: context.jobId,
      title: manualTitle.trim() || context?.detectedTitle || 'Audio CD',
      artist: manualArtist.trim() || null,
      year: manualYear || null,
      mbId: selected?.mbId || null,
      coverUrl: selected?.coverArtUrl || null,
      tracks
    };

    await onSubmit(payload);
  };

  const mbTitleBody = (row) => (
    <div className="mb-result-row">
      {row.coverArtUrl ? (
        <img src={row.coverArtUrl} alt={row.title} className="poster-thumb-lg" />
      ) : (
        <div className="poster-thumb-lg poster-fallback">-</div>
      )}
      <div>
        <div><strong>{row.title}</strong></div>
        <small>{row.artist}{row.year ? ` | ${row.year}` : ''}</small>
        {row.label ? <small> | {row.label}</small> : null}
      </div>
    </div>
  );

  const allSelected = tocTracks.length > 0 && selectedTrackPositions.size === tocTracks.length;
  const noneSelected = selectedTrackPositions.size === 0;

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
        <Button label="MusicBrainz Suche" icon="pi pi-search" onClick={handleSearch} loading={busy} />
      </div>

      {mbRows.length > 0 ? (
        <div className="table-scroll-wrap table-scroll-medium">
          <DataTable
            value={mbRows}
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

      {/* Track selection */}
      {tocTracks.length > 0 ? (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginTop: '1rem', marginBottom: '0.25rem' }}>
            <h4 style={{ margin: 0 }}>Tracks ({tocTracks.length})</h4>
            <Button
              label={allSelected ? 'Alle abwählen' : 'Alle auswählen'}
              size="small"
              severity="secondary"
              outlined
              onClick={handleToggleAll}
            />
          </div>
          <div className="cd-track-list">
            {tocTracks.map((track) => (
              <div key={track.position} className="cd-track-row">
                <Checkbox
                  checked={selectedTrackPositions.has(track.position)}
                  onChange={() => handleToggleTrack(track.position)}
                  inputId={`track-${track.position}`}
                />
                <span className="cd-track-num">{String(track.position).padStart(2, '0')}</span>
                <InputText
                  value={trackTitles[track.position] ?? `Track ${track.position}`}
                  onChange={(e) => setTrackTitles((prev) => ({ ...prev, [track.position]: e.target.value }))}
                  className="cd-track-title-input"
                  placeholder={`Track ${track.position}`}
                  disabled={!selectedTrackPositions.has(track.position)}
                />
                <span className="cd-track-duration">
                  {track.durationMs ? formatDurationMs(track.durationMs) : '-'}
                </span>
              </div>
            ))}
          </div>
        </>
      ) : null}

      <div className="dialog-actions" style={{ marginTop: '1rem' }}>
        <Button label="Abbrechen" severity="secondary" text onClick={onHide} />
        <Button
          label="Weiter"
          icon="pi pi-arrow-right"
          onClick={handleSubmit}
          loading={busy}
          disabled={noneSelected || (!manualTitle.trim() && !context?.detectedTitle)}
        />
      </div>
    </Dialog>
  );
}
