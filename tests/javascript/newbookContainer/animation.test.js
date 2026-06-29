/**
 * Unit tests for the animation helpers (animation.ts). finishClose is the de-duplicated close
 * completion that previously existed as two verbatim copies (transitionend handler + timeout
 * fallback); both completion paths now route through it.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  resetAnimationState,
  finishClose,
} from '../../../resources/js/components/newbookContainer/animation';

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = '';
});

function makeHost({ originalContent = null } = {}) {
  const container = document.createElement('div');
  container.id = 'newbook-container';
  document.body.appendChild(container);
  const overlay = document.createElement('div');
  document.body.appendChild(overlay);

  return {
    container,
    overlay,
    originalContent,
    isAnimating: true,
    animationTimeout: null,
    transitionEndHandler: null,
    setupButtonListeners: vi.fn(),
  };
}

describe('resetAnimationState', () => {
  it('clears the pending timeout + transitionend listener and drops the flag', () => {
    vi.useFakeTimers();
    const host = makeHost();
    const handler = vi.fn();
    host.transitionEndHandler = handler;
    host.container.addEventListener('transitionend', handler);
    host.animationTimeout = setTimeout(() => { throw new Error('should have been cleared'); }, 500);

    resetAnimationState(host);

    expect(host.isAnimating).toBe(false);
    expect(host.animationTimeout).toBeNull();
    expect(host.transitionEndHandler).toBeNull();
    // listener removed → dispatching does nothing
    host.container.dispatchEvent(new Event('transitionend'));
    expect(handler).not.toHaveBeenCalled();
    vi.runOnlyPendingTimers(); // no throw — the timeout was cleared
  });
});

describe('finishClose', () => {
  it('hides + collapses the container, clears positioning, hides overlay', () => {
    const host = makeHost();
    host.container.style.left = '50px';
    host.container.style.top = '48px';
    host.container.style.transform = 'scale(1)';

    finishClose(host);

    expect(host.container.classList.contains('hidden')).toBe(true);
    expect(host.container.style.display).toBe('none');
    expect(host.container.style.left).toBe('');
    expect(host.container.style.right).toBe('');
    expect(host.container.style.top).toBe('');
    expect(host.container.style.transform).toBe('');
    expect(host.overlay.style.display).toBe('none');
    expect(host.isAnimating).toBe(false);
  });

  it('restores the two-button view and re-binds listeners when originalContent differs', () => {
    const host = makeHost({ originalContent: '<button id="importBook">Import</button>' });
    host.container.innerHTML = '<form id="cite-form"></form>';

    finishClose(host);

    expect(host.container.querySelector('#importBook')).toBeTruthy();
    expect(host.container.querySelector('#cite-form')).toBeNull();
    expect(host.setupButtonListeners).toHaveBeenCalledOnce();
  });

  it('does not re-bind when the content already matches originalContent', () => {
    const html = '<button id="importBook">Import</button>';
    const host = makeHost({ originalContent: html });
    host.container.innerHTML = html;

    finishClose(host);

    expect(host.setupButtonListeners).not.toHaveBeenCalled();
  });
});
