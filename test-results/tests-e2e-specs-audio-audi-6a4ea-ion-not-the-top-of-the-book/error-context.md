# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: tests/e2e/specs/audio/audio-start-position.spec.js >> audio start position >> Listen starts at the current reading position, not the top of the book
- Location: tests/e2e/specs/audio/audio-start-position.spec.js:78:3

# Error details

```
Error: page.goto: Protocol error (Page.navigate): Cannot navigate to invalid URL
Call log:
  - navigating to "/", waiting until "load"

```

# Test source

```ts
  1   | /**
  2   |  * Nested-authoring primitives.
  3   |  *
  4   |  * The author flow can recursively nest:
  5   |  *   main book → footnote → hyperlight on footnote text → footnote inside
  6   |  *   that hyperlight → ...  Each new level opens a fresh stacked
  7   |  *   hyperlit-container with its own `.sub-book-content[contenteditable]`.
  8   |  *
  9   |  * These helpers always operate on the **topmost open editable surface** —
  10  |  * the deepest stacked container if any are open, else `.main-content`.
  11  |  */
  12  | 
  13  | /**
  14  |  * Create a new book from the homepage. Lands in the reader in edit mode.
  15  |  * Returns { bookId }.
  16  |  */
  17  | export async function createNewBook(page, spa) {
> 18  |   await page.goto('/');
      |              ^ Error: page.goto: Protocol error (Page.navigate): Cannot navigate to invalid URL
  19  |   await page.waitForLoadState('networkidle');
  20  |   await page.click('#newBookButton');
  21  |   await page.waitForFunction(() => {
  22  |     const c = document.getElementById('newbook-container');
  23  |     return c && window.getComputedStyle(c).opacity !== '0' && window.getComputedStyle(c).width !== '0px';
  24  |   }, null, { timeout: 5000 });
  25  |   await page.click('#createNewBook');
  26  |   await spa.waitForTransition(page);
  27  |   await spa.waitForEditMode(page);
  28  |   const bookId = await spa.getCurrentBookId(page);
  29  |   if (!/^book_\d+/.test(String(bookId))) {
  30  |     throw new Error(`createNewBook: expected book_<digits>, got "${bookId}"`);
  31  |   }
  32  |   // Wait for the initial h1 to be present
  33  |   await page.waitForSelector('h1[id="100"]', { timeout: 5000 });
  34  |   return { bookId };
  35  | }
  36  | 
  37  | /**
  38  |  * Return the topmost editable element on the page — used as the "active
  39  |  * edit context" for type / select / footnote / hyperlight operations.
  40  |  *
  41  |  * Resolves to (in priority order):
  42  |  *   - The deepest open `.hyperlit-container-stacked.open .sub-book-content[contenteditable="true"]`
  43  |  *   - The base `#hyperlit-container.open .sub-book-content[contenteditable="true"]`
  44  |  *   - `.main-content` (edit mode)
  45  |  */
  46  | async function resolveActiveEditTargetHandle(page) {
  47  |   return page.evaluateHandle(() => {
  48  |     // Deepest stacked first
  49  |     const stacked = [...document.querySelectorAll('.hyperlit-container-stacked.open')];
  50  |     const topStacked = stacked[stacked.length - 1];
  51  |     if (topStacked) {
  52  |       const editable = topStacked.querySelector('.sub-book-content[contenteditable="true"]');
  53  |       if (editable) return editable;
  54  |     }
  55  |     // Then base hyperlit-container
  56  |     const base = document.querySelector('#hyperlit-container.open');
  57  |     if (base) {
  58  |       const editable = base.querySelector('.sub-book-content[contenteditable="true"]');
  59  |       if (editable) return editable;
  60  |     }
  61  |     // Fallback to main content (only valid when edit mode is on)
  62  |     return document.querySelector('.main-content');
  63  |   });
  64  | }
  65  | 
  66  | /**
  67  |  * Get the current stack depth (0 = main content only, 1 = main + base container, etc.)
  68  |  */
  69  | export async function getStackDepth(page) {
  70  |   return page.evaluate(() => {
  71  |     return (document.querySelector('#hyperlit-container.open') ? 1 : 0)
  72  |       + document.querySelectorAll('.hyperlit-container-stacked.open').length;
  73  |   });
  74  | }
  75  | 
  76  | /**
  77  |  * Place caret at end of the active editor and type `text`.
  78  |  */
  79  | export async function typeAtEndOfActiveEditor(page, text) {
  80  |   const handle = await resolveActiveEditTargetHandle(page);
  81  |   await page.evaluate((el) => {
  82  |     if (!el) throw new Error('No active editor');
  83  |     // For nested .sub-book-content, find last block descendant
  84  |     const blocks = el.querySelectorAll('p, h1, h2, h3, h4, h5, h6, li, blockquote');
  85  |     const target = blocks.length ? blocks[blocks.length - 1] : el;
  86  |     const range = document.createRange();
  87  |     range.selectNodeContents(target);
  88  |     range.collapse(false);
  89  |     const sel = window.getSelection();
  90  |     sel.removeAllRanges();
  91  |     sel.addRange(range);
  92  |     (target.focus ? target : el).focus();
  93  |   }, handle);
  94  |   await handle.dispose();
  95  |   await page.keyboard.type(text);
  96  | }
  97  | 
  98  | /**
  99  |  * Select the entire content (or a phrase) inside the active editor.
  100 |  * If `phrase` is null, selects all text inside the topmost block.
  101 |  */
  102 | export async function selectInActiveEditor(page, phrase) {
  103 |   const handle = await resolveActiveEditTargetHandle(page);
  104 |   await page.evaluate(({ el, phrase }) => {
  105 |     if (!el) throw new Error('No active editor');
  106 |     const blocks = el.querySelectorAll('p, h1, h2, h3, h4, h5, h6, li, blockquote');
  107 |     const target = blocks.length ? blocks[blocks.length - 1] : el;
  108 |     const text = target.textContent || '';
  109 |     if (!text) throw new Error('Active editor is empty — cannot select');
  110 |     let startOffset = 0;
  111 |     let endOffset = text.length;
  112 |     if (phrase) {
  113 |       const idx = text.indexOf(phrase);
  114 |       if (idx >= 0) { startOffset = idx; endOffset = idx + phrase.length; }
  115 |     }
  116 |     // Walk text nodes to find positions
  117 |     const walker = document.createTreeWalker(target, NodeFilter.SHOW_TEXT, null, false);
  118 |     let charCount = 0;
```