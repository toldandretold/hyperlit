// The #openBookButton trigger: ButtonRegistry lifecycle for the "Open" flyout
// (recents + library search). Creates / rebinds the singleton
// OpenBookContainerManager (whose base ContainerManager wires the button
// click → toggleContainer) and the flyout's searchBox instance. Registered as
// 'openBookContainer' in registerComponents.ts. Exposes the singleton on
// window.openBookManager (read by logoNav's close + the sibling flyouts'
// one-flyout-at-a-time cross-close) — assigned INSIDE the init fn only.
import { OpenBookContainerManager } from '../openbookContainer/index';
import { initializeOpenbookSearch, destroyOpenbookSearch } from '../openbookContainer/openbookSearch';
import { verbose } from '../../utilities/logger';

let openBookManager: any = null;

export function initializeOpenBookContainer() {
  if (!document.getElementById('openBookButton')) {
    verbose.init('Open book button not found, skipping initialization', '/components/openbookButton/openbookButton.ts');
    return null;
  }

  if (!openBookManager) {
    openBookManager = new OpenBookContainerManager(
      'openbook-container',
      'user-overlay', // shared overlay — handlers are anchored per-containerId
      'openBookButton',
      ['main-content'],
    );
    verbose.init('Open book container manager created', '/components/openbookButton/openbookButton.ts');
  } else {
    openBookManager.button = document.getElementById('openBookButton');
    openBookManager.rebindElements();
    openBookManager.setupStyles();
    openBookManager.setupPanelListeners();
    verbose.init('Open book container manager updated', '/components/openbookButton/openbookButton.ts');
  }

  initializeOpenbookSearch();
  (window as any).openBookManager = openBookManager;
  return openBookManager;
}

export function destroyOpenBookContainer() {
  destroyOpenbookSearch();
  if (openBookManager) {
    if (openBookManager.isOpen) {
      openBookManager.closeContainer();
    }
    openBookManager.destroy();
    openBookManager = null;
    if ((window as any).openBookManager) (window as any).openBookManager = null;
    return true;
  }
  return false;
}
