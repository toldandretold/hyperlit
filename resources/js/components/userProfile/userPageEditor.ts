/**
 * User-page customization editor (/u/{username}, owner only).
 *
 * The pencil (#editButton inside #bottom-right-buttons — the reader's exact
 * markup/styling, positioned + tap-toggled by togglePerimeterButtons; the
 * reader's book-edit component never attaches on 'user' pages, rendered only
 * for the owner) toggles
 * page-edit mode: body.user-page-editing. While on:
 *   - the inline title/bio editors engage (userProfileEditor
 *     setUserProfileEditingEnabled — they save via the library upsert seam);
 *   - the about section (#user-about-content) becomes contenteditable and
 *     saves through PUT /api/user-home/page-settings (server sanitizes; the
 *     response's canonical HTML is re-rendered when it differs);
 *   - a floating palette (#user-page-edit-panel) offers logo/background image
 *     swap (uploadBookImage — the user-home book IS a book, so the standard
 *     media store/serving applies), curated color/font/size vars, and resets;
 *   - dropping an image on the logo lockup swaps the logo. The drag handlers
 *     run in DOCUMENT CAPTURE phase and stopPropagation while edit mode is on,
 *     so fileDropTarget's page-level import overlay (window bubble listeners)
 *     never fires mid-customization.
 *
 * Every change PUTs a partial page_settings patch (the server merges + the
 * validator enforces the value grammar) and applies live via CSS vars on
 * #app-container / a DOM swap of the lockup. Escape exits edit mode (a
 * stacked modal's focus trap swallows Escape first, so this never steals it).
 *
 * The palette is a NON-modal floating toolbar by design — the whole point of
 * the mode is editing the page behind it, so no focus trap; Escape and Done
 * both close it and return focus to the pencil.
 */

import { book } from '../../app';
import { log } from '../../utilities/logger';
import { ensureCsrfToken } from '../../utilities/auth/csrf';
import { uploadBookImage, isInsertableImageFile } from '../../utilities/bookImageUpload';
import { setUserProfileEditingEnabled } from './userProfileEditor';

interface PageSettings {
    logo_image?: string | null;
    background_image?: string | null;
    /** Curated visitor pills (shelf UUIDs); null/absent = all public shelves */
    pill_shelves?: string[] | null;
    about_html?: string | null;
}

interface PublicShelf {
    id: string;
    name: string;
}

let active = false;
let panelEl: HTMLElement | null = null;
let fileInputEl: HTMLInputElement | null = null;
let pendingImageKey: 'logo_image' | 'background_image' = 'logo_image';
let clickHandler: ((e: Event) => void) | null = null;
let keyHandler: ((e: KeyboardEvent) => void) | null = null;
let dragHandler: ((e: DragEvent) => void) | null = null;
let dropHandler: ((e: DragEvent) => void) | null = null;
let aboutInputHandler: (() => void) | null = null;
let aboutSaveTimer = 0;
let aboutDirty = false;
let originalColonHtml = '';
let settings: PageSettings = {};

const appContainer = (): HTMLElement | null => document.getElementById('app-container');
const lockupLink = (): HTMLElement | null => document.querySelector('.user-logo-lockup .journal-colon-link');
const aboutContent = (): HTMLElement | null => document.getElementById('user-about-content');

/* ── persistence ─────────────────────────────────────────────────────── */

async function putSettings(patch: Partial<PageSettings>): Promise<PageSettings | null> {
    try {
        const csrfToken = await ensureCsrfToken();
        if (!csrfToken) throw new Error('Not authenticated');
        const response = await fetch('/api/user-home/page-settings', {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'X-XSRF-TOKEN': csrfToken,
            },
            credentials: 'include',
            body: JSON.stringify(patch),
        });
        if (!response.ok) {
            const data = (await response.json().catch(() => ({}))) as { error?: string };
            throw new Error(data.error ?? `Save failed (${response.status})`);
        }
        const data = (await response.json()) as { page_settings: PageSettings };
        settings = data.page_settings ?? {};
        (window as unknown as { userPageSettings?: PageSettings }).userPageSettings = settings;
        return settings;
    } catch (error) {
        log.error('User page settings save failed', '/components/userProfile/userPageEditor.ts', error);
        void import('../dialog/dialog').then(({ alertDialog }) =>
            alertDialog({ title: 'Save failed', message: error instanceof Error ? error.message : 'Could not save your page settings.' }));
        return null;
    }
}

/* ── live application ────────────────────────────────────────────────── */

function applyLogo(filename: string | null): void {
    const link = lockupLink();
    if (!link) return;
    if (filename) {
        const img = document.createElement('img');
        img.className = 'journal-colon user-page-logo';
        img.alt = '';
        img.src = `/${book}/media/${filename}`;
        link.replaceChildren(img);
    } else if (originalColonHtml) {
        link.innerHTML = originalColonHtml;
    }
}

function applyBackground(filename: string | null): void {
    const container = appContainer();
    if (!container) return;
    if (filename) {
        // ABSOLUTE url: a relative url() in a custom property resolves against
        // the stylesheet consuming the var (the vite origin in dev), not the page.
        container.style.setProperty('--up-bg-image', `url('${window.location.origin}/${book}/media/${filename}')`);
    } else {
        container.style.removeProperty('--up-bg-image');
    }
}

/* ── image flows ─────────────────────────────────────────────────────── */

/** Logos are square, LOGO_SIDE px, baked into the pixels at upload (no fit
 *  settings to store, display stays trivial); backgrounds are capped to
 *  BG_MAX_EDGE on the long edge. Both re-encodes also solve the raw-bytes
 *  problem (a 9MB phone photo must never be served to every visitor). */
const LOGO_SIDE = 512;
const BG_MAX_EDGE = 2560;

function canvasToPngFile(canvas: HTMLCanvasElement, name: string): Promise<File> {
    return new Promise((resolve, reject) => {
        canvas.toBlob(
            (blob) => blob ? resolve(new File([blob], name, { type: 'image/png' })) : reject(new Error('Could not process the image')),
            'image/png',
        );
    });
}

/**
 * Normalize an upload for its slot. Logos: square canvas — near-square inputs
 * center-crop silently; skewed ones ask the owner "crop or fit". Backgrounds:
 * downscale to a sane long edge. SVGs pass through untouched (vector, tiny).
 */
async function normalizeImage(key: 'logo_image' | 'background_image', file: File): Promise<File | null> {
    if (file.name.toLowerCase().endsWith('.svg')) return file;

    let bitmap: ImageBitmap;
    try {
        bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch {
        return file; // undecodable here — let the server-side pipeline decide
    }
    const { width: w, height: h } = bitmap;

    try {
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        if (!ctx) return file;

        if (key === 'background_image') {
            const scale = Math.min(1, BG_MAX_EDGE / Math.max(w, h));
            if (scale === 1 && file.size < 1_500_000) return file; // already sane
            canvas.width = Math.round(w * scale);
            canvas.height = Math.round(h * scale);
            ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
            return await canvasToPngFile(canvas, 'background.png');
        }

        // Logo → square. Within ~8% of square: silent center-crop. Otherwise
        // the owner picks: crop (cover, center) or fit (contain, transparent
        // padding) — "too lazy to crop manually" is the expected case. Both
        // options carry a live thumbnail DEMO rendered from this very image.
        const drawSquare = (target: HTMLCanvasElement, side: number, squareMode: 'crop' | 'fit'): void => {
            target.width = side;
            target.height = side;
            const c = target.getContext('2d');
            if (!c) return;
            if (squareMode === 'crop') {
                const src = Math.min(w, h);
                c.drawImage(bitmap, (w - src) / 2, (h - src) / 2, src, src, 0, 0, side, side);
            } else {
                const scale = side / Math.max(w, h);
                const dw = w * scale;
                const dh = h * scale;
                c.drawImage(bitmap, (side - dw) / 2, (side - dh) / 2, dw, dh);
            }
        };

        const ratio = Math.max(w, h) / Math.min(w, h);
        let mode: 'crop' | 'fit' = 'crop';
        if (ratio > 1.08) {
            const demo = (squareMode: 'crop' | 'fit'): string => {
                const preview = document.createElement('canvas');
                drawSquare(preview, 96, squareMode);
                return preview.toDataURL('image/png');
            };
            const { choiceDialog } = await import('../dialog/dialog');
            const choice = await choiceDialog({
                title: 'Make it square',
                message: 'Your logo image isn’t square. How should it fit the square logo slot?',
                options: [
                    { value: 'crop', label: 'Auto-crop', description: 'Fill the square with the image’s center — edges are trimmed.', previewSrc: demo('crop') },
                    { value: 'fit', label: 'Auto-zoom out', description: 'Shrink the whole image into the square — transparent bars fill the rest.', previewSrc: demo('fit') },
                ],
            });
            if (choice === null) return null; // cancelled — no upload
            mode = choice === 'fit' ? 'fit' : 'crop';
        }

        drawSquare(canvas, LOGO_SIDE, mode);
        return await canvasToPngFile(canvas, 'logo.png');
    } finally {
        bitmap.close();
    }
}

async function uploadAndSet(key: 'logo_image' | 'background_image', file: File): Promise<void> {
    if (!isInsertableImageFile(file)) {
        void import('../dialog/dialog').then(({ alertDialog }) =>
            alertDialog({ title: 'Unsupported file', message: `"${file.name}" is not a supported image type (jpg, png, gif, webp, svg).` }));
        return;
    }
    try {
        const prepared = await normalizeImage(key, file);
        if (!prepared) return; // owner cancelled the crop/fit choice
        const uploaded = await uploadBookImage(book, prepared);
        const saved = await putSettings({ [key]: uploaded.filename });
        if (!saved) return;
        if (key === 'logo_image') applyLogo(uploaded.filename);
        else applyBackground(uploaded.filename);
    } catch (error) {
        log.error('User page image upload failed', '/components/userProfile/userPageEditor.ts', error);
        void import('../dialog/dialog').then(({ alertDialog }) =>
            alertDialog({ title: 'Upload failed', message: error instanceof Error ? error.message : 'Could not upload the image.' }));
    }
}

async function resetImage(key: 'logo_image' | 'background_image'): Promise<void> {
    const saved = await putSettings({ [key]: null });
    if (!saved) return;
    if (key === 'logo_image') applyLogo(null);
    else applyBackground(null);
}

/* ── about editing ───────────────────────────────────────────────────── */

function flushAboutSave(): void {
    window.clearTimeout(aboutSaveTimer);
    aboutSaveTimer = 0;
    if (!aboutDirty) return;
    aboutDirty = false;
    const el = aboutContent();
    if (!el) return;
    const html = el.innerHTML;
    void putSettings({ about_html: html }).then((saved) => {
        if (!saved) return;
        const canonical = saved.about_html ?? '';
        // Re-render the server-sanitized form, but never under the caret.
        if (canonical !== html && !el.contains(document.activeElement) && document.activeElement !== el) {
            el.innerHTML = canonical;
        }
    });
}

function engageAboutEditing(): void {
    const el = aboutContent();
    if (!el) return;
    el.contentEditable = 'true';
    el.classList.add('editable-field');
    aboutInputHandler = () => {
        aboutDirty = true;
        window.clearTimeout(aboutSaveTimer);
        aboutSaveTimer = window.setTimeout(flushAboutSave, 2000);
    };
    el.addEventListener('input', aboutInputHandler);
    el.addEventListener('blur', flushAboutSave);
}

function releaseAboutEditing(): void {
    const el = aboutContent();
    flushAboutSave();
    if (el) {
        el.setAttribute('contenteditable', 'false');
        el.classList.remove('editable-field');
        if (aboutInputHandler) el.removeEventListener('input', aboutInputHandler);
        el.removeEventListener('blur', flushAboutSave);
    }
    aboutInputHandler = null;
}

/* ── the palette ─────────────────────────────────────────────────────── */

function escapeHtml(v: string): string {
    return v.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

function buildPanel(): HTMLElement {
    const panel = document.createElement('div');
    panel.id = 'user-page-edit-panel';
    panel.className = 'user-page-edit-panel hidden';
    // Visitor-pill curation: the owner's PUBLIC shelves (server-injected).
    // Checked = shown. No curation saved yet = everything checked (the
    // default); untick to hide; unticking all = no pills.
    const shelves = ((window as unknown as { publicShelves?: PublicShelf[] }).publicShelves) ?? [];
    const curated = settings.pill_shelves; // undefined/null = never curated
    const isChecked = (id: string): boolean => curated == null || curated.includes(id);
    const shelvesHtml = shelves.length
        ? `
      <div class="upe-heading upe-shelves-heading">Visitor shelf pills</div>
      <p class="upe-hint">Ticked shelves show as tabs for visitors — untick to hide.</p>
      <div class="upe-shelves">
        ${shelves.map(s => `
          <label class="upe-shelf">
            <input type="checkbox" data-pill-shelf="${escapeHtml(s.id)}"${isChecked(s.id) ? ' checked' : ''}>
            <span>${escapeHtml(s.name)}</span>
          </label>`).join('')}
      </div>`
        : '';
    panel.innerHTML = `
      <div class="upe-heading">Customize your page</div>
      <div class="upe-row upe-image-row">
        <span class="upe-label">Logo</span>
        <button type="button" class="upe-btn" data-image-pick="logo_image">Swap image</button>
        <button type="button" class="upe-btn upe-btn-quiet" data-image-reset="logo_image">Reset</button>
      </div>
      <div class="upe-row upe-image-row">
        <span class="upe-label">Background</span>
        <button type="button" class="upe-btn" data-image-pick="background_image">Set image</button>
        <button type="button" class="upe-btn upe-btn-quiet" data-image-reset="background_image">Reset</button>
      </div>
      ${shelvesHtml}
      <p class="upe-hint">Your title and the about text below are editable in place — click them and type. Tap the logo (or drop an image on it) to swap it.</p>
      <button type="button" class="upe-btn upe-done" data-done>Done</button>
    `;
    document.body.appendChild(panel);
    return panel;
}

/* ── logo badge (THE mobile path: tap the badge/logo → picker) ───────── */

function addLogoBadge(): void {
    const link = lockupLink();
    if (!link || link.querySelector('.upe-logo-badge')) return;
    const badge = document.createElement('button');
    badge.type = 'button';
    badge.className = 'upe-logo-badge';
    badge.setAttribute('aria-label', 'Swap the logo image');
    badge.title = 'Swap the logo image';
    badge.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/><circle cx="12" cy="13" r="3"/></svg>`;
    link.appendChild(badge);
}

function removeLogoBadge(): void {
    lockupLink()?.querySelector('.upe-logo-badge')?.remove();
}

function ensureFileInput(): HTMLInputElement {
    if (fileInputEl) return fileInputEl;
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.hidden = true;
    input.addEventListener('change', () => {
        const file = input.files?.[0];
        input.value = '';
        if (file) void uploadAndSet(pendingImageKey, file);
    });
    document.body.appendChild(input);
    fileInputEl = input;
    return input;
}

/* ── mode toggle ─────────────────────────────────────────────────────── */

function enterEditMode(): void {
    if (active) return;
    active = true;
    document.body.classList.add('user-page-editing');
    // .inverted = the reader edit button's "editing" look (buttonIcons.css)
    document.getElementById('editButton')?.classList.add('inverted');
    setUserProfileEditingEnabled(true);
    engageAboutEditing();
    addLogoBadge();
    // Rebuild each entry: the shelf list / checked state may have changed.
    panelEl?.remove();
    panelEl = buildPanel();
    panelEl.classList.remove('hidden');
}

function exitEditMode(): void {
    if (!active) return;
    active = false;
    document.body.classList.remove('user-page-editing');
    const pencil = document.getElementById('editButton');
    pencil?.classList.remove('inverted');
    setUserProfileEditingEnabled(false);
    releaseAboutEditing();
    removeLogoBadge();
    panelEl?.classList.add('hidden');
    pencil?.focus();
}

/* ── lifecycle (ButtonRegistry) ──────────────────────────────────────── */

export function initUserPageEditor(): void {
    const pencil = document.getElementById('editButton');
    if (!pencil) return; // visitor — the blade didn't render the button

    settings = ((window as unknown as { userPageSettings?: PageSettings }).userPageSettings) ?? {};
    // Capture the pristine colon markup once per page DOM so logo resets can
    // restore it (a custom logo replaces the svg wholesale).
    const link = lockupLink();
    if (link && !link.querySelector('.user-page-logo')) {
        originalColonHtml = link.innerHTML;
    }

    if (clickHandler) {
        // SPA re-init: fresh DOM, stale mode — start clean.
        active = false;
        document.body.classList.remove('user-page-editing');
        panelEl?.classList.add('hidden');
        return;
    }

    clickHandler = (e: Event) => {
        const target = e.target instanceof Element ? e.target : null;
        if (!target) return;
        if (target.closest('#editButton')) {
            if (active) exitEditMode();
            else enterEditMode();
            return;
        }
        if (!active || !panelEl) return;
        const pick = target.closest<HTMLElement>('[data-image-pick]');
        if (pick) {
            pendingImageKey = pick.dataset.imagePick as 'logo_image' | 'background_image';
            ensureFileInput().click();
            return;
        }
        const reset = target.closest<HTMLElement>('[data-image-reset]');
        if (reset) {
            void resetImage(reset.dataset.imageReset as 'logo_image' | 'background_image');
            return;
        }
        // Tapping the logo (or its camera badge) opens the picker — the ONLY
        // customization path needed on mobile, where the palette is hidden.
        // preventDefault: the colon link normally navigates home.
        if (target.closest('.journal-colon-link')) {
            e.preventDefault();
            e.stopPropagation();
            pendingImageKey = 'logo_image';
            ensureFileInput().click();
            return;
        }
        if (target.closest('[data-done]')) {
            exitEditMode();
        }
    };
    document.addEventListener('click', clickHandler);

    // Palette inputs (change events don't bubble to click)
    document.addEventListener('change', onPanelChange);

    keyHandler = (e: KeyboardEvent) => {
        // A stacked modal's focus trap stopImmediatePropagation()s Escape
        // before this runs, so this only fires when the page owns the keys.
        if (e.key === 'Escape' && active) exitEditMode();
    };
    document.addEventListener('keydown', keyHandler);

    // Logo drop: capture phase beats fileDropTarget's window bubble listeners.
    dragHandler = (e: DragEvent) => {
        if (!active) return;
        const overLockup = e.target instanceof Element && !!e.target.closest('.user-logo-lockup');
        if (overLockup) {
            e.preventDefault();
            e.stopPropagation();
            lockupLink()?.classList.add('upe-drop-hover');
        } else {
            lockupLink()?.classList.remove('upe-drop-hover');
        }
    };
    dropHandler = (e: DragEvent) => {
        if (!active) return;
        lockupLink()?.classList.remove('upe-drop-hover');
        const overLockup = e.target instanceof Element && !!e.target.closest('.user-logo-lockup');
        if (!overLockup) return;
        e.preventDefault();
        e.stopPropagation();
        const file = e.dataTransfer?.files?.[0];
        if (file) void uploadAndSet('logo_image', file);
    };
    document.addEventListener('dragover', dragHandler, true);
    document.addEventListener('drop', dropHandler, true);
}

function onPanelChange(e: Event): void {
    if (!active || !panelEl) return;
    const target = e.target;
    // Shelf-pill curation: any checkbox toggle saves the literal checked set —
    // checked = shown, and an empty set really means "no pills".
    if (target instanceof HTMLInputElement && target.dataset.pillShelf !== undefined) {
        const checked = [...panelEl.querySelectorAll<HTMLInputElement>('[data-pill-shelf]')]
            .filter((cb) => cb.checked)
            .map((cb) => cb.dataset.pillShelf as string);
        void putSettings({ pill_shelves: checked });
    }
}

export function destroyUserPageEditor(): void {
    if (active) exitEditMode();
    if (clickHandler) document.removeEventListener('click', clickHandler);
    clickHandler = null;
    document.removeEventListener('change', onPanelChange);
    if (keyHandler) document.removeEventListener('keydown', keyHandler);
    keyHandler = null;
    if (dragHandler) document.removeEventListener('dragover', dragHandler, true);
    dragHandler = null;
    if (dropHandler) document.removeEventListener('drop', dropHandler, true);
    dropHandler = null;
    window.clearTimeout(aboutSaveTimer);
    aboutSaveTimer = 0;
    aboutDirty = false;
    panelEl?.remove();
    panelEl = null;
    fileInputEl?.remove();
    fileInputEl = null;
    originalColonHtml = '';
}
