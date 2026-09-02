/**
 * citeGroupPopover — the grouped-citation ↗ chooser.
 *
 * Locks: a click on an `a[data-cite-group]` anchor never navigates — it opens
 * ONE floating chooser listing every member (quote + source + working href);
 * same-anchor click toggles; Escape and outside clicks close; destroy removes
 * the document-level delegate.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
    initCiteGroupPopover,
    destroyCiteGroupPopover,
} from '../../../../resources/js/components/aiArchivist/citeGroupPopover';

const MEMBERS = [
    { t: '/book_a#hypercite_aaa11111', s: 'Delinking — Samir Amin', q: 'first quoted passage' },
    { t: '/book_b#hypercite_bbb22222', s: 'Two Bits — Christopher Kelty', q: 'second quoted passage' },
];

function buildDom(payload = JSON.stringify(MEMBERS)) {
    document.body.innerHTML = `
        <p>Cited at length <a id="hypercite_group1" href="/book_a#hypercite_aaa11111"
            class="open-icon" data-cite-group='${payload}'>↗</a> here.</p>
        <button id="elsewhere">elsewhere</button>
    `;
}

const anchor = () => document.getElementById('hypercite_group1');
const popover = () => document.querySelector('.cite-group-popover');

function click(el) {
    const e = new MouseEvent('click', { bubbles: true, cancelable: true });
    el.dispatchEvent(e);
    return e;
}

beforeEach(() => {
    initCiteGroupPopover();
});

afterEach(() => {
    destroyCiteGroupPopover();
    document.body.innerHTML = '';
});

describe('cite group chooser', () => {
    it('opens one chooser listing every member instead of navigating', () => {
        buildDom();
        const e = click(anchor());

        expect(e.defaultPrevented).toBe(true);
        expect(popover()).not.toBeNull();
        const rows = popover().querySelectorAll('.cite-group-row');
        expect(rows).toHaveLength(2);
        expect(rows[0].getAttribute('href')).toBe('/book_a#hypercite_aaa11111');
        expect(rows[1].getAttribute('href')).toBe('/book_b#hypercite_bbb22222');
        expect(rows[0].textContent).toContain('first quoted passage');
        expect(rows[1].textContent).toContain('Christopher Kelty');
        expect(document.querySelectorAll('.cite-group-popover')).toHaveLength(1);
    });

    it('toggles on same-anchor click and closes on Escape / outside click', () => {
        buildDom();
        click(anchor());
        expect(popover()).not.toBeNull();
        click(anchor());
        expect(popover()).toBeNull();

        click(anchor());
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        expect(popover()).toBeNull();

        click(anchor());
        click(document.getElementById('elsewhere'));
        expect(popover()).toBeNull();
    });

    it('ignores anchors with an unparseable payload', () => {
        buildDom('not-json');
        click(anchor());
        expect(popover()).toBeNull();
    });

    it('destroy removes the delegate so clicks navigate normally again', () => {
        buildDom();
        destroyCiteGroupPopover();
        const e = click(anchor());
        expect(e.defaultPrevented).toBe(false);
        expect(popover()).toBeNull();
    });
});
