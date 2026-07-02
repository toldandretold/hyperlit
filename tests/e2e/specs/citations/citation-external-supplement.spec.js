/**
 * Citation modal — external supplementation (OpenAlex / Open Library) loop.
 *
 * When local results are thin the server dispatches a background ingest job and
 * responds external_pending=true; the modal shows "searching external
 * databases…" and polls the same query up to 3× at 2.5s intervals, folding new
 * canonicals in when the job lands.
 *
 * Two layers:
 *  1. Deterministic (always runs): route-mocks /api/search/combined and proves
 *     the SHIPPED BROWSER BUNDLE does the loop — indicator, automatic polls,
 *     early stop when results land, cancellation on retype.
 *  2. Full-real (opt-in E2E_EXTERNAL=1): no mocks. Requires a running queue
 *     worker on the search-supplement queue and hits real OpenAlex/Open Library.
 *     This is the test that catches a dead worker or a retry/job race.
 */

import { test, expect } from '../../fixtures/navigation.fixture.js';
import {
  findCitableParagraph,
  openCitationModal,
} from '../../helpers/citationModal.js';

const READER_BOOK = process.env.E2E_READER_BOOK || 'book_1777271888985';

/** Response envelope matching SearchController::searchWithOpenAlex. */
function combinedEnvelope(results, externalPending, externalStatus = null) {
  return {
    success: true,
    results,
    query: 'ignored',
    mode: 'combined',
    count: results.length,
    has_more: false,
    offset: 0,
    external_ingested: 0,
    external_pending: externalPending,
    external_status: externalStatus ?? (externalPending ? 'dispatched' : null),
  };
}

/** A canonical-only row shaped like shapeCitationResult's output. */
const INGESTED_ROW = {
  row_type: 'canonical',
  id: 'e2e-canonical-1',
  book: '',
  canonical_source_id: 'e2e-canonical-1',
  title: 'The Selfish Gene (e2e external fixture)',
  author: 'Richard Dawkins',
  year: '1976',
  journal: null,
  bibtex: '@misc{e2e, author = {Richard Dawkins}, year = {1976}, title = {The Selfish Gene}}',
  has_version: false,
  has_nodes: false,
  is_private: false,
  source: 'canonical-only',
};

async function openModalOnTestBook(page) {
  await page.goto(`/${READER_BOOK}`);
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForSelector('.main-content', { timeout: 20_000 });
  const sel = await findCitableParagraph(page, 40);
  if (!sel) test.skip(true, 'no citable paragraph in test book');
  await openCitationModal(page, sel, 10);
}

test.describe('Citation modal — external supplement loop (mocked server)', () => {
  test('shows searching state, polls automatically, folds results in, stops', async ({ page }) => {
    const seen = [];
    await page.route('**/api/search/combined*', async (route) => {
      const url = new URL(route.request().url());
      seen.push(url.searchParams.get('q'));
      const n = seen.length;
      // 1st: thin local page, ingest dispatched. 2nd (poll): job not done yet.
      // 3rd (poll): ingested canonical has landed.
      const body =
        n === 1 ? combinedEnvelope([], true)
        : n === 2 ? combinedEnvelope([], false)
        : combinedEnvelope([INGESTED_ROW], false);
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
    });

    await openModalOnTestBook(page);
    await page.fill('#citation-search-input', 'dawkins selfish');

    // Phase 1: first response → searching-external indicator, not "No results".
    await expect(page.locator('#citation-toolbar-results .citation-search-loading'))
      .toContainText(/searching external databases/i, { timeout: 5_000 });

    // Phase 2: polls fire on their own (2.5s apart) — no user interaction.
    await expect
      .poll(() => seen.length, { timeout: 10_000, message: 'modal never polled the query' })
      .toBeGreaterThanOrEqual(3);

    // Phase 3: the ingested canonical renders.
    await expect(page.locator('.citation-result-item'))
      .toContainText(/Selfish Gene/i, { timeout: 5_000 });

    // Phase 4: polling stopped once results grew — no 4th request.
    await page.waitForTimeout(4_000);
    expect(seen.length).toBe(3);
    // Every request was the same first-page query.
    expect(seen.every((q) => q === 'dawkins selfish')).toBe(true);
  });

  test('polling gives up after 3 attempts and reports the still-searching state honestly', async ({ page }) => {
    const seen = [];
    await page.route('**/api/search/combined*', async (route) => {
      seen.push(1);
      // Dispatch on the first request; every poll stays empty with the job
      // still unfinished (status 'pending' — e.g. stuck behind an import).
      const body = seen.length === 1
        ? combinedEnvelope([], true)
        : combinedEnvelope([], false, 'pending');
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
    });

    await openModalOnTestBook(page);
    await page.fill('#citation-search-input', 'nothing anywhere');

    // 1 initial + 3 polls, then silence.
    await expect
      .poll(() => seen.length, { timeout: 15_000 })
      .toBe(4);
    await page.waitForTimeout(4_000);
    expect(seen.length).toBe(4);

    // Final state: the honest still-searching empty message.
    await expect(page.locator('#citation-toolbar-results .citation-search-empty'))
      .toContainText(/still searching external databases/i);
  });

  test('sources_failed is reported as unreachable databases, not a bare no-results', async ({ page }) => {
    await page.route('**/api/search/combined*', async (route) => {
      // Retype inside the dedup window after a failed ingest: recorded outcome.
      const body = combinedEnvelope([], false, 'sources_failed');
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
    });

    await openModalOnTestBook(page);
    await page.fill('#citation-search-input', 'doomed query');

    await expect(page.locator('#citation-toolbar-results .citation-search-empty'))
      .toContainText(/external databases are currently unreachable/i, { timeout: 5_000 });
  });

  test('typing a new query cancels the poll chain for the old one', async ({ page }) => {
    const seen = [];
    await page.route('**/api/search/combined*', async (route) => {
      const url = new URL(route.request().url());
      const q = url.searchParams.get('q');
      seen.push(q);
      // First query dispatches an ingest; the replacement query is plain-empty.
      const body = combinedEnvelope([], q === 'first query');
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
    });

    await openModalOnTestBook(page);
    await page.fill('#citation-search-input', 'first query');
    await expect.poll(() => seen.length, { timeout: 5_000 }).toBeGreaterThanOrEqual(1);

    // Retype before the first poll (2.5s) fires.
    await page.fill('#citation-search-input', 'second query');

    // Give any stale poll ample time, then check: 'first query' was fetched
    // exactly once — its poll chain died with the retype.
    await page.waitForTimeout(6_000);
    expect(seen.filter((q) => q === 'first query')).toHaveLength(1);
    expect(seen.filter((q) => q === 'second query').length).toBeGreaterThanOrEqual(1);
  });
});

test.describe('Citation modal — external supplement loop (REAL stack)', () => {
  test('a thin query is supplemented from real external APIs via the queue worker', async ({ page }) => {
    test.skip(
      process.env.E2E_EXTERNAL !== '1',
      'Set E2E_EXTERNAL=1 to run the full-real external loop (needs a worker serving the search-supplement queue — `npm run dev:all` or `php artisan queue:work --queue=search-supplement`; hits real OpenAlex/Open Library and writes canonical_source rows).'
    );
    test.setTimeout(90_000);

    await openModalOnTestBook(page);

    // Real-but-obscure query: likely absent from the local corpus, findable on
    // OpenAlex. Once it HAS been ingested locally, this spec self-skips (the
    // external gate won't fire again) — clear those canonical_source rows or
    // change the query to re-exercise the loop.
    const query = process.env.E2E_EXTERNAL_QUERY || 'reinhold letters kantian philosophy';

    const responsePromise = page.waitForResponse(
      (res) => res.url().includes('/api/search/combined'),
      { timeout: 15_000 }
    );
    await page.fill('#citation-search-input', query);
    const first = await (await responsePromise).json();

    if ((first.results?.length ?? 0) >= 15) {
      test.skip(true, `local corpus already returns a full page for "${query}" — pick a rarer E2E_EXTERNAL_QUERY`);
    }
    if (first.external_pending !== true) {
      test.skip(true, `external gate did not fire for "${query}" (dedup window active or corpus already supplemented) — wait ~15min, clear the canonical rows, or change E2E_EXTERNAL_QUERY`);
    }

    // The searching indicator should be up while the job runs.
    await expect(page.locator('#citation-toolbar-results .citation-search-loading'))
      .toContainText(/searching external databases/i, { timeout: 5_000 });

    // Real proof: results from OpenAlex/Open Library fold into the modal.
    // Polls run at 2.5s/5s/7.5s; a cold external fetch usually lands within that.
    // Diagnosis order when this fails: (1) no worker serving the
    // search-supplement queue (npm run dev:all / queue:work --queue=search-supplement);
    // (2) failed_jobs table; (3) the sources genuinely had nothing — OpenAlex
    // 503s happen, and Open Library returns [] for author+title phrases it
    // can't parse (e.g. "hofstadter godel escher bach") — try a plainer
    // E2E_EXTERNAL_QUERY like "carl sagan cosmos".
    await expect(
      page.locator('.citation-result-item'),
      'external results never arrived — is a worker serving the search-supplement queue? (npm run dev:all, or php artisan queue:work --queue=search-supplement) Check failed_jobs; or the external sources may have returned no candidates for this query (try another E2E_EXTERNAL_QUERY).'
    ).not.toHaveCount(0, { timeout: 30_000 });
  });
});
