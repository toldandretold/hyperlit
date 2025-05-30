import { book, OpenHyperlightID } from './app.js';

import {
  createLazyLoader,
  loadNextChunkFixed,
  loadPreviousChunkFixed,
} from "./lazyLoaderFactory.js";

import {
  openDatabase,
  getNodeChunksFromIndexedDB,
  saveNodeChunksToIndexedDB,
  saveFootnotesToIndexedDB
} from "./cache-indexedDB.js";

import {
  attachMarkListeners,
} from "./hyperLights.js";

import { parseMarkdownIntoChunksInitial } from "./convert-markdown.js";

import { syncBookDataFromDatabase } from "./postgreSQL.js";

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
  const markdown = await fetchMainTextMarkdown(bookId, forceReload);
  
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
  
  // Save to IndexedDB
  await saveNodeChunksToIndexedDB(nodeChunks, bookId);
  
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

// NEW: Function for homepage multi-book support
// NEW: Function for homepage multi-book support
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

// Your existing function - unchanged for backward compatibility
export async function loadMarkdownFile() {
  console.log(`📖 Opening: ${book}`);
  console.log("📝 Book variable:", book, "Type:", typeof book);

  const openHyperlightID = OpenHyperlightID || null;
  if (openHyperlightID) {
    console.log(`🔍 Found OpenHyperlightID to navigate to: ${openHyperlightID}`);
  }
  
  try {
    // 1. Check for cached nodeChunks
    console.log("🔍 Checking if nodeChunks are in IndexedDB...");
    const cached = await getNodeChunksFromIndexedDB(book);
    if (cached && cached.length) {
      console.log(`✅ Found ${cached.length} cached nodeChunks`);
      window.nodeChunks = cached;
      initializeLazyLoader(openHyperlightID);
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
        initializeLazyLoader(openHyperlightID);
        return;
      }
    }

    // 3. Generate from markdown
    console.log("🆕 Not in database or indexedDB – generating from markdown");
    window.nodeChunks = await generateNodeChunksFromMarkdown(book, true);
    initializeLazyLoader(openHyperlightID);

    console.log("✅ Content loading complete");
    return;

  } catch (err) {
    console.error("❌ Error loading content:", err);
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
