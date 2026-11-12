/**
 * "View as archive" — the shelf header button that gives an owner's PUBLIC
 * shelf a global /a/{slug} archive page (the same hero page maintainer
 * archives use; see ArchivePageController + ShelfArchiveMinter).
 *
 * The slug is SET ONCE, like a book slug: there is no slug history or redirect
 * server-side, so the first click opens an inline URL picker (prefilled with
 * the server's suggestion, live-checked for availability) and confirming makes
 * that address permanent. Every later click just goes to the page.
 *
 * Inline row, not a modal — no focus trap / overlay inventory needed; Escape
 * and Cancel collapse it.
 */

import { log } from '../../utilities/logger';

// The #archiveRef glyph (partials/archive-ref.blade.php) minus its backing
// rect, so the shelf button reads as the same "archive" the hero pages show.
export const ARCHIVE_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 503.23 309.68" aria-hidden="true">'
    + '<path d="M503.23,219.35c0-35.07-20.41-66.75-51.68-81.56C449.35,61.43,386.55,0,309.68,0c-54.39,0-103.11,30.53-127.01,78.67-4.94-.84-9.92-1.25-14.93-1.25-35.1,0-66.79,20.43-81.57,51.7C38.28,131.3,0,170.94,0,219.35s40.53,90.32,90.32,90.32h322.58c49.79,0,90.32-40.52,90.32-90.32ZM25.81,219.35c0-35.57,28.94-64.52,64.52-64.52.8,0,1.57.06,2.36.12l11.02.67,3.21-9.2c9.06-25.83,33.51-43.2,60.83-43.2,6.28,0,12.55.93,18.61,2.76l11.28,3.39,4.41-10.92c17.86-44.14,60.09-72.66,107.64-72.66,64.04,0,116.13,52.1,116.13,116.13l-.54,13.46,8.94,3.14c25.85,9.06,43.21,33.51,43.21,60.83,0,35.57-28.94,64.52-64.52,64.52H90.32c-35.57,0-64.52-28.94-64.52-64.52Z"/>'
    + '<path d="M247.54,243.04h-67.31v-51.84c0-19.08,3.97-34.15,11.92-45.19,7.94-11.04,21.56-20.79,40.85-29.25l14.55,27.54c-11.86,5.57-20.07,11.12-24.6,16.64-4.54,5.52-7.07,12.05-7.58,19.58h32.19v62.52ZM326,243.04h-67.31v-51.84c0-19.08,3.97-34.15,11.92-45.19,7.94-11.04,21.56-20.79,40.85-29.25l14.55,27.54c-11.86,5.57-20.07,11.12-24.6,16.64-4.54,5.52-7.07,12.05-7.58,19.58h32.19v62.52Z"/>'
    + '</svg>';

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SLUG_MAX = 100;
const CHECK_DEBOUNCE_MS = 300;

interface ArchiveStatus {
    exists: boolean;
    slug?: string;
    url?: string;
    suggestion?: string;
    valid?: boolean;
    available?: boolean;
    error?: string;
}

interface CreateResult {
    slug?: string;
    url?: string;
    error?: string;
    suggestion?: string;
}

export interface ShelfArchiveButton {
    el: HTMLButtonElement;
    /** Show only while the shelf is public (call from the visibility toggle). */
    setVisibility(visibility: string): void;
    destroy(): void;
}

function getXsrf(): string {
    return decodeURIComponent(document.cookie.match(/XSRF-TOKEN=([^;]+)/)?.[1] || '');
}

/** Normalise free typing toward a valid slug (lowercase, hyphens, no doubles). */
export function slugifyInput(raw: string): string {
    return raw
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, '-')
        .replace(/-{2,}/g, '-')
        .replace(/^-+/, '')
        .slice(0, SLUG_MAX);
}

async function fetchStatus(shelfId: string, slug?: string, signal?: AbortSignal): Promise<ArchiveStatus> {
    const qs = slug ? `?slug=${encodeURIComponent(slug)}` : '';
    const resp = await fetch(`/api/shelves/${shelfId}/archive${qs}`, {
        headers: { 'Accept': 'application/json', 'X-XSRF-TOKEN': getXsrf() },
        credentials: 'include',
        signal,
    });
    const data = await resp.json() as ArchiveStatus;
    if (!resp.ok) {
        return { exists: false, error: data.error || `Request failed (${resp.status})` };
    }
    return data;
}

async function postCreate(shelfId: string, slug: string): Promise<CreateResult> {
    const resp = await fetch(`/api/shelves/${shelfId}/archive`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'X-XSRF-TOKEN': getXsrf() },
        credentials: 'include',
        body: JSON.stringify({ slug }),
    });
    const data = await resp.json() as CreateResult;
    if (!resp.ok && !data.error) data.error = `Request failed (${resp.status})`;
    return data;
}

/** Overridable in tests (happy-dom can't navigate). */
export const navigation = {
    go(url: string): void { window.location.assign(url); },
};

/**
 * Build the button. `mountPicker` receives the inline picker row so the header
 * decides where it sits (under the title row).
 */
export function createShelfArchiveButton(opts: {
    shelfId: string;
    visibility: string;
    mountPicker: (row: HTMLElement) => void;
}): ShelfArchiveButton {
    const { shelfId, mountPicker } = opts;
    let knownUrl: string | null = null;
    let picker: HTMLElement | null = null;
    let checkTimer: ReturnType<typeof setTimeout> | null = null;
    let checkAbort: AbortController | null = null;
    let busy = false;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'shelf-header-archive-btn';
    btn.title = 'View as archive';
    btn.setAttribute('aria-label', 'View as archive');
    btn.innerHTML = ARCHIVE_SVG;

    function closePicker(): void {
        if (checkTimer) clearTimeout(checkTimer);
        checkAbort?.abort();
        checkTimer = null;
        checkAbort = null;
        picker?.remove();
        picker = null;
        btn.setAttribute('aria-expanded', 'false');
    }

    function openPicker(suggestion: string): void {
        closePicker();
        const row = document.createElement('div');
        row.className = 'shelf-header-archive-picker';
        row.setAttribute('role', 'group');
        row.setAttribute('aria-label', 'Choose this archive’s address');

        const label = document.createElement('label');
        label.className = 'shelf-archive-url';
        const prefix = document.createElement('span');
        prefix.className = 'shelf-archive-prefix';
        prefix.textContent = `${window.location.host}/a/`;
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'shelf-archive-slug-input';
        input.value = suggestion;
        input.maxLength = SLUG_MAX;
        input.spellcheck = false;
        input.autocomplete = 'off';
        input.setAttribute('aria-label', 'Archive address');
        label.append(prefix, input);

        const status = document.createElement('span');
        status.className = 'shelf-archive-status';
        status.setAttribute('aria-live', 'polite');
        status.textContent = 'Available';
        status.dataset.state = 'ok';

        const create = document.createElement('button');
        create.type = 'button';
        create.className = 'shelf-archive-create';
        create.textContent = 'Create archive';

        const cancel = document.createElement('button');
        cancel.type = 'button';
        cancel.className = 'shelf-archive-cancel';
        cancel.textContent = 'Cancel';

        const note = document.createElement('p');
        note.className = 'shelf-archive-note';
        note.textContent = 'This address is permanent — it can’t be changed later. The archive page takes its title from the shelf name.';

        row.append(label, status, create, cancel, note);

        const setStatus = (state: 'ok' | 'bad' | 'checking', text: string) => {
            status.dataset.state = state;
            status.textContent = text;
            create.disabled = state !== 'ok' || busy;
        };

        const check = () => {
            if (!row.isConnected) return; // header was torn down mid-debounce
            const slug = input.value;
            if (!SLUG_RE.test(slug)) {
                setStatus('bad', 'Letters, numbers and single hyphens only');
                return;
            }
            setStatus('checking', 'Checking…');
            checkAbort?.abort();
            checkAbort = new AbortController();
            fetchStatus(shelfId, slug, checkAbort.signal)
                .then((s) => {
                    if (input.value !== slug || !row.isConnected) return; // stale answer
                    if (s.exists && s.url) { knownUrl = s.url; navigation.go(s.url); return; }
                    if (s.error) { setStatus('bad', s.error); return; }
                    setStatus(s.available ? 'ok' : 'bad', s.available ? 'Available' : 'Taken');
                })
                .catch((err: unknown) => {
                    if ((err as { name?: string })?.name === 'AbortError') return;
                    log.error('Archive slug check failed', '/components/shelves/shelfArchiveButton.ts', err as Error);
                    setStatus('bad', 'Couldn’t check — try again');
                });
        };

        input.addEventListener('input', () => {
            const cleaned = slugifyInput(input.value);
            if (cleaned !== input.value) input.value = cleaned;
            if (checkTimer) clearTimeout(checkTimer);
            setStatus('checking', 'Checking…');
            checkTimer = setTimeout(check, CHECK_DEBOUNCE_MS);
        });

        const submit = async () => {
            if (create.disabled) return;
            busy = true;
            create.disabled = true;
            create.textContent = 'Creating…';
            try {
                const result = await postCreate(shelfId, input.value);
                if (result.url) {
                    knownUrl = result.url;
                    navigation.go(result.url);
                    return;
                }
                if (result.suggestion && result.error) {
                    setStatus('bad', `${result.error} Try ${result.suggestion}`);
                } else {
                    setStatus('bad', result.error || 'Couldn’t create the archive');
                }
            } catch (err) {
                log.error('Archive create failed', '/components/shelves/shelfArchiveButton.ts', err as Error);
                setStatus('bad', 'Couldn’t create the archive — try again');
            } finally {
                busy = false;
                create.textContent = 'Create archive';
                if (status.dataset.state === 'ok') create.disabled = false;
            }
        };

        create.addEventListener('click', submit);
        cancel.addEventListener('click', () => { closePicker(); btn.focus(); });
        row.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') { e.preventDefault(); closePicker(); btn.focus(); }
            if (e.key === 'Enter' && e.target === input) { e.preventDefault(); void submit(); }
        });

        picker = row;
        btn.setAttribute('aria-expanded', 'true');
        mountPicker(row);
        input.focus();
        input.select();
    }

    btn.addEventListener('click', async () => {
        if (knownUrl) { navigation.go(knownUrl); return; }
        if (picker) { closePicker(); return; }
        btn.disabled = true;
        try {
            const s = await fetchStatus(shelfId);
            if (s.exists && s.url) { knownUrl = s.url; navigation.go(s.url); return; }
            if (s.error) { btn.title = s.error; return; }
            openPicker(s.suggestion || '');
        } catch (err) {
            log.error('Archive status failed', '/components/shelves/shelfArchiveButton.ts', err as Error);
        } finally {
            btn.disabled = false;
        }
    });

    const api: ShelfArchiveButton = {
        el: btn,
        setVisibility(visibility: string) {
            const show = visibility === 'public';
            btn.style.display = show ? '' : 'none';
            if (!show) closePicker();
        },
        destroy() { closePicker(); btn.remove(); },
    };
    api.setVisibility(opts.visibility);
    return api;
}
