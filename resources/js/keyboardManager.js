// keyboardManager.js or in your main JS file
class KeyboardManager {
  constructor() {
    this.isIOS = /iPhone|iPad|iPod/.test(window.navigator.userAgent);
    this.initialVisualHeight = null;
    this.isKeyboardOpen = false;
    
    this.init();
  }
  
  init() {
    if (!('visualViewport' in window)) {
      console.warn('Visual Viewport API not supported');
      return;
    }
    
    // Store initial height
    this.initialVisualHeight = window.visualViewport.height;
    
    // Listen for viewport changes
    window.visualViewport.addEventListener('resize', this.handleViewportChange.bind(this));
    
    console.log('🔧 KeyboardManager: Initialized', {
      isIOS: this.isIOS,
      initialHeight: this.initialVisualHeight
    });
  }
  
  handleViewportChange() {
    const viewport = window.visualViewport;
    let referenceHeight;
    
    // Use the demo's approach
    if (this.isIOS) {
      referenceHeight = this.initialVisualHeight;
    } else {
      referenceHeight = viewport.height;
    }
    
    const keyboardOffset = referenceHeight - viewport.height;
    const keyboardOpen = keyboardOffset > 50;
    
    console.log('📱 KeyboardManager: Viewport change', {
      referenceHeight,
      viewportHeight: viewport.height,
      keyboardOffset,
      keyboardOpen,
      isIOS: this.isIOS
    });
    
    if (keyboardOpen !== this.isKeyboardOpen) {
      this.isKeyboardOpen = keyboardOpen;
      this.adjustLayout(keyboardOffset, keyboardOpen);
    }
  }
  
  adjustLayout(keyboardOffset, keyboardOpen) {
    const body = document.body;
    const mainContent = document.querySelector('.main-content');
    
    if (keyboardOpen && keyboardOffset > 0) {
      console.log(`🔧 KeyboardManager: Keyboard OPEN - adjusting layout`);
      
      // Add keyboard-open class to body for CSS targeting
      body.classList.add('keyboard-open');
      
      // Calculate available space
      const availableHeight = window.visualViewport.height;
      const toolbarHeight = 50; // Edit toolbar height
      const contentHeight = availableHeight - toolbarHeight - 20; // 20px buffer
      
      console.log(`📱 KeyboardManager: Available: ${availableHeight}px, Content: ${contentHeight}px`);
      
      // Adjust main content
      if (mainContent) {
        mainContent.style.height = `${contentHeight}px`;
        mainContent.style.maxHeight = `${contentHeight}px`;
        mainContent.style.overflowY = 'auto';
        mainContent.style.position = 'fixed';
        mainContent.style.top = '0px';
        mainContent.style.left = '0px';
        mainContent.style.right = '0px';
        mainContent.style.paddingBottom = `${toolbarHeight + 10}px`;
      }
      
      // Set CSS custom property for other elements to use
      document.documentElement.style.setProperty('--keyboard-offset', `${keyboardOffset}px`);
      document.documentElement.style.setProperty('--available-height', `${availableHeight}px`);
      
      // Scroll to keep focused element visible
      this.scrollToFocusedElement();
      
    } else {
      console.log(`🔧 KeyboardManager: Keyboard CLOSED - resetting layout`);
      
      // Remove keyboard-open class
      body.classList.remove('keyboard-open');
      
      // Reset main content
      if (mainContent) {
        mainContent.style.height = '';
        mainContent.style.maxHeight = '';
        mainContent.style.overflowY = '';
        mainContent.style.position = '';
        mainContent.style.top = '';
        mainContent.style.left = '';
        mainContent.style.right = '';
        mainContent.style.paddingBottom = '';
      }
      
      // Remove CSS custom properties
      document.documentElement.style.removeProperty('--keyboard-offset');
      document.documentElement.style.removeProperty('--available-height');
    }
  }
  
  scrollToFocusedElement() {
    const activeElement = document.activeElement;
    if (!activeElement || activeElement === document.body) return;
    
    // Small delay to let layout settle
    setTimeout(() => {
      const rect = activeElement.getBoundingClientRect();
      const mainContent = document.querySelector('.main-content');
      
      if (mainContent && rect.top > 0) {
        const toolbarHeight = 50;
        const visibleBottom = window.visualViewport.height - toolbarHeight - 20;
        
        if (rect.bottom > visibleBottom) {
          const scrollOffset = rect.bottom - visibleBottom + 20;
          mainContent.scrollTop += scrollOffset;
          console.log(`📜 KeyboardManager: Scrolled ${scrollOffset}px to show focused element`);
        }
      }
    }, 100);
  }
  
  destroy() {
    if ('visualViewport' in window) {
      window.visualViewport.removeEventListener('resize', this.handleViewportChange);
    }
    
    // Reset any applied styles
    document.body.classList.remove('keyboard-open');
    document.documentElement.style.removeProperty('--keyboard-offset');
    document.documentElement.style.removeProperty('--available-height');
    
    console.log('🧹 KeyboardManager: Destroyed');
  }
}



export { KeyboardManager };