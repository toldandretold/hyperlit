/**
 * The `shelves` (+ `shelf_items`) wire contracts — user-curated book collections.
 *
 * The SOLE `shelves` data that reaches the client. Must stay in sync with `ShelfController`'s
 * index/store/render responses; `creator_token` is hidden server-side and never sent.
 */

/** A shelf as the gallery/tabs see it (the `GET /api/shelves` list row). */
export interface Shelf {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  visibility: 'private' | 'public' | string;
  default_sort: string;
  /**
   * `'user'` for a hand-made shelf, `'likes'` for the one system shelf that
   * mirrors the owner's likes. A likes shelf is a normal shelf in every
   * presentational respect (rename, visibility, sort, show on profile) — only
   * its MEMBERSHIP is special: it comes from liking, so the add-to-shelf menu
   * hides it and the server refuses manual adds.
   */
  kind: 'user' | 'likes' | string;
  created_at: string;
  updated_at: string;
  item_count: number;
  /** present only when listing another user's shelves (membership check). */
  is_member?: boolean;
}

/** A row of the `shelf_items` junction (book ∈ shelf), with optional manual ordering. */
export interface ShelfItem {
  shelf_id: string;
  book: string;
  manual_position: number | null;
  added_at: string;
}

/** `GET /api/shelves` response envelope. */
export interface ShelfListResponse {
  shelves: Shelf[];
}
