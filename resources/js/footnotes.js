// footnotes.js
import { book } from './reader-DOMContentLoaded.js';
import {
  openDatabase,
  getFootnotesFromIndexedDB,
  saveFootnotesToIndexedDB,
  getPageKey
} from './cache-indexedDB.js';
import { convertMarkdownToHtml } from './convert-markdown.js';
import { attachMarkListeners } from './hyper-lights-cites.js';
import { ContainerManager } from './container-manager.js';

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

// Footnotes handling
export async function loadFootnotes() {
  let footnotesData = await getFootnotesFromIndexedDB();
  if (footnotesData) {
    console.log("✅ Footnotes loaded from IndexedDB.");
    return footnotesData;
  }

  console.log("⚠️ No footnotes found in IndexedDB. Fetching from server...");
  try {
    let footnotesResponse = await fetch(window.jsonPath);
    if (footnotesResponse.ok) {
      footnotesData = await footnotesResponse.json();
      await saveFootnotesToIndexedDB(footnotesData);
      console.log("✅ Footnotes successfully saved to IndexedDB.");
      return footnotesData;
    }
    console.warn("⚠️ Failed to fetch footnotes JSON, using fallback.");
  } catch (error) {
    console.error("❌ Error fetching footnotes JSON:", error);
  }
  return null;
}

export async function displayFootnote(noteElement, book, convertMarkdownToHtml, getFreshUrl) {
  const noteKey = noteElement.dataset.noteKey;
  const parentId = noteElement.closest("[id]")?.id;

  console.log("Note key:", noteKey);
  console.log("Parent ID:", parentId);

  if (!noteKey || !parentId) {
    console.warn("Missing note key or parent ID for the clicked footnote.");
    return;
  }

  // ✅ Load footnotes data from IndexedDB
  console.log("🔑 Attempting to load footnotes using key:", [getPageKey(), "latest"]);
  
  let footnotesData = await getFootnotesFromIndexedDB();
  if (!footnotesData) {
    console.error("Footnotes data could not be fetched from IndexedDB.");
    return;
  }

  console.log("Fetched footnotes data:", footnotesData);

  // Locate the correct section and footnote
  const section = footnotesData.find((sec) =>
    Object.values(sec.footnotes || {}).some(
      (footnote) => footnote.line_number.toString() === parentId && footnote.content
    )
  );

  console.log("Matched section:", section);

  if (!section) {
    console.warn(`No matching section found for line ${parentId}.`);
    return;
  }

  const footnote = section.footnotes[noteKey];
  console.log("Matched footnote:", footnote);

  if (!footnote || footnote.line_number.toString() !== parentId) {
    console.warn(`Footnote [${noteKey}] not found at line ${parentId}.`);
    return;
  }

  console.log("Footnote content before conversion:", footnote.content);
  // Convert the Markdown content to HTML
  const footnoteHtml = convertMarkdownToHtml(footnote.content);
  console.log("Converted HTML:", footnoteHtml);

  // Display the content in the reference container
  console.log("Opening reference container with content:", `<div class="footnote-content">${footnoteHtml}</div>`);
  openReferenceContainer(`<div class="footnote-content">${footnoteHtml}</div>`);
}





export async function injectFootnotesForChunk(chunkId, book, getFreshUrl) {
  // Temporarily disable lazy loading
  window.isUpdatingJsonContent = true;
  console.log("⏳ Disabling lazy loading while updating footnotes...");

  // Look up the chunk data by chunkId.
  const chunk = window.nodeChunks.find(c => c.chunk_id === chunkId);
  if (!chunk) {
    console.error(`❌ Chunk with ID ${chunkId} not found.`);
    window.isUpdatingJsonContent = false;
    return;
  }

  // Use the chunk’s start and end line numbers.
  const startLine = chunk.start_line;
  const endLine = chunk.end_line;

  try {
    // ✅ Load footnotes data from IndexedDB
    console.log("🔑 Attempting to load footnotes using key:", [getPageKey(), "latest"]); // Add this line
    
    let sections = await getFootnotesFromIndexedDB();
    if (!sections) {
      console.error("Footnotes data could not be fetched from IndexedDB.");
      window.isUpdatingJsonContent = false;
      return;
    }

    // ✅ Now we have the footnotes in `sections`
    console.log("✅ Footnotes data loaded, injecting footnotes...");

    sections.forEach((section) => {
      if (section.footnotes) {
        Object.entries(section.footnotes).forEach(([key, footnote]) => {
          const {
            line_number,
            content
          } = footnote;

          // Process only if the footnote’s line number is within this chunk’s range.
          if (line_number >= startLine && line_number <= endLine) {
            const targetElement = document.getElementById(line_number.toString());
            if (targetElement) {
              // Avoid duplicate injection.
              if (targetElement.innerHTML.includes(`<sup class="note" data-note-key="${key}">`)) {
                console.log(`Footnote ${key} already processed in chunk ${chunkId}. Skipping.`);
                return;
              }

              // Construct a regex to find the Markdown footnote reference.
              const regex = new RegExp(`\\[\\^${key}\\](?!:)`, "g");
              if (regex.test(targetElement.innerHTML)) {
                // Convert Markdown footnote content to HTML.
                const footnoteHtml = content ? convertMarkdownToHtml(content) : "";

                // Replace the Markdown footnote marker with a <sup> element.
                targetElement.innerHTML = targetElement.innerHTML.replace(
                  regex,
                  `<sup class="note" data-note-key="${key}">[^${key}]</sup>`
                );
              } else {
                console.warn(`Regex did not match for footnote key: ${key} in element:`, targetElement.innerHTML);
              }
            } else {
              console.warn(`No target element found for line_number: ${line_number} in chunk ${chunkId}`);
            }
          }
        });
      }
    });

    attachMarkListeners();

    // ✅ Re-enable lazy loading after footnotes update
    setTimeout(() => {
      window.isUpdatingJsonContent = false;
      console.log("✅ Re-enabling lazy loading after footnotes update.");
    }, 200); // Delay ensures any layout shifts settle

  } catch (error) {
    console.error("❌ Error injecting footnotes for chunk:", error);
    window.isUpdatingJsonContent = false;
  }
}
