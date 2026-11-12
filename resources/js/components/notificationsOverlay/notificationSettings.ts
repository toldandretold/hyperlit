/**
 * Notification settings — the recipient's controls over what reaches their
 * notifications panel. Rendered in TWO places from this one module, so the
 * two can never disagree: the Notifications panel (behind its gear) and the
 * Data sovereignty panel's Settings section.
 *
 * Server side, every control is enforced in ONE place —
 * NotificationWriter::allowed — so this module only reads and writes
 * preferences:
 *  - per-type switches (notify_hyperlight / _suggested_edit / _hypercite /
 *    _like) and notify_anonymous: booleans through savePreference, ABSENT
 *    means ON (a fresh account notifies about everything, as before);
 *  - notify_muted: the mute list. The generic preferences endpoint refuses
 *    to write it; muting goes through POST /api/notifications/mute (which
 *    also deletes that actor's existing rows) and unmuting through DELETE.
 *
 * The window.__userPreferences mirror is kept coherent after every change so
 * whichever of the two surfaces opens next renders the current state.
 */

import { savePreference } from '../../utilities/preferences';
import { drainResponse } from '../../utilities/drainResponse';
import { log } from '../../utilities/logger';

export type NotifyToggleKey =
    | 'notify_hyperlight'
    | 'notify_suggested_edit'
    | 'notify_hypercite'
    | 'notify_like'
    | 'notify_anonymous';

interface NotifyPrefs {
    notify_hyperlight?: boolean;
    notify_suggested_edit?: boolean;
    notify_hypercite?: boolean;
    notify_like?: boolean;
    notify_anonymous?: boolean;
    notify_muted?: string[];
    [key: string]: unknown;
}

const TOGGLES: ReadonlyArray<{ key: NotifyToggleKey; title: string; desc: string }> = [
    { key: 'notify_hyperlight', title: 'Highlights', desc: 'Someone highlights a passage of your work.' },
    { key: 'notify_suggested_edit', title: 'Suggested edits', desc: 'Someone suggests an edit to your text. The notification shows their suggested wording.' },
    { key: 'notify_hypercite', title: 'Citations', desc: 'Someone cites a passage of your work in a public text.' },
    { key: 'notify_like', title: 'Likes', desc: 'Someone likes one of your texts or shelves.' },
    { key: 'notify_anonymous', title: 'Activity from anonymous readers', desc: 'Readers who aren’t logged in appear as “Someone”. They can’t be muted one by one, so this switch silences all of them.' },
];

function prefs(): NotifyPrefs {
    const w = window as unknown as { __userPreferences?: NotifyPrefs };
    if (!w.__userPreferences || typeof w.__userPreferences !== 'object') w.__userPreferences = {};
    return w.__userPreferences;
}

function isOn(key: NotifyToggleKey): boolean {
    return prefs()[key] !== false;
}

export function mutedActors(): string[] {
    const list = prefs().notify_muted;
    return Array.isArray(list) ? list.filter((m): m is string => typeof m === 'string') : [];
}

/** Persist one switch and keep the mirror coherent. */
export function setNotifyToggle(key: NotifyToggleKey, on: boolean): void {
    savePreference(key, on);
    prefs()[key] = on;
}

function esc(s: string): string {
    const div = document.createElement('div');
    div.textContent = s;
    return div.innerHTML;
}

function xsrfToken(): string {
    const match = document.cookie.match(/(?:^|;\s*)XSRF-TOKEN=([^;]+)/);
    return match?.[1] ? decodeURIComponent(match[1]) : '';
}

/**
 * Mute (POST) or unmute (DELETE) an actor. Resolves to the server's mute list
 * on success (and mirrors it), or null on failure. The body is always read.
 */
export async function requestMute(actor: string, mute: boolean): Promise<string[] | null> {
    try {
        const resp = await fetch('/api/notifications/mute', {
            method: mute ? 'POST' : 'DELETE',
            headers: {
                Accept: 'application/json',
                'Content-Type': 'application/json',
                'X-XSRF-TOKEN': xsrfToken(),
            },
            credentials: 'include',
            body: JSON.stringify({ actor }),
        });
        if (!resp.ok) {
            await drainResponse(resp);
            log.error(`Notification ${mute ? 'mute' : 'unmute'} failed (${resp.status})`, '/components/notificationsOverlay/notificationSettings.ts');
            return null;
        }
        const data = (await resp.json()) as { muted?: string[] };
        const muted = Array.isArray(data.muted) ? data.muted : [];
        prefs().notify_muted = muted;
        return muted;
    } catch (error) {
        log.error('Notification mute request failed', '/components/notificationsOverlay/notificationSettings.ts', error);
        return null;
    }
}

function mutedListHtml(): string {
    const muted = mutedActors();
    if (!muted.length) {
        return '<p class="notif-settings-empty">Nobody is muted. Use the mute button on a notification to stop hearing from someone.</p>';
    }
    return `<ul class="notif-settings-muted">${muted.map((name) => `
      <li class="notif-settings-muted-item">
        <span class="notif-settings-muted-name">${esc(name)}</span>
        <button type="button" class="notif-settings-unmute" data-actor="${esc(name)}">Unmute</button>
      </li>`).join('')}</ul>`;
}

/**
 * Render the settings into $container (replacing its contents) and wire them.
 * Returns a cleanup that detaches the listeners.
 */
export function renderNotificationSettings(container: HTMLElement): () => void {
    container.innerHTML = `
      <div class="notif-settings">
        ${TOGGLES.map((t) => `
          <label class="notif-settings-row" for="notif-settings-${t.key}">
            <span class="notif-settings-text">
              <span class="notif-settings-title">${esc(t.title)}</span>
              <span class="notif-settings-desc">${esc(t.desc)}</span>
            </span>
            <input type="checkbox" id="notif-settings-${t.key}" data-pref="${t.key}" ${isOn(t.key) ? 'checked' : ''}>
          </label>`).join('')}
        <p class="notif-settings-label">Muted users</p>
        <div class="notif-settings-muted-wrap">${mutedListHtml()}</div>
      </div>`;

    const onChange = (e: Event): void => {
        const input = e.target instanceof HTMLInputElement ? e.target : null;
        const key = input?.dataset.pref as NotifyToggleKey | undefined;
        if (!input || !key) return;
        setNotifyToggle(key, input.checked);
    };

    const onClick = (e: Event): void => {
        const btn = e.target instanceof Element ? e.target.closest<HTMLButtonElement>('.notif-settings-unmute') : null;
        const actor = btn?.dataset.actor;
        if (!btn || !actor) return;
        e.preventDefault();
        e.stopPropagation();
        btn.disabled = true;
        void requestMute(actor, false).then((muted) => {
            const wrap = container.querySelector<HTMLElement>('.notif-settings-muted-wrap');
            if (muted !== null && wrap) {
                wrap.innerHTML = mutedListHtml();
            } else {
                btn.disabled = false;
            }
        });
    };

    container.addEventListener('change', onChange);
    container.addEventListener('click', onClick);
    return () => {
        container.removeEventListener('change', onChange);
        container.removeEventListener('click', onClick);
    };
}
