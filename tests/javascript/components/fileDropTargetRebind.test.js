/**
 * fileDropTarget: the init guard must ask the DOM, not the module variable.
 *
 * The overlay is appended to document.body. An SPA transition swaps the body,
 * which DETACHES the overlay while this module keeps its reference — so a plain
 * `if (overlayEl) return` idempotency guard skipped the rebuild forever and
 * page-level file drop was silently dead on every SPA-entered home/user/journal
 * page. The registry still reported fileDropTarget as ACTIVE, so nothing looked
 * broken from the outside; it surfaced only as the grand tour's
 * "#page-drop-overlay missing (registry: page=home, fileDropTarget active=true)"
 * on the journal → … → home landing (2026-09-22).
 *
 * This is the same family as the ButtonRegistry / SPA-nav-dead-feature gate: a
 * component that survives registration but not navigation.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../../resources/js/components/importQueue/folderIngest', () => ({
    captureDropEntries: vi.fn(() => null),
    collectFilesFromEntries: vi.fn(async () => []),
    planIngest: vi.fn(() => ({ kind: 'none' })),
}));
vi.mock('../../../resources/js/components/importQueue/batchUploader', () => ({
    uploadBatch: vi.fn(async () => {}),
}));
vi.mock('../../../resources/js/components/importQueue/importQueue', () => ({
    showImportQueuePreparing: vi.fn(),
    clearImportQueuePreparing: vi.fn(),
}));

import {
    initializeFileDropTarget,
    destroyFileDropTarget,
} from '../../../resources/js/components/fileDropTarget/fileDropTarget';

const OVERLAY = '#page-drop-overlay';

beforeEach(() => {
    document.body.innerHTML = '';
});

afterEach(() => {
    destroyFileDropTarget();
    document.body.innerHTML = '';
    vi.restoreAllMocks();
});

describe('fileDropTarget init guard', () => {
    it('creates the overlay on first init', () => {
        initializeFileDropTarget();
        expect(document.querySelector(OVERLAY)).not.toBeNull();
    });

    it('is idempotent while the overlay is still attached', () => {
        initializeFileDropTarget();
        const first = document.querySelector(OVERLAY);

        initializeFileDropTarget();

        expect(document.querySelectorAll(OVERLAY)).toHaveLength(1);
        // Same element — no needless rebuild.
        expect(document.querySelector(OVERLAY)).toBe(first);
    });

    it('rebuilds after an SPA body swap detaches the overlay', () => {
        initializeFileDropTarget();
        expect(document.querySelector(OVERLAY)).not.toBeNull();

        // What an SPA transition does: the body's children are replaced, so the
        // overlay is detached without destroyFileDropTarget() ever running.
        document.body.innerHTML = '<div id="app-container"></div>';
        expect(document.querySelector(OVERLAY)).toBeNull();

        initializeFileDropTarget();

        expect(document.querySelector(OVERLAY)).not.toBeNull();
        expect(document.querySelectorAll(OVERLAY)).toHaveLength(1);
    });

    it('survives repeated SPA swaps with exactly one overlay each time', () => {
        // The tour does several page transitions before landing on home; each
        // one detaches the overlay. Every rebuild must leave exactly one.
        for (let i = 0; i < 4; i++) {
            initializeFileDropTarget();
            expect(document.querySelectorAll(OVERLAY), `cycle ${i}`).toHaveLength(1);
            document.body.innerHTML = '<div id="app-container"></div>';
        }

        initializeFileDropTarget();
        expect(document.querySelectorAll(OVERLAY)).toHaveLength(1);
    });

    it('an explicit destroy still removes the overlay', () => {
        initializeFileDropTarget();
        destroyFileDropTarget();
        expect(document.querySelector(OVERLAY)).toBeNull();

        // ...and a later init brings it back (destroy nulls the module ref, so
        // this path never depended on the isConnected guard).
        initializeFileDropTarget();
        expect(document.querySelectorAll(OVERLAY)).toHaveLength(1);
    });
});
