// Shared reference to the single TocContainerManager instance (leaf — no imports).
// The button folder (tocToggleButton) creates/clears it; the container's standalone
// functions (attachTocClickHandler, etc.) read it via getTocManager() — so neither
// folder needs to import the other (no button↔container cycle).
let mgr: any = null;
export const getTocManager = (): any => mgr;
export const setTocManager = (m: any): void => { mgr = m; };
