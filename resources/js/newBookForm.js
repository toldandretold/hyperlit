import { openDatabase } from './cache-indexedDB.js';
import './debugLog.js';
import { generateBibtexFromForm } from './bibtexProcessor.js';


document.querySelectorAll('input[name="type"]').forEach(radio => {
    radio.addEventListener('change', function() {
        const type = this.value;
        showFieldsForType(type);
        populateFieldsFromBibtex();
    });
});


export function initializeCitationFormListeners() {
    // Define showFieldsForType inside the function scope
    function showFieldsForType(type) {
        // Hide all optional fields first
        document.querySelectorAll('.optional-field').forEach(field => {
            field.style.display = 'none';
            field.previousElementSibling.style.display = 'none';  // Hide the label
        });

        // Show relevant fields based on the selected type
        if (type === 'article') {
            document.getElementById('journal').style.display = 'block';
            document.querySelector('label[for="journal"]').style.display = 'block';
            document.getElementById('pages').style.display = 'block';  // Show pages field
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
        const bibtexText = document.getElementById('bibtex').value.trim();
        if (!bibtexText) return;

        // Improved regex patterns with more flexible whitespace handling
        const idMatch = bibtexText.match(/@\w+\s*\{\s*([^,]+)\s*,/);
        const titleMatch = bibtexText.match(/title\s*=\s*[\{"']([^}\"']+)[\}"']/i);
        const authorMatch = bibtexText.match(/author\s*=\s*[\{"']([^}\"']+)[\}"']/i);
        const journalMatch = bibtexText.match(/journal\s*=\s*[\{"']([^}\"']+)[\}"']/i);
        const yearMatch = bibtexText.match(/year\s*=\s*[\{"']?(\d+)[\}"']?/i);
        const pagesMatch = bibtexText.match(/pages\s*=\s*[\{"']([^}\"']+)[\}"']/i);
        const publisherMatch = bibtexText.match(/publisher\s*=\s*[\{"']([^}\"']+)[\}"']/i);
        const schoolMatch = bibtexText.match(/school\s*=\s*[\{"']([^}\"']+)[\}"']/i);
        const noteMatch = bibtexText.match(/note\s*=\s*[\{"']([^}\"']+)[\}"']/i);
        const urlMatch = bibtexText.match(/url\s*=\s*[\{"']([^}\"']+)[\}"']/i);

        console.log("BibTeX parsing results:", {
            idMatch, titleMatch, authorMatch, journalMatch, yearMatch,
            pagesMatch, publisherMatch, schoolMatch, noteMatch, urlMatch
        });

        // Populate fields regardless of visibility
        if (idMatch) document.getElementById('citation_id').value = idMatch[1].trim();
        if (titleMatch) document.getElementById('title').value = titleMatch[1].trim();
        if (authorMatch) document.getElementById('author').value = authorMatch[1].trim();
        if (journalMatch) document.getElementById('journal').value = journalMatch[1].trim();
        if (yearMatch) document.getElementById('year').value = yearMatch[1].trim();
        if (pagesMatch) document.getElementById('pages').value = pagesMatch[1].trim();
        if (publisherMatch) document.getElementById('publisher').value = publisherMatch[1].trim();
        if (schoolMatch) document.getElementById('school').value = schoolMatch[1].trim();
        if (noteMatch) document.getElementById('note').value = noteMatch[1].trim();
        if (urlMatch) document.getElementById('url').value = urlMatch[1].trim();
    }

    // Add event listeners for radio buttons
    document.querySelectorAll('input[name="type"]').forEach(radio => {
        radio.addEventListener('change', function() {
            const type = this.value;
            showFieldsForType(type);
        });
    });

    document.getElementById('bibtex').addEventListener('paste', function(e) {
        // Use setTimeout to ensure the paste content is available
        setTimeout(() => {
            const bibtexText = this.value;
            
            // Match the BibTeX entry type
            const typeMatch = bibtexText.match(/@(\w+)\s*\{/i);
            if (typeMatch) {
                const bibType = typeMatch[1].toLowerCase();
                console.log("Detected BibTeX type:", bibType);
                
                // Auto-select radio button based on BibTeX type
                const radio = document.querySelector(`input[name="type"][value="${bibType}"]`);
                if (radio) {
                    radio.checked = true;
                    showFieldsForType(bibType);
                } else {
                    // Default to misc if type not recognized
                    const miscRadio = document.querySelector('input[name="type"][value="misc"]');
                    if (miscRadio) {
                        miscRadio.checked = true;
                        showFieldsForType('misc');
                    }
                }
                
                // Populate the fields after a short delay to ensure DOM updates
                setTimeout(populateFieldsFromBibtex, 50);
            }
        }, 0);
    });

    // Also keep the input event listener for when users manually type
    document.getElementById('bibtex').addEventListener('input', function() {
        // Use debounce to avoid excessive processing during typing
        clearTimeout(this.debounceTimer);
        this.debounceTimer = setTimeout(() => {
            const bibtexText = this.value;
            
            // Match the BibTeX entry type
            const typeMatch = bibtexText.match(/@(\w+)\s*\{/i);
            if (typeMatch) {
                const bibType = typeMatch[1].toLowerCase();
                
                // Auto-select radio button based on BibTeX type
                const radio = document.querySelector(`input[name="type"][value="${bibType}"]`);
                if (radio) {
                    radio.checked = true;
                    showFieldsForType(bibType);
                    populateFieldsFromBibtex();
                }
            }
        }, 300); // 300ms debounce
    });

    
    console.log("Citation form event listeners initialized");
}



document.getElementById('clearButton').addEventListener('click', function() {
    // Clear local storage
    localStorage.removeItem('formData');

    // Clear all form fields
    const form = document.getElementById('cite-form');
    form.reset();

    // Optionally, you can manually clear specific input fields if needed
    form.querySelectorAll('input, textarea').forEach(field => {
        field.value = '';
    });

    // Hide all dynamic form sections if using dynamic form fields like in your previous example
    document.querySelectorAll('.form-section').forEach(section => {
        section.style.display = 'none';
    });

    // Reset the selected radio buttons if applicable
    document.querySelectorAll('input[type="radio"]').forEach(radio => {
        radio.checked = false;
    });

    // Refresh the page to fully reset everything
    location.reload(); // This will refresh the page
});

// Modify the form submission to save to IndexedDB instead of submitting to server
// Modify the form submission to save to IndexedDB instead of submitting to server
// Replace your current form submission handler with this one
document.getElementById('cite-form').addEventListener('submit', function(event) {
    // Prevent default form submission behavior
    event.preventDefault();
    event.stopPropagation();

    // Validate file input first
    if (!validateFileInput()) {
        console.log("File validation failed, stopping form submission");
        return false; // Stop form submission if validation fails
    }
    
    console.log("File validation passed, continuing with form submission");
    
    // Disable the submit button to prevent multiple submissions
    const submitButton = this.querySelector('button[type="submit"]');
    if (submitButton) {
        submitButton.disabled = true;
        submitButton.textContent = 'Saving...';
    }
    
    // Get form data
    const formData = new FormData(this);
    const citationData = {};
    
    // Convert FormData to a regular object
    for (const [key, value] of formData.entries()) {
      if (key !== 'markdown_file') {
        // For bibtex field: use the trimmed value (or empty string) instead of null
        citationData[key] = key === 'bibtex' ? value.trim() : (value === '' ? null : value);
      }
    }

    
    // Add the selected type
    const selectedType = document.querySelector('input[name="type"]:checked');
    if (selectedType) {
        citationData.type = selectedType.value;
    }

    citationData.bibtex =
        citationData.bibtex && citationData.bibtex.trim() !== ""
      ? citationData.bibtex
      : generateBibtexFromForm(citationData);
    
    // Handle the file if present
    const fileInput = document.getElementById('markdown_file');
    if (fileInput && fileInput.files.length > 0) {
        const file = fileInput.files[0];
        // Convert file to base64 for storage
        const reader = new FileReader();
        
        reader.onload = function(e) {
            citationData.fileContent = e.target.result;
            citationData.fileName = file.name;
            citationData.fileType = file.type;
            
            // Now that we have the file content, save to IndexedDB
            saveToIndexedDB(citationData);
        };
        
        reader.onerror = function(e) {
            console.error('Error reading file:', e);
            alert('Error reading file');
            if (submitButton) {
                submitButton.disabled = false;
                submitButton.textContent = 'Submit';
            }
        };
        
        reader.readAsDataURL(file);
    } else {
        // No file to process, save directly
        saveToIndexedDB(citationData);
    }
    
    // Function to save to IndexedDB
    function saveToIndexedDB(data) {

        console.log("Saving citation data:", data);
        
        // Get the citation ID from the form data or generate a new one
        const citationID = 
            (data.citation_id && data.citation_id.trim() !== '') 
                ? data.citation_id.trim() 
                : 'citation_' + Date.now();
        
        console.log("Using citation ID:", citationID);
        
        // Create the library record
        const libraryRecord = {
            citationID: citationID,
            bibtex: data.bibtex || "",
            title: data.title || null,
            author: data.author || null,
            year: data.year || null,
            journal: data.journal || null,
            publisher: data.publisher || null,
            pages: data.pages || null,
            school: data.school || null,
            note: data.note || null,
            url: data.url || null,
            type: data.type || null,
            fileContent: data.fileContent || null,
            fileName: data.fileName || null,
            fileType: data.fileType || null,
            timestamp: new Date().toISOString()
        };
        
        // Open the database
        const request = indexedDB.open("MarkdownDB");
        
        request.onerror = function(event) {
            console.error("Database error:", event.target.error);
            alert("Database error: " + event.target.error);
            if (submitButton) {
                submitButton.disabled = false;
                submitButton.textContent = 'Submit';
            }
        };
        
        request.onsuccess = function(event) {
            const db = event.target.result;
            const tx = db.transaction("library", "readwrite");
            const store = tx.objectStore("library");
            
            console.log("Saving record:", libraryRecord);
            const saveRequest = store.put(libraryRecord);
            
            saveRequest.onsuccess = function() {
                console.log("Record saved successfully");
            };
            
            saveRequest.onerror = function(event) {
                console.error("Error saving record:", event.target.error);
            };
            
            tx.oncomplete = function() {
                console.log("Transaction completed successfully");
                alert("Citation saved successfully! ID: " + citationID);
                
                // Clear form
                document.getElementById('cite-form').reset();
                localStorage.removeItem('formData');
                
                // Re-enable submit button
                if (submitButton) {
                    submitButton.disabled = false;
                    submitButton.textContent = 'Submit';
                }
            };
            
            tx.onerror = function(event) {
                console.error("Transaction error:", event.target.error);
                alert("Error saving citation: " + event.target.error);
                if (submitButton) {
                    submitButton.disabled = false;
                    submitButton.textContent = 'Submit';
                }
            };
        };
    }
    
    // Return false to ensure the form doesn't submit
    return false;
});







// Function to save form data to localStorage
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
        ID: document.getElementById('citation_id').value,
        url: document.getElementById('url').value,
        type: selectedType ? selectedType.value : '' // Save selected radio button value
    };
    localStorage.setItem('formData', JSON.stringify(formData));
}

// Function to load form data from localStorage
function loadFormData() {
    const savedData = localStorage.getItem('formData');
    if (savedData) {
        const formData = JSON.parse(savedData);
        document.getElementById('bibtex').value = formData.bibtex || '';
        document.getElementById('author').value = formData.author || '';
        document.getElementById('title').value = formData.title || '';
        document.getElementById('journal').value = formData.journal || '';
        document.getElementById('publisher').value = formData.publisher || '';
        document.getElementById('year').value = formData.year || '';
        document.getElementById('citation_id').value = formData.ID || '';
        document.getElementById('url').value = formData.url || '';
        document.getElementById('pages').value = formData.pages || '';
        document.getElementById('school').value = formData.school || '';
        document.getElementById('note').value = formData.note || '';

        // Restore the selected radio button
        if (formData.type) {
            const radio = document.querySelector(`input[name="type"][value="${formData.type}"]`);
            if (radio) {
                radio.checked = true; // Set the saved radio button as checked
                showFieldsForType(formData.type); // Display fields for the selected type
            }
        }
    }
}

// Function to clear form data from localStorage
function clearFormData() {
    localStorage.removeItem('formData');
}

// Event listeners to save data on input
document.getElementById('cite-form').addEventListener('input', saveFormData);

// Load data on page load
window.addEventListener('load', loadFormData);

// Real-time form validation
document.querySelectorAll('input[type="text"], textarea').forEach((input) => {
    input.addEventListener('input', function() {
        if (this.value === '') {
            this.style.borderColor = 'red'; // Invalid input
        } else {
            this.style.borderColor = 'green'; // Valid input
        }
    });
});

// Add a function to retrieve and display saved citations
async function displaySavedCitations() {
    try {
        const db = await openDatabase();
        const tx = db.transaction("library", "readonly");
        const store = tx.objectStore("library");
        const citations = await store.getAll();
        
        console.log("Saved citations:", citations);
        // You can implement UI to display these citations if needed
    } catch (error) {
        console.error("Error retrieving citations:", error);
    }
}

// Optional: Call this function on page load to see saved citations in console
window.addEventListener('load', () => {
    setTimeout(displaySavedCitations, 1000); // Delay slightly to ensure DB is ready
});


// In newBookForm.js, add this new export function:
export function setupFormSubmissionHandler() {
  const form = document.getElementById('cite-form');
  if (!form) {
    console.error("Form not found when setting up submission handler");
    return;
  }
  
  console.log("Setting up form submission handler");
  
  // Store a flag to track if we've already set up the handler
  if (form._hasSubmitHandler) {
    console.log("Form already has submit handler, skipping");
    return;
  }
  
  // Mark the form as having a submit handler
  form._hasSubmitHandler = true;
  
  // Add the submission handler to the form
  form.addEventListener('submit', function(event) {
    // Temporarily prevent default form submission
    event.preventDefault();
    
    console.log("Form submission intercepted - validating file first");
    
    // Validate file input first
    if (!validateFileInput()) {
      console.log("File validation failed, stopping form submission");
      return false; // Stop form submission if validation fails
    }
    
    console.log("File validation passed, saving to IndexedDB");
    
    // Get form data
    const formData = new FormData(this);
    const citationData = {};
    
    // Convert FormData to a regular object
    for (const [key, value] of formData.entries()) {
      if (key !== 'markdown_file' && key !== '_token') {
        citationData[key] = value === '' ? null : value;
      }
    }
    
    // Add the selected type
    const selectedType = document.querySelector('input[name="type"]:checked');
    if (selectedType) {
      citationData.type = selectedType.value;
    }
    
    // Get the citation ID from the form data or generate a new one
    const citationID = 
      (citationData.citation_id && citationData.citation_id.trim() !== '') 
        ? citationData.citation_id.trim() 
        : 'citation_' + Date.now();
    
    console.log("Using citation ID:", citationID);
    
    citationData.bibtex =
      citationData.bibtex && citationData.bibtex.trim() !== ""
        ? citationData.bibtex
        : generateBibtexFromForm(citationData);

    // Handle the file
    const fileInput = document.getElementById('markdown_file');
    if (fileInput && fileInput.files.length > 0) {
      const file = fileInput.files[0];
      citationData.fileName = file.name;
      citationData.fileType = file.type;
    }

    // Create the library record
    const libraryRecord = {
      book: citationID,
      bibtex: citationData.bibtex || null,
      title: citationData.title || null,
      author: citationData.author || null,
      year: citationData.year || null,
      journal: citationData.journal || null,
      publisher: citationData.publisher || null,
      pages: citationData.pages || null,
      school: citationData.school || null,
      note: citationData.note || null,
      url: citationData.url || null,
      type: citationData.type || null,
      fileName: citationData.fileName || null,
      fileType: citationData.fileType || null,
      timestamp: new Date().toISOString()
    };
    
    // Open the database
    const request = indexedDB.open("MarkdownDB");
    
    request.onerror = function(event) {
      console.error("Database error:", event.target.error);
      // Continue with form submission even if IndexedDB fails
      console.log("Continuing with form submission despite IndexedDB error");
      form.submit();
    };
    
    request.onsuccess = function(event) {
      const db = event.target.result;
      const tx = db.transaction("library", "readwrite");
      const store = tx.objectStore("library");
      
      console.log("Saving record to IndexedDB:", libraryRecord);
      const saveRequest = store.put(libraryRecord);
      
      saveRequest.onerror = function(event) {
        console.error("Error saving record:", event.target.error);
        // Continue with form submission even if saving fails
        console.log("Continuing with form submission despite save error");
        form.submit();
      };
      
      tx.oncomplete = function() {
        console.log("Transaction completed successfully");
        console.log("Now submitting form to server");
        console.log("Data ready to submit:", libraryRecord);
        localStorage.setItem("debugLibraryRecord", JSON.stringify(libraryRecord));
        // then delay form submission
        form.submit();
      };
      
      tx.onerror = function(event) {
        console.error("Transaction error:", event.target.error);
        // Continue with form submission even if transaction fails
        console.log("Continuing with form submission despite transaction error");
        form.submit();
      };
    };
  });
  
  console.log("Form submission handler attached - will validate file, save to IndexedDB, then submit to server");
  
  // Also make sure the BibTeX parsing is working
  const bibtexField = document.getElementById('bibtex');
  if (bibtexField) {
    console.log("Re-initializing BibTeX field listeners");
    
    // Make sure the populateFieldsFromBibtex function is available
    function populateFieldsFromBibtex() {
      const bibtexText = bibtexField.value.trim();
      if (!bibtexText) return;

      // Improved regex patterns with more flexible whitespace handling
      const idMatch = bibtexText.match(/@\w+\s*\{\s*([^,]+)\s*,/);
      const titleMatch = bibtexText.match(/title\s*=\s*[\{"']([^}\"']+)[\}"']/i);
      const authorMatch = bibtexText.match(/author\s*=\s*[\{"']([^}\"']+)[\}"']/i);
      const journalMatch = bibtexText.match(/journal\s*=\s*[\{"']([^}\"']+)[\}"']/i);
      const yearMatch = bibtexText.match(/year\s*=\s*[\{"']?(\d+)[\}"']?/i);
      const pagesMatch = bibtexText.match(/pages\s*=\s*[\{"']([^}\"']+)[\}"']/i);
      const publisherMatch = bibtexText.match(/publisher\s*=\s*[\{"']([^}\"']+)[\}"']/i);
      const schoolMatch = bibtexText.match(/school\s*=\s*[\{"']([^}\"']+)[\}"']/i);
      const noteMatch = bibtexText.match(/note\s*=\s*[\{"']([^}\"']+)[\}"']/i);
      const urlMatch = bibtexText.match(/url\s*=\s*[\{"']([^}\"']+)[\}"']/i);

      console.log("BibTeX parsing results:", {
          idMatch, titleMatch, authorMatch, journalMatch, yearMatch,
          pagesMatch, publisherMatch, schoolMatch, noteMatch, urlMatch
      });

      // Populate fields regardless of visibility
      if (idMatch) document.getElementById('citation_id').value = idMatch[1].trim();
      if (titleMatch) document.getElementById('title').value = titleMatch[1].trim();
      if (authorMatch) document.getElementById('author').value = authorMatch[1].trim();
      if (journalMatch) document.getElementById('journal').value = journalMatch[1].trim();
      if (yearMatch) document.getElementById('year').value = yearMatch[1].trim();
      if (pagesMatch) document.getElementById('pages').value = pagesMatch[1].trim();
      if (publisherMatch) document.getElementById('publisher').value = publisherMatch[1].trim();
      if (schoolMatch) document.getElementById('school').value = schoolMatch[1].trim();
      if (noteMatch) document.getElementById('note').value = noteMatch[1].trim();
      if (urlMatch) document.getElementById('url').value = urlMatch[1].trim();
    }
    
    // Function to show fields based on type
    function showFieldsForType(type) {
      // Hide all optional fields first
      document.querySelectorAll('.optional-field').forEach(field => {
          field.style.display = 'none';
          field.previousElementSibling.style.display = 'none';  // Hide the label
      });

      // Show relevant fields based on the selected type
      if (type === 'article') {
          document.getElementById('journal').style.display = 'block';
          document.querySelector('label[for="journal"]').style.display = 'block';
          document.getElementById('pages').style.display = 'block';  // Show pages field
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
  }
  
  // Add file validation function
  function validateFileInput() {
    console.log("Running file validation");
    const fileInput = document.getElementById('markdown_file');
    console.log("File input element:", fileInput);
    
    // Get or create the error message element
    let errorMsg = document.getElementById('file-error-message');
    if (!errorMsg) {
      errorMsg = document.createElement('div');
      errorMsg.id = 'file-error-message';
      errorMsg.style.color = 'red';
      errorMsg.style.marginTop = '5px';
      errorMsg.style.fontSize = '14px';
      fileInput.parentNode.insertBefore(errorMsg, fileInput.nextSibling);
    }
    
    // Check if a file is selected
    if (!fileInput || !fileInput.files || fileInput.files.length === 0) {
      errorMsg.textContent = 'Please select a file to upload';
      errorMsg.style.display = 'block';
      return false;
    }
    
    // Check file type
    const file = fileInput.files[0];
    const fileName = file.name.toLowerCase();
    const validExtensions = ['.md', '.epub', '.doc', '.docx'];
    const isValidType = validExtensions.some(ext => fileName.endsWith(ext));
    
    if (!isValidType) {
      errorMsg.textContent = 'Please select a valid file (.md, .epub, .doc, or .docx)';
      errorMsg.style.display = 'block';
      return false;
    }
    
    // File is valid
    errorMsg.style.display = 'none';
    return true;
  }
  
  // Add real-time validation when a file is selected
  const fileInput = document.getElementById('markdown_file');
  if (fileInput) {
    fileInput.addEventListener('change', validateFileInput);
  }
}






