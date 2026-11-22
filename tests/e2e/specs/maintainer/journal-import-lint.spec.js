// /maintainer/journal-import — "search the journal for problems" (conversion lint), driven with
// real gestures against real books in the real reader:
//
//   - every imported lane is checked and badged; "problems first" ranks the list and drops the
//     clean articles;
//   - selecting a lane lists its problems, and clicking one JUMPS the converted-output pane to
//     the node (the reader only resolves a hash at load time, so this is a reload — the thing
//     most likely to silently do nothing) and rings it;
//   - a snapshot, then a "reconvert", turns the strip into a before/after: what went away, and —
//     the reason it exists — what the reconvert INTRODUCED, on an article nobody had opened.
//
// Fixture: `php artisan e2e:seed-journal-lint` (reset in beforeAll; `--reconverted` applies the
// after-state mid-spec). Promotes the e2e user to admin, which the console's 404 gate needs.
//
// Manual suite (npm run test:e2e) — not CI.

import { test, expect } from '@playwright/test';
import { execSync } from 'node:child_process';
import { resolve } from 'node:path';

const SLUG = 'e2e-lint-journal';
const BROKEN = 'book_e2e_lint_broken';
const FRAGMENT_LINE = '4200';
const APP_ROOT = resolve(import.meta.dirname, '../../../..');

test.describe.configure({ mode: 'serial', timeout: 120000 });

// The framed reader registers the service worker on first load and later reloads then route
// through it, which intermittently stalls the pane under the dev server (same remedy as the
// hypercite console spec).
test.use({ serviceWorkers: 'block' });

const seed = (flags = '') =>
  execSync(`php artisan e2e:seed-journal-lint ${flags}`, { cwd: APP_ROOT, stdio: 'pipe' });

test.describe('journal-import conversion lint', () => {
  let seeded = false;

  test.beforeAll(() => {
    try {
      seed();
      seeded = true;
    } catch (err) {
      console.warn('e2e:seed-journal-lint failed — skipping suite:', String(err.stderr || err));
    }
  });

  test('find a problem, jump to it, then see what a reconvert fixed and what it broke', async ({ page }) => {
    test.skip(!seeded, 'fixture seeding failed — is the local DB migrated?');

    const errors = [];
    page.on('pageerror', (err) => errors.push(String(err).slice(0, 300)));

    await page.goto(`/maintainer/journal-import/${SLUG}`);
    await expect(page.locator('#ji-journal-name')).toContainText('E2E Lint Journal');

    // ── The journal is checked, and says what it found ──
    const summary = page.locator('#ji-lint-summary');
    await expect(summary).toHaveText('1 possible problem in 1 of 2 lanes', { timeout: 30000 });

    const brokenArticle = page.locator('.ji-article', { hasText: 'E2E Lint Broken Article' });
    const cleanArticle = page.locator('.ji-article', { hasText: 'E2E Lint Clean Article' });
    await expect(brokenArticle.locator('.ji-badge-lint')).toHaveText('1 problem');
    await expect(brokenArticle.locator('.ji-badge-lint')).toHaveAttribute('title', 'false blockquote ×1');
    await expect(cleanArticle.locator('.ji-badge-lint')).toHaveCount(0);

    // ── "problems first" drops the clean article ──
    await page.locator('#ji-only-problems').check();
    await expect(page.locator('.ji-article')).toHaveCount(1);
    await expect(brokenArticle).toBeVisible();
    await page.locator('#ji-only-problems').uncheck();
    await expect(page.locator('.ji-article')).toHaveCount(2);

    // ── Select the lane: its problems are listed above the converted output ──
    await brokenArticle.locator('.ji-lane').click();
    const finding = page.locator('#ji-findings .ji-finding');
    await expect(finding).toHaveCount(1);
    await expect(finding.locator('.ji-finding-kind')).toHaveText('false blockquote');
    await expect(finding.locator('.ji-finding-excerpt')).toContainText('domain names (such as microsoft.com)');

    // The reader pane loads at the top: the fragment is ~40 paragraphs down, out of view.
    const reader = page.frameLocator('#ji-converted');
    await expect(reader.locator('[id="100"]')).toBeVisible({ timeout: 60000 });

    // ── Click the problem: the pane reloads AT the node and rings it ──
    await finding.locator('.ji-finding-main').click();
    await expect(page.locator('#ji-converted')).toHaveAttribute('src', `/${BROKEN}#${FRAGMENT_LINE}`);
    const target = reader.locator(`[id="${FRAGMENT_LINE}"]`);
    await expect(target).toBeInViewport({ timeout: 60000 });
    await expect(target).toContainText('domain names');
    // Ringed by a stylesheet in the frame's head — never by touching the node itself.
    await expect(reader.locator('#ji-finding-ring')).toHaveCount(1);
    await expect(target).not.toHaveAttribute('style', /outline/);
    await expect(target).toHaveCSS('outline-style', 'solid');

    // ── A verdict: "false alarm" takes it out of the count, and can be undone ──
    await finding.locator('.ji-finding-verdict-false').click();
    await expect(page.locator('#ji-findings .ji-finding-fold')).toContainText('1 dismissed as false alarm');
    await expect(page.locator('#ji-findings-toggle')).toHaveText('problems (0)');
    await expect(brokenArticle.locator('.ji-badge-lint')).toHaveCount(0);
    await page.locator('#ji-findings .ji-finding-fold').click();
    await page.locator('#ji-findings .ji-finding-dismissed .ji-finding-verdict-undo').click();
    await expect(page.locator('#ji-findings-toggle')).toHaveText('problems (1)');

    // ── "Real": it lands in the lane's note (which rides the case bundle) ──
    await finding.locator('.ji-finding-verdict-real').click();
    await expect(finding).toHaveClass(/ji-finding-confirmed/);
    await expect(page.locator('#ji-note')).toHaveValue(/✓ \[fragment_blockquote:[0-9a-f]{12}\] \(node 4200\).*domain names/);

    // ── …and the reviewed-cases download is one archive: the review + an example bundle ──
    const casesButton = page.locator('#ji-lint-cases');
    await expect(casesButton).toBeVisible();
    const [download] = await Promise.all([page.waitForEvent('download'), casesButton.click()]);
    expect(download.suggestedFilename()).toBe(`lint-cases-${SLUG}.tar`);
    const members = execSync(`tar -tf "${await download.path()}"`).toString();
    expect(members).toContain('lint-review.json');
    expect(members).toContain(`${BROKEN}.tar.gz`);

    // ── Snapshot: a comparison exists and says nothing has happened yet ──
    await page.locator('#ji-lint-snapshot').click();
    const compare = page.locator('#ji-lint-compare');
    await expect(compare).toBeVisible();
    await expect(compare).toContainText('0 of 2 lanes changed');
    await expect(compare).toContainText('nothing new');
    await expect(page.locator('#ji-only-new-label')).toBeHidden();

    // ── "Reconvert": the broken article is repaired, the clean one gains a bad heading ──
    seed('--reconverted');
    await page.reload();
    await expect(summary).toHaveText('1 possible problem in 1 of 2 lanes', { timeout: 30000 });

    await expect(compare).toBeVisible();
    await expect(compare).toContainText('2 of 2 lanes changed');
    await expect(compare.locator('.ji-lint-down', { hasText: 'false blockquote 1 → 0' })).toBeVisible();
    await expect(compare.locator('.ji-lint-up', { hasText: 'heading ends in a colon 0 → 1' })).toBeVisible();
    await expect(compare.locator('.ji-lint-up', { hasText: '1 new in 1 lane' })).toBeVisible();

    // The regression is on the article that WAS clean — the one nobody would have re-read.
    await expect(cleanArticle.locator('.ji-badge-flag', { hasText: '▲ 1 new' })).toBeVisible();
    await expect(brokenArticle.locator('.ji-badge-lint')).toHaveCount(0);

    await page.locator('#ji-only-new').check();
    await expect(page.locator('.ji-article')).toHaveCount(1);
    await expect(cleanArticle).toBeVisible();

    await cleanArticle.locator('.ji-lane').click();
    const newFinding = page.locator('#ji-findings .ji-finding');
    await expect(newFinding).toHaveClass(/ji-finding-new/);
    await expect(newFinding.locator('.ji-finding-tag')).toHaveText('new');
    await expect(newFinding).toContainText('Aspects of emergence are:');

    // ── Clearing the snapshot ends the comparison (and un-sticks the "new only" filter) ──
    page.once('dialog', (dialog) => dialog.accept());
    await page.locator('#ji-lint-clear').click();
    await expect(compare).toBeHidden();
    await expect(page.locator('.ji-article')).toHaveCount(2);

    expect(errors, `page errors:\n${errors.join('\n')}`).toEqual([]);
  });
});
