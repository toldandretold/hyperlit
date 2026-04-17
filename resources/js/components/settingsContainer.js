// settingsContainer.js - Manages the bottom-up settings panel

import { ContainerManager } from "../containerManager.js";
import { log, verbose } from "../utilities/logger.js";
import { switchTheme, getCurrentTheme, THEMES } from "../utilities/themeSwitcher.js";
import { openSearchToolbar } from "../search/inTextSearch/searchToolbar.js";
// vibeCSS.js is lazily imported at click time — keeps it out of the main bundle
import { isLoggedIn } from "../utilities/auth.js";
import { captureScrollAnchor, restoreScrollAnchor } from "../utilities/scrollAnchor.js";
import { savePreference, clearPreference } from "../utilities/preferences.js";

const STORAGE_KEYS = { TEXT_SIZE: 'hyperlit_text_size', CONTENT_WIDTH: 'hyperlit_content_width', FULL_WIDTH: 'hyperlit_full_width' };
const DEFAULTS = { TEXT_SIZE: 28, TEXT_SIZE_MOBILE: 18, CONTENT_WIDTH: 40 };

/**
 * SettingsContainerManager - Extends ContainerManager with event delegation
 * Uses the same robust pattern as userContainer.js
 */
export class SettingsContainerManager extends ContainerManager {
  constructor(containerId, overlayId, buttonId, frozenContainerIds = []) {
    super(containerId, overlayId, buttonId, frozenContainerIds);

    this.boundClickHandler = this.handleDocumentClick.bind(this);
    this.boundThemeChangeHandler = this.updateButtonStates.bind(this);
    this.boundInputHandler = this.handleSliderInput.bind(this);
    this._resizeDebounce = null;

    this.setupSettingsListeners();

    // Set initial button states and apply saved text adjustments
    this.updateButtonStates();
    this.applyTextAdjustments();
  }

  /**
   * Setup event delegation for theme buttons
   * Survives innerHTML replacement and SPA transitions
   */
  setupSettingsListeners() {
    document.addEventListener("click", this.boundClickHandler);
    document.addEventListener("input", this.boundInputHandler);
    window.addEventListener('themechange', this.boundThemeChangeHandler);
    verbose.init('Settings event listeners attached', '/components/settingsContainer.js');
  }

  /**
   * Handle all clicks inside settings container using delegation
   * Pattern from userContainer.js - queries DOM at click time
   */
  handleDocumentClick(e) {
    // Only handle clicks inside settings container or overlay
    const isInSettingsContainer = e.target.closest('#bottom-up-container');
    const isSettingsOverlay = e.target.closest('#settings-overlay');

    if (!isInSettingsContainer && !isSettingsOverlay) {
      return;
    }

    // Handle theme button clicks
    if (e.target.closest("#darkModeButton")) {
      e.preventDefault();
      e.stopPropagation();
      verbose.init('Dark mode clicked via delegation', '/components/settingsContainer.js');
      switchTheme(THEMES.DARK);
      return;
    }

    if (e.target.closest("#lightModeButton")) {
      e.preventDefault();
      e.stopPropagation();
      verbose.init('Light mode clicked via delegation', '/components/settingsContainer.js');
      switchTheme(THEMES.LIGHT);
      return;
    }

    if (e.target.closest("#sepiaModeButton")) {
      e.preventDefault();
      e.stopPropagation();
      verbose.init('Sepia mode clicked via delegation', '/components/settingsContainer.js');
      switchTheme(THEMES.SEPIA);
      return;
    }

    if (e.target.closest("#vibeCSSButton")) {
      e.preventDefault();
      e.stopPropagation();
      verbose.init('Vibe CSS clicked via delegation', '/components/settingsContainer.js');
      this.handleVibeClick();
      return;
    }

    // Handle full-width toggle click
    if (e.target.closest("#fullWidthToggle")) {
      e.preventDefault();
      e.stopPropagation();
      this.toggleFullWidth();
      return;
    }

    // Handle search button click
    if (e.target.closest("#searchButton")) {
      e.preventDefault();
      e.stopPropagation();
      verbose.init('Search button clicked via delegation', '/components/settingsContainer.js');
      this.closeContainer();
      // Open search toolbar after settings closes
      setTimeout(() => {
        openSearchToolbar();
      }, 100);
      return;
    }

    // Handle overlay click to close
    if (e.target.closest("#settings-overlay") && this.isOpen) {
      this.closeContainer();
    }
  }

  /**
   * Update button active states based on current theme
   * Called on theme change events and after rebinding
   */
  updateButtonStates() {
    const currentTheme = getCurrentTheme();

    const darkButton = document.getElementById("darkModeButton");
    const lightButton = document.getElementById("lightModeButton");
    const sepiaButton = document.getElementById("sepiaModeButton");
    const vibeButton = document.getElementById("vibeCSSButton");

    // Remove all active classes
    darkButton?.classList.remove("active");
    lightButton?.classList.remove("active");
    sepiaButton?.classList.remove("active");
    vibeButton?.classList.remove("active");

    // Add active class to current theme
    switch (currentTheme) {
      case THEMES.DARK:
        darkButton?.classList.add("active");
        break;
      case THEMES.LIGHT:
        lightButton?.classList.add("active");
        break;
      case THEMES.SEPIA:
        sepiaButton?.classList.add("active");
        break;
      case THEMES.VIBE:
        vibeButton?.classList.add("active");
        break;
    }

  }

  /**
   * Handle vibe button click.
   * - Saved + not active theme: apply vibe instantly + close
   * - Otherwise: open gallery
   */
  async handleVibeClick() {
    const { hasVibeCSS } = await import('./vibeCSS.js');
    const currentTheme = getCurrentTheme();
    const saved = hasVibeCSS();

    if (saved && currentTheme !== THEMES.VIBE) {
      // Apply the saved vibe, then show the gallery
      switchTheme(THEMES.VIBE);
    }

    // Always open the gallery
    this._openVibeGallery();
  }

  /**
   * Replace settings panel content with vibe gallery.
   */
  async _openVibeGallery() {
    const container = document.getElementById('bottom-up-container');
    if (!container) return;

    const savedHTML = container.innerHTML;

    const restorePanel = () => {
      container.innerHTML = savedHTML;
      this._vibeRestore = null;
      this.syncSliderUI();
      this.updateButtonStates();
    };

    this._vibeRestore = restorePanel;

    const { showVibeGallery } = await import('./vibeCSS.js');
    const loggedIn = await isLoggedIn();

    showVibeGallery(container, loggedIn, {
      onApply: () => {
        restorePanel();
        switchTheme(THEMES.VIBE);
        this.updateButtonStates();
        this.closeContainer();
      },
      onClose: restorePanel,
      onGenerate: () => {
        this._openVibeUI(savedHTML);
      },
    });
  }

  /**
   * Replace settings panel content with vibe generation input UI.
   * @param {string} [fallbackHTML] - HTML to restore on cancel (if called from gallery, use gallery's savedHTML)
   */
  async _openVibeUI(fallbackHTML) {
    const container = document.getElementById('bottom-up-container');
    if (!container) return;

    const { showVibeInput } = await import('./vibeCSS.js');
    const savedHTML = fallbackHTML || container.innerHTML;

    showVibeInput(
      container,
      // onComplete
      () => {
        container.innerHTML = savedHTML;
        this.syncSliderUI();
        switchTheme(THEMES.VIBE);
        this.updateButtonStates();
        this.closeContainer();
      },
      // onCancel — go back to gallery if we came from there, else restore settings
      () => {
        if (fallbackHTML) {
          // Came from gallery — re-open gallery
          this._openVibeGallery();
        } else {
          container.innerHTML = savedHTML;
          this.syncSliderUI();
          this.updateButtonStates();
        }
      }
    );
  }

  /**
   * Toggle full-width mode — reduces main-content padding to near-edge-to-edge.
   * Perimeter buttons stay in place but get transparent backgrounds.
   */
  toggleFullWidth() {
    const allMainContent = document.querySelectorAll('.main-content');
    if (!allMainContent.length) return;

    // Capture scroll anchor before layout change
    const wrapper = document.querySelector('.reader-content-wrapper');
    const anchor = wrapper ? captureScrollAnchor(wrapper) : null;

    // Determine new state from first element
    const isActive = !allMainContent[0].classList.contains('full-width-mode');
    allMainContent.forEach(el => el.classList.toggle('full-width-mode', isActive));

    // Restore scroll position after reflow
    if (anchor) restoreScrollAnchor(wrapper, anchor);

    // Update button text
    const btn = document.getElementById('fullWidthToggle');
    if (btn) btn.textContent = isActive ? '>full<' : '<full>';

    // Persist
    if (isActive) {
      localStorage.setItem(STORAGE_KEYS.FULL_WIDTH, 'true');
      savePreference('full_width', true);
    } else {
      localStorage.removeItem(STORAGE_KEYS.FULL_WIDTH);
      clearPreference('full_width');
    }
  }

  /**
   * Apply saved text size and content width from localStorage.
   * Only sets inline CSS variables if user has explicitly changed from defaults.
   */
  applyTextAdjustments() {
    const savedSize = localStorage.getItem(STORAGE_KEYS.TEXT_SIZE);
    const savedWidth = localStorage.getItem(STORAGE_KEYS.CONTENT_WIDTH);

    if (savedSize) {
      // Scope to .main-content so logo, search bar, arranger buttons etc. stay fixed size
      document.querySelectorAll('.main-content').forEach(el => el.style.fontSize = `${savedSize}px`);
    }
    if (savedWidth) {
      document.documentElement.style.setProperty('--content-width', `${savedWidth}ch`);
      // Also set inline max-width on wrapper to override global * { max-width: 100% }
      const wrapper = document.querySelector('.reader-content-wrapper');
      if (wrapper) wrapper.style.maxWidth = `${savedWidth}ch`;
    }

    // Restore full-width mode
    if (localStorage.getItem(STORAGE_KEYS.FULL_WIDTH) === 'true') {
      const allMainContent = document.querySelectorAll('.main-content');
      allMainContent.forEach(el => el.classList.add('full-width-mode'));

      const btn = document.getElementById('fullWidthToggle');
      if (btn) btn.textContent = '>full<';
    }
  }

  /**
   * Sync slider UI elements with current values.
   * Called when settings panel opens (sliders may have been destroyed by innerHTML replacement).
   */
  syncSliderUI() {
    const isMobile = window.innerWidth <= 500;
    const defaultSize = isMobile ? DEFAULTS.TEXT_SIZE_MOBILE : DEFAULTS.TEXT_SIZE;

    const savedSize = localStorage.getItem(STORAGE_KEYS.TEXT_SIZE);
    const savedWidth = localStorage.getItem(STORAGE_KEYS.CONTENT_WIDTH);
    const textSize = savedSize ? parseInt(savedSize, 10) : defaultSize;
    const contentWidth = savedWidth ? parseInt(savedWidth, 10) : DEFAULTS.CONTENT_WIDTH;

    const sizeSlider = document.getElementById('textSizeSlider');
    const sizeValue = document.getElementById('textSizeValue');
    const widthSlider = document.getElementById('contentWidthSlider');
    const widthValue = document.getElementById('contentWidthValue');

    if (sizeSlider) {
      sizeSlider.value = textSize;
    }
    if (sizeValue) sizeValue.textContent = `${textSize}px`;
    if (widthSlider) widthSlider.value = contentWidth;
    if (widthValue) widthValue.textContent = `${contentWidth}ch`;

    // Sync full-width button text
    const fullWidthBtn = document.getElementById('fullWidthToggle');
    const isFullWidth = document.querySelector('.main-content')?.classList.contains('full-width-mode');
    if (fullWidthBtn) fullWidthBtn.textContent = isFullWidth ? '>full<' : '<full>';
  }

  /**
   * Delegated input handler for sliders.
   * Sets CSS variable live, saves to localStorage, dispatches resize for button repositioning.
   */
  handleSliderInput(e) {
    if (e.target.id === 'textSizeSlider') {
      const val = parseInt(e.target.value, 10);
      const isMobile = window.innerWidth <= 500;
      const defaultSize = isMobile ? DEFAULTS.TEXT_SIZE_MOBILE : DEFAULTS.TEXT_SIZE;

      // Capture scroll anchor before font-size change
      const wrapper = document.querySelector('.reader-content-wrapper');
      const anchor = wrapper ? captureScrollAnchor(wrapper) : null;

      // Scope to .main-content so only book content resizes
      document.querySelectorAll('.main-content').forEach(el => el.style.fontSize = `${val}px`);
      const display = document.getElementById('textSizeValue');
      if (display) display.textContent = `${val}px`;

      if (val === defaultSize) {
        localStorage.removeItem(STORAGE_KEYS.TEXT_SIZE);
        clearPreference('text_size');
        document.querySelectorAll('.main-content').forEach(el => el.style.removeProperty('font-size'));
      } else {
        localStorage.setItem(STORAGE_KEYS.TEXT_SIZE, val);
        savePreference('text_size', val);
      }

      // Restore scroll position after reflow
      if (anchor) restoreScrollAnchor(wrapper, anchor);

      this._debounceResize();
      return;
    }

    if (e.target.id === 'contentWidthSlider') {
      const val = parseInt(e.target.value, 10);

      // Set max-width directly on .reader-content-wrapper — overrides both
      // the CSS variable and the global * { max-width: 100% } rule
      const wrapper = document.querySelector('.reader-content-wrapper');

      // Capture scroll anchor before width change
      const anchor = wrapper ? captureScrollAnchor(wrapper) : null;

      if (wrapper) wrapper.style.maxWidth = `${val}ch`;

      document.documentElement.style.setProperty('--content-width', `${val}ch`);
      const display = document.getElementById('contentWidthValue');
      if (display) display.textContent = `${val}ch`;

      if (val === DEFAULTS.CONTENT_WIDTH) {
        localStorage.removeItem(STORAGE_KEYS.CONTENT_WIDTH);
        clearPreference('content_width');
        document.documentElement.style.removeProperty('--content-width');
        if (wrapper) wrapper.style.removeProperty('max-width');
      } else {
        localStorage.setItem(STORAGE_KEYS.CONTENT_WIDTH, val);
        savePreference('content_width', val);
      }

      // Restore scroll position after reflow
      if (anchor) restoreScrollAnchor(wrapper, anchor);

      this._debounceResize();
      return;
    }
  }

  /**
   * Debounced resize dispatch — triggers perimeter button repositioning.
   */
  _debounceResize() {
    if (this._resizeDebounce) clearTimeout(this._resizeDebounce);
    this._resizeDebounce = setTimeout(() => {
      window.dispatchEvent(new Event('resize'));
    }, 150);
  }

  /**
   * Override closeContainer to restore settings UI if vibe gallery is showing.
   */
  closeContainer() {
    if (this._vibeRestore) {
      this._vibeRestore();
    }
    super.closeContainer();
  }

  /**
   * Rebind elements after SPA transitions
   * Extends parent rebindElements to also update button states
   */
  rebindElements() {
    super.rebindElements();
    this.updateButtonStates();
  }

  /**
   * Override openContainer to skip innerHTML reset (preserves slider state)
   * and update button active classes + slider positions
   */
  openContainer(content = null, highlightId = null) {
    // skipContentReset: true — settings panel never receives new content,
    // and resetting innerHTML would destroy slider positions and values
    super.openContainer(content, highlightId, { skipContentReset: true });

    // Update button states and slider UI after DOM is ready
    requestAnimationFrame(() => {
      this.updateButtonStates();
      this.syncSliderUI();
      verbose.init('Button states and sliders updated after container opened', '/components/settingsContainer.js');
    });
  }

  /**
   * Proper cleanup - remove all event listeners
   */
  destroy() {
    document.removeEventListener("click", this.boundClickHandler);
    document.removeEventListener("input", this.boundInputHandler);
    window.removeEventListener('themechange', this.boundThemeChangeHandler);
    if (this._resizeDebounce) clearTimeout(this._resizeDebounce);
    super.destroy();
    verbose.init('Settings event listeners removed', '/components/settingsContainer.js');
  }
}

// Settings manager instance (singleton)
let settingsManager = null;

/**
 * Initialize the settings container manager
 */
export function initializeSettingsManager() {
  const settingsButton = document.getElementById("settingsButton");

  if (!settingsButton) {
    verbose.init('Settings button not found, skipping initialization', '/components/settingsContainer.js');
    return null;
  }

  if (!settingsManager) {
    // Create new manager instance
    settingsManager = new SettingsContainerManager(
      "bottom-up-container",
      "settings-overlay",
      "settingsButton",
      ["main-content"]
    );
    log.init('Settings Manager initialized', '/components/settingsContainer.js');
  } else {
    // Manager exists, just rebind elements after SPA transition
    settingsManager.rebindElements();
    verbose.init('Settings Manager rebound', '/components/settingsContainer.js');
  }

  return settingsManager;
}

/**
 * Open the settings container
 */
export function openSettings() {
  if (settingsManager) {
    settingsManager.openContainer();
  }
}

/**
 * Close the settings container
 */
export function closeSettings() {
  if (settingsManager) {
    settingsManager.closeContainer();
  }
}

/**
 * Toggle the settings container
 */
export function toggleSettings() {
  if (settingsManager) {
    settingsManager.toggleContainer();
  }
}

/**
 * Destroy settings manager for cleanup during navigation
 */
export function destroySettingsManager() {
  if (settingsManager) {
    settingsManager.destroy();
    settingsManager = null;
    verbose.init('Settings Manager destroyed', '/components/settingsContainer.js');
    return true;
  }
  return false;
}
