// Reader actions — the like / add-to-shelf / share cluster on the left of the
// source container's action bar (built by buildSourceHtml, wired from
// attachInternalListeners like every other concern module here).
//
// All three act on the ROOT book: a sub-book overlay's source card still likes /
// shelves / shares the parent work. Logged-out clicks funnel into the same
// anchored login/register prompt the add-to-shelf menu already uses.

import { book, bookSlug } from '../../app';
import { isLoggedIn } from '../../utilities/auth/index';
import { log } from '../../utilities/logger';
import { trapModalFocus } from '../../utilities/modalFocusTrap';
import { drainResponse } from '../../utilities/drainResponse';

function rootBookId(): string {
  return String(book).split('/')[0] ?? String(book);
}

/** The book's shareable URL — its slug when it has one, else its raw id. */
function bookUrl(): string {
  return `${window.location.origin}/${encodeURIComponent(bookSlug || rootBookId())}`;
}

/**
 * Copy text, then flash the button for 1.5s — the `.copied` feedback pattern
 * the shelf header's share button already uses (no toast for a copy this
 * small; the button IS the confirmation).
 */
async function copyWithFeedback(btn: HTMLElement, text: string, what: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    btn.classList.add('copied');
    setTimeout(() => btn.classList.remove('copied'), 1500);
  } catch (err: any) {
    log.error(`Copy ${what} failed:`, err?.message);
  }
}

/** The book's formatted citation line + its URL, or '' when there is no citation. */
function citationText(self: any): string {
  // Read the RENDERED citation line rather than re-deriving it from the bibtex:
  // what gets copied is then always exactly what the panel shows. The wand
  // button lives inside that <p>, so strip it before reading.
  const citationEl = self.container.querySelector('.citation')?.cloneNode(true) as HTMLElement | undefined;
  citationEl?.querySelector('#auto-meta-btn')?.remove();
  const citation = citationEl?.textContent?.trim();
  return citation ? `${citation}\n${bookUrl()}` : '';
}

/**
 * The share popover: one trigger in the action bar expanding to labelled Link /
 * Citation rows. Modelled on visibilityControl's trigger+panel pair, minus the
 * content-blur overlay — this is a two-item menu over a strip, not a state
 * change over the whole card, so a click-outside listener is the whole contract.
 *
 * The rows deliberately do NOT close the panel on copy: the `.copied` tick IS
 * the confirmation, and collapsing the menu out from under the click would take
 * the feedback with it.
 */
function initShareControl(self: any): void {
  const control = self.container.querySelector('#share-control');
  if (!control || control._listenerAttached) return;
  control._listenerAttached = true;

  const trigger = control.querySelector('#share-book');
  const panel = control.querySelector('.share-panel');
  if (!trigger || !panel) return;

  const onOutside = (e: any) => { if (!control.contains(e.target)) close(); };
  let releaseTrap: (() => void) | null = null;
  let overlay: HTMLElement | null = null;

  function close(): void {
    panel.style.display = 'none';
    control.classList.remove('share-open');
    trigger.setAttribute('aria-expanded', 'false');
    overlay?.remove();
    overlay = null;
    releaseTrap?.();
    releaseTrap = null;
    document.removeEventListener('click', onOutside, true);
  }

  function open(): void {
    panel.style.display = 'block';
    control.classList.add('share-open');
    trigger.setAttribute('aria-expanded', 'true');
    // Click-catcher over the (now blurred) content — the .share-open class
    // drives `filter: blur(5px)` on #source-content in CSS. Without the
    // catcher a click on the frosted area falls through to a link beneath it.
    overlay = document.createElement('div');
    overlay.className = 'share-overlay';
    overlay.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      close();
    });
    self.container.appendChild(overlay);
    document.addEventListener('click', onOutside, true);
    // Stacks ABOVE the source container's own trap (modalState), so Escape
    // closes just this popover — same contract as the visibility panel.
    releaseTrap = trapModalFocus(control, { onEscape: close });
  }

  trigger.addEventListener('click', (e: Event) => {
    e.preventDefault();
    e.stopPropagation();
    if (control.classList.contains('share-open')) close(); else open();
  });

  panel.querySelectorAll('.share-option').forEach((opt: any) => {
    opt.addEventListener('click', (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      const kind = opt.dataset.share;
      const text = kind === 'citation' ? citationText(self) : bookUrl();
      if (!text) return;
      void copyWithFeedback(opt, text, kind);
    });
  });
}

function xsrf(): string {
  return decodeURIComponent(document.cookie.match(/XSRF-TOKEN=([^;]+)/)?.[1] || '');
}

function setLikedState(btn: HTMLElement, liked: boolean): void {
  btn.setAttribute('aria-pressed', liked ? 'true' : 'false');
  btn.classList.toggle('liked', liked);
  btn.title = liked ? 'Unlike' : 'Like';
}

/** Wire the action bar's reader buttons. Idempotent per rebuilt HTML (guard flags). */
export function initReaderActions(self: any): void {
  const likeBtn = self.container.querySelector('#like-book');
  const shelfBtn = self.container.querySelector('#shelf-book');

  initShareControl(self);

  if (shelfBtn && !shelfBtn._listenerAttached) {
    shelfBtn._listenerAttached = true;
    shelfBtn.addEventListener('click', async (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      const { showAddToShelfMenu } = await import('../shelves/addToShelfMenu');
      await showAddToShelfMenu(shelfBtn, rootBookId());
    });
  }

  if (likeBtn && !likeBtn._listenerAttached) {
    likeBtn._listenerAttached = true;

    // Seat the initial liked state (and count for future use) — best-effort.
    void (async () => {
      try {
        const resp = await fetch(`/api/books/${encodeURIComponent(rootBookId())}/likes`, {
          headers: { Accept: 'application/json' },
          credentials: 'include',
        });
        if (resp.ok) {
          const data = await resp.json();
          setLikedState(likeBtn, !!data.liked);
        }
      } catch {
        // leave the default unliked state
      }
    })();

    likeBtn.addEventListener('click', async (e: Event) => {
      e.preventDefault();
      e.stopPropagation();

      if (!(await isLoggedIn())) {
        const { showLoginPromptMenu } = await import('../shelves/addToShelfMenu');
        showLoginPromptMenu(likeBtn, 'Log in to like books');
        return;
      }

      // Optimistic toggle; revert if the request fails.
      const wasLiked = likeBtn.getAttribute('aria-pressed') === 'true';
      setLikedState(likeBtn, !wasLiked);
      try {
        const resp = await drainResponse(await fetch(`/api/books/${encodeURIComponent(rootBookId())}/like`, {
          method: wasLiked ? 'DELETE' : 'POST',
          headers: { Accept: 'application/json', 'X-XSRF-TOKEN': xsrf() },
          credentials: 'include',
        }));
        if (!resp.ok) throw new Error(`like toggle ${resp.status}`);
      } catch (err: any) {
        setLikedState(likeBtn, wasLiked);
        log.error('Like toggle failed:', err?.message);
        return;
      }

      // A like IS a shelf membership change now — the server mirrors it into
      // the user's Likes shelf. Drop the cached shelf list so that shelf
      // doesn't show stale contents on the next visit to the profile. Kept
      // OUTSIDE the try: a failed cache-drop must not trip the optimistic
      // revert above and un-paint a like the server actually took.
      try {
        const { invalidateShelfCache } = await import('../shelves/shelfTabs');
        invalidateShelfCache();
      } catch {
        // stale tab list is cosmetic — the next hard load rebuilds it
      }
    });
  }
}
