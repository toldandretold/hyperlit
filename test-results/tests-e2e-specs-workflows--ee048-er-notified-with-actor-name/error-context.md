# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: tests/e2e/specs/workflows/notifications.spec.js >> Notifications >> a second registered user likes + cites → owner notified with actor name
- Location: tests/e2e/specs/workflows/notifications.spec.js:188:3

# Error details

```
Error: page.goto: Protocol error (Page.navigate): Cannot navigate to invalid URL
Call log:
  - navigating to "/", waiting until "load"

```

# Test source

```ts
  1   | import { test, expect } from '../../fixtures/navigation.fixture.js';
  2   | import { findParagraphByText, waitForCloudGreen } from '../../helpers/pageVerifiers.js';
  3   | import { readLibrary } from '../../helpers/backendRead.js';
  4   | 
  5   | /**
  6   |  * Notifications end-to-end: real engagement by OTHER identities surfaces for
  7   |  * the book owner as feed rows + the pink unread dot, via real gestures only.
  8   |  *
  9   |  *  1. Owner (the suite's logged-in user) authors a book (grand-tour recipe),
  10  |  *     flips it PUBLIC through the source container's visibility control.
  11  |  *  2. An ANONYMOUS context hyperlights it → owner sees "Someone highlighted
  12  |  *     your book …" with the pink dot on #userButton and the Notifications row.
  13  |  *  3. A REGISTERED second user (created through the real signup form) likes
  14  |  *     the book via the source container's #like-book — the first e2e coverage
  15  |  *     that button has ever had — and mints + pastes a hypercite (pairing) →
  16  |  *     owner sees "liked your book" and "cited".
  17  |  *
  18  |  * Opening the panel marks everything read: the dot must be gone on re-open.
  19  |  */
  20  | 
  21  | /** Author a fresh book as the CURRENT page's user and make it public. */
  22  | async function authorPublicBook(page, spa, title) {
> 23  |   await page.goto('/');
      |              ^ Error: page.goto: Protocol error (Page.navigate): Cannot navigate to invalid URL
  24  |   await page.waitForLoadState('networkidle');
  25  | 
  26  |   await page.evaluate(() => document.getElementById('newBookButton')?.click());
  27  |   await page.waitForFunction(() => {
  28  |     const c = document.getElementById('newbook-container');
  29  |     return c && window.getComputedStyle(c).opacity !== '0' && window.getComputedStyle(c).width !== '0px';
  30  |   }, null, { timeout: 5000 });
  31  |   await page.evaluate(() => document.getElementById('createNewBook')?.click());
  32  | 
  33  |   await spa.waitForTransition(page);
  34  |   await spa.waitForEditMode(page);
  35  |   const bookId = await spa.getCurrentBookId(page);
  36  |   expect(bookId).toMatch(/^book_\d+$/);
  37  | 
  38  |   await page.waitForSelector('h1[id="100"]', { timeout: 5000 });
  39  |   await page.click('h1[id="100"]');
  40  |   await page.keyboard.type(title);
  41  |   await page.keyboard.press('Enter');
  42  |   await page.waitForTimeout(300);
  43  |   await page.keyboard.type('Notification source text for highlight and quote. Some content worth engaging with.');
  44  |   await page.waitForTimeout(500);
  45  |   await waitForCloudGreen(page);
  46  | 
  47  |   // Public, via the real visibility control in the source container.
  48  |   await page.click('#cloudRef');
  49  |   await page.waitForSelector('#source-container.open', { timeout: 8000 });
  50  |   await page.waitForSelector('#visibility-control .visibility-trigger', { timeout: 8000 });
  51  |   await page.click('#visibility-control .visibility-trigger');
  52  |   await page.waitForSelector('#visibility-control.vis-open', { timeout: 4000 });
  53  |   await page.click('#visibility-control .visibility-option[data-target="public"]');
  54  |   // "Make this book public?" confirm dialog (components/dialog).
  55  |   await page.waitForSelector('.app-dialog-overlay [data-act="confirm"]', { timeout: 5000 });
  56  |   await page.click('.app-dialog-overlay [data-act="confirm"]');
  57  |   await page.waitForSelector('#visibility-control[data-state="public"]', { timeout: 10000 });
  58  | 
  59  |   // Confirm the flip reached Postgres before another identity tries to read it.
  60  |   await expect(async () => {
  61  |     const lib = await readLibrary(page, bookId);
  62  |     expect(lib.ok).toBe(true);
  63  |     expect(lib.body?.visibility ?? lib.body?.library?.visibility).toBe('public');
  64  |   }).toPass({ timeout: 10000 });
  65  | 
  66  |   await page.keyboard.press('Escape'); // close the source container
  67  |   return bookId;
  68  | }
  69  | 
  70  | /** Open a book and wait until its content (containing `needle`) is actually rendered. */
  71  | async function openBookWithContent(page, bookId, needle) {
  72  |   await page.goto(`/${bookId}`, { waitUntil: 'domcontentloaded' });
  73  |   // A freshly-navigated (esp. just-registered / anonymous) context can hold a
  74  |   // boot connection open past networkidle while the content is long usable —
  75  |   // wait on the CONTENT, generously, not the network.
  76  |   await page.waitForFunction(
  77  |     (text) => (document.querySelector('.main-content')?.textContent || '').includes(text),
  78  |     needle,
  79  |     { timeout: 45000 },
  80  |   );
  81  |   await page.waitForTimeout(1000); // let annotations + session settle
  82  | }
  83  | 
  84  | /** Select `needle` in the paragraph containing `anchorText` and hyperlight it. */
  85  | async function hyperlightAs(page, spa, needle, anchorText) {
  86  |   const sel = await findParagraphByText(page, anchorText);
  87  |   expect(sel).not.toBeNull();
  88  |   const text = await page.locator(sel).textContent();
  89  |   const start = text.indexOf(needle);
  90  |   expect(start).toBeGreaterThanOrEqual(0);
  91  |   await spa.selectTextInElement(page, sel, start, start + needle.length);
  92  |   await spa.waitForHyperlightButtons(page);
  93  |   await page.click('#copy-hyperlight');
  94  |   await page.waitForFunction(() => {
  95  |     const marks = document.querySelectorAll('.main-content mark.user-highlight, .main-content mark.highlight');
  96  |     return marks.length >= 1;
  97  |   }, null, { timeout: 10000 });
  98  |   await waitForCloudGreen(page);
  99  | }
  100 | 
  101 | /** Register a brand-new user through the real signup form (page must be a fresh, logged-out context). */
  102 | async function registerUser(page, name) {
  103 |   await page.goto('/');
  104 |   await page.waitForLoadState('domcontentloaded');
  105 |   await expect(async () => {
  106 |     if (!(await page.locator('input[type="email"]').first().isVisible())) {
  107 |       await page.click('#userButton');
  108 |     }
  109 |     await expect(page.locator('input[type="email"]').first()).toBeVisible({ timeout: 1000 });
  110 |   }).toPass({ timeout: 15000 });
  111 |   await page.click('#showRegister');
  112 |   await page.fill('#registerName', name);
  113 |   await page.fill('#registerEmail', `${name}@test.local`);
  114 |   await page.fill('#registerPassword', 'password-e2e-1');
  115 |   await expect(async () => {
  116 |     await page.evaluate(() => document.getElementById('registerSubmit')?.click());
  117 |     await page.waitForFunction(() => !document.querySelector('#registerPassword'), null, { timeout: 4000 });
  118 |   }).toPass({ timeout: 20000 });
  119 | }
  120 | 
  121 | /** Open the account menu; return whether #userButton currently carries the dot. */
  122 | async function openAccountMenu(page) {
  123 |   await expect(async () => {
```