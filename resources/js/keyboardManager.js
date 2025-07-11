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
      const toolbarHeight = toolbarActualHeight;
      const contentHeight = availableHeight - toolbarHeight - 10;
      
      console.log(`📱 KeyboardManager: Available: ${availableHeight}px, Content: ${contentHeight}px`);
      
      // 🆕 DEBUG: Check current state BEFORE changes
      console.log('🔍 BEFORE changes:');
      console.log('  - body classes:', body.className);
      console.log('  - mainContent exists:', !!mainContent);
      console.log('  - editToolbar exists:', !!editToolbar);
      console.log('  - navButtons exists:', !!navButtons);
      if (mainContent) {
        console.log('  - mainContent current height:', mainContent.style.height || 'not set');
        console.log('  - mainContent computed height:', getComputedStyle(mainContent).height);
        console.log('  - mainContent computed width:', getComputedStyle(mainContent).width);
        console.log('  - mainContent position:', getComputedStyle(mainContent).position);
      }
      
      // Add keyboard-open class to body
      body.classList.add('keyboard-open');
      
      // 🆕 POSITION EVERYTHING RELATIVE TO VISUAL VIEWPORT
      const visualTop = window.visualViewport.offsetTop || 0;
      const visualLeft = window.visualViewport.offsetLeft || 0;
      
      console.log(`📱 Visual viewport offset: top=${visualTop}, left=${visualLeft}`);
      console.log(`📱 Visual viewport size: ${window.visualViewport.width}x${window.visualViewport.height}`);
      
      // 1. Position main-content - PRESERVE ORIGINAL WIDTH CONSTRAINTS
      if (mainContent) {
        // 🔧 CAPTURE ORIGINAL WIDTH BEFORE CHANGING POSITION
        const originalComputedStyle = getComputedStyle(mainContent);
        const originalWidth = originalComputedStyle.width;
        const originalMaxWidth = originalComputedStyle.maxWidth;
        
        console.log(`🔧 Capturing original dimensions: width=${originalWidth}, maxWidth=${originalMaxWidth}`);
        
        mainContent.style.setProperty('height', `${contentHeight}px`, 'important');
        mainContent.style.setProperty('max-height', `${contentHeight}px`, 'important');
        mainContent.style.setProperty('position', 'fixed', 'important');
        mainContent.style.setProperty('top', `${visualTop}px`, 'important');
        mainContent.style.setProperty('left', '50%', 'important');
        mainContent.style.setProperty('transform', 'translateX(-50%)', 'important');
        
        // 🔧 EXPLICITLY PRESERVE WIDTH CONSTRAINTS
        if (originalMaxWidth && originalMaxWidth !== 'none') {
          mainContent.style.setProperty('max-width', originalMaxWidth, 'important');
        }
        if (originalWidth && !originalWidth.includes('px')) {
          // If original width was in ch, em, etc., preserve it
          mainContent.style.setProperty('width', originalWidth, 'important');
        } else {
          // If it was in px, use max-width constraint instead
          mainContent.style.setProperty('width', 'auto', 'important');
        }
        
        mainContent.style.setProperty('overflow-y', 'auto', 'important');
        mainContent.style.setProperty('z-index', '1000', 'important');
        mainContent.style.setProperty('padding-bottom', '90px', 'important');
        mainContent.style.setProperty('box-sizing', 'border-box', 'important');
        
        console.log('🔧 Applied styles to main-content:');
        console.log(`   - position: fixed, top: ${visualTop}px, centered horizontally`);
        console.log(`   - height: ${contentHeight}px, preserving width: ${originalWidth}, maxWidth: ${originalMaxWidth}`);
      }
      
      // Rest of your code remains the same...
      // 2. POSITION EDIT TOOLBAR RELATIVE TO VISUAL VIEWPORT
      if (editToolbar) {
        const toolbarTop = visualTop + availableHeight - toolbarHeight;
        editToolbar.style.setProperty('position', 'fixed', 'important');
        editToolbar.style.setProperty('top', `${toolbarTop}px`, 'important');
        editToolbar.style.setProperty('left', '0px', 'important');
        editToolbar.style.setProperty('right', '0px', 'important');
        editToolbar.style.setProperty('z-index', '999999', 'important');
        editToolbar.style.setProperty('background', 'rgba(34, 31, 32, 1)', 'important');
        
        console.log(`🔧 Positioned toolbar at top: ${toolbarTop}px (visual viewport bottom)`);
        console.log(`   - calculation: ${visualTop} + ${availableHeight} - ${toolbarHeight} = ${toolbarTop}`);
      }
      
      // 3. MOVE NAV BUTTONS UP (instead of hiding them)
      if (navButtons) {
        const navButtonsTop = visualTop + availableHeight - toolbarHeight - 200;
        navButtons.style.setProperty('position', 'fixed', 'important');
        navButtons.style.setProperty('top', `${navButtonsTop}px`, 'important');
        navButtons.style.setProperty('right', '10px', 'important');
        navButtons.style.setProperty('z-index', '999998', 'important');
        
        console.log(`🔧 Positioned nav buttons at top: ${navButtonsTop}px`);
      }
      
      // 4. Hide interfering elements
      document.querySelectorAll('#logoContainer, #topRightContainer, #userButtonContainer').forEach(el => {
        if (el) el.style.setProperty('display', 'none', 'important');
      });
      console.log('🔧 Hidden interfering navigation elements (kept nav-buttons visible)');
      
      // Debug after changes
      setTimeout(() => {
        console.log('🔍 AFTER changes:');
        console.log('  - body classes:', body.className);
        
        if (mainContent) {
          const computedStyle = getComputedStyle(mainContent);
          console.log('  - mainContent.style.height:', mainContent.style.height);
          console.log('  - mainContent.style.width:', mainContent.style.width);
          console.log('  - mainContent.style.maxWidth:', mainContent.style.maxWidth);
          console.log('  - mainContent computed height:', computedStyle.height);
          console.log('  - mainContent computed width:', computedStyle.width);
          console.log('  - mainContent computed maxWidth:', computedStyle.maxWidth);
          console.log('  - mainContent computed position:', computedStyle.position);
          console.log('  - mainContent computed top:', computedStyle.top);
          console.log('  - mainContent getBoundingClientRect():', mainContent.getBoundingClientRect());
        }
        
        // Rest of debug logging...
        
        setKeyboardLayoutInProgress(false);
        console.log('🔧 KeyboardManager: Layout changes complete, mutations re-enabled');
      }, 100);
      
    } else {
      // Reset logic remains the same but add width/max-width to the properties to remove
      console.log(`🔧 KeyboardManager: Keyboard CLOSED - resetting layout`);
      
      setKeyboardLayoutInProgress(true);
      
      body.classList.remove('keyboard-open');
      console.log('🔧 Removed keyboard-open class from body');
      
      if (mainContent) {
        // 🔧 ALSO REMOVE WIDTH CONSTRAINTS WE ADDED
        ['height', 'max-height', 'position', 'top', 'left', 'transform', 'width', 'overflow-y', 'z-index', 'padding-bottom', 'box-sizing'].forEach(prop => {
          mainContent.style.removeProperty(prop);
        });
        console.log('🔧 Removed forced styles from main-content');
      }
      
      // Rest of reset logic remains the same...
      if (editToolbar) {
        ['position', 'top', 'left', 'right', 'z-index', 'background'].forEach(prop => {
          editToolbar.style.removeProperty(prop);
        });
        console.log('🔧 Removed forced styles from edit-toolbar');
      }
      
      if (navButtons) {
        ['position', 'top', 'right', 'z-index'].forEach(prop => {
          navButtons.style.removeProperty(prop);
        });
        console.log('🔧 Removed forced styles from nav-buttons');
      }
      
      document.querySelectorAll('#logoContainer, #topRightContainer, #userButtonContainer').forEach(el => {
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