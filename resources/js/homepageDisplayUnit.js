import { initializeLazyLoaderForContainer } from './initializePage.js';

export function initializeHomepageButtons() {
  // Initialize the default active content on page load
  const activeButton = document.querySelector('.arranger-button.active');
  if (activeButton) {
    const initialTargetId = activeButton.dataset.content;
    initializeLazyLoaderForContainer(initialTargetId);
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
      
      // Update content visibility
      document.querySelectorAll('.main-content').forEach(content => {
        content.classList.remove('active-content');
        content.classList.add('hidden-content');
      });
      
      document.getElementById(targetId).classList.remove('hidden-content');
      document.getElementById(targetId).classList.add('active-content');
      
      // Initialize lazy loader for this specific container/book
      await initializeLazyLoaderForContainer(targetId);
    });
  });
}
