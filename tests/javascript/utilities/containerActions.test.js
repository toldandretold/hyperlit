/**
 * Unit tests for the containerActions DI registry — the seam that lets feature modules
 * (hypercites, hyperlights) drive the hyperlit container WITHOUT importing hyperlitContainer/*
 * (the inversion that removed the last cross-folder cycle-breakers).
 *
 * Module singleton: the first test checks the pre-registration defaults, then registration
 * is wired and the delegators are asserted to forward.
 */
import { describe, it, expect, vi } from 'vitest';
import * as actions from '../../../resources/js/hyperlitContainer/containerActions';

describe('containerActions (before registration)', () => {
  it('queries return safe defaults; actions no-op without throwing', () => {
    expect(actions.getCurrentContainer()).toBeNull();
    expect(actions.isStackPopping()).toBe(false);
    expect(() => actions.openHyperlitContainer('x')).not.toThrow();
    // async delegator resolves rather than rejecting
    return expect(actions.closeHyperlitContainer()).resolves.toBeUndefined();
  });
});

describe('containerActions (after registration)', () => {
  it('delegators forward args + return values to the registered impls', async () => {
    const open = vi.fn();
    const close = vi.fn().mockResolvedValue(undefined);
    const getCurrentContainer = vi.fn(() => 'CONTAINER');
    const isStackPopping = vi.fn(() => true);
    const handleUnifiedContentClick = vi.fn().mockResolvedValue('clicked');

    actions.registerContainerActions({
      openHyperlitContainer: open,
      closeHyperlitContainer: close,
      getCurrentContainer,
      isStackPopping,
      handleUnifiedContentClick,
    });

    actions.openHyperlitContainer('content', true);
    expect(open).toHaveBeenCalledWith('content', true);

    expect(actions.getCurrentContainer()).toBe('CONTAINER');
    expect(actions.isStackPopping()).toBe(true);

    await expect(actions.closeHyperlitContainer(true)).resolves.toBeUndefined();
    expect(close).toHaveBeenCalledWith(true, undefined);

    await expect(actions.handleUnifiedContentClick('el', null)).resolves.toBe('clicked');
    expect(handleUnifiedContentClick).toHaveBeenCalledWith('el', null);
  });
});
