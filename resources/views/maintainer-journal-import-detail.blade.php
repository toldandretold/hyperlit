<!DOCTYPE html>
{{-- ji-detail-root gives <html> a definite height: the three-pane grid is sized
     in percent, and without it the panes grow to the whole article list. --}}
<html lang="en" class="ji-detail-root">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Journal import — Hyperlit</title>
    <meta name="robots" content="noindex">
    @vite(['resources/css/pages/maintainer-journal-import.css'])
</head>
<body class="ji-detail">
    <script>
        (function () {
            var t = 'dark';
            try { t = localStorage.getItem('hyperlit_theme_preference') || 'dark'; } catch (e) {}
            if (['dark', 'light', 'sepia'].indexOf(t) === -1) t = 'dark';
            document.body.classList.add('theme-' + t);
        })();
    </script>

    <header class="ji-header">
        <h1 id="ji-journal-name">…</h1>
        <span class="ji-header-sub" id="ji-journal-meta"></span>

        {{-- The journal-scoped controls. Everything else on this page acts on ONE article, which
             left an un-enumerated journal with an empty list and no way to fill it: enumerate is
             the step that makes every other button reachable. Free (OpenAlex only) — the import
             beside it is the one that spends money, hence the explicit lane + cap. --}}
        <div class="ji-journal-actions">
            <button type="button" id="ji-enumerate"
                    title="Ask OpenAlex what this journal has published and list it here. Touches no publisher, runs no OCR, costs nothing.">⟳ enumerate</button>
            <span class="ji-bulk-group">
                <label class="ji-visually-hidden" for="ji-bulk-lanes">Lane to import</label>
                <select id="ji-bulk-lanes">
                    {{-- HTML first and selected: it is free, and on the pilot journal it converted
                         BETTER than OCR (which dropped whole sections). PDF is opt-in. --}}
                    <option value="html" selected>HTML</option>
                    <option value="pdf">PDF</option>
                    <option value="both">both</option>
                </select>
                <label class="ji-visually-hidden" for="ji-bulk-limit">How many works</label>
                <select id="ji-bulk-limit">
                    <option value="5" selected>next 5</option>
                    <option value="25">next 25</option>
                    <option value="100">next 100</option>
                    <option value="0">all eligible</option>
                </select>
                <button type="button" id="ji-bulk-import"
                        title="Import the most-cited eligible works that have no lane yet. HTML is free; PDF runs OCR and is charged to you.">⇩ import</button>
            </span>
            <span class="ji-actions-status" id="ji-journal-status" role="status" aria-live="polite"></span>
        </div>

        <nav class="ji-header-nav">
            <a href="/maintainer/journal-import">&larr; all journals</a>
            <a id="ji-public-link" href="#" target="_blank" rel="noopener">public page →</a>
            <a href="/maintainer/conversion">conversions →</a>
        </nav>
        <button type="button" id="ji-help-toggle" aria-expanded="false" aria-controls="ji-help-panel" title="How this works">?</button>
    </header>

    {{-- Three panes, same shape as /maintainer/conversion: the article/lane list drives two
         iframes — what we produced, and what we produced it FROM. --}}
    <div class="ji-columns" id="ji-columns">
        <aside class="ji-articles" id="ji-articles">
            <div class="ji-articles-head">
                <span id="ji-articles-count">…</span>
                <label class="ji-only-imported">
                    <input type="checkbox" id="ji-only-imported"> imported only
                </label>
            </div>
            <div id="ji-articles-list" role="list"></div>
            {{-- Says what to DO, not just what is missing: an empty list here used to be a dead
                 end, because every action on this page needs an article row to hang off. --}}
            <p class="ji-empty" id="ji-articles-empty" hidden>No articles enumerated yet — press
                <strong>⟳ enumerate</strong> above to ask OpenAlex what this journal has published.
                It's free and touches no publisher.</p>
        </aside>

        <section class="ji-pane ji-converted">
            <div class="ji-pane-label" id="ji-converted-label">converted output</div>
            {{-- Book id (click to copy) + the maintainer's own note, which rides the case bundle
                 into dev — same strip as /maintainer/conversion. --}}
            <div class="ji-detail-strip" id="ji-detail-strip" hidden>
                <div class="ji-bookid-row">
                    <code class="ji-bookid" id="ji-bookid" tabindex="0" title="Book id — click to copy"></code>
                    <a class="ji-bookid-open" id="ji-bookid-open" href="#" target="_blank" rel="noopener">open ↗</a>
                    {{-- The note editor is collapsed behind this: it's occasional, and a permanent
                         textarea steals height from the conversion you're here to read. The dot
                         means a note is already saved. --}}
                    <button type="button" class="ji-note-toggle" id="ji-note-toggle"
                            aria-expanded="false" aria-controls="ji-note-row">note<span
                            class="ji-note-dot" id="ji-note-dot" hidden aria-hidden="true"></span></button>
                    <span class="ji-bookid-meta" id="ji-bookid-meta"></span>
                </div>
                <div class="ji-note-row" id="ji-note-row" hidden>
                    <textarea id="ji-note" rows="2" placeholder="What's wrong with this lane? Rides the bundle into dev — opens a case if nothing has flagged it yet."></textarea>
                    <div class="ji-note-buttons">
                        <button type="button" id="ji-note-save">save note</button>
                        {{-- Close the case here rather than sending you to /maintainer/conversion.
                             Hidden until there is an open case to close. --}}
                        <button type="button" id="ji-resolve" hidden title="Close this case as fixed">✓ fixed</button>
                        <button type="button" id="ji-dismiss" hidden title="Close this case — nothing to fix here">✕ dismiss</button>
                    </div>
                </div>
            </div>
            <iframe id="ji-converted" title="Converted output" src="about:blank"></iframe>
            <div class="ji-pane-placeholder" id="ji-converted-placeholder">select a lane</div>
        </section>

        <section class="ji-pane ji-source">
            <div class="ji-pane-label" id="ji-source-label">source</div>
            <iframe id="ji-source" title="Original source" src="about:blank"></iframe>
            <div class="ji-pane-placeholder" id="ji-source-placeholder">no source file on disk</div>
        </section>
    </div>

    {{-- Floating action bar for the selected lane (draggable, like the conversion page's).
         The two bundle buttons and the two re-run buttons are the same fork: is the CONVERSION
         wrong, or is the page we acquired wrong? --}}
    <div class="ji-actions" id="ji-actions" hidden>
        <span class="ji-actions-grip" id="ji-actions-grip" title="Drag to move">⠿</span>
        <span class="ji-actions-book" id="ji-actions-book"></span>
        <button type="button" id="ji-open-reader" title="Open this lane in the reader">open ↗</button>
        <button type="button" id="ji-promote" title="Make this lane the version readers get">★ make version</button>
        <button type="button" id="ji-reconvert" title="Re-run the converter over the page we already have — no network, no cost. The fix loop after you ship a processor change.">↻ reconvert</button>
        <button type="button" id="ji-refetch" title="Go back to the publisher for a fresh copy — for when what we stored isn't the article">⇩ re-fetch</button>
        <button type="button" id="ji-export" title="Bundle blaming the CONVERTER — replays through run_regression.py">⤓ conversion</button>
        <button type="button" id="ji-export-harvest" title="Bundle blaming ACQUISITION — ships canonical_source + fetch_trace.json">⤓ harvest</button>
        <span class="ji-actions-status" id="ji-actions-status" role="status" aria-live="polite"></span>
    </div>

    {{-- Shown instead of the lane bar when the selected article has no lanes yet. --}}
    <div class="ji-actions ji-import-bar" id="ji-import-bar" hidden>
        <span class="ji-actions-grip" id="ji-import-grip" title="Drag to move">⠿</span>
        <span class="ji-actions-book" id="ji-import-title"></span>
        <span class="ji-import-label">not imported — fetch:</span>
        <button type="button" id="ji-import-pdf" title="Vacuum the PDF and OCR it (slow, costs OCR credit)">PDF</button>
        <button type="button" id="ji-import-html" title="Fetch the publisher page and run the paste engine (free)">HTML</button>
        <button type="button" id="ji-import-both" title="Both lanes, so you can compare them">both</button>
        <span class="ji-actions-status" id="ji-import-status" role="status" aria-live="polite"></span>
    </div>

    <div class="ji-help-panel" id="ji-help-panel" hidden>
        <h2>Reading this page <button type="button" id="ji-help-close" aria-label="Close help">✕</button></h2>
        <ol>
            <li><strong>Start with ⟳ enumerate</strong> — it asks OpenAlex what this journal has published and lists it here. Nothing else on this page works until it has run, because every other action targets an article row. Free: no publisher is contacted and no OCR runs.</li>
            <li><strong>Then ⇩ import</strong> to work the queue in bulk — most-cited eligible works first, in the lane you pick. <code>HTML</code> is free; <code>PDF</code> runs OCR and is charged to you. The cap is your spend control; <code>all eligible</code> is a real option but never the default, and a long run stops at its time limit and tells you to press again.</li>
            <li><strong>One row per article</strong>, most-cited first — every work OpenAlex lists for this journal, whether or not we've imported it.</li>
            <li><strong>Each imported lane is a sub-row</strong>: <code>pdf</code> (vacuumed PDF + OCR), <code>html</code> (publisher page via the paste engine), <code>ar5iv</code>. Lanes are sibling library rows on one canonical, each with its own book id and artifacts.</li>
            <li><strong>★ marks the promoted lane</strong> — the one <code>/j/&lt;slug&gt;</code>, the shelf and readers resolve to. The others stay imported but unlisted.</li>
            <li><strong>Click a lane</strong> to load what we produced (left) beside what we produced it from (right): the PDF for the PDF lane, the fetched publisher page for the HTML lane.</li>
            <li><strong>The badges are the evidence</strong>: completeness, the body-presence verdict, which host the copy won from, and any open conversion flags.</li>
            <li><strong>An article with no lanes</strong> selects too — the bar offers <code>PDF</code>, <code>HTML</code> or <code>both</code>. HTML is free; PDF runs OCR and is charged to you.</li>
        </ol>
        <h3>Reconvert or re-fetch?</h3>
        <p>They answer different questions, which is the point of having both. <strong>↻ reconvert</strong> re-runs the converter over the page <em>already on disk</em> — no network, no cost — so it is what you press after fixing a processor and shipping it; the input is held constant, so any change in the output is your fix. <strong>⇩ re-fetch</strong> goes back to the publisher, for when what we stored isn't the article at all (empty, paywalled, wrong page). Same fork as the two bundles: <code>⤓ conversion</code> blames the converter, <code>⤓ harvest</code> blames acquisition.</p>
        <p>The PDF lane reconverts through the shared <code>/maintainer/conversion</code> path (it has an <code>original.pdf</code> and an OCR cache, so it costs nothing to re-run). Re-acquiring a PDF is a retract-and-re-harvest, not a button here.</p>
        <p class="ji-help-doc">Design: <code>docs/journal-harvest.md</code></p>
    </div>

    <script>window.__journalImport = { slug: @json($journalSlug) };</script>
    @vite(['resources/js/maintainerJournalImport/main.ts'])
</body>
</html>
