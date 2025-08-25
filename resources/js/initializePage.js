import { book, OpenHyperlightID } from './app.js';

import {
  createLazyLoader,
  loadNextChunkFixed,
  loadPreviousChunkFixed,
} from "./lazyLoaderFactory.js";

import {
  openDatabase,
  getNodeChunksFromIndexedDB,
  saveAllNodeChunksToIndexedDB,
  saveFootnotesToIndexedDB,
  updateHistoryLog, 
  executeSyncPayload,
  saveAllFootnotesToIndexedDB,
  saveAllReferencesToIndexedDB
} from "./cache-indexedDB.js";

import {
  attachMarkListeners,
} from "./hyperLights.js";

import { parseMarkdownIntoChunksInitial } from "./convert-markdown.js";

import { syncBookDataFromDatabase, syncIndexedDBtoPostgreSQL } from "./postgreSQL.js";
// Add to your imports at the top
import { buildUserHighlightCache, clearUserHighlightCache } from "./userCache.js";

import { undoLastBatch, redoLastBatch } from './historyManager.js';

let isRetrying = false; // Prevents multiple retries at once


export let pendingFirstChunkLoadedPromise;
let firstChunkLoadedResolver;

export function resolveFirstChunkPromise() {
  if (firstChunkLoadedResolver && typeof firstChunkLoadedResolver === 'function') {
    console.log("✅ Manually resolving first chunk promise");
    firstChunkLoadedResolver();
    firstChunkLoadedResolver = null; // Clear it after use
  } else {
    console.log("⚠️ First chunk resolver not available - will resolve when created");
    // Set a flag to resolve it immediately when the promise is created
    window._resolveFirstChunkWhenReady = true;
  }
}

function resetFirstChunkPromise() {
    pendingFirstChunkLoadedPromise = new Promise(resolve => {
        firstChunkLoadedResolver = resolve;
        
        // ✅ If we were asked to resolve immediately, do it now
        if (window._resolveFirstChunkWhenReady) {
            console.log("✅ Resolving first chunk promise immediately as requested");
            resolve();
            window._resolveFirstChunkWhenReady = false;
        }
    });
    console.log("PROMISE STATE: A new firstChunkPromise has been created and is pending.");
}

async function retryFailedBatches() {
  if (isRetrying || !navigator.onLine) {
    return;
  }
  isRetrying = true;
  console.log("🔁 Network is online. Checking for failed sync batches...");

  try {
    const db = await openDatabase();
    const tx = db.transaction("historyLog", "readonly");
    const store = tx.objectStore("historyLog");
    const index = store.index("status");

    const failedLogs = await new Promise((resolve, reject) => {
      const request = index.getAll("failed");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });

    if (failedLogs.length === 0) {
      console.log("✅ No failed batches to retry.");
      isRetrying = false;
      return;
    }

    console.log(`Retrying ${failedLogs.length} failed sync batches...`);

    for (const log of failedLogs) {
      try {
        // --- START: Build a clean payload for syncing ---
        const historyPayload = log.payload;
        const syncPayload = {
          book: historyPayload.book,
          updates: {
            nodeChunks: historyPayload.updates.nodeChunks || [],
            hypercites: historyPayload.updates.hypercites || [],
            hyperlights: historyPayload.updates.hyperlights || [],
            library: historyPayload.updates.library || null,
          },
          deletions: {
            // For syncing, we only want TRUE deletions.
            // A true deletion is an item in `deletions` that does NOT have a corresponding `update`.
            nodeChunks: (historyPayload.deletions.nodeChunks || []).filter(
              d => !(historyPayload.updates.nodeChunks || []).some(u => u.startLine === d.startLine)
            ),
            hypercites: (historyPayload.deletions.hypercites || []).filter(
              d => !(historyPayload.updates.hypercites || []).some(u => u.hyperciteId === d.hyperciteId)
            ),
            hyperlights: (historyPayload.deletions.hyperlights || []).filter(
              d => !(historyPayload.updates.hyperlights || []).some(u => u.hyperlight_id === d.hyperlight_id)
            ),
            // Library deletions are not handled this way, so it remains empty for sync.
          }
        };
        // --- END: Build a clean payload for syncing ---

        console.log(`🔄 Retrying batch ${log.id} with clean syncPayload:`, syncPayload);
        await executeSyncPayload(syncPayload); // <-- Pass the clean syncPayload

        log.status = "synced";
        await updateHistoryLog(log);
        console.log(`✅ Successfully retried batch ${log.id}`);
      } catch (error) {
        console.error(`❌ Retry for batch ${log.id} failed again. Will stop for now.`, error);
        break;
      }
    }
  } catch (error) {
    console.error("❌ A critical error occurred during the retry process:", error);
  } finally {
    isRetrying = false;
  }
}

// ✅ STEP 3: A setup function to attach the event listeners
export function setupOnlineSyncListener() {
  // Immediately check for failed batches when the app loads
  retryFailedBatches();

  // Add a listener to automatically retry when the browser comes back online
  window.addEventListener("online", retryFailedBatches);

  console.log("👂 Online sync listener is active.");
}




// ✅ MODIFIED: This function now loads all three JSON files.
export async function loadFromJSONFiles(bookId) {
  console.log(`Attempting to load all pre-generated JSON for book: ${bookId}`);
  try {
    // Fetch all three files concurrently for maximum speed
    const [
      nodeChunksResponse,
      footnotesResponse,
      referencesResponse,
    ] = await Promise.all([
      fetch(`/markdown/${bookId}/nodeChunks.json`),
      fetch(`/markdown/${bookId}/footnotes.json`),
      fetch(`/markdown/${bookId}/references.json`),
    ]);

    // Check if all requests were successful
    if (
      !nodeChunksResponse.ok ||
      !footnotesResponse.ok ||
      !referencesResponse.ok
    ) {
      throw new Error("One or more required JSON files not found (404).");
    }

    // Parse all JSON responses concurrently
    const [
      nodeChunks,
      footnotes,
      references,
    ] = await Promise.all([
      nodeChunksResponse.json(),
      footnotesResponse.json(),
      referencesResponse.json(),
    ]);

    console.log(`✅ Successfully fetched all JSON files for ${bookId}.`);
    console.log(`   - Found ${nodeChunks.length} nodeChunks.`);
    console.log(`   - Found ${footnotes.length} footnotes.`);
    console.log(`   - Found ${references.length} references.`);

    // Save all the fetched data to IndexedDB concurrently
    await Promise.all([
      saveAllNodeChunksToIndexedDB(nodeChunks, bookId),
      saveAllFootnotesToIndexedDB(footnotes, bookId),
      saveAllReferencesToIndexedDB(references, bookId),
    ]);

    // Return the nodeChunks to be used immediately for rendering the page
    return nodeChunks;
  } catch (error) {
    console.warn(
      `Could not load from JSON files. Reason: ${error.message}`
    );
    throw error; // Re-throw to trigger the fallback
  }
}

// ✅ MODIFIED: Your main loading function now calls the new loader.
export async function loadHyperText(bookId) {
  resetFirstChunkPromise();
  const currentBook = bookId || book;
  console.log(`📖 Opening: ${currentBook}`);
  setupOnlineSyncListener();
  const openHyperlightID = OpenHyperlightID || null;

  try {
    // 1. Check for node chunks in IndexedDB (No change)
    console.log("🔍 Checking if nodeChunks are in IndexedDB...");
    const cached = await getNodeChunksFromIndexedDB(currentBook);
    if (cached && cached.length) {
      // ... (no change to this block)
      console.log(`✅ Found ${cached.length} cached nodeChunks`);
      window.nodeChunks = cached;
      await buildUserHighlightCache(currentBook);
      initializeLazyLoader(openHyperlightID, currentBook);
      checkAndUpdateIfNeeded(currentBook, currentLazyLoader);
      return;
    }

    // 2. Try Database Sync (No change)
    console.log("🔍 Trying to load chunks from database...");
    const dbResult = await syncBookDataFromDatabase(currentBook);
    if (dbResult && dbResult.success) {
      // ... (no change to this block)
      const dbChunks = await getNodeChunksFromIndexedDB(currentBook);
      if (dbChunks && dbChunks.length) {
        console.log(`✅ Loaded ${dbChunks.length} nodeChunks from database`);
        window.nodeChunks = dbChunks;
        await buildUserHighlightCache(currentBook);
        initializeLazyLoader(openHyperlightID, currentBook);
        return;
      }
    }

    // 3. Fallback: Try to load from pre-generated JSON
    try {
      // This now calls our new, more powerful function
      const jsonChunks = await loadFromJSONFiles(currentBook);
      if (jsonChunks && jsonChunks.length) {
        console.log("✅ Content loaded from JSON; now initializing UI");
        window.nodeChunks = jsonChunks;
        await buildUserHighlightCache(currentBook);
        initializeLazyLoader(openHyperlightID, currentBook);
        return;
      }
    } catch (error) {
      console.log("ℹ️ JSON loading failed. Falling back to markdown parsing...");
    }

    // 4. Final Fallback: Generate from markdown (No change)
    console.log("🆕 Not in cache, DB, or JSON – generating from markdown");
    window.nodeChunks = await generateNodeChunksFromMarkdown(currentBook);
    console.log("✅ Content generated + saved; now initializing UI");
    await buildUserHighlightCache(currentBook);
    initializeLazyLoader(OpenHyperlightID || null, currentBook);
    return;
  } catch (err) {
    console.error("❌ A critical error occurred during content loading:", err);
    if (firstChunkLoadedResolver) {
      firstChunkLoadedResolver();
    }
  }
}


// Helper function: Cache buster for forced reloads
function buildUrl(path, forceReload = false) {
  return forceReload ? `${path}?v=${Date.now()}` : path;
}

// Updated to accept bookId parameter
async function fetchMainTextMarkdown(bookId, forceReload = false) {
  const response = await fetch(buildUrl(`/markdown/${bookId}/main-text.md`, forceReload));
  if (!response.ok) {
    throw new Error(`Failed to fetch main-text.md for ${bookId}`);
  }
  return response.text();
}

// Updated to accept bookId parameter
async function generateNodeChunksFromMarkdown(bookId, forceReload = false) {
  const markdown = await fetchMainTextMarkdown(bookId);
  
  // Parse markdown into nodeChunks
  const nodeChunks = parseMarkdownIntoChunksInitial(markdown);
  console.log(`✅ Generated ${nodeChunks.length} nodeChunks from markdown for ${bookId}`);

  // Add detailed footnote logging
  const totalFootnotes = nodeChunks.reduce((sum, chunk) => sum + chunk.footnotes.length, 0);
  console.log(`📝 Found ${totalFootnotes} footnotes across all chunks for ${bookId}`);

  // Log some sample footnotes if any exist
  if (totalFootnotes > 0) {
    // Find chunks with footnotes
    const chunksWithFootnotes = nodeChunks.filter(chunk => chunk.footnotes.length > 0);
    
    console.log(`📋 Footnote distribution: ${chunksWithFootnotes.length} chunks contain footnotes`);
    
    // Log details of the first few chunks with footnotes
    const samplesToShow = Math.min(3, chunksWithFootnotes.length);
    
    console.log(`🔍 Showing footnote details for ${samplesToShow} sample chunks:`);
    
    for (let i = 0; i < samplesToShow; i++) {
      const chunk = chunksWithFootnotes[i];
      console.log(`\n📄 Chunk #${chunk.chunk_id} (Node #${chunk.startLine}, type: ${chunk.type}):`);
      console.log(`   Text preview: "${chunk.plainText.substring(0, 50)}${chunk.plainText.length > 50 ? '...' : ''}"`);
      
      chunk.footnotes.forEach((footnote, index) => {
        console.log(`   📌 Footnote ${index + 1}/${chunk.footnotes.length}:`);
        console.log(`      ID: ${footnote.id}`);
        console.log(`      Reference at line: ${footnote.referenceLine}`);
        console.log(`      Definition at line: ${footnote.definitionLine}`);
        console.log(`      Content: "${footnote.content.substring(0, 100)}${footnote.content.length > 100 ? '...' : ''}"`);
      });
    }
    
    // Log a summary of all footnote IDs found
    const allFootnoteIds = nodeChunks
      .flatMap(chunk => chunk.footnotes)
      .map(footnote => footnote.id);
    
    const uniqueIds = [...new Set(allFootnoteIds)];
    console.log(`\n🔢 Found ${uniqueIds.length} unique footnote IDs: ${uniqueIds.join(', ')}`);
    
    // Check for any potential issues
    const multipleRefsToSameId = uniqueIds.filter(id => 
      allFootnoteIds.filter(fid => fid === id).length > 1
    );
    
    if (multipleRefsToSameId.length > 0) {
      console.log(`⚠️ Note: Found ${multipleRefsToSameId.length} footnote IDs with multiple references: ${multipleRefsToSameId.join(', ')}`);
    }
  }
  
  // Pass the callback to the save function
  await saveAllNodeChunksToIndexedDB(nodeChunks, bookId);
  return nodeChunks;
}

// Store multiple lazy loaders by bookId
export const lazyLoaders = {};

// Keep your existing single lazy loader for backward compatibility
export let currentLazyLoader = null;

// Your existing function - unchanged for backward compatibility
export function initializeMainLazyLoader() {
  if (currentLazyLoader) {
    console.log("✅ Lazy loader already initialized. Skipping reinitialization.");
    return currentLazyLoader;
  }
  
  // Debug the book variable
  console.log(`Book variable value: ${book}, type: ${typeof book}`);
  
  // If book is undefined or not what you expect, set a default or log an error
  if (!book) {
    console.error("Book variable is undefined or empty!");
  }
  
  console.log(`Initializing lazy loader for book: ${book}`);
  currentLazyLoader = createLazyLoader({
    nodeChunks: window.nodeChunks,
    loadNextChunk: loadNextChunkFixed,
    loadPreviousChunk: loadPreviousChunkFixed,
    attachMarkListeners,
    bookId: book,
  });
  
  return currentLazyLoader;
}


// Function for homepage multi-book support
export async function initializeLazyLoaderForContainer(bookId) {
  console.log(`🔄 Initializing lazy loader for book: ${bookId}`);
  
  // If we already have a lazy loader for this book, don't recreate
  if (lazyLoaders[bookId]) {
    console.log(`✅ Lazy loader for ${bookId} already exists`);
    return lazyLoaders[bookId];
  }
  
  // Check if content is already loaded in the DOM
  const container = document.getElementById(bookId);
  const existingChunks = container?.querySelectorAll('.chunk');
  if (existingChunks && existingChunks.length > 0) {
    console.log(`📄 Content already exists in DOM for ${bookId}, skipping reload`);
    
    // Still create the lazy loader for scroll management, but don't reload content
    try {
      let nodeChunks = await getNodeChunksFromIndexedDB(bookId);
      
      if (!nodeChunks || !nodeChunks.length) {
        console.log(`🔍 Loading ${bookId} from database...`);
        const dbResult = await syncBookDataFromDatabase(bookId);
        if (dbResult && dbResult.success) {
          nodeChunks = await getNodeChunksFromIndexedDB(bookId);
        }
      }
      
      if (!nodeChunks || !nodeChunks.length) {
        console.log(`🆕 Generating ${bookId} from markdown`);
        nodeChunks = await generateNodeChunksFromMarkdown(bookId, true);
      }
      
      if (nodeChunks && nodeChunks.length) {
        lazyLoaders[bookId] = createLazyLoader({
          nodeChunks: nodeChunks,
          loadNextChunk: loadNextChunkFixed,
          loadPreviousChunk: loadPreviousChunkFixed,
          attachMarkListeners,
          bookId: bookId,
          skipInitialLoad: true // Add this flag to prevent initial content loading
        });
        
        console.log(`✅ Lazy loader created for existing content: ${bookId}`);
        return lazyLoaders[bookId];
      }
    } catch (error) {
      console.error(`❌ Error creating lazy loader for existing content ${bookId}:`, error);
    }
    return null;
  }
  
  try {
    // Load the book data (existing code for new content)
    let nodeChunks = await getNodeChunksFromIndexedDB(bookId);
    
    if (!nodeChunks || !nodeChunks.length) {
      console.log(`🔍 Loading ${bookId} from database...`);
      const dbResult = await syncBookDataFromDatabase(bookId);
      if (dbResult && dbResult.success) {
        nodeChunks = await getNodeChunksFromIndexedDB(bookId);
      }
    }
    
    if (!nodeChunks || !nodeChunks.length) {
      console.log(`🆕 Generating ${bookId} from markdown`);
      nodeChunks = await generateNodeChunksFromMarkdown(bookId, true);
    }
    
    if (!nodeChunks || !nodeChunks.length) {
      console.error(`❌ No nodeChunks available for ${bookId}`);
      return null;
    }
    
    // Create new lazy loader instance
    lazyLoaders[bookId] = createLazyLoader({
      nodeChunks: nodeChunks,
      loadNextChunk: loadNextChunkFixed,
      loadPreviousChunk: loadPreviousChunkFixed,
      attachMarkListeners,
      bookId: bookId
    });
    
    // Load the first chunk manually since the observer might not trigger immediately
    const firstChunk = nodeChunks.find(chunk => chunk.chunk_id === 0) || nodeChunks[0];
    if (firstChunk && lazyLoaders[bookId]) {
      console.log(`📄 Loading initial chunk ${firstChunk.chunk_id} for ${bookId}`);
      lazyLoaders[bookId].loadChunk(firstChunk.chunk_id, "down");
    }
    
    console.log(`✅ Lazy loader created for ${bookId}`);
    return lazyLoaders[bookId];
    
  } catch (error) {
    console.error(`❌ Error initializing lazy loader for ${bookId}:`, error);
  }
}



// Your existing helper function - unchanged
function initializeLazyLoader(openHyperlightID, bookId) { // <-- Add bookId parameter
  if (!currentLazyLoader) {
    currentLazyLoader = createLazyLoader({
      nodeChunks: window.nodeChunks,
      loadNextChunk: loadNextChunkFixed,
      loadPreviousChunk: loadPreviousChunkFixed,
      attachMarkListeners,
      bookId: bookId, // <-- Use the passed-in bookId
      isNavigatingToInternalId: !!openHyperlightID,
      onFirstChunkLoaded: firstChunkLoadedResolver
    });
    
    if (openHyperlightID) {
      setTimeout(() => {
        navigateToElement(openHyperlightID);
      }, 300);
    }
  }
}

// Your existing function - unchanged
function navigateToElement(elementId) {
  const element = document.getElementById(elementId);
  if (element) {
    console.log(`Navigating to element: ${elementId}`);
    element.scrollIntoView({ behavior: 'smooth', block: 'center' });
  } else {
    console.log(`Element not found: ${elementId}, will try loading more content`);
  }
}

async function checkAndUpdateIfNeeded(bookId, lazyLoader) {
  // ===================== THE FIX =====================
  // First, check if this is the brand-new book we just created.
  const pendingSyncJSON = sessionStorage.getItem("pending_new_book_sync");
  if (pendingSyncJSON) {
    try {
      const pendingSync = JSON.parse(pendingSyncJSON);
      // If the pending sync is for the book we are currently loading...
      if (pendingSync.bookId === bookId) {
        console.log(
          `✅ Skipping server timestamp check for new book "${bookId}" that is pending sync.`
        );
        // ...then we know it doesn't exist on the server yet.
        // There's nothing to compare, so we exit the function early.
        return;
      }
    } catch (e) {
      console.error(
        "Could not parse pending_new_book_sync from sessionStorage",
        e
      );
    }
  }

  // This part only runs for EXISTING books.
  if (!lazyLoader) {
    console.warn(
      "⚠️ Timestamp check skipped: lazyLoader instance not provided."
    );
    return;
  }

  // ===================================================

  try {
    // The log message is now more accurate, as it only runs for existing books.
    console.log(`🕐 Starting async timestamp check for existing book: ${bookId}`);

    // Get both records in parallel
    const [serverRecord, localRecord] = await Promise.all([
      getLibraryRecordFromServer(bookId),
      getLibraryRecordFromIndexedDB(bookId),
    ]);

    // Handle case where server request failed
    if (!serverRecord) {
      console.log(`⚠️ Could not fetch server data for ${bookId}. Skipping timestamp check.`);
      return;
    }
    
    if (!localRecord) {
      console.log(`⚠️ No local data found for ${bookId}. Skipping timestamp check.`);
      return;
    }

    const serverTimestamp = new Date(serverRecord.timestamp).getTime();
    const localTimestamp = new Date(localRecord.timestamp).getTime();

    if (serverTimestamp > localTimestamp) {
      console.log(
        `🔥 Server content is newer for ${bookId}. Syncing in background...`
      );
      await syncBookDataFromDatabase(bookId, true); // Download new data
      notifyContentUpdated();

      // Tell the already-rendered page to refresh itself with the new data.
      console.log(
        `🔄 Triggering lazyLoader.refresh() to display updated content.`
      );
      await lazyLoader.refresh();
    } else {
      console.log(
        `✅ Local content is up-to-date for ${bookId}. No action needed.`
      );
    }
  } catch (err) {
    console.error("❌ Error during background timestamp check:", err);
  }
}

// Helper function to get library record from server
async function getLibraryRecordFromServer(bookId) {
  try {
    const response = await fetch(`/api/database-to-indexeddb/books/${bookId}/library`, {
      headers: {
        'Authorization': `Bearer ${localStorage.getItem('authToken')}`,
        'Content-Type': 'application/json'
      }
    });
    
    if (!response.ok) {
      throw new Error(`Server responded with ${response.status}`);
    }
    
    const data = await response.json();
    console.log("🔍 Full server response:", data);
    console.log("🔍 Library data:", data.library);
    console.log("🔍 Timestamp in library:", data.library?.timestamp);
    
    return data.success ? data.library : null;
  } catch (err) {
    console.error("❌ Error fetching library record from server:", err);
    return null;
  }
}

// Helper function to get library record from IndexedDB
async function getLibraryRecordFromIndexedDB(bookId) {
  try {
    const db = await openDatabase();
    const tx = db.transaction("library", "readonly");
    const store = tx.objectStore("library");
    
    return new Promise((resolve, reject) => {
      const request = store.get(bookId);
      
      request.onsuccess = () => {
        resolve(request.result || null);
      };
      
      request.onerror = () => {
        reject("❌ Error loading library record from IndexedDB");
      };
    });
  } catch (err) {
    console.error("❌ Error accessing library record in IndexedDB:", err);
    return null;
  }
}

// Optional: Function to notify UI that content was updated
function notifyContentUpdated() {
  // You could dispatch a custom event, show a toast notification, etc.
  console.log("📢 Content has been updated in the background");
  
  // Example: dispatch custom event
  window.dispatchEvent(new CustomEvent('contentUpdated', {
    detail: { bookId: book }
  }));
}



