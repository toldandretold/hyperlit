/**
 * Licence code → display label + link, shared by the source-container render and edit paths.
 *
 * The vocabulary is GENERATED from the server (`licenses.generated.ts`, from
 * app/Support/Licenses.php via `php artisan licenses:export-js`) so the reader, the picker and
 * the server can never disagree. Rules worth knowing:
 *  - An UNKNOWN code labels as "Licence unknown" — never as the site default. The old map fell
 *    back to "CC BY-SA 4.0 (No AI)" for any code it lacked, so a third party's
 *    `all-rights-reserved` book was shown to readers as copyleft.
 *  - A blank code (a brand-new user book the server has not stamped yet) is the user default.
 *  - A custom licence may be a BOOK (record.license_book): it links there, or — when that book
 *    has changed since this work was pinned to it (record.license_book_at) — to the time
 *    machine view of the terms the work was actually published under. Mirrors
 *    App\Services\Licensing\LicenseLink.
 */
import { log } from '../../utilities/logger';
import {
  CUSTOM_LICENSE,
  DEFAULT_USER_LICENSE,
  LICENSES,
  UNKNOWN_LICENSE,
  type LicenseDef,
} from './licenses.generated';

export { CUSTOM_LICENSE, DEFAULT_USER_LICENSE, LICENSES, UNKNOWN_LICENSE };

export interface LicenseInfo {
  short: string;
  url: string | null;
}

/** Kept for existing imports: the user-work default. */
export const DEFAULT_LICENSE = DEFAULT_USER_LICENSE;

/** Vocabulary spelling of a stored code (case-insensitive), or null if it matches nothing. */
export function canonicalLicenseCode(code: string | null | undefined): string | null {
  if (!code || !code.trim()) return null;
  if (LICENSES[code]) return code;
  const lower = code.trim().toLowerCase();
  return Object.keys(LICENSES).find((c) => c.toLowerCase() === lower) ?? null;
}

/** Look up a licence code's display info. Blank → user default; unknown → "Licence unknown". */
export function licenseInfoFor(code: string | null | undefined): LicenseInfo {
  const key = !code || !code.trim() ? DEFAULT_USER_LICENSE : canonicalLicenseCode(code) ?? UNKNOWN_LICENSE;
  const def = LICENSES[key] ?? LICENSES[UNKNOWN_LICENSE]!;
  return { short: def.label, url: def.url };
}

export interface LicenseRecordFields {
  license?: string | null;
  custom_license_text?: string | null;
  license_url?: string | null;
  license_book?: string | null;
  license_book_at?: number | null;
  work_license?: string | null;
}

export interface LicenseBookInfo {
  available: boolean;
  book?: string;
  title?: string | null;
  url?: string;
  timemachine_base?: string;
  changed_at?: number | null;
}

export interface LicenseLink {
  /** Canonical vocabulary code. */
  code: string;
  label: string;
  url: string | null;
  /** The licence book changed after this work was pinned — the link shows the earlier terms. */
  pinnedTerms: boolean;
  /** ms the work was pinned at (for "terms as of …"). */
  pinnedAt: number | null;
  /** Visible plain-text terms for a custom licence with nothing to link to. */
  customText: string | null;
}

/** The time machine's `at` is a timestamptz string, not epoch ms. */
export function isoFromMs(ms: number): string {
  return new Date(ms).toISOString();
}

export function licenseLinkFor(record: LicenseRecordFields | null | undefined, bookInfo?: LicenseBookInfo | null): LicenseLink {
  const code = record?.license && record.license.trim() ? canonicalLicenseCode(record.license) ?? UNKNOWN_LICENSE : DEFAULT_USER_LICENSE;
  const info = licenseInfoFor(code);
  const out: LicenseLink = { code, label: info.short, url: info.url, pinnedTerms: false, pinnedAt: null, customText: null };

  if (code !== CUSTOM_LICENSE) return out;

  const text = record?.custom_license_text?.trim() || null;
  out.url = record?.license_url || null;
  out.customText = text;
  if (text && !out.url) out.label = info.short;

  if (record?.license_book && bookInfo?.available) {
    out.label = bookInfo.title || info.short;
    out.customText = null;
    const pin = record.license_book_at ?? null;
    if (pin && bookInfo.changed_at && bookInfo.changed_at > pin && bookInfo.timemachine_base) {
      out.url = `${bookInfo.timemachine_base}?at=${encodeURIComponent(isoFromMs(pin))}`;
      out.pinnedTerms = true;
      out.pinnedAt = pin;
    } else {
      out.url = bookInfo.url ?? `/${record.license_book}`;
    }
  } else if (text && out.url) {
    out.label = text.length > 120 ? `${text.slice(0, 119)}…` : text;
    out.customText = null;
  }
  return out;
}

const bookInfoCache = new Map<string, Promise<LicenseBookInfo | null>>();

/** Public lookup of a licence book (title, link, last change). Cached per page. */
export function fetchLicenseBookInfo(bookId: string): Promise<LicenseBookInfo | null> {
  let p = bookInfoCache.get(bookId);
  if (!p) {
    p = fetch(`/api/license-books/${encodeURIComponent(bookId)}/info`, { headers: { Accept: 'application/json' } })
      .then((res) => res.json() as Promise<LicenseBookInfo>)
      .catch((err) => {
        log.error('licence book lookup failed', 'licenseInfo', err);
        bookInfoCache.delete(bookId);
        return null;
      });
    bookInfoCache.set(bookId, p);
  }
  return p;
}

export interface PickerOption {
  value: string;
  label: string;
}

export interface PickerGroup {
  label: string;
  options: PickerOption[];
}

const GROUP_LABELS: Record<LicenseDef['group'], string> = {
  hyperlit: 'Hyperlit',
  cc: 'Creative Commons',
  'public-domain': 'Public domain',
  other: 'Other',
  custom: 'Custom',
};

/**
 * The picker's built-in options, grouped. The CURRENT stored code is always included even when
 * it is not user-selectable (a harvested CC BY 3.0 work): a <select> whose value matches no
 * option reads back as '' — which is how editing a title used to wipe a work's licence.
 */
export function licensePickerGroups(currentCode?: string | null): PickerGroup[] {
  const current = canonicalLicenseCode(currentCode);
  const groups = new Map<string, PickerOption[]>();
  for (const [code, def] of Object.entries(LICENSES)) {
    if (code === CUSTOM_LICENSE) continue; // custom has its own section in the form
    if (!def.selectable && code !== current) continue;
    const label = code === DEFAULT_USER_LICENSE ? `${def.label} — default` : def.label;
    const g = GROUP_LABELS[def.group];
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g)!.push({ value: code, label });
  }
  return [...groups.entries()].map(([label, options]) => ({ label, options }));
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function safeHref(url: string): string | null {
  return /^(https?:\/\/|\/)/i.test(url) ? url : null;
}

/**
 * The reader's licence line. Always a LINK when there is anywhere to go (a CC deed, the
 * owner's licence book, an upstream terms page); custom terms with no link are shown as
 * visible text — they used to live only in a hover tooltip, invisible on touch screens.
 * For a harvested/imported work whose upstream statement differs from the label, the raw
 * statement is shown underneath as the evidence.
 */
export function licenseLineHtml(link: LicenseLink, record?: LicenseRecordFields | null): string {
  const style = 'font-size: var(--sc-12); color: var(--color-label); margin-top: 10px;';
  const href = link.url ? safeHref(link.url) : null;
  const label = esc(link.label);
  const main = href
    ? `<a href="${esc(href)}" target="_blank" rel="license noopener" style="color: var(--color-label); text-decoration: underline;">${label}</a>`
    : label;

  let note = '';
  if (link.pinnedTerms && link.pinnedAt) {
    const date = new Date(link.pinnedAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
    note = ` <span class="license-pinned">(terms as of ${esc(date)} — since updated)</span>`;
  }

  let extra = '';
  if (link.customText) {
    extra = `<span class="license-custom-text" style="display:block; white-space: pre-line; margin-top: 4px;">${esc(link.customText)}</span>`;
  }
  // Only where the label is a judgement rather than a known licence (open-unspecified,
  // publisher terms, all rights reserved, custom): show the upstream wording it came from.
  const upstream = record?.work_license?.trim();
  const group = LICENSES[link.code]?.group;
  if (upstream && (group === 'other' || group === 'custom') && upstream !== link.label) {
    extra += `<span class="license-upstream" style="display:block; opacity: 0.7; margin-top: 2px;">As stated by the source: ${esc(upstream)}</span>`;
  }

  return `<p class="license-line" style="${style}">📄 ${main}${note}${extra}</p>`;
}
