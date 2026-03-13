const STATUS_LABELS = {
  IDLE: 'Bereit',
  DISC_DETECTED: 'Medium erkannt',
  ANALYZING: 'Analyse',
  METADATA_SELECTION: 'Metadatenauswahl',
  WAITING_FOR_USER_DECISION: 'Warte auf Auswahl',
  READY_TO_START: 'Startbereit',
  MEDIAINFO_CHECK: 'Mediainfo-Pruefung',
  READY_TO_ENCODE: 'Bereit zum Encodieren',
  RIPPING: 'Rippen',
  ENCODING: 'Encodieren',
  POST_ENCODE_SCRIPTS: 'Nachbearbeitung',
  FINISHED: 'Fertig',
  CANCELLED: 'Abgebrochen',
  ERROR: 'Fehler',
  CD_ANALYZING: 'CD-Analyse',
  CD_METADATA_SELECTION: 'CD-Metadatenauswahl',
  CD_READY_TO_RIP: 'CD bereit zum Rippen',
  CD_RIPPING: 'CD rippen',
  CD_ENCODING: 'CD encodieren'
};

const PROCESS_STATUS_LABELS = {
  SUCCESS: 'Erfolgreich',
  ERROR: 'Fehler',
  CANCELLED: 'Abgebrochen',
  RUNNING: 'Laeuft',
  STARTED: 'Gestartet',
  PENDING: 'Ausstehend'
};

export function normalizeStatus(status) {
  return String(status || '').trim().toUpperCase();
}

export function getStatusLabel(status, options = {}) {
  if (options?.queued) {
    return 'In der Queue';
  }
  const normalized = normalizeStatus(status);
  return STATUS_LABELS[normalized] || (String(status || '').trim() || '-');
}

export function getStatusSeverity(status, options = {}) {
  if (options?.queued) {
    return 'info';
  }
  const normalized = normalizeStatus(status);
  if (normalized === 'FINISHED') return 'success';
  if (normalized === 'CANCELLED') return 'warning';
  if (normalized === 'ERROR') return 'danger';
  if (normalized === 'READY_TO_START' || normalized === 'READY_TO_ENCODE') return 'info';
  if (normalized === 'WAITING_FOR_USER_DECISION') return 'warning';
  if (normalized === 'CD_READY_TO_RIP') return 'info';
  if (normalized === 'CD_METADATA_SELECTION') return 'warning';
  if (
    normalized === 'RIPPING'
    || normalized === 'ENCODING'
    || normalized === 'ANALYZING'
    || normalized === 'MEDIAINFO_CHECK'
    || normalized === 'METADATA_SELECTION'
    || normalized === 'POST_ENCODE_SCRIPTS'
    || normalized === 'CD_ANALYZING'
    || normalized === 'CD_RIPPING'
    || normalized === 'CD_ENCODING'
  ) {
    return 'warning';
  }
  return 'secondary';
}

export function getProcessStatusLabel(status) {
  const normalized = normalizeStatus(status);
  return PROCESS_STATUS_LABELS[normalized] || (String(status || '').trim() || '-');
}

export const STATUS_FILTER_OPTIONS = [
  { label: 'Alle', value: '' },
  { label: getStatusLabel('FINISHED'), value: 'FINISHED' },
  { label: getStatusLabel('CANCELLED'), value: 'CANCELLED' },
  { label: getStatusLabel('ERROR'), value: 'ERROR' },
  { label: getStatusLabel('CD_METADATA_SELECTION'), value: 'CD_METADATA_SELECTION' },
  { label: getStatusLabel('CD_READY_TO_RIP'), value: 'CD_READY_TO_RIP' },
  { label: getStatusLabel('CD_ANALYZING'), value: 'CD_ANALYZING' },
  { label: getStatusLabel('CD_RIPPING'), value: 'CD_RIPPING' },
  { label: getStatusLabel('CD_ENCODING'), value: 'CD_ENCODING' },
  { label: getStatusLabel('WAITING_FOR_USER_DECISION'), value: 'WAITING_FOR_USER_DECISION' },
  { label: getStatusLabel('READY_TO_START'), value: 'READY_TO_START' },
  { label: getStatusLabel('READY_TO_ENCODE'), value: 'READY_TO_ENCODE' },
  { label: getStatusLabel('MEDIAINFO_CHECK'), value: 'MEDIAINFO_CHECK' },
  { label: getStatusLabel('RIPPING'), value: 'RIPPING' },
  { label: getStatusLabel('ENCODING'), value: 'ENCODING' },
  { label: getStatusLabel('ANALYZING'), value: 'ANALYZING' },
  { label: getStatusLabel('METADATA_SELECTION'), value: 'METADATA_SELECTION' }
];
