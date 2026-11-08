/**
 * Licence display + picker — resources/js/components/sourceContainer/{licenseInfo,licensePicker}.ts.
 *
 * What these pin:
 *  - an UNKNOWN code labels "Licence unknown" — the old map showed any code it lacked as the
 *    site's CC BY-SA No-AI licence (an all-rights-reserved book displayed as copyleft);
 *  - the picker always offers the CURRENT stored code, so a harvested CC BY-NC-ND / CC BY 3.0
 *    work's <select> never reads back '' (which is how editing a title wiped its licence);
 *  - a custom licence that is a BOOK links to it, or to the time machine view of the terms the
 *    work was published under once the licence book has changed since the pin;
 *  - custom terms are visible text, not a hover tooltip, and are HTML-escaped.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../resources/js/utilities/logger', () => ({
  log: { init: vi.fn(), nav: vi.fn(), content: vi.fn(), user: vi.fn(), error: vi.fn() },
  verbose: { init: vi.fn(), nav: vi.fn(), content: vi.fn(), user: vi.fn() },
  isVerboseEnabled: () => false,
}));
vi.mock('../../../resources/js/utilities/auth/csrf', () => ({ ensureCsrfToken: async () => 'tok' }));

import {
  licenseInfoFor,
  licenseLinkFor,
  licenseLineHtml,
  licensePickerGroups,
  canonicalLicenseCode,
} from '../../../resources/js/components/sourceContainer/licenseInfo';
import {
  licenseFieldsHtml,
  populateLicenseFields,
  collectLicenseFields,
} from '../../../resources/js/components/sourceContainer/licensePicker';

describe('licenseInfoFor', () => {
  it('labels an unknown code as unknown, never as the site default', () => {
    expect(licenseInfoFor('MIT').short).toBe('Licence unknown');
    expect(licenseInfoFor('MIT').url).toBeNull();
  });
  it('a blank code (unsynced new user book) is the user default', () => {
    expect(licenseInfoFor('').short).toMatch(/No AI/);
    expect(licenseInfoFor(null).url).toBe('/license2025content');
  });
  it('canonicalises legacy casing', () => {
    expect(canonicalLicenseCode('all-rights-reserved')).toBe('All-Rights-Reserved');
    expect(licenseInfoFor('cc-by-sa-4.0').url).toBe('https://creativecommons.org/licenses/by-sa/4.0/');
  });
  it('knows versioned CC and the public domain mark', () => {
    expect(licenseInfoFor('CC-BY-3.0').url).toBe('https://creativecommons.org/licenses/by/3.0/');
    expect(licenseInfoFor('PDM').url).toBe('https://creativecommons.org/publicdomain/mark/1.0/');
  });
});

describe('licensePickerGroups', () => {
  const values = (code) => licensePickerGroups(code).flatMap((g) => g.options.map((o) => o.value));
  it('offers the full 4.0 CC set, CC0, PDM and all rights reserved', () => {
    const v = values(null);
    for (const c of ['CC-BY-SA-4.0-NO-AI', 'CC-BY-4.0', 'CC-BY-SA-4.0', 'CC-BY-NC-4.0', 'CC-BY-ND-4.0', 'CC-BY-NC-SA-4.0', 'CC-BY-NC-ND-4.0', 'CC0', 'PDM', 'All-Rights-Reserved']) {
      expect(v).toContain(c);
    }
    expect(v).not.toContain('CC-BY-3.0');
  });
  it('includes a stored non-selectable code so the select cannot read back blank', () => {
    expect(values('CC-BY-3.0')).toContain('CC-BY-3.0');
    expect(values('Publisher-Open')).toContain('Publisher-Open');
  });
});

describe('licenseLinkFor (custom licence as a book)', () => {
  const record = { license: 'custom', license_book: 'book_1', license_book_at: 1_000_000, custom_license_text: 'snap' };
  const info = { available: true, book: 'book_1', title: 'Sam Licence', url: '/sam-licence', timemachine_base: '/book_1/timemachine' };

  it('links the live licence book when it has not changed since the pin', () => {
    const l = licenseLinkFor(record, { ...info, changed_at: 900_000 });
    expect(l.label).toBe('Sam Licence');
    expect(l.url).toBe('/sam-licence');
    expect(l.pinnedTerms).toBe(false);
  });

  it('links the time-machine view of the pinned terms once the book has changed', () => {
    const l = licenseLinkFor(record, { ...info, changed_at: 2_000_000 });
    expect(l.pinnedTerms).toBe(true);
    expect(l.url).toBe(`/book_1/timemachine?at=${encodeURIComponent(new Date(1_000_000).toISOString())}`);
    expect(licenseLineHtml(l)).toContain('since updated');
  });

  it('falls back to the snapshot text when the licence book is unavailable', () => {
    const l = licenseLinkFor(record, { available: false });
    expect(l.url).toBeNull();
    expect(l.customText).toBe('snap');
  });
});

describe('licenseLineHtml', () => {
  it('shows custom terms as visible, escaped text', () => {
    const html = licenseLineHtml(licenseLinkFor({ license: 'custom', custom_license_text: '<b>mine</b> & yours' }));
    expect(html).toContain('&lt;b&gt;mine&lt;/b&gt; &amp; yours');
    expect(html).not.toContain('title=');
  });
  it('marks the link rel=license', () => {
    expect(licenseLineHtml(licenseLinkFor({ license: 'CC-BY-4.0' }))).toContain('rel="license noopener"');
  });
  it('shows the upstream statement behind a judgement label', () => {
    const html = licenseLineHtml(licenseLinkFor({ license: 'Open-Unspecified' }), { work_license: 'other-oa' });
    expect(html).toContain('As stated by the source: other-oa');
  });
});

describe('licence picker form', () => {
  function mount(record) {
    const root = document.createElement('form');
    root.innerHTML = licenseFieldsHtml(record.license);
    populateLicenseFields(root, record);
    return root;
  }

  it('keeps a harvested work\'s stored code through a save (the title-edit wipe)', () => {
    const root = mount({ license: 'CC-BY-NC-ND-4.0' });
    expect(root.querySelector('#edit-license').value).toBe('CC-BY-NC-ND-4.0');
    expect(collectLicenseFields(root).license).toBe('CC-BY-NC-ND-4.0');
  });

  it('never sends license_book before the licence list has loaded', () => {
    globalThis.fetch = vi.fn(() => new Promise(() => {})); // list never arrives
    const root = mount({ license: 'custom', license_book: 'book_1' });
    const out = collectLicenseFields(root);
    expect(out.license).toBe('custom');
    expect('license_book' in out).toBe(false);
  });
});
