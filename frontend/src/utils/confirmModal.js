import { confirmDialog } from 'primereact/confirmdialog';

export function confirmModal(options = {}) {
  const message = String(options?.message || '').trim();
  if (!message) {
    return Promise.resolve(false);
  }

  const header = String(options?.header || 'Bitte bestätigen').trim() || 'Bitte bestätigen';
  const acceptLabel = String(options?.acceptLabel || 'Ja').trim() || 'Ja';
  const rejectLabel = String(options?.rejectLabel || 'Abbrechen').trim() || 'Abbrechen';
  const icon = String(options?.icon || 'pi pi-exclamation-triangle').trim() || 'pi pi-exclamation-triangle';
  const danger = Boolean(options?.danger);
  const style = options?.style && typeof options.style === 'object'
    ? options.style
    : null;
  const breakpoints = options?.breakpoints && typeof options.breakpoints === 'object'
    ? options.breakpoints
    : null;

  return new Promise((resolve) => {
    let finished = false;
    const settle = (value) => {
      if (finished) {
        return;
      }
      finished = true;
      resolve(Boolean(value));
    };

    confirmDialog({
      header,
      message,
      icon,
      closable: true,
      closeOnEscape: true,
      draggable: false,
      dismissableMask: true,
      acceptLabel,
      rejectLabel,
      ...(style ? { style } : {}),
      ...(breakpoints ? { breakpoints } : {}),
      ...(danger ? { acceptClassName: 'p-button-danger' } : {}),
      accept: () => settle(true),
      reject: () => settle(false),
      onHide: () => settle(false)
    });
  });
}
