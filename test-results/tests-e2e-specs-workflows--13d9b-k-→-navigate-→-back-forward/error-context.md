# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: tests/e2e/specs/workflows/authoring-workflow.spec.js >> Full authoring workflow >> create → edit → annotate → link → navigate → back/forward
- Location: tests/e2e/specs/workflows/authoring-workflow.spec.js:4:3

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
  3   | test.describe('Full authoring workflow', () => {
  4   |   test('create → edit → annotate → link → navigate → back/forward', async ({ page, spa }) => {
  5   |     test.setTimeout(120_000);
  6   | 
  7   |     // Shared state across phases
  8   |     let book1Id;
  9   |     let book2Id;
  10  |     let clipboardHtml;
  11  |     let clipboardText;
  12  |     let hyperciteId;
  13  | 
  14  |     // ──────────────────────────────────────────────────────────
  15  |     // Phase 1: Create Book 1 from Homepage
  16  |     // ──────────────────────────────────────────────────────────
> 17  |     await page.goto('/');
      |                ^ Error: page.goto: Protocol error (Page.navigate): Cannot navigate to invalid URL
  18  |     await page.waitForLoadState('networkidle');
  19  |     expect(await spa.getStructure(page)).toBe('home');
  20  | 
  21  |     // Open new-book container and create
  22  |     await page.click('#newBook');
  23  |     await page.waitForFunction(() => {
  24  |       const c = document.getElementById('newbook-container');
  25  |       return c && window.getComputedStyle(c).opacity !== '0' && window.getComputedStyle(c).width !== '0px';
  26  |     }, { timeout: 5000 });
  27  |     await page.click('#createNewBook');
  28  | 
  29  |     // Wait for SPA transition to the new book
  30  |     await spa.waitForTransition(page);
  31  |     expect(await spa.getStructure(page)).toBe('reader');
  32  | 
  33  |     // Book creation enters edit mode automatically
  34  |     await spa.waitForEditMode(page);
  35  | 
  36  |     // Capture book 1 ID
  37  |     book1Id = await spa.getCurrentBookId(page);
  38  |     expect(book1Id).toMatch(/^book_\d+$/);
  39  |     expect(page.url()).toContain(`/${book1Id}`);
  40  | 
  41  |     // Verify initial heading exists
  42  |     await page.waitForSelector('h1#100', { timeout: 5000 });
  43  | 
  44  |     // ──────────────────────────────────────────────────────────
  45  |     // Phase 2: Type Text
  46  |     // ──────────────────────────────────────────────────────────
  47  |     await page.click('h1#100');
  48  |     await page.keyboard.type('My Test Book');
  49  |     await page.keyboard.press('Enter');
  50  |     await page.waitForTimeout(500);
  51  |     await page.keyboard.type('This is bold text and italic text and normal');
  52  |     await page.keyboard.press('Enter');
  53  |     await page.waitForTimeout(300);
  54  |     await page.keyboard.type('Text for highlighting and hyperciting later');
  55  |     await page.waitForTimeout(500);
  56  | 
  57  |     // Assert title and paragraph content
  58  |     const h1Text = await page.locator('h1#100').textContent();
  59  |     expect(h1Text.trim()).toBe('My Test Book');
  60  | 
  61  |     const paragraphs = await page.locator('.main-content p').count();
  62  |     expect(paragraphs).toBeGreaterThanOrEqual(2);
  63  | 
  64  |     // ──────────────────────────────────────────────────────────
  65  |     // Phase 3: Edit Toolbar Formatting
  66  |     // ──────────────────────────────────────────────────────────
  67  | 
  68  |     // Bold: select "bold text" in first <p>
  69  |     const firstP = '.main-content p:first-of-type';
  70  |     const firstPText = await page.locator(firstP).textContent();
  71  |     const boldStart = firstPText.indexOf('bold text');
  72  |     expect(boldStart).toBeGreaterThanOrEqual(0);
  73  |     await spa.selectTextInElement(page, firstP, boldStart, boldStart + 'bold text'.length);
  74  |     await page.click('#boldButton');
  75  |     await page.waitForTimeout(300);
  76  |     const hasBold = await page.locator(`${firstP} strong, ${firstP} b`).count();
  77  |     expect(hasBold).toBeGreaterThanOrEqual(1);
  78  | 
  79  |     // Italic: select "italic text" in first <p>
  80  |     // Re-read text after bold formatting may have changed offsets
  81  |     const firstPText2 = await page.locator(firstP).textContent();
  82  |     const italicStart = firstPText2.indexOf('italic text');
  83  |     expect(italicStart).toBeGreaterThanOrEqual(0);
  84  |     await spa.selectTextInElement(page, firstP, italicStart, italicStart + 'italic text'.length);
  85  |     await page.click('#italicButton');
  86  |     await page.waitForTimeout(300);
  87  |     const hasItalic = await page.locator(`${firstP} em, ${firstP} i`).count();
  88  |     expect(hasItalic).toBeGreaterThanOrEqual(1);
  89  | 
  90  |     // Heading: type text, then convert to h2
  91  |     await page.keyboard.press('Enter');
  92  |     await page.waitForTimeout(200);
  93  |     await page.keyboard.type('Heading text');
  94  |     await page.waitForTimeout(200);
  95  |     await page.click('#headingButton');
  96  |     await page.waitForSelector('#heading-submenu:not(.hidden)', { timeout: 3000 });
  97  |     await page.click('[data-heading="h2"]');
  98  |     await page.waitForTimeout(300);
  99  |     const hasH2 = await page.locator('.main-content h2').count();
  100 |     expect(hasH2).toBeGreaterThanOrEqual(1);
  101 | 
  102 |     // Blockquote: type text, then convert to blockquote
  103 |     await page.keyboard.press('Enter');
  104 |     await page.waitForTimeout(200);
  105 |     await page.keyboard.type('Quote text');
  106 |     await page.waitForTimeout(200);
  107 |     await page.click('#blockquoteButton');
  108 |     await page.waitForSelector('#blockquote-submenu:not(.hidden)', { timeout: 3000 });
  109 |     await page.click('[data-block-type="blockquote"]');
  110 |     await page.waitForTimeout(300);
  111 |     const hasBlockquote = await page.locator('.main-content blockquote').count();
  112 |     expect(hasBlockquote).toBeGreaterThanOrEqual(1);
  113 | 
  114 |     // List: type text, then convert to ul
  115 |     await page.keyboard.press('Enter');
  116 |     await page.waitForTimeout(200);
  117 |     await page.keyboard.type('List item');
```