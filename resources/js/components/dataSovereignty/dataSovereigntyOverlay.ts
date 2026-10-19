/**
 * Data sovereignty overlay — the your-data-is-yours panel, opened from the
 * userButton flyout's "Data sovereignty" row. Sibling of the Stats /
 * Notifications / Money overlays and built on the same skeleton: body-appended
 * singleton, one root click listener, trapModalFocus (Escape closes, focus
 * returns to the opener), ButtonRegistry registration purely so SPA navigation
 * destroys an open overlay cleanly.
 *
 * Houses the user's data/privacy options and is the home for future per-user
 * privacy/data defaults:
 *  - EXPORT: the real archive-export downloads (markdown vault + SQLite),
 *    wired through archivePanel/exportDownload.ts with the USER scope — the
 *    same state machine the user-page archive panel uses, so exports work
 *    from any page instead of bouncing the user to their library first.
 *  - the privacy policy (a Hyperlit book at /privacy);
 *  - account deletion — hands off to the dialog-based flow in
 *    userContainer/deleteAccount.ts (the overlay closes first: the flow's
 *    dialogs are their own trapped surfaces).
 */

import { trapModalFocus } from '../../utilities/modalFocusTrap';
import { getCurrentUserInfo } from '../../utilities/auth/index';
import { initExportDownload, type ExportDownloadHandle } from '../archivePanel/exportDownload';
import { savePreference } from '../../utilities/preferences';

let overlayEl: HTMLElement | null = null;
let releaseTrap: (() => void) | null = null;
let exportHandles: ExportDownloadHandle[] = [];

export function closeDataSovereigntyOverlay(): void {
    // Export buttons poll the build status — stop them with the overlay.
    exportHandles.forEach((h) => h.destroy());
    exportHandles = [];
    releaseTrap?.();
    releaseTrap = null;
    overlayEl?.remove();
    overlayEl = null;
}

const ICON = (paths: string): string =>
    `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;

const ICON_VAULT = ICON('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="3" y2="15"/>');
const ICON_DB = ICON('<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14c0 1.66 4.03 3 9 3s9-1.34 9-3V5"/><path d="M3 12c0 1.66 4.03 3 9 3s9-1.34 9-3"/>');
const ICON_SHIELD = ICON('<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1 1 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/>');
const ICON_FILE_TEXT = ICON('<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/>');
const ICON_TRASH = ICON('<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/>');

function rowHtml(id: string, icon: string, title: string, desc: string, opts: { danger?: boolean; progress?: boolean } = {}): string {
    return `
      <button type="button" id="${id}" class="datasov-row${opts.danger ? ' datasov-row-danger' : ''}">
        <span class="datasov-row-icon">${icon}${opts.progress ? '<span class="export-progress" aria-hidden="true"></span>' : ''}</span>
        <span class="datasov-row-text">
          <span class="datasov-row-title">${title}</span>
          <span class="datasov-row-desc">${desc}</span>
        </span>
      </button>`;
}

function onOverlayClick(e: Event): void {
    const target = e.target instanceof Element ? e.target : null;
    if (!target || !overlayEl) return;

    // Backdrop click (outside the panel) closes.
    if (target === overlayEl) {
        closeDataSovereigntyOverlay();
        return;
    }

    if (target.closest('.datasov-panel-close')) {
        e.preventDefault();
        e.stopPropagation();
        closeDataSovereigntyOverlay();
        return;
    }

    // The export buttons own their clicks (exportDownload.ts attached its own
    // listeners); only the navigation/danger rows are handled here.

    if (target.closest('#datasovPrivacyBtn')) {
        e.preventDefault();
        e.stopPropagation();
        closeDataSovereigntyOverlay();
        window.location.href = '/privacy';
        return;
    }

    if (target.closest('#datasovTermsBtn')) {
        e.preventDefault();
        e.stopPropagation();
        closeDataSovereigntyOverlay();
        window.location.href = '/terms';
        return;
    }

    if (target.closest('#datasovDeleteBtn')) {
        e.preventDefault();
        e.stopPropagation();
        closeDataSovereigntyOverlay();
        // Lazy: the deletion flow (and its dialogs) stay out of the eager bundle.
        void import('../userContainer/deleteAccount').then(({ startDeleteAccountFlow }) =>
            startDeleteAccountFlow(null));
    }
}

export function openDataSovereigntyOverlay(): void {
    if (overlayEl) return; // already open

    const name = getCurrentUserInfo()?.name;

    // Semantic search for private books: embedding means sending node text to
    // the external embedding API at save/import time — the ONE default that
    // isn't strictly "nothing leaves unless you choose", so it gets a switch.
    // Default ON; EmbeddingEligibility owns the server-side meaning, and the
    // nightly embeddings:reconcile converges existing vectors both ways.
    const embedOn = ((window as any).__userPreferences?.embed_private_books) !== false;
    const settingsSection = name
        ? `
          <p class="datasov-section-label">Settings</p>
          <label class="datasov-row datasov-toggle" for="datasov-embed-toggle">
            <span class="datasov-row-text">
              <span class="datasov-row-title">Semantic search for private books</span>
              <span class="datasov-row-desc">Your private (non-encrypted) texts are converted to vector embeddings when saved, so you can search your own library by meaning. The embedding provider states it does not store or train on the text, but it is an external service. Turning this off stops new embeddings and removes existing ones within a day.</span>
            </span>
            <input type="checkbox" id="datasov-embed-toggle" ${embedOn ? 'checked' : ''}>
          </label>`
        : '';

    const exportSection = name
        ? `
          <p class="datasov-section-label">Export everything</p>
          ${rowHtml('datasov-export-md', ICON_VAULT, 'Markdown vault',
            '.zip — one .md per text (private included), drop into Obsidian.', { progress: true })}
          ${rowHtml('datasov-export-sqlite', ICON_DB, 'Data file',
            '.sqlite — texts, annotations and vector embeddings for offline work.', { progress: true })}`
        : '';

    const overlay = document.createElement('div');
    overlay.id = 'data-sovereignty-overlay';
    overlay.innerHTML = `
      <div class="datasov-panel" role="dialog" aria-label="Data sovereignty">
        <div class="datasov-panel-header">
          <span class="datasov-panel-title">Data sovereignty</span>
          <span class="datasov-panel-actions">
            <button type="button" class="datasov-panel-close" aria-label="Close">&times;</button>
          </span>
        </div>
        <div class="datasov-panel-body">
          ${settingsSection}
          ${exportSection}
          <p class="datasov-section-label">Your rights</p>
          ${rowHtml('datasovPrivacyBtn', ICON_SHIELD, 'Privacy policy',
        'What we collect, what never leaves your device, and exactly when content reaches a third party.')}
          ${rowHtml('datasovTermsBtn', ICON_FILE_TEXT, 'Terms of service',
        'The agreement that governs your account — plain language, 30 days’ notice of material changes.')}
          ${rowHtml('datasovDeleteBtn', ICON_TRASH, 'Delete account',
        'Permanently delete your account. You choose what happens to anything you published.', { danger: true })}
        </div>
      </div>`;
    overlay.addEventListener('click', onOverlayClick);
    document.body.appendChild(overlay);
    overlayEl = overlay;

    // Wire the real export machinery (same contract as the archive panel's
    // buttons: busy %, poll, download on ready).
    if (name) {
        const scope = { scopeType: 'user', scopeId: String(name) };
        for (const [buttonId, kind] of [['datasov-export-md', 'markdown'], ['datasov-export-sqlite', 'sqlite']] as const) {
            const handle = initExportDownload(overlay, buttonId, scope, kind);
            if (handle) exportHandles.push(handle);
        }
    }

    // The embeddings toggle: savePreference batches + POSTs to the server
    // allow-list; the __userPreferences mirror stays coherent so reopening
    // the panel this page-lifetime shows the new state.
    overlay.querySelector<HTMLInputElement>('#datasov-embed-toggle')?.addEventListener('change', (e) => {
        const on = (e.target as HTMLInputElement).checked;
        savePreference('embed_private_books', on);
        // Keep the server-injected mirror coherent: consumers (the user
        // page's semantic-coverage notice) re-read it per render.
        const prefs = (window as any).__userPreferences || ((window as any).__userPreferences = {});
        prefs.embed_private_books = on;
    });

    const panel = overlay.querySelector<HTMLElement>('.datasov-panel');
    if (panel) {
        releaseTrap = trapModalFocus(panel, { onEscape: closeDataSovereigntyOverlay });
    }
}

/**
 * Open the Data sovereignty overlay the way a user WOULD: raise the logo nav,
 * open the Account container on the profile (showUserProfile does both), then
 * press the Data row — so the path is visible and learnable, exactly like the
 * code-opened login panel (see userContainer/index.ts openContainer's logo-nav
 * note). Used by gates that send someone here ("enable semantic search…").
 * Falls back to opening the overlay directly if the container machinery
 * isn't available.
 */
export async function openDataSovereigntyGuided(): Promise<void> {
    try {
        const { initializeUserContainer } = await import('../userButton/userButton') as any;
        const mgr: any = initializeUserContainer();
        if (!mgr?.showUserProfile) {
            openDataSovereigntyOverlay();
            return;
        }
        mgr.showUserProfile(); // renders the profile + opens container + raises the nav
        window.setTimeout(() => {
            const row = document.getElementById('dataSovereigntyBtn');
            if (!row) {
                mgr.closeContainer?.();
                openDataSovereigntyOverlay();
                return;
            }
            // Light the row BEFORE pressing it — the same active treatment the
            // Account row gets in the nav (menuRow.css styles .logo-nav-active
            // on any .menu-row-btn). Without this beat the overlay appears to
            // come from nowhere; with it, the step reads: "…then press Data."
            row.classList.add('logo-nav-active');
            window.setTimeout(() => {
                row.click(); // the profile listener closes the container and opens this overlay
            }, 450);
        }, 650); // each beat long enough to SEE, short enough not to feel stuck
    } catch {
        openDataSovereigntyOverlay();
    }
}

/* ── ButtonRegistry lifecycle ─────────────────────────────────────────── */

export function initDataSovereigntyOverlay(): void {
    // Nothing to arm — the overlay is built on demand by the userButton menu.
    // A fresh page/SPA entry must never inherit an orphaned open overlay.
    closeDataSovereigntyOverlay();
}

export function destroyDataSovereigntyOverlay(): void {
    closeDataSovereigntyOverlay();
}
