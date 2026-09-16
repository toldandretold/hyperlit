<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Stats — Hyperlit</title>
    <meta name="robots" content="noindex">
    @vite(['resources/css/pages/maintainer-stats.css'])
</head>
<body>
    {{-- Theme before paint: the reader's storage key (same pattern as the sibling pages). --}}
    <script>
        (function () {
            var t = 'dark';
            try { t = localStorage.getItem('hyperlit_theme_preference') || 'dark'; } catch (e) {}
            if (['dark', 'light', 'sepia'].indexOf(t) === -1) t = 'dark';
            document.body.classList.add('theme-' + t);
        })();
    </script>

    <header class="mst-header">
        <h1>Stats</h1>
        <span class="mst-header-sub" id="mst-summary">loading…</span>
        <nav class="mst-header-nav">
            <a href="/maintainer/conversion">conversions &rarr;</a>
            <a href="/maintainer/jobs">jobs &rarr;</a>
            <a href="/maintainer/storage">storage &rarr;</a>
            <a href="/maintainer/journal-import">journals &rarr;</a>
            <a href="/">&larr; Hyperlit</a>
        </nav>
        <button type="button" id="mst-help-toggle" aria-expanded="false" aria-controls="mst-help-panel" title="How this works">?</button>
    </header>

    <main class="mst-main">
        {{-- Corpus totals: views, readers, likes at a glance. --}}
        <section class="mst-section" aria-labelledby="mst-totals-h">
            <h2 id="mst-totals-h">Totals</h2>
            <div class="mst-tiles" id="mst-tiles"></div>
        </section>

        {{-- Daily views + likes, last 90 days, one bar per day. --}}
        <section class="mst-section" aria-labelledby="mst-daily-h">
            <h2 id="mst-daily-h">Last 90 days</h2>
            <div id="mst-daily" class="mst-daily"></div>
            <div class="mst-legend">
                <span class="mst-legend-item"><span class="mst-swatch mst-swatch-views"></span> book views</span>
                <span class="mst-legend-item"><span class="mst-swatch mst-swatch-home"></span> home views</span>
                <span class="mst-legend-item"><span class="mst-swatch mst-swatch-likes"></span> likes</span>
            </div>
        </section>

        {{-- Most-read books with likes and average reading depth. --}}
        <section class="mst-section" aria-labelledby="mst-top-h">
            <h2 id="mst-top-h">Most read</h2>
            <div id="mst-top" class="mst-top"></div>
        </section>
    </main>

    <div class="mst-help-panel" id="mst-help-panel" hidden>
        <h2>What this measures <button type="button" id="mst-help-close" aria-label="Close help">✕</button></h2>
        <ul>
            <li><strong>view</strong> — one reader (logged-in user or anonymous cookie) opening a book, counted once per day. Same-day re-opens merge into the same view.</li>
            <li><strong>readers</strong> — distinct identities across all books and days. Anonymous readers are as durable as their cookie.</li>
            <li><strong>depth</strong> — how far into the book a view's furthest on-screen chunk got, averaged over the views that know their book's chunk count.</li>
            <li><strong>likes</strong> — logged-in users only, one per (book, user).</li>
        </ul>
        <p>Capture rides the reader's scroll detector: a chunk counts only when it was actually on screen, not merely loaded. Sub-books roll up to their parent; home/user feed pages are never counted.</p>
    </div>

    @vite(['resources/js/maintainerStats/main.ts'])
</body>
</html>
