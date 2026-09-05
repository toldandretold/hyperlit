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
import { loadRecentBooks, renderRecentList } from './recentBooks';

const PANEL_WIDTH = 280;
// Fixed height (only the viewport caps it): a constant, decent-sized panel
// regardless of how many recents are cached, so search results always have
// room and the frame never resizes — content areas flex and scroll inside it
// (with a visible scrollbar when there's more, see openbookContainer.css).
const PANEL_HEIGHT = 420;

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
    const records = await loadRecentBooks();
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

    // Constant height, capped only by the viewport space below the panel's
    // top edge (measured from window.innerHeight, not 100vh).
    const topPx = parseFloat(this.container.style.top) || 15;
    const targetH = Math.min(PANEL_HEIGHT, Math.max(200, window.innerHeight - topPx - 16));

    requestAnimationFrame(() => {
      this.container.style.width = `${PANEL_WIDTH}px`;
      this.container.style.height = `${targetH}px`;
      this.container.style.opacity = '1';

      this.isOpen = true;
      (window as any).activeContainer = this.container.id;
      this.updateState();
      this._engageFocusTrap(); // base ContainerManager: Tab trap + Escape + focus restore

      this.container.addEventListener('transitionend', () => {
        this.isAnimating = false;
      }, { once: true });

      // Fallback timeout
      setTimeout(() => {
        if (this.isAnimating) this.isAnimating = false;
      }, 1000);
    });
  }

  closeContainer() {
    // A running CLOSE is left to finish; an in-flight OPEN is interrupted so
    // the close takes over (same semantics as the sibling flyouts).
    if (this.isAnimating && this.animationType === 'close') return;
    this.isAnimating = true;
    this.animationType = 'close';

    this.container.style.padding = '0';
    this.container.style.width = '0';
    this.container.style.height = '0';
    this.container.style.opacity = '0';

    this.button?.classList.remove('logo-nav-active');

    this.isOpen = false;
    (window as any).activeContainer = 'main-content';
    this.updateState();
    this._releaseFocusTrap();

    this.container.addEventListener('transitionend', () => {
      this.container.classList.add('hidden');
      this.container.style.visibility = 'hidden';
      this.isAnimating = false;
    }, { once: true });
  }

  destroy() {
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
