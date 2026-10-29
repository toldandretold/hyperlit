/**
 * API tokens overlay — mint/revoke the personal access tokens that connect an
 * external AI client (MCP) to this account. Opened from the userButton
 * flyout's "AI access" row. Same skeleton as the Data sovereignty overlay:
 * body-appended singleton, one root click listener, trapModalFocus (Escape
 * closes, focus returns to the opener), ButtonRegistry registration purely so
 * SPA navigation destroys an open overlay cleanly.
 *
 * The plaintext token appears exactly once, in the reveal box after creation
 * — the server stores only a hash, so there is nothing to re-show later.
 */

import { trapModalFocus } from '../../utilities/modalFocusTrap';
import { ensureCsrfToken, getCsrfTokenFromCookie } from '../../utilities/auth/csrf';
import { log } from '../../utilities/logger';

interface TokenRecord {
    id: number;
    name: string;
    abilities: string[];
    last_used_at: string | null;
    created_at: string | null;
    expires_at: string | null;
}

const ABILITIES: Array<{ key: string; label: string; desc: string; default: boolean }> = [
    { key: 'read', label: 'Read', desc: 'Library, search, book content, annotations, exports.', default: true },
    { key: 'annotate', label: 'Annotate', desc: 'Create highlights, hypercites and shelf changes.', default: true },
    { key: 'import', label: 'Import', desc: 'Import documents and URLs into your library.', default: false },
    { key: 'spend', label: 'Spend credits', desc: 'Allow paid actions (e.g. PDF OCR) to charge your balance.', default: false },
];

let overlayEl: HTMLElement | null = null;
let releaseTrap: (() => void) | null = null;

export function closeApiTokensOverlay(): void {
    releaseTrap?.();
    releaseTrap = null;
    overlayEl?.remove();
    overlayEl = null;
}

function csrfHeaders(): Record<string, string> {
    return {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-XSRF-TOKEN': getCsrfTokenFromCookie() ?? '',
    };
}

function fmtDate(iso: string | null): string {
    if (!iso) return 'never';
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? 'never' : d.toLocaleDateString();
}

function escapeHtml(s: string): string {
    return s.replace(/[&<>"']/g, (c) => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string
    ));
}

function tokenRowHtml(t: TokenRecord): string {
    const abilities = t.abilities.map((a) => `<span class="apitokens-chip">${escapeHtml(a)}</span>`).join('');
    return `
      <li class="apitokens-row" data-token-id="${t.id}">
        <span class="apitokens-row-text">
          <span class="apitokens-row-title">${escapeHtml(t.name)}</span>
          <span class="apitokens-row-desc">${abilities}</span>
          <span class="apitokens-row-desc">Last used: ${fmtDate(t.last_used_at)} &middot; Expires: ${fmtDate(t.expires_at)}</span>
        </span>
        <button type="button" class="apitokens-revoke" data-token-id="${t.id}">Revoke</button>
      </li>`;
}

async function refreshList(): Promise<void> {
    const listEl = overlayEl?.querySelector<HTMLElement>('#apitokens-list');
    if (!listEl) return;
    try {
        const res = await fetch('/api/user/api-tokens', {
            credentials: 'include',
            headers: { Accept: 'application/json' },
        });
        const payload = await res.json().catch(() => null);
        if (!res.ok || !payload?.success) {
            listEl.innerHTML = '<li class="apitokens-empty">Could not load tokens.</li>';
            return;
        }
        const tokens: TokenRecord[] = payload.tokens ?? [];
        listEl.innerHTML = tokens.length
            ? tokens.map(tokenRowHtml).join('')
            : '<li class="apitokens-empty">No tokens yet.</li>';
    } catch (err) {
        log.error('apiTokens: list failed', err);
        listEl.innerHTML = '<li class="apitokens-empty">Could not load tokens.</li>';
    }
}

async function createToken(): Promise<void> {
    if (!overlayEl) return;
    const nameInput = overlayEl.querySelector<HTMLInputElement>('#apitokens-name');
    const name = nameInput?.value.trim() || 'My AI client';
    const abilities = Array.from(
        overlayEl.querySelectorAll<HTMLInputElement>('.apitokens-ability:checked')
    ).map((el) => el.value);
    const status = overlayEl.querySelector<HTMLElement>('#apitokens-create-status');

    if (!abilities.length) {
        if (status) status.textContent = 'Pick at least one permission.';
        return;
    }
    if (status) status.textContent = 'Creating…';

    try {
        await ensureCsrfToken();
        const res = await fetch('/api/user/api-tokens', {
            method: 'POST',
            credentials: 'include',
            headers: csrfHeaders(),
            body: JSON.stringify({ name, abilities }),
        });
        const payload = await res.json().catch(() => null);
        if (!res.ok || !payload?.success) {
            if (status) status.textContent = payload?.message || 'Could not create the token.';
            return;
        }
        if (status) status.textContent = '';
        if (nameInput) nameInput.value = '';
        showReveal(payload.token as string);
        void refreshList();
    } catch (err) {
        log.error('apiTokens: create failed', err);
        if (status) status.textContent = 'Could not create the token.';
    }
}

function showReveal(plainToken: string): void {
    const reveal = overlayEl?.querySelector<HTMLElement>('#apitokens-reveal');
    if (!reveal) return;
    reveal.hidden = false;
    reveal.innerHTML = `
      <p class="apitokens-reveal-note">Copy this token now — it is shown only once.</p>
      <code class="apitokens-reveal-code">${escapeHtml(plainToken)}</code>
      <button type="button" id="apitokens-copy" class="apitokens-copy">Copy</button>`;
    reveal.querySelector('#apitokens-copy')?.addEventListener('click', () => {
        void navigator.clipboard.writeText(plainToken).then(() => {
            const btn = reveal.querySelector<HTMLElement>('#apitokens-copy');
            if (btn) btn.textContent = 'Copied!';
        });
    });
}

async function revokeToken(id: string): Promise<void> {
    try {
        await ensureCsrfToken();
        const res = await fetch(`/api/user/api-tokens/${id}`, {
            method: 'DELETE',
            credentials: 'include',
            headers: csrfHeaders(),
        });
        // Drain the body regardless of outcome (fetch-drain review gate).
        await res.json().catch(() => null);
        void refreshList();
    } catch (err) {
        log.error('apiTokens: revoke failed', err);
    }
}

function onOverlayClick(e: Event): void {
    const target = e.target instanceof Element ? e.target : null;
    if (!target || !overlayEl) return;

    if (target === overlayEl) {
        closeApiTokensOverlay();
        return;
    }
    if (target.closest('.apitokens-panel-close')) {
        e.preventDefault();
        closeApiTokensOverlay();
        return;
    }
    const revoke = target.closest<HTMLElement>('.apitokens-revoke');
    if (revoke?.dataset.tokenId) {
        e.preventDefault();
        void revokeToken(revoke.dataset.tokenId);
        return;
    }
    if (target.closest('#apitokens-create')) {
        e.preventDefault();
        void createToken();
    }
}

export function openApiTokensOverlay(): void {
    if (overlayEl) return; // already open

    const abilityRows = ABILITIES.map((a) => `
        <label class="apitokens-ability-row">
          <input type="checkbox" class="apitokens-ability" value="${a.key}" ${a.default ? 'checked' : ''}>
          <span class="apitokens-row-text">
            <span class="apitokens-row-title">${a.label}</span>
            <span class="apitokens-row-desc">${a.desc}</span>
          </span>
        </label>`).join('');

    const overlay = document.createElement('div');
    overlay.id = 'api-tokens-overlay';
    overlay.innerHTML = `
      <div class="apitokens-panel" role="dialog" aria-label="AI access tokens">
        <div class="apitokens-panel-header">
          <span class="apitokens-panel-title">AI access</span>
          <span class="apitokens-panel-actions">
            <button type="button" class="apitokens-panel-close" aria-label="Close">&times;</button>
          </span>
        </div>
        <div class="apitokens-panel-body">
          <p class="apitokens-intro">Let your AI assistant work with your library. Create a token, then add
            <code>${escapeHtml(window.location.origin)}/mcp</code> as an MCP connector in your client with the header
            <code>Authorization: Bearer &lt;token&gt;</code>. The token acts as you, within the permissions you pick —
            revoke it here any time.</p>
          <p class="apitokens-section-label">Your tokens</p>
          <ul id="apitokens-list" class="apitokens-list"><li class="apitokens-empty">Loading…</li></ul>
          <p class="apitokens-section-label">Create a token</p>
          <input type="text" id="apitokens-name" class="apitokens-name" maxlength="100"
                 placeholder="Name (e.g. Claude on my laptop)">
          ${abilityRows}
          <button type="button" id="apitokens-create" class="apitokens-create">Create token</button>
          <p id="apitokens-create-status" class="apitokens-status" role="status"></p>
          <div id="apitokens-reveal" class="apitokens-reveal" hidden></div>
        </div>
      </div>`;
    overlay.addEventListener('click', onOverlayClick);
    document.body.appendChild(overlay);
    overlayEl = overlay;

    void refreshList();

    const panel = overlay.querySelector<HTMLElement>('.apitokens-panel');
    if (panel) {
        releaseTrap = trapModalFocus(panel, { onEscape: closeApiTokensOverlay });
    }
}

/* ── ButtonRegistry lifecycle ─────────────────────────────────────────── */

export function initApiTokensOverlay(): void {
    // Nothing to arm — built on demand by the userButton menu. A fresh
    // page/SPA entry must never inherit an orphaned open overlay.
    closeApiTokensOverlay();
}

export function destroyApiTokensOverlay(): void {
    closeApiTokensOverlay();
}
