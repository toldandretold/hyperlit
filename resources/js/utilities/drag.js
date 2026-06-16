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
    this._onMouseDown = this.handleMouseDown.bind(this);
    this._onMouseMove = this.handleMouseMove.bind(this);
    this._onMouseUp = this.handleMouseUp.bind(this);
    this._onTouchStart = this.handleTouchStart.bind(this);
    this._onTouchMove = this.handleTouchMove.bind(this);
    this._onTouchEnd = this.handleTouchEnd.bind(this);

    document.addEventListener('mousedown', this._onMouseDown);
    document.addEventListener('mousemove', this._onMouseMove);
    document.addEventListener('mouseup', this._onMouseUp);

    // Touch events for mobile
    document.addEventListener('touchstart', this._onTouchStart);
    document.addEventListener('touchmove', this._onTouchMove);
    document.addEventListener('touchend', this._onTouchEnd);
  }

  /**
   * Force-reset any stale resize state.
   * Called on container open/close and SPA navigation to prevent stuck states.
   */
  reset() {
    if (this.isResizing) {
      document.querySelector('.resize-handle.resizing, .resize-edge.resizing')?.classList.remove('resizing');
    }
    document.body.classList.remove('container-resizing');
    this.isResizing = false;
    this.resizeDirection = null;
    this.currentContainer = null;
    this.containerType = null;
  }

  handleMouseDown(e) {
    // Safety: if isResizing is stuck from a previous interrupted drag, reset first
    if (this.isResizing && this.currentContainer && !this.currentContainer.isConnected) {
      this.reset();
    }

    // Only handle resize, not drag
    const resizeHandle = e.target.closest('.resize-handle, .resize-edge');

    if (resizeHandle) {
      this.startResize(e, resizeHandle);
    }
  }

  handleTouchStart(e) {
    // Safety: if isResizing is stuck from a previous interrupted drag, reset first
    if (this.isResizing && this.currentContainer && !this.currentContainer.isConnected) {
      this.reset();
    }

    // Only handle resize, not drag
    const resizeHandle = e.target.closest('.resize-handle, .resize-edge');

    if (resizeHandle) {
      this.startResize(e.touches[0], resizeHandle);
    }
  }

  startResize(event, resizeHandle) {
    // Find the container (hyperlit, toc, source, and stacked containers)
    this.currentContainer = resizeHandle.closest('#hyperlit-container, #toc-container, #source-container, .hyperlit-container-stacked');
    if (!this.currentContainer) return;

    this.isResizing = true;
    this.resizeDirection = resizeHandle.classList.contains('resize-left') ? 'left' : 'right';

    // Detect which container we're working with
    // Stacked containers behave like hyperlit-container (right edge fixed)
    this.containerType = this.currentContainer.classList.contains('hyperlit-container-stacked')
      ? 'hyperlit-container'
      : this.currentContainer.id; // 'hyperlit-container' | 'toc-container' | 'source-container'

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

    // Store the fixed edge position based on container type
    if (this.containerType === 'hyperlit-container' || this.containerType === 'source-container') {
      // Right-anchored containers: right edge stays fixed, left edge moves
      this.fixedRightEdge = rect.right;
    } else if (this.containerType === 'toc-container') {
      // Left edge stays fixed
      this.fixedLeftEdge = rect.left;
    }

    // For proportional stack resize: snapshot depth info if stacked container
    this.draggedDepthInfo = null;
    if (this.currentContainer.classList.contains('hyperlit-container-stacked')) {
      const depth = parseInt(this.currentContainer.getAttribute('data-layer'), 10);
      if (depth && window.getStackDepthInfo) {
        this.draggedDepthInfo = window.getStackDepthInfo(depth);
      }
    }

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
    const viewportWidth = window.innerWidth;
    const minWidth = 150;

    if (this.containerType === 'hyperlit-container') {
      // HYPERLIT-CONTAINER: Right edge fixed, left edge moves
      const rightEdge = this.fixedRightEdge;
      const rightOffset = viewportWidth - rightEdge;

      // New left position based on mouse movement
      let newLeft = this.startContainerPos.x + deltaX;

      // Calculate new width (fixed right edge - new left position)
      let newWidth = rightEdge - newLeft;

      // Apply minimum width constraint
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

      // Proportional stack resize: derive base width and update all layers
      if (window.resizeAllLayers) {
        let newBaseWidth;
        if (this.draggedDepthInfo) {
          // Stacked container: reverse the shrink to get implied base width
          const { localDepth, shrinkFactor } = this.draggedDepthInfo;
          newBaseWidth = newWidth / Math.pow(shrinkFactor, localDepth);
        } else {
          // Base container: new width IS the base width
          newBaseWidth = newWidth;
        }
        // resizeAllLayers handles base + all stacked containers
        window.resizeAllLayers(newBaseWidth);
        // Still set max-width/left/transform on the base container
        const base = document.getElementById('hyperlit-container');
        if (base) {
          base.style.setProperty('max-width', 'none', 'important');
          base.style.setProperty('right', `${rightOffset}px`, 'important');
          base.style.setProperty('left', 'auto', 'important');
          base.style.setProperty('transform', 'translateX(0)', 'important');
        }
      } else {
        // Fallback: no stack manager, just resize this container
        this.currentContainer.style.setProperty('width', `${newWidth}px`, 'important');
        this.currentContainer.style.setProperty('max-width', 'none', 'important');
        this.currentContainer.style.setProperty('right', `${rightOffset}px`, 'important');
        this.currentContainer.style.setProperty('left', 'auto', 'important');
        this.currentContainer.style.setProperty('transform', 'translateX(0)', 'important');
      }

    } else if (this.containerType === 'toc-container') {
      // TOC-CONTAINER: Left edge fixed, right edge moves
      const leftEdge = this.fixedLeftEdge;
      const leftOffset = leftEdge;

      // New right position based on mouse movement
      let newRight = this.startContainerPos.x + this.startContainerSize.width + deltaX;

      // Calculate new width (new right position - fixed left edge)
      let newWidth = newRight - leftEdge;

      // Apply minimum width constraint
      if (newWidth < minWidth) {
        newWidth = minWidth;
        newRight = leftEdge + minWidth;
      }

      // Apply maximum width constraint (right edge can't go closer than leftOffset from right edge)
      const maxWidth = viewportWidth - leftEdge - leftOffset;
      if (newWidth > maxWidth) {
        newWidth = maxWidth;
        newRight = leftEdge + maxWidth;
      }

      // Apply the new size using left-based positioning to match CSS
      this.currentContainer.style.setProperty('width', `${newWidth}px`, 'important');
      this.currentContainer.style.setProperty('max-width', 'none', 'important');
      this.currentContainer.style.setProperty('left', `${leftOffset}px`, 'important');
      this.currentContainer.style.setProperty('right', 'auto', 'important');
      this.currentContainer.style.setProperty('transform', 'translateX(0)', 'important');

    } else if (this.containerType === 'source-container') {
      // SOURCE-CONTAINER: right edge fixed, left edge moves — same geometry as
      // hyperlit-container, but standalone (no stack/layers), so resize THIS element.
      const rightEdge = this.fixedRightEdge;
      const rightOffset = viewportWidth - rightEdge;

      let newWidth = rightEdge - (this.startContainerPos.x + deltaX);

      if (newWidth < minWidth) newWidth = minWidth;
      const maxWidth = rightEdge - rightOffset;
      if (newWidth > maxWidth) newWidth = maxWidth;

      this.currentContainer.style.setProperty('width', `${newWidth}px`, 'important');
      this.currentContainer.style.setProperty('max-width', 'none', 'important');
      this.currentContainer.style.setProperty('right', `${rightOffset}px`, 'important');
      this.currentContainer.style.setProperty('left', 'auto', 'important');
      this.currentContainer.style.setProperty('transform', 'translateX(0)', 'important');
    }
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
    document.querySelector('.resize-handle.resizing, .resize-edge.resizing')?.classList.remove('resizing');
    document.body.classList.remove('container-resizing');

    // Save the new width and position to customizations
    if (this.currentContainer && this.currentContainer.isConnected && window.containerCustomizer) {
      const viewportWidth = window.innerWidth;

      if (this.containerType === 'hyperlit-container') {
        // Always save for the BASE container — stacked widths are derived from it
        const base = document.getElementById('hyperlit-container');
        if (base) {
          const baseRect = base.getBoundingClientRect();
          const rightOffset = viewportWidth - baseRect.right;
          const customizations = {
            'width': `${baseRect.width}px`,
            'max-width': 'none',
            'right': `${rightOffset}px`,
            'left': 'auto',
            'transform': 'translateX(0)'
          };
          window.containerCustomizer.updateContainer('hyperlit-container', customizations);
          console.log('Saved new width for hyperlit-container:', customizations);
        }
      } else if (this.containerType === 'toc-container') {
        // Save left-based positioning for toc
        const rect = this.currentContainer.getBoundingClientRect();
        const leftOffset = rect.left;
        const customizations = {
          'width': `${rect.width}px`,
          'max-width': 'none',
          'left': `${leftOffset}px`,
          'right': 'auto',
          'transform': 'translateX(0)'
        };
        window.containerCustomizer.updateContainer(this.currentContainer.id, customizations);
        console.log(`Saved new width for ${this.currentContainer.id}:`, customizations);
      } else if (this.containerType === 'source-container') {
        // Save right-based positioning for source (right-anchored, like hyperlit)
        const rect = this.currentContainer.getBoundingClientRect();
        const rightOffset = viewportWidth - rect.right;
        const customizations = {
          'width': `${rect.width}px`,
          'max-width': 'none',
          'right': `${rightOffset}px`,
          'left': 'auto',
          'transform': 'translateX(0)'
        };
        window.containerCustomizer.updateContainer('source-container', customizations);
        console.log('Saved new width for source-container:', customizations);
      }
    }

    // Don't clear inline styles - let them persist
    // The containerCustomizer will apply them via stylesheet

    this.isResizing = false;
    this.resizeDirection = null;
    this.currentContainer = null;
    this.containerType = null;
  }
}

// Lifecycle — managed by ButtonRegistry ('containerDragger', pages: ['reader']).
//
// This module used to self-instantiate on load and was wired ONLY into reader.blade.php's
// @vite block. That block runs on a full reader page load but NOT on in-SPA book opens
// (card-click / pushState never re-render the blade), so after an SPA navigation no dragger
// existed and the resize edges were live-but-unwired — present, hit-testable, correct, but
// with no document mousedown listener behind them. Registering with ButtonRegistry means the
// dragger is (re)initialised on every reader entry, full-load and SPA alike, like every other
// reader component (perimeterButtons, editButton, toc, ...).
//
// The dragger listens via delegation on `document`, which survives SPA navigation, so one
// instance per page session is enough: create it once, and just clear any stale resize state
// on re-entry. It stays exposed as window.containerDragger because container lifecycle code
// (containerManager.ts) calls reset() through that global.
export function initContainerDragger() {
  if (!window.containerDragger) {
    window.containerDragger = new ContainerDragger();
  } else {
    window.containerDragger.reset();
  }
  return window.containerDragger;
}

export function destroyContainerDragger() {
  // Keep the singleton and its document-level listeners alive across SPA nav (cheap and
  // page-agnostic — it no-ops with no .resize-edge under the pointer); just clear any stuck
  // resize state so the next reader entry starts clean.
  if (window.containerDragger) window.containerDragger.reset();
}
