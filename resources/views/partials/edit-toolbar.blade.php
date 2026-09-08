{{-- The block editor toolbar + its two required siblings
     (#keyboard-gap-blocker, #citation-toolbar-results). Extracted from
     reader.blade.php so the USER page can host the same inline editor for
     its About book (components/userProfile — the editToolbar/divEditor stack
     is container-agnostic; it binds whatever carries data-book-id). Include
     once per page, AFTER the app container. --}}
  <!-- Add the new edit-toolbar div -->
  <div id="edit-toolbar">
    <button type="button" id="boldButton" aria-label="Bold">
      <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
        <rect width="24" height="24" />
        <path d="M6 4h8a4 4 0 0 1 4 4 4 4 0 0 1-4 4H6z" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
        <path d="M6 12h9a4 4 0 0 1 4 4 4 4 0 0 1-4 4H6z" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
    </button>

    <button type="button" id="italicButton" aria-label="Italic">
      <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
        <rect width="24" height="24" />
        <line x1="19" y1="4" x2="10" y2="4" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
        <line x1="14" y1="20" x2="5" y2="20" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
        <line x1="15" y1="4" x2="9" y2="20" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
    </button>

    <button type="button" id="headingButton" aria-label="Heading">
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

    <!-- Block-type picker: the icon reflects the caret's CURRENT block type
         (data-block-type set by ButtonStateManager; P is the default). -->
    <button type="button" id="blockquoteButton" aria-label="Block format" data-block-type="p">
      <svg class="block-icon block-icon-p" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
        <rect width="24" height="24" />
        <text x="5.5" y="20" font-size="21" font-weight="500" font-family="system-ui, -apple-system, sans-serif">P</text>
      </svg>
      <svg class="block-icon block-icon-ul" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
        <rect width="24" height="24" />
        <line x1="9" y1="6" x2="20" y2="6" stroke-width="2" stroke-linecap="round"/>
        <line x1="9" y1="12" x2="20" y2="12" stroke-width="2" stroke-linecap="round"/>
        <line x1="9" y1="18" x2="20" y2="18" stroke-width="2" stroke-linecap="round"/>
        <circle cx="4.5" cy="6" r="1.5"/>
        <circle cx="4.5" cy="12" r="1.5"/>
        <circle cx="4.5" cy="18" r="1.5"/>
      </svg>
      <svg class="block-icon block-icon-ol" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
        <rect width="24" height="24" />
        <text x="2" y="8" font-size="7" font-weight="600" font-family="system-ui, sans-serif">1</text>
        <line x1="9" y1="6" x2="20" y2="6" stroke-width="2" stroke-linecap="round"/>
        <text x="2" y="14" font-size="7" font-weight="600" font-family="system-ui, sans-serif">2</text>
        <line x1="9" y1="12" x2="20" y2="12" stroke-width="2" stroke-linecap="round"/>
        <text x="2" y="20" font-size="7" font-weight="600" font-family="system-ui, sans-serif">3</text>
        <line x1="9" y1="18" x2="20" y2="18" stroke-width="2" stroke-linecap="round"/>
      </svg>
      <svg class="block-icon block-icon-blockquote" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
        <rect width="24" height="24" />
        <line x1="4" y1="4" x2="4" y2="20" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
        <line x1="8" y1="6" x2="20" y2="6" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
        <line x1="8" y1="12" x2="20" y2="12" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
        <line x1="8" y1="18" x2="20" y2="18" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
      <svg class="block-icon block-icon-code" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
        <rect width="24" height="24" />
        <polyline points="16 18 22 12 16 6" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
        <polyline points="8 6 2 12 8 18" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
    </button>

    <div id="blockquote-submenu" class="blockquote-submenu hidden">
      <button type="button" class="block-type-btn" data-block-type="p" title="Paragraph">
        <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
          <text x="5.5" y="20" font-size="21" font-weight="500" font-family="system-ui, -apple-system, sans-serif">P</text>
        </svg>
      </button>
      <button type="button" class="block-type-btn" data-block-type="ul" title="Bullet list">
        <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
          <line x1="9" y1="6" x2="20" y2="6" stroke-width="2" stroke-linecap="round"/>
          <line x1="9" y1="12" x2="20" y2="12" stroke-width="2" stroke-linecap="round"/>
          <line x1="9" y1="18" x2="20" y2="18" stroke-width="2" stroke-linecap="round"/>
          <circle cx="4.5" cy="6" r="1.5"/>
          <circle cx="4.5" cy="12" r="1.5"/>
          <circle cx="4.5" cy="18" r="1.5"/>
        </svg>
      </button>
      <button type="button" class="block-type-btn" data-block-type="ol" title="Numbered list">
        <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
          <text x="2" y="8" font-size="7" font-weight="600" font-family="system-ui, sans-serif">1</text>
          <line x1="9" y1="6" x2="20" y2="6" stroke-width="2" stroke-linecap="round"/>
          <text x="2" y="14" font-size="7" font-weight="600" font-family="system-ui, sans-serif">2</text>
          <line x1="9" y1="12" x2="20" y2="12" stroke-width="2" stroke-linecap="round"/>
          <text x="2" y="20" font-size="7" font-weight="600" font-family="system-ui, sans-serif">3</text>
          <line x1="9" y1="18" x2="20" y2="18" stroke-width="2" stroke-linecap="round"/>
        </svg>
      </button>
      <button type="button" class="block-type-btn" data-block-type="blockquote" title="Blockquote">
        <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
          <line x1="4" y1="4" x2="4" y2="20" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
          <line x1="8" y1="6" x2="20" y2="6" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
          <line x1="8" y1="12" x2="20" y2="12" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
          <line x1="8" y1="18" x2="20" y2="18" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </button>
      <button type="button" class="block-type-btn" data-block-type="code" title="Code block">
        <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
          <polyline points="16 18 22 12 16 6" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none" />
          <polyline points="8 6 2 12 8 18" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none" />
        </svg>
      </button>
    </div>

    <button type="button" id="insertButton" aria-label="Insert">
      <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
        <rect width="24" height="24" />
        <line x1="12" y1="5" x2="12" y2="19" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
        <line x1="5" y1="12" x2="19" y2="12" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
    </button>

    <!-- Insert submenu: footnote / citation / image / link -->
    <div id="insert-submenu" class="insert-submenu hidden">
      <button type="button" id="footnoteButton" title="Insert footnote">
        <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
          <rect width="24" height="24" />
          <text x="5" y="19" font-size="18" font-weight="500" font-family="system-ui, -apple-system, sans-serif">a</text>
          <text x="16" y="11" font-size="11" font-weight="500" font-family="system-ui, -apple-system, sans-serif">1</text>
        </svg>
      </button>
      <button type="button" id="citationButton" title="Insert citation">
        <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
          <rect width="24" height="24" />
          <text x="2" y="19" font-size="16" font-weight="500" font-family="system-ui, -apple-system, sans-serif">(a)</text>
        </svg>
      </button>
      <button type="button" id="imageButton" aria-label="Insert image">
        <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
          <rect width="24" height="24" />
          <rect x="3" y="3" width="18" height="18" rx="2" ry="2" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
          <circle cx="8.5" cy="8.5" r="1.5" fill="none" stroke-width="2" />
          <polyline points="21 15 16 10 5 21" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </button>
      <button type="button" id="linkButton" title="Insert link">
        <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
          <rect width="24" height="24" />
          <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
          <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </button>
    </div>
    <input type="file" id="imageFileInput" accept="image/png,image/jpeg,image/gif,image/webp,image/svg+xml,.jpg,.jpeg,.png,.gif,.webp,.svg" multiple hidden />

    <button type="button" id="undoButton" aria-label="Undo">
      <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
        <rect width="24" height="24" />
        <path d="M30.3,12.6c10.4,0,18.9,8.4,18.9,18.9s-8.5,18.9-18.9,18.9h-8.2c-0.8,0-1.3-0.6-1.3-1.4v-3.2 c0-0.8,0.6-1.5,1.4-1.5h8.1c7.1,0,12.8-5.7,12.8-12.8s-5.7-12.8-12.8-12.8H16.4c0,0-0.8,0-1.1,0.1c-0.8,0.4-0.6,1,0.1,1.7l4.9,4.9 c0.6,0.6,0.5,1.5-0.1,2.1L18,29.7c-0.6,0.6-1.3,0.6-1.9,0.1l-13-13c-0.5-0.5-0.5-1.3,0-1.8L16,2.1c0.6-0.6,1.6-0.6,2.1,0l2.1,2.1 c0.6,0.6,0.6,1.6,0,2.1l-4.9,4.9c-0.6,0.6-0.6,1.3,0.4,1.3c0.3,0,0.7,0,0.7,0L30.3,12.6z" transform="scale(0.35) translate(8.2, 8.2)" />
      </svg>
    </button>
    <button type="button" id="redoButton" aria-label="Redo">
      <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
        <rect width="24" height="24" />
        <path d="M30.3,12.6c10.4,0,18.9,8.4,18.9,18.9s-8.5,18.9-18.9,18.9h-8.2c-0.8,0-1.3-0.6-1.3-1.4v-3.2 c0-0.8,0.6-1.5,1.4-1.5h8.1c7.1,0,12.8-5.7,12.8-12.8s-5.7-12.8-12.8-12.8H16.4c0,0-0.8,0-1.1,0.1c-0.8,0.4-0.6,1,0.1,1.7l4.9,4.9 c0.6,0.6,0.5,1.5-0.1,2.1L18,29.7c-0.6,0.6-1.3,0.6-1.9,0.1l-13-13c-0.5-0.5-0.5-1.3,0-1.8L16,2.1c0.6-0.6,1.6-0.6,2.1,0l2.1,2.1 c0.6,0.6,0.6,1.6,0,2.1l-4.9,4.9c-0.6,0.6-0.6,1.3,0.4,1.3c0.3,0,0.7,0,0.7,0L30.3,12.6z" transform="scale(-0.35, 0.35) translate(-60.2, 8.2)" />
      </svg>
    </button>

  <!-- Citation mode container - shown when citation button clicked -->
  <div id="citation-mode-container" class="hidden">
    <div class="citation-input-wrapper">
      <input type="text" id="citation-search-input" placeholder="Search library for citation..." autocomplete="off" />
      <button type="button" id="citation-close-btn" class="citation-close-btn" title="Close (ESC)">×</button>
    </div>
  </div>

  <!-- Link mode container - shown when the insert-link option is chosen -->
  <div id="link-mode-container" class="hidden">
    <div class="link-input-wrapper">
      <input type="url" id="link-url-input" inputmode="url" placeholder="Paste URL (https://...)" autocomplete="off" />
      <button type="button" id="link-remove-btn" class="citation-close-btn" title="Remove link">⌫</button>
      <button type="button" id="link-confirm-btn" class="citation-close-btn" title="Insert link">✓</button>
      <button type="button" id="link-close-btn" class="citation-close-btn" title="Close (ESC)">×</button>
    </div>
  </div>

  </div>

  <!-- Keyboard gap blocker - prevents taps in Safari gap from closing keyboard -->
  <div id="keyboard-gap-blocker"></div>

  <!-- Citation results - outside edit-toolbar so it can blur both toolbar and bottom-right-buttons.
       Scope chips live INSIDE this blurred panel so adding/removing them never
       changes the bottom toolbar's height and never shifts the search input.
       Chip bar is the FIRST flex child — with the panel's column-reverse it
       renders at the visual BOTTOM, right above the search input. Results
       stack above the chips. When chips hide on typed input, results fill
       the same bottom slot — no perceived jump. -->
  <div id="citation-toolbar-results">
    <div class="citation-scope-bar">
      <div class="citation-scope-chips" role="tablist" aria-label="Search scope">
        <button type="button" class="citation-scope-btn active" data-scope="public" role="tab" aria-selected="true">Public</button>
        <button type="button" class="citation-scope-btn" data-scope="mine" role="tab" aria-selected="false">Personal</button>
        <button type="button" class="citation-scope-btn" data-scope="shelf" role="tab" aria-selected="false">Shelf</button>
      </div>
      <div class="citation-shelf-picker" style="display:none;">
        <!-- Custom dropdown (NOT a native <select>) so iOS doesn't dismiss
             the keyboard when it's tapped. The native picker would always
             close the on-screen keyboard regardless of preventDefault. -->
        <button type="button" class="citation-shelf-trigger" aria-haspopup="listbox" aria-expanded="false">
          <span class="citation-shelf-current">— pick a shelf —</span>
          <span class="citation-shelf-caret" aria-hidden="true">▾</span>
        </button>
        <ul class="citation-shelf-options" role="listbox" hidden></ul>
      </div>
    </div>
    <div class="citation-results-items"></div>
  </div>
