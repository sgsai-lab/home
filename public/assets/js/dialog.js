// Sheet dialogs for the hub pages, built on the native <dialog> element.
import { h } from '/assets/js/auth.js';

const FOCUSABLE = 'input:not([type="hidden"]):not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled]):not([data-dialog-close])';

/** Opens a sheet and resolves with its returnValue once it closes. Focus returns to the opener. */
export function openDialog(dialog, { initialFocus } = {}) {
  const opener = document.activeElement;
  if (!dialog.open) dialog.showModal();
  (initialFocus ?? dialog.querySelector('[autofocus]') ?? dialog.querySelector(FOCUSABLE))?.focus();
  return new Promise((resolve) => {
    dialog.addEventListener('close', () => {
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus({ preventScroll: true });
      resolve(dialog.returnValue);
    }, { once: true });
  });
}

export function closeDialog(dialog, value = '') {
  if (dialog.open) dialog.close(value);
}

/** Wires close buttons and backdrop clicks for every <dialog class="sheet"> under root. */
export function setupDialogs(root = document) {
  for (const dialog of root.querySelectorAll('dialog.sheet')) {
    dialog.addEventListener('click', (event) => {
      // The sheet itself has no padding, so a click on the element is a click on the backdrop.
      if (event.target === dialog) dialog.close('dismiss');
    });
    dialog.querySelectorAll('[data-dialog-close]').forEach((button) => {
      button.addEventListener('click', () => dialog.close('dismiss'));
    });
  }
}

/** Accessible replacement for window.confirm. Resolves true when the user confirms. */
export async function confirmDialog({ title, message, confirmLabel = 'Confirm', cancelLabel = 'Cancel', danger = false }) {
  const id = `confirm-${Math.random().toString(36).slice(2, 8)}`;
  const confirm = h('button', { type: 'button', className: `button ${danger ? 'button-danger' : 'button-primary'}`, text: confirmLabel });
  const cancel = h('button', { type: 'button', className: 'button button-secondary', text: cancelLabel });
  const dialog = h('dialog', { className: 'sheet sheet-compact', 'aria-labelledby': `${id}-title`, 'aria-describedby': `${id}-message` },
    h('div', { className: 'sheet-inner' },
      h('div', { className: 'sheet-body' },
        h('h2', { id: `${id}-title`, className: 'sheet-title', text: title }),
        h('p', { id: `${id}-message`, className: 'hint', text: message })),
      h('div', { className: 'sheet-actions' }, cancel, confirm)));
  confirm.addEventListener('click', () => dialog.close('confirm'));
  cancel.addEventListener('click', () => dialog.close('cancel'));
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dialog.close('cancel');
  });
  document.body.append(dialog);
  const result = await openDialog(dialog, { initialFocus: cancel });
  dialog.remove();
  return result === 'confirm';
}
