// Edit-library-card form for the source container (#edit-form-container and the
// #edit-* fields): show/hide, populate from the library record, type-specific
// optional fields, BibTeX paste/drop autofill, URL cleaning/validation, and
// save (IndexedDB + backend upsert). Each function takes the
// SourceContainerManager instance as `self`; the class delegates to these and
// is the single dispatch hub, so peer calls go through `self.*`.
import { openDatabase, prepareLibraryForIndexedDB, cleanLibraryItemForStorage } from '../../../indexedDB/index';
import { generateBibtexFromForm } from '../../../utilities/bibtexProcessor.js';
import { book } from '../../../app.js';
import { canUserEditBook } from '../../../utilities/auth.js';
import { getRecord } from './helpers';
import { buildSourceHtml } from './buildSourceHtml';

export async function handleEditClick(self: any) {
  console.log("Edit button clicked");

  // Toggle: if already editing, save then close
  if (self.isInEditMode) {
    await self.saveEditForm();
    self.hideEditForm();
    return;
  }

  // Check if user can edit this book
  const canEdit = await canUserEditBook(book);
  if (!canEdit) {
    alert("You don't have permission to edit this book's details.");
    return;
  }

  // Get the library record and show the edit form
  await self.showEditForm();
}

export async function showEditForm(self: any) {
  const db = await openDatabase();
  const record = await getRecord(db, "library", book);

  if (!record) {
    alert("Library record not found.");
    return;
  }

  // Store the editing record so auto-save can access it later
  self.editingRecord = record;

  // Hide the main content and show the edit form
  const sourceContent = self.container.querySelector("#source-content");
  const editFormContainer = self.container.querySelector("#edit-form-container");

  if (sourceContent && editFormContainer) {
    sourceContent.style.display = "none";
    editFormContainer.style.display = "block";
    editFormContainer.classList.remove("hidden");

    // SET EDIT MODE FLAG
    self.isInEditMode = true;

    // Invert edit button to show it's active
    const editBtn = self.container.querySelector("#edit-source");
    if (editBtn) editBtn.classList.add("inverted");

    // Pre-fill the form with current data
    self.populateEditForm(record);

    // Expand container to accommodate form
    self.expandForEditForm();

    // CRITICAL FIX: Reapply container styles now that edit form is visible
    self.setupSourceContainerStyles();

    // Set up form event listeners
    self.setupEditFormListeners(record);
  }
}

export function populateEditForm(self: any, record: any) {
  // Basic fields
  const titleField = self.container.querySelector("#edit-title");
  const authorField = self.container.querySelector("#edit-author");
  const yearField = self.container.querySelector("#edit-year");
  const urlField = self.container.querySelector("#edit-url");
  const bibtexField = self.container.querySelector("#edit-bibtex");
  const licenseField = self.container.querySelector("#edit-license");
  const customLicenseField = self.container.querySelector("#edit-custom-license-text");

  const volumeField = self.container.querySelector("#edit-volume");
  const issueField2 = self.container.querySelector("#edit-issue");
  const booktitleField = self.container.querySelector("#edit-booktitle");
  const chapterField = self.container.querySelector("#edit-chapter");
  const editorField = self.container.querySelector("#edit-editor");

  if (titleField) titleField.value = record.title || "";
  if (authorField) authorField.value = record.author || record.creator || "";
  if (yearField) yearField.value = record.year || "";
  if (urlField) urlField.value = record.url || "";
  if (bibtexField) {
    bibtexField.value = record.bibtex || "";
    // Auto-resize textarea to fit content
    bibtexField.style.height = "auto";
    bibtexField.style.height = bibtexField.scrollHeight + "px";
    bibtexField.addEventListener("input", () => {
      bibtexField.style.height = "auto";
      bibtexField.style.height = bibtexField.scrollHeight + "px";
    });
  }
  if (volumeField) volumeField.value = record.volume || "";
  if (issueField2) issueField2.value = record.issue || "";
  if (booktitleField) booktitleField.value = record.booktitle || "";
  if (chapterField) chapterField.value = record.chapter || "";
  if (editorField) editorField.value = record.editor || "";

  // License fields
  if (licenseField) {
    licenseField.value = record.license || '';
    // Show custom license textarea if license is custom
    if (record.license === 'custom' && customLicenseField) {
      customLicenseField.style.display = 'block';
      customLicenseField.value = record.custom_license_text || '';
    }
  }

  // Set the correct radio button for type
  const typeRadios = self.container.querySelectorAll('input[name="type"]');
  const recordType = record.type || "book";
  typeRadios.forEach((radio: any) => {
    radio.checked = radio.value === recordType;
  });

  // Show optional fields based on type
  self.showOptionalFieldsForType(recordType, record);
}

export function showOptionalFieldsForType(self: any, type: any, record: any = {}) {
  // Hide all optional fields first (like the original showFieldsForType)
  self.container.querySelectorAll('.optional-field').forEach((field: any) => {
    field.style.display = 'none';
    // Also hide the label (previous sibling)
    if (field.previousElementSibling && field.previousElementSibling.classList.contains('optional-field')) {
      field.previousElementSibling.style.display = 'none';
    }
  });

  // Show fields based on type (same logic as newBookForm.js)
  if (type === 'article') {
    const journal = self.container.querySelector('#edit-journal');
    const journalLabel = self.container.querySelector('label[for="edit-journal"]');
    const pages = self.container.querySelector('#edit-pages');
    const pagesLabel = self.container.querySelector('label[for="edit-pages"]');
    const volume = self.container.querySelector('#edit-volume');
    const volumeLabel = self.container.querySelector('label[for="edit-volume"]');
    const issue = self.container.querySelector('#edit-issue');
    const issueLabel = self.container.querySelector('label[for="edit-issue"]');

    if (journal && journalLabel) {
      journal.style.display = 'block';
      journalLabel.style.display = 'block';
      journal.value = record.journal || '';
    }
    if (volume && volumeLabel) {
      volume.style.display = 'block';
      volumeLabel.style.display = 'block';
      volume.value = record.volume || '';
    }
    if (issue && issueLabel) {
      issue.style.display = 'block';
      issueLabel.style.display = 'block';
      issue.value = record.issue || '';
    }
    if (pages && pagesLabel) {
      pages.style.display = 'block';
      pagesLabel.style.display = 'block';
      pages.value = record.pages || '';
    }
  } else if (type === 'book') {
    const publisher = self.container.querySelector('#edit-publisher');
    const publisherLabel = self.container.querySelector('label[for="edit-publisher"]');

    if (publisher && publisherLabel) {
      publisher.style.display = 'block';
      publisherLabel.style.display = 'block';
      publisher.value = record.publisher || '';
    }
  } else if (type === 'incollection') {
    const booktitle = self.container.querySelector('#edit-booktitle');
    const booktitleLabel = self.container.querySelector('label[for="edit-booktitle"]');
    const editor = self.container.querySelector('#edit-editor');
    const editorLabel = self.container.querySelector('label[for="edit-editor"]');
    const publisher = self.container.querySelector('#edit-publisher');
    const publisherLabel = self.container.querySelector('label[for="edit-publisher"]');
    const pages = self.container.querySelector('#edit-pages');
    const pagesLabel = self.container.querySelector('label[for="edit-pages"]');
    const chapter = self.container.querySelector('#edit-chapter');
    const chapterLabel = self.container.querySelector('label[for="edit-chapter"]');

    if (booktitle && booktitleLabel) {
      booktitle.style.display = 'block';
      booktitleLabel.style.display = 'block';
      booktitle.value = record.booktitle || '';
    }
    if (editor && editorLabel) {
      editor.style.display = 'block';
      editorLabel.style.display = 'block';
      editor.value = record.editor || '';
    }
    if (publisher && publisherLabel) {
      publisher.style.display = 'block';
      publisherLabel.style.display = 'block';
      publisher.value = record.publisher || '';
    }
    if (chapter && chapterLabel) {
      chapter.style.display = 'block';
      chapterLabel.style.display = 'block';
      chapter.value = record.chapter || '';
    }
    if (pages && pagesLabel) {
      pages.style.display = 'block';
      pagesLabel.style.display = 'block';
      pages.value = record.pages || '';
    }
  } else if (type === 'phdthesis') {
    const school = self.container.querySelector('#edit-school');
    const schoolLabel = self.container.querySelector('label[for="edit-school"]');

    if (school && schoolLabel) {
      school.style.display = 'block';
      schoolLabel.style.display = 'block';
      school.value = record.school || '';
    }
  } else if (type === 'misc') {
    const note = self.container.querySelector('#edit-note');
    const noteLabel = self.container.querySelector('label[for="edit-note"]');

    if (note && noteLabel) {
      note.style.display = 'block';
      noteLabel.style.display = 'block';
      note.value = record.note || '';
    }
  }
}

export function populateFieldsFromBibtex(self: any) {
  const bibtexField = self.container.querySelector('#edit-bibtex');
  if (!bibtexField) return;

  const bibtexText = bibtexField.value.trim();
  if (!bibtexText) return;

  const patterns: any = {
    title: /title\s*=\s*[{"]([^}"]+)[}"]/i,
    author: /author\s*=\s*[{"]([^}"]+)[}"]/i,
    journal: /journal\s*=\s*[{"]([^}"]+)[}"]/i,
    year: /year\s*=\s*[{"]?(\d+)[}"]?/i,
    pages: /pages\s*=\s*[{"]([^}"]+)[}"]/i,
    publisher: /publisher\s*=\s*[{"]([^}"]+)[}"]/i,
    school: /school\s*=\s*[{"]([^}"]+)[}"]/i,
    note: /note\s*=\s*[{"]([^}"]+)[}"]/i,
    url: /url\s*=\s*[{"]([^}"]+)[}"]/i,
    volume: /volume\s*=\s*[{"]([^}"]+)[}"]/i,
    issue: /number\s*=\s*[{"]([^}"]+)[}"]/i,
    booktitle: /booktitle\s*=\s*[{"]([^}"]+)[}"]/i,
    chapter: /chapter\s*=\s*[{"]([^}"]+)[}"]/i,
    editor: /editor\s*=\s*[{"]([^}"]+)[}"]/i
  };

  let changed = false;
  Object.entries(patterns).forEach(([field, pattern]: [any, any]) => {
    const match = bibtexText.match(pattern);
    if (match) {
      const element = self.container.querySelector(`#edit-${field}`);
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
    const title = self.container.querySelector('#edit-title');
    if (title) title.dispatchEvent(new Event('input', { bubbles: true }));
  }
}

export function cleanUrl(self: any, url: any) {
  if (!url) return url;

  try {
    const urlObj = new URL(url);

    // Common tracking parameters to remove
    const trackingParams = [
      'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
      'fbclid', 'gclid', 'msclkid', 'mc_cid', 'mc_eid',
      '_ga', '_gl', 'ref', 'source', 'referrer'
    ];

    // Remove tracking parameters
    trackingParams.forEach(param => {
      urlObj.searchParams.delete(param);
    });

    return urlObj.toString();
  } catch (e) {
    // If URL is invalid, return as-is
    return url;
  }
}

export function validateUrl(self: any, value: any) {
  if (!value) return { valid: true, message: '' }; // Optional field

  // Auto-format URL if it doesn't have a protocol
  let formattedUrl = value.trim();
  if (formattedUrl && !formattedUrl.match(/^https?:\/\//i)) {
    formattedUrl = `https://${formattedUrl}`;
  }

  // Clean tracking parameters from URL
  formattedUrl = self.cleanUrl(formattedUrl);

  try {
    new URL(formattedUrl);
    return { valid: true, message: 'Valid URL', formattedValue: formattedUrl };
  } catch (e) {
    return { valid: false, message: 'Please enter a valid URL (e.g., example.com or https://example.com)' };
  }
}

export function expandForEditForm(self: any) {
  // Expand container for edit form (override CSS width temporarily)
  const vw = window.innerWidth;
  let w;
  if (vw <= 480) {
    w = vw - 16;                // phone: near full width
  } else if (vw <= 1024) {
    w = Math.min(vw - 40, 600); // tablet: up to 600px
  } else {
    w = 600;                    // desktop
  }
  const h = Math.min(window.innerHeight * 0.9, 700);

  self.container.style.width = `${w}px`;
  self.container.style.height = `${h}px`;
}

export function setupEditFormListeners(self: any, record: any) {
  const form = self.container.querySelector("#edit-source-form");
  const typeRadios = self.container.querySelectorAll('input[name="type"]');

  const bibtexField = self.container.querySelector("#edit-bibtex");
  const urlField = self.container.querySelector("#edit-url");
  const licenseField = self.container.querySelector("#edit-license");
  const customLicenseField = self.container.querySelector("#edit-custom-license-text");

  // License dropdown listener to show/hide custom license textarea
  if (licenseField && customLicenseField) {
    licenseField.addEventListener('change', (e: any) => {
      if (e.target.value === 'custom') {
        customLicenseField.style.display = 'block';
      } else {
        customLicenseField.style.display = 'none';
      }
    });
  }

  // Type change listeners for radio buttons
  typeRadios.forEach((radio: any) => {
    radio.addEventListener("change", (e: any) => {
      if (e.target.checked) {
        self.showOptionalFieldsForType(e.target.value, record);
      }
    });
  });


  // URL field auto-formatting
  if (urlField) {
    urlField.addEventListener('blur', () => {
      const result = self.validateUrl(urlField.value);

      // Auto-format the URL in the input field if validation succeeded
      if (result.valid && result.formattedValue && result.formattedValue !== urlField.value) {
        urlField.value = result.formattedValue;
      }
    });
  }

  // BibTeX field listeners (same as newBookForm.js)
  if (bibtexField) {
    // Helper to trigger validation after autofill
    const triggerAutoValidation = () => {
      const titleField = self.container.querySelector("#edit-title");
      if (titleField) titleField.dispatchEvent(new Event('input', { bubbles: true }));
    };

    bibtexField.addEventListener('paste', (e: any) => {
      setTimeout(() => {
        const bibtexText = bibtexField.value;
        const typeMatch = bibtexText.match(/@(\w+)\s*\{/i);

        if (typeMatch) {
          const bibType = typeMatch[1].toLowerCase();
          const radio = self.container.querySelector(`input[name="type"][value="${bibType}"]`);

          if (radio) {
            radio.checked = true;
            self.showOptionalFieldsForType(bibType, record);
          } else {
            const miscRadio = self.container.querySelector('input[name="type"][value="misc"]');
            if (miscRadio) {
              miscRadio.checked = true;
              self.showOptionalFieldsForType('misc', record);
            }
          }

          setTimeout(() => {
            self.populateFieldsFromBibtex();
            triggerAutoValidation();
          }, 50);
        }
      }, 0);
    });

    bibtexField.addEventListener('input', () => {
      clearTimeout(bibtexField.debounceTimer);
      bibtexField.debounceTimer = setTimeout(() => {
        const bibtexText = bibtexField.value;
        const typeMatch = bibtexText.match(/@(\w+)\s*\{/i);

        if (typeMatch) {
          const bibType = typeMatch[1].toLowerCase();
          const radio = self.container.querySelector(`input[name="type"][value="${bibType}"]`);

          if (radio) {
            radio.checked = true;
            self.showOptionalFieldsForType(bibType, record);
          }
        }

        // Always populate fields if there's any BibTeX-like content
        self.populateFieldsFromBibtex();
        triggerAutoValidation();
      }, 300);
    });

    // Drag-and-drop .bib file support
    bibtexField.addEventListener('dragover', (e: any) => {
      e.preventDefault();
      bibtexField.style.borderColor = 'var(--hyperlit-orange)';
    });

    bibtexField.addEventListener('dragleave', () => {
      bibtexField.style.borderColor = '';
    });

    bibtexField.addEventListener('drop', (e: any) => {
      e.preventDefault();
      bibtexField.style.borderColor = '';
      const file = e.dataTransfer.files[0];
      if (file && (file.name.endsWith('.bib') || file.type === 'text/plain' || file.type === 'application/x-bibtex')) {
        const reader = new FileReader();
        reader.onload = () => {
          bibtexField.value = (reader.result as string).trim();
          // Auto-resize
          bibtexField.style.height = 'auto';
          bibtexField.style.height = bibtexField.scrollHeight + 'px';
          // Trigger the same paste-like flow
          const bibtexText = bibtexField.value;
          const typeMatch = bibtexText.match(/@(\w+)\s*\{/i);
          if (typeMatch) {
            const bibType = typeMatch[1].toLowerCase();
            const radio = self.container.querySelector(`input[name="type"][value="${bibType}"]`);
            if (radio) {
              radio.checked = true;
              self.showOptionalFieldsForType(bibType, record);
            } else {
              const miscRadio = self.container.querySelector('input[name="type"][value="misc"]');
              if (miscRadio) {
                miscRadio.checked = true;
                self.showOptionalFieldsForType('misc', record);
              }
            }
          }
          self.populateFieldsFromBibtex();
          triggerAutoValidation();
        };
        reader.readAsText(file);
      }
    });
  }


  // Form submission
  if (form) {
    form.addEventListener("submit", async (e: any) => {
      e.preventDefault();
      await self.handleFormSubmit(record);
    });
  }
}

export async function saveEditForm(self: any) {
  if (!self.isInEditMode || !self.editingRecord) return;
  try {
    const formData = self.collectFormData();
    formData.book = self.editingRecord.book;
    const finalBibtex = await generateBibtexFromForm(formData);
    const updatedRecord = {
      ...self.editingRecord,
      ...formData,
      bibtex: finalBibtex,
      timestamp: Date.now(),
      book: self.editingRecord.book,
    };
    const cleanedRecord = prepareLibraryForIndexedDB(updatedRecord);
    const db = await openDatabase();
    const tx = db.transaction("library", "readwrite");
    const store = tx.objectStore("library");
    await store.put(cleanedRecord);
    try {
      await self.syncLibraryRecordToBackend(cleanedRecord);
    } catch (syncError) {
      console.warn("Backend sync failed, local update succeeded:", syncError);
    }
    // Refresh the citation display after saving
    await self.refreshCitationDisplay();
  } catch (error) {
    console.error("Error auto-saving library record:", error);
  }
}

export function hideEditForm(self: any) {
  // CLEAR EDIT MODE FLAG
  self.isInEditMode = false;
  self.editingRecord = null;

  const sourceContent = self.container.querySelector("#source-content");
  const editFormContainer = self.container.querySelector("#edit-form-container");

  if (sourceContent && editFormContainer) {
    sourceContent.style.display = "block";
    editFormContainer.style.display = "none";
    editFormContainer.classList.add("hidden");

    // Remove inverted state from edit button
    const editBtn = self.container.querySelector("#edit-source");
    if (editBtn) editBtn.classList.remove("inverted");

    // Reset to CSS dimensions by removing inline width/height
    self.container.style.width = "";
    self.container.style.height = "";

    // Clean up any stale inline styles on source-content from previous bug
    const sourceScroller = self.container.querySelector('#source-content');
    if (sourceScroller) {
      sourceScroller.style.paddingLeft = '';
      sourceScroller.style.paddingRight = '';
    }

    // RE-ATTACH EVENT LISTENERS: Make sure buttons work after returning from edit form
    self.attachInternalListeners();
  }
}

export async function handleFormSubmit(self: any, originalRecord: any) {
  try {
    // Collect form data
    const formData = self.collectFormData();

    // Ensure book ID is available for BibTeX generation (used as citation key)
    formData.book = originalRecord.book;

    // Always regenerate BibTeX from form data to ensure all fields are included
    const finalBibtex = await generateBibtexFromForm(formData);
    console.log("🔄 Regenerated BibTeX from form data:", finalBibtex);


    // Update the record with new data AND regenerated BibTeX
    const updatedRecord = {
      ...originalRecord,
      ...formData,
      bibtex: finalBibtex,
      timestamp: Date.now(), // Update timestamp when record is modified

      book: originalRecord.book, // Keep original book ID (primary key)
    };

    // 🧹 Clean the record before saving to prevent payload bloat
    const cleanedRecord = prepareLibraryForIndexedDB(updatedRecord);

    // Save to IndexedDB
    const db = await openDatabase();
    const tx = db.transaction("library", "readwrite");
    const store = tx.objectStore("library");
    await store.put(cleanedRecord);

    console.log("Library record updated successfully:", cleanedRecord);

    console.log("Final BibTeX:", finalBibtex);

    // Sync to backend database
    try {
      await self.syncLibraryRecordToBackend(cleanedRecord);
      console.log("✅ Library record synced to backend successfully");
    } catch (syncError) {
      console.warn("⚠️ Backend sync failed, but local update succeeded:", syncError);
      // Don't fail the entire operation if backend sync fails
    }


    // Hide the form and refresh the container content
    self.hideEditForm();

    // Refresh the citation display
    await self.refreshCitationDisplay();

    alert("Library record updated successfully!");

  } catch (error: any) {
    console.error("Error updating library record:", error);
    alert("Error updating library record: " + error.message);
  }
}

export async function syncLibraryRecordToBackend(self: any, libraryRecord: any) {
  const csrfToken = (document.querySelector('meta[name="csrf-token"]') as any)?.content;

  // 🧹 Clean the library record and prepare raw_json for PostgreSQL
  const cleanedForSync = {
    ...libraryRecord,
    raw_json: JSON.stringify(cleanLibraryItemForStorage(libraryRecord))
  };

  const response = await fetch('/api/db/library/upsert', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'X-CSRF-TOKEN': csrfToken,
    },
    credentials: 'include',
    body: JSON.stringify({
      data: cleanedForSync // The upsert endpoint expects a single record in the data field

    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Backend sync failed: ${response.status} - ${errorText}`);
  }

  return await response.json();
}

export function collectFormData(self: any) {
  const form = self.container.querySelector("#edit-source-form");
  const formData = new FormData(form);
  const data: any = {};

  for (const [key, value] of formData.entries()) {
    data[key] = value;
  }

  // Make sure we get the selected radio button type
  const checkedTypeRadio = self.container.querySelector('input[name="type"]:checked');
  if (checkedTypeRadio) {
    data.type = checkedTypeRadio.value;
  }


  // Collect all fields including BibTeX and license
  const allFields = ["title", "author", "year", "url", "bibtex", "journal", "pages", "publisher", "school", "note", "volume", "issue", "booktitle", "chapter", "editor", "license", "custom_license_text"];
  allFields.forEach(fieldName => {
    const field = self.container.querySelector(`#edit-${fieldName.replace('_', '-')}`);
    if (field) {
      data[fieldName] = field.value || '';
    }
  });

  return data;
}

export async function refreshCitationDisplay(self: any) {
  self._creatorToolsLoaded = false;
  // Rebuild the HTML with updated citation
  const html = await buildSourceHtml(book);
  self.container.innerHTML = html;

  // Re-attach all internal listeners (download, edit, privacy toggle)
  self.attachInternalListeners();
}
