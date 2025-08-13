import { ContainerManager } from "./container-manager.js";
import { openDatabase } from "./cache-indexedDB.js";
import { transitionToReaderView } from './viewManager.js';
import { ensureAuthInitialized } from "./auth.js";

import { createNewBook, fireAndForgetSync } from "./createNewBook.js";
import { enableEditMode } from './editButton.js';
import { setInitialBookSyncPromise } from "./operationState.js";

 

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
    this.setupButtonListeners();
    this.originalContent = null;

    window.addEventListener('resize', () => {
      if (this.isOpen && this.container.querySelector('#cite-form')) {
        // If form is open, adjust size on resize
        this.setResponsiveFormSize();
      }
    });
  }

 setupNewBookContainerStyles() {
    const container = this.container;
    if (!container) return;

    // CLOSED state only:
    container.style.position = "fixed";       // so we can animate from 0→XYZ
    container.style.transition =
      "width 0.3s ease-out, height 0.3s ease-out, opacity 0.3s ease-out, padding 0.3s ease-out";
    container.style.zIndex = "1000";
    container.style.backgroundColor = "#221F20";
    container.style.boxShadow = "0 0 15px rgba(0, 0, 0, 0.2)";
    container.style.borderRadius = "0.75em";

    // start hidden/collapsed:
    container.style.opacity = "0";
    container.style.padding = "12px";
    container.style.width = "0";
    container.style.height = "0";
  }


   setupButtonListeners() {
  document
    .getElementById("createNewBook")
    ?.addEventListener("click", async () => {
      console.log("Create new book clicked");
      this.closeContainer();
      const pendingSyncData = await createNewBook();

      if (pendingSyncData) {
        const syncPromise = fireAndForgetSync(
        pendingSyncData.bookId,
        pendingSyncData.isNewBook,
        pendingSyncData
      );
        setInitialBookSyncPromise(syncPromise);

        // ✅ STEP 1: Transition to the reader view WITHOUT any special options.
        // This will just load the blank page structure.
        await transitionToReaderView(pendingSyncData.bookId);

        // ✅ STEP 2: AFTER the transition is complete and the new view is stable,
        // explicitly call enableEditMode. This is now a separate, deliberate action.
        console.log("📘 New book from scratch: Forcing edit mode.");
        enableEditMode(null, true);
      }
    });

  document.getElementById("importBook")?.addEventListener("click", () => {
    console.log("Import book clicked");
    // Save the original content if not already saved
    if (!this.originalContent) {
      this.originalContent = this.container.innerHTML;
    }

    // Replace content with the form
    this.showImportForm();
    
    // ✅ NOW OPEN THE CONTAINER IN FORM MODE
    this.openContainer("form");
    
    // Dynamically import the module and set up the form submission handler
    import("./newBookForm.js")
      .then(module => {
        // Call the initialization function from the imported module
        module.initializeCitationFormListeners();
        
        // Set up the form submission handler
        module.setupFormSubmissionHandler();
      })
      .catch(error => {
        console.error("Error importing citation form module:", error);
      });
  });
}

 showImportForm() {
  // Get the CSRF token from the meta tag.
  const csrfToken = document
    .querySelector('meta[name="csrf-token"]')
    .getAttribute("content");

  // Get the route URL that has been processed by Laravel.
  const processCiteRoute = document
    .querySelector('meta[name="process-cite-route"]')
    .getAttribute("content");

  // The form HTML content with the processed route:
  const formHTML = `
      <div class="scroller">
      <form id="cite-form" action="${processCiteRoute}" method="POST" enctype="multipart/form-data">
        <h2 style="color: #EF8D34;">.md, .docx or .epub:</h2>
        <input type="hidden" name="_token" value="${csrfToken}" id="submitFile">

        <!-- Drag and drop field for Markdown file -->
        <input type="file" id="markdown_file" name="markdown_file" accept=".md,.epub,.doc,.docx">
        <p></p>
        <!-- Paste BibTeX details -->
        <label for="bibtex"><b>Paste</b> BibTeX Details:</label>
        <textarea id="bibtex" name="bibtex"></textarea>

        <!-- BibTeX Type Selection -->
        <label for="type"><b>Or</b> <i>type</i>:</label>
        <div class="radio-group">
          <label><input type="radio" name="type" value="article"> Article</label>
          <label><input type="radio" name="type" value="book"> Book</label>
          <label><input type="radio" name="type" value="phdthesis"> PhD Thesis</label>
          <label><input type="radio" name="type" value="misc"> Miscellaneous</label>
        </div>
        <br>

        <!-- Shared Input Fields -->
        <div id="common-fields">
          <label for="citation_id">Citation ID:</label>
          <input type="text" id="citation_id" name="citation_id">

          <label for="author">Author:</label>
          <input type="text" id="author" name="author">

          <label for="title">Title:</label>
          <input type="text" id="title" name="title">

          <label for="year">Year:</label>
          <input type="number" id="year" name="year">

          <label for="url">URL:</label>
          <input type="text" id="url" name="url">

          <label for="pages" class="optional-field" style="display:none;">Pages:</label>
          <input type="text" id="pages" name="pages" class="optional-field" style="display:none;">

          <label for="journal" class="optional-field" style="display:none;">Journal:</label>
          <input type="text" id="journal" name="journal" class="optional-field" style="display:none;">

          <label for="publisher" class="optional-field" style="display:none;">Publisher:</label>
          <input type="text" id="publisher" name="publisher" class="optional-field" style="display:none;">

          <label for="school" class="optional-field" style="display:none;">School:</label>
          <input type="text" id="school" name="school" class="optional-field" style="display:none;">

          <label for="note" class="optional-field" style="display:none;">Note:</label>
          <input type="text" id="note" name="note" class="optional-field" style="display:none;">
        </div>

        <div class="form-actions">
          <button type="submit" id="createButton" class="formButton">Create</button>
          <button type="button" id="clearButton" class="formButton">Clear</button>
        </div>
      </form>
      </div>
     <div class="mask-top"></div>
    <div class="mask-bottom"></div>
  `;

    // Replace the container content
    this.container.innerHTML = formHTML;

    this.container.style.padding = "20px";
    this.container.style.display = "block";


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

    // Set default type
    if (typeRadios.length > 0) {
      typeRadios[0].checked = true;
      this.toggleOptionalFields("article");
    }

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
    const isMobile = window.innerWidth <= 768;
    
    if (isMobile) {
      // Mobile: Use most of the screen
      this.container.style.width = "calc(100vw - 40px)";  // Full width minus padding
      this.container.style.height = "calc(100vh - 100px)"; // Full height minus some margin
      this.container.style.maxWidth = "none";
      
      // Center it on mobile
      this.container.style.left = "20px";
      this.container.style.right = "20px";
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
  if (this.isAnimating) return;
  this.isAnimating = true;

  // icon tilt
  this.button.querySelector(".icon")?.classList.add("tilted");

  // position on screen - keep original logic for both desktop and mobile
  const rect = this.button.getBoundingClientRect();
  this.container.style.top = `${rect.bottom + 8}px`;
  this.container.style.right = `${window.innerWidth - rect.right}px`;

  // make it visible
  this.container.classList.remove("hidden");
  this.container.style.visibility = "visible";

  // clear any previous layout
  this.container.style.display = "";
  this.container.style.flexDirection = "";
  this.container.style.justifyContent = "";
  this.container.style.alignItems = "";
  this.container.style.gap = "";

  // decide layout by mode:
  let targetWidth, targetHeight;
  const isMobile = window.innerWidth <= 768;
  
  if (mode === "buttons") {
    // the "+ New Book / Import" buttons view
    this.container.style.display = "flex";
    this.container.style.flexDirection = "column";
    this.container.style.justifyContent = "center";
    this.container.style.alignItems = "center";
    this.container.style.gap = "10px";
    this.container.style.padding = "20px";

    targetWidth = "200px";
    targetHeight = "auto";
  } else if (mode === "form") {
    // the big import form view
    this.container.style.display = "block";
    
    // Only adjust for mobile in form mode
    if (isMobile) {
      targetWidth = "calc(100vw - 40px)";
      targetHeight = "calc(100vh - 120px)";
      this.container.style.padding = "15px";
      
      // Adjust position for mobile only in form mode
      this.container.style.top = "30px";
      this.container.style.right = "20px";
      this.container.style.left = "20px";
    } else {
      targetWidth = "400px";
      targetHeight = "80vh";
      this.container.style.padding = "0";
    }
  }

  requestAnimationFrame(() => {
    this.container.style.width = targetWidth;
    this.container.style.height = targetHeight;
    this.container.style.opacity = "1";

    // overlay:
    if (this.overlay) {
      this.overlay.classList.add("active");
      this.overlay.style.display = "block";
      this.overlay.style.opacity = "0.5";
    }

    this.isOpen = true;
    window.uiState
      ? window.uiState.setActiveContainer(this.container.id)
      : (window.activeContainer = this.container.id);

    this.container.addEventListener(
      "transitionend",
      () => {
        this.isAnimating = false;
      },
      { once: true }
    );
  });
}

  closeContainer() {
  if (this.isAnimating) return;
  this.isAnimating = true;

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
  
  // ✅ RESET ALL POSITIONING STYLES
  this.container.style.left = "";
  this.container.style.right = "";
  this.container.style.top = "";
  
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
  
  this.container.addEventListener(
    "transitionend",
    () => {
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
    },
    { once: true }
  );
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
      const fieldIds = ['bibtex', 'citation_id', 'author', 'title', 'year', 'url', 'pages', 'journal', 'publisher', 'school', 'note', '_token'];
      
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
      
    }, 100);
    
  } catch (error) {
    console.error('Error loading form data:', error);
  }
}

clearSavedFormData() {
  localStorage.removeItem('newbook-form-data');
}

}

// Initialize the new book container manager
const newBookManager = new NewBookContainerManager(
  "newbook-container", // You'll need to create this container in your HTML
  "ref-overlay", // Using the same overlay as the source container
  "newBook", // The ID of your "+" button
  ["main-content"] // Same frozen containers
);

// Export the manager instance for use in other files if needed
export default newBookManager;
