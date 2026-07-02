const STATUS_LABELS = {
  IDLE: 'Bereit',
  DISC_DETECTED: 'Medium erkannt',
  ANALYZING: 'Analyse',
  METADATA_LOOKUP: 'TMDb-Suche',
  METADATA_SELECTION: 'Metadatenauswahl',
  WAITING_FOR_USER_DECISION: 'Warte auf Auswahl',
  READY_TO_START: 'Startbereit',
  MEDIAINFO_CHECK: 'Mediainfo-Prüfung',
  READY_TO_ENCODE: 'Bereit zum Encodieren',
  RIPPING: 'Rippen',
  ENCODING: 'Encodieren',
  POST_ENCODE_SCRIPTS: 'Nachbearbeitung',
  FINISHED: 'Fertig',
  CANCELLED: 'Abgebrochen',
  ERROR: 'Fehler',
  CD_ANALYZING: 'Analyse',
  CD_METADATA_SELECTION: 'Metadatenauswahl',
  CD_READY_TO_RIP: 'Bereit zum Encodieren',
  CD_RIPPING: 'Rippen',
  CD_ENCODING: 'Encodieren'
};

const PROCESS_STATUS_LABELS = {
  SUCCESS: 'Erfolgreich',
  ERROR: 'Fehler',
  CANCELLED: 'Abgebrochen',
  RUNNING: 'Läuft',
  STARTED: 'Gestartet',
  PENDING: 'Ausstehend',
  DONE: 'Erledigt',
  FAILED: 'Fehlgeschlagen',
  COMPLETE: 'Abgeschlossen',
  COMPLETED: 'Abgeschlossen',
  SKIPPED: 'Übersprungen',
  OK: 'OK'
};

const FALLBACK_TOKEN_LABELS = {
  IDLE: 'Bereit',
  DISC: 'Medium',
  DETECTED: 'erkannt',
  READY: 'bereit',
  TO: 'zu',
  RIP: 'rippen',
  RIPPING: 'rippen',
  ENCODE: 'encodieren',
  ENCODING: 'encodieren',
  ANALYZING: 'analyse',
  LOOKUP: 'suche',
  METADATA: 'metadaten',
  SELECTION: 'auswahl',
  WAITING: 'warte',
  FOR: 'auf',
  USER: 'Benutzer',
  DECISION: 'entscheidung',
  CHECK: 'prüfung',
  POST: 'post',
  SCRIPTS: 'skripte',
  FINISHED: 'fertig',
  CANCELLED: 'abgebrochen',
  ERROR: 'fehler',
  SUCCESS: 'erfolgreich',
  RUNNING: 'läuft',
  STARTED: 'gestartet',
  PENDING: 'ausstehend',
  FAILED: 'fehlgeschlagen',
  SKIPPED: 'übersprungen',
  CD: 'CD',
  DVD: 'DVD',
  RAW: 'RAW'
};

function prettifyUnknownStatus(status) {
  const raw = String(status || '').trim();
  if (!raw) {
    return '-';
  }
  if (!raw.includes('_')) {
    return raw;
  }
  const parts = raw
    .split('_')
    .map((part) => String(part || '').trim().toUpperCase())
    .filter(Boolean);
  if (parts.length === 0) {
    return raw;
  }
  const mapped = parts.map((token) => FALLBACK_TOKEN_LABELS[token] || token.toLowerCase());
  const joined = mapped.join(' ').trim();
  if (!joined) {
    return raw;
  }
  return joined.charAt(0).toUpperCase() + joined.slice(1);
}

export function normalizeStatus(status) {
  return String(status || '').trim().toUpperCase();
}

export function getStatusLabel(status, options = {}) {
  if (options?.queued) {
    return 'In der Queue';
  }
  const normalized = normalizeStatus(status);
  return STATUS_LABELS[normalized] || prettifyUnknownStatus(status);
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
    || normalized === 'METADATA_LOOKUP'
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
  return PROCESS_STATUS_LABELS[normalized] || prettifyUnknownStatus(status);
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
  { label: getStatusLabel('METADATA_LOOKUP'), value: 'METADATA_LOOKUP' },
  { label: getStatusLabel('METADATA_SELECTION'), value: 'METADATA_SELECTION' }
];
