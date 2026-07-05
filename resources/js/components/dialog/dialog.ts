// App-styled modal dialogs (glass theme) that replace the native browser
// confirm()/alert() white popups. Promise-based, created on demand, appended to
// <body>, no registry entry (same pattern as e2ee/ui/unlockModal). Escape =
// cancel, Enter = confirm; the confirm button is focused on open.
//
//   if (await confirmDialog({ message: 'Delete?', danger: true })) { ... }
//   await alertDialog({ message: 'Done.' });

interface ConfirmOptions {
  title?: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Red confirm button for exposure-increasing / destructive actions. */
  danger?: boolean;
}

interface AlertOptions {
  title?: string;
  message: string;
  okLabel?: string;
}

const OVERLAY_CSS =
  'position: fixed; inset: 0; z-index: 10000; display: flex; align-items: center; justify-content: center; padding: 20px; ' +
  'background: rgba(0,0,0,0.5); -webkit-backdrop-filter: blur(2px); backdrop-filter: blur(2px);';

const CARD_CSS =
  'max-width: 400px; width: 100%; box-sizing: border-box; padding: 20px 22px; border-radius: 12px; ' +
  'background-color: var(--container-glass-bg, #221F20); -webkit-backdrop-filter: var(--container-glass-blur, blur(7px)); backdrop-filter: var(--container-glass-blur, blur(7px)); ' +
  'border: 1px solid var(--border-subtle, rgba(203,204,204,0.15)); box-shadow: 0 8px 30px rgba(0,0,0,0.5); ' +
  'color: var(--color-text, #CBCCCC); font-family: inherit;';

const TITLE_CSS = 'margin: 0 0 8px; font-size: 15px; font-weight: 600; color: var(--color-text, #CBCCCC);';
const MSG_CSS = 'margin: 0 0 18px; font-size: 14px; line-height: 1.55; color: var(--color-text, #CBCCCC);';
const ROW_CSS = 'display: flex; gap: 10px; justify-content: flex-end;';
const BTN_BASE =
  'padding: 8px 16px; border-radius: 6px; cursor: pointer; font-family: inherit; font-size: 13px; box-sizing: border-box;';
const CANCEL_CSS =
  BTN_BASE + ' background: transparent; color: var(--color-text, #CBCCCC); border: 1px solid var(--border-button, rgba(203,204,204,0.3));';
const confirmCss = (danger?: boolean) =>
  BTN_BASE +
  ' border: none; font-weight: 600;' +
  (danger
    ? ' background: var(--color-danger, #d73a49); color: #fff;'
    : ' background: var(--hyperlit-aqua, #4EACAE); color: var(--color-background, #221F20);');

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Styled replacement for window.confirm — resolves true (confirm) / false (cancel/escape). */
export function confirmDialog(opts: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'app-dialog-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.style.cssText = OVERLAY_CSS;
    overlay.innerHTML = `
      <div class="app-dialog-card" style="${CARD_CSS}">
        ${opts.title ? `<h3 style="${TITLE_CSS}">${escapeHtml(opts.title)}</h3>` : ''}
        <p style="${MSG_CSS}">${escapeHtml(opts.message)}</p>
        <div style="${ROW_CSS}">
          <button type="button" data-act="cancel" style="${CANCEL_CSS}">${escapeHtml(opts.cancelLabel ?? 'Cancel')}</button>
          <button type="button" data-act="confirm" style="${confirmCss(opts.danger)}">${escapeHtml(opts.confirmLabel ?? 'Confirm')}</button>
        </div>
      </div>`;

    const done = (result: boolean) => {
      document.removeEventListener('keydown', onKey, true);
      overlay.remove();
      resolve(result);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(false); }
      else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); done(true); }
    };

    overlay.addEventListener('click', (e) => {
      const act = (e.target as HTMLElement).closest('[data-act]')?.getAttribute('data-act');
      if (act === 'confirm') done(true);
      else if (act === 'cancel' || e.target === overlay) done(false);
    });
    document.addEventListener('keydown', onKey, true);

    document.body.appendChild(overlay);
    (overlay.querySelector('[data-act="confirm"]') as HTMLElement | null)?.focus();
  });
}

/** Styled replacement for window.alert — resolves when dismissed. */
export function alertDialog(opts: AlertOptions): Promise<void> {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'app-dialog-overlay';
    overlay.setAttribute('role', 'alertdialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.style.cssText = OVERLAY_CSS;
    overlay.innerHTML = `
      <div class="app-dialog-card" style="${CARD_CSS}">
        ${opts.title ? `<h3 style="${TITLE_CSS}">${escapeHtml(opts.title)}</h3>` : ''}
        <p style="${MSG_CSS}">${escapeHtml(opts.message)}</p>
        <div style="${ROW_CSS}">
          <button type="button" data-act="ok" style="${confirmCss(false)}">${escapeHtml(opts.okLabel ?? 'OK')}</button>
        </div>
      </div>`;

    const done = () => {
      document.removeEventListener('keydown', onKey, true);
      overlay.remove();
      resolve();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' || e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); done(); }
    };

    overlay.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('[data-act="ok"]') || e.target === overlay) done();
    });
    document.addEventListener('keydown', onKey, true);

    document.body.appendChild(overlay);
    (overlay.querySelector('[data-act="ok"]') as HTMLElement | null)?.focus();
  });
}
