/**
 * Logo Navigation Toggle
 * Handles the logo button that rotates and shows/hides navigation menu
 */

import { verbose } from '../../utilities/logger';

let isOpen = false;
let clickOutsideHandler: any = null;
let escapeHandler: any = null;
let logoClickHandler: any = null; // Store handler reference for cleanup

/**
 * Initialize logo navigation toggle
 */
export function initializeLogoNav() {
  const logoBtn = document.getElementById('logoContainer');
  const logoWrapper = document.getElementById('logoNavWrapper');
  const navMenu = document.getElementById('logoNavMenu');

  if (!logoBtn || !navMenu || !logoWrapper) {
    verbose.init('Logo nav elements not found, skipping initialization', '/components/logoNav/logoNav.ts');
    return;
  }

  // Prevent duplicate listeners
  if (logoBtn.dataset.logoNavAttached) {
    verbose.init('Logo nav listener already attached', '/components/logoNav/logoNav.ts');
    return;
  }

  verbose.init('Logo navigation toggle initialized', '/components/logoNav/logoNav.ts');

  // Store handler reference for cleanup
  logoClickHandler = (e: any) => {
    e.stopPropagation(); // Prevent immediate close from document click
    toggleLogoNav();
  };

  logoBtn.addEventListener('click', logoClickHandler);
  logoBtn.dataset.logoNavAttached = 'true';
}

/**
 * Toggle logo navigation menu open/closed
 */
function toggleLogoNav() {
  const logoBtn = document.getElementById('logoContainer');
  const navMenu = document.getElementById('logoNavMenu');

  if (!logoBtn || !navMenu) return;

  isOpen = !isOpen;

  if (isOpen) {
    openLogoNav(logoBtn, navMenu);
  } else {
    closeLogoNav(logoBtn, navMenu);
  }
}

/**
 * Open logo navigation menu
 */
function openLogoNav(logoBtn: any, navMenu: any) {
  // Rotate logo
  logoBtn.classList.add('rotated');

  // Show menu
  navMenu.classList.remove('hidden');

  // Add click-outside handler
  setTimeout(() => {
    clickOutsideHandler = (e: any) => {
      // Use composedPath (snapshotted at dispatch) rather than contains/closest
      // on e.target: in-panel links like "Switch to register" replace the
      // panel's innerHTML in an earlier handler, so by the time this bubbles
      // the target is DETACHED and closest() reports "outside" — which closed
      // the whole nav mid-flow.
      const path: any[] = typeof e.composedPath === 'function' ? e.composedPath() : [];
      const clickedLogo = path.includes(logoBtn) || logoBtn.contains(e.target);
      const clickedMenu = path.includes(navMenu) || navMenu.contains(e.target);
      // The user/new-book flyout panels are level-2 children of this menu —
      // clicking inside them (login fields, view-switch links) must NOT close
      // it. Same for the custom-alert dialogs those flows spawn on top.
      const clickedFlyout =
        path.some((n: any) => n && (n.id === 'user-container' || n.id === 'newbook-container' || n.id === 'openbook-container')) ||
        !!e.target?.closest?.('#user-container, #newbook-container, #openbook-container, .custom-alert, .custom-alert-overlay');

      if (!clickedLogo && !clickedMenu && !clickedFlyout) {
        closeLogoNav(logoBtn, navMenu);
      }
    };
    // CAPTURE phase: many widgets (the TOC toggle among them) stopPropagation
    // in their own click handlers, which starved a bubble-phase outside-close
    // — the nav (and its z-1003 flyout panels) then stayed open UNDER/OVER
    // whatever panel the click opened. Capture runs before any of that and
    // cannot be suppressed, so one listener covers every widget generically.
    document.addEventListener('click', clickOutsideHandler, true);
  }, 0);

  // Keyboard: Escape closes the menu and returns focus to the logo (this is a
  // nav dropdown, not a modal — no focus trap; its buttons are plain tabbables).
  escapeHandler = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    closeLogoNav(logoBtn, navMenu);
    try { logoBtn.focus(); } catch { /* non-fatal */ }
  };
  document.addEventListener('keydown', escapeHandler);
}

/**
 * Close logo navigation menu
 */
function closeLogoNav(logoBtn: any, navMenu: any) {
  isOpen = false;

  // Rotate logo back
  logoBtn.classList.remove('rotated');

  // Hide menu
  navMenu.classList.add('hidden');

  // Closing the menu also closes any level-2 flyout it spawned — the flyouts
  // anchor to this column and would float orphaned without it.
  const userMgr = (window as any).userManager;
  if (userMgr?.isOpen) userMgr.closeContainer();
  const newBookMgr = (window as any).newBookManager;
  if (newBookMgr?.isOpen && newBookMgr.button?.closest?.('#logoNavMenu')) {
    newBookMgr.closeContainer();
  }
  const openBookMgr = (window as any).openBookManager;
  if (openBookMgr?.isOpen) openBookMgr.closeContainer();

  // Remove click-outside handler
  if (clickOutsideHandler) {
    document.removeEventListener('click', clickOutsideHandler, true);
    clickOutsideHandler = null;
  }
  if (escapeHandler) {
    document.removeEventListener('keydown', escapeHandler);
    escapeHandler = null;
  }
}

/**
 * Cleanup function for navigation transitions
 */
export function destroyLogoNav() {
  const logoBtn = document.getElementById('logoContainer');
  const navMenu = document.getElementById('logoNavMenu');

  // Close menu if open
  if (logoBtn) {
    logoBtn.classList.remove('rotated');
  }

  if (navMenu) {
    navMenu.classList.add('hidden');
  }

  // Remove click-outside handler
  if (clickOutsideHandler) {
    document.removeEventListener('click', clickOutsideHandler, true);
    clickOutsideHandler = null;
  }
  if (escapeHandler) {
    document.removeEventListener('keydown', escapeHandler);
    escapeHandler = null;
  }

  // ✅ CRITICAL FIX: Remove main click listener
  if (logoBtn && logoClickHandler) {
    logoBtn.removeEventListener('click', logoClickHandler);
    logoClickHandler = null;
    delete logoBtn.dataset.logoNavAttached;
  }

  isOpen = false;
  verbose.init('Logo nav destroyed', '/components/logoNav/logoNav.ts');
}
