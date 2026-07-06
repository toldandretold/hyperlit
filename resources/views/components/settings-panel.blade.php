<!-- Settings container - slides up from bottom -->
<div id="settings-container" class="hidden">
  <!-- Theme buttons row -->
  <div class="settings-row settings-theme-row">
    <button type="button" id="darkModeButton" class="settings-button active">Dark</button>
    <button type="button" id="lightModeButton" class="settings-button">Light</button>
    <button type="button" id="sepiaModeButton" class="settings-button">Sepia</button>
    <button type="button" id="vibeCSSButton" class="settings-button">Vibe</button>
    <button type="button" id="gateFilterButton" class="settings-button">Gate</button>
    <span class="settings-theme-break"></span>
    <button type="button" id="searchButton" class="settings-button" aria-label="Search in text">
      <svg viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg">
        <path d="M221.09,64A157.09,157.09,0,1,0,378.18,221.09,157.1,157.1,0,0,0,221.09,64Z" />
        <line x1="338.29" y1="338.29" x2="448" y2="448" />
      </svg>
    </button>
    {{-- Hidden by default: only the reader-page audioPlayer component reveals
         it (and only for narratable books — not encrypted, not sub-books) --}}
    <button type="button" id="audioListenButton" class="settings-button" aria-label="Listen to this book" hidden>
      <svg viewBox="-0.5 0 25 25" xmlns="http://www.w3.org/2000/svg">
        <path d="M13 22.42C15.2091 22.42 17 20.6292 17 18.42C17 16.2109 15.2091 14.42 13 14.42C10.7909 14.42 9 16.2109 9 18.42C9 20.6292 10.7909 22.42 13 22.42Z" />
        <path d="M17 18.4099V9.5C16.9991 8.0814 17.5008 6.70828 18.4161 5.62451C19.3315 4.54074 20.6012 3.81639 22 3.57996" />
        <path d="M2 7.42004H12" />
        <path d="M2 11.42H12" />
        <path d="M2 3.42004H12" />
      </svg>
    </button>
    <button type="button" id="fullWidthToggle" class="settings-button settings-fullwidth-btn">&gt;margins&lt;</button>
  </div>

  <!-- Text Size slider -->
  <div class="settings-row settings-slider-row">
    <label class="settings-slider-label" for="textSizeSlider"><span class="slider-icon">Aa</span></label>
    <input type="range" id="textSizeSlider" class="settings-slider" min="4" max="60" value="28" step="1">
    <span class="settings-slider-value" id="textSizeValue">28px</span>
  </div>

  <!-- Content Width slider -->
  <div class="settings-row settings-slider-row settings-width-row">
    <label class="settings-slider-label" for="contentWidthSlider"><span class="slider-icon">&harr;</span></label>
    <input type="range" id="contentWidthSlider" class="settings-slider" min="25" max="80" value="40" step="1">
    <span class="settings-slider-value" id="contentWidthValue">40ch</span>
  </div>


</div>
<div id="settings-overlay"></div>
