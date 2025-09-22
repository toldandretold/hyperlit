import { loadHyperText, resetCurrentLazyLoader } from './initializePage.js';
import { setCurrentBook } from './app.js';
import { showNavigationLoading, hideNavigationLoading } from './scrolling.js';

let resizeHandler = null;
const buttonHandlers = new Map();

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

// Align header content with main content text dynamically
function alignHeaderContent() {
  const mainContent = document.querySelector('body[data-page="home"] .main-content');
  const imageContainer = document.getElementById('imageContainer');
  const buttonsContainer = document.querySelector('.arranger-buttons-container');
  
  if (mainContent && imageContainer && buttonsContainer) {
    // Calculate the left edge of the actual text content
    const mainContentRect = mainContent.getBoundingClientRect();
    const mainContentPadding = parseInt(getComputedStyle(mainContent).paddingLeft);
    const textLeftEdge = mainContentRect.left + mainContentPadding;
    
    // Get current position of image container (without any margin)
    imageContainer.style.marginLeft = '0px'; // Reset to get base position
    const imageRect = imageContainer.getBoundingClientRect();
    
    // Calculate needed offset from the image's current position
    const neededMargin = textLeftEdge - imageRect.left;
    
    // Apply the calculated margin
    imageContainer.style.marginLeft = neededMargin + 'px';
    buttonsContainer.style.marginLeft = neededMargin + 'px';
  }
}

export function initializeHomepageButtons() {
  // First, ensure any old listeners are cleaned up
  destroyHomepageDisplayUnit();

  // Fix header spacing on initialization
  fixHeaderSpacing();
  
  // Align header content with text content
  alignHeaderContent();
  
  // Set up and store the resize handler
  resizeHandler = () => {
    fixHeaderSpacing();
    alignHeaderContent();
  };
  window.addEventListener('resize', resizeHandler);
  
  // Initialize the default active content on page load  
  const activeButton = document.querySelector('.arranger-button.active');
  if (activeButton) {
    const initialTargetId = activeButton.dataset.content;
    transitionToBookContent(initialTargetId, false); // No loading overlay on initial load
  }
  
  document.querySelectorAll('.arranger-button').forEach(button => {
    const handler = async function() {
      const targetId = this.dataset.content;
      
      if (this.classList.contains('active')) {
        console.log(`📄 ${targetId} is already active, skipping reinitialization`);
        return;
      }
      
      document.querySelectorAll('.arranger-button').forEach(btn => btn.classList.remove('active'));
      this.classList.add('active');
      
      await transitionToBookContent(targetId, true);
    };
    button.addEventListener('click', handler);
    buttonHandlers.set(button, handler); // Store handler for cleanup
  });
}

export function destroyHomepageDisplayUnit() {
  if (resizeHandler) {
    window.removeEventListener('resize', resizeHandler);
    resizeHandler = null;
    console.log('🧹 Homepage resize listener removed.');
  }

  buttonHandlers.forEach((handler, button) => {
    button.removeEventListener('click', handler);
  });
  buttonHandlers.clear();
  console.log('🧹 Homepage arranger button listeners removed.');
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
    
    // Realign header content after new content is loaded
    alignHeaderContent();
    
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

