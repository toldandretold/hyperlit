// The archive panel: the citation/source container for a WHOLE library or
// journal/archive corpus (the top-right #archiveRef button on user, journal
// and archive pages), with the vault/SQLite bulk downloads.
//
// Deliberately a sibling of SourceContainerManager, not a fork: that manager
// is hard-wired to the per-book `book` global (garbage on hero pages — it
// resolves to the username/URL segment) and the `cloudRef` button id its
// singleton binds at import time. This one reads its scope from #archiveRef's
// data-scope-type/-id AT OPEN TIME, so SPA transitions between scopes stay
// correct, and passes buttonId null to the base — the click wiring lives
// solely in archiveRefButton.ts (no double-handler).

import { ContainerManager } from '../utilities/containerManager';
import { buildArchiveHtml, type ArchivePanelData } from './buildArchiveHtml';
import { initExportDownload, type ArchiveScope, type ExportDownloadHandle } from './exportDownload';
import { log } from '../../utilities/logger';

class ArchivePanelManager extends ContainerManager {
  private mdDownload: ExportDownloadHandle | null = null;

  private sqliteDownload: ExportDownloadHandle | null = null;

  constructor() {
    // SHARES #source-overlay (the newbook-container precedent): the base
    // manager's overlay click handler gives click-outside-close, and the
    // overlay's existing CSS/inventory wiring comes for free. Managers on a
    // shared overlay each guard on their own isOpen, so only the open one
    // reacts.
    super('archive-container', 'source-overlay', null, []);
  }

  /** The page's scope, stamped on #archiveRef by the blade. */
  private readScope(): ArchiveScope | null {
    const button = document.getElementById('archiveRef');
    const scopeType = button?.dataset.scopeType;
    const scopeId = button?.dataset.scopeId;
    if (!scopeType || !scopeId) return null;

    return { scopeType, scopeId };
  }

  async openContainer(): Promise<void> {
    if (!this.container || this.isOpen) return;
    const scope = this.readScope();
    if (!scope) return;

    let html: string;
    let data: ArchivePanelData | null = null;
    try {
      const resp = await fetch(
        `/api/archive-export/${encodeURIComponent(scope.scopeType)}/${encodeURIComponent(scope.scopeId)}/panel`,
        { credentials: 'include' },
      );
      if (!resp.ok) throw new Error(`panel ${resp.status}`);
      data = (await resp.json()) as ArchivePanelData;
      html = await buildArchiveHtml(data);
    } catch (e) {
      log.error('archive panel load failed', '/components/archivePanel', e);
      html = '<div class="scroller" id="archive-content"><p class="citation">This archive could not be loaded.</p></div>';
    }

    // Base openContainer sets the content, .open/.hidden classes, overlay,
    // activeContainer and the focus trap.
    super.openContainer(html as any);

    if (data) await this.wireActions(data);

    this.mdDownload = initExportDownload(this.container, 'download-archive-md', scope, 'markdown');
    this.sqliteDownload = initExportDownload(this.container, 'download-archive-sqlite', scope, 'sqlite');
  }

  /**
   * The action bar (buildArchiveHtml's actionBar): Share copies this page's
   * link / the rendered corpus citation; Like likes the corpus's shelf.
   */
  private async wireActions(data: ArchivePanelData): Promise<void> {
    const container = this.container as HTMLElement | null;
    if (!container) return;
    try {
      const pageUrl = data.pageUrl || window.location.href;
      const { wireShareControl } = await import('../sourceContainer/readerActions');
      wireShareControl(container, () => pageUrl, () => {
        const citation = container.querySelector('.citation')?.textContent?.trim();
        return citation ? `${citation}\n${pageUrl}` : '';
      });

      const likeBtn = container.querySelector<HTMLElement>('#like-book');
      if (likeBtn && data.shelfId) {
        const { wireShelfLikeButton } = await import('../shelves/shelfLike');
        wireShelfLikeButton(likeBtn, data.shelfId, data.noun || 'archive');
      }

      // Creator Tools (the shelf's owner only — the server decides, via
      // `curateUrl`): the book panel's collapsible section, same ids and style.
      const toolsToggle = container.querySelector<HTMLElement>('#creator-tools-toggle');
      const toolsContent = container.querySelector<HTMLElement>('#creator-tools-content');
      if (toolsToggle && toolsContent) {
        toolsToggle.addEventListener('click', () => {
          const open = toolsContent.style.display === 'none';
          toolsContent.style.display = open ? 'block' : 'none';
          toolsToggle.classList.toggle('expanded', open);
          toolsToggle.setAttribute('aria-expanded', String(open));
          if (open) toolsContent.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        });
      }

      // The hypercite workbench is a standalone non-SPA page, so it opens in a
      // new tab and the library stays where it was.
      const workbenchBtn = container.querySelector<HTMLElement>('#archive-hypercite-workbench');
      if (workbenchBtn?.dataset.href) {
        const href = workbenchBtn.dataset.href;
        workbenchBtn.addEventListener('click', () => { window.open(href, '_blank', 'noopener'); });
      }

      // Plus (keeper only): a popover in this panel, like Share — Blank or
      // Import. On a journal/archive the book it makes joins this
      // collection's shelf (newBookShelfTarget). Only once a choice is made
      // does the panel close: Blank navigates to the new book, Import hands
      // over to the import form (which lives in the New panel).
      const addControl = container.querySelector<HTMLElement>('#add-control');
      if (addControl) {
        const { wirePanelPopover } = await import('../sourceContainer/readerActions');
        const { setNewBookShelfTarget, clearNewBookShelfTarget } = await import('../../utilities/newBookShelfTarget');
        wirePanelPopover(container, addControl, addControl.querySelector<HTMLElement>('#archive-add-book'), (opt, close) => {
          if (data.addShelfId) setNewBookShelfTarget(data.addShelfId);
          else clearNewBookShelfTarget();
          // Measured BEFORE the panel closes: the import form opens where this
          // panel is (its right edge), not beside the left nav.
          const dockRightPx = Math.max(10, window.innerWidth - container.getBoundingClientRect().right);
          close();
          this.closeContainer();
          if (opt.dataset.add === 'import') {
            const newBook = (window as unknown as { newBookManager?: { dockRightPx: number | null } }).newBookManager;
            if (newBook) newBook.dockRightPx = dockRightPx;
            document.getElementById('importBook')?.click();
            return;
          }
          sessionStorage.removeItem('pending_new_book_encrypted'); // a stale tick must not encrypt this one
          void import('../../SPA/navigation/navigationRegistry')
            .then(({ navigate }) => navigate('create-new-book', { createAndTransition: true }))
            .catch((e) => log.error('new book from the archive panel failed', '/components/archivePanel', e));
        });
      }
    } catch (e) {
      log.error('archive panel actions failed to wire', '/components/archivePanel', e);
    }
  }

  closeContainer(): void {
    if (!this.container || !this.isOpen) return;
    this.destroyDownloads(); // poll timers must not outlive the panel
    super.closeContainer();
  }

  destroyDownloads(): void {
    this.mdDownload?.destroy();
    this.mdDownload = null;
    this.sqliteDownload?.destroy();
    this.sqliteDownload = null;
  }
}

// One instance, created at import time like the other container singletons.
const archivePanelManager = new ArchivePanelManager();
export default archivePanelManager;
