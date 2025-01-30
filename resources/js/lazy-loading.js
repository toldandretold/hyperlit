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



    function convertMarkdownToHtml(markdown) {
        console.log("Markdown content passed to convertMarkdownToHtml:", markdown);
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
        console.error("Error generating Table of Contents:", error);
    }
}




document.addEventListener("DOMContentLoaded", function () {
    const mainContentDiv = document.getElementById("main-content");
    let markdownContent = mainContentDiv.textContent; // Raw Markdown content

    // JSON path
    const jsonPath = `/${window.book}/main-text-footnotes.json`;
    
    // lazy loading
    const chunkSize = 100; // Number of lines to process per chunk
    const processedChunks = new Set(); // Track processed chunks
    
    // read position memory [NOT GOOD!]
    const lastVisitedKey = "last-visited-id"; // Key for session storage
    

    // footnotes buttons
    const refContainer = document.getElementById("ref-container");
    const refOverlay = document.getElementById("ref-overlay");
    let isRefOpen = false;


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

        // Inject footnotes for the processed range
        injectFootnotesForRange(startLine, endLine, jsonPath);

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
            const lineNumber = parseInt(targetId, 10);
            loadContentAroundLine(lineNumber);

            // Set the current range after loading content
            const bufferSize = 50;
            currentRangeStart = Math.max(0, lineNumber - bufferSize);
            currentRangeEnd = Math.min(markdownContent.split("\n").length, lineNumber + bufferSize);


            console.log({
                action: "Navigating to internal ID",
                targetId,
                lineNumber,
                currentRangeStart,
                currentRangeEnd,
            });

            // Reorder the DOM after loading content
            //reorderDomContent();
            pruneDomContent(currentRangeStart, currentRangeEnd, bufferSize);
        } else {
            const targetElement = document.getElementById(targetId);
            if (targetElement) {
                targetElement.scrollIntoView({ behavior: "smooth", block: "start" });
                console.log(`Scrolled to existing ID: ${targetId}`);
            } else {
                loadContentAroundId(targetId);
            }
        }

        // Reinitialize lazy loading for scrolling up and down
        setTimeout(() => {
            setupLazyLoad();
        }, 200);
    }




    // Function to dynamically load content around a line number
    function loadContentAroundLine(lineNumber) {
        const totalLines = markdownContent.split("\n").length;
        const bufferSize = 50; // Buffer size for adjacent content
        const startLine = Math.max(0, lineNumber - bufferSize);
        const endLine = Math.min(totalLines, lineNumber + bufferSize);

        console.log(`Loading content around line: ${lineNumber} (range: ${startLine}-${endLine})`);

        processRange(startLine, endLine, false, "downward");

        // Update global range
        currentRangeStart = Math.min(currentRangeStart, startLine);
        currentRangeEnd = Math.max(currentRangeEnd, endLine);

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
        let isLazyLoading = false; // Add a flag to prevent overlapping triggers

        function lazyLoadOnScroll() {
            if (isScrolling || isLazyLoading) return; // Prevent overlapping triggers
            isScrolling = true;
            isLazyLoading = true;

            setTimeout(() => {
                const totalLines = markdownContent.split("\n").length;

                const scrollTop = mainContentDiv.scrollTop;
                const scrollHeight = mainContentDiv.scrollHeight;
                const clientHeight = mainContentDiv.clientHeight;

                console.log({
                    action: "Lazy loading triggered",
                    scrollTop,
                    scrollHeight,
                    clientHeight,
                    currentRangeStart,
                    currentRangeEnd,
                });

                // Lazy load upward
               if (scrollTop <= 600 && currentRangeStart > 0) { // Increase threshold
                    console.log("Lazy loading upward...");
                    const newStart = Math.max(0, currentRangeStart - chunkSize);
                    if (!processedChunks.has(`${newStart}-${currentRangeStart}`)) {
                        const previousHeight = mainContentDiv.scrollHeight; // Capture current scroll height

                        processRange(newStart, currentRangeStart, false, "upward");
                        currentRangeStart = newStart;

                        //reorderDomContent();
                        pruneDomContent(currentRangeStart, currentRangeEnd, 50);

                        const newHeight = mainContentDiv.scrollHeight; // Calculate new height after content is added
                        const heightDifference = newHeight - previousHeight;

                        // Adjust `scrollTop` to maintain the same visual position
                        mainContentDiv.scrollTop += heightDifference;
                        console.log({
                            action: "Lazy load upward",
                            previousHeight,
                            newHeight,
                            heightDifference,
                            adjustedScrollTop: mainContentDiv.scrollTop,
                        });
                    }
                }


                // Lazy load downward
                if (scrollTop + clientHeight >= scrollHeight - 100 && currentRangeEnd < totalLines) { // Slightly higher buffer
                    console.log("Lazy loading downward...");
                    const newEnd = Math.min(totalLines, currentRangeEnd + chunkSize);
                    if (!processedChunks.has(`${currentRangeEnd}-${newEnd}`)) {
                        processRange(currentRangeEnd, newEnd, false, "downward");
                        currentRangeEnd = newEnd;

                        //reorderDomContent();
                        pruneDomContent(currentRangeStart, currentRangeEnd, 50);
                    }
                }

                isScrolling = false;
                setTimeout(() => { isLazyLoading = false; }, 500); // Cooldown for 500ms
            }, 200);
        }

        mainContentDiv.addEventListener("scroll", lazyLoadOnScroll);
    }

    function reorderDomContent() {
        console.log("Reordering DOM content by numerical IDs...");
        const elements = Array.from(mainContentDiv.children); // Get all child elements
        elements.sort((a, b) => {
            const idA = parseInt(a.id, 10);
            const idB = parseInt(b.id, 10);
            return idA - idB; // Sort by numerical ID
        });

        // Append the sorted elements back into `mainContentDiv`
        elements.forEach((el) => mainContentDiv.appendChild(el));
        console.log("DOM content reordered.");
    }


        function pruneDomContent(start, end, buffer = 300, maxRangeInDom = 2000) {
            // If the total range of lines in the DOM is not too large, skip pruning entirely:
            if (end - start < maxRangeInDom) {
                console.log("Skipping pruning because the DOM range is not too large yet.");
                return;
            }
            console.log(`Pruning DOM to keep range: ${start}-${end} with buffer: ${buffer}`);
            const elements = mainContentDiv.querySelectorAll("[id]");

            let heightRemovedAbove = 0; // Track height of elements removed above the viewport
            const viewportTop = mainContentDiv.scrollTop;

            elements.forEach((el) => {
                const id = parseInt(el.id, 10); // Get numerical ID
                if (isNaN(id) || id < start - buffer || id > end + buffer) {
                    if (el.offsetTop < viewportTop) {
                        heightRemovedAbove += el.offsetHeight; // Track removed height
                    }
                    console.log(`Removing element with ID: ${id}, offsetTop: ${el.offsetTop}`);
                    el.remove(); // Remove out-of-range element
                }
            });

            // Adjust scroll position if content above was removed
            if (heightRemovedAbove > 0) {
                mainContentDiv.scrollTop -= heightRemovedAbove;
                console.log({
                    action: "Scroll adjustment",
                    heightRemovedAbove,
                    newScrollTop: mainContentDiv.scrollTop,
                });
            }
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
                                        console.log("Target element before regex:", targetElement.innerHTML);

                                        // Check if the content already contains <sup> elements
                                        if (targetElement.innerHTML.includes(`<sup class="note" data-note-key="${key}">`)) {
                                            console.log(`Footnote ${key} already processed. Skipping.`);
                                            return;
                                        }

                                        const regex = new RegExp(`\\[\\^${key}\\](?!:)`, "g");

                                        // Check if the Markdown footnote exists in the content
                                        if (regex.test(targetElement.innerHTML)) {
                                            console.log(`Regex matched for key: ${key}`);

                                            // Convert Markdown content to HTML
                                            const footnoteHtml = content ? convertMarkdownToHtml(content) : "";

                                            // Replace Markdown reference `[ ^key ]` with the `<sup>` element
                                            targetElement.innerHTML = targetElement.innerHTML.replace(
                                                regex,
                                                `<sup class="note" data-note-key="${key}">[^${key}]</sup>`
                                            );

                                            console.log("Updated target element innerHTML:", targetElement.innerHTML);
                                        } else {
                                            console.warn(`Regex did not match for key: ${key} in element:`, targetElement.innerHTML);
                                        }
                                    } else {
                                        console.warn(`No target element found for line_number: ${line_number}`);
                                    }
                                }
                            });
                        }
                    });
                })
                .catch((error) => {
                    console.error("Error injecting footnotes for range:", error);
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
