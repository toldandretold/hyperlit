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
    // Select only <mark> tags that do not already have a listener attached
    const markTags = document.querySelectorAll("mark:not([data-listener-attached])");

    markTags.forEach(function (mark) {
        const highlightId = mark.getAttribute("id"); // Ensure we're getting the correct ID for the highlight

        if (highlightId) {
            mark.dataset.listenerAttached = true; // Mark this <mark> tag to avoid duplicate listeners

            // Add click event listener to navigate to the highlight
            mark.addEventListener("click", function () {
                window.location.href = `/${book}/hyperlights#${highlightId}`;
            });

            // Set cursor style for hover effect
            mark.style.cursor = "pointer";

            // Add mouseover effect for underline
            mark.addEventListener("mouseover", function () {
                mark.style.textDecoration = "underline";
            });

            // Remove underline on mouseout
            mark.addEventListener("mouseout", function () {
                mark.style.textDecoration = "none";
            });
        }
    });

    console.log(`Mark listeners attached to ${markTags.length} new <mark> tags.`);
}

// Function to convert Markdown to HTML with IDs and inline parsing
function convertMarkdownToHtmlWithIds(markdown, offset = 0) {
    const lines = markdown.split("\n"); // Split Markdown into lines
    let htmlOutput = "";

    lines.forEach((line, index) => {
        const trimmedLine = line.trim();

        if (!trimmedLine) return; // Skip empty lines

        const absoluteIndex = index + offset; // Add the offset to get the correct ID

        // Handle block-level Markdown elements
        if (trimmedLine.startsWith("# ")) {
            htmlOutput += `<h1 id="${absoluteIndex}">${parseInlineMarkdown(trimmedLine.replace(/^# /, ""))}</h1>\n`;
        } else if (trimmedLine.startsWith("## ")) {
            htmlOutput += `<h2 id="${absoluteIndex}">${parseInlineMarkdown(trimmedLine.replace(/^## /, ""))}</h2>\n`;
        } else if (trimmedLine.startsWith("### ")) {
            htmlOutput += `<h3 id="${absoluteIndex}">${parseInlineMarkdown(trimmedLine.replace(/^### /, ""))}</h3>\n`;
        } else if (trimmedLine.startsWith("#### ")) {
            htmlOutput += `<h4 id="${absoluteIndex}">${parseInlineMarkdown(trimmedLine.replace(/^#### /, ""))}</h4>\n`;
        } else if (trimmedLine.startsWith("> ")) {
            htmlOutput += `<blockquote id="${absoluteIndex}">${parseInlineMarkdown(trimmedLine.replace(/^> /, ""))}</blockquote>\n`;
        } else if (trimmedLine.startsWith("- ") || trimmedLine.match(/^\d+\. /)) {
            // Handle lists (unordered or ordered)
            htmlOutput += `<li id="${absoluteIndex}">${parseInlineMarkdown(trimmedLine.replace(/^[-\d\. ]+/, ""))}</li>\n`;
        } else {
            // Default to paragraph
            htmlOutput += `<p id="${absoluteIndex}">${parseInlineMarkdown(trimmedLine)}</p>\n`;
        }
    });

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
        const lines = markdownContent.split("\n").slice(startLine, endLine);
        const chunk = lines.join("\n");
        const processedHtml = convertMarkdownToHtmlWithIds(chunk, startLine); // Pass the offset

        if (!processedHtml) {
            console.error(`Failed to process lines ${startLine}-${endLine}.`);
            return false;
        }

        const tempDiv = document.createElement("div");
        tempDiv.innerHTML = processedHtml;

        if (isInitial) {
            mainContentDiv.innerHTML = ""; // Clear raw Markdown content for the initial render
        }

        // Append or prepend the content based on direction
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

    // Step 1: Handle navigation and fallback logic
    function handleNavigation() {
        const targetId = getTargetIdFromUrl();
        let targetLine = null;

        if (targetId) {
            console.log(`Navigating to target ID: ${targetId}`);
            if (isNumericId(targetId)) {
                // Handle numerical ID as line number
                targetLine = findLineForNumericId(parseInt(targetId, 10), markdownContent);
                console.log(`Target ID "${targetId}" treated as line number: ${targetLine}`);
            } else {
                // Handle non-numerical ID
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

        // Navigate to the target line
        processAndNavigate(targetLine);
    }

    // Process and navigate to a line
    function processAndNavigate(targetLine) {
        const startLine = Math.max(0, targetLine - 50);
        const endLine = Math.min(markdownContent.split("\n").length, targetLine + 50);

        processRange(startLine, endLine, true, "downward");
        attachMarkListeners();

        // Ensure upward content is also loaded if near the top
        if (startLine > 0) {
            const newStart = Math.max(0, startLine - chunkSize);
            processRange(newStart, startLine, false, "upward");
        }

        setTimeout(() => {
            const targetId = getTargetIdFromUrl();
            const targetElement = document.getElementById(targetId);
            if (targetElement) {
                targetElement.scrollIntoView({ block: "start" });
                console.log(`Scrolled to target ID: ${targetId}`);
            } else {
                console.warn(`Unable to navigate directly to target ID.`);
            }
        }, 100);
    }


        // Step 2: Setup lazy loading
        function setupLazyLoad() {
            if (isLazyLoadSetup) return; // Prevent duplicate setup
            isLazyLoadSetup = true;

            let isScrolling = false;

            function lazyLoadOnScroll() {
    if (isScrolling) return; // Prevent overlapping executions
    isScrolling = true;

    setTimeout(() => {
        const totalLines = markdownContent.split("\n").length;

        const scrollTop = mainContentDiv.scrollTop;
        const scrollHeight = mainContentDiv.scrollHeight;
        const clientHeight = mainContentDiv.clientHeight;

        console.log({
            scrollTop,
            clientHeight,
            scrollHeight,
        });

        // Lazy load upward
        if (scrollTop <= 100 && currentRangeStart > 0) { // Increased threshold for better triggering
            console.log("Lazy loading upward...");
            const newStart = Math.max(0, currentRangeStart - chunkSize);
            const previousHeight = mainContentDiv.scrollHeight; // Capture current height before prepending

            if (!processedChunks.has(`${newStart}-${currentRangeStart}`)) {
                processRange(newStart, currentRangeStart, false, "upward");
                const newHeight = mainContentDiv.scrollHeight; // Calculate new height after prepending
                mainContentDiv.scrollTop += newHeight - previousHeight; // Adjust scrollTop to maintain position
                console.log({
                    previousHeight,
                    newHeight,
                    adjustedScrollTop: mainContentDiv.scrollTop,
                });
            }
            currentRangeStart = newStart;
        }

        // Lazy load downward
        if (scrollTop + clientHeight >= scrollHeight - 50 && currentRangeEnd < totalLines) {
            console.log("Lazy loading downward...");
            const newEnd = Math.min(totalLines, currentRangeEnd + chunkSize);
            if (!processedChunks.has(`${currentRangeEnd}-${newEnd}`)) {
                processRange(currentRangeEnd, newEnd, false, "downward");
            }
            currentRangeEnd = newEnd;
        }

        isScrolling = false; // Reset the flag
    }, 100); // Debounce
}



        mainContentDiv.addEventListener("scroll", lazyLoadOnScroll);
        console.log("Lazy loading setup complete.");
    }

    // Initialize navigation and lazy loading
    handleNavigation();
    setupLazyLoad();

    // Step 3: Update browser memory with the last visible ID
    window.addEventListener("scroll", () => {
        const elementInView = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2);
        if (elementInView && elementInView.id) {
            sessionStorage.setItem(lastVisitedKey, elementInView.id);
            console.log(`Updated last visited ID: ${elementInView.id}`);
        }
    });
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

    const allMarks = document.querySelectorAll('mark');
    allMarks.forEach(function(mark) {
        let markText = mark.textContent.trim();

        if (selectedText.includes(markText)) {
            if (mark.hasAttribute('id')) {
                let highlightId = mark.getAttribute('id');
                removedHighlightIds.push(highlightId);
                console.log("Mark with ID to be deleted:", highlightId);  // Log for clarity
            }

            let parentAnchor = mark.closest('a');
            if (parentAnchor) {
                let parent = parentAnchor.parentNode;
                parent.replaceChild(document.createTextNode(mark.textContent), parentAnchor);
            } else {
                let parent = mark.parentNode;
                parent.replaceChild(document.createTextNode(mark.textContent), mark);
            }
        }
    });

    console.log("Removed highlight IDs:", removedHighlightIds);

    // Ensure that highlight IDs are always sent as an array
    if (removedHighlightIds.length > 0) {
        let updatedHtml = document.getElementById('main-content').innerHTML;
        let book = document.getElementById('main-content').getAttribute('data-book');

        // Send the removed IDs as an array, even if there’s only one highlight ID
        fetch('/highlight/delete', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-CSRF-TOKEN': document.querySelector('meta[name="csrf-token"]').getAttribute('content')
            },
            body: JSON.stringify({
                highlight_ids: removedHighlightIds, // Ensure this is an array
                updated_html: updatedHtml,
                book: book
            })
        })
        .then(response => response.json())
        .then(data => {
            if (data.success) {
                console.log('Highlights deleted and HTML updated');
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
