import { ContainerManager } from "../containerManager.js";
import { openDatabase } from "../indexedDB/index.js";
// Navigation imports moved to new system - see createBookHandler function
import { ensureAuthInitialized } from "../utilities/auth.js";
import { log, verbose } from "../utilities/logger.js";

import { createNewBook, fireAndForgetSync } from "../createNewBook.js";
import { setInitialBookSyncPromise } from "../utilities/operationState.js";



export class NewBookContainerManager extends ContainerManager {
  constructor(
    containerId,
    overlayId,
    buttonId,
    frozenContainerIds = [],
  ) {
    super(containerId, overlayId, buttonId, frozenContainerIds);

    this.setupNewBookContainerStyles();
    this.isAnimating = false;
    this.button = document.getElementById(buttonId);
    this.buttonPosition = null;
    this.originalButtonRect = null; // Store original button position
    
    // Store event handler references for proper cleanup
    this.createBookHandler = null;
    this.importBookHandler = null;
    
    // Track external link clicks to prevent inappropriate closure
    this.recentExternalLinkClick = false;
    
    // Store resize handler reference for lazy initialization and cleanup
    this.resizeHandler = null;
    
    this.setupButtonListeners();
    this.originalContent = null;

    // Resize listener will be initialized lazily when import form is opened

    this.boundVisibilityChangeHandler = this.handleVisibilityChange.bind(this);
    this.boundFocusHandler = this.handleFocus.bind(this);

    document.addEventListener('visibilitychange', this.boundVisibilityChangeHandler);
    window.addEventListener('focus', this.boundFocusHandler);
  }

  handleVisibilityChange() {
      if (!document.hidden && this.recentExternalLinkClick) {
        verbose.init('Page visible again after external link click - preserving form state', 'newBookButton.js');
        this.recentExternalLinkClick = false;
        return; // Don't let other handlers close the form
      }
  }

  handleFocus() {
      if (this.recentExternalLinkClick) {
        verbose.init('Page focused after external link click - preserving form state', 'newBookButton.js');
        this.recentExternalLinkClick = false;
        return;
      }
  }

  destroy() {
    document.removeEventListener('visibilitychange', this.boundVisibilityChangeHandler);
    window.removeEventListener('focus', this.boundFocusHandler);
    this.cleanupResizeListener();
    verbose.init('All global listeners removed', 'newBookButton.js');
  }

  setupResizeListener() {
    // Only set up the resize listener if it hasn't been created yet
    if (!this.resizeHandler) {
      this.resizeHandler = () => {
        if (this.isOpen && this.container?.querySelector('#cite-form')) {
          // If form is open, adjust size on resize
          this.setResponsiveFormSize();
        }
      };
      window.addEventListener('resize', this.resizeHandler);
    }
  }

  cleanupResizeListener() {
    if (this.resizeHandler) {
      window.removeEventListener('resize', this.resizeHandler);
      this.resizeHandler = null;
    }
  }

 setupNewBookContainerStyles() {
    const container = this.container;
    if (!container) return;

    // CLOSED state only:
    container.style.position = "fixed"; // so we can animate from 0→XYZ
    container.style.transition =
      "width 0.3s ease-out, height 0.3s ease-out, opacity 0.3s ease-out, padding 0.3s ease-out, top 0.3s ease-out, left 0.3s ease-out, right 0.3s ease-out";
    container.style.zIndex = "1001";
    container.style.backgroundColor = "#221F20";
    container.style.boxShadow = "0 0 15px rgba(0, 0, 0, 0.2)";
    container.style.borderRadius = "0.75em";
    container.style.boxSizing = "border-box"; // Prevents padding from adding to the width

    // start hidden/collapsed:
    container.style.opacity = "0";
    container.style.padding = "12px";
    container.style.width = "0";
    container.style.height = "0";
  }


   setupButtonListeners() {
    // Remove existing event listeners if they exist
    if (this.createBookHandler) {
      document.getElementById("createNewBook")?.removeEventListener("click", this.createBookHandler);
    }
    if (this.importBookHandler) {
      document.getElementById("importBook")?.removeEventListener("click", this.importBookHandler);
    }

    // Create and store event handler functions
    this.createBookHandler = async () => {
      verbose.init('Create new book clicked', 'newBookButton.js');
      this.closeContainer();

      try {
        // Use NavigationManager to ensure overlay lifecycle is managed correctly
        const { NavigationManager } = await import('../navigation/NavigationManager.js');
        await NavigationManager.navigate('create-new-book', { createAndTransition: true });
        log.init('New book transition completed successfully', 'newBookButton.js');
      } catch (error) {
        console.error("❌ New book creation failed:", error);
        // Could show user feedback here
      }
    };

    this.importBookHandler = () => {
      verbose.init('Import book clicked', 'newBookButton.js');
      // Save the original content if not already saved
      if (!this.originalContent) {
        this.originalContent = this.container.innerHTML;
      }

      // ✅ LAZY INITIALIZATION: Set up resize listener only when form is opened
      this.setupResizeListener();

      // Replace content with the form
      this.showImportForm();

      // ✅ NOW OPEN THE CONTAINER IN FORM MODE
      this.openContainer("form");

      // ✅ FIX: Wait for container animation to complete before setting up form
      // Use a more robust approach that waits for the container to be ready
      const setupForm = () => {
        // Ensure form exists before trying to set up listeners
        const form = document.getElementById('cite-form');
        if (!form) {
          console.error("🔥 DEBUG: Form not found, retrying in 50ms");
          setTimeout(setupForm, 50);
          return;
        }

        import("./newBookForm.js")
          .then(module => {
            // Call the initialization function from the imported module
            module.initializeCitationFormListeners();

            // Set up the form submission handler explicitly
            module.setupFormSubmissionHandler();
          })
          .catch(error => {
            console.error("Error importing citation form module:", error);
          });
      };

      // Wait for the next animation frame to ensure DOM is ready
      requestAnimationFrame(() => {
        // Add a small delay to ensure mobile animations don't interfere
        setTimeout(setupForm, 100);
      });
    };

    // Add the event listeners
    document.getElementById("createNewBook")?.addEventListener("click", this.createBookHandler);
    document.getElementById("importBook")?.addEventListener("click", this.importBookHandler);
  }

 showImportForm() {
  // Get the CSRF token from the meta tag.
  const csrfToken = document
    .querySelector('meta[name="csrf-token"]')
    .getAttribute("content");

  // The form HTML content:
  const formHTML = `
      <div class="scroller">
      <form id="cite-form" action="/import-file" method="POST" enctype="multipart/form-data">
        <div class="form-header">
          <h2 style="color: #EF8D34;">Import File</h2>
          <p class="form-subtitle">Required fields marked with <span class="required-indicator">*</span></p>
        </div>

        <input type="hidden" name="_token" value="${csrfToken}" id="submitFile">

        <!-- File Upload Section -->
        <div class="form-section">
          <label for="markdown_file" class="required">File <span class="required-indicator">*</span></label>
          <input type="file" id="markdown_file" name="markdown_file[]" accept=".md,.epub,.doc,.docx,.html,.jpg,.jpeg,.png,.gif,.webp,.svg" webkitdirectory multiple>
          <div class="field-hint">Upload a document file</div>
          <div id="file-validation" class="validation-message"></div>
        </div>

        <!-- BibTeX Section -->
        <div class="form-section">
          <label for="bibtex">BibTeX Details (optional)</label>
          <textarea id="bibtex" name="bibtex" placeholder="Paste BibTeX entry here..."></textarea>
          <div class="field-hint">Auto-fills fields below when pasted</div>
        </div>

        <!-- Type Selection -->
        <div class="form-section">
          <label>Document Type:</label>
          <div class="radio-group">
            <label><input type="radio" name="type" value="article"> Article</label>
            <label><input type="radio" name="type" value="book" checked> Book</label>
            <label><input type="radio" name="type" value="phdthesis"> PhD Thesis</label>
            <label><input type="radio" name="type" value="misc"> Miscellaneous</label>
          </div>
        </div>

        <!-- Required Fields Section -->
        <div class="form-section">
          
          <label for="book" class="required">Book ID <span class="required-indicator">*</span></label>
          <input type="text" id="book" name="book" required
                 placeholder="e.g., smith2023, doe_2024_book"
                 title="Only letters, numbers, underscores, and hyphens allowed">
          <div class="field-hint">Unique identifier (letters, numbers, _, - only)</div>
          <div id="book-validation" class="validation-message"></div>

        </div>

        <div class="form-section">
          <label for="title" class="required">Title <span class="required-indicator">*</span></label>
          <input type="text" id="title" name="title" required placeholder="Enter document title">
          <div id="title-validation" class="validation-message"></div>
        

        <!-- Optional Fields Section -->
        
          
          <label for="author">Author</label>
          <input type="text" id="author" name="author" placeholder="Author name">

          <label for="year">Year</label>
          <input type="number" id="year" name="year" min="1000" max="${new Date().getFullYear() + 10}" placeholder="Publication year">

          <label for="url">URL</label>
          <input type="url" id="url" name="url" placeholder="https://...">

          <!-- Type-specific fields -->
          <label for="pages" class="optional-field" style="display:none;">Pages</label>
          <input type="text" id="pages" name="pages" class="optional-field" style="display:none;" placeholder="e.g., 1-20, 45-67">

          <label for="journal" class="optional-field" style="display:none;">Journal</label>
          <input type="text" id="journal" name="journal" class="optional-field" style="display:none;" placeholder="Journal name">

          <label for="publisher" class="optional-field" style="display:none;">Publisher</label>
          <input type="text" id="publisher" name="publisher" class="optional-field" style="display:none;" placeholder="Publisher name">

          <label for="school" class="optional-field" style="display:none;">School</label>
          <input type="text" id="school" name="school" class="optional-field" style="display:none;" placeholder="University/School name">

          <label for="note" class="optional-field" style="display:none;">Note</label>
          <input type="text" id="note" name="note" class="optional-field" style="display:none;" placeholder="Additional notes">
        </div>

        <div class="form-actions">
          <button type="submit" id="createButton" class="formButton">Create Book</button>
          <button type="button" id="clearButton" class="formButton">Clear</button>
        </div>
        
        <div id="form-validation-summary" class="validation-summary" style="display:none;">
          <h4>Please fix the following issues:</h4>
          <ul id="validation-list"></ul>
        </div>
      </form>
      </div>
     <div class="mask-top"></div>
    <div class="mask-bottom"></div>
  `;

    // Replace the container content
    this.container.innerHTML = formHTML;

    // Let openContainer() handle all positioning and display logic
    // Remove alignment styles from flex usage, if any.
    this.container.style.flexDirection = "";
    this.container.style.justifyContent = "";
    this.container.style.alignItems = "";
    this.container.style.gap = "";

    // In case elements like a close button are needed,
    // re-attach event listeners if elements exist (for now, for example).
    document.querySelector(".close-button")?.addEventListener("click", () => {
      this.restoreOriginalContent();
    });

    // If there is an element to cancel the form, reattach
    document.getElementById("cancelImport")?.addEventListener("click", () => {
      this.restoreOriginalContent();
    });

    document.getElementById("clearButton")?.addEventListener("click", () => {
      document.getElementById("cite-form").reset();
      this.clearSavedFormData();
    });

    // Show/hide optional fields based on the selected type
    const typeRadios = document.querySelectorAll('input[name="type"]');
    typeRadios.forEach((radio) => {
      radio.addEventListener("change", () => {
        this.toggleOptionalFields(radio.value);
      });
    });

    // Set default type and ensure URL field is visible
    if (typeRadios.length > 0) {
      // Find the checked radio or default to first one
      const checkedRadio = document.querySelector('input[name="type"]:checked');
      if (checkedRadio) {
        this.toggleOptionalFields(checkedRadio.value);
      } else {
        typeRadios[0].checked = true;
        this.toggleOptionalFields(typeRadios[0].value);
      }
    }
    
    // Always ensure URL field is visible after initialization
    setTimeout(() => {
      const urlField = document.getElementById('url');
      if (urlField) {
        urlField.style.display = 'block';
        
        // Add URL auto-formatting
        urlField.addEventListener('blur', function() {
          let url = this.value.trim();
          if (url && !url.startsWith('http://') && !url.startsWith('https://')) {
            this.value = 'https://' + url;
          }
        });
      }
    }, 50);

    this.loadFormData();

    const form = document.getElementById('cite-form');
    if (form) {
      form.addEventListener('input', () => {
        // Debounce the save to avoid too many localStorage writes
        clearTimeout(this.saveTimeout);
        this.saveTimeout = setTimeout(() => {
          this.saveFormData();
        }, 500);
      });
    }
  }

  setResponsiveFormSize() {
    const isMobile = window.innerWidth <= 480;
    
    if (isMobile) {
      // Mobile: Maintain our custom positioning - only expand down and to the left
      // Use ORIGINAL button position to prevent size creep during resize
      const maxWidthFromButton = this.originalButtonRect.right - 15; // From left margin to button's right edge
      
      this.container.style.width = `${maxWidthFromButton}px`;
      this.container.style.height = "calc(100vh - 100px)";
      this.container.style.maxWidth = `${maxWidthFromButton}px`;
      
      // Keep our positioning - don't override with centering
      this.container.style.left = "15px";
      this.container.style.right = ""; // Clear right positioning
      this.container.style.top = "50px";
    } else {
      // Desktop: Keep existing size
      this.container.style.width = "500px";
      this.container.style.height = "80vh";
      this.container.style.maxWidth = "500px";

      // Keep existing positioning logic for desktop
      // (this will be set by openContainer method)
    }
  }

  toggleOptionalFields(type) {
    // Hide all optional fields first
    const optionalFields = document.querySelectorAll(".optional-field");
    optionalFields.forEach((field) => {
      field.style.display = "none";
    });

    // Always show common fields like URL
    const urlField = document.getElementById('url');
    if (urlField) urlField.style.display = 'block';

    // Show fields based on type
    switch (type) {
      case "article":
        document.querySelector('label[for="journal"]').style.display =
          "block";
        document.getElementById("journal").style.display = "block";
        document.querySelector('label[for="pages"]').style.display =
          "block";
        document.getElementById("pages").style.display = "block";
        break;
      case "book":
        document.querySelector('label[for="publisher"]').style.display =
          "block";
        document.getElementById("publisher").style.display = "block";
        document.querySelector('label[for="pages"]').style.display =
          "block";
        document.getElementById("pages").style.display = "block";
        break;
      case "phdthesis":
        document.querySelector('label[for="school"]').style.display =
          "block";
        document.getElementById("school").style.display = "block";
        break;
      case "misc":
        document.querySelector('label[for="note"]').style.display = "block";
        document.getElementById("note").style.display = "block";
        break;
    }
  }

  restoreOriginalContent() {
    if (this.originalContent) {
      // Restore the original content (the two buttons)
      this.container.innerHTML = this.originalContent;

      // Resize the container back to its original size
      this.container.style.width = "150px";
      this.container.style.height = "100px";
      this.container.style.overflow = "hidden";

      // Re-attach event listeners to the buttons
      this.setupButtonListeners();
    }
  }

  openContainer(mode = "buttons") {
    console.log("🔥 DEBUG: openContainer called", { mode, isOpen: this.isOpen, isAnimating: this.isAnimating });
    
    if (this.isAnimating) {
      console.log("🔥 DEBUG: openContainer blocked - already animating");
      return;
    }

    // 🔥 MOBILE FIX: Reset any stuck states that could cause glitches
    if (!this.isOpen) {
      console.log("🔥 MOBILE: Resetting container state for fresh open");
      this.container.style.display = "none";
      this.container.style.opacity = "0";
      this.container.style.width = "0";
      this.container.style.height = "0";
      this.container.style.visibility = "hidden";
      this.container.classList.remove("hidden");
      
      // Clear any residual positioning
      this.container.style.left = "";
      this.container.style.right = "";
      this.container.style.top = "";
      this.container.style.transform = "";
    }

    this.isAnimating = true;

    const isMobile = window.innerWidth <= 480;
    const rect = this.button.getBoundingClientRect();
    
    console.log("🔥 DEBUG: openContainer state", { isMobile, rect, originalButtonRect: this.originalButtonRect });

    // This logic handles the TRANSITION from the initial "buttons" view to the "form" view.
    // It assumes the container is already open.
    if (this.isOpen && mode === "form") {
      console.log("🔥 DEBUG: Transitioning to form mode");
      // ✅ FIX: Ensure originalButtonRect exists for mobile positioning
      if (!this.originalButtonRect) {
        this.originalButtonRect = { ...rect, right: rect.right, bottom: rect.bottom };
      }

      this.container.style.display = "block";
      this.container.style.gap = "";
      this.container.style.alignItems = "";
      this.container.style.justifyContent = "";
      this.container.style.flexDirection = "";

      let targetWidth, targetHeight, targetTop, targetPadding;

      if (isMobile) {
        // Mobile: Keep the right edge anchored. Animate width, height, and top.
        targetWidth = `${this.originalButtonRect.right - 15}px`;
        targetHeight = "calc(100vh - 100px)";
        targetTop = "50px";
        targetPadding = "15px";
        this.container.style.maxWidth = targetWidth;
      } else {
        // Desktop: Keep the right edge anchored. Animate width, height, and top.
        targetWidth = "400px";
        targetHeight = "80vh";
        targetTop = `${this.originalButtonRect.bottom + 8}px`;
        targetPadding = "0";
      }

      // Apply the new styles to trigger the transition.
      console.log("🔥 DEBUG: Applying form styles", { targetWidth, targetHeight, targetTop, targetPadding });
      requestAnimationFrame(() => {
        this.container.style.width = targetWidth;
        this.container.style.height = targetHeight;
        this.container.style.top = targetTop;
        this.container.style.padding = targetPadding;
        
        console.log("🔥 DEBUG: Form styles applied", {
          actualWidth: this.container.style.width,
          actualHeight: this.container.style.height,
          actualTop: this.container.style.top,
          display: this.container.style.display,
          opacity: this.container.style.opacity,
          visibility: this.container.style.visibility
        });
        
        // Add both transitionend listener and timeout fallback
        const resetAnimation = () => { this.isAnimating = false; };
        this.container.addEventListener("transitionend", resetAnimation, { once: true });
        // Fallback timeout in case transitionend doesn't fire (mobile browser issue)
        setTimeout(resetAnimation, 500);
      });
      return;
    }

    // This logic handles the very FIRST opening of the container.
    if (!this.isOpen) {
      console.log("🔥 DEBUG: Opening container for first time in mode:", mode);
      
      this.button.querySelector(".icon")?.classList.add("tilted");

      if (!this.originalButtonRect) {
        this.originalButtonRect = { ...rect, right: rect.right, bottom: rect.bottom };
      }

      // ✅ FIX: If opening directly in form mode, skip the buttons layout
      if (mode === "form") {
        console.log("🔥 DEBUG: Opening directly in form mode");
        
        // Set up the container for form display - start invisible then fade in
        this.container.style.visibility = "visible";
        this.container.style.opacity = "0";
        this.container.style.display = "block";
        
        // Apply form-specific positioning immediately
        let targetWidth, targetHeight, targetTop, targetPadding;
        if (isMobile) {
          targetWidth = `${this.originalButtonRect.right - 15}px`;
          targetHeight = "calc(100vh - 100px)";
          targetTop = "50px";
          targetPadding = "15px";
          this.container.style.left = "15px";
          this.container.style.right = "";
          this.container.style.maxWidth = targetWidth;
        } else {
          targetWidth = "400px";
          targetHeight = "80vh";
          targetTop = `${this.originalButtonRect.bottom + 8}px`;
          targetPadding = "0";
          this.container.style.right = `${window.innerWidth - this.originalButtonRect.right}px`;
        }
        
        this.container.style.width = targetWidth;
        this.container.style.height = targetHeight;
        this.container.style.top = targetTop;
        this.container.style.padding = targetPadding;
        
        // Fade in after positioning is set, synced with button rotation (0.3s)
        requestAnimationFrame(() => {
          this.container.style.opacity = "1";
        });
        
        console.log("🔥 DEBUG: Direct form mode styles applied", {
          width: targetWidth, height: targetHeight, top: targetTop, padding: targetPadding
        });
        
      } else {
        // Original buttons mode layout - start invisible then fade in
        this.container.style.top = `${rect.bottom + 8}px`;
        this.container.style.right = `${window.innerWidth - rect.right}px`;
        this.container.style.visibility = "visible";
        this.container.style.opacity = "0";
        this.container.style.width = "200px";
        this.container.style.height = "auto";
        this.container.style.padding = "20px";
        this.container.style.display = "flex";
        this.container.style.flexDirection = "column";
        this.container.style.justifyContent = "center";
        this.container.style.alignItems = "center";
        this.container.style.gap = "10px";
        
        // Fade in after positioning is set, synced with button rotation (0.3s)
        requestAnimationFrame(() => {
          this.container.style.opacity = "1";
        });
      }

      if (this.overlay) {
        this.overlay.classList.add("active");
        this.overlay.style.display = "block";
        this.overlay.style.opacity = "0.5";
      }

      this.isOpen = true;
      window.uiState?.setActiveContainer(this.container.id);
      // Add both transitionend listener and timeout fallback
      const resetAnimation = () => { this.isAnimating = false; };
      this.container.addEventListener("transitionend", resetAnimation, { once: true });
      // Fallback timeout in case transitionend doesn't fire (mobile browser issue)
      setTimeout(resetAnimation, 500);
    }
  }

  closeContainer() {
  if (this.isAnimating) return;
  this.isAnimating = true;

  // 🔥 MOBILE DEBUG: Log when and why container is closing
  verbose.init('closeContainer called', 'newBookButton.js');

  // Don't close if we recently clicked an external link (mobile protection)
  if (this.recentExternalLinkClick) {
    verbose.init('Preventing container close due to recent external link click', 'newBookButton.js');
    this.isAnimating = false;
    this.recentExternalLinkClick = false;
    return;
  }

  verbose.init('Clearing original button rect', 'newBookButton.js');
  this.originalButtonRect = null; // Clear so it gets recalculated next time

  // ✅ CLEANUP: Remove resize listener when form is closed
  this.cleanupResizeListener();

  this.saveFormData();

  // Remove tilt from icon, if applicable
  const icon = this.button.querySelector(".icon");
  if (icon) {
    icon.classList.remove("tilted");
  }
  
  // Start the closing animation with graceful padding transition
  this.container.style.padding = "0"; // Animate padding to zero
  this.container.style.width = "0";
  this.container.style.height = "0";
  this.container.style.opacity = "0";
  
  // ✅ RESET ALL POSITIONING STYLES - including any mobile-specific ones
  this.container.style.left = "";
  this.container.style.right = "";
  this.container.style.top = "";
  this.container.style.transform = "";
  
  // Deactivate the overlay
  if (this.overlay) {
    this.overlay.classList.remove("active");
    this.overlay.style.opacity = "0";
  }
  
  // Set state and finish the animation
  this.isOpen = false;
  if (window.uiState) {
    window.uiState.setActiveContainer("main-content");
  } else {
    window.activeContainer = "main-content";
  }
  
  const onTransitionEnd = () => {
    this.container.classList.add("hidden");
    this.container.style.display = "none";
    this.isAnimating = false;

    if (this.overlay) {
      this.overlay.style.display = "none";
    }

    if (this.originalContent &&
        this.container.innerHTML !== this.originalContent) {
      this.container.innerHTML = this.originalContent;
      this.setupButtonListeners();
    }
  };

  this.container.addEventListener("transitionend", onTransitionEnd, { once: true });
  // Fallback timeout in case transitionend doesn't fire (mobile browser issue)
  setTimeout(onTransitionEnd, 500);
}

// Add these methods to your NewBookContainerManager class

saveFormData() {
  const form = document.getElementById('cite-form');
  if (!form) return;

  const data = {};
  
  // Get all form inputs except file inputs
  const inputs = form.querySelectorAll('input:not([type="file"]), textarea, select');
  inputs.forEach(input => {
    if (input.type === 'radio') {
      if (input.checked) {
        data[input.name] = input.value;
      }
    } else if (input.type === 'checkbox') {
      data[input.name] = input.checked;
    } else {
      data[input.name] = input.value;
    }
  });
  
  // Handle file input separately - just save the filename for reference
  const fileInput = document.getElementById('markdown_file');
  if (fileInput && fileInput.files && fileInput.files.length > 0) {
    data.selectedFileName = fileInput.files[0].name;
  }
  
  // Save to localStorage
  localStorage.setItem('newbook-form-data', JSON.stringify(data));
  console.log('Form data saved:', data);
}

loadFormData() {
  const savedData = localStorage.getItem('newbook-form-data');
  if (!savedData) return;
  
  try {
    const data = JSON.parse(savedData);
    console.log('Loading form data:', data);
    
    // Wait a bit for the form to be fully rendered
    setTimeout(() => {
      // Restore specific form fields by ID
      const fieldIds = ['bibtex', 'book', 'author', 'title', 'year', 'url', 'pages', 'journal', 'publisher', 'school', 'note', '_token'];

      fieldIds.forEach(fieldId => {
        const element = document.getElementById(fieldId);
        if (element && data[fieldId]) {
          element.value = data[fieldId];
        }
      });
      
      // Restore radio button selection
      if (data.type) {
        const radio = document.querySelector(`input[name="type"][value="${data.type}"]`);
        if (radio) {
          radio.checked = true;
          this.toggleOptionalFields(data.type);
        }
      }
      
      // Show a message about the previously selected file
      if (data.selectedFileName) {
        const fileInput = document.getElementById('markdown_file');
        if (fileInput) {
          // Remove any existing file note
          const existingNote = document.getElementById('file-restore-note');
          if (existingNote) {
            existingNote.remove();
          }
          
          // Create a new note about the previously selected file
          const fileNote = document.createElement('div');
          fileNote.id = 'file-restore-note';
          fileNote.style.fontSize = '12px';
          fileNote.style.color = '#EF8D34';
          fileNote.style.marginTop = '5px';
          fileNote.textContent = `Previously selected: ${data.selectedFileName} (please reselect)`;
          fileInput.parentNode.insertBefore(fileNote, fileInput.nextSibling);
        }
      }

      // Trigger validations after values are restored so messages appear without interaction
      try {
        const bookField = document.getElementById('book');
        const title = document.getElementById('title');
        const fileInput = document.getElementById('markdown_file');

        if (title) {
          title.dispatchEvent(new Event('input', { bubbles: true }));
          title.dispatchEvent(new Event('blur', { bubbles: true }));
        }

        if (bookField && bookField.value) {
          bookField.dispatchEvent(new Event('input', { bubbles: true }));
          bookField.dispatchEvent(new Event('blur', { bubbles: true }));
        }

        if (fileInput) {
          fileInput.dispatchEvent(new Event('change', { bubbles: true }));
        }
      } catch (e) {
        console.warn('Unable to trigger validations after draft load', e);
      }
      
    }, 100);
    
  } catch (error) {
    console.error('Error loading form data:', error);
  }
}

clearSavedFormData() {
  localStorage.removeItem('newbook-form-data');
}

}

// Container manager instance
let newBookManager = null;

// Initialize function that can be called after DOM changes
export function initializeNewBookContainer() {
  if (document.getElementById("newBook")) {
    if (!newBookManager) {
      newBookManager = new NewBookContainerManager(
        "newbook-container",
        "ref-overlay",
        "newBook",
        ["main-content"]
      );
      log.init('New book container initialized', '/components/newBookButton.js');
    } else {
      // Manager exists, just update button reference
      newBookManager.button = document.getElementById("newBook");
      newBookManager.rebindElements();
      log.init('New book container updated', '/components/newBookButton.js');
    }
    
    // Make available globally for mobile link handling
    window.newBookManager = newBookManager;
    return newBookManager;
  } else {
    console.log('ℹ️ NewBookContainer: Button not found, skipping initialization');
    return null;
  }
}

// Destroy function for cleanup during navigation
export function destroyNewBookContainer() {
  if (newBookManager) {
    verbose.init('Destroying new book container manager', 'newBookButton.js');
    // Clean up any open containers
    if (newBookManager.isOpen) {
      newBookManager.closeContainer();
    }
    // Call the new destroy method to remove listeners
    newBookManager.destroy();
    // Nullify the singleton instance
    newBookManager = null;
    return true;
  }
  return false;
}

// Export the manager instance for use in other files if needed
export default newBookManager;
