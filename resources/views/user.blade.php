@extends('layout')

@section('styles')
    @vite(['resources/css/app.css', 'resources/css/reader.css', 'resources/css/highlight-div.css', 'resources/css/containers.css', 'resources/css/buttons.css', 'resources/css/form.css', 'resources/css/alert.css', 'resources/css/layout.css'])
@endsection

@section('content')



<!--
  ======================================================================
  1. THE NEW APP CONTAINER
  This is the main flexbox layout for the entire page.
  ======================================================================
-->
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

 

  <!--
    ==================================================================
    2. THE CENTER COLUMN - User Content Wrapper
    ==================================================================
  -->
  <div class="user-content-wrapper">
    <div class="fixed-header">
      <div id="userLibraryContainer" class="top-content">
        <h1 id="userLibraryTitle" contenteditable="false">{{ $libraryTitle }}</h1>
        <div id="userBio" contenteditable="false">{{ $libraryBio }}</div>
      </div>
      @if($isOwner)
      <div class="arranger-buttons-container">
        <!-- User page: public/private toggle - load different books based on visibility -->
        <!-- Only visible to page owner -->
        <button class="arranger-button active" data-content="{{ $book }}" data-filter="public">Public</button>
        <button class="arranger-button" data-content="{{ $book }}Private" data-filter="private">Private</button>
      </div>
      @endif
    </div>
    <!-- User page content container - single book, filtered by public/private -->
    <main id="{{ $book }}" class="main-content active-content"></main>
  </div>
  <!-- ================================================================ -->

  <!-- Spacer to keep the content centered -->


  <!-- Right Column: The New Book Button -->
  <div id="topRightContainer" class="loading">
    <button type="button" id="newBook" class="open"><span class="icon">+</span></button>
  </div>

</div> <!-- End of #app-container -->

<!-- Bottom left settings button -->
<div id="bottom-left-buttons" class="loading">
  <button type="button" id="settingsButton">
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 50 50">
      <path d="M47.16,21.221l-5.91-0.966c-0.346-1.186-0.819-2.326-1.411-3.405l3.45-4.917c0.279-0.397,0.231-0.938-0.112-1.282 l-3.889-3.887c-0.347-0.346-0.893-0.391-1.291-0.104l-4.843,3.481c-1.089-0.602-2.239-1.08-3.432-1.427l-1.031-5.886 C28.607,2.35,28.192,2,27.706,2h-5.5c-0.49,0-0.908,0.355-0.987,0.839l-0.956,5.854c-1.2,0.345-2.352,0.818-3.437,1.412l-4.83-3.45 c-0.399-0.285-0.942-0.239-1.289,0.106L6.82,10.648c-0.343,0.343-0.391,0.883-0.112,1.28l3.399,4.863 c-0.605,1.095-1.087,2.254-1.438,3.46l-5.831,0.971c-0.482,0.08-0.836,0.498-0.836,0.986v5.5c0,0.485,0.348,0.9,0.825,0.985 l5.831,1.034c0.349,1.203,0.831,2.362,1.438,3.46l-3.441,4.813c-0.284,0.397-0.239,0.942,0.106,1.289l3.888,3.891 c0.343,0.343,0.884,0.391,1.281,0.112l4.87-3.411c1.093,0.601,2.248,1.078,3.445,1.424l0.976,5.861C21.3,47.647,21.717,48,22.206,48 h5.5c0.485,0,0.9-0.348,0.984-0.825l1.045-5.89c1.199-0.353,2.348-0.833,3.43-1.435l4.905,3.441 c0.398,0.281,0.938,0.232,1.282-0.111l3.888-3.891c0.346-0.347,0.391-0.894,0.104-1.292l-3.498-4.857 c0.593-1.08,1.064-2.222,1.407-3.408l5.918-1.039c0.479-0.084,0.827-0.5,0.827-0.985v-5.5C47.999,21.718,47.644,21.3,47.16,21.221z M25,32c-3.866,0-7-3.134-7-7c0-3.866,3.134-7,7-7s7,3.134,7,7C32,28.866,28.866,32,25,32z"></path>
    </svg>
  </button>
</div>

<!--
  ======================================================================
  3. FLOATING & OVERLAY ELEMENTS
  All of these remain outside the #app-container, as direct children
  of the <body>, so they can float freely over the whole page.
  ======================================================================
-->

<!-- Buttons for hyper-lighting -->
<div id="hyperlight-buttons" style="display: none; position: absolute; z-index: 9999;">

  <!-- Delete Button -->
  <button id="delete-hyperlight" type="button">
    <svg id="svgDeleter" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
      <path d="M3 6h18" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  </button>

  <!-- Hyperlight Button (Pink Square) -->
  <button id="copy-hyperlight" type="button">
    <svg id="svgHighlighter" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
      <rect class="hyperlight-color" width="24" height="24" rx="4" ry="4" />
    </svg>
  </button>


  <!-- Hypercite Button -->
  <button id="copy-hypercite" type="button">
    <svg id="Layer_1" xmlns="http://www.w3.org/2000/svg" version="1.1" viewBox="0 0 36 36">
  <path class="st0" d="M17.71,24.31h-4.82v-3.71c0-1.36.28-2.44.85-3.23.57-.79,1.54-1.49,2.92-2.09l1.04,1.97c-.85.4-1.44.8-1.76,1.19-.32.39-.51.86-.54,1.4h2.3v4.47h0ZM23.32,24.31h-4.82v-3.71c0-1.36.28-2.44.85-3.23.57-.79,1.54-1.49,2.92-2.09l1.04,1.97c-.85.4-1.44.8-1.76,1.19-.32.39-.51.86-.54,1.4h2.3v4.47h0Z"/>
  <path class="st0" d="M30.34,2.51h-13.47c-2.97,0-5.39,2.42-5.39,5.39-2.97,0-5.39,2.42-5.39,5.39v13.47c0,2.97,2.42,5.39,5.39,5.39h13.47c2.97,0,5.39-2.42,5.39-5.39,2.97,0,5.39-2.42,5.39-5.39V7.9c0-2.97-2.42-5.39-5.39-5.39ZM27.65,26.76c0,1.49-1.21,2.69-2.69,2.69h-13.47c-1.49,0-2.69-1.21-2.69-2.69v-13.47c0-1.49,1.21-2.69,2.69-2.69h13.47c1.49,0,2.69,1.21,2.69,2.69v13.47ZM33.04,21.37c0,1.49-1.21,2.69-2.69,2.69v-10.78c0-2.97-2.42-5.39-5.39-5.39h-10.78c0-1.49,1.21-2.69,2.69-2.69h13.47c1.49,0,2.69,1.21,2.69,2.69v13.47Z"/>
    </svg>
  </button>
</div>

<div id="toc-container" class="hidden">
  <div class="mask-top" style="position: absolute !important; top: 0 !important; left: 0 !important; right: 0 !important; height: 1em !important; pointer-events: none !important; z-index: 10 !important; opacity: 1 !important; visibility: visible !important; display: block !important; transition: none !important; animation: none !important;"></div>
  <div class="mask-bottom" style="position: absolute !important; bottom: 0 !important; left: 0 !important; right: 0 !important; height: 1em !important; pointer-events: none !important; z-index: 10 !important; opacity: 1 !important; visibility: visible !important; display: block !important; transition: none !important; animation: none !important;"></div>
</div>
<div id="highlight-container" class="hidden" contenteditable="true"></div>
<div id="hypercite-container" class="hidden"></div>
<div id="source-container" class="hidden"></div>
<div id="source-overlay"></div>
<div id="ref-container" class="hidden"></div>

<div id="user-container" class="hidden">
  <div class="scroller">
    <div id="user-content">
      <h2>User Login</h2>
    </div>
  </div>
  <div class="mask-bottom"></div>
  <div class="mask-top"></div>
</div>

<div id="newbook-container" class="hidden loading">
  <button id="createNewBook" type="button" class="fucked-buttons" style="width: 100%; padding: 10px; background: #4a4a4a; color: #CBCCCC; border: none; border-radius: 4px; cursor: pointer; margin-bottom: 10px; box-sizing: border-box; transition: background-color 0.3s, color 0.3s; font-family: inherit;">New</button>
  <button id="importBook" type="button" class="fucked-buttons" style="width: 100%; padding: 10px; background: #4a4a4a; color: #CBCCCC; border: none; border-radius: 4px; cursor: pointer; box-sizing: border-box; transition: background-color 0.3s, color 0.3s; font-family: inherit;">Import</button>
</div>


<div id="toc-overlay"></div>
<div id="ref-overlay"></div>
<div id="user-overlay"></div>

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
    Search
  </button>
</div>
<div id="settings-overlay"></div>

@endsection

@section('scripts')
<script src="{{ asset('js/crypto-js.min.js') }}"></script>
<script src="{{ asset('js/rangy-core.min.js') }}"></script>
<script src="{{ asset('js/rangy-classapplier.min.js') }}"></script>
<script src="{{ asset('js/rangy-highlighter.min.js') }}"></script>
<script>
    // Pass user page data to JavaScript
    window.isUserPage = true;
    window.userPageBook = "{{ $book }}";
    window.username = "{{ $username }}";
</script>
@vite([
    'resources/js/readerDOMContentLoaded.js'
])
@endsection
