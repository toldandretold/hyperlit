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

      // In your NewBookContainerManager class, update the importBook event listener:

    document.getElementById("importBook")?.addEventListener("click", () => {
      console.log("Import book clicked");
      // Save the original content if not already saved
      if (!this.originalContent) {
        this.originalContent = this.container.innerHTML;
      }

      // Replace content with the form and expand the container
      this.showImportForm();
      
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

    // IMPORTANT: Reset container styles that were used with flex

    // so the form can flow naturally. We switch from flex to block.
    
    // Give it enough width and height for the form.
    // You might try auto-height or a high fixed height.
    this.container.style.width = "500px";
    this.container.style.height = "80vh";
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

  // position on screen
  const rect = this.button.getBoundingClientRect();
  this.container.style.top = `${rect.bottom + 8}px`;
  this.container.style.right = `${
    window.innerWidth - rect.right
  }px`;

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
  if (mode === "buttons") {
    // the “+ New Book / Import” buttons view
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
    // scrolling + fade‐masks come from your CSS on .scroller/.mask‐*
    targetWidth = "500px";
    targetHeight = "80vh";
    // keep the padding tight so .scroller fills edge‑to‑edge
    this.container.style.padding = "0";
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
