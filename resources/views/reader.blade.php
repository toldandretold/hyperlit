@extends('layout')

@section('styles')

    @vite(['resources/css/app.css', 'resources/css/reader.css'])
    @endsection

@section('content')

    <!-- Add the <base> tag here to ensure correct resolution of relative URLs -->
    <base href="{{ url('markdown/' . $book . '/epub_original/') }}">


    <!-- Load the content of the main-text.md file -->

    <div id="main-content" data-book="{{ $book }}">
    {{ File::get(resource_path("markdown/{$book}/main-text.md")) }}
</div>

    <!-- Buttons for hyper-lighting -->
    <div id="hyperlight-buttons" style="display: none; position: absolute; z-index: 9999;">
        <button id="copy-hyperlight">Hyperlight</button>
        <button id="delete-hyperlight" type="button" style="display:none;">Delete</button>
    </div>


    <div style="position: fixed; top: 10px; left: 10px;">
    <button type="button" id="toc-toggle-button">Contents</button>
    </div>

    <div style="position: fixed; top: 10px; right: 10px;">
    <button type="button" id="editButton">Edit</button>
    </div>

    <!-- Container for the Table of Contents -->
    <div id="toc-container" class="hidden"></div>
    <div id="toc-overlay"></div>

@endsection

@section('scripts')
    <script src="https://cdnjs.cloudflare.com/ajax/libs/crypto-js/4.1.1/crypto-js.min.js"></script>
    <script src="https://cdnjs.cloudflare.com/ajax/libs/rangy/1.3.0/rangy-core.min.js"></script>
    <script src="https://cdnjs.cloudflare.com/ajax/libs/rangy/1.3.0/rangy-classapplier.min.js"></script>
    <script src="https://cdnjs.cloudflare.com/ajax/libs/rangy/1.3.0/rangy-highlighter.min.js"></script>
    


@vite(['resources/js/app.js', 'resources/js/lazy-loading.js', 'resources/js/reader.js'])
    
@endsection
