import { book } from "./app.js";
import { navigateToInternalId } from "./scrolling.js";
import { openDatabase } from "./cache-indexedDB.js";
import { ContainerManager } from "./container-manager.js";
import { formatBibtexToCitation } from "./bibtexProcessor.js";



// Event listener for copying text and creating a hypercite
document.addEventListener("copy", (event) => {
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
  event.clipboardData.setData("text/html", clipboardHtml);
  event.clipboardData.setData("text/plain", clipboardText);
  event.preventDefault(); // Prevent default copy behavior

  // Wrap the selected text in the DOM and update IndexedDB
  wrapSelectedTextInDOM(hyperciteId, citationIdA);
});

function wrapSelectedTextInDOM(hyperciteId, book) {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) {
    console.error("No valid selection found for hypercite.");
    return;
  }
  const range = selection.getRangeAt(0);
  let parent = range.startContainer.parentElement;
  while (parent && !parent.hasAttribute("id")) {
    parent = parent.parentElement; // Traverse up to find a parent with an ID
  }
  if (!parent || isNaN(parseInt(parent.id, 10))) {
    console.error("No valid parent with numerical ID found.");
    return;
  }
  const wrapper = document.createElement("u");
  wrapper.setAttribute("id", hyperciteId);
  wrapper.setAttribute("class", "single");
  try {
    range.surroundContents(wrapper);
  } catch (e) {
    console.error("Error wrapping selected text:", e);
    return;
  }
  // Build blocks data: here we calculate the character offsets
  const blocks = collectHyperciteData(hyperciteId, wrapper);
  NewHyperciteIndexedDB(book, hyperciteId, blocks);
  setTimeout(() => selection.removeAllRanges(), 50);
}

async function NewHyperciteIndexedDB(book, hyperciteId, blocks) {
  // Open the IndexedDB database
  const db = await openDatabase();

  try {
    console.log("Attempting to add hypercite with book:", book);
    console.log("Hypercite ID:", hyperciteId);
    if (!book || !hyperciteId) {
      throw new Error("Missing key properties: book or hyperciteId is undefined.");
    }

    const tx = db.transaction(["hypercites", "nodeChunks"], "readwrite");
    const hypercitesStore = tx.objectStore("hypercites");

    // Locate the created <u> node in the DOM by hyperciteId.
    const uElement = document.getElementById(hyperciteId);
    if (!uElement) {
      throw new Error("Hypercite element not found in DOM.");
    }

    // Remove <u> tag wrappers to get clean inner HTML
    const tempDiv = document.createElement("div");
    const clonedU = uElement.cloneNode(true);
    tempDiv.appendChild(clonedU);
    const uTags = tempDiv.querySelectorAll("u");
    uTags.forEach((uTag) => {
      const textNode = document.createTextNode(uTag.textContent);
      uTag.parentNode.replaceChild(textNode, uTag);
    });

    const hypercitedHTML = tempDiv.innerHTML;
    const hypercitedText = uElement.textContent;
    const overallStartChar = blocks.length > 0 ? blocks[0].charStart : 0;
    const overallEndChar = blocks.length > 0 ? blocks[blocks.length - 1].charEnd : 0;

    // Build the hypercite record with two additional fields:
    const hyperciteEntry = {
      book: book,                     // Key field 1
      hyperciteId: hyperciteId,      // Key field 2 (must exactly match the store keyPath)
      hypercitedText: hypercitedText,
      hypercitedHTML: hypercitedHTML,
      startChar: overallStartChar,
      endChar: overallEndChar,
      relationshipStatus: "single",   // New field, initially "single"
      citedIN: []                 // New field, an empty array initially
    };

    console.log("Hypercite record to add:", hyperciteEntry);

    const addRequest = hypercitesStore.add(hyperciteEntry);
    addRequest.onerror = (event) => {
      console.error("❌ Error adding hypercite record:", event.target.error);
    };
    addRequest.onsuccess = () => {
      console.log("✅ Successfully added hypercite record.");
    };

    // --- Update nodeChunks for each affected block ---
    const nodeChunksStore = tx.objectStore("nodeChunks");

    for (const block of blocks) {
      console.log("Processing block:", block);
      if (block.startLine === undefined || block.startLine === null) {
        console.error("Block missing startLine:", block);
        continue;
      }
      // Retrieve the current record from nodeChunks using key [book, block.startLine].
      const getRequest = nodeChunksStore.get([book, block.startLine]);
      const nodeChunkRecord = await new Promise((resolve, reject) => {
        getRequest.onsuccess = (e) => resolve(e.target.result);
        getRequest.onerror = (e) => reject(e.target.error);
      });
      let updatedRecord;
      if (nodeChunkRecord) {
        if (!Array.isArray(nodeChunkRecord.hypercites)) {
          nodeChunkRecord.hypercites = [];
        }
        // Add the hypercite object to the nodeChunk hypercites array.
        nodeChunkRecord.hypercites.push({
          hyperciteId: hyperciteId,
          charStart: block.charStart,
          charEnd: block.charEnd,
          relationshipStatus: "single",  // New field in the nodeChunk as well
          citedIN: []                // New field; can later be updated with file paths (e.g. "/book#hyperciteID")
        });
        updatedRecord = nodeChunkRecord;
      } else {
        updatedRecord = {
          book: book,
          startLine: block.startLine,
          hypercites: [
            {
              hyperciteId: hyperciteId,
              charStart: block.charStart,
              charEnd: block.charEnd,
              relationshipStatus: "single",
              pastedNodes: []
            }
          ]
        };
      }
      const putRequest = nodeChunksStore.put(updatedRecord);
      await new Promise((resolve, reject) => {
        putRequest.onsuccess = () => {
          console.log(
            `✅ Updated nodeChunk [${book}, ${block.startLine}] with hypercite info.`
          );
          resolve();
        };
        putRequest.onerror = (e) => {
          console.error("❌ Error updating nodeChunk:", e.target.error);
          reject(e.target.error);
        };
      });
    }

    await new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = (e) => reject(e.target.error);
    });

    console.log("✅ Hypercite records and nodeChunks updated.");
  } catch (error) {
    console.error("❌ Error in NewHyperciteIndexedDB:", error);
  }
}


/**
 * Modify collectHyperciteData so that it returns an array of "block" objects.
 * Each block object contains:
 *   - startLine: the parent's numeric id (as a number)
 *   - charStart: the start character offset (computed from parent's innerText)
 *   - charEnd: the ending character offset
 *   - html: the parent's outer HTML
 *   - hypercite_id: the hypercite id (for reference)
 */
function collectHyperciteData(hyperciteId, wrapper) {
  console.log("Wrapper outerHTML:", wrapper.outerHTML);

  // Find nearest parent with a numeric id.
  const parentElement = findParentWithNumericalId(wrapper);
  if (!parentElement) {
    console.error(
      "No valid parent element with a numerical ID found for the <u> tag:",
      wrapper.outerHTML
    );
    return [];
  }

  const parentId = parseInt(parentElement.id, 10);
  const parentText = parentElement.innerText;

  // The hypercited text is the text of our <u> element.
  const hyperciteText = wrapper.innerText;
  let charStart = parentText.indexOf(hyperciteText);
  if (charStart === -1) {
    console.warn(
      "Could not determine the start position of hypercited text in the parent.",
      parentText,
      hyperciteText
    );
    charStart = 0;
  }
  const charEnd = charStart + hyperciteText.length;

  return [
    {
      startLine: parentId,
      charStart: charStart,
      charEnd: charEnd,
      html: parentElement.outerHTML,
      hypercite_id: hyperciteId,
      id: parentElement.id,
    },
  ];
}

// Function to generate a unique hypercite ID
function generateHyperciteID() {
  return "hypercite_" + Math.random().toString(36).substring(2, 9); // Unique ID generation
}

// Fallback copy function: Standard copy if HTML format isn't supported
function fallbackCopyText(text) {
  const textArea = document.createElement("textarea");
  textArea.value = text;
  document.body.appendChild(textArea);
  textArea.focus();
  textArea.select();
  try {
    document.execCommand("copy"); // Fallback copy for plain text
  } catch (err) {
    console.error("Fallback: Unable to copy text", err);
  }
  document.body.removeChild(textArea);
}

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



// Function to get hypercite data from IndexedDB
async function getHyperciteData(book, startLine) {
  try {
    const db = await openDatabase();
    const tx = db.transaction("nodeChunks", "readonly");
    const store = tx.objectStore("nodeChunks");
    
    // Use the composite key [book, startLine]
    const request = store.get([book, startLine]);
    
    return new Promise((resolve, reject) => {
      request.onsuccess = () => {
        resolve(request.result);
      };
      request.onerror = () => {
        reject(new Error("Error retrieving hypercite data"));
      };
    });
  } catch (error) {
    console.error("Error accessing IndexedDB:", error);
    throw error;
  }
}

// Assume getHyperciteData and book are imported from elsewhere, as in the original

/**
 * Function to handle the click on <u class="couple"> tags.
 * @param {HTMLElement} uElement - The <u class="couple"> element that was clicked.
 */
async function UpdateUnderlineCouple(uElement) {
  console.log("u.couple element clicked:", uElement);

  const parent = uElement.parentElement;
  if (!parent || !parent.id) {
    console.error("Parent element not found or missing id.", uElement);
    return;
  }
  console.log("Parent element found:", parent);

  const startLine = parseFloat(parent.id); // Convert ID to number for IndexedDB
  const bookId = book || "latest"; // Use the imported book variable

  try {
    const nodeChunk = await getHyperciteData(bookId, startLine);
    if (!nodeChunk) {
      console.error(
        `No nodeChunk found for book: ${bookId}, startLine: ${startLine}`
      );
      return;
    }
    console.log("Retrieved nodeChunk:", nodeChunk);

    // Get the hyperciteId from the clicked <u> tag
    const clickedHyperciteId = uElement.id;
    let link = null;

    if (nodeChunk.hypercites && nodeChunk.hypercites.length > 0) {
      // Look for the hypercite that matches the clicked hyperciteId
      const matchingHypercite = nodeChunk.hypercites.find(
        (hyper) => hyper.hyperciteId === clickedHyperciteId
      );

      if (
        matchingHypercite &&
        matchingHypercite.citedIN &&
        matchingHypercite.citedIN.length > 0
      ) {
        link = matchingHypercite.citedIN[0];
      }
    }

    if (link) {
      // If the link is relative, prepend the base URL
      if (link.startsWith("/")) {
        link = window.location.origin + link;
      }
      console.log("Opening link:", link);
      window.location.href = link;
    } else {
      console.error(
        "No citedIN link found for clicked hyperciteId:",
        clickedHyperciteId,
        nodeChunk
      );
    }
  } catch (error) {
    console.error("Failed to retrieve hypercite data:", error);
  }
}

/**
 * Function to handle clicks on underlined elements based on their class
 * @param {HTMLElement} uElement - The underlined element that was clicked
 * @param {Event} event - The click event
 */
async function handleUnderlineClick(uElement, event) {
  // Check the class of the underlined element
  if (uElement.classList.contains("couple")) {
    await UpdateUnderlineCouple(uElement);
  } else if (uElement.classList.contains("poly")) {
    await UpdateUnderlinePoly(event);
  } else {
    console.log("Clicked on an underlined element with no special handling");
  }
}

/**
 * Function to attach click listeners to underlined citations
 */
export function attachUnderlineClickListeners() {
  // Select all underlined elements with either couple or poly class
  const uElements = document.querySelectorAll("u.couple, u.poly");
  console.log(
    `attachUnderlineClickListeners: Found ${uElements.length} underlined elements.`
  );

  uElements.forEach((uElement, index) => {
    console.log(`Processing element ${index + 1}:`, uElement);
    uElement.style.cursor = "pointer";

    uElement.addEventListener("click", async (event) => {
      await handleUnderlineClick(uElement, event);
    });
  });
}


export async function UpdateUnderlinePoly(event) {
  // Prevent default click action if needed
  event.preventDefault();

  // Get hyperciteId from the clicked element
  const hyperciteId = event.target.id;

  if (!hyperciteId) {
    console.error("❌ Could not determine hypercite ID.");
    return;
  }

  console.log(`u.poly clicked: ${hyperciteId}`);

  try {
    const db = await openDatabase();
    const tx = db.transaction("hypercites", "readonly");
    const store = tx.objectStore("hypercites");
    const index = store.index("hyperciteId");

    const getRequest = index.get(hyperciteId);

    getRequest.onsuccess = async () => {
      const hyperciteData = getRequest.result;
      console.log("Found hypercite data:", hyperciteData);

      if (!hyperciteData) {
        console.error("❌ No hypercite data found for ID:", hyperciteId);
        return;
      }

      // If your hyperciteData contains a citedIN array, we build the container's content based on that.
      let linksHTML = "";
      if (Array.isArray(hyperciteData.citedIN) && hyperciteData.citedIN.length > 0) {
        linksHTML = await Promise.all(
          hyperciteData.citedIN.map(async (citationID) => {
            // Extract the book/citation ID from the URL
            const bookID = citationID.split("#")[0].replace("/", "");

            // Check if the book exists in the library object store
            const libraryTx = db.transaction("library", "readonly");
            const libraryStore = libraryTx.objectStore("library");
            const libraryRequest = libraryStore.get(bookID);

            return new Promise((resolve) => {
              libraryRequest.onsuccess = () => {
                const libraryData = libraryRequest.result;

                if (libraryData && libraryData.bibtex) {
                  // Format the BibTeX data into an academic citation
                  const formattedCitation = formatBibtexToCitation(libraryData.bibtex);

                  // Return the formatted citation with the clickable link
                  resolve(
                    `<p>${formattedCitation} <a href="${citationID}" class="citation-link">[:]</a></p>`
                  );
                } else {
                  // If no record exists, return the default link
                  resolve(`<a href="${citationID}" class="citation-link">${citationID}</a>`);
                }
              };

              libraryRequest.onerror = () => {
                console.error(`❌ Error fetching library data for book ID: ${bookID}`);
                resolve(`<a href="${citationID}" class="citation-link">${citationID}</a>`);
              };
            });
          })
        ).then((results) => results.join("<br>"));
      } else {
        linksHTML = "<p>No citations available.</p>";
      }

      const containerContent = `
        <div class="scroller">
          <h1> Cited By: </h1>
          <p class="hypercite-text">
            ${hyperciteData.highlightedHTML || ""}
          </p>
          <div class="citation-links">
            ${linksHTML}
          </div>
        </div>
        <div class="mask-bottom"></div>
        <div class="mask-top"></div>
      `;

      // Open the hypercite container with the generated content
      openHyperciteContainer(containerContent);

      // Double-check that the container exists and has content
      const hyperciteContainer =
        document.getElementById("hypercite-container");
      if (!hyperciteContainer) {
        console.error("❌ Hypercite container element not found in DOM");
        return;
      }
      console.log("Container state:", {
        exists: !!hyperciteContainer,
        content: hyperciteContainer.innerHTML,
        isVisible: hyperciteContainer.classList.contains("open"),
      });
    };

    getRequest.onerror = (event) => {
      console.error("❌ Error fetching hypercite data:", event.target.error);
    };
  } catch (error) {
    console.error("❌ Error accessing IndexedDB:", error);
  }
}




// Assume ContainerManager, openDatabase, and other helper functions are imported

// Create a container manager for hypercites using the same overlay if needed
const hyperciteManager = new ContainerManager(
  "hypercite-container",
  "ref-overlay",
  null,
  ["main-content", "nav-buttons"]
);

export function openHyperciteContainer(content) {
  hyperciteManager.openContainer(content);
}

export function closeHyperciteContainer() {
  hyperciteManager.closeContainer();
}




// Future implementation for <u class="poly">
// export async function UpdateUnderlinePoly(uElement) {
//   // Do something different for .poly class underlines...
// }




