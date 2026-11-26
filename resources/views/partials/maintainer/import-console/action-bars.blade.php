{{-- Floating action bar for the selected lane (draggable, like the conversion page's).
     The two bundle buttons and the two re-run buttons are the same fork: is the CONVERSION
     wrong, or is the page we acquired wrong? --}}
<div class="ji-actions" id="ji-actions" hidden>
    <span class="ji-actions-grip" id="ji-actions-grip" title="Drag to move">⠿</span>
    <span class="ji-actions-book" id="ji-actions-book"></span>
    <button type="button" id="ji-open-reader" title="Open this lane in the reader">open ↗</button>
    <button type="button" id="ji-promote" title="Make this lane the version readers get">★ make version</button>
    <button type="button" id="ji-reconvert" title="Re-run the converter over the page we already have — no network, no cost. The fix loop after you ship a processor change.">↻ reconvert</button>
    <button type="button" id="ji-refetch" title="Go back to the publisher for a fresh copy — for when what we stored isn't the article">⇩ re-fetch</button>
    <button type="button" id="ji-export" title="Bundle blaming the CONVERTER — replays through run_regression.py">⤓ conversion</button>
    <button type="button" id="ji-export-harvest" title="Bundle blaming ACQUISITION — ships canonical_source + fetch_trace.json">⤓ harvest</button>
    {{-- Dev machines only: it runs run_regression.py against the local fixture tree. --}}
    @if(!app()->environment('production'))
        <button type="button" id="ji-approve-golden" title="Freeze this book's CURRENT conversion as the regression golden — the promote-to-golden step after the converter is fixed (runs run_regression.py --update-golden)">✓ golden</button>
    @endif
    <span class="ji-actions-status" id="ji-actions-status" role="status" aria-live="polite"></span>
</div>

{{-- Shown instead of the lane bar when the selected article has no lanes yet. --}}
<div class="ji-actions ji-import-bar" id="ji-import-bar" hidden>
    <span class="ji-actions-grip" id="ji-import-grip" title="Drag to move">⠿</span>
    <span class="ji-actions-book" id="ji-import-title"></span>
    <span class="ji-import-label">not imported — fetch:</span>
    <button type="button" id="ji-import-pdf" title="Vacuum the PDF and OCR it (slow, costs OCR credit)">PDF</button>
    <button type="button" id="ji-import-html" title="Fetch the publisher page and run the paste engine (free)">HTML</button>
    <button type="button" id="ji-import-both" title="Both lanes, so you can compare them">both</button>
    <span class="ji-actions-status" id="ji-import-status" role="status" aria-live="polite"></span>
</div>
