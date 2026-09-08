/**
 * The user page's About BOOK (`{sanitized}About`) — a real book rendered
 * inline in the hero's .welcome-copy section (#user-about-book), hydrated
 * from IndexedDB and editable IN PLACE with the full editToolbar/divEditor
 * stack. The editor stack is container-agnostic: everything binds via the
 * container's data-book-id and explicit bookId arguments, so no reader, no
 * .main-content, no current-book switch (`setCurrentBook` is never called —
 * every save path here passes the About id explicitly).
 *
 * Edit ceremony = the hyperlitContainer sub-book editor's, verbatim
 * (hyperlitContainer/editMode.ts): contentEditable BEFORE startObserving on
 * enter; flush → stopObserving → integrity sweep → contentEditable=false on
 * exit (the reversed order avoids the browser-normalization phantom-mutation
 * batch). Driven by userPageEditor's pencil mode.
 */

import { log, verbose } from '../../utilities/logger';
import { asBookId, type BookId } from '../../utilities/idHelpers';

const CONTAINER_ID = 'user-about-book';

let editingAbout = false;
let previousIsEditing = false;

export function aboutBookContainer(): HTMLElement | null {
    return document.getElementById(CONTAINER_ID);
}

export function aboutBookId(): BookId | null {
    const raw = aboutBookContainer()?.dataset.bookId;
    return raw ? asBookId(raw) : null;
}

/**
 * Re-render the server-painted About book from IndexedDB (fresh pull), which
 * applies stored hyperlights/hypercites and normalizes the DOM into the
 * editor's expected shape, then attaches annotation listeners. Safe for
 * owner AND visitor; no-op when the container/book is absent.
 */
export async function hydrateAboutBook(): Promise<void> {
    const container = aboutBookContainer();
    const bookId = aboutBookId();
    if (!container || !bookId) return;

    try {
        const { syncBookDataFromDatabase } = await import('../../indexedDB/serverSync/index');
        await syncBookDataFromDatabase(bookId);
        // Container may have been swapped away by SPA nav during the await
        if (!document.getElementById(CONTAINER_ID)) return;

        const { getNodesFromIndexedDB } = await import('../../indexedDB/index');
        const nodes: any = await getNodesFromIndexedDB(bookId);
        if (!nodes || nodes.length === 0) return;

        const { rebuildNodeArrays }: any = await import('../../indexedDB/hydration/rebuild');
        await rebuildNodeArrays(nodes);

        const { createChunkElement }: any = await import('../../lazyLoader/chunkRender');
        const { attachMarkListeners }: any = await import('../../hyperlights/index');
        const { attachUnderlineClickListeners }: any = await import('../../hypercites/index');

        const byChunk: Record<string, any[]> = {};
        for (const n of nodes) {
            (byChunk[n.chunk_id] ??= []).push(n);
        }
        container.innerHTML = '';
        for (const chunkNodes of Object.values(byChunk)) {
            const chunkEl = createChunkElement(chunkNodes, { bookId });
            if (chunkEl) {
                container.appendChild(chunkEl);
                attachMarkListeners(chunkEl);
                attachUnderlineClickListeners(chunkEl);
            }
        }
        verbose.content(`About book hydrated (${nodes.length} nodes)`, '/components/userProfile/userAboutBook.ts');
    } catch (error) {
        // Server-rendered HTML remains — hydration is an enhancement.
        log.error('About book hydration failed', '/components/userProfile/userAboutBook.ts', error);
    }
}

/** Whether inline About editing is currently engaged. */
export function isAboutEditing(): boolean {
    return editingAbout;
}

/** Enter inline edit mode on the About book (owner pencil). */
export async function enterAboutEdit(): Promise<void> {
    const container = aboutBookContainer();
    const bookId = aboutBookId();
    if (!container || !bookId || editingAbout) return;

    editingAbout = true;
    previousIsEditing = Boolean((window as any).isEditing);

    // Order matters: contentEditable BEFORE startObserving (editMode.ts:132)
    container.contentEditable = 'true';
    (window as any).isEditing = true;

    const { startObserving } = await import('../../divEditor/index');
    await startObserving(container, bookId as any);

    if (!container.dataset.pasteAttached) {
        const { addPasteListener }: any = await import('../../paste/index');
        addPasteListener(container);
        container.dataset.pasteAttached = 'true';
    }

    const { addImageDropListener }: any = await import('../../divEditor/imageDrop/index');
    addImageDropListener(container, bookId);

    const { getEditToolbar, initEditToolbar }: any = await import('../../editToolbar/index');
    if (!getEditToolbar()) {
        // viewManager only builds the toolbar on reader pages — build it here
        // targeted at the About container.
        initEditToolbar({
            toolbarId: 'edit-toolbar',
            editableSelector: `#${CONTAINER_ID}[contenteditable='true']`,
            currentBookId: bookId,
        });
    }
    getEditToolbar()?.setBookId(bookId);
    getEditToolbar()?.setEditMode(true);

    const { placeCursorAtEnd }: any = await import('../../hyperlitContainer/editMode');
    const lastNode = container.querySelector('.chunk')?.lastElementChild;
    if (lastNode) placeCursorAtEnd(lastNode);
    container.focus();
}

/** Exit inline edit mode: flush saves, verify integrity, restore state. */
export async function exitAboutEdit(): Promise<void> {
    const container = aboutBookContainer();
    const bookId = aboutBookId();
    if (!editingAbout) return;
    editingAbout = false;

    try {
        const { flushInputDebounce, flushAllPendingSaves, stopObserving } = await import('../../divEditor/index');
        flushInputDebounce();
        await flushAllPendingSaves();

        // Push queued syncs before teardown (bounded — a slow network must
        // not wedge the pencil).
        try {
            const { debouncedMasterSync }: any = await import('../../indexedDB/syncQueue/master');
            await Promise.race([
                debouncedMasterSync.flush(),
                new Promise((resolve) => setTimeout(resolve, 5000)),
            ]);
        } catch { /* sync flush is best-effort here */ }

        await stopObserving();

        if (container && bookId) {
            const { runIntegritySweep }: any = await import('../../integrity/verifier');
            await runIntegritySweep(bookId, container, 'user-about-edit-off');
        }
    } catch (error) {
        log.error('About edit teardown failed', '/components/userProfile/userAboutBook.ts', error);
    } finally {
        // AFTER stopObserving — flipping earlier fires browser text-node
        // normalization as phantom childList mutations into a live observer.
        container?.setAttribute('contenteditable', 'false');
        const { getEditToolbar }: any = await import('../../editToolbar/index');
        getEditToolbar()?.setEditMode(false);
        (window as any).isEditing = previousIsEditing;
    }
}
