@extends('layout')

@section('styles')

    @vite(['resources/css/app.css', 'resources/css/reader.css', 'resources/css/highlight-div.css', 'resources/css/containers.css', 'resources/css/buttons.css', 'resources/css/alert.css', 'resources/css/layout.css'])
    @endsection
@section('content')





<div id="app-container">

  <!-- Logo Navigation Wrapper -->
  <div id="logoNavWrapper">
    <button
      type="button"
      id="logoContainer"
      aria-label="Toggle navigation menu"
    >
      <img
        src="{{ asset('images/logoa.svg') }}"
        id="logo"
        alt="Logo"
      >
    </button>

    <!-- Hidden navigation menu (appears below logo when toggled) -->
    <div id="logoNavMenu" class="logo-nav-menu hidden">
      <!-- User Button -->
      <div id="userButtonContainer">
        <button type="button" class="open" id="userButton">
          <svg
            id="userLogo"
            xmlns="http://www.w3.org/2000/svg"
            xmlns:xlink="http://www.w3.org/1999/xlink"
            version="1.1"
            viewBox="198 40 604 582">
            <g transform="matrix(1,0,0,-1,197.42373,1300.6102)">
              <path d="M473.1,779.8c-15.2-14.5-35.4-21.7-60.6-21.7H139.4 c-25.2,0-45.4,7.2-60.6,21.7s-19.5,56.4-17.3,68.6s4.9,23.5,8.3,33.9c3.3,10.4,7.8,20.6,13.4,30.5s12.1,18.3,19.4,25.3 c7.3,7,16.2,12.6,26.7,16.7s22.1,6.2,34.8,6.2c1.9,0,6.2-2.2,13.1-6.7s14.6-9.5,23.3-15s19.9-10.5,33.8-15 c13.9-4.5,27.8-6.7,41.7-6.7s27.9,2.2,41.7,6.7s25.1,9.5,33.8,15s16.4,10.5,23.3,15s11.2,6.7,13.1,6.7c12.7,0,24.3-2.1,34.8-6.2 c10.5-4.2,19.4-9.7,26.7-16.7c7.3-7,13.8-15.4,19.4-25.3s10.1-20.1,13.4-30.5c3.3-10.4,6.1-21.7,8.3-33.9 S488.3,794.3,473.1,779.8z M395.9,1061.1c0-33.1-11.7-61.4-35.2-84.8s-51.7-35.2-84.8-35.2s-61.4,11.7-84.8,35.2 s-35.2,51.7-35.2,84.8s11.7,61.4,35.2,84.8s51.7,35.2,84.8,35.2s61.4-11.7,84.8-35.2S395.9,1094.2,395.9,1061.1z"/>
            </g>
            <path d="M667.2,293.2H621v-27.3h46.2v-48.3h28.3v48.3h46.2v27.3 h-46.2v48.3h-28.3V293.2z"/>
          </svg>
        </button>
      </div>

      <!-- Home Button -->
      <a href="{{ url('/') }}" id="homeButtonNav" aria-label="Go to home">
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor">
          <path d="M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z"/>
        </svg>
      </a>
    </div>
  </div>

      <div class="spacer"></div>
      <div class="reader-content-wrapper">
  <!-- Load the content of the main-text.md file -->
  <main id="{{ $book }}" class="main-content" contenteditable="{{ $editMode ? 'true' : 'false' }}">
      </main>
      <div id="keyboard-spacer"></div>
      </div>
      <div class="spacer"></div>

  <div id="topRightContainer" class="loading">
      <button type="button" id="cloudRef">
          <svg
            id="cloudRef-svg"
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 503.23 309.68"
            width="36"
            height="36"
            preserveAspectRatio="xMidYMid meet"
          >
          <rect width="503.23" height="309.68" />
          <path class="cls-1" d="M503.23,219.35c0-35.07-20.41-66.75-51.68-81.56C449.35,61.43,386.55,0,309.68,0c-54.39,0-103.11,30.53-127.01,78.67-4.94-.84-9.92-1.25-14.93-1.25-35.1,0-66.79,20.43-81.57,51.7C38.28,131.3,0,170.94,0,219.35s40.53,90.32,90.32,90.32h322.58c49.79,0,90.32-40.52,90.32-90.32ZM25.81,219.35c0-35.57,28.94-64.52,64.52-64.52.8,0,1.57.06,2.36.12l11.02.67,3.21-9.2c9.06-25.83,33.51-43.2,60.83-43.2,6.28,0,12.55.93,18.61,2.76l11.28,3.39,4.41-10.92c17.86-44.14,60.09-72.66,107.64-72.66,64.04,0,116.13,52.1,116.13,116.13l-.54,13.46,8.94,3.14c25.85,9.06,43.21,33.51,43.21,60.83,0,35.57-28.94,64.52-64.52,64.52H90.32c-35.57,0-64.52-28.94-64.52-64.52Z"/>
          <path class="cls-2" d="M247.54,243.04h-67.31v-51.84c0-19.08,3.97-34.15,11.92-45.19,7.94-11.04,21.56-20.79,40.85-29.25l14.55,27.54c-11.86,5.57-20.07,11.12-24.6,16.64-4.54,5.52-7.07,12.05-7.58,19.58h32.19v62.52ZM326,243.04h-67.31v-51.84c0-19.08,3.97-34.15,11.92-45.19,7.94-11.04,21.56-20.79,40.85-29.25l14.55,27.54c-11.86,5.57-20.07,11.12-24.6,16.64-4.54,5.52-7.07,12.05-7.58,19.58h32.19v62.52Z"/>
          </svg>
      </button>
  </div>

<!-- In reader.blade.php -->

<!-- Buttons for hyper-lighting -->
<div id="hyperlight-buttons" style="display: none; position: absolute; z-index: 9999;">

  <!-- Delete Button -->
  <button id="delete-hyperlight" type="button">
    <svg
      id="svgDeleter"
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path d="M3 6h18" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  </button>
  
  <!-- Hyperlight Button (Pink Square) -->
  <button id="copy-hyperlight" type="button">
    <svg
      id="svgHighlighter"
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
    >
      <!-- The color is now a class so CSS can control it -->
      <rect class="hyperlight-color" width="24" height="24" rx="4" ry="4" />
    </svg>
  </button>


  <!-- Hypercite Button -->
  <button id="copy-hypercite" type="button">
    <svg xmlns="http://www.w3.org/2000/svg" version="1.1" viewBox="0 0 36 36">
  <path class="st0" d="M17.71,24.31h-4.82v-3.71c0-1.36.28-2.44.85-3.23.57-.79,1.54-1.49,2.92-2.09l1.04,1.97c-.85.4-1.44.8-1.76,1.19-.32.39-.51.86-.54,1.40h2.3v4.47h0ZM23.32,24.31h-4.82v-3.71c0-1.36.28-2.44.85-3.23.57-.79,1.54-1.49,2.92-2.09l1.04,1.97c-.85.4-1.44.8-1.76,1.19-.32.39-.51.86-.54,1.40h2.3v4.47h0Z"/>
  <path class="st0" d="M30.34,2.51h-13.47c-2.97,0-5.39,2.42-5.39,5.39-2.97,0-5.39,2.42-5.39,5.39v13.47c0,2.97,2.42,5.39,5.39,5.39h13.47c2.97,0,5.39-2.42,5.39-5.39,2.97,0,5.39-2.42,5.39-5.39V7.9c0-2.97-2.42-5.39-5.39-5.39ZM27.65,26.76c0,1.49-1.21,2.69-2.69,2.69h-13.47c-1.49,0-2.69-1.21-2.69-2.69v-13.47c0-1.49,1.21-2.69,2.69-2.69h13.47c1.49,0,2.69,1.21,2.69,2.69v13.47ZM33.04,21.37c0,1.49-1.21,2.69-2.69,2.69v-10.78c0-2.97-2.42-5.39-5.39-5.39h-10.78c0-1.49,1.21-2.69,2.69-2.69h13.47c1.49,0,2.69,1.21,2.69,2.69v13.47Z"/>
    </svg>
  </button>
</div>

  <div id="bottom-left-buttons" class="loading"> <!-- bottom left buttons -->
      <button type="button" id="settingsButton">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 50 50">
          <path d="M47.16,21.221l-5.91-0.966c-0.346-1.186-0.819-2.326-1.411-3.405l3.45-4.917c0.279-0.397,0.231-0.938-0.112-1.282 l-3.889-3.887c-0.347-0.346-0.893-0.391-1.291-0.104l-4.843,3.481c-1.089-0.602-2.239-1.08-3.432-1.427l-1.031-5.886 C28.607,2.35,28.192,2,27.706,2h-5.5c-0.49,0-0.908,0.355-0.987,0.839l-0.956,5.854c-1.2,0.345-2.352,0.818-3.437,1.412l-4.83-3.45 c-0.399-0.285-0.942-0.239-1.289,0.106L6.82,10.648c-0.343,0.343-0.391,0.883-0.112,1.28l3.399,4.863 c-0.605,1.095-1.087,2.254-1.438,3.46l-5.831,0.971c-0.482,0.08-0.836,0.498-0.836,0.986v5.5c0,0.485,0.348,0.9,0.825,0.985 l5.831,1.034c0.349,1.203,0.831,2.362,1.438,3.46l-3.441,4.813c-0.284,0.397-0.239,0.942,0.106,1.289l3.888,3.891 c0.343,0.343,0.884,0.391,1.281,0.112l4.87-3.411c1.093,0.601,2.248,1.078,3.445,1.424l0.976,5.861C21.3,47.647,21.717,48,22.206,48 h5.5c0.485,0,0.9-0.348,0.984-0.825l1.045-5.89c1.199-0.353,2.348-0.833,3.43-1.435l4.905,3.441 c0.398,0.281,0.938,0.232,1.282-0.111l3.888-3.891c0.346-0.347,0.391-0.894,0.104-1.292l-3.498-4.857 c0.593-1.08,1.064-2.222,1.407-3.408l5.918-1.039c0.479-0.084,0.827-0.5,0.827-0.985v-5.5C47.999,21.718,47.644,21.3,47.16,21.221z M25,32c-3.866,0-7-3.134-7-7c0-3.866,3.134-7,7-7s7,3.134,7,7C32,28.866,28.866,32,25,32z"></path>
          </svg>
      </button>
  </div>

  <div id="bottom-right-buttons" class="loading"> <!-- bottom right buttons -->
      <button type="button" id="editButton">
          <svg viewBox="0 0 24 24" width="100%" height="100%" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 20h9" />
          <path d="M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4 12.5-12.5z" />
          </svg>
          </button>
      
      <button type="button" id="toc-toggle-button">
          <svg width="36px" height="36px" viewBox="0 0 24.75 24.75" version="1.1" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">
          <rect width="24.75" height="24.75" />
          <g>
          <path d="M0,3.875c0-1.104,0.896-2,2-2h20.75c1.104,0,2,0.896,2,2s-0.896,2-2,2H2 C0.896,5.875,0,4.979,0,3.875z" />
          <path d="M22.75,10.375H2c-1.104,0-2,0.896-2,2c0,1.104,0.896,2,2,2h20.75c1.104,0,2-0.896,2-2 C24.75,11.271,23.855,10.375,22.75,10.375z" />
          <path d="M22.75,18.875H2c-1.104,0-2,0.896-2,2s0.896,2,2,2h20.75c1.104,0,2-0.896,2-2 S23.855,18.875,22.75,18.875z" />
          </g>
          </svg>
      </button>
  </div>
  <!-- Add the new edit-toolbar div -->
  <div id="edit-toolbar">
    <button type="button" id="boldButton">
      <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
        <rect width="24" height="24" />
        <path d="M6 4h8a4 4 0 0 1 4 4 4 4 0 0 1-4 4H6z" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
        <path d="M6 12h9a4 4 0 0 1 4 4 4 4 0 0 1-4 4H6z" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
    </button>

    <button type="button" id="italicButton">
      <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
        <rect width="24" height="24" />
        <line x1="19" y1="4" x2="10" y2="4" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
        <line x1="14" y1="20" x2="5" y2="20" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
        <line x1="15" y1="4" x2="9" y2="20" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
    </button>

    <button type="button" id="headingButton">
      <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
        <rect width="24" height="24" />
        <path d="M6 12h12" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
        <path d="M6 4v16" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
        <path d="M18 4v16" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
    </button>

    <!-- Heading Level Submenu -->
    <div id="heading-submenu" class="heading-submenu hidden">
      <button type="button" class="heading-remove-btn" data-action="remove-heading" title="Remove heading">✕</button>
      <button type="button" class="heading-level-btn" data-heading="h1">H1</button>
      <button type="button" class="heading-level-btn" data-heading="h2">H2</button>
      <button type="button" class="heading-level-btn" data-heading="h3">H3</button>
      <button type="button" class="heading-level-btn" data-heading="h4">H4</button>
    </div>

    <button type="button" id="blockquoteButton">
    <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
      <rect width="24" height="24" />
      <line x1="4" y1="4" x2="4" y2="20" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
      <line x1="8" y1="6" x2="20" y2="6" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
      <line x1="8" y1="12" x2="20" y2="12" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
      <line x1="8" y1="18" x2="20" y2="18" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  </button>

    <button type="button" id="codeButton">
      <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
        <rect width="24" height="24" />
        <polyline points="16 18 22 12 16 6" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
        <polyline points="8 6 2 12 8 18" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
    </button>

    <button id="undoButton">
    <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
      <rect width="24" height="24" />
      <path d="M30.3,12.6c10.4,0,18.9,8.4,18.9,18.9s-8.5,18.9-18.9,18.9h-8.2c-0.8,0-1.3-0.6-1.3-1.4v-3.2 c0-0.8,0.6-1.5,1.4-1.5h8.1c7.1,0,12.8-5.7,12.8-12.8s-5.7-12.8-12.8-12.8H16.4c0,0-0.8,0-1.1,0.1c-0.8,0.4-0.6,1,0.1,1.7l4.9,4.9 c0.6,0.6,0.5,1.5-0.1,2.1L18,29.7c-0.6,0.6-1.3,0.6-1.9,0.1l-13-13c-0.5-0.5-0.5-1.3,0-1.8L16,2.1c0.6-0.6,1.6-0.6,2.1,0l2.1,2.1 c0.6,0.6,0.6,1.6,0,2.1l-4.9,4.9c-0.6,0.6-0.6,1.3,0.4,1.3c0.3,0,0.7,0,0.7,0L30.3,12.6z" transform="scale(0.35) translate(8.2, 8.2)" />
    </svg>
  </button>
  <button id="redoButton">
    <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
      <rect width="24" height="24" />
      <path d="M30.3,12.6c10.4,0,18.9,8.4,18.9,18.9s-8.5,18.9-18.9,18.9h-8.2c-0.8,0-1.3-0.6-1.3-1.4v-3.2 c0-0.8,0.6-1.5,1.4-1.5h8.1c7.1,0,12.8-5.7,12.8-12.8s-5.7-12.8-12.8-12.8H16.4c0,0-0.8,0-1.1,0.1c-0.8,0.4-0.6,1,0.1,1.7l4.9,4.9 c0.6,0.6,0.5,1.5-0.1,2.1L18,29.7c-0.6,0.6-1.3,0.6-1.9,0.1l-13-13c-0.5-0.5-0.5-1.3,0-1.8L16,2.1c0.6-0.6,1.6-0.6,2.1,0l2.1,2.1 c0.6,0.6,0.6,1.6,0,2.1l-4.9,4.9c-0.6,0.6-0.6,1.3,0.4,1.3c0.3,0,0.7,0,0.7,0L30.3,12.6z" transform="scale(-0.35, 0.35) translate(-60.2, 8.2)" />
    </svg>
  </button>

  </div>

  <!-- Search toolbar - iOS Safari style find bar -->
  <div id="search-toolbar">
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


  <!-- toggle hidden containers -->
  <div id="toc-container" class="hidden">
    <div class="scroller"></div>
    <div class="mask-top" style="position: absolute !important; top: 0 !important; left: 0 !important; right: 0 !important; height: 1em !important; pointer-events: none !important; z-index: 9999 !important; opacity: 1 !important; visibility: visible !important; display: block !important; transition: none !important; animation: none !important; transform: none !important; will-change: auto !important;"></div>
    <div class="mask-bottom" style="position: absolute !important; bottom: 0 !important; left: 0 !important; right: 0 !important; height: 20px !important; pointer-events: none !important; z-index: 10 !important; opacity: 1 !important; visibility: visible !important; display: block !important; transition: none !important; animation: none !important; transform: none !important; will-change: auto !important;"></div>
    <div class="container-controls">
      <div class="resize-handle resize-right" title="Resize width (drag left/right)"></div>
    </div>
  </div>
  <div id="hyperlit-container" class="container-panel hidden">
    <div class="scroller"></div>
    <div class="mask-top"></div>
    <div class="mask-bottom"></div>
    <div class="container-controls">
      <div class="resize-handle resize-left" title="Resize width"></div>
      <div class="drag-handle" title="Drag to move container"></div>
      <div class="resize-handle resize-right" title="Resize width"></div>
    </div>
  </div>
 
  <div id="source-container" class="hidden"></div>

          
  <div id="toc-overlay"></div>
  <div id="ref-overlay"></div>
  

  <div id="user-overlay"></div>
  <div id="user-container" class="hidden" style="visibility: hidden;"></div>

  <!-- Settings container - slides up from bottom -->
  <div id="bottom-up-container" class="hidden">
    <!-- Dark Mode Button (active by default) -->
    <button type="button" id="darkModeButton" class="settings-button active">
      Dark Mode
    </button>

    <!-- Light Mode Button -->
    <button type="button" id="lightModeButton" class="settings-button">
      Light Mode
    </button>

    <!-- Sepia Mode Button -->
    <button type="button" id="sepiaModeButton" class="settings-button">
      Sepia Mode
    </button>

    <!-- Search Button -->
    <button type="button" id="searchButton" class="settings-button">
      <svg viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg">
        <path d="M221.09,64A157.09,157.09,0,1,0,378.18,221.09,157.1,157.1,0,0,0,221.09,64Z" />
        <line x1="338.29" y1="338.29" x2="448" y2="448" />
      </svg>
    </button>
  </div>
  <div id="settings-overlay"></div>

</div><!-- Close app-container -->

@endsection


@section('scripts')

<script src="{{ asset('js/crypto-js.min.js') }}"></script>
<script src="{{ asset('js/rangy-core.min.js') }}"></script>
<script src="{{ asset('js/rangy-classapplier.min.js') }}"></script>
<script src="{{ asset('js/rangy-highlighter.min.js') }}"></script>

<script>
    window.editMode = @json($editMode);
  </script>

  {{-- Now load your reader‑specific JS via Vite --}}
  @vite(['resources/js/containerCustomization.js', 'resources/js/utilities/drag.js', 'resources/js/readerDOMContentLoaded.js'])
@endsection
    

