<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Maintainer — Hyperlit</title>
    <meta name="robots" content="noindex">
    @vite(['resources/css/pages/maintainer.css'])
</head>
<body>
    {{-- Theme before paint: the reader's storage key (same pattern as docuverse). --}}
    <script>
        (function () {
            var t = 'dark';
            try { t = localStorage.getItem('hyperlit_theme_preference') || 'dark'; } catch (e) {}
            if (['dark', 'light', 'sepia'].indexOf(t) === -1) t = 'dark';
            document.body.classList.add('theme-' + t);
        })();
    </script>

    <header class="mt-header">
        <h1>Maintainer</h1>
        <span class="mt-header-sub">flagged conversions</span>
        <a href="/">&larr; Hyperlit</a>
        <button type="button" id="mt-flags-toggle" aria-expanded="true" title="Toggle the flag list">☰ queue</button>
    </header>

    <div class="mt-columns" id="mt-columns">
        {{-- Left: the flag queue --}}
        <aside class="mt-flags" id="mt-flags" aria-label="Flagged books">
            <div id="mt-flags-list" role="list"></div>
            <p class="mt-flags-empty" id="mt-flags-empty" hidden>Queue empty — nothing flagged. 🎉</p>
        </aside>

        {{-- Middle: the book, in the real reader --}}
        <section class="mt-book" aria-label="Flagged book (reader)">
            <div class="mt-pane-note" id="mt-detail" hidden></div>
            <iframe id="mt-reader" title="Flagged book in the reader" src="about:blank"></iframe>
            <p class="mt-pane-placeholder" id="mt-reader-placeholder">Select a flagged book from the queue.</p>
        </section>

        {{-- Right: the original source file --}}
        <section class="mt-original" id="mt-original-pane" aria-label="Original source file">
            <iframe id="mt-original" title="Original source file" src="about:blank"></iframe>
            <p class="mt-pane-placeholder" id="mt-original-placeholder">No original source on disk for this book.</p>
        </section>
    </div>

    {{-- Floating action bar --}}
    <div class="mt-actions" id="mt-actions" hidden>
        <span id="mt-actions-book"></span>
        <button type="button" id="mt-export">⤓ dev bundle</button>
        <button type="button" id="mt-reconvert">↻ reconvert</button>
        <button type="button" id="mt-resolve">✓ resolve</button>
        <button type="button" id="mt-dismiss">✕ dismiss</button>
        <span class="mt-actions-status" id="mt-actions-status" role="status"></span>
    </div>

    <script>
        window.__maintainer = { book: @json($deepLinkBook) };
    </script>
    @vite(['resources/js/maintainer/main.ts'])
</body>
</html>
