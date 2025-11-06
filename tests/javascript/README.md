# JavaScript Unit Testing Guide

This directory contains unit tests for the Hyperlit JavaScript modules, specifically for `divEditor/` and `editToolbar/` functionality.

## Table of Contents

- [Quick Start](#quick-start)
- [What is Unit Testing?](#what-is-unit-testing)
- [Running Tests](#running-tests)
- [Writing New Tests](#writing-new-tests)
- [What to Test](#what-to-test)
- [What NOT to Test](#what-not-to-test)
- [Testing Patterns](#testing-patterns)
- [Troubleshooting](#troubleshooting)

---

## Quick Start

### Run all tests
```bash
npm test
```

### Run tests in watch mode (auto-rerun on file changes)
```bash
npm test -- --watch
```

### Run specific test file
```bash
npm test toolbarDOMUtils
```

### Open visual test UI
```bash
npm run test:ui
```

### Run tests once and exit (CI mode)
```bash
npm run test:run
```

---

## What is Unit Testing?

**Unit testing** = Writing code that tests your code automatically.

### Example

Your code:
```javascript
export function hasParentWithTag(element, tagName) {
  if (!element) return false;
  if (element.tagName === tagName) return true;
  // ... more logic
}
```

Your test:
```javascript
test('hasParentWithTag returns true when element IS the tag', () => {
  const strong = document.createElement('strong');
  expect(hasParentWithTag(strong, 'STRONG')).toBe(true);
});
```

The test automatically:
1. Creates a `<strong>` element
2. Calls `hasParentWithTag(strong, 'STRONG')`
3. Checks if result is `true`
4. ✅ PASS or ❌ FAIL

---

## Running Tests

### Basic Commands

| Command | Description |
|---------|-------------|
| `npm test` | Run all tests in watch mode |
| `npm test -- --run` | Run once and exit |
| `npm test toolbarDOMUtils` | Run specific file |
| `npm test -- --ui` | Open visual test runner |
| `npm test -- --coverage` | Generate coverage report |

### Example Output

```
✓ toolbarDOMUtils.test.js (42) 2ms
  ✓ hasParentWithTag (6) 1ms
    ✓ returns true when element IS the target tag
    ✓ returns true when parent has the target tag
    ✓ returns false when no match found
    ...
  ✓ isBlockElement (8) 1ms
    ✓ returns true for paragraph element
    ✓ returns true for all heading levels
    ...

Test Files  3 passed (3)
Tests       85 passed (85)
Duration    847ms
```

---

## Writing New Tests

### File Structure

```
tests/javascript/
  editToolbar/
    toolbarDOMUtils.test.js       ← Pure utility functions
    selectionManager.test.js      ← Class-based state management
    blockFormatter.test.js        ← Integration tests
  divEditor/
    [your tests here]
  README.md                       ← This file
```

### Basic Test Template

```javascript
import { describe, it, expect, beforeEach } from 'vitest';
import { yourFunction } from '../../../resources/js/yourModule.js';

describe('YourModule', () => {
  beforeEach(() => {
    // Clear DOM before each test
    document.body.innerHTML = '';
  });

  describe('yourFunction', () => {
    it('does what it should do', () => {
      // Arrange: Set up test data
      const input = 'test';

      // Act: Call the function
      const result = yourFunction(input);

      // Assert: Check the result
      expect(result).toBe('expected output');
    });

    it('handles edge case', () => {
      expect(yourFunction(null)).toBe(null);
    });
  });
});
```

---

## What to Test

### ✅ EASY: Pure Utility Functions

Functions that:
- Take input, return output
- No side effects
- No dependencies

**Example:** `hasParentWithTag()`, `isBlockElement()`, `findParentWithTag()`

```javascript
it('isBlockElement returns true for headings', () => {
  const h1 = document.createElement('h1');
  expect(isBlockElement(h1)).toBe(true);
});
```

### ✅ MEDIUM: Class State Management

Classes that:
- Manage internal state
- Have simple getters/setters
- Limited dependencies

**Example:** `SelectionManager` initialization, visibility toggling

```javascript
it('initializes with default options', () => {
  const manager = new SelectionManager();
  expect(manager.isVisible).toBe(false);
});
```

### ✅ HARD (but valuable): Integration Logic

Complex DOM manipulation:
- Block conversions (heading ↔ paragraph)
- Text formatting
- List operations

**Example:** Code block → heading conversion (tests our bug fix!)

```javascript
it('converts code block to heading without double encoding', () => {
  document.body.innerHTML = '<pre><code>&lt;div&gt;</code></pre>';
  const codeElement = document.querySelector('code');
  const heading = document.createElement('h2');
  heading.textContent = codeElement.textContent;

  expect(heading.textContent).toBe('<div>');
  expect(heading.innerHTML).not.toContain('&amp;'); // No double encoding!
});
```

---

## What NOT to Test

### ❌ Browser-specific Selection API Quirks

The `Selection` and `Range` APIs behave differently across browsers. jsdom provides a simplified version that may not match real browser behavior.

**Skip:** Full selection restoration, complex range manipulation
**Test instead:** The logic that *uses* selections (state management, offset calculations)

### ❌ IndexedDB Operations

IndexedDB is async, stateful, and complex to mock properly.

**Skip:** Actual database reads/writes
**Test instead:** The logic *around* IndexedDB (queue management, ID parsing)

### ❌ User Interactions (clicks, touches, typing)

Unit tests run in Node.js without a real browser.

**Skip:** Actual event dispatching, touch gestures
**Test instead:** Event handler logic as plain functions

### ❌ Visual Rendering & CSS

jsdom doesn't render visually.

**Skip:** Layout, positioning, visual appearance
**Test instead:** DOM structure, class names, attribute values

### ❌ Third-party Library Internals

Don't test `marked.js`, `DOMPurify`, etc.

**Test instead:** How *you* use these libraries

---

## Testing Patterns

### Pattern 1: Test All Cases

```javascript
describe('hasParentWithTag', () => {
  it('returns true when element IS the target tag');
  it('returns true when parent has the target tag');
  it('returns true when grandparent has the target tag');
  it('returns false when no match found');
  it('returns false for null element');
  it('is case-sensitive');
});
```

### Pattern 2: Test Edge Cases

```javascript
describe('isBlockElement', () => {
  it('returns true for block elements');
  it('returns false for inline elements');
  it('returns false for text nodes'); // Edge case
  it('returns false for null');        // Edge case
});
```

### Pattern 3: Test State Transitions

```javascript
describe('visibility toggling', () => {
  it('starts hidden', () => {
    const manager = new SelectionManager();
    expect(manager.isVisible).toBe(false);
  });

  it('can be shown', () => {
    manager.setVisible(true);
    expect(manager.isVisible).toBe(true);
  });

  it('can be hidden again', () => {
    manager.setVisible(false);
    expect(manager.isVisible).toBe(false);
  });
});
```

### Pattern 4: Test Bug Fixes

When you fix a bug, **write a test first** so it never comes back!

```javascript
// REGRESSION TEST: Code block → heading double encoding bug
it('extracts plain text without double HTML encoding', () => {
  // This test would have FAILED before our fix
  document.body.innerHTML = '<pre><code>&lt;div&gt;</code></pre>';
  const heading = convertCodeToHeading(/* ... */);

  expect(heading.innerHTML).not.toContain('&amp;'); // ✅ Now passes!
});
```

---

## Example: Full Test File

See `editToolbar/toolbarDOMUtils.test.js` for a complete example with:
- 14 functions tested
- ~60 individual test cases
- Edge case coverage
- Clear documentation

---

## Test Coverage

### Check coverage
```bash
npm test -- --coverage
```

### Coverage report will show:
- **Lines**: % of code lines executed
- **Functions**: % of functions called
- **Branches**: % of if/else paths taken

**Target:** Aim for >80% coverage on utility modules

---

## Troubleshooting

### Tests fail with "Cannot find module"

**Solution:** Check your import path. Use relative paths from test file to source:
```javascript
import { func } from '../../../resources/js/module.js';
//                    ^^^ Three levels up
```

### Tests pass but real code breaks

**Possible causes:**
1. Browser-specific behavior not in jsdom
2. Missing DOM setup in test
3. Test mocking something important

**Solution:** Consider E2E tests for critical user flows

### Tests are too slow

**Causes:**
- Creating too much DOM per test
- Not cleaning up between tests

**Solution:**
```javascript
beforeEach(() => {
  document.body.innerHTML = ''; // Reset DOM
});
```

### "window is not defined" or "document is not defined"

**Solution:** Check `vitest.config.js` has:
```javascript
test: {
  environment: 'jsdom',
}
```

---

## Benefits of Testing

### ✅ Catch Bugs Early
Run 85 tests in 2 seconds vs manually testing 85 scenarios

### ✅ Refactor Confidently
"I want to optimize this function... will it break anything?"
→ Run tests → All green → Ship it!

### ✅ Document Behavior
Tests are **living documentation** that always stay up-to-date

### ✅ Prevent Regressions
Fixed a bug? Write a test. It will never come back.

---

## Next Steps

1. **Try it out:** `npm test` and watch the tests run
2. **Explore:** Look at `toolbarDOMUtils.test.js` for examples
3. **Add tests:** When you write new functions, add tests
4. **Run before commits:** Make sure tests pass before pushing

---

## Resources

- [Vitest Documentation](https://vitest.dev/)
- [Testing Library](https://testing-library.com/)
- [jsdom](https://github.com/jsdom/jsdom)

---

**Happy Testing! 🧪✨**
