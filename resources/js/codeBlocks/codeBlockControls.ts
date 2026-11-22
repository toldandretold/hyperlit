/**
 * Code-block header controls — copy, expand, and (in edit mode) the language
 * picker. ONE document-delegated listener set, initialised through ButtonRegistry
 * (components/utilities/registerComponents.ts) so it survives SPA navigation.
 *
 * Two body-mounted surfaces, both focus-trapped (utilities/modalFocusTrap) and
 * registered in tests/javascript/architecture/overlaySurfacesInventory.json:
 *   - `.code-expand-sheet` — the block full-screen, no-wrap, larger type.
 *   - `.code-lang-menu`    — language picker (edit mode only).
 * Both scroll their own content, so both are listed in
 * scrolling/wheelScrollForwarder.ts SCROLLABLE_OVERLAY_SEL.
 */
import {
  codeTarget, codeText, colourCodeBlock, setCopyIcon, uncolourPreservingSelection, HEADER_ROLE,
  codeIcon, type CodeIconName,
} from './highlight';
import { CODE_LANGUAGES, declaredLanguage, displayNameFor, languageClassFor } from './language';
import { CODE_TOKEN_ATTR, RENDER_ONLY_ATTR } from './stripDecoration';
import { loadHighlighter } from './hljsLoader';
import { trapModalFocus } from '../utilities/modalFocusTrap';
import { log } from '../utilities/logger';

const FILE = '/codeBlocks/codeBlockControls.ts';

let clickHandler: ((e: MouseEvent) => void) | null = null;
let mousedownHandler: ((e: MouseEvent) => void) | null = null;
let beforeInputHandler: ((e: Event) => void) | null = null;
let closeOpenSurface: (() => void) | null = null;

function preFor(el: Element): HTMLElement | null {
  const header = el.closest(`[${RENDER_ONLY_ATTR}="${HEADER_ROLE}"]`);
  return (header?.parentElement?.tagName === 'PRE' ? header.parentElement : null) as HTMLElement | null;
}

// ---------------------------------------------------------------------------
// Copy
// ---------------------------------------------------------------------------

async function writeClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* fall through to the legacy path */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

/** Copies the code's TEXT only — never markup, never the header. */
async function copyCode(pre: Element, btn: HTMLElement): Promise<void> {
  const ok = await writeClipboard(codeText(pre));
  if (!ok) { log.warn('Code copy failed', FILE); return; }
  btn.classList.add('is-copied');
  setCopyIcon(btn, true);
  window.setTimeout(() => {
    btn.classList.remove('is-copied');
    setCopyIcon(btn, false);
  }, 1500);
}

// ---------------------------------------------------------------------------
// Expand sheet
// ---------------------------------------------------------------------------

/** An icon-only button: the SVG is the face, the label is aria-label + tooltip. */
function iconButton(icon: CodeIconName, label: string, cls: string): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = `${cls} code-expand-action--icon`;
  b.setAttribute('aria-label', label);
  b.title = label;
  b.appendChild(codeIcon(icon));
  return b;
}

function openExpandSheet(pre: HTMLElement): void {
  closeOpenSurface?.();
  const label = pre.getAttribute('data-code-label') || 'Code';

  const sheet = document.createElement('div');
  sheet.className = 'code-expand-sheet';
  sheet.setAttribute('role', 'dialog');
  sheet.setAttribute('aria-modal', 'true');
  sheet.setAttribute('aria-label', `${label} code`);

  const panel = document.createElement('div');
  panel.className = 'code-expand-panel';

  const bar = document.createElement('div');
  bar.className = 'code-expand-bar';
  const title = document.createElement('span');
  title.className = 'code-expand-title';
  title.textContent = label;
  const wrapBtn = iconButton('wrap', 'Wrap long lines', 'code-expand-action');
  wrapBtn.setAttribute('aria-pressed', 'false');
  const copyBtn = iconButton('copy', 'Copy code', 'code-expand-action');
  const closeBtn = iconButton('close', 'Close', 'code-expand-action code-expand-close');
  bar.append(title, wrapBtn, copyBtn, closeBtn);

  // A clone of the code element: tokens + hyperlight marks come along, ids and
  // any render-only furniture do not (the sheet is never content).
  const body = document.createElement('pre');
  body.className = 'code-expand-pre';
  const source = codeTarget(pre);
  const clone = (source === pre ? document.createElement('code') : source.cloneNode(true)) as HTMLElement;
  if (source === pre) {
    pre.childNodes.forEach((n) => {
      if (n instanceof Element && n.hasAttribute(RENDER_ONLY_ATTR)) return;
      clone.appendChild(n.cloneNode(true));
    });
  }
  clone.querySelectorAll('[id]').forEach((el) => el.removeAttribute('id'));
  clone.querySelectorAll('[data-node-id]').forEach((el) => el.removeAttribute('data-node-id'));
  clone.querySelectorAll(`[${RENDER_ONLY_ATTR}]`).forEach((el) => el.remove());
  body.appendChild(clone);
  body.tabIndex = 0; // keyboard-scrollable region

  panel.append(bar, body);
  sheet.appendChild(panel);
  document.body.appendChild(sheet);
  document.body.classList.add('code-expand-open');

  // Highlight marks are cloned without their click/hover listeners (they're
  // attached per element), so a highlight in the expanded view was dead.
  // Re-attach the same listeners: a click opens its container, which stacks
  // ABOVE this sheet (see the sheet's z-index in codeBlocks.css).
  if (clone.querySelector('mark')) {
    void import('../hyperlights/listeners')
      .then(({ attachMarkListeners }) => { if (body.isConnected) attachMarkListeners(clone); })
      .catch((err) => log.error('Could not wire highlights in the expanded code view', FILE, err));
  }

  // The source block may be un-coloured (edit mode) — colour the CLONE only.
  if (!clone.querySelector(`span[${CODE_TOKEN_ATTR}]`)) {
    void loadHighlighter().then((hljs) => { if (body.isConnected) colourCodeBlock(body, hljs); });
  }

  const close = (): void => {
    release();
    sheet.remove();
    document.body.classList.remove('code-expand-open');
    if (closeOpenSurface === close) closeOpenSurface = null;
  };
  const release = trapModalFocus(sheet, {
    onEscape: close,
    // A highlight clicked in the sheet opens #hyperlit-container ABOVE it;
    // that container owns Tab/Escape until it closes.
    suspendWhen: () => document.getElementById('hyperlit-container')?.classList.contains('open') ?? false,
  });
  closeOpenSurface = close;

  closeBtn.addEventListener('click', close);
  sheet.addEventListener('click', (e) => { if (e.target === sheet) close(); });
  copyBtn.addEventListener('click', () => {
    void writeClipboard(codeText(body)).then((ok) => {
      const label = ok ? 'Copied' : 'Copy failed';
      if (ok) setCopyIcon(copyBtn, true);
      copyBtn.setAttribute('aria-label', label);
      copyBtn.title = label;
      window.setTimeout(() => {
        setCopyIcon(copyBtn, false);
        copyBtn.setAttribute('aria-label', 'Copy code');
        copyBtn.title = 'Copy code';
      }, 1500);
    });
  });
  wrapBtn.addEventListener('click', () => {
    const on = body.classList.toggle('is-wrapped');
    wrapBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
}

// ---------------------------------------------------------------------------
// Language menu (edit mode)
// ---------------------------------------------------------------------------

async function persistLanguage(pre: HTMLElement, langId: string | null): Promise<void> {
  const target = codeTarget(pre);
  for (const el of new Set([target, pre])) {
    for (const cls of Array.from(el.classList)) {
      if (/^(language|lang)-/i.test(cls)) el.classList.remove(cls);
    }
    if (el.getAttribute('class') === '') el.removeAttribute('class');
  }
  if (langId) {
    const cls = languageClassFor(langId);
    if (cls) target.classList.add(cls);
  }
  // Refresh the header label (declared language wins; auto shows "Code" until
  // colouring re-runs on edit-mode exit).
  const declared = declaredLanguage(target);
  const label = declared ? (declared.lang?.label ?? displayNameFor(declared.name)) : 'Auto-detect';
  pre.setAttribute('data-code-label', label);
  pre.querySelector(`:scope > [${RENDER_ONLY_ATTR}] .code-block-lang`)?.setAttribute('data-label', label);

  // The divEditor observer only watches `style` attributes, so a class change
  // must be queued explicitly. It's an authorized edit-session write.
  if (!pre.id) return;
  try {
    const { queueNodeForSave } = await import('../divEditor/index');
    queueNodeForSave(pre.id, 'update');
  } catch (err) {
    log.error('Could not queue code-language save', FILE, err);
  }
}

function openLanguageMenu(pre: HTMLElement, trigger: HTMLElement): void {
  closeOpenSurface?.();
  const current = declaredLanguage(codeTarget(pre))?.lang?.id ?? null;

  const menu = document.createElement('div');
  menu.className = 'code-lang-menu';
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', 'Code language');

  const addItem = (id: string | null, label: string): void => {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'code-lang-item';
    item.setAttribute('role', 'menuitemradio');
    item.setAttribute('aria-checked', id === current ? 'true' : 'false');
    item.textContent = label;
    item.addEventListener('click', () => {
      close();
      void persistLanguage(pre, id);
    });
    menu.appendChild(item);
  };
  addItem(null, 'Auto-detect');
  for (const lang of CODE_LANGUAGES) addItem(lang.id, lang.label);

  document.body.appendChild(menu);
  const r = trigger.getBoundingClientRect();
  const top = Math.min(r.bottom + 4, window.innerHeight - 40);
  menu.style.top = `${Math.max(8, top)}px`;
  menu.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - 220))}px`;
  menu.style.maxHeight = `${Math.max(160, window.innerHeight - top - 16)}px`;

  const onOutside = (e: MouseEvent): void => {
    if (!menu.contains(e.target as Node)) close();
  };
  const close = (): void => {
    release();
    menu.remove();
    document.removeEventListener('mousedown', onOutside, true);
    if (closeOpenSurface === close) closeOpenSurface = null;
  };
  const release = trapModalFocus(menu, { onEscape: close });
  closeOpenSurface = close;
  // Defer so the click that opened the menu doesn't immediately close it.
  window.setTimeout(() => document.addEventListener('mousedown', onOutside, true), 0);
  menu.querySelector<HTMLElement>('[aria-checked="true"]')?.focus();
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export function initCodeBlockControls(): void {
  if (clickHandler) return; // document-delegated singleton — create once

  // Header buttons must not move the caret/selection (edit mode) or start a
  // text selection that the highlight UI would then react to.
  mousedownHandler = (e: MouseEvent) => {
    const t = e.target as Element | null;
    if (t?.closest?.('[data-code-action]') && preFor(t)) e.preventDefault();
  };

  clickHandler = (e: MouseEvent) => {
    const t = e.target as Element | null;
    const btn = t?.closest?.<HTMLElement>('[data-code-action]');
    if (!btn) return;
    const pre = preFor(btn);
    if (!pre) return;
    e.preventDefault();
    e.stopPropagation();
    const action = btn.getAttribute('data-code-action');
    if (action === 'copy') void copyCode(pre, btn);
    else if (action === 'expand') openExpandSheet(pre);
    else if (action === 'language') openLanguageMenu(pre, btn);
  };

  // A coloured block the user starts typing into (e.g. an editable sub-book
  // outside the main edit-mode toggle): drop the token spans first, keeping
  // the caret where it was, so the edit lands in plain text.
  beforeInputHandler = (e: Event) => {
    const t = e.target as Element | null;
    if (!t || !(t instanceof Element)) return;
    const sel = window.getSelection();
    const anchor = sel?.anchorNode;
    const el = anchor ? (anchor.nodeType === Node.ELEMENT_NODE ? anchor as Element : anchor.parentElement) : null;
    const pre = el?.closest<HTMLElement>('pre[data-code-decorated="coloured"]');
    if (pre && pre.isContentEditable) uncolourPreservingSelection(pre);
  };

  document.addEventListener('mousedown', mousedownHandler, true);
  document.addEventListener('click', clickHandler, true);
  document.addEventListener('beforeinput', beforeInputHandler, true);
}

export function destroyCodeBlockControls(): void {
  closeOpenSurface?.();
  if (mousedownHandler) document.removeEventListener('mousedown', mousedownHandler, true);
  if (clickHandler) document.removeEventListener('click', clickHandler, true);
  if (beforeInputHandler) document.removeEventListener('beforeinput', beforeInputHandler, true);
  mousedownHandler = null;
  clickHandler = null;
  beforeInputHandler = null;
}
