<!-- Settings container - slides up from bottom -->
<div id="bottom-up-container" class="hidden">
  <!-- Theme buttons row -->
  <div class="settings-row settings-theme-row">
    <button type="button" id="darkModeButton" class="settings-button active">Dark</button>
    <button type="button" id="lightModeButton" class="settings-button">Light</button>
    <button type="button" id="sepiaModeButton" class="settings-button">Sepia</button>
    <button type="button" id="vibeCSSButton" class="settings-button">Vibe</button>
    <span class="settings-theme-break"></span>
    <button type="button" id="searchButton" class="settings-button">
      <svg viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg">
        <path d="M221.09,64A157.09,157.09,0,1,0,378.18,221.09,157.1,157.1,0,0,0,221.09,64Z" />
        <line x1="338.29" y1="338.29" x2="448" y2="448" />
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
