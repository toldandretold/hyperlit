@extends('layout')

@section('styles')
    <link rel="stylesheet" href="{{ asset('css/reader.css') }}">

    <style>
        #markdown-IT-editor {
            width: 100%;
            height: calc(100vh - 60px);
            border: none;
            outline: none;
            padding: 20px;
            box-sizing: border-box;
            font-family: 'Arial', sans-serif;
            font-size: 16px;
            line-height: 1.6;
            background-color: #221F20;
            resize: none;
            color: #CBCCCC;
        }

        #markdown-it-preview {
            margin: 20px;
            background-color: #221F20;
            padding: 20px;
            border-radius: 8px;
        }

        button {
            background-color: #444;
            color: #fff;
            border: 1px solid #777;
            padding: 10px 20px;
            border-radius: 5px;
            font-weight: 600;
            box-shadow: 0px 2px 5px rgba(0, 0, 0, 0.5);
            transition: background-color 0.3s ease, box-shadow 0.3s ease;
        }

        button:hover {
            background-color: #555;
            box-shadow: 0px 4px 6px rgba(0, 0, 0, 0.3);
        }
    </style>
@endsection

@section('content')
    <div>
        <!-- Markdown Editor (Textarea) -->
        <textarea id="markdown-IT-editor" name="markdown_it_content" rows="10">{{ $content }}</textarea>
    </div>

    <div style="position: fixed; bottom: 10px; width: 100%;">
        <button type="button" id="saveButton">Save</button>
        <button type="button" id="toggle-preview">Preview</button>
        <button type="button" id="html-link">HTML</button>
    </div>

    <div id="markdown-it-preview" style="display: none;"></div>
@endsection

@section('scripts')
  <script src="https://cdn.jsdelivr.net/npm/markdown-it/dist/markdown-it.min.js"></script>
<script>
    document.getElementById('html-link').addEventListener('click', function() {
        const book = 'to-do_two';  // Use the book variable from Laravel
        window.location.href = `/${book}/hyperlights`;  // Redirect to the Markdown version
    });

    document.addEventListener('DOMContentLoaded', function() {
        const md = markdownit();
        const editorElement = document.getElementById('markdown-IT-editor');
        const previewElement = document.getElementById('markdown-it-preview');
        const saveButton = document.getElementById('saveButton');
        const togglePreviewButton = document.getElementById('toggle-preview');

        // Object to store initial links before editing
        const initialLinks = [];

        // Parse initial markdown and store links when the page first loads
        const rawMarkdown = editorElement.value;  // Raw markdown on page load
        const initialParsed = md.parse(rawMarkdown, {});  // Use markdown-it to parse the markdown

        console.log('Parsed tokens:', initialParsed);  // Log the parsed token structure for debugging

        // Traverse parsed tokens to store links within blockquotes
        let insideBlockquote = false;
        initialParsed.forEach((token) => {
            if (token.type === 'blockquote_open') {
                insideBlockquote = true;  // We're now inside a blockquote
            }

            if (insideBlockquote && token.type === 'inline') {
                // Inline tokens contain the actual text, including links
                token.children.forEach((childToken) => {
                    if (childToken.type === 'link_open') {
                        const href = childToken.attrGet('href');
                        if (href && href.includes('#')) {
                            initialLinks.push(href);  // Store the full link
                            console.log('Stored link inside blockquote:', href);  // Debugging log for stored links
                        }
                    }
                });
            }

            if (token.type === 'blockquote_close') {
                insideBlockquote = false;  // Exiting the blockquote
            }
        });

        console.log('Initial links:', initialLinks);  // Debugging log for initial links

        // Toggle preview visibility
        togglePreviewButton.addEventListener('click', () => {
            if (previewElement.style.display === 'none') {
                previewElement.innerHTML = md.render(editorElement.value);  // Convert markdown to HTML
                previewElement.style.display = 'block';  // Show preview
                editorElement.style.display = 'none';  // Hide editor
                togglePreviewButton.innerText = 'Hide Preview';
            } else {
                previewElement.style.display = 'none';  // Hide preview
                editorElement.style.display = 'block';  // Show editor
                togglePreviewButton.innerText = 'Preview';
            }
        });

        // Save button functionality
        saveButton.addEventListener('click', () => {
            const rawMarkdown = editorElement.value;  // Get the updated raw markdown from the editor
            const renderedHTML = md.render(rawMarkdown);  // Convert markdown to HTML

            const tempDiv = document.createElement('div');
            tempDiv.innerHTML = renderedHTML;
            const blockquotes = tempDiv.querySelectorAll('blockquote');
            const annotations = [];
            const deletedHighlights = [];  // Array to track deleted highlight_ids

            // Array to store current links in the updated markdown
            const currentLinks = [];

            blockquotes.forEach((blockquote) => {
                const highlightLink = blockquote.querySelector('a');
                const annotation = [];

                // Check for annotation text before <hr>
                let sibling = blockquote.nextElementSibling;
                while (sibling && sibling.tagName !== 'HR') {
                    annotation.push(sibling.outerHTML.trim());  // Use `outerHTML` to preserve full structure (HTML tags)
                    sibling = sibling.nextElementSibling;
                }

                const annotationText = annotation.join(' ').trim();

                if (highlightLink) {
                    const highlightId = decodeURIComponent(highlightLink.getAttribute('href').split('#')[1]);
                    annotations.push({
                        highlight_id: highlightId,
                        annotation: annotationText  // Now preserving HTML or Markdown syntax
                    });

                    // Store the current link
                    currentLinks.push(highlightLink.getAttribute('href'));
                }
            });

            // Compare initialLinks with currentLinks to detect deleted links
            initialLinks.forEach((initialLink) => {
                if (!currentLinks.includes(initialLink)) {
                    // Link was deleted, extract highlight_id
                    const highlightId = initialLink.split('#')[1].split(')')[0];  // Extract the text between # and )
                    deletedHighlights.push({ highlight_id: highlightId });
                    console.log('Deleted highlight detected:', highlightId);  // Debugging log for deleted highlight
                }
            });

            // Debugging log to check what is being sent
            console.log('Annotations:', annotations);
            console.log('Deleted highlights:', deletedHighlights);

            // Send content, annotations, and deleted highlights to the server
                // Send annotations and update markdown
        fetch('{{ route("highlight.update-annotations-md", ["book" => $book]) }}', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-CSRF-TOKEN': '{{ csrf_token() }}'
            },
            body: JSON.stringify({
                markdown: rawMarkdown,  // Send raw markdown content
                annotations: annotations  // Send annotations with preserved HTML
            })
        })
        .then(response => response.json())
        .then(data => {
            if (!data.success) {
                alert('Failed to save content.');
            }
            console.log('Content saved:', rawMarkdown, 'Annotations:', annotations);

            // After saving annotations, check if there are any deleted highlights to process
            if (deletedHighlights.length > 0) {
                // Send deleted highlights to the server
                fetch('{{ route("highlight.mark-as-deleted-md", ["book" => $book]) }}', {
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
                    }
                    console.log('Deleted highlights processed:', deletedHighlights);
                });
            }
        });
    });
});
</script>



@endsection

