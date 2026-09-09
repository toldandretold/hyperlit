// The #archiveRef trigger button: attaches / detaches the click listener that
// toggles the archive panel. The panel itself (and its singleton manager)
// lives in ./index; this module only owns the button → open/close wiring,
// registered with ButtonRegistry as the 'archivePanel' component. Mirrors
// cloudRefButton.ts, including its teardown lesson: a force-closed panel must
// clear the overlay's .active or a stale full-screen overlay blocks scroll.

import archivePanelManager from './index';
import { verbose } from '../../utilities/logger';

let archiveClickHandler: ((e: Event) => void) | null = null;

export function initializeArchivePanelListener(): void {
  archivePanelManager.rebindElements();

  const button = document.getElementById('archiveRef');
  if (!button) {
    // Not an error: the component is registered for whole page types, but a
    // page can render without the button (defensive).
    return;
  }

  if (button.dataset.archiveListenerAttached) {
    return;
  }

  archiveClickHandler = (e: Event) => {
    e.preventDefault();
    void archivePanelManager.toggleContainer();
  };

  button.addEventListener('click', archiveClickHandler);
  button.dataset.archiveListenerAttached = 'true';
  verbose.init('Archive panel button listener attached', '/components/archivePanel/archiveRefButton.ts');
}

export function destroyArchivePanelListener(): void {
  archivePanelManager.destroyDownloads(); // stop polls even if mid-open
  if (archivePanelManager.isOpen && archivePanelManager.container) {
    archivePanelManager.isOpen = false;
    (window as any).activeContainer = 'main-content';
    // updateState() (isOpen=false) removes .open, clears the overlay's
    // .active and unfreezes elements — hand-toggling classes here would miss
    // the overlay (the sourceButton teardown bug).
    archivePanelManager.updateState();
    archivePanelManager.container.classList.add('hidden');
    archivePanelManager._releaseFocusTrap();
  }

  const button = document.getElementById('archiveRef');
  if (button && archiveClickHandler) {
    button.removeEventListener('click', archiveClickHandler);
  }
  archiveClickHandler = null;
  if (button) {
    delete button.dataset.archiveListenerAttached;
  }
}
