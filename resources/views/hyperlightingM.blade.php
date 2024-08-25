@extends('layout')

@section('content')

    @section('styles')
    <link rel="stylesheet" href="{{ asset('css/reader.css') }}">

    <style>
    /* In your styles.css file */
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

        // Calculate the numerical value
        let numerical = calculateNumerical(range);

        // Use Rangy to highlight the selection
        highlighter.highlightSelection("highlight");

        // After the highlight is added, replace the highlighted text with <mark><a></a></mark>
        const highlights = document.querySelectorAll('mark.highlight');
        highlights.forEach(function(mark) {
            if (!mark.querySelector('a')) {
                const hash = generateFingerprint(mark.textContent || mark.innerText);
                const a = document.createElement('a');
                a.setAttribute('href', `/hyper-lights#${hash}`);
                a.setAttribute('id', hash);
                a.innerHTML = mark.innerHTML;
                mark.innerHTML = '';  // Clear the current content of <mark>
                mark.appendChild(a);  // Add the <a> inside <mark>
            }
        });

        // Save the highlight and update the markdown file in the background
        const fingerprintHash = generateFingerprint(selectedText);
        const timestamp = new Date().toISOString(); // Capture the current timestamp

        let book = "{{ $book }}"; // Get the book name from the Blade template

        console.log("Book:", book); // This should log the correct book name

        fetch('/save-highlight', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-CSRF-TOKEN': document.querySelector('meta[name="csrf-token"]').getAttribute('content')
            },
            body: JSON.stringify({
                text: selectedText,
                hash: fingerprintHash, // Save the hash for backend consistency
                book: book,
                numerical: numerical, // Pass the numerical value
                created_at: timestamp   // Save the time the highlight was created
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

            // Optionally, update the markdown file with the new highlight
            fetch('/update-markdown', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-CSRF-TOKEN': document.querySelector('meta[name="csrf-token"]').getAttribute('content')
                },
                body: JSON.stringify({
                    text: selectedText,
                    hash: fingerprintHash,
                    book: book
                     // Use the hash to update the markdown
                })
            })
            .then(response => {
                if (!response.ok) {
                    return response.text().then(text => { throw new Error(text); });
                }
                console.log('Markdown file updated');
            })
            .catch(error => {
                console.error('Error updating markdown:', error);
            });

        })
        .catch(error => {
            console.error('Error:', error);
        });
    });

    // Function to calculate the numerical value based on character positions
    function calculateNumerical(range) {
        let startPosition = getTextPosition(range.startContainer, range.startOffset);
        let endPosition = getTextPosition(range.endContainer, range.endOffset);
        return startPosition + endPosition;
    }

    function getTextPosition(container, offset) {
        let position = 0;

        // Traverse all nodes before the container and add their lengths to the position
        while (container.previousSibling) {
            container = container.previousSibling;
            position += (container.textContent || container.innerText || "").length;
        }

        // Add the offset within the container
        position += offset;

        return position;
    }
</script>




@endsection
