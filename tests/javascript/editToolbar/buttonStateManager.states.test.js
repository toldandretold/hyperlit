/**
 * ButtonStateManager — the states added by the 2026-09 toolbar redesign:
 * the link option (needs a selection, EXCEPT caret-inside-a-content-link which
 * enables edit mode; footnote-ref anchors never count), multi-block selections
 * disabling link, and the code option surfacing on the block submenu with the
 * block trigger lighting for PRE.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { ButtonStateManager } from '../../../resources/js/editToolbar/buttonStateManager';

function buildDom() {
  document.body.innerHTML = `
    <div class="main-content" id="book_x" contenteditable="true">
      <div class="chunk">
        <p id="100">plain paragraph text</p>
        <p id="101">second paragraph</p>
        <pre id="200"><code>const x = 1;</code></pre>
        <p id="300">before <a class="external-link" href="https://example.com/">a user link</a> after</p>
        <p id="400">note<sup class="footnote-ref" fn-count-id="1"><a id="Fn1" href="#fn1">1</a></sup></p>
      </div>
    </div>
    <button id="blockquoteButton" type="button"></button>
    <button id="linkButton" type="button"></button>
    <div id="blockquote-submenu">
      <button type="button" class="block-type-btn" data-block-type="p">P</button>
      <button type="button" class="block-type-btn" data-block-type="ul">ul</button>
      <button type="button" class="block-type-btn" data-block-type="ol">ol</button>
      <button type="button" class="block-type-btn" data-block-type="blockquote">bq</button>
      <button type="button" class="block-type-btn" data-block-type="code">code</button>
    </div>
  `;
}

function rangeOn(startNode, startOffset, endNode = startNode, endOffset = startOffset) {
  const range = document.createRange();
  range.setStart(startNode, startOffset);
  range.setEnd(endNode, endOffset);
  return range;
}

function managerFor(range) {
  const selection = {
    isCollapsed: range.collapsed,
    rangeCount: 1,
    getRangeAt: () => range,
  };
  const container = range.commonAncestorContainer;
  const parentElement = container.nodeType === Node.TEXT_NODE ? container.parentElement : container;
  const selectionManager = {
    currentSelection: selection,
    lastValidRange: range,
    editableSelector: '.main-content',
    getSelectionParentElement: () => parentElement,
  };
  const manager = new ButtonStateManager({
    blockquoteButton: document.getElementById('blockquoteButton'),
    linkButton: document.getElementById('linkButton'),
    blockSubmenu: document.getElementById('blockquote-submenu'),
    selectionManager,
  });
  return manager;
}

const linkButton = () => document.getElementById('linkButton');
// Scope to the submenu — the TRIGGER also carries data-block-type (the indicator).
const codeOption = () => document.querySelector('#blockquote-submenu [data-block-type="code"]');

beforeEach(() => buildDom());
afterEach(() => { document.body.innerHTML = ''; });

describe('link button state', () => {
  it('disabled with a collapsed caret in plain text', () => {
    const text = document.getElementById('100').firstChild;
    managerFor(rangeOn(text, 3)).updateButtonStates();
    expect(linkButton().disabled).toBe(true);
    expect(linkButton().classList.contains('disabled')).toBe(true);
  });

  it('enabled with a single-block text selection', () => {
    const text = document.getElementById('100').firstChild;
    managerFor(rangeOn(text, 0, text, 5)).updateButtonStates();
    expect(linkButton().disabled).toBe(false);
  });

  it('disabled for a selection spanning two blocks', () => {
    const a = document.getElementById('100').firstChild;
    const b = document.getElementById('101').firstChild;
    managerFor(rangeOn(a, 2, b, 4)).updateButtonStates();
    expect(linkButton().disabled).toBe(true);
  });

  it('enabled with a collapsed caret inside an existing user link (edit mode)', () => {
    const linkText = document.getElementById('300').querySelector('a').firstChild;
    managerFor(rangeOn(linkText, 2)).updateButtonStates();
    expect(linkButton().disabled).toBe(false);
  });

  it('disabled with a caret inside a footnote-ref anchor (not a content link)', () => {
    const fnText = document.querySelector('#Fn1').firstChild;
    managerFor(rangeOn(fnText, 0)).updateButtonStates();
    expect(linkButton().disabled).toBe(true);
  });
});

describe('block-picker indicator + conversion matrix', () => {
  const trigger = () => document.getElementById('blockquoteButton');
  const option = (type) => document.querySelector(`#blockquote-submenu [data-block-type="${type}"]`);
  const pOption = () => option('p');

  it('caret in a PRE: indicates code; blockquote/p enabled, lists disabled (code→list unimplemented)', () => {
    const codeText = document.getElementById('200').querySelector('code').firstChild;
    managerFor(rangeOn(codeText, 2)).updateButtonStates();
    expect(trigger().dataset.blockType).toBe('code');
    expect(trigger().classList.contains('active')).toBe(true);
    expect(trigger().disabled).toBe(false);
    expect(codeOption().classList.contains('active')).toBe(true);
    expect(pOption().disabled).toBe(false);
    expect(option('blockquote').disabled).toBe(false);
    expect(option('ul').disabled).toBe(true);
    expect(option('ol').disabled).toBe(true);
  });

  it('caret in a plain paragraph: indicates P, trigger reads SELECTED, all targets enabled', () => {
    const text = document.getElementById('100').firstChild;
    managerFor(rangeOn(text, 1)).updateButtonStates();
    expect(trigger().dataset.blockType).toBe('p');
    expect(trigger().classList.contains('active')).toBe(true); // indicator always reads selected
    expect(trigger().disabled).toBe(false);
    expect(pOption().classList.contains('active')).toBe(true);
    for (const t of ['ul', 'ol', 'blockquote', 'code']) {
      expect(option(t).disabled, `${t} should be enabled from a paragraph`).toBe(false);
    }
  });

  it('caret in a LIST: every cross-conversion enabled (swap, flatten, unwrap)', () => {
    const ul = document.createElement('ul');
    ul.id = '500';
    ul.innerHTML = '<li>item one</li>';
    document.querySelector('.chunk').appendChild(ul);
    const liText = ul.querySelector('li').firstChild;
    managerFor(rangeOn(liText, 2)).updateButtonStates();

    expect(trigger().dataset.blockType).toBe('ul');
    expect(option('ul').classList.contains('active')).toBe(true);
    for (const t of ['p', 'ol', 'blockquote', 'code']) {
      expect(option(t).disabled, `${t} should be enabled from a ul`).toBe(false);
    }
  });

  it('caret in a heading: picker disabled entirely (not its vocabulary)', () => {
    const h = document.createElement('h2');
    h.id = '600';
    h.textContent = 'a heading';
    document.querySelector('.chunk').appendChild(h);
    managerFor(rangeOn(h.firstChild, 2)).updateButtonStates();

    expect(trigger().disabled).toBe(true);
    expect(trigger().classList.contains('active')).toBe(false);
    for (const t of ['ul', 'ol', 'blockquote', 'code']) {
      expect(option(t).disabled).toBe(true);
    }
  });
});
