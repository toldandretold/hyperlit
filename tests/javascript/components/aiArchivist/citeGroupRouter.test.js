/**
 * citeGroupRouter — grouped-citation ↗ anchors open the hyperlit container.
 *
 * Locks: a click on an `a[data-cite-group]` anchor never navigates — it routes
 * to handleUnifiedContentClick (the normal hypercite → container path, which
 * renders one Reference section per member); ordinary anchors are untouched;
 * destroy removes the document-level delegate.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { handleUnifiedContentClick } = vi.hoisted(() => ({
    handleUnifiedContentClick: vi.fn(async () => {}),
}));
vi.mock('../../../../resources/js/hyperlitContainer/index', () => ({
    handleUnifiedContentClick,
}));

import {
    initCiteGroupRouter,
    destroyCiteGroupRouter,
} from '../../../../resources/js/components/aiArchivist/citeGroupRouter';

const MEMBERS = [
    { t: '/book_a#hypercite_aaa11111', s: 'Delinking — Samir Amin', q: 'first quoted passage' },
    { t: '/book_b#hypercite_bbb22222', s: 'Two Bits — Christopher Kelty', q: 'second quoted passage' },
];

function buildDom(payload = JSON.stringify(MEMBERS)) {
    document.body.innerHTML = `
        <p>Cited at length <a id="hypercite_group1" href="/book_a#hypercite_aaa11111"
            class="open-icon" data-cite-group='${payload}'>↗</a> here.</p>
        <p>Single cite <a id="hypercite_single1" href="/book_c#hypercite_ccc33333"
            class="open-icon">↗</a> too.</p>
    `;
}

const groupAnchor = () => document.getElementById('hypercite_group1');
const singleAnchor = () => document.getElementById('hypercite_single1');

function click(el) {
    const e = new MouseEvent('click', { bubbles: true, cancelable: true });
    el.dispatchEvent(e);
    return e;
}

async function flush() {
    // the router's dynamic import + handler run async after the click
    await new Promise((r) => setTimeout(r, 0));
}

async function flushUntilRouted() {
    // The router awaits a dynamic import before calling the handler; under a
    // loaded suite that import can take more than one macrotask, so a single
    // setTimeout(0) flush loses the race (flaked in the full run 2026-11-02).
    // Positive assertions wait for the call; negatives keep the single tick.
    await vi.waitFor(() => expect(handleUnifiedContentClick).toHaveBeenCalled());
}

beforeEach(async () => {
    // Prime the (mocked) module cache: the router's dynamic import otherwise
    // resolves inside happy-dom's event-callback realm, where vite's module
    // runner lacks the URL global.
    await import('../../../../resources/js/hyperlitContainer/index');
    handleUnifiedContentClick.mockClear();
    initCiteGroupRouter();
});

afterEach(() => {
    destroyCiteGroupRouter();
    document.body.innerHTML = '';
});

describe('cite group router', () => {
    it('routes a group-anchor click into the hyperlit container instead of navigating', async () => {
        buildDom();
        const e = click(groupAnchor());

        expect(e.defaultPrevented).toBe(true);
        await flushUntilRouted();
        expect(handleUnifiedContentClick).toHaveBeenCalledTimes(1);
        expect(handleUnifiedContentClick).toHaveBeenCalledWith(groupAnchor());
    });

    it('routes clicks on children of the group anchor too', async () => {
        buildDom();
        groupAnchor().innerHTML = '<span class="inner">↗</span>';
        const e = click(groupAnchor().querySelector('.inner'));

        expect(e.defaultPrevented).toBe(true);
        await flushUntilRouted();
        expect(handleUnifiedContentClick).toHaveBeenCalledWith(groupAnchor());
    });

    it('leaves ordinary (non-group) anchors untouched', async () => {
        buildDom();
        const e = click(singleAnchor());

        expect(e.defaultPrevented).toBe(false);
        await flush();
        expect(handleUnifiedContentClick).not.toHaveBeenCalled();
    });

    it('destroy removes the delegate so clicks navigate normally again', async () => {
        buildDom();
        destroyCiteGroupRouter();
        const e = click(groupAnchor());

        expect(e.defaultPrevented).toBe(false);
        await flush();
        expect(handleUnifiedContentClick).not.toHaveBeenCalled();
    });
});
