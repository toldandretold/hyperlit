    // footnotes buttons
    const refContainer = document.getElementById("ref-container");
    const refOverlay = document.getElementById("ref-overlay");
    let isRefOpen = false;

    // varaibles for lazy loading up and down:
    let lowestAddedBlock = null;  // ✅ The lowest block that has been added to the DOM
    let highestAddedBlock = null; // ✅ The highest block that has been added to the DOM
    let currentVisibleBlock = null; // ✅ The block the user is currently scrolling within
    window.currentlyLoadedBlocks = new Set(); // Stores loaded block indexes
    let disableLazyLoading = false;


async function loadMarkdownFile() {
    try {
        const response = await fetch(mdFilePath);
        if (!response.ok) throw new Error(`Failed to load Markdown: ${response.statusText}`);
        
        window.markdownContent = await response.text(); // Assign Markdown content globally

        // Now that we have the Markdown, initialize everything
        initializePage();
    } catch (error) {
    }
}

// Function to initialize the page after Markdown is loaded
function initializePage() {
    if (!window.markdownContent) {
        return;
    }


    if (!mainContentDiv) {
        return;
    }

    mainContentDiv.innerHTML = "";  

    window.allBlocks = parseMarkdownIntoBlocks(window.markdownContent);
    if (!window.allBlocks || window.allBlocks.length === 0) {
        return;
    }

    window.renderedBlocks = window.allBlocks.map(block => renderBlockToHtml(block));
    if (!window.renderedBlocks || window.renderedBlocks.length === 0) {
        return;
    }

    // ✅ Load initial content range
    lowestAddedBlock = 0;  // 🔥 Ensure the lowest added block is set
    highestAddedBlock = Math.min(20, window.allBlocks.length);
    
    loadBlockRange(0, highestAddedBlock, true, "down");

    // ✅ Setup lazy loading
    mainContentDiv.addEventListener("scroll", onScroll);

    // ✅ Handle URL navigation (e.g., `#some-id`)
    handleNavigation();
}




function parseMarkdownIntoBlocks(markdown) {

    const lines = markdown.split("\n");
    const blocks = [];
    let currentBlock = null;

    
    function pushCurrentBlock() {
        if (currentBlock) {
            blocks.push(currentBlock);
            currentBlock = null;
        }
    }

    for (let i = 0; i < lines.length; i++) {
        const rawLine = lines[i];
        const trimmed = rawLine.trim();

        // ✅ Make sure the first block starts at line 1
        const adjustedLineNumber = i + 1; 


        // Detect a heading
        if (trimmed.match(/^#{1,5}\s/)) {
            // Close previous block
            pushCurrentBlock();

            // Count how many # signs
            const match = trimmed.match(/^(#{1,5})\s/);
            const level = match ? match[1].length : 1;

            // Start new block for this heading
            currentBlock = {
                type: "heading",
                level: level,
                startLine: adjustedLineNumber,
                lines: [rawLine],
            };
            // Immediately push and reset (since headings are usually single lines)
            pushCurrentBlock();
            continue;
        }

        // Detect blockquote line
        if (trimmed.startsWith(">")) {
            // If currentBlock is NOT a blockquote, push and start a new blockquote
            if (!currentBlock || currentBlock.type !== "blockquote") {
                pushCurrentBlock();
                currentBlock = {
                    type: "blockquote",
                    startLine: adjustedLineNumber,
                    lines: [],
                };
            }
            // Add this line to the blockquote lines
            currentBlock.lines.push(rawLine);
            continue;
        }

        // Detect image
        if (trimmed.match(/^!\[.*\]\(.*\)$/)) {
            // Close out the current block
            pushCurrentBlock();

            // Start a new "image" block
            currentBlock = {
                type: "image",
                startLine: adjustedLineNumber,
                lines: [rawLine],
            };
            // Push immediately (only one line)
            pushCurrentBlock();
            continue;
        }

        // Otherwise, it's a normal paragraph or blank line
        if (!trimmed) {
            // Blank line => close out any existing block
            pushCurrentBlock();
        } else {
            // Normal text => paragraph line
            if (!currentBlock || currentBlock.type !== "paragraph") {
                // Start a new paragraph
                pushCurrentBlock();
                currentBlock = {
                    type: "paragraph",
                    startLine: adjustedLineNumber,
                    lines: [],
                };
            }
            currentBlock.lines.push(rawLine);
        }
    }

    // Push whatever is left
    pushCurrentBlock();

    return blocks;
}

function renderBlockToHtml(block) {
    let html = "";

    if (block.type === "heading") {
        let rawLine = block.lines[0].replace(/^\uFEFF/, "").trim();
        let headingText = rawLine.replace(/^#+\s*/, "");
        let headingTag = `h${block.level}`;
        html += `<${headingTag} id="${block.startLine}" data-block-id="${block.startLine}">${parseInlineMarkdown(headingText)}</${headingTag}>\n`;
    }
    else if (block.type === "blockquote") {
        html += `<blockquote data-block-id="${block.startLine}">`;
        block.lines.forEach((rawLine, idx) => {
            const lineId = block.startLine + idx;
            const innerText = rawLine.replace(/^>\s?/, "").trim();
            html += `<p id="${lineId}" data-block-id="${lineId}">${parseInlineMarkdown(innerText)}</p>`;
        });
        html += `</blockquote>\n`;
    }
    else if (block.type === "image") {
        const rawLine = block.lines[0];
        const match = rawLine.match(/^!\[(.*)\]\((.*)\)$/);
        if (match) {
            const altText = match[1];
            const imageUrl = match[2];
            html += `<img id="${block.startLine}" data-block-id="${block.startLine}" src="${imageUrl}" alt="${altText}" />\n`;
        }
    }
    else if (block.type === "paragraph") {
        // ✅ Ensure both the wrapper <div> and each <p> inside get `data-block-id`
        html += `<div data-block-id="${block.startLine}">`;
        block.lines.forEach((rawLine, idx) => {
            const lineId = block.startLine + idx;
            const innerText = rawLine.trim();
            if (innerText) {
                html += `<p id="${lineId}" data-block-id="${lineId}">${parseInlineMarkdown(innerText)}</p>\n`;
            }
        });
        html += `</div>\n`;
    }

    return html;
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




// Function to generate and display the Table of Contents
async function generateTableOfContents(jsonPath, tocContainerId, toggleButtonId) {
    try {
        const response = await fetch(jsonPath);
        const sections = await response.json();

        const tocContainer = document.getElementById(tocContainerId);
        if (!tocContainer) {
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

                    // Create the heading element dynamically
                    const headingElement = document.createElement(headingLevel); // e.g., <h1>, <h2>
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
    }
}


const processedChunks = new Set();



// STEP 1: Parse entire MD into blocks
    window.allBlocks = parseMarkdownIntoBlocks(markdownContent);
    


function onScroll() {
    if (disableLazyLoading) {
        return;
    }

    const scrollTop = mainContentDiv.scrollTop;
    const scrollHeight = mainContentDiv.scrollHeight;
    const clientHeight = mainContentDiv.clientHeight;


    // 🔍 **Get real existing blocks in the DOM**
    const existingBlocks = new Set([...document.querySelectorAll("[data-block-id]")].map(el => parseInt(el.getAttribute("data-block-id"), 10)));

    // 🔽 Scroll Down: Find the next real block ID
    if (scrollTop + clientHeight >= scrollHeight - 500) {

        // Find the next block in `window.allBlocks`
        const nextBlockIndex = window.allBlocks.findIndex(b => b.startLine > highestAddedBlock);

        if (nextBlockIndex !== -1) {
            const nextBlock = window.allBlocks[nextBlockIndex];
            loadBlockRange(nextBlock.startLine, nextBlock.startLine + 10, false, "down");
        }
    }

    // 🔼 Scroll Up: Find the previous real block ID
    if (scrollTop < 500) {

        // Find the last loaded block before `lowestAddedBlock`
        const prevBlockIndex = [...window.allBlocks].reverse().findIndex(b => b.startLine < lowestAddedBlock);

        if (prevBlockIndex !== -1) {
            const prevBlock = window.allBlocks[prevBlockIndex];
            loadBlockRange(prevBlock.startLine, prevBlock.startLine + 1, false, "up");
        }
    }

    // 🔍 Detect the currently visible block, but only pick real blocks
    const newVisibleBlock = findCurrentVisibleBlock();
    if (newVisibleBlock !== currentVisibleBlock || currentVisibleBlock === null) {
        currentVisibleBlock = newVisibleBlock;
    } else {
    }

    // 🔍 **Check for missing blocks, but only log real expected blocks**
    for (let i of currentlyLoadedBlocks) {
        if (!existingBlocks.has(i) && currentlyLoadedBlocks.has(i)) {
        }
    }
}







// ✅ Find the block currently in view
function findCurrentVisibleBlock() {
    const elements = [...document.querySelectorAll("[data-block-id]")]; // Get all loaded blocks
    let closestBlock = null;
    let closestDistance = Infinity;


    for (let el of elements) {
        const rect = el.getBoundingClientRect();
        const blockId = parseInt(el.getAttribute("data-block-id"), 10);

        if (!isNaN(blockId)) {
            // Check if block is fully within the viewport
            if (rect.top >= 0 && rect.bottom <= window.innerHeight) {
                return blockId; // Immediate return if fully visible
            }

            // Otherwise, find the closest block to the top of the viewport
            let distanceToViewport = Math.abs(rect.top);
            if (distanceToViewport < closestDistance) {
                closestDistance = distanceToViewport;
                closestBlock = blockId;
            }
        }
    }

    return closestBlock ?? highestAddedBlock ?? lowestAddedBlock ?? 0;
}








// ✅ Ensure blocks are added in the correct order
function loadBlockRange(startIndex, endIndex, isInitial = false, direction = "down") {

    if (!window.renderedBlocks || window.renderedBlocks.length === 0) {
        return;
    }

    // 🔍 Filter to only blocks that are truly missing
    const existingBlocks = new Set(
        [...document.querySelectorAll("[data-block-id]")].map(el => parseInt(el.getAttribute("data-block-id")))
    );


    const missingBlocks = [];

    for (let i = startIndex; i < endIndex; i++) {
        if (!existingBlocks.has(i)) {
            missingBlocks.push(i);
        }
    }

    if (missingBlocks.length === 0) {
        return;
    }


    const sliceHtml = missingBlocks.map(i => window.renderedBlocks[i]).join("\n");
    if (!sliceHtml.trim()) {
        return;
    }

    const tempDiv = document.createElement("div");
    tempDiv.innerHTML = sliceHtml;

    if (tempDiv.children.length === 0) {
        return;
    }


    if (direction === "up") {
        mainContentDiv.insertBefore(tempDiv, mainContentDiv.firstChild);
        lowestAddedBlock = Math.min(lowestAddedBlock, missingBlocks[0]);
    } else {
        mainContentDiv.appendChild(tempDiv);
        highestAddedBlock = Math.max(highestAddedBlock, missingBlocks[missingBlocks.length - 1]);
    }

    // ✅ Track loaded blocks
    missingBlocks.forEach(i => currentlyLoadedBlocks.add(i));

}



















     // [:FOOTNOTES]

       function injectFootnotesForRange(startLine, endLine, jsonPath) {
            fetch(jsonPath)
                .then((response) => response.json())
                .then((sections) => {
                    sections.forEach((section) => {
                        if (section.footnotes) {
                            Object.entries(section.footnotes).forEach(([key, footnote]) => {
                                const { line_number, content } = footnote;

                                // Process only footnotes within the given range
                                if (line_number >= startLine && line_number < endLine) {
                                    const targetElement = document.getElementById(line_number.toString());

                                    if (targetElement) {

                                        // Check if the content already contains <sup> elements
                                        if (targetElement.innerHTML.includes(`<sup class="note" data-note-key="${key}">`)) {
                                            return;
                                        }

                                        const regex = new RegExp(`\\[\\^${key}\\](?!:)`, "g");

                                        // Check if the Markdown footnote exists in the content
                                        if (regex.test(targetElement.innerHTML)) {

                                            // Convert Markdown content to HTML
                                            const footnoteHtml = content ? convertMarkdownToHtml(content) : "";

                                            // Replace Markdown reference `[ ^key ]` with the `<sup>` element
                                            targetElement.innerHTML = targetElement.innerHTML.replace(
                                                regex,
                                                `<sup class="note" data-note-key="${key}">[^${key}]</sup>`
                                            );

                                        } else {
                                        }
                                    } else {
                                    }
                                }
                            });
                        }
                    });
                })
                .catch((error) => {
                });
        }


         // Function to update the footnotes container state
        function updateRefState() {
            if (isRefOpen) {
                refContainer.classList.add("open");
                refOverlay.classList.add("active");
            } else {
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
                return null;
            }
        }

        // Function to open the footnotes container with content
        function openReferenceContainer(content) {
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


            async function displayFootnote(noteElement) {
                const noteKey = noteElement.dataset.noteKey;
                const parentId = noteElement.closest("[id]")?.id;



                if (!noteKey || !parentId) {
                    return;
                }

                const footnotesData = await fetchFootnotes();
                if (!footnotesData) {
                    return;
                }


                // Locate the correct section and footnote
                const section = footnotesData.find((sec) =>
                    Object.values(sec.footnotes || {}).some(
                        (footnote) => footnote.line_number.toString() === parentId && footnote.content
                    )
                );


                if (!section) {
                    return;
                }

                const footnote = section.footnotes[noteKey];

                if (!footnote || footnote.line_number.toString() !== parentId) {
                    return;
                }

                // Convert the Markdown content to HTML
                const footnoteHtml = convertMarkdownToHtml(footnote.content);

                // Display the content in the reference container
                openReferenceContainer(`<div class="footnote-content">${footnoteHtml}</div>`);
            }


    // Handle navigation to specific ID or position
    function handleNavigation() {
        // 1) Extract #hash from the URL (e.g. "#145" or "#some-heading")
        const targetId = getTargetIdFromUrl();

        if (!targetId) {
            return;
        }


        // **First attempt: Check if the target ID already exists in the DOM**
        const existingElement = document.getElementById(targetId);
        if (existingElement) {
            existingElement.scrollIntoView({ behavior: "smooth", block: "start" });
            return;
        }


        let finalLineNumber = null;

        // If numeric, use as a line number. Otherwise, find corresponding line in Markdown.
        if (isNumericId(targetId)) {
            finalLineNumber = parseInt(targetId, 10);
        } else {
            const lineFromId = findLineForId(markdownContent, targetId);
            if (lineFromId !== null) {
                finalLineNumber = lineFromId;
            } else {
            }
        }

        // Fallback if the ID is completely missing
        if (finalLineNumber === null) {
            finalLineNumber = 1;
        }

        // ✅ Find which block contains the target line
        const blockIndex = findBlockForLine(finalLineNumber, allBlocks);
        if (blockIndex === -1) {
            return;
        }

        // ✅ Load extra content around the target block to prevent lazy-loading interference
        const extraAbove = 10;  // Load more blocks above
        const extraBelow = 15;  // Load more blocks below
        const startIndex = Math.max(0, blockIndex - extraAbove);
        const endIndex = Math.min(allBlocks.length, blockIndex + extraBelow);

        loadBlockRange(startIndex, endIndex, true, "down");

        // ✅ Ensure content is fully loaded before scrolling
        setTimeout(() => {
            const targetElement = document.getElementById(targetId);
            if (targetElement) {
                targetElement.scrollIntoView({ behavior: "smooth", block: "start" });
            } else {
            }
        }, 500); // Allow blocks to load before scrolling
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

    // Utility: Find the line number of a unique `id` in the Markdown
    // Improved function to find an ID in the raw Markdown
    function findLineForId(markdown, id) {
        
        const regex = new RegExp(`id=['"]${id}['"]`, "i"); // Match both single & double quotes
        const lines = markdown.split("\n");

        for (let i = 0; i < lines.length; i++) {
            if (regex.test(lines[i])) {
                return i + 1; // Return the exact line number
            }
        }

        return null;
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

    function waitForElementAndScroll(targetId, maxAttempts = 20, attempt = 0) {
        const targetElement = document.getElementById(targetId);

        if (targetElement) {
            targetElement.scrollIntoView({ behavior: "smooth", block: "start" });
            return;
        }

        if (attempt >= maxAttempts) {
            return;
        }


        setTimeout(() => waitForElementAndScroll(targetId, maxAttempts, attempt + 1), 100);
    }


    // Function to handle navigation to internal links
    function navigateToInternalId(targetId) {

        let finalLineNumber = null;

        if (isNumericId(targetId)) {
            finalLineNumber = parseInt(targetId, 10);
        } else {
            const lineFromId = findLineForId(markdownContent, targetId);
            if (lineFromId !== null) {
                finalLineNumber = lineFromId;
            } else {
            }
        }

        if (finalLineNumber === null) {
            finalLineNumber = 1;
        }

        // Find block containing the target line
        const blockIndex = findBlockForLine(finalLineNumber, allBlocks);
        if (blockIndex === -1) {
            return;
        }


        // ✅ Load more content **before** scrolling to prevent lazy loading from triggering
        const extraAbove = 10;
        const extraBelow = 15;
        const startIndex = Math.max(0, blockIndex - extraAbove);
        const endIndex = Math.min(allBlocks.length, blockIndex + extraBelow);

        loadBlockRange(startIndex, endIndex, true, "down");

        // ✅ Ensure content is fully loaded before scrolling
        waitForElementAndScroll(targetId);
    }


    // Function to dynamically load content around a line number
    function loadContentAroundLine(lineNumber) {
        const totalLines = markdownContent.split("\n").length;
        const bufferSize = 50; // Buffer size for adjacent content
        const startLine = Math.max(0, lineNumber - bufferSize);
        const endLine = Math.min(totalLines, lineNumber + bufferSize);


        processRange(startLine, endLine, false, "downward");

        // Update global range
        currentRangeStart = Math.min(currentRangeStart, startLine);
        currentRangeEnd = Math.max(currentRangeEnd, endLine);

        setTimeout(() => {
            const targetElement = document.getElementById(lineNumber.toString());
            if (targetElement) {
                targetElement.scrollIntoView({ behavior: "smooth", block: "start" });
            } else {
            }
        }, 100);
    }



    // Function to dynamically load content around a target ID
    function loadContentAroundId(targetId) {
        const targetLine = findLineForId(markdownContent, targetId);
        if (targetLine === null) {
            return;
        }

        const totalLines = markdownContent.split("\n").length;
        const startLine = Math.max(0, targetLine - 50); // Load 50 lines before the target
        const endLine = Math.min(totalLines, targetLine + 50); // Load 50 lines after the target

        processRange(startLine, endLine, false, "downward");

        setTimeout(() => {
            const newTargetElement = document.getElementById(targetId);
            if (newTargetElement) {
                newTargetElement.scrollIntoView({ behavior: "smooth", block: "start" });
            } else {
            }
        }, 100);
    }

    // Utility to determine if a string is numeric
    function isNumericId(id) {
        return /^\d+$/.test(id);
    }

    // Utility to get the target ID from the URL
    function getTargetIdFromUrl() {
        return window.location.hash ? window.location.hash.substring(1) : null;
    }


document.addEventListener("DOMContentLoaded", async () => {

    await loadMarkdownFile();  // ✅ This now runs in the same file where it's defined

     // lazy loading initial launch (I think)
     if (!markdownContent) {
        return;
    }


    mainContentDiv.addEventListener("scroll", onScroll);

    // TOC table of contents 
    const tocContainer = document.getElementById("toc-container");
    const tocOverlay = document.getElementById("toc-overlay");
    const tocButton = document.getElementById("toc-toggle-button");

    // Check if elements exist
    if (!tocContainer || !tocOverlay || !tocButton) {
        return;
    }

    // State to track if TOC is open
    let isTOCOpen = false;

    let currentRangeStart = 0;
    let currentRangeEnd = 0;
    let isLazyLoadSetup = false; // Flag to avoid duplicate setup

    // Ensure the `book` variable is available globally
    if (typeof window.book === "undefined" || !window.book) {
        return;
    }

    // Call the function to generate the TOC
    generateTableOfContents(jsonPath, "toc-container", "toc-toggle-button");

    function updateTOCState() {
        if (isTOCOpen) {
            tocContainer.classList.add("open");
            tocOverlay.classList.add("active");
        } else {
            tocContainer.classList.remove("open");
            tocOverlay.classList.remove("active");
        }
    }

    // Toggle TOC state when the button is clicked
    tocButton.addEventListener("click", function () {
        isTOCOpen = !isTOCOpen; // Toggle state
        updateTOCState();
    });

    // Close TOC when clicking the overlay
    tocOverlay.addEventListener("click", function () {
        if (isTOCOpen) {
            isTOCOpen = false;
            updateTOCState();
        }
    });

    // Close TOC when clicking a link inside it
    tocContainer.addEventListener("click", function (event) {
        const link = event.target.closest("a");
        if (link) {
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

       // Event listener for clicking on footnote `<sup>` elements
    document.addEventListener("click", (event) => {
        if (noteElement) {

            const noteKey = noteElement.dataset.noteKey;
            const parentId = noteElement.closest("[id]")?.id;

                return;
            }

            fetch(jsonPath)
                .then((response) => response.json())
                .then((footnotesData) => {
                    });


                    if (!section) {
                        return;
                    }

                    const footnote = section.footnotes[noteKey];
                    if (!footnote || footnote.line_number.toString() !== parentId) {
                        return;
                    }


                    // Convert Markdown to HTML directly here
                    const footnoteHtml = convertMarkdownToHtml(footnote.content);

                    // Open the container with the converted content
                    openReferenceContainer(`<div class="footnote-content">${footnoteHtml}</div>`);
                })
                .catch((error) => {
                });
        } else {

    // Close the footnotes container when clicking the overlay
    refOverlay.addEventListener("click", () => {
        if (isRefOpen) {
            closeReferenceContainer();
        }
    });

    handleNavigation()
});
