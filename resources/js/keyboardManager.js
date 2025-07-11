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
  const logoContainer = document.querySelector('#logoContainer');
  const topRightContainer = document.querySelector('#topRightContainer');
  
  if (keyboardOpen && keyboardOffset > 0) {
    console.log(`🔧 KeyboardManager: Keyboard OPEN - adjusting layout`);
    
    setKeyboardLayoutInProgress(true);
    
    // 🔍 AGGRESSIVE DEBUGGING - Check actual computed styles
    [logoContainer, topRightContainer, navButtons].forEach(element => {
      if (element) {
        const beforeStyles = getComputedStyle(element);
        console.log(`🔍 BEFORE ${element.id}:`, {
          display: beforeStyles.display,
          opacity: beforeStyles.opacity,
          visibility: beforeStyles.visibility,
          pointerEvents: beforeStyles.pointerEvents,
          position: beforeStyles.position,
          classes: element.className,
          inlineStyle: element.style.cssText
        });
        
        // NUCLEAR OPTION - Force everything
        element.classList.remove('hidden-nav');
        element.style.setProperty('display', 'flex', 'important');
        element.style.setProperty('opacity', '1', 'important');
        element.style.setProperty('visibility', 'visible', 'important');
        element.style.setProperty('pointer-events', 'auto', 'important');
        
        // Check immediately after setting
        setTimeout(() => {
          const afterStyles = getComputedStyle(element);
          console.log(`🔍 AFTER ${element.id}:`, {
            display: afterStyles.display,
            opacity: afterStyles.opacity,
            visibility: afterStyles.visibility,
            pointerEvents: afterStyles.pointerEvents,
            position: afterStyles.position,
            classes: element.className,
            inlineStyle: element.style.cssText,
            boundingRect: element.getBoundingClientRect()
          });
          
          // Check if element is actually visible
          const rect = element.getBoundingClientRect();
          const isVisible = rect.width > 0 && rect.height > 0 && 
                           afterStyles.display !== 'none' && 
                           afterStyles.visibility !== 'hidden' && 
                           afterStyles.opacity !== '0';
          
          console.log(`🔍 ${element.id} IS ACTUALLY VISIBLE: ${isVisible}`);
          
          if (!isVisible) {
            console.log(`🚨 ${element.id} STILL NOT VISIBLE! Checking parent elements...`);
            
            // Check if parent elements are hiding it
            let parent = element.parentElement;
            while (parent && parent !== document.body) {
              const parentStyles = getComputedStyle(parent);
              console.log(`🔍 Parent ${parent.tagName}#${parent.id}:`, {
                display: parentStyles.display,
                opacity: parentStyles.opacity,
                visibility: parentStyles.visibility,
                overflow: parentStyles.overflow
              });
              parent = parent.parentElement;
            }
          }
        }, 50);
        
        console.log(`🔧 Applied nuclear visibility to ${element.id}`);
      }
    });
    
    // Calculate available space
    const availableHeight = window.visualViewport.height;
    const toolbarActualHeight = editToolbar ? editToolbar.getBoundingClientRect().height : 60;
    const contentHeight = availableHeight - toolbarActualHeight - 10;
    const visualTop = window.visualViewport.offsetTop || 0;
    
    console.log(`📱 KeyboardManager: Available: ${availableHeight}px, Content: ${contentHeight}px`);
    
    // Add keyboard-open class to body
    body.classList.add('keyboard-open');
    
    // Set CSS custom properties
    document.documentElement.style.setProperty('--keyboard-visual-top', `${visualTop}px`);
    document.documentElement.style.setProperty('--keyboard-content-height', `${contentHeight}px`);
    
    // Position toolbar
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
    
    // Only move nav buttons if they would be covered
    if (navButtons) {
      const navRect = navButtons.getBoundingClientRect();
      const keyboardTop = visualTop + availableHeight;
      
      if (navRect.bottom > keyboardTop) {
        const navButtonsTop = visualTop + availableHeight - toolbarActualHeight - 60;
        navButtons.style.setProperty('position', 'fixed', 'important');
        navButtons.style.setProperty('top', `${navButtonsTop}px`, 'important');
        navButtons.style.setProperty('right', '5px', 'important');
        navButtons.style.setProperty('z-index', '999998', 'important');
        
        console.log(`🔧 Repositioned nav buttons to: ${navButtonsTop}px`);
      }
    }
    
    setTimeout(() => {
      setKeyboardLayoutInProgress(false);
      console.log('🔧 KeyboardManager: Layout changes complete');
    }, 100);
    
  } else {
    // Reset code remains the same...
    console.log(`🔧 KeyboardManager: Keyboard CLOSED - resetting layout`);
    
    setKeyboardLayoutInProgress(true);
    body.classList.remove('keyboard-open');
    
    document.documentElement.style.removeProperty('--keyboard-visual-top');
    document.documentElement.style.removeProperty('--keyboard-content-height');
    
    if (editToolbar) {
      ['position', 'top', 'left', 'right', 'z-index', 'background'].forEach(prop => {
        editToolbar.style.removeProperty(prop);
      });
    }
    
    if (navButtons) {
      ['position', 'top', 'right', 'z-index'].forEach(prop => {
        navButtons.style.removeProperty(prop);
      });
    }
    
    // Reset navigation visibility overrides
    [logoContainer, topRightContainer, navButtons].forEach(element => {
      if (element) {
        ['display', 'opacity', 'visibility', 'pointer-events'].forEach(prop => {
          element.style.removeProperty(prop);
        });
        console.log(`🔧 Reset all visibility overrides for ${element.id}`);
      }
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