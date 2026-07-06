// The source container's visibility control: a single corner button showing the
// book's current state (Public / Private / Encrypted) that expands into a
// frosted-glass popover to change it. Replaces the old side-by-side
// #privacy-toggle + #encrypt-toggle padlocks. The three states are mutually
// exclusive (Encrypted implies private — the server pins visibility while
// encrypted), so picking one orchestrates whatever transition is needed:
//   • non-encrypted → Public/Private : IDB flip + library upsert
//   • any           → Encrypted      : vault-unlock (if needed) + lockBook
//   • Encrypted     → Private        : publishBook (leaves it private)
//   • Encrypted     → Public         : publishBook, then flip to public
// The heavy lifting is delegated to the existing e2ee lifecycle seams and the
// library-record backend sync — no new content-POST path is introduced.
// Takes the SourceContainerManager as `self`.
import { openDatabase } from '../../indexedDB/index';
import type { LibraryRecord } from '../../indexedDB/types';
import { book } from '../../app';
import { clearEditPermissionCache } from '../../utilities/auth/index';
import { getRecord, PUBLIC_SVG, PRIVATE_SVG, ENCRYPTED_SVG } from './helpers';
import { log } from '../../utilities/logger';
import { trapModalFocus } from '../../utilities/modalFocusTrap';
import { confirmDialog, alertDialog } from '../dialog/dialog';

type VisState = 'public' | 'private' | 'encrypted';

/** A small centred status line appended under the control for lock/publish progress. */
function makeStatusEl(control: HTMLElement): HTMLElement {
  const el = document.createElement('div');
  el.className = 'visibility-encrypt-status';
  el.style.cssText = 'font-size:11px; color: var(--color-label); margin-top:6px; text-align:center;';
  control.appendChild(el);
  return el;
}

const STATE_ICON: Record<VisState, string> = {
  public: PUBLIC_SVG,
  private: PRIVATE_SVG,
  encrypted: ENCRYPTED_SVG,
};
const STATE_LABEL: Record<VisState, string> = {
  public: 'Public',
  private: 'Private',
  encrypted: 'Encrypt',
};

const CHECK_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>`;

const LOG_PATH = '/components/sourceContainer/visibilityControl.ts';

// ── Per-transition confirm copy ────────────────────────────────────────────
// Keyed by `${from}->${to}`. An entry means that transition shows a warning
// dialog first; no entry means it happens silently. Edit the strings freely.
// (message strings with an apostrophe must stay double-quoted.)
const ENCRYPT_COPY = {
  title: 'Encrypt this book?',
  message: "It will be removed from sitewide search (in-book search still works), and unreadable without your passkey or recovery code.",
  confirmLabel: 'Encrypt',
};
const TRANSITION_CONFIRMS: Record<string, { title: string; message: string; confirmLabel?: string; danger?: boolean }> = {
  'private->public': {
    title: 'Make this book public?',
    message: 'Let the world read your hypertext literature.',
    confirmLabel: 'Make public',
    danger: true,
  },
  'public->private': {
    title: 'Make this book private?',
    message: 'Anyone with the link will lose access. Only you will be able to read it.',
    confirmLabel: 'Make private',
  },
  'public->encrypted': ENCRYPT_COPY,
  'private->encrypted': ENCRYPT_COPY,
  'encrypted->public': {
    title: 'Publish this book?',
    message: "Let the world read your hypertext literature.",
    confirmLabel: 'Publish',
    danger: true,
  },
  'encrypted->private': {
    title: 'Decrypt this book?',
    message: "Your book will remain private. Only you will be able to pull the text nodes from the database. However, the text content in the database will be readable by the system admin.",
    confirmLabel: 'Decrypt',
    danger: true,
  },
};

/** Current UI state from the library record. Encrypted wins; else by visibility. */
export function deriveVisibilityState(record: any): VisState {
  if ((record as { encrypted?: boolean } | null)?.encrypted === true) return 'encrypted';
  return record?.visibility === 'public' ? 'public' : 'private';
}

/**
 * Build the corner control + hidden glass popover. Guarded like the old toggles
 * (owner, has record, not access-denied). Sub-books can't be encrypted
 * independently (they inherit the root), so their control is a plain
 * Public/Private picker keyed off visibility — matching the old behaviour.
 */
export function buildVisibilityControlHtml(record: any, canEdit: boolean, accessDenied: boolean): string {
  if (!(canEdit && !accessDenied && record)) return '';

  const isSubBook = String(record.book ?? '').includes('/');
  const state: VisState = isSubBook
    ? (record?.visibility === 'public' ? 'public' : 'private')
    : deriveVisibilityState(record);
  const targets: VisState[] = isSubBook ? ['public', 'private'] : ['public', 'private', 'encrypted'];

  const rows = targets.map((t) => `
      <button type="button" class="visibility-option${t === state ? ' active' : ''}" data-target="${t}">
        <span class="visibility-option-icon">${STATE_ICON[t]}</span>
        <span class="visibility-option-label">${STATE_LABEL[t]}</span>
        <span class="visibility-option-check">${CHECK_SVG}</span>
      </button>`).join('');

  return `
    <div id="visibility-control" class="visibility-control" data-state="${state}" style="position: absolute; top: 10px; right: 10px; z-index: 1002;">
      <button type="button" class="visibility-trigger" aria-haspopup="true" aria-expanded="false" title="Visibility: ${STATE_LABEL[state]} — click to change">
        <span class="visibility-trigger-icon">${STATE_ICON[state]}</span>
        <svg class="visibility-chevron" xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>
      </button>
      <div class="visibility-panel" style="display: none;">${rows}
      </div>
    </div>`;
}

/** Wire the trigger (expand/collapse) and the option rows. Idempotent guard. */
export function attachVisibilityControlListeners(self: any) {
  const control = self.container.querySelector('#visibility-control');
  if (!control || control._listenerAttached) return;
  control._listenerAttached = true;

  const trigger = control.querySelector('.visibility-trigger');
  const panel = control.querySelector('.visibility-panel');
  if (!trigger || !panel) return;

  // While a confirm/transition is in flight (vis-busy), keep the panel open so
  // the row spinner stays visible and a styled-dialog click doesn't collapse it.
  const onOutside = (e: any) => { if (control.classList.contains('vis-busy')) return; if (!control.contains(e.target)) closePanel(); };
  // NB: class is 'vis-open', NOT 'open' — a global bare `.open` button rule
  // (hyperlitEditButton.css) forces width/height:36px on anything class="open".
  let overlay: HTMLElement | null = null;
  let releaseTrap: (() => void) | null = null;
  function closePanel() {
    panel.style.display = 'none';
    control.classList.remove('vis-open');
    trigger.setAttribute('aria-expanded', 'false');
    overlay?.remove();
    overlay = null;
    releaseTrap?.();
    releaseTrap = null;
    document.removeEventListener('click', onOutside, true);
  }
  function openPanel() {
    panel.style.display = 'block';
    control.classList.add('vis-open');
    trigger.setAttribute('aria-expanded', 'true');
    // Frosted glass over the container content — the panel/trigger sit above it,
    // and a click on the frosted area closes the panel (blocks click-through to
    // links beneath). Kept out of the busy path so a spinning transition stays lit.
    overlay = document.createElement('div');
    overlay.className = 'visibility-overlay';
    overlay.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!control.classList.contains('vis-busy')) closePanel();
    });
    self.container.appendChild(overlay);
    document.addEventListener('click', onOutside, true);
    // Keyboard: trap Tab within the trigger+panel cluster while open — it
    // stacks ABOVE the source-container's own trap (modalState), so Escape
    // closes just the panel, not the whole container. Busy-guard preserved.
    releaseTrap = trapModalFocus(control, {
      onEscape: () => { if (!control.classList.contains('vis-busy')) closePanel(); },
    });
  }
  // Let the orchestrator collapse the panel after a successful change.
  control._closePanel = closePanel;

  trigger.addEventListener('click', (e: any) => {
    e.preventDefault();
    e.stopPropagation();
    if (control.classList.contains('vis-busy')) return;
    if (control.classList.contains('vis-open')) closePanel(); else openPanel();
  });

  panel.querySelectorAll('.visibility-option').forEach((opt: any) => {
    opt.addEventListener('click', (e: any) => {
      e.preventDefault();
      e.stopPropagation();
      if (control.classList.contains('vis-busy')) return;
      applyVisibilityState(self, opt.dataset.target as VisState, opt);
    });
  });
}

/** Persist a plain visibility flip (public/private) to IDB + backend. */
async function setVisibility(self: any, newVisibility: 'public' | 'private') {
  const db = await openDatabase();
  const record: LibraryRecord | null = await getRecord(db, 'library', book);
  if (!record) throw new Error('Library record not found.');

  record.visibility = newVisibility;
  // Keep raw_json in sync with top-level visibility (deprecated denormalized copy).
  if (record.raw_json && typeof record.raw_json === 'object') {
    (record.raw_json as { visibility?: string }).visibility = newVisibility;
  }

  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('library', 'readwrite');
    const req = tx.objectStore('library').put(record);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });

  await self.syncLibraryRecordToBackend(record);
}

/** Re-paint the trigger icon/title and the option rows' active markers. */
function renderControlState(control: any, state: VisState) {
  const triggerIcon = control.querySelector('.visibility-trigger-icon');
  if (triggerIcon) triggerIcon.innerHTML = STATE_ICON[state];
  control.querySelector('.visibility-trigger')?.setAttribute('title', `Visibility: ${STATE_LABEL[state]} — click to change`);
  control.querySelectorAll('.visibility-option').forEach((o: any) => {
    const t = o.dataset.target as VisState;
    const icon = o.querySelector('.visibility-option-icon');
    if (icon) icon.innerHTML = STATE_ICON[t];
    o.classList.toggle('active', t === state);
  });
}

/**
 * Run the transition from the current state to `target`, showing a spinner on the
 * clicked row until it resolves. Confirms exposure-increasing / one-way changes.
 */
export async function applyVisibilityState(self: any, target: VisState, optEl?: any) {
  const control = self.container.querySelector('#visibility-control');
  if (!control) return;

  const current = (control.dataset.state as VisState) || 'private';
  if (target === current) { control._closePanel?.(); return; }
  if (control.classList.contains('vis-busy')) return;

  const wasEncrypted = current === 'encrypted';

  const option = optEl || control.querySelector(`.visibility-option[data-target="${target}"]`);
  const iconSpan = option?.querySelector('.visibility-option-icon');
  const prevIcon = iconSpan?.innerHTML;
  let started = false;

  // Mark busy up front so the confirm dialog (which lives outside the control)
  // can't trip the outside-click / Escape handlers that would close the panel.
  control.classList.add('vis-busy');

  try {
    // Warn on the transition if the table has copy for it (see TRANSITION_CONFIRMS).
    const confirmCopy = TRANSITION_CONFIRMS[`${current}->${target}`];
    if (confirmCopy && !(await confirmDialog(confirmCopy))) return;

    // Confirmed → spin the chosen row and lock the options.
    started = true;
    if (iconSpan) iconSpan.innerHTML = '<span class="btn-spinner"></span>';
    control.querySelectorAll('.visibility-option').forEach((o: any) => { o.disabled = true; });

    if (target === 'encrypted') {
      await ensureVaultUnlocked();
      const { lockBook } = await import('../../e2ee/lifecycle');
      // Show per-part progress — a footnote-heavy book is a large tree and the
      // lock/publish takes a while; a frozen dialog reads as a hang.
      const statusEl = makeStatusEl(control);
      try {
        await lockBook(String(book), (msg) => { statusEl.textContent = msg; });
      } finally {
        statusEl.remove();
      }
    } else if (wasEncrypted) {
      // Publishing decrypts the ciphertext locally before re-pushing plaintext,
      // so it needs the vault unlocked too — prompt just like the lock path.
      await ensureVaultUnlocked();
      const { publishBook } = await import('../../e2ee/lifecycle');
      const statusEl = makeStatusEl(control);
      try {
        await publishBook(String(book), (msg) => { statusEl.textContent = msg; }); // decrypts; leaves it private
      } finally {
        statusEl.remove();
      }
      if (target === 'public') await setVisibility(self, 'public');
    } else {
      // Repair-on-click: a lingering wrapped DEK on a flag-off book means an
      // unfinished publish (some image bytes still ciphertext → broken imgs).
      // Finish the decrypt as part of ANY visibility change so the owner's own
      // click fixes the book instead of silently flipping a flag.
      const { hasIncompletePublish } = await import('../../e2ee/lifecycle');
      if (await hasIncompletePublish(String(book))) {
        await ensureVaultUnlocked();
        const { finishIncompletePublish } = await import('../../e2ee/lifecycle');
        const statusEl = makeStatusEl(control);
        try {
          await finishIncompletePublish(String(book), (msg) => { statusEl.textContent = msg; });
        } finally {
          statusEl.remove();
        }
      }
      await setVisibility(self, target);
    }

    control.dataset.state = target;
    clearEditPermissionCache(book);
    renderControlState(control, target);
    control._closePanel?.();
    log.user(`Book visibility changed to ${target}`, LOG_PATH);

    // Confirmation only for the slow / significant E2EE transitions.
    if (target === 'encrypted') {
      await alertDialog({ title: 'Encrypted', message: 'This book is now end-to-end encrypted and private.' });
    } else if (wasEncrypted) {
      await alertDialog({
        title: target === 'public' ? 'Published' : 'Decrypted',
        message: target === 'public'
          ? 'This book is decrypted on the server and anyone can read it now.'
          : 'This book is decrypted on the server but still private. You can re-encrypt it later.',
      });
    }
  } catch (error: any) {
    if (started && iconSpan) iconSpan.innerHTML = prevIcon;
    log.error('Visibility change failed', LOG_PATH, error);
    await alertDialog({
      title: "Couldn't change visibility",
      message: (error?.name === 'PasskeyError' || /passkey|vault/i.test(String(error?.message)))
        ? error.message
        : (error?.message ?? 'Unknown error'),
    });
  } finally {
    control.classList.remove('vis-busy');
    control.querySelectorAll('.visibility-option').forEach((o: any) => { o.disabled = false; });
  }
}

/** Prompt the passkey unlock modal if the vault is locked (both lock & publish need it). */
async function ensureVaultUnlocked(): Promise<void> {
  const { isVaultUnlocked } = await import('../../e2ee/keys');
  if (await isVaultUnlocked()) return;
  const { showUnlockModal } = await import('../../e2ee/ui/unlockModal');
  await showUnlockModal(); // throws if dismissed / no vault yet
}
