<!DOCTYPE html>
{{-- /books — the crawlable index of the public library, in journal-index
     .blade.php's standalone list style (same partials.journal-page-style, same
     .jp-* classes). $books comes from BookIndexController: public + listed,
     top-level only, alphabetical.

     The links here are the whole point of the page — see the class comment on
     BookIndexController. Keep them plain server-rendered <a href>, and keep the
     prev/next pagination links: they are how a crawl reaches past page 1. --}}
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>{{ $pageTitle }}</title>
    <meta name="description" content="{{ $pageDescription }}">
    <link rel="canonical" href="{{ $canonicalUrl }}">
    @if ($books->currentPage() > 1)
        <link rel="prev" href="{{ $books->previousPageUrl() }}">
    @endif
    @if ($books->hasMorePages())
        <link rel="next" href="{{ $books->nextPageUrl() }}">
    @endif
    @include('partials.journal-page-style')
</head>
<body>
    <script>
        (function () {
            var t = 'dark';
            try { t = localStorage.getItem('hyperlit_theme_preference') || 'dark'; } catch (e) {}
            if (['dark', 'light', 'sepia'].indexOf(t) === -1) t = 'dark';
            document.body.classList.add('theme-' + t);
        })();
    </script>

    <main class="jp-page">
        <nav class="jp-breadcrumb"><a href="/">Hyperlit</a></nav>

        <header class="jp-header">
            <h1>Books on Hyperlit</h1>
            <p class="jp-counts">
                {{ number_format($books->total()) }} public text{{ $books->total() === 1 ? '' : 's' }},
                alphabetical. Also browse
                <a href="/j">journals</a> and <a href="/a">archives</a>.
            </p>
        </header>

        <ol class="jp-works" start="{{ $books->firstItem() ?? 1 }}">
            @forelse ($books as $b)
                <li>
                    <a class="jp-title" href="{{ $b->url }}">{{ $b->title }}</a>
                    <span class="jp-work-meta">
                        @if ($b->author){{ $b->author }} @endif
                        @if ($b->year)· {{ $b->year }} @endif
                        @if ($b->journal)· {{ $b->journal }} @endif
                    </span>
                </li>
            @empty
                <li class="jp-empty">No public texts yet.</li>
            @endforelse
        </ol>

        @if ($books->hasPages())
            <nav class="jp-pagination">
                @if ($books->onFirstPage())<span>← previous</span>@else<a href="{{ $books->previousPageUrl() }}">← previous</a>@endif
                <span>page {{ $books->currentPage() }} of {{ $books->lastPage() }}</span>
                @if ($books->hasMorePages())<a href="{{ $books->nextPageUrl() }}">next →</a>@else<span>next →</span>@endif
            </nav>
        @endif
    </main>
</body>
</html>
