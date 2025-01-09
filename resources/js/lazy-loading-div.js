
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
function adjustNewNode(node, originalNodeContent) {
    if (node.tagName === "DIV" && !node.id) {
        console.log("Detected new <div> node without ID. Adjusting...");

        // Save the current selection
        const selection = document.getSelection();
        const range = selection.rangeCount > 0 ? selection.getRangeAt(0) : null;

        // Convert <div> to <p>
        const newP = document.createElement("p");
        newP.innerHTML = node.innerHTML;

        // Find the preceding node with an ID
        const allNodes = Array.from(mainContentDiv.querySelectorAll("*")); // Get all nodes
        const nodeIndex = allNodes.indexOf(node);
        const precedingNode = findNearestNodeWithId(allNodes, nodeIndex - 1, -1);

        if (precedingNode && precedingNode.id) {
            const baseId = precedingNode.id.match(/^(\d+)/)?.[1]; // Extract numerical base ID
            const siblingNodes = getSiblingNodesWithSameBaseId(allNodes, baseId);
            const nextLetter = getNextSequentialLetter(siblingNodes, baseId);

            newP.id = `${baseId}${nextLetter}`;
            console.log(`Assigned ID "${newP.id}" to new <p> node.`);
        } else {
            console.warn("No valid preceding node found. Assigning unique ID.");
            newP.id = generateUniqueId(); // Fallback to unique ID generation
        }

        // Replace the <div> with the new <p>
        node.parentNode.replaceChild(newP, node);

        // Restore the cursor position
        if (range) {
            const newRange = document.createRange();
            newRange.selectNodeContents(newP);
            newRange.collapse(true);
            selection.removeAllRanges();
            selection.addRange(newRange);
        }

        addedNodes.add(newP); // Track the new node as added
        originalNodeContent.set(newP.id, newP.innerHTML); // Cache its content
    }
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

        // Handle removed node verification and potential merges (same as before)
        tempRemovedIds.forEach((id) => {
            const removedNode = document.getElementById(id);
            if (!removedNode) {
                const mergedIntoNode = Array.from(originalNodeContent.keys()).find((key) => {
                    const currentNode = document.getElementById(key);
                    return currentNode && currentNode.innerHTML.includes(originalNodeContent.get(id));
                });

                if (mergedIntoNode) {
                    console.log(`Merge detected: Content of node ID ${id} merged into node ID ${mergedIntoNode}.`);
                    modifiedNodes.add(mergedIntoNode);
                    removedIds.add(id);
                    console.log(`Node ID ${id} marked as deleted due to merge.`);
                } else {
                    removedIds.add(id);
                    console.log(`Confirmed node removal: ${id}`);
                }

                originalNodeContent.delete(id); // Cleanup cache
            }
        });

        // Cleanup removed nodes no longer in the DOM
        originalNodeContent.forEach((content, id) => {
            if (!document.getElementById(id)) {
                console.log(`Node with ID ${id} disappeared completely.`);
                removedIds.add(id);
                originalNodeContent.delete(id);
            }
        });

        // Log current states
        console.log("Current modifiedNodes:", Array.from(modifiedNodes));
        console.log("Current removedIds:", Array.from(removedIds));
    });

    observer.observe(wrapperDiv, {
        childList: true,
        subtree: true,
        characterData: true,
    });

    observedSections.add(wrapperDiv);
    console.log(`Attached MutationObserver to range: ${wrapperDiv.dataset.chunkRange}`);
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


function getSiblingNodesWithSameBaseId(nodes, baseId) {
    return nodes.filter((node) => node.id && node.id.startsWith(baseId));
}

function getNextSequentialLetter(siblingNodes, baseId) {
    const existingLetters = siblingNodes
        .map((node) => node.id.replace(baseId, "")) // Extract the suffix
        .filter((suffix) => /^[a-z]+$/.test(suffix)) // Include only letter suffixes
        .sort(); // Sort alphabetically

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

    // Prepare added nodes for backend
    addedNodes.forEach((node) => {
        updates.push({
            id: node.id,
            html: node.outerHTML,
            action: "add", // Mark as an add action
        });
    });

    // Prepare modified nodes for backend
    modifiedNodes.forEach((node) => {
        updates.push({
            id: node.id,
            html: node.outerHTML,
            action: "update", // Mark as an update action
        });
    });

    // Prepare removed nodes for backend
    removedIds.forEach((id) => {
        updates.push({
            id: id,
            action: "delete", // Mark as a delete action
        });
    });

    console.log("Prepared updates for backend:", updates);

    if (updates.length === 0) {
        console.log("No changes detected.");
        return;
    }

    try {
        const response = await fetch("/save-div-content", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "X-CSRF-TOKEN": document
                    .querySelector('meta[name="csrf-token"]')
                    .getAttribute("content"),
            },
            body: JSON.stringify({ updates }),
        });

        if (response.ok) {
            console.log("Changes saved successfully.");
            // Clear tracked nodes only after a successful save
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

    for (const { id, html } of updatedNodes) {
        const parser = new DOMParser();
        const doc = parser.parseFromString(html, 'text/html');
        const anchors = doc.querySelectorAll('a');

        for (const anchor of anchors) {
            const href = anchor.getAttribute('href');
            if (anchor && anchor.textContent.includes('[:]') && href && !anchor.hasAttribute('id')) {
                try {
                    const response = await fetch(`/process-hypercite-link`, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'X-CSRF-TOKEN': document.querySelector('meta[name="csrf-token"]').getAttribute('content')
                        },
                        body: JSON.stringify({ href_a: href, citation_id_b: book })
                    });

                    const data = await response.json();
                    if (data.success) {
                        console.log(`New hypercite ID assigned: ${data.new_hypercite_id_x}`);
                        anchor.setAttribute('id', data.new_hypercite_id_x);
                    } else {
                        console.log(`Skipped hyperlink: ${href}`, data.message);
                    }
                } catch (error) {
                    console.error("Error processing hyperlink:", error);
                }
            }
        }
    }

    console.log("Hyperlink processing completed.");
    }


    document.getElementById('markdown-link').addEventListener('click', function () {
        window.location.href = `/${book}/md`;
    });

    document.getElementById('readButton').addEventListener('click', function () {
        localStorage.setItem('fromEditPage', 'true');
        window.location.href = `/${book}`;
    });
