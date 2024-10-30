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


     #main-content {
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

    <!-- Load the content of the main-text.html file -->
    <div id="main-content" data-book="{{ $book }}" contenteditable="true">
        {!! File::get(resource_path("markdown/{$book}/main-text.html")) !!}
    </div>

    <div style="position: fixed; bottom: 10px; width: 100%;">
        <button type="button" id="saveButton">Save</button>
        <button type="button" id="markdown-link">Markdown</button>
    </div>

    <div style="position: fixed; top: 10px; right: 10px;">
    <button type="button" id="readButton">Read</button>
    </div>

@endsection

@section('scripts')
    <script src="https://cdnjs.cloudflare.com/ajax/libs/crypto-js/4.1.1/crypto-js.min.js"></script>
    

    <script>

        window.addEventListener('DOMContentLoaded', () => {
    const domPath = localStorage.getItem('originalReadPath');
    if (domPath) {
        const targetElement = document.querySelector(domPath);
        if (targetElement) {
            targetElement.scrollIntoView({ behavior: 'smooth' });
        }
    }
});

    // Handle clicks on links inside the editable div
    document.getElementById('main-content').addEventListener('click', function(event) {
        if (event.target.tagName === 'A') {
            event.preventDefault();  // Prevent the editable div from taking over
            window.open(event.target.href, '_blank');  // Open the link in a new tab
        }
    });

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

    document.getElementById('main-content').addEventListener('paste', (event) => {
    event.preventDefault();
    
    // Get the HTML content from the clipboard
    const htmlContent = (event.clipboardData || window.clipboardData).getData('text/html');
    const textContent = (event.clipboardData || window.clipboardData).getData('text');

    // Check if HTML content is available; if not, fallback to plain text
    const contentToInsert = htmlContent || textContent;

    // Insert the content at the cursor position
    document.execCommand('insertHTML', false, contentToInsert);

    // Clean up inline styles after paste
    setTimeout(() => {
        const mainContent = document.getElementById('main-content');
        const elementsWithStyles = mainContent.querySelectorAll('[style]');
        
        elementsWithStyles.forEach((element) => {
            element.removeAttribute('style');
        });
    }, 0); // Timeout allows the pasted content to appear before cleanup
});


    document.getElementById('saveButton').addEventListener('click', function () {
    const content = document.getElementById('main-content').innerHTML;

    fetch(`/save-div-content/`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-CSRF-TOKEN': document.querySelector('meta[name="csrf-token"]').getAttribute('content')
        },
        body: JSON.stringify({ book: book, updated_html: content })
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
    document.getElementById('markdown-link').addEventListener('click', function () {
        window.location.href = `/${book}/md`;
    });

    
        document.getElementById('readButton').addEventListener('click', function () {
        // Set a flag indicating we're returning to the read page, not refreshing
        localStorage.setItem('fromEditPage', 'true');
        window.location.href = `/${book}`; // Replace with the actual URL of the read page
    });


 
    



    
    </script>
@endsection
