/**
 * Notifications overlay — "someone engaged with your work" feed as an ANY-PAGE
 * overlay, opened from the userButton flyout's "Notifications" row. Built on
 * the Stats/Money overlay skeleton: body-appended singleton, one root click
 * listener, trapModalFocus (Escape closes, focus returns to the opener),
 * ButtonRegistry registration purely so SPA navigation destroys an open
 * overlay cleanly.
 *
 * Events (written server-side by NotificationWriter): someone hyperlighted
 * your book / footnote / highlight (any sub-book depth), someone's hypercite
 * of your passage got PAIRED (a paste added a citedIN entry), someone liked
 * your book. Rows arrive render-ready from GET /api/notifications — the panel
 * never derives labels or links itself.
 *
 * Unread state: opening the panel marks everything read (POST
 * /api/notifications/read, drained). Until then, unread rows are pink-marked
 * and a pink dot rides #userButton (Account) and the Notifications menu row —
 * both live only INSIDE menus, deliberately: nothing on the always-visible
 * logo nav, so reading is never interrupted.
 */

import { log } from '../../utilities/logger';
import { trapModalFocus } from '../../utilities/modalFocusTrap';
import { drainResponse } from '../../utilities/drainResponse';
import { getAuthContext } from '../../utilities/auth/session';

interface NotificationItem {
    id: number;
    type: string;
    actor: string | null;
    actor_label: string;
    verb: string;
    context_label: string;
    snippet: string | null;
    link: string;
    created_at: string | null;
    read_at: string | null;
}

let overlayEl: HTMLElement | null = null;
let releaseTrap: (() => void) | null = null;

export function closeNotificationsOverlay(): void {
    releaseTrap?.();
    releaseTrap = null;
    overlayEl?.remove();
    overlayEl = null;
}

function esc(s: string): string {
    const div = document.createElement('div');
    div.textContent = s;
    return div.innerHTML;
}

function timeAgo(iso: string | null): string {
    if (!iso) return '';
    const then = new Date(iso).getTime();
    if (Number.isNaN(then)) return '';
    const secs = Math.max(0, Math.floor((Date.now() - then) / 1000));
    if (secs < 60) return 'just now';
    const mins = Math.floor(secs / 60);
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days < 30) return `${days}d ago`;
    const months = Math.floor(days / 30);
    if (months < 12) return `${months}mo ago`;
    return `${Math.floor(months / 12)}y ago`;
}

// The aqua heart shown to the left of a "liked" row — the SAME glyph and
// colour #like-book takes in its pressed state (sourceContainer.css
// #like-book.liked svg → fill/stroke var(--hyperlit-aqua)).
const LIKE_HEART = `<svg class="notif-like-heart" viewBox="0 0 24 24" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/></svg>`;

/**
 * The verb, styled so the KIND of engagement reads at a glance:
 *   - hyperlight → the verb wears a highlight mark (like a hyperlight)
 *   - hypercite  → the verb is underlined in the couple/poly rainbow gradient
 *   - like       → plain (the aqua heart carries the meaning)
 */
function verbHtml(n: NotificationItem): string {
    const verb = esc(n.verb);
    if (n.type === 'hyperlight') return `<mark class="notif-verb-highlight">${verb}</mark>`;
    if (n.type === 'hypercite_paired') return `<span class="notif-verb-cite">${verb}</span>`;
    return verb;
}

function rowHtml(n: NotificationItem): string {
    // The whole row is a real ANCHOR: "go to the highlight/citation/book" is a
    // plain navigation the SPA link handler owns (no preventDefault branch).
    const heart = n.type === 'like' ? LIKE_HEART : '';
    return `
      <a class="notif-row notif-row-${esc(n.type)}${n.read_at ? '' : ' notif-unread'}" href="${esc(n.link)}">
        ${heart}
        <span class="notif-row-main">
          <span class="notif-row-text"><strong>${esc(n.actor_label)}</strong> ${verbHtml(n)} ${esc(n.context_label)}</span>
          ${n.snippet ? `<span class="notif-row-snippet">&ldquo;${esc(n.snippet)}&rdquo;</span>` : ''}
        </span>
        <span class="notif-row-time">${esc(timeAgo(n.created_at))}</span>
      </a>`;
}

/** Paged like the stats list: a fresh open RESETS, "Load more" APPENDS. */
const listState = { offset: 0, total: 0, loading: false };
let listRequestSeq = 0;

async function loadNotifications(panel: HTMLElement, append: boolean): Promise<void> {
    const body = panel.querySelector<HTMLElement>('.notifications-panel-body');
    if (!body || listState.loading) return;
    listState.loading = true;
    const seq = ++listRequestSeq;

    if (!append) {
        listState.offset = 0;
        body.innerHTML = '<p class="notifications-panel-empty">Loading&hellip;</p>';
    }

    try {
        const resp = await fetch(`/api/notifications?offset=${listState.offset}`, {
            headers: { Accept: 'application/json' },
            credentials: 'include',
        });
        if (!resp.ok) {
            await drainResponse(resp);
            throw new Error(`notifications fetch failed (${resp.status})`);
        }
        const data = (await resp.json()) as {
            items?: NotificationItem[]; total?: number; unread_count?: number;
        };
        if (seq !== listRequestSeq) return; // a newer request already answered

        const items = data.items || [];
        listState.total = data.total || 0;
        listState.offset += items.length;

        const rows = items.map(rowHtml).join('');
        if (append) {
            body.querySelector('.notif-load-more-wrap')?.remove();
            body.insertAdjacentHTML('beforeend', rows);
        } else if (items.length) {
            body.innerHTML = rows;
        } else {
            body.innerHTML = '<p class="notifications-panel-empty">Nothing yet — you’ll hear it here when someone highlights, cites, or likes your work.</p>';
        }

        if (listState.offset < listState.total) {
            body.insertAdjacentHTML('beforeend', `
              <div class="notif-load-more-wrap">
                <button type="button" class="notif-load-more">Load more</button>
                <span class="notif-load-more-count">${listState.offset} of ${listState.total}</span>
              </div>`);
        }

        // Opening the panel marks everything read: fire-and-forget, drained.
        // The unread styling stays for THIS open (you can see what was new);
        // the dots clear now.
        if (!append && (data.unread_count || 0) > 0) {
            fetch('/api/notifications/read', {
                method: 'POST',
                headers: { Accept: 'application/json', 'X-XSRF-TOKEN': xsrfToken() },
                credentials: 'include',
            }).then(drainResponse).catch(() => {});
            setUnreadCount(0);
        }
    } catch (error) {
        if (seq !== listRequestSeq) return;
        log.error('Notifications overlay: failed to load feed', '/components/notificationsOverlay/notificationsOverlay.ts', error);
        if (!append) body.innerHTML = '<p class="notifications-panel-empty">Could not load notifications right now.</p>';
    } finally {
        if (seq === listRequestSeq) listState.loading = false;
    }
}

function xsrfToken(): string {
    const match = document.cookie.match(/(?:^|;\s*)XSRF-TOKEN=([^;]+)/);
    return match?.[1] ? decodeURIComponent(match[1]) : '';
}

function onOverlayClick(e: Event): void {
    const target = e.target instanceof Element ? e.target : null;
    if (!target || !overlayEl) return;

    if (target === overlayEl) {
        closeNotificationsOverlay();
        return;
    }

    if (target.closest('.notifications-panel-close')) {
        e.preventDefault();
        e.stopPropagation();
        closeNotificationsOverlay();
        return;
    }

    // A notification row: close the panel and let the click through — the
    // SPA's link handler (or a plain navigation) takes it from here.
    if (target.closest('.notif-row')) {
        closeNotificationsOverlay();
        return;
    }

    if (target.closest('.notif-load-more')) {
        e.preventDefault();
        e.stopPropagation();
        const panel = overlayEl.querySelector<HTMLElement>('.notifications-panel');
        if (panel) void loadNotifications(panel, true);
    }
}

export async function openNotificationsOverlay(): Promise<void> {
    if (overlayEl) return; // already open

    const overlay = document.createElement('div');
    overlay.id = 'notifications-overlay';
    overlay.innerHTML = `
      <div class="notifications-panel" role="dialog" aria-label="Notifications">
        <div class="notifications-panel-header">
          <span class="notifications-panel-title">Notifications</span>
          <span class="notifications-panel-actions">
            <button type="button" class="notifications-panel-close" aria-label="Close">&times;</button>
          </span>
        </div>
        <div class="notifications-panel-body"><p class="notifications-panel-empty">Loading&hellip;</p></div>
      </div>`;
    overlay.addEventListener('click', onOverlayClick);
    document.body.appendChild(overlay);
    overlayEl = overlay;

    const panel = overlay.querySelector<HTMLElement>('.notifications-panel');
    if (!panel) return;

    listState.offset = 0;
    listState.loading = false;

    releaseTrap = trapModalFocus(panel, { onEscape: closeNotificationsOverlay });
    await loadNotifications(panel, false);
}

/* ── Unread dot (pink) ────────────────────────────────────────────────── */

/**
 * Cached unread count for this page entry. The dot targets only exist inside
 * menus (#userButton in the flyout, #notificationsBtn in the profile menu),
 * so applyNotificationsBadge() re-runs whenever those surfaces render.
 */
let unreadCount = 0;

function setUnreadCount(n: number): void {
    unreadCount = n;
    applyNotificationsBadge();
}

/**
 * Give a badge host its dot scaffolding, once.
 *
 * STRUCTURAL — this inserts elements, so it must happen when the surface
 * RENDERS, never when the unread fetch resolves. The dot rides the button's
 * ICON (top-right of the silhouette/bell head) rather than the button's
 * corner, because the Account button is label-and-icon in the flyout but
 * icon-only elsewhere and a corner-anchored dot drifts off the silhouette in
 * one of the two — hence the position:relative wrapper span.
 *
 * Idempotent: returns the existing anchor untouched on every later call, so
 * the badge refresh below can call it freely without ever moving the DOM.
 * `#notificationsBtn` ships its anchor in the static markup (forms.ts) and
 * never takes the building branch at all; `#userButton` lives in three blades
 * with a hand-inlined svg, so it is scaffolded here at page-entry time.
 */
function ensureDotAnchor(host: HTMLElement | null): HTMLElement | null {
    if (!host) return null;

    const existing = host.querySelector<HTMLElement>(':scope > .notif-dot-anchor');
    if (existing) return existing;

    const icon = host.querySelector<SVGElement>(':scope > svg');
    if (!icon) return null;

    const anchor = document.createElement('span');
    anchor.className = 'notif-dot-anchor';
    icon.parentNode?.insertBefore(anchor, icon);
    anchor.appendChild(icon);

    const dot = document.createElement('span');
    dot.className = 'notif-dot';
    dot.setAttribute('aria-hidden', 'true');
    anchor.appendChild(dot);

    return anchor;
}

/**
 * Show/hide the dot. Deliberately a CLASS TOGGLE on an always-present element
 * and nothing else.
 *
 * The dot used to be created and removed on arrival, and the anchor built
 * lazily around the icon at the same moment. Both are DOM insertions, and
 * refreshNotificationsBadge() runs them whenever a network round trip happens
 * to land — including while the profile flyout is mid-open-animation. The rows
 * below shifted under the user's cursor, and in the e2e tour it detached
 * #myBooksBtn between Playwright's visibility check and its click
 * ("element is not stable", then "element was detached from the DOM").
 *
 * A pink dot appearing must never move anything. The dot is absolutely
 * positioned inside the anchor, so with both already in the DOM this costs a
 * repaint and no reflow at all.
 */
function toggleDot(host: HTMLElement | null, show: boolean): void {
    const anchor = ensureDotAnchor(host);
    anchor?.classList.toggle('has-unread', show);
}

/**
 * Build the badge scaffolding for the hosts that exist right now, without
 * deciding anything about the count. Called at page/SPA entry so the one
 * layout-affecting step is done long before any menu opens or any fetch lands.
 */
export function ensureNotificationsBadgeSlots(): void {
    ensureDotAnchor(document.getElementById('userButton'));
    ensureDotAnchor(document.getElementById('notificationsBtn'));
}

/** Sync the pink dot onto whichever badge hosts currently exist in the DOM. */
export function applyNotificationsBadge(): void {
    const show = unreadCount > 0;
    toggleDot(document.getElementById('userButton'), show);
    toggleDot(document.getElementById('notificationsBtn'), show);
}

/**
 * Fetch the unread count and paint the dots. Call sites: component init (per
 * page entry / SPA nav) via initNotificationsOverlay, and the userContainer's
 * updateButtonColor (logged-in rebind). Anonymous sessions never fetch (the
 * auth context is already warm/shared — no extra request); a stray 401 is a
 * routine outcome: drain it and clear the dots.
 */
export async function refreshNotificationsBadge(): Promise<void> {
    try {
        const auth = await getAuthContext();
        if (!auth.isLoggedIn) {
            setUnreadCount(0);
            return;
        }
        const resp = await fetch('/api/notifications/unread-count', {
            headers: { Accept: 'application/json' },
            credentials: 'include',
        });
        if (!resp.ok) {
            await drainResponse(resp);
            setUnreadCount(0);
            return;
        }
        const data = (await resp.json()) as { unread?: number };
        setUnreadCount(data.unread || 0);
    } catch {
        // Network hiccup — leave the current dot state alone.
    }
}

/* ── ButtonRegistry lifecycle ─────────────────────────────────────────── */

export function initNotificationsOverlay(): void {
    // A fresh page/SPA entry must never inherit an orphaned open overlay.
    closeNotificationsOverlay();
    // Build the dot scaffolding NOW, synchronously on page entry — the only
    // layout-affecting step, done while nothing is animating and long before
    // the unread fetch below can resolve into an open menu.
    ensureNotificationsBadgeSlots();
    void refreshNotificationsBadge();
}

export function destroyNotificationsOverlay(): void {
    closeNotificationsOverlay();
}
