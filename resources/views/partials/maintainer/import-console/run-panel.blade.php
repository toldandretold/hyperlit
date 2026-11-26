{{-- Shared by the journal and shelf consoles: a scope-wide run (import, enumerate, reconvert
     all) reports here on both, and so does the drain behind a finished reconvert all.

     What a bulk run is DOING, while it does it. The job has always reported every work
     ("html 7/25: <title>"), but the journal bar painted it into a span the stylesheet keeps
     at opacity 0, so a 50-minute import looked exactly like a dead queue worker: a dimmed
     button and nothing else. This is that report, given somewhere to live — and somewhere
     that survives a reload, because the poll is re-attached from `active_run`.

     Bottom-RIGHT: the failures panel is bottom-left and both are open at once when a run
     finishes badly. Not a modal — it reports, it never blocks, and it takes no focus. --}}
<div class="ji-run-panel" id="ji-run-panel" hidden>
    <div class="ji-run-head">
        <strong id="ji-run-title"></strong>
        <button type="button" id="ji-run-close" aria-label="Close run progress" hidden>✕</button>
    </div>
    <div class="ji-run-bar"><div class="ji-run-bar-fill" id="ji-run-bar-fill"></div></div>
    {{-- The live region is this line ALONE, not the panel: announcing the whole panel on
         every 2.5s poll would read the bar, the tallies and the error list out again each
         tick. The count plus the work in hand is the sentence worth hearing. --}}
    <div class="ji-run-line" role="status" aria-live="polite">
        <span class="ji-run-count" id="ji-run-count"></span>
        <span class="ji-run-current" id="ji-run-current"></span>
    </div>
    <div class="ji-run-tallies" id="ji-run-tallies"></div>
    <div class="ji-run-errors" id="ji-run-errors" hidden></div>
    {{-- Journal imports only (a shelf has no import queue to continue; the banner stays hidden).
         "This journal is NOT finished." A run is capped at 50 minutes, so a big journal takes
         a dozen of them — and that fact used to be a clause at the end of the summary sentence
         in the grey line above, while a handful of failures got their own panel with a bold
         header. A tripleC run did 73 of 960 works and read as a finished job. The headline is
         how much is left; the failures are the footnote. --}}
    <div class="ji-run-continue" id="ji-run-continue" role="status" aria-live="polite" hidden>
        <span id="ji-run-continue-text"></span>
        <button type="button" id="ji-run-continue-go">continue →</button>
    </div>
</div>

{{-- Why the last bulk run's failures happened, grouped by reason. A run that says "13 failed"
     has not told you anything actionable: 13 empty shells is publisher intermittency (press
     again), 3 identity mismatches is our bug. Copy ships the same grouping as plain text. --}}
<div class="ji-failures" id="ji-failures" hidden>
    <div class="ji-failures-head">
        <strong id="ji-failures-title"></strong>
        <button type="button" id="ji-failures-copy" title="Copy this list as plain text">copy</button>
        <button type="button" id="ji-failures-close" aria-label="Close failures">✕</button>
    </div>
    <div class="ji-failures-body" id="ji-failures-body"></div>
</div>
