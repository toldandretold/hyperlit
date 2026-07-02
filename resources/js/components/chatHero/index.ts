/**
 * Chat-homepage hero behavior (/chat experimental homepage).
 *
 * The chat page renders the logo + search + arranger buttons as a centered
 * glass card over the lava-lamp background. The hero rises to the top
 * (`content-active` on #app-container, transition in resources/css/chat.css)
 * whenever library content is showing.
 *
 * State is DERIVED from the DOM, not just from clicks: homepageDisplayUnit
 * restores the last-viewed tab from localStorage on reload (and SPA returns
 * rebuild .main-content), so "content is present OR a tab is active" must
 * mean risen — otherwise the centered hero overlaps the restored cards.
 *
 * No-ops unless #app-container.chat-page exists, so it is inert on the
 * normal homepage even though it registers for pages: ['home'].
 */

let clickHandler: ((e: Event) => void) | null = null;
let observer: MutationObserver | null = null;

function syncHeroState(): void {
  const page = document.querySelector<HTMLElement>('#app-container.chat-page');
  if (!page) return;
  const hasContent = !!document.querySelector('.home-content-wrapper .main-content');
  const hasActiveTab = !!page.querySelector('.arranger-button.active');
  if (hasContent || hasActiveTab) {
    page.classList.add('content-active');
    // risen is terminal for this page-view; stop watching
    observer?.disconnect();
    observer = null;
  }
}

export function initChatHero(): void {
  const page = document.querySelector<HTMLElement>('#app-container.chat-page');
  if (!page) return;
  if (clickHandler) { syncHeroState(); return; } // create-once + re-sync on SPA re-init

  // instant rise on press (before the fetch lands)
  clickHandler = (e: Event) => {
    const target = e.target instanceof Element ? e.target : null;
    if (!target?.closest('.arranger-button')) return;
    document.querySelector('#app-container.chat-page')?.classList.add('content-active');
  };
  // capture phase: runs regardless of what homepageDisplayUnit's handler does
  document.addEventListener('click', clickHandler, true);

  // catches the restore paths: localStorage tab restore on reload, SPA returns
  observer = new MutationObserver(() => syncHeroState());
  observer.observe(document.body, { childList: true, subtree: true });

  syncHeroState();
}

export function destroyChatHero(): void {
  if (clickHandler) document.removeEventListener('click', clickHandler, true);
  clickHandler = null;
  observer?.disconnect();
  observer = null;
}
