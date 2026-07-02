import { useCallback, useMemo, useRef, useState } from 'react';
import { Button } from 'primereact/button';
import { ProgressBar } from 'primereact/progressbar';
import { Tag } from 'primereact/tag';

const DEFAULT_ALLOWED_EXTENSIONS = [
  'mkv', 'mp4', 'm2ts', 'iso', 'avi', 'mov',
  'flac', 'mp3', 'wav', 'm4a', 'ogg', 'opus'
];

function normalizeAllowedExtensions(values) {
  const source = Array.isArray(values) ? values : [];
  const seen = new Set();
  const parsed = source
    .map((item) => String(item || '').trim().toLowerCase())
    .filter((item) => {
      if (!item || !DEFAULT_ALLOWED_EXTENSIONS.includes(item) || seen.has(item)) {
        return false;
      }
      seen.add(item);
      return true;
    });
  if (parsed.length === 0) {
    return [...DEFAULT_ALLOWED_EXTENSIONS];
  }
  return parsed;
}

function getFileExtensionWithoutDot(fileName) {
  const raw = String(fileName || '').trim();
  const dotIndex = raw.lastIndexOf('.');
  if (dotIndex === -1 || dotIndex === raw.length - 1) {
    return '';
  }
  return raw.slice(dotIndex + 1).toLowerCase();
}

/**
 * Upload-Panel für den Converter.
 * Unterstützt Mehrfach-Dateien und Ordner-Upload (webkitdirectory).
 */
export default function ConverterUploadPanel({ onUploaded, allowedExtensions = null }) {
  const [phase, setPhase] = useState('idle'); // idle | uploading | done | error
  const [progress, setProgress] = useState(0);
  const [statusText, setStatusText] = useState('');
  const [errorMsg, setErrorMsg] = useState(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const fileInputRef = useRef(null);
  const dirInputRef = useRef(null);
  const normalizedAllowedExtensions = useMemo(
    () => normalizeAllowedExtensions(allowedExtensions),
    [allowedExtensions]
  );
  const allowedExtensionSet = useMemo(
    () => new Set(normalizedAllowedExtensions),
    [normalizedAllowedExtensions]
  );
  const acceptValue = useMemo(
    () => normalizedAllowedExtensions.map((ext) => `.${ext}`).join(','),
    [normalizedAllowedExtensions]
  );
  const allowedListLabel = useMemo(
    () => normalizedAllowedExtensions.map((ext) => ext.toUpperCase()).join(', '),
    [normalizedAllowedExtensions]
  );

  const reset = () => {
    setPhase('idle');
    setProgress(0);
    setStatusText('');
    setErrorMsg(null);
  };

  const uploadFiles = useCallback(async (fileList) => {
    const files = Array.from(fileList).filter((f) => {
      if (f.size === 0) return false;
      // Dot-Dateien (.DS_Store, .gitkeep, __MACOSX etc.) ignorieren
      const relPath = f.webkitRelativePath || f.name;
      return !relPath.split('/').some((seg) => seg.startsWith('.') || seg === '__MACOSX');
    });
    if (files.length === 0) return;

    const invalidFiles = files
      .map((file) => ({
        name: String(file?.name || '').trim(),
        ext: getFileExtensionWithoutDot(file?.name)
      }))
      .filter((item) => !item.ext || !allowedExtensionSet.has(item.ext));
    if (invalidFiles.length > 0) {
      const preview = invalidFiles.slice(0, 6).map((item) => item.name || '<ohne Dateiname>').join(', ');
      const suffix = invalidFiles.length > 6 ? ` (+${invalidFiles.length - 6} weitere)` : '';
      setPhase('error');
      setProgress(0);
      setStatusText('Upload abgelehnt');
      setErrorMsg(
        `Nicht erlaubte Datei-Endung in ${invalidFiles.length} Datei(en): ${preview}${suffix}. Erlaubt: ${allowedListLabel}`
      );
      return;
    }

    const isFolderUpload = files.some((f) => f.webkitRelativePath && f.webkitRelativePath.includes('/'));

    setPhase('uploading');
    setProgress(0);
    setStatusText(isFolderUpload
      ? `Lade Ordner hoch (${files.length} Datei${files.length !== 1 ? 'en' : ''}) …`
      : `Lade ${files.length} Datei${files.length !== 1 ? 'en' : ''} hoch …`);
    setErrorMsg(null);

    // Wie Klangkiste: folderName als eigenes Feld, Dateien mit file.name (kein Pfad im Dateinamen)
    const formData = new FormData();
    if (isFolderUpload) {
      const folderName = files.find((f) => f.webkitRelativePath)?.webkitRelativePath?.split('/')[0] || 'upload';
      formData.append('folderName', folderName);
      for (const file of files) {
        formData.append('files', file, file.name);
      }
    } else {
      for (const file of files) {
        formData.append('files', file, file.name);
      }
    }

    try {
      // XHR für Upload-Fortschritt
      const result = await uploadWithProgress(formData, (pct) => {
        setProgress(pct);
        setStatusText(`Upload: ${Math.trunc(pct)}%`);
      });

      setPhase('done');
      setProgress(100);
      const folders = result.folders || [];
      setStatusText(`${folders.length} Ordner hochgeladen.`);
      onUploaded?.(folders);
    } catch (err) {
      setPhase('error');
      setErrorMsg(err.message || 'Upload fehlgeschlagen.');
    }
  }, [onUploaded, allowedExtensionSet, allowedListLabel]);

  const handleFileChange = (e) => {
    if (e.target.files?.length > 0) {
      uploadFiles(e.target.files);
    }
    e.target.value = '';
  };

  const handleDrop = (e) => {
    e.preventDefault();
    setIsDragOver(false);
    const dt = e.dataTransfer;
    if (dt?.files?.length > 0) {
      uploadFiles(dt.files);
    }
  };

  const handleDragOver = (e) => { e.preventDefault(); setIsDragOver(true); };
  const handleDragLeave = () => setIsDragOver(false);

  const phaseLabel = {
    idle: null,
    uploading: { label: 'Wird hochgeladen', severity: 'warning' },
    done: { label: 'Fertig', severity: 'success' },
    error: { label: 'Fehler', severity: 'danger' }
  }[phase];

  return (
    <div className="converter-upload-panel">
      <div
        className={`converter-upload-dropzone${isDragOver ? ' drag-over' : ''}`}
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
      >
        <div className="converter-upload-icon">
          <i className="pi pi-upload" style={{ fontSize: '2rem', color: '#888' }} />
        </div>
        <div className="converter-upload-hint">
          Dateien hierher ziehen oder auswählen
          <br />
          <small>Unterstützt: {allowedListLabel}</small>
        </div>
        <div className="converter-upload-buttons">
          <Button
            label="Dateien auswählen"
            icon="pi pi-file"
            size="small"
            outlined
            disabled={phase === 'uploading'}
            onClick={() => fileInputRef.current?.click()}
          />
          <Button
            label="Ordner auswählen"
            icon="pi pi-folder-open"
            size="small"
            outlined
            disabled={phase === 'uploading'}
            onClick={() => dirInputRef.current?.click()}
          />
        </div>

        {/* Versteckte File-Inputs */}
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept={acceptValue}
          style={{ display: 'none' }}
          onChange={handleFileChange}
        />
        <input
          ref={dirInputRef}
          type="file"
          webkitdirectory="true"
          multiple
          accept={acceptValue}
          style={{ display: 'none' }}
          onChange={handleFileChange}
        />
      </div>

      {phase !== 'idle' && (
        <div className="converter-upload-status">
          <div className="converter-upload-status-head">
            {phaseLabel && <Tag value={phaseLabel.label} severity={phaseLabel.severity} />}
            <span>{statusText}</span>
            {(phase === 'done' || phase === 'error') && (
              <Button
                icon="pi pi-times"
                text
                rounded
                size="small"
                onClick={reset}
                aria-label="Schließen"
              />
            )}
          </div>
          {phase === 'uploading' && (
            <ProgressBar value={progress} style={{ height: 6 }} />
          )}
          {phase === 'error' && errorMsg && (
            <small style={{ color: 'var(--red-500)' }}>{errorMsg}</small>
          )}
        </div>
      )}
    </div>
  );
}

function uploadWithProgress(formData, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const apiBase = import.meta.env.VITE_API_BASE || '/api';

    xhr.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable) {
        onProgress(Math.round((e.loaded / e.total) * 100));
      }
    });

    xhr.addEventListener('load', () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(JSON.parse(xhr.responseText));
        } catch (_err) {
          resolve({});
        }
      } else {
        let msg = `HTTP ${xhr.status}`;
        try {
          const parsed = JSON.parse(xhr.responseText);
          msg = parsed?.error?.message || msg;
        } catch (_err) { /* ignore */ }
        reject(new Error(msg));
      }
    });

    xhr.addEventListener('error', () => reject(new Error('Netzwerkfehler beim Upload.')));
    xhr.addEventListener('abort', () => reject(new Error('Upload abgebrochen.')));

    xhr.open('POST', `${apiBase}/converter/upload`);
    xhr.send(formData);
  });
}
