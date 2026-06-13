/**
 * Characterization of resources/js/divEditor/editSessionManager.js — the active
 * edit-session registry + the isolation-breach guard. Pinned before .js → .ts.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  registerEditSession, unregisterEditSession, getActiveEditSession,
  isContainerEditing, isEventInActiveDiv, verifyMutationSource,
} from '../../../resources/js/divEditor/editSessionManager.js';

let div;
beforeEach(async () => {
  document.body.innerHTML = '';
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  div = document.createElement('div');
  document.body.appendChild(div);
  // fresh session each test (module state is a singleton)
  await registerEditSession('c1', div, 'bookA');
});

describe('session lifecycle', () => {
  it('registers and exposes the active session, and clears it on unregister', () => {
    expect(getActiveEditSession()).toMatchObject({ containerId: 'c1', bookId: 'bookA' });
    expect(isContainerEditing('c1')).toBe(true);
    expect(isContainerEditing('other')).toBe(false);
    unregisterEditSession('c1');
    expect(getActiveEditSession()).toBeNull();
  });
});

describe('verifyMutationSource (isolation guard)', () => {
  it('accepts a mutation whose target is inside the active div and counts it', () => {
    const child = document.createElement('p'); div.appendChild(child);
    expect(verifyMutationSource({ type: 'characterData', target: child })).toBe(true);
    expect(getActiveEditSession().mutations).toBe(1);
  });

  it('rejects a connected mutation from a DIFFERENT container (breach)', () => {
    const outside = document.createElement('p'); document.body.appendChild(outside);
    expect(verifyMutationSource({ type: 'childList', target: outside })).toBe(false);
  });

  it('rejects a detached (disconnected) target silently', () => {
    const ghost = document.createElement('p'); // never appended → isConnected false
    expect(verifyMutationSource({ type: 'childList', target: ghost })).toBe(false);
  });

  it('rejects everything when there is no active session', () => {
    unregisterEditSession('c1');
    expect(verifyMutationSource({ type: 'characterData', target: div })).toBe(false);
  });
});

describe('isEventInActiveDiv', () => {
  it('is true for a target inside the active div, false otherwise', () => {
    const inside = document.createElement('span'); div.appendChild(inside);
    expect(isEventInActiveDiv(inside)).toBe(true);
    expect(isEventInActiveDiv(document.body)).toBe(false);
  });
});
