/**
 * Chat-homepage hero behavior (/chat experimental homepage).
 *
 * The chat page renders the logo + search + arranger buttons as a centered
 * glass card over the lava-lamp background, with big intro copy scrollable
 * beneath it. States (classes on #app-container.chat-page, CSS in chat.css):
 *
 *  - (none)          centered hero, intro copy below the fold, scroll hint
 *  - .scrolled       user scrolled the intro — hero docks to the top while
 *                    the copy scrolls beneath it (backdrop stays theme-native)
 *  - .content-active an arranger tab is open — hero docks, intro hides,
 *                    feed shows, × (chat-feed-close) appears
 *
 * /chat always boots to the hero: homepageDisplayUnit would otherwise restore
 * the last tab (localStorage 'homepage_active_button' / history.state
 * .userPageActiveTab) and auto-load the feed, so init clears both. chatHero
 * registers before homepageDisplayUnit, so this runs before its restore reads.
 * The × closes the feed the same way. SPA returns from a book DO restore the
 * feed DOM — the MutationObserver re-applies .content-active for that case.
 *
 * No-ops unless #app-container.chat-page exists, so it is inert on the
 * normal homepage even though it registers for pages: ['home'].
 */

import { setLavaRise } from '../lavaLamp/index';

let clickHandler: ((e: Event) => void) | null = null;
let scrollHandler: (() => void) | null = null;
let observer: MutationObserver | null = null;
let fadeRaf = 0;

const chatPage = (): HTMLElement | null =>
  document.querySelector<HTMLElement>('#app-container.chat-page');

/**
 * Scrolling content (the intro copy AND the feed cards) must DISAPPEAR under
 * the glass card rather than show through it. A CSS mask fades each element
 * out at the card's bottom edge — but masks are element-relative while the
 * card is viewport-fixed, so the fade line is fed in as a CSS var recomputed
 * on scroll (and while the card's dock transition is still moving it).
 */
function updateIntroFade(): void {
  const header = document.querySelector('.fixed-header');
  if (!header) return;
  const line = header.getBoundingClientRect().bottom + 6;
  document
    .querySelectorAll<HTMLElement>('.chat-intro, .home-content-wrapper .main-content')
    .forEach(el => {
      // may go negative (element below the card) — that just pushes the fade
      // band above the element, i.e. fully visible; do NOT clamp to 0
      const y = line - el.getBoundingClientRect().top;
      el.style.setProperty('--intro-fade-y', `${y.toFixed(0)}px`);
    });
}

/** Keep the fade line glued to the card while its 0.6s dock transition runs. */
function trackFadeFor(ms: number): void {
  cancelAnimationFrame(fadeRaf);
  const until = performance.now() + ms;
  const step = (now: number) => {
    updateIntroFade();
    if (now < until) fadeRaf = requestAnimationFrame(step);
  };
  fadeRaf = requestAnimationFrame(step);
}

function suppressTabRestore(): void {
  localStorage.removeItem('homepage_active_button');
  const state = history.state;
  if (state && typeof state === 'object' && 'userPageActiveTab' in state) {
    const cleaned = { ...state } as Record<string, unknown>;
    delete cleaned.userPageActiveTab;
    try {
      history.replaceState(cleaned, '', window.location.href);
    } catch {
      // replaceState can throw in rare sandboxed contexts; restore then just wins
    }
  }
}

function syncHeroState(): void {
  const page = chatPage();
  if (!page) return;
  const hasContent = !!document.querySelector('.home-content-wrapper .main-content');
  const hasActiveTab = !!page.querySelector('.arranger-button.active');
  if (hasContent || hasActiveTab) page.classList.add('content-active');
}

function closeFeed(): void {
  const page = chatPage();
  if (!page) return;
  document.querySelectorAll('.home-content-wrapper .main-content').forEach(el => el.remove());
  page.querySelectorAll('.arranger-button.active').forEach(el => el.classList.remove('active'));
  page.classList.remove('content-active', 'scrolled');
  suppressTabRestore(); // so a reload doesn't reopen the feed
  document.querySelector('.home-content-wrapper')?.scrollTo({ top: 0 });
}

export function initChatHero(): void {
  const page = chatPage();
  if (!page) return;
  if (clickHandler) { syncHeroState(); return; } // create-once + re-sync on SPA re-init

  suppressTabRestore(); // /chat always boots to the hero

  clickHandler = (e: Event) => {
    const target = e.target instanceof Element ? e.target : null;
    if (!target) return;
    if (target.closest('#chat-feed-close')) {
      closeFeed();
      return;
    }
    if (target.closest('#chat-intro-import')) {
      e.preventDefault();
      document.getElementById('newBookButton')?.click();
      return;
    }
    // instant rise on tab press (before the fetch lands)
    if (target.closest('.arranger-button')) {
      chatPage()?.classList.add('content-active');
    }
  };
  // capture phase: runs regardless of what homepageDisplayUnit's handler does
  document.addEventListener('click', clickHandler, true);

  // hero docks while the intro is being read; scroll doesn't bubble but IS
  // capturable at document level, which survives SPA wrapper rebuilds
  scrollHandler = () => {
    const p = chatPage();
    const wrapper = document.querySelector('.home-content-wrapper');
    if (!p || !wrapper) return;
    const st = wrapper.scrollTop;

    const wasScrolled = p.classList.contains('scrolled');
    const nowScrolled = st > 30;
    p.classList.toggle('scrolled', nowScrolled);

    // background parallax: whole artwork creeps up gently (as before)...
    const mount = document.getElementById('lava-lamp-mount');
    mount?.style.setProperty('--lava-parallax', `${(-Math.min(st * 0.12, 130)).toFixed(0)}px`);
    // ...while the shorter/foreground hills GROW up with the text
    setLavaRise(Math.min(st / 700, 1));

    if (wasScrolled !== nowScrolled) trackFadeFor(750); // card is gliding — follow it
    else updateIntroFade();
  };
  document.addEventListener('scroll', scrollHandler, true);

  // catches the SPA-return path where the feed DOM is restored wholesale,
  // and keeps the fade var fresh on newly created .main-content elements
  observer = new MutationObserver(() => {
    syncHeroState();
    updateIntroFade();
  });
  observer.observe(document.body, { childList: true, subtree: true });

  syncHeroState();
}

export function destroyChatHero(): void {
  if (clickHandler) document.removeEventListener('click', clickHandler, true);
  clickHandler = null;
  if (scrollHandler) document.removeEventListener('scroll', scrollHandler, true);
  scrollHandler = null;
  cancelAnimationFrame(fadeRaf);
  fadeRaf = 0;
  observer?.disconnect();
  observer = null;
}
