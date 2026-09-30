/**
 * Shelf tab routing — the ONE decision table for how an `.arranger-button`
 * with `data-filter="shelf"` and (possibly) an empty `data-content` resolves
 * to a rendered shelf feed. Both homepageDisplayUnit call sites (the click
 * handler and the boot/restore path) consult this instead of inlining the
 * branch, because the two copies drifting apart is exactly how the owner's
 * visitor-shelf pills went dead: the inline guard only resolved empty
 * `data-content` for journals and non-owner visitors, so the OWNER fell
 * through to the generic path and loaded `''` as a book id.
 *
 * Invariants encoded here (do not weaken without reading both call sites):
 * - Journal/archive pages (`body[data-page="journal"]`) are isOwner-BLIND:
 *   `window.isOwner` is stamped by the user page and leaks across SPA body
 *   swaps, and a journal feed is a public shelf where owner-ness is
 *   irrelevant anyway. They always resolve via the public endpoint.
 * - On the user page, the OWNER resolves via the authed owner endpoint
 *   (`/api/shelves/{id}/render`, same as shelfTabs.activateTab) so a
 *   server-rendered pill and a dynamic tab for the same shelf mint the SAME
 *   content id (`shelf_{id}_{sort}`, no `_pub` suffix) and get the owner
 *   shelf header.
 * - Anything else (non-shelf filter, or a shelf filter on a page that is
 *   neither journal nor user) takes the generic data-content path.
 *
 * Pure data-in/data-out — no DOM, no globals — so the vitest guardrail
 * (tests/javascript/homepage/shelfTabRouting.test.js) pins every branch.
 */

export type ShelfClickMode = 'owner-shelf' | 'public-shelf' | 'generic';

export interface ShelfClickContext {
  /** the button's data-filter */
  filter: string | undefined;
  /** document.body.dataset.page */
  page: string | undefined;
  /** window.isOwner (user-page global; leaks across SPA swaps — see above) */
  isOwner: boolean;
  /** window.isUserPage */
  isUserPage: boolean;
}

export function resolveShelfClickMode(ctx: ShelfClickContext): ShelfClickMode {
  if (ctx.filter !== 'shelf') return 'generic';
  if (ctx.page === 'journal') return 'public-shelf';
  if (!ctx.isUserPage) return 'generic';
  return ctx.isOwner ? 'owner-shelf' : 'public-shelf';
}

export function shelfRenderUrl(mode: ShelfClickMode, shelfId: string, sort: string): string | null {
  if (mode === 'generic') return null;
  const id = encodeURIComponent(shelfId);
  const s = encodeURIComponent(sort);
  return mode === 'owner-shelf'
    ? `/api/shelves/${id}/render?sort=${s}`
    : `/api/public/shelves/${id}/render?sort=${s}`;
}

/**
 * Guard for the tab-persistence writes (localStorage `homepage_active_button`,
 * history.state.userPageActiveTab). An empty content id must never be
 * persisted: it replays on reload/back as `transitionToBookContent('')`,
 * which cascades into loading the USERNAME as a book id.
 */
export function isPersistableContentId(contentId: unknown): contentId is string {
  return typeof contentId === 'string' && contentId.length > 0;
}
