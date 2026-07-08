/**
 * Cleanup Helpers - Shared cleanup logic for navigation transitions
 * Extracted from DifferentTemplateTransition for reusability
 */

import { cleanupReaderView } from '../../viewManager';
import { resetEditModeState } from '../../../components/editButton/index';
import { destroyUserContainer } from '../../../components/userButton/userButton';
import { destroyUserProfileEditor } from '../../../components/userProfile/userProfileEditor';
import { destroyLogoNav } from '../../../components/logoNav/logoNav';
import { closeHyperlitContainer, hyperlitManager } from '../../../hyperlitContainer/index';
import { buttonRegistry } from '../../../components/utilities/buttonRegistry';

/**
 * SYNCHRONOUS hard-reset of any open hyperlit-container state. Runs at the very start of reader
 * cleanup — BEFORE the async close + body swap. Under CPU contention a late async op from a rapid
 * back/forward can otherwise leave `#hyperlit-container.open` (+ `body.hyperlit-container-open`,
 * `#ref-overlay.active`) on the home page after the swap (the `container-persisted-across-nav`
 * flake). Stripping the visible state synchronously here defangs that stale state immediately; the
 * async `closeOpenContainers()` still runs afterwards for history-state + listener cleanup. No-op
 * when nothing is open. Nothing relies on a container surviving a reader→home/user nav.
 */
function forceClearOpenContainers() {
  const base = document.getElementById('hyperlit-container');
  const anyOpen = !!base?.classList.contains('open')
    || !!document.querySelector('.hyperlit-container-stacked.open')
    || document.body.classList.contains('hyperlit-container-open');
  if (!anyOpen) return;

  base?.classList.remove('open');
  document.querySelectorAll('.hyperlit-container-stacked').forEach((el) => el.remove());
  document.getElementById('ref-overlay')?.classList.remove('active');
  document.querySelectorAll('.ref-overlay-stacked').forEach((el) => el.remove());
  document.body.classList.remove('hyperlit-container-open');

  // Reset the live manager so a later reader entry rebinds clean (a stale isOpen=true would make
  // initializeHyperlitManagerInternal rebind-instead-of-recreate and suppress the next open).
  if (hyperlitManager) {
    try {
      hyperlitManager.isOpen = false;
      hyperlitManager._releaseFocusTrap?.();
    } catch { /* non-fatal */ }
  }
}

/**
 * Clean up reader state
 * Extracted from DifferentTemplateTransition.cleanupReader()
 */
export async function cleanupReader() {

  try {
    // Hard-reset any open container FIRST (synchronous) so a late async op can't leave it on the
    // next page — see forceClearOpenContainers().
    forceClearOpenContainers();

    // Use existing cleanup from viewManager
    // Already imported statically
    cleanupReaderView();

    // Reset edit mode state
    // Already imported statically
    resetEditModeState();

    // Destroy user container (reader pages also have userButton)
    // Already imported statically
    if (typeof destroyUserContainer === 'function') {
      destroyUserContainer();
    }

    // Close any open containers
    await closeOpenContainers();

  } catch (error) {
    console.warn('Reader cleanup failed:', error);
  }
}

/**
 * Clean up home state
 * Extracted from DifferentTemplateTransition.cleanupHome()
 */
export async function cleanupHome() {

  try {
    // Destroy all registered button managers (search toolbar, etc.)
    buttonRegistry.destroyAll();

    // Destroy homepage-specific managers
    if (typeof destroyUserContainer === 'function') {
      destroyUserContainer();
    }

    // Dynamically import to avoid circular dependency
    const { destroyNewBookContainer } = await import('../../../components/newBookButton/newBookButton');
    if (typeof destroyNewBookContainer === 'function') {
      destroyNewBookContainer();
    }

    // Close any open containers
    await closeOpenContainers();

  } catch (error) {
    console.warn('Home cleanup failed:', error);
  }
}

/**
 * Clean up user state
 * Extracted from DifferentTemplateTransition.cleanupUser()
 */
export async function cleanupUser() {
  try {
    // 🧹 CRITICAL: Destroy user profile editor first
    // Already imported statically
    if (typeof destroyUserProfileEditor === 'function') {
      destroyUserProfileEditor();
    }

    // User pages have same managers as home pages
    await cleanupHome();

  } catch (error) {
    console.warn('User cleanup failed:', error);
  }
}

/**
 * Clean up logo navigation toggle (common to all page types)
 * Extracted from DifferentTemplateTransition.cleanupFromStructure()
 */
export async function cleanupLogoNav() {
  try {
    // Already imported statically
    if (typeof destroyLogoNav === 'function') {
      destroyLogoNav();
    }
  } catch (error) {
    console.warn('Logo nav cleanup failed:', error);
  }
}

/**
 * Close any open containers
 * Extracted from DifferentTemplateTransition.closeOpenContainers()
 */
export async function closeOpenContainers() {
  try {
    await closeHyperlitContainer();

    // Close source container if open
    const sourceButton = document.getElementById('cloudRef');
    if (sourceButton) {
      // Dynamically import to avoid circular dependency
      const sourceButtonModule = await import('../../../components/sourceContainer/index');
      const sourceManager = sourceButtonModule.default;
      if (sourceManager && sourceManager.isOpen) {
        sourceManager.closeContainer();
      }
    }
  } catch (error) {
    console.warn('Container closing failed:', error);
  }
}

/**
 * Structure-aware cleanup dispatcher
 * Routes to the appropriate cleanup function based on page structure
 */
export async function cleanupFromStructure(fromStructure: any) {

  try {
    // 🧹 Cleanup logo navigation toggle (present on all page types)
    await cleanupLogoNav();

    switch (fromStructure) {
      case 'reader':
        await cleanupReader();
        break;

      case 'home':
        await cleanupHome();
        break;

      case 'user':
        await cleanupUser();
        break;

      default:
        console.warn(`Unknown fromStructure: ${fromStructure}, skipping cleanup`);
    }
  } catch (error) {
    console.warn(`Cleanup from ${fromStructure} failed:`, error);
  }
}
