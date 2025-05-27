@extends('layout')

@section('styles')

    @vite(['resources/css/app.css', 'resources/css/reader.css', 'resources/css/highlight-div.css', 'resources/css/containers.css', 'resources/css/buttons.css', 'resources/css/form.css'])

    <meta name="process-cite-route" content="{{ route('processCite') }}">

    
    @endsection

@section('content')

<body data-page="home">


<!-- resources/markdown/home/main-text.md is loaded below a hyperlit logo,  -->
<div class="content-wrapper" style="max-width: 60ch; margin: 0 auto;">
    <div class="scroll-container">
        <!-- Image Container -->
        <div id="imageContainer" class="top-content">
            <img src="http://127.0.0.1:8000/images/titleLogo.png" id="top" alt="Title Logo">
        </div>
        
        <div id="home" class="main-content">
            <!-- Your content here -->
        </div>
    </div>
</div>

<!-- Buttons for hyper-lighting -->
<div id="hyperlight-buttons" style="display: none; position: absolute; z-index: 9999;">
  <button id="copy-hyperlight" type="button">
    <svg 
    id="svgHighlighter" 
    xmlns="http://www.w3.org/2000/svg" 
    width="16" 
    height="16"
    >
    <rect 
    width="16" 
    height="16" 
    fill="#EE4A95" 
    rx="4" 
    ry="4" />
        </svg>
    </button>

  <button id="delete-hyperlight" type="button">🗑️</button>
  
  <button id="copy-hypercite" type="button">
    <svg
    id="svgHyperciter"
    viewBox="0 0 15 16"
    width="16"
    height="16"
     xmlns="http://www.w3.org/2000/svg"
    >
    <!-- Background rectangle -->
    <rect width="15" height="16" fill="#221F20" />
    <!-- Quotation mark symbol -->
    <path
    fill="#CBCCCC"
    d="M6.5 3.5H1.5V8.5H3.75L1.75 12.5H4.75L6.5 9V3.5zM13.5 3.5H8.5V8.5H10.75L8.75 12.5H11.75L13.5 9V3.5z"
        />
        </svg>
    </button>
</div>

<!-- buttons: clockwise from top-lept -->
<div id="userContainer" onclick="window.location.href='{{ url('/') }}';">
    <svg 
    id="userLogo" 
    xmlns="http://www.w3.org/2000/svg" 
    xmlns:xlink="http://www.w3.org/1999/xlink" 
    version="1.1" 
    viewBox="198 40 604 582">
        <g transform="matrix(1,0,0,-1,197.42373,1300.6102)">
        <path d="M473.1,779.8c-15.2-14.5-35.4-21.7-60.6-21.7H139.4 c-25.2,0-45.4,7.2-60.6,21.7s-19.5,56.4-17.3,68.6s4.9,23.5,8.3,33.9c3.3,10.4,7.8,20.6,13.4,30.5s12.1,18.3,19.4,25.3 c7.3,7,16.2,12.6,26.7,16.7s22.1,6.2,34.8,6.2c1.9,0,6.2-2.2,13.1-6.7s14.6-9.5,23.3-15s19.9-10.5,33.8-15 c13.9-4.5,27.8-6.7,41.7-6.7s27.9,2.2,41.7,6.7s25.1,9.5,33.8,15s16.4,10.5,23.3,15s11.2,6.7,13.1,6.7c12.7,0,24.3-2.1,34.8-6.2 c10.5-4.2,19.4-9.7,26.7-16.7c7.3-7,13.8-15.4,19.4-25.3s10.1-20.1,13.4-30.5c3.3-10.4,6.1-21.7,8.3-33.9 S488.3,794.3,473.1,779.8z M395.9,1061.1c0-33.1-11.7-61.4-35.2-84.8s-51.7-35.2-84.8-35.2s-61.4,11.7-84.8,35.2 s-35.2,51.7-35.2,84.8s11.7,61.4,35.2,84.8s51.7,35.2,84.8,35.2s61.4-11.7,84.8-35.2S395.9,1094.2,395.9,1061.1z"/>
        </g>
        <path d="M667.2,293.2H621v-27.3h46.2v-48.3h28.3v48.3h46.2v27.3 h-46.2v48.3h-28.3V293.2z"/>
        </svg>
</div>

<div id="topRightContainer">
    <button type="button" id="newBook" class="open"><span class="icon">+</span></button>
</div>

<div id="nav-buttons"> <!-- bottom right buttons -->
    <button type="button" id="editButton">
        <svg 
        width="24" 
        height="24" 
        viewBox="0 0 24 24" 
        fill="none" 
        stroke-width="2" 
        stroke-linecap="round" 
        stroke-linejoin="round"
            >
        <path d="M12 20h9" />
        <path d="M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4 12.5-12.5z" />
            </svg>
        </button>
    
    <button type="button" id="toc-toggle-button">
        <svg
        width="36px"
        height="36px"
        viewBox="0 0 24.75 24.75"
        version="1.1"
        xmlns="http://www.w3.org/2000/svg"
        xmlns:xlink="http://www.w3.org/1999/xlink"
            >
        <!-- Background rectangle -->
        <rect width="24.75" height="24.75" fill="#221F20" />
        <g fill="#CBCCCC">
        <path
        d="M0,3.875c0-1.104,0.896-2,2-2h20.75c1.104,0,2,0.896,2,2s-0.896,2-2,2H2
       C0.896,5.875,0,4.979,0,3.875z"
        />
        <path
        d="M22.75,10.375H2c-1.104,0-2,0.896-2,2c0,1.104,0.896,2,2,2h20.75c1.104,0,2-0.896,2-2
       C24.75,11.271,23.855,10.375,22.75,10.375z"
            />
        <path
        d="M22.75,18.875H2c-1.104,0-2,0.896-2,2s0.896,2,2,2h20.75c1.104,0,2-0.896,2-2
       S23.855,18.875,22.75,18.875z"
        />
        </g>
        </svg>
    </button>
</div>

<!-- toggle hidden containers -->
<div id="toc-container" class="hidden"></div>
<div id="highlight-container" class="hidden" contenteditable="true"></div>
<div id="hypercite-container" class="hidden"></div>
<div id="source-container" class="hidden"></div>
<div id="ref-container" class="hidden"></div>


<div id="newbook-container" class="hidden">
  <button id="createNewBook" typ="button">new</button>
  <button id="importBook" typ="button">import</button>
</div>

<div id="importCitation-container">
     <form id="cite-form" action="{{ route('processCite') }}" method="POST" enctype="multipart/form-data">
    @csrf

    <!-- Drag and drop field for Markdown file -->
    <label for="markdown_file">Upload Markdown or EPUB File:</label>
    <input type="file" id="markdown_file" name="markdown_file" accept=".md,.epub,.doc,.docx">

    <!-- Paste BibTeX details -->
    <label for="bibtex">Paste BibTeX Details:</label>
    <textarea id="bibtex" name="bibtex"></textarea>

    <!-- BibTeX Type Selection -->
    <label for="type">Type:</label>
    <label><input type="radio" name="type" value="article"> Article</label>
    <label><input type="radio" name="type" value="book"> Book</label>
    <label><input type="radio" name="type" value="phdthesis"> PhD Thesis</label>
    <label><input type="radio" name="type" value="misc"> Miscellaneous</label>
    

    <!-- Shared Input Fields -->
    <div id="common-fields">
        <label for="citation_id">Citation ID:</label>
        <input type="text" id="citation_id" name="citation_id">

        <label for="author">Author:</label>
        <input type="text" id="author" name="author">

        <label for="title">Title:</label>
        <input type="text" id="title" name="title">

        <label for="year">Year:</label>
        <input type="number" id="year" name="year">

        <label for="url">URL:</label>
        <input type="text" id="url" name="url">

        <label for="pages" class="optional-field" style="display:none;">Pages:</label>
        <input type="text" id="pages" name="pages" class="optional-field" style="display:none;">

        <label for="journal" class="optional-field" style="display:none;">Journal:</label>
        <input type="text" id="journal" name="journal" class="optional-field" style="display:none;">

        <label for="publisher" class="optional-field" style="display:none;">Publisher:</label>
        <input type="text" id="publisher" name="publisher" class="optional-field" style="display:none;">

        <label for="school" class="optional-field" style="display:none;">School:</label>
        <input type="text" id="school" name="school" class="optional-field" style="display:none;">

        <label for="note" class="optional-field" style="display:none;">Note:</label>
        <input type="text" id="note" name="note" class="optional-field" style="display:none;">
    </div>

    <button type="submit" id="createButton" class="formButton">Create</button>
    <button type="button" id="clearButton" class="formButton">Clear</button>
</form>
</div>




<div id="toc-overlay"></div>
<div id="ref-overlay"></div>
    


</body>

@endsection

@section('scripts')

<script src="{{ asset('js/crypto-js.min.js') }}"></script>
<script src="{{ asset('js/rangy-core.min.js') }}"></script>
<script src="{{ asset('js/rangy-classapplier.min.js') }}"></script>
<script src="{{ asset('js/rangy-highlighter.min.js') }}"></script>



 
@vite([
    'resources/js/reader-DOMContentLoaded.js',
    'resources/js/renderOpenBooks.js'
])




    
@endsection

    
        
       

