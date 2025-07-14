@extends('layout')

@section('styles')

    @vite(['resources/css/app.css', 'resources/css/reader.css', 'resources/css/highlight-div.css', 'resources/css/containers.css', 'resources/css/buttons.css', 'resources/css/alert.css', 'resources/css/layout.css'])
    @endsection
@section('content')

<body 
data-page="reader"
data-edit-mode="{{ $editMode ? '1' : '0' }}"
>


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
      </div>
      <div class="spacer"></div>

  <div id="topRightContainer" class="loading">
      <button type="button" id="cloudRef">
          <svg
            id="Layer_1"
            data-name="Layer 1"
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

</div> <!-- app-container -->

  <!-- Buttons for hyper-lighting -->
  <div id="hyperlight-buttons" style="display: none; position: absolute; z-index: 9999;">
    <button id="copy-hyperlight" type="button">
      <svg 
      id="svgHighlighter" 
      xmlns="http://www.w3.org/2000/svg" 
      width="16" 
      height="16"
      >
      <rect 
      width="16" 
      height="16" 
      fill="#EE4A95" 
      rx="4" 
      ry="4" />
          </svg>
      </button>

    <button id="delete-hyperlight" type="button">🗑️</button>
    
    <button id="copy-hypercite" type="button">
      <svg
      id="svgHyperciter"
      viewBox="0 0 15 16"
      width="16"
      height="16"
       xmlns="http://www.w3.org/2000/svg"
      >
      <!-- Background rectangle -->
      <rect width="15" height="16" fill="#221F20" />
      <!-- Quotation mark symbol -->
      <path
      fill="#CBCCCC"
      d="M6.5 3.5H1.5V8.5H3.75L1.75 12.5H4.75L6.5 9V3.5zM13.5 3.5H8.5V8.5H10.75L8.75 12.5H11.75L13.5 9V3.5z"
          />
          </svg>
      </button>
  </div>

  




  <div id="nav-buttons" class="loading"> <!-- bottom right buttons -->
      <button type="button" id="editButton">
          <svg 
          viewBox="0 0 24 24" 
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
  </div>



  <!-- toggle hidden containers -->
  <div id="toc-container" class="hidden"></div>
  <div id="highlight-container" class="hidden"></div>
  <div id="hypercite-container" class="hidden"></div>
  <div id="ref-container" class="hidden"></div>
  <div id="source-container" class="hidden"></div>

          
  <div id="toc-overlay"></div>
  <div id="ref-overlay"></div>
  <div id="user-overlay"></div>



</body>

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
  @vite('resources/js/reader-DOMContentLoaded.js')
@endsection
    

