@extends('layout')

{{-- User page (/u/{username}): the homepage's lava-lamp hero scoped to one
     user's library, owner-customizable via page_settings. Same design
     invariants as home.blade.php (guarded by tests/Feature/UserPageSeoTest.php):
       - On the plain /u/{name} URL NO .arranger-button has the `active` class
         and there are NO <main> elements — that defers homepageDisplayUnit's
         initial auto-load; a feed loads on tab press or client-side tab
         restore (history.state.userPageActiveTab / localStorage). A shelf
         deep link (/u/{name}/shelf/{slug}) DOES render its tab active.
       - #app-container carries .lava-lamp-background; #lava-lamp-mount is the
         sibling AFTER it (dim rule: `#app-container.content-active ~ #lava-lamp-mount`).
       - The crawlable SEO body is the .welcome-copy user-about section.
     Customization (logo/background image, css vars, about) is stored in
     library.page_settings — validated by UserPageSettingsValidator; the
     <style> block below only ever prints validator-emitted values. --}}

@section('styles')
    @vite(['resources/css/app.css', 'resources/css/pages/user.css'])
    @if(!empty($backgroundImage))
    {{-- ABSOLUTE url: a relative url() inside a custom property resolves
         against the stylesheet CONSUMING the var (userPageHero.css — the
         vite dev origin in dev), not the document. Background image is the
         ONLY styling var — color/font theming is a reader preference. --}}
    <style id="user-page-settings-css">
      body[data-page="user"] #app-container {
        --up-bg-image: url('{{ url('/' . $book . '/media/' . $backgroundImage) }}');
      }
    </style>
    @endif
@endsection

@section('content')



<!--
  ======================================================================
  1. THE NEW APP CONTAINER
  This is the main flexbox layout for the entire page.
  ======================================================================
-->
{{-- bg-art-{name}: the owner's background-art pick (validator registry);
     'none' hides the lava mount via CSS. Absent = default hills. --}}
<div id="app-container" class="lava-lamp-background{{ !empty($backgroundArt) && $backgroundArt !== 'hills' ? ' bg-art-' . $backgroundArt : '' }}">

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
        <button type="button" class="open menu-row-btn" id="userButton" aria-label="Account">
          <svg
            id="userLogo"
            xmlns="http://www.w3.org/2000/svg"
            xmlns:xlink="http://www.w3.org/1999/xlink"
            version="1.1"
            viewBox="198 40 604 582">
            <g transform="matrix(1,0,0,-1,197.42373,1300.6102)">
              <path d="M473.1,779.8c-15.2-14.5-35.4-21.7-60.6-21.7H139.4 c-25.2,0-45.4,7.2-60.6,21.7s-19.5,56.4-17.3,68.6s4.9,23.5,8.3,33.9c3.3,10.4,7.8,20.6,13.4,30.5s12.1,18.3,19.4,25.3 c7.3,7,16.2,12.6,26.7,16.7s22.1,6.2,34.8,6.2c1.9,0,6.2-2.2,13.1-6.7s14.6-9.5,23.3-15s19.9-10.5,33.8-15 c13.9-4.5,27.8-6.7,41.7-6.7s27.9,2.2,41.7,6.7s25.1,9.5,33.8,15s16.4,10.5,23.3,15s11.2,6.7,13.1,6.7c12.7,0,24.3-2.1,34.8-6.2 c10.5-4.2,19.4-9.7,26.7-16.7c7.3-7,13.8-15.4,19.4-25.3s10.1-20.1,13.4-30.5c3.3-10.4,6.1-21.7,8.3-33.9 S488.3,794.3,473.1,779.8z M395.9,1061.1c0-33.1-11.7-61.4-35.2-84.8s-51.7-35.2-84.8-35.2s-61.4,11.7-84.8,35.2 s-35.2,51.7-35.2,84.8s11.7,61.4,35.2,84.8s51.7,35.2,84.8,35.2s61.4-11.7,84.8-35.2S395.9,1094.2,395.9,1061.1z"/>
            </g>
          </svg>
          <span class="logo-nav-label">Account</span>
        </button>
      </div>

      <!-- Home Button -->
      <a href="{{ url('/') }}" id="homeButtonNav" class="menu-row-btn" aria-label="Go to home">
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" data-supported-dps="24x24" fill="currentColor" class="mercado-match" width="24" height="24" focusable="false">
          <path d="M23 9v2h-2v7a3 3 0 01-3 3h-4v-6h-4v6H6a3 3 0 01-3-3v-7H1V9l11-7z"/>
        </svg>
        <span class="logo-nav-label">Home</span>
      </a>

      <!-- Open Book Button -->
      <button type="button" id="openBookButton" class="menu-row-btn" aria-label="Open a book">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M12 7v14"/>
          <path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z"/>
        </svg>
        <span class="logo-nav-label">Open</span>
      </button>
    </div>
  </div>

  {{-- Right Column: The New Book Button. Directly after the top-left cluster
       so Tab order = visual reading order, top-left → top-right (WCAG 2.4.3);
       position:fixed makes DOM placement visually free. --}}
  <div id="topRightContainer" class="loading">
    <button type="button" id="newBookButton" class="open"><span class="icon">+</span></button>
  </div>


  <!--
    ==================================================================
    2. THE CENTER COLUMN - hero card (lockup + search + pill tabs),
    no preloaded content. Carries BOTH wrapper classes: the hero/lava
    machinery keys on .home-content-wrapper, the user-page machinery
    (shelfTabs, profile editor, display unit) on .user-content-wrapper.
    ==================================================================
  -->
  <div class="home-content-wrapper user-content-wrapper">
    <div class="fixed-header">
      {{-- User logo lockup: journal-lockup geometry (the colon squares sized
           by --colon-h, title beside) with the colon swappable for the
           owner's own image. #userLibraryContainer + #userLibraryTitle are
           the userProfileEditor's contract — keep the ids. --}}
      <div id="userLibraryContainer"@if($isOwner && $libraryRecord) data-library-record='@json($libraryRecord)'@endif>
        <div id="imageContainer" class="top-content journal-logo-lockup user-logo-lockup">
          <a href="/" aria-label="Hyperlit home" class="journal-colon-link">
            @if(!empty($logoImage))
            <img class="journal-colon user-page-logo" src="/{{ $book }}/media/{{ $logoImage }}" alt="">
            @else
            <svg class="journal-colon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 28.33 85" aria-hidden="true">
              <defs>
                <linearGradient id="New_Gradient_Swatch_copy" data-name="New Gradient Swatch copy" x1="14.17" y1="28.33" x2="14.17" y2="0" gradientTransform="translate(28.33 28.33) rotate(-180)" gradientUnits="userSpaceOnUse">
                  <stop offset="0" stop-color="#ff8700"/>
                  <stop offset="1" stop-color="#00afaf"/>
                </linearGradient>
                <linearGradient id="New_Gradient_Swatch_copy_4" data-name="New Gradient Swatch copy 4" x1="-169.77" y1="-.18" x2="-169.77" y2="82.14" gradientTransform="translate(183.94)" gradientUnits="userSpaceOnUse">
                  <stop offset="0" stop-color="#ee4b96"/>
                  <stop offset=".33" stop-color="#00afaf"/>
                  <stop offset=".66" stop-color="#ff8700"/>
                  <stop offset="1" stop-color="#ee4b96"/>
                </linearGradient>
              </defs>
              <rect width="28.33" height="28.33" transform="translate(28.33 28.33) rotate(180)" fill="url(#New_Gradient_Swatch_copy)"/>
              <rect y="56.67" width="28.33" height="28.33" fill="url(#New_Gradient_Swatch_copy_4)"/>
            </svg>
            @endif
          </a>
          <h1 id="userLibraryTitle" class="journal-title" contenteditable="false">{{ $libraryTitle }}</h1>
        </div>
        {{-- No bio here: the hero card stays lockup-only. #userBio lives in
             the scroll-up about section below (same editable element). --}}
      </div>
      <div class="arranger-buttons-container">
        {{-- User-scoped search (userSearch component keys off these ids;
             deliberately NOT homepageSearch's ids — that component is global) --}}
        @include('partials.search-box', [
          'containerId'      => 'user-search-container',
          'inputId'          => 'user-search-input',
          'resultsId'        => 'user-search-results',
          'fulltextToggleId' => 'user-fulltext-toggle',
          'semanticToggleId' => 'user-semantic-toggle',
          'placeholder'      => 'Search titles & authors...',
          'fulltextTitle'    => 'Search within book content',
          'contextUsername'  => $username,
          'archivist'        => true,
        ])
        {{-- NO `active` class on the plain URL (defers the initial load — the
             hero shows instead); the client restores the last-open tab itself.
             A shelf deep link is the exception: its tab renders active.
             The scroller keeps ONE horizontally-scrollable pill row however
             many shelf tabs are open; shelfTabs inserts dynamic tabs before
             #shelf-picker-trigger, i.e. inside the scroller. The brain button
             and × live OUTSIDE it so they never scroll away. --}}
        <div class="user-pill-scroller">
          @if($isOwner)
          {{-- No Account pill: financials live in the userButton flyout's
               Money overlay (components/moneyOverlay) on every page. --}}
          <button class="arranger-button" data-content="{{ $allBook }}" data-filter="library">Library</button>
          @else
          <button class="arranger-button" data-content="{{ $book }}" data-filter="library">Library</button>
          @endif
          @foreach($visitorShelves as $pShelf)
          <button class="arranger-button visitor-shelf-tab{{ ($activeShelfId ?? '') === $pShelf->id ? ' active' : '' }}" data-content="" data-filter="shelf" data-shelf-id="{{ $pShelf->id }}" data-shelf-slug="{{ $pShelf->slug }}" data-sort="{{ $pShelf->default_sort ?? 'recent' }}" data-shelf-name="{{ $pShelf->name }}">{{ $pShelf->name }}</button>
          @endforeach
          @if($isOwner)
          <button type="button" id="shelf-picker-trigger" class="shelf-picker-trigger" title="Shelves">+</button>
          @endif
        </div>
        @include('partials.archivist-brain-button')
        {{-- visible only while a feed is open; homepageHero closes back to the hero --}}
        <button type="button" id="copy-feed-close" aria-label="Close feed" title="Close feed">&times;</button>
      </div>
    </div>

    {{-- About: a REAL book ({sanitized}About) — nodes server-rendered here
         for SEO/first paint in the editor's DOM contract (.chunk[data-chunk-id]
         > block[id=startLine][data-node-id]); the client re-renders via
         createChunkElement (highlights/hypercites applied) and the pencil's
         edit mode attaches the full editToolbar/divEditor stack inline.
         Container id ≠ any feed id (transitionToBookContent mints div#{bookId}
         elements; global getElementById lookups must not cross books).
         Legacy fallback: pages whose About book was never minted still show
         the old about_html blob / default copy. --}}
    <span id="main-start" tabindex="-1"></span>
    <section class="welcome-copy user-about" aria-label="About this library">
      @if(!empty($aboutNodes))
      <div id="user-about-book" class="sub-book-content" data-book-id="{{ $aboutBookId }}" contenteditable="false">
        <div class="chunk" data-chunk-id="0">
          @foreach($aboutNodes as $n)
            {!! preg_replace('/^<(\w+)/', '<$1 id="' . e($n->startLine) . '" data-node-id="' . e($n->node_id) . '"', $n->content) !!}
          @endforeach
        </div>
      </div>
      @else
      <div id="user-about-content">
        @if(!empty($aboutHtml))
          {!! $aboutHtml !!}
        @elseif($isOwner)
          <h1 class="mega">This is your library's front page.</h1>
          <h2>Press the pencil (bottom right) to swap the logo, restyle the page, and write your own about section.</h2>
        @else
          <h1 class="mega">{{ $libraryTitle }}</h1>
        @endif
      </div>
      @endif
      {{-- Hypercite network (opt-in via the pencil panel's "Connection map"):
           the journal pages' server-rendered SVG, corpus = this user's public
           books. Same wrapper class/expand id — the journalHyperciteMap
           component (registered for user pages too) is generic over them. --}}
      @if($hyperciteMap ?? null)
        <div class="journal-hypercite-map">
          {!! $hyperciteMap !!}
          <ul class="journal-map-legend" aria-label="Hypercite network legend">
            <li><span class="jml-dot jml-lit"></span>hypercited book <em>(bigger = more connections)</em></li>
            <li><span class="jml-dot jml-plain"></span>book</li>
            <li><span class="jml-line"></span>books hypercited together</li>
            <li><span class="jml-dot jml-ext"></span>hypercited book beyond this library</li>
          </ul>
          <div class="journal-map-actions">
            <button type="button" id="journal-map-expand" tabindex="-1" aria-label="Expand the hypercite network">&#10530; Expand diagram</button>
          </div>
        </div>
      @endif
    </section>
    {{-- No <main> containers: homepageDisplayUnit creates a fresh
         .main-content inside the wrapper when a tab is pressed/restored. --}}
  </div>
  <!-- ================================================================ -->

  {{-- scroll affordance for the hero state --}}
  <div class="copy-scroll-hint" aria-hidden="true">&darr;</div>

</div> <!-- End of #app-container -->

{{-- Lava-lamp background mount (must be AFTER #app-container: the dimming rule
     uses the sibling selector #app-container.content-active ~ #lava-lamp-mount) --}}
<div id="lava-lamp-mount" aria-hidden="true"></div>

@if($isOwner)
{{-- Page-edit toggle (owner only): SAME structure as reader.blade.php's edit
     button — #bottom-right-buttons is a perimeter button (positioned, shown/
     hidden and un-`loading`ed by togglePerimeterButtons), #editButton gets the
     reader's pencil styling. The reader's book-edit component is registered
     pages:['reader'] so none of its logic attaches here; userPageEditor
     (pages:['user']) owns this button instead. --}}
<div id="bottom-right-buttons" class="loading">
  <button type="button" id="editButton" aria-label="Customize this page" title="Customize this page">
    <svg viewBox="0 0 24 24" width="100%" height="100%" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4 12.5-12.5z" />
    </svg>
  </button>
</div>
@endif

<!-- Bottom left settings button -->
<div id="bottom-left-buttons" class="loading">
  <button type="button" id="settingsButton" aria-label="Settings">
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

  @include('partials.brain-hyperlight-button')
</div>

<div id="toc-container" class="hidden">
  <div class="mask-top" style="position: absolute !important; top: 0 !important; left: 0 !important; right: 0 !important; height: 1em !important; pointer-events: none !important; z-index: 10 !important; opacity: 1 !important; visibility: visible !important; display: block !important; transition: none !important; animation: none !important;"></div>
  <div class="mask-bottom" style="position: absolute !important; bottom: 0 !important; left: 0 !important; right: 0 !important; height: 1em !important; pointer-events: none !important; z-index: 10 !important; opacity: 1 !important; visibility: visible !important; display: block !important; transition: none !important; animation: none !important;"></div>
</div>
<div id="highlight-container" class="hidden" contenteditable="true"></div>
<div id="hypercite-container" class="hidden"></div>

{{-- The hyperlit container: annotation panel for highlights/hypercites. On
     hero pages it serves the AI-answer book renders (and feed marks) — the
     container code REQUIRES this static element (hyperlitContainer/core.ts
     bails without it; it is never created by JS). Same structure as
     reader.blade.php's copy. --}}
<div id="hyperlit-container" class="container-panel hidden">
  <div class="scroller"></div>
  <div class="mask-top"></div>
  <div class="mask-bottom"></div>
  <div class="resize-edge resize-left" title="Resize width"></div>
</div>
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

@include('partials.newbook-container')

@include('partials.openbook-container')


<div id="toc-overlay"></div>
<div id="ref-overlay"></div>
<div id="user-overlay"></div>

<x-settings-panel />

{{-- The inline About-book editor's toolbar (+ #keyboard-gap-blocker,
     #citation-toolbar-results) — same partial the reader uses. --}}
@include('partials.edit-toolbar')

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
    window.allBook = "{{ $allBook ?? '' }}";
    window.username = "{{ $username }}";
    window.isOwner = {{ $isOwner ? 'true' : 'false' }};
    window.userShelves = @json($shelves ?? []);
    window.publicShelves = @json($publicShelves ?? []);
    window.activeShelfId = @json($activeShelfId ?? null);
    // Deep-link target (/u/{name}/shelf/{slug}) — consumed one-shot by
    // initializeShelfTabs to open PRIVATE owner shelves that have no
    // server-rendered tab (visitor public shelves use the active tab above).
    window.activeShelfDeepLink = @json($activeShelf ?? null);
    // Current page customization (owner only gets the editor; visitors just
    // see the server-rendered result). Seeds userPageEditor's panel state.
    window.userPageSettings = @json($pageSettings ?? (object) []);
</script>
@vite([
    'resources/js/pageLoad/readerEntry.ts'
])
@endsection
