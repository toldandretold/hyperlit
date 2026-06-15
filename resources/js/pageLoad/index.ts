/**
 * pageLoad — the backend→DOM bootstrap layer (formerly the top-level
 * initializePage.js / readerDOMContentLoaded.js / initialChunkLoader.js /
 * backgroundDownloader.js files).
 *
 * Barrel re-exporting the public surface. Decomposed into:
 *   firstChunkPromise (leaf) · lazyLoaderRegistry · onlineRetry · accessGuards ·
 *   containerChain · initialChunk · backgroundDownload · loadHyperText · readerEntry.
 *
 * Live-binding re-exports (currentLazyLoader, pendingFirstChunkLoadedPromise,
 * pendingContainerRestorePromise) use ESM `export { x } from` so reassignments
 * inside their owning modules stay visible to importers.
 */

// firstChunkPromise
export { pendingFirstChunkLoadedPromise, resolveFirstChunkPromise } from './firstChunkPromise';

// lazyLoaderRegistry
export {
  lazyLoaders,
  currentLazyLoader,
  pendingContainerRestorePromise,
  resetCurrentLazyLoader,
  initializeMainLazyLoader,
  initializeLazyLoaderForContainer,
} from './lazyLoaderRegistry';

// onlineRetry
export { setupOnlineSyncListener, cleanupOnlineSyncListener } from './onlineRetry';

// loadHyperText
export { loadFromJSONFiles, loadHyperText } from './loadHyperText';

// containerChain
export { buildChainFromUrl, openContainerChain } from './containerChain';

// accessGuards
export { handlePrivateBookAccessDenied, handleDeletedBookAccess } from './accessGuards';

// readerEntry (progress)
export { updatePageLoadProgress, hidePageLoadProgress } from './readerEntry';

// initialChunk
export { fetchInitialChunk, resolveBootstrapTarget } from './initialChunk';

// backgroundDownload
export { backgroundDownloadRemainingChunks, waitForBackgroundDownload } from './backgroundDownload';
