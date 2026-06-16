// pasteSnapshot — zero-import leaf holding the large-paste undo snapshot state.
//
// The snapshot (all nodes before a paste, for undo) lived as module state inside the heavy
// paste/handlers/largePasteHandler. But divEditor/saveQueue and paste/ui/pasteUndoToast only
// need clearPasteSnapshot(), and importing it from largePasteHandler dragged that whole handler
// (→ pageLoad → hyperlights → divEditor) into their import reach — the last dynamic-import
// "breaker" cycle (see visualisation import-lens). Holding the state + accessors in this leaf lets
// those modules clear the snapshot without importing the handler.

export interface PasteSnapshot { bookId: any; allNodes: any[]; }

let lastPasteSnapshot: PasteSnapshot | null = null;

export function getPasteSnapshot(): PasteSnapshot | null { return lastPasteSnapshot; }
export function setPasteSnapshot(snapshot: PasteSnapshot | null): void { lastPasteSnapshot = snapshot; }
export function clearPasteSnapshot(): void { lastPasteSnapshot = null; }
