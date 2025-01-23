@extends('layout')

@section('content')

@section('styles')
    <link rel="stylesheet" href="{{ asset('css/reader.css') }}">
    @endsection

    <?php
    use League\CommonMark\CommonMarkConverter;

    $filePath = storage_path('app/markdown-content.md');
    $markdown = file_get_contents($filePath);

    $converter = new CommonMarkConverter();
    $html = $converter->convertToHtml($markdown);
    ?>

    {!! $html !!}

@endsection