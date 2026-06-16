/**
 * navigationRegistry — zero-import DI leaf for SPA navigation.
 *
 * Features (newbookContainer, userContainer, viewManager, reconvert, …) used to
 * dynamic-import the heavy navigation orchestrator (NavigationManager /
 * LinkNavigationHandler / ImportBookTransition) just to TRIGGER navigation. But those
 * orchestrators statically import back into the same feature/components cluster, so each
 * such dynamic import is a cycle-masking "breaker" edge (see visualisation import-lens).
 *
 * Instead: the orchestrators REGISTER their entry points into this leaf at module-load;
 * features statically import the delegators below and call them. The leaf has zero imports,
 * so feature→leaf is one-way (no cycle). Backed by globalThis so registration survives
 * code-split chunk boundaries. Mirrors utilities/linkClickRegistry + hyperlitContainer/
 * containerActions.
 *
 * Registration is triggered at reader boot: pageLoad/readerEntry loads NavigationManager
 * (existing 'fresh-page-load' call) + fire-and-forget loads LinkNavigationHandler and
 * ImportBookTransition — each lands as a code-split 'lazy' edge (none statically reaches
 * readerEntry), so loading them registers their impls before any feature invokes the leaf.
 */

const KEY = '__hyperlitNavRegistry';

interface NavActions {
  navigate: (pathway: any, options?: any) => Promise<any>;
  navigateByStructure: (options?: any) => Promise<any>;
  attachGlobalLinkClickHandler: () => any;
  removeGlobalHandlers: () => any;
  pollImportProgress: (bookId: any, progressUI: any) => Promise<any>;
  showFootnoteAuditModal: (audit: any, bookId: any, options?: any) => any;
}

function impl(): Partial<NavActions> {
  return ((globalThis as any)[KEY] = (globalThis as any)[KEY] || {});
}

/** Register navigation entry points (called by the orchestrators at module-load). */
export function registerNavActions(actions: Partial<NavActions>): void {
  Object.assign(impl(), actions);
}

function warnUnregistered(name: string): void {
  console.warn(`navigationRegistry: ${name} called before its impl was registered — navigation no-op`);
}

export function navigate(pathway: any, options: any = {}): Promise<any> {
  const fn = impl().navigate;
  if (!fn) { warnUnregistered('navigate'); return Promise.resolve(); }
  return fn(pathway, options);
}

export function navigateByStructure(options: any = {}): Promise<any> {
  const fn = impl().navigateByStructure;
  if (!fn) { warnUnregistered('navigateByStructure'); return Promise.resolve(); }
  return fn(options);
}

export function attachGlobalLinkClickHandler(): any {
  const fn = impl().attachGlobalLinkClickHandler;
  if (!fn) { warnUnregistered('attachGlobalLinkClickHandler'); return; }
  return fn();
}

export function removeGlobalHandlers(): any {
  const fn = impl().removeGlobalHandlers;
  if (!fn) { warnUnregistered('removeGlobalHandlers'); return; }
  return fn();
}

export function pollImportProgress(bookId: any, progressUI: any): Promise<any> {
  const fn = impl().pollImportProgress;
  if (!fn) { warnUnregistered('pollImportProgress'); return Promise.resolve(null); }
  return fn(bookId, progressUI);
}

export function showFootnoteAuditModal(audit: any, bookId: any, options: any = {}): any {
  const fn = impl().showFootnoteAuditModal;
  if (!fn) { warnUnregistered('showFootnoteAuditModal'); return; }
  return fn(audit, bookId, options);
}
