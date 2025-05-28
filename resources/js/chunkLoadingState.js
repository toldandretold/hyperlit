// chunkLoadingState.js
let chunkLoadingInProgress = false;
let chunkLoadingChunkId = null;

export function setChunkLoadingInProgress(chunkId) {
  console.log(`🔄 Setting chunk loading in progress for chunk ${chunkId}`);
  chunkLoadingInProgress = true;
  chunkLoadingChunkId = chunkId;
}

export function clearChunkLoadingInProgress(chunkId) {
  console.log(`✅ Clearing chunk loading in progress for chunk ${chunkId}`);
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
