import { useRef, useState } from 'react';
import { FileUpload } from 'primereact/fileupload';
import { Button } from 'primereact/button';
import { ProgressBar } from 'primereact/progressbar';
import { Toast } from 'primereact/toast';

function formatBytes(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return 'n/a';
  }
  if (parsed === 0) {
    return '0 B';
  }
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let unitIndex = 0;
  let current = parsed;
  while (current >= 1024 && unitIndex < units.length - 1) {
    current /= 1024;
    unitIndex += 1;
  }
  const digits = unitIndex <= 1 ? 0 : 2;
  return `${current.toFixed(digits)} ${units[unitIndex]}`;
}

function normalizeJobId(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return Math.trunc(parsed);
}

function extractUploadJobIdFromResponse(response) {
  const payload = response && typeof response === 'object' ? response : {};
  const result = payload?.result && typeof payload.result === 'object' ? payload.result : {};
  return (
    normalizeJobId(result?.jobId)
    || normalizeJobId(payload?.jobId)
    || normalizeJobId(result?.id)
    || normalizeJobId(payload?.id)
    || normalizeJobId(result?.job?.id)
    || normalizeJobId(payload?.job?.id)
    || null
  );
}

export default function AudiobookUploadPanel({
  audiobookUpload,
  onAudiobookUpload,
  onCancelUpload = null,
  onUploaded = null
}) {
  const toastRef = useRef(null);
  const fileUploadRef = useRef(null);
  const fallbackFileInputRef = useRef(null);
  const [uploadFile, setUploadFile] = useState(null);

  const phase = String(audiobookUpload?.phase || 'idle').trim().toLowerCase();
  const uploadBusy = phase === 'uploading' || phase === 'processing';
  const progress = Number.isFinite(Number(audiobookUpload?.progressPercent))
    ? Math.max(0, Math.min(100, Number(audiobookUpload.progressPercent)))
    : 0;
  const loadedBytes = Number(audiobookUpload?.loadedBytes || 0);
  const totalBytes = Number(audiobookUpload?.totalBytes || 0);
  const progressLabel = phase === 'processing'
    ? '100% | Upload fertig, Job wird vorbereitet ...'
    : totalBytes > 0
      ? `${Math.trunc(progress)}% | ${formatBytes(loadedBytes)} / ${formatBytes(totalBytes)}`
      : `${Math.trunc(progress)}%`;
  const hasHeaderStatus = phase !== 'idle' || Boolean(uploadFile);
  const canStartUpload = Boolean(uploadFile) && !uploadBusy;
  const canCancelUpload = uploadBusy && typeof onCancelUpload === 'function';
  const canClearSelection = Boolean(uploadFile) && !uploadBusy;

  const handleUpload = async () => {
    if (!uploadFile) {
      toastRef.current?.show({
        severity: 'warn',
        summary: 'Keine Datei',
        detail: 'Bitte zuerst eine AAX-Datei auswaehlen.',
        life: 2600
      });
      return;
    }
    try {
      const response = await onAudiobookUpload?.(uploadFile, { startImmediately: false });
      const uploadedJobId = extractUploadJobIdFromResponse(response);
      if (uploadedJobId) {
        toastRef.current?.show({
          severity: 'success',
          summary: 'Audiobook importiert',
          detail: `Job #${uploadedJobId} ist bereit.`,
          life: 3200
        });
      } else {
        toastRef.current?.show({
          severity: 'success',
          summary: 'Audiobook importiert',
          detail: 'Upload abgeschlossen.',
          life: 2600
        });
      }
      setUploadFile(null);
      fileUploadRef.current?.clear?.();
      onUploaded?.(uploadedJobId, response);
    } catch (error) {
      if (error?.name === 'AbortError') {
        toastRef.current?.show({
          severity: 'info',
          summary: 'Upload abgebrochen',
          detail: 'Der Audiobook-Upload wurde gestoppt.',
          life: 2800
        });
        return;
      }
      toastRef.current?.show({
        severity: 'error',
        summary: 'Upload fehlgeschlagen',
        detail: error?.message || 'Bitte Logs pruefen.',
        life: 4200
      });
    }
  };

  const handleFileSelected = (file) => {
    if (!file) {
      setUploadFile(null);
      return;
    }
    setUploadFile(file);
  };

  const handleFileCleared = () => {
    setUploadFile(null);
  };

  const handleChooseFile = () => {
    if (uploadBusy) {
      return;
    }
    fallbackFileInputRef.current?.click();
  };

  const handleFileItemAction = (onRemove = null) => {
    if (canCancelUpload) {
      void onCancelUpload();
      onRemove?.();
      fileUploadRef.current?.clear?.();
      handleFileCleared();
      return;
    }
    onRemove?.();
    fileUploadRef.current?.clear?.();
    handleFileCleared();
  };

  const renderFileRow = (file, onRemove = null) => (
    <div className="aax-file-item">
      <i className="pi pi-headphones aax-file-icon" />
      <div className="aax-file-info">
        <span className="aax-file-name" title={file?.name}>{file?.name || 'upload.aax'}</span>
        <small>{formatBytes(Number(file?.size || 0))}</small>
        {hasHeaderStatus ? (
          <div className="aax-file-status">
            <>
              <small className="audiobook-upload-inline-text">{progressLabel}</small>
              <ProgressBar value={progress} showValue={false} />
              {audiobookUpload?.statusText ? (
                <small className="audiobook-upload-inline-text">{audiobookUpload.statusText}</small>
              ) : null}
            </>
          </div>
        ) : null}
      </div>
      <Button
        icon="pi pi-times"
        text
        rounded
        severity="danger"
        size="small"
        onClick={() => {
          handleFileItemAction(onRemove);
        }}
        disabled={!canCancelUpload && !canClearSelection}
        tooltip={canCancelUpload ? 'Upload abbrechen' : 'Auswahl entfernen'}
        tooltipOptions={{ position: 'left' }}
      />
    </div>
  );

  return (
    <div className="audiobook-upload-panel">
      <Toast ref={toastRef} position="top-right" />
      <FileUpload
        ref={fileUploadRef}
        accept=".aax"
        maxFileSize={10737418240}
        customUpload
        uploadHandler={() => void handleUpload()}
        disabled={uploadBusy}
        onSelect={(event) => {
          handleFileSelected(event.files[0] || null);
        }}
        onClear={() => {
          handleFileCleared();
        }}
        onRemove={() => {
          handleFileCleared();
        }}
        chooseOptions={{ icon: 'pi pi-images', iconOnly: true, className: 'p-button-rounded p-button-outlined' }}
        uploadOptions={{ icon: 'pi pi-cloud-upload', iconOnly: true, className: 'p-button-rounded p-button-outlined p-button-success' }}
        cancelOptions={{ icon: 'pi pi-times', iconOnly: true, className: 'p-button-rounded p-button-outlined p-button-danger' }}
        headerTemplate={(options) => (
          <div className={options.className}>
            <div className="audiobook-upload-header">
              <div className="audiobook-upload-header-actions">
                <Button
                  icon="pi pi-images"
                  rounded
                  outlined
                  aria-label="Datei auswählen"
                  onClick={() => {
                    void handleChooseFile();
                  }}
                  disabled={uploadBusy}
                />
                <Button
                  icon="pi pi-cloud-upload"
                  rounded
                  outlined
                  severity="success"
                  aria-label="Upload starten"
                  onClick={() => {
                    void handleUpload();
                  }}
                  disabled={!canStartUpload}
                />
                <Button
                  icon="pi pi-times"
                  rounded
                  outlined
                  severity="secondary"
                  aria-label="Auswahl entfernen"
                  onClick={() => {
                    fileUploadRef.current?.clear?.();
                    handleFileCleared();
                  }}
                  disabled={!canClearSelection}
                />
              </div>
            </div>
          </div>
        )}
        itemTemplate={(file, options) => (
          renderFileRow(file, () => {
            options.onRemove?.();
          })
        )}
        emptyTemplate={() => (
          uploadFile
            ? renderFileRow(uploadFile, () => {
              // handled by handleFileItemAction
            })
            : (
              <div className="aax-drop-zone">
                <i className="pi pi-headphones aax-drop-icon" />
                <p>AAX-Datei hier ablegen</p>
                <small>oder oben "Auswaehlen" klicken</small>
              </div>
            )
        )}
      />
      <input
        ref={fallbackFileInputRef}
        type="file"
        accept=".aax,audio/vnd.audible.aax"
        style={{ display: 'none' }}
        onChange={(event) => {
          const file = event.target?.files?.[0] || null;
          handleFileSelected(file);
          if (event.target) {
            event.target.value = '';
          }
        }}
      />
    </div>
  );
}
