@extends('layout')

@section('styles')
    

    <link rel="stylesheet" href="{{ asset('css/reader.css') }}">

    <style>
        #markdown-IT-editor {
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
            resize: none;                /* Prevent resizing */
            color: #CBCCCC;
        }

        #markdown-it-preview {
            margin: 20px;
            background-color: #221F20;
            padding: 20px;
            border-radius: 8px;
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
    <div>
        <!-- Markdown Editor (Textarea) -->
        <textarea id="markdown-IT-editor" name="markdown_it_content" rows="10">{{ $content }}</textarea>
    </div>

    <div style="position: fixed; bottom: 10px; width: 100%;">
        <button type="button" id="saveButton">Save</button>
        <button type="button" id="toggle-preview">Preview</button>
    </div>

    <!-- Markdown Preview -->
    <div id="markdown-it-preview" style="display: none;"></div>
@endsection

@section('scripts')
    <script src="https://cdn.jsdelivr.net/npm/markdown-it/dist/markdown-it.min.js"></script>
    <script>
        document.addEventListener('DOMContentLoaded', function() {
            const md = markdownit();
            const editorElement = document.getElementById('markdown-IT-editor');
            const previewElement = document.getElementById('markdown-it-preview');
            const saveButton = document.getElementById('saveButton');
            const togglePreviewButton = document.getElementById('toggle-preview');

            // Toggle preview visibility
            togglePreviewButton.addEventListener('click', () => {
                if (previewElement.style.display === 'none') {
                    previewElement.innerHTML = md.render(editorElement.value); // Convert markdown to HTML
                    previewElement.style.display = 'block'; // Show preview
                    editorElement.style.display = 'none'; // Hide editor
                    togglePreviewButton.innerText = 'Hide Preview';
                } else {
                    previewElement.style.display = 'none'; // Hide preview
                    editorElement.style.display = 'block'; // Show editor
                    togglePreviewButton.innerText = 'Preview';
                }
            });

            // Save button functionality
                                saveButton.addEventListener('click', () => {
                const content = editorElement.value;
                const renderedHTML = md.render(content);

                // Extract blockquotes and annotations between them and <hr>
                const tempDiv = document.createElement('div');
                tempDiv.innerHTML = renderedHTML;
                const blockquotes = tempDiv.querySelectorAll('blockquote');
                const annotations = [];

                blockquotes.forEach(blockquote => {
                    const hr = blockquote.nextElementSibling;
                    const annotation = [];

                    // Check for annotation text before <hr>
                    let sibling = blockquote.nextElementSibling;
                    while (sibling && sibling.tagName !== 'HR') {
                        annotation.push(sibling.textContent.trim());
                        sibling = sibling.nextElementSibling;
                    }

                    const annotationText = annotation.join(' ').trim();
                    if (annotationText) {
                        // Extract the highlight ID from the backlink and decode it
                        const highlightLink = blockquote.querySelector('a');
                        const highlightId = decodeURIComponent(highlightLink.getAttribute('href').split('#')[1]);

                        annotations.push({
                            highlight_id: highlightId,
                            annotation: annotationText
                        });
                    }
                });

                // Send content and annotations to server
                fetch('{{ route("markdownIT.save", ["book" => $book]) }}', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'X-CSRF-TOKEN': '{{ csrf_token() }}'
                    },
                    body: JSON.stringify({ markdown: content, annotations: annotations })
                })
                .then(response => response.json())
                .then(data => {
                    if (!data.success) {
                        alert('Failed to save content.');
                    }
                    console.log('Content saved:', content, 'Annotations:', annotations);
                });
            });



        });
    </script>
@endsection
