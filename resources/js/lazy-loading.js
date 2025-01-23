
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
        } else if (trimmedLine.startsWith("#### ")) {
            if (insideBlockquote) {
                htmlOutput += currentBlockquote + "</blockquote>\n";
                insideBlockquote = false;
                currentBlockquote = "";
                blockquoteOffset = 0;
            }
            htmlOutput += `<h4 id="${absoluteIndex}">${parseInlineMarkdown(trimmedLine.replace(/^#### /, ""))}</h4>\n`;
        } else if (trimmedLine.startsWith("##### ")) {
            if (insideBlockquote) {
                htmlOutput += currentBlockquote + "</blockquote>\n";
                insideBlockquote = false;
                currentBlockquote = "";
                blockquoteOffset = 0;
            }
            htmlOutput += `<h5 id="${absoluteIndex}">${parseInlineMarkdown(trimmedLine.replace(/^##### /, ""))}</h5>\n`;
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
        } else if (trimmedLine.match(/^!\[.*\]\(.*\)$/)) {
            // Handle Markdown image syntax
            const imageMatch = trimmedLine.match(/^!\[(.*)\]\((.*)\)$/);
            if (imageMatch) {
                const altText = imageMatch[1];
                const imageUrl = imageMatch[2];
                htmlOutput += `<img id="${absoluteIndex}" src="${imageUrl}" alt="${altText}" />\n`;
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


// Function to generate and display the Table of Contents
async function generateTableOfContents(jsonPath, tocContainerId, toggleButtonId) {
    try {
        // Fetch the JSON file
        const response = await fetch(jsonPath);
        const sections = await response.json();

        // Get the container for the TOC
        const tocContainer = document.getElementById(tocContainerId);
        if (!tocContainer) {
            console.error(`TOC container with ID "${tocContainerId}" not found.`);
            return;
        }

        // Clear any existing content in the container
        tocContainer.innerHTML = "";

        // Generate the TOC content
        sections.forEach((section) => {
            if (section.heading) {
                const headingContent = Object.values(section.heading)[0]; // Get the heading text
                const headingLevel = Object.keys(section.heading)[0]; // Get the heading level (e.g., h1, h2)
                const lineNumber = section.heading.line_number; // Get the line number

                if (headingContent && headingLevel && lineNumber) {
                    // Create the internal link
                    const link = document.createElement("a");
                    link.href = `#${lineNumber}`;

                    // Create the heading element (e.g., <h1>, <h2>) and set its content
                    const headingElement = document.createElement(headingLevel);
                    headingElement.textContent = headingContent;

                    // Append the heading element to the link
                    link.appendChild(headingElement);

                    // Create a wrapper div or list item for the link
                    const tocItem = document.createElement("div");
                    tocItem.classList.add("toc-item", headingLevel); // Optional: Add classes for styling
                    tocItem.appendChild(link);

                    // Append the item to the TOC container
                    tocContainer.appendChild(tocItem);
                }
            }
        });


        // Add a toggle button to show/hide the TOC
        const toggleButton = document.getElementById(toggleButtonId);
        if (toggleButton) {
            toggleButton.addEventListener("click", () => {
                tocContainer.classList.toggle("hidden"); // Show/hide the TOC
            });
        } else {
            console.error(`Toggle button with ID "${toggleButtonId}" not found.`);
        }
    } catch (error) {
        console.error("Error generating Table of Contents:", error);
    }
}


document.addEventListener("DOMContentLoaded", function () {
    const mainContentDiv = document.getElementById("main-content");
    let markdownContent = mainContentDiv.textContent; // Raw Markdown content
    const chunkSize = 100; // Number of lines to process per chunk
    const processedChunks = new Set(); // Track processed chunks
    const lastVisitedKey = "last-visited-id"; // Key for session storage
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

    // Use the global `book` variable to construct the JSON path
    const jsonPath = `/${window.book}/main-text-footnotes.json`;

    // Log the JSON path for debugging purposes
    console.log(`JSON Path: ${jsonPath}`);

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
        const regex = new RegExp(`id="${id}"`, "i");
        const lines = markdown.split("\n");
        for (let i = 0; i < lines.length; i++) {
            if (regex.test(lines[i])) {
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
        const targetId = getTargetIdFromUrl(); // Extract target ID from URL
        let targetLine = null;

        if (targetId) {
            console.log(`Navigating to target ID: ${targetId}`);
            if (isNumericId(targetId)) {
                // If the ID is numeric, treat it as a line number
                targetLine = parseInt(targetId, 10);
            } else {
                // Otherwise, find the line for the non-numeric ID
                targetLine = findLineForId(markdownContent, targetId);
                if (targetLine === null) {
                    console.warn(`Target ID "${targetId}" not found in Markdown.`);
                }
            }
        }

        if (targetLine === null) {
            // Fallback to last visited ID from session storage
            const lastVisitedId = sessionStorage.getItem(lastVisitedKey);
            if (lastVisitedId) {
                console.log(`Falling back to last visited ID: ${lastVisitedId}`);
                targetLine = isNumericId(lastVisitedId)
                    ? parseInt(lastVisitedId, 10) // Treat as a line number
                    : findLineForId(markdownContent, lastVisitedId); // Treat as a regular ID
            }
        }

        if (targetLine === null) {
            console.log("No valid target ID. Defaulting to top of the page.");
            targetLine = 0;
        }

        // Determine the range of lines to load
        const startLine = Math.max(0, targetLine - 50);
        const endLine = Math.min(markdownContent.split("\n").length, targetLine + 50);

        // Process the range
        processRange(startLine, endLine, true, "downward");

        currentRangeStart = startLine;
        currentRangeEnd = endLine;

        // Navigate to the loaded content
        setTimeout(() => {
            const targetElement = document.getElementById(targetId);
            if (targetElement) {
                targetElement.scrollIntoView({ block: "start" });
                console.log(`Scrolled to target ID: ${targetId}`);
            } else {
                console.warn(`Target ID "${targetId}" not found after loading.`);
            }
        }, 100);
    }


    // Function to handle navigation to internal links
    function navigateToInternalId(targetId) {
        if (isNumericId(targetId)) {
            // If the ID is numeric, treat it as a line number
            loadContentAroundLine(parseInt(targetId, 10));
        } else {
            const targetElement = document.getElementById(targetId);
            if (targetElement) {
                // If the element is already in the DOM, scroll to it
                targetElement.scrollIntoView({ behavior: "smooth", block: "start" });
                console.log(`Scrolled to existing ID: ${targetId}`);
            } else {
                // If the element is not in the DOM, load the content dynamically
                console.log(`ID not found in DOM, loading dynamically: ${targetId}`);
                loadContentAroundId(targetId);
            }
        }
    }

    // Function to dynamically load content around a line number
    function loadContentAroundLine(lineNumber) {
        const totalLines = markdownContent.split("\n").length;
        const startLine = Math.max(0, lineNumber - 50); // Load 50 lines before the target
        const endLine = Math.min(totalLines, lineNumber + 50); // Load 50 lines after the target

        console.log(`Loading content around line: ${lineNumber} (range: ${startLine}-${endLine})`);

        processRange(startLine, endLine, false, "downward");

        setTimeout(() => {
            const targetElement = document.getElementById(lineNumber.toString());
            if (targetElement) {
                targetElement.scrollIntoView({ behavior: "smooth", block: "start" });
                console.log(`Scrolled to dynamically loaded line: ${lineNumber}`);
            } else {
                console.error(`Line "${lineNumber}" still not found after loading.`);
            }
        }, 100);
    }

    // Function to dynamically load content around a target ID
    function loadContentAroundId(targetId) {
        const targetLine = findLineForId(markdownContent, targetId);
        if (targetLine === null) {
            console.warn(`Target ID "${targetId}" not found in Markdown.`);
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
                console.log(`Scrolled to dynamically loaded ID: ${targetId}`);
            } else {
                console.error(`ID "${targetId}" still not found after loading.`);
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


    // Intercept internal links
    document.addEventListener("click", function (event) {
        const link = event.target.closest("a");
        if (link && link.hash && link.hash.startsWith("#")) {
            event.preventDefault(); // Prevent default anchor behavior
            const targetId = link.hash.substring(1); // Get the ID without the "#"
            navigateToInternalId(targetId);
        }
    });

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
