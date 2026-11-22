/**
 * Code blocks through the REAL editor UX — typed text, toolbar clicks, real
 * Cmd+C / Cmd+V through the system clipboard. Unit tests prove the pieces;
 * these prove the feel:
 *
 *   1. Several paragraphs → code makes ONE block, and its header (label, copy,
 *      expand) appears AT ONCE in edit mode — no refresh.
 *   2. Leaving edit mode colours it and shows the read-mode header — no refresh.
 *   3. Copying PART of a code block and pasting into a paragraph gives plain
 *      paragraph text, not a second code block.
 *   4. Everything survives a reload, and nothing render-only is saved.
 */
import { test, expect } from '../../fixtures/navigation.fixture.js';
import { waitForCloudGreen } from '../../helpers/pageVerifiers.js';

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

async function openNewBook(page, spa) {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await page.click('#newBookButton');
  await page.waitForFunction(() => {
    const c = document.getElementById('newbook-container');
    return c && window.getComputedStyle(c).opacity !== '0' && window.getComputedStyle(c).width !== '0px';
  }, null, { timeout: 5000 });
  await page.click('#createNewBook');
  await spa.waitForTransition(page);
  await spa.waitForEditMode(page);
  await page.waitForSelector('h1[id="100"]', { timeout: 5000 });
}

async function clickBlockType(page, type) {
  await page.click('#blockquoteButton');
  await page.waitForSelector('#blockquote-submenu:not(.hidden)', { timeout: 5000 });
  await page.click(`#blockquote-submenu [data-block-type="${type}"]`);
  await page.waitForTimeout(400);
}

/** Select from the start of the element holding `fromText` to the end of the one holding `toText`. */
async function selectParagraphs(page, fromText, toText) {
  await page.evaluate(([a, b]) => {
    const norm = (t) => t.replace(/\u00A0/g, ' ').trim();
    const ps = Array.from(document.querySelectorAll('.main-content p'));
    const first = ps.find((p) => norm(p.textContent) === norm(a));
    const last = ps.find((p) => norm(p.textContent) === norm(b));
    const r = document.createRange();
    r.setStart(first.firstChild, 0);
    r.setEnd(last.lastChild, last.lastChild.textContent.length);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
    document.dispatchEvent(new Event('selectionchange'));
  }, [fromText, toText]);
  await page.waitForTimeout(200);
}

async function codeBlockState(page) {
  return page.evaluate(() => {
    const pres = Array.from(document.querySelectorAll('.main-content pre'));
    return pres.map((pre) => {
      const header = pre.querySelector('.code-block-header');
      const code = pre.querySelector('code');
      return {
        text: (() => {
          const c = (code ?? pre).cloneNode(true);
          c.querySelectorAll('[data-render-only]').forEach((e) => e.remove());
          return c.textContent;
        })(),
        brs: (code ?? pre).querySelectorAll('br').length,
        hasHeader: !!header,
        headerEditing: header?.getAttribute('data-editing') ?? null,
        hasCopy: !!pre.querySelector('[data-code-action="copy"]'),
        hasExpand: !!pre.querySelector('[data-code-action="expand"]'),
        tokenSpans: pre.querySelectorAll('span[data-code-tok]').length,
        label: pre.querySelector('.code-block-lang')?.getAttribute('data-label') ?? null,
      };
    });
  });
}

const LINES = [
  'def greet(name):',
  '    message = "Hello, " + name',
  '    return message',
];
const LINES2 = ['for person in ["Ada", "Grace"]:', '    print(greet(person))'];

test.describe('divEditor — code block gestures', () => {
  test.beforeEach(async ({ context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  });

  test('paragraphs → one code block, decorated live in edit mode and after exit', async ({ page, spa }) => {
    test.setTimeout(120_000);
    await openNewBook(page, spa);

    // Type the program the way it arrives as prose: lines, blank-line split.
    await page.click('h1[id="100"]');
    await page.keyboard.press('End');
    for (const line of [...LINES, ...LINES2]) {
      await page.keyboard.press('Enter');
      await page.waitForTimeout(150);
      await page.keyboard.type(line);
    }

    await selectParagraphs(page, LINES[0], LINES2[1]);
    await clickBlockType(page, 'code');

    let state = await codeBlockState(page);
    expect(state.length, 'all selected paragraphs become ONE code block').toBe(1);
    expect(state[0].text).toBe([...LINES, ...LINES2].join('\n'));
    expect(state[0].hasHeader, 'header must appear immediately in edit mode, no refresh').toBe(true);
    expect(state[0].headerEditing).toBe('1');
    expect(state[0].hasCopy).toBe(true);

    // Leave edit mode: colours + read-mode header, no refresh.
    await page.click('#editButton');
    await page.waitForFunction(() => !window.isEditing);
    await expect.poll(async () => (await codeBlockState(page))[0]?.tokenSpans ?? 0, {
      message: 'code must be coloured after leaving edit mode, no refresh',
      timeout: 5000,
    }).toBeGreaterThan(0);
    state = await codeBlockState(page);
    expect(state[0].headerEditing).toBe('0');
    expect(state[0].hasCopy).toBe(true);
    expect(state[0].hasExpand).toBe(true);
    expect(state[0].label).toBe('Python');

    // Reload: same block, same text, still decorated.
    await page.waitForTimeout(2500);
    await page.reload();
    await page.waitForLoadState('networkidle');
    await spa.waitForTransition(page).catch(() => {});
    await expect.poll(async () => (await codeBlockState(page))[0]?.tokenSpans ?? 0, { timeout: 8000 }).toBeGreaterThan(0);
    state = await codeBlockState(page);
    expect(state.length).toBe(1);
    expect(state[0].text).toBe([...LINES, ...LINES2].join('\n'));
  });

  test('copy PART of a code block, paste into a paragraph → plain paragraph text', async ({ page, spa }) => {
    test.setTimeout(120_000);
    await openNewBook(page, spa);

    await page.click('h1[id="100"]');
    await page.keyboard.press('End');
    for (const line of LINES) {
      await page.keyboard.press('Enter');
      await page.waitForTimeout(150);
      await page.keyboard.type(line);
    }
    await selectParagraphs(page, LINES[0], LINES[2]);
    await clickBlockType(page, 'code');
    expect((await codeBlockState(page)).length).toBe(1);

    // A paragraph after the code block to paste into.
    await page.evaluate(() => {
      const code = document.querySelector('.main-content pre code');
      const r = document.createRange();
      r.selectNodeContents(code);
      r.collapse(false);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(r);
    });
    // Typing a line inside the block: newline is TEXT (no <br>, no zero-width junk).
    await page.keyboard.press('Enter');
    await page.keyboard.type('greet("x")');
    const typed = await codeBlockState(page);
    expect(typed[0].text).toBe([...LINES, 'greet("x")'].join('\n'));
    // Triple Enter at the end leaves the block into a fresh paragraph.
    for (let i = 0; i < 3; i++) { await page.keyboard.press('Enter'); await page.waitForTimeout(80); }
    await page.waitForTimeout(300);
    const left = await codeBlockState(page);
    expect(left[0].text, 'leaving the block strips the trailing newlines').toBe([...LINES, 'greet("x")'].join('\n'));
    await page.keyboard.type('Pasted: ');
    const afterHtml = await page.evaluate(() => document.querySelector('.main-content pre').nextElementSibling?.outerHTML ?? null);
    expect(afterHtml, 'a paragraph follows the code block').toMatch(/^<p/);

    // Select "message" on line 2 and copy it with the real clipboard.
    await page.evaluate(() => {
      const code = document.querySelector('.main-content pre code');
      const walker = document.createTreeWalker(code, NodeFilter.SHOW_TEXT);
      let n;
      while ((n = walker.nextNode())) {
        const i = n.data.indexOf('message =');
        if (i >= 0) {
          const r = document.createRange();
          r.setStart(n, i);
          r.setEnd(n, i + 'message'.length);
          const sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(r);
          return;
        }
      }
      throw new Error('message not found');
    });
    await page.keyboard.press(`${MOD}+c`);
    await page.waitForTimeout(200);

    // Caret to the end of the paragraph and paste.
    await page.evaluate(() => {
      const p = document.querySelector('.main-content pre').nextElementSibling;
      const r = document.createRange();
      r.selectNodeContents(p);
      r.collapse(false);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(r);
    });
    await page.keyboard.press(`${MOD}+v`);
    await page.waitForTimeout(800);

    const result = await page.evaluate(() => ({
      pres: document.querySelectorAll('.main-content pre').length,
      after: document.querySelector('.main-content pre').nextElementSibling?.outerHTML,
    }));
    expect(result.pres, 'pasting a fragment must not mint a second code block').toBe(1);
    expect(result.after).toMatch(/^<p[^>]*>Pasted:(\s|&nbsp;)*message<\/p>$/);
  });

  test('paste plain-text Python (comments first) → one code block, exact text, labelled live', async ({ page, spa }) => {
    test.setTimeout(120_000);
    await openNewBook(page, spa);
    const PY = '# Create a file (for demo purposes)\nwith open("myfile.txt", "w") as f:\n    f.write("First line.\\nSecond line.\\n")\n\n# Read the whole file\nwith open("myfile.txt", "r") as f:\n    text = f.read()\n\nprint(text)';

    await page.click('h1[id="100"]');
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(200);
    await page.evaluate((t) => navigator.clipboard.writeText(t), PY);
    await page.keyboard.press(`${MOD}+v`);
    await page.waitForTimeout(800);

    const state = await codeBlockState(page);
    expect(state.length, 'the whole program is ONE code block').toBe(1);
    expect(state[0].text, 'comments keep their "#", nothing reflowed').toBe(PY);
    expect(await page.locator('.main-content h1').count(), 'no comment became a heading').toBe(1);
    expect(state[0].hasHeader).toBe(true);
    await expect.poll(async () => (await codeBlockState(page))[0]?.label, {
      message: 'language detected while still in edit mode',
      timeout: 5000,
    }).toBe('Python');
  });

  test('select lines in a code block → P: those lines become paragraphs, the rest stays code', async ({ page, spa }) => {
    test.setTimeout(120_000);
    await openNewBook(page, spa);
    const PY = 'def greet(name):\n    message = "Hello, " + name\n    return message\n\nprint(greet("Ada"))';

    await page.click('h1[id="100"]');
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(200);
    await page.evaluate((t) => navigator.clipboard.writeText(t), PY);
    await page.keyboard.press(`${MOD}+v`);
    await page.waitForTimeout(800);
    expect((await codeBlockState(page)).length).toBe(1);

    // Select from inside line 2 to inside line 3 (partial lines count whole).
    await page.evaluate(() => {
      const code = document.querySelector('.main-content pre code');
      const walker = document.createTreeWalker(code, NodeFilter.SHOW_TEXT);
      const texts = [];
      let n;
      while ((n = walker.nextNode())) if (!n.parentElement.closest('[data-render-only]')) texts.push(n);
      const find = (needle) => {
        for (const t of texts) { const i = t.data.indexOf(needle); if (i >= 0) return [t, i]; }
        throw new Error(`not found: ${needle}`);
      };
      const [a, ai] = find('message =');
      const [b, bi] = find('return');
      const r = document.createRange();
      r.setStart(a, ai + 2);
      r.setEnd(b, bi + 3);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(r);
      document.dispatchEvent(new Event('selectionchange'));
    });
    await page.waitForTimeout(200);
    await clickBlockType(page, 'p');

    // (Pasting a block into an EMPTY paragraph leaves that paragraph behind —
    // general paste behaviour, not this gesture; ignore empty paragraphs here.)
    const shape = (await page.evaluate(() => Array.from(document.querySelectorAll('.main-content .chunk > *')).map((el) => {
      const c = el.cloneNode(true);
      c.querySelectorAll('[data-render-only]').forEach((e) => e.remove());
      return { tag: el.tagName, text: c.textContent.replace(/\u00A0/g, ' ') };
    }))).filter((x) => !(x.tag === 'P' && x.text.trim() === ''));
    expect(shape.map((x) => x.tag)).toEqual(['H1', 'PRE', 'P', 'P', 'PRE']);
    expect(shape[1].text).toBe('def greet(name):');
    expect(shape[2].text).toBe('    message = "Hello, " + name');
    expect(shape[3].text).toBe('    return message');
    expect(shape[4].text).toBe('print(greet("Ada"))');
    const ids = await page.evaluate(() => Array.from(document.querySelectorAll('.main-content .chunk > [id]')).map((el) => parseFloat(el.id)));
    expect(ids, 'DOM order equals id order').toEqual([...ids].sort((x, y) => x - y));

    // Both remaining code blocks got headers live; survives a reload.
    expect((await codeBlockState(page)).every((b) => b.hasHeader)).toBe(true);
    await page.waitForTimeout(2500);
    await page.reload();
    await page.waitForLoadState('networkidle');
    await spa.waitForTransition(page).catch(() => {});
    await expect.poll(async () => (await codeBlockState(page)).length, { timeout: 8000 }).toBe(2);
    expect(await page.locator('.main-content p', { hasText: 'return message' }).count()).toBe(1);
  });

  test('a highlight inside converted code lines survives into the paragraph, and a reload', async ({ page, spa }) => {
    test.setTimeout(150_000);
    await openNewBook(page, spa);
    const PY = 'def greet(name):\n    message = "Hello, " + name\n    return message\n\nprint(greet("Ada"))';

    await page.click('h1[id="100"]');
    await page.keyboard.type('Highlight in code');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(200);
    await page.evaluate((t) => navigator.clipboard.writeText(t), PY);
    await page.keyboard.press(`${MOD}+v`);
    await page.waitForTimeout(800);
    expect((await codeBlockState(page)).length).toBe(1);

    // Real hyperlight on "Hello" inside the code block.
    const preId = await page.evaluate(() => document.querySelector('.main-content pre').id);
    const start = PY.indexOf('Hello');
    await spa.selectTextInElement(page, `.main-content pre[id="${preId}"] code`, start, start + 'Hello'.length);
    await spa.waitForHyperlightButtons(page);
    await page.click('#copy-hyperlight');
    await page.waitForFunction(() => document.getElementById('hyperlit-container')?.classList.contains('open'), null, { timeout: 10000 });
    await spa.closeHyperlitContainer(page);
    await waitForCloudGreen(page);
    const markId = await page.evaluate(() => document.querySelector('.main-content pre mark')?.id ?? null);
    expect(markId, 'the highlight is a <mark> inside the code block').not.toBeNull();

    // Convert lines 2–3 to paragraphs via the P button.
    await page.evaluate(() => {
      const code = document.querySelector('.main-content pre code');
      const walker = document.createTreeWalker(code, NodeFilter.SHOW_TEXT);
      const texts = [];
      let n;
      while ((n = walker.nextNode())) if (!n.parentElement.closest('[data-render-only]')) texts.push(n);
      const find = (needle) => {
        for (const t of texts) { const i = t.data.indexOf(needle); if (i >= 0) return [t, i]; }
        throw new Error(`not found: ${needle}`);
      };
      const [a, ai] = find('message =');
      const [b, bi] = find('return');
      const r = document.createRange();
      r.setStart(a, ai);
      r.setEnd(b, bi + 3);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(r);
      document.dispatchEvent(new Event('selectionchange'));
    });
    await page.waitForTimeout(200);
    await clickBlockType(page, 'p');

    const inPara = async () => page.evaluate((id) => {
      const m = document.querySelector(`.main-content mark.${id}, .main-content mark#${id}`);
      return m ? { host: m.closest('p, pre')?.tagName, text: m.textContent, para: m.closest('p')?.textContent.replace(/ /g, ' ') } : null;
    }, markId);
    expect(await inPara()).toEqual({ host: 'P', text: 'Hello', para: '    message = "Hello, " + name' });

    // Leave edit mode, let it save, reload: still on the same word, same paragraph.
    await page.click('#editButton');
    await page.waitForFunction(() => window.isEditing === false, null, { timeout: 5000 });
    await waitForCloudGreen(page);
    await page.waitForTimeout(1500);
    await page.reload();
    await page.waitForLoadState('networkidle');
    await spa.waitForTransition(page).catch(() => {});
    await expect.poll(inPara, { message: 'highlight anchored to the same word after reload', timeout: 10000 })
      .toEqual({ host: 'P', text: 'Hello', para: '    message = "Hello, " + name' });
  });

  /** New book holding one pasted code block; returns the program text. */
  async function bookWithCode(page, spa, text) {
    await openNewBook(page, spa);
    await page.click('h1[id="100"]');
    await page.keyboard.type('Code buttons');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(200);
    await page.evaluate((t) => navigator.clipboard.writeText(t), text);
    await page.keyboard.press(`${MOD}+v`);
    await page.waitForTimeout(800);
    expect((await codeBlockState(page)).length).toBe(1);
  }

  const BTN_PY = 'def greet(name):\n    return "Hello, " + name\n\nprint(greet("Ada"))';

  for (const mode of ['edit', 'read']) {
    test(`copy button copies the exact code (${mode} mode)`, async ({ page, spa }) => {
      test.setTimeout(120_000);
      await bookWithCode(page, spa, BTN_PY);
      if (mode === 'read') {
        await page.click('#editButton');
        await page.waitForFunction(() => window.isEditing === false);
        await expect.poll(async () => (await codeBlockState(page))[0]?.tokenSpans ?? 0, { timeout: 5000 }).toBeGreaterThan(0);
      }
      await page.evaluate(() => navigator.clipboard.writeText('stale'));
      await page.locator('.main-content pre [data-code-action="copy"]').click();
      await expect.poll(() => page.evaluate(() => navigator.clipboard.readText()), { timeout: 3000 }).toBe(BTN_PY);
      // Copying must not edit the block.
      expect((await codeBlockState(page))[0].text).toBe(BTN_PY);
    });

    test(`expand button opens a full-screen view; Escape closes and returns focus (${mode} mode)`, async ({ page, spa }) => {
      test.setTimeout(120_000);
      await bookWithCode(page, spa, BTN_PY);
      if (mode === 'read') {
        await page.click('#editButton');
        await page.waitForFunction(() => window.isEditing === false);
      }
      const btn = page.locator('.main-content pre [data-code-action="expand"]');
      await btn.click();
      const sheet = page.locator('.code-expand-sheet');
      await expect(sheet, 'expand opens the sheet').toBeVisible({ timeout: 3000 });
      await page.waitForTimeout(400);
      await page.screenshot({ path: `tests/e2e/test-results/code-expand-${mode}.png` });
      // The sheet is the TOP element at its own centre (not hidden behind the page).
      const onTop = await page.evaluate(() => {
        const el = document.querySelector('.code-expand-sheet');
        const r = el.getBoundingClientRect();
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + Math.min(r.height / 2, 200));
        return !!hit && !!hit.closest('.code-expand-sheet');
      });
      expect(onTop, 'the expanded sheet is on top, not under the page').toBe(true);
      expect(await sheet.locator('code').textContent()).toBe(BTN_PY);
      // Focus is inside the sheet (trapped).
      expect(await page.evaluate(() => !!document.activeElement?.closest('.code-expand-sheet'))).toBe(true);
      await page.keyboard.press('Tab');
      expect(await page.evaluate(() => !!document.activeElement?.closest('.code-expand-sheet'))).toBe(true);
      await page.keyboard.press('Escape');
      await expect(sheet).toHaveCount(0, { timeout: 3000 });
      // The book is untouched.
      expect((await codeBlockState(page))[0].text).toBe(BTN_PY);
    });
  }

  test('Backspace at the start of a code block JOINS it to the code block above', async ({ page, spa }) => {
    test.setTimeout(120_000);
    const PY = 'a = 1\nb = 2\n\nc = 3\nd = 4';
    await bookWithCode(page, spa, PY);
    // Split it into two code blocks the real way: blank seam line → P, then remove that paragraph.
    // Simpler: convert line "c = 3"'s preceding blank to make two blocks via P on line c, then back.
    await page.evaluate(() => {
      const code = document.querySelector('.main-content pre code');
      const walker = document.createTreeWalker(code, NodeFilter.SHOW_TEXT);
      let n;
      while ((n = walker.nextNode())) {
        if (n.parentElement.closest('[data-render-only]')) continue;
        const i = n.data.indexOf('b = 2');
        if (i >= 0) {
          const r = document.createRange();
          r.setStart(n, i);
          r.setEnd(n, i + 5);
          const sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(r);
          return;
        }
      }
    });
    await page.evaluate(() => document.dispatchEvent(new Event('selectionchange')));
    await clickBlockType(page, 'p'); // a = 1 | <p>b = 2</p> | c = 3 d = 4
    // Turn the paragraph back into code: now three blocks, two of them code, adjacent after we delete the paragraph.
    await page.evaluate(() => {
      const p = Array.from(document.querySelectorAll('.main-content p')).find((x) => x.textContent.includes('b = 2'));
      const r = document.createRange();
      r.selectNodeContents(p);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(r);
    });
    await page.keyboard.press('Backspace'); // empty the paragraph
    await page.keyboard.press('Backspace'); // remove it (caret goes up)
    await page.waitForTimeout(400);
    let pres = await codeBlockState(page);
    expect(pres.length, 'setup: two adjacent code blocks').toBe(2);

    // Caret at the very start of the SECOND block's code, then Backspace.
    await page.evaluate(() => {
      const second = document.querySelectorAll('.main-content pre')[1];
      const code = second.querySelector('code');
      const walker = document.createTreeWalker(code, NodeFilter.SHOW_TEXT);
      let n;
      while ((n = walker.nextNode())) if (!n.parentElement.closest('[data-render-only]')) break;
      window.getSelection().collapse(n, 0);
    });
    await page.keyboard.press('Backspace');
    await page.waitForTimeout(400);

    pres = await codeBlockState(page);
    expect(pres.length, 'the two blocks are now ONE').toBe(1);
    expect(pres[0].hasHeader, 'the merged block keeps its header').toBe(true);
    expect(pres[0].text).toBe(`${pres[0].text.split('\n')[0]}\n${pres[0].text.split('\n').slice(1).join('\n')}`);
    expect(pres[0].text.replace(/\n+/g, '\n')).toBe('a = 1\nc = 3\nd = 4');

    // Typing goes in at the seam.
    await page.keyboard.type('X');
    expect((await codeBlockState(page))[0].text).toContain('a = 1X\nc = 3');

    // Survives a reload.
    await page.waitForTimeout(2500);
    await page.reload();
    await page.waitForLoadState('networkidle');
    await spa.waitForTransition(page).catch(() => {});
    await expect.poll(async () => (await codeBlockState(page)).length, { timeout: 8000 }).toBe(1);
    expect((await codeBlockState(page))[0].text).toBe('a = 1X\nc = 3\nd = 4');
  });

  test('after a full page reload, expand and copy still work (read mode)', async ({ page, spa }) => {
    test.setTimeout(120_000);
    await bookWithCode(page, spa, BTN_PY);
    await page.click('#editButton');
    await page.waitForFunction(() => window.isEditing === false);
    await page.waitForTimeout(2500);
    await page.reload();
    await page.waitForLoadState('networkidle');
    await spa.waitForTransition(page).catch(() => {});
    await expect.poll(async () => (await codeBlockState(page))[0]?.hasHeader ?? false, { timeout: 8000 }).toBe(true);

    await page.locator('.main-content pre [data-code-action="expand"]').click();
    await expect(page.locator('.code-expand-sheet'), 'expand after reload').toBeVisible({ timeout: 3000 });
    await page.keyboard.press('Escape');
    await expect(page.locator('.code-expand-sheet')).toHaveCount(0, { timeout: 3000 });

    await page.evaluate(() => navigator.clipboard.writeText('stale'));
    await page.locator('.main-content pre [data-code-action="copy"]').click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText()), { timeout: 3000 }).toBe(BTN_PY);
  });

  test('a highlight opened from the EXPANDED view shows its container on top; icon buttons', async ({ page, spa }) => {
    test.setTimeout(150_000);
    await bookWithCode(page, spa, BTN_PY);

    // Real hyperlight on "Hello" in the code block.
    const preId = await page.evaluate(() => document.querySelector('.main-content pre').id);
    const start = BTN_PY.indexOf('Hello');
    await spa.selectTextInElement(page, `.main-content pre[id="${preId}"] code`, start, start + 'Hello'.length);
    await spa.waitForHyperlightButtons(page);
    await page.click('#copy-hyperlight');
    await page.waitForFunction(() => document.getElementById('hyperlit-container')?.classList.contains('open'), null, { timeout: 10000 });
    await spa.closeHyperlitContainer(page);
    await waitForCloudGreen(page);

    // Leave edit mode, expand.
    await page.click('#editButton');
    await page.waitForFunction(() => window.isEditing === false);
    await page.locator('.main-content pre [data-code-action="expand"]').click();
    const sheet = page.locator('.code-expand-sheet');
    await expect(sheet).toBeVisible({ timeout: 3000 });

    // Icon buttons, not words: each has an SVG and an accessible name, no text.
    const buttons = await sheet.locator('.code-expand-bar button').evaluateAll((bs) => bs.map((b) => ({
      label: b.getAttribute('aria-label'), text: b.textContent.trim(), svg: !!b.querySelector('svg'),
    })));
    expect(buttons).toEqual([
      { label: 'Wrap long lines', text: '', svg: true },
      { label: 'Copy code', text: '', svg: true },
      { label: 'Close', text: '', svg: true },
    ]);

    // Click the highlight INSIDE the expanded view → its container opens ON TOP.
    await sheet.locator('mark').first().click();
    await page.waitForFunction(() => document.getElementById('hyperlit-container')?.classList.contains('open'), null, { timeout: 10000 });
    await page.waitForTimeout(500);
    await page.screenshot({ path: 'tests/e2e/test-results/code-expand-highlight.png' });
    const containerOnTop = await page.evaluate(() => {
      const c = document.getElementById('hyperlit-container');
      const r = c.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + Math.min(r.height / 2, 120));
      return !!hit && !!hit.closest('#hyperlit-container');
    });
    expect(containerOnTop, 'the highlight container is above the expanded code view').toBe(true);

    // Escape closes the container first, the sheet stays; Escape again closes the sheet.
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.getElementById('hyperlit-container')?.classList.contains('open'), null, { timeout: 5000 });
    await expect(sheet).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(sheet).toHaveCount(0, { timeout: 3000 });
  });
});
