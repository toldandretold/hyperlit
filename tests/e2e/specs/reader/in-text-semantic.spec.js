import { test, expect } from '../../fixtures/navigation.fixture.js';

/**
 * In-text search: the exact/meaning mode toggle, driven by real gestures.
 *
 * Unit coverage for the mode seam lives in
 * tests/javascript/search/inTextSearchModes.test.js (ordering, availability,
 * abort, handoff). What can only be checked here is that the two halves actually
 * meet: the toggle the blade partial renders reaches the registry-managed
 * toolbar, the request goes out scoped to the open book, and a semantic hit
 * paints a node tint rather than a <mark>.
 *
 * A freshly authored book has NO embeddings (they are generated on their own
 * queue lane, after the fact), so the semantic assertions stub
 * /api/search/in-book. That is deliberate: this spec is about the client wiring,
 * and the server contract is locked by
 * tests/Feature/Api/InBookSemanticSearchTest.php against real pgvector rows.
 *
 * e2e is MANUAL (npm run test:e2e) and not in CI.
 */

const SEARCH_BUTTON = '#searchButton';
const TOOLBAR = '#search-toolbar';

/** Author a small book and drop back into read mode (search runs in the reader). */
async function buildBook(page, spa) {
  await spa.createNewBook(page, spa);

  await page.click('h1[id="100"]');
  await page.keyboard.type('Crisis Theory');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(150);

  const paragraphs = [
    'The tendency of the rate of profit to fall follows from the rising organic composition of capital.',
    'Primitive accumulation was the historical separation of producers from the means of production.',
    'Overproduction is not a failure of planning but a consequence of expanded reproduction.',
  ];
  for (const p of paragraphs) {
    await page.keyboard.type(p);
    await page.keyboard.press('Enter');
  }
  await page.waitForTimeout(300);

  await page.evaluate(() => document.getElementById('editButton')?.click());
  await page.waitForFunction(() => window.isEditing === false, null, { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(500);
}

/** Open the find bar the way a user does: settings panel → search. */
async function openToolbar(page) {
  await page.evaluate(() => document.getElementById('settingsButton')?.click());
  await page.waitForTimeout(250);
  await page.click(SEARCH_BUTTON);
  await expect(page.locator(`${TOOLBAR}.visible`)).toBeAttached({ timeout: 10_000 });
}

/** The ids of the rendered nodes, in document order. */
function renderedNodeIds(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll('.main-content p[id]')]
      .map(e => e.id)
      .filter(id => /^\d+(\.\d+)?$/.test(id))
  );
}

/**
 * Locator for a node by its LineId.
 *
 * MUST be an attribute selector, never `#${id}`: a node's id IS its position, so
 * it is a decimal-shaped string ("200", "100.5"), and CSS forbids an identifier
 * starting with a digit — `#200` throws
 * "'#200' is not a valid selector" rather than just not matching. Same hazard the
 * unit suite works around with installDecimalIdSelectorShim().
 */
function node(page, id, extra = '') {
  return page.locator(`[id="${id}"]${extra}`);
}

test('exact mode marks the literal string; meaning mode tints whole nodes', async ({ page, spa }) => {
  test.setTimeout(120_000);

  await buildBook(page, spa);
  const ids = await renderedNodeIds(page);
  test.skip(ids.length < 3, 'book did not render the expected paragraphs');

  await openToolbar(page);

  // The toggle is rendered on the reader (the feed pages' partial omits it).
  const toggle = page.locator('#search-mode-toggle');
  await expect(toggle).toBeVisible();
  await expect(page.locator('.search-mode-toggle-btn[data-search-mode="exact"]')).toHaveClass(/active/);

  // --- exact mode: a real <mark> around the literal substring ---------------
  await page.fill('#search-input', 'overproduction');
  await expect(page.locator('mark.search-highlight.current')).toBeAttached({ timeout: 10_000 });
  await expect(page.locator('.semantic-match')).toHaveCount(0);

  // --- meaning mode: node tints, no <mark> ---------------------------------
  // Stub the endpoint: a book authored seconds ago has no embeddings yet.
  const requested = [];
  await page.route('**/api/search/in-book**', async (route) => {
    requested.push(route.request().url());
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      // Deliberately ranked BEST-FIRST and out of document order — the toolbar
      // must re-sort so ▲▼ walks the book top to bottom. chunk_id is a STRING
      // because that is what the wire carries (Postgres serializes the numeric
      // column as one); left uncoerced it never matches currentlyLoadedChunks.
      body: JSON.stringify({
        success: true,
        mode: 'semantic',
        count: 2,
        results: [
          { node_id: 'n3', startLine: ids[2], chunk_id: '0', excerpt: 'overproduction', similarity: 0.84, match: 54 },
          { node_id: 'n1', startLine: ids[0], chunk_id: '0', excerpt: 'rate of profit', similarity: 0.71, match: 17 },
        ],
      }),
    });
  });

  await page.click('.search-mode-toggle-btn[data-search-mode="semantic"]');
  await page.fill('#search-input', 'why capitalism keeps breaking down');

  await expect(page.locator('.semantic-match')).toHaveCount(2, { timeout: 15_000 });

  // The request carried the open book.
  const bookId = await page.evaluate(() => document.body.getAttribute('data-book'));
  expect(requested.some(u => u.includes(encodeURIComponent(bookId)))).toBe(true);

  // Whole-node tinting with the match % in a data attribute — and crucially no
  // <mark> surgery inside the prose.
  await expect(node(page, ids[0])).toHaveAttribute('data-semantic-match', '17');
  await expect(node(page, ids[2])).toHaveAttribute('data-semantic-match', '54');
  await expect(page.locator('mark.search-highlight')).toHaveCount(0);

  // Document order, not similarity order: the FIRST match is the earlier node
  // even though the server ranked the later one higher.
  await expect(page.locator('#search-match-counter')).toHaveText(/of 2/);
  await expect(node(page, ids[0], '.semantic-match.current')).toBeAttached();

  // ▲▼ advances down the book.
  await page.click('#search-next-button');
  await expect(node(page, ids[2], '.semantic-match.current')).toBeAttached({ timeout: 10_000 });

  // --- closing leaves nothing behind ---------------------------------------
  await page.keyboard.press('Escape');
  await expect(page.locator(`${TOOLBAR}.visible`)).not.toBeAttached({ timeout: 10_000 });
  await expect(page.locator('.semantic-match')).toHaveCount(0);
  await expect(page.locator('mark.search-highlight')).toHaveCount(0);
});

test('the toggle is absent on a feed page, whose book is never embedded', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');

  await page.evaluate(() => document.getElementById('settingsButton')?.click());
  await page.waitForTimeout(250);

  const searchButton = page.locator(SEARCH_BUTTON);
  test.skip(!(await searchButton.count()), 'no search entry point on this home layout');

  await searchButton.click();
  await expect(page.locator(`${TOOLBAR}.visible`)).toBeAttached({ timeout: 10_000 });

  // The partial renders without the toggle here — the homepage feed is a
  // synthetic card-list book, excluded by EmbeddingEligibility, so semantic
  // could only ever return nothing.
  await expect(page.locator('#search-mode-toggle')).toHaveCount(0);
});
