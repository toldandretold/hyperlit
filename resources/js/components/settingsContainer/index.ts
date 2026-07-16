// SettingsContainerManager — the #settings-container bottom-up panel opened by
// #settingsButton. Owns the document-delegated click router + container lifecycle
// inline (theme buttons + search are handled inline); delegates the vibe gallery,
// gate panel, and text/width controls to sibling modules via self-as-first-arg.
// Registry lifecycle + the default-export singleton live in
// ../settingsButton/settingsButton.
import { ContainerManager } from "../utilities/containerManager";
import { verbose } from "../../utilities/logger";
import { switchTheme, getCurrentTheme, THEMES } from "./themeSwitcher";
import { switchReadingMode, getReadingMode, READING_MODES } from "./readingModeSwitcher";
import { openSearchToolbar } from "../../search/inTextSearch/searchToolbar";
import { openAudioPlayer, syncListenButton } from "../audioPlayer/index";
import { handleVibeClick, _openVibeGallery, _openVibeUI } from "./vibe";
import { _openGatePanel } from "./gate";
import { applyTextAdjustments, syncControlsUI, stepTextSize, stepWidth, _debounceResize, reconcileViewportWidth } from "./textControls";

// Persisted flag: once the user dismisses the Pages-mode caveat note, never
// auto-show it again ("once per user").
const PAGES_WARNING_DISMISSED_KEY = "hyperlit_pages_warning_dismissed";

/**
 * SettingsContainerManager - Extends ContainerManager with event delegation
 * Uses the same robust pattern as userContainer.
 */
export class SettingsContainerManager extends (ContainerManager as any) {
  constructor(containerId: any, overlayId: any, buttonId: any, frozenContainerIds: any = []) {
    super(containerId, overlayId, buttonId, frozenContainerIds);

    this.boundClickHandler = this.handleDocumentClick.bind(this);
    this.boundThemeChangeHandler = this.updateButtonStates.bind(this);
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
    window.addEventListener('themechange', this.boundThemeChangeHandler);
    window.addEventListener('readingmodechange', this.boundThemeChangeHandler);
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

    // Reading-mode buttons (scroll vs paginated)
    if (e.target.closest("#scrollModeButton")) {
      e.preventDefault();
      e.stopPropagation();
      verbose.init('Scroll mode clicked via delegation', '/components/settingsContainer/index.ts');
      switchReadingMode(READING_MODES.SCROLL);
      this.syncPagesWarning(false);
      return;
    }
    if (e.target.closest("#paginatedModeButton")) {
      e.preventDefault();
      e.stopPropagation();
      verbose.init('Paginated mode clicked via delegation', '/components/settingsContainer/index.ts');
      switchReadingMode(READING_MODES.PAGINATED);
      this.syncPagesWarning(true);
      return;
    }
    // Dismiss the Pages-mode caveat (once per user — persisted).
    if (e.target.closest("#pagesModeWarningClose")) {
      e.preventDefault();
      e.stopPropagation();
      this.dismissPagesWarning();
      return;
    }

    // Text-size steppers
    if (e.target.closest("#textSizeDecrease")) {
      e.preventDefault();
      e.stopPropagation();
      this.stepTextSize(-1);
      return;
    }
    if (e.target.closest("#textSizeIncrease")) {
      e.preventDefault();
      e.stopPropagation();
      this.stepTextSize(1);
      return;
    }

    // Column-width steppers
    if (e.target.closest("#widthNarrow")) {
      e.preventDefault();
      e.stopPropagation();
      this.stepWidth(-1);
      return;
    }
    if (e.target.closest("#widthWiden")) {
      e.preventDefault();
      e.stopPropagation();
      this.stepWidth(1);
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

    // Handle listen (TTS audio) button click — same choreography as search
    if (e.target.closest("#audioListenButton")) {
      e.preventDefault();
      e.stopPropagation();
      verbose.init('Listen button clicked via delegation', '/components/settingsContainer/index.ts');
      this.closeContainer();
      setTimeout(() => {
        openAudioPlayer();
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
    // The parent's innerHTML reset restores the Listen button's default
    // `hidden` — re-reveal it when the open book is narratable.
    syncListenButton();

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

    // Gate is a neutral action button (like search / listen), NOT a theme toggle —
    // it never gets `.active`, so it inherits each theme's plain settings-button
    // wash and stays visually identical to the other action pills.

    // Reading-mode toggle pair
    const readingMode = getReadingMode();
    document.getElementById("scrollModeButton")?.classList.toggle("active", readingMode === READING_MODES.SCROLL);
    document.getElementById("paginatedModeButton")?.classList.toggle("active", readingMode === READING_MODES.PAGINATED);
    // Show the Pages-mode caveat whenever pages mode is the active preference
    // (parent's innerHTML reset restores it hidden each open; re-evaluate here).
    this.syncPagesWarning(readingMode === READING_MODES.PAGINATED);
  }

  /**
   * Show/hide the honest Pages-mode caveat note. Never shows once the user has
   * dismissed it (persisted) — "once per user". `hidden` is toggled rather than
   * removed so the parent's innerHTML reset restores a clean default each open.
   */
  syncPagesWarning(show: boolean) {
    const note = document.getElementById("pagesModeWarning");
    if (!note) return;
    const dismissed = localStorage.getItem(PAGES_WARNING_DISMISSED_KEY) === "1";
    (note as HTMLElement).hidden = !show || dismissed;
  }

  /** User closed the caveat — hide it now and never auto-show it again. */
  dismissPagesWarning() {
    localStorage.setItem(PAGES_WARNING_DISMISSED_KEY, "1");
    const note = document.getElementById("pagesModeWarning");
    if (note) (note as HTMLElement).hidden = true;
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
   * Override openContainer to update button active classes + stepper bounds.
   * Parent resets innerHTML to initialContent, then we refresh the dimmed-at-bound
   * state of the text-size / width steppers from localStorage + viewport fit.
   */
  openContainer(content: any = null, highlightId: any = null) {
    super.openContainer(content, highlightId);

    requestAnimationFrame(() => {
      this.updateButtonStates();
      this.syncControlsUI();
    });
  }

  /**
   * Proper cleanup - remove all event listeners
   */
  destroy() {
    document.removeEventListener("click", this.boundClickHandler);
    window.removeEventListener('themechange', this.boundThemeChangeHandler);
    window.removeEventListener('readingmodechange', this.boundThemeChangeHandler);
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
  applyTextAdjustments() { return applyTextAdjustments(this); }
  syncControlsUI() { return syncControlsUI(this); }
  stepTextSize(dir: number) { return stepTextSize(this, dir); }
  stepWidth(dir: number) { return stepWidth(this, dir); }
  _debounceResize() { return _debounceResize(this); }
}
