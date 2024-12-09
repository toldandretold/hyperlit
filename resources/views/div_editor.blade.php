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

        /* Loading indicator styling */
        #loading-indicator {
            display: none;
            position: fixed;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            z-index: 9999;
            background-color: rgba(0, 0, 0, 0.8);
            color: white;
            padding: 20px;
            border-radius: 8px;
            font-size: 18px;
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

      <div id="loading-indicator">Processing... Please wait.</div>

@endsection

@section('scripts')
     <!-- Include Pusher first -->
<script src="https://js.pusher.com/7.0/pusher.min.js"></script>

<!-- Include the Vite bundle (usually in your main layout) -->
@vite(['resources/js/echo.js']) <!-- Add echo.js here -->

<script src="https://cdnjs.cloudflare.com/ajax/libs/crypto-js/4.1.1/crypto-js.min.js"></script>
    

    <script>
    window.addEventListener('DOMContentLoaded', () => {
        // Handle clicks on links inside the editable div
        document.getElementById('main-content').addEventListener('click', function(event) {
            if (event.target.tagName === 'A') {
                
            }
        });

        let book = document.getElementById('main-content').getAttribute('data-book');
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

        attachMarkListeners();

        // Adjust internal links to handle #hash navigation properly
        const internalLinks = document.querySelectorAll('a[href^="#"]');
        internalLinks.forEach(function(link) {
            link.addEventListener('click', function(event) {
                event.preventDefault();
                const targetId = link.getAttribute('href').substring(1);
                const targetElement = document.getElementById(targetId);
                if (targetElement) {
                    targetElement.scrollIntoView({ behavior: 'smooth', block: 'start' });
                } else {
                    console.error(`Target element with ID "${targetId}" not found.`);
                }
            });
        });
    });

    let isListenerSet = false; // Flag to check if listener is already set

    function setupEchoListener() {
        window.Echo.channel('process-channel')
            .listen('.ProcessComplete', (event) => {
                console.log('Received event:', event);
                if (event.message === 'Hypercited') {
                    console.log("Citation ID B file update complete");
                    hideLoadingIndicator();
                }
            });
    }

    document.getElementById('main-content').addEventListener('paste', (event) => {
        event.preventDefault();
        const htmlContent = (event.clipboardData || window.clipboardData).getData('text/html');
        const textContent = (event.clipboardData || window.clipboardData).getData('text');
        const contentToInsert = htmlContent || textContent;
        document.execCommand('insertHTML', false, contentToInsert);

        setTimeout(() => {
            const mainContent = document.getElementById('main-content');
            const elementsWithStyles = mainContent.querySelectorAll('[style]');
            elementsWithStyles.forEach((element) => {
                element.removeAttribute('style');
            });
        }, 0);
    });

    function showLoadingIndicator() {
        document.getElementById('loading-indicator').style.display = 'block';
    }

    function hideLoadingIndicator() {
        document.getElementById('loading-indicator').style.display = 'none';
    }

    document.getElementById('saveButton').addEventListener('click', async function () {
        const content = document.getElementById('main-content').innerHTML;
            showLoadingIndicator();

        // Activate Echo listener if it hasn't been set up yet
        if (!isListenerSet) {
            setupEchoListener();
            isListenerSet = true; // Mark listener as set
        }

        try {
            const response = await fetch(`/save-div-content/`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-CSRF-TOKEN': document.querySelector('meta[name="csrf-token"]').getAttribute('content')
                },
                body: JSON.stringify({ book: book, updated_html: content })
            });

            if (response.ok) {
                console.log("Content saved successfully");
                await processHyperCiteLinks(book);
                console.log("Hypercite links are being processed...");
            } else {
                console.error('Failed to save content.');
            }
        } catch (error) {
            console.error('Error:', error);
        } 
    });

    function saveUpdatedHTMLToFile(updatedHTML, book) {
        fetch(`/save-updated-html/${book}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-CSRF-TOKEN': document.querySelector('meta[name="csrf-token"]').getAttribute('content')
            },
            body: JSON.stringify({ html: updatedHTML })
        })
        .then(response => {
            if (response.ok) {
                console.log('HTML file saved successfully!');
            } else {
                console.error('Failed to save HTML file.');
            }
        })
        .catch(error => {
            console.error('Error saving HTML file:', error);
        });
    }

    async function processHyperCiteLinks(book) {
        const mainContent = document.querySelector('#main-content');
        const parser = new DOMParser();
        const doc = parser.parseFromString(mainContent.innerHTML, 'text/html');
        const anchors = doc.querySelectorAll('a');

        for (const anchor of anchors) {
            if (anchor.textContent.includes('[:]') && !anchor.hasAttribute('id')) {
                const href = anchor.getAttribute('href');
                console.log(`Processing hyperlink with href: ${href}`);

                try {
                    const response = await fetch(`/process-hypercite-link`, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'X-CSRF-TOKEN': document.querySelector('meta[name="csrf-token"]').getAttribute('content')
                        },
                        body: JSON.stringify({ href_a: href, citation_id_b: book })
                    });

                    const data = await response.json();
                    if (data.success) {
                        console.log(`New hypercite ID assigned: ${data.new_hypercite_id_x}`);
                        anchor.setAttribute('id', data.new_hypercite_id_x);
                    } else {
                        console.log(`Processing for href=${href} stopped:`, data.message);
                    }
                } catch (error) {
                    console.error('Error processing hypercite link:', error);
                }
            }
        }

        mainContent.innerHTML = doc.body.innerHTML;
        await saveUpdatedHTMLToFile(mainContent.innerHTML, book);

        // Trigger the ProcessConnectedHyperCitesJob after the frontend has completed its updates
        fetch(`/process-connected-hypercites`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-CSRF-TOKEN': document.querySelector('meta[name="csrf-token"]').getAttribute('content')
            },
            body: JSON.stringify({ citation_id_a: book })
        });
    }

    document.getElementById('markdown-link').addEventListener('click', function () {
        window.location.href = `/${book}/md`;
    });

    document.getElementById('readButton').addEventListener('click', function () {
        localStorage.setItem('fromEditPage', 'true');
        window.location.href = `/${book}`;
    });
</script>

@endsection
