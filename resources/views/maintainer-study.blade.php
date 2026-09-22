<!DOCTYPE html>
{{-- /maintainer/study — the citation-study reviewer-review workbench (standalone, non-SPA,
     admin-only; see Maintainer\StudyConsoleController). Three panes: claims list (flagged
     by default), claim detail + two-axis adjudication form, and the source PDF with
     server-side text search. Verdicts persist to study/corpora/{corpus}/adjudications/;
     the Apply bar folds labels into ground_truth.json. --}}
<html lang="en" class="st-root">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Citation study review — Hyperlit</title>
    <meta name="robots" content="noindex">
    @vite(['resources/css/pages/maintainer-study.css'])
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
    <script>window.__study = @json(['corpus' => $corpus, 'slug' => $slug]);</script>

    <header class="st-header">
        <h1>Citation study review</h1>
        {{-- Corpus switcher. The corpus used to live ONLY in a query string that the app dropped
             on navigation, so switching meant hand-editing the URL and a refresh silently sent you
             back to the default. Plain links: they survive refresh and Back by construction. --}}
        <span class="st-corpus-switch">
            @foreach (($corpora ?? []) as $c)
                <a class="st-header-link @if ($c === $corpus) st-corpus-on @endif"
                   href="{{ $slug ? '/maintainer/study?corpus=' . urlencode($c) : '/maintainer/study?corpus=' . urlencode($c) }}">{{ $c }}</a>
            @endforeach
        </span>
        <span class="st-header-sub" id="st-counts"></span>
        <button type="button" class="st-header-link" id="st-help-toggle" aria-expanded="false">?</button>
        <a class="st-header-link" href="/maintainer/citations">citations</a>
        <a class="st-header-link" href="/maintainer/conversion">conversion</a>
    </header>

    <div class="st-help" id="st-help" hidden>
        <p><strong>The loop:</strong> the AI reviewed each citation; you review the AI. Default
        filter = the claims worth your time (rejected / unlikely / source not found /
        insufficient). For each one decide the <em>label</em> (what the citation truly is —
        feeds the study baseline) and, when the AI flagged it, the <em>cause</em> (whose
        failure the flag was — feeds system improvement). The conversion-check block shows
        whether OUR OCR mangled the citation before blaming the author. Verdicts save
        instantly to the corpus adjudications file; <em>Apply</em> folds labels into
        ground_truth.json; then re-run <code>citation:study:report</code>.</p>
        <p><strong>Context before you judge:</strong> each claim shows the book's <em>pathway</em>
        (how the document was imported — pdf / markdown / html / docx / paste) and how the corpus
        copy was built. A copy labelled <em>exported-from-nodes</em> had its citation anchors
        RE-DERIVED from plain text rather than inherited from the live book, so a mislink there
        may be an artifact of that round-trip. An amber <em>anchor ⚠</em> means this citation's
        own in-text anchor displays a different year from the entry it points at — the pairing
        may never have been made by the author, so settle that before judging the citation.</p>

        <p>The source pane has two views. <em>Original PDF</em> streams the source document —
        search it server-side, click a hit to jump the viewer to that page (the viewer's own
        find bar works too once focused). <em>Hyperlit</em> shows the study copy exactly as
        stored — selecting a claim jumps it to that citation's node (outlined). Books without
        a PDF (web imports) open in Hyperlit view automatically.</p>
    </div>

    <main class="st-columns">
        <aside class="st-list-pane">
            <div id="st-books" class="st-books"></div>
            <div class="st-filters" id="st-filters" hidden>
                <label><input type="checkbox" id="st-filter-flagged" checked> flagged only</label>
                <label><input type="checkbox" id="st-filter-unadjudicated"> unadjudicated only</label>
            </div>
            <div id="st-list" role="list" aria-live="polite"><p class="st-empty">Loading…</p></div>
        </aside>

        <section class="st-detail-pane" id="st-detail" aria-live="polite">
            <p class="st-empty">Pick a book, then a claim.</p>
        </section>

        <aside class="st-pdf-pane" id="st-pdf-pane" hidden>
            <div class="st-pane-toggle" role="tablist" aria-label="Source view">
                <button type="button" id="st-view-pdf" role="tab" aria-selected="true">Original PDF</button>
                <button type="button" id="st-view-hyperlit" role="tab" aria-selected="false">Hyperlit</button>
                {{-- What WE extracted from the cited source, as stored. The verifier only ever
                     sees a few passages of it, so this is where "did we scrape a nav rail?" is
                     answered. Enabled only for a claim whose source actually resolved. --}}
                <button type="button" id="st-view-source" role="tab" aria-selected="false">Extracted source</button>
            </div>
            <div class="st-pdf-search" id="st-pdf-search">
                <input type="search" id="st-pdf-query" placeholder="Search the PDF…" />
                <button type="button" id="st-pdf-go">Search</button>
            </div>
            {{-- Judge the EXTRACTION, not the citation. Shown only in the Source view, because
                 that is the only place you can see what we kept. Buttons are built in main.ts
                 from StudyConsoleController::EXTRACTION_VERDICTS. --}}
            <div class="st-extraction-flag" id="st-extraction-flag" hidden></div>
            <div id="st-pdf-hits" class="st-pdf-hits"></div>
            <iframe id="st-pdf-frame" title="Source document"></iframe>
        </aside>
    </main>

    <div class="st-applybar" id="st-applybar" hidden>
        <span id="st-apply-summary"></span>
        <button type="button" id="st-apply-btn">Apply to ground truth</button>
    </div>

    @vite(['resources/js/maintainerStudy/main.ts'])
</body>
</html>
