import { openDatabase } from '../indexedDB/index.js';
import '../utilities/debugLog.js';
import { generateBibtexFromForm } from "../utilities/bibtexProcessor.js";
import { getCurrentUser, getAnonymousToken } from "../utilities/auth.js";
import { loadFromJSONFiles, loadHyperText } from '../initializePage.js';
// Navigation imports moved to new system - see submitToLaravelAndLoad function

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
  // Use the new authentication system instead of localStorage
  const userId = await getCurrentUserId();
  console.log('getCreatorId() returning:', userId, typeof userId);
  return userId;
}

// Global functions that need to be accessible everywhere
function showFieldsForType(type) {
    document.querySelectorAll('.optional-field').forEach(field => {
        field.style.display = 'none';
        field.previousElementSibling.style.display = 'none';
    });

    // Always show common fields like URL
    const urlField = document.getElementById('url');
    if (urlField) urlField.style.display = 'block';

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

    let changed = false;
    Object.entries(patterns).forEach(([field, pattern]) => {
        const match = bibtexText.match(pattern);
        if (match) {
            const fieldName = field === 'id' ? 'citation_id' : field;
            const element = document.getElementById(fieldName);
            if (element) {
                let newVal = match[1].trim();
                
                // Auto-format URL if it's a URL field
                if (field === 'url' && newVal && !newVal.match(/^https?:\/\//i)) {
                    newVal = `https://${newVal}`;
                }
                
                if (element.value !== newVal) {
                    element.value = newVal;
                    changed = true;
                }
            }
        }
    });

    // If fields were updated programmatically, trigger their validation listeners
    if (changed) {
        const citation = document.getElementById('citation_id');
        const title = document.getElementById('title');
        if (citation) citation.dispatchEvent(new Event('input', { bubbles: true }));
        if (title) title.dispatchEvent(new Event('input', { bubbles: true }));
    }
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
    
    // Handle folder upload (multiple files)
    if (fileInput.files.length > 1) {
        let hasMarkdown = false;
        let hasInvalidFiles = false;
        const validImageExts = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg'];
        const validFileExts = ['.md', ...validImageExts];
        
        for (let i = 0; i < fileInput.files.length; i++) {
            const file = fileInput.files[i];
            const fileName = file.name.toLowerCase();
            const hasValidExt = validFileExts.some(ext => fileName.endsWith(ext));
            
            if (!hasValidExt) {
                hasInvalidFiles = true;
                break;
            }
            
            if (fileName.endsWith('.md')) {
                hasMarkdown = true;
            }
        }
        
        if (!hasMarkdown) {
            errorMsg.textContent = 'Folder must contain at least one .md file';
            errorMsg.style.display = 'block';
            return false;
        }
        
        if (hasInvalidFiles) {
            errorMsg.textContent = 'Folder should only contain .md and image files';
            errorMsg.style.display = 'block';
            return false;
        }
        
        errorMsg.style.display = 'none';
        return true;
    }
    
    // Handle single file upload  
    const file = fileInput.files[0];
    const fileName = file.name.toLowerCase();
    const validExtensions = ['.md', '.epub', '.doc', '.docx', '.html'];
    const isValidType = validExtensions.some(ext => fileName.endsWith(ext));
    
    if (!isValidType) {
        errorMsg.textContent = 'Please select a valid file (.md, .epub, .doc, .docx, .html)';
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

        // After restoring values, trigger validations so the user sees status immediately
        setTimeout(() => {
            try {
                const citation = document.getElementById('citation_id');
                const title = document.getElementById('title');
                const fileInput = document.getElementById('markdown_file');

                // Kick title validators (immediate UX feedback)
                if (title) {
                    title.dispatchEvent(new Event('input', { bubbles: true }));
                    title.dispatchEvent(new Event('blur', { bubbles: true }));
                }

                // Kick citation validators (server check runs once on blur if value exists)
                if (citation) {
                    citation.dispatchEvent(new Event('input', { bubbles: true }));
                    citation.dispatchEvent(new Event('blur', { bubbles: true }));
                }

                // Show file validation message (will indicate reselect if empty)
                if (fileInput) {
                    fileInput.dispatchEvent(new Event('change', { bubbles: true }));
                }
            } catch (e) {
                console.warn('Initial validation trigger failed', e);
            }
        }, 50);
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
        // Helper to kick validators after programmatic autofill
        const triggerAutoValidation = () => {
            const citation = document.getElementById('citation_id');
            const title = document.getElementById('title');
            if (citation) citation.dispatchEvent(new Event('input', { bubbles: true }));
            if (title) title.dispatchEvent(new Event('input', { bubbles: true }));
        };
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
                    
                    setTimeout(() => {
                        populateFieldsFromBibtex();
                        triggerAutoValidation();
                    }, 50);
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
                        triggerAutoValidation();
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

        if (form._submitting) {
            console.log('⏳ Submit suppressed: already submitting');
            return false;
        }
        form._submitting = true;

        // Force blur active element so any pending validation completes
        try { if (document.activeElement) document.activeElement.blur(); } catch(_) {}

        // Quick file validation
        if (!validateFileInput()) {
            console.log("File validation failed");
            return false;
        }

        // Title + Citation ID validation (block duplicates)
        const submitButton = this.querySelector('button[type="submit"]');
        const citationInput = this.querySelector('#citation_id');
        const titleInput = this.querySelector('#title');
        const fileInput = this.querySelector('#markdown_file');

        const errors = [];

        // Title check
        if (!titleInput || !titleInput.value || titleInput.value.trim().length === 0) {
            errors.push({ field: 'Title', message: 'Title is required' });
            const el = document.getElementById('title-validation');
            if (el) { el.textContent = 'Title is required'; el.className = 'validation-message error'; }
        }

        // Citation ID checks
        const idVal = citationInput?.value?.trim() || '';
        if (!idVal) {
            errors.push({ field: 'Citation ID', message: 'Citation ID is required' });
            const el = document.getElementById('citation_id-validation');
            if (el) { el.textContent = 'Citation ID is required'; el.className = 'validation-message error'; }
        } else if (!/^[a-zA-Z0-9_-]+$/.test(idVal)) {
            errors.push({ field: 'Citation ID', message: 'Only letters, numbers, underscores, and hyphens allowed' });
            const el = document.getElementById('citation_id-validation');
            if (el) { el.textContent = 'Only letters, numbers, underscores, and hyphens allowed'; el.className = 'validation-message error'; }
        } else if (idVal.length < 3) {
            errors.push({ field: 'Citation ID', message: 'Citation ID must be at least 3 characters' });
            const el = document.getElementById('citation_id-validation');
            if (el) { el.textContent = 'Citation ID must be at least 3 characters'; el.className = 'validation-message error'; }
        } else {
            // Server availability check
            try {
                const resp = await fetch('/api/validate-citation-id', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'X-CSRF-TOKEN': document.querySelector('meta[name="csrf-token"]')?.content
                    },
                    body: JSON.stringify({ citation_id: idVal })
                });
                const data = await resp.json();
                if (!data.success) {
                    errors.push({ field: 'Citation ID', message: 'Error checking citation ID availability' });
                    const el = document.getElementById('citation_id-validation');
                    if (el) { el.textContent = 'Error checking citation ID availability'; el.className = 'validation-message error'; }
                } else if (data.exists) {
                    errors.push({ field: 'Citation ID', message: `Citation ID "${idVal}" is already taken` });
                    const el = document.getElementById('citation_id-validation');
                    if (el) { el.textContent = `Citation ID "${idVal}" is already taken`; el.className = 'validation-message error'; }
                } else {
                    const el = document.getElementById('citation_id-validation');
                    if (el) { el.textContent = 'Citation ID is available'; el.className = 'validation-message success'; }
                }
            } catch (e) {
                console.warn('Citation ID check failed', e);
                errors.push({ field: 'Citation ID', message: 'Unable to verify citation ID availability' });
                const el = document.getElementById('citation_id-validation');
                if (el) { el.textContent = 'Unable to verify citation ID availability'; el.className = 'validation-message error'; }
            }
        }

        // Update summary
        const summary = document.getElementById('form-validation-summary');
        const list = document.getElementById('validation-list');
        if (summary && list) {
            if (errors.length > 0) {
                list.innerHTML = errors.map(e => `<li>${e.field}: ${e.message}</li>`).join('');
                summary.style.display = 'block';
            } else {
                summary.style.display = 'none';
            }
        }

        if (errors.length > 0) {
            // Do not proceed
            if (submitButton) {
                submitButton.disabled = false;
                submitButton.textContent = 'Create Book';
            }
            return false;
        }

        // Passed validations — disable to avoid double submission
        if (submitButton) {
            submitButton.disabled = true;
            submitButton.textContent = 'Processing...';
        }

        try {
            // Manual FormData construction for robustness
            const form = this;
            const formData = new FormData();
            
            // Append all other form fields
            new FormData(form).forEach((value, key) => {
                if (key !== 'markdown_file') {
                    formData.append(key, value);
                }
            });

            // Explicitly append the file(s)
            const fileInput = form.querySelector('#markdown_file');
            if (fileInput && fileInput.files.length > 0) {
                // Handle multiple files (folder upload) or single file
                for (let i = 0; i < fileInput.files.length; i++) {
                    formData.append('markdown_file[]', fileInput.files[i]);
                }
            }

            await submitToLaravelAndLoad(formData, submitButton);
        } finally {
            // If navigation did not occur, allow another try
            form._submitting = false;
        }
    };
    
    form.addEventListener('submit', submitHandler);
    // Store handler reference for potential cleanup
    form._submitHandler = submitHandler;
    
    // ✅ DEBUG: Test if the submit button is working + Safari single-tap submit shim
    const submitButton = form.querySelector('button[type="submit"]');
    if (submitButton) {
        console.log("🔥 DEBUG: Found submit button:", submitButton);

        const ensureSubmit = (e) => {
            // Mark that shim handled this tap to suppress the next click
            form._shimSubmitted = true;
            setTimeout(() => { form._shimSubmitted = false; }, 600);

            // Prevent the following synthetic click; we will submit programmatically
            e.preventDefault();
            e.stopPropagation();
            try {
                if (document.activeElement && document.activeElement !== submitButton) {
                    document.activeElement.blur();
                }
            } catch (_) {}
            // Defer slightly to allow blur handlers/validation to settle
            setTimeout(() => {
                // Guard: if form already disabled button (in-flight), skip
                if (submitButton.disabled) return;
                // Programmatic submit triggers our submit handler
                if (typeof form.requestSubmit === 'function') {
                    form.requestSubmit(submitButton);
                } else {
                    form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
                }
            }, 0);
        };

        // Use pointerup/touchend to capture the first tap on Safari and avoid double-tap
        try {
            submitButton.addEventListener('pointerup', ensureSubmit, { passive: false });
            submitButton.addEventListener('touchend', ensureSubmit, { passive: false });
        } catch (_) {
            submitButton.addEventListener('touchend', ensureSubmit);
        }

        // Suppress immediate native click after shim to avoid double submission in Chrome
        submitButton.addEventListener('click', function(e) {
            if (form._shimSubmitted) {
                e.preventDefault();
                e.stopPropagation();
                return false;
            }
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

  try {
    // Use the new ImportBookTransition pathway
    const { ImportBookTransition } = await import('../navigation/pathways/ImportBookTransition.js');
    
    const result = await ImportBookTransition.handleFormSubmissionAndTransition(formData, submitButton);
    console.log(`🔥 DEBUG: ImportBookTransition completed for ${result.bookId}`);
    
  } catch (error) {
    console.error("❌ Import failed:", error);
    
    // Show more helpful error messages based on error type
    let userMessage = "Import failed: " + error.message;
    
    if (error.isProcessingError) {
      userMessage = "Document processing failed. This is likely a backend issue.\n\n" + 
                   "Please check:\n" +
                   "• Document format and complexity\n" +
                   "• Backend processing logs\n" +
                   "• Try with a simpler test document\n\n" +
                   "Technical details:\n" + error.message;
    }
    
    alert(userMessage);
    
    // Re-enable the button only on failure, since on success we navigate away.
    if (submitButton) {
      submitButton.disabled = false;
      submitButton.textContent = "Submit";
    }
  }
}

// Clear button handler
function setupClearButton() {
    const clearButton = document.getElementById('clearButton');
    if (clearButton) {
        clearButton.addEventListener('click', function(e) {
            e.preventDefault();
            const form = document.getElementById('cite-form');
            if (!form) return;

            // Reset inputs
            form.reset();

            // Hide optional fields (labels and inputs)
            document.querySelectorAll('.optional-field').forEach(field => {
                field.style.display = 'none';
            });

            // Clear validation messages (remove inline display so CSS classes can show later)
            document.querySelectorAll('.validation-message').forEach(msg => {
                msg.textContent = '';
                msg.innerHTML = '';
                msg.className = 'validation-message';
                msg.style.removeProperty('display');
            });
            const summary = document.getElementById('form-validation-summary');
            const list = document.getElementById('validation-list');
            if (summary) summary.style.display = 'none';
            if (list) list.innerHTML = '';

            // Re-enable submit button
            const submitButton = document.getElementById('createButton');
            if (submitButton) {
                submitButton.disabled = false;
                submitButton.textContent = 'Create Book';
            }

            // Clear any persisted form data (both keys used across modules)
            localStorage.removeItem('formData');
            localStorage.removeItem('newbook-form-data');
        }, { passive: false });
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
        validateCitationId: async (value) => {
            if (!value) return { valid: false, message: 'Citation ID is required' };
            if (!/^[a-zA-Z0-9_-]+$/.test(value)) return { valid: false, message: 'Only letters, numbers, underscores, and hyphens allowed' };
            if (value.length < 3) return { valid: false, message: 'Citation ID must be at least 3 characters' };
            
            // Check database for existing citation ID
            try {
                const response = await fetch('/api/validate-citation-id', {
                    method: 'POST',
                    credentials: 'same-origin',
                    headers: {
                        'Accept': 'application/json',
                        'Content-Type': 'application/json',
                        'X-CSRF-TOKEN': document.querySelector('meta[name="csrf-token"]')?.content
                    },
                    body: JSON.stringify({ citation_id: value })
                });
                
                let data;
                try {
                    data = await response.json();
                } catch (parseErr) {
                    console.warn('Citation ID check: non-JSON response', parseErr);
                    // Non-blocking: do not show an error state here; enforce on submit
                    return { valid: true, message: '' };
                }
                
                if (!data.success) {
                    // Non-blocking warning; treat as neutral so UI isn't alarming
                    return { valid: true, message: '' };
                }
                
                if (data.exists) {
                    const linkHtml = `<a href="${data.book_url}" target="_blank" style="color: #EF8D34; text-decoration: underline;">View existing book</a>`;
                    return { 
                        valid: false, 
                        message: `Citation ID "${value}" is already taken by "${data.book_title}". ${linkHtml}`,
                        isHtml: true
                    };
                }
                
                return { valid: true, message: 'Citation ID is available' };
                
            } catch (error) {
                console.warn('Citation ID validation error (non-blocking):', error);
                // Non-blocking: avoid showing an error; submit-time check will catch duplicates
                return { valid: true, message: '' };
            }
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
            const validExtensions = ['.md', '.epub', '.doc', '.docx', '.html'];
            const fileName = file.name.toLowerCase();
            const isValidType = validExtensions.some(ext => fileName.endsWith(ext));
            
            if (!isValidType) {
                return { valid: false, message: 'Please select a .md, .epub, .doc, .docx, or .html file' };
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
        },

        validateUrl: (value) => {
            if (!value) return { valid: true, message: '' }; // Optional field
            
            // Auto-format URL if it doesn't have a protocol
            let formattedUrl = value.trim();
            if (formattedUrl && !formattedUrl.match(/^https?:\/\//i)) {
                formattedUrl = `https://${formattedUrl}`;
            }
            
            try {
                new URL(formattedUrl);
                return { valid: true, message: 'Valid URL', formattedValue: formattedUrl };
            } catch (e) {
                return { valid: false, message: 'Please enter a valid URL (e.g., example.com or https://example.com)' };
            }
        }
    };
    
    // Show validation message
    const showValidationMessage = (elementId, result) => {
        const msgElement = document.getElementById(`${elementId}-validation`);
        if (msgElement) {
            if (result.isHtml) {
                msgElement.innerHTML = result.message;
                // Prevent validation message links from closing the form
                const links = msgElement.querySelectorAll('a');
                links.forEach(link => {
                    link.addEventListener('click', (e) => {
                        e.stopPropagation(); // Prevent event bubbling to overlay
                        
                        // Mark that we clicked an external link (for mobile handling)
                        if (window.newBookManager) {
                            window.newBookManager.recentExternalLinkClick = true;
                            console.log('🔥 MOBILE: External link clicked - flagged to preserve form state');
                        }
                    });
                });
            } else {
                msgElement.textContent = result.message;
            }
            msgElement.className = `validation-message ${result.valid ? 'success' : 'error'}`;
        }
    };
    
    // Validate form and update messages (do not disable the submit button pre-emptively)
    const validateForm = async () => {
        const citationId = document.getElementById('citation_id');
        const title = document.getElementById('title');
        const fileInput = document.getElementById('markdown_file');
        const submitButton = document.getElementById('createButton');
        
        if (!citationId || !title || !fileInput || !submitButton) return;
        
        // Do not disable the button here to avoid Safari double-tap issues
        // Avoid hitting the server here; handle citation ID via its own listeners
        const titleResult = validators.validateTitle(title.value);
        const fileResult = validators.validateFile(fileInput);
        
        const isFormValid = titleResult.valid && fileResult.valid;
        // Show individual field messages
        showValidationMessage('title', titleResult);
        showValidationMessage('file', fileResult);
        // Keep the submit button enabled; the submit handler will guard and show errors if needed
        submitButton.textContent = 'Create Book';
        
        // Update validation summary
        updateValidationSummary([
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
        let validationTimeout;
        
        citationIdField.addEventListener('input', function() {
            clearTimeout(validationTimeout);
            // Debounce the database check to avoid too many requests
            validationTimeout = setTimeout(async () => {
                const result = await validators.validateCitationId(this.value);
                showValidationMessage('citation_id', result);
                // Also refresh summary with current local field states
                const titleResult = validators.validateTitle(document.getElementById('title')?.value || '');
                const fileResult = validators.validateFile(document.getElementById('markdown_file'));
                updateValidationSummary([
                    { field: 'Citation ID', result },
                    { field: 'Title', result: titleResult },
                    { field: 'File', result: fileResult }
                ]);
            }, 500);
        });
        
        citationIdField.addEventListener('blur', async function() {
            clearTimeout(validationTimeout);
            const result = await validators.validateCitationId(this.value);
            showValidationMessage('citation_id', result);
            const titleResult = validators.validateTitle(document.getElementById('title')?.value || '');
            const fileResult = validators.validateFile(document.getElementById('markdown_file'));
            updateValidationSummary([
                { field: 'Citation ID', result },
                { field: 'Title', result: titleResult },
                { field: 'File', result: fileResult }
            ]);
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
            // Pass field base id 'file' so showValidationMessage targets #file-validation
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

    const urlField = document.getElementById('url');
    if (urlField) {
        urlField.addEventListener('blur', function() {
            const result = validators.validateUrl(this.value);
            
            // Auto-format the URL in the input field if validation succeeded
            if (result.valid && result.formattedValue && result.formattedValue !== this.value) {
                this.value = result.formattedValue;
            }
            
            if (result.message) {
                // Only show URL validation if there's an actual message (error or success)
                const msgElement = document.querySelector('#url').parentNode.querySelector('.validation-message');
                if (!msgElement) {
                    const newMsgElement = document.createElement('div');
                    newMsgElement.className = `validation-message ${result.valid ? 'success' : 'error'}`;
                    newMsgElement.textContent = result.message;
                    urlField.parentNode.appendChild(newMsgElement);
                } else {
                    msgElement.className = `validation-message ${result.valid ? 'success' : 'error'}`;
                    msgElement.textContent = result.message;
                }
            }
        });
        
        urlField.addEventListener('input', function() {
            const result = validators.validateUrl(this.value);
            if (result.message) {
                // Show validation during typing (but don't auto-format until blur)
                const msgElement = document.querySelector('#url').parentNode.querySelector('.validation-message');
                if (!msgElement) {
                    const newMsgElement = document.createElement('div');
                    newMsgElement.className = `validation-message ${result.valid ? 'success' : 'error'}`;
                    newMsgElement.textContent = result.message;
                    urlField.parentNode.appendChild(newMsgElement);
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
