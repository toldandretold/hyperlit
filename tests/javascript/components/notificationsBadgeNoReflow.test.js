/**
 * The unread dot must never move anything.
 *
 * The badge count arrives on a network round trip, so applyNotificationsBadge()
 * runs whenever that happens to land — including while the profile flyout is
 * mid-open-animation (#user-container transitions width/height/opacity over
 * 0.3s). The first implementation built the .notif-dot-anchor around the icon
 * AND created/removed the .notif-dot element at that moment. Both are DOM
 * insertions, so every row below shifted under the user's cursor; in the e2e
 * tour it detached #myBooksBtn between Playwright's visibility check and its
 * click ("element is not stable" → "element was detached from the DOM").
 *
 * The contract now: all structure exists up front, and showing/hiding the dot
 * is a class toggle on an absolutely-positioned element. These tests assert the
 * DOM does not CHANGE SHAPE across a badge refresh — happy-dom has no layout
 * engine, so "no reflow" is pinned as "no structural mutation", which is the
 * thing we actually control.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../../resources/js/utilities/auth/session', () => ({
    getAuthContext: vi.fn(async () => ({ isLoggedIn: true })),
}));

import {
    applyNotificationsBadge,
    ensureNotificationsBadgeSlots,
} from '../../../resources/js/components/notificationsOverlay/notificationsOverlay';
import { getProfileHTML } from '../../../resources/js/components/userContainer/forms';

const USER_BUTTON = `
  <button id="userButton" aria-label="Account">
    <svg id="userLogo" width="20" height="20" viewBox="0 0 24 24"></svg>
  </button>
`;

/**
 * The element list itself, in document order. Compared by IDENTITY, so this
 * catches an element being added, removed, re-parented or replaced — while
 * deliberately ignoring class/attribute churn, because toggling a state class
 * is exactly the change we WANT and it cannot move anything.
 */
function elements(root) {
    return [...root.querySelectorAll('*')];
}

function sameElements(a, b) {
    return a.length === b.length && a.every((el, i) => el === b[i]);
}

beforeEach(() => {
    document.body.innerHTML = `${USER_BUTTON}<div id="user-container">${getProfileHTML(true)}</div>`;
});

afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
});

describe('notifications unread dot', () => {
    it('ships the anchor AND the dot in the profile markup', () => {
        // Not built on demand: #notificationsBtn must never take the
        // anchor-building branch, because that branch inserts elements.
        const btn = document.getElementById('notificationsBtn');
        expect(btn.querySelector(':scope > .notif-dot-anchor')).not.toBeNull();
        expect(btn.querySelector('.notif-dot-anchor > .notif-dot')).not.toBeNull();
        // The icon lives inside the anchor, not beside it.
        expect(btn.querySelector('.notif-dot-anchor > svg')).not.toBeNull();
    });

    it('scaffolds #userButton up front, at page entry', () => {
        expect(document.querySelector('#userButton > .notif-dot-anchor')).toBeNull();

        ensureNotificationsBadgeSlots();

        expect(document.querySelector('#userButton > .notif-dot-anchor')).not.toBeNull();
        expect(document.querySelector('#userButton .notif-dot')).not.toBeNull();
    });

    it('is idempotent — repeated scaffolding never nests or duplicates', () => {
        for (let i = 0; i < 4; i++) ensureNotificationsBadgeSlots();

        expect(document.querySelectorAll('#userButton .notif-dot-anchor')).toHaveLength(1);
        expect(document.querySelectorAll('#userButton .notif-dot')).toHaveLength(1);
        expect(document.querySelectorAll('#notificationsBtn .notif-dot-anchor')).toHaveLength(1);
        expect(document.querySelectorAll('#notificationsBtn .notif-dot')).toHaveLength(1);
    });

    it('does NOT add, remove or move any element when the badge is applied', async () => {
        // THE regression. applyNotificationsBadge() is what used to run at an
        // arbitrary moment — whenever the unread fetch landed — which could be
        // mid-flyout-animation. Asserted for a NON-ZERO count, since showing
        // the dot is the direction that used to insert an element.
        ensureNotificationsBadgeSlots();
        const before = elements(document.body);

        const mod = await import(
            '../../../resources/js/components/notificationsOverlay/notificationsOverlay'
        );
        global.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ unread: 7 }) }));
        await mod.refreshNotificationsBadge();

        expect(document.querySelector('#notificationsBtn .notif-dot-anchor').classList)
            .toContain('has-unread');
        expect(
            sameElements(before, elements(document.body)),
            'showing the unread dot changed the element tree — it must only toggle a class',
        ).toBe(true);
    });

    it('shows and hides purely via .has-unread', async () => {
        ensureNotificationsBadgeSlots();
        const anchor = document.querySelector('#notificationsBtn .notif-dot-anchor');
        const dot = anchor.querySelector('.notif-dot');

        const mod = await import(
            '../../../resources/js/components/notificationsOverlay/notificationsOverlay'
        );

        // Drive the real count path: an unread response, then a zero one.
        global.fetch = vi.fn(async () => ({
            ok: true,
            json: async () => ({ unread: 3 }),
        }));
        await mod.refreshNotificationsBadge();
        expect(anchor.classList.contains('has-unread')).toBe(true);
        // ...and the element itself never moved or was replaced.
        expect(anchor.querySelector('.notif-dot')).toBe(dot);

        global.fetch = vi.fn(async () => ({
            ok: true,
            json: async () => ({ unread: 0 }),
        }));
        await mod.refreshNotificationsBadge();
        expect(anchor.classList.contains('has-unread')).toBe(false);
        expect(anchor.querySelector('.notif-dot')).toBe(dot);
    });
});
