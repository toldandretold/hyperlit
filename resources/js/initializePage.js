import { book } from './app.js';

import {
  createLazyLoader,
  loadNextChunkFixed,
  loadPreviousChunkFixed,
} from "./lazyLoaderFactory.js";

import {
  openDatabase,
  getNodeChunksFromIndexedDB,
  saveNodeChunksToIndexedDB,
} from "./cache-indexedDB.js";

import {
  attachMarkListeners,
} from "./hyper-lights-cites.js";

import { parseMarkdownIntoChunks } from "./convert-markdown.js";
import { loadFootnotes } from "./footnotes.js";

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
async function generateNodeChunksFromMarkdown(forceReload = false) {
  console.log("🚦 Generating nodeChunks from markdown...");
  const markdown = await fetchMainTextMarkdown(forceReload);
  
  // Save the markdown globally (needed when resolving internal links)
  window.markdownContent = markdown;
  
  // Parse markdown into nodeChunks
  const nodeChunks = parseMarkdownIntoChunks(markdown);
  console.log(`✅ Generated ${nodeChunks.length} nodeChunks from markdown`);
  
  // Save to IndexedDB
  await saveNodeChunksToIndexedDB(nodeChunks, book);
  
  return nodeChunks;
}

// Trigger backend update (optional, can be removed if not needed)
async function triggerBackendUpdate() {
  try {
    const backendResponse = await fetch(`/update-markdown/${book}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-TOKEN": document.querySelector('meta[name="csrf-token"]')?.content,
      },
    });
    
    if (!backendResponse.ok) {
      throw new Error(`Failed to trigger backend update: ${backendResponse.statusText}`);
    }
    
    const result = await backendResponse.json();
    if (result.success) {
      console.log("✅ Backend update successful:", result.message);
    } else {
      console.error("❌ Backend update failed:", result.message);
    }
  } catch (error) {
    console.error("❌ Error during backend update:", error);
  }
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

// Main Entry Point - Simplified
export async function loadMarkdownFile() {
  console.log(`🚀 Loading content for book: ${book}`);
  
  try {
    // 1. Check if nodeChunks exist in IndexedDB
    console.log("🔍 Checking for cached nodeChunks in IndexedDB...");
    const cachedNodeChunks = await getNodeChunksFromIndexedDB(book);
    
    if (cachedNodeChunks && cachedNodeChunks.length > 0) {
      // Use cached nodeChunks
      console.log(`✅ Found ${cachedNodeChunks.length} cached nodeChunks in IndexedDB`);
      window.nodeChunks = cachedNodeChunks;
    } else {
      // Generate new nodeChunks from markdown
      console.log("⚠️ No cached nodeChunks found. Generating from markdown...");
      window.nodeChunks = await generateNodeChunksFromMarkdown(true);
      
      // Optional: Trigger backend update
      // await triggerBackendUpdate();
    }
    
    // 2. Load footnotes
    await loadFootnotes();
    
    // 3. Initialize lazy loader
    if (!currentLazyLoader) {
      initializeMainLazyLoader();
    }
    
    console.log("✅ Content loading complete");
    
  } catch (error) {
    console.error("❌ Error loading content:", error);
  }
}

// Navigation helper functions
export function loadContentAroundLine(lineNumber) {
  if (!window.nodeChunks || !currentLazyLoader) {
    console.error("❌ Cannot navigate: nodeChunks or lazyLoader not initialized");
    return;
  }
  
  console.log(`🔍 Navigating to line: ${lineNumber}`);
  
  // Find the chunk containing this line
  const targetChunk = window.nodeChunks.find(
    chunk => lineNumber >= chunk.startLine && lineNumber <= chunk.endLine
  );
  
  if (!targetChunk) {
    console.warn(`❌ No chunk found containing line ${lineNumber}`);
    return;
  }
  
  // Load the chunk and scroll to the element
  currentLazyLoader.loadChunkById(targetChunk.chunkId);
  
  // Wait for DOM to update, then scroll
  setTimeout(() => {
    const targetElement = document.getElementById(lineNumber.toString());
    if (targetElement) {
      targetElement.scrollIntoView({ behavior: "smooth", block: "center" });
    } else {
      console.error(`❌ Element with ID "${lineNumber}" not found after loading chunk`);
    }
  }, 100);
}

export function loadContentAroundId(elementId) {
  if (!window.nodeChunks || !currentLazyLoader) {
    console.error("❌ Cannot navigate: nodeChunks or lazyLoader not initialized");
    return;
  }
  
  console.log(`🔍 Navigating to element ID: ${elementId}`);
  
  // First try to find the element directly (it might already be loaded)
  const element = document.getElementById(elementId);
  if (element) {
    element.scrollIntoView({ behavior: "smooth", block: "center" });
    return;
  }
  
  // If not found, we need to search through nodeChunks
  // This assumes you have a way to map element IDs to line numbers
  // For now, we'll just load chunks sequentially until we find it
  
  let currentChunkIndex = 0;
  
  function loadNextChunkAndCheck() {
    if (currentChunkIndex >= window.nodeChunks.length) {
      console.error(`❌ Element with ID "${elementId}" not found in any chunk`);
      return;
    }
    
    const chunk = window.nodeChunks[currentChunkIndex];
    currentLazyLoader.loadChunkById(chunk.chunkId);
    
    setTimeout(() => {
      const element = document.getElementById(elementId);
      if (element) {
        element.scrollIntoView({ behavior: "smooth", block: "center" });
      } else {
        currentChunkIndex++;
        loadNextChunkAndCheck();
      }
    }, 100);
  }
  
  loadNextChunkAndCheck();
}
