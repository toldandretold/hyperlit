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
    console.log('  - editToolbar exists:', !!editToolbar);
    if (mainContent) {
      console.log('  - mainContent current height:', mainContent.style.height || 'not set');
      console.log('  - mainContent computed height:', getComputedStyle(mainContent).height);
      console.log('  - mainContent position:', getComputedStyle(mainContent).position);
    }
    if (editToolbar) {
      console.log('  - editToolbar current top:', editToolbar.style.top || 'not set');
      console.log('  - editToolbar computed top:', getComputedStyle(editToolbar).top);
      console.log('  - editToolbar position:', getComputedStyle(editToolbar).position);
    }
    
    // Add keyboard-open class to body
    body.classList.add('keyboard-open');
    
    // 🆕 POSITION EVERYTHING RELATIVE TO VISUAL VIEWPORT
    const visualTop = window.visualViewport.offsetTop || 0;
    const visualLeft = window.visualViewport.offsetLeft || 0;
    
    console.log(`📱 Visual viewport offset: top=${visualTop}, left=${visualLeft}`);
    console.log(`📱 Visual viewport size: ${window.visualViewport.width}x${window.visualViewport.height}`);
    
    // 1. Position main-content
    if (mainContent) {
      mainContent.style.setProperty('height', `${contentHeight}px`, 'important');
      mainContent.style.setProperty('max-height', `${contentHeight}px`, 'important');
      mainContent.style.setProperty('position', 'fixed', 'important');
      mainContent.style.setProperty('top', `${visualTop}px`, 'important');
      mainContent.style.setProperty('left', `${visualLeft}px`, 'important');
      mainContent.style.setProperty('width', `${window.visualViewport.width}px`, 'important');
      mainContent.style.setProperty('overflow-y', 'auto', 'important');
      mainContent.style.setProperty('z-index', '1000', 'important');
      mainContent.style.setProperty('padding-left', '20px', 'important');
      mainContent.style.setProperty('padding-right', '20px', 'important');
      mainContent.style.setProperty('padding-bottom', '70px', 'important'); // Space for toolbar
      mainContent.style.setProperty('box-sizing', 'border-box', 'important');
      
      console.log('🔧 Applied styles to main-content:');
      console.log(`   - position: fixed, top: ${visualTop}px, left: ${visualLeft}px`);
      console.log(`   - size: ${window.visualViewport.width}px x ${contentHeight}px`);
    }
    
    // 2. 🆕 POSITION EDIT TOOLBAR RELATIVE TO VISUAL VIEWPORT
    if (editToolbar) {
      const toolbarBottom = visualTop + availableHeight - toolbarHeight;
      editToolbar.style.setProperty('position', 'fixed', 'important');
      editToolbar.style.setProperty('top', `${toolbarBottom}px`, 'important'); // Position at bottom of visual viewport
      editToolbar.style.setProperty('left', `${visualLeft}px`, 'important');
      editToolbar.style.setProperty('width', `${window.visualViewport.width}px`, 'important');
      editToolbar.style.setProperty('z-index', '999999', 'important');
      editToolbar.style.setProperty('background', 'rgba(34, 31, 32, 1)', 'important');
      
      console.log(`🔧 Positioned toolbar at top: ${toolbarBottom}px (visual viewport bottom)`);
      console.log(`   - calculation: ${visualTop} + ${availableHeight} - ${toolbarHeight} = ${toolbarBottom}`);
    }
    
    // 3. Hide navigation elements (they're outside visual viewport anyway)
    document.querySelectorAll('#nav-buttons, #logoContainer, #topRightContainer, #userButtonContainer').forEach(el => {
      if (el) el.style.setProperty('display', 'none', 'important');
    });
    console.log('🔧 Hidden navigation elements');
    
    // 🆕 DEBUG: Check state AFTER changes
    setTimeout(() => {
      console.log('🔍 AFTER changes:');
      console.log('  - body classes:', body.className);
      
      if (mainContent) {
        const computedStyle = getComputedStyle(mainContent);
        console.log('  - mainContent.style.height:', mainContent.style.height);
        console.log('  - mainContent computed height:', computedStyle.height);
        console.log('  - mainContent computed position:', computedStyle.position);
        console.log('  - mainContent computed top:', computedStyle.top);
        console.log('  - mainContent getBoundingClientRect():', mainContent.getBoundingClientRect());
      }
      
      if (editToolbar) {
        const computedStyle = getComputedStyle(editToolbar);
        console.log('  - editToolbar.style.top:', editToolbar.style.top);
        console.log('  - editToolbar computed top:', computedStyle.top);
        console.log('  - editToolbar computed position:', computedStyle.position);
        console.log('  - editToolbar getBoundingClientRect():', editToolbar.getBoundingClientRect());
      }
      
      setKeyboardLayoutInProgress(false);
      console.log('🔧 KeyboardManager: Layout changes complete, mutations re-enabled');
    }, 100);
    
  } else {
    console.log(`🔧 KeyboardManager: Keyboard CLOSED - resetting layout`);
    
    setKeyboardLayoutInProgress(true);
    
    // Remove keyboard-open class
    body.classList.remove('keyboard-open');
    console.log('🔧 Removed keyboard-open class from body');
    
    // 🆕 RESET ALL ELEMENTS
    if (mainContent) {
      // Remove all forced styles from main-content
      ['height', 'max-height', 'position', 'top', 'left', 'width', 'overflow-y', 'z-index', 'padding-left', 'padding-right', 'padding-bottom', 'box-sizing'].forEach(prop => {
        mainContent.style.removeProperty(prop);
      });
      console.log('🔧 Removed forced styles from main-content');
    }
    
    if (editToolbar) {
      // Remove all forced styles from toolbar
      ['position', 'top', 'left', 'width', 'z-index', 'background'].forEach(prop => {
        editToolbar.style.removeProperty(prop);
      });
      console.log('🔧 Removed forced styles from edit-toolbar');
    }
    
    // Show navigation elements
    document.querySelectorAll('#nav-buttons, #logoContainer, #topRightContainer, #userButtonContainer').forEach(el => {
      if (el) el.style.removeProperty('display');
    });
    console.log('🔧 Restored navigation elements');
    
    setTimeout(() => {
      setKeyboardLayoutInProgress(false);
      console.log('🔧 KeyboardManager: Cleanup complete, mutations re-enabled');
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