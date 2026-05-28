import { test, expect } from '../../fixtures/navigation.fixture.js';
import {
  snapshotLaravelLog,
  readLaravelLogSince,
  findLaravelErrors,
  getLaravelLogPath,
} from '../../helpers/laravelLog.js';
import { startBrainNetworkCapture } from '../../helpers/networkCapture.js';
import {
  findSelectableParagraph,
  openBrainQueryFromSelection,
  setBrainMode,
  setBrainScope,
  submitQuestion,
  waitForBrainResult,
} from '../../helpers/brainQuery.js';

const READER_BOOK = process.env.E2E_READER_BOOK || 'book_1778118568525';

test.describe('AI Brain diagnostic', () => {
  test('end-to-end probe — captures console / network / laravel.log', async ({ page, spa }, testInfo) => {
    test.setTimeout(180_000);

    const logOffset = snapshotLaravelLog();
    const netCapture = startBrainNetworkCapture(page);

    let phase = 'navigate';
    let phaseError = null;

    try {
      await page.goto(`/${READER_BOOK}`);
      await page.waitForLoadState('networkidle').catch(() => {});
      await page.waitForSelector('.main-content', { timeout: 20_000 });

      phase = 'find selectable paragraph';
      const selector = await findSelectableParagraph(page, 80);
      if (!selector) throw new Error('No paragraph with >=80 chars found in .main-content');

      phase = 'open brain query';
      await openBrainQueryFromSelection(page, selector, 80);

      phase = 'set mode/scope';
      await setBrainMode(page, 'archivist');
      await setBrainScope(page, 'public');

      phase = 'submit question';
      await submitQuestion(page, 'What is the central claim of this passage?');

      phase = 'await result';
      const result = await waitForBrainResult(page, { timeout: 150_000 });
      phaseError = result.outcome === 'success'
        ? null
        : new Error(`Brain query did not succeed: outcome=${result.outcome}, status=${result.status || '(none)'}`);
    } catch (e) {
      phaseError = e;
    } finally {
      // Always capture artifacts, success or fail.
      const tail = readLaravelLogSince(logOffset);
      const errors = findLaravelErrors(tail);
      const events = netCapture.events();
      netCapture.stop();

      const consoleErrors = spa.filterConsoleErrors
        ? spa.filterConsoleErrors(page.consoleErrors || [])
        : (page.consoleErrors || []);
      const pageErrors = page.pageErrors || [];

      const summary = {
        phase,
        phaseError: phaseError ? phaseError.message : null,
        consoleErrorsCount: consoleErrors.length,
        pageErrorsCount: pageErrors.length,
        networkEvents: events.length,
        laravelTailBytes: tail.length,
        laravelErrorBlocks: errors.length,
      };

      console.log('=== AI BRAIN DIAGNOSTIC SUMMARY ===');
      console.log(JSON.stringify(summary, null, 2));

      if (consoleErrors.length) {
        console.log('\n--- Browser console.error ---');
        consoleErrors.slice(0, 30).forEach((e, i) => console.log(`[${i}] ${e}`));
      }
      if (pageErrors.length) {
        console.log('\n--- Page uncaught exceptions ---');
        pageErrors.slice(0, 30).forEach((e, i) => console.log(`[${i}] ${e}`));
      }
      if (events.length) {
        console.log('\n--- /api/ai-brain network events ---');
        events.forEach((e, i) => {
          if (e.kind === 'request') {
            console.log(`[${i}] REQUEST ${e.method} ${e.url}`);
            if (e.postData) console.log(`    postData: ${e.postData.slice(0, 800)}`);
          } else if (e.kind === 'response') {
            console.log(`[${i}] RESPONSE ${e.status} ${e.url}  (${e.contentType})`);
            if (e.body) console.log(`    body: ${e.body.slice(0, 800)}`);
          } else if (e.kind === 'requestfailed') {
            console.log(`[${i}] FAILED ${e.method} ${e.url}  ${e.errorText}`);
          }
        });
      }
      if (errors.length) {
        console.log('\n--- laravel.log ERROR blocks (since spec start) ---');
        errors.slice(0, 5).forEach((blk, i) => console.log(`\n[${i}]\n${blk.slice(0, 4000)}`));
      } else if (tail.trim()) {
        console.log('\n--- laravel.log tail (no ERROR blocks parsed; raw tail follows) ---');
        console.log(tail.slice(-4000));
      } else {
        console.log(`\n--- laravel.log path checked: ${getLaravelLogPath()} (no new bytes) ---`);
      }
      console.log('===================================');

      await testInfo.attach('diagnostic-summary.json', {
        body: JSON.stringify({ summary, consoleErrors, pageErrors, networkEvents: events }, null, 2),
        contentType: 'application/json',
      });
      if (tail) {
        await testInfo.attach('laravel.log.tail', {
          body: tail,
          contentType: 'text/plain',
        });
      }
      if (errors.length) {
        await testInfo.attach('laravel.errors.txt', {
          body: errors.join('\n\n--- next error ---\n\n'),
          contentType: 'text/plain',
        });
      }
    }

    if (process.env.AI_BRAIN_DIAGNOSTIC_FAIL_ON_ERROR === '1' && phaseError) {
      throw phaseError;
    }
    expect(true).toBe(true);
  });
});
