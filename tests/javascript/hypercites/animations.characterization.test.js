/**
 * Characterization of the testable parts of resources/js/hypercites/animations.js.
 * (highlightTargetHypercite is timer/animation-heavy and exercised by the e2e
 * grand tour; here we pin the two synchronous, deterministic helpers.)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../resources/js/utilities/toast.js', () => ({ showTargetNotFoundToast: vi.fn() }));

import { revealGhostIfTombstone, restoreNormalHyperciteDisplay } from '../../../resources/js/hypercites/animations';

beforeEach(() => { document.body.innerHTML = ''; });

describe('revealGhostIfTombstone', () => {
  it('returns false for a missing element or a non-tombstone', () => {
    expect(revealGhostIfTombstone('nope')).toBe(false);

    const plain = document.createElement('u');
    plain.id = 'u1';
    document.body.appendChild(plain);
    expect(revealGhostIfTombstone('u1')).toBe(false);
    expect(document.getElementById('ghost-bubble-u1')).toBeNull();
  });

  it('returns true and floats a ghost bubble for a tombstone', () => {
    const tomb = document.createElement('u');
    tomb.id = 't1';
    tomb.className = 'hypercite-tombstone';
    document.body.appendChild(tomb);

    expect(revealGhostIfTombstone('t1')).toBe(true);
    const bubble = document.getElementById('ghost-bubble-t1');
    expect(bubble).not.toBeNull();
    expect(bubble.className).toContain('ghost-bubble');
  });
});

describe('restoreNormalHyperciteDisplay', () => {
  it('strips target/dimmed/arrow classes from every hypercite element', () => {
    document.body.innerHTML =
      '<u class="hypercite-target">a</u>' +
      '<a class="hypercite-dimmed">b</a>' +
      '<span class="open-icon arrow-target">↗</span>';

    restoreNormalHyperciteDisplay();

    expect(document.querySelector('.hypercite-target')).toBeNull();
    expect(document.querySelector('.hypercite-dimmed')).toBeNull();
    expect(document.querySelector('.arrow-target')).toBeNull();
  });
});
