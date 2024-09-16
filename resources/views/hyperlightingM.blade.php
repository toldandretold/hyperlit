@extends('layout')

@section('styles')
    <link rel="stylesheet" href="{{ asset('css/reader.css') }}">

    <style>
    mark {
        background-color: yellow;
    }

    #hyperlight-buttons {
        position: fixed;
        bottom: 20px;
        right: 20px;
        background-color: white;
        border: 1px solid #ccc;
        padding: 10px;
        box-shadow: 0 0 10px rgba(0, 0, 0, 0.1);
    }

    #hyperlight-buttons button {
        margin: 5px;
    }

    </style>
@endsection

@section('content')

    <!-- Load the content of the main-text.html file -->
    <div id="main-content" data-book="{{ $book }}">
        {!! File::get(resource_path("markdown/{$book}/main-text.html")) !!}

    </div>

    <!-- Buttons for hyper-lighting -->
    <div id="hyperlight-buttons" style="display:none;">
        <button id="copy-hyperlight">Hyperlight</button>
        <button id="delete-hyperlight" type="button" style="display:none;">Delete</button>
    </div>

@endsection

@section('scripts')
    <script src="https://cdnjs.cloudflare.com/ajax/libs/crypto-js/4.1.1/crypto-js.min.js"></script>
    <script src="https://cdnjs.cloudflare.com/ajax/libs/rangy/1.3.0/rangy-core.min.js"></script>
    <script src="https://cdnjs.cloudflare.com/ajax/libs/rangy/1.3.0/rangy-classapplier.min.js"></script>
    <script src="https://cdnjs.cloudflare.com/ajax/libs/rangy/1.3.0/rangy-highlighter.min.js"></script>



<script>
    rangy.init();

    // Initialize the highlighter
    var highlighter = rangy.createHighlighter();

    // Custom class applier with an element tag name of "mark"
    var classApplier = rangy.createClassApplier("highlight", {
        elementTagName: "mark",
        applyToAnyTagName: true
    });

    highlighter.addClassApplier(classApplier);

    // Event listener for mouseup to detect selected text and show buttons
    document.addEventListener('mouseup', function() {
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
            document.getElementById('hyperlight-buttons').style.display = 'block';

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
    });

   // Function to handle creating a highlight
document.getElementById('copy-hyperlight').addEventListener('click', function() {
    let selection = window.getSelection();
    let range;

    try {
        range = selection.getRangeAt(0);
        console.log('Full selected text:', selection.toString());
    } catch (error) {
        console.error('Error getting range:', error);
        return;
    }

    // Get the selected text
    let selectedText = selection.toString().trim();

    // Ensure that there is a valid selection
    if (!selectedText) {
        console.error('No valid text selected.');
        return;
    }

    // Get the book name from the data attribute
    let book = document.getElementById('main-content').getAttribute('data-book');

    if (!book) {
        console.error('Book name not found!');
        return;
    }

    // Get the XPath for the start and end containers
    let startXPath = getXPath(range.startContainer);
    let endXPath = getXPath(range.endContainer);

    // Generate the full XPath for the start of the highlight
    let fullXPath = getFullXPath(range.startContainer);

    // Normalize the start and end XPaths
    startXPath = normalizeXPath(startXPath);
    endXPath = normalizeXPath(endXPath);

    // Calculate start and end positions relative to the container
    let containerText = range.startContainer.textContent || range.startContainer.innerText;
    let startPosition = range.startOffset;
    let endPosition = startPosition + selectedText.length;

    // Generate the highlight ID based on character count and XPath
    let highlightId = `${startPosition}${startXPath}-${Date.now()}`;

    console.log("Generated Highlight ID:", highlightId);
    console.log("Start XPath:", startXPath);
    console.log("End XPath:", endXPath);
    console.log("Full XPath:", fullXPath);
    console.log("Start Position:", startPosition, "End Position:", endPosition);

    // Use Rangy to highlight the selection
    highlighter.highlightSelection("highlight");

    // Get all <mark> tags applied by Rangy
    const highlights = document.querySelectorAll('mark.highlight');

    if (highlights.length > 0) {
        // Loop through all <mark> tags
        highlights.forEach((mark, index) => {
            // Remove any existing class and add the correct highlight class
            mark.removeAttribute('class');
            mark.classList.add(highlightId);  // Add class based on highlightId

            // Apply the id to only the first <mark> tag
            if (index === 0) {
                mark.setAttribute('id', highlightId);
            }

            // Create an <a> tag for each <mark>
            const a = document.createElement('a');
            a.setAttribute('href', `/${book}/hyperlights#${highlightId}`);

            // Wrap the <mark> tag inside the <a> tag
            mark.parentNode.insertBefore(a, mark);
            a.appendChild(mark);
        });
    }

    // Capture only the content of the main container
    let updatedHtml = document.getElementById('main-content').innerHTML;

    // Send the updated HTML and highlight data to the backend
    fetch('/save-updated-html', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-CSRF-TOKEN': document.querySelector('meta[name="csrf-token"]').getAttribute('content')
        },
        body: JSON.stringify({
            book: book,
            updated_html: updatedHtml,
            text: selectedText,
            start_xpath: startXPath,
            end_xpath: endXPath,
            xpath_full: fullXPath,
            start_position: startPosition,
            end_position: endPosition,
            highlight_id: highlightId
        })
    })
    .then(response => {
        if (!response.ok) {
            return response.text().then(text => { throw new Error(text); });
        }
        console.log('HTML updated and highlight saved');
    })
    .catch(error => {
        console.error('Error updating HTML:', error);
    });
});
// Function to handle deleting a highlight
document.getElementById('delete-hyperlight').addEventListener('click', function(event) {
    event.preventDefault();  // Prevent default behavior like page reload
    console.log("Delete button clicked.");

    let selection = window.getSelection();
    let selectedText = selection.toString().trim();

    if (!selectedText) {
        console.error('No text selected to delete.');
        return;
    }

    // Keep track of the IDs and classes of the <mark> tags that are removed
    let removedHighlightIds = [];
    let removedHighlightClasses = [];

    // Loop through all <mark> elements in the document
    const allMarks = document.querySelectorAll('mark');
    allMarks.forEach(function(mark) {
        let markText = mark.textContent.trim();

        // Check if the selected text contains the text inside the <mark> tag
        if (selectedText.includes(markText)) {
            if (mark.hasAttribute('id')) {
                let highlightId = mark.getAttribute('id');
                removedHighlightIds.push(highlightId);  // Store the highlight ID for backend update
            }

            if (mark.hasAttribute('class')) {
                let highlightClass = mark.getAttribute('class');
                removedHighlightClasses.push(highlightClass);  // Store the class for backend update
            }

            // Find the parent <a> tag and remove both the <a> and <mark> tags but keep the text
            let parentAnchor = mark.closest('a');
            if (parentAnchor) {
                let parent = parentAnchor.parentNode;
                parent.replaceChild(document.createTextNode(mark.textContent), parentAnchor);
            } else {
                // Fallback: Just remove the <mark> tag if <a> is not found (unlikely case)
                let parent = mark.parentNode;
                parent.replaceChild(document.createTextNode(mark.textContent), mark);
            }
        }
    });

    console.log("Removed highlight IDs:", removedHighlightIds);
    console.log("Removed highlight classes:", removedHighlightClasses);

    if (removedHighlightIds.length > 0 || removedHighlightClasses.length > 0) {
        // Capture the updated HTML after deletion
        let updatedHtml = document.getElementById('main-content').innerHTML;
        let book = document.getElementById('main-content').getAttribute('data-book');  // Get the book value

        // Send the deletion request to the backend
        fetch('/delete-highlight', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-CSRF-TOKEN': document.querySelector('meta[name="csrf-token"]').getAttribute('content')
            },
            body: JSON.stringify({
                highlight_ids: removedHighlightIds,
                highlight_classes: removedHighlightClasses,
                updated_html: updatedHtml,
                book: book  // Include the book value here
            })
        })
        .then(response => {
            if (!response.ok) {
                return response.text().then(text => { throw new Error(text); });
            }
            console.log('Highlights deleted and HTML updated');
            return response.json(); // Handle successful JSON response
        })
        .then(data => {
            console.log('Success:', data);  // Log success response from the server
        })
        .catch(error => {
            console.error('Error deleting highlights:', error);  // Log errors more clearly
        });
    } else {
        console.error('No matching mark elements found in selection.');
    }
});


    // Function to calculate XPath of a node
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

    // Function to generate the full XPath
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

    // Function to normalize XPath to match backend format
    function normalizeXPath(xpath) {
        const regex = /^id\(".*?"\)\/div\[1\]/;  // Matches id("...")/div[1] or similar pattern
        return xpath.replace(regex, '');  // Replace the match with an empty string
    }
</script>



@endsection
