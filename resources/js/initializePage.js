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
  executeSyncPayload
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

async function retryFailedBatches() {
  // Don't run if already retrying or if we're still offline
  if (isRetrying || !navigator.onLine) {
    return;
  }

  isRetrying = true;
  console.log("🔁 Network is online. Checking for failed sync batches...");

  try {
    const db = await openDatabase();
    
    // ===================================================================
    // THE FIX IS HERE: Replace the incorrect line with this standard IndexedDB pattern.
    // ===================================================================
    const tx = db.transaction("historyLog", "readonly");
    const store = tx.objectStore("historyLog");
    const index = store.index("status");

    const failedLogs = await new Promise((resolve, reject) => {
      // Get all records where the 'status' index is "failed"
      const request = index.getAll("failed");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    // ===================================================================

    if (failedLogs.length === 0) {
      console.log("✅ No failed batches to retry.");
      isRetrying = false;
      return;
    }

    console.log(`Retrying ${failedLogs.length} failed sync batches...`);

    // Process one by one to maintain order
    for (const log of failedLogs) {
      try {
        await executeSyncPayload(log.payload);
        // It worked! Update the status to 'synced'
        log.status = "synced";
        await updateHistoryLog(log);
        console.log(`✅ Successfully retried batch ${log.id}`);
      } catch (error) {
        console.error(`❌ Retry for batch ${log.id} failed again. Will stop for now.`);
        // Stop on the first failure to maintain order and prevent spamming a broken endpoint
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


// Your existing function - unchanged for backward compatibility
export async function loadHyperText() {
  console.log(`📖 Opening: ${book}`);
  
  setupOnlineSyncListener();

  const openHyperlightID = OpenHyperlightID || null;
  if (openHyperlightID) {
    console.log(`🔍 Found OpenHyperlightID to navigate to: ${openHyperlightID}`);
  }
  
  try {
    // 1. Check for node chunks in indexedDB
    console.log("🔍 Checking if nodeChunks are in IndexedDB...");
    const cached = await getNodeChunksFromIndexedDB(book);
    if (cached && cached.length) {
      console.log(`✅ Found ${cached.length} cached nodeChunks`);
      window.nodeChunks = cached;
      
      await buildUserHighlightCache(book);
      
      initializeLazyLoader(openHyperlightID);

      checkAndUpdateIfNeeded(book);

      return;
    }

    // 2. Try Database
    console.log("🔍 Trying to load chunks from database...");
    const dbResult = await syncBookDataFromDatabase(book);
    if (dbResult && dbResult.success) {
      const dbChunks = await getNodeChunksFromIndexedDB(book);
      if (dbChunks && dbChunks.length) {
        console.log(`✅ Loaded ${dbChunks.length} nodeChunks from database`);
        window.nodeChunks = dbChunks;
        
        // 🚨 BUILD USER HIGHLIGHT CACHE HERE
        await buildUserHighlightCache(book);
        
        initializeLazyLoader(openHyperlightID);
        return;
      }
    }

    // 3. Generate from markdown with notification
    console.log("🆕 Not in database or indexedDB – generating from markdown");
    
    window.nodeChunks = await generateNodeChunksFromMarkdown(book);
    console.log("✅ Content generated + saved; now initializing UI");
    
    // 🚨 BUILD USER HIGHLIGHT CACHE HERE
    await buildUserHighlightCache(book);
    
    initializeLazyLoader(OpenHyperlightID || null);
    console.log("✅ Content loading complete");
    return;
  } catch (err) {
    console.error("❌ Error loading content:", err);
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
function initializeLazyLoader(openHyperlightID) {
  if (!currentLazyLoader) {
    currentLazyLoader = createLazyLoader({
      nodeChunks: window.nodeChunks,
      loadNextChunk: loadNextChunkFixed,
      loadPreviousChunk: loadPreviousChunkFixed,
      attachMarkListeners,
      bookId: book,
      isNavigatingToInternalId: !!openHyperlightID
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

// New async function to check timestamps and update if needed
async function checkAndUpdateIfNeeded(bookId) {
  try {
    console.log("🕐 Starting async timestamp check...");
    
    // Get both records in parallel
    const [serverRecord, localRecord] = await Promise.all([
      getLibraryRecordFromServer(bookId),
      getLibraryRecordFromIndexedDB(bookId)
    ]);

    if (!serverRecord || !localRecord) {
      console.log("⚠️ Missing server or local library record for timestamp comparison");
      console.log("Server record:", serverRecord);
      console.log("Local record:", localRecord);
      return;
    }

    // Debug the timestamp values
    console.log("🔍 Raw timestamps:", {
      server: serverRecord.timestamp,
      local: localRecord.timestamp
    });

    // Get timestamp values
    const serverTimestampValue = serverRecord.timestamp;
    const localTimestampValue = localRecord.timestamp;

    // Validate timestamp values exist
    if (!serverTimestampValue || !localTimestampValue) {
      console.log("⚠️ Missing timestamp values:");
      console.log("Server timestamp:", serverTimestampValue);
      console.log("Local timestamp:", localTimestampValue);
      return;
    }

    // Create Date objects with validation
    const serverTimestamp = new Date(serverTimestampValue);
    const localTimestamp = new Date(localTimestampValue);

    // Check if dates are valid
    if (isNaN(serverTimestamp.getTime()) || isNaN(localTimestamp.getTime())) {
      console.error("❌ Invalid timestamp format:");
      console.log("Server timestamp:", serverTimestampValue, "→", serverTimestamp);
      console.log("Local timestamp:", localTimestampValue, "→", localTimestamp);
      return;
    }

    console.log(`🕐 Server timestamp: ${serverTimestamp.toISOString()}`);
    console.log(`🕐 Local timestamp: ${localTimestamp.toISOString()}`);

    if (serverTimestamp > localTimestamp) {
      console.log("🔄 Server version is newer - updating from database...");
      
      // Update from server
      const dbResult = await syncBookDataFromDatabase(bookId);
      if (dbResult && dbResult.success) {
        // Reload the nodeChunks
        const updatedChunks = await getNodeChunksFromIndexedDB(bookId);
        if (updatedChunks && updatedChunks.length) {
          console.log(`🔄 Updated to ${updatedChunks.length} newer nodeChunks`);
          window.nodeChunks = updatedChunks;
          
          // Optionally trigger a re-render or notification
          notifyContentUpdated();
        }
      }
    } else {
      console.log("✅ Local version is up to date");
    }
    
  } catch (err) {
    console.error("❌ Error during timestamp check:", err);
    console.error("Error stack:", err.stack);
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



