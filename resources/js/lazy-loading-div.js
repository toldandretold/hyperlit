
let insertedLetters = {}; // Track lettered inserts for each base ID


// Function to convert Markdown to HTML with IDs and inline parsing
function convertMarkdownToHtmlWithIds(markdown, offset = 0) {
    const lines = markdown.split("\n"); // Split Markdown into lines
    let htmlOutput = "";
    let insideBlockquote = false;
    let currentBlockquote = "";
    let blockquoteOffset = 0; // Counter for assigning unique IDs within a blockquote

    lines.forEach((line, index) => {
        const trimmedLine = line.trim();

        // Skip lines that are completely empty (no content, no `>`) unless inside a blockquote
        if (!trimmedLine && !insideBlockquote) return;

        const absoluteIndex = index + offset; // Add the offset to get the correct ID

        // Handle block-level Markdown elements
        if (trimmedLine.startsWith("# ")) {
            // Close blockquote if needed
            if (insideBlockquote) {
                htmlOutput += currentBlockquote + "</blockquote>\n";
                insideBlockquote = false;
                currentBlockquote = "";
                blockquoteOffset = 0; // Reset blockquote counter
            }
            htmlOutput += `<h1 id="${absoluteIndex}">${parseInlineMarkdown(trimmedLine.replace(/^# /, ""))}</h1>\n`;
        } else if (trimmedLine.startsWith("## ")) {
            if (insideBlockquote) {
                htmlOutput += currentBlockquote + "</blockquote>\n";
                insideBlockquote = false;
                currentBlockquote = "";
                blockquoteOffset = 0;
            }
            htmlOutput += `<h2 id="${absoluteIndex}">${parseInlineMarkdown(trimmedLine.replace(/^## /, ""))}</h2>\n`;
        } else if (trimmedLine.startsWith("### ")) {
            if (insideBlockquote) {
                htmlOutput += currentBlockquote + "</blockquote>\n";
                insideBlockquote = false;
                currentBlockquote = "";
                blockquoteOffset = 0;
            }
            htmlOutput += `<h3 id="${absoluteIndex}">${parseInlineMarkdown(trimmedLine.replace(/^### /, ""))}</h3>\n`;
        } else if (trimmedLine.startsWith(">")) {
            // Start a new blockquote if not already inside one
            if (!insideBlockquote) {
                insideBlockquote = true;
                currentBlockquote = `<blockquote id="${absoluteIndex}">`;
                blockquoteOffset = 0; // Reset blockquote paragraph counter
            }
            // Check for blank blockquote line (`>` or `> `)
            if (trimmedLine === ">" || trimmedLine === "> ") {
                currentBlockquote += `<p id="${absoluteIndex}_${blockquoteOffset}"></p>`;
                blockquoteOffset++; // Increment blockquote paragraph counter
            } else {
                // Add the current line to the blockquote, wrapped in <p> tags
                currentBlockquote += `<p id="${absoluteIndex}_${blockquoteOffset}">${parseInlineMarkdown(trimmedLine.replace(/^> /, "").trim())}</p>`;
                blockquoteOffset++; // Increment blockquote paragraph counter
            }
        } else {
            // Close the blockquote when encountering a non-blockquote line
            if (insideBlockquote) {
                htmlOutput += currentBlockquote + "</blockquote>\n";
                insideBlockquote = false;
                currentBlockquote = "";
                blockquoteOffset = 0; // Reset blockquote counter
            }
            // Process the current non-blockquote line
            if (trimmedLine) {
                htmlOutput += `<p id="${absoluteIndex}">${parseInlineMarkdown(trimmedLine)}</p>\n`;
            }
        }
    });

    // Ensure any remaining open blockquote is closed at the end
    if (insideBlockquote) {
        htmlOutput += currentBlockquote + "</blockquote>\n";
        insideBlockquote = false;
    }

    return htmlOutput;
}




// Function to parse inline Markdown for italics, bold, and inline code
function parseInlineMarkdown(text) {
    text = text.replace(/\\([`*_{}\[\]()#+.!-])/g, "$1"); // Remove escape characters before processing
    text = text.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>"); // Convert **bold** to <strong>
    text = text.replace(/\*([^*]+)\*/g, "<em>$1</em>"); // Convert *italic* to <em>
    text = text.replace(/`([^`]+)`/g, "<code>$1</code>"); // Convert `code` to <code>
    return text;
}

// MutationObserver setup
const observedSections = new Set(); // Track observed sections to avoid duplicates
const modifiedNodes = new Set(); // Track modified nodes
const removedIds = new Set(); // Track IDs of removed nodes
const addedNodes = new Set(); // Track added nodes


function processRange(startLine, endLine, isInitial = false, direction = "downward") {
    const rangeKey = `${startLine}-${endLine}`;
    if (processedChunks.has(rangeKey)) {
        console.log(`Skipping already processed range: ${rangeKey}`);
        return false;
    }

    const lines = markdownContent.split("\n").slice(startLine, endLine);
    const chunk = lines.join("\n");
    const processedHtml = convertMarkdownToHtmlWithIds(chunk, startLine);

    if (!processedHtml) {
        console.error(`Failed to process lines ${startLine}-${endLine}.`);
        return false;
    }

    const wrapperDiv = document.createElement("div");
    wrapperDiv.classList.add("lazy-loaded-chunk");
    wrapperDiv.dataset.chunkRange = rangeKey;
    wrapperDiv.innerHTML = processedHtml;

    if (isInitial) {
        mainContentDiv.innerHTML = ""; // Clear initial raw Markdown content
    }

    if (direction === "upward") {
        mainContentDiv.insertBefore(wrapperDiv, mainContentDiv.firstChild);
    } else {
        mainContentDiv.appendChild(wrapperDiv);
    }

    processedChunks.add(rangeKey);

    // Attach observer explicitly
    observeSection(wrapperDiv);

    console.log(`Processed lines ${rangeKey}.`);
    return true;
}


// Function to adjust new nodes (convert <div> to <p> and assign ID)
// Function to adjust new nodes (convert <div> or <span> to <p> and assign ID)
function adjustNewNode(node, originalNodeContent) {
    // Check for span or div nodes without IDs
    if ((node.tagName === "DIV" || node.tagName === "SPAN") && !node.id) {
        console.log(`Detected new <${node.tagName.toLowerCase()}> node without ID. Evaluating if adjustment is necessary...`);

        // Detect if the <span> is part of a heading or block element
        const parentIsBlock = node.parentElement && ["P", "H1", "H2", "H3"].includes(node.parentElement.tagName);

        // Ignore inline spans (e.g., spans within a <p> or styled text)
        if (node.tagName === "SPAN" && !parentIsBlock) {
            console.log("Ignoring inline <span> node.");
            return;
        }

        // Convert <div> or block-level <span> to <p>
        const newP = document.createElement("p");
        newP.innerHTML = node.innerHTML;

        // Find the preceding node with an ID
        const allNodes = Array.from(mainContentDiv.querySelectorAll("*"));
        const nodeIndex = allNodes.indexOf(node);
        const precedingNode = findNearestNodeWithId(allNodes, nodeIndex - 1, -1);

        if (precedingNode && precedingNode.id) {
            const baseId = precedingNode.id.match(/^(\d+)/)?.[1];
            const siblingNodes = getSiblingNodesWithSameBaseId(allNodes, baseId);
            const nextLetter = getNextSequentialLetter(siblingNodes, baseId);
            newP.id = `${baseId}${nextLetter}`;
            console.log(`Assigned ID "${newP.id}" to new <p> node.`);
        } else {
            console.warn("No valid preceding node found. Assigning unique ID.");
            newP.id = generateUniqueId();
        }

        // Replace the <div> or block-level <span> with the new <p>
        node.parentNode.replaceChild(newP, node);

        // Track the new node as added
        addedNodes.add(newP);
        originalNodeContent.set(newP.id, newP.innerHTML);
    }
}


function generateUniqueId() {
    return `unique_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}


// Updated MutationObserver logic
function observeSection(wrapperDiv) {
    if (observedSections.has(wrapperDiv)) return;

    const originalNodeContent = new Map(); // Track original content of nodes by ID

    // Initialize tracking
    wrapperDiv.querySelectorAll("[id]").forEach((node) => {
        originalNodeContent.set(node.id, node.innerHTML);
    });

    const observer = new MutationObserver((mutations) => {
        const tempRemovedIds = new Set();

        mutations.forEach((mutation) => {
            if (mutation.type === "childList") {
                // Handle added nodes
                mutation.addedNodes.forEach((node) => {
                    if (node.nodeType === Node.ELEMENT_NODE) {
                        console.log(`Detected added node: ${node.tagName} with ID: ${node.id || "no ID yet"}`);

                        if (node.tagName === "P") {
                            console.log(`Added node: ${node.tagName} with ID: ${node.id || "no ID yet"}`);
                            adjustIdForNewNode(node); // Ensure new nodes get lettered IDs
                            addedNodes.add(node); // Track as added
                            originalNodeContent.set(node.id, node.innerHTML); // Cache its content
                        } else {
                            // Adjust new <div> nodes to <p> tags with IDs
                            adjustNewNode(node, originalNodeContent);
                        }
                    }
                });

                // Handle removed nodes
                mutation.removedNodes.forEach((node) => {
                    if (node.nodeType === Node.ELEMENT_NODE && node.id) {
                        console.log(`Removed node: ${node.tagName} with ID: ${node.id}`);
                        tempRemovedIds.add(node.id); // Track as temporarily removed
                    }
                });
            } else if (mutation.type === "characterData") {
                // Track text modifications
                const parent = mutation.target.parentElement;
                if (parent && parent.id) {
                    if (originalNodeContent.has(parent.id)) {
                        if (parent.innerHTML !== originalNodeContent.get(parent.id)) {
                            modifiedNodes.add(parent.id); // Mark as modified
                            console.log(`Text modified in node with ID: ${parent.id}`);
                        }
                    } else {
                        originalNodeContent.set(parent.id, parent.innerHTML); // Initialize cache
                    }
                }
            }
        });

        // Additional handling for pasted content
        tempRemovedIds.forEach((id) => {
            const removedNodeContent = originalNodeContent.get(id);
            const removedNode = document.getElementById(id);
            const parentElement = removedNode ? removedNode.parentElement : null;

            const nodeAtCursor = getNodeAtCursor();
            let mergedIntoNode = null;

            if (nodeAtCursor && nodeAtCursor.textContent.trim().includes(removedNodeContent?.trim())) {
                mergedIntoNode = nodeAtCursor; // Cursor detected merge
                console.log(`Merge detected via cursor: Node ID ${id} merged into ${nodeAtCursor.id}`);
            } else if (parentElement) {
                const siblings = Array.from(parentElement.children).filter((sibling) => sibling.id);
                mergedIntoNode = siblings.find((sibling) =>
                    sibling.textContent.trim().includes(removedNodeContent?.trim())
                );

                if (mergedIntoNode) {
                    console.log(`Merge detected via siblings: Node ID ${id} merged into ${mergedIntoNode.id}`);
                }
            }

            if (!mergedIntoNode) {
                console.log(`No merge detected: Node ID ${id} is marked as deleted.`);
                removedIds.add(id);
            } else {
                modifiedNodes.add(mergedIntoNode.id);
                removedIds.add(id);
            }

            originalNodeContent.delete(id);
        });

        // Log current states for debugging
        console.log("Current added nodes:", Array.from(addedNodes));
        console.log("Current modified nodes:", Array.from(modifiedNodes));
        console.log("Current removed IDs:", Array.from(tempRemovedIds));
    });

    observer.observe(wrapperDiv, {
        childList: true,
        subtree: true,
        characterData: true,
    });

    observedSections.add(wrapperDiv);
    console.log(`Attached MutationObserver to section.`);
}

    



function adjustIdForNewNode(node) {
    if (node.tagName !== "P") {
        console.warn(`Skipping ID adjustment for non-paragraph node: ${node.tagName}`);
        return;
    }


    console.log(`Adjusting ID for new or reassigned node: ${node.tagName} with current ID: ${node.id || "no ID"}`);

    const allNodes = Array.from(mainContentDiv.querySelectorAll("*")); // Include all nodes
    const nodeIndex = allNodes.indexOf(node);

    if (nodeIndex !== -1) {
        const precedingNode = findNearestNodeWithId(allNodes, nodeIndex - 1, -1);

        if (!precedingNode || !precedingNode.id) {
            console.warn("No valid preceding node found to determine base ID.");
            node.id = generateUniqueId();
            console.log(`Assigned unique ID to isolated node: ${node.id}`);
            return;
        }

        const baseId = precedingNode.id.match(/^(\d+)/)?.[1]; // Extract numerical base ID
        console.log(`Using preceding node's ID: ${precedingNode.id} for baseId: ${baseId}`);

        const siblingNodes = getSiblingNodesWithSameBaseId(allNodes, baseId);
        console.log(`Siblings with baseId ${baseId}:`, siblingNodes.map((n) => n.id));
        
        const nextLetter = getNextSequentialLetter(siblingNodes, baseId);

        node.id = `${baseId}${nextLetter}`;
        console.log(`Assigned new ID: ${node.id}`);
    } else {
        console.warn("Node not found in allNodes array.");
    }
}




function findNearestNodeWithId(nodes, startIndex, step) {
    for (let i = startIndex; i >= 0 && i < nodes.length; i += step) {
        if (nodes[i].id && /^\d+/.test(nodes[i].id)) {
            return nodes[i]; // Return the first valid preceding node with a numerical ID
        }
    }
    return null; // No valid preceding node found
}


// Function to get the node at the current cursor position
function getNodeAtCursor() {
    const selection = document.getSelection();
    if (selection.rangeCount > 0) {
        const range = selection.getRangeAt(0);
        const node = range.startContainer;

        // Return the closest parent node with an ID
        return node.nodeType === Node.ELEMENT_NODE
            ? node.closest("[id]")
            : node.parentElement?.closest("[id]");
    }
    return null;
}



function getSiblingNodesWithSameBaseId(nodes, baseId) {
    return nodes.filter((node) => {
        // Exclude heading tags while checking for siblings
        if (node.tagName.startsWith("H")) return false;

        return node.id && node.id.startsWith(baseId);
    });
}


function getNextSequentialLetter(siblingNodes, baseId) {
    const existingLetters = siblingNodes
        .map((node) => node.id.replace(baseId, "")) // Extract the suffix
        .filter((suffix) => /^[a-z]+$/.test(suffix)) // Include only letter suffixes
        .sort(); // Sort alphabetically

         console.log(`Base ID: ${baseId}, Existing letters: ${existingLetters}`);

    if (existingLetters.length === 0) {
        console.log(`Starting new sequence for baseId ${baseId} with "a"`);
        return "a"; // Start with 'a' if no suffix exists
    }

    const lastLetter = existingLetters[existingLetters.length - 1];
    const nextLetter = String.fromCharCode(lastLetter.charCodeAt(0) + 1);
    console.log(`Incrementing letter for baseId ${baseId}: ${lastLetter} -> ${nextLetter}`);
    return nextLetter; // Increment the last letter
}



function getNextLetter(baseId, isAbove = false) {
    // Initialize the tracking object for inserted letters if not already present
    if (!insertedLetters[baseId]) {
        insertedLetters[baseId] = isAbove ? "-a" : "a"; // Start with "-a" for above, "a" for below
    } else {
        let letter = insertedLetters[baseId];
        const isHyphenated = letter.startsWith("-");

        // Determine the current letter without the hyphen
        let currentLetter = isHyphenated ? letter.slice(1) : letter;

        // Increment the letter
        currentLetter = String.fromCharCode(currentLetter.charCodeAt(0) + 1);

        // Reapply the hyphen if necessary
        insertedLetters[baseId] = isAbove ? `-${currentLetter}` : currentLetter;
    }

    return insertedLetters[baseId];
}



document.addEventListener("DOMContentLoaded", function () {
    const mainContentDiv = document.getElementById("main-content");
    let markdownContent = mainContentDiv.textContent; // Raw Markdown content
    const chunkSize = 100; // Number of lines to process per chunk
    const processedChunks = new Set(); // Track processed chunks
    const lastVisitedKey = "last-visited-id"; // Key for session storage
    let currentRangeStart = 0;
    let currentRangeEnd = 0;
    let isLazyLoadSetup = false; // Flag to avoid duplicate setup

    if (!markdownContent) {
        console.error("No Markdown content found.");
        return;
    }

    console.log("Raw Markdown Content Loaded.");

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
    function findLineForId(markdown, id) {
        const lines = markdown.split("\n");
        for (let i = 0; i < lines.length; i++) {
            if (lines[i].includes(`id="${id}"`)) {
                return i; // Return the line number where the `id` is found
            }
        }
        return null; // Return null if the `id` is not found
    }

    // Utility: Process and render a range of Markdown lines
    function processRange(startLine, endLine, isInitial = false, direction = "downward") {
    const rangeKey = `${startLine}-${endLine}`;
    if (processedChunks.has(`${startLine}-${endLine}`)) {
        console.log(`Skipping already processed range: ${startLine}-${endLine}`);
        return false;
    }

    const lines = markdownContent.split("\n").slice(startLine, endLine);
    const chunk = lines.join("\n");
    const processedHtml = convertMarkdownToHtmlWithIds(chunk, startLine);

    if (!processedHtml) {
        console.error(`Failed to process lines ${startLine}-${endLine}.`);
        return false;
    }

    // Create a wrapper div for the lazy-loaded chunk
    const wrapperDiv = document.createElement("div");
    wrapperDiv.classList.add("lazy-loaded-chunk");
    wrapperDiv.dataset.chunkRange = rangeKey; // Optional: Track the range in a data attribute
    wrapperDiv.innerHTML = processedHtml;

    if (isInitial) {
        mainContentDiv.innerHTML = ""; // Clear raw Markdown content for the initial render
    }

    if (direction === "upward") {
        mainContentDiv.insertBefore(wrapperDiv, mainContentDiv.firstChild);
    } else {
        mainContentDiv.appendChild(wrapperDiv);
    }

    processedChunks.add(rangeKey);

    // Attach observer to the wrapper div
    observeSection(wrapperDiv);

    console.log(`Processed lines ${rangeKey}.`);
    return true;
}


    // Handle navigation to specific ID or position
    function handleNavigation() {
        const targetId = getTargetIdFromUrl();
        let targetLine = null;

        if (targetId) {
            console.log(`Navigating to target ID: ${targetId}`);
            if (isNumericId(targetId)) {
                targetLine = findLineForNumericId(parseInt(targetId, 10), markdownContent);
            } else {
                targetLine = findLineForId(markdownContent, targetId);
                if (targetLine === null) {
                    console.warn(`Target ID "${targetId}" not found in Markdown.`);
                }
            }
        }

        if (targetLine === null) {
            // Fallback to browser memory
            const lastVisitedId = sessionStorage.getItem(lastVisitedKey);
            if (lastVisitedId) {
                console.log(`Falling back to last visited ID: ${lastVisitedId}`);
                targetLine = isNumericId(lastVisitedId)
                    ? findLineForNumericId(parseInt(lastVisitedId, 10), markdownContent)
                    : findLineForId(markdownContent, lastVisitedId);
            }
        }

        if (targetLine === null) {
            console.log("No valid target ID. Defaulting to top of the page.");
            targetLine = 0;
        }

        const startLine = Math.max(0, targetLine - 50);
        const endLine = Math.min(markdownContent.split("\n").length, targetLine + 50);

        processRange(startLine, endLine, true, "downward");

        currentRangeStart = startLine;
        currentRangeEnd = endLine;

        setTimeout(() => {
            const targetElement = document.getElementById(targetId);
            if (targetElement) {
                targetElement.scrollIntoView({ block: "start" });
                console.log(`Scrolled to target ID: ${targetId}`);
            }
        }, 100);
    }

    // Lazy loading setup
    function setupLazyLoad() {
    if (isLazyLoadSetup) return;
    isLazyLoadSetup = true;

    let isScrolling = false;

    function lazyLoadOnScroll() {
        if (isScrolling) return;
        isScrolling = true;

        setTimeout(() => {
            const totalLines = markdownContent.split("\n").length;

            const scrollTop = mainContentDiv.scrollTop;
            const scrollHeight = mainContentDiv.scrollHeight;
            const clientHeight = mainContentDiv.clientHeight;

            // Lazy load upward
            if (scrollTop <= 100 && currentRangeStart > 0) {
                console.log("Lazy loading upward...");
                const newStart = Math.max(0, currentRangeStart - chunkSize);
                if (!processedChunks.has(`${newStart}-${currentRangeStart}`)) {
                    const previousHeight = mainContentDiv.scrollHeight; // Capture current height before prepending

                    processRange(newStart, currentRangeStart, false, "upward");

                    const newHeight = mainContentDiv.scrollHeight; // Calculate new height after prepending
                    const heightDifference = newHeight - previousHeight;

                    mainContentDiv.scrollTop += heightDifference; // Adjust scrollTop to maintain position
                    console.log({
                        previousHeight,
                        newHeight,
                        adjustedScrollTop: mainContentDiv.scrollTop,
                    });

                    currentRangeStart = newStart;
                }
            }

            // Lazy load downward
            if (scrollTop + clientHeight >= scrollHeight - 50 && currentRangeEnd < totalLines) {
                console.log("Lazy loading downward...");
                const newEnd = Math.min(totalLines, currentRangeEnd + chunkSize);
                if (!processedChunks.has(`${currentRangeEnd}-${newEnd}`)) {
                    processRange(currentRangeEnd, newEnd, false, "downward");
                    currentRangeEnd = newEnd;
                }
            }

            isScrolling = false;
        }, 100);
    }

    mainContentDiv.addEventListener("scroll", lazyLoadOnScroll);
    }


    // Track last visible ID for refresh
    window.addEventListener("scroll", () => {
        const elementInView = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2);
        if (elementInView && elementInView.id) {
            sessionStorage.setItem(lastVisitedKey, elementInView.id);
            console.log(`Updated last visited ID: ${elementInView.id}`);
        }
    });

    handleNavigation();
    setupLazyLoad();
});


// Save button handler
document.getElementById("saveButton").addEventListener("click", async () => {
    console.log("Save button clicked");

    const updates = [];
    const validIdPattern = /^(\d+)([a-z]*)$/; // Matches IDs like "13b" and separates into numeric and suffix parts

    // Step 1: Group nodes by their base ID (numeric part)
    const groupedNodes = {};
    const allRelevantNodes = [...addedNodes, ...modifiedNodes]
        .map((nodeId) => document.getElementById(nodeId))
        .filter((node) => node !== null); // Filter out null values

    allRelevantNodes.forEach((node) => {
        const match = validIdPattern.exec(node.id);
        if (match) {
            const baseId = match[1]; // Numeric part (e.g., "13")
            if (!groupedNodes[baseId]) {
                groupedNodes[baseId] = [];
            }
            groupedNodes[baseId].push(node);
        } else {
            console.log(`Skipping node with invalid ID: ${node.id}`);
        }
    });

    // Step 2: Reorder IDs within each group based on DOM position
    Object.keys(groupedNodes).forEach((baseId) => {
        const nodes = groupedNodes[baseId];

        if (nodes.length > 1) {
            nodes.sort((a, b) => {
                const positionA = a.compareDocumentPosition(b);
                if (positionA & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
                if (positionA & Node.DOCUMENT_POSITION_PRECEDING) return 1;
                return 0;
            });

            nodes.forEach((node, index) => {
                const newId = `${baseId}${String.fromCharCode(97 + index)}`;
                if (node.id !== newId) {
                    console.log(`Reassigning ID from ${node.id} to ${newId}`);
                    node.id = newId; // Update the DOM
                }

                updates.push({
                    id: newId,
                    html: node.outerHTML,
                    action: addedNodes.has(node) ? "add" : "update",
                });
            });
        } else {
            const node = nodes[0];
            updates.push({
                id: node.id,
                html: node.outerHTML,
                action: addedNodes.has(node) ? "add" : "update",
            });
        }
    });

    // Step 3: Process removed nodes
    removedIds.forEach((id) => {
        if (validIdPattern.test(id)) {
            updates.push({
                id: id,
                action: "delete",
            });
        } else {
            console.log(`Skipping removed node with invalid ID: ${id}`);
        }
    });

    console.log("Prepared updates before filtering:", updates);

    // Step 4: Filter out redundant updates
    const uniqueUpdates = [];
    const processedIds = new Set();
    updates.forEach((update) => {
        if (update.action === "add") {
            update.action = "update";
        }

        if (!processedIds.has(update.id)) {
            uniqueUpdates.push(update);
            processedIds.add(update.id);
        }
    });

    console.log("Filtered updates for backend:", uniqueUpdates);

    if (uniqueUpdates.length === 0) {
        console.log("No changes detected.");
        return;
    }

    try {
        // Step 5: Process hyperlinks in the updates
        console.log("Processing hyperlinks in updates...");
        await processHyperCiteLinks(book, uniqueUpdates);

        console.log("Hyperlink processing complete. Sending updates to backend...");

        // Step 6: Send updates to backend
        const response = await fetch("/save-div-content", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "X-CSRF-TOKEN": document
                    .querySelector('meta[name="csrf-token"]')
                    .getAttribute("content"),
            },
            body: JSON.stringify({ updates: uniqueUpdates, book }),
        });

        if (response.ok) {
            console.log("Changes saved successfully.");
            addedNodes.clear();
            modifiedNodes.clear();
            removedIds.clear();
        } else {
            console.error("Failed to save changes.");
        }
    } catch (error) {
        console.error("Error during save:", error);
    }
});



// Hyperlink processing function
async function processHyperCiteLinks(book, updatedNodes) {
    if (!updatedNodes.length) {
        console.log("No updated nodes to process for hyperlinks.");
        return;
    }

    for (const node of updatedNodes) {
        const { id, html } = node;
        const parser = new DOMParser();
        const doc = parser.parseFromString(html, 'text/html');
        const anchors = doc.querySelectorAll('a');

        for (const anchor of anchors) {
            const href = anchor.getAttribute('href');
            if (anchor && anchor.textContent.includes('[:]') && href && !anchor.hasAttribute('id')) {
                try {
                    // Send request to backend
                    const response = await fetch(`/process-hypercite-link`, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'X-CSRF-TOKEN': document.querySelector('meta[name="csrf-token"]').getAttribute('content')
                        },
                        body: JSON.stringify({ href_a: href, citation_id_b: book })
                    });

                    const data = await response.json();

                    // Log the response
                    console.log("Backend response:", data);

                    if (data.success) {
                        // Set the new ID on the <a> tag
                        anchor.setAttribute('id', data.new_hypercite_id_x);

                        // Log the updated anchor tag for debugging
                        console.log("Updated <a> tag:", anchor.outerHTML);
                    } else {
                        console.log(`Skipped hyperlink: ${href}`, data.message);
                    }
                } catch (error) {
                    console.error("Error processing hyperlink:", error);
                }
            }
        }

        // Serialize the updated DOM back into the node's HTML
        node.html = doc.body.innerHTML;
        console.log("Updated node HTML:", node.html);
    }

    console.log("Hyperlink processing completed.");
}



// PASTE: listen
    document.addEventListener("DOMContentLoaded", function () {
    const editableDiv = document.getElementById("main-content"); // Editable div

    editableDiv.addEventListener("paste", (event) => {
        event.preventDefault(); // Prevent default paste behavior

        const clipboardData = event.clipboardData || window.clipboardData;
        
        // Retrieve HTML content from the clipboard, fallback to plain text
        const pastedHTML = clipboardData.getData("text/html");
        const pastedText = clipboardData.getData("text/plain");
        const contentToInsert = pastedHTML || pastedText; // Use HTML if available, otherwise use plain text

        const selection = document.getSelection();

        if (!selection.rangeCount) return;

        const range = selection.getRangeAt(0); // Get the range (cursor position)

        // Use a container to safely parse and insert HTML
        const container = document.createElement("div");
        container.innerHTML = contentToInsert;

        // Insert parsed HTML content into the current range
        const fragment = document.createDocumentFragment();
        Array.from(container.childNodes).forEach((node) => fragment.appendChild(node));
        
        range.deleteContents(); // Remove any selected content
        range.insertNode(fragment); // Insert the fragment
        range.collapse(false); // Move cursor to the end of the inserted content

        // Restore selection
        selection.removeAllRanges();
        selection.addRange(range);

        console.log(`Pasted content: "${contentToInsert}" into editable div.`);
    });
});




    document.getElementById('markdown-link').addEventListener('click', function () {
        window.location.href = `/${book}/md`;
    });

    document.getElementById('readButton').addEventListener('click', function () {
        localStorage.setItem('fromEditPage', 'true');
        window.location.href = `/${book}`;
    });
