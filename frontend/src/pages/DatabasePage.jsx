import { useEffect, useRef, useState } from 'react';
import { Card } from 'primereact/card';
import { DataTable } from 'primereact/datatable';
import { Column } from 'primereact/column';
import { Tag } from 'primereact/tag';
import { Button } from 'primereact/button';
import { Toast } from 'primereact/toast';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { confirmModal } from '../utils/confirmModal';

function formatDetectedMediaType(value) {
  const mediaType = String(value || '').trim().toLowerCase();
  if (mediaType === 'bluray') {
    return 'Blu-ray';
  }
  if (mediaType === 'dvd') {
    return 'DVD';
  }
  if (mediaType === 'cd') {
    return 'CD';
  }
  if (mediaType === 'audiobook') {
    return 'Audiobook';
  }
  return 'Sonstiges';
}

export default function DatabasePage() {
  const navigate = useNavigate();
  const [orphanRows, setOrphanRows] = useState([]);
  const [orphanLoading, setOrphanLoading] = useState(false);
  const [orphanImportBusyPath, setOrphanImportBusyPath] = useState(null);
  const [orphanDeleteBusyPath, setOrphanDeleteBusyPath] = useState(null);
  const toastRef = useRef(null);
  const orphanLoadRequestRef = useRef(0);

  const loadOrphans = async (options = {}) => {
    const requestId = orphanLoadRequestRef.current + 1;
    orphanLoadRequestRef.current = requestId;
    const silent = Boolean(options?.silent);
    if (!silent) {
      setOrphanLoading(true);
    }
    try {
      const response = await api.getOrphanRawFolders();
      if (orphanLoadRequestRef.current !== requestId) {
        return;
      }
      setOrphanRows(Array.isArray(response?.rows) ? response.rows : []);
    } catch (error) {
      if (orphanLoadRequestRef.current !== requestId) {
        return;
      }
      toastRef.current?.show({ severity: 'error', summary: 'RAW-Prüfung fehlgeschlagen', detail: error.message });
    } finally {
      if (orphanLoadRequestRef.current === requestId && !silent) {
        setOrphanLoading(false);
      }
    }
  };

  useEffect(() => {
    void loadOrphans();
  }, []);

  const handleImportOrphanRaw = async (row) => {
    const target = row?.rawPath || row?.folderName || '-';
    const confirmed = await confirmModal({
      header: 'Historienjob anlegen',
      message: `Für RAW-Ordner "${target}" einen neuen Historienjob anlegen?`,
      acceptLabel: 'Job anlegen',
      rejectLabel: 'Abbrechen'
    });
    if (!confirmed) {
      return;
    }

    setOrphanImportBusyPath(row.rawPath);
    try {
      const response = await api.importOrphanRawFolder(row.rawPath);
      const newJobId = response?.job?.id;
      const activationStarted = Boolean(response?.activation?.started);
      const activationError = String(response?.activationError || '').trim();
      const importedRawPath = String(row?.rawPath || '').trim();
      if (importedRawPath) {
        // Immediate UX feedback: imported orphan should disappear without a full page reload.
        setOrphanRows((previousRows) => (
          (Array.isArray(previousRows) ? previousRows : []).filter((entry) => String(entry?.rawPath || '').trim() !== importedRawPath)
        ));
      }
      toastRef.current?.show({
        severity: 'success',
        summary: activationStarted ? 'Analyse gestartet' : 'Job angelegt',
        detail: activationStarted
          ? (newJobId
            ? `Job #${newJobId} läuft jetzt im Ripper-View.`
            : 'Job läuft jetzt im Ripper-View.')
          : (newJobId ? `Historieneintrag #${newJobId} erstellt.` : 'Historieneintrag wurde erstellt.'),
        life: 3500
      });
      if (activationError) {
        toastRef.current?.show({
          severity: 'warn',
          summary: 'Analyse-Start fehlgeschlagen',
          detail: activationError,
          life: 5200
        });
      }

      // Some workflows update job linkage milliseconds later (e.g. follow-up analyze start).
      // Recheck a few times in background to converge UI without manual refresh.
      const refreshDelaysMs = [0, 600, 1800];
      for (const delayMs of refreshDelaysMs) {
        if (delayMs > 0) {
          await new Promise((resolve) => window.setTimeout(resolve, delayMs));
        }
        await loadOrphans({ silent: true });
      }

      // Jump to the Ripper view immediately after creating a job from /database.
      navigate('/ripper');
    } catch (error) {
      toastRef.current?.show({
        severity: 'error',
        summary: 'Import fehlgeschlagen',
        detail: error.message,
        life: 4500
      });
    } finally {
      setOrphanImportBusyPath(null);
    }
  };
  const handleDeleteOrphanRaw = async (row) => {
    const target = String(row?.rawPath || row?.folderName || '-').trim() || '-';
    const confirmed = await confirmModal({
      header: 'RAW löschen',
      message:
        `RAW-Ordner "${target}" wirklich löschen?\n` +
        'Der Ordner wird dauerhaft aus dem Dateisystem entfernt und verschwindet aus der /database-Liste.',
      acceptLabel: 'RAW löschen',
      rejectLabel: 'Abbrechen',
      danger: true
    });
    if (!confirmed) {
      return;
    }

    setOrphanDeleteBusyPath(row.rawPath);
    try {
      const response = await api.deleteOrphanRawFolder(row.rawPath);
      const deletedRawPath = String(response?.rawPath || row?.rawPath || '').trim();
      const deletedFiles = Number(response?.filesDeleted || 0);
      const deletedDirs = Number(response?.dirsRemoved || 0);
      if (deletedRawPath) {
        setOrphanRows((previousRows) => (
          (Array.isArray(previousRows) ? previousRows : []).filter((entry) => String(entry?.rawPath || '').trim() !== deletedRawPath)
        ));
      }
      toastRef.current?.show({
        severity: 'success',
        summary: 'RAW gelöscht',
        detail: `Ordner entfernt | Dateien: ${deletedFiles}, Ordner: ${deletedDirs}`,
        life: 3500
      });
      await loadOrphans({ silent: true });
    } catch (error) {
      toastRef.current?.show({
        severity: 'error',
        summary: 'Löschen fehlgeschlagen',
        detail: error.message,
        life: 4500
      });
    } finally {
      setOrphanDeleteBusyPath(null);
    }
  };
  const orphanTitleBody = (row) => (
    <div>
      <div><strong>{row.title || '-'}</strong></div>
      <small>{row.year || '-'} | {row.imdbId || '-'}</small>
    </div>
  );
  const orphanMediaBody = (row) => (
    <Tag value={formatDetectedMediaType(row?.detectedMediaType)} />
  );
  const orphanPathBody = (row) => (
    <div className="orphan-path-cell">
      {row.rawPath}
    </div>
  );
  const orphanActionBody = (row) => (
    <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
      <Button
        label="Job anlegen"
        icon="pi pi-plus"
        size="small"
        onClick={() => handleImportOrphanRaw(row)}
        loading={orphanImportBusyPath === row.rawPath}
        disabled={Boolean(orphanImportBusyPath) || Boolean(orphanDeleteBusyPath)}
      />
      <Button
        label="RAW löschen"
        icon="pi pi-trash"
        severity="danger"
        outlined
        size="small"
        onClick={() => handleDeleteOrphanRaw(row)}
        loading={orphanDeleteBusyPath === row.rawPath}
        disabled={Boolean(orphanImportBusyPath) || Boolean(orphanDeleteBusyPath)}
      />
    </div>
  );

  return (
    <div className="page-grid">
      <Toast ref={toastRef} />

      <Card
        title="Gefundene RAW-Einträge"
        subTitle="Es werden RAW-Ordner ohne zugehörigen Historienjob aus Settings- und Default-RAW-Pfaden angezeigt."
      >
        <div className="table-filters">
          <Button
            label="RAW prüfen"
            icon="pi pi-search"
            onClick={loadOrphans}
            loading={orphanLoading}
            disabled={Boolean(orphanImportBusyPath) || Boolean(orphanDeleteBusyPath)}
          />
          <Tag value={`${orphanRows.length} gefunden`} severity={orphanRows.length > 0 ? 'warning' : 'success'} />
        </div>

        <div className="table-scroll-wrap table-scroll-wide">
          <DataTable
            value={orphanRows}
            dataKey="rawPath"
            paginator
            rows={10}
            loading={orphanLoading}
            emptyMessage="Keine verwaisten RAW-Ordner gefunden"
            responsiveLayout="scroll"
          >
            <Column field="folderName" header="RAW-Ordner" style={{ minWidth: '18rem' }} />
            <Column header="Medium" body={orphanMediaBody} style={{ width: '10rem' }} />
            <Column header="Titel" body={orphanTitleBody} style={{ minWidth: '14rem' }} />
            <Column field="entryCount" header="Dateien" style={{ width: '8rem' }} />
            <Column header="Pfad" body={orphanPathBody} style={{ minWidth: '22rem' }} />
            <Column field="lastModifiedAt" header="Geändert" style={{ width: '16rem' }} />
            <Column header="Aktion" body={orphanActionBody} style={{ minWidth: '18rem' }} />
          </DataTable>
        </div>
      </Card>
    </div>
  );
}
