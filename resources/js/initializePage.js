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

// Fetch the main markdown file
async function fetchMainTextMarkdown(forceReload = false) {
  const response = await fetch(buildUrl(`/markdown/${book}/main-text.md`, forceReload));
  if (!response.ok) {
    throw new Error(`Failed to fetch main-text.md for ${book}`);
  }
  return response.text();
}

// Process markdown and generate nodeChunks
// Process markdown and generate nodeChunks
async function generateNodeChunksFromMarkdown(forceReload = false) {
  const markdown = await fetchMainTextMarkdown(forceReload);
  
  // Parse markdown into nodeChunks
 const nodeChunks = parseMarkdownIntoChunksInitial(markdown);
  console.log(`✅ Generated ${nodeChunks.length} nodeChunks from markdown`);

 

// Add detailed footnote logging
const totalFootnotes = nodeChunks.reduce((sum, chunk) => sum + chunk.footnotes.length, 0);
console.log(`📝 Found ${totalFootnotes} footnotes across all chunks`);

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
  await saveNodeChunksToIndexedDB(nodeChunks, book);

  
  return nodeChunks;
}



// Lazy Loader Initialization
export let currentLazyLoader = null;

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
    // You might want to set a default here
    // book = "your-default-book-id";
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



// In your loadMarkdownFile function
export async function loadMarkdownFile() {
  console.log(`📖 Opening: ${book}`);
  console.log("📝 Book variable:", book, "Type:", typeof book); // Move this to the top
  
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
      initializeLazyLoader(openHyperlightID); // ADD THIS
      return; // ADD THIS - Don't continue to database!
    }

    // 2. Try Database
    console.log("🔍 Not in IndexedDB, trying database...");
    const dbResult = await syncBookDataFromDatabase(book);
    if (dbResult && dbResult.success) {
      const dbChunks = await getNodeChunksFromIndexedDB(book);
      if (dbChunks && dbChunks.length) {
        console.log(`✅ Loaded ${dbChunks.length} nodeChunks from database`);
        window.nodeChunks = dbChunks;
        initializeLazyLoader(openHyperlightID); // ADD THIS
        return; // ADD THIS
      }
    }

    // 3. Generate from markdown
    console.log("🆕 Not in database or indexedDB – generating from markdown");
    window.nodeChunks = await generateNodeChunksFromMarkdown(true);
    initializeLazyLoader(openHyperlightID); // ADD THIS

    console.log("✅ Content loading complete");
    document.dispatchEvent(new Event("pageReady"));

  } catch (err) {
    console.error("❌ Error loading content:", err);
  }
}

// Helper function
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


// Simple function to navigate to an element by ID
function navigateToElement(elementId) {
  const element = document.getElementById(elementId);
  if (element) {
    console.log(`Navigating to element: ${elementId}`);
    element.scrollIntoView({ behavior: 'smooth', block: 'center' });
  } else {
    console.log(`Element not found: ${elementId}, will try loading more content`);
    // You might need additional logic here to load more chunks
  }
}






