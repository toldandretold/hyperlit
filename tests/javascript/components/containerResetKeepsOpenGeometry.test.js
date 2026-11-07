/**
 * Regression: a rebind must not strip an OPEN panel's geometry.
 *
 * ContainerManager.rebindElements() → resetContainerState() runs on every
 * (re)initialisation, and home hydration runs it on the user container twice
 * AFTER the Account button is already clickable (registry initFn +
 * initializeHomepage). It used to wipe the inline top/left/width/height/opacity
 * while keeping `.open`. Those are exactly what openContainer writes to place
 * and reveal the panel, so the panel kept its backdrop and focus trap but fell
 * into normal flow below the fold: a blurred page with no reachable panel.
 * That is what the account-deletion e2e kept hitting as "#showRegister is
 * outside of the viewport".
 *
 * The method is called on a bare `this` so the test pins the contract without
 * pulling in a real subclass's dependency graph.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../resources/js/app', () => ({ book: 'test-book' }));
vi.mock('../../../resources/js/components/cloudRef/editIndicator', () => ({
  isProcessing: () => false,
  isComplete: () => false,
}));
vi.mock('../../../resources/js/utilities/logger', () => ({
  verbose: { init: vi.fn(), content: vi.fn() },
  log: { init: vi.fn(), error: vi.fn() },
}));

import { ContainerManager } from '../../../resources/js/components/utilities/containerManager';

const reset = (self) => ContainerManager.prototype.resetContainerState.call(self);

let container;

beforeEach(() => {
  document.body.innerHTML = '<div id="user-container" class="hidden"></div>';
  container = document.getElementById('user-container');
});

describe('resetContainerState', () => {
  it('leaves an open panel where openContainer put it', () => {
    container.classList.remove('hidden');
    container.classList.add('open');
    Object.assign(container.style, {
      top: '54px', left: '54px', width: '280px', height: 'auto', opacity: '1', padding: '20px',
    });
    const self = { container, isOpen: true };

    reset(self);

    expect(container.classList.contains('open')).toBe(true);
    expect(container.classList.contains('hidden')).toBe(false);
    expect(self.isOpen).toBe(true);
    expect(container.style.top).toBe('54px');
    expect(container.style.left).toBe('54px');
    expect(container.style.width).toBe('280px');
    expect(container.style.opacity).toBe('1');
    expect(container.style.padding).toBe('20px');
  });

  it('still scrubs a closed panel back to a clean hidden state', () => {
    // What closeContainer leaves behind: zero size, transparent, hidden.
    Object.assign(container.style, {
      top: '54px', left: '54px', width: '0', height: '0', opacity: '0', visibility: 'hidden',
    });
    const self = { container, isOpen: false };

    reset(self);

    expect(container.classList.contains('hidden')).toBe(true);
    expect(container.classList.contains('open')).toBe(false);
    expect(self.isOpen).toBe(false);
    for (const prop of ['top', 'left', 'width', 'height', 'opacity', 'visibility']) {
      expect(container.style[prop], prop).toBe('');
    }
  });
});
