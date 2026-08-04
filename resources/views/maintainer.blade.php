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
        <a href="/maintainer/jobs">job failures &rarr;</a>
        <a href="/maintainer/storage">storage &rarr;</a>
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
        <span class="mt-actions-grip" id="mt-actions-grip" title="Drag to move (double-click to reset)">⋮⋮</span>
        <span id="mt-actions-book"></span>
        <button type="button" id="mt-export" title="Conversion case: the input was fine, the converter mangled it — downloads the case bundle for the dev loop">⤓ conversion glitch</button>
        <button type="button" id="mt-export-harvest" title="Acquisition case: what we FETCHED was wrong (paywalled landing page, captcha, wrong edition) — carries canonical_source + fetch_trace.json">⤓ harvest glitch</button>
        <button type="button" id="mt-reconvert">↻ reconvert</button>
        <button type="button" id="mt-retract" title="Harvest false positive: this should never have been a version (landing page / captcha / contents-only). Deletes the version, frees the canonical for a legit re-fetch, closes the flag.">🗑 retract</button>
        <button type="button" id="mt-resolve">✓ resolve</button>
        <button type="button" id="mt-dismiss">✕ dismiss</button>
        <span class="mt-actions-status" id="mt-actions-status" role="status"></span>
        <button type="button" id="mt-help-toggle" aria-expanded="false" aria-controls="mt-help-panel" title="How this works">?</button>
    </div>

    {{-- Workflow help (the ? button) --}}
    <div class="mt-help-panel" id="mt-help-panel" hidden>
        <h2>The loop <button type="button" id="mt-help-close" aria-label="Close help">✕</button></h2>
        <ol>
            <li><strong>Judge it.</strong> Book (middle) vs original (right). Conversion actually fine? <strong>✓ resolve</strong> or <strong>✕ dismiss</strong> — done. Closing a flag on a <em>harvested</em> version also PROMOTES it to <strong>listed</strong> (homepage/search/sitemap): auto-versions stay unlisted until a human has looked at them, and this is that look.</li>
            <li><strong>Code already fixed, or worth a re-run?</strong> <strong>↻ reconvert</strong> — runs with progress; highlights &amp; hypercites re-attach automatically. Then resolve.</li>
            <li><strong>Conversion code needs FIXING?</strong> <strong>⤓ conversion glitch</strong> — downloads <code>&lt;book&gt;.tar.gz</code> (DB rows + original + OCR cache + decision traces + the complaint). Leave it in Downloads, or drag it into <code>tests/conversion/cases/</code>.</li>
            <li><strong>Is the CONTENT ITSELF wrong — a paywalled landing page, a captcha, the wrong edition?</strong> That's an <em>acquisition</em> bug, not a conversion bug: the converter faithfully converted junk, so replaying it through <code>run_regression.py</code> just reproduces the junk. <strong>🗑 retract</strong> is the closer: it DELETES the bogus version, frees the canonical for a legitimate re-fetch (the body gate now guards it), and closes the flag as <code>retracted</code>. Bulk cleanup from the terminal: <code>php artisan harvest:retract --flagged --dry-run</code>, then without <code>--dry-run</code>. If the acquisition ladder itself needs a code fix first, grab <strong>⤓ harvest glitch</strong> — same tarball plus <code>canonical_source</code> (what OpenAlex claimed) and <code>fetch_trace.json</code> (which copy won, and the body-gate verdict). Fix <code>ContentFetchService</code>, not <code>app/Python</code>.</li>
            <li><strong>On your dev machine, ONE command ingests everything</strong>:<br><code>php artisan book:import-cases --downloads</code><br>Sweeps Downloads + the drop-folder, imports each book (opens in your local reader), captures regression fixtures automatically.</li>
            <li><strong>Or one prompt</strong>: tell Claude <code>@tests/conversion/cases/ new broken conversions to fix</code> — its README is the full contract (ingest → diagnose via <code>assessment.json</code> → fix → <code>--update-golden</code>).</li>
            <li><strong>Deploy, come back here, ↻ reconvert, ✓ resolve.</strong></li>
        </ol>
        <p>ssh alternative (no browser download): <code>tests/conversion/pull_case.sh &lt;book&gt; --corpus</code></p>
        <p class="mt-help-doc">Full write-up: <code>docs/maintainer-loop.md</code></p>
    </div>

    <script>
        window.__maintainer = { book: @json($deepLinkBook) };
    </script>
    @vite(['resources/js/maintainer/main.ts'])
</body>
</html>
