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

### 2. Browser-Based Manual Testing

Open the test page in your browser:

```bash
# Start the dev server
npm run dev

# Navigate to:
http://localhost:5173/resources/test-paste-refactor.html
```

The test page provides:
- **Format Detection Test**: Paste HTML and see which format is detected
- **Processor Test**: Run the full processing pipeline
- **Utility Tests**: Test individual utility functions
- **Integration Test**: End-to-end test with sample Cambridge content

### 3. Console Testing

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
├── utils/                          # Utility function tests
│   ├── normalizer.test.js
│   ├── content-estimator.test.js
│   └── dom-utils.test.js
│
├── format-processors/              # Processor tests
│   ├── cambridge-processor.test.js
│   ├── oup-processor.test.js
│   └── general-processor.test.js
│
└── integration/                    # End-to-end tests
    └── full-paste-flow.test.js
```

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

## Testing Checklist

When adding a new format processor:

- [ ] Create `{format}-processor.test.js`
- [ ] Test `extractFootnotes()` with valid input
- [ ] Test `extractFootnotes()` with edge cases (no footnotes, malformed)
- [ ] Test `extractReferences()` with valid input
- [ ] Test `extractReferences()` with edge cases
- [ ] Test `transformStructure()` modifications
- [ ] Test full `process()` pipeline
- [ ] Test DOM cleanup (footnote containers removed, etc.)
- [ ] Add sample HTML to browser test page
- [ ] Update format registry test data

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
