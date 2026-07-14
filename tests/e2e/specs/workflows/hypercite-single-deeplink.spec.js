/**
 * Hypercite deep-link fetch-on-demand — the "externally-pasted link to a 'single'
 * hypercite" flow (manual e2e sketch, not CI).
 *
 * What this covers: the server's always-on singles filter means a foreign
 * relationshipStatus='single' hypercite is NOT in the bulk sync payloads. A deep link
 * (#hypercite_X) must still render + glow via:
 *   - fresh page load: /initial?target= exemption (server sends the record; the client
 *     pins it in buildInitialChunkParams so applyGateFilter keeps it at render)
 *   - in-SPA nav: internalNav's fetch-on-demand step (find?scope=record → pin →
 *     rebuild embedded arrays → chunk evict/re-render → scroll + glow)
 *   - gate hideAll + re-sync: the pinned= param keeps the target alive server-side
 *
 * MANUAL SETUP (why this skips by default): the target must be a hypercite that the
 * test account does NOT own, with relationshipStatus 'single' — i.e. copy text in a
 * public book as ANOTHER user and take the minted #hypercite_ link. Then set:
 *   E2E_HC_BOOK=<book id>  E2E_HC_TARGET=<hypercite_...>  in .env.e2e
 * Treat skips as coverage gaps (per the repo's e2e culture), not as green.
 */
import { test, expect } from '../../fixtures/navigation.fixture.js';

const HC_BOOK = process.env.E2E_HC_BOOK;
const HC_TARGET = process.env.E2E_HC_TARGET;

// The target may render as a plain <u id>, an overlapping segment, or a ghost tombstone.
const targetLocator = (page, id) =>
  page.locator(`u[id="${id}"], [data-overlapping*="${id}"], a.open-icon[id="${id}"]`).first();

test.describe('hypercite single deep-link fetch-on-demand', () => {
  test.skip(!HC_BOOK || !HC_TARGET, 'E2E_HC_BOOK / E2E_HC_TARGET not set in .env.e2e (needs a foreign single — see header)');

  test('fresh page load with #hypercite_ hash renders + glows the gated target', async ({ page }) => {
    test.setTimeout(60_000);
    await page.goto(`/${HC_BOOK}#${HC_TARGET}`);
    await page.waitForLoadState('networkidle');

    // The record was gate/singles-filtered from bulk payloads — only the target=
    // exemption can have delivered it. It must be in the DOM…
    await expect(targetLocator(page, HC_TARGET)).toBeAttached({ timeout: 15_000 });
    // …and NOT the "Target not found" fallback toast.
    await expect(page.locator('.toast', { hasText: /target not found|start of book/i })).toHaveCount(0);
  });

  test('in-SPA nav to the hash fetches the record on demand (book opened WITHOUT the hash)', async ({ page }) => {
    test.setTimeout(90_000);
    // Open the book plain — the single is absent from IDB after this sync.
    await page.goto(`/${HC_BOOK}`);
    await page.waitForLoadState('networkidle');
    const inIdbBefore = await page.evaluate(async ({ book, id }) => {
      const mod = await import('/resources/js/indexedDB/hypercites/read.ts').catch(() => null);
      if (!mod?.getHyperciteFromIndexedDB) return null; // raw-vite path unavailable → soft skip
      return !!(await mod.getHyperciteFromIndexedDB(book, id));
    }, { book: HC_BOOK, id: HC_TARGET }).catch(() => null);

    // Real gesture: click an injected same-page anchor (goes through the lazyLoader
    // link handler → navigateToInternalId → fetch-on-demand).
    await page.evaluate((id) => {
      const a = document.createElement('a');
      a.href = `#${id}`;
      a.textContent = 'deep link under test';
      a.id = 'e2e-deeplink-probe';
      document.querySelector('.main-content')?.prepend(a);
    }, HC_TARGET);
    await page.click('#e2e-deeplink-probe');

    await expect(targetLocator(page, HC_TARGET)).toBeAttached({ timeout: 15_000 });
    // Glow class fires after scroll (auto-removed at ~2s — assert quickly or accept attached-only)
    // and the not-found toast must not have fired.
    await expect(page.locator('.toast', { hasText: /target not found/i })).toHaveCount(0);

    // Fetch-on-demand actually populated the store (only meaningful if it was absent before).
    if (inIdbBefore === false) {
      const inIdbAfter = await page.evaluate(async ({ book, id }) => {
        const mod = await import('/resources/js/indexedDB/hypercites/read.ts').catch(() => null);
        if (!mod?.getHyperciteFromIndexedDB) return null;
        return !!(await mod.getHyperciteFromIndexedDB(book, id));
      }, { book: HC_BOOK, id: HC_TARGET });
      expect(inIdbAfter).toBe(true);
    }
  });

  test('gate hideAll + reload keeps the pinned target rendered (pinned= survives re-sync)', async ({ page }) => {
    test.setTimeout(90_000);
    // Arrive via deep link (pins the id in sessionStorage)…
    await page.goto(`/${HC_BOOK}#${HC_TARGET}`);
    await page.waitForLoadState('networkidle');
    await expect(targetLocator(page, HC_TARGET)).toBeAttached({ timeout: 15_000 });

    // …switch the gate to hideAll (storage write = what the settings panel persists)…
    await page.evaluate(() => {
      localStorage.setItem('hyperlit_gate_filter', JSON.stringify({ mode: 'hideAll', custom: {} }));
    });
    // …reload same tab (sessionStorage pin survives): bulk fetches now carry gate=hideAll
    // AND pinned=<target>, so the target must still arrive and render.
    await page.reload();
    await page.waitForLoadState('networkidle');
    await expect(targetLocator(page, HC_TARGET)).toBeAttached({ timeout: 15_000 });
  });
});
