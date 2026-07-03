/**
 * Homepage hero behavior — the interactive layer over the lava-lamp background.
 *
 * The homepage renders the logo + search + arranger buttons as a centered
 * glass card (the "hero") over the lava-lamp background, with big welcome copy
 * scrollable beneath it. States (classes on #app-container.lava-lamp-background,
 * CSS in homepage.css):
 *
 *  - (none)          centered hero, welcome copy below the fold, scroll hint
 *  - .scrolled       user scrolled the copy — hero docks to the top while
 *                    the copy scrolls beneath it (backdrop stays theme-native)
 *  - .content-active an arranger tab is open — hero docks, copy hides,
 *                    feed shows, × (#copy-feed-close) appears
 *
 * The homepage always boots to the hero: homepageDisplayUnit would otherwise
 * restore the last tab (localStorage 'homepage_active_button' / history.state
 * .userPageActiveTab) and auto-load the feed, so init clears both. homepageHero
 * registers before homepageDisplayUnit, so this runs before its restore reads.
 * The × closes the feed the same way. SPA returns from a book DO restore the
 * feed DOM — the MutationObserver re-applies .content-active for that case.
 *
 * No-ops unless #app-container.lava-lamp-background exists, so it is inert
 * everywhere else even though it registers for pages: ['home'].
 */

import { setLavaCeiling, setLavaRise } from './lavaLampBackground';
import { fixHeaderSpacing, resetHeaderAlignment } from './homepageDisplayUnit';
import { setPerimeterButtonsHidden } from '../../utilities/operationState';


let clickHandler: ((e: Event) => void) | null = null;
let scrollHandler: (() => void) | null = null;
let observer: MutationObserver | null = null;
let fadeRaf = 0;
let returnTimer = 0;

// scroll distance over which the hero migrates centre → docked (≈ its actual
// travel in px, so it moves at the same speed as the text)
const HERO_TRAVEL = 280;

const heroRoot = (): HTMLElement | null =>
  document.querySelector<HTMLElement>('#app-container.lava-lamp-background');

/**
 * Scrolling content (the intro copy AND the feed cards) must DISAPPEAR under
 * the glass card rather than show through it. A CSS mask fades each element
 * out at the card's bottom edge — but masks are element-relative while the
 * card is viewport-fixed, so the fade line is fed in as a CSS var recomputed
 * on scroll (and while the card's dock transition is still moving it).
 */
function updateCopyFade(): void {
  const header = document.querySelector('.fixed-header');
  if (!header) return;
  const line = header.getBoundingClientRect().bottom + 30;
  document
    .querySelectorAll<HTMLElement>('.welcome-copy, .home-content-wrapper .main-content')
    .forEach(el => {
      // may go negative (element below the card) — that just pushes the fade
      // band above the element, i.e. fully visible; do NOT clamp to 0
      const y = line - el.getBoundingClientRect().top;
      el.style.setProperty('--copy-fade-y', `${y.toFixed(0)}px`);
    });
}

/** Keep the fade line glued to the card while its 0.6s dock transition runs. */
function trackFadeFor(ms: number): void {
  cancelAnimationFrame(fadeRaf);
  const until = performance.now() + ms;
  const step = (now: number) => {
    updateCopyFade();
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
  const page = heroRoot();
  if (!page) return;
  const hasContent = !!document.querySelector('.home-content-wrapper .main-content');
  const hasActiveTab = !!page.querySelector('.arranger-button.active');
  if (hasContent || hasActiveTab) page.classList.add('content-active');
}

function closeFeed(): void {
  const page = heroRoot();
  if (!page) return;
  document.querySelectorAll('.home-content-wrapper .main-content').forEach(el => el.remove());
  page.querySelectorAll('.arranger-button.active').forEach(el => el.classList.remove('active'));
  page.classList.remove('content-active', 'scrolled');
  // feed set inline left-margins on the header (alignHeaderContent) to match the
  // now-removed feed text — clear them so the hero re-centres
  resetHeaderAlignment();
  // ...and send the perimeter buttons back to the viewport corners (their
  // .main-content reference is gone; updatePosition listens on resize)
  window.dispatchEvent(new Event('resize'));
  // the one non-scroll-driven move: glide (don't snap) back to centre
  page.classList.add('hero-return');
  window.clearTimeout(returnTimer);
  returnTimer = window.setTimeout(() => heroRoot()?.classList.remove('hero-return'), 700);
  page.style.setProperty('--hero-p', '0');
  suppressTabRestore(); // so a reload doesn't reopen the feed
  document.querySelector('.home-content-wrapper')?.scrollTo({ top: 0 });
  trackFadeFor(750);
}

export function initHomepageHero(): void {
  const page = heroRoot();
  if (!page) return;
  if (clickHandler) { syncHeroState(); return; } // create-once + re-sync on SPA re-init

  suppressTabRestore(); // the homepage always boots to the hero

  clickHandler = (e: Event) => {
    const target = e.target instanceof Element ? e.target : null;
    if (!target) return;
    if (target.closest('#copy-feed-close')) {
      closeFeed();
      return;
    }
    // Import/convert links open the new-book panel. Accept a class so multiple
    // links can coexist (ids must be unique — prefer .copy-import).
    if (target.closest('.copy-import') || target.closest('#copy-import')) {
      e.preventDefault();

      // Reveal the perimeter buttons before opening the login container.
      ["bottom-right-buttons", "bottom-left-buttons", "topRightContainer",
       "logoNavWrapper", "userButtonContainer"].forEach((id) =>
        document.getElementById(id)?.classList.remove("perimeter-hidden"));
      setPerimeterButtonsHidden(false);
      document.getElementById('newBookButton')?.click();
      return;
    }
    // Auth links in the intro copy. The existing `.import-auth-*` handlers
    // (citeForm submission/urlImport) bind DIRECTLY to elements at creation
    // time, so statically-authored copy never gets a listener — this
    // capture-phase delegate is what makes them work in the hero. Reuses the
    // same entry point (initializeUserContainer → showLoginForm/RegisterForm).
    if (target.closest('.import-auth-login') || target.closest('.import-auth-register')) {
      e.preventDefault();
      const register = !!target.closest('.import-auth-register');
      void import('../userButton/userButton').then(({ initializeUserContainer }) => {
        const mgr = initializeUserContainer();
        if (register) mgr?.showRegisterForm();
        else mgr?.showLoginForm();
      });
      return;
    }
    // instant rise on tab press (before the fetch lands)
    if (target.closest('.arranger-button')) {
      const p = heroRoot();
      if (p) {
        p.classList.add('content-active');
        // feed mode: lava returns to its resting pose (the dim fader takes over)
        document.getElementById('lava-lamp-mount')?.style.setProperty('--lava-parallax', '0px');
        setLavaCeiling(null);
        setLavaRise(0);
        trackFadeFor(750); // follow the header while it glides to the top
        // homepageDisplayUnit measured the header while it was still the BIG
        // centered card and padded the wrapper to that height — re-measure
        // once the 0.6s glide has landed it in its (smaller) docked pose
        window.setTimeout(fixHeaderSpacing, 680);
      }
    }
  };
  // capture phase: runs regardless of what homepageDisplayUnit's handler does
  document.addEventListener('click', clickHandler, true);

  // hero docks while the intro is being read; scroll doesn't bubble but IS
  // capturable at document level, which survives SPA wrapper rebuilds
  scrollHandler = () => {
    const p = heroRoot();
    const wrapper = document.querySelector('.home-content-wrapper');
    if (!p || !wrapper) return;
    const st = wrapper.scrollTop;

    p.classList.toggle('scrolled', st > 30); // scroll-hint fade
    // hero pose is scroll-LINKED: it rises/shrinks at the text's speed
    p.style.setProperty('--hero-p', Math.min(st / HERO_TRAVEL, 1).toFixed(4));

    // lava reacts to scroll only in intro mode — in feed mode it sits still
    // behind the dim fader
    if (!p.classList.contains('content-active')) {
      // background parallax: whole artwork creeps up gently...
      const mount = document.getElementById('lava-lamp-mount');
      mount?.style.setProperty('--lava-parallax', `${(-Math.min(st * 0.12, 130)).toFixed(0)}px`);
      // ...while the hills behind the copy GROW up with the text, capped at
      // the header's bottom edge (rect read AFTER the parallax/--hero-p writes
      // forces a sync flush, so the ceiling tracks the docking card exactly)
      const header = document.querySelector('.fixed-header');
      if (header) setLavaCeiling(header.getBoundingClientRect().bottom);
      setLavaRise(Math.min(st / 700, 1));
    }

    updateCopyFade(); // header moves in lockstep with scroll — no tracker needed
  };
  document.addEventListener('scroll', scrollHandler, true);

  // catches the SPA-return path where the feed DOM is restored wholesale,
  // and keeps the fade var fresh on newly created .main-content elements
  observer = new MutationObserver(() => {
    syncHeroState();
    updateCopyFade();
  });
  observer.observe(document.body, { childList: true, subtree: true });

  syncHeroState();
}

export function destroyHomepageHero(): void {
  if (clickHandler) document.removeEventListener('click', clickHandler, true);
  clickHandler = null;
  if (scrollHandler) document.removeEventListener('scroll', scrollHandler, true);
  scrollHandler = null;
  window.clearTimeout(returnTimer);
  returnTimer = 0;
  cancelAnimationFrame(fadeRaf);
  fadeRaf = 0;
  observer?.disconnect();
  observer = null;
}
