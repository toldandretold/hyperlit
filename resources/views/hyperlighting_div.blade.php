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
    </style>
@endsection

@section('content')

    <!-- Load the content of the main-text.html file -->
    <div id="main-content" data-book="{{ $book }}" contenteditable="true">
        {!! File::get(resource_path("markdown/{$book}/main-text.html")) !!}
    </div>

    <!-- Buttons for hyper-lighting -->
    <div id="hyperlight-buttons" style="display: none; position: absolute; z-index: 9999;">
        <button id="copy-hyperlight">Hyperlight</button>
        <button id="delete-hyperlight" type="button" style="display:none;">Delete</button>
    </div>

@endsection

@section('scripts')
    <script src="https://cdnjs.cloudflare.com/ajax/libs/crypto-js/4.1.1/crypto-js.min.js"></script>
    

    <script>

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

 

    



    
    </script>
@endsection
