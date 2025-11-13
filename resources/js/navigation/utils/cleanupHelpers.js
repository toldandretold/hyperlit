/**
 * Cleanup Helpers - Shared cleanup logic for navigation transitions
 * Extracted from DifferentTemplateTransition for reusability
 */

import { cleanupReaderView } from '../../viewManager.js';
import { resetEditModeState } from '../../components/editButton.js';
import { destroyUserContainer } from '../../components/userContainer.js';
import { destroyNewBookContainer } from '../../components/newBookButton.js';
import { destroyHomepageDisplayUnit } from '../../homepageDisplayUnit.js';
import { destroyUserProfileEditor } from '../../components/userProfileEditor.js';
import { destroyLogoNav } from '../../components/logoNavToggle.js';
import { closeHyperlitContainer } from '../../hyperlitContainer/index.js';
import sourceManager from '../../components/sourceButton.js';

/**
 * Clean up reader state
 * Extracted from DifferentTemplateTransition.cleanupReader()
 */
export async function cleanupReader() {

  try {
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
    // Destroy homepage-specific managers
    // Already imported statically
    if (typeof destroyUserContainer === 'function') {
      destroyUserContainer();
    }

    // Already imported statically
    if (typeof destroyNewBookContainer === 'function') {
      destroyNewBookContainer();
    }

    // Already imported statically
    if (typeof destroyHomepageDisplayUnit === 'function') {
      destroyHomepageDisplayUnit();
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
    // Already imported statically
    closeHyperlitContainer();

    // Close source container if open
    const sourceButton = document.getElementById('cloudRef');
    if (sourceButton) {
      // sourceManager already imported statically
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
export async function cleanupFromStructure(fromStructure) {

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
