import { openDatabase, prepareLibraryForIndexedDB, cleanLibraryItemForStorage } from '../../indexedDB/index';
import { canUserEditBook } from "../../utilities/auth/index";
import { book } from '../../app';
import { fixHeaderSpacing } from '../homepage/homepageDisplayUnit';
import { log, verbose } from '../../utilities/logger';

let titleDebounceTimer: any = null;
let bioDebounceTimer: any = null;

// Store listener references to prevent duplicate attachment
let titleInputListener: any = null;
let bioInputListener: any = null;
let currentTitleElement: any = null;
let currentBioElement: any = null;

// Editing is OFFERED by init (owner + record present) but only ENGAGED while
// the page-edit mode is on — userPageEditor calls setUserProfileEditingEnabled
// when the pencil toggles. Keeps visitors and casual owners off the caret.
let editableRecord: any = null;
let editingEnabled = false;

/**
 * Initialize the user profile editor
 * Fetches library record and displays title/bio
 * Makes fields editable if user is authorized
 */
export async function initializeUserProfileEditor() {

  // Bio is OPTIONAL: the redesigned user page has no #userBio element (the
  // about section is the one prose surface; library.note only feeds the SEO
  // description) — title editing must not die on its absence.
  const titleEl = document.getElementById('userLibraryTitle');
  const bioEl = document.getElementById('userBio');

  if (!titleEl) {
    verbose.init('User profile title element not found', '/components/userProfile/userProfileEditor.ts');
    return;
  }

  try {
    // Read the authoritative library record straight off the server-rendered DOM. The row is
    // embedded (owner only) as a data attribute on #userLibraryContainer by user.blade.php, so it
    // arrives with the same HTML as the title/bio — no IndexedDB lookup (which never held a record
    // keyed by the username on a user page) and no sync race, on both full load and SPA nav.
    const rawRecord = document.getElementById('userLibraryContainer')?.dataset.libraryRecord;
    let record: any = null;
    if (rawRecord) {
      try {
        record = JSON.parse(rawRecord);
      } catch (parseError) {
        log.error('Failed to parse embedded library record', '/components/userProfile/userProfileEditor.ts', parseError);
      }
    }

    if (!record) {
      // No embedded record (visitor, or the owner's row is somehow absent). Title/bio remain
      // server-rendered; editing is simply not offered. Not an error — no console noise.
      // Only set defaults if not already present (server-rendered)
      if (!titleEl.textContent.trim()) {
        titleEl.textContent = `${book}'s library`;
      }
      if (bioEl && !bioEl.textContent.trim()) {
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
      titleEl.textContent = (record as any).title || `${book}'s library`;
    }
    if (bioEl && !bioEl.textContent.trim()) {
      bioEl.textContent = (record as any).note || '';
    }

    // Recalculate header spacing now that content is loaded
    setTimeout(() => {
      fixHeaderSpacing();
    }, 0);

    // Check if user can edit
    const canEdit = await canUserEditBook(book);

    if (canEdit) {
      // Editing is available but not engaged: the pencil (userPageEditor)
      // flips it on via setUserProfileEditingEnabled. If edit mode was
      // already on when a SPA re-init landed here, re-engage immediately.
      editableRecord = record;
      if (editingEnabled) {
        engageEditing();
      }
    }

  } catch (error) {
    log.error('Error initializing user profile editor', '/components/userProfile/userProfileEditor.ts', error);
  }
}

/**
 * Engage/release the inline title/bio editing — called by userPageEditor when
 * page-edit mode toggles. No-op unless init found an editable record (owner).
 */
export function setUserProfileEditingEnabled(enabled: boolean) {
  editingEnabled = enabled;
  if (enabled) {
    engageEditing();
  } else {
    releaseEditing();
  }
}

function engageEditing() {
  const titleEl = document.getElementById('userLibraryTitle');
  const bioEl = document.getElementById('userBio'); // absent on the redesigned page
  if (!titleEl || !editableRecord) return;

  titleEl.contentEditable = 'true';
  titleEl.classList.add('editable-field');
  if (!titleEl.textContent.trim()) {
    titleEl.setAttribute('data-placeholder', 'Your Library Title');
  }

  if (bioEl) {
    bioEl.contentEditable = 'true';
    bioEl.classList.add('editable-field');
    if (!bioEl.textContent.trim()) {
      bioEl.setAttribute('data-placeholder', 'Introduce your library, if you want...');
    }
  }

  attachSaveListeners(titleEl, bioEl, editableRecord);
}

function releaseEditing() {
  // Flush nothing — the debounced savers already fired or will have been
  // cleared below only after their elements stop being editable.
  if (currentTitleElement && titleInputListener) {
    currentTitleElement.removeEventListener('input', titleInputListener);
  }
  if (currentBioElement && bioInputListener) {
    currentBioElement.removeEventListener('input', bioInputListener);
  }
  const titleEl = document.getElementById('userLibraryTitle');
  const bioEl = document.getElementById('userBio');
  titleEl?.setAttribute('contenteditable', 'false');
  bioEl?.setAttribute('contenteditable', 'false');
  titleEl?.classList.remove('editable-field');
  bioEl?.classList.remove('editable-field');
  titleInputListener = null;
  bioInputListener = null;
  currentTitleElement = null;
  currentBioElement = null;
}

/**
 * Attach debounced save listeners to title and bio fields
 * Removes old listeners first to prevent duplicates
 */
function attachSaveListeners(titleEl: any, bioEl: any, originalRecord: any) {
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

  // Bio field listener (element absent on the redesigned user page)
  if (bioEl) {
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
  }

  verbose.init('user.blade.php library title and bio editor listeners attached (old listeners removed first)', '/components/userProfile/userProfileEditor.ts');
}

/**
 * Save a library field to IndexedDB and sync to PostgreSQL
 */
async function saveLibraryField(fieldName: any, value: any, originalRecord: any) {
  try {
    verbose.content(`💾 Saving library field: ${fieldName} = "${value}"`, '/components/userProfile/userProfileEditor.ts');

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
    await new Promise<void>((resolve, reject) => {
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
    alert(`Error saving ${fieldName}: ` + (error as any).message);
  }
}

/**
 * Sync library record to PostgreSQL backend
 * Reuses the same endpoint as sourceButton.js
 */
async function syncLibraryRecordToBackend(libraryRecord: any) {
  const csrfToken = (document.querySelector('meta[name="csrf-token"]') as any)?.content;

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
  editableRecord = null;
  editingEnabled = false;

  // Clear any pending timers
  clearTimeout(titleDebounceTimer);
  clearTimeout(bioDebounceTimer);
  titleDebounceTimer = null;
  bioDebounceTimer = null;

  verbose.init('🧹 User profile editor destroyed (listeners removed, references cleared)', '/components/userProfile/userProfileEditor.ts');
}
