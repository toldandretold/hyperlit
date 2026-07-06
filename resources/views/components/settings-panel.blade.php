<!-- Settings container - slides up from bottom -->
<div id="settings-container" class="hidden">
  <!-- Inner wrapper: constrained to the reading column width (var(--content-width))
       so the rows stack as .main-content narrows. -->
  <div class="settings-inner">
    <!-- Theme buttons row -->
    <div class="settings-row settings-theme-row">
      <button type="button" id="darkModeButton" class="settings-button active">Dark</button>
      <button type="button" id="lightModeButton" class="settings-button">Light</button>
      <button type="button" id="sepiaModeButton" class="settings-button">Sepia</button>
      <button type="button" id="vibeCSSButton" class="settings-button">Vibe</button>
    </div>

    <!-- Action buttons row (neutral grey): search, gate, audio — identical icon+label pills -->
    <div class="settings-row settings-action-row">
      <button type="button" id="searchButton" class="settings-button settings-action-btn" aria-label="Search in text">
        <svg viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg">
          <path d="M221.09,64A157.09,157.09,0,1,0,378.18,221.09,157.1,157.1,0,0,0,221.09,64Z" />
          <line x1="338.29" y1="338.29" x2="448" y2="448" />
        </svg>
        <span class="settings-btn-label">search</span>
      </button>
      <button type="button" id="gateFilterButton" class="settings-button settings-action-btn">
        <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
          <path d="M5 5 L19 5 L14 12 L14 18 L10 20 L10 12 Z" />
        </svg>
        <span class="settings-btn-label">hyperlit gate</span>
      </button>
      {{-- Hidden by default: only the reader-page audioPlayer component reveals
           it (not for sub-books; encrypted books get it too — pressing explains
           why server-side narration is impossible for them) --}}
      <button type="button" id="audioListenButton" class="settings-button settings-action-btn" aria-label="Listen to this book" hidden>
        <svg viewBox="-0.5 0 25 25" xmlns="http://www.w3.org/2000/svg">
          <path d="M13 22.42C15.2091 22.42 17 20.6292 17 18.42C17 16.2109 15.2091 14.42 13 14.42C10.7909 14.42 9 16.2109 9 18.42C9 20.6292 10.7909 22.42 13 22.42Z" />
          <path d="M17 18.4099V9.5C16.9991 8.0814 17.5008 6.70828 18.4161 5.62451C19.3315 4.54074 20.6012 3.81639 22 3.57996" />
          <path d="M2 7.42004H12" />
          <path d="M2 11.42H12" />
          <path d="M2 3.42004H12" />
        </svg>
        <span class="settings-btn-label">listen</span>
      </button>
    </div>

    <!-- Text-size + column-width steppers. Each pair stays glued together; the two
         pairs share one row and only reflow onto separate lines when very narrow. -->
    <div class="settings-row settings-adjust-row">
      <div class="settings-adjust-group" role="group" aria-label="Text size">
        <button type="button" id="textSizeDecrease" class="settings-button settings-adjust-btn settings-size-btn" aria-label="Smaller text"><span class="settings-size-glyph settings-size-sm">A</span></button>
        <button type="button" id="textSizeIncrease" class="settings-button settings-adjust-btn settings-size-btn" aria-label="Larger text"><span class="settings-size-glyph settings-size-lg">A</span></button>
      </div>
      <div class="settings-adjust-group" role="group" aria-label="Column width">
        <button type="button" id="widthNarrow" class="settings-button settings-adjust-btn settings-width-btn" aria-label="Narrower column">&gt;narrow&lt;</button>
        <button type="button" id="widthWiden" class="settings-button settings-adjust-btn settings-width-btn" aria-label="Wider column">&lt;widen&gt;</button>
      </div>
    </div>
  </div>
</div>
<div id="settings-overlay"></div>
