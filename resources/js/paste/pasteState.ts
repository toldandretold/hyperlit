// Zero-import leaf: the "paste operation in progress" flag.
// Extracted from paste/index so the editor (divEditor/*) can read it WITHOUT importing
// the 809-line paste barrel — which would pull paste→divEditor/pageLoad/hyperlights into a
// static import cycle once the paste/ folder is on the viz graph. (Leaf-state de-cycling.)
export let isPasteOperationInProgress = false;
export function isPasteOperationActive(): boolean { return isPasteOperationInProgress; }
export function setPasteOperationInProgress(v: boolean): void { isPasteOperationInProgress = v; }
