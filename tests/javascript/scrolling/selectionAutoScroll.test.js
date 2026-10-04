/**
 * selectionAutoScroll — the scroll-padding-top override, both sources.
 *
 * `.reader-content-wrapper` carries `scroll-padding-top: 192px` (fragment-nav alignment).
 * The browser honours it for every native scroll-into-view, which breaks two gestures:
 * drag-select (native selection auto-scroll races up) and TYPING (the UA caret reveal
 * yanks the caret down to the 192px line — the "page jumps down when I type" bug).
 * The component zeroes the padding while either gesture is live, and the two sources are
 * deliberately separate flags: chunk windowing consumes isSelectionDragActive() as "don't
 * trim chunks", and typing must never masquerade as a drag.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
    initSelectionAutoScroll,
    destroySelectionAutoScroll,
    isSelectionDragActive,
} from '../../../resources/js/scrolling/selectionAutoScroll';

const TYPING_HOLD_MS = 250;

function buildDom() {
    document.body.innerHTML = `
        <div class="reader-content-wrapper">
            <div class="main-content">
                <p id="editable-node">Some text</p>
                <p id="readonly-node">Other text</p>
            </div>
        </div>
    `;
    const editable = document.getElementById('editable-node');
    // happy-dom reflects the attribute into isContentEditable; make it explicit either way.
    editable.setAttribute('contenteditable', 'true');
    if (!editable.isContentEditable) {
        Object.defineProperty(editable, 'isContentEditable', { value: true, configurable: true });
    }
    return {
        wrapper: document.querySelector('.reader-content-wrapper'),
        editable,
        readonly: document.getElementById('readonly-node'),
    };
}

function keydownOn(el, key = 'a') {
    el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
}

function pointerDownOn(el) {
    el.dispatchEvent(new PointerEvent('pointerdown', { button: 0, bubbles: true }));
}

function pointerUp() {
    document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
}

let dom;

beforeEach(() => {
    vi.useFakeTimers();
    dom = buildDom();
    initSelectionAutoScroll();
});

afterEach(() => {
    destroySelectionAutoScroll();
    vi.useRealTimers();
    document.body.innerHTML = '';
});

describe('typing override (the caret-reveal jump)', () => {
    it('zeroes scroll-padding-top on keydown in a contentEditable and restores after the hold', () => {
        keydownOn(dom.editable);
        expect(dom.wrapper.style.scrollPaddingTop).toBe('0px');

        vi.advanceTimersByTime(TYPING_HOLD_MS + 1);
        expect(dom.wrapper.style.scrollPaddingTop).toBe(''); // back to the stylesheet 192px
    });

    it('continuous typing keeps the override held (debounce re-arms per keystroke)', () => {
        keydownOn(dom.editable);
        vi.advanceTimersByTime(TYPING_HOLD_MS - 50);
        keydownOn(dom.editable);
        vi.advanceTimersByTime(TYPING_HOLD_MS - 50);
        expect(dom.wrapper.style.scrollPaddingTop).toBe('0px'); // still held

        vi.advanceTimersByTime(TYPING_HOLD_MS);
        expect(dom.wrapper.style.scrollPaddingTop).toBe('');
    });

    it('ignores keystrokes on non-contentEditable targets (read mode keeps native behaviour)', () => {
        keydownOn(dom.readonly);
        expect(dom.wrapper.style.scrollPaddingTop).toBe('');
    });

    it('does NOT report a selection drag while typing (chunk-trim guard isolation)', () => {
        keydownOn(dom.editable);
        expect(dom.wrapper.style.scrollPaddingTop).toBe('0px');
        expect(isSelectionDragActive()).toBe(false);
    });
});

describe('drag/typing overlap', () => {
    it('pointerup does not restore early while the typing hold is still pending', () => {
        keydownOn(dom.editable);
        pointerDownOn(dom.editable);
        pointerUp();
        expect(dom.wrapper.style.scrollPaddingTop).toBe('0px'); // typing hold still live

        vi.advanceTimersByTime(TYPING_HOLD_MS + 1);
        expect(dom.wrapper.style.scrollPaddingTop).toBe('');
    });

    it('typing-hold expiry does not restore while a drag is still live', () => {
        pointerDownOn(dom.editable);
        keydownOn(dom.editable);
        vi.advanceTimersByTime(TYPING_HOLD_MS + 1);
        expect(dom.wrapper.style.scrollPaddingTop).toBe('0px'); // drag still holds it

        pointerUp();
        expect(dom.wrapper.style.scrollPaddingTop).toBe('');
    });
});

describe('lifecycle', () => {
    it('drag override still works and reports via isSelectionDragActive()', () => {
        pointerDownOn(dom.editable);
        expect(dom.wrapper.style.scrollPaddingTop).toBe('0px');
        expect(isSelectionDragActive()).toBe(true);

        pointerUp();
        expect(dom.wrapper.style.scrollPaddingTop).toBe('');
        expect(isSelectionDragActive()).toBe(false);
    });

    it('window blur clears both sources (lost pointerup / tab switch mid-typing)', () => {
        pointerDownOn(dom.editable);
        keydownOn(dom.editable);
        window.dispatchEvent(new Event('blur'));
        expect(dom.wrapper.style.scrollPaddingTop).toBe('');
        expect(isSelectionDragActive()).toBe(false);
    });

    it('init re-entry clears a stale typing override (SPA nav)', () => {
        keydownOn(dom.editable);
        expect(dom.wrapper.style.scrollPaddingTop).toBe('0px');

        initSelectionAutoScroll(); // reader re-entry
        expect(dom.wrapper.style.scrollPaddingTop).toBe('');
    });
});
