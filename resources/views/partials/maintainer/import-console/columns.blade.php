{{-- The import console's three panes, shared by /maintainer/journal-import/{slug} and
     /maintainer/shelf-import/{id} — one markup, as there is one script (main.ts) wiring it.
     Same shape as /maintainer/conversion: the article/lane list drives two iframes — what we
     produced, and what we produced it FROM.

     INCLUDED BY BOTH BLADES ON PURPOSE. The shelf page used to carry its own copy of this,
     and every panel added to the journal page afterwards (the lint strip, "problems first",
     the findings list) silently never reached it. A control that belongs to both scopes goes
     HERE; tests/Feature/Architecture/ImportConsoleParityTest.php holds the two pages to it.

     $scope is 'journal' or 'shelf' and only chooses wording. --}}
@php($isShelf = ($scope ?? 'journal') === 'shelf')
<div class="ji-columns" id="ji-columns">
    <aside class="ji-articles" id="ji-articles">
        <div class="ji-articles-head">
            <span id="ji-articles-count">…</span>
            <label class="ji-only-imported">
                <input type="checkbox" id="ji-only-imported"> imported only
            </label>
            {{-- A failed work still mints its lane row, so "failed" is a lane with no content.
                 Without this you hunt 100+ rows for the handful a run reported. --}}
            <label class="ji-only-imported">
                <input type="checkbox" id="ji-only-failed"> failed only
            </label>
            {{-- Without this the metadata flags are decorative: a journal-wide repair leaves
                 a badge on ~1 row in 10, scattered through a thousand, and the diff only on
                 hover. This is how you find the ones asking you to decide. --}}
            <label class="ji-only-imported">
                <input type="checkbox" id="ji-only-metadata"> metadata drift
            </label>
            {{-- Ranks by what the stored conversions LOOK wrong in (conversion lint), worst
                 first, and drops the clean ones. The point of the whole strip below: find
                 the next converter bug by searching the journal, not by reading it. --}}
            <label class="ji-only-imported" title="Worst first, clean articles hidden — ranked by problems found in the stored conversion">
                <input type="checkbox" id="ji-only-problems"> problems first
            </label>
        </div>
        {{-- Conversion lint, scope-wide. One line of totals, a snapshot button, and — once
             a snapshot exists — the before/after: which kinds of problem a reconvert removed
             and, in the warning colour, any it INTRODUCED. Hidden until the first payload
             lands. Not a live region: it repaints on every poll during a drain. --}}
        <div class="ji-lint-bar" id="ji-lint-bar" hidden>
            <div class="ji-lint-line">
                <span id="ji-lint-summary">checking for problems…</span>
                <button type="button" id="ji-lint-snapshot" disabled>snapshot</button>
                <button type="button" id="ji-lint-cases" hidden
                        title="Download one example case per kind of problem you confirmed, plus the list of everything you confirmed or dismissed — for book:import-cases on a dev machine">⤓ reviewed cases</button>
                <button type="button" id="ji-lint-sample" hidden
                        title="No review needed: download an example case for every kind of problem found — two for a kind the last reconvert made worse — for book:import-cases on a dev machine">⤓ sample cases</button>
            </div>
            <div class="ji-lint-compare" id="ji-lint-compare" hidden>
                <div class="ji-lint-compare-body" id="ji-lint-compare-body"></div>
                <div class="ji-lint-line">
                    <label class="ji-only-imported" id="ji-only-new-label" hidden
                           title="Only articles with a problem that was not in the snapshot">
                        <input type="checkbox" id="ji-only-new"> new only
                    </label>
                    <button type="button" id="ji-lint-clear" title="Discard the snapshot and stop comparing">clear snapshot</button>
                </div>
            </div>
        </div>
        {{-- 107 rows is past the point where scrolling finds anything. Title/DOI, live. --}}
        <input type="search" id="ji-article-search" class="ji-article-search"
               placeholder="{{ $isShelf ? 'Find a work by title or DOI…' : 'Find an article by title or DOI…' }}"
               aria-label="{{ $isShelf ? 'Find a work' : 'Find an article' }}">
        <div id="ji-articles-list" role="list"></div>
        {{-- Says what to DO, not just what is missing: an empty list here used to be a dead
             end, because every action on this page needs an article row to hang off. --}}
        @if($isShelf)
            <p class="ji-empty" id="ji-articles-empty" hidden>Nothing assessable on this shelf yet —
                its books carry no canonical link, or the shelf is empty. Imports from the
                hypercite console's <strong>⇩ import all OA</strong> land here.</p>
        @else
            <p class="ji-empty" id="ji-articles-empty" hidden>No articles enumerated yet — press
                <strong>⟳ enumerate</strong> above to ask OpenAlex what this journal has published.
                It's free and touches no publisher.</p>
        @endif
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
                {{-- What the lint found in THIS lane. Open by default — it is why you
                     selected the lane — and collapsible, because the list sits on top of the
                     conversion you then want to read. --}}
                <button type="button" class="ji-note-toggle" id="ji-findings-toggle"
                        aria-expanded="true" aria-controls="ji-findings" hidden>problems</button>
                <span class="ji-bookid-meta" id="ji-bookid-meta"></span>
            </div>
            {{-- Each row jumps the pane below to its node. --}}
            <div class="ji-findings" id="ji-findings" hidden></div>
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
