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
    try {
      const resp = await fetch(
        `/api/archive-export/${encodeURIComponent(scope.scopeType)}/${encodeURIComponent(scope.scopeId)}/panel`,
        { credentials: 'include' },
      );
      if (!resp.ok) throw new Error(`panel ${resp.status}`);
      const data = (await resp.json()) as ArchivePanelData;
      html = await buildArchiveHtml(data);
    } catch (e) {
      log.error('archive panel load failed', '/components/archivePanel', e);
      html = '<div class="scroller" id="archive-content"><p class="citation">This archive could not be loaded.</p></div>';
    }

    // Base openContainer sets the content, .open/.hidden classes, overlay,
    // activeContainer and the focus trap.
    super.openContainer(html as any);

    this.mdDownload = initExportDownload(this.container, 'download-archive-md', scope, 'markdown');
    this.sqliteDownload = initExportDownload(this.container, 'download-archive-sqlite', scope, 'sqlite');
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
