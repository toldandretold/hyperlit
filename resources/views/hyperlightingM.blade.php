@extends('layout')

@section('content')

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


    {!! $html !!}

    <!-- Buttons for hyper-lighting -->
    <div id="hyperlight-buttons" style="display:none;">
        <button id="copy-hyperlight">Copy Hyperlight</button>
        <button id="hyper-cite" style="display:none;">Hyper-Cite</button>
    </div>

    <script src="https://cdnjs.cloudflare.com/ajax/libs/crypto-js/4.1.1/crypto-js.min.js"></script>
    <script src="https://cdnjs.cloudflare.com/ajax/libs/rangy/1.3.0/rangy-core.min.js"></script>
    <script src="https://cdnjs.cloudflare.com/ajax/libs/rangy/1.3.0/rangy-classapplier.min.js"></script>
    <script src="https://cdnjs.cloudflare.com/ajax/libs/rangy/1.3.0/rangy-highlighter.min.js"></script>

  <script>
    rangy.init();

    // Custom function to generate the fingerprint hash
    function generateFingerprint(text) {
        return CryptoJS.SHA256(text).toString();
    }

    // Initialize the highlighter
    var highlighter = rangy.createHighlighter();

    // Custom class applier with an element tag name of "mark"
    var classApplier = rangy.createClassApplier("highlight", {
        elementTagName: "mark",
        applyToAnyTagName: true
    });

    highlighter.addClassApplier(classApplier);

    document.addEventListener('mouseup', function() {
        let selectedText = window.getSelection().toString().trim();

        if (selectedText.length > 0) {
            document.getElementById('hyperlight-buttons').style.display = 'block';
        }
    });

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

        // Get the XPath for the start and end containers
        let startXPath = getXPath(range.startContainer);
        let endXPath = getXPath(range.endContainer);

        // Normalize the XPath to match the format expected on the backend
        startXPath = normalizeXPath(startXPath);
        endXPath = normalizeXPath(endXPath);

        // Calculate start and end positions relative to the container
        let containerText = range.startContainer.textContent || range.startContainer.innerText;
        let startPosition = range.startOffset; // Start offset within the container
        let endPosition = startPosition + selectedText.length; // Calculate end position

        console.log("Start XPath:", startXPath);
        console.log("End XPath:", endXPath);
        console.log("Start Position:", startPosition, "End Position:", endPosition);

        // Capture a larger surrounding context to reduce collision
        let surroundingContext = getExtendedSurroundingContext(range);
        let contextHash = generateFingerprint(surroundingContext);

        // Use Rangy to highlight the selection
        highlighter.highlightSelection("highlight");

        // Replace highlighted text with <mark><a></a></mark>
        const highlights = document.querySelectorAll('mark.highlight');
        highlights.forEach(function(mark) {
            if (!mark.querySelector('a')) {
                const hash = generateFingerprint(mark.textContent || mark.innerText);
                const a = document.createElement('a');
                a.setAttribute('href', `/hyper-lights#${hash}`);
                a.setAttribute('id', hash);
                a.innerHTML = mark.innerHTML;
                mark.innerHTML = '';
                mark.appendChild(a);
            }
        });

        // Save the highlight and update the markdown file in the background
        const timestamp = new Date().toISOString();

        let book = "{{ $book }}";

        fetch('/save-highlight', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-CSRF-TOKEN': document.querySelector('meta[name="csrf-token"]').getAttribute('content')
            },
            body: JSON.stringify({
                text: selectedText,
                hash: contextHash,
                surrounding_hash: contextHash,
                book: book,
                start_xpath: startXPath,
                end_xpath: endXPath,
                start_position: startPosition, // Send start position
                end_position: endPosition,     // Send end position
                created_at: timestamp
            })
        })
        .then(response => {
            if (!response.ok) {
                return response.text().then(text => { throw new Error(text); });
            }
            return response.json();
        })
        .then(data => {
            console.log('Highlight saved:', data);

            return fetch('/update-markdown', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-CSRF-TOKEN': document.querySelector('meta[name="csrf-token"]').getAttribute('content')
                },
                body: JSON.stringify({
                    text: selectedText,
                    hash: contextHash,
                    surrounding_hash: contextHash,
                    book: book,
                    start_xpath: startXPath,
                    end_xpath: endXPath
                })
            });
        })
        .then(response => {
            if (!response.ok) {
                return response.text().then(text => { throw new Error(text); });
            }
            console.log('Markdown file updated');
        })
        .catch(error => {
            console.error('Error:', error);
        });
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

    // Function to normalize XPath to match backend format
    function normalizeXPath(xpath) {
        // Remove the initial /html/body/div[1]/div[1] from the XPath to match the backend format
        return xpath.replace(/^\/html\/body\/div\[1\]/, '').replace(/^\/div\[1\]/, '');
    }

    function getExtendedSurroundingContext(range) {
        const contextBefore = range.startContainer.textContent.slice(Math.max(0, range.startOffset - 50), range.startOffset);
        const contextAfter = range.endContainer.textContent.slice(range.endOffset, range.endOffset + 50);
        return contextBefore + range.toString() + contextAfter;
    }
</script>










@endsection
