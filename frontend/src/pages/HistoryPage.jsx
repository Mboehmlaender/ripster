import { useEffect, useRef, useState } from 'react';
import { Card } from 'primereact/card';
import { DataTable } from 'primereact/datatable';
import { Column } from 'primereact/column';
import { InputText } from 'primereact/inputtext';
import { Dropdown } from 'primereact/dropdown';
import { Button } from 'primereact/button';
import { Tag } from 'primereact/tag';
import { Toast } from 'primereact/toast';
import { api } from '../api/client';
import JobDetailDialog from '../components/JobDetailDialog';
import blurayIndicatorIcon from '../assets/media-bluray.svg';
import discIndicatorIcon from '../assets/media-disc.svg';

const statusOptions = [
  { label: 'Alle', value: '' },
  { label: 'FINISHED', value: 'FINISHED' },
  { label: 'ERROR', value: 'ERROR' },
  { label: 'WAITING_FOR_USER_DECISION', value: 'WAITING_FOR_USER_DECISION' },
  { label: 'READY_TO_START', value: 'READY_TO_START' },
  { label: 'READY_TO_ENCODE', value: 'READY_TO_ENCODE' },
  { label: 'MEDIAINFO_CHECK', value: 'MEDIAINFO_CHECK' },
  { label: 'RIPPING', value: 'RIPPING' },
  { label: 'ENCODING', value: 'ENCODING' },
  { label: 'ANALYZING', value: 'ANALYZING' },
  { label: 'METADATA_SELECTION', value: 'METADATA_SELECTION' }
];

function resolveMediaType(row) {
  const raw = String(row?.mediaType || row?.media_type || '').trim().toLowerCase();
  return raw === 'bluray' ? 'bluray' : 'disc';
}

export default function HistoryPage() {
  const [jobs, setJobs] = useState([]);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [selectedJob, setSelectedJob] = useState(null);
  const [detailVisible, setDetailVisible] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [logLoadingMode, setLogLoadingMode] = useState(null);
  const [loading, setLoading] = useState(false);
  const toastRef = useRef(null);

  const load = async () => {
    setLoading(true);
    try {
      const response = await api.getJobs({ search, status });
      setJobs(response.jobs || []);
    } catch (error) {
      toastRef.current?.show({ severity: 'error', summary: 'Fehler', detail: error.message });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    const timer = setTimeout(() => {
      load();
    }, 300);

    return () => clearTimeout(timer);
  }, [search, status]);

  const openDetail = async (row) => {
    const jobId = Number(row?.id || 0);
    if (!jobId) {
      return;
    }

    setSelectedJob({
      ...row,
      logs: [],
      log: '',
      logMeta: {
        loaded: false,
        total: Number(row?.log_count || 0),
        returned: 0,
        truncated: false
      }
    });
    setDetailVisible(true);
    setDetailLoading(true);

    try {
      const response = await api.getJob(jobId, { includeLogs: false });
      setSelectedJob(response.job);
    } catch (error) {
      toastRef.current?.show({ severity: 'error', summary: 'Fehler', detail: error.message });
    } finally {
      setDetailLoading(false);
    }
  };

  const handleLoadLog = async (job, mode = 'tail') => {
    const jobId = Number(job?.id || selectedJob?.id || 0);
    if (!jobId) {
      return;
    }

    setLogLoadingMode(mode);
    try {
      const response = await api.getJob(jobId, {
        includeLogs: true,
        includeAllLogs: mode === 'all',
        logTailLines: mode === 'all' ? null : 800
      });
      setSelectedJob(response.job);
    } catch (error) {
      toastRef.current?.show({ severity: 'error', summary: 'Log konnte nicht geladen werden', detail: error.message });
    } finally {
      setLogLoadingMode(null);
    }
  };

  const statusBody = (row) => <Tag value={row.status} />;
  const mkBody = (row) => row.makemkvInfo ? `${row.makemkvInfo.status || '-'} ${typeof row.makemkvInfo.lastProgress === 'number' ? `${row.makemkvInfo.lastProgress.toFixed(1)}%` : ''}` : '-';
  const hbBody = (row) => row.handbrakeInfo ? `${row.handbrakeInfo.status || '-'} ${typeof row.handbrakeInfo.lastProgress === 'number' ? `${row.handbrakeInfo.lastProgress.toFixed(1)}%` : ''}` : '-';
  const mediaBody = (row) => {
    const mediaType = resolveMediaType(row);
    const src = mediaType === 'bluray' ? blurayIndicatorIcon : discIndicatorIcon;
    const alt = mediaType === 'bluray' ? 'Blu-ray' : 'Disc';
    const title = mediaType === 'bluray' ? 'Blu-ray' : 'CD/sonstiges Medium';
    return <img src={src} alt={alt} title={title} className="media-indicator-icon" />;
  };
  const posterBody = (row) =>
    row.poster_url && row.poster_url !== 'N/A' ? (
      <img src={row.poster_url} alt={row.title || row.detected_title || 'Poster'} className="poster-thumb" />
    ) : (
      <span>-</span>
    );

  return (
    <div className="page-grid">
      <Toast ref={toastRef} />

      <Card title="Historie" subTitle="Alle Jobs mit Details und Logs">
        <div className="table-filters">
          <InputText
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Suche nach Titel oder IMDb"
          />
          <Dropdown
            value={status}
            options={statusOptions}
            optionLabel="label"
            optionValue="value"
            onChange={(event) => setStatus(event.value)}
            placeholder="Status"
          />
          <Button label="Neu laden" icon="pi pi-refresh" onClick={load} loading={loading} />
        </div>

        <div className="table-scroll-wrap table-scroll-wide">
          <DataTable
            value={jobs}
            dataKey="id"
            paginator
            rows={10}
            loading={loading}
            onRowClick={(event) => openDetail(event.data)}
            className="clickable-table"
            emptyMessage="Keine Einträge"
            responsiveLayout="scroll"
          >
            <Column field="id" header="#" style={{ width: '5rem' }} />
            <Column header="Medium" body={mediaBody} style={{ width: '6rem' }} />
            <Column header="Poster" body={posterBody} style={{ width: '7rem' }} />
            <Column field="title" header="Titel" body={(row) => row.title || row.detected_title || '-'} />
            <Column field="year" header="Jahr" style={{ width: '6rem' }} />
            <Column field="imdb_id" header="IMDb" style={{ width: '10rem' }} />
            <Column field="status" header="Status" body={statusBody} style={{ width: '12rem' }} />
            <Column header="MakeMKV" body={mkBody} style={{ width: '12rem' }} />
            <Column header="HandBrake" body={hbBody} style={{ width: '12rem' }} />
            <Column field="start_time" header="Start" style={{ width: '16rem' }} />
            <Column field="end_time" header="Ende" style={{ width: '16rem' }} />
            <Column field="output_path" header="Output" />
          </DataTable>
        </div>
      </Card>

      <JobDetailDialog
        visible={detailVisible}
        job={selectedJob}
        detailLoading={detailLoading}
        onLoadLog={handleLoadLog}
        logLoadingMode={logLoadingMode}
        onHide={() => {
          setDetailVisible(false);
          setDetailLoading(false);
          setLogLoadingMode(null);
        }}
      />
    </div>
  );
}
