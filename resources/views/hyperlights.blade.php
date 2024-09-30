@extends('layout')

@section('styles')
    <link rel="stylesheet" href="{{ asset('css/reader.css') }}">
    <style>
        #html-editor {
            width: 100%;
            height: calc(100vh - 60px); /* Full height minus space for buttons */
            border: none;               /* Remove border */
            outline: none;              /* Remove default focus outline */
            padding: 20px;              /* Add padding for text */
            box-sizing: border-box;     /* Ensure padding doesn’t overflow */
            font-family: 'Arial', sans-serif;  /* Make it look more like a document */
            font-size: 16px;
            line-height: 1.6;
            background-color: #221F20;   /* dark background color */
            color: #CBCCCC;
        }

        div[style*="position: fixed"] button {
            margin-right: 10px;
            padding: 10px 20px;
            font-size: 14px;
        }

        button {
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
    <!-- Editable Div to display HTML content -->
    <div id="html-editor" name="html_content" contenteditable="true">{!! $htmlContent !!}</div>

    <div style="position: fixed; bottom: 10px; width: 100%;">
        <button type="button" id="saveButton">Save</button>
        <button type="button" id="markdown-link">Markdown</button>
    </div>
@endsection

@section('scripts')
<script>
    // Handle clicks on links inside the editable div
    document.getElementById('html-editor').addEventListener('click', function(event) {
        if (event.target.tagName === 'A') {
            event.preventDefault();  // Prevent the editable div from taking over
            window.open(event.target.href, '_blank');  // Open the link in a new tab
        }
    });

    // Redirect to the markdown version
    document.getElementById('markdown-link').addEventListener('click', function() {
        const book = '{{ $book }}';  // Use the book variable from Laravel
        window.location.href = `/${book}/hyperlights.md`;  // Redirect to the Markdown version
    });

    document.addEventListener('DOMContentLoaded', function() {
        const editorElement = document.getElementById('html-editor');
        const saveButton = document.getElementById('saveButton');
        const initialLinks = [];  // Store initial links from page load

        // Gather all initial links on page load
        const initialAnchorElements = editorElement.querySelectorAll('a');  // Find all anchor tags
        initialAnchorElements.forEach(anchor => {
            const href = anchor.getAttribute('href');
            if (href && href.includes('#')) {
                initialLinks.push(href);  // Store the full link
            }
        });

        console.log('Initial links:', initialLinks);  // Debugging log for initial links

        // Save button functionality
        saveButton.addEventListener('click', () => {
            const content = editorElement.innerHTML;  // Get the entire HTML content of the editable div
            const annotationElements = editorElement.querySelectorAll('.annotation');
            const annotations = [];  // Array to store annotations
            const deletedHighlights = [];  // Array to track deleted highlights
            const currentLinks = [];  // Array to store current links

            // Loop through each annotation div and gather its data
            annotationElements.forEach(annotationDiv => {
                const highlightId = annotationDiv.getAttribute('id');  // Get the highlight_id from the div's id
                const annotationHTML = annotationDiv.innerHTML.trim();  // Get the annotation HTML content

                // Push the annotation to the array, preserving the HTML content
                annotations.push({
                    highlight_id: highlightId,
                    annotation: annotationHTML || ""  // Ensure empty annotations are included as empty strings
                });
            });

            // Gather current links after editing
            const updatedAnchorElements = editorElement.querySelectorAll('a');  // Find all anchor tags
            updatedAnchorElements.forEach(anchor => {
                const href = anchor.getAttribute('href');
                if (href && href.includes('#')) {
                    currentLinks.push(href);  // Store current links
                }
            });

            // Compare initialLinks with currentLinks to detect deleted links
            initialLinks.forEach(initialLink => {
                if (!currentLinks.includes(initialLink)) {
                    // Link was deleted, extract highlight_id
                    const highlightId = initialLink.split('#')[1];  // Extract the highlight_id
                    deletedHighlights.push({ highlight_id: highlightId });
                    console.log('Deleted highlight detected:', highlightId);  // Debugging log for deleted highlight
                }
            });

            // Debugging log to check what is being sent
            console.log('Annotations:', annotations);
            console.log('Deleted highlights:', deletedHighlights);

            // Send content, annotations, and deleted highlights to the server
            fetch('{{ route("highlight.update-annotations", ["book" => $book]) }}', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-CSRF-TOKEN': '{{ csrf_token() }}'
                },
                body: JSON.stringify({
                    htmlContent: content,  // Send the full HTML content of the editable div
                    annotations: annotations  // Send annotations
                })
            })
            .then(response => response.json())
            .then(data => {
                if (!data.success) {
                    alert('Failed to save annotations and content.');
                } else {
                    console.log('Annotations and content saved:', annotations);

                    // After saving annotations, check if there are any deleted highlights to process
                    if (deletedHighlights.length > 0) {
                        // Send deleted highlights to the server
                        fetch('{{ route("highlight.mark-as-deleted", ["book" => $book]) }}', {
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/json',
                                'X-CSRF-TOKEN': '{{ csrf_token() }}'
                            },
                            body: JSON.stringify({
                                deleted_highlights: deletedHighlights  // Send deleted highlight IDs array
                            })
                        })
                        .then(response => response.json())
                        .then(data => {
                            if (!data.success) {
                                alert('Failed to delete highlights.');
                            } else {
                                console.log('Deleted highlights processed:', deletedHighlights);
                            }
                        });
                    }
                }
            });
        });
    });
</script>


@endsection
            