/**
 * Navigation System Index
 * Provides easy access to all navigation components
 */

// Core navigation manager
export { NavigationManager } from './NavigationManager.js';

// Progress overlay management
export { ProgressOverlayConductor } from './ProgressOverlayConductor.js';
export { ProgressOverlayEnactor } from './ProgressOverlayEnactor.js';

// Link handling
export { LinkNavigationHandler } from './LinkNavigationHandler.js';

// Individual pathways
export { FreshPageLoader } from './pathways/FreshPageLoader.js';
export { NewBookTransition } from './pathways/NewBookTransition.js';
export { ImportBookTransition } from './pathways/ImportBookTransition.js';
export { BookToBookTransition } from './pathways/BookToBookTransition.js';

// Legacy compatibility - these maintain the same API as viewManager.js
export async function initializeReaderView(progressCallback = null) {
  const { NavigationManager } = await import('./NavigationManager.js');
  return await NavigationManager.initializeReaderView(progressCallback);
}

export async function transitionToReaderView(bookId, hash = '', progressCallback = null) {
  const { NavigationManager } = await import('./NavigationManager.js');
  return await NavigationManager.transitionToReaderView(bookId, hash, progressCallback);
}

export async function initializeImportedBook(bookId) {
  const { NavigationManager } = await import('./NavigationManager.js');
  return await NavigationManager.initializeImportedBook(bookId);
}

// Smart navigation helper
export async function smartNavigate(context) {
  const { NavigationManager } = await import('./NavigationManager.js');
  return await NavigationManager.smartNavigate(context);
}