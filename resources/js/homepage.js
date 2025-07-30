// In resources/js/homepage.js

import './userContainer.js';
import { initializeHomepageButtons } from './homepageDisplayUnit.js';
import NavButtons from './nav-buttons.js';
import './newBookButton.js'; 
import { initializeLazyLoaderForContainer } from './initializePage.js';

export function initializeHomepage() {
  console.log("🏠 Initializing homepage...");

  initializeLazyLoaderForContainer('most-recent');
  initializeHomepageButtons();

  // This is correct. Create a new manager for this page.
  const navButtons = new NavButtons({
    elementIds: ["userButtonContainer", "topRightContainer"],
    tapThreshold: 15,
  });
  navButtons.init();
}