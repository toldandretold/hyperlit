@extends('layout')

{{-- Hyperlit's own English UI. Served by TextController for a work Hyperlit HOLDS but does not
     publish (App\Services\Licensing\HostingPolicy): a web page saved as citation-review
     evidence, or a closed / all-rights-reserved work. Old review reports link here, so the
     address answers with the citation and the ORIGINAL — never the text. --}}
@php($htmlLang = 'en')
@php($pageTitle = ($title ?: 'Source') . ' — Hyperlit')

@section('styles')
    @vite(['resources/css/app.css'])
@endsection

@section('content')
<div style="display: flex; align-items: center; justify-content: center; min-height: 70vh; padding: 20px; box-sizing: border-box;">
  <main style="max-width: 560px; color: var(--color-text); font-family: Inter, Arial, sans-serif;">
    <h1 style="color: var(--color-secondary); font-size: 22px; margin: 0 0 10px;">{{ $title ?: 'Source' }}</h1>
    @if ($byline)
      <p style="opacity: 0.8; font-size: 15px; margin: 0 0 16px;">{{ $byline }}</p>
    @endif
    <p style="opacity: 0.7; font-size: 14px; margin: 0 0 20px;">
      Hyperlit checked a citation against this source, but it isn't ours to republish, so its text isn't shown here.
    </p>
    @if ($originalUrl)
      <p style="margin: 0 0 24px;"><a href="{{ $originalUrl }}" rel="noopener" style="color: var(--color-secondary); font-size: 15px;">Read it at the original{{ $host ? " ({$host})" : '' }} ↗</a></p>
    @endif
    <a href="/" style="color: var(--color-secondary); font-size: 14px;">← Hyperlit home</a>
  </main>
</div>
@endsection
