// The licence section of the edit-library-card form: the grouped vocabulary picker, and the
// custom-licence flow where a custom licence is a BOOK the owner keeps (pick one they already
// use, use any of their public books, or type terms and have one minted), plus an optional
// external terms URL and a short plain-text summary.
//
// Server rules this UI relies on (DbLibraryController::resolveLicenseUpdate): a blank or
// unknown `license` is ignored, `license_book` must be the owner's public plaintext book, and
// `license_book_at` (the pin to the terms as they read when applied) is stamped server-side.
import { log } from '../../utilities/logger';
import { ensureCsrfToken } from '../../utilities/auth/csrf';
import { CUSTOM_LICENSE, canonicalLicenseCode, licensePickerGroups, type LicenseRecordFields } from './licenseInfo';

const PATH = '/components/sourceContainer/licensePicker';
const NEW_BOOK = '__new__';

interface LicenseBookRow {
  book: string;
  title: string | null;
  slug?: string | null;
  uses?: number;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Static HTML for the licence section (values are filled by populateLicenseFields). */
export function licenseFieldsHtml(currentCode?: string | null): string {
  const groups = licensePickerGroups(currentCode)
    .map((g) => `<optgroup label="${esc(g.label)}">${g.options
      .map((o) => `<option value="${esc(o.value)}">${esc(o.label)}</option>`)
      .join('')}</optgroup>`)
    .join('');

  return `
          <div class="form-section">
            <label for="edit-license">Content licence</label>
            <select id="edit-license" name="license">
              ${groups}
              <optgroup label="Custom"><option value="${CUSTOM_LICENSE}">Custom licence…</option></optgroup>
            </select>
            <div id="edit-custom-license" style="display:none; margin-top: 10px;">
              <label for="edit-license-book">Licence page</label>
              <select id="edit-license-book">
                <option value="">— none (summary / link below) —</option>
              </select>
              <div id="edit-new-license" style="display:none; margin-top: 8px;">
                <input type="text" id="edit-new-license-title" placeholder="Licence name, e.g. “Sam’s Commons Licence”">
                <textarea id="edit-new-license-text" rows="6" placeholder="The licence terms. Each paragraph becomes a paragraph of a public page you own and can reuse on all your works."></textarea>
                <button type="button" id="edit-create-license-book">Create licence page</button>
                <span id="edit-new-license-status" class="field-hint"></span>
              </div>
              <input type="url" id="edit-license-url" placeholder="Or link to terms elsewhere (https://…)" style="margin-top: 8px;">
              <textarea id="edit-custom-license-text" name="custom_license_text" rows="2" placeholder="Short summary shown if the licence page is unavailable" style="margin-top: 8px;"></textarea>
              <div class="field-hint">A licence page is a public book you own. Works stay under the terms as they read when you applied them; edit the page later and older works keep linking to their version.</div>
            </div>
            <div id="license-book-usage" class="field-hint" style="display:none;"></div>
            <div class="field-hint">Choose how others can use your content. <a href="/license2025content" target="_blank">Learn more</a></div>
          </div>`;
}

function q<T extends Element>(root: ParentNode, sel: string): T | null {
  return root.querySelector(sel) as T | null;
}

async function jsonFetch(url: string, init: RequestInit = {}): Promise<{ ok: boolean; status: number; body: any }> {
  const headers: Record<string, string> = { Accept: 'application/json', ...(init.headers as Record<string, string> | undefined) };
  if (init.method && init.method !== 'GET') {
    const token = await ensureCsrfToken();
    if (token) headers['X-XSRF-TOKEN'] = token;
    headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(url, { credentials: 'include', ...init, headers });
  // Always consume the body (drained-fetch gate): JSON when we can, text otherwise.
  const raw = await res.text();
  let body: any = null;
  try { body = raw ? JSON.parse(raw) : null; } catch { body = null; }
  return { ok: res.ok, status: res.status, body };
}

function fillLicenseBookOptions(select: HTMLSelectElement, used: LicenseBookRow[], candidates: LicenseBookRow[], current: string | null) {
  const label = (r: LicenseBookRow) => esc(r.title || r.book);
  const known = new Set([...used, ...candidates].map((r) => r.book));
  let html = '<option value="">— none (summary / link below) —</option>';
  if (current && !known.has(current)) {
    html += `<option value="${esc(current)}">Current licence page</option>`;
  }
  if (used.length) {
    html += `<optgroup label="Your licences">${used.map((r) => `<option value="${esc(r.book)}">${label(r)}${r.uses ? ` (${r.uses})` : ''}</option>`).join('')}</optgroup>`;
  }
  if (candidates.length) {
    html += `<optgroup label="Use one of your public books">${candidates.map((r) => `<option value="${esc(r.book)}">${label(r)}</option>`).join('')}</optgroup>`;
  }
  html += `<option value="${NEW_BOOK}">＋ Write a new licence…</option>`;
  select.innerHTML = html;
  select.value = current || '';
}

let loaded: Promise<void> | null = null;

async function loadLicenseBooks(root: ParentNode, current: string | null): Promise<void> {
  const select = q<HTMLSelectElement>(root, '#edit-license-book');
  if (!select) return;
  try {
    const r = await jsonFetch('/api/license-books');
    if (r.status === 401) {
      select.innerHTML = '<option value="">Log in to use a licence page</option>';
      select.disabled = true;
      return;
    }
    if (!r.ok || !r.body?.success) throw new Error(`HTTP ${r.status}`);
    fillLicenseBookOptions(select, r.body.used ?? [], r.body.candidates ?? [], current);
  } catch (e) {
    log.error('could not load licence books', PATH, e);
    fillLicenseBookOptions(select, [], [], current);
  }
}

/** Fill the section from the stored record. */
export function populateLicenseFields(root: ParentNode, record: LicenseRecordFields & { book?: string; visibility?: string }) {
  const licenseField = q<HTMLSelectElement>(root, '#edit-license');
  if (!licenseField) return;
  // The stored code is always an option (licensePickerGroups includes it), so the select can
  // never read back '' for a valid stored licence.
  licenseField.value = canonicalLicenseCode(record.license) ?? (record.license ? CUSTOM_LICENSE : licenseField.value);

  const isCustom = licenseField.value === CUSTOM_LICENSE;
  const section = q<HTMLElement>(root, '#edit-custom-license');
  if (section) section.style.display = isCustom ? 'block' : 'none';
  const url = q<HTMLInputElement>(root, '#edit-license-url');
  if (url) url.value = record.license_url || '';
  const text = q<HTMLTextAreaElement>(root, '#edit-custom-license-text');
  if (text) text.value = record.custom_license_text || '';

  loaded = isCustom ? loadLicenseBooks(root, record.license_book ?? null) : null;
  // Only a public book can be anyone's licence page — don't spend a lookup on the rest.
  if (record.book && record.visibility === 'public') void showLicenseBookUsage(root, record.book);
}

/** Wire the picker's interactions. */
export function wireLicenseFields(root: ParentNode, record: LicenseRecordFields) {
  const licenseField = q<HTMLSelectElement>(root, '#edit-license');
  const section = q<HTMLElement>(root, '#edit-custom-license');
  const bookSelect = q<HTMLSelectElement>(root, '#edit-license-book');
  const newBox = q<HTMLElement>(root, '#edit-new-license');

  licenseField?.addEventListener('change', () => {
    const isCustom = licenseField.value === CUSTOM_LICENSE;
    if (section) section.style.display = isCustom ? 'block' : 'none';
    if (isCustom && !loaded) loaded = loadLicenseBooks(root, record.license_book ?? null);
  });

  bookSelect?.addEventListener('change', () => {
    if (newBox) newBox.style.display = bookSelect.value === NEW_BOOK ? 'block' : 'none';
  });

  q<HTMLButtonElement>(root, '#edit-create-license-book')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget as HTMLButtonElement;
    const title = q<HTMLInputElement>(root, '#edit-new-license-title')?.value.trim() ?? '';
    const text = q<HTMLTextAreaElement>(root, '#edit-new-license-text')?.value.trim() ?? '';
    const status = q<HTMLElement>(root, '#edit-new-license-status');
    if (!title || !text) {
      if (status) status.textContent = 'Give the licence a name and its terms.';
      return;
    }
    btn.disabled = true;
    if (status) status.textContent = 'Creating…';
    try {
      const r = await jsonFetch('/api/license-books', { method: 'POST', body: JSON.stringify({ title, text }) });
      if (!r.ok || !r.body?.success) {
        if (status) status.textContent = r.body?.message || `Could not create the licence page (HTTP ${r.status}).`;
        return;
      }
      if (bookSelect) {
        const opt = document.createElement('option');
        opt.value = r.body.book;
        opt.textContent = r.body.title;
        bookSelect.insertBefore(opt, bookSelect.lastElementChild);
        bookSelect.value = r.body.book;
      }
      if (newBox) newBox.style.display = 'none';
      const summary = q<HTMLTextAreaElement>(root, '#edit-custom-license-text');
      if (summary && !summary.value.trim()) summary.value = title;
      if (status) status.textContent = '';
    } catch (err) {
      log.error('licence book create failed', PATH, err);
      if (status) status.textContent = 'Could not create the licence page.';
    } finally {
      btn.disabled = false;
    }
  });
}

/** The licence fields the save path sends (merged over the generic form fields). */
export function collectLicenseFields(root: ParentNode): Record<string, string> {
  const out: Record<string, string> = {};
  const licenseField = q<HTMLSelectElement>(root, '#edit-license');
  if (!licenseField) return out;
  out.license = licenseField.value || '';
  const text = q<HTMLTextAreaElement>(root, '#edit-custom-license-text');
  out.custom_license_text = text?.value ?? '';
  if (out.license === CUSTOM_LICENSE) {
    const book = q<HTMLSelectElement>(root, '#edit-license-book');
    // Only send license_book once the list has loaded — before that the select holds a
    // placeholder, and sending '' would clear a stored licence page.
    if (book && !book.disabled && book.options.length > 1 && book.value !== NEW_BOOK) {
      out.license_book = book.value;
    }
    out.license_url = q<HTMLInputElement>(root, '#edit-license-url')?.value.trim() ?? '';
  }
  return out;
}

/**
 * On a licence BOOK's own edit form: "used by N of your works (M on earlier terms)" with a
 * button to move them all onto the current terms.
 */
async function showLicenseBookUsage(root: ParentNode, bookId: string) {
  const box = q<HTMLElement>(root, '#license-book-usage');
  if (!box) return;
  try {
    const r = await jsonFetch(`/api/license-books/${encodeURIComponent(bookId)}/usage`);
    if (!r.ok || !r.body?.success || !r.body.total) return;
    const { total, outdated } = r.body as { total: number; outdated: number };
    box.style.display = 'block';
    box.innerHTML = `This book is the licence of ${total} of your work${total === 1 ? '' : 's'}`
      + (outdated ? ` — ${outdated} still under earlier terms. <button type="button" id="license-book-reapply">Apply current terms to all</button>` : '.');
    q<HTMLButtonElement>(box, '#license-book-reapply')?.addEventListener('click', async (e) => {
      const btn = e.currentTarget as HTMLButtonElement;
      btn.disabled = true;
      const res = await jsonFetch(`/api/license-books/${encodeURIComponent(bookId)}/reapply`, { method: 'POST', body: '{}' });
      box.textContent = res.ok && res.body?.success
        ? `All ${res.body.updated} works now use the current terms.`
        : 'Could not re-apply the licence.';
    });
  } catch (e) {
    log.error('licence book usage lookup failed', PATH, e);
  }
}
