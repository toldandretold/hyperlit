/**
 * Insert Submenu Handler for EditToolbar
 *
 * Manages the insert (+) dropdown submenu (footnote / citation / image / link).
 * Open/close/click-outside skeleton cloned from BlockSubmenu, with ONE
 * deliberate difference: the option buttons are NOT clone-replaced here —
 * they keep their ids (#footnoteButton etc.) and their four-listener wiring
 * from index.ts's attachButtonHandlers (touchstart selection store, touchend
 * action delay, mousedown preventDefault, click). index.ts wraps each option
 * action to call notifyOptionActivated() so the menu closes and the trigger's
 * touchend guard window engages, mirroring the BlockSubmenu double-fire flag.
 */

interface InsertSubmenuOptions {
  insertSubmenu?: HTMLElement | null;
  insertButton?: HTMLElement | null;
  buttonStateManager?: { updateButtonStates(): void } | null;
}

export class InsertSubmenu {
  insertSubmenu: HTMLElement | null;
  insertButton: HTMLElement | null;
  buttonStateManager: { updateButtonStates(): void } | null;
  submenuButtonJustClicked = false;

  constructor(options: InsertSubmenuOptions = {}) {
    this.insertSubmenu = options.insertSubmenu || null;
    this.insertButton = options.insertButton || null;
    this.buttonStateManager = options.buttonStateManager || null;

    this.toggleInsertSubmenu = this.toggleInsertSubmenu.bind(this);
    this.openInsertSubmenu = this.openInsertSubmenu.bind(this);
    this.closeInsertSubmenu = this.closeInsertSubmenu.bind(this);
    this.handleClickOutsideSubmenu = this.handleClickOutsideSubmenu.bind(this);
  }

  /** Check if an option was just activated (mobile double-fire guard). */
  wasSubmenuButtonJustClicked(): boolean {
    return this.submenuButtonJustClicked;
  }

  toggleInsertSubmenu(): void {
    if (!this.insertSubmenu) return;
    if (this.insertSubmenu.classList.contains("hidden")) {
      this.openInsertSubmenu();
    } else {
      this.closeInsertSubmenu();
    }
  }

  openInsertSubmenu(): void {
    if (!this.insertSubmenu) return;

    // Refresh option disabled-states (footnote/citation vs selection, link
    // needs-selection) so the menu opens showing the truth.
    this.buttonStateManager?.updateButtonStates();

    this.insertSubmenu.classList.remove("hidden");
    this.insertButton?.classList.add("menu-open");

    // Attach click-outside listener after a tick so the opening click
    // doesn't immediately close the menu.
    setTimeout(() => {
      document.addEventListener("click", this.handleClickOutsideSubmenu);
    }, 0);
  }

  closeInsertSubmenu(): void {
    if (!this.insertSubmenu) return;
    this.insertSubmenu.classList.add("hidden");
    this.insertButton?.classList.remove("menu-open");
    document.removeEventListener("click", this.handleClickOutsideSubmenu);
  }

  handleClickOutsideSubmenu(e: MouseEvent): void {
    const submenu = this.insertSubmenu;
    const triggerBtn = this.insertButton;
    if (!submenu || !triggerBtn) return;
    const target = e.target as Node | null;
    if (target && !submenu.contains(target) && !triggerBtn.contains(target)) {
      this.closeInsertSubmenu();
    }
  }

  /**
   * Called by index.ts when any option action fires: closes the menu and arms
   * the 1000ms guard the trigger's touchend polls (prevents the + button from
   * re-toggling on the same gesture).
   */
  notifyOptionActivated(): void {
    this.submenuButtonJustClicked = true;
    this.closeInsertSubmenu();
    setTimeout(() => {
      this.submenuButtonJustClicked = false;
    }, 1000);
  }
}
