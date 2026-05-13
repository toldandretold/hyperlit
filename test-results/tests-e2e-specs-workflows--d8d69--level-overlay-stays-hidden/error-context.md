# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: tests/e2e/specs/workflows/file-import-drag-drop.spec.js >> File import via drag-and-drop (SPA flow) >> drop while import form already open → page-level overlay stays hidden
- Location: tests/e2e/specs/workflows/file-import-drag-drop.spec.js:180:3

# Error details

```
Error: page.goto: Protocol error (Page.navigate): Cannot navigate to invalid URL
Call log:
  - navigating to "/", waiting until "load"

```

# Test source

```ts
  82  |     await page.waitForFunction(() => {
  83  |       const text = document.getElementById('markdown-file-dropzone')?.textContent || '';
  84  |       return text.includes('File ready') && text.includes('drag-drop-test.md');
  85  |     }, null, { timeout: 5000 });
  86  | 
  87  |     // Page-level overlay is hidden (we're past the drag, in the form now)
  88  |     const overlayHiddenPostDrop = await page.evaluate(() => {
  89  |       const el = document.getElementById('page-drop-overlay');
  90  |       return !el || window.getComputedStyle(el).display === 'none';
  91  |     });
  92  |     expect(overlayHiddenPostDrop).toBe(true);
  93  | 
  94  |     // ──────────────────────────────────────────────────────────
  95  |     // Phase 3: Submit the import form → SPA transition to reader
  96  |     // ──────────────────────────────────────────────────────────
  97  |     await page.click('#createButton');
  98  | 
  99  |     await spa.waitForTransition(page);
  100 |     expect(await spa.getStructure(page)).toBe('reader');
  101 | 
  102 |     const importedBookId = await spa.getCurrentBookId(page);
  103 |     expect(importedBookId).toBeTruthy();
  104 |     expect(page.url()).toContain(`/${importedBookId}`);
  105 | 
  106 |     // Imported content rendered
  107 |     await page.waitForSelector('.main-content', { timeout: 10000 });
  108 |     const renderedText = await page.locator('.main-content').textContent();
  109 |     expect(renderedText).toContain('drag-and-drop import test');
  110 | 
  111 |     // ──────────────────────────────────────────────────────────
  112 |     // Phase 4: Post-import edit — same shape as authoring-workflow does
  113 |     // after creating a new book (proves both pathways converge cleanly)
  114 |     // ──────────────────────────────────────────────────────────
  115 |     // Enter edit mode (imports don't auto-enter; click the edit button)
  116 |     const inEditMode = await page.evaluate(() => !!window.isEditing);
  117 |     if (!inEditMode) {
  118 |       await page.click('#editButton');
  119 |       await page.waitForFunction(() => window.isEditing === true, null, { timeout: 5000 });
  120 |     }
  121 | 
  122 |     // Move cursor to end of the document and type a new paragraph
  123 |     await page.evaluate(() => {
  124 |       const blocks = document.querySelectorAll('.main-content p, .main-content h1, .main-content h2, .main-content h3, .main-content h4, .main-content h5, .main-content h6, .main-content li, .main-content blockquote');
  125 |       const lastBlock = blocks[blocks.length - 1];
  126 |       if (!lastBlock) return;
  127 |       const range = document.createRange();
  128 |       range.selectNodeContents(lastBlock);
  129 |       range.collapse(false);
  130 |       const sel = window.getSelection();
  131 |       sel.removeAllRanges();
  132 |       sel.addRange(range);
  133 |       lastBlock.focus();
  134 |     });
  135 |     await page.waitForTimeout(200);
  136 |     await page.keyboard.press('Enter');
  137 |     await page.keyboard.type('Added by the drag-drop e2e test');
  138 |     await page.waitForTimeout(500);
  139 | 
  140 |     // Wait for the cloud-sync indicator to go green (best effort — fall back
  141 |     // to a generous timeout if the icon class isn't immediately readable).
  142 |     try {
  143 |       await page.waitForFunction(() => {
  144 |         const cloudSvg = document.querySelector('#cloudRef-svg .cls-1');
  145 |         return cloudSvg && cloudSvg.getAttribute('fill') === '#63B995';
  146 |       }, null, { timeout: 8000 });
  147 |     } catch {
  148 |       await page.waitForTimeout(3000);
  149 |     }
  150 | 
  151 |     // Exit edit mode — this is the path that fires the integrity verifier on save
  152 |     await page.click('#editButton');
  153 |     await page.waitForFunction(() => window.isEditing === false, null, { timeout: 5000 });
  154 | 
  155 |     // ──────────────────────────────────────────────────────────
  156 |     // Phase 5: Navigate home → drop target re-initialises
  157 |     // ──────────────────────────────────────────────────────────
  158 |     await spa.navigateToHome(page);
  159 |     await spa.waitForTransition(page);
  160 |     expect(await spa.getStructure(page)).toBe('home');
  161 | 
  162 |     registry = await spa.getRegistryStatus(page);
  163 |     expect(registry?.activeComponents).toContain('homepageDropTarget');
  164 | 
  165 |     // Overlay element is fresh (not the leftover from before navigation) and hidden
  166 |     const freshOverlayHidden = await page.evaluate(() => {
  167 |       const el = document.getElementById('page-drop-overlay');
  168 |       return el && window.getComputedStyle(el).display === 'none';
  169 |     });
  170 |     expect(freshOverlayHidden).toBe(true);
  171 | 
  172 |     // ──────────────────────────────────────────────────────────
  173 |     // Phase 6: SPA + console health on final state
  174 |     // ──────────────────────────────────────────────────────────
  175 |     spa.assertHealthy(await spa.healthCheck(page));
  176 |     await spa.assertRegistryHealthy(page, 'home');
  177 |     expect(spa.filterConsoleErrors(page.consoleErrors)).toHaveLength(0);
  178 |   });
  179 | 
  180 |   test('drop while import form already open → page-level overlay stays hidden', async ({ page, spa }) => {
  181 |     test.setTimeout(60_000);
> 182 |     await page.goto('/');
      |                ^ Error: page.goto: Protocol error (Page.navigate): Cannot navigate to invalid URL
  183 |     await page.waitForLoadState('networkidle');
  184 |     expect(await spa.getStructure(page)).toBe('home');
  185 | 
  186 |     // Open the import form via the button (NOT via drop)
  187 |     await page.click('#importBook');
  188 |     await page.waitForSelector('#cite-form', { timeout: 5000 });
  189 | 
  190 |     // Drop a file on window — overlay should NOT appear because the form is open;
  191 |     // the file should still attach to the form's existing input as a convenience.
  192 |     await dropFileOnWindow(page, {
  193 |       name: 'while-form-open.md',
  194 |       type: 'text/markdown',
  195 |       content: '# Test\n\nForm-open drop.',
  196 |     });
  197 | 
  198 |     // Overlay never flips to display: flex
  199 |     const overlayHidden = await page.evaluate(() => {
  200 |       const el = document.getElementById('page-drop-overlay');
  201 |       return !el || window.getComputedStyle(el).display === 'none';
  202 |     });
  203 |     expect(overlayHidden).toBe(true);
  204 | 
  205 |     // File auto-attached to existing input
  206 |     await page.waitForFunction(() => {
  207 |       const input = document.getElementById('markdown_file');
  208 |       return input && input.files && input.files[0] && input.files[0].name === 'while-form-open.md';
  209 |     }, null, { timeout: 3000 });
  210 | 
  211 |     expect(spa.filterConsoleErrors(page.consoleErrors)).toHaveLength(0);
  212 |   });
  213 | 
  214 |   test('reader page does not register drop target', async ({ page, spa }) => {
  215 |     const bookSlug = process.env.E2E_READER_BOOK;
  216 |     test.skip(!bookSlug, 'E2E_READER_BOOK not set in .env.e2e');
  217 |     test.setTimeout(60_000);
  218 | 
  219 |     await page.goto(`/${bookSlug}`);
  220 |     await page.waitForLoadState('networkidle');
  221 |     expect(await spa.getStructure(page)).toBe('reader');
  222 | 
  223 |     // Registry filter prevents homepageDropTarget from being active
  224 |     const registry = await spa.getRegistryStatus(page);
  225 |     expect(registry?.activeComponents || []).not.toContain('homepageDropTarget');
  226 | 
  227 |     // No overlay element exists in the DOM
  228 |     const overlayPresent = await page.evaluate(() => !!document.getElementById('page-drop-overlay'));
  229 |     expect(overlayPresent).toBe(false);
  230 | 
  231 |     // A drop on window does nothing visible — no overlay flashes into existence
  232 |     await dropFileOnWindow(page, {
  233 |       name: 'reader-drop.md',
  234 |       type: 'text/markdown',
  235 |       content: '# Should be ignored',
  236 |     });
  237 | 
  238 |     const overlayStillAbsent = await page.evaluate(() => !!document.getElementById('page-drop-overlay'));
  239 |     expect(overlayStillAbsent).toBe(false);
  240 | 
  241 |     // Form must NOT have opened either
  242 |     const formExists = await page.evaluate(() => !!document.getElementById('cite-form'));
  243 |     expect(formExists).toBe(false);
  244 | 
  245 |     expect(spa.filterConsoleErrors(page.consoleErrors)).toHaveLength(0);
  246 |   });
  247 | });
  248 | 
```