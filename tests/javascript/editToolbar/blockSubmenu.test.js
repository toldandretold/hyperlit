/**
 * BlockSubmenu — the block-type picker (2026-09 toolbar redesign). Pins: the
 * data-block-type="code" option dispatches formatBlockCallback("code"), and
 * the P option converts back to paragraph by dispatching on the CURRENT type
 * (remove-list in lists, code-toggle in PRE, blockquote-toggle in quotes) and
 * does NOTHING on a plain paragraph — the old ✕'s blockquote-toggle wrapped a
 * paragraph into a blockquote instead.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { BlockSubmenu } from '../../../resources/js/editToolbar/blockSubmenu';

function buildDom() {
  document.body.innerHTML = `
    <div id="edit-toolbar">
      <button id="blockquoteButton" type="button">B</button>
      <div id="blockquote-submenu" class="blockquote-submenu hidden">
        <button type="button" class="block-type-btn" data-block-type="p">P</button>
        <button type="button" class="block-type-btn" data-block-type="ul">ul</button>
        <button type="button" class="block-type-btn" data-block-type="blockquote">bq</button>
        <button type="button" class="block-type-btn" data-block-type="code">code</button>
      </div>
    </div>
    <div class="chunk">
      <p id="100">plain paragraph</p>
      <pre id="200"><code>const x = 1;</code></pre>
      <blockquote id="300">quoted</blockquote>
    </div>
  `;
  return {
    submenu: document.getElementById('blockquote-submenu'),
    trigger: document.getElementById('blockquoteButton'),
  };
}

function makeHandler(dom, parentElement) {
  const formatBlockCallback = vi.fn();
  const updateButtonStates = vi.fn();
  const handler = new BlockSubmenu({
    blockSubmenu: dom.submenu,
    blockquoteButton: dom.trigger,
    selectionManager: { getSelectionParentElement: () => parentElement },
    buttonStateManager: { updateButtonStates },
    formatBlockCallback,
  });
  return { handler, formatBlockCallback, updateButtonStates };
}

beforeEach(() => {
  document.body.innerHTML = '';
});

afterEach(() => {
  document.body.innerHTML = '';
});

describe('BlockSubmenu dispatch', () => {
  it('dispatches formatBlockCallback("code") from the code option', () => {
    const dom = buildDom();
    const { handler, formatBlockCallback } = makeHandler(dom, document.getElementById('100'));

    handler.openBlockSubmenu();
    // open() clone-replaces the option buttons — query fresh, then click.
    const codeBtn = dom.submenu.querySelector('[data-block-type="code"]');
    codeBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(formatBlockCallback).toHaveBeenCalledWith('code');
    expect(dom.submenu.classList.contains('hidden')).toBe(true);
  });

  it('open() refreshes option states and highlights the trigger while open', () => {
    const dom = buildDom();
    const { handler, updateButtonStates } = makeHandler(dom, document.getElementById('100'));
    handler.openBlockSubmenu();
    expect(updateButtonStates).toHaveBeenCalledTimes(1);
    expect(dom.trigger.classList.contains('menu-open')).toBe(true);
    handler.closeBlockSubmenu();
    expect(dom.trigger.classList.contains('menu-open')).toBe(false);
  });
});

describe('BlockSubmenu P option (convert to paragraph)', () => {
  it('in a PRE → toggles code off (not blockquote)', () => {
    const dom = buildDom();
    const inPre = document.getElementById('200').querySelector('code');
    const { handler, formatBlockCallback } = makeHandler(dom, inPre);

    handler._convertToParagraph();

    expect(formatBlockCallback).toHaveBeenCalledWith('code');
    expect(formatBlockCallback).not.toHaveBeenCalledWith('blockquote');
  });

  it('in a blockquote → toggles blockquote off', () => {
    const dom = buildDom();
    const { handler, formatBlockCallback } = makeHandler(dom, document.getElementById('300'));

    handler._convertToParagraph();

    expect(formatBlockCallback).toHaveBeenCalledWith('blockquote');
  });

  it('in a list → remove-list (list wins over other types)', () => {
    const dom = buildDom();
    const ul = document.createElement('ul');
    ul.innerHTML = '<li id="400">item</li>';
    document.querySelector('.chunk').appendChild(ul);
    const { handler, formatBlockCallback } = makeHandler(dom, ul.querySelector('li'));

    handler._convertToParagraph();

    expect(formatBlockCallback).toHaveBeenCalledWith('remove-list');
  });

  it('on a plain paragraph → NO-OP (the old ✕ wrapped it in a blockquote)', () => {
    const dom = buildDom();
    const { handler, formatBlockCallback } = makeHandler(dom, document.getElementById('100'));

    handler._convertToParagraph();

    expect(formatBlockCallback).not.toHaveBeenCalled();
  });

  it('the P option button dispatches through _executeBlockType', () => {
    const dom = buildDom();
    const inPre = document.getElementById('200').querySelector('code');
    const { handler, formatBlockCallback } = makeHandler(dom, inPre);

    handler.openBlockSubmenu();
    const pBtn = dom.submenu.querySelector('[data-block-type="p"]');
    pBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(formatBlockCallback).toHaveBeenCalledWith('code');
    expect(dom.submenu.classList.contains('hidden')).toBe(true);
  });
});
