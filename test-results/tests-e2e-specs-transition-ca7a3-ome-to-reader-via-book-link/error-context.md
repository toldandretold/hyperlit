# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: tests/e2e/specs/transitions/home-to-reader.spec.js >> Home → Reader transition >> navigates from home to reader via book link
- Location: tests/e2e/specs/transitions/home-to-reader.spec.js:4:3

# Error details

```
Error: page.goto: Protocol error (Page.navigate): Cannot navigate to invalid URL
Call log:
  - navigating to "/", waiting until "load"

```

# Test source

```ts
  1  | import { test, expect } from '../../fixtures/navigation.fixture.js';
  2  | 
  3  | test.describe('Home → Reader transition', () => {
  4  |   test('navigates from home to reader via book link', async ({ page, spa }) => {
  5  |     // Start on home page
> 6  |     await page.goto('/');
     |                ^ Error: page.goto: Protocol error (Page.navigate): Cannot navigate to invalid URL
  7  |     await page.waitForLoadState('networkidle');
  8  |     expect(await spa.getStructure(page)).toBe('home');
  9  | 
  10 |     // Snapshot listeners before transition
  11 |     const before = await spa.getListenerSnapshot(page);
  12 | 
  13 |     // Click the first available book link
  14 |     await spa.clickFirstBookLink(page);
  15 |     await spa.waitForTransition(page);
  16 | 
  17 |     // Verify we're on reader
  18 |     expect(await spa.getStructure(page)).toBe('reader');
  19 | 
  20 |     // Health check
  21 |     const health = await spa.healthCheck(page);
  22 |     spa.assertHealthy(health);
  23 | 
  24 |     // Registry health check
  25 |     await spa.assertRegistryHealthy(page, 'reader');
  26 | 
  27 |     // No console errors
  28 |     expect(spa.filterConsoleErrors(page.consoleErrors)).toHaveLength(0);
  29 |   });
  30 | });
  31 | 
```