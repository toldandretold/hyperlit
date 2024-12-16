@extends('layout')

@section('styles')
    <link rel="stylesheet" href="{{ asset('css/reader.css') }}">

    <style>
    mark {
        background-color: yellow;
    }

    /* Disable the native iOS menu */
    html, body, * {
        -webkit-touch-callout: none; /* Disable the callout menu */
        -webkit-user-select: text;   /* Allow text selection */ 

    }

    #editButton

      {
            margin-right: 10px;
            padding: 10px 20px;
            font-size: 14px;
            background-color: #444; /* Dark background */
            color: #fff; /* White text */
            border: 1px solid #777; /* Subtle border */
            padding: 10px 20px; /* Spacing */
            border-radius: 5px; /* Rounded corners */
            font-weight: 600; /* Semi-bold text */
            box-shadow: 0px 2px 5px rgba(0, 0, 0, 0.5); /* Soft shadow */
            transition: background-color 0.3s ease, box-shadow 0.3s ease; /* Smooth hover transition */
        }

        button:hover {
            background-color: #555; /* Slightly lighter on hover */
            box-shadow: 0px 4px 6px rgba(0, 0, 0, 0.3); /* Larger shadow on hover */
        }

   

  
#main-content {
    height: 90vh; /* Ensures a fixed height based on the viewport */
    overflow-y: auto; /* Enable vertical scrolling */
    overflow-x: hidden; /* Prevent horizontal scrolling */
    padding: 1rem; /* Optional padding for better content appearance */
    margin: 0 auto; /* Center the container horizontally, if needed */
    box-sizing: border-box; /* Ensure padding is included in height calculation */
}


       
    </style>
@endsection

@section('content')

    <!-- Add the <base> tag here to ensure correct resolution of relative URLs -->
    <base href="{{ url('markdown/' . $book . '/epub_original/') }}">


    <!-- Load the content of the main-text.html file -->

    <div id="main-content" data-book="{{ $book }}">
    {{ File::get(resource_path("markdown/{$book}/main-text.md")) }}
</div>

    <!-- Buttons for hyper-lighting -->
    <div id="hyperlight-buttons" style="display: none; position: absolute; z-index: 9999;">
        <button id="copy-hyperlight">Hyperlight</button>
        <button id="delete-hyperlight" type="button" style="display:none;">Delete</button>
    </div>

    <div style="position: fixed; top: 10px; right: 10px;">
    <button type="button" id="editButton">Edit</button>
    </div>

@endsection

@section('scripts')
    <script src="https://cdnjs.cloudflare.com/ajax/libs/crypto-js/4.1.1/crypto-js.min.js"></script>
    <script src="https://cdnjs.cloudflare.com/ajax/libs/rangy/1.3.0/rangy-core.min.js"></script>
    <script src="https://cdnjs.cloudflare.com/ajax/libs/rangy/1.3.0/rangy-classapplier.min.js"></script>
    <script src="https://cdnjs.cloudflare.com/ajax/libs/rangy/1.3.0/rangy-highlighter.min.js"></script>
    
    



    <script>
let book = document.getElementById('main-content').getAttribute('data-book');

// Make sure the book variable is available globally if needed
        window.book = book;

// Function to attach listeners to <mark> tags
    // Function to attach listeners to <mark> tags
function attachMarkListeners() {
    // Select all <mark> tags, including those with `data-listener-attached`
    const markTags = document.querySelectorAll("mark");

    markTags.forEach(function (mark) {
        const highlightId = mark.getAttribute("id");

        if (highlightId) {
            // Remove existing listeners to avoid duplication
            mark.removeEventListener("click", handleMarkClick);
            mark.removeEventListener("mouseover", handleMarkHover);
            mark.removeEventListener("mouseout", handleMarkHoverOut);

            // Add click event listener to navigate to the highlight
            mark.addEventListener("click", handleMarkClick);

            // Add hover effect for underline
            mark.addEventListener("mouseover", handleMarkHover);
            mark.addEventListener("mouseout", handleMarkHoverOut);

            // Mark the <mark> tag as having a listener attached
            mark.dataset.listenerAttached = true;
        }
    });

    console.log(`Mark listeners refreshed for ${markTags.length} <mark> tags.`);
}

// Click handler for <mark> tags
function handleMarkClick(event) {
    event.preventDefault(); // Prevent default link behavior
    const highlightId = event.target.id;
    console.log(`Mark clicked: ${highlightId}`);
    window.location.href = `/${book}/hyperlights#${highlightId}`;
}

// Hover handlers for <mark> tags
function handleMarkHover(event) {
    event.target.style.textDecoration = "underline"; // Add underline on hover
}

function handleMarkHoverOut(event) {
    event.target.style.textDecoration = "none"; // Remove underline on hover out
}


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

        const tempDiv = document.createElement("div");
        tempDiv.innerHTML = processedHtml;

        if (isInitial) {
            mainContentDiv.innerHTML = ""; // Clear raw Markdown content for the initial render
        }

        if (direction === "upward") {
            mainContentDiv.insertBefore(tempDiv, mainContentDiv.firstChild);
        } else {
            mainContentDiv.appendChild(tempDiv);
        }

        processedChunks.add(`${startLine}-${endLine}`);
        attachMarkListeners(); // Ensure listeners are attached to newly added content
        console.log(`Processed lines ${startLine}-${endLine}.`);
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
addTouchAndClickListener(document.getElementById('copy-hyperlight'), function () {
    let selection = window.getSelection();
    let range;

    try {
        range = selection.getRangeAt(0);
        console.log('Full selected text:', selection.toString());
    } catch (error) {
        console.error('Error getting range:', error);
        return;
    }

    let selectedText = selection.toString().trim();

    if (!selectedText) {
        console.error('No valid text selected.');
        return;
    }

    let book = document.getElementById('main-content').getAttribute('data-book');

    if (!book) {
        console.error('Book name not found!');
        return;
    }

    // Generate the highlight_id on the front-end
    let userName = 'user-name'; // Use the actual user name
    let timestamp = Date.now();
    let highlightId = `${userName}_${timestamp}`;

    // Highlight the selection and assign id and class
    highlighter.highlightSelection("highlight");

    // Remove 'highlight' class from the new marks
    const newMarks = document.querySelectorAll('mark.highlight');
    if (newMarks.length > 0) {
        newMarks.forEach((mark, index) => {
            // Add id and class to the first <mark> tag
            if (index === 0) {
                mark.setAttribute('id', highlightId);
            }
            // Add class="highlight_id" to all <mark> tags
            mark.classList.add(highlightId);

            // Optionally remove the default 'highlight' class if it exists
            mark.classList.remove('highlight'); // Remove the class if not needed
        });
    }

    console.log("New highlight mark created with ID:", highlightId);

    attachMarkListeners(); // Attach listeners to new highlights

    // Find the closest block-level elements containing the start and end of the highlight
    let startContainer = range.startContainer.parentElement.closest('[id]');
    let endContainer = range.endContainer.parentElement.closest('[id]');

    // Ensure both start and end containers are valid
    if (startContainer && endContainer) {
        let startId = startContainer.id; // Get the ID of the starting block
        let endId = endContainer.id; // Get the ID of the ending block

        // Collect all block-level elements between the start and end
        let blocks = [];
        let current = startContainer;
        while (current && current.id <= endId) {
            blocks.push({
                id: current.id,
                html: current.innerHTML
            });
            current = current.nextElementSibling;
        }

        // Send the relevant blocks and their IDs to the backend
        fetch('/highlight/custom-markdown', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-CSRF-TOKEN': document.querySelector('meta[name="csrf-token"]').getAttribute('content')
            },
            body: JSON.stringify({
                book: book,
                blocks: blocks, // Array of block IDs and their HTML content
                text: selectedText,
                start_xpath: getXPath(range.startContainer),
                end_xpath: getXPath(range.endContainer),
                xpath_full: getFullXPath(range.startContainer),
                start_position: range.startOffset,
                end_position: range.startOffset + selectedText.length,
                highlight_id: highlightId // Send highlight_id to the backend
            })
        })
        .then(response => response.json())
        .then(data => {
            if (data.success) {
                console.log('Highlight saved and Markdown updated.');
                attachMarkListeners(); // Re-run listeners for newly created marks
            } else {
                console.error('Error from server:', data.message);
            }
        })
        .catch(error => {
            console.error('Error updating highlight:', error);
        });
    } else {
        console.error('Could not find valid start or end containers for the selection.');
    }
});


    // Function to handle deleting a highlight
// Function to handle deleting a highlight
addTouchAndClickListener(document.getElementById('delete-hyperlight'), function(event) {
    event.preventDefault();
    console.log("Delete button clicked.");

    let selection = window.getSelection();
    let selectedText = selection.toString().trim();

    if (!selectedText) {
        console.error('No text selected to delete.');
        return;
    }

    let removedHighlightIds = [];
    let blockIds = [];

    // Select all `mark` elements in the document
    const allMarks = document.querySelectorAll('mark');

    // Inside the delete highlight logic
    allMarks.forEach(function (mark) {
    let markText = mark.textContent.trim();

    if (selectedText.includes(markText)) {
        if (mark.hasAttribute('id')) {
            let highlightId = mark.getAttribute('id');
            removedHighlightIds.push(highlightId);
            console.log("Mark with ID to be deleted:", highlightId);
        }

        // Use the new function to find the nearest parent with a numerical ID
        let blockId = findParentWithNumericalId(mark);
        if (blockId) {
            blockIds.push(blockId);
            console.log("Found numerical block ID:", blockId);
        } else {
            console.warn("No numerical block ID found for mark:", mark);
        }

        // Remove the highlight mark
        let parentAnchor = mark.closest('a');
        if (parentAnchor) {
            let parent = parentAnchor.parentNode;
            parent.replaceChild(document.createTextNode(mark.textContent), parentAnchor);
        } else {
            let parent = mark.parentNode;
            parent.replaceChild(document.createTextNode(mark.textContent), mark);
        }
    }
     attachMarkListeners();
});


// Find the nearest ancestor with a numerical ID
function findParentWithNumericalId(element) {
    let current = element; // Start from the given element
    while (current) {
        if (current.hasAttribute('id')) {
            let blockId = current.getAttribute('id');
            if (!isNaN(blockId)) {
                return blockId; // Found a numerical ID, return it
            }
        }
        current = current.parentElement; // Move to the next parent
    }
    return null; // No numerical ID found in the hierarchy
}

    console.log("Removed highlight IDs:", removedHighlightIds);
    console.log("Affected block IDs:", blockIds);

    if (removedHighlightIds.length > 0) {
        let book = document.getElementById('main-content').getAttribute('data-book');

        // Send the removed IDs and block IDs to the backend
        fetch('/highlight/custom-markdown-delete', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-CSRF-TOKEN': document.querySelector('meta[name="csrf-token"]').getAttribute('content')
            },
            body: JSON.stringify({
                highlight_ids: removedHighlightIds, // IDs of highlights to delete
                block_ids: blockIds,               // IDs of affected block-level elements
                book: book                         // Book identifier
            })
        })
        .then(response => response.json())
        .then(data => {
            if (data.success) {
                console.log('Highlights deleted and HTML updated.');
            } else {
                console.error('Error from server:', data.message);
            }
        })
        .catch(error => {
            console.error('Error deleting highlights:', error);
        });
    } else {
        console.error('No matching mark elements found in selection.');
    }
});


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

function findParentWithNumericalId(element) {
    let currentElement = element;
    while (currentElement) {
        const id = currentElement.getAttribute('id');
        if (id && !isNaN(parseInt(id, 10))) {
            return currentElement; // Found a parent with a numerical ID
        }
        currentElement = currentElement.parentElement; // Move to the next parent
    }
    return null; // No valid parent with numerical ID found
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
                console.log('Hypercite blocks saved successfully:', data);
            } else {
                console.error('Error saving hypercite blocks:', data.message);
            }
        })
        .catch(error => {
            console.error('Error communicating with backend:', error);
        });
}


// Event listener for copying text and creating a hypercite
document.addEventListener('copy', (event) => {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) {
        return; // Do nothing if no text is selected
    }

    const hyperciteId = generateHyperciteID();
    const book = document.getElementById('main-content').getAttribute('data-book');

    if (!book) {
        console.error("Book identifier not found.");
        return;
    }

    // Wrap the selected text and send the relevant blocks to the backend
    wrapSelectedTextInDOM(hyperciteId, book);
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






    </script>
@endsection
