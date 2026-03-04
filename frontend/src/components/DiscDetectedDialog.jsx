import { Dialog } from 'primereact/dialog';
import { Button } from 'primereact/button';

export default function DiscDetectedDialog({ visible, device, onHide, onAnalyze, busy }) {
  return (
    <Dialog
      header="Neue Disk erkannt"
      visible={visible}
      onHide={onHide}
      style={{ width: '32rem', maxWidth: '96vw' }}
      className="disc-detected-dialog"
      breakpoints={{ '768px': '96vw', '560px': '98vw' }}
      modal
    >
      <p>
        Laufwerk: <strong>{device?.path || 'unbekannt'}</strong>
      </p>
      <p>
        Disk-Label: <strong>{device?.discLabel || 'n/a'}</strong>
      </p>
      <p>
        Laufwerks-Label: <strong>{device?.label || 'n/a'}</strong>
      </p>
      <p>
        Modell: <strong>{device?.model || 'n/a'}</strong>
      </p>

      <div className="dialog-actions">
        <Button label="Schließen" severity="secondary" onClick={onHide} text />
        <Button
          label="Analyse starten"
          icon="pi pi-search"
          onClick={onAnalyze}
          loading={busy}
        />
      </div>
    </Dialog>
  );
}
