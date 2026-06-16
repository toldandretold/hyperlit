// hyperlitContainer/subBookActions.ts — zero-import DI leaf.
// subBookLoader registers its sub-book STATE fns here at load; the container modules
// (core/index/history/stack) call these delegators instead of dynamic-importing the heavy
// subBookLoader — which statically reaches back through the lazyLoader engine into the
// container (an import cycle). No-ops until a sub-book has actually loaded subBookLoader.
interface SubBookActions {
  saveSubBookState: () => any;
  restoreSubBookState: (saved: any) => void;
  resetSubBookState: () => void;
  destroySubBook: (id: any) => void;
  destroyAllSubBooks: () => void;
}
const impl: Partial<SubBookActions> = {};
export function registerSubBookActions(a: Partial<SubBookActions>): void { Object.assign(impl, a); }
export const saveSubBookState = (): any => (impl.saveSubBookState ? impl.saveSubBookState() : new Map());
export const restoreSubBookState = (saved: any): void => { impl.restoreSubBookState?.(saved); };
export const resetSubBookState = (): void => { impl.resetSubBookState?.(); };
export const destroySubBook = (id: any): void => { impl.destroySubBook?.(id); };
export const destroyAllSubBooks = (): void => { impl.destroyAllSubBooks?.(); };
