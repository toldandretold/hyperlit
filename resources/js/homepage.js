// In resources/js/homepage.js

import './userContainer.js';
import { initializeHomepageButtons } from './homepageDisplayUnit.js';
import NavButtons from './nav-buttons.js';
import './newBookButton.js'; 
import { initializeLazyLoaderForContainer } from './initializePage.js';

export async function initializeHomepage() {
  console.log("🏠 Initializing homepage...");

  // Import progress functions
  let updatePageLoadProgress, hidePageLoadProgress;
  try {
    const progressModule = await import('./reader-DOMContentLoaded.js');
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
  
  // Initialize homepage buttons - this will handle loading the initial content
  initializeHomepageButtons();
  
  updatePageLoadProgress(70, "Interface ready...");

  updatePageLoadProgress(90, "Finishing setup...");
  await new Promise(resolve => setTimeout(resolve, 100));

  // NavButtons are handled by reader-DOMContentLoaded.js which is loaded by home.blade.php

  // Hide the progress overlay
  await hidePageLoadProgress();
}