// chunkLoadingState.js
import { verbose } from '../../utilities/logger';

let chunkLoadingInProgress = false;
let chunkLoadingChunkId: any = null;

export function setChunkLoadingInProgress(chunkId?: any) {
  verbose.content(`Chunk loading started: ${chunkId}`, '/lazyLoader/utilities/chunkLoadingState.ts');
  chunkLoadingInProgress = true;
  chunkLoadingChunkId = chunkId;
}

export function clearChunkLoadingInProgress(chunkId?: any) {
  verbose.content(`Chunk loading completed: ${chunkId}`, '/lazyLoader/utilities/chunkLoadingState.ts');
  chunkLoadingInProgress = false;
  chunkLoadingChunkId = null;
}

export function isChunkLoadingInProgress() {
  return chunkLoadingInProgress;
}

export function getLoadingChunkId() {
  return chunkLoadingChunkId;
}

// Auto-clear after a timeout as a safety net
function scheduleAutoClear(chunkId: any, timeout = 1000) {
  setTimeout(() => {
    if (chunkLoadingChunkId === chunkId) {
      console.warn(`⚠️ Auto-clearing chunk loading state for chunk ${chunkId} after timeout`);
      clearChunkLoadingInProgress(chunkId);
    }
  }, timeout);
}

export { scheduleAutoClear };
