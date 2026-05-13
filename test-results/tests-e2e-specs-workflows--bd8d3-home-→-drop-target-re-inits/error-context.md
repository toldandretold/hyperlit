# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: tests/e2e/specs/workflows/file-import-drag-drop.spec.js >> File import via drag-and-drop (SPA flow) >> drop .md on home → import → edit → home → drop target re-inits
- Location: tests/e2e/specs/workflows/file-import-drag-drop.spec.js:42:3

# Error details

```
Error: page.goto: Protocol error (Page.navigate): Cannot navigate to invalid URL
Call log:
  - navigating to "/", waiting until "load"

```

# Test source

```ts
  1   | import { test, expect } from '../../fixtures/navigation.fixture.js';
  2   | 
  3   | /**
  4   |  * File-import drag-and-drop workflow.
  5   |  *
  6   |  * Exercises:
  7   |  *   - Page-level drop overlay registration via buttonRegistry
  8   |  *   - Synthetic file drop via DataTransfer (the same path an OS drag triggers)
  9   |  *   - Auto-open of the import form with the dropped file pre-attached
  10  |  *   - Inline dropzone "File ready" green state
  11  |  *   - Form submission → SPA transition to the imported book's reader page
  12  |  *   - Post-import editing (matches the patterns used by authoring-workflow.spec.js)
  13  |  *   - SPA navigation back to home → drop target re-initializes cleanly
  14  |  *   - Suppression of the page-level overlay while the form is already open
  15  |  *   - Reader pages do not register the drop target (registry filtering works)
  16  |  */
  17  | 
  18  | /**
  19  |  * Dispatch a synthetic file drop on the window. Mirrors what an OS file drag
  20  |  * triggers — the same dataTransfer.types/files surface that our window listeners
  21  |  * read in homepageDropTarget.js.
  22  |  */
  23  | async function dropFileOnWindow(page, { name, type, content }) {
  24  |   await page.evaluate(({ name, type, content }) => {
  25  |     const dt = new DataTransfer();
  26  |     const file = new File([content], name, { type });
  27  |     dt.items.add(file);
  28  |     window.dispatchEvent(new DragEvent('dragenter', { dataTransfer: dt, bubbles: true, cancelable: true }));
  29  |     window.dispatchEvent(new DragEvent('dragover',  { dataTransfer: dt, bubbles: true, cancelable: true }));
  30  |     window.dispatchEvent(new DragEvent('drop',      { dataTransfer: dt, bubbles: true, cancelable: true }));
  31  |   }, { name, type, content });
  32  | }
  33  | 
  34  | const SAMPLE_MD = `# Drag Drop Test Book
  35  | 
  36  | This paragraph was created via the e2e drag-and-drop import test.
  37  | 
  38  | A second paragraph for content.
  39  | `;
  40  | 
  41  | test.describe('File import via drag-and-drop (SPA flow)', () => {
  42  |   test('drop .md on home → import → edit → home → drop target re-inits', async ({ page, spa }) => {
  43  |     test.setTimeout(180_000);
  44  | 
  45  |     // ──────────────────────────────────────────────────────────
  46  |     // Phase 1: Home loads, drop target is registered
  47  |     // ──────────────────────────────────────────────────────────
> 48  |     await page.goto('/');
      |                ^ Error: page.goto: Protocol error (Page.navigate): Cannot navigate to invalid URL
  49  |     await page.waitForLoadState('networkidle');
  50  |     expect(await spa.getStructure(page)).toBe('home');
  51  | 
  52  |     let registry = await spa.getRegistryStatus(page);
  53  |     expect(registry?.activeComponents).toContain('homepageDropTarget');
  54  | 
  55  |     // Overlay element exists but is hidden by default
  56  |     const overlayInitiallyHidden = await page.evaluate(() => {
  57  |       const el = document.getElementById('page-drop-overlay');
  58  |       return el && window.getComputedStyle(el).display === 'none';
  59  |     });
  60  |     expect(overlayInitiallyHidden).toBe(true);
  61  | 
  62  |     // ──────────────────────────────────────────────────────────
  63  |     // Phase 2: Drop a .md file via synthetic DataTransfer
  64  |     // ──────────────────────────────────────────────────────────
  65  |     await dropFileOnWindow(page, {
  66  |       name: 'drag-drop-test.md',
  67  |       type: 'text/markdown',
  68  |       content: SAMPLE_MD,
  69  |     });
  70  | 
  71  |     // Form opens (the click on #importBook is fired internally by handleAcceptedDrop)
  72  |     await page.waitForSelector('#cite-form', { timeout: 10000 });
  73  | 
  74  |     // File landed in the input
  75  |     const attachedName = await page.evaluate(() => {
  76  |       const input = document.getElementById('markdown_file');
  77  |       return input && input.files && input.files[0] ? input.files[0].name : null;
  78  |     });
  79  |     expect(attachedName).toBe('drag-drop-test.md');
  80  | 
  81  |     // Inline dropzone reflects the file-ready state
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
```