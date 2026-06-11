# Paste System Tests

This directory contains tests for the refactored paste system.

## Running Tests

### 1. Automated Tests (Vitest)

Run all tests:
```bash
./vendor/bin/pest  # or npm test if configured
```

Run specific test file:
```bash
npx vitest tests/paste/utils/normalizer.test.js
```

Run tests in watch mode:
```bash
npx vitest --watch
```

### 2. Capturing a fixture from a real publisher page

**The fixture generator is `resources/paste-capture.html`.** Open it as a
local file — it is self-contained, do NOT use a `localhost`/`:5173` URL
(`resources/` is not served over HTTP, you'll get a 404):

```bash
open resources/paste-capture.html
```

Click the drop zone, Cmd+V the copied article, sanity-check the stats, and
**Download** — then move the file into `tests/paste/fixtures/clipboard/`.
It captures the exact `text/html` clipboard payload production paste handlers
see. Full instructions + naming convention: `fixtures/clipboard/README.md`.

### 3. Browser-Based Manual Testing (interactive playground)

`resources/test-paste-refactor.html` is an interactive page to eyeball format
detection + the processing pipeline. Same rule — open it as a file, not a URL:

```bash
open resources/test-paste-refactor.html
```

### 4. Console Testing

You can also test in the browser console:

```javascript
// Import modules
import { detectFormat } from '/resources/js/paste/format-detection/format-detector.js';
import { CambridgeProcessor } from '/resources/js/paste/format-processors/cambridge-processor.js';

// Test format detection
const html = '<a class="xref fn"><sup>1</sup></a>';
console.log(detectFormat(html)); // Should output: 'cambridge'

// Test processor
const processor = new CambridgeProcessor();
const result = await processor.process(html, 'testBook');
console.log(result);
```

## Test Structure

```
tests/paste/
├── fixtures/clipboard/             # Real captured text/html payloads (+ its own README)
├── utils/
│   ├── normalizer.test.js
│   └── content-estimator.test.js
├── format-processors/
│   └── cambridge-processor.test.js
└── handlers/
    ├── fixtures-smoke.test.js      # ← THE regression regime: per-publisher baselines
    ├── backend-entry.test.js       # ← shared-engine guard (frontend == backend)
    └── hypercite-whitespace.test.js
```

### The two load-bearing tests

- **`handlers/fixtures-smoke.test.js`** — for each real fixture, baselines the
  detected format, footnote/reference counts, AND the app-native linked output
  (`inTextCitations` = `<a class="in-text-citation">`, `footnoteMarkers` =
  `<sup fn-count-id>`). This is what catches a processor regression. Entries
  marked KNOWN BUG document current broken behaviour — fix the bug, bump the
  number, both move together.
- **`handlers/backend-entry.test.js`** — runs `scripts/paste-convert.mjs` (the
  Node + happy-dom backend entry point the citation vacuum uses) as a
  subprocess and asserts it produces the SAME output as the in-process
  processors. This is what guarantees the engine is single-source: a paste fix
  propagates to the backend, and the two can't silently drift.

## Writing New Tests

### Unit Test Example

```javascript
import { describe, it, expect } from 'vitest';
import { myFunction } from '../../../resources/js/paste/utils/my-utility.js';

describe('myFunction', () => {
  it('should do something', () => {
    const result = myFunction('input');
    expect(result).toBe('expected output');
  });
});
```

### Processor Test Example

```javascript
import { describe, it, expect } from 'vitest';
import { MyProcessor } from '../../../resources/js/paste/format-processors/my-processor.js';

describe('MyProcessor', () => {
  it('should extract footnotes', async () => {
    const html = '<div>...</div>';
    const processor = new MyProcessor();

    const dom = document.createElement('div');
    dom.innerHTML = html;

    const footnotes = await processor.extractFootnotes(dom, 'testBook');

    expect(footnotes).toHaveLength(1);
    expect(footnotes[0].originalIdentifier).toBe('1');
  });
});
```

## Common Test Scenarios

### Testing Format Detection

```javascript
import { detectFormat } from './format-detection/format-detector.js';

// Test Cambridge detection
const cambridgeHtml = '<a class="xref fn"><sup>1</sup></a>';
expect(detectFormat(cambridgeHtml)).toBe('cambridge');

// Test fallback to general
const unknownHtml = '<p>Simple paragraph</p>';
expect(detectFormat(unknownHtml)).toBe('general');
```

### Testing Processors

```javascript
import { CambridgeProcessor } from './format-processors/cambridge-processor.js';

const processor = new CambridgeProcessor();
const result = await processor.process(html, 'testBook');

// Check outputs
expect(result.formatType).toBe('cambridge');
expect(result.footnotes).toHaveLength(expectedCount);
expect(result.references).toHaveLength(expectedCount);
expect(result.html).toContain('expected content');
```

### Testing Utilities

```javascript
import { normalizeQuotes } from './utils/normalizer.js';

const input = '"smart quotes"';
const output = normalizeQuotes(input);
expect(output).toBe('"regular quotes"');
```

## Adding a new publisher (e.g. MIT Press) — the whole loop

The engine is shared: front-end paste AND the backend citation vacuum both
read `format-detection/format-registry.js`, so registering a processor once
makes it work in both places. Steps:

1. **Capture a fixture** — `open resources/paste-capture.html`, paste a real
   MIT Press article, Download, move to `fixtures/clipboard/mit-press-*.html`.
2. **Write the processor** — `format-processors/mit-press-processor.js`
   extending `BaseFormatProcessor`.
3. **Register it** — add one entry to `FORMAT_REGISTRY` in
   `format-detection/format-registry.js` (selectors + priority). That's the
   single registration point; nothing else needs touching.
4. **Add a baseline row** to `handlers/fixtures-smoke.test.js` with the
   observed counts (the test logs OBSERVED/LINKED counts you can copy in).
5. **Run** `npx vitest run tests/paste` — `backend-entry.test.js` automatically
   proves the backend reproduces your processor. Green = it works in the
   citation vacuum too, no backend code change.

Unit-level processor tests (optional but encouraged): create
`{format}-processor.test.js` covering `extractFootnotes()` / `extractReferences()`
valid + edge cases, `transformStructure()`, the full `process()` pipeline, and
DOM cleanup.

## Debugging Tests

### Enable verbose logging

In browser console or test file:
```javascript
// Processors log to console during processing
const result = await processor.process(html, 'testBook');
// Check console for step-by-step logs
```

### Inspect intermediate DOM state

```javascript
const dom = document.createElement('div');
dom.innerHTML = html;

// Run processor steps individually
await processor.extractFootnotes(dom, 'testBook');
console.log('DOM after footnote extraction:', dom.innerHTML);

await processor.transformStructure(dom, 'testBook');
console.log('DOM after transformation:', dom.innerHTML);
```

### Use detectFormatVerbose for debugging

```javascript
import { detectFormatVerbose } from './format-detection/format-detector.js';

const result = detectFormatVerbose(html);
console.log(result);
// Shows all formats checked, which selectors matched, etc.
```
