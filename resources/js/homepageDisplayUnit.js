import { loadHyperText, resetCurrentLazyLoader } from './initializePage.js';
import { setCurrentBook } from './app.js';
import { showNavigationLoading, hideNavigationLoading } from './scrolling.js';

// Fix header spacing dynamically based on actual header height
function fixHeaderSpacing() {
  const header = document.querySelector('.fixed-header');
  const wrapper = document.querySelector('.home-content-wrapper');
  
  if (header && wrapper) {
    const headerHeight = header.offsetHeight;
    // Add small buffer (10px) to ensure content doesn't touch header
    wrapper.style.paddingTop = (headerHeight + 10) + 'px';
  }
}

export function initializeHomepageButtons() {
  // Fix header spacing on initialization
  fixHeaderSpacing();
  
  // Run again on window resize to handle responsive changes
  window.addEventListener('resize', fixHeaderSpacing);
  
  // Initialize the default active content on page load  
  const activeButton = document.querySelector('.arranger-button.active');
  if (activeButton) {
    const initialTargetId = activeButton.dataset.content;
    transitionToBookContent(initialTargetId, false); // No loading overlay on initial load
  }
  
  document.querySelectorAll('.arranger-button').forEach(button => {
    button.addEventListener('click', async function() {
      const targetId = this.dataset.content;
      
      // Don't reinitialize if this button is already active
      if (this.classList.contains('active')) {
        console.log(`📄 ${targetId} is already active, skipping reinitialization`);
        return;
      }
      
      // Update button states
      document.querySelectorAll('.arranger-button').forEach(btn => btn.classList.remove('active'));
      this.classList.add('active');
      
      // Show loading overlay and transition to new content
      await transitionToBookContent(targetId, true);
    });
  });
}

async function transitionToBookContent(bookId, showLoader = true) {
  try {
    if (showLoader) {
      showNavigationLoading(`Loading ${bookId}...`);
    }
    
    console.log(`🔄 Transitioning homepage content to: ${bookId}`);
    
    // Remove existing content containers
    document.querySelectorAll('.main-content').forEach(content => {
      console.log(`🧹 Removing existing content container: ${content.id}`);
      content.remove();
    });
    
    // Create fresh container for the new content
    const mainContainer = document.querySelector('.home-content-wrapper');
    if (!mainContainer) {
      throw new Error('Home content wrapper not found');
    }
    
    const newContentDiv = document.createElement('div');
    newContentDiv.id = bookId;
    newContentDiv.className = 'main-content active-content';
    mainContainer.appendChild(newContentDiv);
    console.log(`✨ Created fresh content container: ${bookId}`);
    
    // Set the current book context (important for other systems)
    setCurrentBook(bookId);
    
    // Reset the current lazy loader so a fresh one gets created
    resetCurrentLazyLoader();
    
    // Use the same loading pipeline as regular page transitions
    await loadHyperText(bookId);
    
    console.log(`✅ Successfully loaded ${bookId} content`);
    
    if (showLoader) {
      hideNavigationLoading();
    }
    
  } catch (error) {
    console.error(`❌ Failed to transition to ${bookId}:`, error);
    if (showLoader) {
      hideNavigationLoading();
    }
    // Could show an error state here
  }
}
