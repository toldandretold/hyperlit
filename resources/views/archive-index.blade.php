<!DOCTYPE html>
{{-- /a — the certified hypertext archives, journal-index.blade.php's standalone
     list style. $archives comes from CertifiedArchivesQuery: certified AND
     holding at least one readable document. See docs/web-scrape-import.md. --}}
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Hypertext Archives — Hyperlit</title>
    <meta name="description" content="Hypertext archives on Hyperlit — curated document collections converted for reading, linking and annotation.">
    <link rel="canonical" href="{{ url('/a') }}">
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
            <h1>Hypertext Archives</h1>
            <p class="jp-counts">Curated document collections, converted for reading and linking.</p>
        </header>

        <ol class="jp-works">
            @forelse ($archives as $a)
                <li>
                    <a class="jp-title" href="/a/{{ $a['slug'] }}">{{ $a['display_name'] }}</a>
                    <span class="jp-work-meta">{{ number_format($a['readable']) }} document{{ $a['readable'] === 1 ? '' : 's' }}</span>
                </li>
            @empty
                <li class="jp-empty">No certified archives yet.</li>
            @endforelse
        </ol>
    </main>
</body>
</html>
