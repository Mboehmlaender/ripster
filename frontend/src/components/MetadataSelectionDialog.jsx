import { useEffect, useMemo, useState } from 'react';
import { Dialog } from 'primereact/dialog';
import { Button } from 'primereact/button';
import { DataTable } from 'primereact/datatable';
import { Column } from 'primereact/column';
import { InputText } from 'primereact/inputtext';

export default function MetadataSelectionDialog({
  visible,
  context,
  onHide,
  onSubmit,
  onSearch,
  busy
}) {
  const [selected, setSelected] = useState(null);
  const [query, setQuery] = useState('');
  const [manualTitle, setManualTitle] = useState('');
  const [manualYear, setManualYear] = useState('');
  const [manualImdb, setManualImdb] = useState('');
  const [extraResults, setExtraResults] = useState([]);

  useEffect(() => {
    if (!visible) {
      return;
    }

    const selectedMetadata = context?.selectedMetadata || {};
    const defaultTitle = selectedMetadata.title || context?.detectedTitle || '';
    const defaultYear = selectedMetadata.year ? String(selectedMetadata.year) : '';
    const defaultImdb = selectedMetadata.imdbId || '';

    setSelected(null);
    setQuery(defaultTitle);
    setManualTitle(defaultTitle);
    setManualYear(defaultYear);
    setManualImdb(defaultImdb);
    setExtraResults([]);
  }, [visible, context]);

  const rows = useMemo(() => {
    const base = context?.omdbCandidates || [];
    const all = [...base, ...extraResults];
    const map = new Map();

    all.forEach((item) => {
      if (item?.imdbId) {
        map.set(item.imdbId, item);
      }
    });

    return Array.from(map.values());
  }, [context, extraResults]);

  const titleWithPosterBody = (row) => (
    <div className="omdb-row">
      {row.poster && row.poster !== 'N/A' ? (
        <img src={row.poster} alt={row.title} className="poster-thumb-lg" />
      ) : (
        <div className="poster-thumb-lg poster-fallback">-</div>
      )}
      <div>
        <div><strong>{row.title}</strong></div>
        <small>{row.year} | {row.imdbId}</small>
      </div>
    </div>
  );

  const handleSearch = async () => {
    if (!query.trim()) {
      return;
    }
    const results = await onSearch(query.trim());
    setExtraResults(results || []);
  };

  const handleSubmit = async () => {
    const payload = selected
      ? {
          jobId: context.jobId,
          title: selected.title,
          year: selected.year,
          imdbId: selected.imdbId,
          poster: selected.poster && selected.poster !== 'N/A' ? selected.poster : null,
          fromOmdb: true
        }
      : {
          jobId: context.jobId,
          title: manualTitle,
          year: manualYear,
          imdbId: manualImdb,
          poster: null,
          fromOmdb: false
        };

    await onSubmit(payload);
  };

  return (
    <Dialog
      header="Metadaten auswählen"
      visible={visible}
      onHide={onHide}
      style={{ width: '52rem', maxWidth: '95vw' }}
      className="metadata-selection-dialog"
      breakpoints={{ '1200px': '92vw', '768px': '96vw', '560px': '98vw' }}
      modal
    >
      <div className="search-row">
        <InputText
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Titel suchen"
        />
        <Button label="OMDb Suche" icon="pi pi-search" onClick={handleSearch} loading={busy} />
      </div>

      <div className="table-scroll-wrap table-scroll-medium">
        <DataTable
          value={rows}
          selectionMode="single"
          selection={selected}
          onSelectionChange={(event) => setSelected(event.value)}
          dataKey="imdbId"
          size="small"
          scrollable
          scrollHeight="22rem"
          emptyMessage="Keine Treffer"
          responsiveLayout="stack"
          breakpoint="960px"
        >
          <Column header="Titel" body={titleWithPosterBody} />
          <Column field="year" header="Jahr" style={{ width: '8rem' }} />
          <Column field="imdbId" header="IMDb" style={{ width: '10rem' }} />
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
          placeholder="IMDb-ID"
          disabled={!!selected}
        />
      </div>

      <div className="dialog-actions">
        <Button label="Abbrechen" severity="secondary" text onClick={onHide} />
        <Button
          label="Auswahl übernehmen"
          icon="pi pi-play"
          onClick={handleSubmit}
          loading={busy}
          disabled={!selected && !manualTitle.trim() && !manualImdb.trim()}
        />
      </div>
    </Dialog>
  );
}
