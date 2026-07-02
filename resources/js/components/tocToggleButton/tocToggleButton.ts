// The #toc-toggle-button trigger: ButtonRegistry lifecycle for the TOC. Creates /
// rebinds the singleton TocContainerManager (whose base ContainerManager wires the
// #toc-toggle-button click → toggleContainer) and stores it in the shared ref leaf.
// The panel + all TOC logic live in ../tocContainer; this is the thin button entry,
// registered as the 'toc' component in registerComponents.ts.
import { TocContainerManager, invalidateTocCache } from "../tocContainer/index";
import { getTocManager, setTocManager } from "../tocContainer/managerRef";
import { verbose } from "../../utilities/logger";

export function initializeTocManager() {
  if (!document.getElementById("toc-toggle-button")) {
    return;
  }

  if (!getTocManager()) {
    setTocManager(new TocContainerManager(
      "toc-container",
      "toc-overlay",
      "toc-toggle-button",
      ["main-content"]
    ));
    verbose.init('TOC Manager initialized', '/components/tocToggleButton/tocToggleButton.ts');
  } else {
    getTocManager().rebindElements();
  }
}

/** Destroy function for cleanup during navigation */
export function destroyTocManager() {
  const mgr = getTocManager();
  if (mgr) {
    mgr.destroy();
    setTocManager(null);
    // Clear TOC cache as well
    invalidateTocCache();
    return true;
  }
  return false;
}

/** Opens the TOC using the container manager. */
export function openTOC() {
  getTocManager()?.openContainer();
}

/** Closes the TOC using the container manager. */
export function closeTOC() {
  getTocManager()?.closeContainer();
}

/** Toggles the TOC using the container manager. */
export function toggleTOC() {
  getTocManager()?.toggleContainer();
}
