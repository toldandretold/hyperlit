<!DOCTYPE html>
{{-- /maintainer/citations — the ambiguous-citation review queue (standalone, non-SPA,
     admin-only; see Maintainer\CitationConsoleController). One column: books with open
     questions, each question a card carrying the sentence + the candidate entries. --}}
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Ambiguous citations — Hyperlit</title>
    <meta name="robots" content="noindex">
    @vite(['resources/css/pages/maintainer-citations.css'])
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

    <header class="mc-header">
        <h1>Ambiguous citations</h1>
        <span class="mc-header-sub" id="mc-counts"></span>
        <a class="mc-header-link" href="/maintainer/conversion">conversion</a>
        <a class="mc-header-link" href="/maintainer/hypercites">hypercites</a>
    </header>

    <p class="mc-intro">
        Each card is a citation the converter could not resolve with certainty: a bare year whose
        author lives in the surrounding prose, with <em>more than one</em> bibliography entry that
        fits. It currently links to the first candidate. Pick the right entry — or mark it as not
        a citation — and the stored text is corrected immediately; the answer survives every
        later reconvert.
    </p>

    <main id="mc-list" aria-live="polite">
        <p class="mc-empty">Loading…</p>
    </main>

    @vite(['resources/js/maintainerCitations/main.ts'])
</body>
</html>
