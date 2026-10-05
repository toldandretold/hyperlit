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
  input.addEventListener('input', autoGrow);
  autoGrow();

  const status = section.querySelector('#book-url-status') as HTMLElement;
  const showStatus = (msg: string) => {
    status.textContent = msg;
    status.style.display = '';
  };

  const submit = async () => {
    status.style.display = 'none';
    // Enter submits (keydown below), but a paste can still carry newlines.
    const slug = input.value.replace(/[\r\n]+/g, '').trim().toLowerCase();
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
