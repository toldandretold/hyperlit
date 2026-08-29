<!DOCTYPE html>
{{-- hx-root gives <html> a definite height: the three-pane grid is sized in
     percent, and without it the panes grow to the whole candidate list (the
     same descendant-selector trap the journal-import console hit). --}}
@php($isDetail = (bool) ($journalSlug || $shelfId))
<html lang="en" class="hx-root{{ $isDetail ? ' hx-root-detail' : '' }}">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Hypercites — Hyperlit</title>
    <meta name="robots" content="noindex">
    @vite(['resources/css/pages/maintainer-hypercites.css'])
</head>
<body class="{{ $isDetail ? 'hx-detail' : 'hx-index' }}">
    <script>
        (function () {
            var t = 'dark';
            try { t = localStorage.getItem('hyperlit_theme_preference') || 'dark'; } catch (e) {}
            if (['dark', 'light', 'sepia'].indexOf(t) === -1) t = 'dark';
            document.body.classList.add('theme-' + t);
        })();
    </script>

    <header class="hx-header">
        <h1 id="hx-title">Hypercites</h1>
        <span class="hx-header-sub" id="hx-journal-meta"></span>

        @if ($isDetail)
        <div class="hx-journal-actions">
            <button type="button" id="hx-detect"
                    title="Walk this collection's citation graph: find citations of works we hold, detect quotes, and try to locate each quote in the cited text. Free — no publisher is contacted.">⌕ detect candidates</button>
            <label class="hx-auto-approve" title="Also mint every candidate the auto-approve policy clears: exact verbatim match, single occurrence, real quote length. Off by default — the point of this page is that you review first.">
                <input type="checkbox" id="hx-auto-approve"> auto-approve exact
            </label>
            <span class="hx-actions-status" id="hx-run-status" role="status" aria-live="polite"></span>
        </div>

        <nav class="hx-tabs" role="tablist">
            <button type="button" id="hx-tab-candidates" class="hx-tab hx-tab-active" role="tab" aria-selected="true">candidates</button>
            <button type="button" id="hx-tab-mostcited" class="hx-tab" role="tab" aria-selected="false">most cited</button>
        </nav>
        @endif

        <nav class="hx-header-nav">
            @if ($isDetail)
            <a href="/maintainer/hypercites">&larr; all collections</a>
            @if ($journalSlug)
            <a id="hx-journal-import-link" href="/maintainer/journal-import/{{ $journalSlug }}">journal import →</a>
            @endif
            @else
            <a href="/maintainer/journal-import">journal import →</a>
            <a href="/maintainer/conversion">conversions →</a>
            @endif
        </nav>
        <button type="button" id="hx-help-toggle" aria-expanded="false" aria-controls="hx-help-panel" title="How this works">?</button>
    </header>

    @if (! $isDetail)
    {{-- INDEX: pick a collection — a journal, or a public shelf. --}}
    <main class="hx-index-main">
        <h3 class="hx-group-title">journals</h3>
        <div id="hx-journals-list" role="list"></div>
        <p class="hx-empty" id="hx-journals-empty" hidden>No journals in the registry yet —
            run <code>journal:sync-registry</code>, then import articles on
            <a href="/maintainer/journal-import">/maintainer/journal-import</a>.</p>
        <h3 class="hx-group-title">public shelves</h3>
        <div id="hx-shelves-list" role="list"></div>
        <p class="hx-empty" id="hx-shelves-empty" hidden>No public shelves yet.</p>
    </main>
    @else
    {{-- DETAIL: candidate list drives two REAL readers — the article that cites
         (left pane) and the article that is cited (right pane). --}}
    <div class="hx-columns" id="hx-columns">
        <aside class="hx-list" id="hx-list">
            {{-- Candidates tab --}}
            <div id="hx-candidates-tab">
                <div class="hx-list-head">
                    <span id="hx-count">…</span>
                    <button type="button" id="hx-batch-approve" hidden
                            title="Approve every listed candidate the policy clears (exact match, single occurrence, real quote). The server re-checks each one.">✓ approve listed</button>
                </div>
                <div class="hx-filters" id="hx-filters">
                    <select id="hx-filter-status" aria-label="Filter by status">
                        <option value="">all statuses</option>
                        <option value="matched" selected>matched</option>
                        <option value="pending">pending (no quote)</option>
                        <option value="no_match">quote not found</option>
                        <option value="applied">applied</option>
                        <option value="rejected">rejected</option>
                        <option value="failed">failed</option>
                    </select>
                    <select id="hx-filter-method" aria-label="Filter by match method">
                        <option value="">any method</option>
                        <option value="exact">exact</option>
                        <option value="normalized">normalized</option>
                        <option value="fts_fuzzy">fuzzy</option>
                    </select>
                    <label class="hx-chk"><input type="checkbox" id="hx-filter-internal"
                        title="Only citations of works that are ALSO in this collection"> internal only</label>
                </div>
                <div id="hx-candidates-list" role="list"></div>
                <p class="hx-empty" id="hx-candidates-empty" hidden>No candidates yet — press
                    <strong>⌕ detect candidates</strong> above. It scans every imported article's
                    citations against the works we hold. Free.</p>

                {{-- The permanent record: every applied hypercite of this collection,
                     independent of the working filter above — approving means the
                     result OUTLIVES the review session. Click to review / revert. --}}
                <div class="hx-applied" id="hx-applied-section" hidden>
                    <h3 class="hx-group-title">✓ applied hypercites (<span id="hx-applied-count">0</span>)</h3>
                    <div id="hx-applied-list" role="list"></div>
                </div>
            </div>

            {{-- Most-cited tab --}}
            <div id="hx-mostcited-tab" hidden>
                <div class="hx-list-head">
                    <span id="hx-mostcited-count">…</span>
                    <span class="hx-mc-bulk">
                        <select id="hx-bulk-limit" title="How many of the importable works to attempt in one run">
                            <option value="5" selected>next 5</option>
                            <option value="25">next 25</option>
                            <option value="100">next 100</option>
                            <option value="0">all listed</option>
                        </select>
                        <button type="button" id="hx-import-all"
                            title="Import the most-cited external OA works in one run, collected onto a public 'Cited by:' shelf for assessment. PDF fetch + OCR is charged to you.">⇩ import all OA</button>
                    </span>
                </div>
                <div class="hx-list-head">
                    <span class="hx-actions-status" id="hx-mc-status" role="status" aria-live="polite"></span>
                    <a id="hx-assess-link" hidden>assess imports →</a>
                </div>
                <p class="hx-mostcited-note">Counts come from resolved bibliographies — run a
                    detect first or they undercount. <strong>⇩ import</strong> fetches an external
                    OA work so the next detect can match quotes against it.</p>
                <h3 class="hx-group-title">external works</h3>
                <div id="hx-external-list" role="list"></div>
                <h3 class="hx-group-title">this journal's own articles</h3>
                <div id="hx-internal-list" role="list"></div>
            </div>

            {{-- Selected candidate: the evidence + the verdict buttons. --}}
            <div class="hx-selected" id="hx-selected" hidden>
                <div class="hx-selected-meta" id="hx-selected-meta"></div>
                <blockquote class="hx-selected-quote" id="hx-selected-quote"></blockquote>
                <div class="hx-selected-actions">
                    {{-- Occurrence picker. A quote can appear many times in the
                         cited work and only a human can say which one the
                         citing author meant; the ranked default is the body
                         occurrence, not the title block it used to land on.
                         Hidden unless there is a choice to make. --}}
                    <span class="hx-occurrence" id="hx-occurrence" hidden>
                        <button type="button" class="hx-occ-btn" id="hx-occ-prev" aria-label="Previous occurrence">↑</button>
                        <span class="hx-occ-count" id="hx-occ-count" role="status" aria-live="polite"></span>
                        <button type="button" class="hx-occ-btn" id="hx-occ-next" aria-label="Next occurrence">↓</button>
                    </span>
                    <button type="button" id="hx-approve" title="Mint the hypercite: the quoted passage in the cited article becomes the target, and a ↗ appears after the citation marker in the citing article.">✓ hypercite</button>
                    <button type="button" id="hx-reject" title="Not a valid link — recorded, and kept as labeled data for the auto-approve policy.">✕ reject</button>
                    <button type="button" id="hx-revert" hidden title="Undo this hypercite: the ↗ is removed from the citing article and the link deleted; the candidate returns to matched for re-review.">↩ revert</button>
                    <span class="hx-actions-status" id="hx-selected-status" role="status" aria-live="polite"></span>
                </div>
            </div>
        </aside>

        <section class="hx-pane">
            <div class="hx-pane-label" id="hx-citing-label">citing article</div>
            <iframe id="hx-citing" title="Citing article" src="about:blank"></iframe>
            <div class="hx-pane-placeholder" id="hx-citing-placeholder">select a candidate</div>
        </section>

        <section class="hx-pane">
            <div class="hx-pane-label" id="hx-cited-label">cited article</div>
            <iframe id="hx-cited" title="Cited article" src="about:blank"></iframe>
            <div class="hx-pane-placeholder" id="hx-cited-placeholder">select a candidate</div>
        </section>
    </div>
    @endif

    <div class="hx-help-panel" id="hx-help-panel" hidden>
        <h2>Reading this page <button type="button" id="hx-help-close" aria-label="Close help">✕</button></h2>
        <ol>
            <li><strong>⌕ detect candidates</strong> walks every held book of this collection (a journal's imported articles, or a public shelf's items): each book's resolved citations are intersected with the works we hold (any held book, not just this collection), each in-text marker becomes a candidate, quotes near markers are detected, and each quote is searched for in the cited text. Re-running is safe — it upserts, and your verdicts survive.</li>
            <li><strong>One row per citation site.</strong> A quote badge means the citation carries a direct quote; the method badge (exact / normalized / fuzzy) says how the quote was found in the cited text. Rows without a quote are context — reviewable, not appliable.</li>
            <li><strong>Click a row</strong> to load the citing article (left, at the citation's paragraph) beside the cited article (right, at the matched passage). Both are the real reader.</li>
            <li><strong>✓ hypercite</strong> mints it: a hypercite row on the cited article and a ↗ link after the citation marker in the citing one. <strong>✕ reject</strong> records the no — rejections survive re-detects and train the auto-approve policy.</li>
            <li><strong>A 409 on approve</strong> means a book changed since detection (usually a reconvert) — press detect again and re-review.</li>
            <li><strong>most cited</strong> ranks the works this collection's books cite. Import the big external OA ones, re-run detect, and their quotes become matchable too.</li>
        </ol>
        <p class="hx-help-doc">Design: plan file + <code>docs/journal-harvest.md</code></p>
    </div>

    <script>window.__hyperciteConsole = { slug: @json($journalSlug), shelfId: @json($shelfId), scopeLabel: @json($scopeLabel) };</script>
    @vite(['resources/js/maintainerHypercites/main.ts'])
</body>
</html>
