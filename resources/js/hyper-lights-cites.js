/* LOGIC of highlighting: 

1. on highlighting a range of text, a unique highlight_id is generated. it is added as a 
id= and class= on the first mark tag and only as a class= on any others. this ensures mark tags
are added to multiple html nodes, without id being duplicated.

 */



import {
    mainContentDiv,
    book
} from './app.js';

import { fetchLatestUpdateInfo, handleTimestampComparison } from "./updateCheck.js";


import { createLazyLoader,
         loadNextChunkFixed,
         loadPreviousChunkFixed
       } from "./lazyLoaderFactory.js";

import { ContainerManager } from "./container-manager.js";

import { navigateToInternalId } from "./scrolling.js";  // or the correct path
 
let highlightId; 

let highlightLazyLoader;

// Create a container manager for highlights using the same overlay if needed
const highlightManager = new ContainerManager(
    "highlight-container", 
    "ref-overlay", 
    null, 
    ["main-content", "nav-buttons"]);

export function openHighlightContainer(content) {
  highlightManager.openContainer(content);
}

export function closeHighlightContainer() {
  highlightManager.closeContainer();
}

// Helper that creates or updates the lazy loader.
function initOrUpdateHighlightLazyLoader(chunks) {
  if (highlightLazyLoader) {
    // Update the nodeChunks if the lazy loader already exists.
    highlightLazyLoader.nodeChunks = chunks;
  } else {
    // Create the lazy loader with the given chunks.
    highlightLazyLoader = createLazyLoader({
      container: document.getElementById("highlight-container"),
      nodeChunks: chunks,
      loadNextChunk: loadNextChunkFixed,
      loadPreviousChunk: loadPreviousChunkFixed,
      attachMarkListeners,
      bookId: book,
    });
  }
  return highlightLazyLoader;
}

async function fetchHighlightChunksOnDemand(book) {
  const updateInfo = await fetchLatestUpdateInfo(book);
  // Read the cached timestamp from localStorage
  const cachedTimestamp =
    localStorage.getItem("highlightChunksLastModified") || "null";

  // Assume latest_update.json now includes a property “highlightChunksLastModified”
  const serverTimestamp =
    updateInfo && updateInfo.highlightChunksLastModified
      ? updateInfo.highlightChunksLastModified.toString()
      : "null";

  console.log(
    "✅ Server reported highlightChunksLastModified:",
    serverTimestamp
  );

  if (serverTimestamp !== cachedTimestamp) {
    console.log("Highlight chunks timestamp is DIFFERENT. Updating cache.");
    localStorage.setItem("highlightChunksLastModified", serverTimestamp);
  } else {
    console.log("Highlight chunks timestamp unchanged.");
  }

  // Now load the highlightChunks.json file
  const resourcePath = `/markdown/${book}/highlightChunks.json`;
  const response = await fetch(resourcePath);
  if (!response.ok) {
    throw new Error(`Failed to load highlightChunks from ${resourcePath}`);
  }
  return response.json();
}




// ========= Mark Listeners =========
export function attachMarkListeners() {
    // Get all mark elements (both with ID and with just class)
    const markTags = document.querySelectorAll("mark");
    console.log(`Attempting to attach listeners to ${markTags.length} mark elements`);
    
    markTags.forEach(function(mark) {
        // Remove existing listeners
        mark.removeEventListener("click", handleMarkClick);
        mark.removeEventListener("mouseover", handleMarkHover);
        mark.removeEventListener("mouseout", handleMarkHoverOut);
        
        // Add new listeners
        mark.addEventListener("click", handleMarkClick);
        mark.addEventListener("mouseover", handleMarkHover);
        mark.addEventListener("mouseout", handleMarkHoverOut);
        
        mark.dataset.listenerAttached = true;
        console.log(`Listener attached to mark with ID or class: ${mark.id || '[class only]'}`);
    });
    
    console.log(`Mark listeners refreshed for ${markTags.length} <mark> tags`);
}




export function handleMarkClick(event) {
  event.preventDefault();

  // Determine the highlight ID from the element (same logic as before)
  let highlightId = event.target.id;
  if (!highlightId) {
    const highlightClass = Array.from(event.target.classList).find((cls) =>
      cls.startsWith("unknown-user_") || cls.includes("_")
    );
    if (highlightClass) {
      highlightId = highlightClass;
    }
  }
  console.log(`Mark clicked: ${highlightId}`);

  if (!book) {
    console.error("❌ Book variable is not defined.");
    return;
  }
  if (!highlightId) {
    console.error("❌ Could not determine highlight ID.");
    return;
  }

  // Open the highlight container
  openHighlightContainer("");

  // Fetch the highlight chunks and then create/update the lazy loader
  fetchHighlightChunksOnDemand(book)
    .then((highlightChunks) => {
      const lazyLoader = initOrUpdateHighlightLazyLoader(highlightChunks);
      navigateToInternalId(highlightId, lazyLoader, false);
    })
    .catch((err) => {
      console.error("❌ Error fetching highlight chunks:", err);
    });
}



/**
 * Recursively determine the offsetTop of an element relative to a
 * container element.
 *
 * @param {HTMLElement} element The target element.
 * @param {HTMLElement} container The container element.
 * @returns {number} Distance in pixels from the top of the container.
 */
function getRelativeOffsetTop(element, container) {
  let offsetTop = 0;
  while (element && element !== container) {
    offsetTop += element.offsetTop;
    element = element.offsetParent;
  }
  return offsetTop;
}





export function handleMarkHover(event) {
    const highlightId = event.target.id;
    event.target.style.textDecoration = "underline";
    console.log(`Mark over: ${highlightId}`);
}


export function handleMarkHoverOut(event) {
    event.target.style.textDecoration = "none";
}



rangy.init();

    // Initialize the highlighter
    var highlighter = rangy.createHighlighter();

    // Custom class applier with an element tag name of "mark"
    var classApplier = rangy.createClassApplier("highlight", {
        elementTagName: "mark",
        applyToAnyTagName: true
    });

    highlighter.addClassApplier(classApplier);

    // Cross-platform selection detection: desktop and mobile
    function handleSelection() {
        let selectedText = window.getSelection().toString().trim();
        const highlights = document.querySelectorAll('mark');
        let isOverlapping = false;

        // Check if the highlighted text overlaps with any existing highlight
        highlights.forEach(function(highlight) {
            if (selectedText.includes(highlight.textContent.trim())) {
                isOverlapping = true;
            }
        });

        if (selectedText.length > 0) {
            console.log('Showing buttons. Selected text:', selectedText);

            // Get the bounding box of the selected text to position buttons near it
            const selection = window.getSelection();
            const range = selection.getRangeAt(0);
            const rect = range.getBoundingClientRect();

            // Position the buttons near the selected text, but far from iOS context menu
            const buttons = document.getElementById('hyperlight-buttons');
            buttons.style.display = 'block';

            // Position the buttons below the selection (or above if there's no room below)
            let offset = 100; // Adjust this value to move the buttons further from iOS context menu
            if (rect.bottom + offset > window.innerHeight) {
                // Position the buttons above the selection if there's no room below
                buttons.style.top = `${rect.top + window.scrollY - offset}px`;
            } else {
                // Default: Position the buttons below the selection
                buttons.style.top = `${rect.bottom + window.scrollY + 10}px`; // 10px padding from selection
            }

            buttons.style.left = `${rect.left + window.scrollX}px`;

            // Show or hide the delete button based on overlap detection
            if (isOverlapping) {
                console.log('Detected overlapping highlight');
                document.getElementById('delete-hyperlight').style.display = 'block';
            } else {
                console.log('No overlapping highlight detected');
                document.getElementById('delete-hyperlight').style.display = 'none';
            }
        } else {
            console.log('No text selected. Hiding buttons.');
            document.getElementById('hyperlight-buttons').style.display = 'none';
            document.getElementById('delete-hyperlight').style.display = 'none';
        }
    }

    // Event listener for desktop (mouseup)
    document.addEventListener('mouseup', handleSelection);

    // Event listeners for mobile (touchend)
    document.addEventListener('touchend', function() {
        setTimeout(handleSelection, 100);  // Small delay to ensure touch selection happens
    });

    // Prevent iOS from cancelling the selection when interacting with buttons
    document.getElementById('hyperlight-buttons').addEventListener('touchstart', function(event) {
        event.preventDefault(); // Prevents native iOS behavior like cancelling the selection
        event.stopPropagation(); // Prevent touch events from bubbling and cancelling selection
    });

    // Allow interaction with buttons on touch
    document.getElementById('hyperlight-buttons').addEventListener('click', function(event) {
        event.preventDefault(); // Ensure the button click doesn't cancel the selection
        event.stopPropagation(); // Stop the event from bubbling
    });

    // Helper function to bind click and touchstart events
    function addTouchAndClickListener(element, handler) {
        element.addEventListener('click', handler);
        element.addEventListener('touchstart', function(event) {
            event.preventDefault(); // Prevents default touch behavior
            handler(event); // Call the same handler for touch events
        });
    }

    // Function to handle creating a highlight
// Functions to handle creating a highlight



function generateHighlightID() {
    let userName = document.getElementById('user-name')?.textContent || 'unknown-user';
    let timestamp = Date.now();
    return `${userName}_${timestamp}`;
}

function modifyNewMarks(highlightId) {
    const newMarks = document.querySelectorAll('mark.highlight');
    newMarks.forEach((mark, index) => {
        if (index === 0) mark.setAttribute('id', highlightId);
        mark.classList.add(highlightId);
        mark.classList.remove('highlight');
    });
    console.log("✅ New highlight mark created with ID:", highlightId);
}

addTouchAndClickListener(document.getElementById('copy-hyperlight'), function () {
    let selection = window.getSelection();
    let range;

    try {
        range = selection.getRangeAt(0);
        console.log('📌 Full selected text:', selection.toString());
    } catch (error) {
        console.error('❌ Error getting range:', error);
        return;
    }

    let selectedText = selection.toString().trim();
    if (!selectedText) {
        console.error('⚠️ No valid text selected.');
        return;
    }

    // Generate unique highlight ID
    const highlightId = generateHighlightID();

    // Ensure highlighter function exists before calling it
    if (typeof highlighter !== "undefined" && highlighter.highlightSelection) {
        highlighter.highlightSelection("highlight");
    } else {
        console.warn("⚠️ Highlighter function is not defined.");
    }

    // Modify the marks immediately after highlighting
    modifyNewMarks(highlightId);
    attachMarkListeners();


    // Get closest valid block elements
    let startContainer = range.startContainer.nodeType === 3 
    ? range.startContainer.parentElement.closest('p, blockquote, table, [id]') 
    : range.startContainer.closest('p, blockquote, table, [id]');

    let endContainer = range.endContainer.nodeType === 3 
    ? range.endContainer.parentElement.closest('p, blockquote, table, [id]') 
    : range.endContainer.closest('p, blockquote, table, [id]');

    // 🔍 Debugging: Check if startContainer and endContainer are valid
    console.log("📌 Start Container:", startContainer);
    console.log("📌 End Container:", endContainer);

    if (!startContainer || !endContainer) {
        console.error('❌ Could not determine start or end block.');
        return;
    }

    let startId = parseInt(startContainer.id, 10);
    let endId = parseInt(endContainer.id, 10);

    // Collect all blocks in range
    let blocks = [];
    let allBlocks = [...document.querySelectorAll('[id]')]; // Get all elements with an ID

    // Find the index of start and end containers
    let startIndex = allBlocks.findIndex(el => el.id === startContainer.id);
    let endIndex = allBlocks.findIndex(el => el.id === endContainer.id);

    if (startIndex === -1 || endIndex === -1) {
        console.error("❌ Could not find start or end container in document.");
        return;
    }

    // Slice the array to get only the selected range
    let selectedBlocks = allBlocks.slice(startIndex, endIndex + 1);

    // Add the blocks to be sent
    selectedBlocks.forEach(block => {
        blocks.push({
            id: block.id,
            html: block.innerHTML  // Get latest content
        });
    });

    // Debugging
    console.log("📌 Blocks collected:", blocks);



    // Apply highlights to each block
    blocks.forEach(block => {
        let element = document.getElementById(block.id);
        if (element) {
            highlighter.highlightSelection("highlight", element);
        } else {
            console.warn(`⚠️ No element found for block ID: ${block.id}`);
        }
    });


    // Prevent sending empty blocks
    if (!blocks.length) {
        console.error("❌ No valid blocks found. Aborting request.");
        return;
    }

    // Prepare the data
    const requestBody = JSON.stringify({
        book: book,
        blocks: blocks,
        text: selectedText,
        start_xpath: getXPath(range.startContainer),
        end_xpath: getXPath(range.endContainer),
        xpath_full: getFullXPath(range.startContainer),
        start_position: range.startOffset,
        end_position: range.startOffset + selectedText.length,
        highlight_id: highlightId,  // Now we have the highlightId to use here
    });

    // Log the data BEFORE sending
    console.log('➡️ Sending to backend:', requestBody);

    // Send blocks to the backend
    // When sending new highlight data to the backend...
    fetch('/highlight/custom-markdown', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-TOKEN': document
          .querySelector('meta[name="csrf-token"]')
          .getAttribute('content'),
      },
      body: requestBody,
    })
      .then((response) => response.json())
      .then((data) => {
        if (data.success) {
          console.log('✅ Highlight saved and Markdown updated.');
          attachMarkListeners();
          // After saving, force a refresh of your highlightChunks:
          return fetchHighlightChunksOnDemand(book);
        } else {
          throw new Error(data.message);
        }
      })
      .then((updatedChunks) => {
        // Ensure the lazy loader exists or update it using the new chunks.
        const lazyLoader = initOrUpdateHighlightLazyLoader(updatedChunks);
        console.log("Updated highlightChunks:", updatedChunks);
      })
      .catch((error) => {
        console.error("❌ Error updating highlight:", error);
      });

});





    // Function to handle deleting a highlight
// Function to handle deleting a highlight
addTouchAndClickListener(
  document.getElementById("delete-hyperlight"),
  function (event) {
    event.preventDefault();
    console.log("Delete button clicked.");

    let selection = window.getSelection();
    let selectedText = selection.toString().trim();

    if (!selectedText) {
      console.error("No text selected to delete.");
      return;
    }

    let removedHighlightIds = [];
    let blockIds = [];

    // Select all <mark> elements
    const allMarks = document.querySelectorAll("mark");

    allMarks.forEach(function (mark) {
      let markText = mark.textContent.trim();
      console.log(
        "Comparing selectedText:",
        selectedText,
        "with markText:",
        markText
      );

      if (selectedText.includes(markText)) {
        // Instead of checking the 'id', check for a class that is not the default "highlight"
        const highlightClass = Array.from(mark.classList).find(
          (cls) => cls !== "highlight"
        );
        if (highlightClass) {
          removedHighlightIds.push(highlightClass);
          console.log(
            "Mark with highlight class to be deleted:",
            highlightClass
          );
        } else {
          console.warn("No unique highlight class found for mark:", mark);
        }

        // Find the parent with a numerical ID
        let blockElement = findParentWithNumericalId(mark);
        if (blockElement) {
          blockIds.push(blockElement.id);
          console.log("Found numerical block ID:", blockElement.id);
        } else {
          console.warn("No numerical block ID found for mark:", mark);
        }

        // Remove the highlight mark from the DOM
        let parentAnchor = mark.closest("a");
        if (parentAnchor) {
          let parent = parentAnchor.parentNode;
          parent.replaceChild(
            document.createTextNode(mark.textContent),
            parentAnchor
          );
        } else {
          let parent = mark.parentNode;
          parent.replaceChild(
            document.createTextNode(mark.textContent),
            mark
          );
        }
      }
    });
    attachMarkListeners();

    console.log("Removed highlight IDs:", removedHighlightIds);
    console.log("Affected block IDs:", blockIds);

    if (removedHighlightIds.length > 0) {
      let book = document
        .getElementById("main-content")
        .getAttribute("data-book");

      // Send the removed IDs and block IDs to the backend
      fetch("/highlight/custom-markdown-delete", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-TOKEN": document
          .querySelector('meta[name="csrf-token"]')
          .getAttribute("content"),
      },
      body: JSON.stringify({
        highlight_ids: removedHighlightIds, // now from the class attribute
        block_ids: blockIds, // IDs of affected block-level elements
        book: book, // Book identifier
      }),
    })
      .then((response) => response.json())
      .then((data) => {
        if (data.success) {
          console.log("Highlights deleted and HTML updated.");
        } else {
          console.error("Error from server:", data.message);
        }
      })
      .catch((error) => {
        console.error("Error deleting highlights:", error);
      });
    } else {
      console.error("No matching mark elements found in selection.");
    }
  }
);



    // Find the nearest ancestor with a numerical ID
    function findParentWithNumericalId(element) {
      let current = element;
      while (current) {
        if (current.hasAttribute("id") && !isNaN(parseInt(current.id, 10))) {
          return current; // Return the element
        }
        current = current.parentElement;
      }
      return null;
    }

  


    // Helper functions: getXPath, getFullXPath, normalizeXPath
    function getXPath(node) {
        if (node.nodeType === Node.TEXT_NODE) {
            node = node.parentNode;
        }
        if (node.id !== '') {
            return 'id("' + node.id + '")';
        }
        if (node === document.body) {
            return '/html/' + node.tagName.toLowerCase();
        }
        let ix = 0;
        let siblings = node.parentNode.childNodes;
        for (let i = 0; i < siblings.length; i++) {
            let sibling = siblings[i];
            if (sibling === node) {
                return getXPath(node.parentNode) + '/' + node.tagName.toLowerCase() + '[' + (ix + 1) + ']';
            }
            if (sibling.nodeType === 1 && sibling.tagName === node.tagName) {
                ix++;
            }
        }
    }

    function getFullXPath(node) {
        if (node.nodeType === Node.TEXT_NODE) {
            node = node.parentNode;
        }
        let fullXPath = '';
        while (node !== document.body) {
            let tagName = node.tagName.toLowerCase();
            let index = Array.prototype.indexOf.call(node.parentNode.children, node) + 1;
            fullXPath = '/' + tagName + '[' + index + ']' + fullXPath;
            node = node.parentNode;
        }
        return '/html' + fullXPath;
    }

    function normalizeXPath(xpath) {
        const regex = /^id\(".*?"\)\/div\[1\]/;
        return xpath.replace(regex, '');
    }


  

// Function to generate a unique hypercite ID
function generateHyperciteID() {
    return 'hypercite_' + Math.random().toString(36).substring(2, 9); // Unique ID generation
}

// Fallback copy function: Standard copy if HTML format isn't supported
function fallbackCopyText(text) {
    const textArea = document.createElement("textarea");
    textArea.value = text;
    document.body.appendChild(textArea);
    textArea.focus();
    textArea.select();
    try {
        document.execCommand('copy'); // Fallback copy for plain text
    } catch (err) {
        console.error('Fallback: Unable to copy text', err);
    }
    document.body.removeChild(textArea);
}



function collectHyperciteData(hyperciteId, wrapper) {
    console.log("Wrapper outerHTML:", wrapper.outerHTML);

    // Use the iterative method to find a parent with a numerical ID
    let parentElement = findParentWithNumericalId(wrapper);

    if (!parentElement) {
        console.error("No valid parent element with a numerical ID found for the <u> tag:", wrapper.outerHTML);
        return [];
    }

    return [
        {
            id: parentElement.id, // The parent element's ID
            html: parentElement.outerHTML, // Full outer HTML of the parent
            hypercite_id: wrapper.id // The hypercite ID
        }
    ];
}



function wrapSelectedTextInDOM(hyperciteId, book) {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) {
        console.error("No valid selection found for hypercite.");
        return;
    }
    const range = selection.getRangeAt(0);
    let parent = range.startContainer.parentElement;
    while (parent && !parent.hasAttribute('id')) {
        parent = parent.parentElement; // Traverse up to find a parent with an ID
    }
    if (!parent || isNaN(parseInt(parent.id, 10))) {
        console.error("No valid parent with numerical ID found.");
        return;
    }
    const wrapper = document.createElement('u');
    wrapper.setAttribute('id', hyperciteId);
    try {
        range.surroundContents(wrapper);
    } catch (e) {
        console.error("Error wrapping selected text:", e);
        return;
    }
    const blocks = collectHyperciteData(hyperciteId, wrapper);
    sendHyperciteBlocksToBackend(book, hyperciteId, blocks);
    attachMarkListeners();
    setTimeout(() => selection.removeAllRanges(), 50);
}   



// Send hypercite blocks to the backend
function sendHyperciteBlocksToBackend(book, hyperciteId, blocks) {
    fetch('/save-hypercite-blocks', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-CSRF-TOKEN': document.querySelector('meta[name="csrf-token"]').getAttribute('content')
        },
        body: JSON.stringify({
            book: book,
            hypercite_id: hyperciteId,
            blocks: blocks // Array of block-level IDs, HTML content, and hypercite IDs
        })
    })
        .then(response => response.json())
        .then(data => {
            if (data.success) {
            console.log('✅ Hypercite blocks saved and Markdown updated.');

        
        } else {
            console.error('❌ Error from server:', data.message);
        }
    })
    .catch(error => {
        console.error('❌ Error saving hypercite blocks:', error);
    });
}

// Event listener for copying text and creating a hypercite

document.addEventListener('copy', (event) => {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) {
        return; // Do nothing if no text is selected
    }

    const hyperciteId = generateHyperciteID();

    if (!book) {
        console.error("Book identifier not found.");
        return;
    }

    // Get the current site URL
    const currentSiteUrl = `${window.location.origin}`; // E.g., "https://thissite.com"
    const citationIdA = book; // Assign 'book' to 'citation_id_a'
    const hypercitedText = selection.toString(); // The actual text being copied
    const hrefA = `${currentSiteUrl}/${citationIdA}#${hyperciteId}`; // Construct href_a dynamically

    // Extract plain text from the selection
    const selectedText = selection.toString().trim(); // Plain text version of selected content

    // Create the HTML and plain text for the clipboard, including the full URL
    const clipboardHtml = `"${selectedText}"<a href="${hrefA}">[:]</a>`;
    const clipboardText = `"${selectedText}" [[:]](${hrefA})`;

    // Set clipboard data
    event.clipboardData.setData('text/html', clipboardHtml);
    event.clipboardData.setData('text/plain', clipboardText);
    event.preventDefault(); // Prevent default copy behavior

    // Wrap the selected text in the DOM and send data to the backend
    wrapSelectedTextInDOM(hyperciteId, citationIdA);
    saveHyperciteData(citationIdA, hyperciteId, hypercitedText, hrefA);
});



// Function to save hypercite metadata to the server
function saveHyperciteData(citation_id_a, hypercite_id, hypercited_text, href_a) {
    fetch(`/save-hypercite`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-CSRF-TOKEN': document.querySelector('meta[name="csrf-token"]').getAttribute('content')
        },
        body: JSON.stringify({
            citation_id_a: citation_id_a,
            hypercite_id: hypercite_id,
            hypercited_text: hypercited_text,
            href_a: href_a // Use the updated column name
        })
    })
        .then(response => response.json())
        .then(data => {
            if (data.success) {
                console.log('Hypercite data saved successfully');
            } else {
                console.error('Error saving hypercite data:', data.error);
            }
        })
        .catch(error => {
            console.error('Error saving hypercite data:', error);
        });
}




// [edit] button

// Function to get the full DOM path of the element in view
function getDomPath(element) {
    let path = [];
    while (element && element.nodeType === Node.ELEMENT_NODE) {
        let selector = element.nodeName.toLowerCase();
        if (element.id) {
            selector += `#${element.id}`;
            path.unshift(selector);
            break;
        } else {
            let sibling = element;
            let siblingIndex = 1;
            while ((sibling = sibling.previousElementSibling)) {
                if (sibling.nodeName.toLowerCase() === selector) siblingIndex++;
            }
            selector += `:nth-of-type(${siblingIndex})`;
        }
        path.unshift(selector);
        element = element.parentNode;
    }
    return path.join(" > ");
}

// Save position on refresh or navigation away
window.addEventListener('beforeunload', function () {
    const elementInView = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2);
    const domPath = getDomPath(elementInView);
    localStorage.setItem('originalReadPath', domPath);
    console.log("Updated originalReadPath on refresh:", domPath);
});

// Save original read position when clicking "edit" button
document.getElementById('editButton').addEventListener('click', function () {
    const elementInView = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2);
    const domPath = getDomPath(elementInView);

    // Save and log the original path for returning from edit mode
    localStorage.setItem('originalReadPath', domPath);
    console.log("Saved originalReadPath on edit:", domPath);

    // Redirect to the editable page
    window.location.href = `/${book}/div`; // Adjust URL as needed
});