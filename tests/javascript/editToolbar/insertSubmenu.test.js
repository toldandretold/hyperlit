/**
 * InsertSubmenu — the insert (+) dropdown holding footnote/citation/image/link.
 * Pins: open/close/toggle, click-outside closes (but clicks inside or on the
 * trigger don't), the notifyOptionActivated guard window the trigger's
 * touchend polls, and that open() refreshes option button states.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { InsertSubmenu } from '../../../resources/js/editToolbar/insertSubmenu';

function buildDom() {
  document.body.innerHTML = `
    <div id="edit-toolbar">
      <button id="insertButton" type="button">+</button>
      <div id="insert-submenu" class="insert-submenu hidden">
        <button id="footnoteButton" type="button">fn</button>
        <button id="linkButton" type="button">link</button>
      </div>
    </div>
    <p id="outside">outside</p>
  `;
  return {
    submenu: document.getElementById('insert-submenu'),
    trigger: document.getElementById('insertButton'),
    outside: document.getElementById('outside'),
  };
}

function makeHandler(dom, buttonStateManager = { updateButtonStates: vi.fn() }) {
  return {
    handler: new InsertSubmenu({
      insertSubmenu: dom.submenu,
      insertButton: dom.trigger,
      buttonStateManager,
    }),
    buttonStateManager,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = '';
});

describe('InsertSubmenu', () => {
  it('toggle opens then closes, refreshes button states, and highlights the trigger while open', () => {
    const dom = buildDom();
    const { handler, buttonStateManager } = makeHandler(dom);

    handler.toggleInsertSubmenu();
    expect(dom.submenu.classList.contains('hidden')).toBe(false);
    expect(dom.trigger.classList.contains('menu-open')).toBe(true);
    expect(buttonStateManager.updateButtonStates).toHaveBeenCalledTimes(1);

    handler.toggleInsertSubmenu();
    expect(dom.submenu.classList.contains('hidden')).toBe(true);
    expect(dom.trigger.classList.contains('menu-open')).toBe(false);
  });

  it('click outside closes; clicks inside or on the trigger do not', () => {
    const dom = buildDom();
    const { handler } = makeHandler(dom);

    handler.openInsertSubmenu();
    vi.runOnlyPendingTimers(); // attach the deferred click-outside listener

    document.getElementById('footnoteButton').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(dom.submenu.classList.contains('hidden')).toBe(false);

    dom.trigger.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(dom.submenu.classList.contains('hidden')).toBe(false);

    dom.outside.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(dom.submenu.classList.contains('hidden')).toBe(true);
  });

  it('the click-outside listener is deferred so the opening click cannot instantly close it', () => {
    const dom = buildDom();
    const { handler } = makeHandler(dom);

    handler.openInsertSubmenu();
    // BEFORE the timeout(0) flushes, an outside click must not close it.
    dom.outside.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(dom.submenu.classList.contains('hidden')).toBe(false);
  });

  it('notifyOptionActivated closes the menu and arms a ~1s guard window', () => {
    const dom = buildDom();
    const { handler } = makeHandler(dom);

    handler.openInsertSubmenu();
    handler.notifyOptionActivated();

    expect(dom.submenu.classList.contains('hidden')).toBe(true);
    expect(handler.wasSubmenuButtonJustClicked()).toBe(true);

    vi.advanceTimersByTime(999);
    expect(handler.wasSubmenuButtonJustClicked()).toBe(true);
    vi.advanceTimersByTime(2);
    expect(handler.wasSubmenuButtonJustClicked()).toBe(false);
  });

  it('close removes the click-outside listener (no zombie closes)', () => {
    const dom = buildDom();
    const { handler } = makeHandler(dom);

    handler.openInsertSubmenu();
    vi.runOnlyPendingTimers();
    handler.closeInsertSubmenu();

    // Re-open manually WITHOUT the handler, then click outside: nothing should throw
    // and the stale listener must not close the fresh state.
    dom.submenu.classList.remove('hidden');
    dom.outside.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(dom.submenu.classList.contains('hidden')).toBe(false);
  });
});
