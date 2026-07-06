/**
 * modalState — the global modal stack that makes focus traps compose
 * (only the top trap owns Tab/Escape) and gates the contentHopper shortcuts.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { pushModal, popModal, isTopModal, isAnyModalOpen } from '../../../resources/js/utilities/modalState';

beforeEach(() => {
  // State lives on globalThis (survives module duplication) — reset per test.
  delete globalThis.__hyperlitModalStack;
});

describe('modalState stack semantics', () => {
  it('empty stack: nothing open, nothing top', () => {
    expect(isAnyModalOpen()).toBe(false);
  });

  it('single modal: open and top; closed after pop', () => {
    const t = pushModal();
    expect(isAnyModalOpen()).toBe(true);
    expect(isTopModal(t)).toBe(true);
    popModal(t);
    expect(isAnyModalOpen()).toBe(false);
    expect(isTopModal(t)).toBe(false);
  });

  it('stacked modals: only the top owns the keys; popping restores the one below', () => {
    const below = pushModal();
    const top = pushModal();
    expect(isTopModal(top)).toBe(true);
    expect(isTopModal(below)).toBe(false);
    popModal(top);
    expect(isTopModal(below)).toBe(true);
  });

  it('out-of-order pop (a lower modal closes first) keeps the stack sane', () => {
    const a = pushModal();
    const b = pushModal();
    const c = pushModal();
    popModal(a); // lower one closes first (e.g. SPA teardown of a container)
    expect(isTopModal(c)).toBe(true);
    popModal(c);
    expect(isTopModal(b)).toBe(true);
    popModal(b);
    expect(isAnyModalOpen()).toBe(false);
  });

  it('double-pop of the same token is a no-op', () => {
    const a = pushModal();
    const b = pushModal();
    popModal(b);
    popModal(b);
    expect(isTopModal(a)).toBe(true);
  });
});
