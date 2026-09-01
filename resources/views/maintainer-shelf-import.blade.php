<!DOCTYPE html>
{{-- The journal-import console generalized to a SHELF scope: same CSS, same JS
     entry, boot global carries mode:'shelf'. Detail mode is the journal detail
     three-pane layout MINUS the journal-registry controls (enumerate /
     import_all) — a shelf has no OpenAlex source to enumerate. --}}
@php($isDetail = (bool) $shelfId)
<html lang="en" @if($isDetail) class="ji-detail-root" @endif>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    {{-- batchUploader (the shelf drop target) reads its CSRF token from this meta. --}}
    <meta name="csrf-token" content="{{ csrf_token() }}">
    <title>Shelf import — Hyperlit</title>
    <meta name="robots" content="noindex">
    @vite(['resources/css/pages/maintainer-journal-import.css'])
</head>
<body @if($isDetail) class="ji-detail" @endif>
    <script>
        (function () {
            var t = 'dark';
            try { t = localStorage.getItem('hyperlit_theme_preference') || 'dark'; } catch (e) {}
            if (['dark', 'light', 'sepia'].indexOf(t) === -1) t = 'dark';
            document.body.classList.add('theme-' + t);
        })();
    </script>

@if($isDetail)
    <header class="ji-header">
        <h1 id="ji-journal-name">…</h1>
        <span class="ji-header-sub" id="ji-journal-meta"></span>

        <nav class="ji-header-nav">
            <a href="/maintainer/shelf-import">&larr; all shelves</a>
            <a id="ji-public-link" href="#" target="_blank" rel="noopener">public page →</a>
            <a href="/maintainer/hypercites/shelf/{{ $shelfId }}">hypercites →</a>
            <a href="/maintainer/conversion">conversions →</a>
            <button type="button" id="ji-archive-toggle" aria-expanded="false" aria-controls="ji-archive-panel" title="This shelf's public archive page (/a/{slug})">archive page</button>
        </nav>
        <button type="button" id="ji-help-toggle" aria-expanded="false" aria-controls="ji-help-panel" title="How this works">?</button>
    </header>

    {{-- Archive page record: slug + display name + hand-written about copy +
         the certified ★ that lists the archive on the homepage. Writes
         archive_sources via /api/maintainer/shelf-import/{id}/archive. --}}
    <div class="ji-help-panel ji-archive-panel" id="ji-archive-panel" hidden>
        <h2>Archive page <button type="button" id="ji-archive-close" aria-label="Close archive panel">✕</button></h2>
        <p class="ji-archive-hint">Gives this shelf a public hero page at <code>/a/&lt;slug&gt;</code>. Certify (★)
            to list it on the homepage — the listing self-heals away if the archive loses its readable books.</p>
        <label class="ji-archive-field">slug
            <input type="text" id="ji-archive-slug" placeholder="e.g. nam" autocomplete="off" spellcheck="false" pattern="[a-z0-9-]+">
        </label>
        <label class="ji-archive-field">display name
            <input type="text" id="ji-archive-name" placeholder="the page's title" autocomplete="off">
        </label>
        <label class="ji-archive-field">about copy
            <textarea id="ji-archive-about" rows="10" placeholder="Write or paste the page copy — separate paragraphs with a blank line. The first paragraph renders large."></textarea>
        </label>
        <div class="ji-archive-actions">
            <button type="button" id="ji-archive-save">save</button>
            <button type="button" id="ji-archive-certify" title="List this archive on the homepage">☆ certify</button>
            <a id="ji-archive-link" href="#" target="_blank" rel="noopener" hidden>open page ↗</a>
        </div>
        <span class="ji-actions-status" id="ji-archive-status" role="status" aria-live="polite"></span>
    </div>

    {{-- Three panes, identical ids to the journal detail page — one JS wires both. --}}
    <div class="ji-columns" id="ji-columns">
        <aside class="ji-articles" id="ji-articles">
            <div class="ji-articles-head">
                <span id="ji-articles-count">…</span>
                <label class="ji-only-imported">
                    <input type="checkbox" id="ji-only-imported"> imported only
                </label>
                <label class="ji-only-imported">
                    <input type="checkbox" id="ji-only-failed"> failed only
                </label>
            </div>
            <input type="search" id="ji-article-search" class="ji-article-search"
                   placeholder="Find a work by title or DOI…" aria-label="Find a work">
            <div id="ji-articles-list" role="list"></div>
            <p class="ji-empty" id="ji-articles-empty" hidden>Nothing assessable on this shelf yet —
                its books carry no canonical link, or the shelf is empty. Imports from the
                hypercite console's <strong>⇩ import all OA</strong> land here.</p>
        </aside>

        <section class="ji-pane ji-converted">
            <div class="ji-pane-label" id="ji-converted-label">converted output</div>
            <div class="ji-detail-strip" id="ji-detail-strip" hidden>
                <div class="ji-bookid-row">
                    <code class="ji-bookid" id="ji-bookid" tabindex="0" title="Book id — click to copy"></code>
                    <a class="ji-bookid-open" id="ji-bookid-open" href="#" target="_blank" rel="noopener">open ↗</a>
                    <button type="button" class="ji-note-toggle" id="ji-note-toggle"
                            aria-expanded="false" aria-controls="ji-note-row">note<span
                            class="ji-note-dot" id="ji-note-dot" hidden aria-hidden="true"></span></button>
                    <span class="ji-bookid-meta" id="ji-bookid-meta"></span>
                </div>
                <div class="ji-note-row" id="ji-note-row" hidden>
                    <textarea id="ji-note" rows="2" placeholder="What's wrong with this lane? Rides the bundle into dev — opens a case if nothing has flagged it yet."></textarea>
                    <div class="ji-note-buttons">
                        <button type="button" id="ji-note-save">save note</button>
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

    <div class="ji-actions" id="ji-actions" hidden>
        <span class="ji-actions-grip" id="ji-actions-grip" title="Drag to move">⠿</span>
        <span class="ji-actions-book" id="ji-actions-book"></span>
        <button type="button" id="ji-open-reader" title="Open this lane in the reader">open ↗</button>
        <button type="button" id="ji-promote" title="Make this lane the version readers get">★ make version</button>
        <button type="button" id="ji-reconvert" title="Re-run the converter over the page we already have — no network, no cost. The fix loop after you ship a processor change.">↻ reconvert</button>
        <button type="button" id="ji-refetch" title="Go back to the publisher for a fresh copy — for when what we stored isn't the article">⇩ re-fetch</button>
        <button type="button" id="ji-export" title="Bundle blaming the CONVERTER — replays through run_regression.py">⤓ conversion</button>
        <button type="button" id="ji-export-harvest" title="Bundle blaming ACQUISITION — ships canonical_source + fetch_trace.json">⤓ harvest</button>
        @if(!app()->environment('production'))
            <button type="button" id="ji-approve-golden" title="Freeze this book's CURRENT conversion as the regression golden — the promote-to-golden step after the converter is fixed (runs run_regression.py --update-golden)">✓ golden</button>
        @endif
        <span class="ji-actions-status" id="ji-actions-status" role="status" aria-live="polite"></span>
    </div>

    <div class="ji-actions ji-import-bar" id="ji-import-bar" hidden>
        <span class="ji-actions-grip" id="ji-import-grip" title="Drag to move">⠿</span>
        <span class="ji-actions-book" id="ji-import-title"></span>
        <span class="ji-import-label">not imported — fetch:</span>
        <button type="button" id="ji-import-pdf" title="Vacuum the PDF and OCR it (slow, costs OCR credit)">PDF</button>
        <button type="button" id="ji-import-html" title="Fetch the publisher page and run the paste engine (free)">HTML</button>
        <button type="button" id="ji-import-both" title="Both lanes, so you can compare them">both</button>
        <span class="ji-actions-status" id="ji-import-status" role="status" aria-live="polite"></span>
    </div>

    <div class="ji-failures" id="ji-failures" hidden>
        <div class="ji-failures-head">
            <strong id="ji-failures-title"></strong>
            <button type="button" id="ji-failures-copy" title="Copy this list as plain text">copy</button>
            <button type="button" id="ji-failures-close" aria-label="Close failures">✕</button>
        </div>
        <div class="ji-failures-body" id="ji-failures-body"></div>
    </div>

    <div class="ji-help-panel" id="ji-help-panel" hidden>
        <h2>Reading this page <button type="button" id="ji-help-close" aria-label="Close help">✕</button></h2>
        <ol>
            <li><strong>This shelf's works</strong>, most-cited first — one row per canonical work behind the shelf's books. "Cited by:" shelves are filled by the hypercite console's <strong>⇩ import all OA</strong>.</li>
            <li><strong>Each imported lane is a sub-row</strong>: <code>pdf</code> (vacuumed PDF + OCR), <code>html</code> (publisher page via the paste engine), <code>ar5iv</code> — plus <code>jats</code> / <code>web</code> when the vacuum ladder won with publisher XML or a browser-fetched page instead of a PDF. Lanes are sibling library rows on one canonical — including siblings that are not on this shelf, because comparing them is the workflow.</li>
            <li><strong>★ marks the promoted lane</strong> — the one readers resolve to. Promoting from here also swaps the winner onto this shelf in place of demoted siblings.</li>
            <li><strong>Click a lane</strong> to load what we produced (left) beside what we produced it from (right).</li>
            <li><strong>The badges are the evidence</strong>: completeness, the body-presence verdict, which host the copy won from, and any open conversion flags.</li>
            <li><strong>Then back to hypercites →</strong> and re-run detect — the imported works are matchable as soon as their conversion lands.</li>
        </ol>
        <p class="ji-help-doc">Design: <code>docs/journal-harvest.md</code></p>
    </div>
@else
    <header class="ji-header">
        <h1>Shelf import</h1>
        <span class="ji-header-sub" id="ji-summary">loading…</span>
        <nav class="ji-header-nav">
            <a href="/maintainer/journal-import">journals →</a>
            <a href="/maintainer/hypercites">hypercites →</a>
            <a href="/maintainer/conversion">conversions →</a>
            <a href="/">&larr; Hyperlit</a>
        </nav>
        <button type="button" id="ji-help-toggle" aria-expanded="false" aria-controls="ji-help-panel" title="How this works">?</button>
    </header>

    <main class="ji-main">
        <div class="ji-filter-row">
            <input type="search" id="ji-filter" class="ji-filter" placeholder="Filter by name or creator…" autocomplete="off" spellcheck="false">
        </div>

        <section class="ji-section" aria-label="Public shelves">
            <div class="ji-section-head">
                <h2>Public shelves</h2>
                <span class="ji-section-note">collection shelves first, then by size</span>
            </div>
            <div id="ji-shelf-list" role="list"></div>
            <p class="ji-empty" id="ji-shelf-empty" hidden>No public shelves yet — the hypercite
                console's <strong>⇩ import all OA</strong> creates a "Cited by:" shelf per scope.</p>
        </section>
    </main>

    <div class="ji-status" id="ji-status" role="status" aria-live="polite"></div>

    <div class="ji-help-panel" id="ji-help-panel" hidden>
        <h2>The loop <button type="button" id="ji-help-close" aria-label="Close help">✕</button></h2>
        <ol>
            <li><strong>Pick a shelf.</strong> "Cited by:" shelves collect the external OA works imported from the hypercite console; "Journal:" and "Harvested from:" shelves work here too.</li>
            <li><strong>Open a shelf</strong> to assess its works exactly as the journal-import console does: lanes, evidence badges, promote, reconvert, flags.</li>
            <li><strong>Then back to /maintainer/hypercites</strong> and re-run detect — imported works are matchable as soon as their conversion lands.</li>
        </ol>
        <p class="ji-help-doc">Design: <code>docs/journal-harvest.md</code></p>
    </div>
@endif

    <script>window.__journalImport = { slug: null, shelfId: @json($shelfId), shelfName: @json($shelfName), mode: 'shelf' };</script>
    @vite(['resources/js/maintainerJournalImport/main.ts'])
</body>
</html>
