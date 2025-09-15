@extends('layout')

@section('styles')
    @vite(['resources/css/app.css', 'resources/css/layout.css'])
@endsection

@section('content')
<div class="container" style="margin: 1.5rem 0;">
    <h2 style="font-size: 1.25rem; font-weight: 600; margin-bottom: 0.75rem;">{{ $username }}’s Books</h2>

    @if (isset($uploads) && $uploads->count())
        <ul>
            @foreach ($uploads as $upload)
                <li style="margin: 0.25rem 0;">
                    <a href="/{{ $upload->book }}" style="text-decoration: underline;">
                        {{ $upload->title ?? $upload->book }}
                    </a>
                    @if(!empty($upload->author) || !empty($upload->year))
                        <span style="color:#888;"> — {{ $upload->author ?? 'Anon.' }} {{ $upload->year ? '(' . $upload->year . ')' : '' }}</span>
                    @endif
                </li>
            @endforeach
        </ul>
        <div style="margin-top: 0.75rem;">
            {{ $uploads->links() }}
        </div>
    @else
        <p>No books at the moment</p>
    @endif
</div>
@endsection

@section('scripts')
@endsection
