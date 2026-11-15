/**
 * progressDialog — the "this is running, keep the page open" surface for work
 * the caller drives in several requests (first user: a shelf's bulk
 * make-public / make-private, whose single silent 12s request was reloaded
 * through).
 *
 * Pinned:
 *   - it is a real modal: on the body, focus held inside, and Escape does NOT
 *     close it — there is nothing to cancel into, the caller closes it;
 *   - `update` rewrites the status line in place (escaped, like every dialog);
 *   - `close` removes it, hands focus back to where it was, and is safe twice
 *     (callers close in a `finally`).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { progressDialog } from '../../../resources/js/components/dialog/dialog';
import { isAnyModalOpen } from '../../../resources/js/utilities/modalState';

const overlay = () => document.querySelector('.app-dialog-overlay');
const status = () => overlay().querySelector('[role="status"]');

beforeEach(() => {
  document.body.innerHTML = '<button id="opener">Make public</button>';
});

describe('progressDialog', () => {
  it('opens a modal with a live status line and takes focus off the page behind it', () => {
    const opener = document.getElementById('opener');
    opener.focus();

    const progress = progressDialog({ title: 'Making books public…', message: '0 of 59 book(s) done.' });

    expect(overlay().getAttribute('role')).toBe('dialog');
    expect(overlay().getAttribute('aria-modal')).toBe('true');
    expect(overlay().getAttribute('aria-busy')).toBe('true');
    expect(overlay().querySelector('h3').textContent).toBe('Making books public…');
    expect(status().getAttribute('aria-live')).toBe('polite');
    expect(status().textContent).toBe('0 of 59 book(s) done.');
    expect(overlay().contains(document.activeElement)).toBe(true);
    expect(isAnyModalOpen()).toBe(true);

    progress.close();
  });

  it('update rewrites the status line, escaped', () => {
    const progress = progressDialog({ message: 'Starting…' });

    progress.update('20 of 59 <b>books</b> done.');

    expect(status().textContent).toBe('20 of 59 <b>books</b> done.');
    expect(status().querySelector('b')).toBeNull();

    progress.close();
  });

  it('Escape does not dismiss it, and no listener behind it hears the key', () => {
    let heard = 0;
    const behind = () => { heard++; };
    document.addEventListener('keydown', behind, true);
    const progress = progressDialog({ message: 'Working…' });

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));

    expect(overlay()).not.toBeNull();
    // Registered BEFORE the trap, so it runs first in capture order — the
    // point is that the dialog itself is still there; later listeners are cut.
    expect(heard).toBe(1);
    let later = 0;
    const after = () => { later++; };
    document.addEventListener('keydown', after, true);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(later).toBe(0);

    progress.close();
    document.removeEventListener('keydown', behind, true);
    document.removeEventListener('keydown', after, true);
  });

  it('close removes it, returns focus to the opener, and is safe to call twice', () => {
    const opener = document.getElementById('opener');
    opener.focus();
    const progress = progressDialog({ message: 'Working…' });

    progress.close();
    progress.close();

    expect(overlay()).toBeNull();
    expect(document.activeElement).toBe(opener);
    expect(isAnyModalOpen()).toBe(false);
  });
});
