import { useEffect, useMemo, useState } from 'react';
import 'chart.js/auto';
import { Card } from 'primereact/card';
import { Tag } from 'primereact/tag';
import { ProgressBar } from 'primereact/progressbar';
import { Chart } from 'primereact/chart';
import { Button } from 'primereact/button';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';

function clampPercent(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return 0;
  }
  return Math.max(0, Math.min(100, parsed));
}

function formatPercent(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return '-';
  }
  return `${Math.round(parsed)}%`;
}

function formatBytes(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes < 0) {
    return '-';
  }
  if (bytes === 0) {
    return '0 B';
  }
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const normalized = bytes / (1024 ** exponent);
  return `${normalized.toFixed(normalized >= 100 ? 0 : (normalized >= 10 ? 1 : 2))} ${units[exponent]}`;
}

function formatUpdatedAt(value) {
  const raw = String(value || '').trim();
  if (!raw) {
    return '-';
  }
  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed)) {
    return raw;
  }
  return new Date(parsed).toLocaleString('de-DE');
}

function normalizeHardwareMonitoringPayload(rawPayload) {
  const payload = rawPayload && typeof rawPayload === 'object' ? rawPayload : {};
  return {
    enabled: Boolean(payload.enabled),
    intervalMs: Number(payload.intervalMs || 0),
    updatedAt: payload.updatedAt || null,
    sample: payload.sample && typeof payload.sample === 'object' ? payload.sample : null,
    error: payload.error ? String(payload.error) : null
  };
}

function buildGaugeDataset(value, color) {
  const safe = clampPercent(value);
  return {
    datasets: [
      {
        data: [safe, Math.max(0, 100 - safe)],
        backgroundColor: [color, 'rgba(255,255,255,0.08)'],
        borderWidth: 0,
        hoverOffset: 0
      }
    ]
  };
}

const gaugeOptions = {
  responsive: true,
  maintainAspectRatio: false,
  cutout: '82%',
  plugins: {
    legend: {
      display: false
    },
    tooltip: {
      enabled: false
    }
  },
  animation: false
};

const HISTORY_WINDOWS = [
  { label: '1h', hours: 1 },
  { label: '6h', hours: 6 },
  { label: '24h', hours: 24 },
  { label: '4d', hours: 96 }
];
const HISTORY_STACK_BREAKPOINT = 1700;
const HISTORY_RESAMPLE_TARGET_POINTS = 720;
const HISTORY_INTERPOLATION_MIN_GAP_MS = 5 * 60 * 1000;
const HISTORY_INTERPOLATION_MAX_GAP_MS = 45 * 60 * 1000;
const HISTORY_INTERPOLATION_GAP_FACTOR = 6;

const CPU_SERIES_COLOR = '#c43d2f';
const GPU_SERIES_COLOR = '#c9961a';
const RAM_SERIES_COLOR = '#2e7d4f';

const historyChartOptions = {
  responsive: true,
  maintainAspectRatio: false,
  animation: false,
  interaction: {
    mode: 'index',
    intersect: false
  },
  plugins: {
    legend: {
      display: false
    },
    tooltip: {
      callbacks: {
        title: (items) => {
          const first = Array.isArray(items) ? items[0] : null;
          const rawLabel = first?.label ?? first?.raw?.x ?? first?.parsed?.x ?? '';
          return formatTickLabel(rawLabel);
        }
      }
    }
  },
  scales: {
    x: {
      ticks: {
        autoSkip: true,
        maxTicksLimit: 8,
        color: '#6a4d38',
        callback: function (value, index, ticks) {
          const resolvedLabel = typeof this?.getLabelForValue === 'function'
            ? this.getLabelForValue(value)
            : (
              Array.isArray(ticks) && ticks[index]
                ? (ticks[index].label ?? ticks[index].value ?? value)
                : value
            );
          return formatTickLabel(resolvedLabel);
        }
      },
      grid: {
        color: 'rgba(111,57,34,0.08)'
      }
    },
    y: {
      beginAtZero: true,
      ticks: {
        color: '#6a4d38'
      },
      grid: {
        color: 'rgba(111,57,34,0.08)'
      }
    }
  }
};

function toNumberOrNull(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatTickLabel(timestampIso) {
  const parsed = Date.parse(String(timestampIso || ''));
  if (!Number.isFinite(parsed)) {
    return '-';
  }
  const date = new Date(parsed);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function formatDayMarkerLabel(timestampIso) {
  const parsed = Date.parse(String(timestampIso || ''));
  if (!Number.isFinite(parsed)) {
    return '';
  }
  const date = new Date(parsed);
  return `${String(date.getDate()).padStart(2, '0')}.${String(date.getMonth() + 1).padStart(2, '0')}.`;
}

function toDayKeyFromTimestamp(timestampIso) {
  const parsed = Date.parse(String(timestampIso || ''));
  if (!Number.isFinite(parsed)) {
    return null;
  }
  const date = new Date(parsed);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function parseTimestampMs(value) {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeHistoryPoints(points = []) {
  return (Array.isArray(points) ? points : [])
    .map((point) => {
      const timestampMs = parseTimestampMs(point?.capturedAt);
      if (!Number.isFinite(timestampMs)) {
        return null;
      }
      return {
        capturedAt: new Date(timestampMs).toISOString(),
        timestampMs,
        cpuUsagePercent: toNumberOrNull(point?.cpuUsagePercent),
        ramUsagePercent: toNumberOrNull(point?.ramUsagePercent),
        gpuUsagePercent: toNumberOrNull(point?.gpuUsagePercent),
        cpuTemperatureC: toNumberOrNull(point?.cpuTemperatureC),
        gpuTemperatureC: toNumberOrNull(point?.gpuTemperatureC)
      };
    })
    .filter(Boolean)
    .sort((left, right) => left.timestampMs - right.timestampMs);
}

function interpolateMetric(prevPoint, nextPoint, metricKey, targetMs, maxGapMs) {
  if (!prevPoint || !nextPoint) {
    return null;
  }
  if (prevPoint.timestampMs === nextPoint.timestampMs) {
    return toNumberOrNull(prevPoint[metricKey]);
  }
  const gapMs = nextPoint.timestampMs - prevPoint.timestampMs;
  if (!Number.isFinite(gapMs) || gapMs <= 0 || gapMs > maxGapMs) {
    return null;
  }
  const prevValue = toNumberOrNull(prevPoint[metricKey]);
  const nextValue = toNumberOrNull(nextPoint[metricKey]);
  if (!Number.isFinite(prevValue) || !Number.isFinite(nextValue)) {
    return null;
  }
  const ratio = (targetMs - prevPoint.timestampMs) / gapMs;
  if (!Number.isFinite(ratio) || ratio < 0 || ratio > 1) {
    return null;
  }
  return Number((prevValue + ((nextValue - prevValue) * ratio)).toFixed(2));
}

function buildResampledHistoryPoints(points = [], historyHours = 24) {
  const normalized = normalizeHistoryPoints(points);
  if (normalized.length === 0) {
    return [];
  }

  const historyWindowMs = Math.max(1, Number(historyHours || 24)) * 60 * 60 * 1000;
  const stepMsRaw = Math.round(historyWindowMs / HISTORY_RESAMPLE_TARGET_POINTS);
  const stepMs = Math.max(60 * 1000, stepMsRaw);
  const maxInterpolationGapMs = Math.max(
    HISTORY_INTERPOLATION_MIN_GAP_MS,
    Math.min(HISTORY_INTERPOLATION_MAX_GAP_MS, stepMs * HISTORY_INTERPOLATION_GAP_FACTOR)
  );

  const latestSourceMs = normalized[normalized.length - 1].timestampMs;
  const windowEndMs = Math.max(Date.now(), latestSourceMs);
  const windowStartMs = windowEndMs - historyWindowMs;
  const gridStartMs = Math.floor(windowStartMs / stepMs) * stepMs;
  const gridEndMs = Math.ceil(windowEndMs / stepMs) * stepMs;
  const source = normalized.filter((point) => point.timestampMs >= (gridStartMs - maxInterpolationGapMs));

  const keys = [
    'cpuUsagePercent',
    'ramUsagePercent',
    'gpuUsagePercent',
    'cpuTemperatureC',
    'gpuTemperatureC'
  ];

  let sourceIndex = 0;
  const output = [];
  for (let ts = gridStartMs; ts <= gridEndMs; ts += stepMs) {
    while (sourceIndex < source.length && source[sourceIndex].timestampMs < ts) {
      sourceIndex += 1;
    }
    const nextPoint = sourceIndex < source.length ? source[sourceIndex] : null;
    const prevPoint = sourceIndex > 0 ? source[sourceIndex - 1] : null;

    const row = {
      capturedAt: new Date(ts).toISOString(),
      timestampMs: ts
    };

    for (const key of keys) {
      const nextValue = nextPoint && nextPoint.timestampMs === ts
        ? toNumberOrNull(nextPoint[key])
        : null;
      const prevValue = prevPoint && prevPoint.timestampMs === ts
        ? toNumberOrNull(prevPoint[key])
        : null;
      row[key] = Number.isFinite(nextValue)
        ? nextValue
        : (Number.isFinite(prevValue)
          ? prevValue
          : interpolateMetric(prevPoint, nextPoint, key, ts, maxInterpolationGapMs));
    }
    output.push(row);
  }

  return output;
}

const historyDayBoundaryPlugin = {
  id: 'historyDayBoundary',
  afterDatasetsDraw(chart, _args, options) {
    if (options === false) {
      return;
    }
    const xScale = chart?.scales?.x;
    const area = chart?.chartArea;
    const labels = Array.isArray(chart?.data?.labels) ? chart.data.labels : [];
    if (!xScale || !area || labels.length < 2) {
      return;
    }

    const ctx = chart.ctx;
    ctx.save();
    ctx.strokeStyle = 'rgba(111,57,34,0.30)';
    ctx.fillStyle = 'rgba(111,57,34,0.75)';
    ctx.setLineDash([4, 4]);
    ctx.lineWidth = 1;
    ctx.font = '11px sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';

    for (let index = 1; index < labels.length; index += 1) {
      const prevDayKey = toDayKeyFromTimestamp(labels[index - 1]);
      const nextDayKey = toDayKeyFromTimestamp(labels[index]);
      if (!prevDayKey || !nextDayKey || prevDayKey === nextDayKey) {
        continue;
      }
      const xPrev = xScale.getPixelForValue(index - 1);
      const xNext = xScale.getPixelForValue(index);
      const x = (xPrev + xNext) / 2;

      ctx.beginPath();
      ctx.moveTo(x, area.top);
      ctx.lineTo(x, area.bottom);
      ctx.stroke();

      const markerLabel = formatDayMarkerLabel(labels[index]);
      if (markerLabel) {
        ctx.fillText(markerLabel, x + 4, area.top + 4);
      }
    }
    ctx.restore();
  }
};

function buildSeriesToggleButtonStyle(color, active) {
  if (active) {
    return {
      background: color,
      borderColor: color,
      color: '#fffaf1'
    };
  }
  return {
    background: 'transparent',
    borderColor: color,
    color
  };
}

function getHistoryViewportBucket() {
  if (typeof window === 'undefined') {
    return 'wide';
  }
  return window.innerWidth < HISTORY_STACK_BREAKPOINT ? 'narrow' : 'wide';
}

function ChartLegendRow({ items = [] }) {
  return (
    <div className="hardware-history-legend-row" aria-hidden="true">
      {items.map((item) => (
        <span key={item.label} className="hardware-history-legend-item">
          <span className="hardware-history-legend-dot" style={{ background: item.color }} />
          <span>{item.label}</span>
        </span>
      ))}
    </div>
  );
}

function GaugeBlock({ title, subtitle, icon, valuePercent, gaugeColor, bars = [], footer = null }) {
  return (
    <Card className="hardware-detail-card hardware-detail-card-top">
      <div className="hardware-detail-card-head">
        <div className="hardware-detail-card-icon"><i className={`pi ${icon}`} /></div>
        <div>
          <h3>{title}</h3>
          {subtitle ? <small>{subtitle}</small> : null}
        </div>
      </div>

      <div className="hardware-detail-gauge-layout">
        <div className="hardware-detail-gauge-wrap">
          <Chart type="doughnut" data={buildGaugeDataset(valuePercent, gaugeColor)} options={gaugeOptions} className="hardware-detail-gauge-chart" />
          <div className="hardware-detail-gauge-center">{formatPercent(valuePercent)}</div>
        </div>
        <div className="hardware-detail-bar-list">
          {bars.map((bar) => (
            <div key={bar.label} className="hardware-detail-bar-item">
              <div className="hardware-detail-bar-head">
                <span>{bar.label}</span>
                <span>{bar.valueLabel}</span>
              </div>
              <ProgressBar value={clampPercent(bar.valuePercent)} showValue={false} />
            </div>
          ))}
        </div>
      </div>

      {footer}
    </Card>
  );
}

export default function HardwarePage({ hardwareMonitoring }) {
  const navigate = useNavigate();
  const [historyHours, setHistoryHours] = useState(24);
  const [historyViewportBucket, setHistoryViewportBucket] = useState(() => getHistoryViewportBucket());
  const [usageSeriesVisible, setUsageSeriesVisible] = useState({
    cpu: true,
    ram: true,
    gpu: true
  });
  const [tempSeriesVisible, setTempSeriesVisible] = useState({
    cpu: true,
    gpu: true
  });
  const [historyState, setHistoryState] = useState({
    loading: false,
    points: [],
    totalPoints: 0,
    error: null
  });
  const monitoringState = useMemo(
    () => normalizeHardwareMonitoringPayload(hardwareMonitoring),
    [hardwareMonitoring]
  );

  const sample = monitoringState.sample;
  const cpu = sample?.cpu && typeof sample.cpu === 'object' ? sample.cpu : {};
  const memory = sample?.memory && typeof sample.memory === 'object' ? sample.memory : {};
  const gpu = sample?.gpu && typeof sample.gpu === 'object' ? sample.gpu : {};

  const cpuPerCore = Array.isArray(cpu?.perCore) ? cpu.perCore : [];
  const gpuDevices = Array.isArray(gpu?.devices) ? gpu.devices : [];
  const primaryGpu = gpuDevices[0] || null;

  const cpuTitle = String(cpu?.name || cpu?.model || cpu?.modelName || cpu?.brand || '').trim() || 'CPU';
  const ramTitle = String(memory?.name || memory?.vendor || memory?.model || '').trim() || 'Arbeitsspeicher';
  const gpuTitle = String(primaryGpu?.name || gpu?.name || gpu?.vendor || '').trim() || 'GPU';
  const historyPoints = Array.isArray(historyState.points) ? historyState.points : [];
  const resampledHistoryPoints = useMemo(
    () => buildResampledHistoryPoints(historyPoints, historyHours),
    [historyPoints, historyHours]
  );

  useEffect(() => {
    if (!monitoringState.enabled) {
      setHistoryState({
        loading: false,
        points: [],
        totalPoints: 0,
        error: null
      });
      return undefined;
    }

    let cancelled = false;
    const loadHistory = async (forceRefresh = false) => {
      setHistoryState((prev) => ({
        ...prev,
        loading: prev.points.length === 0
      }));
      try {
        const response = await api.getHardwareHistory({
          hours: historyHours,
          maxPoints: 900,
          forceRefresh
        });
        if (cancelled) {
          return;
        }
        const payload = response?.history && typeof response.history === 'object' ? response.history : {};
        setHistoryState({
          loading: false,
          points: Array.isArray(payload.points) ? payload.points : [],
          totalPoints: Number(payload.totalPoints || 0),
          error: null
        });
      } catch (error) {
        if (cancelled) {
          return;
        }
        setHistoryState((prev) => ({
          ...prev,
          loading: false,
          error: error?.message || 'Historische Hardware-Daten konnten nicht geladen werden.'
        }));
      }
    };

    loadHistory(true);
    const refreshMs = Math.max(5000, Number(monitoringState.intervalMs || 5000) * 2);
    const timer = setInterval(() => {
      loadHistory(true);
    }, refreshMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [historyHours, monitoringState.enabled, monitoringState.intervalMs]);

  useEffect(() => {
    let frame = null;
    const handleResize = () => {
      if (frame) {
        cancelAnimationFrame(frame);
      }
      frame = requestAnimationFrame(() => {
        frame = null;
        setHistoryViewportBucket((prev) => {
          const next = getHistoryViewportBucket();
          return prev === next ? prev : next;
        });
      });
    };
    window.addEventListener('resize', handleResize);
    return () => {
      if (frame) {
        cancelAnimationFrame(frame);
      }
      window.removeEventListener('resize', handleResize);
    };
  }, []);

const historyUsageChartData = useMemo(() => ({
    labels: resampledHistoryPoints.map((point) => String(point?.capturedAt || '').trim()),
    datasets: [
      {
        label: 'CPU',
        data: resampledHistoryPoints.map((point) => toNumberOrNull(point?.cpuUsagePercent)),
        borderColor: CPU_SERIES_COLOR,
        backgroundColor: CPU_SERIES_COLOR,
        borderWidth: 2,
        hidden: !usageSeriesVisible.cpu,
        pointRadius: 0,
        tension: 0.22
      },
      {
        label: 'RAM',
        data: resampledHistoryPoints.map((point) => toNumberOrNull(point?.ramUsagePercent)),
        borderColor: RAM_SERIES_COLOR,
        backgroundColor: RAM_SERIES_COLOR,
        borderWidth: 2,
        hidden: !usageSeriesVisible.ram,
        pointRadius: 0,
        tension: 0.22
      },
      {
        label: 'GPU',
        data: resampledHistoryPoints.map((point) => toNumberOrNull(point?.gpuUsagePercent)),
        borderColor: GPU_SERIES_COLOR,
        backgroundColor: GPU_SERIES_COLOR,
        borderWidth: 2,
        hidden: !usageSeriesVisible.gpu,
        pointRadius: 0,
        tension: 0.22
      }
    ]
  }), [resampledHistoryPoints, usageSeriesVisible]);

const historyTempChartData = useMemo(() => ({
    labels: resampledHistoryPoints.map((point) => String(point?.capturedAt || '').trim()),
    datasets: [
      {
        label: 'CPU',
        data: resampledHistoryPoints.map((point) => toNumberOrNull(point?.cpuTemperatureC)),
        borderColor: CPU_SERIES_COLOR,
        backgroundColor: CPU_SERIES_COLOR,
        borderWidth: 2,
        hidden: !tempSeriesVisible.cpu,
        pointRadius: 0,
        tension: 0.22
      },
      {
        label: 'GPU',
        data: resampledHistoryPoints.map((point) => toNumberOrNull(point?.gpuTemperatureC)),
        borderColor: GPU_SERIES_COLOR,
        backgroundColor: GPU_SERIES_COLOR,
        borderWidth: 2,
        hidden: !tempSeriesVisible.gpu,
        pointRadius: 0,
        tension: 0.22
      }
    ]
  }), [resampledHistoryPoints, tempSeriesVisible]);

  return (
    <div className="hardware-detail-page">
      <Card className="hardware-detail-hero">
        <div className="hardware-detail-hero-head">
          <div>
            <h2>Hardware Monitoring</h2>
            <small>Ausführliche Live-Ansicht für CPU, RAM und GPU</small>
          </div>
          <div className="hardware-detail-hero-tags">
            <Tag value={monitoringState.enabled ? 'Aktiv' : 'Inaktiv'} severity={monitoringState.enabled ? 'success' : 'warning'} />
            <Tag value={`Intervall: ${monitoringState.intervalMs > 0 ? `${monitoringState.intervalMs} ms` : '-'}`} severity="secondary" />
            <Tag value={`Letztes Update: ${formatUpdatedAt(monitoringState.updatedAt)}`} severity="info" />
          </div>
        </div>
      </Card>

      {!monitoringState.enabled ? (
        <Card className="hardware-detail-empty">
          <h3>Monitoring ist deaktiviert</h3>
          <p>
            Aktiviere <code>hardware_monitoring_enabled</code> in den Einstellungen,
            um die Live-Ansicht auf dieser Seite zu nutzen.
          </p>
          <Button
            label="Zu den Einstellungen"
            icon="pi pi-cog"
            onClick={() => navigate('/settings')}
          />
        </Card>
      ) : null}

      {monitoringState.enabled && !sample ? (
        <Card className="hardware-detail-empty">
          <h3>Warte auf erste Messung ...</h3>
          <p>Die Hardware-Metriken werden gerade aufgebaut.</p>
        </Card>
      ) : null}

      {monitoringState.enabled ? (
        <Card className="hardware-detail-card hardware-history-card">
          <div className="hardware-detail-card-head hardware-history-card-head">
            <div>
              <h3>Historie</h3>
              <small>
                Verlauf aus Backend-Log ({historyState.totalPoints} Messpunkte, Ansicht: letzte {historyHours}h)
              </small>
            </div>
            <div className="hardware-history-window-buttons">
              {HISTORY_WINDOWS.map((window) => (
                <Button
                  key={`history-window-${window.hours}`}
                  label={window.label}
                  size="small"
                  severity={historyHours === window.hours ? 'primary' : 'secondary'}
                  outlined={historyHours !== window.hours}
                  onClick={() => setHistoryHours(window.hours)}
                />
              ))}
            </div>
          </div>
          {historyState.error ? <small className="error-text">{historyState.error}</small> : null}
          {historyState.loading && historyPoints.length === 0 ? (
            <p>Lade Verlauf ...</p>
          ) : resampledHistoryPoints.length === 0 ? (
            <p>Noch keine Verlaufsdaten vorhanden.</p>
          ) : (
            <div className="hardware-history-grid">
              <div className="hardware-history-chart-wrap">
                <h4>Auslastung (%)</h4>
                <div className="hardware-history-series-toggles">
                  <Button
                    type="button"
                    size="small"
                    label="CPU"
                    className="hardware-series-toggle-btn"
                    style={buildSeriesToggleButtonStyle(CPU_SERIES_COLOR, usageSeriesVisible.cpu)}
                    onClick={() => setUsageSeriesVisible((prev) => ({ ...prev, cpu: !prev.cpu }))}
                  />
                  <Button
                    type="button"
                    size="small"
                    label="RAM"
                    className="hardware-series-toggle-btn"
                    style={buildSeriesToggleButtonStyle(RAM_SERIES_COLOR, usageSeriesVisible.ram)}
                    onClick={() => setUsageSeriesVisible((prev) => ({ ...prev, ram: !prev.ram }))}
                  />
                  <Button
                    type="button"
                    size="small"
                    label="GPU"
                    className="hardware-series-toggle-btn"
                    style={buildSeriesToggleButtonStyle(GPU_SERIES_COLOR, usageSeriesVisible.gpu)}
                    onClick={() => setUsageSeriesVisible((prev) => ({ ...prev, gpu: !prev.gpu }))}
                  />
                </div>
                <div className="hardware-history-chart">
                  <Chart
                    key={`usage-${historyViewportBucket}`}
                    className="hardware-history-chart-canvas"
                    type="line"
                    data={historyUsageChartData}
                    options={historyChartOptions}
                    plugins={[historyDayBoundaryPlugin]}
                  />
                </div>
                <ChartLegendRow
                  items={[
                    { label: 'CPU', color: CPU_SERIES_COLOR },
                    { label: 'RAM', color: RAM_SERIES_COLOR },
                    { label: 'GPU', color: GPU_SERIES_COLOR }
                  ]}
                />
              </div>
              <div className="hardware-history-chart-wrap">
                <h4>Temperatur (°C)</h4>
                <div className="hardware-history-series-toggles">
                  <Button
                    type="button"
                    size="small"
                    label="CPU °C"
                    className="hardware-series-toggle-btn"
                    style={buildSeriesToggleButtonStyle(CPU_SERIES_COLOR, tempSeriesVisible.cpu)}
                    onClick={() => setTempSeriesVisible((prev) => ({ ...prev, cpu: !prev.cpu }))}
                  />
                  <Button
                    type="button"
                    size="small"
                    label="GPU °C"
                    className="hardware-series-toggle-btn"
                    style={buildSeriesToggleButtonStyle(GPU_SERIES_COLOR, tempSeriesVisible.gpu)}
                    onClick={() => setTempSeriesVisible((prev) => ({ ...prev, gpu: !prev.gpu }))}
                  />
                </div>
                <div className="hardware-history-chart">
                  <Chart
                    key={`temp-${historyViewportBucket}`}
                    className="hardware-history-chart-canvas"
                    type="line"
                    data={historyTempChartData}
                    options={historyChartOptions}
                    plugins={[historyDayBoundaryPlugin]}
                  />
                </div>
                <ChartLegendRow
                  items={[
                    { label: 'CPU', color: CPU_SERIES_COLOR },
                    { label: 'GPU', color: GPU_SERIES_COLOR }
                  ]}
                />
              </div>
            </div>
          )}
        </Card>
      ) : null}

      {monitoringState.enabled && sample ? (
        <div className="hardware-detail-grid">
          <GaugeBlock
            title="CPU"
            subtitle={cpuTitle}
            icon="pi-microchip"
            valuePercent={cpu?.overallUsagePercent}
            gaugeColor="#b07a24"
            bars={[
              { label: 'Gesamtauslastung', valuePercent: cpu?.overallUsagePercent, valueLabel: formatPercent(cpu?.overallUsagePercent) },
              { label: 'Load Avg 1m', valuePercent: clampPercent(Number(cpu?.loadAverage?.[0]) * 100 / 8), valueLabel: Array.isArray(cpu?.loadAverage) ? String(cpu.loadAverage[0] ?? '-') : '-' }
            ]}
            footer={(
              <div className="hardware-detail-core-grid">
                {cpuPerCore.length === 0 ? <small>Keine Core-Metriken verfügbar.</small> : cpuPerCore.map((core, index) => (
                  <div key={`cpu-core-${core?.index ?? index}`} className="hardware-detail-core-item">
                    <div className="hardware-detail-bar-head">
                      <span>Core {core?.index ?? index}</span>
                      <span>{formatPercent(core?.usagePercent)}</span>
                    </div>
                    <ProgressBar value={clampPercent(core?.usagePercent)} showValue={false} />
                  </div>
                ))}
              </div>
            )}
          />

          <GaugeBlock
            title="RAM"
            subtitle={ramTitle}
            icon="pi-server"
            valuePercent={memory?.usagePercent}
            gaugeColor="#9f6b1d"
            bars={[
              { label: 'Verwendet', valuePercent: memory?.usagePercent, valueLabel: formatPercent(memory?.usagePercent) },
              { label: 'Belegt', valuePercent: memory?.usagePercent, valueLabel: formatBytes(memory?.usedBytes) },
              { label: 'Frei', valuePercent: Math.max(0, 100 - clampPercent(memory?.usagePercent)), valueLabel: formatBytes(memory?.freeBytes) }
            ]}
            footer={(
              <div className="hardware-detail-meter-wrap">
                <div className="hardware-detail-meter-head">
                  <span>RAM Nutzung</span>
                  <span>{formatBytes(memory?.usedBytes)} / {formatBytes(memory?.totalBytes)}</span>
                </div>
                <ProgressBar value={clampPercent(memory?.usagePercent)} showValue={false} />
              </div>
            )}
          />

          <GaugeBlock
            title="GPU"
            subtitle={gpuTitle}
            icon="pi-desktop"
            valuePercent={primaryGpu?.utilizationPercent}
            gaugeColor="#996521"
            bars={[
              { label: '3D / Compute', valuePercent: primaryGpu?.utilizationPercent, valueLabel: formatPercent(primaryGpu?.utilizationPercent) },
              { label: 'Speicher', valuePercent: primaryGpu?.memoryUtilizationPercent, valueLabel: formatPercent(primaryGpu?.memoryUtilizationPercent) },
              { label: 'VRAM', valuePercent: primaryGpu?.memoryUtilizationPercent, valueLabel: `${formatBytes(primaryGpu?.memoryUsedBytes)} / ${formatBytes(primaryGpu?.memoryTotalBytes)}` }
            ]}
            footer={(
              <div className="hardware-detail-meter-wrap">
                <div className="hardware-detail-meter-head">
                  <span>GPU Nutzung</span>
                  <span>
                    GPU {primaryGpu?.index ?? 0}
                    {primaryGpu?.name ? ` | ${primaryGpu.name}` : ''}
                  </span>
                </div>
                <ProgressBar value={clampPercent(primaryGpu?.utilizationPercent)} showValue={false} />
              </div>
            )}
          />

        </div>
      ) : null}
    </div>
  );
}
