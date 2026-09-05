// OpenBookContainerManager — the "Open" start-menu flyout beside the logo-nav
// column: a library-mode search box (./openbookSearch) over an IndexedDB
// recents list (./recentBooks). Flyout geometry / glass shell / animation
// mirror UserContainerManager (userContainer/index.ts); the base
// ContainerManager wires the #openBookButton click → toggleContainer and
// provides the focus trap (openbook-container is in FOCUS_TRAP_CONTAINER_IDS).
// Registry lifecycle + the window.openBookManager handle live in
// ../openbookButton/openbookButton.
import { ContainerManager } from '../utilities/containerManager';
import { navigateByStructure } from '../../SPA/navigation/navigationRegistry';
import { book } from '../../app';
import { log } from '../../utilities/logger';
import { getVisibleBottom } from '../../utilities/viewportMetrics';
import { loadRecentBooks, renderRecentList } from './recentBooks';

const PANEL_WIDTH = 280;
// Fixed height (only the viewport caps it): a constant, decent-sized panel
// regardless of how many recents are cached, so search results always have
// room and the frame never resizes — content areas flex and scroll inside it
// (with a visible scrollbar when there's more, see openbookContainer.css).
const PANEL_HEIGHT = 420;
// ≤ this width the panel opens as a full-width bottom sheet instead of a
// flyout (same phone threshold as the newbook flyout's MOBILE_MAX_WIDTH).
const MOBILE_MAX_WIDTH = 480;

export class OpenBookContainerManager extends (ContainerManager as any) {
  constructor(containerId: any, overlayId: any, buttonId: any, frozenContainerIds: any = []) {
    super(containerId, overlayId, buttonId, frozenContainerIds);
    this.isAnimating = false;
    this.setupStyles();
    this.setupPanelListeners();
  }

  setupStyles() {
    const container = this.container;
    if (!container) return;

    container.style.position = 'fixed';
    container.style.transition =
      'width 0.3s ease-out, height 0.3s ease-out, opacity 0.3s ease-out, padding 0.3s ease-out';
    // Above the logo nav (1002): when a narrow viewport clamps this flyout
    // left over the nav column, the panel is the TOP of the stack.
    container.style.zIndex = '1003';
    container.style.boxShadow = '0 0 15px rgba(0, 0, 0, 0.2)';
    container.style.borderRadius = '10px'; /* match the logo-nav glass pill */
    container.style.opacity = '0';
    container.style.padding = '12px';
    container.style.width = '0';
    container.style.height = '0';
  }

  setupPanelListeners() {
    // Result-link click: close the flyout and let the document-level
    // LinkNavigationHandler SPA-route the <a href="/{book}"> — no
    // preventDefault here, and closing must not cancel the click.
    if (!this._resultsClickHandler) {
      this._resultsClickHandler = (e: any) => {
        if (e.target?.closest?.('a')) this.closeContainer();
      };
    }
    const results = document.getElementById('openbook-search-results');
    results?.removeEventListener('click', this._resultsClickHandler);
    results?.addEventListener('click', this._resultsClickHandler);

    // Empty query ⇒ Recent list; anything typed ⇒ search results.
    if (!this._inputHandler) {
      this._inputHandler = (e: any) => {
        const empty = (e.target?.value ?? '').trim().length === 0;
        const recent = document.getElementById('openbook-recent');
        if (recent) recent.style.display = empty ? '' : 'none';
      };
    }
    const input = document.getElementById('openbook-search-input');
    input?.removeEventListener('input', this._inputHandler);
    input?.addEventListener('input', this._inputHandler);
  }

  async refreshRecents() {
    const listEl = document.getElementById('openbook-recent-list');
    if (!listEl) return;
    // Exclude the book currently on screen (live SPA binding from app.ts).
    const records = await loadRecentBooks(String(book));
    renderRecentList(listEl, records, (bookId: string) => { void this.openBook(bookId); });
  }

  async openBook(bookId: string) {
    this.closeContainer();
    if (bookId === String(book)) return; // already reading this book — just dismiss
    try {
      await navigateByStructure({
        toBook: bookId,
        targetUrl: `/${bookId}`,
        targetStructure: 'reader',
        hash: '',
      });
    } catch (error) {
      log.error('Open-book SPA navigation failed, falling back to full load', '/components/openbookContainer/index.ts', error);
      window.location.href = `/${encodeURIComponent(bookId)}`;
    }
  }

  toggleContainer() {
    if (this.isAnimating) return;
    if (this.isOpen) {
      this.closeContainer();
    } else {
      this.openContainer();
    }
  }

  openContainer() {
    if (this.isAnimating) return;

    // One flyout at a time (three-way with the user + newbook panels).
    const userMgr = (window as any).userManager;
    if (userMgr?.isOpen) userMgr.closeContainer();
    const newBookMgr = (window as any).newBookManager;
    if (newBookMgr?.isOpen) newBookMgr.closeContainer();

    this.isAnimating = true;
    this.animationType = 'open';

    // Every open starts in the Recent view: clear any persisted query so the
    // searchBox's bfcache/init restore can't resurrect stale results.
    const input = document.getElementById('openbook-search-input') as HTMLTextAreaElement | null;
    if (input) input.value = '';
    localStorage.removeItem('openbook_search_query');
    const results = document.getElementById('openbook-search-results');
    if (results) {
      results.classList.remove('visible');
      results.classList.add('hidden');
      results.innerHTML = '';
    }
    const recent = document.getElementById('openbook-recent');
    if (recent) recent.style.display = '';
    void this.refreshRecents();

    // Phones get a keyboard-aware bottom sheet instead of the flyout.
    this._isSheet = window.innerWidth <= MOBILE_MAX_WIDTH;
    if (this._isSheet) {
      this.openAsSheet();
      return;
    }

    if (this.button) {
      const rect = this.button.getBoundingClientRect();
      const navWrapper = this.button.closest('#logoNavMenu')
        ? document.getElementById('logoNavWrapper')
        : null;
      if (navWrapper) {
        // Start-menu-style flyout: right of the logo-nav glass column (+4 =
        // flush with the pill), top-aligned with the trigger row, clamped so
        // narrow viewports stack it over the nav instead of off-screen.
        const desired = navWrapper.getBoundingClientRect().right + 4;
        const maxLeft = window.innerWidth - PANEL_WIDTH - 10;
        this.container.style.top = `${rect.top}px`;
        this.container.style.left = `${Math.max(16, Math.min(desired, maxLeft))}px`;
      } else {
        this.container.style.top = `${rect.bottom + 8}px`;
        this.container.style.left = `${rect.left}px`;
      }
      this.container.style.transform = '';
    }

    this.container.classList.remove('hidden');
    this.container.style.visibility = 'visible';
    this.container.style.display = '';

    // Keep the triggering nav row highlighted while this flyout is open.
    this.button?.classList.add('logo-nav-active');

    this.container.style.padding = '16px';

    // Constant height, capped only by the visible-viewport space below the
    // panel's top edge (getVisibleBottom = the sanctioned visualViewport
    // accessor — innerHeight lies on mobile; see utilities/viewportMetrics).
    const topPx = parseFloat(this.container.style.top) || 15;
    const targetH = Math.min(PANEL_HEIGHT, Math.max(200, getVisibleBottom() - topPx - 16));

    // State flips SYNCHRONOUSLY (not in the rAF): the sibling flyouts'
    // one-flyout-at-a-time cross-close checks `isOpen` the moment they open —
    // an rAF-deferred flip left a 1-frame race where this panel dodged the
    // cross-close and then re-activated the shared #user-overlay OVER the
    // page (a stale overlay that swallowed every click).
    this.isOpen = true;
    (window as any).activeContainer = this.container.id;
    this.updateState();
    this._engageFocusTrap(); // base ContainerManager: Tab trap + Escape + focus restore

    requestAnimationFrame(() => {
      if (this.animationType !== 'open') return; // a close interrupted before this frame
      this.container.style.width = `${PANEL_WIDTH}px`;
      this.container.style.height = `${targetH}px`;
      this.container.style.opacity = '1';

      // animationType-guarded: if a close interrupts this open, the close owns
      // isAnimating — an unguarded stale {once} listener firing on the CLOSE
      // transition's end would clear it mid-close and skip the close's own
      // guarded finish (the stuck-visible-sheet Escape race).
      this.container.addEventListener('transitionend', () => {
        if (this.animationType === 'open') this.isAnimating = false;
      }, { once: true });

      // Fallback timeout
      setTimeout(() => {
        if (this.isAnimating && this.animationType === 'open') this.isAnimating = false;
      }, 1000);
    });
  }

  /**
   * Mobile: full-width bottom sheet (the settings-container visual idiom),
   * with keyboard-aware positioning owned HERE — keyboardManager exists only
   * on reader pages and only moves the three `.visible` toolbars, so the
   * sheet stamps its own `top` from the visual viewport. `bottom: 0` would
   * NOT work: iOS pans the layout viewport when the keyboard opens
   * (vv.offsetTop > 0), sinking bottom-anchored elements under the keyboard;
   * `top = getVisibleBottom() - height` tracks it correctly.
   */
  openAsSheet() {
    const style = this.container.style;
    // The .openbook-sheet class transition (transform/opacity) owns enter/exit
    // on mobile — the inline width/height transition must not fight it.
    style.transition = 'none';
    this.container.classList.add('openbook-sheet');

    const visibleBottom = getVisibleBottom();
    this._sheetHeight = Math.min(PANEL_HEIGHT, visibleBottom - 80);
    style.left = '0';
    style.right = '0';
    style.width = '100%';
    style.maxWidth = '100%';
    style.height = `${this._sheetHeight}px`;
    style.top = `${visibleBottom - this._sheetHeight}px`;
    style.padding = '16px';
    style.opacity = ''; // the sheet class owns opacity (0 → .sheet-open 1)
    style.transform = '';

    this.container.classList.remove('hidden');
    style.visibility = 'visible';
    style.display = '';
    this.button?.classList.add('logo-nav-active');

    // Commit the geometry untransitioned, then hand transition control to the
    // .openbook-sheet class (an inline `transition` would override it and kill
    // the slide-up). top/height stay OUTSIDE the class transition list, so the
    // keyboard handler's re-top below is always instant.
    void this.container.offsetHeight;
    style.transition = '';

    // Track the visual viewport while open: when the phone keyboard opens,
    // re-top the sheet so the search row sits directly above it (shrinking if
    // the remaining space is tight); restores itself when the keyboard closes.
    // Reapplied on both `resize` and `scroll` — iOS moves offsetTop via both.
    this._sheetViewportHandler = () => {
      if (!this.isOpen || !this._isSheet) return;
      const bottom = getVisibleBottom();
      const h = Math.min(this._sheetHeight, Math.max(160, bottom - 24));
      this.container.style.height = `${h}px`;
      this.container.style.top = `${bottom - h}px`;
    };
    const vv = window.visualViewport;
    if (vv) {
      vv.addEventListener('resize', this._sheetViewportHandler);
      vv.addEventListener('scroll', this._sheetViewportHandler);
    }

    // Synchronous state flip — same cross-close race rationale as the
    // desktop path (a deferred flip could re-activate the shared overlay
    // after an interrupting close).
    this.isOpen = true;
    (window as any).activeContainer = this.container.id;
    this.updateState();
    this._engageFocusTrap(); // focuses the CONTAINER, so the keyboard only opens when the user taps the field

    requestAnimationFrame(() => {
      if (this.animationType !== 'open') return; // a close interrupted before this frame
      this.container.classList.add('sheet-open');

      // animationType-guarded — see openContainer: an unguarded stale open
      // listener consumed by an interrupting close's transitionend cleared
      // isAnimating before the close's guarded _finishSheetClose could run,
      // leaving the sheet visually gone but never .hidden / reset.
      this.container.addEventListener('transitionend', () => {
        if (this.animationType === 'open') this.isAnimating = false;
      }, { once: true });
      setTimeout(() => {
        if (this.isAnimating && this.animationType === 'open') this.isAnimating = false;
      }, 1000);
    });
  }

  _detachSheetViewportHandler() {
    if (!this._sheetViewportHandler) return;
    const vv = window.visualViewport;
    if (vv) {
      vv.removeEventListener('resize', this._sheetViewportHandler);
      vv.removeEventListener('scroll', this._sheetViewportHandler);
    }
    this._sheetViewportHandler = null;
  }

  /** Post-slide-out cleanup: back to the closed FLYOUT baseline so a later
   *  open (possibly at desktop width after rotation) starts clean. */
  _finishSheetClose() {
    this.container.classList.add('hidden');
    this.container.style.visibility = 'hidden';
    this.container.classList.remove('openbook-sheet', 'sheet-open');
    const style = this.container.style;
    style.top = '';
    style.left = '';
    style.right = '';
    style.maxWidth = '';
    this.setupStyles(); // restores the closed baseline incl. the inline transition
    this._isSheet = false;
    this.isAnimating = false;
  }

  closeContainer() {
    // A running CLOSE is left to finish; an in-flight OPEN is interrupted so
    // the close takes over (same semantics as the sibling flyouts).
    if (this.isAnimating && this.animationType === 'close') return;
    this.isAnimating = true;
    this.animationType = 'close';

    this._detachSheetViewportHandler();
    this.button?.classList.remove('logo-nav-active');

    this.isOpen = false;
    (window as any).activeContainer = 'main-content';
    this.updateState();
    this._releaseFocusTrap();

    if (this._isSheet) {
      // Slide the sheet out via the class transition, then reset to the
      // flyout's closed baseline.
      this.container.classList.remove('sheet-open');
      this.container.addEventListener('transitionend', () => {
        if (this.animationType === 'close' && this.isAnimating) this._finishSheetClose();
      }, { once: true });
      setTimeout(() => {
        if (this.animationType === 'close' && this.isAnimating) this._finishSheetClose();
      }, 500);
      return;
    }

    this.container.style.padding = '0';
    this.container.style.width = '0';
    this.container.style.height = '0';
    this.container.style.opacity = '0';

    // Mirror-image guard: if an OPEN interrupts this close, this stale {once}
    // listener fires on the open transition's end and must not slam .hidden
    // onto the now-open panel.
    this.container.addEventListener('transitionend', () => {
      if (this.animationType !== 'close') return;
      this.container.classList.add('hidden');
      this.container.style.visibility = 'hidden';
      this.isAnimating = false;
    }, { once: true });
    // Backstop (same as the sheet branch): a missed transitionend must not
    // leave isAnimating stuck true, which would block every future toggle.
    setTimeout(() => {
      if (this.animationType === 'close' && this.isAnimating) {
        this.container.classList.add('hidden');
        this.container.style.visibility = 'hidden';
        this.isAnimating = false;
      }
    }, 500);
  }

  destroy() {
    this._detachSheetViewportHandler();
    document.getElementById('openbook-search-results')
      ?.removeEventListener('click', this._resultsClickHandler);
    document.getElementById('openbook-search-input')
      ?.removeEventListener('input', this._inputHandler);
    this._resultsClickHandler = null;
    this._inputHandler = null;
    // Base destroy: removes container/overlay/button listeners and deletes
    // this container's handler key off the SHARED #user-overlay.
    super.destroy();
  }
}
