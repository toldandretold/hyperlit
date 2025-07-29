// In resources/js/homepage.js

import './userContainer.js';
import { initializeHomepageButtons } from './homepageDisplayUnit.js';
import NavButtons from './nav-buttons.js';
import './newBookButton.js'; 
import { initializeLazyLoaderForContainer } from './initializePage.js';

export function initializeHomepage() {
  console.log("🏠 Initializing homepage...");

  // ✅ STEP 1: START LOADING THE CONTENT FIRST.
  // This function is asynchronous, so it will start loading in the background.
  // This ensures the DOM will begin to populate immediately.
  initializeLazyLoaderForContainer('most-recent');

  // ✅ STEP 2: INITIALIZE THE UI BUTTONS AFTER.
  // By the time these run, the content loading has already begun,
  // making the layout measurements more reliable.
  initializeHomepageButtons();

  const navButtons = new NavButtons({
    elementIds: ["userButtonContainer", "topRightContainer"],
    tapThreshold: 15,
  });
  navButtons.init();
}