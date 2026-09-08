/**
 * Money overlay — the account/billing view (balance card, tier selector,
 * top-up, ledger) as an ANY-PAGE overlay, opened from the userButton flyout's
 * "Money" row. Content is the same `{sanitized}Account` synthetic book the
 * user page's Account tab renders, served by GET /api/billing/account-panel
 * (same generator, same freshness guard, RLS-scoped to the owner); the
 * balance-card CSS (accountPage.css) is in every page bundle already.
 *
 * Interaction: tier toggle/select and .stripe-topup are handled by ONE click
 * listener on the overlay root that always stopPropagation()s — on the user
 * page the same selectors have document-delegated handlers (userProfilePage)
 * that must not double-fire, and LinkNavigationHandler must never see the
 * top-up anchor.
 *
 * Focus: trapModalFocus (Escape closes, focus returns to the opener).
 * Registered via ButtonRegistry so SPA navigation destroys an open overlay
 * cleanly (releases the trap before the body swap orphans the DOM).
 */

import { log } from '../../utilities/logger';
import { trapModalFocus } from '../../utilities/modalFocusTrap';

let overlayEl: HTMLElement | null = null;
let releaseTrap: (() => void) | null = null;

function xsrfToken(): string {
    return decodeURIComponent(document.cookie.match(/XSRF-TOKEN=([^;]+)/)?.[1] || '');
}

export function closeMoneyOverlay(): void {
    releaseTrap?.();
    releaseTrap = null;
    overlayEl?.remove();
    overlayEl = null;
}

async function refreshPanelContent(panel: HTMLElement): Promise<void> {
    const body = panel.querySelector<HTMLElement>('.money-panel-body');
    if (!body) return;
    try {
        const resp = await fetch('/api/billing/account-panel', {
            headers: { 'Accept': 'application/json' },
            credentials: 'include',
        });
        if (!resp.ok) throw new Error(`account panel fetch failed (${resp.status})`);
        const data = (await resp.json()) as { html?: string };
        // Server-generated markup (the same nodes the Account tab renders).
        body.innerHTML = data.html || '<p class="money-panel-empty">No account activity yet.</p>';
    } catch (error) {
        log.error('Money overlay: failed to load account panel', '/components/moneyOverlay/moneyOverlay.ts', error);
        body.innerHTML = '<p class="money-panel-empty">Could not load your account right now.</p>';
    }
}

async function handleTierSelect(option: HTMLElement): Promise<void> {
    const tier = option.dataset.tier;
    if (!tier) return;
    try {
        const resp = await fetch('/api/billing/tier', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'X-XSRF-TOKEN': xsrfToken() },
            credentials: 'include',
            body: JSON.stringify({ tier }),
        });
        const data = (await resp.json()) as { success?: boolean };
        if (data.success && overlayEl) {
            // The server regenerated the account book — re-pull the canonical render.
            const panel = overlayEl.querySelector<HTMLElement>('.money-panel');
            if (panel) await refreshPanelContent(panel);
        }
    } catch (error) {
        log.error('Money overlay: tier change failed', '/components/moneyOverlay/moneyOverlay.ts', error);
    }
}

/** Fetch the full-ledger export and hand it to the browser as a download.
 *  fetch + blob (not a plain <a href>) so the SPA's link handler never sees
 *  it and auth rides the session cookie. */
async function downloadLedger(format: 'csv' | 'md'): Promise<void> {
    try {
        const resp = await fetch(`/api/billing/ledger/export?format=${format}`, { credentials: 'include' });
        if (!resp.ok) throw new Error(`ledger export failed (${resp.status})`);
        const blob = await resp.blob();
        const filename = resp.headers.get('Content-Disposition')?.match(/filename="([^"]+)"/)?.[1]
            || `hyperlit-ledger.${format}`;
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.click();
        URL.revokeObjectURL(url);
    } catch (error) {
        log.error('Money overlay: ledger export failed', '/components/moneyOverlay/moneyOverlay.ts', error);
    }
}

function onOverlayClick(e: Event): void {
    const target = e.target instanceof Element ? e.target : null;
    if (!target || !overlayEl) return;

    // Backdrop click (outside the panel) closes.
    if (target === overlayEl) {
        closeMoneyOverlay();
        return;
    }

    if (target.closest('.money-panel-close')) {
        e.preventDefault();
        e.stopPropagation();
        closeMoneyOverlay();
        return;
    }

    const exportBtn = target.closest<HTMLElement>('.money-panel-export');
    if (exportBtn) {
        e.preventDefault();
        e.stopPropagation();
        void downloadLedger(exportBtn.dataset.format === 'md' ? 'md' : 'csv');
        return;
    }

    const tierSelector = target.closest('.tier-selector');
    if (tierSelector) {
        e.preventDefault();
        e.stopPropagation();
        tierSelector.nextElementSibling?.classList.toggle('hidden');
        return;
    }

    const tierOption = target.closest<HTMLElement>('.tier-option');
    if (tierOption) {
        e.preventDefault();
        e.stopPropagation();
        void handleTierSelect(tierOption);
        return;
    }

    const topup = target.closest<HTMLElement>('.stripe-topup');
    if (topup) {
        e.preventDefault();
        e.stopPropagation();
        const amount = parseFloat(topup.dataset.topupAmount || '5') || 5;
        void import('../../utilities/billing/topUp').then(({ startTopUpCheckout }) => startTopUpCheckout(amount));
        return;
    }
}

export async function openMoneyOverlay(): Promise<void> {
    if (overlayEl) return; // already open

    const overlay = document.createElement('div');
    overlay.id = 'money-overlay';
    overlay.innerHTML = `
      <div class="money-panel" role="dialog" aria-label="Account and billing">
        <div class="money-panel-header">
          <span class="money-panel-title">Money</span>
          <span class="money-panel-actions">
            <button type="button" class="money-panel-export" data-format="csv" title="Download your full ledger as CSV">&#8595; CSV</button>
            <button type="button" class="money-panel-export" data-format="md" title="Download your full ledger as Markdown">&#8595; MD</button>
            <button type="button" class="money-panel-close" aria-label="Close">&times;</button>
          </span>
        </div>
        <div class="money-panel-body"><p class="money-panel-empty">Loading&hellip;</p></div>
      </div>`;
    overlay.addEventListener('click', onOverlayClick);
    document.body.appendChild(overlay);
    overlayEl = overlay;

    const panel = overlay.querySelector<HTMLElement>('.money-panel');
    if (panel) {
        releaseTrap = trapModalFocus(panel, { onEscape: closeMoneyOverlay });
        await refreshPanelContent(panel);
    }
}

/* ── ButtonRegistry lifecycle ─────────────────────────────────────────── */

export function initMoneyOverlay(): void {
    // Nothing to arm — the overlay is built on demand by the userButton menu.
    // A fresh page/SPA entry must never inherit an orphaned open overlay.
    closeMoneyOverlay();
}

export function destroyMoneyOverlay(): void {
    closeMoneyOverlay();
}
