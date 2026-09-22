/**
 * showUserProfile() must not re-render a profile that is already mounted.
 *
 * Several callers reach showUserProfile redundantly, and some do it from async
 * work (the delayed anonymous-transfer prompt, an auth round trip completing).
 * The unconditional `container.innerHTML = getProfileHTML(...)` therefore fired
 * at arbitrary moments — including while the flyout was open — destroying and
 * recreating every row. That drops focus, and it yanks a row out from under a
 * pointer mid-click: in the e2e journal tour it detached #myBooksBtn between
 * Playwright's stability check and its click ("element was detached from the
 * DOM, retrying").
 *
 * The guard is stateless on purpose — it reads the two DOM markers that fully
 * determine getProfileHTML's output — so there is no flag to go stale when a
 * login or register view is mounted into the same container.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

import { showUserProfile } from '../../../resources/js/components/userContainer/profile';
import { getLoginFormHTML } from '../../../resources/js/components/userContainer/forms';

/** Minimal stand-in for UserContainerManager's surface. */
function makeSelf({ verified = true, isOpen = true } = {}) {
    const container = document.createElement('div');
    container.id = 'user-container';
    document.body.appendChild(container);
    return {
        container,
        isOpen,
        user: { email_verified_at: verified ? '2026-01-01T00:00:00Z' : null },
        openContainer: vi.fn(function () { this.isOpen = true; }),
        attachProfileButtonListeners: vi.fn(),
    };
}

beforeEach(() => {
    document.body.innerHTML = '';
});

describe('showUserProfile idempotency', () => {
    it('renders and wires on first call', () => {
        const self = makeSelf();
        showUserProfile(self);

        expect(self.container.querySelector('#myBooksBtn')).not.toBeNull();
        expect(self.attachProfileButtonListeners).toHaveBeenCalledTimes(1);
    });

    it('does NOT replace the rows on a redundant call', () => {
        const self = makeSelf();
        showUserProfile(self);
        const myBooks = self.container.querySelector('#myBooksBtn');

        showUserProfile(self);
        showUserProfile(self);

        // Same element instance — nothing was detached out from under a click.
        expect(self.container.querySelector('#myBooksBtn')).toBe(myBooks);
        expect(myBooks.isConnected).toBe(true);
    });

    it('does NOT re-wire listeners on a redundant call', () => {
        // attachProfileButtonListeners uses bare addEventListener, so running
        // it twice over surviving rows would fire "My Library" twice — two SPA
        // navigations from one click.
        const self = makeSelf();
        showUserProfile(self);
        showUserProfile(self);

        expect(self.attachProfileButtonListeners).toHaveBeenCalledTimes(1);
    });

    it('DOES re-render when the verified state changes', () => {
        const self = makeSelf({ verified: true });
        showUserProfile(self);
        expect(self.container.querySelector('#verifyEmailBtn')).toBeNull();

        self.user.email_verified_at = null;
        showUserProfile(self);

        expect(self.container.querySelector('#verifyEmailBtn')).not.toBeNull();
        expect(self.attachProfileButtonListeners).toHaveBeenCalledTimes(2);
    });

    it('DOES render over a different view mounted in the same container', () => {
        // The guard must be derived from the DOM, not a remembered flag: the
        // login form lives in this same container.
        const self = makeSelf();
        self.container.innerHTML = getLoginFormHTML();

        showUserProfile(self);

        expect(self.container.querySelector('#myBooksBtn')).not.toBeNull();
        expect(self.container.querySelector('#loginEmail')).toBeNull();
        expect(self.attachProfileButtonListeners).toHaveBeenCalledTimes(1);
    });

    it('still opens a closed container without re-rendering it', () => {
        const self = makeSelf({ isOpen: true });
        showUserProfile(self);
        const myBooks = self.container.querySelector('#myBooksBtn');

        self.isOpen = false;
        showUserProfile(self);

        expect(self.openContainer).toHaveBeenCalledWith('profile');
        expect(self.container.querySelector('#myBooksBtn')).toBe(myBooks);
    });
});
