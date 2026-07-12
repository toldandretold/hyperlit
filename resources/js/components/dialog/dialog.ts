// App-styled modal dialogs (glass theme) that replace the native browser
// confirm()/alert() white popups. Promise-based, created on demand, appended to
// <body>, no registry entry (same pattern as e2ee/ui/unlockModal). Escape =
// cancel, Enter = confirm; the confirm button is focused on open. Keyboard
// focus is trapped inside the dialog via utilities/modalFocusTrap (Tab cycles
// the buttons, focus restored to the opener on close).
//
//   if (await confirmDialog({ message: 'Delete?', danger: true })) { ... }
//   await alertDialog({ message: 'Done.' });

import { trapModalFocus } from '../../utilities/modalFocusTrap';

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

interface ChoiceOption {
  /** Returned by choiceDialog when this option is picked. */
  value: string;
  label: string;
  /** Optional second line under the label. */
  description?: string;
}

interface ChoiceOptions {
  title?: string;
  message?: string;
  options: ChoiceOption[];
  cancelLabel?: string;
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
// pre-line: messages may carry \n\n paragraph breaks (they're escaped text,
// so this is the only way callers can shape longer copy).
const MSG_CSS = 'margin: 0 0 18px; font-size: 14px; line-height: 1.55; color: var(--color-text, #CBCCCC); white-space: pre-line;';
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

/**
 * Message body renderer: escape EVERYTHING first (the XSS posture — raw HTML
 * in messages renders as literal text), then allow exactly one bit of
 * typography on the escaped result: *asterisk spans* become <em>italics</em>.
 */
function renderMessage(s: string): string {
  return escapeHtml(s).replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
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
        <p style="${MSG_CSS}">${renderMessage(opts.message)}</p>
        <div style="${ROW_CSS}">
          <button type="button" data-act="cancel" style="${CANCEL_CSS}">${escapeHtml(opts.cancelLabel ?? 'Cancel')}</button>
          <button type="button" data-act="confirm" style="${confirmCss(opts.danger)}">${escapeHtml(opts.confirmLabel ?? 'Confirm')}</button>
        </div>
      </div>`;

    let release: (() => void) | null = null;
    const done = (result: boolean) => {
      document.removeEventListener('keydown', onKey, true);
      release?.(); // restores focus to the opener
      release = null;
      overlay.remove();
      resolve(result);
    };
    // Enter = confirm (Escape is owned by the focus trap → done(false)).
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); done(true); }
    };

    overlay.addEventListener('click', (e) => {
      const act = (e.target as HTMLElement).closest('[data-act]')?.getAttribute('data-act');
      if (act === 'confirm') done(true);
      else if (act === 'cancel' || e.target === overlay) done(false);
    });
    document.addEventListener('keydown', onKey, true);

    document.body.appendChild(overlay);
    release = trapModalFocus(overlay, { onEscape: () => done(false) });
    // The trap seats the first focusable (cancel); the designed default is confirm.
    (overlay.querySelector('[data-act="confirm"]') as HTMLElement | null)?.focus();
  });
}

/**
 * A single-choice picker in the same trapped dialog shell: a title, optional
 * message, and a vertical list of full-width option buttons. Resolves the
 * chosen option's `value`, or null on cancel/escape/backdrop. Reuses the
 * `app-dialog-overlay` surface (already focus-trapped + inventoried).
 */
export function choiceDialog(opts: ChoiceOptions): Promise<string | null> {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'app-dialog-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.style.cssText = OVERLAY_CSS;

    const optionCss =
      'display: block; width: 100%; text-align: left; box-sizing: border-box; margin: 0 0 8px; padding: 11px 14px; ' +
      'border-radius: 8px; cursor: pointer; font-family: inherit; ' +
      'background: rgba(255,255,255,0.04); color: var(--color-text, #CBCCCC); ' +
      'border: 1px solid var(--border-button, rgba(203,204,204,0.3));';

    const optionsHtml = opts.options.map((o, i) => `
        <button type="button" data-choice="${i}" style="${optionCss}">
          <span style="display:block; font-size: 14px; font-weight: 600; color: var(--hyperlit-aqua, #4EACAE);">${escapeHtml(o.label)}</span>
          ${o.description ? `<span style="display:block; margin-top: 3px; font-size: 12px; line-height: 1.45; color: var(--color-text-faint, #999);">${escapeHtml(o.description)}</span>` : ''}
        </button>`).join('');

    overlay.innerHTML = `
      <div class="app-dialog-card" style="${CARD_CSS} max-width: 460px;">
        ${opts.title ? `<h3 style="${TITLE_CSS}">${escapeHtml(opts.title)}</h3>` : ''}
        ${opts.message ? `<p style="${MSG_CSS}">${renderMessage(opts.message)}</p>` : ''}
        <div>${optionsHtml}</div>
        <div style="${ROW_CSS} margin-top: 4px;">
          <button type="button" data-act="cancel" style="${CANCEL_CSS}">${escapeHtml(opts.cancelLabel ?? 'Cancel')}</button>
        </div>
      </div>`;

    let release: (() => void) | null = null;
    const done = (value: string | null) => {
      release?.();
      release = null;
      overlay.remove();
      resolve(value);
    };

    overlay.addEventListener('click', (e) => {
      const choiceEl = (e.target as HTMLElement).closest('[data-choice]');
      if (choiceEl) {
        const idx = Number(choiceEl.getAttribute('data-choice'));
        done(opts.options[idx]?.value ?? null);
        return;
      }
      const act = (e.target as HTMLElement).closest('[data-act]')?.getAttribute('data-act');
      if (act === 'cancel' || e.target === overlay) done(null);
    });

    document.body.appendChild(overlay);
    release = trapModalFocus(overlay, { onEscape: () => done(null) });
  });
}

interface FormRadioOption {
  value: string;
  label: string;
  description?: string;
}

interface FormDialogOptions {
  title?: string;
  message?: string;
  /** A single radio group; the picked value comes back as `radio`. */
  radios?: { options: FormRadioOption[]; selected?: string };
  /** An optional numeric input; its raw string comes back as `number`. */
  numberField?: { label: string; prefix?: string; value?: string; placeholder?: string; hint?: string };
  confirmLabel?: string;
  cancelLabel?: string;
}

export interface FormDialogResult {
  radio: string | null;
  number: string;
}

/**
 * A form in the same trapped dialog shell: a radio group and/or a numeric
 * field, with confirm/cancel. Resolves { radio, number } on confirm, or null on
 * cancel/escape/backdrop. Reuses the `app-dialog-overlay` surface (already
 * focus-trapped + inventoried) so it adds no new overlay to the drift gate.
 */
export function formDialog(opts: FormDialogOptions): Promise<FormDialogResult | null> {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'app-dialog-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.style.cssText = OVERLAY_CSS;

    const radioRowCss =
      'display: flex; align-items: flex-start; gap: 9px; width: 100%; box-sizing: border-box; margin: 0 0 7px; padding: 10px 12px; ' +
      'border-radius: 8px; cursor: pointer; background: rgba(255,255,255,0.04); ' +
      'border: 1px solid var(--border-button, rgba(203,204,204,0.3));';
    const sel = opts.radios?.selected ?? opts.radios?.options[0]?.value;
    const radiosHtml = opts.radios ? opts.radios.options.map((o) => `
        <label style="${radioRowCss}">
          <input type="radio" name="fd-radio" value="${escapeHtml(o.value)}" ${o.value === sel ? 'checked' : ''} style="margin-top: 2px; accent-color: var(--hyperlit-aqua, #4EACAE);">
          <span style="display:block;">
            <span style="display:block; font-size: 14px; font-weight: 600; color: var(--hyperlit-aqua, #4EACAE);">${escapeHtml(o.label)}</span>
            ${o.description ? `<span style="display:block; margin-top: 2px; font-size: 12px; line-height: 1.45; color: var(--color-text-faint, #999);">${escapeHtml(o.description)}</span>` : ''}
          </span>
        </label>`).join('') : '';

    const nf = opts.numberField;
    const numberHtml = nf ? `
        <label for="fd-number" style="display:block; margin: 12px 0 5px; font-size: 13px; color: var(--color-text, #CBCCCC);">${escapeHtml(nf.label)}</label>
        <div style="display:flex; align-items:center; gap:6px;">
          ${nf.prefix ? `<span style="font-size:14px; color: var(--color-text-faint,#999);">${escapeHtml(nf.prefix)}</span>` : ''}
          <input type="number" id="fd-number" min="0" step="0.01" value="${escapeHtml(nf.value ?? '')}" placeholder="${escapeHtml(nf.placeholder ?? '')}"
            style="flex:1; min-width:0; box-sizing:border-box; padding: 8px 10px; border-radius: 6px; font-family: inherit; font-size: 13px; background: rgba(255,255,255,0.04); color: var(--color-text, #CBCCCC); border: 1px solid var(--border-button, rgba(203,204,204,0.3));">
        </div>
        ${nf.hint ? `<p style="margin: 6px 0 0; font-size: 11px; line-height: 1.45; color: var(--color-text-faint, #999);">${escapeHtml(nf.hint)}</p>` : ''}` : '';

    overlay.innerHTML = `
      <div class="app-dialog-card" style="${CARD_CSS} max-width: 460px;">
        ${opts.title ? `<h3 style="${TITLE_CSS}">${escapeHtml(opts.title)}</h3>` : ''}
        ${opts.message ? `<p style="${MSG_CSS}">${renderMessage(opts.message)}</p>` : ''}
        <div>${radiosHtml}</div>
        ${numberHtml}
        <div style="${ROW_CSS} margin-top: 16px;">
          <button type="button" data-act="cancel" style="${CANCEL_CSS}">${escapeHtml(opts.cancelLabel ?? 'Cancel')}</button>
          <button type="button" data-act="confirm" style="${confirmCss(false)}">${escapeHtml(opts.confirmLabel ?? 'Start')}</button>
        </div>
      </div>`;

    let release: (() => void) | null = null;
    const collect = (): FormDialogResult => ({
      radio: (overlay.querySelector('input[name="fd-radio"]:checked') as HTMLInputElement | null)?.value ?? null,
      number: (overlay.querySelector('#fd-number') as HTMLInputElement | null)?.value ?? '',
    });
    const done = (result: FormDialogResult | null) => {
      document.removeEventListener('keydown', onKey, true);
      release?.();
      release = null;
      overlay.remove();
      resolve(result);
    };
    // Enter = confirm (Escape is owned by the focus trap → done(null)).
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); done(collect()); }
    };

    overlay.addEventListener('click', (e) => {
      const act = (e.target as HTMLElement).closest('[data-act]')?.getAttribute('data-act');
      if (act === 'confirm') done(collect());
      else if (act === 'cancel' || e.target === overlay) done(null);
    });
    document.addEventListener('keydown', onKey, true);

    document.body.appendChild(overlay);
    release = trapModalFocus(overlay, { onEscape: () => done(null) });
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
        <p style="${MSG_CSS}">${renderMessage(opts.message)}</p>
        <div style="${ROW_CSS}">
          <button type="button" data-act="ok" style="${confirmCss(false)}">${escapeHtml(opts.okLabel ?? 'OK')}</button>
        </div>
      </div>`;

    let release: (() => void) | null = null;
    const done = () => {
      document.removeEventListener('keydown', onKey, true);
      release?.(); // restores focus to the opener
      release = null;
      overlay.remove();
      resolve();
    };
    // Enter = dismiss (Escape is owned by the focus trap).
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); done(); }
    };

    overlay.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('[data-act="ok"]') || e.target === overlay) done();
    });
    document.addEventListener('keydown', onKey, true);

    document.body.appendChild(overlay);
    release = trapModalFocus(overlay, { onEscape: done });
  });
}
