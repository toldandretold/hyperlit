/**
 * Characterization tests for the containerState leaf — the shared mutable state +
 * listener registry + module-state snapshot extracted out of index.ts so the
 * orchestrator modules can share it without an import cycle. Pins the save/restore/
 * reset round-trip and the listener registry that the stack/history rely on.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

import {
  containerState,
  activeListeners,
  registerListener,
  saveModuleState,
  restoreModuleState,
  resetModuleState,
  isClickProcessing,
} from '../../../resources/js/hyperlitContainer/containerState';

beforeEach(() => {
  // Module singletons persist across tests — reset to a known baseline.
  resetModuleState();
  containerState.isProcessingClick = false;
  containerState.isSavingEditToggle = false;
});

describe('registerListener', () => {
  it('attaches the listener and tracks it for cleanup', () => {
    const el = { addEventListener: vi.fn() };
    const handler = () => {};
    registerListener(el, 'click', handler);
    expect(el.addEventListener).toHaveBeenCalledWith('click', handler, {});
    expect(activeListeners).toHaveLength(1);
    expect(activeListeners[0]).toMatchObject({ element: el, event: 'click', handler });
  });
});

describe('saveModuleState / restoreModuleState', () => {
  it('round-trips the flags and a copy of the listeners', () => {
    const el = { addEventListener: vi.fn() };
    registerListener(el, 'input', () => {});
    containerState.mainEditorWasActive = true;
    containerState.previousIsEditing = true;
    containerState.focusSwitcherAttached = true;

    const snapshot = saveModuleState();

    // Mutate away from the snapshot...
    resetModuleState();
    expect(containerState.mainEditorWasActive).toBe(false);
    expect(activeListeners).toHaveLength(0);

    // ...then restore it.
    restoreModuleState(snapshot);
    expect(containerState.mainEditorWasActive).toBe(true);
    expect(containerState.previousIsEditing).toBe(true);
    expect(containerState.focusSwitcherAttached).toBe(true);
    expect(activeListeners).toHaveLength(1);
  });

  it('snapshots a COPY of the listeners array (later pushes do not leak in)', () => {
    registerListener({ addEventListener: vi.fn() }, 'a', () => {});
    const snapshot = saveModuleState();
    registerListener({ addEventListener: vi.fn() }, 'b', () => {});
    expect(snapshot.listeners).toHaveLength(1); // unaffected by the later push
    expect(activeListeners).toHaveLength(2);
  });

  it('restoreModuleState(null) is a no-op', () => {
    containerState.mainEditorWasActive = true;
    restoreModuleState(null);
    expect(containerState.mainEditorWasActive).toBe(true);
  });
});

describe('resetModuleState', () => {
  it('zeroes the flags and clears the listeners', () => {
    registerListener({ addEventListener: vi.fn() }, 'x', () => {});
    containerState.mainEditorWasActive = true;
    containerState.previousIsEditing = true;
    containerState.focusSwitcherAttached = true;

    resetModuleState();

    expect(activeListeners).toHaveLength(0);
    expect(containerState.mainEditorWasActive).toBe(false);
    expect(containerState.previousIsEditing).toBe(false);
    expect(containerState.focusSwitcherAttached).toBe(false);
  });
});

describe('isClickProcessing', () => {
  it('reflects the live containerState flag', () => {
    expect(isClickProcessing()).toBe(false);
    containerState.isProcessingClick = true;
    expect(isClickProcessing()).toBe(true);
  });
});
