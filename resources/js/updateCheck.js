
import {
  book,
  mainContentDiv
} from './reader-DOMContentLoaded.js';

export async function fetchLatestUpdateInfo(book) {
  const response = await fetch(`/markdown/${book}/latest_update.json?v=${Date.now()}`);
  if (!response.ok) {
    console.warn("⚠️ Could not fetch latest update info.");
    return null;
  }
  return response.json();
}

export function handleTimestampComparison(serverTimestamp, cachedServerTimestamp) {
  const oldTimestamp = Number(cachedServerTimestamp);
  const newTimestamp = Number(serverTimestamp);
  console.log(`🔍 COMPARING TIMESTAMPS -> cached: ${oldTimestamp}, server: ${newTimestamp}`);
  return oldTimestamp !== newTimestamp;
}
