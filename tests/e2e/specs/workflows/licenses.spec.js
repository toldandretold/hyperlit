// @ts-check
//
// Licences, end to end: can a reader actually SEE the right licence, and does every link go
// where it should? Real gestures in the source container's edit form, read back three ways:
//   1. the reader's licence line in #source-container (label + href),
//   2. the stored library row (what reached Postgres),
//   3. the SERVER-rendered <head> an anonymous visitor / crawler gets
//      (<link rel="license">, <meta name="DC.rights">).
//
// No harvest runs. `php artisan e2e:seed-license-fixtures` (beforeEach) resets five owned,
// public fixture books, including one carrying a harvested-style licence the picker does not
// offer by default (CC BY-NC-ND) and one with a legacy mis-cased code — the two shapes that
// used to be mislabelled as the site's CC BY-SA No-AI licence.
//
// Covered:
//   - every built-in picker licence: saved, shown, linked to the right deed, declared in <head>
//   - the title-edit wipe: editing a harvested NC-ND work's title keeps its licence
//   - legacy / judgement codes label honestly (no silent site default), upstream wording shown
//   - custom licence as plain text (visible, escaped) and as an external terms URL
//   - custom licence as a BOOK: written in the picker, linked, readable logged-out, reused on a
//     second work, pinned to the time machine once its terms change, re-applied to all
//
// Run: npm run test:e2e -- specs/workflows/licenses.spec.js

import { test, expect } from '@playwright/test';
import { execSync } from 'child_process';
import { resolve } from 'path';
import { readLibrary } from '../../helpers/backendRead.js';

test.use({ serviceWorkers: 'block' });
test.describe.configure({ mode: 'serial' });

const BASE = process.env.E2E_BASE_URL || 'https://hyperlit.test';
const APP_ROOT = resolve(import.meta.dirname, '../../../..');

const HARVEST = 'book_e2e_lic_harvest';
const OPEN = 'book_e2e_lic_open';
const LEGACY = 'book_e2e_lic_legacy';
const WORK_A = 'book_e2e_lic_work_a';
const WORK_B = 'book_e2e_lic_work_b';

/** Built-in picker choices → [label shown to readers, expected href (null = no link)]. */
const BUILT_INS = {
  'CC-BY-4.0': ['CC BY 4.0', 'https://creativecommons.org/licenses/by/4.0/'],
  'CC-BY-SA-4.0': ['CC BY-SA 4.0', 'https://creativecommons.org/licenses/by-sa/4.0/'],
  'CC-BY-NC-4.0': ['CC BY-NC 4.0', 'https://creativecommons.org/licenses/by-nc/4.0/'],
  'CC-BY-ND-4.0': ['CC BY-ND 4.0', 'https://creativecommons.org/licenses/by-nd/4.0/'],
  'CC-BY-NC-SA-4.0': ['CC BY-NC-SA 4.0', 'https://creativecommons.org/licenses/by-nc-sa/4.0/'],
  'CC-BY-NC-ND-4.0': ['CC BY-NC-ND 4.0', 'https://creativecommons.org/licenses/by-nc-nd/4.0/'],
  'CC0': ['CC0 1.0 (public domain dedication)', 'https://creativecommons.org/publicdomain/zero/1.0/'],
  'PDM': ['Public domain', 'https://creativecommons.org/publicdomain/mark/1.0/'],
  'All-Rights-Reserved': ['All rights reserved', null],
  'Unknown': ['Licence unknown', null],
  // Last, so the fixture ends where it started.
  'CC-BY-SA-4.0-NO-AI': ['CC BY-SA 4.0 (No AI training)', '/license2025content'],
};

test.beforeEach(() => {
  execSync('php artisan e2e:seed-license-fixtures', { cwd: APP_ROOT, stdio: 'pipe' });
});

// ── helpers ──────────────────────────────────────────────────────────────────

async function openSourcePanel(page, book) {
  await page.goto(`${BASE}/${book}`);
  await page.waitForLoadState('networkidle');
  await page.waitForSelector('.main-content', { timeout: 15_000 });
  await page.waitForSelector('#cloudRef', { timeout: 15_000 });
  // ButtonRegistry binds after boot, so the first click can land on a deaf button — retry
  // the whole gesture, clicking through the DOM (the translation-ui.spec pattern).
  await expect(async () => {
    await page.evaluate(() => document.getElementById('cloudRef')?.click());
    await page.waitForFunction(() => !!document.querySelector('#source-container.open'), null, { timeout: 2000 });
  }).toPass({ timeout: 20_000 });
  await page.waitForSelector('#source-container .license-line', { timeout: 10_000 });
}

async function openEditForm(page) {
  await expect(async () => {
    await page.evaluate(() => document.getElementById('edit-source')?.click());
    await expect(page.locator('#edit-form-container')).toBeVisible({ timeout: 2000 });
  }).toPass({ timeout: 15_000 });
  await expect(page.locator('#edit-license')).toBeVisible();
}

/** Toggle the edit button again = save + close; wait for the upsert AND the re-render. */
async function saveEditForm(page) {
  const upsert = page.waitForResponse((r) => r.url().includes('/api/db/library/upsert') && r.request().method() === 'POST', { timeout: 15_000 });
  await page.evaluate(() => document.getElementById('edit-source')?.click());
  const res = await upsert;
  expect(res.ok(), `library upsert should succeed (HTTP ${res.status()})`).toBeTruthy();
  await expect(page.locator('#edit-form-container')).toBeHidden({ timeout: 10_000 });
  await page.waitForSelector('#source-container .license-line', { timeout: 10_000 });
  return res.json();
}

const licenseLine = (page) => page.locator('#source-container .license-line');
const licenseLink = (page) => page.locator('#source-container .license-line a');

/** Assert the reader's licence line: label text, and href (null = must not be a link). */
async function expectLine(page, label, href) {
  await expect(licenseLine(page)).toContainText(label);
  if (href === null) {
    await expect(licenseLink(page)).toHaveCount(0);
  } else {
    await expect(licenseLink(page)).toHaveAttribute('href', href);
    await expect(licenseLink(page)).toHaveAttribute('rel', /license/);
  }
}

async function storedLicense(page, book) {
  const r = await readLibrary(page, book);
  expect(r.ok, `library read for ${book} (HTTP ${r.status})`).toBeTruthy();
  return r.body?.library ?? r.body;
}

/** The server-rendered head an anonymous visitor (or crawler) gets for a book page. */
async function anonHead(browser, path) {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
  try {
    const res = await ctx.request.get(`${BASE}${path}`);
    expect(res.ok(), `GET ${path} (HTTP ${res.status()})`).toBeTruthy();
    const html = await res.text();
    const link = html.match(/<link rel="license" href="([^"]+)">/);
    const rights = html.match(/<meta name="DC\.rights" content="([^"]*)">/);
    // Blade's {{ }} escaping, undone (&amp; last so "&amp;lt;" can't double-decode).
    const decode = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
      .replace(/&#0?39;/g, "'").replace(/&amp;/g, '&');
    return { licenseHref: link ? decode(link[1]) : null, rights: rights ? decode(rights[1]) : null };
  } finally {
    await ctx.close();
  }
}

/** Absolute form of an href as the server emits it (relative site paths are made absolute). */
const abs = (href) => (href && href.startsWith('/') ? `${BASE}${href}` : href);

/** In-page JSON POST with the app's own session + XSRF (Sanctum stateful needs the Origin). */
async function postJson(page, url, data) {
  return page.evaluate(async ({ url, data }) => {
    const m = document.cookie.match(/(?:^|;\s*)XSRF-TOKEN=([^;]+)/);
    const res = await fetch(url, {
      method: 'POST',
      credentials: 'include',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-XSRF-TOKEN': m ? decodeURIComponent(m[1]) : '' },
      body: JSON.stringify(data),
    });
    let body = null;
    try { body = await res.json(); } catch { body = null; }
    return { ok: res.ok, status: res.status, body };
  }, { url, data });
}

// ── tests ────────────────────────────────────────────────────────────────────

test('the picker offers the full CC 4.0 set, CC0, public domain, all rights reserved, unknown and custom', async ({ page }) => {
  await openSourcePanel(page, WORK_A);
  await openEditForm(page);

  const values = await page.locator('#edit-license option').evaluateAll((os) => os.map((o) => /** @type {HTMLOptionElement} */ (o).value));
  for (const code of [...Object.keys(BUILT_INS), 'custom']) {
    expect(values, `picker should offer ${code}`).toContain(code);
  }
  // Older CC versions are valid stored values, but only offered when a work already has one.
  expect(values).not.toContain('CC-BY-3.0');
  await expect(page.locator('#edit-license')).toHaveValue('CC-BY-SA-4.0-NO-AI');
});

test('every built-in licence saves, shows the right label and deed link, and is declared in <head>', async ({ page, browser }) => {
  test.setTimeout(240_000);
  await openSourcePanel(page, WORK_A);

  for (const [code, [label, href]] of Object.entries(BUILT_INS)) {
    await test.step(code, async () => {
      await openEditForm(page);
      await page.selectOption('#edit-license', code);
      const saved = await saveEditForm(page);
      expect(saved?.library?.license, `server verdict for ${code}`).toBe(code);

      // 1. reader's licence line
      await expectLine(page, label, href);
      // 2. Postgres
      expect((await storedLicense(page, WORK_A)).license).toBe(code);
      // 3. server-rendered head
      const head = await anonHead(browser, `/${WORK_A}`);
      expect(head.rights).toBe(label);
      expect(head.licenseHref).toBe(href ? abs(href) : null);
    });
  }

  // Survives a full reload (IndexedDB + server agree).
  await openSourcePanel(page, WORK_A);
  await expectLine(page, ...BUILT_INS['CC-BY-SA-4.0-NO-AI']);
});

test('a harvested CC BY-NC-ND work keeps its licence through an unrelated title edit', async ({ page, browser }) => {
  await openSourcePanel(page, HARVEST);
  await expectLine(page, 'CC BY-NC-ND 4.0', 'https://creativecommons.org/licenses/by-nc-nd/4.0/');

  await openEditForm(page);
  // The stored code must be the SELECTED option — a select matching no option reads back ''
  // and the old server stored it, relabelling the work with the site default.
  await expect(page.locator('#edit-license')).toHaveValue('CC-BY-NC-ND-4.0');
  await page.fill('#edit-title', 'E2E Licence Fixture — Harvested NC-ND (retitled)');
  await saveEditForm(page);

  await expectLine(page, 'CC BY-NC-ND 4.0', 'https://creativecommons.org/licenses/by-nc-nd/4.0/');
  const row = await storedLicense(page, HARVEST);
  expect(row.title).toContain('retitled');
  expect(row.license).toBe('CC-BY-NC-ND-4.0');

  await openSourcePanel(page, HARVEST);
  await expectLine(page, 'CC BY-NC-ND 4.0', 'https://creativecommons.org/licenses/by-nc-nd/4.0/');
  expect((await anonHead(browser, `/${HARVEST}`)).licenseHref).toBe('https://creativecommons.org/licenses/by-nc-nd/4.0/');
});

test('a legacy mis-cased code labels as what it is, never as the site default', async ({ page, browser }) => {
  await openSourcePanel(page, LEGACY);
  await expectLine(page, 'All rights reserved', null);
  await expect(licenseLine(page)).not.toContainText('No AI');

  const head = await anonHead(browser, `/${LEGACY}`);
  expect(head.rights).toBe('All rights reserved');
  expect(head.licenseHref).toBeNull();
});

test('a judgement label shows the upstream wording it came from', async ({ page }) => {
  await openSourcePanel(page, OPEN);
  await expectLine(page, 'Open access (licence not stated)', null);
  await expect(licenseLine(page).locator('.license-upstream')).toHaveText('As stated by the source: other-oa');
});

test('a custom licence as plain text is visible (not a tooltip) and escaped', async ({ page, browser }) => {
  await openSourcePanel(page, WORK_A);
  await openEditForm(page);
  await page.selectOption('#edit-license', 'custom');
  await expect(page.locator('#edit-custom-license')).toBeVisible();
  const terms = 'Share freely <b>but</b> credit the collective & keep it free';
  await page.fill('#edit-custom-license-text', terms);
  await saveEditForm(page);

  await expect(licenseLine(page).locator('.license-custom-text')).toHaveText(terms);
  await expect(licenseLine(page).locator('b')).toHaveCount(0);
  await expect(licenseLine(page)).not.toHaveAttribute('title', /.+/);
  expect((await storedLicense(page, WORK_A)).license).toBe('custom');
  expect((await anonHead(browser, `/${WORK_A}`)).rights).toBe(terms);
});

test('a custom licence with an external terms URL links to it', async ({ page, browser }) => {
  await openSourcePanel(page, WORK_A);
  await openEditForm(page);
  await page.selectOption('#edit-license', 'custom');
  await page.fill('#edit-custom-license-text', 'Collective Commons Licence v2');
  await page.fill('#edit-license-url', 'https://example.org/collective-licence-v2');
  await saveEditForm(page);

  await expectLine(page, 'Collective Commons Licence v2', 'https://example.org/collective-licence-v2');
  const row = await storedLicense(page, WORK_A);
  expect(row.license_url).toBe('https://example.org/collective-licence-v2');
  expect((await anonHead(browser, `/${WORK_A}`)).licenseHref).toBe('https://example.org/collective-licence-v2');
});

test('a custom licence BOOK: written in the picker, linked, reused, pinned to its terms, re-applied', async ({ page, browser }) => {
  test.setTimeout(240_000);
  const title = `E2E Licence ${Date.now()}`;
  const v1 = 'Version one terms: share alike, credit the authors.';
  const v2 = 'Version two terms: anything goes.';

  // ── Write a new licence page from work A's picker ──
  let licenseBook;
  await test.step('create licence page in the picker and apply it to work A', async () => {
    await openSourcePanel(page, WORK_A);
    await openEditForm(page);
    await page.selectOption('#edit-license', 'custom');
    await expect(page.locator('#edit-license-book option[value="__new__"]')).toHaveCount(1, { timeout: 10_000 });
    await page.selectOption('#edit-license-book', '__new__');
    await page.fill('#edit-new-license-title', title);
    await page.fill('#edit-new-license-text', `${title} — the terms.\n\n${v1}`);
    const created = page.waitForResponse((r) => r.url().endsWith('/api/license-books') && r.request().method() === 'POST');
    await page.click('#edit-create-license-book');
    const body = await (await created).json();
    expect(body.success, `licence page creation: ${body.message ?? ''}`).toBe(true);
    licenseBook = body.book;
    await expect(page.locator('#edit-license-book')).toHaveValue(licenseBook);

    await saveEditForm(page);
    await expectLine(page, title, `/${licenseBook}`);
    const row = await storedLicense(page, WORK_A);
    expect(row.license).toBe('custom');
    expect(row.license_book).toBe(licenseBook);
    expect(Number(row.license_book_at)).toBeGreaterThan(0);
    expect((await anonHead(browser, `/${WORK_A}`)).licenseHref).toBe(abs(`/${licenseBook}`));
  });

  await test.step('the licence link opens the licence page, including for a logged-out reader', async () => {
    const [popup] = await Promise.all([page.waitForEvent('popup'), licenseLink(page).click()]);
    await popup.waitForLoadState('networkidle');
    await expect(popup.locator('.main-content')).toContainText(v1, { timeout: 15_000 });
    await popup.close();

    const anon = await browser.newContext({ ignoreHTTPSErrors: true, serviceWorkers: 'block' });
    const ap = await anon.newPage();
    await ap.goto(`${BASE}/${licenseBook}`);
    await expect(ap.locator('.main-content')).toContainText(v1, { timeout: 20_000 });
    await anon.close();
  });

  await test.step('reuse it on work B from "Your licences"', async () => {
    await openSourcePanel(page, WORK_B);
    await openEditForm(page);
    await page.selectOption('#edit-license', 'custom');
    const option = page.locator(`#edit-license-book optgroup[label="Your licences"] option[value="${licenseBook}"]`);
    await expect(option).toHaveCount(1, { timeout: 10_000 });
    await page.selectOption('#edit-license-book', licenseBook);
    await saveEditForm(page);
    await expectLine(page, title, `/${licenseBook}`);
  });

  // ── Change the licence terms (the same unified-sync write the editor makes) ──
  await test.step('editing the licence terms pins earlier works to the terms they were published under', async () => {
    await page.goto(`${BASE}/${licenseBook}`);
    await page.waitForLoadState('networkidle');
    const data = await page.evaluate(async (b) => {
      const r = await fetch(`/api/database-to-indexeddb/books/${b}/data`, { headers: { Accept: 'application/json' } });
      return r.json();
    }, licenseBook);
    const node = data.nodes.find((n) => n.content.includes(v1));
    expect(node, 'licence page holds the v1 paragraph').toBeTruthy();
    const lib = await storedLicense(page, licenseBook);

    // Pins are ms; make sure the edit lands strictly after them.
    await page.waitForTimeout(50);
    const write = await postJson(page, '/api/db/unified-sync', {
      book: licenseBook,
      base_timestamp: Number(lib.timestamp),
      nodes: [{ ...node, content: node.content.replace(v1, v2), plainText: v2, _action: 'upsert' }],
      library: { book: licenseBook, timestamp: Date.now() },
    });
    expect(write.ok, `licence terms edit (HTTP ${write.status}) ${JSON.stringify(write.body)?.slice(0, 200)}`).toBeTruthy();

    await openSourcePanel(page, WORK_A);
    await expect(licenseLine(page)).toContainText('since updated');
    const href = await licenseLink(page).getAttribute('href');
    expect(href).toMatch(new RegExp(`^/${licenseBook}/timemachine\\?at=`));
    expect((await anonHead(browser, `/${WORK_A}`)).licenseHref).toBe(abs(href));

    // The pinned link shows the OLD terms — to a logged-out reader too.
    const anon = await browser.newContext({ ignoreHTTPSErrors: true, serviceWorkers: 'block' });
    const ap = await anon.newPage();
    await ap.goto(`${BASE}${href}`);
    await expect(ap.locator('.main-content')).toContainText(v1, { timeout: 20_000 });
    await expect(ap.locator('.main-content')).not.toContainText(v2);
    await anon.close();

    // And the live licence page shows the NEW terms.
    const anon2 = await browser.newContext({ ignoreHTTPSErrors: true, serviceWorkers: 'block' });
    const ap2 = await anon2.newPage();
    await ap2.goto(`${BASE}/${licenseBook}`);
    await expect(ap2.locator('.main-content')).toContainText(v2, { timeout: 20_000 });
    await anon2.close();
  });

  await test.step('"apply current terms to all" from the licence page moves both works onto the new terms', async () => {
    await openSourcePanel(page, licenseBook);
    await openEditForm(page);
    const usage = page.locator('#license-book-usage');
    await expect(usage).toContainText('licence of 2 of your works', { timeout: 10_000 });
    await expect(usage).toContainText('2 still under earlier terms');
    await usage.locator('#license-book-reapply').click();
    await expect(usage).toContainText('All 2 works now use the current terms');

    for (const work of [WORK_A, WORK_B]) {
      await openSourcePanel(page, work);
      await expectLine(page, title, `/${licenseBook}`);
      await expect(licenseLine(page)).not.toContainText('since updated');
      expect((await anonHead(browser, `/${work}`)).licenseHref).toBe(abs(`/${licenseBook}`));
    }
  });
});
