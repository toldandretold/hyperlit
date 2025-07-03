import { parseHyperciteHref } from './hyperCites.js';
import { extractQuotedText } from './paste.js';
// Import necessary functions from database and utility modules
import { openDatabase, updateCitationForExistingHypercite } from './cache-indexedDB.js';
import { parseMarkdownIntoChunksInitial } from './convert-markdown.js';
import { book } from './app.js';
import { getCurrentUser, getAuthorId, getAnonymousToken } from "./auth.js";

// Variables to control paste behavior
let pasteHandled = false;
let hypercitePasteInProgress = false;


function handleHighlightContainerPaste(event, highlightId) {
  // Prevent double-handling
  if (pasteHandled) return;
  pasteHandled = true;
  
  // Reset the flag after the event cycle
  setTimeout(() => { pasteHandled = false; }, 0);
  
  // Log detailed paste information
  const plainText = event.clipboardData.getData('text/plain');
  const htmlContent = event.clipboardData.getData('text/html');
  
  console.log('HIGHLIGHT CONTAINER PASTE EVENT:', {
    plainTextLength: plainText.length,
    plainTextPreview: plainText.substring(0, 50) + (plainText.length > 50 ? '...' : ''),
    hasHTML: !!htmlContent,
    target: event.target,
    targetId: event.target.id || 'no-id',
    targetNodeName: event.target.nodeName,
    highlightId: highlightId
  });
  
  // Try to handle as hypercite first with custom highlight format
  if (handleHighlightHypercitePaste(event, highlightId)) {
    return; // Handled as hypercite
  }
  
  // Then try to handle as markdown
  if (handleHighlightMarkdownPaste(event, highlightId)) {
    return; // Handled as markdown
  }
  
  // For regular pastes, we'll handle them ourselves to ensure clean content
  event.preventDefault(); // Prevent default paste behavior
  
  // Get the annotation div
  const annotationDiv = document.querySelector(
    `#highlight-container .annotation[data-highlight-id="${highlightId}"]`
  );
  if (!annotationDiv) {
    console.warn(`No annotation div found for highlight ID: ${highlightId}`);
    return;
  }
  
  const selection = window.getSelection();
  if (!selection.rangeCount) {
    console.warn("No selection found for paste operation");
    return;
  }
  
  // Find the current paragraph or create one if needed
  const range = selection.getRangeAt(0);
  let currentNode = range.startContainer;
  if (currentNode.nodeType !== Node.ELEMENT_NODE) {
    currentNode = currentNode.parentElement;
  }
  
  // Find the closest paragraph or block element
  let paragraph = currentNode.closest('p, div, h1, h2, h3, h4, h5, h6, li');
  if (!paragraph || !annotationDiv.contains(paragraph)) {
    // If no paragraph or paragraph is outside annotation div, create a new one
    paragraph = document.createElement('p');
    annotationDiv.appendChild(paragraph);
    
    // Move selection to the new paragraph
    range.selectNodeContents(paragraph);
    selection.removeAllRanges();
    selection.addRange(range);
  }
  
  // Clean the content
  let cleanContent;
  
  if (plainText.includes('\n')) {
    // Text with line breaks - convert to paragraphs
    cleanContent = plainText.split('\n')
      .filter(line => line.trim() !== '')
      .map(line => `<p>${line}</p>`)
      .join('');
      
    // Insert multiple paragraphs
    const tempDiv = document.createElement('div');
    tempDiv.innerHTML = cleanContent;
    
    // Replace current paragraph content with first paragraph content
    const firstP = tempDiv.querySelector('p');
    if (firstP) {
      paragraph.innerHTML = firstP.innerHTML;
      
      // Insert remaining paragraphs after the current one
      let insertAfter = paragraph;
      Array.from(tempDiv.children).forEach((el, index) => {
        if (index > 0) { // Skip the first one as we already used its content
          const newP = document.createElement('p');
          newP.innerHTML = el.innerHTML;
          
          // Insert after the previous paragraph
          if (insertAfter.nextSibling) {
            annotationDiv.insertBefore(newP, insertAfter.nextSibling);
          } else {
            annotationDiv.appendChild(newP);
          }
          insertAfter = newP;
        }
      });
    }
  } else {
    // Single line text - insert directly
    document.execCommand('insertText', false, plainText);
  }
  
  // Save the annotation after paste
  saveHighlightAnnotation(highlightId, annotationDiv.innerHTML);
}



/**
 * Handle pasting of hypercites in the highlight container
 */
function handleHighlightHypercitePaste(event, highlightId) {
  const clipboardHtml = event.clipboardData.getData("text/html");
  if (!clipboardHtml) return false;
  
  console.log("🔍 DEBUG - Raw clipboard HTML:", clipboardHtml); // DEBUG
  
  // Parse clipboard HTML
  const pasteWrapper = document.createElement("div");
  pasteWrapper.innerHTML = clipboardHtml;
  
  // Look for hypercite link
  const citeLink = pasteWrapper.querySelector(
    'a[id^="hypercite_"] > span.open-icon'
  )?.parentElement;
  
  // Check if this is a hypercite link
  if (!(citeLink && 
      (citeLink.innerText.trim() === "↗" || 
       (citeLink.closest("span") && citeLink.closest("span").classList.contains("open-icon"))))) {
    return false; // Not a hypercite
  }
  
  // Prevent default paste behavior
  event.preventDefault();
  
  console.log("Detected a hypercite in highlight container paste");
  
  const originalHref = citeLink.getAttribute("href");
  const parsed = parseHyperciteHref(originalHref);
  if (!parsed) return false;
  
  const { booka, hyperciteIDa, citationIDa } = parsed;
  console.log("Parsed citation info:", { booka, hyperciteIDa, citationIDa });
  
  // Generate new hypercite ID for this instance
  const hyperciteIDb = "hypercite_" + Math.random().toString(36).substr(2, 8);
  
  // Get current book (where paste is happening)
  const bookb = book;
  
  // Create the citation ID for this new instance - include the highlight ID
  const citationIDb = `/${bookb}/${highlightId}#${hyperciteIDb}`;
  
  // Extract quoted text - IMPROVED VERSION
  let quotedText = "";

  // Method 1: Try regex to extract quoted text from raw HTML
  const quoteMatch = clipboardHtml.match(/'([^']*)'/);
  if (quoteMatch) {
    quotedText = quoteMatch[1];
    console.log("🔍 Found quoted text via regex:", quotedText);
  }

  // Method 2: If regex failed, try DOM parsing
  if (!quotedText) {
    // First try to find the text directly before the citation link
    let textNode = citeLink.previousSibling;
    while (textNode) {
      if (textNode.nodeType === Node.TEXT_NODE) {
        quotedText = textNode.textContent.trim() + quotedText;
        break;
      } else if (textNode.nodeType === Node.ELEMENT_NODE) {
        // Check if it's a span or other element containing text
        const textContent = textNode.textContent.trim();
        if (textContent) {
          quotedText = textContent + quotedText;
          break;
        }
      }
      textNode = textNode.previousSibling;
    }
    console.log("🔍 Found quoted text via DOM:", quotedText);
  }

  // Method 3: Fallback - extract all text before the link
  if (!quotedText) {
    quotedText = extractQuotedText(pasteWrapper);
    console.log("🔍 Found quoted text via fallback:", quotedText);
  }

  // Clean up the quoted text
  quotedText = quotedText.replace(/^['"]|['"]$/g, ''); // Remove quotes
  console.log("🔍 Final cleaned quoted text:", `"${quotedText}"`);
  
  // Create the reference HTML with no space between text and sup
  const referenceHtml = `'${quotedText}'<a href="${originalHref}" id="${hyperciteIDb}">\u200B<sup class="open-icon">↗</sup></a>`;
  
  // Set the flag to prevent MutationObserver from processing this paste
  hypercitePasteInProgress = true;
  console.log("Setting hypercitePasteInProgress flag to true");
  
  // Insert the content
  const selection = window.getSelection();
  if (selection.rangeCount > 0) {
    const range = selection.getRangeAt(0);
    
    // Create a document fragment with just the text and link
    const fragment = document.createDocumentFragment();
    const tempDiv = document.createElement('div');
    tempDiv.innerHTML = referenceHtml;
    
    // Move all nodes from tempDiv to fragment
    while (tempDiv.firstChild) {
      fragment.appendChild(tempDiv.firstChild);
    }
    
    // Clear the range and insert our clean fragment
    range.deleteContents();
    range.insertNode(fragment);
    
    // Move cursor to end of insertion
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
  } else {
    // Fallback to execCommand if selection isn't available
    document.execCommand("insertHTML", false, referenceHtml);
  }
  
  // Save the annotation
  const annotationDiv = document.querySelector(
    `#highlight-container .annotation[data-highlight-id="${highlightId}"]`
  );
  if (annotationDiv) {
    saveHighlightAnnotation(highlightId, annotationDiv.innerHTML);
  }
  
  // Update the original hypercite's citedIN array
  updateCitationForExistingHypercite(
    booka, 
    hyperciteIDa, 
    citationIDb,
    false // Don't insert content, just update the database
  ).then(updated => {
    if (updated) {
      console.log(`Successfully linked: ${citationIDa} cited in ${citationIDb}`);
    } else {
      console.warn(`Failed to update citation for ${citationIDa}`);
    }
    
    // Clear the flag after a short delay
    setTimeout(() => {
      hypercitePasteInProgress = false;
      console.log("Cleared hypercitePasteInProgress flag");
    }, 100);
  });
  
  return true; // Successfully handled as hypercite
}

/**
 * Handle pasting of markdown content in the highlight container
 */
function handleHighlightMarkdownPaste(event, highlightId) {
  const markdown = event.clipboardData.getData("text/plain");
  if (!markdown.trim()) return false;
  
  // Check if this looks like markdown
  const hasMarkdownSyntax = /^#+\s|\n#+\s|^\s*[-*+]\s|\n\s*[-*+]\s|^\s*\d+\.\s|\n\s*\d+\.\s|`|_\w+_|\*\w+\*/.test(markdown);
  if (!hasMarkdownSyntax) return false;
  
  event.preventDefault();

  // Get the specific annotation div for this highlight ID
  const annotationDiv = document.querySelector(
    `#highlight-container .annotation[data-highlight-id="${highlightId}"]`
  );
  if (!annotationDiv) {
    console.warn(`No annotation div found for markdown paste, highlight ID: ${highlightId}`);
    return false;
  }

  // Parse markdown into HTML blocks
  const blocks = parseMarkdownIntoChunksInitial(markdown);

  // Build fragment and insert
  const frag = document.createDocumentFragment();
  blocks.forEach(block => {
    const wrapper = document.createElement("div");
    wrapper.innerHTML = block.content;
    const el = wrapper.firstElementChild;
    frag.appendChild(el);
  });
  
  // Insert at current selection
  const selection = window.getSelection();
  if (selection.rangeCount > 0) {
    const range = selection.getRangeAt(0);
    range.deleteContents();
    range.insertNode(frag);
    
    // Move cursor to end
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
  } else {
    // If no selection, append to the end
    annotationDiv.appendChild(frag);
  }
  
  return true; // Successfully handled as markdown
}

/**
 * Save the annotation content to the database
 */
function saveHighlightAnnotation(highlightId, annotationHTML) {
  if (!highlightId) {
    console.error("Cannot save annotation: No highlight ID provided");
    return;
  }
  
  console.log(`Saving annotation for highlight ${highlightId}`);
  
  // Clean the annotation HTML if needed
  const cleanedHTML = annotationHTML;
  
  // Update the database
  openDatabase().then(db => {
    const tx = db.transaction("hyperlights", "readwrite");
    const store = tx.objectStore("hyperlights");
    const index = store.index("hyperlight_id");
    
    const getRequest = index.get(highlightId);
    
    getRequest.onsuccess = () => {
      const highlightData = getRequest.result;
      if (!highlightData) {
        console.error("Cannot save annotation: Highlight not found in database");
        return;
      }
      
      // Update the annotation field
      highlightData.annotation = cleanedHTML;
      
      // Save back to database
      const updateRequest = store.put(highlightData);
      
      updateRequest.onsuccess = () => {
        console.log(`Successfully saved annotation for highlight ${highlightId}`);
        updateAnnotationInPostgreSQL(highlightData);
      };
      
      updateRequest.onerror = (event) => {
        console.error("Error saving annotation:", event.target.error);
      };
    };
    
    getRequest.onerror = (event) => {
      console.error("Error retrieving highlight for annotation update:", event.target.error);
    };
  }).catch(error => {
    console.error("Database error when saving annotation:", error);
  });
}

export async function updateAnnotationInPostgreSQL(highlightData) {
  try {
    const anon = await getAnonymousToken();

    const payload = {
      book: highlightData.book,
      data: [
        {
          book:        highlightData.book,
          hyperlight_id: highlightData.hyperlight_id,
          annotation:    highlightData.annotation
        }
      ],
      ...(anon ? { anonymous_token: anon } : {})
    };

    const res = await fetch("/api/db/hyperlights/upsert", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-TOKEN":
          document.querySelector('meta[name="csrf-token"]')?.content
      },
      credentials: "same-origin",
      body: JSON.stringify(payload)
    });

    const json = await res.json();

    if (res.ok && json.success) {
      console.log("✅ Annotation synced to server successfully");
    } else {
      console.error(
        "❌ Failed to sync annotation to server:",
        json.message || res.statusText
      );
    }
  } catch (err) {
    console.error("❌ Error syncing annotation to server:", err);
  }
}

/**
 * Add the highlight container paste listener
 */
/**
 * Add the highlight container paste listener
 */
export function addHighlightContainerPasteListener(highlightId) {
  const container = document.getElementById("highlight-container");
  if (!container || container.classList.contains("hidden")) {
    console.error("Cannot add paste listener: Container not found or hidden");
    return;
  }

  // Find the specific annotation element for this highlight ID
  const annotationDiv = container.querySelector(
    `.annotation[data-highlight-id="${highlightId}"]`
  );
  
  if (!annotationDiv) {
    console.warn(`Cannot add paste listener: No annotation div found for highlight ID: ${highlightId}`);
    return;
  }
  
  console.log(`Adding paste listener to annotation for highlight ${highlightId}`);
  
  // Remove any existing paste listeners to avoid duplicates
  annotationDiv.removeEventListener("paste", annotationDiv._pasteHandler);
  
  // Create a new handler that includes the highlight ID
  annotationDiv._pasteHandler = (event) => handleHighlightContainerPaste(event, highlightId);
  
  // Add the listener
  annotationDiv.addEventListener("paste", annotationDiv._pasteHandler);
}
