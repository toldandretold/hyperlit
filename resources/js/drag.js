// containerDrag.js

class ContainerDragger {
  constructor() {
    this.isResizing = false;
    this.resizeDirection = null;
    this.currentContainer = null;
    this.startPos = { x: 0, y: 0 };
    this.startContainerPos = { x: 0, y: 0 };
    this.startContainerSize = { width: 0 };
    this.init();
  }

  init() {
    // Use event delegation for dynamically added drag handles
    document.addEventListener('mousedown', this.handleMouseDown.bind(this));
    document.addEventListener('mousemove', this.handleMouseMove.bind(this));
    document.addEventListener('mouseup', this.handleMouseUp.bind(this));
    
    // Touch events for mobile
    document.addEventListener('touchstart', this.handleTouchStart.bind(this));
    document.addEventListener('touchmove', this.handleTouchMove.bind(this));
    document.addEventListener('touchend', this.handleTouchEnd.bind(this));
  }

  handleMouseDown(e) {
    // Only handle resize, not drag
    const resizeHandle = e.target.closest('.resize-handle');

    if (resizeHandle) {
      this.startResize(e, resizeHandle);
    }
  }

  handleTouchStart(e) {
    // Only handle resize, not drag
    const resizeHandle = e.target.closest('.resize-handle');

    if (resizeHandle) {
      this.startResize(e.touches[0], resizeHandle);
    }
  }

  startResize(event, resizeHandle) {
    // Find the container
    this.currentContainer = resizeHandle.closest('#hyperlit-container');
    if (!this.currentContainer) return;

    this.isResizing = true;
    this.resizeDirection = resizeHandle.classList.contains('resize-left') ? 'left' : 'right';

    // Record starting positions
    this.startPos = {
      x: event.clientX,
      y: event.clientY
    };

    const rect = this.currentContainer.getBoundingClientRect();
    this.startContainerPos = {
      x: rect.left,
      y: rect.top
    };
    this.startContainerSize = {
      width: rect.width
    };

    // Store the right edge position (this should stay fixed)
    this.fixedRightEdge = rect.right;

    // Add resizing class
    resizeHandle.classList.add('resizing');
    document.body.classList.add('container-resizing');

    // Prevent text selection
    event.preventDefault();
  }

  handleMouseMove(e) {
    if (this.isResizing) {
      this.resize(e.clientX, e.clientY);
    }
  }

  handleTouchMove(e) {
    if (this.isResizing) {
      e.preventDefault(); // Prevent scrolling
      this.resize(e.touches[0].clientX, e.touches[0].clientY);
    }
  }

  resize(clientX, clientY) {
    if (!this.currentContainer) return;

    const deltaX = clientX - this.startPos.x;

    // Use the fixed right edge we stored at the start
    const rightEdge = this.fixedRightEdge;

    // Calculate the right offset from viewport right edge
    const viewportWidth = window.innerWidth;
    const rightOffset = viewportWidth - rightEdge;

    // New left position based on mouse movement
    let newLeft = this.startContainerPos.x + deltaX;

    // Calculate new width (fixed right edge - new left position)
    let newWidth = rightEdge - newLeft;

    // Apply minimum width constraint
    const minWidth = 150;
    if (newWidth < minWidth) {
      newWidth = minWidth;
      newLeft = rightEdge - minWidth;
    }

    // Apply maximum width constraint (left edge can't go closer than rightOffset from left edge)
    const maxWidth = rightEdge - rightOffset;
    if (newWidth > maxWidth) {
      newWidth = maxWidth;
      newLeft = rightEdge - maxWidth;
    }

    // Apply the new size using right-based positioning to match CSS
    this.currentContainer.style.setProperty('width', `${newWidth}px`, 'important');
    this.currentContainer.style.setProperty('max-width', 'none', 'important');
    this.currentContainer.style.setProperty('right', `${rightOffset}px`, 'important');
    this.currentContainer.style.setProperty('left', 'auto', 'important');
    this.currentContainer.style.setProperty('transform', 'translateX(0)', 'important');
  }

  handleMouseUp() {
    this.endDragOrResize();
  }

  handleTouchEnd() {
    this.endDragOrResize();
  }

  endDragOrResize() {
    if (!this.isResizing) return;

    // Remove classes
    document.querySelector('.resize-handle.resizing')?.classList.remove('resizing');
    document.body.classList.remove('container-resizing');

    // Save the new width and position to customizations
    if (this.currentContainer && window.containerCustomizer) {
      const rect = this.currentContainer.getBoundingClientRect();
      const containerId = this.currentContainer.id;

      const viewportWidth = window.innerWidth;
      const rightOffset = viewportWidth - rect.right;

      const customizations = {
        'width': `${rect.width}px`,
        'max-width': 'none',
        'right': `${rightOffset}px`,
        'left': 'auto',
        'transform': 'translateX(0)'
      };

      window.containerCustomizer.updateContainer(containerId, customizations);

      console.log(`📍 Saved new width for ${containerId}:`, customizations);
    }

    // Don't clear inline styles - let them persist
    // The containerCustomizer will apply them via stylesheet

    this.isResizing = false;
    this.resizeDirection = null;
    this.currentContainer = null;
  }
}

// Initialize the dragger
const containerDragger = new ContainerDragger();