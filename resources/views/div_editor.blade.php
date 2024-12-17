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
    <!-- Load the content of the main-text.md file -->

     <div id="main-content" data-book="{{ $book }}" contenteditable="true">
    {{ File::get(resource_path("markdown/{$book}/main-text.md")) }}
</div>


    <div style="position: fixed; bottom: 10px; width: 100%;">
        <button type="button" id="saveButton">Save</button>
        <button type="button" id="markdown-link">Markdown</button>
    </div>

    <div style="position: fixed; top: 10px; right: 10px;">
    <button type="button" id="readButton">Read</button>
    </div>

      <div id="loading-indicator">Processing... Please wait.</div>

@endsection

@section('scripts')
     <!-- Include Pusher first -->
<script src="https://js.pusher.com/7.0/pusher.min.js"></script>

<!-- Include the Vite bundle (usually in your main layout) -->
@vite(['resources/js/echo.js']) <!-- Add echo.js here -->

<script src="https://cdnjs.cloudflare.com/ajax/libs/crypto-js/4.1.1/crypto-js.min.js"></script>
    

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





</script> 

@endsection
