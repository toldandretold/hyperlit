/**
 * The owner-minted archive page (/a/{slug}) runs the USER PAGE's editor —
 * userPageEditor, same code — with an archive target (server half pinned in
 * tests/Feature/Api/ShelfArchiveTest.php).
 *
 * What's pinned: on a journal page WITHOUT the owner seed nothing attaches
 * (a /j/ page or a visitor); with it, the pencil opens the same palette
 * ("Customize your archive", logo/background/art/connection map, NO shelf
 * pills), drives the About-book editor on #archive-about-book and the
 * archive title editor (not the user-library title editor); settings PUT to
 * the archive endpoint and images upload into the archive's About book;
 * leaving edit mode PATCHes a renamed title to the shelf.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const SHELF = '11111111-2222-4333-8444-555555555555';
const ABOUT = `shelf_about_${SHELF}`;

const about = vi.hoisted(() => ({
  enterAboutEdit: vi.fn(async () => {}),
  exitAboutEdit: vi.fn(async () => {}),
  hydrateAboutBook: vi.fn(async () => {}),
}));
const profile = vi.hoisted(() => ({ setUserProfileEditingEnabled: vi.fn() }));
const upload = vi.hoisted(() => ({
  uploadBookImage: vi.fn(async () => ({ filename: 'logo.png' })),
  isInsertableImageFile: vi.fn(() => true),
}));

vi.mock('../../../resources/js/app', () => ({ book: 'most-recent' }));
vi.mock('../../../resources/js/utilities/auth/csrf', () => ({ ensureCsrfToken: vi.fn(async () => 'tok') }));
vi.mock('../../../resources/js/utilities/bookImageUpload', () => upload);
vi.mock('../../../resources/js/components/userProfile/userProfileEditor', () => profile);
vi.mock('../../../resources/js/components/userProfile/userAboutBook', () => about);

import { initUserPageEditor, destroyUserPageEditor, aboutContainerId } from '../../../resources/js/components/userProfile/userPageEditor';

function render({ owner = true } = {}) {
  const seed = JSON.stringify({ shelfId: SHELF, name: 'Cyber Politics', mediaBook: ABOUT });
  document.body.dataset.page = 'journal';
  document.body.innerHTML = `
    <div id="app-container" class="lava-lamp-background archive-hero">
      <div id="imageContainer" class="top-content journal-logo-lockup">
        <a href="/" class="journal-colon-link"><svg class="journal-colon"></svg></a>
        <h1 id="archiveTitle" class="journal-title">Cyber Politics</h1>
      </div>
      <section class="welcome-copy journal-about">
        <div id="archive-about-book" class="sub-book-content" data-book-id="${ABOUT}" contenteditable="false"></div>
      </section>
    </div>
    ${owner ? `<div id="bottom-right-buttons" data-archive-edit='${seed}'><button id="editButton" type="button"></button></div>` : ''}
  `;
  window.userPageSettings = {};
  initUserPageEditor();
}

const pencil = () => document.getElementById('editButton');
const panel = () => document.getElementById('user-page-edit-panel');
const title = () => document.getElementById('archiveTitle');
const flush = () => new Promise((r) => setTimeout(r, 0));
const ok = (body) => Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } }));

describe('archive page = the user page editor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    globalThis.fetch = vi.fn(() => ok({ success: true, page_settings: {} }));
    document.title = 'Cyber Politics — Hyperlit';
  });

  afterEach(async () => {
    // Entering edit mode kicks off lazy imports; let them land before the
    // environment is torn down (else they reject after teardown, under load).
    await vi.dynamicImportSettled();
    destroyUserPageEditor();
    await vi.dynamicImportSettled();
    delete document.body.dataset.page;
  });

  it('a journal page without the owner seed gets no editor', async () => {
    render({ owner: false });
    expect(aboutContainerId()).toBe('user-about-book'); // no archive seed
    document.body.insertAdjacentHTML('beforeend', '<button id="editButton"></button>');
    pencil().click();
    expect(panel()).toBeNull();
  });

  it('the pencil opens the SAME palette — minus shelf pills — and the archive editors', async () => {
    window.publicShelves = [{ id: 'x', name: 'Should not show' }];
    render();
    pencil().click();
    await flush();
    const p = panel();
    expect(p).not.toBeNull();
    expect(p.textContent).toContain('Customize your archive');
    expect(p.querySelector('[data-image-pick="logo_image"]')).not.toBeNull();
    expect(p.querySelector('[data-image-pick="background_image"]')).not.toBeNull();
    expect(p.querySelector('[data-bg-art="none"]')).not.toBeNull();
    expect(p.querySelector('[data-show-map]')).not.toBeNull();
    // Pinned-book-as-about: offered on archives, OFF by default.
    expect(p.querySelector('[data-overview-as-about]').checked).toBe(false);
    expect(aboutContainerId()).toBe('archive-about-book');
    expect(profile.setUserProfileEditingEnabled).not.toHaveBeenCalled();
    expect(title().getAttribute('contenteditable')).toMatch(/plaintext-only|true/);
    expect(document.body.classList.contains('user-page-editing')).toBe(true);
    delete window.publicShelves;
  });

  it('settings PUT to the archive endpoint', async () => {
    render();
    pencil().click();
    const none = panel().querySelector('[data-bg-art="none"]');
    none.checked = true;
    none.dispatchEvent(new Event('change', { bubbles: true }));
    await flush();
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe(`/api/shelves/${SHELF}/archive/page-settings`);
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body)).toEqual({ background_art: 'none' });
  });

  it('ticking "use the pinned book as the about text" saves it and reloads', async () => {
    globalThis.fetch = vi.fn(() => ok({ success: true, page_settings: { overview_as_about: true } }));
    const reload = vi.fn();
    vi.stubGlobal('location', { ...window.location, reload });
    render();
    pencil().click();
    const box = panel().querySelector('[data-overview-as-about]');
    box.checked = true;
    box.dispatchEvent(new Event('change', { bubbles: true }));
    await vi.waitFor(() => expect(reload).toHaveBeenCalled());
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe(`/api/shelves/${SHELF}/archive/page-settings`);
    expect(JSON.parse(init.body)).toEqual({ overview_as_about: true });
    vi.unstubAllGlobals();
  });

  it('images upload into the archive About book and render from its media', async () => {
    globalThis.createImageBitmap = undefined; // normalizeImage falls back to the raw file
    render();
    pencil().click();
    document.querySelector('[data-image-pick="logo_image"]').click();
    const input = document.querySelector('input[type="file"]');
    const file = new File(['x'], 'logo.svg', { type: 'image/svg+xml' });
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    input.dispatchEvent(new Event('change'));
    await flush(); await flush(); await flush();
    expect(upload.uploadBookImage).toHaveBeenCalledWith(ABOUT, file);
    expect(document.querySelector('img.user-page-logo').getAttribute('src')).toBe(`/${ABOUT}/media/logo.png`);
  });

  it('leaving edit mode stops the About editor and PATCHes a renamed title to the shelf', async () => {
    render();
    pencil().click();
    title().textContent = 'Cyber Politics Reader';
    pencil().click();
    await flush(); await flush();
    const patch = fetch.mock.calls.find(([u]) => u === `/api/shelves/${SHELF}`);
    expect(patch[1].method).toBe('PATCH');
    expect(JSON.parse(patch[1].body)).toEqual({ name: 'Cyber Politics Reader' });
    expect(document.title).toBe('Cyber Politics Reader — Hyperlit');
    expect(title().hasAttribute('contenteditable')).toBe(false);
  });

  it('Escape in the title reverts it without leaving edit mode', () => {
    render();
    pencil().click();
    title().textContent = 'oops';
    title().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(title().textContent).toBe('Cyber Politics');
    expect(document.body.classList.contains('user-page-editing')).toBe(true);
  });
});
