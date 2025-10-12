// In resources/js/homepage.js

import './userContainer.js';
import { initializeHomepageButtons } from './homepageDisplayUnit.js';
import TogglePerimeterButtons from './togglePerimeterButtons.js';
import './newBookButton.js'; 
import { initializeLazyLoaderForContainer } from './initializePage.js';

export async function initializeHomepage() {
  console.log("🏠 Initializing homepage...");

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
    const userContainerModule = await import('./userContainer.js');
    if (userContainerModule.default && userContainerModule.default.rebindElements) {
      userContainerModule.default.rebindElements();
      console.log('✅ User button rebound after SPA transition');
      
      // Re-initialize user state after SPA transition
      if (userContainerModule.default.initializeUser) {
        await userContainerModule.default.initializeUser();
        console.log('✅ User state re-initialized after SPA transition');
      }
    }
    
    // Import and rebind newBookButton manager  
    const newBookModule = await import('./newBookButton.js');
    if (newBookModule.default && newBookModule.default.rebindElements) {
      newBookModule.default.rebindElements();
      console.log('✅ New book button rebound after SPA transition');
    }
  } catch (error) {
    console.warn('Could not rebind button managers:', error);
  }
  
  // Initialize homepage buttons - this will handle loading the initial content
  initializeHomepageButtons();
  
  updatePageLoadProgress(70, "Interface ready...");

  updatePageLoadProgress(90, "Finishing setup...");
  await new Promise(resolve => setTimeout(resolve, 100));

  // TogglePerimeterButtons are handled by readerDOMContentLoaded.js which is loaded by home.blade.php

  // Hide the progress overlay
  await hidePageLoadProgress();
}