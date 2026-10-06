import { ensureCsrfToken } from '../utilities/auth/csrf';

/**
 * Translate button — translates the current selection into a small card
 * under it:
 *
 *   1. FREE — the reader's own browser, when it has the built-in Translator
 *      API (desktop Chrome 138+, Edge 148+): on-device, instant, and the text
 *      never leaves their machine. Safari and Firefox translate pages for
 *      their users but expose nothing to websites, so they can't be used here.
 *   2. PAID — otherwise POST /api/translate (Safari, Firefox, phones, or a
 *      pair the browser can't do): a fraction of a cent from the reader's
 *      credit, and the card says it's free in Chrome/Edge. (Unless
 *      services.translation.passages_free makes the server route free too.)
 *
 * Direction defaults to Chinese → English and anything else → Chinese, unless
 * the reader has picked a language before (remembered per browser). The card's
 * picker offers the main languages.
 *
 * The SERVER is sent the selection's HTML, not toString(): it strips footnote
 * markers, hypercite arrows and other furniture (TranslatableText), which
 * toString() would hand to the model as stray digits and ↗ glyphs. The
 * browser translator takes plain text, so readableText() applies the same
 * rules here.
 *
 * Wired by selectionToolbar.ts (button) and closed by its cleanup on SPA
 * navigation.
 */

interface Language {
  /** LanguageRegistry's canonical code — what the server is asked for. */
  code: string;
  /** Endonym, so a reader finds their own language. */
  label: string;
  dir?: 'rtl';
  /** The browser Translator's BCP 47 code, when it differs from `code`. */
  browser?: string;
}

export const LANGUAGES: Language[] = [
  { code: 'en', label: 'English' },
  { code: 'zh-Hans', label: '简体中文', browser: 'zh' },
  { code: 'zh-Hant', label: '繁體中文' },
  { code: 'es', label: 'Español' },
  { code: 'fr', label: 'Français' },
  { code: 'de', label: 'Deutsch' },
  { code: 'it', label: 'Italiano' },
  { code: 'pt', label: 'Português' },
  { code: 'nl', label: 'Nederlands' },
  { code: 'pl', label: 'Polski' },
  { code: 'sv', label: 'Svenska' },
  { code: 'el', label: 'Ελληνικά' },
  { code: 'ru', label: 'Русский' },
  { code: 'uk', label: 'Українська' },
  { code: 'tr', label: 'Türkçe' },
  { code: 'ar', label: 'العربية', dir: 'rtl' },
  { code: 'fa', label: 'فارسی', dir: 'rtl' },
  { code: 'he', label: 'עברית', dir: 'rtl' },
  { code: 'ur', label: 'اردو', dir: 'rtl' },
  { code: 'hi', label: 'हिन्दी' },
  { code: 'bn', label: 'বাংলা' },
  { code: 'ja', label: '日本語' },
  { code: 'ko', label: '한국어' },
  { code: 'vi', label: 'Tiếng Việt' },
  { code: 'th', label: 'ไทย' },
  { code: 'id', label: 'Bahasa Indonesia' },
  { code: 'ms', label: 'Bahasa Melayu' },
  { code: 'fil', label: 'Filipino' },
];

/** Where translating is free — named to readers whenever they pay instead. */
const FREE_BROWSERS = 'desktop Chrome and Edge';

/** TranslationController::MAX_INPUT_CHARS — the server refuses anything longer. */
const MAX_CHARS = 20000;

const TARGET_PREF_KEY = 'hyperlit.translate.target';

let card: HTMLElement | null = null;
let inFlight: AbortController | null = null;
let source: { html: string; plain: string; bookId: string | null } | null = null;

const language = (code: string): Language | undefined => LANGUAGES.find((l) => l.code === code);

/** Han characters at least as common as Latin letters. */
export function looksChinese(text: string): boolean {
  const han = (text.match(/\p{Script=Han}/gu) || []).length;
  const latin = (text.match(/\p{Script=Latin}/gu) || []).length;
  return han > 0 && han >= latin;
}

/**
 * The reader's last pick, unless it's the language the passage already
 * looks to be in — then the EN↔ZH default.
 */
export function defaultTarget(text: string): string {
  const preferred = savedTarget();
  if (looksChinese(text)) {
    return preferred && !preferred.startsWith('zh') ? preferred : 'en';
  }
  return preferred && preferred !== 'en' ? preferred : 'zh-Hans';
}

function savedTarget(): string | null {
  try {
    const saved = localStorage.getItem(TARGET_PREF_KEY);
    return saved && language(saved) ? saved : null;
  } catch {
    return null; // storage blocked (private mode, sandbox)
  }
}

function rememberTarget(code: string): void {
  try {
    localStorage.setItem(TARGET_PREF_KEY, code);
  } catch {
    // Not remembering is fine.
  }
}

/**
 * The selection as plain prose, by the server's TranslatableText rules:
 * footnote markers, hypercite arrows, page numbers, maths and images dropped;
 * block boundaries become paragraph breaks.
 */
export function readableText(fragment: DocumentFragment): string {
  const holder = document.createElement('div');
  holder.appendChild(fragment.cloneNode(true));
  holder.querySelectorAll('sup[fn-count-id], .footnote-ref, .open-icon, .pageNumber, latex, latex-block, img, script, style')
    .forEach((el) => el.remove());
  holder.querySelectorAll('br').forEach((br) => br.replaceWith('\n'));
  holder.querySelectorAll('p, li, h1, h2, h3, h4, h5, h6, blockquote, div, tr, dt, dd')
    .forEach((el) => el.append('\n\n'));

  return (holder.textContent || '')
    .replace(/[⁠​‌‍­﻿↗]/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Translate the live selection and show the result in a card under it. */
export async function translateSelection(): Promise<void> {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return;

  const range = selection.getRangeAt(0).cloneRange();
  const plain = selection.toString().trim();
  if (!plain) return;

  const fragment = range.cloneContents();
  const holder = document.createElement('div');
  holder.appendChild(fragment.cloneNode(true));
  const readable = readableText(fragment);
  // HTML when it fits the server's cap (furniture gets stripped there); plain
  // text when markup alone would push a long selection over it.
  const html = holder.innerHTML.length <= MAX_CHARS ? holder.innerHTML : readable;

  // The MAIN book, never a footnote sub-book id: the server only uses it to
  // refuse encrypted books (it resolves sub-books to their root itself) and
  // to check visibility, and sub-books aren't library rows.
  const bookId = document.querySelector('.main-content')?.id || null;

  // After openCard: it closes any previous card, which clears `source`.
  openCard(range.getBoundingClientRect());
  source = { html, plain: readable || plain, bookId };

  if (source.plain.length > MAX_CHARS) {
    setBody(`That selection is too long to translate at once (over ${MAX_CHARS.toLocaleString()} characters).`, 'error');
    return;
  }

  await request(defaultTarget(plain));
}

/** Close the card and cancel anything in flight. Safe to call when closed. */
export function closeTranslation(): void {
  inFlight?.abort();
  inFlight = null;
  source = null;
  card?.remove();
  card = null;
  document.removeEventListener('keydown', onKeydown);
  document.removeEventListener('pointerdown', onPointerDownOutside, true);
}

async function request(target: string): Promise<void> {
  if (!card || !source) return;

  inFlight?.abort();
  const controller = new AbortController();
  inFlight = controller;
  const current = source;

  const picker = card.querySelector<HTMLSelectElement>('.tp-target');
  if (picker) picker.value = target;
  setBody('Translating…', 'loading', target);
  setNote('', false);

  // 1. On the reader's own device, when the browser can.
  const local = await translateInBrowser(current.plain, target, (percent) => {
    if (controller === inFlight) {
      setBody(`Downloading ${language(target)?.label ?? target} for your browser… ${percent}%`, 'loading', target);
    }
  });
  if (controller !== inFlight) return; // superseded or closed meanwhile
  if (local !== null) {
    setBody(local.text, 'done', target);
    setNote(local.note, false);
    inFlight = null;
    return;
  }

  // 2. The server. The cookie token, not the page's <meta> one: that goes stale
  // when the reader logs in after the page loaded, and a 419 would follow.
  try {
    const csrf = await ensureCsrfToken();
    if (controller !== inFlight) return;
    const response = await fetch('/api/translate', {
      method: 'POST',
      credentials: 'include',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'X-XSRF-TOKEN': csrf ?? '',
      },
      body: JSON.stringify({
        text: current.html,
        target_lang: target,
        ...(current.bookId ? { book: current.bookId } : {}),
      }),
    });
    const data: any = await response.json().catch(() => ({}));
    if (controller !== inFlight) return;

    if (!response.ok || !data.success) {
      setBody(errorMessage(response.status, data), 'error', target);
      return;
    }

    setBody(data.translation?.text ?? '', 'done', target);
    if (data.wrong_script) {
      setNote('⚠ The model answered in the wrong writing system — treat this with caution.', true);
    } else if (typeof data.cost === 'number') {
      setNote(`Paid from your credit (${formatCost(data.cost)}). Free in ${FREE_BROWSERS}, which translate on your device.`, false);
    } else if (data.unverified) {
      setNote('Machine translation — not reviewed.', false);
    }
  } catch (error: any) {
    if (error?.name === 'AbortError') return;
    setBody('Translation failed — check your connection and try again.', 'error', target);
  } finally {
    if (inFlight === controller) inFlight = null;
  }
}

/**
 * The browser's built-in Translator, or null to fall through to the server:
 * no API, a pair it can't do, a language it couldn't identify, or any error
 * (a model download needs a user gesture, and quotas exist). Never throws.
 */
export async function translateInBrowser(
  text: string,
  target: string,
  onDownload: (percent: number) => void,
): Promise<{ text: string; note: string } | null> {
  const Translator = (globalThis as any).Translator;
  const lang = language(target);
  if (!Translator || !lang) return null;

  const targetCode = lang.browser ?? lang.code;
  const sourceCode = await detectLanguage(text);
  if (!sourceCode) return null;
  if (sourceCode === targetCode) {
    return { text, note: `This passage already appears to be in ${lang.label}.` };
  }

  try {
    const options = { sourceLanguage: sourceCode, targetLanguage: targetCode };
    if ((await Translator.availability(options)) === 'unavailable') return null;

    const translator = await Translator.create({
      ...options,
      monitor(m: EventTarget) {
        m.addEventListener('downloadprogress', (e: any) => onDownload(Math.round((e.loaded ?? 0) * 100)));
      },
    });
    // Paragraph by paragraph: keeps the breaks, and each call stays small.
    const out: string[] = [];
    for (const paragraph of text.split('\n\n')) {
      out.push(paragraph.trim() ? await translator.translate(paragraph) : paragraph);
    }
    translator.destroy?.();

    return { text: out.join('\n\n'), note: 'Translated by your browser — nothing left your device.' };
  } catch {
    return null;
  }
}

/** The passage's language as a Translator code, or null when unsure. */
async function detectLanguage(text: string): Promise<string | null> {
  const LanguageDetector = (globalThis as any).LanguageDetector;
  if (LanguageDetector) {
    try {
      const detector = await LanguageDetector.create();
      const [best] = await detector.detect(text);
      detector.destroy?.();
      if (best && best.detectedLanguage !== 'und' && (best.confidence ?? 0) >= 0.5) {
        // 'zh-Hant' is the one region/script subtag the Translator distinguishes.
        const detected = String(best.detectedLanguage);
        return detected === 'zh-Hant' ? detected : (detected.split('-')[0] ?? detected);
      }
    } catch {
      // fall through to the script guess
    }
  }
  return looksChinese(text) ? 'zh' : null;
}

/** "under 1¢", or dollars and cents — a passage almost never costs a cent. */
export function formatCost(cost: number): string {
  return cost < 0.01 ? 'under 1¢' : `$${cost.toFixed(2)}`;
}

function errorMessage(status: number, data: any): string {
  // Only the server fallback needs an account and credit; a browser that
  // translates on-device never gets here.
  if (status === 401) return `Log in to translate in this browser — it uses a little credit. It’s free in ${FREE_BROWSERS}, which translate on your device.`;
  if (status === 419) return 'Your session expired — reload the page and try again.';
  if (status === 402) return `Not enough credit. Translating in this browser costs a fraction of a cent a passage — it’s free in ${FREE_BROWSERS}.`;
  return data?.message || `Translation failed (${status}).`;
}

function openCard(rect: DOMRect): void {
  closeTranslation();

  const el = document.createElement('div');
  el.id = 'translation-popover';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-label', 'Translation');
  el.innerHTML = `
    <div class="tp-header">
      <select class="tp-target" aria-label="Translate into">
        ${LANGUAGES.map((l) => `<option value="${l.code}">${l.label}</option>`).join('')}
      </select>
      <button type="button" class="tp-close" aria-label="Close translation">×</button>
    </div>
    <div class="tp-body" aria-live="polite"></div>
    <div class="tp-note"></div>`;
  document.body.appendChild(el);
  card = el;

  // Below the selection toolbar, or above the selection when there's no room
  // — the same test handleSelection uses to place the toolbar itself.
  const below = rect.bottom + 100 <= window.innerHeight;
  el.classList.toggle('tp-above', !below);
  el.style.top = below
    ? `${rect.bottom + window.scrollY + 46}px`
    : `${rect.top + window.scrollY - 110}px`;
  const maxLeft = window.scrollX + window.innerWidth - el.offsetWidth - 8;
  el.style.left = `${Math.max(window.scrollX + 8, Math.min(rect.left + window.scrollX, maxLeft))}px`;

  el.querySelector('.tp-close')?.addEventListener('click', closeTranslation);
  el.querySelector<HTMLSelectElement>('.tp-target')?.addEventListener('change', (event) => {
    const code = (event.target as HTMLSelectElement).value;
    rememberTarget(code);
    void request(code);
  });
  document.addEventListener('keydown', onKeydown);
  document.addEventListener('pointerdown', onPointerDownOutside, true);
}

function setBody(text: string, state: 'loading' | 'done' | 'error', target?: string): void {
  const body = card?.querySelector<HTMLElement>('.tp-body');
  if (!body) return;
  body.textContent = text; // never innerHTML: this is model output
  body.dataset.state = state;
  // Right-to-left scripts and per-language fonts need the result tagged.
  const lang = target && state === 'done' ? language(target) : undefined;
  if (lang) {
    body.lang = lang.code;
    body.dir = lang.dir ?? 'ltr';
  } else {
    body.removeAttribute('lang');
    body.removeAttribute('dir');
  }
}

function setNote(text: string, warning: boolean): void {
  const note = card?.querySelector<HTMLElement>('.tp-note');
  if (!note) return;
  note.textContent = text;
  note.classList.toggle('tp-warning', warning);
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') closeTranslation();
}

function onPointerDownOutside(event: PointerEvent): void {
  if (card && !card.contains(event.target as Node)) closeTranslation();
}
