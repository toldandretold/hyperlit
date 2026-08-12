<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>{{ $journal->display_name }} — Hyperlit</title>
    <meta name="description" content="{{ $journal->display_name }}{{ $journal->publisher ? ' (' . $journal->publisher . ')' : '' }} — {{ $journal->is_diamond ? 'diamond open access' : 'open access' }} journal on Hyperlit: {{ $readable }} readable article{{ $readable === 1 ? '' : 's' }}.">
    <link rel="canonical" href="{{ url('/j/' . $journal->slug) }}">
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
        <nav class="jp-breadcrumb"><a href="/">Hyperlit</a> · <a href="/j">Journals</a></nav>

        <header class="jp-header">
            <h1>{{ $journal->display_name }}</h1>
            <p class="jp-meta">
                @if ($journal->is_diamond)<span class="jp-diamond" title="Free to read and free to publish — no article processing charges">◆ diamond open access</span>@endif
                @if ($journal->publisher)<span>{{ $journal->publisher }}</span>@endif
                @if ($journal->issn_l)<span>ISSN {{ $journal->issn_l }}</span>@endif
                @if ($journal->homepage_url)<a href="{{ $journal->homepage_url }}" rel="noopener">journal website ↗</a>@endif
            </p>
            <p class="jp-counts">
                {{ number_format($readable) }} of {{ number_format($works->total()) }} article{{ $works->total() === 1 ? '' : 's' }} readable on Hyperlit
                @if ($shelfUrl) · <a href="{{ $shelfUrl }}">browse the shelf</a>@endif
            </p>
        </header>

        <ol class="jp-works" start="{{ $works->firstItem() ?? 1 }}">
            @forelse ($works as $work)
                <li>
                    @if ($work->version_book && $work->version_has_nodes)
                        <a class="jp-title" href="/{{ $work->version_book }}">{{ $work->title ?? '(untitled)' }}</a>
                    @else
                        <span class="jp-title jp-unreadable">{{ $work->title ?? '(untitled)' }}</span>
                    @endif
                    <span class="jp-work-meta">
                        @if ($work->author){{ $work->author }} @endif
                        @if ($work->year)({{ $work->year }}) @endif
                        @if ($work->cited_by_count)· cited by {{ number_format($work->cited_by_count) }} @endif
                        @if ($work->doi)· <a href="https://doi.org/{{ $work->doi }}" rel="noopener">doi</a> @endif
                        @if ($work->version_book && $work->version_has_nodes && !$work->version_listed)· <span class="jp-unreviewed" title="Imported automatically; not yet checked by a maintainer">unreviewed</span>@endif
                    </span>
                </li>
            @empty
                <li class="jp-empty">No works registered yet — run <code>php artisan journal:harvest {{ $journal->slug }}</code>.</li>
            @endforelse
        </ol>

        @if ($works->hasPages())
            <nav class="jp-pagination">
                @if ($works->onFirstPage())<span>← previous</span>@else<a href="{{ $works->previousPageUrl() }}">← previous</a>@endif
                <span>page {{ $works->currentPage() }} of {{ $works->lastPage() }}</span>
                @if ($works->hasMorePages())<a href="{{ $works->nextPageUrl() }}">next →</a>@else<span>next →</span>@endif
            </nav>
        @endif
    </main>
</body>
</html>
