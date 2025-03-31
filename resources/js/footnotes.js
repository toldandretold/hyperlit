// footnotes.js
import { book } from "./app.js";
import {
  openDatabase,
  getFootnotesFromIndexedDB,
  saveFootnotesToIndexedDB,
  getNodeChunksFromIndexedDB
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



 /* Inject footnotes for a chunk - supports both embedded and legacy approaches.
 */
export async function injectFootnotesForChunk(chunkId, bookId) {
  console.log(`Injecting footnotes for chunk ${chunkId} in book ${bookId}`);
  
  try {
    // 1. Assume nodeChunks is already available (e.g., in window.nodeChunks).
    if (!window.nodeChunks || window.nodeChunks.length === 0) {
      console.warn("No nodeChunks available.");
      return;
    }
    
    // 2. Get the nodes for this chunk.
    const chunkNodes = window.nodeChunks.filter(node => node.chunk_id === chunkId);
    if (!chunkNodes || chunkNodes.length === 0) {
      console.warn(`No nodes found for chunk ${chunkId}`);
      return;
    }
    
    console.log(`Processing ${chunkNodes.length} nodes in chunk ${chunkId}`);
    
    // 3. Find the chunk container in the DOM.
    const chunkContainer = document.querySelector(`[data-chunk-id="${chunkId}"]`);
    if (!chunkContainer) {
      console.error(`Chunk container not found for chunk ${chunkId}`);
      return;
    }
    
    // 4. Process each node in the chunk.
    for (const node of chunkNodes) {
      // Skip nodes with no footnotes.
      if (!node.footnotes || node.footnotes.length === 0) {
        continue;
      }
      
      console.log(`Node ${node.id || node.startLine} has ${node.footnotes.length} footnote(s)`);
      
      // Escape the node id to create a valid selector.
      const safeId = CSS.escape(node.startLine.toString());
      const nodeElement = chunkContainer.querySelector(`#${safeId}`);
      
      if (!nodeElement) {
        console.warn(`DOM element not found for node at line ${node.startLine}`);
        continue;
      }
      
      // 5. For each footnote stored in the node, replace its markdown reference in the HTML.
      node.footnotes.forEach(footnote => {
        // Construct a regex to find the markdown footnote reference, like [^1]
        const regex = new RegExp(`\\[\\^${footnote.id}\\](?!:)`, "g");
        
        if (regex.test(nodeElement.innerHTML)) {
          console.log(`Replacing footnote ref [^${footnote.id}] in node ${node.startLine}`);
          nodeElement.innerHTML = nodeElement.innerHTML.replace(
            regex,
            `<sup class="note" data-note-id="${footnote.id}" data-ref-line="${footnote.referenceLine}" data-def-line="${footnote.definitionLine}">${footnote.id}</sup>`
          );
        } else {
          console.warn(
            `Footnote reference [^${footnote.id}] not found in node ${node.startLine}.`
          );
        }
      });
    }
    
    // 6. Attach click listeners to the newly created footnote <sup> elements.
    attachMarkListeners();
    
    console.log(`Finished injecting footnotes for chunk ${chunkId}`);
    
  } catch (error) {
    console.error(`Error injecting footnotes for chunk ${chunkId}:`, error);
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