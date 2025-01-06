@extends('layout')

@section('styles')

     @vite(['resources/css/app.css', 'resources/css/div-editor.css'])
    

@endsection

@section('content')


     <!-- Add the <base> tag here to ensure correct resolution of relative URLs -->
    <base href="{{ url('markdown/' . $book . '/epub_original/') }}">
    <!-- Load the content of the main-text.md file -->

     <div id="main-content" data-book="{{ $book }}" contenteditable="true">
    {{ File::get(resource_path("markdown/{$book}/main-text.md")) }}
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

    <script src="https://cdnjs.cloudflare.com/ajax/libs/crypto-js/4.1.1/crypto-js.min.js"></script>

    <!-- Local -->
    @vite(['resources/js/app.js', 'resources/js/lazy-loading-div.js', 'resources/js/div-editor.js'])



@endsection
