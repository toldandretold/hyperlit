<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Journal import — Hyperlit</title>
    <meta name="robots" content="noindex">
    @vite(['resources/css/pages/maintainer-journal-import.css'])
</head>
<body>
    {{-- Theme before paint: the reader's storage key (same pattern as the sibling maintainer pages). --}}
    <script>
        (function () {
            var t = 'dark';
            try { t = localStorage.getItem('hyperlit_theme_preference') || 'dark'; } catch (e) {}
            if (['dark', 'light', 'sepia'].indexOf(t) === -1) t = 'dark';
            document.body.classList.add('theme-' + t);
        })();
    </script>

    <header class="ji-header">
        <h1>Journal import</h1>
        <span class="ji-header-sub" id="ji-summary">loading…</span>
        <nav class="ji-header-nav">
            <a href="/maintainer/conversion">conversions →</a>
            <a href="/maintainer/jobs">jobs →</a>
            <a href="/maintainer/storage">storage →</a>
            <a href="/">&larr; Hyperlit</a>
        </nav>
        <button type="button" id="ji-help-toggle" aria-expanded="false" aria-controls="ji-help-panel" title="How this works">?</button>
    </header>

    <main class="ji-main">
        <div class="ji-filter-row">
            <input type="search" id="ji-filter" class="ji-filter" placeholder="Filter by name, publisher or ISSN…" autocomplete="off" spellcheck="false">
        </div>

        {{-- Journals we've pulled at least one article from. --}}
        <section class="ji-section" aria-label="Journals in progress">
            <h2>In progress</h2>
            <div id="ji-started-list" role="list"></div>
            <p class="ji-empty" id="ji-started-empty" hidden>Nothing imported yet — pick one below.</p>
        </section>

        {{-- The worklist: the registry, most-cited first. Same ordering as `journal:list` and /j. --}}
        <section class="ji-section" aria-label="Journals not yet started">
            <div class="ji-section-head">
                <h2>Next up</h2>
                <span class="ji-section-note">registry order — most cited first</span>
            </div>
            <div id="ji-next-list" role="list"></div>
            <p class="ji-empty" id="ji-next-empty" hidden>Registry is empty — run <code>php artisan journal:sync-registry</code>.</p>
        </section>
    </main>

    <div class="ji-status" id="ji-status" role="status" aria-live="polite"></div>

    {{-- Workflow help (the ? button) --}}
    <div class="ji-help-panel" id="ji-help-panel" hidden>
        <h2>The loop <button type="button" id="ji-help-close" aria-label="Close help">✕</button></h2>
        <ol>
            <li><strong>Pick a journal.</strong> "In progress" is anything already harvested; "Next up" is the diamond registry, most-cited first.</li>
            <li><strong>Not in the registry yet?</strong> Add it from the CLI: <code>php artisan journal:sync-registry --issn=&lt;issn&gt;</code> — DOAJ decides whether it's diamond, OpenAlex supplies the rest.</li>
            <li><strong>Open a journal</strong> to see every article it knows about and, per article, every imported <strong>lane</strong>.</li>
            <li><strong>Lanes are the point.</strong> The same article converted from the PDF and from the publisher's HTML come out differently — OCR loses headings the HTML keeps. Compare them side by side, then promote the better one.</li>
            <li><strong>Only the promoted lane is public.</strong> It's what <code>/j/&lt;slug&gt;</code>, the shelf and readers resolve to; the sibling stays imported but unlisted so you can keep comparing.</li>
        </ol>
        <p class="ji-help-doc">Runbook: <code>app/Services/JournalHarvest/README.md</code> · Design: <code>docs/journal-harvest.md</code></p>
    </div>

    @vite(['resources/js/maintainerJournalImport/main.ts'])
</body>
</html>
