<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Job failures — Hyperlit</title>
    <meta name="robots" content="noindex">
    @vite(['resources/css/pages/maintainer-jobs.css'])
</head>
<body>
    {{-- Theme before paint: the reader's storage key (same pattern as /maintainer/conversion). --}}
    <script>
        (function () {
            var t = 'dark';
            try { t = localStorage.getItem('hyperlit_theme_preference') || 'dark'; } catch (e) {}
            if (['dark', 'light', 'sepia'].indexOf(t) === -1) t = 'dark';
            document.body.classList.add('theme-' + t);
        })();
    </script>

    <header class="mj-header">
        <h1>Job failures</h1>
        <span class="mj-header-sub" id="mj-summary">loading…</span>
        <nav class="mj-header-nav">
            <a href="/maintainer/conversion">conversions →</a>
            <a href="/maintainer/storage">storage →</a>
            <a href="/">&larr; Hyperlit</a>
        </nav>
        <button type="button" id="mj-help-toggle" aria-expanded="false" aria-controls="mj-help-panel" title="How this works">?</button>
    </header>

    <main class="mj-main">
        {{-- Queue depth: what is waiting right now (from the jobs table). --}}
        <section class="mj-queues" aria-label="Queue depth">
            <h2>Queues</h2>
            <div id="mj-queues-list" class="mj-queues-list"></div>
            <p class="mj-queues-note">
                Worker process state isn't shown — the web process can't ask Supervisor.
                Run <code id="mj-workers-hint">./deploy/supervisor/workers.sh status</code> for that.
            </p>
        </section>

        {{-- The point of the page: failures grouped by what actually broke. --}}
        <section class="mj-groups" aria-label="Failure groups">
            <div class="mj-groups-head">
                <h2>Failures</h2>
                <button type="button" id="mj-mark-seen" title="Stamp everything as seen, so next visit only highlights what's new">mark all seen</button>
            </div>
            <div id="mj-groups-list" role="list"></div>
            <p class="mj-empty" id="mj-groups-empty" hidden>No failed jobs. 🎉</p>
        </section>
    </main>

    <div class="mj-status" id="mj-status" role="status" aria-live="polite"></div>

    {{-- Workflow help (the ? button) --}}
    <div class="mj-help-panel" id="mj-help-panel" hidden>
        <h2>The loop <button type="button" id="mj-help-close" aria-label="Close help">✕</button></h2>
        <ol>
            <li><strong>Read the group, not the rows.</strong> Each row here is one bug, however many times it fired. <strong>NEW</strong> means it happened since you last pressed "mark all seen".</li>
            <li><strong>Historical noise?</strong> <strong>✕ forget</strong> — deletes those <code>failed_jobs</code> rows. That's all "dismiss" can honestly mean.</li>
            <li><strong>Work still needs doing?</strong> <strong>↻ retry</strong> re-queues them. Paid jobs (import, citation, audio, harvest) ask first — a retry re-runs the billable API call.</li>
            <li><strong>Needs a code fix?</strong> <strong>⤓ case bundle</strong> — downloads <code>failure-&lt;key&gt;.tar.gz</code>: full stack trace, every payload, worker-log excerpts, deployed git sha, affected books.</li>
            <li><strong>On your dev machine, ONE command ingests it</strong>:<br><code>php artisan failure:import-cases --downloads</code></li>
            <li><strong>Or one prompt</strong>: tell Claude <code>@tests/failures/cases/ production job failures to fix</code> — each bundle's README is the contract for that specific failure.</li>
            <li><strong>Deploy the fix, come back, ✕ forget the group.</strong></li>
        </ol>
        <p class="mj-help-doc">Which worker runs what: <code>deploy/supervisor/README.md</code></p>
    </div>

    @vite(['resources/js/maintainerJobs/main.ts'])
</body>
</html>
