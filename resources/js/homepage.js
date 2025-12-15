// In resources/js/homepage.js

import { initializeHomepageButtons } from './homepageDisplayUnit.js';
import TogglePerimeterButtons from './components/togglePerimeterButtons.js';
import { initializeLazyLoaderForContainer } from './initializePage.js';
import { log, verbose } from './utilities/logger.js';

export async function initializeHomepage() {
  log.init("Homepage components initializing", 'homepage.js');

  // Import progress functions
  let updatePageLoadProgress, hidePageLoadProgress;
  try {
    const progressModule = await import('./readerDOMContentLoaded.js');
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
    const userContainerModule = await import('./components/userContainer.js');
    if (userContainerModule.default && userContainerModule.default.rebindElements) {
      userContainerModule.default.rebindElements();
      verbose.init('User button rebound after SPA transition', 'homepage.js');

      // Re-initialize user state after SPA transition
      if (userContainerModule.default.initializeUser) {
        await userContainerModule.default.initializeUser();
      }
    }

    // Import and initialize newBookButton manager
    const newBookModule = await import('./components/newBookButton.js');
    const newBookManager = newBookModule.initializeNewBookContainer();
    if (newBookManager) {
      verbose.init('New book button initialized', 'homepage.js');
    }
  } catch (error) {
    console.warn('Could not rebind button managers:', error);
  }
  
  // Initialize homepage buttons - this will handle loading the initial content
  initializeHomepageButtons();

  // Note: Homepage search is initialized via ButtonRegistry in registerComponents.js

  updatePageLoadProgress(70, "Interface ready...");

  updatePageLoadProgress(90, "Finishing setup...");
  await new Promise(resolve => setTimeout(resolve, 100));

  // TogglePerimeterButtons are handled by readerDOMContentLoaded.js which is loaded by home.blade.php

  // Hide the progress overlay
  await hidePageLoadProgress();
}