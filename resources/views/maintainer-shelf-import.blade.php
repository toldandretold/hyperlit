<!DOCTYPE html>
{{-- The journal-import console over a SHELF scope: same CSS, same JS entry (boot
     global carries mode:'shelf'), and the same blade partials for the panes, the
     action bars and the run panel. Only the header is the shelf's own — it has no
     journal-registry controls (enumerate / import), because a shelf has no OpenAlex
     source to enumerate, and it carries the archive-page record instead. --}}
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
    @include('partials.maintainer-theme')

@if($isDetail)
    <header class="ji-header">
        <h1 id="ji-journal-name">…</h1>
        <span class="ji-header-sub" id="ji-journal-meta"></span>

        {{-- Shelf-WIDE, so it lives in the header rather than the per-article action bar below
             (which is hidden until a lane is selected). Re-runs the current converter over every
             imported lane on the shelf, each from its own cached source — free, nothing re-fetched,
             no OCR. The way a processor fix reaches a corpus imported before it existed. --}}
        <div class="ji-journal-actions">
            {{-- Which lanes "reconvert all" covers. Same id as the journal console's picker, which
                 main.ts reads — there it doubles as the import lane; here there is no import. --}}
            <label class="ji-visually-hidden" for="ji-bulk-lanes">Lanes to reconvert</label>
            <select id="ji-bulk-lanes">
                <option value="both" selected>every lane</option>
                <option value="html">HTML lanes only</option>
                <option value="pdf">PDF lanes only</option>
            </select>
            <button type="button" id="ji-reconvert-all"
                    title="Re-run the current converter over EVERY imported book on this shelf, from each one's cached source. Free — nothing is re-fetched and no OCR runs. Books convert one at a time on the import worker.">⟲ reconvert all</button>
            <span class="ji-actions-status" id="ji-journal-status" role="status" aria-live="polite"></span>
        </div>

        <nav class="ji-header-nav">
            <a href="/maintainer/shelf-import">&larr; all shelves</a>
            <a id="ji-public-link" href="#" target="_blank" rel="noopener">public page →</a>
            <a href="/maintainer/hypercites/shelf/{{ $shelfId }}">hypercites →</a>
            <a href="/maintainer/citations">citations →</a>
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

    {{-- The panes, the action bars and the run panel are the SAME partials the journal detail
         page includes — not a copy of them. Anything that belongs to both scopes is added there. --}}
    @include('partials.maintainer.import-console.columns', ['scope' => 'shelf'])

    @include('partials.maintainer.import-console.action-bars')

    @include('partials.maintainer.import-console.run-panel')

    <div class="ji-help-panel" id="ji-help-panel" hidden>
        <h2>Reading this page <button type="button" id="ji-help-close" aria-label="Close help">✕</button></h2>
        <ol>
            <li><strong>This shelf's works</strong>, most-cited first — one row per canonical work behind the shelf's books. "Cited by:" shelves are filled by the hypercite console's <strong>⇩ import all OA</strong>.</li>
            <li><strong>Each imported lane is a sub-row</strong>: <code>pdf</code> (vacuumed PDF + OCR), <code>html</code> (publisher page via the paste engine), <code>ar5iv</code> — plus <code>jats</code> / <code>web</code> when the vacuum ladder won with publisher XML or a browser-fetched page instead of a PDF. Lanes are sibling library rows on one canonical — including siblings that are not on this shelf, because comparing them is the workflow.</li>
            <li><strong>★ marks the promoted lane</strong> — the one readers resolve to. Promoting from here also swaps the winner onto this shelf in place of demoted siblings.</li>
            <li><strong>Click a lane</strong> to load what we produced (left) beside what we produced it from (right).</li>
            <li><strong>The badges are the evidence</strong>: completeness, the body-presence verdict, which host the copy won from, and any open conversion flags.</li>
            <li><strong>Search the shelf for problems instead of reading it.</strong> Every book on the shelf is checked for the shapes conversion bugs leave behind — a paragraph or blockquote that starts mid-sentence, a footnote sitting in the body, a footnote nothing points to, a suspicious heading, a page header repeated across books — and gets a <code>N problems</code> badge. Tick <strong>problems first</strong> to rank the list worst first; select a lane and each problem is a row that jumps the converted output to it. These are places to look, not verdicts.</li>
            <li><strong>⟲ reconvert all</strong> re-runs the current converter over every book ON this shelf (not the sibling lanes listed beside them), each from its cached source — free. The panel at the bottom right follows it: first while the books are queued, then while they <em>drain</em> through the import worker one at a time, which is the long part. A book shows "no content" until its turn comes, and the button stays disabled until the queue is empty.</li>
            <li><strong>Snapshot before a reconvert, compare after.</strong> <code>snapshot</code> records today's problems; <code>⟲ reconvert all</code> takes one for you. From then on the strip above the list shows what each kind of problem did (<code>▼</code> fewer, <code>▲</code> more) and how many are <em>new</em> — problems the reconvert introduced. Books still waiting to convert are left out until they are back, so the numbers are safe to read mid-drain.</li>
            <li><strong>Conversion code needs FIXING?</strong> <strong>⤓ conversion</strong> downloads <code>&lt;book&gt;.tar.gz</code> (DB rows + original + OCR cache + decision traces); <strong>⤓ harvest</strong> is the same bundle blaming acquisition. On your dev machine, ONE command ingests everything in Downloads:<br><code>php artisan book:import-cases --downloads</code><br>It imports each book locally and captures regression fixtures automatically.</li>
            <li><strong>Then back to hypercites →</strong> and re-run detect — the imported works are matchable as soon as their conversion lands.</li>
        </ol>
        <p class="ji-help-doc">Design: <code>docs/journal-harvest.md</code> · <code>docs/web-scrape-import.md</code></p>
    </div>
@else
    <header class="ji-header">
        <h1>Shelf import</h1>
        <span class="ji-header-sub" id="ji-summary">loading…</span>
        <nav class="ji-header-nav">
            <a href="/maintainer/journal-import">journals →</a>
            <a href="/maintainer/hypercites">hypercites →</a>
            <a href="/maintainer/citations">citations →</a>
            <a href="/maintainer/conversion">conversions →</a>
            <a href="/maintainer" title="Every workbench">all workbenches</a>
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
    @vite(['resources/js/workbenches/journalImport/main.ts'])
</body>
</html>
