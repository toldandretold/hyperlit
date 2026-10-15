@extends('layout')

{{-- Hyperlit's own English UI. Served with HTTP 410 by TextController for a
     library row whose visibility = 'deleted' — the row is kept (slug reserved,
     content scrubbed) so this URL can answer honestly forever. --}}
@php($htmlLang = 'en')
@php($pageTitle = 'Deleted — Hyperlit')

@section('styles')
    @vite(['resources/css/app.css'])
@endsection

@section('content')
<div style="display: flex; align-items: center; justify-content: center; min-height: 70vh; padding: 20px; box-sizing: border-box;">
  <main style="text-align: center; color: var(--color-text); font-family: Inter, Arial, sans-serif;">
    <h1 style="color: var(--color-secondary); font-size: 22px; margin: 0 0 10px;">This book was deleted by its author</h1>
    <p style="opacity: 0.7; font-size: 14px; margin: 0 0 24px;">The content is gone and this address will not be reused.</p>
    <a href="/" style="color: var(--color-secondary); font-size: 14px;">← Hyperlit home</a>
  </main>
</div>
@endsection
