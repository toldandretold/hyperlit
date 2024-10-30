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

        h1 {
    color: #4CAF50; /* Example color */
            }
        h2 {
    color: #FF5722;
            }
        /* Blockquotes */
        blockquote {
            color: #9E9E9E;
            border-left: 3px solid #FF5722;
            padding-left: 10px;
        }
        /* Code blocks */
        pre code {
            background-color: #F5F5F5;
            color: #333;
        }




    </style>
@endsection

@section('content')

    <div>
        <!-- Markdown Editor (Textarea) -->
        <textarea id="markdown-IT-editor" name="markdown_it_content" rows="10"> {!! File::get(resource_path("markdown/{$book}/main-text.md")) !!}</textarea>
    </div>

    <div style="position: fixed; bottom: 10px; width: 100%;">
        <button type="button" id="saveButton">Save</button>
        <button type="button" id="div-link">html</button>
    </div>

    <div style="position: fixed; top: 10px; right: 10px;">
    <button type="button" id="readButton">Read</button>
    </div>

@endsection

@section('scripts')
    <script src="https://cdn.jsdelivr.net/npm/markdown-it/dist/markdown-it.min.js"></script>
    <script src="https://cdnjs.cloudflare.com/ajax/libs/crypto-js/4.1.1/crypto-js.min.js"></script>
    

    <script>
    
        // Define book directly from the Blade variable
    let book = @json($book);  // Converts PHP variable to JSON-safe format for JavaScript
    window.book = book; // Make it globally accessible if necessary

 
      
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


    document.getElementById('saveButton').addEventListener('click', function () {
    // Get the raw Markdown content from the textarea
    const content = document.getElementById('markdown-IT-editor').value;

    fetch(`/save-md-content`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-CSRF-TOKEN': document.querySelector('meta[name="csrf-token"]').getAttribute('content')
        },
        body: JSON.stringify({ book: book, updated_markdown: content })
    })
    .then(response => {
        if (response.ok) {
            alert('Content saved successfully!');
        } else {
            alert('Failed to save content.');
        }
    })
    .catch(error => {
        console.error('Error:', error);
        alert('An error occurred while saving.');
    });
});
    

 
     // Redirect to /{book}/md when the Markdown button is clicked
    document.getElementById('div-link').addEventListener('click', function () {
        window.location.href = `/${book}/div`;
    });

    // Redirect to /{book} when the read button is pressed
    document.getElementById('readButton').addEventListener('click', function () {
        window.location.href = `/${book}`;
    });




    
    </script>
@endsection
