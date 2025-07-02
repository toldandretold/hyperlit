// containerDrag.js

class ContainerDragger {
  constructor() {
    this.isDragging = false;
    this.isResizing = false;
    this.resizeDirection = null;
    this.currentContainer = null;
    this.startPos = { x: 0, y: 0 };
    this.startContainerPos = { x: 0, y: 0 };
    this.startContainerSize = { width: 0, height: 0 };
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
    const dragHandle = e.target.closest('.drag-handle');
    const resizeHandle = e.target.closest('.resize-handle');
    
    if (dragHandle) {
      this.startDrag(e, dragHandle);
    } else if (resizeHandle) {
      this.startResize(e, resizeHandle);
    }
  }

  handleTouchStart(e) {
    const dragHandle = e.target.closest('.drag-handle');
    const resizeHandle = e.target.closest('.resize-handle');
    
    if (dragHandle) {
      this.startDrag(e.touches[0], dragHandle);
    } else if (resizeHandle) {
      this.startResize(e.touches[0], resizeHandle);
    }
  }

  startDrag(event, dragHandle) {
    // Find the container
    this.currentContainer = dragHandle.closest('#highlight-container, #ref-container, #hypercite-container');
    if (!this.currentContainer) return;

    this.isDragging = true;
    
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

    // Add dragging class
    dragHandle.classList.add('dragging');
    document.body.classList.add('container-dragging');

    // Prevent text selection
    event.preventDefault();
  }

  startResize(event, resizeHandle) {
    // Find the container
    this.currentContainer = resizeHandle.closest('#highlight-container, #ref-container, #hypercite-container');
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
      width: rect.width,
      height: rect.height
    };

    // Add resizing class
    resizeHandle.classList.add('resizing');
    document.body.classList.add('container-resizing');

    // Prevent text selection
    event.preventDefault();
  }

  handleMouseMove(e) {
    if (this.isDragging) {
      this.drag(e.clientX, e.clientY);
    } else if (this.isResizing) {
      this.resize(e.clientX, e.clientY);
    }
  }

  handleTouchMove(e) {
    if (this.isDragging) {
      e.preventDefault(); // Prevent scrolling
      this.drag(e.touches[0].clientX, e.touches[0].clientY);
    } else if (this.isResizing) {
      e.preventDefault(); // Prevent scrolling
      this.resize(e.touches[0].clientX, e.touches[0].clientY);
    }
  }

  drag(clientX, clientY) {
    if (!this.currentContainer) return;

    // Calculate movement delta
    const deltaX = clientX - this.startPos.x;
    const deltaY = clientY - this.startPos.y;

    // Calculate new position
    const newX = this.startContainerPos.x + deltaX;
    const newY = this.startContainerPos.y + deltaY;

    // Constrain to viewport
    const containerRect = this.currentContainer.getBoundingClientRect();
    const maxX = window.innerWidth - containerRect.width;
    const maxY = window.innerHeight - containerRect.height;

    const constrainedX = Math.max(0, Math.min(newX, maxX));
    const constrainedY = Math.max(0, Math.min(newY, maxY));

    // Override the default positioning
    this.currentContainer.style.left = `${constrainedX}px`;
    this.currentContainer.style.top = `${constrainedY}px`;
    this.currentContainer.style.right = 'auto';
    this.currentContainer.style.bottom = 'auto';
  }

  resize(clientX, clientY) {
    if (!this.currentContainer) return;

    const deltaX = clientX - this.startPos.x;
    const deltaY = clientY - this.startPos.y;
    
    let newWidth = this.startContainerSize.width;
    let newHeight = this.startContainerSize.height;

    if (this.resizeDirection === 'left') {
      // Resize from left side - only change width, never move the container
      newWidth = this.startContainerSize.width - deltaX;
    } else {
      // Resize from right side - only change width
      newWidth = this.startContainerSize.width + deltaX;
    }

    // Also resize height based on vertical mouse movement
    newHeight = this.startContainerSize.height + deltaY;

    // Apply minimum constraints only (no maximum)
    const minWidth = 150;  // Smaller minimum
    const minHeight = 100; // Minimum height
    
    newWidth = Math.max(minWidth, newWidth);
    newHeight = Math.max(minHeight, newHeight);

    // Apply the new size - NEVER change position during resize
    this.currentContainer.style.width = `${newWidth}px`;
    this.currentContainer.style.height = `${newHeight}px`;
    
    // Keep original position unchanged
    this.currentContainer.style.left = `${this.startContainerPos.x}px`;
    this.currentContainer.style.top = `${this.startContainerPos.y}px`;
    this.currentContainer.style.right = 'auto';
    this.currentContainer.style.bottom = 'auto';
  }

  handleMouseUp() {
    this.endDragOrResize();
  }

  handleTouchEnd() {
    this.endDragOrResize();
  }

  endDragOrResize() {
    if (!this.isDragging && !this.isResizing) return;

    // Remove classes
    document.querySelector('.drag-handle.dragging')?.classList.remove('dragging');
    document.querySelector('.resize-handle.resizing')?.classList.remove('resizing');
    document.body.classList.remove('container-dragging', 'container-resizing');

    // Save the new position/size to customizations
    if (this.currentContainer && window.containerCustomizer) {
      const rect = this.currentContainer.getBoundingClientRect();
      const containerId = this.currentContainer.id;
      
      const customizations = {
        'left': `${rect.left}px`,
        'top': `${rect.top}px`,
        'right': 'auto',
        'bottom': 'auto'
      };

      // Add width and height if it was resized
      if (this.isResizing) {
        customizations.width = `${rect.width}px`;
        customizations.height = `${rect.height}px`;
      }
      
      window.containerCustomizer.updateContainer(containerId, customizations);
      
      console.log(`📍 Saved new ${this.isDragging ? 'position' : 'size'} for ${containerId}:`, customizations);
    }

    // Clear all inline styles so closing animation works
    if (this.currentContainer) {
      this.currentContainer.style.left = '';
      this.currentContainer.style.top = '';
      this.currentContainer.style.right = '';
      this.currentContainer.style.bottom = '';
      this.currentContainer.style.width = '';
      this.currentContainer.style.height = '';
      this.currentContainer.style.transform = '';
    }

    this.isDragging = false;
    this.isResizing = false;
    this.resizeDirection = null;
    this.currentContainer = null;
  }
}

// Initialize the dragger
const containerDragger = new ContainerDragger();

// Make it globally available
window.containerDragger = containerDragger;