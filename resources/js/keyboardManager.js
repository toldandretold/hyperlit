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
  
  if (keyboardOpen && keyboardOffset > 0) {
    console.log(`🔧 KeyboardManager: Keyboard OPEN - adjusting layout`);
    
    setKeyboardLayoutInProgress(true);
    
    // Calculate available space
    const availableHeight = window.visualViewport.height;
    const toolbarHeight = 60;
    const contentHeight = availableHeight - toolbarHeight - 10;
    
    console.log(`📱 KeyboardManager: Available: ${availableHeight}px, Content: ${contentHeight}px`);
    
    // 🆕 DEBUG: Check current state BEFORE changes
    console.log('🔍 BEFORE changes:');
    console.log('  - body classes:', body.className);
    console.log('  - mainContent exists:', !!mainContent);
    if (mainContent) {
      console.log('  - mainContent current height:', mainContent.style.height || 'not set');
      console.log('  - mainContent computed height:', getComputedStyle(mainContent).height);
      console.log('  - mainContent position:', getComputedStyle(mainContent).position);
    }
    
    // Add keyboard-open class to body
    body.classList.add('keyboard-open');
    
    // Set CSS custom properties
    document.documentElement.style.setProperty('--keyboard-offset', `${keyboardOffset}px`);
    document.documentElement.style.setProperty('--available-height', `${availableHeight}px`);
    document.documentElement.style.setProperty('--content-height', `${contentHeight}px`);
    
    // 🆕 FORCE the main-content styles directly with maximum priority
    if (mainContent) {
      // Store original styles first
      if (!mainContent._keyboardOriginalStyles) {
        mainContent._keyboardOriginalStyles = {
          height: mainContent.style.height,
          maxHeight: mainContent.style.maxHeight,
          position: mainContent.style.position,
          top: mainContent.style.top,
          left: mainContent.style.left,
          right: mainContent.style.right,
          overflowY: mainContent.style.overflowY,
          zIndex: mainContent.style.zIndex,
          paddingLeft: mainContent.style.paddingLeft,
          paddingRight: mainContent.style.paddingRight,
          paddingBottom: mainContent.style.paddingBottom
        };
      }
      
      // Apply styles with maximum force
      mainContent.style.setProperty('height', `${contentHeight}px`, 'important');
      mainContent.style.setProperty('max-height', `${contentHeight}px`, 'important');
      mainContent.style.setProperty('position', 'fixed', 'important');
      mainContent.style.setProperty('top', '0px', 'important');
      mainContent.style.setProperty('left', '0px', 'important');
      mainContent.style.setProperty('right', '0px', 'important');
      mainContent.style.setProperty('overflow-y', 'auto', 'important');
      mainContent.style.setProperty('z-index', '1000', 'important');
      mainContent.style.setProperty('padding-left', '20px', 'important');
      mainContent.style.setProperty('padding-right', '20px', 'important');
      mainContent.style.setProperty('padding-bottom', '80px', 'important');
      mainContent.style.setProperty('box-sizing', 'border-box', 'important');
      
      console.log('🔧 Applied direct styles with !important to main-content');
    }
    
    // 🆕 DEBUG: Check state AFTER changes
    setTimeout(() => {
      console.log('🔍 AFTER changes:');
      console.log('  - body classes:', body.className);
      console.log('  - CSS --content-height:', getComputedStyle(document.documentElement).getPropertyValue('--content-height'));
      
      if (mainContent) {
        const computedStyle = getComputedStyle(mainContent);
        console.log('  - mainContent.style.height:', mainContent.style.height);
        console.log('  - mainContent computed height:', computedStyle.height);
        console.log('  - mainContent computed position:', computedStyle.position);
        console.log('  - mainContent computed top:', computedStyle.top);
        console.log('  - mainContent getBoundingClientRect():', mainContent.getBoundingClientRect());
        
        // 🆕 EXTRA AGGRESSIVE: Try to force a reflow
        mainContent.offsetHeight; // Force reflow
        mainContent.style.display = 'block';
        
        console.log('  - After forced reflow, computed height:', getComputedStyle(mainContent).height);
      }
      
      setKeyboardLayoutInProgress(false);
      console.log('🔧 KeyboardManager: Layout changes complete, mutations re-enabled');
    }, 100);
    
  } else {
    console.log(`🔧 KeyboardManager: Keyboard CLOSED - resetting layout`);
    
    setKeyboardLayoutInProgress(true);
    
    // Remove keyboard-open class
    body.classList.remove('keyboard-open');
    
    // Remove CSS custom properties
    document.documentElement.style.removeProperty('--keyboard-offset');
    document.documentElement.style.removeProperty('--available-height');
    document.documentElement.style.removeProperty('--content-height');
    
    // 🆕 RESTORE original styles
    if (mainContent && mainContent._keyboardOriginalStyles) {
      const original = mainContent._keyboardOriginalStyles;
      
      // Remove all the forced styles
      mainContent.style.removeProperty('height');
      mainContent.style.removeProperty('max-height');
      mainContent.style.removeProperty('position');
      mainContent.style.removeProperty('top');
      mainContent.style.removeProperty('left');
      mainContent.style.removeProperty('right');
      mainContent.style.removeProperty('overflow-y');
      mainContent.style.removeProperty('z-index');
      mainContent.style.removeProperty('padding-left');
      mainContent.style.removeProperty('padding-right');
      mainContent.style.removeProperty('padding-bottom');
      mainContent.style.removeProperty('box-sizing');
      
      // Restore original values if they existed
      Object.keys(original).forEach(prop => {
        if (original[prop]) {
          mainContent.style[prop] = original[prop];
        }
      });
      
      delete mainContent._keyboardOriginalStyles;
      console.log('🔧 Restored original styles to main-content');
    }
    
    setTimeout(() => {
      setKeyboardLayoutInProgress(false);
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