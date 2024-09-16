@extends('layout')

@section('styles')

    <link rel="stylesheet" href="{{ asset('css/reader.css') }}">

    
@endsection

@section('content')

    <form action="{{ route('markdownIT.save', ['book' => $book]) }}" method="POST">

        @csrf
        <div>

            <textarea id="markdown-IT-editor" name="markdown_it_content" rows="10">{{ $content }}</textarea>
        </div>

        <div style="position: fixed; bottom: 10px; width: 100%;">
            <button type="submit">Save</button>
            <button type="button" id="toggle-preview">Preview</button>
        </div>
        
        <div id="markdown-it-preview" style="display: none;"></div>
    </form>

@endsection 

@section('scripts')

    @vite('resources/js/app.js') <!-- Load Vite assets here to avoid conflicts -->
@endsection
