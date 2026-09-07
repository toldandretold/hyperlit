/**
 * LinkMode — the in-toolbar URL input for the insert-link option. Pins: URL
 * validation posture (http/https only, schemeless gets https://, dangerous
 * schemes and oversized rejected), the wrap of a PARTIAL-node selection via
 * extractContents (the surroundContents-throws case), the {type:'input'} undo
 * entry shape + save call, existing-link pre-fill + href rewrite, and unwrap
 * via removeLink.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../../resources/js/app.js', () => ({ book: 'book_link' }));
vi.mock('../../../resources/js/utilities/logger', () => ({
  log: new Proxy({}, { get: () => vi.fn() }),
  verbose: new Proxy({}, { get: () => vi.fn() }),
  isVerboseEnabled: () => false,
}));

import { LinkMode, validateLinkUrl } from '../../../resources/js/editToolbar/linkMode';

function buildDom() {
  document.body.innerHTML = `
    <div id="edit-toolbar">
      <button id="someButton" type="button">b</button>
      <div id="link-mode-container" class="hidden">
        <div class="link-input-wrapper">
          <input type="url" id="link-url-input" />
          <button id="link-remove-btn" type="button">⌫</button>
          <button id="link-confirm-btn" type="button">✓</button>
          <button id="link-close-btn" type="button">×</button>
        </div>
      </div>
    </div>
    <div class="chunk">
      <p id="100" data-node-id="book_link_1_n">Hello <strong>bold world</strong> tail</p>
    </div>
  `;
  return {
    toolbar: document.getElementById('edit-toolbar'),
    container: document.getElementById('link-mode-container'),
    input: document.getElementById('link-url-input'),
    confirmBtn: document.getElementById('link-confirm-btn'),
    removeBtn: document.getElementById('link-remove-btn'),
    closeBtn: document.getElementById('link-close-btn'),
    block: document.getElementById('100'),
  };
}

function makeMode(dom) {
  return new LinkMode({
    toolbar: dom.toolbar,
    linkContainer: dom.container,
    linkInput: dom.input,
    confirmBtn: dom.confirmBtn,
    removeBtn: dom.removeBtn,
    closeBtn: dom.closeBtn,
  });
}

function makeContext(range, existingAnchor = null) {
  return {
    range,
    existingAnchor,
    bookId: 'book_link',
    undoManager: { sealGroup: vi.fn(), _pushUndo: vi.fn() },
    saveCallback: vi.fn(),
  };
}

beforeEach(() => {
  document.body.innerHTML = '';
});

afterEach(() => {
  document.body.innerHTML = '';
});

describe('validateLinkUrl', () => {
  it('accepts http/https and normalizes', () => {
    expect(validateLinkUrl('https://example.com/page')).toBe('https://example.com/page');
    expect(validateLinkUrl('  http://example.com  ')).toBe('http://example.com/');
  });

  it('prepends https:// to schemeless input', () => {
    expect(validateLinkUrl('example.com/thing')).toBe('https://example.com/thing');
  });

  it('rejects dangerous or non-web schemes', () => {
    expect(validateLinkUrl('javascript:alert(1)')).toBeNull();
    expect(validateLinkUrl('data:text/html,<b>x</b>')).toBeNull();
    expect(validateLinkUrl('file:///etc/passwd')).toBeNull();
    expect(validateLinkUrl('vbscript:evil')).toBeNull();
  });

  it('rejects empty, dotless-host and oversized input', () => {
    expect(validateLinkUrl('')).toBeNull();
    expect(validateLinkUrl('   ')).toBeNull();
    expect(validateLinkUrl('localhost')).toBeNull();
    expect(validateLinkUrl(`https://example.com/${'a'.repeat(2050)}`)).toBeNull();
  });
});

describe('LinkMode open/close', () => {
  it('open shows the container, adds the toolbar class, pre-fills from an existing anchor', () => {
    const dom = buildDom();
    const mode = makeMode(dom);
    const anchor = document.createElement('a');
    anchor.setAttribute('href', 'https://old.example.com/');
    dom.block.appendChild(anchor);

    const range = document.createRange();
    range.selectNodeContents(dom.block);
    mode.open(makeContext(range, anchor));

    expect(dom.toolbar.classList.contains('link-mode-active')).toBe(true);
    expect(dom.container.classList.contains('hidden')).toBe(false);
    expect(dom.input.value).toBe('https://old.example.com/');
    expect(dom.removeBtn.style.display).not.toBe('none');

    mode.close();
    expect(dom.toolbar.classList.contains('link-mode-active')).toBe(false);
    expect(dom.container.classList.contains('hidden')).toBe(true);
  });

  it('dismisses the hyperlight selection popup on open (link mode owns the selection)', () => {
    const dom = buildDom();
    const hlButtons = document.createElement('div');
    hlButtons.id = 'hyperlight-buttons';
    hlButtons.style.display = 'flex';
    document.body.appendChild(hlButtons);
    dom.toolbar.classList.add('hyperlight-selection-active');

    const mode = makeMode(dom);
    const range = document.createRange();
    range.selectNodeContents(dom.block);
    mode.open(makeContext(range));

    expect(hlButtons.style.display).toBe('none');
    expect(dom.toolbar.classList.contains('hyperlight-selection-active')).toBe(false);
  });

  it('hides the remove button for a fresh insert', () => {
    const dom = buildDom();
    const mode = makeMode(dom);
    const range = document.createRange();
    range.selectNodeContents(dom.block);
    mode.open(makeContext(range));
    expect(dom.removeBtn.style.display).toBe('none');
  });
});

describe('LinkMode confirm — new link', () => {
  it('wraps a partial-node selection (half a <strong>) and records undo + save', async () => {
    const dom = buildDom();
    const mode = makeMode(dom);

    // Select from "bold" (inside <strong>) into the tail text — the classic
    // partially-selected-node range that makes surroundContents throw.
    const strongText = dom.block.querySelector('strong').firstChild;
    const tailText = dom.block.lastChild;
    const range = document.createRange();
    range.setStart(strongText, 5); // after "bold "
    range.setEnd(tailText, 3);

    const context = makeContext(range);
    mode.open(context);
    dom.input.value = 'example.org/ref';
    await mode.confirm();

    const anchor = dom.block.querySelector('a.external-link');
    expect(anchor).not.toBeNull();
    expect(anchor.getAttribute('href')).toBe('https://example.org/ref');
    expect(anchor.getAttribute('target')).toBe('_blank');
    expect(anchor.getAttribute('rel')).toBe('noopener noreferrer');
    expect(anchor.textContent).toBe('world ta');

    expect(context.undoManager.sealGroup).toHaveBeenCalled();
    const [bookId, entry] = context.undoManager._pushUndo.mock.calls[0];
    expect(bookId).toBe('book_link');
    expect(entry.type).toBe('input');
    expect(entry.elementId).toBe('100');
    expect(entry.oldHTML).toContain('bold world');
    expect(entry.newHTML).toContain('external-link');

    expect(context.saveCallback).toHaveBeenCalledTimes(1);
    const [savedId, savedHtml] = context.saveCallback.mock.calls[0];
    expect(savedId).toBe('100');
    expect(savedHtml).toContain('external-link');

    expect(mode.isOpen).toBe(false);
  });

  it('keeps the mode open and flags the input when the URL is invalid', async () => {
    const dom = buildDom();
    const mode = makeMode(dom);
    const range = document.createRange();
    range.selectNodeContents(dom.block);
    const context = makeContext(range);
    mode.open(context);

    dom.input.value = 'javascript:alert(1)';
    await mode.confirm();

    expect(mode.isOpen).toBe(true);
    expect(dom.input.classList.contains('link-input-invalid')).toBe(true);
    expect(context.saveCallback).not.toHaveBeenCalled();
    expect(dom.block.querySelector('a')).toBeNull();
  });
});

describe('LinkMode existing-link edit + remove', () => {
  function withExistingLink(dom) {
    const anchor = document.createElement('a');
    anchor.setAttribute('href', 'https://old.example.com/');
    anchor.className = 'external-link';
    anchor.textContent = 'linked text';
    dom.block.appendChild(anchor);
    const range = document.createRange();
    range.setStart(anchor.firstChild, 2);
    range.collapse(true);
    return { anchor, range };
  }

  it('confirm rewrites only the href', async () => {
    const dom = buildDom();
    const mode = makeMode(dom);
    const { anchor, range } = withExistingLink(dom);
    const context = makeContext(range, anchor);

    mode.open(context);
    dom.input.value = 'https://new.example.com/path';
    await mode.confirm();

    expect(anchor.getAttribute('href')).toBe('https://new.example.com/path');
    expect(anchor.textContent).toBe('linked text');
    expect(context.saveCallback).toHaveBeenCalledTimes(1);
  });

  it('removeLink unwraps the anchor, keeping its children', async () => {
    const dom = buildDom();
    const mode = makeMode(dom);
    const { anchor, range } = withExistingLink(dom);
    const context = makeContext(range, anchor);

    mode.open(context);
    await mode.removeLink();

    expect(dom.block.querySelector('a')).toBeNull();
    expect(dom.block.textContent).toContain('linked text');
    expect(context.saveCallback).toHaveBeenCalledTimes(1);
    expect(mode.isOpen).toBe(false);
  });
});
