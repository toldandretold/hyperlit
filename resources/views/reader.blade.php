@extends('layout')

@section('styles')

    @vite(['resources/css/app.css', 'resources/css/reader.css', 'resources/css/highlight-div.css'])
    @endsection

@section('content')

    <!-- Add the <base> tag here to ensure correct resolution of relative URLs -->
    <base href="{{ url('markdown/' . $book . '/epub_original/') }}">


    <!-- Load the content of the main-text.md file -->

    <div id="main-content" data-book="{{ $book }}">
    
</div>

    <!-- Buttons for hyper-lighting -->
    <div id="hyperlight-buttons" style="display: none; position: absolute; z-index: 9999;">
        <button id="copy-hyperlight" type="button">Hyperlight</button>
        <button id="delete-hyperlight" type="button" style="display:none;">Delete</button>
    </div>

    <!-- Button edit -->
    <div id="nav-buttons">
    <button type="button" id="editButton">Edit</button>
    <button type="button" id="toc-toggle-button">Contents</button>
    </div>

    <!-- Container for the Table of Contents -->
    <div id="toc-container" class="hidden"></div>
    <div id="toc-overlay"></div>


    <!-- Container for references and highlights -->
    <div id="ref-container" class="hidden"></div>
    <div id="ref-overlay"></div>
    <div id="highlight-container" class="hidden" contenteditable="true"></div>
    
    

    

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
