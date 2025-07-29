import './userContainer.js';
import { initializeHomepageButtons } from './homepageDisplayUnit.js';
import NavButtons from './nav-buttons.js';
// ✅ We need to import this to initialize it
import './newBookButton.js'; 

export function initializeHomepage() {
  console.log("🏠 Initializing homepage...");

  initializeHomepageButtons();

  const navButtons = new NavButtons({
    elementIds: ["userButtonContainer", "topRightContainer"],
    tapThreshold: 15,
  });
  navButtons.init();
}