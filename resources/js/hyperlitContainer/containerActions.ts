/**
 * Container action registry — a zero-import leaf (the initXDependencies/DI idiom).
 *
 * Feature modules (hypercites, hyperlights) need to drive the hyperlit container: open/close it,
 * route a click through it, run hypercite health/delete, etc. Previously they imported UP into
 * `hyperlitContainer/*` to do so — a dependency pointing the wrong way that, combined with the
 * orchestrator importing back into the features, formed a cycle held apart by `await import()`.
 *
 * Inversion: the orchestrator registers its actions here at load (`registerContainerActions`);
 * features call the delegators below, importing only this leaf — never `hyperlitContainer/*`.
 * The delegator names + signatures mirror the orchestrator symbols, so feature call-sites are
 * unchanged (only the import source moves).
 *
 * Registration runs at bootstrap (footnotesCitations.js statically imports hyperlitContainer/index),
 * before any feature *calls* an action (all in event handlers / view transitions). The defensive
 * defaults below only matter if that invariant is ever broken.
 */

interface ContainerActions {
  openHyperlitContainer: (content: any, isBackNavigation?: boolean) => void;
  closeHyperlitContainer: (silent?: boolean, skipPrepare?: boolean) => Promise<void>;
  initializeHyperlitManager: () => void;
  getCurrentContainer: () => any;
  isStackPopping: () => boolean;
  handleUnifiedContentClick: (...args: any[]) => Promise<any>;
  handleHyperciteHealthCheck: (...args: any[]) => any;
  handleHyperciteDelete: (...args: any[]) => any;
  /** Open a highlight's container by id (a hyperlights action; registered by viewManager at bootstrap). */
  openHighlightById: (...args: any[]) => any;
}

const impl: Partial<ContainerActions> = {};

/** Called once by hyperlitContainer/index at module load to wire the real implementations. */
export function registerContainerActions(actions: Partial<ContainerActions>): void {
  Object.assign(impl, actions);
}

const unregistered = (name: string) => {
  console.warn(`[containerActions] ${name} called before the hyperlit container registered — no-op`);
};

// Delegators — same names/signatures as the orchestrator symbols they replace.
export const openHyperlitContainer = (content: any, isBackNavigation?: boolean): void =>
  impl.openHyperlitContainer ? impl.openHyperlitContainer(content, isBackNavigation) : unregistered('openHyperlitContainer');

export const closeHyperlitContainer = (silent?: boolean, skipPrepare?: boolean): Promise<void> =>
  impl.closeHyperlitContainer ? impl.closeHyperlitContainer(silent, skipPrepare) : (unregistered('closeHyperlitContainer'), Promise.resolve());

export const initializeHyperlitManager = (): void =>
  impl.initializeHyperlitManager ? impl.initializeHyperlitManager() : unregistered('initializeHyperlitManager');

export const getCurrentContainer = (): any =>
  impl.getCurrentContainer ? impl.getCurrentContainer() : null;

export const isStackPopping = (): boolean =>
  impl.isStackPopping ? impl.isStackPopping() : false;

export const handleUnifiedContentClick = (...args: any[]): Promise<any> =>
  impl.handleUnifiedContentClick ? impl.handleUnifiedContentClick(...args) : (unregistered('handleUnifiedContentClick'), Promise.resolve());

export const handleHyperciteHealthCheck = (...args: any[]): any =>
  impl.handleHyperciteHealthCheck ? impl.handleHyperciteHealthCheck(...args) : unregistered('handleHyperciteHealthCheck');

export const handleHyperciteDelete = (...args: any[]): any =>
  impl.handleHyperciteDelete ? impl.handleHyperciteDelete(...args) : unregistered('handleHyperciteDelete');

export const openHighlightById = (...args: any[]): any =>
  impl.openHighlightById ? impl.openHighlightById(...args) : unregistered('openHighlightById');
