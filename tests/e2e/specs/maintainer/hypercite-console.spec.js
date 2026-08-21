// /maintainer/hypercites — the citation-graph review console, driven end to
// end with real gestures against real books: select a candidate (marks appear
// in both reader panes), approve (↗ spliced OUTSIDE the citation brackets,
// applied section appears), RELOAD the page (the applied record must survive),
// select the applied row (the revert button must be VISIBLE and ENABLED — the
// exact flow that read as broken on prod), revert (content restored
// byte-for-byte), and approve again (the loop closes).
//
// Fixture: `php artisan e2e:seed-hypercite-console` (run in beforeAll) — a
// journal + citing/cited article pair with one `matched` candidate, reset on
// every run. Requires the e2e user (auth.setup.js session) and promotes it to
// admin, which the console's 404 gate needs.
//
// Manual suite (npm run test:e2e) — not CI.

import { test, expect } from '@playwright/test';
import { execSync } from 'node:child_process';
import { resolve } from 'node:path';
import { readBookData } from '../../helpers/backendRead.js';

const SLUG = 'e2e-hypercite-journal';
const APP_ROOT = resolve(import.meta.dirname, '../../../..');

// Serial (the loop is stateful) and generously timed: approve/revert bump the
// citing book's content clock, so the forced pane reload does a full reader
// re-sync — legitimate slowness, not flake.
test.describe.configure({ mode: 'serial', timeout: 120000 });

// The reader inside the panes registers the service worker on its first load;
// subsequent forced reloads (the approve/revert flow) then go through it,
// which intermittently stalled the pane for 60s+ under the dev server. Same
// remedy as the audio harness: block SW for this spec.
test.use({ serviceWorkers: 'block' });

test.describe('hypercite console review loop', () => {
  let seeded = false;

  test.beforeAll(() => {
    try {
      execSync('php artisan e2e:seed-hypercite-console', { cwd: APP_ROOT, stdio: 'pipe' });
      seeded = true;
    } catch (err) {
      console.warn('e2e:seed-hypercite-console failed — skipping suite:', String(err.stderr || err));
    }
  });

  test.beforeEach(async ({ page }) => {
    test.skip(!seeded, 'fixture seeding failed — is the local DB migrated?');
    await page.goto(`/maintainer/hypercites/${SLUG}`);
    await expect(page.locator('#hx-title')).toContainText('E2E Hypercite Journal');
  });

  test('walking down the candidate list loads panes at every stop', async ({ page }) => {
    // The live failure: clicking row after row, the panes go BLANK and stay
    // blank. Reproduce it like a human — click each row at reading pace and
    // require the CITING pane to actually render each citing book's node.
    // Every frame error is captured so a failure names its cause.
    const errors = [];
    page.on('pageerror', (err) => errors.push(`[pageerror] ${String(err).slice(0, 300)}`));
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(`[console.error] ${msg.text().slice(0, 300)}`);
    });

    const rows = page.locator('#hx-candidates-list .hx-row');
    await expect(rows.first()).toBeVisible(); // list is fetched async
    const count = await rows.count();
    expect(count).toBeGreaterThanOrEqual(4); // seeder provides 4 citing books

    for (let i = 0; i < count; i++) {
      await rows.nth(i).click();
      await page.waitForTimeout(700); // human pace between clicks
      // The citing pane must render SOMETHING for the selected candidate:
      // its book's node carries the quote text in a <p> with a data-node-id.
      const citing = page.frameLocator('#hx-citing');
      try {
        // 30s allows one pane self-heal cycle (8s watchdog + reload).
        await expect(citing.locator('[data-node-id]').first()).toBeVisible({ timeout: 30000 });
      } catch (err) {
        throw new Error(
          `pane blank after clicking row ${i + 1}/${count}.\nFrame errors so far:\n${errors.join('\n') || '(none captured)'}`,
          { cause: err },
        );
      }
    }

    // And walk back UP fast (re-selections of already-visited books).
    for (let i = count - 1; i >= 0; i--) {
      await rows.nth(i).click();
      await page.waitForTimeout(250);
    }
    const citing = page.frameLocator('#hx-citing');
    try {
      await expect(citing.locator('[data-node-id]').first()).toBeVisible({ timeout: 30000 });
    } catch (err) {
      throw new Error(
        `pane blank after walking back up the list.\nFrame errors:\n${errors.join('\n') || '(none captured)'}`,
        { cause: err },
      );
    }
  });

  test('candidate selection marks the quote in both panes and arms approve', async ({ page }) => {
    const row = page.locator('#hx-candidates-list .hx-row').first();
    await expect(row).toBeVisible();
    await row.click();

    // The verdict card: approve armed, reject available, revert PRESENT but
    // disabled (it must never be hidden — an invisible button is unfindable).
    await expect(page.locator('#hx-selected')).toBeVisible();
    await expect(page.locator('#hx-approve')).toBeEnabled();
    await expect(page.locator('#hx-reject')).toBeVisible();
    await expect(page.locator('#hx-revert')).toBeVisible();
    await expect(page.locator('#hx-revert')).toBeDisabled();

    // Both panes are the REAL reader; the evidence gets search-style marks.
    const citing = page.frameLocator('#hx-citing');
    await expect(citing.locator('mark.search-highlight')).toBeVisible({ timeout: 30000 });
    await expect(citing.locator('mark.search-highlight')).toContainText('dominance of the global north');

    const cited = page.frameLocator('#hx-cited');
    await expect(cited.locator('mark.search-highlight')).toBeVisible({ timeout: 30000 });
  });

  test('approve splices the ↗ outside the brackets and populates the applied section', async ({ page }) => {
    await page.locator('#hx-candidates-list .hx-row').first().click();
    await expect(page.locator('#hx-approve')).toBeEnabled();
    await page.locator('#hx-approve').click();

    await expect(page.locator('#hx-selected-status')).toContainText('✓ hypercited', { timeout: 15000 });

    // Applied section appears with the row, and revert arms IMMEDIATELY.
    await expect(page.locator('#hx-applied-section')).toBeVisible();
    await expect(page.locator('#hx-applied-list .hx-row')).toHaveCount(1);
    await expect(page.locator('#hx-revert')).toBeVisible();
    await expect(page.locator('#hx-revert')).toBeEnabled();

    // Placement, asserted against POSTGRES (authoritative — the pane is
    // mid-resync after the content-clock bump and can lag): the ↗ anchor sits
    // AFTER `: 81).` — outside the citation's brackets AND past the
    // sentence's full stop (the prod regression put it mid-citation, before
    // the page number). Word joiner glues it on.
    const data = await readBookData(page, 'book_e2e_hxc_citing');
    expect(data.ok).toBe(true);
    const content = data.body.nodes.find((n) => n.node_id === 'book_e2e_hxc_citing_n1')?.content ?? '';
    expect(content).toContain(': 81).⁠<a href="/book_e2e_hxc_cited#hypercite_');
    const citedData = await readBookData(page, 'book_e2e_hxc_cited');
    expect(citedData.body.metadata.total_hypercites).toBe(1);

    // VISUAL check from a fresh page load + reselect. The in-place forced
    // double-reload is still unreliable (two framed readers share
    // sessionStorage → shared tab identity → concurrent full-syncs trip each
    // other; known follow-up) — but the console PURGES both books from the
    // shared IndexedDB on approve/revert, so whenever a pane renders it
    // renders FRESH; the stale-arrow-after-revert failure is dead either way.
    await page.reload();
    await expect(page.locator('#hx-applied-list .hx-row')).toHaveCount(1);
    await page.locator('#hx-applied-list .hx-row').first().click();
    const citing = page.frameLocator('#hx-citing');
    await expect(citing.locator('a.open-icon')).toBeVisible({ timeout: 60000 });
    const cited = page.frameLocator('#hx-cited');
    await expect(cited.locator('u[id^="hypercite_"]')).toBeVisible({ timeout: 60000 });
  });

  test('after a full page reload, the applied row still offers an ENABLED revert', async ({ page }) => {
    // The applied record must be permanent — this reload is the exact flow
    // that looked broken: refresh, click the applied row, find revert.
    await expect(page.locator('#hx-applied-section')).toBeVisible();
    const appliedRow = page.locator('#hx-applied-list .hx-row').first();
    await appliedRow.click();

    await expect(page.locator('#hx-selected')).toBeVisible();
    await expect(page.locator('#hx-revert')).toBeVisible();
    await expect(page.locator('#hx-revert')).toBeEnabled();
    await expect(page.locator('#hx-approve')).toBeDisabled();
  });

  test('revert restores the citing text and re-arms the candidate', async ({ page }) => {
    await page.locator('#hx-applied-list .hx-row').first().click();
    await expect(page.locator('#hx-revert')).toBeEnabled();
    await page.locator('#hx-revert').click();

    await expect(page.locator('#hx-selected-status')).toContainText('reverted', { timeout: 15000 });
    await expect(page.locator('#hx-applied-section')).toBeHidden();

    // Postgres says the ↗ is gone and the hypercite row deleted — the
    // byte-for-byte restore the minter promises.
    const data = await readBookData(page, 'book_e2e_hxc_citing');
    const content = data.body.nodes.find((n) => n.node_id === 'book_e2e_hxc_citing_n1')?.content ?? '';
    expect(content).not.toContain('open-icon');
    expect(content).toContain(': 81). During one FGD');
    const citedData = await readBookData(page, 'book_e2e_hxc_cited');
    expect(citedData.body.metadata.total_hypercites).toBe(0);

    // And the PANE agrees, from a fresh load: the reverted node renders
    // WITHOUT the arrow — the exact stale-cache failure seen live (↗ on
    // screen, Postgres clean).
    await page.reload();
    await page.locator('#hx-candidates-list .hx-row').first().click();
    const citing = page.frameLocator('#hx-citing');
    const node = citing.locator('[data-node-id="book_e2e_hxc_citing_n1"]');
    await expect(node).toBeVisible({ timeout: 60000 });
    await expect(node.locator('a.open-icon')).toHaveCount(0);

    // And the loop closes: approve works again.
    await expect(page.locator('#hx-approve')).toBeEnabled();
    await page.locator('#hx-approve').click();
    await expect(page.locator('#hx-selected-status')).toContainText('✓ hypercited', { timeout: 15000 });
    await expect(page.locator('#hx-applied-list .hx-row')).toHaveCount(1);
  });
});
