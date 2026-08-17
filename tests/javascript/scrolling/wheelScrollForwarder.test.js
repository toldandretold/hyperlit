/**
 * wheelScrollForwarder — the homepage search textarea exemption.
 *
 * The capture-phase wheel handler forwards fixed-header wheels to the page
 * scroller. The auto-growing search textarea scrolls internally once it hits
 * max-height, so it must keep its wheel — but ONLY while it actually
 * overflows; over a short query the wheel still belongs to the page.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
    initWheelScrollForwarder,
    destroyWheelScrollForwarder,
} from '../../../resources/js/scrolling/wheelScrollForwarder';

function buildDom() {
    document.body.innerHTML = `
        <div id="app-container">
            <div class="fixed-header">
                <div id="homepage-search-container" class="search-container">
                    <textarea id="homepage-search-input" class="search-input"></textarea>
                </div>
            </div>
            <div class="home-content-wrapper"></div>
        </div>
    `;
}

function setOverflow(el, { scrollHeight, clientHeight }) {
    Object.defineProperty(el, 'scrollHeight', { value: scrollHeight, configurable: true });
    Object.defineProperty(el, 'clientHeight', { value: clientHeight, configurable: true });
}

function wheelOn(el, deltaY = 40) {
    const event = new WheelEvent('wheel', { deltaY, bubbles: true, cancelable: true });
    el.dispatchEvent(event);
    return event;
}

beforeEach(() => {
    buildDom();
    initWheelScrollForwarder();
});

afterEach(() => {
    destroyWheelScrollForwarder();
    document.body.innerHTML = '';
});

describe('homepage search textarea exemption', () => {
    it('keeps the wheel on the textarea while it overflows (internal scroll)', () => {
        const field = document.getElementById('homepage-search-input');
        setOverflow(field, { scrollHeight: 400, clientHeight: 220 });

        const wrapper = document.querySelector('.home-content-wrapper');
        const before = wrapper.scrollTop;
        const event = wheelOn(field);

        expect(event.defaultPrevented).toBe(false); // native textarea scroll runs
        expect(wrapper.scrollTop).toBe(before); // nothing forwarded to the page
    });

    it('forwards the wheel to the page while the textarea does NOT overflow', () => {
        const field = document.getElementById('homepage-search-input');
        setOverflow(field, { scrollHeight: 58, clientHeight: 58 });

        const wrapper = document.querySelector('.home-content-wrapper');
        const event = wheelOn(field, 40);

        expect(event.defaultPrevented).toBe(true);
        expect(wrapper.scrollTop).toBe(40);
    });

    it('still forwards fixed-header dead-zone wheels outside the field', () => {
        const wrapper = document.querySelector('.home-content-wrapper');
        const event = wheelOn(document.querySelector('.fixed-header'), 25);

        expect(event.defaultPrevented).toBe(true);
        expect(wrapper.scrollTop).toBe(25);
    });

    it('exempts any .search-results dropdown regardless of its id (journal regression)', () => {
        // The journal dropdown is #journal-search-results — the exemption must
        // match by class, not the homepage id.
        const dropdown = document.createElement('div');
        dropdown.id = 'journal-search-results';
        dropdown.className = 'search-results visible';
        document.querySelector('.fixed-header').appendChild(dropdown);

        const wrapper = document.querySelector('.home-content-wrapper');
        const event = wheelOn(dropdown, 30);

        expect(event.defaultPrevented).toBe(false); // native dropdown scroll runs
        expect(wrapper.scrollTop).toBe(0);
    });
});
