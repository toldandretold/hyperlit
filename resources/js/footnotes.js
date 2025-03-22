// footnotes.js
import { book } from "./app.js";
import {
  openDatabase,
  getFootnotesFromIndexedDB,
  saveFootnotesToIndexedDB
} from "./cache-indexedDB.js";
import { convertMarkdownToHtml } from "./convert-markdown.js";
import { attachMarkListeners } from "./hyper-lights-cites.js";
import { ContainerManager } from "./container-manager.js";

// Create a container manager for references
const refManager = new ContainerManager(
  "ref-container",   // The container to manage
  "ref-overlay",     // The overlay element
  null,              // No dedicated toggle button
  ["main-content", "nav-buttons"] // IDs to freeze when ref-container is open
);

// Export the DOM elements for backward compatibility
export const refContainer = document.getElementById("ref-container");
export const refOverlay = document.getElementById("ref-overlay");
// Export isRefOpen as a getter that returns the current state from the manager
export const isRefOpen = refManager.isOpen;

// Function to open the footnotes container with content
export function openReferenceContainer(content) {
  refManager.openContainer(content);
}

// Function to close the reference container
export function closeReferenceContainer() {
  refManager.closeContainer();
}

// Flag to determine if we're using the new embedded footnotes approach
const useEmbeddedFootnotes = true;

// Log footnotes data from nodeChunks for debugging
export function logFootnotesData() {
  if (!window.nodeChunks) {
    console.warn("nodeChunks not available yet");
    return;
  }
  
  const totalFootnotes = window.nodeChunks.reduce(
    (sum, chunk) => sum + (chunk.footnotes ? chunk.footnotes.length : 0), 0
  );
  
  console.log(`📝 Found ${totalFootnotes} footnotes across all chunks`);
  
  if (totalFootnotes > 0) {
    // Find chunks with footnotes
    const chunksWithFootnotes = window.nodeChunks.filter(
      chunk => chunk.footnotes && chunk.footnotes.length > 0
    );
    
    console.log(`📋 Footnote distribution: ${chunksWithFootnotes.length} chunks contain footnotes`);
    
    // Log details of the first few chunks with footnotes
    const samplesToShow = Math.min(3, chunksWithFootnotes.length);
    
    console.log(`🔍 Showing footnote details for ${samplesToShow} sample chunks:`);
    
    for (let i = 0; i < samplesToShow; i++) {
      const chunk = chunksWithFootnotes[i];
      console.log(`\n📄 Chunk #${chunk.chunk_id} (Node #${chunk.startLine}, type: ${chunk.type}):`);
      
      chunk.footnotes.forEach((footnote, index) => {
        console.log(`   📌 Footnote ${index + 1}/${chunk.footnotes.length}:`);
        console.log(`      ID: ${footnote.id}`);
        console.log(`      Reference at line: ${footnote.referenceLine}`);
        console.log(`      Definition at line: ${footnote.definitionLine}`);
        console.log(`      Content: "${footnote.content.substring(0, 100)}${footnote.content.length > 100 ? '...' : ''}"`);
      });
    }
  }
}

// Footnotes handling - legacy approach
/*export async function loadFootnotes(book) {
  // If using embedded footnotes, we don't need to load from external sources
  if (useEmbeddedFootnotes && window.nodeChunks && window.nodeChunks.length > 0) {
    console.log("✅ Using embedded footnotes from nodeChunks.");
    return window.nodeChunks;
  }

  // Legacy approach - try loading footnotes data from IndexedDB first
  let footnotesData = await getFootnotesFromIndexedDB(book);
  if (footnotesData) {
    console.log("✅ Footnotes for book", book, "loaded from IndexedDB.");
    return footnotesData;
  }

  console.warn(`⚠️ No footnotes found for book ${book} in IndexedDB.`);
  console.log("🌍 Generating footnotes on the server...");

  // Call the controller endpoint to generate the updated footnotes.json file
  const refreshResponse = await fetch(`/footnotes/refresh/${book}`);
  if (refreshResponse.ok) {
    const refreshResult = await refreshResponse.json();
    if (refreshResult.success) {
      console.log("✅ Footnotes refreshed on server:", refreshResult.message);
    } else {
      console.error("❌ Server error refreshing footnotes:", refreshResult.message);
      return null;
    }
  } else {
    console.error("❌ Failed to call the refresh endpoint.");
    return null;
  }

  // Once the generation is successful, fetch the updated footnotes.json file
  const storedFootnotesTimestamp =
    localStorage.getItem("footnotesLastModified") || "0";
  const freshJsonUrl = window.getFreshUrl(
    `/markdown/${book}/footnotes.json`,
    storedFootnotesTimestamp
  );

  const jsonResponse = await fetch(freshJsonUrl);
  if (jsonResponse.ok) {
    footnotesData = await jsonResponse.json();
    // Save the fetched data to IndexedDB
    await saveFootnotesToIndexedDB(footnotesData, book);
    console.log("✅ Footnotes loaded and saved to IndexedDB.");
    return footnotesData;
  } else {
    console.error("❌ Failed to fetch the updated footnotes.json file.");
    return null;
  }
} */


// Display footnote - supports both embedded and legacy approaches
export async function displayFootnote(noteElement) {
  // Check if we're using data-note-id (new approach) or data-note-key (legacy)
  const noteId = noteElement.dataset.noteId;
  const noteKey = noteElement.dataset.noteKey;
  const identifier = noteId || noteKey;
  
  // Find the parent element that has an id (this should be the line number)
  const parentId = noteElement.closest("[id]")?.id;

  console.log("Note identifier:", identifier);
  console.log("Parent ID:", parentId);

  if (!identifier || !parentId) {
    console.warn("Missing note identifier or parent ID for the clicked footnote.");
    return;
  }

  let footnoteHtml = "";
  let footnoteContent = null;

  // Try the embedded approach first if enabled
  if (useEmbeddedFootnotes) {
    // Construct the composite footnote ID
    const footnoteId = `${book}-${parentId}-${identifier}`;
    console.log("Looking up footnote with ID:", footnoteId);
    
    // Get the footnote content from IndexedDB
    const db = await openDatabase();
    const transaction = db.transaction(["footnotes"], "readonly");
    const store = transaction.objectStore("footnotes");
    
    const result = await store.get(book);
    if (result && result.footnotes && result.footnotes[footnoteId]) {
      footnoteContent = result.footnotes[footnoteId];
      console.log("Found footnote content:", footnoteContent);
      footnoteHtml = convertMarkdownToHtml(footnoteContent.content);
    }
  }

  // Fall back to legacy approach if needed
  if (!footnoteHtml && !useEmbeddedFootnotes) {
    console.log("🔑 Falling back to legacy footnote lookup for book:", book);
    let footnotesData = await getFootnotesFromIndexedDB(book);
    if (!footnotesData) {
      console.error("Footnotes data could not be fetched from IndexedDB.");
      return;
    }

    // Locate the section that contains the footnotes
    const section = footnotesData.find((sec) =>
      Object.values(sec.footnotes || {}).some(
        (footnote) =>
          footnote.line_number.toString() === parentId && footnote.content
      )
    );

    if (!section) {
      console.warn(`No matching section found for line ${parentId}.`);
      return;
    }

    const footnote = section.footnotes[identifier];
    if (!footnote || footnote.line_number.toString() !== parentId) {
      console.warn(`Footnote [${identifier}] not found at line ${parentId}.`);
      return;
    }

    console.log("Footnote content before conversion:", footnote.content);
    // Convert Markdown content to HTML
    footnoteHtml = convertMarkdownToHtml(footnote.content);
  }

  if (!footnoteHtml) {
    console.error("Could not find footnote content using either approach.");
    return;
  }

  console.log("Final footnote HTML:", footnoteHtml);

  // Display the content in the reference container
  const htmlToDisplay = `
    <div class="footnote-content">
      <div class="footnote-id">${identifier}</div>
      <div class="footnote-text">${footnoteHtml}</div>
    </div>`;
  
  console.log("Opening reference container with content:", htmlToDisplay);
  openReferenceContainer(htmlToDisplay);
}


// Inject footnotes for a chunk - supports both embedded and legacy approaches
// Inject footnotes for a chunk - supports both embedded and legacy approaches
export async function injectFootnotesForChunk(chunkId, book) {
  // Temporarily disable lazy loading
  window.isUpdatingJsonContent = true;
  console.log("⏳ Disabling lazy loading while updating footnotes...");

  // Look up the chunk data by chunkId
  const chunk = window.nodeChunks.find((c) => c.chunk_id === chunkId);
  if (!chunk) {
    console.error(`❌ Chunk with ID ${chunkId} not found.`);
    window.isUpdatingJsonContent = false;
    return;
  }

  try {
    // Use embedded footnotes if available
    if (useEmbeddedFootnotes && chunk.footnotes && chunk.footnotes.length > 0) {
      console.log(`✅ Processing ${chunk.footnotes.length} footnote references for chunk ${chunkId}...`);

      // Process each footnote in the chunk
      chunk.footnotes.forEach(footnote => {
        // Find the target element using its line number as the id
        const targetElement = document.getElementById(chunk.startLine.toString());
        
        if (targetElement) {
          // Avoid duplicate injection
          if (targetElement.innerHTML.includes(`<sup class="note" data-note-id="${footnote.id}">`)) {
            console.log(`Footnote ${footnote.id} already processed in chunk ${chunkId}. Skipping.`);
            return;
          }

          // Construct a regex to find the Markdown footnote reference
          const regex = new RegExp(`\\[\\^${footnote.id}\\](?!:)`, "g");
          
          if (regex.test(targetElement.innerHTML)) {
            // Replace the Markdown footnote marker with a <sup> element
            targetElement.innerHTML = targetElement.innerHTML.replace(
              regex,
              `<sup class="note" data-note-id="${footnote.id}">${footnote.id}</sup>`
            );
          } else {
            console.warn(
              `Regex did not match for footnote ID: ${footnote.id} in element:`,
              targetElement.innerHTML
            );
          }
        } else {
          console.warn(
            `No target element found for line_number: ${chunk.startLine} in chunk ${chunkId}`
          );
        }
      });
    } 
    // Fall back to legacy approach if needed
    else if (!useEmbeddedFootnotes) {
      // Legacy code (unchanged)
      // ...
    } else {
      console.log(`No footnotes found for chunk ${chunkId}`);
    }

    attachMarkListeners();

    // Re-enable lazy loading after footnotes update
    setTimeout(() => {
      window.isUpdatingJsonContent = false;
      console.log("✅ Re-enabling lazy loading after footnotes update.");
    }, 200); // Delay to allow layout shifts to settle
  } catch (error) {
    console.error("❌ Error injecting footnotes for chunk:", error);
    window.isUpdatingJsonContent = false;
  }
}




export function processFootnotes(markdown) {
  
  console.log("pairing md-footnotes... pray jesus ✝️")


  const lines = markdown.split('\n');
  const footnoteRefs = [];
  const footnoteDefs = [];
  
  // Scan for footnote references and definitions
  lines.forEach((line, lineIndex) => {
    // Find all footnote references in the line
    const refMatches = Array.from(line.matchAll(/\[\^(\w+)\](?!\:)/g));
    for (const match of refMatches) {
      footnoteRefs.push({
        id: match[1],
        lineNumber: lineIndex + 1,
        position: match.index,
        text: match[0]
      });
    }
    
    // Find footnote definitions
    const defMatch = line.match(/^\[\^(\w+)\]\:(.*)/);
    if (defMatch) {
      footnoteDefs.push({
        id: defMatch[1],
        lineNumber: lineIndex + 1,
        text: defMatch[0],
        content: defMatch[2].trim()
      });
    }
  });
  
  // Create pairings between references and definitions
  const footnotePairs = [];
  const defsById = {};
  
  // Group definitions by ID
  footnoteDefs.forEach(def => {
    if (!defsById[def.id]) {
      defsById[def.id] = [];
    }
    defsById[def.id].push(def);
  });
  
  // Match references with the next available definition
  footnoteRefs.forEach(ref => {
    const matchingDefs = defsById[ref.id] || [];
    // Find the next definition after this reference
    const nextDef = matchingDefs.find(def => def.lineNumber > ref.lineNumber);
    
    if (nextDef) {
      footnotePairs.push({
        reference: ref,
        definition: nextDef
      });
      
      // Remove this definition so it's not reused
      const index = matchingDefs.indexOf(nextDef);
      matchingDefs.splice(index, 1);
    }
  });
  
  return {
    references: footnoteRefs,
    definitions: footnoteDefs,
    pairs: footnotePairs
  };
}