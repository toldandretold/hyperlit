/**
 * Logo Navigation Toggle
 * Handles the logo button that rotates and shows/hides navigation menu
 */

import { log, verbose } from '../utilities/logger.js';

let isOpen = false;
let clickOutsideHandler = null;

/**
 * Initialize logo navigation toggle
 */
export function initializeLogoNav() {
  const logoBtn = document.getElementById('logoContainer');
  const logoWrapper = document.getElementById('logoNavWrapper');
  const navMenu = document.getElementById('logoNavMenu');

  if (!logoBtn || !navMenu || !logoWrapper) {
    return;
  }

  log.init('Logo navigation toggle initialized', '/components/logoNavToggle.js');

  // Click handler for logo button
  logoBtn.addEventListener('click', (e) => {
    e.stopPropagation(); // Prevent immediate close from document click
    toggleLogoNav();
  });
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
function openLogoNav(logoBtn, navMenu) {
  // Rotate logo
  logoBtn.classList.add('rotated');

  // Show menu
  navMenu.classList.remove('hidden');

  // Add click-outside handler
  setTimeout(() => {
    clickOutsideHandler = (e) => {
      // Check if click is outside both logo button and menu
      const clickedLogo = logoBtn.contains(e.target);
      const clickedMenu = navMenu.contains(e.target);

      if (!clickedLogo && !clickedMenu) {
        closeLogoNav(logoBtn, navMenu);
      }
    };
    document.addEventListener('click', clickOutsideHandler);
  }, 0);
}

/**
 * Close logo navigation menu
 */
function closeLogoNav(logoBtn, navMenu) {
  isOpen = false;

  // Rotate logo back
  logoBtn.classList.remove('rotated');

  // Hide menu
  navMenu.classList.add('hidden');

  // Remove click-outside handler
  if (clickOutsideHandler) {
    document.removeEventListener('click', clickOutsideHandler);
    clickOutsideHandler = null;
  }
}

/**
 * Cleanup function for navigation transitions
 */
export function destroyLogoNav() {
  const logoBtn = document.getElementById('logoContainer');
  const navMenu = document.getElementById('logoNavMenu');

  if (logoBtn) {
    logoBtn.classList.remove('rotated');
  }

  if (navMenu) {
    navMenu.classList.add('hidden');
  }

  if (clickOutsideHandler) {
    document.removeEventListener('click', clickOutsideHandler);
    clickOutsideHandler = null;
  }

  isOpen = false;
}
