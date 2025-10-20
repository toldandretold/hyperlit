@extends('layout')

@section('styles')

    @vite(['resources/css/app.css', 'resources/css/reader.css', 'resources/css/highlight-div.css', 'resources/css/containers.css', 'resources/css/buttons.css', 'resources/css/alert.css', 'resources/css/layout.css'])
    @endsection
@section('content')





<div id="app-container">


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
      
      <div class="spacer"></div>
      <div class="reader-content-wrapper">
  <!-- Load the content of the main-text.md file -->
  <div id="{{ $book }}" class="main-content" contenteditable="{{ $editMode ? 'true' : 'false' }}"> 
      </div>
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
          <defs>
          <style>
          .cls-1, .cls-2 {
            fill: #CBCCCC; /* Both shapes start as grey */
            transition: fill 0.3s ease;
          }
              </style>
              </defs>
          <rect 
          width="503.23" 
          height="309.68" 
          fill="#221F20" 
          /> <!-- Dark background -->
              <path class="cls-1" d="M503.23,219.35c0-35.07-20.41-66.75-51.68-81.56C449.35,61.43,386.55,0,309.68,0c-54.39,0-103.11,30.53-127.01,78.67-4.94-.84-9.92-1.25-14.93-1.25-35.1,0-66.79,20.43-81.57,51.7C38.28,131.3,0,170.94,0,219.35s40.53,90.32,90.32,90.32h322.58c49.79,0,90.32-40.52,90.32-90.32ZM25.81,219.35c0-35.57,28.94-64.52,64.52-64.52.8,0,1.57.06,2.36.12l11.02.67,3.21-9.2c9.06-25.83,33.51-43.2,60.83-43.2,6.28,0,12.55.93,18.61,2.76l11.28,3.39,4.41-10.92c17.86-44.14,60.09-72.66,107.64-72.66,64.04,0,116.13,52.1,116.13,116.13l-.54,13.46,8.94,3.14c25.85,9.06,43.21,33.51,43.21,60.83,0,35.57-28.94,64.52-64.52,64.52H90.32c-35.57,0-64.52-28.94-64.52-64.52Z"/>
              <path class="cls-2" d="M247.54,243.04h-67.31v-51.84c0-19.08,3.97-34.15,11.92-45.19,7.94-11.04,21.56-20.79,40.85-29.25l14.55,27.54c-11.86,5.57-20.07,11.12-24.6,16.64-4.54,5.52-7.07,12.05-7.58,19.58h32.19v62.52ZM326,243.04h-67.31v-51.84c0-19.08,3.97-34.15,11.92-45.19,7.94-11.04,21.56-20.79,40.85-29.25l14.55,27.54c-11.86,5.57-20.07,11.12-24.6,16.64-4.54,5.52-7.07,12.05-7.58,19.58h32.19v62.52Z"/>
          </svg>
      </button>
  </div>

<!-- In reader.blade.php -->

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

  <div id="bottom-right-buttons" class="loading"> <!-- bottom right buttons -->
      <button type="button" id="editButton">
          <svg
          viewBox="0 0 24 24"
          width="100%"
          height="100%"
          fill="none"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
              >
          <path d="M12 20h9" />
          <path d="M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4 12.5-12.5z" />
              </svg>
          </button>
      
      <button type="button" id="toc-toggle-button">
          <svg
          width="36px"
          height="36px"
          viewBox="0 0 24.75 24.75"
          version="1.1"
          xmlns="http://www.w3.org/2000/svg"
          xmlns:xlink="http://www.w3.org/1999/xlink"
              >
          <!-- Background rectangle -->
          <rect width="24.75" height="24.75" fill="#221F20" />
          <g fill="#CBCCCC">
          <path
          d="M0,3.875c0-1.104,0.896-2,2-2h20.75c1.104,0,2,0.896,2,2s-0.896,2-2,2H2
         C0.896,5.875,0,4.979,0,3.875z"
          />
          <path
          d="M22.75,10.375H2c-1.104,0-2,0.896-2,2c0,1.104,0.896,2,2,2h20.75c1.104,0,2-0.896,2-2
         C24.75,11.271,23.855,10.375,22.75,10.375z"
              />
          <path
          d="M22.75,18.875H2c-1.104,0-2,0.896-2,2s0.896,2,2,2h20.75c1.104,0,2-0.896,2-2
         S23.855,18.875,22.75,18.875z"
          />
          </g>
          </svg>
      </button>
  </div>
  <!-- Add the new edit-toolbar div -->
  <div id="edit-toolbar">
    <button type="button" id="boldButton">
      <svg
        viewBox="0 0 24 24"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
      >
        <!-- Background rectangle -->
        <rect width="24" height="24" fill="#221F20" />
        <!-- Bold icon -->
        <path
          d="M6 4h8a4 4 0 0 1 4 4 4 4 0 0 1-4 4H6z"
          stroke="#CBCCCC"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
        <path
          d="M6 12h9a4 4 0 0 1 4 4 4 4 0 0 1-4 4H6z"
          stroke="#CBCCCC"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </svg>
    </button>

    <button type="button" id="italicButton">
      <svg
        viewBox="0 0 24 24"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
      >
        <rect width="24" height="24" fill="#221F20" />
        <line
          x1="19"
          y1="4"
          x2="10"
          y2="4"
          stroke="#CBCCCC"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
        <line
          x1="14"
          y1="20"
          x2="5"
          y2="20"
          stroke="#CBCCCC"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
        <line
          x1="15"
          y1="4"
          x2="9"
          y2="20"
          stroke="#CBCCCC"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </svg>
    </button>

    <button type="button" id="headingButton">
      <svg
        viewBox="0 0 24 24"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
      >
        <rect width="24" height="24" fill="#221F20" />
        <path
          d="M6 12h12"
          stroke="#CBCCCC"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
        <path
          d="M6 4v16"
          stroke="#CBCCCC"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
        <path
          d="M18 4v16"
          stroke="#CBCCCC"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
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
    <svg
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <!-- Background rectangle -->
      <rect width="24" height="24" fill="#221F20" />
      <!-- Left margin bar -->
      <line
        x1="4"
        y1="4"
        x2="4"
        y2="20"
        stroke="#CBCCCC"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
      <!-- Text lines -->
      <line
        x1="8"
        y1="6"
        x2="20"
        y2="6"
        stroke="#CBCCCC"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
      <line
        x1="8"
        y1="12"
        x2="20"
        y2="12"
        stroke="#CBCCCC"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
      <line
        x1="8"
        y1="18"
        x2="20"
        y2="18"
        stroke="#CBCCCC"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </svg>
  </button>

    <button type="button" id="codeButton">
      <svg
        viewBox="0 0 24 24"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
      >
        <rect width="24" height="24" fill="#221F20" />
        <polyline
          points="16 18 22 12 16 6"
          stroke="#CBCCCC"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
        <polyline
          points="8 6 2 12 8 18"
          stroke="#CBCCCC"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </svg>
    </button>

    <button id="undoButton">
    <svg
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <rect width="24" height="24" fill="#221F20" />
      <path
        d="M30.3,12.6c10.4,0,18.9,8.4,18.9,18.9s-8.5,18.9-18.9,18.9h-8.2c-0.8,0-1.3-0.6-1.3-1.4v-3.2
        c0-0.8,0.6-1.5,1.4-1.5h8.1c7.1,0,12.8-5.7,12.8-12.8s-5.7-12.8-12.8-12.8H16.4c0,0-0.8,0-1.1,0.1c-0.8,0.4-0.6,1,0.1,1.7l4.9,4.9
        c0.6,0.6,0.5,1.5-0.1,2.1L18,29.7c-0.6,0.6-1.3,0.6-1.9,0.1l-13-13c-0.5-0.5-0.5-1.3,0-1.8L16,2.1c0.6-0.6,1.6-0.6,2.1,0l2.1,2.1
        c0.6,0.6,0.6,1.6,0,2.1l-4.9,4.9c-0.6,0.6-0.6,1.3,0.4,1.3c0.3,0,0.7,0,0.7,0L30.3,12.6z"
        fill="#CBCCCC"
        transform="scale(0.35) translate(8.2, 8.2)"
      /> 
    </svg>
  </button>
  <button id="redoButton">
    <svg
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <rect width="24" height="24" fill="#221F20" />
      <path
        d="M30.3,12.6c10.4,0,18.9,8.4,18.9,18.9s-8.5,18.9-18.9,18.9h-8.2c-0.8,0-1.3-0.6-1.3-1.4v-3.2
        c0-0.8,0.6-1.5,1.4-1.5h8.1c7.1,0,12.8-5.7,12.8-12.8s-5.7-12.8-12.8-12.8H16.4c0,0-0.8,0-1.1,0.1c-0.8,0.4-0.6,1,0.1,1.7l4.9,4.9
        c0.6,0.6,0.5,1.5-0.1,2.1L18,29.7c-0.6,0.6-1.3,0.6-1.9,0.1l-13-13c-0.5-0.5-0.5-1.3,0-1.8L16,2.1c0.6-0.6,1.6-0.6,2.1,0l2.1,2.1
        c0.6,0.6,0.6,1.6,0,2.1l-4.9,4.9c-0.6,0.6-0.6,1.3,0.4,1.3c0.3,0,0.7,0,0.7,0L30.3,12.6z"
        fill="#CBCCCC"
        transform="scale(-0.35, 0.35) translate(-60.2, 8.2)"
      />
    </svg>
  </button>

  </div>



  <!-- toggle hidden containers -->
  <div id="toc-container" class="hidden">
    <div class="scroller"></div>
    <div class="mask-top" style="position: absolute !important; top: 0 !important; left: 0 !important; right: 0 !important; height: 1em !important; pointer-events: none !important; background-color: #221F20 !important; z-index: 9999 !important; box-shadow: inset 0px -4px 4px -4px #221F20 !important; opacity: 1 !important; visibility: visible !important; display: block !important; transition: none !important; animation: none !important; transform: none !important; will-change: auto !important;"></div>
    <div class="mask-bottom" style="position: absolute !important; bottom: 0 !important; left: 0 !important; right: 0 !important; height: 1em !important; pointer-events: none !important; background-color: #221F20 !important; z-index: 9999 !important; opacity: 1 !important; visibility: visible !important; display: block !important; transition: none !important; animation: none !important; transform: none !important; will-change: auto !important;"></div>
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
  @vite(['resources/js/drag.js', 'resources/js/readerDOMContentLoaded.js'])
@endsection
    

