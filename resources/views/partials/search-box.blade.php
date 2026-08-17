{{--
  Shared search box: auto-growing textarea + Full text / Semantic toggle
  stack + results dropdown. One structure for every page that mounts a
  searchBox instance (resources/js/search/searchBox.ts) — the homepage and
  the journal pages pass their own ids so each page's JS/storage stays
  isolated (see the factory's doc block for why ids differ per page).

  Params:
    $containerId, $inputId, $resultsId, $fulltextToggleId, $semanticToggleId
    $placeholder        — initial placeholder (JS swaps it per mode)
    $fulltextTitle      — tooltip for the Full text toggle
    $shelfId (optional) — journal pages: the shelf backing this journal ('' = not harvested)
--}}
<div id="{{ $containerId }}" class="search-container search-container--multiline"
     @isset($shelfId) data-shelf-id="{{ $shelfId }}" @endisset>
  <div class="search-input-anchor">
    {{-- textarea, not input: wraps + grows downward for long/pasted
         queries (semantic search takes whole passages) --}}
    <textarea
      id="{{ $inputId }}"
      class="search-input"
      placeholder="{{ $placeholder }}"
      autocomplete="off"
      spellcheck="false"
      rows="2"
      maxlength="2000"
    ></textarea>
    <div id="{{ $resultsId }}" class="search-results hidden"></div>
  </div>
  <div class="search-toggle-stack">
    <label class="fulltext-toggle-label" title="{{ $fulltextTitle }}">
      <input
        type="checkbox"
        id="{{ $fulltextToggleId }}"
        class="fulltext-toggle-checkbox"
      >
      <span class="fulltext-toggle-slider"></span>
      <span class="fulltext-toggle-text">Full text</span>
    </label>
    <label class="fulltext-toggle-label" title="Search by meaning">
      <input
        type="checkbox"
        id="{{ $semanticToggleId }}"
        class="fulltext-toggle-checkbox"
      >
      <span class="fulltext-toggle-slider"></span>
      <span class="fulltext-toggle-text">Semantic</span>
    </label>
  </div>
</div>
