// Book URL section (#book-url-section) inside Creator Tools: shows the book's
// public address — /{slug} when one is set, the raw /{bookId} otherwise — and
// lets the creator claim a slug ONCE. The server enforces set-once (a slug has
// no history and no redirect, so changing one kills every external link);
// this UI just mirrors that: slugged books get a read-only display, slug-less
// books get an input prefilled with the server's collision-free suggestion.
// Setting a slug never breaks the old /{bookId} URL — id resolution wins.
import { book } from '../../../app';
import { confirmDialog } from '../../dialog/dialog';
import { log } from '../../../utilities/logger';

interface SlugInfo {
  success: boolean;
  slug: string | null;
  encrypted: boolean;
  canSet: boolean;
  suggestion: string | null;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const URL_CSS = 'font-size: var(--sc-13); color: var(--color-text-secondary); margin: 0; word-break: break-all;';
const LABEL_CSS = 'font-size: var(--sc-11); color: var(--color-text-faint); margin: 0 0 2px 0;';
const NOTE_CSS = 'font-size: var(--sc-11); color: var(--color-text-faint); margin-top: 6px;';

/** Client mirror of SlugRules::FORMAT — pre-screens before the live server probe. */
const SLUG_FORMAT = /^[a-z0-9][a-z0-9-]{1,58}[a-z0-9]$/;
const SLUG_FORMAT_MESSAGE = '3–60 characters: lowercase letters, numbers and hyphens, no leading/trailing hyphen';
const CHECK_DEBOUNCE_MS = 500;

/** The one normalization applied before checking and before submitting. */
function normalizeSlug(raw: string): string {
  return raw.replace(/[\r\n]+/g, '').trim().toLowerCase();
}

export async function loadSlugSection(self: any) {
  const section = self.container.querySelector('#book-url-section');
  if (!section) return;

  let info: SlugInfo;
  try {
    const resp = await fetch(`/api/db/library/slug-info?book=${encodeURIComponent(book)}`, {
      credentials: 'include',
    });
    info = await resp.json(); // always read — an unconsumed body leaks the connection
    if (!resp.ok || !info?.success) return; // leave the section hidden
  } catch (e) {
    log.error('Could not load book URL info:', e);
    return;
  }

  render(section, info);
}

function render(section: HTMLElement, info: SlugInfo) {
  section.style.display = '';

  const path = info.slug ?? book;
  const url = `${window.location.origin}/${path}`;

  // The URL is selectable text and a real link — no copy button needed.
  const urlLine = `
      <p style="${URL_CSS}">
        <a href="/${escapeHtml(path)}" style="color: inherit;">${escapeHtml(url)}</a>
      </p>`;

  if (info.slug !== null) {
    section.innerHTML = `
      <h3>Book URL</h3>
      ${urlLine}
      <p style="${NOTE_CSS}">This address is permanent and can't be changed.</p>`;
  } else if (info.encrypted) {
    section.innerHTML = `
      <h3>Book URL</h3>
      ${urlLine}
      <p style="${NOTE_CSS}">Encrypted books can't have a custom URL — publish the book first.</p>`;
  } else {
    // Stacked rows: the raw book-id URL and the proposed slug are both long,
    // so each gets the full panel width — the slug field is a one-line-looking
    // textarea that grows taller as the text wraps, and the button sits below.
    section.innerHTML = `
      <h3>Book URL</h3>
      <p style="${LABEL_CSS}">Current:</p>
      ${urlLine}
      <p style="${LABEL_CSS} margin-top: 8px;">Change to:</p>
      <p style="${URL_CSS} margin-bottom: 2px;">${escapeHtml(window.location.origin)}/</p>
      <textarea id="book-url-slug-input" rows="1" placeholder="your-book-title" maxlength="60" autocomplete="off" spellcheck="false" style="display: block; width: 100%; box-sizing: border-box; padding: 6px 8px; font-size: var(--sc-13); font-family: inherit; line-height: 1.4; resize: none; overflow: hidden; word-break: break-all;">${escapeHtml(info.suggestion ?? '')}</textarea>
      <p id="book-url-check" class="validation-message" style="display: none; margin-top: 4px;"></p>
      <button type="button" id="book-url-set-btn" style="display: block; width: 100%; margin-top: 6px; padding: 6px 12px; font-size: var(--sc-13); color: var(--hyperlit-orange); border: 1px solid rgba(239,141,52,0.4); background: transparent; border-radius: 4px; cursor: pointer;">Set URL</button>
      <p id="book-url-status" style="font-size: var(--sc-12); color: var(--color-danger); margin-top: 6px; display: none;"></p>
      <p style="${NOTE_CSS}">Claim a readable address for sharing and search engines. One-time: once set, it can never be changed. Your current link keeps working.</p>`;
  }

  wire(section, info);
}

function wire(section: HTMLElement, info: SlugInfo) {
  const setBtn = section.querySelector('#book-url-set-btn') as HTMLButtonElement | null;
  const input = section.querySelector('#book-url-slug-input') as HTMLTextAreaElement | null;
  if (!setBtn || !input) return;

  // One-line-looking textarea that grows with its wrapped content.
  const autoGrow = () => {
    input.style.height = 'auto';
    input.style.height = `${input.scrollHeight}px`;
  };
  autoGrow();

  // Live availability check (the slug counterpart of the cite-form's book-id
  // probe): local format screen first, then a debounced server check through
  // the REAL SlugRules gauntlet — reserved routes/usernames, username
  // impersonation, book-id and slug collisions — so the inline verdict is
  // exactly what Set URL would say. A sequence counter drops stale responses
  // (debounced fetches can resolve out of order).
  const check = section.querySelector('#book-url-check') as HTMLElement;
  let checkTimer: ReturnType<typeof setTimeout> | undefined;
  let checkSeq = 0;
  const showCheck = (ok: boolean, msg: string) => {
    check.textContent = msg;
    check.className = `validation-message ${ok ? 'success' : 'error'}`;
    check.style.display = '';
  };
  const runCheck = async (slug: string) => {
    const seq = ++checkSeq;
    try {
      const resp = await fetch(
        `/api/db/library/slug-check?slug=${encodeURIComponent(slug)}&book=${encodeURIComponent(book)}`,
        { credentials: 'include' },
      );
      const result = await resp.json(); // always read — an unconsumed body leaks the connection
      if (seq !== checkSeq) return; // a newer keystroke superseded this probe
      if (!resp.ok || !result?.success) {
        check.style.display = 'none'; // can't verify — the submit path still enforces
        return;
      }
      showCheck(result.available, result.available ? 'Available' : result.message);
    } catch (e) {
      if (seq === checkSeq) check.style.display = 'none';
      log.error('Slug availability check failed:', e);
    }
  };
  const scheduleCheck = () => {
    clearTimeout(checkTimer);
    checkSeq++; // invalidate any in-flight probe for the old value
    const slug = normalizeSlug(input.value);
    if (!slug) {
      check.style.display = 'none';
      return;
    }
    if (!SLUG_FORMAT.test(slug)) {
      showCheck(false, SLUG_FORMAT_MESSAGE);
      return;
    }
    checkTimer = setTimeout(() => { runCheck(slug); }, CHECK_DEBOUNCE_MS);
  };
  input.addEventListener('input', () => {
    autoGrow();
    scheduleCheck();
  });
  // The prefilled suggestion was minted available server-side, but verify it
  // live anyway — it can be claimed by another book between panel loads.
  if (normalizeSlug(input.value)) scheduleCheck();

  const status = section.querySelector('#book-url-status') as HTMLElement;
  const showStatus = (msg: string) => {
    status.textContent = msg;
    status.style.display = '';
  };

  const submit = async () => {
    status.style.display = 'none';
    const slug = normalizeSlug(input.value);
    if (!slug) {
      showStatus('Enter a slug first.');
      return;
    }

    const confirmed = await confirmDialog({
      title: 'Set permanent URL?',
      message: `This book's address will become:\n${window.location.origin}/${slug}\n\nThis can only be set once and can never be changed. Your current link will keep working.`,
      confirmLabel: 'Set URL',
    });
    if (!confirmed) return;

    setBtn.disabled = true;
    setBtn.textContent = 'Setting…';
    try {
      const csrfToken = (document.querySelector('meta[name="csrf-token"]') as HTMLMetaElement | null)?.content;
      const resp = await fetch('/api/db/library/set-slug', {
        method: 'POST',
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json',
          'X-CSRF-TOKEN': csrfToken ?? '',
        },
        credentials: 'include',
        body: JSON.stringify({ book, slug }),
      });
      const result = await resp.json();
      if (resp.ok && result?.success) {
        render(section, { ...info, slug: result.slug, canSet: false });
        return;
      }
      showStatus(result?.message || `Failed to set URL (${resp.status})`);
    } catch (e) {
      log.error('Set slug failed:', e);
      showStatus('Network error — please try again.');
    } finally {
      setBtn.disabled = false;
      setBtn.textContent = 'Set URL';
    }
  };

  setBtn.addEventListener('click', (e: Event) => {
    e.preventDefault();
    e.stopPropagation();
    submit();
  });
  input.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      submit();
    }
  });
}
