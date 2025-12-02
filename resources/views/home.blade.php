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

  <!-- Left Column: The User Button -->
  <div id="userButtonContainer" class="loading">
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

 

  <!-- 
    ==================================================================
    2. THE CENTER COLUMN
    This is your original content-wrapper, now acting as the central,
    scrollable column in our new layout.
    I've renamed the class to "home-content-wrapper" to match the CSS.
    ==================================================================
  -->
  <div class="home-content-wrapper">
    <div class="fixed-header">
      <div id="imageContainer" class="top-content">
        <svg id="top" data-name="Layer 1" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 432.49 110.22">
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
          <polygon points="112.41 35.83 67.35 35.83 67.35 .21 56.32 .21 56.32 85.01 67.35 85.01 67.35 45.15 112.41 45.15 112.41 85.01 123.44 85.01 123.44 .21 112.41 .21 112.41 35.83" fill="var(--logo-text-color, #f1f2f2)"/>
          <path d="M162.38,63.93c-.32.81-.55,1.39-.67,1.76-.12.36-.35.95-.67,1.76-.25.81-.44,1.41-.6,1.82-.17.4-.36,1.01-.61,1.82-.89-2.42-1.81-4.8-2.79-7.15l-14.54-37.32h-11.51l23.38,56.34-10.66,27.26h11.03l31.38-83.6h-10.91l-12.84,37.32Z" fill="var(--logo-text-color, #f1f2f2)"/>
          <path d="M236.4,28.68c-4.07-2.66-8.86-4-14.36-4-4.12,0-7.92.97-11.39,2.91-3.48,1.94-6.1,4.28-7.88,7.03v-8h-10.42v83.6h10.42v-33.32c1.94,3.07,4.56,5.49,7.88,7.27,3.31,1.78,7.03,2.67,11.15,2.67,5.33,0,10.05-1.31,14.17-3.94,4.12-2.62,7.31-6.28,9.57-10.97,2.26-4.68,3.4-10.1,3.4-16.23s-1.07-11.31-3.21-15.99c-2.14-4.68-5.25-8.36-9.33-11.02ZM235.86,67.69c-1.45,3.47-3.53,6.18-6.24,8.12-2.71,1.94-5.84,2.91-9.39,2.91s-6.69-.97-9.39-2.91c-2.71-1.94-4.83-4.64-6.36-8.12-1.54-3.47-2.3-7.47-2.3-11.99s.76-8.62,2.3-12.06c1.53-3.43,3.67-6.08,6.42-7.94,2.75-1.86,5.86-2.79,9.33-2.79s6.69.97,9.39,2.91c2.71,1.94,4.79,4.62,6.24,8.06,1.45,3.43,2.18,7.37,2.18,11.81s-.72,8.52-2.18,11.99Z" fill="var(--logo-text-color, #f1f2f2)"/>
          <path d="M297.86,28.49c-4.04-2.54-8.92-3.82-14.66-3.82-5.25,0-10,1.33-14.24,4-4.24,2.67-7.56,6.34-9.93,11.02-2.39,4.69-3.58,9.98-3.58,15.87,0,6.63,1.15,12.28,3.45,16.96,2.3,4.68,5.57,8.24,9.81,10.66,4.24,2.42,9.27,3.64,15.09,3.64,5.25,0,9.75-.91,13.51-2.73,3.76-1.82,6.65-4.22,8.66-7.21,2.02-2.99,3.23-6.3,3.64-9.93h-10.3c-.65,4.2-2.38,7.21-5.21,9.02-2.83,1.82-6.22,2.73-10.18,2.73-3.39,0-6.44-.83-9.15-2.48-2.71-1.65-4.84-4.06-6.42-7.21-1.57-3.15-2.4-6.9-2.48-11.27h44.34v-2.06c0-6.3-1.05-11.77-3.15-16.42-2.1-4.64-5.17-8.24-9.21-10.78ZM266.24,50.36c.4-5.01,2.14-9.17,5.21-12.48,3.07-3.31,6.98-4.97,11.75-4.97,5,0,8.9,1.58,11.69,4.72,2.79,3.15,4.18,7.39,4.18,12.72h-32.83Z" fill="var(--logo-text-color, #f1f2f2)"/>
          <path d="M337.52,27.89c-3.19,2.14-5.56,4.95-7.09,8.42v-9.69h-10.42v58.4h10.42v-30.89c0-4.28.68-7.85,2.06-10.72,1.37-2.87,3.37-5.01,6-6.42,2.62-1.41,5.84-2.12,9.63-2.12,1.05,0,2.14.08,3.27.24v-10.3c-.65-.08-1.54-.12-2.67-.12-4.28,0-8.02,1.07-11.2,3.21Z" fill="var(--logo-text-color, #f1f2f2)"/>
          <polygon points="357.73 .21 357.73 8.81 357.73 76.41 357.73 85.01 368.16 85.01 368.16 76.41 368.16 .21 362.95 .21 357.73 .21" fill="var(--logo-text-color, #f1f2f2)"/>
          <rect x="380.16" y="3.11" width="12.12" height="12.48" fill="var(--logo-text-color, #f1f2f2)"/>
          <polygon points="381.13 26.62 381.13 35.22 381.13 76.41 381.13 85.01 391.55 85.01 391.55 76.41 391.55 26.62 386.34 26.62 381.13 26.62" fill="var(--logo-text-color, #f1f2f2)"/>
          <path d="M428.12,76.65c-2.75,0-4.87-.68-6.36-2.06s-2.24-3.68-2.24-6.91v-32.47h12.12v-8.6h-12.12V7.35h-10.42v19.26h-10.91v8.6h10.91v33.56c0,6.06,1.55,10.44,4.66,13.15,3.11,2.71,7.09,4.06,11.93,4.06,1.21,0,2.38-.06,3.52-.18,1.13-.12,2.22-.3,3.27-.54v-8.96c-1.7.24-3.15.36-4.37.36Z" fill="var(--logo-text-color, #f1f2f2)"/>
          <rect width="28.33" height="28.33" transform="translate(28.33 28.33) rotate(180)" fill="url(#New_Gradient_Swatch_copy)"/>
          <rect y="56.67" width="28.33" height="28.33" fill="url(#New_Gradient_Swatch_copy_4)"/>
        </svg>
      </div>
      <div class="arranger-buttons-container">
        <!-- Homepage: sorting options -->
        <button class="arranger-button active" data-content="most-recent">Most Recent</button>
        <button class="arranger-button" data-content="most-connected">Most Connected</button>
        <button class="arranger-button" data-content="most-lit">Most Lit</button>
      </div>
    </div>
    <!-- Homepage content containers -->
    <main id="most-recent" class="main-content active-content"></main>
    <main id="most-connected" class="main-content hidden-content"></main>
    <main id="most-lit" class="main-content hidden-content"></main>
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

  <!-- Delete Button -->
  <button id="delete-hyperlight" type="button">
    <svg id="svgDeleter" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
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
    <svg id="Layer_1" xmlns="http://www.w3.org/2000/svg" version="1.1" viewBox="0 0 36 36">
  <path class="st0" d="M17.71,24.31h-4.82v-3.71c0-1.36.28-2.44.85-3.23.57-.79,1.54-1.49,2.92-2.09l1.04,1.97c-.85.4-1.44.8-1.76,1.19-.32.39-.51.86-.54,1.4h2.3v4.47h0ZM23.32,24.31h-4.82v-3.71c0-1.36.28-2.44.85-3.23.57-.79,1.54-1.49,2.92-2.09l1.04,1.97c-.85.4-1.44.8-1.76,1.19-.32.39-.51.86-.54,1.4h2.3v4.47h0Z"/>
  <path class="st0" d="M30.34,2.51h-13.47c-2.97,0-5.39,2.42-5.39,5.39-2.97,0-5.39,2.42-5.39,5.39v13.47c0,2.97,2.42,5.39,5.39,5.39h13.47c2.97,0,5.39-2.42,5.39-5.39,2.97,0,5.39-2.42,5.39-5.39V7.9c0-2.97-2.42-5.39-5.39-5.39ZM27.65,26.76c0,1.49-1.21,2.69-2.69,2.69h-13.47c-1.49,0-2.69-1.21-2.69-2.69v-13.47c0-1.49,1.21-2.69,2.69-2.69h13.47c1.49,0,2.69,1.21,2.69,2.69v13.47ZM33.04,21.37c0,1.49-1.21,2.69-2.69,2.69v-10.78c0-2.97-2.42-5.39-5.39-5.39h-10.78c0-1.49,1.21-2.69,2.69-2.69h13.47c1.49,0,2.69,1.21,2.69,2.69v13.47Z"/>
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
@vite([
    'resources/js/readerDOMContentLoaded.js'
])
@endsection