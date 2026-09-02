{{--
  The AI Archivist brain button (hero pages: home / journal / archive). Sits in
  the arranger row after the feed buttons; clicking it toggles the search box's
  archivist takeover mode (search/searchBox.ts — toggles + feed buttons hide,
  the textarea becomes a submit-driven prompt). Guest state (dimmed + tooltip)
  is stamped by components/aiArchivist/archivistPanel.ts. Lucide "brain" icon —
  same paths as the reader's #brain-hyperlight selection button.
--}}
<button type="button" id="archivist-brain-button" aria-label="Ask the AI Archivist" title="Ask the AI Archivist">
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path class="brain-icon-path" d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z"/>
    <path class="brain-icon-path" d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z"/>
    <path class="brain-icon-path" d="M15 13a4.5 4.5 0 0 1-3-4 4.5 4.5 0 0 1-3 4"/>
    <path class="brain-icon-path" d="M17.599 6.5a3 3 0 0 0 .399-1.375"/>
    <path class="brain-icon-path" d="M6.003 5.125A3 3 0 0 0 6.401 6.5"/>
    <path class="brain-icon-path" d="M3.477 10.896a4 4 0 0 1 .585-.396"/>
    <path class="brain-icon-path" d="M19.938 10.5a4 4 0 0 1 .585.396"/>
    <path class="brain-icon-path" d="M6 18a4 4 0 0 1-1.967-.516"/>
    <path class="brain-icon-path" d="M19.967 17.484A4 4 0 0 1 18 18"/>
  </svg>
</button>
