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
    </style>
@endsection

@section('content')

    <!-- Add the <base> tag here to ensure correct resolution of relative URLs -->
    <base href="{{ url('markdown/' . $book . '/epub_original/') }}">


    <!-- Load the content of the main-text.html file -->
    <div id="main-content" data-book="{{ $book }}">
        {!! File::get(resource_path("markdown/{$book}/main-text.html")) !!}
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


      
   // Function to attach event listeners to all mark tags
    function attachMarkListeners() {
        const markTags = document.querySelectorAll('mark');

        markTags.forEach(function(mark) {
            const highlightId = mark.getAttribute('class');

            if (highlightId) {
                mark.addEventListener('click', function() {
                    window.location.href = `/${book}/hyperlights#${highlightId}`;  
                });

                mark.style.cursor = 'pointer';

                mark.addEventListener('mouseover', function() {
                    mark.style.textDecoration = 'underline';
                });
                mark.addEventListener('mouseout', function() {
                    mark.style.textDecoration = 'none';
                });
            }
        });
    }

    // Call the function on page load to attach listeners to existing marks
    document.addEventListener("DOMContentLoaded", function() {
        attachMarkListeners(); // Attach listeners on page load
    // Adjust internal links to handle #hash navigation properly
        const internalLinks = document.querySelectorAll('a[href^="#"]');
        
        internalLinks.forEach(function(link) {
            link.addEventListener('click', function(event) {
                event.preventDefault();  // Prevent default behavior
                const targetId = link.getAttribute('href').substring(1);  // Get the ID from href (remove the '#')
                const targetElement = document.getElementById(targetId);

                if (targetElement) {
                    // Scroll to the target element smoothly
                    targetElement.scrollIntoView({ behavior: 'smooth', block: 'start' });
                } else {
                    console.error(`Target element with ID "${targetId}" not found.`);
                }
            });
        });
    });


// Save position on refresh or navigation away
window.addEventListener('beforeunload', function () {
    const elementInView = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2);
    const domPath = getDomPath(elementInView);
    localStorage.setItem('originalReadPath', domPath);
    localStorage.setItem('refreshFlag', 'true'); // Set the flag to indicate a refresh
    console.log("Updated originalReadPath on refresh:", domPath);
});

window.addEventListener('DOMContentLoaded', () => {
    const fromEditPage = localStorage.getItem('fromEditPage');
    const domPath = localStorage.getItem('originalReadPath');
    console.log("Retrieved originalReadPath:", domPath); // Debugging log

    if (domPath && fromEditPage) {
        const targetElement = document.querySelector(domPath);
        if (targetElement) {
            targetElement.scrollIntoView({ behavior: 'smooth' });
            console.log("Scrolled to:", targetElement); // Debugging log
        } else {
            console.log("Target element not found for:", domPath); // Debugging log
        }
    }

    // Clear the flags to reset for future actions
    localStorage.removeItem('refreshFlag');
    localStorage.removeItem('fromEditPage');
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
addTouchAndClickListener(document.getElementById('copy-hyperlight'), function() {
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
    let highlightId = userName + '_' + timestamp;

    // Highlight the selection and assign id and class
    highlighter.highlightSelection("highlight");

    // Remove 'highlight' class from the new marks, as it's no longer needed
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


    let updatedHtml = document.getElementById('main-content').innerHTML;

    // Send data to the server, including the generated highlight_id
    fetch('/highlight/store', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-CSRF-TOKEN': document.querySelector('meta[name="csrf-token"]').getAttribute('content')
        },
        body: JSON.stringify({
            book: book,
            updated_html: updatedHtml,
            text: selectedText,
            start_xpath: getXPath(range.startContainer),
            end_xpath: getXPath(range.endContainer),
            xpath_full: getFullXPath(range.startContainer),
            start_position: range.startOffset,
            end_position: range.startOffset + selectedText.length,
            highlight_id: highlightId  // Send highlight_id to the backend
        })
    })
    .then(response => response.json())
    .then(data => {
        if (data.success) {
            console.log('HTML updated and highlight saved');
        // Re-run the listener function for the newly created marks
            attachMarkListeners();  // Attach listeners to newly created mark tags
        } else {
            console.error('Error from server:', data.message);
        }
    })
    .catch(error => {
        console.error('Error updating HTML:', error);
    });
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


  



// HYPERCITE[:]
// Function to generate a unique hyper-cite ID
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
        document.execCommand('copy');  // Fallback copy for plain text
    } catch (err) {
        console.error('Fallback: Unable to copy text', err);
    }
    document.body.removeChild(textArea);
}

// Function to wrap selected text with <u> tag in the DOM
function wrapSelectedTextInDOM(hyperciteId) {
    const selection = window.getSelection();
    const range = selection.getRangeAt(0);
    
    // Create a <u> element with the hypercite_id
    const wrapper = document.createElement('u');
    wrapper.setAttribute('id', hyperciteId);

    // Wrap the selected text in the <u> tag
    range.surroundContents(wrapper);
    
    // Clear the selection after modifying the DOM
    selection.removeAllRanges();

    // Capture the HTML content inside the #main-content div
    const updatedHTML = document.getElementById('main-content').innerHTML;
    console.log('Captured updatedHTML:', updatedHTML);

    // Send the updated HTML to the server for saving
    saveUpdatedHTMLToFile(updatedHTML, book);

    
}



function saveUpdatedHTMLToFile(updatedHTML, book) {
    try {
        // Validate JSON format
        const jsonPayload = JSON.stringify({ html: updatedHTML });
        
        // Send the request
        fetch(`/save-updated-html/${book}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-CSRF-TOKEN': document.querySelector('meta[name="csrf-token"]').getAttribute('content')
            },
            body: jsonPayload
        })
        .then(response => response.text())
        .then(text => {
            console.log('Raw server response:', text); // Log raw text to identify issues
            const data = JSON.parse(text); // Attempt to parse as JSON
            if (data.success) {
                console.log('HTML saved successfully');
            } else {
                console.error('Error saving HTML:', data.error);
            }
        })
        .catch(error => {
            console.error('Error saving HTML:', error);
        });
    } catch (error) {
        console.error('Invalid JSON structure:', error);
    }
}




document.addEventListener('copy', (event) => {
    const selection = window.getSelection();

    if (selection.rangeCount === 0) {
        return; // Do nothing if no text is selected
    }

    // Generate a unique hyper-cite ID for the copied text
    const hyperciteId = generateHyperciteID();

    // Get the current page URL without any existing hash
    const baseUrl = window.location.href.split('#')[0];
    const href = `${baseUrl}#${hyperciteId}`;

    // Clone the HTML structure of the selected content
    const range = selection.getRangeAt(0).cloneContents();
    const div = document.createElement('div');
    div.appendChild(range);
    const selectedHtml = div.innerHTML;  // Original HTML with styles intact
    const selectedText = selection.toString(); // Plain text version of selected content

    // Add the hyperlink at the end of the selected HTML content
    const clipboardHtml = `'${selectedHtml}'<a href="${href}">[:]</a>`;
    const clipboardText = `'${selectedText}'[[:]](${href})`;

    // Set clipboard data
    event.clipboardData.setData('text/html', clipboardHtml);
    event.clipboardData.setData('text/plain', clipboardText);
    event.preventDefault(); // Prevent default copy behavior

    // Wrap the selected text with <u> tags in the HTML page only
    wrapSelectedTextInDOM(hyperciteId);

    // Save the hypercite data to the server, including the href
    saveHyperciteData(book, hyperciteId, selectedText, href);
});




// Function to save hypercite data to the server, including citation_id-a and href-a
function saveHyperciteData(citation_id_a, hypercite_id, hypercited_text, href_a) {
    fetch(`/save-hypercite`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-CSRF-TOKEN': document.querySelector('meta[name="csrf-token"]').getAttribute('content')
        },
        body: JSON.stringify({
            citation_id_a: citation_id_a, // Use the updated column name
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
