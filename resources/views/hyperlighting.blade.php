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


    <?php
    use League\CommonMark\CommonMarkConverter;

    $filePath = resource_path('markdown/Need_to_do.md');
    $markdown = file_get_contents($filePath);

    $converter = new CommonMarkConverter();
    $html = $converter->convertToHtml($markdown);
    ?>

    {!! $html !!}

    <!-- Buttons for hyper-lighting -->
    <div id="hyperlight-buttons" style="display:none;">
        <button id="copy-hyperlight">Copy Hyperlight</button>
        <button id="hyper-cite" style="display:none;">Hyper-Cite</button>
    </div>

   <script>
    document.addEventListener('mouseup', function() {
        let selectedText = window.getSelection().toString().trim();

        if (selectedText.length > 0) {
            document.getElementById('hyperlight-buttons').style.display = 'block';
            
            if (checkForOverlappingHighlights()) {
                showDeleteHighlightsButton();
            }
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

        // Get the full text content of the body
        let bodyText = document.body.innerText || document.body.textContent;

        // Calculate the position of the first and last characters in the entire body text
        let startIndex = bodyText.indexOf(selectedText);
        let endIndex = startIndex + selectedText.length - 1;

        if (startIndex === -1 || endIndex === -1) {
            console.error('Could not determine the positions in the text.');
            return;
        }

        // Generate the highlight ID and numerical value
        let numerical = startIndex + 1 + endIndex + 1; // Adding 1 to convert from 0-based index to 1-based
        let highlightId = `pos_${startIndex + 1}_${endIndex + 1}_${numerical}`;

        // Immediate feedback: Wrap the selected text with <mark> and <a> in the DOM
        let mark = document.createElement('mark');
        let a = document.createElement('a');
        a.setAttribute('href', `/hyper-lights#${highlightId}`);
        a.setAttribute('id', highlightId);

        try {
            range.surroundContents(a);
            console.log('Wrapped text:', a.outerHTML);
        } catch (error) {
            console.error('Error surrounding content:', error);
            return;
        }

        a.parentNode.insertBefore(mark, a);
        mark.appendChild(a);

        // Now proceed with saving the highlight and updating the markdown file in the background
        fetch('/save-highlight', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-CSRF-TOKEN': document.querySelector('meta[name="csrf-token"]').getAttribute('content')
            },
            body: JSON.stringify({
                text: selectedText, // Plain text is sent to the server
                id: highlightId,
                numerical: numerical
            })
        })
        .then(response => {
            if (!response.ok) {
                return response.text().then(text => { throw new Error(text); });
            }
            return response.json(); // Directly parse as JSON
        })
        .then(data => {
            console.log('Highlight saved:', data);

            // Update the markdown file with the new highlight in the background
            fetch('/update-markdown', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-CSRF-TOKEN': document.querySelector('meta[name="csrf-token"]').getAttribute('content')
                },
                body: JSON.stringify({
                    text: selectedText, // Pass the plain text to update the markdown
                    numerical: numerical,
                    startIndex: startIndex,
                    highlightId: highlightId // Send the highlight ID for proper linking
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

    function checkForOverlappingHighlights() {
        const selection = window.getSelection();
        if (selection.rangeCount === 0) return false;

        const range = selection.getRangeAt(0);
        const container = range.commonAncestorContainer;

        // If the container is a text node, go up to the parent element
        const parentElement = container.nodeType === 3 ? container.parentElement : container;

        // Check if any <mark> or <a> tags related to hyperlighting are within the selected range
        const marks = parentElement.querySelectorAll('mark');
        const hyperlightLinks = parentElement.querySelectorAll('a[href^="/hyper-lights#"]');

        let overlapDetected = false;

        marks.forEach(mark => {
            if (range.intersectsNode(mark)) {
                overlapDetected = true;
            }
        });

        hyperlightLinks.forEach(link => {
            if (range.intersectsNode(link)) {
                overlapDetected = true;
            }
        });

        return overlapDetected;
    }

    function showDeleteHighlightsButton() {
        const deleteButton = document.createElement('button');
        deleteButton.innerText = 'Delete Highlights';
        deleteButton.id = 'delete-highlights-btn';
        deleteButton.onclick = removeHyperlightTags;
        
        const copyHighlightButton = document.getElementById('copy-hyperlight');
        copyHighlightButton.parentNode.insertBefore(deleteButton, copyHighlightButton.nextSibling);
    }

    function removeHyperlightTags() {
        const selection = window.getSelection();
        const range = selection.getRangeAt(0);
        const container = range.commonAncestorContainer;

        const parentElement = container.nodeType === 3 ? container.parentElement : container;


        const hyperlightLinks = parentElement.querySelectorAll('a[href^="/hyper-lights#"]');
        hyperlightLinks.forEach(link => {
            if (range.intersectsNode(link)) {
                link.replaceWith(link.textContent);
            }
        });

        // Send the delete request to the server to mark the highlight as deleted
        const highlightId = hyperlightLinks.length > 0 ? hyperlightLinks[0].id : null;
        if (highlightId) {
            fetch('/delete-highlight', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-CSRF-TOKEN': document.querySelector('meta[name="csrf-token"]').getAttribute('content')
                },
                body: JSON.stringify({
                    id: highlightId
                })
            })
            .then(response => response.json())
            .then(data => {
                if (data.success) {
                    console.log('Highlight marked as deleted:', data);
                } else {
                    console.error('Failed to delete highlight:', data.message);
                }
            })
            .catch(error => {
                console.error('Error:', error);
            });

            // Remove the <mark> and <a> tags on the front-end
        const marks = parentElement.querySelectorAll('mark');
        marks.forEach(mark => {
            if (range.intersectsNode(mark)) {
                mark.replaceWith(mark.textContent);
            }
        });
        
        }

        // Remove the 'Delete Highlights' button after use
        const deleteButton = document.getElementById('delete-highlights-btn');
        if (deleteButton) {
            deleteButton.remove();
        }
    }
</script>






@endsection