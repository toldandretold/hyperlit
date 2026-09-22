{{--
  In-text search toolbar — iOS Safari style find bar.

  Single-sourced (2026-09-21) after living as five verbatim copies in
  reader / home / user / journal-home / archive-home. Driven by
  resources/js/search/inTextSearch/, registered through ButtonRegistry as
  'searchToolbar' for pages ['reader','home','user','journal'].

  $semantic — render the exact/semantic mode toggle. READER ONLY, and not
  merely because of encryption: the feed pages search a synthetic book
  ({username}All, a shelf render, most-recent), every one of which
  App\Services\EmbeddingEligibility excludes from embedding, so a toggle there
  could only ever return zero results. The reader hides it again at runtime for
  E2EE books and sub-books (see searchToolbar.ts applyModeAvailability).
--}}
@php($semantic = $semantic ?? false)

<div id="search-toolbar">
  @if ($semantic)
    <div id="search-mode-toggle" class="search-mode-toggle" role="group" aria-label="Search mode">
      <button type="button" class="search-mode-toggle-btn active" data-search-mode="exact"
              aria-pressed="true" title="Match the exact words you type">exact</button>
      <button type="button" class="search-mode-toggle-btn" data-search-mode="semantic"
              aria-pressed="false" title="Find passages by meaning, even in different words">meaning</button>
    </div>
  @endif

  <input type="text" id="search-input" placeholder="Find in document" autocomplete="off" />

  <button type="button" id="search-prev-button" aria-label="Previous match">
    <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
      <rect width="24" height="24" />
      <polyline points="18 15 12 9 6 15" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  </button>

  <button type="button" id="search-next-button" aria-label="Next match">
    <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
      <rect width="24" height="24" />
      <polyline points="6 9 12 15 18 9" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  </button>

  <span id="search-match-counter">0 of 0</span>
</div>
