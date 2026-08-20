import { test, expect } from '../../fixtures/navigation.fixture.js';
import { dropFilesOnWindow } from '../../helpers/dropFile.js';
import { generateLongMarkdown } from '../../helpers/bookContent.js';
import { readFileSync } from 'fs';
import { resolve } from 'path';

/**
 * Import-batch queue workflow — the full multi-file UX:
 *
 *   - Dropping SEVERAL documents at once routes to the batch importer
 *     (no cite-form), shows the "Importing N texts…" drop-overlay card,
 *     and brings up the corner import-queue widget (pill + panel).
 *   - The widget tracks per-item progress to completion ("✓ N imported").
 *   - Obsidian-vault semantics: each .md becomes its own book; an image
 *     referenced by BOTH notes (standard syntax in one, wikilink embed in
 *     the other) renders in BOTH books; wikilink image embeds are rewritten
 *     client-side so they survive conversion.
 *   - Auto-shelf: the batch gets a shelf, and the widget's "View shelf" link
 *     deep-links to it — a PRIVATE shelf must open for its owner (regression:
 *     activeShelfId used to resolve against public shelves only, so the link
 *     landed on plain user home).
 *   - The form's file picker with multiple documents routes to the same
 *     batch path; a finished batch can be dismissed from the panel.
 *
 * Fixture: tests/e2e/fixtures/import-batch-folder/ — a mini Obsidian-style
 * vault (2 notes + shared/solo/orphan attachments). It's a REAL folder on
 * disk, so you can also drag it into a browser by hand to test the
 * webkitGetAsEntry directory-traversal path, which synthetic DataTransfer
 * drops cannot reach (they carry loose files; image routing is
 * basename-based, so the covered logic is the same).
 *
 * Manual run: npm run test:e2e -- import-batch-queue (needs dev:all — a
 * default-queue worker must be running or imports sit at "Waiting to start").
 */

const FIXTURE_DIR = resolve(import.meta.dirname, '../../fixtures/import-batch-folder');

// The slow-import test injects a header via page.route — a registered service
// worker would hide those requests from route interception (see the audio
// harness gotcha), so block SWs for this file.
test.use({ serviceWorkers: 'block' });

function fixtureFiles() {
  const md = (name) => ({
    name,
    type: 'text/markdown',
    content: readFileSync(resolve(FIXTURE_DIR, name), 'utf-8'),
  });
  const png = (name) => ({
    name,
    type: 'image/png',
    contentBase64: readFileSync(resolve(FIXTURE_DIR, 'attachments', name)).toString('base64'),
  });
  return [
    md('note-alpha.md'),
    md('note-beta.md'),
    png('shared-figure.png'),
    png('alpha-only.png'),
    png('orphan.png'),
  ];
}

/**
 * Dismiss every lingering batch of the shared e2e user. The widget already
 * hides stale terminal batches (session-scoped), but residue from ABORTED
 * runs can carry still-"active" items (queued rows whose job is long gone)
 * that would pollute this run's pill counts.
 */
async function dismissAllBatches(page) {
  await page.evaluate(async () => {
    const resp = await fetch('/api/my-imports', { credentials: 'include', headers: { Accept: 'application/json' } });
    if (!resp.ok) return;
    const data = await resp.json();
    const csrf = document.querySelector('meta[name="csrf-token"]')?.content;
    for (const b of data.batches || []) {
      await fetch(`/api/import-batches/${b.id}/dismiss`, {
        method: 'POST',
        headers: { 'X-CSRF-TOKEN': csrf, Accept: 'application/json' },
        credentials: 'include',
      });
    }
  });
}

test.describe('Import batch queue (multi-file / vault UX)', () => {
  test('vault drop → widget progress → completion → shelf deep link → images in both books', async ({ page, spa }) => {
    test.setTimeout(420_000);

    // ──────────────────────────────────────────────────────────
    // Phase 1: home loads with the widget + drop target registered
    // ──────────────────────────────────────────────────────────
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    expect(await spa.getStructure(page)).toBe('home');
    await dismissAllBatches(page);

    const registry = await spa.getRegistryStatus(page);
    expect(registry?.activeComponents).toContain('fileDropTarget');
    expect(registry?.activeComponents).toContain('importQueue');

    // ──────────────────────────────────────────────────────────
    // Phase 2: drop the whole vault (2 notes + 3 images) at once
    // ──────────────────────────────────────────────────────────
    await dropFilesOnWindow(page, fixtureFiles());

    // ──────────────────────────────────────────────────────────
    // Phase 3: the widget appears IMMEDIATELY, already expanded — the
    // progress plays out in place (no "check the corner" hint card), and the
    // import form never opens.
    // ──────────────────────────────────────────────────────────
    const pill = page.locator('.import-queue-pill');
    const panel = page.locator('.import-queue-panel');
    await expect(pill).toBeVisible({ timeout: 15_000 });
    await expect(panel).toBeVisible({ timeout: 15_000 });
    await expect(pill).toHaveText(/Importing 2 texts/, { timeout: 15_000 });
    expect(await page.evaluate(() => !!document.getElementById('cite-form'))).toBe(false);

    // Real per-item rows replace the preparing placeholder once the batch
    // registers and the first poll lands.
    await expect(panel.locator('.import-queue-row:not(.import-queue-preparing)')).toHaveCount(2, { timeout: 30_000 });

    // Both conversions run through the serial default-queue worker.
    await expect(pill).toHaveText(/✓ 2 imported/, { timeout: 300_000 });

    // Panel is stable now (polling stopped) — re-open if the re-render collapsed it.
    if (!(await panel.isVisible())) await pill.click();
    const completedLinks = panel.locator('.import-queue-row[data-status="complete"] a');
    await expect(completedLinks).toHaveCount(2);
    const alphaHref = await completedLinks.filter({ hasText: /alpha/i }).first().getAttribute('href');
    const betaHref = await completedLinks.filter({ hasText: /beta/i }).first().getAttribute('href');
    expect(alphaHref).toBeTruthy();
    expect(betaHref).toBeTruthy();

    // ──────────────────────────────────────────────────────────
    // Phase 4: "View shelf" deep-links into the (private) auto-shelf
    // ──────────────────────────────────────────────────────────
    const shelfLink = panel.locator('a', { hasText: 'View shelf' });
    await expect(shelfLink).toBeVisible();
    const shelfHref = await shelfLink.getAttribute('href');
    expect(shelfHref).toMatch(/\/u\/[^/]+\/shelf\/[^/]+/);

    // data-full-nav → full page load (the deep link needs the blade's inline script).
    await Promise.all([
      page.waitForURL(/\/u\/[^/]+\/shelf\//, { timeout: 30_000 }),
      shelfLink.click(),
    ]);
    await page.waitForLoadState('domcontentloaded');

    // The shelf actually OPENS: a dynamic shelf tab is active (not plain user home)…
    await page.waitForSelector('.shelf-tab.active', { timeout: 30_000 });
    // …and its content lists both imported books.
    await page.waitForFunction(() => {
      const text = document.querySelector('.main-content')?.textContent || '';
      return /alpha/i.test(text) && /beta/i.test(text);
    }, null, { timeout: 60_000 });
    // Let the user page's boot fetches settle before navigating away — a goto
    // mid-boot aborts them and the aborted fetch trips the console-error gate
    // (the known nav-aborted-fetch flake class).
    await page.waitForLoadState('networkidle');

    // ──────────────────────────────────────────────────────────
    // Phase 5: vault image routing — the SHARED image is in BOTH books
    // ──────────────────────────────────────────────────────────
    for (const [href, expectedImages] of [[alphaHref, 2], [betaHref, 1]]) {
      await page.goto(href);
      await page.waitForFunction(
        () => document.body.getAttribute('data-page') === 'reader',
        null,
        { timeout: 60_000 }
      );
      await page.waitForSelector('.main-content img[src*="/media/"]', { timeout: 30_000 });
      const mediaImgs = await page.locator('.main-content img[src*="/media/"]').count();
      expect(mediaImgs).toBe(expectedImages);
      // Images actually load (the URL-encoded media path resolves).
      const broken = await page.evaluate(() =>
        Array.from(document.querySelectorAll('.main-content img[src*="/media/"]'))
          .filter((img) => img.complete && img.naturalWidth === 0).length
      );
      expect(broken).toBe(0);
      // Same settle before the next goto (reader boot fetches).
      await page.waitForLoadState('networkidle');
    }

    expect(spa.filterConsoleErrors(page.consoleErrors)).toHaveLength(0);
  });

  test('form picker with several documents routes to the batch; finished batch dismisses', async ({ page, spa }) => {
    test.setTimeout(420_000);

    await page.goto('/');
    await page.waitForLoadState('networkidle');
    expect(await spa.getStructure(page)).toBe('home');
    await dismissAllBatches(page);

    // Open the import form and pick BOTH notes via the real file input.
    await page.evaluate(() => document.getElementById('importBook')?.click());
    await page.waitForSelector('#cite-form', { timeout: 5_000 });
    await page.setInputFiles('#markdown_file', [
      resolve(FIXTURE_DIR, 'note-alpha.md'),
      resolve(FIXTURE_DIR, 'note-beta.md'),
    ]);
    // The submit handler is wired by a DYNAMIC import after the form renders
    // (buttonView.ts) — submitting before it lands would be a no-op (native
    // submission is blocked in that window). Wait for the real handler.
    await page.waitForFunction(
      () => document.getElementById('cite-form')?._hasSubmitHandler === true,
      null,
      { timeout: 10_000 }
    );
    await page.click('#createButton');

    // Routed to the batch importer: the widget takes over as the UI.
    const pill = page.locator('.import-queue-pill');
    await expect(pill).toBeVisible({ timeout: 30_000 });

    await expect(pill).toHaveText(/✓ 2 imported/, { timeout: 300_000 });

    // Dismiss the finished batch from the panel — the pill goes away.
    // (The panel opens expanded on batch start; only click the pill if a
    // re-render or earlier toggle left it collapsed.)
    const panel = page.locator('.import-queue-panel');
    if (!(await panel.isVisible())) await pill.click();
    await expect(panel).toBeVisible();
    await panel.locator('button', { hasText: 'Dismiss' }).click();
    await expect(pill).toBeHidden({ timeout: 15_000 });

    expect(spa.filterConsoleErrors(page.consoleErrors)).toHaveLength(0);
  });

  test('a file dropped while another import is processing queues behind it', async ({ page, spa }) => {
    test.setTimeout(420_000);

    // Hold import A in 'processing' for a deterministic window: even a
    // 120k-word markdown converts in seconds, so the drop below kept racing
    // the card. The X-Test-Slow-Import header (env-gated, local/testing only)
    // makes the job sleep before converting. Injected via route interception
    // so no client code carries test headers.
    await page.route('**/import-file', (route) => route.continue({
      headers: { ...route.request().headers(), 'X-Test-Slow-Import': '30' },
    }));

    await page.goto('/');
    await page.waitForLoadState('networkidle');
    expect(await spa.getStructure(page)).toBe('home');
    await dismissAllBatches(page);

    // Import A via the normal single-file form flow.
    await dropFilesOnWindow(page, [{
      name: 'big-first-import.md',
      type: 'text/markdown',
      content: generateLongMarkdown({
        title: 'Big First Import',
        chapters: 6,
        paragraphsPerChapter: 4,
        wordsPerParagraph: 60,
      }),
    }]);
    await page.waitForSelector('#cite-form', { timeout: 10_000 });
    await page.waitForFunction(
      () => document.getElementById('cite-form')?._hasSubmitHandler === true,
      null,
      { timeout: 10_000 }
    );
    await page.click('#createButton');

    // A is running: the in-form progress card is up (the file input is gone).
    await page.waitForSelector('#import-progress-bar', { timeout: 60_000 });

    // Drop file B NOW. The old behaviour silently discarded it (the form-open
    // branch found no #markdown_file to attach to); it must instead queue as
    // a batch behind A, with the corner widget as its UI.
    await dropFilesOnWindow(page, [{
      name: 'queued-second.md',
      type: 'text/markdown',
      content: '# Queued Second\n\nDropped while the first import was processing.',
    }]);

    const pill = page.locator('.import-queue-pill');
    await expect(pill).toBeVisible({ timeout: 30_000 });

    // A completes → the import flow opens its book (reader). B keeps running
    // server-side; the widget's module state survives the navigation.
    await page.waitForFunction(
      () => document.body.getAttribute('data-page') === 'reader',
      null,
      { timeout: 300_000 }
    );
    await spa.waitForTransition(page, { timeout: 60_000 });
    expect(await spa.getStructure(page)).toBe('reader');

    // Back home (dismiss A's conversion-feedback toast first — it overlaps
    // the logo nav trigger): the widget resumes and B finishes.
    await spa.dismissConversionFeedbackToast(page);
    await spa.navigateToHome(page);
    await spa.waitForTransition(page);
    expect(await spa.getStructure(page)).toBe('home');

    const pillAfterNav = page.locator('.import-queue-pill');
    await expect(pillAfterNav).toBeVisible({ timeout: 30_000 });
    await expect(pillAfterNav).toHaveText(/✓ 1 imported/, { timeout: 300_000 });

    // B's book is real and openable from the panel (which may already be
    // expanded — the drop opened it that way and the state survives SPA nav).
    const panelAfterNav = page.locator('.import-queue-panel');
    if (!(await panelAfterNav.isVisible())) await pillAfterNav.click();
    const completedLink = panelAfterNav.locator('.import-queue-row[data-status="complete"] a');
    await expect(completedLink).toHaveCount(1);
    expect(await completedLink.getAttribute('href')).toBeTruthy();

    expect(spa.filterConsoleErrors(page.consoleErrors)).toHaveLength(0);
  });

  test('multiple users importing at once: your imports wait their turn behind others', async ({ page, spa, browser }) => {
    test.setTimeout(420_000);

    // ──────────────────────────────────────────────────────────
    // User B — a STRANGER in a second browser context — registers a
    // throwaway account and floods the conversion queue with slow imports
    // (the test-only X-Test-Slow-Import header holds each in 'processing').
    // Five imports saturate every dev worker and leave a real backlog.
    // ──────────────────────────────────────────────────────────
    const ctxB = await browser.newContext({ ignoreHTTPSErrors: true, serviceWorkers: 'block' });
    const pageB = await ctxB.newPage();
    await pageB.goto('/', { waitUntil: 'domcontentloaded' });

    const bName = `qtest${Date.now().toString(36)}`;
    const registered = await pageB.evaluate(async (name) => {
      await fetch('/sanctum/csrf-cookie', { credentials: 'include' });
      const xsrf = decodeURIComponent((document.cookie.match(/XSRF-TOKEN=([^;]+)/) || [])[1] || '');
      const resp = await fetch('/api/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-XSRF-TOKEN': xsrf },
        credentials: 'include',
        body: JSON.stringify({ name, email: `${name}@e2e.test`, password: 'password123' }),
      });
      return resp.ok;
    }, bName);
    expect(registered).toBe(true);

    const flooded = await pageB.evaluate(async (name) => {
      const xsrf = decodeURIComponent((document.cookie.match(/XSRF-TOKEN=([^;]+)/) || [])[1] || '');
      let ok = 0;
      for (let i = 0; i < 5; i++) {
        const fd = new FormData();
        fd.append('book', `${name}flood${i}`);
        fd.append('title', `Flood ${i}`);
        fd.append('markdown_file[]', new File([`# Flood ${i}\n\nQueue filler from another user.`], `flood-${i}.md`, { type: 'text/markdown' }));
        const resp = await fetch('/import-file', {
          method: 'POST',
          headers: { Accept: 'application/json', 'X-XSRF-TOKEN': xsrf, 'X-Test-Slow-Import': '40' },
          credentials: 'include',
          body: fd,
        });
        if (resp.ok) ok++;
      }
      return ok;
    }, bName);
    expect(flooded).toBe(5);

    // ──────────────────────────────────────────────────────────
    // User A (the real session) imports while the strangers hold the queue.
    // ──────────────────────────────────────────────────────────
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    expect(await spa.getStructure(page)).toBe('home');
    await dismissAllBatches(page);

    // Just the two notes (no images) — the vault path with an empty image set.
    await dropFilesOnWindow(page, fixtureFiles().filter((f) => f.name.endsWith('.md')));

    const pill = page.locator('.import-queue-pill');
    const panel = page.locator('.import-queue-panel');
    await expect(panel).toBeVisible({ timeout: 15_000 });

    // The multi-user state: none of A's items are processing, strangers'
    // jobs sit ahead — the pill and the panel banner both say so. (RLS keeps
    // B's batches invisible to A; only the POSITION leaks, by design.)
    await expect(pill).toHaveText(/In queue — \d+ ahead/, { timeout: 60_000 });
    await expect(panel.locator('.import-queue-waiting')).toBeVisible();
    await expect(panel.locator('.import-queue-waiting')).toContainText(/in the queue before your turn/);

    // FIFO drains: the strangers' imports finish, then A's run and complete.
    await expect(pill).toHaveText(/✓ 2 imported/, { timeout: 300_000 });

    await ctxB.close();
    expect(spa.filterConsoleErrors(page.consoleErrors)).toHaveLength(0);
  });
});
