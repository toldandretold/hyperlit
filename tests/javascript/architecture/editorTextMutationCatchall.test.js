/**
 * Gate: the editor's text-mutation catch-all must never be disabled again.
 *
 * A text change that produces NO `input` event (Safari autocorrect, spelling-panel
 * replacement) silently bypasses the debounced input pipeline — the DOM diverges
 * from IndexedDB and only the periodic integrity scan notices, 30s later
 * (book_1787617675521, node 407, "origianl"→"original", Aug 2026).
 *
 * characterData observation was removed once before (72a0adb3, Dec 2025, as a
 * typing-churn perf optimization); this test fails if either half of the
 * catch-all seam is disabled again:
 *   1. the MutationObserver watches characterData (chunkMutationHandler dedupes
 *      it per batch, so churn stays bounded), and
 *   2. the input handler listens for the legacy `textInput` event.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const readSource = (rel) => readFileSync(resolve(here, '../../../resources/js', rel), 'utf8');

describe('editor text-mutation catch-all (autocorrect/DOM-only edits reach the save queue)', () => {
  it('the editor MutationObserver observes characterData (input events are not sufficient)', () => {
    const src = readSource('divEditor/index.ts');
    const observeCall = src.match(/observer\.observe\s*\([\s\S]*?\}\s*\);/);
    expect(observeCall, 'divEditor/index.ts: observer.observe(config) call not found').not.toBeNull();
    expect(observeCall[0]).toMatch(/characterData:\s*true/);
  });

  it('the input handler attaches a textInput listener (Safari autocorrect channel)', () => {
    const src = readSource('divEditor/inputHandler.ts');
    expect(src).toMatch(/addEventListener\(\s*['"]textInput['"]/);
    // And it must be detachable (session teardown leaks listeners otherwise).
    expect(src).toMatch(/removeEventListener\(\s*['"]textInput['"]/);
  });
});
