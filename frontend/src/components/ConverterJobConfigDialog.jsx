import { useEffect, useState } from 'react';
import { Button } from 'primereact/button';
import { Dialog } from 'primereact/dialog';
import { Dropdown } from 'primereact/dropdown';
import { InputNumber } from 'primereact/inputnumber';
import { SelectButton } from 'primereact/selectbutton';
import { Divider } from 'primereact/divider';
import { Message } from 'primereact/message';
import { api } from '../api/client';

const VIDEO_OUTPUT_FORMATS = [
  { label: 'MKV', value: 'mkv' },
  { label: 'MP4', value: 'mp4' },
  { label: 'M4V', value: 'm4v' }
];

const AUDIO_OUTPUT_FORMATS = [
  { label: 'FLAC', value: 'flac' },
  { label: 'MP3', value: 'mp3' },
  { label: 'Opus', value: 'opus' },
  { label: 'OGG', value: 'ogg' },
  { label: 'WAV', value: 'wav' }
];

const MP3_MODES = [
  { label: 'CBR', value: 'cbr' },
  { label: 'VBR', value: 'vbr' }
];

/**
 * Konfigurationsmodal für einen Converter-Job.
 * Erscheint nachdem ein Job aus dem File-Explorer oder Upload erstellt wurde.
 */
export default function ConverterJobConfigDialog({
  visible,
  job,
  onHide,
  onStarted
}) {
  const [converterMediaType, setConverterMediaType] = useState('video');
  const [outputFormat, setOutputFormat] = useState('mkv');
  const [userPresets, setUserPresets] = useState([]);
  const [hbPresets, setHbPresets] = useState([]);
  const [selectedUserPreset, setSelectedUserPreset] = useState(null);
  const [selectedHbPreset, setSelectedHbPreset] = useState('');
  const [audioFormatOptions, setAudioFormatOptions] = useState({
    flacCompression: 5,
    mp3Mode: 'cbr',
    mp3Bitrate: 192,
    mp3Quality: 4,
    opusBitrate: 160,
    oggQuality: 6
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  // Beim Öffnen: Medientyp und Format aus dem Job-Plan lesen
  useEffect(() => {
    if (!job || !visible) return;

    let plan = null;
    try {
      plan = job.encode_plan_json ? JSON.parse(job.encode_plan_json) : null;
    } catch (_err) { /* ignore */ }

    const mediaType = plan?.converterMediaType || 'video';
    setConverterMediaType(mediaType);
    setOutputFormat(mediaType === 'audio' ? 'flac' : 'mkv');
    setSelectedUserPreset(null);
    setSelectedHbPreset('');
    setError(null);
  }, [job, visible]);

  // User-Presets laden
  useEffect(() => {
    if (!visible) return;
    api.getUserPresets?.('video')
      .then((data) => setUserPresets(Array.isArray(data?.presets) ? data.presets : []))
      .catch(() => setUserPresets([]));
  }, [visible]);

  // HandBrake Built-in Presets laden
  useEffect(() => {
    if (!visible || converterMediaType !== 'video') return;
    api.getHandBrakePresets?.()
      .then((data) => {
        const list = Array.isArray(data?.presets) ? data.presets : [];
        setHbPresets(list);
      })
      .catch(() => setHbPresets([]));
  }, [visible, converterMediaType]);

  const handleStart = async () => {
    if (!job) return;
    setBusy(true);
    setError(null);
    try {
      let userPreset = null;
      if (selectedUserPreset) {
        const found = userPresets.find((p) => p.id === selectedUserPreset);
        if (found) {
          userPreset = {
            id: found.id,
            handbrakePreset: found.handbrake_preset || null,
            extraArgs: found.extra_args || ''
          };
        }
      } else if (selectedHbPreset) {
        userPreset = { handbrakePreset: selectedHbPreset, extraArgs: '' };
      }

      await api.startConverterJob(job.id, {
        converterMediaType,
        outputFormat,
        userPreset,
        audioFormatOptions: converterMediaType === 'audio' ? audioFormatOptions : undefined
      });

      onStarted?.(job.id);
      onHide?.();
    } catch (err) {
      setError(err.message || 'Fehler beim Starten.');
    } finally {
      setBusy(false);
    }
  };

  const isVideo = converterMediaType === 'video' || converterMediaType === 'iso';
  const isAudio = converterMediaType === 'audio';
  const outputFormats = isVideo ? VIDEO_OUTPUT_FORMATS : AUDIO_OUTPUT_FORMATS;

  const footer = (
    <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
      <Button label="Abbrechen" outlined onClick={onHide} disabled={busy} />
      <Button
        label="Encoding starten"
        icon={busy ? 'pi pi-spin pi-spinner' : 'pi pi-play'}
        disabled={busy}
        onClick={handleStart}
      />
    </div>
  );

  return (
    <Dialog
      header={`Converter konfigurieren — ${job?.title || job?.detected_title || 'Job'}`}
      visible={visible}
      onHide={onHide}
      footer={footer}
      style={{ width: '520px' }}
      modal
    >
      {error && (
        <Message severity="error" text={error} style={{ marginBottom: 16, width: '100%' }} />
      )}

      {/* Medientyp anzeigen (read-only) */}
      <div className="field">
        <label>Medientyp</label>
        <div style={{ marginTop: 4 }}>
          <strong>{converterMediaType === 'iso' ? 'ISO (Video)' : converterMediaType === 'video' ? 'Video' : 'Audio'}</strong>
          {converterMediaType === 'iso' && (
            <small style={{ marginLeft: 8, color: '#888' }}>→ MakeMKV Rip, dann HandBrake</small>
          )}
        </div>
      </div>

      {/* Ausgabeformat */}
      <div className="field" style={{ marginTop: 12 }}>
        <label>Ausgabeformat</label>
        <Dropdown
          value={outputFormat}
          options={outputFormats}
          onChange={(e) => setOutputFormat(e.value)}
          style={{ width: '100%', marginTop: 4 }}
        />
      </div>

      {/* Video: Preset-Auswahl */}
      {isVideo && (
        <>
          <Divider />
          <div className="field">
            <label>User-Preset (optional)</label>
            <Dropdown
              value={selectedUserPreset}
              options={[
                { label: '— Kein User-Preset —', value: null },
                ...userPresets.map((p) => ({ label: p.name, value: p.id }))
              ]}
              onChange={(e) => {
                setSelectedUserPreset(e.value);
                if (e.value) setSelectedHbPreset('');
              }}
              style={{ width: '100%', marginTop: 4 }}
            />
          </div>
          {!selectedUserPreset && (
            <div className="field" style={{ marginTop: 12 }}>
              <label>HandBrake-Preset (optional)</label>
              <Dropdown
                value={selectedHbPreset}
                options={[
                  { label: '— Kein Preset (HB-Standard) —', value: '' },
                  ...hbPresets.map((p) => ({
                    label: p.category ? `[${p.category}] ${p.name}` : p.name,
                    value: p.name
                  }))
                ]}
                onChange={(e) => setSelectedHbPreset(e.value)}
                filter
                style={{ width: '100%', marginTop: 4 }}
                placeholder="Preset auswählen …"
              />
            </div>
          )}
        </>
      )}

      {/* Audio: Format-Optionen */}
      {isAudio && (
        <>
          <Divider />
          {outputFormat === 'flac' && (
            <div className="field">
              <label>Komprimierung (0–12)</label>
              <InputNumber
                value={audioFormatOptions.flacCompression}
                onValueChange={(e) => setAudioFormatOptions((p) => ({ ...p, flacCompression: e.value ?? 5 }))}
                min={0} max={12} step={1}
                style={{ width: '100%', marginTop: 4 }}
              />
            </div>
          )}
          {outputFormat === 'mp3' && (
            <>
              <div className="field">
                <label>Modus</label>
                <SelectButton
                  value={audioFormatOptions.mp3Mode}
                  options={MP3_MODES}
                  onChange={(e) => setAudioFormatOptions((p) => ({ ...p, mp3Mode: e.value || 'cbr' }))}
                  style={{ marginTop: 4 }}
                />
              </div>
              {audioFormatOptions.mp3Mode === 'cbr' ? (
                <div className="field" style={{ marginTop: 12 }}>
                  <label>Bitrate (kbps)</label>
                  <Dropdown
                    value={audioFormatOptions.mp3Bitrate}
                    options={[128, 160, 192, 224, 256, 320].map((v) => ({ label: `${v} kbps`, value: v }))}
                    onChange={(e) => setAudioFormatOptions((p) => ({ ...p, mp3Bitrate: e.value }))}
                    style={{ width: '100%', marginTop: 4 }}
                  />
                </div>
              ) : (
                <div className="field" style={{ marginTop: 12 }}>
                  <label>VBR Qualität (0=beste, 9=schlechteste)</label>
                  <InputNumber
                    value={audioFormatOptions.mp3Quality}
                    onValueChange={(e) => setAudioFormatOptions((p) => ({ ...p, mp3Quality: e.value ?? 4 }))}
                    min={0} max={9} step={1}
                    style={{ width: '100%', marginTop: 4 }}
                  />
                </div>
              )}
            </>
          )}
          {outputFormat === 'opus' && (
            <div className="field">
              <label>Bitrate (kbps)</label>
              <Dropdown
                value={audioFormatOptions.opusBitrate}
                options={[64, 96, 128, 160, 192, 256].map((v) => ({ label: `${v} kbps`, value: v }))}
                onChange={(e) => setAudioFormatOptions((p) => ({ ...p, opusBitrate: e.value }))}
                style={{ width: '100%', marginTop: 4 }}
              />
            </div>
          )}
          {outputFormat === 'ogg' && (
            <div className="field">
              <label>Qualität (-1 bis 10)</label>
              <InputNumber
                value={audioFormatOptions.oggQuality}
                onValueChange={(e) => setAudioFormatOptions((p) => ({ ...p, oggQuality: e.value ?? 6 }))}
                min={-1} max={10} step={1}
                style={{ width: '100%', marginTop: 4 }}
              />
            </div>
          )}
        </>
      )}
    </Dialog>
  );
}
