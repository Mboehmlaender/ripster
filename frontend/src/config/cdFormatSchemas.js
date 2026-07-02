/**
 * CD output format schemas.
 * Each format defines the fields shown in CdRipConfigPanel.
 */
export const CD_FORMATS = [
  { label: 'FLAC (verlustlos)', value: 'flac' },
  { label: 'MP3', value: 'mp3' },
  { label: 'Opus', value: 'opus' },
  { label: 'OGG Vorbis', value: 'ogg' },
  { label: 'WAV (unkomprimiert)', value: 'wav' }
];

export const CD_FORMAT_SCHEMAS = {
  wav: {
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
        label: 'VBR Qualität (V0–V9)',
        description: '0 = beste Qualität, 9 = kleinste Datei',
        type: 'slider',
        min: 0,
        max: 9,
        step: 1,
        showWhen: { field: 'mp3Mode', value: 'vbr' },
        default: 4
      }
    ]
  },

  opus: {
    fields: [
      {
        key: 'opusBitrate',
        label: 'Bitrate (kbps)',
        description: 'Empfohlen: 96–192 kbps für Musik',
        type: 'slider',
        min: 32,
        max: 512,
        step: 8,
        default: 160
      },
      {
        key: 'opusComplexity',
        label: 'Encoder-Komplexität',
        description: '0 = schnell, 10 = beste Qualität',
        type: 'slider',
        min: 0,
        max: 10,
        step: 1,
        default: 10
      }
    ]
  },

  ogg: {
    fields: [
      {
        key: 'oggQuality',
        label: 'Qualität',
        description: '-1 = kleinste Datei, 10 = beste Qualität. Empfohlen: 5–7.',
        type: 'slider',
        min: -1,
        max: 10,
        step: 1,
        default: 6
      }
    ]
  }
};

export function getDefaultFormatOptions(format) {
  const schema = CD_FORMAT_SCHEMAS[format];
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
