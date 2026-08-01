<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Storage — Hyperlit</title>
    <meta name="robots" content="noindex">
    @vite(['resources/css/pages/maintainer-storage.css'])
</head>
<body>
    {{-- Theme before paint: the reader's storage key (same pattern as the sibling pages). --}}
    <script>
        (function () {
            var t = 'dark';
            try { t = localStorage.getItem('hyperlit_theme_preference') || 'dark'; } catch (e) {}
            if (['dark', 'light', 'sepia'].indexOf(t) === -1) t = 'dark';
            document.body.classList.add('theme-' + t);
        })();
    </script>

    <header class="ms-header">
        <h1>Storage</h1>
        <span class="ms-header-sub" id="ms-summary">loading…</span>
        <nav class="ms-header-nav">
            <a href="/maintainer/conversion">conversions &rarr;</a>
            <a href="/maintainer/jobs">jobs &rarr;</a>
            <a href="/">&larr; Hyperlit</a>
        </nav>
        <button type="button" id="ms-rescan" title="Measure now — walks the file trees (~2s)">↻ rescan</button>
        <button type="button" id="ms-export" title="Download the full snapshot as JSON — every row, for analysis off the box">⤓ json</button>
        <button type="button" id="ms-help-toggle" aria-expanded="false" aria-controls="ms-help-panel" title="How this works">?</button>
    </header>

    <main class="ms-main">
        <p class="ms-empty" id="ms-empty" hidden>
            No snapshot yet. Press <strong>↻ rescan</strong>, or run <code>php artisan storage:scan</code>.
        </p>

        <div id="ms-body" hidden>
            {{-- Total footprint, one stacked bar, every category at once. --}}
            <section class="ms-section" aria-labelledby="ms-total-h">
                <div class="ms-section-head">
                    <h2 id="ms-total-h">Total footprint</h2>
                    <span class="ms-hero" id="ms-total"></span>
                </div>
                <div id="ms-stack" class="ms-stack"></div>
                <div id="ms-legend" class="ms-legend"></div>

                {{-- Database cost per book / per node. Files excluded on purpose. --}}
                <div class="ms-tiles" id="ms-averages" hidden>
                    <div class="ms-tile">
                        <span class="ms-tile-val" id="ms-avg-book"></span>
                        <span class="ms-tile-label">database per book</span>
                        <span class="ms-tile-sub" id="ms-avg-book-sub"></span>
                    </div>
                    <div class="ms-tile">
                        <span class="ms-tile-val" id="ms-avg-node"></span>
                        <span class="ms-tile-label">database per node</span>
                        <span class="ms-tile-sub" id="ms-avg-node-sub"></span>
                    </div>
                </div>
            </section>

            {{-- Two budgets: droplet disk and the (managed, in prod) database. --}}
            <section class="ms-section" aria-labelledby="ms-meters-h">
                <h2 id="ms-meters-h">Where it lives</h2>
                <div class="ms-meters" id="ms-meters"></div>
                <p class="ms-note" id="ms-managed-note" hidden>
                    The database is a managed cluster — its bytes are <strong>not</strong> droplet disk.
                    Two separate budgets, two separate bills.
                </p>
            </section>

            {{-- The ranked list IS the accessible relief for the chart colours:
                 identity is never carried by colour alone. --}}
            <section class="ms-section" aria-labelledby="ms-cat-h">
                <h2 id="ms-cat-h">By category</h2>
                <div id="ms-categories" class="ms-rows" role="list"></div>
                <p class="ms-note">
                    Database sizes include indexes and TOAST, which is usually most of the number.
                    Click any category to drill in.
                </p>
            </section>

            <section class="ms-section" id="ms-detail-section" hidden aria-labelledby="ms-detail-h">
                <div class="ms-section-head">
                    <h2 id="ms-detail-h">Detail</h2>
                    <button type="button" id="ms-detail-close" aria-label="Close detail">✕</button>
                </div>
                <p class="ms-note" id="ms-detail-note" hidden></p>
                <div id="ms-detail" class="ms-rows" role="list"></div>
            </section>

            {{-- Per-user footprint: the groundwork for quotas. --}}
            <section class="ms-section" id="ms-users-section" hidden aria-labelledby="ms-users-h">
                <div class="ms-section-head">
                    <h2 id="ms-users-h">Per user</h2>
                </div>
                <div class="ms-tiles" id="ms-user-stats"></div>
                <div id="ms-users-rows" class="ms-rows" role="list"></div>
                <p class="ms-note">
                    Database bytes are apportioned by each user's share of node rows — there is no
                    per-user byte figure in Postgres. Files come from the scan. Click a user for the split.
                </p>
            </section>

            <section class="ms-section" aria-labelledby="ms-books-h">
                <h2 id="ms-books-h">Biggest books</h2>
                <div id="ms-books" class="ms-rows" role="list"></div>
            </section>

            <section class="ms-section ms-orphans" id="ms-deleted-section" hidden aria-labelledby="ms-deleted-h">
                <div class="ms-section-head">
                    <h2 id="ms-deleted-h">Deleted, still stored</h2>
                    <span class="ms-hero" id="ms-deleted-total"></span>
                </div>
                <p id="ms-deleted-line"></p>
                <div id="ms-deleted-rows" class="ms-rows" role="list"></div>
                <p class="ms-note" id="ms-deleted-sub"></p>
                <p class="ms-note">
                    Books marked <code>deleted</code> whose nodes are still in the database — usually a book
                    deleted while its import was running, so the conversion finished and wrote into it anyway.
                    The orphan sweep can't see these: it looks for a <em>missing</em> library row, and theirs exists.
                </p>
                <pre class="ms-cmd">php artisan nodes:purge-deleted-books --dry-run</pre>
            </section>

            <section class="ms-section ms-orphans" id="ms-orphan-section" hidden aria-labelledby="ms-orphan-h">
                <div class="ms-section-head">
                    <h2 id="ms-orphan-h">Orphaned</h2>
                    <span class="ms-hero" id="ms-orphan-total"></span>
                </div>
                <p id="ms-orphan-line"></p>
                <div id="ms-orphan-rows" class="ms-rows" role="list"></div>
                <p class="ms-note">
                    Files whose book has no <code>library</code> row — already counted in the totals above.
                    Nothing in the app deletes a book's files, so these accumulate. Reclaim them from a
                    terminal; there is no undo:
                </p>
                <pre class="ms-cmd">php artisan storage:reclaim --dry-run</pre>
            </section>
        </div>
    </main>

    <div class="ms-status" id="ms-status" role="status" aria-live="polite"></div>

    <div class="ms-help-panel" id="ms-help-panel" hidden>
        <h2>What this measures <button type="button" id="ms-help-close" aria-label="Close help">✕</button></h2>
        <ul>
            <li><strong>documents</strong> — <code>resources/markdown/&lt;book&gt;/</code>: the original upload plus every conversion artifact. Artifacts routinely outweigh the original.</li>
            <li><strong>images</strong> / <strong>audio</strong> — <code>storage/app/books/&lt;book&gt;/</code>, the private store behind <code>book_images</code> and <code>book_audio</code>.</li>
            <li><strong>cache</strong> — <code>BookCache</code> JSON. Regenerable: safe to delete, it rebuilds on demand.</li>
            <li><strong>legacy_images</strong> — the pre-E2EE public image tree. Drain it with the image migration, then it's zero.</li>
            <li><strong>database</strong> — <code>pg_total_relation_size</code> per table. In production this is a managed cluster, billed separately from the droplet.</li>
        </ul>
        <p>Snapshots are taken nightly (<code>storage:scan</code>) and kept, so growth is measurable — which is what quota policy needs. Rescan runs the same scan inline.</p>
        <p class="ms-help-doc">Drift warnings mean bytes on disk that no DB row accounts for — untracked blobs.</p>
    </div>

    @vite(['resources/js/maintainerStorage/main.ts'])
</body>
</html>
