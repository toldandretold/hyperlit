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
    @include('partials.maintainer-theme')

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
                    {{-- Cheap-first is the default for FILLING a journal: it tries the free
                         publisher page per work and only buys OCR where that yields nothing
                         publishable. The three below are the COMPARISON modes — they import a lane
                         because you want to look at it, which is a different job and, for `both`,
                         pays for every work twice. --}}
                    <option value="html_first" selected>HTML, PDF if needed</option>
                    <option value="html">HTML only</option>
                    <option value="pdf">PDF only</option>
                    <option value="both">both (compare)</option>
                </select>
                <label class="ji-visually-hidden" for="ji-bulk-limit">How many works</label>
                <select id="ji-bulk-limit">
                    <option value="5" selected>next 5</option>
                    <option value="25">next 25</option>
                    <option value="100">next 100</option>
                    <option value="0">all eligible</option>
                </select>
                {{-- One run is capped at 50 minutes (the queue's retry_after leaves no room for
                     more), so a journal of a few hundred works needs a dozen presses. This makes
                     the job re-dispatch itself until the queue is empty. Opt-in and capped,
                     because it spends money with nobody watching. --}}
                <label class="ji-bulk-continue" title="Keep re-starting the run until the journal is fully imported. Each run is capped at 50 minutes; without this you have to press import again for each one.">
                    <input type="checkbox" id="ji-bulk-continue">
                    keep going
                </label>
                <button type="button" id="ji-bulk-import"
                        title="Import the most-cited eligible works that have no version yet. The HTML lane is free; PDF runs OCR and is charged to you.">⇩ import</button>
            </span>
            {{-- Re-run the CURRENT converter over everything already imported. This is how a
                 processor fix reaches the corpus it was written for — without it a fix shipped
                 after a 944-article journal applies to nothing, and doing it a book at a time is
                 not a real option. FREE: each lane replays what is already on disk (a PDF lane its
                 ocr_response.json, an HTML lane its stored page), so nothing is fetched or OCR'd. --}}
            <button type="button" id="ji-reconvert-all"
                    title="Re-run the current converter over every imported lane, from each one's cached source. Free — nothing is re-fetched and no OCR runs. Books convert one at a time on the import worker.">⟲ reconvert all</button>
            {{-- Certification is the editorial half of this console: everything else here decides
                 whether a CONVERSION is good, this decides whether the JOURNAL is ready to show
                 visitors. It is what puts a journal in the homepage copy — nothing automatic can
                 grant it, because "I have read these and they're right" is not a thing a gate can
                 check. The homepage additionally drops any certified journal with no readable
                 article, so this never has to be un-set to fix an emptied journal. --}}
            {{-- The public hero shows OpenAlex's registered name, which for some venues is a
                 whole sentence — and the colon squares are sized to the rendered title block,
                 so a nine-line name stretches the mark across the card. This sets a short
                 form for the HERO ONLY (hero_name); the full display_name still carries the
                 <title>, meta description and JSON-LD, and is resynced from OpenAlex. Empty
                 the box to go back to the full name. --}}
            <span class="ji-hero-name-group">
                <label class="ji-visually-hidden" for="ji-hero-name">Short name for the public page hero</label>
                <input type="text" id="ji-hero-name" maxlength="120" autocomplete="off"
                       placeholder="hero name (blank = full title)"
                       title="What the /j page shows as the journal's name. Leave blank to use the full registered title.">
                <button type="button" id="ji-hero-name-save"
                        title="Save the hero name. Affects the public page's heading only — the citation identity stays the full title.">save</button>
            </span>
            <button type="button" id="ji-certify" aria-pressed="false"
                    title="Show this journal on the Hyperlit homepage. Certify it once you've read the conversions — it only appears there while it has at least one readable article.">☆ certify</button>
            <span class="ji-actions-status" id="ji-journal-status" role="status" aria-live="polite"></span>
        </div>

        <nav class="ji-header-nav">
            <a href="/maintainer/journal-import">&larr; all journals</a>
            <a id="ji-public-link" href="#" target="_blank" rel="noopener">public page →</a>
            <a href="/maintainer/citations">citations →</a>
            <a href="/maintainer/conversion">conversions →</a>
            <a href="/maintainer" title="Every workbench">all workbenches</a>
        </nav>
        <button type="button" id="ji-help-toggle" aria-expanded="false" aria-controls="ji-help-panel" title="How this works">?</button>
    </header>

    @include('partials.maintainer.import-console.columns', ['scope' => 'journal'])

    @include('partials.maintainer.import-console.action-bars')

    @include('partials.maintainer.import-console.run-panel')

    <div class="ji-help-panel" id="ji-help-panel" hidden>
        <h2>Reading this page <button type="button" id="ji-help-close" aria-label="Close help">✕</button></h2>
        <ol>
            <li><strong>Start with ⟳ enumerate</strong> — it asks OpenAlex what this journal has published and lists it here. Nothing else on this page works until it has run, because every other action targets an article row. Free: no publisher is contacted and no OCR runs.</li>
            <li><strong>Then ⇩ import</strong> to work the queue in bulk — most-cited eligible works first. <code>HTML, PDF if needed</code> is the default and the one to use for FILLING a journal: per work it tries the publisher page, which is free, and buys OCR only where that yields nothing publishable. The three single-lane options import a lane because you want to <em>look</em> at it, which is a different job — <code>both</code> in particular pays for every work whether or not the free lane already worked.</li>
            <li><strong>A run is capped at 50 minutes</strong>, so a journal of a few hundred works needs many of them. When one stops at that limit the panel says so and offers <em>continue →</em>; tick <strong>keep going</strong> before you start and it re-runs itself until the journal is done, stopping at its spend cap. The work cap is your other spend control — <code>all eligible</code> is a real option but never the default.</li>
            <li><strong>A work that fails backs off</strong> before it is tried again — an hour, then six, then a day, and so on per consecutive failure. Without that a dead article would sit at the front of the queue (it is usually a much-cited one) and be re-fetched at the head of every single run. Works waiting out a cooldown are reported separately from <em>eligible</em>, so a "remaining" number that stops falling has a visible reason. Importing an article by hand ignores the cooldown entirely, and succeeding clears it.</li>
            <li><strong>One row per article</strong>, most-cited first — every work OpenAlex lists for this journal, whether or not we've imported it.</li>
            <li><strong>Each imported lane is a sub-row</strong>: <code>pdf</code> (vacuumed PDF + OCR), <code>html</code> (publisher page via the paste engine), <code>ar5iv</code> — plus <code>jats</code> / <code>web</code> when the vacuum ladder won with publisher XML or a browser-fetched page instead of a PDF. Lanes are sibling library rows on one canonical, each with its own book id and artifacts.</li>
            <li><strong>★ marks the promoted lane</strong> — the one <code>/j/&lt;slug&gt;</code>, the shelf and readers resolve to. The others stay imported but unlisted.</li>
            <li><strong>Click a lane</strong> to load what we produced (left) beside what we produced it from (right): the PDF for the PDF lane, the fetched publisher page for the HTML lane.</li>
            <li><strong>Search the journal for problems instead of reading it.</strong> Every imported lane is checked for the shapes conversion bugs leave behind — a paragraph or blockquote that starts mid-sentence, a footnote sitting in the body, a footnote nothing points to, a suspicious heading, a page header repeated across articles — and gets a <code>N problems</code> badge. Tick <strong>problems first</strong> to rank the list worst first; select a lane and each problem is a row that jumps the converted output to it. These are places to look, not verdicts.</li>
            <li><strong>Snapshot before a reconvert, compare after.</strong> <code>snapshot</code> records today's problems; <code>⟲ reconvert all</code> takes one for you if there is none. From then on the strip above the list shows what each kind of problem did (<code>▼</code> fewer, <code>▲</code> more) and how many are <em>new</em> — problems the reconvert introduced, flagged <code>▲ new</code> on their lane. Lanes still waiting to convert are left out until they are back, so the numbers are safe to read mid-drain.</li>
            <li><strong>Say whether a problem is real.</strong> Each listed problem has <code>✓</code> (real) and <code>✗</code> (false alarm). <code>✗</code> hides it and stops counting it, for good — it stays dismissed after a reconvert, and can be undone from the “dismissed” line under the list. <code>✓</code> adds it to the lane's note, which opens a case. You do not need to judge them all: a few per kind of problem is enough. <code>⤓ reviewed cases</code> then downloads one example case per kind you confirmed, plus the list of everything you confirmed or dismissed — hand it to <code>book:import-cases --downloads</code>.</li>
            <li><strong>The badges are the evidence</strong>: completeness, the body-presence verdict, which host the copy won from, and any open conversion flags.</li>
            <li><strong>☆ certify when the journal is ready to show people.</strong> That is what puts it in the homepage copy, linked to its <code>/j/&lt;slug&gt;</code> page. It is your judgement, not a gate — <code>◆ diamond</code> is DOAJ's fact about APCs, this is you saying the conversions are worth reading. A certified journal with no readable article is silently left off the homepage, so you never have to un-certify one to fix it.</li>
            <li><strong>An article with no lanes</strong> selects too — the bar offers <code>PDF</code>, <code>HTML</code> or <code>both</code>. HTML is free; PDF runs OCR and is charged to you.</li>
        </ol>
        <h3>Reconvert or re-fetch?</h3>
        <p>They answer different questions, which is the point of having both. <strong>↻ reconvert</strong> re-runs the converter over the page <em>already on disk</em> — no network, no cost — so it is what you press after fixing a processor and shipping it; the input is held constant, so any change in the output is your fix. <strong>⇩ re-fetch</strong> goes back to the publisher, for when what we stored isn't the article at all (empty, paywalled, wrong page). Same fork as the two bundles: <code>⤓ conversion</code> blames the converter, <code>⤓ harvest</code> blames acquisition.</p>
        <p>The PDF lane reconverts through the shared <code>/maintainer/conversion</code> path (it has an <code>original.pdf</code> and an OCR cache, so it costs nothing to re-run). Re-acquiring a PDF is a retract-and-re-harvest, not a button here.</p>
        <p class="ji-help-doc">Design: <code>docs/journal-harvest.md</code></p>
    </div>

    <script>window.__journalImport = { slug: @json($journalSlug) };</script>
    @vite(['resources/js/workbenches/journalImport/main.ts'])
</body>
</html>
