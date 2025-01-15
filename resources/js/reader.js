
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
    event.clipboardData.setData('text/html', clipboardHtml);
    event.clipboardData.setData('text/plain', clipboardText);
    event.preventDefault(); // Prevent default copy behavior

    // Wrap the selected text in the DOM and send data to the backend
    wrapSelectedTextInDOM(hyperciteId, citationIdA);
    saveHyperciteData(citationIdA, hyperciteId, hypercitedText, hrefA);
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
