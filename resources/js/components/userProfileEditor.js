import { openDatabase, prepareLibraryForIndexedDB, cleanLibraryItemForStorage } from '../indexedDB.js';
import { canUserEditBook } from "../utilities/auth.js";
import { book } from '../app.js';
import { fixHeaderSpacing } from '../homepageDisplayUnit.js';

let titleDebounceTimer = null;
let bioDebounceTimer = null;

// Store listener references to prevent duplicate attachment
let titleInputListener = null;
let bioInputListener = null;
let currentTitleElement = null;
let currentBioElement = null;

/**
 * Initialize the user profile editor
 * Fetches library record and displays title/bio
 * Makes fields editable if user is authorized
 */
export async function initializeUserProfileEditor() {
  console.log('🎨 Initializing user profile editor for book:', book);

  const titleEl = document.getElementById('userLibraryTitle');
  const bioEl = document.getElementById('userBio');

  if (!titleEl || !bioEl) {
    console.warn('User profile elements not found');
    return;
  }

  try {
    // Fetch library record from IndexedDB
    const db = await openDatabase();
    const tx = db.transaction('library', 'readonly');
    const store = tx.objectStore('library');
    const record = await new Promise((resolve, reject) => {
      const req = store.get(book);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });

    if (!record) {
      console.warn('No library record found for book:', book);
      // Only set defaults if not already present (server-rendered)
      if (!titleEl.textContent.trim()) {
        titleEl.textContent = `${book}'s library`;
      }
      if (!bioEl.textContent.trim()) {
        bioEl.textContent = '';
      }

      // Recalculate header spacing even with defaults
      setTimeout(() => {
        fixHeaderSpacing();
      }, 0);

      return;
    }

    // Display title and bio only if not already present (server-rendered)
    if (!titleEl.textContent.trim()) {
      titleEl.textContent = record.title || `${book}'s library`;
    }
    if (!bioEl.textContent.trim()) {
      bioEl.textContent = record.note || '';
    }

    // Recalculate header spacing now that content is loaded
    setTimeout(() => {
      fixHeaderSpacing();
    }, 0);

    // Check if user can edit
    const canEdit = await canUserEditBook(book);
    console.log('🔑 User can edit profile:', canEdit);

    if (canEdit) {
      // Make fields editable
      titleEl.contentEditable = 'true';
      bioEl.contentEditable = 'true';

      // Add placeholders via CSS class
      titleEl.classList.add('editable-field');
      bioEl.classList.add('editable-field');

      if (!titleEl.textContent.trim()) {
        titleEl.setAttribute('data-placeholder', 'Your Library Title');
      }
      if (!bioEl.textContent.trim()) {
        bioEl.setAttribute('data-placeholder', 'Introduce your library, if you want...');
      }

      // Attach save listeners
      attachSaveListeners(titleEl, bioEl, record);
    }

  } catch (error) {
    console.error('Error initializing user profile editor:', error);
  }
}

/**
 * Attach debounced save listeners to title and bio fields
 * Removes old listeners first to prevent duplicates
 */
function attachSaveListeners(titleEl, bioEl, originalRecord) {
  // 🧹 CRITICAL: Remove old listeners first to prevent duplicates
  if (currentTitleElement && titleInputListener) {
    currentTitleElement.removeEventListener('input', titleInputListener);
    console.log('🧹 Removed old title input listener');
  }
  if (currentBioElement && bioInputListener) {
    currentBioElement.removeEventListener('input', bioInputListener);
    console.log('🧹 Removed old bio input listener');
  }

  // Store current elements
  currentTitleElement = titleEl;
  currentBioElement = bioEl;

  // Title field listener
  titleInputListener = () => {
    clearTimeout(titleDebounceTimer);
    titleDebounceTimer = setTimeout(async () => {
      const newTitle = titleEl.textContent.trim();

      // Character limit enforcement
      if (newTitle.length > 150) {
        titleEl.textContent = newTitle.substring(0, 150);
        alert('Library title cannot exceed 150 characters');
        return;
      }

      await saveLibraryField('title', newTitle, originalRecord);
    }, 1000);
  };
  titleEl.addEventListener('input', titleInputListener);

  // Bio field listener
  bioInputListener = () => {
    clearTimeout(bioDebounceTimer);
    bioDebounceTimer = setTimeout(async () => {
      const newBio = bioEl.textContent.trim();

      // Character limit enforcement
      if (newBio.length > 500) {
        bioEl.textContent = newBio.substring(0, 500);
        alert('Bio cannot exceed 500 characters');
        return;
      }

      await saveLibraryField('note', newBio, originalRecord);
    }, 1000);
  };
  bioEl.addEventListener('input', bioInputListener);

  console.log('✅ User profile save listeners attached (old listeners removed first)');
}

/**
 * Save a library field to IndexedDB and sync to PostgreSQL
 */
async function saveLibraryField(fieldName, value, originalRecord) {
  try {
    console.log(`💾 Saving library field: ${fieldName} = "${value}"`);

    // Update the record
    const updatedRecord = {
      ...originalRecord,
      [fieldName]: value,
      timestamp: Date.now(), // Update timestamp when modified
    };

    // Clean the record before saving
    const cleanedRecord = prepareLibraryForIndexedDB(updatedRecord);

    // Save to IndexedDB
    const db = await openDatabase();
    const tx = db.transaction('library', 'readwrite');
    const store = tx.objectStore('library');
    await new Promise((resolve, reject) => {
      const req = store.put(cleanedRecord);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });

    console.log(`✅ Library field ${fieldName} saved to IndexedDB`);

    // Sync to PostgreSQL
    try {
      await syncLibraryRecordToBackend(cleanedRecord);
      console.log(`✅ Library field ${fieldName} synced to backend`);
    } catch (syncError) {
      console.warn('⚠️ Backend sync failed, but local update succeeded:', syncError);
    }

  } catch (error) {
    console.error(`Error saving library field ${fieldName}:`, error);
    alert(`Error saving ${fieldName}: ` + error.message);
  }
}

/**
 * Sync library record to PostgreSQL backend
 * Reuses the same endpoint as sourceButton.js
 */
async function syncLibraryRecordToBackend(libraryRecord) {
  const csrfToken = document.querySelector('meta[name="csrf-token"]')?.content;

  // Clean the library record and prepare raw_json for PostgreSQL
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
      data: cleanedForSync
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Backend sync failed: ${response.status} - ${errorText}`);
  }

  return await response.json();
}

/**
 * Cleanup function for navigation
 * Removes event listeners and resets state
 */
export function destroyUserProfileEditor() {
  // Remove event listeners if they exist
  if (currentTitleElement && titleInputListener) {
    currentTitleElement.removeEventListener('input', titleInputListener);
    currentTitleElement.contentEditable = 'false';
    currentTitleElement.classList.remove('editable-field');
  }

  if (currentBioElement && bioInputListener) {
    currentBioElement.removeEventListener('input', bioInputListener);
    currentBioElement.contentEditable = 'false';
    currentBioElement.classList.remove('editable-field');
  }

  // Clear stored references
  titleInputListener = null;
  bioInputListener = null;
  currentTitleElement = null;
  currentBioElement = null;

  // Clear any pending timers
  clearTimeout(titleDebounceTimer);
  clearTimeout(bioDebounceTimer);
  titleDebounceTimer = null;
  bioDebounceTimer = null;

  console.log('🧹 User profile editor destroyed (listeners removed, references cleared)');
}
