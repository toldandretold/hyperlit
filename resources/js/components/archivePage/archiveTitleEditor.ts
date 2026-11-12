/**
 * The archive page's title, editable in place during userPageEditor's edit
 * mode — the archive counterpart of userProfileEditor's library-title editor.
 *
 * An owner-minted archive's title IS its shelf's name (ArchiveIdentity), so
 * it saves with one PATCH /api/shelves/{id} when edit mode ends. The URL never
 * changes (archive slugs are set once; renaming only moves the shelf's slug).
 * Enter ends the line; Escape reverts it.
 */

import { log } from '../../utilities/logger';

interface ArchiveEditSeed {
    shelfId: string;
    name: string;
    mediaBook?: string;
}

let current: ArchiveEditSeed | null = null;
let keyHandler: ((e: KeyboardEvent) => void) | null = null;

const titleEl = (): HTMLElement | null => document.getElementById('archiveTitle');

/** The archive seed the blade renders for the OWNER only (null elsewhere). */
export function readArchiveEditSeed(): ArchiveEditSeed | null {
    const holder = document.querySelector<HTMLElement>('#bottom-right-buttons[data-archive-edit]');
    if (!holder) return null;
    try {
        const seed = JSON.parse(holder.dataset.archiveEdit || 'null') as ArchiveEditSeed | null;
        return seed?.shelfId ? seed : null;
    } catch {
        return null;
    }
}

function getXsrf(): string {
    return decodeURIComponent(document.cookie.match(/XSRF-TOKEN=([^;]+)/)?.[1] || '');
}

async function saveName(seed: ArchiveEditSeed, name: string): Promise<void> {
    try {
        const resp = await fetch(`/api/shelves/${seed.shelfId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'X-XSRF-TOKEN': getXsrf() },
            credentials: 'include',
            body: JSON.stringify({ name: name.slice(0, 255) }),
        });
        const data = await resp.json().catch(() => ({})) as { error?: string };
        if (!resp.ok) throw new Error(data.error || `Save failed (${resp.status})`);
        const old = seed.name;
        seed.name = name;
        if (document.title.startsWith(old)) document.title = name + document.title.slice(old.length);
    } catch (error) {
        log.error('Archive title save failed', '/components/archivePage/archiveTitleEditor.ts', error as Error);
        const t = titleEl();
        if (t) t.textContent = seed.name;
        void import('../dialog/dialog').then(({ alertDialog }) =>
            alertDialog({ title: 'Save failed', message: error instanceof Error ? error.message : 'Could not save the title.' }));
    }
}

/** Turn in-place title editing on/off; turning it off saves a changed name. */
export function setArchiveTitleEditing(on: boolean, seed: ArchiveEditSeed | null): Promise<void> {
    const title = titleEl();
    if (!title || !seed) return Promise.resolve();

    if (on) {
        current = seed;
        title.textContent = seed.name;
        title.setAttribute('contenteditable', 'plaintext-only');
        if (title.contentEditable !== 'plaintext-only') title.setAttribute('contenteditable', 'true');
        title.classList.add('editable-field');
        title.setAttribute('aria-label', 'Archive title (your shelf name)');
        if (!keyHandler) {
            keyHandler = (e: KeyboardEvent) => {
                if (e.target !== titleEl() || !current) return;
                if (e.key === 'Enter') { e.preventDefault(); titleEl()?.blur(); }
                if (e.key === 'Escape') {
                    // Revert the title only — stop userPageEditor's Escape from
                    // also leaving edit mode mid-correction.
                    e.preventDefault();
                    e.stopPropagation();
                    const t = titleEl();
                    if (t) t.textContent = current.name;
                }
            };
            document.addEventListener('keydown', keyHandler, true);
        }
        return Promise.resolve();
    }

    title.removeAttribute('contenteditable');
    title.removeAttribute('aria-label');
    title.classList.remove('editable-field');
    if (keyHandler) document.removeEventListener('keydown', keyHandler, true);
    keyHandler = null;
    current = null;

    const name = (title.textContent ?? '').replace(/\s+/g, ' ').trim();
    if (!name) { title.textContent = seed.name; return Promise.resolve(); }
    title.textContent = name;
    return name === seed.name ? Promise.resolve() : saveName(seed, name);
}
