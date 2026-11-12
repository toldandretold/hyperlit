/**
 * The reader's "can you edit this book?" check (editButton/lock.ts) must not
 * touch hero-page pencils: on /a/{slug} it locked + hid the archive pencil
 * (the page's `book` is a route id, never editable), and the user page's
 * customization pencil is exposed the same way.
 */
import { describe, it, expect, vi } from 'vitest';

describe('reader edit-permission check leaves hero-page pencils alone', () => {
  it('does not lock/hide #editButton on a journal (archive) page', async () => {
    vi.resetModules();
    vi.doMock('../../../resources/js/utilities/auth/index', () => ({
      getCurrentUser: vi.fn(async () => ({ name: 'owner' })),
      canUserEditBook: vi.fn(async () => false),
    }));
    document.body.innerHTML = '<div id="bottom-right-buttons"><button id="editButton"><svg></svg></button></div>';
    document.body.dataset.page = 'journal';
    const { checkEditPermissionsAndUpdateUI } = await import('../../../resources/js/components/editButton/lock');
    await checkEditPermissionsAndUpdateUI();
    const btn = document.getElementById('editButton');
    expect(btn.dataset.isLocked).toBeUndefined();
    expect(btn.classList.contains('locked-state')).toBe(false);

    // …while the reader still gets the lock.
    document.body.dataset.page = 'reader';
    await checkEditPermissionsAndUpdateUI();
    expect(document.getElementById('editButton').dataset.isLocked).toBe('true');
    delete document.body.dataset.page;
    vi.doUnmock('../../../resources/js/utilities/auth/index');
  });
});
