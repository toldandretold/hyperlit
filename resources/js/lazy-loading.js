/* Lazy Loading Logic [: as i understand it]

[haven't done this yet] If a lazy-load.json doesn’t already exist that is update more recently than the main-text.md, 

The main-text.md is processed to generate / update the lazy-load.json [not as a saved file yet, but as: window.nodeChunks = parseMarkdownIntoChunks(window.markdownContent);], and it is saved as browser memory.

This .jason stores: 

- data-chunk-id: number of each chunk of blocks and lines to be lazy loaded 
- data-block-id: Block number 
- id: Md line number 

On page load, lazy-load.jason is used to:

- convert the first chunk of md blocks to html 
- Pit in DOM within: div.id=“data-chunk-id”
- insert sentinels at top and bottom of this chunk 
- listen for when top or bottom sentinel node gets to either the top or bottom of the viewport/rootMargin
- when it does, check if the next highest chunk (numerically, from the one that the tracked html node id is in) is in the DOM
- If it isn’t, lazy load it.

When Navigating to internal links: 

- extract the id of internal link
- search for it in the DOM
- if it is there, navigate to it, to centre of viewport 
- if not, use .jason to determine which chunk its in, load that chunk and one above and below.
- put sentinels above and below this new "contiguous range of chunks"
- clear nodes outside this range (could change this if needed)
- so now lazy loading works up and down... 

*/
    
// footnotes buttons
const refContainer = document.getElementById("ref-container");
const refOverlay = document.getElementById("ref-overlay");
let isRefOpen = false;

// .jason: could save this as a file, and check its 
//updated time to determine whether to reload
//on page load
window.nodeChunks = parseMarkdownIntoChunks(window.markdownContent);

// ============================================================
// Adjusting the Page Initialization
// ============================================================
function initializePage() {
  if (!window.markdownContent) {
    console.error("❌ No Markdown content detected.");
    return;
  }

  console.log("📌 Initializing page with Markdown content...");

  const mainContentDiv = document.getElementById("main-content");
  if (!mainContentDiv) {
    console.error("❌ No #main-content found.");
    return;
  }
  mainContentDiv.innerHTML = "";

  // Parse Markdown into node chunks.
  window.nodeChunks = parseMarkdownIntoChunks(window.markdownContent);
  if (!window.nodeChunks || window.nodeChunks.length === 0) {
    console.error("❌ Markdown parsing failed! No node chunks found.");
    return;
  }
  console.log(`✅ Markdown successfully parsed into ${window.nodeChunks.length} node chunks.`);

  // Initialize tracking of loaded chunks.
  window.currentlyLoadedChunks = new Set();

  // Check for an internal link (hash in URL)
  const targetId = getTargetIdFromUrl();
  if (targetId) {
    console.log(`🔗 Internal link detected with target ID: ${targetId}`);
    let targetChunkIndex;

    if (isNumericId(targetId)) {
      // Numeric IDs assumed to be the block's startLine
      targetChunkIndex = window.nodeChunks.findIndex(chunk =>
        chunk.blocks.some(block => block.startLine.toString() === targetId)
      );
    } else {
      // For non-numeric IDs, try to find the chunk by scanning for the target within the raw Markdown or block content.
      const targetLine = findLineForCustomId(targetId);
      if (targetLine === null) {
        console.warn(`❌ No block found for target ID "${targetId}" in nodeChunks. Loading first chunk as fallback.`);
        targetChunkIndex = 0;
      } else {
        targetChunkIndex = window.nodeChunks.findIndex(chunk =>
          targetLine >= chunk.start_line && targetLine <= chunk.end_line
        );
      }
    }

    if (targetChunkIndex === -1) {
      console.warn(`❌ Could not determine a chunk for target ID "${targetId}". Loading first chunk as fallback.`);
      targetChunkIndex = 0;
    }

    // Optionally, load a contiguous block of chunks (e.g., one before and one after)
    const startIndex = Math.max(0, targetChunkIndex - 1);
    const endIndex = Math.min(window.nodeChunks.length - 1, targetChunkIndex + 1);
    const chunksToLoad = window.nodeChunks.slice(startIndex, endIndex + 1);

    console.log(`✅ Internal link block determined. Loading chunks: ${chunksToLoad.map(c => c.chunk_id)}`);

    // Load each chunk in the contiguous block.
    chunksToLoad.forEach(chunk => {
      if (!document.querySelector(`[data-chunk-id="${chunk.chunk_id}"]`)) {
        loadChunk(chunk.chunk_id, "down");
      }
    });
  } else {
    // No internal link: load the first chunk by default.
    const firstChunk = window.nodeChunks[0];
    if (firstChunk) {
      console.log(`🟢 Loading first chunk (Chunk ID: ${firstChunk.chunk_id})`);
      loadChunk(firstChunk.chunk_id, "down");
    } else {
      console.error("❌ First chunk could not be found!");
    }
  }

  // Now initialize the fixed sentinels for the contiguous block.
  initializeLazyLoadingFixed();

  // Attach any scroll event listeners, navigation handling, etc.
  handleNavigation();

  // Now that everything's ready, make the main content visible.
  mainContentDiv.style.visibility = "visible"; 
}




// Markdown Conversion shit

async function loadMarkdownFile() {
  try {
    // Retrieve the stored timestamp for the Markdown file, if available.
    const storedMdTimestamp = localStorage.getItem("markdownLastModified") || new Date().getTime();
    // Build the fresh URL using the global getFreshUrl function.
    const freshMdUrl = window.getFreshUrl(window.mdFilePath, storedMdTimestamp);

    // Log the timestamp and URL for debugging.
    console.log(`Loading Markdown from: ${freshMdUrl} (timestamp: ${storedMdTimestamp})`);
    
    const response = await fetch(freshMdUrl);
    if (!response.ok) throw new Error(`Failed to load Markdown: ${response.statusText}`);
    
    window.markdownContent = await response.text(); // Assign Markdown content globally
    console.log("📄 Markdown file loaded successfully:", window.markdownContent.substring(0, 100));

    // Now that we have the Markdown, initialize everything.
    initializePage();
  } catch (error) {
    console.error("❌ Error loading Markdown file:", error);
  }
}


function parseMarkdownIntoChunks(markdown) {
    const lines = markdown.split("\n");
    const chunks = [];
    let currentChunk = [];
    let currentChunkId = 0;
    let currentStartLine = 1;

    for (let i = 0; i < lines.length; i++) {
        const rawLine = lines[i];
        const trimmed = rawLine.trim();
        const adjustedLineNumber = i + 1;
        let block = null;

        if (trimmed.match(/^#{1,5}\s/)) {
            block = { type: "heading", level: trimmed.match(/^#{1,5}/)[0].length, startLine: adjustedLineNumber, content: trimmed.replace(/^#+\s*/, "") };
        }
        else if (trimmed.startsWith(">")) {
            block = { type: "blockquote", startLine: adjustedLineNumber, content: trimmed.replace(/^>\s?/, "") };
        }
        else if (trimmed.match(/^!\[.*\]\(.*\)$/)) {
            const match = trimmed.match(/^!\[(.*)\]\((.*)\)$/);
            block = { type: "image", startLine: adjustedLineNumber, altText: match ? match[1] : "", imageUrl: match ? match[2] : "" };
        }
        else if (trimmed) {
            block = { type: "paragraph", startLine: adjustedLineNumber, content: trimmed };
        }

        if (block) {
            currentChunk.push(block);
        }

        if (currentChunk.length >= 50 || i === lines.length - 1) {
            chunks.push({ chunk_id: currentChunkId, start_line: currentStartLine, end_line: adjustedLineNumber, blocks: currentChunk });
            currentChunk = [];
            currentChunkId++;
            currentStartLine = adjustedLineNumber + 1;
        }
    }

    return chunks;
}


function renderBlockToHtml(block) {

    let html = "";
    if (!block || !block.type || typeof block.content === "undefined") {
        console.error("❌ Invalid block detected:", block);
        return "";
    }

    // Ensure each block is wrapped in a div with data-block-id
    let blockWrapper = `<div data-block-id="${block.startLine}">`;

    if (block.type === "heading") {
        let headingTag = `h${block.level}`;
        html += `<${headingTag} id="${block.startLine}" data-block-id="${block.startLine}">${parseInlineMarkdown(block.content)}</${headingTag}>\n`;
    }
    else if (block.type === "blockquote") {
        html += `<blockquote data-block-id="${block.startLine}"><p id="${block.startLine}">${parseInlineMarkdown(block.content)}</p></blockquote>\n`;
    }
    else if (block.type === "image") {
        html += `<img id="${block.startLine}" data-block-id="${block.startLine}" src="${block.imageUrl}" alt="${block.altText}" />\n`;
    }
    else if (block.type === "paragraph") {
        // ✅ Ensure each paragraph gets an `id` based on its line number
        html += `<p id="${block.startLine}" data-block-id="${block.startLine}">${parseInlineMarkdown(block.content)}</p>\n`;
    }

    return blockWrapper + html + `</div>\n`;  // Close block wrapper
}

// Function to parse inline Markdown for italics, bold, and inline code
function parseInlineMarkdown(text) {
    text = text.replace(/\\([`*_{}\[\]()#+.!-])/g, "$1"); // Remove escape characters before processing
    text = text.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>"); // Convert **bold** to <strong>
    text = text.replace(/\*([^*]+)\*/g, "<em>$1</em>"); // Convert *italic* to <em>
    text = text.replace(/`([^`]+)`/g, "<code>$1</code>"); // Convert `code` to <code>
    
    // Convert Markdown links [text](url) to HTML <a> tags
    text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

    return text;
}

    function convertMarkdownToHtml(markdown) {
        const lines = markdown.split("\n");
        let htmlOutput = "";

        lines.forEach((line) => {
            const trimmedLine = line.trim();
            if (trimmedLine.startsWith("# ")) {
                htmlOutput += `<h1>${parseInlineMarkdown(trimmedLine.replace(/^# /, ""))}</h1>`;
            } else if (trimmedLine.startsWith("## ")) {
                htmlOutput += `<h2>${parseInlineMarkdown(trimmedLine.replace(/^## /, ""))}</h2>`;
            } else if (trimmedLine.startsWith("### ")) {
                htmlOutput += `<h3>${parseInlineMarkdown(trimmedLine.replace(/^### /, ""))}</h3>`;
            } else if (trimmedLine.startsWith(">")) {
                htmlOutput += `<blockquote>${parseInlineMarkdown(trimmedLine.replace(/^> /, ""))}</blockquote>`;
            } else if (trimmedLine.match(/^!\[.*\]\(.*\)$/)) {
                const imageMatch = trimmedLine.match(/^!\[(.*)\]\((.*)\)$/);
                if (imageMatch) {
                    const altText = imageMatch[1];
                    const imageUrl = imageMatch[2];
                    htmlOutput += `<img src="${imageUrl}" alt="${altText}"/>`;
                }
            } else if (trimmedLine) {
                htmlOutput += `<p>${parseInlineMarkdown(trimmedLine)}</p>`;
            }
        });

        return htmlOutput;
    }



// TOC shit // 
// Function to generate and display the Table of Contents

async function generateTableOfContents(jsonPath, tocContainerId, toggleButtonId) {
  try {
    // Get the stored timestamp for the footnotes JSON (or use current time if not available)
    const storedFootnotesTimestamp = localStorage.getItem("footnotesLastModified") || new Date().getTime();
    // Use the global getFreshUrl function to build the URL
    const freshJsonUrl = window.getFreshUrl(jsonPath, storedFootnotesTimestamp);
    
    const response = await fetch(freshJsonUrl);
    const sections = await response.json();

    // Log the timestamp and URL for debugging.
    console.log(`Loading .json from: ${freshJsonUrl} (timestamp: ${storedFootnotesTimestamp})`);

    const tocContainer = document.getElementById(tocContainerId);
    if (!tocContainer) {
      console.error(`TOC container with ID "${tocContainerId}" not found.`);
      return;
    }

    tocContainer.innerHTML = "";

    let firstHeadingAdded = false;

    sections.forEach((section) => {
      if (section.heading) {
        const headingContent = Object.values(section.heading)[0]; // Get the heading text
        const headingLevel = Object.keys(section.heading)[0]; // Get the heading level (e.g., h1, h2)
        const lineNumber = section.heading.line_number; // Get the line number

        if (headingContent && headingLevel && lineNumber) {
          // Convert Markdown to inline HTML for heading content
          const headingHtml = parseInlineMarkdown(headingContent);

          // Create the heading element dynamically (e.g., <h1>, <h2>)
          const headingElement = document.createElement(headingLevel);
          headingElement.innerHTML = headingHtml;

          // Add the "first" class to the first heading
          if (!firstHeadingAdded) {
            headingElement.classList.add("first");
            firstHeadingAdded = true;
          }

          // Create a link wrapping the heading
          const link = document.createElement("a");
          link.href = `#${lineNumber}`;
          link.appendChild(headingElement);

          // Create a container for the link
          const tocItem = document.createElement("div");
          tocItem.classList.add("toc-item", headingLevel); // Optional: Add class for styling
          tocItem.appendChild(link);

          // Append the container to the TOC
          tocContainer.appendChild(tocItem);
        }
      }
    });

    // Add a toggle button to show/hide the TOC
    const toggleButton = document.getElementById(toggleButtonId);
    if (toggleButton) {
      toggleButton.addEventListener("click", () => {
        tocContainer.classList.toggle("hidden");
      });
    }
  } catch (error) {
    console.error("Error generating Table of Contents:", error);
  }
}




// CHUNKY CHUNKY
// ============================================================
// Fixed Sentinel Setup for a Contiguous Block
// ============================================================

function initializeLazyLoadingFixed() {
  const mainContentDiv = document.getElementById("main-content");

  let topSentinel = document.getElementById("top-sentinel");
  if (!topSentinel) {
    topSentinel = document.createElement("div");
    topSentinel.id = "top-sentinel";
    topSentinel.classList.add("sentinel");
    mainContentDiv.prepend(topSentinel);
  }

  let bottomSentinel = document.getElementById("bottom-sentinel");
  if (!bottomSentinel) {
    bottomSentinel = document.createElement("div");
    bottomSentinel.id = "bottom-sentinel";
    bottomSentinel.classList.add("sentinel");
    mainContentDiv.appendChild(bottomSentinel);
  }

  const options = {
    root: mainContentDiv,
    rootMargin: "50px",
    threshold: 0
  };

  const observer = new IntersectionObserver((entries) => {
    if (window.isNavigatingToInternalId || window.isUpdatingJsonContent) {
      console.log("Navigation in progress; skipping lazy-load triggers.");
      return;
    }

    entries.forEach(entry => {
      if (!entry.isIntersecting) return;

      if (entry.target.id === "top-sentinel") {
        const firstChunkEl = mainContentDiv.querySelector("[data-chunk-id]");
        if (firstChunkEl) {
          const firstChunkId = parseInt(firstChunkEl.getAttribute("data-chunk-id"), 10);
          if (firstChunkId > 0 && !window.currentlyLoadedChunks.has(firstChunkId - 1)) {
            console.log(`🟢 Loading previous chunk ${firstChunkId - 1}`);
            loadPreviousChunkFixed(firstChunkId);
          }
        }
      }

      if (entry.target.id === "bottom-sentinel") {
        const lastChunkEl = getLastChunkElement();
        if (lastChunkEl) {
          const lastChunkId = parseInt(lastChunkEl.getAttribute("data-chunk-id"), 10);
          loadNextChunkFixed(lastChunkId);
        }
      }
    });
  }, options);

  observer.observe(topSentinel);
  observer.observe(bottomSentinel);
  console.log("🕒 Sentinels observation started immediately.");

  // Store reference
  window.fixedSentinelObserver = observer;
  window.topSentinel = topSentinel;
  window.bottomSentinel = bottomSentinel;
}





// A helper to get the last chunk element currently in the DOM.
function getLastChunkElement() {
  const chunks = document.querySelectorAll("[data-chunk-id]");
  if (chunks.length === 0) return null;
  return chunks[chunks.length - 1];
}

// ============================================================
// Revised Chunk Loading Functions (Fixed Sentinel Version)
// ============================================================

// Loads the previous chunk and repositions the top sentinel.
function loadPreviousChunkFixed(currentFirstChunkId) {
  const previousChunkId = currentFirstChunkId - 1;
  if (previousChunkId < 0) {
    console.warn("🚫 No previous chunks to load.");
    return;
  }
  // If already loaded, do nothing.
  if (document.querySelector(`[data-chunk-id="${previousChunkId}"]`)) {
    console.log(`✅ Previous chunk ${previousChunkId} is already loaded.`);
    return;
  }
  
  const prevChunk = window.nodeChunks.find(chunk => chunk.chunk_id === previousChunkId);
  if (!prevChunk) {
    console.warn(`❌ No data found for chunk ${previousChunkId}.`);
    return;
  }
  
  console.log(`🟢 Loading previous chunk (loadPreviousChunkFixed): ${previousChunkId}`);
  const scrollContainer = document.getElementById("main-content");
  
  // Store current scroll position
  const prevScrollTop = scrollContainer.scrollTop;
  
  // Create and insert the new chunk at the top.
  const chunkWrapper = createChunkElement(prevChunk);
  scrollContainer.insertBefore(chunkWrapper, scrollContainer.firstElementChild);
  window.currentlyLoadedChunks.add(previousChunkId);
  
  // Measure the new chunk's height.
  const newChunkHeight = chunkWrapper.getBoundingClientRect().height;
  
  // Adjust the scroll so the content remains anchored.
  scrollContainer.scrollTop = prevScrollTop + newChunkHeight;
  
  // Reposition the fixed top sentinel to be immediately before the first chunk.
  if (window.topSentinel) {
    window.topSentinel.remove();
    scrollContainer.prepend(window.topSentinel);
  }
}


// Loads the next chunk and repositions the bottom sentinel.
function loadNextChunkFixed(currentLastChunkId) {
  const nextChunkId = currentLastChunkId + 1;
  // If already loaded, do nothing.
  if (document.querySelector(`[data-chunk-id="${nextChunkId}"]`)) {
    console.log(`✅ Next chunk ${nextChunkId} is already loaded.`);
    return;
  }

  const nextChunk = window.nodeChunks.find(chunk => chunk.chunk_id === nextChunkId);
  if (!nextChunk) {
    console.warn(`❌ No data found for chunk ${nextChunkId}.`);
    return;
  }

  console.log(`🟢 Loading next chunk: ${nextChunkId}`);
  const mainContentDiv = document.getElementById("main-content");
  const chunkWrapper = createChunkElement(nextChunk);
  mainContentDiv.appendChild(chunkWrapper);
  window.currentlyLoadedChunks.add(nextChunkId);

  // Reposition the bottom sentinel: remove it and re-append it.
  if (window.bottomSentinel) {
    window.bottomSentinel.remove();
    mainContentDiv.appendChild(window.bottomSentinel);
  }
}


// ✅ Creates a chunk element with sentinels
function createChunkElement(chunk) {
    const chunkWrapper = document.createElement("div");
    chunkWrapper.setAttribute("data-chunk-id", chunk.chunk_id);
    chunkWrapper.classList.add("chunk");

    chunk.blocks.forEach(block => {
        const html = renderBlockToHtml(block);
        const tempDiv = document.createElement("div");
        tempDiv.innerHTML = html;
        chunkWrapper.appendChild(tempDiv);
    });
    return chunkWrapper;
}

// ✅ Get the first chunk currently in the DOM
function getFirstChunkId() {
    const firstChunk = document.querySelector("[data-chunk-id]");
    return firstChunk ? parseInt(firstChunk.getAttribute("data-chunk-id"), 10) : null;
}

// ✅ Get the last chunk currently in the DOM
function getLastChunkId() {
    const chunks = document.querySelectorAll("[data-chunk-id]");
    if (chunks.length === 0) return null;
    return parseInt(chunks[chunks.length - 1].getAttribute("data-chunk-id"), 10);
}

function insertChunkInOrder(newChunk) {
    const mainContentDiv = document.getElementById("main-content");
    const existingChunks = [...mainContentDiv.querySelectorAll("[data-chunk-id]")];

    let inserted = false;
    const newChunkId = parseInt(newChunk.getAttribute("data-chunk-id"), 10);

    for (let i = 0; i < existingChunks.length; i++) {
        const existingChunkId = parseInt(existingChunks[i].getAttribute("data-chunk-id"), 10);
        
        if (newChunkId < existingChunkId) {
            mainContentDiv.insertBefore(newChunk, existingChunks[i]);
            inserted = true;
            break;
        }
    }

    // If it wasn't inserted, append it to the end
    if (!inserted) {
        mainContentDiv.appendChild(newChunk);
    }

    console.log(`✅ Inserted chunk ${newChunkId} in the correct order.`);
}


function loadChunk(chunkId, direction = "down") {
    console.log(`🟢 Loading chunk: ${chunkId}, direction: ${direction}`);

    // Check if the chunk is already loaded
    if (window.currentlyLoadedChunks.has(chunkId)) {
        console.log(`✅ Chunk ${chunkId} is already loaded. Skipping.`);
        return;
    }

    // Find the chunk data
    const chunk = window.nodeChunks.find(c => c.chunk_id === chunkId);
    if (!chunk) {
        console.error(`❌ Chunk ${chunkId} not found!`);
        return;
    }

    // Create the chunk wrapper
    const chunkWrapper = document.createElement("div");
    chunkWrapper.setAttribute("data-chunk-id", chunkId);
    chunkWrapper.classList.add("chunk"); // Optional for styling

    chunk.blocks.forEach(block => {
        if (!block.content) {
            console.warn(`🚨 Skipping empty block at line ${block.startLine}`);
            return;
        }

        const html = renderBlockToHtml(block);
        const tempDiv = document.createElement("div");
        tempDiv.innerHTML = html;
        chunkWrapper.appendChild(tempDiv);
    });

    // ✅ Insert chunk in the correct position
    insertChunkInOrder(chunkWrapper);
    injectFootnotesForChunk(chunk.chunk_id, jsonPath);
    

    // ✅ Mark chunk as loaded
    window.currentlyLoadedChunks.add(chunkId);
    console.log(`✅ Chunk ${chunkId} inserted.`);
}

     // [:FOOTNOTES]

    /**
     * We need to prevent lazy loading while doing footnotes, as the footnotes alters dom, and thefore acts as a scroll event that 
     * To prevent lazy loading from triggering when footnotes are injected, you need to:
        * Temporarily disable lazy loading (window.isUpdatingJsonContent = true).
        * Inject footnotes as usual.
        *Re-enable lazy loading (window.isUpdatingJsonContent = false) after updates.
        */

       /**
 * Injects footnotes for a given chunk.
 * This function retrieves the chunk data (including its start and end lines)
 * and then applies footnotes that fall within that range.
 *
 * @param {number} chunkId - The ID of the chunk to process.
 * @param {string} jsonPath - Path to the JSON file containing footnotes.
 */
function injectFootnotesForChunk(chunkId, jsonPath) {
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
  
  // Retrieve the stored timestamp for the footnotes JSON (or use current time if not available)
  const storedFootnotesTimestamp = localStorage.getItem("footnotesLastModified") || new Date().getTime();
  const freshJsonUrl = window.getFreshUrl(jsonPath, storedFootnotesTimestamp);
  
  // Fetch the footnotes JSON.
  fetch(freshJsonUrl)
    .then((response) => response.json())
    .then((sections) => {
      sections.forEach((section) => {
        if (section.footnotes) {
          Object.entries(section.footnotes).forEach(([key, footnote]) => {
            const { line_number, content } = footnote;
            
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

      // ✅ Re-enable lazy loading after footnotes update
      setTimeout(() => {
        window.isUpdatingJsonContent = false;
        console.log("✅ Re-enabling lazy loading after footnotes update.");
      }, 200); // Delay ensures any layout shifts settle
    })
    .catch((error) => {
      console.error("Error injecting footnotes for chunk:", error);
      window.isUpdatingJsonContent = false;
    });
}





         // Function to update the footnotes container state
        function updateRefState() {
            if (isRefOpen) {
                console.log("Opening footnotes container...");
                refContainer.classList.add("open");
                refOverlay.classList.add("active");
            } else {
                console.log("Closing footnotes container...");
                refContainer.classList.remove("open");
                refOverlay.classList.remove("active");
            }
        }

         // Function to fetch footnotes JSON
        async function fetchFootnotes() {
            try {
                const response = await fetch(jsonPath);
                if (!response.ok) {
                    throw new Error(`Failed to fetch footnotes JSON: ${response.statusText}`);
                }
                return await response.json();
            } catch (error) {
                console.error("Error fetching footnotes JSON:", error);
                return null;
            }
        }

        // Function to open the footnotes container with content
        function openReferenceContainer(content) {
                console.log("Opening reference container with content:", content); // Debugging output
            if (refContainer) {
                if (refContainer) {
                    refContainer.innerHTML = content; // Populate the container
                    isRefOpen = true;
                    updateRefState();
                }
            }
        }

        // Function to close the reference container
            function closeReferenceContainer() {
                    isRefOpen = false;
                updateRefState();
                setTimeout(() => {
                    refContainer.innerHTML = ""; // Clear content after animation
                }, 300); // Delay to match the slide-out animation
            }

            console.log("convertMarkdownToHtml function:", typeof convertMarkdownToHtml);

            async function displayFootnote(noteElement) {
                const noteKey = noteElement.dataset.noteKey;
                const parentId = noteElement.closest("[id]")?.id;

                console.log("Note key:", noteKey);
                console.log("Parent ID:", parentId);


                if (!noteKey || !parentId) {
                    console.warn("Missing note key or parent ID for the clicked footnote.");
                    return;
                }

                const footnotesData = await fetchFootnotes();
                if (!footnotesData) {
                    console.error("Footnotes data could not be fetched.");
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


    // Handle navigation to specific ID or position
    let navigationTimeout;

    function handleNavigation() {
        clearTimeout(navigationTimeout);
        navigationTimeout = setTimeout(() => {
            const targetId = getTargetIdFromUrl();
            if (targetId) {
                console.log(`🔍 Handling navigation to: ${targetId}`);
                navigateToInternalId(targetId);
            }
        }, 300);
    }


    // Utility: Extract target `id` from the URL
    function getTargetIdFromUrl() {
        return window.location.hash ? window.location.hash.substring(1) : null;
    }


      // Utility: Check if an ID is numerical
    function isNumericId(id) {
        return /^\d+$/.test(id);
    }

    // Utility: Find a line for a numerical ID
    function findLineForNumericId(lineNumber, markdown) {
        const totalLines = markdown.split("\n").length;
        return Math.max(0, Math.min(lineNumber, totalLines - 1));
    }

    



    function findBlockForLine(lineNumber, allBlocks) {
      for (let i = 0; i < allBlocks.length; i++) {
        const block = allBlocks[i];
        const start = block.startLine;
        const end   = start + block.lines.length - 1;
        // If lineNumber is within [start..end]
        if (lineNumber >= start && lineNumber <= end) {
          return i; // i = index in allBlocks
        }
      }
      return -1; // not found
    }


function waitForElementAndScroll(targetId, maxAttempts = 10, attempt = 0) {
    const targetElement = document.getElementById(targetId);
    if (targetElement) {
        console.log(`✅ Target ID "${targetId}" found! Scrolling...`);
        setTimeout(() => {
            scrollElementIntoMainContent(targetElement, 50);
        }, 150);
        return;
    }

    if (attempt >= maxAttempts) {
        console.warn(`❌ Gave up waiting for "${targetId}".`);
        return;
    }

    setTimeout(() => waitForElementAndScroll(targetId, maxAttempts, attempt + 1), 200);
}






// Utility: Find the line number of a unique `id` in the Markdown
    // Improved function to find an ID in the raw Markdown
   function findLineForCustomId(targetId) {
      // Iterate over all chunks and their blocks
      for (let chunk of window.nodeChunks) {
        for (let block of chunk.blocks) {
          // You can choose how to detect the custom ID.
          // For instance, if your block.content (or a rendered version) already includes
          // literal HTML tags with id="targetId", you could use a regex:
          const regex = new RegExp(`id=['"]${targetId}['"]`, "i");
          if (regex.test(block.content)) {
            // Return the start line for this block as the line number
            return block.startLine;
          }
        }
      }
      return null;
    }

function navigateToInternalId(targetId) {
  // Prevent duplicate navigation actions.
  if (window.isNavigatingToInternalId) {
    console.log("Navigation already in progress, skipping duplicate call.");
    return;
  }
  window.isNavigatingToInternalId = true;
  console.log(`🟢 Navigating to internal ID: ${targetId}`);

  // First, check if the target element is already in the DOM.
  let existingElement = document.getElementById(targetId);
  if (existingElement) {
    console.log(`✅ Target ID ${targetId} already in DOM. Scrolling now...`);
    // Perform a single scroll action.
    scrollElementIntoMainContent(existingElement, 50);
    // After a short delay, reapply the scroll once more to counter any layout shifts.
    setTimeout(() => {
      scrollElementIntoMainContent(existingElement, 50);
      window.isNavigatingToInternalId = false;
    }, 600);
    return;
  }

  // If the target element is not yet in the DOM, determine which chunk it is in.
  let targetChunkIndex;
  if (isNumericId(targetId)) {
    // Numeric IDs: Assume the block's startLine is used as the ID.
    targetChunkIndex = window.nodeChunks.findIndex(chunk =>
      chunk.blocks.some(block => block.startLine.toString() === targetId)
    );
  } else {
    // For non-numeric IDs, try to find the block by scanning the raw Markdown.
    let targetLine = findLineForCustomId(targetId);
    if (targetLine === null) {
      console.warn(`❌ No block found for target ID "${targetId}" in nodeChunks.`);
      window.isNavigatingToInternalId = false;
      return;
    }
    console.log(`Non-numeric ID detected. Found at line: ${targetLine}`);
    targetChunkIndex = window.nodeChunks.findIndex(chunk =>
      targetLine >= chunk.start_line && targetLine <= chunk.end_line
    );
  }
  if (targetChunkIndex === -1) {
    console.warn(`❌ No chunk found for target ID "${targetId}".`);
    window.isNavigatingToInternalId = false;
    return;
  }

  // Load the contiguous block: one chunk before, the target chunk, and one chunk after.
  const startIndex = Math.max(0, targetChunkIndex - 1);
  const endIndex = Math.min(window.nodeChunks.length - 1, targetChunkIndex + 1);
  const chunksToLoad = window.nodeChunks.slice(startIndex, endIndex + 1);
  console.log(`✅ Internal link block determined. Loading chunks: ${chunksToLoad.map(c => c.chunk_id)}`);

  // Load any missing chunks.
  chunksToLoad.forEach(chunk => {
    if (!document.querySelector(`[data-chunk-id="${chunk.chunk_id}"]`)) {
      console.log(`🔄 Loading missing chunk ${chunk.chunk_id} for contiguous block`);
      loadChunk(chunk.chunk_id, "down");
    }
  });

  repositionFixedSentinelsForBlock();

  // Wait until lazy-loading and any layout shifts settle before performing the final scroll.
  setTimeout(() => {
    // Now that the necessary chunks should be loaded, wait for the target element.
    waitForElementAndScroll(targetId);
    // Optionally, do one final scroll after a short delay to ensure final alignment.
    setTimeout(() => {
      let finalTarget = document.getElementById(targetId);
      if (finalTarget) {
        scrollElementIntoMainContent(finalTarget, 50);
      }
      window.isNavigatingToInternalId = false;
    }, 400);
  }, 800);
}






// SENTINEL SHIT FOR INTERNAL ID NAVIGATION // 

/**
 * Removes all loaded chunks whose data-chunk-id is not in the allowedIds array.
 */
function removeChunksOutside(allowedIds) {
  const mainContentDiv = document.getElementById("main-content");
  const allChunks = mainContentDiv.querySelectorAll("[data-chunk-id]");
  allChunks.forEach(chunk => {
    const chunkId = parseInt(chunk.getAttribute("data-chunk-id"), 10);
    if (!allowedIds.includes(chunkId)) {
      console.log(`Removing chunk ${chunkId} as it is outside the new block.`);
      chunk.remove();
      // Also remove the chunk from your tracking set, if needed:
      window.currentlyLoadedChunks.delete(chunkId);
    }
  });
}


/**
 * Repositions the fixed top and bottom sentinels so that they wrap
 * exactly the new contiguous block of chunks.
 */
function repositionFixedSentinelsForBlock() {
  const mainContentDiv = document.getElementById("main-content");
  const allChunks = mainContentDiv.querySelectorAll("[data-chunk-id]");
  if (allChunks.length === 0) {
    console.warn("No chunks in the DOM to reposition sentinels around.");
    return;
  }
  // Assume chunks are in order.
  const firstChunk = allChunks[0];
  const lastChunk = allChunks[allChunks.length - 1];

  // Remove the fixed sentinels if they exist.
  if (window.topSentinel) window.topSentinel.remove();
  if (window.bottomSentinel) window.bottomSentinel.remove();

  // Create or reuse fixed sentinels.
  let topSentinel = document.getElementById("top-sentinel") || document.createElement("div");
  topSentinel.id = "top-sentinel";
  topSentinel.className = "sentinel";

  let bottomSentinel = document.getElementById("bottom-sentinel") || document.createElement("div");
  bottomSentinel.id = "bottom-sentinel";
  bottomSentinel.className = "sentinel";

  // Insert the top sentinel immediately before the first chunk.
  mainContentDiv.insertBefore(topSentinel, firstChunk);
  // Insert the bottom sentinel immediately after the last chunk.
  lastChunk.after(bottomSentinel);

  // Save the references for your IntersectionObserver.
  window.topSentinel = topSentinel;
  window.bottomSentinel = bottomSentinel;

  // (If you’re using an observer that watches these, you may need to reobserve them.)
  if (window.fixedSentinelObserver) {
    window.fixedSentinelObserver.observe(topSentinel);
    window.fixedSentinelObserver.observe(bottomSentinel);
  }
}



    // Function to dynamically load content around a line number
   function loadContentAroundLine(lineNumber) {
    console.log(`🟢 Loading content around line: ${lineNumber}`);

    // 🔍 Find the chunk that contains this line
    const targetChunk = window.nodeChunks.find(chunk =>
        lineNumber >= chunk.start_line && lineNumber <= chunk.end_line
    );

    if (!targetChunk) {
        console.warn(`❌ No chunk found for line ${lineNumber}.`);
        return;
    }

    console.log(`✅ Line ${lineNumber} is in chunk ${targetChunk.chunk_id}.`);

    // ✅ Load the target chunk if it's not already loaded
    if (!window.currentlyLoadedChunks.has(targetChunk.chunk_id)) {
        console.log(`🔄 Loading chunk ${targetChunk.chunk_id}...`);
        loadChunk(targetChunk.chunk_id, "down");
    }

    // 🔼 Check if we should load the previous chunk
    if (lineNumber - targetChunk.start_line < 5) {
        const prevChunk = window.nodeChunks.find(c => c.chunk_id === targetChunk.chunk_id - 1);
        if (prevChunk && !window.currentlyLoadedChunks.has(prevChunk.chunk_id)) {
            console.warn(`⬆️ Loading previous chunk(loadcontentaroundline): ${prevChunk.chunk_id}`);
            loadChunk(prevChunk.chunk_id, "up");
        }
    }

    // 🔽 Check if we should load the next chunk
    if (targetChunk.end_line - lineNumber < 5) {
        const nextChunk = window.nodeChunks.find(c => c.chunk_id === targetChunk.chunk_id + 1);
        if (nextChunk && !window.currentlyLoadedChunks.has(nextChunk.chunk_id)) {
            console.warn(`⬇️ Loading next chunk: ${nextChunk.chunk_id}`);
            loadChunk(nextChunk.chunk_id, "down");
        }
    }

    // ✅ Ensure content is loaded before scrolling
    setTimeout(() => {
        const targetElement = document.getElementById(lineNumber.toString());
        if (targetElement) {
            console.log(`✅ Scrolling to line: ${lineNumber}`);
            targetElement.scrollIntoView({ behavior: "smooth", block: "start" });
        } else {
            console.error(`❌ Line "${lineNumber}" still not found after loading.`);
        }
    }, 200); // Allow some time for lazy-loaded content
}




    function loadContentAroundId(targetId) {
    console.log(`🟢 Loading content around ID: ${targetId}`);

    const targetLine = findLineForId(markdownContent, targetId);
    if (targetLine === null) {
        console.warn(`❌ Target ID "${targetId}" not found in Markdown.`);
        return;
    }

    console.log(`✅ Found ID "${targetId}" at line ${targetLine}`);

    // ✅ Use the updated function to load content based on line number
    loadContentAroundLine(targetLine);

    // ✅ Ensure content is fully loaded before scrolling
    setTimeout(() => {
        const newTargetElement = document.getElementById(targetId);
        if (newTargetElement) {
            console.log(`✅ Scrolling to target ID: ${targetId}`);
            newTargetElement.scrollIntoView({ behavior: "smooth", block: "start" });
        } else {
            console.error(`❌ ID "${targetId}" still not found after loading.`);
        }
    }, 200); // Delay ensures content loads first
}



// WELLLLLLllllllllllllllllllllllllllllllllllllllllllllllllllllllllll
// WELLLLLLllllllllllllllllllllllllllllllllllllllllllllllllllllllllll
// WELLLLLLllllllllllllllllllllllllllllllllllllllllllllllllllllllllll
// WELLLLLLllllllllllllllllllllllllllllllllllllllllllllllllllllllllll
// WELLLLLLllllllllllllllllllllllllllllllllllllllllllllllllllllllllll
// WELLLLLLllllllllllllllllllllllllllllllllllllllllllllllllllllllllll
// WELLLLLLllllllllllllllllllllllllllllllllllllllllllllllllllllllllll


document.addEventListener("DOMContentLoaded", async () => {

    console.log("✅ DOM is ready. Loading Markdown file...");
    await loadMarkdownFile();  // ✅ This now runs in the same file where it's defined

     // lazy loading initial launch (I think)
     if (!markdownContent) {
        console.error("No Markdown content found in #main-content.");
        return;
    }

    // TOC table of contents 
    const tocContainer = document.getElementById("toc-container");
    const tocOverlay = document.getElementById("toc-overlay");
    const tocButton = document.getElementById("toc-toggle-button");

    // Check if elements exist
    if (!tocContainer || !tocOverlay || !tocButton) {
        console.error("TOC elements are missing in the DOM.");
        return;
    }

    // State to track if TOC is open
    let isTOCOpen = false;

    let currentRangeStart = 0;
    let currentRangeEnd = 0;
    let isLazyLoadSetup = false; // Flag to avoid duplicate setup

    // Ensure the `book` variable is available globally
    if (typeof window.book === "undefined" || !window.book) {
        console.error("The 'book' variable is not defined or empty.");
        return;
    }

    // Call the function to generate the TOC
    generateTableOfContents(jsonPath, "toc-container", "toc-toggle-button");

    function updateTOCState() {
        if (isTOCOpen) {
            console.log("Opening TOC...");
            tocContainer.classList.add("open");
            tocOverlay.classList.add("active");
        } else {
            console.log("Closing TOC...");
            tocContainer.classList.remove("open");
            tocOverlay.classList.remove("active");
        }
    }

    // Toggle TOC state when the button is clicked
    tocButton.addEventListener("click", function () {
        console.log("TOC button clicked");
        isTOCOpen = !isTOCOpen; // Toggle state
        updateTOCState();
    });

    // Close TOC when clicking the overlay
    tocOverlay.addEventListener("click", function () {
        if (isTOCOpen) {
            console.log("Closing TOC via overlay click");
            isTOCOpen = false;
            updateTOCState();
        }
    });

    // Close TOC when clicking a link inside it
    tocContainer.addEventListener("click", function (event) {
        const link = event.target.closest("a");
        if (link) {
            console.log("Closing TOC via link click");
            isTOCOpen = false;
            updateTOCState();

            // Scroll to target (optional)
            const targetId = link.hash?.substring(1); // Get ID without `#`
            const targetElement = document.getElementById(targetId);
            if (targetElement) {
                targetElement.scrollIntoView({ behavior: "smooth", block: "start" });
            }
        }
    });

    // Intercept internal links
    document.addEventListener("click", function (event) {
        const link = event.target.closest("a");
        if (link && link.hash && link.hash.startsWith("#")) {
            event.preventDefault(); // Prevent default anchor behavior
            const targetId = link.hash.substring(1); // Get the ID without the "#"
            navigateToInternalId(targetId);
        }
    });

     // Use event delegation for <mark> tags within #main-content
   
    if (mainContentDiv) {
        // Click delegation for <mark> elements
        mainContentDiv.addEventListener("click", function (event) {
            const mark = event.target.closest("mark");
            if (mark) {
                // Call your existing mark click handler
                event.preventDefault(); // Prevent default if needed
                handleMarkClick(event);
            }
        });
    
        // Mouseover delegation for <mark> elements
        mainContentDiv.addEventListener("mouseover", function (event) {
            const mark = event.target.closest("mark");
            if (mark) {
                handleMarkHover(event);
            }
        });
    
        // Mouseout delegation for <mark> elements
        mainContentDiv.addEventListener("mouseout", function (event) {
            const mark = event.target.closest("mark");
            if (mark) {
                handleMarkHoverOut(event);
            }
        });
    } else {
        console.error("No #main-content container found for attaching mark listeners.");
    }

       // Event listener for clicking on footnote `<sup>` elements
    document.addEventListener("click", (event) => {
        console.log("Click detected on element:", event.target); // Log the clicked element
        const noteElement = event.target.closest("sup.note");
        if (noteElement) {
            console.log("Footnote <sup> element detected:", noteElement); // Log the matched element
            event.preventDefault();

            const noteKey = noteElement.dataset.noteKey;
            const parentId = noteElement.closest("[id]")?.id;

            console.log("Extracted noteKey:", noteKey); // Debugging extracted data
            console.log("Extracted parentId:", parentId); // Debugging extracted data

            if (!noteKey || !parentId) {
                console.warn("Missing note key or parent ID for the clicked footnote.");
                return;
            }

            fetch(jsonPath)
                .then((response) => response.json())
                .then((footnotesData) => {
                    console.log("Fetched footnotes data:", footnotesData); // Debugging output
                    const section = footnotesData.find((sec) => {
                        return Object.values(sec.footnotes || {}).some(
                            (fn) => fn.line_number.toString() === parentId && fn.content
                        );
                    });

                    console.log("Matched section:", section);

                    if (!section) {
                        console.warn(`No matching section found for line ${parentId}.`);
                        return;
                    }

                    const footnote = section.footnotes[noteKey];
                    if (!footnote || footnote.line_number.toString() !== parentId) {
                        console.warn(`Footnote [${noteKey}] not found at line ${parentId}.`);
                        return;
                    }

                    console.log("Footnote content before conversion:", footnote.content);

                    // Convert Markdown to HTML directly here
                    const footnoteHtml = convertMarkdownToHtml(footnote.content);
                    console.log("Converted HTML:", footnoteHtml);

                    // Open the container with the converted content
                    openReferenceContainer(`<div class="footnote-content">${footnoteHtml}</div>`);
                })
                .catch((error) => {
                    console.error("Error fetching footnotes JSON:", error);
                });
        } else {
            console.log("No <sup.note> element detected for this click."); // Log for non-matching elements
        }
    });

    // Close the footnotes container when clicking the overlay
    refOverlay.addEventListener("click", () => {
        if (isRefOpen) {
            console.log("Closing footnotes container via overlay click...");
            closeReferenceContainer();
        }
    });

    handleNavigation();
});
