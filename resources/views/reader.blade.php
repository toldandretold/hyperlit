@extends('layout')

@section('styles')

    @vite(['resources/css/app.css', 'resources/css/reader.css', 'resources/css/highlight-div.css', 'resources/css/containers.css', 'resources/css/buttons.css'])
    @endsection
@section('content')

    <!-- Add the <base> tag here to ensure correct resolution of relative URLs -->
    <base href="{{ url('markdown/' . $book . '/epub_original/') }}">


   <div id="logoContainer" onclick="window.location.href='{{ url('/') }}';">
      <img src="{{ asset('images/logoa.png') }}" id="logo" alt="Logo">

    </div>

    <!-- Load the content of the main-text.md file -->

    <div id="{{ $book }}" class="main-content"> 
    </div>

    <!-- Buttons for hyper-lighting -->
 
       <div
  id="hyperlight-buttons"
  style="display: none; position: absolute; z-index: 9999;"
>
  <button id="copy-hyperlight" type="button">
   <svg id="svgHighlighter" xmlns="http://www.w3.org/2000/svg" width="16" height="16">
  <rect width="16" height="16" fill="#EE4A95" rx="4" ry="4" />
</svg>
  </button>
  <button id="delete-hyperlight" type="button">🗑️</button>
</div>

    <!-- Button edit -->
    <div id="nav-buttons">
    <button type="button" id="editButton">
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" 
     stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M12 20h9" />
    <path d="M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4 12.5-12.5z" />
  </svg>
</button>
    <button type="button" id="toc-toggle-button"></button>
    </div>

    <!-- Container for the Table of Contents -->
    <div id="toc-container" class="hidden"></div>
    <div id="highlight-container" class="hidden" contenteditable="true"></div>
    <div id="hypercite-container" class="hidden"></div>
    <div id="toc-overlay"></div>


    <!-- Container for references and highlights -->
    <div id="ref-container" class="hidden">
        
    </div>
    <div id="ref-overlay"></div>
    
    
    

    

@endsection

@section('scripts')

<script src="{{ asset('js/crypto-js.min.js') }}"></script>
<script src="{{ asset('js/rangy-core.min.js') }}"></script>
<script src="{{ asset('js/rangy-classapplier.min.js') }}"></script>
<script src="{{ asset('js/rangy-highlighter.min.js') }}"></script>


 
@vite([
    'resources/js/reader-DOMContentLoaded.js'
])


    
@endsection
