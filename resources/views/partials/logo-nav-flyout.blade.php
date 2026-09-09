{{-- The top-left logo flyout (reader chrome parity): hyperlit logo button
     opening a menu with Account / Home / Open / New. Shared by user.blade,
     journal-home.blade and archive-home.blade; reader.blade keeps its inline
     copy (it interleaves reader-specific comments) — if you change a row here,
     mirror it there. #newBookButton MUST stay in the DOM on hero pages: the
     hero copy's import links click it programmatically and fileDropTarget's
     import path depends on the newbook container it opens. --}}
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
          width="20" height="20"
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

    <!-- New Book Button -->
    <button type="button" id="newBookButton" class="open menu-row-btn" aria-label="New book">
      <svg class="icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M12 5v14M5 12h14"/>
      </svg>
      <span class="logo-nav-label">New</span>
    </button>
  </div>
</div>
