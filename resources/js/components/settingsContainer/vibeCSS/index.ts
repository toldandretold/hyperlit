// VibeCSS public barrel — the entry point external callers import
// (utilities/themeSwitcher, SPA/viewManager, settingsContainer/vibe). Re-exports
// the storage/injection surface + the two settings-panel UIs. Split internally
// into storage / api / galleryUI / inputUI to stay acyclic (UI modules import
// the leaves, never this barrel).
export {
  applyVibeCSS, removeVibeCSS, clearVibeCSS, getVibeCSS, hasVibeCSS, getVibePrompt,
  VIBE_STORAGE_KEY, VIBE_PROMPT_KEY, VIBE_META_KEY,
} from './storage';
export { showVibeGallery } from './galleryUI';
export { showVibeInput, showTopUpUI } from './inputUI';
