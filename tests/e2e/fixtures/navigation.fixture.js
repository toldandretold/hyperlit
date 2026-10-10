import { test as base, expect } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listenerMonitorScript } from '../helpers/listenerMonitor.js';
import { restorationSpyScript } from '../helpers/restorationSpy.js';
import { integrityCaptureScript } from '../helpers/integrityCapture.js';
import { targetNotFoundCaptureScript } from '../helpers/targetNotFoundCapture.js';
import {
  createNewBook,
  getStackDepth,
  typeAtEndOfActiveEditor,
  selectInActiveEditor,
  insertFootnoteAtCaret,
  hyperlightSelection,
  closeTopContainer,
  copyHyperciteFromActiveEditor,
  toggleEditModeInActiveContainer,
  clickIntoDeeperLevel,
  pasteEnvProbe,
  snapshotIntegrity,
  readNestText,
} from '../helpers/nestedAuthoring.js';
import {
  waitForSpaTransitionComplete,
  getPageStructure,
  runHealthCheck,
  assertHealthy,
  getRegistryStatus,
  getStaleBindings,
  assertRegistryHealthy,
  getPageGlobals,
  getListenerSnapshot,
  getListenerDelta,
  filterConsoleErrors,
  dismissConversionFeedbackToast,
  navigateToHome,
  navigateToUserPage,
  clickFirstBookLink,
  openHomeFeed,
  navigateViaHypercite,
  clickReaderContent,
  selectTextInElement,
  waitForEditMode,
  getCurrentBookId,
  waitForHyperlightButtons,
  closeHyperlitContainer,
  pasteHyperciteContent,
  getTargetNotFoundToasts,
  assertNoTargetNotFoundToasts,
  getHashProvenance,
  assertHashNamesRenderedBook,
} from '../helpers/pageHelpers.js';
import { dropFileOnWindow } from '../helpers/dropFile.js';
import { importMarkdownBook, generateLongMarkdown } from '../helpers/bookContent.js';
import {
  openToc,
  closeToc,
  getTocEntries,
  clickTocEntry,
  isHeadingInViewportForHref,
} from '../helpers/tocNav.js';
import {
  snapshotPageState,
  summariseSnapshot,
  detectAnomalies,
  detectRestorationRace,
} from '../helpers/stateSnapshot.js';
import { openAndCloseFootnotes, openFootnoteStack, closeAllContainers } from '../helpers/stress.js';

const CONSOLE_AUDIT_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..', 'test-results', 'console-audit'
);

// Strip origin + Vite dev-server query strings (?t=..., ?import) so the audit
// key is a stable source path like resources/js/foo/bar.ts.
function normalizeAuditUrl(url) {
  return (url || '')
    .replace(/^https?:\/\/[^/]+\//, '')
    .replace(/\?.*$/, '');
}

// Pick the real app frame from a CDP stack trace. We need the stack (not
// msg.location()) because console.log is WRAPPED twice — by the app's own
// ring buffer (resources/js/integrity/logCapture.ts) and by the e2e
// restorationSpy init script — so the immediate call site of most app logs is
// a wrapper. Skip: empty-url frames (injected wrappers / evaluate), the
// wrappers, and the logger itself, so log.*/verbose.* calls attribute to
// their caller.
const AUDIT_SKIP_FRAMES = /utilities\/logger\.ts$|integrity\/logCapture\.ts$/;
function pickAuditFrame(stackTrace) {
  for (const frame of stackTrace?.callFrames || []) {
    const file = normalizeAuditUrl(frame.url);
    if (!file) continue;
    if (AUDIT_SKIP_FRAMES.test(file)) continue;
    // CDP lineNumber is 0-based; report editor-style 1-based lines.
    return { file, line: frame.lineNumber + 1 };
  }
  return { file: '(test-injected)', line: 0 };
}

// Compact one-line sample from CDP RemoteObject args.
function auditSample(args) {
  return (args || [])
    .map(a => (a.value !== undefined ? String(a.value) : a.description || a.type))
    .join(' ')
    .slice(0, 200);
}

/**
 * Extended test fixture that installs the listener monitor + restoration spy,
 * captures console errors + a full console-frequency audit, and provides SPA
 * navigation helpers.
 */
export const test = base.extend({
  // Install init scripts + console capture before each test
  page: async ({ page }, use, testInfo) => {
    // Inject the listener monitor and restoration spy before any page scripts run
    await page.addInitScript(listenerMonitorScript);
    await page.addInitScript(restorationSpyScript);
    await page.addInitScript(integrityCaptureScript);
    await page.addInitScript(targetNotFoundCaptureScript);

    // Pages-mode sweep: E2E_READING_MODE=paginated runs the whole suite with
    // the paginated reading preference set (npm run test:e2e:pages). The
    // fixtures/readingMode.teardown.js global teardown clears the pref from
    // the shared e2e user afterwards (seedFromServer would otherwise upload
    // it and leak pages mode into later normal runs). Specs that assert
    // scroll-mode MECHANICS should self-skip via
    // `test.skip(process.env.E2E_READING_MODE === 'paginated', 'asserts scroll-mode mechanics')`.
    if (process.env.E2E_READING_MODE === 'paginated') {
      await page.addInitScript(() => {
        localStorage.setItem('hyperlit_reading_mode', 'paginated');
      });
    }


    // Capture console errors (existing gates read page.consoleErrors).
    const consoleErrors = [];
    page.on('console', msg => {
      if (msg.type() === 'error') {
        consoleErrors.push(msg.text());
        // Triage aid: E2E_CONSOLE_DEBUG=1 streams page errors to the runner's
        // stdout live (the consoleErrors gate only surfaces them at assert time,
        // and a test that dies earlier otherwise hides what the page logged).
        if (process.env.E2E_CONSOLE_DEBUG) console.log('[page-err]', msg.text().slice(0, 400));
      } else if (process.env.E2E_CONSOLE_DEBUG === 'all') {
        // Full-console triage: stream every page log line to the runner's
        // stdout so navigation/restoration decision logs (📚 restore vs
        // cascade, popstate branches) are visible next to the test's steps.
        console.log(`[page-${msg.type()}]`, msg.text().slice(0, 400));
      }
    });

    // Console AUDIT: aggregate ALL console calls by originating source
    // location. Uses a CDP session because Runtime.consoleAPICalled carries a
    // stack trace — pickAuditFrame() walks past the restorationSpy console
    // wrapper (and logger.ts) to the real app frame, which msg.location()
    // cannot do. The audit is a Map keyed by `type|file:line`, so memory is
    // bounded by unique log SITES, not message volume. Chromium-only (the
    // whole suite is); soft-fails if CDP is unavailable.
    const consoleAudit = new Map();
    try {
      const cdp = await page.context().newCDPSession(page);
      await cdp.send('Runtime.enable');
      cdp.on('Runtime.consoleAPICalled', event => {
        const { file, line } = pickAuditFrame(event.stackTrace);
        const key = `${event.type}|${file}:${line}`;
        const site = consoleAudit.get(key);
        if (site) {
          site.count += 1;
        } else {
          consoleAudit.set(key, {
            type: event.type, file, line, count: 1,
            sample: auditSample(event.args),
          });
        }
      });
    } catch (e) {
      console.warn(`[console-audit] CDP capture unavailable: ${e.message}`);
    }

    // Capture uncaught exceptions
    const pageErrors = [];
    page.on('pageerror', error => {
      pageErrors.push(error.message);
    });

    // Attach helpers to page object for easy access
    page.consoleErrors = consoleErrors;
    page.pageErrors = pageErrors;
    page.consoleAudit = consoleAudit;

    await use(page);

    // GLOBAL GATE: no navigation may end with "Couldn't find 'X' — showing start of book".
    //
    // That toast means the app abandoned a requested position and dumped the reader at the top of
    // a book — a real, user-visible failure that throws nothing, logs no console error, and leaves
    // the URL, page structure and registry all valid. Every end-state assertion in this suite
    // passes through it; the one that shipped was caught by a human watching an 18/18 green run
    // (a parent book's `HL_…` replayed onto its `/AIreview` sub-book during a back/forward burst,
    // opening a container over text with no such highlight). See helpers/targetNotFoundCapture.js.
    //
    // Only raised when the test otherwise PASSED — a test already failing has a more specific
    // error, and replacing it with this one would hide the real cause.
    //
    // A spec that deliberately drives a missing target (a deleted hypercite, a stale deep link)
    // opts out with `page.allowTargetNotFoundToasts = true`.
    if (!page.allowTargetNotFoundToasts && !testInfo.errors.length) {
      let toasts = [];
      try {
        toasts = await page.evaluate(() => (
          typeof window.__getTargetNotFoundToasts === 'function'
            ? window.__getTargetNotFoundToasts()
            : []
        ));
      } catch { /* page already closed — nothing to report */ }
      if (toasts.length) {
        throw new Error(
          'Navigation target(s) not found — the reader was dumped at the start of a book instead '
          + 'of the requested position. Nothing threw, so this is the only signal:\n'
          + JSON.stringify(toasts, null, 2)
          + '\n(If this spec drives a missing target on purpose, set '
          + 'page.allowTargetNotFoundToasts = true.)'
        );
      }
    }

    // Write the per-test console-frequency report. Playwright clears
    // test-results/ at run start, so reports always reflect the last run.
    // Merge across tests with: node tests/e2e/scripts/merge-console-audit.mjs
    if (consoleAudit.size > 0) {
      const sites = [...consoleAudit.values()].sort((a, b) => b.count - a.count);
      const byType = {};
      let total = 0;
      for (const site of sites) {
        byType[site.type] = (byType[site.type] || 0) + site.count;
        total += site.count;
      }
      const report = {
        test: testInfo.titlePath.join(' > '),
        totals: { total, byType },
        sites,
      };
      try {
        const name = testInfo.titlePath.join('__')
          .replace(/[^a-zA-Z0-9._-]+/g, '-')
          .slice(0, 180);
        mkdirSync(CONSOLE_AUDIT_DIR, { recursive: true });
        writeFileSync(
          join(CONSOLE_AUDIT_DIR, `${name}.json`),
          JSON.stringify(report, null, 2)
        );
      } catch (e) {
        console.warn(`[console-audit] failed to write report: ${e.message}`);
      }
    }
  },

  // Provide helper functions as a fixture
  spa: async ({}, use) => {
    await use({
      // Existing
      waitForTransition: waitForSpaTransitionComplete,
      getStructure: getPageStructure,
      healthCheck: runHealthCheck,
      assertHealthy,
      getRegistryStatus,
      getStaleBindings,
      assertRegistryHealthy,
      getGlobals: getPageGlobals,
      getListenerSnapshot,
      getListenerDelta,
      filterConsoleErrors,
      dismissConversionFeedbackToast,
      navigateToHome,
      navigateToUserPage,
      clickFirstBookLink,
      openHomeFeed,
      navigateViaHypercite,
      clickReaderContent,
      selectTextInElement,
      waitForEditMode,
      getCurrentBookId,
      waitForHyperlightButtons,
      closeHyperlitContainer,
      pasteHyperciteContent,
      // Navigation-honesty probes (the fixture asserts the toast one automatically at test end;
      // these let a spec localise a failure to a specific step instead of the whole test)
      getTargetNotFoundToasts,
      assertNoTargetNotFoundToasts,
      getHashProvenance,
      assertHashNamesRenderedBook,
      // New: book + TOC + state snapshot + stress
      dropFileOnWindow,
      importMarkdownBook,
      generateLongMarkdown,
      openToc,
      closeToc,
      getTocEntries,
      clickTocEntry,
      isHeadingInViewportForHref,
      snapshotPageState,
      summariseSnapshot,
      detectAnomalies,
      detectRestorationRace,
      openAndCloseFootnotes,
      openFootnoteStack,
      closeAllContainers,
      // Nested authoring primitives
      createNewBook,
      getStackDepth,
      typeAtEndOfActiveEditor,
      selectInActiveEditor,
      insertFootnoteAtCaret,
      hyperlightSelection,
      closeTopContainer,
      copyHyperciteFromActiveEditor,
      toggleEditModeInActiveContainer,
      clickIntoDeeperLevel,
      pasteEnvProbe,
      snapshotIntegrity,
      readNestText,
    });
  },
});

export { expect };
