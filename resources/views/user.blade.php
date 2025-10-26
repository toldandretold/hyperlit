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

  <!-- Left Column: Home Button (link to homepage) -->
  
       <!-- buttons: clockwise from top-left -->
  <a
    id="logoContainer"
    href="{{ url('/') }}"
  >
    <img
      src="{{ asset('images/logoa.svg') }}"
      id="logo"
      alt="Logo"
    >
  </a>


  <!--
    ==================================================================
    2. THE CENTER COLUMN - User Content Wrapper
    ==================================================================
  -->
  <div class="user-content-wrapper">
    <div class="fixed-header">
      <div class="arranger-buttons-container">
        <!-- User page: public/private toggle - both load same book -->
        <button class="arranger-button active" data-content="{{ $book }}" data-filter="public">Public</button>
        <button class="arranger-button" data-content="{{ $book }}" data-filter="private">Private</button>
      </div>
    </div>
    <!-- User page content container - single book, filtered by public/private -->
    <div id="{{ $book }}" class="main-content active-content"></div>
  </div>
  <!-- ================================================================ -->

  <!-- Spacer to keep the content centered -->


  <!-- Right Column: The New Book Button -->
  <div id="topRightContainer" class="loading">
    <button type="button" id="newBook" class="open"><span class="icon">+</span></button>
  </div>

</div> <!-- End of #app-container -->


<!--
  ======================================================================
  3. FLOATING & OVERLAY ELEMENTS
  All of these remain outside the #app-container, as direct children
  of the <body>, so they can float freely over the whole page.
  ======================================================================
-->

<!-- Buttons for hyper-lighting -->
<div id="hyperlight-buttons" style="display: none; position: absolute; z-index: 9999;">

  <!-- Delete Button (NOW A PROPER SVG ICON) -->
  <button id="delete-hyperlight" type="button">
    <svg
      id="svgDeleter"
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="M3 6h18"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
      <path
        d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
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


  <!-- Hypercite Button (fill attribute removed from path) -->
  <button id="copy-hypercite" type="button">
    <svg
    id="Layer_1"
    xmlns="http://www.w3.org/2000/svg"
    version="1.1"
    viewBox="0 0 36 36">
  <defs>
    <style>
      .st0 {
        fill: #cbcccc;
      }
    </style>
  </defs>
  <path
    class="st0"
    d="M17.71,24.31h-4.82v-3.71c0-1.36.28-2.44.85-3.23.57-.79,1.54-1.49,2.92-2.09l1.04,1.97c-.85.4-1.44.8-1.76,1.19-.32.39-.51.86-.54,1.4h2.3v4.47h0ZM23.32,24.31h-4.82v-3.71c0-1.36.28-2.44.85-3.23.57-.79,1.54-1.49,2.92-2.09l1.04,1.97c-.85.4-1.44.8-1.76,1.19-.32.39-.51.86-.54,1.4h2.3v4.47h0Z"/>
  <path
    class="st0"
    d="M30.34,2.51h-13.47c-2.97,0-5.39,2.42-5.39,5.39-2.97,0-5.39,2.42-5.39,5.39v13.47c0,2.97,2.42,5.39,5.39,5.39h13.47c2.97,0,5.39-2.42,5.39-5.39,2.97,0,5.39-2.42,5.39-5.39V7.9c0-2.97-2.42-5.39-5.39-5.39ZM27.65,26.76c0,1.49-1.21,2.69-2.69,2.69h-13.47c-1.49,0-2.69-1.21-2.69-2.69v-13.47c0-1.49,1.21-2.69,2.69-2.69h13.47c1.49,0,2.69,1.21,2.69,2.69v13.47ZM33.04,21.37c0,1.49-1.21,2.69-2.69,2.69v-10.78c0-2.97-2.42-5.39-5.39-5.39h-10.78c0-1.49,1.21-2.69,2.69-2.69h13.47c1.49,0,2.69,1.21,2.69,2.69v13.47Z"/>
    </svg>
  </button>
</div>

<div id="toc-container" class="hidden">
  <div class="mask-top" style="position: absolute !important; top: 0 !important; left: 0 !important; right: 0 !important; height: 1em !important; pointer-events: none !important; background-color: #221F20 !important; z-index: 10 !important; box-shadow: inset 0px -4px 4px -4px #221F20 !important; opacity: 1 !important; visibility: visible !important; display: block !important; transition: none !important; animation: none !important;"></div>
  <div class="mask-bottom" style="position: absolute !important; bottom: 0 !important; left: 0 !important; right: 0 !important; height: 1em !important; pointer-events: none !important; background-color: #221F20 !important; z-index: 10 !important; opacity: 1 !important; visibility: visible !important; display: block !important; transition: none !important; animation: none !important;"></div>
</div>
<div id="highlight-container" class="hidden" contenteditable="true"></div>
<div id="hypercite-container" class="hidden"></div>
<div id="source-container" class="hidden"></div>
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

<div id="newbook-container" class="hidden" class="loading">
  <button id="createNewBook" type="button">new</button>
  <button id="importBook" type="button">import</button>
</div>


<div id="toc-overlay"></div>
<div id="ref-overlay"></div>
<div id="user-overlay"></div>


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
