import { useEffect, useMemo, useRef, useState } from 'react';
import { Card } from 'primereact/card';
import { DataView, DataViewLayoutOptions } from 'primereact/dataview';
import { InputText } from 'primereact/inputtext';
import { Dropdown } from 'primereact/dropdown';
import { Button } from 'primereact/button';
import { Tag } from 'primereact/tag';
import { Toast } from 'primereact/toast';
import { api } from '../api/client';
import JobDetailDialog from '../components/JobDetailDialog';
import blurayIndicatorIcon from '../assets/media-bluray.svg';
import discIndicatorIcon from '../assets/media-disc.svg';
import otherIndicatorIcon from '../assets/media-other.svg';
import {
  getStatusLabel,
  getStatusSeverity,
  normalizeStatus,
  STATUS_FILTER_OPTIONS
} from '../utils/statusPresentation';

const MEDIA_FILTER_OPTIONS = [
  { label: 'Alle Medien', value: '' },
  { label: 'Blu-ray', value: 'bluray' },
  { label: 'DVD', value: 'dvd' },
  { label: 'Sonstiges', value: 'other' }
];

const BASE_SORT_FIELD_OPTIONS = [
  { label: 'Startzeit', value: 'start_time' },
  { label: 'Endzeit', value: 'end_time' },
  { label: 'Titel', value: 'title' },
  { label: 'Medium', value: 'mediaType' }
];

const OPTIONAL_SORT_FIELD_OPTIONS = [
  { label: 'Keine', value: '' },
  ...BASE_SORT_FIELD_OPTIONS
];

const SORT_DIRECTION_OPTIONS = [
  { label: 'Aufsteigend', value: 1 },
  { label: 'Absteigend', value: -1 }
];

const MEDIA_SORT_RANK = {
  bluray: 0,
  dvd: 1,
  other: 2
};

function resolveMediaType(row) {
  const raw = String(row?.mediaType || row?.media_type || '').trim().toLowerCase();
  if (raw === 'bluray') {
    return 'bluray';
  }
  if (raw === 'dvd' || raw === 'disc') {
    return 'dvd';
  }
  return 'other';
}

function resolveMediaTypeMeta(row) {
  const mediaType = resolveMediaType(row);
  if (mediaType === 'bluray') {
    return {
      mediaType,
      icon: blurayIndicatorIcon,
      label: 'Blu-ray',
      alt: 'Blu-ray'
    };
  }
  if (mediaType === 'dvd') {
    return {
      mediaType,
      icon: discIndicatorIcon,
      label: 'DVD',
      alt: 'DVD'
    };
  }
  return {
    mediaType,
    icon: otherIndicatorIcon,
    label: 'Sonstiges',
    alt: 'Sonstiges Medium'
  };
}

function normalizeJobId(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return Math.trunc(parsed);
}

function getQueueActionResult(response) {
  return response?.result && typeof response.result === 'object' ? response.result : {};
}

function normalizeSortText(value) {
  return String(value || '').trim().toLocaleLowerCase('de-DE');
}

function normalizeSortDate(value) {
  if (!value) {
    return null;
  }
  const ts = new Date(value).getTime();
  return Number.isFinite(ts) ? ts : null;
}

function compareSortValues(a, b) {
  const aMissing = a === null || a === undefined || a === '';
  const bMissing = b === null || b === undefined || b === '';
  if (aMissing && bMissing) {
    return 0;
  }
  if (aMissing) {
    return 1;
  }
  if (bMissing) {
    return -1;
  }

  if (typeof a === 'number' && typeof b === 'number') {
    if (a === b) {
      return 0;
    }
    return a > b ? 1 : -1;
  }

  return String(a).localeCompare(String(b), 'de', {
    sensitivity: 'base',
    numeric: true
  });
}

function resolveSortValue(row, field) {
  switch (field) {
    case 'start_time':
      return normalizeSortDate(row?.start_time);
    case 'end_time':
      return normalizeSortDate(row?.end_time);
    case 'title':
      return normalizeSortText(row?.title || row?.detected_title || '');
    case 'mediaType': {
      const mediaType = resolveMediaType(row);
      return MEDIA_SORT_RANK[mediaType] ?? MEDIA_SORT_RANK.other;
    }
    default:
      return null;
  }
}

function sanitizeRating(value) {
  const raw = String(value || '').trim();
  if (!raw || raw.toUpperCase() === 'N/A') {
    return null;
  }
  return raw;
}

function findOmdbRatingBySource(omdbInfo, sourceName) {
  const ratings = Array.isArray(omdbInfo?.Ratings) ? omdbInfo.Ratings : [];
  const source = String(sourceName || '').trim().toLowerCase();
  const entry = ratings.find((item) => String(item?.Source || '').trim().toLowerCase() === source);
  return sanitizeRating(entry?.Value);
}

function resolveRatings(row) {
  const omdbInfo = row?.omdbInfo && typeof row.omdbInfo === 'object' ? row.omdbInfo : null;
  if (!omdbInfo) {
    return [];
  }

  const imdb = sanitizeRating(omdbInfo?.imdbRating)
    || findOmdbRatingBySource(omdbInfo, 'Internet Movie Database');
  const rotten = findOmdbRatingBySource(omdbInfo, 'Rotten Tomatoes');
  const metascore = sanitizeRating(omdbInfo?.Metascore);

  const ratings = [];
  if (imdb) {
    ratings.push({ key: 'imdb', label: 'IMDb', value: imdb });
  }
  if (rotten) {
    ratings.push({ key: 'rt', label: 'RT', value: rotten });
  }
  if (metascore) {
    ratings.push({ key: 'meta', label: 'Meta', value: metascore });
  }
  return ratings;
}

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

export default function HistoryPage() {
  const [jobs, setJobs] = useState([]);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [mediumFilter, setMediumFilter] = useState('');
  const [layout, setLayout] = useState('list');
  const [sortPrimaryField, setSortPrimaryField] = useState('start_time');
  const [sortPrimaryOrder, setSortPrimaryOrder] = useState(-1);
  const [sortSecondaryField, setSortSecondaryField] = useState('title');
  const [sortSecondaryOrder, setSortSecondaryOrder] = useState(1);
  const [sortTertiaryField, setSortTertiaryField] = useState('mediaType');
  const [sortTertiaryOrder, setSortTertiaryOrder] = useState(1);
  const [selectedJob, setSelectedJob] = useState(null);
  const [detailVisible, setDetailVisible] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [logLoadingMode, setLogLoadingMode] = useState(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [reencodeBusyJobId, setReencodeBusyJobId] = useState(null);
  const [loading, setLoading] = useState(false);
  const [queuedJobIds, setQueuedJobIds] = useState([]);
  const toastRef = useRef(null);

  const queuedJobIdSet = useMemo(() => {
    const next = new Set();
    for (const value of Array.isArray(queuedJobIds) ? queuedJobIds : []) {
      const id = normalizeJobId(value);
      if (id) {
        next.add(id);
      }
    }
    return next;
  }, [queuedJobIds]);

  const sortDescriptors = useMemo(() => {
    const seen = new Set();
    const rawDescriptors = [
      { field: String(sortPrimaryField || '').trim(), order: Number(sortPrimaryOrder || -1) >= 0 ? 1 : -1 },
      { field: String(sortSecondaryField || '').trim(), order: Number(sortSecondaryOrder || -1) >= 0 ? 1 : -1 },
      { field: String(sortTertiaryField || '').trim(), order: Number(sortTertiaryOrder || -1) >= 0 ? 1 : -1 }
    ];

    const descriptors = [];
    for (const descriptor of rawDescriptors) {
      if (!descriptor.field || seen.has(descriptor.field)) {
        continue;
      }
      seen.add(descriptor.field);
      descriptors.push(descriptor);
    }
    return descriptors;
  }, [sortPrimaryField, sortPrimaryOrder, sortSecondaryField, sortSecondaryOrder, sortTertiaryField, sortTertiaryOrder]);

  const visibleJobs = useMemo(() => {
    const filtered = mediumFilter
      ? jobs.filter((job) => resolveMediaType(job) === mediumFilter)
      : [...jobs];

    if (sortDescriptors.length === 0) {
      return filtered;
    }

    filtered.sort((a, b) => {
      for (const descriptor of sortDescriptors) {
        const valueA = resolveSortValue(a, descriptor.field);
        const valueB = resolveSortValue(b, descriptor.field);
        const compared = compareSortValues(valueA, valueB);
        if (compared !== 0) {
          return compared * descriptor.order;
        }
      }

      const idA = Number(a?.id || 0);
      const idB = Number(b?.id || 0);
      return idB - idA;
    });

    return filtered;
  }, [jobs, mediumFilter, sortDescriptors]);

  const load = async () => {
    setLoading(true);
    try {
      const [jobsResponse, queueResponse] = await Promise.allSettled([
        api.getJobs({ search, status }),
        api.getPipelineQueue()
      ]);
      if (jobsResponse.status === 'fulfilled') {
        setJobs(jobsResponse.value.jobs || []);
      } else {
        setJobs([]);
      }
      if (queueResponse.status === 'fulfilled') {
        const queuedRows = Array.isArray(queueResponse.value?.queue?.queuedJobs) ? queueResponse.value.queue.queuedJobs : [];
        const queuedIds = queuedRows
          .map((item) => normalizeJobId(item?.jobId))
          .filter(Boolean);
        setQueuedJobIds(queuedIds);
      } else {
        setQueuedJobIds([]);
      }
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

  const refreshDetailIfOpen = async (jobId) => {
    if (!detailVisible || Number(selectedJob?.id || 0) !== Number(jobId || 0)) {
      return;
    }
    const response = await api.getJob(jobId, { includeLogs: false });
    setSelectedJob(response.job);
  };

  const handleDeleteFiles = async (row, target) => {
    const label = target === 'raw' ? 'RAW-Dateien' : target === 'movie' ? 'Movie-Datei(en)' : 'RAW + Movie';
    const title = row.title || row.detected_title || `Job #${row.id}`;
    const confirmed = window.confirm(`${label} für "${title}" wirklich löschen?`);
    if (!confirmed) {
      return;
    }

    setActionBusy(true);
    try {
      const response = await api.deleteJobFiles(row.id, target);
      const summary = response.summary || {};
      toastRef.current?.show({
        severity: 'success',
        summary: 'Dateien gelöscht',
        detail: `RAW: ${summary.raw?.filesDeleted ?? 0}, MOVIE: ${summary.movie?.filesDeleted ?? 0}`,
        life: 3500
      });
      await load();
      await refreshDetailIfOpen(row.id);
    } catch (error) {
      toastRef.current?.show({ severity: 'error', summary: 'Löschen fehlgeschlagen', detail: error.message, life: 4500 });
    } finally {
      setActionBusy(false);
    }
  };

  const handleReencode = async (row) => {
    const title = row.title || row.detected_title || `Job #${row.id}`;
    const confirmed = window.confirm(`RAW neu encodieren für "${title}" starten?`);
    if (!confirmed) {
      return;
    }

    setReencodeBusyJobId(row.id);
    try {
      await api.reencodeJob(row.id);
      toastRef.current?.show({
        severity: 'success',
        summary: 'Re-Encode gestartet',
        detail: 'Job wurde in die Mediainfo-Prüfung gesetzt.',
        life: 3500
      });
      await load();
      await refreshDetailIfOpen(row.id);
    } catch (error) {
      toastRef.current?.show({ severity: 'error', summary: 'Re-Encode fehlgeschlagen', detail: error.message, life: 4500 });
    } finally {
      setReencodeBusyJobId(null);
    }
  };

  const handleRestartEncode = async (row) => {
    const title = row.title || row.detected_title || `Job #${row.id}`;
    if (row?.encodeSuccess) {
      const confirmed = window.confirm(
        `Encode für "${title}" ist bereits erfolgreich abgeschlossen. Wirklich erneut encodieren?\n`
        + 'Es wird eine neue Datei mit Kollisionsprüfung angelegt.'
      );
      if (!confirmed) {
        return;
      }
    }

    setActionBusy(true);
    try {
      const response = await api.restartEncodeWithLastSettings(row.id);
      const result = getQueueActionResult(response);
      if (result.queued) {
        const queuePosition = Number(result?.queuePosition || 0);
        toastRef.current?.show({
          severity: 'info',
          summary: 'Encode-Neustart in Queue',
          detail: queuePosition > 0
            ? `Job wurde auf Position ${queuePosition} eingeplant.`
            : 'Job wurde in die Warteschlange eingeplant.',
          life: 3500
        });
      } else {
        toastRef.current?.show({
          severity: 'success',
          summary: 'Encode-Neustart gestartet',
          detail: 'Letzte bestätigte Einstellungen werden verwendet.',
          life: 3500
        });
      }
      await load();
      await refreshDetailIfOpen(row.id);
    } catch (error) {
      toastRef.current?.show({ severity: 'error', summary: 'Encode-Neustart fehlgeschlagen', detail: error.message, life: 4500 });
    } finally {
      setActionBusy(false);
    }
  };

  const handleRemoveFromQueue = async (row) => {
    const jobId = normalizeJobId(row?.id || row);
    if (!jobId) {
      return;
    }

    setActionBusy(true);
    try {
      await api.cancelPipeline(jobId);
      toastRef.current?.show({
        severity: 'success',
        summary: 'Aus Queue entfernt',
        detail: `Job #${jobId} wurde aus der Warteschlange entfernt.`,
        life: 3200
      });
      await load();
      await refreshDetailIfOpen(jobId);
    } catch (error) {
      toastRef.current?.show({
        severity: 'error',
        summary: 'Queue-Entfernung fehlgeschlagen',
        detail: error.message,
        life: 4500
      });
    } finally {
      setActionBusy(false);
    }
  };

  const renderStatusTag = (row) => {
    const normalizedStatus = normalizeStatus(row?.status);
    const rowId = normalizeJobId(row?.id);
    const isQueued = Boolean(rowId && queuedJobIdSet.has(rowId));
    return (
      <Tag
        value={getStatusLabel(row?.status, { queued: isQueued })}
        severity={getStatusSeverity(normalizedStatus, { queued: isQueued })}
      />
    );
  };

  const renderPoster = (row, className = 'history-dv-poster') => {
    const title = row?.title || row?.detected_title || 'Poster';
    if (row?.poster_url && row.poster_url !== 'N/A') {
      return <img src={row.poster_url} alt={title} className={className} loading="lazy" />;
    }
    return <div className="history-dv-poster-fallback">Kein Poster</div>;
  };

  const renderPresenceChip = (label, available) => (
    <span className={`history-dv-chip ${available ? 'tone-ok' : 'tone-no'}`}>
      <i className={`pi ${available ? 'pi-check-circle' : 'pi-times-circle'}`} aria-hidden="true" />
      <span>{label}: {available ? 'Ja' : 'Nein'}</span>
    </span>
  );

  const renderRatings = (row) => {
    const ratings = resolveRatings(row);
    if (ratings.length === 0) {
      return <span className="history-dv-subtle">Keine Ratings</span>;
    }
    return ratings.map((rating) => (
      <span key={`${row?.id}-${rating.key}`} className="history-dv-rating-chip">
        <strong>{rating.label}</strong>
        <span>{rating.value}</span>
      </span>
    ));
  };

  const onItemKeyDown = (event, row) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      void openDetail(row);
    }
  };

  const renderListItem = (row) => {
    const mediaMeta = resolveMediaTypeMeta(row);
    const title = row?.title || row?.detected_title || '-';
    const imdb = row?.imdb_id || '-';

    return (
      <div
        className="history-dv-item history-dv-item-list"
        role="button"
        tabIndex={0}
        onKeyDown={(event) => onItemKeyDown(event, row)}
        onClick={() => {
          void openDetail(row);
        }}
      >
        <div className="history-dv-poster-wrap">
          {renderPoster(row)}
        </div>

        <div className="history-dv-main">
          <div className="history-dv-head">
            <div className="history-dv-title-block">
              <strong className="history-dv-title">{title}</strong>
              <small className="history-dv-subtle">
                #{row?.id || '-'} | {row?.year || '-'} | {imdb}
              </small>
            </div>
            {renderStatusTag(row)}
          </div>

          <div className="history-dv-meta-row">
            <span className="job-step-cell">
              <img src={mediaMeta.icon} alt={mediaMeta.alt} title={mediaMeta.label} className="media-indicator-icon" />
              <span>{mediaMeta.label}</span>
            </span>
            <span className="history-dv-subtle">Start: {formatDateTime(row?.start_time)}</span>
            <span className="history-dv-subtle">Ende: {formatDateTime(row?.end_time)}</span>
          </div>

          <div className="history-dv-flags-row">
            {renderPresenceChip('RAW', Boolean(row?.rawStatus?.exists))}
            {renderPresenceChip('Movie', Boolean(row?.outputStatus?.exists))}
            {renderPresenceChip('Encode', Boolean(row?.encodeSuccess))}
          </div>

          <div className="history-dv-ratings-row">
            {renderRatings(row)}
          </div>
        </div>

        <div className="history-dv-actions">
          <Button
            label="Details"
            icon="pi pi-search"
            size="small"
            onClick={(event) => {
              event.stopPropagation();
              void openDetail(row);
            }}
          />
        </div>
      </div>
    );
  };

  const renderGridItem = (row) => {
    const mediaMeta = resolveMediaTypeMeta(row);
    const title = row?.title || row?.detected_title || '-';

    return (
      <div className="history-dv-grid-cell">
        <div
          className="history-dv-item history-dv-item-grid"
          role="button"
          tabIndex={0}
          onKeyDown={(event) => onItemKeyDown(event, row)}
          onClick={() => {
            void openDetail(row);
          }}
        >
          <div className="history-dv-grid-head">
            {renderPoster(row, 'history-dv-poster-lg')}
            <div className="history-dv-grid-title-wrap">
              <strong className="history-dv-title">{title}</strong>
              <small className="history-dv-subtle">
                #{row?.id || '-'} | {row?.year || '-'} | {row?.imdb_id || '-'}
              </small>
              <span className="job-step-cell">
                <img src={mediaMeta.icon} alt={mediaMeta.alt} title={mediaMeta.label} className="media-indicator-icon" />
                <span>{mediaMeta.label}</span>
              </span>
            </div>
          </div>

          <div className="history-dv-grid-status-row">
            {renderStatusTag(row)}
          </div>

          <div className="history-dv-grid-time-row">
            <span className="history-dv-subtle">Start: {formatDateTime(row?.start_time)}</span>
            <span className="history-dv-subtle">Ende: {formatDateTime(row?.end_time)}</span>
          </div>

          <div className="history-dv-flags-row">
            {renderPresenceChip('RAW', Boolean(row?.rawStatus?.exists))}
            {renderPresenceChip('Movie', Boolean(row?.outputStatus?.exists))}
            {renderPresenceChip('Encode', Boolean(row?.encodeSuccess))}
          </div>

          <div className="history-dv-ratings-row">
            {renderRatings(row)}
          </div>

          <div className="history-dv-actions history-dv-actions-grid">
            <Button
              label="Details"
              icon="pi pi-search"
              size="small"
              onClick={(event) => {
                event.stopPropagation();
                void openDetail(row);
              }}
            />
          </div>
        </div>
      </div>
    );
  };

  const itemTemplate = (row, currentLayout) => {
    if (!row) {
      return null;
    }
    if (currentLayout === 'grid') {
      return renderGridItem(row);
    }
    return renderListItem(row);
  };

  const dataViewHeader = (
    <div>
      <div className="history-dv-toolbar">
        <InputText
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Suche nach Titel oder IMDb"
        />
        <Dropdown
          value={status}
          options={STATUS_FILTER_OPTIONS}
          optionLabel="label"
          optionValue="value"
          onChange={(event) => setStatus(event.value)}
          placeholder="Status"
        />
        <Dropdown
          value={mediumFilter}
          options={MEDIA_FILTER_OPTIONS}
          optionLabel="label"
          optionValue="value"
          onChange={(event) => setMediumFilter(event.value || '')}
          placeholder="Medium"
        />
        <Button label="Neu laden" icon="pi pi-refresh" onClick={load} loading={loading} />
        <div className="history-dv-layout-toggle">
          <DataViewLayoutOptions
            layout={layout}
            onChange={(event) => setLayout(event.value)}
          />
        </div>
      </div>

      <div className="history-dv-sortbar">
        <div className="history-dv-sort-rule">
          <strong>1.</strong>
          <Dropdown
            value={sortPrimaryField}
            options={BASE_SORT_FIELD_OPTIONS}
            optionLabel="label"
            optionValue="value"
            onChange={(event) => setSortPrimaryField(event.value || 'start_time')}
            placeholder="Primär"
          />
          <Dropdown
            value={sortPrimaryOrder}
            options={SORT_DIRECTION_OPTIONS}
            optionLabel="label"
            optionValue="value"
            onChange={(event) => setSortPrimaryOrder(Number(event.value || -1) >= 0 ? 1 : -1)}
            placeholder="Richtung"
          />
        </div>

        <div className="history-dv-sort-rule">
          <strong>2.</strong>
          <Dropdown
            value={sortSecondaryField}
            options={OPTIONAL_SORT_FIELD_OPTIONS}
            optionLabel="label"
            optionValue="value"
            onChange={(event) => setSortSecondaryField(event.value || '')}
            placeholder="Sekundär"
          />
          <Dropdown
            value={sortSecondaryOrder}
            options={SORT_DIRECTION_OPTIONS}
            optionLabel="label"
            optionValue="value"
            onChange={(event) => setSortSecondaryOrder(Number(event.value || -1) >= 0 ? 1 : -1)}
            placeholder="Richtung"
            disabled={!sortSecondaryField}
          />
        </div>

        <div className="history-dv-sort-rule">
          <strong>3.</strong>
          <Dropdown
            value={sortTertiaryField}
            options={OPTIONAL_SORT_FIELD_OPTIONS}
            optionLabel="label"
            optionValue="value"
            onChange={(event) => setSortTertiaryField(event.value || '')}
            placeholder="Tertiär"
          />
          <Dropdown
            value={sortTertiaryOrder}
            options={SORT_DIRECTION_OPTIONS}
            optionLabel="label"
            optionValue="value"
            onChange={(event) => setSortTertiaryOrder(Number(event.value || -1) >= 0 ? 1 : -1)}
            placeholder="Richtung"
            disabled={!sortTertiaryField}
          />
        </div>
      </div>
    </div>
  );

  return (
    <div className="page-grid">
      <Toast ref={toastRef} />

      <Card title="Historie" subTitle="DataView mit Poster, Status, Dateiverfügbarkeit, Encode-Status und Ratings">
        <DataView
          value={visibleJobs}
          layout={layout}
          itemTemplate={itemTemplate}
          paginator
          rows={12}
          rowsPerPageOptions={[12, 24, 48]}
          header={dataViewHeader}
          loading={loading}
          emptyMessage="Keine Einträge"
          className="history-dataview"
        />
      </Card>

      <JobDetailDialog
        visible={detailVisible}
        job={selectedJob}
        detailLoading={detailLoading}
        onLoadLog={handleLoadLog}
        logLoadingMode={logLoadingMode}
        onRestartEncode={handleRestartEncode}
        onReencode={handleReencode}
        onDeleteFiles={handleDeleteFiles}
        onRemoveFromQueue={handleRemoveFromQueue}
        isQueued={Boolean(selectedJob?.id && queuedJobIdSet.has(normalizeJobId(selectedJob.id)))}
        actionBusy={actionBusy}
        reencodeBusy={reencodeBusyJobId === selectedJob?.id}
        onHide={() => {
          setDetailVisible(false);
          setDetailLoading(false);
          setLogLoadingMode(null);
        }}
      />
    </div>
  );
}
