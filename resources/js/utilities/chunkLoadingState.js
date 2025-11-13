// chunkLoadingState.js
import { verbose } from './logger.js';

let chunkLoadingInProgress = false;
let chunkLoadingChunkId = null;

export function setChunkLoadingInProgress(chunkId) {
  verbose.content(`Chunk loading started: ${chunkId}`, '/utilities/chunkLoadingState.js');
  chunkLoadingInProgress = true;
  chunkLoadingChunkId = chunkId;
}

export function clearChunkLoadingInProgress(chunkId) {
  verbose.content(`Chunk loading completed: ${chunkId}`, '/utilities/chunkLoadingState.js');
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
function scheduleAutoClear(chunkId, timeout = 1000) {
  setTimeout(() => {
    if (chunkLoadingChunkId === chunkId) {
      console.warn(`⚠️ Auto-clearing chunk loading state for chunk ${chunkId} after timeout`);
      clearChunkLoadingInProgress(chunkId);
    }
  }, timeout);
}

export { scheduleAutoClear };
