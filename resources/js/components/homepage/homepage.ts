// resources/js/components/homepage/homepage.ts

import { log, verbose } from '../../utilities/logger.js';

let homepageBookActionsHandler: any = null;

export function destroyHomepageListeners() {
  if (homepageBookActionsHandler) {
    document.removeEventListener('click', homepageBookActionsHandler);
    homepageBookActionsHandler = null;
  }
}

export function initializeHomepageBookActions() {
  // Remove previous handler if exists (guard against double-init)
  if (homepageBookActionsHandler) {
    document.removeEventListener('click', homepageBookActionsHandler);
  }

  homepageBookActionsHandler = async (e: any) => {
    if ((window as any).isUserPage) return;
    const target = e.target.closest('.book-actions');
    if (!target) return;
    e.preventDefault();
    e.stopPropagation();

    const bookId = target.getAttribute('data-book');
    if (!bookId) return;

    const menuItems = [
      { id: 'preview', label: 'Preview', icon: '<svg viewBox="0 0 24 24"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>' },
      { id: 'add-to-shelf', label: 'Add to shelf', icon: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>' },
    ];

    const { showFloatingMenu } = await import('../floatingActionMenu/floatingActionMenu');
    showFloatingMenu(target, menuItems, async (action: any) => {
      switch (action) {
        case 'preview':
          const { showShelfPreview } = await import('../shelves/shelfPreview.js');
          showShelfPreview(bookId);
          break;
        case 'add-to-shelf':
          const { showAddToShelfMenu } = await import('../shelves/addToShelfMenu.js');
          showAddToShelfMenu(target, bookId);
          break;
      }
    });
  };
  document.addEventListener('click', homepageBookActionsHandler);
}

export async function initializeHomepage() {
  log.init("Homepage components initializing", '/components/homepage/homepage.ts');

  // Import progress functions
  let updatePageLoadProgress, hidePageLoadProgress;
  try {
    const progressModule = await import('../../pageLoad');
    updatePageLoadProgress = progressModule.updatePageLoadProgress;
    hidePageLoadProgress = progressModule.hidePageLoadProgress;
  } catch (e) {
    console.warn('Could not import progress functions:', e);
    // Create dummy functions if import fails
    updatePageLoadProgress = () => {};
    hidePageLoadProgress = () => {};
  }

  updatePageLoadProgress(10, "Loading homepage...");
  
  await new Promise(resolve => setTimeout(resolve, 100));
  updatePageLoadProgress(40, "Setting up interface...");
  await new Promise(resolve => setTimeout(resolve, 100));
  
  // Rebind button managers after SPA transition to ensure they reference correct DOM elements
  try {
    // Import and rebind userContainer manager
    const userContainerModule = await import('../userButton/userButton');
    if (userContainerModule.default && userContainerModule.default.rebindElements) {
      userContainerModule.default.rebindElements();
      verbose.init('User button rebound after SPA transition', '/components/homepage/homepage.ts');

      // Re-initialize user state after SPA transition
      if (userContainerModule.default.initializeUser) {
        await userContainerModule.default.initializeUser();
      }
    }

    // Import and initialize newBookButton manager
    const newBookModule = await import('../newBookButton/newBookButton');
    const newBookManager = newBookModule.initializeNewBookContainer();
    if (newBookManager) {
      verbose.init('New book button initialized', '/components/homepage/homepage.ts');
    }
  } catch (error) {
    console.warn('Could not rebind button managers:', error);
  }

  // Note: homepageDisplayUnit, homepageBookActions, shelfTabs are initialized via ButtonRegistry
  // Note: Homepage search is initialized via ButtonRegistry in registerComponents.ts

  updatePageLoadProgress(70, "Interface ready...");

  updatePageLoadProgress(90, "Finishing setup...");
  await new Promise(resolve => setTimeout(resolve, 100));

  // TogglePerimeterButtons are handled by readerDOMContentLoaded.js which is loaded by home.blade.php

  // Hide the progress overlay
  await hidePageLoadProgress();
}