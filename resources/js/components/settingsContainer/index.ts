// SettingsContainerManager — the #settings-container bottom-up panel opened by
// #settingsButton. Owns the document-delegated click router + container lifecycle
// inline (theme buttons + search are handled inline); delegates the vibe gallery,
// gate panel, and text/width controls to sibling modules via self-as-first-arg.
// Registry lifecycle + the default-export singleton live in
// ../settingsButton/settingsButton.
import { ContainerManager } from "../utilities/containerManager";
import { verbose } from "../../utilities/logger";
import { switchTheme, getCurrentTheme, THEMES } from "./themeSwitcher";
import { openSearchToolbar } from "../../search/inTextSearch/searchToolbar";
import { handleVibeClick, _openVibeGallery, _openVibeUI } from "./vibe";
import { _openGatePanel } from "./gate";
import { toggleFullWidth, applyTextAdjustments, syncSliderUI, handleSliderInput, _debounceResize, reconcileViewportWidth } from "./textControls";

/**
 * SettingsContainerManager - Extends ContainerManager with event delegation
 * Uses the same robust pattern as userContainer.
 */
export class SettingsContainerManager extends (ContainerManager as any) {
  constructor(containerId: any, overlayId: any, buttonId: any, frozenContainerIds: any = []) {
    super(containerId, overlayId, buttonId, frozenContainerIds);

    this.boundClickHandler = this.handleDocumentClick.bind(this);
    this.boundThemeChangeHandler = this.updateButtonStates.bind(this);
    this.boundInputHandler = this.handleSliderInput.bind(this);
    this.boundViewportResizeHandler = this._reconcileWidthDebounced.bind(this);
    this._resizeDebounce = null;
    this._widthReconcileDebounce = null;

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
    // Reconcile the content-width inline artifacts when the viewport crosses the
    // width-control breakpoint (live resize / rotate) — keeps a saved wide-screen
    // width from lingering as a too-narrow column below WIDTH_HIDE_BP.
    window.addEventListener('resize', this.boundViewportResizeHandler);
    verbose.init('Settings event listeners attached', '/components/settingsContainer/index.ts');
  }

  // Escape-to-close + Tab focus trap come from the ContainerManager base
  // (settings-container is in its FOCUS_TRAP_CONTAINER_IDS).

  /** Debounced viewport-width reconcile (strips/reapplies inline content-width). */
  _reconcileWidthDebounced() {
    if (this._widthReconcileDebounce) clearTimeout(this._widthReconcileDebounce);
    this._widthReconcileDebounce = setTimeout(() => reconcileViewportWidth(this), 150);
  }

  /**
   * Handle all clicks inside settings container using delegation
   * Pattern from userContainer - queries DOM at click time
   */
  handleDocumentClick(e: any) {
    // Only handle clicks inside settings container or overlay
    const isInSettingsContainer = e.target.closest('#settings-container');
    const isSettingsOverlay = e.target.closest('#settings-overlay');

    if (!isInSettingsContainer && !isSettingsOverlay) {
      return;
    }

    // Handle theme button clicks
    if (e.target.closest("#darkModeButton")) {
      e.preventDefault();
      e.stopPropagation();
      verbose.init('Dark mode clicked via delegation', '/components/settingsContainer/index.ts');
      switchTheme(THEMES.DARK);
      return;
    }

    if (e.target.closest("#lightModeButton")) {
      e.preventDefault();
      e.stopPropagation();
      verbose.init('Light mode clicked via delegation', '/components/settingsContainer/index.ts');
      switchTheme(THEMES.LIGHT);
      return;
    }

    if (e.target.closest("#sepiaModeButton")) {
      e.preventDefault();
      e.stopPropagation();
      verbose.init('Sepia mode clicked via delegation', '/components/settingsContainer/index.ts');
      switchTheme(THEMES.SEPIA);
      return;
    }

    if (e.target.closest("#vibeCSSButton")) {
      e.preventDefault();
      e.stopPropagation();
      verbose.init('Vibe CSS clicked via delegation', '/components/settingsContainer/index.ts');
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

    // Handle gate filter button click
    if (e.target.closest("#gateFilterButton")) {
      e.preventDefault();
      e.stopPropagation();
      verbose.init('Gate filter clicked via delegation', '/components/settingsContainer/index.ts');
      this._openGatePanel();
      return;
    }

    // Handle search button click
    if (e.target.closest("#searchButton")) {
      e.preventDefault();
      e.stopPropagation();
      verbose.init('Search button clicked via delegation', '/components/settingsContainer/index.ts');
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
  async updateButtonStates() {
    const currentTheme = getCurrentTheme();

    const darkButton = document.getElementById("darkModeButton");
    const lightButton = document.getElementById("lightModeButton");
    const sepiaButton = document.getElementById("sepiaModeButton");
    const vibeButton = document.getElementById("vibeCSSButton");
    const gateButton = document.getElementById("gateFilterButton");

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

    // Gate button: active (aqua) when filtering is on (mode !== 'all')
    if (gateButton) {
      try {
        const { getGateSettings } = await import('../utilities/gateFilter');
        gateButton.classList.toggle('active', getGateSettings().mode !== 'all');
      } catch { /* module not loaded yet — leave default */ }
    }
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
   * Override openContainer to update button active classes + slider positions.
   * Parent resets innerHTML to initialContent, then we sync slider values from localStorage.
   */
  openContainer(content: any = null, highlightId: any = null) {
    super.openContainer(content, highlightId);

    requestAnimationFrame(() => {
      this.updateButtonStates();
      this.syncSliderUI();
    });
  }

  /**
   * Proper cleanup - remove all event listeners
   */
  destroy() {
    document.removeEventListener("click", this.boundClickHandler);
    document.removeEventListener("input", this.boundInputHandler);
    window.removeEventListener('themechange', this.boundThemeChangeHandler);
    window.removeEventListener('resize', this.boundViewportResizeHandler);
    if (this._resizeDebounce) clearTimeout(this._resizeDebounce);
    if (this._widthReconcileDebounce) clearTimeout(this._widthReconcileDebounce);
    super.destroy();
    verbose.init('Settings event listeners removed', '/components/settingsContainer/index.ts');
  }

  // ── Delegators ──────────────────────────────────────────────────────────
  // vibe
  handleVibeClick() { return handleVibeClick(this); }
  _openVibeGallery() { return _openVibeGallery(this); }
  _openVibeUI(fallbackHTML?: any) { return _openVibeUI(this, fallbackHTML); }

  // gate
  _openGatePanel() { return _openGatePanel(this); }

  // textControls
  toggleFullWidth() { return toggleFullWidth(this); }
  applyTextAdjustments() { return applyTextAdjustments(this); }
  syncSliderUI() { return syncSliderUI(this); }
  handleSliderInput(e: any) { return handleSliderInput(this, e); }
  _debounceResize() { return _debounceResize(this); }
}
