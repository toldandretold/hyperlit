/**
 * newbookContainer: rebindElements() must re-wire the buttons INSIDE the panel,
 * not just the outer trio the base ContainerManager knows about.
 *
 * ContainerManager.rebindElements() re-finds container / overlay / #newBookButton.
 * The two buttons inside the panel — #createNewBook and #importBook — are wired
 * by setupButtonListeners, which otherwise runs only from the constructor and
 * after a form close. So on an SPA body swap that the module-scoped manager
 * SURVIVES, initializeNewBookContainer takes its "manager exists → rebindElements()"
 * branch: the container reference is refreshed (so the ButtonRegistry and every DOM
 * probe report the component perfectly healthy) while both inner buttons keep their
 * handlers on the DETACHED nodes from the previous page.
 *
 * Nothing looks broken from the outside. The + menu opens and neither button does
 * anything — and because page-level file drop opens the import form by CLICKING
 * #importBook, drag-and-drop import dies silently with it. That was 9/10 runs of
 * tests/e2e/specs/journal/journal-spa-navigation.spec.js failing at "#cite-form
 * never opened after a synthetic drop" while the diagnostic reported
 * {importBtn: true, newbookContainer: true, registryPage: "home",
 *  newBookButtonActive: true} — every link in the chain present, none of them wired.
 *
 * Sibling gate: fileDropTargetRebind.test.js (same family — a component that
 * survives registration but not navigation). See CLAUDE.md §"Interactive
 * components MUST go through ButtonRegistry".
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// The create path navigates; the import path lazy-loads the cite-form module.
// Neither is under test here — only which ELEMENT the handlers are bound to.
vi.mock('../../../resources/js/SPA/navigation/navigationRegistry', () => ({
    navigate: vi.fn(async () => {}),
}));

import { NewBookContainerManager } from '../../../resources/js/components/newbookContainer/index';

const PANEL_HTML = `
  <button id="newBookButton"><span class="icon"></span></button>
  <div id="source-overlay"></div>
  <div id="newbook-container">
    <button id="createNewBook">Create</button>
    <button id="importBook">Import</button>
    <input type="checkbox" id="createEncrypted" />
  </div>
`;

function mountPage() {
    // The cite-form template reads the CSRF token out of the document head.
    if (!document.querySelector('meta[name="csrf-token"]')) {
        document.head.innerHTML = '<meta name="csrf-token" content="test-token">';
    }
    document.body.innerHTML = PANEL_HTML;
}

/**
 * An SPA body swap: every element is replaced by an equivalent NEW node, and
 * destroy() never runs — which is exactly the state the manager survives into.
 */
function swapBody() {
    document.body.innerHTML = PANEL_HTML;
}

let manager;

beforeEach(() => {
    mountPage();
    manager = new NewBookContainerManager('newbook-container', 'source-overlay', 'newBookButton', []);
});

afterEach(() => {
    manager?.destroy?.();
    manager = undefined;
    document.body.innerHTML = '';
    vi.restoreAllMocks();
});

describe('NewBookContainerManager.rebindElements', () => {
    it('wires the inner buttons on construction', () => {
        expect(manager.importBookHandler).toBeTruthy();
        expect(manager.createBookHandler).toBeTruthy();

        document.getElementById('importBook').click();
        expect(document.getElementById('cite-form')).not.toBeNull();
    });

    it('re-wires #importBook after a body swap the manager survives', () => {
        swapBody();
        // The manager still holds a handler, but it is bound to the DETACHED
        // button — this is the state the registry cannot see.
        expect(manager.importBookHandler).toBeTruthy();

        // What initializeNewBookContainer's "manager exists" branch does.
        manager.button = document.getElementById('newBookButton');
        manager.rebindElements();

        document.getElementById('importBook').click();
        expect(
            document.getElementById('cite-form'),
            'clicking the post-swap #importBook must open the cite-form',
        ).not.toBeNull();
    });

    it('re-finds the container itself, so the form lands in the LIVE panel', () => {
        swapBody();
        manager.button = document.getElementById('newBookButton');
        manager.rebindElements();

        expect(manager.container).toBe(document.getElementById('newbook-container'));
        expect(manager.container.isConnected).toBe(true);

        document.getElementById('importBook').click();
        // Not merely present in the document — present in the panel the user sees.
        expect(manager.container.querySelector('#cite-form')).not.toBeNull();
    });

    it('fires the import handler exactly ONCE per click after repeated rebinds', () => {
        // setupButtonListeners removes-then-adds against the CURRENT elements,
        // so rebinding N times must not accumulate listeners. The equivalent
        // duplicate on #createNewBook would create two books from one click.
        const showImportForm = vi.spyOn(manager, 'showImportForm');

        for (let i = 0; i < 4; i++) manager.rebindElements();

        document.getElementById('importBook').click();
        expect(showImportForm).toHaveBeenCalledTimes(1);
    });

    it('does not double-wire during construction', () => {
        // The base constructor calls rebindElements() before this subclass's
        // field initializers have run. If the override re-wired there, the
        // constructor's own setupButtonListeners() would add a SECOND listener
        // (the first handler having been clobbered to null by the field
        // initializer, so it could never be removed).
        swapBody(); // strand the beforeEach manager's handlers on detached nodes
        const fresh = new NewBookContainerManager(
            'newbook-container', 'source-overlay', 'newBookButton', [],
        );
        const showImportForm = vi.spyOn(fresh, 'showImportForm');

        document.getElementById('importBook').click();
        expect(showImportForm).toHaveBeenCalledTimes(1);

        fresh.destroy();
    });

    it('REPORTS a stale binding instead of looking healthy', () => {
        // The point of checkBindings(): before it existed, this state was
        // indistinguishable from a healthy one. Every presence check passed
        // (#importBook is right there in the document) while the handler sat
        // on the detached node, so the e2e failure could only say "the form
        // never opened" and the registry cheerfully reported ACTIVE.
        expect(manager.checkBindings()).toEqual([]);

        swapBody();

        const stale = manager.checkBindings();
        const ids = stale.map((s) => s.id);
        expect(ids).toContain('importBook');
        expect(ids).toContain('createNewBook');
        // 'detached-but-present' is the whole diagnosis in one word: OUR node
        // is gone, but a live #importBook is sitting right there in its place.
        // That is why every presence check passed while the button was dead.
        expect(stale.find((s) => s.id === 'importBook').reason).toBe('detached-but-present');

        // ...and a rebind clears the report.
        manager.button = document.getElementById('newBookButton');
        manager.rebindElements();
        expect(manager.checkBindings()).toEqual([]);
    });

    it('survives repeated swap→rebind cycles', () => {
        for (let i = 0; i < 3; i++) {
            swapBody();
            manager.button = document.getElementById('newBookButton');
            manager.rebindElements();

            document.getElementById('importBook').click();
            expect(document.getElementById('cite-form'), `cycle ${i}`).not.toBeNull();
        }
    });
});
