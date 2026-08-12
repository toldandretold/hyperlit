<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Diamond Open Access Journals — Hyperlit</title>
    <meta name="description" content="Diamond open access journals on Hyperlit — free to read, free to publish, no article processing charges.">
    <link rel="canonical" href="{{ url('/j') }}">
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
            <h1>Diamond Open Access Journals</h1>
            <p class="jp-counts">Free to read, free to publish. Ranked by citations.</p>
        </header>

        <ol class="jp-works" start="{{ $journals->firstItem() ?? 1 }}">
            @forelse ($journals as $j)
                <li>
                    <a class="jp-title" href="/j/{{ $j->slug }}">{{ $j->display_name }}</a>
                    <span class="jp-work-meta">
                        @if ($j->publisher){{ $j->publisher }} @endif
                        @if ($j->works_count)· {{ number_format($j->works_count) }} works @endif
                        @if ($j->cited_by_count)· cited by {{ number_format($j->cited_by_count) }} @endif
                        @if ($j->last_harvested_at)· <span class="jp-diamond">harvested</span>@endif
                    </span>
                </li>
            @empty
                <li class="jp-empty">The registry is empty — run <code>php artisan journal:sync-registry</code>.</li>
            @endforelse
        </ol>

        @if ($journals->hasPages())
            <nav class="jp-pagination">
                @if ($journals->onFirstPage())<span>← previous</span>@else<a href="{{ $journals->previousPageUrl() }}">← previous</a>@endif
                <span>page {{ $journals->currentPage() }} of {{ $journals->lastPage() }}</span>
                @if ($journals->hasMorePages())<a href="{{ $journals->nextPageUrl() }}">next →</a>@else<span>next →</span>@endif
            </nav>
        @endif
    </main>
</body>
</html>
