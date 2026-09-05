{{-- The "Open" flyout: IndexedDB recents over a library search field (the
     search/searchBox.ts factory in library mode). Search sits at the BOTTOM so
     titles get the room; its results open UPWARD (CSS order) into the space
     the Recent list vacates while typing. Deliberately NO fulltext/semantic
     toggle elements — the factory null-guards them, locking this instance to
     library mode. Shared by reader/user (the logo-nav "Open" row opens it).
     Manager: resources/js/components/openbookContainer/index.ts.
     Styling: resources/css/components/openbookContainer.css --}}
<div id="openbook-container" class="hidden">
  <div id="openbook-recent">
    <div class="openbook-recent-heading">Recent</div>
    <div id="openbook-recent-list" class="openbook-recent-list"></div>
  </div>
  <div id="openbook-search-container" class="openbook-search">
    <div class="search-input-anchor">
      <div class="openbook-search-row">
        <svg class="openbook-search-icon" viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg" fill="none" stroke="currentColor" stroke-width="32" stroke-linecap="round" stroke-miterlimit="10" aria-hidden="true">
          <path d="M221.09,64A157.09,157.09,0,1,0,378.18,221.09,157.1,157.1,0,0,0,221.09,64Z"></path>
          <line x1="338.29" y1="338.29" x2="448" y2="448"></line>
        </svg>
        <textarea
          id="openbook-search-input"
          class="search-input"
          placeholder="Search titles & authors..."
          autocomplete="off" spellcheck="false" rows="1" maxlength="2000"
        ></textarea>
      </div>
      <div id="openbook-search-results" class="search-results hidden"></div>
    </div>
  </div>
</div>
