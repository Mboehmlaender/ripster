import { useState, useEffect } from 'react';
import { Dialog } from 'primereact/dialog';
import { Button } from 'primereact/button';

/**
 * Modal zur Konfliktlösung wenn bereits encodierte Ausgabe-Ordner existieren.
 *
 * Props:
 *  - visible: boolean
 *  - onHide: () => void
 *  - job: object (das Job-Objekt)
 *  - existingFolders: Array<{ id, output_path, label, created_at }>
 *  - onKeepBoth: () => void  – "Beide behalten" geklickt
 *  - onDeleteSelected: (selectedPaths: string[]) => void – "Auswahl löschen & neu encodieren" geklickt
 *  - busy: boolean
 */
export default function ReencodeConflictModal({
  visible = false,
  onHide,
  job,
  existingFolders = [],
  mode = 'reencode',
  onKeepBoth,
  onDeleteSelected,
  busy = false
}) {
  const [checkedPaths, setCheckedPaths] = useState(new Set());
  const isDeleteMode = String(mode || '').trim().toLowerCase() === 'delete';

  // Reset on open
  useEffect(() => {
    if (visible) {
      setCheckedPaths(new Set());
    }
  }, [visible]);

  const togglePath = (p) => {
    setCheckedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(p)) {
        next.delete(p);
      } else {
        next.add(p);
      }
      return next;
    });
  };

  const toggleAll = () => {
    if (checkedPaths.size === existingFolders.length) {
      setCheckedPaths(new Set());
    } else {
      setCheckedPaths(new Set(existingFolders.map((f) => f.output_path)));
    }
  };

  const allChecked = existingFolders.length > 0 && checkedPaths.size === existingFolders.length;
  const someChecked = checkedPaths.size > 0 && !allChecked;
  const noneChecked = checkedPaths.size === 0;

  const title = job?.title || job?.detected_title || `Job #${job?.id || ''}`;

  const handleDeleteSelected = () => {
    const selected = [...checkedPaths];
    onDeleteSelected?.(selected);
  };

  const footer = (
    <div className="reencode-conflict-footer">
      <Button
        label="Abbrechen"
        icon="pi pi-times"
        severity="secondary"
        outlined
        size="small"
        onClick={onHide}
        disabled={busy}
      />
      {!isDeleteMode ? (
        <Button
          label="Beide behalten"
          icon="pi pi-copy"
          severity="info"
          size="small"
          onClick={onKeepBoth}
          loading={busy}
          title="Bestehende Ausgabe belassen – neuer Encode erhält eine Nummerierung (_2, _3 …)"
        />
      ) : null}
      <Button
        label={isDeleteMode
          ? (noneChecked ? 'Alle Ordner löschen' : `${checkedPaths.size} Ordner löschen`)
          : (noneChecked
            ? 'Alle löschen & neu encodieren'
            : `${checkedPaths.size} Ordner löschen & neu encodieren`)}
        icon="pi pi-trash"
        severity="danger"
        size="small"
        onClick={handleDeleteSelected}
        loading={busy}
        disabled={false}
        title={isDeleteMode
          ? (noneChecked
            ? 'Alle bestehenden Ausgabe-Ordner löschen'
            : 'Ausgewählte Ausgabe-Ordner löschen')
          : (noneChecked
            ? 'Alle bestehenden Ausgabe-Ordner löschen, dann neu encodieren'
            : 'Ausgewählte Ausgabe-Ordner löschen, dann neu encodieren')}
      />
    </div>
  );

  return (
    <Dialog
      header={isDeleteMode ? 'Ausgabe-Ordner löschen' : 'Ausgabe bereits vorhanden'}
      visible={visible}
      onHide={onHide}
      style={{ width: '44rem', maxWidth: '96vw' }}
      modal
      footer={footer}
      className="reencode-conflict-modal"
    >
      <p className="reencode-conflict-intro">
        {isDeleteMode ? (
          <>
            Für <strong>{title}</strong> wurden mehrere Ausgabe-Ordner erkannt.
            Welche Ordner sollen gelöscht werden?
          </>
        ) : (
          <>
            Für <strong>{title}</strong> existieren bereits encodierte Dateien.
            Wie soll mit den vorhandenen Ausgabe-Ordnern umgegangen werden?
          </>
        )}
      </p>

      {existingFolders.length > 0 ? (
        <div className="reencode-conflict-folders">
          <div className="reencode-conflict-folders-header">
            <label className="reencode-conflict-check-all">
              <input
                type="checkbox"
                checked={allChecked}
                ref={(el) => { if (el) el.indeterminate = someChecked; }}
                onChange={toggleAll}
              />
              <span>Alle auswählen (zum Löschen)</span>
            </label>
          </div>
          {existingFolders.map((folder) => {
            const p = folder.output_path;
            const checked = checkedPaths.has(p);
            const folderName = p.split(/[/\\]/).filter(Boolean).pop() || p;
            return (
              <label key={p} className={`reencode-conflict-folder-row${checked ? ' is-checked' : ''}`}>
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => togglePath(p)}
                />
                <span className="reencode-conflict-folder-name" title={p}>{folderName}</span>
                {folder.created_at ? (
                  <small className="reencode-conflict-folder-date">
                    {new Date(folder.created_at).toLocaleDateString('de-DE', {
                      day: '2-digit', month: '2-digit', year: 'numeric',
                      hour: '2-digit', minute: '2-digit'
                    })}
                  </small>
                ) : null}
              </label>
            );
          })}
        </div>
      ) : (
        <p className="reencode-conflict-no-folders">
          {isDeleteMode
            ? 'Es wurden keine gespeicherten Ausgabe-Ordner gefunden.'
            : 'Es wurden keine gespeicherten Ausgabe-Ordner gefunden. Der neue Encode wird ggf. automatisch nummeriert.'}
        </p>
      )}

      {!isDeleteMode ? (
        <div className="reencode-conflict-hint">
          <strong>Beide behalten:</strong> Bestehende Ordner bleiben. Neuer Encode erhält eine Nummerierung (_2, _3 …).<br />
          <strong>Löschen &amp; neu encodieren:</strong> Ausgewählte (oder alle) Ordner werden gelöscht.
          Wenn alle gelöscht wurden, erhält der neue Encode keine Nummerierung.
          Wenn nur eine Auswahl gelöscht wurde, setzt die Nummerierung fort.
        </div>
      ) : null}
    </Dialog>
  );
}
