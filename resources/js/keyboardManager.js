import { setKeyboardLayoutInProgress } from './operationState.js';

// keyboardManager.js
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
  const editToolbar = document.querySelector('#edit-toolbar');
  const navButtons = document.querySelector('#nav-buttons');
  
  if (keyboardOpen && keyboardOffset > 0) {
    console.log(`🔧 KeyboardManager: Keyboard OPEN - adjusting layout`);
    
    setKeyboardLayoutInProgress(true);
    
    // Calculate available space
    const availableHeight = window.visualViewport.height;
    const toolbarActualHeight = editToolbar ? editToolbar.getBoundingClientRect().height : 60;
    const contentHeight = availableHeight - toolbarActualHeight - 10;
    
    console.log(`📱 KeyboardManager: Available: ${availableHeight}px, Content: ${contentHeight}px`);
    
    // Add keyboard-open class to body (let CSS handle most of the styling)
    body.classList.add('keyboard-open');
    
    // 🔧 SIMPLE APPROACH: Just set CSS custom properties and let CSS do the work
    const visualTop = window.visualViewport.offsetTop || 0;
    
    document.documentElement.style.setProperty('--keyboard-visual-top', `${visualTop}px`);
    document.documentElement.style.setProperty('--keyboard-content-height', `${contentHeight}px`);
    document.documentElement.style.setProperty('--keyboard-available-height', `${availableHeight}px`);
    document.documentElement.style.setProperty('--keyboard-toolbar-height', `${toolbarActualHeight}px`);
    
    console.log(`🔧 Set CSS variables: top=${visualTop}px, height=${contentHeight}px`);
    
    // Only handle toolbar positioning in JS (since it needs precise calculation)
    if (editToolbar) {
      const toolbarTop = visualTop + availableHeight - toolbarActualHeight;
      editToolbar.style.setProperty('position', 'fixed', 'important');
      editToolbar.style.setProperty('top', `${toolbarTop}px`, 'important');
      editToolbar.style.setProperty('left', '0px', 'important');
      editToolbar.style.setProperty('right', '0px', 'important');
      editToolbar.style.setProperty('z-index', '999999', 'important');
      editToolbar.style.setProperty('background', 'rgba(34, 31, 32, 1)', 'important');
      
      console.log(`🔧 Positioned toolbar at top: ${toolbarTop}px`);
    }
    
    // Hide interfering elements
    document.querySelectorAll('#logoContainer, #topRightContainer, #userButtonContainer').forEach(el => {
      if (el) el.style.setProperty('display', 'none', 'important');
    });
    
    setTimeout(() => {
      setKeyboardLayoutInProgress(false);
      console.log('🔧 KeyboardManager: Layout changes complete');
    }, 100);
    
  } else {
    console.log(`🔧 KeyboardManager: Keyboard CLOSED - resetting layout`);
    
    setKeyboardLayoutInProgress(true);
    
    // Remove keyboard-open class
    body.classList.remove('keyboard-open');
    
    // Clear CSS custom properties
    document.documentElement.style.removeProperty('--keyboard-visual-top');
    document.documentElement.style.removeProperty('--keyboard-content-height');
    document.documentElement.style.removeProperty('--keyboard-available-height');
    document.documentElement.style.removeProperty('--keyboard-toolbar-height');
    
    // Reset toolbar
    if (editToolbar) {
      ['position', 'top', 'left', 'right', 'z-index', 'background'].forEach(prop => {
        editToolbar.style.removeProperty(prop);
      });
    }
    
    // Show navigation elements
    document.querySelectorAll('#logoContainer, #topRightContainer, #userButtonContainer').forEach(el => {
      if (el) el.style.removeProperty('display');
    });
    
    setTimeout(() => {
      setKeyboardLayoutInProgress(false);
      console.log('🔧 KeyboardManager: Cleanup complete');
    }, 100);
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
    document.documentElement.style.removeProperty('--content-height');
    
    // Clear any lingering flag
    window.keyboardLayoutInProgress = false;
    
    console.log('🧹 KeyboardManager: Destroyed');
  }
}

export { KeyboardManager };