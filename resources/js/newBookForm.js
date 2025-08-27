import { openDatabase } from './cache-indexedDB.js';
import './debugLog.js';
import { generateBibtexFromForm } from './bibtexProcessor.js';
import { getCurrentUser, getAnonymousToken } from './auth.js';
import { loadFromJSONFiles, loadHyperText } from './initializePage.js';
import { transitionToReaderView, initializeImportedReaderView, initializeImportedBook } from "./viewManager.js";

// Add the helper functions from createNewBook.js
function generateUUID() {
  return ([1e7] + -1e3 + -4e3 + -8e3 + -1e11).replace(
    /[018]/g,
    (c) =>
      (c ^ (crypto.getRandomValues(new Uint8Array(1))[0] &
        (15 >> (c / 4)))).toString(16)
  );
}
 
async function getCreatorId() {
  const user = await getCurrentUser();
  
  if (user) {
    // User is logged in, use their username or name
    return user.name || user.username || user.email;
  } else {
    // User not logged in, use persistent UUID
    const AUTHOR_KEY = "authorId";
    let authorId = localStorage.getItem(AUTHOR_KEY);
    if (!authorId) {
      authorId = generateUUID();
      localStorage.setItem(AUTHOR_KEY, authorId);
    }
    return authorId;
  }
}

// Global functions that need to be accessible everywhere
function showFieldsForType(type) {
    document.querySelectorAll('.optional-field').forEach(field => {
        field.style.display = 'none';
        field.previousElementSibling.style.display = 'none';
    });

    if (type === 'article') {
        document.getElementById('journal').style.display = 'block';
        document.querySelector('label[for="journal"]').style.display = 'block';
        document.getElementById('pages').style.display = 'block';
        document.querySelector('label[for="pages"]').style.display = 'block';
    } else if (type === 'book') {
        document.getElementById('publisher').style.display = 'block';
        document.querySelector('label[for="publisher"]').style.display = 'block';
    } else if (type === 'phdthesis') {
        document.getElementById('school').style.display = 'block';
        document.querySelector('label[for="school"]').style.display = 'block';
    } else if (type === 'misc') {
        document.getElementById('note').style.display = 'block';
        document.querySelector('label[for="note"]').style.display = 'block';
    }
}

function populateFieldsFromBibtex() {
    const bibtexField = document.getElementById('bibtex');
    if (!bibtexField) return;
    
    const bibtexText = bibtexField.value.trim();
    if (!bibtexText) return;

    const patterns = {
        id: /@\w+\s*\{\s*([^,]+)\s*,/,
        title: /title\s*=\s*[\{"']([^}\"']+)[\}"']/i,
        author: /author\s*=\s*[\{"']([^}\"']+)[\}"']/i,
        journal: /journal\s*=\s*[\{"']([^}\"']+)[\}"']/i,
        year: /year\s*=\s*[\{"']?(\d+)[\}"']?/i,
        pages: /pages\s*=\s*[\{"']([^}\"']+)[\}"']/i,
        publisher: /publisher\s*=\s*[\{"']([^}\"']+)[\}"']/i,
        school: /school\s*=\s*[\{"']([^}\"']+)[\}"']/i,
        note: /note\s*=\s*[\{"']([^}\"']+)[\}"']/i,
        url: /url\s*=\s*[\{"']([^}\"']+)[\}"']/i
    };

    Object.entries(patterns).forEach(([field, pattern]) => {
        const match = bibtexText.match(pattern);
        if (match) {
            const fieldName = field === 'id' ? 'citation_id' : field;
            const element = document.getElementById(fieldName);
            if (element) {
                element.value = match[1].trim();
            }
        }
    });
}

function validateFileInput() {
    const fileInput = document.getElementById('markdown_file');
    
    let errorMsg = document.getElementById('file-error-message');
    if (!errorMsg) {
        errorMsg = document.createElement('div');
        errorMsg.id = 'file-error-message';
        errorMsg.style.color = 'red';
        errorMsg.style.marginTop = '5px';
        errorMsg.style.fontSize = '14px';
        fileInput.parentNode.insertBefore(errorMsg, fileInput.nextSibling);
    }
    
    if (!fileInput || !fileInput.files || fileInput.files.length === 0) {
        errorMsg.textContent = 'Please select a file to upload';
        errorMsg.style.display = 'block';
        return false;
    }
    
    const file = fileInput.files[0];
    const fileName = file.name.toLowerCase();
    const validExtensions = ['.md', '.epub', '.doc', '.docx'];
    const isValidType = validExtensions.some(ext => fileName.endsWith(ext));
    
    if (!isValidType) {
        errorMsg.textContent = 'Please select a valid file (.md, .epub, .doc, or .docx)';
        errorMsg.style.display = 'block';
        return false;
    }
    
    errorMsg.style.display = 'none';
    return true;
}

function resetSubmitButton(submitButton) {
    if (submitButton) {
        submitButton.disabled = false;
        submitButton.textContent = 'Submit';
    }
}

// Form data persistence functions
function saveFormData() {
    const selectedType = document.querySelector('input[name="type"]:checked');
    const formData = {
        bibtex: document.getElementById('bibtex').value,
        author: document.getElementById('author').value,
        title: document.getElementById('title').value,
        journal: document.getElementById('journal').value,
        publisher: document.getElementById('publisher').value,
        year: document.getElementById('year').value,
        pages: document.getElementById('pages').value,
        citation_id: document.getElementById('citation_id').value,
        url: document.getElementById('url').value,
        school: document.getElementById('school').value,
        note: document.getElementById('note').value,
        type: selectedType ? selectedType.value : ''
    };
    localStorage.setItem('formData', JSON.stringify(formData));
}

function loadFormData() {
    const savedData = localStorage.getItem('formData');
    if (savedData) {
        const formData = JSON.parse(savedData);
        
        Object.entries(formData).forEach(([key, value]) => {
            const element = document.getElementById(key);
            if (element && value) {
                element.value = value;
            }
        });

        if (formData.type) {
            const radio = document.querySelector(`input[name="type"][value="${formData.type}"]`);
            if (radio) {
                radio.checked = true;
                showFieldsForType(formData.type);
            }
        }
    }
}

// Main initialization function
export function initializeCitationFormListeners() {
    // Set up radio button listeners
    document.querySelectorAll('input[name="type"]').forEach(radio => {
        radio.addEventListener('change', function() {
            showFieldsForType(this.value);
        });
    });

    // Set up BibTeX field listeners
    const bibtexField = document.getElementById('bibtex');
    if (bibtexField) {
        bibtexField.addEventListener('paste', function(e) {
            setTimeout(() => {
                const bibtexText = this.value;
                const typeMatch = bibtexText.match(/@(\w+)\s*\{/i);
                
                if (typeMatch) {
                    const bibType = typeMatch[1].toLowerCase();
                    const radio = document.querySelector(`input[name="type"][value="${bibType}"]`);
                    
                    if (radio) {
                        radio.checked = true;
                        showFieldsForType(bibType);
                    } else {
                        const miscRadio = document.querySelector('input[name="type"][value="misc"]');
                        if (miscRadio) {
                            miscRadio.checked = true;
                            showFieldsForType('misc');
                        }
                    }
                    
                    setTimeout(populateFieldsFromBibtex, 50);
                }
            }, 0);
        });

        bibtexField.addEventListener('input', function() {
            clearTimeout(this.debounceTimer);
            this.debounceTimer = setTimeout(() => {
                const bibtexText = this.value;
                const typeMatch = bibtexText.match(/@(\w+)\s*\{/i);
                
                if (typeMatch) {
                    const bibType = typeMatch[1].toLowerCase();
                    const radio = document.querySelector(`input[name="type"][value="${bibType}"]`);
                    
                    if (radio) {
                        radio.checked = true;
                        showFieldsForType(bibType);
                        populateFieldsFromBibtex();
                    }
                }
            }, 300);
        });
    }

    // Set up file validation
    const fileInput = document.getElementById('markdown_file');
    if (fileInput) {
        fileInput.addEventListener('change', validateFileInput);
    }

    console.log("Citation form event listeners initialized");
    
    // ✅ CRITICAL FIX: Set up validation when form is dynamically created
    setupFormSubmission();
    setupClearButton();
    setupRealTimeValidation();
    setupFormPersistence();
    loadFormData();
}

function setupFormSubmission() {
    console.log("🔥 DEBUG: setupFormSubmission called");
    const form = document.getElementById('cite-form');
    if (!form) {
        console.error("🔥 DEBUG: setupFormSubmission - form not found");
        return;
    }
    
    console.log("🔥 DEBUG: setupFormSubmission - form found:", form);
    
    // ✅ FIX: Check for existing handler more robustly
    if (form._hasSubmitHandler) {
        console.log("🔥 DEBUG: setupFormSubmission - handler already exists, skipping");
        return;
    }
    
    console.log("🔥 DEBUG: setupFormSubmission - adding new handler to form");
    form._hasSubmitHandler = true;
    
    const submitHandler = async function(event) {
        console.log("🔥 DEBUG: FORM SUBMIT TRIGGERED");
        event.preventDefault();
        event.stopPropagation();

        if (!validateFileInput()) {
            console.log("File validation failed");
            return false;
        }
        console.log("🔥 DEBUG: File validation passed");

        const submitButton = this.querySelector('button[type="submit"]');
        if (submitButton) {
            submitButton.disabled = true;
            submitButton.textContent = 'Processing...';
        }

        const formData = new FormData(this);

        // ✅ We no longer create a local libraryRecord here.
        // We just submit the form and let the backend handle it.
        await submitToLaravelAndLoad(formData, submitButton);
    };
    
    form.addEventListener('submit', submitHandler);
    // Store handler reference for potential cleanup
    form._submitHandler = submitHandler;
    
    // ✅ DEBUG: Test if the submit button is working
    const submitButton = form.querySelector('button[type="submit"]');
    if (submitButton) {
        console.log("🔥 DEBUG: Found submit button:", submitButton);
        // Test click handler
        submitButton.addEventListener('click', function(e) {
            console.log("🔥 DEBUG: Submit button clicked!", e);
        });
    } else {
        console.error("🔥 DEBUG: Submit button not found!");
    }
}

async function saveToIndexedDBThenSync(libraryRecord, originalFormData, submitButton) {
    console.log("Opening IndexedDB using openDatabase function...");
    
    try {
        // Get creator ID before saving
        const creatorId = await getCreatorId();
        console.log("Creating citation with creator:", creatorId);
        
        // Add creator to the library record
        libraryRecord.creator = creatorId;
        
        // Use your existing openDatabase function
        const db = await openDatabase();
        console.log("IndexedDB opened successfully");
        
        // Check if the library object store exists
        if (!db.objectStoreNames.contains("library")) {
            console.error("Library object store does not exist");
            alert("Database structure error. Please refresh the page.");
            resetSubmitButton(submitButton);
            return;
        }
        
        const tx = db.transaction("library", "readwrite");
        const store = tx.objectStore("library");
        
        console.log("Saving record to IndexedDB:", libraryRecord);
        const saveRequest = store.put(libraryRecord);
        
        saveRequest.onsuccess = function(event) {
            console.log("Record saved successfully to IndexedDB");
        };
        
        saveRequest.onerror = function(event) {
            console.error("Error saving to IndexedDB:", event.target.error);
            alert("Error saving locally: " + event.target.error);
            resetSubmitButton(submitButton);
        };
        
        tx.oncomplete = function() {
            console.log("IndexedDB transaction completed successfully");
            
            // Step 3: Sync to PostgreSQL
            syncToPostgreSQL(libraryRecord)
                .then(() => {
                    console.log("Synced to PostgreSQL successfully");
                    
                    // Step 4: Submit to Laravel for file processing
                    submitToLaravel(originalFormData, submitButton);
                })
                .catch(error => {
                    console.error("PostgreSQL sync failed:", error);
                    // Continue with Laravel submission even if sync fails
                    submitToLaravel(originalFormData, submitButton);
                });
        };
        
        tx.onerror = function(event) {
            console.error("IndexedDB transaction error:", event.target.error);
            alert("Transaction error: " + event.target.error);
            resetSubmitButton(submitButton);
        };
        
        tx.onabort = function(event) {
            console.error("IndexedDB transaction aborted:", event.target.error);
            alert("Transaction aborted: " + event.target.error);
            resetSubmitButton(submitButton);
        };
        
    } catch (error) {
        console.error("Failed to open IndexedDB:", error);
        alert("Local storage error: " + error);
        resetSubmitButton(submitButton);
    }
}

// Placeholder for your PostgreSQL sync function
async function syncToPostgreSQL(libraryRecord) {
    console.log("Syncing to PostgreSQL:", libraryRecord);
    
    // TODO: Replace with your actual sync function
    // For now, just return a resolved promise
    return Promise.resolve();
}

async function submitToLaravelAndLoad(formData, submitButton) {
  console.log("🔥 DEBUG: submitToLaravelAndLoad STARTED");
  console.log("Submitting to Laravel controller for file processing...");

  const csrfToken = document.querySelector('meta[name="csrf-token"]')?.content;

  try {
    const response = await fetch("/cite-creator", {
      method: "POST",
      body: formData,
      credentials: "include",
      headers: {
        Accept: "application/json",
        "X-CSRF-TOKEN": csrfToken,
      },
    });

    if (!response.ok) {
      // ✅ Get the actual error details from Laravel
      const errorText = await response.text();
      let errorDetails;
      
      try {
        const errorJson = JSON.parse(errorText);
        console.error("❌ Server validation errors:", errorJson);
        
        // Laravel validation errors are usually in errorJson.errors
        if (errorJson.errors) {
          const validationErrors = Object.entries(errorJson.errors)
            .map(([field, messages]) => `${field}: ${messages.join(', ')}`)
            .join('\n');
          errorDetails = `Validation failed:\n${validationErrors}`;
        } else {
          errorDetails = errorJson.message || errorText;
        }
      } catch (e) {
        console.error("❌ Server error (not JSON):", errorText);
        errorDetails = errorText;
      }
      
      throw new Error(`Server responded with ${response.status}: ${errorDetails}`);
    }

    const result = await response.json();
    console.log("✅ Import completed:", result);
    console.log("🔥 DEBUG: About to check for result.bookId");

    if (!result.bookId) {
      throw new Error("No bookId returned from backend");
    }
    console.log("🔥 DEBUG: bookId confirmed:", result.bookId);

    // Save the authoritative library record that came from the server
    if (result.library) {
      const db = await openDatabase();
      const tx = db.transaction("library", "readwrite");
      tx.objectStore("library").put(result.library);
      await tx.done;
      console.log("✅ Server's library record saved to IndexedDB");
    }

    // Pre-load the book's content into IndexedDB so the transition is instant.
    console.log(
      `📥 Fetching pre-generated JSON for imported book: ${result.bookId}`
    );
    await loadFromJSONFiles(result.bookId);

    // ===================== THE FIX: STEP 2 =====================
    // 🔥 CRITICAL: Set the same sessionStorage flag that create new book uses
    // This tells layout.blade.php to hide the overlay immediately on page load
    sessionStorage.setItem("pending_import_book", result.bookId);
    console.log(`🎯 Set pending_import_book flag for overlay management: ${result.bookId}`);

    // INSTEAD: Call the SPA transition function that you already built and know works.
    // This will smoothly replace the form page with the reader view.
    console.log(
      `🚀 Handing off to the working SPA transition for book: ${result.bookId}`
    );
    console.log(`🔥 DEBUG: About to call initializeImportedBook with ${result.bookId}`);
    await initializeImportedBook(result.bookId);
    console.log(`🔥 DEBUG: initializeImportedBook completed for ${result.bookId}`);
    // ===========================================================
  } catch (error) {
    console.error("❌ Import failed:", error);
    alert("Import failed: " + error.message);
    // Re-enable the button only on failure, since on success we navigate away.
    if (submitButton) {
      submitButton.disabled = false;
      submitButton.textContent = "Submit";
    }
  }
  // The 'finally' block is removed because on success, the button no longer exists.
}

// Clear button handler
function setupClearButton() {
    const clearButton = document.getElementById('clearButton');
    if (clearButton) {
        clearButton.addEventListener('click', function() {
            localStorage.removeItem('formData');
            document.getElementById('cite-form').reset();
            document.querySelectorAll('.optional-field').forEach(field => {
                field.style.display = 'none';
                field.previousElementSibling.style.display = 'none';
            });
            location.reload();
        });
    }
}

// Form persistence setup
function setupFormPersistence() {
    const form = document.getElementById('cite-form');
    if (form) {
        form.addEventListener('input', saveFormData);
    }
}

// Enhanced real-time validation
function setupRealTimeValidation() {
    // Validation functions
    const validators = {
        validateCitationId: (value) => {
            if (!value) return { valid: false, message: 'Citation ID is required' };
            if (!/^[a-zA-Z0-9_-]+$/.test(value)) return { valid: false, message: 'Only letters, numbers, underscores, and hyphens allowed' };
            if (value.length < 3) return { valid: false, message: 'Citation ID must be at least 3 characters' };
            return { valid: true, message: 'Valid citation ID' };
        },
        
        validateTitle: (value) => {
            if (!value) return { valid: false, message: 'Title is required' };
            if (value.length > 255) return { valid: false, message: 'Title must be less than 255 characters' };
            return { valid: true, message: 'Valid title' };
        },
        
        validateFile: (fileInput) => {
            if (!fileInput.files || fileInput.files.length === 0) {
                return { valid: false, message: 'Please select a file to upload' };
            }
            
            const file = fileInput.files[0];
            const validExtensions = ['.md', '.epub', '.doc', '.docx'];
            const fileName = file.name.toLowerCase();
            const isValidType = validExtensions.some(ext => fileName.endsWith(ext));
            
            if (!isValidType) {
                return { valid: false, message: 'Please select a .md, .epub, .doc, or .docx file' };
            }
            
            if (file.size > 50 * 1024 * 1024) { // 50MB
                return { valid: false, message: 'File size must be less than 50MB' };
            }
            
            return { valid: true, message: 'Valid file selected' };
        },
        
        validateYear: (value) => {
            if (!value) return { valid: true, message: '' }; // Optional field
            const year = parseInt(value);
            const currentYear = new Date().getFullYear();
            if (year < 1000 || year > currentYear + 10) {
                return { valid: false, message: `Year must be between 1000 and ${currentYear + 10}` };
            }
            return { valid: true, message: 'Valid year' };
        }
    };
    
    // Show validation message
    const showValidationMessage = (elementId, result) => {
        const msgElement = document.getElementById(`${elementId}-validation`);
        if (msgElement) {
            msgElement.textContent = result.message;
            msgElement.className = `validation-message ${result.valid ? 'success' : 'error'}`;
        }
    };
    
    // Validate form and update submit button
    const validateForm = () => {
        const citationId = document.getElementById('citation_id');
        const title = document.getElementById('title');
        const fileInput = document.getElementById('markdown_file');
        const submitButton = document.getElementById('createButton');
        
        if (!citationId || !title || !fileInput || !submitButton) return;
        
        const citationResult = validators.validateCitationId(citationId.value);
        const titleResult = validators.validateTitle(title.value);
        const fileResult = validators.validateFile(fileInput);
        
        const isFormValid = citationResult.valid && titleResult.valid && fileResult.valid;
        
        submitButton.disabled = !isFormValid;
        
        // Update validation summary
        updateValidationSummary([
            { field: 'Citation ID', result: citationResult },
            { field: 'Title', result: titleResult },
            { field: 'File', result: fileResult }
        ]);
        
        return isFormValid;
    };
    
    // Update validation summary
    const updateValidationSummary = (validations) => {
        const summary = document.getElementById('form-validation-summary');
        const list = document.getElementById('validation-list');
        
        if (!summary || !list) return;
        
        const errors = validations.filter(v => !v.result.valid && v.result.message);
        
        if (errors.length > 0) {
            list.innerHTML = errors.map(e => `<li>${e.field}: ${e.result.message}</li>`).join('');
            summary.style.display = 'block';
        } else {
            summary.style.display = 'none';
        }
    };
    
    // Set up individual field validators
    const citationIdField = document.getElementById('citation_id');
    if (citationIdField) {
        citationIdField.addEventListener('input', function() {
            const result = validators.validateCitationId(this.value);
            showValidationMessage('citation_id', result);
            setTimeout(validateForm, 100); // Slight delay for better UX
        });
        citationIdField.addEventListener('blur', function() {
            const result = validators.validateCitationId(this.value);
            showValidationMessage('citation_id', result);
            validateForm();
        });
    }
    
    const titleField = document.getElementById('title');
    if (titleField) {
        titleField.addEventListener('input', function() {
            const result = validators.validateTitle(this.value);
            showValidationMessage('title', result);
            setTimeout(validateForm, 100);
        });
        titleField.addEventListener('blur', function() {
            const result = validators.validateTitle(this.value);
            showValidationMessage('title', result);
            validateForm();
        });
    }
    
    const fileField = document.getElementById('markdown_file');
    if (fileField) {
        fileField.addEventListener('change', function() {
            const result = validators.validateFile(this);
            showValidationMessage('file', result);
            validateForm();
        });
    }
    
    const yearField = document.getElementById('year');
    if (yearField) {
        yearField.addEventListener('input', function() {
            const result = validators.validateYear(this.value);
            if (result.message) {
                // Only show year validation if there's an actual message (error or success)
                const msgElement = document.querySelector('#year').parentNode.querySelector('.validation-message');
                if (!msgElement) {
                    const newMsgElement = document.createElement('div');
                    newMsgElement.className = `validation-message ${result.valid ? 'success' : 'error'}`;
                    newMsgElement.textContent = result.message;
                    yearField.parentNode.appendChild(newMsgElement);
                } else {
                    msgElement.className = `validation-message ${result.valid ? 'success' : 'error'}`;
                    msgElement.textContent = result.message;
                }
            }
        });
    }
    
    // Initial validation
    setTimeout(validateForm, 500);
}

// Display saved citations
async function displaySavedCitations() {
    try {
        const db = await openDatabase();
        const tx = db.transaction("library", "readonly");
        const store = tx.objectStore("library");
        const citations = await store.getAll();
        console.log("Saved citations:", citations);
    } catch (error) {
        console.error("Error retrieving citations:", error);
    }
}

// Initialize everything when DOM is loaded
document.addEventListener('DOMContentLoaded', function() {
    initializeCitationFormListeners();
    setupFormSubmission();
    setupClearButton();
    setupFormPersistence();
    setupRealTimeValidation();
    loadFormData();
    
    setTimeout(displaySavedCitations, 1000);
});



// Keep setupFormSubmissionHandler as alias for backward compatibility
export function setupFormSubmissionHandler() {
    setupFormSubmission();
}