// pageLoad/progress.ts — zero-import leaf (the ProgressOverlayConductor import is deferred).
// Legacy page-load progress shims, extracted from readerEntry so loadHyperText can use them
// without importing the bootstrap entry (which pulls the whole reader graph into a cycle).
export async function updatePageLoadProgress(percent: number, message: any = null) {
  const { ProgressOverlayConductor } = await import('../SPA/navigation/ProgressOverlayConductor.js');
  ProgressOverlayConductor.updateProgress(percent, message);
}
export async function hidePageLoadProgress() {
  const { ProgressOverlayConductor } = await import('../SPA/navigation/ProgressOverlayConductor.js');
  return await ProgressOverlayConductor.hide();
}
