/**
 * Translate button — the selection → POST /api/translate → card flow.
 *
 * Locks: the reader's browser translates when it can (nothing sent to the
 * server) and the server is the fallback; direction is guessed from the
 * script (Chinese → English, else Chinese) unless the reader picked a language
 * before; the server gets HTML (so it can strip footnote markers) with the
 * MAIN book id, the browser gets the same text with the furniture already
 * stripped; model output is rendered as text, never HTML; the picker offers
 * the main languages and re-translates; right-to-left results are tagged;
 * failures say what to do; the card closes on Escape and on a click outside.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../../resources/js/utilities/auth/csrf', () => ({
  ensureCsrfToken: vi.fn(async () => 'xsrf'),
}));

const promptLogin = vi.fn(async () => {});
const promptRegister = vi.fn(async () => {});
vi.mock('../../../resources/js/utilities/auth/promptLogin', () => ({
  promptLogin: (...args) => promptLogin(...args),
  promptRegister: (...args) => promptRegister(...args),
}));

import {
  translateSelection,
  closeTranslation,
  looksChinese,
  defaultTarget,
  readableText,
  formatCost,
  LANGUAGES,
} from '../../../resources/js/hyperlights/translateSelection';

function select(el) {
  const range = document.createRange();
  range.selectNodeContents(el);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
}

function reply(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function translated(text, extra = {}) {
  return reply(200, { success: true, translation: { text }, unverified: true, wrong_script: false, ...extra });
}

const card = () => document.getElementById('translation-popover');
const sentBody = (call = 0) => JSON.parse(fetchMock.mock.calls[call][1].body);

let fetchMock;

beforeEach(() => {
  document.head.innerHTML = '<meta name="csrf-token" content="tok">';
  document.body.innerHTML = `
    <main class="main-content" id="book_1">
      <p id="zh">资本积累<sup fn-count-id="1">1</sup>不均衡。</p>
      <div data-book-id="book_1/Fn1"><p id="en">Wages stagnated.</p></div>
    </main>`;
  localStorage.clear();
  promptLogin.mockClear();
  promptRegister.mockClear();
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  closeTranslation();
  vi.unstubAllGlobals();
});

describe('direction', () => {
  it('sends Chinese to English and everything else to Chinese', () => {
    expect(looksChinese('资本积累不均衡 (Marx 1867)')).toBe(true);
    expect(looksChinese('Capital accumulates unevenly')).toBe(false);
    expect(defaultTarget('资本积累')).toBe('en');
    expect(defaultTarget('Capital')).toBe('zh-Hans');

    // A remembered pick wins, unless the passage is already in that language.
    localStorage.setItem('hyperlit.translate.target', 'es');
    expect(defaultTarget('Capital')).toBe('es');
    expect(defaultTarget('资本积累')).toBe('es');
    localStorage.setItem('hyperlit.translate.target', 'zh-Hant');
    expect(defaultTarget('Capital')).toBe('zh-Hant');
    expect(defaultTarget('资本积累')).toBe('en');
    localStorage.setItem('hyperlit.translate.target', 'en');
    expect(defaultTarget('Capital')).toBe('zh-Hans');
  });

  it('offers the main languages, in their own scripts', () => {
    const codes = LANGUAGES.map((l) => l.code);
    expect(codes).toEqual(expect.arrayContaining(['en', 'zh-Hans', 'zh-Hant', 'es', 'fr', 'de', 'ru', 'ar', 'hi', 'ja', 'ko', 'pt']));
    expect(LANGUAGES.find((l) => l.code === 'ar')).toMatchObject({ label: 'العربية', dir: 'rtl' });
  });

  it('reads a selection as prose, without footnote markers or hypercite arrows', () => {
    const p = document.getElementById('zh');
    const range = document.createRange();
    range.selectNodeContents(p);
    expect(readableText(range.cloneContents())).toBe('资本积累不均衡。');
  });
});

describe('translateSelection', () => {
  it('sends the selection as HTML with the main book, and shows the translation', async () => {
    fetchMock.mockResolvedValue(translated('Capital accumulation is uneven.'));
    select(document.getElementById('zh'));

    await translateSelection();

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/translate');
    // The cookie token (fresh after a login), not the page's <meta> one.
    expect(init.headers['X-XSRF-TOKEN']).toBe('xsrf');
    expect(sentBody()).toMatchObject({ target_lang: 'en', book: 'book_1' });
    // HTML, so the server can drop the footnote marker before the model sees it.
    expect(sentBody().text).toContain('<sup fn-count-id="1">1</sup>');

    expect(card().querySelector('.tp-body').textContent).toBe('Capital accumulation is uneven.');
    expect(card().querySelector('.tp-target').value).toBe('en');
    expect(card().querySelector('.tp-note').textContent).toBe('Machine translation — not reviewed.');
  });

  it('sends the main book, not the footnote sub-book the selection is in', async () => {
    fetchMock.mockResolvedValue(translated('工资停滞了。'));
    select(document.getElementById('en'));

    await translateSelection();

    expect(sentBody()).toMatchObject({ target_lang: 'zh-Hans', book: 'book_1' });
  });

  it('says what a server translation cost, and where it would have been free', async () => {
    fetchMock.mockResolvedValue(translated('工资停滞了。', { cost: 0.00041 }));
    select(document.getElementById('en'));

    await translateSelection();

    expect(card().querySelector('.tp-note').textContent)
      .toBe('Paid from your credit (under 1¢). Free in desktop Chrome and Edge, which translate on your device.');
    expect(formatCost(0.004)).toBe('under 1¢');
    expect(formatCost(0.0234)).toBe('$0.02');
  });

  it('renders model output as text, never as HTML', async () => {
    fetchMock.mockResolvedValue(translated('<img src=x onerror="alert(1)">'));
    select(document.getElementById('en'));

    await translateSelection();

    const body = card().querySelector('.tp-body');
    expect(body.querySelector('img')).toBeNull();
    expect(body.textContent).toBe('<img src=x onerror="alert(1)">');
  });

  it('re-translates when another language is picked, and remembers it', async () => {
    fetchMock
      .mockResolvedValueOnce(translated('工资停滞了。'))
      .mockResolvedValueOnce(translated('工資停滯了。'));
    select(document.getElementById('en'));
    await translateSelection();

    const picker = card().querySelector('.tp-target');
    picker.value = 'zh-Hant';
    picker.dispatchEvent(new Event('change'));

    await vi.waitFor(() => expect(card().querySelector('.tp-body').textContent).toBe('工資停滯了。'));
    expect(sentBody(1).target_lang).toBe('zh-Hant');
    expect(localStorage.getItem('hyperlit.translate.target')).toBe('zh-Hant');
  });

  it('warns when the answer is in the wrong writing system', async () => {
    fetchMock.mockResolvedValue(translated('Wages stagnated.', { wrong_script: true }));
    select(document.getElementById('en'));

    await translateSelection();

    const note = card().querySelector('.tp-note');
    expect(note.textContent).toContain('wrong writing system');
    expect(note.classList.contains('tp-warning')).toBe(true);
  });

  it.each([
    [419, {}, 'Your session expired — reload the page and try again.'],
    [402, { success: false, message: 'Insufficient balance' }, 'Not enough credit. Translating in this browser costs a fraction of a cent a passage — it’s free in desktop Chrome and Edge.'],
    [403, { success: false, message: 'Encrypted books cannot use server-side translation' }, 'Encrypted books cannot use server-side translation'],
    [429, { success: false, message: "You've used today's 200 free translations. More become available within a day." }, "You've used today's 200 free translations. More become available within a day."],
  ])('explains a %i', async (status, body, message) => {
    fetchMock.mockResolvedValue(reply(status, body));
    select(document.getElementById('en'));

    await translateSelection();

    expect(card().querySelector('.tp-body').textContent).toBe(message);
    expect(card().querySelector('.tp-body').dataset.state).toBe('error');
  });

  it('offers a guest real log-in and register links, like the rest of the site', async () => {
    fetchMock.mockResolvedValue(reply(401, {}));
    select(document.getElementById('en'));

    await translateSelection();

    const body = card().querySelector('.tp-body');
    expect(body.dataset.state).toBe('error');
    expect(body.textContent).toBe(
      'You need to log in or register to translate in this browser — it uses a little credit.'
      + ' It’s free in desktop Chrome and Edge, which translate on your device.',
    );

    const [login, register] = body.querySelectorAll('.tp-auth-link');
    expect([login.textContent, register.textContent]).toEqual(['log in', 'register']);

    // The card gets out of the way — the user panel takes the screen.
    register.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(card()).toBeNull();
    expect(promptRegister).toHaveBeenCalled();
    expect(promptLogin).not.toHaveBeenCalled();

    await translateSelection();
    card().querySelector('.tp-auth-link').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(promptLogin).toHaveBeenCalled();
  });

  it('closes on Escape and on a click outside the card', async () => {
    fetchMock.mockResolvedValue(translated('工资停滞了。'));
    select(document.getElementById('en'));

    await translateSelection();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(card()).toBeNull();

    await translateSelection();
    card().dispatchEvent(new Event('pointerdown', { bubbles: true })); // inside: stays
    expect(card()).not.toBeNull();
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(card()).toBeNull();
  });

  it('does nothing without a selection', async () => {
    window.getSelection().removeAllRanges();

    await translateSelection();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(card()).toBeNull();
  });
  it('tags a right-to-left result so it reads right to left', async () => {
    fetchMock.mockResolvedValue(translated('توقفت الأجور.'));
    localStorage.setItem('hyperlit.translate.target', 'ar');
    select(document.getElementById('en'));

    await translateSelection();

    const body = card().querySelector('.tp-body');
    expect(sentBody().target_lang).toBe('ar');
    expect(body.getAttribute('dir')).toBe('rtl');
    expect(body.getAttribute('lang')).toBe('ar');
  });
});

describe('in the browser', () => {
  let created;

  function stubBrowserTranslator({ detected = 'zh', confidence = 0.95, availability = 'available', fail = false } = {}) {
    created = [];
    vi.stubGlobal('LanguageDetector', {
      create: async () => ({ detect: async () => [{ detectedLanguage: detected, confidence }], destroy() {} }),
    });
    vi.stubGlobal('Translator', {
      availability: async () => availability,
      create: async (options) => {
        if (fail) throw new DOMException('Requires a user gesture', 'NotAllowedError');
        options.monitor?.(new EventTarget());
        created.push(options);
        return { translate: async (text) => `[${options.targetLanguage}] ${text}`, destroy() {} };
      },
    });
  }

  it('translates on the device and sends nothing to the server', async () => {
    stubBrowserTranslator();
    select(document.getElementById('zh'));

    await translateSelection();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(created[0]).toMatchObject({ sourceLanguage: 'zh', targetLanguage: 'en' });
    // Prose only: the footnote marker never reaches the translator.
    expect(card().querySelector('.tp-body').textContent).toBe('[en] 资本积累不均衡。');
    expect(card().querySelector('.tp-note').textContent).toBe('Translated by your browser — nothing left your device.');
  });

  it('maps Simplified Chinese to the code the browser uses', async () => {
    stubBrowserTranslator({ detected: 'en' });
    select(document.getElementById('en'));

    await translateSelection();

    expect(created[0]).toMatchObject({ sourceLanguage: 'en', targetLanguage: 'zh' });
  });

  it.each([
    ['the browser cannot do the pair', { detected: 'en', availability: 'unavailable' }],
    ['the model download is refused', { detected: 'en', fail: true }],
    ['the language detector is unsure', { detected: 'en', confidence: 0.2 }],
  ])('falls back to the server when %s', async (_why, options) => {
    stubBrowserTranslator(options);
    fetchMock.mockResolvedValue(translated('工资停滞了。'));
    select(document.getElementById('en'));

    await translateSelection();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(card().querySelector('.tp-body').textContent).toBe('工资停滞了。');
  });

  it('says so when the passage is already in the chosen language', async () => {
    stubBrowserTranslator({ detected: 'en' });
    localStorage.setItem('hyperlit.translate.target', 'es');
    select(document.getElementById('en'));
    await translateSelection();

    const picker = card().querySelector('.tp-target');
    picker.value = 'en';
    picker.dispatchEvent(new Event('change'));

    await vi.waitFor(() => expect(card().querySelector('.tp-note').textContent).toBe('This passage already appears to be in English.'));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
