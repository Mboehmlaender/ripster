import { useEffect, useMemo, useRef, useState } from 'react';
import { Card } from 'primereact/card';
import { DataTable } from 'primereact/datatable';
import { Column } from 'primereact/column';
import { InputText } from 'primereact/inputtext';
import { Dropdown } from 'primereact/dropdown';
import { Button } from 'primereact/button';
import { Tag } from 'primereact/tag';
import { Toast } from 'primereact/toast';
import { api } from '../api/client';

const STATUS_OPTIONS = [
  { label: 'Alle Stati', value: '' },
  { label: 'Wartend', value: 'queued' },
  { label: 'Laufend', value: 'processing' },
  { label: 'Bereit', value: 'ready' },
  { label: 'Fehlgeschlagen', value: 'failed' }
];

function formatDateTime(value) {
  if (!value) {
    return '-';
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return String(value);
  }
  return date.toLocaleString('de-DE', {
    dateStyle: 'short',
    timeStyle: 'short'
  });
}

function formatBytes(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return '-';
  }
  if (parsed === 0) {
    return '0 B';
  }
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let unitIndex = 0;
  let current = parsed;
  while (current >= 1024 && unitIndex < units.length - 1) {
    current /= 1024;
    unitIndex += 1;
  }
  const digits = unitIndex === 0 ? 0 : 2;
  return `${current.toFixed(digits)} ${units[unitIndex]}`;
}

function normalizeSearchText(value) {
  return String(value || '').trim().toLocaleLowerCase('de-DE');
}

function getStatusMeta(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'queued') {
    return { label: 'Wartend', severity: 'warning' };
  }
  if (normalized === 'processing') {
    return { label: 'Laeuft', severity: 'info' };
  }
  if (normalized === 'ready') {
    return { label: 'Bereit', severity: 'success' };
  }
  return { label: 'Fehlgeschlagen', severity: 'danger' };
}

export default function DownloadsPage({ refreshToken = 0 }) {
  const [items, setItems] = useState([]);
  const [summary, setSummary] = useState(null);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [loading, setLoading] = useState(false);
  const [downloadBusyId, setDownloadBusyId] = useState(null);
  const [deleteBusyId, setDeleteBusyId] = useState(null);
  const toastRef = useRef(null);

  const hasActiveItems = useMemo(
    () => items.some((item) => ['queued', 'processing'].includes(String(item?.status || '').trim().toLowerCase())),
    [items]
  );

  const visibleItems = useMemo(() => {
    const searchText = normalizeSearchText(search);
    return items.filter((item) => {
      const matchesStatus = !statusFilter || String(item?.status || '').trim().toLowerCase() === statusFilter;
      if (!matchesStatus) {
        return false;
      }
      if (!searchText) {
        return true;
      }
      const haystack = [
        item?.displayTitle,
        item?.archiveName,
        item?.label,
        item?.sourcePath,
        item?.jobId ? `job ${item.jobId}` : ''
      ]
        .map((value) => normalizeSearchText(value))
        .join(' ');
      return haystack.includes(searchText);
    });
  }, [items, search, statusFilter]);

  const load = async () => {
    setLoading(true);
    try {
      const response = await api.getDownloads();
      setItems(Array.isArray(response?.items) ? response.items : []);
      setSummary(response?.summary && typeof response.summary === 'object' ? response.summary : null);
    } catch (error) {
      toastRef.current?.show({
        severity: 'error',
        summary: 'Downloads konnten nicht geladen werden',
        detail: error.message,
        life: 4500
      });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, [refreshToken]);

  useEffect(() => {
    if (!hasActiveItems) {
      return undefined;
    }
    const timer = setInterval(() => {
      void load();
    }, 3000);
    return () => clearInterval(timer);
  }, [hasActiveItems]);

  const handleDownload = async (row) => {
    const id = String(row?.id || '').trim();
    if (!id) {
      return;
    }
    setDownloadBusyId(id);
    try {
      await api.downloadPreparedArchive(id);
    } catch (error) {
      toastRef.current?.show({
        severity: 'error',
        summary: 'ZIP-Download fehlgeschlagen',
        detail: error.message,
        life: 4500
      });
    } finally {
      setDownloadBusyId(null);
    }
  };

  const handleDelete = async (row) => {
    const id = String(row?.id || '').trim();
    if (!id) {
      return;
    }
    const label = row?.archiveName || `ZIP ${id}`;
    const confirmed = window.confirm(`"${label}" wirklich loeschen?`);
    if (!confirmed) {
      return;
    }

    setDeleteBusyId(id);
    try {
      await api.deleteDownload(id);
      toastRef.current?.show({
        severity: 'success',
        summary: 'ZIP geloescht',
        detail: `"${label}" wurde entfernt.`,
        life: 3500
      });
      await load();
    } catch (error) {
      toastRef.current?.show({
        severity: 'error',
        summary: 'Loeschen fehlgeschlagen',
        detail: error.message,
        life: 4500
      });
    } finally {
      setDeleteBusyId(null);
    }
  };

  const statusBody = (row) => {
    const meta = getStatusMeta(row?.status);
    return <Tag value={meta.label} severity={meta.severity} />;
  };

  const titleBody = (row) => (
    <div className="downloads-title-cell">
      <strong>{row?.displayTitle || '-'}</strong>
      <small>
        {row?.jobId ? `Job #${row.jobId}` : 'Ohne Job'} | {row?.label || '-'}
      </small>
      {row?.errorMessage ? <small className="downloads-error-text">{row.errorMessage}</small> : null}
    </div>
  );

  const archiveBody = (row) => (
    <div className="downloads-path-cell">
      <code>{row?.archiveName || '-'}</code>
      <small>{row?.downloadDir || '-'}</small>
    </div>
  );

  const sourceBody = (row) => (
    <div className="downloads-path-cell">
      <code>{row?.sourcePath || '-'}</code>
      <small>{row?.sourceType === 'file' ? 'Datei' : 'Ordner'}</small>
    </div>
  );

  const actionBody = (row) => {
    const normalizedStatus = String(row?.status || '').trim().toLowerCase();
    const canDownload = normalizedStatus === 'ready';
    const canDelete = !['queued', 'processing'].includes(normalizedStatus);
    const id = String(row?.id || '').trim();

    return (
      <div className="downloads-actions">
        <Button
          label="Download"
          icon="pi pi-download"
          size="small"
          onClick={() => handleDownload(row)}
          disabled={!canDownload || Boolean(deleteBusyId)}
          loading={downloadBusyId === id}
        />
        <Button
          label="Loeschen"
          icon="pi pi-trash"
          severity="danger"
          outlined
          size="small"
          onClick={() => handleDelete(row)}
          disabled={!canDelete || Boolean(downloadBusyId)}
          loading={deleteBusyId === id}
        />
      </div>
    );
  };

  return (
    <div className="page-grid">
      <Toast ref={toastRef} />

      <Card title="Downloadbare Dateien" subTitle="Vorbereitete ZIP-Dateien aus RAW- und Encode-Inhalten">
        <div className="table-filters">
          <InputText
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Suche nach Titel, ZIP-Datei oder Pfad"
          />
          <Dropdown
            value={statusFilter}
            options={STATUS_OPTIONS}
            optionLabel="label"
            optionValue="value"
            onChange={(event) => setStatusFilter(event.value || '')}
            placeholder="Status"
          />
          <Button label="Neu laden" icon="pi pi-refresh" onClick={load} loading={loading} />
        </div>

        <div className="downloads-summary-tags">
          <Tag value={`${summary?.activeCount || 0} aktiv`} severity={(summary?.activeCount || 0) > 0 ? 'info' : 'secondary'} />
          <Tag value={`${summary?.readyCount || 0} bereit`} severity={(summary?.readyCount || 0) > 0 ? 'success' : 'secondary'} />
          <Tag value={`${summary?.failedCount || 0} Fehler`} severity={(summary?.failedCount || 0) > 0 ? 'danger' : 'secondary'} />
        </div>

        <div className="table-scroll-wrap table-scroll-wide">
          <DataTable
            value={visibleItems}
            dataKey="id"
            paginator
            rows={10}
            rowsPerPageOptions={[10, 20, 50]}
            loading={loading}
            responsiveLayout="scroll"
            emptyMessage="Keine ZIP-Dateien vorhanden"
          >
            <Column header="Status" body={statusBody} style={{ width: '10rem' }} />
            <Column header="Inhalt" body={titleBody} style={{ minWidth: '18rem' }} />
            <Column header="ZIP-Datei" body={archiveBody} style={{ minWidth: '18rem' }} />
            <Column header="Quelle" body={sourceBody} style={{ minWidth: '22rem' }} />
            <Column header="Erstellt" body={(row) => formatDateTime(row?.createdAt)} style={{ width: '11rem' }} />
            <Column header="Fertig" body={(row) => formatDateTime(row?.finishedAt)} style={{ width: '11rem' }} />
            <Column header="Groesse" body={(row) => formatBytes(row?.sizeBytes)} style={{ width: '9rem' }} />
            <Column header="Aktion" body={actionBody} style={{ width: '14rem' }} />
          </DataTable>
        </div>
      </Card>
    </div>
  );
}
