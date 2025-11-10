/**
 * Logo Navigation Toggle
 * Handles the logo button that rotates and shows/hides navigation menu
 */

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
    console.log('ℹ️ Logo nav: Elements not found, skipping initialization');
    return;
  }

  console.log('🔧 Initializing logo navigation toggle');

  // Click handler for logo button
  logoBtn.addEventListener('click', (e) => {
    console.log('🖱️ Logo button clicked!', {
      currentState: isOpen ? 'open' : 'closed',
      target: e.target,
      currentTarget: e.currentTarget,
      hasRotatedClass: logoBtn.classList.contains('rotated')
    });
    e.stopPropagation(); // Prevent immediate close from document click
    toggleLogoNav();
  });

  console.log('✅ Logo navigation toggle initialized');
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
  console.log('📖 Opening logo navigation menu');

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

      console.log('🔍 Click-outside check:', {
        clickedElement: e.target,
        clickedLogo,
        clickedMenu,
        shouldClose: !clickedLogo && !clickedMenu
      });

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
  console.log('📕 Closing logo navigation menu');

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
  console.log('🧹 Logo navigation toggle destroyed');
}
