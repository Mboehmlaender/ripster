export const AUDIOBOOK_FORMATS = [
  { label: 'M4B (Original-Audio)', value: 'm4b' },
  { label: 'MP3', value: 'mp3' },
  { label: 'FLAC (verlustlos)', value: 'flac' }
];

export const AUDIOBOOK_FORMAT_SCHEMAS = {
  m4b: {
    fields: []
  },

  flac: {
    fields: [
      {
        key: 'flacCompression',
        label: 'Kompressionsstufe',
        description: '0 = schnell / wenig Kompression, 8 = maximale Kompression',
        type: 'slider',
        min: 0,
        max: 8,
        step: 1,
        default: 5
      }
    ]
  },

  mp3: {
    fields: [
      {
        key: 'mp3Mode',
        label: 'Modus',
        type: 'select',
        options: [
          { label: 'CBR (Konstante Bitrate)', value: 'cbr' },
          { label: 'VBR (Variable Bitrate)', value: 'vbr' }
        ],
        default: 'cbr'
      },
      {
        key: 'mp3Bitrate',
        label: 'Bitrate (kbps)',
        type: 'select',
        showWhen: { field: 'mp3Mode', value: 'cbr' },
        options: [
          { label: '128 kbps', value: 128 },
          { label: '160 kbps', value: 160 },
          { label: '192 kbps', value: 192 },
          { label: '256 kbps', value: 256 },
          { label: '320 kbps', value: 320 }
        ],
        default: 192
      },
      {
        key: 'mp3Quality',
        label: 'VBR Qualität (V0-V9)',
        description: '0 = beste Qualität, 9 = kleinste Datei',
        type: 'slider',
        min: 0,
        max: 9,
        step: 1,
        showWhen: { field: 'mp3Mode', value: 'vbr' },
        default: 4
      }
    ]
  }
};

export function getDefaultAudiobookFormatOptions(format) {
  const schema = AUDIOBOOK_FORMAT_SCHEMAS[format];
  if (!schema) {
    return {};
  }
  const defaults = {};
  for (const field of schema.fields) {
    if (field.default !== undefined) {
      defaults[field.key] = field.default;
    }
  }
  return defaults;
}
